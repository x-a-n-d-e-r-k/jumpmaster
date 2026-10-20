/**
 * Spec §16 failure classes, driven end to end through the harness (server routes, reconcile, the
 * fake forge with both identities). Each test checks the visible end state and the forge call log.
 */
import type { DropResult, GateResult, Verdict } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import {
  activeDropFor,
  getAttempts,
  getUsageState,
  insertOutbox,
  insertVerdict,
  listOutbox,
  setAttempts,
} from '../db/repo.js';
import { expireLeases } from '../leases.js';
import { markPendingUnknown, opKeys } from '../outbox.js';
import { usageCfg } from '../test/fixtures.js';
import { type Harness, harness, toApproved, toPrOpen } from '../test/flowHarness.js';
import { workItem } from '../test/helpers.js';
import { dispatchGate } from '../usage.js';

const gateOk: GateResult = {
  name: 'test',
  exitCode: 0,
  durationMs: 10,
  timedOut: false,
  outputTail: '',
};
const approve: Verdict = { decision: 'approve', summary: 'ok', findings: [] };
const changes: Verdict = {
  decision: 'request_changes',
  summary: 'needs work',
  findings: [{ severity: 'major', file: 'src/a.ts', detail: 'handle the empty case' }],
};
const reviewed = (verdict: Verdict): DropResult => ({
  status: 'completed',
  gates: [gateOk],
  verdict,
});
const implemented = (headSha: string): DropResult => ({
  status: 'completed',
  headSha,
  gates: [gateOk],
});

const issue = (n: number) => ({
  number: n,
  title: `Issue ${n}`,
  body: 'b',
  author: 'human',
  labels: ['agent-ready'],
  createdAt: `2026-01-01T00:00:0${n}.000Z`,
});

const count = (h: Harness, method: string, identity?: 'author' | 'reviewer'): number =>
  [...h.forge.author.calls, ...h.forge.reviewer.calls].filter(
    (c) => c.method === method && (identity === undefined || c.identity === identity),
  ).length;
const item = (h: Harness, id = 1) => workItem(h.db, id);
const requireCi = (h: Harness, checks: string[] = ['ci']): void => {
  for (const id of ['author', 'reviewer'] as const) {
    const r = h.forge.state.rules[id];
    if (r.kind === 'ok') r.rules.requiredChecks = checks;
  }
};

/** Review RC on `sha`, then a heal drop is queued. */
async function toHealQueued(h: Harness, sha: string): Promise<void> {
  await toPrOpen(h, sha);
  await h.reconcile();
  await h.finishDrop('review', reviewed(changes));
  await h.reconcile();
}

describe('§16 outbox and merge', () => {
  test('5xx after a successful merge: exactly one merge; outcome read back', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', '5xx-after-success');
    await h.reconcile();
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    expect(count(h, 'merge')).toBe(1);
    expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('server restart with a pending merge: pending row read back after restart; no second merge', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    // The process died after the forge merged but before the row left `pending`.
    await h.forge.author.merge(1, { sha: 'sha1', title: 'Issue 1', message: 'Closes #1' });
    insertOutbox(h.db, {
      id: 'op-m',
      opKey: opKeys.merge(1, 'sha1'),
      kind: 'merge',
      workItemId: 1,
      payloadJson: JSON.stringify({ pr: 1, sha: 'sha1', title: 'Issue 1', message: 'Closes #1' }),
      state: 'pending',
      createdAt: h.now().toISOString(),
    });
    markPendingUnknown(h.db, h.now());
    await h.reconcile();
    expect(count(h, 'merge')).toBe(1);
    expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('merge rejected (405): parks merge rejected; never re-merges', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', { status: 405, message: 'not mergeable' });
    await h.reconcile();
    await h.reconcile();
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(item(h).reason).toMatch(/^merge rejected/);
    expect(count(h, 'merge')).toBe(1);
  });

  test('outbox never resolves: unknown merge row fails at the deadline, then parks', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', 'throw');
    await h.reconcile();
    expect(listOutbox(h.db, ['unknown'])).toHaveLength(1);
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(item(h).reason).toMatch(/^merge rejected/);
    expect(count(h, 'merge')).toBe(1);
  });

  test('restore from an older backup: adopts unknown PRs; nothing merged twice', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    await h.reconcile();
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    h.forge.state.addPull({
      number: 5,
      headRef: 'agent/issue-1',
      headSha: 'sha9',
      author: 'author-bot',
    });
    h.forge.state.pulls.get(5)!.state = 'closed';
    h.wipeDbKeepIssues();
    for (let i = 0; i < 3; i++) await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(1);
    expect(count(h, 'merge')).toBe(1);
  });
});

describe('§16 drops and results', () => {
  test('partitioned trooper / second lease: stale epoch result rejected; one PR', async () => {
    const h = await harness();
    await h.reconcile();
    const first = await h.lease();
    h.at(10);
    expireLeases(h.db, h.now(), usageCfg, () => 0);
    await h.reconcile();
    const second = await h.lease();
    expect(second.payload.role).toBe('implement');
    expect(second.dropId).not.toBe(first.dropId);
    h.forge.state.branches.set('agent/issue-1', 'sha1');
    expect(await h.postResult(first.dropId, first.epoch, implemented('sha1'))).toBe(409);
    expect(await h.postResult(second.dropId, second.epoch, implemented('sha1'))).toBe(204);
    expect(h.forge.state.pulls.size).toBe(1);
    expect(count(h, 'findOrCreatePullRequest', 'author')).toBe(1);
  });

  test('duplicate result post: one verdict, one review', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    expect(await h.postResult(dropId, epoch, reviewed(approve))).toBe(204);
    await h.postResult(dropId, epoch, reviewed(approve));
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM verdicts').get()).toEqual({ n: 1 });
    expect(count(h, 'createReview', 'reviewer')).toBe(1);
  });

  test('implement ends without a PR: no_changes parks after maxNoChange', async () => {
    const h = await harness();
    for (let i = 0; i <= h.zone.budgets.maxNoChange; i++) {
      await h.reconcile();
      await h.finishDrop('implement', { status: 'no_changes', gates: [] });
    }
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'no_changes' });
    expect(count(h, 'findOrCreatePullRequest')).toBe(0);
  });

  test("Jumpmaster's own comments and reviews never reset or change a fingerprint", async () => {
    const h = await harness();
    h.forge.state.trusted.push('author-bot', 'reviewer-bot');
    await toHealQueued(h, 'sha1');
    const before = getAttempts(h.db, 1, 'heal');
    h.forge.state.review({
      author: 'author-bot',
      state: 'CHANGES_REQUESTED',
      body: 'bot',
      commitId: 'sha1',
    });
    h.forge.state.review({
      author: 'reviewer-bot',
      state: 'COMMENTED',
      body: 'note',
      commitId: 'sha1',
    });
    await h.finishDrop('heal', { status: 'no_changes', gates: [] });
    await h.reconcile();
    const after = getAttempts(h.db, 1, 'heal');
    expect(after.lastFingerprint).toBe(before.lastFingerprint);
    expect(after.count).toBe(before.count + 1);
  });

  test('implement interrupted: resumes with resume:true; three interruptions park', async () => {
    const h = await harness();
    await h.reconcile();
    await h.finishDrop('implement', { status: 'interrupted', headSha: 'ck1', gates: [] });
    const { payload, dropId, epoch } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'ck1' });
    await h.postResult(dropId, epoch, { status: 'interrupted', headSha: 'ck2', gates: [] });
    await h.finishDrop('implement', { status: 'interrupted', headSha: 'ck3', gates: [] });
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resume' });
  });

  test('claim race: one active drop per item under concurrent enqueue', async () => {
    const h = await harness();
    await Promise.all([h.reconcile(), h.reconcile(), h.reconcile()]);
    expect(h.queuedRoles()).toEqual(['implement']);
    await toPrOpen(await harness(), 'x'); // sanity: harness still usable
  });

  test('dead in_flight: create_pr 5xx with no PR: item resumes after the row fails', async () => {
    const h = await harness();
    await h.reconcile();
    h.forge.author.failNext('findOrCreatePullRequest', '5xx');
    await h.finishDrop('implement', implemented('sha1'));
    expect(item(h).state).toBe('in_flight');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    await h.reconcile();
    const { payload } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'sha1' });
  });
});

describe('§16 closed issues', () => {
  test('landed: closed issue with the work on base is done', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.compares.set('main...sha1', {
      aheadBy: 0,
      behindBy: 0,
      baseSha: 'b',
      mergeBaseSha: 'b',
    });
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'done', reason: 'already on base' });
    expect(count(h, 'merge')).toBe(0);
  });

  test('not landed: parks issue closed', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'issue closed' });
  });

  test('conflicted: parks issue closed without a resolve', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.compares.set('main...sha1', {
      aheadBy: 1,
      behindBy: 3,
      baseSha: 'b2',
      mergeBaseSha: 'b',
    });
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'issue closed' });
    expect(h.queuedRoles()).not.toContain('resolve');
  });

  test('branch gone: parks issue closed', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.branches.delete('agent/issue-1');
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'issue closed' });
  });

  test('never blocks dispatch of another ready item', async () => {
    const h = await harness({ issues: [issue(1), issue(2)] });
    await toPrOpen(h, 'sha1');
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h, 1).state).toBe('parked');
    const { payload } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', issue: { number: 2 } });
  });
});

describe('§16 reviews and heals', () => {
  test("stale CHANGES_REQUESTED on an old SHA: one review, then park 'human block stands'; no merge call", async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.review({
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      body: 'no',
      commitId: 'sha1',
    });
    h.forge.state.setHead(1, 'sha2');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['review']);
    await h.finishDrop('review', reviewed(approve));
    await h.reconcile();
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'human block stands' });
    expect(count(h, 'merge')).toBe(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM drops WHERE role = 'review'").get()).toEqual({
      n: 1,
    });
  });

  test('heal that pushes nothing: never reaches approval; parks at maxHeal', async () => {
    const h = await harness();
    await toHealQueued(h, 'sha1');
    for (let i = 0; i < h.zone.budgets.maxHeal + 2 && item(h).state === 'pr_open'; i++) {
      if (h.queuedRoles().includes('heal'))
        await h.finishDrop('heal', { status: 'no_changes', gates: [] });
      await h.reconcile();
    }
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'budget exhausted: heal' });
    expect(count(h, 'merge')).toBe(0);
    const approvals = h.forge.state.reviews.filter((r) => r.state === 'APPROVED');
    expect(approvals).toHaveLength(0);
  });

  test('reviewer blocked SHA X, then the same SHA is approved: never merges', async () => {
    const h = await harness();
    await toHealQueued(h, 'sha1');
    insertVerdict(h.db, {
      id: 'v-late',
      workItemId: 1,
      headSha: 'sha1',
      decision: 'approve',
      forced: false,
      summary: 'ok now',
      findingsJson: '[]',
      gatesJson: '[]',
      createdAt: h.at(1).toISOString(),
    });
    await h.finishDrop('heal', { status: 'no_changes', gates: [] });
    await h.reconcile();
    await h.reconcile();
    expect(count(h, 'merge')).toBe(0);
    expect(h.forge.state.merges).toEqual([]);
  });

  test('head moved under review: re-decided, not parked', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    h.forge.state.setHead(1, 'sha2');
    await h.postResult(dropId, epoch, reviewed(approve));
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['review']);
    expect(count(h, 'merge')).toBe(0);
  });

  test('head moved under heal: re-decided, not parked', async () => {
    const h = await harness();
    await toHealQueued(h, 'sha1');
    h.forge.state.setHead(1, 'sha2');
    await h.finishDrop('heal', {
      status: 'failed',
      reason: 'head moved: expected sha1 got sha2',
      gates: [],
    });
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['review']);
  });

  test('untrusted or bot CHANGES_REQUESTED is ignored', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.state.review({
      author: 'mallory',
      state: 'CHANGES_REQUESTED',
      body: 'x',
      commitId: 'sha1',
    });
    h.forge.state.review({
      author: 'author-bot',
      state: 'CHANGES_REQUESTED',
      body: 'y',
      commitId: 'sha1',
    });
    await h.reconcile();
    await h.reconcile();
    expect(h.forge.state.merges.map((m) => m.sha)).toEqual(['sha1']);
  });

  test('a failed trust lookup waits instead of dropping the block; never merges', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.state.review({
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      body: 'x',
      commitId: 'sha1',
    });
    const real = h.forge.author.isTrusted;
    let down = true;
    h.forge.author.isTrusted = async (login) => {
      if (login === 'alice' && down) throw new Error('fake 502 in isTrusted');
      return real(login);
    };
    await h.reconcile();
    await h.reconcile();
    expect(count(h, 'merge')).toBe(0);
    expect(item(h).state).toBe('pr_open');
    down = false;
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    expect(count(h, 'merge')).toBe(0);
  });
});

describe('§16 hostile PR content', () => {
  const pkg = (test: string, dev: Record<string, string> = { vitest: '^3.0.0' }) =>
    JSON.stringify({ scripts: { test }, devDependencies: dev });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: {} });

  async function withFiles(paths: string[]): Promise<Harness> {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.pullFiles.set(1, { files: paths.map((path) => ({ path })), complete: true });
    return h;
  }

  test('protected path parks', async () => {
    const h = await withFiles(['.github/workflows/ci.yml']);
    await h.reconcile();
    expect(item(h)).toMatchObject({
      state: 'parked',
      reason: 'protected path: .github/workflows/ci.yml',
    });
    expect(h.queuedRoles()).toEqual([]);
  });

  test("rewriting the test script parks 'gate script changed'", async () => {
    const h = await withFiles(['package.json']);
    h.forge.state.files.set('base0:package.json', pkg('vitest run'));
    h.forge.state.files.set('sha1:package.json', pkg('true'));
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'gate script changed: test' });
  });

  test("an npm: alias for the runner parks 'gate tool changed'", async () => {
    const h = await withFiles(['package.json', 'package-lock.json']);
    h.forge.state.files.set('base0:package.json', pkg('vitest run'));
    h.forge.state.files.set('sha1:package.json', pkg('vitest run', { vitest: 'npm:evil@1.0.0' }));
    h.forge.state.files.set('base0:package-lock.json', lock);
    h.forge.state.files.set('sha1:package-lock.json', lock);
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(item(h).reason).toMatch(/^gate tool changed: .*vitest/);
  });

  test('base changing a gate script does not park a behind PR', async () => {
    const h = await withFiles(['src/a.ts']);
    h.forge.state.files.set('base0:package.json', pkg('vitest run'));
    h.forge.state.files.set('sha1:package.json', pkg('vitest run'));
    h.forge.state.files.set('b2:package.json', pkg('vitest run --coverage'));
    h.forge.state.compares.set('main...sha1', {
      aheadBy: 1,
      behindBy: 1,
      baseSha: 'b2',
      mergeBaseSha: 'base0',
    });
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['resolve']);
  });
});

describe('§16 PR lifecycle edges', () => {
  test('closed PR, then retry: retry resumes the branch and opens a new PR (create_pr keyed by head)', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.reconcile();
    const { payload, dropId, epoch } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'sha1' });
    h.forge.state.branches.set('agent/issue-1', 'sha2');
    await h.postResult(dropId, epoch, implemented('sha2'));
    expect(item(h).state).toBe('pr_open');
    expect([...h.forge.state.pulls.values()].filter((p) => p.state === 'open')).toHaveLength(1);
    expect(listOutbox(h.db, ['done']).map((o) => o.opKey)).toContain(opKeys.pr(1, 'sha2'));
  });

  test("a retried PR at the same SHA is reviewed afresh, never merged on the closed PR's approval", async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const review = await h.lease();
    h.forge.state.close(1); // a human closes PR 1 while its approval is being posted
    await h.postResult(review.dropId, review.epoch, reviewed(approve));
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.reconcile();
    await h.finishDrop('implement', implemented('sha1'));
    expect(item(h)).toMatchObject({ state: 'pr_open', prNumber: 2 });
    await h.reconcile();
    expect(h.forge.state.merges).toEqual([]);
    expect(h.queuedRoles()).toEqual(['review']);
  });

  test('orphan (rule 10, agent branch deleted) parks', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.branches.delete('agent/issue-1');
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'agent branch deleted' });
  });

  test('orphan (rule 4, pr closed) parks', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
  });

  test('a null-SHA preparing PR waits', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.pulls.get(1)!.headSha = null;
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual([]);
  });

  test('stale conflict flag while the branch contains base: no resolve loop', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    (h.forge.state.pulls.get(1) as unknown as Record<string, unknown>).mergeable = false;
    await h.reconcile();
    await h.reconcile();
    expect(h.queuedRoles()).not.toContain('resolve');
    expect(h.forge.state.merges.map((m) => m.sha)).toEqual(['sha1']);
  });

  test('every merge moves base: three approved PRs: clean resolves are free; none parks', async () => {
    const h = await harness({ issues: [issue(1), issue(2), issue(3)] });
    const behindAll = () => {
      for (const p of h.forge.state.pulls.values()) {
        if (p.state === 'open' && p.headSha) {
          h.forge.state.compares.set(`main...${p.headSha}`, {
            aheadBy: 1,
            behindBy: 1,
            baseSha: `b${h.forge.state.merges.length}`,
            mergeBaseSha: 'b0',
          });
        }
      }
    };
    for (let pass = 0; pass < 30 && h.forge.state.merges.length < 3; pass++) {
      const merged = h.forge.state.merges.length;
      await h.reconcile();
      if (h.forge.state.merges.length > merged) behindAll();
      while (h.queuedRoles().length > 0) {
        const { payload, dropId, epoch } = await h.lease();
        if (payload.role === 'implement') {
          const sha = `s${payload.issue.number}`;
          h.forge.state.branches.set(payload.branch, sha);
          await h.postResult(dropId, epoch, implemented(sha));
        } else if (payload.role === 'review') {
          await h.postResult(dropId, epoch, reviewed(approve));
        } else if (payload.role === 'resolve') {
          const sha = `${payload.pr.headSha}-r${pass}`;
          h.forge.state.setHead(payload.pr.number, sha);
          await h.postResult(dropId, epoch, {
            status: 'completed',
            headSha: sha,
            mergeOutcome: 'clean',
            gates: [gateOk],
          });
        } else {
          throw new Error(`unexpected ${payload.role}`);
        }
      }
    }
    expect(h.forge.state.merges).toHaveLength(3);
    for (const n of [1, 2, 3]) {
      expect(item(h, n)).toMatchObject({ state: 'done', reason: 'merged' });
      expect(getAttempts(h.db, n, 'resolve').count).toBe(0);
    }
  });

  test('busy base: free resolves stop at maxResolveTotal', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    let head = 'sha1';
    for (let i = 0; i < h.zone.budgets.maxResolveTotal + 2 && item(h).state === 'pr_open'; i++) {
      h.forge.state.compares.set(`main...${head}`, {
        aheadBy: 1,
        behindBy: 1,
        baseSha: `b${i}`,
        mergeBaseSha: 'b',
      });
      await h.reconcile();
      if (!h.queuedRoles().includes('resolve')) break;
      const next = `r${i}`;
      await h.finishDrop('resolve', {
        status: 'completed',
        headSha: next,
        mergeOutcome: 'clean',
        gates: [gateOk],
      });
      head = next;
    }
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'budget exhausted: resolve-total' });
  });
});

describe('§16 server-side parks', () => {
  test('unsafe branch protection: parks before any merge call', async () => {
    const h = await harness();
    const r = h.forge.state.rules.author;
    if (r.kind === 'ok') r.rules.viewerCanBypass = true;
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(item(h).reason).toMatch(/^unsafe branch protection/);
    expect(count(h, 'merge')).toBe(0);
    expect(count(h, 'createReview')).toBe(0);
  });

  test('unsafe protection park is cleared by the cause going away', async () => {
    const h = await harness();
    const r = h.forge.state.rules.author;
    if (r.kind === 'ok') r.rules.viewerCanBypass = true;
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    if (r.kind === 'ok') r.rules.viewerCanBypass = false;
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
  });

  test('a merge rejected park is retried after an hour, so a cleared human blocker merges', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', { status: 405, message: 'unresolved conversations' });
    await h.reconcile();
    await h.reconcile();
    expect(item(h).reason).toMatch(/^merge rejected/);
    h.at(30);
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(count(h, 'merge')).toBe(1);
    h.at(31); // the human resolved the conversation meanwhile
    await h.reconcile();
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
    expect(count(h, 'merge')).toBe(2);
  });

  test('merge rejected park is cleared by the retry label', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('merge', { status: 405 });
    await h.reconcile();
    await h.reconcile();
    expect(item(h).reason).toMatch(/^merge rejected/);
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.reconcile();
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
  });

  test('human block park is cleared by the cause going away', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    const rc = h.forge.state.review({
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      commitId: 'sha0',
    });
    await h.reconcile();
    await h.finishDrop('review', reviewed(approve));
    await h.reconcile();
    await h.reconcile();
    expect(item(h).reason).toBe('human block stands');
    h.forge.state.review({ author: 'alice', state: 'APPROVED', commitId: 'sha1', id: rc.id + 10 });
    await h.reconcile();
    expect(item(h).state).not.toBe('parked');
  });

  test('budgets counted before the run; retry label resets once', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    expect(getAttempts(h.db, 1, 'review').count).toBe(1); // charged at enqueue, before the drop ran
    await h.finishDrop('review', reviewed(changes));
    setAttempts(h.db, 1, 'heal', h.zone.budgets.maxHeal, 'old');
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'budget exhausted: heal' });
    h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await h.sync();
    expect(item(h).state).toBe('pr_open');
    expect(getAttempts(h.db, 1, 'heal').count).toBe(0);
    setAttempts(h.db, 1, 'heal', h.zone.budgets.maxHeal, 'old2');
    await h.reconcile();
    expect(item(h).reason).toBe('budget exhausted: heal');
    await h.sync(); // label still on: no second reset
    expect(item(h).state).toBe('parked');
  });
});

describe('§16 CI and forge data', () => {
  test('CI lag: green checks without a required check wait; the deadline park names the missing check', async () => {
    const h = await harness({ zone: { ciRequired: true } });
    requireCi(h);
    await toApproved(h, 'sha1');
    h.forge.state.checks.set('sha1', { state: 'success', names: ['lint'] });
    await h.reconcile();
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(count(h, 'merge')).toBe(0);
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'no CI result: missing ci' });
  });

  test("lost webhook: deadline parks with 'no CI result'", async () => {
    const h = await harness({ zone: { ciRequired: true } });
    requireCi(h);
    await toApproved(h, 'sha1');
    h.forge.state.checks.set('sha1', { state: 'pending', names: [] });
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    await h.reconcile();
    expect(item(h).reason).toMatch(/^no CI result/);
  });

  test("missing pipeline: deadline parks with 'no pipeline'", async () => {
    // With protection required, ciRequired and no required check is already unsafe protection.
    const h = await harness({ zone: { ciRequired: true, requireBranchProtection: false } });
    await toApproved(h, 'sha1');
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'no pipeline' });
  });

  test('missing forge data: null pr waits, then parks at the deadline', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.pulls.delete(1);
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'forge data missing: pr' });
  });

  test('missing forge data: null compare waits, then parks at the deadline', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.author.failNext('compare', '5xx');
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    h.at(h.zone.ciDeadlineMinutes + 5);
    h.forge.author.failNext('compare', '5xx');
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'forge data missing: compare' });
  });
});

describe('§16 usage limits', () => {
  const rejected = (resetsAt: string) => ({ status: 'rejected' as const, resetsAt });

  test('usage limit mid-drop: requeued only while paused, charge refunded, gate closed until reset', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    expect(getAttempts(h.db, 1, 'review').count).toBe(1);
    const reset = new Date(h.now().getTime() + 30 * 60_000).toISOString();
    await h.finishDrop('review', { status: 'rate_limited', gates: [], rateLimit: rejected(reset) });
    expect(h.queuedRoles()).toEqual(['review']);
    expect(getAttempts(h.db, 1, 'review').count).toBe(0);
    expect(dispatchGate(h.db, usageCfg, h.now())).toBe('closed');
    await expect(h.lease()).rejects.toThrow();
  });

  test('a forged far-future reset is clamped; a single-drop pause lasts at most 1 h', async () => {
    const h = await harness();
    await h.reconcile();
    const farFuture = new Date(h.now().getTime() + 30 * 86_400_000).toISOString();
    await h.finishDrop('implement', {
      status: 'rate_limited',
      gates: [],
      rateLimit: rejected(farFuture),
    });
    const until = Date.parse(getUsageState(h.db).pausedUntil ?? '');
    expect(until - h.now().getTime()).toBeLessThanOrEqual(60 * 60_000);
    h.at(61);
    expect(dispatchGate(h.db, usageCfg, h.now())).not.toBe('closed');
  });

  test('a late allowed from an older drop does not reopen', async () => {
    const h = await harness({ issues: [issue(1), issue(2)] });
    await toPrOpen(h, 'sha1');
    await h.reconcile(); // review for 1, implement for 2
    const older = await h.lease();
    h.at(1);
    const newer = await h.lease();
    const reset = new Date(h.now().getTime() + 30 * 60_000).toISOString();
    await h.postResult(newer.dropId, newer.epoch, {
      status: 'rate_limited',
      gates: [],
      rateLimit: rejected(reset),
    });
    await h.postResult(older.dropId, older.epoch, {
      ...(older.payload.role === 'review' ? reviewed(approve) : implemented('sha2')),
      rateLimit: { status: 'allowed' },
    });
    expect(dispatchGate(h.db, usageCfg, h.now())).toBe('closed');
  });

  test('probe drop dies: gate reopens after one jitter; the probe is never the cause item', async () => {
    const h = await harness({ issues: [issue(1), issue(2)] });
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const cause = await h.lease(); // review on item 1
    const reset = new Date(h.now().getTime() + 10 * 60_000).toISOString();
    await h.postResult(cause.dropId, cause.epoch, {
      status: 'rate_limited',
      gates: [],
      rateLimit: rejected(reset),
    });
    h.at(11);
    expect(dispatchGate(h.db, usageCfg, h.now())).toBe('probe');
    const probe = await h.lease();
    expect(probe.payload.issue.number).toBe(2);
    h.at(5);
    expireLeases(h.db, h.now(), usageCfg, () => 0);
    expect(dispatchGate(h.db, usageCfg, h.now())).toBe('closed');
    h.at(usageCfg.probeJitterSeconds[1] / 60 + 1);
    expect(dispatchGate(h.db, usageCfg, h.now())).toBe('probe');
  });

  test('a rate-limited probe is requeued free', async () => {
    const h = await harness({ issues: [issue(1), issue(2)] });
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const cause = await h.lease();
    const reset = new Date(h.now().getTime() + 10 * 60_000).toISOString();
    await h.postResult(cause.dropId, cause.epoch, {
      status: 'rate_limited',
      gates: [],
      rateLimit: rejected(reset),
    });
    h.at(11);
    const probe = await h.lease();
    const before = getAttempts(h.db, 2, 'rate_limit').count;
    await h.postResult(probe.dropId, probe.epoch, {
      status: 'rate_limited',
      gates: [],
      rateLimit: rejected(new Date(h.now().getTime() + 600_000).toISOString()),
    });
    expect(getAttempts(h.db, 2, 'rate_limit').count).toBe(before);
    expect(activeDropFor(h.db, 2)?.state).toBe('queued');
  });
});

/**
 * Human-action end-state matrix. S1 = implement running, no PR; S2 = review drop running;
 * S3 = approved, waiting for CI; S4 = parked `budget exhausted: heal`.
 */
describe('§16 human-action matrix', () => {
  async function s1(issues = [issue(1)]) {
    const h = await harness({ issues });
    await h.reconcile();
    const drop = await h.lease();
    return { h, drop };
  }
  async function s2() {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const drop = await h.lease();
    return { h, drop };
  }
  async function s3() {
    const h = await harness({ zone: { ciRequired: true } });
    requireCi(h);
    h.forge.state.checks.set('sha1', { state: 'pending', names: [] });
    await toApproved(h, 'sha1');
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    return h;
  }
  async function s4() {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    await h.finishDrop('review', reviewed(changes));
    setAttempts(h.db, 1, 'heal', h.zone.budgets.maxHeal, 'spent');
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'budget exhausted: heal' });
    return h;
  }
  const finishReview = (h: Harness, d: { dropId: string; epoch: number }) =>
    h.postResult(d.dropId, d.epoch, reviewed(approve));

  describe('merges the PR', () => {
    test('S2: drop result is stored; next pass done/merged; zero merge calls', async () => {
      const { h, drop } = await s2();
      h.forge.state.markMerged(1);
      expect(await finishReview(h, drop)).toBe(204);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
      expect(count(h, 'merge')).toBe(0);
    });
    test('S3: done/merged; zero merge calls', async () => {
      const h = await s3();
      h.forge.state.markMerged(1);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
      expect(count(h, 'merge')).toBe(0);
    });
    test('S4: done/merged (sync)', async () => {
      const h = await s4();
      h.forge.state.markMerged(1);
      await h.sync();
      expect(item(h)).toMatchObject({ state: 'done', reason: 'merged' });
    });
  });

  describe('closes the PR', () => {
    test('S2: after the drop: parked pr closed', async () => {
      const { h, drop } = await s2();
      h.forge.state.close(1);
      await finishReview(h, drop);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
    });
    test('S3: parked pr closed', async () => {
      const h = await s3();
      h.forge.state.close(1);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
      expect(count(h, 'merge')).toBe(0);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.close(1);
      await h.reconcile();
      expect(item(h).state).toBe('parked');
    });
  });

  test('reopens the PR, S4 from pr closed: back to pr_open, re-decided', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.close(1);
    await h.reconcile();
    expect(item(h).reason).toBe('pr closed');
    h.forge.state.reopen(1);
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    expect(h.queuedRoles()).toEqual(['review']);
  });

  describe('closes the issue', () => {
    test('S1: the PR is created, then parked issue closed; another ready item dispatches', async () => {
      const { h, drop } = await s1([issue(1), issue(2)]);
      h.forge.state.closeIssue(1);
      h.forge.state.branches.set('agent/issue-1', 'sha1');
      await h.postResult(drop.dropId, drop.epoch, implemented('sha1'));
      expect(h.forge.state.pulls.size).toBe(1);
      await h.reconcile();
      expect(item(h, 1)).toMatchObject({ state: 'parked', reason: 'issue closed' });
      const next = await h.lease();
      expect(next.payload.issue.number).toBe(2);
    });
    test('S2: parked issue closed', async () => {
      const { h, drop } = await s2();
      h.forge.state.closeIssue(1);
      await finishReview(h, drop);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'parked', reason: 'issue closed' });
    });
    test('S3: parked issue closed; zero merge calls', async () => {
      const h = await s3();
      h.forge.state.closeIssue(1);
      h.forge.state.checks.set('sha1', { state: 'success', names: ['ci'] });
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'parked', reason: 'issue closed' });
      expect(count(h, 'merge')).toBe(0);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.closeIssue(1);
      await h.reconcile();
      expect(item(h).reason).toBe('budget exhausted: heal');
    });
  });

  test('reopens the issue, S4 from issue closed: back to pr_open', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    h.forge.state.closeIssue(1);
    await h.reconcile();
    expect(item(h).reason).toBe('issue closed');
    h.forge.state.reopenIssue(1);
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
  });

  describe('force-pushes the branch', () => {
    test('S1: implement push rejected → back to ready, then resumed from the pushed branch', async () => {
      const { h, drop } = await s1();
      h.forge.state.branches.set('agent/issue-1', 'human1');
      await h.postResult(drop.dropId, drop.epoch, {
        status: 'failed',
        reason: 'branch agent/issue-1 already exists on remote',
        gates: [],
      });
      expect(item(h).state).toBe('ready');
      await h.reconcile();
      const { payload } = await h.lease();
      expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'human1' });
    });
    test('S2: the verdict binds to the old SHA; new head reviewed; zero merge calls on the old SHA', async () => {
      const { h, drop } = await s2();
      h.forge.state.setHead(1, 'sha2');
      await finishReview(h, drop);
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['review']);
      expect(h.forge.author.calls.filter((c) => c.method === 'merge')).toHaveLength(0);
      const v = h.db.prepare('SELECT head_sha AS headSha FROM verdicts').get();
      expect(v).toEqual({ headSha: 'sha1' });
    });
    test('S3: approval invalidated; review queued for the new head', async () => {
      const h = await s3();
      h.forge.state.setHead(1, 'sha2');
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['review']);
      expect(count(h, 'merge')).toBe(0);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.setHead(1, 'sha2');
      await h.reconcile();
      expect(item(h).state).toBe('parked');
    });
  });

  describe('deletes the branch', () => {
    test('S1: implement pushes a new branch normally', async () => {
      const { h, drop } = await s1();
      h.forge.state.branches.set('agent/issue-1', 'sha1');
      await h.postResult(drop.dropId, drop.epoch, implemented('sha1'));
      expect(item(h).state).toBe('pr_open');
    });
    test('S2: parked pr closed (forge closes the PR)', async () => {
      const { h, drop } = await s2();
      h.forge.state.deleteBranch('agent/issue-1');
      await finishReview(h, drop);
      await h.reconcile();
      expect(item(h)).toMatchObject({ state: 'parked', reason: 'pr closed' });
    });
    test('S3: parked pr closed or agent branch deleted', async () => {
      const h = await s3();
      h.forge.state.deleteBranch('agent/issue-1');
      await h.reconcile();
      expect(item(h).state).toBe('parked');
      expect(['pr closed', 'agent branch deleted']).toContain(item(h).reason);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.deleteBranch('agent/issue-1');
      await h.reconcile();
      expect(item(h).state).toBe('parked');
    });
  });

  describe('pushes to base', () => {
    test('S1: no effect until the PR exists', async () => {
      const { h, drop } = await s1();
      h.forge.state.branches.set('agent/issue-1', 'sha1');
      await h.postResult(drop.dropId, drop.epoch, implemented('sha1'));
      expect(item(h).state).toBe('pr_open');
      expect(h.queuedRoles()).toEqual([]);
    });
    test('S2: after the drop: resolve queued, no budget charge if clean', async () => {
      const { h, drop } = await s2();
      h.forge.state.compares.set('main...sha1', {
        aheadBy: 1,
        behindBy: 1,
        baseSha: 'b2',
        mergeBaseSha: 'b',
      });
      await finishReview(h, drop);
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['resolve']);
      await h.finishDrop('resolve', {
        status: 'completed',
        headSha: 'sha2',
        mergeOutcome: 'clean',
        gates: [gateOk],
      });
      expect(getAttempts(h.db, 1, 'resolve').count).toBe(0);
    });
    test('S3: resolve, then re-review on the new head', async () => {
      const h = await s3();
      h.forge.state.compares.set('main...sha1', {
        aheadBy: 1,
        behindBy: 1,
        baseSha: 'b2',
        mergeBaseSha: 'b',
      });
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['resolve']);
      await h.finishDrop('resolve', {
        status: 'completed',
        headSha: 'sha2',
        mergeOutcome: 'clean',
        gates: [gateOk],
      });
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['review']);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.compares.set('main...sha1', {
        aheadBy: 1,
        behindBy: 1,
        baseSha: 'b2',
        mergeBaseSha: 'b',
      });
      await h.reconcile();
      expect(item(h).state).toBe('parked');
    });
  });

  describe('trusted CHANGES_REQUESTED on head', () => {
    test('S2: after the drop: heal with feedback under the trusted heading', async () => {
      const { h, drop } = await s2();
      h.forge.state.review({
        author: 'alice',
        state: 'CHANGES_REQUESTED',
        body: 'rename foo',
        commitId: 'sha1',
      });
      await finishReview(h, drop);
      await h.reconcile();
      const { payload } = await h.lease();
      expect(payload.role).toBe('heal');
      if (payload.role === 'heal') {
        expect(payload.feedback).toContain('## Feedback (data, from trusted reviewers)');
        expect(payload.feedback).toContain('rename foo');
      }
    });
    test('S3: heal queued; zero merge calls', async () => {
      const h = await s3();
      h.forge.state.review({
        author: 'alice',
        state: 'CHANGES_REQUESTED',
        body: 'no',
        commitId: 'sha1',
      });
      h.forge.state.checks.set('sha1', { state: 'success', names: ['ci'] });
      await h.reconcile();
      expect(h.queuedRoles()).toEqual(['heal']);
      expect(count(h, 'merge')).toBe(0);
    });
    test('S4: stays parked', async () => {
      const h = await s4();
      h.forge.state.review({
        author: 'alice',
        state: 'CHANGES_REQUESTED',
        body: 'no',
        commitId: 'sha1',
      });
      await h.reconcile();
      expect(item(h).state).toBe('parked');
    });
  });

  describe('applies the retry label', () => {
    test('S1: no effect', async () => {
      const { h } = await s1();
      h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
      await h.reconcile();
      expect(item(h).state).toBe('in_flight');
    });
    test('S2: no effect', async () => {
      const { h } = await s2();
      h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
      await h.reconcile();
      expect(item(h).state).toBe('pr_open');
      expect(getAttempts(h.db, 1, 'review').count).toBe(1);
    });
    test('S3: no effect', async () => {
      const h = await s3();
      h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
      await h.reconcile();
      expect(item(h).state).toBe('pr_open');
    });
    test('S4: attempts reset; back to pr_open', async () => {
      const h = await s4();
      h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
      await h.sync();
      expect(item(h).state).toBe('pr_open');
      expect(getAttempts(h.db, 1, 'heal').count).toBe(0);
    });
  });
});

describe('§16 final-review regressions', () => {
  test('a partial forge outage past the deadline recovers once the forge answers again', async () => {
    const h = await harness();
    await toApproved(h, 'sha1');
    h.forge.author.failNext('getPull', '5xx');
    h.forge.author.failNext('getPull', '5xx');
    await h.reconcile();
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    expect(item(h)).toMatchObject({ state: 'parked', reason: 'forge data missing: pr' });
    await h.reconcile();
    await h.reconcile();
    expect(item(h).state).not.toBe('parked');
  });

  test("an unchanged package.json with a 5xx on one read is reviewed, not parked 'unreadable'", async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    const pkg = JSON.stringify({ scripts: { test: 'vitest run' } });
    h.forge.state.pullFiles.set(1, {
      files: [{ path: 'package.json' }, { path: 'src/a.ts' }],
      complete: true,
    });
    h.forge.state.files.set('base0:package.json', pkg);
    h.forge.state.files.set('sha1:package.json', pkg);
    h.forge.author.failNext('getFileAt', '5xx');
    await h.reconcile();
    expect(item(h).state).toBe('pr_open');
    await h.reconcile();
    expect(h.queuedRoles()).toContain('review');
  });

  test('ciRequired without required checks never merges on a green third-party check', async () => {
    const h = await harness({ zone: { requireBranchProtection: false, ciRequired: true } });
    h.forge.state.checks.set('sha1', { state: 'success', names: ['license/cla'] });
    await toApproved(h, 'sha1');
    await h.reconcile();
    expect(h.forge.state.merges).toHaveLength(0);
    h.at(h.zone.ciDeadlineMinutes + 5);
    await h.reconcile();
    expect(item(h).state).toBe('parked');
    expect(item(h).reason).toMatch(/^no CI result/);
  });

  test('an item whose agent branch exists is resumed, never freshly implemented', async () => {
    const h = await harness();
    h.forge.state.branches.set('agent/issue-1', 'old1');
    h.forge.author.failNext('branchSha', '5xx');
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    await h.reconcile();
    const { payload } = await h.lease();
    expect(payload).toMatchObject({ role: 'implement', resume: true, resumeSha: 'old1' });
  });

  test("a 'stale info' or 'already exists' implement failure resumes instead of parking", async () => {
    for (const reason of [
      'stale info: ! [rejected] agent/issue-1 -> agent/issue-1 (stale info)',
      'branch agent/issue-1 already exists on remote',
    ]) {
      const h = await harness();
      await h.reconcile();
      const { dropId, epoch } = await h.lease();
      h.forge.state.branches.set('agent/issue-1', 'sha-other');
      await h.postResult(dropId, epoch, { status: 'failed', reason, gates: [gateOk] });
      expect(item(h).state).not.toBe('parked');
      await h.reconcile();
      const next = await h.lease();
      expect(next.payload).toMatchObject({
        role: 'implement',
        resume: true,
        resumeSha: 'sha-other',
      });
    }
  });
});
