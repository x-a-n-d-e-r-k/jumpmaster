import type { Db } from './db/open.js';

/**
 * Transcript export (issue #195): a drop's stored events as JSONL, one JSON object per line, for
 * the operator to grep and analyse outside the database. The retention issue reuses
 * `exportDropJsonl` to archive a drop before it is pruned.
 *
 * The lines come lazily, a page of events at a time, each page read whole (`.all()`): no SQLite
 * iterator stays open between lines, so a consumer that awaits between them (an HTTP stream)
 * never holds the connection busy while other requests write.
 */

/** Events read per query. */
const PAGE = 500;

/** The longest zone export window, in days. */
export const MAX_WINDOW_DAYS = 92;

type HeaderRow = {
  id: string;
  zone: string;
  role: string;
  state: string;
  createdAt: string;
  finishedAt: string | null;
  stick: string | null;
  requestedModel: string | null;
  servedModel: string | null;
};

type EventRow = { seq: number; ts: string; kind: string; dataJson: string };

/**
 * A raw newline is never inside a JSON string, so one in stored JSON is whitespace: it becomes a
 * space, keeping a line one line. Stored JSON (`JSON.stringify`) has none, and passes unchanged.
 */
const oneLine = (json: string): string =>
  /[\r\n]/.test(json) ? json.replace(/\r\n?|\n/g, ' ') : json;

/**
 * The lines of one drop's transcript, without line endings: a header (`header: true`), then every
 * stored event in `seq` order with its `data` exactly as stored (already redacted by the trooper).
 * An unknown drop yields nothing.
 */
export function* exportDropJsonl(db: Db, dropId: string): Generator<string> {
  const h = db
    .prepare(
      `SELECT d.id, d.drop_zone_id AS zone, d.role, d.state, d.created_at AS createdAt,
         d.finished_at AS finishedAt, s.name AS stick, d.requested_model AS requestedModel,
         d.served_model AS servedModel
       FROM drops d LEFT JOIN sticks s ON s.id = d.stick_id WHERE d.id = ?`,
    )
    .get(dropId) as HeaderRow | undefined;
  if (!h) return;
  yield JSON.stringify({
    dropId: h.id,
    zone: h.zone,
    role: h.role,
    state: h.state,
    createdAt: h.createdAt,
    finishedAt: h.finishedAt,
    stick: h.stick,
    requestedModel: h.requestedModel,
    servedModel: h.servedModel,
    header: true,
  });
  // The fields every event line shares, before its own.
  const prefix = `{"dropId":${JSON.stringify(h.id)},"zone":${JSON.stringify(h.zone)},"role":${JSON.stringify(h.role)}`;
  const page = db.prepare(
    `SELECT seq, ts, kind, data_json AS dataJson FROM drop_events
     WHERE drop_id = ? AND seq > ? ORDER BY seq LIMIT ${PAGE}`,
  );
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows = page.all(h.id, after) as EventRow[];
    for (const e of rows)
      yield `${prefix},"seq":${e.seq},"ts":${JSON.stringify(e.ts)},"kind":${JSON.stringify(e.kind)},"data":${oneLine(e.dataJson)}}`;
    if (rows.length < PAGE) return;
    after = (rows[rows.length - 1] as EventRow).seq;
  }
}

/** The ids of a zone's drops created in `[since, until)` (ISO instants), oldest first. */
export function zoneDropIds(db: Db, zone: string, since: string, until: string): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM drops WHERE drop_zone_id = ? AND created_at >= ? AND created_at < ?
         ORDER BY created_at, id`,
      )
      .all(zone, since, until) as { id: string }[]
  ).map((r) => r.id);
}

/** The lines of each drop in turn, as `exportDropJsonl` gives them. */
export function* exportDropsJsonl(db: Db, dropIds: Iterable<string>): Generator<string> {
  for (const id of dropIds) yield* exportDropJsonl(db, id);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** An ISO date (`YYYY-MM-DD`, UTC midnight) or instant with its offset, as `toISOString`; else null. */
export function parseInstant(s: string | undefined): string | null {
  if (s === undefined) return null;
  const date = DATE.test(s);
  if (!date && !INSTANT.test(s)) return null;
  const ms = Date.parse(date ? `${s}T00:00:00.000Z` : s);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // `2026-02-30` parses to March 2nd in some engines: a date must round-trip.
  if (date && iso.slice(0, 10) !== s) return null;
  return iso;
}

/**
 * The zone export window from its query: `since` required, `until` defaulting to now, `since`
 * before `until`, at most `MAX_WINDOW_DAYS` days. An error is a sentence for a 400.
 */
export function exportWindow(
  q: { since?: unknown; until?: unknown },
  now: Date,
): { since: string; until: string } | { error: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const since = parseInstant(str(q.since));
  if (since === null)
    return { error: 'since is required: an ISO date (YYYY-MM-DD) or instant (…T…Z)' };
  const until = q.until === undefined ? now.toISOString() : parseInstant(str(q.until));
  if (until === null) return { error: 'until is an ISO date (YYYY-MM-DD) or instant (…T…Z)' };
  const span = Date.parse(until) - Date.parse(since);
  if (span <= 0) return { error: 'since must be before until' };
  if (span > MAX_WINDOW_DAYS * 86_400_000)
    return { error: `the window is at most ${MAX_WINDOW_DAYS} days` };
  return { since, until };
}

/** Whether the database has a row for the zone (a zone removed from the config keeps its drops). */
export function zoneRecorded(db: Db, zone: string): boolean {
  return db.prepare('SELECT 1 FROM drop_zones WHERE id = ?').get(zone) !== undefined;
}

/** Each line with its line ending, as a JSONL stream sends it. */
export function* withNewlines(lines: Iterable<string>): Generator<string> {
  for (const l of lines) yield `${l}\n`;
}
