import { randomUUID } from 'node:crypto';
import type { Role } from '@jumpmaster/protocol';
import type { DropZoneConfig, UsageConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode, insertDrop, isKilled, recordObservation } from '../db/repo.js';
import type { ZonePass } from '../flow/snapshot.js';
import { getGoals } from '../goals.js';
import type { ForgePair } from '../outbox.js';
import type { CrewInputJson } from '../payloads.js';
import { dispatchGate } from '../usage.js';
import { crewLeadInput, diagnoseInput, refuteInput } from './inputs.js';

export type { CrewInputJson } from '../payloads.js';

export type CrewWork = CrewInputJson['work'];

const DAY_MS = 24 * 60 * 60 * 1000;

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/.test(e.message);

/**
 * Operator requests for a lead cycle (`ctl crew-cycle`), by zone. Kept in memory: after a restart
 * the cycle comes due by time as usual.
 */
const cycleRequests = new Map<string, string>();

/** Makes the zone's lead cycle due now (it runs once the other crew work and gates allow). */
export function requestCrewCycle(zoneId: string, now: Date): void {
  cycleRequests.set(zoneId, now.toISOString());
}

/**
 * The zone's next crew work, in order: diagnose an open parked briefing not yet diagnosed, refute a
 * staged crew issue whose current body is unrefuted (within `maxRefute`), then the lead cycle when
 * it is due.
 */
export function nextCrewWork(db: Db, zone: DropZoneConfig, now: Date): CrewWork | null {
  const parked = db
    .prepare(
      `SELECT id, subject FROM briefings WHERE zone_id = ? AND kind = 'parked' AND state = 'open'
         AND diagnose_attempts < 1 ORDER BY id`,
    )
    .all(zone.id) as { id: number; subject: string }[];
  for (const b of parked) {
    const m = /^item:(\d+)$/.exec(b.subject);
    if (m) return { role: 'diagnose', briefingId: b.id, itemId: Number(m[1]) };
  }

  const refute = db
    .prepare(
      `SELECT id FROM crew_issues WHERE zone_id = ? AND state = 'staged' AND body_sha IS NOT NULL
         AND (refuted_sha IS NULL OR refuted_sha <> body_sha) AND refute_count < ?
       ORDER BY id LIMIT 1`,
    )
    .get(zone.id, zone.crew.maxRefute) as { id: number } | undefined;
  if (refute) return { role: 'refute', crewIssueId: refute.id };

  const last = db
    .prepare(
      `SELECT created_at AS at FROM drops WHERE drop_zone_id = ? AND role = 'crew-lead'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(zone.id) as { at: string } | undefined;
  if (!last) return { role: 'crew-lead' };
  if (now.getTime() - Date.parse(last.at) >= zone.crew.cycleMinutes * 60_000) {
    return { role: 'crew-lead' };
  }
  const ruled = db
    .prepare('SELECT 1 FROM rulings WHERE zone_id = ? AND created_at > ? LIMIT 1')
    .get(zone.id, last.at);
  const requested = cycleRequests.get(zone.id);
  if (ruled || (requested !== undefined && requested > last.at)) return { role: 'crew-lead' };
  return null;
}

/** Crew drops created in the trailing 24 hours, not counting lost or rate-limited ones. */
export function crewDropsToday(db: Db, zoneId: string, now: Date): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drops WHERE drop_zone_id = ? AND work_item_id IS NULL
         AND created_at > ? AND state <> 'lost'
         AND COALESCE(json_extract(result_json, '$.status'), '') <> 'rate_limited'`,
    )
    .get(zoneId, new Date(now.getTime() - DAY_MS).toISOString()) as { n: number };
  return n;
}

const hasActiveCrewDrop = (db: Db, zoneId: string): boolean =>
  db
    .prepare(
      `SELECT 1 FROM drops WHERE drop_zone_id = ? AND work_item_id IS NULL
         AND state IN ('queued', 'leased', 'running') LIMIT 1`,
    )
    .get(zoneId) !== undefined;

const observeDetail = (w: CrewWork): string =>
  w.role === 'diagnose'
    ? `briefing ${w.briefingId}`
    : w.role === 'refute'
      ? `crew issue ${w.crewIssueId}`
      : 'lead cycle';

/**
 * Queues the zone's next crew drop, if any, with its rendered input. Runs only with the crew
 * enabled, the zone active (observe records `would_enqueue:<role>` instead), the kill switch off,
 * the usage gate open, no crew drop active, and the zone under `maxDropsPerDay`. The lead cycle also
 * needs a parsed GOAL.md. Attempts are counted here, at enqueue.
 */
export async function enqueueCrew(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  now: Date,
): Promise<string | null> {
  if (!zone.crew?.enabled || isKilled(db)) return null;
  const mode = getZoneMode(db, zone.id, zone.mode);
  if (mode === 'paused') return null;
  if (dispatchGate(db, usageCfg, now) !== 'open') return null;
  if (hasActiveCrewDrop(db, zone.id)) return null;
  if (crewDropsToday(db, zone.id, now) >= zone.crew.maxDropsPerDay) return null;
  const work = nextCrewWork(db, zone, now);
  if (!work) return null;
  if (work.role === 'crew-lead' && getGoals(db, zone.id)?.parse.ok !== true) return null;
  if (mode === 'observe') {
    const itemId = work.role === 'diagnose' ? work.itemId : null;
    recordObservation(db, zone.id, itemId, `would_enqueue:${work.role}`, observeDetail(work), now);
    return null;
  }

  const id = randomUUID();
  let input: string;
  try {
    input =
      work.role === 'crew-lead'
        ? await crewLeadInput(db, forges, zone, pass, now, id)
        : work.role === 'refute'
          ? refuteInput(db, zone, work.crewIssueId, id)
          : diagnoseInput(db, zone, work.itemId, id);
  } catch (err) {
    // A forge read failed while gathering input: try again next pass.
    console.warn(`zone ${zone.id}: crew ${work.role} input failed: ${String(err)}`);
    return null;
  }
  const stored: CrewInputJson = { work, input };
  try {
    db.transaction(() => {
      if (work.role === 'diagnose') {
        db.prepare(
          'UPDATE briefings SET diagnose_attempts = diagnose_attempts + 1 WHERE id = ?',
        ).run(work.briefingId);
      } else if (work.role === 'refute') {
        db.prepare('UPDATE crew_issues SET refute_count = refute_count + 1 WHERE id = ?').run(
          work.crewIssueId,
        );
      }
      insertDrop(db, {
        id,
        dropZoneId: zone.id,
        workItemId: null,
        role: work.role,
        state: 'queued',
        promptVersion: versions[work.role],
        image: zone.image,
        inputJson: JSON.stringify(stored),
        createdAt: now.toISOString(),
      });
    })();
  } catch (e) {
    if (isUniqueViolation(e)) return null; // another crew drop became active: rolled back
    throw e;
  }
  return id;
}
