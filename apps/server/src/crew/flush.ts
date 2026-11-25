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
  runOpIf,
  type SetLabelsPayload,
  sanitizeCrewText,
  type UpdateIssuePayload,
} from '../outbox.js';
import {
  type CrewIssue,
  type CrewIssuePatch,
  type CrewIssueState,
  commandRejection,
  getCrewIssue,
  INTAKE_SOURCE,
  listCrewIssues,
  parseAfter,
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

/** The waiting reason of a promotion held for an in-flight issue it does not name (#843). */
export const OBJECTIVE_IN_FLIGHT = 'waiting: another issue of the objective is in flight';

/** The waiting reason of a promotion held until a crew issue it names in `after` merges. */
export const waitsFor = (key: string, number: number | null): string =>
  `waiting: after ${key}${number === null ? '' : ` (#${number})`}, not merged yet`;

/** Whether a crew issue's work is merged: its work item is done as merged. Nothing else counts. */
const MERGED_SQL = `EXISTS (SELECT 1 FROM work_items w
  WHERE w.drop_zone_id = c.zone_id AND w.issue_number = c.number
    AND w.state = 'done' AND w.reason = 'merged')`;

/**
 * The other crew issues of `row`'s objective in flight, each holding one of its slots: promoted
 * and not merged, or promoting with its label swap already recorded in the outbox (the claim
 * `promote` takes in the transaction that checks the limit, so two passes never both take one).
 */
function inFlight(db: Db, row: CrewIssue): { after: string[] | null }[] {
  const rows = db
    .prepare(
      `SELECT c.after_json AS afterJson FROM crew_issues c
         WHERE c.zone_id = ? AND c.objective = ? AND c.id <> ?
           AND (c.state = 'promoted' OR (c.state = 'promoting' AND EXISTS (
             SELECT 1 FROM outbox o WHERE o.op_key = 'labels:' || c.id || ':promote'
               AND o.state <> 'failed')))
           AND NOT ${MERGED_SQL}`,
    )
    .all(row.zoneId, row.objective, row.id) as { afterJson: string | null }[];
  return rows.map((r) => ({ after: parseAfter(r.afterJson) }));
}

/**
 * Why `row`'s promotion waits (#843), or null when it may go now. Without `after` it waits while
 * any other issue of its objective is in flight, so its issues land one at a time as before. With
 * `after` it waits until every issue it names has merged (a rejected, failed or closed one never
 * has), while its objective has `maxConcurrentImplement` issues in flight, and while an in-flight
 * issue has no `after`, which still lands alone.
 */
export function promotionWait(
  db: Db,
  zone: Pick<DropZoneConfig, 'maxConcurrentImplement'>,
  row: CrewIssue,
): string | null {
  const flying = inFlight(db, row);
  if (row.after === null) return flying.length > 0 ? OBJECTIVE_IN_FLIGHT : null;
  const merged = db.prepare(
    `SELECT c.number, ${MERGED_SQL} AS merged FROM crew_issues c WHERE c.zone_id = ? AND c.key = ?`,
  );
  for (const key of row.after) {
    const dep = merged.get(row.zoneId, key) as
      | { number: number | null; merged: number }
      | undefined;
    if (dep?.merged !== 1) return waitsFor(key, dep?.number ?? null);
  }
  if (flying.length >= (zone.maxConcurrentImplement ?? 1)) return OBJECTIVE_IN_FLIGHT;
  if (flying.some((f) => f.after === null)) return OBJECTIVE_IN_FLIGHT;
  return null;
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
): Promise<Step | 'wait' | 'changed' | 'closed'> {
  if (row.number === null) return 'wait';
  // A label swap already recorded has its slot: it goes on without the check.
  const claimed = getOutbox(db, opKeys.promote(row.id)) !== undefined;
  if (!claimed && promotionWait(db, zone, row) !== null) return 'wait';
  const live = await forges.author.getIssue(row.number);
  if (!live) return 'wait';
  // Closed on the forge since Command ruled: a label swap would "promote" an issue no sync lists.
  if (live.state === 'closed') return 'closed';
  // A body edited on the forge since it was staged is not what Command approved.
  if (row.bodySha === null || crewBodySha(liveCrewBody(live.body)) !== row.bodySha) {
    return 'changed';
  }
  const payload: SetLabelsPayload = {
    number: row.number,
    add: [zone.readyLabel],
    remove: [zone.crew.stagedLabel],
  };
  // The limit is checked again in the transaction that records the write (D3): another pass may
  // have taken the last slot while this one read the forge.
  const result = await runOpIf(
    db,
    forges,
    { kind: 'set_labels', opKey: opKeys.promote(row.id), zoneId: zone.id, itemId: null, payload },
    now,
    () => promotionWait(db, zone, row) === null,
  );
  if (result === null) return 'wait';
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
const rejectedByCommand = (db: Db, row: CrewIssue): boolean =>
  commandRejection(db, row)?.applied === true;

/**
 * Moves crew issues along by their forge writes, all through the outbox as the author identity.
 * Only in an active zone with the kill switch off; returns how many issues changed state. With the
 * zone's crew disabled nothing is promoted (a refute hold neither starts nor ends), revised or
 * closed by the crew, and crew drops' filings wait until it is enabled again. Two writes go ahead:
 * an assistant's (MCP) filing, which lands staged and starts nothing without a Promote ruling, and
 * the close of an issue Command rejected by ruling (its brake); a `rejecting` row from a refute
 * verdict waits like the rest.
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
    // An assistant's (MCP) proposal is filed staged with the crew off: it starts nothing until
    // Command promotes it, and promotion still waits for the crew.
    // Its server-briefed promotion goes ahead too, once Command has ruled Promote.
    const mcpOwn = row.source === 'mcp' && (row.state === 'filing' || row.state === 'promoting');
    if (!crewOn && !mcpOwn) {
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
    let step: Step | 'wait' | 'changed' | 'closed';
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
          // The veto window has passed: the notice closes with it, even if the promotion now
          // waits on an earlier issue of the objective (#449).
          db.transaction(() => {
            setCrewIssue(db, row.id, { state: 'promoting' }, now);
            withdrawBriefing(db, zone.id, subjectOf(row), now);
          })();
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
    if (step === 'closed') {
      // Left unpromoted, and Command is told why; a fresh ruling decides (reopen, or reject).
      setCrewIssue(db, row.id, { state: 'staged' }, now);
      raiseBriefing(
        db,
        {
          zoneId: zone.id,
          kind: 'promote',
          subject: subjectOf(row),
          decision: `Crew issue #${row.number} was closed on GitHub, so it was not promoted. Reopen it and promote it, or reject it?`,
          why: 'The issue was closed on the forge after it was staged. Promoting a closed issue would start nothing: reopen it on GitHub first if the work is still wanted.',
          options: PROMOTE_OPTIONS,
          onHold: `Crew issue #${row.number}`,
          source: 'server',
          ...(row.bodySha ? { sourceRef: row.bodySha } : {}),
        },
        now,
      );
      moved++;
      continue;
    }
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
  if (!crewOn) briefStagedMcpIssues(db, zone, now);
  return moved;
}

/**
 * With the crew off no refute drop judges a staged issue, so nothing would put it to Command: the
 * server raises the Promote briefing for an assistant's (MCP) staged issue itself, with the
 * refute path's options. Once per issue: an issue that has ever had a briefing is skipped, so a
 * re-flush or a restart raises no second one. With the crew on the refute owns promotion.
 */
function briefStagedMcpIssues(db: Db, zone: DropZoneConfig, now: Date): void {
  // Once per staged body: skipped while any briefing on the issue is open, or once one was raised
  // for this body. A Re-stage (a new body) earns a fresh Promote briefing.
  const briefed = db.prepare(
    `SELECT 1 FROM briefings WHERE zone_id = ? AND subject = ?
       AND (state = 'open' OR source_ref = ?) LIMIT 1`,
  );
  for (const row of listCrewIssues(db, zone.id, ['staged'])) {
    if (row.source !== 'mcp' || row.number === null || row.bodySha === null) continue;
    if (briefed.get(zone.id, subjectOf(row), row.bodySha)) continue;
    const label = `issue #${row.number}`;
    raiseBriefing(
      db,
      {
        zoneId: zone.id,
        kind: 'promote',
        subject: subjectOf(row),
        decision: `Promote ${label}?`,
        why: 'Proposed by the assistant (MCP) and filed staged. The crew is off, so no refute judged it: read the issue, then promote it to let an agent start, or reject it.',
        options: PROMOTE_OPTIONS,
        onHold: label,
        source: 'server',
        sourceRef: row.bodySha,
      },
      now,
    );
  }
}
