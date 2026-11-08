import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/open.js';

export type McpScope = 'read' | 'write';
export const MCP_SCOPES = ['read', 'write'] as const;
/** Who is calling: the zone always comes from here, never from a tool argument. */
export type McpPrincipal = { tokenId: number; zoneId: string; scope: McpScope };
/** A token as the operator's list shows it: never the hash. */
export type McpTokenInfo = {
  id: number;
  zoneId: string;
  scope: McpScope;
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

export function auditMcp(db: Db, e: McpAuditEntry, now: Date): void {
  db.prepare(
    `INSERT INTO mcp_audit (token_id, zone_id, tool, args_sha256, outcome, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.tokenId,
    e.zoneId,
    e.tool,
    e.args === undefined ? null : sha256(JSON.stringify(e.args)),
    e.outcome,
    e.detail ?? '',
    now.toISOString(),
  );
  maybePrune(db, now);
}

/**
 * Records a refused authentication with nothing derived from the presented token. `tokenId` is set
 * only when the token matched a row (expired or revoked: a stolen token in use). Bounded by the
 * sweep (`AUDIT_LIMITS`), not per request.
 */
export function auditRefusedAuth(db: Db, reason: string, tokenId: number | null, now: Date): void {
  auditMcp(db, { tokenId, zoneId: null, tool: 'auth', outcome: 'refused', detail: reason }, now);
}

/**
 * Mints a token for one zone: `jmm_` plus 32 random bytes in base64url, valid for `days` (1 to
 * 90). Only its SHA-256 is stored, so the returned token is the one copy. Audited as `mint`.
 */
export function mintMcpToken(
  db: Db,
  o: { zoneId: string; scope: McpScope; days: number; label?: string },
  now: Date,
): { id: number; token: string; expiresAt: string } {
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > MAX_TOKEN_DAYS) {
    throw new Error(`days must be an integer from 1 to ${MAX_TOKEN_DAYS}`);
  }
  if (!MCP_SCOPES.includes(o.scope)) throw new Error('scope must be read or write');
  const token = `jmm_${randomBytes(32).toString('base64url')}`;
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
 * Looks the token up by its hash (an index probe on a hash, so no timing oracle on the token) and
 * says why it is refused: refused from `expires_at` on, and from the call after a revocation.
 * Records `last_used_at` on success.
 */
export function checkMcpToken(db: Db, token: string | undefined, now: Date): TokenCheck {
  if (!token) return { ok: false, reason: 'missing', tokenId: null };
  const row = db
    .prepare(
      `SELECT id, zone_id AS zoneId, scope, expires_at AS expiresAt, revoked_at AS revokedAt
         FROM mcp_tokens WHERE token_hash = ?`,
    )
    .get(sha256(token)) as
    | { id: number; zoneId: string; scope: McpScope; expiresAt: string; revokedAt: string | null }
    | undefined;
  if (!row) return { ok: false, reason: 'unknown', tokenId: null };
  if (row.revokedAt !== null) return { ok: false, reason: 'revoked', tokenId: row.id };
  if (now.getTime() >= Date.parse(row.expiresAt)) {
    return { ok: false, reason: 'expired', tokenId: row.id };
  }
  db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return { ok: true, principal: { tokenId: row.id, zoneId: row.zoneId, scope: row.scope } };
}

export function verifyMcpToken(db: Db, token: string | undefined, now: Date): McpPrincipal | null {
  const c = checkMcpToken(db, token, now);
  return c.ok ? c.principal : null;
}

/** Revokes a live token; false when there is no such token or it was already revoked. */
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

export function listMcpTokens(db: Db): McpTokenInfo[] {
  return db
    .prepare(
      `SELECT id, zone_id AS zoneId, scope, label, created_at AS createdAt, expires_at AS expiresAt,
         revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM mcp_tokens ORDER BY id`,
    )
    .all() as McpTokenInfo[];
}
