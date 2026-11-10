import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  deleteOperator,
  hashPassphrase,
  MAX_PASSPHRASE,
  MIN_PASSPHRASE,
  newSetupCode,
  passphraseProblem,
  SETUP_CLAIM_MS,
  SETUP_CODE_PREFIX,
  SetupMode,
  setOperatorPassphrase,
  setupActive,
  setupCodeLine,
  setupCodeMatches,
  verifyPassphrase,
} from './operator.js';
import { createSession, loadSession } from './sessions.js';

describe('passphrases', () => {
  test('a passphrase under 12 characters is refused and the stored hash is scrypt with a fresh salt per hash', () => {
    expect(MIN_PASSPHRASE).toBe(12);
    expect(MAX_PASSPHRASE).toBe(256);
    expect(passphraseProblem('a'.repeat(11))).toMatch(/at least 12/);
    expect(passphraseProblem('a'.repeat(12))).toBeNull();
    expect(passphraseProblem('a'.repeat(257))).toMatch(/at most 256/);
    const p = 'correct horse battery';
    const a = hashPassphrase(p);
    const b = hashPassphrase(p);
    const parts = a.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', String(2 ** 15), '8', '1']);
    expect(Buffer.from(parts[4] ?? '', 'base64')).toHaveLength(32);
    expect(Buffer.from(parts[5] ?? '', 'base64')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(a).not.toContain(p);
    expect(verifyPassphrase(p, a)).toBe(true);
    expect(verifyPassphrase(p, b)).toBe(true);
    expect(verifyPassphrase(`${p}!`, a)).toBe(false);
    expect(verifyPassphrase(p, 'garbage')).toBe(false);
    expect(verifyPassphrase(p, 'scrypt$1$1$1$$')).toBe(false);
  });
});

describe('the operator row', () => {
  test('setup is active until a passphrase exists; setting one claims, then replaces, and deletes every session', () => {
    const db = openDb(tmpDbFile());
    expect(setupActive(db)).toBe(true);
    createSession(db, t0);
    expect(setOperatorPassphrase(db, 'first passphrase', t0)).toBe('claimed');
    expect(setupActive(db)).toBe(false);
    const s = createSession(db, t0);
    expect(setOperatorPassphrase(db, 'second passphrase', plus(t0, 1000))).toBe('replaced');
    expect(loadSession(db, s.id, t0)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    expect(db.prepare('SELECT created_at AS c, rotated_at AS r FROM operator').get()).toEqual({
      c: t0.toISOString(),
      r: plus(t0, 1000).toISOString(),
    });
    deleteOperator(db);
    expect(setupActive(db)).toBe(true);
  });
});

describe('setup codes', () => {
  test('a code is three groups of four base32 characters, 60 bits, matched loosely in constant time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { code, state } = newSetupCode();
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(setupCodeMatches(state, code)).toBe(true);
      expect(setupCodeMatches(state, code.toLowerCase().replaceAll('-', ' '))).toBe(true);
      expect(setupCodeMatches(state, ` ${code.replaceAll('-', '')} `)).toBe(true);
      expect(setupCodeMatches(state, 'AAAA-AAAA-AAAA')).toBe(code === 'AAAA-AAAA-AAAA');
      expect(setupCodeMatches(state, '')).toBe(false);
      seen.add(code);
      // Only a hash is held.
      expect(JSON.stringify(state)).not.toContain(code.replaceAll('-', ''));
    }
    expect(seen.size).toBe(50);
  });

  test('the printed line has a fixed prefix and names a loopback URL for a wildcard listen', () => {
    expect(SETUP_CODE_PREFIX).toBe('JUMPMASTER SETUP CODE: ');
    expect(setupCodeLine('ABCD-EFGH-JKLM', { host: '0.0.0.0', port: 7420 })).toBe(
      'JUMPMASTER SETUP CODE: ABCD-EFGH-JKLM  (open http://127.0.0.1:7420/setup; a restart prints a new code)',
    );
    expect(setupCodeLine('ABCD-EFGH-JKLM', { host: '::', port: 1 })).toContain(
      'http://127.0.0.1:1/setup',
    );
    expect(setupCodeLine('ABCD-EFGH-JKLM', { host: 'localhost', port: 2 })).toContain(
      'http://localhost:2/setup',
    );
    expect(setupCodeLine('ABCD-EFGH-JKLM', { host: '::1', port: 3 })).toContain(
      'http://[::1]:3/setup',
    );
  });

  test('a code is accepted once; the claim it yields lasts ten minutes', () => {
    const printed: string[] = [];
    const s = new SetupMode((code) => printed.push(code));
    expect(s.accept('AAAA-AAAA-AAAA', t0)).toBeNull();
    s.rotateSetupCode();
    expect(printed).toHaveLength(1);
    const code = printed[0] as string;
    expect(s.accept('WRONG', t0)).toBeNull();
    const claim = s.accept(code, t0);
    expect(claim).toEqual(expect.any(String));
    expect(claim).not.toContain(code);
    expect(s.accept(code, t0)).toBeNull();
    expect(SETUP_CLAIM_MS).toBe(10 * 60_000);
    expect(s.claimValid(claim ?? '', plus(t0, SETUP_CLAIM_MS - 1))).toBe(true);
    expect(s.claimValid(claim ?? '', plus(t0, SETUP_CLAIM_MS))).toBe(false);
    expect(s.claimValid('other', t0)).toBe(false);
  });

  test('rotating prints a fresh code and retires the old one; clear ends every code and claim', () => {
    const printed: string[] = [];
    const s = new SetupMode((code) => printed.push(code));
    s.rotateSetupCode();
    s.rotateSetupCode();
    expect(printed).toHaveLength(2);
    expect(s.accept(printed[0] as string, t0)).toBeNull();
    const claim = s.accept(printed[1] as string, t0) as string;
    s.rotateSetupCode();
    s.clear();
    expect(s.claimValid(claim, t0)).toBe(false);
    expect(s.accept(printed[2] as string, t0)).toBeNull();
  });
});
