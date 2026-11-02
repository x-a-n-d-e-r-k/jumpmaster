import { beforeEach, describe, expect, test } from 'vitest';
import {
  activeDropFor,
  getAttempts,
  getOutbox,
  getWorkItem,
  insertDrop,
  insertOutbox,
  insertVerdict,
  setAttempts,
  updateOutbox,
} from '../db/repo.js';
import { promptVersions } from '../payloads.js';
import { usageCfg, zoneWorld } from '../test/fixtures.js';
import { reconcileZone } from './reconcile.js';
import { zonePass } from './snapshot.js';

const t = new Date('2026-01-01T01:00:00Z');
let w: ReturnType<typeof zoneWorld>;

const pass = async (now = t) => {
  const p = await zonePass(w.forges, w.zone, 'main');
  return reconcileZone(w.db, w.forges, w.zone, p, promptVersions(), usageCfg, [], now);
};
const item = (id: number) => {
  const i = getWorkItem(w.db, id);
  if (!i) throw new Error(`no item ${id}`);
  return i;
};
const calls = (method: string) => w.f.author.calls.filter((c) => c.method === method);

function approve(itemId: number, headSha: string, posted = true): void {
  const id = `rev-${itemId}-${headSha}`;
  insertVerdict(w.db, {
    id,
    workItemId: itemId,
    headSha,
    decision: 'approve',
    forced: false,
    summary: 'ok',
    findingsJson: '[]',
    gatesJson: '[]',
    createdAt: t.toISOString(),
  });
  if (posted) {
    const key = `review:${itemId}:${headSha}:${id}`;
    insertOutbox(w.db, {
      id: `o-${id}`,
      opKey: key,
      kind: 'post_review',
      workItemId: itemId,
      payloadJson: '{}',
      state: 'pending',
      createdAt: t.toISOString(),
    });
    updateOutbox(w.db, key, { state: 'done', resultJson: '{"id":1}' }, t);
  }
}

beforeEach(() => {
  w = zoneWorld();
});

describe('reconcileZone — pr_open items', () => {
  test('an unreviewed head gets a review drop with fingerprint, PR and prompt version', async () => {
    const id = w.prItem(1, 'sha1');
    await pass();
    expect(activeDropFor(w.db, id)).toMatchObject({
      role: 'review',
      prNumber: 1,
      headSha: 'sha1',
      promptVersion: promptVersions().review,
      state: 'queued',
    });
    expect(getAttempts(w.db, id, 'review').count).toBe(1);
  });

  test('an approved, posted, green head merges with the PR title and Closes #N', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    const r = await pass();
    expect(r.merges).toBe(1);
    expect(w.f.state.merges).toEqual([
      { number: 1, sha: 'sha1', title: 'Issue 1', message: 'Closes #1' },
    ]);
    expect(item(id)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('at most one merge per zone per pass', async () => {
    const a = w.prItem(1, 'sha1');
    const b = w.prItem(2, 'sha2');
    approve(a, 'sha1');
    approve(b, 'sha2');
    expect((await pass()).merges).toBe(1);
    expect((await pass()).merges).toBe(1);
    expect(w.f.state.merges).toHaveLength(2);
  });

  test('merge rejected parks without a second merge call', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.author.failNext('merge', { status: 405 });
    await pass();
    await pass();
    expect(calls('merge')).toHaveLength(1);
    expect(item(id)).toMatchObject({
      state: 'parked',
      reason: expect.stringMatching(/^merge rejected/),
    });
  });

  test('a thrown branchSha read does not park agent branch deleted', async () => {
    const id = w.prItem(1, 'sha1');
    w.f.author.failNext('branchSha', 'throw');
    await pass();
    expect(item(id).state).toBe('pr_open');
  });

  test('an unposted verdict re-runs its review op', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1', false);
    await pass();
    expect(w.f.state.reviews.map((r) => r.commitId)).toEqual(['sha1']);
    expect(getOutbox(w.db, `review:${id}:sha1:rev-${id}-sha1`)?.state).toBe('done');
  });

  test('charge and drop insert are one transaction', async () => {
    const id = w.prItem(1, 'sha1');
    insertDrop(w.db, {
      id: 'busy',
      dropZoneId: 'main',
      workItemId: id,
      role: 'heal',
      state: 'succeeded',
    });
    // Simulate a concurrent active drop appearing between snapshot and insert by occupying the
    // one_active_drop slot through a queued drop on the same item created after the snapshot.
    const before = getAttempts(w.db, id, 'review').count;
    w.db.exec(`CREATE TRIGGER block_insert BEFORE INSERT ON drops
      WHEN NEW.role = 'review' BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: drops'); END`);
    await pass();
    expect(getAttempts(w.db, id, 'review').count).toBe(before);
    expect(activeDropFor(w.db, id)).toBeUndefined();
  });

  test('an exhausted budget parks the item', async () => {
    const id = w.prItem(1, 'sha1');
    setAttempts(w.db, id, 'review', 2, 'x');
    await pass();
    await pass();
    // the first pass reviews (new fingerprint resets to 1); force exhaustion on the same fingerprint
    setAttempts(w.db, id, 'review', 2, getAttempts(w.db, id, 'review').lastFingerprint);
    w.db.exec(`UPDATE drops SET state = 'succeeded'`);
    await pass();
    expect(item(id)).toMatchObject({ state: 'parked', reason: 'budget exhausted: review' });
  });
});

describe('reconcileZone — adoption and resume', () => {
  test('adoption uses one listing call per pass and adopts the author bot PR', async () => {
    const id = w.item(1, 'ready');
    w.f.state.addPull({ number: 9, headRef: 'agent/issue-1', headSha: 's9', author: 'author-bot' });
    await pass();
    expect(calls('listOpenAgentPulls')).toHaveLength(1);
    expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
  });

  test('adoption ignores PRs from other authors', async () => {
    const id = w.item(1, 'ready');
    w.f.state.addPull({ number: 9, headRef: 'agent/issue-1', headSha: 's9', author: 'mallory' });
    await pass();
    expect(item(id).state).not.toBe('pr_open');
  });

  test('a ready item with an existing branch resumes with resumeSha', async () => {
    const id = w.item(1, 'ready');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    await pass();
    expect(activeDropFor(w.db, id)).toMatchObject({
      role: 'implement',
      headSha: 'wip1',
      chargedKey: 'resume',
    });
    expect(getAttempts(w.db, id, 'resume').count).toBe(1);
  });

  test('an in_flight item with no drop and no PR resumes', async () => {
    const id = w.item(1, 'in_flight');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    await pass();
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'implement', headSha: 'wip1' });
  });

  test('an in_flight item with no drop, no PR and no branch returns to ready', async () => {
    const id = w.item(1, 'in_flight');
    w.zone.gates = [];
    // nothing else is ready, so enqueueNext then picks it up as fresh work
    await pass();
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'implement', headSha: null });
  });

  test('a dead in_flight item whose create_pr failed reopens its PR on resume', async () => {
    const id = w.item(1, 'in_flight');
    w.f.state.branches.set('agent/issue-1', 'sha1');
    insertOutbox(w.db, {
      id: 'o1',
      opKey: `pr:${id}:sha1`,
      kind: 'create_pr',
      workItemId: id,
      payloadJson: '{}',
      state: 'pending',
      createdAt: t.toISOString(),
    });
    updateOutbox(w.db, `pr:${id}:sha1`, { state: 'failed', error: 'boom' }, t);
    await pass();
    expect(getOutbox(w.db, `pr:${id}:sha1`)).toBeUndefined();
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'implement', headSha: 'sha1' });
  });

  test('resume respects the one-implement-per-zone cap', async () => {
    const a = w.item(1, 'ready');
    const b = w.item(2, 'ready');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    w.f.state.branches.set('agent/issue-2', 'wip2');
    await pass();
    const active = [activeDropFor(w.db, a), activeDropFor(w.db, b)].filter(Boolean);
    expect(active).toHaveLength(1);
    // the refused resume charged nothing
    expect(getAttempts(w.db, a, 'resume').count + getAttempts(w.db, b, 'resume').count).toBe(1);
  });

  test('an exhausted resume budget parks the item', async () => {
    const id = w.item(1, 'ready');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    setAttempts(w.db, id, 'resume', 2, null);
    await pass();
    expect(item(id)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
  });
});
