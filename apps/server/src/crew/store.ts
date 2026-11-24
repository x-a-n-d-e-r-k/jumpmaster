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
  /** The key of the rejected crew issue this one replaces (#784), or null. */
  replaces: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewCrewIssue = Pick<
  CrewIssue,
  'zoneId' | 'key' | 'source' | 'objective' | 'title' | 'body' | 'priority' | 'createdAt'
> &
  Partial<Pick<CrewIssue, 'sourceRef' | 'state' | 'number' | 'bodySha' | 'replaces'>>;

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
  hold_until AS holdUntil, replaces, created_at AS createdAt, updated_at AS updatedAt`;

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
         body_sha, priority, number, state, replaces, created_at, updated_at)
       VALUES (@zoneId, @key, @source, @sourceRef, @objective, @title, @titleNorm, @body, @bodySha,
         @priority, @number, @state, @replaces, @createdAt, @createdAt)`,
    )
    .run({
      sourceRef: null,
      number: null,
      bodySha: null,
      replaces: null,
      state: 'filing',
      ...row,
      titleNorm: normTitle(row.title),
    });
  return Number(r.lastInsertRowid);
}

export function getCrewIssueByKey(db: Db, zoneId: string, key: string): CrewIssue | undefined {
  return db
    .prepare(`SELECT ${COLS} FROM crew_issues WHERE zone_id = ? AND key = ?`)
    .get(zoneId, key) as CrewIssue | undefined;
}

/**
 * Command's latest ruling to reject the crew issue (a chosen option whose effect is
 * `reject_issue`, on the issue's briefing), with its note; `applied` says whether it was applied.
 * Undefined when Command never ruled to reject it.
 */
export function commandRejection(
  db: Db,
  issue: Pick<CrewIssue, 'id' | 'zoneId'>,
): { note: string; applied: boolean } | undefined {
  const row = db
    .prepare(
      `SELECT r.note, r.applied_at AS appliedAt
         FROM rulings r JOIN briefings b ON b.id = r.briefing_id, json_each(b.options_json) o
       WHERE b.zone_id = ? AND b.subject = ?
         AND json_extract(o.value, '$.id') = r.choice
         AND json_extract(o.value, '$.effect') = 'reject_issue'
       ORDER BY (r.applied_at IS NOT NULL) DESC, r.id DESC LIMIT 1`,
    )
    .get(issue.zoneId, `issue:${issue.id}`) as
    | { note: string | null; appliedAt: string | null }
    | undefined;
  return row && { note: row.note ?? '', applied: row.appliedAt !== null };
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

export type TriageState = 'open' | 'waiting' | 'verifying' | 'done' | 'failed';
export type TriageOutcome = 'split' | 'questions' | 'not-agent-work' | 'already-done';
/** What an `already-done` verdict cites as having done the work (#466). */
export type TriageEvidence = { pulls?: number[]; issues?: number[] };

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
  /** An `already-done` verdict's citations, while and after the server verifies them. */
  evidence: TriageEvidence | null;
  /** Why the server refused the last attempt's verdict (numbers only), for the retry's input. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TriagePatch = Partial<
  Pick<
    TriageRequest,
    'state' | 'outcome' | 'reason' | 'attempts' | 'briefingId' | 'evidence' | 'lastError'
  >
>;

const TRIAGE_COLS = `id, zone_id AS zoneId, issue_number AS issueNumber, title, body,
  body_sha AS bodySha, author, state, outcome, reason, gate_reasons AS gateReasons, attempts,
  briefing_id AS briefingId, evidence_json AS evidence, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;

type TriageRow = Omit<TriageRequest, 'gateReasons' | 'evidence'> & {
  gateReasons: string | null;
  evidence: string | null;
};

const triageOf = (r: TriageRow): TriageRequest => ({
  ...r,
  gateReasons: r.gateReasons === null ? null : (JSON.parse(r.gateReasons) as string[]),
  evidence: r.evidence === null ? null : (JSON.parse(r.evidence) as TriageEvidence),
});

const TRIAGE_COLUMN: Record<keyof TriagePatch, string> = {
  state: 'state',
  outcome: 'outcome',
  reason: 'reason',
  attempts: 'attempts',
  briefingId: 'briefing_id',
  evidence: 'evidence_json',
  lastError: 'last_error',
};

export const triageBodySha = (body: string): string =>
  createHash('sha256').update(body).digest('hex');

/**
 * The reason sync gives an untouched open request whose issue left both triage listings. Only a
 * row with this reason, no outcome and no attempts was never triaged, so only it is reopened.
 */
export const TRIAGE_WITHDRAWN = 'withdrawn';

/**
 * Records a request for an issue's current text, once per body (`UNIQUE(zone, number, sha)`):
 * the same body again records nothing, unless its request was withdrawn untouched, which is
 * reopened. A new body supersedes the issue's request still open, waiting on Command or having
 * its evidence verified. Returns the new or reopened request's id, or null when nothing was recorded.
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
        `SELECT id, state, outcome, reason, attempts FROM triage_requests
           WHERE zone_id = ? AND issue_number = ? AND body_sha = ?`,
      )
      .get(zoneId, issue.number, sha) as
      | Pick<TriageRequest, 'id' | 'state' | 'outcome' | 'reason' | 'attempts'>
      | undefined;
    const withdrawn =
      seen?.state === 'done' &&
      seen.reason === TRIAGE_WITHDRAWN &&
      seen.outcome === null &&
      seen.attempts === 0;
    if (seen && !withdrawn) return null;
    db.prepare(
      // A verdict still being verified loses its outcome: a superseded request leaves no trail.
      `UPDATE triage_requests SET state = 'done', reason = 'superseded', updated_at = ?,
         outcome = CASE WHEN state = 'verifying' THEN NULL ELSE outcome END
         WHERE zone_id = ? AND issue_number = ? AND state IN ('open', 'waiting', 'verifying')`,
    ).run(at, zoneId, issue.number);
    if (seen) {
      // The same text, never triaged: the withdrawn row is sent again with the issue's current facts.
      db.prepare(
        `UPDATE triage_requests SET state = 'open', reason = NULL, title = ?, author = ?,
           gate_reasons = ?, updated_at = ? WHERE id = ?`,
      ).run(
        issue.title,
        issue.author,
        gateReasons.length > 0 ? JSON.stringify(gateReasons) : null,
        at,
        seen.id,
      );
      return seen.id;
    }
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
    ...Object.fromEntries(
      keys.map((k) => [k, k === 'evidence' && patch[k] ? JSON.stringify(patch[k]) : patch[k]]),
    ),
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

/** A zone's audit cursor: the last merged commit audited (or the head when audits started). */
export type AuditCursor = {
  zoneId: string;
  auditedSha: string;
  /** Commits known to wait after `auditedSha` when it was set; 0 when none were. */
  pending: number;
  checkedAt: string;
  updatedAt: string;
};

export function getAuditCursor(db: Db, zoneId: string): AuditCursor | undefined {
  return db
    .prepare(
      `SELECT zone_id AS zoneId, audited_sha AS auditedSha, pending, checked_at AS checkedAt,
         updated_at AS updatedAt FROM crew_audit_cursor WHERE zone_id = ?`,
    )
    .get(zoneId) as AuditCursor | undefined;
}

/** Stores a zone's first cursor; a cursor stored meanwhile by another pass is kept. */
export function insertAuditCursor(db: Db, zoneId: string, sha: string, now: Date): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO crew_audit_cursor (zone_id, audited_sha, pending, checked_at, updated_at)
     VALUES (?, ?, 0, ?, ?) ON CONFLICT (zone_id) DO NOTHING`,
  ).run(zoneId, sha, at, at);
}

/**
 * Moves the cursor from `from` (the SHA this pass read) to `to`. Returns false, changing nothing,
 * when another pass moved it first.
 */
export function moveAuditCursor(
  db: Db,
  zoneId: string,
  from: string,
  to: string,
  pending: number,
  now: Date,
): boolean {
  const at = now.toISOString();
  const r = db
    .prepare(
      `UPDATE crew_audit_cursor SET audited_sha = ?, pending = ?, checked_at = ?, updated_at = ?
       WHERE zone_id = ? AND audited_sha = ?`,
    )
    .run(to, pending, at, at, zoneId, from);
  return r.changes > 0;
}

export type AuditState = 'running' | 'holds' | 'filed' | 'refused' | 'failed';

/** One audit of one merged commit, by its drop. One per zone and commit (`UNIQUE`). */
export type CrewAudit = {
  id: number;
  zoneId: string;
  sha: string;
  dropId: string;
  state: AuditState;
  crewIssueId: number | null;
  /** Why it was refused or failed. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

const AUDIT_COLS = `id, zone_id AS zoneId, sha, drop_id AS dropId, state, crew_issue_id AS crewIssueId,
  reason, created_at AS createdAt, updated_at AS updatedAt`;

/** Records a running audit; throws a UNIQUE violation if the zone audited this commit already. */
export function insertAudit(
  db: Db,
  row: { zoneId: string; sha: string; dropId: string },
  now: Date,
): number {
  const at = now.toISOString();
  const r = db
    .prepare(
      `INSERT INTO crew_audits (zone_id, sha, drop_id, state, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    )
    .run(row.zoneId, row.sha, row.dropId, at, at);
  return Number(r.lastInsertRowid);
}

export function getAuditByDrop(db: Db, dropId: string): CrewAudit | undefined {
  return db.prepare(`SELECT ${AUDIT_COLS} FROM crew_audits WHERE drop_id = ?`).get(dropId) as
    | CrewAudit
    | undefined;
}

export function listAudits(db: Db, zoneId: string): CrewAudit[] {
  return db
    .prepare(`SELECT ${AUDIT_COLS} FROM crew_audits WHERE zone_id = ? ORDER BY id`)
    .all(zoneId) as CrewAudit[];
}

/**
 * Settles a running audit. Only from `running`: returns false, changing nothing, when it was
 * settled already, so a re-delivered result acts once.
 */
export function settleAudit(
  db: Db,
  id: number,
  s: { state: Exclude<AuditState, 'running'>; crewIssueId?: number; reason?: string },
  now: Date,
): boolean {
  const r = db
    .prepare(
      `UPDATE crew_audits SET state = ?, crew_issue_id = ?, reason = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
    )
    .run(s.state, s.crewIssueId ?? null, s.reason ?? null, now.toISOString(), id);
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

/** Where a diagnose drop's `already_done` claim on a parked item stands (#536). */
export type DoneClaimState = 'verifying' | 'done' | 'refused' | 'superseded';

/** What a claim cites as having done the work: merged pulls and issues closed as completed. */
export type DoneEvidence = { pulls?: number[]; issues?: number[] };

/**
 * A diagnose drop's claim that a parked item is already done (#536). Recorded `verifying` with
 * the diagnose result; the trail pass verifies its evidence on the forge before anything is written.
 */
export type DoneClaim = {
  id: number;
  zoneId: string;
  itemId: number;
  briefingId: number;
  dropId: string;
  /** The parked briefing's why basis the diagnosis was made on. */
  basis: string;
  diagnosis: string;
  evidence: DoneEvidence;
  state: DoneClaimState;
  /** Why a claim was refused or superseded, in numbers and plain words only. */
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewDoneClaim = Pick<
  DoneClaim,
  'zoneId' | 'itemId' | 'briefingId' | 'dropId' | 'basis' | 'diagnosis' | 'evidence'
>;

const CLAIM_COLS = `id, zone_id AS zoneId, item_id AS itemId, briefing_id AS briefingId,
  drop_id AS dropId, basis, diagnosis, evidence_json AS evidenceJson, state, reason,
  created_at AS createdAt, updated_at AS updatedAt`;

type DoneClaimRow = Omit<DoneClaim, 'evidence'> & { evidenceJson: string };

const positiveInts = (v: unknown): number[] | undefined =>
  Array.isArray(v)
    ? v.filter((n): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)
    : undefined;

const claimOfRow = ({ evidenceJson, ...r }: DoneClaimRow): DoneClaim => {
  let parsed: { pulls?: unknown; issues?: unknown } = {};
  try {
    parsed = (JSON.parse(evidenceJson) ?? {}) as typeof parsed;
  } catch {
    parsed = {};
  }
  const pulls = positiveInts(parsed.pulls);
  const issues = positiveInts(parsed.issues);
  return { ...r, evidence: { ...(pulls ? { pulls } : {}), ...(issues ? { issues } : {}) } };
};

/**
 * Records a `verifying` claim; throws a UNIQUE violation when the item has one verifying already,
 * or the drop has one at all (D3).
 */
export function insertDoneClaim(db: Db, c: NewDoneClaim, now: Date): number {
  const at = now.toISOString();
  const res = db
    .prepare(
      `INSERT INTO crew_done_claims (zone_id, item_id, briefing_id, drop_id, basis, diagnosis,
         evidence_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'verifying', ?, ?)`,
    )
    .run(
      c.zoneId,
      c.itemId,
      c.briefingId,
      c.dropId,
      c.basis,
      c.diagnosis,
      JSON.stringify(c.evidence),
      at,
      at,
    );
  return Number(res.lastInsertRowid);
}

export function getDoneClaim(db: Db, id: number): DoneClaim | undefined {
  const r = db.prepare(`SELECT ${CLAIM_COLS} FROM crew_done_claims WHERE id = ?`).get(id) as
    | DoneClaimRow
    | undefined;
  return r && claimOfRow(r);
}

/** The item's claims, oldest first. */
export function listItemDoneClaims(db: Db, itemId: number): DoneClaim[] {
  return (
    db
      .prepare(`SELECT ${CLAIM_COLS} FROM crew_done_claims WHERE item_id = ? ORDER BY id`)
      .all(itemId) as DoneClaimRow[]
  ).map(claimOfRow);
}

/** The zone's claims still `verifying`, oldest first. */
export function listVerifyingDoneClaims(db: Db, zoneId: string): DoneClaim[] {
  return (
    db
      .prepare(
        `SELECT ${CLAIM_COLS} FROM crew_done_claims WHERE zone_id = ? AND state = 'verifying'
         ORDER BY id`,
      )
      .all(zoneId) as DoneClaimRow[]
  ).map(claimOfRow);
}

/** Whether the item has a claim still `verifying`: no new diagnosis is asked for meanwhile. */
export function hasVerifyingDoneClaim(db: Db, itemId: number): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM crew_done_claims WHERE item_id = ? AND state = 'verifying'`)
      .get(itemId) !== undefined
  );
}

/** Settles a `verifying` claim; false when it was settled already. */
export function settleDoneClaim(
  db: Db,
  id: number,
  state: Exclude<DoneClaimState, 'verifying'>,
  reason: string | null,
  now: Date,
): boolean {
  return (
    db
      .prepare(
        `UPDATE crew_done_claims SET state = ?, reason = ?, updated_at = ?
           WHERE id = ? AND state = 'verifying'`,
      )
      .run(state, reason, now.toISOString(), id).changes === 1
  );
}
