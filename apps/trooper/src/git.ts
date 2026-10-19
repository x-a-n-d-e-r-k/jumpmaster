import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubEnv } from './gates.js';

/** The only URL prefix the forge auth header is ever sent to. */
export const AUTH_SCOPE = 'https://github.com/';

export interface RemoteTarget {
  owner: string;
  name: string;
  /** Test-only override of the explicit https://github.com/<owner>/<name>.git URL. */
  url?: string;
}

const remoteUrl = (t: RemoteTarget): string => t.url ?? `${AUTH_SCOPE}${t.owner}/${t.name}.git`;

export function runGit(cwd: string | undefined, args: string[], token = ''): Promise<string> {
  // Auth rides in the child's env (not argv, so not in ps or error messages) for this one command,
  // scoped to github.com only, and never reaches .git/config. Every inherited GIT_* variable is
  // dropped (scrubEnv) and global/system config is ignored, so nothing outside the repo the
  // command runs in can redirect the push or inject config.
  const auth: NodeJS.ProcessEnv = token
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${AUTH_SCOPE}.extraheader`,
        GIT_CONFIG_VALUE_0: authHeader(token),
      }
    : {};
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...scrubEnv(process.env),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          ...auth,
        },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        // Never use err.message: it embeds the full command line.
        const code = (err as NodeJS.ErrnoException).code;
        const detail = stderr.trim();
        reject(
          new Error(
            `git ${args[0]} failed (${typeof code === 'number' ? `exit ${code}` : String(code)})${detail ? `: ${detail}` : ''}`,
          ),
        );
      },
    );
  });
}

export function authHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

const run = runGit;

export async function cloneRepo(o: {
  owner: string;
  name: string;
  token: string;
  dir: string;
  url?: string;
}): Promise<void> {
  await run(undefined, ['clone', remoteUrl(o), o.dir], o.token);
  await run(o.dir, ['config', 'user.name', 'Jumpmaster Agent']);
  await run(o.dir, ['config', 'user.email', 'jumpmaster-agent@users.noreply.github.com']);
}

export async function prepareBranch(dir: string, branch: string, base: string): Promise<void> {
  await run(dir, ['switch', '-c', branch, `origin/${base}`]);
}

export async function commitIfDirty(dir: string, message: string): Promise<boolean> {
  if ((await run(dir, ['status', '--porcelain'])) === '') return false;
  await run(dir, ['add', '-A']);
  await run(dir, ['commit', '-m', message]);
  return true;
}

export function headSha(dir: string): Promise<string> {
  return run(dir, ['rev-parse', 'HEAD']);
}

export async function aheadOfBase(dir: string, base: string): Promise<number> {
  return Number.parseInt(await run(dir, ['rev-list', '--count', `origin/${base}..HEAD`]), 10);
}

/** Hardening applied to every git command that carries the token. */
const PRISTINE = ['-c', 'core.hooksPath=/dev/null'];
const protocolFor = (url: string): string[] =>
  url.startsWith('file://')
    ? []
    : ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

/**
 * True when refs/heads/<branch> exists on the remote. Runs from a fresh, trooper-owned directory
 * against the explicit remote URL, so nothing in the working copy is consulted.
 */
export async function remoteBranchExists(
  target: RemoteTarget,
  branch: string,
  token: string,
): Promise<boolean> {
  const cwd = mkdtempSync(join(tmpdir(), 'jm-lsremote-'));
  try {
    const url = remoteUrl(target);
    const out = await run(
      cwd,
      [...PRISTINE, ...protocolFor(url), 'ls-remote', '--heads', url, `refs/heads/${branch}`],
      token,
    );
    return out !== '';
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Pushes <branch> to the explicit remote URL from a pristine, trooper-owned bare repo.
 *
 * The working copy (and its .git/) is agent-writable: hooks, core.hooksPath, pushurl or insteadOf
 * redirects planted there would see or reroute the token. So the commits are first fetched into a
 * fresh bare repo WITHOUT the token, then pushed from there with hooks disabled. `sweep` kills any
 * lingering agent/gate process (which could read the push's environ) and runs before the bare
 * repo is created and again right before the token is used. Returns the pushed commit sha.
 */
export async function pushNewBranch(
  dir: string,
  branch: string,
  token: string,
  target: RemoteTarget,
  sweep: () => void = () => {},
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  sweep();
  const bare = mkdtempSync(join(tmpdir(), 'jm-push-'));
  try {
    await run(bare, ['init', '--bare', '-q', '--template=', '.']);
    // Local fetch, no token: the only place file:// is allowed.
    await run(bare, [
      ...PRISTINE,
      '-c',
      'protocol.file.allow=always',
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      dir,
      `+${ref}:${ref}`,
    ]);
    sweep();
    // Anything spawned during the fetch is gone now; rewrite the config it could have touched.
    writeFileSync(join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    rmSync(join(bare, 'hooks'), { recursive: true, force: true });
    const sha = await run(bare, ['rev-parse', '--verify', `${ref}^{commit}`]);
    const url = remoteUrl(target);
    // Empty expected value: the remote branch must not exist yet.
    await run(
      bare,
      [
        ...PRISTINE,
        ...protocolFor(url),
        'push',
        '-q',
        `--force-with-lease=${ref}:`,
        url,
        `${ref}:${ref}`,
      ],
      token,
    );
    return sha;
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
}

/**
 * In container mode (the trooper is PID 1 and the only trusted process), SIGKILLs every other
 * process this uid can signal, so no agent or gate leftover can read the token from a git child's
 * environ. A no-op anywhere else: never signal processes on a host.
 */
export function sweepProcesses(
  env: NodeJS.ProcessEnv = process.env,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill.bind(process),
): boolean {
  if (env.JM_CONTAINER !== '1') return false;
  try {
    kill(-1, 'SIGKILL');
  } catch {
    // ESRCH: nothing else is running
  }
  return true;
}
