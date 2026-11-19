import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode } from '../auth/operator.js';
import { sha256Hex } from '../auth/sessions.js';
import { type ChatCard, listCards, recordCard } from '../chat/cards.js';
import {
  appendMessage,
  type ChatMessage,
  type ChatThread,
  createThread,
  listMessages,
  listThreads,
  setMessage,
} from '../chat/store.js';
import type { HubEvent } from '../chat/turns.js';
import { loadBoot } from '../config/boot.js';
import { PENDING_MS } from '../config/confirm.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  CHAT_MISSING_COMMAND,
  messageTextHtml,
  renderChatList,
  renderThread,
  THREAD_SCRIPT,
} from './chat.js';
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
  return { db, store, app: a, session, sid: s.id, bearer, subscribed, listeners };
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

  test('/chat/:id renders owner and assistant text escaped and each tool line as a collapsed step', async () => {
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
      /<details class="steps"><summary>Worked through 1 step<\/summary><ol><li data-seq="2">read apps\/server\/src\/goals\.ts<\/li><\/ol><\/details>/,
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
      FakeEl.parse?.(this, v);
    }
    get lastChild() {
      return this.children[this.children.length - 1];
    }
    get lastElementChild() {
      return this.lastChild ?? null;
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
    /** A selector list of `tag`, `.class`, `[attr]` and `[attr=value]` parts, as the script uses. */
    matches(sel: string): boolean {
      return sel.split(',').some((one) => {
        const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:=[\w-]+)?\])*)$/.exec(one.trim());
        if (!m) throw new Error(`unsupported selector ${one}`);
        const [, tag, classes, attrs] = m;
        if (tag && this.tagName !== tag) return false;
        const mine = this.className.split(' ');
        for (const c of (classes ?? '').split('.').filter(Boolean))
          if (!mine.includes(c)) return false;
        for (const a of (attrs ?? '').match(/\[[^\]]+\]/g) ?? []) {
          const [k = '', v] = a.slice(1, -1).split('=');
          const got = k.startsWith('data-')
            ? this.dataset[k.slice(5)]
            : (this.attrs[k] ?? (this as unknown as Record<string, unknown>)[k]);
          if (got === undefined || got === '' || (v !== undefined && got !== v)) return false;
        }
        return true;
      });
    }
    querySelectorAll(sel: string): FakeEl[] {
      return this.children.flatMap((c) => [
        ...(c.matches(sel) ? [c] : []),
        ...c.querySelectorAll(sel),
      ]);
    }
    querySelector(sel: string): FakeEl | null {
      return this.querySelectorAll(sel)[0] ?? null;
    }
    get firstChild() {
      return this.children[0];
    }
    type = '';
    name = '';
    href = '';
    tabIndex = 0;
    static focused: FakeEl | null = null;
    focus() {
      FakeEl.focused = this;
    }
    /** Builds the children a test says an innerHTML write stands for. */
    static parse: ((el: FakeEl, html: string) => void) | undefined;
    /** Like the browser's: fires `submit` unless the required textarea is empty. */
    requestSubmit() {
      const box = this.querySelector('textarea');
      if (box && box.value === '') return;
      this.fire('submit', { preventDefault() {}, target: this });
    }
  }

  type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

  /** A `<dialog>`: `showModal` opens it, `close` shuts it and fires `close`, as the browser's. */
  class FakeDialog extends FakeEl {
    open = false;
    showModal() {
      this.open = true;
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.fire('close', {});
    }
  }

  /**
   * THREAD_SCRIPT in a vm with a fake DOM, following a busy thread; `emit` fires an SSE event.
   * `fetches` holds each `jmFetch` call's resolver; `scroller` is the page's scrolling element.
   */
  function runScript(o: { dialogApi?: boolean; now?: number; cards?: FakeEl[] } = {}) {
    FakeEl.htmlWrites = [];
    FakeEl.focused = null;
    FakeEl.parse = undefined;
    const root = new FakeEl('div');
    root.dataset = { thread: '1', last: '1', busy: '1' };
    const log = new FakeEl('div');
    const form = new FakeEl('form');
    const box = new FakeEl('textarea');
    const button = new FakeEl('button');
    form.append(box, new FakeEl('small'), button);
    for (const c of o.cards ?? []) log.append(c);
    const dialog = new FakeDialog('dialog');
    const dbody = new FakeEl('div');
    dbody.className = 'confirm-body';
    const heading = new FakeEl('h2');
    heading.textContent = 'Confirm a guarded change';
    dialog.append(heading, dbody);
    const ids: Record<string, FakeEl> = {
      chat: root,
      messages: log,
      send: form,
      'confirm-dialog': dialog,
    };
    const clock = { now: o.now ?? 0 };
    let tick: (() => void) | undefined;
    let tickMs = 0;
    const location = { href: '/chat/1' };
    const pageFetches: {
      url: string;
      init: { method?: string; headers?: Record<string, string>; body?: string };
      resolve: (r: {
        ok: boolean;
        status: number;
        text?: () => Promise<string>;
        json?: () => Promise<unknown>;
      }) => void;
    }[] = [];
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
        get activeElement() {
          return FakeEl.focused;
        },
      },
      ...(o.dialogApi === false ? {} : { HTMLDialogElement: FakeDialog }),
      location,
      URLSearchParams,
      Date: { now: () => clock.now, parse: Date.parse },
      setInterval: (fn: () => void, ms: number) => {
        tick = fn;
        tickMs = ms;
        return 1;
      },
      fetch: (url: string, init: (typeof pageFetches)[number]['init'] = {}) =>
        new Promise((resolve) => pageFetches.push({ url, init, resolve })),
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
    return {
      log,
      emit,
      form,
      box,
      button,
      scroller,
      fetches,
      dialog,
      dbody,
      clock,
      location,
      pageFetches,
      tickMs: () => tickMs,
      tick: () => tick?.(),
    };
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

  const THREAD: ChatThread = {
    id: 1,
    title: 't',
    focusKind: null,
    focusZoneId: null,
    focusRef: null,
    claudeSessionId: null,
    createdAt: t0.toISOString(),
    updatedAt: t0.toISOString(),
  };

  /** A stored message for `renderThread`. */
  const stored = (seq: number, role: ChatMessage['role'], text: string): ChatMessage => ({
    id: seq,
    threadId: 1,
    seq,
    role,
    text,
    state: 'done',
    sessionHash: null,
    usage: null,
    error: null,
    createdAt: t0.toISOString(),
  });

  /** The chat log's top-level items in a stored page: a role, or `steps:N` for a group of N. */
  function storedShape(html: string): string[] {
    const log = /<div id="messages"[^>]*>([\s\S]*)<\/div><form id="send"/.exec(html)?.[1] ?? '';
    return [
      ...log.matchAll(
        /<div class="msg (\w+)"|<details class="steps"><summary>[^<]*<\/summary><ol>((?:<li data-seq="\d+">[^<]*<\/li>)*)<\/ol><\/details>/g,
      ),
    ].map((m) => (m[1] ?? `steps:${(m[2]?.match(/<li /g) ?? []).length}`) as string);
  }

  /** The chat log's top-level items in the fake DOM, as `storedShape` reads them. */
  const liveShape = (log: FakeEl) =>
    log.children.map((c) =>
      c.className === 'steps'
        ? `steps:${c.querySelector('ol')?.children.length}`
        : (c.className.split(' ')[1] as string),
    );

  const SEQUENCE: [ChatMessage['role'], string][] = [
    ['owner', 'go'],
    ['tool', 'read a'],
    ['tool', 'read b'],
    ['tool', 'searched for invalid'],
    ['assistant', 'half'],
    ['tool', 'read c'],
    ['assistant', 'done'],
  ];

  test('stored consecutive tool lines group into one "Worked through N steps" disclosure each run', () => {
    const msgs = SEQUENCE.map(([role, text], i) => stored(i + 1, role, text));
    const html = renderThread(THREAD, msgs);
    expect(storedShape(html)).toEqual(['owner', 'steps:3', 'assistant', 'steps:1', 'assistant']);
    expect(html).toContain(
      '<details class="steps"><summary>Worked through 3 steps</summary><ol><li data-seq="2">read a</li><li data-seq="3">read b</li><li data-seq="4">searched for invalid</li></ol></details>',
    );
    expect(html).toContain(
      '<summary>Worked through 1 step</summary><ol><li data-seq="6">read c</li></ol>',
    );
    expect(html).not.toMatch(/<details[^>]*>(<summary>[^<]*<\/summary>)?<\/details>/);
    expect(html).not.toContain('<details class="steps" open');
  });

  test('a card between tool lines splits the group', () => {
    const msgs = [stored(1, 'tool', 'a'), stored(2, 'tool', 'b')];
    msgs[1] = { ...(msgs[1] as ChatMessage), createdAt: plus(t0, 2000).toISOString() };
    const card = {
      id: 1,
      threadId: 1,
      kind: 'x',
      state: 'pending',
      summary: 's',
      link: null,
      createdAt: plus(t0, 1000).toISOString(),
    } as unknown as ChatCard;
    const html = renderThread(THREAD, msgs, [card]);
    expect((html.match(/<details class="steps">/g) ?? []).length).toBe(2);
  });

  test("a tool line's text is escaped in its step", () => {
    const html = renderThread(THREAD, [stored(1, 'tool', 'read <b>x</b>')]);
    expect(html).toContain('<li data-seq="1">read &lt;b&gt;x&lt;/b&gt;</li>');
    expect(html).not.toContain('<b>x</b>');
  });

  test('streamed tool events group until a message, then a further tool event starts a new group', () => {
    const { log, emit } = runScript();
    emit('tool', { seq: 2, text: 'read a' });
    emit('tool', { seq: 3, text: '<b>b</b>' });
    emit('tool', { seq: 4, text: 'read c' });
    expect(log.children).toHaveLength(1);
    const group = log.children[0] as FakeEl;
    expect(group.tagName).toBe('details');
    expect(group.className).toBe('steps');
    expect(group.querySelector('summary')?.textContent).toBe('Worked through 3 steps');
    const ol = group.querySelector('ol') as FakeEl;
    expect(ol.children.map((li) => [li.tagName, li.dataset.seq, li.textContent])).toEqual([
      ['li', '2', 'read a'],
      ['li', '3', '<b>b</b>'],
      ['li', '4', 'read c'],
    ]);
    emit('message', { seq: 5, role: 'assistant', state: 'done', text: 'x', html: '<p>x</p>' });
    expect(liveShape(log)).toEqual(['steps:3', 'assistant']);
    emit('tool', { seq: 6, text: 'read d' });
    expect(liveShape(log)).toEqual(['steps:3', 'assistant', 'steps:1']);
    expect(log.children[2]?.querySelector('summary')?.textContent).toBe('Worked through 1 step');
    expect(FakeEl.htmlWrites.map((w) => w.value)).toEqual(['<p>x</p>']);
  });

  test('a re-sent tool line replaces its step in place', () => {
    const { log, emit } = runScript();
    emit('tool', { seq: 2, text: 'a' });
    emit('tool', { seq: 3, text: 'b' });
    emit('tool', { seq: 2, text: 'a2' });
    const ol = log.children[0]?.querySelector('ol') as FakeEl;
    expect(ol.children.map((li) => li.textContent)).toEqual(['a2', 'b']);
    expect(log.children[0]?.querySelector('summary')?.textContent).toBe('Worked through 2 steps');
  });

  test('text and card events close the open group', () => {
    const { log, emit } = runScript();
    emit('tool', { seq: 2, text: 'a' });
    emit('text', { seq: 2, text: 'thinking' });
    emit('tool', { seq: 3, text: 'b' });
    emit('card', { card: { id: 9, kind: 'x', state: 'pending', summary: 's' } });
    emit('tool', { seq: 4, text: 'c' });
    expect(liveShape(log)).toEqual(['steps:1', 'assistant', 'steps:1', 'card', 'steps:1']);
  });

  test('stored and streamed rendering give the same groups for the same sequence', () => {
    const msgs = SEQUENCE.map(([role, text], i) => stored(i + 1, role, text));
    const html = renderThread(THREAD, msgs);
    const { log, emit } = runScript();
    for (const m of msgs) {
      if (m.role === 'tool') emit('tool', { seq: m.seq, text: m.text });
      else emit('message', { ...m, html: messageTextHtml(m) });
    }
    expect(liveShape(log)).toEqual(storedShape(html));
    expect(liveShape(log)).toEqual(['owner', 'steps:3', 'assistant', 'steps:1', 'assistant']);
  });

  describe('a tool step opens to its input and result (#514)', () => {
    const step = (
      seq: number,
      o: Partial<Pick<ChatMessage, 'toolName' | 'input' | 'result' | 'text'>>,
    ): ChatMessage => ({ ...stored(seq, 'tool', o.text ?? `step ${seq}`), ...o });
    const ok = (text: string, lines = text.split('\n').length) => ({
      text,
      truncated: false,
      lines,
      isError: false,
    });
    /** The `<li>` of the step at `seq` in a stored page. */
    const li = (html: string, seq: number) =>
      new RegExp(`<li data-seq="${seq}">([\\s\\S]*?)</li>`).exec(html)?.[1] ?? '';

    test('a Read step renders its path and a result <pre>', () => {
      const html = renderThread(THREAD, [
        step(1, {
          text: 'read a.ts',
          toolName: 'Read',
          input: { file_path: '/repo/a.ts', offset: 10, limit: 20 },
          result: ok('one\ntwo\nthree'),
        }),
      ]);
      const item = li(html, 1);
      expect(item).toMatch(/^<details><summary>read a\.ts<\/summary>/);
      expect(item).toMatch(/<\/details>$/);
      expect(item).toContain('/repo/a.ts');
      expect(item).toContain('offset: 10');
      expect(item).toContain('limit: 20');
      expect(item).toContain('<pre>one\ntwo\nthree</pre>');
      expect(item).toContain('3 lines');
    });

    test('Read without offset or limit, Grep and Glob show only what is set', () => {
      const html = renderThread(THREAD, [
        step(1, { toolName: 'Read', input: { file_path: 'b.ts' }, result: ok('x') }),
        step(2, {
          toolName: 'Grep',
          input: { pattern: 'foo.*', path: 'src', glob: '*.ts', output_mode: 'content' },
          result: ok('x'),
        }),
        step(3, { toolName: 'Grep', input: { pattern: 'bar' }, result: ok('x') }),
        step(4, { toolName: 'Glob', input: { pattern: '**/*.md' }, result: ok('x') }),
      ]);
      expect(li(html, 1)).not.toContain('offset');
      expect(li(html, 1)).not.toContain('limit');
      expect(li(html, 2)).toContain('foo.*');
      expect(li(html, 2)).toContain('path: src');
      expect(li(html, 2)).toContain('glob: *.ts');
      expect(li(html, 2)).not.toContain('output_mode');
      expect(li(html, 3)).not.toContain('path:');
      expect(li(html, 4)).toContain('**/*.md');
      expect(li(html, 1)).toContain('1 line<');
    });

    test('a Bash step renders its command in <code>', () => {
      const html = renderThread(THREAD, [
        step(1, { toolName: 'Bash', input: { command: 'ls -la && echo "<hi>"' }, result: ok('') }),
      ]);
      expect(li(html, 1)).toContain('<code>ls -la &amp;&amp; echo &quot;&lt;hi&gt;&quot;</code>');
    });

    test('an MCP step renders each key as key: JSON value, cut at 200 characters', () => {
      const html = renderThread(THREAD, [
        step(1, {
          toolName: 'mcp__jm__zone_status',
          input: { zoneId: 'jm', deep: { a: [1, 2] }, long: 'x'.repeat(500) },
          result: ok('{}'),
        }),
      ]);
      const item = li(html, 1);
      expect(item).toContain('zoneId: &quot;jm&quot;');
      expect(item).toContain('deep: {&quot;a&quot;:[1,2]}');
      expect(item).toContain(`long: &quot;${'x'.repeat(199)}…`);
      expect(item).not.toContain('x'.repeat(200));
    });

    test('a truncated input shows its preview and an "input truncated" note', () => {
      const html = renderThread(THREAD, [
        step(1, {
          toolName: 'Write',
          input: { _truncated: true, preview: '{"file_path":"a","content":"<b>' },
        }),
      ]);
      const item = li(html, 1);
      expect(item).toContain(
        '{&quot;file_path&quot;:&quot;a&quot;,&quot;content&quot;:&quot;&lt;b&gt;',
      );
      expect(item).toContain('input truncated');
      expect(item).not.toContain('_truncated');
    });

    test('a truncated result shows "showing the first 200 of 500 lines"', () => {
      const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
      const html = renderThread(THREAD, [
        step(1, {
          toolName: 'Read',
          input: { file_path: 'big' },
          result: { text, truncated: true, lines: 500, isError: false },
        }),
      ]);
      expect(li(html, 1)).toContain('showing the first 200 of 500 lines');
    });

    test('an error result has class error and says Error', () => {
      const html = renderThread(THREAD, [
        step(1, {
          toolName: 'Bash',
          input: { command: 'false' },
          result: { text: 'exit 1', truncated: false, lines: 1, isError: true },
        }),
        step(2, { toolName: 'Bash', input: { command: 'true' }, result: ok('fine') }),
      ]);
      expect(li(html, 1)).toMatch(/<div class="result error">[^]*Error/);
      expect(li(html, 2)).not.toContain('error');
      expect(li(html, 2)).not.toContain('Error');
    });

    test('a result with <script> and a javascript: link renders escaped, with no element or href', () => {
      const html = renderThread(THREAD, [
        step(1, {
          text: 'ran <i>x</i>',
          toolName: 'mcp__x__y',
          input: { q: '<img src=x onerror=alert(1)>' },
          result: ok('<script>alert(1)</script> [x](javascript:alert(1)) https://evil.example'),
        }),
      ]);
      const item = li(html, 1);
      expect(item).toContain('&lt;script&gt;alert(1)&lt;/script&gt; [x](javascript:alert(1))');
      expect(item).toContain('ran &lt;i&gt;x&lt;/i&gt;');
      expect(item).not.toMatch(/<(script|a|img|i)[\s>]/);
      expect(item).not.toContain('href');
    });

    test('an older step with no input or result stays a plain <li>', () => {
      const html = renderThread(THREAD, [stored(1, 'tool', 'read a')]);
      expect(html).toContain('<li data-seq="1">read a</li>');
      expect(html).not.toMatch(/<li[^>]*><details>/);
    });

    test('a step with no result says running… while its turn runs, else no result recorded', () => {
      const pending = step(2, { toolName: 'Read', input: { file_path: 'a' } });
      const busy = renderThread(THREAD, [
        { ...stored(1, 'owner', 'go') },
        pending,
        { ...stored(3, 'assistant', ''), state: 'running' },
      ]);
      expect(li(busy, 2)).toContain('running…');
      const done = renderThread(THREAD, [stored(1, 'owner', 'go'), pending]);
      expect(li(done, 2)).toContain('no result recorded');
      expect(li(done, 2)).not.toContain('running');
      // A step of an earlier turn is done even while a later turn runs.
      const later = renderThread(THREAD, [
        stored(1, 'owner', 'go'),
        pending,
        stored(3, 'owner', 'again'),
        { ...stored(4, 'assistant', ''), state: 'running' },
      ]);
      expect(li(later, 2)).toContain('no result recorded');
    });

    test('streamed: a step re-sent with its result updates its <li> in place, the group as it was', () => {
      const { log, emit } = runScript();
      const input = { file_path: 'a.ts' };
      emit('tool', { seq: 2, text: 'read a.ts', toolName: 'Read', input });
      emit('tool', { seq: 3, text: 'old' });
      const group = log.children[0] as FakeEl & { open?: boolean };
      const ol = group.querySelector('ol') as FakeEl;
      const first = ol.children[0] as FakeEl;
      expect(first.querySelector('summary')?.textContent).toBe('read a.ts');
      expect(first.textContent).toContain('running…');
      expect(ol.children[1]?.querySelector('details')).toBeNull();
      group.open = true;
      (first.querySelector('details') as FakeEl & { open?: boolean }).open = true;
      emit('tool', {
        seq: 2,
        text: 'read a.ts',
        toolName: 'Read',
        input,
        result: { text: '<script>x</script>', truncated: true, lines: 9, isError: true },
      });
      expect(log.children).toHaveLength(1);
      expect(log.children[0]).toBe(group);
      expect(group.open).toBe(true);
      expect(ol.children).toHaveLength(2);
      expect(group.querySelector('summary')?.textContent).toBe('Worked through 2 steps');
      const now = ol.children[0] as FakeEl;
      expect(now.dataset.seq).toBe('2');
      expect(now.tagName).toBe('li');
      expect((now.querySelector('details') as FakeEl & { open?: boolean }).open).toBe(true);
      expect(now.textContent).not.toContain('running…');
      expect(now.querySelector('pre')?.textContent).toBe('<script>x</script>');
      expect(now.querySelector('.result')?.className).toBe('result error');
      expect(now.textContent).toContain('Error');
      expect(now.textContent).toContain('showing the first 1 of 9 lines');
      expect(FakeEl.htmlWrites).toEqual([]);
    });

    test('streamed: input per tool matches the stored page', () => {
      const msgs = [
        step(1, { toolName: 'Read', input: { file_path: 'a', offset: 3 }, result: ok('x\ny') }),
        step(2, { toolName: 'Bash', input: { command: 'ls' }, result: ok('') }),
        step(3, { toolName: 'mcp__a__b', input: { zoneId: 'jm' }, result: ok('z') }),
        step(4, { toolName: 'Grep', input: { _truncated: true, preview: '{"pa' } }),
      ];
      const { log, emit } = runScript();
      for (const m of msgs) emit('tool', m);
      const ol = log.children[0]?.querySelector('ol') as FakeEl;
      const texts = ol.children.map((c) => c.textContent);
      expect(texts[0]).toContain('offset: 3');
      expect(texts[0]).toContain('2 lines');
      expect(ol.children[1]?.querySelector('code')?.textContent).toBe('ls');
      expect(texts[2]).toContain('zoneId: "jm"');
      expect(texts[3]).toContain('input truncated');
      expect(texts[3]).toContain('running…');
      // Once the turn is done, the same text as the stored page of a thread at rest.
      emit('done', {});
      const html = renderThread(THREAD, msgs);
      for (const [i, item] of ol.children.entries()) {
        const t = item.textContent;
        const plain = li(html, i + 1)
          .replace(/<[^>]+>/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        expect(t).toBe(plain);
      }
    });

    test('streamed: done turns a step still running into no result recorded', () => {
      const { log, emit } = runScript();
      emit('tool', { seq: 2, text: 'r', toolName: 'Read', input: { file_path: 'a' } });
      emit('done', {});
      expect(log.children[0]?.textContent).toContain('no result recorded');
      expect(log.children[0]?.textContent).not.toContain('running…');
    });
  });

  describe('the confirm dialog (#503)', () => {
    const T = Date.parse('2026-01-01T00:00:00.000Z');
    const MIN = 60_000;
    const pendingCard = (o: Record<string, unknown> = {}) => ({
      id: 7,
      kind: 'setting',
      state: 'pending',
      summary: 'Turn off CI in main',
      link: '/config/confirm/abc',
      createdAt: new Date(T).toISOString(),
      ...o,
    });
    const FRAME = '<meta name="jm-csrf" content="csrf-1"><form>…</form>';
    /** What the frame's HTML stands for in the fake: the meta, the form and its fields. */
    const parseFrame = (el: FakeEl) => {
      const meta = new FakeEl('meta');
      meta.attrs = { name: 'jm-csrf' };
      (meta as unknown as { content: string }).content = 'csrf-1';
      const form = new FakeEl('form');
      const token = new FakeEl('input');
      Object.assign(token, { type: 'hidden', name: 'token', value: 'tok-1' });
      const pass = new FakeEl('input');
      Object.assign(pass, { type: 'password', name: 'passphrase' });
      const ok = new FakeEl('button');
      ok.className = 'primary';
      const cancel = new FakeEl('button');
      cancel.dataset = { cancel: '1' };
      form.append(token, pass, ok, cancel);
      el.append(meta, form);
    };
    const text = (status: number, body: string) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    });
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    const press = (el: FakeEl | null) => {
      if (!el) throw new Error('no such button');
      el.fire('click', {});
    };
    const cardOf = (log: FakeEl) => log.querySelector('[data-card]') as FakeEl;
    /** A thread with one streamed pending card, its Review pressed and the frame loaded. */
    const opened = async () => {
      const r = runScript({ now: T + MIN });
      FakeEl.parse = (el) => parseFrame(el);
      r.emit('card', { card: pendingCard() });
      const review = cardOf(r.log).querySelector('.review') as FakeEl;
      review.focus();
      press(review);
      r.pageFetches[0]?.resolve(text(200, FRAME));
      await flush();
      const form = r.dbody.querySelector('form') as FakeEl;
      const submit = () => form.fire('submit', { preventDefault() {} });
      return { ...r, review, form, submit };
    };

    test('Review and confirm opens the dialog and loads ?frame=1 into it, from the server only', async () => {
      const r = await opened();
      expect(r.dialog.open).toBe(true);
      expect(r.pageFetches).toHaveLength(1);
      expect(r.pageFetches[0]?.url).toBe('/config/confirm/abc?frame=1');
      expect(r.pageFetches[0]?.init.method ?? 'GET').toBe('GET');
      // The one HTML the dialog sets is that response's.
      expect(FakeEl.htmlWrites).toEqual([{ el: r.dbody, value: FRAME }]);
      expect(r.dialog.querySelector('h2')?.textContent).toBe('Confirm a guarded change');
      expect(FakeEl.focused?.name).toBe('passphrase');
    });

    test('submitting posts the form as JSON with the CSRF header; 200 closes the dialog and the card event settles it', async () => {
      const r = await opened();
      (r.form.querySelector('input[type=password]') as FakeEl).value = 'pass phrase';
      r.submit();
      const post = r.pageFetches[1];
      expect(post?.url).toBe('/config/confirm/abc');
      expect(post?.init.method).toBe('POST');
      expect(post?.init.headers).toMatchObject({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'x-jm-csrf': 'csrf-1',
      });
      expect(Object.fromEntries(new URLSearchParams(post?.init.body))).toEqual({
        token: 'tok-1',
        passphrase: 'pass phrase',
      });
      post?.resolve(json(200, { applied: true, revision: 4 }));
      await flush();
      expect(r.dialog.open).toBe(false);
      expect(r.dbody.children).toEqual([]);
      const card = cardOf(r.log);
      expect(card.querySelector('.review')).toBeNull();
      expect(FakeEl.focused).toBe(card);
      r.emit('card', {
        card: { id: 7, kind: 'setting', state: 'done', summary: 'Changed CI', link: null },
      });
      expect(r.log.querySelectorAll('[data-card]')).toHaveLength(1);
      expect(cardOf(r.log).querySelector('.text')?.textContent).toBe('Changed CI');
    });

    test('401 keeps the dialog open with the error; 429 and 503 say why too', async () => {
      const r = await opened();
      r.submit();
      r.pageFetches[1]?.resolve(json(401, { error: 'passphrase' }));
      await flush();
      expect(r.dialog.open).toBe(true);
      const err = r.dbody.querySelector('.error') as FakeEl;
      expect(err.attrs.role).toBe('alert');
      expect(err.textContent).toBe('That passphrase is not right.');
      expect(cardOf(r.log).querySelector('.review')).not.toBeNull();
      r.submit();
      r.pageFetches[2]?.resolve(json(429, { error: 'backoff', retryAfter: 4 }));
      await flush();
      expect(err.textContent).toContain('wait 4 s');
      r.submit();
      r.pageFetches[3]?.resolve(json(503, { error: 'busy' }));
      await flush();
      expect(r.dialog.open).toBe(true);
      expect(r.dbody.querySelectorAll('.error')).toHaveLength(1);
      expect(err.textContent).toContain('busy');
    });

    test.each([404, 409])('%i closes the dialog and marks the card Expired', async (status) => {
      const r = await opened();
      r.submit();
      r.pageFetches[1]?.resolve(json(status, { error: status === 404 ? 'gone' : 'used' }));
      await flush();
      expect(r.dialog.open).toBe(false);
      const card = cardOf(r.log);
      expect(card.querySelector('.state')?.textContent).toBe('Expired');
      expect(card.querySelector('.review')).toBeNull();
      expect(card.querySelector('.restage')?.textContent).toBe('Stage it again');
      expect(FakeEl.focused).toBe(card.querySelector('.restage'));
    });

    test('a 404 frame marks the card Expired without showing anything', async () => {
      const r = runScript({ now: T });
      r.emit('card', { card: pendingCard() });
      press(cardOf(r.log).querySelector('.review'));
      r.pageFetches[0]?.resolve(text(404, 'Nothing to confirm'));
      await flush();
      expect(r.dialog.open).toBe(false);
      expect(FakeEl.htmlWrites).toEqual([]);
      expect(cardOf(r.log).querySelector('.state')?.textContent).toBe('Expired');
    });

    test('Escape and Cancel close the dialog without posting, and focus returns to the button', async () => {
      const r = await opened();
      let prevented = false;
      r.dialog.fire('keydown', { key: 'Escape', preventDefault: () => (prevented = true) });
      expect([r.dialog.open, prevented]).toEqual([false, true]);
      expect(FakeEl.focused).toBe(r.review);
      press(r.review);
      r.pageFetches[1]?.resolve(text(200, FRAME));
      await flush();
      expect(r.dialog.open).toBe(true);
      press(r.dbody.querySelector('[data-cancel]'));
      expect(r.dialog.open).toBe(false);
      expect(FakeEl.focused).toBe(r.review);
      // Only the two frame loads: nothing was posted.
      expect(r.pageFetches.map((f) => f.init.method ?? 'GET')).toEqual(['GET', 'GET']);
    });

    test('Tab and Shift+Tab stay inside the open dialog', async () => {
      const r = await opened();
      const focusable = r.dialog
        .querySelectorAll('button,input,a[href],textarea,select')
        .filter((x) => x.type !== 'hidden');
      const first = focusable[0] as FakeEl;
      const last = focusable[focusable.length - 1] as FakeEl;
      expect(first.name).toBe('passphrase');
      last.focus();
      let prevented = false;
      r.dialog.fire('keydown', {
        key: 'Tab',
        shiftKey: false,
        preventDefault: () => (prevented = true),
      });
      expect([FakeEl.focused, prevented]).toEqual([first, true]);
      r.dialog.fire('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
      expect(FakeEl.focused).toBe(last);
    });

    test('without HTMLDialogElement the button navigates to the confirm page instead', () => {
      const r = runScript({ dialogApi: false, now: T });
      r.emit('card', { card: pendingCard() });
      const review = cardOf(r.log).querySelector('.review') as FakeEl;
      expect(review.tagName).toBe('button');
      expect(review.type).toBe('button');
      press(review);
      expect(r.location.href).toBe('/config/confirm/abc');
      expect(r.pageFetches).toEqual([]);
      expect(r.dialog.open).toBe(false);
    });

    test('a card whose link is not a confirm path has no button and opens no dialog; nor does message text naming one', async () => {
      const r = runScript({ now: T });
      r.emit('card', { card: pendingCard({ id: 8, link: '/config/confirm/../zones' }) });
      r.emit('card', { card: pendingCard({ id: 9, link: '/zones/main' }) });
      r.emit('card', { card: pendingCard({ id: 10, state: 'done', link: '/config/confirm/abc' }) });
      r.emit('message', {
        seq: 2,
        role: 'assistant',
        state: 'done',
        text: 'Open /config/confirm/abc',
        html: renderChatMarkdown('Open /config/confirm/abc', {}),
      });
      expect(r.log.querySelectorAll('.review')).toEqual([]);
      expect(r.log.querySelectorAll('[data-confirm]')).toEqual([]);
      for (const a of r.log.querySelectorAll('a')) a.fire('click', {});
      for (const c of r.log.children) c.fire('click', {});
      await flush();
      expect(r.pageFetches).toEqual([]);
      expect(r.dialog.open).toBe(false);
      expect(FakeEl.htmlWrites.filter((w) => w.el === r.dbody)).toEqual([]);
      expect(r.location.href).toBe('/chat/1');
    });

    test('the countdown shows the minutes left, then Expired with Stage it again, which fills but does not send', () => {
      const r = runScript({ now: T + 9 * MIN });
      r.emit('card', { card: pendingCard() });
      const card = cardOf(r.log);
      expect(card.querySelector('.expiry')?.textContent).toBe('Confirm within 1 min');
      expect(r.tickMs()).toBe(30_000);
      r.clock.now = T + 10 * MIN;
      r.tick();
      expect(card.querySelector('.state')?.textContent).toBe('Expired');
      expect(card.querySelector('.review')).toBeNull();
      expect(card.querySelector('.expiry')).toBeNull();
      press(card.querySelector('.restage'));
      expect(r.box.value).toBe('Stage this change again: Turn off CI in main');
      expect(FakeEl.focused).toBe(r.box);
      expect(r.fetches).toEqual([]);
      expect(r.pageFetches).toEqual([]);
    });

    test('a stored card from the page is wired the same: its countdown and its button', async () => {
      const stored = new FakeEl('div');
      stored.className = 'msg card pending';
      stored.dataset = {
        card: '7',
        confirm: '/config/confirm/abc',
        created: new Date(T).toISOString(),
      };
      const t = new FakeEl('div');
      t.className = 'text';
      t.textContent = 'Turn off CI in main';
      const exp = new FakeEl('small');
      exp.className = 'expiry';
      const review = new FakeEl('button');
      review.className = 'review';
      stored.append(t, exp, review);
      const r = runScript({ now: T + 4 * MIN + 1, cards: [stored] });
      expect(exp.textContent).toBe('Confirm within 6 min');
      press(review);
      expect(r.pageFetches[0]?.url).toBe('/config/confirm/abc?frame=1');
    });

    test('server render: a pending card whose change is gone is Expired; one still pending has the button', async () => {
      const w = world();
      const th = createThread(w.db, { title: 'Settings' }, t0);
      const owner = appendMessage(
        w.db,
        th.id,
        { role: 'owner', text: 'ci off', state: 'done' },
        t0,
      );
      const live = w.store.confirmations.addPending({
        sessionIdHash: sha256Hex(w.sid),
        patch: {},
        expectRevision: w.store.revision(),
        meta: { via: 'ui' } as never,
        guarded: [],
        notes: [],
      });
      const card = (id: string, summary: string) =>
        recordCard(
          w.db,
          {
            threadId: th.id,
            messageId: owner.id,
            kind: 'setting',
            state: 'pending',
            link: `/config/confirm/${id}`,
            summary,
            undo: { paths: ['x'], what: 'x' },
          },
          t0,
        );
      const gone = card('gone-id', 'Gone change');
      const waiting = card(live.id, 'Live change');
      const res = await w.app.inject({ method: 'GET', url: `/chat/${th.id}`, headers: w.session });
      const of = (id: number, body = res.body) =>
        new RegExp(
          `<div class="msg card [^"]*" data-card="${id}"[^>]*>.*?</div>(?=<div class="msg|</div><form)`,
        ).exec(body)?.[0] ?? '';
      expect(of(gone.id)).toContain('Expired');
      expect(of(gone.id)).toContain('Stage it again');
      expect(of(gone.id)).not.toContain('Review and confirm');
      expect(of(waiting.id)).toContain('Review and confirm');
      expect(of(waiting.id)).toContain(`data-confirm="/config/confirm/${live.id}"`);
      expect(of(waiting.id)).toContain('Confirm within 10 min');
      expect(res.body).toContain('<dialog id="confirm-dialog"');
      // The stored cards are unchanged.
      expect(listCards(w.db, th.id).map((c) => c.state)).toEqual(['pending', 'pending']);
      // Another session sees the live one as Expired too.
      const other = operatorSession(w.db, t0);
      const theirs = await w.app.inject({
        method: 'GET',
        url: `/chat/${th.id}`,
        headers: { host: HOST, ...other.headers },
      });
      expect(of(waiting.id, theirs.body)).toContain('Expired');
      expect(of(waiting.id, theirs.body)).not.toContain('Review and confirm');
      // At createdAt + PENDING_MS the page says Expired by the clock alone.
      expect(renderThread(th, [], [waiting], { now: plus(t0, PENDING_MS) })).toContain('Expired');
    });
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
