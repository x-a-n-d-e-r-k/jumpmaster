import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { syncParkBriefings } from '../briefings.js';
import { syncDropZone } from '../sync.js';
import { fakeForge } from '../test/fakes.js';
import { makeZone } from '../test/fixtures.js';
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

/**
 * A database at v11 whose parked briefings carry a diagnosis inside `why`, as the crew wrote it
 * before v12: item 1's open briefing (diagnosed), item 2's open briefing (not yet diagnosed), a
 * ruled briefing for item 1 with a diagnosis, and a crew briefing whose why merely contains the
 * same words.
 */
function v11Db(f: string): void {
  const raw = new Database(f);
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 11)) {
    raw.exec(m.sql);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  const options = JSON.stringify([
    { id: 'retry', label: 'Retry', effect: 'retry_item' },
    { id: 'leave', label: 'Leave parked', effect: 'none' },
  ]);
  raw.exec(`
    INSERT INTO drop_zones VALUES ('main','o/r','main','{}');
    INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at,
        updated_at, state, reason)
      VALUES ('main', 1, 't', 'b', 'a', 'x', '2026-01-01T00:00:00.000Z', 'parked', 'heal budget exhausted'),
             ('main', 2, 't', 'b', 'a', 'x', '2026-01-01T00:00:00.000Z', 'parked', 'stuck');
  `);
  const ins = raw.prepare(
    `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, recommendation,
       on_hold, source, state, diagnose_attempts, created_at, updated_at)
     VALUES ('main', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'x', 'x')`,
  );
  ins.run(
    'parked',
    'item:1',
    'Issue #1 is parked. Retry it?',
    'heal budget exhausted\n\nDiagnosis: The test is flaky.',
    options,
    'retry: Re-run it.',
    'Issue #1',
    'server',
    'open',
  );
  ins.run(
    'parked',
    'item:2',
    'Issue #2 is parked. Retry it?',
    'stuck',
    options,
    '',
    'Issue #2',
    'server',
    'open',
  );
  ins.run(
    'parked',
    'item:1',
    'Issue #1 is parked. Retry it?',
    'earlier\n\nDiagnosis: Out of disk.',
    options,
    'leave: Wait.',
    'Issue #1',
    'server',
    'ruled',
  );
  ins.run(
    'crew',
    'crew:x',
    'Split?',
    'Two parts.\n\nDiagnosis: none here.',
    '[]',
    '',
    '',
    'crew',
    'open',
  );
  raw.close();
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

test('v12 carves a diagnosis out of each parked briefing why, keyed to the server text', () => {
  const f = tmpDbFile();
  v11Db(f);
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    ids(
      db,
      'SELECT subject, state, why, diagnosis, diagnosis_basis AS basis, recommendation FROM briefings ORDER BY id',
    ),
  ).toEqual([
    {
      subject: 'item:1',
      state: 'open',
      why: 'heal budget exhausted',
      diagnosis: 'The test is flaky.',
      basis: sha('heal budget exhausted'),
      recommendation: 'retry: Re-run it.',
    },
    {
      subject: 'item:2',
      state: 'open',
      why: 'stuck',
      diagnosis: null,
      basis: null,
      recommendation: '',
    },
    {
      subject: 'item:1',
      state: 'ruled',
      why: 'earlier',
      diagnosis: 'Out of disk.',
      basis: sha('earlier'),
      recommendation: 'leave: Wait.',
    },
    {
      subject: 'crew:x',
      state: 'open',
      why: 'Two parts.\n\nDiagnosis: none here.',
      diagnosis: null,
      basis: null,
      recommendation: '',
    },
  ]);
  // The next pass finds the carved briefing up to date: it keeps the diagnosis and is not rewritten.
  syncParkBriefings(db, makeZone(), new Date('2026-01-02T00:00:00.000Z'));
  expect(
    ids(db, 'SELECT why, diagnosis, recommendation, updated_at FROM briefings WHERE id = 1'),
  ).toEqual([
    {
      why: 'heal budget exhausted',
      diagnosis: 'The test is flaky.',
      recommendation: 'retry: Re-run it.',
      updated_at: 'x',
    },
  ]);
});

test('v12 gives a crew row the number its resolved create recorded; intake then starts nothing', async () => {
  const f = tmpDbFile();
  v11Db(f);
  const raw = new Database(f);
  const crewRow = raw.prepare(
    `INSERT INTO crew_issues (zone_id, key, source, objective, title, title_norm, body, state,
       created_at, updated_at)
     VALUES ('main', ?, 'crew-lead', 'obj', 't', 't', 'b', 'filing', 'x', 'x')`,
  );
  crewRow.run('k'); // its create resolved while the zone was paused: op done, row unnumbered
  crewRow.run('open'); // its create is still unresolved
  const op = raw.prepare(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state,
       result_json, created_at, updated_at)
     VALUES (?, ?, 'create_issue', NULL, 'main', '{}', ?, ?, 'x', 'x')`,
  );
  op.run('o1', 'issue:main:obj:k', 'done', '{"number":7}');
  op.run('o2', 'issue:main:obj:open', 'unknown', null);
  raw.close();
  const db = openDb(f);
  expect(ids(db, 'SELECT key, number FROM crew_issues ORDER BY id')).toEqual([
    { key: 'k', number: 7 },
    { key: 'open', number: null },
  ]);
  // Someone edits the marker out of #7, drops the staged label and adds ready; the crew is off.
  const forge = fakeForge({
    issues: [
      {
        number: 7,
        title: 't',
        body: 'Cleaned up.',
        author: 'alice',
        authorType: 'User',
        labels: ['agent-ready'],
        createdAt: 'x',
      },
    ],
    trusted: ['alice'],
  });
  const zone = makeZone({ crew: { ...makeZone().crew, enabled: false } });
  const r = await syncDropZone(db, { author: forge, reviewer: forge }, zone, new Date());
  expect(r.skippedCrewUnpromoted).toEqual([7]);
  expect(ids(db, 'SELECT issue_number FROM work_items WHERE issue_number = 7')).toEqual([]);
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

test('v13 adds the credits stop to a v12 usage row, keeping the throttle state, not stopped', () => {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 12)) {
    raw.exec(m.sql);
    m.after?.(raw as unknown as Db);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  raw.exec(
    `UPDATE usage_state SET status = 'rejected', paused_until = '2026-01-01T05:00:00.000Z',
       cause_drop_id = 'd1' WHERE id = 1`,
  );
  raw.close();
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  const u = getUsageState(db);
  expect(u).toMatchObject({
    status: 'rejected',
    pausedUntil: '2026-01-01T05:00:00.000Z',
    causeDropId: 'd1',
    overageStoppedAt: null,
    overageDropId: null,
    overageUntil: null,
    overageSignalJson: null,
    overageResumeUntil: null,
    overageResumeDropId: null,
    overageResumeWorkItemId: null,
    overageResumedAt: null,
    overageProbeSince: null,
  });
  expect(Object.keys(u)).toContain('overageStoppedAt');
  expect(count(db, 'credit_drops')).toBe(0);
});

test('v14 widens briefings.source to mcp, keeps every briefing and ruling, and adds the MCP tables', () => {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 13)) {
    raw.exec(m.sql);
    m.after?.(raw as unknown as Db);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  raw.exec(
    `INSERT INTO briefings (id, zone_id, kind, subject, decision, why, options_json, source,
       source_ref, state, diagnosis, diagnosis_basis, created_at, updated_at)
     VALUES (1, 'main', 'parked', 'item:1', 'd1', 'w1', '[]', 'server', NULL, 'ruled', 'diag',
       'basis', 'a', 'b'),
            (2, 'main', 'crew', 'crew:x', 'd2', 'w2', '[]', 'crew', 'drop-1', 'open', NULL, NULL,
       'c', 'd');
     INSERT INTO rulings (zone_id, briefing_id, choice, note, created_at)
       VALUES ('main', 1, 'o1', 'my note', 'e');`,
  );
  expect(() =>
    raw.exec(
      `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
         created_at, updated_at) VALUES ('main', 'crew', 'mcp:y', 'd', 'w', '[]', 'mcp', 'open', 'a', 'a')`,
    ),
  ).toThrow(/CHECK/);
  raw.close();

  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  const rows = db
    .prepare(
      'SELECT id, subject, source, source_ref AS ref, state, diagnosis, diagnosis_basis AS basis FROM briefings ORDER BY id',
    )
    .all();
  expect(rows).toEqual([
    {
      id: 1,
      subject: 'item:1',
      source: 'server',
      ref: null,
      state: 'ruled',
      diagnosis: 'diag',
      basis: 'basis',
    },
    {
      id: 2,
      subject: 'crew:x',
      source: 'crew',
      ref: 'drop-1',
      state: 'open',
      diagnosis: null,
      basis: null,
    },
  ]);
  expect(db.prepare('SELECT briefing_id AS b, note FROM rulings').all()).toEqual([
    { b: 1, note: 'my note' },
  ]);
  db.prepare(
    `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
       created_at, updated_at) VALUES ('main', 'crew', 'mcp:y', 'd', 'w', '[]', 'mcp', 'open', 'a', 'a')`,
  ).run();
  // The open-subject index survived the rebuild.
  expect(() =>
    db
      .prepare(
        `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
           created_at, updated_at) VALUES ('main', 'crew', 'crew:x', 'd', 'w', '[]', 'crew', 'open', 'a', 'a')`,
      )
      .run(),
  ).toThrow(/UNIQUE/);
  expect(count(db, 'mcp_tokens')).toBe(0);
  expect(count(db, 'mcp_audit')).toBe(0);
  // A refused-auth audit row carries no token id.
  db.prepare(
    `INSERT INTO mcp_audit (token_id, zone_id, tool, args_sha256, outcome, detail, at)
     VALUES (NULL, NULL, 'auth', NULL, 'refused', 'unknown token', 'a')`,
  ).run();
  expect(() =>
    db
      .prepare(
        `INSERT INTO mcp_tokens (token_hash, zone_id, scope, created_at, expires_at)
         VALUES ('h', 'main', 'admin', 'a', 'b')`,
      )
      .run(),
  ).toThrow(/CHECK/);
  // Pruning by tool walks an index, not the table.
  expect(
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mcp_audit_by_tool'")
      .get(),
  ).toEqual({ sql: 'CREATE INDEX mcp_audit_by_tool ON mcp_audit(tool, id)' });
  // A ruling records the label and effect Command chose; older rulings have none.
  expect(
    db.prepare('SELECT choice_label AS label, choice_effect AS effect FROM rulings').all(),
  ).toEqual([{ label: null, effect: null }]);
});

test('v15 adds the stick columns, keeping every stick row', () => {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= 14)) {
    raw.exec(m.sql);
    m.after?.(raw as unknown as Db);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  raw.exec(
    `INSERT INTO sticks (id, name, token_hash, slots, last_seen_at, created_at)
       VALUES ('s1', 'one', 'h1', 2, NULL, 'a'), ('s2', 'two', 'h2', 1, 'b', 'c');`,
  );
  raw.close();

  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  const rows = db
    .prepare(
      `SELECT id, name, token_hash AS hash, slots, last_seen_at AS seen, created_at AS created,
         capabilities_json AS caps, image_policy AS policy, version, pinned_json AS pinned
       FROM sticks ORDER BY id`,
    )
    .all();
  expect(rows).toEqual([
    {
      id: 's1',
      name: 'one',
      hash: 'h1',
      slots: 2,
      seen: null,
      created: 'a',
      caps: '[]',
      policy: 'allowlist',
      version: null,
      pinned: '[]',
    },
    {
      id: 's2',
      name: 'two',
      hash: 'h2',
      slots: 1,
      seen: 'b',
      created: 'c',
      caps: '[]',
      policy: 'allowlist',
      version: null,
      pinned: '[]',
    },
  ]);
  // An M3 binary's insert (no new columns) still works against v15.
  db.prepare(
    "INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s3', 'm3', 'h3', 1, 'd')",
  ).run();
  expect(
    db
      .prepare("SELECT image_policy AS p, capabilities_json AS c FROM sticks WHERE id = 's3'")
      .get(),
  ).toEqual({ p: 'allowlist', c: '[]' });
});

/** A database built by every migration up to and including `version`, closed. */
function dbAt(version: number, seed?: (raw: Database.Database) => void): string {
  const f = tmpDbFile();
  const raw = new Database(f);
  raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) {
    raw.exec(m.sql);
    m.after?.(raw as unknown as Db);
    raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
  }
  seed?.(raw);
  raw.close();
  return f;
}

test('v16 adds doctor_runs and keeps the last 20', () => {
  const f = dbAt(15, (raw) =>
    raw.exec(
      `INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s1', 'one', 'h1', 1, 'a');`,
    ),
  );
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'sticks')).toBe(1);
  const insert = db.prepare(
    'INSERT INTO doctor_runs (started_at, finished_at, results_json, drop_ids_json) VALUES (?, ?, ?, ?)',
  );
  for (let i = 1; i <= 25; i++) insert.run(`t${i}`, `f${i}`, `[{"n":${i}}]`, '[]');
  const rows = db.prepare('SELECT id, started_at AS s FROM doctor_runs ORDER BY id').all() as {
    id: number;
    s: string;
  }[];
  expect(rows).toHaveLength(20);
  expect(rows[0]?.s).toBe('t6');
  expect(rows.at(-1)?.s).toBe('t25');
  // A run still in progress has no finish and no results yet.
  db.prepare('INSERT INTO doctor_runs (started_at) VALUES (?)').run('t26');
  expect(
    db
      .prepare(
        "SELECT finished_at AS f, results_json AS r, drop_ids_json AS d FROM doctor_runs WHERE started_at = 't26'",
      )
      .get(),
  ).toEqual({ f: null, r: '[]', d: '[]' });
  // Reopening runs nothing again.
  db.close();
  const again = openDb(f);
  expect(maxVersion(again)).toBe(MIGRATIONS.length);
  expect(count(again, 'doctor_runs')).toBe(20);
});

/** A v16 database with a zone, a work item, an item drop, a crew drop with events, and an artifact. */
function v16Db(): string {
  return dbAt(16, (raw) =>
    raw.exec(`
      INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('main', 'o/r', 'main', '{}');
      INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s1', 'one', 'h1', 1, 'a');
      INSERT INTO work_items (id, drop_zone_id, issue_number, title, body, author, priority, is_fix,
        issue_created_at, state, updated_at)
        VALUES (1, 'main', 7, 't', 'b', 'a', 0, 0, 'x', 'in_flight', 'x');
      INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, created_at,
        result_json, requested_model, served_model, charged_key, hard_cancel)
        VALUES ('i1', 'main', 1, 'implement', 'running', 's1', 2, 'x', NULL, 'm', NULL, 'k', 0),
               ('c1', 'main', NULL, 'crew-lead', 'queued', NULL, 0, 'y', NULL, NULL, NULL, NULL, 0),
               ('c0', 'main', NULL, 'diagnose', 'succeeded', 's1', 1, 'w', '{"status":"completed"}', 'm', 'm', NULL, 1);
      INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES ('c0', 1, 't', 'log', '{}');
    `),
  );
}

const insDrop = (db: Db, id: string, role: string, item: number | null, state = 'queued') =>
  db
    .prepare(
      `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
       VALUES (?, 'main', ?, ?, ?, 'z')`,
    )
    .run(id, item, role, state);

test('v17 rebuilds drops keeping every row and column, with foreign keys intact', () => {
  const f = v16Db();
  const before = new Database(f);
  // v22, v23 and v31 add columns; the rows as v17 left them are what must survive.
  const NEW_V22 = [
    'push_kind',
    'push_expect_sha',
    'push_deadline',
    'running_at',
    'usage_applied',
    'was_probe',
    'rate_limit_requeue',
    'transcript_pruned_at',
    'transcript_archive',
  ];
  const all = (db: Db | Database.Database) =>
    (db.prepare('SELECT * FROM drops ORDER BY id').all() as Record<string, unknown>[]).map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !NEW_V22.includes(k))),
    );
  const old = all(before);
  before.close();
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(all(db)).toEqual(old);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(count(db, 'drop_events')).toBe(1);
  // Reopening is a no-op.
  db.close();
  expect(all(openDb(f))).toEqual(old);
});

test('v17 lets a doctor drop and a crew drop be active in one zone at once', () => {
  const db = openDb(v16Db());
  insDrop(db, 'doc1', 'doctor', null);
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM drops WHERE state = 'queued' AND work_item_id IS NULL")
      .get(),
  ).toEqual({ n: 2 });
  // The crew index still allows one active crew drop per zone.
  expect(() => insDrop(db, 'c2', 'refute', null)).toThrow(/UNIQUE/);
  // A doctor drop has no work item; item roles still need one, crew roles still have none.
  expect(() => insDrop(db, 'doc-item', 'doctor', 1, 'succeeded')).toThrow(/CHECK/);
  expect(() => insDrop(db, 'impl-none', 'implement', null, 'succeeded')).toThrow(/CHECK/);
  expect(() => insDrop(db, 'crew-item', 'diagnose', 1, 'succeeded')).toThrow(/CHECK/);
  expect(() => insDrop(db, 'i2', 'heal', 1)).toThrow(/UNIQUE/);
});

test('v17 refuses a second active doctor drop per zone', () => {
  const db = openDb(v16Db());
  insDrop(db, 'doc1', 'doctor', null, 'running');
  expect(() => insDrop(db, 'doc2', 'doctor', null)).toThrow(/UNIQUE/);
  insDrop(db, 'doc3', 'doctor', null, 'succeeded');
  db.prepare("UPDATE drops SET state = 'failed' WHERE id = 'doc1'").run();
  insDrop(db, 'doc4', 'doctor', null);
});

test('an M3-era statement set still runs against v16 (the new table is ignored)', () => {
  const db = openDb(dbAt(16));
  db.prepare(
    "INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s3', 'm3', 'h3', 1, 'd')",
  ).run();
  db.prepare(
    "INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}')",
  ).run();
  expect(count(db, 'sticks')).toBe(1);
});

test('v18 adds operator, sessions and control_audit, and control_audit keeps the last 5000 rows', () => {
  const f = dbAt(17, (raw) =>
    raw.exec(
      `INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s1', 'one', 'h1', 1, 'a');`,
    ),
  );
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(MIGRATIONS.some((m) => m.version === 18)).toBe(true);
  expect(count(db, 'sticks')).toBe(1);
  // One operator row at most.
  const op = db.prepare('INSERT INTO operator (id, passphrase_hash, created_at) VALUES (?, ?, ?)');
  op.run(1, 'h', 'a');
  expect(() => op.run(1, 'h', 'b')).toThrow(/UNIQUE|PRIMARY/);
  expect(() => op.run(2, 'h', 'b')).toThrow(/CHECK/);
  db.prepare(
    "INSERT INTO sessions (id_hash, csrf, created_at, last_seen_at) VALUES ('x', 'c', 'a', 'a')",
  ).run();
  expect(db.prepare('SELECT sudo_until AS s FROM sessions').get()).toEqual({ s: null });
  const audit = db.prepare(
    "INSERT INTO control_audit (at, via, action, detail_json) VALUES ('t', ?, 'kill', '{}')",
  );
  expect(() => audit.run('browser')).toThrow(/CHECK/);
  // One transaction: 5003 autocommits cost an fsync each and time the test out on slow disks.
  db.transaction(() => {
    for (let i = 0; i < 5003; i++) audit.run(['token', 'session', 'system'][i % 3]);
  })();
  expect(count(db, 'control_audit')).toBe(5000);
  const ids = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM control_audit').get() as {
    lo: number;
    hi: number;
  };
  // The first valid insert was id 1 (the refused one consumed none): the oldest three are gone.
  expect(ids.hi - ids.lo + 1).toBe(5000);
  expect(db.prepare('SELECT guarded AS g, target AS t FROM control_audit LIMIT 1').get()).toEqual({
    g: 0,
    t: null,
  });
  db.close();
  expect(maxVersion(openDb(f))).toBe(MIGRATIONS.length);
});

test('an M4-era statement set still runs against v18 (the new tables are ignored)', () => {
  const db = openDb(dbAt(18));
  db.prepare(
    "INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s3', 'm4', 'h3', 1, 'd')",
  ).run();
  db.prepare('INSERT INTO doctor_runs (started_at) VALUES (?)').run('t');
  expect(count(db, 'doctor_runs')).toBe(1);
});

test('v19 adds config_revisions with a 500-character note cap and settings', () => {
  const f = dbAt(18, (raw) =>
    raw
      .prepare("INSERT INTO operator (id, passphrase_hash, created_at) VALUES (1, 'h', 'a')")
      .run(),
  );
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'operator')).toBe(1);
  const rev = db.prepare(
    `INSERT INTO config_revisions (parent_id, config_json, source_hash, via, note, created_at)
     VALUES (?, '{}', 'h', ?, ?, 't')`,
  );
  const first = rev.run(null, 'setup', null);
  expect(Number(first.lastInsertRowid)).toBe(1);
  for (const via of ['file', 'ui', 'ctl', 'rollback', 'adopt', 'import', 'setup'])
    rev.run(1, via, 'n');
  expect(() => rev.run(1, 'browser', null)).toThrow(/CHECK/);
  expect(() => rev.run(1, 'ui', 'x'.repeat(501))).toThrow(/CHECK/);
  rev.run(1, 'ui', 'x'.repeat(500));
  expect(() =>
    db
      .prepare(
        "INSERT INTO config_revisions (config_json, source_hash, via, created_at) VALUES (NULL, 'h', 'ui', 't')",
      )
      .run(),
  ).toThrow(/NOT NULL/);
  const set = db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  set.run('config.mode', '"db"', 't');
  expect(() => set.run('config.mode', '"file"', 't')).toThrow(/UNIQUE|PRIMARY/);
  db.close();
});

test('an M4.5a-era statement set still runs against v19 (the new tables are ignored)', () => {
  const db = openDb(dbAt(19));
  db.prepare(
    "INSERT INTO control_audit (at, via, action, detail_json) VALUES ('t', 'token', 'kill', '{}')",
  ).run();
  expect(count(db, 'control_audit')).toBe(1);
});

test('v20 adds vault: ciphertext and metadata by name, never a plaintext column', () => {
  const db = openDb(dbAt(19));
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  const cols = (
    db.prepare('SELECT name, "notnull" AS nn, pk FROM pragma_table_info(\'vault\')').all() as {
      name: string;
      nn: number;
      pk: number;
    }[]
  ).map((c) => `${c.name}${c.pk ? ' pk' : ''}${c.nn ? ' notnull' : ''}`);
  expect(cols).toEqual([
    'name pk',
    'ciphertext notnull',
    'nonce notnull',
    'key_id notnull',
    'fingerprint notnull',
    'created_at notnull',
    'declared_created_at',
    'tested_at',
    'test_result',
    'login',
    'note',
  ]);
  const put = db.prepare(
    'INSERT INTO vault (name, ciphertext, nonce, key_id, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  put.run('claudeToken', Buffer.from('c'), Buffer.alloc(12), 'k', 'f', 't');
  expect(() => put.run('claudeToken', Buffer.from('c'), Buffer.alloc(12), 'k', 'f', 't')).toThrow(
    /UNIQUE|PRIMARY/,
  );
  db.close();
});

test('an M4.5a-era statement set still runs against v20 (the vault is ignored)', () => {
  const db = openDb(dbAt(20));
  db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('k', '1', 't')").run();
  expect(count(db, 'settings')).toBe(1);
});

test('v21 lets the outbox hold create_labels, keeping every row and the kind check', () => {
  const f = dbAt(20, (raw) =>
    raw
      .prepare(
        `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
         VALUES ('o1', 'issue:z:o:k', 'create_issue', NULL, 'z', '{}', 'done', 't', 't')`,
      )
      .run(),
  );
  const db = openDb(f);
  expect(MIGRATIONS.some((m) => m.version === 21)).toBe(true);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'outbox')).toBe(1);
  const put = db.prepare(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'z', '{}', 'pending', 't', 't')`,
  );
  put.run('o2', 'create_labels:z:1', 'create_labels');
  // The rebuilt table keeps the work item foreign key and zone_id's default.
  expect(
    db.prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(\'outbox\')').all(),
  ).toEqual([{ table: 'work_items', from: 'work_item_id', to: 'id' }]);
  const zoneCol = db
    .prepare(
      "SELECT dflt_value AS d, \"notnull\" AS nn FROM pragma_table_info('outbox') WHERE name = 'zone_id'",
    )
    .get();
  expect(zoneCol).toEqual({ d: "''", nn: 1 });
  expect(() => put.run('o3', 'x', 'delete_repo')).toThrow(/CHECK/);
  expect(() => put.run('o4', 'issue:z:o:k', 'create_issue')).toThrow(/UNIQUE/);
  db.close();
});

test('v22 migrates a v21 database and keeps every drop and index', () => {
  const f = dbAt(21, (raw) => {
    raw.exec(
      `INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}');
       INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, priority, is_fix,
         issue_created_at, state, updated_at) VALUES ('z', 1, 't', 'b', 'a', 0, 0, 't', 'in_flight', 't');
       INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at, head_sha, hard_cancel)
         VALUES ('d1', 'z', 1, 'implement', 'running', 't', 'abc', 1);
       INSERT INTO kill_switch (id, engaged, updated_at) VALUES (1, 1, 't');`,
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        'SELECT id, state, head_sha AS h, hard_cancel AS hc, usage_applied AS ua, was_probe AS wp, push_kind AS pk, running_at AS ra FROM drops',
      )
      .all(),
  ).toEqual([{ id: 'd1', state: 'running', h: 'abc', hc: 1, ua: 0, wp: 0, pk: null, ra: null }]);
  expect(db.prepare('SELECT engaged, engaged_at AS e FROM kill_switch').get()).toEqual({
    engaged: 1,
    e: null,
  });
  const idx = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'drops' AND name LIKE 'one_active%' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  expect(idx.map((i) => i.name)).toEqual([
    'one_active_crew_drop',
    'one_active_doctor_drop',
    'one_active_drop',
  ]);
  for (const i of idx) expect(i.sql).toContain("'push_pending'");
  db.prepare(
    "UPDATE drops SET state = 'push_pending', push_kind = 'checkpoint' WHERE id = 'd1'",
  ).run();
  expect(() => db.prepare("UPDATE drops SET push_kind = 'bogus' WHERE id = 'd1'").run()).toThrow(
    /CHECK/,
  );
  expect(() => db.prepare("UPDATE drops SET state = 'nope' WHERE id = 'd1'").run()).toThrow(
    /CHECK/,
  );
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(
    db.prepare('SELECT "table" AS t FROM pragma_foreign_key_list(\'drops\') ORDER BY t').all(),
  ).toEqual([{ t: 'drop_zones' }, { t: 'sticks' }, { t: 'work_items' }]);
  const pk = db
    .prepare("SELECT name FROM pragma_table_info('push_tokens') WHERE pk > 0 ORDER BY pk")
    .all();
  expect(pk).toEqual([{ name: 'drop_id' }, { name: 'epoch' }, { name: 'seq' }]);
  db.close();
});

test('v23 adds rate_limit_requeue, undecided on every existing drop', () => {
  const f = dbAt(22, (raw) => {
    raw.exec(
      `INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}');
       INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, priority, is_fix,
         issue_created_at, state, updated_at) VALUES ('z', 1, 't', 'b', 'a', 0, 0, 't', 'in_flight', 't');
       INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at, push_kind)
         VALUES ('d1', 'z', 1, 'implement', 'push_pending', 't', 'checkpoint');`,
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT id, state, rate_limit_requeue AS r FROM drops').all()).toEqual([
    { id: 'd1', state: 'push_pending', r: null },
  ]);
  db.close();
});

test('v24 adds the stopping marker, unset on every existing zone', () => {
  const f = dbAt(23, (raw) => {
    raw.exec("INSERT INTO zone_controls (zone_id, mode, updated_at) VALUES ('z', 'paused', 't');");
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        'SELECT zone_id AS id, mode, stopping_since AS s, stopping_via AS v FROM zone_controls',
      )
      .all(),
  ).toEqual([{ id: 'z', mode: 'paused', s: null, v: null }]);
  expect(() => db.prepare("UPDATE zone_controls SET stopping_via = 'mcp'").run()).toThrow(
    /CHECK constraint/,
  );
  db.close();
});

test('v25 lets a briefing be dismissed, keeping every briefing and ruling', () => {
  const f = dbAt(24, (raw) => {
    raw.exec(
      `INSERT INTO briefings (id, zone_id, kind, subject, decision, why, options_json, source,
       source_ref, state, diagnosis, diagnosis_basis, created_at, updated_at)
     VALUES (1, 'main', 'parked', 'item:1', 'd1', 'w1', '[]', 'server', NULL, 'ruled', 'diag',
       'basis', 'a', 'b'),
            (2, 'main', 'crew', 'crew:x', 'd2', 'w2', '[]', 'mcp', 'drop-1', 'open', NULL, NULL,
       'c', 'd');
     INSERT INTO rulings (zone_id, briefing_id, choice, note, created_at)
       VALUES ('main', 1, 'o1', 'my note', 'e');`,
    );
    expect(() => raw.exec(`UPDATE briefings SET state = 'dismissed' WHERE id = 2`)).toThrow(
      /CHECK/,
    );
  });

  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  db.exec(`UPDATE briefings SET state = 'dismissed' WHERE id = 2`);
  expect(
    db.prepare('SELECT id, source, state, diagnosis FROM briefings ORDER BY id').all(),
  ).toEqual([
    { id: 1, source: 'server', state: 'ruled', diagnosis: 'diag' },
    { id: 2, source: 'mcp', state: 'dismissed', diagnosis: null },
  ]);
  expect(db.prepare('SELECT briefing_id AS b, note FROM rulings').all()).toEqual([
    { b: 1, note: 'my note' },
  ]);
  // Still one open briefing per subject.
  db.exec(
    `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
       created_at, updated_at) VALUES ('main', 'crew', 'crew:x', 'd', 'w', '[]', 'crew', 'open', 'a', 'a')`,
  );
  expect(() =>
    db.exec(
      `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
         created_at, updated_at) VALUES ('main', 'crew', 'crew:x', 'd', 'w', '[]', 'crew', 'open', 'a', 'a')`,
    ),
  ).toThrow(/UNIQUE/);
});

test('v26 adds the trooper counts, unset on every existing stick: it runs its enrolled slots', () => {
  const f = dbAt(25, (raw) => {
    raw.exec(
      `INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s1', 'n', 'h', 2, 'a')`,
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT slots, desired_slots AS d, max_slots AS m FROM sticks').all()).toEqual([
    { slots: 2, d: null, m: null },
  ]);
  db.close();
});

test('v27 adds usage_windows, empty, keyed by window', () => {
  const db = openDb(dbAt(26, () => {}));
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT * FROM usage_windows').all()).toEqual([]);
  db.exec(
    "INSERT INTO usage_windows (key, utilization, resets_at, observed_at) VALUES ('seven_day_fable', 0.4, NULL, 'a')",
  );
  expect(() =>
    db.exec(
      "INSERT INTO usage_windows (key, utilization, resets_at, observed_at) VALUES ('seven_day_fable', 0.5, NULL, 'b')",
    ),
  ).toThrow(/UNIQUE|PRIMARY/);
  db.close();
});

test('v40 adds the reporting model to usage_windows, null on every existing row (#377)', () => {
  const f = dbAt(39, (raw) => {
    raw.exec(
      "INSERT INTO usage_windows (key, utilization, resets_at, observed_at) VALUES ('seven_day_overage_included', 0.01, NULL, 'a')",
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT key, utilization, model FROM usage_windows').all()).toEqual([
    { key: 'seven_day_overage_included', utilization: 0.01, model: null },
  ]);
  db.close();
});

test("v28 adds stick invites and the sticks' removal, Auto count and health, unset on every existing stick", () => {
  const f = dbAt(27, (raw) => {
    raw.exec(
      `INSERT INTO sticks (id, name, token_hash, slots, created_at) VALUES ('s1', 'n', 'h', 2, 'a')`,
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        'SELECT auto_slots AS a, removed_at AS r, docker_version AS d, free_bytes AS b FROM sticks',
      )
      .all(),
  ).toEqual([{ a: 0, r: null, d: null, b: null }]);
  db.exec(
    `INSERT INTO stick_invites (id, name, slots, code_hash, created_at, expires_at)
     VALUES ('i1', 'vps-1', NULL, 'hash', 'a', 'b')`,
  );
  expect(
    db.prepare('SELECT name, slots, used_at AS u, stick_id AS s FROM stick_invites').all(),
  ).toEqual([{ name: 'vps-1', slots: null, u: null, s: null }]);
  expect(() =>
    db.exec(
      `INSERT INTO stick_invites (id, name, slots, code_hash, created_at, expires_at)
       VALUES ('i2', 'vps-2', NULL, 'hash', 'a', 'b')`,
    ),
  ).toThrow(/UNIQUE/);
  db.close();
});

test('v29 lets the outbox hold comment_issue, keeping every row and the kind check', () => {
  const f = dbAt(28, (raw) =>
    raw
      .prepare(
        `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
         VALUES ('o1', 'create_labels:z:1', 'create_labels', NULL, 'z', '{}', 'done', 't', 't')`,
      )
      .run(),
  );
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(29);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(count(db, 'outbox')).toBe(1);
  const put = db.prepare(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'z', '{}', 'pending', 't', 't')`,
  );
  put.run('o2', 'comment:z:triage:1', 'comment_issue');
  expect(
    db.prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(\'outbox\')').all(),
  ).toEqual([{ table: 'work_items', from: 'work_item_id', to: 'id' }]);
  const zoneCol = db
    .prepare(
      "SELECT dflt_value AS d, \"notnull\" AS nn FROM pragma_table_info('outbox') WHERE name = 'zone_id'",
    )
    .get();
  expect(zoneCol).toEqual({ d: "''", nn: 1 });
  expect(() => put.run('o3', 'x', 'delete_comment')).toThrow(/CHECK/);
  expect(() => put.run('o4', 'comment:z:triage:1', 'comment_issue')).toThrow(/UNIQUE/);
  db.close();
});

test('v34 lets the outbox hold add_blocked_by, keeping every row and the kind check', () => {
  const f = dbAt(33, (raw) =>
    raw
      .prepare(
        `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
         VALUES ('o1', 'comment:z:triage:1:2', 'comment_issue', NULL, 'z', '{}', 'done', 't', 't')`,
      )
      .run(),
  );
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT op_key AS k, kind, state FROM outbox').all()).toEqual([
    { k: 'comment:z:triage:1:2', kind: 'comment_issue', state: 'done' },
  ]);
  const put = db.prepare(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'z', '{}', 'pending', 't', 't')`,
  );
  put.run('o2', 'blocked-by:z:triage:2:300:200', 'add_blocked_by');
  expect(
    db.prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(\'outbox\')').all(),
  ).toEqual([{ table: 'work_items', from: 'work_item_id', to: 'id' }]);
  expect(() => put.run('o3', 'x', 'remove_blocked_by')).toThrow(/CHECK/);
  expect(() => put.run('o4', 'blocked-by:z:triage:2:300:200', 'add_blocked_by')).toThrow(/UNIQUE/);
  db.close();
});

test('v30 adds triage_requests and lets triage be a crew drop, keeping every drop and its columns', () => {
  const f = dbAt(29, (raw) => {
    raw.exec(`INSERT INTO drop_zones (id, repo, default_branch, config_json)
      VALUES ('z', 'o/r', 'main', '{}')`);
    raw.exec(`INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at,
        was_probe, rate_limit_requeue, push_kind)
      VALUES ('d1', 'z', NULL, 'refute', 'succeeded', 't', 1, 0, 'final')`);
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(30);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        `SELECT role, was_probe AS p, rate_limit_requeue AS r, push_kind AS k FROM drops WHERE id = 'd1'`,
      )
      .get(),
  ).toEqual({ role: 'refute', p: 1, r: 0, k: 'final' });
  const drop = db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
     VALUES (?, 'z', NULL, ?, ?, 't')`,
  );
  drop.run('d2', 'triage', 'queued');
  // One active crew drop per zone, triage included.
  expect(() => drop.run('d3', 'crew-lead', 'queued')).toThrow(/UNIQUE/);
  const put = db.prepare(
    `INSERT INTO triage_requests (zone_id, issue_number, title, body, body_sha, author, state,
       created_at, updated_at) VALUES ('z', 179, 't', 'b', ?, 'a', ?, 't', 't')`,
  );
  put.run('sha1', 'open');
  expect(
    db.prepare('SELECT attempts, outcome, briefing_id AS b FROM triage_requests').get(),
  ).toEqual({ attempts: 0, outcome: null, b: null });
  expect(() => put.run('sha1', 'open')).toThrow(/UNIQUE/);
  expect(() => put.run('sha2', 'closed')).toThrow(/CHECK/);
  db.close();
});

test('v31 adds the transcript prune mark and archive path, unset on every existing drop', () => {
  const f = dbAt(30, (raw) => {
    raw.exec(
      `INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}');
       INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at, finished_at,
         result_json) VALUES ('d1', 'z', NULL, 'doctor', 'succeeded', 't', 't', '{"ok":true}');`,
    );
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(31);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        `SELECT id, result_json AS r, transcript_pruned_at AS p, transcript_archive AS a FROM drops`,
      )
      .all(),
  ).toEqual([{ id: 'd1', r: '{"ok":true}', p: null, a: null }]);
  db.close();
});

test('v32 adds objectives_done and the objective_done kind, keeping every briefing and ruling', () => {
  const f = dbAt(31, (raw) => {
    raw.exec(
      `INSERT INTO briefings (id, zone_id, kind, subject, decision, why, options_json, source, state,
         created_at, updated_at) VALUES (7, 'z', 'crew', 'crew:x', 'd', 'w', '[]', 'crew', 'ruled',
         't', 't');
       INSERT INTO rulings (id, zone_id, briefing_id, choice, created_at) VALUES (7, 'z', 7, 'o1', 't');`,
    );
  });
  const db = openDb(f);
  expect(db.prepare('SELECT id, kind FROM briefings').all()).toEqual([{ id: 7, kind: 'crew' }]);
  expect(db.prepare('SELECT id, briefing_id AS b FROM rulings').all()).toEqual([{ id: 7, b: 7 }]);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(32);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  db.exec(
    `INSERT INTO briefings (id, zone_id, kind, subject, decision, why, options_json, source, state,
       created_at, updated_at) VALUES (1, 'z', 'objective_done', 'objective:a', 'd', 'w', '[]',
       'server', 'ruled', 't', 't');
     INSERT INTO rulings (id, zone_id, briefing_id, choice, created_at) VALUES (1, 'z', 1, 'done', 't');`,
  );
  const put = db.prepare(
    `INSERT INTO objectives_done (zone_id, key, done_at, ruling_id) VALUES ('z', ?, 't', ?)`,
  );
  put.run('a', 1);
  expect(() => put.run('a', 1)).toThrow(/UNIQUE|PRIMARY/);
  expect(() => put.run('b', 99)).toThrow(/FOREIGN KEY/);
  db.close();
});

test('v33 adds triage_requests.gate_reasons, null on every existing request', () => {
  const f = dbAt(32, (raw) => {
    raw.exec(
      `INSERT INTO triage_requests (zone_id, issue_number, title, body, body_sha, author, state,
         reason, created_at, updated_at) VALUES ('z', 179, 't', 'b', 's', 'a', 'done', 'r', 't', 't')`,
    );
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(33);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db.prepare('SELECT issue_number AS n, reason, gate_reasons AS g FROM triage_requests').all(),
  ).toEqual([{ n: 179, reason: 'r', g: null }]);
  db.close();
});

test('v35 adds work_items.pr_files, null (unknown) on every existing item', () => {
  const f = dbAt(34, (raw) => {
    raw.exec(
      `INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}');
       INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, priority, is_fix,
         issue_created_at, state, updated_at) VALUES ('z', 7, 't', 'b', 'a', 0, 0, 't', 'pr_open', 't')`,
    );
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(35);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT issue_number AS n, pr_files AS f FROM work_items').all()).toEqual([
    { n: 7, f: null },
  ]);
  db.close();
});

test('v36 keeps every outbox row, takes update_branch ops and adds branch_updates', () => {
  const f = dbAt(35, (raw) => {
    raw.exec(
      `INSERT INTO drop_zones (id, repo, default_branch, config_json) VALUES ('z', 'o/r', 'main', '{}');
       INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, priority, is_fix,
         issue_created_at, state, updated_at) VALUES ('z', 7, 't', 'b', 'a', 0, 0, 't', 'pr_open', 't');
       INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at,
         updated_at) VALUES ('o1', 'merge:1:aaa', 'merge', 1, 'z', '{}', 'done', 't', 't');`,
    );
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT op_key AS k, kind, state FROM outbox').all()).toEqual([
    { k: 'merge:1:aaa', kind: 'merge', state: 'done' },
  ]);
  db.exec(
    `INSERT INTO outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, created_at,
       updated_at) VALUES ('o2', 'update_branch:1:aaa:b1', 'update_branch', 1, 'z', '{}', 'pending', 't', 't')`,
  );
  const mark = db.prepare(
    `INSERT INTO branch_updates (work_item_id, head_sha, base_sha, failures, outcome, updated_at)
     VALUES (?, 'aaa', 'b1', 0, ?, 't')`,
  );
  mark.run(1, 'conflict');
  expect(() => mark.run(1, 'conflict')).toThrow(/UNIQUE|PRIMARY/);
  expect(() => mark.run(99, null)).toThrow(/FOREIGN KEY/);
  expect(() =>
    db
      .prepare(
        `INSERT INTO branch_updates (work_item_id, head_sha, base_sha, outcome, updated_at)
         VALUES (1, 'x', 'y', 'maybe', 't')`,
      )
      .run(),
  ).toThrow(/CHECK/);
  db.close();
});

test('v37 keeps every invite as a line invite and adds the exchange columns, the token hash unique', () => {
  const f = dbAt(36, (raw) => {
    raw.exec(
      `INSERT INTO stick_invites (id, name, slots, code_hash, created_at, expires_at)
       VALUES ('i1', 'vps-1', NULL, 'c1', 't', 'u')`,
    );
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(37);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        'SELECT id, kind, exchanged_at AS x, token_hash AS h, token_expires_at AS e FROM stick_invites',
      )
      .all(),
  ).toEqual([{ id: 'i1', kind: 'line', x: null, h: null, e: null }]);
  const add = db.prepare(
    `INSERT INTO stick_invites (id, name, code_hash, created_at, expires_at, kind, token_hash)
     VALUES (?, 'n', ?, 't', 'u', ?, ?)`,
  );
  add.run('i2', 'c2', 'cloud_init', 'th');
  add.run('i3', 'c3', 'line', null);
  expect(() => add.run('i4', 'c4', 'line', 'th')).toThrow(/UNIQUE/);
  expect(() => add.run('i5', 'c5', 'pigeon', null)).toThrow(/CHECK/);
  db.close();
});

test('v38 keeps existing tokens and their audit rows', () => {
  const f = dbAt(37, (raw) =>
    raw.exec(
      `INSERT INTO mcp_tokens (id, token_hash, zone_id, scope, label, created_at, expires_at,
         revoked_at, last_used_at)
       VALUES (1, 'h1', 'main', 'read', 'laptop', 'c1', 'e1', NULL, 'u1'),
              (2, 'h2', 'main', 'write', '', 'c2', 'e2', 'r2', NULL);
       INSERT INTO mcp_audit (id, token_id, zone_id, tool, args_sha256, outcome, detail, at)
       VALUES (1, 1, 'main', 'mint', NULL, 'ok', 'read, 30 days', 'a1'),
              (2, 1, 'main', 'get_goals', 'x', 'ok', '', 'a2'),
              (3, 2, 'main', 'revoke', NULL, 'ok', '', 'a3'),
              (4, NULL, NULL, 'auth', NULL, 'refused', 'unknown', 'a4');`,
    ),
  );
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        `SELECT id, token_hash AS h, zone_id AS z, scope, label, created_at AS c, expires_at AS e,
           revoked_at AS r, last_used_at AS u, chat_thread_id AS t, chat_message_id AS m,
           session_hash AS s FROM mcp_tokens ORDER BY id`,
      )
      .all(),
  ).toEqual([
    {
      id: 1,
      h: 'h1',
      z: 'main',
      scope: 'read',
      label: 'laptop',
      c: 'c1',
      e: 'e1',
      r: null,
      u: 'u1',
      t: null,
      m: null,
      s: null,
    },
    {
      id: 2,
      h: 'h2',
      z: 'main',
      scope: 'write',
      label: '',
      c: 'c2',
      e: 'e2',
      r: 'r2',
      u: null,
      t: null,
      m: null,
      s: null,
    },
  ]);
  expect(
    db.prepare('SELECT id, token_id AS t, tool, detail FROM mcp_audit ORDER BY id').all(),
  ).toEqual([
    { id: 1, t: 1, tool: 'mint', detail: 'read, 30 days' },
    { id: 2, t: 1, tool: 'get_goals', detail: '' },
    { id: 3, t: 2, tool: 'revoke', detail: '' },
    { id: 4, t: null, tool: 'auth', detail: 'unknown' },
  ]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  // The rebuilt table takes chat tokens, keeps the hash unique and refuses any other scope.
  const insert = db.prepare(
    `INSERT INTO mcp_tokens (token_hash, zone_id, scope, created_at, expires_at, chat_thread_id,
       chat_message_id, session_hash) VALUES (?, '*', ?, 'c', 'e', 1, 2, 's')`,
  );
  insert.run('h3', 'chat');
  expect(() => insert.run('h3', 'chat')).toThrow(/UNIQUE/);
  expect(() => insert.run('h4', 'admin')).toThrow(/CHECK/);
  // The audit foreign key still points at the rebuilt table.
  expect(() =>
    db
      .prepare("INSERT INTO mcp_audit (token_id, tool, outcome, at) VALUES (999, 'x', 'ok', 'a')")
      .run(),
  ).toThrow(/FOREIGN KEY/);
});

test('v41 adds arbitrations and lets arbitrate be a crew drop, keeping every drop and its columns', () => {
  const f = dbAt(40, (raw) => {
    raw.exec(`INSERT INTO drop_zones (id, repo, default_branch, config_json)
      VALUES ('z', 'o/r', 'main', '{}')`);
    raw.exec(`INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at,
        was_probe, rate_limit_requeue, push_kind, transcript_pruned_at, transcript_archive,
        requested_model, served_model)
      VALUES ('d1', 'z', NULL, 'refute', 'succeeded', 't', 1, 0, 'final', 'p', 'a', 'rq', 'sv')`);
    raw.exec(`INSERT INTO drop_events (drop_id, seq, ts, kind, data_json)
      VALUES ('d1', 1, 't', 'log', '{}')`);
  });
  const db = openDb(f);
  expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(41);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(
    db
      .prepare(
        `SELECT role, was_probe AS p, rate_limit_requeue AS r, push_kind AS k,
           transcript_pruned_at AS tp, transcript_archive AS ta, requested_model AS rq,
           served_model AS sv FROM drops WHERE id = 'd1'`,
      )
      .get(),
  ).toEqual({ role: 'refute', p: 1, r: 0, k: 'final', tp: 'p', ta: 'a', rq: 'rq', sv: 'sv' });
  expect(count(db, 'drop_events')).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.exec(`INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at,
      updated_at) VALUES ('z', 1, 't', 'b', 'a', 't', 't')`);
  const drop = db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
     VALUES (?, 'z', ?, ?, ?, 't')`,
  );
  // An arbitrate drop is a crew drop: never with a work item.
  expect(() => drop.run('d2', 1, 'arbitrate', 'succeeded')).toThrow(/CHECK/);
  drop.run('d3', null, 'arbitrate', 'queued');
  // One active crew drop per zone, arbitrate included, both ways round.
  expect(() => drop.run('d4', null, 'refute', 'queued')).toThrow(/UNIQUE/);
  db.prepare(`UPDATE drops SET state = 'succeeded' WHERE id = 'd3'`).run();
  drop.run('d5', null, 'triage', 'running');
  expect(() => drop.run('d6', null, 'arbitrate', 'queued')).toThrow(/UNIQUE/);
  const put = db.prepare(
    `INSERT INTO arbitrations (zone_id, subject, basis, drop_id, state, created_at, updated_at)
     VALUES ('z', 'issue:1', ?, 'd3', ?, 't', 't')`,
  );
  put.run('sha1', 'pending');
  expect(db.prepare('SELECT acted, ruling FROM arbitrations').get()).toEqual({
    acted: 0,
    ruling: null,
  });
  expect(() => put.run('sha1', 'pending')).toThrow(/UNIQUE/);
  expect(() => put.run('sha2', 'won')).toThrow(/CHECK/);
  expect(() =>
    db.prepare(`UPDATE arbitrations SET ruling = 'C' WHERE basis = 'sha1'`).run(),
  ).toThrow(/CHECK/);
  db.close();
});

test('v40 keeps every control_audit row and the 5000-row trigger (the rebuild ships as v42: v40 and v41 were taken)', () => {
  let seedMs = Infinity;
  const f = dbAt(41, (raw) => {
    const start = performance.now();
    const put = raw.prepare(
      `INSERT INTO control_audit (at, via, action, target, guarded, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // One transaction: 5002 autocommits cost an fsync each and time the test out on slow disks.
    raw.transaction(() => {
      for (let i = 0; i < 5002; i++)
        put.run(
          `t${i}`,
          ['token', 'session', 'system'][i % 3],
          `a${i}`,
          i % 2 ? 'z' : null,
          i % 2,
          `{"n":${i}}`,
        );
    })();
    seedMs = performance.now() - start;
  });
  // The seed must stay fast, or the test drifts back towards vitest's timeout on slow disks.
  expect(seedMs).toBeLessThan(5000);
  const before = new Database(f);
  const rows = before.prepare('SELECT * FROM control_audit ORDER BY id').all();
  before.close();
  expect(rows).toHaveLength(5000);
  const db = openDb(f);
  expect(MIGRATIONS.some((m) => m.version === 42)).toBe(true);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT * FROM control_audit ORDER BY id').all()).toEqual(rows);
  const audit = db.prepare(
    "INSERT INTO control_audit (at, via, action, detail_json) VALUES ('t', ?, 'x', '{}')",
  );
  expect(() => audit.run('browser')).toThrow(/CHECK/);
  audit.run('chat');
  // The trigger still keeps the last 5000, and ids keep counting from where they were.
  expect(count(db, 'control_audit')).toBe(5000);
  const ids = db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi FROM control_audit').get() as {
    lo: number;
    hi: number;
  };
  expect(ids).toEqual({ lo: 4, hi: 5003 });
  expect(db.prepare('SELECT via FROM control_audit WHERE id = 5003').get()).toEqual({
    via: 'chat',
  });
  for (let i = 0; i < 10; i++) audit.run('session');
  expect(count(db, 'control_audit')).toBe(5000);
  db.close();
});

test('v44 adds applied_at to arbitrations, keeping every row unapplied', () => {
  const f = dbAt(43, (raw) => {
    raw.exec(`INSERT INTO arbitrations (zone_id, subject, basis, drop_id, state, created_at,
        updated_at) VALUES ('z', 'issue:1', 'sha1', 'd1', 'ruled', 't', 't')`);
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT subject, state, applied_at AS at FROM arbitrations').all()).toEqual([
    { subject: 'issue:1', state: 'ruled', at: null },
  ]);
  db.close();
});

test('v43 keeps every briefing and ruling (the rebuild ships as v46: v43 to v45 were taken), and takes the goal_change kind', () => {
  const f = dbAt(45, (raw) => {
    raw.exec(
      `INSERT INTO briefings (id, zone_id, kind, subject, decision, why, options_json,
         recommendation, on_hold, source, source_ref, state, diagnose_attempts, created_at,
         updated_at, diagnosis, diagnosis_basis)
       VALUES (7, 'z', 'objective_done', 'objective:a', 'd', 'w', '[]', 'r', 'h', 'server', 'drop-1',
         'ruled', 2, 't1', 't2', 'diag', 'basis'),
              (8, 'z', 'crew', 'crew:x', 'd', 'w', '[]', '', '', 'crew', NULL, 'open', 0, 't', 't',
         NULL, NULL),
              (9, 'z', 'promote', 'issue:3', 'd', 'w', '[]', '', '', 'mcp', '4', 'dismissed', 0,
         't', 't', NULL, NULL);
       INSERT INTO rulings (id, zone_id, briefing_id, choice, note, created_at, applied_at,
         apply_error, apply_attempts)
       VALUES (7, 'z', 7, 'done', 'n', 't', 't3', NULL, 0);
       INSERT INTO objectives_done (zone_id, key, done_at, ruling_id) VALUES ('z', 'a', 't', 7);`,
    );
  });
  const before = new Database(f);
  const briefings = before.prepare('SELECT * FROM briefings ORDER BY id').all();
  const rulings = before.prepare('SELECT * FROM rulings ORDER BY id').all();
  before.close();
  const db = openDb(f);
  expect(MIGRATIONS.some((m) => m.version === 46 && m.foreignKeysOff)).toBe(true);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare('SELECT * FROM briefings ORDER BY id').all()).toEqual(briefings);
  expect(db.prepare('SELECT * FROM rulings ORDER BY id').all()).toEqual(rulings);
  expect(count(db, 'objectives_done')).toBe(1);
  const put = db.prepare(
    `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, source, state,
       created_at, updated_at) VALUES ('z', ?, ?, 'd', 'w', '[]', 'server', 'open', 't', 't')`,
  );
  put.run('goal_change', 'goal-change:1');
  expect(() => put.run('nonsense', 'x:1')).toThrow(/CHECK/);
  // The one-open-per-subject index survives the rebuild.
  expect(() => put.run('goal_change', 'goal-change:1')).toThrow(/UNIQUE/);
  db.close();
});

test('v48 adds the audit tables and lets audit be a crew drop, keeping every drop and its columns', () => {
  const f = dbAt(47, (raw) => {
    raw.exec(`INSERT INTO drop_zones (id, repo, default_branch, config_json)
      VALUES ('z', 'o/r', 'main', '{}')`);
    raw.exec(`INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at,
        was_probe, rate_limit_requeue, push_kind, transcript_pruned_at, transcript_archive,
        requested_model, served_model, input_json)
      VALUES ('d1', 'z', NULL, 'arbitrate', 'succeeded', 't', 1, 0, 'final', 'p', 'a', 'rq', 'sv',
        '{}')`);
    raw.exec(`INSERT INTO drop_events (drop_id, seq, ts, kind, data_json)
      VALUES ('d1', 1, 't', 'log', '{}')`);
  });
  const db = openDb(f);
  expect(maxVersion(db)).toBe(MIGRATIONS.length);
  expect(MIGRATIONS.find((m) => m.version === 48)?.foreignKeysOff).toBe(true);
  // The drops survive the rebuild with every column.
  expect(
    db
      .prepare(
        `SELECT role, was_probe AS p, rate_limit_requeue AS r, push_kind AS k,
           transcript_pruned_at AS tp, transcript_archive AS ta, requested_model AS rq,
           served_model AS sv, input_json AS ij FROM drops WHERE id = 'd1'`,
      )
      .get(),
  ).toEqual({
    role: 'arbitrate',
    p: 1,
    r: 0,
    k: 'final',
    tp: 'p',
    ta: 'a',
    rq: 'rq',
    sv: 'sv',
    ij: '{}',
  });
  expect(count(db, 'drop_events')).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  db.exec(`INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at,
      updated_at) VALUES ('z', 1, 't', 'b', 'a', 't', 't')`);
  const drop = db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
     VALUES (?, 'z', ?, ?, ?, 't')`,
  );
  // An audit drop is a crew drop: never with a work item.
  expect(() => drop.run('d2', 1, 'audit', 'succeeded')).toThrow(/CHECK/);
  drop.run('d3', null, 'audit', 'queued');
  // Two active crew drops in a zone are refused, audit included, both ways round.
  expect(() => drop.run('d4', null, 'refute', 'queued')).toThrow(/UNIQUE/);
  expect(() => drop.run('d4', null, 'audit', 'leased')).toThrow(/UNIQUE/);
  db.prepare(`UPDATE drops SET state = 'succeeded' WHERE id = 'd3'`).run();
  drop.run('d5', null, 'crew-lead', 'running');
  expect(() => drop.run('d6', null, 'audit', 'queued')).toThrow(/UNIQUE/);
  // The work-item drops keep their own one-active index.
  drop.run('d7', 1, 'implement', 'queued');
  expect(() => drop.run('d8', 1, 'review', 'queued')).toThrow(/UNIQUE/);

  db.prepare(
    `INSERT INTO crew_audit_cursor (zone_id, audited_sha, checked_at, updated_at)
     VALUES ('z', 'abc', 't', 't')`,
  ).run();
  expect(db.prepare('SELECT pending FROM crew_audit_cursor').get()).toEqual({ pending: 0 });
  const put = db.prepare(
    `INSERT INTO crew_audits (zone_id, sha, drop_id, state, created_at, updated_at)
     VALUES ('z', ?, 'd3', ?, 't', 't')`,
  );
  put.run('abc', 'running');
  expect(() => put.run('abc', 'running')).toThrow(/UNIQUE/);
  expect(() => put.run('def', 'reverted')).toThrow(/CHECK/);
  db.close();
});
