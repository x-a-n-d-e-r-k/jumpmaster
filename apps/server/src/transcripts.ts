import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { getSetting, setSetting } from './config/revisions.js';
import type { Db } from './db/open.js';
import { ACTIVE_STATES_SQL } from './db/repo.js';

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
  prunedAt: string | null;
  archive: string | null;
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
 * An unknown drop yields nothing. A pruned drop yields its header alone, with `prunedAt` and
 * `archive` (the archive's path under the data directory, or null).
 */
export function* exportDropJsonl(db: Db, dropId: string): Generator<string> {
  const h = db
    .prepare(
      `SELECT d.id, d.drop_zone_id AS zone, d.role, d.state, d.created_at AS createdAt,
         d.finished_at AS finishedAt, s.name AS stick, d.requested_model AS requestedModel,
         d.served_model AS servedModel, d.transcript_pruned_at AS prunedAt,
         d.transcript_archive AS archive
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
    // A pruned drop says so (issue #197), so its empty transcript isn't read as one that never was.
    ...(h.prunedAt === null ? {} : { prunedAt: h.prunedAt, archive: h.archive }),
    header: true,
  });
  if (h.prunedAt !== null) return;
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

// ---------------------------------------------------------------------------------------------
// Retention (issue #197): a finished drop's events leave the database `retainDays` after it
// finished, archived first (unless the zone says not to) as the JSONL above, gzipped.

/** Drops pruned per pass, across zones. */
export const PRUNE_BATCH = 200;
/** A prune pass runs at most this often. */
export const PRUNE_EVERY_MS = 3_600_000;
/** The archive directory, under the data directory. */
export const ARCHIVE_DIR = 'transcripts';
/** How long an archive failure keeps the doctor's check at WARN. */
export const FAILURE_WINDOW_MS = 24 * 3_600_000;

const DAY_MS = 86_400_000;

/** A zone's retention setting, as the config gives it (absent: the defaults). */
export type RetentionZone = { id: string; transcripts?: { retainDays: number; archive: boolean } };

const retentionOf = (z: RetentionZone) => z.transcripts ?? { retainDays: 90, archive: true };

/**
 * Finished drops only: a state outside `ACTIVE_DROP_STATES` (so a held push is never pruned, nor
 * a state added later as active), finished before the cutoff, and not pruned already.
 */
const DUE_WHERE = `drop_zone_id = ? AND state NOT IN (${ACTIVE_STATES_SQL})
  AND finished_at IS NOT NULL AND finished_at < ? AND transcript_pruned_at IS NULL`;

/** The cutoff for a zone, or null when it keeps transcripts forever. */
function cutoffOf(z: RetentionZone, now: Date): string | null {
  const days = retentionOf(z).retainDays;
  return days > 0 ? new Date(now.getTime() - days * DAY_MS).toISOString() : null;
}

/** How many of a zone's drops are due for pruning now. */
export function countDueDrops(db: Db, zone: RetentionZone, now: Date): number {
  const cutoff = cutoffOf(zone, now);
  if (cutoff === null) return 0;
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM drops WHERE ${DUE_WHERE}`).get(zone.id, cutoff) as {
      c: number;
    }
  ).c;
}

function dueDrops(
  db: Db,
  zone: RetentionZone,
  now: Date,
  limit: number,
): { id: string; finishedAt: string }[] {
  const cutoff = cutoffOf(zone, now);
  if (cutoff === null || limit <= 0) return [];
  return db
    .prepare(
      `SELECT id, finished_at AS finishedAt FROM drops WHERE ${DUE_WHERE}
       ORDER BY finished_at, id LIMIT ?`,
    )
    .all(zone.id, cutoff, limit) as { id: string; finishedAt: string }[];
}

/** Whether the drop's events were pruned: when, and its archive (relative to the data dir). */
export function transcriptPruned(
  db: Db,
  dropId: string,
): { prunedAt: string; archive: string | null } | null {
  const row = db
    .prepare(
      `SELECT transcript_pruned_at AS prunedAt, transcript_archive AS archive FROM drops
       WHERE id = ?`,
    )
    .get(dropId) as { prunedAt: string | null; archive: string | null } | undefined;
  return row?.prunedAt ? { prunedAt: row.prunedAt, archive: row.archive } : null;
}

/** One path segment of ours: never empty, `.`, `..`, or anything with a separator. */
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** `transcripts/<zone>/<YYYY-MM of finished_at>/<dropId>.jsonl.gz`, relative to the data dir. */
export function archivePathOf(zone: string, dropId: string, finishedAt: string): string {
  const month = finishedAt.slice(0, 7);
  if (!SEGMENT.test(zone) || !SEGMENT.test(dropId) || !/^\d{4}-\d{2}$/.test(month))
    throw new Error(`no safe archive path for drop ${dropId} in zone ${zone}`);
  return `${ARCHIVE_DIR}/${zone}/${month}/${dropId}.jsonl.gz`;
}

/** Writes the lines (each with its newline) to `file`; resolves only once they are durable. */
export type ArchiveWriter = (file: string, lines: Iterable<string>) => Promise<void>;

/**
 * The lines gzipped into a temp file beside `file` (0600), fsynced, then renamed over `file` and
 * the directory fsynced: `file` is either absent, an earlier complete archive, or this one, never
 * part of one. A failure removes the temp file and throws.
 */
export const writeArchive: ArchiveWriter = async (file, lines) => {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.chmod(0o600); // Whatever the umask.
    // Each compressed chunk as it comes: the transcript is never held whole.
    // A failing source destroys the gzip stream, so the loop below throws instead of waiting.
    const gz = pipeline(Readable.from(withNewlines(lines)), createGzip(), () => {});
    for await (const chunk of gz as AsyncIterable<Buffer>) await fh.write(chunk);
    await fh.sync();
    await fh.close();
    await rename(tmp, file);
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  const dir = await open(join(file, '..'), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
};

/** Creates each directory of `rel` under `base` (0700, even ones already there). */
function privateDirs(base: string, rel: string): void {
  let at = base;
  for (const part of rel.split('/')) {
    at = join(at, part);
    mkdirSync(at, { recursive: true, mode: 0o700 });
    chmodSync(at, 0o700);
  }
}

export type ArchiveFailure = { at: string; zone: string; dropId: string; error: string };

/** The last archive write that failed, if any (the doctor warns for a day after one). */
export function lastArchiveFailure(db: Db): ArchiveFailure | undefined {
  const v = getSetting(db, 'transcripts.archive_failure');
  return v && typeof v === 'object' ? (v as ArchiveFailure) : undefined;
}

export type PruneDeps = {
  dataDir: string;
  zones: readonly RetentionZone[];
  now: Date;
  log(message: string): void;
  /** The archive writer (tests inject a failing one). */
  write?: ArchiveWriter;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One prune pass: per zone, its due drops (at most `PRUNE_BATCH` in all), each archived first when
 * the zone archives, then its events deleted and the drop marked in one transaction. A drop whose
 * archive fails keeps every event and stays unmarked (fail closed); the failures are logged once
 * for the pass and the last one recorded for the doctor. A drop already marked is never selected
 * again, so a second pass changes nothing.
 */
export async function prunePass(
  db: Db,
  deps: PruneDeps,
): Promise<{ pruned: string[]; failed: { dropId: string; error: string }[] }> {
  const write = deps.write ?? writeArchive;
  const pruned: string[] = [];
  const failed: (ArchiveFailure & { dropId: string })[] = [];
  const now = deps.now.toISOString();
  const count = db.prepare('SELECT COUNT(*) AS c FROM drop_events WHERE drop_id = ?');
  const del = db.prepare('DELETE FROM drop_events WHERE drop_id = ?');
  const mark = db.prepare(
    `UPDATE drops SET transcript_pruned_at = ?, transcript_archive = ?
     WHERE id = ? AND transcript_pruned_at IS NULL AND state NOT IN (${ACTIVE_STATES_SQL})`,
  );
  for (const zone of deps.zones) {
    const { archive } = retentionOf(zone);
    for (const d of dueDrops(db, zone, deps.now, PRUNE_BATCH - pruned.length - failed.length)) {
      let rel: string | null = null;
      let events = -1;
      if (archive) {
        try {
          rel = archivePathOf(zone.id, d.id, d.finishedAt);
          privateDirs(deps.dataDir, rel.slice(0, rel.lastIndexOf('/')));
          let lines = 0;
          const counted = function* () {
            for (const l of exportDropJsonl(db, d.id)) {
              lines++;
              yield l;
            }
          };
          await write(join(deps.dataDir, rel), counted());
          events = lines - 1;
        } catch (e) {
          failed.push({ at: now, zone: zone.id, dropId: d.id, error: message(e) });
          continue;
        }
      }
      const done = db.transaction(() => {
        // An event that arrived after the archive was written would be lost: try again next pass.
        if (events >= 0 && (count.get(d.id) as { c: number }).c !== events) return false;
        del.run(d.id);
        return mark.run(now, rel, d.id).changes === 1;
      })();
      if (done) pruned.push(d.id);
    }
  }
  if (failed.length > 0) {
    const last = failed[failed.length - 1] as ArchiveFailure;
    setSetting(db, 'transcripts.archive_failure', last, deps.now);
    deps.log(
      `transcript archive failed for ${failed.length} drop(s), nothing deleted for them: ${failed
        .map((f) => `${f.dropId} (${f.error})`)
        .join('; ')}`,
    );
  }
  return { pruned, failed: failed.map((f) => ({ dropId: f.dropId, error: f.error })) };
}

/**
 * The scheduled prune: called beside the lease sweep, it runs a pass at most once per
 * `PRUNE_EVERY_MS` (across restarts too) and never two at once. A pass that throws is logged.
 */
export function transcriptPruner(deps: {
  db: Db;
  dataDir: string;
  zones(): readonly RetentionZone[];
  log(message: string): void;
  write?: ArchiveWriter;
}): (now: Date) => Promise<void> {
  let running = false;
  return async (now) => {
    if (running) return;
    const last = getSetting(deps.db, 'transcripts.last_prune');
    if (typeof last === 'string' && now.getTime() - Date.parse(last) < PRUNE_EVERY_MS) return;
    running = true;
    try {
      setSetting(deps.db, 'transcripts.last_prune', now.toISOString(), now);
      await prunePass(deps.db, {
        dataDir: deps.dataDir,
        zones: deps.zones(),
        now,
        log: deps.log,
        ...(deps.write ? { write: deps.write } : {}),
      });
    } catch (e) {
      deps.log(`transcript prune failed: ${message(e)}`);
    } finally {
      running = false;
    }
  };
}

/** The bytes of every file under the archive directory (0 when there is none). */
export function archiveDirBytes(dataDir: string): number {
  const walk = (dir: string): number => {
    let total = 0;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) total += walk(p);
      else if (e.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // Gone since the listing.
        }
      }
    }
    return total;
  };
  return walk(join(dataDir, ARCHIVE_DIR));
}
