import type { TrooperEvent } from '@jumpmaster/protocol';
import type { Db } from './open.js';

export type WorkItemState = 'ready' | 'in_flight' | 'pr_open' | 'parked' | 'done';
export type DropState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'lost'
  | 'cancelled';

export interface DropZoneRow {
  id: string;
  repo: string;
  defaultBranch: string;
  configJson: string;
}

export interface WorkItem {
  id: number;
  dropZoneId: string;
  issueNumber: number;
  title: string;
  body: string;
  author: string;
  priority: number;
  isFix: boolean;
  issueCreatedAt: string;
  state: WorkItemState;
  reason: string | null;
  prNumber: number | null;
  retryLabelSeen: boolean;
  waitingSince: string | null;
}

export type NewWorkItem = Omit<
  WorkItem,
  'id' | 'state' | 'reason' | 'prNumber' | 'retryLabelSeen' | 'waitingSince'
>;

export interface Drop {
  id: string;
  dropZoneId: string;
  workItemId: number;
  role: string;
  state: DropState;
  stickId: string | null;
  epoch: number;
  leaseExpiresAt: string | null;
  promptVersion: string | null;
  image: string | null;
  resultJson: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  fingerprint: string | null;
  prNumber: number | null;
  headSha: string | null;
  inputJson: string | null;
  /** Comma-separated AttemptKeys the enqueue charged, e.g. `resolve,resolve_total`. */
  chargedKey: string | null;
}

export type NewDrop = Pick<Drop, 'id' | 'dropZoneId' | 'workItemId' | 'role' | 'state'> &
  Partial<
    Pick<
      Drop,
      | 'stickId'
      | 'epoch'
      | 'leaseExpiresAt'
      | 'promptVersion'
      | 'image'
      | 'createdAt'
      | 'fingerprint'
      | 'prNumber'
      | 'headSha'
      | 'inputJson'
      | 'chargedKey'
    >
  >;

export type DropPatch = Partial<Omit<Drop, 'id' | 'dropZoneId' | 'workItemId' | 'createdAt'>>;

export interface StoredEvent {
  seq: number;
  ts: string;
  kind: TrooperEvent['kind'];
  data: Record<string, unknown>;
}

export interface Stick {
  id: string;
  name: string;
  tokenHash: string;
  slots: number;
  lastSeenAt: string | null;
  createdAt: string;
}

const wallClock = () => new Date().toISOString();
const iso = (now?: Date) => (now ? now.toISOString() : wallClock());

const WORK_ITEM_COLS = `id, drop_zone_id AS dropZoneId, issue_number AS issueNumber, title, body, author,
  priority, is_fix AS isFix, issue_created_at AS issueCreatedAt, state, reason, pr_number AS prNumber,
  retry_label_seen AS retryLabelSeen, waiting_since AS waitingSince`;

const DROP_COLS = `id, drop_zone_id AS dropZoneId, work_item_id AS workItemId, role, state, stick_id AS stickId,
  epoch, lease_expires_at AS leaseExpiresAt, prompt_version AS promptVersion, image,
  result_json AS resultJson, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  fingerprint, pr_number AS prNumber, head_sha AS headSha, input_json AS inputJson, charged_key AS chargedKey`;

type WorkItemRow = Omit<WorkItem, 'isFix' | 'retryLabelSeen'> & {
  isFix: number;
  retryLabelSeen: number;
};
const toWorkItem = (r: WorkItemRow): WorkItem => ({
  ...r,
  isFix: r.isFix === 1,
  retryLabelSeen: r.retryLabelSeen === 1,
});

export function upsertDropZone(db: Db, z: DropZoneRow): void {
  db.prepare(
    `INSERT INTO drop_zones (id, repo, default_branch, config_json)
     VALUES (@id, @repo, @defaultBranch, @configJson)
     ON CONFLICT(id) DO UPDATE SET repo = excluded.repo,
       default_branch = excluded.default_branch, config_json = excluded.config_json`,
  ).run(z);
}

export function setDropZoneDefaultBranch(db: Db, id: string, defaultBranch: string): void {
  db.prepare('UPDATE drop_zones SET default_branch = ? WHERE id = ?').run(defaultBranch, id);
}

/** Inserts a new ready work item, or refreshes issue fields of an existing one (state is preserved). */
export function upsertWorkItem(db: Db, w: NewWorkItem, now?: Date): WorkItem {
  const row = db
    .prepare(
      `INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, priority, is_fix,
         issue_created_at, updated_at)
       VALUES (@dropZoneId, @issueNumber, @title, @body, @author, @priority, @isFix, @issueCreatedAt, @updatedAt)
       ON CONFLICT(drop_zone_id, issue_number) DO UPDATE SET title = excluded.title, body = excluded.body,
         author = excluded.author, priority = excluded.priority, is_fix = excluded.is_fix,
         issue_created_at = excluded.issue_created_at, updated_at = excluded.updated_at
       RETURNING ${WORK_ITEM_COLS}`,
    )
    .get({ ...w, isFix: w.isFix ? 1 : 0, updatedAt: iso(now) }) as WorkItemRow;
  return toWorkItem(row);
}

export function listWorkItems(db: Db, zoneId: string, state?: WorkItemState): WorkItem[] {
  const rows = db
    .prepare(
      `SELECT ${WORK_ITEM_COLS} FROM work_items
       WHERE drop_zone_id = @zoneId AND (@state IS NULL OR state = @state) ORDER BY id`,
    )
    .all({ zoneId, state: state ?? null }) as WorkItemRow[];
  return rows.map(toWorkItem);
}

export function getWorkItem(db: Db, id: number): WorkItem | undefined {
  const row = db.prepare(`SELECT ${WORK_ITEM_COLS} FROM work_items WHERE id = ?`).get(id) as
    | WorkItemRow
    | undefined;
  return row && toWorkItem(row);
}

export function setWorkItemState(
  db: Db,
  id: number,
  state: WorkItemState,
  reason?: string,
  now?: Date,
): void {
  db.prepare('UPDATE work_items SET state = ?, reason = ?, updated_at = ? WHERE id = ?').run(
    state,
    reason ?? null,
    iso(now),
    id,
  );
}

export function setWaitingSince(db: Db, id: number, at: string | null): void {
  db.prepare('UPDATE work_items SET waiting_since = ? WHERE id = ?').run(at, id);
}

export function setRetryLabelSeen(db: Db, id: number, seen: boolean): void {
  db.prepare('UPDATE work_items SET retry_label_seen = ? WHERE id = ?').run(seen ? 1 : 0, id);
}

export function insertDrop(db: Db, d: NewDrop, now?: Date): void {
  db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
       prompt_version, image, created_at, fingerprint, pr_number, head_sha, input_json, charged_key)
     VALUES (@id, @dropZoneId, @workItemId, @role, @state, @stickId, @epoch, @leaseExpiresAt,
       @promptVersion, @image, @createdAt, @fingerprint, @prNumber, @headSha, @inputJson, @chargedKey)`,
  ).run({
    stickId: null,
    epoch: 0,
    leaseExpiresAt: null,
    promptVersion: null,
    image: null,
    fingerprint: null,
    prNumber: null,
    headSha: null,
    inputJson: null,
    chargedKey: null,
    createdAt: iso(now),
    ...d,
  });
}

export function getDrop(db: Db, id: string): Drop | undefined {
  return db.prepare(`SELECT ${DROP_COLS} FROM drops WHERE id = ?`).get(id) as Drop | undefined;
}

const DROP_COLUMN: Record<keyof DropPatch, string> = {
  role: 'role',
  state: 'state',
  stickId: 'stick_id',
  epoch: 'epoch',
  leaseExpiresAt: 'lease_expires_at',
  promptVersion: 'prompt_version',
  image: 'image',
  resultJson: 'result_json',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  fingerprint: 'fingerprint',
  prNumber: 'pr_number',
  headSha: 'head_sha',
  inputJson: 'input_json',
  chargedKey: 'charged_key',
};

export function updateDrop(db: Db, id: string, patch: DropPatch): void {
  const keys = (Object.keys(patch) as (keyof DropPatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${DROP_COLUMN[k]} = @${k}`).join(', ');
  db.prepare(`UPDATE drops SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

/** Appends events after the drop's current highest seq (seq starts at 1), atomically. */
export function appendEvents(db: Db, dropId: string, events: TrooperEvent[]): void {
  const max = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM drop_events WHERE drop_id = ?');
  const ins = db.prepare(
    'INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    let seq = (max.get(dropId) as { m: number }).m;
    for (const e of events) ins.run(dropId, ++seq, e.ts, e.kind, JSON.stringify(e.data));
  })();
}

export function listEvents(db: Db, dropId: string): StoredEvent[] {
  const rows = db
    .prepare(
      'SELECT seq, ts, kind, data_json AS dataJson FROM drop_events WHERE drop_id = ? ORDER BY seq',
    )
    .all(dropId) as { seq: number; ts: string; kind: StoredEvent['kind']; dataJson: string }[];
  return rows.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, data: JSON.parse(r.dataJson) }));
}

export function insertStick(db: Db, s: Pick<Stick, 'id' | 'name' | 'tokenHash' | 'slots'>): void {
  db.prepare(
    'INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES (@id, @name, @tokenHash, @slots, @createdAt)',
  ).run({ ...s, createdAt: wallClock() });
}

export function getStickByTokenHash(db: Db, tokenHash: string): Stick | undefined {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, slots, last_seen_at AS lastSeenAt, created_at AS createdAt
       FROM sticks WHERE token_hash = ?`,
    )
    .get(tokenHash) as Stick | undefined;
}

export function listRecentDrops(db: Db, limit = 50): Drop[] {
  return db
    .prepare(`SELECT ${DROP_COLS} FROM drops ORDER BY created_at DESC, id LIMIT ?`)
    .all(limit) as Drop[];
}

export function latestRateLimitEvent(db: Db): (StoredEvent & { dropId: string }) | undefined {
  const r = db
    .prepare(
      `SELECT drop_id AS dropId, seq, ts, kind, data_json AS dataJson FROM drop_events
       WHERE kind = 'rate_limit' ORDER BY ts DESC, seq DESC LIMIT 1`,
    )
    .get() as
    | { dropId: string; seq: number; ts: string; kind: StoredEvent['kind']; dataJson: string }
    | undefined;
  return (
    r && { dropId: r.dropId, seq: r.seq, ts: r.ts, kind: r.kind, data: JSON.parse(r.dataJson) }
  );
}

export function activeDropFor(db: Db, itemId: number): Drop | undefined {
  return db
    .prepare(
      `SELECT ${DROP_COLS} FROM drops
       WHERE work_item_id = ? AND state IN ('queued','leased','running')`,
    )
    .get(itemId) as Drop | undefined;
}

// ---- M1: pull requests -------------------------------------------------------------------------

export type AttemptKey =
  | 'heal'
  | 'resolve'
  | 'resolve_total'
  | 'resume'
  | 'review'
  | 'no_change'
  | 'rate_limit';

export interface PullRequestRow {
  workItemId: number;
  number: number;
  headRef: string;
  headSha: string;
  headFirstSeenAt: string;
  state: 'open' | 'closed' | 'merged';
  observedAt: string;
}

const PR_COLS = `work_item_id AS workItemId, number, head_ref AS headRef, head_sha AS headSha,
  head_first_seen_at AS headFirstSeenAt, state, observed_at AS observedAt`;

export function getPullRequest(db: Db, itemId: number): PullRequestRow | undefined {
  return db.prepare(`SELECT ${PR_COLS} FROM pull_requests WHERE work_item_id = ?`).get(itemId) as
    | PullRequestRow
    | undefined;
}

/**
 * Records the observed PR. `headFirstSeenAt` is reset only when `headSha` changes. Mirrors `number`
 * into `work_items.pr_number` (a UI copy; `pull_requests` is authoritative).
 */
export function upsertPullRequest(
  db: Db,
  row: Omit<PullRequestRow, 'headFirstSeenAt' | 'observedAt'>,
  now: Date,
): void {
  const at = now.toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO pull_requests (work_item_id, number, head_ref, head_sha, head_first_seen_at, state,
         observed_at)
       VALUES (@workItemId, @number, @headRef, @headSha, @at, @state, @at)
       ON CONFLICT(work_item_id) DO UPDATE SET number = excluded.number, head_ref = excluded.head_ref,
         head_first_seen_at = CASE WHEN pull_requests.head_sha = excluded.head_sha
           THEN pull_requests.head_first_seen_at ELSE excluded.head_first_seen_at END,
         head_sha = excluded.head_sha, state = excluded.state, observed_at = excluded.observed_at`,
    ).run({ ...row, at });
    db.prepare('UPDATE work_items SET pr_number = ? WHERE id = ?').run(row.number, row.workItemId);
  })();
}

// ---- M1: verdicts ------------------------------------------------------------------------------

export interface VerdictRow {
  id: string;
  workItemId: number;
  headSha: string;
  decision: 'approve' | 'request_changes';
  forced: boolean;
  summary: string;
  findingsJson: string;
  gatesJson: string;
  createdAt: string;
}

const VERDICT_COLS = `id, work_item_id AS workItemId, head_sha AS headSha, decision, forced, summary,
  findings_json AS findingsJson, gates_json AS gatesJson, created_at AS createdAt`;

type VerdictDbRow = Omit<VerdictRow, 'forced'> & { forced: number };
const toVerdict = (r: VerdictDbRow): VerdictRow => ({ ...r, forced: r.forced === 1 });

/** Returns whether a row was inserted (false when a verdict with this id already exists). */
export function insertVerdict(db: Db, v: VerdictRow): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO verdicts (id, work_item_id, head_sha, decision, forced, summary,
         findings_json, gates_json, created_at)
       VALUES (@id, @workItemId, @headSha, @decision, @forced, @summary, @findingsJson, @gatesJson,
         @createdAt)`,
    )
    .run({ ...v, forced: v.forced ? 1 : 0 });
  return r.changes === 1;
}

export function latestVerdict(db: Db, itemId: number): VerdictRow | undefined {
  const r = db
    .prepare(
      `SELECT ${VERDICT_COLS} FROM verdicts WHERE work_item_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as VerdictDbRow | undefined;
  return r && toVerdict(r);
}

export function verdictsForHead(db: Db, itemId: number, headSha: string): VerdictRow[] {
  const rows = db
    .prepare(
      `SELECT ${VERDICT_COLS} FROM verdicts WHERE work_item_id = ? AND head_sha = ?
       ORDER BY created_at, rowid`,
    )
    .all(itemId, headSha) as VerdictDbRow[];
  return rows.map(toVerdict);
}

// ---- M1: attempts ------------------------------------------------------------------------------

export function getAttempts(
  db: Db,
  itemId: number,
  key: AttemptKey,
): { count: number; lastFingerprint: string | null } {
  const r = db
    .prepare(
      'SELECT count, last_fingerprint AS lastFingerprint FROM attempts WHERE work_item_id = ? AND key = ?',
    )
    .get(itemId, key) as { count: number; lastFingerprint: string | null } | undefined;
  return r ?? { count: 0, lastFingerprint: null };
}

export function setAttempts(
  db: Db,
  itemId: number,
  key: AttemptKey,
  count: number,
  fingerprint: string | null,
): void {
  db.prepare(
    `INSERT INTO attempts (work_item_id, key, count, last_fingerprint) VALUES (?, ?, ?, ?)
     ON CONFLICT(work_item_id, key) DO UPDATE SET count = excluded.count,
       last_fingerprint = excluded.last_fingerprint`,
  ).run(itemId, key, count, fingerprint);
}

export function resetAttempts(db: Db, itemId: number): void {
  db.prepare('DELETE FROM attempts WHERE work_item_id = ?').run(itemId);
}

// ---- M1: outbox --------------------------------------------------------------------------------

export type OutboxState = 'pending' | 'done' | 'unknown' | 'failed';

export interface OutboxRow {
  id: string;
  opKey: string;
  kind: 'create_pr' | 'post_review' | 'merge';
  workItemId: number;
  payloadJson: string;
  state: OutboxState;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const OUTBOX_COLS = `o.id, o.op_key AS opKey, o.kind, o.work_item_id AS workItemId,
  o.payload_json AS payloadJson, o.state, o.result_json AS resultJson, o.error,
  o.created_at AS createdAt, o.updated_at AS updatedAt`;

export function getOutbox(db: Db, opKey: string): OutboxRow | undefined {
  return db.prepare(`SELECT ${OUTBOX_COLS} FROM outbox o WHERE o.op_key = ?`).get(opKey) as
    | OutboxRow
    | undefined;
}

/** `INSERT OR IGNORE` on `op_key`; returns whether a row was inserted. */
export function insertOutbox(
  db: Db,
  row: Omit<OutboxRow, 'resultJson' | 'error' | 'updatedAt'>,
): boolean {
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id, op_key, kind, work_item_id, payload_json, state, created_at,
         updated_at)
       VALUES (@id, @opKey, @kind, @workItemId, @payloadJson, @state, @createdAt, @createdAt)`,
    )
    .run(row);
  return r.changes === 1;
}

export function updateOutbox(
  db: Db,
  opKey: string,
  patch: Pick<Partial<OutboxRow>, 'state' | 'resultJson' | 'error'>,
  now: Date,
): void {
  const cols = { state: 'state', resultJson: 'result_json', error: 'error' } as const;
  const keys = (Object.keys(cols) as (keyof typeof cols)[]).filter((k) => patch[k] !== undefined);
  const sets = [...keys.map((k) => `${cols[k]} = @${k}`), 'updated_at = @updatedAt'].join(', ');
  db.prepare(`UPDATE outbox SET ${sets} WHERE op_key = @opKey`).run({
    ...patch,
    opKey,
    updatedAt: now.toISOString(),
  });
}

export function listOutbox(db: Db, states: OutboxState[], zoneId?: string): OutboxRow[] {
  if (states.length === 0) return [];
  const marks = states.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${OUTBOX_COLS} FROM outbox o JOIN work_items w ON w.id = o.work_item_id
       WHERE o.state IN (${marks}) AND (? IS NULL OR w.drop_zone_id = ?)
       ORDER BY o.created_at, o.rowid`,
    )
    .all(...states, zoneId ?? null, zoneId ?? null) as OutboxRow[];
}

/** Deletes failed ops for an item (all kinds when `kind` is omitted); returns the count deleted. */
export function deleteFailedOutbox(db: Db, itemId: number, kind?: OutboxRow['kind']): number {
  return db
    .prepare(
      `DELETE FROM outbox WHERE work_item_id = ? AND state = 'failed' AND (? IS NULL OR kind = ?)`,
    )
    .run(itemId, kind ?? null, kind ?? null).changes;
}

/**
 * Compare-and-set `done` -> `pending` for an op that must run again; restarts its `created_at`
 * clock. Returns whether this caller won the reset.
 */
export function resetDoneOutbox(db: Db, opKey: string, now: Date): boolean {
  const at = now.toISOString();
  return (
    db
      .prepare(
        `UPDATE outbox SET state = 'pending', result_json = NULL, error = NULL, created_at = ?,
           updated_at = ? WHERE op_key = ? AND state = 'done'`,
      )
      .run(at, at, opKey).changes === 1
  );
}

// ---- M1: usage state ---------------------------------------------------------------------------

export interface UsageStateRow {
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  pausedUntil: string | null;
  fiveHourUtil: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtil: number | null;
  sevenDayResetsAt: string | null;
  observedAt: string | null;
  pausedAt: string | null;
  pauseConfirmed: boolean;
  probeDropId: string | null;
  probeNotBefore: string | null;
  causeDropId: string | null;
  causeWorkItemId: number | null;
  updatedAt: string | null;
}

const USAGE_COLUMN: Record<keyof UsageStateRow, string> = {
  status: 'status',
  pausedUntil: 'paused_until',
  fiveHourUtil: 'five_hour_util',
  fiveHourResetsAt: 'five_hour_resets_at',
  sevenDayUtil: 'seven_day_util',
  sevenDayResetsAt: 'seven_day_resets_at',
  observedAt: 'observed_at',
  pausedAt: 'paused_at',
  pauseConfirmed: 'pause_confirmed',
  probeDropId: 'probe_drop_id',
  probeNotBefore: 'probe_not_before',
  causeDropId: 'cause_drop_id',
  causeWorkItemId: 'cause_work_item_id',
  updatedAt: 'updated_at',
};

export function getUsageState(db: Db): UsageStateRow {
  const cols = (Object.keys(USAGE_COLUMN) as (keyof UsageStateRow)[])
    .map((k) => `${USAGE_COLUMN[k]} AS ${k}`)
    .join(', ');
  const r = db.prepare(`SELECT ${cols} FROM usage_state WHERE id = 1`).get() as Omit<
    UsageStateRow,
    'pauseConfirmed'
  > & { pauseConfirmed: number };
  return { ...r, pauseConfirmed: r.pauseConfirmed === 1 };
}

/** Merges `patch` onto the single usage row (a key set to `null` clears it; `undefined` is skipped). */
export function setUsageState(db: Db, patch: Partial<UsageStateRow>, now: Date): void {
  const keys = (Object.keys(patch) as (keyof UsageStateRow)[]).filter(
    (k) => k !== 'updatedAt' && patch[k] !== undefined,
  );
  const sets = [...keys.map((k) => `${USAGE_COLUMN[k]} = @${k}`), 'updated_at = @updatedAt'].join(
    ', ',
  );
  const params: Record<string, unknown> = { ...patch, updatedAt: now.toISOString() };
  if (patch.pauseConfirmed !== undefined) params.pauseConfirmed = patch.pauseConfirmed ? 1 : 0;
  db.prepare(`UPDATE usage_state SET ${sets} WHERE id = 1`).run(params);
}

/** The zone's default branch as last synced from the forge, or null before the first sync. */
export function getDropZoneDefaultBranch(db: Db, zoneId: string): string | null {
  const r = db.prepare('SELECT default_branch AS b FROM drop_zones WHERE id = ?').get(zoneId) as
    | { b: string }
    | undefined;
  return r?.b ?? null;
}

/** Whether the item has a create_pr outbox row that is still pending or unknown. */
export function hasOpenCreatePr(db: Db, itemId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM outbox WHERE work_item_id = ? AND kind = 'create_pr'
           AND state IN ('pending', 'unknown') LIMIT 1`,
      )
      .get(itemId) !== undefined
  );
}
