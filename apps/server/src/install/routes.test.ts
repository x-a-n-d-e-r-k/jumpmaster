// Swapping the pasted code for an install token at once, and cancelling on failure (issue #269),
// through the whole app: the exchange spends the code, the token serves every installer route and
// the enrollment, and a cancelled, expired or spent credential is refused everywhere.
import { afterEach, describe, expect, test } from 'vitest';
import { inviteState } from '../db/repo.js';
import { t0 } from '../test/helpers.js';
import { closeInstallWorld, installWorld, sha } from '../test/install-world.js';
import { INSTALL_TOKEN, SPENT_CODE_ERROR } from './invite.js';

afterEach(closeInstallWorld);

const MINUTE = 60_000;
const ROUTES = [
  '/install/cosign?platform=linux/amd64',
  '/install/trusted-root.json',
  '/install/stick-image.tar?platform=linux/amd64',
];

async function world() {
  const w = await installWorld();
  const bearer = (cred?: string) => ({
    host: 'any.example',
    ...(cred ? { authorization: `Bearer ${cred}` } : {}),
  });
  const exchange = (code?: string) =>
    w.inject({ method: 'POST', url: '/install/exchange', headers: bearer(code) });
  const cancel = (token?: string) =>
    w.inject({ method: 'POST', url: '/install/cancel', headers: bearer(token) });
  const get = (url: string, cred?: string) =>
    w.inject({ method: 'GET', url, headers: bearer(cred) });
  const inviteId = (name: string) =>
    (w.db.prepare('SELECT id FROM stick_invites WHERE name = ?').get(name) as { id: string }).id;
  /** An invite, exchanged: its code and its install token. */
  const exchanged = async (name: string) => {
    const code = await w.invite(name);
    const r = await exchange(code);
    expect(r.statusCode, r.body).toBe(200);
    return { code, token: (r.json() as { token: string }).token };
  };
  return { ...w, exchange, cancel, get, inviteId, exchanged };
}

describe('POST /install/exchange', () => {
  test('trades a pending code for a 30-minute install token, stored hashed, and spends the code', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const r = await w.exchange(code);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const { token } = r.json() as { token: string };
    expect(token).toMatch(INSTALL_TOKEN);
    const row = w.db
      .prepare(
        'SELECT token_hash AS h, token_expires_at AS e, exchanged_at AS x FROM stick_invites',
      )
      .get() as { h: string; e: string; x: string };
    expect(row.h).toBe(sha(token));
    expect(Date.parse(row.e) - t0.getTime()).toBe(30 * MINUTE);
    expect(row.x).toBe(t0.toISOString());
    expect(JSON.stringify(w.db.prepare('SELECT * FROM stick_invites').all())).not.toContain(token);
    expect(inviteState(w.db, w.inviteId('vps-1'), t0)).toBe('exchanged');
    // Registered with the scrub set, as the code is.
    expect(w.scrub.values()).toContain(token);
    // Still waiting on the sticks page, and its name still held.
    expect(await w.page()).toContain('vps-1: waiting for it to check in');
    expect((await w.add({ name: 'vps-1', slots: 'auto' })).statusCode).toBe(400);
  });

  test('D1: a second exchange, and any download or enrollment with the spent code, get 401; the first two say why', async () => {
    const w = await world();
    const { code } = await w.exchanged('vps-1');
    const again = await w.exchange(code);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: SPENT_CODE_ERROR });
    expect(SPENT_CODE_ERROR).toBe(
      'this code was already used to start an install; make a new one on the sticks page',
    );
    for (const url of ROUTES) {
      const r = await w.get(url, code);
      expect(r.statusCode, url).toBe(401);
      expect(r.json(), url).toEqual({ error: SPENT_CODE_ERROR });
    }
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(401);
  });

  test('D3: concurrent exchanges of one code issue exactly one token', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    const results = await Promise.all([1, 2, 3, 4].map(() => w.exchange(code)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401, 401, 401]);
    expect(
      w.db.prepare('SELECT COUNT(*) AS n FROM stick_invites WHERE token_hash IS NOT NULL').get(),
    ).toEqual({ n: 1 });
  });

  test('no code, an unknown, expired or cancelled code, or a token, get 401 unauthorized', async () => {
    const w = await world();
    expect((await w.exchange()).statusCode).toBe(401);
    expect((await w.exchange(`jm_enroll_${'A'.repeat(43)}`)).json()).toEqual({
      error: 'unauthorized',
    });
    const { token } = await w.exchanged('vps-1');
    expect((await w.exchange(token)).statusCode).toBe(401);
    const old = await w.invite('vps-2');
    w.setClock(new Date(t0.getTime() + 24 * 60 * MINUTE + 1000));
    expect((await w.exchange(old)).json()).toEqual({ error: 'unauthorized' });
  });
});

describe('the install token', () => {
  test('downloads from every installer route, then enrolls; enrollment moves the invite to used', async () => {
    const w = await world();
    const { token } = await w.exchanged('vps-1');
    for (const url of ROUTES) expect((await w.get(url, token)).statusCode, url).toBe(200);
    const e = await w.enroll({ enrollCode: token });
    expect(e.statusCode, e.body).toBe(200);
    expect(e.json().name).toBe('vps-1');
    expect(inviteState(w.db, w.inviteId('vps-1'), t0)).toBe('used');
    // Spent: the token works nowhere now.
    for (const url of ROUTES) expect((await w.get(url, token)).statusCode, url).toBe(401);
    expect((await w.enroll({ enrollCode: token })).statusCode).toBe(401);
    expect((await w.cancel(token)).statusCode).toBe(401);
    expect(await w.page()).not.toContain('waiting for it to check in');
  });

  test('an expired token gets 401 everywhere, and its invite counts as cancelled', async () => {
    const w = await world();
    const { token } = await w.exchanged('vps-1');
    w.setClock(new Date(t0.getTime() + 30 * MINUTE + 1));
    for (const url of ROUTES) expect((await w.get(url, token)).statusCode, url).toBe(401);
    expect((await w.enroll({ enrollCode: token })).statusCode).toBe(401);
    expect((await w.cancel(token)).statusCode).toBe(401);
    expect(inviteState(w.db, w.inviteId('vps-1'), new Date(t0.getTime() + 30 * MINUTE + 1))).toBe(
      'cancelled',
    );
    // No longer waiting, and its name is free.
    expect(await w.page()).not.toContain('waiting for it to check in');
    w.sudo();
    expect((await w.add({ name: 'vps-1', slots: 'auto' })).statusCode).toBe(200);
  });

  test('a token of the right shape that was never issued gets 401', async () => {
    const w = await world();
    await w.exchanged('vps-1');
    const forged = `jm_install_${'A'.repeat(43)}`;
    expect((await w.get(ROUTES[0] as string, forged)).statusCode).toBe(401);
    expect((await w.enroll({ enrollCode: forged })).statusCode).toBe(401);
    expect((await w.cancel(forged)).statusCode).toBe(401);
  });
});

describe('POST /install/cancel', () => {
  test('cancels an exchanged invite: 200 twice, the invite cancelled, the token dead, enrollment refused', async () => {
    const w = await world();
    const { token, code } = await w.exchanged('vps-1');
    const first = await w.cancel(token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ cancelled: true });
    const second = await w.cancel(token);
    expect(second.statusCode, second.body).toBe(200);
    expect(inviteState(w.db, w.inviteId('vps-1'), t0)).toBe('cancelled');
    expect((await w.enroll({ enrollCode: token })).statusCode).toBe(401);
    expect((await w.enroll({ enrollCode: code })).statusCode).toBe(401);
    for (const url of ROUTES) expect((await w.get(url, token)).statusCode, url).toBe(401);
    expect(await w.page()).not.toContain('waiting for it to check in');
    expect((await w.add({ name: 'vps-1', slots: 'auto' })).statusCode).toBe(200);
  });

  test('a code, no credential or an unknown token gets 401; a pending invite is left alone', async () => {
    const w = await world();
    const code = await w.invite('vps-1');
    expect((await w.cancel(code)).statusCode).toBe(401);
    expect((await w.cancel()).statusCode).toBe(401);
    expect(inviteState(w.db, w.inviteId('vps-1'), t0)).toBe('pending');
  });

  test("the sticks page's Cancel also cancels an exchanged invite", async () => {
    const w = await world();
    const { token } = await w.exchanged('vps-1');
    w.sudo();
    const r = await w.inject({
      method: 'POST',
      url: `/api/control/sticks/invites/${w.inviteId('vps-1')}/cancel`,
      headers: w.session,
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await w.enroll({ enrollCode: token })).statusCode).toBe(401);
  });
});

describe('how it will be installed (cloud-init codes expire in 1 hour)', () => {
  test('a line invite: 24 hours, and the result page holds the line only', async () => {
    const w = await world();
    w.sudo();
    const r = await w.add({ name: 'vps-1', slots: 'auto', kind: 'line' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('| sudo sh -s -- jm_enroll_');
    expect(r.body).not.toContain('#cloud-config');
    expect(r.body).toContain('(24 hours)');
    const row = w.db.prepare('SELECT kind, expires_at AS e FROM stick_invites').get() as {
      kind: string;
      e: string;
    };
    expect(row.kind).toBe('line');
    expect(Date.parse(row.e) - t0.getTime()).toBe(24 * 60 * MINUTE);
  });

  test('a cloud-init invite: expiresAt is created + 1 hour, and the result page holds the cloud-config only', async () => {
    const w = await world();
    w.sudo();
    const r = await w.add({ name: 'vps-1', slots: 'auto', kind: 'cloud_init' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('#cloud-config');
    expect(r.body).not.toContain('id="install-line"');
    expect(r.body).not.toContain('role="tab"');
    expect(r.body).toContain('(1 hour)');
    const row = w.db.prepare('SELECT kind, expires_at AS e FROM stick_invites').get() as {
      kind: string;
      e: string;
    };
    expect(row.kind).toBe('cloud_init');
    expect(Date.parse(row.e) - t0.getTime()).toBe(60 * MINUTE);
  });

  test('no choice is a line invite; an unknown one is refused', async () => {
    const w = await world();
    w.sudo();
    expect((await w.add({ name: 'vps-1', slots: 'auto' })).statusCode).toBe(200);
    expect(w.db.prepare('SELECT kind FROM stick_invites').get()).toEqual({ kind: 'line' });
    const bad = await w.add({ name: 'vps-2', slots: 'auto', kind: 'carrier-pigeon' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('Paste a line or Cloud-init user data');
  });
});
