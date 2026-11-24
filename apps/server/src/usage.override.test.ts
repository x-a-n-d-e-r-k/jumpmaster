import type { RateLimitEventData } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import type { UsageConfig } from './config.js';
import { noteOverage } from './credits.js';
import type { Db } from './db/open.js';
import {
  type Drop,
  getDrop,
  getUsageState,
  insertDrop,
  recordUsageWindows,
  setKilled,
  setUsageState,
  setWorkItemState,
  upsertWorkItem,
} from './db/repo.js';
import { doctorMayLease, leaseNextDrop } from './leases.js';
import { seedQueuedDrop, t0 } from './test/helpers.js';
import {
  clearUsageOverride,
  dispatchGate,
  gateQueuesCrew,
  gateQueuesImplement,
  ingestRateLimit,
  OVERRIDE_CEILING,
  refundOverrideStart,
  setUsageOverride,
  throttleHolds,
  usageOverride,
} from './usage.js';

const H = 3_600_000;
const at = (ms: number): Date => new Date(t0.getTime() + ms);
const iso = (ms: number): string => at(ms).toISOString();
const cfg: UsageConfig = { throttleUtilization: 0.9, probeJitterSeconds: [0, 0] };

let db: Db;
beforeEach(() => {
  db = seedQueuedDrop(); // d1, an implement-class drop, queued in zone `main`, stick s1
  db.prepare("UPDATE drops SET role = 'implement' WHERE id = 'd1'").run();
});

/**
 * Claude's warning, as a live report leaves it: a stored five_hour warning with no reset, and no
 * five_hour utilization reported, so it holds for five hours from the report (#748).
 */
const warned = (over: Parameters<typeof setUsageState>[1] = {}) =>
  setUsageState(
    db,
    {
      status: 'allowed_warning',
      warningWindow: 'five_hour',
      warningAt: iso(0),
      warningResetsAt: null,
      sevenDayUtil: 0.81,
      sevenDayResetsAt: iso(36 * H),
      ...over,
    },
    t0,
  );
/** Seeds the account's reported usage windows, as a report's ingest stores them (#738). */
const windows = (w: Parameters<typeof recordUsageWindows>[1]) =>
  recordUsageWindows(db, w, t0, null);
const grant = (starts = 5, hours = 3) => setUsageOverride(db, { starts, hours, by: 'token' }, t0);
/** Queues a drop: one of an item's roles on an item of its own, a crew or doctor drop on none. */
const queue = (id: string, role: string, ms: number) => {
  let workItemId: number | null = null;
  if (['implement', 'review', 'heal', 'resolve'].includes(role)) {
    const wi = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 100 + ms,
      title: id,
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setWorkItemState(db, wi.id, 'in_flight');
    workItemId = wi.id;
  }
  insertDrop(db, { id, dropZoneId: 'main', workItemId, role, state: 'queued', createdAt: iso(ms) });
};
const report = (o: Partial<RateLimitEventData>): RateLimitEventData => ({
  status: 'allowed_warning',
  rateLimitType: 'seven_day',
  resetsAt: iso(36 * H),
  ...o,
});
const src = { dropId: 'd1', workItemId: 1, startedAt: iso(0), outcome: null };

describe('the usage override and the gate (#728)', () => {
  test('a warning holds dispatch, and an override opens it', () => {
    warned();
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
    expect(throttleHolds(db, cfg, t0)).toBe(true);
    grant();
    expect(dispatchGate(db, cfg, t0)).toBe('override');
    expect(throttleHolds(db, cfg, t0)).toBe(true);
    expect(gateQueuesImplement('override')).toBe(true);
    expect(gateQueuesCrew('override')).toBe(true);
    expect(doctorMayLease('override')).toBe(true);
  });

  test('a warning does not hold while its window reports utilization under the threshold (#748)', () => {
    ingestRateLimit(
      db,
      report({ unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: iso(36 * H) } } }),
      src,
      cfg,
      t0,
    );
    expect(throttleHolds(db, cfg, t0)).toBe(false);
    expect(dispatchGate(db, cfg, t0)).toBe('open');
  });

  test('with no throttle the gate is open, never override', () => {
    grant();
    expect(dispatchGate(db, cfg, t0)).toBe('open');
    expect(throttleHolds(db, cfg, t0)).toBe(false);
  });

  test('the time limit and the start count each end it', () => {
    warned();
    grant(5, 3);
    expect(dispatchGate(db, cfg, at(3 * H - 1))).toBe('override');
    expect(dispatchGate(db, cfg, at(3 * H))).toBe('finishing_only');
    grant(1, 3);
    setUsageState(db, { overrideStartsLeft: 0 }, t0);
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
  });

  test('a stop, a pause, a probe and a credits Resume all win over an override', () => {
    warned();
    grant();
    setUsageState(db, { pausedUntil: iso(H) }, t0);
    expect(dispatchGate(db, cfg, t0)).toBe('closed');
    setUsageState(db, { pausedUntil: null, status: 'rejected' }, t0);
    expect(dispatchGate(db, cfg, t0)).toBe('probe');
    warned({ overageResumeUntil: iso(H), overageResumeWorkItemId: 1 });
    expect(dispatchGate(db, cfg, t0)).toBe('credits_resume');
    warned({ overageResumeUntil: null, overageStoppedAt: iso(0), overageUntil: iso(H) });
    expect(dispatchGate(db, cfg, t0)).toBe('stopped');
  });

  test('stored usage at the ceiling is not overridden; a window that has reset does not count', () => {
    warned();
    windows({ seven_day: { utilization: OVERRIDE_CEILING, resetsAt: iso(36 * H) } });
    grant();
    expect(usageOverride(db, t0)).toBeNull();
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
    windows({
      seven_day: { utilization: 0.5, resetsAt: iso(36 * H) },
      five_hour: { utilization: 0.97, resetsAt: iso(H) },
    });
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
    // The five-hour window is over: its old figure holds nothing back.
    windows({
      seven_day: { utilization: 0.5, resetsAt: iso(36 * H) },
      five_hour: { utilization: 0.97, resetsAt: iso(-1) },
    });
    expect(dispatchGate(db, cfg, t0)).toBe('override');
    // So too the seven-day one, once its reset has passed.
    windows({ seven_day: { utilization: 0.97, resetsAt: iso(-1) } });
    expect(dispatchGate(db, cfg, t0)).toBe('override');
  });

  test('a ceiling read from an account window other than five_hour or seven_day ends it (#738)', () => {
    warned();
    grant();
    windows({
      seven_day: { utilization: 0.5, resetsAt: iso(36 * H) },
      seven_day_oauth_apps: { utilization: 0.94, resetsAt: iso(36 * H) },
    });
    expect(dispatchGate(db, cfg, t0)).toBe('override');
    windows({
      seven_day: { utilization: 0.5, resetsAt: iso(36 * H) },
      seven_day_oauth_apps: { utilization: OVERRIDE_CEILING, resetsAt: iso(36 * H) },
    });
    expect(usageOverride(db, t0)).toBeNull();
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
    // A per-model window at the ceiling is not the account's: the override stands.
    windows({
      seven_day: { utilization: 0.5, resetsAt: iso(36 * H) },
      seven_day_fable: { utilization: 0.99, resetsAt: iso(36 * H) },
      seven_day_overage_included: { utilization: 0.99, resetsAt: iso(36 * H) },
    });
    expect(dispatchGate(db, cfg, t0)).toBe('override');
  });

  test('the ceiling is fixed: raising the throttle setting, as chat can, does not raise it', () => {
    warned();
    windows({ seven_day: { utilization: 0.95, resetsAt: iso(36 * H) } });
    grant();
    for (const throttleUtilization of [0.96, 1])
      expect(dispatchGate(db, { ...cfg, throttleUtilization }, t0)).toBe('finishing_only');
  });

  test('an unreadable override is not in force', () => {
    warned();
    grant();
    setUsageState(db, { overrideUntil: 'not a time' }, t0);
    expect(usageOverride(db, t0)).toBeNull();
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
  });

  test('it reports what is left, and clearing ends it', () => {
    grant(5, 3);
    expect(usageOverride(db, t0)).toEqual({ startsLeft: 5, starts: 5, until: iso(3 * H) });
    expect(getUsageState(db).overrideBy).toBe('token');
    clearUsageOverride(db, t0);
    expect(usageOverride(db, t0)).toBeNull();
    expect(getUsageState(db)).toMatchObject({
      overrideUntil: null,
      overrideStarts: null,
      overrideStartsLeft: null,
      overrideBy: null,
    });
  });
});

describe('counting starts (#728)', () => {
  const left = () => getUsageState(db).overrideStartsLeft;

  test('an implement and a crew lead each take one start, at the lease', () => {
    warned();
    grant(3);
    queue('c1', 'crew-lead', 10);
    expect(left()).toBe(3);
    expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId).toBe('d1');
    expect(left()).toBe(2);
    expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId).toBe('c1');
    expect(left()).toBe(1);
  });

  test.each(['refute', 'triage', 'diagnose', 'arbitrate', 'audit'])(
    'a %s drop takes one',
    (role) => {
      warned();
      grant(2);
      db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
      queue('c1', role, 10);
      expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId).toBe('c1');
      expect(left()).toBe(1);
    },
  );

  test('review, heal, resolve and doctor drops take none', () => {
    warned();
    grant(2);
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
    for (const [i, role] of ['review', 'heal', 'resolve', 'doctor'].entries()) {
      queue(`q${i}`, role, i);
      expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId).toBe(`q${i}`);
    }
    expect(left()).toBe(2);
  });

  test('the gate open for its own reasons takes none', () => {
    grant(2);
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('d1');
    expect(left()).toBe(2);
  });

  test('a gate read before the last start was taken leases only once (D3)', () => {
    warned();
    grant(1);
    queue('i2', 'implement', 10);
    const gate = dispatchGate(db, cfg, t0);
    expect(gate).toBe('override');
    expect(leaseNextDrop(db, 's1', t0, gate)?.dropId).toBe('d1');
    expect(leaseNextDrop(db, 's1', t0, gate)).toBeNull();
    expect(left()).toBe(0);
    expect(getDrop(db, 'i2')?.state).toBe('queued');
  });

  test('with no start left, finishing work and a doctor drop still lease', () => {
    warned();
    grant(1);
    setUsageState(db, { overrideStartsLeft: 0 }, t0);
    queue('doc', 'doctor', 20);
    expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId).toBe('doc');
    for (const [i, role] of ['review', 'heal', 'resolve'].entries()) {
      queue(`f${i}`, role, 30 + i);
      expect(leaseNextDrop(db, 's1', t0, 'override')?.dropId, role).toBe(`f${i}`);
    }
    expect(getDrop(db, 'd1')?.state).toBe('queued');
  });

  test('an override past its time leases no new work under a stale gate', () => {
    warned();
    grant(5, 1);
    expect(leaseNextDrop(db, 's1', at(H), 'override')).toBeNull();
    expect(left()).toBe(5);
  });

  test('a start is given back to the grant it came from, and to no other, never past the grant', () => {
    warned();
    grant(2);
    const taken = leaseNextDrop(db, 's1', t0, 'override');
    expect(taken?.overrideUntil).toBe(iso(3 * H));
    expect(left()).toBe(1);
    refundOverrideStart(db, taken?.overrideUntil, t0);
    expect(left()).toBe(2);
    refundOverrideStart(db, taken?.overrideUntil, t0);
    expect(left()).toBe(2);
    // A newer grant is not topped up by an older one's drop, nor a cleared one brought back.
    setUsageOverride(db, { starts: 5, hours: 6, by: 'token' }, t0);
    setUsageState(db, { overrideStartsLeft: 1 }, t0);
    refundOverrideStart(db, taken?.overrideUntil, t0);
    expect(left()).toBe(1);
    clearUsageOverride(db, t0);
    refundOverrideStart(db, iso(3 * H), t0);
    expect(left()).toBeNull();
    // A drop that took no start has none to give.
    grant(2);
    setUsageState(db, { overrideStartsLeft: 1 }, t0);
    refundOverrideStart(db, undefined, t0);
    expect(left()).toBe(1);
  });

  test('a lease that took no start says so', () => {
    expect(leaseNextDrop(db, 's1', t0, 'open')).toEqual({ dropId: 'd1', epoch: 1 });
  });

  test('the kill switch and a paused zone still win', () => {
    warned();
    grant();
    db.prepare(
      "INSERT INTO zone_controls (zone_id, mode, updated_at) VALUES ('main', 'paused', ?)",
    ).run(iso(0));
    expect(leaseNextDrop(db, 's1', t0, 'override')).toBeNull();
    db.prepare('DELETE FROM zone_controls').run();
    setKilled(db, true, t0);
    expect(leaseNextDrop(db, 's1', t0, 'override')).toBeNull();
    expect(left()).toBe(5);
  });
});

describe('an override ends early (#728)', () => {
  const inForce = () => usageOverride(db, t0) !== null;

  test('a report at the ceiling clears it, on either window; one under it does not', () => {
    for (const key of ['seven_day', 'five_hour'] as const) {
      grant();
      ingestRateLimit(
        db,
        report({ unifiedWindows: { [key]: { utilization: 0.94, resetsAt: iso(H) } } }),
        src,
        cfg,
        t0,
      );
      expect(inForce(), key).toBe(true);
      ingestRateLimit(
        db,
        report({ unifiedWindows: { [key]: { utilization: 0.95, resetsAt: iso(H) } } }),
        src,
        cfg,
        t0,
      );
      expect(getUsageState(db).overrideUntil, key).toBeNull();
      setUsageState(db, { sevenDayUtil: null, fiveHourUtil: null }, t0);
    }
  });

  test('a report of a window that has already reset does not clear it; one with no reset does', () => {
    grant();
    const over = (resetsAt?: string) =>
      ingestRateLimit(
        db,
        report({
          unifiedWindows: { five_hour: { utilization: 0.96, ...(resetsAt ? { resetsAt } : {}) } },
        }),
        src,
        cfg,
        t0,
      );
    over(iso(-60_000));
    expect(getUsageState(db).overrideUntil).not.toBeNull();
    over();
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test("a Fable-typed report's account windows count toward the ceiling", () => {
    grant();
    ingestRateLimit(
      db,
      report({
        rateLimitType: 'seven_day_fable',
        unifiedWindows: { seven_day: { utilization: 0.99, resetsAt: iso(H) } },
      }),
      src,
      cfg,
      t0,
    );
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test('a refusal clears it, from a live report too', () => {
    grant();
    ingestRateLimit(db, report({ status: 'rejected' }), src, cfg, t0);
    expect(getUsageState(db).overrideUntil).toBeNull();
  });

  test('another warning does not clear it', () => {
    warned();
    grant();
    ingestRateLimit(
      db,
      // Warned on five_hour, which it does not report: the warning still holds (#748).
      report({
        rateLimitType: 'five_hour',
        unifiedWindows: { seven_day: { utilization: 0.82, resetsAt: iso(36 * H) } },
      }),
      src,
      cfg,
      t0,
    );
    expect(dispatchGate(db, cfg, t0)).toBe('override');
  });

  test('a Fable-only refusal pauses Fable and leaves the override', () => {
    grant();
    ingestRateLimit(
      db,
      { status: 'rejected', rateLimitType: 'seven_day_fable', resetsAt: iso(H) },
      src,
      cfg,
      t0,
    );
    expect(inForce()).toBe(true);
  });

  test('entering the credits stop clears it', () => {
    grant();
    const drop = { id: 'd1', dropZoneId: 'main', workItemId: 1, role: 'implement' } as Drop;
    expect(
      noteOverage(
        db,
        cfg,
        drop,
        report({
          status: 'allowed',
          unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: iso(36 * H) } },
          isUsingOverage: true,
          overageStatus: 'allowed',
        }),
        null,
        t0,
      ),
    ).toBe(true);
    expect(getUsageState(db).overrideUntil).toBeNull();
    expect(dispatchGate(db, cfg, t0)).toBe('stopped');
  });
});
