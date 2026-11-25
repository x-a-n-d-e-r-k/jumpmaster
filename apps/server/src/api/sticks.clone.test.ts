import { CloneGrantSchema, ClonePlanSchema, gitlabBasicAuthAs } from '@jumpmaster/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import type { Config, DropZoneConfig } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  appendEvents,
  insertDrop,
  markCloneMinted,
  reserveCloneGrant,
  reserveGrant,
  revokeCloneGrants,
  setKilled,
  setWorkItemState,
  setZoneMode,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { expireLeases } from '../leases.js';
import { fakeForge } from '../test/fakes.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import type { GitlabPats, ResolvedGitlabPats } from '../vault/resolution.js';
import { CLONE_MAX_BYTES, registerStickRoutes } from './sticks.js';

/**
 * The clone container's stick routes (#840): `clone-plan` and `clone-token` for a GitLab drop.
 * Every token is split after its prefix (the push check refuses a whole token-shaped literal), and
 * its `username:token` and basic-auth forms are built at run time.
 */

const AUTHOR = 'glpat-' + 'AuthorPlantedValue0001';
const REVIEWER = 'glpat-' + 'ReviewerPlantedValue02';
const READ_USER = 'gitlab+deploy-token-7';
const READ_TOKEN = 'gldt-' + 'ReadPlantedValue000003';
const READ_FORMS = [
  READ_TOKEN,
  `${READ_USER}:${READ_TOKEN}`,
  gitlabBasicAuthAs(READ_USER, READ_TOKEN),
];
const ALL_TOKENS = [AUTHOR, REVIEWER, ...READ_FORMS];

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
};

const gitlabZone = (over: Partial<DropZoneConfig> = {}): DropZoneConfig => ({
  ...baseZone,
  forge: 'gitlab',
  gitlab: { baseUrl: 'https://gitlab.example.com' },
  ...over,
});

const configWith = (zone: DropZoneConfig): Config => ({
  listen: { host: '127.0.0.1', port: 7420 },
  dataDir: '/data',
  pollSeconds: 60,
  dropZones: [zone],
  usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
  secrets: {
    claudeToken: 'claude-secret',
    githubAuthorToken: 'gh-secret',
    githubReviewerToken: 'gh-reviewer',
    joinToken: 'join-me',
    operatorToken: 'o'.repeat(32),
  },
});

const proto = { 'x-jumpmaster-protocol': '1' };
const bearer = (token: string) => ({ ...proto, authorization: `Bearer ${token}` });

let app: FastifyInstance;
afterEach(() => app.close());

type World = { db: Db; logs: string[]; stickId: string; stickToken: string };

async function setup(
  o: { zone?: DropZoneConfig; pats?: GitlabPats | null; state?: 'leased' | 'running' } = {},
): Promise<World> {
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
  const logs: string[] = [];
  const pats = o.pats === undefined ? { author: AUTHOR, reviewer: REVIEWER } : o.pats;
  const forge = fakeForge({ issues: [], trusted: [] });
  app = Fastify();
  registerStickRoutes(app, {
    db,
    config: configWith(o.zone ?? gitlabZone()),
    log: (line) => logs.push(line),
    forgesFor: () => ({ author: forge, reviewer: forge }),
    now: () => t0,
    ...(pats ? { resolvedGitlabPats: (): ResolvedGitlabPats => new Map([['main', pats]]) } : {}),
  });
  const enrolled = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: proto,
    payload: { joinToken: 'join-me', name: 'stick-1', slots: 4 },
  });
  const { stickId, stickToken } = enrolled.json() as { stickId: string; stickToken: string };
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'main',
    workItemId: wi.id,
    role: 'implement',
    state: 'queued',
    createdAt: t0.toISOString(),
  });
  updateDrop(db, 'd1', {
    state: o.state ?? 'leased',
    stickId,
    epoch: 1,
    leaseExpiresAt: plus(t0, 60_000).toISOString(),
    startedAt: t0.toISOString(),
  });
  return { db, logs, stickId, stickToken };
}

const call = (route: 'clone-plan' | 'clone-token', token: string, dropId = 'd1', epoch = 1) =>
  app.inject({
    method: 'POST',
    url: `/api/sticks/${route}`,
    headers: bearer(token),
    payload: { dropId, epoch },
  });
const plan = (token: string, dropId?: string, epoch?: number) =>
  call('clone-plan', token, dropId, epoch);
const grant = (token: string, dropId?: string, epoch?: number) =>
  call('clone-token', token, dropId, epoch);

type Row = { epoch: number; seq: number; minted: string | null; revoked: string | null };
const rows = (db: Db): Row[] =>
  db
    .prepare(
      `SELECT epoch, seq, minted_at AS minted, revoked_at AS revoked FROM clone_grants
       WHERE drop_id = 'd1' ORDER BY seq`,
    )
    .all() as Row[];
const liveGrants = (db: Db) => rows(db).filter((r) => r.revoked === null).length;
const pushTokens = (db: Db) =>
  (db.prepare('SELECT COUNT(*) AS n FROM push_tokens').get() as { n: number }).n;

/** Asserts no token, in any form, is in `text`. */
const holdsNoToken = (text: string) => {
  for (const t of ALL_TOKENS) expect(text).not.toContain(t);
};

describe('clone-plan (#840)', () => {
  test('a GitLab zone without egress: the remote, limits and maxBytes, no egress', async () => {
    const w = await setup();
    const res = await plan(w.stickToken);
    expect(res.statusCode).toBe(200);
    const p = ClonePlanSchema.parse(res.json());
    expect(p).toEqual({
      forge: { kind: 'gitlab', origin: 'https://gitlab.example.com', projectPath: 'octo/demo' },
      limits: { pids: 512 },
      maxBytes: CLONE_MAX_BYTES,
    });
    // Room under the stick's 10 GiB free-space floor.
    expect(CLONE_MAX_BYTES).toBeLessThan(10 * 1024 ** 3);
    holdsNoToken(res.body + w.logs.join('\n'));
  });

  test.each(['enforce', 'monitor'] as const)(
    'a GitLab zone under %s egress allows only its GitLab host',
    async (mode) => {
      const w = await setup({
        zone: gitlabZone({
          gitlab: { baseUrl: 'https://GitLab.Example.com/' },
          egress: { mode, allow: ['registry.npmjs.org', '*.example.com'] },
        }),
      });
      const res = await plan(w.stickToken);
      expect(res.statusCode).toBe(200);
      const p = ClonePlanSchema.parse(res.json());
      expect(p.egress).toEqual({ mode, allow: ['gitlab.example.com'] });
      expect(p.forge.origin).toBe('https://gitlab.example.com');
    },
  );

  test('a GitLab host outside egress is refused as egress, retryable, revoking nothing', async () => {
    const w = await setup({
      zone: gitlabZone({ egress: { mode: 'enforce', allow: ['other.example.org'] } }),
    });
    w.db
      .prepare(`INSERT INTO clone_grants (drop_id, epoch, seq, reserved_at) VALUES ('d1', 1, 1, ?)`)
      .run(t0.toISOString());
    const res = await plan(w.stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'egress', retryable: true });
    expect(w.logs.join('\n')).toMatch(/clone of drop d1 refused.*gitlab\.example\.com/);
    expect(liveGrants(w.db)).toBe(1);
  });

  test("a GitHub zone's plan is refused as forge", async () => {
    const w = await setup({ zone: baseZone });
    const res = await plan(w.stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'forge', retryable: false });
  });

  test('a wrong stick, an old epoch and a push_pending drop are stale', async () => {
    const w = await setup();
    const other = await app.inject({
      method: 'POST',
      url: '/api/sticks/enroll',
      headers: proto,
      payload: { joinToken: 'join-me', name: 'stick-2', slots: 1 },
    });
    expect((await plan(other.json().stickToken)).statusCode).toBe(409);
    expect((await plan(w.stickToken, 'd1', 0)).statusCode).toBe(409);
    updateDrop(w.db, 'd1', { state: 'push_pending' });
    const res = await plan(w.stickToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'stale' });
  });
});

describe('clone-token (#840)', () => {
  test('with the read entry: the deploy token and its username', async () => {
    const w = await setup({
      pats: {
        author: AUTHOR,
        reviewer: REVIEWER,
        read: { username: READ_USER, token: READ_TOKEN },
      },
    });
    expect((await plan(w.stickToken)).statusCode).toBe(200);
    const res = await grant(w.stickToken);
    expect(res.statusCode).toBe(200);
    const g = CloneGrantSchema.parse(res.json().grant);
    expect(g.token).toBe(READ_TOKEN);
    expect(g.username).toBe(READ_USER);
    expect(g.forge).toEqual({
      kind: 'gitlab',
      origin: 'https://gitlab.example.com',
      projectPath: 'octo/demo',
    });
    expect([...g.secrets].sort()).toEqual([...ALL_TOKENS].sort());
    expect(new Set(g.secrets).size).toBe(g.secrets.length);
    expect(rows(w.db)).toEqual([{ epoch: 1, seq: 1, minted: t0.toISOString(), revoked: null }]);
    const audit = listAudit(w.db).filter((a) => a.action === 'clone-token');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      via: 'system',
      target: 'd1',
      detail: { drop: 'd1', epoch: 1, credential: 'read' },
    });
    holdsNoToken(JSON.stringify(listAudit(w.db)) + w.logs.join('\n'));
    expect(pushTokens(w.db)).toBe(0);
  });

  test('without the read entry: the author token and no username', async () => {
    const w = await setup();
    const res = await grant(w.stickToken);
    expect(res.statusCode).toBe(200);
    const g = CloneGrantSchema.parse(res.json().grant);
    expect(g.token).toBe(AUTHOR);
    expect(g.username).toBeUndefined();
    expect([...g.secrets].sort()).toEqual([AUTHOR, REVIEWER].sort());
    const audit = listAudit(w.db).filter((a) => a.action === 'clone-token');
    expect(audit[0]?.detail).toEqual({ drop: 'd1', epoch: 1, credential: 'author' });
    holdsNoToken(JSON.stringify(listAudit(w.db)) + w.logs.join('\n'));
  });

  test.each([
    ['no entry resolves', {}],
    ['the dep is absent', null],
    ['only the reviewer resolves', { reviewer: REVIEWER }],
  ] as const)('refused as gitlab token when %s, the reservation revoked', async (_, pats) => {
    const w = await setup({ pats });
    const res = await grant(w.stickToken);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'gitlab token', retryable: false });
    expect(rows(w.db)).toHaveLength(1);
    expect(liveGrants(w.db)).toBe(0);
    expect(rows(w.db)[0]?.minted).toBeNull();
    holdsNoToken(res.body + JSON.stringify(listAudit(w.db)) + w.logs.join('\n'));
  });

  test('a running drop is granted as a leased one is', async () => {
    const w = await setup({ state: 'running' });
    expect((await grant(w.stickToken)).statusCode).toBe(200);
  });

  describe('every grant rule refuses', () => {
    test('a wrong stick: stale', async () => {
      const w = await setup();
      const other = await app.inject({
        method: 'POST',
        url: '/api/sticks/enroll',
        headers: proto,
        payload: { joinToken: 'join-me', name: 'stick-2', slots: 1 },
      });
      const res = await grant(other.json().stickToken);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'stale' });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('an old epoch: stale', async () => {
      const w = await setup();
      const res = await grant(w.stickToken, 'd1', 0);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'stale' });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('a drop whose result was posted: stale', async () => {
      const w = await setup({ state: 'running' });
      const posted = await app.inject({
        method: 'POST',
        url: '/api/drops/d1/result',
        headers: bearer(w.stickToken),
        payload: { epoch: 1, result: { status: 'failed', reason: 'x', gates: [] } },
      });
      expect(posted.statusCode).toBe(204);
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'stale' });
    });

    test('a live drop with a result recorded: started', async () => {
      const w = await setup({ state: 'running' });
      updateDrop(w.db, 'd1', { resultJson: '{}' });
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'started', retryable: false });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('a GitHub zone: forge', async () => {
      const w = await setup({ zone: baseZone });
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'forge', retryable: false });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('the kill switch: killed', async () => {
      const w = await setup();
      setKilled(w.db, true, t0);
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'killed', retryable: true });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('an observing zone: zone observe', async () => {
      const w = await setup();
      setZoneMode(w.db, 'main', 'observe', t0);
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'zone observe', retryable: true });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('a changed repository: repo mismatch', async () => {
      const w = await setup();
      w.db.prepare('UPDATE drop_zones SET repo = ?').run('octo/other');
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'repo mismatch', retryable: false });
      expect(rows(w.db)).toHaveLength(0);
    });

    test('a second request without a new plan: reserved', async () => {
      const w = await setup();
      expect((await grant(w.stickToken)).statusCode).toBe(200);
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ refused: 'reserved', retryable: true });
      holdsNoToken(res.body);
      expect(rows(w.db)).toHaveLength(1);
    });

    test('a drop that has an event: started', async () => {
      const w = await setup({ state: 'running' });
      appendEvents(w.db, 'd1', [{ ts: t0.toISOString(), kind: 'log', data: { message: 'hi' } }]);
      const res = await grant(w.stickToken);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ refused: 'started', retryable: false });
      expect(rows(w.db)).toHaveLength(0);
    });
  });

  test('a clone-plan after a lost clone-token reply lets the retry succeed', async () => {
    const w = await setup();
    expect((await plan(w.stickToken)).statusCode).toBe(200);
    expect((await grant(w.stickToken)).statusCode).toBe(200);
    // The reply was lost: the stick starts over with a new plan.
    expect((await grant(w.stickToken)).statusCode).toBe(409);
    const again = await plan(w.stickToken);
    expect(again.statusCode).toBe(200);
    holdsNoToken(again.body);
    const res = await grant(w.stickToken);
    expect(res.statusCode).toBe(200);
    expect(CloneGrantSchema.parse(res.json().grant).token).toBe(AUTHOR);
    const r = rows(w.db);
    expect(r).toHaveLength(2);
    expect(r[0]?.revoked).not.toBeNull();
    expect(r[1]).toMatchObject({ seq: 2, revoked: null, minted: t0.toISOString() });
  });
});

describe('clone grant bookkeeping (#840)', () => {
  test("posting the drop's result revokes its live clone grant", async () => {
    const w = await setup({ state: 'running' });
    expect((await grant(w.stickToken)).statusCode).toBe(200);
    const posted = await app.inject({
      method: 'POST',
      url: '/api/drops/d1/result',
      headers: bearer(w.stickToken),
      payload: { epoch: 1, result: { status: 'failed', reason: 'x', gates: [] } },
    });
    expect(posted.statusCode).toBe(204);
    expect(rows(w.db)[0]?.revoked).toBe(t0.toISOString());
    expect(liveGrants(w.db)).toBe(0);
  });

  test("expiring the drop's lease revokes its live clone grant", async () => {
    const w = await setup({ state: 'running' });
    expect((await grant(w.stickToken)).statusCode).toBe(200);
    const later = plus(t0, 10 * 60_000);
    expect(expireLeases(w.db, later)).toBe(1);
    expect(rows(w.db)[0]?.revoked).toBe(later.toISOString());
    expect(pushTokens(w.db)).toBe(0);
  });
});

test('the clone grant helpers never touch push_tokens, nor the push ones clone_grants', async () => {
  const w = await setup();
  expect(reserveGrant(w.db, 'd1', 1, t0)).toBe('ok');
  const pushRow = () => w.db.prepare('SELECT * FROM push_tokens').all();
  const before = pushRow();
  expect(reserveCloneGrant(w.db, 'd1', 1, t0)).toBe('ok');
  expect(reserveCloneGrant(w.db, 'd1', 1, t0)).toBe('reserved');
  markCloneMinted(w.db, 'd1', 1, t0);
  revokeCloneGrants(w.db, 'd1', t0);
  expect(pushRow()).toEqual(before);
  expect(rows(w.db)).toEqual([
    { epoch: 1, seq: 1, minted: t0.toISOString(), revoked: t0.toISOString() },
  ]);
});
