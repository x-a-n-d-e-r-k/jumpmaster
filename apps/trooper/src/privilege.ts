import { spawn } from 'node:child_process';
import { constants, readdirSync, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

/** An unprivileged identity inside the trooper container. */
export type AgentIdentity = { uid: number; gid: number; home: string };
export type TrooperIdentities = { agent: AgentIdentity; gate: AgentIdentity };

function identityFrom(env: NodeJS.ProcessEnv, prefix: 'AGENT' | 'GATE'): AgentIdentity | null {
  const uid = Number(env[`JM_${prefix}_UID`]);
  const gid = Number(env[`JM_${prefix}_GID`]);
  const home = env[`JM_${prefix}_HOME`];
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0 || !home) {
    return null;
  }
  return { uid, gid, home };
}

/**
 * The agent and gate identities, only in container mode and only when this process is root.
 * Outside the container (tests, local runs) everything runs as the current user.
 */
export function trooperIdentities(
  env: NodeJS.ProcessEnv,
  getuid: () => number = () => process.getuid?.() ?? -1,
): TrooperIdentities | null {
  if (env.JM_CONTAINER !== '1' || getuid() !== 0) return null;
  const agent = identityFrom(env, 'AGENT');
  const gate = identityFrom(env, 'GATE');
  if (!agent || !gate || agent.uid === gate.uid) return null;
  return { agent, gate };
}

/** SIGKILLs every process whose real or effective uid is `uid`; returns how many were signalled. */
export function sweepUid(
  uid: number,
  kill: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) => process.kill(pid, sig),
  procRoot = '/proc',
): number {
  let killed = 0;
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let status: string;
    try {
      status = readFileSync(join(procRoot, entry, 'status'), 'utf8');
    } catch {
      continue; // exited
    }
    const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
    if (!m || (Number(m[1]) !== uid && Number(m[2]) !== uid)) continue;
    try {
      kill(Number(entry), 'SIGKILL');
      killed++;
    } catch {
      // already gone
    }
  }
  return killed;
}

/** Environment for a process running as `id` (HOME and CLAUDE_CONFIG_DIR under its home). */
export function agentSpawnOptions(
  id: AgentIdentity | null,
  env: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv } {
  if (!id) return { env };
  return { env: { ...env, HOME: id.home, CLAUDE_CONFIG_DIR: join(id.home, '.claude') } };
}

/**
 * argv that runs `argv` as `id` with no supplementary groups and umask 022. Node's `spawn` has no
 * umask option, so the uid, gid and umask are all applied here.
 */
export function asAgentArgv(id: AgentIdentity | null, argv: string[]): string[] {
  if (!id) return argv;
  return [
    'setpriv',
    `--reuid=${id.uid}`,
    `--regid=${id.gid}`,
    '--clear-groups',
    '--',
    'sh',
    '-c',
    'umask 022; exec "$@"',
    'jm-agent',
    ...argv,
  ];
}

function runAs(argv: string[], maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv as [string, ...string[]];
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        child.kill('SIGKILL');
        reject(new Error('agent file too large'));
        return;
      }
      chunks.push(c);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (size > maxBytes) return;
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`reading agent file failed (exit ${code})`));
    });
  });
}

/**
 * The only permitted way for root to read a file the agent could have written. With an identity
 * the read happens as that uid; without one, symlinks and non-regular files are refused.
 */
export async function readAgentFile(
  path: string,
  id: AgentIdentity | null,
  maxBytes = 1_048_576,
): Promise<string> {
  if (id) return runAs(asAgentArgv(id, ['cat', '--', path]), maxBytes);
  const st = await lstat(path);
  if (!st.isFile()) throw new Error('agent file is not a regular file');
  if (st.size > maxBytes) throw new Error('agent file too large');
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const text = await fh.readFile('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw new Error('agent file too large');
    return text;
  } finally {
    await fh.close();
  }
}
