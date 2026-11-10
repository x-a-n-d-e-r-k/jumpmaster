import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import type { Config } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import { isKilled, upsertDropZone } from '../db/repo.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { Backoff } from './backoff.js';
import { authenticate, requireCsrf, routeClass } from './guard.js';
import { SetupMode, scryptStats, setOperatorPassphrase, setupActive } from './operator.js';
import { createSession, loadSession, SUDO_MS } from './sessions.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Headers = Record<string, string>;

async function world(o: { operator?: boolean; tlsTerminated?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  let clock = t0;
  const printed: string[] = [];
  const setup = new SetupMode((code) => printed.push(code));
  const config = {
    listen: { host: '127.0.0.1', port: 7420, ...(o.tlsTerminated ? { tlsTerminated: true } : {}) },
    dataDir: '.',
    pollSeconds: 60,
    dropZones: [makeZone({ id: 'main' })],
    claude: { plan: 'pro', fableWeeklyDropCap: 5 },
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    secrets: { operatorToken: TOKEN, joinToken: 'join' },
  } as unknown as Config;
  if (o.operator) await setOperatorPassphrase(db, PASS, t0);
  const backoff = new Backoff();
  const a = createApp({
    db,
    config,
    forgesFor: () => ({}) as never,
    now: () => clock,
    setup,
    backoff,
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  app = a;
  // As main.ts does at start.
  if (setupActive(db)) setup.rotateSetupCode();
  const inject = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Headers = {},
    payload?: unknown,
    remoteAddress = '127.0.0.1',
  ) =>
    a.inject({
      method,
      url,
      headers: { host: HOST, ...headers },
      remoteAddress,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    db,
    config,
    printed,
    setup,
    deps: { db, config, now: () => clock },
    tick(ms: number) {
      clock = plus(clock, ms);
    },
    get: (url: string, headers: Headers = {}) => inject('GET', url, headers),
    post: (url: string, payload: unknown, headers: Headers = {}, from?: string) =>
      inject('POST', url, { origin: ORIGIN, ...headers }, payload, from),
    put: (url: string, payload: unknown, headers: Headers = {}) =>
      inject('PUT', url, headers, payload),
  };
}

const cookieOf = (res: { headers: Record<string, unknown> }, name: string): string | undefined => {
  const raw = res.headers['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  return all.find((c: string) => c.startsWith(`${name}=`));
};
const valueOf = (cookie: string | undefined) =>
  cookie?.split(';')[0]?.split('=').slice(1).join('=');

/** Enters the printed code and chooses the passphrase; returns the session cookie. */
async function claim(w: Awaited<ReturnType<typeof world>>): Promise<string> {
  const code = await w.post('/setup/code', { code: w.printed.at(-1) });
  const setupCookie = `jm_setup=${valueOf(cookieOf(code, 'jm_setup'))}`;
  const done = await w.post(
    '/setup/passphrase',
    { passphrase: PASS, confirm: PASS },
    { cookie: setupCookie },
  );
  expect(done.statusCode).toBe(303);
  return `jm_session=${valueOf(cookieOf(done, 'jm_session'))}`;
}

describe('route classes', () => {
  test('stick routes and /mcp keep their own checks; the rest is auth, control or page', () => {
    expect(routeClass('/api/sticks/enroll')).toBe('stick');
    expect(routeClass('/api/drops/:id/result')).toBe('stick');
    expect(routeClass('/mcp')).toBe('mcp');
    expect(routeClass('/api/control/kill')).toBe('control');
    expect(routeClass('/api/other')).toBe('control');
    for (const p of ['/login', '/logout', '/setup', '/setup/code', '/setup/passphrase'])
      expect(routeClass(p)).toBe('auth');
    for (const p of ['/', '/doctor', '/drops/:id', '/artifacts/:id', '/setupx', '/loginx'])
      expect(routeClass(p)).toBe('page');
  });
});

describe('setup mode', () => {
  test('with no operator every page redirects to /setup, and /setup accepts only the printed code', async () => {
    const w = await world();
    expect(w.printed).toHaveLength(1);
    for (const url of ['/', '/doctor', '/briefings', '/zones/main/intake', '/login']) {
      const res = await w.get(url);
      expect([url, res.statusCode, res.headers.location]).toEqual([url, 302, '/setup']);
    }
    const page = await w.get('/setup');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('action="/setup/code"');
    expect(page.body).toContain('docker compose logs jumpmaster');
    const wrong = await w.post('/setup/code', { code: 'AAAA-BBBB-CCCC' });
    expect(wrong.statusCode).toBe(401);
    expect(cookieOf(wrong, 'jm_setup')).toBeUndefined();
    w.tick(1000);
    // A form post, as the page sends it.
    const ok = await w.post(
      '/setup/code',
      `code=${encodeURIComponent((w.printed[0] as string).toLowerCase())}`,
      { 'content-type': 'application/x-www-form-urlencoded' },
    );
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/setup');
    const setupCookie = cookieOf(ok, 'jm_setup') as string;
    expect(setupCookie).toMatch(
      /^jm_setup=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=600$/,
    );
    const cookie = `jm_setup=${valueOf(setupCookie)}`;
    const choose = await w.get('/setup', { cookie });
    expect(choose.body).toContain('action="/setup/passphrase"');
    const short = await w.post(
      '/setup/passphrase',
      { passphrase: 'short', confirm: 'short' },
      { cookie },
    );
    expect(short.statusCode).toBe(400);
    expect(short.body).toContain('at least 12');
    const differ = await w.post(
      '/setup/passphrase',
      { passphrase: PASS, confirm: `${PASS}x` },
      { cookie },
    );
    expect(differ.statusCode).toBe(400);
    expect(setupActive(w.db)).toBe(true);
    const done = await w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS }, { cookie });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/');
    expect(cookieOf(done, 'jm_session')).toMatch(
      /^jm_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/,
    );
    expect(cookieOf(done, 'jm_setup')).toBe(
      'jm_setup=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
    expect(setupActive(w.db)).toBe(false);
    const session = `jm_session=${valueOf(cookieOf(done, 'jm_session'))}`;
    expect((await w.get('/', { cookie: session })).statusCode).toBe(200);
    const after = await w.get('/setup', { cookie: session });
    expect([after.statusCode, after.headers.location]).toEqual([302, '/']);
  });

  test('/setup/passphrase without the claim cookie is refused', async () => {
    const w = await world();
    const res = await w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS });
    expect(res.statusCode).toBe(403);
    expect(
      (
        await w.post(
          '/setup/passphrase',
          { passphrase: PASS, confirm: PASS },
          { cookie: 'jm_setup=forged' },
        )
      ).statusCode,
    ).toBe(403);
    expect(setupActive(w.db)).toBe(true);
  });

  test('the claim cookie lasts ten minutes', async () => {
    const w = await world();
    const ok = await w.post('/setup/code', { code: w.printed[0] });
    const cookie = `jm_setup=${valueOf(cookieOf(ok, 'jm_setup'))}`;
    w.tick(10 * 60_000);
    const res = await w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS }, { cookie });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('jumpmaster ctl setup-code');
  });

  test('wrong codes back off per source, 1 s doubling to 5 min, with 429 and Retry-After, and never lock', async () => {
    const w = await world();
    const seconds: string[] = [];
    for (let i = 0; i < 11; i++) {
      expect((await w.post('/setup/code', { code: 'WRONG' })).statusCode).toBe(401);
      const held = await w.post('/setup/code', { code: w.printed[0] });
      expect(held.statusCode).toBe(429);
      seconds.push(String(held.headers['retry-after']));
      w.tick(Number(held.headers['retry-after']) * 1000);
    }
    expect(seconds).toEqual(['1', '2', '4', '8', '16', '32', '64', '128', '256', '300', '300']);
    // Another source is not held by this one.
    const other = await w.post('/setup/code', { code: 'WRONG' }, {}, '10.0.0.9');
    expect(other.statusCode).toBe(401);
    // Once the wait is over the right code still works: a wait, never a lock.
    expect((await w.post('/setup/code', { code: w.printed[0] })).statusCode).toBe(303);
  });

  test('an Origin-refused or Host-refused POST does not advance backoff', async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) {
      const foreign = await w.post(
        '/setup/code',
        { code: 'WRONG' },
        { origin: 'http://evil.test' },
      );
      expect(foreign.statusCode).toBe(403);
      const host = await w.post('/setup/code', { code: 'WRONG' }, { host: 'evil.test' });
      expect(host.statusCode).toBe(403);
      const login = await w.post('/login', { passphrase: 'x' }, { origin: 'http://evil.test' });
      expect(login.statusCode).toBe(403);
    }
    expect((await w.post('/setup/code', { code: 'WRONG' })).statusCode).toBe(401);
    const held = await w.post('/setup/code', { code: 'WRONG' });
    expect([held.statusCode, held.headers['retry-after']]).toEqual([429, '1']);
  });

  test('a code accepted once is refused the second time and after a passphrase exists', async () => {
    const w = await world();
    const code = w.printed[0] as string;
    expect((await w.post('/setup/code', { code })).statusCode).toBe(303);
    w.tick(60_000);
    expect((await w.post('/setup/code', { code })).statusCode).toBe(401);
    w.tick(60_000);
    w.setup.rotateSetupCode();
    await claim(w);
    w.tick(60_000);
    const late = await w.post('/setup/code', { code: w.printed.at(-1) });
    expect(late.statusCode).toBe(409);
    expect(cookieOf(late, 'jm_setup')).toBeUndefined();
  });
});

describe('login and sessions', () => {
  test('login sets an HttpOnly SameSite=Strict cookie, rotates the session id and follows next only to a single-slash path', async () => {
    const w = await world({ operator: true });
    const anon = await w.get('/doctor?x=1');
    expect([anon.statusCode, anon.headers.location]).toEqual([
      302,
      '/login?next=%2Fdoctor%3Fx%3D1',
    ]);
    const form = await w.get('/login?next=%2Fdoctor');
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('name="next" value="/doctor"');
    const old = createSession(w.db, t0);
    const res = await w.post(
      '/login',
      { passphrase: PASS, next: '/doctor' },
      { cookie: `jm_session=${old.id}` },
    );
    expect([res.statusCode, res.headers.location]).toEqual([303, '/doctor']);
    const set = cookieOf(res, 'jm_session') as string;
    expect(set).toMatch(/^jm_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(set).not.toContain('Secure');
    const fresh = valueOf(set) as string;
    expect(fresh).not.toBe(old.id);
    expect(loadSession(w.db, old.id, t0)).toBeNull();
    expect(loadSession(w.db, fresh, t0)).not.toBeNull();
    const page = await w.get('/', { cookie: `jm_session=${fresh}` });
    expect(page.statusCode).toBe(200);
    const csrf = (loadSession(w.db, fresh, t0) as { csrf: string }).csrf;
    expect(page.body).toContain(`<meta name="jm-csrf" content="${csrf}">`);
    for (const [next, to] of [
      ['//evil.test/x', '/'],
      ['/\\evil.test', '/'],
      ['http://evil.test/', '/'],
      ['doctor', '/'],
      ['', '/'],
      ['/briefings?z=1', '/briefings?z=1'],
    ]) {
      const r = await w.post('/login', { passphrase: PASS, next });
      expect([next, r.headers.location]).toEqual([next, to]);
    }
  });

  test('a wrong passphrase is 401 and makes no session', async () => {
    const w = await world({ operator: true });
    const res = await w.post('/login', { passphrase: 'not the passphrase' });
    expect(res.statusCode).toBe(401);
    expect(cookieOf(res, 'jm_session')).toBeUndefined();
    expect(res.body).not.toContain('not the passphrase');
  });

  test('failed logins back off per source and never lock the operator out', async () => {
    const w = await world({ operator: true });
    for (const wait of [1, 2, 4]) {
      expect((await w.post('/login', { passphrase: 'wrong passphrase!' })).statusCode).toBe(401);
      const held = await w.post('/login', { passphrase: PASS });
      expect([held.statusCode, held.headers['retry-after']]).toEqual([429, String(wait)]);
      expect(cookieOf(held, 'jm_session')).toBeUndefined();
      w.tick(wait * 1000);
    }
    expect((await w.post('/login', { passphrase: PASS }, {}, '10.0.0.7')).statusCode).toBe(303);
    expect((await w.post('/login', { passphrase: PASS })).statusCode).toBe(303);
    // Success resets the source.
    expect((await w.post('/login', { passphrase: 'wrong passphrase!' })).statusCode).toBe(401);
    const held = await w.post('/login', { passphrase: PASS });
    expect(held.headers['retry-after']).toBe('1');
  });

  test('an expired session is sent to the login page', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    expect((await w.get('/', { cookie: s.cookie })).statusCode).toBe(200);
    w.tick(12 * 3_600_000);
    const res = await w.get('/', { cookie: s.cookie });
    expect([res.statusCode, res.headers.location]).toEqual([302, '/login?next=%2F']);
  });

  test('logout deletes the session and clears the cookie', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    const res = await w.post('/logout', {}, { cookie: s.cookie });
    expect([res.statusCode, res.headers.location]).toEqual([303, '/login']);
    expect(cookieOf(res, 'jm_session')).toBe(
      'jm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
    expect(loadSession(w.db, s.id, t0)).toBeNull();
  });

  test('a POST to /login, /setup/code, /setup/passphrase or /logout with a foreign Origin is 403', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    for (const url of ['/login', '/setup/code', '/setup/passphrase', '/logout']) {
      for (const origin of ['http://evil.test', 'null']) {
        const res = await w.post(url, { passphrase: PASS }, { origin, cookie: s.cookie });
        expect([url, origin, res.statusCode]).toEqual([url, origin, 403]);
      }
    }
    expect(loadSession(w.db, s.id, t0)).not.toBeNull();
  });
});

describe('cookies behind a declared TLS terminator', () => {
  test('with tlsTerminated the session and setup cookies are Secure, and without it they are not', async () => {
    const w = await world({ tlsTerminated: true });
    const code = await w.post('/setup/code', { code: w.printed.at(-1) });
    expect(cookieOf(code, 'jm_setup')).toMatch(/; Secure$/);
    const setupCookie = `jm_setup=${valueOf(cookieOf(code, 'jm_setup'))}`;
    const done = await w.post(
      '/setup/passphrase',
      { passphrase: PASS, confirm: PASS },
      { cookie: setupCookie },
    );
    expect(cookieOf(done, 'jm_session')).toMatch(
      /^jm_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/,
    );
    expect(cookieOf(done, 'jm_setup')).toBe(
      'jm_setup=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure',
    );
    const login = await w.post('/login', { passphrase: PASS });
    expect(cookieOf(login, 'jm_session')).toMatch(/; Secure$/);
    const out = await w.post(
      '/logout',
      {},
      { cookie: `jm_session=${valueOf(cookieOf(login, 'jm_session'))}` },
    );
    expect(cookieOf(out, 'jm_session')).toMatch(/Max-Age=0; Secure$/);
    const plain = await world({ operator: true });
    const l2 = await plain.post('/login', { passphrase: PASS });
    expect(cookieOf(l2, 'jm_session')).not.toContain('Secure');
  });
});

describe('control routes with a session', () => {
  test('a POST with a valid session but without the matching x-jm-csrf header is 403', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    const bare = await w.post('/api/control/kill', { engaged: true }, { cookie: s.cookie });
    expect(bare.statusCode).toBe(403);
    const wrong = await w.post(
      '/api/control/kill',
      { engaged: true },
      { cookie: s.cookie, 'x-jm-csrf': `${s.csrf}x` },
    );
    expect(wrong.statusCode).toBe(403);
    const other = operatorSession(w.db, t0);
    const crossed = await w.post(
      '/api/control/kill',
      { engaged: true },
      { cookie: s.cookie, 'x-jm-csrf': other.csrf },
    );
    expect(crossed.statusCode).toBe(403);
    expect(isKilled(w.db)).toBe(false);
  });

  test('a control route accepts the Bearer token without CSRF and a session only with CSRF', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    expect((await w.post('/api/control/kill', { engaged: true })).statusCode).toBe(401);
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await w.post('/api/control/kill', { engaged: true }, bearer)).statusCode).toBe(200);
    expect((await w.post('/api/control/kill', { engaged: false }, s.headers)).statusCode).toBe(200);
    // A read needs no CSRF header.
    expect((await w.get('/api/control/briefings', { cookie: s.cookie })).statusCode).toBe(200);
    // A wrong Bearer is refused even beside a live session.
    expect(
      (
        await w.post(
          '/api/control/kill',
          { engaged: true },
          { ...s.headers, authorization: 'Bearer nope' },
        )
      ).statusCode,
    ).toBe(401);
    // The token never gets a session.
    const res = await w.post('/api/control/kill', { engaged: true }, bearer);
    expect(res.headers['set-cookie']).toBeUndefined();
    // Pages want a session, not the token.
    const page = await w.get('/', bearer);
    expect(page.statusCode).toBe(302);
  });

  test('control routes work with the token while setup is active', async () => {
    const w = await world();
    const bearer = { authorization: `Bearer ${TOKEN}` };
    expect((await w.post('/api/control/kill', { engaged: true }, bearer)).statusCode).toBe(200);
    expect(isKilled(w.db)).toBe(true);
  });

  test('a wrong Host or foreign Origin is refused with a valid session and the header', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    const host = await w.post(
      '/api/control/kill',
      { engaged: true },
      { ...s.headers, host: 'evil.test' },
    );
    expect(host.statusCode).toBe(403);
    const origin = await w.post(
      '/api/control/kill',
      { engaged: true },
      { ...s.headers, origin: 'http://evil.test' },
    );
    expect(origin.statusCode).toBe(403);
    const page = await w.get('/', { cookie: s.cookie, host: 'evil.test' });
    expect(page.statusCode).toBe(403);
    expect(isKilled(w.db)).toBe(false);
  });

  test('sudo lasts five minutes after re-entering the passphrase and the Bearer token is always sudo', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    // The seeded row has no real hash: give it one.
    await setOperatorPassphrase(w.db, PASS, t0);
    const fresh = createSession(w.db, t0);
    const headers = { cookie: `jm_session=${fresh.id}`, 'x-jm-csrf': fresh.csrf };
    const req = (h: Headers, method = 'POST') =>
      ({ method, headers: h }) as unknown as FastifyRequest;
    expect(authenticate(req(headers), w.deps)?.sudo).toBe(false);
    expect(authenticate(req({ authorization: `Bearer ${TOKEN}` }), w.deps)).toEqual({
      kind: 'operator',
      via: 'token',
      sudo: true,
    });
    expect(authenticate(req({ authorization: 'Bearer nope' }), w.deps)).toBeNull();
    expect(authenticate(req({ cookie: s.cookie }), w.deps)).toBeNull(); // ended by the new passphrase

    const wrong = await w.post('/api/control/sudo', { passphrase: 'not the passphrase' }, headers);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain('not the passphrase');
    const held = await w.post('/api/control/sudo', { passphrase: PASS }, headers);
    expect([held.statusCode, held.headers['retry-after']]).toEqual([429, '1']);
    w.tick(1000);
    const ok = await w.post('/api/control/sudo', { passphrase: PASS }, headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ sudo: true, until: plus(t0, 1000 + SUDO_MS).toISOString() });
    const p = authenticate(req(headers), w.deps);
    expect(p).toMatchObject({ via: 'session', sudo: true });
    expect(p && requireCsrf(req(headers), p)).toBe(true);
    expect(p && requireCsrf(req({ cookie: headers.cookie }), p)).toBe(false);
    expect(p && requireCsrf(req({ cookie: headers.cookie }, 'GET'), p)).toBe(true);
    w.tick(SUDO_MS - 1);
    expect(authenticate(req(headers), w.deps)?.sudo).toBe(true);
    w.tick(1);
    expect(authenticate(req(headers), w.deps)?.sudo).toBe(false);
    const bearer = await w.post('/api/control/sudo', {}, { authorization: `Bearer ${TOKEN}` });
    expect(bearer.json()).toEqual({ sudo: true, until: null });
  });
});

describe('Bearer-only setup routes', () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };

  test('ctl setup reopen needs the Bearer token, deletes every session and reopens setup with a new code', async () => {
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    const viaSession = await w.post('/api/control/setup/reopen', {}, s.headers);
    expect(viaSession.statusCode).toBe(403);
    expect(setupActive(w.db)).toBe(false);
    expect(w.printed).toHaveLength(0);
    const res = await w.post('/api/control/setup/reopen', {}, bearer);
    expect(res.statusCode).toBe(200);
    expect(setupActive(w.db)).toBe(true);
    expect(loadSession(w.db, s.id, t0)).toBeNull();
    expect(w.printed).toHaveLength(1);
    expect(res.body).not.toContain(w.printed[0]);
    expect((await w.get('/', { cookie: s.cookie })).headers.location).toBe('/setup');
    await claim(w);
    expect(setupActive(w.db)).toBe(false);
  });

  test('ctl setup-code prints a fresh code to stderr and returns nothing to the caller', async () => {
    const w = await world();
    const first = w.printed[0] as string;
    const res = await w.post('/api/control/setup/code', {}, bearer);
    expect(res.statusCode).toBe(200);
    expect(w.printed).toHaveLength(2);
    const fresh = w.printed[1] as string;
    expect(res.body).not.toContain(fresh);
    expect(res.body).not.toContain(fresh.replaceAll('-', ''));
    expect((await w.post('/setup/code', { code: first })).statusCode).toBe(401);
    w.tick(1000);
    expect((await w.post('/setup/code', { code: fresh })).statusCode).toBe(303);
    // Setup is complete: no code to print.
    const done = await world({ operator: true });
    expect((await done.post('/api/control/setup/code', {}, bearer)).statusCode).toBe(409);
    expect(done.printed).toHaveLength(0);
    // Not a session's to ask for.
    const s = operatorSession(done.db, t0);
    expect((await done.post('/api/control/setup/code', {}, s.headers)).statusCode).toBe(403);
  });

  test('PUT passphrase claims or replaces the operator with no browser, ends setup mode and deletes every session', async () => {
    const w = await world();
    expect(
      (await w.put('/api/control/passphrase', { passphrase: 'short' }, bearer)).statusCode,
    ).toBe(400);
    expect((await w.put('/api/control/passphrase', { passphrase: PASS })).statusCode).toBe(401);
    const claimed = await w.put('/api/control/passphrase', { passphrase: PASS }, bearer);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ operator: 'claimed' });
    expect(setupActive(w.db)).toBe(false);
    // The printed code is dead now.
    expect((await w.post('/setup/code', { code: w.printed[0] })).statusCode).toBe(409);
    const s = operatorSession(w.db, t0);
    const viaSession = await w.put('/api/control/passphrase', { passphrase: PASS }, s.headers);
    expect(viaSession.statusCode).toBe(403);
    const replaced = await w.put(
      '/api/control/passphrase',
      { passphrase: 'another long passphrase' },
      bearer,
    );
    expect(replaced.json()).toMatchObject({ operator: 'replaced', sessionsDeleted: 1 });
    expect(loadSession(w.db, s.id, t0)).toBeNull();
    expect((await w.post('/login', { passphrase: 'another long passphrase' })).statusCode).toBe(
      303,
    );
    expect(replaced.body).not.toContain('another long passphrase');
  });
});

describe('the setup code stays out of every surface', () => {
  test('never in a page, a cookie, a URL or the database', async () => {
    const w = await world();
    const code = w.printed[0] as string;
    const bare = code.replaceAll('-', '');
    const responses = [
      await w.get('/setup'),
      await w.get('/'),
      await w.post('/setup/code', { code: 'WRONG' }),
    ];
    w.tick(1000);
    const ok = await w.post('/setup/code', { code });
    responses.push(ok);
    const cookie = `jm_setup=${valueOf(cookieOf(ok, 'jm_setup'))}`;
    responses.push(await w.get('/setup', { cookie }));
    const done = await w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS }, { cookie });
    responses.push(done);
    for (const r of responses) {
      const all = `${r.body}\n${JSON.stringify(r.headers)}`;
      expect(all).not.toContain(code);
      expect(all).not.toContain(bare);
      expect(all.toLowerCase()).not.toContain(bare.toLowerCase());
    }
    const dump = dumpDb(w.db);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(bare);
  });
});

/** Every row of every table, as text. */
function dumpDb(db: Db): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  return tables
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join('\n');
}

describe('round 2', () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };

  test('a claim from a spent code cannot set the passphrase after ctl setup-code', async () => {
    const w = await world();
    const ok = await w.post('/setup/code', { code: w.printed[0] });
    const cookie = `jm_setup=${valueOf(cookieOf(ok, 'jm_setup'))}`;
    expect((await w.post('/api/control/setup/code', {}, bearer)).statusCode).toBe(200);
    const res = await w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS }, { cookie });
    expect(res.statusCode).toBe(403);
    expect(setupActive(w.db)).toBe(true);
  });

  test('stick routes answer while passphrase guesses from many sources are running', async () => {
    const w = await world({ operator: true });
    const enroll = () =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: '/api/sticks/enroll',
        headers: { 'x-jumpmaster-protocol': '1', host: 'jumpmaster:7420' },
        payload: { joinToken: 'join', name: 's', slots: 1 },
      });
    const order: string[] = [];
    const guesses = Array.from({ length: 6 }, (_, i) =>
      w.post('/login', { passphrase: `guess number ${i}` }, {}, `127.0.0.${i + 2}`).then((r) => {
        order.push('guess');
        return r.statusCode;
      }),
    );
    const stick = enroll().then((r) => {
      order.push('stick');
      return r.statusCode;
    });
    expect(await stick).toBe(200);
    expect(await Promise.all(guesses)).toEqual([401, 401, 401, 401, 401, 401]);
    // The stick did not wait behind the six scrypt runs.
    expect(order[0]).toBe('stick');
  });

  test('a setup claim is audited as system, before any session exists', async () => {
    const w = await world();
    await claim(w);
    const row = w.db.prepare("SELECT via FROM control_audit WHERE action = 'setup.claim'").get();
    expect(row).toEqual({ via: 'system' });
  });

  test('the login, setup and logged-in pages are never cached', async () => {
    const open = await world();
    expect((await open.get('/setup')).headers['cache-control']).toBe('no-store');
    const w = await world({ operator: true });
    const s = operatorSession(w.db, t0);
    for (const res of [
      await w.get('/login'),
      await w.post('/login', { passphrase: 'not the passphrase' }),
      await w.get('/', { cookie: s.cookie }),
      await w.get('/doctor', { cookie: s.cookie }),
    ]) {
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('round 3', () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };

  test('one address firing 33 parallel guesses is refused from the second on, so it cannot fill the queue', async () => {
    const w = await world({ operator: true });
    const statuses = await Promise.all(
      Array.from({ length: 33 }, (_, i) => w.post('/login', { passphrase: `guess number ${i}` })),
    );
    expect(statuses.filter((r) => r.statusCode === 401)).toHaveLength(1);
    expect(statuses.filter((r) => r.statusCode === 429)).toHaveLength(32);
    expect(statuses.some((r) => r.statusCode === 503)).toBe(false);
    // The same holds for sudo, from a session on another address.
    const s = operatorSession(w.db, t0);
    const sudo = await Promise.all(
      Array.from({ length: 5 }, () =>
        w
          .post('/api/control/sudo', { passphrase: 'not the passphrase' }, s.headers, '10.1.1.1')
          .then((r) => r.statusCode),
      ),
    );
    expect(sudo.sort()).toEqual([401, 429, 429, 429, 429]);
  });

  test('a double submit of the setup passphrase claims once and keeps the first session', async () => {
    const w = await world();
    const ok = await w.post('/setup/code', { code: w.printed[0] });
    const cookie = `jm_setup=${valueOf(cookieOf(ok, 'jm_setup'))}`;
    const [a, b] = await Promise.all([
      w.post('/setup/passphrase', { passphrase: PASS, confirm: PASS }, { cookie }),
      w.post('/setup/passphrase', { passphrase: `${PASS}!`, confirm: `${PASS}!` }, { cookie }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([303, 409]);
    const won = a.statusCode === 303 ? a : b;
    const session = `jm_session=${valueOf(cookieOf(won, 'jm_session'))}`;
    expect((await w.get('/', { cookie: session })).statusCode).toBe(200);
  });

  test('a login with the old passphrase that was waiting during a rotation is refused', async () => {
    const w = await world({ operator: true });
    const rotate = w.put(
      '/api/control/passphrase',
      { passphrase: 'the new long passphrase' },
      bearer,
    );
    // The rotation's hash is running; the login reads the old hash now and waits behind it.
    while (scryptStats().running === 0) await new Promise((r) => setImmediate(r));
    const login = w.post('/login', { passphrase: PASS });
    const [r, l] = await Promise.all([rotate, login]);
    expect(r.statusCode).toBe(200);
    expect(l.statusCode).toBe(401);
    expect(cookieOf(l, 'jm_session')).toBeUndefined();
    expect((w.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
  });
});
