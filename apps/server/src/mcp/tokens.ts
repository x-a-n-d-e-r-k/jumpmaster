import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';

export type McpScope = 'read' | 'write' | 'chat';
/** The scopes an operator can mint for a zone; `chat` tokens are minted per turn by the server. */
export const MCP_SCOPES = ['read', 'write'] as const;
export type ZoneScope = (typeof MCP_SCOPES)[number];
/** A zone token's caller: the zone always comes from here, never from a tool argument. */
export type ZonePrincipal = { tokenId: number; zoneId: string; scope: ZoneScope };
/**
 * A chat turn's caller: the zone is a tool argument, checked against the config on every call. The
 * thread, message and session are the turn's, so every audit row leads back to them by `token_id`.
 */
export type ChatPrincipal = {
  tokenId: number;
  scope: 'chat';
  threadId: number;
  messageId: number;
  /** The SHA-256 of the browser session that posted the owner's message. */
  sessionHash: string;
};
export type McpPrincipal = ZonePrincipal | ChatPrincipal;
export const isChatPrincipal = (p: McpPrincipal): p is ChatPrincipal => p.scope === 'chat';
/** A token as the operator's list shows it: never the hash. */
export type McpTokenInfo = {
  id: number;
  zoneId: string;
  scope: ZoneScope;
  label: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
export type RefusedAuth = 'missing' | 'unknown' | 'expired' | 'revoked';
export type TokenCheck =
  | { ok: true; principal: McpPrincipal }
  | { ok: false; reason: RefusedAuth; tokenId: number | null };

export const MAX_TOKEN_DAYS = 90;
export const MAX_CHAT_TOKEN_MINUTES = 60;

/**
 * How much of `mcp_audit` is kept. `mint` and `revoke` rows are never pruned (one each per token).
 * Refused-auth rows that name a token (an expired or revoked token in use, or one whose zone left
 * the config) have their own cap, so anonymous noise can't evict that evidence.
 */
export const AUDIT_LIMITS = {
  maxAgeDays: 90,
  maxRows: 100_000,
  anonymousAuthRows: 500,
  tokenAuthRows: 500,
};
export type AuditLimits = typeof AUDIT_LIMITS;
/** Anonymous refused-auth rows kept by the sweep. */
export const MAX_REFUSED_AUTH_ROWS = AUDIT_LIMITS.anonymousAuthRows;
/** The sweep runs at most this often, from whichever audit insert comes first after it. */
const PRUNE_EVERY_MS = 60_000;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export type McpAuditEntry = {
  tokenId: number | null;
  zoneId: string | null;
  tool: string;
  /** Hashed, never stored: the question after a leak is what was asked, not what was said. */
  args?: unknown;
  outcome: 'ok' | 'refused' | 'error';
  /** Reason codes and counts only: never text the caller supplied. */
  detail?: string;
};

/** Deletes the newest-first remainder past `keep` rows matching `where` (an id range delete). */
function keepNewest(db: Db, where: string, keep: number): void {
  const edge = db
    .prepare(`SELECT id FROM mcp_audit WHERE ${where} ORDER BY id DESC LIMIT 1 OFFSET ?`)
    .get(keep) as { id: number } | undefined;
  if (edge) db.prepare(`DELETE FROM mcp_audit WHERE ${where} AND id <= ?`).run(edge.id);
}

const PRUNABLE = "tool NOT IN ('mint', 'revoke')";

/** Applies the retention rules now: age, the two refused-auth caps, then the hard cap. */
export function pruneMcpAudit(db: Db, now: Date, limits: AuditLimits = AUDIT_LIMITS): void {
  db.transaction(() => {
    const cutoff = new Date(now.getTime() - limits.maxAgeDays * 24 * 60 * 60 * 1000);
    db.prepare(`DELETE FROM mcp_audit WHERE ${PRUNABLE} AND at < ?`).run(cutoff.toISOString());
    keepNewest(db, "tool = 'auth' AND token_id IS NULL", limits.anonymousAuthRows);
    keepNewest(db, "tool = 'auth' AND token_id IS NOT NULL", limits.tokenAuthRows);
    keepNewest(db, PRUNABLE, limits.maxRows);
  })();
}

const lastPruned = new WeakMap<Db, number>();

/** `pruneMcpAudit` at most once a minute per database, so no request pays for a scan. */
function maybePrune(db: Db, now: Date): void {
  const last = lastPruned.get(db);
  if (last !== undefined && now.getTime() - last < PRUNE_EVERY_MS) return;
  lastPruned.set(db, now.getTime());
  pruneMcpAudit(db, now);
}

/** Records one audit row; returns its id. */
export function auditMcp(db: Db, e: McpAuditEntry, now: Date): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO mcp_audit (token_id, zone_id, tool, args_sha256, outcome, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.tokenId,
      e.zoneId,
      e.tool,
      e.args === undefined ? null : sha256(JSON.stringify(e.args)),
      e.outcome,
      e.detail ?? '',
      now.toISOString(),
    );
  maybePrune(db, now);
  return Number(lastInsertRowid);
}

/**
 * Sets the outcome of a row already recorded: an external tool's call (ruling R10), reserved
 * before it ran so the budgets count it, and settled once it has.
 */
export function updateMcpAudit(
  db: Db,
  id: number,
  outcome: McpAuditEntry['outcome'],
  detail?: string,
): void {
  db.prepare('UPDATE mcp_audit SET outcome = ?, detail = ? WHERE id = ?').run(
    outcome,
    detail ?? '',
    id,
  );
}

/**
 * Records a refused authentication with nothing derived from the presented token. `tokenId` is set
 * only when the token matched a row (expired or revoked: a stolen token in use). Bounded by the
 * sweep (`AUDIT_LIMITS`), not per request.
 */
export function auditRefusedAuth(db: Db, reason: string, tokenId: number | null, now: Date): void {
  auditMcp(db, { tokenId, zoneId: null, tool: 'auth', outcome: 'refused', detail: reason }, now);
}

/** `jmm_` plus 32 random bytes in base64url: the shape the redaction patterns know. */
const newToken = (): string => `jmm_${randomBytes(32).toString('base64url')}`;

/**
 * Mints a token for one zone: `jmm_` plus 32 random bytes in base64url, valid for `days` (1 to
 * 90). Only its SHA-256 is stored, so the returned token is the one copy. Audited as `mint`.
 */
export function mintMcpToken(
  db: Db,
  o: { zoneId: string; scope: ZoneScope; days: number; label?: string },
  now: Date,
): { id: number; token: string; expiresAt: string } {
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > MAX_TOKEN_DAYS) {
    throw new Error(`days must be an integer from 1 to ${MAX_TOKEN_DAYS}`);
  }
  if (!MCP_SCOPES.includes(o.scope)) throw new Error('scope must be read or write');
  const token = newToken();
  const expiresAt = new Date(now.getTime() + o.days * 24 * 60 * 60 * 1000).toISOString();
  return db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO mcp_tokens (token_hash, zone_id, scope, label, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), o.zoneId, o.scope, o.label ?? '', now.toISOString(), expiresAt);
    const id = Number(r.lastInsertRowid);
    auditMcp(
      db,
      {
        tokenId: id,
        zoneId: o.zoneId,
        tool: 'mint',
        outcome: 'ok',
        detail: `${o.scope}, ${o.days} days`,
      },
      now,
    );
    return { id, token, expiresAt };
  })();
}

/**
 * Mints the token one chat turn uses on `/mcp/chat`, valid for `minutes` (1 to 60) and revoked when
 * the turn ends. It has no zone (`zone_id` is `*`) and names the turn's thread, message and session.
 * Only its SHA-256 is stored, and it never appears in the operator's list. Audited as `mint` with
 * detail `chat`.
 */
export function mintChatToken(
  db: Db,
  o: { threadId: number; messageId: number; sessionHash: string; minutes: number },
  now: Date,
): { id: number; token: string; expiresAt: string } {
  if (!Number.isInteger(o.minutes) || o.minutes < 1 || o.minutes > MAX_CHAT_TOKEN_MINUTES) {
    throw new Error(`minutes must be an integer from 1 to ${MAX_CHAT_TOKEN_MINUTES}`);
  }
  const token = newToken();
  const expiresAt = new Date(now.getTime() + o.minutes * 60 * 1000).toISOString();
  return db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO mcp_tokens (token_hash, zone_id, scope, created_at, expires_at,
           chat_thread_id, chat_message_id, session_hash)
         VALUES (?, '*', 'chat', ?, ?, ?, ?, ?)`,
      )
      .run(sha256(token), now.toISOString(), expiresAt, o.threadId, o.messageId, o.sessionHash);
    const id = Number(r.lastInsertRowid);
    auditMcp(db, { tokenId: id, zoneId: '*', tool: 'mint', outcome: 'ok', detail: 'chat' }, now);
    return { id, token, expiresAt };
  })();
}

type TokenRow = {
  id: number;
  zoneId: string;
  scope: McpScope;
  expiresAt: string;
  revokedAt: string | null;
  threadId: number | null;
  messageId: number | null;
  sessionHash: string | null;
};

function principalOf(row: TokenRow): McpPrincipal | null {
  if (row.scope !== 'chat') return { tokenId: row.id, zoneId: row.zoneId, scope: row.scope };
  const { threadId, messageId, sessionHash } = row;
  if (threadId === null || messageId === null || sessionHash === null) return null;
  return { tokenId: row.id, scope: 'chat', threadId, messageId, sessionHash };
}

/**
 * Looks the token up by its hash (an index probe on a hash, so no timing oracle on the token) and
 * says why it is refused: refused from `expires_at` on, and from the call after a revocation.
 * Records `last_used_at` on success.
 */
export function checkMcpToken(db: Db, token: string | undefined, now: Date): TokenCheck {
  if (!token) return { ok: false, reason: 'missing', tokenId: null };
  const row = db
    .prepare(
      `SELECT id, zone_id AS zoneId, scope, expires_at AS expiresAt, revoked_at AS revokedAt,
         chat_thread_id AS threadId, chat_message_id AS messageId, session_hash AS sessionHash
         FROM mcp_tokens WHERE token_hash = ?`,
    )
    .get(sha256(token)) as TokenRow | undefined;
  if (!row) return { ok: false, reason: 'unknown', tokenId: null };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked', tokenId: row.id };
  if (now.getTime() >= Date.parse(row.expiresAt)) {
    return { ok: false, reason: 'expired', tokenId: row.id };
  }
  const principal = principalOf(row);
  // A chat row without its turn (a hand edit) is no principal at all.
  if (!principal) return { ok: false, reason: 'unknown', tokenId: row.id };
  db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { ok: true, principal };
}

export function verifyMcpToken(db: Db, token: string | undefined, now: Date): McpPrincipal | null {
  const c = checkMcpToken(db, token, now);
  return c.ok ? c.principal : null;
}

/** Revokes a live token, zone or chat; false when there is no such token or it was already revoked. */
export function revokeMcpToken(db: Db, id: number, now: Date): boolean {
  return db.transaction(() => {
    const row = db
      .prepare(
        `UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
         RETURNING zone_id AS zoneId`,
      )
      .get(now.toISOString(), id) as { zoneId: string } | undefined;
    if (!row) return false;
    auditMcp(db, { tokenId: id, zoneId: row.zoneId, tool: 'revoke', outcome: 'ok' }, now);
    return true;
  })();
}

/** The operator's zone tokens; chat tokens are the server's own and never listed. */
export function listMcpTokens(db: Db): McpTokenInfo[] {
  return db
    .prepare(
      `SELECT id, zone_id AS zoneId, scope, label, created_at AS createdAt, expires_at AS expiresAt,
         revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM mcp_tokens
         WHERE scope != 'chat' ORDER BY id`,
    )
    .all() as McpTokenInfo[];
}
