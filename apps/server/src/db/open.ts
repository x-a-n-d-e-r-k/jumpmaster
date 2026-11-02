import Database from 'better-sqlite3';
import { migrate } from './migrations.js';

export type Db = Database.Database;

/** Opens (creating if needed) the SQLite file with WAL and foreign keys, and applies pending migrations. */
export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
