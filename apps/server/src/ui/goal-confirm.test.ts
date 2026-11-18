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
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { getGoalChange, openGoalChange, proposeGoalChange } from '../goal-change.js';
import { refreshGoals } from '../goals.js';
import { GOAL } from '../test/crew.js';
import { fakeForgePair } from '../test/fakes.js';
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
const NEW_GOAL = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the user guide');

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function world() {
  const db = openDb(tmpDbFile());
  const clock = { now: t0 };
  const dir = mkdtempSync(join(tmpdir(), 'jm-goal-confirm-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, join(dir, 'none.json')),
    env,
    now: () => clock.now,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  store.apply(
    {
      dropZones: [
        {
          id: 'main',
          repo: 'octo/demo',
          gates: [{ name: 'test', run: 'npm test' }],
          image: 'jm-trooper:dev',
          crew: { enabled: true },
        },
      ],
    },
    { via: 'ctl', principal: tokenPrincipal },
  );
  await setOperatorPassphrase(db, PASS, t0);
  const f = fakeForgePair({ issues: [], trusted: [] });
  f.state.branches.set('main', 'base0');
  f.state.files.set('base0:GOAL.md', GOAL);
  f.state.files.set('main:GOAL.md', GOAL);
  const forges = { author: f.author, reviewer: f.reviewer };
  const zone = store.current().dropZones[0];
  if (!zone) throw new Error('no zone');
  await refreshGoals(db, f.author, zone, 'main', t0);
  const proposed = proposeGoalChange(
    db,
    zone,
    { text: NEW_GOAL, source: 'chat', sourceRef: 'chat:1:2' },
    t0,
  );
  if (!proposed.ok) throw new Error(proposed.error);
  const id = proposed.id;
  expect(await openGoalChange(db, forges, zone, id, t0)).toBe('open');
  const head = getGoalChange(db, id)?.headSha as string;
  const pr = getGoalChange(db, id)?.prNumber as number;
  const a = createApp({
    db,
    config: store,
    forgesFor: () => forges,
    now: () => clock.now,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  app = a;
  const one = operatorSession(db);
  const page = (headers: Record<string, string> = { cookie: one.cookie }) =>
    a.inject({
      method: 'GET',
      url: `/goal-changes/${id}/confirm`,
      headers: { host: HOST, ...headers },
    });
  const confirm = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    a.inject({
      method: 'POST',
      url: `/goal-changes/${id}/confirm`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: one.cookie,
        'x-jm-csrf': one.csrf,
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      payload: new URLSearchParams(form).toString(),
    });
  const audits = () => listAudit(db).filter((r) => r.action === 'goal.confirm');
  return { db, f, clock, id, head, pr, one, page, confirm, audits, app: a };
}

describe('the goal-change confirm page (#363)', () => {
  test('GET shows the diff and the head SHA, with a passphrase field', async () => {
    const w = await world();
    const r = await w.page();
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain('+ ### Write the user guide');
    expect(r.body).toContain(w.head);
    expect(r.body).toContain(`name="headSha" value="${w.head}"`);
    expect(r.body).toContain('type="password" name="passphrase"');
    expect(r.body).toContain(`action="/goal-changes/${w.id}/confirm"`);
  });

  test('a right passphrase at the PR head records confirmed_sha and audits goal.confirm via session', async () => {
    const w = await world();
    const r = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(r.statusCode, r.body).toBe(200);
    expect(getGoalChange(w.db, w.id)).toMatchObject({
      state: 'confirmed',
      confirmedSha: w.head,
      confirmedAt: t0.toISOString(),
    });
    const audit = w.audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ via: 'session', target: `goal-change:${w.id}` });
    expect(JSON.stringify(audit[0])).not.toContain(PASS);
  });

  test('D1 the confirm page needs the passphrase and a session; the Bearer token gets 401', async () => {
    const w = await world();
    // The token never opens the page, and never confirms.
    const get = await w.page({ authorization: `Bearer ${TOKEN}` });
    expect(get.statusCode).not.toBe(200);
    expect(get.body).not.toContain(w.head);
    const bearer = await w.confirm(
      { passphrase: PASS, headSha: w.head },
      { cookie: '', authorization: `Bearer ${TOKEN}` },
    );
    expect(bearer.statusCode).toBe(401);
    // A session without the passphrase confirms nothing.
    const bare = await w.confirm({ headSha: w.head });
    expect(bare.statusCode).toBe(401);
    expect(getGoalChange(w.db, w.id)).toMatchObject({ state: 'open', confirmedSha: null });
    expect(w.audits()).toEqual([]);
  });

  test('D2 a wrong passphrase confirms nothing and charges the backoff', async () => {
    const w = await world();
    const wrong = await w.confirm({ passphrase: 'not it', headSha: w.head });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain('That passphrase is not right.');
    expect(getGoalChange(w.db, w.id)).toMatchObject({ state: 'open', confirmedSha: null });
    // Charged: even the right passphrase waits now.
    const held = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(held.statusCode).toBe(429);
    expect(getGoalChange(w.db, w.id)?.state).toBe('open');
    expect(w.audits()).toEqual([]);
    w.clock.now = plus(t0, 2000);
    expect((await w.confirm({ passphrase: PASS, headSha: w.head })).statusCode).toBe(200);
  });

  test('D3 two confirm POSTs for one change record one confirmation', async () => {
    const w = await world();
    const first = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(first.statusCode).toBe(200);
    const second = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(second.statusCode).toBe(409);
    const again = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(again.statusCode).toBe(409);
    expect(w.audits()).toHaveLength(1);
    expect(getGoalChange(w.db, w.id)?.confirmedSha).toBe(w.head);
  });

  test('a head that is not the PR head now confirms nothing', async () => {
    const w = await world();
    const stale = await w.confirm({ passphrase: PASS, headSha: 'some-other-sha' });
    expect(stale.statusCode).toBe(409);
    // The PR moved after the page was shown: the SHA the page showed is no longer its head.
    w.f.state.setHead(w.pr, 'sha-B');
    const moved = await w.confirm({ passphrase: PASS, headSha: w.head });
    expect(moved.statusCode).toBe(409);
    expect(moved.body).toMatch(/propose/i);
    // Nor does the new head, which is not the commit the server made.
    const other = await w.confirm({ passphrase: PASS, headSha: 'sha-B' });
    expect(other.statusCode).toBe(409);
    expect(getGoalChange(w.db, w.id)).toMatchObject({ state: 'open', confirmedSha: null });
    expect(w.audits()).toEqual([]);
  });

  test("the zone's goals page shows the open goal change and its Approve and merge link", async () => {
    const w = await world();
    const r = await w.app.inject({
      method: 'GET',
      url: '/zones/main/goals',
      headers: { host: HOST, cookie: w.one.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`href="/goal-changes/${w.id}/confirm"`);
    expect(r.body).toContain('Approve and merge');
    expect(r.body).toContain(`#${w.pr}`);
  });
});
