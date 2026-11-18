import { describe, expect, test } from 'vitest';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  listThreads,
  nextQueued,
  setMessage,
  setThreadSession,
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
});
