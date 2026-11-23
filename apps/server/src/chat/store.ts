import type { Db } from '../db/open.js';

/**
 * The crew chat's threads and messages (#336). A message's `seq` is its place in its thread and is
 * allocated by the INSERT itself, so two appends to one thread never share one.
 */

/**
 * What a focused thread is about: `ref` is the zone id (`zone`, `goals`), the briefing id, the
 * drop id, or the doctor check id (its zone in `zoneId`, or `install` for an install-wide check).
 */
export type FocusKind = 'zone' | 'goals' | 'briefing' | 'drop' | 'doctor';
/** The focus kinds whose thread belongs to the session that opened it (#627). */
export const SESSION_BOUND_FOCUS: readonly FocusKind[] = ['drop', 'doctor'];
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
  /** A tool step's tool; absent on a step from an older chat image and on other roles. */
  toolName?: string;
  /** A tool step's input as stored, redacted; absent when the step has none. */
  input?: Record<string, unknown>;
  /** A tool step's result, redacted and capped; absent until one arrives. */
  result?: ToolStepResult;
  /** When a tool step's result was pruned (#515); absent while it is kept. */
  resultPrunedAt?: string;
}

/** What a tool step gave back, as stored (#502). */
export interface ToolStepResult {
  text: string;
  /** Whether the chat service or the server cut it. */
  truncated: boolean;
  /** Lines in the uncut result. */
  lines: number;
  isError: boolean;
}

const THREAD_COLS = `id, title, focus_kind AS focusKind, focus_zone_id AS focusZoneId,
  focus_ref AS focusRef, claude_session_id AS claudeSessionId, created_at AS createdAt,
  updated_at AS updatedAt`;

const MESSAGE_COLS = `id, thread_id AS threadId, seq, role, text, state, session_hash AS sessionHash,
  usage_json AS usageJson, error, created_at AS createdAt, tool_name AS toolName,
  input_json AS inputJson, result_text AS resultText, result_truncated AS resultTruncated,
  result_lines AS resultLines, result_error AS resultError, result_pruned_at AS resultPrunedAt`;

type MessageRow = Omit<
  ChatMessage,
  'usage' | 'toolName' | 'input' | 'result' | 'resultPrunedAt'
> & {
  usageJson: string | null;
  toolName: string | null;
  inputJson: string | null;
  resultText: string | null;
  resultTruncated: number | null;
  resultLines: number | null;
  resultError: number | null;
  resultPrunedAt: string | null;
};

/** A stored input's JSON as an object; a value that is not one is kept as its text. */
function inputOf(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === 'object' && v !== null && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // Not JSON: kept as text below.
  }
  return { _unparsed: json };
}

const messageOf = ({
  usageJson,
  toolName,
  inputJson,
  resultText,
  resultTruncated,
  resultLines,
  resultError,
  resultPrunedAt,
  ...r
}: MessageRow): ChatMessage => ({
  ...r,
  usage: usageJson === null ? null : (JSON.parse(usageJson) as Record<string, unknown>),
  // Only the fields a row has, so a message stored as before reads as before.
  ...(toolName === null ? {} : { toolName }),
  ...(inputJson === null ? {} : { input: inputOf(inputJson) }),
  ...(resultText === null
    ? {}
    : {
        result: {
          text: resultText,
          truncated: resultTruncated === 1,
          lines: resultLines ?? 0,
          isError: resultError === 1,
        },
      }),
  ...(resultPrunedAt === null ? {} : { resultPrunedAt }),
});

/**
 * A new thread. `owner` is the hash of the browser session it belongs to: another session's
 * reads (with a `viewer`) never see it. Without one the thread is shared.
 */
export function createThread(
  db: Db,
  o: { title: string; focus?: { kind: FocusKind; zoneId: string; ref: string }; owner?: string },
  now: Date,
): ChatThread {
  const at = now.toISOString();
  return db
    .prepare(
      `INSERT INTO chat_threads (title, focus_kind, focus_zone_id, focus_ref, created_at, updated_at,
         owner_session)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${THREAD_COLS}`,
    )
    .get(
      o.title,
      o.focus?.kind ?? null,
      o.focus?.zoneId ?? null,
      o.focus?.ref ?? null,
      at,
      at,
      o.owner ?? null,
    ) as ChatThread;
}

/** A shared thread, or one the viewing session owns; every thread when there is no viewer. */
const VISIBLE = '(? IS NULL OR owner_session IS NULL OR owner_session = ?)';

/** The newest-updated threads first; with a `viewer` (a session hash), only those it may see. */
export function listThreads(db: Db, limit = 100, viewer?: string): ChatThread[] {
  const v = viewer ?? null;
  return db
    .prepare(
      `SELECT ${THREAD_COLS} FROM chat_threads WHERE ${VISIBLE}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(v, v, limit) as ChatThread[];
}

/** The thread; with a `viewer` (a session hash), undefined when it belongs to another session. */
export function getThread(db: Db, id: number, viewer?: string): ChatThread | undefined {
  const v = viewer ?? null;
  return db
    .prepare(`SELECT ${THREAD_COLS} FROM chat_threads WHERE id = ? AND ${VISIBLE}`)
    .get(id, v, v) as ChatThread | undefined;
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
    /** A tool step's tool, `tool_use` id and input JSON, each already redacted. */
    tool?: { name: string; useId?: string; inputJson?: string };
  },
  now: Date,
): ChatMessage {
  return db.transaction(() => {
    const row = db
      .prepare(
        `INSERT INTO chat_messages
           (thread_id, seq, role, text, state, session_hash, usage_json, created_at, tool_name,
            tool_use_id, input_json)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE thread_id = ?),
           ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        m.tool?.name ?? null,
        m.tool?.useId ?? null,
        m.tool?.inputJson ?? null,
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

/**
 * The latest tool message of the thread after `afterSeq` (the turn's owner message) with this
 * `tool_use` id: a step of the running turn, never one of an earlier turn.
 */
export function turnToolMessage(
  db: Db,
  threadId: number,
  afterSeq: number,
  toolUseId: string,
): ChatMessage | undefined {
  const row = db
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE thread_id = ? AND seq > ? AND role = 'tool'
         AND tool_use_id = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(threadId, afterSeq, toolUseId) as MessageRow | undefined;
  return row ? messageOf(row) : undefined;
}

/** Stores a tool step's result, already redacted and capped, and marks its thread updated. */
export function setToolResult(db: Db, id: number, r: ToolStepResult, now: Date): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE chat_messages SET result_text = ?, result_truncated = ?, result_lines = ?,
           result_error = ? WHERE id = ? RETURNING thread_id AS t`,
      )
      .get(r.text, r.truncated ? 1 : 0, r.lines, r.isError ? 1 : 0, id) as
      | { t: number }
      | undefined;
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

/**
 * The tool steps at or before `uptoSeq` that have a stored result, of the turn a browser that saw
 * up to `uptoSeq` was following: those after the last assistant or system message it saw (#583).
 * A result is stored on its step's row under the step's seq, so a stream that starts after that
 * seq would never send it.
 */
export function resultStepsUpTo(db: Db, threadId: number, uptoSeq: number): ChatMessage[] {
  if (uptoSeq <= 0) return [];
  return (
    db
      .prepare(
        `SELECT ${MESSAGE_COLS} FROM chat_messages WHERE thread_id = ? AND role = 'tool'
           AND result_text IS NOT NULL AND seq <= ?
           AND seq > (SELECT COALESCE(MAX(seq), 0) FROM chat_messages WHERE thread_id = ?
             AND seq <= ? AND role IN ('assistant', 'system'))
         ORDER BY seq`,
      )
      .all(threadId, uptoSeq, threadId, uptoSeq) as MessageRow[]
  ).map(messageOf);
}

/** Sets the thread's title and marks it updated. The caller titles a thread once (#492). */
export function setThreadTitle(db: Db, id: number, title: string, now: Date): void {
  db.prepare('UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?').run(
    title,
    now.toISOString(),
    id,
  );
}

/** Whether the thread has an owner message. */
export function hasOwnerMessage(db: Db, threadId: number): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM chat_messages WHERE thread_id = ? AND role = 'owner' LIMIT 1`)
      .get(threadId) !== undefined
  );
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

/** How long a tool step's stored result is kept (#515). Inputs, summaries and messages stay. */
export const CHAT_TOOL_RESULT_DAYS = 30;

/**
 * Drops the result of each tool step created more than `CHAT_TOOL_RESULT_DAYS` before `now`,
 * recording when. Returns how many were pruned; a step pruned already is not counted again.
 */
export function pruneChatToolResults(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - CHAT_TOOL_RESULT_DAYS * 86_400_000).toISOString();
  return db
    .prepare(
      `UPDATE chat_messages SET result_text = NULL, result_pruned_at = ?
       WHERE role = 'tool' AND result_text IS NOT NULL AND created_at < ?`,
    )
    .run(now.toISOString(), cutoff).changes;
}
