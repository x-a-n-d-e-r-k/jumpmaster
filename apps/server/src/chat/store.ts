import type { Db } from '../db/open.js';

/**
 * The crew chat's threads and messages (#336). A message's `seq` is its place in its thread and is
 * allocated by the INSERT itself, so two appends to one thread never share one.
 */

export type FocusKind = 'zone' | 'goals' | 'briefing';
export type ChatRole = 'owner' | 'assistant' | 'tool' | 'system';
export type ChatMessageState = 'queued' | 'running' | 'done' | 'failed';

export interface ChatThread {
  id: number;
  title: string;
  focusKind: FocusKind | null;
  focusZoneId: string | null;
  focusRef: string | null;
  claudeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  seq: number;
  role: ChatRole;
  text: string;
  state: ChatMessageState;
  /** The SHA-256 of the browser session that posted an owner message; never the session id. */
  sessionHash: string | null;
  usage: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
}

const THREAD_COLS = `id, title, focus_kind AS focusKind, focus_zone_id AS focusZoneId,
  focus_ref AS focusRef, claude_session_id AS claudeSessionId, created_at AS createdAt,
  updated_at AS updatedAt`;

const MESSAGE_COLS = `id, thread_id AS threadId, seq, role, text, state, session_hash AS sessionHash,
  usage_json AS usageJson, error, created_at AS createdAt`;

type MessageRow = Omit<ChatMessage, 'usage'> & { usageJson: string | null };

const messageOf = ({ usageJson, ...r }: MessageRow): ChatMessage => ({
  ...r,
  usage: usageJson === null ? null : (JSON.parse(usageJson) as Record<string, unknown>),
});

export function createThread(
  db: Db,
  o: { title: string; focus?: { kind: FocusKind; zoneId: string; ref: string } },
  now: Date,
): ChatThread {
  const at = now.toISOString();
  return db
    .prepare(
      `INSERT INTO chat_threads (title, focus_kind, focus_zone_id, focus_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING ${THREAD_COLS}`,
    )
    .get(
      o.title,
      o.focus?.kind ?? null,
      o.focus?.zoneId ?? null,
      o.focus?.ref ?? null,
      at,
      at,
    ) as ChatThread;
}

/** The newest-updated threads first. */
export function listThreads(db: Db, limit = 100): ChatThread[] {
  return db
    .prepare(`SELECT ${THREAD_COLS} FROM chat_threads ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(limit) as ChatThread[];
}

export function getThread(db: Db, id: number): ChatThread | undefined {
  return db.prepare(`SELECT ${THREAD_COLS} FROM chat_threads WHERE id = ?`).get(id) as
    | ChatThread
    | undefined;
}

const touch = (db: Db, threadId: number, now: Date) =>
  db
    .prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?')
    .run(now.toISOString(), threadId);

/** Appends a message at the thread's next seq and marks the thread updated. */
export function appendMessage(
  db: Db,
  threadId: number,
  m: {
    role: ChatRole;
    text: string;
    state: ChatMessageState;
    sessionHash?: string;
    usage?: Record<string, unknown>;
  },
  now: Date,
): ChatMessage {
  return db.transaction(() => {
    const row = db
      .prepare(
        `INSERT INTO chat_messages
           (thread_id, seq, role, text, state, session_hash, usage_json, created_at)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE thread_id = ?),
           ?, ?, ?, ?, ?, ?)
         RETURNING ${MESSAGE_COLS}`,
      )
      .get(
        threadId,
        threadId,
        m.role,
        m.text,
        m.state,
        m.sessionHash ?? null,
        m.usage === undefined ? null : JSON.stringify(m.usage),
        now.toISOString(),
      ) as MessageRow;
    touch(db, threadId, now);
    return messageOf(row);
  })();
}

/** Changes a message's state, usage, error or text, and marks its thread updated. */
export function setMessage(
  db: Db,
  id: number,
  patch: Partial<Pick<ChatMessage, 'state' | 'usage' | 'error' | 'text'>>,
  now: Date,
): void {
  const cols: [string, unknown][] = [];
  if (patch.state !== undefined) cols.push(['state', patch.state]);
  if (patch.text !== undefined) cols.push(['text', patch.text]);
  if (patch.error !== undefined) cols.push(['error', patch.error]);
  if (patch.usage !== undefined) {
    cols.push(['usage_json', patch.usage === null ? null : JSON.stringify(patch.usage)]);
  }
  const sets = cols.map(([c]) => `${c} = ?`);
  const args = cols.map(([, v]) => v);
  if (sets.length === 0) return;
  db.transaction(() => {
    const row = db
      .prepare(`UPDATE chat_messages SET ${sets.join(', ')} WHERE id = ? RETURNING thread_id AS t`)
      .get(...args, id) as { t: number } | undefined;
    if (row) touch(db, row.t, now);
  })();
}

/** A thread's messages after `afterSeq`, in order. */
export function listMessages(db: Db, threadId: number, afterSeq = 0): ChatMessage[] {
  return (
    db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE thread_id = ? AND seq > ? ORDER BY seq`,
      )
      .all(threadId, afterSeq) as MessageRow[]
  ).map(messageOf);
}

/** Records (or clears) the Claude session a thread resumes. */
export function setThreadSession(db: Db, id: number, sessionId: string | null, now: Date): void {
  db.prepare('UPDATE chat_threads SET claude_session_id = ?, updated_at = ? WHERE id = ?').run(
    sessionId,
    now.toISOString(),
    id,
  );
}

/** The thread's oldest queued message: the next turn to run. */
export function nextQueued(db: Db, threadId: number): ChatMessage | undefined {
  const row = db
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE thread_id = ? AND state = 'queued'
       ORDER BY seq LIMIT 1`,
    )
    .get(threadId) as MessageRow | undefined;
  return row ? messageOf(row) : undefined;
}

/** Whether a turn of the thread is waiting or running. */
export function threadBusy(db: Db, threadId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM chat_messages WHERE thread_id = ? AND state IN ('queued', 'running') LIMIT 1`,
      )
      .get(threadId) !== undefined
  );
}
