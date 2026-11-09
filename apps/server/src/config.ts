import { readFileSync } from 'node:fs';
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
  '.pnpmfile.cjs',
  'pnpmfile.cjs',
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
export const EGRESS_MODES = ['off', 'monitor', 'enforce'] as const;
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

const DropZoneObject = z.object({
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
  if ((zone.egress?.mode ?? 'off') !== 'off' && zone.services.length > MAX_EGRESS_SERVICES) {
    ctx.addIssue({
      code: 'custom',
      path: ['services'],
      message: `with egress on a zone may declare at most ${MAX_EGRESS_SERVICES} services (each drop network is a /28)`,
    });
  }
  if (!zone.crew.enabled) return;
  if (!zone.protectedPaths.some((g) => pathMatches(zone.crew.goalPath, g))) {
    ctx.addIssue({
      code: 'custom',
      path: ['crew', 'goalPath'],
      message: `crew.goalPath ${zone.crew.goalPath} must match a protectedPaths glob`,
    });
  }
  if (zone.crew.stagedLabel === zone.readyLabel) {
    ctx.addIssue({
      code: 'custom',
      path: ['crew', 'stagedLabel'],
      message: 'crew.stagedLabel must differ from readyLabel',
    });
  }
});

const FileSchema = z.object({
  listen: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7420),
      /** Accepted Host and Origin values for control routes; defaults to loopback on the port. */
      allowedHosts: z.array(z.string()).optional(),
    })
    .default({ host: '127.0.0.1', port: 7420 }),
  dataDir: z.string().min(1),
  pollSeconds: z.number().positive().default(60),
  dropZones: z.array(DropZoneSchema),
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
  listen: { host: string; port: number; allowedHosts?: string[] };
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
    githubReviewerToken: string;
    githubReadToken?: string;
    joinToken: string;
    operatorToken: string;
    /** Per-zone values for gate steps only. Any PR's gate code can read them. */
    zoneSecrets?: Record<string, Record<string, string>>;
  };
}

export type UsageConfig = Config['usage'];
export type ClaudePlan = 'pro' | 'max' | 'team_standard' | 'team_premium' | 'enterprise';
export type ClaudeConfig = { plan: ClaudePlan; fableModel?: string; fableWeeklyDropCap: number };

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
  return config.secrets.zoneSecrets?.[zoneId] ?? {};
}

const GATE_SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_NAME =
  /^(GH_TOKEN|GITHUB_TOKEN|PATH|HOME|USER|SHELL|NODE_OPTIONS|NODE_PATH|(GIT|CLAUDE|ANTHROPIC|JM|LD|DYLD)_.*)$/;
const MIN_SECRET_LENGTH = 8; // Shorter values can't be redacted without mangling ordinary output.

const zoneSecretVar = (zoneId: string, name: string): string =>
  `JM_ZONE_SECRET_${zoneId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name}`;

function loadZoneSecrets(
  zones: { id: string; gateSecrets: string[] }[],
  env: NodeJS.ProcessEnv,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const zone of zones) {
    if (zone.gateSecrets.length === 0) continue;
    // NAME_FILE names the file holding NAME, so a zone can't also declare NAME_FILE as a secret.
    for (const name of zone.gateSecrets) {
      if (zone.gateSecrets.includes(`${name}_FILE`))
        throw new Error(
          `zone ${zone.id} declares gate secrets ${name} and ${name}_FILE; ${name}_FILE collides with the file variable for ${name}. Rename one.`,
        );
    }
    const values: Record<string, string> = {};
    for (const name of zone.gateSecrets) {
      if (!GATE_SECRET_NAME.test(name) || RESERVED_NAME.test(name)) {
        throw new Error(`Invalid gate secret name: ${name}`);
      }
      const variable = zoneSecretVar(zone.id, name);
      const value = readSecret(env, variable);
      if (!value) throw new Error(`Missing required environment variables: ${variable}`);
      if (value.length < MIN_SECRET_LENGTH) {
        throw new Error(`${variable} must be at least ${MIN_SECRET_LENGTH} characters`);
      }
      values[name] = value;
    }
    out[zone.id] = values;
  }
  return out;
}

const SECRET_VARS = {
  claudeToken: 'JM_CLAUDE_TOKEN',
  githubAuthorToken: 'JM_GITHUB_AUTHOR_TOKEN',
  githubReviewerToken: 'JM_GITHUB_REVIEWER_TOKEN',
  joinToken: 'JM_JOIN_TOKEN',
  operatorToken: 'JM_OPERATOR_TOKEN',
} as const;

export function loadConfig(
  path: string,
  rawEnv: NodeJS.ProcessEnv,
  opts: { imageLockPath?: string } = {},
): Config {
  const parsed = FileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid config ${path}: ${issues.join('; ')}`);
  }
  // A zone without an explicit image runs its preset's: the release lock's digest when the
  // image ships one, else the local `:dev` build.
  const zonesNeedLock = parsed.data.dropZones.some((z) => !z.image);
  const lockPath = opts.imageLockPath ?? IMAGE_LOCK_PATH;
  const lock = zonesNeedLock ? loadImageLock(lockPath) : undefined;
  // Without a lock a preset would run a mutable local `:dev` tag: only when asked for, for
  // development against locally built images.
  const devImages = rawEnv.JM_DEV_IMAGES === '1';
  const dropZones: DropZoneConfig[] = parsed.data.dropZones.map((zone) => {
    if (!zone.image && zone.preset && !lock && !devImages)
      throw new Error(
        `Invalid config ${path}: zone ${zone.id}: preset ${zone.preset} needs the release image lock at ${lockPath}; set image explicitly, or JM_DEV_IMAGES=1 to run locally built :dev images`,
      );
    // A zone may require signed images when the install doesn't, never the other way round.
    if (parsed.data.requireSignedImages && zone.requireSignedImages === false)
      throw new Error(
        `Invalid config ${path}: zone ${zone.id} sets requireSignedImages: false, but the install requires signed images (top-level requireSignedImages: true); a zone can only strengthen it, so remove the zone's setting`,
      );
    let image: string;
    try {
      image = resolveImage(zone, lock);
    } catch (e) {
      throw new Error(`Invalid config ${path}: zone ${zone.id}: ${(e as Error).message}`);
    }
    // A signed zone's stick refuses tags at run time; say so at startup, naming the image.
    if (parsed.data.requireSignedImages || zone.requireSignedImages) {
      const tag = (what: string, ref: string) =>
        new Error(
          `Invalid config ${path}: zone ${zone.id} requires signed images, but its ${what} ${ref} is a tag: use a digest reference (name@sha256:<64 hex>)${zone.preset && !zone.image ? ', or the release image lock for the preset' : ''}`,
        );
      if (!DIGEST_REF.test(image)) throw tag('image', image);
      for (const s of zone.services ?? [])
        if (!DIGEST_REF.test(s.image)) throw tag(`service ${s.name} image`, s.image);
    }
    return { ...zone, image };
  });
  // Every secret may come from NAME or from the file named by NAME_FILE (never both).
  const env: Record<string, string | undefined> = {};
  for (const name of [...Object.values(SECRET_VARS), 'JM_GITHUB_READ_TOKEN'])
    env[name] = readSecret(rawEnv, name);
  const missing = Object.values(SECRET_VARS).filter((name) => !env[name]);
  if (missing.length > 0)
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (env[SECRET_VARS.githubReviewerToken] === env[SECRET_VARS.githubAuthorToken])
    throw new Error('JM_GITHUB_REVIEWER_TOKEN must differ from JM_GITHUB_AUTHOR_TOKEN');
  // An admin's classic token could edit the ruleset. A fine-grained one can be limited to one repo.
  if (
    parsed.data.dropZones.some((z) => z.authorMayBeAdmin) &&
    !env[SECRET_VARS.githubAuthorToken]?.startsWith('github_pat_')
  )
    throw new Error('authorMayBeAdmin requires a fine-grained JM_GITHUB_AUTHOR_TOKEN');
  const operatorToken = env[SECRET_VARS.operatorToken] as string;
  if (operatorToken.length < 32)
    throw new Error('JM_OPERATOR_TOKEN must be at least 32 characters');
  const others = Object.values(SECRET_VARS)
    .filter((name) => name !== SECRET_VARS.operatorToken)
    .map((name) => env[name]);
  if (others.includes(operatorToken))
    throw new Error('JM_OPERATOR_TOKEN must differ from every other token');
  const readToken = env.JM_GITHUB_READ_TOKEN;
  const needsRead = parsed.data.dropZones.filter((z) => z.reviewReadToken).map((z) => z.id);
  if (needsRead.length > 0 && !readToken)
    throw new Error(
      `JM_GITHUB_READ_TOKEN is required because reviewReadToken is true for zone(s): ${needsRead.join(', ')}`,
    );
  const zones = loadZoneSecrets(parsed.data.dropZones, rawEnv);
  const secrets: Config['secrets'] = {
    claudeToken: env[SECRET_VARS.claudeToken] as string,
    githubAuthorToken: env[SECRET_VARS.githubAuthorToken] as string,
    githubReviewerToken: env[SECRET_VARS.githubReviewerToken] as string,
    joinToken: env[SECRET_VARS.joinToken] as string,
    operatorToken,
    ...(readToken ? { githubReadToken: readToken } : {}),
    ...(Object.keys(zones).length > 0 ? { zoneSecrets: zones } : {}),
  };
  const { listen } = parsed.data;
  return {
    ...parsed.data,
    dropZones,
    listen: {
      ...listen,
      allowedHosts: listen.allowedHosts ?? [`127.0.0.1:${listen.port}`, `localhost:${listen.port}`],
    },
    secrets,
  };
}
