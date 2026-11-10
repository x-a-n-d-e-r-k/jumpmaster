import type { DropResult, RateLimitEventData } from '@jumpmaster/protocol';
import {
  type Effect,
  listBriefings,
  type NewBriefing,
  raiseBriefing,
  withdrawBriefing,
} from './briefings.js';
import type { UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  type Drop,
  getDrop,
  getUsageState,
  isKilled,
  setUsageState,
  type UsageStateRow,
} from './db/repo.js';
import { enableFable } from './fable.js';

/**
 * The credits stop (spec §12.2: Jumpmaster never buys credits). A drop that reports running on
 * usage credits (`isUsingOverage: true`, live or in its result) stops all dispatch: nothing leases,
 * reviews included; running drops finish. The stop lifts by itself when the exhausted window resets
 * (usage is in plan again), or when Command rules Resume: credits may then run for at most five
 * hours, for the stopping drop (and its work item) only; another drop on credits stops again.
 * After a stop or a Resume horizon ends, one drop probes (the `probe` gate) until a live report says
 * the account runs in plan (`isUsingOverage: false`).
 */

export const CREDITS_STOP = 'credits:stop:';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;
/** A window at or above this utilization counts as the exhausted one (rounding, credit denominators). */
const EXHAUSTED = 0.98;

type WindowKey = 'five_hour' | 'seven_day';
const WINDOW_LABEL: Record<WindowKey, string> = { five_hour: '5-hour', seven_day: '7-day' };

/** What the stopping drop reported, kept for the briefing and the status page. */
export type CreditSignal = {
  zoneId: string;
  role: string;
  workItemId: number | null;
  /** The drop's outcome, or null when a live event stopped it. */
  outcome: DropResult['status'] | null;
  rateLimit: RateLimitEventData;
  /** Stopped during a Resume by a drop other than the one resumed. */
  secondDrop: boolean;
  /** The window the stop waits for, if known, and why it was chosen. */
  window?: WindowKey | null;
  reason?: string;
};

export const stopsOnOverage = (cfg: Pick<UsageConfig, 'stopOnOverage'> | undefined): boolean =>
  cfg?.stopOnOverage !== false;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const iso = (t: number): string => new Date(t).toISOString();

export function creditsStopInForce(u: UsageStateRow, now: Date): boolean {
  if (u.overageStoppedAt === null) return false;
  const until = ms(u.overageUntil);
  return until === null || now.getTime() < until;
}

export function creditSignal(u: UsageStateRow): CreditSignal | null {
  if (u.overageSignalJson === null) return null;
  try {
    return JSON.parse(u.overageSignalJson) as CreditSignal;
  } catch {
    return null;
  }
}

/**
 * When the stop lifts by itself, and why: the reset of a window at 98% or more (the later, if
 * both), else the reported limit's window (`rateLimitType`), else the top-level `resetsAt` when the
 * limit type is a plan window or absent (never a Fable cap), else five hours. At most seven days.
 */
export function stopWindow(
  data: RateLimitEventData,
  now: Date,
): { until: string; window: WindowKey | null; reason: string } {
  const t = now.getTime();
  const future = (v: string | undefined): number | null => {
    const r = ms(v);
    return r !== null && r > t ? r : null;
  };
  const windows = data.unifiedWindows ?? {};
  const capped = (until: number, window: WindowKey | null, reason: string) =>
    until > t + SEVEN_DAYS
      ? { until: iso(t + SEVEN_DAYS), window, reason: `${reason} Capped at seven days.` }
      : { until: iso(until), window, reason };
  const exhausted = (['five_hour', 'seven_day'] as const)
    .map((key) => ({ key, w: windows[key], reset: future(windows[key]?.resetsAt) }))
    .filter((x) => x.w !== undefined && x.w.utilization >= EXHAUSTED && x.reset !== null)
    .sort((a, b) => (b.reset ?? 0) - (a.reset ?? 0));
  const top = exhausted[0];
  if (top?.w && top.reset !== null) {
    const used = Math.round(top.w.utilization * 100);
    return capped(
      top.reset,
      top.key,
      `Stopped until the ${WINDOW_LABEL[top.key]} window resets: it is at ${used}%.`,
    );
  }
  const type = data.rateLimitType;
  const plan = type === 'five_hour' || type === 'seven_day' ? type : null;
  const named = plan ? future(windows[plan]?.resetsAt) : null;
  if (plan && named !== null) {
    return capped(
      named,
      plan,
      `Stopped until the ${WINDOW_LABEL[plan]} window resets: no window reported as exhausted; the reported limit is ${plan}.`,
    );
  }
  const topReset = plan || type === undefined ? future(data.resetsAt) : null;
  if (topReset !== null) {
    return capped(
      topReset,
      plan,
      `Stopped until the reported limit (${type ?? 'no type'}) resets: no window reported as exhausted.`,
    );
  }
  return {
    until: iso(t + FIVE_HOURS),
    window: null,
    reason: 'Stopped for five hours: no window reported as exhausted and no usable reset time.',
  };
}

/**
 * How long a Resume lets credits run: until the 5-hour window resets when that is the exhausted one
 * (at most five hours), else five hours. `atReset` says the 5-hour reset decided it.
 */
export function resumeHorizon(u: UsageStateRow, now: Date): { until: string; atReset: boolean } {
  const t = now.getTime();
  const s = creditSignal(u);
  const cap = t + FIVE_HOURS;
  if (s?.window !== 'five_hour') return { until: iso(cap), atReset: false };
  const resets = [u.fiveHourResetsAt, s.rateLimit.unifiedWindows?.five_hour?.resetsAt]
    .map((v) => ms(v))
    .filter((r): r is number => r !== null && r > t && r < cap);
  return resets.length > 0
    ? { until: iso(Math.min(...resets)), atReset: true }
    : { until: iso(cap), atReset: false };
}

/** A Resume horizon in force (and no stop). */
export function creditsResumeInForce(u: UsageStateRow, now: Date): boolean {
  const until = ms(u.overageResumeUntil);
  return until !== null && now.getTime() < until && !creditsStopInForce(u, now);
}

/** A stop or a Resume horizon has ended and no live report has shown the account in plan yet. */
export function creditsProbing(u: UsageStateRow, now: Date): boolean {
  if (creditsStopInForce(u, now)) return false;
  const resumeUntil = ms(u.overageResumeUntil);
  return (
    u.overageProbeSince !== null ||
    u.overageStoppedAt !== null ||
    (resumeUntil !== null && now.getTime() >= resumeUntil)
  );
}

const CLEAR_STOP = {
  overageStoppedAt: null,
  overageDropId: null,
  overageUntil: null,
  overageSignalJson: null,
} satisfies Partial<UsageStateRow>;

const CLEAR_RESUME = {
  overageResumeUntil: null,
  overageResumeDropId: null,
  overageResumeWorkItemId: null,
  overageResumedAt: null,
} satisfies Partial<UsageStateRow>;

/** Turns an ended stop or Resume horizon into the stored probe (what the pass does). */
function settleLifted(db: Db, u: UsageStateRow, now: Date): void {
  if (creditsStopInForce(u, now)) return;
  if (u.overageStoppedAt !== null) {
    setUsageState(
      db,
      { ...CLEAR_STOP, overageProbeSince: u.overageUntil ?? now.toISOString() },
      now,
    );
    return;
  }
  const resumeUntil = ms(u.overageResumeUntil);
  if (resumeUntil !== null && now.getTime() >= resumeUntil) {
    setUsageState(db, { ...CLEAR_RESUME, overageProbeSince: u.overageResumeUntil }, now);
  }
}

/**
 * Notes one rate-limit report from `drop` (a live event, `outcome` null, or its result). Only sets
 * state: the briefing is the pass's (`syncCreditsBriefing`). Returns true when it set a new stop.
 * A result is the backstop for live events that never arrived: for a drop already seen on credits
 * it may extend a stop in force but never starts one (its report may predate a reset). Only a live
 * report with `isUsingOverage: false` ends the probe after a stop (a result's report has no time).
 */
export function noteOverage(
  db: Db,
  cfg: UsageConfig,
  drop: Pick<Drop, 'id' | 'dropZoneId' | 'workItemId' | 'role'>,
  data: RateLimitEventData,
  outcome: DropResult['status'] | null,
  now: Date,
  /** When the drop reported it (a live event's `ts`); defaults to `now`. */
  reportedAt: Date = now,
): boolean {
  // A doctor drop observes usage (its report still feeds the usage state via ingestRateLimit) but
  // never touches the credits stop: it has no work item, so it could only bind a Resume to nothing.
  // So it neither starts a stop nor ends a credits probe: under the probe gate a doctor drop never
  // leases, and only the probe drop's own in-plan report ends probing.
  if (drop.role === 'doctor') return false;
  if (data.isUsingOverage === false && outcome === null) {
    db.transaction(() => {
      const u = getUsageState(db);
      if (!creditsProbing(u, now)) return;
      // A report from before the lift (a batch posted late) says nothing about now.
      const start = ms(u.overageProbeSince ?? u.overageUntil ?? u.overageResumeUntil);
      if (start !== null && reportedAt.getTime() < start) return;
      endProbe(db, u, now);
    })();
    return false;
  }
  if (data.isUsingOverage !== true) return false;
  return db.transaction(() => {
    const at = now.toISOString();
    const seen =
      db.prepare('SELECT 1 FROM credit_drops WHERE drop_id = ?').get(drop.id) !== undefined;
    db.prepare(
      `INSERT INTO credit_drops (drop_id, zone_id, overage_status, first_at, last_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (drop_id) DO UPDATE SET last_at = excluded.last_at,
         overage_status = COALESCE(excluded.overage_status, overage_status)`,
    ).run(drop.id, drop.dropZoneId, data.overageStatus ?? null, at, at);
    if (!stopsOnOverage(cfg)) return false;
    const u = getUsageState(db);
    const chosen = stopWindow(data, now);
    const until = chosen.until;
    if (creditsStopInForce(u, now)) {
      // Keeps its first drop; a later report may know a later reset.
      const current = ms(u.overageUntil);
      const signal = creditSignal(u);
      if (current !== null && Date.parse(until) > current) {
        // The briefing's why names the window it waits for: keep it in step with the decision.
        const refreshed = signal && {
          ...signal,
          rateLimit: data,
          window: chosen.window,
          reason: chosen.reason,
        };
        setUsageState(
          db,
          {
            overageUntil: until,
            ...(refreshed ? { overageSignalJson: JSON.stringify(refreshed) } : {}),
          },
          now,
        );
      }
      return false;
    }
    if (outcome !== null && seen) return false;
    const resumeUntil = ms(u.overageResumeUntil);
    let secondDrop = false;
    if (resumeUntil !== null && now.getTime() < resumeUntil) {
      const bound =
        drop.id === u.overageResumeDropId ||
        (drop.workItemId !== null && drop.workItemId === u.overageResumeWorkItemId);
      if (bound) return false;
      secondDrop = true;
    }
    const signal: CreditSignal = {
      zoneId: drop.dropZoneId,
      role: drop.role,
      workItemId: drop.workItemId,
      outcome,
      rateLimit: data,
      secondDrop,
      window: chosen.window,
      reason: chosen.reason,
    };
    setUsageState(
      db,
      {
        ...CLEAR_RESUME,
        overageStoppedAt: at,
        overageDropId: drop.id,
        overageUntil: until,
        overageSignalJson: JSON.stringify(signal),
        overageProbeSince: null,
      },
      now,
    );
    return true;
  })();
}

function endProbe(db: Db, u: UsageStateRow, now: Date): void {
  settleLifted(db, u, now);
  setUsageState(db, { overageProbeSince: null }, now);
}

/**
 * A finished drop's result, after `noteOverage`. The probe drop's result ends probing when it
 * carries a report saying the account ran in plan (`isUsingOverage: false`), or when the drop
 * succeeded and was never seen on credits. A failed or cancelled probe with no such report proves
 * nothing (it may never have called the API): probing goes on and the next drop takes the slot.
 * The probe started after the lift, so either is a witness. Other drops' results prove nothing.
 */
export function noteProbeResult(
  db: Db,
  drop: Pick<Drop, 'id'>,
  result: DropResult,
  now: Date,
): void {
  const flag = result.rateLimit?.isUsingOverage;
  if (flag === true) return;
  const succeeded = result.status === 'completed' || result.status === 'no_changes';
  db.transaction(() => {
    const u = getUsageState(db);
    if (u.probeDropId !== drop.id || !creditsProbing(u, now)) return;
    if (flag === false) return endProbe(db, u, now);
    const seen = db.prepare('SELECT 1 FROM credit_drops WHERE drop_id = ?').get(drop.id);
    if (succeeded && seen === undefined) endProbe(db, u, now);
  })();
}

/**
 * The `resume_after_credits` effect, bound to the stop's drop by the briefing subject. A Resume on a
 * stop that is no longer the current one changes nothing and throws (recorded as stale).
 */
export function resumeAfterCredits(db: Db, dropId: string, now: Date): void {
  db.transaction(() => {
    const u = getUsageState(db);
    if (!creditsStopInForce(u, now) || u.overageDropId !== dropId) {
      throw new Error('stale: not the current credits stop');
    }
    // Its briefing offers no Resume; one ruled on an older briefing must not bind nothing.
    if ((creditSignal(u)?.workItemId ?? null) === null) {
      throw new Error('this credits stop came from a drop with no work item: nothing to resume');
    }
    setUsageState(
      db,
      {
        ...CLEAR_STOP,
        overageResumeUntil: resumeHorizon(u, now).until,
        overageResumeDropId: dropId,
        overageResumeWorkItemId: creditSignal(u)?.workItemId ?? null,
        overageResumedAt: now.toISOString(),
      },
      now,
    );
  })();
}

/** Applies a `credits:*` briefing's effect. Throws for an effect that does not belong there. */
export function applyCreditsEffect(db: Db, subject: string, effect: Effect, now: Date): void {
  switch (effect) {
    case 'none':
      return;
    case 'enable_fable':
      return enableFable(db, now);
    case 'resume_after_credits': {
      if (!subject.startsWith(CREDITS_STOP)) {
        throw new Error(`resume_after_credits needs a credits stop subject, got ${subject}`);
      }
      return resumeAfterCredits(db, subject.slice(CREDITS_STOP.length), now);
    }
    case 'retry_item':
    case 'promote_issue':
    case 'reject_issue':
    case 'restage_issue':
    case 'allow_gate_change':
      throw new Error(`${effect} does not apply to ${subject}`);
    default: {
      const never: never = effect;
      throw new Error(`unknown effect ${String(never)}`);
    }
  }
}

const pct = (v: number | undefined | null): string =>
  v === undefined || v === null ? 'not reported' : `${Math.round(v * 100)}% used`;
const minute = (v: string): string => `${v.slice(0, 16).replace('T', ' ')} UTC`;

/** The credits stop briefing the server raises now for the stop in `u`. */
function stopBriefing(db: Db, u: UsageStateRow, now: Date): NewBriefing {
  const dropId = u.overageDropId ?? '';
  const s = creditSignal(u);
  const role = s?.role ?? getDrop(db, dropId)?.role ?? 'unknown role';
  const rl = s?.rateLimit;
  const win = (label: string, w: { utilization: number; resetsAt?: string } | undefined) =>
    `${label}: ${pct(w?.utilization)}, resets ${w?.resetsAt ?? 'unknown'}`;
  const horizon = resumeHorizon(u, now);
  // A stop from a drop with no work item (a crew drop: a doctor drop never stops) has no follow-on
  // drops for a Resume to run, so it offers none rather than one that would lease nothing.
  const workItemId = s ? s.workItemId : (getDrop(db, dropId)?.workItemId ?? null);
  const resumable = workItemId !== null;
  const lines = [
    `Drop ${dropId} (${role}) reported running on usage credits at ${u.overageStoppedAt}; outcome: ${s?.outcome ?? 'still running'}.`,
    ...(s?.secondDrop ? ['This stop was confirmed by a second drop during a Resume.'] : []),
    ...(s?.reason ? [s.reason] : []),
    win('5-hour window', rl?.unifiedWindows?.five_hour),
    win('7-day window', rl?.unifiedWindows?.seven_day),
    `Reported limit: ${rl?.rateLimitType ?? 'not reported'}, resets ${rl?.resetsAt ?? 'unknown'}; account overage status: ${rl?.overageStatus ?? 'not reported'}.`,
    '',
    'Nothing leases, reviews included; running drops finish.',
    ...(resumable
      ? [
          'Run on credits buys usage credits for',
          horizon.atReset
            ? `this drop's work item until the 5-hour window resets (${minute(horizon.until)}): only its`
            : "this drop's work item for at most five hours from the ruling: only its",
          'follow-on drops (review, heal, resolve) lease; nothing else does, and no new work is queued.',
          'Another drop on credits stops dispatch again. When the time is up, one drop probes until a',
          'drop reports running in plan.',
        ]
      : [
          `This stop came from a crew drop (${role}), which has no follow-on work: there is nothing to run on credits.`,
          `Work resumes when the window resets at ${u.overageUntil}.`,
        ]),
  ];
  return {
    zoneId: s?.zoneId ?? getDrop(db, dropId)?.dropZoneId ?? '',
    kind: 'credits_required',
    subject: `${CREDITS_STOP}${dropId}`,
    decision: `Dispatch is stopped: a drop ran on usage credits. It resumes by itself at ${u.overageUntil}, when the exhausted window resets.`,
    why: lines.join('\n'),
    options: [
      ...(resumable
        ? [
            {
              id: 'resume',
              label: horizon.atReset
                ? `Run on credits now (until ${minute(horizon.until)})`
                : 'Run on credits now (at most 5 hours)',
              effect: 'resume_after_credits' as const,
            },
          ]
        : []),
      { id: 'noted', label: 'Noted', effect: 'none' },
    ],
    onHold: 'All dispatch',
    source: 'server',
  };
}

/**
 * Once per pass: clears a stop that has lifted, then keeps exactly one open credits stop briefing
 * while stopped (raised again after Noted, or after a restart that lost it) and none otherwise. A
 * Resume ruled but not yet applied (the kill switch is on) counts as answered.
 */
export function syncCreditsBriefing(db: Db, now: Date): void {
  settleLifted(db, getUsageState(db), now);
  const u = getUsageState(db);
  const open = listBriefings(db, { state: 'open' }).filter((b) =>
    b.subject.startsWith(CREDITS_STOP),
  );
  const want = creditsStopInForce(u, now) ? stopBriefing(db, u, now) : null;
  for (const b of open) {
    if (!want || b.subject !== want.subject || b.zoneId !== want.zoneId) {
      withdrawBriefing(db, b.zoneId, b.subject, now);
    }
  }
  if (!want) return;
  const current = open.find((b) => b.subject === want.subject && b.zoneId === want.zoneId);
  if (current) {
    const same =
      current.why === want.why &&
      current.decision === want.decision &&
      JSON.stringify(current.options) === JSON.stringify(want.options);
    if (!same) raiseBriefing(db, want, now);
    return;
  }
  const pending = db
    .prepare(
      `SELECT 1 FROM rulings r JOIN briefings b ON b.id = r.briefing_id
         WHERE b.subject = ? AND r.applied_at IS NULL AND r.apply_error IS NULL LIMIT 1`,
    )
    .get(want.subject);
  if (!pending) raiseBriefing(db, want, now);
}

/**
 * The pass's global credits step, before any zone: applies every pending `credits:*` ruling in
 * any zone (whatever its mode, configured or not), except while the kill switch is on, then syncs
 * the stop briefing. Returns how many rulings were applied.
 */
export function creditsPass(db: Db, now: Date): number {
  let applied = 0;
  if (!isKilled(db)) {
    const pending = db
      .prepare(
        `SELECT r.id, r.choice, b.subject, b.options_json AS optionsJson
           FROM rulings r JOIN briefings b ON b.id = r.briefing_id
         WHERE b.subject LIKE 'credits:%' AND r.applied_at IS NULL AND r.apply_error IS NULL
         ORDER BY r.id`,
      )
      .all() as { id: number; choice: string; subject: string; optionsJson: string }[];
    for (const r of pending) {
      const option = (JSON.parse(r.optionsJson) as { id: string; effect: Effect }[]).find(
        (o) => o.id === r.choice,
      );
      try {
        if (!option) throw new Error(`option ${r.choice} is not on the briefing`);
        applyCreditsEffect(db, r.subject, option.effect, now);
        db.prepare('UPDATE rulings SET applied_at = ? WHERE id = ?').run(now.toISOString(), r.id);
        applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.prepare('UPDATE rulings SET apply_error = ? WHERE id = ?').run(message, r.id);
      }
    }
  }
  syncCreditsBriefing(db, now);
  return applied;
}

/** Drops that reported credits since `since`. */
export function creditDropsSince(db: Db, since: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM credit_drops WHERE last_at >= ?').get(since) as {
      n: number;
    }
  ).n;
}
