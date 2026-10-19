import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Opens (creating if needed) the SQLite file with WAL and foreign keys, and applies the schema. */
export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}
