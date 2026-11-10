import { redact } from '@jumpmaster/protocol';
import type { Db } from '../db/open.js';

export type AuditVia = 'token' | 'session' | 'system';

/** A detail value: named fields only, never a request body. */
export type AuditDetail = Record<string, string | number | boolean | null | undefined>;

export type AuditEntry = {
  via: AuditVia;
  action: string;
  target?: string;
  guarded?: boolean;
  detail: AuditDetail;
};

export type AuditRow = {
  id: number;
  at: string;
  via: AuditVia;
  action: string;
  target: string | null;
  guarded: boolean;
  detail: Record<string, unknown>;
};

/**
 * Records one mutating control call (§7.5: which credential was used). `detail` is built by the
 * handler from named fields; it is still scrubbed of every configured secret and of token shapes.
 * The table keeps the last 5000 rows (a trigger prunes older ones).
 */
export function recordAudit(db: Db, e: AuditEntry, now: Date, secrets: string[] = []): void {
  const scrub = (v: string): string => redact(v, secrets);
  const detail = Object.fromEntries(
    Object.entries(e.detail)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, typeof v === 'string' ? scrub(v) : v]),
  );
  db.prepare(
    `INSERT INTO control_audit (at, via, action, target, guarded, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    now.toISOString(),
    e.via,
    e.action,
    e.target === undefined ? null : scrub(e.target),
    e.guarded ? 1 : 0,
    JSON.stringify(detail),
  );
}

/** The newest rows first. */
export function listAudit(db: Db, limit = 100): AuditRow[] {
  const rows = db
    .prepare(
      `SELECT id, at, via, action, target, guarded, detail_json AS d FROM control_audit
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as (Omit<AuditRow, 'guarded' | 'detail'> & { guarded: number; d: string })[];
  return rows.map(({ d, guarded, ...r }) => ({
    ...r,
    guarded: guarded === 1,
    detail: JSON.parse(d) as Record<string, unknown>,
  }));
}
