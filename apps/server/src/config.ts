import { readFileSync } from 'node:fs';
import { GateSpecSchema } from '@jumpmaster/protocol';
import { z } from 'zod';

const DropZoneSchema = z.object({
  id: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo must be "owner/name"'),
  readyLabel: z.string().default('agent-ready'),
  gates: z.array(GateSpecSchema),
  image: z.string().min(1),
  model: z.string().default('claude-opus-5-5'),
  maxTurns: z.number().int().positive().default(200),
});

const FileSchema = z.object({
  listen: z
    .object({ host: z.string().default('127.0.0.1'), port: z.number().int().default(7420) })
    .default({ host: '127.0.0.1', port: 7420 }),
  dataDir: z.string().min(1),
  pollSeconds: z.number().positive().default(60),
  dropZones: z.array(DropZoneSchema),
});

export type DropZoneConfig = z.infer<typeof DropZoneSchema>;

export interface Config {
  listen: { host: string; port: number };
  dataDir: string;
  pollSeconds: number;
  dropZones: DropZoneConfig[];
  secrets: { claudeToken: string; githubAuthorToken: string; joinToken: string };
}

const SECRET_VARS = {
  claudeToken: 'JM_CLAUDE_TOKEN',
  githubAuthorToken: 'JM_GITHUB_AUTHOR_TOKEN',
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
  const secrets = {
    claudeToken: env[SECRET_VARS.claudeToken] as string,
    githubAuthorToken: env[SECRET_VARS.githubAuthorToken] as string,
    joinToken: env[SECRET_VARS.joinToken] as string,
  };
  return { ...parsed.data, secrets };
}
