import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import {
  clearCookie,
  createSession,
  deleteAllSessions,
  deleteSession,
  grantSudo,
  loadSession,
  parseCookies,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SUDO_MS,
  setCookie,
  sha256Hex,
} from './sessions.js';

const HOUR = 3_600_000;
const rows = (db: ReturnType<typeof openDb>) =>
  (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;

test('the limits are 12 hours idle, 7 days absolute and 5 minutes of sudo', () => {
  expect(SESSION_IDLE_MS).toBe(12 * HOUR);
  expect(SESSION_ABSOLUTE_MS).toBe(7 * 24 * HOUR);
  expect(SUDO_MS).toBe(5 * 60_000);
});

test('a session id is stored only as its SHA-256; the CSRF token is per session', () => {
  const db = openDb(tmpDbFile());
  const a = createSession(db, t0);
  const b = createSession(db, t0);
  expect(a.id).not.toBe(b.id);
  expect(a.csrf).not.toBe(b.csrf);
  const stored = db.prepare('SELECT id_hash AS h FROM sessions').all() as { h: string }[];
  expect(stored.map((r) => r.h).sort()).toEqual(
    [a.id, b.id].map((id) => createHash('sha256').update(id).digest('hex')).sort(),
  );
  const s = loadSession(db, a.id, t0);
  expect(s?.csrf).toBe(a.csrf);
  expect(loadSession(db, 'nope', t0)).toBeNull();
});

test('a session idle for 12 hours or older than 7 days is refused and deleted', () => {
  const db = openDb(tmpDbFile());
  const idle = createSession(db, t0);
  expect(loadSession(db, idle.id, plus(t0, SESSION_IDLE_MS - 1))).not.toBeNull();
  // The load above refreshed last_seen_at, so the idle clock restarts from there.
  expect(loadSession(db, idle.id, plus(t0, 2 * SESSION_IDLE_MS - 2))).not.toBeNull();
  expect(loadSession(db, idle.id, plus(t0, 3 * SESSION_IDLE_MS))).toBeNull();
  expect(rows(db)).toBe(0);

  const old = createSession(db, t0);
  // Kept busy, it still ends at seven days.
  for (let at = 0; at < SESSION_ABSOLUTE_MS; at += 6 * HOUR) {
    expect(loadSession(db, old.id, plus(t0, at))).not.toBeNull();
  }
  expect(loadSession(db, old.id, plus(t0, SESSION_ABSOLUTE_MS))).toBeNull();
  expect(rows(db)).toBe(0);
});

test('sudo lasts five minutes from the grant', () => {
  const db = openDb(tmpDbFile());
  const s = createSession(db, t0);
  expect(loadSession(db, s.id, t0)?.sudoUntil).toBeNull();
  grantSudo(db, sha256Hex(s.id), t0);
  expect(loadSession(db, s.id, t0)?.sudoUntil).toBe(plus(t0, SUDO_MS).toISOString());
});

test('logout deletes one session; a passphrase change deletes them all', () => {
  const db = openDb(tmpDbFile());
  const a = createSession(db, t0);
  const b = createSession(db, t0);
  deleteSession(db, a.id);
  expect(loadSession(db, a.id, t0)).toBeNull();
  expect(loadSession(db, b.id, t0)).not.toBeNull();
  expect(deleteAllSessions(db)).toBe(1);
  expect(rows(db)).toBe(0);
});

test('cookies are HttpOnly, SameSite=Strict and Path=/, without Secure', () => {
  expect(setCookie('jm_session', 'v', 60)).toBe(
    'jm_session=v; HttpOnly; SameSite=Strict; Path=/; Max-Age=60',
  );
  expect(clearCookie('jm_setup')).toBe('jm_setup=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  expect(parseCookies('a=1; jm_session=abc=; b')).toEqual({ a: '1', jm_session: 'abc=' });
  expect(parseCookies(undefined)).toEqual({});
});
