import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { getUsageState, setUsageState } from '../db/repo.js';
import { harness } from '../test/flowHarness.js';
import { operatorSession } from '../test/helpers.js';
import { setUsageOverride } from '../usage.js';
import { USAGE_OVERRIDE_SCRIPT } from './usage-override.js';

const H = 3_600_000;
const HOST = 'localhost:80';
const URL_ = '/api/control/usage/override';

/** The text of an HTML fragment: every character outside a `<...>` tag, in order. */
function textOf(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (ch === '<') inTag = true;
    else if (ch === '>' && inTag) inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** The body of a `<script>...</script>` string, for running in a VM context. */
function scriptBody(script: string): string {
  const open = '<script>';
  const close = '</script>';
  expect(script.startsWith(open) && script.endsWith(close)).toBe(true);
  return script.slice(open.length, script.length - close.length);
}

/** A real app and session; `throttle` puts weekly usage over the throttle, resetting in 36 h. */
async function world(o: { throttle?: boolean; override?: boolean } = {}) {
  const h = await harness();
  const now = h.now();
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  if (o.throttle ?? true)
    setUsageState(
      h.db,
      {
        status: 'allowed_warning',
        warningWindow: 'five_hour',
        warningAt: at(0),
        sevenDayUtil: 0.81,
        sevenDayResetsAt: at(36 * H + 30 * 60_000),
      },
      now,
    );
  if (o.override) setUsageOverride(h.db, { starts: 5, hours: 3, by: 'session' }, now);
  const home = async () => {
    const r = await h.view('/', { host: HOST });
    expect(r.statusCode, r.body).toBe(200);
    return r.body;
  };
  return { h, now, at, home };
}

describe('Home: Run the next cycle anyway (#729)', () => {
  test('throttled with no override: the button and its dialog, with the starts, hours, ceiling, usage and reset', async () => {
    const { home } = await world();
    const html = await home();
    expect(html).toContain('id="usage-override-open"');
    expect(html).toContain('Run the next cycle anyway');
    expect(html).toContain('id="usage-override-dialog"');
    expect(html).not.toContain('id="usage-override-stop"');
    const text = /<p id="usage-override-what">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    const plain = textOf(text);
    expect(plain).toBe(
      "Jumpmaster will start up to 5 new drops in the next 3 hours despite Claude's usage warning. It stops early if usage reaches 95% or Claude refuses a request. Weekly usage is 81%, resetting at 2 Jan 12:30 UTC.",
    );
    expect(html).toContain(USAGE_OVERRIDE_SCRIPT);
  });

  test('an override in force: the starts left and the stop button, and no run button', async () => {
    const { home } = await world({ override: true });
    const html = await home();
    expect(textOf(html)).toContain('Usage override: 5 of 5 starts left, until 03:00 UTC');
    expect(html).toContain('id="usage-override-stop"');
    expect(html).toContain('Stop the override');
    expect(html).not.toContain('id="usage-override-open"');
  });

  test('not throttled: neither button', async () => {
    const { home } = await world({ throttle: false });
    const html = await home();
    expect(html).not.toContain('id="usage-override-open"');
    expect(html).not.toContain('id="usage-override-stop"');
  });

  test('the session sets it with the CSRF header, and the page then shows 5 of 5; DELETE clears it', async () => {
    const { h, home } = await world();
    const s = operatorSession(h.db, h.now());
    const set = await h.app.inject({
      method: 'POST',
      url: URL_,
      headers: {
        host: HOST,
        cookie: s.cookie,
        'x-jm-csrf': s.csrf,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(textOf(await home())).toContain('5 of 5 starts left');
    const stop = await h.app.inject({
      method: 'DELETE',
      url: URL_,
      headers: {
        host: HOST,
        cookie: s.cookie,
        'x-jm-csrf': s.csrf,
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(await home()).toContain('id="usage-override-open"');
  });

  test('a session POST without x-jm-csrf is refused and sets nothing', async () => {
    const { h } = await world();
    const s = operatorSession(h.db, h.now());
    const r = await h.app.inject({
      method: 'POST',
      url: URL_,
      headers: { host: HOST, cookie: s.cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(403);
    expect(getUsageState(h.db).overrideUntil).toBeNull();
  });
});

describe('the usage override script (#729)', () => {
  class Node {
    textContent = '';
    disabled = false;
    open = false;
    listeners: Record<string, (() => unknown)[]> = {};
    addEventListener(ev: string, fn: () => unknown) {
      (this.listeners[ev] ??= []).push(fn);
    }
    async click() {
      await Promise.all((this.listeners.click ?? []).map((fn) => fn()));
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
    }
    focus() {}
  }

  const IDS = [
    'usage-override-open',
    'usage-override-dialog',
    'usage-override-confirm',
    'usage-override-cancel',
    'usage-override-err',
    'usage-override-stop',
    'usage-override-stop-err',
  ];

  function run(present: string[], status = 200, error?: string) {
    const ids: Record<string, Node> = Object.fromEntries(present.map((id) => [id, new Node()]));
    const calls: { url: string; body: unknown; method: unknown }[] = [];
    let reloads = 0;
    const ctx = vm.createContext({
      document: { getElementById: (id: string) => ids[id] ?? null },
      location: { reload: () => reloads++ },
      alert: () => {
        throw new Error('alert called');
      },
      jmFetch: async (url: string, body: unknown, method?: unknown) => {
        calls.push({ url, body, method });
        return {
          ok: status < 300,
          status,
          json: async () => (error === undefined ? {} : { error }),
        };
      },
    });
    vm.runInContext(scriptBody(USAGE_OVERRIDE_SCRIPT), ctx);
    const n = (id: string) => ids[id] as Node;
    return { n, calls, reloads: () => reloads };
  }
  const runRow = IDS.slice(0, 5);
  const stopRow = IDS.slice(5);

  test('the button opens the dialog and sends nothing; Cancel shuts it', async () => {
    const k = run(runRow);
    await k.n('usage-override-open').click();
    expect(k.n('usage-override-dialog').open).toBe(true);
    await k.n('usage-override-cancel').click();
    expect(k.n('usage-override-dialog').open).toBe(false);
    expect(k.calls).toEqual([]);
  });

  test('confirming POSTs to the route with no body, once, then reloads', async () => {
    const k = run(runRow);
    await k.n('usage-override-open').click();
    const c = k.n('usage-override-confirm');
    await Promise.all([c.click(), c.click()]);
    expect(k.calls).toEqual([{ url: URL_, body: undefined, method: 'POST' }]);
    expect(k.reloads()).toBe(1);
  });

  test("a 409 shows the server's error in the dialog and does not reload", async () => {
    const k = run(runRow, 409, 'nothing to override');
    await k.n('usage-override-open').click();
    await k.n('usage-override-confirm').click();
    expect(k.n('usage-override-dialog').open).toBe(true);
    expect(k.n('usage-override-err').textContent).toBe('Refused (409): nothing to override');
    expect(k.reloads()).toBe(0);
  });

  test('Stop sends DELETE to the route, then reloads; a failure is said', async () => {
    const k = run(stopRow);
    await k.n('usage-override-stop').click();
    expect(k.calls).toEqual([{ url: URL_, body: undefined, method: 'DELETE' }]);
    expect(k.reloads()).toBe(1);
    const bad = run(stopRow, 500, 'boom');
    await bad.n('usage-override-stop').click();
    expect(bad.n('usage-override-stop-err').textContent).toBe('Refused (500): boom');
    expect(bad.reloads()).toBe(0);
  });
});
