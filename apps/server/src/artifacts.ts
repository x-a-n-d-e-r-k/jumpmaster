import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';

export type ArtifactRow = {
  id: number;
  dropId: string;
  rule: string;
  name: string;
  sha256: string;
  mediaType: string;
  bytes: number;
  createdAt: string;
};

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/json': 'json',
};

const COLUMNS = `id, drop_id AS dropId, rule, name, sha256, media_type AS mediaType, bytes,
  created_at AS createdAt`;

const pathOf = (dataDir: string, dropId: string, sha256: string, mediaType: string): string =>
  join(dataDir, 'artifacts', dropId, `${sha256}.${EXTENSIONS[mediaType]}`);

/** Stores by content hash: the supplied name is display text and never reaches the filesystem. */
export function storeArtifact(
  db: Db,
  dataDir: string,
  dropId: string,
  a: { rule: string; name: string; mediaType: string; bytes: Buffer },
): ArtifactRow {
  if (!EXTENSIONS[a.mediaType]) throw new Error(`unsupported media type: ${a.mediaType}`);
  if (a.bytes.length > MAX_ARTIFACT_BYTES) throw new Error('artifact too large');
  if (listArtifacts(db, dropId).length >= MAX_ARTIFACTS) throw new Error('too many artifacts');
  const sha256 = createHash('sha256').update(a.bytes).digest('hex');
  mkdirSync(join(dataDir, 'artifacts', dropId), { recursive: true });
  writeFileSync(pathOf(dataDir, dropId, sha256, a.mediaType), a.bytes);
  return db
    .prepare(
      `INSERT INTO artifacts (drop_id, rule, name, sha256, media_type, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    )
    .get(
      dropId,
      a.rule,
      a.name,
      sha256,
      a.mediaType,
      a.bytes.length,
      new Date().toISOString(),
    ) as ArtifactRow;
}

export function listArtifacts(db: Db, dropId: string): ArtifactRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE drop_id = ? ORDER BY id`)
    .all(dropId) as ArtifactRow[];
}

export function getArtifact(db: Db, id: number): ArtifactRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`).get(id) as
    | ArtifactRow
    | undefined;
}

export const readArtifact = (dataDir: string, a: ArtifactRow): Buffer =>
  readFileSync(pathOf(dataDir, a.dropId, a.sha256, a.mediaType));
