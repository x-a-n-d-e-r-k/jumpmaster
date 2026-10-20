import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  aheadOfBase,
  authHeader,
  cloneRepo,
  commitIfDirty,
  headSha,
  prepareBranch,
  pushNewBranch,
  remoteBranchExists,
  runGit,
  sweepProcesses,
} from './git.js';

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

test('pushNewBranch refuses to overwrite an existing remote branch', async () => {
  const dirA = await clone('pa');
  const dirB = await clone('pb');
  for (const d of [dirA, dirB]) {
    await prepareBranch(d, 'agent/issue-1', 'main');
    writeFileSync(join(d, `${d.includes('/pa/') ? 'x' : 'y'}.txt`), 'z\n');
    await commitIfDirty(d, 'feat: z');
  }
  await pushNewBranch(dirA, 'agent/issue-1', '', target());
  await expect(pushNewBranch(dirB, 'agent/issue-1', '', target())).rejects.toThrow(
    /stale info|rejected/,
  );
});

test('a silent git failure leaks neither the token nor its base64 form', async () => {
  const dir = await clone('silent');
  const token = 'ghp_SILENTTOKEN1234567890abcdef';
  const mirror = join(dir, '..', 'mirror');
  const err = await runGit(
    undefined,
    ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'],
    token,
    {
      gitDir: realpathSync(mirror),
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
  for (const hook of ['pre-commit', 'pre-push']) {
    const f = join(dir, '.git/hooks', hook);
    writeFileSync(f, `#!/bin/sh\nenv >> ${dump}\n`);
    chmodSync(f, 0o755);
  }
  const saved = { ...process.env };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'claude-secret-value';
  process.env.GH_TOKEN = 'gh-secret-value';
  process.env.JM_X = 'jm-secret-value';
  try {
    writeFileSync(join(dir, 'c.txt'), 'c\n');
    await commitIfDirty(dir, 'feat: c');
    await pushNewBranch(dir, 'agent/issue-9', 'forge-tok', target());
  } finally {
    process.env = saved;
  }
  const seen = readFileSync(dump, 'utf8');
  expect(seen).not.toMatch(/claude-secret-value|gh-secret-value|jm-secret-value/);
  expect(seen).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
});

function bare(name: string): string {
  const d = join(tmp, name);
  git(tmp, 'init', '--bare', '-q', '-b', 'main', d);
  return d;
}
const hasBranch = (repo: string, b: string): boolean =>
  git(repo, 'for-each-ref', '--format=%(refname)', `refs/heads/${b}`) !== '';

test('push runs from a pristine repo: planted hooks, hooksPath and redirects never run or see the token', async () => {
  const dir = await clone('planted');
  await prepareBranch(dir, 'agent/issue-11', 'main');
  writeFileSync(join(dir, 'p.txt'), 'p\n');
  await commitIfDirty(dir, 'feat: p');
  const decoy = bare('decoy.git');
  const dump = join(tmp, 'planted-dump');
  const hookBody = `#!/bin/sh\n{ env; echo "ARGS $*"; } >> ${dump}\n`;
  const hookDir = join(tmp, 'evil-hooks');
  mkdirSync(hookDir);
  for (const f of [join(dir, '.git/hooks/pre-push'), join(hookDir, 'pre-push')]) {
    writeFileSync(f, hookBody);
    chmodSync(f, 0o755);
  }
  git(dir, 'config', 'core.hooksPath', hookDir);
  git(dir, 'config', 'remote.origin.pushurl', `file://${decoy}`);
  git(dir, 'config', `url.file://${decoy}.insteadOf`, url());

  const sha = await pushNewBranch(
    dir,
    'agent/issue-11',
    'ghp_PLANTEDTOKEN1234567890abcd',
    target(),
  );

  expect(existsSync(dump)).toBe(false);
  expect(hasBranch(decoy, 'agent/issue-11')).toBe(false);
  expect(git(origin, 'rev-parse', 'refs/heads/agent/issue-11')).toBe(git(dir, 'rev-parse', 'HEAD'));
  expect(sha).toBe(git(dir, 'rev-parse', 'HEAD'));
});

test('push ignores inherited GIT_* config and the global gitconfig', async () => {
  const dir = await clone('globalcfg');
  await prepareBranch(dir, 'agent/issue-12', 'main');
  writeFileSync(join(dir, 'g.txt'), 'g\n');
  await commitIfDirty(dir, 'feat: g');
  const decoy = bare('decoy2.git');
  const home = join(tmp, 'evil-home');
  mkdirSync(home);
  const evil = `[url "file://${decoy}"]\n\tinsteadOf = ${url()}\n`;
  writeFileSync(join(home, '.gitconfig'), evil);
  const saved = { ...process.env };
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.file://${decoy}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = url();
  try {
    await pushNewBranch(dir, 'agent/issue-12', 'tok', target());
  } finally {
    process.env = saved;
  }
  expect(hasBranch(decoy, 'agent/issue-12')).toBe(false);
  expect(hasBranch(origin, 'agent/issue-12')).toBe(true);
});

test('push sweeps other processes before the token is used', async () => {
  const dir = await clone('sweep');
  await prepareBranch(dir, 'agent/issue-13', 'main');
  writeFileSync(join(dir, 's.txt'), 's\n');
  await commitIfDirty(dir, 'feat: s');
  let sweeps = 0;
  await pushNewBranch(dir, 'agent/issue-13', 'tok', target(), () => {
    sweeps++;
    expect(hasBranch(origin, 'agent/issue-13')).toBe(false);
  });
  expect(sweeps).toBeGreaterThan(0);
  expect(hasBranch(origin, 'agent/issue-13')).toBe(true);
});

test('the auth header is scoped to https://github.com/ only', async () => {
  const dir = await clone('scoped');
  const token = 'ghp_SCOPEDTOKEN1234567890abcd';
  const gitDir = realpathSync(join(dir, '..', 'mirror'));
  expect(
    await runGit(undefined, ['config', '--get', 'http.https://github.com/.extraheader'], token, {
      gitDir,
    }),
  ).toBe(authHeader(token));
  await expect(
    runGit(undefined, ['config', '--get', 'http.extraheader'], token, { gitDir }),
  ).rejects.toThrow();
});

test('remoteBranchExists reports whether the branch is on the remote', async () => {
  const dir = await clone('lsremote');
  await prepareBranch(dir, 'agent/issue-14', 'main');
  writeFileSync(join(dir, 'l.txt'), 'l\n');
  await commitIfDirty(dir, 'feat: l');
  expect(await remoteBranchExists(target(), 'agent/issue-14', 'tok')).toBe(false);
  await pushNewBranch(dir, 'agent/issue-14', 'tok', target());
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
