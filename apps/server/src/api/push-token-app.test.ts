/**
 * Push tokens in app mode (issue #224, spec §4.2 and §13 Task 5): a contents: write token minted
 * per push, narrowed to the zone's repository, held in memory only and revoked on the result.
 */
import { generateKeyPairSync } from 'node:crypto';
import { PushGrantSchema } from '@jumpmaster/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { listAudit } from '../auth/audit.js';
import type { Config, DropZoneConfig } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  insertDrop,
  setWorkItemState,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { type AppBrokers, createAppBrokers } from '../forge/app-brokers.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { scrub } from '../scrub.js';
import { fakeForge } from '../test/fakes.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import type { AppEntryRead } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { registerStickRoutes } from './sticks.js';

const api = 'https://api.github.com';
const HOUR = 3_600_000;
const SHA_A = 'a'.repeat(40);
const INSTALLATION = 77;
const REPOSITORY = 5550;

const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

// Built at runtime so no token-shaped literal sits in the tracked file.
const tokenOf = (n: number) => ['ghs', `PUSHTOK${String(n).padStart(4, '0')}`.repeat(4)].join('_');
const b64 = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');

const AUTHOR_PAT = 'gh-author-pat-secret';

const baseZone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
  image: 'jm-trooper:test',
  model: 'claude-opus-5-5',
  maxTurns: 200,
  models: {},
  protectedPaths: [],
  privateKeyPaths: [],
  securityPaths: [],
  reviewReadToken: false,
  budgets: {
    maxHeal: 3,
    maxResolve: 2,
    maxResolveTotal: 6,
    maxResume: 2,
    maxReviewRepeat: 2,
    maxNoChange: 1,
    maxBaseSync: 12,
  },
  ciRequired: true,
  ciDeadlineMinutes: 45,
  retryLabel: 'agent-retry',
  mergeMethod: 'squash',
  requireBranchProtection: true,
  services: [],
  verification: [],
  limits: { pids: 512 },
} as DropZoneConfig;

const appZone = {
  ...baseZone,
  identity: 'two-bot',
  githubApp: { repositoryId: REPOSITORY, installations: { author: INSTALLATION } },
} as DropZoneConfig;

const configWith = (zone: DropZoneConfig, read = true): Config =>
  ({
    listen: { host: '127.0.0.1', port: 7420 },
    dataDir: '/data',
    pollSeconds: 60,
    dropZones: [zone],
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    secrets: {
      claudeToken: 'claude-secret',
      githubAuthorToken: AUTHOR_PAT,
      githubReviewerToken: 'gh-reviewer',
      ...(read ? { githubReadToken: 'gh-read-secret' } : {}),
      joinToken: 'join-me',
      operatorToken: 'o'.repeat(32),
    },
  }) as Config;

const authorEntry: AppEntryRead = {
  source: 'vault',
  fingerprint: 'fp-1',
  entry: { appId: '42', slug: 'jm-author', clientId: 'c', pem: KEY, importedAt: '2026-11-01' },
};
const missing: AppEntryRead = { source: 'missing' };
const withAuthorApp: ResolvedApps = new Map([['octo', { author: authorEntry, reviewer: missing }]]);
const undecryptable: ResolvedApps = new Map([
  ['octo', { author: { source: 'missing', undecryptable: true }, reviewer: missing }],
]);

interface Call {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

/** A recording fake GitHub: mints answer per `state.mint`, revokes per `state.revoke`. */
function fakeGitHub() {
  const calls: Call[] = [];
  const minted: string[] = [];
  /** The metadata-only tokens the installation check minted (issue #267). */
  const probes: string[] = [];
  const state = {
    /** What GitHub says of octo/demo: its installation (or 404, or a network error) and its id. */
    installation: INSTALLATION as number | 404 | 'network',
    repositoryId: REPOSITORY,
    mint: 'ok' as 'ok' | '500' | 'network',
    revoke: 204,
    /** When set, each mint waits for it before answering. */
    gate: undefined as Promise<void> | undefined,
  };
  const record = async (req: Request) => {
    const text = await req.text();
    calls.push({
      method: req.method,
      path: new URL(req.url).pathname,
      authorization: req.headers.get('authorization') ?? '',
      body: text ? JSON.parse(text) : undefined,
    });
  };
  const scope = nock(api).persist();
  scope
    .get('/repos/octo/demo/installation')
    .reply(async (req: Request) => {
      await record(req);
      if (state.installation === 'network') throw new Error('connect ETIMEDOUT');
      if (state.installation === 404) return [404, { message: 'Not Found' }];
      return [200, { id: state.installation, permissions: {} }];
    })
    .get('/repos/octo/demo')
    .reply(async (req: Request) => {
      await record(req);
      return [200, { id: state.repositoryId }];
    })
    .post(/^\/app\/installations\/\d+\/access_tokens$/)
    .reply(async (req: Request) => {
      await record(req);
      if ('repositories' in (calls.at(-1)!.body as object)) {
        const probe = ['ghs', `PROBE${String(probes.length + 1).padStart(4, '0')}`.repeat(4)].join(
          '_',
        );
        probes.push(probe);
        return [201, { token: probe, expires_at: plus(t0, HOUR).toISOString() }];
      }
      if (state.gate) await state.gate;
      if (state.mint === 'network') throw new Error('connect ECONNREFUSED');
      if (state.mint === '500') return [500, { message: 'boom' }];
      const token = tokenOf(minted.length + 1);
      minted.push(token);
      return [201, { token, expires_at: plus(t0, HOUR).toISOString() }];
    })
    .delete('/installation/token')
    .reply(async (req: Request) => {
      await record(req);
      return [state.revoke, state.revoke === 204 ? '' : { message: 'nope' }];
    });
  return {
    calls,
    minted,
    state,
    probes,
    /** The push mints (narrowed by repository id; the check's probe is narrowed by name). */
    mints: () =>
      calls.filter(
        (c) => c.path.endsWith('/access_tokens') && !('repositories' in (c.body as object)),
      ),
    anyMint: () => calls.filter((c) => c.path.endsWith('/access_tokens')),
    lookups: () => calls.filter((c) => c.path.endsWith('/installation')),
    revokes: () =>
      calls.filter(
        (c) => c.method === 'DELETE' && !probes.includes(c.authorization.slice('Bearer '.length)),
      ),
  };
}

const proto = { 'x-jumpmaster-protocol': '1' };
const bearer = (token: string) => ({ ...proto, authorization: `Bearer ${token}` });

let app: FastifyInstance;
let gh: ReturnType<typeof fakeGitHub>;
const logs: string[] = [];
const consoleLines: string[] = [];

beforeAll(() => {
  nock.disableNetConnect();
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      consoleLines.push(a.map(String).join(' '));
    });
});
afterAll(() => {
  vi.restoreAllMocks();
  nock.enableNetConnect();
});
beforeEach(() => {
  nock.cleanAll();
  gh = fakeGitHub();
  logs.length = 0;
  consoleLines.length = 0;
  serverScrubSet.clear();
});
afterEach(() => app.close());

function setup(o: {
  zone?: DropZoneConfig;
  apps?: ResolvedApps;
  brokers?: AppBrokers | 'none';
  read?: boolean;
}) {
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
  const apps = o.apps ?? withAuthorApp;
  const forge = fakeForge({ issues: [], trusted: [] });
  app = Fastify();
  const brokers =
    o.brokers === 'none'
      ? {
          brokerFor: () => undefined,
          verifiedInstallation: () => Promise.reject(new Error('no broker')),
        }
      : (o.brokers ?? createAppBrokers({ apps: () => apps }));
  registerStickRoutes(app, {
    db,
    config: configWith(o.zone ?? appZone, o.read ?? true),
    log: (line) => logs.push(line),
    forgesFor: () => ({ author: forge, reviewer: forge }),
    now: () => t0,
    leaseWaitMs: 60,
    leasePollMs: 10,
    appBrokers: brokers,
    resolvedApps: () => apps,
  });
  return { db };
}

async function enroll() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: proto,
    payload: { joinToken: 'join-me', name: 'stick-1', slots: 4 },
  });
  return res.json() as { stickId: string; stickToken: string };
}

function pending(db: Db, stickId: string, kind: 'final' | 'checkpoint' = 'final') {
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'main',
    workItemId: 1,
    role: 'implement',
    state: 'queued',
    createdAt: t0.toISOString(),
  });
  updateDrop(db, 'd1', {
    state: 'push_pending',
    stickId,
    epoch: 1,
    pushKind: kind,
    pushExpectSha: kind === 'final' ? SHA_A : null,
    pushDeadline: plus(t0, 24 * HOUR).toISOString(),
    resultJson: JSON.stringify({
      status: 'completed',
      role: 'implement',
      headSha: SHA_A,
      gates: [],
    }),
    usageApplied: 1,
    runningAt: t0.toISOString(),
    finishedAt: t0.toISOString(),
  });
}

const post = (url: string, token: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, headers: bearer(token), payload });
const grant = (token: string) => post('/api/sticks/push-token', token, { dropId: 'd1', epoch: 1 });
const plan = (token: string) => post('/api/sticks/push-plan', token, { dropId: 'd1', epoch: 1 });
const salvage = (token: string) => post('/api/sticks/salvage', token, { dropId: 'd1', epoch: 1 });
const pushResult = (token: string, result: Record<string, unknown>) =>
  post('/api/drops/d1/push-result', token, { epoch: 1, result });

const liveGrants = (db: Db): number =>
  (
    db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE revoked_at IS NULL').get() as {
      n: number;
    }
  ).n;

const dump = (db: Db, table: string) =>
  JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());

async function granted(db: Db) {
  const { stickId, stickToken } = await enroll();
  pending(db, stickId);
  const res = await grant(stickToken);
  expect(res.statusCode).toBe(200);
  return { stickToken, g: PushGrantSchema.parse((res.json() as { grant: unknown }).grant) };
}

describe('push-token in PAT mode', () => {
  test('a starter zone gets the PAT grant and audits credential: pat', async () => {
    const starter = { ...baseZone, identity: 'starter' } as DropZoneConfig;
    const { db } = setup({ zone: starter });
    const { g } = await granted(db);
    expect(g.token).toBe(AUTHOR_PAT);
    expect(g.secrets).toContain(AUTHOR_PAT);
    expect(g.secrets).toContain('gh-read-secret');
    expect(gh.calls).toHaveLength(0);
    const row = listAudit(db).find((a) => a.action === 'push-token');
    expect(row?.detail).toEqual({ drop: 'd1', epoch: 1, kind: 'final', credential: 'pat' });
  });

  test('a two-bot zone without an author app gets the PAT grant', async () => {
    const { db } = setup({
      zone: { ...baseZone, identity: 'two-bot' } as DropZoneConfig,
      apps: new Map(),
    });
    const { g } = await granted(db);
    expect(g.token).toBe(AUTHOR_PAT);
    expect(gh.calls).toHaveLength(0);
    expect(listAudit(db).find((a) => a.action === 'push-token')?.detail).toMatchObject({
      credential: 'pat',
    });
  });
});

describe('push-token in app mode', () => {
  test('mints a contents: write token for the recorded installation and repository', async () => {
    const { db } = setup({});
    const { g } = await granted(db);
    expect(gh.mints()).toHaveLength(1);
    const [m] = gh.mints();
    expect(m?.path).toBe(`/app/installations/${INSTALLATION}/access_tokens`);
    expect(m?.body).toEqual({ repository_ids: [REPOSITORY], permissions: { contents: 'write' } });
    expect(m?.authorization).toMatch(/^Bearer eyJ/);
    expect(g.token).toBe(gh.minted[0]);
  });

  test("the grant's secrets hold the minted token, not the author PAT when a read token is set", async () => {
    const { db } = setup({});
    const { g } = await granted(db);
    const token = gh.minted[0]!;
    expect(g.secrets).toContain(token);
    expect(g.secrets).toContain(b64(token));
    expect(g.secrets).toContain('gh-read-secret');
    expect(g.secrets).not.toContain(AUTHOR_PAT);
    expect(g.secrets).not.toContain(b64(AUTHOR_PAT));
  });

  test('audits credential: app with ids only', async () => {
    const { db } = setup({});
    await granted(db);
    const row = listAudit(db).find((a) => a.action === 'push-token');
    expect(row?.detail).toEqual({ drop: 'd1', epoch: 1, kind: 'final', credential: 'app' });
  });

  test('the minted token is in the scrub set before the grant is sent', async () => {
    const { db } = setup({});
    const { g } = await granted(db);
    expect(serverScrubSet.values()).toContain(g.token);
    expect(scrub(`pushed with ${g.token}`)).not.toContain(g.token);
  });

  test('two concurrent requests produce one mint', async () => {
    const { db } = setup({});
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const [a, b] = await Promise.all([grant(stickToken), grant(stickToken)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(gh.mints()).toHaveLength(1);
  });

  const refusals: [string, () => ReturnType<typeof setup>][] = [
    ['an undecryptable entry', () => setup({ apps: undecryptable })],
    [
      'a missing author installation',
      () =>
        setup({
          zone: {
            ...appZone,
            githubApp: { repositoryId: REPOSITORY, installations: {} },
          } as DropZoneConfig,
        }),
    ],
    ['no broker', () => setup({ brokers: 'none' })],
  ];
  for (const [name, make] of refusals) {
    test(`${name} is a retryable refusal that never falls back to the PAT`, async () => {
      const { db } = make();
      const { stickId, stickToken } = await enroll();
      pending(db, stickId);
      const res = await grant(stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'app unavailable', retryable: true });
      expect(res.body).not.toContain(AUTHOR_PAT);
      expect(gh.mints()).toHaveLength(0);
      expect(liveGrants(db)).toBe(0);
      // The reservation is released: a later request reserves again (and is refused the same way).
      expect((await grant(stickToken)).statusCode).toBe(403);
    });
  }

  for (const failure of ['500', 'network'] as const) {
    test(`a mint ${failure} answers a retryable 503 and a retry reserves and mints`, async () => {
      const { db } = setup({});
      const { stickId, stickToken } = await enroll();
      pending(db, stickId);
      gh.state.mint = failure;
      const res = await grant(stickToken);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ refused: 'mint failed', retryable: true });
      expect(res.body).not.toContain(AUTHOR_PAT);
      expect(res.body).not.toMatch(/eyJ|BEGIN|ghs_/);
      for (const line of [...logs, ...consoleLines]) expect(line).not.toMatch(/eyJ|BEGIN|ghs_/);
      expect(liveGrants(db)).toBe(0);
      const minted = db.prepare('SELECT minted_at AS m FROM push_tokens').all() as { m: unknown }[];
      expect(minted.every((r) => r.m === null)).toBe(true);

      gh.state.mint = 'ok';
      const again = await grant(stickToken);
      expect(again.statusCode).toBe(200);
      expect(PushGrantSchema.parse(again.json().grant).token).toBe(gh.minted[0]);
    });
  }
});

describe('push-token: the installation check (issue #267)', () => {
  test('a recorded repository id GitHub does not give octo/demo is refused, and no push token is minted', async () => {
    const { db } = setup({});
    gh.state.repositoryId = 9999;
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'app unverified', retryable: true });
    expect(res.body).not.toContain(AUTHOR_PAT);
    expect(gh.mints()).toEqual([]);
    expect(liveGrants(db)).toBe(0);
    expect(
      logs.some((l) =>
        l.includes('main: the recorded author repository id does not match octo/demo'),
      ),
    ).toBe(true);
  });

  test('a recorded installation id GitHub does not give octo/demo is refused before any token is minted', async () => {
    const { db } = setup({});
    gh.state.installation = 78;
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'app unverified', retryable: true });
    expect(gh.anyMint()).toEqual([]);
  });

  test('an app not installed on octo/demo is refused before any token is minted', async () => {
    const { db } = setup({});
    gh.state.installation = 404;
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    expect((await grant(stickToken)).statusCode).toBe(403);
    expect(gh.anyMint()).toEqual([]);
  });

  test('a check that cannot run is a retryable 503 with no mint; the retry checks again and mints', async () => {
    const { db } = setup({});
    gh.state.installation = 'network';
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    const res = await grant(stickToken);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ refused: 'app unverified', retryable: true });
    expect(gh.anyMint()).toEqual([]);
    expect(liveGrants(db)).toBe(0);
    gh.state.installation = INSTALLATION;
    const again = await grant(stickToken);
    expect(again.statusCode).toBe(200);
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints()).toHaveLength(1);
  });

  test('a second grant for the verified zone does not check again', async () => {
    const { db } = setup({});
    const { stickToken } = await granted(db);
    expect((await plan(stickToken)).statusCode).toBe(200);
    expect((await grant(stickToken)).statusCode).toBe(200);
    expect(gh.lookups()).toHaveLength(1);
    expect(gh.mints()).toHaveLength(2);
  });
});

describe('revoking the push token', () => {
  test('a reservation released while the mint is in flight revokes the fresh token', async () => {
    const { db } = setup({});
    const { stickId, stickToken } = await enroll();
    pending(db, stickId);
    let open = () => {};
    gh.state.gate = new Promise<void>((r) => {
      open = r;
    });
    const inFlight = grant(stickToken);
    await vi.waitFor(() => expect(gh.mints()).toHaveLength(1));
    expect((await plan(stickToken)).statusCode).toBe(200);
    open();
    const res = await inFlight;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ refused: 'mint failed', retryable: true });
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    expect(gh.revokes()[0]?.authorization).toBe(`Bearer ${gh.minted[0]}`);
  });

  test('push-result revokes the held token exactly once', async () => {
    const { db } = setup({});
    const { stickToken, g } = await granted(db);
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_A,
      alreadyThere: false,
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    expect(gh.revokes()[0]?.authorization).toBe(`Bearer ${g.token}`);
    // A repeat finds nothing held.
    await pushResult(stickToken, { status: 'pushed', headSha: SHA_A, alreadyThere: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(gh.revokes()).toHaveLength(1);
  });

  test('a later push-plan revokes a leftover token', async () => {
    const { db } = setup({});
    const { stickToken, g } = await granted(db);
    expect((await plan(stickToken)).statusCode).toBe(200);
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    expect(gh.revokes()[0]?.authorization).toBe(`Bearer ${g.token}`);
  });

  test('salvage revokes a leftover token', async () => {
    const { db } = setup({});
    const { stickToken, g } = await granted(db);
    expect((await salvage(stickToken)).statusCode).toBe(200);
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    expect(gh.revokes()[0]?.authorization).toBe(`Bearer ${g.token}`);
  });

  test("a revoke that fails doesn't change the route's answer, and is logged without the token", async () => {
    const { db } = setup({});
    const { stickToken, g } = await granted(db);
    gh.state.revoke = 500;
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_A,
      alreadyThere: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: expect.any(String) });
    await vi.waitFor(() => expect(logs.some((l) => l.includes('revok'))).toBe(true));
    for (const line of logs) expect(line).not.toContain(g.token);
  });

  test('a full cycle leaves the token in no log, audit row or push_tokens row', async () => {
    const { db } = setup({});
    const { stickToken, g } = await granted(db);
    const res = await pushResult(stickToken, {
      status: 'pushed',
      headSha: SHA_A,
      alreadyThere: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(g.token);
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    for (const line of [...logs, ...consoleLines]) expect(line).not.toContain(g.token);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain('push_tokens');
    for (const { name } of tables) expect(dump(db, name), name).not.toContain(g.token);
    expect(JSON.stringify(listAudit(db))).not.toContain(g.token);
    expect(serverScrubSet.values()).toContain(g.token);
    expect(scrub(`token ${g.token}`)).not.toContain(g.token);
  });
});
