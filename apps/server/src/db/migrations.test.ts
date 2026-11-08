import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { M0_SCHEMA_SQL, MIGRATIONS, migrate } from './migrations.js';
import { type Db, openDb } from './open.js';
import { getUsageState } from './repo.js';

const tmpDbFile = () => join(mkdtempSync(join(tmpdir(), 'jm-mig-')), 'jm.sqlite');
const maxVersion = (db: Db) =>
  (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

test('fresh DB migrates to the latest version', () => {
  expect(maxVersion(openDb(tmpDbFile()))).toBe(MIGRATIONS.length);
});

test('an M0 database is stamped v1 then upgraded without data loss', () => {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec(M0_SCHEMA_SQL);
  raw.prepare(`insert into drop_zones values ('main','o/r','master','{}')`).run();
  raw.close();
  const db = openDb(f);
  expect(count(db, 'drop_zones')).toBe(1);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'schema_version')).toBe(MIGRATIONS.length);
});

test('migrate is idempotent', () => {
  const f = tmpDbFile();
  openDb(f).close();
  const db = openDb(f);
  expect(migrate(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'schema_version')).toBe(MIGRATIONS.length);
});

test('usage_state row 1 is seeded', () => {
  const db = openDb(tmpDbFile());
  expect(count(db, 'usage_state')).toBe(1);
  expect(getUsageState(db).status).toBeNull();
});

/** A database at v5 (the M2 schema), with one row in every table the v6 rebuild touches. */
function m2Db(f: string): void {
  const raw = new Database(f);
  raw.pragma('foreign_keys = ON');
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 5)) {
    raw.exec(m.sql);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  raw.exec(`
    INSERT INTO drop_zones VALUES ('main','o/r','main','{}');
    INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at, updated_at)
      VALUES ('main', 1, 't', 'b', 'a', 'x', 'x'), ('main', 2, 't', 'b', 'a', 'x', 'x');
    INSERT INTO sticks (id, name, token_hash, created_at) VALUES ('s1', 's', 'h', 'x');
    INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, stick_id, created_at, charged_key)
      VALUES ('d1', 'main', 1, 'implement', 'succeeded', 's1', 'x', 'review'),
             ('d2', 'main', 2, 'review', 'queued', NULL, 'y', NULL);
    INSERT INTO drop_events VALUES ('d1', 1, 'x', 'log', '{}'), ('d1', 2, 'x', 'log', '{}');
    INSERT INTO artifacts (drop_id, rule, name, sha256, media_type, bytes, created_at)
      VALUES ('d1', 'r', 'n', 's', 'text/plain', 1, 'x');
    INSERT INTO outbox (id, op_key, kind, work_item_id, payload_json, state, created_at, updated_at)
      VALUES ('o1', 'pr:1:h', 'create_pr', 1, '{}', 'done', 'x', 'x'),
             ('o2', 'merge:2:h', 'merge', 2, '{}', 'unknown', 'x', 'x');
  `);
  raw.close();
}

const ids = (db: Db, sql: string) => db.prepare(sql).all();

test('v6 migrates a v5 database keeping every drop, event, artifact and outbox row', () => {
  const f = tmpDbFile();
  m2Db(f);
  const before = new Database(f);
  const snap = (db: Db) => ({
    drops: ids(
      db,
      'SELECT id, work_item_id, role, state, stick_id, charged_key FROM drops ORDER BY id',
    ),
    events: ids(db, 'SELECT drop_id, seq FROM drop_events ORDER BY drop_id, seq'),
    artifacts: ids(db, 'SELECT id, drop_id FROM artifacts ORDER BY id'),
    outbox: ids(db, 'SELECT id, op_key, kind, work_item_id, state FROM outbox ORDER BY id'),
  });
  const old = snap(before);
  before.close();
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(snap(db)).toEqual(old);
  expect(ids(db, 'SELECT id, zone_id FROM outbox ORDER BY id')).toEqual([
    { id: 'o1', zone_id: 'main' },
    { id: 'o2', zone_id: 'main' },
  ]);
});

test('v6 leaves foreign_key_check empty and foreign keys on afterwards', () => {
  const f = tmpDbFile();
  m2Db(f);
  const db = openDb(f);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(() =>
    db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES ('x', 'main', 999, 'implement', 'queued', 'x')`,
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
});

test('an M2-shaped outbox insert without zone_id still succeeds after v6', () => {
  const f = tmpDbFile();
  m2Db(f);
  const db = openDb(f);
  db.prepare(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, payload_json, state, created_at, updated_at)
     VALUES ('o3', 'review:1:h:d', 'post_review', 1, '{}', 'pending', 'x', 'x')`,
  ).run();
  expect(ids(db, "SELECT zone_id FROM outbox WHERE id = 'o3'")).toEqual([{ zone_id: '' }]);
});

test('an item drop without a work item is refused by the CHECK', () => {
  const f = tmpDbFile();
  m2Db(f);
  const db = openDb(f);
  const ins = (id: string, item: number | null, role: string) =>
    db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES (?, 'main', ?, ?, 'succeeded', 'x')`,
      )
      .run(id, item, role);
  expect(() => ins('a', null, 'implement')).toThrow(/CHECK/);
  expect(() => ins('b', 1, 'crew-lead')).toThrow(/CHECK/);
});

test('a crew drop has no work item, and a second active crew drop in the zone is refused', () => {
  const f = tmpDbFile();
  m2Db(f);
  const db = openDb(f);
  const ins = (id: string, role: string, state = 'queued') =>
    db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES (?, 'main', NULL, ?, ?, 'x')`,
      )
      .run(id, role, state);
  ins('c1', 'crew-lead');
  expect(() => ins('c2', 'refute')).toThrow(/UNIQUE/);
  ins('c3', 'diagnose', 'succeeded');
  // The item drop's index still allows one active drop per work item.
  expect(() =>
    db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES ('i2', 'main', 2, 'heal', 'queued', 'x')`,
      )
      .run(),
  ).toThrow(/UNIQUE/);
});
