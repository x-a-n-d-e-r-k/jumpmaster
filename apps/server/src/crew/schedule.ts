import { randomUUID } from 'node:crypto';
import type { Role } from '@jumpmaster/protocol';
import {
  raiseBriefing,
  recordDiagnosis,
  refuteExhaustedWhy,
  refuteVerdicts,
  whyBasis,
} from '../briefings.js';
import type { ClaudeConfig, DropZoneConfig, UsageConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  ACTIVE_DROP_STATES,
  ACTIVE_STATES_SQL,
  getPullRequest,
  getWorkItem,
  getZoneMode,
  insertDrop,
  isKilled,
  recordObservation,
  type WorkItem,
} from '../db/repo.js';
import { fableStatus } from '../fable.js';
import type { ZonePass } from '../flow/snapshot.js';
import { getGoals } from '../goals.js';
import { log } from '../log.js';
import { type ForgePair, unsanitizeForgeText } from '../outbox.js';
import type { CrewInputJson } from '../payloads.js';
import { dispatchGate, gateQueuesCrew } from '../usage.js';
import { crewIssueSlots, isSecurityTouching, OPEN_STATES } from './actions.js';
import { PROMOTE_OPTIONS, subjectOf } from './flush.js';
import { fetchIssueImages, type ImageFetchOpts } from './images.js';
import {
  arbitrateIssueInput,
  arbitrateItemInput,
  auditInput,
  crewLeadInput,
  diagnoseInput,
  lastHealFeedback,
  refuteInput,
  triageInput,
} from './inputs.js';
import {
  type Arbitration,
  type CrewIssue,
  getArbitration,
  getAuditCursor,
  getCrewIssue,
  getItemArbitration,
  getTriageRequest,
  hasVerifyingDoneClaim,
  insertArbitration,
  insertAudit,
  insertAuditCursor,
  issueArbitrationSubject,
  itemArbitrationSubject,
  moveAuditCursor,
  settleArbitration,
} from './store.js';

export type { CrewInputJson } from '../payloads.js';

export type CrewWork = CrewInputJson['work'];

/**
 * What `nextCrewWork` names: crew work, or an audit whose commit `enqueueCrew` resolves with forge
 * reads.
 */
export type CrewNext = Exclude<CrewWork, { role: 'audit' }> | { role: 'audit' };

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long after the last lead cycle an emptied queue may start an early one (#757). */
export const EARLY_CYCLE_MS = 10 * 60_000;

/**
 * Whether the zone's queue emptied since the lead cycle created at `lastAt`, so the lead may file
 * what just became possible: at least `EARLY_CYCLE_MS` since that cycle, no work item `ready`,
 * `in_flight` or `pr_open`, no crew issue in an open state, and an item `done` after that cycle.
 * The early cycle's own drop makes the last condition false again: at most one per emptying.
 */
function queueEmptied(db: Db, zoneId: string, lastAt: string, now: Date): boolean {
  if (now.getTime() - Date.parse(lastAt) < EARLY_CYCLE_MS) return false;
  const busy = db
    .prepare(
      `SELECT 1 FROM work_items WHERE drop_zone_id = ?
         AND state IN ('ready', 'in_flight', 'pr_open') LIMIT 1`,
    )
    .get(zoneId);
  if (busy) return false;
  const filing = db
    .prepare(
      `SELECT 1 FROM crew_issues WHERE zone_id = ?
         AND state IN (${OPEN_STATES.map(() => '?').join(', ')}) LIMIT 1`,
    )
    .get(zoneId, ...OPEN_STATES);
  if (filing) return false;
  const finished = db
    .prepare(
      `SELECT 1 FROM work_items WHERE drop_zone_id = ? AND state = 'done' AND updated_at > ?
       LIMIT 1`,
    )
    .get(zoneId, lastAt);
  return finished !== undefined;
}

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
 * Puts a staged crew issue whose refutes ran out to Command: promote it as it reads, or reject it.
 * The one place a `refute_exhausted` briefing is raised; its why ends with the arbiter's ruling on
 * this text, when one was settled.
 */
export function raiseRefuteExhausted(db: Db, zone: DropZoneConfig, c: CrewIssue, now: Date): void {
  const label = c.number !== null ? `crew issue #${c.number}` : `crew issue ${c.key}`;
  raiseBriefing(
    db,
    {
      zoneId: zone.id,
      kind: 'refute_exhausted',
      subject: subjectOf(c),
      decision: `Reviewers asked for changes to ${label} ${c.refuteCount} times, and its latest text hasn't been reviewed. Promote it as it reads now, or reject it?`,
      why: refuteExhaustedWhy(db, c),
      options: PROMOTE_OPTIONS,
      onHold: label,
      source: 'server',
    },
    now,
  );
}

const dropActive = (db: Db, dropId: string): boolean => {
  const drop = db.prepare('SELECT state FROM drops WHERE id = ?').get(dropId) as
    | { state: string }
    | undefined;
  return drop !== undefined && (ACTIVE_DROP_STATES as readonly string[]).includes(drop.state);
};

/**
 * Briefs Command on an item's arbitration that does not act: the ruling (or why there is none)
 * becomes the open parked briefing's diagnosis, and the briefing counts as diagnosed, so no
 * diagnose drop runs on top. The item stays parked; nothing retries it.
 */
export function briefItemRuling(
  db: Db,
  itemId: number,
  diagnosis: string,
  recommendation: string,
  now: Date,
): void {
  const b = db
    .prepare(
      `SELECT id, why FROM briefings WHERE kind = 'parked' AND state = 'open' AND subject = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(itemArbitrationSubject(itemId)) as { id: number; why: string } | undefined;
  if (!b) return;
  recordDiagnosis(
    db,
    b.id,
    { diagnosis, basis: whyBasis(b.why), recommendation: `needs_command: ${recommendation}` },
    now,
    { spent: true },
  );
}

/**
 * An item's arbitration that came to nothing (a lost, failed, rate-limited or invalid drop): it is
 * `failed` with the reason, once, and Command is briefed on the parked item. Fails closed.
 */
export function itemArbitrationFailed(db: Db, row: Arbitration, reason: string, now: Date): void {
  if (!settleArbitration(db, row.id, { state: 'failed', reason }, now)) return;
  const id = Number(row.subject.slice('item:'.length));
  briefItemRuling(db, id, `The arbiter could not rule: ${reason}.`, reason, now);
}

/** The one park reason a review disagreement can have: the item ran out of heals. */
export const HEAL_EXHAUSTED = 'budget exhausted: heal';

/**
 * Whether a parked item is a review disagreement the arbiter may rule on: parked on exactly
 * `budget exhausted: heal`, its PR open with a `request_changes` verdict on the current head, its
 * newest heal drop's stored feedback from the automated `review` (never a person's change request,
 * never CI), an open parked briefing, and no arbitration of this item ever. Every fact is the
 * server's own record, never an agent's report.
 */
export function reviewDisagreement(db: Db, item: WorkItem): boolean {
  if (item.state !== 'parked' || item.reason !== HEAL_EXHAUSTED) return false;
  const pr = getPullRequest(db, item.id);
  if (!pr || pr.state !== 'open' || !pr.headSha) return false;
  const rc = db
    .prepare(
      `SELECT 1 FROM verdicts WHERE work_item_id = ? AND head_sha = ?
         AND decision = 'request_changes' LIMIT 1`,
    )
    .get(item.id, pr.headSha);
  if (!rc) return false;
  if (lastHealFeedback(db, item.id)?.source !== 'review') return false;
  const briefing = db
    .prepare(
      `SELECT 1 FROM briefings WHERE zone_id = ? AND kind = 'parked' AND state = 'open'
         AND subject = ? LIMIT 1`,
    )
    .get(item.dropZoneId, itemArbitrationSubject(item.id));
  if (!briefing) return false;
  return getItemArbitration(db, item.id) === undefined;
}

/**
 * The zone's next work on its parked briefings: an open one not yet diagnosed is arbitrated when
 * its item is a review disagreement (`reviewDisagreement`, with `crew.arbiter` on and Fable
 * available), skipped while that arbitration is in flight or waits to be applied, and else
 * diagnosed. It answers a park the server raised, so it runs at the daily crew cap too. A diagnose
 * that failed only because the head moved gave its attempt back (`rerunStaleDiagnose`), so it is
 * picked again here.
 */
export function nextDiagnose(
  db: Db,
  zone: DropZoneConfig,
  now: Date,
  fableOk = false,
): CrewWork | null {
  const parked = db
    .prepare(
      `SELECT id, subject, why FROM briefings WHERE zone_id = ? AND kind = 'parked'
         AND state = 'open' AND diagnose_attempts < 1 ORDER BY id`,
    )
    .all(zone.id) as { id: number; subject: string; why: string }[];
  for (const b of parked) {
    const m = /^item:(\d+)$/.exec(b.subject);
    // The basis ties the diagnosis to this why: one that lands after the why changed is dropped.
    if (!m) continue;
    const itemId = Number(m[1]);
    // A claim that the item is already done waits for the trail pass to verify it (#536).
    if (hasVerifyingDoneClaim(db, itemId)) continue;
    const row = getItemArbitration(db, itemId);
    if (row?.state === 'pending') {
      if (dropActive(db, row.dropId)) continue; // its drop is in flight: neither arbitrate nor diagnose
      // Its drop ended without a result applied (lost): fail closed, as a failed drop would.
      itemArbitrationFailed(db, row, 'the arbitrate drop ended without a ruling', now);
      continue;
    }
    // An acting ruling waits for its retry (applyArbitrations), not for a diagnosis.
    if (row?.state === 'ruled' && row.acted && row.appliedAt === null) continue;
    const item = getWorkItem(db, itemId);
    if (!row && zone.crew.arbiter && fableOk && item && reviewDisagreement(db, item)) {
      const headSha = getPullRequest(db, itemId)?.headSha;
      if (headSha) {
        return {
          role: 'arbitrate',
          subject: 'item',
          itemId,
          briefingId: b.id,
          headSha,
          basis: 'review',
        };
      }
    }
    return { role: 'diagnose', briefingId: b.id, itemId, basis: whyBasis(b.why) };
  }
  return null;
}

/**
 * The zone's next crew work, in order: a parked briefing's arbitration or diagnosis
 * (`nextDiagnose`); then refute a staged crew issue whose current body is unrefuted (within `maxRefute`), arbitrate one whose
 * refutes ran out (with `crew.arbiter` on, Fable available, at least one stored verdict, and no
 * arbitration of this text yet), triage the oldest open triage request (within `maxTriage`, with a
 * slot free), then the lead cycle when it is due (by time, a ruling, a request, or the queue
 * emptying: `queueEmptied`), then an audit of a merged commit (`auditDue`). An
 * exhausted issue that may not be arbitrated, or whose arbitration of this text is settled, is put
 * to Command instead.
 */
export function nextCrewWork(
  db: Db,
  zone: DropZoneConfig,
  now: Date,
  fableOk = false,
): CrewNext | null {
  const parkedWork = nextDiagnose(db, zone, now, fableOk);
  if (parkedWork) return parkedWork;

  const refute = db
    .prepare(
      `SELECT id FROM crew_issues WHERE zone_id = ? AND state = 'staged' AND body_sha IS NOT NULL
         AND (refuted_sha IS NULL OR refuted_sha <> body_sha) AND refute_count < ?
       ORDER BY id LIMIT 1`,
    )
    .get(zone.id, zone.crew.maxRefute) as { id: number } | undefined;
  if (refute) return { role: 'refute', crewIssueId: refute.id };

  // The refute budget is used up with the current body unjudged (every review asked for changes,
  // or the attempts died): an arbiter rules on it once per text, or it is put to Command rather
  // than left staged forever.
  const exhausted = db
    .prepare(
      `SELECT id FROM crew_issues WHERE zone_id = ? AND state = 'staged'
         AND body_sha IS NOT NULL AND (refuted_sha IS NULL OR refuted_sha <> body_sha)
         AND refute_count >= ? ORDER BY id`,
    )
    .all(zone.id, zone.crew.maxRefute) as { id: number }[];
  let arbitrate: CrewWork | null = null;
  for (const { id } of exhausted) {
    const c = getCrewIssue(db, id);
    if (!c || c.bodySha === null) continue;
    const subject = issueArbitrationSubject(c.id);
    const row = getArbitration(db, subject, c.bodySha);
    if (row?.state === 'pending') {
      if (dropActive(db, row.dropId)) continue; // its drop is in flight
      // Its drop ended without a result applied (lost): fail closed, as a failed drop would.
      settleArbitration(
        db,
        row.id,
        { state: 'failed', reason: 'the arbitrate drop ended without a ruling' },
        now,
      );
    } else if (!row && zone.crew.arbiter && fableOk && refuteVerdicts(db, c).length > 0) {
      arbitrate ??= { role: 'arbitrate', subject: 'issue', crewIssueId: c.id, basis: c.bodySha };
      continue;
    }
    raiseRefuteExhausted(db, zone, c, now);
  }
  if (arbitrate) return arbitrate;

  const triage = nextTriage(db, zone, now);
  if (triage !== null) return { role: 'triage', requestId: triage };

  const last = db
    .prepare(
      `SELECT created_at AS at, rowid AS rid FROM drops WHERE drop_zone_id = ? AND role = 'crew-lead'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(zone.id) as { at: string; rid: number } | undefined;
  if (!last) return { role: 'crew-lead' };
  if (now.getTime() - Date.parse(last.at) >= zone.crew.cycleMinutes * 60_000) {
    return { role: 'crew-lead' };
  }
  const ruled = db
    .prepare(
      `SELECT 1 FROM rulings r JOIN briefings b ON b.id = r.briefing_id
       WHERE r.zone_id = ? AND r.created_at > ?
         AND b.kind IN ('crew', 'promote', 'promote_held', 'refute_exhausted') LIMIT 1`,
    )
    .get(zone.id, last.at);
  const requested = cycleRequests.get(zone.id);
  if (ruled || (requested !== undefined && requested > last.at)) return { role: 'crew-lead' };
  if (queueEmptied(db, zone.id, last.at, now)) return { role: 'crew-lead' };
  return auditDue(db, zone, last) ? { role: 'audit' } : null;
}

/**
 * Whether the zone audits a merged commit now, in the lead cycle that began with `lead`: with
 * `crew.auditPerCycle` above 0, fewer audit drops than that created since the lead drop, a
 * crew-issue slot free (a refutation files one), and the cursor missing, not checked since the
 * lead drop, or with commits pending.
 */
function auditDue(db: Db, zone: DropZoneConfig, lead: { at: string; rid: number }): boolean {
  const per = zone.crew.auditPerCycle ?? 0;
  if (per <= 0) return false;
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drops WHERE drop_zone_id = ? AND role = 'audit'
         AND (created_at > ? OR (created_at = ? AND rowid > ?))`,
    )
    .get(zone.id, lead.at, lead.at, lead.rid) as { n: number };
  if (n >= per) return false;
  if (crewIssueSlots(db, zone) < 1) return false;
  const cursor = getAuditCursor(db, zone.id);
  return !cursor || cursor.checkedAt < lead.at || cursor.pending > 0;
}

/**
 * Audits whose drop ended without a verdict applied (lost or cancelled) are `failed`, so every row
 * says what became of its commit. The cursor has moved: the commit is not audited again.
 */
export function settleLostAudits(db: Db, zoneId: string, now: Date): void {
  db.prepare(
    `UPDATE crew_audits SET state = 'failed', reason = 'the audit drop ended without a verdict',
       updated_at = ?
     WHERE zone_id = ? AND state = 'running' AND drop_id IN (
       SELECT id FROM drops WHERE drop_zone_id = ? AND state NOT IN (${ACTIVE_STATES_SQL}))`,
  ).run(now.toISOString(), zoneId, zoneId);
}

/** A pass that lost the race to move the audit cursor: rolls its drop back. */
class AuditCursorMoved extends Error {}

/**
 * Resolves the commit an audit is for, with forge reads: the oldest first-parent commit on the
 * default branch after the zone's cursor. With no cursor, one is stored at the head and nothing is
 * audited (audits start from now); with history the cursor can't be walked from, the cursor moves
 * to the head and an `audit_skipped` observation says why; with nothing new, the cursor is marked
 * checked. Returns the work and the cursor SHA read, or null when there is nothing to audit.
 */
async function resolveAudit(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
  /** Observe mode: read only, moving nothing and recording nothing. */
  readOnly = false,
): Promise<{ work: Extract<CrewWork, { role: 'audit' }>; from: string; pending: number } | null> {
  const row = db.prepare('SELECT default_branch AS b FROM drop_zones WHERE id = ?').get(zone.id) as
    | { b: string }
    | undefined;
  const branch = row?.b ?? 'main';
  const head = await forges.author.branchSha(branch);
  if (head === null) return null;
  const cursor = getAuditCursor(db, zone.id);
  if (!cursor) {
    if (!readOnly) insertAuditCursor(db, zone.id, head, now);
    return null;
  }
  const from = cursor.auditedSha;
  const found = await forges.author.firstParentCommits(from, head, zone.crew.auditPerCycle + 1);
  if (!found.complete) {
    if (!readOnly && moveAuditCursor(db, zone.id, from, head, 0, now)) {
      recordObservation(
        db,
        zone.id,
        null,
        'audit_skipped',
        `commit ${from.slice(0, 7)} is not a first-parent ancestor of ${branch} at ${head.slice(0, 7)} within one compare; audits resume from ${head.slice(0, 7)}`,
        now,
      );
    }
    return null;
  }
  const [oldest] = found.commits;
  if (!oldest) {
    if (!readOnly) moveAuditCursor(db, zone.id, from, from, 0, now);
    return null;
  }
  return {
    work: { role: 'audit', sha: oldest.sha, message: oldest.message },
    from,
    pending: found.commits.length - 1,
  };
}

/**
 * The oldest open triage request with attempts left, if the zone is active, its crew on and a
 * crew-issue slot free. A request waiting on Command comes back to open once its briefing is ruled.
 */
function nextTriage(db: Db, zone: DropZoneConfig, now: Date): number | null {
  if (!zone.crew?.enabled) return null;
  db.prepare(
    `UPDATE triage_requests SET state = 'open', updated_at = ?
       WHERE zone_id = ? AND state = 'waiting'
         AND briefing_id IN (SELECT briefing_id FROM rulings WHERE zone_id = ?)`,
  ).run(now.toISOString(), zone.id, zone.id);
  if (getZoneMode(db, zone.id, zone.mode) !== 'active') return null;
  if (crewIssueSlots(db, zone) < 1) return null;
  const row = db
    .prepare(
      `SELECT id FROM triage_requests WHERE zone_id = ? AND state = 'open' AND attempts < ?
       ORDER BY id LIMIT 1`,
    )
    .get(zone.id, zone.crew.maxTriage) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Crew drops created in the trailing 24 hours, not counting lost or rate-limited ones, doctor
 * drops, nor diagnose drops: a diagnosis answers a park the server raised, one per park
 * (`diagnose_attempts`; a stale failure is rerun at most twice, `rerunStaleDiagnose`), so it is not
 * the crew's self-directed spend the cap bounds.
 */
export function crewDropsToday(db: Db, zoneId: string, now: Date): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM drops WHERE drop_zone_id = ? AND work_item_id IS NULL
         AND role NOT IN ('doctor', 'diagnose') AND created_at > ? AND state <> 'lost'
         AND COALESCE(json_extract(result_json, '$.status'), '') <> 'rate_limited'`,
    )
    .get(zoneId, new Date(now.getTime() - DAY_MS).toISOString()) as { n: number };
  return n;
}

const hasActiveCrewDrop = (db: Db, zoneId: string): boolean =>
  db
    .prepare(
      `SELECT 1 FROM drops WHERE drop_zone_id = ? AND work_item_id IS NULL AND role <> 'doctor'
         AND state IN (${ACTIVE_STATES_SQL}) LIMIT 1`,
    )
    .get(zoneId) !== undefined;

const observeDetail = (w: CrewNext, auditSha?: string): string =>
  w.role === 'diagnose' || (w.role === 'arbitrate' && w.subject === 'item')
    ? `briefing ${w.briefingId}`
    : w.role === 'refute' || w.role === 'arbitrate'
      ? `crew issue ${w.crewIssueId}`
      : w.role === 'triage'
        ? `triage request ${w.requestId}`
        : w.role === 'audit'
          ? `commit ${(auditSha ?? '').slice(0, 7)}`
          : 'lead cycle';

/**
 * Queues the zone's next crew drop, if any, with its rendered input. Runs only with the crew
 * enabled, the zone active (observe records `would_enqueue:<role>` instead), the kill switch off,
 * the usage gate open, and no crew drop active. At a positive `maxDropsPerDay` (0 is no limit)
 * only a parked briefing's diagnosis (or arbitration) is queued (`nextDiagnose`); diagnoses don't
 * count. The lead cycle also
 * needs a parsed GOAL.md. Attempts are counted here, at enqueue. With `images`, a triage drop
 * also carries the issue's images, fetched and checked here (`crew/images.ts`).
 */
export async function enqueueCrew(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  now: Date,
  images?: ImageFetchOpts,
  opts: { claude?: ClaudeConfig; secrets?: string[] } = {},
): Promise<string | null> {
  if (!zone.crew?.enabled || isKilled(db)) return null;
  const mode = getZoneMode(db, zone.id, zone.mode);
  if (mode === 'paused') return null;
  if (!gateQueuesCrew(dispatchGate(db, usageCfg, now))) return null;
  if (hasActiveCrewDrop(db, zone.id)) return null;
  // 0 means no daily limit: the usage gate above alone paces the crew.
  const cap = zone.crew.maxDropsPerDay;
  // No claude config means no Fable, so nothing is arbitrated: it is put to Command as before.
  const fableOk = opts.claude ? fableStatus(db, { claude: opts.claude }, now).available : false;
  settleLostAudits(db, zone.id, now);
  // At the cap only parked briefings are worked on: nextCrewWork's other branches (and their side
  // effects: refute exhaustion put to Command, arbitrations settled, triage reopened) wait.
  const capped = cap > 0 && crewDropsToday(db, zone.id, now) >= cap;
  const next = capped ? nextDiagnose(db, zone, now, fableOk) : nextCrewWork(db, zone, now, fableOk);
  if (!next) return null;
  if (next.role === 'crew-lead' && getGoals(db, zone.id)?.parse.ok !== true) return null;
  if (mode === 'observe') {
    const itemId =
      next.role === 'diagnose' || (next.role === 'arbitrate' && next.subject === 'item')
        ? next.itemId
        : null;
    let auditSha: string | undefined;
    if (next.role === 'audit') {
      // Observe reads which commit it would audit, and moves nothing.
      try {
        auditSha = (await resolveAudit(db, forges, zone, now, true))?.work.sha;
      } catch (err) {
        log(`zone ${zone.id}: crew audit read failed: ${String(err)}`);
        return null;
      }
      if (auditSha === undefined) return null;
    }
    recordObservation(
      db,
      zone.id,
      itemId,
      `would_enqueue:${next.role}`,
      observeDetail(next, auditSha),
      now,
    );
    return null;
  }

  const id = randomUUID();
  let input: string;
  let work: CrewWork;
  let audit: { from: string; pending: number } | undefined;
  try {
    if (next.role === 'audit') {
      const resolved = await resolveAudit(db, forges, zone, now);
      if (!resolved) return null;
      work = resolved.work;
      audit = { from: resolved.from, pending: resolved.pending };
    } else {
      work = next;
    }
    input =
      work.role === 'audit'
        ? auditInput(db, zone, work, id)
        : work.role === 'crew-lead'
          ? await crewLeadInput(db, forges, zone, pass, now, id)
          : work.role === 'refute'
            ? refuteInput(db, zone, work.crewIssueId, id)
            : work.role === 'arbitrate'
              ? work.subject === 'item'
                ? arbitrateItemInput(db, zone, work, id)
                : arbitrateIssueInput(db, zone, work, id)
              : work.role === 'triage'
                ? triageInput(db, zone, work.requestId, id)
                : diagnoseInput(db, zone, work.itemId, id, opts.secrets ?? []);
  } catch (err) {
    // A forge read failed while gathering input: try again next pass.
    log(`zone ${zone.id}: crew ${next.role} input failed: ${String(err)}`);
    return null;
  }
  // Read with the row refuteInput just rendered (no await between): its model is chosen at lease.
  const stored: CrewInputJson = {
    work:
      work.role === 'refute'
        ? {
            ...work,
            securityTouching: isSecurityTouching(getCrewIssue(db, work.crewIssueId)?.body ?? ''),
          }
        : work,
    input,
  };
  if (work.role === 'triage' && images) {
    // The issue's images, fetched here: the server has the network and the read token, the
    // trooper's egress does not. A failure skips that image; it never stops the drop.
    const req = getTriageRequest(db, work.requestId);
    const found = await fetchIssueImages(unsanitizeForgeText(req?.body ?? ''), images);
    stored.images = found.images;
    stored.imagesSkipped = found.imagesSkipped;
  }
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
      } else if (work.role === 'arbitrate') {
        // One arbitration per text (an issue) or per item ever: a second for the same (subject,
        // basis) rolls the drop back.
        insertArbitration(
          db,
          {
            zoneId: zone.id,
            subject:
              work.subject === 'item'
                ? itemArbitrationSubject(work.itemId)
                : issueArbitrationSubject(work.crewIssueId),
            basis: work.basis,
            dropId: id,
          },
          now,
        );
      } else if (work.role === 'audit' && audit) {
        // One audit per commit ever (UNIQUE rolls a second back), and the cursor moves only from
        // the SHA this pass read: a pass that lost the race rolls back.
        insertAudit(db, { zoneId: zone.id, sha: work.sha, dropId: id }, now);
        if (!moveAuditCursor(db, zone.id, audit.from, work.sha, audit.pending, now)) {
          throw new AuditCursorMoved();
        }
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
    // Another crew drop became active, this text was arbitrated already, this commit was audited
    // already, or another pass moved the audit cursor: rolled back.
    if (isUniqueViolation(e) || e instanceof AuditCursorMoved) return null;
    throw e;
  }
  return id;
}
