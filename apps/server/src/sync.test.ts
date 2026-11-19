import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { loadBoot } from './config/boot.js';
import { ConfigStore } from './config/store.js';
import type { DropZoneConfig } from './config.js';
import { flushCrewOps } from './crew/flush.js';
import { triageInput } from './crew/inputs.js';
import {
  type CrewIssueState,
  getCrewIssue,
  insertCrewIssue,
  listTriageRequests,
  setCrewIssue,
  setTriageRequest,
} from './crew/store.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import {
  insertOutbox,
  listOutbox,
  listWorkItems,
  setWorkItemState,
  setZoneMode,
  updateOutbox,
  type WorkItem,
} from './db/repo.js';
import type { ForgeIssue } from './forge/github.js';
import { getGoals } from './goals.js';
import { resolveUnknown } from './outbox.js';
import { rankItems, syncDropZone } from './sync.js';
import { fakeForge, fakeForgePair } from './test/fakes.js';
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

/** A body in the agent-ready format, so the triage gate (crew on) admits it. */
const FORMATTED = '## Acceptance criteria\n\n- [ ] it works\n\n## Required tests\n\n- a test\n';

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
  /** A zone as the config loads it: crew settings defaulted, GOAL.md protected. */
  const realZone = (enabled: boolean) => makeZone({ crew: { ...makeZone().crew, enabled } });

  test('a crew zone reads GOAL.md on the default branch after intake', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), realZone(true), t0);
    expect(getGoals(db, 'main')?.parse).toMatchObject({ ok: true });
  });

  test('with the crew off (the default), GOAL.md is still read every pass', async () => {
    const forge = fakeForge({ issues: [], trusted: [] });
    forge.state.files.set('main:GOAL.md', '## Objectives\n### One\n');
    await syncDropZone(db, pair(forge), realZone(false), t0);
    expect(getGoals(db, 'main')?.parse).toMatchObject({ ok: true });
  });

  test('a zone without a GOAL.md records it as not found, and nothing acts on it', async () => {
    const forge = fakeForge({ issues: [issue(1)], trusted: ['alice'] });
    const r = await syncDropZone(db, pair(forge), realZone(false), t0);
    expect(getGoals(db, 'main')?.parse).toEqual({ ok: false, error: 'GOAL.md not found' });
    expect(r.added).toBe(1);
  });

  test('a thrown GOAL.md read never fails the sync', async () => {
    const forge = fakeForge({ issues: [issue(1, { body: FORMATTED })], trusted: ['alice'] });
    forge.getFileAt = async () => {
      throw new Error('fake 502');
    };
    await expect(syncDropZone(db, pair(forge), realZone(true), t0)).resolves.toMatchObject({
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
    const w = world([crewIssue(12, { body: `My own issue.\n\n${FORMATTED}` })]);
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

describe('triage gate at intake (#183)', () => {
  /**
   * #179's shape, reconstructed (the forge was not reachable when this was written): two
   * complaints and a screenshot, no acceptance criteria and no tests.
   */
  const ISSUE_179 = {
    title: 'Zone page: the drop list is confusing and the log viewer is broken',
    body: [
      'The drop list on the zone page shows finished drops above running ones, so I never know what is running right now.',
      '',
      'Also the log viewer cuts off long lines and you cannot scroll sideways to read them.',
      '',
      '![screenshot](https://github.com/user-attachments/assets/179-zone-page.png)',
    ].join('\n'),
  };
  /** The same body with the two sections the agent-ready format asks for. */
  const SHAPED_179 = `${ISSUE_179.body}

## Acceptance criteria

- [ ] Running drops are listed above finished ones on the zone page.
- [ ] The log viewer scrolls sideways instead of cutting long lines.

## Required tests

- A zone page test with a running and a finished drop pins the order.
`;

  const crewOn = (o: Partial<DropZoneConfig> = {}) =>
    zoneWorld({ crew: { ...makeZone().crew, enabled: true }, ...o });
  /** A world whose only open ready issue is #179 by `author`. */
  const world179 = (o: { body?: string; author?: string; zone?: Partial<DropZoneConfig> } = {}) => {
    const w = crewOn(o.zone);
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    w.f.state.addIssue({
      number: 179,
      title: ISSUE_179.title,
      body: o.body ?? ISSUE_179.body,
      author: o.author ?? 'human',
      labels: ['agent-ready'],
      createdAt: t0.toISOString(),
    });
    return w;
  };
  const numbers = (w: ReturnType<typeof zoneWorld>) =>
    listWorkItems(w.db, 'main').map((i) => i.issueNumber);
  const ops = (w: ReturnType<typeof zoneWorld>) =>
    listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main');
  const labelWrites = (w: ReturnType<typeof zoneWorld>) =>
    w.f.author.calls.filter((c) => c.method === 'setLabels');

  test('#179 by a trusted author is not admitted; one set_labels op sends it to triage', async () => {
    const w = world179();
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r).toMatchObject({ added: 0, sentToTriage: 1, skippedUntrusted: 0 });
    const all = ops(w);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: 'set_labels', state: 'done', workItemId: null });
    expect(JSON.parse(all[0]?.payloadJson ?? '{}')).toEqual({
      number: 179,
      add: ['jm-triage'],
      remove: ['agent-ready'],
    });
    expect(w.f.state.issues.get(179)?.labels).toEqual(['jm-triage']);
  });

  test('the same issue with the two sections added is admitted as today', async () => {
    const w = world179({ body: SHAPED_179 });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([179]);
    expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
  });

  test('D1: an untrusted author is skipped with no forge write', async () => {
    const w = world179({ author: 'stranger' });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r).toMatchObject({ skippedUntrusted: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
    expect(labelWrites(w)).toEqual([]);
  });

  test('D2: a failed trust lookup fails closed, with no forge write', async () => {
    const w = world179();
    w.f.author.isTrusted = async () => {
      throw new Error('fake 502');
    };
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r).toMatchObject({ skippedUntrusted: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
    expect(labelWrites(w)).toEqual([]);
  });

  test('D3: two syncs in a row enqueue one op, even with the ready label put back', async () => {
    const w = world179();
    await syncDropZone(w.db, w.forges, w.zone, t0);
    // Someone puts the ready label back on the unchanged issue.
    w.f.state.setLabels(179, ['agent-ready', 'jm-triage']);
    const r = await syncDropZone(w.db, w.forges, w.zone, plus(t0, 60_000));
    expect(r.sentToTriage).toBe(1);
    expect(numbers(w)).toEqual([]);
    expect(ops(w)).toHaveLength(1);
    expect(labelWrites(w)).toHaveLength(1);
  });

  test('D5: a crew-promoted issue is never gated, even with a failing body', async () => {
    const w = world179({ author: 'author-bot' });
    insertCrewIssue(w.db, {
      zoneId: 'main',
      key: 'k179',
      source: 'crew-lead',
      sourceRef: 'd',
      objective: 'obj',
      title: ISSUE_179.title,
      body: ISSUE_179.body,
      priority: null,
      state: 'promoted',
      number: 179,
      createdAt: t0.toISOString(),
    });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([179]);
    expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
  });

  test('triage.gate false admits a failing issue as today', async () => {
    const w = world179({ zone: { triage: { gate: false } } });
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([179]);
    expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
  });

  test('with the crew off and the gate on, a failing issue is admitted and no op is enqueued', async () => {
    const w = world179({ zone: { crew: { ...makeZone().crew, enabled: false } } });
    expect(w.zone.triage.gate).toBe(true);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([179]);
    expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
    expect(ops(w)).toEqual([]);
  });

  test('a ready item whose issue now fails goes to done / needs triage; an in-flight one is untouched', async () => {
    const w = world179({ body: SHAPED_179 });
    w.f.state.addIssue({
      number: 180,
      title: 'Another',
      body: SHAPED_179,
      author: 'human',
      labels: ['agent-ready'],
      createdAt: t0.toISOString(),
    });
    await syncDropZone(w.db, w.forges, w.zone, t0);
    const [ready, flying] = listWorkItems(w.db, 'main');
    setWorkItemState(w.db, flying!.id, 'in_flight');
    // Both bodies are edited down to fail the format.
    for (const n of [179, 180]) {
      const e = w.f.state.issues.get(n);
      if (e?.issue) e.issue.body = ISSUE_179.body;
    }
    const r = await syncDropZone(w.db, w.forges, w.zone, plus(t0, 60_000));
    expect(r.sentToTriage).toBe(1);
    const after = listWorkItems(w.db, 'main');
    expect(after.find((i) => i.id === ready!.id)).toMatchObject({
      state: 'done',
      reason: 'needs triage',
    });
    expect(after.find((i) => i.id === flying!.id)).toMatchObject({
      state: 'in_flight',
      body: SHAPED_179,
    });
    expect(ops(w).map((o) => JSON.parse(o.payloadJson).number)).toEqual([179]);
    // Shaped again and put back on ready, the retired item comes back.
    const e = w.f.state.issues.get(179);
    if (e?.issue) e.issue.body = SHAPED_179;
    w.f.state.setLabels(179, ['agent-ready']);
    const back = await syncDropZone(w.db, w.forges, w.zone, plus(t0, 120_000));
    expect(back.added).toBe(1);
    expect(listWorkItems(w.db, 'main').find((i) => i.id === ready!.id)?.state).toBe('ready');
  });

  describe('a spec-valid issue naming a protected path (#247)', () => {
    const NAMES_GOAL = SHAPED_179.replace(
      '## Required tests',
      'Also update `GOAL.md` with the new objective.\n\n## Required tests',
    );
    const PROTECTED = { protectedPaths: ['GOAL.md', 'examples/**', '.github/**'] };

    test('with the gate on it goes to triage with the reason, and no work item', async () => {
      const w = world179({ body: NAMES_GOAL, zone: PROTECTED });
      const r = await syncDropZone(w.db, w.forges, w.zone, t0);
      expect(numbers(w)).toEqual([]);
      expect(r).toMatchObject({ added: 0, sentToTriage: 1 });
      expect(w.f.state.issues.get(179)?.labels).toEqual(['jm-triage']);
      const [req] = listTriageRequests(w.db, 'main');
      expect(req).toMatchObject({
        issueNumber: 179,
        state: 'open',
        reason: null,
        gateReasons: ['protected path GOAL.md named in the issue'],
      });
      const input = triageInput(w.db, w.zone, req?.id ?? -1, 'drop-x');
      expect(input).toContain('Why this issue is in triage');
      expect(input).toContain('- protected path GOAL.md named in the issue');
    });

    test('the spec reasons come first when both apply', async () => {
      const w = world179({ body: `${ISSUE_179.body}\n\nEdit \`GOAL.md\`.`, zone: PROTECTED });
      await syncDropZone(w.db, w.forges, w.zone, t0);
      expect(listTriageRequests(w.db, 'main')[0]?.gateReasons).toEqual([
        'no "## Acceptance criteria" checklist',
        'no "## Tests" or "## Required tests" list',
        'protected path GOAL.md named in the issue',
      ]);
    });

    test('naming no protected path, it becomes a work item as today', async () => {
      const w = world179({ body: SHAPED_179, zone: PROTECTED });
      const r = await syncDropZone(w.db, w.forges, w.zone, t0);
      expect(numbers(w)).toEqual([179]);
      expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
    });

    test('with the gate off it becomes a work item', async () => {
      const w = world179({ body: NAMES_GOAL, zone: { ...PROTECTED, triage: { gate: false } } });
      const r = await syncDropZone(w.db, w.forges, w.zone, t0);
      expect(numbers(w)).toEqual([179]);
      expect(r).toMatchObject({ added: 1, sentToTriage: 0 });
      expect(ops(w)).toEqual([]);
    });

    test('an item already past ready is left alone', async () => {
      const w = world179({ body: SHAPED_179, zone: PROTECTED });
      await syncDropZone(w.db, w.forges, w.zone, t0);
      const [it] = listWorkItems(w.db, 'main');
      setWorkItemState(w.db, it!.id, 'in_flight');
      const e = w.f.state.issues.get(179);
      if (e?.issue) e.issue.body = NAMES_GOAL;
      const r = await syncDropZone(w.db, w.forges, w.zone, plus(t0, 60_000));
      expect(r.sentToTriage).toBe(0);
      expect(listWorkItems(w.db, 'main')[0]).toMatchObject({
        state: 'in_flight',
        body: SHAPED_179,
      });
      expect(ops(w)).toEqual([]);
    });
  });

  test('in observe mode the gate holds the issue back and the refused write fails nothing', async () => {
    const w = world179();
    setZoneMode(w.db, 'main', 'observe', t0);
    const r = await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(numbers(w)).toEqual([]);
    expect(r.sentToTriage).toBe(1);
    expect(ops(w)).toEqual([]);
  });
});

describe('triage requests at sync (#184)', () => {
  const BODY = 'The overage gauge shows when overage is off. Also Fable usage is missing.';
  /** A crew-on world whose only triage-labeled issue is #179 by `author`. */
  const world = (o: { author?: string; crew?: boolean } = {}) => {
    const w = zoneWorld({ crew: { ...makeZone().crew, enabled: o.crew ?? true } });
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    w.f.state.addIssue({
      number: 179,
      title: 'Usage page',
      body: BODY,
      author: o.author ?? 'human',
      labels: ['jm-triage'],
      createdAt: t0.toISOString(),
    });
    return w;
  };
  const rows = (w: ReturnType<typeof zoneWorld>) =>
    listTriageRequests(w.db, 'main').map((r) => ({
      n: r.issueNumber,
      state: r.state,
      reason: r.reason,
      body: r.body,
    }));

  test('a trusted author’s triage-labeled issue is recorded as an open request', async () => {
    const w = world();
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(rows(w)).toEqual([{ n: 179, state: 'open', reason: null, body: BODY }]);
    const [r] = listTriageRequests(w.db, 'main');
    expect(r).toMatchObject({ author: 'human', title: 'Usage page', attempts: 0, outcome: null });
  });

  test('D1: an untrusted author’s issue is never recorded', async () => {
    const w = world({ author: 'stranger' });
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(rows(w)).toEqual([]);
  });

  test('D2: a failed trust lookup counts as untrusted', async () => {
    const w = world();
    w.f.author.isTrusted = async () => {
      throw new Error('fake 502');
    };
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(rows(w)).toEqual([]);
  });

  test('D3: the same body synced twice records one request', async () => {
    const w = world();
    await syncDropZone(w.db, w.forges, w.zone, t0);
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 60_000));
    expect(rows(w)).toHaveLength(1);
  });

  test('an edited body supersedes the open request with a new open one', async () => {
    const w = world();
    await syncDropZone(w.db, w.forges, w.zone, t0);
    const e = w.f.state.issues.get(179);
    if (e?.issue) e.issue.body = `${BODY}\n\nEdited.`;
    await syncDropZone(w.db, w.forges, w.zone, plus(t0, 60_000));
    expect(rows(w)).toEqual([
      { n: 179, state: 'done', reason: 'superseded', body: BODY },
      { n: 179, state: 'open', reason: null, body: `${BODY}\n\nEdited.` },
    ]);
  });

  test('with the crew off nothing is recorded', async () => {
    const w = world({ crew: false });
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(rows(w)).toEqual([]);
  });
});

describe('backlog issues to crew triage (#467)', () => {
  const BODY = 'Make the zone page show the backlog count.';
  /** A crew-on world whose open issues are the given ones, all by `human` unless set. */
  const world = (
    issues: Array<Partial<ForgeIssue> & { number: number }>,
    crew: Partial<DropZoneConfig['crew']> = {},
  ) => {
    const w = zoneWorld({ crew: { ...makeZone().crew, enabled: true, ...crew } });
    for (const n of [1, 2, 3, 4, 5]) w.f.state.closeIssue(n);
    for (const i of issues)
      w.f.state.addIssue({ title: `Issue ${i.number}`, body: BODY, labels: [], ...i });
    return w;
  };
  const rows = (w: ReturnType<typeof zoneWorld>) =>
    listTriageRequests(w.db, 'main').map((r) => ({
      n: r.issueNumber,
      state: r.state,
      reason: r.reason,
    }));
  const sync = (w: ReturnType<typeof zoneWorld>, at = t0) =>
    syncDropZone(w.db, w.forges, w.zone, at);

  test('default on: an unlabeled trusted issue gets one open request with its title and body', async () => {
    const w = world([{ number: 178, title: 'Backlog count' }]);
    expect(w.zone.crew.triageBacklog).toBe(true);
    await sync(w);
    const reqs = listTriageRequests(w.db, 'main');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({
      issueNumber: 178,
      state: 'open',
      title: 'Backlog count',
      body: BODY,
      author: 'human',
      attempts: 0,
    });
  });

  describe('exclusions record nothing', () => {
    test.each<[string, Partial<ForgeIssue>]>([
      ['the ready label', { labels: ['agent-ready'], body: FORMATTED }],
      ['the staged label', { labels: ['agent-staged'] }],
      ['the triaged label', { labels: ['jm-triaged'] }],
      ['a Bot author', { author: 'helper', authorType: 'Bot' }],
      ['an Epic label', { labels: ['Epic'] }],
      ['an untrusted author', { author: 'stranger' }],
    ])('%s', async (_, o) => {
      const w = world([{ number: 178, ...o }]);
      w.f.state.trusted.push('helper');
      await sync(w);
      expect(rows(w)).toEqual([]);
    });

    test('a crew-filed body', async () => {
      const w = world([{ number: 178, body: `${BODY}\n\n<!-- jm:op:issue:main:k1 -->` }]);
      await sync(w);
      expect(rows(w)).toEqual([]);
    });

    test('a trust lookup that throws', async () => {
      const w = world([{ number: 178 }]);
      w.f.author.isTrusted = async () => {
        throw new Error('fake 502');
      };
      await sync(w);
      expect(rows(w)).toEqual([]);
    });
  });

  test('two passes over the same body record one request', async () => {
    const w = world([{ number: 178 }]);
    await sync(w);
    await sync(w, plus(t0, 60_000));
    expect(rows(w)).toEqual([{ n: 178, state: 'open', reason: null }]);
  });

  test('a changed body while open records a second request and supersedes the first', async () => {
    const w = world([{ number: 178 }]);
    await sync(w);
    const e = w.f.state.issues.get(178);
    if (e?.issue) e.issue.body = `${BODY}\n\nEdited.`;
    await sync(w, plus(t0, 60_000));
    expect(rows(w)).toEqual([
      { n: 178, state: 'done', reason: 'superseded' },
      { n: 178, state: 'open', reason: null },
    ]);
  });

  describe('pacing', () => {
    const five = () => world([14, 12, 10, 13, 11].map((number) => ({ number })));

    test('five backlog issues: the three lowest numbers after one pass, none more while open', async () => {
      const w = five();
      await sync(w);
      expect(rows(w).map((r) => r.n)).toEqual([10, 11, 12]);
      await sync(w, plus(t0, 60_000));
      expect(rows(w).map((r) => r.n)).toEqual([10, 11, 12]);
    });

    test('one more once one of them is done', async () => {
      const w = five();
      await sync(w);
      const [first] = listTriageRequests(w.db, 'main');
      setTriageRequest(w.db, first?.id ?? -1, { state: 'done', outcome: 'questions' }, t0);
      await sync(w, plus(t0, 60_000));
      expect(
        rows(w)
          .filter((r) => r.state === 'open')
          .map((r) => r.n),
      ).toEqual([11, 12, 13]);
    });

    test('a triage-labeled issue in the same pass is recorded on top of the three', async () => {
      const w = five();
      w.f.state.addIssue({ number: 20, body: BODY, labels: ['jm-triage'] });
      await sync(w);
      expect(rows(w).map((r) => r.n)).toEqual([20, 10, 11, 12]);
    });
  });

  describe('stale requests', () => {
    test('an issue labeled ready before its drop ran is superseded', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const e = w.f.state.issues.get(178);
      // Drop-ready, so intake takes it rather than sending it back to triage.
      if (e?.issue) e.issue.body = FORMATTED;
      w.f.state.setLabels(178, ['agent-ready']);
      await sync(w, plus(t0, 60_000));
      expect(rows(w)).toEqual([{ n: 178, state: 'done', reason: 'withdrawn' }]);
    });

    test('an issue closed before its drop ran is superseded', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      expect(rows(w)).toEqual([{ n: 178, state: 'done', reason: 'withdrawn' }]);
    });

    test('a request with attempts is not superseded', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const [r] = listTriageRequests(w.db, 'main');
      setTriageRequest(w.db, r?.id ?? -1, { attempts: 1 }, t0);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      expect(rows(w)).toEqual([{ n: 178, state: 'open', reason: null }]);
    });

    test('a triage-labeled request is not superseded', async () => {
      const w = world([{ number: 179, labels: ['jm-triage'] }]);
      await sync(w);
      await sync(w, plus(t0, 60_000));
      expect(rows(w)).toEqual([{ n: 179, state: 'open', reason: null }]);
    });

    const open = (w: ReturnType<typeof zoneWorld>) => rows(w).filter((r) => r.state === 'open');
    const forgeWrites = (w: ReturnType<typeof zoneWorld>) =>
      w.f.author.calls.filter((c) =>
        /^(create|update|add|remove|set|close|comment)/i.test(c.method),
      );

    test('a Jumpmaster label added then removed, same body: sent again', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      w.f.state.setLabels(178, ['jm-triaged']);
      await sync(w, plus(t0, 60_000));
      expect(open(w)).toEqual([]);
      w.f.state.setLabels(178, []);
      await sync(w, plus(t0, 120_000));
      expect(open(w)).toEqual([{ n: 178, state: 'open', reason: null }]);
      expect(rows(w)).toHaveLength(1);
    });

    test('closed then reopened, same body: one open request after the reopen', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      expect(open(w)).toEqual([]);
      w.f.state.reopenIssue(178);
      await sync(w, plus(t0, 120_000));
      expect(open(w)).toEqual([{ n: 178, state: 'open', reason: null }]);
    });

    test('a jm-triage label swapped for another Jumpmaster label for one pass, then restored', async () => {
      const w = world([{ number: 179, labels: ['jm-triage'] }]);
      await sync(w);
      w.f.state.setLabels(179, ['agent-staged']);
      await sync(w, plus(t0, 60_000));
      expect(open(w)).toEqual([]);
      w.f.state.setLabels(179, ['jm-triage']);
      await sync(w, plus(t0, 120_000));
      expect(open(w)).toEqual([{ n: 179, state: 'open', reason: null }]);
    });

    test('an issue that stays out of both listings has no open request and no forge write', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const before = forgeWrites(w).length;
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      await sync(w, plus(t0, 120_000));
      expect(open(w)).toEqual([]);
      expect(forgeWrites(w)).toHaveLength(before);
    });

    test('a returning withdrawn request still honours the pace of three', async () => {
      const w = world([10, 11, 12, 13].map((number) => ({ number })));
      await sync(w);
      w.f.state.closeIssue(10);
      await sync(w, plus(t0, 60_000));
      expect(open(w).map((r) => r.n)).toEqual([11, 12, 13]);
      w.f.state.reopenIssue(10);
      await sync(w, plus(t0, 120_000));
      expect(open(w).map((r) => r.n)).toEqual([11, 12, 13]);
    });

    test('a returning withdrawn request still honours the skip labels', async () => {
      const w = world([{ number: 178 }], { backlogSkipLabels: ['later'] });
      await sync(w);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      w.f.state.reopenIssue(178);
      w.f.state.setLabels(178, ['later']);
      await sync(w, plus(t0, 120_000));
      expect(open(w)).toEqual([]);
    });

    test('a request done with an outcome is not recorded again when its issue returns', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const [r] = listTriageRequests(w.db, 'main');
      setTriageRequest(
        w.db,
        r?.id ?? -1,
        { state: 'done', outcome: 'not-agent-work', reason: 'withdrawn' },
        t0,
      );
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      w.f.state.reopenIssue(178);
      await sync(w, plus(t0, 120_000));
      expect(rows(w)).toEqual([{ n: 178, state: 'done', reason: 'withdrawn' }]);
    });

    test.each<[string, Parameters<typeof setTriageRequest>[2]]>([
      ['failed', { state: 'failed', reason: 'failed', attempts: 3 }],
      ['waiting', { state: 'waiting', outcome: 'questions' }],
      ['verifying', { state: 'verifying', outcome: 'already-done' }],
      ['superseded after verifying', { state: 'done', outcome: null, reason: 'superseded' }],
    ])('a %s request is not recorded again in the backlog', async (_, patch) => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const [r] = listTriageRequests(w.db, 'main');
      setTriageRequest(w.db, r?.id ?? -1, patch, t0);
      const before = rows(w);
      await sync(w, plus(t0, 60_000));
      await sync(w, plus(t0, 120_000));
      expect(rows(w)).toEqual(before);
    });

    test('a request with attempts whose issue left the listings: unchanged, no duplicate', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const [r] = listTriageRequests(w.db, 'main');
      setTriageRequest(w.db, r?.id ?? -1, { attempts: 1 }, t0);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      w.f.state.reopenIssue(178);
      await sync(w, plus(t0, 120_000));
      expect(listTriageRequests(w.db, 'main')).toMatchObject([
        { issueNumber: 178, state: 'open', reason: null, attempts: 1 },
      ]);
    });

    test('a withdrawn request with attempts is never reopened', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      const [r] = listTriageRequests(w.db, 'main');
      setTriageRequest(w.db, r?.id ?? -1, { state: 'done', reason: 'withdrawn', attempts: 1 }, t0);
      await sync(w, plus(t0, 60_000));
      expect(rows(w)).toEqual([{ n: 178, state: 'done', reason: 'withdrawn' }]);
    });

    test('returning to an earlier withdrawn text supersedes the open request for the newer text', async () => {
      const w = world([{ number: 178 }]);
      await sync(w);
      w.f.state.closeIssue(178);
      await sync(w, plus(t0, 60_000));
      const e = w.f.state.issues.get(178);
      w.f.state.reopenIssue(178);
      if (e?.issue) e.issue.body = 'Another text.';
      await sync(w, plus(t0, 120_000));
      if (e?.issue) e.issue.body = BODY;
      await sync(w, plus(t0, 180_000));
      expect(rows(w)).toEqual([
        { n: 178, state: 'open', reason: null },
        { n: 178, state: 'done', reason: 'superseded' },
      ]);
    });
  });

  test('triageBacklog false: only the triage-labeled issue is recorded', async () => {
    const w = world([{ number: 178 }, { number: 179, labels: ['jm-triage'] }], {
      triageBacklog: false,
    });
    await sync(w);
    expect(rows(w).map((r) => r.n)).toEqual([179]);
  });

  test('crew disabled: nothing is recorded', async () => {
    const w = world([{ number: 178 }], { enabled: false });
    await sync(w);
    expect(rows(w)).toEqual([]);
  });

  test('a failed unfiltered listing records no backlog request; the labeled issue still is', async () => {
    const w = world([{ number: 178 }, { number: 179, labels: ['jm-triage'] }]);
    const real = w.f.author.listOpenIssues;
    w.f.author.listOpenIssues = async (label) => {
      if (label === undefined) throw new Error('fake 502');
      return real(label);
    };
    await expect(sync(w)).resolves.toBeDefined();
    expect(rows(w).map((r) => r.n)).toEqual([179]);
  });

  test('D5: the same text by either path records the same gate reasons', async () => {
    const body = 'Edit .github/workflows/ci.yml to cache deps.';
    const w = world([
      { number: 178, title: 'Cache deps', body },
      { number: 179, title: 'Cache deps', body, labels: ['jm-triage'] },
    ]);
    await sync(w);
    const reqs = listTriageRequests(w.db, 'main');
    expect(reqs.map((r) => r.issueNumber).sort()).toEqual([178, 179]);
    expect(reqs[0]?.gateReasons).not.toBeNull();
    expect(reqs[0]?.gateReasons).toEqual(reqs[1]?.gateReasons);
  });
});

describe('the ready label after the drop-ready upgrade (#198)', () => {
  const env: NodeJS.ProcessEnv = {
    JM_CLAUDE_TOKEN: 'claude-secret-value-1',
    JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
    JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: 'o'.repeat(32),
  };
  const open = () =>
    ConfigStore.open({
      db,
      boot: loadBoot(env, undefined),
      env,
      now: () => t0,
      imageLockPath: join(tmpdir(), 'jm-no-such-lock.json'),
    });

  test('a zone that ran on the old default is pinned and still admits its agent-ready issues', async () => {
    const before = open();
    const token = { kind: 'operator', via: 'token', sudo: true } as const;
    const added = before.apply(
      {
        dropZones: [
          { id: 'main', repo: 'octo/demo', gates: [{ name: 't', run: 'true' }], image: 'img' },
        ],
      },
      { via: 'ctl', principal: token },
    );
    expect(added.ok).toBe(true);
    // As an install before the upgrade left it: the pin has not run.
    db.prepare("DELETE FROM settings WHERE key = 'config.ready_label_pins'").run();
    const after = open().current().dropZones[0];
    if (!after) throw new Error('no zone');
    const forge = fakeForgePair({ issues: [issue(1)], trusted: ['alice'] });
    expect(issue(1).labels).toEqual(['agent-ready']);
    const r = await syncDropZone(db, { author: forge.author, reviewer: forge.reviewer }, after, t0);
    expect(r).toMatchObject({ added: 1 });
    expect(listWorkItems(db, 'main').map((w) => w.issueNumber)).toEqual([1]);
    // Unpinned, the new default would have missed it.
    const unpinned = { ...after, readyLabel: 'drop-ready' };
    expect(await forge.author.listReadyIssues(unpinned.readyLabel)).toEqual([]);
  });
});
