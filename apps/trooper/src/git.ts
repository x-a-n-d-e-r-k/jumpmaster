import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import {
  type DropPayload,
  type ForgeRemote,
  findPrivateKeys,
  gitlabBasicAuthAs,
  type MergeOutcome,
  type PushGrant,
  type PushResult,
  protectedPathMatches,
} from '@jumpmaster/protocol';
import { scrubEnv } from './gates.js';
import {
  type AgentIdentity,
  asAgentArgv,
  asAgentInDirArgv,
  type TrooperIdentities,
} from './privilege.js';
import { containsSecret, redact } from './redact.js';

/** The only URL prefix a GitHub target's auth header is ever sent to. */
export const AUTH_SCOPE = 'https://github.com/';

export const PUSH_FETCH_TIMEOUT_MS = 120_000;
export const PUSH_FETCH_MAX_BYTES = 1024 * 1024 * 1024;

const AGENT_NAME = 'Jumpmaster Agent';
const AGENT_EMAIL = 'jumpmaster-agent@users.noreply.github.com';

export interface RemoteTarget {
  owner: string;
  name: string;
  /**
   * A GitLab remote: the URL is `<origin>/<projectPath>.git` and the auth is scoped to
   * `<origin>/`, built from it alone. `owner` and `name` then name nothing on the wire.
   */
  forge?: ForgeRemote;
  /** Test-only override of the explicit remote URL (the auth scope still follows the target). */
  url?: string;
}

/** The target a drop's `repo` names: GitHub `<owner>/<name>`, or its GitLab `forge`. */
export function repoTarget(repo: DropPayload['repo']): RemoteTarget {
  return { owner: repo.owner, name: repo.name, ...(repo.forge ? { forge: repo.forge } : {}) };
}

const remoteUrl = (t: RemoteTarget): string =>
  t.url ??
  (t.forge
    ? `${t.forge.origin}/${t.forge.projectPath}.git`
    : `${AUTH_SCOPE}${t.owner}/${t.name}.git`);

/** The only URL prefix the target's auth header is sent to. */
export const authScope = (t: RemoteTarget): string => (t.forge ? `${t.forge.origin}/` : AUTH_SCOPE);

/** The basic-auth username for a GitLab target: a deploy token's own, else `oauth2`. */
const forgeUser = (username: string | undefined): string => username ?? 'oauth2';

/**
 * The auth header git sends to the target's scope. A GitLab target authenticates as `username`
 * (a deploy token's own) or, absent, `oauth2`; a GitHub target ignores it.
 */
export const targetAuthHeader = (t: RemoteTarget, token: string, username?: string): string =>
  t.forge
    ? `AUTHORIZATION: basic ${gitlabBasicAuthAs(forgeUser(username), token)}`
    : authHeader(token);

/** The forms of `token` to redact from what git says about the target. */
export const targetTokenSecrets = (t: RemoteTarget, token: string, username?: string): string[] => [
  token,
  authHeader(token),
  ...(t.forge ? [gitlabBasicAuthAs(forgeUser(username), token)] : []),
  ...(t.forge && username !== undefined
    ? [`${username}:${token}`, gitlabBasicAuthAs('oauth2', token)]
    : []),
];

// ---- process seam --------------------------------------------------------------------------------

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnImpl: SpawnFn = spawn;

/** Test seam: replaces the process runner used by every function in this module (null restores). */
export function setSpawn(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
}

/** The most stdout `exec` accepts from one child; past it the call fails, never truncates. */
export const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
let outputMaxBytes = GIT_OUTPUT_MAX_BYTES;

/** Test seam: lowers the stdout cap `exec` enforces (null restores the default). */
export function setGitOutputMaxBytes(n: number | null): void {
  outputMaxBytes = n ?? GIT_OUTPUT_MAX_BYTES;
}

/** Root-owned scratch for repo-less root calls (ls-remote). Defaults to the real tmpdir. */
let workRoot = realpathSync(tmpdir());
export function setWorkRoot(dir: string): void {
  workRoot = dir;
}

// ---- a GitLab grant's private CA (#947) --------------------------------------------------------

/** The image's system roots: a grant's CA file starts with them, never replaces them. */
export const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
let systemCaBundle = SYSTEM_CA_BUNDLE;
/** Test seam: the system bundle a grant's CA file starts with (null restores the default). */
export function setSystemCaBundle(path: string | null): void {
  systemCaBundle = path ?? SYSTEM_CA_BUNDLE;
}

/** How every failure about a grant's CA names it: never a path or any of the PEM text. */
export const GITLAB_CA_BUNDLE = 'the GitLab CA bundle';

/** A grant's CA file, written for one push or clone; `remove` deletes it and its directory. */
export interface GrantCa {
  /** `http.<origin>/.sslCAInfo=<file>`: the trust, scoped to the grant's GitLab origin. */
  config: [string, string][];
  remove(): void;
}

/**
 * Writes the system bundle followed by `caCert` to a 0600 file in a fresh 0700 directory of this
 * process's uid, under the root scratch (never in a push dir or a mirror an agent later mounts).
 * The returned config trusts it for `forge`'s origin only, port kept. Throws, naming only
 * `GITLAB_CA_BUNDLE`, when the system bundle can't be read or the file can't be written: no
 * fallback to the grant's certificates alone or to the default roots.
 */
export function writeGrantCa(forge: ForgeRemote, caCert: string): GrantCa {
  let dir: string | null = null;
  const remove = () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
  try {
    const system = readFileSync(systemCaBundle, 'utf8');
    dir = mkdtempSync(join(workRoot, 'jm-ca-'));
    chmodSync(dir, 0o700);
    const file = join(dir, 'ca.crt');
    const sep = system === '' || system.endsWith('\n') ? '' : '\n';
    writeFileSync(file, `${system}${sep}${caCert}`, { mode: 0o600, flag: 'wx' });
    return {
      config: [[`http.${authScope({ owner: '', name: '', forge })}.sslCAInfo`, file]],
      remove,
    };
  } catch {
    remove();
    throw new Error(`could not prepare ${GITLAB_CA_BUNDLE}`);
  }
}

/**
 * Where a drop's provided mirror is mounted, read-only, in the agent's container: the clone
 * container fetched the project into a root-owned bare repo there (`repo.mirror: "provided"`).
 */
export const PROVIDED_MIRROR_DIR = '/jm/mirror';
let providedMirror = PROVIDED_MIRROR_DIR;
/** The provided mirror's path: `PROVIDED_MIRROR_DIR` outside tests. */
export function providedMirrorDir(): string {
  return providedMirror;
}
/** Test-only: points the provided mirror at another path (null restores the default). */
export function setProvidedMirrorDir(dir: string | null): void {
  providedMirror = dir ?? PROVIDED_MIRROR_DIR;
}

/** `exec`'s rejection once a child's stdout passes the cap. */
class OutputTooLarge extends Error {
  constructor() {
    super('output too large');
  }
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
    // Its own process group: an abort kills git and everything it started (a transport helper
    // that inherited the token in its env, a remote hook), not only the direct child.
    const child = spawnImpl(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let aborted: Error | null = null;
    const abort = (msg: string, err: Error = new Error(msg)) => {
      if (aborted) return;
      aborted = err;
      killGroup(child);
      // Settle now: a grandchild (a remote hook, a transport helper) can hold the pipes open, and
      // 'close' would wait for it.
      done();
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(err);
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
      if (aborted) return;
      // Bytes, not characters. Past the cap the call fails: a cut-off listing would read as a
      // complete one to every caller.
      stdoutBytes += c.length;
      if (stdoutBytes > outputMaxBytes) return abort('output too large', new OutputTooLarge());
      chunks.push(c);
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
      if (aborted) return reject(aborted);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (code === 0) return resolve(stdout.trim());
      // Never echo the command line: it may carry the upload-pack wrapper or paths.
      const detail = stderr.trim();
      // stdout rides on the error for callers that classify by it (push --porcelain), never in
      // the message.
      reject(
        Object.assign(new Error(`${o.label} failed (exit ${code})${detail ? `: ${detail}` : ''}`), {
          stdout,
        }),
      );
    });
  });
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid === undefined) throw new Error('no pid');
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // No group (spawn failed, or already gone): kill the child itself.
    child.kill('SIGKILL');
  }
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
  /** With a token: the remote whose scope and header the token is sent with. Required then. */
  remote?: RemoteTarget;
  /** A GitLab remote's basic-auth username (a deploy token's own). Absent: `oauth2`. */
  username?: string;
  /** Sets `http.followRedirects=false`: a redirect, even to the same host, fails the call. */
  refuseRedirects?: boolean;
  /** Root call: a root-owned bare repo; sets GIT_DIR / GIT_COMMON_DIR / GIT_CEILING_DIRECTORIES. */
  gitDir?: string;
  extraConfig?: [string, string][];
  timeoutMs?: number;
  watch?: () => string | null;
};

/**
 * Root-owned mirrors this trooper created and checked (`assertRootOwnedDir`). Agent-identity git
 * runs `upload-pack` inside them (clone and fetch from `file://<mirror>`), which git refuses for a
 * repo owned by another uid unless `safe.directory` names it in protected config. A local
 * transport strips GIT_CONFIG_COUNT/PARAMETERS from upload-pack's env but keeps GIT_CONFIG_GLOBAL,
 * so the trust goes in a root-written global config file. Exactly these paths are trusted, never
 * `*`, and root calls trust nothing.
 */
const trustedMirrors = new Set<string>();
/** Root-written global config for agent-identity git: only `safe.directory` for those mirrors. */
let agentGlobalConfig: string | null = null;

/** The root-written global git config agent-identity git reads, once a mirror is trusted. */
export function agentGitConfigFile(): string | null {
  return agentGlobalConfig;
}

/**
 * Trusts `mirrorDir` for agent-identity git (see `trustedMirrors`). `alsoTrust` adds a working
 * tree root created for the agent (the chat's `work`, group-writable by the agent's gid but owned
 * by root, since root here cannot chown). Returns the global config file the agent's git reads.
 */
export function trustMirror(
  mirrorDir: string,
  alsoTrust: string[] = [],
  /** Where the config file goes: the mirror's parent, unless that can't be written. */
  configDir: string = dirname(mirrorDir),
): string {
  assertRootOwnedDir(mirrorDir);
  trustedMirrors.add(mirrorDir);
  for (const d of alsoTrust) trustedMirrors.add(d);
  const file = join(configDir, 'agent.gitconfig');
  const lines = [...trustedMirrors].map((m) => `\tdirectory = ${m}`).join('\n');
  // In the root-owned workdir (0755): the agent can read it but not change it.
  writeFileSync(file, `[safe]\n${lines}\n`, { mode: 0o644 });
  agentGlobalConfig = file;
  return file;
}

/**
 * Runs git. Auth rides in the child's env (never argv or config) as GIT_CONFIG_KEY_0, scoped to
 * `opts.remote`'s origin (github.com, or a GitLab target's origin), which a token requires.
 * Inherited GIT_* variables and global/system config are ignored. A token is only ever used by a
 * root call in a root-owned `gitDir`; working-copy calls carry no token.
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
  const remote = opts.remote;
  if (token && !remote) return Promise.reject(new Error('runGit: a token without a remote'));
  const config: [string, string][] = [
    ...(token && remote
      ? ([
          [`http.${authScope(remote)}.extraheader`, targetAuthHeader(remote, token, opts.username)],
        ] as [string, string][])
      : []),
    ...(opts.refuseRedirects ? ([['http.followRedirects', 'false']] as [string, string][]) : []),
    ...(opts.extraConfig ?? []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: opts.as && agentGlobalConfig ? agentGlobalConfig : '/dev/null',
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
  // As the agent, start from / and enter `dir` after the uid drop: root can't chdir into 0700.
  return exec(opts.as ? asAgentInDirArgv(opts.as, dir, ['git', ...args]) : ['git', ...args], {
    cwd: opts.as ? '/' : dir,
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

/** The fixed config of every root-owned bare repo: nothing an earlier process wrote survives. */
export const BARE_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n';

/** Creates (or resets) a root-owned bare repo: fixed config, no hooks. */
export async function initBare(gitDir: string): Promise<void> {
  ensureRootDir(gitDir);
  await runGit(undefined, ['init', '--bare', '-q', '--template='], '', { gitDir });
  // Fixed config: nothing an earlier process wrote survives.
  writeFileSync(join(gitDir, 'config'), BARE_CONFIG);
  rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
}

/**
 * Root, in the mirror only: refresh `refs/heads/<ref>` (`*` for all heads) from the remote, and
 * each of `extraRefs` (`pull/7/head`) as `refs/<ref>`. `depth` makes the fetch shallow.
 * `username` is a GitLab target's basic-auth username (absent: `oauth2`); `refuseRedirects` sets
 * `http.followRedirects=false`. With either, a failure's message is redacted of the token's forms.
 */
export async function mirrorFetch(
  mirrorDir: string,
  token: string,
  target: RemoteTarget,
  refs: string[],
  o: {
    extraRefs?: string[];
    depth?: number;
    timeoutMs?: number;
    username?: string;
    refuseRedirects?: boolean;
    /** Extra env-carried config (a grant's `sslCAInfo`, `writeGrantCa`). */
    extraConfig?: [string, string][];
  } = {},
): Promise<void> {
  const url = remoteUrl(target);
  const fetched = runGit(
    undefined,
    [
      ...PRISTINE,
      ...protocolFor(url),
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      '--prune',
      ...(o.depth !== undefined ? [`--depth=${o.depth}`] : []),
      '--end-of-options',
      url,
      ...refs.map((r) => `+refs/heads/${r}:refs/heads/${r}`),
      ...(o.extraRefs ?? []).map((r) => `+refs/${r}:refs/${r}`),
    ],
    token,
    {
      gitDir: mirrorDir,
      remote: target,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.username !== undefined ? { username: o.username } : {}),
      ...(o.refuseRedirects ? { refuseRedirects: true } : {}),
      ...(o.extraConfig?.length ? { extraConfig: o.extraConfig } : {}),
    },
  );
  try {
    await fetched;
  } catch (e) {
    // Only the clone fetch (the new options) redacts here: every other caller redacts itself.
    const clone = o.username !== undefined || o.refuseRedirects === true;
    if (!clone || !token || !(e instanceof Error)) throw e;
    throw Object.assign(e, {
      message: redact(e.message, targetTokenSecrets(target, token, o.username)),
    });
  }
}

/**
 * Root clones the remote into a root-owned bare mirror (with the token); the agent then clones the
 * working copy from the mirror (no token) and sets the Jumpmaster Agent identity.
 */
export async function cloneRepo(o: {
  owner: string;
  name: string;
  forge?: ForgeRemote;
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
  if (as) trustMirror(mirrorDir);
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

/**
 * The mirror check: `mirrorDir` (a provided mirror) is a bare repository on a path that passes
 * `assertRootOwnedDir`, with exactly `BARE_CONFIG` as its config and no `hooks`. Throws naming
 * what is wrong. Reads only: nothing is written into the mirror.
 */
export async function checkMirror(
  mirrorDir: string,
  getuid: () => number = () => process.getuid?.() ?? -1,
): Promise<void> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(mirrorDir);
  } catch {
    throw new Error(`no mirror at ${mirrorDir}`);
  }
  if (st.isSymbolicLink()) throw new Error(`the mirror ${mirrorDir} is a symlink`);
  if (!st.isDirectory()) throw new Error(`the mirror ${mirrorDir} is not a directory`);
  try {
    assertRootOwnedDir(mirrorDir, getuid);
  } catch (e) {
    throw new Error(`the mirror is not root-owned and closed: ${(e as Error).message}`);
  }
  const isFile = (p: string) => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  };
  const isSymlink = (p: string) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const isDir = (p: string) => {
    try {
      return lstatSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const bare =
    isFile(join(mirrorDir, 'HEAD')) &&
    isDir(join(mirrorDir, 'objects')) &&
    isDir(join(mirrorDir, 'refs'));
  if (!bare) throw new Error(`the mirror ${mirrorDir} is not a bare repository`);
  const config = join(mirrorDir, 'config');
  if (!isFile(config) || readFileSync(config, 'utf8') !== BARE_CONFIG) {
    throw new Error('the mirror config is not the fixed bare config');
  }
  if (existsSync(join(mirrorDir, 'hooks')) || isSymlink(join(mirrorDir, 'hooks'))) {
    throw new Error('the mirror has a hooks directory');
  }
}

/**
 * A provided mirror (checked with `checkMirror` first): the agent clones the working copy from it
 * at `branch` (the default branch) and sets the Jumpmaster Agent identity. No remote, no token.
 * The agent's git config (the mirror's safe-directory trust) goes in `configDir`, never in the
 * read-only mirror's parent.
 */
export async function cloneFromMirror(o: {
  mirrorDir: string;
  dir: string;
  branch: string;
  configDir: string;
  as?: AgentIdentity | null;
}): Promise<void> {
  const as = o.as ?? null;
  trustMirror(o.mirrorDir, [], o.configDir);
  await runGit(
    dirname(o.dir),
    [
      'clone',
      '-q',
      '--no-hardlinks',
      '--branch',
      o.branch,
      '--end-of-options',
      `file://${o.mirrorDir}`,
      o.dir,
    ],
    '',
    { as, extraConfig: [['protocol.file.allow', 'always']] },
  );
  await runGit(o.dir, ['config', 'user.name', AGENT_NAME], '', { as });
  await runGit(o.dir, ['config', 'user.email', AGENT_EMAIL], '', { as });
}

/** The tip of `refs/heads/<branch>` in a provided mirror, or null. Root, read-only, no remote. */
export async function mirrorBranchSha(mirrorDir: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await runGit(
    undefined,
    [...PRISTINE, 'for-each-ref', '--format=%(objectname) %(refname)', '--', ref],
    '',
    { gitDir: mirrorDir },
  );
  const line = out.split('\n').find((l) => l.endsWith(` ${ref}`));
  return line ? (line.split(' ')[0] as string) : null;
}

export async function prepareBranch(
  dir: string,
  branch: string,
  base: string,
  as: AgentIdentity | null = null,
): Promise<void> {
  await runGit(dir, ['switch', '-q', '-c', branch, `origin/${base}`], '', { as });
}

/** How long a hardened (salvage) status, add or commit may take. */
export const HARDENED_COMMIT_TIMEOUT_MS = 60_000;

/**
 * Commits everything in `dir` when it is dirty. `hardened` (salvage, in the push container, on a
 * working copy the agent left behind): no fsmonitor, no hooks, the Jumpmaster Agent identity
 * whatever the repo config says, a bound on every call, and git is pointed at `dir` with `-C`
 * from `/` (root never enters the agent's directory).
 */
export async function commitIfDirty(
  dir: string,
  message: string,
  as: AgentIdentity | null = null,
  o: { hardened?: boolean } = {},
): Promise<boolean> {
  if (o.hardened) {
    const run = (args: string[]) =>
      runGit(
        '/',
        ['-C', dir, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
        '',
        { as, timeoutMs: HARDENED_COMMIT_TIMEOUT_MS },
      );
    if ((await run(['status', '--porcelain'])) === '') return false;
    await run(['add', '-A']);
    await run([
      '-c',
      `user.name=${AGENT_NAME}`,
      '-c',
      `user.email=${AGENT_EMAIL}`,
      // No signing: an agent-configured gpg.program never runs.
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-q',
      '--no-verify',
      '-m',
      message,
    ]);
    return true;
  }
  if ((await runGit(dir, ['status', '--porcelain'], '', { as })) === '') return false;
  await runGit(dir, ['add', '-A'], '', { as });
  // The trooper's own housekeeping commit: project hooks (husky, lint-staged) must not fail it.
  await runGit(dir, [...PRISTINE, 'commit', '-q', '-m', message], '', { as });
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
  timeoutMs?: number,
  /** Extra env-carried config (a grant's `sslCAInfo`, `writeGrantCa`). */
  extraConfig: [string, string][] = [],
): Promise<string | null> {
  const scratch = mkdtempSync(join(workRoot, 'jm-lsremote-'));
  try {
    await initBare(scratch);
    const url = remoteUrl(target);
    const out = await runGit(
      undefined,
      [
        ...PRISTINE,
        ...protocolFor(url),
        'ls-remote',
        '--heads',
        '--end-of-options',
        url,
        `refs/heads/${branch}`,
      ],
      token,
      {
        gitDir: scratch,
        remote: target,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(extraConfig.length ? { extraConfig } : {}),
      },
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
/** Paths the branch changes against base, listing both sides of a rename. */
export async function changedPaths(
  dir: string,
  base: string,
  as: AgentIdentity | null = null,
): Promise<string[]> {
  await runGit(
    dir,
    ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`],
    '',
    { as, extraConfig: [['protocol.file.allow', 'always']] },
  );
  const out = await runGit(
    dir,
    ['diff', '--name-only', '--no-renames', '-z', `origin/${base}...HEAD`],
    '',
    {
      as,
    },
  );
  return out.split('\0').filter(Boolean);
}

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

/** The server's review check uses the same matcher, so a path one refuses the other refuses too. */
const globHit = (p: string, globs: string[]): boolean =>
  globs.some((g) => protectedPathMatches(p, g));

/** Undoes git's C-style quoting of a path (`"b/\\303\\251.ts"`); a plain path is returned as is. */
export function unquoteGitPath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const ESC: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  const bytes: number[] = [];
  const s = p.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[++i] ?? '';
    const oct = /^[0-7]{3}/.exec(s.slice(i, i + 3));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 2;
    } else bytes.push(ESC[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The added lines of a `git diff -U0` patch, per destination file, as runs of consecutive added
 * lines joined with `\n` (the leading `+` dropped). A deleted file has no destination and adds
 * nothing.
 */
export function addedRuns(patch: string): { path: string; runs: string[] }[] {
  const out: { path: string; runs: string[] }[] = [];
  let file: { path: string; runs: string[] } | null = null;
  let inHunk = false;
  let run: string[] | null = null;
  const close = () => {
    if (file && run) file.runs.push(run.join('\n'));
    run = null;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      close();
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      // Git ends a name holding a space with a tab, for patch(1).
      const p = line.slice(4).replace(/\t$/, '');
      file = p === '/dev/null' ? null : { path: unquoteGitPath(p).replace(/^b\//, ''), runs: [] };
      if (file) out.push(file);
    } else if (line.startsWith('@@')) {
      close();
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      run ??= [];
      run.push(line.slice(1));
    } else if (inHunk && line.startsWith('\\')) {
      // "\ No newline at end of file": part of the line before it, not a break in the run.
    } else {
      close();
    }
  }
  close();
  return out;
}

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
  privateKeyPaths: string[] = [],
): Promise<string | null> {
  try {
    return await checkStaged(bareDir, branch, protectedPaths, since, secrets, privateKeyPaths);
  } catch (e) {
    // A listing cut at the cap could hide the very entry the check exists for: refuse.
    if (e instanceof OutputTooLarge) return 'diff too large to check';
    throw e;
  }
}

async function checkStaged(
  bareDir: string,
  branch: string,
  protectedPaths: string[],
  since: string,
  secrets: string[],
  privateKeyPaths: string[],
): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  // -z: paths are raw bytes, never C-quoted, so a non-ASCII name cannot dodge the glob.
  const diff = await runGit(
    undefined,
    [
      '--no-replace-objects',
      'diff',
      '--name-status',
      '-z',
      '-M',
      '--end-of-options',
      `refs/jm/base...${ref}`,
    ],
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
      // A file moved out of an allow-listed path shows its whole content as added.
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '-U0',
      '--end-of-options',
      `refs/jm/base...${ref}`,
    ],
    '',
    { gitDir: bareDir },
  );
  const files = addedRuns(patch);
  // A real private key, its lines joined per run of added lines, outside the zone's allow-list.
  // The refusal names the path only, never any of the key.
  for (const { path, runs } of files) {
    if (globHit(path, privateKeyPaths)) continue;
    if (runs.some((run) => findPrivateKeys(run).some((k) => k.real))) {
      return `private key in ${path}`;
    }
  }
  const added = files.flatMap((f) => f.runs).join('\n');
  const messages = await runGit(
    undefined,
    [
      '--no-replace-objects',
      'log',
      '--format=%B',
      '--end-of-options',
      `${since}..${ref}`,
      '^refs/jm/base',
    ],
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
      '--end-of-options',
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

/**
 * The upload-pack the root fetch runs in the agent's working copy, as the agent uid: no
 * fsmonitor, no hooks, and no lazy fetch from a promisor remote the agent configured.
 */
export const HARDENED_UPLOAD_PACK =
  'env GIT_NO_LAZY_FETCH=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack';

export type StageOptions = {
  as?: AgentIdentity | null;
  /** Kills every agent-uid process; runs before and after the agent's upload-pack. */
  sweep: () => void;
  limits?: { timeoutMs: number; maxBytes: number };
};

/**
 * Push container, before any grant: root copies `refs/heads/<branch>` out of the agent's working
 * copy into a fresh root-owned bare repo. The only process that touches the working copy is the
 * hardened upload-pack, run as the agent; root git runs only in the bare repo. Takes no token.
 * The caller owns the returned `pushDir` (`pushStaged` removes it).
 */
export async function stageFromAgent(
  dir: string,
  branch: string,
  o: StageOptions,
): Promise<{ pushDir: string; head: string } | { nothing: string }> {
  const ref = `refs/heads/${branch}`;
  const limits = o.limits ?? { timeoutMs: PUSH_FETCH_TIMEOUT_MS, maxBytes: PUSH_FETCH_MAX_BYTES };
  const pushDir = mkdtempSync(join(workRoot, 'push-'));
  let keep = false;
  try {
    await initBare(pushDir);
    // git appends the quoted repo path; the hardened command's words need no quoting.
    const uploadPack = [
      ...asAgentArgv(o.as ?? null, []).map(shellQuote),
      HARDENED_UPLOAD_PACK,
    ].join(' ');
    const tooLarge = () => (dirSize(pushDir) > limits.maxBytes ? 'push fetch too large' : null);
    o.sweep();
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
          '--end-of-options',
          `file://${dir}`,
          `+${ref}:${ref}`,
        ],
        '',
        { gitDir: pushDir, timeoutMs: limits.timeoutMs, watch: tooLarge },
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'timeout') throw new Error('push fetch timed out');
      if (msg === 'push fetch too large' || tooLarge()) throw new Error('push fetch too large');
      if (/couldn't find remote ref/.test(msg))
        return { nothing: 'branch not in the working copy' };
      throw e;
    } finally {
      // On every outcome: an aborted fetch can leave the agent-uid upload-pack running.
      o.sweep();
    }
    if (tooLarge()) throw new Error('push fetch too large');
    // Nothing the agent fetch could have touched survives.
    writeFileSync(join(pushDir, 'config'), BARE_CONFIG);
    rmSync(join(pushDir, 'hooks'), { recursive: true, force: true });
    const head = await runGit(
      undefined,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      '',
      {
        gitDir: pushDir,
      },
    );
    keep = true;
    return { pushDir, head };
  } finally {
    if (!keep) rmSync(pushDir, { recursive: true, force: true });
  }
}

/**
 * A refusal is only what git's porcelain output (stdout) reports per ref: `!<TAB><ref><TAB>
 * [rejected]` or `[remote rejected]`, with exit 1. stderr is not trusted for this (a remote hook
 * writes there), and a transport failure or timeout has no such line, so it stays retryable.
 */
const pushRejected = (e: unknown): boolean => {
  const out = (e as { stdout?: unknown }).stdout;
  return (
    (e as Error).message.includes('(exit 1)') &&
    typeof out === 'string' &&
    /^!\t[^\t]*\t\[(?:remote )?rejected\]/m.test(out)
  );
};

/** A failure carrying its retry classification; its message is redacted before it leaves. */
class PushFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const failure = (e: unknown, retryable: boolean): PushFailure =>
  e instanceof PushFailure ? e : new PushFailure((e as Error).message, retryable);

/**
 * Push container, after the grant: fetches the trusted base from the forge, runs the pre-push
 * check against it, and pushes the staged branch with a lease. Always removes `pushDir`. The
 * token rides only in the env of root git calls in `pushDir`, and every reason is redacted.
 */
export async function pushStaged(
  pushDir: string,
  grant: PushGrant,
  o: { remoteUrl?: string; timeoutMs?: number } = {},
): Promise<PushResult> {
  const { token, branch, lease } = grant;
  // Every network call is bounded: a stalled connection fails (retryable), never hangs.
  const timeoutMs = o.timeoutMs ?? PUSH_FETCH_TIMEOUT_MS;
  const ref = `refs/heads/${branch}`;
  const target: RemoteTarget = {
    owner: grant.owner,
    name: grant.name,
    ...(grant.forge ? { forge: grant.forge } : {}),
    ...(o.remoteUrl !== undefined ? { url: o.remoteUrl } : {}),
  };
  const url = remoteUrl(target);
  const secrets = [...grant.secrets, ...targetTokenSecrets(target, token)];
  let ca: GrantCa | null = null;
  try {
    if (grant.caCert !== undefined) {
      // The trust is scoped to a GitLab origin: a grant without one has none to give it.
      if (!grant.forge) throw new PushFailure(`${GITLAB_CA_BUNDLE} needs a GitLab forge`, false);
      try {
        ca = writeGrantCa(grant.forge, grant.caCert);
      } catch (e) {
        throw failure(e, false);
      }
    }
    const caConfig = ca ? { extraConfig: ca.config } : {};
    try {
      await runGit(
        undefined,
        [
          ...PRISTINE,
          ...protocolFor(url),
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          '--end-of-options',
          url,
          `+refs/heads/${grant.base}:refs/jm/base`,
        ],
        token,
        { gitDir: pushDir, remote: target, timeoutMs, ...caConfig },
      );
    } catch (e) {
      throw failure(e, true);
    }
    const refusal = await prePushCheck(
      pushDir,
      branch,
      grant.protectedPaths,
      lease || 'refs/jm/base',
      grant.secrets,
      grant.privateKeyPaths ?? [],
    );
    if (refusal) throw new PushFailure(refusal, false);
    const head = await runGit(
      undefined,
      ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      '',
      {
        gitDir: pushDir,
      },
    );
    if (grant.expectSha !== undefined && head !== grant.expectSha) {
      throw new PushFailure(
        `pushed branch is not the gated commit: ${head} != ${grant.expectSha}`,
        false,
      );
    }
    // A checkpoint or salvage (no gated commit) still at its lease has nothing to push.
    if (grant.expectSha === undefined && lease !== '' && lease === head) {
      return { status: 'nothing', reason: 'nothing ahead' };
    }
    let out: string;
    try {
      // --porcelain: an up-to-date ref is reported as `=` (git skips the lease check for it).
      out = await runGit(
        undefined,
        [
          ...PRISTINE,
          ...protocolFor(url),
          'push',
          '--porcelain',
          `--force-with-lease=${ref}:${lease}`,
          '--end-of-options',
          url,
          `${ref}:${ref}`,
        ],
        token,
        { gitDir: pushDir, remote: target, timeoutMs, ...caConfig },
      );
    } catch (e) {
      // The remote decides: our own earlier push that died before reporting, a remote that moved
      // past the lease (stale), or a push that never landed (retry).
      const want = grant.expectSha ?? head;
      const tip = await remoteBranchSha(target, branch, token, timeoutMs, ca?.config).catch(
        (le: unknown) => {
          throw failure(le, true);
        },
      );
      if (tip === want) return { status: 'pushed', headSha: want, alreadyThere: true };
      if (tip !== (lease === '' ? null : lease)) {
        throw new PushFailure(
          `stale info: remote ${branch} is at ${tip ?? 'nothing'}, lease ${lease || 'none'}`,
          false,
        );
      }
      // The remote is untouched: a decline (protection rule, hook, push protection) is final; a
      // transport failure or timeout may succeed next time.
      if (pushRejected(e)) throw new PushFailure(`push rejected: ${(e as Error).message}`, false);
      throw failure(e, true);
    }
    const upToDate = out.split('\n').some((l) => l.startsWith('=\t') && l.includes(ref));
    return { status: 'pushed', headSha: head, alreadyThere: upToDate };
  } catch (e) {
    const f = failure(e, false);
    return {
      status: 'failed',
      reason: redact(f.message, secrets).slice(0, 2000),
      retryable: f.retryable,
    };
  } finally {
    ca?.remove();
    rmSync(pushDir, { recursive: true, force: true });
  }
}

/**
 * Removes the repository's agent instructions (`.claude/`, `CLAUDE*.md`, `.mcp.json`) from `dir` at
 * any depth, as `as` (the clone's owner: root has no DAC_OVERRIDE over it). `.git` is left alone and
 * links are removed as links, never followed (`find` without `-L`). Returns the removed paths,
 * relative to `dir`.
 */
export async function removeInstructionFiles(
  dir: string,
  as: AgentIdentity | null = null,
): Promise<string[]> {
  // Without an identity (outside the container) a missing clone has nothing to strip. With one,
  // never skip: root can't see into the agent's private home, so an existence check would lie.
  if (!as && !existsSync(dir)) return [];
  const find = [
    'find',
    '.',
    '-path',
    './.git',
    '-prune',
    '-o',
    '(',
    '-name',
    '.claude',
    '-o',
    '-name',
    'CLAUDE*.md',
    '-o',
    '-name',
    '.mcp.json',
    ')',
    '-prune',
    '-print',
    '-exec',
    'rm',
    '-rf',
    '--',
    '{}',
    '+',
  ];
  // As the agent, enter `dir` after the uid drop: root can't chdir into its 0700 working copy.
  const out = await exec(as ? asAgentInDirArgv(as, dir, find) : find, {
    cwd: as ? '/' : dir,
    env: scrubEnv(process.env),
    label: 'strip',
  });
  return out
    .split('\n')
    .filter((l) => l.startsWith('./'))
    .map((l) => l.slice(2));
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
  // cwd '/': root cannot chdir into the gate's 0700 home before the uid drop; paths are absolute.
  await runGit('/', ['clone', '-q', bundle, gateDir], '', { as: ids.gate });
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
