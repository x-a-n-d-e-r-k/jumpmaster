import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  aheadOfBase,
  cloneRepo,
  commitIfDirty,
  headSha,
  prepareBranch,
  pushNewBranch,
} from './git.js';

let tmp: string;
let origin: string;
const url = (): string => `file://${origin}`;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function clone(name: string): Promise<string> {
  const dir = join(tmp, name);
  await cloneRepo({ owner: 'o', name: 'r', token: 'tok', dir, url: url() });
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'git-'));
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
    writeFileSync(join(d, `${d.endsWith('pa') ? 'x' : 'y'}.txt`), 'z\n');
    await commitIfDirty(d, 'feat: z');
  }
  await pushNewBranch(dirA, 'agent/issue-1', '');
  await expect(pushNewBranch(dirB, 'agent/issue-1', '')).rejects.toThrow(/stale info|rejected/);
});
