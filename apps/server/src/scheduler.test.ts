import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { type Db, openDb } from './db/open.js';
import { getDrop, listWorkItems, upsertDropZone, upsertWorkItem } from './db/repo.js';
import { enqueueNext } from './scheduler.js';
import { t0, tmpDbFile } from './test/helpers.js';
import { DEFAULT_USAGE_CONFIG } from './usage.js';

const zone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img:1',
  model: 'm',
  maxTurns: 10,
};

let db: Db;
const add = (n: number, priority: number) =>
  upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: n,
    title: 't',
    body: 'b',
    author: 'a',
    priority,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });

beforeEach(() => {
  db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
});

describe('enqueueNext', () => {
  test('one implement drop per zone at a time', () => {
    add(1, 2);
    add(2, 2);
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).not.toBeNull();
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
  });

  test('queues an implement drop for the top item and marks it in_flight', () => {
    add(1, 2);
    const top = add(2, 0);
    const id = enqueueNext(db, zone, 'v7', DEFAULT_USAGE_CONFIG, t0)!;
    expect(getDrop(db, id)).toMatchObject({
      state: 'queued',
      role: 'implement',
      workItemId: top.id,
      promptVersion: 'v7',
      image: 'img:1',
    });
    expect(listWorkItems(db, 'main', 'in_flight').map((w) => w.id)).toEqual([top.id]);
  });

  test('returns null when nothing is ready', () => {
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).toBeNull();
  });

  test('enqueues again once the previous drop is finished', () => {
    add(1, 2);
    add(2, 2);
    const id = enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)!;
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = ?").run(id);
    expect(enqueueNext(db, zone, 'v1', DEFAULT_USAGE_CONFIG, t0)).not.toBeNull();
  });
});
