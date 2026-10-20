import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  RESULT_PREFIX,
} from '@jumpmaster/protocol';
import { runGates } from './gates.js';
import * as gitOps from './git.js';
import {
  type AgentIdentity,
  agentSpawnOptions,
  asAgentArgv,
  type sweepUid,
  type TrooperIdentities,
  trooperIdentities,
} from './privilege.js';
import { redact } from './redact.js';
import { runImplement } from './roles/implement.js';
import { runReview } from './roles/review.js';
import type { RoleCtx, RoleRunner } from './roles/shared.js';

export interface TrooperDeps {
  git: typeof import('./git.js');
  runClaude(
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    as?: AgentIdentity | null,
  ): AsyncIterable<string>;
  runGates: typeof runGates;
  emit(line: string): void;
  /** Uid sweeps (default: the real `privilege.ts` functions). */
  privilege?: { sweepUid: typeof sweepUid };
  /** Unprivileged identities; null outside the container. */
  ids?: TrooperIdentities | null;
}

const ROLES: Partial<Record<DropPayload['role'], RoleRunner>> = {
  implement: runImplement,
  review: runReview,
};

export async function runTrooper(payload: DropPayload, deps: TrooperDeps): Promise<DropResult> {
  const { claudeToken, forgeToken } = payload.credentials;
  if (payload.role === 'implement' && forgeToken === undefined) {
    throw new Error('forge token required for implement');
  }
  const secrets =
    forgeToken === undefined
      ? [claudeToken]
      : [claudeToken, forgeToken, Buffer.from(`x-access-token:${forgeToken}`).toString('base64')];
  const finish = (r: DropResult): DropResult => {
    const out: DropResult =
      r.reason === undefined ? r : { ...r, reason: redact(r.reason, secrets) };
    deps.emit(redact(RESULT_PREFIX + JSON.stringify(out), secrets));
    return out;
  };
  const runner = ROLES[payload.role];
  if (!runner) return finish({ status: 'failed', reason: 'role not implemented', gates: [] });

  const ids = deps.ids ?? null;
  const work = mkdtempSync(join(workRoot(), 'trooper-'));
  // Root-owned but world-readable: the agent uid reads the settings and system prompt in here.
  chmodSync(work, 0o755);
  const ctx: RoleCtx = { workdir: work, secrets, ids };
  try {
    return finish(await runner(payload, deps, ctx));
  } catch (err) {
    return finish({
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      gates: [],
    });
  } finally {
    if (ids) {
      await deps.git.removeTree(join(ids.agent.home, 'repo'), ids.agent).catch(() => undefined);
      await deps.git.removeTree(join(ids.gate.home, 'repo'), ids.gate).catch(() => undefined);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

function workRoot(): string {
  return process.env.JM_WORK_ROOT ?? realpathSync(tmpdir());
}

export { capEventData } from './events.js';

async function* spawnClaude(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  as: AgentIdentity | null = null,
): AsyncIterable<string> {
  const [cmd, ...argv] = asAgentArgv(as, ['claude', ...args]) as [string, ...string[]];
  const child = spawn(cmd, argv, {
    env: agentSpawnOptions(as, env).env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString('utf8')).slice(-4000);
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  exit.catch(() => undefined);
  for await (const line of createInterface({ input: child.stdout })) yield line;
  const code = await exit;
  if (code !== 0) yield JSON.stringify({ type: 'claude_stderr', exitCode: code, stderr });
}

export async function readPayload(
  file: string | undefined,
  stdin: AsyncIterable<string | Buffer>,
): Promise<DropPayload> {
  let text: string;
  if (file) text = readFileSync(file, 'utf8');
  else {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    text = Buffer.concat(chunks).toString('utf8');
  }
  return DropPayloadSchema.parse(JSON.parse(text));
}

async function main(): Promise<void> {
  const payload = await readPayload(process.argv[2], process.stdin);
  if (process.env.JM_WORK_ROOT) gitOps.setWorkRoot(process.env.JM_WORK_ROOT);
  const result = await runTrooper(payload, {
    git: gitOps,
    runClaude: spawnClaude,
    runGates,
    emit: (l) => process.stdout.write(`${l}\n`),
    ids: trooperIdentities(process.env),
  });
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
