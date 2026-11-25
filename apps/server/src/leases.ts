import {
  ceilingRefusal,
  type EgressPayload,
  entryCovered,
  type ImagePolicy,
  type Role,
  type StickCapability,
} from '@jumpmaster/protocol';
import type { Config, DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  ACTIVE_STATES_SQL,
  appendEvents,
  type Drop,
  getDrop,
  getUsageState,
  getWorkItem,
  isKilled,
  reclaimableSql,
  reclaimCutoff,
  revokeCloneGrants,
  revokeGrants,
  setKilled,
  setUsageState,
  setWorkItemState,
  updateDrop,
} from './db/repo.js';
import { egressFor } from './egress-for.js';
import { refundCharge } from './flow/budgets.js';
import { forgeKind } from './forge/kind.js';
import { CEILING_MISSING, CEILING_MODE } from './missing-words.js';
import {
  DEFAULT_USAGE_CONFIG,
  type Gate,
  releaseProbe,
  takeOverrideStart,
  unreachable,
} from './usage.js';

const LEASE_TTL_MS = 60_000;
const LOST_GRACE_MS = 120_000;

const iso = (d: Date, offsetMs = 0): string => new Date(d.getTime() + offsetMs).toISOString();

const FINISHING = "('review','heal','resolve')";

/** The roles the throttle never holds (FINISHING, and doctor drops). */
const UNTHROTTLED: ReadonlySet<string> = new Set(['review', 'heal', 'resolve', 'doctor']);

/**
 * Finishing roles first, then implement, then crew roles (§5.3), then doctor drops; age within a
 * class. A doctor drop is charged to no budget and is never the usage probe.
 */
const ROLE_CLASS = `CASE WHEN role IN ${FINISHING} THEN 0 WHEN role = 'implement' THEN 1
  WHEN role = 'doctor' THEN 3 ELSE 2 END`;

/**
 * Whether a doctor drop may lease under `gate`: when dispatch is open and above the throttle
 * (finishing_only). A doctor drop runs one Claude call plus the zone's gates, which spend no usage;
 * it never leases during a pause or a credits stop, as the probe, or on a credits Resume. Shared
 * with the doctor's account of why a queued one waits (doctorDropWait).
 */
export function doctorMayLease(gate: Gate): boolean {
  return gate === 'open' || gate === 'finishing_only' || gate === 'override';
}

/** What `leaseNextDrop`'s `modelHeld` predicate is shown of a queued drop. */
export type HeldCandidate = {
  id: string;
  role: string;
  dropZoneId: string;
  workItemId: number | null;
  inputJson: string | null;
};

/** Queued drops wait while their zone is paused or observing. */
const ZONE_ACTIVE = `AND drop_zone_id NOT IN (SELECT zone_id FROM zone_controls WHERE mode <> 'active')`;

export type ZoneRequirements = {
  caps: Set<StickCapability>;
  signed: boolean;
  /** What `egressFor` gives the zone's drops (undefined when its mode is `off`), for a ceiling. */
  egress: EgressPayload | undefined;
};

/**
 * What a stick must have to run this zone's drops: `egress-v1` unless egress is off,
 * `image-verify-v1` under the `signed` policy when signed images are required (install-wide, or
 * by the zone itself), and `clone-v1` for a GitLab zone, whose drops say `repo.mirror: provided`
 * (ruling 121: the stick's clone container fills the mirror). `egress` is what the drops are
 * given, judged against a stick's ceiling.
 */
export function zoneRequirements(
  zone: Pick<DropZoneConfig, 'egress' | 'requireSignedImages' | 'preset' | 'forge'>,
  config: Pick<Config, 'requireSignedImages'>,
): ZoneRequirements {
  const caps = new Set<StickCapability>();
  if (forgeKind(zone) === 'gitlab') caps.add('clone-v1');
  if ((zone.egress?.mode ?? 'off') !== 'off') caps.add('egress-v1');
  // Strengthen-only: the zone can add the requirement, never remove the install's.
  const signed = config.requireSignedImages === true || zone.requireSignedImages === true;
  if (signed) caps.add('image-verify-v1');
  return { caps, signed, egress: egressFor(zone) };
}

/** Hosts an `egress-ceiling:` item names before `+N`, and the characters kept of each. */
const CEILING_HOSTS_SHOWN = 3;
const CEILING_HOST_CHARS = 100;

/**
 * The `egress-ceiling:` item for a stick whose ceiling refuses this egress, or null when it may
 * run it: `egress-ceiling:mode` when the mode is the cause, else the hosts outside the ceiling,
 * at most 3 joined with `+`, each cut to 100 printable characters, then `+N` more (a lone host
 * named `mode` gets a trailing `+`). Short, as it travels in the lease's skip header.
 */
function ceilingMissing(
  egress: EgressPayload | undefined,
  ceiling: readonly string[] | null,
): string | null {
  if (ceilingRefusal(egress, ceiling === null ? null : [...ceiling]) === null) return null;
  if (!egress || egress.mode !== 'enforce') return CEILING_MODE;
  const outside = egress.allow.filter((e) => !entryCovered(e, [...(ceiling ?? [])]));
  const named = outside
    .slice(0, CEILING_HOSTS_SHOWN)
    .map((h) => h.replace(/[^\x21-\x2a\x2c-\x7e]/g, '?').slice(0, CEILING_HOST_CHARS));
  const more = outside.length - named.length;
  const hosts = [...named, ...(more > 0 ? [String(more)] : [])].join('+');
  // A lone host literally named `mode` would read as CEILING_MODE: a trailing `+` (an empty part,
  // which `ceilingHosts` drops) keeps the two apart.
  return `${CEILING_MISSING}${hosts}${`${CEILING_MISSING}${hosts}` === CEILING_MODE ? '+' : ''}`;
}

/**
 * What the stick lacks for these requirements (empty: it may run the zone's drops). A stick that
 * reported an egress ceiling lacks an `egress-ceiling:` item when it would refuse the zone's
 * egress (`ceilingRefusal`); one that reported none (null, or an older stick) has no ceiling.
 */
export function missingFor(
  stick: {
    capabilities: readonly string[];
    imagePolicy: ImagePolicy;
    egressCeiling?: readonly string[] | null;
  },
  need: ZoneRequirements,
): string[] {
  const missing: string[] = [...need.caps].filter((c) => !stick.capabilities.includes(c));
  if (need.signed && stick.imagePolicy !== 'signed') missing.push('image-policy:signed');
  const ceiling = ceilingMissing(need.egress, stick.egressCeiling ?? null);
  if (ceiling !== null) missing.push(ceiling);
  return missing;
}

/**
 * Excludes queued drops of zones the stick can't run (a JSON array of zone ids), and of roles it
 * must not be given (a JSON array of roles).
 */
const NOT_EXCLUDED = `AND drop_zone_id NOT IN (SELECT value FROM json_each(@exclude))
  AND role NOT IN (SELECT value FROM json_each(@excludeRoles))`;

/**
 * Leases the oldest queued drop the usage gate allows, bumping its epoch and stamping started_at.
 * `probe` leases exactly one drop (preferring one not on the pause's cause item) and records it.
 * `credits_resume` leases only the resumed work item's drops; with none queued, nothing. A stop
 * with no work item (a crew drop's) offers no Resume (credits.ts), so none binds to nothing. The gate is required: a caller that forgets it must not lease while stopped. All time
 * comes from `now`. Drops of the `exclude` zones (ones the stick can't run), and of the
 * `excludeRoles` (pushing roles, for a stick that can't take them), are never picked, under any
 * gate: they stay queued, untouched, for a capable stick. A stick that is gone or removed is leased
 * nothing (issue #255), checked in the same transaction as the lease, so a removal racing it either
 * comes first (nothing leased) or ends the lease it finds. Under `open` and `override`, a drop the
 * throttle would hold is skipped while `modelHeld` says its model's own window is at the threshold
 * (#747), before any override start is taken: the override lifts the account throttle only.
 */
export function leaseNextDrop(
  db: Db,
  stickId: string,
  now: Date,
  gate: Gate,
  exclude: readonly string[] = [],
  excludeRoles: readonly Role[] = [],
  modelHeld: (drop: HeldCandidate) => boolean = () => false,
): { dropId: string; epoch: number; overrideUntil?: string } | null {
  const ex = JSON.stringify(exclude);
  const exRoles = JSON.stringify(excludeRoles);
  return db.transaction(() => {
    if (isKilled(db)) return null;
    const live = db
      .prepare('SELECT 1 FROM sticks WHERE id = ? AND removed_at IS NULL')
      .get(stickId);
    if (!live) return null;
    let next: { id: string } | undefined;
    let probe = false;
    /** The override grant this lease took a start of, if any. */
    let start: string | null = null;
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
        .get({ cause: u.causeWorkItemId, exclude: ex, excludeRoles: exRoles }) as
        | { id: string }
        | undefined;
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
                .get({ bound, exclude: ex, excludeRoles: exRoles }) as { id: string } | undefined);
        break;
      }
      case 'open':
      case 'finishing_only':
      case 'override': {
        /**
         * The first queued candidate in order that its model's own window does not hold: a drop
         * the throttle would hold is skipped while `modelHeld` says its model is at the threshold
         * (#747). Skipped drops stay queued, untouched.
         */
        const pick = (filter: string): HeldCandidate | undefined =>
          (
            db
              .prepare(
                `SELECT id, role, drop_zone_id AS dropZoneId, work_item_id AS workItemId, input_json AS inputJson
               FROM drops WHERE state = 'queued' ${ZONE_ACTIVE} ${NOT_EXCLUDED}${filter}
               ORDER BY ${ROLE_CLASS}, created_at, rowid`,
              )
              .all({ exclude: ex, excludeRoles: exRoles }) as HeldCandidate[]
          ).find((row) => UNTHROTTLED.has(row.role) || !modelHeld(row));
        // Above the throttle only finishing work starts, and doctor drops (doctorMayLease): an
        // operator-asked readiness check, still last by ROLE_CLASS.
        const doctor = doctorMayLease(gate) ? '' : " AND role <> 'doctor'";
        const held = ` AND (role IN ${FINISHING} OR role = 'doctor')${doctor}`;
        const found = pick(gate === 'finishing_only' ? held : doctor);
        // Under Command's override each drop the throttle would hold takes one start, here in the
        // lease's transaction: a gate read before the last start was taken leases no more (#728).
        next = found;
        if (gate === 'override' && found && !UNTHROTTLED.has(found.role)) {
          start = takeOverrideStart(db, now);
          if (start === null) next = pick(held);
        }
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
    return {
      dropId: next.id,
      epoch: row.epoch,
      ...(start === null ? {} : { overrideUntil: start }),
    };
  })();
}

/**
 * Engages the kill switch: refuses all new work and cancels every queued, leased and running drop,
 * refunding its charge so a later reset doesn't count cancelled work as a repeat. A pending push is
 * left as it is: its agent has finished, and the switch only withholds its grant (and its
 * retention clock) until release.
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

/**
 * Releases the kill switch and credits the time it was engaged to every pending push's deadline
 * (Ruling 12), so retention counts only time a push could have run. Returns the paused ms (0 when
 * the switch was already off).
 */
export function releaseKill(db: Db, now: Date): number {
  return db.transaction((): number => {
    const paused = setKilled(db, false, now);
    if (paused <= 0) return 0;
    const rows = db
      .prepare(
        `SELECT id, push_deadline AS deadline FROM drops
         WHERE state = 'push_pending' AND push_deadline IS NOT NULL`,
      )
      .all() as { id: string; deadline: string }[];
    for (const r of rows) {
      const moved = new Date(Date.parse(r.deadline) + paused).toISOString();
      updateDrop(db, r.id, { pushDeadline: moved });
    }
    return paused;
  })();
}

/**
 * Gives up on a pending push whose retention ran out (Ruling 12: never while the switch is on): it
 * goes `lost`, with `running_at` cleared so no salvage brings it back, and its grants are revoked.
 * An implement item goes back to `ready`, as for any lost drop: the reconciler's resume picks up
 * the last pushed commit from the branch, charged to `resume` and parked when that is exhausted
 * (a fresh start when nothing was pushed). A heal or resolve item stays `pr_open`.
 */
function expireRetention(db: Db, now: Date): number {
  if (isKilled(db)) return 0;
  const ids = (
    db
      .prepare(
        `SELECT id FROM drops WHERE state = 'push_pending' AND push_deadline < ?
         ORDER BY push_deadline, rowid`,
      )
      .all(iso(now)) as { id: string }[]
  ).map((r) => r.id);
  for (const id of ids) {
    const drop = getDrop(db, id) as Drop;
    updateDrop(db, id, { state: 'lost', finishedAt: iso(now), runningAt: null });
    revokeGrants(db, id, now);
    appendEvents(db, id, [
      { ts: iso(now), kind: 'log', data: { message: 'push retention expired' } },
    ]);
    if (drop.role !== 'implement' || drop.workItemId === null) continue;
    if (getWorkItem(db, drop.workItemId)?.state !== 'in_flight') continue;
    setWorkItemState(db, drop.workItemId, 'ready', undefined, now);
  }
  return ids.length;
}

/**
 * Extends a live lease and moves leased to running, stamping `running_at` on the first such move;
 * reports stale/cancelled drops. A pending push has no lease to extend: it answers `killed` while
 * the kill switch is on, so its push container stops and keeps the volume, and `ok` otherwise.
 */
export function heartbeat(
  db: Db,
  dropId: string,
  stickId: string,
  epoch: number,
  now: Date,
): 'ok' | 'stale' | 'cancel' | 'hard_cancel' | 'killed' {
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
    if (d.state === 'push_pending') return isKilled(db) ? 'killed' : 'ok';
    if (d.state !== 'leased' && d.state !== 'running') return 'stale';
    db.prepare(
      `UPDATE drops SET state = 'running', lease_expires_at = @expires,
         started_at = COALESCE(started_at, @now), running_at = COALESCE(running_at, @now)
       WHERE id = @id`,
    ).run({ id: dropId, expires: iso(now, LEASE_TTL_MS), now: iso(now) });
    return 'ok';
  })();
}

/**
 * Marks drops with expired leases `lost` (finished_at = now), and pending pushes past their
 * retention (`expireRetention`, not while killed). Then returns in_flight work items to `ready`
 * once their latest drop has been lost for the grace period, no drop is active, and none may still
 * be salvaged (`reclaimableSql`: a drop that had run holds its item for the reclaim window).
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
    for (const id of lostIds) {
      releaseProbe(db, id, usageCfg, now, rand);
      // Bookkeeping only (#840): a GitLab token stays valid once handed out.
      revokeCloneGrants(db, id, now);
    }
    const lost = lostIds.length + expireRetention(db, now);
    db.prepare(
      `UPDATE work_items SET state = 'ready', updated_at = @now
       WHERE state = 'in_flight'
         AND NOT EXISTS (SELECT 1 FROM drops a WHERE a.work_item_id = work_items.id
                         AND a.state IN (${ACTIVE_STATES_SQL}))
         AND NOT EXISTS (SELECT 1 FROM drops r WHERE r.work_item_id = work_items.id
                         AND ${reclaimableSql('r')})
         AND (SELECT l.state FROM drops l WHERE l.work_item_id = work_items.id
              ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1) = 'lost'
         AND (SELECT l.finished_at FROM drops l WHERE l.work_item_id = work_items.id
              ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1) <= @cutoff`,
    ).run({ now: iso(now), cutoff: iso(now, -LOST_GRACE_MS), reclaimCutoff: reclaimCutoff(now) });
    return lost;
  })();
}

/** Pushes every live lease out to a full TTL from `now`. A pending push has no lease: untouched. */
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
 *
 * `usageCfg` may be a getter (the config store's current usage settings), read once per run.
 */
export function leaseExpirer(
  db: Db,
  usageCfg: UsageConfig | (() => UsageConfig) = DEFAULT_USAGE_CONFIG,
  rand: () => number = Math.random,
): (now: Date) => number {
  const usage = typeof usageCfg === 'function' ? usageCfg : () => usageCfg;
  let last: number | null = null;
  return (now) => {
    const t = now.getTime();
    const away = last === null || t - last > LEASE_TTL_MS;
    last = t;
    if (away) {
      extendLiveLeases(db, now);
      return 0;
    }
    return expireLeases(db, now, usage(), rand);
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
