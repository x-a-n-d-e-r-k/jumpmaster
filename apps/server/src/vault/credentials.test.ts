import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  credentialCreatedAt,
  credentialFingerprint,
  gateSecretName,
  refusalWords,
  resolveCredentials,
  SECRET_FILES,
  shadowedAppEntries,
  shadowedCredentials,
  testAppEntry,
  testCredential,
} from './credentials.js';
import { appEntryName, type GitHubAppEntry, serializeAppEntry } from './github-app-entries.js';
import { type ResolvedApps, resolveAppEntries } from './resolution.js';
import { fingerprintOf, openVault, type Vault } from './vault.js';

const CLAUDE = 'sk-ant-' + 'oat01-CLAUDEVALUE-0001';
const AUTHOR = 'github_pat_AUTHORVALUE_0002';
const REVIEWER = 'github_pat_REVIEWERVALUE_0003';
const READ = 'github_pat_READVALUE_0004';
const VAULT_AUTHOR = 'github_pat_VAULTAUTHOR_0005';

function secretsDir(files: Record<string, string>, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'jm-cred-'));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), `${value}\n`, { mode });
    chmodSync(join(dir, name), mode);
  }
  return dir;
}
function vault(): Vault {
  const f = join(mkdtempSync(join(tmpdir(), 'jm-key-')), 'vault_key');
  writeFileSync(f, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const v = openVault(f, openDb(tmpDbFile()));
  if (v === 'disabled') throw new Error('no vault');
  return v;
}

describe('resolveCredentials', () => {
  test('SECRET_FILES names the five credential files', () => {
    expect(SECRET_FILES).toEqual({
      claudeToken: 'claude_token',
      githubAuthorToken: 'github_author_token',
      githubReviewerToken: 'github_reviewer_token',
      githubReadToken: 'github_read_token',
      registryReadToken: 'registry_read_token',
    });
  });

  test('the registry read token (issue #140) resolves like the others: variable, file, vault', () => {
    const value = 'ghp_' + 'registryReadToken0123456789';
    expect(
      resolveCredentials({ JM_REGISTRY_READ_TOKEN: value }, undefined, 'disabled')
        .registryReadToken,
    ).toMatchObject({ value, source: 'env', path: 'JM_REGISTRY_READ_TOKEN' });
    const dir = secretsDir({ registry_read_token: value });
    expect(resolveCredentials({}, dir, 'disabled').registryReadToken).toMatchObject({
      value,
      source: 'file',
    });
    expect(resolveCredentials({}, undefined, 'disabled').registryReadToken).toEqual({
      source: 'missing',
    });
  });

  test('an init-written M4 directory resolves every credential as source file', () => {
    const dir = secretsDir({
      claude_token: CLAUDE,
      github_author_token: AUTHOR,
      github_reviewer_token: REVIEWER,
      github_read_token: READ,
    });
    const r = resolveCredentials({}, dir, 'disabled');
    expect(r.claudeToken).toEqual({
      value: CLAUDE,
      source: 'file',
      path: join(dir, 'claude_token'),
      fingerprint: fingerprintOf(CLAUDE),
    });
    expect(r.githubAuthorToken?.source).toBe('file');
    expect(r.githubReviewerToken?.value).toBe(REVIEWER);
    expect(r.githubReadToken?.value).toBe(READ);
  });

  test('a file named for the credential wins over a vault entry; the vault serves what is not there; the rest is missing', () => {
    const v = vault();
    v.put('githubAuthorToken', VAULT_AUTHOR, { now: t0 });
    v.put('githubReviewerToken', REVIEWER, { now: t0, declaredCreatedAt: '2026-01-01' });
    const dir = secretsDir({ github_author_token: AUTHOR });
    const r = resolveCredentials({}, dir, v);
    expect(r.githubAuthorToken).toMatchObject({ value: AUTHOR, source: 'file' });
    expect(r.githubReviewerToken).toEqual({
      value: REVIEWER,
      source: 'vault',
      fingerprint: fingerprintOf(REVIEWER),
      setAt: t0.toISOString(),
      declaredCreatedAt: '2026-01-01',
    });
    expect(r.claudeToken).toEqual({ source: 'missing' });
    expect(r.githubReadToken).toEqual({ source: 'missing' });
  });

  test('a credential file gets the regular-file and writable checks, named at startup, never with its value', () => {
    const dir = secretsDir({ claude_token: CLAUDE }, 0o666);
    let msg = '';
    try {
      resolveCredentials({}, dir, 'disabled');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      `claude_token: ${join(dir, 'claude_token')} is group- or world-writable; chmod go-w it`,
    );
    expect(msg).not.toContain(CLAUDE);
  });

  test('a dangling link named for a credential is reported by name at start, as a dangling _FILE path is', () => {
    const dir = secretsDir({});
    symlinkSync(join(dir, 'gone'), join(dir, 'github_author_token'));
    expect(() => resolveCredentials({}, dir, 'disabled')).toThrow(
      `github_author_token: ${join(dir, 'github_author_token')} does not exist`,
    );
  });

  test('a _FILE variable or a plain variable still wins over the file by name and the vault', () => {
    const dir = secretsDir({ claude_token: 'sk-ant-FROMDIRECTORY-00', other: CLAUDE });
    const r = resolveCredentials(
      { JM_CLAUDE_TOKEN_FILE: join(dir, 'other'), JM_GITHUB_AUTHOR_TOKEN: AUTHOR },
      dir,
      'disabled',
    );
    expect(r.claudeToken).toMatchObject({
      value: CLAUDE,
      source: 'file',
      path: join(dir, 'other'),
    });
    expect(r.githubAuthorToken).toMatchObject({
      value: AUTHOR,
      source: 'env',
      path: 'JM_GITHUB_AUTHOR_TOKEN',
    });
  });

  test('a _FILE under /run/secrets that is missing falls back to the secrets directory with a warning', () => {
    const dir = secretsDir({ github_author_token: AUTHOR });
    const warnings: string[] = [];
    const r = resolveCredentials(
      { JM_GITHUB_AUTHOR_TOKEN_FILE: '/run/secrets/github_author_token', JM_SECRETS_DIR: dir },
      dir,
      'disabled',
      { warn: (w) => warnings.push(w) },
    );
    expect(r.githubAuthorToken).toMatchObject({ value: AUTHOR, source: 'file' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/run/secrets/github_author_token');
    expect(warnings[0]).toContain(join(dir, 'github_author_token'));
  });

  test('gate secrets come from their JM_ZONE_SECRET_ variable or the vault', () => {
    const v = vault();
    v.put(gateSecretName('web', 'NPM_TOKEN'), 'npm-vault-value-1', { now: t0 });
    const r = resolveCredentials({ JM_ZONE_SECRET_WEB_SENTRY: 'sentry-env-value' }, undefined, v, {
      gateSecrets: [
        { zoneId: 'web', name: 'NPM_TOKEN' },
        { zoneId: 'web', name: 'SENTRY' },
        { zoneId: 'web', name: 'ABSENT' },
      ],
    });
    expect(r['zone:web:NPM_TOKEN']).toMatchObject({ value: 'npm-vault-value-1', source: 'vault' });
    expect(r['zone:web:SENTRY']).toMatchObject({ value: 'sentry-env-value', source: 'env' });
    expect(r['zone:web:ABSENT']).toEqual({ source: 'missing' });
  });

  test('a vault entry that does not decrypt is missing, and says so without a value', () => {
    const v = vault();
    v.put('claudeToken', CLAUDE, { now: t0 });
    const db = (v as unknown as { db: ReturnType<typeof openDb> }).db;
    db.prepare("UPDATE vault SET nonce = zeroblob(12) WHERE name = 'claudeToken'").run();
    const r = resolveCredentials({}, undefined, v);
    expect(r.claudeToken).toEqual({
      source: 'missing',
      undecryptable: true,
      fingerprint: fingerprintOf(CLAUDE),
    });
  });
});

describe('shadowing, fingerprints and dates', () => {
  test('a credential set in both places with different values is shadowed; equal values are not', () => {
    const v = vault();
    v.put('githubAuthorToken', VAULT_AUTHOR, { now: t0 });
    v.put('claudeToken', CLAUDE, { now: t0 });
    const dir = secretsDir({ github_author_token: AUTHOR, claude_token: CLAUDE });
    const r = resolveCredentials({}, dir, v);
    const s = shadowedCredentials(r, v);
    expect(s).toEqual([
      {
        name: 'githubAuthorToken',
        path: join(dir, 'github_author_token'),
        fileFingerprint: fingerprintOf(AUTHOR),
        vaultFingerprint: fingerprintOf(VAULT_AUTHOR),
      },
    ]);
    expect(JSON.stringify(s)).not.toContain(AUTHOR);
    expect(JSON.stringify(s)).not.toContain(VAULT_AUTHOR);
  });

  test('credentialFingerprint changes with any forge token and holds none', () => {
    const dir = secretsDir({ github_author_token: AUTHOR });
    const a = resolveCredentials({}, dir, 'disabled');
    const b = resolveCredentials({ JM_GITHUB_REVIEWER_TOKEN: REVIEWER }, dir, 'disabled');
    expect(credentialFingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint(b));
    expect(credentialFingerprint(a)).toBe(
      credentialFingerprint(resolveCredentials({}, dir, 'disabled')),
    );
  });

  test('credentialFingerprint with no app entries is byte-identical to the PAT-only value', () => {
    const r = resolveCredentials(
      { JM_GITHUB_AUTHOR_TOKEN: AUTHOR, JM_GITHUB_REVIEWER_TOKEN: REVIEWER },
      undefined,
      'disabled',
    );
    // Pinned from the code before app entries were hashed.
    const PINNED = 'd30acf30e7d73d1f';
    expect(credentialFingerprint(r)).toBe(PINNED);
    expect(credentialFingerprint(r, new Map())).toBe(PINNED);
    const onlyMissing: ResolvedApps = new Map([
      [
        'acme',
        { author: { source: 'missing' }, reviewer: { source: 'missing', undecryptable: true } },
      ],
    ]);
    expect(credentialFingerprint(r, onlyMissing)).toBe(PINNED);
  });

  test('credentialFingerprint changes when an app entry changes, and holds no PEM', () => {
    const r = resolveCredentials({ JM_GITHUB_AUTHOR_TOKEN: AUTHOR }, undefined, 'disabled');
    const pemOf = () =>
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
    const v = vault();
    const appsWith = (pem: string): ResolvedApps => {
      v.put(
        appEntryName('acme', 'author'),
        serializeAppEntry({
          appId: '1',
          slug: 's',
          clientId: 'c',
          pem,
          importedAt: '2026-11-15T10:00:00.000Z',
        }),
        { now: t0 },
      );
      return resolveAppEntries([{ repo: 'acme/x' }], { vault: v, scrubSet: new ScrubSet() });
    };
    const a = credentialFingerprint(r, appsWith(pemOf()));
    const b = credentialFingerprint(r, appsWith(pemOf()));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(credentialFingerprint(r));
    expect(a).not.toBe(b);
  });

  test("credentialCreatedAt: a vault credential's date (declared, else set) in either mode; claude.tokenCreatedAt for one the vault does not hold", () => {
    const v = vault();
    v.put('claudeToken', CLAUDE, { now: t0 });
    const r = resolveCredentials({}, undefined, v);
    expect(credentialCreatedAt('claudeToken', r, { tokenCreatedAt: '2025-01-01' })).toBe(
      t0.toISOString().slice(0, 10),
    );
    v.put('claudeToken', CLAUDE, { now: t0, declaredCreatedAt: '2026-01-15' });
    const r2 = resolveCredentials({}, undefined, v);
    expect(credentialCreatedAt('claudeToken', r2, {})).toBe('2026-01-15');
    // The source decides, not the config mode: a file-mode install's vault token is dated by the
    // vault, as its row, the banner and the doctor all read it.
    expect(credentialCreatedAt('claudeToken', r2, { tokenCreatedAt: '2025-01-01' })).toBe(
      '2026-01-15',
    );
    const f = resolveCredentials({}, secretsDir({ claude_token: CLAUDE }), 'disabled');
    expect(credentialCreatedAt('claudeToken', f, { tokenCreatedAt: '2025-02-02' })).toBe(
      '2025-02-02',
    );
  });
});

describe('testing a credential on entry', () => {
  const FAILED = 'github_pat_' + 'FAILEDTESTVALUE_distinct_9999';
  const zones = [
    { id: 'web', repo: 'octo/web' },
    { id: 'api', repo: 'octo/api' },
  ];
  const forgeFake = (behave: Record<string, () => Promise<unknown>>) => {
    const calls: string[] = [];
    return {
      calls,
      forge: (_token: string, repo: string) => ({
        viewerLogin: async () => {
          calls.push(`login ${repo}`);
          return (await (behave.login ?? (async () => 'author-bot'))()) as string;
        },
        repoAccess: async () => {
          calls.push(`access ${repo}`);
          return (behave[repo] ?? (async () => ({})))();
        },
      }),
    };
  };

  test('a forge token is tested for its login and against every zone', async () => {
    const f = forgeFake({});
    const r = await testCredential('githubAuthorToken', AUTHOR, { zones, forge: f.forge });
    expect(r).toEqual({ ok: true, result: 'ok', login: 'author-bot', live: true });
    expect(f.calls).toEqual(['login octo/web', 'access octo/web', 'access octo/api']);
    // The read token: its login only.
    const g = forgeFake({});
    expect(await testCredential('githubReadToken', READ, { zones, forge: g.forge })).toMatchObject({
      ok: true,
    });
    expect(g.calls).toEqual(['login octo/web']);
  });

  test('the registry read token is not a forge token: no GitHub call, the image mirror is its proof', async () => {
    const f = forgeFake({});
    expect(
      await testCredential('registryReadToken', 'ghp_' + 'registryRead0123456789', {
        zones,
        forge: f.forge,
      }),
    ).toEqual({ ok: true, result: 'stored: the image mirror is the live proof (Sticks, Images)' });
    expect(f.calls).toEqual([]);
    expect(await testCredential('registryReadToken', 'short', { zones, forge: f.forge })).toEqual({
      ok: false,
      status: null,
      problem: 'a registry token is at least 8 characters',
    });
  });

  test('a failed test returns only the status and the permission, and nothing of the value or the upstream body', async () => {
    const refusal = Object.assign(new Error(`Bad credentials ${FAILED} body text`), {
      status: 403,
      response: {
        headers: { 'x-accepted-github-permissions': 'contents=read' },
        data: { message: FAILED },
      },
    });
    const f = forgeFake({ 'octo/api': async () => Promise.reject(refusal) });
    const r = await testCredential('githubAuthorToken', FAILED, { zones, forge: f.forge });
    expect(r).toEqual({ ok: false, status: 403, permission: 'contents=read' });
    const g = forgeFake({ login: async () => Promise.reject(new Error(`network ${FAILED}`)) });
    expect(await testCredential('githubAuthorToken', FAILED, { zones, forge: g.forge })).toEqual({
      ok: false,
      status: null,
    });
  });

  test('the Claude token is judged by shape only; a gate secret by its length', async () => {
    const none = forgeFake({});
    expect(await testCredential('claudeToken', CLAUDE, { zones, forge: none.forge })).toEqual({
      ok: true,
      result: 'shape ok: the doctor drop is the live proof',
    });
    expect(
      await testCredential('claudeToken', 'not-a-claude-token', { zones, forge: none.forge }),
    ).toEqual({
      ok: false,
      status: null,
      problem: 'a Claude token from claude setup-token starts with sk-ant-',
    });
    expect(
      await testCredential(gateSecretName('web', 'NPM'), 'short', { zones, forge: none.forge }),
    ).toEqual({ ok: false, status: null, problem: 'a gate secret is at least 8 characters' });
    expect(none.calls).toEqual([]);
  });
});

describe('refusalWords: what a refused token test says (T10 finding 4)', () => {
  test('each GitHub status gets its meaning and the next step, never only "refused"', () => {
    expect(refusalWords(401)).toBe(
      "GitHub rejected this token (401): it is expired, revoked or mistyped. Make a new one (the GitHub step and each project's GitHub page have the links).",
    );
    expect(refusalWords(403, 'contents=write')).toBe(
      'GitHub refused it (403): the token lacks a permission (it needs contents=write), or an organization policy or a rate limit refused it. Edit the token on GitHub to add the permission, or wait and try again.',
    );
    expect(refusalWords(403)).toBe(
      'GitHub refused it (403): the token lacks a permission, or an organization policy or a rate limit refused it. Edit the token on GitHub to add the permission, or wait and try again.',
    );
    expect(refusalWords(404)).toBe(
      "The token can't see a project's repository (404): on GitHub, add the repository to the token's repository access.",
    );
    expect(refusalWords(null)).toBe(
      'GitHub did not answer: check this host reaches api.github.com.',
    );
    expect(refusalWords(503)).toBe(
      'GitHub did not accept the test (HTTP 503): try again in a moment.',
    );
  });

  const VAULT_401 =
    "GitHub rejected this token (401): it is expired, revoked or mistyped. Make a new one (the GitHub step and each project's GitHub page have the links).";

  test('a 401 for an environment variable names it and says to change it where the server environment is set, then restart', () => {
    const words = refusalWords(401, undefined, { source: 'env', path: 'JM_GITHUB_READ_TOKEN' });
    expect(words).toBe(
      "GitHub rejected this token (401): it is expired, revoked or mistyped. It comes from the environment variable JM_GITHUB_READ_TOKEN: make a new token on GitHub, set JM_GITHUB_READ_TOKEN to it where the server's environment is set, and restart the server.",
    );
    expect(words).not.toContain('/api/');
  });

  test('a 401 for a file names the path and says to replace its contents, then restart', () => {
    const words = refusalWords(401, undefined, {
      source: 'file',
      path: '/run/secrets/github_reviewer_token',
    });
    expect(words).toBe(
      "GitHub rejected this token (401): it is expired, revoked or mistyped. It is read from the file /run/secrets/github_reviewer_token: make a new token on GitHub, replace the file's contents with it, and restart the server.",
    );
  });

  test("a vault credential's 401, and 403 and 404 from any source, keep today's words", () => {
    expect(refusalWords(401, undefined, { source: 'vault' })).toBe(VAULT_401);
    expect(refusalWords(401)).toBe(VAULT_401);
    const env = { source: 'env', path: 'JM_GITHUB_READ_TOKEN' } as const;
    expect(refusalWords(403, 'contents=write', env)).toBe(refusalWords(403, 'contents=write'));
    expect(refusalWords(404, undefined, env)).toBe(refusalWords(404));
  });
});

describe('preferring the vault', () => {
  test('off (the default): a variable wins over the vault and says it overrides it; on: the vault wins and says which variable it overrides', () => {
    const v = vault();
    v.put('githubReadToken', 'github_pat_VAULTREAD_0006', { now: t0 });
    const env = { JM_GITHUB_READ_TOKEN: READ };
    const off = resolveCredentials(env, undefined, v);
    expect(off.githubReadToken).toMatchObject({
      value: READ,
      source: 'env',
      overriding: [{ source: 'vault' }],
    });
    const on = resolveCredentials(env, undefined, v, { preferVault: true });
    expect(on.githubReadToken).toMatchObject({
      value: 'github_pat_VAULTREAD_0006',
      source: 'vault',
      overriding: [{ source: 'env', path: 'JM_GITHUB_READ_TOKEN' }],
    });
    // A credential the vault does not hold still comes from its variable or file.
    const dir = secretsDir({ github_author_token: AUTHOR });
    const r = resolveCredentials({}, dir, v, { preferVault: true });
    expect(r.githubAuthorToken).toEqual({
      value: AUTHOR,
      source: 'file',
      path: join(dir, 'github_author_token'),
      fingerprint: fingerprintOf(AUTHOR),
    });
  });

  test('on: a vault entry wins over a file by name and over a gate secret variable', () => {
    const v = vault();
    v.put('githubAuthorToken', VAULT_AUTHOR, { now: t0 });
    v.put(gateSecretName('web', 'NPM_TOKEN'), 'npm-vault-value-1', { now: t0 });
    const dir = secretsDir({ github_author_token: AUTHOR });
    const env = { JM_ZONE_SECRET_WEB_NPM_TOKEN: 'npm-env-value-22' };
    const gateSecrets = [{ zoneId: 'web', name: 'NPM_TOKEN' }];
    const on = resolveCredentials(env, dir, v, { preferVault: true, gateSecrets });
    expect(on.githubAuthorToken).toMatchObject({
      value: VAULT_AUTHOR,
      source: 'vault',
      overriding: [{ source: 'file', path: join(dir, 'github_author_token') }],
    });
    expect(on['zone:web:NPM_TOKEN']).toMatchObject({
      value: 'npm-vault-value-1',
      overriding: [{ source: 'env', path: 'JM_ZONE_SECRET_WEB_NPM_TOKEN' }],
    });
    const off = resolveCredentials(env, dir, v, { gateSecrets });
    expect(off.githubAuthorToken).toMatchObject({ value: AUTHOR, source: 'file' });
    expect(off['zone:web:NPM_TOKEN']).toMatchObject({ value: 'npm-env-value-22', source: 'env' });
  });

  test('on: an entry that does not decrypt falls back to the variable', () => {
    const v = vault();
    v.put('claudeToken', 'sk-ant-' + 'oat01-OTHER-0007', { now: t0 });
    const db = (v as unknown as { db: ReturnType<typeof openDb> }).db;
    db.prepare("UPDATE vault SET nonce = zeroblob(12) WHERE name = 'claudeToken'").run();
    const r = resolveCredentials({ JM_CLAUDE_TOKEN: CLAUDE }, undefined, v, { preferVault: true });
    expect(r.claudeToken).toMatchObject({ value: CLAUDE, source: 'env' });
  });
});

describe('shadowedAppEntries (issue #551)', () => {
  const pemOf = (): string =>
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  const PEM_A = pemOf();
  const PEM_B = pemOf();
  const CLIENT_ID = 'Iv23liCLIENTIDVALUE551';
  const app = (pem: string): GitHubAppEntry => ({
    appId: '551',
    slug: 'acme-author',
    clientId: CLIENT_ID,
    pem,
    importedAt: '2026-11-15T10:00:00.000Z',
  });
  const NAME = 'github-app/acme/author';
  const writeFile = (dir: string, entry: GitHubAppEntry): string => {
    mkdirSync(join(dir, 'github-app', 'acme'), { recursive: true });
    const path = join(dir, 'github-app', 'acme', 'author.json');
    // Not canonical on purpose: whitespace and key order differ from serializeAppEntry.
    writeFileSync(path, JSON.stringify({ importedAt: entry.importedAt, ...entry }, null, 2), {
      mode: 0o600,
    });
    chmodSync(path, 0o600);
    return path;
  };
  const appsOf = (v: Vault | 'disabled', dir: string | undefined, preferVault = false) =>
    resolveAppEntries([{ repo: 'acme/x' }], {
      vault: v,
      ...(dir ? { secretsDir: dir } : {}),
      preferVault,
      scrubSet: new ScrubSet(),
    });

  test('a file and a differing vault entry give one item, with the name, the path and both fingerprints', () => {
    const v = vault();
    v.put(NAME, serializeAppEntry(app(PEM_B)), { now: t0 });
    const dir = secretsDir({});
    const path = writeFile(dir, app(PEM_A));
    const s = shadowedAppEntries(appsOf(v, dir), v);
    expect(s).toEqual([
      {
        name: NAME,
        path,
        fileFingerprint: fingerprintOf(serializeAppEntry(app(PEM_A))),
        vaultFingerprint: fingerprintOf(serializeAppEntry(app(PEM_B))),
        inUse: 'file',
      },
    ]);
    expect(s[0]?.fileFingerprint).not.toBe(s[0]?.vaultFingerprint);
    const text = JSON.stringify(s);
    for (const secret of [CLIENT_ID, ...PEM_A.split('\n'), ...PEM_B.split('\n')].filter(
      (l) => l.length > 0,
    ))
      expect(text).not.toContain(secret);
  });

  test('under prefer-vault the vault entry is in use, and the file is still fingerprinted canonically', () => {
    const v = vault();
    v.put(NAME, serializeAppEntry(app(PEM_B)), { now: t0 });
    const dir = secretsDir({});
    const path = writeFile(dir, app(PEM_A));
    expect(shadowedAppEntries(appsOf(v, dir, true), v)).toEqual([
      {
        name: NAME,
        path,
        fileFingerprint: fingerprintOf(serializeAppEntry(app(PEM_A))),
        vaultFingerprint: fingerprintOf(serializeAppEntry(app(PEM_B))),
        inUse: 'vault',
      },
    ]);
  });

  test('the same entry in both sources gives none, in either order', () => {
    const v = vault();
    v.put(NAME, serializeAppEntry(app(PEM_A)), { now: t0 });
    const dir = secretsDir({});
    writeFile(dir, app(PEM_A));
    expect(shadowedAppEntries(appsOf(v, dir), v)).toEqual([]);
    expect(shadowedAppEntries(appsOf(v, dir, true), v)).toEqual([]);
  });

  test('a file alone, a vault entry alone, or a disabled vault gives none', () => {
    const dir = secretsDir({});
    writeFile(dir, app(PEM_A));
    const empty = vault();
    expect(shadowedAppEntries(appsOf(empty, dir), empty)).toEqual([]);
    const v = vault();
    v.put(NAME, serializeAppEntry(app(PEM_B)), { now: t0 });
    expect(shadowedAppEntries(appsOf(v, undefined), v)).toEqual([]);
    expect(shadowedAppEntries(appsOf(v, secretsDir({})), v)).toEqual([]);
    expect(shadowedAppEntries(appsOf('disabled', dir), 'disabled')).toEqual([]);
    expect(shadowedAppEntries(appsOf(v, dir), 'disabled')).toEqual([]);
  });
});

describe('testAppEntry', () => {
  const api = 'https://ghe.test.invalid/api/v3';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pemLines = pem
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('-----'));
  const entry: GitHubAppEntry = {
    appId: '424242',
    slug: 'jm-author-app',
    clientId: 'Iv23liCLIENTIDVALUE01',
    pem,
    importedAt: '2026-11-13T00:00:00.000Z',
  };
  const now = () => 1_800_000_000_000;
  const recorder = () => {
    const calls: [string, string][] = [];
    return {
      calls,
      scrub: {
        add: (v: string) => calls.push(['add', v]),
        addPem: (v: string) => calls.push(['addPem', v]),
      },
    };
  };
  const leaks = (r: unknown, extra: string[] = []): string[] => {
    const text = JSON.stringify(r);
    return [pem, ...pemLines, entry.clientId, ...extra].filter((v) => text.includes(v));
  };

  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  test('a 200 with a matching id and slug is ok, signed with the entry key as a bearer JWT', async () => {
    let auth = '';
    nock(api, {
      reqheaders: {
        authorization: (v: string) => {
          auth = v;
          return true;
        },
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
      .get('/app')
      .reply(200, { id: 424242, slug: 'jm-author-app', client_id: entry.clientId });
    const { scrub, calls } = recorder();
    const r = await testAppEntry(entry, { apiBase: `${api}//`, now, scrub });
    expect(r).toEqual({ ok: true, result: 'ok', login: 'jm-author-app[bot]' });
    expect(auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const jwt = auth.slice('Bearer '.length);
    const [head, body, sig] = jwt.split('.') as [string, string, string];
    const verified = createVerify('RSA-SHA256')
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, 'base64url'));
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toMatchObject({
      iss: '424242',
      iat: 1_800_000_000 - 60,
    });
    expect(calls).toContainEqual(['add', jwt]);
  });

  test('a 200 with a different slug is refused without echoing either slug', async () => {
    nock(api).get('/app').reply(200, { id: 424242, slug: 'some-other-app' });
    const r = await testAppEntry(entry, { apiBase: api, now, scrub: recorder().scrub });
    expect(r).toEqual({
      ok: false,
      status: 200,
      problem: "GitHub names this app differently from the entry's slug: re-import the app",
    });
    expect(leaks(r, ['jm-author-app', 'some-other-app'])).toEqual([]);
  });

  test('a 200 with a different id is refused without echoing either id', async () => {
    nock(api).get('/app').reply(200, { id: 777777, slug: 'jm-author-app' });
    const r = await testAppEntry(entry, { apiBase: api, now, scrub: recorder().scrub });
    expect(r).toEqual({
      ok: false,
      status: 200,
      problem:
        "GitHub says this key belongs to a different app than the entry's app id: re-import the app",
    });
    expect(leaks(r, ['424242', '777777'])).toEqual([]);
  });

  test('a 401 means a wrong or revoked key, and nothing secret is echoed', async () => {
    const token = 'ghs_' + 'FAKETOKENVALUE0123456789abcdef';
    let jwt = '';
    const captureJwt = (v: string) => {
      jwt = v.slice('Bearer '.length);
      return true;
    };
    nock(api, { reqheaders: { authorization: captureJwt } })
      .get('/app')
      .reply(() => {
        return [401, { message: `Bad credentials ${token} ${pem} ${entry.clientId}` }];
      });
    const r = await testAppEntry(entry, { apiBase: api, now, scrub: recorder().scrub });
    expect(r).toEqual({
      ok: false,
      status: 401,
      problem:
        "GitHub rejected this app's key (401): it is the wrong key or it was revoked. Generate a new private key on the app's page and import it again.",
    });
    expect(jwt).not.toBe('');
    expect(leaks(r, [jwt, token, 'Bad credentials'])).toEqual([]);
  });

  test('a 500 returns its status only', async () => {
    nock(api).get('/app').reply(500, { message: 'boom' });
    const r = await testAppEntry(entry, { apiBase: api, now, scrub: recorder().scrub });
    expect(r).toEqual({ ok: false, status: 500 });
  });

  test('a network error returns status null with the fixed words', async () => {
    nock(api).get('/app').replyWithError(`socket hang up ${pem}`);
    const r = await testAppEntry(entry, { apiBase: api, now, scrub: recorder().scrub });
    expect(r).toEqual({ ok: false, status: null, problem: 'GitHub could not be reached' });
  });

  test('a malformed PEM is refused with the fixed words and makes no request', async () => {
    const bad = `-----BEGIN PRIVATE KEY-----\n${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(2)}\n-----END PRIVATE KEY-----\n`;
    const scope = nock(api).get('/app').reply(200, { id: 424242, slug: 'jm-author-app' });
    const { scrub, calls } = recorder();
    const r = await testAppEntry({ ...entry, pem: bad }, { apiBase: api, now, scrub });
    expect(r).toEqual({
      ok: false,
      status: null,
      problem: 'the private key could not be used to sign',
    });
    expect(scope.isDone()).toBe(false);
    expect(calls).toEqual([['addPem', bad]]);
    const text = JSON.stringify(r);
    for (const part of bad.split('\n').filter((l) => l !== '')) expect(text).not.toContain(part);
    expect(text).not.toContain(entry.clientId);
    nock.cleanAll();
  });

  test('addPem and add(jwt) are called before the request is answered', async () => {
    const { scrub, calls } = recorder();
    let seen: [string, string][] = [];
    let jwt = '';
    const captureJwt = (v: string) => {
      jwt = v.slice('Bearer '.length);
      return true;
    };
    nock(api, { reqheaders: { authorization: captureJwt } })
      .get('/app')
      .reply(() => {
        seen = [...calls];
        return [200, { id: 424242, slug: 'jm-author-app' }];
      });
    await testAppEntry(entry, { apiBase: api, now, scrub });
    expect(seen).toEqual([
      ['addPem', pem],
      ['add', jwt],
    ]);
  });

  test('scrub defaults to the server scrub set', async () => {
    const { serverScrubSet } = await import('../forge/scrub-set.js');
    serverScrubSet.clear();
    let jwt = '';
    const captureJwt = (v: string) => {
      jwt = v.slice('Bearer '.length);
      return true;
    };
    nock(api, { reqheaders: { authorization: captureJwt } })
      .get('/app')
      .reply(200, { id: 424242, slug: 'jm-author-app' });
    await testAppEntry(entry, { apiBase: api, now });
    expect(serverScrubSet.values()).toContain(pem);
    expect(serverScrubSet.values()).toContain(jwt);
    serverScrubSet.clear();
  });
});
