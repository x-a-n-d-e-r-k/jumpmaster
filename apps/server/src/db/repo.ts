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
}

export type NewWorkItem = Omit<WorkItem, 'id' | 'state' | 'reason' | 'prNumber'>;

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
}

export type NewDrop = Pick<Drop, 'id' | 'dropZoneId' | 'workItemId' | 'role' | 'state'> &
  Partial<
    Pick<Drop, 'stickId' | 'epoch' | 'leaseExpiresAt' | 'promptVersion' | 'image' | 'createdAt'>
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

const now = () => new Date().toISOString();

const WORK_ITEM_COLS = `id, drop_zone_id AS dropZoneId, issue_number AS issueNumber, title, body, author,
  priority, is_fix AS isFix, issue_created_at AS issueCreatedAt, state, reason, pr_number AS prNumber`;

const DROP_COLS = `id, drop_zone_id AS dropZoneId, work_item_id AS workItemId, role, state, stick_id AS stickId,
  epoch, lease_expires_at AS leaseExpiresAt, prompt_version AS promptVersion, image,
  result_json AS resultJson, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt`;

type WorkItemRow = Omit<WorkItem, 'isFix'> & { isFix: number };
const toWorkItem = (r: WorkItemRow): WorkItem => ({ ...r, isFix: r.isFix === 1 });

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
export function upsertWorkItem(db: Db, w: NewWorkItem): WorkItem {
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
    .get({ ...w, isFix: w.isFix ? 1 : 0, updatedAt: now() }) as WorkItemRow;
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

export function setWorkItemState(db: Db, id: number, state: WorkItemState, reason?: string): void {
  db.prepare('UPDATE work_items SET state = ?, reason = ?, updated_at = ? WHERE id = ?').run(
    state,
    reason ?? null,
    now(),
    id,
  );
}

export function insertDrop(db: Db, d: NewDrop): void {
  db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
       prompt_version, image, created_at)
     VALUES (@id, @dropZoneId, @workItemId, @role, @state, @stickId, @epoch, @leaseExpiresAt,
       @promptVersion, @image, @createdAt)`,
  ).run({
    stickId: null,
    epoch: 0,
    leaseExpiresAt: null,
    promptVersion: null,
    image: null,
    createdAt: now(),
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
  ).run({ ...s, createdAt: now() });
}

export function getStickByTokenHash(db: Db, tokenHash: string): Stick | undefined {
  return db
    .prepare(
      `SELECT id, name, token_hash AS tokenHash, slots, last_seen_at AS lastSeenAt, created_at AS createdAt
       FROM sticks WHERE token_hash = ?`,
    )
    .get(tokenHash) as Stick | undefined;
}
