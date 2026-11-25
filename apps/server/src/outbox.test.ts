import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import nock from 'nock';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { getCrewIssueByKey, insertCrewIssue } from './crew/store.js';
import { MIGRATIONS } from './db/migrations.js';
import { type Db, openDb } from './db/open.js';
import {
  getOutbox,
  insertOutbox,
  listOutbox,
  listWorkItems,
  type OutboxRow,
  setKilled,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import { GitHubForge, type TokenProvider } from './forge/github.js';
import { USE_PERMISSIONS } from './forge/github-app.js';
import {
  appPushToken,
  COMMENT_BODY_MAX,
  commentMarker,
  type ForgePair,
  ForgePairs,
  forgeTokenFingerprint,
  markPendingUnknown,
  opKeys,
  opMarker,
  pairFor,
  pairKey,
  pairOptionsFor,
  pushOptionsFor,
  resolveUnknown,
  runOp,
  sanitizeCrewText,
  sanitizeForgeText,
  unsanitizeForgeText,
} from './outbox.js';
import { syncDropZone } from './sync.js';
import { FORGE_WRITES, fakeForgePair } from './test/fakes.js';
import { makeZone } from './test/fixtures.js';
import { plus, t0, tmpDbFile } from './test/helpers.js';
import type { Resolved } from './vault/credentials.js';
import type { AppEntryRead, AppRole, CredentialRef } from './vault/github-app-entries.js';
import type { ResolvedApps } from './vault/resolution.js';

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

  test('a changed author token fingerprint rebuilds the forge pair and an unchanged one keeps it', () => {
    const pairs = new ForgePairs();
    const zone = { id: 'main', repo: 'o/r', authorMayBeAdmin: false, identity: 'two-bot' as const };
    const tokens = { githubAuthorToken: 'a1', githubReviewerToken: 'r1' };
    const first = pairs.for(zone, tokens);
    // An equal config object rebuilt by the store (a new revision elsewhere) keeps the pair.
    expect(pairs.for({ ...zone }, { ...tokens })).toBe(first);
    const rotated = pairs.for(zone, { ...tokens, githubAuthorToken: 'a2' });
    expect(rotated).not.toBe(first);
    expect(pairs.for(zone, { ...tokens, githubAuthorToken: 'a2' })).toBe(rotated);
    // The reviewer token, the identity and the admin setting decide the pair too.
    expect(pairs.for(zone, { githubAuthorToken: 'a2', githubReviewerToken: 'r2' })).not.toBe(
      rotated,
    );
    const starter = pairs.for({ ...zone, identity: 'starter' }, { githubAuthorToken: 'a2' });
    expect(starter.reviewer).toBeNull();
    expect(pairs.for({ ...zone, authorMayBeAdmin: true }, tokens).merger).toBeDefined();
    // Timed pairs are cached apart from untimed ones.
    expect(pairs.for(zone, tokens, { requestTimeoutMs: 5 })).not.toBe(pairs.for(zone, tokens));
    // Only the latest pair per zone and kind is kept.
    expect(pairs.size()).toBeLessThanOrEqual(2);
  });

  test('ForgePairs forgets the pairs of zones no longer configured (a removed zone is drained first)', () => {
    const pairs = new ForgePairs();
    const tokens = { githubAuthorToken: 'a1', githubReviewerToken: 'r1' };
    const zone = (id: string) => ({ id, repo: `o/${id}`, authorMayBeAdmin: false });
    const kept = pairs.for(zone('a'), tokens);
    pairs.for(zone('a'), tokens, { requestTimeoutMs: 5 });
    pairs.for(zone('b'), tokens);
    pairs.for(zone('b'), tokens, { requestTimeoutMs: 5 });
    expect(pairs.size()).toBe(4);
    pairs.retain(['a']);
    expect(pairs.size()).toBe(2);
    expect(pairs.for(zone('a'), tokens)).toBe(kept);
  });

  test('forgeTokenFingerprint is a short hash that changes with any forge token and holds none', () => {
    const s = { githubAuthorToken: 'ghp_author', githubReviewerToken: 'ghp_rev' };
    const fp = forgeTokenFingerprint(s);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(forgeTokenFingerprint({ ...s })).toBe(fp);
    expect(forgeTokenFingerprint({ ...s, githubReviewerToken: 'other' })).not.toBe(fp);
    expect(fp).not.toContain('ghp_');
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

  describe('authorLoginAliases (issue #284)', () => {
    const createOp = (extra: Record<string, unknown>) => ({
      kind: 'create_pr' as const,
      opKey: opKeys.pr(itemId, 'h2'),
      zoneId: 'main',
      itemId,
      payload: { head: 'agent/issue-77', base: 'main', title: 't', body: 'b', ...extra },
    });

    test.each(['old-bot', 'Old-BOT'])('a listed PR by an alias (%s) is ours', async (author) => {
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author });
      const op = createOp({ adoptPulls: [1], authorLoginAliases: ['old-bot'] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({
        state: 'done',
        result: { number: 1 },
      });
    });

    test('read-back of an unknown op treats a listed PR by an alias as ours', async () => {
      const op = createOp({ adoptPulls: [1], authorLoginAliases: ['OLD-bot'] });
      seed(op, 'unknown', t0);
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'old-bot' });
      expect(await resolveUnknown(db, forges, 'main', t0, 45)).toBe(1);
      expect(getOutbox(db, op.opKey)?.state).toBe('done');
    });

    test('read-back of an unknown op ignores a listed PR by a stranger', async () => {
      const op = createOp({ adoptPulls: [1], authorLoginAliases: ['old-bot'] });
      seed(op, 'unknown', t0);
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'mallory' });
      expect(await resolveUnknown(db, forges, 'main', t0, 45)).toBe(0);
    });

    test('the author login compares case-insensitively', async () => {
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'Author-Bot' });
      const op = createOp({ adoptPulls: [1] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'done' });
    });

    test('an unlisted PR by an alias is not ours', async () => {
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'old-bot' });
      const op = createOp({ authorLoginAliases: ['old-bot'] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({
        state: 'failed',
        error: 'hand-opened PR on agent branch: #1',
      });
    });

    test('a listed PR by a stranger is not ours', async () => {
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'mallory' });
      const op = createOp({ adoptPulls: [1], authorLoginAliases: ['old-bot'] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'failed' });
    });

    test('a queued op without the field trusts the author login alone', async () => {
      f.state.addPull({ headRef: 'agent/issue-77', headSha: 'h2', author: 'old-bot' });
      const op = createOp({ adoptPulls: [1] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'failed' });
    });

    test('the forge create call never receives the aliases', async () => {
      const op = createOp({ adoptPulls: [1], authorLoginAliases: ['old-bot'] });
      expect(await runOp(db, forges, op, new Date())).toMatchObject({ state: 'done' });
      const creates = f.author.calls.filter((c) => c.method === 'findOrCreatePullRequest');
      expect(creates).toHaveLength(1);
      expect(creates[0]?.args[0]).not.toHaveProperty('authorLoginAliases');
      expect(creates[0]?.args[0]).not.toHaveProperty('adoptPulls');
    });
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

describe('comment_issue', () => {
  const MARK = '<!-- jm:comment:main:triage:1 -->';
  const commentOp = (opKey = 'comment:main:triage:1', body = 'Triaged.') => ({
    kind: 'comment_issue' as const,
    opKey,
    zoneId: 'main',
    itemId: null,
    payload: { number: 1, body, marker: MARK },
  });
  beforeEach(() => f.state.addIssue({ number: 1 }));

  test('commentMarker builds the marker and rejects a key outside [a-z0-9:-]{1,80}', () => {
    expect(commentMarker('jm', 'triage:179')).toBe('<!-- jm:comment:jm:triage:179 -->');
    expect(() => commentMarker('jm', 'Bad Key')).toThrow(/key/);
    expect(() => commentMarker('jm', '')).toThrow(/key/);
    expect(() => commentMarker('jm', 'a'.repeat(81))).toThrow(/key/);
    expect(() => commentMarker('jm', 'x -->')).toThrow(/key/);
    expect(commentMarker('jm', 'a'.repeat(80))).toBe(`<!-- jm:comment:jm:${'a'.repeat(80)} -->`);
  });

  test('posts the body with the marker as the author', async () => {
    expect(await runOp(db, forges, commentOp(), t0)).toMatchObject({
      state: 'done',
      result: { id: 1 },
    });
    expect(f.state.comments).toHaveLength(1);
    expect(f.state.comments[0]).toMatchObject({
      issue: 1,
      author: 'author-bot',
      body: `Triaged.\n\n${MARK}`,
    });
  });

  test('the same op applied twice makes one createIssueComment call', async () => {
    await runOp(db, forges, commentOp(), t0);
    expect((await runOp(db, forges, commentOp(), t1)).state).toBe('done');
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(f.state.comments).toHaveLength(1);
  });

  test('two ops with the same marker post one comment', async () => {
    await runOp(db, forges, commentOp('comment:main:a'), t0);
    expect(await runOp(db, forges, commentOp('comment:main:b'), t1)).toMatchObject({
      state: 'done',
      result: { id: 1 },
    });
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(f.state.comments).toHaveLength(1);
  });

  test('a crash after the POST (unknown) is resolved by the marker, never by posting again', async () => {
    f.author.failNext('createIssueComment', '5xx-after-success');
    expect((await runOp(db, forges, commentOp(), t0)).state).toBe('unknown');
    expect(f.state.comments).toHaveLength(1);
    expect((await runOp(db, forges, commentOp(), t1)).state).toBe('done');
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(f.state.comments).toHaveLength(1);
  });

  test('resolveUnknown settles an unknown comment by its marker, with one comment', async () => {
    f.author.failNext('createIssueComment', '5xx-after-success');
    await runOp(db, forges, commentOp(), t0);
    expect(await resolveUnknown(db, forges, 'main', t1, 30)).toBe(1);
    expect(getOutbox(db, 'comment:main:triage:1')?.state).toBe('done');
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(f.state.comments).toHaveLength(1);
  });

  test("another account's comment ending with the marker is not ours: ours is still posted", async () => {
    f.state.comments.push({
      id: 50,
      issue: 1,
      author: 'mallory',
      body: `copied\n\n${MARK}`,
      createdAt: t0.toISOString(),
    });
    expect(await runOp(db, forges, commentOp(), t0)).toMatchObject({ state: 'done' });
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(f.state.comments.filter((c) => c.author === 'author-bot')).toHaveLength(1);
  });

  test('a body over 60000 characters is refused at enqueue, with no forge call and no row', async () => {
    expect(COMMENT_BODY_MAX).toBe(60_000);
    const long = commentOp('comment:main:long', 'x'.repeat(60_001));
    await expect(runOp(db, forges, long, t0)).rejects.toThrow(/60000/);
    expect(getOutbox(db, 'comment:main:long')).toBeUndefined();
    expect([...f.author.calls, ...f.reviewer.calls]).toHaveLength(0);
    const max = commentOp('comment:main:max', 'x'.repeat(60_000));
    expect((await runOp(db, forges, max, t0)).state).toBe('done');
    expect(f.state.comments).toHaveLength(1);
  });

  test('a marker not built by commentMarker is refused at enqueue', async () => {
    const op = { ...commentOp(), payload: { number: 1, body: 'b', marker: 'nope' } };
    await expect(runOp(db, forges, op, t0)).rejects.toThrow(/marker/);
    expect(f.author.calls).toHaveLength(0);
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

describe('unsanitizeForgeText', () => {
  test('undoes sanitizeCrewText in prose and code spans', () => {
    for (const x of [
      'Import @scope/pkg from https://host/path, see www.example.com, #12 and GH-34.',
      'Use `@scope/pkg`, `https://host/path`, `www.example.com`, `#12` and `GH-34` verbatim.',
      '@scope/pkg\nhttps://host/path\nWWW.example.com\n#12\ngh-34\n',
      '```ts\nimport x from "@scope/pkg"; // https://host/path #12 GH-34 www.example.com\n```',
    ]) {
      const sanitized = sanitizeCrewText(x, []);
      expect(sanitized).not.toBe(x);
      expect(unsanitizeForgeText(sanitized)).toBe(x);
    }
  });

  test('undoes sanitizeForgeText too', () => {
    const x = 'cc @org/team at https://a.test and www.b.test';
    expect(unsanitizeForgeText(sanitizeForgeText(x, []))).toBe(x);
  });

  test('keeps every other zero-width joiner, such as an emoji sequence', () => {
    for (const x of [
      '\u{1F468}\u200d\u{1F469}\u200d\u{1F467} family',
      '\u{1F3F3}\u{FE0F}\u200d\u{1F308}',
      'a\u200db @\u200d- #\u200dx gh-\u200dy :\u200d/',
    ]) {
      expect(unsanitizeForgeText(x)).toBe(x);
    }
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

describe('the label op (Task 8)', () => {
  const labelOp = (key = 'create_labels:main:1') => ({
    kind: 'create_labels' as const,
    opKey: key,
    zoneId: 'main',
    itemId: null,
    payload: {
      labels: [
        { name: 'agent-ready', color: '0e8a16', description: 'Ready for an agent' },
        { name: 'agent-retry', color: 'fbca04', description: 'Retry' },
      ],
    },
  });

  test('creates the missing labels as the author, idempotent by name', async () => {
    f.state.labels = ['Agent-Ready'];
    const r = await runOp(db, forges, labelOp(), t1);
    expect(r).toMatchObject({ state: 'done', result: { created: ['agent-retry'] } });
    expect(f.author.calls.filter((c) => c.method === 'createLabel').map((c) => c.args[0])).toEqual([
      'agent-retry',
    ]);
    expect(f.reviewer.calls.filter((c) => c.method === 'createLabel')).toEqual([]);
    // A second request (a new op) finds them all and writes nothing.
    const again = await runOp(db, forges, labelOp('create_labels:main:2'), t1);
    expect(again).toMatchObject({ state: 'done', result: { created: [] } });
    expect(f.author.calls.filter((c) => c.method === 'createLabel')).toHaveLength(1);
  });

  test('the label op works in observe mode with allowInObserve, and is refused when killed', async () => {
    setZoneMode(db, 'main', 'observe', t0);
    f.state.labels = [];
    await expect(runOp(db, forges, labelOp(), t1)).rejects.toThrow(/observe mode/);
    expect(await runOp(db, forges, labelOp(), t1, { allowInObserve: true })).toMatchObject({
      state: 'done',
    });
    setKilled(db, true, t0);
    await expect(
      runOp(db, forges, labelOp('create_labels:main:3'), t1, { allowInObserve: true }),
    ).rejects.toThrow(/kill switch/);
  });

  test('no other outbox op bypasses the observe suppression', async () => {
    setZoneMode(db, 'main', 'observe', t0);
    const crew = {
      kind: 'create_issue' as const,
      opKey: 'issue:main:obj:k',
      zoneId: 'main',
      itemId: null,
      payload: { title: 't', body: 'b', labels: [], since: t0.toISOString() },
    };
    await expect(runOp(db, forges, crew, t1, { allowInObserve: true })).rejects.toThrow(
      /observe mode/,
    );
    expect(f.author.calls.filter((c) => FORGE_WRITES.includes(c.method as never))).toEqual([]);
  });
});

describe('pairFor by credential kind (spec §4.4)', () => {
  const api = 'https://api.github.com';
  const alnum = (n: number) => 'aB3'.repeat(Math.ceil(n / 3)).slice(0, n);
  const authorPat = `ghp_${alnum(36)}`;
  const reviewerPat = `ghp_${alnum(35)}x`;
  const appToken = `ghs_${alnum(36)}`;
  const tokens = { githubAuthorToken: authorPat, githubReviewerToken: reviewerPat };
  const pat = (name: 'githubAuthorToken' | 'githubReviewerToken'): CredentialRef => ({
    kind: 'github-pat',
    name,
  });
  const app = (owner: string): CredentialRef => ({ kind: 'github-app', owner });
  const patRefs = { author: pat('githubAuthorToken'), reviewer: pat('githubReviewerToken') };
  const twoBot = { repo: 'o/r', authorMayBeAdmin: false, identity: 'two-bot' as const };
  const fakeApps = (value = appToken) =>
    vi.fn((_owner: string, _role: AppRole): TokenProvider => ({ token: async () => value }));
  const slugs: Record<AppRole, string> = { author: 'acme-author', reviewer: 'acme-reviewer' };
  const appIdentity = (_owner: string, role: AppRole) => ({ slug: slugs[role], appId: '12345' });

  /** Answers one default-branch read only when it carries `token`. */
  const expectToken = (token: string) =>
    nock(api)
      .matchHeader('authorization', `token ${token}`)
      .get('/repos/o/r')
      .reply(200, { default_branch: 'main' });

  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    expect(nock.pendingMocks()).toEqual([]);
    nock.cleanAll();
  });

  for (const [label, refs] of [
    ['no refs', undefined],
    ['token refs', patRefs],
  ] as const) {
    describe(label, () => {
      test('the author and reviewer forges get the same tokens as before', async () => {
        const pair = pairFor(twoBot, tokens, refs ? { refs } : {});
        expectToken(authorPat);
        expect(await pair.author.getDefaultBranch()).toBe('main');
        expectToken(reviewerPat);
        expect(await pair.reviewer!.getDefaultBranch()).toBe('main');
        expect(pair.merger).toBeUndefined();
      });

      test('authorMayBeAdmin still merges through the reviewer', () => {
        const pair = pairFor({ ...twoBot, authorMayBeAdmin: true }, tokens, refs ? { refs } : {});
        expect(pair.merger).toBe(pair.reviewer);
      });

      test('a two-bot zone with no reviewer token still throws', () => {
        expect(() =>
          pairFor(twoBot, { githubAuthorToken: authorPat }, refs ? { refs } : {}),
        ).toThrow('JM_GITHUB_REVIEWER_TOKEN is required for a two-bot zone');
      });
    });
  }

  test('an app author never gets a merger, and its requests carry the provider token', async () => {
    const appTokens = fakeApps();
    const pair = pairFor({ ...twoBot, authorMayBeAdmin: true }, tokens, {
      refs: { author: app('o'), reviewer: pat('githubReviewerToken') },
      appTokens,
      appIdentity,
    });
    expect(pair.merger).toBeUndefined();
    expect(appTokens).toHaveBeenCalledExactlyOnceWith('o', 'author');
    expectToken(appToken);
    expect(await pair.author.getDefaultBranch()).toBe('main');
    expectToken(reviewerPat);
    expect(await pair.reviewer!.getDefaultBranch()).toBe('main');
  });

  test('an app reviewer needs no reviewer token and uses the provider', async () => {
    const appTokens = fakeApps();
    const pair = pairFor(
      twoBot,
      { githubAuthorToken: authorPat },
      { refs: { author: pat('githubAuthorToken'), reviewer: app('o') }, appTokens, appIdentity },
    );
    expect(appTokens).toHaveBeenCalledExactlyOnceWith('o', 'reviewer');
    expectToken(appToken);
    expect(await pair.reviewer!.getDefaultBranch()).toBe('main');
    expectToken(authorPat);
    expect(await pair.author.getDefaultBranch()).toBe('main');
  });

  test('a starter zone uses the author token whatever the refs say', async () => {
    const appTokens = fakeApps();
    const pair = pairFor(
      { ...twoBot, identity: 'starter' },
      { githubAuthorToken: authorPat },
      { refs: { author: app('o'), reviewer: app('o') }, appTokens, appIdentity },
    );
    expect(pair.reviewer).toBeNull();
    expect(appTokens).not.toHaveBeenCalled();
    expectToken(authorPat);
    expect(await pair.author.getDefaultBranch()).toBe('main');
  });

  test('an app ref without a provider factory names the repository and role, and no secret', () => {
    for (const role of ['author', 'reviewer'] as const) {
      const refs = { ...patRefs, [role]: app('o') };
      let message = '';
      try {
        pairFor(twoBot, tokens, { refs });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('o/r');
      expect(message).toContain(role);
      expect(message).not.toContain(authorPat);
      expect(message).not.toContain(reviewerPat);
    }
  });

  test('a provider that fails with a PEM and a token reaches the caller with neither', async () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const appTokens = vi.fn(
      (): TokenProvider => ({
        token: () => Promise.reject(new Error(`mint failed: ${pem} ${appToken}`)),
      }),
    );
    const pair = pairFor(twoBot, tokens, {
      refs: { author: app('o'), reviewer: app('o') },
      appTokens,
      appIdentity,
    });
    for (const forge of [pair.author, pair.reviewer!]) {
      const err = (await forge.getDefaultBranch().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      const seen = `${err.message}\n${err.stack ?? ''}\n${String(err.cause ?? '')}`;
      expect(seen).not.toContain('PRIVATE KEY');
      expect(seen).not.toContain('MIIEowIBAAKCAQEA');
      expect(seen).not.toContain(appToken);
    }
  });

  test('a provider factory that throws is reported without its message', () => {
    const appTokens = vi.fn((): TokenProvider => {
      throw new Error(`no key: ${appToken}`);
    });
    expect(() =>
      pairFor(twoBot, tokens, { refs: { ...patRefs, author: app('o') }, appTokens, appIdentity }),
    ).toThrow(/author of o\/r/);
    expect(() =>
      pairFor(twoBot, tokens, { refs: { ...patRefs, author: app('o') }, appTokens, appIdentity }),
    ).not.toThrow(appToken);
  });

  describe('the push grant behind a branch update (#292, D1 and D5)', () => {
    const pushToken = `ghs_${alnum(35)}P`;
    const updateOp = () => ({
      kind: 'update_branch' as const,
      opKey: opKeys.updateBranch(itemId, 'aaa', 'base1'),
      zoneId: 'main',
      itemId,
      payload: { pr: 7, headSha: 'aaa', baseSha: 'base1' },
    });
    /** The fake answers every read; the pair's pusher alone makes the write, over HTTP. */
    const withPusher = (pair: ForgePair): ForgePair => ({
      author: f.author,
      reviewer: f.reviewer,
      ...(pair.pusher ? { pusher: pair.pusher } : {}),
    });
    const expectUpdate = (token: string) =>
      nock(api)
        .matchHeader('authorization', `token ${token}`)
        .put('/repos/o/r/pulls/7/update-branch', (b) => b.expected_head_sha === 'aaa')
        .reply(202, { message: 'Updating pull request branch.' });
    beforeEach(() => {
      f.state.addPull({
        number: 7,
        headRef: 'agent/issue-1',
        headSha: 'aaa',
        author: 'author-bot',
      });
    });

    test('PAT mode updates with the author token, the push containers’ grant', async () => {
      const pair = pairFor(twoBot, tokens, { refs: patRefs });
      expectUpdate(authorPat);
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'updated' } });
    });

    test('app mode mints the push use from the author app per update, and revokes it', async () => {
      const revoke = vi.fn(async () => {});
      const source = {
        fresh: vi.fn(async () => ({
          token: pushToken,
          expiresAt: plus(t0, 60 * MIN),
          owner: 'o',
          revoke,
        })),
      };
      const serverAuthor = vi.fn(async () => appToken);
      const pair = pairFor(twoBot, tokens, {
        refs: { author: app('o'), reviewer: pat('githubReviewerToken') },
        appTokens: () => ({ token: serverAuthor }),
        appIdentity,
        pushToken: appPushToken(source, 'main'),
      });
      expectUpdate(pushToken);
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'updated' } });
      // The token source's request: the author app, the push use, this zone.
      expect(source.fresh).toHaveBeenCalledExactlyOnceWith('main', 'author', 'push');
      // That use is contents: write alone, narrowed to the one repository by the mint body.
      expect(USE_PERMISSIONS.push).toEqual({ contents: 'write' });
      expect(revoke).toHaveBeenCalledOnce();
      // The server-author token (wider: pull requests, issues…) was never asked for.
      expect(serverAuthor).not.toHaveBeenCalled();
    });

    test('app mode refuses rather than widens when the mint fails: no request is sent', async () => {
      const source = {
        fresh: vi.fn(async (): Promise<never> => {
          throw new Error(`mint failed: ${appToken}`);
        }),
      };
      const serverAuthor = vi.fn(async () => appToken);
      const pair = pairFor(twoBot, tokens, {
        refs: { author: app('o'), reviewer: pat('githubReviewerToken') },
        appTokens: () => ({ token: serverAuthor }),
        appIdentity,
        pushToken: appPushToken(source, 'main'),
      });
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'no_token' } });
      expect(source.fresh).toHaveBeenCalledOnce();
      expect(serverAuthor).not.toHaveBeenCalled();
      expect(calls('updateBranch')).toEqual([]);
      expect(JSON.stringify(getOutbox(db, updateOp().opKey))).not.toContain(appToken);
    });

    test('an app author with no push token source has no pusher, so no request', async () => {
      const pair = pairFor(twoBot, tokens, {
        refs: { author: app('o'), reviewer: pat('githubReviewerToken') },
        appTokens: fakeApps(),
        appIdentity,
      });
      expect(pair.pusher).toBeUndefined();
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'no_token' } });
    });

    test('a head already off the expected SHA is read back as updated, and not sent', async () => {
      f.state.setHead(7, 'bbb');
      const pair = pairFor(twoBot, tokens, { refs: patRefs });
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'updated' } });
    });

    test('a head moved by an agent push (not holding the base) is read back as head_moved', async () => {
      f.state.setHead(7, 'ccc');
      f.state.compares.set('base1...ccc', {
        aheadBy: 1,
        behindBy: 2,
        baseSha: 'base1',
        mergeBaseSha: 'base0',
      });
      const pair = pairFor(twoBot, tokens, { refs: patRefs });
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r).toEqual({ state: 'done', result: { kind: 'head_moved' } });
      expect(calls('updateBranch')).toEqual([]);
    });

    describe('the live wiring: ForgePairs with pairOptionsFor (main.ts)', () => {
      const entryOf = (role: AppRole, fingerprint = `F-${role}`): AppEntryRead => ({
        entry: {
          appId: role === 'author' ? '100' : '200',
          slug: slugs[role],
          clientId: `Iv1.${role}`,
          pem: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----',
          importedAt: '2026-11-01T00:00:00Z',
        },
        source: 'file',
        fingerprint,
      });
      const missing: AppEntryRead = { source: 'missing' };
      const undecryptable: AppEntryRead = { source: 'missing', undecryptable: true };
      const zone = { ...twoBot, id: 'main' };
      const resolved = {} as Resolved;
      const appsOf = (author: AppEntryRead, reviewer: AppEntryRead): ResolvedApps =>
        new Map([['o', { author, reviewer }]]);
      const appAuthor = appsOf(entryOf('author'), missing);
      const appReviewer = appsOf(missing, entryOf('reviewer'));
      const creds = (apps: ResolvedApps) => ({ resolved, apps });
      const minted = (revoke: () => Promise<void> = async () => {}) => ({
        token: pushToken,
        expiresAt: plus(t0, 60 * MIN),
        owner: 'o',
        revoke,
      });
      const serverToken = vi.fn(async () => appToken);
      const source = (mint: () => Promise<ReturnType<typeof minted>> = async () => minted()) => ({
        fresh: vi.fn(mint),
        provider: vi.fn(
          (_zoneId: string, _role: AppRole, _use: string): TokenProvider => ({
            token: serverToken,
          }),
        ),
        grant: vi.fn((_zoneId: string, _role: AppRole) => async () => ({
          permissions: { contents: 'write', pull_requests: 'write' },
          tokenExpiresAt: null,
        })),
      });
      const identityOf = (forge: unknown) =>
        forge instanceof GitHubForge ? forge.appIdentity() : 'not a GitHubForge';
      beforeEach(() => serverToken.mockClear());

      test('an app-author zone updates with the minted push token, never the author PAT', async () => {
        const revoke = vi.fn(async () => {});
        const src = source(async () => minted(revoke));
        const pair = new ForgePairs().for(
          zone,
          tokens,
          pairOptionsFor(zone, creds(appAuthor), src),
        );
        expectUpdate(pushToken);
        const r = await runOp(db, withPusher(pair), updateOp(), t0);
        expect(r).toEqual({ state: 'done', result: { kind: 'updated' } });
        expect(src.fresh).toHaveBeenCalledExactlyOnceWith('main', 'author', 'push');
        expect(revoke).toHaveBeenCalledOnce();
        expect(serverToken).not.toHaveBeenCalled();
      });

      test('an app-author zone whose mint fails sends nothing: refused, not widened', async () => {
        const src = source(async () => {
          throw new Error('mint failed');
        });
        const pair = new ForgePairs().for(
          zone,
          tokens,
          pairOptionsFor(zone, creds(appAuthor), src),
        );
        const r = await runOp(db, withPusher(pair), updateOp(), t0);
        expect(r).toEqual({ state: 'done', result: { kind: 'no_token' } });
        expect(src.fresh).toHaveBeenCalledOnce();
      });

      test('an app author acts as <slug>[bot] on the server-author token, never the PAT', async () => {
        const src = source();
        const pair = new ForgePairs().for(
          zone,
          tokens,
          pairOptionsFor(zone, creds(appAuthor), src),
        );
        expect(identityOf(pair.author)).toEqual({ slug: 'acme-author', appId: '100' });
        expect(identityOf(pair.reviewer)).toBeNull();
        // No GET /user: nock allows no request, so one would reject.
        expect(await pair.author.viewerLogin()).toBe('acme-author[bot]');
        expect(serverToken).not.toHaveBeenCalled();
        expectToken(appToken);
        expect(await pair.author.getDefaultBranch()).toBe('main');
        expect(src.provider).toHaveBeenCalledExactlyOnceWith('main', 'author', 'server-author');
        expect(src.grant).toHaveBeenCalledExactlyOnceWith('main', 'author');
        // The reviewer stays on its PAT.
        expectToken(reviewerPat);
        expect(await pair.reviewer!.getDefaultBranch()).toBe('main');
      });

      test('an app reviewer acts as <slug>[bot] on the server-reviewer token, never the PAT', async () => {
        const src = source();
        const opts = pairOptionsFor(zone, creds(appReviewer), src);
        // A PAT author pushes with the author PAT, as before.
        expect(opts.authorUsesApp).toBeUndefined();
        const pair = new ForgePairs().for(zone, tokens, opts);
        expect(identityOf(pair.reviewer)).toEqual({ slug: 'acme-reviewer', appId: '200' });
        expect(identityOf(pair.author)).toBeNull();
        expect(await pair.reviewer!.viewerLogin()).toBe('acme-reviewer[bot]');
        expect(serverToken).not.toHaveBeenCalled();
        expectToken(appToken);
        expect(await pair.reviewer!.getDefaultBranch()).toBe('main');
        expect(src.provider).toHaveBeenCalledExactlyOnceWith('main', 'reviewer', 'server-reviewer');
        expect(src.grant).toHaveBeenCalledExactlyOnceWith('main', 'reviewer');
        expectToken(authorPat);
        expect(await pair.author.getDefaultBranch()).toBe('main');
      });

      test('an undecryptable app entry refuses the pair, naming only the repository and role', () => {
        for (const role of ['author', 'reviewer'] as const) {
          const apps =
            role === 'author' ? appsOf(undecryptable, missing) : appsOf(missing, undecryptable);
          const src = source();
          let error: unknown;
          try {
            new ForgePairs().for(zone, tokens, pairOptionsFor(zone, creds(apps), src));
          } catch (e) {
            error = e;
          }
          expect(error).toBeInstanceOf(Error);
          const err = error as Error;
          expect(err.message).toContain('o/r');
          expect(err.message).toContain(role);
          expect(err.cause).toBeUndefined();
          const seen = `${err.message}\n${err.stack ?? ''}`;
          for (const secret of [appToken, pushToken, authorPat, reviewerPat, 'PRIVATE KEY'])
            expect(seen).not.toContain(secret);
          expect(serverToken).not.toHaveBeenCalled();
        }
      });

      test('a PAT-only zone and a starter zone get the push options and key of before', () => {
        const PINNED = '["o/r","two-bot",false,"af14c68180fea0c1"]';
        const src = source();
        for (const apps of [new Map() as ResolvedApps, appsOf(missing, missing)]) {
          const opts = pairOptionsFor(zone, creds(apps), src);
          expect(opts).toEqual(pushOptionsFor(zone, apps, src));
          expect(opts).toEqual({});
          expect(pairKey(zone, tokens, opts)).toBe(PINNED);
        }
        const starter = { ...zone, identity: 'starter' as const };
        const both = appsOf(entryOf('author'), entryOf('reviewer'));
        const opts = pairOptionsFor(starter, creds(both), src);
        expect(opts).toEqual(pushOptionsFor(starter, both, src));
        expect(opts).toEqual({});
        expect(pairKey(starter, tokens, opts)).toBe('["o/r","starter",false,"af14c68180fea0c1"]');
        expect(src.provider).not.toHaveBeenCalled();
      });

      test('a PAT-author zone keeps the author PAT for its branch update', async () => {
        const src = source();
        const pair = new ForgePairs().for(
          zone,
          tokens,
          pairOptionsFor(zone, creds(new Map()), src),
        );
        expectUpdate(authorPat);
        const r = await runOp(db, withPusher(pair), updateOp(), t0);
        expect(r).toEqual({ state: 'done', result: { kind: 'updated' } });
        expect(src.fresh).not.toHaveBeenCalled();
      });

      test('main.ts builds every pair through pairOptionsFor, on the resolved credentials', () => {
        const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
        const calls = main.match(/pairs\.for\([^;]*;/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) expect(call).toMatch(/pairOptionsOf\(zone\)/);
        expect(main).toMatch(
          /pairOptionsFor\(\s*zone,\s*\{ resolved: live\.resolved\(\), apps: live\.resolvedApps\(\) \},\s*appTokens,\s*live\.resolvedGitlabPats\(\),\s*\)/,
        );
        expect(main).not.toMatch(/pushOptionsFor|pairFor\(/);
      });

      test('a role switched between PAT and app, or a changed entry, gets a new pair', () => {
        const pairs = new ForgePairs();
        const src = source();
        const of = (apps: ResolvedApps) =>
          pairs.for(zone, tokens, pairOptionsFor(zone, creds(apps), src));
        const byPat = of(new Map());
        expect(of(new Map())).toBe(byPat);
        const byAuthorApp = of(appAuthor);
        expect(byAuthorApp).not.toBe(byPat);
        expect(identityOf(byAuthorApp.author)).toEqual({ slug: 'acme-author', appId: '100' });
        expect(of(appAuthor)).toBe(byAuthorApp);
        const replaced = of(appsOf(entryOf('author', 'F-new'), missing));
        expect(replaced).not.toBe(byAuthorApp);
        const byReviewerApp = of(appReviewer);
        expect(byReviewerApp).not.toBe(replaced);
        expect(identityOf(byReviewerApp.reviewer)).toEqual({ slug: 'acme-reviewer', appId: '200' });
        expect(of(new Map())).not.toBe(byReviewerApp);
      });
    });

    test('any error fails the op, so the caller may send it again', async () => {
      const pair = pairFor(twoBot, tokens, { refs: patRefs });
      nock(api).put('/repos/o/r/pulls/7/update-branch').reply(502, { message: 'Bad Gateway' });
      const r = await runOp(db, withPusher(pair), updateOp(), t0);
      expect(r.state).toBe('failed');
    });
  });

  describe('app identity (spec §4.3)', () => {
    const identityOf = (forge: unknown) =>
      forge instanceof GitHubForge ? forge.appIdentity() : 'not a GitHubForge';

    test('an app author gets its identity, and a PAT reviewer none', () => {
      const identities = vi.fn(appIdentity);
      const pair = pairFor(twoBot, tokens, {
        refs: { author: app('o'), reviewer: pat('githubReviewerToken') },
        appTokens: fakeApps(),
        appIdentity: identities,
      });
      expect(identities).toHaveBeenCalledExactlyOnceWith('o', 'author');
      expect(identityOf(pair.author)).toEqual({ slug: 'acme-author', appId: '12345' });
      expect(identityOf(pair.reviewer)).toBeNull();
    });

    test('an app reviewer gets its own identity, and a PAT author none', async () => {
      const pair = pairFor(twoBot, tokens, {
        refs: { author: pat('githubAuthorToken'), reviewer: app('o') },
        appTokens: fakeApps(),
        appIdentity,
      });
      expect(identityOf(pair.author)).toBeNull();
      expect(identityOf(pair.reviewer)).toEqual({ slug: 'acme-reviewer', appId: '12345' });
      expect(await pair.reviewer!.viewerLogin()).toBe('acme-reviewer[bot]');
    });

    test('token refs, no refs and a starter zone build forges with no identity', () => {
      const identities = vi.fn(appIdentity);
      const opts = { appTokens: fakeApps(), appIdentity: identities };
      for (const pair of [
        pairFor(twoBot, tokens, opts),
        pairFor(twoBot, tokens, { ...opts, refs: patRefs }),
        pairFor({ ...twoBot, identity: 'starter' }, tokens, {
          ...opts,
          refs: { author: app('o'), reviewer: app('o') },
        }),
      ]) {
        expect(identityOf(pair.author)).toBeNull();
        if (pair.reviewer) expect(identityOf(pair.reviewer)).toBeNull();
      }
      expect(identities).not.toHaveBeenCalled();
    });

    const failureOf = (fn: () => unknown): Error => {
      try {
        fn();
      } catch (err) {
        return err as Error;
      }
      throw new Error('expected a throw');
    };

    test('an app ref with no appIdentity is refused with a fixed message', () => {
      for (const role of ['author', 'reviewer'] as const) {
        const err = failureOf(() =>
          pairFor(twoBot, tokens, {
            refs: { ...patRefs, [role]: app('o') },
            appTokens: fakeApps(),
          }),
        );
        expect(err.message).toContain(role);
        expect(err.message).toContain('o/r');
        expect(err.cause).toBeUndefined();
      }
    });

    test('an appIdentity that throws is reported without its error, key or token', () => {
      const pem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
      const ghp = `ghp_${alnum(36)}`;
      for (const role of ['author', 'reviewer'] as const) {
        const err = failureOf(() =>
          pairFor(twoBot, tokens, {
            refs: { ...patRefs, [role]: app('o') },
            appTokens: fakeApps(),
            appIdentity: () => {
              throw new Error(`bad entry ${ghp} ${pem}`);
            },
          }),
        );
        expect(err.message).toContain(role);
        expect(err.message).toContain('o/r');
        const seen = `${err.message}\n${err.stack ?? ''}`;
        for (const secret of [ghp, 'PRIVATE KEY', 'MIIEowIBAAKCAQEA', 'bad entry'])
          expect(seen).not.toContain(secret);
        expect(err.cause).toBeUndefined();
      }
    });

    test('an app ref with appGrant builds a forge whose repoAccess reads that grant', async () => {
      const grants = vi.fn((_owner: string, _role: AppRole) => async () => ({
        permissions: { contents: 'write', pull_requests: 'write' },
        tokenExpiresAt: '2026-12-01T10:00:00.000Z',
      }));
      const pair = pairFor(twoBot, tokens, {
        refs: { author: app('o'), reviewer: app('o') },
        appTokens: fakeApps(),
        appIdentity,
        appGrant: grants,
      });
      expect(grants).toHaveBeenCalledWith('o', 'author');
      expect(grants).toHaveBeenCalledWith('o', 'reviewer');
      nock(api)
        .get('/repos/o/r')
        .reply(200, {
          private: true,
          default_branch: 'main',
          permissions: { admin: false, maintain: false, push: false, triage: false, pull: false },
        });
      expect(await pair.author.repoAccess()).toEqual({
        private: true,
        defaultBranch: 'main',
        permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        scopes: null,
        tokenExpiresAt: '2026-12-01T10:00:00.000Z',
        ownerType: 'User',
        grantedPermissions: { contents: 'write', pull_requests: 'write' },
      });
    });

    test('an appGrant factory that throws is reported without its error, and keeps no cause', () => {
      const ghp = `ghp_${alnum(36)}`;
      for (const role of ['author', 'reviewer'] as const) {
        const err = failureOf(() =>
          pairFor(twoBot, tokens, {
            refs: { ...patRefs, [role]: app('o') },
            appTokens: fakeApps(),
            appIdentity,
            appGrant: () => {
              throw new Error(`bad grant ${ghp}`);
            },
          }),
        );
        expect(err.message).toContain(role);
        expect(err.message).toContain('o/r');
        const seen = `${err.message}\n${err.stack ?? ''}`;
        for (const secret of [ghp, 'bad grant']) expect(seen).not.toContain(secret);
        expect(err.cause).toBeUndefined();
      }
    });

    test('the repository in the message is redacted', () => {
      const ghp = `ghp_${alnum(36)}`;
      const err = failureOf(() =>
        pairFor({ ...twoBot, repo: `o/${ghp}` }, tokens, {
          refs: { ...patRefs, author: app('o') },
          appTokens: fakeApps(),
        }),
      );
      expect(err.message).not.toContain(ghp);
    });
  });

  describe('the pair cache', () => {
    const zone = { ...twoBot, id: 'main' };
    const credentials = { resolved: {} as Resolved, apps: new Map() as ResolvedApps };

    test('the same refs return the same pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const refs = { author: app('o'), reviewer: pat('githubReviewerToken') };
      const first = pairs.for(zone, tokens, { refs, appTokens, appIdentity, credentials });
      expect(
        pairs.for(
          { ...zone },
          { ...tokens },
          { refs: { ...refs }, appTokens, appIdentity, credentials },
        ),
      ).toBe(first);
      expect(appTokens).toHaveBeenCalledOnce();
    });

    test('token refs keep the pair built with no refs (today’s key)', () => {
      const pairs = new ForgePairs();
      const first = pairs.for(zone, tokens);
      expect(pairs.for(zone, tokens, { refs: patRefs })).toBe(first);
    });

    test('author token to app, and back, gives a new pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const byToken = pairs.for(zone, tokens, {
        refs: patRefs,
        appTokens,
        appIdentity,
        credentials,
      });
      const byApp = pairs.for(zone, tokens, {
        refs: { ...patRefs, author: app('o') },
        appTokens,
        appIdentity,
        credentials,
      });
      expect(byApp).not.toBe(byToken);
      expect(
        pairs.for(zone, tokens, { refs: patRefs, appTokens, appIdentity, credentials }),
      ).not.toBe(byApp);
    });

    test('reviewer token to app gives a new pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const byToken = pairs.for(zone, tokens, {
        refs: patRefs,
        appTokens,
        appIdentity,
        credentials,
      });
      const byApp = pairs.for(zone, tokens, {
        refs: { ...patRefs, reviewer: app('o') },
        appTokens,
        appIdentity,
        credentials,
      });
      expect(byApp).not.toBe(byToken);
    });

    test('app owner A to app owner B gives a new pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const a = pairs.for(zone, tokens, {
        refs: { ...patRefs, author: app('a') },
        appTokens,
        appIdentity,
        credentials,
      });
      const b = pairs.for(zone, tokens, {
        refs: { ...patRefs, author: app('b') },
        appTokens,
        appIdentity,
        credentials,
      });
      expect(b).not.toBe(a);
      expect(appTokens).toHaveBeenLastCalledWith('b', 'author');
    });

    // Issue #266: the key carries each app role's entry fingerprint and recorded ids.
    const entryRead = (fingerprint: string): AppEntryRead =>
      ({ source: 'file', fingerprint, entry: {} }) as unknown as AppEntryRead;
    const appsWith = (fingerprint: string): ResolvedApps =>
      new Map([['o', { author: entryRead(fingerprint), reviewer: entryRead('R1') }]]);
    const resolved = {} as Resolved;
    const appZone = {
      ...zone,
      githubApp: { repositoryId: 42, installations: { author: 7, reviewer: 9 } },
    };
    const appRefs = { ...patRefs, author: app('o') };

    test('PAT-mode keys are byte-identical to the key before issue #266 (PR 146)', () => {
      const PINNED = '["o/r","two-bot",false,"af14c68180fea0c1"]';
      expect(pairKey(zone, tokens)).toBe(PINNED);
      expect(pairKey(zone, tokens, { refs: patRefs })).toBe(PINNED);
      expect(
        pairKey(appZone, tokens, {
          refs: patRefs,
          credentials: { resolved, apps: appsWith('F1') },
        }),
      ).toBe(PINNED);
      expect(pairKey({ ...zone, authorMayBeAdmin: true }, tokens)).toBe(
        '["o/r","two-bot",true,"af14c68180fea0c1"]',
      );
    });

    test('a replaced app entry (new fingerprint) gives a new pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const opts = (fp: string) => ({
        refs: appRefs,
        appTokens,
        appIdentity,
        credentials: { resolved, apps: appsWith(fp) },
      });
      const first = pairs.for(appZone, tokens, opts('F1'));
      expect(pairs.for(appZone, tokens, opts('F1'))).toBe(first);
      expect(pairs.for(appZone, tokens, opts('F2'))).not.toBe(first);
      expect(pairKey(appZone, tokens, opts('F1'))).not.toBe(pairKey(appZone, tokens, opts('F2')));
    });

    test('a changed installation or repository id gives a new pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const opts = {
        refs: appRefs,
        appTokens,
        appIdentity,
        credentials: { resolved, apps: appsWith('F1') },
      };
      const first = pairs.for(appZone, tokens, opts);
      const installation = {
        ...appZone,
        githubApp: { repositoryId: 42, installations: { author: 8, reviewer: 9 } },
      };
      const second = pairs.for(installation, tokens, opts);
      expect(second).not.toBe(first);
      const repository = {
        ...appZone,
        githubApp: { repositoryId: 43, installations: { author: 8, reviewer: 9 } },
      };
      expect(pairs.for(repository, tokens, opts)).not.toBe(second);
    });

    test('app refs without the resolved credentials are refused, naming no secret', () => {
      const pairs = new ForgePairs();
      expect(() => pairs.for(appZone, tokens, { refs: appRefs, appTokens: fakeApps() })).toThrow(
        /resolved credentials/,
      );
    });

    test('a config revision that changes nothing keeps the pair', () => {
      const pairs = new ForgePairs();
      const appTokens = fakeApps();
      const refs = { author: app('o'), reviewer: app('o') };
      const first = pairs.for(zone, tokens, { refs, appTokens, appIdentity, credentials });
      const revised = structuredClone({ zone, tokens, refs });
      expect(
        pairs.for(revised.zone, revised.tokens, {
          refs: revised.refs,
          appTokens,
          appIdentity,
          credentials,
        }),
      ).toBe(first);
    });
  });
});

describe('a GitLab zone without gitlabTokens gets no forge pair (issue #667)', () => {
  const alnum = (n: number) => 'aB3'.repeat(Math.ceil(n / 3)).slice(0, n);
  const tokens = {
    githubAuthorToken: `ghp_${alnum(36)}`,
    githubReviewerToken: `ghp_${alnum(35)}x`,
  };
  const gitlab = {
    id: 'lab',
    repo: 'acme/app',
    authorMayBeAdmin: false,
    identity: 'two-bot' as const,
    forge: 'gitlab' as const,
  };
  const github = { ...gitlab, id: 'hub', repo: 'o/r', forge: undefined };

  beforeAll(() => {
    nock.disableNetConnect();
  });
  afterEach(() => {
    nock.cleanAll();
  });

  test('pairFor throws the fixed message before it builds a forge or asks for app tokens', () => {
    const appTokens = vi.fn();
    const appIdentity = vi.fn();
    const refs = {
      author: { kind: 'github-app', owner: 'acme' },
      reviewer: { kind: 'github-app', owner: 'acme' },
    } as const;
    for (const zone of [gitlab, { ...gitlab, identity: 'starter' as const }]) {
      let thrown: unknown;
      try {
        pairFor(zone, tokens, { refs, appTokens, appIdentity });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('GitLab zones are not supported yet');
      expect(JSON.stringify(thrown)).not.toContain('acme');
    }
    expect(appTokens).not.toHaveBeenCalled();
    expect(appIdentity).not.toHaveBeenCalled();
    // No interceptor for api.github.com and the network is shut: none was attempted.
    expect(nock.pendingMocks()).toEqual([]);
  });

  test('ForgePairs.for throws for the GitLab zone and caches nothing; a GitHub zone still gets its pair', () => {
    const pairs = new ForgePairs();
    expect(() => pairs.for(gitlab, tokens)).toThrow('GitLab zones are not supported yet');
    expect(() => pairs.for(gitlab, tokens)).toThrow('GitLab zones are not supported yet');
    expect(pairs.for(github, tokens).author).toBeInstanceOf(GitHubForge);
  });

  test("a GitHub zone's key is unchanged by forge: github; a GitLab zone's differs", () => {
    const PINNED = `["o/r","two-bot",false,"${JSON.parse(pairKey(github, tokens))[3]}"]`;
    expect(pairKey({ ...github, forge: 'github' as const }, tokens)).toBe(PINNED);
    expect(pairKey(github, tokens)).toBe(PINNED);
    expect(pairKey({ ...gitlab, repo: 'o/r' }, tokens)).not.toBe(PINNED);
  });
});

describe('resend after a clean read-back (issue #787)', () => {
  const head = 'agent/issue-1';
  const writes = () =>
    [...f.author.calls, ...f.reviewer.calls].filter((c) =>
      (FORGE_WRITES as readonly string[]).includes(c.method),
    );
  const at = (minutes: number) => plus(t0, minutes * MIN);
  const pass = (minutes: number) => resolveUnknown(db, forges, 'main', at(minutes), 45);

  /** A create_pr whose connection drops: the row is `unknown`, and GitHub has no PR. */
  async function droppedPr(): Promise<string> {
    f.state.branches.set(head, 'h1');
    f.author.failNext('findOrCreatePullRequest', 'throw');
    expect((await runOp(db, forges, prOp(), t0)).state).toBe('unknown');
    return prOp().opKey;
  }

  beforeEach(() => setZoneMode(db, 'main', 'active', t0));

  test('a dropped create_pr is sent again 2 minutes later, and the PR opens', async () => {
    const key = await droppedPr();
    expect(await pass(1)).toBe(0);
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
    expect(await pass(2)).toBe(1);
    expect(calls('findOrCreatePullRequest')).toHaveLength(2);
    expect(getOutbox(db, key)).toMatchObject({ state: 'done', resends: 1 });
    expect([...f.state.pulls.values()].filter((p) => p.headRef === head)).toHaveLength(1);
  });

  test('a write that landed is read back and never sent twice', async () => {
    f.state.branches.set(head, 'h1');
    f.author.failNext('findOrCreatePullRequest', '5xx-after-success');
    expect((await runOp(db, forges, prOp(), t0)).state).toBe('unknown');
    expect(await pass(2)).toBe(1);
    expect(await pass(4)).toBe(0);
    expect(getOutbox(db, prOp().opKey)).toMatchObject({ state: 'done', resends: 0 });
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
  });

  test('a read-back that fails proves nothing: no send, resends unchanged', async () => {
    const key = await droppedPr();
    f.author.failNext('findOpenPullByHead', 'throw');
    expect(await pass(2)).toBe(0);
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
    expect(getOutbox(db, key)).toMatchObject({ state: 'unknown', resends: 0 });
  });

  test('a forge that always drops gets 3 resends, then the row fails at its deadline', async () => {
    const key = await droppedPr();
    for (let i = 0; i < 10; i++) f.author.failNext('findOrCreatePullRequest', 'throw');
    for (let m = 2; m <= 44; m += 2) await pass(m);
    expect(calls('findOrCreatePullRequest')).toHaveLength(4);
    expect(getOutbox(db, key)).toMatchObject({ state: 'unknown', resends: 3 });
    await pass(46);
    expect(getOutbox(db, key)).toMatchObject({ state: 'failed', error: 'unresolved after 45 min' });
    expect(calls('findOrCreatePullRequest')).toHaveLength(4);
  });

  test('resends are 2 minutes apart, counted from the last send', async () => {
    const key = await droppedPr();
    f.author.failNext('findOrCreatePullRequest', 'throw');
    await pass(2);
    expect(getOutbox(db, key)).toMatchObject({ state: 'unknown', resends: 1 });
    await pass(3);
    expect(calls('findOrCreatePullRequest')).toHaveLength(2);
    await pass(4);
    expect(calls('findOrCreatePullRequest')).toHaveLength(3);
    expect(getOutbox(db, key)?.state).toBe('done');
  });

  describe('every kind', () => {
    type Case = [OutboxRow['kind'], boolean, unknown, () => void];
    const cases: Case[] = [
      [
        'create_pr',
        true,
        { head, base: 'main', title: 't', body: 'b' },
        () => {
          f.state.branches.set(head, 'h1');
        },
      ],
      [
        'merge',
        true,
        { pr: 1, sha: 'h1', title: 't', message: 'm' },
        () => {
          f.state.addPull({ headRef: head, headSha: 'h1', author: 'author-bot' });
        },
      ],
      [
        'set_labels',
        true,
        { number: 5, add: ['x'], remove: [] },
        () => {
          f.state.addIssue({ number: 5 });
        },
      ],
      ['update_issue', true, { number: 5, body: 'new' }, () => f.state.addIssue({ number: 5 })],
      [
        'create_labels',
        true,
        { labels: [{ name: 'jm-new', color: 'ffffff', description: 'd' }] },
        () => {},
      ],
      [
        'add_blocked_by',
        true,
        { issue: 5, blocker: 6, repo: 'octo/demo' },
        () => {
          f.state.addIssue({ number: 5 });
          f.state.addIssue({ number: 6 });
        },
      ],
      [
        'create_issue',
        false,
        { title: 't', body: 'b', labels: [], since: t0.toISOString() },
        () => {},
      ],
      [
        'comment_issue',
        false,
        { number: 5, body: 'b', marker: commentMarker('main', 'k') },
        () => f.state.addIssue({ number: 5 }),
      ],
      [
        'post_review',
        false,
        { pr: 1, event: 'APPROVE', body: 'b', commitId: 'h1' },
        () => {
          f.state.addPull({ headRef: head, headSha: 'h1', author: 'author-bot' });
        },
      ],
      [
        'update_branch',
        false,
        { pr: 1, headSha: 'h1', baseSha: 'b1' },
        () => {
          f.state.addPull({ headRef: head, headSha: 'h1', author: 'author-bot' });
        },
      ],
    ];

    test.each(cases)('%s: resent %s', async (kind, resent, payload, arrange) => {
      arrange();
      const opKey = kind === 'create_pr' ? opKeys.pr(itemId, 'h1') : `${kind}:test`;
      insertOutbox(db, {
        id: `seed-${kind}`,
        opKey,
        kind,
        workItemId: itemId,
        zoneId: 'main',
        payloadJson: JSON.stringify(payload),
        state: 'unknown',
        createdAt: t0.toISOString(),
      });
      await pass(2);
      expect(writes().length > 0).toBe(resent);
      expect(getOutbox(db, opKey)).toMatchObject({
        resends: resent ? 1 : 0,
        state: resent ? 'done' : 'unknown',
      });
    });
  });

  test('create_pr is not resent when the branch head moved off the key sha', async () => {
    const key = await droppedPr();
    f.state.branches.set(head, 'h2');
    await pass(2);
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
    expect(getOutbox(db, key)).toMatchObject({ state: 'unknown', resends: 0 });
  });

  test.each([
    ['the kill switch', () => setKilled(db, true, t0)],
    ['a paused zone', () => setZoneMode(db, 'main', 'paused', t0)],
    ['an observing zone', () => setZoneMode(db, 'main', 'observe', t0)],
  ])('%s holds every resend', async (_name, hold) => {
    const key = await droppedPr();
    hold();
    await pass(2);
    expect(calls('findOrCreatePullRequest')).toHaveLength(1);
    expect(getOutbox(db, key)).toMatchObject({ state: 'unknown', resends: 0 });
  });

  test('two passes at once send once', async () => {
    const key = await droppedPr();
    await Promise.all([pass(2), pass(2)]);
    expect(calls('findOrCreatePullRequest')).toHaveLength(2);
    expect(getOutbox(db, key)).toMatchObject({ state: 'done', resends: 1 });
  });

  test('a resend the forge refuses (422) fails, as today', async () => {
    const key = await droppedPr();
    f.author.failNext('findOrCreatePullRequest', { status: 422, message: 'Validation Failed' });
    expect(await pass(2)).toBe(0);
    expect(getOutbox(db, key)).toMatchObject({ state: 'failed', resends: 1 });
  });

  test('the migration reads existing outbox rows as resent 0 times', () => {
    const file = tmpDbFile();
    const raw = new Database(file);
    // A scratch file: skip the fsync per statement, which made 62 migrations outrun the timeout
    // under a full parallel run. The migrated open below is the code under test and is untouched.
    raw.pragma('synchronous = OFF');
    raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.version <= 62)) {
      raw.exec(m.sql);
      m.after?.(raw as unknown as Db);
      raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
    }
    raw.exec(
      `INSERT INTO outbox (id, op_key, kind, zone_id, payload_json, state, created_at, updated_at)
       VALUES ('o1', 'merge:9:h1', 'merge', 'main', '{}', 'unknown', 'a', 'a')`,
    );
    raw.close();
    const migrated = openDb(file);
    expect(getOutbox(migrated, 'merge:9:h1')?.resends).toBe(0);
    migrated.close();
  });
});

describe('resend a lost issue filing or review after three clean reads (issue #900)', () => {
  const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
  const pass = (minutes: number) => resolveUnknown(db, forges, 'main', at(minutes), 45);
  const passes = async (...minutes: number[]) => {
    for (const m of minutes) await pass(m);
  };
  const issueKey = opKeys.issue('main', 'obj', 'k');
  const issueOp = () => ({
    kind: 'create_issue' as const,
    opKey: issueKey,
    zoneId: 'main',
    itemId: null,
    payload: {
      title: 'Crew issue',
      body: 'Do it.',
      labels: ['agent-ready'],
      since: t0.toISOString(),
    },
  });
  const marker = opMarker(issueKey);
  /** An issue carrying `body`'s last line, by `author`, as a late first write would appear. */
  const lateIssue = (body = `Do it.\n\n${marker}`, author = 'author-bot'): number => {
    const n = Math.max(0, ...f.state.issues.keys(), ...f.state.pulls.keys()) + 1;
    f.state.addIssue({
      number: n,
      body,
      author,
      labels: ['agent-ready'],
      createdAt: at(0).toISOString(),
    });
    return n;
  };
  const issuesWithMarker = () =>
    [...f.state.issues].filter(([, e]) => e.issue?.body.endsWith(marker)).map(([n]) => n);

  /** A create_issue whose answer is lost to a 503: the row is `unknown`, GitHub has no issue. */
  async function lostIssue(): Promise<void> {
    f.author.failNext('createIssue', { status: 503 });
    expect((await runOp(db, forges, issueOp(), t0)).state).toBe('unknown');
  }
  /** A post_review whose answer is lost to a 503, on open PR #1 at h1. */
  async function lostReview(): Promise<void> {
    f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
    f.reviewer.failNext('createReview', { status: 503 });
    expect((await runOp(db, forges, reviewOp(), t0)).state).toBe('unknown');
  }

  beforeEach(() => setZoneMode(db, 'main', 'active', t0));
  afterEach(() => vi.restoreAllMocks());

  describe.each([
    ['create_issue', lostIssue, 'createIssue', 'findIssueByMarker', () => issueKey],
    ['post_review', lostReview, 'createReview', 'findReviewByMarker', () => reviewOp().opKey],
  ] as const)('%s', (_kind, lose, send, read, key) => {
    test('a 503, the forge well again after 3 minutes: sent again at minute 5', async () => {
      await lose();
      f.author.failNext(read, { status: 503 });
      f.reviewer.failNext(read, { status: 503 });
      await passes(2, 3, 4);
      expect(calls(send)).toHaveLength(1);
      expect(await pass(5)).toBe(1);
      expect(calls(send)).toHaveLength(2);
      expect(getOutbox(db, key())).toMatchObject({ state: 'done', resends: 1 });
    });

    test('a first write that landed is found by the first read, and nothing is resent', async () => {
      f.author.failNext('createIssue', '5xx-after-success');
      f.state.addPull({ headRef: 'agent/issue-1', headSha: 'h1', author: 'author-bot' });
      f.reviewer.failNext('createReview', '5xx-after-success');
      const op = _kind === 'create_issue' ? issueOp() : reviewOp();
      expect((await runOp(db, forges, op, t0)).state).toBe('unknown');
      expect(await pass(2)).toBe(1);
      await passes(3, 4, 5);
      expect(calls(send)).toHaveLength(1);
      expect(getOutbox(db, key())).toMatchObject({ state: 'done', resends: 0 });
    });

    test('two clean reads, a failed one, then two clean: no send; a third clean: sent', async () => {
      await lose();
      await passes(2, 3);
      f.author.failNext(read, 'throw');
      f.reviewer.failNext(read, 'throw');
      await passes(4, 5, 6);
      expect(calls(send)).toHaveLength(1);
      expect(getOutbox(db, key())).toMatchObject({ state: 'unknown', resends: 0 });
      await pass(7);
      expect(calls(send)).toHaveLength(2);
      expect(getOutbox(db, key())).toMatchObject({ state: 'done', resends: 1 });
    });

    test('reads 30 seconds apart count once', async () => {
      await lose();
      await passes(2, 2.5, 3, 3.5);
      expect(calls(send)).toHaveLength(1);
      await pass(4);
      expect(calls(send)).toHaveLength(2);
    });

    test('reads before 2 minutes after the last send do not count', async () => {
      await lose();
      await passes(1, 1.5, 2, 3);
      expect(calls(send)).toHaveLength(1);
      await pass(4);
      expect(calls(send)).toHaveLength(2);
    });

    test('two resends that fail: at most 2, then failed at the deadline as today', async () => {
      await lose();
      for (let i = 0; i < 10; i++) {
        f.author.failNext(send, 'throw');
        f.reviewer.failNext(send, 'throw');
      }
      for (let m = 2; m <= 44; m++) await pass(m);
      expect(calls(send)).toHaveLength(3);
      expect(getOutbox(db, key())).toMatchObject({ state: 'unknown', resends: 2 });
      await pass(46);
      expect(getOutbox(db, key())).toMatchObject({
        state: 'failed',
        error: 'unresolved after 45 min',
      });
      expect(calls(send)).toHaveLength(3);
    });

    test.each([
      ['the kill switch', () => setKilled(db, true, t0)],
      ['a paused zone', () => setZoneMode(db, 'main', 'paused', t0)],
      ['an observing zone', () => setZoneMode(db, 'main', 'observe', t0)],
    ])('%s: nothing is sent', async (_name, hold) => {
      await lose();
      hold();
      await passes(2, 3, 4, 5, 6);
      expect(calls(send)).toHaveLength(1);
      expect(getOutbox(db, key())).toMatchObject({ state: 'unknown', resends: 0 });
    });

    test('two passes at once send once', async () => {
      await lose();
      await passes(2, 3);
      await Promise.all([pass(4), pass(4)]);
      expect(calls(send)).toHaveLength(2);
      expect(getOutbox(db, key())).toMatchObject({ state: 'done', resends: 1 });
    });
  });

  test('a filing that landed while the search index lagged 2 minutes is found, not resent', async () => {
    await lostIssue();
    await pass(2);
    lateIssue();
    await passes(3, 4, 5);
    expect(calls('createIssue')).toHaveLength(1);
    expect(getOutbox(db, issueKey)).toMatchObject({ state: 'done', resends: 0 });
    expect(issuesWithMarker()).toHaveLength(1);
  });

  test('the wide search finds it on the third read: done, no send', async () => {
    await lostIssue();
    // Updated (by the forge's clock) before `since`: only the day-wider search sees it.
    const n = lateIssue();
    const e = f.state.issues.get(n);
    if (e) e.updatedAt = plus(t0, -60 * MIN).toISOString();
    await passes(2, 3);
    expect(getOutbox(db, issueKey)?.state).toBe('unknown');
    expect(await pass(4)).toBe(1);
    expect(calls('createIssue')).toHaveLength(1);
    expect(getOutbox(db, issueKey)).toMatchObject({ state: 'done', resends: 0 });
    expect(JSON.parse(getOutbox(db, issueKey)?.resultJson ?? '{}')).toEqual({ number: n });
  });

  test('a wide search that fails on the third read is not clean: the count starts again', async () => {
    await lostIssue();
    await passes(2, 3);
    const real = f.author.findIssueByMarker.bind(f.author);
    let n = 0;
    f.author.findIssueByMarker = async (m, since) => {
      if (++n === 2) throw new Error('fake 502 in the wide search');
      return real(m, since);
    };
    await passes(4, 5, 6);
    expect(calls('createIssue')).toHaveLength(1);
    await pass(7);
    expect(calls('createIssue')).toHaveLength(2);
  });

  test.each([
    ['its head moved', () => f.state.setHead(1, 'h2')],
    ['it closed', () => f.state.close(1)],
  ])('a review is not resent when the PR %s', async (_name, change) => {
    await lostReview();
    change();
    await passes(2, 3, 4, 5, 6, 7);
    expect(calls('createReview')).toHaveLength(1);
    expect(getOutbox(db, reviewOp().opKey)).toMatchObject({ state: 'unknown', resends: 0 });
    await pass(46);
    expect(getOutbox(db, reviewOp().opKey)?.state).toBe('failed');
  });

  test('a comment_issue is never resent', async () => {
    f.state.addIssue({ number: 5 });
    const op = {
      kind: 'comment_issue' as const,
      opKey: 'comment:5',
      zoneId: 'main',
      itemId: null,
      payload: { number: 5, body: 'b', marker: commentMarker('main', 'k') },
    };
    f.author.failNext('createIssueComment', { status: 503 });
    expect((await runOp(db, forges, op, t0)).state).toBe('unknown');
    for (let m = 2; m <= 44; m++) await pass(m);
    expect(calls('createIssueComment')).toHaveLength(1);
    expect(getOutbox(db, op.opKey)).toMatchObject({ state: 'unknown', resends: 0 });
  });

  describe('a duplicate after the resend', () => {
    /** Resent at minute 4 as issue #1. */
    async function resent(): Promise<void> {
      await lostIssue();
      await passes(2, 3, 4);
      expect(getOutbox(db, issueKey)).toMatchObject({ state: 'done', resends: 1 });
      expect(JSON.parse(getOutbox(db, issueKey)?.resultJson ?? '{}')).toMatchObject({ number: 1 });
    }
    const closes = () =>
      calls('updateIssue').filter((c) => (c.args[1] as { state?: string }).state);

    test('the higher number is closed, once, and one line is logged', async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      await resent();
      const dup = lateIssue();
      expect(dup).toBe(2);
      await passes(5, 6, 7, 10);
      expect(f.state.issues.get(2)?.state).toBe('closed');
      expect(f.state.issues.get(1)?.state).toBe('open');
      expect(closes()).toHaveLength(1);
      expect(closes()[0]?.args[0]).toBe(2);
      const lines = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('#2'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/duplicate/);
    });

    test('another issue without the marker is never touched', async () => {
      await resent();
      const other = lateIssue(`Other.\n\n${opMarker(opKeys.issue('main', 'obj', 'other'))}`);
      const human = lateIssue('A human issue.', 'human');
      const forged = lateIssue(`Forged.\n\n${marker}`, 'stranger');
      await passes(5, 6, 7);
      for (const n of [1, other, human, forged]) expect(f.state.issues.get(n)?.state).toBe('open');
      expect(closes()).toHaveLength(0);
    });

    test('after 30 minutes nothing is closed', async () => {
      await resent();
      await pass(20);
      lateIssue();
      await passes(35, 36);
      expect(f.state.issues.get(2)?.state).toBe('open');
      expect(closes()).toHaveLength(0);
    });

    test('a filing never resent is not searched for duplicates', async () => {
      await runOp(db, forges, issueOp(), t0);
      lateIssue();
      await passes(1, 2, 3);
      expect(f.state.issues.get(2)?.state).toBe('open');
      expect(closes()).toHaveLength(0);
    });

    test.each([
      ['the kill switch', () => setKilled(db, true, t0)],
      ['a paused zone', () => setZoneMode(db, 'main', 'paused', t0)],
      ['an observing zone', () => setZoneMode(db, 'main', 'observe', t0)],
    ])('%s: nothing is closed', async (_name, hold) => {
      await resent();
      lateIssue();
      hold();
      await passes(5, 6);
      expect(f.state.issues.get(2)?.state).toBe('open');
      expect(closes()).toHaveLength(0);
    });

    test('a lower-numbered first write is kept: the resent issue is closed, the record moves', async () => {
      insertCrewIssue(db, {
        zoneId: 'main',
        key: 'k',
        source: 'crew-lead',
        objective: 'obj',
        title: 'Crew issue',
        body: 'Do it.',
        priority: null,
        state: 'promoted',
        createdAt: t0.toISOString(),
      });
      await lostIssue();
      // The first write landed as #1, but no search sees it until after the resend files #2.
      const first = lateIssue();
      const e = f.state.issues.get(first);
      if (e) e.updatedAt = plus(t0, -3 * 24 * 60 * MIN).toISOString();
      await passes(2, 3, 4);
      expect(JSON.parse(getOutbox(db, issueKey)?.resultJson ?? '{}')).toMatchObject({ number: 2 });
      expect(getCrewIssueByKey(db, 'main', 'k')?.number).toBe(2);
      if (e) e.updatedAt = at(5).toISOString();
      await passes(5, 6);
      expect(f.state.issues.get(1)?.state).toBe('open');
      expect(f.state.issues.get(2)?.state).toBe('closed');
      expect(closes()).toHaveLength(1);
      expect(getCrewIssueByKey(db, 'main', 'k')?.number).toBe(1);
      expect(JSON.parse(getOutbox(db, issueKey)?.resultJson ?? '{}')).toMatchObject({ number: 1 });
    });

    test('the crew issue keeps the recorded number, and intake never starts the duplicate', async () => {
      insertCrewIssue(db, {
        zoneId: 'main',
        key: 'k',
        source: 'crew-lead',
        objective: 'obj',
        title: 'Crew issue',
        body: 'Do it.',
        priority: null,
        state: 'promoted',
        createdAt: t0.toISOString(),
      });
      await resent();
      expect(getCrewIssueByKey(db, 'main', 'k')?.number).toBe(1);
      lateIssue();
      const zone = makeZone({ crew: { ...makeZone().crew, enabled: true } });
      await syncDropZone(db, forges, zone, at(5));
      expect(listWorkItems(db, 'main').map((w) => w.issueNumber)).not.toContain(2);
      await pass(6);
      expect(f.state.issues.get(2)?.state).toBe('closed');
      expect(getCrewIssueByKey(db, 'main', 'k')?.number).toBe(1);
      await syncDropZone(db, forges, zone, at(7));
      const started = listWorkItems(db, 'main').map((w) => w.issueNumber);
      expect(started).toContain(1);
      expect(started).not.toContain(2);
    });
  });

  test('the migration reads existing outbox rows with no clean reads', () => {
    const file = tmpDbFile();
    const raw = new Database(file);
    raw.pragma('synchronous = OFF');
    raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.version <= 67)) {
      raw.exec(m.sql);
      m.after?.(raw as unknown as Db);
      raw.prepare('INSERT INTO schema_version VALUES (?, ?)').run(m.version, 'x');
    }
    raw.exec(
      `INSERT INTO outbox (id, op_key, kind, zone_id, payload_json, state, created_at, updated_at)
       VALUES ('o1', 'issue:main:o:k', 'create_issue', 'main', '{}', 'unknown', 'a', 'a')`,
    );
    raw.close();
    const migrated = openDb(file);
    expect(getOutbox(migrated, 'issue:main:o:k')).toMatchObject({
      cleanReads: 0,
      cleanReadAt: null,
    });
    migrated.close();
  });
});
