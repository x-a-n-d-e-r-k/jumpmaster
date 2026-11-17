import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  type AppRole,
  appEntryName,
  type CredentialRef,
  type GitHubAppEntry,
  ownerOfRepo,
  parseAppEntry,
  parseAppEntryName,
  readAppEntry,
  serializeAppEntry,
} from './github-app-entries.js';
import { fingerprintOf, openVault, type Vault } from './vault.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PKCS1 = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const PKCS8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_LINES = PKCS8.split('\n')
  .concat(PKCS1.split('\n'))
  .filter((l) => l !== '' && !l.startsWith('-----'));

const entry = (over: Partial<GitHubAppEntry> = {}): GitHubAppEntry => ({
  appId: '123456',
  slug: 'acme-jumpmaster-author',
  clientId: 'Iv23liClientId0001',
  pem: PKCS8,
  importedAt: '2026-11-15T10:00:00.000Z',
  ...over,
});

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
};

/** The message holds no PEM, no PEM line and none of `secrets`. */
const expectClean = (msg: string, ...secrets: string[]): void => {
  expect(msg).not.toContain('PRIVATE KEY');
  for (const l of PEM_LINES) expect(msg).not.toContain(l);
  for (const s of secrets) if (s) expect(msg).not.toContain(s);
};

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}abcdef`;

describe('entry names', () => {
  test.each(['author', 'reviewer'] as AppRole[])('round-trip for %s', (role) => {
    const name = appEntryName('acme', role);
    expect(name).toBe(`github-app/acme/${role}`);
    expect(parseAppEntryName(name)).toEqual({ owner: 'acme', role });
  });

  test('a mixed-case owner normalises to lowercase', () => {
    expect(appEntryName('AcMe-Corp', 'author')).toBe('github-app/acme-corp/author');
    expect(appEntryName('Acme', 'reviewer')).toBe(appEntryName('acme', 'reviewer'));
  });

  test.each(['', 'acme/x', '..', '-acme', 'acme-', 'a--b', 'a'.repeat(40), TOKEN])(
    'refuses the owner %j without echoing it',
    (owner) => {
      const msg = thrown(() => appEntryName(owner, 'author'));
      expect(msg).toMatch(/owner/);
      if (owner.length > 2) expect(msg).not.toContain(owner);
    },
  );

  test('a 39-character owner is accepted', () => {
    expect(appEntryName('a'.repeat(39), 'author')).toBe(`github-app/${'a'.repeat(39)}/author`);
  });

  test('refuses an unknown role', () => {
    expect(() => appEntryName('acme', 'merger' as AppRole)).toThrow(/role/);
  });

  test.each([
    'githubAuthorToken',
    'zone:z:NAME',
    'github-app/acme/merger',
    'github-app/acme',
    'github-app/acme/author/x',
    'github-app//author',
    'github-app/-acme/author',
    'github-app/Acme/author',
    `github-app/${TOKEN}/author`,
    'github-app/acme/author.json',
  ])('parseAppEntryName(%j) is undefined', (name) => {
    expect(parseAppEntryName(name)).toBeUndefined();
  });
});

describe('parseAppEntry', () => {
  test.each([
    ['PKCS#8', PKCS8],
    ['PKCS#1', PKCS1],
  ])('accepts a valid entry with a %s key', (_, pem) => {
    const e = entry({ pem });
    expect(parseAppEntry(JSON.stringify(e))).toEqual(e);
  });

  test('accepts a date-time with an offset and no fraction', () => {
    const e = entry({ importedAt: '2026-11-15T10:00:00+02:00' });
    expect(parseAppEntry(JSON.stringify(e))).toEqual(e);
  });

  const fields = ['appId', 'slug', 'clientId', 'pem', 'importedAt'] as const;

  const refusals: [string, string, Record<string, unknown>][] = [
    ...fields.map((f): [string, string, Record<string, unknown>] => {
      const { [f]: _, ...rest } = entry();
      return [`missing ${f}`, f, rest];
    }),
    ['non-numeric appId', 'appId', { ...entry(), appId: '12ab' }],
    ['numeric (not string) appId', 'appId', { ...entry(), appId: 123 }],
    ['empty appId', 'appId', { ...entry(), appId: '' }],
    ['empty slug', 'slug', { ...entry(), slug: '' }],
    ['non-string slug', 'slug', { ...entry(), slug: ['x'] }],
    ['empty clientId', 'clientId', { ...entry(), clientId: '' }],
    ['non-PEM pem', 'pem', { ...entry(), pem: 'not a key at all' }],
    ['public-key pem', 'pem', { ...entry(), pem: PKCS8.replace(/PRIVATE/g, 'PUBLIC') }],
    ['two PEM blocks', 'pem', { ...entry(), pem: PKCS8 + PKCS1 }],
    [
      'corrupt PEM body',
      'pem',
      { ...entry(), pem: PKCS8.replace(/\n[A-Za-z0-9+/]{8}/, '\nAAAAAAAA') },
    ],
    ['non-ISO importedAt', 'importedAt', { ...entry(), importedAt: 'last tuesday' }],
    ['date-only importedAt', 'importedAt', { ...entry(), importedAt: '2026-11-15' }],
    ['impossible importedAt', 'importedAt', { ...entry(), importedAt: '2026-13-45T99:00:00Z' }],
    ['unknown field', 'extra', { ...entry(), extra: 'x' }],
  ];

  test.each(refusals)('refuses %s, naming the field and nothing secret', (_, field, obj) => {
    const json = JSON.stringify(obj);
    const msg = thrown(() => parseAppEntry(json));
    expect(msg).toContain(field);
    expectClean(msg, json, String(obj.slug ?? ''), String(obj.clientId ?? ''));
    if (typeof obj.appId === 'string' && obj.appId.length > 1) expect(msg).not.toContain(obj.appId);
  });

  test('refuses invalid JSON and non-objects without echoing them', () => {
    const bad = `{"pem": ${JSON.stringify(PKCS8)}, `;
    expectClean(
      thrown(() => parseAppEntry(bad)),
      bad,
    );
    expect(() => parseAppEntry('[]')).toThrow(/object/);
    expect(() => parseAppEntry('null')).toThrow(/object/);
    expect(() => parseAppEntry('"x"')).toThrow(/object/);
  });

  test('an unknown field named like a PEM line is not echoed', () => {
    const line = PEM_LINES[3] as string;
    const msg = thrown(() => parseAppEntry(JSON.stringify({ ...entry(), [line]: 1 })));
    expectClean(msg);
  });
});

describe('serializeAppEntry', () => {
  test('is canonical and round-trips', () => {
    const a = entry();
    const b: GitHubAppEntry = {
      importedAt: a.importedAt,
      pem: a.pem,
      clientId: a.clientId,
      slug: a.slug,
      appId: a.appId,
    };
    expect(serializeAppEntry(a)).toBe(serializeAppEntry(b));
    expect(Object.keys(JSON.parse(serializeAppEntry(b)))).toEqual([
      'appId',
      'slug',
      'clientId',
      'pem',
      'importedAt',
    ]);
    expect(parseAppEntry(serializeAppEntry(a))).toEqual(a);
    expect(parseAppEntry(serializeAppEntry(b))).toEqual(a);
  });
});

describe('readAppEntry', () => {
  const keyFile = (): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'jm-vault-')), 'vault_key');
    writeFileSync(f, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
    return f;
  };
  const setup = (): { vault: Vault; secretsDir: string; dbFile: string } => {
    const dbFile = tmpDbFile();
    const v = openVault(keyFile(), openDb(dbFile));
    if (v === 'disabled') throw new Error('expected a vault');
    return { vault: v, secretsDir: mkdtempSync(join(tmpdir(), 'jm-secrets-')), dbFile };
  };
  const writeEntryFile = (dir: string, owner: string, role: AppRole, text: string): string => {
    mkdirSync(join(dir, 'github-app', owner), { recursive: true });
    const p = join(dir, 'github-app', owner, `${role}.json`);
    writeFileSync(p, text, { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  };
  const fileEntry = entry({ slug: 'from-file', pem: PKCS1 });
  const vaultEntry = entry({ slug: 'from-vault' });

  test('file only', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    const r = readAppEntry({ vault, secretsDir }, 'Acme', 'author');
    expect(r).toEqual({
      entry: fileEntry,
      source: 'file',
      path,
      fingerprint: fingerprintOf(serializeAppEntry(fileEntry)),
    });
  });

  test('vault only', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'reviewer'), serializeAppEntry(vaultEntry), { now: t0 });
    const r = readAppEntry({ vault, secretsDir }, 'ACME', 'reviewer');
    expect(r).toEqual({
      entry: vaultEntry,
      source: 'vault',
      fingerprint: fingerprintOf(serializeAppEntry(vaultEntry)),
    });
    expect(readAppEntry({ vault }, 'acme', 'reviewer').source).toBe('vault');
  });

  test('both: the file wins and the vault is overriden', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(vaultEntry), { now: t0 });
    const r = readAppEntry({ vault, secretsDir }, 'acme', 'author');
    expect(r).toMatchObject({ source: 'file', path, entry: fileEntry });
    expect(r.source !== 'missing' && r.overriding).toEqual([{ source: 'vault' }]);
  });

  test('both with preferVault: the vault wins and the file is overriden', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(vaultEntry), { now: t0 });
    const r = readAppEntry({ vault, secretsDir, preferVault: true }, 'acme', 'author');
    expect(r).toMatchObject({ source: 'vault', entry: vaultEntry });
    expect(r.source !== 'missing' && r.path).toBeFalsy();
    expect(r.source !== 'missing' && r.overriding).toEqual([{ source: 'file', path }]);
  });

  test('neither: missing', () => {
    const { vault, secretsDir } = setup();
    expect(readAppEntry({ vault, secretsDir }, 'acme', 'author')).toEqual({ source: 'missing' });
    expect(readAppEntry({ vault }, 'acme', 'author')).toEqual({ source: 'missing' });
  });

  test('a disabled vault counts as no vault entry', () => {
    const { secretsDir } = setup();
    expect(readAppEntry({ vault: 'disabled', secretsDir }, 'acme', 'author')).toEqual({
      source: 'missing',
    });
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    expect(
      readAppEntry({ vault: 'disabled', secretsDir, preferVault: true }, 'acme', 'author'),
    ).toEqual({
      entry: fileEntry,
      source: 'file',
      path,
      fingerprint: fingerprintOf(serializeAppEntry(fileEntry)),
    });
  });

  test('a vault entry that does not decrypt, with no file: missing and undecryptable', () => {
    const { vault, secretsDir, dbFile } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(vaultEntry), { now: t0 });
    const other = openVault(keyFile(), openDb(dbFile));
    expect(readAppEntry({ vault: other, secretsDir }, 'acme', 'author')).toEqual({
      source: 'missing',
      undecryptable: true,
    });
    // A file still serves, and the undecryptable entry overrides nothing.
    writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    const r = readAppEntry({ vault: other, secretsDir, preferVault: true }, 'acme', 'author');
    expect(r).toMatchObject({ source: 'file', entry: fileEntry });
    expect(r.source !== 'missing' && r.overriding).toBeFalsy();
  });

  test('an invalid file throws naming its path, never its contents', () => {
    const { vault, secretsDir } = setup();
    const text = JSON.stringify({ ...fileEntry, appId: 'abc' });
    const path = writeEntryFile(secretsDir, 'acme', 'author', text);
    const msg = thrown(() => readAppEntry({ vault, secretsDir }, 'acme', 'author'));
    expect(msg).toContain(path);
    expect(msg).toContain('appId');
    expectClean(msg, text, fileEntry.slug, fileEntry.clientId);
    // Not JSON at all.
    writeFileSync(path, PKCS1);
    const msg2 = thrown(() => readAppEntry({ vault, secretsDir }, 'acme', 'author'));
    expect(msg2).toContain(path);
    expectClean(msg2);
  });

  test('an unreadable file throws naming its path', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    chmodSync(path, 0o666);
    const msg = thrown(() => readAppEntry({ vault, secretsDir }, 'acme', 'author'));
    expect(msg).toContain(path);
    expectClean(msg);
  });

  test('#258: an entry file with any group or other bit is refused with the chmod message; 0600 and 0400 are read', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(secretsDir, 'acme', 'author', serializeAppEntry(fileEntry));
    for (const mode of [0o640, 0o604, 0o644, 0o666]) {
      chmodSync(path, mode);
      const msg = thrown(() => readAppEntry({ vault, secretsDir }, 'acme', 'author'));
      expect(msg).toBe(`${path} is readable by others; chmod 600 it`);
      expectClean(msg);
    }
    for (const mode of [0o600, 0o400]) {
      chmodSync(path, mode);
      expect(readAppEntry({ vault, secretsDir }, 'acme', 'author')).toMatchObject({
        source: 'file',
        path,
        entry: { slug: 'from-file' },
      });
    }
  });

  test('a vault entry holding invalid JSON throws naming the entry, never its contents', () => {
    const { vault, secretsDir } = setup();
    const name = appEntryName('acme', 'author');
    const bad = `{"pem": ${JSON.stringify(PKCS8)}`;
    vault.put(name, bad, { now: t0 });
    const msg = thrown(() => readAppEntry({ vault, secretsDir }, 'acme', 'author'));
    expect(msg).toContain(name);
    expectClean(msg, bad);
  });

  test('the same entry in a file (other key order, whitespace) and the vault: equal fingerprints', () => {
    const { vault, secretsDir } = setup();
    const e = entry();
    const pretty = `${JSON.stringify(
      { importedAt: e.importedAt, pem: e.pem, clientId: e.clientId, slug: e.slug, appId: e.appId },
      null,
      2,
    )}\n`;
    writeEntryFile(secretsDir, 'acme', 'author', pretty);
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(e), { now: t0 });
    const f = readAppEntry({ vault, secretsDir }, 'acme', 'author');
    const v = readAppEntry({ vault, secretsDir, preferVault: true }, 'acme', 'author');
    expect(f.source).toBe('file');
    expect(v.source).toBe('vault');
    expect(f.source !== 'missing' && f.fingerprint).toBe(v.source !== 'missing' && v.fingerprint);
  });

  test('refuses an invalid owner before reading anything, without echoing it', () => {
    const { vault, secretsDir } = setup();
    const msg = thrown(() => readAppEntry({ vault, secretsDir }, TOKEN, 'author'));
    expect(msg).not.toContain(TOKEN);
    expect(() => readAppEntry({ vault, secretsDir }, '../x', 'author')).toThrow(/owner/);
  });
});

describe('credential references', () => {
  test('a reference is an app by owner or a PAT by name', () => {
    const refs: CredentialRef[] = [
      { kind: 'github-app', owner: 'acme' },
      { kind: 'github-pat', name: 'githubAuthorToken' },
    ];
    expect(refs).toHaveLength(2);
  });

  test('ownerOfRepo returns the lowercased owner', () => {
    expect(ownerOfRepo('Owner/repo')).toBe('owner');
    expect(ownerOfRepo('acme-corp/x.y_z')).toBe('acme-corp');
  });

  test.each([
    'owner',
    'owner/',
    '/repo',
    'a/b/c',
    '',
    '-bad/repo',
    `${TOKEN}/repo`,
    `owner/${TOKEN}x/y`,
  ])('ownerOfRepo refuses %j without echoing it', (repo) => {
    const msg = thrown(() => ownerOfRepo(repo));
    if (repo.length > 1) expect(msg).not.toContain(repo);
    expect(msg).not.toContain(TOKEN);
  });
});
