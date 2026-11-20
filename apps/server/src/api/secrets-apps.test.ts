/**
 * GitHub App vault entries in the credential routes (issue #235, spec §4.4): the list shows each
 * two-bot zone owner's entries for both roles, and an entry can be tested with `GET /app`. No
 * answer, audit row or log line carries a PEM, a JWT or a client id.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore, VAULT_DISABLED } from '../config/store.js';
import { openDb } from '../db/open.js';
import { upsertDropZone } from '../db/repo.js';
import { createAppBrokers } from '../forge/app-brokers.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  type GitHubAppEntry,
  parseAppEntry,
  serializeAppEntry,
} from '../vault/github-app-entries.js';
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
function world(o: { vaultOff?: boolean } = {}) {
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

describe('Replace key on a GitHub App entry (issue #487)', () => {
  const NAME = 'github-app/acme/author';
  const replaceKey = (
    owner: string,
    role: string,
    payload: unknown,
    headers: Record<string, string> = auth,
  ) =>
    (app as FastifyInstance).inject({
      method: 'PUT',
      url: `/api/control/secrets/github-app/${owner}/${role}/key`,
      headers,
      payload: payload as object,
    });
  /** Whether `jwt` is an RS256 JWT signed by `pem`'s key. */
  const signedBy = (jwt: string, pem: string): boolean => {
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) return false;
    return verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      createPublicKey(pem),
      Buffer.from(sig, 'base64url'),
    );
  };
  /** A fake `GET /app` that answers acme-author only to a JWT signed with `pem`, else 401. */
  function fakeAppFor(pem: string, body: object = { id: 1001, slug: 'acme-author' }) {
    const jwts: string[] = [];
    const rest = fakeOnlyFor(pem, () => nock(API, onlyKey(pem, jwts)).get('/app').reply(200, body));
    return { jwts, rest };
  }
  /** nock options that match only a request whose bearer JWT `pem` signed. */
  const onlyKey = (pem: string, jwts: string[] = []) => ({
    reqheaders: {
      authorization: (v: string) => {
        const jwt = v.replace(/^Bearer /, '');
        jwts.push(jwt);
        return signedBy(jwt, pem);
      },
    },
  });
  /** `accept` answers a JWT `pem` signed; any other JWT is answered 401. */
  function fakeOnlyFor(pem: string, accept: () => unknown, path = '/app') {
    const jwts: string[] = [];
    accept();
    nock(API, {
      reqheaders: {
        authorization: (v: string) => {
          jwts.push(v.replace(/^Bearer /, ''));
          return !signedBy(v.replace(/^Bearer /, ''), pem);
        },
      },
    })
      .get(path)
      .optionally()
      .reply(401, { message: 'bad credentials' });
    return jwts;
  }
  const replaceAudits = (w: ReturnType<typeof world>) =>
    listAudit(w.db).filter((a) => a.action === 'secret.replace');
  const allText = (w: ReturnType<typeof world>, ...bodies: string[]) =>
    `${bodies.join('\n')}\n${JSON.stringify(listAudit(w.db))}\n${w.logs.join('\n')}`;
  const expectNoKeys = (text: string, ...pems: string[]) => {
    expectNoSecrets(text);
    for (const p of pems) for (const l of pemLines(p)) expect(text).not.toContain(l);
  };

  test('a valid new key for the same app is tested, stored with a fresh importedAt, recorded and audited', async () => {
    const w = world();
    const newPem = pemOf();
    const { jwts } = fakeAppFor(newPem);
    const NOW = new Date('2026-11-19T12:00:00.000Z');
    w.clock.now = NOW;
    const r = await replaceKey('acme', 'author', { pem: newPem });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ replaced: true, result: 'ok' });
    expect(r.json().hint).toMatch(/delete the old key/);
    expect(jwts.length).toBeGreaterThan(0);
    const read = w.store.resolvedApps().get('acme')?.author;
    if (read?.source !== 'vault') throw new Error('expected a vault entry');
    expect(read.entry).toEqual({
      appId: VAULT_ENTRY.appId,
      slug: VAULT_ENTRY.slug,
      clientId: VAULT_ENTRY.clientId,
      pem: newPem,
      importedAt: NOW.toISOString(),
    });
    expect(Date.parse(read.entry.importedAt)).toBeGreaterThan(Date.parse(VAULT_ENTRY.importedAt));
    expect(w.vault.meta(NAME)).toMatchObject({
      testedAt: NOW.toISOString(),
      testResult: 'ok',
    });
    const newFingerprint = fingerprintOf(serializeAppEntry(read.entry));
    expect(read.fingerprint).toBe(newFingerprint);
    expect(replaceAudits(w).map((a) => a.detail)).toEqual([
      { name: NAME, fingerprint: newFingerprint, result: 'stored' },
    ]);
    const listed = (await list()).json().apps[0];
    expect(listed).toMatchObject({
      importedAt: NOW.toISOString(),
      testResult: 'ok',
      fingerprint: newFingerprint,
    });
    expectNoKeys(allText(w, r.body), newPem);
    for (const j of jwts) expect(allText(w, r.body)).not.toContain(j);
  });

  test('a key GitHub rejects (401): 422, tested false, and the stored entry is byte-identical', async () => {
    const w = world();
    const before = w.vault.snapshot(NAME);
    const newPem = pemOf();
    fakeApp(401, { message: 'A JSON web token could not be decoded' });
    const r = await replaceKey('acme', 'author', { pem: newPem });
    expect(r.statusCode).toBe(422);
    const body = r.json();
    expect(body).toMatchObject({ tested: false, status: 401 });
    expect(body.problem).toMatch(/wrong key or it was revoked/);
    expect(body.error).toBe(body.problem);
    expect(w.vault.snapshot(NAME)).toEqual(before);
    const candidate = fingerprintOf(
      serializeAppEntry({ ...VAULT_ENTRY, pem: newPem, importedAt: t0.toISOString() }),
    );
    expect(replaceAudits(w).map((a) => a.detail)).toEqual([
      { name: NAME, fingerprint: candidate, result: 'test failed (401)' },
    ]);
    expectNoKeys(allText(w, r.body), newPem);
  });

  test.each([
    ['a different app id', { id: 9999, slug: 'acme-author' }, /different app/],
    ['a different slug', { id: 1001, slug: 'someone-else' }, /names this app differently/],
  ])(
    'a key whose GET /app answers %s: 409, tested false, entry unchanged',
    async (_, answer, why) => {
      const w = world();
      const before = w.vault.snapshot(NAME);
      const newPem = pemOf();
      fakeAppFor(newPem, answer);
      const r = await replaceKey('acme', 'author', { pem: newPem });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ tested: false, status: 200 });
      expect(r.json().problem).toMatch(why);
      expect(r.json().error).toBe(r.json().problem);
      expect(w.vault.snapshot(NAME)).toEqual(before);
      expect(replaceAudits(w).map((a) => a.detail.result)).toEqual(['test failed (200)']);
      expectNoKeys(allText(w, r.body), newPem);
    },
  );

  test('when putAppEntry refuses, 400 with issues, audited refused, and the previous entry stays', async () => {
    const w = world();
    const before = w.vault.snapshot(NAME);
    const newPem = pemOf();
    fakeAppFor(newPem);
    vi.spyOn(w.store, 'refreshSecrets').mockReturnValueOnce({
      ok: false,
      issues: [{ path: 'dropZones', message: 'refused in this test' }],
    });
    const r = await replaceKey('acme', 'author', { pem: newPem });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ issues: [{ path: 'dropZones', message: 'refused in this test' }] });
    expect(w.vault.snapshot(NAME)).toEqual(before);
    const read = w.store.resolvedApps().get('acme')?.author;
    if (read?.source !== 'vault') throw new Error('expected a vault entry');
    expect(read.entry.pem).toBe(VAULT_ENTRY.pem);
    expect(replaceAudits(w).map((a) => a.detail.result)).toEqual(['refused']);
    expectNoKeys(allText(w, r.body), newPem);
  });

  test('refusals store nothing: not a PEM, bad body, missing, undecryptable, file, bad name, unknown owner', async () => {
    const w = world();
    const snaps = () =>
      ['acme/author', 'acme/reviewer', 'beta/author', 'beta/reviewer'].map((n) =>
        w.vault.snapshot(`github-app/${n}`),
      );
    const before = snaps();
    const newPem = pemOf();
    const notPem = await replaceKey('acme', 'author', { pem: 'not a key at all' });
    expect(notPem.statusCode).toBe(400);
    expect(notPem.body).not.toContain('not a key at all');
    // A public key, or a PEM with a line of junk, is not a private key.
    const pub = createPublicKey(newPem).export({ type: 'spki', format: 'pem' }).toString();
    expect((await replaceKey('acme', 'author', { pem: pub })).statusCode).toBe(400);
    const bad = await replaceKey('acme', 'author', { pem: newPem, extra: 'sneaky-value' });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('sneaky-value');
    const big = await replaceKey('acme', 'author', { pem: 'x'.repeat(64 * 1024 + 1) });
    expect(big.statusCode).toBe(400);
    const junk = await (app as FastifyInstance).inject({
      method: 'PUT',
      url: '/api/control/secrets/github-app/acme/author/key',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: '{"pem": sneaky-junk}',
    });
    expect(junk.statusCode).toBe(400);
    expect(junk.body).not.toContain('sneaky-junk');
    const missing = await replaceKey('beta', 'reviewer', { pem: newPem });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatch(/not set/);
    const undecryptable = await replaceKey('beta', 'author', { pem: newPem });
    expect(undecryptable.statusCode).toBe(409);
    expect(undecryptable.json().error).toMatch(/does not decrypt/);
    const file = await replaceKey('acme', 'reviewer', { pem: newPem });
    expect(file.statusCode).toBe(409);
    expect(file.json().error).toContain(
      `managed by ${join(w.secretsDir, 'github-app', 'acme', 'reviewer.json')}`,
    );
    for (const [owner, role] of [
      [encodeURIComponent('bad owner!'), 'author'],
      ['Acme', 'author'],
      ['acme', 'merger'],
    ] as const) {
      const r = await replaceKey(owner, role, { pem: newPem });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe(
        'an app entry is github-app/<owner>/<role>: a lowercase GitHub owner name, and author or reviewer',
      );
    }
    const unknown = await replaceKey('nobody', 'author', { pem: newPem });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown app entry' });
    expect((await replaceKey('solo', 'author', { pem: newPem })).statusCode).toBe(404);
    expect(snaps()).toEqual(before);
    expect(nock.pendingMocks()).toEqual([]);
    expectNoKeys(allText(w, notPem.body, missing.body, file.body), newPem);
  });

  test.each([
    ['a trailing blank line', (p: string) => `${p}\n`],
    ['a leading blank line', (p: string) => `\n${p}`],
    ['trailing spaces after the END line', (p: string) => `${p.trimEnd()}   `],
    ['CRLF line ends and a trailing blank line', (p: string) => `${p.replace(/\n/g, '\r\n')}\r\n`],
  ])(
    'a valid key pasted with %s is tested and stored in canonical form (issue #559)',
    async (_, pad) => {
      const w = world();
      const newPem = pemOf();
      fakeAppFor(newPem);
      const r = await replaceKey('acme', 'author', { pem: pad(newPem) });
      expect(r.statusCode).toBe(200);
      const read = w.store.resolvedApps().get('acme')?.author;
      if (read?.source !== 'vault') throw new Error('expected a vault entry');
      expect(read.entry.pem).toBe(`${newPem.replace(/\r\n/g, '\n').trim()}\n`);
      expect(parseAppEntry(serializeAppEntry(read.entry))).toEqual(read.entry);
      expectNoKeys(allText(w, r.body), newPem);
    },
  );

  test('padding does not make a non-key acceptable: padded junk, a junk line, two blocks (issue #559)', async () => {
    const w = world();
    const snaps = () =>
      ['acme/author', 'acme/reviewer', 'beta/author', 'beta/reviewer'].map((n) =>
        w.vault.snapshot(`github-app/${n}`),
      );
    const before = snaps();
    const newPem = pemOf();
    const other = pemOf();
    const lines = newPem.split('\n');
    const junkLine = [...lines.slice(0, 3), 'not base64 at all!', ...lines.slice(3)].join('\n');
    const bodies: string[] = [];
    for (const pem of [
      '\n  not a key  \n',
      junkLine,
      `${newPem}${other}`,
      `${newPem}\n${other}\n`,
    ]) {
      const r = await replaceKey('acme', 'author', { pem });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({
        error:
          'the key is not a private-key PEM: paste the whole .pem file GitHub downloaded, from -----BEGIN to -----END',
      });
      expect(r.body).not.toContain('not a key');
      bodies.push(r.body);
    }
    expect(snaps()).toEqual(before);
    expect(replaceAudits(w)).toEqual([]);
    expectNoKeys(allText(w, ...bodies), newPem, other);
  });

  test('the vault off: 409 VAULT_DISABLED and nothing stored', async () => {
    const w = world({ vaultOff: true });
    const newPem = pemOf();
    for (const role of ['author', 'reviewer']) {
      const r = await replaceKey('acme', role, { pem: newPem });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: VAULT_DISABLED });
    }
    expect(w.vault.snapshot('github-app/acme/reviewer')).toBeUndefined();
    expect(nock.pendingMocks()).toEqual([]);
  });

  test('a session needs sudo; with it, the replace goes through', async () => {
    const w = world();
    const newPem = pemOf();
    const before = w.vault.snapshot(NAME);
    const s = await replaceKey('acme', 'author', { pem: newPem }, w.asSession);
    expect(s.statusCode).toBe(403);
    expect(s.json()).toMatchObject({ sudo: 'required' });
    expect(w.vault.snapshot(NAME)).toEqual(before);
    expect(replaceAudits(w)).toHaveLength(0);
    w.db.prepare('UPDATE sessions SET sudo_until = ?').run(plus(t0, 60_000).toISOString());
    fakeAppFor(newPem);
    const ok = await replaceKey('acme', 'author', { pem: newPem }, w.asSession);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ replaced: true });
  });

  test('after a replace, resolvedApps has the new key and the rebuilt broker signs with it', async () => {
    const w = world();
    const brokers = createAppBrokers({ apps: () => w.store.resolvedApps(), onSecret: () => {} });
    const before = brokers.brokerFor('acme', 'author');
    const newPem = pemOf();
    fakeAppFor(newPem);
    expect((await replaceKey('acme', 'author', { pem: newPem })).statusCode).toBe(200);
    const read = w.store.resolvedApps().get('acme')?.author;
    if (read?.source !== 'vault') throw new Error('expected a vault entry');
    expect(read.entry.pem).toBe(newPem);
    const after = brokers.brokerFor('acme', 'author');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    // A fake GitHub that knows only the new key.
    const seen: string[] = [];
    nock(API, onlyKey(newPem, seen))
      .get('/repos/acme/web/installation')
      .reply(200, { id: 77, permissions: {} });
    nock(API).get('/repos/acme/web/installation').reply(401, { message: 'bad credentials' });
    expect(await after?.installationFor('acme', 'web')).toMatchObject({
      installed: true,
      installationId: 77,
    });
    await expect(before?.installationFor('acme', 'web')).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    expect(nock.isDone()).toBe(true);
  });
});
