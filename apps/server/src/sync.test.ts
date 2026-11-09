import { beforeEach, describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import { flushCrewOps } from './crew/flush.js';
import { type CrewIssueState, getCrewIssue, insertCrewIssue, setCrewIssue } from './crew/store.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import {
  insertOutbox,
  listWorkItems,
  setWorkItemState,
  updateOutbox,
  type WorkItem,
} from './db/repo.js';
import type { ForgeIssue } from './forge/github.js';
import { getGoals } from './goals.js';
import { resolveUnknown } from './outbox.js';
import { rankItems, syncDropZone } from './sync.js';
import { fakeForge } from './test/fakes.js';
import { makeZone, zoneWorld } from './test/fixtures.js';
import { plus, t0, tmpDbFile } from './test/helpers.js';

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

  test('with the crew off, GOAL.md is still read whenever crew.goalPath is set', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), crewZone(false), t0);
    expect(getGoals(db, 'main')?.parse).toMatchObject({ ok: true });
  });

  test('a zone with no crew settings at all never reads a goal file', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), zone, t0);
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
  const world = (issues: ForgeIssue[], botLogins: string[] = [], crewEnabled = true) => {
    const w = zoneWorld({ botLogins, crew: { ...makeZone().crew, enabled: crewEnabled } });
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

  test('with the crew off, Bot-typed and configured bot authors are judged as before; markers still skip', async () => {
    const w = world(
      [
        crewIssue(13, { body: 'plain', author: 'some-app[bot]', authorType: 'Bot' }),
        crewIssue(14, { body: 'plain', author: 'helper' }),
        crewIssue(15, { author: 'human' }),
      ],
      ['helper'],
      false,
    );
    w.f.state.trusted.push('some-app[bot]', 'helper');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([13, 14]);
    expect(r.skippedCrewUnpromoted).toEqual([15]);
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

  /** A crew row for issue `n` in `state`. */
  const crewRow = (w: ReturnType<typeof zoneWorld>, n: number, state: CrewIssueState) =>
    insertCrewIssue(w.db, {
      zoneId: 'main',
      key: `k${n}`,
      source: 'crew-lead',
      sourceRef: 'd',
      objective: 'obj',
      title: `crew ${n}`,
      body: 'Do it.',
      priority: null,
      state,
      number: n,
      createdAt: t0.toISOString(),
    });

  test('an issue on a crew row is crew whatever its body, with the crew off', async () => {
    // The marker was edited out and the ready label added by hand; the crew was then disabled.
    const w = world([crewIssue(20, { body: 'Cleaned up.' })], [], false);
    crewRow(w, 20, 'staged');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([20]);
  });

  test('a ready issue that still carries the staged label is crew and not started', async () => {
    const both = ['agent-ready', 'agent-staged'];
    const w = world([
      crewIssue(21, { body: 'No marker, no row.', labels: both }),
      crewIssue(22, { body: 'Promoted row, staged label back.', labels: both }),
    ]);
    crewRow(w, 22, 'promoted');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([21, 22]);
  });

  test('a ready work item admitted for a crew issue not promoted is retired; it comes back once promoted', async () => {
    const w = world([crewIssue(23, { body: 'Cleaned up.' })]);
    const item = w.item(23, 'ready');
    const row = crewRow(w, 23, 'staged');
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(listWorkItems(w.db, 'main').map((i) => [i.id, i.state, i.reason])).toEqual([
      [item, 'done', 'crew issue not promoted'],
    ]);
    setCrewIssue(w.db, row, { state: 'promoted' }, t0);
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(listWorkItems(w.db, 'main').map((i) => [i.id, i.state])).toEqual([[item, 'ready']]);
  });

  test('a reopened rejected or failed crew issue stays unstartable and is listed', async () => {
    const w = world([
      crewIssue(24, { body: 'Reopened and cleaned.' }),
      crewIssue(25, { body: 'Cleaned.' }),
    ]);
    crewRow(w, 24, 'rejected');
    crewRow(w, 25, 'failed');
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([24, 25]);
  });

  /** A filing crew row whose create reached the forge but answered 5xx: op unknown, no number. */
  async function unresolvedFiling(w: ReturnType<typeof zoneWorld>): Promise<number> {
    const on = makeZone({ crew: { ...makeZone().crew, enabled: true } });
    const id = insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'k',
      source: 'crew-lead',
      sourceRef: 'd',
      objective: 'obj',
      title: 'Add docs',
      body: 'Do it.',
      priority: null,
      createdAt: t0.toISOString(),
    });
    w.f.author.failNext('createIssue', '5xx-after-success');
    await flushCrewOps(w.db, w.forges, on, [], t0);
    expect(getCrewIssue(w.db, id)).toMatchObject({ state: 'filing', number: null });
    return id;
  }

  test('before the create resolves, the row has no number and the staged label keeps the issue from starting', async () => {
    const w = world([]);
    const id = await unresolvedFiling(w);
    const [n, e] =
      [...w.f.state.issues.entries()].find(([, x]) => x.issue?.title === 'Add docs') ?? [];
    if (n === undefined || !e?.issue) throw new Error('issue not created');
    // The marker is edited out and ready added by hand; the staged label is still on.
    e.issue.body = 'Cleaned up.';
    e.labels = ['agent-staged', 'agent-ready'];
    e.issue.labels = [...e.labels];
    const off = makeZone({ crew: { ...makeZone().crew, enabled: false } });
    const r = await syncDropZone(w.db, w.forges, off, plus(t0, 1));
    expect(getCrewIssue(w.db, id)?.number).toBeNull();
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([n]);
  });

  test('once the create resolves the row has its number, and intake knows the issue by it alone', async () => {
    const w = world([]);
    const id = await unresolvedFiling(w);
    // The create resolves while the crew is disabled: the flush that would record it does not run.
    await resolveUnknown(w.db, w.forges, 'main', plus(t0, 1), 45);
    const n = getCrewIssue(w.db, id)?.number;
    expect(n).toEqual(expect.any(Number));
    // Someone edits the marker out, drops the staged label and labels it ready.
    const e = w.f.state.issues.get(n ?? -1);
    if (!e?.issue) throw new Error('issue not created');
    e.issue.body = 'Cleaned up.';
    e.labels = ['agent-ready'];
    e.issue.labels = ['agent-ready'];
    const off = makeZone({ crew: { ...makeZone().crew, enabled: false } });
    const r = await syncDropZone(w.db, w.forges, off, plus(t0, 2));
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([n]);
  });
});

describe('intake issues at sync', () => {
  const KEY = 'intake-0123456789ab';
  const OP = `issue:main:1:${KEY}`;
  const intakeIssue = (n: number): ForgeIssue => ({
    number: n,
    title: 'Add sum',
    body: `## Context\n\nx\n\n<!-- jm:op:${OP} -->`,
    author: 'author-bot',
    authorType: 'User',
    labels: ['agent-ready'],
    createdAt: t0.toISOString(),
  });
  const world = (crewEnabled: boolean) => {
    const w = zoneWorld({ crew: { ...makeZone().crew, enabled: crewEnabled } });
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    w.f.state.addIssue(intakeIssue(20));
    return w;
  };
  const row = (
    w: ReturnType<typeof zoneWorld>,
    o: Partial<{ state: CrewIssueState; number: number; source: string }>,
  ) =>
    insertCrewIssue(w.db, {
      zoneId: 'main',
      key: KEY,
      source: 'intake',
      objective: '1',
      title: 'Add sum',
      body: 'x',
      priority: null,
      createdAt: t0.toISOString(),
      ...o,
    });
  const numbers = (w: ReturnType<typeof zoneWorld>) =>
    listWorkItems(w.db, 'main').map((i) => i.issueNumber);
  /** The create came back unknown at the request; reconcile's read-back resolved it since. */
  const resolvedCreate = (w: ReturnType<typeof zoneWorld>) => {
    insertOutbox(w.db, {
      id: 'o1',
      opKey: OP,
      kind: 'create_issue',
      workItemId: null,
      zoneId: 'main',
      payloadJson: '{}',
      state: 'pending',
      createdAt: t0.toISOString(),
    });
    updateOutbox(w.db, OP, { state: 'done', resultJson: '{"number":20}' }, t0);
  };

  test('an intake issue starts with crew.enabled false', async () => {
    const w = world(false);
    row(w, { state: 'promoted', number: 20 });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([20]);
    expect(r.skippedCrewUnpromoted).toEqual([]);
  });

  test('an intake row whose create resolved after the request is confirmed at the next sync', async () => {
    const w = world(true);
    const id = row(w, { state: 'filing' });
    resolvedCreate(w);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(getCrewIssue(w.db, id)).toMatchObject({ state: 'promoted', number: 20 });
    expect(numbers(w)).toEqual([20]);
    expect(r.skippedCrewUnpromoted).toEqual([]);
  });

  test('an intake row whose create failed is marked failed at the next sync', async () => {
    const w = world(true);
    const id = row(w, { state: 'filing' });
    insertOutbox(w.db, {
      id: 'o1',
      opKey: OP,
      kind: 'create_issue',
      workItemId: null,
      zoneId: 'main',
      payloadJson: '{}',
      state: 'pending',
      createdAt: t0.toISOString(),
    });
    updateOutbox(w.db, OP, { state: 'failed', error: 'HTTP 422' }, t0);
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(getCrewIssue(w.db, id)?.state).toBe('failed');
  });

  test('a filing intake row with no outbox row is swept to failed after ten minutes, not before', async () => {
    const w = world(true);
    const id = row(w, { state: 'filing' });
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 9 * 60_000));
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 11 * 60_000));
    expect(getCrewIssue(w.db, id)?.state).toBe('failed');
  });

  test('an intake row is never filed as a staged crew issue by the crew flush', async () => {
    const w = world(true);
    const id = row(w, { state: 'filing' });
    await flushCrewOps(w.db, w.forges, w.zone, [], t0);
    expect(getCrewIssue(w.db, id)?.state).toBe('filing');
    expect(w.f.author.calls.filter((c) => c.method === 'createIssue')).toEqual([]);
  });

  test('an intake marker without an intake row is not started', async () => {
    const w = world(false);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([20]);
  });

  test('a crew-filed staged issue is still not started without a ruling', async () => {
    const w = world(true);
    // A crew row (not intake) with the same shape: only a ruling promotes it.
    row(w, { state: 'staged', number: 20, source: 'crew-lead' });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.skippedCrewUnpromoted).toEqual([20]);
    // A crew row stuck in filing is not confirmed as if it were intake.
    const w2 = world(true);
    const id = row(w2, { state: 'filing', source: 'mcp' });
    resolvedCreate(w2);
    await syncDropZone(w2.db, w2.forges, w2.zone, t0);
    expect(getCrewIssue(w2.db, id)?.state).toBe('filing');
    expect(numbers(w2)).toEqual([]);
  });
});
