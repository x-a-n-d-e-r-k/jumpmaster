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
import type { Drop } from './db/repo.js';

export { servedModel } from '@jumpmaster/protocol';

/** Roles that run on Fable when it is available. */
export const FABLE_ROLES: readonly CrewRole[] = ['diagnose'];
/** Plans that include Fable. `enterprise` is treated as not including it until verified. */
export const FABLE_PLANS: readonly ClaudePlan[] = ['max', 'team_premium'];

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
         AND (requested_model = ? OR requested_model LIKE '%fable%')`,
    )
    .get(new Date(now.getTime() - WEEK_MS).toISOString(), cfg.claude.fableModel ?? '') as {
    n: number;
  };
  return n;
}

/**
 * Whether Fable may run now, and why not. It needs a declared plan that includes it, `fableModel`
 * set, no disable, no pause in force, and fewer than `fableWeeklyDropCap` Fable drops this week.
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
  if (fableDropsThisWeek(db, cfg, now) >= fableWeeklyDropCap) {
    return no(`weekly cap reached (${fableWeeklyDropCap} Fable drops in 7 days)`);
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
  const isFable = FABLE.test(configured) || configured === cfg.claude.fableModel;
  return isFable && !status.available ? zone.model : configured;
}

const isFableRequest = (cfg: Pick<Config, 'claude'>, drop: Drop): boolean =>
  drop.requestedModel !== null &&
  (drop.requestedModel === cfg.claude.fableModel || FABLE.test(drop.requestedModel));

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
