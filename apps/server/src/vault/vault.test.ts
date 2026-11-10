import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type Db, openDb } from '../db/open.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import { fingerprintOf, openVault, Vault, VaultKeyError } from './vault.js';

const VALUE = 'sk-ant-oat01-VAULTVALUE-0123456789';

function keyFile(key = randomBytes(32), mode = 0o600): string {
  const f = join(mkdtempSync(join(tmpdir(), 'jm-vault-')), 'vault_key');
  writeFileSync(f, `${key.toString('base64url')}\n`, { mode });
  chmodSync(f, mode);
  return f;
}
const open = (db: Db, file: string): Vault => {
  const v = openVault(file, db);
  if (v === 'disabled') throw new Error('expected a vault');
  return v;
};
const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
};

describe('the vault', () => {
  test('a value round-trips through AES-256-GCM with the name as AAD and a fresh nonce per write', () => {
    const dbFile = tmpDbFile();
    const db = openDb(dbFile);
    const key = randomBytes(32);
    const v = open(db, keyFile(key));
    expect(v.keyId).toBe(createHash('sha256').update(key).digest('hex').slice(0, 8));
    const meta = v.put('claudeToken', VALUE, { now: t0 });
    expect(meta).toMatchObject({
      name: 'claudeToken',
      fingerprint: fingerprintOf(VALUE),
      keyId: v.keyId,
      createdAt: t0.toISOString(),
    });
    expect(v.get('claudeToken')).toBe(VALUE);
    const nonce = () =>
      (db.prepare("SELECT nonce FROM vault WHERE name = 'claudeToken'").get() as { nonce: Buffer })
        .nonce;
    const first = Buffer.from(nonce());
    expect(first).toHaveLength(12);
    v.put('claudeToken', VALUE, { now: plus(t0, 1000) });
    expect(Buffer.from(nonce()).equals(first)).toBe(false);
    // The name is the AAD: a row moved under another name does not decrypt.
    db.prepare(
      "INSERT INTO vault (name, ciphertext, nonce, key_id, fingerprint, created_at) SELECT 'githubAuthorToken', ciphertext, nonce, key_id, fingerprint, created_at FROM vault WHERE name = 'claudeToken'",
    ).run();
    expect(() => v.get('githubAuthorToken')).toThrow(VaultKeyError);
    // Only ciphertext rests in the database file.
    db.close();
    expect(readFileSync(dbFile).includes(Buffer.from(VALUE))).toBe(false);
  });

  test('a wrong key fails to decrypt with an error that names no value, and keyStatus says mismatch', () => {
    const db = openDb(tmpDbFile());
    open(db, keyFile()).put('githubAuthorToken', VALUE, { now: t0 });
    const other = open(db, keyFile());
    const msg = thrown(() => other.get('githubAuthorToken'));
    expect(msg).toBe(
      'the vault key changed: restore the key file or re-enter each credential (githubAuthorToken)',
    );
    expect(msg).not.toContain(VALUE);
    expect(other.keyStatus()).toEqual({ status: 'mismatch', names: ['githubAuthorToken'] });
    expect(open(db, keyFile()).meta('githubAuthorToken')?.fingerprint).toBe(fingerprintOf(VALUE));
  });

  test('a missing key file with a non-empty vault refuses startup with the travel-together message; an empty one is disabled', () => {
    const db = openDb(tmpDbFile());
    expect(openVault(undefined, db, '/data')).toBe('disabled');
    open(db, keyFile()).put('claudeToken', VALUE, { now: t0 });
    expect(thrown(() => openVault(undefined, db, '/data'))).toBe(
      'the vault at /data holds 1 credentials but JM_VAULT_KEY_FILE is unset: the key and the data travel together',
    );
  });

  test('a key file that is not 32 bytes of base64url, or is writable by others, is refused by name', () => {
    const db = openDb(tmpDbFile());
    const short = join(mkdtempSync(join(tmpdir(), 'jm-vault-')), 'vault_key');
    writeFileSync(short, 'abc\n', { mode: 0o600 });
    expect(thrown(() => openVault(short, db))).toBe(
      `JM_VAULT_KEY_FILE: ${short} must hold 32 random bytes, base64url (as bootstrap and init write it)`,
    );
    const open666 = keyFile(randomBytes(32), 0o666);
    expect(thrown(() => openVault(open666, db))).toContain('is group- or world-writable');
  });

  test('test results, logins and dates are kept beside the ciphertext; delete removes the row', () => {
    const db = openDb(tmpDbFile());
    const v = open(db, keyFile());
    v.put('githubReviewerToken', VALUE, { now: t0, declaredCreatedAt: '2026-01-02', note: 'n' });
    v.recordTest('githubReviewerToken', { at: plus(t0, 5), result: 'ok', login: 'rev-bot' });
    expect(v.meta('githubReviewerToken')).toEqual({
      name: 'githubReviewerToken',
      fingerprint: fingerprintOf(VALUE),
      keyId: v.keyId,
      createdAt: t0.toISOString(),
      declaredCreatedAt: '2026-01-02',
      testedAt: plus(t0, 5).toISOString(),
      testResult: 'ok',
      login: 'rev-bot',
      note: 'n',
    });
    // A failed test records its result and keeps the login the last passing test found.
    v.recordTest('githubReviewerToken', { at: plus(t0, 9), result: 'failed (503)' });
    expect(v.meta('githubReviewerToken')).toMatchObject({
      login: 'rev-bot',
      testResult: 'failed (503)',
    });
    v.recordTest('githubReviewerToken', { at: plus(t0, 10), result: 'ok', login: 'rev-bot-2' });
    expect(v.meta('githubReviewerToken')?.login).toBe('rev-bot-2');
    v.recordTest('githubReviewerToken', { at: plus(t0, 5), result: 'ok', login: 'rev-bot' });
    expect(v.list().map((m) => m.name)).toEqual(['githubReviewerToken']);
    expect(v.count()).toBe(1);
    expect(v.delete('githubReviewerToken')).toBe(true);
    expect(v.delete('githubReviewerToken')).toBe(false);
    expect(v.get('githubReviewerToken')).toBeUndefined();
  });

  test('fingerprintOf is the first 8 hex characters of SHA-256, never a substring or the length', () => {
    expect(fingerprintOf('abc')).toBe('ba7816bf');
    expect(fingerprintOf(VALUE)).not.toContain(VALUE.slice(0, 4));
  });
});
