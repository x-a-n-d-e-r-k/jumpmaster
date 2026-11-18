import type { DropResult, RateLimitEventData } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import {
  activeDropFor,
  getAttempts,
  getDrop,
  getUsageState,
  insertDrop,
  insertStick,
  listUsageWindows,
  type NewDrop,
  setUsageState,
  setWorkItemState,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import { expireLeases, leaseNextDrop } from './leases.js';
import { applyResult, type ResultDeps } from './results.js';
import { enqueueImplement, enqueueNext } from './scheduler.js';
import { fakeForgePair } from './test/fakes.js';
import { tmpDbFile } from './test/helpers.js';
import {
  dispatchGate,
  ingestRateLimit,
  type RateLimitSource,
  rateLimitFromEvent,
  releaseProbe,
} from './usage.js';

// This file declares its own clock.
const t0 = new Date('2026-10-20T11:00:00Z');
const at = (hms: string): Date => new Date(`2026-10-20T${hms}Z`);
const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const future = '2026-10-20T12:00:00Z';

const cfg: UsageConfig = { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] };
const zero = (): number => 0;

const zone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 200,
  models: {},
  budgets: {
    maxHeal: 3,
    maxResolve: 2,
    maxResolveTotal: 6,
    maxResume: 2,
    maxReviewRepeat: 2,
    maxNoChange: 1,
    maxBaseSync: 12,
  },
  ciRequired: true,
  ciDeadlineMinutes: 45,
  retryLabel: 'agent-retry',
  mergeMethod: 'squash',
  requireBranchProtection: true,
  protectedPaths: [],
  reviewReadToken: false,
};

const rej = (resetsAt?: string, rateLimitType = 'five_hour'): RateLimitEventData => ({
  status: 'rejected',
  ...(resetsAt ? { resetsAt } : {}),
  rateLimitType,
});
const src = (
  dropId: string,
  outcome: DropResult['status'] | null,
  startedAt: string | null = t0.toISOString(),
  workItemId = 1,
): RateLimitSource => ({ dropId, workItemId, startedAt, outcome });

let db: Db;
let seq = 0;

function item(issue: number, state: 'ready' | 'in_flight' | 'pr_open' = 'in_flight'): number {
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: issue,
    title: `t${issue}`,
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(db, wi.id, state);
  return wi.id;
}

function drop(d: Partial<NewDrop> & { id: string; workItemId: number }): string {
  seq += 1;
  insertDrop(db, {
    dropZoneId: 'main',
    role: 'implement',
    state: 'queued',
    createdAt: new Date(t0.getTime() + seq).toISOString(),
    ...d,
  });
  return d.id;
}

beforeEach(() => {
  db = openDb(tmpDbFile());
  seq = 0;
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  insertStick(db, { id: 's', name: 'stick', tokenHash: 'h', slots: 2 });
});

describe('ingestRateLimit and dispatchGate', () => {
  test('a confirmed rejected pauses until resetsAt plus jitter', () => {
    ingestRateLimit(db, rej('2026-10-20T12:00:00Z'), src('d1', 'rate_limited'), cfg, t0, zero);
    ingestRateLimit(
      db,
      rej('2026-10-20T12:00:00Z'),
      src('d2', 'rate_limited', t0.toISOString(), 2),
      cfg,
      t0,
      zero,
    );
    expect(dispatchGate(db, cfg, at('12:00:29'))).toBe('closed');
    expect(dispatchGate(db, cfg, at('12:00:31'))).toBe('probe');
  });

  test('a second drop of the same work item never confirms a pause', () => {
    ingestRateLimit(
      db,
      rej('2026-10-27T12:00:00Z', 'seven_day'),
      src('d1', 'rate_limited'),
      cfg,
      t0,
      zero,
    );
    ingestRateLimit(
      db,
      rej('2026-10-27T12:00:00Z', 'seven_day'),
      src('d2', 'rate_limited'),
      cfg,
      t0,
      zero,
    );
    expect(getUsageState(db).pauseConfirmed).toBe(false);
    expect(dispatchGate(db, cfg, plus(t0, H + 1000))).toBe('probe');
  });

  test('a probe re-running the cause item does not confirm a pause', () => {
    ingestRateLimit(
      db,
      rej('2026-10-27T12:00:00Z', 'seven_day'),
      src('d1', 'rate_limited'),
      cfg,
      t0,
      zero,
    );
    setUsageState(db, { probeDropId: 'p1' }, plus(t0, H + 1000));
    const later = plus(t0, H + 2000);
    ingestRateLimit(
      db,
      rej('2026-10-27T12:00:00Z', 'seven_day'),
      src('p1', 'rate_limited', later.toISOString()),
      cfg,
      later,
      zero,
    );
    expect(getUsageState(db).pauseConfirmed).toBe(false);
    expect(dispatchGate(db, cfg, plus(later, H + 1000))).toBe('probe');
  });

  test('an unconfirmed pause is capped at one hour', () => {
    ingestRateLimit(db, rej('2026-10-20T12:00:00Z'), src('d1', 'rate_limited'), cfg, t0, zero);
    expect(getUsageState(db).pauseConfirmed).toBe(false);
    expect(dispatchGate(db, cfg, plus(t0, H - 1000))).toBe('closed');
    expect(dispatchGate(db, cfg, plus(t0, H + 1000))).toBe('probe');
  });

  test('a live event or a completed drop never pauses', () => {
    ingestRateLimit(db, rej(future), src('d1', null), cfg, t0);
    ingestRateLimit(db, rej(future), src('d2', 'completed'), cfg, t0);
    expect(dispatchGate(db, cfg, t0)).toBe('open');
  });

  test('a late allowed from an older drop does not reopen the gate', () => {
    ingestRateLimit(db, rej(future), src('d1', 'rate_limited'), cfg, t0, zero);
    const startedBefore = new Date(t0.getTime() - MIN).toISOString();
    ingestRateLimit(db, { status: 'allowed' }, src('old', null, startedBefore), cfg, plus(t0, MIN));
    expect(dispatchGate(db, cfg, plus(t0, MIN))).toBe('closed');
  });

  test('an allowed from a drop started after the pause clears it', () => {
    ingestRateLimit(db, rej(future), src('d1', 'rate_limited'), cfg, t0, zero);
    const after = plus(t0, MIN).toISOString();
    ingestRateLimit(db, { status: 'allowed' }, src('new', null, after), cfg, plus(t0, 2 * MIN));
    expect(dispatchGate(db, cfg, plus(t0, 2 * MIN))).toBe('open');
    expect(getUsageState(db).pausedUntil).toBeNull();
  });

  test('a far-future resetsAt is clamped to the window', () => {
    ingestRateLimit(db, rej('2099-01-01T00:00:00Z'), src('d1', 'rate_limited'), cfg, t0, zero);
    ingestRateLimit(
      db,
      rej('2099-01-01T00:00:00Z'),
      src('d2', 'rate_limited', t0.toISOString(), 2),
      cfg,
      t0,
      zero,
    );
    expect(dispatchGate(db, cfg, plus(t0, 5 * H + 29_000))).toBe('closed');
    expect(dispatchGate(db, cfg, plus(t0, 5 * H + 31_000))).toBe('probe');
  });

  test('a past resetsAt pauses for one jitter', () => {
    const past = new Date(t0.getTime() - H).toISOString();
    ingestRateLimit(db, rej(past), src('d1', 'rate_limited'), cfg, t0, zero);
    expect(dispatchGate(db, cfg, plus(t0, 29_000))).toBe('closed');
    expect(dispatchGate(db, cfg, plus(t0, 31_000))).toBe('probe');
  });

  test('rejected without a usable resetsAt pauses for one jitter, like a past reset', () => {
    ingestRateLimit(db, rej(), src('d1', 'rate_limited'), cfg, t0, zero);
    expect(dispatchGate(db, cfg, plus(t0, 29_000))).toBe('closed');
    expect(dispatchGate(db, cfg, plus(t0, 31_000))).toBe('probe');
  });

  test('rejected with an unparsable resetsAt pauses too', () => {
    ingestRateLimit(db, rej('not a date'), src('d2', 'rate_limited'), cfg, t0, zero);
    expect(dispatchGate(db, cfg, plus(t0, 29_000))).toBe('closed');
  });

  test('jitter is drawn between the configured bounds, tolerating a reversed pair', () => {
    const reversed: UsageConfig = { throttleUtilization: 0.9, probeJitterSeconds: [90, 30] };
    ingestRateLimit(db, rej(future), src('d1', 'rate_limited'), reversed, t0, () => 1);
    ingestRateLimit(
      db,
      rej(future),
      src('d2', 'rate_limited', t0.toISOString(), 2),
      reversed,
      t0,
      () => 1,
    );
    expect(getUsageState(db).pausedUntil).toBe('2026-10-20T12:01:30.000Z');
  });

  test('utilization at 0.9 throttles', () => {
    ingestRateLimit(
      db,
      { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.9 } } },
      src('d1', null),
      cfg,
      t0,
    );
    expect(dispatchGate(db, cfg, t0)).toBe('finishing_only');
  });

  test('a utilization observed 8 days ago has expired', () => {
    ingestRateLimit(
      db,
      { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.95 } } },
      src('d1', null),
      cfg,
      t0,
    );
    expect(dispatchGate(db, cfg, plus(t0, 6 * DAY))).toBe('finishing_only');
    expect(dispatchGate(db, cfg, plus(t0, 8 * DAY))).toBe('open');
  });

  test('a window resetsAt ends the throttle', () => {
    ingestRateLimit(
      db,
      {
        status: 'allowed',
        unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: '2026-10-20T12:00:00Z' } },
      },
      src('d1', null),
      cfg,
      t0,
    );
    expect(dispatchGate(db, cfg, at('11:59:00'))).toBe('finishing_only');
    expect(dispatchGate(db, cfg, at('12:00:01'))).toBe('open');
  });

  test('a warning throttles for at most five hours', () => {
    ingestRateLimit(db, { status: 'allowed_warning' }, src('d1', null), cfg, t0);
    expect(dispatchGate(db, cfg, plus(t0, 4 * H))).toBe('finishing_only');
    expect(dispatchGate(db, cfg, plus(t0, 5 * H + 1000))).toBe('open');
  });

  test('missing unifiedWindows is not treated as zero', () => {
    ingestRateLimit(
      db,
      { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.95 } } },
      src('d1', null),
      cfg,
      t0,
    );
    ingestRateLimit(db, { status: 'allowed' }, src('d2', null), cfg, plus(t0, MIN));
    expect(getUsageState(db).sevenDayUtil).toBe(0.95);
    expect(dispatchGate(db, cfg, plus(t0, MIN))).toBe('finishing_only');
  });

  test('the raw rate_limit_info fallback is parsed', () => {
    const parsed = rateLimitFromEvent({
      raw: {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1792442400,
          rateLimitType: 'five_hour',
          unifiedWindows: { seven_day: { utilization: 0.15, resetsAt: 1792555200 } },
        },
      },
    });
    expect(parsed).toEqual({
      status: 'rejected',
      resetsAt: new Date(1792442400 * 1000).toISOString(),
      rateLimitType: 'five_hour',
      unifiedWindows: {
        seven_day: { utilization: 0.15, resetsAt: new Date(1792555200 * 1000).toISOString() },
      },
    });
    expect(rateLimitFromEvent({ status: 'allowed' })).toEqual({ status: 'allowed' });
    expect(rateLimitFromEvent({ nonsense: true })).toBeNull();
  });
});

describe('probe and leases', () => {
  function expiredPause(): void {
    ingestRateLimit(db, rej(future), src('c1', 'rate_limited'), cfg, t0, zero);
    setUsageState(db, { pausedUntil: t0.toISOString() }, t0);
  }

  test('probe allows exactly one lease', () => {
    const a = item(1);
    const b = item(2);
    drop({ id: 'x', workItemId: a });
    drop({ id: 'y', workItemId: b });
    expiredPause();
    const now = plus(t0, MIN);
    expect(dispatchGate(db, cfg, now)).toBe('probe');
    expect(leaseNextDrop(db, 's', now, 'probe')).not.toBeNull();
    expect(leaseNextDrop(db, 's', now, 'probe')).toBeNull();
  });

  test('the probe is never the cause item when another item is queued', () => {
    const cause = item(1);
    const other = item(2);
    drop({ id: 'cause-drop', workItemId: cause });
    drop({ id: 'other-drop', workItemId: other });
    ingestRateLimit(db, rej(future), src('c1', 'rate_limited', null, cause), cfg, t0, zero);
    setUsageState(db, { pausedUntil: t0.toISOString() }, t0);
    expect(leaseNextDrop(db, 's', plus(t0, MIN), 'probe')?.dropId).toBe('other-drop');
    expect(getUsageState(db).probeDropId).toBe('other-drop');
  });

  test('with only the cause item queued, its requeued drop leases as the probe', () => {
    const cause = item(1);
    const t1 = '2026-10-20T12:00:00Z';
    ingestRateLimit(db, rej(t1), src('c1', 'rate_limited', null, cause), cfg, t0, zero);
    ingestRateLimit(db, rej(t1), src('c2', 'rate_limited', null, cause), cfg, t0, zero);
    const requeuedId = drop({ id: 'requeued', workItemId: cause });
    expect(leaseNextDrop(db, 's', plus(new Date(t1), 91_000), 'probe')?.dropId).toBe(requeuedId);
    expect(getUsageState(db).probeDropId).toBe(requeuedId);
  });

  test('a probe drop that fails without an event reopens after one jitter', () => {
    const a = item(1);
    drop({ id: 'p', workItemId: a });
    expiredPause();
    const now = plus(t0, MIN);
    leaseNextDrop(db, 's', now, 'probe');
    releaseProbe(db, 'p', cfg, now, zero);
    expect(getUsageState(db).probeDropId).toBeNull();
    expect(dispatchGate(db, cfg, plus(now, 29_000))).toBe('closed');
    expect(dispatchGate(db, cfg, plus(now, 31_000))).toBe('probe');
  });

  test('an allowed from the probe reopens the gate', () => {
    const a = item(1);
    drop({ id: 'p', workItemId: a });
    expiredPause();
    const now = plus(t0, MIN);
    leaseNextDrop(db, 's', now, 'probe');
    ingestRateLimit(db, { status: 'allowed' }, src('p', null, null), cfg, now);
    releaseProbe(db, 'p', cfg, now, zero);
    expect(dispatchGate(db, cfg, now)).toBe('open');
  });

  test('closed leases nothing', () => {
    drop({ id: 'x', workItemId: item(1) });
    expect(leaseNextDrop(db, 's', t0, 'closed')).toBeNull();
  });

  test('warning allows finishing roles only', () => {
    drop({ id: 'impl', workItemId: item(1) });
    drop({ id: 'rev', workItemId: item(2, 'pr_open'), role: 'review' });
    expect(leaseNextDrop(db, 's', t0, 'finishing_only')?.dropId).toBe('rev');
    expect(leaseNextDrop(db, 's', t0, 'finishing_only')).toBeNull();
    expect(leaseNextDrop(db, 's', t0, 'open')?.dropId).toBe('impl');
  });

  test('started_at is set at lease time', () => {
    drop({ id: 'x', workItemId: item(1) });
    leaseNextDrop(db, 's', t0, 'open');
    expect(getDrop(db, 'x')?.startedAt).toBe(t0.toISOString());
  });

  test('lost review drop leaves the item pr_open', () => {
    const it = item(1, 'pr_open');
    drop({ id: 'rev', workItemId: it, role: 'review' });
    leaseNextDrop(db, 's', t0, 'open');
    expireLeases(db, plus(t0, 10 * MIN), cfg);
    expireLeases(db, plus(t0, 20 * MIN), cfg);
    expect(getDrop(db, 'rev')?.state).toBe('lost');
    expect(db.prepare('SELECT state FROM work_items WHERE id = ?').get(it)).toEqual({
      state: 'pr_open',
    });
  });

  test('expireLeases releases a lost probe', () => {
    const a = item(1);
    drop({ id: 'p', workItemId: a });
    expiredPause();
    leaseNextDrop(db, 's', plus(t0, MIN), 'probe');
    expireLeases(db, plus(t0, 10 * MIN), cfg, zero);
    expect(getUsageState(db).probeDropId).toBeNull();
  });

  test('expireLeases keeps its M0 two-argument form', () => expect(expireLeases(db, t0)).toBe(0));
});

describe('enqueue', () => {
  test('a review drop for item A does not block implement for item B', () => {
    drop({ id: 'rev', workItemId: item(1, 'pr_open'), role: 'review' });
    item(2, 'ready');
    expect(enqueueNext(db, zone, 'v1', cfg, t0)).not.toBeNull();
  });

  test('enqueueImplement refuses a second implement in the zone', () => {
    const a = item(1, 'ready');
    const b = item(2, 'ready');
    const w = (id: number) =>
      db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as { id: number };
    const opts = { headSha: null, chargedKey: null, promptVersion: 'v1' };
    expect(enqueueImplement(db, zone, { ...w(a), id: a } as never, opts, cfg, t0)).not.toBeNull();
    expect(enqueueImplement(db, zone, { ...w(b), id: b } as never, opts, cfg, t0)).toBeNull();
  });

  test('enqueue refuses while the gate is closed or throttled', () => {
    item(1, 'ready');
    ingestRateLimit(db, rej(future), src('c1', 'rate_limited'), cfg, t0, zero);
    expect(enqueueNext(db, zone, 'v1', cfg, t0)).toBeNull();
    setUsageState(
      db,
      { pausedUntil: null, status: 'allowed_warning', observedAt: t0.toISOString() },
      t0,
    );
    expect(enqueueNext(db, zone, 'v1', cfg, t0)).toBeNull();
  });

  test('enqueueNext sets the item in_flight', () => {
    const a = item(1, 'ready');
    const id = enqueueNext(db, zone, 'v1', cfg, t0);
    expect(activeDropFor(db, a)?.id).toBe(id);
    expect(db.prepare('SELECT state FROM work_items WHERE id = ?').get(a)).toEqual({
      state: 'in_flight',
    });
  });
});

describe('applyResult and usage', () => {
  const deps = (): ResultDeps => ({
    forges: fakeForgePair({ issues: [], trusted: [] }),
    zone,
    secrets: [],
    usageCfg: cfg,
    rand: zero,
  });

  test('a rate-limited probe stays free after the ingest starts a new pause', async () => {
    ingestRateLimit(db, rej(future), src('c1', 'rate_limited'), cfg, t0, zero);
    setUsageState(db, { pausedUntil: t0.toISOString(), probeDropId: 'p1' }, t0);
    const it = item(2);
    drop({ id: 'p1', workItemId: it, state: 'running' });
    await applyResult(
      db,
      deps(),
      'p1',
      { status: 'rate_limited', gates: [], rateLimit: rej(future) },
      plus(t0, MIN),
    );
    expect(getAttempts(db, it, 'rate_limit').count).toBe(0);
    expect(activeDropFor(db, it)?.state).toBe('queued');
  });

  test('a result with rate-limit data is ingested before its table runs', async () => {
    const it = item(1);
    drop({ id: 'd1', workItemId: it, state: 'running' });
    await applyResult(
      db,
      deps(),
      'd1',
      { status: 'rate_limited', gates: [], rateLimit: rej(future) },
      t0,
    );
    expect(getUsageState(db).status).toBe('rejected');
    expect(activeDropFor(db, it)?.state).toBe('queued');
  });
});

test('ingestRateLimit accepts a source with no work item', () => {
  const crew: RateLimitSource = {
    dropId: 'c1',
    workItemId: null,
    startedAt: t0.toISOString(),
    outcome: 'rate_limited',
  };
  ingestRateLimit(db, rej(future), crew, cfg, t0, zero);
  expect(getUsageState(db)).toMatchObject({ status: 'rejected', causeWorkItemId: null });
  expect(dispatchGate(db, cfg, plus(t0, MIN))).toBe('closed');
});

describe('every reported usage window (#144)', () => {
  const allowed = (windows: RateLimitEventData['unifiedWindows']): RateLimitEventData => ({
    status: 'allowed',
    unifiedWindows: windows,
  });

  test('two reports keep the latest value of every window, with observed_at set', () => {
    ingestRateLimit(
      db,
      allowed({
        seven_day: { utilization: 0.3, resetsAt: '2026-10-25T00:00:00.000Z' },
        seven_day_fable: { utilization: 0.1 },
      }),
      src('d1', null),
      cfg,
      t0,
    );
    const later = plus(t0, MIN);
    ingestRateLimit(
      db,
      allowed({ seven_day_fable: { utilization: 0.42, resetsAt: '2026-10-26T00:00:00.000Z' } }),
      src('d2', null),
      cfg,
      later,
    );
    expect(listUsageWindows(db)).toEqual([
      {
        key: 'seven_day',
        utilization: 0.3,
        resetsAt: '2026-10-25T00:00:00.000Z',
        observedAt: t0.toISOString(),
        model: null,
      },
      {
        key: 'seven_day_fable',
        utilization: 0.42,
        resetsAt: '2026-10-26T00:00:00.000Z',
        observedAt: later.toISOString(),
        model: null,
      },
    ]);
    // The existing columns still follow five_hour and seven_day only.
    expect(getUsageState(db)).toMatchObject({ sevenDayUtil: 0.3, fiveHourUtil: null });
  });

  test('a Fable-only limit still records its window', () => {
    ingestRateLimit(
      db,
      {
        status: 'rejected',
        rateLimitType: 'seven_day_fable',
        unifiedWindows: { seven_day_fable: { utilization: 1 } },
      },
      src('d1', 'rate_limited'),
      cfg,
      t0,
    );
    expect(listUsageWindows(db).map((w) => [w.key, w.utilization])).toEqual([
      ['seven_day_fable', 1],
    ]);
  });

  test('each window records the model of the drop that reported it (#377)', () => {
    const wi = item(1);
    drop({ id: 'df', workItemId: wi });
    updateDrop(db, 'df', { servedModel: 'claude-fable-5-2', requestedModel: 'claude-opus-5-5' });
    ingestRateLimit(
      db,
      allowed({ seven_day_overage_included: { utilization: 0.01 } }),
      src('df', null),
      cfg,
      t0,
    );
    expect(listUsageWindows(db)).toEqual([
      {
        key: 'seven_day_overage_included',
        utilization: 0.01,
        resetsAt: null,
        observedAt: t0.toISOString(),
        model: 'claude-fable-5-2',
      },
    ]);
  });

  test('an unknown drop records no model (#377)', () => {
    ingestRateLimit(
      db,
      allowed({ seven_day_overage_included: { utilization: 0.01 } }),
      src('nope', null),
      cfg,
      t0,
    );
    expect(listUsageWindows(db).map((w) => w.model)).toEqual([null]);
  });

  test('with no served model, the requested model is recorded (#377)', () => {
    const wi = item(1);
    drop({ id: 'dr', workItemId: wi });
    updateDrop(db, 'dr', { requestedModel: 'claude-opus-5-5' });
    ingestRateLimit(
      db,
      allowed({ seven_day_overage_included: { utilization: 0.3 } }),
      src('dr', null),
      cfg,
      t0,
    );
    expect(listUsageWindows(db).map((w) => w.model)).toEqual(['claude-opus-5-5']);
  });

  test('the raw fallback keeps every valid window and drops bad ones', () => {
    expect(
      rateLimitFromEvent({
        raw: {
          rate_limit_info: {
            status: 'allowed',
            unifiedWindows: {
              seven_day: { utilization: 0.5, resetsAt: 1792555200 },
              seven_day_fable: { utilization: 0.42 },
              'Bad-Key!': { utilization: 0.1 },
              seven_day_opus: { utilization: 2 },
            },
          },
        },
      })?.unifiedWindows,
    ).toEqual({
      seven_day: { utilization: 0.5, resetsAt: new Date(1792555200 * 1000).toISOString() },
      seven_day_fable: { utilization: 0.42 },
    });
  });

  // The gate reads no plan: under ultra (no five_hour reported) it decides exactly as today on
  // seven_day, and a new window (here Fable's) never pauses or throttles anything.
  type Row = { name: string; events: RateLimitEventData[]; outcome: DropResult['status'] | null };
  const fable = (u: number) => ({ seven_day_fable: { utilization: u } });
  const table: (Row & { gate: string })[] = [
    {
      name: 'seven_day low, Fable full',
      events: [allowed({ seven_day: { utilization: 0.2 }, ...fable(1) })],
      outcome: null,
      gate: 'open',
    },
    {
      name: 'only a new window, full',
      events: [allowed(fable(1))],
      outcome: null,
      gate: 'open',
    },
    {
      name: 'seven_day over the throttle',
      events: [allowed({ seven_day: { utilization: 0.95 }, ...fable(0.1) })],
      outcome: null,
      gate: 'finishing_only',
    },
    {
      name: 'rejected on seven_day',
      events: [
        {
          status: 'rejected',
          rateLimitType: 'seven_day',
          resetsAt: '2026-10-27T12:00:00Z',
          unifiedWindows: { seven_day: { utilization: 1 }, ...fable(0.5) },
        },
      ],
      outcome: 'rate_limited',
      gate: 'closed',
    },
    {
      name: 'rejected on Fable only',
      events: [
        {
          status: 'rejected',
          rateLimitType: 'seven_day_fable',
          resetsAt: '2026-10-27T12:00:00Z',
          unifiedWindows: { seven_day: { utilization: 0.4 }, ...fable(1) },
        },
      ],
      outcome: 'rate_limited',
      gate: 'open',
    },
    {
      name: 'rejected on seven_day, then a later drop resumes',
      events: [
        {
          status: 'rejected',
          rateLimitType: 'seven_day',
          resetsAt: '2026-10-27T12:00:00Z',
          unifiedWindows: { seven_day: { utilization: 1 }, ...fable(1) },
        },
        allowed({ seven_day: { utilization: 0.5 }, ...fable(1) }),
      ],
      outcome: 'rate_limited',
      gate: 'open',
    },
  ];
  /** Today's input for the same report: the windows the gate always knew, nothing else. */
  const today = (e: RateLimitEventData): RateLimitEventData => {
    const { unifiedWindows, ...rest } = e;
    const sd = unifiedWindows?.seven_day;
    return { ...rest, ...(sd ? { unifiedWindows: { seven_day: sd } } : {}) };
  };
  const run = (events: RateLimitEventData[], outcome: DropResult['status'] | null) => {
    db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
    events.forEach((e, i) => {
      const when = plus(t0, i * MIN);
      // A later event comes from a drop started after the pause: it clears it.
      ingestRateLimit(
        db,
        e,
        src(`d${i}`, i === 0 ? outcome : null, when.toISOString(), i + 1),
        cfg,
        when,
        zero,
      );
    });
    const end = plus(t0, events.length * MIN);
    return { gate: dispatchGate(db, cfg, end), state: getUsageState(db) };
  };

  test.each(table)('ultra, $name: $gate, as today, never a 5-hour pause', (row) => {
    const now = run(row.events, row.outcome);
    const before = run(row.events.map(today), row.outcome);
    expect(now.gate).toBe(row.gate);
    expect(now.gate).toBe(before.gate);
    expect(now.state).toEqual(before.state);
    expect(now.state.fiveHourUtil).toBeNull();
    expect(now.state.fiveHourResetsAt).toBeNull();
    if (now.state.pausedUntil !== null) {
      // A seven_day pause, capped at an hour until confirmed: never the 5-hour window.
      expect(Date.parse(now.state.pausedUntil) - t0.getTime()).toBeLessThanOrEqual(H + 90_000);
    }
  });
});
