import {
  type DropResult,
  type RateLimitEventData,
  RateLimitEventDataSchema,
  USAGE_WINDOW_KEY,
  usageWindowsOf,
} from '@jumpmaster/protocol';
import type { UsageConfig } from './config.js';
import {
  creditsProbing,
  creditsResumeInForce,
  creditsStopInForce,
  stopsOnOverage,
} from './credits.js';
import type { Db } from './db/open.js';
import {
  getDrop,
  getUsageState,
  listUsageWindows,
  NO_OVERRIDE,
  recordUsageWindows,
  setUsageState,
  type UsageStateRow,
  type UsageWindowRow,
} from './db/repo.js';
import { isFableRateLimit, modelFamily, PER_MODEL_WINDOWS, pauseFableFor } from './fable.js';

/**
 * `stopped`: a drop ran on usage credits (credits.ts); nothing leases, of any role.
 * `credits_resume`: Command resumed on credits; the bound work item's drops lease first and alone,
 * else one probe. `override`: the throttle holds, and Command's override lets a bounded number of
 * drops start (#728); leaseNextDrop counts each one.
 */
export type Gate =
  | 'open'
  | 'finishing_only'
  | 'override'
  | 'probe'
  | 'closed'
  | 'stopped'
  | 'credits_resume';

/** For an exhaustive `switch` on a union: a new member fails to compile. */
export function unreachable(x: never): never {
  throw new Error(`unexpected value ${String(x)}`);
}

/** Whether new implement work may be queued under `gate` (a probe may start one). */
export function gateQueuesImplement(gate: Gate): boolean {
  switch (gate) {
    case 'open':
    case 'override':
    case 'probe':
      return true;
    // During a Resume only the bound item's follow-on drops (queued by the reconciler) run.
    case 'credits_resume':
    case 'finishing_only':
    case 'closed':
    case 'stopped':
      return false;
    default:
      return unreachable(gate);
  }
}

/** Whether crew work may be queued under `gate`: only with the gate open, or overridden. */
export function gateQueuesCrew(gate: Gate): boolean {
  switch (gate) {
    case 'open':
    case 'override':
      return true;
    case 'probe':
    case 'credits_resume':
    case 'finishing_only':
    case 'closed':
    case 'stopped':
      return false;
    default:
      return unreachable(gate);
  }
}

/** Where a rate-limit observation came from. `outcome` null means a live stream event. */
export type RateLimitSource = {
  dropId: string;
  /** Null for a crew drop. */
  workItemId: number | null;
  startedAt: string | null;
  outcome: DropResult['status'] | null;
};

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  throttleUtilization: 0.9,
  probeJitterSeconds: [30, 90],
  stopOnOverage: true,
};

const HOUR = 60 * 60 * 1000;
const FIVE_HOURS = 5 * HOUR;
const SEVEN_DAYS = 7 * 24 * HOUR;
const UNCONFIRMED_CAP = HOUR;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const iso = (t: number): string => new Date(t).toISOString();

/** Jitter in ms, drawn between the configured bounds (a reversed pair is tolerated). */
export function jitterMs(cfg: UsageConfig, rand: () => number): number {
  const [a, b] = cfg.probeJitterSeconds;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.round((lo + (hi - lo) * rand()) * 1000);
}

/** Normalizes a reset time given as epoch seconds, epoch ms or an ISO string. */
function normalizeResetsAt(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  return undefined;
}

/**
 * Reads rate-limit data from a stored trooper event's `data`: the trooper's normalized fields
 * first, falling back to the raw CLI `rate_limit_info`. Returns null when neither parses.
 */
export function rateLimitFromEvent(data: unknown): RateLimitEventData | null {
  const direct = RateLimitEventDataSchema.safeParse(data);
  if (direct.success) return direct.data;
  const raw = (data as { raw?: { rate_limit_info?: Record<string, unknown> } } | null)?.raw
    ?.rate_limit_info;
  if (!raw || typeof raw !== 'object') return null;
  const unifiedWindows = usageWindowsOf(raw.unifiedWindows, normalizeResetsAt);
  const resetsAt = normalizeResetsAt(raw.resetsAt);
  const candidate = {
    status: raw.status,
    ...(resetsAt ? { resetsAt } : {}),
    ...(typeof raw.rateLimitType === 'string' ? { rateLimitType: raw.rateLimitType } : {}),
    ...(unifiedWindows ? { unifiedWindows } : {}),
    ...(typeof raw.isUsingOverage === 'boolean' ? { isUsingOverage: raw.isUsingOverage } : {}),
    ...(typeof raw.overageStatus === 'string' ? { overageStatus: raw.overageStatus } : {}),
  };
  const parsed = RateLimitEventDataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Records one rate-limit observation; may start, confirm or clear a dispatch pause. */
export function ingestRateLimit(
  db: Db,
  data: RateLimitEventData,
  src: RateLimitSource,
  cfg: UsageConfig,
  now: Date,
  rand: () => number = Math.random,
): void {
  // Every reported window is kept (#144); the account-wide ones feed the gate (#738).
  const windows = usageWindowsOf(data.unifiedWindows);
  if (windows) {
    // A per-model window does not name its model; the reporting drop's model does (#377).
    const d = getDrop(db, src.dropId);
    recordUsageWindows(db, windows, now, d ? (d.servedModel ?? d.requestedModel) : null);
  }
  // Command's override ends at the ceiling (#728), by the account's windows in any report, a
  // Fable-typed one's too: only a Fable-only refusal leaves it.
  if (reachesCeiling(data, now) && getUsageState(db).overrideUntil !== null)
    clearUsageOverride(db, now);
  // A Fable-only limit pauses Fable, never dispatch (best-effort, pending rehearsal).
  if (isFableRateLimit(data)) return pauseFableFor(db, data, now);
  db.transaction(() => {
    const u = getUsageState(db);
    const patch: Partial<UsageStateRow> = {};
    const fh = data.unifiedWindows?.five_hour;
    const sd = data.unifiedWindows?.seven_day;
    if (fh) {
      patch.fiveHourUtil = fh.utilization;
      patch.fiveHourResetsAt = normalizeResetsAt(fh.resetsAt) ?? null;
    }
    if (sd) {
      patch.sevenDayUtil = sd.utilization;
      patch.sevenDayResetsAt = normalizeResetsAt(sd.resetsAt) ?? null;
    }
    if (fh || sd) patch.observedAt = now.toISOString();
    Object.assign(patch, warningPatch(data, u, now));
    // Command's override ends at once on a refusal (#728), whoever reports it.
    if (data.status === 'rejected') Object.assign(patch, NO_OVERRIDE);

    const t = now.getTime();
    if (data.status === 'rejected') {
      const pauses = src.outcome !== null && src.outcome !== 'completed';
      // No usable reset time: treat it like a past reset (pause one jitter, then probe) rather
      // than ignoring a real limit and parking every drop that hits it.
      const reset = ms(normalizeResetsAt(data.resetsAt)) ?? t;
      if (pauses) {
        const window = data.rateLimitType === 'five_hour' ? FIVE_HOURS : SEVEN_DAYS;
        const base = reset <= t ? t : Math.min(reset, t + window);
        const target = base + jitterMs(cfg, rand);
        const until = ms(u.pausedUntil);
        const inForce = until !== null && t < until;
        // Confirmation needs a second, independent witness: another work item's drop. A probe that is
        // re-running the cause item (or that item's own retries) is the same agent, possibly forging.
        const otherItem = src.workItemId !== u.causeWorkItemId;
        const fromProbe = u.probeDropId !== null && src.dropId === u.probeDropId && otherItem;
        if (!inForce) {
          Object.assign(patch, {
            status: 'rejected',
            pausedUntil: iso(fromProbe ? target : Math.min(target, t + UNCONFIRMED_CAP)),
            pauseConfirmed: fromProbe,
            pausedAt: now.toISOString(),
            causeDropId: src.dropId,
            causeWorkItemId: src.workItemId,
            probeDropId: null,
            probeNotBefore: null,
          } satisfies Partial<UsageStateRow>);
        } else if (!u.pauseConfirmed && src.dropId !== u.causeDropId && otherItem) {
          patch.pauseConfirmed = true;
          patch.pausedUntil = iso(Math.max(until, target));
        } else if (u.pauseConfirmed) {
          patch.pausedUntil = iso(Math.max(until, target));
        }
      }
    } else {
      // allowed / allowed_warning
      const blocked = u.status === 'rejected';
      const startedAt = ms(src.startedAt);
      const pausedAt = ms(u.pausedAt);
      const clears =
        !blocked ||
        (u.probeDropId !== null && src.dropId === u.probeDropId) ||
        (startedAt !== null && pausedAt !== null && startedAt > pausedAt);
      if (clears) {
        Object.assign(patch, {
          status: data.status,
          pausedUntil: null,
          pauseConfirmed: false,
          // A credits probe holds its slot until a live in-plan report (credits.ts).
          probeDropId: creditsProbing(u, now) ? u.probeDropId : null,
          probeNotBefore: null,
          causeDropId: null,
          causeWorkItemId: null,
        } satisfies Partial<UsageStateRow>);
      }
    }
    if (Object.keys(patch).length > 0) setUsageState(db, patch, now);
  })();
}

/** No stored warning, as a patch of the usage row (#739). */
const NO_WARNING = {
  warningWindow: null,
  warningAt: null,
  warningResetsAt: null,
} satisfies Partial<UsageStateRow>;

/**
 * How a report changes the stored warning (#739): an `allowed_warning` replaces it, whatever the
 * pause; an `allowed` for its window, or naming none, clears it; anything else leaves it.
 */
function warningPatch(
  data: RateLimitEventData,
  u: UsageStateRow,
  now: Date,
): Partial<UsageStateRow> {
  const named = data.rateLimitType;
  const window = named !== undefined && USAGE_WINDOW_KEY.test(named) ? named : null;
  if (data.status === 'allowed_warning') {
    const own = window !== null ? data.unifiedWindows?.[window]?.resetsAt : undefined;
    return {
      warningWindow: window,
      warningAt: now.toISOString(),
      warningResetsAt: normalizeResetsAt(data.resetsAt) ?? normalizeResetsAt(own) ?? null,
    };
  }
  if (data.status === 'allowed' && u.warningAt !== null) {
    if (window === null || window === u.warningWindow) return NO_WARNING;
  }
  return {};
}

/** Claude's last `allowed_warning`, while it is current: until its reset, else its fallback span. */
export function usageWarning(
  db: Db,
  now: Date,
): { window: string | null; at: string; resetsAt: string | null } | null {
  const u = getUsageState(db);
  const at = ms(u.warningAt);
  if (u.warningAt === null || at === null) return null;
  const span =
    u.warningWindow === null || u.warningWindow.startsWith('five_hour') ? FIVE_HOURS : SEVEN_DAYS;
  const end = ms(u.warningResetsAt) ?? at + span;
  if (now.getTime() >= end) return null;
  return { window: u.warningWindow, at: u.warningAt, resetsAt: u.warningResetsAt };
}

/** Model families a window key may name; such a window is one model's, never the account's. */
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** Whether a window covers the whole account: not a per-model window, and no part names a model. */
function accountWide(key: string): boolean {
  if (PER_MODEL_WINDOWS.has(key)) return false;
  return !key.split('_').some((part) => MODEL_FAMILIES.includes(part));
}

/**
 * When a window's figure stops counting: its reset, else its own observation plus the window's
 * span (five hours for `five_hour*`, seven days for any other); null when it has neither time.
 */
function windowEnd(w: UsageWindowRow): number | null {
  const reset = ms(w.resetsAt);
  if (reset !== null) return reset;
  const observed = ms(w.observedAt);
  if (observed === null) return null;
  return observed + (w.key.startsWith('five_hour') ? FIVE_HOURS : SEVEN_DAYS);
}

/** The account-wide windows whose reported utilization still counts at `now` (#738). */
export function liveAccountWindows(
  db: Db,
  now: Date,
): (UsageWindowRow & { utilization: number })[] {
  const t = now.getTime();
  return listUsageWindows(db).filter((w): w is UsageWindowRow & { utilization: number } => {
    if (w.utilization === null || !accountWide(w.key)) return false;
    const end = windowEnd(w);
    return end !== null && t < end;
  });
}

/**
 * The model family a per-model window belongs to, lower case: the family its key names, or for a
 * PER_MODEL_WINDOWS key the family of its stored model. Null for an account-wide window, and for a
 * PER_MODEL_WINDOWS row with no model (it names none).
 */
function windowFamily(w: UsageWindowRow): string | null {
  if (PER_MODEL_WINDOWS.has(w.key)) return modelFamily(w.model)?.toLowerCase() ?? null;
  return w.key.split('_').find((part) => MODEL_FAMILIES.includes(part)) ?? null;
}

/**
 * The model families (lower case) whose live per-model window reports a utilization at or above
 * `cfg.throttleUtilization` (#747). Such a window holds new drops on its model only, never the
 * account: dispatchGate does not read it.
 */
export function heldModelFamilies(db: Db, cfg: UsageConfig, now: Date): Set<string> {
  const t = now.getTime();
  const held = new Set<string>();
  for (const w of listUsageWindows(db)) {
    if (w.utilization === null || w.utilization < cfg.throttleUtilization) continue;
    const family = windowFamily(w);
    const end = windowEnd(w);
    if (family !== null && end !== null && t < end) held.add(family);
  }
  return held;
}

/** Whether some live account-wide window is at or above `share`. */
function accountAt(db: Db, share: number, t: number): boolean {
  return liveAccountWindows(db, new Date(t)).some((w) => w.utilization >= share);
}

/**
 * Whether a window's figure counts at `t`: a row of `key` with a utilization whose window has not
 * ended (the rule liveAccountWindows uses).
 */
function reportsUtilization(db: Db, key: string, t: number): boolean {
  return listUsageWindows(db).some((w) => {
    if (w.key !== key || w.utilization === null) return false;
    const end = windowEnd(w);
    return end !== null && t < end;
  });
}

/**
 * Whether Claude's warning holds all dispatch (#748): only while it is current, names an
 * account-wide window (or none), and that window reports no utilization. The threshold is the
 * control; a warning only stands in for a figure Claude did not give.
 */
function warningHolds(db: Db, t: number): boolean {
  const w = usageWarning(db, new Date(t));
  if (w === null) return false;
  if (w.window === null) return liveAccountWindows(db, new Date(t)).length === 0;
  return accountWide(w.window) && !reportsUtilization(db, w.window, t);
}

function throttled(db: Db, cfg: UsageConfig, t: number): boolean {
  return accountAt(db, cfg.throttleUtilization, t) || warningHolds(db, t);
}

/**
 * The usage share at which an override ends by itself. A constant, and never the throttle's own
 * setting: chat can change that one without a confirmation, so nothing but a release raises this.
 */
export const OVERRIDE_CEILING = 0.95;
export const OVERRIDE_DEFAULTS = { starts: 5, hours: 3 } as const;

/** Whether a report shows an account window, one that has not reset, at the override's ceiling. */
function reachesCeiling(data: RateLimitEventData, now: Date): boolean {
  return [data.unifiedWindows?.five_hour, data.unifiedWindows?.seven_day].some((w) => {
    if (!w || w.utilization < OVERRIDE_CEILING) return false;
    const reset = ms(normalizeResetsAt(w.resetsAt));
    return reset === null || now.getTime() < reset;
  });
}

export type UsageOverride = { startsLeft: number; starts: number; until: string };

/** The override in `u`, when it is in force at `t`: in time, with a start left, under the ceiling. */
function overrideIn(db: Db, u: UsageStateRow, t: number): UsageOverride | null {
  const until = ms(u.overrideUntil);
  if (until === null || t >= until) return null;
  if (u.overrideStartsLeft === null || u.overrideStartsLeft <= 0) return null;
  if (accountAt(db, OVERRIDE_CEILING, t)) return null;
  return {
    startsLeft: u.overrideStartsLeft,
    starts: u.overrideStarts ?? u.overrideStartsLeft,
    until: iso(until),
  };
}

/** Command's override of the usage throttle, while it is in force (#728). */
export function usageOverride(db: Db, now: Date): UsageOverride | null {
  return overrideIn(db, getUsageState(db), now.getTime());
}

/** Sets Command's override, replacing any. Only the control route calls this: no chat or MCP path. */
export function setUsageOverride(
  db: Db,
  o: { starts: number; hours: number; by: 'session' | 'token' },
  now: Date,
): void {
  setUsageState(
    db,
    {
      overrideUntil: iso(now.getTime() + o.hours * HOUR),
      overrideStarts: o.starts,
      overrideStartsLeft: o.starts,
      overrideBy: o.by,
    },
    now,
  );
}

export function clearUsageOverride(db: Db, now: Date): void {
  setUsageState(db, NO_OVERRIDE, now);
}

/**
 * Takes one start of the override, inside the caller's transaction: the grant it came from, by its
 * end, or null when none is left.
 */
export function takeOverrideStart(db: Db, now: Date): string | null {
  const r = db
    .prepare(
      `UPDATE usage_state SET override_starts_left = override_starts_left - 1
       WHERE id = 1 AND override_starts_left > 0 AND override_until > @now
       RETURNING override_until AS until`,
    )
    .get({ now: now.toISOString() }) as { until: string } | undefined;
  return r?.until ?? null;
}

/** Gives back a start whose drop never left the server, while its own grant still stands. */
export function refundOverrideStart(db: Db, until: string | undefined, now: Date): void {
  if (until === undefined) return;
  db.prepare(
    `UPDATE usage_state SET override_starts_left = override_starts_left + 1, updated_at = @now
     WHERE id = 1 AND override_until = @until AND override_starts_left < override_starts`,
  ).run({ until, now: now.toISOString() });
}

/** Whether the throttle holds new work now, override or not: what an override would lift. */
export function throttleHolds(db: Db, cfg: UsageConfig, now: Date): boolean {
  return baseGate(db, getUsageState(db), cfg, now) === 'finishing_only';
}

/** What the scheduler and the lease route may start right now. A credits stop wins over all. */
export function dispatchGate(db: Db, cfg: UsageConfig, now: Date): Gate {
  const u = getUsageState(db);
  const gate = baseGate(db, u, cfg, now);
  // An override lifts the throttle alone: a stop, a pause and a probe win over it.
  return gate === 'finishing_only' && overrideIn(db, u, now.getTime()) ? 'override' : gate;
}

/** The gate without Command's override. */
function baseGate(
  db: Db,
  u: UsageStateRow,
  cfg: UsageConfig,
  now: Date,
): Exclude<Gate, 'override'> {
  // The credits stop and what follows it apply only while configured (stopOnOverage).
  const credits = stopsOnOverage(cfg);
  if (credits && creditsStopInForce(u, now)) return 'stopped';
  const t = now.getTime();
  const until = ms(u.pausedUntil);
  const notBefore = ms(u.probeNotBefore);
  if ((until !== null && t < until) || (notBefore !== null && t < notBefore)) return 'closed';
  if (credits && creditsResumeInForce(u, now)) return 'credits_resume';
  if (u.status === 'rejected' || (credits && creditsProbing(u, now))) return 'probe';
  return throttled(db, cfg, t) ? 'finishing_only' : 'open';
}

/** Called when a drop becomes terminal: frees the probe slot, backing off if nothing cleared it. */
export function releaseProbe(
  db: Db,
  dropId: string,
  cfg: UsageConfig,
  now: Date,
  rand: () => number = Math.random,
): void {
  const u = getUsageState(db);
  if (u.probeDropId === null || u.probeDropId !== dropId) return;
  setUsageState(
    db,
    {
      probeDropId: null,
      ...(u.status === 'rejected'
        ? { probeNotBefore: iso(now.getTime() + jitterMs(cfg, rand)) }
        : {}),
    },
    now,
  );
}
