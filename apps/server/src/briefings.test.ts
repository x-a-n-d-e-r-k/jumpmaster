import { describe, expect, test } from 'vitest';
import {
  applyEffect,
  applyPendingRulings,
  type BriefingOption,
  dismissZoneBriefings,
  listBriefings,
  listRulings,
  raiseBriefing,
  ruleBriefing,
  syncParkBriefings,
} from './briefings.js';
import { applyCrewActions } from './crew/actions.js';
import { flushCrewOps } from './crew/flush.js';
import { getCrewIssue, insertCrewIssue, setCrewIssue } from './crew/store.js';
import {
  getAttempts,
  getWorkItem,
  insertOutbox,
  listOutbox,
  setAttempts,
  setWorkItemState,
} from './db/repo.js';
import { zonePass } from './flow/snapshot.js';
import { objectivesDone } from './goals.js';
import { syncParked } from './sync.js';
import { crewWorld } from './test/crew.js';
import { makeZone, type ZoneWorld, zoneWorld } from './test/fixtures.js';
import { plus, t0 } from './test/helpers.js';

const MIN = 60_000;
const crewOn = { ...makeZone({}).crew, enabled: true };

function parkedWorld(): { w: ZoneWorld; id: number } {
  const w = zoneWorld({ crew: crewOn });
  const id = w.prItem(1, 'sha1');
  setAttempts(w.db, id, 'heal', 3, 'fp');
  insertOutbox(w.db, {
    id: 'o1',
    opKey: 'merge:1:sha1',
    kind: 'merge',
    workItemId: id,
    zoneId: 'main',
    payloadJson: '{}',
    state: 'failed',
    createdAt: t0.toISOString(),
  });
  setWorkItemState(w.db, id, 'parked', 'heal budget exhausted', t0);
  return { w, id };
}

const deps = (w: ZoneWorld) => ({ forges: () => w.forges, zone: () => w.zone });
const open = (w: ZoneWorld) => listBriefings(w.db, { zoneId: 'main', state: 'open' });
const optionOf = (b: { options: BriefingOption[] }, effect: string) =>
  b.options.find((o) => o.effect === effect)?.id ?? 'missing';

describe('raising a briefing', () => {
  test('a crew briefing raised again takes the crew recommendation and has no diagnosis', () => {
    const w = zoneWorld({ crew: crewOn });
    const crew = (recommendation: string) => ({
      zoneId: 'main',
      kind: 'crew' as const,
      subject: 'crew:split',
      decision: 'Split?',
      why: 'Two parts.',
      options: [{ id: 'yes', label: 'Yes', effect: 'none' as const }],
      recommendation,
      source: 'crew' as const,
    });
    raiseBriefing(w.db, crew('Split it'), t0);
    raiseBriefing(w.db, crew('Keep it'), plus(t0, MIN));
    expect(open(w)).toMatchObject([{ recommendation: 'Keep it', diagnosis: null }]);
  });
});

describe('parked briefings', () => {
  test('a newly parked item raises one parked briefing; a second pass does not duplicate it', () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    syncParkBriefings(w.db, w.zone, plus(t0, MIN));
    const list = open(w);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'parked', subject: `item:${id}`, source: 'server' });
    expect(list[0]?.options.map((o) => [o.label, o.effect])).toEqual([
      ['Retry', 'retry_item'],
      ['Leave parked', 'none'],
    ]);
  });

  test('the briefing is withdrawn when the item leaves parked by any path', () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    setWorkItemState(w.db, id, 'pr_open', undefined, plus(t0, MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    expect(open(w)).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' })[0]?.state).toBe('withdrawn');
  });

  test('a briefing ruled Leave parked is not raised again until the item parks again', () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    const b = open(w)[0];
    if (!b) throw new Error('no briefing');
    expect(ruleBriefing(w.db, b.id, optionOf(b, 'none'), '', plus(t0, MIN)).ok).toBe(true);
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    expect(open(w)).toEqual([]);
    setWorkItemState(w.db, id, 'pr_open', undefined, plus(t0, 3 * MIN));
    setWorkItemState(w.db, id, 'parked', 'again', plus(t0, 4 * MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 5 * MIN));
    expect(open(w)).toHaveLength(1);
  });
});

describe("dismissing a zone's briefings", () => {
  const crewBriefing = (zoneId: string, subject: string) => ({
    zoneId,
    kind: 'crew' as const,
    subject,
    decision: `${subject}?`,
    why: 'w',
    options: [{ id: 'ok', label: 'OK', effect: 'none' as const }],
    source: 'crew' as const,
  });

  test("dismisses exactly that zone's open briefings, rules nothing and writes no outbox entry", () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    raiseBriefing(w.db, crewBriefing('main', 'crew:a'), t0);
    raiseBriefing(w.db, crewBriefing('other', 'crew:b'), t0);
    const outboxBefore = listOutbox(w.db, ['pending', 'unknown', 'failed', 'done']).length;
    const ids = open(w).map((b) => b.id);
    expect(dismissZoneBriefings(w.db, 'main', ids, plus(t0, MIN))).toEqual(ids);
    expect(open(w)).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' }).map((b) => b.state)).toEqual([
      'dismissed',
      'dismissed',
    ]);
    expect(listBriefings(w.db, { zoneId: 'other', state: 'open' })).toHaveLength(1);
    expect(listRulings(w.db, 'main')).toEqual([]);
    expect(listOutbox(w.db, ['pending', 'unknown', 'failed', 'done'])).toHaveLength(outboxBefore);
    // The condition is not ruled on: the item stays parked.
    expect(getWorkItem(w.db, id)?.state).toBe('parked');
  });

  test('dismisses only the ids it was shown, and none of another zone', () => {
    const w = zoneWorld({ crew: crewOn });
    const a = raiseBriefing(w.db, crewBriefing('main', 'crew:a'), t0);
    const b = raiseBriefing(w.db, crewBriefing('main', 'crew:b'), t0);
    const c = raiseBriefing(w.db, crewBriefing('other', 'crew:c'), t0);
    expect(dismissZoneBriefings(w.db, 'main', [a, c], plus(t0, MIN))).toEqual([a]);
    expect(open(w).map((x) => x.id)).toEqual([b]);
    expect(listBriefings(w.db, { zoneId: 'other', state: 'open' })).toHaveLength(1);
  });

  test('a dismissed parked briefing is not raised again until the item parks again', () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    dismissZoneBriefings(
      w.db,
      'main',
      open(w).map((b) => b.id),
      plus(t0, MIN),
    );
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    expect(open(w)).toEqual([]);
    setWorkItemState(w.db, id, 'pr_open', undefined, plus(t0, 3 * MIN));
    setWorkItemState(w.db, id, 'parked', 'again', plus(t0, 4 * MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 5 * MIN));
    expect(open(w)).toHaveLength(1);
  });
});

describe('rulings', () => {
  test('ruling Retry resets attempts and restores the item exactly as the retry label does', async () => {
    const label = parkedWorld();
    label.w.f.state.setLabels(1, ['agent-ready', 'agent-retry']);
    const pass = await zonePass(label.w.forges, label.w.zone, 'main');
    await syncParked(label.w.db, label.w.forges, label.w.zone, pass, plus(t0, MIN));

    const ruled = parkedWorld();
    syncParkBriefings(ruled.w.db, ruled.w.zone, t0);
    const b = open(ruled.w)[0];
    if (!b) throw new Error('no briefing');
    expect(ruleBriefing(ruled.w.db, b.id, optionOf(b, 'retry_item'), 'go', t0).ok).toBe(true);
    expect(await applyPendingRulings(ruled.w.db, deps(ruled.w), 'main', plus(t0, MIN))).toBe(1);

    const view = (w: ZoneWorld, id: number) => {
      const { updatedAt: _u, ...item } = getWorkItem(w.db, id) as NonNullable<
        ReturnType<typeof getWorkItem>
      > & { updatedAt?: string };
      return {
        item,
        heal: getAttempts(w.db, id, 'heal'),
        failed: listOutbox(w.db, ['failed'], 'main').length,
      };
    };
    expect(view(ruled.w, ruled.id)).toEqual(view(label.w, label.id));
    expect(view(ruled.w, ruled.id)).toMatchObject({
      item: { state: 'pr_open' },
      heal: { count: 0 },
      failed: 0,
    });
  });

  function stagedIssue(w: ZoneWorld): number {
    return insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'k',
      source: 'crew-lead',
      objective: 'obj',
      title: 'T',
      body: 'B',
      priority: null,
      createdAt: t0.toISOString(),
    });
  }

  async function promoteBriefing(w: ZoneWorld): Promise<{ issue: number; briefing: number }> {
    const issue = stagedIssue(w);
    await flushCrewOps(w.db, w.forges, w.zone, [], t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    const briefing = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'promote',
        subject: `issue:${issue}`,
        decision: 'Promote the crew issue?',
        why: 'The crew proposed it.',
        options: [
          { id: 'promote', label: 'Promote', effect: 'promote_issue' },
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
        ],
        source: 'server',
      },
      t0,
    );
    return { issue, briefing };
  }

  test('ruling Promote moves the crew issue to promoting; the next flush promotes it', async () => {
    const w = zoneWorld({ crew: crewOn });
    const { issue, briefing } = await promoteBriefing(w);
    expect(ruleBriefing(w.db, briefing, 'promote', '', t0)).toMatchObject({ ok: true });
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged'); // the ruling only records
    await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoting');
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoted');
  });

  test('a crash between ruled and applied applies the ruling once on the next pass', async () => {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    const b = open(w)[0];
    if (!b) throw new Error('no briefing');
    ruleBriefing(w.db, b.id, optionOf(b, 'retry_item'), '', t0);
    // The process stopped here. After a restart the next pass applies it, and only once.
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN))).toBe(1);
    setWorkItemState(w.db, id, 'parked', 'parked again', plus(t0, 2 * MIN));
    setAttempts(w.db, id, 'heal', 3, 'fp');
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 3 * MIN))).toBe(0);
    expect(getWorkItem(w.db, id)?.state).toBe('parked');
    expect(listRulings(w.db, 'main')[0]?.appliedAt).toBe(plus(t0, MIN).toISOString());
  });

  test('applying an effect twice changes nothing the second time', async () => {
    const w = zoneWorld({ crew: crewOn });
    const { issue } = await promoteBriefing(w);
    const subject = `issue:${issue}`;
    await applyEffect(w.db, deps(w), 'main', subject, 'promote_issue', t0);
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoted');
    await applyEffect(w.db, deps(w), 'main', subject, 'promote_issue', plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoted');
    // Once its work has started, a promoted issue can no longer be rejected.
    const started = w.item(getCrewIssue(w.db, issue)?.number ?? -1, 'in_flight');
    expect(started).toBeGreaterThan(0);
    await expect(
      applyEffect(w.db, deps(w), 'main', subject, 'reject_issue', plus(t0, 2 * MIN)),
    ).rejects.toThrow('already started');
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoted');

    const { w: pw, id } = parkedWorld();
    await applyEffect(pw.db, deps(pw), 'main', `item:${id}`, 'retry_item', t0);
    const after = getWorkItem(pw.db, id);
    setAttempts(pw.db, id, 'heal', 2, 'fp');
    await applyEffect(pw.db, deps(pw), 'main', `item:${id}`, 'retry_item', plus(t0, MIN));
    expect(getWorkItem(pw.db, id)?.state).toBe(after?.state);
    expect(getAttempts(pw.db, id, 'heal').count).toBe(2);
  });

  test('a briefing ruled twice applies once; the second gets 409', async () => {
    const w = zoneWorld({ crew: crewOn });
    const { issue, briefing } = await promoteBriefing(w);
    expect(ruleBriefing(w.db, briefing, 'promote', '', t0).ok).toBe(true);
    expect(ruleBriefing(w.db, briefing, 'reject', '', t0)).toEqual({ ok: false, status: 409 });
    expect(listRulings(w.db, 'main')).toHaveLength(1);
    await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promoting');
  });

  test('an option id not on the briefing is 400; an unknown briefing is 404', async () => {
    const w = zoneWorld({ crew: crewOn });
    const { briefing } = await promoteBriefing(w);
    expect(ruleBriefing(w.db, briefing, 'merge', '', t0)).toEqual({ ok: false, status: 400 });
    expect(ruleBriefing(w.db, 9999, 'promote', '', t0)).toEqual({ ok: false, status: 404 });
    expect(listBriefings(w.db, { zoneId: 'main' })[0]?.state).toBe('open');
  });

  test('a crew-raised briefing can only carry effect none', () => {
    const w = zoneWorld({ crew: crewOn });
    const crew = {
      zoneId: 'main',
      kind: 'crew' as const,
      subject: 'goal: add a section',
      decision: 'Add a section to GOAL.md?',
      why: 'w',
      source: 'crew' as const,
    };
    expect(() =>
      raiseBriefing(
        w.db,
        {
          ...crew,
          options: [
            { id: 'a', label: 'Yes', effect: 'promote_issue' },
            { id: 'b', label: 'No', effect: 'none' },
          ],
        },
        t0,
      ),
    ).toThrow(/effect none/);
    // An assistant (MCP) briefing is held to the same rule.
    expect(() =>
      raiseBriefing(
        w.db,
        {
          ...crew,
          subject: 'mcp:x',
          source: 'mcp',
          options: [
            { id: 'a', label: 'Yes', effect: 'enable_fable' },
            { id: 'b', label: 'No', effect: 'none' },
          ],
        },
        t0,
      ),
    ).toThrow(/effect none/);
    const id = raiseBriefing(
      w.db,
      {
        ...crew,
        options: [
          { id: 'a', label: 'Yes', effect: 'none' },
          { id: 'b', label: 'No', effect: 'none' },
        ],
      },
      t0,
    );
    expect(listBriefings(w.db, { zoneId: 'main' }).map((b) => b.id)).toEqual([id]);
  });

  test('a failed effect records apply_error, is shown, and is not retried', async () => {
    const { w } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    const b = open(w)[0];
    if (!b) throw new Error('no briefing');
    ruleBriefing(w.db, b.id, optionOf(b, 'retry_item'), '', t0);
    let calls = 0;
    const broken = {
      forges: () => {
        calls++;
        throw new Error('no forge for zone');
      },
      zone: () => w.zone,
    };
    expect(await applyPendingRulings(w.db, broken, 'main', plus(t0, MIN))).toBe(0);
    expect(listRulings(w.db, 'main')[0]).toMatchObject({
      appliedAt: null,
      applyError: 'no forge for zone',
    });
    await applyPendingRulings(w.db, broken, 'main', plus(t0, 2 * MIN));
    expect(calls).toBe(1);
  });
});

describe('promotion mismatch', () => {
  test('a body changed on the forge raises a promote briefing saying so', async () => {
    const w = zoneWorld({ crew: crewOn });
    const id = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'k',
      source: 'crew-lead',
      objective: 'obj',
      title: 'T',
      body: 'B',
      priority: null,
      createdAt: t0.toISOString(),
    });
    await flushCrewOps(w.db, w.forges, w.zone, [], t0);
    const n = getCrewIssue(w.db, id)?.number ?? -1;
    const e = w.f.state.issues.get(n);
    if (e?.issue) e.issue.body = 'Edited.';
    setCrewIssue(w.db, id, { state: 'promoting' }, t0);
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    expect(getCrewIssue(w.db, id)?.state).toBe('staged');
    const [b] = open(w);
    expect(b).toMatchObject({ kind: 'promote', subject: `issue:${id}` });
    expect(b?.why).toMatch(/body changed/);
  });
});

describe('advance_objective', () => {
  const SUBJECT = 'objective:document-every-endpoint';
  async function objectiveBriefing(): Promise<{ w: ZoneWorld; id: number }> {
    const w = await crewWorld();
    const r = applyCrewActions(
      w.db,
      w.zone,
      { objectiveDone: { key: 'document-every-endpoint', why: 'All merged.' } },
      { kind: 'drop', dropId: 'd1' },
      t0,
    );
    return { w, id: r.briefings[0] ?? -1 };
  }
  const rows = (w: ZoneWorld) =>
    w.db.prepare('SELECT zone_id AS zoneId, key, ruling_id AS rulingId FROM objectives_done').all();

  test('ruling done records the objective done by that ruling', async () => {
    const { w, id } = await objectiveBriefing();
    const ruled = ruleBriefing(w.db, id, 'done', '', t0);
    if (!ruled.ok) throw new Error('not ruled');
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN))).toBe(1);
    expect(rows(w)).toEqual([
      { zoneId: 'main', key: 'document-every-endpoint', rulingId: ruled.rulingId },
    ]);
    expect(objectivesDone(w.db, 'main')).toEqual(
      new Map([['document-every-endpoint', ruled.rulingId]]),
    );
    expect(listRulings(w.db, 'main')[0]).toMatchObject({
      applyError: null,
      effect: 'advance_objective',
    });
  });

  test('ruling again or applying the effect again still leaves one row (D3)', async () => {
    const { w, id } = await objectiveBriefing();
    const ruled = ruleBriefing(w.db, id, 'done', '', t0);
    if (!ruled.ok) throw new Error('not ruled');
    expect(ruleBriefing(w.db, id, 'done', '', t0)).toEqual({ ok: false, status: 409 });
    await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN));
    await applyPendingRulings(w.db, deps(w), 'main', plus(t0, 2 * MIN));
    await applyEffect(w.db, deps(w), 'main', SUBJECT, 'advance_objective', plus(t0, 3 * MIN), {
      rulingId: ruled.rulingId,
      source: 'server',
    });
    expect(rows(w)).toEqual([
      { zoneId: 'main', key: 'document-every-endpoint', rulingId: ruled.rulingId },
    ]);
  });

  test('ruling keep records nothing', async () => {
    const { w, id } = await objectiveBriefing();
    expect(ruleBriefing(w.db, id, 'keep', '', t0).ok).toBe(true);
    expect(await applyPendingRulings(w.db, deps(w), 'main', plus(t0, MIN))).toBe(1);
    expect(rows(w)).toEqual([]);
  });

  test('a subject not starting objective: throws and records nothing (D2)', async () => {
    const { w, id } = await objectiveBriefing();
    const ruled = ruleBriefing(w.db, id, 'done', '', t0);
    if (!ruled.ok) throw new Error('not ruled');
    for (const subject of ['issue:1', 'crew:objective:x', 'objective:', 'objective:Bad Key']) {
      await expect(
        applyEffect(w.db, deps(w), 'main', subject, 'advance_objective', t0, {
          rulingId: ruled.rulingId,
          source: 'server',
        }),
      ).rejects.toThrow(/advance_objective needs an objective subject/);
    }
    // Only a ruling on a server briefing applies it.
    for (const ruling of [{}, { rulingId: ruled.rulingId, source: 'crew' as const }]) {
      await expect(
        applyEffect(w.db, deps(w), 'main', SUBJECT, 'advance_objective', t0, ruling),
      ).rejects.toThrow(/only through a ruling/);
    }
    expect(rows(w)).toEqual([]);
  });

  test('a crew or MCP briefing can never offer advance_objective', async () => {
    const w = await crewWorld();
    for (const source of ['crew', 'mcp'] as const) {
      expect(() =>
        raiseBriefing(
          w.db,
          {
            zoneId: 'main',
            kind: 'objective_done',
            subject: SUBJECT,
            decision: 'Mark it done?',
            why: 'w',
            options: [
              { id: 'done', label: 'Mark it done', effect: 'advance_objective' },
              { id: 'keep', label: 'Keep it open', effect: 'none' },
            ],
            source,
          },
          t0,
        ),
      ).toThrow(/effect none/);
    }
    expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
  });
});
