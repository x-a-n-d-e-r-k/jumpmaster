import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import { listRulings, raiseBriefing } from '../briefings.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { type Config, secretList } from '../config.js';
import { nextCrewWork } from '../crew/schedule.js';
import { listCrewIssues } from '../crew/store.js';
import { ctlRequest } from '../ctl.js';
import { openDb } from '../db/open.js';
import {
  getOutbox,
  getZoneMode,
  insertDrop,
  isKilled,
  setKilled,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
  zoneIsDrained,
} from '../db/repo.js';
import { intakeKey } from '../intake.js';
import { AUTHOR_TOKEN, CLAUDE_TOKEN, NOW, world } from '../test/doctorWorld.js';
import { fakeForgePair } from '../test/fakes.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { type ControlDeps, registerControlRoutes } from './control.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(allowedHosts?: string[], zone = makeZone({ id: 'main' })) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  const config = {
    listen: { host: '127.0.0.1', port: 7420, ...(allowedHosts ? { allowedHosts } : {}) },
    dropZones: [zone],
    secrets: { operatorToken: TOKEN },
  } as unknown as Config;
  app = controlApp({ db, config, now: () => t0 });
  return db;
}

/** The control routes behind the guard, as `createApp` mounts them. */
function controlApp(deps: ControlDeps): FastifyInstance {
  const a = Fastify();
  registerGuard(a, deps);
  registerControlRoutes(a, deps);
  return a;
}

const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app?.inject({ method: 'POST', url, headers, payload }) as NonNullable<
    ReturnType<NonNullable<typeof app>['inject']>
  >;

function busy(db: ReturnType<typeof openDb>) {
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 't',
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(db, wi.id, 'in_flight');
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'main',
    workItemId: wi.id,
    role: 'implement',
    state: 'queued',
    createdAt: t0.toISOString(),
  });
}

describe('control routes', () => {
  test('every control route refuses a missing or wrong token', async () => {
    const db = setup();
    for (const headers of [{ host: HOST }, { host: HOST, authorization: 'Bearer nope' }]) {
      expect((await post('/api/control/zones/main', { mode: 'paused' }, headers)).statusCode).toBe(
        401,
      );
      expect((await post('/api/control/kill', { engaged: true }, headers)).statusCode).toBe(401);
    }
    expect(getZoneMode(db, 'main', 'active')).toBe('active');
    expect(isKilled(db)).toBe(false);
  });

  test('a wrong Host or foreign Origin is refused even with the token', async () => {
    const db = setup();
    const wrongHost = { ...auth, host: 'evil.test' };
    const foreign = { ...auth, origin: 'http://evil.test' };
    expect((await post('/api/control/zones/main', { mode: 'paused' }, wrongHost)).statusCode).toBe(
      403,
    );
    expect((await post('/api/control/zones/main', { mode: 'paused' }, foreign)).statusCode).toBe(
      403,
    );
    expect(getZoneMode(db, 'main', 'active')).toBe('active');
  });

  test('a same-origin browser request is accepted', async () => {
    setup();
    const res = await post(
      '/api/control/zones/main',
      { mode: 'paused' },
      { ...auth, origin: `http://${HOST}` },
    );
    expect(res.statusCode).toBe(200);
  });

  test('a listed host is accepted on a non-loopback listen address', async () => {
    setup(['10.0.0.5:7420']);
    const res = await post(
      '/api/control/zones/main',
      { mode: 'paused' },
      { ...auth, host: '10.0.0.5:7420' },
    );
    expect(res.statusCode).toBe(200);
    expect((await post('/api/control/zones/main', { mode: 'paused' })).statusCode).toBe(403);
  });

  test('moving to observe is refused while the zone has active work', async () => {
    const db = setup();
    busy(db);
    const res = await post('/api/control/zones/main', { mode: 'observe' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/1 active/);
    expect(getZoneMode(db, 'main', 'active')).toBe('active');
  });

  test('moving to observe succeeds once drained', async () => {
    const db = setup();
    expect(zoneIsDrained(db, 'main')).toBe(true);
    expect((await post('/api/control/zones/main', { mode: 'observe' })).statusCode).toBe(200);
    expect(getZoneMode(db, 'main', 'active')).toBe('observe');
  });

  test('pause and resume are allowed with active work', async () => {
    const db = setup();
    busy(db);
    expect((await post('/api/control/zones/main', { mode: 'paused' })).statusCode).toBe(200);
    expect(getZoneMode(db, 'main', 'active')).toBe('paused');
    expect((await post('/api/control/zones/main', { mode: 'active' })).statusCode).toBe(200);
    expect(getZoneMode(db, 'main', 'paused')).toBe('active');
  });

  test('an unknown zone or mode is refused', async () => {
    setup();
    expect((await post('/api/control/zones/nope', { mode: 'paused' })).statusCode).toBe(404);
    expect((await post('/api/control/zones/main', { mode: 'sideways' })).statusCode).toBe(400);
    expect((await post('/api/control/kill', { engaged: 'yes' })).statusCode).toBe(400);
  });

  test('a stored mode survives a restart and beats the config default', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    expect(getZoneMode(db, 'main', 'observe')).toBe('observe');
    setZoneMode(db, 'main', 'paused', t0);
    db.close();
    expect(getZoneMode(openDb(file), 'main', 'active')).toBe('paused');
  });

  test('the kill route engages and resets the switch, which persists', async () => {
    const db = setup();
    expect((await post('/api/control/kill', { engaged: true })).statusCode).toBe(200);
    expect(isKilled(db)).toBe(true);
    expect((await post('/api/control/kill', { engaged: false })).statusCode).toBe(200);
    expect(isKilled(db)).toBe(false);
  });
});

describe('ctl', () => {
  test('commands map to control requests', () => {
    expect(ctlRequest(['pause', 'main'])).toEqual({
      path: '/api/control/zones/main',
      body: { mode: 'paused' },
    });
    expect(ctlRequest(['resume', 'main'])?.body).toEqual({ mode: 'active' });
    expect(ctlRequest(['observe', 'main'])?.body).toEqual({ mode: 'observe' });
    expect(ctlRequest(['kill'])).toEqual({ path: '/api/control/kill', body: { engaged: true } });
    expect(ctlRequest(['unkill'])?.body).toEqual({ engaged: false });
    expect(ctlRequest(['pause'])).toBeNull();
    expect(ctlRequest(['nonsense', 'main'])).toBeNull();
    expect(ctlRequest(['crew-cycle', 'main'])).toEqual({
      path: '/api/control/zones/main/crew-cycle',
      body: {},
    });
    expect(ctlRequest(['crew-cycle'])).toBeNull();
  });
});

describe('crew-cycle route', () => {
  test('makes the lead cycle due now; 404 for an unknown zone, 409 with the crew off', async () => {
    const crew = { ...makeZone().crew, enabled: true, cycleMinutes: 60 };
    const db = setup(undefined, makeZone({ id: 'main', crew }));
    insertDrop(db, {
      id: 'lead',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'succeeded',
      createdAt: new Date(t0.getTime() - 60_000).toISOString(),
    });
    const zone = makeZone({ id: 'main', crew });
    expect(nextCrewWork(db, zone, t0)).toBeNull();
    expect((await post('/api/control/zones/main/crew-cycle', {})).statusCode).toBe(200);
    expect(nextCrewWork(db, zone, new Date(t0.getTime() + 1000))).toEqual({ role: 'crew-lead' });
    expect((await post('/api/control/zones/nope/crew-cycle', {})).statusCode).toBe(404);
    expect((await post('/api/control/zones/main/crew-cycle', {}, { host: HOST })).statusCode).toBe(
      401,
    );
  });

  test('409 when the crew is off', async () => {
    setup();
    expect((await post('/api/control/zones/main/crew-cycle', {})).statusCode).toBe(409);
  });
});

describe('rule route', () => {
  function withBriefing() {
    const db = setup();
    const id = raiseBriefing(
      db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'goal change',
        decision: 'd',
        why: 'w',
        options: [
          { id: 'yes', label: 'Yes', effect: 'none' },
          { id: 'no', label: 'No', effect: 'none' },
        ],
        source: 'crew',
      },
      t0,
    );
    return { db, id };
  }

  test('the rule route refuses a missing token and a foreign Origin', async () => {
    const { db, id } = withBriefing();
    const url = `/api/control/briefings/${id}/rule`;
    expect((await post(url, { optionId: 'yes' }, { host: HOST })).statusCode).toBe(401);
    expect(
      (await post(url, { optionId: 'yes' }, { ...auth, origin: 'http://evil.test' })).statusCode,
    ).toBe(403);
    expect(listRulings(db, 'main')).toEqual([]);
  });

  test('records a ruling, then 409 on a second; 400 on a bad option or long note; 404 unknown', async () => {
    const { db, id } = withBriefing();
    const url = `/api/control/briefings/${id}/rule`;
    expect((await post(url, { optionId: 'maybe' })).statusCode).toBe(400);
    expect((await post(url, { optionId: 'yes', note: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await post('/api/control/briefings/999/rule', { optionId: 'yes' })).statusCode).toBe(
      404,
    );
    expect((await post('/api/control/briefings/abc/rule', { optionId: 'yes' })).statusCode).toBe(
      404,
    );
    const ok = await post(url, { optionId: 'yes', note: 'fine' });
    expect(ok.statusCode).toBe(200);
    expect((await post(url, { optionId: 'no' })).statusCode).toBe(409);
    expect(listRulings(db, 'main').map((r) => [r.choice, r.note])).toEqual([['yes', 'fine']]);
  });

  test('ctl rule builds the rule request', () => {
    expect(ctlRequest(['rule', '7', 'retry'])).toEqual({
      path: '/api/control/briefings/7/rule',
      body: { optionId: 'retry' },
    });
    expect(ctlRequest(['rule', '7', 'retry', 'looks', 'fine'])?.body).toEqual({
      optionId: 'retry',
      note: 'looks fine',
    });
    expect(ctlRequest(['rule', '7', 'o1', '--options', 'abc123', 'looks', 'fine'])?.body).toEqual({
      optionId: 'o1',
      optionsDigest: 'abc123',
      note: 'looks fine',
    });
    expect(ctlRequest(['rule', '7', 'o1', '--options'])).toBeNull();
    expect(ctlRequest(['rule', '7'])).toBeNull();
  });
});

describe('doctor routes', () => {
  function doctorApp() {
    const w = world();
    app = controlApp({
      db: w.db,
      config: { ...w.config, secrets: { ...w.config.secrets, operatorToken: TOKEN } },
      now: () => NOW,
      forgesFor: w.deps.forges,
      doctorEnv: w.deps.env,
    });
    return w;
  }

  test('the doctor routes need the operator token and an allowed Origin', async () => {
    const w = doctorApp();
    const get = (headers: Record<string, string>) =>
      app?.inject({ method: 'GET', url: '/api/control/doctor', headers });
    expect((await post('/api/control/doctor', {}, { host: HOST }))?.statusCode).toBe(401);
    expect((await get({ host: HOST }))?.statusCode).toBe(401);
    expect(
      (await post('/api/control/doctor', {}, { ...auth, origin: 'http://evil.test' }))?.statusCode,
    ).toBe(403);
    expect((await get({ ...auth, host: 'evil.test:7420' }))?.statusCode).toBe(403);
    expect(w.f.author.calls).toEqual([]);
    expect((await get(auth))?.json()).toEqual({ run: null });

    const ran = await post('/api/control/doctor', {});
    expect(ran?.statusCode).toBe(200);
    const run = ran?.json() as { run: { id: number; checks: { id: string }[] } };
    expect(run.run.checks.some((c) => c.id === 'forge.author')).toBe(true);
    expect((await get(auth))?.json()).toMatchObject({ run: { id: run.run.id } });
    expect((await post('/api/control/doctor', { zone: 'nope' }))?.statusCode).toBe(404);
    expect((await post('/api/control/doctor', { zone: 'main', extra: 1 }))?.statusCode).toBe(400);
  });

  test('ctl doctor builds the doctor request', () => {
    expect(ctlRequest(['doctor'])).toEqual({ path: '/api/control/doctor', body: {} });
    expect(ctlRequest(['doctor', 'main', '--json'])).toEqual({
      path: '/api/control/doctor',
      body: { zone: 'main' },
    });
    expect(ctlRequest(['doctor', 'main', '--drop'])).toEqual({
      path: '/api/control/doctor/drop',
      body: { zone: 'main' },
    });
    expect(ctlRequest(['doctor', '--drop'])).toBeNull();
  });

  test('ctl doctor --drop in observe or paused is refused naming the mode', async () => {
    const w = doctorApp();
    const ask = () => post('/api/control/doctor/drop', { zone: 'main' });
    const doctorDrops = () =>
      w.db.prepare("SELECT id, state, work_item_id AS item FROM drops WHERE role = 'doctor'").all();
    for (const mode of ['observe', 'paused'] as const) {
      setZoneMode(w.db, 'main', mode, NOW);
      const r = await ask();
      expect(r?.statusCode).toBe(409);
      expect(r?.json().error).toContain(mode);
    }
    setZoneMode(w.db, 'main', 'active', NOW);
    setKilled(w.db, true, NOW);
    expect((await ask())?.json().error).toContain('kill switch');
    setKilled(w.db, false, NOW);
    expect(doctorDrops()).toEqual([]);

    const queued = await ask();
    expect(queued?.statusCode).toBe(202);
    expect(queued?.json().next).toContain('waiting for a free stick slot');
    const { dropId } = queued?.json() as { dropId: string };
    expect(doctorDrops()).toEqual([{ id: dropId, state: 'queued', item: null }]);
    // One per zone: a second is refused while the first is active.
    const again = await ask();
    expect(again?.statusCode).toBe(409);
    expect(again?.json().error).toContain(dropId);
    expect((await post('/api/control/doctor/drop', { zone: 'nope' }))?.statusCode).toBe(404);
    expect((await post('/api/control/doctor/drop', {}))?.statusCode).toBe(400);
    expect(
      (await post('/api/control/doctor/drop', { zone: 'main' }, { host: HOST }))?.statusCode,
    ).toBe(401);
  });

  test('ctl doctor --drop under a usage pause queues it and says what holds it', async () => {
    const w = doctorApp();
    setUsageState(w.db, { pausedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }, NOW);
    const r = await post('/api/control/doctor/drop', { zone: 'main' });
    expect(r?.statusCode).toBe(202);
    expect(r?.json().next).toContain('held: usage paused until 2026-11-09T13:00:00.000Z');
  });

  test('I-4: a queued doctor drop does not block observe, and --cancel cancels it', async () => {
    const w = doctorApp();
    const queued = await post('/api/control/doctor/drop', { zone: 'main' });
    const { dropId } = queued?.json() as { dropId: string };
    // Observe is not blocked by a drop nothing will run.
    expect((await post('/api/control/zones/main', { mode: 'observe' }))?.statusCode).toBe(200);
    setZoneMode(w.db, 'main', 'active', NOW);
    const cancel = await post('/api/control/doctor/drop', { zone: 'main', cancel: true });
    expect(cancel?.statusCode).toBe(200);
    expect(cancel?.json()).toMatchObject({ dropId, state: 'cancelled' });
    expect(w.db.prepare('SELECT state FROM drops WHERE id = ?').get(dropId)).toEqual({
      state: 'cancelled',
    });
    // Nothing queued: nothing to cancel. A running one is not cancelled here.
    expect(
      (await post('/api/control/doctor/drop', { zone: 'main', cancel: true }))?.statusCode,
    ).toBe(404);
    const again = (await post('/api/control/doctor/drop', { zone: 'main' }))?.json() as {
      dropId: string;
    };
    w.db.prepare("UPDATE drops SET state = 'running' WHERE id = ?").run(again.dropId);
    const running = await post('/api/control/doctor/drop', { zone: 'main', cancel: true });
    expect(running?.statusCode).toBe(409);
    expect(running?.json().error).toContain('running');
    expect(ctlRequest(['doctor', 'main', '--cancel'])).toEqual({
      path: '/api/control/doctor/drop',
      body: { zone: 'main', cancel: true },
    });
  });
});

describe('intake routes', () => {
  const KEY = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
  const issue = {
    title: 'Add sum',
    context: 'The CLI needs a sum function.',
    acceptance: ['sum(1, 2) returns 3'],
    tests: ['a unit test for sum'],
  };
  const ISSUE_URL = '/api/control/zones/main/intake/issue';

  function intakeApp(
    zone = makeZone({ id: 'main' }),
    o: { db?: ReturnType<typeof openDb>; intakeForges?: ReturnType<typeof fakeForgePair> } = {},
  ) {
    const db = o.db ?? openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
    const f = fakeForgePair({ issues: [], trusted: [] });
    const timed = o.intakeForges;
    const config = {
      listen: { host: '127.0.0.1', port: 7420 },
      dropZones: [zone],
      secrets: { operatorToken: TOKEN, githubAuthorToken: 'github_pat_secretsecret' },
    } as unknown as Config;
    app = controlApp({
      db,
      config,
      now: () => t0,
      forgesFor: () => ({ author: f.author, reviewer: f.reviewer }),
      ...(timed
        ? { intakeForgesFor: () => ({ author: timed.author, reviewer: timed.reviewer }) }
        : {}),
    });
    return { db, f };
  }
  const creates = (f: ReturnType<typeof fakeForgePair>) =>
    f.author.calls.filter((c) => c.method === 'createIssue').length;

  test('intake/issue without the operator token is 401; with a foreign Origin 403', async () => {
    const { f } = intakeApp();
    const body = { idempotencyKey: KEY, ...issue };
    expect((await post(ISSUE_URL, body, { host: HOST })).statusCode).toBe(401);
    expect(
      (await post(ISSUE_URL, body, { ...auth, authorization: 'Bearer nope' })).statusCode,
    ).toBe(401);
    expect((await post(ISSUE_URL, body, { ...auth, origin: 'http://evil.test' })).statusCode).toBe(
      403,
    );
    expect(
      (await post('/api/control/zones/main/intake/goal-stub', {}, { host: HOST })).statusCode,
    ).toBe(401);
    expect(f.author.calls).toEqual([]);
  });

  test('intake/issue files one ready issue with the marker, objective "1", through the outbox', async () => {
    const { db, f } = intakeApp();
    const res = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(res.statusCode).toBe(201);
    const key = intakeKey(KEY);
    expect(res.json()).toMatchObject({ key, number: 1, state: 'promoted' });
    const filed = f.state.issues.get(1);
    expect(filed?.labels).toEqual(['agent-ready']);
    expect(filed?.issue?.title).toBe('Add sum');
    const body = filed?.issue?.body ?? '';
    expect(body).toContain('## Acceptance criteria');
    expect(body.trimEnd().split('\n').at(-1)).toBe(`<!-- jm:op:issue:main:1:${key} -->`);
    expect(listCrewIssues(db, 'main')).toEqual([
      expect.objectContaining({
        key,
        source: 'intake',
        objective: '1',
        number: 1,
        state: 'promoted',
      }),
    ]);
    expect(getOutbox(db, `issue:main:1:${key}`)?.state).toBe('done');
  });

  test('intake/issue is audited by its outcome, never its text', async () => {
    const { db } = intakeApp();
    const res = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(res.statusCode).toBe(201);
    const [row] = listAudit(db);
    expect(row).toMatchObject({
      action: 'intake.issue',
      via: 'token',
      target: 'main',
      detail: { status: 201, number: expect.any(Number) },
    });
    expect(JSON.stringify(row)).not.toContain('sum');
  });

  test('the same idempotencyKey twice files exactly once', async () => {
    const { db, f } = intakeApp();
    const a = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    const b = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue, title: 'Edited' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ number: 1, state: 'promoted', repeated: true });
    expect(creates(f)).toBe(1);
    expect(listCrewIssues(db, 'main')).toHaveLength(1);
  });

  test('a 5xx after create is resolved by marker read-back, not a second create', async () => {
    const { db, f } = intakeApp();
    f.author.failNext('createIssue', '5xx-after-success');
    const first = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'filing' });
    const again = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ number: 1, state: 'promoted' });
    expect(creates(f)).toBe(1);
    expect(listCrewIssues(db, 'main')[0]?.state).toBe('promoted');
  });

  test('intake in observe, paused or killed is 409 naming the mode', async () => {
    const { db, f } = intakeApp();
    for (const mode of ['observe', 'paused'] as const) {
      setZoneMode(db, 'main', mode, t0);
      const r = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toContain(mode);
    }
    setZoneMode(db, 'main', 'active', t0);
    setKilled(db, true, t0);
    const k = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(k.statusCode).toBe(409);
    expect(k.json().error).toContain('kill switch');
    expect(f.author.calls).toEqual([]);
    expect(listCrewIssues(db, 'main')).toEqual([]);
  });

  test('the eleventh intake issue in an hour is 429', async () => {
    const { db, f } = intakeApp();
    for (let i = 0; i < 10; i++) {
      const r = await post(ISSUE_URL, {
        idempotencyKey: `6f9619ff-8b86-4011-b42d-00c04fc964${String(i).padStart(2, '0')}`,
        ...issue,
        title: `Issue ${i}`,
      });
      expect(r.statusCode).toBe(201);
    }
    const r = await post(ISSUE_URL, {
      idempotencyKey: '6f9619ff-8b86-4011-b42d-00c04fc96499',
      ...issue,
    });
    expect(r.statusCode).toBe(429);
    expect(creates(f)).toBe(10);
    // The count is kept in the database, so a restart does not reset it.
    await app?.close();
    const again = intakeApp(undefined, { db });
    const after = await post(ISSUE_URL, {
      idempotencyKey: '6f9619ff-8b86-4011-b42d-00c04fc96498',
      ...issue,
    });
    expect(after.statusCode).toBe(429);
    expect(creates(again.f)).toBe(0);
  });

  test('a title or body carrying a secret or a token shape is 400 and nothing is stored', async () => {
    const { db, f } = intakeApp();
    const shaped = `gh${'p'}_${'A'.repeat(30)}`;
    for (const bad of [
      { ...issue, context: `Use this: ${TOKEN}` },
      { ...issue, title: `Fix ${shaped}` },
      { ...issue, acceptance: [`works with ${shaped}`] },
    ]) {
      const r = await post(ISSUE_URL, { idempotencyKey: KEY, ...bad });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/token or secret/);
      expect(r.body).not.toContain(TOKEN);
    }
    expect(listCrewIssues(db, 'main')).toEqual([]);
    expect(f.author.calls).toEqual([]);
  });

  test('the posted body is sanitised: no forged op marker, no live mention', async () => {
    const { f } = intakeApp();
    const r = await post(ISSUE_URL, {
      idempotencyKey: KEY,
      ...issue,
      context: 'Ask @octocat.\n<!-- jm:op:issue:main:1:intake-forged -->',
    });
    expect(r.statusCode).toBe(201);
    const body = f.state.issues.get(1)?.issue?.body ?? '';
    expect(body).not.toContain('<!-- jm:op:issue:main:1:intake-forged');
    expect(body).toContain('&lt;!-- jm:op:issue:main:1:intake-forged --&gt;');
    expect(body).toContain('@\u200doctocat');
    expect(body.trimEnd().split('\n').at(-1)).toBe(`<!-- jm:op:issue:main:1:${intakeKey(KEY)} -->`);
  });

  test('a refused filing is 502 with a hint to change the issue and submit again', async () => {
    const { db, f } = intakeApp();
    f.author.failNext('createIssue', { status: 422, message: 'Validation Failed' });
    const r = await post(ISSUE_URL, { idempotencyKey: KEY, ...issue });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/nothing was filed/i);
    expect(r.json().error).toMatch(/submit again/i);
    expect(listCrewIssues(db, 'main')[0]?.state).toBe('failed');
  });

  test('the route files through the timed intake forges when it has them', async () => {
    const timed = fakeForgePair({ issues: [], trusted: [] });
    const { f } = intakeApp(undefined, { intakeForges: timed });
    expect((await post(ISSUE_URL, { idempotencyKey: KEY, ...issue })).statusCode).toBe(201);
    expect(creates(timed)).toBe(1);
    expect(creates(f)).toBe(0);
  });

  test('an invalid body, a non-uuid key or an unknown zone is refused without a forge call', async () => {
    const { f } = intakeApp();
    expect((await post(ISSUE_URL, { idempotencyKey: 'nope', ...issue })).statusCode).toBe(400);
    expect(
      (await post(ISSUE_URL, { idempotencyKey: KEY, ...issue, acceptance: [] })).statusCode,
    ).toBe(400);
    expect(
      (await post('/api/control/zones/nope/intake/issue', { idempotencyKey: KEY, ...issue }))
        .statusCode,
    ).toBe(404);
    expect(f.author.calls).toEqual([]);
  });

  test('goal-stub makes no forge call', async () => {
    const { db, f } = intakeApp();
    const r = await post('/api/control/zones/main/intake/goal-stub', {
      template: 'existing',
      lighthouse: 'A small CLI.',
      objectives: ['Parse the input'],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().markdown).toContain('## Objectives');
    expect(
      (await post('/api/control/zones/main/intake/goal-stub', { template: 'nope' })).statusCode,
    ).toBe(400);
    expect(f.author.calls).toEqual([]);
    expect(listCrewIssues(db, 'main')).toEqual([]);
  });
});

describe('control audit', () => {
  test('every mutating control route writes a control_audit row from named fields, with its via and no secret value', async () => {
    const crew = { ...makeZone().crew, enabled: true, cycleMinutes: 60 };
    const w = world({ zone: { crew }, config: { mcp: { enabled: true } } as Partial<Config> });
    const db = w.db;
    app = controlApp({
      db,
      config: w.config,
      now: () => NOW,
      forgesFor: w.deps.forges,
      doctorEnv: w.deps.env,
    });
    const session = operatorSession(db, NOW);
    const briefing = (subject: string) =>
      raiseBriefing(
        db,
        {
          zoneId: 'main',
          kind: 'crew',
          subject,
          decision: 'd',
          why: 'w',
          options: [
            { id: 'yes', label: 'Yes', effect: 'none' },
            { id: 'no', label: 'No', effect: 'none' },
          ],
          source: 'crew',
        },
        NOW,
      );
    const send = (
      method: 'POST' | 'DELETE',
      url: string,
      payload: unknown,
      via: 'token' | 'session',
    ) =>
      (app as FastifyInstance).inject({
        method,
        url,
        headers: via === 'token' ? auth : { host: HOST, ...session.headers },
        ...(method === 'POST' ? { payload: payload as object } : {}),
      });
    // A pasted secret in a free-text field (a ruling note) must not reach the audit.
    const note = `see ${AUTHOR_TOKEN} and ${CLAUDE_TOKEN}`;
    const calls: [string, 'POST' | 'DELETE', string, unknown, 'token' | 'session'][] = [
      ['zone.mode', 'POST', '/api/control/zones/main', { mode: 'paused' }, 'session'],
      ['zone.mode', 'POST', '/api/control/zones/main', { mode: 'active' }, 'token'],
      [
        'briefing.rule',
        'POST',
        `/api/control/briefings/${briefing('a')}/rule`,
        { optionId: 'yes', note },
        'session',
      ],
      ['zone.crew-cycle', 'POST', '/api/control/zones/main/crew-cycle', {}, 'token'],
      [
        'mcp-token.mint',
        'POST',
        '/api/control/mcp-tokens',
        { zoneId: 'main', scope: 'read', days: 7, label: `x ${CLAUDE_TOKEN}` },
        'session',
      ],
      ['doctor.run', 'POST', '/api/control/doctor', {}, 'token'],
      ['doctor.drop', 'POST', '/api/control/doctor/drop', { zone: 'main' }, 'session'],
      [
        'doctor.drop-cancel',
        'POST',
        '/api/control/doctor/drop',
        { zone: 'main', cancel: true },
        'token',
      ],
      ['kill', 'POST', '/api/control/kill', { engaged: true }, 'session'],
      ['kill', 'POST', '/api/control/kill', { engaged: false }, 'token'],
    ];
    const minted: string[] = [];
    for (const [action, method, url, payload, via] of calls) {
      const res = await send(method, url, payload, via);
      expect([action, res.statusCode]).toEqual([action, res.statusCode < 300 ? res.statusCode : 0]);
      if (action === 'mcp-token.mint') minted.push((res.json() as { token: string }).token);
    }
    const revoke = await send('DELETE', '/api/control/mcp-tokens/1', undefined, 'token');
    expect(revoke.statusCode).toBe(200);
    const rows = listAudit(db).reverse();
    expect(rows.map((r) => [r.action, r.via])).toEqual([
      ...calls.map(([action, , , , via]) => [action, via]),
      ['mcp-token.revoke', 'token'],
    ]);
    expect(rows[0]).toMatchObject({ target: 'main', detail: { mode: 'paused' }, guarded: false });
    expect(rows[2]?.detail).toEqual({ optionId: 'yes', rulingId: expect.any(Number) });
    expect(rows[4]?.detail).toEqual({ id: 1, scope: 'read', days: 7 });
    const all = JSON.stringify(db.prepare('SELECT * FROM control_audit').all());
    for (const secret of [
      ...secretList(w.config.secrets),
      ...minted,
      session.id,
      session.csrf,
      'note',
    ]) {
      expect(all).not.toContain(secret);
    }
    // A GET writes nothing.
    await (app as FastifyInstance).inject({
      method: 'GET',
      url: '/api/control/briefings',
      headers: auth,
    });
    expect(listAudit(db)).toHaveLength(rows.length);
  });
});

describe('config routes', () => {
  const env = {
    JM_CLAUDE_TOKEN: 'claude-secret-value-1',
    JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
    JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
  };
  const zoneDoc = (id = 'main', extra: Record<string, unknown> = {}) => ({
    id,
    repo: `octo/${id}`,
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'jm-trooper:dev',
    ...extra,
  });

  /** The control routes over a real store: db mode, or file mode when `file` is given. */
  function configApp(file?: Record<string, unknown>) {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-cfg-'));
    const filePath = join(dir, 'jumpmaster.config.json');
    if (file) writeFileSync(filePath, JSON.stringify({ dataDir: './data', ...file }));
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, filePath),
      filePath,
      env,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    app = controlApp({
      db,
      config: store,
      now: () => t0,
      forgesFor: () => {
        throw new Error('no zone, no forge');
      },
      doctorEnv: { uid: 1000, inContainer: true, uidMap: null },
    });
    const session = operatorSession(db);
    const asSession = { ...session.headers, host: HOST };
    return { db, store, filePath, asSession };
  }
  const req = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = auth,
  ) =>
    (app as FastifyInstance).inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const revVia = (db: ReturnType<typeof openDb>) =>
    (db.prepare('SELECT via FROM config_revisions ORDER BY id').all() as { via: string }[]).map(
      (r) => r.via,
    );

  test('GET config shows the mode, revision, document, boot settings and restart state, never a secret', async () => {
    const { store } = configApp();
    store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    const r = await req('GET', '/api/control/config');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      mode: 'db',
      revision: 2,
      config: { dropZones: [zoneDoc()] },
      boot: {
        listen: {
          host: '127.0.0.1',
          port: 7420,
          allowedHosts: ['127.0.0.1:7420', 'localhost:7420'],
          tlsTerminated: false,
        },
        dataDir: './data',
        source: { listen: 'env', dataDir: 'env' },
      },
      restartPending: [],
      filePath: expect.stringMatching(/jumpmaster\.config\.json$/),
    });
    for (const s of Object.values(env)) expect(r.body).not.toContain(s);
  });

  test('PATCH applies a merge patch as ui from a session and ctl from the token, audited, and conflicts on a stale revision', async () => {
    const { db, store, asSession } = configApp();
    const one = await req(
      'PATCH',
      '/api/control/config',
      { patch: { pollSeconds: 30, dropZones: [zoneDoc()] }, expectRevision: 1, note: 'first' },
      asSession,
    );
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({
      revision: 2,
      changed: ['dropZones[main]', 'pollSeconds'],
      restartNeeded: [],
    });
    // null removes a key (RFC 7396): pollSeconds goes back to its default.
    const two = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: null },
      expectRevision: 2,
    });
    expect(two.statusCode).toBe(200);
    expect(store.current().pollSeconds).toBe(60);
    expect(store.document()).toEqual({ dropZones: [zoneDoc()] });
    expect(revVia(db)).toEqual(['setup', 'ui', 'ctl']);
    const stale = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 5 },
      expectRevision: 2,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ conflict: { expected: 2, actual: 3 } });
    const audits = listAudit(db).filter((a) => a.action === 'config.apply');
    expect(audits.map((a) => [a.via, a.detail.revision])).toEqual([
      ['token', 3],
      ['session', 2],
    ]);
    expect(audits[1]?.detail.changed).toBe('dropZones[main], pollSeconds');
  });

  test('PATCH refuses an invalid document by path, a boot setting, a long note and a missing revision, changing nothing', async () => {
    const { db, store } = configApp();
    const bad = await req('PATCH', '/api/control/config', {
      patch: { dropZones: [zoneDoc('main', { repo: 'nope' })] },
      expectRevision: 1,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({
      issues: [expect.objectContaining({ path: 'dropZones.0.repo' })],
    });
    const boot = await req('PATCH', '/api/control/config', {
      patch: { listen: { port: 1 } },
      expectRevision: 1,
    });
    expect(boot.statusCode).toBe(400);
    expect(boot.json()).toEqual({
      issues: [
        { path: 'listen', message: 'set in the config file or the environment; restart to change' },
      ],
    });
    const note = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 5 },
      expectRevision: 1,
      note: 'x'.repeat(501),
    });
    expect(note.statusCode).toBe(400);
    const noRev = await req('PATCH', '/api/control/config', { patch: { pollSeconds: 5 } });
    expect(noRev.statusCode).toBe(400);
    expect(store.revision()).toBe(1);
    expect(revVia(db)).toEqual(['setup']);
    expect(listAudit(db).filter((a) => a.action.startsWith('config.'))).toEqual([]);
  });

  test('revisions list their changes, and rollback makes a new revision with the old content', async () => {
    const { db, store } = configApp();
    await req('PATCH', '/api/control/config', { patch: { pollSeconds: 30 }, expectRevision: 1 });
    await req('PATCH', '/api/control/config', { patch: { pollSeconds: 40 }, expectRevision: 2 });
    const list = await req('GET', '/api/control/config/revisions?limit=2');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      revisions: [
        {
          id: 3,
          parentId: 2,
          createdAt: t0.toISOString(),
          via: 'ctl',
          note: null,
          changes: [{ path: 'pollSeconds', from: 30, to: 40 }],
        },
        expect.objectContaining({ id: 2 }),
      ],
    });
    const back = await req('POST', '/api/control/config/rollback', { id: 2, note: 'too slow' });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ revision: 4, changed: ['pollSeconds'] });
    expect(store.current().pollSeconds).toBe(30);
    expect(revVia(db)).toEqual(['setup', 'ctl', 'ctl', 'rollback']);
    expect((await req('POST', '/api/control/config/rollback', { id: 99 })).statusCode).toBe(400);
    expect(listAudit(db)[0]).toMatchObject({
      action: 'config.rollback',
      detail: { revision: 4, from: 2 },
    });
  });

  test('the doctor run from the route reports where the config comes from and what waits for a restart', async () => {
    const { store } = configApp();
    store.apply(
      { mcp: { enabled: true } },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    const r = await req('POST', '/api/control/doctor', {});
    expect(r.statusCode).toBe(200);
    const checks = (r.json() as { run: { checks: { id: string; status: string }[] } }).run.checks;
    expect(checks.find((c) => c.id === 'config.file')).toMatchObject({ status: 'pass' });
    expect(checks.find((c) => c.id === 'config.restart')).toMatchObject({ status: 'warn' });
  });

  test('a note keeps its text as data: the API returns it as JSON, never as markup', async () => {
    configApp();
    const note = '<img src=x onerror=alert(1)>';
    await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 30 },
      expectRevision: 1,
      note,
    });
    const r = await req('GET', '/api/control/config/revisions');
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect((r.json() as { revisions: { note: string }[] }).revisions[0]?.note).toBe(note);
  });

  test('export is the byte-stable JSON as an attachment; import --dry-run returns the diff and applies nothing', async () => {
    const { db, store } = configApp();
    store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    const ex = await req('GET', '/api/control/config/export');
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-disposition']).toBe('attachment; filename="jumpmaster.config.json"');
    expect(ex.body).toBe(store.exportJson());
    for (const s of Object.values(env)) expect(ex.body).not.toContain(s);
    const doc = JSON.parse(ex.body) as Record<string, unknown>;
    const dry = await req('POST', '/api/control/config/import', {
      config: { ...doc, pollSeconds: 15 },
      dryRun: true,
    });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toEqual({
      dryRun: true,
      // An absent side is absent in JSON too.
      changes: [{ path: 'pollSeconds', to: 15 }],
      issues: [],
    });
    expect(store.revision()).toBe(2);
    const done = await req('POST', '/api/control/config/import', {
      config: { ...doc, pollSeconds: 15 },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ revision: 3, changed: ['pollSeconds'] });
    expect(revVia(db).at(-1)).toBe('import');
    const badDry = await req('POST', '/api/control/config/import', {
      config: { pollSeconds: -1 },
      dryRun: true,
    });
    expect(badDry.json()).toMatchObject({
      dryRun: true,
      issues: [expect.objectContaining({ path: 'pollSeconds' })],
    });
  });

  test('file mode: a PATCH is refused with the reload-or-adopt message; reload and adopt work; mode file is the token only', async () => {
    const { db, store, filePath, asSession } = configApp({ dropZones: [zoneDoc()] });
    const p = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 5 },
      expectRevision: 1,
    });
    expect(p.statusCode).toBe(400);
    expect((p.json() as { issues: { message: string }[] }).issues[0]?.message).toMatch(
      /config is managed by the file at .*: edit it and run `jumpmaster ctl config reload`, or adopt it into the UI/,
    );
    writeFileSync(
      filePath,
      JSON.stringify({ dataDir: './data', pollSeconds: 20, dropZones: [zoneDoc()] }),
    );
    const rl = await req('POST', '/api/control/config/reload', {});
    expect(rl.statusCode).toBe(200);
    expect(rl.json()).toMatchObject({ revision: 2, changed: ['pollSeconds'] });
    const ad = await req('POST', '/api/control/config/adopt', {}, asSession);
    expect(ad.statusCode).toBe(200);
    expect(store.mode()).toBe('db');
    // In db mode a reload changes nothing and says why.
    const ignored = await req('POST', '/api/control/config/reload', {});
    expect(ignored.json()).toMatchObject({
      revision: 3,
      changed: [],
      note: expect.stringMatching(/config file ignored/),
    });
    const bySession = await req('POST', '/api/control/config/mode', { mode: 'file' }, asSession);
    expect(bySession.statusCode).toBe(403);
    const differs = await req('POST', '/api/control/config/mode', { mode: 'file' });
    expect(differs.statusCode).toBe(400);
    writeFileSync(filePath, store.exportJson());
    const back = await req('POST', '/api/control/config/mode', { mode: 'file' });
    expect(back.statusCode).toBe(200);
    expect(store.mode()).toBe('file');
    expect(
      listAudit(db)
        .map((a) => [a.action, a.via])
        .filter(([a]) => String(a).startsWith('config.')),
    ).toEqual([
      ['config.mode', 'token'],
      // The reload in db mode changed nothing, and is on record all the same.
      ['config.reload', 'token'],
      ['config.adopt', 'session'],
      ['config.reload', 'token'],
    ]);
  });
});
