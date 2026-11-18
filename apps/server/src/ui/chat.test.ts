import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode } from '../auth/operator.js';
import { recordCard } from '../chat/cards.js';
import {
  appendMessage,
  createThread,
  listMessages,
  listThreads,
  setMessage,
} from '../chat/store.js';
import type { HubEvent } from '../chat/turns.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { CHAT_MISSING_COMMAND, renderChatList, renderThread } from './chat.js';
import { page } from './pages.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** An install with (or, with `service: false`, without) the chat service. */
function world(o: { service?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-chat-ui-'));
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
  const subscribed: number[] = [];
  const listeners: ((e: HubEvent) => void)[] = [];
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
    ...(o.service === false
      ? {}
      : {
          chatTurns: {
            enqueue: () => {},
            subscribe: (id: number, after: number, fn: (e: HubEvent) => void) => {
              subscribed.push(id);
              for (const message of listMessages(db, id, after)) {
                fn({ seq: message.seq, event: { type: 'message', message } });
              }
              listeners.push(fn);
              return () => listeners.splice(listeners.indexOf(fn), 1);
            },
          },
        }),
  });
  app = a;
  const s = operatorSession(db, t0);
  const session = { host: HOST, ...s.headers };
  const bearer = { host: HOST, authorization: `Bearer ${TOKEN}` };
  return { db, app: a, session, bearer, subscribed, listeners };
}

/** The SSE frames of a body: each event's name, id and data. */
function frames(body: string): { event: string; id: string; data: unknown }[] {
  return body
    .split('\n\n')
    .filter((f) => f.includes('event: '))
    .map((f) => {
      const field = (k: string) =>
        f
          .split('\n')
          .find((l) => l.startsWith(`${k}: `))
          ?.slice(k.length + 2) ?? '';
      return { event: field('event'), id: field('id'), data: JSON.parse(field('data')) };
    });
}

describe('/chat', () => {
  test("every page's top bar links Chat", () => {
    const html = page('x');
    expect(html).toContain('href="/chat"');
    expect(html.indexOf('href="/chat"')).toBeGreaterThan(html.indexOf('href="/briefings"'));
  });

  test('/chat lists threads newest first and offers New thread', async () => {
    const w = world();
    const older = createThread(w.db, { title: 'Older one' }, t0);
    const newer = createThread(w.db, { title: 'Newer <one>' }, plus(t0, 60_000));
    const res = await w.app.inject({ method: 'GET', url: '/chat', headers: w.session });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('New thread');
    expect(html).toContain('Newer &lt;one&gt;');
    expect(html).not.toContain('Newer <one>');
    expect(html.indexOf(`href="/chat/${newer.id}"`)).toBeGreaterThan(-1);
    expect(html.indexOf(`href="/chat/${newer.id}"`)).toBeLessThan(
      html.indexOf(`href="/chat/${older.id}"`),
    );
    expect(html).not.toContain(CHAT_MISSING_COMMAND);
    expect(renderChatList(listThreads(w.db), { serviceMissing: false })).toContain('New thread');
  });

  test('/chat shows the add-the-service command when no chat service is configured', async () => {
    expect(CHAT_MISSING_COMMAND).toContain('compose.yaml');
    expect(CHAT_MISSING_COMMAND).toContain('docker compose up -d');
    const w = world({ service: false });
    const res = await w.app.inject({ method: 'GET', url: '/chat', headers: w.session });
    expect(res.statusCode).toBe(200);
    // The command as the page shows it (escaped like any text).
    expect(res.body).toContain(CHAT_MISSING_COMMAND.replaceAll('&', '&amp;'));
  });

  test('/chat/:id renders owner and assistant text escaped and each tool line as one collapsed line', async () => {
    const w = world();
    const th = createThread(w.db, { title: 'Ask' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: 'Is <b>this</b> safe?', state: 'done' }, t0);
    appendMessage(
      w.db,
      th.id,
      { role: 'tool', text: 'read apps/server/src/goals.ts', state: 'done' },
      t0,
    );
    appendMessage(
      w.db,
      th.id,
      { role: 'assistant', text: 'Yes <script>alert(1)</script> it is', state: 'done' },
      t0,
    );
    const res = await w.app.inject({ method: 'GET', url: `/chat/${th.id}`, headers: w.session });
    expect(res.statusCode).toBe(200);
    for (const html of [res.body, renderThread(th, [])]) expect(html).toContain('Ask');
    const html = res.body;
    expect(html).toContain('Is &lt;b&gt;this&lt;/b&gt; safe?');
    expect(html).toContain('Yes &lt;script&gt;alert(1)&lt;/script&gt; it is');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toMatch(
      /<details class="tool"[^>]*><summary>read apps\/server\/src\/goals\.ts<\/summary><\/details>/,
    );
    const missing = await w.app.inject({
      method: 'GET',
      url: `/chat/${th.id + 1}`,
      headers: w.session,
    });
    expect(missing.statusCode).toBe(404);
  });

  test('reopening a thread replays events after the last seen seq', async () => {
    const w = world({ service: false });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: 'first-owner-line', state: 'done' }, t0);
    appendMessage(w.db, th.id, { role: 'assistant', text: 'second-reply-line', state: 'done' }, t0);
    appendMessage(w.db, th.id, { role: 'tool', text: 'listed issues', state: 'done' }, t0);
    appendMessage(w.db, th.id, { role: 'assistant', text: 'four', state: 'done' }, t0);
    const res = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: { ...w.session, 'last-event-id': '2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const got = frames(res.body);
    expect(got.map((f) => [f.event, f.id])).toEqual([
      ['tool', '3'],
      ['message', '4'],
      ['done', '4'],
    ]);
    expect(got[0]?.data).toMatchObject({ seq: 3, text: 'listed issues' });
    expect(got[1]?.data).toMatchObject({ seq: 4, role: 'assistant', text: 'four' });
    expect(res.body).not.toContain('first-owner-line');
    expect(res.body).not.toContain('second-reply-line');
  });

  test("a running turn's text and messages stream until done", async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const owner = appendMessage(w.db, th.id, { role: 'owner', text: 'hi', state: 'running' }, t0);
    const pending = w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    for (let i = 0; i < 50 && w.listeners.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const emit = (e: HubEvent) => {
      for (const fn of [...w.listeners]) fn(e);
    };
    emit({ seq: 1, event: { type: 'text', text: 'Hello <there>' } });
    const reply = appendMessage(
      w.db,
      th.id,
      { role: 'assistant', text: 'Hello', state: 'done' },
      t0,
    );
    emit({ seq: reply.seq, event: { type: 'message', message: reply } });
    setMessage(w.db, owner.id, { state: 'done' }, t0);
    const [done] = listMessages(w.db, th.id, 0);
    if (done) emit({ seq: done.seq, event: { type: 'message', message: done } });
    const res = await pending;
    expect(frames(res.body).map((f) => [f.event, f.id])).toEqual([
      ['message', '1'],
      ['text', '1'],
      ['message', '2'],
      ['message', '1'],
      ['done', '2'],
    ]);
    expect(frames(res.body)[1]?.data).toEqual({ seq: 1, text: 'Hello <there>' });
    expect(res.body).not.toContain('sessionHash');
    expect(w.listeners).toEqual([]);
  });

  test('/chat/:id renders the stored cards after their message, from the server record, escaped', async () => {
    const w = world();
    const th = createThread(w.db, { title: 'Act' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: 'pause main', state: 'done' }, t0);
    recordCard(
      w.db,
      {
        threadId: th.id,
        messageId: 1,
        kind: 'pause',
        zoneId: 'main',
        link: '/zones/main',
        state: 'done',
        summary: 'Paused zone <main>',
      },
      plus(t0, 1000),
    );
    appendMessage(
      w.db,
      th.id,
      { role: 'assistant', text: 'done-reply', state: 'done' },
      plus(t0, 2000),
    );
    const res = await w.app.inject({ method: 'GET', url: `/chat/${th.id}`, headers: w.session });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Paused zone &lt;main&gt;');
    expect(res.body).toContain('href="/zones/main"');
    const owner = res.body.indexOf('pause main');
    const card = res.body.indexOf('Paused zone &lt;main&gt;');
    expect(owner).toBeLessThan(card);
    expect(card).toBeLessThan(res.body.indexOf('done-reply'));
    // A card on another thread is not this thread's.
    expect(renderThread(th, [], [])).not.toContain('class="msg card');
  });

  test('a card streams as a card event without what Undo needs', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const owner = appendMessage(w.db, th.id, { role: 'owner', text: 'hi', state: 'running' }, t0);
    const pending = w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    for (let i = 0; i < 50 && w.listeners.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const card = recordCard(
      w.db,
      {
        threadId: th.id,
        messageId: owner.id,
        kind: 'queue',
        state: 'done',
        summary: 'Queued #4',
        link: 'javascript:alert(1)',
        undo: { label: 'secret-ish-undo-state' },
      },
      t0,
    );
    for (const fn of [...w.listeners]) fn({ seq: 1, event: { type: 'card', card } });
    setMessage(w.db, owner.id, { state: 'done' }, t0);
    const [done] = listMessages(w.db, th.id, 0);
    for (const fn of [...w.listeners]) {
      if (done) fn({ seq: done.seq, event: { type: 'message', message: done } });
    }
    const res = await pending;
    const got = frames(res.body);
    expect(got.map((f) => f.event)).toEqual(['message', 'card', 'message', 'done']);
    expect(got[1]?.data).toEqual({
      seq: 1,
      card: expect.objectContaining({
        id: card.id,
        kind: 'queue',
        summary: 'Queued #4',
        link: null,
        undoable: true,
      }),
    });
    expect(res.body).not.toContain('secret-ish-undo-state');
  });

  test('the events route is session-only', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const url = `/api/chat/threads/${th.id}/events`;
    const viaToken = await w.app.inject({ method: 'GET', url, headers: w.bearer });
    expect(viaToken.statusCode).toBe(403);
    const none = await w.app.inject({ method: 'GET', url, headers: { host: HOST } });
    expect(none.statusCode).toBe(401);
    const unknown = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id + 1}/events`,
      headers: w.session,
    });
    expect(unknown.statusCode).toBe(404);
    expect(w.subscribed).toEqual([]);
  });
});
