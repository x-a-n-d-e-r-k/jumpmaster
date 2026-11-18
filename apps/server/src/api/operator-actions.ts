import { type AuditDetail, recordAudit } from '../auth/audit.js';
import type { Principal } from '../auth/guard.js';
import { ruleBriefing } from '../briefings.js';
import { mergeConfigPatch } from '../config/diff.js';
import type { ApplyMeta, ApplyResult, ConfigStore } from '../config/store.js';
import type { Config } from '../config.js';
import { requestCrewCycle } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import {
  activeWorkCount,
  clearZoneStopping,
  setZoneMode,
  ZONE_MODES,
  type ZoneMode,
} from '../db/repo.js';
import type { ChatPrincipal } from '../mcp/tokens.js';
import { safeNext } from '../ui/auth-pages.js';

/**
 * The operator actions the HTTP control routes and the crew chat's tools share, so a chat turn
 * changes things exactly as the browser does: the same checks, the same writes and the same audit
 * action, with `via` taken from the principal and, for a chat principal, the thread and message.
 */

/** Who acts and against what: the routes build one per request, the chat per tool call. */
export type ActionCtx = {
  db: Db;
  now(): Date;
  /** The config snapshot the action reads (one revision per request or tool call). */
  config: Config;
  principal: Principal;
  /** Every secret value an audit row or an error is scrubbed of. */
  secrets: string[];
  /** Starts a pass without waiting for it, so a ruling or a cycle applies promptly. */
  kick?: () => void;
};

export type ActionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 502;
      error: string;
      /** The answer's body when it is more than `{ error }` (the PATCH route's 409 and 403). */
      body?: Record<string, unknown>;
    };

/**
 * A chat turn's caller as an operator principal: treated as the browser session that posted the
 * owner's message (never sudo, never the token), audited as `chat` with the thread and message.
 */
export function chatPrincipal(p: ChatPrincipal): Principal {
  return {
    kind: 'operator',
    via: 'chat',
    sessionId: p.sessionHash,
    sudo: false,
    chat: { threadId: p.threadId, messageId: p.messageId },
  };
}

/** Records one action as the context's principal; a chat principal adds its thread and message. */
export function auditAction(
  ctx: ActionCtx,
  action: string,
  detail: AuditDetail,
  target?: string,
): void {
  const chat = ctx.principal.chat;
  recordAudit(
    ctx.db,
    {
      via: ctx.principal.via,
      action,
      ...(target === undefined ? {} : { target }),
      detail: chat ? { ...detail, thread: chat.threadId, message: chat.messageId } : detail,
    },
    ctx.now(),
    ctx.secrets,
  );
}

const fail = <T>(
  status: 400 | 403 | 404 | 409 | 502,
  error: string,
  body?: Record<string, unknown>,
): ActionResult<T> => ({ ok: false, status, error, ...(body ? { body } : {}) });

const MAX_RULING_NOTE = 2000;

/** Rules an open briefing: one ruling, recorded once; a second (from anywhere) is a 409. */
export function ruleAction(
  ctx: ActionCtx,
  briefingId: number,
  optionId: string,
  note: string,
  seen: { optionsDigest?: string },
): ActionResult<{ rulingId: number }> {
  if (!Number.isInteger(briefingId) || briefingId <= 0) return fail(404, 'unknown briefing');
  if (note.length > MAX_RULING_NOTE)
    return fail(400, `a note is at most ${MAX_RULING_NOTE} characters`);
  const r = ruleBriefing(ctx.db, briefingId, optionId, note, ctx.now(), {
    ...(seen.optionsDigest ? { optionsDigest: seen.optionsDigest } : {}),
  });
  if (!r.ok) {
    const error = { 404: 'unknown briefing', 409: 'already ruled', 400: 'unknown option' };
    return fail(r.status, r.reason ?? error[r.status]);
  }
  auditAction(ctx, 'briefing.rule', { optionId, rulingId: r.rulingId }, `briefing:${briefingId}`);
  ctx.kick?.();
  return { ok: true, value: { rulingId: r.rulingId } };
}

/** Sets a zone's mode; observe only once it is drained. Choosing a mode withdraws a stop. */
export function zoneModeAction(
  ctx: ActionCtx,
  zoneId: string,
  mode: ZoneMode,
): ActionResult<{ mode: ZoneMode }> {
  const zone = ctx.config.dropZones.find((z) => z.id === zoneId);
  if (!zone) return fail(404, 'unknown zone');
  if (!(ZONE_MODES as readonly string[]).includes(mode)) return fail(400, 'invalid mode');
  if (mode === 'observe') {
    const active = activeWorkCount(ctx.db, zone.id);
    if (active > 0)
      return fail(409, `${active} active drops or forge writes: pause and drain first`);
  }
  setZoneMode(ctx.db, zone.id, mode, ctx.now());
  clearZoneStopping(ctx.db, zone.id);
  auditAction(ctx, 'zone.mode', { mode }, zone.id);
  return { ok: true, value: { mode } };
}

/** Makes the zone's lead cycle due now; only where the crew is enabled. */
export function crewCycleAction(
  ctx: ActionCtx,
  zoneId: string,
): ActionResult<{ crewCycle: 'due' }> {
  const zone = ctx.config.dropZones.find((z) => z.id === zoneId);
  if (!zone) return fail(404, 'unknown zone');
  if (!zone.crew?.enabled) return fail(409, 'crew is not enabled');
  requestCrewCycle(zone.id, ctx.now());
  auditAction(ctx, 'zone.crew-cycle', {}, zone.id);
  ctx.kick?.();
  return { ok: true, value: { crewCycle: 'due' } };
}

export const SESSION_FORBIDDEN_HINT = 'set with jumpmaster ctl or in the config file';

/** The paths an apply changed, for the audit row: names only, never a value. */
export const pathsOf = (changed: string[]): string => {
  const text = changed.join(', ');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

/** An applied revision's audit fields: the revision and the paths, and whether it was guarded. */
export const appliedDetail = (r: Extract<ApplyResult, { ok: true }>): AuditDetail => ({
  revision: r.revision,
  changed: pathsOf(r.changed),
  ...(r.guarded ? { guarded: 1, guardedPaths: pathsOf(r.guarded) } : {}),
  ...(r.readds ? { readds: r.readds.join(', ') } : {}),
});

/** What an applied change answers. */
export type Applied = {
  revision: number;
  changed: string[];
  restartNeeded: string[];
  readds?: string[];
  guarded?: string[];
};

/**
 * An apply's outcome as every config route answers it, audited as the context's principal: the
 * revision, or 400 issues by path, 409 a stale revision or a guarded change held for the
 * confirmation page (`config.propose` is audited: the paths and base, never the pending id), 403 a
 * browser-forbidden path.
 */
export function applyOutcome(
  ctx: ActionCtx,
  action: string,
  r: ApplyResult,
  extra: AuditDetail = {},
  target?: string,
): ActionResult<Applied> {
  if (!r.ok) {
    if ('conflict' in r) return fail(409, 'the config changed since', { conflict: r.conflict });
    if ('needsConfirmation' in r) {
      const { pendingId, guarded, expectRevision } = r.needsConfirmation;
      auditAction(ctx, 'config.propose', {
        kind: action.replace(/^config\./, ''),
        base: expectRevision,
        guardedPaths: pathsOf([...new Set(guarded.map((g) => g.path))]),
      });
      return fail(409, 'confirm this change in the browser', {
        needsConfirmation: true,
        pendingId,
        confirm: `/config/confirm/${pendingId}`,
        guarded,
      });
    }
    if ('sessionForbidden' in r)
      return fail(403, 'this cannot be changed from the browser', {
        sessionForbidden: r.sessionForbidden,
        hint: SESSION_FORBIDDEN_HINT,
      });
    if ('confirmation' in r)
      return fail(409, 'the confirmation was not accepted', { confirmation: r.confirmation });
    return fail(400, r.issues.map((i) => i.message).join('; ') || 'invalid change', {
      issues: r.issues,
    });
  }
  auditAction(ctx, action, { ...appliedDetail(r), ...extra }, target);
  return {
    ok: true,
    value: {
      revision: r.revision,
      changed: r.changed,
      restartNeeded: r.restartNeeded,
      ...(r.readds ? { readds: r.readds } : {}),
      ...(r.guarded ? { guarded: r.guarded } : {}),
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Applies a partial config patch (zones matched by id) as `PATCH /api/control/config` does. A
 * session's or a chat's apply is revision `via: 'ui'` (a chat's noted with its thread and message),
 * the token's `via: 'ctl'`. A guarded change from a session or a chat is held for the browser
 * session's confirmation; a browser-forbidden one is refused.
 */
export function configPatchAction(
  ctx: ActionCtx,
  store: ConfigStore,
  patch: unknown,
  o: {
    expectRevision?: number;
    note?: string;
    returnTo?: string;
    cancelTo?: string;
    resume?: string[];
  },
): ActionResult<Applied> {
  if (!isRecord(patch)) return fail(400, 'the patch must be an object');
  const p = ctx.principal;
  const chatNote = p.chat
    ? `chat thread ${p.chat.threadId} message ${p.chat.messageId}${o.note ? `: ${o.note}` : ''}`
    : undefined;
  const note = chatNote ?? o.note;
  const meta: ApplyMeta = {
    via: p.via === 'token' ? 'ctl' : 'ui',
    principal: p,
    ...(o.expectRevision !== undefined ? { expectRevision: o.expectRevision } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(o.returnTo === undefined ? {} : { returnTo: safeNext(o.returnTo) }),
    ...(o.cancelTo === undefined ? {} : { cancelTo: safeNext(o.cancelTo) }),
  };
  // Zones are matched by id: a section's `{ dropZones: [{ id, … }] }` edits that zone alone.
  const r = store.apply(mergeConfigPatch(store.document(), patch), meta);
  return applyOutcome(ctx, 'config.apply', r);
}
