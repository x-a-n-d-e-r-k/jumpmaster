import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { insertDrop, insertStick, stampStick, updateDrop } from '../db/repo.js';
import { harness } from '../test/flowHarness.js';
import { LIVE_MARKER, LIVE_SCRIPT, page, renderHome, statusBanner } from './pages.js';

/** A `<main>` as a string, with `[data-live-ignore]` spans its only elements. */
function fakeMain(html: string) {
  const m = {
    html,
    get innerHTML() {
      return m.html;
    },
    querySelectorAll(sel: string) {
      expect(sel).toBe('[data-live-ignore]');
      return (m.html.match(/<span data-live-ignore>.*?<\/span>/g) ?? []).map((s) => ({
        remove: () => {
          m.html = m.html.replace(s, '');
        },
      }));
    },
  };
  return m;
}

class FakeDOMParser {
  parseFromString(text: string, type: string) {
    expect(type).toBe('text/html');
    const inner = /<main[^>]*>([\s\S]*)<\/main>/.exec(text)?.[1];
    return {
      querySelector: (sel: string) =>
        sel === 'main' && inner !== undefined ? fakeMain(inner) : null,
    };
  }
}

type Field = {
  tagName: string;
  type?: string;
  value?: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  options?: { selected: boolean; defaultSelected: boolean }[];
};

/** Runs LIVE_SCRIPT against fakes; `answer` is the next fetch's response (or a rejection). */
function live() {
  const state = {
    answer: (): Promise<{
      status: number;
      redirected?: boolean;
      url?: string;
      text: () => Promise<string>;
    }> => Promise.resolve(ok('<main>one</main>')),
  };
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  let interval: (() => unknown) | undefined;
  let intervalMs = 0;
  const listeners: Record<string, (() => void)[]> = {};
  const reload = { count: 0 };
  const textarea: Field = { tagName: 'TEXTAREA', value: '', defaultValue: '' };
  const forms: { elements: Field[] }[] = [{ elements: [textarea] }];
  const mainEl = {
    contains: (el: unknown) => el === textarea,
    querySelectorAll: (sel: string) => (sel === 'form' ? forms : []),
  };
  const askPanel = { hidden: true };
  const killDialog = { open: false };
  const document = {
    visibilityState: 'visible',
    activeElement: null as unknown,
    querySelector: (sel: string) => (sel === 'main' ? mainEl : null),
    getElementById: (id: string) =>
      id === 'ask-panel' ? askPanel : id === 'kill-dialog' ? killDialog : null,
    addEventListener: (ev: string, fn: () => void) => {
      (listeners[ev] ??= []).push(fn);
    },
  };
  const ctx = vm.createContext({
    document,
    DOMParser: FakeDOMParser,
    URL,
    location: {
      pathname: '/briefings',
      search: '?zone=main',
      origin: 'http://jm.test',
      reload: () => {
        reload.count++;
      },
    },
    fetch: (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init });
      return state.answer();
    },
    setInterval: (fn: () => unknown, ms: number) => {
      interval = fn;
      intervalMs = ms;
      return 1;
    },
    clearInterval: () => {
      interval = undefined;
    },
  });
  vm.runInContext(LIVE_SCRIPT.replace(/^<script>|<\/script>$/g, ''), ctx);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    state,
    calls,
    reload,
    document,
    askPanel,
    killDialog,
    textarea,
    forms,
    listeners,
    intervalMs: () => intervalMs,
    async tick() {
      await interval?.();
      await flush();
    },
    flush,
  };
}

const ok = (html: string, status = 200) => ({
  status,
  redirected: false,
  url: 'http://jm.test/briefings?zone=main',
  text: async () => html,
});

describe('LIVE_SCRIPT', () => {
  test('polls every 10 seconds with the page URL; the first fetch is the baseline, a changed main reloads once', async () => {
    const w = live();
    expect(w.intervalMs()).toBe(10_000);
    await w.tick();
    expect(w.calls[0]).toEqual({
      url: '/briefings?zone=main',
      init: { credentials: 'same-origin', cache: 'no-store' },
    });
    expect(w.reload.count).toBe(0);
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
    await w.tick();
    expect(w.reload.count).toBe(1);
    await w.tick();
    expect(w.reload.count).toBe(1);
  });

  test('a difference only inside [data-live-ignore] does not reload', async () => {
    const w = live();
    w.state.answer = () => Promise.resolve(ok('<main>a <span data-live-ignore>3s</span> b</main>'));
    await w.tick();
    w.state.answer = () =>
      Promise.resolve(ok('<main>a <span data-live-ignore>13s</span> b</main>'));
    await w.tick();
    await w.tick();
    expect(w.reload.count).toBe(0);
  });

  test('a focused textarea in main holds the reload until focus leaves and the next tick comes', async () => {
    const w = live();
    await w.tick();
    w.document.activeElement = w.textarea;
    w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.document.activeElement = null;
    expect(w.reload.count).toBe(0);
    await w.tick();
    expect(w.reload.count).toBe(1);
  });

  test('an open Ask panel holds the reload, so a draft in its frame survives (#626)', async () => {
    const w = live();
    await w.tick();
    w.askPanel.hidden = false;
    // Typing in the panel's frame: the parent sees the IFRAME as the active element.
    w.document.activeElement = { tagName: 'IFRAME' };
    w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
    await w.tick();
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.askPanel.hidden = true;
    w.document.activeElement = null;
    await w.tick();
    expect(w.reload.count).toBe(1);
  });

  test('an open kill switch confirmation holds the reload, so the dialog is not closed mid-confirmation (#628)', async () => {
    const w = live();
    await w.tick();
    w.killDialog.open = true;
    // Focus sits on the dialog's Engage button, in the header, not in main.
    w.document.activeElement = { tagName: 'BUTTON' };
    w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
    await w.tick();
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.killDialog.open = false;
    w.document.activeElement = null;
    await w.tick();
    expect(w.reload.count).toBe(1);
  });

  test('a form field whose value differs from its default holds the reload', async () => {
    const w = live();
    await w.tick();
    w.textarea.value = 'half a note';
    w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
    await w.tick();
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.textarea.value = '';
    await w.tick();
    expect(w.reload.count).toBe(1);
  });

  test('a changed checkbox or select also counts as an unsaved change', async () => {
    for (const field of [
      {
        tagName: 'INPUT',
        type: 'checkbox',
        checked: true,
        defaultChecked: false,
        value: 'on',
        defaultValue: 'on',
      },
      {
        tagName: 'SELECT',
        options: [
          { selected: false, defaultSelected: true },
          { selected: true, defaultSelected: false },
        ],
      },
    ]) {
      const w = live();
      w.forms[0]?.elements.push(field);
      await w.tick();
      w.state.answer = () => Promise.resolve(ok('<main>two</main>'));
      await w.tick();
      expect(w.reload.count, field.tagName).toBe(0);
    }
  });

  test('a hidden tab does not fetch; becoming visible checks at once', async () => {
    const w = live();
    w.document.visibilityState = 'hidden';
    await w.tick();
    await w.tick();
    expect(w.calls).toHaveLength(0);
    w.document.visibilityState = 'visible';
    for (const fn of w.listeners.visibilitychange ?? []) fn();
    await w.flush();
    expect(w.calls).toHaveLength(1);
  });

  test('a 401 stops the polling', async () => {
    const w = live();
    w.state.answer = () => Promise.resolve(ok('', 401));
    await w.tick();
    await w.tick();
    await w.tick();
    expect(w.calls).toHaveLength(1);
  });

  test('a redirect to the login page stops the polling', async () => {
    const w = live();
    w.state.answer = () =>
      Promise.resolve({
        status: 200,
        redirected: true,
        url: 'http://jm.test/login?next=%2Fbriefings',
        text: async () => '<main>Sign in</main>',
      });
    await w.tick();
    await w.tick();
    expect(w.calls).toHaveLength(1);
    expect(w.reload.count).toBe(0);
  });

  test('a rejected fetch or a non-200 answer is ignored, and the next tick fetches again', async () => {
    const w = live();
    await w.tick();
    w.state.answer = () => Promise.reject(new Error('offline'));
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.state.answer = () => Promise.resolve(ok('<main>error page</main>', 502));
    await w.tick();
    expect(w.reload.count).toBe(0);
    w.state.answer = () => Promise.resolve(ok('<main>one</main>'));
    await w.tick();
    expect(w.calls).toHaveLength(4);
    expect(w.reload.count).toBe(0);
  });
});

describe('live pages', () => {
  test('page() adds LIVE_SCRIPT after NAV_SCRIPT only with live', () => {
    expect(page('x')).not.toContain(LIVE_MARKER);
    const html = page('x', { live: true });
    expect(html).toContain(LIVE_SCRIPT);
    expect(html.indexOf(LIVE_SCRIPT)).toBeGreaterThan(
      html.indexOf("querySelectorAll('.topnav a')"),
    );
  });

  test('Home carries the live script', async () => {
    const h = await harness();
    for (const url of ['/']) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(LIVE_MARKER);
    }
    for (const url of ['/drops', '/work', '/chat']) {
      const res = await h.view(url);
      expect(res.body, url).not.toContain(LIVE_MARKER);
    }
  });

  test("GET /'s <main>, less its data-live-ignore spans, is the same at two clock times while a drop runs", async () => {
    const h = await harness();
    await h.sync();
    insertDrop(h.db, {
      id: 'tick-drop',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    updateDrop(h.db, 'tick-drop', { startedAt: '2026-01-01T00:00:00.000Z' });
    insertStick(h.db, { id: 'live', name: 'stick-live', tokenHash: 'hl', slots: 1 });
    // The stick checks in at each render, so the status line is the running drop's.
    const main = async () => {
      stampStick(
        h.db,
        'live',
        { capabilities: ['egress-v1'], imagePolicy: 'allowlist', version: '1', pinnedImages: [] },
        h.now(),
      );
      const body = (await h.view('/')).body;
      const inner = /<main[^>]*>([\s\S]*)<\/main>/.exec(body)?.[1] ?? '';
      return inner.replace(/<span data-live-ignore>[^<]*<\/span>/g, '');
    };
    const first = await main();
    expect(first).toContain('Working: crew-lead in');
    h.at(0.25);
    const second = await main();
    h.at(3);
    expect(await main()).toBe(first);
    expect(second).toBe(first);
  });

  test("the status banner wraps the headline's clock-driven part in data-live-ignore", () => {
    const html = statusBanner({
      headline: 'Waiting on CI for PR #12 (20 of 45 min)',
      volatile: '(20 of 45 min)',
      detail: '',
      waitingOn: 'ci',
    });
    expect(html).toContain(
      '<strong>Waiting on CI for PR #12 <span data-live-ignore>(20 of 45 min)</span></strong>',
    );
  });

  test("Home's paused-until time is volatile: relative, inside data-live-ignore (#625)", () => {
    const html = renderHome({
      zones: [],
      items: [],
      drops: [],
      now: new Date('2026-11-18T10:00:00.000Z'),
      usage: {
        gate: 'closed',
        state: { status: 'rejected', pausedUntil: '2026-11-18T12:00:00.000Z' },
        plan: 'max',
        windows: [],
      },
    } as unknown as Parameters<typeof renderHome>[0]);
    expect(html).toContain(
      'Dispatch paused until <span data-live-ignore><time datetime="2026-11-18T12:00:00.000Z" title="2026-11-18T12:00:00.000Z">in 2 h</time></span>',
    );
  });
});
