import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  runGit,
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

test('a silent git failure leaks neither the token nor its base64 form', async () => {
  const dir = await clone('silent');
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  const token = 'ghp_SILENTTOKEN1234567890abcdef';
  const err = await runGit(dir, ['diff', '--quiet'], token).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).toContain('git diff failed (exit 1)');
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
    await pushNewBranch(dir, 'agent/issue-9', 'forge-tok');
  } finally {
    process.env = saved;
  }
  const seen = readFileSync(dump, 'utf8');
  expect(seen).not.toMatch(/claude-secret-value|gh-secret-value|jm-secret-value/);
  expect(seen).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
});
