import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { insertCrewIssue } from './crew/store.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import { listWorkItems, setWorkItemState, type WorkItem } from './db/repo.js';
import type { ForgeIssue } from './forge/github.js';
import { getGoals } from './goals.js';
import { rankItems, syncDropZone } from './sync.js';
import { fakeForge } from './test/fakes.js';
import { zoneWorld } from './test/fixtures.js';
import { t0, tmpDbFile } from './test/helpers.js';

const pair = <F>(f: F) => ({ author: f, reviewer: f });

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
  test('a failed author trust lookup skips that issue and keeps the pass', async () => {
    const w = zoneWorld();
    const real = w.f.author.isTrusted;
    w.f.author.isTrusted = async (login) => {
      if (login === 'human') throw new Error('fake 502');
      return real(login);
    };
    const r = await syncDropZone(w.db, w.forges, w.zone, new Date('2026-01-01T00:00:00Z'));
    expect(r.added).toBe(0);
    expect(r.skippedUntrusted).toBe(5);
  });

  test('skips untrusted authors', async () => {
    const forge = fakeForge({
      issues: [issue(1), issue(2, { author: 'eve' })],
      trusted: ['alice'],
    });
    expect(await syncDropZone(db, pair(forge), zone, t0)).toMatchObject({
      added: 1,
      skippedUntrusted: 1,
    });
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
    await syncDropZone(db, pair(forge), zone, t0);
    const items = listWorkItems(db, 'main');
    expect(items.map((w) => w.priority)).toEqual([0, 1, 2, 3, 4]);
    expect(items.map((w) => w.isFix)).toEqual([false, false, false, false, true]);
  });

  test('stores the default branch', async () => {
    await syncDropZone(
      db,
      pair(fakeForge({ issues: [], trusted: [], defaultBranch: 'trunk' })),
      zone,
      t0,
    );
    const row = db
      .prepare('SELECT default_branch AS b FROM drop_zones WHERE id = ?')
      .get('main') as { b: string };
    expect(row.b).toBe('trunk');
  });

  test('stores blockers and clears them when the blocker closes', async () => {
    const five = issue(5, { blockedBy: ['#4'] });
    const forge = pair(fakeForge({ issues: [five], trusted: ['alice'] }));
    await syncDropZone(db, forge, zone, t0);
    expect(listWorkItems(db, 'main')[0]?.blockedBy).toEqual(['#4']);
    five.blockedBy = [];
    await syncDropZone(db, forge, zone, t0);
    expect(listWorkItems(db, 'main')[0]).toMatchObject({ blockedBy: [], state: 'ready' });
  });

  test('ready items no longer listed become done; other states are left alone', async () => {
    await syncDropZone(
      db,
      pair(fakeForge({ issues: [issue(1), issue(2), issue(3)], trusted: ['alice'] })),
      zone,
      t0,
    );
    const [a, b, c] = listWorkItems(db, 'main');
    setWorkItemState(db, b!.id, 'in_flight');
    setWorkItemState(db, c!.id, 'parked', 'why');
    const r = await syncDropZone(db, pair(fakeForge({ issues: [], trusted: ['alice'] })), zone, t0);
    expect(r).toMatchObject({ added: 0, skippedUntrusted: 0 });
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
    expect((await syncDropZone(db, pair(forge), zone, t0)).added).toBe(1);
    expect((await syncDropZone(db, pair(forge), zone, t0)).added).toBe(0);
  });

  test('revives an item re-labelled ready', async () => {
    const forge = fakeForge({ issues: [issue(1)], trusted: ['alice'] });
    await syncDropZone(db, pair(forge), zone, t0);
    await syncDropZone(db, pair(fakeForge({ issues: [], trusted: ['alice'] })), zone, t0);
    expect(listWorkItems(db, 'main')[0]).toMatchObject({
      state: 'done',
      reason: 'no longer ready',
    });
    expect((await syncDropZone(db, pair(forge), zone, t0)).added).toBe(1);
    expect(listWorkItems(db, 'main')[0]).toMatchObject({ state: 'ready', reason: null });
  });
});

describe('GOAL.md refresh', () => {
  const crewZone = (enabled: boolean) =>
    ({
      ...zone,
      crew: { enabled, goalPath: 'GOAL.md' },
    }) as unknown as DropZoneConfig;

  test('a crew zone reads GOAL.md on the default branch after intake', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), crewZone(true), t0);
    expect(getGoals(db, 'main')?.parse).toMatchObject({ ok: true });
  });

  test('a zone without crew never reads GOAL.md', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), crewZone(false), t0);
    expect(getGoals(db, 'main')).toBeUndefined();
  });

  test('a thrown GOAL.md read never fails the sync', async () => {
    const forge = fakeForge({ issues: [issue(1)], trusted: ['alice'] });
    forge.getFileAt = async () => {
      throw new Error('fake 502');
    };
    await expect(syncDropZone(db, pair(forge), crewZone(true), t0)).resolves.toMatchObject({
      added: 1,
    });
  });
});

describe('crew provenance at intake', () => {
  const MARK = '\n\n<!-- jm:op:issue:main:obj:k -->';
  const crewIssue = (n: number, o: Partial<ForgeIssue> = {}): ForgeIssue => ({
    number: n,
    title: `crew ${n}`,
    body: `Do it.${MARK}`,
    author: 'author-bot',
    authorType: 'User',
    labels: ['agent-ready'],
    createdAt: t0.toISOString(),
    ...o,
  });
  const world = (issues: ForgeIssue[], botLogins: string[] = []) => {
    const w = zoneWorld({ botLogins });
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    for (const i of issues) w.f.state.addIssue(i);
    return w;
  };
  const numbers = (w: ReturnType<typeof zoneWorld>) =>
    listWorkItems(w.db, 'main').map((i) => i.issueNumber);
  const promoted = (w: ReturnType<typeof zoneWorld>, n: number) =>
    insertCrewIssue(w.db, {
      zoneId: 'main',
      key: `k${n}`,
      source: 'crew-lead',
      sourceRef: 'd',
      objective: 'obj',
      title: `crew ${n}`,
      body: 'Do it.',
      priority: null,
      state: 'promoted',
      number: n,
      createdAt: t0.toISOString(),
    });

  test('a marker-bearing issue labelled ready by a human without a recorded promotion is not started', async () => {
    const w = world([crewIssue(10)]);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([10]);
  });

  test('a marker forged into a stranger issue is skipped, not trusted', async () => {
    const w = world([crewIssue(11, { author: 'stranger' })]);
    w.f.state.trusted.push('stranger');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([11]);
  });

  test("the operator's own unmarked issue is still trusted", async () => {
    const w = world([crewIssue(12, { body: 'My own issue.' })]);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([12]);
    expect(r.skippedCrewUnpromoted).toEqual([]);
  });

  test('a Bot-typed or configured bot author without a promotion is skipped', async () => {
    const w = world(
      [
        crewIssue(13, { body: 'plain', author: 'some-app[bot]', authorType: 'Bot' }),
        crewIssue(14, { body: 'plain', author: 'helper' }),
      ],
      ['helper'],
    );
    w.f.state.trusted.push('some-app[bot]', 'helper');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([13, 14]);
  });

  test('a promoted crew issue becomes a work item', async () => {
    const w = world([crewIssue(15)]);
    promoted(w, 15);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([15]);
    expect(r.skippedCrewUnpromoted).toEqual([]);
  });

  test('lookup failure skips the pass', async () => {
    const w = world([crewIssue(16), crewIssue(17, { body: 'human', author: 'human' })]);
    w.item(3, 'ready');
    w.db.exec('DROP TABLE crew_issues');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(r.intakeSkipped).toMatch(/crew_issues/);
    expect(r.added).toBe(0);
    // #3 is no longer ready on the forge, but a skipped pass marks nothing done.
    expect(listWorkItems(w.db, 'main').map((i) => [i.issueNumber, i.state])).toEqual([
      [3, 'ready'],
    ]);
  });

  test('after restoring an older database, an unknown promoted crew issue is skipped and listed', async () => {
    const w = world([crewIssue(18, { labels: ['agent-ready', 'high'] })]);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([18]);
  });
});
