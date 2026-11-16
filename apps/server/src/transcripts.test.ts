import { describe, expect, test } from 'vitest';
import { openDb } from './db/open.js';
import { insertStick, upsertDropZone } from './db/repo.js';
import { tmpDbFile } from './test/helpers.js';
import { addTranscriptDrop } from './test/transcriptWorld.js';
import { exportDropJsonl, exportWindow, zoneDropIds } from './transcripts.js';

function world() {
  const db = openDb(tmpDbFile());
  for (const id of ['main', 'other'])
    upsertDropZone(db, { id, repo: `o/${id}`, defaultBranch: 'main', configJson: '{}' });
  insertStick(db, { id: 's1', name: 'kidney-shadow', tokenHash: 'h1', slots: 1 });
  return db;
}

describe('exportDropJsonl', () => {
  test('the header line, then every event in seq order', () => {
    const db = world();
    addTranscriptDrop(db, {
      id: 'd1',
      zone: 'main',
      createdAt: '2026-11-01T00:00:00.000Z',
      finishedAt: '2026-11-01T01:00:00.000Z',
      stickId: 's1',
      requestedModel: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      events: [
        { kind: 'phase', dataJson: '{"phase":"clone"}', ts: '2026-11-01T00:00:01.000Z' },
        { kind: 'agent', dataJson: '{"type":"assistant"}', ts: '2026-11-01T00:00:02.000Z' },
      ],
    });
    // Out-of-order inserts still come out by seq.
    db.prepare(
      "INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES ('d1', 4, 't4', 'log', '{\"n\":4}'), ('d1', 3, 't3', 'gate', '{\"n\":3}')",
    ).run();
    const lines = [...exportDropJsonl(db, 'd1')];
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        dropId: 'd1',
        zone: 'main',
        role: 'doctor',
        state: 'succeeded',
        createdAt: '2026-11-01T00:00:00.000Z',
        finishedAt: '2026-11-01T01:00:00.000Z',
        stick: 'kidney-shadow',
        requestedModel: 'claude-opus-5-5',
        servedModel: 'claude-opus-5-5',
        header: true,
      },
      {
        dropId: 'd1',
        zone: 'main',
        role: 'doctor',
        seq: 1,
        ts: '2026-11-01T00:00:01.000Z',
        kind: 'phase',
        data: { phase: 'clone' },
      },
      {
        dropId: 'd1',
        zone: 'main',
        role: 'doctor',
        seq: 2,
        ts: '2026-11-01T00:00:02.000Z',
        kind: 'agent',
        data: { type: 'assistant' },
      },
      {
        dropId: 'd1',
        zone: 'main',
        role: 'doctor',
        seq: 3,
        ts: 't3',
        kind: 'gate',
        data: { n: 3 },
      },
      { dropId: 'd1', zone: 'main', role: 'doctor', seq: 4, ts: 't4', kind: 'log', data: { n: 4 } },
    ]);
    for (const l of lines) expect(l).not.toContain('\n');
  });

  test('a drop with no stick and no events is its header alone, stick null', () => {
    const db = world();
    addTranscriptDrop(db, { id: 'd1', zone: 'main', createdAt: '2026-11-01T00:00:00.000Z' });
    const lines = [...exportDropJsonl(db, 'd1')];
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      stick: null,
      finishedAt: null,
      requestedModel: null,
      header: true,
    });
  });

  test('an unknown drop yields nothing', () => {
    expect([...exportDropJsonl(world(), 'nope')]).toEqual([]);
  });

  test('data is byte-identical to the stored data_json: spacing and unicode kept', () => {
    const db = world();
    const odd = '{ "text" :  "héllo ✓ \\u00e9 😀",\t"n":1.50 , "e":[ ] }';
    addTranscriptDrop(db, {
      id: 'd1',
      zone: 'main',
      createdAt: '2026-11-01T00:00:00.000Z',
      events: [{ kind: 'agent', dataJson: odd }],
    });
    const line = [...exportDropJsonl(db, 'd1')][1] as string;
    expect(line.endsWith(`,"data":${odd}}`)).toBe(true);
    expect(JSON.parse(line).data).toEqual(JSON.parse(odd));
  });

  test('a raw newline in stored JSON (whitespace) becomes a space: one event, one line', () => {
    const db = world();
    addTranscriptDrop(db, {
      id: 'd1',
      zone: 'main',
      createdAt: '2026-11-01T00:00:00.000Z',
      events: [{ kind: 'log', dataJson: '{\n  "a": "b\\n"\r\n}' }],
    });
    const lines = [...exportDropJsonl(db, 'd1')];
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith(',"data":{   "a": "b\\n" }}')).toBe(true);
    expect(JSON.parse(lines[1] as string).data).toEqual({ a: 'b\n' });
  });

  test('a drop with more events than one page comes out whole and in order', () => {
    const db = world();
    addTranscriptDrop(db, {
      id: 'd1',
      zone: 'main',
      createdAt: '2026-11-01T00:00:00.000Z',
      events: Array.from({ length: 1234 }, (_, i) => ({ kind: 'log', dataJson: `{"i":${i}}` })),
    });
    const seqs = [...exportDropJsonl(db, 'd1')].slice(1).map((l) => JSON.parse(l).seq);
    expect(seqs).toEqual(Array.from({ length: 1234 }, (_, i) => i + 1));
  });
});

describe('zoneDropIds', () => {
  test("only the zone's drops created in [since, until), oldest first", () => {
    const db = world();
    const at = (id: string, zone: string, createdAt: string) =>
      addTranscriptDrop(db, { id, zone, createdAt });
    at('late', 'main', '2026-11-10T00:00:00.000Z');
    at('since', 'main', '2026-11-01T00:00:00.000Z');
    at('before', 'main', '2026-10-31T23:59:59.999Z');
    at('until', 'main', '2026-11-15T00:00:00.000Z');
    at('other', 'other', '2026-11-05T00:00:00.000Z');
    at('mid', 'main', '2026-11-05T00:00:00.000Z');
    expect(zoneDropIds(db, 'main', '2026-11-01T00:00:00.000Z', '2026-11-15T00:00:00.000Z')).toEqual(
      ['since', 'mid', 'late'],
    );
  });
});

describe('exportWindow', () => {
  const now = new Date('2026-11-16T12:00:00.000Z');
  test('since required, until defaults to now, at most 92 days', () => {
    expect(exportWindow({ since: '2026-11-01' }, now)).toEqual({
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-16T12:00:00.000Z',
    });
    expect(exportWindow({ since: '2026-01-01', until: '2026-04-03' }, now)).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-04-03T00:00:00.000Z',
    });
    expect(exportWindow({ since: '2026-01-01', until: '2026-04-04' }, now)).toEqual({
      error: 'the window is at most 92 days',
    });
    expect(exportWindow({ since: '2026-01-01', until: '2026-12-31' }, now)).toEqual({
      error: 'the window is at most 92 days',
    });
    expect(exportWindow({ since: '2026-11-01T10:00:00+02:00' }, now)).toMatchObject({
      since: '2026-11-01T08:00:00.000Z',
    });
    for (const q of [
      {},
      { since: '' },
      { since: 'yesterday' },
      { since: '2026-02-30' },
      { since: '2026-11-01T00:00:00' },
      { since: ['2026-11-01'] },
      { since: '2026-11-01', until: 'x' },
      { since: '2026-11-10', until: '2026-11-10' },
      { since: '2026-11-10', until: '2026-11-01' },
    ])
      expect(exportWindow(q, now), JSON.stringify(q)).toHaveProperty('error');
  });
});
