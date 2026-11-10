import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import type { Principal } from '../auth/guard.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { sha256Hex } from '../auth/sessions.js';
import { loadBoot } from '../config/boot.js';
import { CONFIRM_MS, PENDING_MS } from '../config/confirm.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
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

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function world() {
  const db = openDb(tmpDbFile());
  const clock = { now: t0 };
  const dir = mkdtempSync(join(tmpdir(), 'jm-confirm-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, join(dir, 'none.json')),
    env,
    now: () => clock.now,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  store.apply({ dropZones: [zone()] }, { via: 'ctl', principal: tokenPrincipal });
  await setOperatorPassphrase(db, PASS, t0);
  const a = createApp({
    db,
    config: store,
    forgesFor: () => ({}) as never,
    now: () => clock.now,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  app = a;
  const one = operatorSession(db);
  const two = operatorSession(db);
  const as = (s: typeof one) => ({ host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf });
  /** A guarded PATCH from a session: the pending change's id. */
  const propose = async (patch: unknown, s = one, extra: Record<string, unknown> = {}) => {
    const r = await a.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: as(s),
      payload: { patch, expectRevision: store.revision(), ...extra } as object,
    });
    expect(r.statusCode, r.body).toBe(409);
    return r.json().pendingId as string;
  };
  const page = (id: string, s = one) =>
    a.inject({
      method: 'GET',
      url: `/config/confirm/${id}`,
      headers: { host: HOST, cookie: s.cookie },
    });
  /** The token the render put into the form. */
  const tokenIn = (html: string) => /name="token" value="([\w-]+)"/.exec(html)?.[1] as string;
  const confirm = (id: string, form: Record<string, string>, s = one, headers = {}) =>
    a.inject({
      method: 'POST',
      url: `/config/confirm/${id}`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: s.cookie,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      payload: new URLSearchParams(form).toString(),
    });
  return { db, store, clock, one, two, propose, page, tokenIn, confirm };
}

const weaken = { dropZones: [zone({ ciRequired: false, egress: { mode: 'off', allow: [] } })] };

describe('the confirmation page', () => {
  test('renders each consequence verbatim with a passphrase field, and mints a confirmation into the form', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const r = await w.page(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('Agent PRs in main will merge without CI');
    expect(r.body).toContain('Drops in main will be able to reach any host on the internet');
    expect(r.body).toContain('type="password" name="passphrase"');
    expect(r.body).toContain(`action="/config/confirm/${id}"`);
    const token = w.tokenIn(r.body);
    expect(token).toMatch(/^[\w-]{40,}$/);
    // The CSRF meta is the session's, unrelated to the confirmation.
    expect(r.body).toContain(`<meta name="jm-csrf" content="${w.one.csrf}">`);
    expect(r.body).not.toContain(`content="${token}"`);
    // Another session sees nothing.
    expect((await w.page(id, w.two)).statusCode).toBe(404);
  });

  test('a minted confirmation is accepted once with the passphrase, and a second use is refused as used', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    const ok = await w.confirm(id, { token, passphrase: PASS });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('revision 3');
    expect(w.store.current().dropZones[0]?.ciRequired).toBe(false);
    // The audit row: via session, guarded, with the paths and never a value.
    const row = listAudit(w.db).find((a) => a.action === 'config.apply');
    expect(row).toMatchObject({
      via: 'session',
      detail: {
        revision: 3,
        guarded: 1,
        guardedPaths: 'dropZones[main].ciRequired, dropZones[main].egress.mode',
      },
    });
    const again = await w.confirm(id, { token, passphrase: PASS });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('already used');
    expect(w.store.revision()).toBe(3);
  });

  test('returnTo sends the browser on after applying, and only to a path on this host', async () => {
    const w = await world();
    const id = await w.propose(weaken, w.one, { returnTo: '/setup/doctor' });
    const r = await w.confirm(id, { token: w.tokenIn((await w.page(id)).body), passphrase: PASS });
    expect([r.statusCode, r.headers.location]).toEqual([303, '/setup/doctor']);
    const w2 = await world();
    const id2 = await w2.propose(weaken, w2.one, { returnTo: '//evil.example/x' });
    const r2 = await w2.confirm(id2, {
      token: w2.tokenIn((await w2.page(id2)).body),
      passphrase: PASS,
    });
    expect([r2.statusCode, r2.headers.location]).toEqual([303, '/']);
  });

  test('a token not minted by the render, a token from another session, a changed set and a stale revision are each refused', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    const made = await w.confirm(id, { token: 'x'.repeat(43), passphrase: PASS });
    expect(made.statusCode).toBe(409);
    expect(made.body).toContain('not one this page made');
    // Another session's own pending change, confirmed with this session's token.
    const theirs = await w.propose({ dropZones: [zone({ gateCi: false })] }, w.two);
    const cross = await w.confirm(theirs, { token, passphrase: PASS }, w.two);
    expect(cross.statusCode).toBe(409);
    expect(cross.body).toContain('another session');
    // This session's token offered for a different pending change of its own.
    const mine = await w.propose({ dropZones: [zone({ trustPnpmBuildBlocking: true })] });
    const changed = await w.confirm(mine, { token, passphrase: PASS });
    expect(changed.statusCode).toBe(409);
    expect(changed.body).toContain('a different change');
    // The config moves on: the change was judged against revision 2.
    w.store.apply(
      { dropZones: [zone()], pollSeconds: 30 },
      { via: 'ctl', principal: tokenPrincipal },
    );
    const stale = await w.confirm(id, { token, passphrase: PASS });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain('changed since');
    expect(w.store.current().dropZones[0]?.ciRequired).toBe(true);
  });

  test('an expired confirmation and an expired pending change are refused', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    w.clock.now = plus(t0, CONFIRM_MS);
    const late = await w.confirm(id, { token, passphrase: PASS });
    expect(late.statusCode).toBe(409);
    expect(late.body).toContain('expired');
    w.clock.now = plus(t0, PENDING_MS);
    expect((await w.page(id)).statusCode).toBe(404);
    expect(w.store.revision()).toBe(2);
  });

  test('a wrong passphrase on the confirmation POST charges backoff and applies nothing', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    const wrong = await w.confirm(id, { token, passphrase: 'not the passphrase at all' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('That passphrase is not right');
    // The page comes back with a fresh confirmation; the backoff holds this source meanwhile.
    expect(w.tokenIn(wrong.body)).toMatch(/^[\w-]{40,}$/);
    const held = await w.confirm(id, { token: w.tokenIn(wrong.body), passphrase: PASS });
    expect(held.statusCode).toBe(429);
    expect(w.store.revision()).toBe(2);
    expect(listAudit(w.db).filter((a) => a.action === 'config.apply')).toEqual([]);
    // After the wait, the confirmation the latest render made works.
    w.clock.now = plus(t0, 2000);
    const ok = await w.confirm(id, { token: w.tokenIn(held.body), passphrase: PASS });
    expect(ok.statusCode).toBe(200);
  });

  test('a cross-site POST is refused before it charges anything, and the token never reaches the page', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    const cross = await w.confirm(id, { token, passphrase: PASS }, w.one, {
      origin: 'http://evil.example',
    });
    expect(cross.statusCode).toBe(403);
    const bearer = await w.confirm(id, { token, passphrase: PASS }, w.one, {
      cookie: '',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(bearer.statusCode).toBe(401);
    // Nothing was charged: the right passphrase still goes straight through.
    const ok = await w.confirm(id, { token, passphrase: PASS });
    expect(ok.statusCode).toBe(200);
  });

  test('the page escapes what it shows, and the pending change is bound to the hashed session id', async () => {
    const w = await world();
    // A pending change whose consequence carries markup (an egress host can't; a crew goal path can).
    const id = await w.propose({
      dropZones: [
        zone({ crew: { goalPath: '<b>x</b>.md' }, protectedPaths: ['GOAL.md', '<b>x</b>.md'] }),
      ],
    });
    const r = await w.page(id);
    expect(r.body).toContain('&lt;b&gt;x&lt;/b&gt;.md');
    expect(r.body).not.toContain('<b>x</b>');
    expect(sha256Hex(w.one.id)).toBe(
      w.store.confirmations.pending(id, sha256Hex(w.one.id))?.sessionIdHash,
    );
  });
});
