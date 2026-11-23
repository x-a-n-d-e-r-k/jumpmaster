import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import type { Principal } from '../auth/guard.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { sha256Hex } from '../auth/sessions.js';
import { getCard, recordCard } from '../chat/cards.js';
import { appendMessage, createThread } from '../chat/store.js';
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
  const confirm = (
    id: string,
    form: Record<string, string>,
    s = one,
    headers = {},
    remoteAddress?: string,
  ) =>
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
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  /** The dialog's frame: the confirm content alone. */
  const frame = (id: string, s = one) =>
    a.inject({
      method: 'GET',
      url: `/config/confirm/${id}?frame=1`,
      headers: { host: HOST, cookie: s.cookie },
    });
  /** The dialog's POST: the same form, answered in JSON, with the session's CSRF header. */
  const confirmJson = (
    id: string,
    form: Record<string, string>,
    s = one,
    headers: Record<string, string> = {},
    remoteAddress?: string,
  ) =>
    confirm(
      id,
      form,
      s,
      { accept: 'application/json', 'x-jm-csrf': s.csrf, ...headers },
      remoteAddress,
    );
  return { db, store, clock, one, two, propose, page, tokenIn, confirm, frame, confirmJson };
}

const weaken = { dropZones: [zone({ ciRequired: false, egress: { mode: 'off', allow: [] } })] };

/** #628: a POST-rendered notice carries the one breadcrumb, Home › it, and no Back link. */
function expectHomeCrumbs(body: string, title: string): void {
  expect(body.match(/<nav class="crumbs" aria-label="Breadcrumb">/g)).toHaveLength(1);
  expect(body).toContain(
    `<ol><li><a href="/">Home</a></li><li><span aria-current="page">${title}</span></li></ol>`,
  );
  expect(body).not.toMatch(/<a [^>]*>[^<]*Back[^<]*<\/a>/);
}

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
    expectHomeCrumbs(ok.body, 'Applied');
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
    expectHomeCrumbs(again.body, 'Not applied');
    expect(w.store.revision()).toBe(3);
  });

  test("Not applied lists the validator's issues in project words, keys and ids as they are", async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.page(id)).body);
    vi.spyOn(w.store, 'apply').mockReturnValueOnce({
      ok: false,
      issues: [
        {
          path: 'dropZones.0.ciRequired',
          message: 'a starter zone requires ciRequired: true',
        },
        { path: 'dropZones.1.id', message: 'duplicate zone id: drop-zone' },
      ],
    });
    const r = await w.confirm(id, { token, passphrase: PASS });
    expect(r.statusCode).toBe(400);
    expectHomeCrumbs(r.body, 'Not applied');
    expect(r.body).toContain(
      'dropZones.0.ciRequired: a starter project requires ciRequired: true; dropZones.1.id: duplicate project id: drop-zone',
    );
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

describe('cancelTo', () => {
  test('a PATCH can name where Cancel goes, under the same path-only rule as returnTo', async () => {
    const w = await world();
    const id = await w.propose(weaken, w.one, { cancelTo: '/projects' });
    expect((await w.page(id)).body).toContain('<a href="/projects">Cancel</a>');
    const id2 = await w.propose(weaken, w.one, { cancelTo: 'https://evil.example/' });
    const body = (await w.page(id2)).body;
    expect(body).toContain('<a href="/">Cancel</a>');
    expect(body).not.toContain('evil.example');
  });
});

describe('the confirm dialog (#503)', () => {
  const applies = (w: Awaited<ReturnType<typeof world>>) =>
    listAudit(w.db).filter((a) => a.action === 'config.apply');

  test('?frame=1 is the confirm content alone, minted like the page, with the CSRF token', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const r = await w.frame(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('Agent PRs in main will merge without CI');
    expect(r.body).toContain('type="password" name="passphrase"');
    expect(w.tokenIn(r.body)).toMatch(/^[\w-]{40,}$/);
    expect(r.body).toContain('Confirm</button>');
    expect(r.body).toContain('Cancel');
    expect(r.body).toContain(`<meta name="jm-csrf" content="${w.one.csrf}">`);
    for (const chrome of ['<header', '<nav', '<html', '<body', '<script', '<h2'])
      expect(r.body).not.toContain(chrome);
    // The frame's token is the live one: it confirms the change on the page's own POST.
    const ok = await w.confirm(id, { token: w.tokenIn(r.body), passphrase: PASS });
    expect(ok.statusCode).toBe(200);
  });

  test('the frame mints a fresh token each render, replacing the page one, as the page does', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const fromPage = w.tokenIn((await w.page(id)).body);
    const fromFrame = w.tokenIn((await w.frame(id)).body);
    expect(fromFrame).not.toBe(fromPage);
    const stale = await w.confirmJson(id, { token: fromPage, passphrase: PASS });
    expect([stale.statusCode, stale.json()]).toEqual([409, { error: 'unknown' }]);
  });

  test('#579: without a session the frame GET is a redirect to /login (or /setup) and the JSON POST a plain-text 401, never { error: passphrase }', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    const frame = await app?.inject({
      method: 'GET',
      url: `/config/confirm/${id}?frame=1`,
      headers: { host: HOST },
    });
    expect(frame?.statusCode).toBe(302);
    expect(frame?.headers.location).toBe(
      `/login?next=${encodeURIComponent(`/config/confirm/${id}?frame=1`)}`,
    );
    const post = await app?.inject({
      method: 'POST',
      url: `/config/confirm/${id}`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'x-jm-csrf': w.one.csrf,
      },
      payload: new URLSearchParams({ token, passphrase: PASS }).toString(),
    });
    expect(post?.statusCode).toBe(401);
    expect(post?.headers['content-type']).toMatch(/^text\/plain/);
    expect(post?.body).toBe('log in first');
    expect(post?.body).not.toContain(PASS);
    expect(w.store.revision()).toBe(2);
    expect(applies(w)).toEqual([]);
    // Setup mode, still without a session: both go to /setup (a redirect `fetch` follows).
    w.db.prepare('DELETE FROM operator').run();
    const inSetup = await app?.inject({
      method: 'GET',
      url: `/config/confirm/${id}?frame=1`,
      headers: { host: HOST },
    });
    expect([inSetup?.statusCode, inSetup?.headers.location]).toEqual([302, '/setup']);
    const postInSetup = await app?.inject({
      method: 'POST',
      url: `/config/confirm/${id}`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token, passphrase: PASS }).toString(),
    });
    expect([postInSetup?.statusCode, postInSetup?.headers.location]).toEqual([302, '/setup']);
    expect(w.store.revision()).toBe(2);
  });

  test('D1: an unknown, expired or other-session id is 404 GONE on the frame; the JSON POST of another session is 404 and applies nothing', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    const theirs = await w.frame(id, w.two);
    const unknown = await w.frame('nope');
    expect([theirs.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(theirs.body).toBe(unknown.body.replace(w.one.csrf, w.two.csrf));
    expect(theirs.body).toContain('Nothing to confirm');
    expect(theirs.body).not.toContain('<nav');
    const cross = await w.confirmJson(id, { token, passphrase: PASS }, w.two);
    expect([cross.statusCode, cross.json()]).toEqual([404, { error: 'gone' }]);
    expect(w.store.revision()).toBe(2);
    expect(applies(w)).toEqual([]);
    // Still this session's to confirm.
    w.clock.now = plus(t0, PENDING_MS);
    expect((await w.frame(id)).statusCode).toBe(404);
    const late = await w.confirmJson(id, { token, passphrase: PASS });
    expect([late.statusCode, late.json()]).toEqual([404, { error: 'gone' }]);
    expect(w.store.revision()).toBe(2);
  });

  test('D2: a wrong passphrase is 401 JSON, applies nothing, and charges the backoff exactly as the HTML path', async () => {
    const run = async (json: boolean) => {
      const w = await world();
      const id = await w.propose(weaken);
      const token = w.tokenIn((await w.frame(id)).body);
      const post = json ? w.confirmJson : w.confirm;
      const wrong = await post(id, { token, passphrase: 'not the passphrase at all' });
      const held = await post(id, {
        token: json ? token : w.tokenIn(wrong.body),
        passphrase: PASS,
      });
      const statuses = [wrong.statusCode, held.statusCode, held.headers['retry-after']];
      const revision = w.store.revision();
      const audit = applies(w).length;
      w.clock.now = plus(t0, 2000);
      const ok = await post(id, { token: json ? token : w.tokenIn(held.body), passphrase: PASS });
      return { w, wrong, held, statuses, revision, audit, ok };
    };
    const j = await run(true);
    const h = await run(false);
    expect(j.wrong.json()).toEqual({ error: 'passphrase' });
    expect(j.held.json()).toEqual({ error: 'backoff', retryAfter: 1 });
    expect(j.statuses).toEqual(h.statuses);
    expect(j.statuses.slice(0, 2)).toEqual([401, 429]);
    expect([j.revision, j.audit]).toEqual([2, 0]);
    expect([h.revision, h.audit]).toEqual([2, 0]);
    expect([j.ok.statusCode, j.ok.json()]).toEqual([200, { applied: true, revision: 3 }]);
    expect(h.ok.statusCode).toBe(200);
  });

  test('D2: an apply that throws is a 5xx JSON error, nothing applied, onApplied never called', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    const before = w.store.document();
    const spy = vi.spyOn(w.store, 'apply').mockImplementation(() => {
      throw new Error('disk full');
    });
    // A chat card waiting on this change: onApplied would settle it.
    const th = createThread(w.db, { title: 't' }, t0);
    const msg = appendMessage(w.db, th.id, { role: 'owner', text: 'x', state: 'done' }, t0);
    const card = recordCard(
      w.db,
      {
        threadId: th.id,
        messageId: msg.id,
        kind: 'setting',
        state: 'pending',
        link: `/config/confirm/${id}`,
        summary: 'Turn off CI in main',
        undo: { paths: ['dropZones[main].ciRequired'], what: 'CI in main' },
      },
      t0,
    );
    const r = await w.confirmJson(id, { token, passphrase: PASS });
    spy.mockRestore();
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.json()).toEqual({ error: 'failed' });
    expect(r.body).not.toContain('disk full');
    expect(w.store.revision()).toBe(2);
    expect(w.store.document()).toEqual(before);
    expect(applies(w)).toEqual([]);
    expect(getCard(w.db, card.id)?.state).toBe('pending');
  });

  test('D3: two JSON POSTs with one token: exactly one applies, the other is 409 used', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    const [a, b] = await Promise.all([
      w.confirmJson(id, { token, passphrase: PASS }, w.one, {}, '10.0.0.1'),
      w.confirmJson(id, { token, passphrase: PASS }, w.one, {}, '10.0.0.2'),
    ]);
    const answers = [a, b].map((r) => [r.statusCode, r.json()]);
    expect(answers).toContainEqual([200, { applied: true, revision: 3 }]);
    expect(answers).toContainEqual([409, { error: 'used' }]);
    expect(w.store.revision()).toBe(3);
    expect(applies(w)).toHaveLength(1);
  });

  test('the JSON path without the CSRF header, or cross-site, is refused before anything is charged, like the HTML path', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    const noCsrf = await w.confirm(id, { token, passphrase: 'wrong' }, w.one, {
      accept: 'application/json',
    });
    expect(noCsrf.statusCode).toBe(403);
    const crossJson = await w.confirmJson(id, { token, passphrase: 'wrong' }, w.one, {
      origin: 'http://evil.example',
    });
    const crossHtml = await w.confirm(id, { token, passphrase: 'wrong' }, w.one, {
      origin: 'http://evil.example',
    });
    expect([crossJson.statusCode, crossHtml.statusCode]).toEqual([403, 403]);
    // Nothing was charged: the right passphrase still goes straight through.
    const ok = await w.confirmJson(id, { token, passphrase: PASS });
    expect(ok.statusCode).toBe(200);
  });

  test('parity: the same change confirmed through HTML and through JSON makes the same revision and audit', async () => {
    const h = await world();
    const hid = await h.propose(weaken);
    const hr = await h.confirm(hid, {
      token: h.tokenIn((await h.page(hid)).body),
      passphrase: PASS,
    });
    const j = await world();
    const jid = await j.propose(weaken);
    const jr = await j.confirmJson(jid, {
      token: j.tokenIn((await j.frame(jid)).body),
      passphrase: PASS,
    });
    expect([hr.statusCode, jr.statusCode]).toEqual([200, 200]);
    expect(jr.json()).toEqual({ applied: true, revision: h.store.revision() });
    expect(j.store.document()).toEqual(h.store.document());
    const pick = (w: typeof h) =>
      applies(w).map((a) => ({ via: a.via, action: a.action, detail: a.detail }));
    expect(pick(j)).toEqual(pick(h));
    expect(pick(j)).toHaveLength(1);
  });

  test('a JSON replay, a stale token and an expired token are 409 with their reason', async () => {
    const w = await world();
    const id = await w.propose(weaken);
    const token = w.tokenIn((await w.frame(id)).body);
    w.clock.now = plus(t0, CONFIRM_MS);
    const late = await w.confirmJson(id, { token, passphrase: PASS });
    expect([late.statusCode, late.json()]).toEqual([409, { error: 'expired' }]);
    w.clock.now = t0;
    const fresh = w.tokenIn((await w.frame(id)).body);
    expect((await w.confirmJson(id, { token: fresh, passphrase: PASS })).statusCode).toBe(200);
    const again = await w.confirmJson(id, { token: fresh, passphrase: PASS });
    expect([again.statusCode, again.json()]).toEqual([409, { error: 'used' }]);
  });

  test('the HTML path with returnTo still redirects 303; JSON answers JSON instead', async () => {
    const w = await world();
    const id = await w.propose(weaken, w.one, { returnTo: '/setup/doctor' });
    const r = await w.confirm(id, { token: w.tokenIn((await w.page(id)).body), passphrase: PASS });
    expect([r.statusCode, r.headers.location]).toEqual([303, '/setup/doctor']);
    const w2 = await world();
    const id2 = await w2.propose(weaken, w2.one, { returnTo: '/setup/doctor' });
    const r2 = await w2.confirmJson(id2, {
      token: w2.tokenIn((await w2.frame(id2)).body),
      passphrase: PASS,
    });
    expect([r2.statusCode, r2.headers.location, r2.json()]).toEqual([
      200,
      undefined,
      { applied: true, revision: 3 },
    ]);
  });
});
