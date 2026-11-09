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
  payloadSecrets,
  REPORT_MAX_CHARS,
  RESULT_PREFIX,
} from '@jumpmaster/protocol';
import { applyEgress } from './egress-env.js';
import { runGates } from './gates.js';
import * as gitOps from './git.js';
import {
  type AgentIdentity,
  agentSpawnOptions,
  asAgentArgv,
  sweepUid,
  type TrooperIdentities,
  trooperIdentities,
} from './privilege.js';
import { redact } from './redact.js';
import { runCrew } from './roles/crew.js';
import { runDoctorRole } from './roles/doctor.js';
import { runHeal } from './roles/heal.js';
import { runImplement } from './roles/implement.js';
import { runResolve } from './roles/resolve.js';
import { runReview } from './roles/review.js';
import type { RoleCtx, RoleRunner } from './roles/shared.js';

export interface TrooperDeps {
  git: typeof import('./git.js');
  runClaude(
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    as?: AgentIdentity | null,
    signal?: AbortSignal,
  ): AsyncIterable<string>;
  runGates: typeof runGates;
  emit(line: string): void;
  /** Uid sweeps (default: the real `privilege.ts` functions). */
  privilege?: { sweepUid: typeof sweepUid };
  /** Unprivileged identities; null outside the container. */
  ids?: TrooperIdentities | null;
  /** Aborted on SIGTERM/SIGINT: the agent is stopped and the role checkpoints. */
  signal?: AbortSignal;
}

const ROLES: Partial<Record<DropPayload['role'], RoleRunner>> = {
  implement: runImplement,
  review: runReview,
  heal: runHeal,
  resolve: runResolve,
  'crew-lead': runCrew,
  refute: runCrew,
  diagnose: runCrew,
  doctor: runDoctorRole,
};

export async function runTrooper(payload: DropPayload, deps: TrooperDeps): Promise<DropResult> {
  const secrets = payloadSecrets(payload);
  const finish = (r: DropResult): DropResult => {
    // Redact before serialising: JSON escaping could hide a secret from the line-level redact.
    const out: DropResult = { ...r };
    if (r.reason !== undefined) out.reason = redact(r.reason, secrets);
    if (r.summary !== undefined) {
      out.summary = redact(r.summary, secrets).slice(0, REPORT_MAX_CHARS);
    }
    deps.emit(redact(RESULT_PREFIX + JSON.stringify(out), secrets));
    return out;
  };
  // Every failure from here on posts a result, so the server records why the drop stopped.
  const fail = (reason: string) => finish({ status: 'failed', reason, gates: [] });
  if (payload.role === 'implement' && payload.credentials.forgeToken === undefined) {
    return fail('forge token required for implement');
  }
  const runner = ROLES[payload.role];
  if (!runner) return fail('role not implemented');

  const ids = deps.ids ?? null;
  // Before anything is spawned: every environment built from here on carries the proxy.
  try {
    await applyEgress(payload, ids);
  } catch (err) {
    return fail(`egress setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let work: string;
  try {
    work = mkdtempSync(join(workRoot(), 'trooper-'));
    // Root-owned but world-readable: the agent uid reads the settings and system prompt in here.
    chmodSync(work, 0o755);
  } catch (err) {
    return fail(`trooper setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ctx: RoleCtx = { workdir: work, secrets, ids };
  try {
    return finish(await runner(payload, deps, ctx));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
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
  signal?: AbortSignal,
): AsyncIterable<string> {
  const [cmd, ...argv] = asAgentArgv(as, ['claude', ...args]) as [string, ...string[]];
  const child = spawn(cmd, argv, {
    env: agentSpawnOptions(as, env).env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // On a stop, kill the agent and everything it started; the stream then ends.
  const stop = () => {
    child.kill('SIGKILL');
    if (as) sweepUid(as.uid);
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
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

const PAYLOAD_START = '{"protocol":';

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
  // Docker can pass the attach request's body to stdin ahead of the payload. The payload is
  // serialised in schema order, so it starts with its protocol field: parse from there.
  const start = text.indexOf(PAYLOAD_START);
  if (start > 0) text = text.slice(start);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // V8's parse errors quote the text around the fault, which may be a credential.
    throw new Error('payload is not valid JSON');
  }
  return DropPayloadSchema.parse(raw);
}

type SchemaIssue = { path: PropertyKey[]; message: string };
const isSchemaError = (e: unknown): e is Error & { issues: SchemaIssue[] } =>
  e instanceof Error && e.name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues);

/** One line for stderr: the stick reports the last line of a trooper that died without a result. */
export function describeFatal(err: unknown): string {
  if (isSchemaError(err)) {
    const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return `payload rejected: ${issues.join('; ')}`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

async function main(): Promise<void> {
  const payload = await readPayload(process.argv[2], process.stdin);
  if (process.env.JM_WORK_ROOT) gitOps.setWorkRoot(process.env.JM_WORK_ROOT);
  const stopping = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => stopping.abort());
  }
  const result = await runTrooper(payload, {
    git: gitOps,
    runClaude: spawnClaude,
    runGates,
    emit: (l) => process.stdout.write(`${l}\n`),
    ids: trooperIdentities(process.env),
    signal: stopping.signal,
  });
  process.exitCode = result.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`${describeFatal(err)}\n`);
    process.exitCode = 1;
  });
}
