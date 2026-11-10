import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { SetupMode, setupActive } from '../auth/operator.js';
import type { Config } from '../config.js';
import { openDb } from '../db/open.js';
import {
  getAttempts,
  getDrop,
  getOutbox,
  getPullRequest,
  getStickByTokenHash,
  getUsageState,
  insertDrop,
  listEvents,
  setUsageState,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { buildPayload, promptVersions } from '../payloads.js';
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
    config?: Config;
    logs?: string[];
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
  });
  return { db, forge, wi, forgeZones };
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
    await lease(stickToken);
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
    const res2 = await leaseWith(capable.stickToken, { capabilities: ['egress-v1'] });
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
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(204);
    expect(skippedOf(res)).toEqual([{ zoneId: 'locked', missing: ['egress-v1'] }]);
    expect(getDrop(db, 'x1')).toMatchObject({ state: 'queued', stickId: null, epoch: 0 });
  });

  test('a stick with allowlist policy skips drops of a zone needing signed images', async () => {
    const { db } = setup({ queued: false, config: twoZones({ requireSignedImages: true }) });
    lockedDrop(db);
    const { stickToken } = await enroll();
    const caps = ['egress-v1', 'image-verify-v1'];
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

  test('with no zone needing a capability, an M3 stick still leases', async () => {
    // The reference zone: image set, egress and signed images left at their defaults.
    setup({ config: { ...config, requireSignedImages: false } });
    const { stickToken } = await enroll();
    const res = await lease(stickToken); // body { freeSlots } only, as an M3 stick sends
    expect(res.statusCode).toBe(200);
    expect((res.json() as { dropId: string }).dropId).toBe('d1');
    expect(skippedOf(res)).toBeUndefined();
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
      payload: { freeSlots: 1 },
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
