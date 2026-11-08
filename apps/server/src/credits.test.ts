import type { RateLimitEventData } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  type Briefing,
  listBriefings,
  listRulings,
  ruleBriefing,
} from './briefings.js';
import type { UsageConfig } from './config.js';
import {
  creditsPass,
  creditsStopInForce,
  noteOverage,
  noteProbeResult,
  syncCreditsBriefing,
} from './credits.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import {
  type Drop,
  getUsageState,
  insertDrop,
  insertStick,
  setKilled,
  setUsageState,
  setZoneMode,
  upsertDropZone,
} from './db/repo.js';
import { getFableState, noteFableSignals } from './fable.js';
import { leaseNextDrop } from './leases.js';
import { type ZoneWorld, zoneWorld } from './test/fixtures.js';
import { tmpDbFile } from './test/helpers.js';
import { dispatchGate, gateQueuesImplement, ingestRateLimit } from './usage.js';

const t0 = new Date('2026-03-02T10:00:00.000Z');
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const iso = (ms: number): string => at(ms).toISOString();
const cfg: UsageConfig = { throttleUtilization: 0.9, probeJitterSeconds: [0, 0] };

/** A report like the live ones, on credits: the weekly window exhausted, the 5-hour one not. */
const onCredits = (o: Partial<RateLimitEventData> = {}): RateLimitEventData => ({
  status: 'allowed',
  resetsAt: iso(3 * DAY),
  rateLimitType: 'seven_day',
  unifiedWindows: {
    five_hour: { utilization: 0.4, resetsAt: iso(2 * H) },
    seven_day: { utilization: 1, resetsAt: iso(3 * DAY) },
  },
  isUsingOverage: true,
  overageStatus: 'allowed',
  ...o,
});

let w: ZoneWorld;
let db: Db;
beforeEach(() => {
  w = zoneWorld();
  db = w.db;
});

function drop(id: string, role = 'implement', workItemId: number | null = null): Drop {
  const item = workItemId ?? (role.startsWith('crew') || role === 'diagnose' ? null : w.item(9));
  insertDrop(db, { id, dropZoneId: 'main', workItemId: item, role, state: 'running' }, t0);
  return {
    id,
    dropZoneId: 'main',
    workItemId: item,
    role,
  } as Drop;
}

const openStop = (): Briefing[] =>
  listBriefings(db, { state: 'open' }).filter((b) => b.subject.startsWith('credits:stop:'));

describe('the credits stop', () => {
  test('a report of credit use stops dispatch; one without it changes nothing', () => {
    const d = drop('d1');
    expect(noteOverage(db, cfg, d, onCredits({ isUsingOverage: false }), null, t0)).toBe(false);
    expect(dispatchGate(db, cfg, t0)).toBe('open');
    expect(noteOverage(db, cfg, d, onCredits(), null, t0)).toBe(true);
    expect(dispatchGate(db, cfg, t0)).toBe('stopped');
    expect(getUsageState(db)).toMatchObject({ overageDropId: 'd1', overageStoppedAt: iso(0) });
  });

  test('stopOnOverage false never stops, but the drop is still recorded', () => {
    const d = drop('d1');
    expect(noteOverage(db, { ...cfg, stopOnOverage: false }, d, onCredits(), null, t0)).toBe(false);
    expect(dispatchGate(db, cfg, t0)).toBe('open');
    expect(db.prepare('SELECT drop_id AS id FROM credit_drops').all()).toEqual([{ id: 'd1' }]);
  });

  test('stopped wins over a throttle pause that ended (no probe while stopped)', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    setUsageState(db, { status: 'rejected', pausedUntil: iso(-MIN) }, t0);
    expect(dispatchGate(db, cfg, t0)).toBe('stopped');
  });

  test('stopped leases nothing, of any role', () => {
    // One active crew drop per zone: a diagnose stands for the crew roles.
    const roles = ['implement', 'review', 'heal', 'resolve', 'diagnose'];
    roles.forEach((role, i) => {
      const item = role === 'diagnose' ? null : w.item(i + 1);
      insertDrop(db, { id: `q${i}`, dropZoneId: 'main', workItemId: item, role, state: 'queued' });
    });
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 1 });
    expect(leaseNextDrop(db, 's1', t0, 'stopped')).toBeNull();
    // Not vacuous: the same queue leases under an open gate.
    expect(leaseNextDrop(db, 's1', t0, 'open')).not.toBeNull();
  });

  test('the stop survives a later allowed report and a restart', () => {
    const f = tmpDbFile();
    const a = openDb(f);
    upsertDropZone(a, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
    insertDrop(a, {
      id: 'c1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'running',
    });
    noteOverage(
      a,
      cfg,
      { id: 'c1', dropZoneId: 'main', workItemId: null, role: 'crew-lead' } as Drop,
      onCredits(),
      null,
      t0,
    );
    ingestRateLimit(
      a,
      { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } },
      { dropId: 'c1', workItemId: null, startedAt: iso(0), outcome: 'completed' },
      cfg,
      at(MIN),
    );
    a.close();
    expect(dispatchGate(openDb(f), cfg, at(2 * MIN))).toBe('stopped');
  });

  test('a stop already set keeps its first drop', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    expect(noteOverage(db, cfg, drop('d2', 'crew-lead'), onCredits(), null, at(MIN))).toBe(false);
    expect(getUsageState(db).overageDropId).toBe('d1');
  });
});

describe('the stop lifts by itself at the exhausted window reset', () => {
  test('the exhausted window (utilization 1) decides, with no ruling', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    expect(getUsageState(db).overageUntil).toBe(iso(3 * DAY));
    expect(dispatchGate(db, cfg, at(3 * DAY - MIN))).toBe('stopped');
    // Lifted into a single-drop probe (until a live in-plan report).
    expect(dispatchGate(db, cfg, at(3 * DAY))).toBe('probe');
    // The next pass clears it and withdraws the briefing.
    creditsPass(db, at(MIN));
    expect(openStop()).toHaveLength(1);
    creditsPass(db, at(3 * DAY));
    expect(openStop()).toHaveLength(0);
    expect(getUsageState(db).overageStoppedAt).toBeNull();
  });

  test('else the reported limit type window, else five hours; never past seven days', () => {
    const noUtil = { five_hour: { utilization: 0.2, resetsAt: iso(H) } };
    noteOverage(
      db,
      cfg,
      drop('a'),
      onCredits({ unifiedWindows: noUtil, rateLimitType: 'five_hour' }),
      null,
      t0,
    );
    expect(getUsageState(db).overageUntil).toBe(iso(H));

    const b = zoneWorld();
    noteOverage(
      b.db,
      cfg,
      { id: 'b', dropZoneId: 'main', workItemId: null, role: 'x' } as Drop,
      { status: 'allowed', isUsingOverage: true },
      null,
      t0,
    );
    expect(getUsageState(b.db).overageUntil).toBe(iso(5 * H));

    const c = zoneWorld();
    noteOverage(
      c.db,
      cfg,
      { id: 'c', dropZoneId: 'main', workItemId: null, role: 'x' } as Drop,
      onCredits({ unifiedWindows: { seven_day: { utilization: 1, resetsAt: iso(30 * DAY) } } }),
      null,
      t0,
    );
    expect(getUsageState(c.db).overageUntil).toBe(iso(7 * DAY));
  });

  test('after it lifted, a new report stops again', () => {
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    expect(dispatchGate(db, cfg, at(5 * H))).toBe('probe');
    expect(noteOverage(db, cfg, drop('d2', 'crew-lead'), onCredits(), null, at(5 * H))).toBe(true);
    expect(getUsageState(db).overageDropId).toBe('d2');
  });
});

describe('the credits briefing', () => {
  test('one per stop, raised by the pass (also after a restart with none), Run on credits and Noted', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), 'failed', t0);
    expect(openStop()).toHaveLength(0); // handlers only set state
    syncCreditsBriefing(db, t0);
    syncCreditsBriefing(db, at(MIN));
    const [b, ...rest] = openStop();
    expect(rest).toEqual([]);
    expect(b).toMatchObject({
      subject: 'credits:stop:d1',
      kind: 'credits_required',
      zoneId: 'main',
    });
    expect(b?.options.map((o) => [o.id, o.effect])).toEqual([
      ['resume', 'resume_after_credits'],
      ['noted', 'none'],
    ]);
    // The weekly window is the exhausted one: at most five hours, no time named (M2, M1).
    expect(b?.options[0]?.label).toBe('Run on credits now (at most 5 hours)');
    expect(b?.why).toContain('Stopped until the 7-day window resets: it is at 100%.');
    expect(b?.why).toContain('5-hour window: 40% used, resets 2026-03-02T12:00:00.000Z');
    expect(b?.why).toContain('7-day window: 100% used, resets 2026-03-05T10:00:00.000Z');
    expect(b?.why).toContain('overage status: allowed');
    expect(b?.why).toContain('outcome: failed');
    expect(b?.decision).toContain('2026-03-05T10:00:00.000Z');
  });

  test('Noted keeps the stop, and the next pass asks again', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    creditsPass(db, t0);
    const [b] = openStop();
    ruleBriefing(db, b?.id ?? -1, 'noted', '', t0);
    creditsPass(db, at(MIN));
    expect(dispatchGate(db, cfg, at(MIN))).toBe('stopped');
    const again = openStop();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(b?.id);
  });

  test('Resume runs on credits until the 5-hour reset at most, and withdraws nothing it should not', () => {
    // The 5-hour window is exhausted and resets in 2 h: the horizon is that.
    const fiveOut = onCredits({
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: iso(2 * H) } },
    });
    noteOverage(db, cfg, drop('d1'), fiveOut, null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    expect(creditsPass(db, at(MIN))).toBe(1);
    expect(dispatchGate(db, cfg, at(MIN))).toBe('credits_resume');
    expect(getUsageState(db)).toMatchObject({
      overageStoppedAt: null,
      overageResumeUntil: iso(2 * H),
      overageResumeDropId: 'd1',
    });
    expect(openStop()).toHaveLength(0);
    // Applied once.
    expect(creditsPass(db, at(2 * MIN))).toBe(0);
  });

  test('the horizon is five hours when the 5-hour reset is later or unknown', () => {
    noteOverage(db, cfg, drop('d1'), onCredits({ unifiedWindows: undefined }), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(getUsageState(db).overageResumeUntil).toBe(iso(MIN + 5 * H));
  });

  test('within the horizon the bound drop and its item run on; a second drop stops again', () => {
    const d1 = drop('d1', 'implement', w.item(1));
    noteOverage(db, cfg, d1, onCredits(), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(noteOverage(db, cfg, d1, onCredits(), null, at(2 * MIN))).toBe(false);
    db.prepare(`UPDATE drops SET state = 'succeeded' WHERE id = 'd1'`).run();
    const sameItem = drop('d1b', 'review', d1.workItemId);
    expect(noteOverage(db, cfg, sameItem, onCredits(), null, at(3 * MIN))).toBe(false);
    expect(dispatchGate(db, cfg, at(3 * MIN))).toBe('credits_resume');
    const other = drop('d2', 'crew-lead');
    expect(noteOverage(db, cfg, other, onCredits(), null, at(4 * MIN))).toBe(true);
    expect(dispatchGate(db, cfg, at(4 * MIN))).toBe('stopped');
    creditsPass(db, at(5 * MIN));
    const [b] = openStop();
    expect(b?.subject).toBe('credits:stop:d2');
    expect(b?.why).toContain('confirmed by a second drop');
  });

  test('after the horizon even the bound drop stops again', () => {
    const d1 = drop('d1');
    noteOverage(db, cfg, d1, onCredits(), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(noteOverage(db, cfg, d1, onCredits(), null, at(5 * H + 2 * MIN))).toBe(true);
  });

  test('a Resume ruled on an older stop is a no-op recorded as stale', () => {
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    creditsPass(db, t0);
    const old = openStop()[0];
    // The stop lifts at its reset; another drop stops again before the old briefing is ruled.
    noteOverage(db, cfg, drop('d2', 'crew-lead'), onCredits(), null, at(5 * H));
    ruleBriefing(db, old?.id ?? -1, 'resume', '', at(5 * H));
    creditsPass(db, at(5 * H + MIN));
    expect(dispatchGate(db, cfg, at(5 * H + MIN))).toBe('stopped');
    const [r] = listRulings(db, 'main');
    expect(r?.applyError).toMatch(/stale/);
    expect(openStop().map((b) => b.subject)).toEqual(['credits:stop:d2']);
  });

  test('a Resume applies whatever the zone mode (no zone config is read); the zone path skips it', async () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    creditsPass(db, t0);
    setZoneMode(db, 'main', 'paused', t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    const deps = { forges: () => w.forges, zone: () => w.zone };
    expect(await applyPendingRulings(db, deps, 'main', at(MIN))).toBe(0);
    expect(dispatchGate(db, cfg, at(MIN))).toBe('stopped');
    expect(creditsPass(db, at(MIN))).toBe(1);
    expect(dispatchGate(db, cfg, at(MIN))).toBe('credits_resume');
  });

  test('a Resume ruled while killed applies after unkill', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    setKilled(db, true, t0);
    expect(creditsPass(db, at(MIN))).toBe(0);
    expect(creditsStopInForce(getUsageState(db), at(MIN))).toBe(true);
    // No second briefing while the Resume waits.
    expect(listBriefings(db).filter((b) => b.subject.startsWith('credits:stop:'))).toHaveLength(1);
    setKilled(db, false, at(2 * MIN));
    expect(creditsPass(db, at(2 * MIN))).toBe(1);
    expect(creditsStopInForce(getUsageState(db), at(2 * MIN))).toBe(false);
  });
});

describe('with Fable and the old overage briefing', () => {
  const fable = {
    claude: { plan: 'max' as const, fableModel: 'claude-fable-1', fableWeeklyDropCap: 5 },
  };

  test('a Fable drop on credits raises both; ruling one leaves the other', () => {
    insertDrop(db, {
      id: 'f1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'diagnose',
      state: 'running',
    });
    db.prepare(`UPDATE drops SET requested_model = 'claude-fable-1' WHERE id = 'f1'`).run();
    const f1 = {
      id: 'f1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'diagnose',
      requestedModel: 'claude-fable-1',
    } as Drop;
    const result = { status: 'completed' as const, gates: [], rateLimit: onCredits() };
    noteOverage(db, cfg, f1, onCredits(), 'completed', t0);
    noteFableSignals(db, { ...fable, usage: cfg }, f1, result, t0);
    creditsPass(db, t0);
    const subjects = listBriefings(db, { state: 'open' })
      .map((b) => b.subject)
      .sort();
    expect(subjects).toEqual(['credits:fable', 'credits:stop:f1']);
    const fableB = listBriefings(db, { state: 'open' }).find((b) => b.subject === 'credits:fable');
    ruleBriefing(db, fableB?.id ?? -1, 'enable', '', t0);
    creditsPass(db, at(MIN));
    expect(getFableState(db).disabledReason).toBeNull();
    expect(dispatchGate(db, cfg, at(MIN))).toBe('stopped');
    expect(openStop()).toHaveLength(1);
  });

  test('stopOnOverage true raises no credits:overage; false raises it and leaves the gate open', () => {
    const d = drop('d1');
    const result = { status: 'completed' as const, gates: [], rateLimit: onCredits() };
    noteFableSignals(db, { ...fable, usage: cfg }, d, result, t0);
    expect(listBriefings(db, { state: 'open' })).toEqual([]);
    const off = { ...cfg, stopOnOverage: false };
    noteOverage(db, off, d, onCredits(), 'completed', t0);
    noteFableSignals(db, { ...fable, usage: off }, d, result, t0);
    creditsPass(db, t0);
    expect(listBriefings(db, { state: 'open' }).map((b) => b.subject)).toEqual(['credits:overage']);
    expect(dispatchGate(db, off, t0)).toBe('open');
  });
});

describe('review fixes', () => {
  /** The five-hour window is the exhausted one; the weekly window binds (`rateLimitType`). */
  const fiveHourOut = (o: Partial<RateLimitEventData> = {}): RateLimitEventData =>
    onCredits({
      unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: iso(30 * MIN) },
        seven_day: { utilization: 0.7, resetsAt: iso(3 * DAY) },
      },
      ...o,
    });

  test('C1: a result never starts a stop for a drop already seen on credits; it may extend one', () => {
    // 15:30: X reports live; the five-hour window resets at 16:00.
    const x = drop('x');
    expect(noteOverage(db, cfg, x, fiveHourOut(), null, t0)).toBe(true);
    expect(getUsageState(db).overageUntil).toBe(iso(30 * MIN));
    // 16:20: X's result, flag kept, windows after the reset, the weekly window binding.
    const after = onCredits({
      unifiedWindows: {
        five_hour: { utilization: 0.05, resetsAt: iso(5 * H) },
        seven_day: { utilization: 0.72, resetsAt: iso(3 * DAY) },
      },
    });
    expect(noteOverage(db, cfg, x, after, 'completed', at(50 * MIN))).toBe(false);
    expect(dispatchGate(db, cfg, at(50 * MIN))).not.toBe('stopped');
    creditsPass(db, at(50 * MIN));
    expect(openStop()).toEqual([]);
  });

  test('C1: a result from a drop seen live may extend the stop in force', () => {
    const x = drop('x');
    noteOverage(db, cfg, x, fiveHourOut(), null, t0);
    const later = fiveHourOut({
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: iso(H) } },
    });
    noteOverage(db, cfg, x, later, 'completed', at(10 * MIN));
    expect(getUsageState(db).overageUntil).toBe(iso(H));
  });

  test('I3: a window at 98% or more counts as exhausted, and the why names it', () => {
    const near = onCredits({
      unifiedWindows: {
        five_hour: { utilization: 0.99, resetsAt: iso(2 * H) },
        seven_day: { utilization: 0.6, resetsAt: iso(3 * DAY) },
      },
    });
    noteOverage(db, cfg, drop('d1'), near, null, t0);
    expect(getUsageState(db).overageUntil).toBe(iso(2 * H));
    creditsPass(db, t0);
    expect(openStop()[0]?.why).toContain('Stopped until the 5-hour window resets: it is at 99%.');
  });

  test('I3: a Fable limit type never lends its reset; the fallback is named', () => {
    const fable = {
      status: 'allowed' as const,
      rateLimitType: 'seven_day_fable',
      resetsAt: iso(4 * DAY),
      isUsingOverage: true,
    };
    noteOverage(db, cfg, drop('d1'), fable, null, t0);
    expect(getUsageState(db).overageUntil).toBe(iso(5 * H));
    creditsPass(db, t0);
    expect(openStop()[0]?.why).toContain('Stopped for five hours: no window reported as exhausted');
  });

  test('M2: with the weekly window exhausted a Resume runs five hours; with the 5-hour one, to its reset', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0); // weekly at 100%, 5-hour resets in 2 h
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(getUsageState(db).overageResumeUntil).toBe(iso(MIN + 5 * H));

    const b = zoneWorld();
    const d = { id: 'e1', dropZoneId: 'main', workItemId: null, role: 'x' } as Drop;
    noteOverage(b.db, cfg, d, fiveHourOut(), null, t0);
    creditsPass(b.db, t0);
    const [open] = listBriefings(b.db, { state: 'open' });
    expect(open?.options[0]?.label).toBe('Run on credits now (until 2026-03-02 10:30 UTC)');
    ruleBriefing(b.db, open?.id ?? -1, 'resume', '', t0);
    creditsPass(b.db, at(MIN));
    expect(getUsageState(b.db).overageResumeUntil).toBe(iso(30 * MIN));
  });

  test('M1: a five-hour fallback names no time, so the open briefing is not rewritten each pass', () => {
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    creditsPass(db, t0);
    const [first] = openStop();
    expect(first?.options[0]?.label).toBe('Run on credits now (at most 5 hours)');
    creditsPass(db, at(10 * MIN));
    expect(openStop()[0]?.updatedAt).toBe(first?.updatedAt);
  });

  test('I1: a lifted stop probes with one drop until a live in-plan report', () => {
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 4 });
    noteOverage(db, cfg, drop('d1'), fiveHourOut(), null, t0);
    for (const n of [1, 2, 3]) {
      insertDrop(db, {
        id: `q${n}`,
        dropZoneId: 'main',
        workItemId: w.item(n),
        role: 'implement',
        state: 'queued',
      });
    }
    const lifted = at(31 * MIN);
    creditsPass(db, lifted);
    expect(dispatchGate(db, cfg, lifted)).toBe('probe');
    const probe = leaseNextDrop(db, 's1', lifted, dispatchGate(db, cfg, lifted));
    expect(probe).not.toBeNull();
    expect(leaseNextDrop(db, 's1', lifted, dispatchGate(db, cfg, lifted))).toBeNull();
    // A result's in-plan report does not count (its time is unknown); a live one does.
    const inPlan = { status: 'allowed' as const, isUsingOverage: false };
    const pd = {
      id: probe?.dropId ?? '',
      dropZoneId: 'main',
      workItemId: null,
      role: 'implement',
    } as Drop;
    noteOverage(db, cfg, pd, inPlan, 'completed', at(32 * MIN));
    expect(dispatchGate(db, cfg, at(32 * MIN))).toBe('probe');
    noteOverage(db, cfg, pd, inPlan, null, at(33 * MIN));
    expect(dispatchGate(db, cfg, at(33 * MIN))).toBe('open');
  });

  test('I1: the end of a Resume horizon also probes', () => {
    noteOverage(db, cfg, drop('d1'), fiveHourOut(), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(dispatchGate(db, cfg, at(30 * MIN))).toBe('probe');
  });

  test('I2/N1: during a Resume only the bound item leases; with none queued, nothing', () => {
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 4 });
    const bound = w.item(1);
    const d1 = drop('d1', 'implement', bound);
    noteOverage(db, cfg, d1, onCredits(), null, t0);
    db.prepare(`UPDATE drops SET state = 'succeeded' WHERE id = 'd1'`).run();
    // Older unrelated work, then the bound item's review.
    insertDrop(db, {
      id: 'old',
      dropZoneId: 'main',
      workItemId: w.item(2),
      role: 'review',
      state: 'queued',
      createdAt: iso(-H),
    });
    insertDrop(db, {
      id: 'old2',
      dropZoneId: 'main',
      workItemId: w.item(3),
      role: 'implement',
      state: 'queued',
      createdAt: iso(-H),
    });
    insertDrop(db, {
      id: 'mine',
      dropZoneId: 'main',
      workItemId: bound,
      role: 'review',
      state: 'queued',
      createdAt: iso(MIN),
    });
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    const now = at(2 * MIN);
    creditsPass(db, now);
    const lease = () => leaseNextDrop(db, 's1', now, dispatchGate(db, cfg, now))?.dropId ?? null;
    expect(dispatchGate(db, cfg, now)).toBe('credits_resume');
    expect(lease()).toBe('mine');
    // The bound item has nothing queued now: nothing leases, no probe.
    expect(lease()).toBeNull();
    expect(lease()).toBeNull();
    // And no new implement work is queued during the horizon.
    expect(gateQueuesImplement(dispatchGate(db, cfg, now))).toBe(false);
  });

  test('N1: a Resume bound to a crew drop leases nothing', () => {
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 4 });
    noteOverage(db, cfg, drop('c1', 'crew-lead'), onCredits(), null, t0);
    insertDrop(db, {
      id: 'q',
      dropZoneId: 'main',
      workItemId: w.item(2),
      role: 'review',
      state: 'queued',
    });
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    creditsPass(db, at(MIN));
    expect(leaseNextDrop(db, 's1', at(MIN), dispatchGate(db, cfg, at(MIN)))).toBeNull();
  });

  test('N2: the probe drop finishing off credits ends probing', () => {
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 4 });
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    insertDrop(db, {
      id: 'p',
      dropZoneId: 'main',
      workItemId: w.item(2),
      role: 'review',
      state: 'queued',
    });
    const lifted = at(5 * H);
    creditsPass(db, lifted);
    expect(leaseNextDrop(db, 's1', lifted, dispatchGate(db, cfg, lifted))?.dropId).toBe('p');
    const p = { id: 'p', dropZoneId: 'main', workItemId: w.item(2), role: 'review' } as Drop;
    // Another drop's result proves nothing; the probe's does.
    noteProbeResult(db, drop('other', 'crew-lead'), { status: 'completed', gates: [] }, lifted);
    expect(dispatchGate(db, cfg, lifted)).toBe('probe');
    noteProbeResult(db, p, { status: 'completed', gates: [] }, lifted);
    expect(dispatchGate(db, cfg, lifted)).toBe('open');
  });

  test('N2: a probe drop seen on credits does not end probing', () => {
    insertStick(db, { id: 's1', name: 's', tokenHash: 'h', slots: 4 });
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    insertDrop(db, {
      id: 'p',
      dropZoneId: 'main',
      workItemId: w.item(2),
      role: 'review',
      state: 'queued',
    });
    const lifted = at(5 * H);
    creditsPass(db, lifted);
    leaseNextDrop(db, 's1', lifted, dispatchGate(db, cfg, lifted));
    const p = { id: 'p', dropZoneId: 'main', workItemId: w.item(2), role: 'review' } as Drop;
    db.prepare(
      `INSERT INTO credit_drops (drop_id, zone_id, first_at, last_at) VALUES ('p', 'main', 'x', 'x')`,
    ).run();
    noteProbeResult(db, p, { status: 'completed', gates: [] }, lifted);
    expect(dispatchGate(db, cfg, lifted)).toBe('probe');
  });

  test('N2: with stopOnOverage false the gate never probes', () => {
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    creditsPass(db, at(5 * H));
    expect(dispatchGate(db, cfg, at(5 * H))).toBe('probe');
    expect(dispatchGate(db, { ...cfg, stopOnOverage: false }, at(5 * H))).toBe('open');
  });

  test('an extension refreshes the window and reason, so why and decision agree', () => {
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: { five_hour: { utilization: 1, resetsAt: iso(H) } } }),
      null,
      t0,
    );
    noteOverage(db, cfg, drop('d2', 'crew-lead'), onCredits(), null, at(MIN));
    expect(getUsageState(db).overageUntil).toBe(iso(3 * DAY));
    creditsPass(db, at(2 * MIN));
    const [b] = openStop();
    expect(b?.why).toContain('Stopped until the 7-day window resets');
    expect(b?.decision).toContain(iso(3 * DAY));
  });

  test('an in-plan event older than the lift does not end probing', () => {
    noteOverage(
      db,
      cfg,
      drop('d1'),
      onCredits({ unifiedWindows: undefined, resetsAt: undefined }),
      null,
      t0,
    );
    const lifted = at(5 * H);
    creditsPass(db, lifted);
    const d2 = drop('d2', 'crew-lead');
    const inPlan = { status: 'allowed' as const, isUsingOverage: false };
    noteOverage(db, cfg, d2, inPlan, null, at(5 * H + MIN), at(H));
    expect(dispatchGate(db, cfg, at(5 * H + MIN))).toBe('probe');
    noteOverage(db, cfg, d2, inPlan, null, at(5 * H + MIN), at(5 * H + MIN));
    expect(dispatchGate(db, cfg, at(5 * H + MIN))).toBe('open');
  });
});
