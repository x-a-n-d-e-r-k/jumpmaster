import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import { routeClass } from '../auth/guard.js';
import { SetupMode } from '../auth/operator.js';
import { grantSudo, sha256Hex } from '../auth/sessions.js';
import { loadBoot } from '../config/boot.js';
import { getSetting } from '../config/revisions.js';
import { ConfigStore, startVault } from '../config/store.js';
import { type Db, openDb } from '../db/open.js';
import { APP_MANIFEST_PERMISSIONS, appManifest } from '../github/app-manifest.js';
import { PROJECT_URL } from '../project.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { appEntryName, parseAppEntry } from '../vault/github-app-entries.js';
import { openVault } from '../vault/vault.js';
import { AppManifestStore, PENDING_TTL_MS } from './app-manifest-state.js';
import { redactManifestUrl, sweepPendingApps } from './github-app-routes.js';

const HOST = '127.0.0.1:7420';
const LAN = 'jm.lan:7420';
const OWNER = 'acme';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const CLIENT_SECRET = 'client-secret-0123456789abcdef';
const WEBHOOK_SECRET = 'webhook-secret-0123456789abcdef';
const CODE = 'manifestcode0123456789';
const PEM_BODY = PEM.split('\n').find((l) => l.length > 40) as string;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type FetchCall = { url: string; method: string };

/** A fake GitHub conversion endpoint: answers with the app, or with `status`. */
function fakeGitHub(o: { status?: number; login?: string; slug?: string } = {}) {
  const calls: FetchCall[] = [];
  let role: 'author' | 'reviewer' = 'author';
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (o.status && o.status !== 201)
      return new Response('{"message":"nope"}', { status: o.status });
    return new Response(
      JSON.stringify({
        id: 4242,
        slug: o.slug ?? 'jumpmaster-author-acme',
        client_id: 'Iv23liClient0001',
        pem: PEM,
        client_secret: CLIENT_SECRET,
        webhook_secret: WEBHOOK_SECRET,
        owner: { login: o.login ?? 'Acme' },
        permissions: APP_MANIFEST_PERMISSIONS[role],
      }),
      { status: 201 },
    );
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    setRole(r: 'author' | 'reviewer') {
      role = r;
    },
  };
}

/** A file-mode install with a vault (unless `vaultOff`) and one two-bot zone on `acme/demo`. */
async function world(
  o: {
    vaultOff?: boolean;
    db?: Db;
    dbFile?: string;
    file?: Record<string, unknown>;
    github?: ReturnType<typeof fakeGitHub>;
    manifestStore?: AppManifestStore;
  } = {},
) {
  const dbFile = o.dbFile ?? tmpDbFile();
  const db = o.db ?? openDb(dbFile);
  const dir = mkdtempSync(join(tmpdir(), 'jm-app-routes-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  writeFileSync(
    filePath,
    JSON.stringify({
      dataDir: './data',
      listen: { port: 7420, allowedHosts: [HOST, LAN] },
      dropZones: [
        {
          id: 'main',
          repo: `${OWNER}/demo`,
          gates: [{ name: 'test', run: 'npm test' }],
          image: 'jm-trooper:dev',
        },
      ],
      ...o.file,
    }),
  );
  const env = {
    JM_CLAUDE_TOKEN: 'claude-token-value-1',
    JM_GITHUB_AUTHOR_TOKEN: 'author-token-value-1',
    JM_GITHUB_REVIEWER_TOKEN: 'reviewer-token-value-1',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: 'o'.repeat(32),
    JM_DEV_IMAGES: '1',
  };
  let clock = t0;
  const store = ConfigStore.open({
    db,
    boot: loadBoot(env, filePath),
    filePath,
    env,
    vault: o.vaultOff ? startVault(env, db) : openVault(keyFile, db),
    now: () => clock,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const manifestStore = o.manifestStore ?? new AppManifestStore({ now: () => clock.getTime() });
  const github = o.github ?? fakeGitHub();
  const logs: string[] = [];
  const scrubbed: string[] = [];
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no zone forge in this test');
    },
    now: () => clock,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    log: (m) => logs.push(m),
    appManifestStore: manifestStore,
    appManifestFetch: github.fetch,
    appManifestApiBase: 'https://api.github.test',
    scrub: { add: (secret: string) => scrubbed.push(secret) },
  });
  app = a;
  const session = (sudo: boolean) => {
    const s = operatorSession(db, clock);
    if (sudo) grantSudo(db, sha256Hex(s.id), clock);
    return s;
  };
  const responses: { url: string; body: string; headers: string }[] = [];
  const keep = <R extends { body: string; headers: Record<string, unknown> }>(
    url: string,
    r: R,
  ) => {
    responses.push({ url, body: r.body, headers: JSON.stringify(r.headers) });
    return r;
  };
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
  return {
    db,
    dbFile,
    store,
    manifestStore,
    github,
    logs,
    scrubbed,
    responses,
    session,
    at(d: Date) {
      clock = d;
    },
    async start(
      cookie: string | undefined,
      fields: Record<string, string> = { owner: OWNER, role: 'author', ownerType: 'Organization' },
      host = HOST,
    ) {
      return keep(
        '/setup/github-app/start',
        await a.inject({
          method: 'POST',
          url: '/setup/github-app/start',
          headers: {
            host,
            'content-type': 'application/x-www-form-urlencoded',
            ...(cookie ? { cookie } : {}),
          },
          payload: form(fields),
        }),
      );
    },
    async callback(query: Record<string, string>) {
      const url = `/setup/github-app/callback?${new URLSearchParams(query).toString()}`;
      return keep(url, await a.inject({ method: 'GET', url, headers: { host: HOST } }));
    },
    async finish(cookie: string | undefined, id: string) {
      return keep(
        '/setup/github-app/finish',
        await a.inject({
          method: 'POST',
          url: '/setup/github-app/finish',
          headers: {
            host: HOST,
            'content-type': 'application/x-www-form-urlencoded',
            ...(cookie ? { cookie } : {}),
          },
          payload: form({ id }),
        }),
      );
    },
  };
}

const unescape = (v: string): string =>
  v
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const formAction = (html: string): string => {
  // The page chrome's logout form aside.
  const actions = [...html.matchAll(/<form[^>]*action="([^"]*)"/g)]
    .map((m) => unescape(m[1] as string))
    .filter((a) => a !== '/logout');
  if (actions.length !== 1) throw new Error(`expected one form, found ${actions.length}`);
  return actions[0] as string;
};

const hidden = (html: string, name: string): string => {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m?.[1]) throw new Error(`no ${name} field`);
  return unescape(m[1]);
};

const stateOf = (html: string): string =>
  new URL(formAction(html)).searchParams.get('state') as string;

const vaultRows = (db: Db): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM vault').get() as { n: number }).n;

describe('start', () => {
  test('for an organization the form posts the manifest to its registration URL, with a state bound to the session, owner and role', async () => {
    const w = await world();
    const s = w.session(true);
    const r = await w.start(s.cookie);
    expect(r.statusCode, r.body).toBe(200);
    const action = formAction(r.body);
    expect(action).toMatch(
      new RegExp(`^https://github\\.com/organizations/${OWNER}/settings/apps/new\\?state=`),
    );
    expect(r.body).toContain('Continue to GitHub');
    const manifest = JSON.parse(hidden(r.body, 'manifest')) as Record<string, unknown>;
    const installId = getSetting(w.db, 'github_app.install_id') as string;
    expect(manifest).toEqual(
      appManifest('author', {
        baseUrl: `http://${HOST}`,
        installId,
        projectUrl: PROJECT_URL,
      }),
    );
    const perms = manifest.default_permissions as Record<string, string>;
    expect(perms).not.toHaveProperty('administration');
    expect(perms).not.toHaveProperty('workflows');
    // The state is bound: consuming it gives the session, owner and role.
    expect(w.manifestStore.consumeState(stateOf(r.body))).toEqual({
      sessionId: sha256Hex(s.id),
      owner: OWNER,
      role: 'author',
    });
  });

  test('for a user the form posts to the personal registration URL', async () => {
    const w = await world();
    const s = w.session(true);
    const r = await w.start(s.cookie, { owner: OWNER, role: 'reviewer', ownerType: 'User' });
    expect(r.statusCode).toBe(200);
    expect(formAction(r.body)).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    const manifest = JSON.parse(hidden(r.body, 'manifest')) as { name: string };
    expect(manifest.name).toMatch(/^Jumpmaster reviewer \(/);
  });

  test('an invalid field is refused with 400', async () => {
    const w = await world();
    const s = w.session(true);
    for (const fields of [
      { owner: 'not an owner!', role: 'author', ownerType: 'User' },
      { owner: OWNER, role: 'admin', ownerType: 'User' },
      { owner: OWNER, role: 'author', ownerType: 'Enterprise' },
      { owner: OWNER, role: 'author' },
    ])
      expect((await w.start(s.cookie, fields as Record<string, string>)).statusCode).toBe(400);
  });

  test('without sudo: 403 asking for the passphrase, and no state is minted', async () => {
    const w = await world();
    const s = w.session(false);
    const r = await w.start(s.cookie);
    expect(r.statusCode).toBe(403);
    expect(r.body).toMatch(/passphrase/);
    const c = await w.callback({ code: CODE, state: 'x'.repeat(43) });
    expect(c.statusCode).toBe(400);
    expect(w.github.calls).toHaveLength(0);
  });

  test('with the vault disabled: 409 asking to turn it on, and no state is minted', async () => {
    const minted: string[] = [];
    const manifestStore = new AppManifestStore({ now: () => t0.getTime() });
    const mint = manifestStore.mintState.bind(manifestStore);
    manifestStore.mintState = (b) => {
      const st = mint(b);
      minted.push(st);
      return st;
    };
    const w = await world({ vaultOff: true, manifestStore });
    const s = w.session(true);
    const r = await w.start(s.cookie);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatch(/vault/i);
    expect(minted).toHaveLength(0);
  });

  test('a full state store: 429', async () => {
    const manifestStore = new AppManifestStore({ now: () => t0.getTime() });
    manifestStore.mintState = () => {
      throw new Error('manifest state: too many app creations in progress; try again later');
    };
    const w = await world({ manifestStore });
    const s = w.session(true);
    expect((await w.start(s.cookie)).statusCode).toBe(429);
  });

  test('the plain-HTTP warning shows on an http:// non-loopback base, not on https:// or loopback', async () => {
    const w = await world();
    const s = w.session(true);
    const lan = await w.start(s.cookie, undefined, LAN);
    expect(lan.statusCode, lan.body).toBe(200);
    expect(lan.body).toMatch(/clear text/);
    expect(lan.body).toMatch(/HTTPS/);
    const loop = await w.start(s.cookie);
    expect(loop.body).not.toMatch(/clear text/);
    await app?.close();
    const h = await world({ file: { server: { publicUrl: 'https://jm.example.ts.net' } } });
    const s2 = h.session(true);
    const tls = await h.start(s2.cookie, undefined, LAN);
    expect(tls.statusCode).toBe(200);
    expect(tls.body).not.toMatch(/clear text/);
    const manifest = JSON.parse(hidden(tls.body, 'manifest')) as { redirect_url: string };
    expect(manifest.redirect_url).toBe('https://jm.example.ts.net/setup/github-app/callback');
  });

  test('the install id is generated once, stored, and reused across starts and app instances', async () => {
    const w = await world();
    const s = w.session(true);
    const name = async () =>
      (JSON.parse(hidden((await w.start(s.cookie)).body, 'manifest')) as { name: string }).name;
    const first = await name();
    const id = getSetting(w.db, 'github_app.install_id');
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(first).toBe(`Jumpmaster author (${id as string})`);
    expect(await name()).toBe(first);
    await app?.close();
    const again = await world({ db: w.db });
    const s2 = again.session(true);
    const m = JSON.parse(hidden((await again.start(s2.cookie)).body, 'manifest')) as {
      name: string;
    };
    expect(m.name).toBe(first);
  });
});

/** Start (with sudo) then the callback; returns the session and the callback response. */
async function through(
  w: Awaited<ReturnType<typeof world>>,
  role: 'author' | 'reviewer' = 'author',
) {
  const s = w.session(true);
  w.github.setRole(role);
  const start = await w.start(s.cookie, { owner: OWNER, role, ownerType: 'Organization' });
  expect(start.statusCode, start.body).toBe(200);
  const state = stateOf(start.body);
  const cb = await w.callback({ code: CODE, state });
  return { s, state, cb };
}

describe('callback', () => {
  test('with no cookie: one conversion request, a Finish form, no-store and no-referrer; the same state again is 400 with no second request', async () => {
    const w = await world();
    const { state, cb } = await through(w);
    expect(cb.statusCode, cb.body).toBe(200);
    expect(w.github.calls).toEqual([
      {
        url: `https://api.github.test/app-manifests/${CODE}/conversions`,
        method: 'POST',
      },
    ]);
    expect(formAction(cb.body)).toBe('/setup/github-app/finish');
    expect(cb.body).toContain('Finish');
    expect(hidden(cb.body, 'id')).not.toBe('');
    expect(cb.headers['cache-control']).toBe('no-store');
    expect(cb.headers['referrer-policy']).toBe('no-referrer');
    const again = await w.callback({ code: CODE, state });
    expect(again.statusCode).toBe(400);
    expect(again.body).toMatch(/start again/i);
    expect(again.headers['cache-control']).toBe('no-store');
    expect(again.headers['referrer-policy']).toBe('no-referrer');
    expect(w.github.calls).toHaveLength(1);
  });

  test('an unknown or missing state: 400 and no request to GitHub', async () => {
    const w = await world();
    expect((await w.callback({ code: CODE, state: 'unknown-state-value' })).statusCode).toBe(400);
    expect((await w.callback({ code: CODE })).statusCode).toBe(400);
    expect(w.github.calls).toHaveLength(0);
  });

  test('an unknown state leaves the log scrub set unchanged', async () => {
    const w = await world();
    const before = [...w.scrubbed];
    await w.callback({ code: 'attacker-chosen-code', state: 'jumpmaster-repository' });
    await w.callback({ code: 'another-attacker-code' });
    expect(w.scrubbed).toEqual(before);
  });

  test('a valid state registers the code and state for the log scrub', async () => {
    const w = await world();
    const s = w.session(true);
    const start = await w.start(s.cookie);
    const state = stateOf(start.body);
    await w.callback({ code: CODE, state });
    expect(w.scrubbed).toContain(CODE);
    expect(w.scrubbed).toContain(state);
  });

  test('an expired state: 400 and no request to GitHub', async () => {
    const w = await world();
    const s = w.session(true);
    const start = await w.start(s.cookie);
    w.at(plus(t0, 10 * 60_000 + 1000));
    expect((await w.callback({ code: CODE, state: stateOf(start.body) })).statusCode).toBe(400);
    expect(w.github.calls).toHaveLength(0);
  });

  test('a failed owner check names the slug, maps to 502 (a 201 response), and leaves the vault unchanged', async () => {
    const w = await world({ github: fakeGitHub({ login: 'someone-else' }) });
    const before = vaultRows(w.db);
    const { cb } = await through(w);
    expect(cb.statusCode).toBe(502);
    expect(cb.body).toContain('jumpmaster-author-acme');
    expect(cb.body).toMatch(/delete/);
    expect(vaultRows(w.db)).toBe(before);
    expect(cb.headers['referrer-policy']).toBe('no-referrer');
  });

  test('a used code (GitHub 404) maps to 400, a refused code (status 0) to 400, a 5xx to 502', async () => {
    const used = await world({ github: fakeGitHub({ status: 404 }) });
    expect((await through(used)).cb.statusCode).toBe(400);
    await app?.close();
    const bad = await world();
    const s = bad.session(true);
    const st = stateOf((await bad.start(s.cookie)).body);
    const r = await bad.callback({ code: 'not a code!', state: st });
    expect(r.statusCode).toBe(400);
    expect(bad.github.calls).toHaveLength(0);
    await app?.close();
    const down = await world({ github: fakeGitHub({ status: 503 }) });
    const d = await through(down);
    expect(d.cb.statusCode).toBe(502);
    expect(vaultRows(down.db)).toBe(0);
  });

  test('a full pending store: 503 naming the slug and asking to delete the app', async () => {
    const manifestStore = new AppManifestStore({ now: () => t0.getTime() });
    manifestStore.putPending = () => {
      throw new Error('pending app: too many apps waiting to be finished; try again later');
    };
    const w = await world({ manifestStore });
    const { cb } = await through(w);
    expect(cb.statusCode).toBe(503);
    expect(cb.body).toContain('jumpmaster-author-acme');
    expect(cb.body).toMatch(/delete/i);
  });
});

describe('finish', () => {
  test('from the bound session: writes the entry, resolves it, audits without the PEM, links the install', async () => {
    const w = await world();
    const { s, cb } = await through(w);
    const r = await w.finish(s.cookie, hidden(cb.body, 'id'));
    expect(r.statusCode, r.body).toBe(200);
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('vault expected');
    const raw = vault.get(appEntryName(OWNER, 'author'));
    expect(raw).toBeDefined();
    const entry = parseAppEntry(raw as string);
    expect(entry).toMatchObject({ appId: '4242', slug: 'jumpmaster-author-acme', pem: PEM });
    expect(w.store.resolvedApps().get(OWNER)?.author).toMatchObject({ source: 'vault' });
    const rows = listAudit(w.db).filter((a) => a.action === 'github-app.create');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      owner: OWNER,
      role: 'author',
      slug: 'jumpmaster-author-acme',
      appId: '4242',
    });
    expect(JSON.stringify(rows)).not.toContain(PEM_BODY);
    expect(r.body).toContain('https://github.com/apps/jumpmaster-author-acme/installations/new');
  });

  test('from another session, a second time, or after ten minutes: 400 and the vault unchanged', async () => {
    const w = await world();
    const { s, cb } = await through(w);
    const id = hidden(cb.body, 'id');
    const other = w.session(true);
    const before = vaultRows(w.db);
    const r1 = await w.finish(other.cookie, id);
    expect(r1.statusCode).toBe(400);
    expect(r1.body).toMatch(/delete/i);
    expect(vaultRows(w.db)).toBe(before);
    expect((await w.finish(s.cookie, id)).statusCode).toBe(200);
    const after = vaultRows(w.db);
    expect((await w.finish(s.cookie, id)).statusCode).toBe(400);
    expect(vaultRows(w.db)).toBe(after);

    const late = await world();
    const l = await through(late);
    late.at(plus(t0, PENDING_TTL_MS + 1000));
    const lateSession = l.s;
    const lr = await late.finish(lateSession.cookie, hidden(l.cb.body, 'id'));
    expect(lr.statusCode).toBe(400);
    expect(vaultRows(late.db)).toBe(0);
  });

  test('with the vault disabled: 409 and nothing is written', async () => {
    const manifestStore = new AppManifestStore({ now: () => t0.getTime() });
    const w = await world({ vaultOff: true, manifestStore });
    const s = w.session(false);
    const id = manifestStore.putPending(sha256Hex(s.id), {
      appId: '4242',
      slug: 'jumpmaster-author-acme',
      clientId: 'Iv23liClient0001',
      pem: PEM,
      owner: OWNER,
      role: 'author',
    });
    const r = await w.finish(s.cookie, id);
    expect(r.statusCode).toBe(409);
    expect(vaultRows(w.db)).toBe(0);
    expect(listAudit(w.db).filter((a) => a.action === 'github-app.create')).toHaveLength(0);
  });
});

describe('sweep', () => {
  test('an expired pending is logged once by slug; a second sweep logs nothing', () => {
    let now = t0.getTime();
    const store = new AppManifestStore({ now: () => now });
    store.putPending('session-hash', {
      appId: '1',
      slug: 'jumpmaster-author-acme',
      clientId: 'Iv1',
      pem: PEM,
      owner: OWNER,
      role: 'author',
    });
    const logs: string[] = [];
    sweepPendingApps(store, (m) => logs.push(m));
    expect(logs).toHaveLength(0);
    now += PENDING_TTL_MS + 1;
    sweepPendingApps(store, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('jumpmaster-author-acme');
    expect(logs[0]).toMatch(/delete/);
    expect(logs[0]).not.toContain(PEM_BODY);
    sweepPendingApps(store, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
  });
});

describe('secrets', () => {
  test('code, state, PEM, client and webhook secrets stay out of logs and pages (but the state in the start form)', async () => {
    const w = await world({ github: fakeGitHub({ login: 'someone-else' }) });
    // A failed conversion logs too: run one, then a full flow.
    await through(w);
    await app?.close();
    const ok = await world();
    const { s, state, cb } = await through(ok);
    const fin = await ok.finish(s.cookie, hidden(cb.body, 'id'));
    expect(fin.statusCode).toBe(200);
    const id = hidden(cb.body, 'id');
    for (const [label, logs] of [
      ['failed', w.logs],
      ['ok', ok.logs],
    ] as const) {
      for (const line of logs) {
        for (const secret of [CODE, PEM_BODY, CLIENT_SECRET, WEBHOOK_SECRET, id])
          expect(line, label).not.toContain(secret);
      }
    }
    for (const line of ok.logs) expect(line).not.toContain(state);
    for (const r of ok.responses) {
      for (const secret of [PEM_BODY, CLIENT_SECRET, WEBHOOK_SECRET, CODE])
        expect(`${r.body}${r.headers}`, r.url).not.toContain(secret);
      if (r.url !== '/setup/github-app/start')
        expect(`${r.body}${r.headers}`, r.url).not.toContain(state);
    }
    const audit = JSON.stringify(listAudit(ok.db));
    for (const secret of [CODE, state, PEM_BODY, CLIENT_SECRET, WEBHOOK_SECRET])
      expect(audit).not.toContain(secret);
  });

  test('a logged URL has its code and state redacted', () => {
    expect(redactManifestUrl('/setup/github-app/callback?code=abc123&state=xyz789&x=1')).toBe(
      '/setup/github-app/callback?code=[redacted]&state=[redacted]&x=1',
    );
    expect(redactManifestUrl('https://h/p?state=s')).toBe('https://h/p?state=[redacted]');
  });
});

describe('guard', () => {
  test('the callback is an auth route; start and finish are pages', () => {
    expect(routeClass('/setup/github-app/callback')).toBe('auth');
    expect(routeClass('/setup/github-app/start')).toBe('page');
    expect(routeClass('/setup/github-app/finish')).toBe('page');
    // The setup_url page (issue #344) needs no session; discovery behind it is a page.
    expect(routeClass('/setup/github-app/installed')).toBe('auth');
    expect(routeClass('/setup/github-app/discover')).toBe('page');
  });

  test('with setup inactive, start and finish without a session are 401 and write nothing', async () => {
    const w = await world();
    w.session(true); // makes the operator: setup is over
    expect((await w.start(undefined)).statusCode).toBe(401);
    expect((await w.finish(undefined, 'some-id')).statusCode).toBe(401);
    expect(vaultRows(w.db)).toBe(0);
    expect(getSetting(w.db, 'github_app.install_id')).toBeUndefined();
  });

  test('a callback without a session is served, not redirected', async () => {
    const w = await world();
    const r = await w.callback({ code: CODE, state: 'nope-nope-nope' });
    expect(r.statusCode).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });
});
