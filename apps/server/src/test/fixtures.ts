import type { DropZoneConfig, UsageConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import {
  setWorkItemState,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { type FakeForge, type FakeForgeState, fakeForgePair } from './fakes.js';
import { tmpDbFile } from './helpers.js';

export const usageCfg: UsageConfig = { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] };

export function makeZone(o: Partial<DropZoneConfig> = {}): DropZoneConfig {
  return {
    id: 'main',
    repo: 'octo/demo',
    readyLabel: 'agent-ready',
    gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
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
    protectedPaths: ['.github/**', 'CODEOWNERS'],
    reviewReadToken: false,
    ...o,
  };
}

export interface ZoneWorld {
  db: Db;
  f: { author: FakeForge; reviewer: FakeForge; state: FakeForgeState };
  forges: { author: FakeForge; reviewer: FakeForge };
  zone: DropZoneConfig;
  item(n: number, state?: WorkItemState): number;
  prItem(n: number, headSha?: string, now?: Date): number;
}

/**
 * A zone DB plus a shared fake forge whose rules require one pinned `ci` check (so branch
 * protection is safe) and whose issues 1–5 are open with the ready label.
 */
export function zoneWorld(zoneOverrides: Partial<DropZoneConfig> = {}): ZoneWorld {
  const db: Db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  const issues = [1, 2, 3, 4, 5].map((n) => ({
    number: n,
    title: `Issue ${n}`,
    body: 'b',
    author: 'human',
    labels: ['agent-ready'],
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const f = fakeForgePair({ issues, trusted: ['human', 'author-bot', 'reviewer-bot'] });
  for (const id of ['author', 'reviewer'] as const) {
    f.state.rules[id] = {
      kind: 'ok',
      rules: {
        requiredApprovals: 1,
        dismissStaleOnPush: true,
        requiredChecks: ['ci'],
        unpinnedChecks: [],
        viewerCanBypass: false,
        viewerIsAdmin: false,
      },
    };
  }
  const zone = makeZone(zoneOverrides);
  const forges = { author: f.author, reviewer: f.reviewer };

  function item(n: number, state: WorkItemState = 'ready'): number {
    const wi = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: n,
      title: `Issue ${n}`,
      body: 'b',
      author: 'human',
      priority: 0,
      isFix: false,
      issueCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    setWorkItemState(db, wi.id, state);
    return wi.id;
  }

  /** A pr_open item with an open agent PR on `headSha`, CI green on it. */
  function prItem(n: number, headSha = `sha${n}`, now = new Date('2026-01-01T00:00:00Z')): number {
    const id = item(n, 'pr_open');
    f.state.addPull({ number: n, headRef: `agent/issue-${n}`, headSha, author: 'author-bot' });
    f.state.checks.set(headSha, { state: 'success', names: ['ci'] });
    upsertPullRequest(
      db,
      { workItemId: id, number: n, headRef: `agent/issue-${n}`, headSha, state: 'open' },
      now,
    );
    return id;
  }

  return { db, f, forges, zone, item, prItem };
}
