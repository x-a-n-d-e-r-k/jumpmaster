import { readdirSync, readFileSync } from 'node:fs';
import {
  ContainerLimitsSchema,
  GateSpecSchema,
  PresetSchema,
  pathMatches,
  type Role,
  RoleSchema,
  ServiceSpecSchema,
  VerificationSpecSchema,
  validAllowEntry,
} from '@jumpmaster/protocol';
import { z } from 'zod';
import { ZONE_MODES } from './db/repo.js';
import { IMAGE_LOCK_PATH, loadImageLock, resolveImage } from './presets.js';
import { readSecret } from './secrets.js';
import {
  gateSecretName,
  MIN_GATE_SECRET,
  type Resolved,
  type ResolvedCredential,
  resolveCredentials,
} from './vault/credentials.js';

/** An image by digest (`name@sha256:<64 hex>`), the only form a signed zone runs. */
const DIGEST_REF = /^[^\s@-][^\s@]*@sha256:[0-9a-f]{64}$/;

export const DEFAULT_PROTECTED_PATHS = [
  '.github/**',
  '.claude/**',
  'CODEOWNERS',
  'GOAL.md',
  '.npmrc',
  // Package-manager config, hooks and patches can swap the tools the gates run.
  'npm-shrinkwrap.json',
  'pnpm-workspace.yaml',
  // Any pnpmfile pnpm could load (.cjs, .mjs, .js, with or without the dot).
  '.pnpmfile.*',
  'pnpmfile.*',
  'patches/**',
  '.yarnrc',
  '.yarnrc.yml',
  // Installed code and package-manager state committed into the tree.
  'node_modules/**',
  '**/node_modules/**',
  '.pnp.*',
  '.yarn/**',
  '.pnpm-store/**',
  '.gitattributes',
  '.gitmodules',
  'jumpmaster*.json',
  'CLAUDE.md',
  'AGENTS.md',
  '.mcp.json',
  'vitest.config.*',
  'vite.config.*',
  'jest.config.*',
  '.mocharc*',
  'playwright.config.*',
  'babel.config.*',
];

export const DEFAULT_PIDS_LIMIT = 512;
export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 86_400;
export const EGRESS_MODES = ['off', 'monitor', 'enforce'] as const;
/**
 * `two-bot`: an author and a reviewer account. `starter`: the author account alone; the reviewer
 * drop's verdict is kept in Jumpmaster, not posted, and the author merges on it and green CI.
 */
export const IDENTITIES = ['two-bot', 'starter'] as const;
export type Identity = (typeof IDENTITIES)[number];

/** What starter mode costs, as the doctor, README and install runbook state it. */
export const STARTER_WARNING =
  "starter mode: the author token can merge any green PR, including an unreviewed one; it is held by the server and by the trooper's root process in implement, heal and resolve drops. Use a fine-grained token for this repository only, with no Workflows permission, or add a reviewer identity.";
/** Services a zone may declare with egress on: each drop's /28 gives them .8 to .14. */
export const MAX_EGRESS_SERVICES = 6;

const CREW_DEFAULTS = {
  enabled: false,
  goalPath: 'GOAL.md',
  cycleMinutes: 60,
  maxDropsPerDay: 24,
  stagedLabel: 'agent-staged',
  maxStaged: 3,
  refutePromotes: false,
  maxRefute: 2,
};

export type McpConfig = {
  enabled: boolean;
  maxBodyBytes: number;
  writesPerHour: number;
  /** Tool calls of any kind one token may make in a trailing hour. */
  callsPerHour: number;
  maxOpenBriefings: number;
};

export const MCP_DEFAULTS: McpConfig = {
  enabled: false,
  maxBodyBytes: 262_144,
  writesPerHour: 20,
  callsPerHour: 600,
  maxOpenBriefings: 5,
};

/** The MCP settings with defaults filled in; absent means off. */
export function mcpConfigOf(config: Pick<Config, 'mcp'>): McpConfig {
  return { ...MCP_DEFAULTS, ...config.mcp };
}

const CrewSchema = z
  .object({
    enabled: z.boolean().default(CREW_DEFAULTS.enabled),
    /** The objective ladder the crew reads; must be a protected path so no drop can edit it. */
    goalPath: z.string().min(1).default(CREW_DEFAULTS.goalPath),
    cycleMinutes: z.number().positive().default(CREW_DEFAULTS.cycleMinutes),
    maxDropsPerDay: z.number().int().nonnegative().default(CREW_DEFAULTS.maxDropsPerDay),
    /** Crew-filed issues wait under this label until Command promotes them. */
    stagedLabel: z.string().min(1).default(CREW_DEFAULTS.stagedLabel),
    maxStaged: z.number().int().nonnegative().default(CREW_DEFAULTS.maxStaged),
    /** Lets a crew refute promote an issue (still held one pass with a Reject option). */
    refutePromotes: z.boolean().default(CREW_DEFAULTS.refutePromotes),
    maxRefute: z.number().int().min(1).default(CREW_DEFAULTS.maxRefute),
  })
  .default(CREW_DEFAULTS);

/** A zone's fields with their defaults, without the cross-field rules (the add baseline parses with it). */
export const DropZoneObject = z.object({
  id: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be "owner/name"'),
  readyLabel: z.string().default('agent-ready'),
  gates: z.array(GateSpecSchema),
  services: z
    .array(ServiceSpecSchema)
    .default([])
    .superRefine((list, ctx) => {
      const names = list.map((s) => s.name);
      const repeated = names.find((n, i) => names.indexOf(n) !== i);
      if (repeated) ctx.addIssue({ code: 'custom', message: `duplicate service: ${repeated}` });
    }),
  verification: z.array(VerificationSpecSchema).default([]),
  limits: ContainerLimitsSchema.default({ pids: DEFAULT_PIDS_LIMIT }),
  /**
   * Open agent PRs to take over at cutover, even without the server's marker. Listed by number
   * because a person may author both these and hand-opened PRs, so the login can't tell them apart.
   */
  adoptPulls: z.array(z.number().int().positive()).default([]),
  maxConcurrentImplement: z.number().int().positive().default(1),
  /** How long an unresolved forge write may stay unknown; defaults to ciDeadlineMinutes. */
  outboxDeadlineMinutes: z.number().positive().optional(),
  /** Names of secrets for gate steps; values come from JM_ZONE_SECRET_<ZONE>_<NAME>[_FILE]. */
  gateSecrets: z.array(z.string()).default([]),
  /** The starting mode, used only until an operator stores one. */
  mode: z.enum(ZONE_MODES).default('active'),
  /** The trooper image. Optional when `preset` is set: the preset's image is used. */
  image: z.string().min(1).optional(),
  /** A prebuilt stack image (see presets.ts). Gates stay explicit config either way. */
  preset: PresetSchema.optional(),
  /**
   * Egress control. Absent or `off` (the default) keeps M3 behaviour. Any other mode needs a stick
   * that advertises `egress-v1`: until one does, the zone's drops stay queued.
   */
  egress: z
    .object({
      mode: z.enum(EGRESS_MODES).default('off'),
      /**
       * Hosts beyond the base and preset lists: a name, or `*.` plus a name (subdomains only).
       * Never an IP literal, a port, a path or a URL.
       */
      allow: z
        .array(
          z.string().refine(validAllowEntry, {
            message: 'egress.allow entries are host names or *.name, never an IP, port or path',
          }),
        )
        .default([]),
    })
    .optional(),
  /**
   * `true` requires signed images for this zone even when the install doesn't. A zone can't
   * weaken the install-wide setting: `false` under a top-level `true` is a config error.
   */
  requireSignedImages: z.boolean().optional(),
  model: z.string().default('claude-opus-5-5'),
  maxTurns: z.number().int().positive().default(200),
  models: z.partialRecord(RoleSchema, z.string()).default({}),
  budgets: z
    .object({
      maxHeal: z.number().int().nonnegative().default(3),
      maxResolve: z.number().int().nonnegative().default(2),
      maxResolveTotal: z.number().int().nonnegative().default(6),
      maxResume: z.number().int().nonnegative().default(2),
      maxReviewRepeat: z.number().int().nonnegative().default(2),
      maxNoChange: z.number().int().nonnegative().default(1),
    })
    .default({
      maxHeal: 3,
      maxResolve: 2,
      maxResolveTotal: 6,
      maxResume: 2,
      maxReviewRepeat: 2,
      maxNoChange: 1,
    }),
  ciRequired: z.boolean().default(true),
  ciDeadlineMinutes: z.number().positive().default(45),
  retryLabel: z.string().min(1).default('agent-retry'),
  mergeMethod: z.literal('squash').default('squash'),
  requireBranchProtection: z.boolean().default(true),
  /**
   * Allow the author token's account to be a repository admin, as when the owner of a personal
   * repository authors the PRs. The reviewer must still not be an admin, and neither may bypass.
   */
  authorMayBeAdmin: z.boolean().default(false),
  /**
   * `starter` runs with the author token alone (opt-in): no review is posted, and the author
   * merges on the reviewer drop's verdict and green CI. See STARTER_WARNING.
   */
  identity: z.enum(IDENTITIES).default('two-bot'),
  protectedPaths: z.array(z.string()).default(DEFAULT_PROTECTED_PATHS),
  /**
   * Logins (with write access) whose approval of the exact head lets a gate script or gate tool
   * change through, besides anyone with maintain or admin. Protected paths are never overridden.
   */
  overrideApprovers: z.array(z.string()).default([]),
  /**
   * Accept new registry packages in pnpm-lock.yaml when the root package.json pins pnpm 10 or
   * later, which runs no install script unless allow-listed. Turn on only when the image really
   * runs that pnpm: an older pnpm runs install scripts with only a warning.
   */
  trustPnpmBuildBlocking: z.boolean().default(false),
  /**
   * Gates run with CI=true (frozen pnpm, immutable yarn berry and bun installs, jest --ci, no
   * watch mode). `false` runs them with CI=false instead. A plain setting, not a gate secret:
   * the values that turn CI off are too short to be secrets, and secrets are redacted from logs.
   * Turning it off weakens the guard's lockfile review, since a gate install may then resolve
   * afresh and run what it resolved.
   */
  gateCi: z.boolean().default(true),
  reviewReadToken: z.boolean().default(false),
  /** `false`: the agent adds no Claude co-author trailer or PR attribution. */
  attribution: z.boolean().default(true),
  crew: CrewSchema,
  /** Logins whose ready issues count as crew-filed (never the only provenance signal). */
  botLogins: z.array(z.string()).default([]),
});

const DropZoneSchema = DropZoneObject.superRefine((zone, ctx) => {
  if (!zone.image && !zone.preset)
    ctx.addIssue({ code: 'custom', path: ['image'], message: 'a zone needs image or preset' });
  // Fable is chosen per role by the declared plan, never as a zone's default model.
  if (/fable/i.test(zone.model)) {
    ctx.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'model may not name Fable: declare claude.plan and claude.fableModel instead',
    });
  }
  if (zone.identity === 'starter' && !zone.ciRequired) {
    ctx.addIssue({
      code: 'custom',
      path: ['ciRequired'],
      message:
        'a starter zone requires ciRequired: true: with no reviewer identity, required CI is what GitHub enforces',
    });
  }
  if ((zone.egress?.mode ?? 'off') !== 'off' && zone.services.length > MAX_EGRESS_SERVICES) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      message: `with egress on a zone may declare at most ${MAX_EGRESS_SERVICES} services (each drop network is a /28)`,
    });
  }
  // The goal file is read every pass, crew on or off, and served as Command's text: it must be a
  // path no drop can change.
  if (!zone.protectedPaths.some((g) => pathMatches(zone.crew.goalPath, g))) {
    ctx.addIssue({
      code: 'custom',
      path: ['crew', 'goalPath'],
      message: `crew.goalPath ${zone.crew.goalPath} must match a protectedPaths glob`,
    });
  }
  if (!zone.crew.enabled) return;
  if (zone.crew.stagedLabel === zone.readyLabel) {
    ctx.addIssue({
      code: 'custom',
      path: ['crew', 'stagedLabel'],
      message: 'crew.stagedLabel must differ from readyLabel',
    });
  }
});

/**
 * Boot settings: read before the database exists, so never part of the editable document. From
 * the config file when one exists, else from the environment (`config/boot.ts`).
 */
export const BootSchema = z.object({
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7420),
      /** Accepted Host and Origin values for control routes; defaults to loopback on the port. */
      allowedHosts: z.array(z.string()).optional(),
      /** A TLS terminator the operator declares in front of the UI (or `JM_TLS_TERMINATED=1`). */
      tlsTerminated: z.boolean().optional(),
    })
    .default({ host: '127.0.0.1', port: 7420 }),
  dataDir: z.string().min(1),
});

/** The keys of the boot settings, refused in an editable document. */
export const BOOT_KEYS = ['listen', 'dataDir'] as const;
export const BOOT_MESSAGE = 'set in the config file or the environment; restart to change';

/** Everything the UI and `ctl` may edit: the config without boot settings and without secrets. */
export const EditableSchema = z.object({
  /** Seconds between passes: a cadence, never a busy loop or past setInterval's 2^31-1 ms. */
  pollSeconds: z.number().int().min(MIN_POLL_SECONDS).max(MAX_POLL_SECONDS).default(60),
  dropZones: z.array(DropZoneSchema).default([]),
  usage: z
    .object({
      throttleUtilization: z.number().min(0).max(1).default(0.9),
      probeJitterSeconds: z
        .tuple([z.number().nonnegative(), z.number().nonnegative()])
        .default([30, 90]),
      /**
       * Stop all dispatch when a drop reports running on usage credits (spec §12.2). False only
       * raises a briefing.
       */
      stopOnOverage: z.boolean().default(true),
    })
    .default({ throttleUtilization: 0.9, probeJitterSeconds: [30, 90], stopOnOverage: true }),
  /**
   * The Claude plan as declared (not detected). Fable runs only on a plan that includes it, with
   * `fableModel` set, under a trailing seven-day drop cap.
   */
  claude: z
    .object({
      plan: z.enum(['pro', 'max', 'team_standard', 'team_premium', 'enterprise']).default('pro'),
      fableModel: z.string().min(1).optional(),
      fableWeeklyDropCap: z.number().int().nonnegative().default(5),
      /**
       * When `claude setup-token` made the token (YYYY-MM-DD): such tokens last a year, and the
       * doctor warns from day 330. Not a secret.
       */
      tokenCreatedAt: z
        .string()
        .refine((s) => /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s)), {
          message: 'claude.tokenCreatedAt must be a date (YYYY-MM-DD)',
        })
        .optional(),
    })
    .default({ plan: 'pro', fableWeeklyDropCap: 5 }),
  /**
   * Run trooper images only from a stick that verifies signatures (`image-verify-v1`) under the
   * `signed` policy. Off by default; the generated install turns it on.
   */
  requireSignedImages: z.boolean().default(false),
  /** The zone-scoped MCP server at `/mcp` (off by default; read at start, so a flip needs a restart). */
  mcp: z
    .object({
      enabled: z.boolean().default(MCP_DEFAULTS.enabled),
      maxBodyBytes: z.number().int().positive().default(MCP_DEFAULTS.maxBodyBytes),
      /** Write calls one token may make in a trailing hour. */
      writesPerHour: z.number().int().nonnegative().default(MCP_DEFAULTS.writesPerHour),
      /** Tool calls of any kind one token may make in a trailing hour. */
      callsPerHour: z.number().int().nonnegative().default(MCP_DEFAULTS.callsPerHour),
      /** Open MCP-raised briefings a zone may hold. */
      maxOpenBriefings: z.number().int().nonnegative().default(MCP_DEFAULTS.maxOpenBriefings),
    })
    .default(MCP_DEFAULTS),
});

/** A loaded zone: `image` is always resolved (from the preset when it wasn't given). */
export type DropZoneConfig = Omit<z.infer<typeof DropZoneSchema>, 'image'> & { image: string };
export type Budgets = DropZoneConfig['budgets'];

export interface Config {
  listen: { host: string; port: number; allowedHosts?: string[]; tlsTerminated?: boolean };
  dataDir: string;
  pollSeconds: number;
  dropZones: DropZoneConfig[];
  /** `stopOnOverage` absent means true. */
  usage: {
    throttleUtilization: number;
    probeJitterSeconds: [number, number];
    stopOnOverage?: boolean;
  };
  claude: ClaudeConfig;
  /** Absent means the defaults (`MCP_DEFAULTS`): off. */
  mcp?: Partial<McpConfig>;
  /** Absent means false. */
  requireSignedImages?: boolean;
  secrets: {
    claudeToken: string;
    githubAuthorToken: string;
    /** Absent only when every zone is `starter`. */
    githubReviewerToken?: string;
    githubReadToken?: string;
    joinToken: string;
    operatorToken: string;
    /** Per-zone values for gate steps only. Any PR's gate code can read them. */
    zoneSecrets?: Record<string, Record<string, string>>;
  };
}

/** What the config store holds and validates: no boot settings, no secrets. */
export type EditableConfig = Omit<Config, 'listen' | 'dataDir' | 'secrets'>;
export type BootSettings = Pick<Config, 'listen' | 'dataDir'>;
export type ConfigIssue = { path: string; message: string };

export type UsageConfig = Config['usage'];
export type ClaudePlan = 'pro' | 'max' | 'team_standard' | 'team_premium' | 'enterprise';
export type ClaudeConfig = {
  plan: ClaudePlan;
  fableModel?: string;
  fableWeeklyDropCap: number;
  tokenCreatedAt?: string;
};

/** What the server says at startup about risky settings: one line per starter zone. */
export function startupWarnings(config: Pick<Config, 'dropZones'>): string[] {
  return config.dropZones
    .filter((z) => z.identity === 'starter')
    .map((z) => `zone ${z.id}: ${STARTER_WARNING}`);
}

/** The model for a role: the per-role override, else the zone's model. */
export function modelFor(zone: DropZoneConfig, role: Role): string {
  return zone.models[role] ?? zone.model;
}

/** Host and Origin values the operator's browser may use; defaults to loopback on the port. */
export function allowedHostsOf(config: Pick<Config, 'listen'>): string[] {
  const { port, allowedHosts } = config.listen;
  return allowedHosts ?? [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Every non-empty secret value, for redaction. */
export function secretList(secrets: Config['secrets']): string[] {
  const { zoneSecrets, ...tokens } = secrets;
  return [
    ...Object.values(tokens).filter((v): v is string => typeof v === 'string' && v !== ''),
    ...Object.values(zoneSecrets ?? {}).flatMap((zone) => Object.values(zone)),
  ];
}

/** The gate secrets declared for a zone. */
export function zoneSecrets(
  config: Pick<Config, 'secrets'>,
  zoneId: string,
): Record<string, string> {
  const all = config.secrets.zoneSecrets;
  // Own entries only: a zone named toString must not read Object.prototype's.
  return all && Object.hasOwn(all, zoneId) ? (all[zoneId] ?? {}) : {};
}

const GATE_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_NAME =
  /^(GH_TOKEN|GITHUB_TOKEN|PATH|HOME|USER|SHELL|NODE_OPTIONS|NODE_PATH|(GIT|CLAUDE|ANTHROPIC|JM|LD|DYLD)_.*)$/;

/**
 * The config-only rules for a zone's gate secret names (the values are credentials, judged as
 * problems at dispatch: vault/problems.ts).
 */
function gateSecretNameIssues(
  zone: { id: string; gateSecrets: string[] },
  at: string,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const name of zone.gateSecrets) {
    // NAME_FILE names the file holding NAME, so a zone can't also declare NAME_FILE as a secret.
    if (zone.gateSecrets.includes(`${name}_FILE`))
      issues.push({
        path: at,
        message: `zone ${zone.id} declares gate secrets ${name} and ${name}_FILE; ${name}_FILE collides with the file variable for ${name}. Rename one.`,
      });
    if (name === 'CI')
      issues.push({
        path: at,
        message: `zone ${zone.id}: gate secret CI is not allowed; gates run with CI=true, and the zone's "gateCi": false turns it off`,
      });
    else if (!GATE_SECRET_NAME.test(name) || RESERVED_NAME.test(name))
      issues.push({ path: at, message: `Invalid gate secret name: ${name}` });
  }
  return issues;
}

/** The machine secrets: generated for the install, never entered in the UI, read from variables. */
const MACHINE_VARS = { joinToken: 'JM_JOIN_TOKEN', operatorToken: 'JM_OPERATOR_TOKEN' } as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A zone id as `zoneIdOf` makes it: lower case letters, digits and inner dashes, at most 63. */
export const ZONE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Names that reach an object's prototype machinery when assigned: never config keys. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Every own key named in FORBIDDEN_KEYS, at any depth. */
function forbiddenKeys(input: unknown, path: string): ConfigIssue[] {
  const at = (k: string) => (path === '' ? k : `${path}.${k}`);
  if (Array.isArray(input)) return input.flatMap((v, i) => forbiddenKeys(v, at(String(i))));
  if (!isPlainObject(input)) return [];
  return Object.keys(input).flatMap((k) =>
    FORBIDDEN_KEYS.has(k)
      ? [{ path: at(k), message: `a key named ${k} is not allowed in the config` }]
      : forbiddenKeys(input[k], at(k)),
  );
}

/**
 * The lenient read of an M4 file (strict off): a `pollSeconds` outside the bounds the schema now
 * has is clamped to them and said, so an install that ran with it still starts. Writes refuse it.
 */
function clampPoll(json: Record<string, unknown>): {
  json: Record<string, unknown>;
  warnings: string[];
} {
  const p = json.pollSeconds;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return { json, warnings: [] };
  const fixed = Math.min(Math.max(Math.round(p), MIN_POLL_SECONDS), MAX_POLL_SECONDS);
  if (fixed === p) return { json, warnings: [] };
  return {
    json: { ...json, pollSeconds: fixed },
    warnings: [
      `pollSeconds ${p} is outside ${MIN_POLL_SECONDS}..${MAX_POLL_SECONDS}: running with ${fixed}; set it in range`,
    ],
  };
}

/**
 * Keys in `input` that the schema dropped from `output` (zod strips what it doesn't know), at
 * any depth: a typo such as `pollseconds` would otherwise be stored and exported with no effect.
 * Records of free keys (per-role `models`) keep their keys and are never reported. A key starting
 * with `_` is a comment (JSON has none; the shipped example carries `_about`): kept, not reported.
 */
function unknownKeys(input: unknown, output: unknown, path: string): ConfigIssue[] {
  const at = (k: string) => (path === '' ? k : `${path}.${k}`);
  if (Array.isArray(input) && Array.isArray(output))
    return input.flatMap((v, i) => unknownKeys(v, output[i], at(String(i))));
  if (!isPlainObject(input) || !isPlainObject(output)) return [];
  return Object.keys(input).flatMap((k) =>
    k.startsWith('_') || Object.hasOwn(output, k)
      ? unknownKeys(input[k], output[k], at(k))
      : [{ path: at(k), message: 'unknown key: it would have no effect' }],
  );
}

/**
 * Validates an editable document (the config without `listen`, `dataDir` and secrets) with every
 * rule the config can judge alone: the schema, duplicate zone ids, image resolution, digest refs
 * for signed zones, and a zone never weakening `requireSignedImages`. The rules that need a
 * credential are not here. Issues are by dotted path (`dropZones.0.repo`); `''` is the root.
 */
export function parseEditable(
  json: unknown,
  /** `strict`: a key the schema doesn't know is an issue (every write from the UI or ctl). */
  opts: { imageLockPath?: string; devImages?: boolean; strict?: boolean } = {},
):
  | { ok: true; config: EditableConfig; warnings?: string[] }
  | { ok: false; issues: ConfigIssue[] } {
  if (!isPlainObject(json))
    return { ok: false, issues: [{ path: '', message: 'the config must be a JSON object' }] };
  const forbidden = forbiddenKeys(json, '');
  if (forbidden.length > 0) return { ok: false, issues: forbidden };
  const lenient: { json: Record<string, unknown>; warnings: string[] } = opts.strict
    ? { json, warnings: [] }
    : clampPoll(json);
  const doc: Record<string, unknown> = lenient.json;
  const boot = BOOT_KEYS.filter((k) => Object.hasOwn(doc, k));
  if (boot.length > 0)
    return { ok: false, issues: boot.map((path) => ({ path, message: BOOT_MESSAGE })) };
  const parsed = EditableSchema.safeParse(doc);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  if (opts.strict) {
    const unknown = unknownKeys(doc, parsed.data, '');
    if (unknown.length > 0) return { ok: false, issues: unknown };
  }
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  for (const [i, zone] of parsed.data.dropZones.entries()) {
    // Zone ids key plain objects (gate secrets, modes by zone): never a prototype name.
    if (FORBIDDEN_KEYS.has(zone.id))
      issues.push({ path: `dropZones.${i}.id`, message: `a zone id may not be ${zone.id}` });
    // The charset `zoneIdOf` makes. A write keeps to it; an M4 file that doesn't still loads.
    else if (!ZONE_ID.test(zone.id)) {
      if (opts.strict)
        issues.push({
          path: `dropZones.${i}.id`,
          message: `a zone id is lower case letters, digits and inner dashes, at most 63: not ${zone.id}`,
        });
      else
        lenient.warnings.push(
          `zone id ${zone.id} is not lower case letters, digits and inner dashes: a write from the UI or ctl would refuse it; rename it in the file`,
        );
    }
    if (seen.has(zone.id))
      issues.push({ path: `dropZones.${i}.id`, message: `duplicate zone id: ${zone.id}` });
    seen.add(zone.id);
    issues.push(...gateSecretNameIssues(zone, `dropZones.${i}.gateSecrets`));
    // Gate secret variables key on the id folded to upper case and underscores: two ids that fold
    // alike would read each other's.
    const fold = zone.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const twin = parsed.data.dropZones
      .slice(0, i)
      .find((z) => z.id !== zone.id && z.id.toUpperCase().replace(/[^A-Z0-9]/g, '_') === fold);
    if (twin)
      issues.push({
        path: `dropZones.${i}.id`,
        message: `zone ids ${twin.id} and ${zone.id} share the gate secret variables JM_ZONE_SECRET_${fold}_<NAME>: rename one`,
      });
  }
  // A zone without an explicit image runs its preset's: the release lock's digest when the
  // image ships one, else the local `:dev` build.
  const zonesNeedLock = parsed.data.dropZones.some((z) => !z.image);
  const lockPath = opts.imageLockPath ?? IMAGE_LOCK_PATH;
  const lock = zonesNeedLock ? loadImageLock(lockPath) : undefined;
  const dropZones: DropZoneConfig[] = [];
  for (const [i, zone] of parsed.data.dropZones.entries()) {
    const at = (field: string) => `dropZones.${i}.${field}`;
    // Without a lock a preset would run a mutable local `:dev` tag: only when asked for, for
    // development against locally built images.
    if (!zone.image && zone.preset && !lock && !opts.devImages) {
      issues.push({
        path: at('preset'),
        message: `zone ${zone.id}: preset ${zone.preset} needs the release image lock at ${lockPath}; set image explicitly, or JM_DEV_IMAGES=1 to run locally built :dev images`,
      });
      continue;
    }
    // A zone may require signed images when the install doesn't, never the other way round.
    if (parsed.data.requireSignedImages && zone.requireSignedImages === false)
      issues.push({
        path: at('requireSignedImages'),
        message: `zone ${zone.id} sets requireSignedImages: false, but the install requires signed images (top-level requireSignedImages: true); a zone can only strengthen it, so remove the zone's setting`,
      });
    let image: string;
    try {
      image = resolveImage(zone, lock);
    } catch (e) {
      issues.push({ path: at('preset'), message: `zone ${zone.id}: ${(e as Error).message}` });
      continue;
    }
    // A signed zone's stick refuses tags at run time; say so before it is accepted.
    if (parsed.data.requireSignedImages || zone.requireSignedImages) {
      const tag = (what: string, ref: string) =>
        `zone ${zone.id} requires signed images, but its ${what} ${ref} is a tag: use a digest reference (name@sha256:<64 hex>)${zone.preset && !zone.image ? ', or the release image lock for the preset' : ''}`;
      if (!DIGEST_REF.test(image)) issues.push({ path: at('image'), message: tag('image', image) });
      for (const [j, s] of (zone.services ?? []).entries())
        if (!DIGEST_REF.test(s.image))
          issues.push({
            path: at(`services.${j}.image`),
            message: tag(`service ${s.name} image`, s.image),
          });
    }
    dropZones.push({ ...zone, image });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    config: { ...parsed.data, dropZones },
    ...(lenient.warnings.length > 0 ? { warnings: lenient.warnings } : {}),
  };
}

/** One line per issue, as a startup error says it. */
export const formatIssues = (issues: ConfigIssue[]): string =>
  issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');

/**
 * The config file split in two: its boot settings and its editable document. A file that is not
 * JSON, or whose boot settings don't parse, throws.
 */
export function splitConfigFile(
  path: string,
  text: string,
): { boot: BootSettings; editable: Record<string, unknown> } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid config ${path}: not JSON (${(e as Error).message})`);
  }
  if (!isPlainObject(json)) throw new Error(`Invalid config ${path}: the config must be an object`);
  const { listen, dataDir, ...editable } = json;
  const boot = BootSchema.safeParse({ listen, dataDir });
  if (!boot.success) {
    const issues = boot.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new Error(`Invalid config ${path}: ${formatIssues(issues)}`);
  }
  const l = boot.data.listen;
  return {
    boot: {
      dataDir: boot.data.dataDir,
      listen: {
        host: l.host,
        port: l.port,
        allowedHosts: l.allowedHosts ?? [`127.0.0.1:${l.port}`, `localhost:${l.port}`],
        ...(l.tlsTerminated !== undefined ? { tlsTerminated: l.tlsTerminated } : {}),
      },
    },
    editable,
  };
}

/**
 * The config file with its secrets, as `ctl` tools and tests read it: the credentials from their
 * variables and the files named for them under `JM_SECRETS_DIR` (no vault). No credential rule
 * refuses it: those are dispatch refusals (vault/problems.ts).
 */
export function loadConfig(
  path: string,
  rawEnv: NodeJS.ProcessEnv,
  opts: { imageLockPath?: string } = {},
): Config {
  const { boot, editable } = splitConfigFile(path, readFileSync(path, 'utf8'));
  const parsed = parseEditable(editable, {
    ...opts,
    devImages: rawEnv.JM_DEV_IMAGES === '1',
  });
  if (!parsed.ok) throw new Error(`Invalid config ${path}: ${formatIssues(parsed.issues)}`);
  const zones = parsed.config.dropZones;
  const resolved = resolveCredentials(rawEnv, rawEnv.JM_SECRETS_DIR || undefined, 'disabled', {
    gateSecrets: gateSecretsOf(zones),
  });
  return {
    ...boot,
    ...parsed.config,
    secrets: assembleSecrets(resolved, loadMachineSecrets(rawEnv, resolved), zones),
  };
}

/** Every gate secret the zones declare, for `resolveCredentials`. */
export const gateSecretsOf = (zones: readonly { id: string; gateSecrets: string[] }[]) =>
  zones.flatMap((z) => z.gateSecrets.map((name) => ({ zoneId: z.id, name })));

/**
 * Reads every install-wide secret once (`NAME` or `NAME_FILE`, and the credential files named
 * under `secretsDir`) and throws naming the first one that cannot be read, or that is set both
 * ways. Run before the data directory is touched, so an unreadable secret file is reported by
 * name rather than as a database error, as M4's loader did.
 */
export function preflightSecrets(rawEnv: NodeJS.ProcessEnv, secretsDir?: string): void {
  try {
    for (const name of Object.values(MACHINE_VARS)) readSecret(rawEnv, name);
    // Warnings (the /run/secrets fallback) are said once, by the store.
    resolveCredentials(rawEnv, secretsDir, 'disabled', { warn: () => {} });
  } catch (e) {
    if (!(e instanceof Error) || !secretsDir || !isEmptyDir(secretsDir)) throw e;
    // Bootstrap always writes the machine secrets there: an empty directory is a bind that came
    // up empty, not an install without secrets.
    throw new Error(
      `${e.message}. ${secretsDir} is empty: the bind of ./secrets came up empty (seen with Docker Desktop when the install directory is under a symlinked parent such as macOS's /var/folders). Run  docker compose down  then  docker compose up, or install under your home directory`,
    );
  }
}

const isEmptyDir = (dir: string): boolean => {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return false;
  }
};

/**
 * The join and operator tokens, required at every start, with the operator token's rules: at
 * least 32 characters and different from every other secret. Throws naming the variable.
 */
export function loadMachineSecrets(
  rawEnv: NodeJS.ProcessEnv,
  resolved?: Resolved,
): { joinToken: string; operatorToken: string } {
  const joinToken = readSecret(rawEnv, MACHINE_VARS.joinToken);
  const operatorToken = readSecret(rawEnv, MACHINE_VARS.operatorToken);
  const missing = Object.values(MACHINE_VARS).filter((v) => !readSecret(rawEnv, v));
  if (missing.length > 0 || !joinToken || !operatorToken)
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (operatorToken.length < 32)
    throw new Error('JM_OPERATOR_TOKEN must be at least 32 characters');
  const others = [
    joinToken,
    ...Object.values(resolved ?? {}).map((r) => (r as ResolvedCredential).value),
  ];
  if (others.includes(operatorToken))
    throw new Error('JM_OPERATOR_TOKEN must differ from every other token');
  return { joinToken, operatorToken };
}

/**
 * `config.secrets` from the resolved credentials and the machine secrets. A missing Claude or
 * author token is the empty string here (`secretList` skips it): the zones that need it are
 * parked with the problem as their reason, so no drop or forge write uses it.
 */
export function assembleSecrets(
  resolved: Resolved,
  machine: { joinToken: string; operatorToken: string },
  zones: readonly { id: string; gateSecrets: string[] }[],
): Config['secrets'] {
  const zoneValues: Record<string, Record<string, string>> = {};
  for (const z of zones) {
    if (z.gateSecrets.length === 0) continue;
    const values: Record<string, string> = {};
    for (const name of z.gateSecrets) {
      const v = resolved[gateSecretName(z.id, name)]?.value;
      // A value too short to redact stays out of every scrub list (a one-letter value would mask
      // that letter in every line); the zone is parked on its `kind` problem, so no gate gets it.
      if (v && v.length >= MIN_GATE_SECRET) values[name] = v;
    }
    Object.defineProperty(zoneValues, z.id, { value: values, enumerable: true, writable: true });
  }
  const reviewer = resolved.githubReviewerToken.value;
  const read = resolved.githubReadToken.value;
  return {
    claudeToken: resolved.claudeToken.value ?? '',
    githubAuthorToken: resolved.githubAuthorToken.value ?? '',
    ...(reviewer ? { githubReviewerToken: reviewer } : {}),
    joinToken: machine.joinToken,
    operatorToken: machine.operatorToken,
    ...(read ? { githubReadToken: read } : {}),
    ...(Object.keys(zoneValues).length > 0 ? { zoneSecrets: zoneValues } : {}),
  };
}
