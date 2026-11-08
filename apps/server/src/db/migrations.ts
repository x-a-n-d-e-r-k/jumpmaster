import { readFileSync } from 'node:fs';
import type { Db } from './open.js';

/** Migration v1: the frozen M0 schema. Never edit schema.sql. */
export const M0_SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const V2_SQL = `
CREATE TABLE pull_requests (
  work_item_id        INTEGER PRIMARY KEY REFERENCES work_items(id),
  number              INTEGER NOT NULL,
  head_ref            TEXT NOT NULL,
  head_sha            TEXT NOT NULL,
  head_first_seen_at  TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  observed_at         TEXT NOT NULL
);

CREATE TABLE verdicts (
  id            TEXT PRIMARY KEY,
  work_item_id  INTEGER NOT NULL REFERENCES work_items(id),
  head_sha      TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('approve','request_changes')),
  forced        INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  gates_json    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX verdicts_by_item ON verdicts(work_item_id, created_at);

CREATE TABLE attempts (
  work_item_id     INTEGER NOT NULL REFERENCES work_items(id),
  key              TEXT NOT NULL,
  count            INTEGER NOT NULL DEFAULT 0,
  last_fingerprint TEXT,
  PRIMARY KEY (work_item_id, key)
);

CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge')),
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','done','unknown','failed')),
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE usage_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  status               TEXT,
  paused_until         TEXT,
  five_hour_util       REAL,
  five_hour_resets_at  TEXT,
  seven_day_util       REAL,
  seven_day_resets_at  TEXT,
  observed_at          TEXT,
  paused_at            TEXT,
  pause_confirmed      INTEGER NOT NULL DEFAULT 0,
  probe_drop_id        TEXT,
  probe_not_before     TEXT,
  cause_drop_id        TEXT,
  cause_work_item_id   INTEGER,
  updated_at           TEXT
);
INSERT INTO usage_state (id) VALUES (1);

ALTER TABLE work_items ADD COLUMN retry_label_seen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN waiting_since TEXT;

ALTER TABLE drops ADD COLUMN fingerprint TEXT;
ALTER TABLE drops ADD COLUMN pr_number INTEGER;
ALTER TABLE drops ADD COLUMN head_sha TEXT;
ALTER TABLE drops ADD COLUMN input_json TEXT;
ALTER TABLE drops ADD COLUMN charged_key TEXT;
`;

const V3_SQL = `
CREATE TABLE zone_controls (
  zone_id     TEXT PRIMARY KEY,
  mode        TEXT NOT NULL CHECK (mode IN ('active','paused','observe')),
  updated_at  TEXT NOT NULL
);

ALTER TABLE drops ADD COLUMN hard_cancel INTEGER NOT NULL DEFAULT 0;

CREATE TABLE kill_switch (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  engaged     INTEGER NOT NULL CHECK (engaged IN (0,1)),
  updated_at  TEXT NOT NULL
);

CREATE TABLE observations (
  id        INTEGER PRIMARY KEY,
  zone_id   TEXT NOT NULL,
  item_id   INTEGER REFERENCES work_items(id),
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL,
  first_at  TEXT NOT NULL,
  last_at   TEXT NOT NULL,
  count     INTEGER NOT NULL
);
CREATE TABLE artifacts (
  id          INTEGER PRIMARY KEY,
  drop_id     TEXT NOT NULL REFERENCES drops(id),
  rule        TEXT NOT NULL,
  name        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX observations_key
  ON observations (zone_id, COALESCE(item_id, 0), action, detail);
`;

/** v4: open native "blocked by" links per work item, as a JSON array of strings. */
const V4_SQL = `
ALTER TABLE work_items ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]';
`;

/** v5: for a gate park, the newest review seen and when the item was last re-decided. */
const V5_SQL = `
ALTER TABLE work_items ADD COLUMN park_reviews_seen TEXT;
ALTER TABLE work_items ADD COLUMN park_checked_at TEXT;
`;

/**
 * v6: crew drops (no work item) and zone-level outbox ops. SQLite's twelve-step rebuild of `drops`
 * and `outbox`, run with foreign keys off. `outbox.zone_id` defaults to '' so an M2 binary's
 * insert still succeeds against this schema.
 */
const V6_SQL = `
CREATE TABLE new_drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER REFERENCES work_items(id),
  role             TEXT NOT NULL,
  state            TEXT NOT NULL
                   CHECK (state IN ('queued','leased','running','succeeded','failed','lost','cancelled')),
  stick_id         TEXT REFERENCES sticks(id),
  epoch            INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  prompt_version   TEXT,
  image            TEXT,
  result_json      TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  fingerprint      TEXT,
  pr_number        INTEGER,
  head_sha         TEXT,
  input_json       TEXT,
  charged_key      TEXT,
  hard_cancel      INTEGER NOT NULL DEFAULT 0,
  CHECK ((work_item_id IS NULL) = (role IN ('crew-lead','refute','diagnose')))
);
INSERT INTO new_drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel)
SELECT id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel FROM drops;
DROP TABLE drops;
ALTER TABLE new_drops RENAME TO drops;
CREATE UNIQUE INDEX one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE work_item_id IS NULL AND state IN ('queued','leased','running');

CREATE TABLE new_outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge',
                 'create_issue','update_issue','set_labels')),
  work_item_id INTEGER REFERENCES work_items(id),
  zone_id      TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','done','unknown','failed')),
  result_json  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO new_outbox (id, op_key, kind, work_item_id, zone_id, payload_json, state, result_json,
  error, created_at, updated_at)
SELECT o.id, o.op_key, o.kind, o.work_item_id,
  COALESCE((SELECT w.drop_zone_id FROM work_items w WHERE w.id = o.work_item_id), ''),
  o.payload_json, o.state, o.result_json, o.error, o.created_at, o.updated_at FROM outbox o;
DROP TABLE outbox;
ALTER TABLE new_outbox RENAME TO outbox;
`;

/** v7: the parsed GOAL.md ladder, one row per zone. */
const V7_SQL = `
CREATE TABLE goals (
  zone_id         TEXT PRIMARY KEY,
  sha256          TEXT,
  parser_version  INTEGER NOT NULL,
  raw             TEXT,
  parse_json      TEXT NOT NULL,
  read_at         TEXT NOT NULL
);
`;

/** v8: issues the crew proposes, from intent to promotion; forge writes go through the outbox. */
const V8_SQL = `
CREATE TABLE crew_issues (
  id             INTEGER PRIMARY KEY,
  zone_id        TEXT NOT NULL,
  key            TEXT NOT NULL,
  source         TEXT NOT NULL,
  source_ref     TEXT,
  objective      TEXT NOT NULL,
  title          TEXT NOT NULL,
  title_norm     TEXT NOT NULL,
  body           TEXT NOT NULL,
  body_sha       TEXT,
  priority       TEXT,
  number         INTEGER,
  state          TEXT NOT NULL CHECK (state IN ('filing','staged','promote_held','promoting',
                   'promoted','revising','rejecting','rejected','failed')),
  refute_count   INTEGER NOT NULL DEFAULT 0,
  refuted_sha    TEXT,
  findings_json  TEXT,
  hold_until     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (zone_id, key)
);
CREATE INDEX crew_issues_by_number ON crew_issues(zone_id, number);
`;

/** v9: briefings put decisions to Command; rulings are Command's answers, applied once. */
const V9_SQL = `
CREATE TABLE briefings (
  id                 INTEGER PRIMARY KEY,
  zone_id            TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('parked','promote','promote_held',
                       'refute_exhausted','crew','credits_required')),
  subject            TEXT NOT NULL,
  decision           TEXT NOT NULL,
  why                TEXT NOT NULL,
  options_json       TEXT NOT NULL,
  recommendation     TEXT NOT NULL DEFAULT '',
  on_hold            TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL CHECK (source IN ('server','crew')),
  source_ref         TEXT,
  state              TEXT NOT NULL CHECK (state IN ('open','ruled','withdrawn')),
  diagnose_attempts  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX briefings_open_subject ON briefings(zone_id, subject) WHERE state = 'open';

CREATE TABLE rulings (
  id           INTEGER PRIMARY KEY,
  zone_id      TEXT NOT NULL,
  briefing_id  INTEGER NOT NULL UNIQUE REFERENCES briefings(id),
  choice       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  applied_at   TEXT,
  apply_error  TEXT
);
`;

/** v10: Fable's global state, and the model each drop asked for and was served. */
const V10_SQL = `
CREATE TABLE fable_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  disabled_reason  TEXT,
  paused_until     TEXT,
  updated_at       TEXT NOT NULL
);
ALTER TABLE drops ADD COLUMN requested_model TEXT;
ALTER TABLE drops ADD COLUMN served_model TEXT;
`;

/**
 * v11: the gate changes a gate park judged, in full (for Command's briefing), and Command's
 * allowance of one head's gate changes, recorded by an `allow_gate_change` ruling.
 */
const V11_SQL = `
CREATE TABLE gate_parks (
  item_id         INTEGER PRIMARY KEY REFERENCES work_items(id),
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  merge_base_sha  TEXT NOT NULL,
  details_json    TEXT NOT NULL,
  recorded_at     TEXT NOT NULL
);
CREATE TABLE gate_allowances (
  item_id    INTEGER NOT NULL REFERENCES work_items(id),
  head_sha   TEXT NOT NULL,
  ruled_at   TEXT NOT NULL,
  ruling_id  INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
);
`;

export type Migration = { version: number; sql: string; foreignKeysOff?: boolean };

export const MIGRATIONS: Migration[] = [
  { version: 1, sql: M0_SCHEMA_SQL },
  { version: 2, sql: V2_SQL },
  { version: 3, sql: V3_SQL },
  { version: 4, sql: V4_SQL },
  { version: 5, sql: V5_SQL },
  { version: 6, sql: V6_SQL, foreignKeysOff: true },
  { version: 7, sql: V7_SQL },
  { version: 8, sql: V8_SQL },
  { version: 9, sql: V9_SQL },
  { version: 10, sql: V10_SQL },
  { version: 11, sql: V11_SQL },
];

/**
 * Applies every pending migration, each in its own transaction, and returns the schema version.
 * An M0 database (tables present, no schema_version) is stamped v1 first.
 */
export function migrate(db: Db): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const current = () =>
    (db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get() as { v: number })
      .v;
  if (current() === 0) {
    const m0 = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_items'",
    );
    if (m0.get()) {
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (1, ?)').run(
        new Date().toISOString(),
      );
    }
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current()) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      if (m.foreignKeysOff) {
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length > 0) {
          throw new Error(`migration v${m.version} broke ${broken.length} foreign key(s)`);
        }
      }
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    });
    if (!m.foreignKeysOff) {
      apply();
      continue;
    }
    // SQLite ignores this pragma inside a transaction, so it is set around it.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    db.pragma('foreign_keys = OFF');
    try {
      apply();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
  }
  return current();
}
