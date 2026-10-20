import {
  type DropResult,
  type RateLimitEventData,
  RateLimitEventDataSchema,
} from '@jumpmaster/protocol';
import type { UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import { getUsageState, setUsageState, type UsageStateRow } from './db/repo.js';

export type Gate = 'open' | 'finishing_only' | 'probe' | 'closed';

/** Where a rate-limit observation came from. `outcome` null means a live stream event. */
export type RateLimitSource = {
  dropId: string;
  workItemId: number;
  startedAt: string | null;
  outcome: DropResult['status'] | null;
};

export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  throttleUtilization: 0.9,
  probeJitterSeconds: [30, 90],
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
  const windows = raw.unifiedWindows as Record<string, Record<string, unknown>> | undefined;
  const unifiedWindows: Record<string, { utilization: number; resetsAt?: string }> = {};
  for (const key of ['five_hour', 'seven_day'] as const) {
    const w = windows?.[key];
    if (w && typeof w.utilization === 'number') {
      const resetsAt = normalizeResetsAt(w.resetsAt);
      unifiedWindows[key] = { utilization: w.utilization, ...(resetsAt ? { resetsAt } : {}) };
    }
  }
  const resetsAt = normalizeResetsAt(raw.resetsAt);
  const candidate = {
    status: raw.status,
    ...(resetsAt ? { resetsAt } : {}),
    ...(typeof raw.rateLimitType === 'string' ? { rateLimitType: raw.rateLimitType } : {}),
    ...(Object.keys(unifiedWindows).length > 0 ? { unifiedWindows } : {}),
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
          probeDropId: null,
          probeNotBefore: null,
          causeDropId: null,
          causeWorkItemId: null,
        } satisfies Partial<UsageStateRow>);
        if (data.status === 'allowed_warning') patch.observedAt = now.toISOString();
      }
    }
    if (Object.keys(patch).length > 0) setUsageState(db, patch, now);
  })();
}

function throttled(u: UsageStateRow, cfg: UsageConfig, t: number): boolean {
  const observed = ms(u.observedAt);
  const live = (resetsAt: string | null, fallback: number): boolean => {
    const end = ms(resetsAt) ?? (observed === null ? null : observed + fallback);
    return end !== null && t < end;
  };
  if (u.status === 'allowed_warning' && observed !== null && t < observed + FIVE_HOURS) {
    return true;
  }
  if (
    u.fiveHourUtil !== null &&
    u.fiveHourUtil >= cfg.throttleUtilization &&
    live(u.fiveHourResetsAt, FIVE_HOURS)
  ) {
    return true;
  }
  return (
    u.sevenDayUtil !== null &&
    u.sevenDayUtil >= cfg.throttleUtilization &&
    live(u.sevenDayResetsAt, SEVEN_DAYS)
  );
}

/** What the scheduler and the lease route may start right now. */
export function dispatchGate(db: Db, cfg: UsageConfig, now: Date): Gate {
  const u = getUsageState(db);
  const t = now.getTime();
  const until = ms(u.pausedUntil);
  const notBefore = ms(u.probeNotBefore);
  if ((until !== null && t < until) || (notBefore !== null && t < notBefore)) return 'closed';
  if (u.status === 'rejected') return 'probe';
  return throttled(u, cfg, t) ? 'finishing_only' : 'open';
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
