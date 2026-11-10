import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';

export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
export const SUDO_MS = 5 * 60_000;

export const SESSION_COOKIE = 'jm_session';
export const SETUP_COOKIE = 'jm_setup';

export type Session = {
  idHash: string;
  csrf: string;
  createdAt: string;
  lastSeenAt: string;
  sudoUntil: string | null;
};

export const sha256Hex = (v: string): string => createHash('sha256').update(v).digest('hex');

/** A new session: the id goes to the cookie, only its SHA-256 to the database. */
export function createSession(db: Db, now: Date): { id: string; csrf: string } {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const at = now.toISOString();
  // Expired sessions go whenever a new one is made, so the table stays small without a timer.
  db.prepare('DELETE FROM sessions WHERE created_at <= ? OR last_seen_at <= ?').run(
    new Date(now.getTime() - SESSION_ABSOLUTE_MS).toISOString(),
    new Date(now.getTime() - SESSION_IDLE_MS).toISOString(),
  );
  db.prepare(
    'INSERT INTO sessions (id_hash, csrf, created_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).run(sha256Hex(id), csrf, at, at);
  return { id, csrf };
}

/**
 * The live session for a cookie value, its last-seen time refreshed; null (and the row deleted)
 * when it has been idle 12 hours or exists 7 days.
 */
export function loadSession(db: Db, id: string, now: Date): Session | null {
  if (!id) return null;
  const idHash = sha256Hex(id);
  const row = db
    .prepare(
      `SELECT id_hash AS idHash, csrf, created_at AS createdAt, last_seen_at AS lastSeenAt,
              sudo_until AS sudoUntil FROM sessions WHERE id_hash = ?`,
    )
    .get(idHash) as Session | undefined;
  if (!row) return null;
  const t = now.getTime();
  if (
    t - Date.parse(row.lastSeenAt) >= SESSION_IDLE_MS ||
    t - Date.parse(row.createdAt) >= SESSION_ABSOLUTE_MS
  ) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return null;
  }
  const lastSeenAt = now.toISOString();
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(lastSeenAt, idHash);
  return { ...row, lastSeenAt };
}

/** Sudo for five minutes: the passphrase was just re-entered. Keyed by the stored hash. */
export function grantSudo(db: Db, idHash: string, now: Date): string {
  const until = new Date(now.getTime() + SUDO_MS).toISOString();
  db.prepare('UPDATE sessions SET sudo_until = ? WHERE id_hash = ?').run(until, idHash);
  return until;
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(id));
}

/** Every session ends: on any passphrase change and on setup reopen. Returns how many. */
export function deleteAllSessions(db: Db): number {
  return db.prepare('DELETE FROM sessions').run().changes;
}

/** The cookies a browser sent, by name. */
export function parseCookies(header: string | undefined): Record<string, string> {
  // No prototype: a cookie named __proto__ or toString is just a name here.
  const out: Record<string, string> = Object.create(null);
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * A cookie the scripts cannot read and no other site's request carries. `Secure` only behind a
 * TLS terminator the operator declared (`listen.tlsTerminated`): the UI is loopback or a tunnel
 * by default, plain HTTP there, and `config.listen` fails a non-loopback login without TLS.
 */
export const setCookie = (
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure = false,
): string =>
  `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;

export const clearCookie = (name: string, secure = false): string => setCookie(name, '', 0, secure);
