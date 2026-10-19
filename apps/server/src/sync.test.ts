import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import { listWorkItems, setWorkItemState, type WorkItem } from './db/repo.js';
import type { ForgeIssue } from './forge/github.js';
import { rankItems, syncDropZone } from './sync.js';
import { fakeForge } from './test/fakes.js';
import { t0, tmpDbFile } from './test/helpers.js';

const zone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 10,
};

const issue = (n: number, o: Partial<ForgeIssue> = {}): ForgeIssue => ({
  number: n,
  title: `issue ${n}`,
  body: 'b',
  author: 'alice',
  labels: ['agent-ready'],
  createdAt: t0.toISOString(),
  ...o,
});

const item = (id: number, o: Partial<WorkItem> = {}): WorkItem => ({
  id,
  dropZoneId: 'main',
  issueNumber: id,
  title: 't',
  body: 'b',
  author: 'alice',
  priority: 2,
  isFix: false,
  issueCreatedAt: t0.toISOString(),
  state: 'ready',
  reason: null,
  prNumber: null,
  ...o,
});

let db: Db;
beforeEach(() => {
  db = openDb(tmpDbFile());
});

describe('rankItems', () => {
  test('ranks by priority, then fix:, then age', () => {
    const low = item(1, { priority: 3 });
    const highFixNew = item(2, {
      priority: 1,
      isFix: true,
      issueCreatedAt: '2026-03-01T00:00:00Z',
    });
    const highOld = item(3, { priority: 1, issueCreatedAt: '2026-01-01T00:00:00Z' });
    const highNew = item(4, { priority: 1, issueCreatedAt: '2026-02-01T00:00:00Z' });
    expect(rankItems([low, highFixNew, highOld, highNew]).map((i) => i.id)).toEqual([2, 3, 4, 1]);
  });
});

describe('syncDropZone', () => {
  test('skips untrusted authors', async () => {
    const forge = fakeForge({
      issues: [issue(1), issue(2, { author: 'eve' })],
      trusted: ['alice'],
    });
    expect(await syncDropZone(db, forge, zone)).toEqual({ added: 1, skippedUntrusted: 1 });
    expect(listWorkItems(db, 'main').map((w) => w.issueNumber)).toEqual([1]);
  });

  test('derives priority and is_fix from labels and title', async () => {
    const forge = fakeForge({
      issues: [
        issue(1, { labels: ['agent-ready', 'Highest'] }),
        issue(2, { labels: ['high'] }),
        issue(3),
        issue(4, { labels: ['low'] }),
        issue(5, { labels: ['LOWEST'], title: 'Fix: crash' }),
      ],
      trusted: ['alice'],
    });
    await syncDropZone(db, forge, zone);
    const items = listWorkItems(db, 'main');
    expect(items.map((w) => w.priority)).toEqual([0, 1, 2, 3, 4]);
    expect(items.map((w) => w.isFix)).toEqual([false, false, false, false, true]);
  });

  test('stores the default branch', async () => {
    await syncDropZone(db, fakeForge({ issues: [], trusted: [], defaultBranch: 'trunk' }), zone);
    const row = db
      .prepare('SELECT default_branch AS b FROM drop_zones WHERE id = ?')
      .get('main') as { b: string };
    expect(row.b).toBe('trunk');
  });

  test('ready items no longer listed become done; other states are left alone', async () => {
    await syncDropZone(
      db,
      fakeForge({ issues: [issue(1), issue(2), issue(3)], trusted: ['alice'] }),
      zone,
    );
    const [a, b, c] = listWorkItems(db, 'main');
    setWorkItemState(db, b!.id, 'in_flight');
    setWorkItemState(db, c!.id, 'parked', 'why');
    const r = await syncDropZone(db, fakeForge({ issues: [], trusted: ['alice'] }), zone);
    expect(r).toEqual({ added: 0, skippedUntrusted: 0 });
    const after = listWorkItems(db, 'main');
    expect(after.find((w) => w.id === a!.id)).toMatchObject({
      state: 'done',
      reason: 'no longer ready',
    });
    expect(after.find((w) => w.id === b!.id)?.state).toBe('in_flight');
    expect(after.find((w) => w.id === c!.id)).toMatchObject({ state: 'parked', reason: 'why' });
  });

  test('re-sync does not double count existing items', async () => {
    const forge = fakeForge({ issues: [issue(1)], trusted: ['alice'] });
    expect((await syncDropZone(db, forge, zone)).added).toBe(1);
    expect((await syncDropZone(db, forge, zone)).added).toBe(0);
  });
});
