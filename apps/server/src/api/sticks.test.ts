import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURES_HEADER,
  IMAGE_MIRROR_FEATURE,
  PushGrantSchema,
  PushPlanSchema,
  SLOTS_HEADER,
} from '@jumpmaster/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { SetupMode, setupActive } from '../auth/operator.js';
import type { LiveConfig } from '../config/source.js';
import type { Config } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  activeDropFor,
  effectiveSlots,
  getAttempts,
  getDrop,
  getOutbox,
  getPullRequest,
  getStick,
  getStickByTokenHash,
  getUsageState,
  insertDrop,
  listEvents,
  reclaimableDropFor,
  reserveGrant,
  type Stick,
  setAttempts,
  setKilled,
  setStickDesiredSlots,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  updateDrop,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
} from '../db/repo.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { StickFetches } from '../images/fetches.js';
import { ImageMirror } from '../images/mirror.js';
import { buildPayload, promptVersions } from '../payloads.js';
import { type FakeImage, type FakeRegistry, startFakeRegistry } from '../test/fake-registry.js';
import { fakeForge } from '../test/fakes.js';
import { plus, t0, tmpDbFile, workItem } from '../test/helpers.js';
import { registerStickRoutes } from './sticks.js';

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
      models: {},
      protectedPaths: [],
      reviewReadToken: false,
      budgets: {
        maxHeal: 3,
        maxResolve: 2,
        maxResolveTotal: 6,
        maxResume: 2,
        maxReviewRepeat: 2,
        maxNoChange: 1,
      },
      ciRequired: true,
      ciDeadlineMinutes: 45,
      retryLabel: 'agent-retry',
      mergeMethod: 'squash',
      requireBranchProtection: true,
      services: [],
      verification: [],
      limits: { pids: 512 },
    },
  ],
  usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
  secrets: {
    claudeToken: 'claude-secret',
    githubAuthorToken: 'gh-secret',
    githubReviewerToken: 'gh-reviewer',
    joinToken: 'join-me',
    operatorToken: 'o'.repeat(32),
  },
};

const proto = { 'x-jumpmaster-protocol': '1' };
const bearer = (token: string) => ({ ...proto, authorization: `Bearer ${token}` });

const gateOk = { name: 'test', exitCode: 0, durationMs: 1500, timedOut: false, outputTail: '' };

let app: FastifyInstance;

function setup(
  opts: {
    queued?: boolean;
    leaseWaitMs?: number;
    leasePollMs?: number;
    now?: () => Date;
    config?: LiveConfig;
    logs?: string[];
    images?: ImageMirror;
    fetches?: StickFetches;
  } = {},
) {
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
  const forgeZones: string[] = [];
  app = Fastify();
  registerStickRoutes(app, {
    db,
    config: opts.config ?? config,
    ...(opts.logs ? { log: (line: string) => opts.logs?.push(line) } : {}),
    forgesFor: (zoneId) => {
      forgeZones.push(zoneId);
      return { author: forge, reviewer: forge };
    },
    now: opts.now ?? (() => t0),
    leaseWaitMs: opts.leaseWaitMs ?? 60,
    leasePollMs: opts.leasePollMs ?? 10,
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.fetches ? { fetches: opts.fetches } : {}),
  });
  return { db, forge, wi, forgeZones };
}

/** Enrolls a stick that runs up to 4 troopers, so a test may lease it several drops. */
async function enroll(name = 'stick-1') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: proto,
    payload: { joinToken: 'join-me', name, slots: 4 },
  });
  return res.json() as { stickId: string; stickToken: string };
}

/** A lease from a current stick: it runs push containers. */
const lease = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: bearer(token),
    payload: { freeSlots: 1, capabilities: ['push-v1'] },
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
    expect(getStickByTokenHash(db, hash)).toMatchObject({ id: stickId, name: 'stick-1', slots: 4 });
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
      promptVersion: promptVersions().implement,
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
    expect(p.prompt).toMatch(
      /\n\n## Issue \(data\)\n\n<<<jm-data:d1:begin issue>>>\n#7: Add widget\n\nPlease add a widget\.\n<<<jm-data:d1:end issue>>>$/,
    );
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
    expect(ok.json()).toEqual({ cancel: false, hard: false });
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

  test('an events batch of 8 MiB is accepted; 8 MiB + 1 byte is refused with 413', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    await lease(stickToken);
    const LIMIT = 8 * 1024 * 1024;
    const body = (bytes: number) => {
      const of = (text: string) =>
        JSON.stringify({
          epoch: 1,
          events: [{ ts: t0.toISOString(), kind: 'agent', data: { text } }],
        });
      return of('x'.repeat(bytes - Buffer.byteLength(of(''))));
    };
    const post = (payload: string) =>
      app.inject({
        method: 'POST',
        url: '/api/drops/d1/events',
        headers: { ...bearer(stickToken), 'content-type': 'application/json' },
        payload,
      });
    expect(Buffer.byteLength(body(LIMIT))).toBe(LIMIT);
    expect((await post(body(LIMIT))).statusCode).toBe(204);
    expect((await post(body(LIMIT + 1))).statusCode).toBe(413);
    const stored = listEvents(db, 'd1');
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.data).length).toBeGreaterThan(LIMIT - 200);
  });

  test('rate_limit events update utilization but a live rejected never pauses', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    await lease(stickToken);
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/events',
      headers: bearer(stickToken),
      payload: {
        epoch: 1,
        events: [
          {
            ts: t0.toISOString(),
            kind: 'rate_limit',
            data: {
              status: 'rejected',
              resetsAt: '2026-01-01T03:00:00.000Z',
              unifiedWindows: { seven_day: { utilization: 0.42 } },
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(204);
    const u = getUsageState(db);
    expect(u.sevenDayUtil).toBe(0.42);
    expect(u.pausedUntil).toBeNull();
  });

  test('lease honours a closed usage gate', async () => {
    const { db } = setup();
    setUsageState(db, { status: 'rejected', pausedUntil: '2026-01-01T01:00:00.000Z' }, t0);
    const { stickToken } = await enroll();
    expect((await lease(stickToken)).statusCode).toBe(204);
    expect(getDrop(db, 'd1')?.state).toBe('queued');
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

  test('the result route uses forgesFor and now()', async () => {
    let clock = t0;
    const { db, forgeZones } = setup({ now: () => clock });
    const { stickToken } = await enroll();
    await lease(stickToken);
    clock = plus(t0, 5000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result: { status: 'completed', headSha: 'abc', gates: [] } },
    });
    expect(res.statusCode).toBe(204);
    expect(forgeZones).toEqual(['main']);
    expect(getDrop(db, 'd1')?.finishedAt).toBe(clock.toISOString());
    expect(getOutbox(db, 'pr:1:abc')).toMatchObject({
      state: 'done',
      createdAt: clock.toISOString(),
    });
    expect(getPullRequest(db, 1)?.observedAt).toBe(clock.toISOString());
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
      body: JSON.stringify({ freeSlots: 1, capabilities: ['push-v1'] }),
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

describe('the trooper count (x-jumpmaster-slots)', () => {
  const enrollWith = async (slots: number) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/sticks/enroll',
        headers: proto,
        payload: { joinToken: 'join-me', name: 'kidney-shadow', slots },
      })
    ).json() as { stickId: string; stickToken: string };
  const leaseWith = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/sticks/lease', headers: bearer(token), payload });
  /** `n` drops live on the stick, outside the queued one. */
  const busyOn = (db: Db, stickId: string, n: number) => {
    for (let i = 0; i < n; i++)
      insertDrop(db, {
        id: `busy${i}`,
        dropZoneId: 'main',
        workItemId: upsertWorkItem(db, {
          dropZoneId: 'main',
          issueNumber: 100 + i,
          title: 't',
          body: 'b',
          author: 'a',
          priority: 0,
          isFix: false,
          issueCreatedAt: t0.toISOString(),
        }).id,
        role: 'implement',
        state: i % 2 === 0 ? 'running' : 'leased',
        stickId,
        epoch: 1,
        createdAt: t0.toISOString(),
      });
  };

  test('the header is on a 200 and on a 204', async () => {
    setup();
    const { stickToken } = await enrollWith(2);
    const got = await leaseWith(stickToken, { freeSlots: 1, capabilities: ['push-v1'] });
    expect(got.statusCode).toBe(200);
    expect(got.headers[SLOTS_HEADER]).toBe('2');
    const none = await leaseWith(stickToken, { freeSlots: 1, capabilities: ['push-v1'] });
    expect(none.statusCode).toBe(204);
    expect(none.headers[SLOTS_HEADER]).toBe('2');
    const full = await leaseWith(stickToken, { freeSlots: 0 });
    expect(full.statusCode).toBe(204);
    expect(full.headers[SLOTS_HEADER]).toBe('2');
  });

  test('a stick with effective 2 and 2 active drops gets 204, even asking with freeSlots 5', async () => {
    const { db } = setup();
    const { stickId, stickToken } = await enrollWith(2);
    busyOn(db, stickId, 2);
    const res = await leaseWith(stickToken, {
      freeSlots: 5,
      maxSlots: 8,
      capabilities: ['push-v1'],
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers[SLOTS_HEADER]).toBe('2');
    expect(getDrop(db, 'd1')?.state).toBe('queued');
    // A pending push holds no lease slot: one of the two finishing its run frees one.
    updateDrop(db, 'busy1', { state: 'push_pending' });
    const after = await leaseWith(stickToken, { freeSlots: 5, capabilities: ['push-v1'] });
    expect(after.statusCode).toBe(200);
  });

  test('max_slots is stored from the body; the desired count applies up to it', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enrollWith(1);
    await leaseWith(stickToken, { freeSlots: 1, maxSlots: 4 });
    expect(getStick(db, stickId)).toMatchObject({ slots: 1, maxSlots: 4, desiredSlots: null });
    setStickDesiredSlots(db, stickId, 3);
    const res = await leaseWith(stickToken, { freeSlots: 1, maxSlots: 4 });
    expect(res.headers[SLOTS_HEADER]).toBe('3');
    // A stick restarted with a lower ceiling caps the desired count.
    const lower = await leaseWith(stickToken, { freeSlots: 1, maxSlots: 2 });
    expect(lower.headers[SLOTS_HEADER]).toBe('2');
    expect(getStick(db, stickId)?.maxSlots).toBe(2);
    const invalid = await leaseWith(stickToken, { freeSlots: 1, maxSlots: 0 });
    expect(invalid.statusCode).toBe(400);
  });

  test('an old-shaped body without maxSlots is capped at the enrolled slots', async () => {
    const { db } = setup();
    const { stickId, stickToken } = await enrollWith(1);
    setStickDesiredSlots(db, stickId, 3);
    busyOn(db, stickId, 1);
    const res = await leaseWith(stickToken, { freeSlots: 2 });
    expect(res.statusCode).toBe(204);
    expect(res.headers[SLOTS_HEADER]).toBe('1');
    expect(getStick(db, stickId)?.maxSlots).toBeNull();
    expect(getDrop(db, 'd1')?.state).toBe('queued');
  });

  test('a stick with no desired count runs exactly as before: its enrolled slots', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enrollWith(3);
    const res = await leaseWith(stickToken, { freeSlots: 1, maxSlots: 4 });
    expect(res.headers[SLOTS_HEADER]).toBe('3');
    expect(effectiveSlots(getStick(db, stickId) as Stick)).toBe(3);
  });
  test('a stick enrolled with 1 and restarted with a starting count of 3 still runs 3', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enrollWith(1);
    const res = await leaseWith(stickToken, { freeSlots: 1, maxSlots: 4, slots: 3 });
    expect(res.headers[SLOTS_HEADER]).toBe('3');
    expect(getStick(db, stickId)).toMatchObject({ slots: 3, maxSlots: 4, desiredSlots: null });
    // An old-shaped body leaves the refreshed count as it was.
    const old = await leaseWith(stickToken, { freeSlots: 1 });
    expect(old.headers[SLOTS_HEADER]).toBe('3');
    const invalid = await leaseWith(stickToken, { freeSlots: 1, slots: 0 });
    expect(invalid.statusCode).toBe(400);
  });
});

describe('stick capabilities, per zone', () => {
  // `main` needs nothing new (an M3 zone). `locked` enforces egress; with requireSignedImages it
  // also needs verified images under the signed policy.
  const locked = {
    ...config.dropZones[0]!,
    id: 'locked',
    repo: 'octo/locked',
    egress: { mode: 'enforce' as const },
  };
  const twoZones = (extra: Partial<Config> = {}): Config => ({
    ...config,
    dropZones: [config.dropZones[0]!, locked],
    ...extra,
  });

  function lockedDrop(db: ReturnType<typeof setup>['db'], createdAt = t0) {
    upsertDropZone(db, {
      id: 'locked',
      repo: 'octo/locked',
      defaultBranch: 'main',
      configJson: '{}',
    });
    const w = upsertWorkItem(db, {
      dropZoneId: 'locked',
      issueNumber: 9,
      title: 'Locked work',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    setWorkItemState(db, w.id, 'in_flight');
    insertDrop(db, {
      id: 'x1',
      dropZoneId: 'locked',
      workItemId: w.id,
      role: 'implement',
      state: 'queued',
      createdAt: plus(createdAt, -60_000).toISOString(),
    });
    return w;
  }

  const leaseWith = (token: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: bearer(token),
      payload: { freeSlots: 1, ...body },
    });
  const skippedOf = (res: { headers: Record<string, unknown> }) => {
    const h = res.headers['x-jumpmaster-skipped'];
    return typeof h === 'string' ? JSON.parse(decodeURIComponent(h)) : undefined;
  };

  test('every lease stamps last_seen_at, capabilities, policy, version and pins', async () => {
    const at = plus(t0, 5000);
    const { db } = setup({ queued: false, now: () => at });
    const { stickToken } = await enroll();
    const hash = createHash('sha256').update(stickToken).digest('hex');
    expect(getStickByTokenHash(db, hash)).toMatchObject({
      lastSeenAt: null,
      capabilities: [],
      imagePolicy: 'allowlist',
      version: null,
      pinnedImages: [],
    });
    const pin = `ghcr.io/o/svc@sha256:${'d'.repeat(64)}`;
    await leaseWith(stickToken, {
      capabilities: ['egress-v1', 'future-cap'],
      imagePolicy: 'signed',
      version: '0.4.0',
      pinnedImages: [pin],
    });
    expect(getStickByTokenHash(db, hash)).toMatchObject({
      lastSeenAt: at.toISOString(),
      capabilities: ['egress-v1', 'future-cap'],
      imagePolicy: 'signed',
      version: '0.4.0',
      pinnedImages: [pin],
    });
    // An M3 body stamps the defaults, so a downgraded stick doesn't keep its old claims.
    await leaseWith(stickToken, {});
    expect(getStickByTokenHash(db, hash)).toMatchObject({
      capabilities: [],
      imagePolicy: 'allowlist',
      version: null,
      pinnedImages: [],
    });
  });

  test('enroll records what the stick advertises; a malformed advertisement is refused', async () => {
    const { db } = setup({ queued: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: proto,
      payload: {
        joinToken: 'join-me',
        name: 's',
        slots: 1,
        capabilities: ['egress-v1'],
        version: '0.4.0',
      },
    });
    const { stickToken } = res.json() as { stickToken: string };
    const hash = createHash('sha256').update(stickToken).digest('hex');
    expect(getStickByTokenHash(db, hash)).toMatchObject({
      capabilities: ['egress-v1'],
      version: '0.4.0',
    });
    for (const bad of [
      { imagePolicy: 'anything' },
      { capabilities: 'egress-v1' },
      { capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) },
      { version: 'v'.repeat(65) },
      { pinnedImages: ['x'.repeat(513)] },
    ])
      expect((await leaseWith(stickToken, bad)).statusCode, JSON.stringify(bad).slice(0, 40)).toBe(
        400,
      );
  });

  test('a long poll judges what the stick can run afresh each poll: a zone whose egress turns off mid-poll is leased', async () => {
    const off = { ...locked, egress: { mode: 'off' as const } };
    let armed = false;
    let reads = 0;
    const source = {
      current: (): Config => {
        if (armed) reads += 1;
        // The first poll sees the enforce zone; a revision then turns its egress off.
        return armed && reads > 1
          ? twoZones({ dropZones: [config.dropZones[0]!, off] })
          : twoZones();
      },
    };
    const { db } = setup({ queued: false, config: source, leaseWaitMs: 5000, leasePollMs: 1 });
    lockedDrop(db);
    const { stickToken } = await enroll();
    armed = true;
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { dropId: string }).dropId).toBe('x1');
    expect(skippedOf(res)).toBeUndefined();
  });

  test('a count reached mid-poll answers 204 with the skipped zones, like the timeout does', async () => {
    let onRead: (() => void) | undefined;
    const source = {
      current: (): Config => {
        onRead?.();
        onRead = undefined;
        return twoZones();
      },
    };
    const { db } = setup({ queued: false, config: source, leaseWaitMs: 5000, leasePollMs: 1 });
    lockedDrop(db);
    const { stickId, stickToken } = await enroll();
    // While the poll waits, the operator lowers the count to 1 and a drop starts on the stick.
    onRead = () => {
      setStickDesiredSlots(db, stickId, 1);
      insertDrop(db, {
        id: 'busy',
        dropZoneId: 'main',
        workItemId: upsertWorkItem(db, {
          dropZoneId: 'main',
          issueNumber: 900,
          title: 't',
          body: 'b',
          author: 'a',
          priority: 0,
          isFix: false,
          issueCreatedAt: t0.toISOString(),
        }).id,
        role: 'implement',
        state: 'running',
        stickId,
        epoch: 1,
        createdAt: t0.toISOString(),
      });
    };
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(204);
    expect(res.headers[SLOTS_HEADER]).toBe('1');
    expect(skippedOf(res)).toEqual([{ zoneId: 'locked', missing: ['egress-v1'] }]);
  });

  test('a stick without egress-v1 skips an enforce zone drop and leases a drop from an off zone', async () => {
    const { db } = setup({ config: twoZones() });
    lockedDrop(db);
    const { stickToken } = await enroll();
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { dropId: string }).dropId).toBe('d1');
    expect(getDrop(db, 'x1')).toMatchObject({ state: 'queued', stickId: null, epoch: 0 });
    // A capable stick takes the enforce zone's drop.
    const capable = await enroll('stick-2');
    const res2 = await leaseWith(capable.stickToken, { capabilities: ['egress-v1', 'push-v1'] });
    expect((res2.json() as { dropId: string }).dropId).toBe('x1');
  });

  test('the body governs, not the stored row: a downgraded stick is excluded on that very poll', async () => {
    const { db } = setup({ queued: false, config: twoZones() });
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: proto,
      payload: { joinToken: 'join-me', name: 's', slots: 1, capabilities: ['egress-v1'] },
    });
    const { stickToken } = enrolled.json() as { stickToken: string };
    // The capable advertisement is on record from enroll and from a lease with nothing waiting.
    expect((await leaseWith(stickToken, { capabilities: ['egress-v1'] })).statusCode).toBe(204);
    const hash = createHash('sha256').update(stickToken).digest('hex');
    expect(getStickByTokenHash(db, hash)?.capabilities).toEqual(['egress-v1']);
    lockedDrop(db);
    // The same stick now sends a bare M3 body: the enforce zone's drop is not leased to it.
    const res = await leaseWith(stickToken, {});
    expect(res.statusCode).toBe(204);
    expect(skippedOf(res)).toEqual([{ zoneId: 'locked', missing: ['egress-v1'] }]);
    expect(getDrop(db, 'x1')).toMatchObject({ state: 'queued', stickId: null, epoch: 0 });
  });

  test('a stick with allowlist policy skips drops of a zone needing signed images', async () => {
    const { db } = setup({ queued: false, config: twoZones({ requireSignedImages: true }) });
    lockedDrop(db);
    const { stickToken } = await enroll();
    const caps = ['egress-v1', 'image-verify-v1', 'push-v1'];
    const res = await leaseWith(stickToken, { capabilities: caps, imagePolicy: 'allowlist' });
    expect(res.statusCode).toBe(204);
    expect(skippedOf(res)).toEqual([{ zoneId: 'locked', missing: ['image-policy:signed'] }]);
    expect(getDrop(db, 'x1')?.state).toBe('queued');
    const ok = await leaseWith(stickToken, { capabilities: caps, imagePolicy: 'signed' });
    expect((ok.json() as { dropId: string }).dropId).toBe('x1');
    expect(skippedOf(ok)).toBeUndefined();
  });

  test('a skipped drop stays queued with no budget consumed', async () => {
    const { db } = setup({ queued: false, config: twoZones() });
    const w = lockedDrop(db);
    const before = getAttempts(db, w.id, 'resume');
    const { stickToken } = await enroll();
    for (let i = 0; i < 3; i++) expect((await lease(stickToken)).statusCode).toBe(204);
    expect(getDrop(db, 'x1')).toMatchObject({
      state: 'queued',
      stickId: null,
      epoch: 0,
      leaseExpiresAt: null,
      startedAt: null,
    });
    expect(getAttempts(db, w.id, 'resume')).toEqual(before);
    expect(getUsageState(db).probeDropId).toBeNull();
    expect(listEvents(db, 'x1')).toEqual([]);
  });

  test('the lease response names skipped zones and missing capabilities, and the server logs why', async () => {
    const logs: string[] = [];
    const signedLocked = { ...locked, requireSignedImages: true };
    const cfg = { ...config, dropZones: [config.dropZones[0]!, signedLocked] };
    const { db } = setup({ config: cfg, logs });
    lockedDrop(db);
    const { stickId, stickToken } = await enroll();
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(200);
    expect(skippedOf(res)).toEqual([
      { zoneId: 'locked', missing: ['egress-v1', 'image-verify-v1', 'image-policy:signed'] },
    ]);
    // Another poll within the minute logs nothing new.
    await lease(stickToken);
    const lines = logs.filter((l) => l.includes('locked'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(stickId);
    expect(lines[0]).toMatch(/egress-v1, image-verify-v1, image-policy:signed/);
    // A poll that leases nothing (204) still names the zone while its drop waits.
    const waiting = await lease(stickToken);
    expect(waiting.statusCode).toBe(204);
    expect(skippedOf(waiting)).toEqual([
      { zoneId: 'locked', missing: ['egress-v1', 'image-verify-v1', 'image-policy:signed'] },
    ]);
    // Once nothing waits in the incapable zone, nothing is named.
    db.prepare("UPDATE drops SET state = 'cancelled' WHERE id = 'x1'").run();
    expect(skippedOf(await lease(stickToken))).toBeUndefined();
  });

  test('with no zone needing a capability, an M3 stick skips no zone but gets no pushing role', async () => {
    // The reference zone: image set, egress and signed images left at their defaults.
    const { db } = setup({ config: { ...config, requireSignedImages: false } });
    const { stickToken } = await enroll();
    const res = await leaseWith(stickToken, {}); // body { freeSlots } only, as an M3 stick sends
    expect(res.statusCode).toBe(204);
    expect(skippedOf(res)).toBeUndefined();
    expect(getDrop(db, 'd1')?.state).toBe('queued');
    const current = await lease(stickToken);
    expect((current.json() as { dropId: string }).dropId).toBe('d1');
  });
});

describe('setup mode', () => {
  test('a stick enrolls and heartbeats while setup is active', async () => {
    const db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
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
    const forge = fakeForge({ issues: [], trusted: [] });
    // The whole app, guard included, on a database with no operator; a stick may use any address.
    const whole = createApp({
      db,
      config,
      forgesFor: () => ({ author: forge, reviewer: forge }),
      now: () => t0,
      setup: new SetupMode(() => {}),
      leaseWaitMs: 0,
      leasePollMs: 0,
    });
    expect(setupActive(db)).toBe(true);
    const at = { ...proto, host: 'jumpmaster:7420' };
    const enrolled = await whole.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: at,
      payload: { joinToken: 'join-me', name: 's', slots: 1 },
    });
    expect(enrolled.statusCode).toBe(200);
    const { stickToken } = enrolled.json() as { stickToken: string };
    const auth = { ...at, authorization: `Bearer ${stickToken}` };
    const leased = await whole.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: auth,
      payload: { freeSlots: 1, capabilities: ['push-v1'] },
    });
    expect(leased.statusCode).toBe(200);
    const hb = await whole.inject({
      method: 'POST',
      url: '/api/drops/d1/heartbeat',
      headers: auth,
      payload: { epoch: 1 },
    });
    expect(hb.statusCode).toBe(200);
    expect(getDrop(db, 'd1')?.state).toBe('running');
    await whole.close();
  });
});

describe('push container routes', () => {
  const SHA_A = 'a'.repeat(40);
  const SHA_B = 'b'.repeat(40);
  const PRIOR = 'c'.repeat(40);
  const HOUR = 3_600_000;

  const post = (url: string, token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url, headers: bearer(token), payload });
  const leasePush = (token: string, body: Record<string, unknown> = {}) =>
    post('/api/sticks/lease', token, { freeSlots: 1, capabilities: ['push-v1'], ...body });
  const postResult = (token: string, result: Record<string, unknown>, epoch = 1) =>
    post('/api/drops/d1/result', token, { epoch, result });
  const plan = (token: string, dropId = 'd1', epoch = 1) =>
    post('/api/sticks/push-plan', token, { dropId, epoch });
  const grant = (token: string, dropId = 'd1', epoch = 1) =>
    post('/api/sticks/push-token', token, { dropId, epoch });
  const pushResult = (token: string, result: Record<string, unknown>, dropId = 'd1', epoch = 1) =>
    post(`/api/drops/${dropId}/push-result`, token, { epoch, result });
  const salvage = (token: string, dropId = 'd1', epoch = 1) =>
    post('/api/sticks/salvage', token, { dropId, epoch });

  const liveGrants = (db: Db): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE revoked_at IS NULL').get() as {
        n: number;
      }
    ).n;

  type PendingOpts = {
    id?: string;
    role?: 'implement' | 'review' | 'heal' | 'resolve';
    kind?: 'final' | 'checkpoint' | 'salvage';
    result?: Record<string, unknown>;
    headSha?: string | null;
    prNumber?: number | null;
    expectSha?: string | null;
  };

  /** A drop of `stickId` at epoch 1, parked in `push_pending` as the result route leaves it. */
  function pending(db: Db, stickId: string, o: PendingOpts = {}): string {
    const id = o.id ?? 'd1';
    const kind = o.kind ?? 'final';
    const role = o.role ?? 'implement';
    insertDrop(db, {
      id,
      dropZoneId: 'main',
      workItemId: 1,
      role,
      state: 'queued',
      headSha: o.headSha ?? null,
      prNumber: o.prNumber ?? null,
      createdAt: t0.toISOString(),
    });
    const result =
      o.result ??
      (kind === 'final'
        ? { status: 'completed', role, headSha: SHA_A, gates: [] }
        : { status: 'interrupted', role, headSha: SHA_B, gates: [] });
    updateDrop(db, id, {
      state: 'push_pending',
      stickId,
      epoch: 1,
      pushKind: kind,
      pushExpectSha: o.expectSha !== undefined ? o.expectSha : kind === 'final' ? SHA_A : null,
      pushDeadline: plus(t0, 24 * HOUR).toISOString(),
      resultJson: JSON.stringify(result),
      usageApplied: 1,
      runningAt: t0.toISOString(),
      finishedAt: t0.toISOString(),
    });
    return id;
  }

  /** An open PR for item 1, as heal and resolve drops need. */
  function openPr(db: Db) {
    upsertPullRequest(
      db,
      { workItemId: 1, number: 1, headRef: 'agent/issue-7', headSha: PRIOR, state: 'open' },
      t0,
    );
    setWorkItemState(db, 1, 'pr_open', undefined, t0);
  }

  test('lease announces push-v1 and gives pushing roles only to push-v1 sticks without noPush', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    const leaseOld = () => post('/api/sticks/lease', stickToken, { freeSlots: 1 });
    const old = await leaseOld(); // an older stick: no push-v1
    expect(old.statusCode).toBe(204);
    expect(old.headers[FEATURES_HEADER]).toBe('push-v1');
    const full = await leasePush(stickToken, { noPush: true });
    expect(full.statusCode).toBe(204);
    expect(full.headers[FEATURES_HEADER]).toBe('push-v1');
    expect(getDrop(db, 'd1')?.state).toBe('queued');
    // Review drops still go to it.
    const other = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 8,
      title: 'Other',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(db, {
      id: 'r1',
      dropZoneId: 'main',
      workItemId: other.id,
      role: 'review',
      state: 'queued',
      prNumber: 1,
      headSha: PRIOR,
      createdAt: t0.toISOString(),
    });
    const review = await leaseOld();
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ dropId: 'r1', role: 'review' });
    const implement = await leasePush(stickToken);
    expect(implement.statusCode).toBe(200);
    expect(implement.headers[FEATURES_HEADER]).toBe('push-v1');
    expect(implement.json()).toMatchObject({ dropId: 'd1', role: 'implement' });
  });

  test('a push-requested result parks the drop, applies usage once and releases the probe', async () => {
    const { db, forge } = setup();
    const { stickToken } = await enroll();
    await leasePush(stickToken);
    setUsageState(db, { probeDropId: 'd1' }, t0);
    const result = {
      status: 'completed',
      headSha: SHA_A,
      gates: [gateOk],
      push: { kind: 'final', expectSha: SHA_A },
      rateLimit: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.42 } } },
    };
    const res = await postResult(stickToken, result);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'push_pending' });
    const drop = getDrop(db, 'd1');
    expect(drop).toMatchObject({
      state: 'push_pending',
      pushKind: 'final',
      pushExpectSha: SHA_A,
      pushDeadline: plus(t0, 24 * HOUR).toISOString(),
      usageApplied: 1,
      wasProbe: 1,
    });
    expect(JSON.parse(drop?.resultJson ?? 'null')).toMatchObject(result);
    expect(getUsageState(db)).toMatchObject({ probeDropId: null, sevenDayUtil: 0.42 });
    // Nothing of the outcome yet: no PR, the item still in flight.
    expect(forge.created).toHaveLength(0);
    expect(workItem(db, 1).state).toBe('in_flight');
    // Usage is not applied again.
    setUsageState(db, { sevenDayUtil: 0.1 }, t0);
    expect((await postResult(stickToken, result)).statusCode).toBe(200);
    expect(getUsageState(db).sevenDayUtil).toBe(0.1);
  });

  test('a repeated push-requested result is idempotent', async () => {
    let clock = t0;
    const { db } = setup({ now: () => clock });
    const { stickToken } = await enroll();
    await leasePush(stickToken);
    const result = {
      status: 'interrupted',
      headSha: SHA_B,
      gates: [],
      push: { kind: 'checkpoint' },
    };
    expect((await postResult(stickToken, result)).json()).toEqual({ state: 'push_pending' });
    const before = getDrop(db, 'd1');
    clock = plus(t0, HOUR);
    const again = await postResult(stickToken, result);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ state: 'push_pending' });
    expect(getDrop(db, 'd1')).toEqual(before);
    // Another epoch is still stale.
    expect((await postResult(stickToken, result, 2)).statusCode).toBe(409);
  });

  test('an invalid push request is 422', async () => {
    const cases: [string, 'implement' | 'resolve', Record<string, unknown>][] = [
      [
        'final on interrupted',
        'implement',
        {
          status: 'interrupted',
          headSha: SHA_A,
          gates: [],
          push: { kind: 'final', expectSha: SHA_A },
        },
      ],
      [
        'a mismatched headSha',
        'implement',
        {
          status: 'completed',
          headSha: SHA_B,
          gates: [],
          push: { kind: 'final', expectSha: SHA_A },
        },
      ],
      [
        'a resolve checkpoint',
        'resolve',
        { status: 'interrupted', headSha: SHA_B, gates: [], push: { kind: 'checkpoint' } },
      ],
      [
        'salvage from the agent',
        'implement',
        { status: 'interrupted', headSha: SHA_B, gates: [], push: { kind: 'salvage' } },
      ],
    ];
    for (const [name, role, result] of cases) {
      const { db } = setup({ queued: false });
      if (role === 'resolve') openPr(db);
      insertDrop(db, {
        id: 'd1',
        dropZoneId: 'main',
        workItemId: 1,
        role,
        state: 'queued',
        ...(role === 'resolve' ? { prNumber: 1, headSha: PRIOR } : {}),
        createdAt: t0.toISOString(),
      });
      const { stickToken } = await enroll();
      expect((await leasePush(stickToken)).statusCode, name).toBe(200);
      const res = await postResult(stickToken, result);
      expect(res.statusCode, name).toBe(422);
      expect(getDrop(db, 'd1')?.state, name).toBe('leased');
      await app.close();
    }
  });

  test('push-plan answers the branch and egress and revokes stale reservations', async () => {
    const egressed: Config = {
      ...config,
      dropZones: [
        {
          ...config.dropZones[0]!,
          egress: { mode: 'enforce', allow: ['registry.npmjs.org'] },
          limits: { pids: 256, memoryMb: 2048 },
        },
      ],
    };
    const { db } = setup({ queued: false, config: egressed });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'checkpoint' });
    expect(reserveGrant(db, 'd1', 1, t0)).toBe('ok');
    const res = await plan(stickToken);
    expect(res.statusCode).toBe(200);
    expect(PushPlanSchema.parse(res.json())).toEqual({
      branch: 'agent/issue-7',
      salvage: false,
      limits: { pids: 256, memoryMb: 2048 },
      egress: { mode: 'enforce', allow: ['github.com'] },
    });
    expect(liveGrants(db)).toBe(0);
    expect((await grant(stickToken)).statusCode).toBe(200);
  });

  test('push-plan refuses up front under the kill switch and in observe, not in pause', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    setKilled(db, true, t0);
    let res = await plan(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'killed', retryable: true });
    setKilled(db, false, t0);
    setZoneMode(db, 'main', 'observe', t0);
    res = await plan(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'zone observe', retryable: true });
    setZoneMode(db, 'main', 'paused', t0);
    res = await plan(stickToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ branch: 'agent/issue-7' });
  });

  test('push-plan without egress names none, and salvage only for a salvage', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'salvage' });
    expect((await plan(stickToken)).json()).toEqual({
      branch: 'agent/issue-7',
      salvage: true,
      limits: { pids: 512 },
    });
  });

  test('push-token refuses killed, observe, another stick, another epoch, a non-pushing role', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    const other = await enroll('other');
    pending(db, stickId);

    setKilled(db, true, t0);
    let res = await grant(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'killed', retryable: true });
    setKilled(db, false, t0);

    setZoneMode(db, 'main', 'observe', t0);
    res = await grant(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'zone observe', retryable: true });
    setZoneMode(db, 'main', 'active', t0);

    res = await grant(other.stickToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ stale: true });
    res = await grant(stickToken, 'd1', 2);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ stale: true });
    expect(liveGrants(db)).toBe(0);

    const { db: db2 } = setup({ queued: false });
    const s2 = await enroll();
    openPr(db2);
    pending(db2, s2.stickId, { id: 'r1', role: 'review', prNumber: 1, headSha: PRIOR });
    res = await grant(s2.stickToken, 'r1');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'role', retryable: false });
    expect(liveGrants(db2)).toBe(0);
  });

  test('a paused zone still grants: pause lets running work finish, its push included', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    setZoneMode(db, 'main', 'paused', t0);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(200);
    expect(PushGrantSchema.parse(res.json().grant).branch).toBe('agent/issue-7');
  });

  test('push-token refuses a zone whose repository is no longer the drop zone one', async () => {
    const moved: Config = {
      ...config,
      dropZones: [{ ...config.dropZones[0]!, repo: 'octo/elsewhere' }],
    };
    const { db } = setup({ queued: false, config: moved });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'repo mismatch', retryable: false });
    expect(liveGrants(db)).toBe(0);
  });

  test('one live reservation per drop', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const [a, b] = await Promise.all([grant(stickToken), grant(stickToken)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json()).toEqual({ refused: 'reserved', retryable: true });
    expect(liveGrants(db)).toBe(1);
  });

  test('rediscovery revokes a stale reservation', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    expect((await grant(stickToken)).statusCode).toBe(200);
    expect((await grant(stickToken)).statusCode).toBe(409);
    const s = await salvage(stickToken);
    expect(s.statusCode).toBe(200);
    expect(s.json()).toEqual({ state: 'push_pending' });
    expect(getDrop(db, 'd1')?.pushKind).toBe('final');
    expect((await grant(stickToken)).statusCode).toBe(200);
  });

  test("the grant carries the drop's own secrets only", async () => {
    const secrets: Config['secrets'] = {
      ...config.secrets,
      zoneSecrets: { main: { NPM_TOKEN: 'npm-main' }, other: { NPM_TOKEN: 'npm-other' } },
    };
    const withSecrets: Config = {
      ...config,
      dropZones: [{ ...config.dropZones[0]!, protectedPaths: ['.github/**'] }],
      secrets,
    };
    const { db } = setup({ queued: false, config: withSecrets });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { grant: unknown };
    const g = PushGrantSchema.parse(body.grant);
    expect(g).toMatchObject({
      token: 'gh-secret',
      owner: 'octo',
      name: 'demo',
      branch: 'agent/issue-7',
      base: 'main',
      lease: '',
      expectSha: SHA_A,
      protectedPaths: ['.github/**'],
    });
    const basic = Buffer.from('x-access-token:gh-secret').toString('base64');
    expect([...g.secrets].sort()).toEqual([basic, 'claude-secret', 'gh-secret', 'npm-main'].sort());
    for (const absent of ['gh-reviewer', 'join-me', 'npm-other', 'o'.repeat(32)]) {
      expect(JSON.stringify(body), absent).not.toContain(absent);
    }
  });

  test("the grant's secrets include the read token the agent container held", async () => {
    const withRead: Config = {
      ...config,
      secrets: { ...config.secrets, githubReadToken: 'gh-read' },
    };
    const { db } = setup({ queued: false, config: withRead });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(200);
    const g = PushGrantSchema.parse((res.json() as { grant: unknown }).grant);
    // The push itself still uses the author token; the read token is only refused in the diff.
    expect(g.token).toBe('gh-secret');
    const b64 = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');
    for (const t of ['gh-read', b64('gh-read'), 'gh-secret', b64('gh-secret')]) {
      expect(g.secrets).toContain(t);
    }
  });

  test('the grant leases on the resumed sha for implement and the PR head for heal', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'checkpoint', headSha: PRIOR });
    const res = await grant(stickToken);
    expect(res.json()).toMatchObject({ grant: { lease: PRIOR } });
    expect((res.json() as { grant: object }).grant).not.toHaveProperty('expectSha');

    const { db: db2 } = setup({ queued: false });
    const s2 = await enroll();
    openPr(db2);
    pending(db2, s2.stickId, { role: 'heal', prNumber: 1, headSha: PRIOR });
    const heal = await grant(s2.stickToken);
    expect(heal.json()).toMatchObject({ grant: { lease: PRIOR, expectSha: SHA_A } });
    void db;
  });

  test('the audit row never contains the token', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    expect((await grant(stickToken)).statusCode).toBe(200);
    const rows = listAudit(db).filter((a) => a.action === 'push-token');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      via: 'system',
      detail: { drop: 'd1', epoch: 1, kind: 'final' },
    });
    expect(JSON.stringify(rows)).not.toContain('gh-secret');
    const minted = db
      .prepare('SELECT minted_at AS m FROM push_tokens WHERE drop_id = ?')
      .get('d1') as { m: string | null };
    expect(minted.m).toBe(t0.toISOString());
  });

  test('push-result pushed applies the outcome with the pushed sha and skips usage', async () => {
    const { db, forge } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, {
      result: {
        status: 'completed',
        headSha: SHA_A,
        gates: [],
        rateLimit: { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.42 } } },
      },
    });
    setUsageState(db, { sevenDayUtil: 0.1 }, t0);
    expect((await grant(stickToken)).statusCode).toBe(200);
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_A,
      alreadyThere: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'succeeded' });
    expect(forge.created).toHaveLength(1);
    expect(getPullRequest(db, 1)).toMatchObject({ headSha: SHA_A });
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getUsageState(db).sevenDayUtil).toBe(0.1);
    expect(liveGrants(db)).toBe(0);
  });

  test('push-result pushed for a checkpoint resumes from the pushed sha', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'checkpoint', headSha: PRIOR });
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_B,
      alreadyThere: true,
    });
    expect(res.json()).toEqual({ state: 'succeeded' });
    expect(activeDropFor(db, 1)).toMatchObject({
      role: 'implement',
      state: 'queued',
      headSha: SHA_B,
    });
  });

  test('a final push that reports another head is a failure, never the PR head', async () => {
    const { db, forge } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_B,
      alreadyThere: false,
    });
    expect(res.json()).toEqual({ state: 'failed' });
    expect(forge.created).toHaveLength(0);
    expect(getPullRequest(db, 1)).toBeUndefined();
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'pushed branch is not the gated commit',
    });
  });

  test('a failed final push fails the drop', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await pushResult(stickToken, {
      status: 'failed',
      reason: 'push touches a protected path',
      retryable: false,
    });
    expect(res.json()).toEqual({ state: 'failed' });
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'push touches a protected path',
    });
  });

  test('a failed checkpoint push resumes from the prior sha', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'checkpoint', headSha: PRIOR });
    const res = await pushResult(stickToken, {
      status: 'failed',
      reason: 'rejected',
      retryable: false,
    });
    expect(res.json()).toEqual({ state: 'succeeded' });
    expect(activeDropFor(db, 1)).toMatchObject({
      role: 'implement',
      state: 'queued',
      headSha: PRIOR,
    });
    expect(getAttempts(db, 1, 'resume').count).toBe(1);
  });

  test('a retryable failure stays pending', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    expect((await grant(stickToken)).statusCode).toBe(200);
    const res = await pushResult(stickToken, {
      status: 'failed',
      reason: 'HTTP 502',
      retryable: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'push_pending' });
    expect(getDrop(db, 'd1')?.state).toBe('push_pending');
    expect(liveGrants(db)).toBe(0);
    expect((await grant(stickToken)).statusCode).toBe(200);
  });

  test('nothing returns the drop to lost', async () => {
    let clock = t0;
    const { db } = setup({ queued: false, now: () => clock });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'salvage' });
    clock = plus(t0, 60_000);
    const res = await pushResult(stickToken, { status: 'nothing', reason: 'nothing ahead' });
    expect(res.json()).toEqual({ state: 'lost' });
    expect(getDrop(db, 'd1')).toMatchObject({ state: 'lost', finishedAt: clock.toISOString() });
    expect(workItem(db, 1).state).toBe('in_flight');
    expect(activeDropFor(db, 1)).toBeUndefined();
  });

  test('a checkpoint with nothing new spends the resume budget', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId, { kind: 'checkpoint', headSha: PRIOR });
    let res = await pushResult(stickToken, { status: 'nothing', reason: 'nothing new' });
    expect(res.json()).toEqual({ state: 'succeeded' });
    expect(getAttempts(db, 1, 'resume').count).toBe(1);
    expect(activeDropFor(db, 1)).toMatchObject({ headSha: PRIOR, chargedKey: 'resume' });
    // With the budget spent, the item parks.
    db.prepare("DELETE FROM drops WHERE state = 'queued'").run();
    setAttempts(db, 1, 'resume', 2, null);
    pending(db, stickId, { id: 'd2', kind: 'checkpoint', headSha: PRIOR });
    res = await pushResult(stickToken, { status: 'nothing', reason: 'nothing new' }, 'd2');
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
  });

  test('push-result is idempotent after it applied', async () => {
    const { db, forge } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const pushed = { status: 'pushed', headSha: SHA_A, alreadyThere: false };
    expect((await pushResult(stickToken, pushed)).json()).toEqual({ state: 'succeeded' });
    const again = await pushResult(stickToken, pushed);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ state: 'succeeded' });
    expect(forge.created).toHaveLength(1);
    // Another epoch, or a drop that never asked for a push, is stale.
    expect((await pushResult(stickToken, pushed, 'd1', 2)).statusCode).toBe(409);
    void db;
  });

  test('salvage accepts pending, recently lost running and kill-cancelled drops; refuses resolve, old lost, and items with another active drop', async () => {
    const lostAt = (db: Db, id: string, runningMsAgo: number, lostMsAgo: number) =>
      updateDrop(db, id, {
        state: 'lost',
        runningAt: plus(t0, -runningMsAgo).toISOString(),
        finishedAt: plus(t0, -lostMsAgo).toISOString(),
        pushKind: null,
        pushExpectSha: null,
        pushDeadline: null,
        resultJson: null,
        usageApplied: 0,
      });

    // Pending: continues as it is.
    let w = setup({ queued: false });
    let s = await enroll();
    pending(w.db, s.stickId);
    let res = await salvage(s.stickToken);
    expect(res.json()).toEqual({ state: 'push_pending' });
    expect(getDrop(w.db, 'd1')?.pushKind).toBe('final');

    // Recently lost while running: a salvage with a synthetic interrupted result.
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    lostAt(w.db, 'd1', 5 * 60_000, 60_000);
    res = await salvage(s.stickToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'push_pending' });
    const d = getDrop(w.db, 'd1');
    expect(d).toMatchObject({
      state: 'push_pending',
      pushKind: 'salvage',
      pushExpectSha: null,
      pushDeadline: plus(t0, 24 * HOUR).toISOString(),
      usageApplied: 1,
    });
    expect(JSON.parse(d?.resultJson ?? 'null')).toEqual({
      status: 'interrupted',
      role: 'implement',
      gates: [],
      reason: 'salvaged',
    });

    // Cancelled by the kill switch, while the switch is still on.
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    updateDrop(w.db, 'd1', { state: 'cancelled', pushKind: null });
    w.db.prepare('UPDATE drops SET hard_cancel = 1 WHERE id = ?').run('d1');
    setKilled(w.db, true, t0);
    res = await salvage(s.stickToken);
    expect(res.json()).toEqual({ state: 'push_pending' });
    expect(getDrop(w.db, 'd1')?.pushKind).toBe('salvage');

    // Refused: an operator cancel (not hard).
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    updateDrop(w.db, 'd1', { state: 'cancelled' });
    res = await salvage(s.stickToken);
    expect(res.statusCode).toBe(409);
    expect(getDrop(w.db, 'd1')?.state).toBe('cancelled');

    // Refused: resolve.
    w = setup({ queued: false });
    s = await enroll();
    openPr(w.db);
    pending(w.db, s.stickId, { role: 'resolve', prNumber: 1, headSha: PRIOR });
    lostAt(w.db, 'd1', 5 * 60_000, 60_000);
    res = await salvage(s.stickToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ refused: 'role' });
    expect(getDrop(w.db, 'd1')?.state).toBe('lost');

    // Refused: lost too long ago.
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    lostAt(w.db, 'd1', 30 * 60_000, 16 * 60_000);
    res = await salvage(s.stickToken);
    expect(res.statusCode).toBe(409);
    expect(getDrop(w.db, 'd1')?.state).toBe('lost');

    // Refused: lost before it ever ran.
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    lostAt(w.db, 'd1', 0, 60_000);
    updateDrop(w.db, 'd1', { runningAt: null });
    expect((await salvage(s.stickToken)).statusCode).toBe(409);

    // Refused: the item already has another active drop.
    w = setup({ queued: false });
    s = await enroll();
    pending(w.db, s.stickId);
    lostAt(w.db, 'd1', 5 * 60_000, 60_000);
    insertDrop(w.db, {
      id: 'd2',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'queued',
    });
    res = await salvage(s.stickToken);
    expect(res.statusCode).toBe(409);
    expect(getDrop(w.db, 'd1')?.state).toBe('lost');

    // Refused: another stick's drop.
    w = setup({ queued: false });
    s = await enroll();
    const other = await enroll('other');
    pending(w.db, s.stickId);
    lostAt(w.db, 'd1', 5 * 60_000, 60_000);
    expect((await salvage(other.stickToken)).statusCode).toBe(409);
  });

  test('a kill-cancelled drop is salvaged only while it is the item open drop, until the reclaim window after release', async () => {
    let clock = t0;
    const killedDrop = async (o: { release?: number; itemState?: 'done' | 'parked' } = {}) => {
      const w = setup({ queued: false, now: () => clock });
      const s = await enroll();
      pending(w.db, s.stickId);
      updateDrop(w.db, 'd1', { state: 'cancelled', pushKind: null });
      w.db.prepare('UPDATE drops SET hard_cancel = 1 WHERE id = ?').run('d1');
      setKilled(w.db, true, t0);
      if (o.release !== undefined) setKilled(w.db, false, plus(t0, o.release));
      if (o.itemState) setWorkItemState(w.db, 1, o.itemState, undefined, t0);
      return { ...w, ...s };
    };
    const MIN = 60_000;

    // Released ten minutes ago: still within the reclaim window.
    clock = plus(t0, HOUR + 10 * MIN);
    let w = await killedDrop({ release: HOUR });
    expect((await salvage(w.stickToken)).json()).toEqual({ state: 'push_pending' });

    // Released sixteen minutes ago: refused.
    clock = plus(t0, HOUR + 16 * MIN);
    w = await killedDrop({ release: HOUR });
    let res = await salvage(w.stickToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ refused: 'state' });
    expect(getDrop(w.db, 'd1')?.state).toBe('cancelled');

    // Still killed, days later: accepted (nothing has replaced it).
    clock = plus(t0, 72 * HOUR);
    w = await killedDrop();
    expect((await salvage(w.stickToken)).json()).toEqual({ state: 'push_pending' });

    // The item finished meanwhile: refused, even with the switch on.
    for (const itemState of ['done', 'parked'] as const) {
      w = await killedDrop({ itemState });
      res = await salvage(w.stickToken);
      expect(res.statusCode, itemState).toBe(409);
      expect(getDrop(w.db, 'd1')?.state, itemState).toBe('cancelled');
    }

    // A later drop on the item (finished): this one is no longer the item's latest.
    w = await killedDrop();
    insertDrop(w.db, {
      id: 'd2',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'succeeded',
      createdAt: plus(t0, MIN).toISOString(),
    });
    res = await salvage(w.stickToken);
    expect(res.statusCode).toBe(409);
    expect(getDrop(w.db, 'd1')?.state).toBe('cancelled');
  });

  test('a drop lost after a long run is still salvageable within the window', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    updateDrop(db, 'd1', {
      state: 'lost',
      runningAt: plus(t0, -3 * HOUR).toISOString(),
      finishedAt: plus(t0, -60_000).toISOString(),
    });
    expect((await salvage(stickToken)).json()).toEqual({ state: 'push_pending' });
  });

  test('a salvage that found nothing is not salvageable again', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    updateDrop(db, 'd1', {
      state: 'lost',
      runningAt: plus(t0, -5 * 60_000).toISOString(),
      finishedAt: plus(t0, -60_000).toISOString(),
    });
    expect((await salvage(stickToken)).json()).toEqual({ state: 'push_pending' });
    expect(
      (await pushResult(stickToken, { status: 'nothing', reason: 'nothing ahead' })).json(),
    ).toEqual({
      state: 'lost',
    });
    expect(getDrop(db, 'd1')).toMatchObject({ state: 'lost', runningAt: null });
    expect(reclaimableDropFor(db, 1, t0)).toBeUndefined();
    const again = await salvage(stickToken);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ refused: 'state' });
  });

  test('heartbeat answers killed and cancel for pending pushes', async () => {
    let clock = t0;
    const { db } = setup({ now: () => clock });
    const { stickToken } = await enroll();
    await leasePush(stickToken);
    const hb = () => post('/api/drops/d1/heartbeat', stickToken, { epoch: 1 });
    expect((await hb()).json()).toEqual({ cancel: false, hard: false });
    expect(getDrop(db, 'd1')?.runningAt).toBe(t0.toISOString());
    clock = plus(t0, 30_000);
    await hb();
    expect(getDrop(db, 'd1')?.runningAt).toBe(t0.toISOString());

    await postResult(stickToken, {
      status: 'completed',
      headSha: SHA_A,
      gates: [],
      push: { kind: 'final', expectSha: SHA_A },
    });
    const ok = await hb();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ cancel: false, hard: false });
    expect(getDrop(db, 'd1')?.state).toBe('push_pending');
    setKilled(db, true, clock);
    expect((await hb()).json()).toEqual({ cancel: false, hard: false, killed: true });
    setKilled(db, false, clock);
    updateDrop(db, 'd1', { state: 'cancelled' });
    expect((await hb()).json()).toEqual({ cancel: true, hard: false });
  });

  test('push-plan and push-token answer stale for a drop that left push_pending', async () => {
    const { db } = setup({ queued: false });
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    for (const state of ['lost', 'cancelled', 'succeeded'] as const) {
      updateDrop(db, 'd1', { state });
      for (const res of [await plan(stickToken), await grant(stickToken)]) {
        expect(res.statusCode, state).toBe(409);
        expect(res.json(), state).toMatchObject({ stale: true });
      }
    }
    expect(liveGrants(db)).toBe(0);
  });
});

describe('the images route (issue #140)', () => {
  let fake: FakeRegistry;
  let img: FakeImage;
  let pending: FakeImage;
  afterEach(() => fake.close());

  /** A mirror with one complete image and one listed but not yet fetched. */
  async function withImages() {
    fake = await startFakeRegistry();
    img = fake.addImage('jumpmaster-trooper');
    pending = fake.addImage('jumpmaster-egress');
    const images = new ImageMirror({
      dataDir: mkdtempSync(join(tmpdir(), 'jm-route-')),
      scheme: () => 'http',
      scrub: new ScrubSet(),
      log: () => {},
    });
    images.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    await images.syncOnce();
    images.setLock({
      registry: fake.registry,
      images: { [img.name]: img.digest, [pending.name]: pending.digest },
    });
    setup({ images });
    return enroll();
  }

  const get = (url: string, headers: Record<string, string> = proto) =>
    app.inject({ method: 'GET', url, headers });
  const urlOf = (name: string, digest: string, platform = 'linux/amd64') =>
    `/api/sticks/images/${name}@${digest}/oci.tar?platform=${encodeURIComponent(platform)}`;

  test('an authenticated stick downloads the OCI layout tar, with its length and ETag', async () => {
    const { stickToken } = await withImages();
    const res = await get(urlOf(img.name, img.digest), bearer(stickToken));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-tar');
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    expect(res.headers.etag).toBe(`"${img.platforms['linux/amd64']?.manifest}"`);
    expect(res.rawPayload.subarray(0, 10).toString()).toBe('oci-layout');
    const arm = await get(urlOf(img.name, img.digest, 'linux/arm64'), bearer(stickToken));
    expect(arm.headers.etag).toBe(`"${img.platforms['linux/arm64']?.manifest}"`);
    // A percent-encoded reference is the same reference.
    const encoded = await get(
      `/api/sticks/images/${encodeURIComponent(`${img.name}@${img.digest}`)}/oci.tar?platform=linux/amd64`,
      bearer(stickToken),
    );
    expect(encoded.statusCode).toBe(200);
    // The same ETag again: nothing to send.
    const again = await get(urlOf(img.name, img.digest), {
      ...bearer(stickToken),
      'if-none-match': String(res.headers.etag),
    });
    expect(again.statusCode).toBe(304);
  });

  test('anonymous and wrong-token requests get what an anonymous lease gets', async () => {
    await withImages();
    const anonLease = await app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: proto,
      payload: { freeSlots: 1 },
    });
    const anon = await get(urlOf(img.name, img.digest));
    expect(anon.statusCode).toBe(anonLease.statusCode);
    expect(anon.json()).toEqual(anonLease.json());
    expect((await get(urlOf(img.name, img.digest), bearer('bogus'))).statusCode).toBe(
      (await lease('bogus')).statusCode,
    );
    // And without the protocol header, as every stick route.
    expect((await get(urlOf(img.name, img.digest), {})).statusCode).toBe(426);
  });

  test('a digest the lock does not list is 404, as is a malformed reference', async () => {
    const { stickToken } = await withImages();
    const other = await get(urlOf(img.name, `sha256:${'0'.repeat(64)}`), bearer(stickToken));
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: 'not in the image lock' });
    for (const ref of ['jumpmaster-trooper:latest', '..%2F..%2Fetc@sha256:00', 'x'])
      expect(
        (await get(`/api/sticks/images/${ref}/oci.tar?platform=linux/amd64`, bearer(stickToken)))
          .statusCode,
        ref,
      ).toBe(404);
  });

  test('an image not mirrored yet is 404 with its state; an unknown platform is 404', async () => {
    const { stickToken } = await withImages();
    const res = await get(urlOf(pending.name, pending.digest), bearer(stickToken));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not mirrored', state: 'pending' });
    const plat = await get(urlOf(img.name, img.digest, 'linux/s390x'), bearer(stickToken));
    expect(plat.statusCode).toBe(404);
    expect(plat.json()).toEqual({ error: 'unknown platform' });
    expect(
      (await get(urlOf(img.name, img.digest).replace(/\?.*$/, ''), bearer(stickToken))).statusCode,
    ).toBe(400);
  });

  test('a server without a mirror answers 404 for every image', async () => {
    fake = await startFakeRegistry();
    setup();
    const { stickToken } = await enroll();
    const res = await get(
      urlOf('jumpmaster-trooper', `sha256:${'1'.repeat(64)}`),
      bearer(stickToken),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not in the image lock' });
  });

  test('a server with an image lock announces image-mirror-v1; without one it does not (issue #141)', async () => {
    const { stickToken } = await withImages();
    const res = await lease(stickToken);
    expect(String(res.headers[FEATURES_HEADER]).split(',')).toEqual([
      'push-v1',
      IMAGE_MIRROR_FEATURE,
    ]);
    await app.close();
    setup({ queued: false });
    const plain = await enroll();
    expect((await lease(plain.stickToken)).headers[FEATURES_HEADER]).toBe('push-v1');
    // A mirror with no lock (a server run from a checkout) has nothing to serve: not announced.
    await app.close();
    const none = new ImageMirror({
      dataDir: mkdtempSync(join(tmpdir(), 'jm-route-')),
      scrub: new ScrubSet(),
      log: () => {},
    });
    none.setLock(undefined);
    setup({ queued: false, images: none });
    const nolock = await enroll();
    expect((await lease(nolock.stickToken)).headers[FEATURES_HEADER]).toBe('push-v1');
  });
});

describe('image download progress on the lease (issue #141)', () => {
  const ref = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
  const leaseWith = (token: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: bearer(token),
      payload: { freeSlots: 0, capabilities: ['push-v1'], ...extra },
    });

  test('a lease carrying imageFetch records it for the stick; null clears it', async () => {
    const fetches = new StickFetches();
    setup({ queued: false, fetches });
    const { stickId, stickToken } = await enroll();
    expect(fetches.get(stickId, t0)).toBeUndefined();
    const res = await leaseWith(stickToken, { imageFetch: { ref, done: 5, total: 10 } });
    expect(res.statusCode).toBe(204);
    expect(fetches.get(stickId, t0)).toEqual({ ref, done: 5, total: 10 });
    // A lease without the field (an older stick, or nothing new) leaves it.
    await leaseWith(stickToken, {});
    expect(fetches.get(stickId, t0)).toEqual({ ref, done: 5, total: 10 });
    await leaseWith(stickToken, { imageFetch: null });
    expect(fetches.get(stickId, t0)).toBeUndefined();
  });

  test('malformed progress is a 400, like any malformed lease', async () => {
    const fetches = new StickFetches();
    setup({ queued: false, fetches });
    const { stickId, stickToken } = await enroll();
    const res = await leaseWith(stickToken, { imageFetch: { ref, done: -1, total: 10 } });
    expect(res.statusCode).toBe(400);
    expect(fetches.get(stickId, t0)).toBeUndefined();
  });
});

describe('a stick starting up reports it on the lease (issue #157)', () => {
  const image = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
  const leaseWith = (token: string, extra: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/sticks/lease',
      headers: bearer(token),
      payload: { freeSlots: 0, capabilities: [], ...extra },
    });

  test('a lease carrying starting records it and marks the stick seen; null clears it', async () => {
    const fetches = new StickFetches();
    const { db } = setup({ queued: false, fetches });
    const { stickId, stickToken } = await enroll();
    expect(fetches.starting(stickId, t0)).toBeUndefined();
    const res = await leaseWith(stickToken, { starting: { image } });
    expect(res.statusCode).toBe(204);
    expect(fetches.starting(stickId, t0)).toEqual({ image });
    expect(getStick(db, stickId)?.lastSeenAt).not.toBeNull();
    // A lease without the field leaves it; a download report is separate.
    await leaseWith(stickToken, {});
    expect(fetches.starting(stickId, t0)).toEqual({ image });
    expect(fetches.get(stickId, t0)).toBeUndefined();
    await leaseWith(stickToken, { starting: null });
    expect(fetches.starting(stickId, t0)).toBeUndefined();
  });

  test('a malformed starting report is a 400', async () => {
    const fetches = new StickFetches();
    setup({ queued: false, fetches });
    const { stickId, stickToken } = await enroll();
    const res = await leaseWith(stickToken, { starting: { image: '' } });
    expect(res.statusCode).toBe(400);
    expect(fetches.starting(stickId, t0)).toBeUndefined();
  });
});
