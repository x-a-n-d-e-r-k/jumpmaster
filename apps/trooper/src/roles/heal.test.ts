import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropPayload } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import { roleWorld } from '../test/roleWorld.js';
import { runHeal } from './heal.js';
import type { RoleCtx } from './shared.js';

const heal: DropPayload = {
  protocol: 1,
  dropId: 'd3',
  epoch: 1,
  role: 'heal',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  pr: { number: 9, branch: 'agent/issue-1', headSha: 'sha1' },
  feedback: '## Feedback (data, from trusted reviewers)\n\nrename foo',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'heal it',
  image: 'img',
  protectedPaths: ['.github/**'],
  credentials: { claudeToken: 'sk-ant-oat-SECRET1234567890', forgeToken: 'ghp_FORGE1234567890' },
};
const ctx: RoleCtx = {
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-heal-')),
  secrets: ['sk-ant-oat-SECRET1234567890'],
  ids: null,
};
const repoDir = join(ctx.workdir, 'repo');

test('heal pushes with lease on the PR head', async () => {
  const w = roleWorld({ dirty: true });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({ status: 'completed', role: 'heal', headSha: 'pushed' });
  expect(w.calls).toContainEqual([
    'pushExistingBranch',
    repoDir,
    'agent/issue-1',
    heal.credentials.forgeToken,
    { owner: 'o', name: 'r' },
    'sha1',
    expect.any(Function),
    expect.objectContaining({ base: 'main', protectedPaths: ['.github/**'], as: null }),
  ]);
  expect(w.calls).toContainEqual(['checkoutBranch', repoDir, 'agent/issue-1', 'sha1', null]);
  expect(w.names().indexOf('mirrorFetch')).toBeLessThan(w.names().indexOf('checkoutBranch'));
});

test('heal shows the feedback to the agent under its own heading', async () => {
  const w = roleWorld({ dirty: true });
  await runHeal(heal, w.deps, ctx);
  const prompt = w.claude.args.at(-1)?.join(' ') ?? '';
  expect(prompt).toContain('heal it');
  expect(prompt).toContain('## Feedback (data, from trusted reviewers)');
});

test('heal whose agent committed itself is not no_changes', async () => {
  const r = await runHeal(heal, roleWorld({ agentCommits: 'sha2' }).deps, ctx);
  expect(r.status).toBe('completed');
});

test('heal that changes nothing is no_changes', async () => {
  const w = roleWorld();
  const r = await runHeal(heal, w.deps, ctx);
  expect(r.status).toBe('no_changes');
  expect(w.names()).not.toContain('pushExistingBranch');
  expect(w.names()).not.toContain('runGates');
});

test('heal lease rejection fails with stale info', async () => {
  const w = roleWorld({ dirty: true, pushError: 'stale info: remote moved' });
  expect((await runHeal(heal, w.deps, ctx)).reason).toMatch(/^stale info/);
});

test('heal on a moved head fails with head moved', async () => {
  const w = roleWorld({ checkoutError: 'head moved: expected sha1 got sha9' });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({ status: 'failed' });
  expect(r.reason).toMatch(/^head moved/);
  expect(w.claude.runs).toBe(0);
});

test('heal stopped by a limit checkpoints onto the PR branch', async () => {
  const w = roleWorld({ dirty: true, rateLimited: true });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({ status: 'rate_limited', headSha: 'pushed' });
  expect(w.calls).toContainEqual(['commitIfDirty', repoDir, 'wip: checkpoint', null]);
  expect(w.calls.find((c) => c[0] === 'pushExistingBranch')?.[5]).toBe('sha1');
});
