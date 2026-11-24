import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { type Db, openDb } from './open.js';
import {
  ACTIVE_DROP_STATES,
  activeDropFor,
  appendEvents,
  clearZoneStopping,
  deleteFailedOutbox,
  deleteZoneControls,
  ensureZoneMode,
  GRANT_HOLD_MS,
  getAttempts,
  getDrop,
  getOutbox,
  getPullRequest,
  getStickByTokenHash,
  getUsageState,
  getWorkItem,
  getZoneMode,
  insertDrop,
  insertOutbox,
  insertStick,
  insertVerdict,
  isKilled,
  latestVerdict,
  listEvents,
  listOutbox,
  listUsageWindows,
  listWorkItems,
  markMinted,
  markZoneStopping,
  type NewDrop,
  recordUsageWindows,
  removeStick,
  reserveGrant,
  resetAttempts,
  revokeGrants,
  setAttempts,
  setKilled,
  setRetryLabelSeen,
  setUsageState,
  setWaitingSince,
  setWorkItemState,
  setZoneMode,
  stampStick,
  stoppingZones,
  updateDrop,
  updateOutbox,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
  type VerdictRow,
  verdictsForHead,
  zoneDrained,
  zoneHasHistory,
  zoneHistoryRepo,
  zoneStopping,
  zoneWaits,
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
  test('blockedBy defaults to empty, is stored, and is refreshed on upsert', () => {
    expect(getWorkItem(db, workItemId)?.blockedBy).toEqual([]);
    const base = {
      dropZoneId: 'main',
      issueNumber: 7,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: '2026-01-01T00:00:00Z',
    };
    expect(upsertWorkItem(db, { ...base, blockedBy: ['#4', 'o/x#2'] }).blockedBy).toEqual([
      '#4',
      'o/x#2',
    ]);
    expect(listWorkItems(db, 'main')[0]?.blockedBy).toEqual(['#4', 'o/x#2']);
    expect(upsertWorkItem(db, { ...base, blockedBy: [] }).blockedBy).toEqual([]);
  });

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

  test('a refresh keeps updated_at, the time the state last changed (#288)', () => {
    const parkedAt = new Date('2026-01-01T01:00:00Z');
    setWorkItemState(db, workItemId, 'parked', 'budget exhausted: resolve-total', parkedAt);
    const updatedAt = () =>
      (
        db.prepare('SELECT updated_at AS at FROM work_items WHERE id = ?').get(workItemId) as {
          at: string;
        }
      ).at;
    upsertWorkItem(
      db,
      {
        dropZoneId: 'main',
        issueNumber: 7,
        title: 'edited',
        body: 'b2',
        author: 'a',
        priority: 1,
        isFix: false,
        issueCreatedAt: '2026-01-01T00:00:00Z',
      },
      new Date('2026-01-01T02:00:00Z'),
    );
    expect(getWorkItem(db, workItemId)).toMatchObject({ title: 'edited', state: 'parked' });
    expect(updatedAt()).toBe(parkedAt.toISOString());
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

describe("a stick's egress ceiling (#780)", () => {
  const at = new Date('2026-03-01T00:00:00.000Z');
  const advert = (egressCeiling: string[] | null) => ({
    capabilities: [],
    imagePolicy: 'allowlist' as const,
    version: null,
    pinnedImages: [],
    egressCeiling,
  });

  test('none stored reads as null; a lease replaces it, and null clears it', () => {
    insertStick(db, { id: 's1', name: 'box', tokenHash: 'h', slots: 1 });
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toBeNull();
    stampStick(db, 's1', advert(['github.com']), at);
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toEqual(['github.com']);
    stampStick(db, 's1', advert(['github.com', 'gitlab.example.com']), at);
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toEqual([
      'github.com',
      'gitlab.example.com',
    ]);
    stampStick(db, 's1', advert(null), at);
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toBeNull();
  });

  test('enroll stores it', () => {
    insertStick(db, {
      id: 's1',
      name: 'box',
      tokenHash: 'h',
      slots: 1,
      egressCeiling: ['a.example.com'],
    });
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toEqual(['a.example.com']);
  });

  test('a stored value that does not parse reads as [] (covers nothing), never as none', () => {
    insertStick(db, { id: 's1', name: 'box', tokenHash: 'h', slots: 1 });
    for (const bad of ['{', '"github.com"', '{"a":1}', 'null', '42']) {
      db.prepare('UPDATE sticks SET egress_ceiling_json = ? WHERE id = ?').run(bad, 's1');
      expect(getStickByTokenHash(db, 'h')?.egressCeiling, bad).toEqual([]);
    }
    db.prepare('UPDATE sticks SET egress_ceiling_json = ? WHERE id = ?').run('["a.com", 3]', 's1');
    expect(getStickByTokenHash(db, 'h')?.egressCeiling).toEqual(['a.com']);
  });
});

describe('removeStick (issue #255)', () => {
  test("ends the lease of every leased drop of the stick at once, and leaves another stick's alone", () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const later = new Date(now.getTime() + 60_000).toISOString();
    insertStick(db, { id: 'sa', name: 'a', tokenHash: 'ha', slots: 2 });
    insertStick(db, { id: 'sb', name: 'b', tokenHash: 'hb', slots: 2 });
    const other = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 8,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: '2026-01-01T00:00:00Z',
    }).id;
    insertDrop(db, drop('da'));
    insertDrop(db, drop('db', { workItemId: other }));
    // Leased as leaseNextDrop leaves it: started_at is stamped at lease time.
    for (const [id, stick] of [
      ['da', 'sa'],
      ['db', 'sb'],
    ] as const)
      updateDrop(db, id, {
        state: 'leased',
        stickId: stick,
        leaseExpiresAt: later,
        startedAt: now.toISOString(),
      });
    expect(removeStick(db, 'sa', now)?.id).toBe('sa');
    expect(new Date(getDrop(db, 'da')!.leaseExpiresAt!).getTime()).toBeLessThan(now.getTime());
    expect(getDrop(db, 'db')!.leaseExpiresAt).toBe(later);
  });

  test('leaves a running drop to the lost-stick path', () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const later = new Date(now.getTime() + 60_000).toISOString();
    insertStick(db, { id: 'sa', name: 'a', tokenHash: 'ha', slots: 2 });
    insertDrop(db, drop('dr'));
    updateDrop(db, 'dr', { state: 'running', stickId: 'sa', leaseExpiresAt: later });
    removeStick(db, 'sa', now);
    expect(getDrop(db, 'dr')).toMatchObject({ state: 'running', leaseExpiresAt: later });
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
      zoneId: 'main',
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

describe('recordUsageWindows (#737)', () => {
  test('a new set without a stored five_hour forgets it and updates the other keys', () => {
    const t1 = new Date('2026-11-01T00:00:00.000Z');
    const t2 = new Date('2026-11-01T01:00:00.000Z');
    recordUsageWindows(
      db,
      { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.2 } },
      t1,
      null,
    );
    recordUsageWindows(
      db,
      {
        seven_day: { utilization: 0.3, resetsAt: '2026-11-08T00:00:00.000Z' },
        seven_day_fable: { utilization: 0.1 },
      },
      t2,
      'm',
    );
    expect(listUsageWindows(db)).toEqual([
      {
        key: 'seven_day',
        utilization: 0.3,
        resetsAt: '2026-11-08T00:00:00.000Z',
        observedAt: t2.toISOString(),
        model: 'm',
      },
      {
        key: 'seven_day_fable',
        utilization: 0.1,
        resetsAt: null,
        observedAt: t2.toISOString(),
        model: 'm',
      },
    ]);
  });

  test('an empty set forgets nothing', () => {
    const t1 = new Date('2026-11-01T00:00:00.000Z');
    recordUsageWindows(db, { five_hour: { utilization: 0.5 } }, t1, null);
    recordUsageWindows(db, {}, t1, null);
    expect(listUsageWindows(db).map((w) => w.key)).toEqual(['five_hour']);
  });
});

describe('zone removal and history', () => {
  const at = new Date('2026-02-01T00:00:00.000Z');
  const fresh = () => {
    const d = openDb(tmpFile());
    upsertDropZone(d, { id: 'z', repo: 'octo/z', defaultBranch: 'main', configJson: '{}' });
    ensureZoneMode(d, 'z', 'active', at);
    return d;
  };

  test('zoneDrained needs observe, no active drop and no pending forge write', () => {
    const d = fresh();
    expect(zoneDrained(d, 'z')).toBe(false); // active
    setZoneMode(d, 'z', 'observe', at);
    expect(zoneDrained(d, 'z')).toBe(true);
    const wi = upsertWorkItem(d, {
      dropZoneId: 'z',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: at.toISOString(),
    });
    insertDrop(d, { ...drop('d-run', { state: 'running' }), dropZoneId: 'z', workItemId: wi.id });
    expect(zoneDrained(d, 'z')).toBe(false);
    d.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd-run'").run();
    expect(zoneDrained(d, 'z')).toBe(true);
    insertOutbox(d, {
      id: 'o1',
      opKey: 'k1',
      kind: 'merge',
      workItemId: wi.id,
      zoneId: 'z',
      payloadJson: '{}',
      state: 'pending',
      createdAt: at.toISOString(),
    });
    expect(zoneDrained(d, 'z')).toBe(false);
    // A zone with no mode row at all is not known to be drained.
    expect(zoneDrained(d, 'nobody')).toBe(false);
  });

  test('zoneHasHistory sees work items, drops, outbox rows, crew issues and goals, each alone', () => {
    const cases: [string, (d: Db) => void][] = [
      [
        'work item',
        (d) =>
          upsertWorkItem(d, {
            dropZoneId: 'z',
            issueNumber: 1,
            title: 't',
            body: 'b',
            author: 'a',
            priority: 0,
            isFix: false,
            issueCreatedAt: at.toISOString(),
          }),
      ],
      [
        'drop',
        (d) =>
          insertDrop(d, { ...drop('d1', { workItemId: null, role: 'doctor' }), dropZoneId: 'z' }),
      ],
      [
        'outbox',
        (d) =>
          insertOutbox(d, {
            id: 'o1',
            opKey: 'k1',
            kind: 'merge',
            workItemId: null,
            zoneId: 'z',
            payloadJson: '{}',
            state: 'done',
            createdAt: at.toISOString(),
          }),
      ],
      [
        'crew issue',
        (d) =>
          d
            .prepare(
              `INSERT INTO crew_issues (zone_id, key, source, objective, title, title_norm, body, state, created_at, updated_at)
               VALUES ('z', 'k', 'crew', 'o', 't', 't', 'b', 'staged', ?, ?)`,
            )
            .run(at.toISOString(), at.toISOString()),
      ],
      [
        'goals',
        (d) =>
          d
            .prepare(
              "INSERT INTO goals (zone_id, parser_version, parse_json, read_at) VALUES ('z', 1, '{}', ?)",
            )
            .run(at.toISOString()),
      ],
    ];
    for (const [name, seed] of cases) {
      const d = fresh();
      expect(zoneHasHistory(d, 'z'), name).toBe(false);
      seed(d);
      expect(zoneHasHistory(d, 'z'), name).toBe(true);
      expect(zoneHasHistory(d, 'other'), name).toBe(false);
    }
  });

  test('deleteZoneControls removes the mode row only, and zoneHistoryRepo names the repository the history is for', () => {
    const d = fresh();
    setZoneMode(d, 'z', 'observe', at);
    deleteZoneControls(d, 'z');
    expect(getZoneMode(d, 'z', 'active')).toBe('active');
    expect(zoneHistoryRepo(d, 'z')).toBe('octo/z');
    expect(zoneHistoryRepo(d, 'none')).toBeUndefined();
  });
});

describe('stopping a zone (v24)', () => {
  const at = new Date('2026-02-01T00:00:00.000Z');
  test('markZoneStopping sets observe and records who asked and when, once; clearing keeps the mode', () => {
    const d = openDb(tmpFile());
    ensureZoneMode(d, 'z', 'active', at);
    expect(zoneStopping(d, 'z')).toBeUndefined();
    markZoneStopping(d, 'z', 'ui', at);
    expect(getZoneMode(d, 'z', 'active')).toBe('observe');
    expect(zoneStopping(d, 'z')).toEqual({ since: at.toISOString(), via: 'ui' });
    markZoneStopping(d, 'z', 'ctl', new Date(at.getTime() + 1000));
    expect(zoneStopping(d, 'z')).toEqual({ since: at.toISOString(), via: 'ui' });
    // A zone with no mode row yet gets one.
    markZoneStopping(d, 'y', 'ctl', at);
    expect(stoppingZones(d).sort()).toEqual(['y', 'z']);
    clearZoneStopping(d, 'z');
    expect(zoneStopping(d, 'z')).toBeUndefined();
    expect(getZoneMode(d, 'z', 'active')).toBe('observe');
    expect(stoppingZones(d)).toEqual(['y']);
  });

  test('zoneWaits counts drops in flight, pending pushes and unsettled outbox writes apart', () => {
    const d = db;
    expect(zoneWaits(d, 'main')).toEqual({ drops: 0, pushes: 0, outbox: 0 });
    insertDrop(d, drop('r', { state: 'running', role: 'review' }));
    const other = upsertWorkItem(d, {
      dropZoneId: 'main',
      issueNumber: 8,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: at.toISOString(),
    });
    insertDrop(d, drop('p', { state: 'push_pending', workItemId: other.id }));
    insertDrop(d, drop('s', { state: 'succeeded' }));
    // A queued doctor drop never blocks a mode change, nor a removal.
    insertDrop(d, {
      ...drop('q', { state: 'queued', workItemId: null, role: 'doctor' }),
    });
    for (const [id, state] of [
      ['o1', 'pending'],
      ['o2', 'unknown'],
      ['o3', 'done'],
    ] as const)
      insertOutbox(d, {
        id,
        opKey: id,
        kind: 'merge',
        workItemId: null,
        zoneId: 'main',
        payloadJson: '{}',
        state,
        createdAt: at.toISOString(),
      });
    expect(zoneWaits(d, 'main')).toEqual({ drops: 1, pushes: 1, outbox: 2 });
  });
});

describe('push_pending (v22)', () => {
  test('push_pending blocks a second active drop for the item', () => {
    insertDrop(db, drop('d1', { state: 'running' }));
    updateDrop(db, 'd1', { state: 'push_pending' });
    expect(() => insertDrop(db, drop('d2'))).toThrow(/UNIQUE/);
    expect(activeDropFor(db, workItemId)?.id).toBe('d1');
    expect(ACTIVE_DROP_STATES).toContain('push_pending');
    updateDrop(db, 'd1', { state: 'succeeded' });
    expect(() => insertDrop(db, drop('d2'))).not.toThrow();
  });

  test('the new drop columns round-trip', () => {
    insertDrop(db, drop('d1'));
    expect(getDrop(db, 'd1')).toMatchObject({
      pushKind: null,
      pushExpectSha: null,
      pushDeadline: null,
      runningAt: null,
      usageApplied: 0,
      wasProbe: 0,
    });
    updateDrop(db, 'd1', {
      pushKind: 'final',
      pushExpectSha: 'abc',
      pushDeadline: 'dl',
      runningAt: 'ra',
      usageApplied: 1,
      wasProbe: 1,
    });
    expect(getDrop(db, 'd1')).toMatchObject({
      pushKind: 'final',
      pushExpectSha: 'abc',
      pushDeadline: 'dl',
      runningAt: 'ra',
      usageApplied: 1,
      wasProbe: 1,
    });
  });
});

describe('push grant reservations', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);
  const rows = () =>
    db
      .prepare(
        'SELECT seq, minted_at AS m, revoked_at AS r FROM push_tokens WHERE drop_id = ? ORDER BY seq',
      )
      .all('d1') as { seq: number; m: string | null; r: string | null }[];

  test('reserveGrant: one live reservation; a stale one is replaced', () => {
    expect(reserveGrant(db, 'd1', 1, t(0))).toBe('ok');
    expect(reserveGrant(db, 'd1', 1, t(GRANT_HOLD_MS - 1))).toBe('reserved');
    expect(rows()).toHaveLength(1);
    expect(reserveGrant(db, 'd1', 1, t(GRANT_HOLD_MS))).toBe('ok');
    const r = rows();
    expect(r.map((x) => x.seq)).toEqual([1, 2]);
    expect(r[0]?.r).not.toBeNull();
    expect(r[1]?.r).toBeNull();
  });

  test('markMinted stamps the live reservation; revokeGrants frees the drop', () => {
    reserveGrant(db, 'd1', 1, t(0));
    markMinted(db, 'd1', 1, t(5));
    expect(rows()[0]?.m).toBe(t(5).toISOString());
    revokeGrants(db, 'd1', t(10));
    expect(rows()[0]?.r).toBe(t(10).toISOString());
    expect(reserveGrant(db, 'd1', 1, t(11))).toBe('ok');
  });
});

describe('kill switch time', () => {
  const t = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms);
  const engagedAt = () =>
    (
      db.prepare('SELECT engaged_at AS e FROM kill_switch WHERE id = 1').get() as {
        e: string | null;
      }
    ).e;

  test('setKilled records engaged_at once and returns the paused time', () => {
    expect(setKilled(db, true, t(1000))).toBe(0);
    expect(engagedAt()).toBe(t(1000).toISOString());
    expect(setKilled(db, true, t(5000))).toBe(0);
    expect(engagedAt()).toBe(t(1000).toISOString());
    expect(isKilled(db)).toBe(true);
    expect(setKilled(db, false, t(9000))).toBe(8000);
    expect(isKilled(db)).toBe(false);
    expect(engagedAt()).toBeNull();
    expect(setKilled(db, false, t(10000))).toBe(0);
  });
});
