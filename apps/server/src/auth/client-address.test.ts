import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { Backoff } from './backoff.js';
import type { Principal } from './guard.js';
import { SetupMode, setOperatorPassphrase } from './operator.js';

/**
 * Issue #261: behind a TLS terminator on this host (`listen.tlsTerminated`), the backoff counts
 * each client by its `X-Forwarded-For` address, trusted only from a loopback peer. Every request
 * goes through the real app.
 */

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
const WRONG = 'not the passphrase at all';
const env = {
  JM_CLAUDE_TOKEN: 'claude-secret-value-1',
  JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: TOKEN,
};
const tokenPrincipal: Principal = { kind: 'operator', via: 'token', sudo: true };
const zone = (extra: Record<string, unknown> = {}) => ({
  id: 'main',
  repo: 'octo/main',
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
  egress: { mode: 'enforce', allow: [] },
  ...extra,
});
const weaken = { dropZones: [zone({ ciRequired: false, egress: { mode: 'off', allow: [] } })] };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Where a request comes from: the TCP peer and, optionally, the forwarded header. */
type From = { peer: string; forwarded?: string };

async function world(o: { tls: boolean }) {
  const db = openDb(tmpDbFile());
  const clock = { now: t0 };
  const dir = mkdtempSync(join(tmpdir(), 'jm-client-address-'));
  const bootEnv = o.tls ? { ...env, JM_TLS_TERMINATED: '1' } : env;
  const store = ConfigStore.open({
    db,
    boot: loadBoot(bootEnv, join(dir, 'none.json')),
    env: bootEnv,
    now: () => clock.now,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  store.apply({ dropZones: [zone()] }, { via: 'ctl', principal: tokenPrincipal });
  await setOperatorPassphrase(db, PASS, t0);
  const backoff = new Backoff();
  const a = createApp({
    db,
    config: store,
    forgesFor: () => ({}) as never,
    now: () => clock.now,
    setup: new SetupMode(() => {}),
    backoff,
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  app = a;
  const s = operatorSession(db);
  const fromHeaders = (f: From) => (f.forwarded ? { 'x-forwarded-for': f.forwarded } : {});
  const login = (passphrase: string, f: From) =>
    a.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: f.peer,
      headers: {
        host: HOST,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...fromHeaders(f),
      },
      payload: new URLSearchParams({ passphrase }).toString(),
    });
  const sudo = (passphrase: string, f: From) =>
    a.inject({
      method: 'POST',
      url: '/api/control/sudo',
      remoteAddress: f.peer,
      headers: { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf, ...fromHeaders(f) },
      payload: { passphrase },
    });
  /** A pending guarded change; its confirmation POST takes the passphrase. */
  const pendingId = async (): Promise<string> => {
    const r = await a.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf },
      payload: { patch: weaken, expectRevision: store.revision() },
    });
    expect(r.statusCode, r.body).toBe(409);
    return r.json().pendingId as string;
  };
  let confirmId: string | undefined;
  const confirm = async (passphrase: string, f: From) => {
    confirmId ??= await pendingId();
    const page = await a.inject({
      method: 'GET',
      url: `/config/confirm/${confirmId}`,
      headers: { host: HOST, cookie: s.cookie },
    });
    const token = /name="token" value="([\w-]+)"/.exec(page.body)?.[1] as string;
    return a.inject({
      method: 'POST',
      url: `/config/confirm/${confirmId}`,
      remoteAddress: f.peer,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: s.cookie,
        'content-type': 'application/x-www-form-urlencoded',
        ...fromHeaders(f),
      },
      payload: new URLSearchParams({ token, passphrase }).toString(),
    });
  };
  return { db, store, clock, backoff, login, sudo, confirm, session: s, inject: a.inject.bind(a) };
}

const A = '100.64.0.7';
const B = '100.64.0.8';

describe('the backoff bucket (issue #261 examples)', () => {
  test('tlsTerminated on, loopback peer: ten wrong passphrases from A do not delay B', async () => {
    const w = await world({ tls: true });
    for (let i = 0; i < 10; i++) await w.login(WRONG, { peer: '127.0.0.1', forwarded: A });
    // A waits; B, behind the same terminator, logs straight in.
    const a = await w.login(PASS, { peer: '127.0.0.1', forwarded: A });
    expect(a.statusCode).toBe(429);
    const b = await w.login(PASS, { peer: '127.0.0.1', forwarded: B });
    expect(b.statusCode, b.body).toBe(303);
    expect(w.backoff.check(A, w.clock.now).allowed).toBe(false);
    expect(w.backoff.check('127.0.0.1', w.clock.now).allowed).toBe(true);
  });

  test('tlsTerminated on, non-loopback peer: the header is ignored and the peer is the bucket', async () => {
    const w = await world({ tls: true });
    const wrong = await w.login(WRONG, { peer: '192.168.1.50', forwarded: '1.2.3.4' });
    expect(wrong.statusCode).toBe(401);
    expect(w.backoff.check('192.168.1.50', w.clock.now).allowed).toBe(false);
    expect(w.backoff.check('1.2.3.4', w.clock.now).allowed).toBe(true);
    // The same peer without the header, or naming anyone else, waits.
    expect((await w.login(PASS, { peer: '192.168.1.50' })).statusCode).toBe(429);
    // Another machine is not held.
    expect((await w.login(PASS, { peer: '192.168.1.51' })).statusCode).toBe(303);
  });

  test('tlsTerminated off, loopback peer: the header is ignored and every client shares 127.0.0.1, as before', async () => {
    const w = await world({ tls: false });
    const wrong = await w.login(WRONG, { peer: '127.0.0.1', forwarded: A });
    expect(wrong.statusCode).toBe(401);
    expect(w.backoff.check('127.0.0.1', w.clock.now).allowed).toBe(false);
    expect(w.backoff.check(A, w.clock.now).allowed).toBe(true);
    expect((await w.login(PASS, { peer: '127.0.0.1', forwarded: B })).statusCode).toBe(429);
    // After the wait the right passphrase goes through.
    w.clock.now = plus(t0, 2000);
    expect((await w.login(PASS, { peer: '127.0.0.1', forwarded: B })).statusCode).toBe(303);
  });
});

describe('a spoofed X-Forwarded-For (D1)', () => {
  test('from a non-loopback peer it can neither dodge nor reset that peer’s bucket', async () => {
    const w = await world({ tls: true });
    const peer = '192.168.1.50';
    await w.login(WRONG, { peer, forwarded: '1.2.3.4' });
    // Each new header value is the same bucket: still held, and the hold grows.
    for (const forwarded of ['5.6.7.8', '127.0.0.1', A, `${A}, 127.0.0.1`, '']) {
      const r = await w.login(PASS, { peer, forwarded });
      expect(r.statusCode, forwarded).toBe(429);
    }
    // A right passphrase sent as another client cannot clear the attacker's own wait either.
    w.clock.now = plus(t0, 1000);
    expect((await w.login(WRONG, { peer, forwarded: '9.9.9.9' })).statusCode).toBe(401);
    expect((await w.login(PASS, { peer, forwarded: '9.9.9.8' })).statusCode).toBe(429);
    expect(w.backoff.check(peer, w.clock.now).allowed).toBe(false);
  });

  test('through the terminator a client cannot pick its bucket by prefixing the header', async () => {
    const w = await world({ tls: true });
    // The terminator appends the real client last; anything the client wrote sits before it.
    await w.login(WRONG, { peer: '127.0.0.1', forwarded: `${B}, ${A}` });
    expect(w.backoff.check(A, w.clock.now).allowed).toBe(false);
    expect(w.backoff.check(B, w.clock.now).allowed).toBe(true);
    const again = await w.login(PASS, { peer: '127.0.0.1', forwarded: `127.0.0.1, ${A}` });
    expect(again.statusCode).toBe(429);
  });
});

describe('the three backoff call sites (D5)', () => {
  const sites = ['login', 'confirm', 'sudo'] as const;
  type Site = (typeof sites)[number];
  const okStatus: Record<Site, number> = { login: 303, confirm: 200, sudo: 200 };

  test('login, config confirmation and sudo each count the same client address', async () => {
    for (const site of sites) {
      const w = await world({ tls: true });
      const send = (p: string, f: From) => w[site](p, f);
      const wrong = await send(WRONG, { peer: '127.0.0.1', forwarded: A });
      expect(wrong.statusCode, site).toBe(401);
      // The bucket is the forwarded address, at every site.
      expect(w.backoff.check(A, w.clock.now).allowed, site).toBe(false);
      expect(w.backoff.check('127.0.0.1', w.clock.now).allowed, site).toBe(true);
      expect((await send(PASS, { peer: '127.0.0.1', forwarded: A })).statusCode, site).toBe(429);
      const b = await send(PASS, { peer: '127.0.0.1', forwarded: B });
      expect(b.statusCode, `${site}: ${b.body}`).toBe(okStatus[site]);
      // A non-loopback peer's header never names the bucket, at every site.
      const v = await world({ tls: true });
      await v[site](WRONG, { peer: '192.168.1.50', forwarded: A });
      expect(v.backoff.check('192.168.1.50', v.clock.now).allowed, site).toBe(false);
      expect(v.backoff.check(A, v.clock.now).allowed, site).toBe(true);
      await app?.close();
    }
  });
});

describe('the Host and Origin checks ignore forwarded headers', () => {
  test('X-Forwarded-Host and X-Forwarded-Proto neither admit a foreign Host nor refuse the real one', async () => {
    const w = await world({ tls: true });
    const forwarded = {
      'x-forwarded-for': A,
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    };
    const real = await w.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: '127.0.0.1',
      headers: { host: HOST, ...forwarded },
    });
    expect(real.statusCode).toBe(200);
    const evil = await w.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: '127.0.0.1',
      headers: { host: 'evil.example', ...forwarded, 'x-forwarded-host': HOST },
    });
    expect(evil.statusCode).toBe(403);
    // An Origin naming the forwarded host is still cross-site, and charges nothing.
    const cross = await w.inject({
      method: 'POST',
      url: '/login',
      remoteAddress: '127.0.0.1',
      headers: {
        host: HOST,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
        ...forwarded,
      },
      payload: new URLSearchParams({ passphrase: WRONG }).toString(),
    });
    expect(cross.statusCode).toBe(403);
    expect(w.backoff.size).toBe(0);
  });
});
