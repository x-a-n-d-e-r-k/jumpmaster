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

/**
 * v19: the config store (§10.3 live config). Every revision holds the whole validated editable
 * document (never a secret), kept in full and never deleted; `settings` holds `config.mode`,
 * `config.current`, `config.restart_pending` and `setup.step`. New tables only, so an M4 binary
 * still runs against v19 (and reads its config file).
 */
const V19_SQL = `
CREATE TABLE config_revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id    INTEGER,
  config_json  TEXT NOT NULL,
  source_hash  TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('file','ui','ctl','rollback','adopt','import','setup')),
  note         TEXT CHECK (length(note) <= 500),
  created_at   TEXT NOT NULL
);
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/**
 * v20: the credential vault (§7.5). Values only as AES-256-GCM ciphertext under a key file kept
 * outside the data directory, with the metadata the Credentials tab shows. New table only, so an
 * M4 binary still runs against v20.
 */
const V20_SQL = `
CREATE TABLE vault (
  name                 TEXT PRIMARY KEY,
  ciphertext           BLOB NOT NULL,
  nonce                BLOB NOT NULL,
  key_id               TEXT NOT NULL,
  fingerprint          TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  declared_created_at  TEXT,
  tested_at            TEXT,
  test_result          TEXT,
  login                TEXT,
  note                 TEXT
);
`;

/**
 * v21: the label action (§10.3, doctor fix links): the outbox may hold `create_labels`, the one op
 * the operator starts from the doctor, allowed in observe. SQLite cannot widen a CHECK in place:
 * the twelve-step rebuild of `outbox`, rows and columns kept, with foreign keys off. An older
 * binary still reads the table (an unknown kind is never one it writes).
 */
const V21_SQL = `
CREATE TABLE new_outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge',
                 'create_issue','update_issue','set_labels','create_labels')),
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
SELECT id, op_key, kind, work_item_id, zone_id, payload_json, state, result_json, error,
  created_at, updated_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE new_outbox RENAME TO outbox;
`;

/**
 * v22: the push container (pending pushes). The twelve-step rebuild of `drops` with foreign keys off
 * (events and artifacts reference it): the state CHECK admits `push_pending` (an active state, so the
 * three active-drop indexes include it), and new columns hold the push request (`push_kind`,
 * `push_expect_sha`, `push_deadline`), the first heartbeat that ran the drop (`running_at`, for the
 * reclaim window), whether usage was already applied (`usage_applied`) and whether the drop held the
 * probe (`was_probe`). `kill_switch.engaged_at` times a pause so deadlines can be extended on release,
 * and `push_tokens` records grant reservations. An older binary does not run against v22 (the CHECK
 * changed); rolling back past it is a database restore.
 */
const V22_SQL = `
CREATE TABLE new_drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER REFERENCES work_items(id),
  role             TEXT NOT NULL,
  state            TEXT NOT NULL
                   CHECK (state IN ('queued','leased','running','push_pending','succeeded','failed','lost','cancelled')),
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
  push_kind        TEXT CHECK (push_kind IN ('final','checkpoint','salvage')),
  push_expect_sha  TEXT,
  push_deadline    TEXT,
  running_at       TEXT,
  usage_applied    INTEGER NOT NULL DEFAULT 0,
  was_probe        INTEGER NOT NULL DEFAULT 0,
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
  ON drops(work_item_id) WHERE state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE role IN ('crew-lead','refute','diagnose')
    AND state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_doctor_drop
  ON drops(drop_zone_id) WHERE role = 'doctor'
    AND state IN ('queued','leased','running','push_pending');

ALTER TABLE kill_switch ADD COLUMN engaged_at TEXT;

CREATE TABLE push_tokens (
  drop_id      TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  reserved_at  TEXT NOT NULL,
  minted_at    TEXT,
  revoked_at   TEXT,
  PRIMARY KEY (drop_id, epoch, seq)
);
`;

/**
 * v23: whether a rate-limited drop's requeue was due when its usage was applied
 * (`rate_limit_requeue`: 1 paused, 0 not, NULL not decided). A push-requested result applies usage
 * early and its outcome after the push: the outcome must judge the pause as it was then.
 */
const V23_SQL = `
ALTER TABLE drops ADD COLUMN rate_limit_requeue INTEGER;
`;

/**
 * v24: a zone the operator asked to stop managing (§ issue #100): set to observe, and removed by
 * the server once drained, across restarts. `stopping_via` is the removal's revision via.
 */
const V24_SQL = `
ALTER TABLE zone_controls ADD COLUMN stopping_since TEXT;
ALTER TABLE zone_controls ADD COLUMN stopping_via TEXT CHECK (stopping_via IN ('ui','ctl'));
`;

/**
 * v25: Command can dismiss a briefing (`state` gains `dismissed`, issue #98): taken off the floor
 * without a ruling, so its condition is not ruled on. SQLite's rebuild, foreign keys off
 * (`rulings` references it).
 */
const V25_SQL = `
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
  state              TEXT NOT NULL CHECK (state IN ('open','ruled','withdrawn','dismissed')),
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
`;

/**
 * v26: the operator sets each stick's trooper count from the UI (issue #136). `desired_slots` is
 * that count (NULL: the enrolled `slots`); `max_slots` is the ceiling the stick last reported
 * (NULL: a stick too old to report one, capped at its enrolled `slots`).
 */
const V26_SQL = `
ALTER TABLE sticks ADD COLUMN desired_slots INTEGER;
ALTER TABLE sticks ADD COLUMN max_slots INTEGER;
`;

/**
 * v27: the latest value of every usage window the account reports (#144), keyed as reported
 * (`seven_day_fable`...). usage_state keeps five_hour and seven_day, which the gate reads.
 */
const V27_SQL = `
CREATE TABLE usage_windows (
  key          TEXT PRIMARY KEY,
  utilization  REAL,
  resets_at    TEXT,
  observed_at  TEXT
);
`;

/**
 * v28: adding a stick with one pasted line (issue #138). `stick_invites` holds each one-time
 * enrollment code by its SHA-256 only (`slots` NULL: Auto); `used_at` and `stick_id` are set in
 * the enrollment's transaction. On `sticks`: `auto_slots` (enrolled from an Auto invite: its
 * ceiling governs while no count is set), `removed_at` (removed: its token is revoked), and the
 * health it last reported (`docker_version`, `free_bytes`).
 */
const V28_SQL = `
CREATE TABLE stick_invites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slots       INTEGER,
  code_hash   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  stick_id    TEXT REFERENCES sticks(id),
  cancelled_at TEXT
);
ALTER TABLE sticks ADD COLUMN auto_slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sticks ADD COLUMN removed_at TEXT;
ALTER TABLE sticks ADD COLUMN docker_version TEXT;
ALTER TABLE sticks ADD COLUMN free_bytes INTEGER;
`;

/**
 * v29: issue comments (#182): the outbox may hold `comment_issue`. The same twelve-step rebuild
 * of `outbox` as v21, rows and columns kept, with foreign keys off.
 */
const V29_SQL = `
CREATE TABLE new_outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge',
                 'create_issue','update_issue','set_labels','create_labels','comment_issue')),
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
SELECT id, op_key, kind, work_item_id, zone_id, payload_json, state, result_json, error,
  created_at, updated_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE new_outbox RENAME TO outbox;
`;

/**
 * v30: the triage role (#184). `triage_requests` holds one request per issue text
 * (`body_sha`), and `drops` is rebuilt so `triage` is a crew role: the work-item CHECK and the
 * one-active-crew-drop index both name it. Rows and columns kept, foreign keys off.
 */
const V30_SQL = `
CREATE TABLE triage_requests (
  id            INTEGER PRIMARY KEY,
  zone_id       TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  body_sha      TEXT NOT NULL,
  author        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('open','waiting','done','failed')),
  outcome       TEXT CHECK (outcome IN ('split','questions','not-agent-work')),
  reason        TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  briefing_id   INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (zone_id, issue_number, body_sha)
);

CREATE TABLE new_drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER REFERENCES work_items(id),
  role             TEXT NOT NULL,
  state            TEXT NOT NULL
                   CHECK (state IN ('queued','leased','running','push_pending','succeeded','failed','lost','cancelled')),
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
  push_kind        TEXT CHECK (push_kind IN ('final','checkpoint','salvage')),
  push_expect_sha  TEXT,
  push_deadline    TEXT,
  running_at       TEXT,
  usage_applied    INTEGER NOT NULL DEFAULT 0,
  was_probe        INTEGER NOT NULL DEFAULT 0,
  rate_limit_requeue INTEGER,
  CHECK ((work_item_id IS NULL) = (role IN ('crew-lead','refute','diagnose','triage','doctor')))
);
INSERT INTO new_drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue)
SELECT id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue FROM drops;
DROP TABLE drops;
ALTER TABLE new_drops RENAME TO drops;
CREATE UNIQUE INDEX one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE role IN ('crew-lead','refute','diagnose','triage')
    AND state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_doctor_drop
  ON drops(drop_zone_id) WHERE role = 'doctor'
    AND state IN ('queued','leased','running','push_pending');
`;

export type Migration = {
  version: number;
  sql: string;
  foreignKeysOff?: boolean;
  /** Runs after `sql`, in the same transaction. */
  after?: (db: Db) => void;
};

/**
 * Migration v31 (issue #197): transcript retention. A drop whose events were pruned records when,
 * and where its archive went (relative to the data directory; null when the zone archives nothing).
 */
const V31_SQL = `
ALTER TABLE drops ADD COLUMN transcript_pruned_at TEXT;
ALTER TABLE drops ADD COLUMN transcript_archive TEXT;
`;

/**
 * v32: objectives Command ruled done, beside the goal file's own ` (done)` marks (#245), and the
 * `objective_done` briefing kind that asks for the ruling. SQLite's rebuild of `briefings`, foreign
 * keys off (`rulings` references it).
 */
const V32_SQL = `
CREATE TABLE new_briefings (
  id                 INTEGER PRIMARY KEY,
  zone_id            TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('parked','promote','promote_held',
                       'refute_exhausted','crew','credits_required','objective_done')),
  subject            TEXT NOT NULL,
  decision           TEXT NOT NULL,
  why                TEXT NOT NULL,
  options_json       TEXT NOT NULL,
  recommendation     TEXT NOT NULL DEFAULT '',
  on_hold            TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL CHECK (source IN ('server','crew','mcp')),
  source_ref         TEXT,
  state              TEXT NOT NULL CHECK (state IN ('open','ruled','withdrawn','dismissed')),
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

CREATE TABLE objectives_done (
  zone_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  done_at    TEXT NOT NULL,
  ruling_id  INTEGER NOT NULL REFERENCES rulings(id),
  PRIMARY KEY (zone_id, key)
);
`;

/**
 * v33: why sync's triage gate held an issue back (#247): its drop-ready format reasons and the
 * protected paths it names, as a JSON array of strings. Null for a request recorded before, or
 * with nothing to say. `reason` stays the outcome's.
 */
const V33_SQL = `
ALTER TABLE triage_requests ADD COLUMN gate_reasons TEXT;
`;

/**
 * v34: a split's parts inherit the parent's blockers (#297): the outbox may hold
 * `add_blocked_by`. The same twelve-step rebuild of `outbox` as v29, rows and columns kept, with
 * foreign keys off.
 */
const V34_SQL = `
CREATE TABLE new_outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge',
                 'create_issue','update_issue','set_labels','create_labels','comment_issue',
                 'add_blocked_by')),
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
SELECT id, op_key, kind, work_item_id, zone_id, payload_json, state, result_json, error,
  created_at, updated_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE new_outbox RENAME TO outbox;
`;

/**
 * v35: the files an open PR changes (#291), as a JSON array of paths (renames add their previous
 * path), stored by each pass that reads the complete list. Null is unknown: never read, or a list
 * GitHub cut short. The scheduler holds back a ready item whose Placement names one of them.
 */
const V35_SQL = `
ALTER TABLE work_items ADD COLUMN pr_files TEXT;
`;

/**
 * v36 (#292): the outbox takes `update_branch` (GitHub merging the base into a PR's head), and
 * `branch_updates` records, per item, head and base SHA, what came of updating that head: the
 * failed requests so far, and `updated` (charged to base_sync once) or `conflict` (the resolve
 * drop runs instead: a real conflict, or the fallback after failures or with no push token).
 */
const V36_SQL = `
CREATE TABLE new_outbox (
  id           TEXT PRIMARY KEY,
  op_key       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge',
                 'create_issue','update_issue','set_labels','create_labels','comment_issue',
                 'add_blocked_by','update_branch')),
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
SELECT id, op_key, kind, work_item_id, zone_id, payload_json, state, result_json, error,
  created_at, updated_at FROM outbox;
DROP TABLE outbox;
ALTER TABLE new_outbox RENAME TO outbox;
CREATE TABLE branch_updates (
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  head_sha     TEXT NOT NULL,
  base_sha     TEXT NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT CHECK (outcome IN ('updated','conflict')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (work_item_id, head_sha, base_sha)
);
`;

/**
 * v37: the pasted code is swapped for an install token at once (issue #269). `kind` is how the
 * invite will be installed (`line`: 24 hours; `cloud_init`: 1 hour). `exchanged_at` marks the
 * exchange, after which the code works nowhere; the token is kept by its SHA-256 only
 * (`token_hash`), until `token_expires_at`. An exchanged invite whose token expired counts as
 * cancelled.
 */
const V37_SQL = `
ALTER TABLE stick_invites ADD COLUMN kind TEXT NOT NULL DEFAULT 'line'
  CHECK (kind IN ('line','cloud_init'));
ALTER TABLE stick_invites ADD COLUMN exchanged_at TEXT;
ALTER TABLE stick_invites ADD COLUMN token_hash TEXT;
ALTER TABLE stick_invites ADD COLUMN token_expires_at TEXT;
CREATE UNIQUE INDEX stick_invites_token_hash ON stick_invites (token_hash);
`;

/**
 * v38 (#349): per-turn chat MCP tokens. `mcp_tokens.scope` takes `chat`, and a chat token names the
 * thread and message whose turn it serves and the hash of the browser session that posted that
 * message (`zone_id` is `*`: the zone is a tool argument). The same twelve-step rebuild, rows and
 * ids kept, with foreign keys off (`mcp_audit` references it).
 */
const V38_SQL = `
CREATE TABLE new_mcp_tokens (
  id               INTEGER PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  zone_id          TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('read','write','chat')),
  label            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT,
  last_used_at     TEXT,
  chat_thread_id   INTEGER,
  chat_message_id  INTEGER,
  session_hash     TEXT
);
INSERT INTO new_mcp_tokens (id, token_hash, zone_id, scope, label, created_at, expires_at,
  revoked_at, last_used_at)
SELECT id, token_hash, zone_id, scope, label, created_at, expires_at, revoked_at, last_used_at
FROM mcp_tokens;
DROP TABLE mcp_tokens;
ALTER TABLE new_mcp_tokens RENAME TO mcp_tokens;
`;

/**
 * v39 (#350): the crew chat's threads and messages. A message's `seq` is its place in its thread,
 * allocated inside the insert; `session_hash` is the hash of the browser session that posted an
 * owner message (never the session id), so a guarded change it asks for binds to that session.
 */
const V39_SQL = `
CREATE TABLE chat_threads (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  focus_kind         TEXT CHECK (focus_kind IN ('zone','goals','briefing')),
  focus_zone_id      TEXT,
  focus_ref          TEXT,
  claude_session_id  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX chat_threads_updated ON chat_threads (updated_at);
CREATE TABLE chat_messages (
  id            INTEGER PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES chat_threads(id),
  seq           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','assistant','tool','system')),
  text          TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('queued','running','done','failed')),
  session_hash  TEXT,
  usage_json    TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
`;

/**
 * v40: the model of the drop that reported each usage window (#377). A per-model window such as
 * `seven_day_overage_included` does not name its model; the drop's model does. NULL on rows
 * stored before.
 */
const V40_SQL = `
ALTER TABLE usage_windows ADD COLUMN model TEXT;
`;

/**
 * v41 (#382): the arbiter. `arbitrations` records one ruling per subject and basis (the text it
 * judged), and `drops` is rebuilt with foreign keys off so `arbitrate` is a crew role: the
 * work-item CHECK and the one-active crew drop index both name it. Every v40 column is carried.
 */
const V41_SQL = `
CREATE TABLE arbitrations (
  id           INTEGER PRIMARY KEY,
  zone_id      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  basis        TEXT NOT NULL,
  drop_id      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending','ruled','failed','discarded')),
  ruling       TEXT CHECK (ruling IN ('A','B','insufficient_evidence')),
  acted        INTEGER NOT NULL DEFAULT 0,
  because      TEXT,
  instruction  TEXT,
  reason       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (subject, basis)
);

CREATE TABLE new_drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER REFERENCES work_items(id),
  role             TEXT NOT NULL,
  state            TEXT NOT NULL
                   CHECK (state IN ('queued','leased','running','push_pending','succeeded','failed','lost','cancelled')),
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
  push_kind        TEXT CHECK (push_kind IN ('final','checkpoint','salvage')),
  push_expect_sha  TEXT,
  push_deadline    TEXT,
  running_at       TEXT,
  usage_applied    INTEGER NOT NULL DEFAULT 0,
  was_probe        INTEGER NOT NULL DEFAULT 0,
  rate_limit_requeue INTEGER,
  transcript_pruned_at TEXT,
  transcript_archive TEXT,
  CHECK ((work_item_id IS NULL) = (role IN ('crew-lead','refute','diagnose','triage','arbitrate','doctor')))
);
INSERT INTO new_drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue,
  transcript_pruned_at, transcript_archive)
SELECT id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue,
  transcript_pruned_at, transcript_archive FROM drops;
DROP TABLE drops;
ALTER TABLE new_drops RENAME TO drops;
CREATE UNIQUE INDEX one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE role IN ('crew-lead','refute','diagnose','triage','arbitrate')
    AND state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_doctor_drop
  ON drops(drop_zone_id) WHERE role = 'doctor'
    AND state IN ('queued','leased','running','push_pending');
`;

/**
 * v42 (#356, the crew chat's control_audit rebuild): `via` may be `chat`, the actor of an action a
 * chat turn took. Every row is carried with its id, the AUTOINCREMENT sequence continues where it
 * was, and the keep-the-last-5000 trigger is recreated (dropping the old table dropped it).
 */
const V42_SQL = `
CREATE TABLE new_control_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('token','session','chat','system')),
  action       TEXT NOT NULL,
  target       TEXT,
  guarded      INTEGER NOT NULL DEFAULT 0,
  detail_json  TEXT NOT NULL
);
INSERT INTO new_control_audit (id, at, via, action, target, guarded, detail_json)
  SELECT id, at, via, action, target, guarded, detail_json FROM control_audit;
DELETE FROM sqlite_sequence WHERE name = 'new_control_audit';
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'new_control_audit', seq FROM sqlite_sequence WHERE name = 'control_audit';
DROP TABLE control_audit;
ALTER TABLE new_control_audit RENAME TO control_audit;
CREATE TRIGGER control_audit_keep_5000 AFTER INSERT ON control_audit
BEGIN
  DELETE FROM control_audit WHERE id <= NEW.id - 5000;
END;
`;

/**
 * v43 (#357, the crew chat's cards): one row per action a chat turn took or was refused, written
 * from the server's own record of the action (never the model's text). A card is the thread's and
 * message's of the chat token that acted. `undo_json` is what Undo needs; null where there is none
 * (a ruling has no Undo).
 */
const V43_SQL = `
CREATE TABLE chat_cards (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL,
  message_id  INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  zone_id     TEXT,
  target      TEXT,
  link        TEXT,
  state       TEXT NOT NULL CHECK (state IN ('done','pending','refused','undone')),
  summary     TEXT NOT NULL,
  undo_json   TEXT,
  created_at  TEXT NOT NULL,
  undone_at   TEXT
);
CREATE INDEX chat_cards_by_thread ON chat_cards (thread_id, id);
`;

/**
 * v44 (#383): an item's arbitration that acted is applied once (Command's Retry on the parked
 * item): `applied_at` records when, so two passes never retry it twice. (Ships as v44: v43 was
 * taken by the chat cards.)
 */
const V44_SQL = `
ALTER TABLE arbitrations ADD COLUMN applied_at TEXT;
`;

/**
 * v45 (#362, goal changes): one row per proposed GOAL.md change, from the chat or the crew. The
 * server opens it as a PR on `jm/goal-change-<id>` (`base_sha`, `branch`, `pr_number`, `head_sha`),
 * and merges it only at the SHA the owner confirmed in the browser (`confirmed_sha`).
 */
const V45_SQL = `
CREATE TABLE goal_changes (
  id            INTEGER PRIMARY KEY,
  zone_id       TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('chat','crew')),
  source_ref    TEXT,
  text          TEXT NOT NULL,
  text_sha256   TEXT NOT NULL,
  base_sha      TEXT,
  branch        TEXT,
  pr_number     INTEGER,
  head_sha      TEXT,
  state         TEXT NOT NULL
                CHECK (state IN ('proposed','open','confirmed','merged','refused','closed')),
  confirmed_sha TEXT,
  confirmed_at  TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX goal_changes_by_zone_state ON goal_changes (zone_id, state, id);
`;

/**
 * v46 (#364, the plan's v43: v43 to v45 were taken): the crew lead may propose a goal change, so
 * `briefings.kind` gains `goal_change`. SQLite's rebuild of `briefings`, foreign keys off
 * (`rulings` references it), every row and column kept.
 */
const V46_SQL = `
CREATE TABLE new_briefings (
  id                 INTEGER PRIMARY KEY,
  zone_id            TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('parked','promote','promote_held',
                       'refute_exhausted','crew','credits_required','objective_done',
                       'goal_change')),
  subject            TEXT NOT NULL,
  decision           TEXT NOT NULL,
  why                TEXT NOT NULL,
  options_json       TEXT NOT NULL,
  recommendation     TEXT NOT NULL DEFAULT '',
  on_hold            TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL CHECK (source IN ('server','crew','mcp')),
  source_ref         TEXT,
  state              TEXT NOT NULL CHECK (state IN ('open','ruled','withdrawn','dismissed')),
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
`;

/**
 * #396: a crew retry of a parked item, on its own diagnosis. `UNIQUE (item_id)` is the cap: one
 * crew retry per work item, ever. Recorded in the diagnose result's transaction, applied (claimed
 * by `applied_at`) by the next active pass.
 */
const V47_SQL = `
CREATE TABLE crew_retries (
  id           INTEGER PRIMARY KEY,
  zone_id      TEXT NOT NULL,
  item_id      INTEGER NOT NULL UNIQUE REFERENCES work_items(id),
  briefing_id  INTEGER NOT NULL REFERENCES briefings(id),
  drop_id      TEXT NOT NULL,
  diagnosis    TEXT NOT NULL,
  instruction  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  applied_at   TEXT,
  outcome      TEXT CHECK (outcome IN ('retried', 'skipped'))
);
`;

/**
 * v48 (#385): the audit of merged changes. `crew_audit_cursor` holds each zone's last audited
 * commit on the default branch; `crew_audits` records one audit per (zone, commit). `drops` is
 * rebuilt with foreign keys off so `audit` is a crew role: the work-item CHECK and the one-active
 * crew drop index both name it. Every v47 column is carried.
 */
const V48_SQL = `
CREATE TABLE crew_audit_cursor (
  zone_id      TEXT PRIMARY KEY,
  audited_sha  TEXT NOT NULL,
  pending      INTEGER NOT NULL DEFAULT 0,
  checked_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE crew_audits (
  id             INTEGER PRIMARY KEY,
  zone_id        TEXT NOT NULL,
  sha            TEXT NOT NULL,
  drop_id        TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('running','holds','filed','refused','failed')),
  crew_issue_id  INTEGER,
  reason         TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (zone_id, sha)
);

CREATE TABLE new_drops (
  id               TEXT PRIMARY KEY,
  drop_zone_id     TEXT NOT NULL REFERENCES drop_zones(id),
  work_item_id     INTEGER REFERENCES work_items(id),
  role             TEXT NOT NULL,
  state            TEXT NOT NULL
                   CHECK (state IN ('queued','leased','running','push_pending','succeeded','failed','lost','cancelled')),
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
  push_kind        TEXT CHECK (push_kind IN ('final','checkpoint','salvage')),
  push_expect_sha  TEXT,
  push_deadline    TEXT,
  running_at       TEXT,
  usage_applied    INTEGER NOT NULL DEFAULT 0,
  was_probe        INTEGER NOT NULL DEFAULT 0,
  rate_limit_requeue INTEGER,
  transcript_pruned_at TEXT,
  transcript_archive TEXT,
  CHECK ((work_item_id IS NULL) = (role IN ('crew-lead','refute','diagnose','triage','arbitrate','audit','doctor')))
);
INSERT INTO new_drops (id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue,
  transcript_pruned_at, transcript_archive)
SELECT id, drop_zone_id, work_item_id, role, state, stick_id, epoch, lease_expires_at,
  prompt_version, image, result_json, created_at, started_at, finished_at, fingerprint, pr_number,
  head_sha, input_json, charged_key, hard_cancel, requested_model, served_model, push_kind,
  push_expect_sha, push_deadline, running_at, usage_applied, was_probe, rate_limit_requeue,
  transcript_pruned_at, transcript_archive FROM drops;
DROP TABLE drops;
ALTER TABLE new_drops RENAME TO drops;
CREATE UNIQUE INDEX one_active_drop
  ON drops(work_item_id) WHERE state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_crew_drop
  ON drops(drop_zone_id) WHERE role IN ('crew-lead','refute','diagnose','triage','arbitrate','audit')
    AND state IN ('queued','leased','running','push_pending');
CREATE UNIQUE INDEX one_active_doctor_drop
  ON drops(drop_zone_id) WHERE role = 'doctor'
    AND state IN ('queued','leased','running','push_pending');
`;

/**
 * #420: the crew's one action on a parked item is a `retry` or a `rerun` of failed checks; the
 * `UNIQUE (item_id)` cap counts both. A rerun names its `checks` (a JSON array) and, once the forge
 * re-ran them, `rerun_at`; a crew action settled `skipped` says why in `reason` (the briefing
 * quotes it).
 */
const V49_SQL = `
ALTER TABLE crew_retries ADD COLUMN kind TEXT NOT NULL DEFAULT 'retry'
  CHECK (kind IN ('retry', 'rerun'));
ALTER TABLE crew_retries ADD COLUMN checks TEXT;
ALTER TABLE crew_retries ADD COLUMN rerun_at TEXT;
ALTER TABLE crew_retries ADD COLUMN reason TEXT;
`;

/**
 * v50: a gate allowance carried to a new head when only main was merged in names the head it was
 * carried from (null for an allowance Command ruled on that head itself).
 */
const V50_SQL = `
ALTER TABLE gate_allowances ADD COLUMN carried_from_head TEXT;
`;

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
  { version: 19, sql: V19_SQL },
  { version: 20, sql: V20_SQL },
  { version: 21, sql: V21_SQL, foreignKeysOff: true },
  { version: 22, sql: V22_SQL, foreignKeysOff: true },
  { version: 23, sql: V23_SQL },
  { version: 24, sql: V24_SQL },
  { version: 25, sql: V25_SQL, foreignKeysOff: true },
  { version: 26, sql: V26_SQL },
  { version: 27, sql: V27_SQL },
  { version: 28, sql: V28_SQL },
  { version: 29, sql: V29_SQL, foreignKeysOff: true },
  { version: 30, sql: V30_SQL, foreignKeysOff: true },
  { version: 31, sql: V31_SQL },
  { version: 32, sql: V32_SQL, foreignKeysOff: true },
  { version: 33, sql: V33_SQL },
  { version: 34, sql: V34_SQL, foreignKeysOff: true },
  { version: 35, sql: V35_SQL },
  { version: 36, sql: V36_SQL, foreignKeysOff: true },
  { version: 37, sql: V37_SQL },
  { version: 38, sql: V38_SQL, foreignKeysOff: true },
  { version: 39, sql: V39_SQL },
  { version: 40, sql: V40_SQL },
  { version: 41, sql: V41_SQL, foreignKeysOff: true },
  { version: 42, sql: V42_SQL },
  { version: 43, sql: V43_SQL },
  { version: 44, sql: V44_SQL },
  { version: 45, sql: V45_SQL },
  { version: 46, sql: V46_SQL, foreignKeysOff: true },
  { version: 47, sql: V47_SQL },
  { version: 48, sql: V48_SQL, foreignKeysOff: true },
  { version: 49, sql: V49_SQL },
  { version: 50, sql: V50_SQL },
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
