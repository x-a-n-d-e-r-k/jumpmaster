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
import { creditsPass, creditsStopInForce, noteOverage, syncCreditsBriefing } from './credits.js';
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
import { dispatchGate, ingestRateLimit } from './usage.js';

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
    expect(dispatchGate(db, cfg, at(3 * DAY))).toBe('open');
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
    expect(dispatchGate(db, cfg, at(5 * H))).toBe('open');
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
    // The horizon is the 5-hour reset (2 h away), never the weekly one.
    expect(b?.options[0]?.label).toMatch(/credits/);
    expect(b?.options[0]?.label).toContain('2026-03-02 12:00');
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
    // The 5-hour window resets in 2 h: the horizon is that, not the weekly reset 3 days away.
    noteOverage(db, cfg, drop('d1'), onCredits(), null, t0);
    creditsPass(db, t0);
    ruleBriefing(db, openStop()[0]?.id ?? -1, 'resume', '', t0);
    expect(creditsPass(db, at(MIN))).toBe(1);
    expect(dispatchGate(db, cfg, at(MIN))).toBe('open');
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
    expect(dispatchGate(db, cfg, at(3 * MIN))).toBe('open');
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
    expect(noteOverage(db, cfg, d1, onCredits(), null, at(2 * H))).toBe(true);
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
    expect(dispatchGate(db, cfg, at(MIN))).toBe('open');
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
