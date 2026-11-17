/**
 * GitHub App vault entries in the credential routes (issue #235, spec §4.4): the list shows each
 * two-bot zone owner's entries for both roles, and an entry can be tested with `GET /app`. No
 * answer, audit row or log line carries a PEM, a JWT or a client id.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { upsertDropZone } from '../db/repo.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { type GitHubAppEntry, serializeAppEntry } from '../vault/github-app-entries.js';
import { fingerprintOf, openVault, type Vault } from '../vault/vault.js';
import { type ControlDeps, registerControlRoutes } from './control.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const auth = { authorization: `Bearer ${TOKEN}`, host: HOST };
const API = 'https://api.github.com';

const pemOf = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
const pemLines = (pem: string) =>
  pem
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('-----'));

const entryOf = (appId: string, slug: string, clientId: string): GitHubAppEntry => ({
  appId,
  slug,
  clientId,
  pem: pemOf(),
  importedAt: '2026-11-13T00:00:00.000Z',
});
const VAULT_ENTRY = entryOf('1001', 'acme-author', 'Iv23liVAULTCLIENT0001');
const FILE_ENTRY = entryOf('1002', 'acme-reviewer', 'Iv23liFILECLIENT00002');
const STARTER_ENTRY = entryOf('1003', 'solo-author', 'Iv23liSTARTERCLIENT03');
const OTHER_KEY_ENTRY = entryOf('1004', 'beta-author', 'Iv23liOTHERKEYCLIENT4');
const ALL = [VAULT_ENTRY, FILE_ENTRY, STARTER_ENTRY, OTHER_KEY_ENTRY];

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());

let app: FastifyInstance | undefined;
afterEach(async () => {
  nock.cleanAll();
  await app?.close();
  app = undefined;
});

const keyFile = (dir: string, name: string) => {
  const f = join(dir, name);
  writeFileSync(f, randomBytes(32).toString('base64url'), { mode: 0o600 });
  return f;
};

/**
 * Three zones: `web` on acme (two-bot: acme/author in the vault, acme/reviewer in a file), `api`
 * on beta (two-bot: beta/author encrypted under another key, beta/reviewer missing), and `solo`
 * on a starter zone whose owner has a file that is never listed.
 */
function world() {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-apps-'));
  const secretsDir = join(dir, 'secrets');
  const writeEntry = (owner: string, role: string, e: GitHubAppEntry) => {
    mkdirSync(join(secretsDir, 'github-app', owner), { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDir, 'github-app', owner, `${role}.json`), serializeAppEntry(e), {
      mode: 0o600,
    });
  };
  mkdirSync(secretsDir);
  writeEntry('acme', 'reviewer', FILE_ENTRY);
  writeEntry('solo', 'author', STARTER_ENTRY);
  const vault = openVault(keyFile(dir, 'vault_key'), db) as Vault;
  vault.put('github-app/acme/author', serializeAppEntry(VAULT_ENTRY), { now: t0 });
  const other = openVault(keyFile(dir, 'other_key'), db) as Vault;
  other.put('github-app/beta/author', serializeAppEntry(OTHER_KEY_ENTRY), { now: t0 });
  const clock = { now: t0 };
  const store = ConfigStore.open({
    db,
    boot: { ...loadBoot({}, undefined), secretsDir },
    env: { JM_JOIN_TOKEN: 'join-secret-value-4', JM_OPERATOR_TOKEN: TOKEN },
    vault,
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
  const applied = store.apply(
    {
      dropZones: [
        zone('web', 'Acme/web'),
        zone('api', 'beta/api'),
        zone('solo', 'solo/x', { identity: 'starter', ciRequired: true }),
      ],
    },
    { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
  );
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  for (const [id, repo] of [
    ['web', 'Acme/web'],
    ['api', 'beta/api'],
    ['solo', 'solo/x'],
  ] as const)
    upsertDropZone(db, { id, repo, defaultBranch: 'main', configJson: '{}' });
  const logs: string[] = [];
  const deps: ControlDeps = {
    db,
    config: store,
    now: () => clock.now,
    log: (l) => logs.push(l),
    forgesFor: () => {
      throw new Error('no forge in this test');
    },
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
  return {
    db,
    store,
    vault,
    clock,
    logs,
    secretsDir,
    asSession: { ...session.headers, host: HOST },
  };
}

const list = (headers: Record<string, string> = auth) =>
  (app as FastifyInstance).inject({ method: 'GET', url: '/api/control/secrets', headers });
const testApp = (owner: string, role: string, headers: Record<string, string> = auth) =>
  (app as FastifyInstance).inject({
    method: 'POST',
    url: `/api/control/secrets/github-app/${owner}/${role}/test`,
    headers,
    payload: {},
  });

/** Fails when the text holds any key material, JWT or client id of the fixtures. */
function expectNoSecrets(text: string, jwts: string[] = []) {
  for (const e of ALL) {
    for (const line of pemLines(e.pem)) expect(text).not.toContain(line);
    expect(text).not.toContain(e.clientId);
  }
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toMatch(/"(pem|clientId)"/);
  for (const j of jwts) {
    expect(text).not.toContain(j);
    for (const part of j.split('.')) expect(text).not.toContain(part);
  }
}

/** A fake `GET /app` answering `status` with `body`, recording each JWT it is sent. */
function fakeApp(status: number, body: object = {}) {
  const jwts: string[] = [];
  nock(API, {
    reqheaders: {
      authorization: (v: string) => {
        jwts.push(v.replace(/^Bearer /, ''));
        return true;
      },
    },
  })
    .get('/app')
    .reply(status, body);
  return jwts;
}

describe('GitHub App entries in the secret routes (issue #235)', () => {
  test('the list holds each two-bot owner with both roles, sorted, with the right source; no starter owner, no key material', async () => {
    const w = world();
    const r = await list();
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.credentials.length).toBeGreaterThan(0);
    expect(body.apps).toEqual([
      {
        owner: 'acme',
        role: 'author',
        name: 'github-app/acme/author',
        source: 'vault',
        appId: '1001',
        slug: 'acme-author',
        importedAt: VAULT_ENTRY.importedAt,
        fingerprint: fingerprintOf(serializeAppEntry(VAULT_ENTRY)),
      },
      {
        owner: 'acme',
        role: 'reviewer',
        name: 'github-app/acme/reviewer',
        source: 'file',
        appId: '1002',
        slug: 'acme-reviewer',
        importedAt: FILE_ENTRY.importedAt,
        fingerprint: fingerprintOf(serializeAppEntry(FILE_ENTRY)),
        path: join(w.secretsDir, 'github-app', 'acme', 'reviewer.json'),
      },
      {
        owner: 'beta',
        role: 'author',
        name: 'github-app/beta/author',
        source: 'missing',
        undecryptable: true,
      },
      { owner: 'beta', role: 'reviewer', name: 'github-app/beta/reviewer', source: 'missing' },
    ]);
    expect(JSON.stringify(body.apps)).not.toContain('solo');
    expectNoSecrets(r.body);
  });

  test('a file entry overriding a vault entry lists the vault as overridden', async () => {
    const w = world();
    w.vault.put('github-app/acme/reviewer', serializeAppEntry(VAULT_ENTRY), { now: t0 });
    w.store.refreshSecrets();
    const item = (await list()).json().apps[1];
    expect(item).toMatchObject({ source: 'file', overriding: [{ source: 'vault' }] });
  });

  test('a good key tests ok with the bot login; the vault entry records it and the next list shows it', async () => {
    const w = world();
    const jwts = fakeApp(200, { id: 1001, slug: 'acme-author' });
    w.clock.now = plus(t0, 60_000);
    const r = await testApp('acme', 'author');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tested: true, result: 'ok', login: 'acme-author[bot]' });
    expect(jwts).toHaveLength(1);
    const item = (await list()).json().apps[0];
    expect(item).toMatchObject({
      source: 'vault',
      testedAt: plus(t0, 60_000).toISOString(),
      testResult: 'ok',
    });
    const rows = listAudit(w.db).filter((a) => a.action === 'secret.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({
      name: 'github-app/acme/author',
      fingerprint: fingerprintOf(serializeAppEntry(VAULT_ENTRY)),
      result: 'ok',
    });
    const text = `${r.body}\n${JSON.stringify(listAudit(w.db))}\n${w.logs.join('\n')}`;
    expectNoSecrets(text, jwts);
  });

  test('a key GitHub rejects: tested false, 401 and the wrong-or-revoked words, recorded and audited once', async () => {
    const w = world();
    const jwts = fakeApp(401, { message: 'A JSON web token could not be decoded' });
    const r = await testApp('acme', 'author');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ tested: false, status: 401 });
    expect(body.problem).toMatch(/wrong key or it was revoked/);
    expect(body.error).toBe(body.problem);
    expect(r.body).not.toContain('could not be decoded');
    expect((await list()).json().apps[0].testResult).toBe('failed (401)');
    const rows = listAudit(w.db).filter((a) => a.action === 'secret.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ result: 'failed (401)' });
    expectNoSecrets(`${r.body}\n${JSON.stringify(rows)}\n${w.logs.join('\n')}`, jwts);
  });

  test('a file entry is tested and audited, and nothing is recorded in the vault', async () => {
    const w = world();
    fakeApp(200, { id: 1002, slug: 'acme-reviewer' });
    const r = await testApp('acme', 'reviewer');
    expect(r.json()).toEqual({ tested: true, result: 'ok', login: 'acme-reviewer[bot]' });
    expect(w.vault.meta('github-app/acme/reviewer')).toBeUndefined();
    const rows = listAudit(w.db).filter((a) => a.action === 'secret.test');
    expect(rows.map((x) => x.detail)).toEqual([
      {
        name: 'github-app/acme/reviewer',
        fingerprint: fingerprintOf(serializeAppEntry(FILE_ENTRY)),
        result: 'ok',
      },
    ]);
  });

  test('a session needs sudo; the Bearer token does not', async () => {
    const w = world();
    const s = await testApp('acme', 'author', w.asSession);
    expect(s.statusCode).toBe(403);
    expect(s.json()).toMatchObject({ sudo: 'required' });
    expect(listAudit(w.db).filter((a) => a.action === 'secret.test')).toHaveLength(0);
    w.db.prepare('UPDATE sessions SET sudo_until = ?').run(plus(t0, 60_000).toISOString());
    fakeApp(200, { id: 1001, slug: 'acme-author' });
    expect((await testApp('acme', 'author', w.asSession)).json()).toMatchObject({ tested: true });
  });

  test('an invalid owner or role is 400 without echoing it; an unknown owner 404; missing or undecryptable 409', async () => {
    const w = world();
    for (const [owner, role] of [
      [encodeURIComponent('bad owner!'), 'author'],
      ['Acme', 'author'],
      ['acme', 'merger'],
    ] as const) {
      const r = await testApp(owner, role);
      expect(r.statusCode).toBe(400);
      expect(r.body).not.toContain('bad owner');
      expect(r.body).not.toContain('Acme');
      expect(r.body).not.toContain('merger');
    }
    const unknown = await testApp('nobody', 'author');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown app entry' });
    // A starter zone's owner is not an app owner.
    expect((await testApp('solo', 'author')).statusCode).toBe(404);
    expect((await testApp('beta', 'reviewer')).statusCode).toBe(409);
    expect((await testApp('beta', 'author')).statusCode).toBe(409);
    expect(listAudit(w.db).filter((a) => a.action === 'secret.test')).toHaveLength(0);
    expect(nock.pendingMocks()).toEqual([]);
  });
});
