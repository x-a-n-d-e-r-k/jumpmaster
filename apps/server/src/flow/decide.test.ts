import { describe, expect, test } from 'vitest';
import { DEFAULT_PROTECTED_PATHS, type DropZoneConfig } from '../config.js';
import {
  activeDropFor,
  type Drop,
  getWorkItem,
  insertDrop,
  reclaimableDropFor,
  updateDrop,
  type VerdictRow,
  type WorkItem,
} from '../db/repo.js';
import {
  type ChecksFacts,
  type CompareFacts,
  type ForgeReview,
  type PullFacts,
  RUNNER_CONCLUSIONS,
} from '../forge/github.js';
import { promptVersions } from '../payloads.js';
import { usageCfg, zoneWorld } from '../test/fixtures.js';
import { t0 } from '../test/helpers.js';
import { fingerprint } from './budgets.js';
import { decide, gateParkAllowable, HOLD_REASON, OVERRIDE_HINT, type Snapshot } from './decide.js';
import { protectedPathHits } from './guards.js';
import { reconcileZone } from './reconcile.js';
import { buildSnapshot, zonePass } from './snapshot.js';

const now = t0;
const minutesAgo = (m: number): string => new Date(now.getTime() - m * 60_000).toISOString();

const z: DropZoneConfig = {
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
    maxBaseSync: 12,
  },
  ciRequired: true,
  ciDeadlineMinutes: 45,
  retryLabel: 'agent-retry',
  mergeMethod: 'squash',
  requireBranchProtection: true,
  protectedPaths: ['.github/**'],
  reviewReadToken: false,
};

const item: WorkItem = {
  id: 1,
  dropZoneId: 'main',
  issueNumber: 7,
  title: 't',
  body: 'b',
  author: 'alice',
  priority: 0,
  isFix: false,
  issueCreatedAt: minutesAgo(600),
  state: 'pr_open' as WorkItem['state'],
  reason: null,
  prNumber: 9,
  retryLabelSeen: false,
  waitingSince: null,
};

const pr = (headSha: string): PullFacts => ({
  number: 9,
  title: 't',
  state: 'open',
  merged: false,
  headSha,
  headRef: 'jm/7',
  headRepo: 'octo/demo',
  baseRef: 'main',
  author: 'jm-author',
});

const cmp = (over: Partial<CompareFacts> = {}): CompareFacts => ({
  aheadBy: 1,
  behindBy: 0,
  baseSha: 'base1',
  mergeBaseSha: 'mb1',
  ...over,
});

let seq = 0;
const verdict = (
  decision: VerdictRow['decision'],
  headSha: string,
  over: Partial<VerdictRow> = {},
): VerdictRow => ({
  id: `v${++seq}`,
  workItemId: 1,
  headSha,
  decision,
  forced: false,
  summary: `${decision} summary`,
  findingsJson: '[]',
  gatesJson: '[]',
  createdAt: minutesAgo(1),
  ...over,
});
const approve = (sha: string, over: Partial<VerdictRow> = {}) => verdict('approve', sha, over);
const rc = (sha: string, over: Partial<VerdictRow> = {}) => verdict('request_changes', sha, over);

const humanRc = (id: number, body: string): ForgeReview => ({
  id,
  author: 'carol',
  state: 'CHANGES_REQUESTED',
  commitId: 's',
  body,
  submittedAt: minutesAgo(2),
});

const ok: ChecksFacts = { state: 'success', names: ['ci'], failed: [] };
const none: ChecksFacts = { state: 'none', names: [], failed: [] };
const pending: ChecksFacts = { state: 'pending', names: [], failed: [] };
const failing: ChecksFacts = { state: 'failure', names: ['test'], failed: [] };

const drop = { id: 'd1', role: 'review', state: 'running' } as Drop;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    item,
    zone: z,
    now,
    activeDrop: null,
    pr: pr('s'),
    issueState: 'open',
    branchSha: 's',
    compare: cmp(),
    checks: pending,
    codeScanning: [],
    ciAnnotations: [],
    lastCiHealKey: null,
    forgeUnavailable: null,
    forgeDenied: null,
    requiredChecks: [],
    verdictsOnHead: [],
    reviewOp: { state: 'done' },
    mergeOp: null,
    trustedChangeRequests: [],
    humanBlockStanding: false,
    held: false,
    protectedHits: [],
    filesComplete: true,
    gateScriptChanges: [],
    gateToolChanges: [],
    maintainerApproved: false,
    commandAllowed: false,
    gateDetails: { scripts: [], tools: [] },
    newestReviewAt: null,
    protectionProblems: [],
    headFirstSeenAt: now.toISOString(),
    missingSince: null,
    carry: null,
    mergeReservedBy: null,
    updateConflict: false,
    ...over,
  };
}

/** A snapshot that would merge if nothing else intervened. */
const mergeable = (over: Partial<Snapshot> = {}): Snapshot =>
  snap({ verdictsOnHead: [approve('s')], checks: ok, requiredChecks: ok.names, ...over });

describe('rules in order', () => {
  test('1: an active drop waits, whatever the forge says', () => {
    expect(decide(snap({ activeDrop: drop }))).toEqual({ kind: 'wait', on: 'drop' });
    expect(decide(snap({ activeDrop: drop, pr: null, protectedHits: ['x'] }))).toEqual({
      kind: 'wait',
      on: 'drop',
    });
  });

  test('2: null pr waits, then parks at the deadline', () => {
    expect(decide(snap({ pr: null }))).toEqual({ kind: 'wait', on: 'forge' });
    expect(decide(snap({ pr: null, missingSince: minutesAgo(44) }))).toEqual({
      kind: 'wait',
      on: 'forge',
    });
    expect(decide(snap({ pr: null, missingSince: minutesAgo(46) }))).toEqual({
      kind: 'park',
      reason: 'forge data missing: pr',
    });
  });

  test('2: exactly at the deadline still waits (strictly greater parks)', () => {
    expect(decide(snap({ pr: null, missingSince: minutesAgo(45) }))).toEqual({
      kind: 'wait',
      on: 'forge',
    });
  });

  test('2: a failed fresh read waits instead of parking or merging', () =>
    expect(
      decide(snap({ forgeUnavailable: 'listReviews', verdictsOnHead: [approve('s')], checks: ok })),
    ).toEqual({ kind: 'wait', on: 'forge' }));

  test('2: a failed fresh read parks at the deadline', () =>
    expect(
      decide(snap({ forgeUnavailable: 'listPullFiles', missingSince: minutesAgo(46) })),
    ).toEqual({
      kind: 'park',
      reason: 'forge data missing: listPullFiles',
    }));

  test('2: a failed read is not mistaken for a deleted branch or empty lists', () =>
    expect(
      decide(snap({ forgeUnavailable: 'getBranch', branchSha: null, verdictsOnHead: [] })),
    ).toEqual({ kind: 'wait', on: 'forge' }));

  test('3: merged pr is done', () =>
    expect(decide(snap({ pr: { ...pr('s'), merged: true, state: 'closed' } }))).toEqual({
      kind: 'done',
      reason: 'merged',
    }));

  test('3: a done merge op is done even before the forge reports merged', () =>
    expect(decide(snap({ mergeOp: { state: 'done' } }))).toEqual({
      kind: 'done',
      reason: 'merged',
    }));

  test('4: closed unmerged pr parks', () =>
    expect(decide(snap({ pr: { ...pr('s'), state: 'closed' } }))).toEqual({
      kind: 'park',
      reason: 'pr closed',
    }));

  test('5: null headSha is not an orphan', () =>
    expect(decide(snap({ pr: { ...pr('x'), headSha: null } }))).toEqual({
      kind: 'wait',
      on: 'forge',
    }));

  test('5: null headSha parks at the deadline naming head', () =>
    expect(
      decide(
        snap({ pr: { ...pr('x'), headSha: null }, missingSince: minutesAgo(46), branchSha: null }),
      ),
    ).toEqual({ kind: 'park', reason: 'forge data missing: head' }));

  test('6, 7: merge failed parks, merge unknown waits', () => {
    expect(decide(snap({ mergeOp: { state: 'failed', error: '405' } }))).toEqual({
      kind: 'park',
      reason: 'merge rejected: 405',
    });
    expect(decide(snap({ mergeOp: { state: 'unknown' } }))).toEqual({ kind: 'wait', on: 'outbox' });
    expect(decide(snap({ mergeOp: { state: 'pending' } }))).toEqual({ kind: 'wait', on: 'outbox' });
  });

  test('8: failed issue or compare read waits, then parks naming it', () => {
    expect(decide(snap({ issueState: null }))).toEqual({ kind: 'wait', on: 'forge' });
    expect(decide(snap({ compare: null }))).toEqual({ kind: 'wait', on: 'forge' });
    expect(decide(snap({ issueState: null, missingSince: minutesAgo(46) }))).toEqual({
      kind: 'park',
      reason: 'forge data missing: issue',
    });
    expect(decide(snap({ compare: null, missingSince: minutesAgo(46) }))).toEqual({
      kind: 'park',
      reason: 'forge data missing: compare',
    });
  });

  test('9: closed issue with landed work is done', () =>
    expect(decide(snap({ issueState: 'closed', compare: cmp({ aheadBy: 0 }) }))).toEqual({
      kind: 'done',
      reason: 'already on base',
    }));

  test('9: closed issue with unlanded work parks issue closed', () =>
    expect(decide(snap({ issueState: 'closed', compare: cmp({ aheadBy: 2 }) }))).toEqual({
      kind: 'park',
      reason: 'issue closed',
    }));

  test('10: deleted agent branch parks', () =>
    expect(decide(snap({ branchSha: null }))).toEqual({
      kind: 'park',
      reason: 'agent branch deleted',
    }));

  test('11: nothing ahead of base is done', () =>
    expect(decide(snap({ compare: cmp({ aheadBy: 0 }) }))).toEqual({
      kind: 'done',
      reason: 'already on base',
    }));

  test('12: protected path parks', () =>
    expect(decide(snap({ protectedHits: ['.github/workflows/ci.yml'] }))).toEqual({
      kind: 'park',
      reason: 'protected path: .github/workflows/ci.yml',
    }));

  test('12: truncated file list parks', () =>
    expect(decide(snap({ filesComplete: false }))).toEqual({
      kind: 'park',
      reason: 'protected path: file list truncated',
    }));

  test('13: gate script change parks, listing every change and the override', () =>
    expect(decide(snap({ gateScriptChanges: ['scripts/test.sh', 'scripts/lint.sh'] }))).toEqual({
      kind: 'park',
      reason: `gate script changed: scripts/test.sh; scripts/lint.sh${OVERRIDE_HINT}`,
    }));

  test('14: gate tool change parks, listing every change and the override', () =>
    expect(decide(snap({ gateToolChanges: ['node_modules/.bin/vitest'] }))).toEqual({
      kind: 'park',
      reason: `gate tool changed: node_modules/.bin/vitest${OVERRIDE_HINT}`,
    }));

  test('13–14: a long change list is capped and counts the rest', () => {
    const changes = Array.from({ length: 40 }, (_, i) => `dependency added: package-${i}@1.0.0`);
    const a = decide(snap({ gateToolChanges: changes }));
    if (a.kind !== 'park') throw new Error(a.kind);
    expect(a.reason.length).toBeLessThanOrEqual(600);
    expect(a.reason).toMatch(/^gate tool changed: dependency added: package-0@1\.0\.0; /);
    expect(a.reason).toMatch(/… \(\+\d+ more\) \(a maintainer can approve this head/);
  });

  test('13–14: no override hint when the guard could not fully read what changed', () => {
    for (const s of [
      { gateToolChanges: ['vitest: npm:x@1', 'lockfile unreadable'] },
      { gateToolChanges: ['lockfile not found'] },
      { gateToolChanges: ['lockfile format not supported: yarn.lock'] },
      { gateScriptChanges: ['package.json unreadable'] },
    ]) {
      const a = decide(snap(s));
      if (a.kind !== 'park') throw new Error(a.kind);
      expect(a.reason).not.toContain(OVERRIDE_HINT);
      expect(a.reason).toMatch(/ \(not fully read: merge it by hand\)$/);
    }
  });

  test('13–14: a maintainer approval does not lift a park on a change not fully read', () => {
    for (const s of [
      { gateToolChanges: ['vitest: npm:x@1', 'lockfile unreadable'] },
      { gateToolChanges: ['lockfile format not supported: yarn.lock'] },
      { gateScriptChanges: ['package.json unreadable'] },
    ]) {
      const a = decide(snap({ ...s, maintainerApproved: true }));
      expect(a).toMatchObject({ kind: 'park' });
      if (a.kind === 'park') expect(a.reason).toMatch(/\(not fully read: merge it by hand\)$/);
    }
  });

  test('13–14: a maintainer approval of the head lets gate changes through', () => {
    const s = { gateScriptChanges: ['test'], gateToolChanges: ['x'], maintainerApproved: true };
    expect(decide(snap(s))).toEqual(decide(snap()));
  });

  test('13: a script park offers no override when a tool change was not fully read', () => {
    const a = decide(
      snap({ gateScriptChanges: ['test'], gateToolChanges: ['lockfile not found'] }),
    );
    expect(a).toEqual({
      kind: 'park',
      reason: 'gate script changed: test (not fully read: merge it by hand)',
    });
    if (a.kind === 'park') expect(gateParkAllowable(a.reason)).toBe(false);
  });

  test('gateParkAllowable: only a gate park whose reason offers the override', () => {
    const reasonOf = (s: Partial<Snapshot>) => {
      const a = decide(snap(s));
      return a.kind === 'park' ? a.reason : '';
    };
    expect(gateParkAllowable(reasonOf({ gateScriptChanges: ['test'] }))).toBe(true);
    expect(gateParkAllowable(reasonOf({ gateToolChanges: ['vitest: npm:x@1'] }))).toBe(true);
    expect(gateParkAllowable(reasonOf({ gateToolChanges: ['lockfile not found'] }))).toBe(false);
    expect(gateParkAllowable(reasonOf({ protectedHits: ['CODEOWNERS'] }))).toBe(false);
    expect(gateParkAllowable(`protected path: x${OVERRIDE_HINT}`)).toBe(false);
  });

  test('a truncated change list is not allowable, and a Command allowance does not lift it', () => {
    const long = Array.from({ length: 40 }, (_, i) => `dependency added: package-${i}@1.0.0`);
    const a = decide(snap({ gateToolChanges: long }));
    if (a.kind !== 'park') throw new Error(a.kind);
    expect(a.reason).toMatch(/\(\+\d+ more\)/);
    expect(gateParkAllowable(a.reason)).toBe(false);
    expect(decide(snap({ gateToolChanges: long, commandAllowed: true }))).toEqual(a);
    // A maintainer reads the diff on the forge: their approval still lifts it.
    expect(decide(snap({ gateToolChanges: long, maintainerApproved: true }))).toEqual(
      decide(snap()),
    );
  });

  test('13–14: a Command allowance for the head lets gate changes through', () => {
    const s = { gateScriptChanges: ['test'], gateToolChanges: ['x'], commandAllowed: true };
    expect(decide(snap(s))).toEqual(decide(snap()));
  });

  test('13–14: a Command allowance does not lift a park on a change not fully read', () => {
    for (const s of [
      { gateToolChanges: ['vitest: npm:x@1', 'lockfile unreadable'] },
      { gateScriptChanges: ['package.json unreadable'] },
    ]) {
      const a = decide(snap({ ...s, commandAllowed: true }));
      expect(a).toMatchObject({ kind: 'park' });
      if (a.kind === 'park') expect(a.reason).toMatch(/\(not fully read: merge it by hand\)$/);
    }
  });

  test('12: a Command allowance does not lift a protected path park', () =>
    expect(decide(snap({ protectedHits: ['.github/x.yml'], commandAllowed: true }))).toEqual({
      kind: 'park',
      reason: 'protected path: .github/x.yml',
    }));

  test('12: a maintainer approval does not lift a protected path park', () =>
    expect(
      decide(snap({ protectedHits: ['pnpm-workspace.yaml'], maintainerApproved: true })),
    ).toEqual({ kind: 'park', reason: 'protected path: pnpm-workspace.yaml' }));

  test('15: unavailable branch rules wait', () =>
    expect(decide(snap({ protectionProblems: null }))).toEqual({ kind: 'wait', on: 'forge' }));

  test('15: unavailable branch rules park at the deadline', () =>
    expect(decide(snap({ protectionProblems: null, missingSince: minutesAgo(46) }))).toEqual({
      kind: 'park',
      reason: 'forge data missing: branch rules',
    }));

  test('15: unsafe protection parks before any review', () =>
    expect(decide(snap({ protectionProblems: ['bot can bypass'], verdictsOnHead: [] }))).toEqual({
      kind: 'park',
      reason: 'unsafe branch protection: bot can bypass',
    }));

  test('15: several protection problems are all named', () =>
    expect(decide(snap({ protectionProblems: ['bot can bypass', 'no required checks'] }))).toEqual({
      kind: 'park',
      reason: 'unsafe branch protection: bot can bypass; no required checks',
    }));

  test('16: trusted human change requests heal with human feedback', () => {
    const a = decide(
      snap({ trustedChangeRequests: [humanRc(11, 'rename foo'), humanRc(12, 'add a test')] }),
    );
    expect(a).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', 'human', 11, 12]),
      feedback: { source: 'human' },
    });
    if (a.kind !== 'enqueue') throw new Error('unreachable');
    expect(a.feedback?.text).toContain('rename foo');
    expect(a.feedback?.text).toContain('add a test');
  });

  test('17: request_changes verdict heals with the latest RC as review feedback', () => {
    const first = rc('s', { summary: 'old' });
    const latest = rc('s', {
      summary: 'missing null check',
      findingsJson: JSON.stringify([{ severity: 'blocker', file: 'a.ts', detail: 'guard x' }]),
    });
    const a = decide(snap({ verdictsOnHead: [first, latest] }));
    expect(a).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', latest.id]),
      feedback: { source: 'review' },
    });
    if (a.kind !== 'enqueue') throw new Error('unreachable');
    expect(a.feedback?.text).toContain('missing null check');
    expect(a.feedback?.text).toContain('a.ts');
    expect(a.feedback?.text).toContain('guard x');
    expect(a.feedback?.text).not.toContain('old');
  });

  test('17: unparseable findings still give the summary', () => {
    const a = decide(snap({ verdictsOnHead: [rc('s', { summary: 'fix it', findingsJson: '{' })] }));
    expect(a).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
      feedback: { source: 'review', text: 'fix it' },
    });
  });

  test('18: behind base with no conflict mark asks the forge to update the branch', () =>
    expect(decide(snap({ compare: cmp({ behindBy: 3, baseSha: 'base9' }) }))).toEqual({
      kind: 'update_branch',
      headSha: 's',
      baseSha: 'base9',
    }));

  test('18: behind base with a conflict mark for this head and base resolves', () =>
    expect(
      decide(snap({ compare: cmp({ behindBy: 3, baseSha: 'base9' }), updateConflict: true })),
    ).toEqual({
      kind: 'enqueue',
      role: 'resolve',
      fingerprint: fingerprint(['s', 'base9']),
    }));

  test('19: no verdict on head reviews', () =>
    expect(decide(snap())).toEqual({
      kind: 'enqueue',
      role: 'review',
      fingerprint: fingerprint(['s']),
    }));

  describe('19: carrying an approval across a clean merge of the base', () => {
    const same = { digest: 'd1', complete: true };
    const carry = (over: Partial<NonNullable<Snapshot['carry']>> = {}): Snapshot['carry'] => ({
      fromVerdictId: 'v-aaa',
      fromHead: 'aaa',
      fromDecision: 'approve',
      fromForced: false,
      requestChangesAfter: false,
      digestFrom: same,
      digestHead: same,
      ...over,
    });
    const review = { kind: 'enqueue', role: 'review', fingerprint: fingerprint(['s']) };

    test('carries when every condition holds', () =>
      expect(decide(snap({ carry: carry() }))).toEqual({
        kind: 'carry_verdict',
        fromVerdictId: 'v-aaa',
        headSha: 's',
      }));

    test.each<[string, Partial<Snapshot>]>([
      ['the digests differ', { carry: carry({ digestHead: { digest: 'd2', complete: true } }) }],
      [
        'the source digest is incomplete',
        { carry: carry({ digestFrom: { ...same, complete: false } }) },
      ],
      [
        'the head digest is incomplete',
        { carry: carry({ digestHead: { ...same, complete: false } }) },
      ],
      [
        'both digests are incomplete (and empty)',
        {
          carry: carry({
            digestFrom: { digest: '', complete: false },
            digestHead: { digest: '', complete: false },
          }),
        },
      ],
      ['there are no carry facts', { carry: null }],
      ['the source verdict was forced', { carry: carry({ fromForced: true }) }],
      ['a request-changes came after the approve', { carry: carry({ requestChangesAfter: true }) }],
      ['the source is a request-changes', { carry: carry({ fromDecision: 'request_changes' }) }],
      ['the source is on this same head', { carry: carry({ fromHead: 's' }) }],
    ])('reviews when %s', (_, over) => expect(decide(snap(over))).toEqual(review));

    test('never replaces a verdict already on the head', () => {
      const v = approve('s');
      expect(decide(snap({ carry: carry(), verdictsOnHead: [v], reviewOp: null }))).toEqual({
        kind: 'post_review',
        verdictId: v.id,
      });
    });

    test('rules 12 to 18 still run first', () => {
      const c = { carry: carry() };
      expect(decide(snap({ ...c, protectedHits: ['.github/x'] }))).toMatchObject({ kind: 'park' });
      expect(decide(snap({ ...c, filesComplete: false }))).toMatchObject({ kind: 'park' });
      expect(decide(snap({ ...c, gateScriptChanges: ['test'] }))).toMatchObject({
        kind: 'park',
        reason: expect.stringMatching(/^gate script changed: /),
      });
      expect(decide(snap({ ...c, gateToolChanges: ['vitest 1 → 2'] }))).toMatchObject({
        kind: 'park',
        reason: expect.stringMatching(/^gate tool changed: /),
      });
      expect(decide(snap({ ...c, held: true }))).toEqual({ kind: 'park', reason: HOLD_REASON });
      expect(decide(snap({ ...c, trustedChangeRequests: [humanRc(1, 'no')] }))).toMatchObject({
        kind: 'enqueue',
        role: 'heal',
        feedback: { source: 'human' },
      });
      expect(decide(snap({ ...c, verdictsOnHead: [rc('s')] }))).toMatchObject({
        kind: 'enqueue',
        role: 'heal',
        feedback: { source: 'review' },
      });
      expect(decide(snap({ ...c, compare: cmp({ behindBy: 1 }) }))).toMatchObject({
        kind: 'update_branch',
      });
      expect(
        decide(snap({ ...c, compare: cmp({ behindBy: 1 }), updateConflict: true })),
      ).toMatchObject({ kind: 'enqueue', role: 'resolve' });
    });
  });

  test('a hold parks before any heal, resolve or review is enqueued', () => {
    const park = { kind: 'park', reason: HOLD_REASON };
    expect(decide(snap({ held: true, verdictsOnHead: [] }))).toEqual(park);
    expect(decide(snap({ held: true, verdictsOnHead: [approve('s')] }))).toEqual(park);
    expect(decide(snap({ held: true, verdictsOnHead: [rc('s')] }))).toEqual(park);
    expect(decide(snap({ held: true, compare: cmp({ behindBy: 3 }) }))).toEqual(park);
    expect(
      decide(snap({ held: true, compare: cmp({ behindBy: 3 }), updateConflict: true })),
    ).toEqual(park);
  });

  test('20: standing human block on an older commit parks after one review', () => {
    expect(decide(snap({ humanBlockStanding: true, verdictsOnHead: [] }))).toMatchObject({
      kind: 'enqueue',
      role: 'review',
    });
    expect(decide(snap({ humanBlockStanding: true, verdictsOnHead: [approve('s')] }))).toEqual({
      kind: 'park',
      reason: 'human block stands',
    });
  });

  test('21: unposted verdict is posted before merge', () => {
    const v = approve('s');
    expect(decide(snap({ verdictsOnHead: [v], reviewOp: null, checks: ok }))).toEqual({
      kind: 'post_review',
      verdictId: v.id,
    });
  });

  test('21: posts the latest verdict on head', () => {
    const older = approve('s');
    const latest = approve('s');
    expect(decide(snap({ verdictsOnHead: [older, latest], reviewOp: null }))).toEqual({
      kind: 'post_review',
      verdictId: latest.id,
    });
  });

  test('22: pending or unknown review post waits on the outbox', () => {
    expect(decide(mergeable({ reviewOp: { state: 'pending' } }))).toEqual({
      kind: 'wait',
      on: 'outbox',
    });
    expect(decide(mergeable({ reviewOp: { state: 'unknown' } }))).toEqual({
      kind: 'wait',
      on: 'outbox',
    });
  });

  test('23: failed review post parks', () =>
    expect(decide(mergeable({ reviewOp: { state: 'failed', error: '422' } }))).toEqual({
      kind: 'park',
      reason: 'review post failed: 422',
    }));

  test('24: CI failure heals with ci feedback', () =>
    expect(decide(mergeable({ checks: failing }))).toEqual({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', 'ci']),
      feedback: { source: 'ci', text: 'CI failed on s; reproduce with the gates and fix.' },
    }));

  test('24: a CodeQL failure heals with ci feedback and the code-scanning alerts (#652)', () => {
    const codeScanning = [
      {
        check: 'CodeQL',
        annotations: [{ path: 'a.ts', startLine: 1, level: 'failure', title: 'T', message: 'M' }],
      },
    ];
    const failed = [
      { name: 'CodeQL', conclusion: 'failure', checkRunId: 7, app: 'github-advanced-security' },
    ];
    expect(
      decide(mergeable({ checks: { state: 'failure', names: ['CodeQL'], failed }, codeScanning })),
    ).toEqual({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', 'ci']),
      feedback: {
        source: 'ci',
        text: 'CI failed on s; reproduce with the gates and fix.\n- CodeQL: failure',
      },
      codeScanning,
    });
  });

  test('24: an Actions failure heals with its failure annotations, empty lists dropped (#720)', () => {
    const line = { path: 'a.test.ts', startLine: 300, level: 'failure', title: 'T', message: 'M' };
    const failed = [
      { name: 'ci', conclusion: 'failure', checkRunId: 8, app: 'github-actions' },
      { name: 'lint', conclusion: 'failure', checkRunId: 9, app: 'github-actions' },
    ];
    const checks = { state: 'failure' as const, names: ['ci', 'lint'], failed };
    expect(
      decide(
        mergeable({
          checks,
          ciAnnotations: [
            { check: 'ci', annotations: [line] },
            { check: 'lint', annotations: [] },
          ],
        }),
      ),
    ).toMatchObject({ kind: 'enqueue', ciAnnotations: [{ check: 'ci', annotations: [line] }] });
    // A failed read (an empty list): today's action, no annotations, no park.
    const today = decide(mergeable({ checks }));
    expect(
      decide(mergeable({ checks, ciAnnotations: [{ check: 'ci', annotations: [] }] })),
    ).toEqual(today);
    expect(today).not.toHaveProperty('ciAnnotations');
  });

  test('24: the same Actions annotations after a ci heal still heal: no loop break (#720)', () => {
    const line = { path: 'a.test.ts', startLine: 300, level: 'failure', title: 'T', message: 'M' };
    const failed = [{ name: 'ci', conclusion: 'failure', checkRunId: 8, app: 'github-actions' }];
    expect(
      decide(
        mergeable({
          checks: { state: 'failure', names: ['ci'], failed },
          ciAnnotations: [{ check: 'ci', annotations: [line] }],
          lastCiHealKey: ['T|a.test.ts'],
        }),
      ),
    ).toMatchObject({ kind: 'enqueue', role: 'heal' });
  });

  describe('24: code scanning flags the same alerts after a ci heal (#653)', () => {
    const alert = (title: string, path: string, startLine = 1) => ({
      path,
      startLine,
      level: 'failure',
      title,
      message: 'm',
    });
    const rate = alert('Missing rate limiting', 'apps/server/src/api/sticks.ts', 460);
    const cq = {
      name: 'CodeQL',
      conclusion: 'failure',
      checkRunId: 7,
      app: 'github-advanced-security',
    };
    const failingWith = (failed: ChecksFacts['failed'], over: Partial<Snapshot>) =>
      mergeable({
        checks: { state: 'failure', names: failed.map((f) => f.name), failed },
        ...over,
      });
    const KEY = ['Missing rate limiting|apps/server/src/api/sticks.ts'];
    const REASON =
      'code scanning still flags Missing rate limiting at apps/server/src/api/sticks.ts:460 after a heal: fix it with a Retry note, or dismiss the alert in GitHub and re-run the CodeQL check';

    test('the same key after a ci heal parks, naming the first alert', () => {
      expect(
        decide(
          failingWith([cq], {
            codeScanning: [{ check: 'CodeQL', annotations: [rate, rate] }],
            lastCiHealKey: KEY,
          }),
        ),
      ).toEqual({ kind: 'park', reason: REASON });
    });

    test('the first alert is the first by title and path, whatever the order read', () => {
      const b = alert('B rule', 'z.ts', 9);
      const a = alert('A rule', 'y.ts', 3);
      expect(
        decide(
          failingWith([cq], {
            codeScanning: [{ check: 'CodeQL', annotations: [b, a] }],
            lastCiHealKey: ['A rule|y.ts', 'B rule|z.ts'],
          }),
        ),
      ).toEqual({
        kind: 'park',
        reason:
          'code scanning still flags A rule at y.ts:3 after a heal: fix it with a Retry note, or dismiss the alert in GitHub and re-run the CodeQL check',
      });
    });

    test("a review heal in between does not matter: the key is the last ci heal's", () => {
      // The snapshot counts only ci heals; whatever review heal ran since, the same key parks.
      const s = failingWith([cq], {
        codeScanning: [{ check: 'CodeQL', annotations: [rate] }],
        lastCiHealKey: KEY,
        verdictsOnHead: [approve('s')],
      });
      expect(decide(s)).toEqual({ kind: 'park', reason: REASON });
    });

    test('a different key heals', () => {
      const other = alert('Clear-text logging', 'apps/server/src/log.ts', 4);
      const a = decide(
        failingWith([cq], {
          codeScanning: [{ check: 'CodeQL', annotations: [other] }],
          lastCiHealKey: KEY,
        }),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal', feedback: { source: 'ci' } });
    });

    test('a key that only adds an alert heals', () => {
      const other = alert('Clear-text logging', 'apps/server/src/log.ts', 4);
      const a = decide(
        failingWith([cq], {
          codeScanning: [{ check: 'CodeQL', annotations: [rate, other] }],
          lastCiHealKey: KEY,
        }),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal' });
    });

    test('ci failing too heals', () => {
      const a = decide(
        failingWith(
          [cq, { name: 'ci', conclusion: 'failure', checkRunId: 8, app: 'github-actions' }],
          {
            codeScanning: [{ check: 'CodeQL', annotations: [rate] }],
            lastCiHealKey: KEY,
          },
        ),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal' });
    });

    test('an empty annotation list heals', () => {
      const a = decide(
        failingWith([cq], {
          codeScanning: [{ check: 'CodeQL', annotations: [] }],
          lastCiHealKey: [],
        }),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal' });
    });

    test('a second CodeQL check with no annotations heals', () => {
      const a = decide(
        failingWith([cq, { ...cq, name: 'CodeQL (js)', checkRunId: 9 }], {
          codeScanning: [
            { check: 'CodeQL', annotations: [rate] },
            { check: 'CodeQL (js)', annotations: [] },
          ],
          lastCiHealKey: KEY,
        }),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal' });
    });

    test('lastCiHealKey null heals', () => {
      const a = decide(
        failingWith([cq], {
          codeScanning: [{ check: 'CodeQL', annotations: [rate] }],
          lastCiHealKey: null,
        }),
      );
      expect(a).toMatchObject({ kind: 'enqueue', role: 'heal' });
    });
  });

  describe('24: failed checks', () => {
    const head = 'c441a9cdeadbeef';
    const onHead = (over: Partial<Snapshot>) =>
      mergeable({ pr: pr(head), branchSha: head, verdictsOnHead: [approve(head)], ...over });
    const failedWith = (...failed: [string, string][]) =>
      onHead({
        checks: {
          state: 'failure',
          names: failed.map(([name]) => name),
          failed: failed.map(([name, conclusion]) => ({ name, conclusion })),
        },
      });

    test('a runner-only cancelled failure parks without a heal', () => {
      const action = decide(failedWith(['images', 'cancelled']));
      expect(action).toEqual({
        kind: 'park',
        reason:
          'CI did not run to completion on c441a9c: images (cancelled); rerun the jobs, then Retry',
      });
      expect(action.kind).not.toBe('enqueue');
    });

    test.each(['startup_failure', 'stale'])('a runner-only %s failure parks', (conclusion) =>
      expect(decide(failedWith(['a', 'cancelled'], ['b', conclusion]))).toEqual({
        kind: 'park',
        reason: `CI did not run to completion on c441a9c: a (cancelled), b (${conclusion}); rerun the jobs, then Retry`,
      }),
    );

    test('a mixed failure heals and names every failed check', () =>
      expect(decide(failedWith(['ci', 'failure'], ['images', 'cancelled']))).toEqual({
        kind: 'enqueue',
        role: 'heal',
        fingerprint: fingerprint([head, 'ci']),
        feedback: {
          source: 'ci',
          text: `CI failed on ${head}; reproduce with the gates and fix.\n- ci: failure\n- images: cancelled`,
        },
      }));

    test('timed_out is a code failure and heals', () => {
      expect(RUNNER_CONCLUSIONS.has('timed_out')).toBe(false);
      expect(decide(failedWith(['ci', 'timed_out']))).toMatchObject({
        kind: 'enqueue',
        role: 'heal',
        feedback: { text: expect.stringContaining('- ci: timed_out') },
      });
    });

    test('an unknown failure (failed empty) heals with the plain text', () =>
      expect(decide(onHead({ checks: failing }))).toEqual({
        kind: 'enqueue',
        role: 'heal',
        fingerprint: fingerprint([head, 'ci']),
        feedback: { source: 'ci', text: `CI failed on ${head}; reproduce with the gates and fix.` },
      }));
  });

  test('25: green CI with every required check merges the head', () =>
    expect(
      decide(
        mergeable({
          checks: { state: 'success', names: ['lint', 'test'], failed: [] },
          requiredChecks: ['lint', 'test'],
        }),
      ),
    ).toEqual({ kind: 'merge', sha: 's' }));

  test('25: with ciRequired, a green check is not CI unless a required check names it', () => {
    expect(
      decide(snap({ verdictsOnHead: [approve('s')], checks: ok, requiredChecks: [] })).kind,
    ).toBe('wait');
  });

  test('25, 26: no CI honours ciRequired', () => {
    expect(
      decide(
        snap({ verdictsOnHead: [approve('s')], checks: none, zone: { ...z, ciRequired: false } }),
      ),
    ).toEqual({
      kind: 'merge',
      sha: 's',
    });
    expect(
      decide(
        snap({ verdictsOnHead: [approve('s')], checks: none, headFirstSeenAt: minutesAgo(46) }),
      ),
    ).toEqual({
      kind: 'park',
      reason: 'no pipeline',
    });
  });

  test('25: no CI with required checks never merges even when CI is optional', () =>
    expect(
      decide(
        mergeable({ checks: none, requiredChecks: ['test'], zone: { ...z, ciRequired: false } }),
      ),
    ).toEqual({ kind: 'wait', on: 'ci' }));

  test('26: deadline names the missing required check', () =>
    expect(
      decide(
        snap({
          verdictsOnHead: [approve('s')],
          checks: { state: 'success', names: ['lint'], failed: [] },
          requiredChecks: ['lint', 'test'],
          headFirstSeenAt: minutesAgo(46),
        }),
      ),
    ).toEqual({ kind: 'park', reason: 'no CI result: missing test' }));

  test('26: no CI at all with required checks names them at the deadline', () =>
    expect(
      decide(
        mergeable({
          checks: none,
          requiredChecks: ['lint', 'test'],
          headFirstSeenAt: minutesAgo(46),
        }),
      ),
    ).toEqual({ kind: 'park', reason: 'no CI result: missing lint, test' }));

  test('26: pending CI past the deadline with nothing missing parks no CI result', () =>
    expect(
      decide(mergeable({ checks: pending, requiredChecks: [], headFirstSeenAt: minutesAgo(46) })),
    ).toEqual({
      kind: 'park',
      reason: 'no CI result',
    }));

  test('26: a check still queued at the deadline is named as never started', () =>
    expect(
      decide(
        mergeable({
          checks: {
            state: 'pending',
            names: ['preflight', 'lint'],
            failed: [],
            queued: ['preflight'],
          },
          requiredChecks: ['preflight'],
          headFirstSeenAt: minutesAgo(46),
        }),
      ),
    ).toEqual({
      kind: 'park',
      reason:
        'no CI result: preflight queued and never started (is a runner available for its labels?)',
    }));

  test('26: a missing required check is named before a queued one', () =>
    expect(
      decide(
        mergeable({
          checks: { state: 'pending', names: ['lint'], failed: [], queued: ['lint'] },
          requiredChecks: ['lint', 'test'],
          headFirstSeenAt: minutesAgo(46),
        }),
      ),
    ).toEqual({ kind: 'park', reason: 'no CI result: missing test' }));

  test('27: a queued check before the deadline still waits', () =>
    expect(
      decide(
        mergeable({
          checks: { state: 'pending', names: ['preflight'], failed: [], queued: ['preflight'] },
          requiredChecks: ['preflight'],
          headFirstSeenAt: minutesAgo(5),
        }),
      ),
    ).toEqual({ kind: 'wait', on: 'ci' }));

  test('27: required check missing waits even when checks are green', () =>
    expect(
      decide(
        snap({
          verdictsOnHead: [approve('s')],
          checks: { state: 'success', names: ['lint'], failed: [] },
          requiredChecks: ['lint', 'test'],
        }),
      ),
    ).toEqual({ kind: 'wait', on: 'ci' }));

  test('27: pending CI waits', () =>
    expect(decide(mergeable({ checks: pending }))).toEqual({ kind: 'wait', on: 'ci' }));
});

test('a denied directory listing names the permission to grant', () =>
  expect(decide(snap({ forgeDenied: 'listDir' }))).toEqual({
    kind: 'park',
    reason: 'forge read denied: listDir (grant the author token Contents: read)',
  }));

describe('25: a merge reservation held by an older approved item', () => {
  const reserved = { mergeReservedBy: { itemId: 2, issueNumber: 257, since: minutesAgo(10) } };

  test('a merge becomes a wait on the reservation', () => {
    expect(decide(mergeable())).toEqual({ kind: 'merge', sha: 's' });
    expect(decide(mergeable(reserved))).toEqual({ kind: 'wait', on: 'merge-reservation' });
  });

  test('the wait counts toward no deadline: CI past its deadline still waits, never parks', () => {
    expect(decide(mergeable({ ...reserved, headFirstSeenAt: minutesAgo(600) }))).toEqual({
      kind: 'wait',
      on: 'merge-reservation',
    });
  });

  test('a resolve is unchanged', () => {
    const s = mergeable({ compare: cmp({ behindBy: 2, baseSha: 'b2' }), updateConflict: true });
    expect(decide({ ...s, ...reserved })).toEqual(decide(s));
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'resolve' });
  });

  test('a branch update is unchanged', () => {
    const s = mergeable({ compare: cmp({ behindBy: 2, baseSha: 'b2' }) });
    expect(decide({ ...s, ...reserved })).toEqual(decide(s));
    expect(decide(s)).toMatchObject({ kind: 'update_branch' });
  });

  test('a heal is unchanged', () => {
    const s = mergeable({ checks: failing, requiredChecks: [] });
    expect(decide({ ...s, ...reserved })).toEqual(decide(s));
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'heal' });
  });

  test('a review is unchanged', () => {
    const s = mergeable({ verdictsOnHead: [] });
    expect(decide({ ...s, ...reserved })).toEqual(decide(s));
    expect(decide(s)).toMatchObject({ kind: 'enqueue', role: 'review' });
  });

  test('a wait on CI is unchanged', () => {
    const s = mergeable({ checks: pending });
    expect(decide({ ...s, ...reserved })).toEqual({ kind: 'wait', on: 'ci' });
  });

  test('the CI deadline still parks missing CI', () => {
    const s = mergeable({ checks: pending, headFirstSeenAt: minutesAgo(46) });
    expect(decide({ ...s, ...reserved })).toEqual(decide(s));
    expect(decide(s)).toMatchObject({ kind: 'park' });
  });
});

describe('overlaps', () => {
  test('head change invalidates approval', () =>
    expect(decide(snap({ verdictsOnHead: [], pr: pr('sha2'), checks: ok, mergeOp: null }))).toEqual(
      {
        kind: 'enqueue',
        role: 'review',
        fingerprint: fingerprint(['sha2']),
      },
    ));

  test('request_changes then approve on the same sha never merges', () =>
    expect(decide(snap({ verdictsOnHead: [rc('s'), approve('s')], checks: ok })).kind).not.toBe(
      'merge',
    ));

  test('request_changes then approve on the same sha heals on the RC', () => {
    const r = rc('s');
    expect(decide(snap({ verdictsOnHead: [r, approve('s')], checks: ok }))).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', r.id]),
    });
  });

  test('merge failed on an old head: a null mergeOp for the new head is re-decided', () =>
    expect(
      decide(mergeable({ pr: pr('s2'), verdictsOnHead: [approve('s2')], mergeOp: null })),
    ).toEqual({
      kind: 'merge',
      sha: 's2',
    }));

  test('closed issue and behind base, or closed and RC, parks issue closed', () => {
    expect(decide(snap({ issueState: 'closed', compare: cmp({ behindBy: 4 }) }))).toEqual({
      kind: 'park',
      reason: 'issue closed',
    });
    expect(decide(snap({ issueState: 'closed', verdictsOnHead: [rc('s')] }))).toEqual({
      kind: 'park',
      reason: 'issue closed',
    });
  });

  test('protected path with RC and behind base parks before any heal or resolve', () =>
    expect(
      decide(
        snap({
          protectedHits: ['CODEOWNERS'],
          verdictsOnHead: [rc('s')],
          trustedChangeRequests: [humanRc(1, 'x')],
          compare: cmp({ behindBy: 2 }),
          checks: failing,
        }),
      ),
    ).toEqual({ kind: 'park', reason: 'protected path: CODEOWNERS' }));

  test('gate script change parks before a heal', () =>
    expect(
      decide(snap({ gateScriptChanges: ['package.json unreadable'], verdictsOnHead: [rc('s')] })),
    ).toEqual({
      kind: 'park',
      reason: 'gate script changed: package.json unreadable (not fully read: merge it by hand)',
    }));

  test('behind base and request_changes heals first', () => {
    expect(
      decide(snap({ verdictsOnHead: [rc('s')], compare: cmp({ behindBy: 1 }) })),
    ).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
    });
    expect(
      decide(snap({ trustedChangeRequests: [humanRc(5, 'y')], compare: cmp({ behindBy: 1 }) })),
    ).toMatchObject({ kind: 'enqueue', role: 'heal', feedback: { source: 'human' } });
  });

  test('human change requests heal before an agent RC', () =>
    expect(
      decide(snap({ trustedChangeRequests: [humanRc(5, 'y')], verdictsOnHead: [rc('s')] })),
    ).toMatchObject({
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint(['s', 'human', 5]),
    }));

  test('behind base and CI failure updates the branch first', () =>
    expect(decide(mergeable({ checks: failing, compare: cmp({ behindBy: 2 }) }))).toMatchObject({
      kind: 'update_branch',
    }));

  test('behind base updates the branch before the first review', () =>
    expect(decide(snap({ verdictsOnHead: [], compare: cmp({ behindBy: 2 }) }))).toMatchObject({
      kind: 'update_branch',
    }));

  test('behind base with a conflict mark resolves before the first review', () =>
    expect(
      decide(snap({ verdictsOnHead: [], compare: cmp({ behindBy: 2 }), updateConflict: true })),
    ).toMatchObject({ kind: 'enqueue', role: 'resolve' }));

  test('stale mergeable flag is never consulted: behindBy 0 gives no resolve', () => {
    const p = { ...pr('s'), mergeable: false } as PullFacts;
    expect(decide(mergeable({ pr: p, compare: cmp({ behindBy: 0 }) }))).toEqual({
      kind: 'merge',
      sha: 's',
    });
  });

  test('approved but the review post is missing or unknown never merges', () => {
    expect(decide(mergeable({ reviewOp: null })).kind).toBe('post_review');
    expect(decide(mergeable({ reviewOp: { state: 'unknown' } })).kind).toBe('wait');
  });

  test('a merge op in flight waits even with a fresh approval and green CI', () =>
    expect(decide(mergeable({ mergeOp: { state: 'pending' } }))).toEqual({
      kind: 'wait',
      on: 'outbox',
    }));
});

describe('purity', () => {
  test('the same snapshot always gives the same action and is not mutated', () => {
    const s = mergeable({
      verdictsOnHead: [rc('s'), approve('s')],
      trustedChangeRequests: [humanRc(3, 'z')],
    });
    const before = JSON.stringify(s);
    expect(decide(s)).toEqual(decide(s));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('reclaim window', () => {
  test('decide waits on a reclaimable heal drop', async () => {
    const at = new Date('2026-01-01T01:00:00Z');
    const w = zoneWorld();
    const id = w.prItem(1, 'sha1');
    const pass = async (when: Date) =>
      reconcileZone(
        w.db,
        w.forges,
        w.zone,
        await zonePass(w.forges, w.zone, 'main'),
        promptVersions(),
        usageCfg,
        [],
        when,
      );
    insertDrop(w.db, {
      id: 'heal1',
      dropZoneId: 'main',
      workItemId: id,
      role: 'heal',
      state: 'queued',
      prNumber: 1,
      headSha: 'sha1',
    });
    updateDrop(w.db, 'heal1', {
      state: 'lost',
      runningAt: new Date(at.getTime() - 10 * 60_000).toISOString(),
      finishedAt: new Date(at.getTime() - 60_000).toISOString(),
    });
    expect(reclaimableDropFor(w.db, id, at)?.id).toBe('heal1');
    await pass(at);
    // Nothing starts on the PR while the lost heal may still be salvaged.
    expect(activeDropFor(w.db, id)).toBeUndefined();
    // Once the window has passed, the PR is decided as today (its head gets a review).
    const later = new Date(at.getTime() + 15 * 60_000);
    expect(reclaimableDropFor(w.db, id, later)).toBeUndefined();
    await pass(later);
    expect(activeDropFor(w.db, id)).toMatchObject({ role: 'review', headSha: 'sha1' });
  });
});

describe('the goal file (#363)', () => {
  test('CLAIM=PROOF this is the only path that writes goalPath', async () => {
    // The pure rule: a PR touching GOAL.md parks, whatever else would let it merge.
    const hits = protectedPathHits([{ path: 'GOAL.md' }], DEFAULT_PROTECTED_PATHS);
    expect(decide(mergeable({ protectedHits: hits }))).toEqual({
      kind: 'park',
      reason: 'protected path: GOAL.md',
    });
    // Through a real pass (with the goal-change step in it): a work item whose PR touches GOAL.md,
    // approved and green, still parks and is never merged.
    // The zone as a config file gives it: the default protected paths, which hold the goal file.
    const w = zoneWorld({ protectedPaths: [...DEFAULT_PROTECTED_PATHS] });
    expect(w.zone.crew.goalPath).toBe('GOAL.md');
    const id = w.prItem(1, 'sha1');
    w.f.state.pullFiles.set(1, { files: [{ path: 'GOAL.md' }], complete: true });
    const item = getWorkItem(w.db, id);
    if (!item) throw new Error('no item');
    const pass = await zonePass(w.forges, w.zone, 'main');
    const s = await buildSnapshot(w.db, w.forges, w.zone, item, pass, t0);
    expect(decide({ ...s, verdictsOnHead: [approve('sha1')] })).toEqual({
      kind: 'park',
      reason: 'protected path: GOAL.md',
    });
    await reconcileZone(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, [], t0);
    expect(getWorkItem(w.db, id)).toMatchObject({
      state: 'parked',
      reason: 'protected path: GOAL.md',
    });
    expect(w.f.state.merges).toEqual([]);
  });
});
