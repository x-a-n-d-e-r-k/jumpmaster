import { recordAudit } from '../auth/audit.js';
import type { Principal } from '../auth/guard.js';
import { withdrawBriefingsOutside, withdrawZoneBriefings } from '../briefings.js';
import type { ApplyResult, ConfigStore } from '../config/store.js';
import type { Db } from '../db/open.js';
import {
  markZoneStopping,
  stoppingZones,
  type ZoneWaits,
  zoneDrained,
  zoneStopping,
  zoneWaits,
} from '../db/repo.js';

/**
 * Stop managing a zone in one action (issue #100). The zone goes to observe (no new work, no
 * GitHub write) and is marked stopping in its `zone_controls` row; it is removed through the
 * store's apply, whose rule is that it is drained in observe, at once when it already is and
 * otherwise by `sweepStopping` on a later tick, across restarts (the mark is in the database).
 * The removal leaves open pull requests as they are and keeps the zone's history for a Resume.
 */

/** The revision note of a zone's removal, within the store's note limit. */
export const removalNote = (id: string): string => {
  const note = `remove zone ${id}`;
  return note.length > 500 ? `${note.slice(0, 497)}...` : note;
};

/**
 * The removal itself: the document without the zone, through the apply path. Once the apply
 * succeeds, the zone's open briefings are withdrawn (nothing will rule them, issue #178), with one
 * audit entry for the count; a refused apply withdraws nothing. The credits stop briefing stays
 * open (#541): it holds all dispatch, not the zone.
 */
export function removeZone(
  db: Db,
  store: ConfigStore,
  id: string,
  meta: {
    via: 'ui' | 'ctl';
    principal: Principal;
    expectRevision?: number;
    now: Date;
  },
): ApplyResult {
  const doc = store.document();
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const r = store.apply(
    { ...doc, dropZones: zones.filter((z) => z.id !== id) },
    {
      via: meta.via,
      principal: meta.principal,
      ...(meta.expectRevision === undefined ? {} : { expectRevision: meta.expectRevision }),
      note: removalNote(id),
      returnTo: '/zones',
      cancelTo: `/zones/${encodeURIComponent(id)}`,
    },
  );
  if (r.ok) {
    const count = withdrawZoneBriefings(db, id, meta.now);
    if (count > 0)
      recordAudit(
        db,
        {
          via: 'system',
          action: 'briefing.withdraw',
          target: id,
          detail: { count, reason: 'zone removed' },
        },
        meta.now,
      );
  }
  return r;
}

/**
 * Withdraws, once, the open briefings of zones no longer in the config (left behind by removals
 * before issue #178), with one audit entry for the count. Called at server start; a second run
 * finds none. The credits stop briefing stays open whatever its zone (#541): `syncCreditsBriefing`
 * withdraws it once the stop lifts. Returns how many were withdrawn.
 */
export function withdrawOrphanBriefings(db: Db, store: ConfigStore, now: Date): number {
  const count = withdrawBriefingsOutside(
    db,
    store.current().dropZones.map((z) => z.id),
    now,
  );
  if (count > 0)
    recordAudit(
      db,
      {
        via: 'system',
        action: 'briefing.withdraw',
        detail: { count, reason: 'zone not configured' },
      },
      now,
    );
  return count;
}

export type StopOutcome =
  | { kind: 'removed'; result: Extract<ApplyResult, { ok: true }> }
  | { kind: 'stopping'; waits: ZoneWaits }
  | { kind: 'refused'; result: Exclude<ApplyResult, { ok: true }> };

/**
 * Marks the zone stopping (in observe) and removes it if it is drained. A read-only (file-mode)
 * config marks nothing: the apply path's refusal is the answer.
 */
export function stopZone(
  db: Db,
  store: ConfigStore,
  id: string,
  o: { via: 'ui' | 'ctl'; principal: Principal; now: Date },
): StopOutcome {
  if (store.mode() === 'file') {
    const r = removeZone(db, store, id, o);
    if (r.ok) throw new Error('a file-mode config applied a removal');
    return { kind: 'refused', result: r };
  }
  markZoneStopping(db, id, o.via, o.now);
  if (!zoneDrained(db, id)) return { kind: 'stopping', waits: zoneWaits(db, id) };
  const r = removeZone(db, store, id, {
    via: o.via,
    principal: o.principal,
    expectRevision: store.revision(),
    now: o.now,
  });
  return r.ok ? { kind: 'removed', result: r } : { kind: 'refused', result: r };
}

/** The server's own principal for a removal the operator asked for earlier. */
const SWEEP: Principal = { kind: 'operator', via: 'token', sudo: false };

/**
 * Removes every zone marked stopping that is now drained; returns the ids removed. Called on the
 * server's timers and at start, so a removal asked for before a restart still happens.
 */
export function sweepStopping(
  db: Db,
  store: ConfigStore,
  now: Date,
  log: (msg: string) => void = () => {},
): string[] {
  if (store.mode() === 'file') return [];
  const configured = new Set(store.current().dropZones.map((z) => z.id));
  const removed: string[] = [];
  for (const id of stoppingZones(db)) {
    if (!configured.has(id) || !zoneDrained(db, id)) continue;
    const via = zoneStopping(db, id)?.via ?? 'ctl';
    const r = removeZone(db, store, id, {
      via,
      principal: SWEEP,
      expectRevision: store.revision(),
      now,
    });
    if (!r.ok) {
      log(`zone ${id} is drained but could not be removed: ${refusalText(r)}`);
      continue;
    }
    recordAudit(
      db,
      {
        via: 'system',
        action: 'zone.remove',
        target: id,
        detail: { revision: r.revision, stopped: true },
      },
      now,
    );
    removed.push(id);
  }
  return removed;
}

/** One line for a refused apply, for the log. */
export function refusalText(r: Exclude<ApplyResult, { ok: true }>): string {
  if ('issues' in r) return r.issues.map((i) => i.message).join('; ');
  if ('conflict' in r) return 'the config changed meanwhile';
  return 'refused';
}
