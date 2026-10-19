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

export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: M0_SCHEMA_SQL },
  { version: 2, sql: V2_SQL },
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
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    })();
  }
  return current();
}
