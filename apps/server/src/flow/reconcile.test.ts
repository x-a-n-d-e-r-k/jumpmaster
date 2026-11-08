import { beforeEach, describe, expect, test } from 'vitest';
import {
  activeDropFor,
  getAttempts,
  getOutbox,
  getWorkItem,
  insertDrop,
  insertOutbox,
  insertVerdict,
  listObservations,
  setAttempts,
  setWorkItemState,
  updateOutbox,
} from '../db/repo.js';
import { opKeys, opMarker } from '../outbox.js';
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
      zoneId: 'main',
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
    w.f.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: 'author-bot',
      body: `work\n${opMarker(opKeys.pr(id, 's9'))}`,
    });
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

  test('adoption ignores a PR the author opened by hand, without the server marker', async () => {
    const id = w.item(1, 'ready');
    w.f.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: 'author-bot',
      body: 'opened by hand',
    });
    await pass();
    expect(item(id).state).not.toBe('pr_open');
  });

  test('a hand-opened PR on the agent branch parks the item instead of resuming', async () => {
    const id = w.item(1, 'ready');
    w.f.state.addPull({ number: 9, headRef: 'agent/issue-1', headSha: 's9', author: 'author-bot' });
    await pass();
    expect(item(id)).toMatchObject({
      state: 'parked',
      reason: 'hand-opened PR on agent branch: #9',
    });
    expect(activeDropFor(w.db, id)).toBeUndefined();
  });

  describe('adoptPulls', () => {
    const listed = (zone: Parameters<typeof zoneWorld>[0] = {}) =>
      zoneWorld({ adoptPulls: [9], ...zone });
    const pull = (over = {}) => ({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: 'author-bot',
      body: 'from the old loop',
      ...over,
    });
    const refusals = (world: ReturnType<typeof zoneWorld>) =>
      listObservations(world.db, world.zone.id).filter((o) => o.action === 'adopt_refused');

    test('a listed PR on an agent branch by the author is adopted without a marker', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull());
      await pass();
      expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
    });

    test('adoption charges nothing, and a review is the next step', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull());
      await pass();
      const row = w.db
        .prepare('SELECT COUNT(*) AS n FROM attempts WHERE work_item_id = ? AND key <> ?')
        .get(id, 'review') as { n: number };
      expect(row.n).toBe(0);
      expect(activeDropFor(w.db, id)?.role).toBe('review');
    });

    test('a listed PR from another author is refused and logged', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull({ author: 'mallory' }));
      await pass();
      expect(item(id).state).not.toBe('pr_open');
      expect(refusals(w)[0]?.detail).toMatch(/#9.*mallory/);
    });

    test('a listed PR from another author is never resumed or taken over', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull({ author: 'mallory' }));
      await pass();
      expect(item(id)).toMatchObject({
        state: 'parked',
        reason: 'hand-opened PR on agent branch: #9',
      });
      expect(activeDropFor(w.db, id)).toBeUndefined();
    });

    test('a listed PR that is not an open agent PR is logged', async () => {
      w = listed();
      w.f.state.addPull(pull({ headRef: 'feature/x' }));
      await pass();
      expect(refusals(w)[0]?.detail).toMatch(/#9 is not an open agent PR/);
    });

    test('a listed PR with no work item is logged, since it needs the ready label', async () => {
      w = listed();
      w.f.state.addPull(pull());
      await pass();
      expect(refusals(w)[0]?.detail).toMatch(/#9.*no work item.*issue #1/);
    });

    test('an unlisted unmarked PR still parks as hand-opened', async () => {
      w = zoneWorld();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull());
      await pass();
      expect(item(id)).toMatchObject({
        state: 'parked',
        reason: 'hand-opened PR on agent branch: #9',
      });
    });

    test('an item already parked as hand-opened for a listed PR is adopted', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      setWorkItemState(w.db, id, 'parked', 'hand-opened PR on agent branch: #9');
      w.f.state.addPull(pull());
      await pass();
      expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
    });

    test('an item parked for another reason is left alone', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      setWorkItemState(w.db, id, 'parked', 'budget exhausted: resume');
      w.f.state.addPull(pull());
      await pass();
      expect(item(id).state).toBe('parked');
    });

    test('adding a number later adopts it on the next pass, so batches work', async () => {
      w = zoneWorld();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull());
      await pass();
      expect(item(id).state).toBe('parked');
      w.zone.adoptPulls = [9];
      await pass();
      expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
    });

    test('a listed PR whose issue closes follows the closed-issue path', async () => {
      w = listed();
      const id = w.item(1, 'ready');
      w.f.state.addPull(pull());
      await pass();
      w.db.exec(`UPDATE drops SET state = 'cancelled'`); // the review it queued has ended
      w.f.state.issues.set(1, { state: 'closed', labels: [] });
      await pass();
      expect(item(id)).toMatchObject({ state: 'parked', reason: 'issue closed' });
    });
  });

  test('maxConcurrentImplement allows N implement drops; one per issue still holds', async () => {
    w = zoneWorld({ maxConcurrentImplement: 2 });
    const [a, b, c] = [w.item(1, 'ready'), w.item(2, 'ready'), w.item(3, 'ready')];
    await pass();
    await pass();
    await pass();
    const active = [a, b, c].map((id) => activeDropFor(w.db, id)).filter(Boolean);
    expect(active).toHaveLength(2);
    expect(new Set(active.map((d) => d?.workItemId)).size).toBe(2);
  });

  test('the default keeps one implement drop per zone', async () => {
    w = zoneWorld();
    const [a, b] = [w.item(1, 'ready'), w.item(2, 'ready')];
    await pass();
    await pass();
    expect([a, b].map((id) => activeDropFor(w.db, id)).filter(Boolean)).toHaveLength(1);
  });

  test('outboxDeadlineMinutes ages unknown ops independently of the CI deadline', async () => {
    w = zoneWorld({ ciDeadlineMinutes: 150, outboxDeadlineMinutes: 30 });
    const id = w.item(1, 'pr_open');
    insertOutbox(w.db, {
      id: 'o1',
      opKey: 'merge:x',
      kind: 'merge',
      workItemId: id,
      zoneId: 'main',
      payloadJson: JSON.stringify({ pr: 404, sha: 's', title: 't', message: 'm' }),
      state: 'unknown',
      createdAt: t.toISOString(),
    });
    await pass(new Date(t.getTime() + 31 * 60_000));
    expect(getOutbox(w.db, 'merge:x')?.state).toBe('failed');
  });

  test("adoption ignores another item's marker", async () => {
    const id = w.item(1, 'ready');
    w.f.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: 'author-bot',
      body: opMarker(opKeys.pr(id + 1, 's9')),
    });
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
      zoneId: 'main',
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
