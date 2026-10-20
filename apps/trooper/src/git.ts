import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, matchesGlob, sep } from 'node:path';
import type { MergeOutcome } from '@jumpmaster/protocol';
import { scrubEnv } from './gates.js';
import { type AgentIdentity, asAgentArgv, type TrooperIdentities } from './privilege.js';
import { containsSecret } from './redact.js';

/** The only URL prefix the forge auth header is ever sent to. */
export const AUTH_SCOPE = 'https://github.com/';

export const PUSH_FETCH_TIMEOUT_MS = 120_000;
export const PUSH_FETCH_MAX_BYTES = 1024 * 1024 * 1024;

const AGENT_NAME = 'Jumpmaster Agent';
const AGENT_EMAIL = 'jumpmaster-agent@users.noreply.github.com';

export interface RemoteTarget {
  owner: string;
  name: string;
  /** Test-only override of the explicit https://github.com/<owner>/<name>.git URL. */
  url?: string;
}

const remoteUrl = (t: RemoteTarget): string => t.url ?? `${AUTH_SCOPE}${t.owner}/${t.name}.git`;

// ---- process seam --------------------------------------------------------------------------------

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnImpl: SpawnFn = spawn;

/** Test seam: replaces the process runner used by every function in this module (null restores). */
export function setSpawn(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
}

/** Root-owned scratch for repo-less root calls (ls-remote). Defaults to the real tmpdir. */
let workRoot = realpathSync(tmpdir());
export function setWorkRoot(dir: string): void {
  workRoot = dir;
}

type ExecOpts = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  timeoutMs?: number;
  /** Polled every second while running; return an error message to abort. */
  watch?: () => string | null;
};

function exec(argv: string[], o: ExecOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv as [string, ...string[]];
    const child = spawnImpl(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted: string | null = null;
    const abort = (msg: string) => {
      if (aborted) return;
      aborted = msg;
      child.kill('SIGKILL');
    };
    const timer =
      o.timeoutMs !== undefined ? setTimeout(() => abort('timeout'), o.timeoutMs) : null;
    const poll = o.watch
      ? setInterval(() => {
          const m = o.watch?.();
          if (m) abort(m);
        }, 1000)
      : null;
    child.stdout?.on('data', (c: Buffer) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-8192);
    });
    const done = () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
    child.on('error', (e) => {
      done();
      reject(
        new Error(`${o.label} failed (${(e as NodeJS.ErrnoException).code ?? 'spawn error'})`),
      );
    });
    child.on('close', (code) => {
      done();
      if (aborted) return reject(new Error(aborted));
      if (code === 0) return resolve(stdout.trim());
      // Never echo the command line: it may carry the upload-pack wrapper or paths.
      const detail = stderr.trim();
      reject(new Error(`${o.label} failed (exit ${code})${detail ? `: ${detail}` : ''}`));
    });
  });
}

/** The git subcommand, skipping leading `-c k=v` pairs and other global options. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '-c' || a === '-C') {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return '?';
}

export function authHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

/**
 * Checks every path component from `/` down to `path`: a real directory (not a symlink) and, when
 * this process is root, owned by uid 0 and not group- or other-writable.
 */
export function assertRootOwnedDir(
  path: string,
  getuid: () => number = () => process.getuid?.() ?? -1,
): void {
  const root = getuid() === 0;
  const parts = path.split(sep).filter(Boolean);
  let cur: string = sep;
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) cur = join(cur, parts[i - 1] as string);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      throw new Error(`unsafe root git dir: ${cur}`);
    }
    const bad =
      st.isSymbolicLink() ||
      !st.isDirectory() ||
      (root && (st.uid !== 0 || (st.mode & 0o022) !== 0 || (st.mode & 0o002) !== 0));
    if (bad) throw new Error(`unsafe root git dir: ${cur}`);
  }
}

export type RunGitOpts = {
  /** Run as this unprivileged identity (working-copy calls). Never with a token. */
  as?: AgentIdentity | null;
  /** Root call: a root-owned bare repo; sets GIT_DIR / GIT_COMMON_DIR / GIT_CEILING_DIRECTORIES. */
  gitDir?: string;
  extraConfig?: [string, string][];
  timeoutMs?: number;
  watch?: () => string | null;
};

/**
 * Runs git. Auth rides in the child's env (never argv or config) as GIT_CONFIG_KEY_0, scoped to
 * github.com. Inherited GIT_* variables and global/system config are ignored. A token is only ever
 * used by a root call in a root-owned `gitDir`; working-copy calls carry no token.
 */
export function runGit(
  cwd: string | undefined,
  args: string[],
  token = '',
  opts: RunGitOpts = {},
): Promise<string> {
  if (token && opts.as) return Promise.reject(new Error('runGit: a token with an agent identity'));
  if (token && !opts.gitDir) {
    return Promise.reject(new Error('runGit: a token outside a root-owned git dir'));
  }
  const config: [string, string][] = [
    ...(token
      ? ([[`http.${AUTH_SCOPE}.extraheader`, authHeader(token)]] as [string, string][])
      : []),
    ...(opts.extraConfig ?? []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  if (config.length > 0) {
    env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
  }
  let dir = cwd ?? workRoot;
  if (opts.gitDir) {
    try {
      assertRootOwnedDir(opts.gitDir);
    } catch (e) {
      return Promise.reject(e);
    }
    env.GIT_DIR = opts.gitDir;
    env.GIT_COMMON_DIR = opts.gitDir;
    env.GIT_CEILING_DIRECTORIES = dirname(opts.gitDir);
    dir = dirname(opts.gitDir);
  }
  return exec(asAgentArgv(opts.as ?? null, ['git', ...args]), {
    cwd: dir,
    env,
    label: `git ${subcommand(args)}`,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.watch ? { watch: opts.watch } : {}),
  });
}

/** Hardening applied to every root git command. */
const PRISTINE = ['-c', 'core.hooksPath=/dev/null'];
const protocolFor = (url: string): string[] =>
  url.startsWith('file://')
    ? ['-c', 'protocol.file.allow=always']
    : ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always'];

function ensureRootDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o755 });
}

async function initBare(gitDir: string): Promise<void> {
  ensureRootDir(gitDir);
  await runGit(undefined, ['init', '--bare', '-q', '--template='], '', { gitDir });
  // Fixed config: nothing an earlier process wrote survives.
  writeFileSync(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
  rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
}

/** Root, in the mirror only: refresh `refs/heads/<ref>` (`*` for all heads) from the remote. */
export async function mirrorFetch(
  mirrorDir: string,
  token: string,
  target: RemoteTarget,
  refs: string[],
): Promise<void> {
  const url = remoteUrl(target);
  await runGit(
    undefined,
    [
      ...PRISTINE,
      ...protocolFor(url),
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      '--prune',
      url,
      ...refs.map((r) => `+refs/heads/${r}:refs/heads/${r}`),
    ],
    token,
    { gitDir: mirrorDir },
  );
}

/**
 * Root clones the remote into a root-owned bare mirror (with the token); the agent then clones the
 * working copy from the mirror (no token) and sets the Jumpmaster Agent identity.
 */
export async function cloneRepo(o: {
  owner: string;
  name: string;
  token: string;
  dir: string;
  mirrorDir?: string;
  url?: string;
  as?: AgentIdentity | null;
}): Promise<void> {
  if (o.as && !o.mirrorDir) throw new Error('mirrorDir required with an agent identity');
  const mirrorDir = o.mirrorDir ?? join(dirname(o.dir), 'mirror');
  await initBare(mirrorDir);
  await mirrorFetch(mirrorDir, o.token, o, ['*']);
  const as = o.as ?? null;
  await runGit(
    dirname(o.dir),
    ['clone', '-q', '--no-hardlinks', `file://${mirrorDir}`, o.dir],
    '',
    {
      as,
      extraConfig: [['protocol.file.allow', 'always']],
    },
  );
  await runGit(o.dir, ['config', 'user.name', AGENT_NAME], '', { as });
  await runGit(o.dir, ['config', 'user.email', AGENT_EMAIL], '', { as });
}

export async function prepareBranch(
  dir: string,
  branch: string,
  base: string,
  as: AgentIdentity | null = null,
): Promise<void> {
  await runGit(dir, ['switch', '-q', '-c', branch, `origin/${base}`], '', { as });
}

export async function commitIfDirty(
  dir: string,
  message: string,
  as: AgentIdentity | null = null,
): Promise<boolean> {
  if ((await runGit(dir, ['status', '--porcelain'], '', { as })) === '') return false;
  await runGit(dir, ['add', '-A'], '', { as });
  await runGit(dir, ['commit', '-q', '-m', message], '', { as });
  return true;
}

export function headSha(dir: string, as: AgentIdentity | null = null): Promise<string> {
  return runGit(dir, ['rev-parse', 'HEAD'], '', { as });
}

/** Working-tree fingerprint: porcelain status (untracked included) plus HEAD, run as `as`. */
export async function treeState(dir: string, as: AgentIdentity | null = null): Promise<string> {
  const status = await runGit(
    dir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    '',
    {
      as,
    },
  );
  return `${await headSha(dir, as)}\n${status}`;
}

export async function aheadOfBase(
  dir: string,
  base: string,
  as: AgentIdentity | null = null,
): Promise<number> {
  return Number.parseInt(
    await runGit(dir, ['rev-list', '--count', `origin/${base}..HEAD`], '', { as }),
    10,
  );
}

/** The remote tip of refs/heads/<branch>, or null. Runs from a fresh root-owned bare repo. */
export async function remoteBranchSha(
  target: RemoteTarget,
  branch: string,
  token: string,
): Promise<string | null> {
  const scratch = mkdtempSync(join(workRoot, 'jm-lsremote-'));
  try {
    await initBare(scratch);
    const url = remoteUrl(target);
    const out = await runGit(
      undefined,
      [...PRISTINE, ...protocolFor(url), 'ls-remote', '--heads', url, `refs/heads/${branch}`],
      token,
      { gitDir: scratch },
    );
    const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? (line.split('\t')[0] as string) : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function remoteBranchExists(
  target: RemoteTarget,
  branch: string,
  token: string,
): Promise<boolean> {
  return (await remoteBranchSha(target, branch, token)) !== null;
}

/** After `mirrorFetch`, the agent fetches `branch` from the mirror and checks it out at `expectedSha`. */
export async function checkoutBranch(
  dir: string,
  branch: string,
  expectedSha: string,
  as: AgentIdentity | null = null,
): Promise<void> {
  await runGit(
    dir,
    ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    '',
    { as, extraConfig: [['protocol.file.allow', 'always']] },
  );
  await runGit(dir, ['switch', '-q', '-C', branch, `origin/${branch}`], '', { as });
  const got = await headSha(dir, as);
  if (got !== expectedSha) throw new Error(`head moved: expected ${expectedSha} got ${got}`);
}

/** The agent merges origin/<base> (refreshed from the mirror); conflicts are left in the tree. */
export async function mergeBase(
  dir: string,
  base: string,
  as: AgentIdentity | null = null,
): Promise<MergeOutcome> {
  await runGit(
    dir,
    ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`],
    '',
    { as, extraConfig: [['protocol.file.allow', 'always']] },
  );
  const before = await headSha(dir, as);
  try {
    await runGit(dir, ['merge', '--no-edit', '-q', `origin/${base}`], '', {
      as,
      extraConfig: [
        ['user.name', AGENT_NAME],
        ['user.email', AGENT_EMAIL],
      ],
    });
  } catch (e) {
    const unmerged = await runGit(dir, ['diff', '--name-only', '--diff-filter=U'], '', { as });
    if (unmerged !== '') return 'conflicts';
    throw e;
  }
  return (await headSha(dir, as)) === before ? 'up_to_date' : 'clean';
}

/** Tracked files that still hold a `<<<<<<<` or `>>>>>>>` conflict-marker line. */
export async function conflictMarkers(
  dir: string,
  as: AgentIdentity | null = null,
): Promise<string[]> {
  try {
    const out = await runGit(dir, ['grep', '-l', '-I', '-E', '-e', '^(<<<<<<<|>>>>>>>)( |$)'], '', {
      as,
    });
    return out.split('\n').filter((l) => l !== '');
  } catch (e) {
    // git grep exits 1 when nothing matches.
    if (e instanceof Error && e.message.includes('(exit 1)')) return [];
    throw e;
  }
}

/** True while a merge is unconcluded (MERGE_HEAD present or unmerged index entries). */
export async function mergeInProgress(
  dir: string,
  as: AgentIdentity | null = null,
): Promise<boolean> {
  if ((await runGit(dir, ['ls-files', '-u'], '', { as })) !== '') return true;
  try {
    await runGit(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], '', { as });
    return true;
  } catch {
    return false;
  }
}

export type PushOptions = {
  as?: AgentIdentity | null;
  /** Base branch for the pre-push guard; without it no guard runs. */
  base?: string;
  protectedPaths?: string[];
  /** Credential values the push must not carry (in added lines or commit messages). */
  secrets?: string[];
  limits?: { timeoutMs: number; maxBytes: number };
  /** Root mirror; defaults to `<dirname(dir)>/mirror`. */
  mirrorDir?: string;
};

function dirSize(path: string): number {
  let total = 0;
  const walk = (p: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e));
    } else {
      total += st.size;
    }
  };
  walk(path);
  return total;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `dir/**` also covers the bare `dir` entry itself (a file or symlink named like the directory). */
const globHit = (p: string, globs: string[]): boolean =>
  globs.some(
    (g) =>
      matchesGlob(p, g) ||
      (g.endsWith('/**') && p === g.slice(0, -3)) ||
      (!g.includes('/') && matchesGlob(basename(p), g)),
  );

/**
 * Root, in the root-owned bare repo only: refuses protected-path changes against the trusted base
 * (`refs/jm/base`, fetched from the root mirror) and commits this push adds that are not authored
 * and committed by Jumpmaster Agent. Returns the refusal, or null.
 */
export async function prePushCheck(
  bareDir: string,
  branch: string,
  protectedPaths: string[],
  since: string,
  secrets: string[] = [],
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  // -z: paths are raw bytes, never C-quoted, so a non-ASCII name cannot dodge the glob.
  const diff = await runGit(
    undefined,
    ['--no-replace-objects', 'diff', '--name-status', '-z', '-M', `refs/jm/base...${ref}`],
    '',
    { gitDir: bareDir },
  );
  const fields = diff.split('\0');
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++] ?? '';
    if (status === '') continue;
    // Renames and copies carry source then destination; the source is reported first.
    const n = /^[RC]/.test(status) ? 2 : 1;
    for (const p of fields.slice(i, i + n))
      if (globHit(p, protectedPaths)) return `protected path ${p}`;
    i += n;
  }
  // Nothing this push adds may carry a credential: added lines and commit messages.
  const patch = await runGit(
    undefined,
    [
      '--no-replace-objects',
      'diff',
      '--text',
      '--no-textconv',
      '--no-ext-diff',
      '--no-color',
      '-U0',
      `refs/jm/base...${ref}`,
    ],
    '',
    { gitDir: bareDir },
  );
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  const messages = await runGit(
    undefined,
    ['--no-replace-objects', 'log', '--format=%B', `${since}..${ref}`, '^refs/jm/base'],
    '',
    { gitDir: bareDir },
  );
  if (containsSecret(added, secrets) || containsSecret(messages, secrets)) return 'secret in diff';
  const log = await runGit(
    undefined,
    [
      '--no-replace-objects',
      'log',
      '--format=%an%x00%ae%x00%cn%x00%ce',
      `${since}..${ref}`,
      '^refs/jm/base',
    ],
    '',
    { gitDir: bareDir },
  );
  for (const line of log.split('\n').filter(Boolean)) {
    const [an, ae, cn, ce] = line.split('\0');
    if (an !== AGENT_NAME || cn !== AGENT_NAME || ae !== AGENT_EMAIL || ce !== AGENT_EMAIL) {
      return 'foreign commit identity';
    }
  }
  return null;
}

async function guardedPush(
  dir: string,
  branch: string,
  token: string,
  target: RemoteTarget,
  lease: string,
  sweep: () => void,
  o: PushOptions,
): Promise<string> {
  const ref = `refs/heads/${branch}`;
  const mirrorDir = o.mirrorDir ?? join(dirname(dir), 'mirror');
  const limits = o.limits ?? { timeoutMs: PUSH_FETCH_TIMEOUT_MS, maxBytes: PUSH_FETCH_MAX_BYTES };
  const pushDir = mkdtempSync(join(dirname(mirrorDir), 'push-'));
  try {
    await initBare(pushDir);
    const uploadPack = asAgentArgv(o.as ?? null, ['git-upload-pack'])
      .map(shellQuote)
      .join(' ');
    const tooLarge = () => (dirSize(pushDir) > limits.maxBytes ? 'push fetch too large' : null);
    sweep();
    try {
      await runGit(
        undefined,
        [
          ...PRISTINE,
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          `--upload-pack=${uploadPack}`,
          `file://${dir}`,
          `+${ref}:${ref}`,
        ],
        '',
        { gitDir: pushDir, timeoutMs: limits.timeoutMs, watch: tooLarge },
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'timeout') throw new Error('push fetch timed out');
      if (msg === 'push fetch too large') throw e;
      throw e;
    }
    if (tooLarge()) throw new Error('push fetch too large');
    sweep();
    // Nothing the agent fetch could have touched survives.
    writeFileSync(
      join(pushDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = true\n',
    );
    rmSync(join(pushDir, 'hooks'), { recursive: true, force: true });

    if (o.base !== undefined) {
      await mirrorFetch(mirrorDir, token, target, [o.base]);
      await runGit(
        undefined,
        [
          ...PRISTINE,
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          `file://${mirrorDir}`,
          `+refs/heads/${o.base}:refs/jm/base`,
        ],
        '',
        { gitDir: pushDir },
      );
      const refusal = await prePushCheck(
        pushDir,
        branch,
        o.protectedPaths ?? [],
        lease === '' ? 'refs/jm/base' : lease,
        o.secrets ?? [],
      );
      if (refusal) throw new Error(refusal);
    }

    const sha = await runGit(undefined, ['rev-parse', '--verify', `${ref}^{commit}`], '', {
      gitDir: pushDir,
    });
    const url = remoteUrl(target);
    try {
      await runGit(
        undefined,
        [
          ...PRISTINE,
          ...protocolFor(url),
          'push',
          '-q',
          `--force-with-lease=${ref}:${lease}`,
          url,
          `${ref}:${ref}`,
        ],
        token,
        { gitDir: pushDir },
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (/stale info|rejected/.test(msg)) throw new Error(`stale info: ${msg.slice(-300)}`);
      throw e;
    }
    return sha;
  } finally {
    rmSync(pushDir, { recursive: true, force: true });
  }
}

/** Pushes a branch that must not exist on the remote yet. Returns the pushed sha. */
export function pushNewBranch(
  dir: string,
  branch: string,
  token: string,
  target: RemoteTarget,
  sweep: () => void = () => {},
  o: PushOptions = {},
): Promise<string> {
  return guardedPush(dir, branch, token, target, '', sweep, o);
}

/** Pushes onto an existing branch, leased on its expected remote tip. Returns the pushed sha. */
export function pushExistingBranch(
  dir: string,
  branch: string,
  token: string,
  target: RemoteTarget,
  expectedRemoteSha: string,
  sweep: () => void = () => {},
  o: PushOptions = {},
): Promise<string> {
  return guardedPush(dir, branch, token, target, expectedRemoteSha, sweep, o);
}

/** `rm -rf` as `as` (root has no DAC_OVERRIDE over the agent's private files). */
export async function removeTree(dir: string, as: AgentIdentity | null = null): Promise<void> {
  if (!as) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  await exec(asAgentArgv(as, ['rm', '-rf', '--', dir]), {
    cwd: '/',
    env: scrubEnv(process.env),
    label: 'rm',
  });
}

/**
 * Container mode: the agent bundles HEAD into its home; the gate uid clones the bundle into a fresh
 * `gateDir`. No git process runs in the other uid's repo.
 */
export async function cloneForGates(
  agentDir: string,
  gateDir: string,
  ids: TrooperIdentities,
): Promise<void> {
  const bundle = join(ids.agent.home, 'gates.bundle');
  await runGit(agentDir, ['bundle', 'create', '-q', bundle, 'HEAD'], '', { as: ids.agent });
  await removeTree(gateDir, ids.gate);
  await runGit(ids.gate.home, ['clone', '-q', bundle, gateDir], '', { as: ids.gate });
}

/**
 * In container mode (the trooper is PID 1 and the only trusted process), SIGKILLs every other
 * process this uid can signal. A no-op anywhere else: never signal processes on a host.
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
