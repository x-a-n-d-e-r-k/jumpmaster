import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropPayload } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import { roleWorld } from '../test/roleWorld.js';
import { runResolve } from './resolve.js';
import type { RoleCtx } from './shared.js';

const resolve: DropPayload = {
  protocol: 1,
  dropId: 'd4',
  epoch: 1,
  role: 'resolve',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  pr: { number: 9, branch: 'agent/issue-1', headSha: 'sha1' },
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'resolve it',
  image: 'img',
  protectedPaths: [],
  credentials: { claudeToken: 'sk-ant-oat-SECRET1234567890', forgeToken: 'ghp_FORGE1234567890' },
};
const ctx: RoleCtx = {
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-resolve-')),
  secrets: ['sk-ant-oat-SECRET1234567890'],
  ids: null,
};
const repoDir = join(ctx.workdir, 'repo');

test('resolve with conflicts commits the merge before gates', async () => {
  const w = roleWorld({ merge: 'conflicts', dirty: true });
  const r = await runResolve(resolve, w.deps, ctx);
  expect(r).toMatchObject({ status: 'completed', mergeOutcome: 'conflicts', headSha: 'pushed' });
  const order = w.names();
  expect(w.calls).toContainEqual(['commitIfDirty', repoDir, 'Merge origin/main', null]);
  expect(order.indexOf('commitIfDirty')).toBeGreaterThan(-1);
  expect(order.indexOf('commitIfDirty')).toBeLessThan(order.indexOf('runGates'));
  expect(w.claude.runs).toBe(1);
  expect(w.calls.find((c) => c[0] === 'pushExistingBranch')?.[5]).toBe('sha1');
});

test('resolve with clean merge skips claude and reports clean', async () => {
  const w = roleWorld({ merge: 'clean' });
  const r = await runResolve(resolve, w.deps, ctx);
  expect(r).toMatchObject({ status: 'completed', mergeOutcome: 'clean', role: 'resolve' });
  expect(w.claude.runs).toBe(0);
  expect(w.names()).toContain('pushExistingBranch');
});

test('resolve up to date is no_changes', async () => {
  const w = roleWorld({ merge: 'up_to_date' });
  const r = await runResolve(resolve, w.deps, ctx);
  expect(r).toMatchObject({ status: 'no_changes', mergeOutcome: 'up_to_date' });
  expect(w.names()).not.toContain('pushExistingBranch');
});

test('resolve leaving conflict markers fails', async () => {
  const w = roleWorld({ merge: 'conflicts', markers: ['a.ts'] });
  const r = await runResolve(resolve, w.deps, ctx);
  expect(r).toMatchObject({ status: 'failed', mergeOutcome: 'conflicts' });
  expect(r.reason).toContain('a.ts');
  expect(w.names()).not.toContain('pushExistingBranch');
});

test('a merge left unconcluded fails', async () => {
  const w = roleWorld({ merge: 'conflicts', mergeStuck: true });
  const r = await runResolve(resolve, w.deps, ctx);
  expect(r).toMatchObject({ status: 'failed', reason: 'merge not concluded' });
});

test('resolve refreshes the base in the mirror before merging', async () => {
  const w = roleWorld({ merge: 'clean' });
  await runResolve(resolve, w.deps, ctx);
  const fetch = w.calls.find((c) => c[0] === 'mirrorFetch');
  expect(fetch?.[4]).toEqual(['agent/issue-1', 'main']);
});
