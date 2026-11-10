import { createHash } from 'node:crypto';
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
  item_id         INTEGER NOT NULL REFERENCES work_items(id),
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  merge_base_sha  TEXT NOT NULL,
  reason_digest   TEXT NOT NULL,
  ruled_at        TEXT NOT NULL,
  ruling_id       INTEGER NOT NULL,
  PRIMARY KEY (item_id, pr_number, head_sha)
);
ALTER TABLE rulings ADD COLUMN apply_attempts INTEGER NOT NULL DEFAULT 0;
`;

/**
 * v12: a parked briefing's diagnosis lives beside the server-built `why`, keyed to the `why` it
 * diagnosed (`diagnosis_basis`, sha256), so a pass that rebuilds the briefing keeps it. Briefings
 * written before v12 carry it inside `why` after a blank line: carved out here (see afterV12).
 */
const V12_SQL = `
ALTER TABLE briefings ADD COLUMN diagnosis TEXT;
ALTER TABLE briefings ADD COLUMN diagnosis_basis TEXT;
UPDATE briefings SET
    diagnosis = substr(why, instr(why, char(10) || char(10) || 'Diagnosis: ') + 13),
    why = substr(why, 1, instr(why, char(10) || char(10) || 'Diagnosis: ') - 1)
  WHERE kind = 'parked' AND source = 'server'
    AND instr(why, char(10) || char(10) || 'Diagnosis: ') > 0;
`;

/**
 * After the v12 SQL: the basis of each diagnosis carved (SQLite has no sha256, so it is set here),
 * and the issue number of each crew row whose create already resolved. Before v12 the row learned
 * its number only in the flush, so a create resolved while the zone was paused (or the crew off)
 * left it unnumbered and intake could not know the issue as crew by number. The op key is
 * `opKeys.issue`: `issue:<zone>:<objective>:<key>`.
 */
function afterV12(db: Db): void {
  db.exec(`
    UPDATE crew_issues SET number = (
        SELECT json_extract(o.result_json, '$.number') FROM outbox o
          WHERE o.op_key = 'issue:' || crew_issues.zone_id || ':' || crew_issues.objective || ':'
            || crew_issues.key
            AND o.state = 'done' AND o.kind = 'create_issue'
            AND json_type(o.result_json, '$.number') = 'integer')
      WHERE number IS NULL AND EXISTS (
        SELECT 1 FROM outbox o
          WHERE o.op_key = 'issue:' || crew_issues.zone_id || ':' || crew_issues.objective || ':'
            || crew_issues.key
            AND o.state = 'done' AND o.kind = 'create_issue'
            AND json_type(o.result_json, '$.number') = 'integer');
  `);
  const rows = db
    .prepare(
      'SELECT id, why FROM briefings WHERE diagnosis IS NOT NULL AND diagnosis_basis IS NULL',
    )
    .all() as { id: number; why: string }[];
  const set = db.prepare('UPDATE briefings SET diagnosis_basis = ? WHERE id = ?');
  for (const r of rows) set.run(createHash('sha256').update(r.why).digest('hex'), r.id);
}

/**
 * v13: the credits stop (spec §12.2, never buy credits). A drop that reports running on usage
 * credits stops all dispatch until the exhausted window resets (`overage_until`) or Command resumes
 * on credits for a bounded horizon; then one drop probes (`overage_probe_since`) until a live report
 * says the account runs in plan. Kept apart from the throttle columns, which an allowed event
 * clears. `credit_drops` records every drop seen on credits, for the status page.
 */
const V13_SQL = `
ALTER TABLE usage_state ADD COLUMN overage_stopped_at TEXT;
ALTER TABLE usage_state ADD COLUMN overage_drop_id TEXT;
ALTER TABLE usage_state ADD COLUMN overage_until TEXT;
ALTER TABLE usage_state ADD COLUMN overage_signal_json TEXT;
ALTER TABLE usage_state ADD COLUMN overage_resume_until TEXT;
ALTER TABLE usage_state ADD COLUMN overage_resume_drop_id TEXT;
ALTER TABLE usage_state ADD COLUMN overage_resume_work_item_id INTEGER;
ALTER TABLE usage_state ADD COLUMN overage_resumed_at TEXT;
ALTER TABLE usage_state ADD COLUMN overage_probe_since TEXT;
CREATE TABLE credit_drops (
  drop_id         TEXT PRIMARY KEY,
  zone_id         TEXT NOT NULL,
  overage_status  TEXT,
  first_at        TEXT NOT NULL,
  last_at         TEXT NOT NULL
);
`;

/**
 * v14: the zone-scoped MCP server. `briefings.source` gains `mcp` (Command's own assistant, told
 * apart from the crew), by SQLite's rebuild with foreign keys off (`rulings` references it).
 * `mcp_tokens` holds only SHA-256 hashes; `mcp_audit` records every tool call, mint and revoke, and
 * refused authentication with no token id when the token matched none. A ruling records the label
 * and effect Command chose, so a later change to the briefing's options can't change its meaning.
 */
const V14_SQL = `
CREATE TABLE new_briefings (
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
  source             TEXT NOT NULL CHECK (source IN ('server','crew','mcp')),
  source_ref         TEXT,
  state              TEXT NOT NULL CHECK (state IN ('open','ruled','withdrawn')),
  diagnose_attempts  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  diagnosis          TEXT,
  diagnosis_basis    TEXT
);
INSERT INTO new_briefings (id, zone_id, kind, subject, decision, why, options_json, recommendation,
  on_hold, source, source_ref, state, diagnose_attempts, created_at, updated_at, diagnosis,
  diagnosis_basis)
SELECT id, zone_id, kind, subject, decision, why, options_json, recommendation, on_hold, source,
  source_ref, state, diagnose_attempts, created_at, updated_at, diagnosis, diagnosis_basis
FROM briefings;
DROP TABLE briefings;
ALTER TABLE new_briefings RENAME TO briefings;
CREATE UNIQUE INDEX briefings_open_subject ON briefings(zone_id, subject) WHERE state = 'open';

CREATE TABLE mcp_tokens (
  id            INTEGER PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  zone_id       TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('read','write')),
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  last_used_at  TEXT
);

CREATE TABLE mcp_audit (
  id           INTEGER PRIMARY KEY,
  token_id     INTEGER REFERENCES mcp_tokens(id),
  zone_id      TEXT,
  tool         TEXT NOT NULL,
  args_sha256  TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok','refused','error')),
  detail       TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL
);
CREATE INDEX mcp_audit_by_token ON mcp_audit(token_id, at);
CREATE INDEX mcp_audit_by_tool ON mcp_audit(tool, id);

ALTER TABLE rulings ADD COLUMN choice_label TEXT;
ALTER TABLE rulings ADD COLUMN choice_effect TEXT;
`;

/**
 * v15: what each stick advertises, stamped (with last_seen_at) on every lease. Defaulted columns
 * only, so an M3 binary still runs against v15: its stick insert names none of them.
 */
const V15_SQL = `
ALTER TABLE sticks ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sticks ADD COLUMN image_policy TEXT NOT NULL DEFAULT 'allowlist';
ALTER TABLE sticks ADD COLUMN version TEXT;
ALTER TABLE sticks ADD COLUMN pinned_json TEXT NOT NULL DEFAULT '[]';
`;

/**
 * v16: the readiness doctor's runs, the last 20 kept (a trigger prunes older ones). A new table
 * only, so an M3 binary still runs against v16. `results_json` holds redacted checks.
 */
const V16_SQL = `
CREATE TABLE IF NOT EXISTS doctor_runs (
  id             INTEGER PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  results_json   TEXT NOT NULL DEFAULT '[]',
  drop_ids_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE TRIGGER IF NOT EXISTS doctor_runs_keep_20 AFTER INSERT ON doctor_runs
BEGIN
  DELETE FROM doctor_runs WHERE id NOT IN (SELECT id FROM doctor_runs ORDER BY id DESC LIMIT 20);
END;
`;

/**
 * v17: the `doctor` role, a drop with no work item that is not crew. SQLite's twelve-step rebuild of
 * `drops` with foreign keys off (events and artifacts reference it): the CHECK admits `doctor`
 * without a work item, the crew index is narrowed to the crew roles so a doctor drop and a crew drop
 * may be active in one zone at once, and a new index allows one active doctor drop per zone. An M3
 * binary does not run against v17 (the CHECK changed); rolling back past it is a database restore.
 */
const V17_SQL = `
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
  requested_model  TEXT,
  served_model     TEXT,
  CHECK ((work_item_id IS NULL) = (role IN ('crew-lead','refute','diagnose','doctor')))
);
INSERT INTO new_drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model)
SELECT id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model FROM drops;
DROP TABLE drops;
ALTER TABLE new_drops RENAME TO drops;
CREATE UNIQUE INDEX one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE role IN ('crew-lead','refute','diagnose')
    AND state IN ('queued','leased','running');
CREATE UNIQUE INDEX one_active_doctor_drop
  ON drops(drop_zone_id) WHERE role = 'doctor' AND state IN ('queued','leased','running');
`;

/**
 * v18: the operator login (§7.5). One operator row (its scrypt passphrase hash), browser sessions
 * (only the SHA-256 of each session id is stored) and the control audit, which keeps the last 5000
 * rows. New tables only, so an M4 binary still runs against v18.
 */
const V18_SQL = `
CREATE TABLE operator (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  passphrase_hash  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  rotated_at       TEXT
);
CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  csrf          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  sudo_until    TEXT
);
CREATE TABLE control_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('token','session','system')),
  action       TEXT NOT NULL,
  target       TEXT,
  guarded      INTEGER NOT NULL DEFAULT 0,
  detail_json  TEXT NOT NULL
);
CREATE TRIGGER control_audit_keep_5000 AFTER INSERT ON control_audit
BEGIN
  DELETE FROM control_audit WHERE id <= NEW.id - 5000;
END;
`;

export type Migration = {
  version: number;
  sql: string;
  foreignKeysOff?: boolean;
  /** Runs after `sql`, in the same transaction. */
  after?: (db: Db) => void;
};

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
  { version: 12, sql: V12_SQL, after: afterV12 },
  { version: 13, sql: V13_SQL },
  { version: 14, sql: V14_SQL, foreignKeysOff: true },
  { version: 15, sql: V15_SQL },
  { version: 16, sql: V16_SQL },
  { version: 17, sql: V17_SQL, foreignKeysOff: true },
  { version: 18, sql: V18_SQL },
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
      m.after?.(db);
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
