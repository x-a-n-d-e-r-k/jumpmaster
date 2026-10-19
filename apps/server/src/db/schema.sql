CREATE TABLE IF NOT EXISTS drop_zones (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  config_json    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  issue_number     INTEGER NOT NULL,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  author           TEXT NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 0,
  is_fix           INTEGER NOT NULL DEFAULT 0,
  issue_created_at TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'ready'
                   CHECK (state IN ('ready','in_flight','pr_open','parked','done')),
  reason           TEXT,
  pr_number        INTEGER,
  updated_at       TEXT NOT NULL,
  UNIQUE (drop_zone_id, issue_number)
);

CREATE TABLE IF NOT EXISTS sticks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  slots        INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER NOT NULL REFERENCES work_items(id),
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
  finished_at      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running');

CREATE TABLE IF NOT EXISTS drop_events (
  drop_id   TEXT NOT NULL REFERENCES drops(id),
  seq       INTEGER NOT NULL,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (drop_id, seq)
);
