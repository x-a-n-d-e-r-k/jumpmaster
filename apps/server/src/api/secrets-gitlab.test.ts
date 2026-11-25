/**
 * A GitLab zone's `gitlab-pat/<zone>/<role>` tokens in the credential routes (issue #776, spec §9):
 * set, test and remove, and the list's `gitlabPats`. Tested against the fake GitLab only; no
 * answer, audit row or log line carries a token.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { gitlabBasicAuthAs } from '@jumpmaster/protocol';
import Fastify, { type FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore, VAULT_DISABLED } from '../config/store.js';
import { openDb } from '../db/open.js';
import { upsertDropZone } from '../db/repo.js';
import type { DoctorCheck } from '../doctor/checks.js';
import { fakeGitLab } from '../test/fake-gitlab.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  GITLAB_PAT_FORBIDDEN,
  GITLAB_PAT_REJECTED,
  GITLAB_PAT_UNREACHABLE,
  GITLAB_READ_BAD_VALUE,
  GITLAB_READ_REJECTED,
} from '../vault/gitlab-pat-entries.js';
import { fingerprintOf, openVault, type Vault } from '../vault/vault.js';
import { type ControlDeps, registerControlRoutes } from './control.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };
const BASE = 'https://gitlab.example.test';
// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const AUTHOR = glpat('A');
const REVIEWER = glpat('R');
const WRONG = glpat('W');
const NOSCOPE = glpat('N');
const LEFTOVER = glpat('L');
const D_USER = 'gitlab+deploy-token-42';
const D_TOKEN = ['gldt', 'D'.repeat(20)].join('-');
const D_VALUE = `${D_USER}:${D_TOKEN}`;
const D_BASIC = gitlabBasicAuthAs(D_USER, D_TOKEN);
const D_WRONG_TOKEN = ['gldt', 'X'.repeat(20)].join('-');
const D_WRONG = `${D_USER}:${D_WRONG_TOKEN}`;
const ALL = [
  AUTHOR,
  REVIEWER,
  WRONG,
  NOSCOPE,
  LEFTOVER,
  D_TOKEN,
  D_VALUE,
  D_BASIC,
  D_WRONG_TOKEN,
  D_WRONG,
  gitlabBasicAuthAs(D_USER, D_WRONG_TOKEN),
];

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());

let app: FastifyInstance | undefined;
afterEach(async () => {
  nock.cleanAll();
  await app?.close();
  app = undefined;
});

/**
 * Four zones: `gl` (GitLab, two-bot), `solo` (GitLab, starter), `far` (GitLab on an instance
 * nothing answers for) and `web` (GitHub). The fake GitLab knows the author, the reviewer, a
 * token without a read scope; any other token is refused.
 */
function world(o: { vaultOff?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-gitlab-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const vault = openVault(keyFile, db) as Vault;
  const clock = { now: t0 };
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, undefined),
    env: { JM_JOIN_TOKEN: 'join-secret-value-4', JM_OPERATOR_TOKEN: TOKEN },
    vault: o.vaultOff ? 'disabled' : vault,
    now: () => clock.now,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const zone = (id: string, repo: string, extra: object = {}) => ({
    id,
    repo,
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'jm-trooper:dev',
    ...extra,
  });
  const gitlab = (baseUrl: string) => ({ forge: 'gitlab', gitlab: { baseUrl } });
  const zones = [
    zone('gl', 'acme/widgets', gitlab(BASE)),
    zone('solo', 'acme/solo', { ...gitlab(BASE), identity: 'starter', ciRequired: true }),
    zone('far', 'acme/far', gitlab('https://gitlab-far.example.test')),
    zone('web', 'octo/web'),
  ];
  const applied = store.apply(
    { dropZones: zones },
    { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
  );
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  for (const z of zones)
    upsertDropZone(db, { id: z.id, repo: z.repo, defaultBranch: 'main', configJson: '{}' });
  const fake = fakeGitLab({ baseUrl: BASE, project: { id: 7, path: 'acme/widgets' } });
  fake.addUser({ username: 'gl-author-bot', token: AUTHOR, scopes: ['read_user'] });
  fake.addUser({ username: 'gl-reviewer-bot', token: REVIEWER, scopes: ['api'] });
  fake.addUser({ username: 'gl-noscope-bot', token: NOSCOPE, scopes: ['write_repository'] });
  const logs: string[] = [];
  const deps: ControlDeps = {
    db,
    config: store,
    now: () => clock.now,
    log: (l) => logs.push(l),
    forgesFor: () => {
      throw new Error('no forge in this test');
    },
    doctor: async (): Promise<DoctorCheck[]> => [],
    doctorEnv: { uid: 1000, inContainer: true, uidMap: null },
  };
  const a = Fastify({
    logger: {
      level: 'trace',
      stream: new Writable({
        write(chunk, _enc, cb) {
          logs.push(String(chunk));
          cb();
        },
      }),
    },
  });
  registerGuard(a, deps);
  registerControlRoutes(a, deps);
  app = a;
  const session = operatorSession(db);
  return { db, store, vault, clock, logs, fake, asSession: { ...session.headers, host: HOST } };
}

const inject = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  headers: Record<string, string> = auth,
) =>
  (app as FastifyInstance).inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });
const at = (zone: string, role: string) => `/api/control/secrets/gitlab-pat/${zone}/${role}`;
const put = (zone: string, role: string, value: string, headers?: Record<string, string>) =>
  inject('PUT', at(zone, role), { value }, headers);
const testRoute = (zone: string, role: string, headers?: Record<string, string>) =>
  inject('POST', `${at(zone, role)}/test`, {}, headers);
const remove = (zone: string, role: string, headers?: Record<string, string>) =>
  inject('DELETE', at(zone, role), undefined, headers);
const list = () => inject('GET', '/api/control/secrets');

/**
 * The reply bodies, the audit rows and the log, with no token in any of them. `typedInUrl`: the
 * caller put a token in the URL itself, which Fastify's own `incoming request` line logs as sent;
 * those lines are left out, every other line is checked.
 */
function expectNoTokens(
  w: ReturnType<typeof world>,
  bodies: string[],
  o: { typedInUrl?: boolean } = {},
) {
  const logs = o.typedInUrl ? w.logs.filter((l) => !l.includes('"incoming request"')) : w.logs;
  const text = `${bodies.join('\n')}\n${JSON.stringify(listAudit(w.db))}\n${logs.join('\n')}`;
  for (const t of ALL) expect(text.includes(t)).toBe(false);
}

const missing = (w: ReturnType<typeof world>) =>
  w.store
    .problems()
    .filter((p) => p.kind === 'missing')
    .map((p) => p.credential);

describe('PUT /api/control/secrets/gitlab-pat/:zone/:role (issue #776)', () => {
  test('a token GitLab accepts is stored, resolved and clears its missing problem', async () => {
    const w = world();
    expect(missing(w)).toContain('gitlab-pat/gl/author');
    const r = await put('gl', 'author', AUTHOR);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      name: 'gitlab-pat/gl/author',
      tested: true,
      login: 'gl-author-bot',
      fingerprint: fingerprintOf(AUTHOR),
      setAt: t0.toISOString(),
    });
    expect(w.store.resolvedGitlabPats().get('gl')).toEqual({ author: AUTHOR });
    expect(missing(w)).not.toContain('gitlab-pat/gl/author');
    expect(missing(w)).toContain('gitlab-pat/gl/reviewer');
    expect(w.vault.meta('gitlab-pat/gl/author')).toMatchObject({
      testResult: 'ok',
      login: 'gl-author-bot',
    });
    // The reviewer of a two-bot zone, too.
    const rv = await put('gl', 'reviewer', REVIEWER);
    expect(rv.statusCode).toBe(200);
    expect(w.store.resolvedGitlabPats().get('gl')).toEqual({ author: AUTHOR, reviewer: REVIEWER });
    expect(missing(w)).not.toContain('gitlab-pat/gl/reviewer');
    const rows = listAudit(w.db).filter((a) => a.action === 'secret.set');
    expect(rows.map((a) => a.detail)).toEqual([
      { name: 'gitlab-pat/gl/reviewer', fingerprint: fingerprintOf(REVIEWER), result: 'stored' },
      { name: 'gitlab-pat/gl/author', fingerprint: fingerprintOf(AUTHOR), result: 'stored' },
    ]);
    expectNoTokens(w, [r.body, rv.body]);
  });

  test('a token whose test fails (401, 403, unreachable) answers 422 and stores nothing', async () => {
    const w = world();
    await put('gl', 'author', AUTHOR);
    const before = w.vault.snapshot('gitlab-pat/gl/author');
    const cases = [
      ['gl', WRONG, 401, GITLAB_PAT_REJECTED],
      ['gl', NOSCOPE, 403, GITLAB_PAT_FORBIDDEN],
      ['far', AUTHOR, null, GITLAB_PAT_UNREACHABLE],
    ] as const;
    const bodies: string[] = [];
    for (const [zone, value, status, problem] of cases) {
      const r = await put(zone, 'author', value);
      bodies.push(r.body);
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ tested: false, status, problem, error: problem });
    }
    expect(w.vault.snapshot('gitlab-pat/gl/author')).toEqual(before);
    expect(w.vault.meta('gitlab-pat/far/author')).toBeUndefined();
    expect(w.store.resolvedGitlabPats().get('gl')).toEqual({ author: AUTHOR });
    const failed = listAudit(w.db)
      .filter((a) => a.action === 'secret.set' && String(a.detail?.result).startsWith('test'))
      .map((a) => a.detail);
    expect(failed).toEqual([
      {
        name: 'gitlab-pat/far/author',
        fingerprint: fingerprintOf(AUTHOR),
        result: 'test failed (no answer)',
      },
      {
        name: 'gitlab-pat/gl/author',
        fingerprint: fingerprintOf(NOSCOPE),
        result: 'test failed (403)',
      },
      {
        name: 'gitlab-pat/gl/author',
        fingerprint: fingerprintOf(WRONG),
        result: 'test failed (401)',
      },
    ]);
    expectNoTokens(w, bodies);
  });

  test('refused with the vault off (409), a value with whitespace (400) and for a starter zone reviewer (409)', async () => {
    const off = world({ vaultOff: true });
    const r = await put('gl', 'author', AUTHOR);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: VAULT_DISABLED });
    expect(off.fake.requests).toHaveLength(0);
    await app?.close();

    const w = world();
    const spaced = await put('gl', 'author', `${AUTHOR} x`);
    expect(spaced.statusCode).toBe(400);
    expect(spaced.body).not.toContain(AUTHOR);
    const bad = await inject('PUT', at('gl', 'author'), { value: AUTHOR, extra: 1 });
    expect(bad.statusCode).toBe(400);
    const starter = await put('solo', 'reviewer', REVIEWER);
    expect(starter.statusCode).toBe(409);
    expect(starter.json()).toEqual({ error: 'a starter project has no reviewer token' });
    expect(w.vault.meta('gitlab-pat/solo/reviewer')).toBeUndefined();
    expect(w.vault.meta('gitlab-pat/gl/author')).toBeUndefined();
    expect(w.fake.requests).toHaveLength(0);
    expectNoTokens(w, [spaced.body, bad.body, starter.body]);
  });
});

describe('POST /api/control/secrets/gitlab-pat/:zone/:role/test (issue #776)', () => {
  test('a stored token that passes: tested true and the login, recorded in the vault and audited', async () => {
    const w = world();
    await put('gl', 'author', AUTHOR);
    w.clock.now = plus(t0, 60_000);
    const r = await testRoute('gl', 'author');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tested: true, result: 'ok', login: 'gl-author-bot' });
    expect(w.vault.meta('gitlab-pat/gl/author')).toMatchObject({
      testedAt: plus(t0, 60_000).toISOString(),
      testResult: 'ok',
    });
    expect(listAudit(w.db).find((a) => a.action === 'secret.test')?.detail).toEqual({
      name: 'gitlab-pat/gl/author',
      fingerprint: fingerprintOf(AUTHOR),
      result: 'ok',
    });
    expectNoTokens(w, [r.body]);
  });

  test('401, 403 and unreachable: tested false with the GITLAB_PAT_* problem, recorded', async () => {
    const w = world();
    // Stored straight into the vault: the PUT would refuse these.
    w.vault.put('gitlab-pat/gl/author', WRONG, { now: t0 });
    w.vault.put('gitlab-pat/gl/reviewer', NOSCOPE, { now: t0 });
    w.store.refreshSecrets();
    const bodies: string[] = [];
    const rejected = await testRoute('gl', 'author');
    bodies.push(rejected.body);
    expect(rejected.json()).toEqual({
      tested: false,
      status: 401,
      problem: GITLAB_PAT_REJECTED,
      error: GITLAB_PAT_REJECTED,
    });
    expect(w.vault.meta('gitlab-pat/gl/author')?.testResult).toBe('failed (401)');
    const forbidden = await testRoute('gl', 'reviewer');
    bodies.push(forbidden.body);
    expect(forbidden.json()).toMatchObject({
      tested: false,
      status: 403,
      problem: GITLAB_PAT_FORBIDDEN,
    });
    expect(w.vault.meta('gitlab-pat/gl/reviewer')?.testResult).toBe('failed (403)');
    // GitLab goes away.
    nock.cleanAll();
    const down = await testRoute('gl', 'author');
    bodies.push(down.body);
    expect(down.json()).toMatchObject({
      tested: false,
      status: null,
      problem: GITLAB_PAT_UNREACHABLE,
    });
    expect(w.vault.meta('gitlab-pat/gl/author')?.testResult).toBe('failed (no answer)');
    expect(
      listAudit(w.db)
        .filter((a) => a.action === 'secret.test')
        .map((a) => a.detail?.result),
    ).toEqual(['failed (no answer)', 'failed (403)', 'failed (401)']);
    expectNoTokens(w, bodies);
  });

  test('409 when the entry is not set, for a starter zone reviewer, and with the vault off', async () => {
    const w = world();
    const r = await testRoute('gl', 'author');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'the token is not set' });
    w.vault.put('gitlab-pat/solo/reviewer', LEFTOVER, { now: t0 });
    const starter = await testRoute('solo', 'reviewer');
    expect(starter.statusCode).toBe(409);
    expect(starter.json()).toEqual({ error: 'a starter project has no reviewer token' });
    expect(w.fake.requests).toHaveLength(0);
    await app?.close();
    world({ vaultOff: true });
    const off = await testRoute('gl', 'author');
    expect(off.statusCode).toBe(409);
    expect(off.json()).toEqual({ error: VAULT_DISABLED });
  });
});

describe('DELETE /api/control/secrets/gitlab-pat/:zone/:role (issue #776)', () => {
  test('refused while the zone needs it: the author of any GitLab zone, the reviewer of a two-bot zone', async () => {
    const w = world();
    await put('gl', 'author', AUTHOR);
    await put('gl', 'reviewer', REVIEWER);
    await put('solo', 'author', AUTHOR);
    const bodies: string[] = [];
    for (const [zone, role] of [
      ['gl', 'author'],
      ['gl', 'reviewer'],
      ['solo', 'author'],
    ] as const) {
      const r = await remove(zone, role);
      bodies.push(r.body);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe(
        `zones need gitlab-pat/${zone}/${role}: removing it would park them`,
      );
      expect(w.vault.meta(`gitlab-pat/${zone}/${role}`)).toBeDefined();
    }
    expect(w.store.resolvedGitlabPats().get('gl')).toEqual({ author: AUTHOR, reviewer: REVIEWER });
    expectNoTokens(w, bodies);
  });

  test("removes a starter zone's leftover reviewer entry, audited; 409 once no entry exists", async () => {
    const w = world();
    w.vault.put('gitlab-pat/solo/reviewer', LEFTOVER, { now: t0 });
    const r = await remove('solo', 'reviewer');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, name: 'gitlab-pat/solo/reviewer' });
    expect(w.vault.meta('gitlab-pat/solo/reviewer')).toBeUndefined();
    expect(listAudit(w.db).find((a) => a.action === 'secret.remove')?.detail).toEqual({
      name: 'gitlab-pat/solo/reviewer',
      fingerprint: fingerprintOf(LEFTOVER),
      result: 'removed',
    });
    const again = await remove('solo', 'reviewer');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'the vault holds no such token' });
    expect((await remove('gl', 'author')).statusCode).toBe(409);
    expectNoTokens(w, [r.body, again.body]);
  });

  test('409 with the vault off', async () => {
    world({ vaultOff: true });
    const r = await remove('solo', 'reviewer');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: VAULT_DISABLED });
  });
});

describe('GET /api/control/secrets lists gitlabPats (issue #776)', () => {
  test('a two-bot zone lists both roles; a starter zone its author, and its reviewer only when the vault keeps one', async () => {
    const w = world();
    await put('gl', 'author', AUTHOR);
    const first = await list();
    expect(first.statusCode).toBe(200);
    expect(first.json().gitlabPats).toEqual([
      {
        zone: 'gl',
        role: 'author',
        name: 'gitlab-pat/gl/author',
        set: true,
        fingerprint: fingerprintOf(AUTHOR),
        setAt: t0.toISOString(),
        testedAt: t0.toISOString(),
        testResult: 'ok',
      },
      { zone: 'gl', role: 'reviewer', name: 'gitlab-pat/gl/reviewer', set: false },
      { zone: 'solo', role: 'author', name: 'gitlab-pat/solo/author', set: false },
      { zone: 'far', role: 'author', name: 'gitlab-pat/far/author', set: false },
      { zone: 'far', role: 'reviewer', name: 'gitlab-pat/far/reviewer', set: false },
    ]);
    // A reviewer entry left from two-bot mode.
    w.vault.put('gitlab-pat/solo/reviewer', LEFTOVER, { now: t0 });
    const second = await list();
    expect(second.json().gitlabPats.filter((p: { zone: string }) => p.zone === 'solo')).toEqual([
      { zone: 'solo', role: 'author', name: 'gitlab-pat/solo/author', set: false },
      {
        zone: 'solo',
        role: 'reviewer',
        name: 'gitlab-pat/solo/reviewer',
        set: true,
        fingerprint: fingerprintOf(LEFTOVER),
        setAt: t0.toISOString(),
      },
    ]);
    expect(JSON.stringify(second.json().gitlabPats)).not.toContain('"value"');
    expectNoTokens(w, [first.body, second.body]);
  });
});

/**
 * The smart-HTTP probe `testGitlabReadEntry` sends for `project`, matched on the basic auth of
 * `value`: 200 with the upload-pack advertisement for `D_VALUE`, 401 for any other value.
 */
function infoRefs(project: string, value = D_VALUE) {
  const [user = '', token = ''] = value.split(':');
  const probe = nock(BASE, {
    reqheaders: { authorization: `Basic ${gitlabBasicAuthAs(user, token)}` },
  })
    .get(`/${project}.git/info/refs`)
    .query({ service: 'git-upload-pack' });
  return value === D_VALUE
    ? probe.reply(200, '', { 'content-type': 'application/x-git-upload-pack-advertisement' })
    : probe.reply(401, 'HTTP Basic: Access denied');
}

describe('the read deploy token gitlab-pat/:zone/read (issue #866)', () => {
  test('set ok: tested, stored, resolved, audited with the fingerprint of <username>:<token>', async () => {
    const w = world();
    const probe = infoRefs('acme/widgets');
    const r = await put('gl', 'read', D_VALUE);
    expect(r.statusCode).toBe(200);
    expect(probe.isDone()).toBe(true);
    expect(r.json()).toMatchObject({
      name: 'gitlab-pat/gl/read',
      fingerprint: fingerprintOf(D_VALUE),
      tested: true,
      setAt: t0.toISOString(),
    });
    expect(w.store.resolvedGitlabPats().get('gl')?.read).toEqual({
      username: D_USER,
      token: D_TOKEN,
    });
    expect(w.vault.meta('gitlab-pat/gl/read')).toMatchObject({
      fingerprint: fingerprintOf(D_VALUE),
      createdAt: t0.toISOString(),
      testedAt: t0.toISOString(),
      testResult: 'ok',
    });
    expect(listAudit(w.db).find((a) => a.action === 'secret.set')?.detail).toEqual({
      name: 'gitlab-pat/gl/read',
      fingerprint: fingerprintOf(D_VALUE),
      result: 'stored',
    });
    expect(w.fake.requests).toHaveLength(0);
    expectNoTokens(w, [r.body]);
  });

  test('set in a starter zone is accepted', async () => {
    const w = world();
    infoRefs('acme/solo');
    const r = await put('solo', 'read', D_VALUE);
    expect(r.statusCode).toBe(200);
    expect(w.store.resolvedGitlabPats().get('solo')?.read).toEqual({
      username: D_USER,
      token: D_TOKEN,
    });
    expectNoTokens(w, [r.body]);
  });

  test('a malformed value: 400 GITLAB_READ_BAD_VALUE; whitespace: 400 with the whitespace text; nothing sent or stored', async () => {
    const w = world();
    const bodies: string[] = [];
    for (const v of [D_TOKEN, `${D_USER}:`, `:${D_TOKEN}`]) {
      const r = await put('gl', 'read', v);
      bodies.push(r.body);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: GITLAB_READ_BAD_VALUE });
    }
    const spaced = await put('gl', 'read', `${D_USER}: ${D_TOKEN}`);
    bodies.push(spaced.body);
    expect(spaced.statusCode).toBe(400);
    expect(spaced.json()).toEqual({ error: 'a credential is one line with no whitespace' });
    expect(w.vault.meta('gitlab-pat/gl/read')).toBeUndefined();
    expectNoTokens(w, bodies);
  });

  test('GitLab answers 401: 422 with the problem, nothing stored, the failure audited', async () => {
    const w = world();
    const probe = infoRefs('acme/widgets', D_WRONG);
    const r = await put('gl', 'read', D_WRONG);
    expect(probe.isDone()).toBe(true);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toEqual({
      tested: false,
      status: 401,
      problem: GITLAB_READ_REJECTED,
      error: GITLAB_READ_REJECTED,
    });
    expect(w.vault.meta('gitlab-pat/gl/read')).toBeUndefined();
    expect(w.store.resolvedGitlabPats().get('gl')?.read).toBeUndefined();
    expect(listAudit(w.db).find((a) => a.action === 'secret.set')?.detail).toEqual({
      name: 'gitlab-pat/gl/read',
      fingerprint: fingerprintOf(D_WRONG),
      result: 'test failed (401)',
    });
    expectNoTokens(w, [r.body]);
  });

  test('test ok, and a failed test recorded, both audited', async () => {
    const w = world();
    infoRefs('acme/widgets');
    await put('gl', 'read', D_VALUE);
    w.clock.now = plus(t0, 60_000);
    const probe = infoRefs('acme/widgets');
    const r = await testRoute('gl', 'read');
    expect(probe.isDone()).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tested: true, result: 'ok' });
    expect(w.vault.meta('gitlab-pat/gl/read')).toMatchObject({
      testedAt: plus(t0, 60_000).toISOString(),
      testResult: 'ok',
    });
    // A stored value GitLab no longer accepts.
    w.vault.put('gitlab-pat/gl/read', D_WRONG, { now: t0 });
    w.store.refreshSecrets();
    infoRefs('acme/widgets', D_WRONG);
    const failed = await testRoute('gl', 'read');
    expect(failed.json()).toEqual({
      tested: false,
      status: 401,
      problem: GITLAB_READ_REJECTED,
      error: GITLAB_READ_REJECTED,
    });
    expect(w.vault.meta('gitlab-pat/gl/read')?.testResult).toBe('failed (401)');
    expect(
      listAudit(w.db)
        .filter((a) => a.action === 'secret.test')
        .map((a) => a.detail),
    ).toEqual([
      { name: 'gitlab-pat/gl/read', fingerprint: fingerprintOf(D_WRONG), result: 'failed (401)' },
      { name: 'gitlab-pat/gl/read', fingerprint: fingerprintOf(D_VALUE), result: 'ok' },
    ]);
    expectNoTokens(w, [r.body, failed.body]);
  });

  test('test when not set, or set but not resolving: the author/reviewer answers', async () => {
    const w = world();
    const r = await testRoute('gl', 'read');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'the token is not set' });
    // A value that does not parse has meta but resolves to nothing.
    w.vault.put('gitlab-pat/gl/read', D_TOKEN, { now: t0 });
    w.store.refreshSecrets();
    const unresolved = await testRoute('gl', 'read');
    expect(unresolved.statusCode).toBe(409);
    expect(unresolved.json()).toEqual({
      error: 'the token does not decrypt with this vault key',
    });
    expectNoTokens(w, [r.body, unresolved.body]);
  });

  test('remove: never refused for parking a zone, audited; 409 once gone', async () => {
    const w = world();
    infoRefs('acme/widgets');
    await put('gl', 'read', D_VALUE);
    const r = await remove('gl', 'read');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, name: 'gitlab-pat/gl/read' });
    expect(w.vault.meta('gitlab-pat/gl/read')).toBeUndefined();
    expect(w.store.resolvedGitlabPats().get('gl')?.read).toBeUndefined();
    expect(listAudit(w.db).find((a) => a.action === 'secret.remove')?.detail).toEqual({
      name: 'gitlab-pat/gl/read',
      fingerprint: fingerprintOf(D_VALUE),
      result: 'removed',
    });
    const again = await remove('gl', 'read');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'the vault holds no such token' });
    expectNoTokens(w, [r.body, again.body]);
  });

  test('a GitHub zone or an unknown zone: 404 on all three; a session needs sudo', async () => {
    const w = world();
    const bodies: string[] = [];
    for (const zone of ['web', 'nowhere']) {
      for (const r of [
        await put(zone, 'read', D_VALUE),
        await testRoute(zone, 'read'),
        await remove(zone, 'read'),
      ]) {
        bodies.push(r.body);
        expect(r.statusCode).toBe(404);
      }
    }
    for (const r of [
      await put('gl', 'read', D_VALUE, w.asSession),
      await testRoute('gl', 'read', w.asSession),
      await remove('gl', 'read', w.asSession),
    ]) {
      bodies.push(r.body);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ sudo: 'required' });
    }
    expect(w.vault.count()).toBe(0);
    expectNoTokens(w, bodies);
  });

  test('the bad name refusal names read beside author and reviewer', async () => {
    const w = world();
    const r = await put('gl', 'maintainer', D_VALUE);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/author.*reviewer.*read|read.*author.*reviewer/);
    expectNoTokens(w, [r.body]);
  });
});

describe('refusals and sudo (issue #776)', () => {
  const calls = (zone: string, role: string, headers?: Record<string, string>) => [
    () => put(zone, role, AUTHOR, headers),
    () => testRoute(zone, role, headers),
    () => remove(zone, role, headers),
  ];

  test('an unknown zone or a GitHub zone: 404; a bad zone id or role: 400; never the input', async () => {
    const w = world();
    const bodies: string[] = [];
    // Each case names the input that must not come back.
    for (const [zone, role, code, input] of [
      ['nowhere', 'author', 404, 'nowhere'],
      ['web', 'author', 404, 'web'],
      ['bad_zone', 'author', 400, 'bad_zone'],
      [encodeURIComponent(`x${AUTHOR}`), 'author', 400, AUTHOR],
      ['gl', 'maintainer', 400, 'maintainer'],
      ['gl', encodeURIComponent(`r${REVIEWER}`), 400, REVIEWER],
    ] as const)
      for (const call of calls(zone, role)) {
        const r = await call();
        bodies.push(r.body);
        expect([zone, role, r.statusCode]).toEqual([zone, role, code]);
        expect([input, r.body.includes(input)]).toEqual([input, false]);
      }
    expect(w.fake.requests).toHaveLength(0);
    expect(w.vault.count()).toBe(0);
    expectNoTokens(w, bodies, { typedInUrl: true });
  });

  test('a session needs sudo for all three writes; the bearer token proceeds', async () => {
    const w = world();
    w.vault.put('gitlab-pat/solo/reviewer', LEFTOVER, { now: t0 });
    for (const call of calls('solo', 'author', w.asSession)) {
      const r = await call();
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ sudo: 'required' });
    }
    const del = await remove('solo', 'reviewer', w.asSession);
    expect(del.statusCode).toBe(403);
    expect(w.vault.meta('gitlab-pat/solo/author')).toBeUndefined();
    expect(w.fake.requests).toHaveLength(0);
    // With sudo the session proceeds, as the token does.
    w.db.prepare('UPDATE sessions SET sudo_until = ?').run(plus(t0, 60_000).toISOString());
    expect((await put('solo', 'author', AUTHOR, w.asSession)).statusCode).toBe(200);
    expect((await testRoute('solo', 'author')).statusCode).toBe(200);
    expect((await remove('solo', 'reviewer')).statusCode).toBe(200);
  });
});
