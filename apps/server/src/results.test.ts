import type { DropResult, GateResult, Verdict } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { openDb } from './db/open.js';
import {
  activeDropFor,
  getAttempts,
  getDrop,
  getOutbox,
  getPullRequest,
  insertDrop,
  latestVerdict,
  type NewDrop,
  setAttempts,
  setUsageState,
  setWorkItemState,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
} from './db/repo.js';
import { promptVersions } from './payloads.js';
import { applyResult, type ResultDeps, renderReviewBody } from './results.js';
import { fakeForgePair } from './test/fakes.js';
import { plus, t0, tmpDbFile, workItem } from './test/helpers.js';

const zone: DropZoneConfig = {
  id: 'main',
  repo: 'octo/demo',
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 200,
  models: {},
  budgets: {
    maxHeal: 3,
    maxResolve: 2,
    maxResolveTotal: 6,
    maxResume: 2,
    maxReviewRepeat: 2,
    maxNoChange: 1,
  },
  ciRequired: true,
  ciDeadlineMinutes: 45,
  retryLabel: 'agent-retry',
  mergeMethod: 'squash',
  requireBranchProtection: true,
  protectedPaths: [],
  reviewReadToken: false,
};

const SECRET = 'gh-secret-value';

const gateOk: GateResult = {
  name: 'test',
  exitCode: 0,
  durationMs: 1500,
  timedOut: false,
  outputTail: 'SECRET-TAIL',
};
const gateTimeout: GateResult = {
  name: 'slow | gate',
  exitCode: null,
  durationMs: 60000,
  timedOut: true,
  outputTail: '',
};
const redGate: GateResult = {
  name: 'lint',
  exitCode: 1,
  durationMs: 10,
  timedOut: false,
  outputTail: '',
};

const approve: Verdict = {
  decision: 'approve',
  summary: 'Looks good.',
  findings: [{ severity: 'minor', file: 'src/a.ts', detail: 'nit' }],
};
const approveResult: DropResult = { status: 'completed', verdict: approve, gates: [gateOk] };

type Role = 'implement' | 'review' | 'heal' | 'resolve';

function setup(role: Role = 'implement', drop: Partial<NewDrop> = {}) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'develop', configJson: '{}' });
  const wi = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 7,
    title: 'Add widget',
    body: 'b',
    author: 'a',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  const f = fakeForgePair({ issues: [], trusted: [], defaultBranch: 'develop' });
  if (role === 'implement') {
    setWorkItemState(db, wi.id, 'in_flight', undefined, t0);
  } else {
    f.state.addPull({ headRef: 'agent/issue-7', headSha: 'h1', author: 'author-bot' });
    upsertPullRequest(
      db,
      { workItemId: wi.id, number: 1, headRef: 'agent/issue-7', headSha: 'h1', state: 'open' },
      t0,
    );
    setWorkItemState(db, wi.id, 'pr_open', undefined, t0);
  }
  insertDrop(
    db,
    {
      id: 'd1',
      dropZoneId: 'main',
      workItemId: wi.id,
      role,
      state: 'running',
      ...(role === 'implement' ? {} : { prNumber: 1, headSha: 'h1' }),
      ...drop,
    },
    t0,
  );
  const deps: ResultDeps = {
    forges: { author: f.author, reviewer: f.reviewer },
    zone,
    secrets: [SECRET],
    usageCfg: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    rand: () => 0.5,
  };
  return { db, f, deps };
}

const count = (db: Db, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const seedPaused = (db: Db) => setUsageState(db, { status: 'rejected' }, t0);

/** Finishes the active drop with `result`, as a stick would. */
async function finishActive(db: Db, deps: ResultDeps, result: DropResult, now = t0) {
  const active = activeDropFor(db, 1);
  if (!active) throw new Error('no active drop');
  await applyResult(db, deps, active.id, result, now);
}

describe('applyResult: implement', () => {
  test('completed opens one PR through the outbox, keyed by head', async () => {
    const { db, f, deps } = setup();
    f.state.branches.set('agent/issue-7', 'abc');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'completed', headSha: 'abc', gates: [gateOk, gateTimeout] },
      t0,
    );
    const op = getOutbox(db, 'pr:1:abc');
    expect(op).toMatchObject({ kind: 'create_pr', state: 'done', createdAt: t0.toISOString() });
    const pr = [...f.state.pulls.values()];
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({
      headRef: 'agent/issue-7',
      baseRef: 'develop',
      title: 'Add widget',
    });
    const call = f.author.calls.find((c) => c.method === 'findOrCreatePullRequest');
    const body = (call?.args[0] as { body: string }).body;
    expect(body).toContain('Closes #7');
    expect(body).toContain('| test | 0 | 1.5 |');
    expect(body).toContain('| slow \\| gate | timeout | 60.0 |');
    expect(body).not.toContain('SECRET-TAIL');
    expect(body.trimEnd().split('\n').pop()).toBe('<!-- jm:op:pr:1:abc -->');
    expect(workItem(db, 1)).toMatchObject({ state: 'pr_open', prNumber: 1 });
    expect(getPullRequest(db, 1)).toMatchObject({ number: 1, headSha: 'abc', state: 'open' });
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('create_pr is keyed by head', async () => {
    const { db, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'completed', headSha: 'sha-x', gates: [] }, t0);
    expect(getOutbox(db, 'pr:1:sha-x')).toBeDefined();
    expect(count(db, 'outbox')).toBe(1);
  });

  test('create_pr unknown leaves the item in_flight', async () => {
    const { db, f, deps } = setup();
    f.author.failNext('findOpenPullByHead', 'throw');
    await applyResult(db, deps, 'd1', { status: 'completed', headSha: 'abc', gates: [] }, t0);
    expect(getOutbox(db, 'pr:1:abc')?.state).toBe('unknown');
    expect(workItem(db, 1).state).toBe('in_flight');
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('create_pr failed parks', async () => {
    const { db, f, deps } = setup();
    f.author.failNext('findOrCreatePullRequest', { status: 422, message: 'no commits' });
    await applyResult(db, deps, 'd1', { status: 'completed', headSha: 'abc', gates: [] }, t0);
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'create pr failed: no commits',
    });
  });

  test('completed without headSha is a failure', async () => {
    const { db, f, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'completed', gates: [] }, t0);
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'completed without headSha' });
    expect(getDrop(db, 'd1')?.state).toBe('failed');
    expect(f.author.calls).toHaveLength(0);
  });

  test('interrupted implement charges resume and carries the checkpoint', async () => {
    const { db, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'interrupted', headSha: 'ck1', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
    expect(activeDropFor(db, 1)).toMatchObject({
      role: 'implement',
      state: 'queued',
      headSha: 'ck1',
      chargedKey: 'resume',
      createdAt: t0.toISOString(),
      promptVersion: promptVersions().implement,
      image: 'img',
    });
    expect(getAttempts(db, 1, 'resume').count).toBe(1);
    expect(workItem(db, 1).state).toBe('in_flight');
  });

  test('interrupted without a checkpoint keeps the drop head', async () => {
    const { db, deps } = setup('implement', { headSha: 'old' });
    await applyResult(db, deps, 'd1', { status: 'interrupted', gates: [] }, t0);
    expect(activeDropFor(db, 1)?.headSha).toBe('old');
  });

  test('three interruptions park', async () => {
    const { db, deps } = setup();
    for (const sha of ['c1', 'c2', 'c3']) {
      await finishActive(db, deps, { status: 'interrupted', headSha: sha, gates: [] });
    }
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
    expect(activeDropFor(db, 1)).toBeUndefined();
    expect(getAttempts(db, 1, 'resume').count).toBe(2);
  });

  test('no_changes within budget returns the item to ready, then parks', async () => {
    const { db, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'no_changes', gates: [] }, t0);
    expect(workItem(db, 1).state).toBe('ready');
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
    setWorkItemState(db, 1, 'in_flight', undefined, t0);
    insertDrop(
      db,
      { id: 'd2', dropZoneId: 'main', workItemId: 1, role: 'implement', state: 'running' },
      t0,
    );
    await applyResult(db, deps, 'd2', { status: 'no_changes', gates: [] }, t0);
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'no_changes' });
  });

  test('blocked parks with its reason; the drop succeeds', async () => {
    const { db, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'blocked', reason: 'needs design', gates: [] }, t0);
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'needs design' });
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('failed parks with the reason and fails the drop', async () => {
    const { db, deps } = setup();
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'failed', reason: 'gates failed', gates: [gateOk] },
      t0,
    );
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'gates failed' });
    expect(getDrop(db, 'd1')?.state).toBe('failed');
  });

  test('a terminal drop is a no-op', async () => {
    const { db, deps } = setup('implement', { state: 'cancelled' });
    await applyResult(db, deps, 'd1', { status: 'failed', reason: 'x', gates: [] }, t0);
    expect(workItem(db, 1).state).toBe('in_flight');
    expect(getDrop(db, 'd1')?.state).toBe('cancelled');
  });
});

describe('applyResult: review', () => {
  test('approve stores the verdict and posts an approving review on the drop head', async () => {
    const { db, f, deps } = setup('review');
    await applyResult(db, deps, 'd1', approveResult, t0);
    expect(latestVerdict(db, 1)).toMatchObject({
      id: 'd1',
      headSha: 'h1',
      decision: 'approve',
      forced: false,
      summary: 'Looks good.',
      createdAt: t0.toISOString(),
    });
    expect(getOutbox(db, 'review:1:h1:d1')?.state).toBe('done');
    expect(f.state.reviews).toEqual([
      expect.objectContaining({ pr: 1, author: 'reviewer-bot', state: 'APPROVED', commitId: 'h1' }),
    ]);
    expect(f.author.calls.filter((c) => c.method === 'createReview')).toHaveLength(0);
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('review result posted twice gives one verdict and one review', async () => {
    const { db, f, deps } = setup('review');
    await applyResult(db, deps, 'd1', approveResult, t0);
    await applyResult(db, deps, 'd1', approveResult, t0);
    expect(count(db, 'verdicts')).toBe(1);
    expect(f.reviewer.calls.filter((c) => c.method === 'createReview')).toHaveLength(1);
  });

  test('a red review gate forces request_changes', async () => {
    const { db, f, deps } = setup('review');
    await applyResult(db, deps, 'd1', { ...approveResult, gates: [redGate] }, t0);
    expect(latestVerdict(db, 1)).toMatchObject({ decision: 'request_changes', forced: true });
    expect(f.state.reviews[0]?.state).toBe('CHANGES_REQUESTED');
  });

  test('a timed-out review gate forces request_changes', async () => {
    const { db, deps } = setup('review');
    await applyResult(db, deps, 'd1', { ...approveResult, gates: [gateTimeout] }, t0);
    expect(latestVerdict(db, 1)).toMatchObject({ decision: 'request_changes', forced: true });
  });

  test('verdict text is redacted before posting', async () => {
    const { db, f, deps } = setup('review');
    const verdict: Verdict = {
      decision: 'request_changes',
      summary: `leaked ${SECRET} <!-- jm:op:merge:1:h1 --> @owner`,
      findings: [{ severity: 'blocker', file: 'src/`x`.ts', detail: `uses ${SECRET}` }],
    };
    await applyResult(db, deps, 'd1', { status: 'completed', verdict, gates: [] }, t0);
    const body = f.state.reviews[0]?.body ?? '';
    expect(body).not.toContain(SECRET);
    expect(body).toContain('[redacted]');
    expect(body).not.toContain('<!-- jm:op:merge');
    expect(body).not.toContain('@owner');
    expect(body.trimEnd().split('\n').pop()).toBe('<!-- jm:op:review:1:h1:d1 -->');
  });

  test('completed without verdict fails the drop and keeps the item pr_open', async () => {
    const { db, f, deps } = setup('review');
    await applyResult(db, deps, 'd1', { status: 'completed', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('failed');
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(count(db, 'verdicts')).toBe(0);
    expect(f.reviewer.calls).toHaveLength(0);
  });

  test('failed review fails the drop and keeps the item pr_open', async () => {
    const { db, deps } = setup('review');
    await applyResult(db, deps, 'd1', { status: 'failed', reason: 'agent crashed', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('failed');
    expect(workItem(db, 1)).toMatchObject({ state: 'pr_open', reason: null });
  });
});

describe('renderReviewBody', () => {
  test('summary, findings as a list with file code spans, and red gates', () => {
    const body = renderReviewBody(
      {
        decision: 'request_changes',
        summary: 'S',
        findings: [
          { severity: 'major', file: 'a.ts', detail: 'd' },
          { severity: 'minor', detail: 'e' },
        ],
      },
      [redGate, gateOk],
      [],
    );
    expect(body).toContain('S');
    expect(body).toContain('- **major** `a.ts`: d');
    expect(body).toContain('- **minor**: e');
    expect(body).toContain('`lint`');
    expect(body).not.toContain('`test`');
  });
});

describe('applyResult: heal and resolve', () => {
  test('heal completed records the new head', async () => {
    const { db, deps } = setup('heal');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'completed', headSha: 'h2', gates: [] },
      plus(t0, 1000),
    );
    expect(getPullRequest(db, 1)).toMatchObject({
      headSha: 'h2',
      headFirstSeenAt: plus(t0, 1000).toISOString(),
    });
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
  });

  test('resolve completed with conflicts charges resolve', async () => {
    const { db, deps } = setup('resolve');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'completed', headSha: 'h2', mergeOutcome: 'conflicts', gates: [] },
      t0,
    );
    expect(getAttempts(db, 1, 'resolve').count).toBe(1);
    expect(getPullRequest(db, 1)?.headSha).toBe('h2');
    expect(workItem(db, 1).state).toBe('pr_open');
  });

  test('resolve completed clean is free', async () => {
    const { db, deps } = setup('resolve');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'completed', headSha: 'h2', mergeOutcome: 'clean', gates: [] },
      t0,
    );
    expect(getAttempts(db, 1, 'resolve').count).toBe(0);
  });

  test('resolve conflicts over budget parks', async () => {
    const { db, deps } = setup('resolve');
    setAttempts(db, 1, 'resolve', 2, null);
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'completed', headSha: 'h2', mergeOutcome: 'conflicts', gates: [] },
      t0,
    );
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resolve' });
  });

  test('heal no_changes keeps the item pr_open', async () => {
    const { db, deps } = setup('heal');
    await applyResult(db, deps, 'd1', { status: 'no_changes', gates: [] }, t0);
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
    expect(getPullRequest(db, 1)?.headSha).toBe('h1');
  });

  test('heal interrupted with a checkpoint queues a continuation charged to resume', async () => {
    const { db, deps } = setup('heal', {
      fingerprint: 'fp1',
      inputJson: '{"feedback":{"source":"ci","text":"x"}}',
      chargedKey: 'heal',
    });
    await applyResult(db, deps, 'd1', { status: 'interrupted', headSha: 'ck', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('succeeded');
    expect(activeDropFor(db, 1)).toMatchObject({
      role: 'heal',
      state: 'queued',
      fingerprint: 'fp1',
      prNumber: 1,
      inputJson: '{"feedback":{"source":"ci","text":"x"}}',
      headSha: 'ck',
      chargedKey: 'resume',
      promptVersion: promptVersions().heal,
      createdAt: t0.toISOString(),
    });
    expect(getAttempts(db, 1, 'resume').count).toBe(1);
    expect(workItem(db, 1).state).toBe('pr_open');
  });

  test('heal interrupted with exhausted resume parks', async () => {
    const { db, deps } = setup('heal');
    setAttempts(db, 1, 'resume', 2, null);
    await applyResult(db, deps, 'd1', { status: 'interrupted', headSha: 'ck', gates: [] }, t0);
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
    expect(activeDropFor(db, 1)).toBeUndefined();
  });

  test('heal interrupted without a checkpoint is no_changes', async () => {
    const { db, deps } = setup('heal');
    await applyResult(db, deps, 'd1', { status: 'interrupted', gates: [] }, t0);
    expect(activeDropFor(db, 1)).toBeUndefined();
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getAttempts(db, 1, 'resume').count).toBe(0);
  });

  test('heal head moved leaves the item pr_open', async () => {
    const { db, deps } = setup('heal', { chargedKey: 'heal' });
    setAttempts(db, 1, 'heal', 1, null);
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'failed', reason: 'head moved: h1 -> h9', gates: [] },
      t0,
    );
    expect(getDrop(db, 'd1')?.state).toBe('failed');
    expect(workItem(db, 1).state).toBe('pr_open');
    expect(getAttempts(db, 1, 'heal').count).toBe(1);
  });

  test('resolve stale info leaves the item pr_open', async () => {
    const { db, deps } = setup('resolve');
    await applyResult(db, deps, 'd1', { status: 'failed', reason: 'stale info', gates: [] }, t0);
    expect(workItem(db, 1).state).toBe('pr_open');
  });

  test('a push-guard refusal parks', async () => {
    const { db, deps } = setup('heal');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'failed', reason: 'protected path .github/x.yml', gates: [] },
      t0,
    );
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'protected path .github/x.yml',
    });
    expect(getDrop(db, 'd1')?.state).toBe('failed');
  });

  test('resolve blocked parks with the reason', async () => {
    const { db, deps } = setup('resolve');
    await applyResult(
      db,
      deps,
      'd1',
      { status: 'blocked', reason: 'foreign commit identity', gates: [] },
      t0,
    );
    expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: 'foreign commit identity' });
  });
});

describe('applyResult: rate_limited', () => {
  test('a rate-limited requeue refunds exactly the charged keys', async () => {
    const { db, deps } = setup('resolve', { chargedKey: 'resolve_total', fingerprint: 'fp' });
    seedPaused(db);
    setAttempts(db, 1, 'resolve_total', 1, null);
    await applyResult(db, deps, 'd1', { status: 'rate_limited', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('cancelled');
    expect(getAttempts(db, 1, 'resolve_total').count).toBe(0);
    expect(activeDropFor(db, 1)).toMatchObject({
      role: 'resolve',
      state: 'queued',
      fingerprint: 'fp',
      prNumber: 1,
      headSha: 'h1',
      promptVersion: promptVersions().resolve,
      createdAt: t0.toISOString(),
    });
    expect(getAttempts(db, 1, 'rate_limit').count).toBe(1);
    expect(workItem(db, 1).state).toBe('pr_open');
  });

  test('rate_limited is requeued only while usage is rejected', async () => {
    const { db, deps } = setup();
    await applyResult(db, deps, 'd1', { status: 'rate_limited', gates: [] }, t0);
    expect(getDrop(db, 'd1')?.state).toBe('cancelled');
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'rate limit: requeue refused',
    });
    expect(activeDropFor(db, 1)).toBeUndefined();
  });

  test('a future pausedUntil also counts as paused', async () => {
    const { db, deps } = setup();
    setUsageState(db, { status: 'allowed', pausedUntil: plus(t0, 60_000).toISOString() }, t0);
    await applyResult(db, deps, 'd1', { status: 'rate_limited', headSha: 'ck', gates: [] }, t0);
    expect(activeDropFor(db, 1)).toMatchObject({ role: 'implement', headSha: 'ck' });
    expect(workItem(db, 1).state).toBe('in_flight');
  });

  test('rate_limited stops after three requeues', async () => {
    const { db, deps } = setup();
    seedPaused(db);
    for (let i = 0; i < 4; i++) await finishActive(db, deps, { status: 'rate_limited', gates: [] });
    expect(getAttempts(db, 1, 'rate_limit').count).toBe(3);
    expect(workItem(db, 1)).toMatchObject({
      state: 'parked',
      reason: 'rate limit: requeue refused',
    });
    expect(activeDropFor(db, 1)).toBeUndefined();
  });

  test('a rate-limited probe drop is requeued free', async () => {
    const { db, deps } = setup();
    seedPaused(db);
    setAttempts(db, 1, 'rate_limit', 3, null);
    setUsageState(db, { probeDropId: 'd1' }, t0);
    await applyResult(db, deps, 'd1', { status: 'rate_limited', gates: [] }, t0);
    expect(getAttempts(db, 1, 'rate_limit').count).toBe(3);
    expect(activeDropFor(db, 1)?.role).toBe('implement');
  });
});
