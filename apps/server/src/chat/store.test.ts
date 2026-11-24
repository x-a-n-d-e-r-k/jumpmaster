import { describe, expect, test } from 'vitest';
import { PENDING_MS } from '../config/confirm.js';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import { listCards, recordCard } from './cards.js';
import {
  appendMessage,
  CHAT_TOOL_RESULT_DAYS,
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  nextQueued,
  pruneChatToolResults,
  renameThread,
  setMessage,
  setThreadSession,
  setToolResult,
} from './store.js';

const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('chat store', () => {
  test('messages get consecutive seq per thread', () => {
    const db = openDb(tmpDbFile());
    const a = createThread(db, { title: 'a' }, t0);
    const b = createThread(db, { title: 'b' }, t0);
    const m1 = appendMessage(db, a.id, { role: 'owner', text: 'one', state: 'queued' }, t0);
    const m2 = appendMessage(db, a.id, { role: 'assistant', text: 'two', state: 'done' }, t0);
    const n1 = appendMessage(db, b.id, { role: 'owner', text: 'other', state: 'queued' }, t0);
    const m3 = appendMessage(db, a.id, { role: 'owner', text: 'three', state: 'queued' }, t0);
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);
    expect(n1.seq).toBe(1);
    expect(listMessages(db, a.id).map((m) => m.text)).toEqual(['one', 'two', 'three']);
    expect(listMessages(db, a.id, 1).map((m) => m.seq)).toEqual([2, 3]);
  });

  test('two appends racing on one thread never share a seq', () => {
    const db = openDb(tmpDbFile());
    const th = createThread(db, { title: 'race' }, t0);
    let rival: ReturnType<typeof appendMessage> | undefined;
    // The rival append runs inside the first append's transaction, right before its INSERT: an
    // implementation that read the next seq earlier would collide on UNIQUE (thread_id, seq).
    const raced = new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!/INSERT INTO chat_messages/i.test(sql)) return stmt;
            const fire = () => {
              if (rival) return;
              rival = appendMessage(db, th.id, { role: 'owner', text: 'B', state: 'queued' }, t0);
            };
            return new Proxy(stmt, {
              get(s, k) {
                const v = Reflect.get(s, k, s);
                if (typeof v !== 'function') return v;
                if (k === 'run' || k === 'get' || k === 'all') {
                  return (...args: unknown[]) => {
                    fire();
                    return (v as (...a: unknown[]) => unknown).apply(s, args);
                  };
                }
                return v.bind(s);
              },
            });
          };
        }
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Db;
    const first = appendMessage(raced, th.id, { role: 'owner', text: 'A', state: 'queued' }, t0);
    expect(rival?.seq).toBe(1);
    expect(first.seq).toBe(2);
    expect(listMessages(db, th.id).map((m) => [m.seq, m.text])).toEqual([
      [1, 'B'],
      [2, 'A'],
    ]);
  });

  test('listThreads is newest-updated first', () => {
    const db = openDb(tmpDbFile());
    const a = createThread(db, { title: 'a' }, at(0));
    const b = createThread(db, { title: 'b' }, at(1));
    const c = createThread(db, { title: 'c' }, at(2));
    expect(listThreads(db).map((t) => t.id)).toEqual([c.id, b.id, a.id]);
    appendMessage(db, a.id, { role: 'owner', text: 'hi', state: 'queued' }, at(3));
    expect(listThreads(db).map((t) => t.id)).toEqual([a.id, c.id, b.id]);
    setThreadSession(db, b.id, 'sess-1', at(4));
    expect(listThreads(db).map((t) => t.id)).toEqual([b.id, a.id, c.id]);
    expect(listThreads(db, 1).map((t) => t.id)).toEqual([b.id]);
  });

  test('a thread keeps its focus and session, and messages their patches', () => {
    const db = openDb(tmpDbFile());
    const th = createThread(
      db,
      { title: 'zone', focus: { kind: 'zone', zoneId: 'main', ref: 'issue:7' } },
      t0,
    );
    expect(getThread(db, th.id)).toEqual({
      id: th.id,
      title: 'zone',
      focusKind: 'zone',
      focusZoneId: 'main',
      focusRef: 'issue:7',
      claudeSessionId: null,
      createdAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
    });
    expect(getThread(db, th.id + 99)).toBeUndefined();
    setThreadSession(db, th.id, 'abc', at(1));
    expect(getThread(db, th.id)?.claudeSessionId).toBe('abc');
    setThreadSession(db, th.id, null, at(2));
    expect(getThread(db, th.id)?.claudeSessionId).toBeNull();

    const m = appendMessage(
      db,
      th.id,
      { role: 'owner', text: 'q', state: 'queued', sessionHash: 'h1' },
      t0,
    );
    const n = appendMessage(db, th.id, { role: 'owner', text: 'r', state: 'queued' }, t0);
    expect(m.sessionHash).toBe('h1');
    expect(n.sessionHash).toBeNull();
    expect(nextQueued(db, th.id)?.id).toBe(m.id);
    setMessage(db, m.id, { state: 'done', usage: { inputTokens: 3 }, text: 'q!' }, at(3));
    expect(nextQueued(db, th.id)?.id).toBe(n.id);
    setMessage(db, n.id, { state: 'failed', error: 'the chat service is down' }, at(3));
    expect(nextQueued(db, th.id)).toBeUndefined();
    const [a, b] = listMessages(db, th.id);
    expect(a).toMatchObject({ state: 'done', text: 'q!', usage: { inputTokens: 3 }, error: null });
    expect(b).toMatchObject({ state: 'failed', error: 'the chat service is down', usage: null });
    expect(getThread(db, th.id)?.updatedAt).toBe(at(3).toISOString());
  });

  describe('pruneChatToolResults (#515)', () => {
    const DAY = 86_400_000;
    const now = new Date('2026-06-01T12:00:00.000Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const result = { text: 'out', truncated: false, lines: 1, isError: false };
    /** A tool step created at `created`, with input and a result. */
    const stepAt = (db: Db, threadId: number, created: Date) => {
      const m = appendMessage(
        db,
        threadId,
        {
          role: 'tool',
          text: `step at ${created.toISOString()}`,
          state: 'done',
          tool: { name: 'Read', useId: 'u', inputJson: '{"file_path":"a.ts"}' },
        },
        created,
      );
      setToolResult(db, m.id, result, created);
      return m;
    };
    const byId = (db: Db, threadId: number, id: number) =>
      listMessages(db, threadId).find((m) => m.id === id);

    test('the window is 30 days', () => {
      expect(CHAT_TOOL_RESULT_DAYS).toBe(30);
    });

    test('a 31-day-old result is pruned, a 29-day-old one kept, each counted once', () => {
      const db = openDb(tmpDbFile());
      const th = createThread(db, { title: 't' }, ago(40 * DAY));
      const old = stepAt(db, th.id, ago(31 * DAY));
      const recent = stepAt(db, th.id, ago(29 * DAY));
      expect(pruneChatToolResults(db, now)).toBe(1);
      const o = byId(db, th.id, old.id);
      expect(o?.result).toBeUndefined();
      expect(o?.resultPrunedAt).toBe(now.toISOString());
      const r = byId(db, th.id, recent.id);
      expect(r?.result).toEqual(result);
      expect(r?.resultPrunedAt).toBeUndefined();
      // Already pruned: not counted again, and its prune time kept.
      expect(pruneChatToolResults(db, new Date(now.getTime() + 1000))).toBe(0);
      expect(byId(db, th.id, old.id)?.resultPrunedAt).toBe(now.toISOString());
    });

    test('inputs, summaries and other messages are untouched', () => {
      const db = openDb(tmpDbFile());
      const th = createThread(db, { title: 't' }, ago(40 * DAY));
      const owner = appendMessage(
        db,
        th.id,
        { role: 'owner', text: 'go', state: 'done' },
        ago(35 * DAY),
      );
      const old = stepAt(db, th.id, ago(31 * DAY));
      const before = listMessages(db, th.id);
      expect(pruneChatToolResults(db, now)).toBe(1);
      const after = listMessages(db, th.id);
      expect(after.find((m) => m.id === owner.id)).toEqual(before.find((m) => m.id === owner.id));
      const o = after.find((m) => m.id === old.id);
      expect(o?.text).toBe(`step at ${ago(31 * DAY).toISOString()}`);
      expect(o?.input).toEqual({ file_path: 'a.ts' });
      expect(o?.toolName).toBe('Read');
      const { result: _r, resultPrunedAt: _p, ...rest } = o ?? ({} as never);
      const { result: _br, ...was } = before.find((m) => m.id === old.id) ?? ({} as never);
      expect(rest).toEqual(was);
    });

    test('boundary: exactly 30 days old is kept, 30 days and 1 second old is pruned', () => {
      const db = openDb(tmpDbFile());
      const th = createThread(db, { title: 't' }, ago(40 * DAY));
      const edge = stepAt(db, th.id, ago(30 * DAY));
      const past = stepAt(db, th.id, ago(30 * DAY + 1000));
      expect(pruneChatToolResults(db, now)).toBe(1);
      expect(byId(db, th.id, edge.id)?.result).toEqual(result);
      expect(byId(db, th.id, past.id)?.result).toBeUndefined();
      expect(byId(db, th.id, past.id)?.resultPrunedAt).toBe(now.toISOString());
    });
  });
});

describe('deleteThread (#833)', () => {
  const seed = (db: Db, title: string, cardState: 'done' | 'pending' = 'done', at = t0) => {
    const th = createThread(db, { title }, at);
    const m = appendMessage(db, th.id, { role: 'owner', text: `hi ${title}`, state: 'done' }, at);
    appendMessage(db, th.id, { role: 'assistant', text: 'ok', state: 'done' }, at);
    recordCard(
      db,
      {
        threadId: th.id,
        messageId: m.id,
        kind: 'queue',
        state: cardState,
        summary: `card of ${title}`,
        ...(cardState === 'pending' ? { link: '/config/confirm/abc' } : {}),
      },
      at,
    );
    return th;
  };
  const count = (db: Db, table: string, id: number) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'chat_threads' ? 'id' : 'thread_id'} = ?`,
        )
        .get(id) as { n: number }
    ).n;

  test('removes the thread, its messages and its cards; other threads are untouched', () => {
    const db = openDb(tmpDbFile());
    const gone = seed(db, 'gone');
    const kept = seed(db, 'kept');
    const keptMessages = listMessages(db, kept.id);
    const keptCards = listCards(db, kept.id);
    expect(deleteThread(db, gone.id, t0)).toBe('deleted');
    for (const table of ['chat_threads', 'chat_messages', 'chat_cards'])
      expect(count(db, table, gone.id), table).toBe(0);
    expect(getThread(db, gone.id)).toBeUndefined();
    expect(getThread(db, kept.id)).toEqual(kept);
    expect(listMessages(db, kept.id)).toEqual(keptMessages);
    expect(listCards(db, kept.id)).toEqual(keptCards);
    expect(deleteThread(db, gone.id, t0)).toBe('unknown');
  });

  test("is refused while busy or a pending card's change has not lapsed; a lapsed one does not block", () => {
    const db = openDb(tmpDbFile());
    const busy = createThread(db, { title: 'busy' }, t0);
    appendMessage(db, busy.id, { role: 'owner', text: 'go', state: 'running' }, t0);
    expect(deleteThread(db, busy.id, t0)).toBe('busy');
    expect(getThread(db, busy.id)).toBeDefined();
    const pending = seed(db, 'pending', 'pending');
    expect(deleteThread(db, pending.id, new Date(t0.getTime() + PENDING_MS - 1))).toBe('pending');
    expect(listCards(db, pending.id)).toHaveLength(1);
    expect(deleteThread(db, pending.id, new Date(t0.getTime() + PENDING_MS))).toBe('deleted');
    expect(getThread(db, pending.id)).toBeUndefined();
  });

  test("another session's thread is unknown to a viewer and kept", () => {
    const db = openDb(tmpDbFile());
    const th = createThread(db, { title: 'mine', owner: 'a' }, t0);
    expect(deleteThread(db, th.id, t0, 'b')).toBe('unknown');
    expect(getThread(db, th.id)).toBeDefined();
    expect(deleteThread(db, th.id, t0, 'a')).toBe('deleted');
  });
});

describe('renameThread (#833)', () => {
  test("sets the title of a visible thread only; another session's is left as it is", () => {
    const db = openDb(tmpDbFile());
    const th = createThread(db, { title: 'old', owner: 'a' }, t0);
    expect(renameThread(db, th.id, 'new', 'b')).toBeUndefined();
    expect(getThread(db, th.id)?.title).toBe('old');
    expect(renameThread(db, th.id, 'new', 'a')?.title).toBe('new');
    expect(renameThread(db, th.id + 1, 'x')).toBeUndefined();
  });
});
