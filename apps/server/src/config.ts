import { readFileSync } from 'node:fs';
import {
  ContainerLimitsSchema,
  GateSpecSchema,
  type Role,
  RoleSchema,
  ServiceSpecSchema,
  VerificationSpecSchema,
} from '@jumpmaster/protocol';
import { z } from 'zod';
import { ZONE_MODES } from './db/repo.js';

export const DEFAULT_PROTECTED_PATHS = [
  '.github/**',
  '.claude/**',
  'CODEOWNERS',
  'GOAL.md',
  '.npmrc',
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

const DropZoneSchema = z.object({
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
  /** Names of secrets for gate steps; values come from JM_ZONE_SECRET_<ZONE>_<NAME>. */
  gateSecrets: z.array(z.string()).default([]),
  /** The starting mode, used only until an operator stores one. */
  mode: z.enum(ZONE_MODES).default('active'),
  image: z.string().min(1),
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
  reviewReadToken: z.boolean().default(false),
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
    })
    .default({ throttleUtilization: 0.9, probeJitterSeconds: [30, 90] }),
});

export type DropZoneConfig = z.infer<typeof DropZoneSchema>;
export type Budgets = DropZoneConfig['budgets'];

export interface Config {
  listen: { host: string; port: number; allowedHosts?: string[] };
  dataDir: string;
  pollSeconds: number;
  dropZones: DropZoneConfig[];
  usage: { throttleUtilization: number; probeJitterSeconds: [number, number] };
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
    const values: Record<string, string> = {};
    for (const name of zone.gateSecrets) {
      if (!GATE_SECRET_NAME.test(name) || RESERVED_NAME.test(name)) {
        throw new Error(`Invalid gate secret name: ${name}`);
      }
      const variable = zoneSecretVar(zone.id, name);
      const value = env[variable];
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

export function loadConfig(path: string, env: NodeJS.ProcessEnv): Config {
  const parsed = FileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid config ${path}: ${issues.join('; ')}`);
  }
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
  const zones = loadZoneSecrets(parsed.data.dropZones, env);
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
    listen: {
      ...listen,
      allowedHosts: listen.allowedHosts ?? [`127.0.0.1:${listen.port}`, `localhost:${listen.port}`],
    },
    secrets,
  };
}
