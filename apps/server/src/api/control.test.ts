import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import { grantSudo, SUDO_MS, sha256Hex } from '../auth/sessions.js';
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
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { credentialCreatedAt } from '../vault/credentials.js';
import { fingerprintOf, openVault } from '../vault/vault.js';
import { type ControlDeps, registerControlRoutes, removalNote } from './control.js';
import { guidanceFor, recommendFor } from './github.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };
/** The stored id of the session a header set carries. */
const operatorHashOf = (h: Record<string, string>) =>
  sha256Hex((h.cookie ?? '').replace(/^jm_session=/, ''));

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

describe('one config snapshot per request', () => {
  test('a control request reads the config source once, in the guard, and every later read in the handler sees that snapshot', async () => {
    const db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
    let reads = 0;
    const base = {
      listen: { host: '127.0.0.1', port: 7420 },
      dropZones: [makeZone({ id: 'main' })],
      secrets: { operatorToken: TOKEN },
    } as unknown as Config;
    // A fresh object per read, as a store swapping revisions would hand out.
    const source = { current: () => ({ ...base, _read: ++reads }) as unknown as Config };
    app = controlApp({ db, config: source, now: () => t0 });
    await app.ready();
    reads = 0;
    const r = await post('/api/control/zones/main', { mode: 'paused' });
    expect(r.statusCode).toBe(200);
    expect(reads).toBe(1);
  });
});

describe('ctl', () => {
  test('commands map to control requests', () => {
    expect(ctlRequest(['pause', 'main'])).toEqual({
      method: 'POST',
      path: '/api/control/zones/main',
      body: { mode: 'paused' },
    });
    expect(ctlRequest(['resume', 'main'])?.body).toEqual({ mode: 'active' });
    expect(ctlRequest(['observe', 'main'])?.body).toEqual({ mode: 'observe' });
    expect(ctlRequest(['kill'])).toEqual({
      method: 'POST',
      path: '/api/control/kill',
      body: { engaged: true },
    });
    expect(ctlRequest(['unkill'])?.body).toEqual({ engaged: false });
    expect(ctlRequest(['pause'])).toBeNull();
    expect(ctlRequest(['nonsense', 'main'])).toBeNull();
    expect(ctlRequest(['crew-cycle', 'main'])).toEqual({
      method: 'POST',
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
      method: 'POST',
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

  test('forge.labels offers the create action, which runs through the outbox as the author and is idempotent', async () => {
    const w = doctorApp();
    w.f.state.labels = ['bug'];
    const ran = await post('/api/control/doctor', {});
    const labels = (ran?.json().run.checks as { id: string; action?: unknown }[]).find(
      (c) => c.id === 'forge.labels',
    );
    expect(labels?.action).toEqual({
      kind: 'app',
      label: 'Create the missing labels',
      href: '/api/control/zones/main/labels',
      method: 'POST',
    });
    const r = await post('/api/control/zones/main/labels', {});
    expect(r?.statusCode).toBe(200);
    expect(r?.json()).toMatchObject({
      created: ['agent-ready', 'agent-retry'],
      check: { id: 'forge.labels', status: 'pass' },
    });
    expect(w.f.author.calls.filter((c) => c.method === 'createLabel')).toHaveLength(2);
    expect(w.f.reviewer.calls.filter((c) => c.method === 'createLabel')).toHaveLength(0);
    const kinds = w.db.prepare('SELECT kind, state FROM outbox').all();
    expect(kinds).toEqual([{ kind: 'create_labels', state: 'done' }]);
    const again = await post('/api/control/zones/main/labels', {});
    expect(again?.json()).toMatchObject({ created: [], check: { status: 'pass' } });
    expect(w.f.author.calls.filter((c) => c.method === 'createLabel')).toHaveLength(2);
    // A GET never writes.
    const get = await app?.inject({
      method: 'GET',
      url: '/api/control/zones/main/labels',
      headers: auth,
    });
    expect(get?.statusCode).toBe(404);
    expect((await post('/api/control/zones/nope/labels', {}))?.statusCode).toBe(404);
  });

  test('the label action works in observe mode and is refused when killed, with an audit row either way', async () => {
    const w = doctorApp();
    w.f.state.labels = [];
    setZoneMode(w.db, 'main', 'observe', NOW);
    const ok = await post('/api/control/zones/main/labels', {});
    expect(ok?.statusCode).toBe(200);
    w.f.state.labels = [];
    setKilled(w.db, true, NOW);
    const killed = await post('/api/control/zones/main/labels', {});
    expect(killed?.statusCode).toBe(409);
    expect(killed?.json()).toEqual({ error: 'the kill switch is engaged: no forge write' });
    const rows = listAudit(w.db).filter((a) => a.action === 'labels.create');
    expect(rows.map((a) => [a.target, a.detail.result])).toEqual([
      ['main', 'refused: killed'],
      ['main', 'created: agent-ready, agent-retry'],
    ]);
  });

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
    expect(ctlRequest(['doctor'])).toEqual({
      method: 'POST',
      path: '/api/control/doctor',
      body: {},
    });
    expect(ctlRequest(['doctor', 'main', '--json'])).toEqual({
      method: 'POST',
      path: '/api/control/doctor',
      body: { zone: 'main' },
    });
    expect(ctlRequest(['doctor', 'main', '--drop'])).toEqual({
      method: 'POST',
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
      method: 'POST',
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
    // Minting shows an MCP token's value: a session needs sudo for it (Task 13).
    grantSudo(db, sha256Hex(session.id), NOW);
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

describe('MCP tokens and sudo (Task 13)', () => {
  test('a session older than the sudo window that mints is sent to re-authenticate first, and no value is made or shown before that', async () => {
    const w = world({ config: { mcp: { enabled: true } } as Partial<Config> });
    let clock = NOW;
    app = controlApp({ db: w.db, config: w.config, now: () => clock });
    const session = operatorSession(w.db, NOW);
    const headers = { host: HOST, ...session.headers };
    const mint = () =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: '/api/control/mcp-tokens',
        headers,
        payload: { zoneId: 'main', scope: 'write', days: 7 },
      });
    const count = () =>
      (w.db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens').get() as { n: number }).n;

    // Never re-authenticated: refused, pointed at sudo, nothing minted.
    const never = await mint();
    expect(never.statusCode).toBe(403);
    expect(never.json()).toEqual({
      error: 'an MCP token is shown once, so minting one needs sudo: re-enter the passphrase',
      sudo: 'required',
    });
    expect(count()).toBe(0);

    // Re-authenticated: minted, the value returned once.
    grantSudo(w.db, sha256Hex(session.id), clock);
    const ok = await mint();
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { token: string }).token).toMatch(/^jmm_/);
    expect(count()).toBe(1);

    // Past the five minutes: sent back to re-authenticate, and still nothing is made.
    clock = plus(NOW, SUDO_MS + 1000);
    const stale = await mint();
    expect(stale.statusCode).toBe(403);
    expect(stale.body).not.toMatch(/jmm_/);
    expect(count()).toBe(1);

    // The list never carries a value; revoke needs no sudo (it shows nothing).
    const list = await (app as FastifyInstance).inject({
      method: 'GET',
      url: '/api/control/mcp-tokens',
      headers,
    });
    expect(list.body).not.toMatch(/jmm_|token_hash|tokenHash/);
    const revoke = await (app as FastifyInstance).inject({
      method: 'DELETE',
      url: '/api/control/mcp-tokens/1',
      headers,
    });
    expect(revoke.statusCode).toBe(200);

    // The operator token (ctl) is not a browser session: always sudo.
    const bearer = await (app as FastifyInstance).inject({
      method: 'POST',
      url: '/api/control/mcp-tokens',
      headers: auth,
      payload: { zoneId: 'main', scope: 'read', days: 1 },
    });
    expect(bearer.statusCode).toBe(200);
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

  test("GET config carries the lenient read's warnings, so ctl and the Install tab can show them", async () => {
    configApp({ pollSeconds: 1, dropZones: [zoneDoc()] });
    const r = await req('GET', '/api/control/config');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      mode: 'file',
      warnings: ['pollSeconds 1 is outside 5..86400: running with 5; set it in range'],
    });
  });

  test('a session cannot change a guarded path without the confirmation page, and the token can', async () => {
    const { db, store, asSession } = configApp();
    const z = zoneDoc('main', { egress: { mode: 'enforce', allow: [] } });
    store.apply(
      { dropZones: [z] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    // Not guarded: straight through from a session, recorded via ui.
    const plain = await req(
      'PATCH',
      '/api/control/config',
      { patch: { pollSeconds: 30 }, expectRevision: 2 },
      asSession,
    );
    expect(plain.statusCode).toBe(200);
    expect(revVia(db)).toEqual(['setup', 'ctl', 'ui']);
    // Guarded: held for the confirmation page.
    const weaken = { dropZones: [{ ...z, ciRequired: false }] };
    const held = await req(
      'PATCH',
      '/api/control/config',
      { patch: weaken, expectRevision: 3, returnTo: '/setup/doctor' },
      asSession,
    );
    expect(held.statusCode).toBe(409);
    const body = held.json();
    expect(body).toEqual({
      needsConfirmation: true,
      pendingId: expect.any(String),
      confirm: `/config/confirm/${body.pendingId}`,
      guarded: [
        {
          path: 'dropZones[main].ciRequired',
          consequence: 'Agent PRs in main will merge without CI',
        },
      ],
    });
    expect(store.revision()).toBe(3);
    expect(store.confirmations.pending(body.pendingId, operatorHashOf(asSession))?.returnTo).toBe(
      '/setup/doctor',
    );
    // The proposal is audited, with its paths and never the pending id's confirmation.
    const proposed = listAudit(db).filter((a) => a.action === 'config.propose');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      via: 'session',
      detail: { guardedPaths: 'dropZones[main].ciRequired', base: 3, kind: 'apply' },
    });
    expect(JSON.stringify(proposed[0])).not.toContain(body.pendingId);
    // A body cannot carry a confirmation: only the confirm page's POST does, with the passphrase.
    const forged = await req(
      'PATCH',
      '/api/control/config',
      { patch: weaken, expectRevision: 3, confirmation: { pendingId: body.pendingId, token: 'x' } },
      asSession,
    );
    expect(forged.statusCode).toBe(400);
    // The token applies it at once, and the audit row says it was guarded.
    const t = await req('PATCH', '/api/control/config', { patch: weaken, expectRevision: 3 });
    expect(t.statusCode).toBe(200);
    expect(t.json()).toMatchObject({ revision: 4, guarded: ['dropZones[main].ciRequired'] });
    const row = listAudit(db).find((a) => a.action === 'config.apply' && a.detail.revision === 4);
    expect(row?.detail).toMatchObject({ guarded: 1, guardedPaths: 'dropZones[main].ciRequired' });
  });

  test('requireSignedImages weakening and a zone image are a 403 for a session, with the ctl hint, and nothing else applies', async () => {
    const { db, store, asSession } = configApp();
    const image = await req(
      'PATCH',
      '/api/control/config',
      {
        patch: {
          pollSeconds: 30,
          dropZones: [zoneDoc('new', { egress: { mode: 'monitor', allow: [] } })],
        },
        expectRevision: 1,
      },
      asSession,
    );
    expect(image.statusCode).toBe(403);
    expect(image.json()).toEqual({
      sessionForbidden: ['dropZones[new].image'],
      hint: 'set with jumpmaster ctl or in the config file',
    });
    // Turning it on is a strengthening, open to a session; turning it off is not.
    const on = await req(
      'PATCH',
      '/api/control/config',
      { patch: { requireSignedImages: true }, expectRevision: 1 },
      asSession,
    );
    expect(on.statusCode).toBe(200);
    const off = await req(
      'PATCH',
      '/api/control/config',
      { patch: { requireSignedImages: false, pollSeconds: 30 }, expectRevision: 2 },
      asSession,
    );
    expect(off.statusCode).toBe(403);
    expect(off.json().sessionForbidden).toEqual(['requireSignedImages']);
    expect(store.current().pollSeconds).toBe(60);
    expect(revVia(db)).toEqual(['setup', 'ui']);
  });

  test('a session rollback and import go through the classifier, and a dry run shows what would be guarded', async () => {
    const { store, asSession } = configApp();
    const token = { kind: 'operator', via: 'token', sudo: true } as const;
    store.apply({ usage: { stopOnOverage: false } }, { via: 'ctl', principal: token }); // 2
    store.apply({}, { via: 'ctl', principal: token }); // 3
    const rb = await req('POST', '/api/control/config/rollback', { id: 2 }, asSession);
    expect(rb.statusCode).toBe(409);
    expect(rb.json().guarded.map((g: { path: string }) => g.path)).toEqual(['usage.stopOnOverage']);
    const dry = await req(
      'POST',
      '/api/control/config/import',
      { config: { mcp: { enabled: true } }, dryRun: true },
      asSession,
    );
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({
      dryRun: true,
      issues: [],
      guarded: [{ path: 'mcp.enabled' }],
      sessionForbidden: [],
    });
    const imp = await req(
      'POST',
      '/api/control/config/import',
      { config: { mcp: { enabled: true } } },
      asSession,
    );
    expect(imp.statusCode).toBe(409);
    expect(
      store.confirmations.pending(imp.json().pendingId, operatorHashOf(asSession))?.meta.via,
    ).toBe('import');
    expect(store.revision()).toBe(3);
  });

  test('repo on an existing zone is a 400 for the token and a session alike', async () => {
    const { store, asSession } = configApp();
    store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    for (const headers of [auth, asSession]) {
      const r = await req(
        'PATCH',
        '/api/control/config',
        { patch: { dropZones: [zoneDoc('main', { repo: 'octo/elsewhere' })] }, expectRevision: 2 },
        headers,
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().issues).toEqual([
        {
          path: 'dropZones[main].repo',
          message: "the repository of a zone can't change: remove the zone and add a new one",
        },
      ]);
    }
  });

  test('PATCH applies a merge patch as ctl from the token, audited, and conflicts on a stale revision', async () => {
    const { db, store } = configApp();
    const one = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 30, dropZones: [zoneDoc()] },
      expectRevision: 1,
      note: 'first',
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual({
      revision: 2,
      changed: ['dropZones[main]', 'pollSeconds'],
      restartNeeded: [],
      // An added zone without egress is judged against the add baseline (monitor): guarded.
      guarded: ['dropZones[main].repo', 'dropZones[main].egress.mode'],
    });
    // null removes a key (RFC 7396): pollSeconds goes back to its default.
    const two = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: null },
      expectRevision: 2,
    });
    expect(two.statusCode).toBe(200);
    expect(store.current().pollSeconds).toBe(60);
    expect(store.document()).toEqual({ dropZones: [zoneDoc()] });
    expect(revVia(db)).toEqual(['setup', 'ctl', 'ctl']);
    const stale = await req('PATCH', '/api/control/config', {
      patch: { pollSeconds: 5 },
      expectRevision: 2,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ conflict: { expected: 2, actual: 3 } });
    const audits = listAudit(db).filter((a) => a.action === 'config.apply');
    expect(audits.map((a) => [a.via, a.detail.revision])).toEqual([
      ['token', 3],
      ['token', 2],
    ]);
    expect(audits[1]?.detail.changed).toBe('dropZones[main], pollSeconds');
  });

  test('a PATCH carrying a prototype key over HTTP is refused and changes nothing', async () => {
    const { db, store } = configApp();
    for (const body of [
      '{"patch":{"__proto__":{"pollSeconds":86400}},"expectRevision":1}',
      '{"patch":{"constructor":{"prototype":{"pollSeconds":86400}}},"expectRevision":1}',
      '{"patch":{"usage":{"__proto__":{"stopOnOverage":false}}},"expectRevision":1}',
    ]) {
      const r = await (app as FastifyInstance).inject({
        method: 'PATCH',
        url: '/api/control/config',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: body,
      });
      expect(r.statusCode, body).toBe(400);
    }
    expect(store.revision()).toBe(1);
    expect(store.current().pollSeconds).toBe(60);
    expect(store.current().usage.stopOnOverage).not.toBe(false);
    expect(revVia(db)).toEqual(['setup']);
  });

  test('adopt with a note over 500 characters is a 400 naming the note, not a storage error', async () => {
    const { store } = configApp({ dropZones: [zoneDoc()] });
    const r = await req('POST', '/api/control/config/adopt', { note: 'x'.repeat(501) });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({
      issues: [{ path: 'note', message: 'a note is at most 500 characters' }],
    });
    expect(store.mode()).toBe('file');
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
          // Task 13's marks: nothing guarded, no zone re-added, none a revert would bring back.
          guarded: [],
          readds: [],
          revertReadds: [],
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
      guarded: [],
      sessionForbidden: [],
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

describe('secret routes (Task 4)', () => {
  const env = {
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
  };
  const CLAUDE = 'sk-ant-oat01-ROUTECLAUDE-0001';
  const AUTHOR_OLD = 'github_pat_ROUTEAUTHOROLD_0002';
  const AUTHOR_NEW = 'github_pat_ROUTEAUTHORNEW_0003';
  const REVIEWER = 'github_pat_ROUTEREVIEWER_0004';
  const FAILED = 'github_pat_FAILEDFIXTURE_distinct_from_all_0005';
  const zoneDoc = (id: string) => ({
    id,
    repo: `octo/${id}`,
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'jm-trooper:dev',
  });

  /** Two zones over a store with a vault; `files` are written under the secrets directory. */
  function secretsApp(files: Record<string, string> = {}) {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-route-'));
    const secretsDir = join(dir, 'secrets');
    mkdirSync(secretsDir);
    for (const [name, value] of Object.entries(files))
      writeFileSync(join(secretsDir, name), `${value}\n`, { mode: 0o600 });
    const keyFile = join(dir, 'vault_key');
    writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const vault = openVault(keyFile, db);
    const clock = { now: t0 };
    const store = ConfigStore.open({
      db,
      boot: { ...loadBoot({}, undefined), secretsDir },
      env,
      vault,
      now: () => clock.now,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    store.apply(
      { dropZones: [zoneDoc('web'), zoneDoc('api')] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    for (const z of ['web', 'api'])
      upsertDropZone(db, { id: z, repo: `octo/${z}`, defaultBranch: 'main', configJson: '{}' });
    const calls: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    const forge = {
      fail: undefined as unknown,
      /** When set, every test call fails with it (a GitHub outage). */
      outage: undefined as unknown,
      setGate(p: Promise<void>) {
        gate = p;
      },
    };
    const logs: string[] = [];
    app = controlApp({
      db,
      config: store,
      now: () => clock.now,
      log: (l) => logs.push(l),
      forgesFor: () => {
        throw new Error('no forge in this test');
      },
      doctorEnv: { uid: 1000, inContainer: true, uidMap: null },
      credentialForge: (token, repo) => ({
        viewerLogin: async () => {
          calls.push(`login ${repo} ${token === FAILED ? 'failed' : 'ok'}`);
          await gate;
          if (forge.outage) throw forge.outage;
          if (token === FAILED) throw forge.fail;
          return token === REVIEWER ? 'reviewer-bot' : 'author-bot';
        },
        repoAccess: async () => {
          calls.push(`access ${repo}`);
          return {};
        },
      }),
    });
    const session = operatorSession(db);
    const asSession = { ...session.headers, host: HOST };
    return { db, store, clock, calls, forge, logs, asSession, secretsDir, session };
  }
  const put = (name: string, body: unknown, headers: Record<string, string> = auth) =>
    (app as FastifyInstance).inject({
      method: 'PUT',
      url: `/api/control/secrets/${name}`,
      headers,
      payload: body as object,
    });
  const get = (headers: Record<string, string> = auth) =>
    (app as FastifyInstance).inject({ method: 'GET', url: '/api/control/secrets', headers });

  test('PUT secrets needs sudo for a session, never for the Bearer token, and is refused for a file-managed credential with its path', async () => {
    const w = secretsApp({ claude_token: CLAUDE });
    const s1 = await put('githubAuthorToken', { value: AUTHOR_OLD }, w.asSession);
    expect(s1.statusCode).toBe(403);
    // Said as a page can show it: no API path, "saving" (a first save needs it too), and a flag.
    expect(s1.json()).toEqual({
      error: 'saving a credential asks for your passphrase again',
      sudo: 'required',
    });
    w.db.prepare('UPDATE sessions SET sudo_until = ?').run(plus(t0, 60_000).toISOString());
    expect((await put('githubAuthorToken', { value: AUTHOR_OLD }, w.asSession)).statusCode).toBe(
      200,
    );
    expect((await put('githubReviewerToken', { value: REVIEWER })).statusCode).toBe(200);
    const file = await put('claudeToken', { value: CLAUDE });
    expect(file.statusCode).toBe(409);
    expect(file.json()).toEqual({
      error: `managed by ${join(w.secretsDir, 'claude_token')}: replace the file and run \`ctl secrets reload\``,
    });
    const bad = await put('githubAuthorToken', { value: 'two\nlines' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('two');
    expect((await put('nonsense', { value: AUTHOR_OLD })).statusCode).toBe(404);
  });

  test('a rotated author token is tested against every zone, swapped in for the next drop, and the running drops still carrying the old one are counted until they finish', async () => {
    const w = secretsApp({ claude_token: CLAUDE });
    await put('githubReviewerToken', { value: REVIEWER });
    expect((await put('githubAuthorToken', { value: AUTHOR_OLD })).statusCode).toBe(200);
    // A drop leased with the old token.
    const wi = upsertWorkItem(w.db, {
      dropZoneId: 'web',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(w.db, {
      id: 'd-old',
      dropZoneId: 'web',
      workItemId: wi.id,
      role: 'implement',
      state: 'queued',
      createdAt: t0.toISOString(),
    });
    w.db
      .prepare("UPDATE drops SET state = 'running', started_at = ? WHERE id = 'd-old'")
      .run(plus(t0, 1000).toISOString());
    w.clock.now = plus(t0, 5000);
    w.calls.length = 0;
    const r = await put('githubAuthorToken', { value: AUTHOR_NEW });
    expect(r.statusCode).toBe(200);
    expect(w.calls).toEqual(['login octo/web ok', 'access octo/web', 'access octo/api']);
    expect(r.json()).toMatchObject({
      fingerprint: fingerprintOf(AUTHOR_NEW),
      tested: true,
      problems: [],
      runningDropsWithPrevious: 1,
    });
    // The next pass and payload read the new value; the list shows the count until the drop ends.
    expect(w.store.current().secrets.githubAuthorToken).toBe(AUTHOR_NEW);
    const listed = () =>
      get().then((x) =>
        x.json().credentials.find((c: { name: string }) => c.name === 'githubAuthorToken'),
      );
    expect((await listed()).runningDropsWithPrevious).toBe(1);
    w.db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd-old'").run();
    expect((await listed()).runningDropsWithPrevious).toBe(0);
    // The old value is still redacted from what the server logs and audits.
    expect(w.store.retired()).toContain(AUTHOR_OLD);
  });

  test('a failed test stores nothing, returns only the status and permission, and the distinct value reaches no log line, audit row or response', async () => {
    const w = secretsApp();
    w.forge.fail = Object.assign(new Error(`Bad credentials ${FAILED}`), {
      status: 401,
      response: {
        headers: { 'x-accepted-github-permissions': 'metadata=read' },
        data: { message: FAILED },
      },
    });
    const r = await put('githubAuthorToken', { value: FAILED });
    expect(r.statusCode).toBe(422);
    // GitHub's status in words (T10 finding 4): a 401 is an expired, revoked or mistyped token.
    expect(r.json()).toEqual({
      tested: false,
      status: 401,
      permission: 'metadata=read',
      error:
        "GitHub rejected this token (401): it is expired, revoked or mistyped. Make a new one (the GitHub step and each project's GitHub page have the links).",
    });
    expect(w.store.resolved().githubAuthorToken.source).toBe('missing');
    expect(w.store.vault() !== 'disabled' && w.store.vault().meta('githubAuthorToken')).toBe(
      undefined,
    );
    const rows = JSON.stringify(listAudit(w.db));
    expect(rows).toContain('secret.set');
    for (const where of [r.body, rows, w.logs.join('\n'), (await get()).body])
      expect(where).not.toContain(FAILED);
  });

  test('a failed re-test keeps the recorded login, so a zone parked as same stays parked; the test needs sudo from a session', async () => {
    const w = secretsApp({ claude_token: CLAUDE });
    await put('githubAuthorToken', { value: AUTHOR_OLD });
    // The reviewer token's account is the author's: the fake answers author-bot for it.
    await put('githubReviewerToken', { value: AUTHOR_NEW });
    const same = () =>
      w.store
        .problems()
        .filter((p) => p.kind === 'same')
        .map((p) => p.zoneId);
    expect(same()).toEqual(['web', 'api']);
    w.forge.outage = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const test = (headers: Record<string, string> = auth) =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: '/api/control/secrets/githubReviewerToken/test',
        headers,
        payload: {},
      });
    const r = await test();
    expect(r.json()).toEqual({
      tested: false,
      status: 503,
      error: 'GitHub did not accept the test (HTTP 503): try again in a moment.',
    });
    expect(w.store.resolved().githubReviewerToken.login).toBe('author-bot');
    expect(w.store.resolved().githubReviewerToken.testResult).toBe('failed (503)');
    expect(same()).toEqual(['web', 'api']);
    // A session needs sudo to test, as to replace.
    const s = await test(w.asSession);
    expect(s.statusCode).toBe(403);
    expect(s.json()).toEqual({
      error: 'testing a credential asks for your passphrase again',
      sudo: 'required',
    });
    // A passing test replaces the login.
    w.forge.outage = undefined;
    w.db.prepare('UPDATE sessions SET sudo_until = ?').run(plus(t0, 60_000).toISOString());
    expect((await test(w.asSession)).statusCode).toBe(200);
  });

  test('the answer to a rotation says the pass in flight keeps the previous token too', async () => {
    secretsApp({ claude_token: CLAUDE });
    const r = await put('githubAuthorToken', { value: AUTHOR_OLD });
    expect(r.json().hint).toBe(
      '0 running drops still carry the previous token, and the pass running now keeps it until it ends: revoke it on GitHub after they finish',
    );
  });

  test('two PUTs for one name are serialized: the second test starts after the first is stored', async () => {
    const w = secretsApp();
    let release!: () => void;
    w.forge.setGate(new Promise<void>((r) => (release = r)));
    const first = put('githubReviewerToken', { value: REVIEWER });
    const second = put('githubReviewerToken', { value: AUTHOR_NEW });
    // Let both requests reach their handlers.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(w.calls).toEqual(['login octo/web ok']);
    release();
    await first;
    await second;
    expect(w.calls.filter((c) => c.startsWith('login'))).toHaveLength(2);
    expect(w.store.resolved().githubReviewerToken.fingerprint).toBe(fingerprintOf(AUTHOR_NEW));
  });

  test('the list carries fingerprint, source, path for a file, login and dates, and no value, prefix, suffix or length', async () => {
    const w = secretsApp({ claude_token: CLAUDE });
    await put('githubReviewerToken', { value: REVIEWER, declaredCreatedAt: '2026-01-02' });
    const r = await get(w.asSession);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.vault).toBe('on');
    const byName = Object.fromEntries(body.credentials.map((c: { name: string }) => [c.name, c]));
    expect(byName.claudeToken).toMatchObject({
      source: 'file',
      path: join(w.secretsDir, 'claude_token'),
      fingerprint: fingerprintOf(CLAUDE),
    });
    expect(byName.githubReviewerToken).toMatchObject({
      source: 'vault',
      fingerprint: fingerprintOf(REVIEWER),
      login: 'reviewer-bot',
      setAt: t0.toISOString(),
      declaredCreatedAt: '2026-01-02',
      testResult: 'ok',
    });
    expect(byName.githubAuthorToken).toMatchObject({ source: 'missing' });
    expect(body.problems.map((p: { credential: string }) => p.credential)).toEqual([
      'githubAuthorToken',
      'githubAuthorToken',
    ]);
    for (const v of [CLAUDE, REVIEWER]) {
      expect(r.body).not.toContain(v);
      expect(r.body).not.toContain(v.slice(0, 12));
      expect(r.body).not.toContain(v.slice(-6));
      expect(r.body).not.toMatch(new RegExp(`"length":\\s*${v.length}`));
    }
  });

  test('a Claude token set in the UI is dated today unless a date is given', async () => {
    const w = secretsApp();
    await put('claudeToken', { value: CLAUDE });
    expect(credentialCreatedAt('claudeToken', w.store.resolved(), {})).toBe(
      t0.toISOString().slice(0, 10),
    );
    await put('claudeToken', { value: CLAUDE, declaredCreatedAt: '2026-01-15' });
    expect(credentialCreatedAt('claudeToken', w.store.resolved(), {})).toBe('2026-01-15');
    expect(
      (await put('claudeToken', { value: CLAUDE, declaredCreatedAt: 'soon' })).statusCode,
    ).toBe(400);
  });

  test('a credential change that invalidates a zone answers with the problem, parks it, and the doctor fails credential.kind', async () => {
    const w = secretsApp({ claude_token: CLAUDE });
    const token = { kind: 'operator', via: 'token', sudo: true } as const;
    w.store.apply(
      { dropZones: [{ ...zoneDoc('web'), identity: 'starter' }, zoneDoc('api')] },
      { via: 'ctl', principal: token },
    );
    await put('githubReviewerToken', { value: REVIEWER });
    const r = await put('githubAuthorToken', { value: 'ghp_CLASSICAUTHOR_0007' });
    expect(r.statusCode).toBe(200);
    expect(r.json().problems).toEqual([
      expect.objectContaining({ zoneId: 'web', kind: 'kind', credential: 'githubAuthorToken' }),
    ]);
    const doc = await (app as FastifyInstance).inject({
      method: 'POST',
      url: '/api/control/doctor',
      headers: auth,
      payload: { zone: 'web' },
    });
    const checks = doc.json().run.checks as { id: string; zoneId: string; status: string }[];
    expect(checks.find((c) => c.id === 'credential.kind' && c.zoneId === 'web')?.status).toBe(
      'fail',
    );
    expect(checks.find((c) => c.id === 'vault.key')?.status).toBe('pass');
    expect(doc.body).not.toContain('ghp_CLASSICAUTHOR_0007');
  });

  test('DELETE of a credential a zone needs is refused with the problem it would create; reload re-reads the files', async () => {
    const w = secretsApp();
    await put('githubReviewerToken', { value: REVIEWER });
    const del = await (app as FastifyInstance).inject({
      method: 'DELETE',
      url: '/api/control/secrets/githubReviewerToken',
      headers: auth,
    });
    expect(del.statusCode).toBe(409);
    expect(
      del.json().problems.map((p: { zoneId: string; kind: string }) => [p.zoneId, p.kind]),
    ).toEqual([
      ['web', 'missing'],
      ['api', 'missing'],
    ]);
    expect(w.store.resolved().githubReviewerToken.source).toBe('vault');
    // A file appears: reload picks it up.
    writeFileSync(join(w.secretsDir, 'github_author_token'), `${AUTHOR_OLD}\n`, { mode: 0o600 });
    const reload = await (app as FastifyInstance).inject({
      method: 'POST',
      url: '/api/control/secrets/reload',
      headers: auth,
      payload: {},
    });
    expect(reload.statusCode).toBe(200);
    expect(w.store.resolved().githubAuthorToken.source).toBe('file');
    // The read token no zone needs can go.
    await put('githubReadToken', { value: 'github_pat_READ_0006' });
    const ok = await (app as FastifyInstance).inject({
      method: 'DELETE',
      url: '/api/control/secrets/githubReadToken',
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(w.store.resolved().githubReadToken.source).toBe('missing');
  });
});

describe('detect and zone add routes', () => {
  const AUTHOR = 'github_pat_ZONEAUTHORDUMMY0123456789';
  const zenv = {
    JM_CLAUDE_TOKEN: 'sk-ant-oat01-ZONECLAUDEDUMMY0123456789',
    JM_GITHUB_AUTHOR_TOKEN: AUTHOR,
    JM_GITHUB_REVIEWER_TOKEN: 'github_pat_ZONEREVIEWERDUMMY0123456789',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
  };
  const NODE_FILES: Record<string, string> = {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    'package-lock.json': '{}',
  };

  function zoneApp(o: { env?: Record<string, string>; failWith?: number; admin?: boolean } = {}) {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-zones-'));
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, undefined),
      env: o.env ?? zenv,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    const seen: { repo?: string; token?: string; calls: string[] } = { calls: [] };
    app = controlApp({
      db,
      config: store,
      now: () => t0,
      detectForge: (repo, token) => {
        seen.repo = repo;
        seen.token = token;
        return {
          async repoAccess() {
            seen.calls.push('repoAccess');
            if (o.failWith)
              throw Object.assign(new Error('Bad credentials'), { status: o.failWith });
            return {
              private: false,
              defaultBranch: 'main',
              permissions: {
                admin: o.admin ?? false,
                maintain: false,
                push: true,
                triage: true,
                pull: true,
              },
              scopes: null,
              tokenExpiresAt: null,
            };
          },
          async listDir() {
            seen.calls.push('listDir');
            return Object.keys(NODE_FILES);
          },
          async getFileAt(_ref: string, path: string) {
            seen.calls.push(`get ${path}`);
            return NODE_FILES[path] ?? null;
          },
        };
      },
    });
    const session = operatorSession(db);
    return {
      db,
      store,
      seen,
      sessionId: session.id,
      asSession: { ...session.headers, host: HOST },
    };
  }
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
    (app as FastifyInstance).inject({ method: 'POST', url, headers, payload: payload as object });

  test('detect runs after the REPO regexp with the author token and returns the proposal, never the token', async () => {
    const { seen } = zoneApp();
    const r = await post('/api/control/detect', { repo: 'octo/demo' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      visibility: 'public',
      defaultBranch: 'main',
      preset: 'node',
      admin: false,
    });
    expect(seen).toMatchObject({ repo: 'octo/demo', token: AUTHOR });
    expect(r.body).not.toContain(AUTHOR);
    const bad = zoneApp();
    const refused = await post('/api/control/detect', { repo: 'octo/de mo' });
    expect(refused.statusCode).toBe(400);
    expect(bad.seen.calls).toEqual([]);
  });

  test('detect says why GitHub refused, by status, and without a token', async () => {
    zoneApp({ failWith: 401 });
    const r = await post('/api/control/detect', { repo: 'octo/demo' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/GitHub rejected the author token \(401\)/);
    expect(r.body).not.toContain(AUTHOR);
  });

  test('detect without an author token says to set it first', async () => {
    const { JM_GITHUB_AUTHOR_TOKEN: _a, ...noAuthor } = zenv;
    const { seen } = zoneApp({ env: noAuthor });
    const r = await post('/api/control/detect', { repo: 'octo/demo' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/author token/);
    expect(seen.calls).toEqual([]);
  });

  test('zones add by the token: id from the repository name, detected gates and preset, egress monitor', async () => {
    const { store, db } = zoneApp();
    const r = await post('/api/control/zones', { zone: { repo: 'Octo/My.Demo' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ zone: 'my-demo', revision: 2 });
    const z = store.current().dropZones[0];
    expect(z).toMatchObject({
      id: 'my-demo',
      repo: 'Octo/My.Demo',
      preset: 'node',
      egress: { mode: 'monitor', allow: [] },
    });
    expect(z?.gates.map((g) => g.name)).toContain('test');
    expect(listAudit(db)[0]).toMatchObject({ action: 'zone.add', target: 'my-demo', via: 'token' });
    // An explicit egress and given gates are kept as sent; nothing is detected then.
    const { store: s2, seen } = zoneApp();
    const r2 = await post('/api/control/zones', {
      zone: {
        repo: 'octo/other',
        id: 'x',
        preset: 'node',
        gates: [{ name: 'unit', run: 'make test' }],
        egress: { mode: 'off' },
      },
    });
    expect(r2.statusCode, r2.body).toBe(200);
    expect(s2.current().dropZones[0]).toMatchObject({ id: 'x', egress: { mode: 'off' } });
    expect(seen.calls).toEqual([]);
  });

  test('adding a zone whose repo is already in another zone is refused, and an id with history is refused without resume', async () => {
    const { db, store } = zoneApp();
    expect((await post('/api/control/zones', { zone: { repo: 'octo/demo' } })).statusCode).toBe(
      200,
    );
    const again = await post('/api/control/zones', { zone: { repo: 'OCTO/demo', id: 'two' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/octo\/demo is already zone demo/i);
    const sameId = await post('/api/control/zones', {
      zone: { repo: 'octo/elsewhere', id: 'demo' },
    });
    expect(sameId.statusCode).toBe(409);
    expect(sameId.json().error).toMatch(/zone demo exists/);
    // History left by a zone that was removed: refused without resume, kept with it.
    upsertDropZone(db, { id: 'old', repo: 'octo/old', defaultBranch: 'main', configJson: '{}' });
    upsertWorkItem(db, {
      dropZoneId: 'old',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    const hist = await post('/api/control/zones', { zone: { repo: 'octo/old', id: 'old' } });
    expect(hist.statusCode).toBe(400);
    expect(hist.json().issues[0].message).toBe(
      'this zone has history: pick another id, or resume it',
    );
    const resumed = await post('/api/control/zones', {
      zone: { repo: 'octo/old', id: 'old' },
      resume: true,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(store.current().dropZones.map((z) => z.id)).toEqual(['demo', 'old']);
  });

  test('from a session every add goes to the confirmation page (a new project is guarded), with its consequences and returnTo kept', async () => {
    const { store, asSession, sessionId } = zoneApp({ admin: true });
    const plain = await post(
      '/api/control/zones',
      { zone: { repo: 'octo/demo' }, returnTo: '/setup/doctor' },
      asSession,
    );
    expect(plain.statusCode, plain.body).toBe(409);
    expect(plain.json().guarded.map((g: { path: string }) => g.path)).toEqual([
      'dropZones[demo].repo',
    ]);
    const r = await post(
      '/api/control/zones',
      {
        zone: {
          repo: 'octo/starter',
          identity: 'starter',
          authorMayBeAdmin: true,
          services: [{ name: 'db', image: 'postgres@sha256:'.padEnd(80, 'a'), port: 5432 }],
        },
        returnTo: '/setup/doctor',
      },
      asSession,
    );
    expect(r.statusCode, r.body).toBe(409);
    const body = r.json();
    expect(body).toMatchObject({
      needsConfirmation: true,
      confirm: `/config/confirm/${body.pendingId}`,
    });
    // The pending change keeps where the confirm page goes next (setup.test follows it there).
    const sessionHash = createHash('sha256').update(sessionId).digest('hex');
    expect(store.confirmations.pending(body.pendingId, sessionHash)?.returnTo).toBe(
      '/setup/doctor',
    );
    const paths = body.guarded.map((g: { path: string }) => g.path);
    expect(paths).toContain('dropZones[starter].identity');
    expect(paths).toContain('dropZones[starter].services');
    expect(store.current().dropZones).toEqual([]);
  });

  test('zones add refuses an empty gates list and an unknown preset before any detection, and answers with what it wrote', async () => {
    const { seen } = zoneApp();
    const empty = await post('/api/control/zones', { zone: { repo: 'octo/demo', gates: [] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({
      issues: [
        {
          path: 'zone.gates',
          message: 'add at least one check (gate): every change must pass one',
        },
      ],
    });
    const preset = await post('/api/control/zones', {
      zone: { repo: 'octo/demo', preset: 'cobol' },
    });
    expect(preset.statusCode).toBe(400);
    expect(preset.json().issues[0]).toMatchObject({ path: 'zone.preset' });
    expect(preset.json().issues[0].message).toMatch(/one of node/);
    expect(seen.calls).toEqual([]);
    const ok = await post('/api/control/zones', { zone: { repo: 'octo/demo' } });
    expect(ok.json()).toMatchObject({ zone: 'demo', preset: 'node', egress: 'monitor' });
    expect(ok.json().gates.map((g: { name: string }) => g.name)).toEqual(['install', 'test']);
  });

  test('zones add refuses a detection that proposes no checks', async () => {
    zoneApp();
    // The fake repository's files hold no test script for a python preset: no gates.
    const r = await post('/api/control/zones', { zone: { repo: 'octo/demo', preset: 'python' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0]).toMatchObject({ path: 'zone.gates' });
  });

  test('zones add refuses a bad repository name, an unknown key and a boot setting in the zone', async () => {
    zoneApp();
    expect((await post('/api/control/zones', { zone: { repo: 'nope' } })).statusCode).toBe(400);
    expect((await post('/api/control/zones', { zone: {} })).statusCode).toBe(400);
    expect(
      (
        await post('/api/control/zones', {
          zone: { repo: 'octo/demo', gates: [], readylabel: 'x' },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('GitHub guidance routes (Task 7)', () => {
  const AUTHOR = 'github_pat_GUIDEAUTHORDUMMY0123456789';
  const REVIEWER = 'github_pat_GUIDEREVIEWERDUMMY012345678';
  const genv = {
    JM_CLAUDE_TOKEN: 'sk-ant-oat01-GUIDECLAUDEDUMMY0123456789',
    JM_GITHUB_AUTHOR_TOKEN: AUTHOR,
    JM_GITHUB_REVIEWER_TOKEN: REVIEWER,
    JM_JOIN_TOKEN: 'join-secret-value-7',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
  };
  const CI_YML =
    'on:\n  pull_request:\njobs:\n  test:\n    runs-on: x\n  lint:\n    name: Lint\n    runs-on: x\n';

  /** A forge per token that answers as GitHub would, recording each call (all reads). */
  function guideApp(
    o: {
      env?: Record<string, string>;
      ownerType?: 'User' | 'Organization';
      private?: boolean;
      /** Without a token GitHub hides a private repository: 404. */
      anonymous404?: boolean;
      /** The clock the guidance cache reads (default t0). */
      clock?: { now: Date };
    } = {},
  ) {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-guide-'));
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, undefined),
      env: o.env ?? genv,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    const calls: string[] = [];
    const tokens: string[] = [];
    const ownerType = o.ownerType ?? 'Organization';
    app = controlApp({
      db,
      config: store,
      now: () => o.clock?.now ?? t0,
      guidanceForge: (repo, token) => {
        tokens.push(token);
        const who = token === AUTHOR ? 'jm-author' : token === REVIEWER ? 'jm-reviewer' : '';
        return {
          async repoAccess() {
            calls.push(`repoAccess ${repo}`);
            if (token === '' && o.anonymous404)
              throw Object.assign(new Error('Not Found'), { status: 404 });
            return {
              private: o.private ?? false,
              defaultBranch: 'main',
              permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
              scopes: null,
              tokenExpiresAt: null,
              ownerType,
            };
          },
          async ownerType() {
            calls.push(`ownerType ${repo}`);
            return ownerType;
          },
          async viewerLogin() {
            calls.push('viewerLogin');
            if (!who) throw Object.assign(new Error('Requires authentication'), { status: 401 });
            return who;
          },
          async listDir(_ref: string, path: string) {
            calls.push(`listDir ${path}`);
            return path === '.github/workflows' ? ['ci.yml'] : [];
          },
          async getFileAt(_ref: string, path: string) {
            calls.push(`getFileAt ${path}`);
            return path === '.github/workflows/ci.yml' ? CI_YML : null;
          },
        };
      },
    });
    return { db, store, calls, tokens };
  }
  const get = (url: string, headers: Record<string, string> = auth) =>
    (app as FastifyInstance).inject({ method: 'GET', url, headers });
  const addZone = async (identity: 'two-bot' | 'starter' = 'two-bot') =>
    post('/api/control/zones', {
      zone: {
        repo: 'octo-org/demo',
        identity,
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test' }],
        egress: { mode: 'monitor' },
      },
    });

  test('GET zones/:id/github holds the five for the zone, from GET-only reads, the logins resolved and no token', async () => {
    const { calls } = guideApp();
    const added = await addZone();
    expect(added.statusCode, added.body).toBe(200);
    const r = await get('/api/control/zones/demo/github?reviewer=alice');
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json();
    expect(g.recommendation.identity).toBe('two-bot');
    expect(Object.keys(g.pat)).toEqual(['author', 'reviewer', 'read']);
    expect(g.pat.author).toMatch(/^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?/);
    const ruleset = JSON.parse(g.ruleset.text);
    expect(
      ruleset.rules.find((x: { type: string }) => x.type === 'required_status_checks').parameters
        .required_status_checks,
    ).toEqual([
      { context: 'test', integration_id: 15368 },
      { context: 'Lint', integration_id: 15368 },
    ]);
    expect(g.codeowners.text).toContain('.github/** @alice');
    expect(g.codeowners.newFileUrl).toBe(
      'https://github.com/octo-org/demo/new/main?filename=.github%2FCODEOWNERS',
    );
    expect(g.checklist.items).toEqual([
      'invite jm-author with the Write role',
      'accept the invitation as jm-author',
      'invite jm-reviewer with the Write role',
      'accept the invitation as jm-reviewer',
    ]);
    expect(r.body).not.toContain(AUTHOR);
    expect(r.body).not.toContain(REVIEWER);
    expect(
      calls.every((c) => /^(repoAccess|listDir|getFileAt|viewerLogin|ownerType)\b/.test(c)),
    ).toBe(true);
    // A reviewer that is not a login is refused before any read; an unknown zone is 404.
    expect((await get('/api/control/zones/demo/github?reviewer=a%20b')).statusCode).toBe(400);
    expect((await get('/api/control/zones/nope/github')).statusCode).toBe(404);
  });

  test('GET zones/:id/github without an author token says to set it first', async () => {
    const { JM_GITHUB_AUTHOR_TOKEN: _a, ...noAuthor } = genv;
    const { store } = guideApp({ env: noAuthor });
    // The zone is in the store, added directly: the add route itself needs no token here.
    const added = await addZone('starter');
    expect(added.statusCode, added.body).toBe(200);
    expect(store.current().dropZones).toHaveLength(1);
    const r = await get('/api/control/zones/demo/github');
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/author token/);
  });

  test('POST github/recommend before any token reads the owner type without one, and asks about the plan of a private repository', async () => {
    const { JM_GITHUB_AUTHOR_TOKEN: _a, JM_GITHUB_REVIEWER_TOKEN: _r, ...none } = genv;
    const { tokens, calls } = guideApp({ env: none, ownerType: 'User', anonymous404: true });
    const r = await post('/api/control/github/recommend', { repo: 'octo/secret' });
    expect(r.statusCode, r.body).toBe(200);
    expect(tokens.every((t) => t === '')).toBe(true);
    expect(calls).toEqual(['repoAccess octo/secret', 'ownerType octo/secret']);
    const j = r.json();
    expect(j).toMatchObject({ ownerType: 'User', visibility: 'private', visible: false });
    expect(j.recommendation).toMatchObject({ identity: 'starter', authorMayBeAdmin: true });
    expect(j.recommendation.ask).toMatch(/paid GitHub plan/);
    expect(j.pat.author).toMatch(/target_name=octo&/);
    expect(j.guidance).toBeUndefined();
    const free = await post('/api/control/github/recommend', {
      repo: 'octo/secret',
      paidPlan: false,
    });
    expect(free.json().recommendation.stop).toMatch(/need a paid plan/);
    const bad = await post('/api/control/github/recommend', { repo: 'octo/se cret' });
    expect(bad.statusCode).toBe(400);
  });

  test('POST github/recommend with the author token returns the proposed zone guidance (ruleset and CODEOWNERS) and the checklist', async () => {
    guideApp({ ownerType: 'Organization' });
    const r = await post('/api/control/github/recommend', {
      repo: 'octo-org/demo',
      identity: 'two-bot',
      reviewers: ['alice'],
    });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ ownerType: 'Organization', visibility: 'public', visible: true });
    expect(j.recommendation.identity).toBe('two-bot');
    expect(j.guidance.ruleset.filename).toBe('jumpmaster-demo-ruleset.json');
    expect(j.guidance.codeowners.text).toContain('CLAUDE.md @alice');
    expect(j.checklist.items[0]).toBe('invite jm-author with the Write role');
    expect(r.body).not.toContain(AUTHOR);
    expect(r.body).not.toContain(REVIEWER);
  });

  test('without a token the recommendation reads only the repository, never its workflows', async () => {
    const { JM_GITHUB_AUTHOR_TOKEN: _a, JM_GITHUB_REVIEWER_TOKEN: _r, ...none } = genv;
    const { calls } = guideApp({ env: none, ownerType: 'User' });
    const r = await post('/api/control/github/recommend', { repo: 'octo/public' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ visibility: 'public', visible: true });
    expect(calls).toEqual(['repoAccess octo/public']);
  });

  test('the reads are cached five minutes per repository and token, a 404 one minute, fifty at most, and dropped when the secrets change', async () => {
    const clock = { now: t0 };
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    const { calls, store } = guideApp({ clock });
    const ask = (repo = 'octo-org/demo') => post('/api/control/github/recommend', { repo });
    expect((await ask()).statusCode).toBe(200);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);
    later(4 * 60_000);
    expect((await ask()).statusCode).toBe(200);
    expect(calls.length).toBe(first);
    later(60_001);
    await ask();
    expect(calls.length).toBeGreaterThan(first);
    // A secrets refresh (a token replaced, a file reloaded) forgets everything read.
    const beforeRefresh = calls.length;
    store.refreshSecrets();
    await ask();
    expect(calls.length).toBeGreaterThan(beforeRefresh);
    // Fifty entries at most: the oldest goes first.
    for (let i = 0; i < 50; i++) await ask(`octo-org/r${i}`);
    const full = calls.length;
    await ask('octo-org/r49');
    expect(calls.length).toBe(full);
    await ask();
    expect(calls.length).toBeGreaterThan(full);
  });

  test('an anonymous 404 is cached one minute', async () => {
    const clock = { now: t0 };
    const { JM_GITHUB_AUTHOR_TOKEN: _a, JM_GITHUB_REVIEWER_TOKEN: _r, ...none } = genv;
    const { calls } = guideApp({ env: none, ownerType: 'User', anonymous404: true, clock });
    const ask = () => post('/api/control/github/recommend', { repo: 'octo/secret' });
    expect((await ask()).json().visible).toBe(false);
    expect(calls).toHaveLength(2);
    clock.now = new Date(t0.getTime() + 59_000);
    expect((await ask()).json().visible).toBe(false);
    expect(calls).toHaveLength(2);
    clock.now = new Date(t0.getTime() + 61_000);
    await ask();
    expect(calls).toHaveLength(4);
  });

  test('a repository the config allows but detection refuses is a 400 naming it; unknown query keys are ignored', async () => {
    const { store } = guideApp();
    const added = await addZone();
    expect(added.statusCode, added.body).toBe(200);
    const config = store.current();
    const zone = config.dropZones[0];
    if (!zone) throw new Error('no zone');
    const odd = await guidanceFor(store, config, { ...zone, repo: 'octo/app@v2' }, () => {
      throw new Error('no forge for a refused name');
    });
    expect(odd).toEqual({
      ok: false,
      status: 400,
      error: expect.stringContaining('the repository must be owner/name'),
    });
    const r = await get('/api/control/zones/demo/github?reviewer=alice&utm_source=pasted');
    expect(r.statusCode, r.body).toBe(200);
  });

  test('the cache key is the token the request read with, not the live store\u2019s', async () => {
    const { store, calls } = guideApp();
    const config = store.current();
    const ask = (c: typeof config) =>
      recommendFor(store, c, { repo: 'octo-org/demo' }, (repo, token) => ({
        repoAccess: async () => {
          calls.push(`repoAccess ${repo} ${token === AUTHOR ? 'author' : 'other'}`);
          return {
            private: false,
            defaultBranch: 'main',
            permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
            scopes: null,
            tokenExpiresAt: null,
            ownerType: 'Organization' as const,
          };
        },
        ownerType: async () => 'Organization' as const,
        viewerLogin: async () => 'jm-author',
        listDir: async () => [],
        getFileAt: async () => null,
      }));
    await ask(config);
    const n = calls.length;
    await ask(config);
    expect(calls.length).toBe(n);
    // A snapshot read with another author token (a rotation mid-request) is another key.
    await ask({
      ...config,
      secrets: { ...config.secrets, githubAuthorToken: 'github_pat_OTHERDUMMY012345678901234' },
    });
    expect(calls.length).toBeGreaterThan(n);
    expect(calls.at(-1)).toBe('repoAccess octo-org/demo other');
  });
});

describe('zones page routes', () => {
  const zenv = {
    JM_CLAUDE_TOKEN: 'sk-ant-oat01-ZPAGECLAUDEDUMMY0123456789',
    JM_GITHUB_AUTHOR_TOKEN: 'github_pat_ZPAGEAUTHORDUMMY0123456789',
    JM_GITHUB_REVIEWER_TOKEN: 'github_pat_ZPAGEREVIEWERDUMMY0123456789',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
  };
  const zd = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    repo: `octo/${id}`,
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'jm-trooper:dev',
    egress: { mode: 'monitor', allow: ['known.example.com'] },
    ...extra,
  });
  const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };

  function pageApp() {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-zpage-'));
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, undefined),
      env: zenv,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    store.apply({ dropZones: [zd('a'), zd('b')] }, { via: 'ctl', principal: token });
    for (const id of ['a', 'b'])
      upsertDropZone(db, { id, repo: `octo/${id}`, defaultBranch: 'main', configJson: '{}' });
    app = controlApp({ db, config: store, now: () => t0 });
    const session = operatorSession(db);
    return { db, store, asSession: { ...session.headers, host: HOST } };
  }
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
  /** An egress event a monitor drop reported. */
  function seen(db: ReturnType<typeof openDb>, dropId: string, zone: string, host: string, n = 1) {
    insertDrop(db, {
      id: dropId,
      dropZoneId: zone,
      workItemId: null,
      role: 'doctor',
      state: 'succeeded',
      createdAt: t0.toISOString(),
    });
    db.prepare(
      `INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, 1, ?, 'egress', ?)`,
    ).run(dropId, t0.toISOString(), JSON.stringify({ host, decision: 'allowed', count: n }));
  }

  test('a PATCH names one zone by id and leaves the others alone', async () => {
    const { store } = pageApp();
    const r = await call('PATCH', '/api/control/config', {
      patch: { dropZones: [{ id: 'b', readyLabel: 'go' }] },
      expectRevision: store.revision(),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(store.current().dropZones.map((z) => [z.id, z.readyLabel])).toEqual([
      ['a', 'agent-ready'],
      ['b', 'go'],
    ]);
  });

  test('list and show give every zone with its mode and plain label, never a secret', async () => {
    pageApp();
    const list = await call('GET', '/api/control/zones');
    expect(list.statusCode).toBe(200);
    expect(list.json().zones.map((z: { id: string; mode: string }) => [z.id, z.mode])).toEqual([
      ['a', 'active'],
      ['b', 'active'],
    ]);
    expect(list.json().zones[0]).toMatchObject({
      repo: 'octo/a',
      modeLabel: 'active: takes ready issues and runs drops',
      egress: 'monitor',
      identity: 'two-bot',
      image: 'jm-trooper:dev',
    });
    const show = await call('GET', '/api/control/zones/b');
    expect(show.json()).toMatchObject({ zone: zd('b'), mode: 'active', index: 1 });
    expect((await call('GET', '/api/control/zones/nope')).statusCode).toBe(404);
    for (const v of Object.values(zenv)) {
      expect(list.body).not.toContain(v);
      expect(show.body).not.toContain(v);
    }
  });

  test('remove needs the zone drained in observe, deletes its mode row only, and keeps its history', async () => {
    const { db, store } = pageApp();
    const busy = await call('DELETE', '/api/control/zones/a');
    expect(busy.statusCode).toBe(400);
    expect(busy.json().issues[0].message).toMatch(/can't be removed until it is drained/);
    upsertWorkItem(db, {
      dropZoneId: 'a',
      issueNumber: 3,
      title: 't',
      body: 'b',
      author: 'x',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setZoneMode(db, 'a', 'observe', t0);
    const r = await call('DELETE', '/api/control/zones/a');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ removed: 'a' });
    expect(store.current().dropZones.map((z) => z.id)).toEqual(['b']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM zone_controls WHERE zone_id = 'a'").get()).toEqual(
      { n: 0 },
    );
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE drop_zone_id = 'a'").get(),
    ).toEqual({ n: 1 });
    expect(listAudit(db)[0]).toMatchObject({ action: 'zone.remove', target: 'a' });
    expect((await call('DELETE', '/api/control/zones/zzz')).statusCode).toBe(404);
  });

  test('an id with history answers with what Resume would bring back, and resume brings it back paused', async () => {
    const { db, store } = pageApp();
    upsertDropZone(db, { id: 'old', repo: 'octo/old', defaultBranch: 'main', configJson: '{}' });
    upsertWorkItem(db, {
      dropZoneId: 'old',
      issueNumber: 9,
      title: 't',
      body: 'b',
      author: 'x',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    seen(db, 'old-d1', 'old', 'x.example.com');
    const zone = { repo: 'octo/old', id: 'old', gates: [{ name: 't', run: 'true' }], image: 'i:1' };
    const refused = await call('POST', '/api/control/zones', { zone });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().history).toEqual({
      workItems: 1,
      drops: 1,
      outbox: 0,
      crewIssues: 0,
      goals: 0,
    });
    const resumed = await call('POST', '/api/control/zones', { zone, resume: true });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(getZoneMode(db, 'old', 'active')).toBe('paused');
    expect(store.current().dropZones.map((z) => z.id)).toContain('old');
  });

  test("adopt is refused while the zone's egress is off, rather than turning it on", async () => {
    const { db, store } = pageApp();
    const off = await call('PATCH', '/api/control/config', {
      patch: { dropZones: [{ id: 'b', egress: null }] },
      expectRevision: store.revision(),
    });
    expect(off.statusCode, off.body).toBe(200);
    seen(db, 'd9', 'b', 'x.example.com');
    const r = await call('POST', '/api/control/zones/b/egress/adopt', { hosts: ['x.example.com'] });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe(
      'egress is off for zone b: set it to monitor or enforce first, so the allow list is used',
    );
    expect(store.current().dropZones[1]?.egress).toBeUndefined();
  });

  test('a removal note stays within the note limit whatever the id', () => {
    // An M4 file may carry a long id; the lenient read keeps it (with a warning).
    expect(removalNote(`z${'x'.repeat(600)}`).length).toBeLessThanOrEqual(500);
    expect(removalNote('c')).toBe('remove zone c');
  });

  test('the egress section lists observed hosts with their drops', async () => {
    const { db } = pageApp();
    seen(db, 'd1', 'a', 'new.example.com', 3);
    seen(db, 'd2', 'a', 'new.example.com', 2);
    seen(db, 'd3', 'a', 'registry.npmjs.org', 1);
    seen(db, 'd4', 'b', 'other.example.com', 1);
    const r = await call('GET', '/api/control/zones/a/egress/observed');
    expect(r.statusCode).toBe(200);
    expect(r.json().since).toBe(new Date(t0.getTime() - 14 * 86_400_000).toISOString());
    expect(r.json().hosts).toEqual([
      { host: 'new.example.com', decision: 'allowed', count: 5, drops: ['d1', 'd2'] },
      { host: 'registry.npmjs.org', decision: 'allowed', count: 1, drops: ['d3'] },
    ]);
  });

  test('adopt adds only ticked, valid entries, is guarded, and records the revision note', async () => {
    const { db, store, asSession } = pageApp();
    seen(db, 'd1', 'a', 'new.example.com');
    const bad = await call('POST', '/api/control/zones/a/egress/adopt', {
      hosts: ['new.example.com', '10.0.0.1'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues).toEqual([
      { path: 'hosts.1', message: 'not a host name or *.name: 10.0.0.1' },
    ]);
    expect(
      (await call('POST', '/api/control/zones/a/egress/adopt', { hosts: [] })).statusCode,
    ).toBe(400);
    // Only hosts this zone's drops reached in the window can be adopted.
    const unseen = await call('POST', '/api/control/zones/a/egress/adopt', {
      hosts: ['new.example.com', 'never.example.com'],
    });
    expect(unseen.statusCode).toBe(400);
    expect(unseen.json().issues).toEqual([
      {
        path: 'hosts.1',
        message: 'never.example.com was not observed for zone a in the last 14 days',
      },
    ]);
    // From a session the addition is guarded: the confirmation page, nothing applied yet.
    const s = await call(
      'POST',
      '/api/control/zones/a/egress/adopt',
      { hosts: ['new.example.com'] },
      asSession,
    );
    expect(s.statusCode).toBe(409);
    expect(s.json().guarded.map((g: { path: string }) => g.path)).toEqual([
      'dropZones[a].egress.allow',
    ]);
    // With the token: applied, an allowed host is not added twice, and the note says what.
    const r = await call('POST', '/api/control/zones/a/egress/adopt', {
      hosts: ['new.example.com', 'known.example.com'],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(store.current().dropZones[0]?.egress?.allow).toEqual([
      'known.example.com',
      'new.example.com',
    ]);
    expect(store.revisions(1)[0]?.note).toBe('adopt observed hosts: new.example.com');
  });
});
