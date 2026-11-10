import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/open.js';
import { deleteAllSessions, sha256Hex } from './sessions.js';

export const MIN_PASSPHRASE = 12;
export const MAX_PASSPHRASE = 256;

/** scrypt's cost: N=2^15, r=8, p=1, a 32-byte salt and a 32-byte hash (§7.5, Review Focus 2). */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, saltBytes: 32, keyBytes: 32 } as const;
/** 128·N·r is 32 MiB at these costs, Node's default ceiling: room above it. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Why a passphrase cannot be used, or null. */
export function passphraseProblem(p: string): string | null {
  if (p.length < MIN_PASSPHRASE)
    return `the passphrase must be at least ${MIN_PASSPHRASE} characters`;
  if (p.length > MAX_PASSPHRASE)
    return `the passphrase must be at most ${MAX_PASSPHRASE} characters`;
  return null;
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>`, with a fresh salt each time. */
export function hashPassphrase(p: string): string {
  const { N, r, p: par, saltBytes, keyBytes } = SCRYPT;
  const salt = randomBytes(saltBytes);
  const hash = scryptSync(p, salt, keyBytes, { N, r, p: par, maxmem: SCRYPT_MAXMEM });
  return ['scrypt', N, r, par, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Whether `p` is the passphrase `stored` was made from, compared in constant time. */
export function verifyPassphrase(p: string, stored: string): boolean {
  const [kind, n, r, par, salt64, hash64] = stored.split('$');
  if (kind !== 'scrypt' || !salt64 || !hash64) return false;
  // Only the parameters this build writes: a tampered row cannot ask for a huge or tiny cost.
  if (Number(n) !== SCRYPT.N || Number(r) !== SCRYPT.r || Number(par) !== SCRYPT.p) return false;
  const want = Buffer.from(hash64, 'base64');
  if (want.length !== SCRYPT.keyBytes) return false;
  const got = scryptSync(p, Buffer.from(salt64, 'base64'), want.length, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(got, want);
}

/** Setup mode: no operator has chosen a passphrase yet. */
export function setupActive(db: Db): boolean {
  return db.prepare('SELECT 1 FROM operator WHERE id = 1').get() === undefined;
}

export function operatorHash(db: Db): string | null {
  const row = db.prepare('SELECT passphrase_hash AS h FROM operator WHERE id = 1').get() as
    | { h: string }
    | undefined;
  return row?.h ?? null;
}

/**
 * Claims the install (no operator yet) or replaces the passphrase. Either way every session ends,
 * in the same transaction. The caller has checked `passphraseProblem`.
 */
export function setOperatorPassphrase(
  db: Db,
  passphrase: string,
  now: Date,
): 'claimed' | 'replaced' {
  const hash = hashPassphrase(passphrase);
  const at = now.toISOString();
  return db.transaction(() => {
    deleteAllSessions(db);
    const replaced = db
      .prepare('UPDATE operator SET passphrase_hash = ?, rotated_at = ? WHERE id = 1')
      .run(hash, at).changes;
    if (replaced > 0) return 'replaced' as const;
    db.prepare('INSERT INTO operator (id, passphrase_hash, created_at) VALUES (1, ?, ?)').run(
      hash,
      at,
    );
    return 'claimed' as const;
  })();
}

/** Reopens setup: the operator row and every session go. */
export function deleteOperator(db: Db): void {
  db.transaction(() => {
    deleteAllSessions(db);
    db.prepare('DELETE FROM operator').run();
  })();
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** What the server holds of a setup code: its hash only. */
export type SetupState = { codeHash: Buffer };

const codeHash = (normalized: string): Buffer => createHash('sha256').update(normalized).digest();
/** Case, dashes and spaces are forgiven: the code is read off a log and typed. */
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');

/** A fresh code: three groups of four base32 characters, 60 random bits. */
export function newSetupCode(): { code: string; state: SetupState } {
  const chars = Array.from({ length: 12 }, () => BASE32[randomInt(32)]).join('');
  const code = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
  return { code, state: { codeHash: codeHash(chars) } };
}

export function setupCodeMatches(state: SetupState, given: string): boolean {
  return timingSafeEqual(codeHash(normalizeCode(given)), state.codeHash);
}

export const SETUP_CODE_PREFIX = 'JUMPMASTER SETUP CODE: ';
/** How long the `jm_setup` claim lasts once the code was entered. */
export const SETUP_CLAIM_MS = 10 * 60_000;

const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '']);

/** The line printed to stderr, alone, when setup is open. */
export function setupCodeLine(code: string, listen: { host: string; port: number }): string {
  const bare = WILDCARD.has(listen.host) ? '127.0.0.1' : listen.host;
  // An IPv6 literal needs its brackets in a URL.
  const host = bare.includes(':') && !bare.startsWith('[') ? `[${bare}]` : bare;
  return `${SETUP_CODE_PREFIX}${code}  (open http://${host}:${listen.port}/setup; a restart prints a new code)`;
}

/**
 * The setup code and its claims, in memory only: never in a page, a cookie, a URL or the database.
 * A code is accepted once; it yields a claim (the `jm_setup` cookie) that lasts ten minutes and
 * allows choosing the passphrase.
 */
export class SetupMode {
  private state: SetupState | null = null;
  private readonly claims = new Map<string, number>();

  constructor(private readonly print: (code: string) => void) {}

  /** A fresh code replaces any earlier one and is printed. */
  rotateSetupCode(): void {
    const { code, state } = newSetupCode();
    this.state = state;
    this.print(code);
  }

  /** A claim token when `code` is the current code (which is then spent), else null. */
  accept(code: string, now: Date): string | null {
    if (!this.state || !setupCodeMatches(this.state, code)) return null;
    this.state = null;
    const claim = randomBytes(32).toString('base64url');
    this.claims.set(sha256Hex(claim), now.getTime() + SETUP_CLAIM_MS);
    return claim;
  }

  claimValid(claim: string, now: Date): boolean {
    if (!claim) return false;
    const until = this.claims.get(sha256Hex(claim));
    return until !== undefined && now.getTime() < until;
  }

  /** Setup ended (or reopened): no code and no claim stays valid. */
  clear(): void {
    this.state = null;
    this.claims.clear();
  }
}
