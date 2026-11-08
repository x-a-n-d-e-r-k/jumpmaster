import { beforeEach, describe, expect, test, vi } from 'vitest';
import { type Db, openDb } from './db/open.js';
import {
  getOutbox,
  insertOutbox,
  listOutbox,
  setKilled,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import {
  type ForgePair,
  markPendingUnknown,
  opKeys,
  opMarker,
  pairFor,
  resolveUnknown,
  runOp,
  sanitizeForgeText,
} from './outbox.js';
import { fakeForgePair } from './test/fakes.js';
import { plus, t0, tmpDbFile } from './test/helpers.js';

const MIN = 60_000;
const t1 = plus(t0, MIN);

function item(db: Db, zone: string, n: number): number {
  return upsertWorkItem(db, {
    dropZoneId: zone,
    issueNumber: n,
    title: `Issue ${n}`,
    body: 'b',
    author: 'alice',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  }).id;
}

let db: Db;
let f: ReturnType<typeof fakeForgePair>;
let forges: ForgePair;
let itemId: number;

const calls = (method: string) =>
  [...f.author.calls, ...f.reviewer.calls].filter((c) => c.method === method);

const prOp = () => ({
  kind: 'create_pr' as const,
  opKey: opKeys.pr(itemId, 'h1'),
  zoneId: 'main',
  itemId,
  payload: { head: 'agent/issue-1', base: 'main', title: 'Issue 1', body: 'Closes #1' },
});
const reviewOp = () => ({
  kind: 'post_review' as const,
  opKey: opKeys.review(itemId, 'h1', 'd9'),
  zoneId: 'main',
  itemId,
  payload: { pr: 1, event: 'APPROVE' as const, body: 'looks good', commitId: 'h1' },
});
const mergeOp = () => ({
  kind: 'merge' as const,
  opKey: opKeys.merge(itemId, 'h1'),
  zoneId: 'main',
  itemId,
  payload: { pr: 1, sha: 'h1', title: 'Issue 1', message: 'Closes #1' },
});

function seed(
  op: {
    kind: 'create_pr' | 'post_review' | 'merge';
    opKey: string;
    zoneId: string;
    itemId: number;
    payload: unknown;
  },
  state: 'pending' | 'unknown' | 'done' | 'failed',
  at: Date,
): void {
  insertOutbox(db, {
    id: `seed-${op.opKey}`,
    opKey: op.opKey,
    kind: op.kind,
    workItemId: op.itemId,
    zoneId: op.zoneId,
    payloadJson: JSON.stringify(op.payload),
    state,
    createdAt: at.toISOString(),
  });
}

beforeEach(() => {
  db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  upsertDropZone(db, { id: 'other', repo: 'octo/other', defaultBranch: 'main', configJson: '{}' });
  itemId = item(db, 'main', 1);
  f = fakeForgePair({ issues: [], trusted: [] });
  forges = { author: f.author, reviewer: f.reviewer };
});

describe('FakeForgeState', () => {
  test('FakeForgeState numbers PRs from 1 and addPull creates the branch', async () => {
    const p = f.state.addPull({ headRef: 'agent/issue-3', headSha: 's3', author: 'author-bot' });
    expect(p).toMatchObject({
      number: 1,
      state: 'open',
      merged: false,
      title: 'Issue 3',
      baseRef: 'main',
      headRepo: 'octo/demo',
    });
    expect(f.state.branches.get('agent/issue-3')).toBe('s3');
    const r = await f.author.findOrCreatePullRequest({
      head: 'agent/issue-4',
      base: 'main',
      title: 't',
      body: 'b',
    });
    expect(r).toMatchObject({ number: 2, created: true });
    expect(await f.author.findOpenPullByHead('agent/issue-3')).toMatchObject({ number: 1 });
  });

  test('a merger forge, when set, performs the merge instead of the author', async () => {
    const byAuthor = vi.spyOn(forges.author, 'merge');
    const byMerger = vi.spyOn(forges.reviewer, 'merge');
    await runOp(db, { ...forges, merger: forges.reviewer }, mergeOp(), new Date());
    expect(byMerger).toHaveBeenCalledOnce();
    expect(byAuthor).not.toHaveBeenCalled();
  });

  test('pairFor merges through the reviewer only when the author may be an admin', () => {
    const tokens = { githubAuthorToken: 'a', githubReviewerToken: 'r' };
    const owner = pairFor({ repo: 'o/r', authorMayBeAdmin: true }, tokens);
    expect(owner.merger).toBe(owner.reviewer);
    expect(pairFor({ repo: 'o/r', authorMayBeAdmin: false }, tokens).merger).toBeUndefined();
  });

  test("create_pr refuses to track an open PR without this item's marker", async () => {
    const op = {
      kind: 'create_pr' as const,
      opKey: opKeys.pr(itemId, 'h2'),
      zoneId: 'main',
      itemId,
      payload: { head: 'agent/issue-77', base: 'main', title: 't', body: 'b' },
    };
    f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'author-bot' });
    expect(await runOp(db, forges, op, new Date())).toMatchObject({
      state: 'failed',
      error: 'hand-opened PR on agent branch: #1',
    });
  });

  test('create_pr accepts a listed open PR', async () => {
    const op = {
      kind: 'create_pr' as const,
      opKey: opKeys.pr(itemId, 'h2'),
      zoneId: 'main',
      itemId,
      payload: { head: 'agent/issue-77', base: 'main', title: 't', body: 'b', adoptPulls: [1] },
    };
    f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'author-bot' });
    expect(await runOp(db, forges, op, new Date())).toMatchObject({
      state: 'done',
      result: { number: 1 },
    });
  });

  test('create_pr refuses a listed open PR from another author', async () => {
    const op = {
      kind: 'create_pr' as const,
      opKey: opKeys.pr(itemId, 'h2'),
      zoneId: 'main',
      itemId,
      payload: { head: 'agent/issue-77', base: 'main', title: 't', body: 'b', adoptPulls: [1] },
    };
    f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'mallory' });
    expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'failed' });
  });

  test('create_pr tracks an open PR carrying this item marker from an older head', async () => {
    const op = {
      kind: 'create_pr' as const,
      opKey: opKeys.pr(itemId, 'h2'),
      zoneId: 'main',
      itemId,
      payload: { head: 'agent/issue-77', base: 'main', title: 't', body: 'b' },
    };
    f.state.addPull({
      headRef: 'agent/issue-77',
      headSha: 'h2',
      author: 'author-bot',
      body: opMarker(opKeys.pr(itemId, 'h1')),
    });
    expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'done' });
  });

  test('a merge appends to state.merges and marks the PR merged', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    await f.author.merge(1, { sha: 'h1', method: 'squash', title: 'T', message: 'Closes #1' });
    expect(f.state.merges).toEqual([{ number: 1, sha: 'h1', title: 'T', message: 'Closes #1' }]);
    expect(f.state.pulls.get(1)).toMatchObject({ merged: true, state: 'closed' });
  });

  test('deleteBranch closes the open PR and setHead moves the branch', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.state.setHead(1, 'h2');
    expect(await f.author.branchSha('agent/issue-1')).toBe('h2');
    f.state.deleteBranch('agent/issue-1');
    expect(f.state.pulls.get(1)?.state).toBe('closed');
    expect(await f.author.findOpenPullByHead('agent/issue-1')).toBeNull();
  });

  test('failures throw ForgeError with status and identities have their own logins', async () => {
    f.reviewer.failNext('getPull', { status: 404, message: 'Not Found' });
    await expect(f.reviewer.getPull(1)).rejects.toMatchObject({
      status: 404,
      message: 'Not Found',
    });
    expect(await f.author.viewerLogin()).toBe('author-bot');
    expect(await f.reviewer.viewerLogin()).toBe('reviewer-bot');
    expect(f.reviewer.calls[0]).toEqual({ method: 'getPull', identity: 'reviewer', args: [1] });
  });
  test('createReview is 422 on a closed PR or a stale commit', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    const review = (commitId: string) =>
      f.reviewer.createReview(1, { event: 'APPROVE', body: 'b', commitId });
    await expect(review('old')).rejects.toMatchObject({ status: 422 });
    f.state.close(1);
    await expect(review('h1')).rejects.toMatchObject({ status: 422 });
    expect(f.state.reviews).toHaveLength(0);
  });
});

describe('runOp', () => {
  test('a done op is never re-issued', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    expect((await runOp(db, forges, mergeOp(), t0)).state).toBe('done');
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('done');
    expect(calls('merge')).toHaveLength(1);
    expect(f.state.merges).toHaveLength(1);
  });

  test('merge 5xx after success is resolved by read-back', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.author.failNext('merge', '5xx-after-success');
    expect((await runOp(db, forges, mergeOp(), t0)).state).toBe('unknown');
    expect(await resolveUnknown(db, forges, 'main', t0, 45)).toBe(1);
    expect(getOutbox(db, mergeOp().opKey)?.state).toBe('done');
    expect(f.author.calls.filter((c) => c.method === 'merge')).toHaveLength(1);
  });

  test('a thrown merge with no status is unknown', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.author.failNext('merge', 'throw');
    expect((await runOp(db, forges, mergeOp(), t0)).state).toBe('unknown');
    expect(f.state.merges).toHaveLength(0);
  });

  test('a rate-limited write (403 secondary limit) is unknown, not failed', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.author.failNext('merge', {
      status: 403,
      message: 'You have exceeded a secondary rate limit',
    });
    expect((await runOp(db, forges, mergeOp(), t0)).state).toBe('unknown');
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('unknown');
  });

  test('runOp on an unknown row runs the lookup only', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    seed(mergeOp(), 'unknown', t0);
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('unknown');
    expect(calls('merge')).toHaveLength(0);
    expect(calls('getPull')).toHaveLength(1);
  });

  test('runOp on a pending row whose effect is visible marks it done', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.state.markMerged(1);
    seed(mergeOp(), 'pending', t0);
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('done');
    expect(calls('merge')).toHaveLength(0);
  });

  test('runOp on a failed row never writes', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    seed(mergeOp(), 'failed', t0);
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('failed');
    expect(f.author.calls).toHaveLength(0);
  });

  test('merge 405 is failed with the message', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.author.failNext('merge', { status: 405, message: 'Base branch was modified' });
    expect(await runOp(db, forges, mergeOp(), t0)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/Base branch/),
    });
    expect(getOutbox(db, mergeOp().opKey)).toMatchObject({ state: 'failed' });
    expect((await runOp(db, forges, mergeOp(), t1)).state).toBe('failed');
    expect(calls('merge')).toHaveLength(1);
  });

  test('merge 5xx is unknown', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.author.failNext('merge', '5xx');
    expect((await runOp(db, forges, mergeOp(), t0)).state).toBe('unknown');
  });

  test('create_pr writes a body ending with the marker', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    const r = await runOp(db, forges, prOp(), t0);
    expect(r).toMatchObject({ state: 'done', result: { number: 1 } });
    const body = calls('findOrCreatePullRequest')[0]?.args[0] as { body: string };
    expect(body.body.split('\n').pop()).toBe(opMarker(prOp().opKey));
    expect(body.body).toContain('Closes #1');
  });

  test('create_pr adopts an open PR found by lookup', async () => {
    f.state.addPull({
      headRef: 'agent/issue-1',
      headSha: 'h1',
      author: 'author-bot',
      body: `Closes #1\n\n${opMarker(prOp().opKey)}`,
    });
    expect(await runOp(db, forges, prOp(), t0)).toMatchObject({
      state: 'done',
      result: { number: 1 },
    });
    expect(calls('findOrCreatePullRequest')).toHaveLength(0);
  });

  test('a done create_pr whose PR was closed runs again', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    expect((await runOp(db, forges, prOp(), t0)).state).toBe('done');
    f.state.close(1);
    expect(await runOp(db, forges, prOp(), t1)).toMatchObject({
      state: 'done',
      result: { number: 2 },
    });
    expect(calls('findOrCreatePullRequest')).toHaveLength(2);
  });

  test('a done create_pr whose PR merged keeps its stored result', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    await runOp(db, forges, prOp(), t0);
    f.state.markMerged(1);
    expect(await runOp(db, forges, prOp(), t1)).toMatchObject({
      state: 'done',
      result: { number: 1 },
    });
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
    expect(getOutbox(db, prOp().opKey)?.state).toBe('done');
  });

  test('a reset create_pr restarts its deadline clock', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    await runOp(db, forges, prOp(), t0);
    f.state.close(1);
    f.author.failNext('findOrCreatePullRequest', '5xx');
    expect((await runOp(db, forges, prOp(), t1)).state).toBe('unknown');
    expect(getOutbox(db, prOp().opKey)?.createdAt).toBe(t1.toISOString());
  });

  test('the done to pending reset is compare-and-set', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    await runOp(db, forges, prOp(), t0);
    f.state.close(1);
    const [a, b] = await Promise.all([
      runOp(db, forges, prOp(), t1),
      runOp(db, forges, prOp(), t1),
    ]);
    expect([a.state, b.state].sort()).toEqual(['done', 'unknown']);
    expect(calls('findOrCreatePullRequest')).toHaveLength(2);
  });

  test('a done create_pr whose PR is still open is reused', async () => {
    f.state.branches.set('agent/issue-1', 'h1');
    await runOp(db, forges, prOp(), t0);
    expect((await runOp(db, forges, prOp(), t1)).state).toBe('done');
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
  });

  test('post_review finds its own marker instead of posting twice', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    const op = reviewOp();
    seed(op, 'unknown', t0);
    f.state.reviews.push({
      pr: 1,
      id: 77,
      author: 'reviewer-bot',
      state: 'APPROVED',
      commitId: 'h1',
      body: `ok\n\n${opMarker(op.opKey)}`,
      submittedAt: t0.toISOString(),
    });
    expect(await runOp(db, forges, op, t1)).toMatchObject({ state: 'done', result: { id: 77 } });
    expect(calls('createReview')).toHaveLength(0);
  });

  test('post_review uses the reviewer identity', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    expect((await runOp(db, forges, reviewOp(), t0)).state).toBe('done');
    expect(f.author.calls).toHaveLength(0);
    expect(f.reviewer.calls.map((c) => c.method)).toEqual(['findReviewByMarker', 'createReview']);
    expect(f.state.reviews).toHaveLength(1);
    expect(f.state.reviews[0]).toMatchObject({ author: 'reviewer-bot', state: 'APPROVED', pr: 1 });
    expect(f.state.reviews[0]?.body.split('\n').pop()).toBe(opMarker(reviewOp().opKey));
  });
});

describe('recovery', () => {
  test('an unknown row older than the deadline becomes failed', async () => {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    seed(mergeOp(), 'unknown', t0);
    expect(await resolveUnknown(db, forges, 'main', plus(t0, 44 * MIN), 45)).toBe(0);
    expect(getOutbox(db, mergeOp().opKey)?.state).toBe('unknown');
    await resolveUnknown(db, forges, 'main', plus(t0, 46 * MIN), 45);
    expect(getOutbox(db, mergeOp().opKey)).toMatchObject({
      state: 'failed',
      error: 'unresolved after 45 min',
    });
  });

  test('resolveUnknown ignores rows of other zones', async () => {
    const otherItem = item(db, 'other', 1);
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.state.markMerged(1);
    const op = {
      ...mergeOp(),
      opKey: opKeys.merge(otherItem, 'h1'),
      zoneId: 'other',
      itemId: otherItem,
    };
    seed(op, 'unknown', t0);
    expect(await resolveUnknown(db, forges, 'main', t1, 45)).toBe(0);
    expect(getOutbox(db, op.opKey)?.state).toBe('unknown');
    expect(f.author.calls).toHaveLength(0);
  });

  test('markPendingUnknown flips pending rows', () => {
    seed(mergeOp(), 'pending', t0);
    seed(prOp(), 'done', t0);
    expect(markPendingUnknown(db, t1)).toBe(1);
    expect(getOutbox(db, mergeOp().opKey)?.state).toBe('unknown');
    expect(getOutbox(db, prOp().opKey)?.state).toBe('done');
  });
});

describe('sanitizeForgeText', () => {
  test('sanitizeForgeText redacts secrets and escapes markers and mentions', () => {
    expect(sanitizeForgeText('tok @org/team <!-- jm:op:x -->', ['tok'])).not.toMatch(
      /tok|<!--|-->|(^|\s)@org/,
    );
  });

  test('neutralises mentions and links without code spans, leaves emails alone', () => {
    const live = /(^|[^\w])@[A-Za-z0-9]|https?:\/\//;
    for (const input of [
      '`cc @org/team`',
      '`a`@org/team',
      '(https://evil.test/x)',
      'www.evil.test',
    ]) {
      const out = sanitizeForgeText(input, []);
      expect(out).not.toMatch(live);
      expect(out).not.toMatch(/(^|[^\w])www\./);
      expect(out.replaceAll('\u200d', '')).toBe(input);
    }
    expect(sanitizeForgeText('mail a@b.test', [])).toBe('mail a@b.test');
  });

  test('truncation never splits a code span', () => {
    expect(sanitizeForgeText('x'.repeat(100), [], 10)).toHaveLength(10);
    expect(sanitizeForgeText('ab `code span` cd', [], 8)).toBe('ab ');
    expect(sanitizeForgeText('ab `c` `d e`', [], 9)).toBe('ab `c` ');
  });
});

describe('zone-level ops', () => {
  const crewOp = () => ({
    kind: 'create_issue' as const,
    opKey: 'issue:main:obj:k',
    zoneId: 'main',
    itemId: null,
    payload: { title: 't', body: 'b', labels: [], since: t0.toISOString() },
  });
  const rows = () => (db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number }).c;

  test('runOp refuses a crew op in observe and while killed, before any insert', async () => {
    setZoneMode(db, 'main', 'observe', t0);
    await expect(runOp(db, forges, crewOp(), t1)).rejects.toThrow(/observe mode/);
    setZoneMode(db, 'main', 'active', t0);
    setKilled(db, true, t0);
    await expect(runOp(db, forges, crewOp(), t1)).rejects.toThrow(/kill switch/);
    expect(rows()).toBe(0);
    expect(f.author.calls).toHaveLength(0);
  });

  test('listOutbox filters on the row zone, not on a work item', () => {
    insertOutbox(db, {
      id: 'z1',
      opKey: 'issue:main:o:a',
      kind: 'create_issue',
      zoneId: 'main',
      workItemId: null,
      payloadJson: '{}',
      state: 'unknown',
      createdAt: t0.toISOString(),
    });
    expect(listOutbox(db, ['unknown'], 'main').map((r) => r.opKey)).toEqual(['issue:main:o:a']);
    expect(listOutbox(db, ['unknown'], 'other')).toEqual([]);
  });
});
