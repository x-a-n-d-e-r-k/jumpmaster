import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readSecretFile } from '@jumpmaster/protocol';
import type { Db } from '../db/open.js';

/**
 * The vault (§7.5): values encrypted at rest with AES-256-GCM under a 32-byte key read from
 * `JM_VAULT_KEY_FILE`, a file under `./secrets`, outside the data volume, so the database alone
 * (a backup, a `VACUUM INTO` copy) holds ciphertext only. Each write has a fresh 12-byte nonce and
 * the entry's name as additional data, so a row moved under another name does not decrypt.
 *
 * The vault knows names and bytes, nothing about credentials (vault/credentials.ts does).
 */

export const VAULT_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The first 8 hex characters of SHA-256: what the UI shows, never a substring or the length. */
export const fingerprintOf = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 8);

export const KEY_CHANGED =
  'the vault key changed: restore the key file or re-enter each credential';

/** A value that does not decrypt under this key (a changed key, or a row moved by hand). */
export class VaultKeyError extends Error {}

export type VaultMeta = {
  name: string;
  fingerprint: string;
  keyId: string;
  createdAt: string;
  declaredCreatedAt?: string;
  testedAt?: string;
  testResult?: string;
  login?: string;
  note?: string;
};

export type VaultRow = {
  name: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  fingerprint: string;
  created_at: string;
  declared_created_at: string | null;
  tested_at: string | null;
  test_result: string | null;
  login: string | null;
  note: string | null;
};

const metaOf = (r: VaultRow): VaultMeta => ({
  name: r.name,
  fingerprint: r.fingerprint,
  keyId: r.key_id,
  createdAt: r.created_at,
  ...(r.declared_created_at ? { declaredCreatedAt: r.declared_created_at } : {}),
  ...(r.tested_at ? { testedAt: r.tested_at } : {}),
  ...(r.test_result ? { testResult: r.test_result } : {}),
  ...(r.login ? { login: r.login } : {}),
  ...(r.note ? { note: r.note } : {}),
});

/** How many entries the vault holds (readable without the key). */
export function vaultCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM vault').get() as { n: number }).n;
}

export class Vault {
  readonly keyId: string;

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {
    if (key.length !== VAULT_KEY_BYTES) throw new Error('a vault key is 32 bytes');
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 8);
  }

  count(): number {
    return vaultCount(this.db);
  }

  list(): VaultMeta[] {
    return (this.db.prepare('SELECT * FROM vault ORDER BY name').all() as VaultRow[]).map(metaOf);
  }

  meta(name: string): VaultMeta | undefined {
    const r = this.row(name);
    return r ? metaOf(r) : undefined;
  }

  /** The plain value, or undefined when there is no entry; throws VaultKeyError when it won't decrypt. */
  get(name: string): string | undefined {
    const r = this.row(name);
    if (!r) return undefined;
    try {
      const body = r.ciphertext.subarray(0, r.ciphertext.length - TAG_BYTES);
      const tag = r.ciphertext.subarray(r.ciphertext.length - TAG_BYTES);
      const d = createDecipheriv('aes-256-gcm', this.key, r.nonce);
      d.setAAD(Buffer.from(name, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    } catch {
      // The error names the entry, never a value or the key.
      throw new VaultKeyError(`${KEY_CHANGED} (${name})`);
    }
  }

  /**
   * Writes (or replaces) an entry in one statement: a fresh nonce, the name as AAD. A replace
   * clears the previous test result and login, which belonged to the previous value.
   */
  put(
    name: string,
    value: string,
    o: { now: Date; declaredCreatedAt?: string; note?: string },
  ): VaultMeta {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv('aes-256-gcm', this.key, nonce);
    c.setAAD(Buffer.from(name, 'utf8'));
    const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final(), c.getAuthTag()]);
    this.db
      .prepare(
        `INSERT INTO vault (name, ciphertext, nonce, key_id, fingerprint, created_at, declared_created_at, note)
         VALUES (@name, @ciphertext, @nonce, @keyId, @fingerprint, @createdAt, @declared, @note)
         ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce,
           key_id = excluded.key_id, fingerprint = excluded.fingerprint,
           created_at = excluded.created_at, declared_created_at = excluded.declared_created_at,
           note = excluded.note, tested_at = NULL, test_result = NULL, login = NULL`,
      )
      .run({
        name,
        ciphertext,
        nonce,
        keyId: this.keyId,
        fingerprint: fingerprintOf(value),
        createdAt: o.now.toISOString(),
        declared: o.declaredCreatedAt ?? null,
        note: o.note ?? null,
      });
    return this.meta(name) as VaultMeta;
  }

  /** The result of testing an entry's value: a status word and, for a forge token, its login. */
  recordTest(name: string, t: { at: Date; result: string; login?: string }): void {
    this.db
      .prepare('UPDATE vault SET tested_at = ?, test_result = ?, login = ? WHERE name = ?')
      .run(t.at.toISOString(), t.result, t.login ?? null, name);
  }

  /** The raw row (ciphertext and metadata), to put back exactly when a rotation fails. */
  snapshot(name: string): VaultRow | undefined {
    return this.row(name);
  }

  /** Puts a snapshot back (or removes the entry when there was none). */
  restore(name: string, row: VaultRow | undefined): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM vault WHERE name = ?').run(name);
      if (row)
        this.db
          .prepare(
            `INSERT INTO vault (name, ciphertext, nonce, key_id, fingerprint, created_at, declared_created_at, tested_at, test_result, login, note)
             VALUES (@name, @ciphertext, @nonce, @key_id, @fingerprint, @created_at, @declared_created_at, @tested_at, @test_result, @login, @note)`,
          )
          .run(row);
    })();
  }

  delete(name: string): boolean {
    return this.db.prepare('DELETE FROM vault WHERE name = ?').run(name).changes > 0;
  }

  /** Whether every entry decrypts under this key (doctor `vault.key`). */
  keyStatus(): { status: 'ok' | 'empty' } | { status: 'mismatch'; names: string[] } {
    const names = this.list().map((m) => m.name);
    if (names.length === 0) return { status: 'empty' };
    const bad = names.filter((n) => {
      try {
        this.get(n);
        return false;
      } catch {
        return true;
      }
    });
    return bad.length > 0 ? { status: 'mismatch', names: bad } : { status: 'ok' };
  }

  private row(name: string): VaultRow | undefined {
    return this.db.prepare('SELECT * FROM vault WHERE name = ?').get(name) as VaultRow | undefined;
  }
}

/**
 * The vault for this install. The key is 32 random bytes, base64url, in the file `keyFile`
 * (`JM_VAULT_KEY_FILE`), read with every check a secret file gets. Without a key file: an empty
 * vault is `'disabled'` (credentials come from files and the environment only), a non-empty one
 * refuses the start, since the key and the data travel together.
 */
export function openVault(
  keyFile: string | undefined,
  db: Db,
  dataDir = 'the data directory',
): Vault | 'disabled' {
  if (!keyFile) {
    const n = vaultCount(db);
    if (n === 0) return 'disabled';
    throw new Error(
      `the vault at ${dataDir} holds ${n} credentials but JM_VAULT_KEY_FILE is unset: the key and the data travel together`,
    );
  }
  const text = readSecretFile(keyFile, 'JM_VAULT_KEY_FILE');
  const key = /^[A-Za-z0-9_-]+=*$/.test(text) ? Buffer.from(text, 'base64url') : Buffer.alloc(0);
  if (key.length !== VAULT_KEY_BYTES)
    throw new Error(
      `JM_VAULT_KEY_FILE: ${keyFile} must hold 32 random bytes, base64url (as bootstrap and init write it)`,
    );
  return new Vault(db, key);
}
