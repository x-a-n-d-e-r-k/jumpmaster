import type { ImagePolicy, TrooperEvent } from '@jumpmaster/protocol';
import type { Db } from './open.js';

export type WorkItemState = 'ready' | 'in_flight' | 'pr_open' | 'parked' | 'done';
export type DropState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'push_pending'
  | 'succeeded'
  | 'failed'
  | 'lost'
  | 'cancelled';

/**
 * The states in which a drop holds its item (and its branch): nothing else may start on it. A pending
 * push is one of them.
 */
export const ACTIVE_DROP_STATES = ['queued', 'leased', 'running', 'push_pending'] as const;

/** `ACTIVE_DROP_STATES` as an SQL list, e.g. for `state IN (${ACTIVE_STATES_SQL})`. */
export const ACTIVE_STATES_SQL = ACTIVE_DROP_STATES.map((s) => `'${s}'`).join(', ');

/** How long an unrevoked grant reservation blocks another grant for the same drop. */
export const GRANT_HOLD_MS = 15 * 60_000;

/** How long a pending push is kept before it is given up on. */
export const PUSH_RETENTION_MS = 24 * 3_600_000;

/** How long after it went `lost` a drop that had reached `running` may still be salvaged. */
export const RECLAIM_WINDOW_MS = 15 * 60_000;

export type PushKind = 'final' | 'checkpoint' | 'salvage';

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
  /** Open native "blocked by" links; a ready item with any is never started. */
  blockedBy: string[];
}

export type NewWorkItem = Omit<
  WorkItem,
  'id' | 'state' | 'reason' | 'prNumber' | 'retryLabelSeen' | 'waitingSince' | 'blockedBy'
> & { blockedBy?: string[] };

export interface Drop {
  id: string;
  dropZoneId: string;
  /** Null for a crew drop, which works for the zone rather than one work item. */
  workItemId: number | null;
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
  /** The model the payload asked for (set when the drop is leased). */
  requestedModel: string | null;
  /** The model that actually served the drop, as its result reported. */
  servedModel: string | null;
  /** Set when the drop went `push_pending`: what its push container is to push. */
  pushKind: PushKind | null;
  pushExpectSha: string | null;
  /** ISO time after which a pending push is given up on. */
  pushDeadline: string | null;
  /** Stamped on the first heartbeat that moved the drop to `running`. */
  runningAt: string | null;
  /** 1 once the result's usage has been applied (a push-requested result applies it early). */
  usageApplied: number;
  /** 1 when the drop held the usage probe at the time its usage was applied. */
  wasProbe: number;
  /**
   * For a rate-limited result: 1 when usage was paused as its usage was applied (a requeue is
   * due), 0 when not; null when not decided (any other result, or applied before v23).
   */
  rateLimitRequeue: number | null;
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
  /** As advertised on its last enroll or lease (v15). */
  capabilities: string[];
  imagePolicy: ImagePolicy;
  version: string | null;
  pinnedImages: string[];
  /** The trooper count the operator set (v26); null: the enrolled `slots`. */
  desiredSlots: number | null;
  /** The ceiling the stick last reported (v26); null: too old to report one. */
  maxSlots: number | null;
}

/** The most troopers a stick will run: what it reported, or its enrolled `slots` for an old one. */
export const stickCeiling = (s: Pick<Stick, 'slots' | 'maxSlots'>): number => s.maxSlots ?? s.slots;

/** How many troopers a stick runs at once: the operator's count (or the enrolled one), capped. */
export const effectiveSlots = (s: Pick<Stick, 'slots' | 'maxSlots' | 'desiredSlots'>): number =>
  Math.min(s.desiredSlots ?? s.slots, stickCeiling(s));

const wallClock = () => new Date().toISOString();
const iso = (now?: Date) => (now ? now.toISOString() : wallClock());

const WORK_ITEM_COLS = `id, drop_zone_id AS dropZoneId, issue_number AS issueNumber, title, body, author,
  priority, is_fix AS isFix, issue_created_at AS issueCreatedAt, state, reason, pr_number AS prNumber,
  retry_label_seen AS retryLabelSeen, waiting_since AS waitingSince, blocked_by AS blockedBy`;

const DROP_COLS = `id, drop_zone_id AS dropZoneId, work_item_id AS workItemId, role, state, stick_id AS stickId,
  epoch, lease_expires_at AS leaseExpiresAt, prompt_version AS promptVersion, image,
  result_json AS resultJson, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt,
  fingerprint, pr_number AS prNumber, head_sha AS headSha, input_json AS inputJson, charged_key AS chargedKey,
  requested_model AS requestedModel, served_model AS servedModel, push_kind AS pushKind,
  push_expect_sha AS pushExpectSha, push_deadline AS pushDeadline, running_at AS runningAt,
  usage_applied AS usageApplied, was_probe AS wasProbe,
  rate_limit_requeue AS rateLimitRequeue`;

type WorkItemRow = Omit<WorkItem, 'isFix' | 'retryLabelSeen' | 'blockedBy'> & {
  isFix: number;
  retryLabelSeen: number;
  blockedBy: string;
};
const toWorkItem = (r: WorkItemRow): WorkItem => ({
  ...r,
  isFix: r.isFix === 1,
  retryLabelSeen: r.retryLabelSeen === 1,
  blockedBy: JSON.parse(r.blockedBy) as string[],
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
         issue_created_at, blocked_by, updated_at)
       VALUES (@dropZoneId, @issueNumber, @title, @body, @author, @priority, @isFix, @issueCreatedAt,
         @blockedBy, @updatedAt)
       ON CONFLICT(drop_zone_id, issue_number) DO UPDATE SET title = excluded.title, body = excluded.body,
         author = excluded.author, priority = excluded.priority, is_fix = excluded.is_fix,
         issue_created_at = excluded.issue_created_at, blocked_by = excluded.blocked_by,
         updated_at = excluded.updated_at
       RETURNING ${WORK_ITEM_COLS}`,
    )
    .get({
      dropZoneId: w.dropZoneId,
      issueNumber: w.issueNumber,
      title: w.title,
      body: w.body,
      author: w.author,
      priority: w.priority,
      isFix: w.isFix ? 1 : 0,
      issueCreatedAt: w.issueCreatedAt,
      blockedBy: JSON.stringify(w.blockedBy ?? []),
      updatedAt: iso(now),
    }) as WorkItemRow;
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

/** For a gate park: the newest review submittedAt seen, and when the item was last re-decided. */
export function getParkMark(
  db: Db,
  id: number,
): { reviewsSeen: string | null; checkedAt: string | null } {
  return (
    (db
      .prepare(
        'SELECT park_reviews_seen AS reviewsSeen, park_checked_at AS checkedAt FROM work_items WHERE id = ?',
      )
      .get(id) as { reviewsSeen: string | null; checkedAt: string | null } | undefined) ?? {
      reviewsSeen: null,
      checkedAt: null,
    }
  );
}

export function setParkMark(db: Db, id: number, reviewsSeen: string, checkedAt: Date): void {
  db.prepare('UPDATE work_items SET park_reviews_seen = ?, park_checked_at = ? WHERE id = ?').run(
    reviewsSeen,
    checkedAt.toISOString(),
    id,
  );
}

export type GateDetails = { scripts: string[]; tools: string[] };
export type GatePark = {
  itemId: number;
  prNumber: number;
  headSha: string;
  mergeBaseSha: string;
  details: GateDetails;
  /** When this content was first recorded (unchanged by re-recording the same judgement). */
  recordedAt: string;
};

/** Records what a gate park judged; recorded_at moves only when the judgement changes. */
export function recordGatePark(db: Db, p: Omit<GatePark, 'recordedAt'>, now: Date): void {
  db.prepare(
    `INSERT INTO gate_parks (item_id, pr_number, head_sha, merge_base_sha, details_json, recorded_at)
       VALUES (@itemId, @prNumber, @headSha, @mergeBaseSha, @detailsJson, @at)
     ON CONFLICT (item_id) DO UPDATE SET pr_number = excluded.pr_number,
       head_sha = excluded.head_sha, merge_base_sha = excluded.merge_base_sha,
       details_json = excluded.details_json, recorded_at = excluded.recorded_at
     WHERE pr_number IS NOT excluded.pr_number OR head_sha IS NOT excluded.head_sha
       OR merge_base_sha IS NOT excluded.merge_base_sha
       OR details_json IS NOT excluded.details_json`,
  ).run({
    itemId: p.itemId,
    prNumber: p.prNumber,
    headSha: p.headSha,
    mergeBaseSha: p.mergeBaseSha,
    detailsJson: JSON.stringify(p.details),
    at: now.toISOString(),
  });
}

export function getGatePark(db: Db, itemId: number): GatePark | undefined {
  const r = db
    .prepare(
      `SELECT item_id AS itemId, pr_number AS prNumber, head_sha AS headSha,
         merge_base_sha AS mergeBaseSha, details_json AS detailsJson, recorded_at AS recordedAt
         FROM gate_parks WHERE item_id = ?`,
    )
    .get(itemId) as (Omit<GatePark, 'details'> & { detailsJson: string }) | undefined;
  if (!r) return undefined;
  const { detailsJson, ...rest } = r;
  return { ...rest, details: JSON.parse(detailsJson) as GateDetails };
}

/**
 * Command's allowance of one judged diff: the head, the merge base it was judged against, and the
 * digest of every change listed (gateDigest).
 */
export type GateAllowance = {
  itemId: number;
  prNumber: number;
  headSha: string;
  mergeBaseSha: string;
  digest: string;
  ruledAt: string;
  rulingId: number;
};

/**
 * Records Command's allowance of `headSha`'s gate changes. Repeating the same allowance is a no-op
 * (the first ruled_at kept); a later ruling on the same head for another judgement replaces it.
 */
export function recordGateAllowance(db: Db, a: Omit<GateAllowance, 'ruledAt'>, now: Date): void {
  db.prepare(
    `INSERT INTO gate_allowances (item_id, pr_number, head_sha, merge_base_sha, reason_digest,
       ruled_at, ruling_id) VALUES (@itemId, @prNumber, @headSha, @mergeBaseSha, @digest, @at,
       @rulingId)
     ON CONFLICT (item_id, pr_number, head_sha) DO UPDATE SET merge_base_sha = excluded.merge_base_sha,
       reason_digest = excluded.reason_digest, ruled_at = excluded.ruled_at,
       ruling_id = excluded.ruling_id
     WHERE merge_base_sha IS NOT excluded.merge_base_sha
       OR reason_digest IS NOT excluded.reason_digest`,
  ).run({ ...a, at: now.toISOString() });
}

/** Command's allowance for exactly this item, PR and head, if any. */
export function getGateAllowance(
  db: Db,
  itemId: number,
  prNumber: number,
  headSha: string,
): GateAllowance | undefined {
  return db
    .prepare(
      `SELECT item_id AS itemId, pr_number AS prNumber, head_sha AS headSha,
         merge_base_sha AS mergeBaseSha, reason_digest AS digest, ruled_at AS ruledAt,
         ruling_id AS rulingId
         FROM gate_allowances WHERE item_id = ? AND pr_number = ? AND head_sha = ?`,
    )
    .get(itemId, prNumber, headSha) as GateAllowance | undefined;
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
  requestedModel: 'requested_model',
  servedModel: 'served_model',
  pushKind: 'push_kind',
  pushExpectSha: 'push_expect_sha',
  pushDeadline: 'push_deadline',
  runningAt: 'running_at',
  usageApplied: 'usage_applied',
  wasProbe: 'was_probe',
  rateLimitRequeue: 'rate_limit_requeue',
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

type StickAdvert = Pick<Stick, 'capabilities' | 'imagePolicy' | 'version' | 'pinnedImages'>;
const NO_ADVERT: StickAdvert = {
  capabilities: [],
  imagePolicy: 'allowlist',
  version: null,
  pinnedImages: [],
};
const advertParams = (a: StickAdvert) => ({
  caps: JSON.stringify(a.capabilities),
  policy: a.imagePolicy,
  version: a.version,
  pinned: JSON.stringify(a.pinnedImages),
});

export function insertStick(
  db: Db,
  s: Pick<Stick, 'id' | 'name' | 'tokenHash' | 'slots'> & Partial<StickAdvert>,
): void {
  const { id, name, tokenHash, slots, ...advert } = s;
  db.prepare(
    `INSERT INTO sticks (id, name, token_hash, slots, created_at, capabilities_json, image_policy,
       version, pinned_json)
     VALUES (@id, @name, @tokenHash, @slots, @createdAt, @caps, @policy, @version, @pinned)`,
  ).run({
    id,
    name,
    tokenHash,
    slots,
    createdAt: wallClock(),
    ...advertParams({ ...NO_ADVERT, ...advert }),
  });
}

/**
 * Records what the stick advertised on this lease, and that it was seen now. `maxSlots` and
 * `slots` (its starting count), when the stick reports them, replace the stored ceiling and
 * enrolled count; an older stick's lease leaves them as they were.
 */
export function stampStick(
  db: Db,
  id: string,
  advert: StickAdvert,
  now: Date,
  counts: { maxSlots?: number | undefined; slots?: number | undefined } = {},
): void {
  db.prepare(
    `UPDATE sticks SET last_seen_at = @now, capabilities_json = @caps, image_policy = @policy,
       version = @version, pinned_json = @pinned, max_slots = COALESCE(@maxSlots, max_slots),
       slots = COALESCE(@slots, slots)
     WHERE id = @id`,
  ).run({
    id,
    now: now.toISOString(),
    maxSlots: counts.maxSlots ?? null,
    slots: counts.slots ?? null,
    ...advertParams(advert),
  });
}

/** Sets the operator's trooper count for a stick (the caller checks it against the ceiling). */
export function setStickDesiredSlots(db: Db, id: string, slots: number): void {
  db.prepare('UPDATE sticks SET desired_slots = ? WHERE id = ?').run(slots, id);
}

/** Drops holding one of the stick's lease slots now (leased or running; a pending push holds none). */
export function liveDropsOn(db: Db, stickId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM drops WHERE stick_id = ? AND state IN ('leased','running')`,
      )
      .get(stickId) as { n: number }
  ).n;
}

const STICK_COLS = `id, name, token_hash AS tokenHash, slots, last_seen_at AS lastSeenAt,
  created_at AS createdAt, capabilities_json AS capabilitiesJson, image_policy AS imagePolicy,
  version, pinned_json AS pinnedJson, desired_slots AS desiredSlots, max_slots AS maxSlots`;
type StickRow = Omit<Stick, 'capabilities' | 'pinnedImages'> & {
  capabilitiesJson: string;
  pinnedJson: string;
};
const parseList = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const toStick = ({ capabilitiesJson, pinnedJson, ...r }: StickRow): Stick => ({
  ...r,
  // Anything but an exact 'signed' reads as the weaker policy.
  imagePolicy: r.imagePolicy === 'signed' ? 'signed' : 'allowlist',
  capabilities: parseList(capabilitiesJson),
  pinnedImages: parseList(pinnedJson),
});

export function getStickByTokenHash(db: Db, tokenHash: string): Stick | undefined {
  const row = db.prepare(`SELECT ${STICK_COLS} FROM sticks WHERE token_hash = ?`).get(tokenHash) as
    | StickRow
    | undefined;
  return row ? toStick(row) : undefined;
}

export function getStick(db: Db, id: string): Stick | undefined {
  const row = db.prepare(`SELECT ${STICK_COLS} FROM sticks WHERE id = ?`).get(id) as
    | StickRow
    | undefined;
  return row ? toStick(row) : undefined;
}

/**
 * A stick by id, or else by name: `ambiguous` when several share the name (each needs its id).
 */
export function findStick(db: Db, idOrName: string): Stick | 'ambiguous' | undefined {
  const byId = getStick(db, idOrName);
  if (byId) return byId;
  const rows = db
    .prepare(`SELECT ${STICK_COLS} FROM sticks WHERE name = ? LIMIT 2`)
    .all(idOrName) as StickRow[];
  if (rows.length > 1) return 'ambiguous';
  return rows[0] ? toStick(rows[0]) : undefined;
}

/** Every enrolled stick, most recently seen first. */
export function listSticks(db: Db): Stick[] {
  return (
    db
      .prepare(
        `SELECT ${STICK_COLS} FROM sticks ORDER BY last_seen_at IS NULL, last_seen_at DESC, name`,
      )
      .all() as StickRow[]
  ).map(toStick);
}

/** A zone's active drops (queued, leased, running or push_pending), oldest first. */
export function listActiveDrops(db: Db, zoneId: string): Drop[] {
  return db
    .prepare(
      `SELECT ${DROP_COLS} FROM drops WHERE drop_zone_id = ? AND state IN (${ACTIVE_STATES_SQL})
       ORDER BY created_at, id`,
    )
    .all(zoneId) as Drop[];
}

/** Drops newest first, optionally of one zone and of some states, at most `limit`. */
export function listDrops(
  db: Db,
  f: { zoneId?: string; states?: readonly DropState[]; limit: number },
): Drop[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.zoneId !== undefined) {
    where.push('drop_zone_id = ?');
    args.push(f.zoneId);
  }
  if (f.states !== undefined) {
    where.push(`state IN (${f.states.map(() => '?').join(', ') || 'NULL'})`);
    args.push(...f.states);
  }
  return db
    .prepare(
      `SELECT ${DROP_COLS} FROM drops ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id LIMIT ?`,
    )
    .all(...args, f.limit) as Drop[];
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
       WHERE work_item_id = ? AND state IN (${ACTIVE_STATES_SQL})`,
    )
    .get(itemId) as Drop | undefined;
}

/**
 * The one reclaim predicate (Ruling 10, as ledgered): a `lost` drop that had reached `running` and
 * was lost no more than `RECLAIM_WINDOW_MS` ago, so its stick may still salvage it. `alias` names
 * the `drops` row; the statement binds `@reclaimCutoff` to `reclaimCutoff(now)`. A drop given up on
 * (retention expiry, a salvage that found nothing) has `running_at` cleared and never matches.
 */
export const reclaimableSql = (alias: string): string =>
  `(${alias}.state = 'lost' AND ${alias}.running_at IS NOT NULL
    AND ${alias}.finished_at >= @reclaimCutoff)`;

/** The `@reclaimCutoff` binding for `reclaimableSql` at `now`. */
export const reclaimCutoff = (now: Date): string =>
  new Date(now.getTime() - RECLAIM_WINDOW_MS).toISOString();

/** Whether this drop may still be salvaged at `now` (`reclaimableSql`). */
export function isReclaimable(db: Db, dropId: string, now: Date): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM drops d WHERE d.id = @id AND ${reclaimableSql('d')}`)
      .get({ id: dropId, reclaimCutoff: reclaimCutoff(now) }) !== undefined
  );
}

/**
 * The item's most recent drop that may still be salvaged (`reclaimableSql`). Callers deciding
 * whether to start work on an item treat it like `activeDropFor`: nothing else starts under it.
 */
export function reclaimableDropFor(db: Db, itemId: number, now: Date): Drop | undefined {
  return db
    .prepare(
      `SELECT ${DROP_COLS} FROM drops d WHERE d.work_item_id = @itemId AND ${reclaimableSql('d')}
       ORDER BY d.finished_at DESC, d.rowid DESC LIMIT 1`,
    )
    .get({ itemId, reclaimCutoff: reclaimCutoff(now) }) as Drop | undefined;
}

/**
 * The drop that keeps anything else from starting on the item at `now`: its active drop, or else
 * a lost one that may still be salvaged (Ruling 10). What `decide` and the reconciler wait on.
 */
export function holdingDropFor(db: Db, itemId: number, now: Date): Drop | undefined {
  return activeDropFor(db, itemId) ?? reclaimableDropFor(db, itemId, now);
}

// ---- M1: pull requests -------------------------------------------------------------------------

export type AttemptKey =
  | 'heal'
  | 'resolve'
  | 'resolve_total'
  | 'resume'
  | 'review'
  | 'no_change'
  /** A heal that changed nothing; `lastFingerprint` is the findings it could not act on. */
  | 'heal_no_change'
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
    const prev = db
      .prepare('SELECT number FROM pull_requests WHERE work_item_id = ?')
      .get(row.workItemId) as { number: number } | undefined;
    // A verdict belongs to the PR it was posted on: a new PR (retry after a close) starts clean,
    // even at the same head SHA, and gets its own CI clock.
    const newPr = prev !== undefined && prev.number !== row.number;
    if (newPr) db.prepare('DELETE FROM verdicts WHERE work_item_id = ?').run(row.workItemId);
    db.prepare(
      `INSERT INTO pull_requests (work_item_id, number, head_ref, head_sha, head_first_seen_at, state,
         observed_at)
       VALUES (@workItemId, @number, @headRef, @headSha, @at, @state, @at)
       ON CONFLICT(work_item_id) DO UPDATE SET number = excluded.number, head_ref = excluded.head_ref,
         head_first_seen_at = CASE
           WHEN pull_requests.head_sha = excluded.head_sha AND pull_requests.number = excluded.number
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

/**
 * When a head carries a request-changes verdict, forgets every verdict on it so the next pass
 * reviews it afresh (a request-changes there outranks any later approve, so none may survive
 * alone). A head with only approvals is left as it is. Only the retry label calls this: the owner
 * may have waived a criterion in the issue. Returns whether anything was forgotten.
 */
export function clearRequestChangesOnHead(db: Db, itemId: number, headSha: string): boolean {
  const rc = db
    .prepare(
      `SELECT 1 FROM verdicts WHERE work_item_id = ? AND head_sha = ?
       AND decision = 'request_changes' LIMIT 1`,
    )
    .get(itemId, headSha);
  if (!rc) return false;
  db.prepare('DELETE FROM verdicts WHERE work_item_id = ? AND head_sha = ?').run(itemId, headSha);
  return true;
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
  kind:
    | 'create_pr'
    | 'post_review'
    | 'merge'
    | 'create_issue'
    | 'update_issue'
    | 'set_labels'
    | 'create_labels';
  /** Null for a zone-level op (issue and label writes). */
  workItemId: number | null;
  zoneId: string;
  payloadJson: string;
  state: OutboxState;
  resultJson: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const OUTBOX_COLS = `o.id, o.op_key AS opKey, o.kind, o.work_item_id AS workItemId, o.zone_id AS zoneId,
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
      `INSERT OR IGNORE INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state,
         created_at, updated_at)
       VALUES (@id, @opKey, @kind, @workItemId, @zoneId, @payloadJson, @state, @createdAt, @createdAt)`,
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

/** Merges done since `since` (by `updated_at`), each with its work item's zone, oldest first. */
export function listMergesSince(db: Db, since: Date): Array<{ zoneId: string; at: string }> {
  return db
    .prepare(
      `SELECT COALESCE(w.drop_zone_id, o.zone_id) AS zoneId, o.updated_at AS at FROM outbox o
       LEFT JOIN work_items w ON w.id = o.work_item_id
       WHERE o.kind = 'merge' AND o.state = 'done' AND o.updated_at >= ?
       ORDER BY o.updated_at, o.rowid`,
    )
    .all(since.toISOString()) as Array<{ zoneId: string; at: string }>;
}

export function listOutbox(db: Db, states: OutboxState[], zoneId?: string): OutboxRow[] {
  if (states.length === 0) return [];
  const marks = states.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${OUTBOX_COLS} FROM outbox o
       WHERE o.state IN (${marks}) AND (? IS NULL OR o.zone_id = ?)
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
  /** Set while a credits stop is recorded; in force until `overageUntil` (see credits.ts). */
  overageStoppedAt: string | null;
  /** The drop whose report of credit use set the stop. */
  overageDropId: string | null;
  /** When the exhausted window resets and the stop lifts by itself. */
  overageUntil: string | null;
  /** JSON `CreditSignal`: what the stopping drop reported, for the briefing and status page. */
  overageSignalJson: string | null;
  /** Command's Resume: credits may run until then, for the bound drop only. */
  overageResumeUntil: string | null;
  overageResumeDropId: string | null;
  overageResumeWorkItemId: number | null;
  overageResumedAt: string | null;
  /** Set when a stop or a Resume horizon ended: one drop probes until a live in-plan report. */
  overageProbeSince: string | null;
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
  overageStoppedAt: 'overage_stopped_at',
  overageDropId: 'overage_drop_id',
  overageUntil: 'overage_until',
  overageSignalJson: 'overage_signal_json',
  overageResumeUntil: 'overage_resume_until',
  overageResumeDropId: 'overage_resume_drop_id',
  overageResumeWorkItemId: 'overage_resume_work_item_id',
  overageResumedAt: 'overage_resumed_at',
  overageProbeSince: 'overage_probe_since',
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

export const ZONE_MODES = ['active', 'paused', 'observe'] as const;
export type ZoneMode = (typeof ZONE_MODES)[number];

/** The zone's stored mode; `fallback` (from config) applies only until one is stored. */
export function getZoneMode(db: Db, zoneId: string, fallback: ZoneMode): ZoneMode {
  const row = db.prepare('SELECT mode FROM zone_controls WHERE zone_id = ?').get(zoneId) as
    | { mode: ZoneMode }
    | undefined;
  return row?.mode ?? fallback;
}

export function setZoneMode(db: Db, zoneId: string, mode: ZoneMode, now: Date): void {
  db.prepare(
    `INSERT INTO zone_controls (zone_id, mode, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (zone_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
  ).run(zoneId, mode, now.toISOString());
}

export function isKilled(db: Db): boolean {
  const row = db.prepare('SELECT engaged FROM kill_switch WHERE id = 1').get() as
    | { engaged: number }
    | undefined;
  return row?.engaged === 1;
}

/**
 * Whether the kill switch is engaged, or was released no more than `RECLAIM_WINDOW_MS` before
 * `now` (its `updated_at` is the release): how long a kill-cancelled drop may still be salvaged.
 */
export function killHeldOrRecent(db: Db, now: Date): boolean {
  const row = db.prepare('SELECT engaged, updated_at AS at FROM kill_switch WHERE id = 1').get() as
    | { engaged: number; at: string }
    | undefined;
  if (!row) return false;
  return row.engaged === 1 || row.at >= reclaimCutoff(now);
}

/** The item's most recent drop, whatever its state. */
export function latestDropFor(db: Db, itemId: number): Drop | undefined {
  return db
    .prepare(
      `SELECT ${DROP_COLS} FROM drops WHERE work_item_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as Drop | undefined;
}

/**
 * Engages or releases the kill switch. `engaged_at` is set only on an off-to-on transition (a repeat
 * engage keeps it); on on-to-off it is cleared and the paused milliseconds are returned (0 otherwise).
 */
export function setKilled(db: Db, engaged: boolean, now: Date): number {
  return db.transaction((): number => {
    const prev = db
      .prepare('SELECT engaged, engaged_at AS at FROM kill_switch WHERE id = 1')
      .get() as { engaged: number; at: string | null } | undefined;
    const was = prev?.engaged === 1;
    const at = engaged ? (was && prev?.at ? prev.at : now.toISOString()) : null;
    db.prepare(
      `INSERT INTO kill_switch (id, engaged, updated_at, engaged_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET engaged = excluded.engaged, updated_at = excluded.updated_at,
           engaged_at = excluded.engaged_at`,
    ).run(engaged ? 1 : 0, now.toISOString(), at);
    if (engaged || !was || !prev?.at) return 0;
    return Math.max(0, now.getTime() - new Date(prev.at).getTime());
  })();
}

/**
 * Reserves a push grant for a drop. One unrevoked reservation younger than `GRANT_HOLD_MS` blocks
 * another (`reserved`); otherwise older ones are revoked and a new row, `seq + 1`, is inserted.
 */
export function reserveGrant(db: Db, dropId: string, epoch: number, now: Date): 'ok' | 'reserved' {
  return db.transaction((): 'ok' | 'reserved' => {
    const live = db
      .prepare('SELECT reserved_at AS at FROM push_tokens WHERE drop_id = ? AND revoked_at IS NULL')
      .all(dropId) as { at: string }[];
    if (live.some((r) => now.getTime() - new Date(r.at).getTime() < GRANT_HOLD_MS))
      return 'reserved';
    db.prepare(
      'UPDATE push_tokens SET revoked_at = ? WHERE drop_id = ? AND revoked_at IS NULL',
    ).run(now.toISOString(), dropId);
    const { m } = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM push_tokens WHERE drop_id = ? AND epoch = ?')
      .get(dropId, epoch) as { m: number };
    db.prepare(
      'INSERT INTO push_tokens (drop_id, epoch, seq, reserved_at) VALUES (?, ?, ?, ?)',
    ).run(dropId, epoch, m + 1, now.toISOString());
    return 'ok';
  })();
}

/** Marks the drop's live reservation for this epoch as minted. */
export function markMinted(db: Db, dropId: string, epoch: number, now: Date): void {
  db.prepare(
    `UPDATE push_tokens SET minted_at = ? WHERE drop_id = ? AND epoch = ? AND revoked_at IS NULL`,
  ).run(now.toISOString(), dropId, epoch);
}

/** Revokes every unrevoked reservation of the drop, so the next grant is allowed at once. */
export function revokeGrants(db: Db, dropId: string, now: Date): void {
  db.prepare('UPDATE push_tokens SET revoked_at = ? WHERE drop_id = ? AND revoked_at IS NULL').run(
    now.toISOString(),
    dropId,
  );
}

/** Drops in flight plus forge writes not yet settled in the zone. */
export function activeWorkCount(db: Db, zoneId: string): number {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM drops
            WHERE drop_zone_id = @zone AND state IN (${ACTIVE_STATES_SQL})
              -- A queued doctor drop has done nothing yet: it never blocks a mode change.
              AND NOT (role = 'doctor' AND state = 'queued'))
       + (SELECT COUNT(*) FROM outbox o
            WHERE o.zone_id = @zone AND o.state IN ('pending', 'unknown')) AS n`,
    )
    .get({ zone: zoneId }) as { n: number };
  return row.n;
}

/** What a zone still waits for before it is drained, by kind (the sum is `activeWorkCount`). */
export type ZoneWaits = { drops: number; pushes: number; outbox: number };

export function zoneWaits(db: Db, zoneId: string): ZoneWaits {
  return db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM drops
            WHERE drop_zone_id = @zone AND state IN (${ACTIVE_STATES_SQL}) AND state <> 'push_pending'
              AND NOT (role = 'doctor' AND state = 'queued')) AS drops,
         (SELECT COUNT(*) FROM drops
            WHERE drop_zone_id = @zone AND state = 'push_pending') AS pushes,
         (SELECT COUNT(*) FROM outbox o
            WHERE o.zone_id = @zone AND o.state IN ('pending', 'unknown')) AS outbox`,
    )
    .get({ zone: zoneId }) as ZoneWaits;
}

export type ZoneStopping = { since: string; via: 'ui' | 'ctl' };

/**
 * The operator stopped managing the zone: it goes to observe (no new work, no GitHub write) and
 * is marked stopping, so it is removed once drained, whenever that is. A second ask keeps the
 * first one's time and via.
 */
export function markZoneStopping(db: Db, zoneId: string, via: 'ui' | 'ctl', now: Date): void {
  db.prepare(
    `INSERT INTO zone_controls (zone_id, mode, updated_at, stopping_since, stopping_via)
       VALUES (@zone, 'observe', @now, @now, @via)
       ON CONFLICT (zone_id) DO UPDATE SET
         mode = 'observe',
         updated_at = CASE WHEN mode = 'observe' THEN updated_at ELSE excluded.updated_at END,
         stopping_since = COALESCE(stopping_since, excluded.stopping_since),
         stopping_via = COALESCE(stopping_via, excluded.stopping_via)`,
  ).run({ zone: zoneId, now: now.toISOString(), via });
}

/** Withdraws a stop (the operator chose a mode again); the mode stays as it is. */
export function clearZoneStopping(db: Db, zoneId: string): void {
  db.prepare(
    'UPDATE zone_controls SET stopping_since = NULL, stopping_via = NULL WHERE zone_id = ?',
  ).run(zoneId);
}

export function zoneStopping(db: Db, zoneId: string): ZoneStopping | undefined {
  const row = db
    .prepare(
      'SELECT stopping_since AS since, stopping_via AS via FROM zone_controls WHERE zone_id = ? AND stopping_since IS NOT NULL',
    )
    .get(zoneId) as ZoneStopping | undefined;
  return row;
}

/** Every zone marked stopping, oldest ask first. */
export function stoppingZones(db: Db): string[] {
  return (
    db
      .prepare(
        'SELECT zone_id AS id FROM zone_controls WHERE stopping_since IS NOT NULL ORDER BY stopping_since, zone_id',
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

export function zoneIsDrained(db: Db, zoneId: string): boolean {
  return activeWorkCount(db, zoneId) === 0;
}

/**
 * A zone that may be removed: in observe (the stored mode; a zone with no mode row is not known
 * to be), with no drop in flight and no forge write unsettled. The same guard as the move to
 * observe, plus the mode.
 */
export function zoneDrained(db: Db, zoneId: string): boolean {
  const row = db.prepare('SELECT mode FROM zone_controls WHERE zone_id = ?').get(zoneId) as
    | { mode: ZoneMode }
    | undefined;
  return row?.mode === 'observe' && zoneIsDrained(db, zoneId);
}

/** Whether a zone id has a past: work items, drops, outbox rows, crew issues or goals. */
export function zoneHasHistory(db: Db, zoneId: string): boolean {
  const row = db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM work_items WHERE drop_zone_id = @zone)
           OR EXISTS (SELECT 1 FROM drops WHERE drop_zone_id = @zone)
           OR EXISTS (SELECT 1 FROM outbox WHERE zone_id = @zone)
           OR EXISTS (SELECT 1 FROM crew_issues WHERE zone_id = @zone)
           OR EXISTS (SELECT 1 FROM goals WHERE zone_id = @zone) AS h`,
    )
    .get({ zone: zoneId }) as { h: number };
  return row.h === 1;
}

/** What a zone id's history holds, by kind: what Resume brings back. */
export function zoneHistoryCounts(
  db: Db,
  zoneId: string,
): { workItems: number; drops: number; outbox: number; crewIssues: number; goals: number } {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM work_items WHERE drop_zone_id = @zone) AS workItems,
              (SELECT COUNT(*) FROM drops WHERE drop_zone_id = @zone) AS drops,
              (SELECT COUNT(*) FROM outbox WHERE zone_id = @zone) AS outbox,
              (SELECT COUNT(*) FROM crew_issues WHERE zone_id = @zone) AS crewIssues,
              (SELECT COUNT(*) FROM goals WHERE zone_id = @zone) AS goals`,
    )
    .get({ zone: zoneId }) as {
    workItems: number;
    drops: number;
    outbox: number;
    crewIssues: number;
    goals: number;
  };
}

/** The repository a zone id's history was recorded against, when the sync ever saw it. */
export function zoneHistoryRepo(db: Db, zoneId: string): string | undefined {
  const row = db.prepare('SELECT repo FROM drop_zones WHERE id = ?').get(zoneId) as
    | { repo: string }
    | undefined;
  return row?.repo;
}

/** A removed zone loses its mode row only; its history stays. */
export function deleteZoneControls(db: Db, zoneId: string): void {
  db.prepare('DELETE FROM zone_controls WHERE zone_id = ?').run(zoneId);
}

/** Stores the config's starting mode the first time a zone is seen; a stored mode then wins. */
export function ensureZoneMode(db: Db, zoneId: string, mode: ZoneMode, now: Date): void {
  db.prepare(
    `INSERT INTO zone_controls (zone_id, mode, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (zone_id) DO NOTHING`,
  ).run(zoneId, mode, now.toISOString());
}

export type Observation = {
  id: number;
  zoneId: string;
  itemId: number | null;
  action: string;
  detail: string;
  firstAt: string;
  lastAt: string;
  count: number;
};

/** What observe mode would have done. A repeat of the same decision only raises its count. */
export function recordObservation(
  db: Db,
  zoneId: string,
  itemId: number | null,
  action: string,
  detail: string,
  now: Date,
): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO observations (zone_id, item_id, action, detail, first_at, last_at, count)
       VALUES (@zoneId, @itemId, @action, @detail, @at, @at, 1)
       ON CONFLICT (zone_id, COALESCE(item_id, 0), action, detail)
       DO UPDATE SET last_at = @at, count = count + 1`,
  ).run({ zoneId, itemId, action, detail, at });
}

export function listObservations(db: Db, zoneId?: string): Observation[] {
  return db
    .prepare(
      `SELECT id, zone_id AS zoneId, item_id AS itemId, action, detail,
              first_at AS firstAt, last_at AS lastAt, count
         FROM observations WHERE @zoneId IS NULL OR zone_id = @zoneId ORDER BY last_at DESC, id DESC`,
    )
    .all({ zoneId: zoneId ?? null }) as Observation[];
}
