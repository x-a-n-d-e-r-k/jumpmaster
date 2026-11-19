import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
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
import { CHAT_MISSING_COMMAND, renderChatList, renderThread, THREAD_SCRIPT } from './chat.js';
import { renderChatMarkdown } from './markdown.js';
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

/** The text box of each stored message in a page, by seq. */
function textBoxes(html: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const m of html.matchAll(
    /data-seq="(\d+)"><div class="who">[^<]*<\/div><div class="text">([\s\S]*?)<\/div>/g,
  )) {
    out.set(Number(m[1]), m[2] as string);
  }
  return out;
}

describe('/chat Markdown (#490)', () => {
  test('a stored assistant message renders Markdown; the same owner text stays literal', () => {
    const w = world({ service: false });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: '## Title', state: 'done' }, t0);
    appendMessage(w.db, th.id, { role: 'assistant', text: '## Title', state: 'done' }, t0);
    const html = renderThread(th, listMessages(w.db, th.id, 0));
    const boxes = textBoxes(html);
    expect(boxes.get(1)).toBe('## Title');
    expect(boxes.get(2)).toBe('<h3>Title</h3>');
  });

  test('the stored page and the streamed message event render one reply identically', async () => {
    const w = world({ service: false });
    const th = createThread(w.db, { title: 't' }, t0);
    const text =
      '## Plan\n\n| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n\nSee [docs](https://ok.example) and /drops.\n\n<script>alert(1)</script> [x](javascript:alert(1))';
    appendMessage(w.db, th.id, { role: 'assistant', text, state: 'done' }, t0);
    const page = await w.app.inject({ method: 'GET', url: `/chat/${th.id}`, headers: w.session });
    const stored = textBoxes(page.body).get(1);
    const res = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    const streamed = (
      frames(res.body).find((f) => f.event === 'message')?.data as { html?: string }
    ).html;
    expect(stored).toBeDefined();
    expect(streamed).toBe(stored);
    expect(stored).toBe(renderChatMarkdown(text, {}));
    expect(stored).toContain('<table>');
    expect(stored).toContain('<a href="https://ok.example"');
    expect(stored).toContain('&lt;script&gt;');
    expect(stored).not.toContain('<script');
  });

  test('an owner message streams without html', async () => {
    const w = world({ service: false });
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: '## hi', state: 'done' }, t0);
    const res = await w.app.inject({
      method: 'GET',
      url: `/api/chat/threads/${th.id}/events`,
      headers: w.session,
    });
    expect(frames(res.body).find((f) => f.event === 'message')?.data).not.toHaveProperty('html');
  });

  /** A DOM element fake: records every write of innerHTML. */
  class FakeEl {
    className = '';
    dataset: Record<string, string> = {};
    children: FakeEl[] = [];
    parent: FakeEl | undefined;
    text = '';
    html: string | undefined;
    static htmlWrites: { el: FakeEl; value: string }[] = [];
    constructor(readonly tagName: string) {}
    get textContent() {
      return this.html ?? this.text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
      this.text = v;
      this.html = undefined;
      this.children = [];
    }
    get innerHTML(): string {
      throw new Error('the script must not read innerHTML');
    }
    set innerHTML(v: string) {
      FakeEl.htmlWrites.push({ el: this, value: v });
      this.html = v;
      this.text = '';
      this.children = [];
    }
    get lastChild() {
      return this.children[this.children.length - 1];
    }
    append(...els: FakeEl[]) {
      for (const e of els) {
        e.parent = this;
        this.children.push(e);
      }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    }
    replaceWith(e: FakeEl) {
      const p = this.parent;
      if (!p) return;
      e.parent = p;
      p.children = p.children.map((c) => (c === this ? e : c));
    }
    value = '';
    disabled = false;
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: unknown) => unknown)[]> = {};
    addEventListener(ev: string, fn: (e: unknown) => unknown) {
      (this.listeners[ev] ??= []).push(fn);
    }
    fire(ev: string, e: unknown) {
      return (this.listeners[ev] ?? []).map((fn) => fn(e));
    }
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    }
    insertBefore(e: FakeEl, ref: FakeEl) {
      e.parent = this;
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, e);
    }
    querySelector(sel: string): FakeEl | null {
      for (const c of this.children) {
        if (
          c.tagName === sel ||
          (sel.startsWith('.') && c.className.split(' ').includes(sel.slice(1)))
        )
          return c;
        const d = c.querySelector(sel);
        if (d) return d;
      }
      return null;
    }
    /** Like the browser's: fires `submit` unless the required textarea is empty. */
    requestSubmit() {
      const box = this.querySelector('textarea');
      if (box && box.value === '') return;
      this.fire('submit', { preventDefault() {}, target: this });
    }
  }

  type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

  /**
   * THREAD_SCRIPT in a vm with a fake DOM, following a busy thread; `emit` fires an SSE event.
   * `fetches` holds each `jmFetch` call's resolver; `scroller` is the page's scrolling element.
   */
  function runScript() {
    FakeEl.htmlWrites = [];
    const root = new FakeEl('div');
    root.dataset = { thread: '1', last: '1', busy: '1' };
    const log = new FakeEl('div');
    const form = new FakeEl('form');
    const box = new FakeEl('textarea');
    const button = new FakeEl('button');
    form.append(box, new FakeEl('small'), button);
    const ids: Record<string, FakeEl> = { chat: root, messages: log, send: form };
    const scroller = { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 };
    const fetches: { url: string; body: unknown; resolve: (r: FakeResponse) => void }[] = [];
    const handlers: Record<string, (e: { data: string }) => void> = {};
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(ev: string, fn: (e: { data: string }) => void) {
        handlers[ev] = fn;
      }
      close() {}
    }
    const ctx = vm.createContext({
      document: {
        getElementById: (id: string) => ids[id] ?? null,
        createElement: (tag: string) => new FakeEl(tag),
        querySelector: () => null,
        scrollingElement: scroller,
      },
      EventSource: FakeEventSource,
      jmFetch: (url: string, body: unknown) =>
        new Promise<FakeResponse>((resolve) => fetches.push({ url, body, resolve })),
      alert: () => {
        throw new Error('the script must not call alert()');
      },
    });
    vm.runInContext(THREAD_SCRIPT.replace(/^<script>|<\/script>$/g, ''), ctx);
    const emit = (ev: string, data: unknown) => {
      const fn = handlers[ev];
      if (!fn) throw new Error(`no ${ev} listener`);
      fn({ data: JSON.stringify(data) });
    };
    return { log, emit, form, box, button, scroller, fetches };
  }

  test('the page script shows text events as textContent, then a message html replaces the live box', () => {
    const { log, emit } = runScript();
    emit('text', { seq: 1, text: '## <b>part</b>' });
    emit('text', { seq: 1, text: 'two' });
    expect(FakeEl.htmlWrites).toEqual([]);
    const live = log.children[0] as FakeEl;
    expect(live.className).toContain('live');
    const box = live.lastChild as FakeEl;
    expect(box.textContent).toBe('## <b>part</b>\n\ntwo');
    const html = renderChatMarkdown('## part\n\ntwo', {});
    emit('message', {
      seq: 2,
      role: 'assistant',
      state: 'done',
      text: '<img src=x onerror=alert(1)>',
      html,
    });
    expect(log.children).toHaveLength(1);
    expect(log.children[0]).toBe(live);
    expect(live.className).toBe('msg assistant');
    expect(live.dataset.seq).toBe('2');
    expect(FakeEl.htmlWrites).toEqual([{ el: box, value: html }]);
  });

  test('the page script builds no HTML from a message without html, or from an owner message', () => {
    const { log, emit } = runScript();
    emit('message', { seq: 2, role: 'owner', state: 'done', text: '<b>x</b>', html: '<b>x</b>' });
    emit('message', { seq: 3, role: 'assistant', state: 'done', text: '<i>y</i>' });
    emit('tool', { seq: 4, text: '<u>z</u>' });
    expect(FakeEl.htmlWrites).toEqual([]);
    expect(log.children.map((c) => c.lastChild?.textContent)).toEqual([
      '<b>x</b>',
      '<i>y</i>',
      '<u>z</u>',
    ]);
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));
  const key = (o: Record<string, unknown>) => {
    const e = { key: 'Enter', shiftKey: false, isComposing: false, prevented: false, ...o };
    return Object.assign(e, {
      preventDefault() {
        e.prevented = true;
      },
    });
  };

  test('Enter submits; Shift+Enter and Enter during IME composition do not', () => {
    const { box, fetches } = runScript();
    box.value = 'hello';
    const shift = key({ shiftKey: true });
    box.fire('keydown', shift);
    expect(shift.prevented).toBe(false);
    const ime = key({ isComposing: true });
    box.fire('keydown', ime);
    expect(ime.prevented).toBe(false);
    box.fire('keydown', key({ key: 'a' }));
    expect(fetches).toHaveLength(0);
    const enter = key({});
    box.fire('keydown', enter);
    expect(enter.prevented).toBe(true);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]?.url).toBe('/api/chat/threads/1/messages');
    expect(fetches[0]?.body).toEqual({ text: 'hello' });
  });

  test('a blank or whitespace-only message is not sent', () => {
    const { box, form, fetches } = runScript();
    box.value = '   \n ';
    box.fire('keydown', key({}));
    form.fire('submit', { preventDefault() {}, target: form });
    expect(fetches).toHaveLength(0);
  });

  test('Send is disabled while the request is in flight, and a refusal shows inline, then a success clears it', async () => {
    const { box, form, button, fetches } = runScript();
    box.value = 'do it';
    box.fire('keydown', key({}));
    expect(button.disabled).toBe(true);
    fetches[0]?.resolve({ ok: false, status: 403, json: async () => ({ error: 'sudo' }) });
    await flush();
    expect(button.disabled).toBe(false);
    const err = form.querySelector('.error') as FakeEl;
    expect(err).not.toBeNull();
    expect(err.tagName).toBe('p');
    expect(err.attrs.role).toBe('alert');
    expect(err.textContent).toContain('403');
    expect(err.textContent).toContain('sudo');
    expect(form.children.indexOf(err)).toBe(form.children.indexOf(box) - 1);
    expect(box.value).toBe('do it');

    box.fire('keydown', key({}));
    expect(button.disabled).toBe(true);
    expect(form.children.filter((c) => c.className === 'error')).toHaveLength(1);
    fetches[1]?.resolve({
      ok: true,
      status: 200,
      json: async () => ({ message: { seq: 2, role: 'owner', state: 'done', text: 'do it' } }),
    });
    await flush();
    expect(button.disabled).toBe(false);
    expect(form.querySelector('.error')).toBeNull();
    expect(box.value).toBe('');
  });

  test('the page opens scrolled to the newest message', () => {
    const { scroller } = runScript();
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  test('a new message scrolls to the end only when the reader was within 120px of the bottom', () => {
    const { emit, scroller } = runScript();
    const msg = (seq: number) => ({ seq, role: 'assistant', state: 'done', text: 'x' });
    // At the bottom: follows.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    emit('message', msg(2));
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    // 500px from the bottom: stays put.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 500;
    const before = scroller.scrollTop;
    emit('message', msg(3));
    emit('text', { seq: 4, text: 'more' });
    emit('card', { card: { id: 9, kind: 'x', state: 'pending', summary: 's' } });
    expect(scroller.scrollTop).toBe(before);
    // 100px from the bottom: follows streamed text and cards too.
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 100;
    emit('text', { seq: 4, text: 'more' });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 100;
    emit('card', { card: { id: 10, kind: 'x', state: 'pending', summary: 's' } });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});

describe('/chat composer (#491)', () => {
  test('the thread page has the sticky composer, new placeholder and hint', () => {
    const w = world({ service: false });
    const th = createThread(w.db, { title: 't' }, t0);
    const html = renderThread(th, []);
    expect(html).toContain('placeholder="Ask Jumpmaster"');
    expect(html).toContain('Enter to send, Shift+Enter for a new line');
    expect(html).not.toContain('Ask the crew');
    expect(html).toMatch(/\.chat-send\{[^}]*position:sticky;bottom:0/);
    expect(html).toMatch(/\.chat-send\{[^}]*env\(safe-area-inset-bottom\)/);
  });
});

describe('focus chips and relative times', () => {
  const zones = [
    { id: 'main', repo: 'acme/demo' },
    { id: 'other', repo: 'acme/other' },
  ];
  const now = new Date('2026-11-26T12:00:00.000Z');

  function threads() {
    const db = openDb(tmpDbFile());
    const at = new Date('2026-11-26T11:55:00.000Z');
    const plain = createThread(db, { title: 'Plain one' }, at);
    const zone = createThread(
      db,
      { title: 'Zone main', focus: { kind: 'zone', zoneId: 'main', ref: 'main' } },
      at,
    );
    const goals = createThread(
      db,
      { title: 'Goals of other', focus: { kind: 'goals', zoneId: 'other', ref: 'other' } },
      at,
    );
    const briefing = createThread(
      db,
      { title: 'Briefing 12: Retry?', focus: { kind: 'briefing', zoneId: 'main', ref: '12' } },
      at,
    );
    const gone = createThread(
      db,
      { title: 'Zone gone', focus: { kind: 'zone', zoneId: 'gone-zone', ref: 'gone-zone' } },
      at,
    );
    return { db, plain, zone, goals, briefing, gone };
  }

  const rowOf = (html: string, id: number) => {
    const start = html.indexOf(`href="/chat/${id}"`);
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</tr>', start));
  };

  test('the list shows a chip for each focus kind and none for an unfocused thread', () => {
    const t = threads();
    const html = renderChatList(listThreads(t.db), { serviceMissing: false, zones, now });
    expect(rowOf(html, t.zone.id)).toContain('<span class="chip">acme/demo</span>');
    expect(rowOf(html, t.goals.id)).toContain('<span class="chip">acme/other · goals</span>');
    expect(rowOf(html, t.briefing.id)).toContain('<span class="chip">Briefing 12</span>');
    expect(rowOf(html, t.plain.id)).toContain('Plain one');
    expect(rowOf(html, t.plain.id)).not.toContain('class="chip"');
  });

  test('a focus whose zone was removed shows its raw id', () => {
    const t = threads();
    const html = renderChatList(listThreads(t.db), { serviceMissing: false, zones, now });
    expect(rowOf(html, t.gone.id)).toContain('<span class="chip">gone-zone</span>');
  });

  test('the Updated column is a relative <time> with the full ISO', () => {
    const t = threads();
    const html = renderChatList(listThreads(t.db), { serviceMissing: false, zones, now });
    expect(rowOf(html, t.plain.id)).toContain(
      '<time datetime="2026-11-26T11:55:00.000Z" title="2026-11-26T11:55:00.000Z">5 min ago</time>',
    );
  });

  test('the thread page shows the chip next to the heading', () => {
    const t = threads();
    const goals = renderThread(t.goals, [], [], { zones });
    expect(goals).toContain('<h2>Goals of other <span class="chip">acme/other · goals</span></h2>');
    expect(renderThread(t.plain, [], [], { zones })).toContain('<h2>Plain one</h2>');
  });

  test('/chat and /chat/:id show chips for the configured zones', async () => {
    const w = world();
    const th = createThread(
      w.db,
      { title: 'Zone gone', focus: { kind: 'zone', zoneId: 'gone-zone', ref: 'gone-zone' } },
      t0,
    );
    const list = await w.app.inject({ method: 'GET', url: '/chat', headers: w.session });
    expect(list.body).toContain('<span class="chip">gone-zone</span>');
    expect(list.body).toContain(`<time datetime="${t0.toISOString()}"`);
    const one = await w.app.inject({ method: 'GET', url: `/chat/${th.id}`, headers: w.session });
    expect(one.body).toContain('<span class="chip">gone-zone</span>');
  });
});
