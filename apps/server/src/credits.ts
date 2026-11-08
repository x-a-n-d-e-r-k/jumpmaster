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
 */

export const CREDITS_STOP = 'credits:stop:';

const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;

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
 * When the stop lifts by itself: the reset of the window at full utilization (the later, if both),
 * else the reported limit's window (`rateLimitType`, top-level `resetsAt`), else five hours. At
 * most seven days.
 */
export function stopUntil(data: RateLimitEventData, now: Date): string {
  const t = now.getTime();
  const future = (v: string | undefined): number | null => {
    const r = ms(v);
    return r !== null && r > t ? r : null;
  };
  const windows = data.unifiedWindows ?? {};
  const exhausted = [windows.five_hour, windows.seven_day]
    .filter((w) => w !== undefined && w.utilization >= 1)
    .map((w) => future(w?.resetsAt))
    .filter((r): r is number => r !== null);
  let until: number;
  if (exhausted.length > 0) until = Math.max(...exhausted);
  else {
    const type = data.rateLimitType;
    const named =
      type === 'five_hour' || type === 'seven_day' ? windows[type]?.resetsAt : undefined;
    until = future(named) ?? future(data.resetsAt) ?? t + FIVE_HOURS;
  }
  return iso(Math.min(until, t + SEVEN_DAYS));
}

/** How long a Resume lets credits run: until the 5-hour window resets, at most five hours. */
export function resumeHorizon(u: UsageStateRow, now: Date): string {
  const t = now.getTime();
  const resets = [
    u.fiveHourResetsAt,
    creditSignal(u)?.rateLimit.unifiedWindows?.five_hour?.resetsAt,
  ]
    .map((v) => ms(v))
    .filter((r): r is number => r !== null && r > t);
  return iso(Math.min(t + FIVE_HOURS, ...resets));
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

/**
 * Notes one rate-limit report from `drop` (a live event, `outcome` null, or its result). Only sets
 * state: the briefing is the pass's (`syncCreditsBriefing`). Returns true when it set a new stop.
 */
export function noteOverage(
  db: Db,
  cfg: UsageConfig,
  drop: Pick<Drop, 'id' | 'dropZoneId' | 'workItemId' | 'role'>,
  data: RateLimitEventData,
  outcome: DropResult['status'] | null,
  now: Date,
): boolean {
  if (data.isUsingOverage !== true) return false;
  return db.transaction(() => {
    const at = now.toISOString();
    db.prepare(
      `INSERT INTO credit_drops (drop_id, zone_id, overage_status, first_at, last_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (drop_id) DO UPDATE SET last_at = excluded.last_at,
         overage_status = COALESCE(excluded.overage_status, overage_status)`,
    ).run(drop.id, drop.dropZoneId, data.overageStatus ?? null, at, at);
    if (!stopsOnOverage(cfg)) return false;
    const u = getUsageState(db);
    const until = stopUntil(data, now);
    if (creditsStopInForce(u, now)) {
      // Keeps its first drop; a later report may know a later reset.
      const current = ms(u.overageUntil);
      if (current !== null && Date.parse(until) > current) {
        setUsageState(db, { overageUntil: until }, now);
      }
      return false;
    }
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
    };
    setUsageState(
      db,
      {
        ...CLEAR_RESUME,
        overageStoppedAt: at,
        overageDropId: drop.id,
        overageUntil: until,
        overageSignalJson: JSON.stringify(signal),
      },
      now,
    );
    return true;
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
    setUsageState(
      db,
      {
        ...CLEAR_STOP,
        overageResumeUntil: resumeHorizon(u, now),
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
  const lines = [
    `Drop ${dropId} (${role}) reported running on usage credits at ${u.overageStoppedAt}; outcome: ${s?.outcome ?? 'still running'}.`,
    ...(s?.secondDrop ? ['This stop was confirmed by a second drop during a Resume.'] : []),
    win('5-hour window', rl?.unifiedWindows?.five_hour),
    win('7-day window', rl?.unifiedWindows?.seven_day),
    `Reported limit: ${rl?.rateLimitType ?? 'not reported'}, resets ${rl?.resetsAt ?? 'unknown'}; account overage status: ${rl?.overageStatus ?? 'not reported'}.`,
    '',
    'Nothing leases, reviews included; running drops finish. Run on credits buys usage credits for',
    `this drop's work until ${horizon} (the 5-hour reset, at most five hours); another drop on`,
    'credits stops dispatch again.',
  ];
  return {
    zoneId: s?.zoneId ?? getDrop(db, dropId)?.dropZoneId ?? '',
    kind: 'credits_required',
    subject: `${CREDITS_STOP}${dropId}`,
    decision: `Dispatch is stopped: a drop ran on usage credits. It resumes by itself at ${u.overageUntil}, when the exhausted window resets.`,
    why: lines.join('\n'),
    options: [
      {
        id: 'resume',
        label: `Run on credits now (until ${minute(horizon)}, at most 5 hours)`,
        effect: 'resume_after_credits',
      },
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
  let u = getUsageState(db);
  if (u.overageStoppedAt !== null && !creditsStopInForce(u, now)) {
    setUsageState(db, CLEAR_STOP, now);
    u = getUsageState(db);
  }
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
