import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { Config } from '../config.js';
import { openDb } from '../db/open.js';
import {
  getDrop,
  getStickByTokenHash,
  insertDrop,
  listEvents,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { fakeForge } from '../test/fakes.js';
import { t0, tmpDbFile, workItem } from '../test/helpers.js';
import { buildPayload, promptVersion, registerStickRoutes } from './sticks.js';

const config: Config = {
  listen: { host: '127.0.0.1', port: 7420 },
  dataDir: '/data',
  pollSeconds: 60,
  dropZones: [
    {
      id: 'main',
      repo: 'octo/demo',
      readyLabel: 'agent-ready',
      gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
      image: 'jm-trooper:test',
      model: 'claude-opus-5-5',
      maxTurns: 200,
    },
  ],
  secrets: { claudeToken: 'claude-secret', githubAuthorToken: 'gh-secret', joinToken: 'join-me' },
};

const proto = { 'x-jumpmaster-protocol': '1' };
const bearer = (token: string) => ({ ...proto, authorization: `Bearer ${token}` });

const gateOk = { name: 'test', exitCode: 0, durationMs: 1500, timedOut: false, outputTail: '' };

let app: FastifyInstance;

function setup(opts: { queued?: boolean; leaseWaitMs?: number; leasePollMs?: number } = {}) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 'Add widget',
    body: 'Please add a widget.',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(db, wi.id, 'in_flight');
  if (opts.queued !== false) {
    insertDrop(db, {
      id: 'd1',
      dropZoneId: 'main',
      workItemId: wi.id,
      role: 'implement',
      state: 'queued',
      createdAt: t0.toISOString(),
    });
  }
  const forge = fakeForge({ issues: [], trusted: [] });
  app = Fastify();
  registerStickRoutes(app, {
    db,
    config,
    forgeFor: () => forge,
    now: () => t0,
    leaseWaitMs: opts.leaseWaitMs ?? 60,
    leasePollMs: opts.leasePollMs ?? 10,
  });
  return { db, forge, wi };
}

async function enroll(name = 'stick-1') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: proto,
    payload: { joinToken: 'join-me', name, slots: 1 },
  });
  return res.json() as { stickId: string; stickToken: string };
}

const lease = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: bearer(token),
    payload: { freeSlots: 1 },
  });

afterEach(() => app.close());

describe('stick API', () => {
  test('wrong join token is 401', async () => {
    setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: proto,
      payload: { joinToken: 'nope', name: 's', slots: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  test('missing or wrong protocol header is 426 on every route, before auth', async () => {
    setup();
    for (const url of [
      '/api/sticks/enroll',
      '/api/sticks/lease',
      '/api/drops/d1/heartbeat',
      '/api/drops/d1/events',
      '/api/drops/d1/result',
    ]) {
      for (const headers of [{}, { 'x-jumpmaster-protocol': '2' }]) {
        const res = await app.inject({ method: 'POST', url, headers, payload: {} });
        expect(res.statusCode, url).toBe(426);
      }
    }
  });

  test('enroll stores only the token hash', async () => {
    const { db } = setup();
    const { stickId, stickToken } = await enroll();
    const hash = createHash('sha256').update(stickToken).digest('hex');
    expect(getStickByTokenHash(db, hash)).toMatchObject({ id: stickId, name: 'stick-1', slots: 1 });
    expect(getStickByTokenHash(db, stickToken)).toBeUndefined();
  });

  test('lease without a valid token is 401', async () => {
    setup();
    expect((await lease('bogus')).statusCode).toBe(401);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: proto,
      payload: { freeSlots: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  test('lease returns a payload with branch agent/issue-N', async () => {
    setup();
    const { stickToken } = await enroll();
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      protocol: 1,
      dropId: 'd1',
      role: 'implement',
      branch: 'agent/issue-7',
      epoch: 1,
      repo: { owner: 'octo', name: 'demo', defaultBranch: 'main' },
      issue: { number: 7, title: 'Add widget' },
      image: 'jm-trooper:test',
      resume: false,
      protectedPaths: [],
      credentials: { claudeToken: 'claude-secret', forgeToken: 'gh-secret' },
      model: 'claude-opus-5-5',
      maxTurns: 200,
      promptVersion: promptVersion(),
    });
  });

  test('lease with nothing queued is 204 after the long-poll', async () => {
    setup({ queued: false });
    const { stickToken } = await enroll();
    expect((await lease(stickToken)).statusCode).toBe(204);
  });

  test('lease with no free slots is 204 without leasing', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: bearer(stickToken),
      payload: { freeSlots: 0 },
    });
    expect(res.statusCode).toBe(204);
    expect(getDrop(db, 'd1')?.state).toBe('queued');
  });

  test('buildPayload prompt is template plus issue; version is 12 hex', async () => {
    const { db } = setup();
    const zone = config.dropZones[0]!;
    const drop = { ...getDrop(db, 'd1')!, epoch: 1 };
    const p = buildPayload(db, zone, drop, config.secrets);
    expect(p.prompt).toMatch(/autonomous coding agent/);
    expect(p.prompt).toMatch(/\n\n## Issue #7: Add widget\n\nPlease add a widget\.$/);
    expect(p.promptVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  test('heartbeat ok moves to running; wrong epoch or other stick is 409', async () => {
    const { db } = setup();
    const a = await enroll('a');
    const b = await enroll('b');
    await lease(a.stickToken);
    const hb = (token: string, epoch: number) =>
      app.inject({
        method: 'POST',
        url: '/api/drops/d1/heartbeat',
        headers: bearer(token),
        payload: { epoch },
      });
    const ok = await hb(a.stickToken, 1);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ cancel: false });
    expect(getDrop(db, 'd1')?.state).toBe('running');
    expect((await hb(a.stickToken, 2)).statusCode).toBe(409);
    expect((await hb(b.stickToken, 1)).statusCode).toBe(409);
  });

  test('events append with increasing seq; stale epoch is 409', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    await lease(stickToken);
    const post = (epoch: number, n: number) =>
      app.inject({
        method: 'POST',
        url: '/api/drops/d1/events',
        headers: bearer(stickToken),
        payload: {
          epoch,
          events: Array.from({ length: n }, (_, i) => ({
            ts: t0.toISOString(),
            kind: 'log',
            data: { i },
          })),
        },
      });
    expect((await post(1, 2)).statusCode).toBe(204);
    expect((await post(1, 1)).statusCode).toBe(204);
    expect(listEvents(db, 'd1').map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await post(9, 1)).statusCode).toBe(409);
    expect(listEvents(db, 'd1')).toHaveLength(3);
  });

  test('events for a drop that is not leased/running are 409', async () => {
    setup();
    const { stickToken } = await enroll();
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/events',
      headers: bearer(stickToken),
      payload: { epoch: 0, events: [] },
    });
    expect(res.statusCode).toBe(409);
  });

  test('result with stale epoch is 409', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    await lease(stickToken);
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 2, result: { status: 'completed', headSha: 'abc', gates: [gateOk] } },
    });
    expect(res.statusCode).toBe(409);
    expect(getDrop(db, 'd1')?.state).toBe('leased');
  });

  test('accepted result stores result_json, finishes the drop and opens a PR', async () => {
    const { db, forge } = setup();
    const { stickToken } = await enroll();
    await lease(stickToken);
    const result = { status: 'completed', headSha: 'abc', gates: [gateOk] };
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result },
    });
    expect(res.statusCode).toBe(204);
    const drop = getDrop(db, 'd1');
    expect(drop).toMatchObject({ state: 'succeeded', finishedAt: t0.toISOString() });
    expect(JSON.parse(drop?.resultJson ?? 'null')).toMatchObject(result);
    expect(forge.created).toHaveLength(1);
    expect(workItem(db, 1)).toMatchObject({ state: 'pr_open', prNumber: 101 });
    // A second delivery is stale.
    const again = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result },
    });
    expect(again.statusCode).toBe(409);
    expect(forge.created).toHaveLength(1);
  });

  test('long-poll over a real socket waits and returns a drop enqueued later', async () => {
    const { db, wi } = setup({ queued: false, leaseWaitMs: 2000, leasePollMs: 50 });
    const { stickToken } = await enroll();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const started = Date.now();
    const pending = fetch(`http://127.0.0.1:${port}/api/sticks/lease`, {
      method: 'POST',
      headers: { ...bearer(stickToken), 'content-type': 'application/json' },
      body: JSON.stringify({ freeSlots: 1 }),
    });
    setTimeout(() => {
      insertDrop(db, {
        id: 'late',
        dropZoneId: 'main',
        workItemId: wi.id,
        role: 'implement',
        state: 'queued',
        createdAt: t0.toISOString(),
      });
    }, 200);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dropId: string }).dropId).toBe('late');
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test('lease for a drop whose zone is not configured releases it back to queued', async () => {
    const { db, wi } = setup({ queued: false });
    upsertDropZone(db, { id: 'ghost', repo: 'o/g', defaultBranch: 'main', configJson: '{}' });
    const w2 = upsertWorkItem(db, {
      dropZoneId: 'ghost',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(db, {
      id: 'g1',
      dropZoneId: 'ghost',
      workItemId: w2.id,
      role: 'implement',
      state: 'queued',
    });
    void wi;
    const { stickToken } = await enroll();
    expect((await lease(stickToken)).statusCode).toBe(500);
    expect(getDrop(db, 'g1')).toMatchObject({ state: 'queued', stickId: null });
  });
});
