import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { appendMessage, createThread, listMessages } from './store.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function world() {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-chat-'));
  const env = {
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
  };
  const filePath = join(dir, 'jumpmaster.config.json');
  const store = ConfigStore.open({
    db,
    boot: loadBoot({ ...env, JM_DATA_DIR: dir }, filePath),
    filePath,
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const enqueued: number[] = [];
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no forge');
    },
    now: () => t0,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    chatTurns: { enqueue: (id) => enqueued.push(id) },
  });
  app = a;
  const s = operatorSession(db, t0);
  const session = { host: HOST, ...s.headers };
  const bearer = { host: HOST, authorization: `Bearer ${TOKEN}` };
  return { db, app: a, s, session, bearer, enqueued };
}

describe('/api/chat', () => {
  test('/api/chat routes refuse the Bearer operator token with 403 and a missing session with 401', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const calls = [
      { method: 'GET' as const, url: '/api/chat/threads' },
      { method: 'POST' as const, url: '/api/chat/threads', payload: { title: 'x' } },
      { method: 'GET' as const, url: `/api/chat/threads/${th.id}` },
      {
        method: 'POST' as const,
        url: `/api/chat/threads/${th.id}/messages`,
        payload: { text: 'hi' },
      },
    ];
    for (const c of calls) {
      const viaToken = await w.app.inject({ ...c, headers: w.bearer });
      expect(viaToken.statusCode, `${c.method} ${c.url}`).toBe(403);
      const none = await w.app.inject({ ...c, headers: { host: HOST } });
      expect(none.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
    expect(listMessages(w.db, th.id)).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });

  test('a POST without x-jm-csrf is 403', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const headers = { host: HOST, cookie: w.s.cookie };
    const made = await w.app.inject({
      method: 'POST',
      url: '/api/chat/threads',
      headers,
      payload: { title: 'x' },
    });
    expect(made.statusCode).toBe(403);
    const posted = await w.app.inject({
      method: 'POST',
      url: `/api/chat/threads/${th.id}/messages`,
      headers,
      payload: { text: 'hi' },
    });
    expect(posted.statusCode).toBe(403);
    expect(listMessages(w.db, th.id)).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });

  test("an owner message stores the posting session's hash", async () => {
    const w = world();
    const made = await w.app.inject({
      method: 'POST',
      url: '/api/chat/threads',
      headers: w.session,
      payload: { title: 'About the backlog' },
    });
    expect(made.statusCode).toBe(200);
    const { thread } = made.json() as { thread: { id: number; title: string } };
    expect(thread.title).toBe('About the backlog');
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/chat/threads/${thread.id}/messages`,
      headers: w.session,
      payload: { text: 'What is next?' },
    });
    expect(res.statusCode).toBe(202);
    const { message } = res.json() as { message: Record<string, unknown> };
    const hash = createHash('sha256').update(w.s.id).digest('hex');
    expect(message).toMatchObject({
      threadId: thread.id,
      seq: 1,
      role: 'owner',
      text: 'What is next?',
      state: 'queued',
      sessionHash: hash,
    });
    expect(listMessages(w.db, thread.id)[0]?.sessionHash).toBe(hash);
    expect(JSON.stringify(listMessages(w.db, thread.id))).not.toContain(w.s.id);
    expect(w.enqueued).toEqual([thread.id]);

    const got = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${thread.id}`,
      headers: w.session,
    });
    expect(got.statusCode).toBe(200);
    const body = got.json() as { thread: { id: number }; messages: { text: string }[] };
    expect(body.thread.id).toBe(thread.id);
    expect(body.messages.map((m) => m.text)).toEqual(['What is next?']);
    const list = await w.app.inject({
      method: 'GET',
      url: '/api/chat/threads',
      headers: w.session,
    });
    expect((list.json() as { threads: { id: number }[] }).threads.map((t) => t.id)).toEqual([
      thread.id,
    ]);
  });

  test('an empty or over-long message is 400', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    for (const payload of [{ text: '' }, { text: 'x'.repeat(20_001) }, {}, { text: 7 }]) {
      const res = await w.app.inject({
        method: 'POST',
        url: `/api/chat/threads/${th.id}/messages`,
        headers: w.session,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
    }
    const max = await w.app.inject({
      method: 'POST',
      url: `/api/chat/threads/${th.id}/messages`,
      headers: w.session,
      payload: { text: 'x'.repeat(20_000) },
    });
    expect(max.statusCode).toBe(202);
    expect(listMessages(w.db, th.id)).toHaveLength(1);
    expect(w.enqueued).toEqual([th.id]);
  });

  test('an unknown thread is 404', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: 'x', state: 'done' }, t0);
    for (const id of [String(th.id + 1), 'nope', '0']) {
      const got = await w.app.inject({
        method: 'GET',
        url: `/api/chat/threads/${id}`,
        headers: w.session,
      });
      expect(got.statusCode, id).toBe(404);
      const posted = await w.app.inject({
        method: 'POST',
        url: `/api/chat/threads/${id}/messages`,
        headers: w.session,
        payload: { text: 'hi' },
      });
      expect(posted.statusCode, id).toBe(404);
    }
    expect(w.enqueued).toEqual([]);
  });
});
