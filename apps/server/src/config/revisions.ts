import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';

/**
 * Config revisions and settings (migration v19). A revision holds the whole editable document as
 * canonical JSON, never a secret; revisions are never deleted.
 */

export const REVISION_VIAS = ['file', 'ui', 'ctl', 'rollback', 'adopt', 'import', 'setup'] as const;
export type RevisionVia = (typeof REVISION_VIAS)[number];

export const MAX_NOTE = 500;

export type Revision = {
  id: number;
  parentId: number | null;
  doc: Record<string, unknown>;
  sourceHash: string;
  via: RevisionVia;
  note: string | null;
  createdAt: string;
};

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  return v;
};

/**
 * Byte-stable JSON: keys sorted at every depth, two-space indent, LF line ends and a trailing
 * newline. The export, the stored revisions and `mode file`'s hash comparison all use it.
 */
export function canonicalJson(v: unknown): string {
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`;
}

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type Row = {
  id: number;
  parentId: number | null;
  json: string;
  sourceHash: string;
  via: RevisionVia;
  note: string | null;
  createdAt: string;
};

const fromRow = ({ json, ...r }: Row): Revision => ({
  ...r,
  doc: JSON.parse(json) as Record<string, unknown>,
});

const COLUMNS = `id, parent_id AS parentId, config_json AS json, source_hash AS sourceHash, via, note,
  created_at AS createdAt`;

/** Stores a revision (the caller holds the transaction) and returns its id. */
export function insertRevision(
  db: Db,
  r: { parentId: number | null; doc: unknown; via: RevisionVia; note?: string },
  now: Date,
): number {
  const json = canonicalJson(r.doc);
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO config_revisions (parent_id, config_json, source_hash, via, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(r.parentId, json, hashOf(json), r.via, r.note ?? null, now.toISOString());
  return Number(lastInsertRowid);
}

export function getRevision(db: Db, id: number): Revision | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM config_revisions WHERE id = ?`).get(id) as
    | Row
    | undefined;
  return row ? fromRow(row) : undefined;
}

/** The newest first. */
export function listRevisions(db: Db, limit: number): Revision[] {
  return (
    db
      .prepare(`SELECT ${COLUMNS} FROM config_revisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as Row[]
  ).map(fromRow);
}

/** The newest revision recorded `via`, if any. */
export function latestRevisionVia(db: Db, via: RevisionVia): Revision | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM config_revisions WHERE via = ? ORDER BY id DESC LIMIT 1`)
    .get(via) as Row | undefined;
  return row ? fromRow(row) : undefined;
}

export type SettingKey = 'config.mode' | 'config.current' | 'config.restart_pending' | 'setup.step';

export function getSetting(db: Db, key: SettingKey): unknown {
  const row = db.prepare('SELECT value_json AS v FROM settings WHERE key = ?').get(key) as
    | { v: string }
    | undefined;
  return row ? (JSON.parse(row.v) as unknown) : undefined;
}

export function setSetting(db: Db, key: SettingKey, value: unknown, now: Date): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now.toISOString());
}

export function deleteSetting(db: Db, key: SettingKey): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
