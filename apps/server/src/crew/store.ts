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
