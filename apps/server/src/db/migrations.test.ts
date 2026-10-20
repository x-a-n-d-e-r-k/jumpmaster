import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { M0_SCHEMA_SQL, migrate } from './migrations.js';
import { type Db, openDb } from './open.js';
import { getUsageState } from './repo.js';

const tmpDbFile = () => join(mkdtempSync(join(tmpdir(), 'jm-mig-')), 'jm.sqlite');
const maxVersion = (db: Db) =>
  (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test('fresh DB migrates to version 2', () => {
  expect(maxVersion(openDb(tmpDbFile()))).toBe(2);
});

test('an M0 database is stamped v1 then upgraded without data loss', () => {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec(M0_SCHEMA_SQL);
  raw.prepare(`insert into drop_zones values ('main','o/r','master','{}')`).run();
  raw.close();
  const db = openDb(f);
  expect(count(db, 'drop_zones')).toBe(1);
  expect(maxVersion(db)).toBe(2);
  expect(count(db, 'schema_version')).toBe(2);
});

test('migrate is idempotent', () => {
  const f = tmpDbFile();
  openDb(f).close();
  const db = openDb(f);
  expect(migrate(db)).toBe(2);
  expect(count(db, 'schema_version')).toBe(2);
});

test('usage_state row 1 is seeded', () => {
  const db = openDb(tmpDbFile());
  expect(count(db, 'usage_state')).toBe(1);
  expect(getUsageState(db).status).toBeNull();
});
