/**
 * The per-drop reviewer read token in app mode (issue #237, spec §4.2, §4.4): a review, crew or
 * doctor drop of an app-reviewer zone clones with a reviewer `contents: read` token minted for it
 * alone, narrowed to the zone's repository, held in memory and revoked when the drop ends.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { DropPayload } from '@jumpmaster/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import type { Config, DropZoneConfig } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  type Drop,
  getDrop,
  insertDrop,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { createAppTokenSource } from '../forge/app-tokens.js';
import { createHeldDropTokens, type HeldDropTokens } from '../forge/held-tokens.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { expireLeases } from '../leases.js';
import { buildPayload } from '../payloads.js';
import { scrub } from '../scrub.js';
import { fakeForge } from '../test/fakes.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import type { AppEntryRead } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { registerControlRoutes } from './control.js';
import { registerStickRoutes } from './sticks.js';

const api = 'https://api.github.com';
const HOUR = 3_600_000;
const SHA = 'b'.repeat(40);
const INSTALLATION = 88;
const REPOSITORY = 6660;
const OPERATOR = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';

const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

// Built at runtime so no token-shaped literal sits in the tracked file.
const tokenOf = (n: number) => ['ghs', `READTOK${String(n).padStart(4, '0')}`.repeat(4)].join('_');
const READ_PAT = ['github', 'pat', 'READPATREADPATREADPAT99'].join('_');

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
} as DropZoneConfig;

const appZone = {
  ...baseZone,
  identity: 'two-bot',
  githubApp: {
    repositoryId: REPOSITORY,
    installations: { author: 11, reviewer: INSTALLATION },
  },
} as DropZoneConfig;

const configWith = (zone: DropZoneConfig, read: boolean): Config =>
  ({
    listen: { host: '127.0.0.1', port: 7420, allowedHosts: [HOST] },
    dataDir: '/data',
    pollSeconds: 60,
    dropZones: [zone],
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    secrets: {
      claudeToken: 'claude-secret',
      githubAuthorToken: 'gh-author-pat',
      githubReviewerToken: 'gh-reviewer-pat',
      ...(read ? { githubReadToken: READ_PAT } : {}),
      joinToken: 'join-me',
      operatorToken: OPERATOR,
    },
  }) as Config;

const reviewerEntry: AppEntryRead = {
  source: 'vault',
  fingerprint: 'fp-r',
  entry: { appId: '43', slug: 'jm-reviewer', clientId: 'c', pem: KEY, importedAt: '2026-11-01' },
};
const withReviewerApp: ResolvedApps = new Map([
  ['octo', { author: { source: 'missing' }, reviewer: reviewerEntry }],
]);

interface Call {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

/** A recording fake GitHub: the installation lookup, mints per `state.mint`, revokes per `state.revoke`. */
function fakeGitHub() {
  const calls: Call[] = [];
  const minted: string[] = [];
  const state = { mint: 201, revoke: 204 };
  const record = async (req: Request) => {
    const text = await req.text();
    calls.push({
      method: req.method,
      path: new URL(req.url).pathname,
      authorization: req.headers.get('authorization') ?? '',
      body: text ? JSON.parse(text) : undefined,
    });
  };
  nock(api)
    .persist()
    .get('/repos/octo/demo/installation')
    .reply(async (req: Request) => {
      await record(req);
      return [200, { id: INSTALLATION, permissions: { contents: 'read' } }];
    })
    .post(/^\/app\/installations\/\d+\/access_tokens$/)
    .reply(async (req: Request) => {
      await record(req);
      if (state.mint !== 201) return [state.mint, { message: 'boom' }];
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
    mints: () => calls.filter((c) => c.path.endsWith('/access_tokens')),
    revokes: () => calls.filter((c) => c.method === 'DELETE'),
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

type Role = 'review' | 'refute' | 'doctor';

function setup(o: { zone?: DropZoneConfig; apps?: ResolvedApps; read?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 'Add widget',
    body: 'Please add a widget.',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  const apps = o.apps ?? withReviewerApp;
  const config = configWith(o.zone ?? appZone, o.read ?? false);
  const forge = fakeForge({ issues: [], trusted: [] });
  const held = createHeldDropTokens({ log: (line) => logs.push(line) });
  const deps = {
    db,
    config,
    log: (line: string) => logs.push(line),
    forgesFor: () => ({ author: forge, reviewer: forge }),
    now: () => t0,
    leaseWaitMs: 60,
    leasePollMs: 10,
    resolvedApps: () => apps,
    appTokens: createAppTokenSource({
      resolvedApps: () => apps,
      zones: () => config.dropZones,
      now: () => t0.getTime(),
      add: (s) => serverScrubSet.add(s),
    }),
    heldReadTokens: held,
  };
  app = Fastify();
  // As createApp mounts them: the guard, the stick routes, the control routes.
  registerGuard(app, deps);
  registerStickRoutes(app, deps);
  registerControlRoutes(app, deps);
  return { db, held, config };
}

function queue(db: Db, id: string, role: Role) {
  insertDrop(db, {
    id,
    dropZoneId: 'main',
    workItemId: role === 'review' ? 1 : null,
    role,
    state: 'queued',
    createdAt: t0.toISOString(),
    ...(role === 'review' ? { prNumber: 3, headSha: SHA } : {}),
    ...(role === 'refute'
      ? { inputJson: JSON.stringify({ work: { role: 'refute', crewIssueId: 1 }, input: 'x' }) }
      : {}),
  });
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

const lease = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: bearer(token),
    payload: { freeSlots: 1, capabilities: ['push-v1'] },
  });

/** The token a payload clones with: `forgeToken` (review, crew) or `readToken` (doctor). */
const cloneToken = (p: DropPayload): string | undefined => {
  const c = p.credentials as { forgeToken?: string; readToken?: string };
  return c.forgeToken ?? c.readToken;
};

async function leased(db: Db, role: Role, id = 'd1') {
  const { stickToken } = await enroll();
  queue(db, id, role);
  const res = await lease(stickToken);
  expect(res.statusCode).toBe(200);
  return { stickToken, res, payload: res.json() as DropPayload };
}

const dump = (db: Db, table: string) =>
  JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());

describe('the lease of an app-reviewer zone', () => {
  for (const [role, field] of [
    ['review', 'forgeToken'],
    ['refute', 'forgeToken'],
    ['doctor', 'readToken'],
  ] as const) {
    test(`a ${role} drop carries a freshly minted contents: read token as ${field}`, async () => {
      const { db } = setup();
      const { payload } = await leased(db, role);
      expect(gh.mints()).toHaveLength(1);
      const [m] = gh.mints();
      expect(m?.path).toBe(`/app/installations/${INSTALLATION}/access_tokens`);
      expect(m?.body).toEqual({
        repository_ids: [REPOSITORY],
        permissions: { contents: 'read' },
      });
      expect((payload.credentials as Record<string, unknown>)[field]).toBe(gh.minted[0]);
    });
  }

  test('with githubReadToken and reviewReadToken also set, the payload has the minted token, not the PAT', async () => {
    const { db } = setup({ read: true, zone: { ...appZone, reviewReadToken: true } });
    const { res, payload } = await leased(db, 'review');
    expect(cloneToken(payload)).toBe(gh.minted[0]);
    expect(res.body).not.toContain(READ_PAT);
  });

  test('two drops get two mints and two different tokens, none from the cache', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    queue(db, 'd1', 'review');
    queue(db, 'd2', 'doctor');
    const a = (await lease(stickToken)).json() as DropPayload;
    const b = (await lease(stickToken)).json() as DropPayload;
    expect(gh.mints()).toHaveLength(2);
    expect(cloneToken(a)).toBe(gh.minted[0]);
    expect(cloneToken(b)).toBe(gh.minted[1]);
    expect(cloneToken(a)).not.toBe(cloneToken(b));
  });

  test('the minted token is in the scrub set and held for the drop', async () => {
    const { db, held } = setup();
    const { payload } = await leased(db, 'review');
    const token = cloneToken(payload)!;
    expect(serverScrubSet.values()).toContain(token);
    expect(scrub(`cloned with ${token}`)).not.toContain(token);
    expect(held.holds(token)).toBe(true);
  });

  test('an implement drop mints nothing', async () => {
    const { db } = setup();
    const { stickToken } = await enroll();
    insertDrop(db, {
      id: 'i1',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'queued',
      createdAt: t0.toISOString(),
    });
    expect((await lease(stickToken)).statusCode).toBe(200);
    expect(gh.calls).toEqual([]);
  });
});

describe('PAT zones are as before', () => {
  const cases: [string, DropZoneConfig, ResolvedApps][] = [
    ['a PAT zone', { ...baseZone, reviewReadToken: true }, new Map()],
    [
      'a zone whose reviewer is a PAT',
      { ...appZone, reviewReadToken: true },
      new Map([['octo', { author: reviewerEntry, reviewer: { source: 'missing' } }]]),
    ],
  ];
  for (const [name, zone, apps] of cases) {
    for (const role of ['review', 'refute', 'doctor'] as const) {
      test(`${name}: the ${role} payload deep-equals buildPayload without app deps`, async () => {
        const { db, config } = setup({ zone, apps, read: true });
        const { payload } = await leased(db, role);
        const drop = getDrop(db, 'd1') as Drop;
        const expected = buildPayload(db, zone, drop, config.secrets, { now: t0 });
        expect(payload).toEqual(JSON.parse(JSON.stringify(expected)));
        expect(cloneToken(payload)).toBe(READ_PAT);
        expect(gh.calls).toEqual([]);
      });
    }
  }
});

describe('a mint failure', () => {
  test('requeues the drop with no stick, answers 503 mint failed, logs no secret, and never falls back to the PAT', async () => {
    const { db } = setup({ read: true, zone: { ...appZone, reviewReadToken: true } });
    const { stickToken } = await enroll();
    queue(db, 'd1', 'review');
    gh.state.mint = 500;
    const res = await lease(stickToken);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ refused: 'mint failed', retryable: true });
    expect(res.body).not.toContain(READ_PAT);
    expect(getDrop(db, 'd1')).toMatchObject({
      state: 'queued',
      stickId: null,
      leaseExpiresAt: null,
    });
    expect(logs.some((l) => l.includes('d1') && l.includes('HTTP 500'))).toBe(true);
    for (const line of [...logs, ...consoleLines]) {
      expect(line).not.toMatch(/eyJ|BEGIN|ghs_/);
      expect(line).not.toContain(READ_PAT);
    }
    // The next lease mints again.
    gh.state.mint = 201;
    const again = await lease(stickToken);
    expect(again.statusCode).toBe(200);
    expect(cloneToken(again.json() as DropPayload)).toBe(gh.minted[0]);
  });
});

describe('revoking the read token when the drop ends', () => {
  const revoked = async (token: string) => {
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    expect(gh.revokes()[0]?.authorization).toBe(`Bearer ${token}`);
  };

  test('an accepted result revokes it', async () => {
    const { db, held } = setup();
    const { stickToken, payload } = await leased(db, 'review');
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result: { status: 'failed', role: 'review', gates: [], reason: 'x' } },
    });
    expect(res.statusCode).toBe(204);
    await revoked(cloneToken(payload)!);
    expect(held.size()).toBe(0);
  });

  test('lease expiry through expireLeases and the sweep revokes it', async () => {
    const { db, held } = setup();
    const { payload } = await leased(db, 'doctor');
    held.sweep(db);
    // Still leased: nothing goes.
    await new Promise((r) => setTimeout(r, 20));
    expect(gh.revokes()).toHaveLength(0);
    expect(expireLeases(db, plus(t0, 24 * HOUR))).toBe(1);
    held.sweep(db);
    await revoked(cloneToken(payload)!);
  });

  test('a cancel revokes it at the next sweep', async () => {
    const { db, held } = setup();
    const { payload } = await leased(db, 'refute');
    updateDrop(db, 'd1', { state: 'cancelled', finishedAt: t0.toISOString() });
    held.sweep(db);
    await revoked(cloneToken(payload)!);
  });

  test('engaging the kill switch revokes it', async () => {
    const { db } = setup();
    const { payload } = await leased(db, 'review');
    const res = await app.inject({
      method: 'POST',
      url: '/api/control/kill',
      headers: { authorization: `Bearer ${OPERATOR}`, host: HOST },
      payload: { engaged: true },
    });
    expect(res.statusCode).toBe(200);
    expect(getDrop(db, 'd1')?.state).toBe('cancelled');
    await revoked(cloneToken(payload)!);
  });

  test('a revoke that fails is logged without the token', async () => {
    const { db } = setup();
    const { stickToken, payload } = await leased(db, 'review');
    gh.state.revoke = 500;
    await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result: { status: 'failed', role: 'review', gates: [], reason: 'x' } },
    });
    await vi.waitFor(() =>
      expect(logs.some((l) => l.includes('expires in the hour') && l.includes('HTTP 500'))).toBe(
        true,
      ),
    );
    for (const line of [...logs, ...consoleLines]) expect(line).not.toContain(cloneToken(payload)!);
  });
});

describe('secrets', () => {
  test('after a full lease, events and result cycle no table, audit row, event or log holds the token', async () => {
    const { db } = setup();
    const { stickToken, payload } = await leased(db, 'review');
    const token = cloneToken(payload)!;
    const events = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/events',
      headers: bearer(stickToken),
      payload: {
        epoch: 1,
        events: [{ ts: t0.toISOString(), kind: 'log', data: { line: 'cloning' } }],
      },
    });
    expect(events.statusCode).toBe(204);
    const res = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(stickToken),
      payload: { epoch: 1, result: { status: 'failed', role: 'review', gates: [], reason: 'x' } },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).not.toContain(token);
    await vi.waitFor(() => expect(gh.revokes()).toHaveLength(1));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['drops', 'drop_events']));
    for (const { name } of tables) expect(dump(db, name), name).not.toContain(token);
    expect(JSON.stringify(listAudit(db))).not.toContain(token);
    for (const line of [...logs, ...consoleLines]) expect(line).not.toContain(token);
    expect(serverScrubSet.values()).toContain(token);
  });
});
