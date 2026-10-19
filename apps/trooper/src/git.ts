import { execFile } from 'node:child_process';
import { scrubEnv } from './gates.js';

export function runGit(cwd: string | undefined, args: string[], token = ''): Promise<string> {
  // Auth rides in the child's env (not argv, so not in ps or error messages) for this one command
  // and never reaches .git/config.
  const auth: NodeJS.ProcessEnv = token
    ? {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraheader',
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
        env: { ...scrubEnv(process.env), GIT_TERMINAL_PROMPT: '0', ...auth },
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
  const url = o.url ?? `https://github.com/${o.owner}/${o.name}.git`;
  await run(undefined, ['clone', url, o.dir], o.token);
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

export async function pushNewBranch(dir: string, branch: string, token: string): Promise<void> {
  // Empty expected value: the remote branch must not exist yet.
  await run(dir, ['push', `--force-with-lease=refs/heads/${branch}:`, 'origin', branch], token);
}
