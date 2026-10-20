import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DropPayload, GateResult } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import type { TrooperDeps } from '../main.js';
import { runReview } from './review.js';
import type { RoleCtx } from './shared.js';

const SECRET = 'sk-ant-oat-SECRET1234567890';
const review: DropPayload = {
  protocol: 1,
  dropId: 'd2',
  epoch: 1,
  role: 'review',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  pr: { number: 9, branch: 'agent/issue-1', headSha: 'h9' },
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'review it',
  image: 'img',
  protectedPaths: [],
  credentials: { claudeToken: SECRET, forgeToken: 'ghp_READ1234567890' },
};
const ctx: RoleCtx = {
  workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-review-')),
  secrets: [SECRET],
  ids: null,
};
const repoDir = join(ctx.workdir, 'repo');

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
const verdictLine = (v: object) =>
  JSON.stringify({
    type: 'result',
    is_error: false,
    terminal_reason: 'completed',
    session_id: 's',
    structured_output: v,
  });
const approve = { decision: 'approve', summary: 'looks good', findings: [] };

function world(
  o: { verdict?: object; gateExit?: number; claudeWrites?: boolean; gateWrites?: boolean } = {},
) {
  const calls: unknown[][] = [];
  let tree = 'clean';
  const claude = { runs: 0 };
  const rec =
    <T>(name: string, ret: (...a: unknown[]) => T) =>
    async (...a: unknown[]) => {
      calls.push([name, ...a]);
      return ret(...a);
    };
  const deps = {
    git: {
      cloneRepo: rec('cloneRepo', () => undefined),
      mirrorFetch: rec('mirrorFetch', () => undefined),
      checkoutBranch: rec('checkoutBranch', () => undefined),
      treeState: rec('treeState', () => tree),
      commitIfDirty: rec('commitIfDirty', () => false),
      pushNewBranch: rec('pushNewBranch', () => 'x'),
      pushExistingBranch: rec('pushExistingBranch', () => 'x'),
      sweepProcesses: () => false,
      cloneForGates: rec('cloneForGates', () => undefined),
      removeTree: rec('removeTree', () => undefined),
    },
    async *runClaude() {
      claude.runs++;
      if (o.claudeWrites) tree = 'dirty a.ts';
      yield init;
      yield verdictLine(o.verdict ?? approve);
    },
    runGates: async (gates: { name: string }[]): Promise<GateResult[]> => {
      if (o.gateWrites) tree = 'gate artefacts';
      return gates.map((g) => ({
        name: g.name,
        exitCode: o.gateExit ?? 0,
        durationMs: 1,
        timedOut: false,
        outputTail: '',
      }));
    },
    emit: () => undefined,
  } as unknown as TrooperDeps;
  return { deps, calls, claude, names: () => calls.map((c) => c[0]) };
}

test('review never pushes and returns the verdict', async () => {
  const w = world();
  const r = await runReview(review, w.deps, ctx);
  expect(r).toMatchObject({
    status: 'completed',
    role: 'review',
    verdict: { decision: 'approve' },
  });
  expect(r.gates).toHaveLength(1);
  expect(w.calls).toContainEqual(['checkoutBranch', repoDir, 'agent/issue-1', 'h9', null]);
  expect(w.names()).not.toContain('pushExistingBranch');
  expect(w.names()).not.toContain('pushNewBranch');
  expect(w.names()).not.toContain('commitIfDirty');
});

test('review that edits files is discarded', async () => {
  const r = await runReview(review, world({ claudeWrites: true }).deps, ctx);
  expect(r).toMatchObject({ status: 'failed', reason: 'review modified the tree' });
  expect(r.verdict).toBeUndefined();
});

test('a red gate yields request_changes without running claude', async () => {
  const w = world({ gateExit: 1 });
  const r = await runReview(review, w.deps, ctx);
  expect(r.status).toBe('completed');
  expect(r.verdict?.decision).toBe('request_changes');
  expect(r.verdict?.findings).toEqual([expect.objectContaining({ severity: 'blocker' })]);
  expect(r.verdict?.findings[0]?.detail).toContain('test');
  expect(w.claude.runs).toBe(0);
});

test('gate writes before claude are not a tree modification', async () => {
  const r = await runReview(review, world({ gateWrites: true }).deps, ctx);
  expect(r).toMatchObject({ status: 'completed', verdict: { decision: 'approve' } });
});

test('verdict strings are redacted', async () => {
  const leaky = {
    decision: 'request_changes',
    summary: `token ${SECRET}`,
    findings: [{ severity: 'major', file: `f${SECRET}`, detail: `see ${SECRET}` }],
  };
  const r = await runReview(review, world({ verdict: leaky }).deps, ctx);
  expect(JSON.stringify(r)).not.toContain(SECRET);
  expect(r.verdict?.summary).toContain('token');
});

test('an invalid verdict is failed', async () => {
  const r = await runReview(review, world({ verdict: { decision: 'maybe' } }).deps, ctx);
  expect(r.status).toBe('failed');
});

test('review clone carries no token when none is given', async () => {
  const w = world();
  const p = { ...review, credentials: { claudeToken: SECRET } } as DropPayload;
  await runReview(p, w.deps, ctx);
  const clone = w.calls.find((c) => c[0] === 'cloneRepo')?.[1] as { token: string };
  expect(clone.token).toBe('');
});
