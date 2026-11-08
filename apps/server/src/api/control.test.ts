import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listRulings, raiseBriefing } from '../briefings.js';
import type { Config } from '../config.js';
import { ctlRequest } from '../ctl.js';
import { openDb } from '../db/open.js';
import {
  getZoneMode,
  insertDrop,
  isKilled,
  setWorkItemState,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
  zoneIsDrained,
} from '../db/repo.js';
import { makeZone } from '../test/fixtures.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import { registerControlRoutes } from './control.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(allowedHosts?: string[]) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  const config = {
    listen: { host: '127.0.0.1', port: 7420, ...(allowedHosts ? { allowedHosts } : {}) },
    dropZones: [makeZone({ id: 'main' })],
    secrets: { operatorToken: TOKEN },
  } as unknown as Config;
  app = Fastify();
  registerControlRoutes(app, { db, config, now: () => t0 });
  return db;
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
    expect(ctlRequest(['rule', '7'])).toBeNull();
  });
});
