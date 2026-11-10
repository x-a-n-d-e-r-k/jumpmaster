import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  credentialCreatedAt,
  credentialFingerprint,
  gateSecretName,
  resolveCredentials,
  SECRET_FILES,
  shadowedCredentials,
  testCredential,
} from './credentials.js';
import { fingerprintOf, openVault, type Vault } from './vault.js';

const CLAUDE = 'sk-ant-oat01-CLAUDEVALUE-0001';
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
  test('SECRET_FILES names the four credential files', () => {
    expect(SECRET_FILES).toEqual({
      claudeToken: 'claude_token',
      githubAuthorToken: 'github_author_token',
      githubReviewerToken: 'github_reviewer_token',
      githubReadToken: 'github_read_token',
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
  const FAILED = 'github_pat_FAILEDTESTVALUE_distinct_9999';
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
    expect(r).toEqual({ ok: true, result: 'ok', login: 'author-bot' });
    expect(f.calls).toEqual(['login octo/web', 'access octo/web', 'access octo/api']);
    // The read token: its login only.
    const g = forgeFake({});
    expect(await testCredential('githubReadToken', READ, { zones, forge: g.forge })).toMatchObject({
      ok: true,
    });
    expect(g.calls).toEqual(['login octo/web']);
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
