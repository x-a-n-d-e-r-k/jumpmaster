import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { openDb } from '../db/open.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { scrub } from '../scrub.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  type AppRole,
  appEntryName,
  type GitHubAppEntry,
  readAppEntry,
  serializeAppEntry,
} from './github-app-entries.js';
import {
  appInstallationFor,
  credentialFor,
  type ResolvedApps,
  resolveAppEntries,
} from './resolution.js';
import { openVault, type Vault } from './vault.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_LINES = PEM.split('\n').filter((l) => l !== '' && !l.startsWith('-----'));

const entry = (over: Partial<GitHubAppEntry> = {}): GitHubAppEntry => ({
  appId: '123456',
  slug: 'acme-jumpmaster-author',
  clientId: 'Iv23liClientId0001',
  pem: PEM,
  importedAt: '2026-11-15T10:00:00.000Z',
  ...over,
});

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

const twoBot = (repo: string) => ({ repo, identity: 'two-bot' as const });
const starter = (repo: string) => ({ repo, identity: 'starter' as const });
const PAT_AUTHOR = { ref: { kind: 'github-pat', name: 'githubAuthorToken' } };
const PAT_REVIEWER = { ref: { kind: 'github-pat', name: 'githubReviewerToken' } };
const app = (owner: string) => ({ ref: { kind: 'github-app', owner } });

describe('resolveAppEntries', () => {
  test('reads each distinct two-bot owner once, for both roles', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const read = vi.fn(readAppEntry);
    const apps = resolveAppEntries([twoBot('acme/a'), { repo: 'Acme/b' }, twoBot('globex/c')], {
      vault,
      secretsDir,
      scrubSet: new ScrubSet(),
      read,
    });
    const calls = read.mock.calls.map(([, owner, role]) => `${owner}/${role}`).sort();
    expect(calls).toEqual(['acme/author', 'acme/reviewer', 'globex/author', 'globex/reviewer']);
    expect([...apps.keys()].sort()).toEqual(['acme', 'globex']);
    expect(apps.get('acme')?.author).toMatchObject({ source: 'vault' });
    expect(apps.get('acme')?.reviewer).toEqual({ source: 'missing' });
    expect(apps.get('globex')?.author).toEqual({ source: 'missing' });
    expect(apps.get('globex')?.reviewer).toEqual({ source: 'missing' });
  });

  test('a starter-only owner is not read, and its zone gets the PAT', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const read = vi.fn(readAppEntry);
    const z = starter('acme/x');
    const apps = resolveAppEntries([z], { vault, secretsDir, scrubSet: new ScrubSet(), read });
    expect(read).not.toHaveBeenCalled();
    expect(apps.size).toBe(0);
    expect(credentialFor(z, 'author', apps)).toEqual(PAT_AUTHOR);
    expect(credentialFor(z, 'reviewer', apps)).toEqual(PAT_REVIEWER);
  });

  test('a starter zone gets the PAT even when its owner is read for a two-bot zone', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const apps = resolveAppEntries([twoBot('acme/a'), starter('acme/b')], {
      vault,
      secretsDir,
      scrubSet: new ScrubSet(),
    });
    expect(credentialFor(twoBot('acme/a'), 'author', apps)).toEqual(app('acme'));
    expect(credentialFor(starter('acme/b'), 'author', apps)).toEqual(PAT_AUTHOR);
  });

  test('a malformed entry file under a starter-only owner does not throw', () => {
    const { vault, secretsDir } = setup();
    writeEntryFile(secretsDir, 'acme', 'author', '{not json');
    expect(() =>
      resolveAppEntries([starter('acme/x')], { vault, secretsDir, scrubSet: new ScrubSet() }),
    ).not.toThrow();
  });

  test('a malformed entry file for a two-bot owner throws naming the path, never the PEM', () => {
    const { vault, secretsDir } = setup();
    const path = writeEntryFile(
      secretsDir,
      'acme',
      'author',
      JSON.stringify({ ...entry(), appId: 'abc' }),
    );
    let msg = '';
    try {
      resolveAppEntries([twoBot('acme/x')], { vault, secretsDir, scrubSet: new ScrubSet() });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(path);
    expect(msg).not.toContain('PRIVATE KEY');
    for (const l of PEM_LINES) expect(msg).not.toContain(l);
  });

  test('a two-bot zone on an owner that is not a GitHub owner name is skipped, with PAT refs', () => {
    const { vault, secretsDir } = setup();
    const read = vi.fn(readAppEntry);
    const z = twoBot('my_org/x');
    let apps: ResolvedApps = new Map();
    expect(() => {
      apps = resolveAppEntries([z], { vault, secretsDir, scrubSet: new ScrubSet(), read });
    }).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(credentialFor(z, 'author', apps)).toEqual(PAT_AUTHOR);
    expect(credentialFor(z, 'reviewer', apps)).toEqual(PAT_REVIEWER);
  });

  test('both entries: app refs for both roles; only the author: author app, reviewer PAT', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    vault.put(appEntryName('acme', 'reviewer'), serializeAppEntry(entry({ slug: 'rev' })), {
      now: t0,
    });
    writeEntryFile(secretsDir, 'globex', 'author', serializeAppEntry(entry({ slug: 'g' })));
    const a = twoBot('acme/x');
    const g = twoBot('globex/y');
    const apps = resolveAppEntries([a, g], { vault, secretsDir, scrubSet: new ScrubSet() });
    expect(credentialFor(a, 'author', apps)).toEqual(app('acme'));
    expect(credentialFor(a, 'reviewer', apps)).toEqual(app('acme'));
    expect(credentialFor(g, 'author', apps)).toEqual(app('globex'));
    expect(credentialFor(g, 'reviewer', apps)).toEqual(PAT_REVIEWER);
  });

  test('owners match case-insensitively', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const apps = resolveAppEntries([twoBot('Acme/x'), twoBot('acme/y')], {
      vault,
      secretsDir,
      scrubSet: new ScrubSet(),
    });
    expect([...apps.keys()]).toEqual(['acme']);
    expect(credentialFor(twoBot('Acme/x'), 'author', apps)).toEqual(app('acme'));
    expect(credentialFor(twoBot('ACME/z'), 'author', apps)).toEqual(app('acme'));
  });

  test('an undecryptable entry gives the app ref with a problem, never the PAT', () => {
    const { vault, secretsDir, dbFile } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const other = openVault(keyFile(), openDb(dbFile));
    if (other === 'disabled') throw new Error('expected a vault');
    const z = twoBot('acme/x');
    const apps = resolveAppEntries([z], { vault: other, secretsDir, scrubSet: new ScrubSet() });
    const r = credentialFor(z, 'author', apps);
    expect(r).toEqual({ ref: { kind: 'github-app', owner: 'acme' }, problem: 'undecryptable' });
    expect(r.ref.kind).not.toBe('github-pat');
    expect(credentialFor(z, 'reviewer', apps)).toEqual(PAT_REVIEWER);
  });

  test('every loaded PEM is registered with the scrub set before resolution returns', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const set = new ScrubSet();
    resolveAppEntries([twoBot('acme/x')], { vault, secretsDir, scrubSet: set });
    const body = PEM_LINES.join('');
    const line = PEM_LINES[1] as string;
    expect(scrub(`key: ${PEM}`, undefined, [], set)).toBe('key: [redacted]');
    expect(scrub(`body ${body}`, undefined, [], set)).toBe('body [redacted]');
    expect(scrub(`line ${line}`, undefined, [], set)).toBe('line [redacted]');
  });

  test('a PEM replaced by a later resolution stays in the scrub set', () => {
    const { vault, secretsDir } = setup();
    const set = new ScrubSet();
    const next = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    resolveAppEntries([twoBot('acme/x')], { vault, secretsDir, scrubSet: set });
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry({ pem: next })), { now: t0 });
    resolveAppEntries([twoBot('acme/x')], { vault, secretsDir, scrubSet: set });
    expect(scrub(`old ${PEM} new ${next}`, undefined, [], set)).toBe(
      'old [redacted] new [redacted]',
    );
  });

  test('no returned value other than entry holds the PEM', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const z = twoBot('acme/x');
    const apps = resolveAppEntries([z], { vault, secretsDir, scrubSet: new ScrubSet() });
    const out = JSON.stringify([
      credentialFor(z, 'author', apps),
      credentialFor(z, 'reviewer', apps),
    ]);
    for (const l of PEM_LINES) expect(out).not.toContain(l);
  });
});

describe('appInstallationFor (spec §4.2)', () => {
  const githubApp = { repositoryId: 123, installations: { author: 11, reviewer: 22 } };
  const zone = (extra: Record<string, unknown> = {}) => ({ repo: 'octo/web', ...extra });

  test('a two-bot zone with both roles recorded gives each role its installation and the shared repository', () => {
    const z = zone({ identity: 'two-bot', githubApp });
    expect(appInstallationFor(z, 'author')).toEqual({ installationId: 11, repositoryId: 123 });
    expect(appInstallationFor(z, 'reviewer')).toEqual({ installationId: 22, repositoryId: 123 });
  });

  test('identity absent is two-bot', () => {
    expect(appInstallationFor(zone({ githubApp }), 'reviewer')).toEqual({
      installationId: 22,
      repositoryId: 123,
    });
  });

  test('only the author recorded: the reviewer gives undefined', () => {
    const z = zone({ githubApp: { repositoryId: 123, installations: { author: 11 } } });
    expect(appInstallationFor(z, 'author')).toEqual({ installationId: 11, repositoryId: 123 });
    expect(appInstallationFor(z, 'reviewer')).toBeUndefined();
  });

  test('no githubApp gives undefined', () => {
    expect(appInstallationFor(zone(), 'author')).toBeUndefined();
    expect(appInstallationFor(zone({ identity: 'two-bot' }), 'reviewer')).toBeUndefined();
  });

  test('a starter zone gives undefined even with ids recorded', () => {
    const z = zone({ identity: 'starter', githubApp });
    expect(appInstallationFor(z, 'author')).toBeUndefined();
    expect(appInstallationFor(z, 'reviewer')).toBeUndefined();
  });
});
