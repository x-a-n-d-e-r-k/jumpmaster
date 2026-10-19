import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, openDb } from '../db/open.js';
import {
  insertDrop,
  insertStick,
  listWorkItems,
  setWorkItemState,
  upsertDropZone,
  upsertWorkItem,
  type WorkItem,
} from '../db/repo.js';

export const t0 = new Date('2026-01-01T00:00:00.000Z');

export const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

export const tmpDbFile = (): string => join(mkdtempSync(join(tmpdir(), 'jm-test-')), 'jm.sqlite');

/** Fresh DB with zone 'main', stick 's1', work item #1 (in_flight) and queued drop 'd1'. */
export function seedQueuedDrop(): Db {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  insertStick(db, { id: 's1', name: 'stick-1', tokenHash: 'h1', slots: 1 });
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 1,
    title: 't',
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  setWorkItemState(db, wi.id, 'in_flight');
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'main',
    workItemId: wi.id,
    role: 'implement',
    state: 'queued',
    createdAt: t0.toISOString(),
  });
  return db;
}

export function workItem(db: Db, id: number): WorkItem {
  const w = listWorkItems(db, 'main').find((x) => x.id === id);
  if (!w) throw new Error(`no work item ${id}`);
  return w;
}
