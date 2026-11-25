import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitlabBasicAuth, gitlabBasicAuthAs } from '@jumpmaster/protocol';
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
import { gitlabPatEntryName, gitlabReadEntryName } from './gitlab-pat-entries.js';
import {
  appInstallationFor,
  credentialFor,
  isAppAuthorZone,
  isAppReviewerZone,
  type ResolvedApps,
  resolveAppEntries,
  resolveGitlabPatEntries,
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

  test('a resolved PEM is pinned: thousands of later minted values never evict its lines', () => {
    const { vault, secretsDir } = setup();
    vault.put(appEntryName('acme', 'author'), serializeAppEntry(entry()), { now: t0 });
    const set = new ScrubSet(64, () => {});
    resolveAppEntries([twoBot('acme/a')], { vault, secretsDir, scrubSet: set });
    for (let i = 0; i < 5000; i++) set.add(`minted-value-${i}-xx`);
    const lines = entry()
      .pem.split('\n')
      .filter((l) => l.length >= 40 && !l.startsWith('-----'));
    expect(lines.length).toBeGreaterThan(0);
    const values = set.values();
    for (const l of lines) expect(values).toContain(l);
    expect(values).toContain(entry().pem);
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

describe('isAppReviewerZone (issue #237)', () => {
  const githubApp = { repositoryId: 123, installations: { author: 11, reviewer: 22 } };
  const entry: GitHubAppEntry = {
    appId: '9',
    slug: 'rev',
    clientId: 'c',
    pem: 'unused',
    importedAt: '2026-11-01',
  };
  const present = { source: 'vault', fingerprint: 'fp', entry } as const;
  const missing = { source: 'missing' } as const;
  const apps = (reviewer: unknown): ResolvedApps =>
    new Map([['octo', { author: present, reviewer }]]) as unknown as ResolvedApps;

  test('a two-bot zone with a reviewer app and a recorded reviewer installation is one', () => {
    expect(isAppReviewerZone({ repo: 'octo/web', githubApp }, apps(present))).toBe(true);
  });

  test('no reviewer entry, an undecryptable one, no recorded installation or a starter zone is not', () => {
    expect(isAppReviewerZone({ repo: 'octo/web', githubApp }, apps(missing))).toBe(false);
    expect(
      isAppReviewerZone(
        { repo: 'octo/web', githubApp },
        apps({ source: 'missing', undecryptable: true }),
      ),
    ).toBe(false);
    expect(
      isAppReviewerZone(
        { repo: 'octo/web', githubApp: { repositoryId: 123, installations: { author: 11 } } },
        apps(present),
      ),
    ).toBe(false);
    expect(
      isAppReviewerZone({ repo: 'octo/web', identity: 'starter', githubApp }, apps(present)),
    ).toBe(false);
  });
});

describe('isAppAuthorZone (issue #249)', () => {
  const githubApp = { repositoryId: 123, installations: { author: 11, reviewer: 22 } };
  const entry: GitHubAppEntry = {
    appId: '8',
    slug: 'auth',
    clientId: 'c',
    pem: 'unused',
    importedAt: '2026-11-01',
  };
  const present = { source: 'vault', fingerprint: 'fp', entry } as const;
  const missing = { source: 'missing' } as const;
  const apps = (author: unknown): ResolvedApps =>
    new Map([['octo', { author, reviewer: present }]]) as unknown as ResolvedApps;

  test('a two-bot zone with a decryptable author app and a recorded author installation is one', () => {
    expect(isAppAuthorZone({ repo: 'octo/web', githubApp }, apps(present))).toBe(true);
  });

  test('a starter zone is not', () => {
    expect(
      isAppAuthorZone({ repo: 'octo/web', identity: 'starter', githubApp }, apps(present)),
    ).toBe(false);
  });

  test('an author PAT (no author entry) is not', () => {
    expect(isAppAuthorZone({ repo: 'octo/web', githubApp }, apps(missing))).toBe(false);
    expect(isAppAuthorZone({ repo: 'octo/web', githubApp }, new Map())).toBe(false);
  });

  test('an undecryptable author entry is not', () => {
    expect(
      isAppAuthorZone(
        { repo: 'octo/web', githubApp },
        apps({ source: 'missing', undecryptable: true }),
      ),
    ).toBe(false);
  });

  test('a missing author installation is not', () => {
    expect(
      isAppAuthorZone(
        { repo: 'octo/web', githubApp: { repositoryId: 123, installations: { reviewer: 22 } } },
        apps(present),
      ),
    ).toBe(false);
    expect(isAppAuthorZone({ repo: 'octo/web' }, apps(present))).toBe(false);
  });
});

describe('resolveGitlabPatEntries (§9, issue #719)', () => {
  const AUTHOR = 'plain-author-value-0000000001';
  const REVIEWER = 'plain-reviewer-value-000000002';
  const gitlab = (id: string, identity?: 'starter' | 'two-bot') => ({
    id,
    forge: 'gitlab' as const,
    ...(identity ? { identity } : {}),
  });
  const putBoth = (vault: Vault, id: string) => {
    vault.put(gitlabPatEntryName(id, 'author'), AUTHOR, { now: t0 });
    vault.put(gitlabPatEntryName(id, 'reviewer'), REVIEWER, { now: t0 });
  };

  test('a two-bot GitLab zone gives both present values', () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const r = resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: new ScrubSet() });
    expect([...r]).toEqual([['web', { author: AUTHOR, reviewer: REVIEWER }]]);
    expect(
      resolveGitlabPatEntries([gitlab('web', 'two-bot')], { vault, scrubSet: new ScrubSet() }),
    ).toEqual(r);
  });

  test('a starter GitLab zone reads the author only', () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const get = vi.spyOn(vault, 'get');
    const r = resolveGitlabPatEntries([gitlab('web', 'starter')], {
      vault,
      scrubSet: new ScrubSet(),
    });
    expect([...r]).toEqual([['web', { author: AUTHOR }]]);
    // The reviewer is never read; the read deploy token is, in either mode (issue #831).
    expect(get.mock.calls).toEqual([
      [gitlabPatEntryName('web', 'author')],
      [gitlabReadEntryName('web')],
    ]);
  });

  test('a GitHub zone is not read for', () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const get = vi.spyOn(vault, 'get');
    const zones = [{ id: 'web' }, { id: 'web', forge: 'github' as const }];
    expect(resolveGitlabPatEntries(zones, { vault, scrubSet: new ScrubSet() }).size).toBe(0);
    expect(get).not.toHaveBeenCalled();
  });

  test('a disabled vault gives missing roles', () => {
    const r = resolveGitlabPatEntries([gitlab('web')], {
      vault: 'disabled',
      scrubSet: new ScrubSet(),
    });
    expect([...r]).toEqual([['web', {}]]);
  });

  test('a missing entry gives a missing role', () => {
    const { vault } = setup();
    vault.put(gitlabPatEntryName('web', 'reviewer'), REVIEWER, { now: t0 });
    const r = resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: new ScrubSet() });
    expect([...r]).toEqual([['web', { reviewer: REVIEWER }]]);
  });

  test('an undecryptable entry gives a missing role, with no throw and no log line', () => {
    const { vault, dbFile } = setup();
    putBoth(vault, 'web');
    const other = openVault(keyFile(), openDb(dbFile));
    if (other === 'disabled') throw new Error('expected a vault');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.fn();
    try {
      const r = resolveGitlabPatEntries([gitlab('web')], {
        vault: other,
        scrubSet: new ScrubSet(64, warn),
      });
      expect([...r]).toEqual([['web', {}]]);
      expect(err).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  test('each present value is pinned: it outlives eviction and a log line is scrubbed', () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const set = new ScrubSet(2, () => {});
    resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: set });
    for (let i = 0; i < 5; i += 1) set.add(`minted-token-value-${i}-0000000000`);
    expect(set.values()).toEqual(expect.arrayContaining([AUTHOR, REVIEWER]));
    expect(scrub(`a ${AUTHOR} r ${REVIEWER}`, undefined, [], set)).toBe(
      'a [redacted] r [redacted]',
    );
  });

  test('the git basic-auth form of each present value is pinned and scrubbed', () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const set = new ScrubSet(2, () => {});
    resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: set });
    for (let i = 0; i < 5; i += 1) set.add(`minted-token-value-${i}-0000000000`);
    const forms = [gitlabBasicAuth(AUTHOR), gitlabBasicAuth(REVIEWER)];
    expect(set.values()).toEqual(expect.arrayContaining(forms));
    expect(scrub(`AUTHORIZATION: basic ${forms[0]} / ${forms[1]}`, undefined, [], set)).toBe(
      'AUTHORIZATION: basic [redacted] / [redacted]',
    );
  });

  test("a starter GitLab zone pins the author's two forms only, nothing for the reviewer", () => {
    const { vault } = setup();
    putBoth(vault, 'web');
    const set = new ScrubSet(0, () => {});
    resolveGitlabPatEntries([gitlab('web', 'starter')], { vault, scrubSet: set });
    expect(set.values()).toEqual([AUTHOR, gitlabBasicAuth(AUTHOR)]);
  });

  describe('the read deploy token (issue #831)', () => {
    const USER = 'gitlab+deploy-token-9';
    const TOKEN = 'deploy-token-value-00000000003';
    const VALUE = `${USER}:${TOKEN}`;
    const READ = { username: USER, token: TOKEN };

    test('a GitLab zone resolves read in two-bot and starter modes; author and reviewer as before', () => {
      const { vault } = setup();
      putBoth(vault, 'web');
      vault.put(gitlabReadEntryName('web'), VALUE, { now: t0 });
      const two = resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: new ScrubSet() });
      expect([...two]).toEqual([['web', { author: AUTHOR, reviewer: REVIEWER, read: READ }]]);
      const st = resolveGitlabPatEntries([gitlab('web', 'starter')], {
        vault,
        scrubSet: new ScrubSet(),
      });
      expect([...st]).toEqual([['web', { author: AUTHOR, read: READ }]]);
    });

    test('a malformed value resolves none', () => {
      const { vault } = setup();
      putBoth(vault, 'web');
      for (const bad of [TOKEN, `:${TOKEN}`, `${USER}:`]) {
        vault.put(gitlabReadEntryName('web'), bad, { now: t0 });
        const r = resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: new ScrubSet() });
        expect([...r]).toEqual([['web', { author: AUTHOR, reviewer: REVIEWER }]]);
      }
    });

    test('a GitHub zone never gets read', () => {
      const { vault } = setup();
      vault.put(gitlabReadEntryName('web'), VALUE, { now: t0 });
      const zones = [{ id: 'web' }, { id: 'web', forge: 'github' as const }];
      expect(resolveGitlabPatEntries(zones, { vault, scrubSet: new ScrubSet() }).size).toBe(0);
    });

    test('the token, the whole value and its basic-auth form are pinned', () => {
      const { vault } = setup();
      vault.put(gitlabReadEntryName('web'), VALUE, { now: t0 });
      const set = new ScrubSet(2, () => {});
      resolveGitlabPatEntries([gitlab('web')], { vault, scrubSet: set });
      for (let i = 0; i < 5; i += 1) set.add(`minted-token-value-${i}-0000000000`);
      const basic = gitlabBasicAuthAs(USER, TOKEN);
      expect(set.values()).toEqual(expect.arrayContaining([TOKEN, VALUE, basic]));
      expect(scrub(`t ${TOKEN} b ${basic}`, undefined, [], set)).toBe('t [redacted] b [redacted]');
    });
  });
});
