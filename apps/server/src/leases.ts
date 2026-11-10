import type { ImagePolicy, StickCapability } from '@jumpmaster/protocol';
import type { Config, DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import { getUsageState, isKilled, setKilled, setUsageState } from './db/repo.js';
import { refundCharge } from './flow/budgets.js';
import { DEFAULT_USAGE_CONFIG, type Gate, releaseProbe, unreachable } from './usage.js';

const LEASE_TTL_MS = 60_000;
const LOST_GRACE_MS = 120_000;

const iso = (d: Date, offsetMs = 0): string => new Date(d.getTime() + offsetMs).toISOString();

const FINISHING = "('review','heal','resolve')";

/**
 * Finishing roles first, then implement, then crew roles (§5.3), then doctor drops; age within a
 * class. A doctor drop is charged to no budget and is never the usage probe.
 */
const ROLE_CLASS = `CASE WHEN role IN ${FINISHING} THEN 0 WHEN role = 'implement' THEN 1
  WHEN role = 'doctor' THEN 3 ELSE 2 END`;

/** Queued drops wait while their zone is paused or observing. */
const ZONE_ACTIVE = `AND drop_zone_id NOT IN (SELECT zone_id FROM zone_controls WHERE mode <> 'active')`;

export type ZoneRequirements = { caps: Set<StickCapability>; signed: boolean };

/**
 * What a stick must have to run this zone's drops: `egress-v1` unless egress is off, and
 * `image-verify-v1` under the `signed` policy when signed images are required (install-wide, or
 * by the zone itself).
 */
export function zoneRequirements(
  zone: Pick<DropZoneConfig, 'egress' | 'requireSignedImages'>,
  config: Pick<Config, 'requireSignedImages'>,
): ZoneRequirements {
  const caps = new Set<StickCapability>();
  if ((zone.egress?.mode ?? 'off') !== 'off') caps.add('egress-v1');
  // Strengthen-only: the zone can add the requirement, never remove the install's.
  const signed = config.requireSignedImages === true || zone.requireSignedImages === true;
  if (signed) caps.add('image-verify-v1');
  return { caps, signed };
}

/** What the stick lacks for these requirements (empty: it may run the zone's drops). */
export function missingFor(
  stick: { capabilities: readonly string[]; imagePolicy: ImagePolicy },
  need: ZoneRequirements,
): string[] {
  const missing: string[] = [...need.caps].filter((c) => !stick.capabilities.includes(c));
  if (need.signed && stick.imagePolicy !== 'signed') missing.push('image-policy:signed');
  return missing;
}

/** Excludes queued drops of zones the stick can't run (a JSON array of zone ids). */
const NOT_EXCLUDED = 'AND drop_zone_id NOT IN (SELECT value FROM json_each(@exclude))';

/**
 * Leases the oldest queued drop the usage gate allows, bumping its epoch and stamping started_at.
 * `probe` leases exactly one drop (preferring one not on the pause's cause item) and records it.
 * `credits_resume` leases only the resumed work item's drops; with none queued (or a crew drop
 * resumed), nothing. The gate is required: a caller that forgets it must not lease while stopped. All time
 * comes from `now`. Drops of the `exclude` zones (ones the stick can't run) are never picked, under
 * any gate: they stay queued, untouched, for a capable stick.
 */
export function leaseNextDrop(
  db: Db,
  stickId: string,
  now: Date,
  gate: Gate,
  exclude: readonly string[] = [],
): { dropId: string; epoch: number } | null {
  const ex = JSON.stringify(exclude);
  return db.transaction(() => {
    if (isKilled(db)) return null;
    let next: { id: string } | undefined;
    let probe = false;
    const probeNext = (): { id: string } | undefined => {
      const u = getUsageState(db);
      if (u.probeDropId !== null) return undefined;
      probe = true;
      return db
        .prepare(
          // A doctor drop never probes: what clears a usage limit is real work, not a check.
          `SELECT id FROM drops WHERE state = 'queued' AND role <> 'doctor' ${ZONE_ACTIVE} ${NOT_EXCLUDED}
           ORDER BY CASE WHEN work_item_id = @cause THEN 1 ELSE 0 END, ${ROLE_CLASS}, created_at, rowid
           LIMIT 1`,
        )
        .get({ cause: u.causeWorkItemId, exclude: ex }) as { id: string } | undefined;
    };
    switch (gate) {
      case 'closed':
      case 'stopped':
        return null;
      case 'probe':
        next = probeNext();
        break;
      case 'credits_resume': {
        const bound = getUsageState(db).overageResumeWorkItemId;
        next =
          bound === null
            ? undefined
            : (db
                .prepare(
                  `SELECT id FROM drops WHERE state = 'queued' ${ZONE_ACTIVE} ${NOT_EXCLUDED}
                     AND work_item_id = @bound
                   ORDER BY ${ROLE_CLASS}, created_at, rowid LIMIT 1`,
                )
                .get({ bound, exclude: ex }) as { id: string } | undefined);
        break;
      }
      case 'open':
      case 'finishing_only': {
        // Above the throttle only finishing work starts, and doctor drops: an operator-asked
        // readiness check with one small Claude call, still last by ROLE_CLASS.
        const roleFilter =
          gate === 'finishing_only' ? ` AND (role IN ${FINISHING} OR role = 'doctor')` : '';
        next = db
          .prepare(
            `SELECT id FROM drops WHERE state = 'queued' ${ZONE_ACTIVE} ${NOT_EXCLUDED}${roleFilter}
             ORDER BY ${ROLE_CLASS}, created_at, rowid LIMIT 1`,
          )
          .get({ exclude: ex }) as { id: string } | undefined;
        break;
      }
      default:
        return unreachable(gate);
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
    if (probe) setUsageState(db, { probeDropId: next.id }, now);
    return { dropId: next.id, epoch: row.epoch };
  })();
}

/**
 * Engages the kill switch: refuses all new work and cancels every active drop, refunding its
 * charge so a later reset doesn't count cancelled work as a repeat.
 */
export function engageKill(db: Db, now: Date): { cancelled: number } {
  return db.transaction(() => {
    setKilled(db, true, now);
    const active = db
      .prepare(
        `UPDATE drops SET state = 'cancelled', finished_at = ?, hard_cancel = 1
           WHERE state IN ('queued', 'leased', 'running')
           RETURNING id, work_item_id AS itemId, charged_key AS chargedKey`,
      )
      .all(iso(now)) as { id: string; itemId: number | null; chargedKey: string | null }[];
    const probe = getUsageState(db).probeDropId;
    for (const d of active) {
      // Only item drops are charged against a work item's budget.
      if (d.itemId !== null) refundCharge(db, d.itemId, d.chargedKey);
      if (d.id === probe) setUsageState(db, { probeDropId: null }, now);
    }
    return { cancelled: active.length };
  })();
}

/** Extends a live lease and moves leased to running; reports stale/cancelled drops. */
export function heartbeat(
  db: Db,
  dropId: string,
  stickId: string,
  epoch: number,
  now: Date,
): 'ok' | 'stale' | 'cancel' | 'hard_cancel' {
  return db.transaction(() => {
    const d = db
      .prepare(
        'SELECT state, stick_id AS stickId, epoch, hard_cancel AS hardCancel FROM drops WHERE id = ?',
      )
      .get(dropId) as
      | { state: string; stickId: string | null; epoch: number; hardCancel: number }
      | undefined;
    if (!d || d.stickId !== stickId || d.epoch !== epoch) return 'stale';
    // Hard stays hard after a reset: a trooper told to stop gracefully would checkpoint and push.
    if (d.state === 'cancelled') return d.hardCancel === 1 ? 'hard_cancel' : 'cancel';
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

/** Pushes every live lease out to a full TTL from `now`. */
export function extendLiveLeases(db: Db, now: Date): number {
  return db
    .prepare(
      `UPDATE drops SET lease_expires_at = @expires
       WHERE state IN ('leased','running') AND lease_expires_at < @expires`,
    )
    .run({ expires: iso(now, LEASE_TTL_MS) }).changes;
}

/**
 * `expireLeases` that knows when the server itself was away: on its first run (startup) and after
 * any gap longer than the lease TTL (a slow restart, a sleeping laptop) the sticks could not have
 * heartbeated, so live leases get a fresh TTL instead of being declared lost all at once.
 */
export function leaseExpirer(
  db: Db,
  usageCfg: UsageConfig = DEFAULT_USAGE_CONFIG,
  rand: () => number = Math.random,
): (now: Date) => number {
  let last: number | null = null;
  return (now) => {
    const t = now.getTime();
    const away = last === null || t - last > LEASE_TTL_MS;
    last = t;
    if (away) {
      extendLiveLeases(db, now);
      return 0;
    }
    return expireLeases(db, now, usageCfg, rand);
  };
}

/**
 * The zones among `zoneIds` with a drop waiting that a lease would otherwise consider: queued, in
 * an active zone. These are the ones a stick that can't run them is told it skipped.
 */
export function zonesWaiting(db: Db, zoneIds: readonly string[]): Set<string> {
  if (zoneIds.length === 0) return new Set();
  const rows = db
    .prepare(
      `SELECT DISTINCT drop_zone_id AS z FROM drops WHERE state = 'queued' ${ZONE_ACTIVE}
         AND drop_zone_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(zoneIds)) as { z: string }[];
  return new Set(rows.map((r) => r.z));
}
