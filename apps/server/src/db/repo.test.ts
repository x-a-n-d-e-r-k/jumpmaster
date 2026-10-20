import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { type Db, openDb } from './open.js';
import {
  activeDropFor,
  appendEvents,
  deleteFailedOutbox,
  getAttempts,
  getDrop,
  getOutbox,
  getPullRequest,
  getStickByTokenHash,
  getUsageState,
  getWorkItem,
  insertDrop,
  insertOutbox,
  insertStick,
  insertVerdict,
  latestVerdict,
  listEvents,
  listOutbox,
  listWorkItems,
  type NewDrop,
  resetAttempts,
  setAttempts,
  setRetryLabelSeen,
  setUsageState,
  setWaitingSince,
  setWorkItemState,
  updateDrop,
  updateOutbox,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
  type VerdictRow,
  verdictsForHead,
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

describe('M1 repo', () => {
  const t0 = new Date('2026-02-01T00:00:00.000Z');
  const MIN = 60_000;
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
  const verdict = (id: string, over: Partial<VerdictRow> = {}): VerdictRow => ({
    id,
    workItemId,
    headSha: 'sha1',
    decision: 'approve',
    forced: false,
    summary: 's',
    findingsJson: '[]',
    gatesJson: '[]',
    createdAt: t0.toISOString(),
    ...over,
  });
  const seedOutbox = (
    opKey: string,
    kind: 'create_pr' | 'post_review' | 'merge',
    state = 'failed',
  ) =>
    insertOutbox(db, {
      id: `o-${opKey}`,
      opKey,
      kind,
      workItemId,
      payloadJson: '{}',
      state: state as 'failed',
      createdAt: t0.toISOString(),
    });

  test('upsertPullRequest resets headFirstSeenAt only when the head changes', () => {
    const row = { workItemId, number: 5, headRef: 'agent/issue-1', state: 'open' as const };
    upsertPullRequest(db, { ...row, headSha: 'sha1' }, t0);
    upsertPullRequest(db, { ...row, headSha: 'sha1' }, plus(t0, MIN));
    expect(getPullRequest(db, workItemId)?.headFirstSeenAt).toBe(t0.toISOString());
    upsertPullRequest(db, { ...row, headSha: 'sha2' }, plus(t0, 2 * MIN));
    expect(getPullRequest(db, workItemId)).toMatchObject({
      headSha: 'sha2',
      headFirstSeenAt: plus(t0, 2 * MIN).toISOString(),
      observedAt: plus(t0, 2 * MIN).toISOString(),
    });
  });

  test('upsertPullRequest mirrors work_items.pr_number', () => {
    upsertPullRequest(db, { workItemId, number: 9, headRef: 'b', headSha: 's', state: 'open' }, t0);
    expect(getWorkItem(db, workItemId)?.prNumber).toBe(9);
  });

  test('insertVerdict is idempotent per id', () => {
    expect(insertVerdict(db, verdict('v1'))).toBe(true);
    expect(insertVerdict(db, verdict('v1'))).toBe(false);
  });

  test('latestVerdict returns the newest; verdictsForHead is oldest first', () => {
    insertVerdict(db, verdict('v1', { decision: 'request_changes', forced: true }));
    insertVerdict(db, verdict('v2', { createdAt: plus(t0, MIN).toISOString() }));
    insertVerdict(db, verdict('v3', { headSha: 'sha2', createdAt: plus(t0, MIN).toISOString() }));
    expect(latestVerdict(db, workItemId)?.id).toBe('v3');
    expect(verdictsForHead(db, workItemId, 'sha1').map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(verdictsForHead(db, workItemId, 'sha1')[0]?.forced).toBe(true);
    expect(latestVerdict(db, 999)).toBeUndefined();
  });

  test('attempts count and reset', () => {
    expect(getAttempts(db, workItemId, 'heal')).toEqual({ count: 0, lastFingerprint: null });
    setAttempts(db, workItemId, 'heal', 2, 'fp');
    setAttempts(db, workItemId, 'resume', 1, null);
    expect(getAttempts(db, workItemId, 'heal')).toEqual({ count: 2, lastFingerprint: 'fp' });
    resetAttempts(db, workItemId);
    expect(getAttempts(db, workItemId, 'heal').count).toBe(0);
    expect(getAttempts(db, workItemId, 'resume').count).toBe(0);
  });

  test('insertDrop and setWorkItemState use the given now', () => {
    insertDrop(db, drop('d-now'), t0);
    setWorkItemState(db, workItemId, 'in_flight', undefined, t0);
    expect(getDrop(db, 'd-now')?.createdAt).toBe(t0.toISOString());
    expect(
      db.prepare('SELECT updated_at AS u FROM work_items WHERE id = ?').get(workItemId),
    ).toEqual({
      u: t0.toISOString(),
    });
  });

  test('insertDrop round-trips fingerprint, prNumber, headSha, inputJson, chargedKey', () => {
    insertDrop(
      db,
      drop('d-x', {
        fingerprint: 'fp',
        prNumber: 4,
        headSha: 'h',
        inputJson: '{"a":1}',
        chargedKey: 'resolve,resolve_total',
      }),
      t0,
    );
    expect(getDrop(db, 'd-x')).toMatchObject({
      fingerprint: 'fp',
      prNumber: 4,
      headSha: 'h',
      inputJson: '{"a":1}',
      chargedKey: 'resolve,resolve_total',
    });
    insertDrop(db, drop('d-null', { state: 'succeeded' }), t0);
    expect(getDrop(db, 'd-null')).toMatchObject({ fingerprint: null, chargedKey: null });
    updateDrop(db, 'd-x', { chargedKey: 'resolve_total', headSha: 'h2' });
    expect(getDrop(db, 'd-x')).toMatchObject({ chargedKey: 'resolve_total', headSha: 'h2' });
  });

  test('activeDropFor returns the active drop only', () => {
    expect(activeDropFor(db, workItemId)).toBeUndefined();
    insertDrop(db, drop('d1'), t0);
    expect(activeDropFor(db, workItemId)?.id).toBe('d1');
    updateDrop(db, 'd1', { state: 'succeeded' });
    expect(activeDropFor(db, workItemId)).toBeUndefined();
  });

  test('setRetryLabelSeen and setWaitingSince round-trip', () => {
    expect(getWorkItem(db, workItemId)).toMatchObject({
      retryLabelSeen: false,
      waitingSince: null,
    });
    setRetryLabelSeen(db, workItemId, true);
    setWaitingSince(db, workItemId, t0.toISOString());
    expect(getWorkItem(db, workItemId)).toMatchObject({
      retryLabelSeen: true,
      waitingSince: t0.toISOString(),
    });
    setRetryLabelSeen(db, workItemId, false);
    setWaitingSince(db, workItemId, null);
    expect(getWorkItem(db, workItemId)).toMatchObject({
      retryLabelSeen: false,
      waitingSince: null,
    });
    expect(getWorkItem(db, 999)).toBeUndefined();
  });

  test('outbox insert is idempotent; update and list', () => {
    expect(seedOutbox('k1', 'create_pr', 'pending')).toBe(true);
    expect(seedOutbox('k1', 'create_pr', 'pending')).toBe(false);
    updateOutbox(db, 'k1', { state: 'done', resultJson: '{"n":1}' }, plus(t0, MIN));
    expect(getOutbox(db, 'k1')).toMatchObject({
      state: 'done',
      resultJson: '{"n":1}',
      error: null,
      updatedAt: plus(t0, MIN).toISOString(),
    });
    expect(listOutbox(db, ['done'], 'main')).toHaveLength(1);
    expect(listOutbox(db, ['done'], 'other')).toHaveLength(0);
    expect(listOutbox(db, ['pending'])).toHaveLength(0);
    expect(listOutbox(db, [])).toHaveLength(0);
  });

  test('deleteFailedOutbox can limit to one kind', () => {
    seedOutbox('k1', 'create_pr');
    seedOutbox('k2', 'merge');
    expect(deleteFailedOutbox(db, workItemId, 'create_pr')).toBe(1);
    expect(listOutbox(db, ['failed'])).toHaveLength(1);
    expect(deleteFailedOutbox(db, workItemId)).toBe(1);
    expect(listOutbox(db, ['failed'])).toHaveLength(0);
  });

  test('usage state patches merge onto the seeded row', () => {
    setUsageState(
      db,
      { status: 'rejected', pauseConfirmed: true, causeWorkItemId: workItemId },
      t0,
    );
    setUsageState(db, { fiveHourUtil: 0.5, probeDropId: null }, plus(t0, MIN));
    expect(getUsageState(db)).toMatchObject({
      status: 'rejected',
      pauseConfirmed: true,
      causeWorkItemId: workItemId,
      fiveHourUtil: 0.5,
      updatedAt: plus(t0, MIN).toISOString(),
    });
  });
});
