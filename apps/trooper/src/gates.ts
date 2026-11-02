import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import type { GateResult, GateSpec } from '@jumpmaster/protocol';
import { type AgentIdentity, agentSpawnOptions, asAgentArgv } from './privilege.js';
import { redact } from './redact.js';

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnImpl: SpawnFn = spawn;
/** Test seam for the gate process runner (null restores `child_process.spawn`). */
export function setGateSpawn(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
}

const TAIL_CHARS = 4000;
// Keep a window well beyond the tail so a secret straddling the cut is still redacted whole.
const WINDOW_CHARS = 64 * 1024;
const KILL_GRACE_MS = 5000;
const STRIPPED_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
]);

export function scrubEnv(env: NodeJS.ProcessEnv, secrets: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (STRIPPED_KEYS.has(k) || k.startsWith('JM_') || k.startsWith('GIT_')) continue;
    if (v !== undefined && v !== '' && secrets.includes(v)) continue;
    out[k] = v;
  }
  return out;
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

function runOne(
  gate: GateSpec,
  o: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    secrets: string[];
    timeoutScale: number;
    as?: AgentIdentity | null;
  },
): Promise<GateResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let window = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    // As another uid, root (no DAC_OVERRIDE) cannot chdir into that uid's private home, so the
    // process starts in / and changes directory after the uid drop.
    const argv = o.as
      ? ['sh', '-c', 'cd -- "$1" && exec sh -c "$2"', 'jm-gate', o.cwd, gate.run]
      : ['sh', '-c', gate.run];
    const [cmd, ...args] = asAgentArgv(o.as ?? null, argv) as [string, ...string[]];
    const child = spawnImpl(cmd, args, {
      cwd: o.as ? '/' : o.cwd,
      env: agentSpawnOptions(o.as ?? null, scrubEnv(o.env, o.secrets)).env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    const onData = (chunk: Buffer): void => {
      window += chunk.toString('utf8');
      if (window.length > WINDOW_CHARS) window = window.slice(-WINDOW_CHARS);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      killGroup(pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
    }, gate.timeoutMinutes * o.timeoutScale);

    let done = false;
    const finish = (exitCode: number | null, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Reap anything the gate left behind in its process group.
      if (pid !== undefined) killGroup(pid, 'SIGKILL');
      const outputTail = redact(window + extra, o.secrets).slice(-TAIL_CHARS);
      resolve({
        name: gate.name,
        exitCode: timedOut ? null : exitCode,
        durationMs: Date.now() - started,
        timedOut,
        outputTail,
      });
    };
    child.on('error', (err) => finish(null, `\n${err.message}`));
    child.on('close', (code) => finish(code));
  });
}

export async function runGates(
  gates: GateSpec[],
  o: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    secrets: string[];
    timeoutScale?: number;
    /** Run each gate as this unprivileged identity (container mode). */
    as?: AgentIdentity | null;
  },
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const r = await runOne(gate, { ...o, timeoutScale: o.timeoutScale ?? 60_000 });
    results.push(r);
    if (r.timedOut || r.exitCode !== 0) break;
  }
  return results;
}
