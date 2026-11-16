import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import { upsertDropZone } from './db/repo.js';
import { tmpDbFile } from './test/helpers.js';
import { addTranscriptDrop } from './test/transcriptWorld.js';
import {
  archiveDirBytes,
  countDueDrops,
  exportDropJsonl,
  exportDropsJsonl,
  lastArchiveFailure,
  PRUNE_BATCH,
  prunePass,
  transcriptPruned,
  transcriptPruner,
  withNewlines,
  writeArchive,
} from './transcripts.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

type Retention = { retainDays: number; archive: boolean };
const zone = (id: string, t: Retention = { retainDays: 90, archive: true }) => ({
  id,
  transcripts: t,
});

function world(): { db: Db; dataDir: string } {
  const db = openDb(tmpDbFile());
  for (const id of ['jm', 'other'])
    upsertDropZone(db, { id, repo: `o/${id}`, defaultBranch: 'main', configJson: '{}' });
  const dataDir = mkdtempSync(join(tmpdir(), 'jm-data-'));
  return { db, dataDir };
}

const EVENTS = [
  { kind: 'phase', dataJson: '{"phase":"clone"}' },
  { kind: 'agent', dataJson: '{"type":"assistant","text":"héllo \\u2028 world"}' },
];

function addDrop(db: Db, id: string, finishedAt: string | null, state = 'succeeded', z = 'jm') {
  addTranscriptDrop(db, {
    id,
    zone: z,
    state,
    createdAt: '2026-08-01T00:00:00.000Z',
    finishedAt,
    events: EVENTS,
  });
}

const eventCount = (db: Db, id: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM drop_events WHERE drop_id = ?').get(id) as { c: number })
    .c;

const pass = (db: Db, dataDir: string, zones = [zone('jm')], extra: object = {}) =>
  prunePass(db, { dataDir, zones, now: NOW, log: () => {}, ...extra });

describe('prune selection', () => {
  for (const state of ['succeeded', 'failed', 'lost', 'cancelled'])
    test(`a finished ${state} drop older than retainDays is pruned`, async () => {
      const { db, dataDir } = world();
      addDrop(db, 'd1', ago(91 * DAY), state);
      const r = await pass(db, dataDir);
      expect(r.pruned).toEqual(['d1']);
      expect(eventCount(db, 'd1')).toBe(0);
      expect(transcriptPruned(db, 'd1')?.prunedAt).toBe(NOW.toISOString());
    });

  for (const state of ['queued', 'leased', 'running', 'push_pending'])
    test(`a ${state} drop is never pruned, however old`, async () => {
      const { db, dataDir } = world();
      addDrop(db, 'd1', ago(200 * DAY), state);
      const r = await pass(db, dataDir);
      expect(r.pruned).toEqual([]);
      expect(eventCount(db, 'd1')).toBe(2);
      expect(transcriptPruned(db, 'd1')).toBeNull();
      expect(countDueDrops(db, zone('jm'), NOW)).toBe(0);
    });

  test('exactly retainDays old is not yet due; one second older is', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'exact', ago(90 * DAY));
    addDrop(db, 'older', ago(90 * DAY + 1000));
    const r = await pass(db, dataDir);
    expect(r.pruned).toEqual(['older']);
    expect(eventCount(db, 'exact')).toBe(2);
  });

  test('retainDays: 0 keeps forever', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(5000 * DAY));
    const r = await pass(db, dataDir, [zone('jm', { retainDays: 0, archive: true })]);
    expect(r.pruned).toEqual([]);
    expect(eventCount(db, 'd1')).toBe(2);
    expect(countDueDrops(db, zone('jm', { retainDays: 0, archive: true }), NOW)).toBe(0);
  });

  test('a drop with no finished_at is never pruned', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', null);
    expect((await pass(db, dataDir)).pruned).toEqual([]);
  });

  test("each zone's own setting applies only to its drops", async () => {
    const { db, dataDir } = world();
    addDrop(db, 'a', ago(40 * DAY), 'succeeded', 'jm');
    addDrop(db, 'b', ago(40 * DAY), 'succeeded', 'other');
    const r = await pass(db, dataDir, [
      zone('jm'),
      zone('other', { retainDays: 30, archive: true }),
    ]);
    expect(r.pruned).toEqual(['b']);
  });

  test('a zone not in the config is left alone', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'b', ago(400 * DAY), 'succeeded', 'other');
    expect((await pass(db, dataDir)).pruned).toEqual([]);
  });

  test(`250 due: ${PRUNE_BATCH} this pass, the rest the next`, async () => {
    const { db, dataDir } = world();
    for (let i = 0; i < 250; i++) addDrop(db, `d${String(i).padStart(3, '0')}`, ago(100 * DAY));
    expect(countDueDrops(db, zone('jm'), NOW)).toBe(250);
    const first = await pass(db, dataDir, [zone('jm', { retainDays: 90, archive: false })]);
    expect(first.pruned).toHaveLength(200);
    expect(countDueDrops(db, zone('jm'), NOW)).toBe(50);
    const second = await pass(db, dataDir, [zone('jm', { retainDays: 90, archive: false })]);
    expect(second.pruned).toHaveLength(50);
  });
});

describe('archiving', () => {
  test('the archive is exactly the export from before pruning, gzipped, at zone/YYYY-MM/id', async () => {
    const { db, dataDir } = world();
    const finished = ago(91 * DAY); // 2026-08-17
    addDrop(db, 'd1', finished);
    const before = [...withNewlines(exportDropJsonl(db, 'd1'))].join('');
    await pass(db, dataDir);
    const rel = 'transcripts/jm/2026-08/d1.jsonl.gz';
    expect(transcriptPruned(db, 'd1')).toEqual({ prunedAt: NOW.toISOString(), archive: rel });
    expect(gunzipSync(readFileSync(join(dataDir, rel))).toString('utf8')).toBe(before);
    // No temp file is left beside it.
    expect(readdirSync(join(dataDir, 'transcripts/jm/2026-08'))).toEqual(['d1.jsonl.gz']);
  });

  test('archive files are 0600 and their directories 0700', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    await pass(db, dataDir);
    const mode = (p: string) => statSync(join(dataDir, p)).mode & 0o777;
    expect(mode('transcripts')).toBe(0o700);
    expect(mode('transcripts/jm')).toBe(0o700);
    expect(mode('transcripts/jm/2026-08')).toBe(0o700);
    expect(mode('transcripts/jm/2026-08/d1.jsonl.gz')).toBe(0o600);
  });

  test('archive off: events go, nothing is written, the drop records no archive', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    await pass(db, dataDir, [zone('jm', { retainDays: 90, archive: false })]);
    expect(eventCount(db, 'd1')).toBe(0);
    expect(transcriptPruned(db, 'd1')).toEqual({ prunedAt: NOW.toISOString(), archive: null });
    expect(existsSync(join(dataDir, 'transcripts'))).toBe(false);
  });

  test('the archive writer throws: events intact, no pruned mark, failure logged once and recorded', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    addDrop(db, 'd2', ago(92 * DAY));
    const logs: string[] = [];
    const r = await prunePass(db, {
      dataDir,
      zones: [zone('jm')],
      now: NOW,
      log: (m) => logs.push(m),
      write: async () => {
        throw new Error('disk full');
      },
    });
    expect(r.pruned).toEqual([]);
    expect(r.failed.map((f) => f.dropId).sort()).toEqual(['d1', 'd2']);
    for (const id of ['d1', 'd2']) {
      expect(eventCount(db, id)).toBe(2);
      expect(transcriptPruned(db, id)).toBeNull();
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('disk full');
    expect(lastArchiveFailure(db)).toMatchObject({ at: NOW.toISOString(), error: 'disk full' });
  });

  test('an archive directory that is not writable: nothing deleted, no file left', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    // A file where the transcripts directory should be: no write can succeed under it.
    mkdirSync(join(dataDir, 'x'));
    const blocked = join(dataDir, 'x', 'file');
    writeFileSync(blocked, '');
    const r = await pass(db, blocked);
    expect(r.failed).toHaveLength(1);
    expect(eventCount(db, 'd1')).toBe(2);
    expect(transcriptPruned(db, 'd1')).toBeNull();
  });

  test('two passes: one archive file, no error', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    const first = await pass(db, dataDir);
    const second = await pass(db, dataDir);
    expect(first.pruned).toEqual(['d1']);
    expect(second).toEqual({ pruned: [], failed: [] });
    expect(readdirSync(join(dataDir, 'transcripts/jm/2026-08'))).toEqual(['d1.jsonl.gz']);
    expect(transcriptPruned(db, 'd1')?.prunedAt).toBe(NOW.toISOString());
  });

  test('an archive left by an interrupted pass is replaced, not duplicated', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    mkdirSync(join(dataDir, 'transcripts/jm/2026-08'), { recursive: true });
    writeFileSync(join(dataDir, 'transcripts/jm/2026-08/d1.jsonl.gz'), 'stale');
    const before = [...withNewlines(exportDropJsonl(db, 'd1'))].join('');
    await pass(db, dataDir);
    const file = join(dataDir, 'transcripts/jm/2026-08/d1.jsonl.gz');
    expect(gunzipSync(readFileSync(file)).toString('utf8')).toBe(before);
    expect(readdirSync(join(dataDir, 'transcripts/jm/2026-08'))).toEqual(['d1.jsonl.gz']);
  });

  test('drop rows, result_json and artifacts survive pruning', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    db.prepare(
      "UPDATE drops SET result_json = '{\"ok\":true}', served_model = 'm' WHERE id = 'd1'",
    ).run();
    db.prepare(
      `INSERT INTO artifacts (drop_id, rule, name, sha256, media_type, bytes, created_at)
       VALUES ('d1', 'r', 'n', 'h', 'text/plain', 1, 't')`,
    ).run();
    await pass(db, dataDir);
    expect(
      db
        .prepare("SELECT state, result_json AS r, served_model AS m FROM drops WHERE id = 'd1'")
        .get(),
    ).toEqual({ state: 'succeeded', r: '{"ok":true}', m: 'm' });
    expect(db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE drop_id = 'd1'").get()).toEqual({
      c: 1,
    });
  });
});

describe('exports of a pruned drop', () => {
  test('the header gains prunedAt and archive, and no event lines follow', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    await pass(db, dataDir);
    const lines = [...exportDropJsonl(db, 'd1')].map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      dropId: 'd1',
      header: true,
      prunedAt: NOW.toISOString(),
      archive: 'transcripts/jm/2026-08/d1.jsonl.gz',
    });
  });

  test('the zone export gives a pruned drop its header alone', async () => {
    const { db, dataDir } = world();
    addDrop(db, 'd1', ago(91 * DAY));
    addDrop(db, 'd2', ago(10 * DAY));
    await pass(db, dataDir);
    const lines = [...exportDropsJsonl(db, ['d1', 'd2'])].map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.dropId, l.header === true, l.prunedAt ?? null])).toEqual([
      ['d1', true, NOW.toISOString()],
      ['d2', true, null],
      ['d2', false, null],
      ['d2', false, null],
    ]);
  });

  test('a drop that never had events has no prunedAt in its header', () => {
    const { db } = world();
    addTranscriptDrop(db, { id: 'd0', zone: 'jm', createdAt: 't', finishedAt: ago(DAY) });
    const [h] = [...exportDropJsonl(db, 'd0')].map((l) => JSON.parse(l));
    expect(h).not.toHaveProperty('prunedAt');
    expect(h).not.toHaveProperty('archive');
  });
});

describe('writeArchive', () => {
  test('a source that throws mid-way: the write rejects and leaves no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-arch-'));
    const lines = function* () {
      yield 'one';
      throw new Error('db gone');
    };
    await expect(writeArchive(join(dir, 'x.jsonl.gz'), lines())).rejects.toThrow('db gone');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('transcriptPruner', () => {
  test('runs at most once an hour', async () => {
    const { db, dataDir } = world();
    const zones = [zone('jm', { retainDays: 90, archive: false })];
    const run = transcriptPruner({ db, dataDir, zones: () => zones, log: () => {} });
    addDrop(db, 'a', ago(100 * DAY));
    await run(NOW);
    expect(eventCount(db, 'a')).toBe(0);
    addDrop(db, 'b', ago(100 * DAY));
    await run(new Date(NOW.getTime() + 59 * 60_000));
    expect(eventCount(db, 'b')).toBe(2);
    await run(new Date(NOW.getTime() + 60 * 60_000));
    expect(eventCount(db, 'b')).toBe(0);
  });
});

describe('archiveDirBytes', () => {
  test('sums the archive files; none is zero', async () => {
    const { db, dataDir } = world();
    expect(archiveDirBytes(dataDir)).toBe(0);
    addDrop(db, 'd1', ago(91 * DAY));
    await pass(db, dataDir);
    expect(archiveDirBytes(dataDir)).toBe(
      statSync(join(dataDir, 'transcripts/jm/2026-08/d1.jsonl.gz')).size,
    );
  });
});
