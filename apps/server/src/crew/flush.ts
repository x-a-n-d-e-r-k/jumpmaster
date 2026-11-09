import { createHash } from 'node:crypto';
import { hasOpenBriefing, raiseBriefing, withdrawBriefing } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getOutbox, getZoneMode, isKilled } from '../db/repo.js';
import {
  bodyWithoutMarker,
  type CreateIssuePayload,
  type ForgePair,
  type OpResult,
  opKeys,
  recordFiledNumber,
  runOp,
  type SetLabelsPayload,
  sanitizeCrewText,
  type UpdateIssuePayload,
} from '../outbox.js';
import {
  type CrewIssue,
  type CrewIssuePatch,
  type CrewIssueState,
  getCrewIssue,
  INTAKE_SOURCE,
  listCrewIssues,
  setCrewIssue,
} from './store.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Line endings normalised to LF, so a forge that stores CRLF compares equal. */
const lf = (s: string): string => s.replace(/\r\n?/g, '\n');

/** The hash a promotion compares: the sanitised body as written, without its marker line. */
export const crewBodySha = (sanitised: string): string => sha256(lf(sanitised).trimEnd());

/** The live forge body as a crew issue stores it: marker line removed, LF line endings. */
export const liveCrewBody = (body: string): string => bodyWithoutMarker(lf(body));

/** The briefing subject for a crew issue. */
export const subjectOf = (row: Pick<CrewIssue, 'id'>): string => `issue:${row.id}`;

export const PROMOTE_OPTIONS = [
  { id: 'promote', label: 'Promote', effect: 'promote_issue' as const },
  { id: 'reject', label: 'Reject', effect: 'reject_issue' as const },
];

const PENDING: CrewIssueState[] = ['filing', 'promote_held', 'promoting', 'revising', 'rejecting'];

type Step = { result: OpResult; done: CrewIssuePatch };

/**
 * Whether another crew issue of the same objective is promoted and its work is not merged yet.
 * Without blocker links this keeps an objective's issues landing one at a time.
 */
function objectiveBusy(db: Db, row: CrewIssue): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM crew_issues c
           LEFT JOIN work_items w ON w.drop_zone_id = c.zone_id AND w.issue_number = c.number
         WHERE c.zone_id = ? AND c.objective = ? AND c.id <> ? AND c.state = 'promoted'
           AND NOT (COALESCE(w.state, '') = 'done' AND COALESCE(w.reason, '') = 'merged')
         LIMIT 1`,
      )
      .get(row.zoneId, row.objective, row.id) !== undefined
  );
}

async function file(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  row: CrewIssue,
  secrets: string[],
  now: Date,
): Promise<Step> {
  const title = sanitizeCrewText(row.title, secrets);
  const body = sanitizeCrewText(row.body, secrets);
  const bodySha = crewBodySha(body);
  if (row.bodySha !== bodySha) setCrewIssue(db, row.id, { bodySha }, now);
  const payload: CreateIssuePayload = {
    title,
    body,
    labels: [zone.crew.stagedLabel, ...(row.priority ? [row.priority] : [])],
    since: row.createdAt,
  };
  const result = await runOp(
    db,
    forges,
    {
      kind: 'create_issue',
      opKey: opKeys.issue(zone.id, row.objective, row.key),
      zoneId: zone.id,
      itemId: null,
      payload,
    },
    now,
  );
  const number = (result.result as { number?: number } | undefined)?.number;
  return { result, done: { state: 'staged', ...(number !== undefined ? { number } : {}) } };
}

/** `null` when the promotion must wait (or go back to staged) instead of writing labels. */
async function promote(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  row: CrewIssue,
  now: Date,
): Promise<Step | 'wait' | 'changed'> {
  if (row.number === null) return 'wait';
  if (objectiveBusy(db, row)) return 'wait';
  const live = await forges.author.getIssue(row.number);
  if (!live) return 'wait';
  // A body edited on the forge since it was staged is not what Command approved.
  if (row.bodySha === null || crewBodySha(liveCrewBody(live.body)) !== row.bodySha) {
    return 'changed';
  }
  const payload: SetLabelsPayload = {
    number: row.number,
    add: [zone.readyLabel],
    remove: [zone.crew.stagedLabel],
  };
  const result = await runOp(
    db,
    forges,
    { kind: 'set_labels', opKey: opKeys.promote(row.id), zoneId: zone.id, itemId: null, payload },
    now,
  );
  return { result, done: { state: 'promoted' } };
}

async function revise(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  row: CrewIssue,
  secrets: string[],
  now: Date,
): Promise<Step | 'wait'> {
  if (row.number === null) return 'wait';
  const title = sanitizeCrewText(row.title, secrets);
  const body = sanitizeCrewText(row.body, secrets);
  const bodySha = crewBodySha(body);
  const payload: UpdateIssuePayload = { number: row.number, title, body };
  const result = await runOp(
    db,
    forges,
    {
      kind: 'update_issue',
      opKey: opKeys.update(row.id, bodySha.slice(0, 12)),
      zoneId: zone.id,
      itemId: null,
      payload,
    },
    now,
  );
  return { result, done: { state: 'staged', bodySha } };
}

async function reject(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  row: CrewIssue,
  now: Date,
): Promise<Step | 'wait'> {
  if (row.number === null) return 'wait';
  const payload: UpdateIssuePayload = { number: row.number, state: 'closed' };
  const result = await runOp(
    db,
    forges,
    { kind: 'update_issue', opKey: opKeys.close(row.id), zoneId: zone.id, itemId: null, payload },
    now,
  );
  return { result, done: { state: 'rejected' } };
}

/** Whether Command rejected the issue by a ruling that has been applied (not a refute verdict). */
function rejectedByCommand(db: Db, row: CrewIssue): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM rulings r JOIN briefings b ON b.id = r.briefing_id, json_each(b.options_json) o
         WHERE b.zone_id = ? AND b.subject = ? AND r.applied_at IS NOT NULL
           AND json_extract(o.value, '$.id') = r.choice
           AND json_extract(o.value, '$.effect') = 'reject_issue'
         LIMIT 1`,
      )
      .get(row.zoneId, subjectOf(row)) !== undefined
  );
}

/**
 * Moves crew issues along by their forge writes, all through the outbox as the author identity.
 * Only in an active zone with the kill switch off; returns how many issues changed state. With the
 * zone's crew disabled nothing is filed, promoted (a refute hold neither starts nor ends), revised
 * or closed by the crew: those rows wait as they are until it is enabled again. The one write that
 * goes ahead is the close of an issue Command rejected by ruling (its brake); a `rejecting` row from
 * a refute verdict waits like the rest.
 */
export async function flushCrewOps(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  secrets: string[],
  now: Date,
  /** How long a held refute promotion waits once an active pass has seen it (one poll). */
  holdMs = 60_000,
): Promise<number> {
  if (isKilled(db) || getZoneMode(db, zone.id, zone.mode) !== 'active') return 0;
  const crewOn = zone.crew?.enabled === true;
  let moved = 0;
  for (const row of listCrewIssues(db, zone.id, PENDING)) {
    // An intake row is Command's issue, filed ready by its own route: never a staged crew filing.
    if (row.source === INTAKE_SOURCE) continue;
    if (!crewOn) {
      // No forge write, but a create that already resolved gives the row its number, so intake
      // knows the issue as crew.
      if (row.state === 'filing' && row.number === null) {
        const op = getOutbox(db, opKeys.issue(zone.id, row.objective, row.key));
        if (op?.state === 'done' && op.resultJson != null) {
          recordFiledNumber(db, op.opKey, JSON.parse(op.resultJson), now);
        }
      }
      if (row.state !== 'rejecting' || !rejectedByCommand(db, row)) continue;
    }
    let step: Step | 'wait' | 'changed';
    try {
      switch (row.state) {
        case 'filing':
          step = await file(db, forges, zone, row, secrets, now);
          break;
        case 'promote_held':
          // The hold starts at the first active flush that sees it, so a pause, kill or restart
          // never lets the promotion through without Command getting one active pass.
          if (row.holdUntil === null) {
            const holdUntil = new Date(now.getTime() + holdMs).toISOString();
            setCrewIssue(db, row.id, { holdUntil }, now);
            continue;
          }
          if (now.getTime() < Date.parse(row.holdUntil)) continue;
          // Held with a Reject option: it goes ahead only while that briefing is still unanswered.
          if (!hasOpenBriefing(db, zone.id, subjectOf(row))) continue;
          setCrewIssue(db, row.id, { state: 'promoting' }, now);
          moved++;
          step = await promote(db, forges, zone, { ...row, state: 'promoting' }, now);
          break;
        case 'promoting':
          step = await promote(db, forges, zone, row, now);
          break;
        case 'revising':
          step = await revise(db, forges, zone, row, secrets, now);
          break;
        case 'rejecting':
          step = await reject(db, forges, zone, row, now);
          break;
        default:
          continue;
      }
    } catch {
      continue; // a forge read failed: tried again next pass
    }
    if (step === 'wait') continue;
    if (step === 'changed') {
      setCrewIssue(db, row.id, { state: 'staged' }, now);
      raiseBriefing(
        db,
        {
          zoneId: zone.id,
          kind: 'promote',
          subject: subjectOf(row),
          decision: `Crew issue #${row.number} was edited on the forge. Re-stage it as it now reads, or reject it?`,
          why: 'The issue body changed on the forge after it was staged, so it is not the text that was proposed. Re-stage takes the edited text and has a refute judge it before any promotion.',
          options: [
            { id: 'restage', label: 'Re-stage', effect: 'restage_issue' },
            { id: 'reject', label: 'Reject', effect: 'reject_issue' },
          ],
          onHold: `Crew issue #${row.number}`,
          source: 'server',
        },
        now,
      );
      moved++;
      continue;
    }
    // A ruling applied while the write was in flight (a Reject during a promotion) wins: the
    // step's outcome is recorded only if the issue is still where this step found it.
    const current = getCrewIssue(db, row.id)?.state;
    const expected = row.state === 'promote_held' ? 'promoting' : row.state;
    if (current !== expected) continue;
    if (step.result.state === 'done') {
      setCrewIssue(db, row.id, step.done, now);
      if (step.done.state === 'promoted' || step.done.state === 'rejected') {
        withdrawBriefing(db, zone.id, subjectOf(row), now);
      }
      moved++;
    } else if (step.result.state === 'failed') {
      setCrewIssue(db, row.id, { state: 'failed' }, now);
      moved++;
    }
  }
  return moved;
}
