import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { type Db, openDb } from './open.js';
import {
  appendEvents,
  getDrop,
  getStickByTokenHash,
  insertDrop,
  insertStick,
  listEvents,
  listWorkItems,
  type NewDrop,
  setWorkItemState,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from './repo.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'jm-db-')), 'jm.sqlite');

let db: Db;
let workItemId: number;

const drop = (id: string, over: Partial<NewDrop> = {}): NewDrop => ({
  id,
  dropZoneId: 'main',
  workItemId,
  role: 'implement',
  state: 'queued',
  image: 'img',
  promptVersion: 'v1',
  ...over,
});

beforeEach(() => {
  db = openDb(tmpFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  workItemId = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 't',
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: '2026-01-01T00:00:00Z',
  }).id;
});

describe('openDb', () => {
  test('is idempotent and enables WAL + foreign keys', () => {
    const f = tmpFile();
    const first = openDb(f);
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
    first.close();
    expect(() => openDb(f)).not.toThrow();
  });
});

describe('work items', () => {
  test('upsert keeps state and id, refreshes fields; list filters by state', () => {
    const again = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 7,
      title: 'new',
      body: 'b',
      author: 'a',
      priority: 2,
      isFix: true,
      issueCreatedAt: '2026-01-01T00:00:00Z',
    });
    expect(again.id).toBe(workItemId);
    expect(again).toMatchObject({
      title: 'new',
      priority: 2,
      isFix: true,
      state: 'ready',
      reason: null,
      prNumber: null,
    });
    setWorkItemState(db, workItemId, 'parked', 'gates failed');
    expect(listWorkItems(db, 'main', 'ready')).toEqual([]);
    expect(listWorkItems(db, 'main', 'parked')[0]).toMatchObject({
      state: 'parked',
      reason: 'gates failed',
    });
    expect(listWorkItems(db, 'main')).toHaveLength(1);
  });
});

describe('drops', () => {
  test('allows only one active drop per work item', () => {
    insertDrop(db, drop('d1'));
    expect(() => insertDrop(db, drop('d2'))).toThrow(/UNIQUE/);
    updateDrop(db, 'd1', { state: 'succeeded', resultJson: '{}', finishedAt: 'x' });
    expect(() => insertDrop(db, drop('d2'))).not.toThrow();
  });

  test('get and update round-trip', () => {
    insertDrop(db, drop('d1'));
    expect(getDrop(db, 'd1')).toMatchObject({ id: 'd1', state: 'queued', epoch: 0, stickId: null });
    updateDrop(db, 'd1', { state: 'leased', epoch: 1, leaseExpiresAt: 'later' });
    expect(getDrop(db, 'd1')).toMatchObject({ state: 'leased', epoch: 1, leaseExpiresAt: 'later' });
    expect(getDrop(db, 'nope')).toBeUndefined();
  });
});

describe('events', () => {
  test('appendEvents continues seq and listEvents returns in order', () => {
    insertDrop(db, drop('d1'));
    appendEvents(db, 'd1', [{ ts: '1', kind: 'log', data: { m: 'a' } }]);
    appendEvents(db, 'd1', [
      { ts: '2', kind: 'phase', data: { n: 1 } },
      { ts: '3', kind: 'gate', data: {} },
    ]);
    const evs = listEvents(db, 'd1');
    expect(evs.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(evs[1]).toEqual({ seq: 2, ts: '2', kind: 'phase', data: { n: 1 } });
  });
});

describe('sticks', () => {
  test('insert and look up by token hash', () => {
    insertStick(db, { id: 's1', name: 'box', tokenHash: 'h', slots: 2 });
    expect(getStickByTokenHash(db, 'h')).toMatchObject({ id: 's1', name: 'box', slots: 2 });
    expect(getStickByTokenHash(db, 'zz')).toBeUndefined();
  });
});
