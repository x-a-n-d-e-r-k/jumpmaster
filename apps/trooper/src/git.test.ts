import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  addedRuns,
  aheadOfBase,
  authHeader,
  cloneRepo,
  commitIfDirty,
  conflictMarkers,
  GIT_OUTPUT_MAX_BYTES,
  headSha,
  initBare,
  mergeInProgress,
  mirrorFetch,
  prePushCheck,
  prepareBranch,
  remoteBranchExists,
  remoteBranchSha,
  removeInstructionFiles,
  runGit,
  setGitOutputMaxBytes,
  setSpawn,
  sweepProcesses,
  treeState,
} from './git.js';
import { fixtureKey, scratchPush } from './test/privateKey.js';

let tmp: string;
let origin: string;
const url = (): string => `file://${origin}`;
const target = () => ({ owner: 'o', name: 'r', url: url() });
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function clone(name: string): Promise<string> {
  const home = join(tmp, name);
  mkdirSync(home);
  const dir = join(home, 'repo');
  await cloneRepo({ owner: 'o', name: 'r', token: 'tok', dir, url: url() });
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'git-'));
  origin = join(tmp, 'origin.git');
  const seed = join(tmp, 'seed');
  git(tmp, 'init', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', '-q', origin, 'main');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  setSpawn(null);
  setGitOutputMaxBytes(null);
});

test('token is not persisted in .git/config', async () => {
  const dir = await clone('cfg');
  const cfg = readFileSync(join(dir, '.git/config'), 'utf8');
  expect(cfg).not.toContain('tok');
  expect(cfg).not.toContain('extraheader');
});

test('clone sets the agent identity', async () => {
  const dir = await clone('ident');
  expect(git(dir, 'config', 'user.name')).toBe('Jumpmaster Agent');
  expect(git(dir, 'config', 'user.email')).toBe('jumpmaster-agent@users.noreply.github.com');
});

test('treeState changes with an edit, an untracked file or a new commit', async () => {
  const dir = await clone('tree');
  await prepareBranch(dir, 'agent/issue-8', 'main');
  const s0 = await treeState(dir);
  expect(await treeState(dir)).toBe(s0);
  writeFileSync(join(dir, 'new.txt'), 'n\n');
  const s1 = await treeState(dir);
  expect(s1).not.toBe(s0);
  await commitIfDirty(dir, 'chore: add new');
  const s2 = await treeState(dir);
  expect(s2).not.toBe(s0);
  expect(s2).not.toBe(s1);
});

test('conflictMarkers lists tracked files with leftover markers; mergeInProgress sees MERGE_HEAD', async () => {
  const dir = await clone('markers');
  await prepareBranch(dir, 'agent/issue-9', 'main');
  expect(await conflictMarkers(dir)).toEqual([]);
  expect(await mergeInProgress(dir)).toBe(false);
  writeFileSync(join(dir, 'a.txt'), 'ok\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> origin/main\n');
  writeFileSync(join(dir, 'untracked.txt'), '<<<<<<< HEAD\n');
  expect(await conflictMarkers(dir)).toEqual(['a.txt']);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'a.txt'), 'side\n');
  git(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'side');
  git(dir, 'checkout', '-q', 'agent/issue-9');
  writeFileSync(join(dir, 'a.txt'), 'mine\n');
  git(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'mine');
  try {
    git(dir, '-c', 'user.name=x', '-c', 'user.email=x@x', 'merge', '-q', 'side');
  } catch {
    // conflict expected
  }
  expect(await mergeInProgress(dir)).toBe(true);
});

test("commitIfDirty ignores the project's own git hooks", async () => {
  const dir = await clone('hooks');
  await prepareBranch(dir, 'agent/issue-8', 'main');
  const hooks = join(dir, '.husky-like');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(dir, 'config', 'core.hooksPath', hooks);
  writeFileSync(join(dir, 'c.txt'), 'c\n');
  expect(await commitIfDirty(dir, 'chore: checkpoint')).toBe(true);
  expect(await aheadOfBase(dir, 'main')).toBe(1);
});

test("commitIfDirty hardened doesn't run a planted fsmonitor", async () => {
  const dir = await clone('fsmon');
  await prepareBranch(dir, 'agent/issue-8', 'main');
  const marker = join(tmp, 'fsmon-marker');
  const script = join(tmp, 'fsmon.sh');
  writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`);
  chmodSync(script, 0o755);
  git(dir, 'config', 'core.fsmonitor', script);
  const hooks = join(dir, '.planted-hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho hook >> ${marker}\nexit 1\n`);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(dir, 'config', 'core.hooksPath', hooks);
  // The agent can rewrite its identity; the salvage commit is still the Jumpmaster Agent's.
  git(dir, 'config', 'user.name', 'Somebody Else');
  // An agent-configured signing program never runs either.
  const gpg = join(tmp, 'gpg.sh');
  writeFileSync(gpg, `#!/bin/sh\necho gpg >> ${marker}\nexit 1\n`);
  chmodSync(gpg, 0o755);
  git(dir, 'config', 'commit.gpgSign', 'true');
  git(dir, 'config', 'gpg.program', gpg);
  writeFileSync(join(dir, 'salvage.txt'), 's\n');
  expect(await commitIfDirty(dir, 'wip: salvage', null, { hardened: true })).toBe(true);
  expect(existsSync(marker)).toBe(false);
  expect(git(dir, 'log', '-1', '--format=%an <%ae>')).toBe(
    'Jumpmaster Agent <jumpmaster-agent@users.noreply.github.com>',
  );
  expect(await commitIfDirty(dir, 'wip: salvage', null, { hardened: true })).toBe(false);
});

test('branch, commit, ahead count, head sha', async () => {
  const dir = await clone('flow');
  await prepareBranch(dir, 'agent/issue-7', 'main');
  expect(await aheadOfBase(dir, 'main')).toBe(0);
  expect(await commitIfDirty(dir, 'chore: nothing')).toBe(false);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  expect(await commitIfDirty(dir, 'feat: add b')).toBe(true);
  expect(await aheadOfBase(dir, 'main')).toBe(1);
  expect(await headSha(dir)).toBe(git(dir, 'rev-parse', 'HEAD'));
});

test('a silent git failure leaks neither the token nor its base64 form', async () => {
  const dir = await clone('silent');
  const token = 'ghp_' + 'SILENTTOKEN1234567890abcdef';
  const mirror = join(dir, '..', 'mirror');
  const err = await runGit(
    undefined,
    ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'],
    token,
    {
      gitDir: realpathSync(mirror),
      remote: { owner: 'o', name: 'r' },
    },
  ).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).toContain('git rev-parse failed (exit 1)');
  expect(msg).not.toContain(token);
  expect(msg).not.toContain(Buffer.from(`x-access-token:${token}`).toString('base64'));
});

test('git children never see agent or claude credentials', async () => {
  const dir = await clone('envleak');
  await prepareBranch(dir, 'agent/issue-9', 'main');
  const dump = join(tmp, 'env-dump');
  for (const hook of ['pre-commit']) {
    const f = join(dir, '.git/hooks', hook);
    writeFileSync(f, `#!/bin/sh\nenv >> '${dump}'\n`);
    chmodSync(f, 0o755);
  }
  const saved = { ...process.env };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret-value';
  process.env.GH_TOKEN = 'gh-secret-value';
  process.env.JM_X = 'jm-secret-value';
  try {
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    // A plain runGit commit still runs project hooks (commitIfDirty deliberately doesn't).
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-q', '-m', 'feat: c']);
  } finally {
    process.env = saved;
  }
  const seen = readFileSync(dump, 'utf8');
  expect(seen).not.toMatch(/claude-secret-value|gh-secret-value|jm-secret-value/);
  expect(seen).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
});

const hasBranch = (repo: string, b: string): boolean =>
  git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${b}`) !== '';

test('the auth header is scoped to https://github.com/ only', async () => {
  const dir = await clone('scoped');
  const token = 'ghp_' + 'SCOPEDTOKEN1234567890abcd';
  const gitDir = realpathSync(join(dir, '..', 'mirror'));
  expect(
    await runGit(undefined, ['config', '--get', 'http.https://github.com/.extraheader'], token, {
      gitDir,
      remote: { owner: 'o', name: 'r' },
    }),
  ).toBe(authHeader(token));
  await expect(
    runGit(undefined, ['config', '--get', 'http.extraheader'], token, {
      gitDir,
      remote: { owner: 'o', name: 'r' },
    }),
  ).rejects.toThrow();
});

test('runGit refuses a token without the remote it is for', async () => {
  const dir = await clone('noremote');
  const gitDir = realpathSync(join(dir, '..', 'mirror'));
  await expect(runGit(undefined, ['rev-parse', '--git-dir'], 'tok', { gitDir })).rejects.toThrow(
    /without a remote/,
  );
});

describe('the remote target decides the URL, auth scope and header (#716)', () => {
  const TOKEN = 'plain-token-0123456789';
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const GITLAB = {
    kind: 'gitlab' as const,
    origin: 'https://git.example.internal:8443',
    projectPath: 'group/sub/project',
  };
  type Call = { argv: string[]; env: NodeJS.ProcessEnv };
  /** Records every spawn, and runs `true` in its place: no network is touched. */
  const record = (): Call[] => {
    const calls: Call[] = [];
    setSpawn((cmd, args, opts) => {
      calls.push({ argv: [cmd, ...args], env: (opts.env ?? {}) as NodeJS.ProcessEnv });
      return spawn('true', [], { ...opts, cwd: '/' });
    });
    return calls;
  };
  const mirror = async (name: string) => {
    const d = join(tmp, name);
    await initBare(d);
    return d;
  };
  const authEnv = (env: NodeJS.ProcessEnv) =>
    Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('GIT_CONFIG_')));
  const noTokenInArgv = (calls: Call[]) => {
    for (const c of calls) {
      for (const a of c.argv) {
        expect(a).not.toContain(TOKEN);
        expect(a).not.toContain(b64(`oauth2:${TOKEN}`));
        expect(a).not.toContain(b64(`x-access-token:${TOKEN}`));
      }
    }
  };

  test('a GitLab target fetches <origin>/<group>/<sub>/<project>.git with the oauth2 header on <origin>/', async () => {
    const dir = await mirror('gl-fetch');
    const calls = record();
    await mirrorFetch(dir, TOKEN, { owner: 'o', name: 'r', forge: GITLAB }, ['main']);
    expect(calls).toHaveLength(1);
    const c = calls[0] as Call;
    expect(c.env.GIT_CONFIG_COUNT).toBe('1');
    expect(c.env.GIT_CONFIG_KEY_0).toBe('http.https://git.example.internal:8443/.extraheader');
    expect(c.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${b64(`oauth2:${TOKEN}`)}`);
    expect(c.argv).toContain('https://git.example.internal:8443/group/sub/project.git');
    expect(c.argv.join(' ')).not.toContain('github.com');
    expect(JSON.stringify(authEnv(c.env))).not.toContain('github.com');
    noTokenInArgv(calls);
  });

  test('a GitLab target ls-remotes <origin>/<projectPath>.git with the GitLab scope', async () => {
    const calls = record();
    await remoteBranchSha({ owner: 'o', name: 'r', forge: GITLAB }, 'main', TOKEN);
    const ls = calls.find((c) => c.argv.includes('ls-remote')) as Call;
    expect(ls.env.GIT_CONFIG_KEY_0).toBe('http.https://git.example.internal:8443/.extraheader');
    expect(ls.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${b64(`oauth2:${TOKEN}`)}`);
    expect(ls.argv).toContain('https://git.example.internal:8443/group/sub/project.git');
    noTokenInArgv(calls);
  });

  test('cloneRepo with a GitLab forge clones <origin>/<projectPath>.git with the GitLab scope', async () => {
    const home = join(tmp, 'gl-clone');
    mkdirSync(home);
    const calls = record();
    await cloneRepo({
      owner: 'o',
      name: 'r',
      forge: { ...GITLAB, origin: 'https://gitlab.com' },
      token: TOKEN,
      dir: join(home, 'repo'),
    });
    const fetch = calls.find((c) => c.argv.includes('fetch')) as Call;
    expect(fetch.argv).toContain('https://gitlab.com/group/sub/project.git');
    expect(fetch.env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/.extraheader');
    expect(fetch.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${b64(`oauth2:${TOKEN}`)}`);
    // Only the root fetch carries the token.
    expect(calls.filter((c) => JSON.stringify(c.env).includes(b64(`oauth2:${TOKEN}`)))).toEqual([
      fetch,
    ]);
    noTokenInArgv(calls);
  });

  test("a GitHub target's env and argv are unchanged", async () => {
    const dir = await mirror('gh-fetch');
    const calls = record();
    await mirrorFetch(dir, TOKEN, { owner: 'o', name: 'r' }, ['main']);
    const c = calls[0] as Call;
    expect(c.argv).toEqual([
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      '--prune',
      '--end-of-options',
      'https://github.com/o/r.git',
      '+refs/heads/main:refs/heads/main',
    ]);
    expect(authEnv(c.env)).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64(`x-access-token:${TOKEN}`)}`,
    });
    expect(c.env.GIT_DIR).toBe(dir);
    noTokenInArgv(calls);
  });

  test("a GitLab target's env and argv are unchanged without the clone options", async () => {
    const dir = await mirror('gl-fetch-same');
    const calls = record();
    await mirrorFetch(dir, TOKEN, { owner: 'o', name: 'r', forge: GITLAB }, ['main']);
    const c = calls[0] as Call;
    expect(c.argv).toEqual([
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      'fetch',
      '-q',
      '--no-tags',
      '--no-write-fetch-head',
      '--prune',
      '--end-of-options',
      'https://git.example.internal:8443/group/sub/project.git',
      '+refs/heads/main:refs/heads/main',
    ]);
    expect(authEnv(c.env)).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://git.example.internal:8443/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64(`oauth2:${TOKEN}`)}`,
    });
  });

  test('a deploy-token username builds the header, and redirects are refused', async () => {
    const dir = await mirror('gl-fetch-user');
    const calls = record();
    await mirrorFetch(dir, TOKEN, { owner: 'o', name: 'r', forge: GITLAB }, ['*'], {
      username: 'gitlab+deploy-token-7',
      refuseRedirects: true,
    });
    const c = calls[0] as Call;
    expect(authEnv(c.env)).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://git.example.internal:8443/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${b64(`gitlab+deploy-token-7:${TOKEN}`)}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects',
      GIT_CONFIG_VALUE_1: 'false',
    });
    expect(c.argv).toContain('+refs/heads/*:refs/heads/*');
    noTokenInArgv(calls);
    for (const a of c.argv) expect(a).not.toContain(b64(`gitlab+deploy-token-7:${TOKEN}`));
  });

  test('a git failure with a username is redacted in its username forms', async () => {
    const dir = await mirror('gl-fetch-redact');
    const user = 'gitlab+deploy-token-7';
    const forms = [TOKEN, `${user}:${TOKEN}`, b64(`${user}:${TOKEN}`)];
    setSpawn((_cmd, _args, opts) =>
      spawn('sh', ['-c', `echo "401 ${forms.join(' ')}" >&2; exit 128`], { ...opts, cwd: '/' }),
    );
    const err = await mirrorFetch(dir, TOKEN, { owner: 'o', name: 'r', forge: GITLAB }, ['*'], {
      username: user,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('401');
    for (const f of forms) expect(msg).not.toContain(f);
  });
});

test('remoteBranchExists reports whether the branch is on the remote', async () => {
  const dir = await clone('lsremote');
  await prepareBranch(dir, 'agent/issue-14', 'main');
  writeFileSync(join(dir, 'l.txt'), 'l\n');
  await commitIfDirty(dir, 'feat: l');
  expect(await remoteBranchExists(target(), 'agent/issue-14', 'tok')).toBe(false);
  git(dir, 'push', '-q', origin, 'HEAD:refs/heads/agent/issue-14');
  expect(await remoteBranchExists(target(), 'agent/issue-14', 'tok')).toBe(true);
  expect(await remoteBranchExists(target(), 'agent/issue-1', 'tok')).toBe(
    hasBranch(origin, 'agent/issue-1'),
  );
});

test('sweepProcesses signals all other processes only in container mode', () => {
  const calls: unknown[][] = [];
  const kill = (...a: unknown[]): true => {
    calls.push(a);
    return true;
  };
  expect(sweepProcesses({}, kill)).toBe(false);
  expect(sweepProcesses({ JM_CONTAINER: '0' }, kill)).toBe(false);
  expect(calls).toEqual([]);
  expect(sweepProcesses({ JM_CONTAINER: '1' }, kill)).toBe(true);
  expect(calls).toEqual([[-1, 'SIGKILL']]);
});

// Crew clones: the repo's agent instructions are removed before the agent runs. In a container the
// clone is the agent's and root has no DAC_OVERRIDE, so the removal must run as the clone's owner.
test('removeInstructionFiles removes instruction files at any depth, never .git, never through a link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jm strip '));
  const outside = mkdtempSync(join(tmpdir(), 'jm-outside-'));
  writeFileSync(join(outside, 'CLAUDE.md'), 'keep me');
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'CLAUDE.md'), 'git internals stay');
  writeFileSync(join(root, 'CLAUDE.md'), 'x');
  writeFileSync(join(root, '.mcp.json'), '{}');
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'SKILL.md'), 'x');
  mkdirSync(join(root, 'pkg', 'sub'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'sub', 'CLAUDE.local.md'), 'x');
  writeFileSync(join(root, 'pkg', 'README.md'), 'keep');
  symlinkSync(outside, join(root, 'linked'));
  const removed = await removeInstructionFiles(root, null);
  expect(removed.sort()).toEqual(['.claude', '.mcp.json', 'CLAUDE.md', 'pkg/sub/CLAUDE.local.md']);
  expect(existsSync(join(root, '.git', 'CLAUDE.md'))).toBe(true);
  expect(existsSync(join(root, 'pkg', 'README.md'))).toBe(true);
  expect(existsSync(join(outside, 'CLAUDE.md'))).toBe(true);
  expect(existsSync(join(root, '.claude'))).toBe(false);
});

describe('the git output cap', () => {
  const CAP = 4096;
  /** Every runGit child becomes `sh -c <script>`, with exec's own spawn options. */
  const shell = (script: string) =>
    setSpawn((_cmd, _args, opts) => spawn('sh', ['-c', script], opts));
  const gone = (pid: number) => {
    try {
      const st = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
      return st.trim() === '' || st.trim().startsWith('Z');
    } catch {
      return true; // ps exits 1 when the pid does not exist
    }
  };

  test('defaults to 16 MiB', () => {
    expect(GIT_OUTPUT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  test('output past the cap from a child that keeps running rejects at once and kills it', async () => {
    setGitOutputMaxBytes(CAP);
    const pidFile = join(tmp, 'cap.pid');
    // exec: the sleep keeps the shell's pid, so the pid file names the process that must die.
    shell(`echo $$ > ${pidFile}; head -c ${CAP + 1} /dev/zero | tr '\\0' a; exec sleep 30`);
    const t0 = Date.now();
    await expect(runGit(tmp, ['status'])).rejects.toThrow('output too large');
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const t1 = Date.now();
    while (!gone(pid) && Date.now() - t1 < 5_000) await new Promise((ok) => setTimeout(ok, 100));
    const dead = gone(pid);
    if (!dead) process.kill(pid, 'SIGKILL');
    expect(dead).toBe(true);
  }, 30_000);

  test('cap + 1 bytes and exit 0 rejects, never resolves cut off', async () => {
    setGitOutputMaxBytes(CAP);
    shell(`head -c ${CAP + 1} /dev/zero | tr '\\0' a`);
    await expect(runGit(tmp, ['status'])).rejects.toThrow('output too large');
  });

  test('exactly cap bytes resolves with all of them', async () => {
    setGitOutputMaxBytes(CAP);
    shell(`head -c ${CAP} /dev/zero | tr '\\0' a`);
    expect(await runGit(tmp, ['status'])).toBe('a'.repeat(CAP));
  });

  test('the cap counts bytes, not UTF-16 characters', async () => {
    setGitOutputMaxBytes(CAP);
    // 3 bytes and 1 UTF-16 unit each: 4098 bytes, 1366 characters.
    const text = '\u20ac'.repeat(Math.ceil((CAP + 1) / 3));
    const file = join(tmp, 'euro.txt');
    writeFileSync(file, text);
    expect(Buffer.byteLength(text)).toBeGreaterThan(CAP);
    expect(text.length).toBeLessThan(CAP);
    shell(`cat ${file}`);
    await expect(runGit(tmp, ['status'])).rejects.toThrow('output too large');
  });
});

describe('prePushCheck: private keys', () => {
  const B = 'agent/issue-1';
  let n = 0;
  const check = (
    files: Record<string, string>,
    privateKeyPaths: string[] = [],
    seed?: Record<string, string>,
  ) => {
    const base = join(tmp, `pk-${n++}`);
    mkdirSync(base);
    const bare = scratchPush(base, B, files, seed);
    return prePushCheck(bare, B, ['.github/**'], 'refs/jm/base', [], privateKeyPaths);
  };
  const real = fixtureKey(1700);

  test('a real key in an added file is refused, naming the path', async () => {
    const file = `export const KEY = \`${real}\`;\n`;
    expect(await check({ 'config/deploy.pem.ts': file })).toBe(
      'private key in config/deploy.pem.ts',
    );
  });

  test('a real key on an allow-listed path is pushed', async () => {
    const file = `export const KEY = \`${real}\`;\n`;
    expect(await check({ 'test/fixtures/tls/key.ts': file }, ['test/fixtures/**'])).toBeNull();
    // The allow-list covers only its own paths.
    expect(
      await check({ 'test/fixtures/tls/key.ts': file, 'src/k.ts': file }, ['test/fixtures/**']),
    ).toBe('private key in src/k.ts');
  });

  test('a key spread over 30 added lines is caught', async () => {
    const key = fixtureKey(64 * 28);
    expect(key.split('\n')).toHaveLength(30);
    expect(await check({ 'docs/setup.md': `# Setup\n\n${key}\n` })).toBe(
      'private key in docs/setup.md',
    );
  });

  test('a key added into an existing file, between kept lines, is caught', async () => {
    const seed = { 'a.txt': 'a\n', 'notes.md': 'one\ntwo\n' };
    expect(await check({ 'notes.md': `one\n${real}\ntwo\n` }, [], seed)).toBe(
      'private key in notes.md',
    );
  });

  test('JSON-escaped and CRLF keys are caught; a path git quotes is named unquoted', async () => {
    expect(await check({ 'k.json': JSON.stringify({ key: real }) })).toBe('private key in k.json');
    expect(await check({ 'k.txt': fixtureKey(1700, 'OPENSSH ', '\r\n') })).toBe(
      'private key in k.txt',
    );
    expect(await check({ 'dir with space/é.ts': real })).toBe('private key in dir with space/é.ts');
    expect(await check({ 'fx/é k.ts': real }, ['fx/**'])).toBeNull();
  });

  test('a fake (short) key is pushed', async () => {
    expect(await check({ 'src/x.test.ts': `const pem = \`${fixtureKey(16)}\`;\n` })).toBeNull();
  });

  test('the refusal holds no base64 from the key', async () => {
    const r = await check({ 'config/deploy.pem.ts': real });
    expect(r).not.toBeNull();
    for (const line of real.split('\n').slice(1, -1)) {
      for (let i = 0; i + 8 <= line.length; i += 8) expect(r).not.toContain(line.slice(i, i + 8));
    }
    expect(r).not.toContain('PRIVATE KEY');
  });
});

describe('addedRuns', () => {
  test('splits runs at removed lines and keeps "no newline" markers inside a run', () => {
    const patch = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1,2 @@',
      '-old',
      '+a',
      '+++ b/not-a-header',
      '\\ No newline at end of file',
      '@@ -5 +6 @@',
      '+b',
      'diff --git a/gone b/gone',
      '--- a/gone',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-z',
    ].join('\n');
    expect(addedRuns(patch)).toEqual([{ path: 'x', runs: ['a\n++ b/not-a-header', 'b'] }]);
  });
});
