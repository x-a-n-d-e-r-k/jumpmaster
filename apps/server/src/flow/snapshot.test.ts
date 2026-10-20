import { beforeEach, describe, expect, test } from 'vitest';
import { getWorkItem, insertVerdict, type VerdictRow } from '../db/repo.js';
import { zoneWorld } from '../test/fixtures.js';
import { decide } from './decide.js';
import { buildSnapshot, zonePass } from './snapshot.js';

const now = new Date('2026-01-01T01:00:00Z');
const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });

let w: ReturnType<typeof zoneWorld>;
let itemId: number;

const snapshotOf = async (id = itemId) => {
  const pass = await zonePass(w.forges, w.zone, 'main');
  const item = getWorkItem(w.db, id);
  if (!item) throw new Error('no item');
  return buildSnapshot(w.db, w.forges, w.zone, item, pass, now);
};

const approveRow = (headSha: string): VerdictRow => ({
  id: `v-${headSha}`,
  workItemId: itemId,
  headSha,
  decision: 'approve',
  forced: false,
  summary: 'ok',
  findingsJson: '[]',
  gatesJson: '[]',
  createdAt: now.toISOString(),
});

beforeEach(() => {
  w = zoneWorld();
  itemId = w.prItem(1, 'sha1');
});

describe('zonePass', () => {
  test('reads both bot logins and the author identity required checks', async () => {
    const p = await zonePass(w.forges, w.zone, 'main');
    expect(p.botLogins).toEqual(['author-bot', 'reviewer-bot']);
    expect(p.requiredChecks).toEqual(['ci']);
    expect(p.protectionProblems).toEqual([]);
  });
});

describe('buildSnapshot', () => {
  test('gate script compare uses the merge base, not the base tip', async () => {
    w.f.state.compares.set('main...sha1', {
      aheadBy: 1,
      behindBy: 2,
      baseSha: 'base-tip',
      mergeBaseSha: 'mb',
    });
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    w.f.state.files.set('mb:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('base-tip:package.json', pkg({ test: 'vitest --changed' }));
    expect((await snapshotOf()).gateScriptChanges).toEqual([]);
  });

  test('a changed gate script against the merge base is reported', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'package.json' }], complete: true });
    w.f.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
    w.f.state.files.set('sha1:package.json', pkg({ test: 'exit 0' }));
    expect((await snapshotOf()).gateScriptChanges).toEqual(['test']);
  });

  test('a thrown package.json read is forge unavailability (the pass waits), not a park', async () => {
    w.f.state.pullFiles.set(1, { files: [{ path: 'pkg/package.json' }], complete: true });
    w.f.author.failNext('getFileAt', '5xx');
    const s = await snapshotOf();
    expect(s.forgeUnavailable).toBe('getFileAt');
    expect(s.gateScriptChanges).toEqual([]);
  });

  test('snapshot excludes both bots from trust', async () => {
    w.f.state.review({ author: 'reviewer-bot', state: 'CHANGES_REQUESTED' });
    w.f.state.review({ author: 'author-bot', state: 'CHANGES_REQUESTED' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.humanBlockStanding).toBe(false);
  });

  test('a review body carrying an op marker is never trusted', async () => {
    w.f.state.review({ author: 'human', state: 'CHANGES_REQUESTED', body: 'x <!-- jm:op:k -->' });
    expect((await snapshotOf()).trustedChangeRequests).toEqual([]);
  });

  test('a trusted human change request on head is reported', async () => {
    w.f.state.review({ id: 7, author: 'human', state: 'CHANGES_REQUESTED', body: 'fix it' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests.map((r) => r.id)).toEqual([7]);
  });

  test('snapshot sees a standing human block on an older commit', async () => {
    w.f.state.review({ author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.humanBlockStanding).toBe(true);
  });

  test('a later approval by the same author lifts the block; a comment does not', async () => {
    w.f.state.review({ id: 1, author: 'human', state: 'CHANGES_REQUESTED', commitId: 'sha0' });
    w.f.state.review({ id: 2, author: 'human', state: 'COMMENTED', commitId: 'sha0' });
    expect((await snapshotOf()).humanBlockStanding).toBe(true);
    w.f.state.review({ id: 3, author: 'human', state: 'APPROVED' });
    expect((await snapshotOf()).humanBlockStanding).toBe(false);
  });

  test('a failed trust lookup is untrusted', async () => {
    w.f.state.review({ author: 'stranger', state: 'CHANGES_REQUESTED' });
    w.f.author.failNext('isTrusted', '5xx');
    const s = await snapshotOf();
    expect(s.trustedChangeRequests).toEqual([]);
    expect(s.forgeUnavailable).toBe('isTrusted');
  });

  test('an approval on the previous head is not in verdictsOnHead', async () => {
    insertVerdict(w.db, approveRow('sha1'));
    w.f.state.setHead(1, 'sha2');
    w.f.state.checks.set('sha2', { state: 'success', names: ['ci'] });
    const s = await snapshotOf();
    expect(s.verdictsOnHead).toEqual([]);
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'review' });
  });

  test('a thrown listReviews never hides a human block', async () => {
    w.f.author.failNext('listReviews', '5xx');
    const s = await snapshotOf();
    expect(s.forgeUnavailable).toBe('listReviews');
    expect(decide(s)).toEqual({ kind: 'wait', on: 'forge' });
  });

  test('a thrown getPull gives pr null and starts the waiting clock', async () => {
    w.f.author.failNext('getPull', '5xx');
    const s = await snapshotOf();
    expect(s.pr).toBeNull();
    expect(s.missingSince).toBe(now.toISOString());
  });

  test('a branch answered absent is null without forgeUnavailable', async () => {
    w.f.state.branches.delete('agent/issue-1');
    const s = await snapshotOf();
    expect(s.branchSha).toBeNull();
    expect(s.forgeUnavailable).toBeNull();
  });

  test('the head change is recorded on the pull request row', async () => {
    w.f.state.setHead(1, 'sha2');
    const s = await snapshotOf();
    expect(s.pr?.headSha).toBe('sha2');
    expect(s.headFirstSeenAt).toBe(now.toISOString());
  });
});
