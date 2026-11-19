import { describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  type Briefing,
  listBriefings,
  listRulings,
  syncParkBriefings,
} from './briefings.js';
import { ctlRequest } from './ctl.js';
import { getOutbox, getWorkItem, listWorkItems, setKilled, setZoneMode } from './db/repo.js';
import { type Harness, harness, toHealsExhausted } from './test/flowHarness.js';

const OPERATOR = { authorization: `Bearer ${'o'.repeat(32)}`, host: 'localhost:80' };

const parked = (h: Harness): Briefing | undefined =>
  listBriefings(h.db, { state: 'open' }).find((b) => b.kind === 'parked');

const itemId = (h: Harness): number => {
  const item = listWorkItems(h.db, 'main').find((w) => w.issueNumber === 1);
  if (!item) throw new Error('no item');
  return item.id;
};

/** Rules the item's parked briefing through `ctl rule`, as Command does from a terminal. */
async function ctlRule(h: Harness, effect: string, note?: string): Promise<number> {
  const b = parked(h);
  const option = b?.options.find((o) => o.effect === effect);
  if (!b || !option) throw new Error(`no ${effect} option on an open parked briefing`);
  const r = ctlRequest(['rule', String(b.id), option.id, ...(note ? [note] : [])]);
  const res = await h.app.inject({
    method: 'POST',
    url: r?.path ?? '',
    headers: OPERATOR,
    payload: r?.body as object,
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { rulingId: number }).rulingId;
}

/** The writes of a Close as done, in the order they were recorded. */
const closeOps = (h: Harness) =>
  (
    h.db
      .prepare(
        `SELECT kind, state, payload_json AS payloadJson FROM outbox
           WHERE kind IN ('comment_issue', 'update_issue') ORDER BY rowid`,
      )
      .all() as { kind: string; state: string; payloadJson: string }[]
  ).map((r) => ({ kind: r.kind, state: r.state, payload: JSON.parse(r.payloadJson) }));

const commentsOn = (h: Harness, n: number) => h.forge.state.comments.filter((c) => c.issue === n);

async function parkedHarness(): Promise<Harness> {
  const h = await harness();
  await toHealsExhausted(h);
  expect(getWorkItem(h.db, itemId(h))?.state).toBe('parked');
  expect(parked(h)).toBeDefined();
  return h;
}

describe('Close as done (#535)', () => {
  test('comments, then closes as completed, then finishes the item; no drop runs', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item', 'Delivered by 01e9bc3; see the release notes.');
    await h.reconcile();

    const ops = closeOps(h);
    expect(ops.map((o) => [o.kind, o.state])).toEqual([
      ['comment_issue', 'done'],
      ['update_issue', 'done'],
    ]);
    expect(ops[1]?.payload).toMatchObject({ number: 1, state: 'closed', stateReason: 'completed' });
    const [comment, ...more] = commentsOn(h, 1);
    expect(more).toEqual([]);
    expect(comment?.body).toMatch(/^Closed by Command as already done\.\n\nDelivered by 01e9bc3/);
    expect(h.forge.state.issues.get(1)).toMatchObject({
      state: 'closed',
      stateReason: 'completed',
    });
    expect(getWorkItem(h.db, id)).toMatchObject({
      state: 'done',
      reason: 'closed by Command as done',
    });
    expect(listRulings(h.db, 'main')[0]).toMatchObject({ applyError: null });
    expect(listRulings(h.db, 'main')[0]?.appliedAt).not.toBeNull();
    expect(h.queuedRoles()).toEqual([]);
    expect(h.forge.state.pulls.get(1)?.merged).toBeFalsy();
  });

  test('an item with an open PR: the comment ends "PR #N is still open." with #N intact', async () => {
    const h = await parkedHarness();
    await ctlRule(h, 'close_item', 'see #12 and @someone');
    await h.reconcile();
    const body = commentsOn(h, 1)[0]?.body ?? '';
    const text = body.slice(0, body.lastIndexOf('\n\n<!-- jm:comment:'));
    expect(text.endsWith('\n\nPR #1 is still open.')).toBe(true);
    // The note itself is sanitized: its references and mentions are broken.
    expect(text).not.toContain('see #12');
    expect(text).not.toContain('@someone');
  });

  test('applied twice, the first pass failing after the comment: one comment and one close (D3)', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    h.forge.author.failNext('updateIssue', 'throw');
    await h.reconcile();
    // The comment is done, the close is not: the item is not done.
    expect(closeOps(h).map((o) => [o.kind, o.state])).toEqual([
      ['comment_issue', 'done'],
      ['update_issue', 'unknown'],
    ]);
    expect(getWorkItem(h.db, id)?.state).toBe('parked');
    expect(h.forge.state.issues.get(1)?.state).toBe('open');
    expect(listRulings(h.db, 'main')[0]).toMatchObject({ appliedAt: null, applyError: null });

    h.at(1);
    await h.reconcile();
    expect(commentsOn(h, 1)).toHaveLength(1);
    expect(h.forge.state.issues.get(1)).toMatchObject({ state: 'closed' });
    expect(getWorkItem(h.db, id)?.state).toBe('done');
    expect(closeOps(h).map((o) => o.kind)).toEqual(['comment_issue', 'update_issue']);
  });

  test('a close whose answer was lost is read back, never sent twice', async () => {
    const h = await parkedHarness();
    await ctlRule(h, 'close_item');
    h.forge.author.failNext('updateIssue', '5xx-after-success');
    let closes = 0;
    const update = h.forge.author.updateIssue.bind(h.forge.author);
    h.forge.author.updateIssue = async (...a: Parameters<typeof update>) => {
      closes++;
      return update(...a);
    };
    await h.reconcile();
    h.at(1);
    await h.reconcile();
    expect(closes).toBe(1);
    expect(getWorkItem(h.db, itemId(h))?.state).toBe('done');
  });

  test('an item no longer parked: nothing is written', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    h.db.prepare(`UPDATE work_items SET state = 'pr_open' WHERE id = ?`).run(id);
    const deps = { forges: () => h.forges, zone: () => h.zone };
    expect(await applyPendingRulings(h.db, deps, 'main', h.now())).toBe(1);
    expect(closeOps(h)).toEqual([]);
    expect(commentsOn(h, 1)).toEqual([]);
    expect(getWorkItem(h.db, id)?.state).toBe('pr_open');
  });

  test('an item of another zone: nothing is written', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    const deps = { forges: () => h.forges, zone: () => h.zone };
    // The ruling is applied as if it were another zone's: the item is left alone.
    h.db.prepare(`UPDATE rulings SET zone_id = 'other'`).run();
    expect(await applyPendingRulings(h.db, deps, 'other', h.now())).toBe(1);
    expect(closeOps(h)).toEqual([]);
    expect(getWorkItem(h.db, id)?.state).toBe('parked');
  });

  test('the close throws: the effect returns false and the item stays parked; the next pass completes it (D2)', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    const deps = { forges: () => h.forges, zone: () => h.zone };
    h.forge.author.failNext('updateIssue', { status: 500 });
    expect(await applyPendingRulings(h.db, deps, 'main', h.now())).toBe(0);
    expect(getWorkItem(h.db, id)?.state).toBe('parked');
    expect(listRulings(h.db, 'main')[0]).toMatchObject({ appliedAt: null, applyError: null });
    expect(await applyPendingRulings(h.db, deps, 'main', h.at(1))).toBe(1);
    expect(getWorkItem(h.db, id)?.state).toBe('done');
    expect(h.forge.state.issues.get(1)?.state).toBe('closed');
  });

  test('kill switch on, or observe mode: nothing is written and the item stays parked; it applies once off', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    const deps = { forges: () => h.forges, zone: () => h.zone };
    setKilled(h.db, true, h.now());
    await h.reconcile();
    expect(await applyPendingRulings(h.db, deps, 'main', h.now())).toBe(0);
    setKilled(h.db, false, h.now());
    setZoneMode(h.db, 'main', 'observe', h.now());
    expect(await applyPendingRulings(h.db, deps, 'main', h.now())).toBe(0);
    expect(closeOps(h)).toEqual([]);
    expect(commentsOn(h, 1)).toEqual([]);
    expect(getWorkItem(h.db, id)?.state).toBe('parked');
    // Refusals are not failures: they never use up the attempts.
    for (let i = 0; i < 12; i++) await applyPendingRulings(h.db, deps, 'main', h.now());
    expect(listRulings(h.db, 'main')[0]).toMatchObject({ applyError: null });

    setZoneMode(h.db, 'main', 'active', h.now());
    await h.reconcile();
    expect(getWorkItem(h.db, id)?.state).toBe('done');
    expect(commentsOn(h, 1)).toHaveLength(1);
  });

  test('after the attempt cap the item stays parked and its briefing is raised again with the error', async () => {
    const h = await parkedHarness();
    const id = itemId(h);
    await ctlRule(h, 'close_item');
    const deps = { forges: () => h.forges, zone: () => h.zone };
    for (let i = 0; i < 12; i++) h.forge.author.failNext('updateIssue', { status: 403 });
    for (let i = 0; i < 12; i++) await applyPendingRulings(h.db, deps, 'main', h.at(1));
    const r = listRulings(h.db, 'main')[0];
    expect(r?.appliedAt).toBeNull();
    expect(r?.applyError).toMatch(/^close as done failed: .*403/);
    expect(getWorkItem(h.db, id)?.state).toBe('parked');
    expect(h.forge.state.issues.get(1)?.state).toBe('open');

    syncParkBriefings(h.db, h.zone, h.at(1));
    const again = parked(h);
    expect(again).toBeDefined();
    expect(again?.why).toMatch(/^Close as done failed: .*403/);
    expect(again?.options.map((o) => o.effect)).toEqual(['retry_item', 'close_item', 'none']);
  });
});
