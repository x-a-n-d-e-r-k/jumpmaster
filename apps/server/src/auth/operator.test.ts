import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  deleteOperator,
  hashPassphrase,
  MAX_PASSPHRASE,
  MIN_PASSPHRASE,
  newSetupCode,
  OperatorExistsError,
  passphraseProblem,
  SCRYPT_QUEUE,
  ScryptBusyError,
  SETUP_CLAIM_MS,
  SETUP_CODE_PREFIX,
  SetupMode,
  scryptStats,
  setOperatorPassphrase,
  setupActive,
  setupCodeLine,
  setupCodeMatches,
  verifyPassphrase,
} from './operator.js';
import { createSession, loadSession } from './sessions.js';

describe('passphrases', () => {
  test('a passphrase under 12 characters is refused and the stored hash is scrypt with a fresh salt per hash', async () => {
    expect(MIN_PASSPHRASE).toBe(12);
    expect(MAX_PASSPHRASE).toBe(256);
    expect(passphraseProblem('a'.repeat(11))).toMatch(/at least 12/);
    expect(passphraseProblem('a'.repeat(12))).toBeNull();
    expect(passphraseProblem('a'.repeat(257))).toMatch(/at most 256/);
    // Code points, not UTF-16 units: six astral characters are six.
    expect(passphraseProblem('\u{1F600}'.repeat(6))).toMatch(/at least 12/);
    expect(passphraseProblem('\u{1F600}'.repeat(12))).toBeNull();
    expect(passphraseProblem('\u{1F600}'.repeat(200))).toBeNull();
    const p = 'correct horse battery';
    const a = await hashPassphrase(p);
    const b = await hashPassphrase(p);
    const parts = a.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', String(2 ** 15), '8', '1']);
    expect(Buffer.from(parts[4] ?? '', 'base64')).toHaveLength(32);
    expect(Buffer.from(parts[5] ?? '', 'base64')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(a).not.toContain(p);
    expect(await verifyPassphrase(p, a)).toBe(true);
    expect(await verifyPassphrase(p, b)).toBe(true);
    expect(await verifyPassphrase(`${p}!`, a)).toBe(false);
    expect(await verifyPassphrase(p, 'garbage')).toBe(false);
    expect(await verifyPassphrase(p, 'scrypt$1$1$1$$')).toBe(false);
  });

  test('hashing and checking run off the event loop, one at a time, with a bounded queue', async () => {
    const stored = await hashPassphrase('a long operator passphrase');
    // No clock: the loop reaching its check phase before the first result is "off the loop".
    let loopTurned = false;
    setImmediate(() => {
      loopTurned = true;
    });
    const pending = Array.from({ length: 4 }, (_, i) =>
      verifyPassphrase(i === 0 ? 'a long operator passphrase' : `wrong ${i}`, stored),
    );
    expect(loopTurned).toBe(false); // the four calls returned at once
    expect(scryptStats()).toEqual({ running: 1, queued: 3 });
    expect(await pending[0]).toBe(true);
    expect(loopTurned).toBe(true); // the loop turned while scrypt ran
    expect(await Promise.all(pending)).toEqual([true, false, false, false]);
    expect(scryptStats()).toEqual({ running: 0, queued: 0 });
  });

  test('a burst past the queue is refused as busy, not run, and not queued', async () => {
    const stored = await hashPassphrase('a long operator passphrase');
    const burst = Array.from({ length: SCRYPT_QUEUE + 1 }, () =>
      verifyPassphrase('wrong passphrase', stored).then(
        () => 'ran',
        (e: unknown) => (e instanceof ScryptBusyError ? 'busy' : 'other'),
      ),
    );
    const extra = await verifyPassphrase('wrong passphrase', stored).then(
      () => 'ran',
      (e: unknown) => (e instanceof ScryptBusyError ? 'busy' : 'other'),
    );
    expect(extra).toBe('busy');
    const outcomes = await Promise.all(burst);
    expect(outcomes.filter((o) => o === 'ran')).toHaveLength(SCRYPT_QUEUE + 1);
  }, 60_000);
});

describe('the operator row', () => {
  test('setup is active until a passphrase exists; setting one claims, then replaces, and deletes every session', async () => {
    const db = openDb(tmpDbFile());
    expect(setupActive(db)).toBe(true);
    createSession(db, t0);
    expect(await setOperatorPassphrase(db, 'first passphrase', t0)).toEqual({
      result: 'claimed',
      sessionsDeleted: 1,
    });
    expect(setupActive(db)).toBe(false);
    const s = createSession(db, t0);
    expect(await setOperatorPassphrase(db, 'second passphrase', plus(t0, 1000))).toEqual({
      result: 'replaced',
      sessionsDeleted: 1,
    });
    expect(loadSession(db, s.id, t0)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c).toBe(0);
    expect(db.prepare('SELECT created_at AS c, rotated_at AS r FROM operator').get()).toEqual({
      c: t0.toISOString(),
      r: plus(t0, 1000).toISOString(),
    });
    // The setup page only claims: an operator already there is never replaced from it.
    await expect(
      setOperatorPassphrase(db, 'third passphrase', t0, { expect: 'claim' }),
    ).rejects.toThrow(OperatorExistsError);
    deleteOperator(db);
    expect(setupActive(db)).toBe(true);
    expect(await setOperatorPassphrase(db, 'third passphrase', t0, { expect: 'claim' })).toEqual({
      result: 'claimed',
      sessionsDeleted: 0,
    });
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

  test('rotating ends every claim, so a claim from a spent code cannot outlive ctl setup-code', () => {
    const printed: string[] = [];
    const s = new SetupMode((code) => printed.push(code));
    s.rotateSetupCode();
    const claim = s.accept(printed[0] as string, t0) as string;
    expect(s.claimValid(claim, t0)).toBe(true);
    s.rotateSetupCode();
    expect(s.claimValid(claim, t0)).toBe(false);
  });
});
