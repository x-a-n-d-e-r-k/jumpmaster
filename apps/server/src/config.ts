import { readFileSync } from 'node:fs';
import { GateSpecSchema, type Role, RoleSchema } from '@jumpmaster/protocol';
import { z } from 'zod';

const DEFAULT_PROTECTED_PATHS = [
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

const DropZoneSchema = z.object({
  id: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be "owner/name"'),
  readyLabel: z.string().default('agent-ready'),
  gates: z.array(GateSpecSchema),
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
  protectedPaths: z.array(z.string()).default(DEFAULT_PROTECTED_PATHS),
  reviewReadToken: z.boolean().default(false),
});

const FileSchema = z.object({
  listen: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().default(7420) })
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
  listen: { host: string; port: number };
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
  };
}

export type UsageConfig = Config['usage'];

/** The model for a role: the per-role override, else the zone's model. */
export function modelFor(zone: DropZoneConfig, role: Role): string {
  return zone.models[role] ?? zone.model;
}

/** Every non-empty secret value, for redaction. */
export function secretList(secrets: Config['secrets']): string[] {
  return Object.values(secrets).filter((v): v is string => typeof v === 'string' && v !== '');
}

const SECRET_VARS = {
  claudeToken: 'JM_CLAUDE_TOKEN',
  githubAuthorToken: 'JM_GITHUB_AUTHOR_TOKEN',
  githubReviewerToken: 'JM_GITHUB_REVIEWER_TOKEN',
  joinToken: 'JM_JOIN_TOKEN',
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
  const readToken = env.JM_GITHUB_READ_TOKEN;
  const needsRead = parsed.data.dropZones.filter((z) => z.reviewReadToken).map((z) => z.id);
  if (needsRead.length > 0 && !readToken)
    throw new Error(
      `JM_GITHUB_READ_TOKEN is required because reviewReadToken is true for zone(s): ${needsRead.join(', ')}`,
    );
  const secrets: Config['secrets'] = {
    claudeToken: env[SECRET_VARS.claudeToken] as string,
    githubAuthorToken: env[SECRET_VARS.githubAuthorToken] as string,
    githubReviewerToken: env[SECRET_VARS.githubReviewerToken] as string,
    joinToken: env[SECRET_VARS.joinToken] as string,
    ...(readToken ? { githubReadToken: readToken } : {}),
  };
  return { ...parsed.data, secrets };
}
