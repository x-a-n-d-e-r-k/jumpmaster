import type { CrewRole, DropResult, RateLimitEventData, Role } from '@jumpmaster/protocol';
import { raiseBriefing } from './briefings.js';
import {
  type ClaudePlan,
  type Config,
  type DropZoneConfig,
  modelFor,
  type UsageConfig,
} from './config.js';
import { stopsOnOverage } from './credits.js';
import type { Db } from './db/open.js';
import { type Drop, listUsageWindows, type UsageWindowRow } from './db/repo.js';

export { servedModel } from '@jumpmaster/protocol';

/** Roles that run on Fable when it is available. */
export const FABLE_ROLES: readonly CrewRole[] = ['diagnose', 'arbitrate', 'audit'];
/** Plans that include Fable. `enterprise` is treated as not including it until verified. */
export const FABLE_PLANS: readonly ClaudePlan[] = ['max', 'ultra', 'team_premium'];

/** The default share of Fable's weekly limit at which Fable stops (`claude.fableMaxUtilization`). */
export const FABLE_MAX_UTILIZATION = 0.8;

/**
 * Windows that belong to one model the key does not name (#377): `seven_day_overage_included` is
 * Claude's "per-model bucket", labelled by the model of the drop that reported it.
 */
export const PER_MODEL_WINDOWS = new Set(['seven_day_overage_included']);

/** A model id's family: `claude-fable-5-2` reads `Fable`; null for any other shape. */
export function modelFamily(model: string | null): string | null {
  const m = model === null ? null : /^claude-([a-z]+)-/.exec(model);
  const f = m?.[1];
  return f ? f[0]?.toUpperCase() + f.slice(1) : null;
}

/** The Fable window: its key names Fable, or it is a per-model window a Fable drop reported. */
export const isFableWindow = (row: UsageWindowRow): boolean =>
  row.key.includes('fable') ||
  (PER_MODEL_WINDOWS.has(row.key) && modelFamily(row.model) === 'Fable');

/** The Fable window, the most recently observed if several. Read by the Floor and the budget. */
export function fableWindow(windows: readonly UsageWindowRow[]): UsageWindowRow | undefined {
  return windows
    .filter(isFableWindow)
    .reduce<UsageWindowRow | undefined>(
      (best, w) =>
        best === undefined || (w.observedAt ?? '') > (best.observedAt ?? '') ? w : best,
      undefined,
    );
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FABLE = /fable/i;

export type FableState = { disabledReason: string | null; pausedUntil: string | null };

export function getFableState(db: Db): FableState {
  const row = db
    .prepare(
      'SELECT disabled_reason AS disabledReason, paused_until AS pausedUntil FROM fable_state WHERE id = 1',
    )
    .get() as FableState | undefined;
  return row ?? { disabledReason: null, pausedUntil: null };
}

function setFableState(db: Db, patch: Partial<FableState>, now: Date): void {
  const next = { ...getFableState(db), ...patch };
  db.prepare(
    `INSERT INTO fable_state (id, disabled_reason, paused_until, updated_at)
     VALUES (1, @disabledReason, @pausedUntil, @at)
     ON CONFLICT (id) DO UPDATE SET disabled_reason = excluded.disabled_reason,
       paused_until = excluded.paused_until, updated_at = excluded.updated_at`,
  ).run({ ...next, at: now.toISOString() });
}

/** The `enable_fable` effect: clears a disable (a plain set, so idempotent). */
export function enableFable(db: Db, now: Date): void {
  setFableState(db, { disabledReason: null }, now);
}

/** Drops that asked for Fable in the trailing seven days. */
function fableDropsThisWeek(db: Db, cfg: Pick<Config, 'claude'>, now: Date): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drops WHERE created_at > ?
         AND role <> 'doctor' AND (requested_model = ? OR requested_model LIKE '%fable%')`,
    )
    .get(new Date(now.getTime() - WEEK_MS).toISOString(), cfg.claude.fableModel ?? '') as {
    n: number;
  };
  return n;
}

/** A whole percent: 0.85 reads `85%`. */
const percent = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Whether Fable may run now, and why not. It needs a declared plan that includes it, `fableModel`
 * set, no disable and no pause in force. Then, while Claude has reported Fable's weekly window and
 * it hasn't reset, its utilization must be under `fableMaxUtilization`; until then, fewer than
 * `fableWeeklyDropCap` Fable drops this week. A read error or an invalid figure fails closed.
 */
export function fableStatus(
  db: Db,
  cfg: Pick<Config, 'claude'>,
  now: Date,
): { available: boolean; reason: string } {
  const { plan, fableModel, fableWeeklyDropCap } = cfg.claude;
  const no = (reason: string) => ({ available: false, reason });
  if (!FABLE_PLANS.includes(plan)) return no(`plan ${plan} does not include Fable`);
  if (!fableModel) return no('no fableModel is configured');
  const state = getFableState(db);
  if (state.disabledReason !== null) return no(`disabled: ${state.disabledReason}`);
  if (state.pausedUntil !== null && now.getTime() < Date.parse(state.pausedUntil)) {
    return no(`paused until ${state.pausedUntil}`);
  }
  let window: UsageWindowRow | undefined;
  try {
    window = fableWindow(listUsageWindows(db));
  } catch {
    return no('Fable usage could not be read');
  }
  const util = window?.utilization ?? null;
  const unreported =
    util === null || (window?.resetsAt != null && !(Date.parse(window.resetsAt) > now.getTime()));
  if (unreported) {
    if (fableDropsThisWeek(db, cfg, now) >= fableWeeklyDropCap) {
      return no(`weekly cap reached (${fableWeeklyDropCap} Fable drops in 7 days)`);
    }
    return { available: true, reason: 'available' };
  }
  if (typeof util !== 'number' || !Number.isFinite(util) || util < 0) {
    return no('Fable usage report is invalid');
  }
  const limit = cfg.claude.fableMaxUtilization ?? FABLE_MAX_UTILIZATION;
  if (util >= limit) {
    return no(`Fable weekly usage at ${percent(util)} (limit ${percent(limit)})`);
  }
  return { available: true, reason: 'available' };
}

/**
 * The model a drop runs on. A Fable role gets `fableModel` when Fable is available; otherwise the
 * role's configured model, unless that names Fable while Fable is unavailable, when the zone model
 * stands in. Fable never runs undeclared.
 */
export function resolveModel(
  db: Db,
  cfg: Pick<Config, 'claude'>,
  zone: DropZoneConfig,
  role: Role,
  now: Date,
): string {
  const status = fableStatus(db, cfg, now);
  const fableRole = (FABLE_ROLES as readonly string[]).includes(role);
  if (fableRole && status.available && cfg.claude.fableModel) return cfg.claude.fableModel;
  const configured = modelFor(zone, role);
  // The doctor's one-line probe never spends Fable: it runs on the zone's model whatever models says.
  if (role === 'doctor' && (FABLE.test(configured) || configured === cfg.claude.fableModel))
    return zone.model;
  const isFable = FABLE.test(configured) || configured === cfg.claude.fableModel;
  return isFable && !status.available ? zone.model : configured;
}

const namesFable = (cfg: Pick<Config, 'claude'>, model: string): boolean =>
  model === cfg.claude.fableModel || FABLE.test(model);

/** The drop asked for Fable, as recorded in `requested_model`. */
export const isFableRequest = (cfg: Pick<Config, 'claude'>, drop: Drop): boolean =>
  drop.requestedModel !== null && namesFable(cfg, drop.requestedModel);

/**
 * The drop asked for Fable and, when the served model is recorded, was served by Fable too: what
 * the server recorded, never what the agent says it ran on.
 */
export const ranOnFable = (cfg: Pick<Config, 'claude'>, drop: Drop): boolean =>
  isFableRequest(cfg, drop) && (drop.servedModel === null || namesFable(cfg, drop.servedModel));

/** A rate limit on Fable alone: it pauses Fable, never dispatch. */
export const isFableRateLimit = (data: RateLimitEventData | undefined): boolean =>
  data !== undefined && FABLE.test(data.rateLimitType ?? '');

const toIso = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const n = Number(v);
  const t = Number.isFinite(n) && v.trim() !== '' ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Pauses Fable until the limit's reset (or 24 hours) when a Fable-only limit was hit.
 * Best-effort, pending rehearsal: `rateLimitType` values for Fable are unobserved.
 */
export function pauseFableFor(db: Db, data: RateLimitEventData, now: Date): void {
  if (data.status !== 'rejected') return;
  const until = toIso(data.resetsAt) ?? new Date(now.getTime() + DAY_MS).toISOString();
  const current = getFableState(db).pausedUntil;
  if (current !== null && Date.parse(current) >= Date.parse(until)) return;
  setFableState(db, { pausedUntil: until }, now);
}

/**
 * Reacts to what a finished drop reported about Fable and overage. Best-effort, pending rehearsal
 * (the field names are unobserved; see the rehearsal notes): read only when present. A Fable drop
 * on credits disables Fable (`credits:fable`). Any other drop on credits raises `credits:overage`
 * only when `usage.stopOnOverage` is false; otherwise the credits stop briefs it (credits.ts).
 */
export function noteFableSignals(
  db: Db,
  cfg: Pick<Config, 'claude'> & { usage?: Pick<UsageConfig, 'stopOnOverage'> },
  drop: Drop,
  result: DropResult,
  now: Date,
): void {
  const rl = result.rateLimit;
  if (!rl) return;
  if (isFableRateLimit(rl)) pauseFableFor(db, rl, now);
  if (rl.isUsingOverage !== true) return;
  const fable = isFableRequest(cfg, drop);
  if (fable) setFableState(db, { disabledReason: 'credits_required' }, now);
  else if (stopsOnOverage(cfg.usage)) return;
  raiseBriefing(
    db,
    {
      zoneId: drop.dropZoneId,
      kind: 'credits_required',
      subject: fable ? 'credits:fable' : 'credits:overage',
      decision: fable
        ? 'A Fable drop ran on usage credits. Fable is disabled until you re-enable it.'
        : 'A drop ran on usage credits.',
      why: `Drop ${drop.id} (${drop.role}) reported overage use${rl.overageStatus ? ` (${rl.overageStatus})` : ''}. Jumpmaster never buys credits; check the plan declared in claude.plan.`,
      options: fable
        ? [
            { id: 'enable', label: 'Re-enable Fable', effect: 'enable_fable' },
            { id: 'noted', label: 'Noted', effect: 'none' },
          ]
        : [{ id: 'noted', label: 'Noted', effect: 'none' }],
      onHold: fable ? 'Fable drops' : '',
      source: 'server',
    },
    now,
  );
}
