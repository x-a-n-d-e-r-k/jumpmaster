import type { GateResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import {
  applyEffect,
  applyPendingRulings,
  type BriefingOption,
  diagnosePending,
  dismissZoneBriefings,
  effectText,
  getBriefing,
  listBriefings,
  listRulings,
  raiseBriefing,
  recordDiagnosis,
  ruleBriefing,
  syncParkBriefings,
  whyBasis,
} from './briefings.js';
import type { DropZoneConfig } from './config.js';
import { applyCrewActions } from './crew/actions.js';
import { flushCrewOps } from './crew/flush.js';
import {
  claimCrewRetryApply,
  getCrewIssue,
  insertCrewIssue,
  insertCrewRetry,
  setCrewIssue,
  settleCrewRetry,
} from './crew/store.js';
import {
  getAttempts,
  getWorkItem,
  insertDrop,
  insertOutbox,
  listOutbox,
  setAttempts,
  setKilled,
  setWorkItemState,
  setZoneMode,
  updateDrop,
} from './db/repo.js';
import { reconcileZone } from './flow/reconcile.js';
import { zonePass } from './flow/snapshot.js';
import { getGoalChange, listGoalChanges } from './goal-change.js';
import { objectivesDone } from './goals.js';
import { promptVersions } from './payloads.js';
import { syncParked } from './sync.js';
import { crewWorld, GOAL } from './test/crew.js';
import { makeZone, usageCfg, type ZoneWorld, zoneWorld } from './test/fixtures.js';
import { type Harness, harness } from './test/flowHarness.js';
import { plus, t0 } from './test/helpers.js';
import { VITEST_348 } from './test/vitest-output.js';

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
    expect(list[0]?.decision).toBe(
      `Issue #${getWorkItem(w.db, id)?.issueNumber} is parked. Retry it, close it as done, or leave it?`,
    );
    expect(
      list[0]?.options.map((o) => [o.label, o.effect, effectText('parked', o.effect)]),
    ).toEqual([
      [
        'Retry',
        'retry_item',
        'the parked item goes back to work: an agent runs it again from where it parked, with your note, if you wrote one, as direction',
      ],
      [
        'Close as done',
        'close_item',
        'closes the issue as completed with a comment and stops work on it; nothing is merged',
      ],
      ['Leave parked', 'none', 'the item stays parked; nothing runs and nothing changes on GitHub'],
    ]);
  });

  test('an open two-option briefing gains Close as done on the next pass, in place (#535)', () => {
    const { w, id } = parkedWorld();
    const n = getWorkItem(w.db, id)?.issueNumber;
    // As an older server raised it: two options, the old decision.
    const old = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'parked',
        subject: `item:${id}`,
        decision: `Issue #${n} is parked. Retry it?`,
        why: 'heal budget exhausted',
        options: [
          { id: 'retry', label: 'Retry', effect: 'retry_item' },
          { id: 'leave', label: 'Leave parked', effect: 'none' },
        ],
        recommendation: 'Retry it.',
        source: 'server',
      },
      t0,
    );
    syncParkBriefings(w.db, w.zone, plus(t0, MIN));
    const [b] = open(w);
    expect(b?.id).toBe(old);
    expect(b?.decision).toBe(`Issue #${n} is parked. Retry it, close it as done, or leave it?`);
    expect(b?.options.map((o) => o.effect)).toEqual(['retry_item', 'close_item', 'none']);
    // The why is unchanged, so the crew's recommendation stays.
    expect(b?.recommendation).toBe('Retry it.');
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

describe('parked briefings and the crew retry (#396)', () => {
  const token = 'ghp_' + 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8';
  function retried(diagnosis: string, instruction: string) {
    const { w, id } = parkedWorld();
    syncParkBriefings(w.db, w.zone, t0);
    const b = open(w)[0];
    const rowId = insertCrewRetry(w.db, {
      zoneId: 'main',
      itemId: id,
      briefingId: b?.id ?? -1,
      dropId: 'diag',
      diagnosis,
      instruction,
      createdAt: plus(t0, MIN),
    });
    return { w, id, rowId };
  }

  test('no briefing is raised for an item with an unapplied crew retry', () => {
    const { w, rowId } = retried('d', 'i');
    w.db.prepare(`UPDATE briefings SET state = 'withdrawn'`).run();
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 3 * MIN));
    expect(open(w)).toEqual([]);
    // Once applied (here: skipped), Command is briefed as usual.
    expect(claimCrewRetryApply(w.db, rowId, plus(t0, 4 * MIN))).toBe(true);
    settleCrewRetry(w.db, rowId, 'skipped');
    syncParkBriefings(w.db, w.zone, plus(t0, 4 * MIN));
    expect(open(w)).toHaveLength(1);
    expect(open(w)[0]?.decision).toMatch(/is parked\. Retry it, close it as done, or leave it\?$/);
  });

  test("the parked-again briefing's decision and why: the crew's diagnosis, cut, and its instruction, redacted", () => {
    const long = `${'D'.repeat(480)}${token} ${'E'.repeat(100)}`;
    const { w, id, rowId } = retried(long, `Never paste ${token}.`);
    expect(claimCrewRetryApply(w.db, rowId, new Date('2026-03-04T05:06:07.000Z'))).toBe(true);
    settleCrewRetry(w.db, rowId, 'retried');
    setWorkItemState(w.db, id, 'in_flight', undefined, plus(t0, 2 * MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    setWorkItemState(w.db, id, 'parked', 'gate test failed', plus(t0, 3 * MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 3 * MIN));
    const [b] = open(w);
    expect(b?.decision).toBe(
      `Issue #${getWorkItem(w.db, id)?.issueNumber} is parked again after the crew retried it once. Retry it, close it as done, or leave it?`,
    );
    expect(b?.why).toBe(
      `The crew already retried this once on 2026-03-04. Its diagnosis: ${'D'.repeat(480)}[REDACTED] ${'E'.repeat(9)}…. It told the next attempt: Never paste [REDACTED].\n\ngate test failed`,
    );
    expect(b?.why).not.toContain(token);
    expect(b?.options.map((o) => [o.label, o.effect])).toEqual([
      ['Retry', 'retry_item'],
      ['Close as done', 'close_item'],
      ['Leave parked', 'none'],
    ]);
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

describe('open_goal_change', () => {
  const NEW_GOAL = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the guide');
  async function goalChangeWorld() {
    const w = await crewWorld();
    w.f.state.branches.set('main', 'base0');
    w.f.state.files.set('base0:GOAL.md', GOAL);
    const r = applyCrewActions(
      w.db,
      w.zone,
      { goalChange: { text: NEW_GOAL, why: 'A guide is next.' } },
      { kind: 'drop', dropId: 'd1' },
      t0,
    );
    const [change] = listGoalChanges(w.db, 'main');
    if (!change || r.briefings[0] === undefined) throw new Error('not proposed');
    const pass = async (now: Date) => {
      const p = await zonePass(w.forges, w.zone, 'main');
      return reconcileZone(w.db, w.forges, w.zone, p, promptVersions(), usageCfg, [], now);
    };
    return { w, briefingId: r.briefings[0], changeId: change.id, pass };
  }
  const pullsOf = (w: ZoneWorld, id: number) =>
    [...w.f.state.pulls.values()].filter((p) => p.headRef === `jm/goal-change-${id}`);

  test('ruling Open the PR opens it on the next pass, and merging still needs the browser confirmation', async () => {
    const { w, briefingId, changeId, pass } = await goalChangeWorld();
    // Before the ruling, a pass opens nothing: the crew's proposal waits for Command.
    await pass(plus(t0, MIN));
    expect(getGoalChange(w.db, changeId)).toMatchObject({ state: 'proposed', prNumber: null });
    expect(pullsOf(w, changeId)).toEqual([]);

    const ruled = ruleBriefing(w.db, briefingId, 'open', '', plus(t0, 2 * MIN));
    if (!ruled.ok) throw new Error('not ruled');
    await pass(plus(t0, 3 * MIN));
    const pulls = pullsOf(w, changeId);
    expect(pulls).toHaveLength(1);
    expect(getGoalChange(w.db, changeId)).toMatchObject({
      state: 'open',
      prNumber: pulls[0]?.number,
      confirmedSha: null,
    });
    expect(listRulings(w.db, 'main')[0]).toMatchObject({
      applyError: null,
      effect: 'open_goal_change',
    });
    // Another pass merges nothing: no merge op and no review without the owner's confirmation.
    await pass(plus(t0, 4 * MIN));
    expect(getGoalChange(w.db, changeId)?.state).toBe('open');
    const ops = listOutbox(w.db, ['pending', 'done', 'failed', 'unknown'], 'main');
    expect(ops.filter((o) => o.kind === 'merge' || o.kind === 'post_review')).toEqual([]);
    expect(pulls[0]?.merged).toBeFalsy();
  });

  test('ruling Leave the goals closes the proposal, and no pass opens it', async () => {
    const { w, briefingId, changeId, pass } = await goalChangeWorld();
    expect(ruleBriefing(w.db, briefingId, 'no', '', t0).ok).toBe(true);
    await pass(plus(t0, MIN));
    await pass(plus(t0, 2 * MIN));
    expect(getGoalChange(w.db, changeId)?.state).toBe('closed');
    expect(pullsOf(w, changeId)).toEqual([]);
  });

  test('D1 open_goal_change outside a ruling on a server briefing throws', async () => {
    const { w, changeId } = await goalChangeWorld();
    const subject = `goal-change:${changeId}`;
    const run = (ruling: Parameters<typeof applyEffect>[6]) =>
      applyEffect(w.db, deps(w), 'main', subject, 'open_goal_change', t0, ruling);
    await expect(run({})).rejects.toThrow(/only through a ruling/);
    await expect(run({ rulingId: 1, source: 'crew' })).rejects.toThrow(/only through a ruling/);
    await expect(run({ rulingId: 1, source: 'mcp' })).rejects.toThrow(/only through a ruling/);
    await expect(
      applyEffect(w.db, deps(w), 'main', 'item:1', 'open_goal_change', t0, {
        rulingId: 1,
        source: 'server',
      }),
    ).rejects.toThrow(/goal-change subject/);
    expect(getGoalChange(w.db, changeId)?.state).toBe('proposed');
    expect(pullsOf(w, changeId)).toEqual([]);
    // A crew briefing can never carry the effect either.
    expect(() =>
      raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: 'crew',
          subject: 'crew:x',
          decision: 'd',
          why: 'w',
          options: [{ id: 'o1', label: 'Open', effect: 'open_goal_change' }],
          source: 'crew',
        },
        t0,
      ),
    ).toThrow(/effect none/);
  });
});

describe('the why of a gate-failure park (#397)', () => {
  const failingGate = (o: Partial<GateResult> = {}): GateResult => ({
    name: 'test',
    exitCode: 1,
    durationMs: 1,
    timedOut: false,
    outputTail: VITEST_348,
    ...o,
  });

  /** A harness whose item parked on an implement drop that failed `gate`. */
  async function parkedOnGate(
    gate: GateResult,
    zone: Partial<DropZoneConfig> = {},
  ): Promise<Harness> {
    const h = await harness({ zone });
    await h.reconcile();
    await h.finishDrop('implement', {
      status: 'failed',
      reason: `gate ${gate.name} failed`,
      gates: [{ ...gate, name: 'lint', exitCode: 0, outputTail: '' }, gate],
    });
    await h.reconcile();
    return h;
  }
  const openOf = (h: Harness) => listBriefings(h.db, { zoneId: 'main', state: 'open' });

  test('a failed implement drop: the failing test and its assertion, then the park reason', async () => {
    const h = await parkedOnGate(failingGate());
    const [b, ...rest] = openOf(h);
    expect(rest).toEqual([]);
    expect(b?.why).toBe(
      "The test gate failed: `scripts/no-token-literals.test.ts` > no tracked file holds a token-shaped literal, a real private key or a lockfile credential (AssertionError: expected [ 'apps/server/src/chat/session.test.ts:12' ] to deeply equal [])\n\nPark reason: gate test failed",
    );
  });

  test('a second pass leaves the briefing and its diagnosis untouched', async () => {
    const h = await parkedOnGate(failingGate());
    const b = openOf(h)[0];
    if (!b) throw new Error('no briefing');
    recordDiagnosis(
      h.db,
      b.id,
      { diagnosis: 'the literal is a fixture', basis: whyBasis(b.why), recommendation: 'Retry' },
      h.now(),
      { spent: true },
    );
    const before = getBriefing(h.db, b.id);
    h.at(5);
    await h.reconcile();
    syncParkBriefings(h.db, h.zone, h.at(5));
    expect(openOf(h)).toEqual([before]);
  });

  test('output that does not parse: the gate, its exit and the last lines', async () => {
    const tail = ['src/a.ts', '  3:1  error  no-unused-vars', '', '✖ 1 problem'].join('\n');
    const h = await parkedOnGate(failingGate({ name: 'lint', outputTail: tail }));
    expect(openOf(h)[0]?.why).toBe(
      'The lint gate failed (exit 1). Its output ended with:\n\nsrc/a.ts\n  3:1  error  no-unused-vars\n✖ 1 problem\n\nPark reason: gate lint failed',
    );
  });

  test('no stored result to match, or one that does not parse: the park reason, as before', () => {
    const w = zoneWorld({});
    const id = w.item(1, 'ready');
    setWorkItemState(w.db, id, 'parked', 'gate test failed', t0);
    syncParkBriefings(w.db, w.zone, t0);
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })[0]?.why).toBe('gate test failed');

    insertDrop(w.db, {
      id: 'bad',
      dropZoneId: 'main',
      workItemId: id,
      role: 'implement',
      state: 'failed',
      createdAt: t0.toISOString(),
    });
    updateDrop(w.db, 'bad', { resultJson: '{"status":"failed",' });
    syncParkBriefings(w.db, w.zone, plus(t0, MIN));
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })[0]?.why).toBe('gate test failed');

    // A result for another reason, or without a red gate of that name, does not match either.
    updateDrop(w.db, 'bad', {
      resultJson: JSON.stringify({
        status: 'failed',
        reason: 'gate test failed',
        gates: [failingGate({ name: 'lint' })],
      }),
    });
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })[0]?.why).toBe('gate test failed');
  });

  test('a park for another reason keeps its reason', () => {
    for (const reason of ['no_changes', 'budget exhausted: heal']) {
      const w = zoneWorld({});
      const id = w.item(1, 'ready');
      setWorkItemState(w.db, id, 'parked', reason, t0);
      syncParkBriefings(w.db, w.zone, t0);
      expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })[0]?.why).toBe(reason);
    }
  });
});

describe('diagnosePending (#397)', () => {
  /** The crew on, and ready issues not held back for triage. */
  const crewZone = { crew: crewOn, triage: { ...makeZone({}).triage, gate: false } };
  async function parked(zone: Partial<DropZoneConfig> = crewZone) {
    const h = await harness({ zone });
    await h.reconcile();
    await h.finishDrop('implement', {
      status: 'failed',
      reason: 'gate test failed',
      gates: [
        { name: 'test', exitCode: 1, durationMs: 1, timedOut: false, outputTail: VITEST_348 },
      ],
    });
    await h.sync();
    syncParkBriefings(h.db, h.zone, h.now());
    const b = () => {
      const [first] = listBriefings(h.db, { zoneId: 'main' }).filter((x) => x.kind === 'parked');
      if (!first) throw new Error('no briefing');
      return first;
    };
    return { h, b, pending: (at = h.now()) => diagnosePending(h.db, h.zone, b(), at) };
  }

  test('true while attempts are 0 and within 60 minutes; false past them with no drop', async () => {
    const { h, pending } = await parked();
    expect(pending()).toBe(true);
    expect(pending(plus(h.now(), 59 * MIN))).toBe(true);
    expect(pending(plus(h.now(), 60 * MIN))).toBe(false);
    expect(pending(plus(h.now(), 70 * MIN))).toBe(false);
  });

  test('true while a diagnose drop is active, past 60 minutes too; false once it fails', async () => {
    const { h, b, pending } = await parked();
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['diagnose']);
    expect(b().diagnoseAttempts).toBe(1);
    expect(pending(plus(h.now(), 90 * MIN))).toBe(true);
    await h.finishDrop('diagnose', { status: 'failed', reason: 'no output', gates: [] });
    expect(b().diagnosis).toBeNull();
    expect(pending()).toBe(false);
  });

  test('false once the diagnosis lands', async () => {
    const { h, b, pending } = await parked();
    recordDiagnosis(
      h.db,
      b().id,
      { diagnosis: 'a fixture literal', basis: whyBasis(b().why), recommendation: '' },
      h.now(),
    );
    expect(pending()).toBe(false);
  });

  test('false with the crew disabled, under the kill switch, in observe mode, or once ruled', async () => {
    expect((await parked({})).pending()).toBe(false);

    const killed = await parked();
    setKilled(killed.h.db, true, killed.h.now());
    expect(killed.pending()).toBe(false);

    const observing = await parked();
    setZoneMode(observing.h.db, 'main', 'observe', observing.h.now());
    expect(observing.pending()).toBe(false);

    const ruled = await parked();
    const b = ruled.b();
    ruleBriefing(ruled.h.db, b.id, optionOf(b, 'none'), '', ruled.h.now());
    expect(ruled.pending()).toBe(false);
  });

  test('false for a briefing of another kind', () => {
    const w = zoneWorld({ crew: crewOn });
    const id = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'x',
        decision: 'd',
        why: 'w',
        options: [{ id: 'ok', label: 'OK', effect: 'none' }],
        source: 'crew',
      },
      t0,
    );
    const b = listBriefings(w.db, { zoneId: 'main' }).find((x) => x.id === id);
    if (!b) throw new Error('no briefing');
    expect(diagnosePending(w.db, w.zone, b, t0)).toBe(false);
  });
});

describe('the pages while a diagnosis is pending (#397)', () => {
  const crewZone = { crew: crewOn, triage: { ...makeZone({}).triage, gate: false } };
  const notice = 'The crew is looking at this.';

  test('/briefings, its zone view and the briefing page show the notice, then the rule form', async () => {
    const h = await harness({ zone: crewZone });
    await h.reconcile();
    await h.finishDrop('implement', {
      status: 'failed',
      reason: 'gate test failed',
      gates: [
        { name: 'test', exitCode: 1, durationMs: 1, timedOut: false, outputTail: VITEST_348 },
      ],
    });
    await h.sync();
    syncParkBriefings(h.db, h.zone, h.now());
    const b = listBriefings(h.db, { zoneId: 'main', state: 'open' })[0];
    if (!b) throw new Error('no briefing');
    const pages = ['/briefings', '/briefings?zone=main', `/briefings/${b.id}`];
    for (const url of pages) {
      const html = (await h.view(url)).body;
      expect(html, url).toContain(notice);
      expect(html, url).not.toContain('class="rule"');
      expect(html, url).toContain('The test gate failed: `scripts/no-token-literals.test.ts`');
    }
    // Seventy minutes on with no diagnose run (the crew never got to it): the rule form is back.
    h.at(70);
    for (const url of pages) {
      const html = (await h.view(url)).body;
      expect(html, url).not.toContain(notice);
      expect(html, url).toContain(`<form class="rule" data-briefing="${b.id}"`);
    }
  });
});
