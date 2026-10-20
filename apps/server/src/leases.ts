import type { UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import { getUsageState, setUsageState } from './db/repo.js';
import { DEFAULT_USAGE_CONFIG, type Gate, releaseProbe } from './usage.js';

const LEASE_TTL_MS = 60_000;
const LOST_GRACE_MS = 120_000;

const iso = (d: Date, offsetMs = 0): string => new Date(d.getTime() + offsetMs).toISOString();

const FINISHING = "('review','heal','resolve')";

/**
 * Leases the oldest queued drop the usage gate allows, bumping its epoch and stamping started_at.
 * `probe` leases exactly one drop (preferring one not on the pause's cause item) and records it.
 * All time comes from `now`.
 */
export function leaseNextDrop(
  db: Db,
  stickId: string,
  now: Date,
  gate: Gate = 'open',
): { dropId: string; epoch: number } | null {
  return db.transaction(() => {
    if (gate === 'closed') return null;
    let next: { id: string } | undefined;
    if (gate === 'probe') {
      const u = getUsageState(db);
      if (u.probeDropId !== null) return null;
      next = db
        .prepare(
          `SELECT id FROM drops WHERE state = 'queued'
           ORDER BY CASE WHEN work_item_id IS ? THEN 1 ELSE 0 END, created_at, rowid LIMIT 1`,
        )
        .get(u.causeWorkItemId) as { id: string } | undefined;
    } else {
      const roleFilter = gate === 'finishing_only' ? ` AND role IN ${FINISHING}` : '';
      next = db
        .prepare(
          `SELECT id FROM drops WHERE state = 'queued'${roleFilter} ORDER BY created_at, rowid LIMIT 1`,
        )
        .get() as { id: string } | undefined;
    }
    if (!next) return null;
    const row = db
      .prepare(
        `UPDATE drops SET state = 'leased', stick_id = @stickId, epoch = epoch + 1,
           lease_expires_at = @expires, started_at = @now
         WHERE id = @id AND state = 'queued' RETURNING epoch`,
      )
      .get({ id: next.id, stickId, expires: iso(now, LEASE_TTL_MS), now: iso(now) }) as
      | { epoch: number }
      | undefined;
    if (!row) return null;
    if (gate === 'probe') setUsageState(db, { probeDropId: next.id }, now);
    return { dropId: next.id, epoch: row.epoch };
  })();
}

/** Extends a live lease and moves leased to running; reports stale/cancelled drops. */
export function heartbeat(
  db: Db,
  dropId: string,
  stickId: string,
  epoch: number,
  now: Date,
): 'ok' | 'stale' | 'cancel' {
  return db.transaction(() => {
    const d = db
      .prepare('SELECT state, stick_id AS stickId, epoch FROM drops WHERE id = ?')
      .get(dropId) as { state: string; stickId: string | null; epoch: number } | undefined;
    if (!d || d.stickId !== stickId || d.epoch !== epoch) return 'stale';
    if (d.state === 'cancelled') return 'cancel';
    if (d.state !== 'leased' && d.state !== 'running') return 'stale';
    db.prepare(
      `UPDATE drops SET state = 'running', lease_expires_at = @expires,
         started_at = COALESCE(started_at, @now) WHERE id = @id`,
    ).run({ id: dropId, expires: iso(now, LEASE_TTL_MS), now: iso(now) });
    return 'ok';
  })();
}

/**
 * Marks drops with expired leases `lost` (finished_at = now), then returns in_flight work items
 * to `ready` once their latest drop has been lost for the grace period and no drop is active.
 * Only implement items are `in_flight`, so a lost review/heal/resolve drop leaves its item
 * `pr_open` for the reconciler to re-decide. Lost probes are released.
 * Returns the number of drops newly marked lost.
 */
export function expireLeases(
  db: Db,
  now: Date,
  usageCfg: UsageConfig = DEFAULT_USAGE_CONFIG,
  rand: () => number = Math.random,
): number {
  return db.transaction(() => {
    const lostIds = (
      db
        .prepare(
          `UPDATE drops SET state = 'lost', finished_at = @now
           WHERE state IN ('leased','running') AND lease_expires_at < @now RETURNING id`,
        )
        .all({ now: iso(now) }) as { id: string }[]
    ).map((r) => r.id);
    for (const id of lostIds) releaseProbe(db, id, usageCfg, now, rand);
    const lost = lostIds.length;
    db.prepare(
      `UPDATE work_items SET state = 'ready', updated_at = @now
       WHERE state = 'in_flight'
         AND NOT EXISTS (SELECT 1 FROM drops a WHERE a.work_item_id = work_items.id
                         AND a.state IN ('queued','leased','running'))
         AND (SELECT l.state FROM drops l WHERE l.work_item_id = work_items.id
              ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1) = 'lost'
         AND (SELECT l.finished_at FROM drops l WHERE l.work_item_id = work_items.id
              ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1) <= @cutoff`,
    ).run({ now: iso(now), cutoff: iso(now, -LOST_GRACE_MS) });
    return lost;
  })();
}
