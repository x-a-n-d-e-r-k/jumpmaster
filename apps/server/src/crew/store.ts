import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';

/**
 * `source` of a row the in-app intake filed: Command's own issue, filed ready (never staged) by
 * the intake route, and moved on only by it and by `confirmIntakeIssues`, never by the crew flush.
 */
export const INTAKE_SOURCE = 'intake';

export type CrewIssueState =
  | 'filing'
  | 'staged'
  | 'promote_held'
  | 'promoting'
  | 'promoted'
  | 'revising'
  | 'rejecting'
  | 'rejected'
  | 'failed';

export type CrewIssue = {
  id: number;
  zoneId: string;
  /** The crew's output key, unique per zone; the op key adds the zone and objective. */
  key: string;
  source: string;
  sourceRef: string | null;
  objective: string;
  title: string;
  titleNorm: string;
  /** The crew's text; sanitised when an op is built from it. */
  body: string;
  /** sha256 of the sanitised body as last written, without its marker line. */
  bodySha: string | null;
  priority: string | null;
  number: number | null;
  state: CrewIssueState;
  refuteCount: number;
  refutedSha: string | null;
  findingsJson: string | null;
  holdUntil: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewCrewIssue = Pick<
  CrewIssue,
  'zoneId' | 'key' | 'source' | 'objective' | 'title' | 'body' | 'priority' | 'createdAt'
> &
  Partial<Pick<CrewIssue, 'sourceRef' | 'state' | 'number' | 'bodySha'>>;

export type CrewIssuePatch = Partial<
  Pick<
    CrewIssue,
    | 'state'
    | 'number'
    | 'title'
    | 'body'
    | 'bodySha'
    | 'priority'
    | 'refuteCount'
    | 'refutedSha'
    | 'findingsJson'
    | 'holdUntil'
  >
>;

/** Lowercased, punctuation and runs of space folded: how two titles are compared. */
export const normTitle = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const COLS = `id, zone_id AS zoneId, key, source, source_ref AS sourceRef, objective, title,
  title_norm AS titleNorm, body, body_sha AS bodySha, priority, number, state,
  refute_count AS refuteCount, refuted_sha AS refutedSha, findings_json AS findingsJson,
  hold_until AS holdUntil, created_at AS createdAt, updated_at AS updatedAt`;

const COLUMN: Record<keyof CrewIssuePatch, string> = {
  state: 'state',
  number: 'number',
  title: 'title',
  body: 'body',
  bodySha: 'body_sha',
  priority: 'priority',
  refuteCount: 'refute_count',
  refutedSha: 'refuted_sha',
  findingsJson: 'findings_json',
  holdUntil: 'hold_until',
};

export function insertCrewIssue(db: Db, row: NewCrewIssue): number {
  const r = db
    .prepare(
      `INSERT INTO crew_issues (zone_id, key, source, source_ref, objective, title, title_norm, body,
         body_sha, priority, number, state, created_at, updated_at)
       VALUES (@zoneId, @key, @source, @sourceRef, @objective, @title, @titleNorm, @body, @bodySha,
         @priority, @number, @state, @createdAt, @createdAt)`,
    )
    .run({
      sourceRef: null,
      number: null,
      bodySha: null,
      state: 'filing',
      ...row,
      titleNorm: normTitle(row.title),
    });
  return Number(r.lastInsertRowid);
}

export function getCrewIssue(db: Db, id: number): CrewIssue | undefined {
  return db.prepare(`SELECT ${COLS} FROM crew_issues WHERE id = ?`).get(id) as
    | CrewIssue
    | undefined;
}

export function getCrewIssueByNumber(db: Db, zoneId: string, n: number): CrewIssue | undefined {
  return db
    .prepare(`SELECT ${COLS} FROM crew_issues WHERE zone_id = ? AND number = ? ORDER BY id DESC`)
    .get(zoneId, n) as CrewIssue | undefined;
}

export function listCrewIssues(db: Db, zoneId: string, states?: CrewIssueState[]): CrewIssue[] {
  const filter = states?.length ? ` AND state IN (${states.map(() => '?').join(', ')})` : '';
  return db
    .prepare(`SELECT ${COLS} FROM crew_issues WHERE zone_id = ?${filter} ORDER BY id`)
    .all(zoneId, ...(states ?? [])) as CrewIssue[];
}

export function setCrewIssue(db: Db, id: number, patch: CrewIssuePatch, now: Date): void {
  const keys = (Object.keys(patch) as (keyof CrewIssuePatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  const sets = keys.map((k) => `${COLUMN[k]} = @${k}`);
  if (patch.title !== undefined) sets.push('title_norm = @titleNorm');
  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE crew_issues SET ${sets.join(', ')} WHERE id = @id`).run({
    ...patch,
    ...(patch.title !== undefined ? { titleNorm: normTitle(patch.title) } : {}),
    updatedAt: now.toISOString(),
    id,
  });
}

export type TriageState = 'open' | 'waiting' | 'done' | 'failed';
export type TriageOutcome = 'split' | 'questions' | 'not-agent-work';

/** One triage-labeled issue text by a trusted author: what a triage drop works on (#184). */
export type TriageRequest = {
  id: number;
  zoneId: string;
  issueNumber: number;
  title: string;
  body: string;
  bodySha: string;
  author: string;
  state: TriageState;
  outcome: TriageOutcome | null;
  reason: string | null;
  /** Why sync's triage gate held the issue back (#247), or null when it recorded none. */
  gateReasons: string[] | null;
  attempts: number;
  briefingId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TriagePatch = Partial<
  Pick<TriageRequest, 'state' | 'outcome' | 'reason' | 'attempts' | 'briefingId'>
>;

const TRIAGE_COLS = `id, zone_id AS zoneId, issue_number AS issueNumber, title, body,
  body_sha AS bodySha, author, state, outcome, reason, gate_reasons AS gateReasons, attempts,
  briefing_id AS briefingId, created_at AS createdAt, updated_at AS updatedAt`;

type TriageRow = Omit<TriageRequest, 'gateReasons'> & { gateReasons: string | null };

const triageOf = (r: TriageRow): TriageRequest => ({
  ...r,
  gateReasons: r.gateReasons === null ? null : (JSON.parse(r.gateReasons) as string[]),
});

const TRIAGE_COLUMN: Record<keyof TriagePatch, string> = {
  state: 'state',
  outcome: 'outcome',
  reason: 'reason',
  attempts: 'attempts',
  briefingId: 'briefing_id',
};

export const triageBodySha = (body: string): string =>
  createHash('sha256').update(body).digest('hex');

/**
 * Records a request for an issue's current text, once per body (`UNIQUE(zone, number, sha)`):
 * the same body again records nothing. A new body supersedes the issue's request still open (or
 * waiting on Command). Returns the new request's id, or null when nothing was recorded.
 */
export function recordTriageRequest(
  db: Db,
  zoneId: string,
  issue: { number: number; title: string; body: string; author: string },
  now: Date,
  gateReasons: readonly string[] = [],
): number | null {
  const sha = triageBodySha(issue.body);
  const at = now.toISOString();
  return db.transaction(() => {
    const seen = db
      .prepare(
        'SELECT 1 FROM triage_requests WHERE zone_id = ? AND issue_number = ? AND body_sha = ?',
      )
      .get(zoneId, issue.number, sha);
    if (seen) return null;
    db.prepare(
      `UPDATE triage_requests SET state = 'done', reason = 'superseded', updated_at = ?
         WHERE zone_id = ? AND issue_number = ? AND state IN ('open', 'waiting')`,
    ).run(at, zoneId, issue.number);
    const r = db
      .prepare(
        `INSERT INTO triage_requests (zone_id, issue_number, title, body, body_sha, author, state,
           gate_reasons, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(
        zoneId,
        issue.number,
        issue.title,
        issue.body,
        sha,
        issue.author,
        gateReasons.length > 0 ? JSON.stringify(gateReasons) : null,
        at,
        at,
      );
    return Number(r.lastInsertRowid);
  })();
}

export function getTriageRequest(db: Db, id: number): TriageRequest | undefined {
  const row = db.prepare(`SELECT ${TRIAGE_COLS} FROM triage_requests WHERE id = ?`).get(id) as
    | TriageRow
    | undefined;
  return row && triageOf(row);
}

export function listTriageRequests(db: Db, zoneId: string): TriageRequest[] {
  return (
    db
      .prepare(`SELECT ${TRIAGE_COLS} FROM triage_requests WHERE zone_id = ? ORDER BY id`)
      .all(zoneId) as TriageRow[]
  ).map(triageOf);
}

export function setTriageRequest(db: Db, id: number, patch: TriagePatch, now: Date): void {
  const keys = (Object.keys(patch) as (keyof TriagePatch)[]).filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${TRIAGE_COLUMN[k]} = @${k}`), 'updated_at = @updatedAt'];
  db.prepare(`UPDATE triage_requests SET ${sets.join(', ')} WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, patch[k]])),
    updatedAt: now.toISOString(),
    id,
  });
}

export type ArbitrationState = 'pending' | 'ruled' | 'failed' | 'discarded';
export type ArbitrationRuling = 'A' | 'B' | 'insufficient_evidence';

/**
 * One arbiter ruling on a contested decision: `subject` names what was contested
 * (`issue:<crewIssueId>`, or `item:<workItemId>` for a review disagreement), `basis` the exact text
 * judged (the crew issue's `body_sha`, or `review` for an item: once per item ever). One per
 * subject and basis (`UNIQUE`), inserted in the arbitrate drop's own transaction.
 */
export type Arbitration = {
  id: number;
  zoneId: string;
  subject: string;
  basis: string;
  dropId: string;
  state: ArbitrationState;
  ruling: ArbitrationRuling | null;
  acted: boolean;
  because: string | null;
  instruction: string | null;
  /** Why it failed, was discarded or did not act. */
  reason: string | null;
  /** When an acting item ruling was applied (Command's Retry on the item); null until then. */
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArbitrationSettle = {
  state: Exclude<ArbitrationState, 'pending'>;
  ruling?: ArbitrationRuling;
  acted?: boolean;
  because?: string;
  instruction?: string;
  reason?: string;
};

const ARB_COLS = `id, zone_id AS zoneId, subject, basis, drop_id AS dropId, state, ruling, acted, because,
  instruction, reason, applied_at AS appliedAt, created_at AS createdAt, updated_at AS updatedAt`;

type ArbitrationRow = Omit<Arbitration, 'acted'> & { acted: number };
const arbitrationOf = (r: ArbitrationRow): Arbitration => ({ ...r, acted: r.acted === 1 });

/** The subject of a crew issue's arbitration (and of its briefings). */
export const issueArbitrationSubject = (crewIssueId: number): string => `issue:${crewIssueId}`;

/** The subject of a work item's arbitration: the same as its parked briefing's. */
export const itemArbitrationSubject = (itemId: number): string => `item:${itemId}`;

/**
 * The basis of a work item's arbitration: a review disagreement. One per item ever, so a second
 * disagreement on the same item goes to diagnose and Command.
 */
export const ITEM_ARBITRATION_BASIS = 'review';

/** The work item's review arbitration, if it ever had one. */
export const getItemArbitration = (db: Db, itemId: number): Arbitration | undefined =>
  getArbitration(db, itemArbitrationSubject(itemId), ITEM_ARBITRATION_BASIS);

/** The item's arbitration if it acted and was applied: its ruling goes to the next rounds. */
export function appliedItemArbitration(db: Db, itemId: number): Arbitration | undefined {
  const row = getItemArbitration(db, itemId);
  return row && row.state === 'ruled' && row.acted && row.appliedAt !== null ? row : undefined;
}

/** The zone's item arbitrations that ruled to act and are not yet applied, oldest first. */
export function unappliedItemArbitrations(db: Db, zoneId: string): Arbitration[] {
  const rows = db
    .prepare(
      `SELECT ${ARB_COLS} FROM arbitrations WHERE zone_id = ? AND subject LIKE 'item:%'
         AND basis = ? AND state = 'ruled' AND acted = 1 AND applied_at IS NULL ORDER BY id`,
    )
    .all(zoneId, ITEM_ARBITRATION_BASIS) as ArbitrationRow[];
  return rows.map(arbitrationOf);
}

/**
 * Claims an acting ruling for applying: sets `applied_at` only where it is unset, so of two passes
 * one applies it. Returns false, changing nothing, when it was claimed already.
 */
export function claimArbitrationApply(db: Db, id: number, now: Date): boolean {
  const r = db
    .prepare('UPDATE arbitrations SET applied_at = ? WHERE id = ? AND applied_at IS NULL')
    .run(now.toISOString(), id);
  return r.changes > 0;
}

/** Undoes `claimArbitrationApply` when the apply could not run yet: the next pass tries again. */
export function releaseArbitrationApply(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE arbitrations SET applied_at = NULL WHERE id = ? AND applied_at = ?').run(
    id,
    now.toISOString(),
  );
}

/** Records a pending arbitration; throws a UNIQUE violation if (subject, basis) has one already. */
export function insertArbitration(
  db: Db,
  row: { zoneId: string; subject: string; basis: string; dropId: string },
  now: Date,
): number {
  const at = now.toISOString();
  const r = db
    .prepare(
      `INSERT INTO arbitrations (zone_id, subject, basis, drop_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(row.zoneId, row.subject, row.basis, row.dropId, at, at);
  return Number(r.lastInsertRowid);
}

export function getArbitration(db: Db, subject: string, basis: string): Arbitration | undefined {
  const row = db
    .prepare(`SELECT ${ARB_COLS} FROM arbitrations WHERE subject = ? AND basis = ?`)
    .get(subject, basis) as ArbitrationRow | undefined;
  return row && arbitrationOf(row);
}

export function getArbitrationByDrop(db: Db, dropId: string): Arbitration | undefined {
  const row = db.prepare(`SELECT ${ARB_COLS} FROM arbitrations WHERE drop_id = ?`).get(dropId) as
    | ArbitrationRow
    | undefined;
  return row && arbitrationOf(row);
}

/**
 * Settles a pending arbitration. Only from `pending`: returns false, changing nothing, when it was
 * settled already, so a re-delivered result acts once.
 */
export function settleArbitration(db: Db, id: number, s: ArbitrationSettle, now: Date): boolean {
  const r = db
    .prepare(
      `UPDATE arbitrations SET state = @state, ruling = @ruling, acted = @acted, because = @because,
         instruction = @instruction, reason = @reason, updated_at = @at
       WHERE id = @id AND state = 'pending'`,
    )
    .run({
      id,
      state: s.state,
      ruling: s.ruling ?? null,
      acted: s.acted ? 1 : 0,
      because: s.because ?? null,
      instruction: s.instruction ?? null,
      reason: s.reason ?? null,
      at: now.toISOString(),
    });
  return r.changes > 0;
}

/** What became of a crew retry once a pass applied it. */
export type CrewRetryOutcome = 'retried' | 'skipped';

/**
 * The crew's one action on a parked item (#396, #420): a `retry` on its own diagnosis, or a
 * `rerun` of failed checks it judged flaky, then a retry.
 */
export type CrewActionKind = 'retry' | 'rerun';

/**
 * The crew's one action on a parked work item on its own diagnosis (#396, #420): recorded with the
 * diagnose result, applied by the next active pass.
 */
export type CrewRetry = {
  id: number;
  zoneId: string;
  itemId: number;
  briefingId: number;
  /** The diagnose drop whose result asked for it. */
  dropId: string;
  kind: CrewActionKind;
  diagnosis: string;
  /** A retry's instruction for the next attempt; empty for a rerun. */
  instruction: string;
  /** A rerun's check names. */
  checks: string[];
  createdAt: string;
  appliedAt: string | null;
  /** When the forge re-ran a rerun's checks. */
  rerunAt: string | null;
  outcome: CrewRetryOutcome | null;
  /** Why a skipped action did nothing, in plain words. */
  reason: string | null;
};

export type NewCrewRetry = Pick<
  CrewRetry,
  'zoneId' | 'itemId' | 'briefingId' | 'dropId' | 'diagnosis' | 'instruction'
> & { createdAt: Date; kind?: CrewActionKind; checks?: string[] };

const RETRY_COLS = `id, zone_id AS zoneId, item_id AS itemId, briefing_id AS briefingId,
  drop_id AS dropId, kind, diagnosis, instruction, checks, created_at AS createdAt,
  applied_at AS appliedAt, rerun_at AS rerunAt, outcome, reason`;

type CrewRetryRow = Omit<CrewRetry, 'checks'> & { checks: string | null };

const fromRow = (r: CrewRetryRow): CrewRetry => {
  let checks: string[] = [];
  try {
    const parsed = JSON.parse(r.checks ?? '[]') as unknown;
    if (Array.isArray(parsed)) checks = parsed.filter((c): c is string => typeof c === 'string');
  } catch {
    checks = [];
  }
  return { ...r, checks };
};

/**
 * Records a crew action; throws a UNIQUE violation if the item has one already: one crew action
 * (retry or rerun) per work item, ever, by the schema.
 */
export function insertCrewRetry(db: Db, r: NewCrewRetry): number {
  const res = db
    .prepare(
      `INSERT INTO crew_retries (zone_id, item_id, briefing_id, drop_id, kind, diagnosis,
         instruction, checks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.zoneId,
      r.itemId,
      r.briefingId,
      r.dropId,
      r.kind ?? 'retry',
      r.diagnosis,
      r.instruction,
      r.checks ? JSON.stringify(r.checks) : null,
      r.createdAt.toISOString(),
    );
  return Number(res.lastInsertRowid);
}

/** The work item's crew action, if it ever had one. */
export function getCrewRetry(db: Db, itemId: number): CrewRetry | undefined {
  const r = db.prepare(`SELECT ${RETRY_COLS} FROM crew_retries WHERE item_id = ?`).get(itemId) as
    | CrewRetryRow
    | undefined;
  return r && fromRow(r);
}

/** The zone's crew actions not yet applied, oldest first. */
export function listUnappliedCrewRetries(db: Db, zoneId: string): CrewRetry[] {
  return (
    db
      .prepare(
        `SELECT ${RETRY_COLS} FROM crew_retries WHERE zone_id = ? AND applied_at IS NULL
         ORDER BY id`,
      )
      .all(zoneId) as CrewRetryRow[]
  ).map(fromRow);
}

/** Claims a crew retry for one pass to apply: false when another pass has it already. */
export function claimCrewRetryApply(db: Db, id: number, now: Date): boolean {
  return (
    db
      .prepare('UPDATE crew_retries SET applied_at = ? WHERE id = ? AND applied_at IS NULL')
      .run(now.toISOString(), id).changes === 1
  );
}

/** Undoes `claimCrewRetryApply` when the retry could not run yet: the next pass tries again. */
export function releaseCrewRetryApply(db: Db, id: number, now: Date): void {
  db.prepare(
    'UPDATE crew_retries SET applied_at = NULL WHERE id = ? AND applied_at = ? AND outcome IS NULL',
  ).run(id, now.toISOString());
}

/** Records that the forge re-ran a rerun's checks: a later pass only retries the item. */
export function markCrewRerun(db: Db, id: number, now: Date): void {
  db.prepare('UPDATE crew_retries SET rerun_at = ? WHERE id = ?').run(now.toISOString(), id);
}

/** Records what became of a claimed crew action, and why a skipped one did nothing. */
export function settleCrewRetry(
  db: Db,
  id: number,
  outcome: CrewRetryOutcome,
  reason?: string,
): void {
  db.prepare('UPDATE crew_retries SET outcome = ?, reason = ? WHERE id = ?').run(
    outcome,
    reason ?? null,
    id,
  );
}
