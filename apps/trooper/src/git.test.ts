import { execFileSync } from 'node:child_process';
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
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  aheadOfBase,
  authHeader,
  cloneRepo,
  commitIfDirty,
  conflictMarkers,
  headSha,
  mergeInProgress,
  prepareBranch,
  remoteBranchExists,
  removeInstructionFiles,
  runGit,
  sweepProcesses,
  treeState,
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
