import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { registerGuard } from '../auth/guard.js';
import { SetupMode } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import type { Config } from '../config.js';
import { openDb } from '../db/open.js';
import { setZoneMode } from '../db/repo.js';
import { usageCfg, zoneWorld } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { listCards, recordCard } from './cards.js';
import { registerChatRoutes, titleFromMessage } from './routes.js';
import {
  appendMessage,
  createThread,
  getThread,
  listMessages,
  setMessage,
  setToolResult,
} from './store.js';
import { ChatTurns, chatMcpUrl, type HubEvent } from './turns.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function world(o: { chatTurns?: Parameters<typeof createApp>[0]['chatTurns'] } = {}) {
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
    chatTurns: o.chatTurns ?? { enqueue: (id) => enqueued.push(id) },
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

/** A zone on a fake forge, its issue 1 queued by a chat card with Undo. */
function undoWorld() {
  const z = zoneWorld();
  const config = {
    listen: { host: '127.0.0.1', port: 7420 },
    dataDir: '.',
    pollSeconds: 60,
    dropZones: [z.zone],
    claude: { plan: 'max', fableModel: 'fable-x', fableWeeklyDropCap: 5 },
    usage: usageCfg,
    secrets: { operatorToken: TOKEN, joinToken: 'join-secret-value-4' },
  } as Config;
  const a = Fastify();
  registerGuard(a, { db: z.db, config, now: () => t0 });
  registerChatRoutes(a, { db: z.db, config, now: () => t0, forgesFor: () => z.forges });
  app = a;
  const th = createThread(z.db, { title: 't' }, t0);
  const card = recordCard(
    z.db,
    {
      threadId: th.id,
      messageId: 1,
      kind: 'queue',
      zoneId: 'main',
      target: 'issue:1',
      state: 'done',
      summary: 'Put agent-ready on issue #1.',
      undo: { op: 'labels', number: 1, label: 'agent-ready' },
    },
    t0,
  );
  const s = operatorSession(z.db, t0);
  const undo = (headers: Record<string, string>, id: number | string = card.id) =>
    a.inject({ method: 'POST', url: `/api/chat/cards/${id}/undo`, headers, payload: {} });
  const setLabelWrites = () => z.f.author.calls.filter((c) => c.method === 'setLabels').length;
  return {
    ...z,
    th,
    card,
    undo,
    setLabelWrites,
    session: { host: HOST, ...s.headers },
    bearer: { host: HOST, authorization: `Bearer ${TOKEN}` },
  };
}

describe('POST /api/chat/cards/:id/undo', () => {
  test('D1 undo needs the browser session (403 for the Bearer token)', async () => {
    const w = undoWorld();
    const viaToken = await w.undo(w.bearer);
    expect(viaToken.statusCode).toBe(403);
    expect((await w.undo({ host: HOST })).statusCode).toBe(401);
    expect(w.setLabelWrites()).toBe(0);
    expect(listCards(w.db, w.th.id)[0]?.state).toBe('done');
    const ok = await w.undo(w.session);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ card: { id: w.card.id, state: 'undone', undoable: false } });
    expect(ok.json().card.undo).toBeUndefined();
    expect(w.f.state.issues.get(1)?.labels).toEqual([]);
  });

  test('a card already undone is 409', async () => {
    const w = undoWorld();
    expect((await w.undo(w.session)).statusCode).toBe(200);
    const again = await w.undo(w.session);
    expect(again.statusCode).toBe(409);
    expect(w.setLabelWrites()).toBe(1);
    expect((await w.undo(w.session, w.card.id + 1)).statusCode).toBe(404);
    expect((await w.undo(w.session, 'nope')).statusCode).toBe(404);
  });

  test('D3 two Undo presses on one card make one forge write', async () => {
    const w = undoWorld();
    const [a, b] = await Promise.all([w.undo(w.session), w.undo(w.session)]);
    expect([a?.statusCode, b?.statusCode].sort()).toEqual([200, 409]);
    expect(w.setLabelWrites()).toBe(1);
    const rows = w.db.prepare('SELECT op_key AS opKey FROM outbox').all() as { opKey: string }[];
    expect(rows).toEqual([{ opKey: `labels:main:undo:${w.card.id}` }]);
  });

  test('D2 undo in observe mode refuses with no outbox row', async () => {
    const w = undoWorld();
    setZoneMode(w.db, 'main', 'observe', t0);
    const res = await w.undo(w.session);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/observe/);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    expect(w.setLabelWrites()).toBe(0);
    expect(listCards(w.db, w.th.id)[0]?.state).toBe('done');
  });
});

describe('a thread titled from its first message', () => {
  const post = (w: ReturnType<typeof world>, id: number, text: string) =>
    w.app.inject({
      method: 'POST',
      url: `/api/chat/threads/${id}/messages`,
      headers: w.session,
      payload: { text },
    });
  const newThread = async (w: ReturnType<typeof world>) => {
    const made = await w.app.inject({
      method: 'POST',
      url: '/api/chat/threads',
      headers: w.session,
      payload: {},
    });
    const { thread } = made.json() as { thread: { id: number; title: string } };
    expect(thread.title).toBe('New chat');
    return thread.id;
  };

  test('the first message sets the title, cut at a word boundary; a second does not change it', async () => {
    const w = world();
    const id = await newThread(w);
    const first = await post(
      w,
      id,
      '  can you   clean up the Doctor records? A bunch are set as failed on Merlin',
    );
    expect(first.statusCode).toBe(202);
    const title = getThread(w.db, id)?.title;
    expect(title).toBe('can you clean up the Doctor records? A bunch are set as…');
    expect(title?.length).toBeLessThanOrEqual(60);
    expect((await post(w, id, 'Something else entirely')).statusCode).toBe(202);
    expect(getThread(w.db, id)?.title).toBe(
      'can you clean up the Doctor records? A bunch are set as…',
    );
  });

  test('a short first message is the title as is, without heading markers', async () => {
    const w = world();
    const id = await newThread(w);
    await post(w, id, '## What\n is   next?');
    expect(getThread(w.db, id)?.title).toBe('What is next?');
  });

  test('a leading issue reference keeps its #', async () => {
    const w = world();
    const id = await newThread(w);
    await post(w, id, '#105 is stuck in review, why?');
    expect(getThread(w.db, id)?.title).toBe('#105 is stuck in review, why?');
  });

  test('a title is never cut inside a character', () => {
    const title = titleFromMessage('\u{1F600}'.repeat(40));
    expect(title.isWellFormed()).toBe(true);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  test('a thread created with a focus keeps its focus title after a message', async () => {
    const w = world();
    const th = createThread(
      w.db,
      { title: 'Zone main', focus: { kind: 'zone', zoneId: 'main', ref: 'main' } },
      t0,
    );
    expect((await post(w, th.id, 'What is next?')).statusCode).toBe(202);
    expect(getThread(w.db, th.id)?.title).toBe('Zone main');
  });

  test('a thread with an explicit title keeps it', async () => {
    const w = world();
    const th = createThread(w.db, { title: 'About the backlog' }, t0);
    await post(w, th.id, 'What is next?');
    expect(getThread(w.db, th.id)?.title).toBe('About the backlog');
  });

  test('a first message of only "## " leaves "New chat"', async () => {
    const w = world();
    const id = await newThread(w);
    expect((await post(w, id, '## ')).statusCode).toBe(202);
    expect(getThread(w.db, id)?.title).toBe('New chat');
  });

  test('a thread whose earlier owner message did not title it is not titled later', async () => {
    const w = world();
    const id = await newThread(w);
    await post(w, id, '## ');
    await post(w, id, 'A real question');
    expect(getThread(w.db, id)?.title).toBe('New chat');
  });
});

describe('tool steps (#502)', () => {
  /** The SSE events a replayed stream sends, by name. */
  const sseEvents = (body: string) =>
    body
      .split('\n\n')
      .map((block) => ({
        event: /^event: (.*)$/m.exec(block)?.[1],
        data: /^data: (.*)$/m.exec(block)?.[1],
      }))
      .filter((e) => e.event !== undefined)
      .map((e) => ({
        event: e.event,
        data: JSON.parse(e.data ?? 'null') as Record<string, unknown>,
      }));

  test('D5: one secret is redacted alike in the stored input and result, the hub, the SSE tool event and GET', async () => {
    const w = world();
    // Configured, and not token-shaped: only redaction by value catches it.
    const SECRET = 'join-secret-value-4';
    const config = {
      listen: { host: '0.0.0.0', port: 7420 },
      dataDir: '/data',
      pollSeconds: 60,
      dropZones: [],
      usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
      claude: { plan: 'max', fableWeeklyDropCap: 0 },
      chat: {},
      secrets: {
        claudeToken: ['sk', 'ant', 'oat01', 'ROUTESCLAUDETOKEN0123456789'].join('-'),
        githubAuthorToken: ['github', 'pat', 'ROUTESAUTHORAUTHOR999999'].join('_'),
        joinToken: SECRET,
        operatorToken: TOKEN,
      },
    } as unknown as Config;
    const turns = new ChatTurns({
      db: w.db,
      config,
      now: () => t0,
      service: {
        async *runTurn() {
          yield {
            type: 'tool',
            name: 'Grep',
            summary: 'grep',
            id: 't1',
            input: { pattern: SECRET },
          };
          yield {
            type: 'tool_result',
            id: 't1',
            text: `hit: ${SECRET}`,
            truncated: false,
            totalLines: 1,
            isError: false,
          };
          yield { type: 'result', isError: false };
        },
        health: async () => null,
      },
      mcpUrl: chatMcpUrl(7420),
      resolvedApps: () => new Map(),
      log: () => {},
    });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(
      w.db,
      th.id,
      { role: 'owner', text: 'find it', state: 'queued', sessionHash: 'h' },
      t0,
    );
    const hub: HubEvent[] = [];
    turns.subscribe(th.id, 0, (e) => hub.push(e));
    turns.enqueue(th.id);
    await turns.idle();

    const want = {
      toolName: 'Grep',
      input: { pattern: '[REDACTED]' },
      result: { text: 'hit: [REDACTED]', truncated: false, lines: 1, isError: false },
    };
    const stored = listMessages(w.db, th.id).find((m) => m.role === 'tool');
    expect(stored).toMatchObject(want);
    const streamed = hub
      .map((e) => e.event)
      .filter((e) => e.type === 'message' && e.message.role === 'tool');
    expect(streamed.at(-1)).toMatchObject({ type: 'message', message: want });

    const got = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}`,
      headers: w.session,
    });
    const messages = (got.json() as { messages: Record<string, unknown>[] }).messages;
    expect(messages.find((m) => m.role === 'tool')).toMatchObject(want);

    const sse = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    const tool = sseEvents(sse.body).find((e) => e.event === 'tool');
    expect(tool?.data).toEqual({
      seq: stored?.seq,
      text: 'grep',
      createdAt: stored?.createdAt,
      ...want,
    });
    for (const body of [JSON.stringify(stored), JSON.stringify(hub), got.body, sse.body]) {
      expect(body).not.toContain(SECRET);
    }
  });

  test('#575: a truncated input carries no prefix of a secret in the hub, the SSE tool event or GET', async () => {
    const w = world();
    const SECRET = 'join-NOTSHAPED-routes-0123456789';
    const config = {
      listen: { host: '0.0.0.0', port: 7420 },
      dataDir: '/data',
      pollSeconds: 60,
      dropZones: [],
      usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
      claude: { plan: 'max', fableWeeklyDropCap: 0 },
      chat: {},
      secrets: {
        claudeToken: ['sk', 'ant', 'oat01', 'ROUTESCLAUDETOKEN0123456789'].join('-'),
        joinToken: SECRET,
        operatorToken: TOKEN,
      },
    } as unknown as Config;
    // As the chat service cuts a long input: its JSON's first 4096 characters.
    const preview = JSON.stringify({ command: 'x'.repeat(4070) + SECRET }).slice(0, 4096);
    expect(preview.endsWith(SECRET.slice(0, 14))).toBe(true);
    const turns = new ChatTurns({
      db: w.db,
      config,
      now: () => t0,
      service: {
        async *runTurn() {
          yield {
            type: 'tool',
            name: 'Bash',
            summary: 'bash',
            id: 't1',
            input: { _truncated: true, preview },
          };
          yield { type: 'result', isError: false };
        },
        health: async () => null,
      },
      mcpUrl: chatMcpUrl(7420),
      resolvedApps: () => new Map(),
      log: () => {},
    });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(
      w.db,
      th.id,
      { role: 'owner', text: 'go', state: 'queued', sessionHash: 'h' },
      t0,
    );
    const hub: HubEvent[] = [];
    turns.subscribe(th.id, 0, (e) => hub.push(e));
    turns.enqueue(th.id);
    await turns.idle();

    const want = { input: { _truncated: true, preview: preview.slice(0, -14) } };
    const stored = listMessages(w.db, th.id).find((m) => m.role === 'tool');
    expect(stored).toMatchObject(want);
    const got = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}`,
      headers: w.session,
    });
    const messages = (got.json() as { messages: Record<string, unknown>[] }).messages;
    expect(messages.find((m) => m.role === 'tool')).toMatchObject(want);
    const sse = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    expect(sseEvents(sse.body).find((e) => e.event === 'tool')?.data).toMatchObject(want);
    for (const body of [JSON.stringify(hub), got.body, sse.body]) {
      for (let k = 8; k <= SECRET.length; k++) expect(body).not.toContain(SECRET.slice(0, k));
    }
  });

  /**
   * #583: an earlier turn (owner, step with result, reply), then a turn whose step 5 got its
   * result while no browser was subscribed, an older step 6 with no input or result, and a step 7
   * with no result at all.
   */
  function missedResult(w: ReturnType<typeof world>) {
    const th = createThread(w.db, { title: 't' }, t0);
    const add = (m: Parameters<typeof appendMessage>[2]) => appendMessage(w.db, th.id, m, t0);
    const r = (text: string) => ({ text, truncated: false, lines: 1, isError: false });
    add({ role: 'owner', text: 'first', state: 'done', sessionHash: 'h' });
    const early = add({
      role: 'tool',
      text: 'read e.ts',
      state: 'done',
      tool: { name: 'Read', useId: 'tu_0', inputJson: '{"file_path":"e.ts"}' },
    });
    setToolResult(w.db, early.id, r('early'), t0);
    add({ role: 'assistant', text: 'ok', state: 'done' });
    const owner = add({ role: 'owner', text: 'again', state: 'running', sessionHash: 'h' });
    const step = add({
      role: 'tool',
      text: 'read a.ts',
      state: 'done',
      tool: { name: 'Read', useId: 'tu_1', inputJson: '{"file_path":"a.ts"}' },
    });
    const old = add({ role: 'tool', text: 'old step', state: 'done' });
    const none = add({
      role: 'tool',
      text: 'read b.ts',
      state: 'done',
      tool: { name: 'Read', useId: 'tu_2', inputJson: '{"file_path":"b.ts"}' },
    });
    // The result lands while no browser is subscribed.
    setToolResult(w.db, step.id, r('one'), t0);
    return { th, owner, early, step, old, none };
  }

  for (const how of ['last-event-id', 'after'] as const) {
    test(`#583: a stream opened with ${how} past a step gets the result stored since, before done`, async () => {
      const w = world();
      const { th, step, none } = missedResult(w);
      for (const seen of [step.seq, none.seq]) {
        const res = await w.app.inject({
          method: 'GET',
          url: `/api/chat/threads/${th.id}/events${how === 'after' ? `?after=${seen}` : ''}`,
          headers: {
            ...w.session,
            ...(how === 'last-event-id' ? { 'last-event-id': String(seen) } : {}),
          },
        });
        expect(res.body).toMatch(new RegExp(`event: tool\nid: ${step.seq}\ndata: [^\n]*"result"`));
        const events = sseEvents(res.body);
        const tools = events.filter((e) => e.event === 'tool');
        // The result's step, re-sent; then only what follows the seq the browser saw.
        expect(tools.map((e) => e.data.seq)).toEqual(
          seen === step.seq ? [step.seq, step.seq + 1, none.seq] : [step.seq],
        );
        expect(tools[0]?.data).toEqual({
          seq: step.seq,
          text: 'read a.ts',
          createdAt: step.createdAt,
          toolName: 'Read',
          input: { file_path: 'a.ts' },
          result: { text: 'one', truncated: false, lines: 1, isError: false },
        });
        const done = events.findIndex((e) => e.event === 'done');
        expect(done).toBe(events.length - 1);
        expect(events[done]?.data).toEqual({ seq: none.seq });
      }
    });
  }

  test('#583: a subscribed reconnect gets the result too; earlier turns and older steps are not re-sent', async () => {
    const turnsDb: { db?: ReturnType<typeof world>['db'] } = {};
    const w = world({
      chatTurns: {
        enqueue: () => {},
        subscribe: (id, after, fn) => {
          for (const message of listMessages(turnsDb.db as never, id, after))
            fn({ seq: message.seq, event: { type: 'message', message } });
          return () => {};
        },
      },
    });
    turnsDb.db = w.db;
    const { th, owner, early, step, old, none } = missedResult(w);
    // The turn ended while the browser was away.
    setMessage(w.db, owner.id, { state: 'done' }, t0);
    const res = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: { ...w.session, 'last-event-id': String(none.seq) },
    });
    const events = sseEvents(res.body);
    expect(events.map((e) => [e.event, e.data.seq])).toEqual([
      ['tool', step.seq],
      ['done', none.seq],
    ]);
    for (const m of [early, old, none])
      expect(events.some((e) => e.data.seq === m.seq)).toBe(m === none);
  });

  test('#583: a result re-sent to a reconnect arrives redacted, as its first send', async () => {
    const w = world();
    const SECRET = 'join-secret-value-4';
    const config = {
      listen: { host: '0.0.0.0', port: 7420 },
      dataDir: '/data',
      pollSeconds: 60,
      dropZones: [],
      usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
      claude: { plan: 'max', fableWeeklyDropCap: 0 },
      chat: {},
      secrets: {
        claudeToken: ['sk', 'ant', 'oat01', 'ROUTESCLAUDETOKEN0123456789'].join('-'),
        joinToken: SECRET,
        operatorToken: TOKEN,
      },
    } as unknown as Config;
    const turns = new ChatTurns({
      db: w.db,
      config,
      now: () => t0,
      service: {
        async *runTurn() {
          yield { type: 'tool', name: 'Grep', summary: 'grep', id: 't1', input: { pattern: 'x' } };
          yield {
            type: 'tool_result',
            id: 't1',
            text: `hit: ${SECRET}`,
            truncated: false,
            totalLines: 1,
            isError: false,
          };
          yield { type: 'result', isError: false };
        },
        health: async () => null,
      },
      mcpUrl: chatMcpUrl(7420),
      resolvedApps: () => new Map(),
      log: () => {},
    });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(
      w.db,
      th.id,
      { role: 'owner', text: 'go', state: 'queued', sessionHash: 'h' },
      t0,
    );
    turns.enqueue(th.id);
    await turns.idle();
    const step = listMessages(w.db, th.id).find((m) => m.role === 'tool');
    const sse = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: { ...w.session, 'last-event-id': String(step?.seq) },
    });
    const tool = sseEvents(sse.body).find((e) => e.event === 'tool');
    expect(tool?.data).toMatchObject({
      seq: step?.seq,
      result: { text: 'hit: [REDACTED]', truncated: false, lines: 1, isError: false },
    });
    expect(sse.body).not.toContain(SECRET);
  });

  test('an older tool message streams as before, with no tool fields', async () => {
    const w = world();
    const th = createThread(w.db, { title: 't' }, t0);
    const m = appendMessage(w.db, th.id, { role: 'tool', text: 'read X', state: 'done' }, t0);
    const sse = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    expect(sseEvents(sse.body).find((e) => e.event === 'tool')?.data).toEqual({
      seq: m.seq,
      text: 'read X',
      createdAt: m.createdAt,
    });
  });
});
