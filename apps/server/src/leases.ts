import type { Db } from './db/open.js';

const LEASE_TTL_MS = 60_000;
const LOST_GRACE_MS = 120_000;

const iso = (d: Date, offsetMs = 0): string => new Date(d.getTime() + offsetMs).toISOString();

/** Leases the oldest queued drop to a stick, bumping its epoch. All time comes from `now`. */
export function leaseNextDrop(
  db: Db,
  stickId: string,
  now: Date,
): { dropId: string; epoch: number } | null {
  return db.transaction(() => {
    const next = db
      .prepare("SELECT id FROM drops WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1")
      .get() as { id: string } | undefined;
    if (!next) return null;
    const row = db
      .prepare(
        `UPDATE drops SET state = 'leased', stick_id = @stickId, epoch = epoch + 1,
           lease_expires_at = @expires
         WHERE id = @id RETURNING epoch`,
      )
      .get({ id: next.id, stickId, expires: iso(now, LEASE_TTL_MS) }) as { epoch: number };
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
 * Returns the number of drops newly marked lost.
 */
export function expireLeases(db: Db, now: Date): number {
  return db.transaction(() => {
    const lost = db
      .prepare(
        `UPDATE drops SET state = 'lost', finished_at = @now
         WHERE state IN ('leased','running') AND lease_expires_at < @now`,
      )
      .run({ now: iso(now) }).changes;
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
