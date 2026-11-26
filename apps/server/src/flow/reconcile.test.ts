import { beforeEach, describe, expect, test } from 'vitest';
import { listBriefings, ruleBriefing, syncParkBriefings } from '../briefings.js';
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
  updateDrop,
  updateOutbox,
} from '../db/repo.js';
import { expireLeases } from '../leases.js';
import { opKeys, opMarker } from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { usageCfg, zoneWorld } from '../test/fixtures.js';
import {
  arbiterHarness,
  type Harness,
  harness,
  headN,
  ruling,
  toHealsExhausted,
  toPrOpen,
} from '../test/flowHarness.js';
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

describe('a dropped merge is sent again only on a fresh merge decision (#932)', () => {
  const at = (minutes: number) => new Date(t.getTime() + minutes * 60_000);
  const key = (id: number) => opKeys.merge(id, 'sha1');

  /** An approved, green item whose merge connection drops: the row is `unknown`, PR not merged. */
  async function dropped(): Promise<number> {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.author.failNext('merge', 'throw');
    await pass();
    expect(calls('merge')).toHaveLength(1);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'unknown', resends: 0 });
    expect(item(id).state).toBe('pr_open');
    return id;
  }

  test('nothing changed: sent again 2 minutes later, and the item is done', async () => {
    const id = await dropped();
    await pass(at(1));
    expect(calls('merge')).toHaveLength(1);
    await pass(at(2));
    expect(calls('merge')).toHaveLength(2);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'done', resends: 1 });
    expect(w.f.state.merges).toHaveLength(1);
    expect(item(id)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test.each<[string, () => void, (id: number) => void]>([
    [
      'a trusted CHANGES_REQUESTED review on the head',
      () => {
        w.f.state.review({ id: 5, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
      },
      (id) => expect(activeDropFor(w.db, id)).toMatchObject({ role: 'heal', headSha: 'sha1' }),
    ],
    [
      'a failed check on the head',
      () => {
        w.f.state.checks.set('sha1', {
          state: 'failure',
          names: ['ci'],
          failed: [{ name: 'ci', conclusion: 'failure' }],
        });
      },
      (id) => expect(activeDropFor(w.db, id)).toMatchObject({ role: 'heal', headSha: 'sha1' }),
    ],
    [
      'the issue closed',
      () => w.f.state.closeIssue(1),
      (id) => expect(item(id)).toMatchObject({ state: 'parked', reason: 'issue closed' }),
    ],
    [
      'a standing human block',
      () => {
        w.f.state.review({ id: 6, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
      },
      (id) => expect(item(id)).toMatchObject({ state: 'parked', reason: 'human block stands' }),
    ],
  ])('%s: not sent again, resends stay 0', async (_name, change, then) => {
    const id = await dropped();
    change();
    await pass(at(2));
    await pass(at(4));
    expect(calls('merge')).toHaveLength(1);
    expect(w.f.state.merges).toEqual([]);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'unknown', resends: 0 });
    then(id);
  });

  test('the merge reservation held by another item: not sent again, resends stay 0', async () => {
    w.zone = { ...w.zone, mergeReservationMinutes: 30 };
    const id = await dropped();
    // Item 2, approved before item 1 and waiting on its CI, holds the reservation now.
    const other = w.prItem(2, 'sha2');
    w.f.state.checks.set('sha2', { state: 'pending', names: [] });
    insertVerdict(w.db, {
      id: 'rev-older',
      workItemId: other,
      headSha: 'sha2',
      decision: 'approve',
      forced: false,
      summary: 'ok',
      findingsJson: '[]',
      gatesJson: '[]',
      createdAt: at(-1).toISOString(),
    });
    await pass(at(2));
    expect(calls('merge')).toHaveLength(1);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'unknown', resends: 0 });
    expect(item(id)).toMatchObject({ state: 'pr_open', reason: 'waiting to merge after #2' });
  });

  test('a forge read that fails while deciding again: no send, resends unchanged', async () => {
    const id = await dropped();
    w.f.author.failNext('listReviews', 'throw');
    await pass(at(2));
    expect(calls('merge')).toHaveLength(1);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'unknown', resends: 0 });
    expect(item(id).state).toBe('pr_open');
    // The read comes back: the decision is merge again, and it is sent.
    await pass(at(3));
    expect(calls('merge')).toHaveLength(2);
    expect(item(id)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('the cap of 3 resends and the 2-minute gap apply, then the row fails at its deadline', async () => {
    const id = await dropped();
    for (let i = 0; i < 10; i++) w.f.author.failNext('merge', 'throw');
    await pass(at(1));
    expect(calls('merge')).toHaveLength(1);
    await pass(at(2));
    expect(calls('merge')).toHaveLength(2);
    await pass(at(3));
    expect(calls('merge')).toHaveLength(2);
    for (let m = 4; m <= 44; m++) await pass(at(m));
    expect(calls('merge')).toHaveLength(4);
    expect(getOutbox(w.db, key(id))).toMatchObject({ state: 'unknown', resends: 3 });
    expect(item(id).state).toBe('pr_open');
    await pass(at(46));
    expect(calls('merge')).toHaveLength(4);
    expect(getOutbox(w.db, key(id))?.state).toBe('failed');
    expect(item(id)).toMatchObject({
      state: 'parked',
      reason: expect.stringMatching(/^merge rejected/),
    });
  });
});

describe('reconcileZone — starter identity', () => {
  beforeEach(() => {
    w = zoneWorld({ identity: 'starter' });
  });

  test('starter merges on an approve verdict at head with green CI and posts no review', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1', false);
    const r = await pass();
    expect(r.merges).toBe(1);
    expect(w.f.state.merges).toEqual([
      { number: 1, sha: 'sha1', title: 'Issue 1', message: 'Closes #1' },
    ]);
    expect(w.f.state.reviews).toEqual([]);
    expect(w.f.reviewer.calls).toEqual([]);
    expect(getOutbox(w.db, `review:${id}:sha1:rev-${id}-sha1`)).toBeUndefined();
    expect(item(id)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('the verdict stays stored for the UI', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1', false);
    await pass();
    const v = w.db
      .prepare('SELECT decision, head_sha AS headSha FROM verdicts WHERE work_item_id = ?')
      .all(id);
    expect(v).toEqual([{ decision: 'approve', headSha: 'sha1' }]);
  });

  test('starter waits for CI: an approve verdict with CI pending does not merge', async () => {
    const id = w.prItem(1, 'sha1');
    w.f.state.checks.set('sha1', { state: 'pending', names: [] });
    approve(id, 'sha1', false);
    await pass(new Date('2026-01-01T00:10:00Z')); // inside the CI deadline
    expect(w.f.state.merges).toEqual([]);
    expect(item(id).state).toBe('pr_open');
  });

  test('starter never merges while a human CHANGES_REQUESTED is on the head', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1', false);
    w.f.state.review({ id: 5, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha1' });
    await pass();
    expect(w.f.state.merges).toEqual([]);
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'heal' });
  });

  test('starter never merges on a verdict for an older SHA', async () => {
    const id = w.prItem(1, 'sha2');
    approve(id, 'sha1', false);
    await pass();
    expect(w.f.state.merges).toEqual([]);
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'review', headSha: 'sha2' });
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

    describe('authorLoginAliases (issue #284)', () => {
      const aliased = (zone: Parameters<typeof zoneWorld>[0] = {}) =>
        zoneWorld({ authorLoginAliases: ['old-bot'], ...zone });

      test('a listed PR by an alias is adopted', async () => {
        w = aliased({ adoptPulls: [9] });
        const id = w.item(1, 'ready');
        w.f.state.addPull(pull({ author: 'old-bot' }));
        await pass();
        expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
        expect(refusals(w)).toEqual([]);
      });

      test('a marked, unlisted PR by an alias is adopted', async () => {
        w = aliased();
        const id = w.item(1, 'ready');
        w.f.state.addPull(
          pull({ author: 'old-bot', body: `work\n${opMarker(opKeys.pr(id, 's9'))}` }),
        );
        await pass();
        expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
      });

      test('an unlisted, unmarked PR by an alias is not adopted', async () => {
        w = aliased();
        const id = w.item(1, 'ready');
        w.f.state.addPull(pull({ author: 'old-bot' }));
        await pass();
        expect(item(id)).toMatchObject({
          state: 'parked',
          reason: 'hand-opened PR on agent branch: #9',
        });
      });

      test('a listed PR by a stranger is refused with the same detail', async () => {
        w = aliased({ adoptPulls: [9] });
        const id = w.item(1, 'ready');
        w.f.state.addPull(pull({ author: 'mallory' }));
        await pass();
        expect(item(id).state).not.toBe('pr_open');
        expect(refusals(w).map((o) => o.detail)).toEqual([
          '#9 is authored by mallory, not the author account',
        ]);
      });

      test('logins compare case-insensitively, for the author and for an alias', async () => {
        w = zoneWorld({ authorLoginAliases: ['Old-Bot'], adoptPulls: [9, 10] });
        const a = w.item(1, 'ready');
        const b = w.item(2, 'ready');
        w.f.state.addPull(pull({ author: 'OLD-bot' }));
        w.f.state.addPull(pull({ number: 10, headRef: 'agent/issue-2', author: 'Author-Bot' }));
        await pass();
        expect(item(a)).toMatchObject({ state: 'pr_open', prNumber: 9 });
        expect(item(b)).toMatchObject({ state: 'pr_open', prNumber: 10 });
      });

      test("resume's vouched check accepts a listed PR by an alias", async () => {
        // A PR with no head yet isn't adopted, so resume meets it as foreign.
        for (const author of ['old-bot', 'mallory']) {
          w = aliased({ adoptPulls: [9] });
          const id = w.item(1, 'in_flight');
          w.f.state.addPull(pull({ author, headSha: null }));
          w.f.state.branches.set('agent/issue-1', 'wip1');
          await pass();
          if (author === 'old-bot')
            expect(activeDropFor(w.db, id)).toMatchObject({ role: 'implement', headSha: 'wip1' });
          else
            expect(item(id)).toMatchObject({
              state: 'parked',
              reason: 'hand-opened PR on agent branch: #9',
            });
        }
      });
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

  test('reconcile adopts no branch during the reclaim window', async () => {
    const id = w.item(1, 'in_flight');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    w.f.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 'wip1',
      author: 'author-bot',
      body: `work\n${opMarker(opKeys.pr(id, 'wip1'))}`,
    });
    // Lost a minute ago after it had run: its stick may still salvage it.
    insertDrop(w.db, {
      id: 'lost1',
      dropZoneId: 'main',
      workItemId: id,
      role: 'implement',
      state: 'queued',
    });
    updateDrop(w.db, 'lost1', {
      state: 'lost',
      runningAt: new Date(t.getTime() - 30 * 60_000).toISOString(),
      finishedAt: new Date(t.getTime() - 60_000).toISOString(),
    });
    await pass();
    expect(item(id).state).toBe('in_flight');
    expect(activeDropFor(w.db, id)).toBeUndefined();
    expect(getAttempts(w.db, id, 'resume').count).toBe(0);
    // The window has passed: the branch's PR is adopted as today.
    await pass(new Date(t.getTime() + 15 * 60_000));
    expect(item(id)).toMatchObject({ state: 'pr_open', prNumber: 9 });
  });

  test('reconcile resumes no branch during the reclaim window', async () => {
    const id = w.item(1, 'in_flight');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    insertDrop(w.db, {
      id: 'lost1',
      dropZoneId: 'main',
      workItemId: id,
      role: 'implement',
      state: 'queued',
    });
    updateDrop(w.db, 'lost1', {
      state: 'lost',
      runningAt: new Date(t.getTime() - 30 * 60_000).toISOString(),
      finishedAt: new Date(t.getTime() - 60_000).toISOString(),
    });
    await pass();
    expect(activeDropFor(w.db, id)).toBeUndefined();
    await pass(new Date(t.getTime() + 15 * 60_000));
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'implement', headSha: 'wip1' });
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

  /** Item 1 in flight with a pending push of `wip1` whose retention ran out a minute before `t`. */
  function expiredPush(): number {
    const id = w.item(1, 'in_flight');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    insertDrop(w.db, {
      id: 'p1',
      dropZoneId: 'main',
      workItemId: id,
      role: 'implement',
      state: 'queued',
    });
    updateDrop(w.db, 'p1', {
      state: 'push_pending',
      headSha: 'wip1',
      fingerprint: 'fp',
      pushKind: 'final',
      pushDeadline: new Date(t.getTime() - 60_000).toISOString(),
      runningAt: new Date(t.getTime() - 2 * 3_600_000).toISOString(),
      finishedAt: new Date(t.getTime() - 3_600_000).toISOString(),
    });
    expireLeases(w.db, t);
    return id;
  }

  test('retention expiry resumes from the branch through the charged resume', async () => {
    const id = expiredPush();
    await pass();
    expect(activeDropFor(w.db, id)).toMatchObject({
      role: 'implement',
      headSha: 'wip1',
      chargedKey: 'resume',
    });
    expect(getAttempts(w.db, id, 'resume').count).toBe(1);
  });

  test('retention expiry with an exhausted resume budget parks the item', async () => {
    const id = expiredPush();
    setAttempts(w.db, id, 'resume', 2, null);
    await pass();
    expect(item(id)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
    expect(activeDropFor(w.db, id)).toBeUndefined();
  });

  test('an exhausted resume budget parks the item', async () => {
    const id = w.item(1, 'ready');
    w.f.state.branches.set('agent/issue-1', 'wip1');
    setAttempts(w.db, id, 'resume', 2, null);
    await pass();
    expect(item(id)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
  });
});

describe('maxOpenPrs (issue #291)', () => {
  test('at the cap no implement drop starts, while resolve and heal drops still run', async () => {
    w = zoneWorld({ maxOpenPrs: 2 });
    const behind = w.prItem(1, 'sha1');
    w.f.state.compares.set('main...sha1', {
      aheadBy: 1,
      behindBy: 1,
      baseSha: 'base1',
      mergeBaseSha: 'base0',
    });
    const blocked = w.prItem(2, 'sha2');
    insertVerdict(w.db, {
      id: 'rc-2',
      workItemId: blocked,
      headSha: 'sha2',
      decision: 'request_changes',
      forced: false,
      summary: 'fix it',
      findingsJson: '[]',
      gatesJson: '[]',
      createdAt: t.toISOString(),
    });
    const ready = w.item(3);
    await pass();
    expect(activeDropFor(w.db, behind)).toMatchObject({ role: 'resolve' });
    expect(activeDropFor(w.db, blocked)).toMatchObject({ role: 'heal' });
    expect(activeDropFor(w.db, ready)).toBeUndefined();
    expect(item(ready).state).toBe('ready');
  });

  test('below the cap the ready item starts', async () => {
    w = zoneWorld({ maxOpenPrs: 2 });
    w.prItem(1, 'sha1');
    const ready = w.item(3);
    await pass();
    expect(activeDropFor(w.db, ready)).toMatchObject({ role: 'implement' });
  });
});

describe('after an arbiter ruled for the author (#383)', () => {
  /** Issue 1 parked on review heals, ruled B by the arbiter on Fable, and retried by the next pass. */
  async function retriedForAuthor(): Promise<Harness> {
    const h = await arbiterHarness({ zone: { ciRequired: true } });
    await toHealsExhausted(h);
    await h.reconcile(); // queues the arbitrate drop
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('arbitrate');
    await h.postResult(dropId, epoch, { status: 'completed', gates: [], crew: ruling('B') });
    await h.reconcile(); // applies the ruling: Command's Retry
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['review']);
    return h;
  }
  const merged = (h: Harness) => h.forge.state.merges.length;
  const ciGreen = { state: 'success' as const, names: ['ci'] };

  test('a fresh review that requests changes leads to a heal, never to a merge', async () => {
    const h = await retriedForAuthor();
    h.forge.state.checks.set(headN(4), ciGreen);
    await h.finishDrop('review', {
      status: 'completed',
      gates: [],
      verdict: { decision: 'request_changes', summary: 'still no', findings: [] },
    });
    for (let i = 0; i < 3; i++) await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    expect(merged(h)).toBe(0);
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
  });

  test('with an approve, the item merges only once CI is green', async () => {
    const h = await retriedForAuthor();
    h.forge.state.checks.set(headN(4), { state: 'pending', names: ['ci'] });
    await h.finishDrop('review', {
      status: 'completed',
      gates: [],
      verdict: { decision: 'approve', summary: 'ok', findings: [] },
    });
    for (let i = 0; i < 4; i++) await h.reconcile();
    expect(merged(h)).toBe(0);
    h.forge.state.checks.set(headN(4), ciGreen);
    for (let i = 0; i < 3 && merged(h) === 0; i++) await h.reconcile();
    expect(h.forge.state.merges.map((m) => m.sha)).toEqual([headN(4)]);
    expect(getWorkItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' });
  });
});

describe('a retried implement drop carries the previous failure (#395)', () => {
  test('implement fails the test gate, parks; Retry; the next implement prompt holds the tail', async () => {
    const h = await harness();
    await h.reconcile();
    const tail = '\u001b[31m FAIL \u001b[39m scripts/no-token-literals.test.ts > no literal\nexit';
    await h.finishDrop('implement', {
      status: 'failed',
      reason: 'gate test failed',
      gates: [{ name: 'test', exitCode: 1, durationMs: 5, timedOut: false, outputTail: tail }],
    });
    await h.reconcile();
    expect(h.db.prepare('SELECT state FROM work_items WHERE id = 1').get()).toEqual({
      state: 'parked',
    });
    const b = listBriefings(h.db, { zoneId: 'main', state: 'open' }).find(
      (x) => x.kind === 'parked',
    );
    if (!b) throw new Error('no parked briefing');
    const retry = b.options.find((o) => o.effect === 'retry_item');
    if (!retry) throw new Error('no Retry option');
    expect(ruleBriefing(h.db, b.id, retry.id, '', h.now()).ok).toBe(true);
    await h.reconcile();
    const { payload } = await h.lease();
    expect(payload.role).toBe('implement');
    expect(payload.prompt).toContain('## Previous attempt (data, untrusted)');
    expect(payload.prompt).toContain(
      'The previous attempt on this issue failed the test gate (exit 1).',
    );
    expect(payload.prompt).toContain(' FAIL  scripts/no-token-literals.test.ts > no literal');
    expect(payload.prompt).not.toContain('\u001b');
  });
});

describe('a CodeQL failure heals with its code-scanning alerts (#652)', () => {
  test('the heal drop stores codeScanning beside feedback in input_json', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.state.checks.set('sha1', {
      state: 'failure',
      names: ['CodeQL', 'ci'],
      failed: [
        { name: 'CodeQL', conclusion: 'failure', checkRunId: 77, app: 'github-advanced-security' },
      ],
    });
    const alert = {
      path: 'apps/server/src/api/sticks.ts',
      startLine: 460,
      level: 'failure',
      title: 'Missing rate limiting',
      message: 'This route handler performs authorization, but is not rate-limited.',
    };
    w.f.state.annotations.set(77, [alert]);
    await pass();
    const drop = activeDropFor(w.db, id);
    expect(drop).toMatchObject({ role: 'heal' });
    expect(JSON.parse(drop?.inputJson ?? '{}')).toEqual({
      feedback: {
        source: 'ci',
        text: 'CI failed on sha1; reproduce with the gates and fix.\n- CodeQL: failure',
      },
      codeScanning: [{ check: 'CodeQL', annotations: [alert] }],
    });
  });

  test('a heal without code-scanning alerts stores feedback alone, as before', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.state.checks.set('sha1', {
      state: 'failure',
      names: ['ci'],
      failed: [{ name: 'ci', conclusion: 'failure', checkRunId: 78, app: 'github-actions' }],
    });
    await pass();
    const drop = activeDropFor(w.db, id);
    // No annotations on the Actions run (#720): feedback alone.
    expect(Object.keys(JSON.parse(drop?.inputJson ?? '{}'))).toEqual(['feedback']);
  });
});

describe('an Actions failure heals with its failure annotations (#720)', () => {
  const failing = {
    path: 'apps/trooper/src/git.test.ts',
    startLine: 300,
    level: 'failure',
    title: 'scrubs the environment',
    message: "AssertionError: expected '{\"GITHUB_STATE\":…' not to contain 'github.com'",
  };
  const exit = { ...failing, message: 'Process completed with exit code 1.' };

  test('the heal drop stores ciAnnotations beside feedback in input_json, raw', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.state.checks.set('sha1', {
      state: 'failure',
      names: ['ci'],
      failed: [{ name: 'ci', conclusion: 'failure', checkRunId: 78, app: 'github-actions' }],
    });
    w.f.state.annotations.set(78, [failing, exit]);
    await pass();
    const drop = activeDropFor(w.db, id);
    expect(drop).toMatchObject({ role: 'heal' });
    expect(JSON.parse(drop?.inputJson ?? '{}')).toEqual({
      feedback: {
        source: 'ci',
        text: 'CI failed on sha1; reproduce with the gates and fix.\n- ci: failure',
      },
      ciAnnotations: [{ check: 'ci', annotations: [failing] }],
    });
  });

  test('a read that errors: feedback alone, as before, and no park', async () => {
    const id = w.prItem(1, 'sha1');
    approve(id, 'sha1');
    w.f.state.checks.set('sha1', {
      state: 'failure',
      names: ['ci'],
      failed: [{ name: 'ci', conclusion: 'failure', checkRunId: 78, app: 'github-actions' }],
    });
    w.f.state.annotations.set(78, [failing]);
    w.f.author.failNext('checkAnnotations', { status: 500 });
    await pass();
    const drop = activeDropFor(w.db, id);
    expect(drop).toMatchObject({ role: 'heal' });
    expect(Object.keys(JSON.parse(drop?.inputJson ?? '{}'))).toEqual(['feedback']);
  });
});

describe('code scanning flags the same alerts after a heal: park, not another heal (#653)', () => {
  const gateOk = { name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' };
  const alert = {
    path: 'apps/server/src/api/sticks.ts',
    startLine: 460,
    level: 'failure',
    title: 'Missing rate limiting',
    message: 'This route handler performs authorization, but is not rate-limited.',
  };
  const REASON =
    'code scanning still flags Missing rate limiting at apps/server/src/api/sticks.ts:460 after a heal: fix it with a Retry note, or dismiss the alert in GitHub and re-run the CodeQL check';
  let run = 100;
  /** CodeQL fails on `head` with the rate-limiting alert, as GitHub reports it. */
  function codeqlFails(h: Harness, head: string): void {
    const checkRunId = ++run;
    h.forge.state.checks.set(head, {
      state: 'failure',
      names: ['ci', 'CodeQL'],
      failed: [
        { name: 'CodeQL', conclusion: 'failure', checkRunId, app: 'github-advanced-security' },
      ],
    });
    h.forge.state.annotations.set(checkRunId, [alert]);
  }
  async function review(h: Harness, decision: 'approve' | 'request_changes'): Promise<void> {
    await h.reconcile();
    await h.finishDrop('review', {
      status: 'completed',
      gates: [gateOk],
      verdict: {
        decision,
        summary: decision,
        findings: decision === 'approve' ? [] : [{ severity: 'major', detail: 'tidy' }],
      },
    });
  }
  async function healTo(h: Harness, head: string): Promise<void> {
    for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    await h.finishDrop('heal', { status: 'completed', headSha: head, gates: [gateOk] });
  }
  const healInputs = (h: Harness) =>
    (
      h.db
        .prepare(`SELECT input_json AS j FROM drops WHERE role = 'heal' ORDER BY created_at, rowid`)
        .all() as { j: string }[]
    ).map((r) => JSON.parse(r.j) as { feedback: { source: string } });

  test('a ci heal, a review heal, the same alert again: park; Retry gets exactly one more heal', async () => {
    const h = await harness({ zone: { ciRequired: true } });
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
    await toPrOpen(h, headN(1));
    await review(h, 'approve');
    codeqlFails(h, headN(1));
    await healTo(h, headN(2)); // heal 1: ci, with the alert
    await review(h, 'request_changes');
    await healTo(h, headN(3)); // heal 2: review feedback, in between
    await review(h, 'approve');
    codeqlFails(h, headN(3));
    await h.reconcile();
    expect(getWorkItem(h.db, 1)).toMatchObject({ state: 'parked', reason: REASON });
    expect(healInputs(h).map((i) => i.feedback.source)).toEqual(['ci', 'review']);

    // Command rules Retry with a note: one more heal runs on the same alert.
    syncParkBriefings(h.db, h.zone, h.now());
    h.at(1);
    const b = listBriefings(h.db, { zoneId: 'main', state: 'open' }).find(
      (x) => x.kind === 'parked',
    );
    const retry = b?.options.find((o) => o.effect === 'retry_item');
    if (!b || !retry) throw new Error('no Retry option');
    const note = 'keep the hook; the alert is accepted';
    expect(ruleBriefing(h.db, b.id, retry.id, note, h.now(), { via: 'session' }).ok).toBe(true);
    for (let n = 0; n < 3 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['heal']);
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('heal');
    expect(payload.prompt).toContain(note);
    h.forge.state.setHead(1, headN(4));
    await h.postResult(dropId, epoch, { status: 'completed', headSha: headN(4), gates: [gateOk] });

    // The same alert on the healed head: parked again, no third ci heal.
    await review(h, 'approve');
    codeqlFails(h, headN(4));
    await h.reconcile();
    expect(getWorkItem(h.db, 1)).toMatchObject({ state: 'parked', reason: REASON });
    expect(healInputs(h).map((i) => i.feedback.source)).toEqual(['ci', 'review', 'ci']);
    expect(h.forge.state.merges).toEqual([]);
  });
});
