import { describe, expect, test } from 'vitest';
import type { DropZoneConfig } from '../config.js';
import type { Drop, VerdictRow, WorkItem } from '../db/repo.js';
import type { ChecksFacts, CompareFacts, ForgeReview, PullFacts } from '../forge/github.js';
import { t0 } from '../test/helpers.js';
import { fingerprint } from './budgets.js';
import { decide, type Snapshot } from './decide.js';

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

const ok: ChecksFacts = { state: 'success', names: ['ci'] };
const none: ChecksFacts = { state: 'none', names: [] };
const pending: ChecksFacts = { state: 'pending', names: [] };
const failing: ChecksFacts = { state: 'failure', names: ['test'] };

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
    forgeUnavailable: null,
    requiredChecks: [],
    verdictsOnHead: [],
    reviewOp: { state: 'done' },
    mergeOp: null,
    trustedChangeRequests: [],
    humanBlockStanding: false,
    protectedHits: [],
    filesComplete: true,
    gateScriptChanges: [],
    gateToolChanges: [],
    protectionProblems: [],
    headFirstSeenAt: now.toISOString(),
    missingSince: null,
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

  test('13: gate script change parks', () =>
    expect(decide(snap({ gateScriptChanges: ['scripts/test.sh', 'scripts/lint.sh'] }))).toEqual({
      kind: 'park',
      reason: 'gate script changed: scripts/test.sh',
    }));

  test('14: gate tool change parks', () =>
    expect(decide(snap({ gateToolChanges: ['node_modules/.bin/vitest'] }))).toEqual({
      kind: 'park',
      reason: 'gate tool changed: node_modules/.bin/vitest',
    }));

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

  test('18: behind base resolves', () =>
    expect(decide(snap({ compare: cmp({ behindBy: 3, baseSha: 'base9' }) }))).toEqual({
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

  test('25: green CI with every required check merges the head', () =>
    expect(
      decide(
        mergeable({
          checks: { state: 'success', names: ['lint', 'test'] },
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
          checks: { state: 'success', names: ['lint'] },
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

  test('27: required check missing waits even when checks are green', () =>
    expect(
      decide(
        snap({
          verdictsOnHead: [approve('s')],
          checks: { state: 'success', names: ['lint'] },
          requiredChecks: ['lint', 'test'],
        }),
      ),
    ).toEqual({ kind: 'wait', on: 'ci' }));

  test('27: pending CI waits', () =>
    expect(decide(mergeable({ checks: pending }))).toEqual({ kind: 'wait', on: 'ci' }));
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
      reason: 'gate script changed: package.json unreadable',
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

  test('behind base and CI failure resolves first', () =>
    expect(decide(mergeable({ checks: failing, compare: cmp({ behindBy: 2 }) }))).toMatchObject({
      kind: 'enqueue',
      role: 'resolve',
    }));

  test('behind base resolves before the first review', () =>
    expect(decide(snap({ verdictsOnHead: [], compare: cmp({ behindBy: 2 }) }))).toMatchObject({
      kind: 'enqueue',
      role: 'resolve',
    }));

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
