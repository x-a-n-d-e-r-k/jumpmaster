import type { DropResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import {
  activeDropFor,
  getWorkItem,
  listObservations,
  recordObservation,
  setWorkItemState,
  setZoneMode,
} from '../db/repo.js';
import { opKeys, opMarker, runOp } from '../outbox.js';
import { type Harness, harness, toPrOpen } from '../test/flowHarness.js';

const WRITES = ['findOrCreatePullRequest', 'createReview', 'merge'];
const writes = (h: Harness) =>
  [...h.forge.author.calls, ...h.forge.reviewer.calls].filter((c) => WRITES.includes(c.method));
const seen = (h: Harness) => listObservations(h.db, h.zone.id).map((o) => o.action);

const gateOk = { name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' };
const approved: DropResult = {
  status: 'completed',
  verdict: { decision: 'approve', summary: 'ok', findings: [] },
  gates: [gateOk],
};
const observing = () => harness({ zone: { mode: 'observe' } });
const readyIssue = (n: number) => ({
  number: n,
  title: `Issue ${n}`,
  body: 'b',
  author: 'human',
  labels: ['agent-ready'],
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('native blockers in active mode', () => {
  test('a blocked ready item with an old branch is not resumed', async () => {
    const h = await harness({ issues: [{ ...readyIssue(1), blockedBy: ['#4'] }] });
    h.forge.state.branches.set('agent/issue-1', 'wip1');
    await h.reconcile();
    expect(activeDropFor(h.db, 1)).toBeUndefined();
    expect(getWorkItem(h.db, 1)?.state).toBe('ready');
  });

  test('an in_flight item that gains a blocker still resumes', async () => {
    const one = { ...readyIssue(1), blockedBy: [] as string[] };
    const h = await harness({ zone: { mode: 'paused' }, issues: [one] });
    await h.reconcile(); // paused: the item is synced, nothing starts
    setWorkItemState(h.db, 1, 'in_flight'); // work began before the link was added
    setZoneMode(h.db, h.zone.id, 'active', h.now());
    one.blockedBy = ['#4'];
    h.forge.state.branches.set('agent/issue-1', 'wip1');
    await h.reconcile();
    expect(activeDropFor(h.db, 1)).toMatchObject({ role: 'implement', headSha: 'wip1' });
  });
});

/** A PR opened and reviewed for real, then observed from that state. */
async function reviewedThenObserving(): Promise<Harness> {
  const h = await harness();
  await toPrOpen(h, 'sha1');
  await h.reconcile();
  const { dropId, epoch } = await h.lease();
  setZoneMode(h.db, h.zone.id, 'paused', h.now());
  await h.postResult(dropId, epoch, approved);
  setZoneMode(h.db, h.zone.id, 'observe', h.now());
  return h;
}

describe('observe mode', () => {
  test('observe creates no drop and changes no item state', async () => {
    const h = await observing();
    await h.reconcile();
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    expect(getWorkItem(h.db, 1)?.state).toBe('ready');
    expect(activeDropFor(h.db, 1)).toBeUndefined();
    expect(writes(h)).toEqual([]);
  });

  test('records would_wait for a blocked item and would_enqueue for the next', async () => {
    const h = await harness({
      zone: { mode: 'observe' },
      issues: [
        { ...readyIssue(1), labels: ['agent-ready', 'high'], blockedBy: ['#4'] },
        readyIssue(2),
      ],
    });
    await h.reconcile();
    const obs = listObservations(h.db, h.zone.id).map((o) => [o.action, o.itemId, o.detail]);
    expect(obs).toContainEqual(['would_wait:blocked', 1, 'blocked by #4']);
    expect(obs).toContainEqual(['would_enqueue:implement', 2, 'issue #2']);
    expect(obs.some(([a, id]) => a === 'would_enqueue:implement' && id === 1)).toBe(false);
  });

  test('observe does not record a resume for a blocked ready item with an old branch', async () => {
    const h = await harness({
      zone: { mode: 'observe' },
      issues: [{ ...readyIssue(1), blockedBy: ['#4'] }],
    });
    h.forge.state.branches.set('agent/issue-1', 'oldsha1');
    await h.reconcile();
    expect(seen(h)).toEqual(['would_wait:blocked']);
  });

  test('records one implement pick per free slot, in rank order', async () => {
    const h = await harness({
      zone: { mode: 'observe', maxConcurrentImplement: 2 },
      issues: [readyIssue(1), { ...readyIssue(2), labels: ['agent-ready', 'high'] }, readyIssue(3)],
    });
    await h.reconcile();
    const picks = listObservations(h.db, h.zone.id)
      .filter((o) => o.action === 'would_enqueue:implement')
      .map((o) => o.detail);
    expect(picks.sort()).toEqual(['issue #1', 'issue #2']); // #3 ranks last and gets no slot
  });

  test('a would-be resume takes one of the slots', async () => {
    const h = await harness({
      zone: { mode: 'observe', maxConcurrentImplement: 2 },
      issues: [readyIssue(1), readyIssue(2), readyIssue(3)],
    });
    h.forge.state.branches.set('agent/issue-3', 'oldsha3');
    await h.reconcile();
    const obs = listObservations(h.db, h.zone.id).map((o) => `${o.action} ${o.detail}`);
    expect(obs.filter((o) => o.startsWith('would_enqueue:')).sort()).toEqual([
      'would_enqueue:implement issue #1',
      'would_enqueue:resume branch at oldsha3',
    ]);
  });

  test('observe records what it would do, once per decision, with a count', async () => {
    const h = await observing();
    await h.reconcile();
    await h.reconcile();
    const [o] = listObservations(h.db, h.zone.id);
    expect(o).toMatchObject({ action: 'would_enqueue:implement', itemId: 1, count: 2 });
    expect(listObservations(h.db, h.zone.id)).toHaveLength(1);
  });

  test('a ready item with an old agent branch records would_enqueue:resume with the sha', async () => {
    const h = await observing();
    h.forge.state.branches.set('agent/issue-1', 'oldsha1');
    await h.reconcile();
    const o = listObservations(h.db, h.zone.id).find((x) => x.action === 'would_enqueue:resume');
    expect(o?.detail).toContain('oldsha1');
    expect(h.queuedRoles()).toEqual([]);
    expect(getWorkItem(h.db, 1)?.state).toBe('ready');
    expect(writes(h)).toEqual([]);
  });

  test('observe does not park a hand-opened PR', async () => {
    const h = await observing();
    h.forge.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: h.forge.state.logins.author,
      body: 'by hand',
    });
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('ready');
    expect(seen(h)).toContain('would_park');
  });

  test('an adopted PR records a review it would run, and no write', async () => {
    const h = await observing();
    await h.sync();
    h.forge.state.addPull({
      number: 9,
      headRef: 'agent/issue-1',
      headSha: 's9',
      author: h.forge.state.logins.author,
      body: opMarker(opKeys.pr(1, 's9')),
    });
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
    expect(seen(h)).toContain('would_enqueue:review');
    expect(h.queuedRoles()).toEqual([]);
    expect(writes(h)).toEqual([]);
  });

  test('observe makes no forge write across post, merge, park and done', async () => {
    const h = await reviewedThenObserving();
    const before = writes(h).length;
    await h.reconcile();
    expect(seen(h)).toContain('would_post_review');
    const pull = [...h.forge.state.pulls.values()][0];
    if (!pull) throw new Error('no pull');
    h.forge.state.issues.get(1);
    h.forge.state.markMerged(pull.number);
    await h.reconcile();
    expect(seen(h)).toContain('would_done');
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
    expect(writes(h).length).toBe(before);
  });

  test('a closed issue records would_park and the item stays', async () => {
    const h = await reviewedThenObserving();
    const issue = h.forge.state.issues.get(1);
    if (!issue) throw new Error('no issue');
    issue.state = 'closed';
    await h.reconcile();
    expect(seen(h)).toContain('would_park');
    expect(getWorkItem(h.db, 1)?.state).toBe('pr_open');
  });

  test('runOp refuses in observe before inserting any outbox row', async () => {
    const h = await observing();
    await h.sync();
    await h.reconcile();
    const op = {
      kind: 'merge' as const,
      opKey: 'merge:1:s',
      zoneId: h.zone.id,
      itemId: 1,
      payload: { pr: 1, sha: 's', title: 't', message: 'm' },
    };
    const forges = { author: h.forge.author, reviewer: h.forge.reviewer };
    setZoneMode(h.db, h.zone.id, 'observe', h.now());
    await expect(runOp(h.db, forges, op, h.now())).rejects.toThrow(/observe/);
    const row = h.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number };
    expect(row.n).toBe(0);
    expect(writes(h)).toEqual([]);
  });

  test('a would_enqueue:resume observation is kept with no charge', async () => {
    const h = await observing();
    h.forge.state.branches.set('agent/issue-1', 'oldsha1');
    await h.reconcile();
    const row = h.db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number };
    expect(row.n).toBe(0);
    expect(seen(h)).toContain('would_enqueue:resume');
  });
});

describe('the observations page', () => {
  test('a detail containing markup is escaped', async () => {
    const h = await observing();
    await h.sync();
    recordObservation(h.db, h.zone.id, 1, 'would_park', '<script>x</script>', h.now());
    const res = await h.view('/observations');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).not.toContain('<script>x');
  });
});

describe('pause', () => {
  test('pause starts nothing and posts nothing, and resume continues', async () => {
    const h = await harness();
    await h.sync();
    setZoneMode(h.db, h.zone.id, 'paused', h.now());
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    expect(getWorkItem(h.db, 1)?.state).toBe('ready');
    setZoneMode(h.db, h.zone.id, 'active', h.now());
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['implement']);
  });

  test('a queued drop is not leased while paused or observing', async () => {
    const h = await harness();
    await h.reconcile();
    for (const mode of ['paused', 'observe'] as const) {
      setZoneMode(h.db, h.zone.id, mode, h.now());
      await expect(h.lease()).rejects.toThrow();
    }
    setZoneMode(h.db, h.zone.id, 'active', h.now());
    await expect(h.lease()).resolves.toMatchObject({ payload: { role: 'implement' } });
  });

  test('a review finishing during pause posts after resume, not during', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    setZoneMode(h.db, h.zone.id, 'paused', h.now());
    await h.postResult(dropId, epoch, approved);
    await h.reconcile();
    expect(h.forge.state.reviews).toHaveLength(0);
    setZoneMode(h.db, h.zone.id, 'active', h.now());
    await h.reconcile();
    expect(h.forge.state.reviews.map((r) => r.state)).toEqual(['APPROVED']);
  });
});
