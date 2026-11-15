import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DropPayload, pushRequestValid } from '@jumpmaster/protocol';
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

test('a completed heal asks for a final push of the gated commit', async () => {
  const w = roleWorld({ dirty: true });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({
    status: 'completed',
    role: 'heal',
    headSha: 'sha-new',
    push: { kind: 'final', expectSha: 'sha-new' },
  });
  expect(pushRequestValid(r, 'heal')).toBe(true);
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

test('a completed heal carries the agent summary as its report, truncated', async () => {
  const r = await runHeal(heal, roleWorld({ dirty: true }).deps, ctx);
  expect(r).toMatchObject({ status: 'completed', summary: 'done' });
  const long = await runHeal(heal, roleWorld({ dirty: true, summary: 'y'.repeat(9000) }).deps, ctx);
  expect(long.summary).toHaveLength(8000);
});

test('a heal that changes nothing still carries its report', async () => {
  const r = await runHeal(heal, roleWorld().deps, ctx);
  expect(r).toMatchObject({ status: 'no_changes', summary: 'done' });
});

test('a heal whose agent gave no summary still sends an empty one', async () => {
  const done = await runHeal(heal, roleWorld({ dirty: true, noSummary: true }).deps, ctx);
  expect(done).toMatchObject({ status: 'completed', summary: '' });
  const none = await runHeal(heal, roleWorld({ noSummary: true }).deps, ctx);
  expect(none).toMatchObject({ status: 'no_changes', summary: '' });
});

test('heal whose agent committed itself is not no_changes', async () => {
  const r = await runHeal(heal, roleWorld({ agentCommits: 'sha2' }).deps, ctx);
  expect(r.status).toBe('completed');
});

test('heal that changes nothing is no_changes', async () => {
  const w = roleWorld();
  const r = await runHeal(heal, w.deps, ctx);
  expect(r.status).toBe('no_changes');
  expect(r.push).toBeUndefined();
  expect(w.names()).not.toContain('runGates');
});

test('heal on a moved head fails with head moved', async () => {
  const w = roleWorld({ checkoutError: 'head moved: expected sha1 got sha9' });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({ status: 'failed' });
  expect(r.push).toBeUndefined();
  expect(r.reason).toMatch(/^head moved/);
  expect(w.claude.runs).toBe(0);
});

test('heal stopped by a limit asks for a checkpoint push of the PR branch', async () => {
  const w = roleWorld({ dirty: true, rateLimited: true });
  const r = await runHeal(heal, w.deps, ctx);
  expect(r).toMatchObject({
    status: 'rate_limited',
    role: 'heal',
    headSha: 'sha-new',
    push: { kind: 'checkpoint' },
  });
  expect(r.push).toEqual({ kind: 'checkpoint' });
  expect(pushRequestValid(r, 'heal')).toBe(true);
  expect(w.calls).toContainEqual(['commitIfDirty', repoDir, 'wip: checkpoint', null]);
});
