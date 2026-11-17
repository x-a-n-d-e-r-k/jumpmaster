import type { DropResult, GateResult, Verdict } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  activeDropFor,
  getAttempts,
  getPullRequest,
  latestVerdict,
  setAttempts,
  setWorkItemState,
} from '../db/repo.js';
import type { CompareFile } from '../forge/github.js';
import { opKeys, opMarker } from '../outbox.js';
import { type Harness, harness, toApproved, toPrOpen } from '../test/flowHarness.js';
import { workItem } from '../test/helpers.js';

const gateOk: GateResult = {
  name: 'test',
  exitCode: 0,
  durationMs: 10,
  timedOut: false,
  outputTail: '',
};
const approve: Verdict = { decision: 'approve', summary: 'ok', findings: [] };
const changes: Verdict = {
  decision: 'request_changes',
  summary: 'needs work',
  findings: [{ severity: 'major', file: 'src/a.ts', detail: 'handle the empty case' }],
};
const reviewResult = (verdict: Verdict): DropResult => ({
  status: 'completed',
  gates: [gateOk],
  verdict,
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

describe('lifecycle', () => {
  test('happy path: implement → review approve → merge', async () => {
    await toApproved(h, 'sha1');
    await h.reconcile();
    expect(h.forge.reviewer.calls.filter((c) => c.method === 'createReview')).toHaveLength(1);
    expect(h.forge.state.merges).toEqual([
      { number: 1, sha: 'sha1', title: 'Issue 1', message: 'Closes #1' },
    ]);
    expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('request_changes → heal → re-review on the new head', async () => {
    await h.reconcile();
    await h.finishDrop('implement', { status: 'completed', headSha: 'sha1', gates: [gateOk] });
    await h.reconcile();
    await h.finishDrop('review', reviewResult(changes));
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    const { payload } = await h.lease();
    expect(payload).toMatchObject({ role: 'heal', pr: { headSha: 'sha1' } });
    expect(payload.role === 'heal' && payload.feedback).toContain('handle the empty case');
  });

  test('a heal on the new head is reviewed again, then merges', async () => {
    await h.reconcile();
    await h.finishDrop('implement', { status: 'completed', headSha: 'sha1', gates: [gateOk] });
    await h.reconcile();
    await h.finishDrop('review', reviewResult(changes));
    await h.reconcile();
    await h.finishDrop('heal', { status: 'completed', headSha: 'sha2', gates: [gateOk] });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
    await h.finishDrop('review', reviewResult(approve));
    await h.reconcile();
    expect(h.forge.state.merges.map((m) => m.sha)).toEqual(['sha2']);
  });

  test('adopts an existing agent PR', async () => {
    h.forge.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's',
      author: 'author-bot',
      body: opMarker(opKeys.pr(1, 's')),
    });
    h.wipeDbKeepIssues();
    await h.reconcile();
    expect(workItem(h.db, 1)).toMatchObject({ state: 'pr_open' });
    expect(h.queuedRoles()).toEqual(['review']);
  });

  test('interrupted implement resumes with resume:true', async () => {
    await h.reconcile();
    await h.finishDrop('implement', { status: 'interrupted', headSha: 'ck1', gates: [] });
    const { payload } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'ck1' });
  });

  test('force-push after approval reviews the new head and never merges the old one', async () => {
    await toApproved(h, 'sha1');
    h.forge.state.setHead(1, 'sha2');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
    expect(h.forge.state.merges).toEqual([]);
    expect(h.forge.author.calls.filter((c) => c.method === 'merge')).toHaveLength(0);
  });

  test('stale epoch result is rejected', async () => {
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    expect(await h.postResult(dropId, epoch - 1, { status: 'no_changes', gates: [] })).toBe(409);
  });

  test('restore after a merge never merges twice', async () => {
    await toApproved(h, 'sha1');
    await h.reconcile();
    h.forge.state.closeIssue(1); // GitHub closes the issue from "Closes #1" on merge
    h.wipeDbKeepIssues();
    await h.reconcile();
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    expect(h.queuedRoles()).toEqual([]);
  });

  /** CI is required and pending, so approved PRs wait together until `releaseCi`. */
  async function heldByCi(n: number): Promise<void> {
    h = await harness({
      issues: Array.from({ length: n }, (_, i) => issue(i + 1)),
      zone: { ciRequired: true },
    });
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
    for (let i = 1; i <= n; i++) {
      h.forge.state.checks.set(`sha${i}`, { state: 'pending', names: [] });
      await toApproved(h, `sha${i}`);
    }
    expect(h.forge.state.merges).toEqual([]);
  }
  const releaseCi = (n: number) => {
    for (let i = 1; i <= n; i++)
      h.forge.state.checks.set(`sha${i}`, { state: 'success', names: ['ci'] });
  };

  test('one merge per zone per pass', async () => {
    await heldByCi(2);
    releaseCi(2);
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(2);
  });

  test('three PRs approved, one merges, the others resolve cleanly without charge', async () => {
    await heldByCi(3);
    releaseCi(3);
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    // The merge moved the base: the other two heads are now behind.
    for (const sha of ['sha2', 'sha3']) {
      h.forge.state.compares.set(`main...${sha}`, {
        aheadBy: 1,
        behindBy: 1,
        baseSha: 'base1',
        mergeBaseSha: 'base0',
      });
    }
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['resolve', 'resolve']);
    await h.finishDrop('resolve', { status: 'completed', headSha: 'sha2r', gates: [gateOk] });
    await h.finishDrop('resolve', { status: 'completed', headSha: 'sha3r', gates: [gateOk] });
    expect(getAttempts(h.db, 2, 'resolve').count).toBe(0);
    expect(getAttempts(h.db, 3, 'resolve').count).toBe(0);
  });
});

describe('an approval carried across a clean merge of the base', () => {
  const prFile = (patch: string): CompareFile => ({
    filename: 'src/a.ts',
    status: 'modified',
    patch,
  });
  const hunk = '@@ -10,2 +10,3 @@\n context\n+handle the empty case\n context';
  const verdictRows = () =>
    h.db.prepare('SELECT id, head_sha AS headSha FROM verdicts ORDER BY rowid').all() as {
      id: string;
      headSha: string;
    }[];
  const dropRoles = () =>
    (
      h.db.prepare('SELECT role FROM drops ORDER BY created_at, rowid').all() as { role: string }[]
    ).map((r) => r.role);
  const digestCalls = () => h.forge.author.calls.filter((c) => c.method === 'changeDigest');

  /**
   * CI required: `aaa` approved, its review posted, waiting on CI. Main then moves on and a resolve
   * merges it into the branch, making `bbb`; `bbbFiles` is what `bbb` changes from its merge base.
   */
  async function resolvedTo(bbbFiles: CompareFile[]): Promise<void> {
    h = await harness({ issues: [issue(1)], zone: { ciRequired: true } });
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
    h.forge.state.checks.set('aaa', { state: 'pending', names: [] });
    h.forge.state.compareFiles.set('main...aaa', [prFile(hunk)]);
    await toApproved(h, 'aaa');
    await h.reconcile();
    expect(h.forge.state.reviews.map((r) => r.commitId)).toEqual(['aaa']);
    // A sibling merges: the approved head is behind.
    h.forge.state.compares.set('main...aaa', {
      aheadBy: 1,
      behindBy: 1,
      baseSha: 'base1',
      mergeBaseSha: 'base0',
    });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['resolve']);
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(1);
    h.forge.state.compareFiles.set('main...bbb', bbbFiles);
    h.forge.state.checks.set('bbb', { state: 'pending', names: [] });
    await h.finishDrop('resolve', { status: 'completed', headSha: 'bbb', gates: [gateOk] });
  }

  test('the same change on the new head carries the approval, posts it and merges after CI', async () => {
    await resolvedTo([prFile(hunk)]);
    await h.reconcile();
    // Today's code enqueued a second review here.
    expect(h.queuedRoles()).toEqual([]);
    const carried = latestVerdict(h.db, 1);
    expect(carried).toMatchObject({
      headSha: 'bbb',
      decision: 'approve',
      forced: false,
      summary: 'Carried from aaa: the change is identical after merging the base branch.\n\nok',
    });
    expect(carried?.id).toMatch(/^carry:.+:bbb$/);
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(0);
    expect(getAttempts(h.db, 1, 'base_sync').count).toBe(1);

    // Posted on the new head like any approval, then held for CI on it.
    await h.reconcile();
    expect(h.forge.state.reviews.map((r) => [r.commitId, r.state])).toEqual([
      ['aaa', 'APPROVED'],
      ['bbb', 'APPROVED'],
    ]);
    await h.reconcile();
    expect(h.forge.state.merges).toEqual([]);
    h.forge.state.checks.set('bbb', { state: 'success', names: ['ci'] });
    await h.reconcile();
    expect(h.forge.state.merges.map((m) => m.sha)).toEqual(['bbb']);
    expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' });
    expect(dropRoles().filter((r) => r === 'review')).toHaveLength(1);
  });

  test('D4: one more line in a PR file on the new head is reviewed, not carried', async () => {
    await resolvedTo([prFile(`${hunk}\n+and one more line`)]);
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
    expect(verdictRows().map((v) => v.headSha)).toEqual(['aaa']);
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(1);
    expect(getAttempts(h.db, 1, 'base_sync').count).toBe(0);
  });

  test('a file without a patch on the new head is reviewed', async () => {
    await resolvedTo([prFile(hunk), { filename: 'logo.png', status: 'added' }]);
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
  });

  test('D2: a digest read that throws is reviewed and parks nothing', async () => {
    await resolvedTo([prFile(hunk)]);
    h.forge.author.failNext('changeDigest', 'throw');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
    expect(workItem(h.db, 1).state).toBe('pr_open');
    expect(verdictRows().map((v) => v.headSha)).toEqual(['aaa']);
  });

  test('D3: two passes applying the same carry insert one verdict row and credit once', async () => {
    await resolvedTo([prFile(hunk)]);
    const before = digestCalls().length;
    await Promise.all([h.reconcile(), h.reconcile()]);
    // Both passes read the carry facts on a head with no verdict, so both applied the carry.
    expect(digestCalls().length - before).toBe(4);
    expect(verdictRows().filter((v) => v.headSha === 'bbb')).toHaveLength(1);
    expect(getAttempts(h.db, 1, 'base_sync').count).toBe(1);
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(0);
  });

  test('a forced approval is never carried', async () => {
    await resolvedTo([prFile(hunk)]);
    h.db.prepare('UPDATE verdicts SET forced = 1').run();
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
  });

  test('clean base syncs stop at maxBaseSync and park on base-sync', async () => {
    h = await harness({
      issues: [issue(1)],
      zone: { budgets: { ...h.zone.budgets, maxBaseSync: 2 } },
    });
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
    const heads = ['h0', 'h1', 'h2'];
    for (const sha of heads) {
      h.forge.state.checks.set(sha, { state: 'pending', names: [] });
      h.forge.state.compareFiles.set(`main...${sha}`, [prFile(hunk)]);
    }
    await toApproved(h, 'h0');
    for (let i = 0; i < heads.length; i++) {
      const sha = heads[i] as string;
      await h.reconcile();
      h.forge.state.compares.set(`main...${sha}`, {
        aheadBy: 1,
        behindBy: 1,
        baseSha: `base${i + 1}`,
        mergeBaseSha: `base${i}`,
      });
      await h.reconcile();
      if (i === 2) break;
      expect(h.queuedRoles()).toEqual(['resolve']);
      await h.finishDrop('resolve', {
        status: 'completed',
        headSha: heads[i + 1] as string,
        gates: [gateOk],
      });
      await h.reconcile(); // carries
      expect(getAttempts(h.db, 1, 'base_sync').count).toBe(i + 1);
    }
    expect(getAttempts(h.db, 1, 'resolve_total').count).toBe(0);
    expect(dropRoles().filter((r) => r === 'review')).toHaveLength(1);
    expect(workItem(h.db, 1)).toMatchObject({
      state: 'parked',
      reason: 'budget exhausted: base-sync',
    });
  });
});

function issue(n: number) {
  return {
    number: n,
    title: `Issue ${n}`,
    body: 'b',
    author: 'human',
    labels: ['agent-ready'],
    createdAt: `2026-01-01T00:00:0${n}.000Z`,
  };
}

describe('parked-item recovery (sync)', () => {
  const calls = (method: string) => h.forge.author.calls.filter((c) => c.method === method);

  test('reopened PR and issue un-park', async () => {
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    expect(workItem(h.db, 1)).toMatchObject({ state: 'parked', reason: 'pr closed' });
    h.forge.state.reopen(1);
    await h.sync();
    expect(workItem(h.db, 1).state).toBe('pr_open');
  });

  test('retry label on a closed-PR park resumes from the existing branch', async () => {
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.reconcile();
    expect(getPullRequest(h.db, 1)?.state).toBe('closed');
    expect(activeDropFor(h.db, 1)).toMatchObject({ role: 'implement', headSha: 'sha1' });
  });

  test('retry label resets budgets once', async () => {
    await toPrOpen(h, 'sha1');
    setAttempts(h.db, 1, 'heal', 3, 'x');
    setWorkItemState(h.db, 1, 'parked', 'budget exhausted: heal');
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.sync();
    expect(getAttempts(h.db, 1, 'heal').count).toBe(0);
    expect(workItem(h.db, 1).state).toBe('pr_open');
    setAttempts(h.db, 1, 'heal', 3, 'x');
    setWorkItemState(h.db, 1, 'parked', 'budget exhausted: heal');
    await h.sync(); // label still present: not reset again
    expect(getAttempts(h.db, 1, 'heal').count).toBe(3);
    expect(workItem(h.db, 1).state).toBe('parked');
  });

  test('retry after merge rejected clears the failed op and merges', async () => {
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', { status: 405 });
    await h.reconcile();
    await h.reconcile();
    expect(workItem(h.db, 1)).toMatchObject({
      state: 'parked',
      reason: expect.stringMatching(/^merge rejected/),
    });
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.reconcile();
    await h.reconcile();
    expect(calls('merge')).toHaveLength(2);
    expect(workItem(h.db, 1).state).toBe('done');
  });

  test('a dismissed human block un-parks without the label', async () => {
    await toApproved(h, 'sha1');
    h.forge.state.review({ author: 'alice', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
    await h.reconcile();
    expect(workItem(h.db, 1)).toMatchObject({ state: 'parked', reason: 'human block stands' });
    const last = h.forge.state.reviews.at(-1);
    if (last) last.state = 'DISMISSED';
    await h.sync();
    expect(workItem(h.db, 1).state).toBe('pr_open');
  });

  test('a merge rejected park whose PR did merge becomes done', async () => {
    await toPrOpen(h, 'sha1');
    setWorkItemState(h.db, 1, 'parked', 'merge rejected: unresolved after 45 min');
    h.forge.state.markMerged(1);
    await h.sync();
    expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('a parked item whose PR was merged by a human becomes done', async () => {
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    h.forge.state.markMerged(1);
    await h.sync();
    expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' });
  });
});

describe('hot apply', () => {
  test('the next scheduler pass dispatches with the new config while a running drop keeps its payload', async () => {
    const ready = (n: number) => ({
      number: n,
      title: `Issue ${n}`,
      body: 'b',
      author: 'human',
      labels: ['agent-ready'],
      createdAt: `2026-01-01T00:0${n}:00.000Z`,
    });
    const live = await harness({
      live: true,
      issues: [ready(1), ready(2)],
      zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'], model: 'model-before' },
    });
    const store = live.store as NonNullable<Harness['store']>;
    const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };
    // One implement at a time: the first pass dispatches issue 1 only.
    await live.reconcile();
    expect(live.queuedRoles()).toEqual(['implement']);
    const first = await live.lease();
    expect(first.payload.model).toBe('model-before');

    // A revision between passes: a second slot and another model.
    const doc = store.document();
    const zones = doc.dropZones as Record<string, unknown>[];
    const r = store.apply(
      { ...doc, dropZones: [{ ...zones[0], model: 'model-after', maxConcurrentImplement: 2 }] },
      { via: 'ctl', principal: token, expectRevision: store.revision() },
    );
    expect(r.ok).toBe(true);

    // The next pass reads it: issue 2 is dispatched in the new slot, with the new model.
    await live.reconcile();
    expect(live.queuedRoles()).toEqual(['implement']);
    const second = await live.lease();
    expect(second.payload.model).toBe('model-after');
    // The drop already running kept what it was leased with, and finishes as it was.
    expect(first.payload.model).toBe('model-before');
    expect(
      await live.postResult(first.dropId, first.epoch, {
        status: 'completed',
        headSha: 'sha1',
        gates: [gateOk],
      }),
    ).toBe(204);
  });
});
