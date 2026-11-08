import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  clearRequestChangesOnHead,
  deleteFailedOutbox,
  getParkMark,
  getPullRequest,
  getWorkItem,
  listOutbox,
  listWorkItems,
  resetAttempts,
  setDropZoneDefaultBranch,
  setParkMark,
  setRetryLabelSeen,
  setWorkItemState,
  upsertDropZone,
  upsertPullRequest,
  upsertWorkItem,
  type WorkItem,
} from './db/repo.js';
import { DENIED_PREFIX, decide, GATE_PARK_PREFIXES, HOLD_REASON } from './flow/decide.js';
import { buildSnapshot, newestReviewAt, type ZonePass, zonePass } from './flow/snapshot.js';
import type { ForgeIssue, PullFacts } from './forge/github.js';
import type { ForgePair } from './outbox.js';

const PRIORITY_LABELS = ['highest', 'high', 'low', 'lowest'] as const;
const PRIORITY_VALUE: Record<(typeof PRIORITY_LABELS)[number], number> = {
  highest: 0,
  high: 1,
  low: 3,
  lowest: 4,
};
const DEFAULT_PRIORITY = 2;

function priorityOf(labels: string[]): number {
  const names = new Set(labels.map((l) => l.toLowerCase()));
  for (const name of PRIORITY_LABELS) if (names.has(name)) return PRIORITY_VALUE[name];
  return DEFAULT_PRIORITY;
}

const isFixTitle = (title: string): boolean => /^fix:/i.test(title);

/** Orders by priority, then fix: items first, then oldest issue. Does not mutate the input. */
export function rankItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) =>
      a.priority - b.priority ||
      Number(b.isFix) - Number(a.isFix) ||
      Date.parse(a.issueCreatedAt) - Date.parse(b.issueCreatedAt),
  );
}

export type SyncResult = {
  added: number;
  skippedUntrusted: number;
  retried: number;
  reopened: number;
  /** The zone's rules read for this pass; hand it to `reconcileZone`. */
  pass: ZonePass;
};

/**
 * Syncs ready issues into work items, reads the zone pass once, then recovers parked items
 * (`syncParked`). The returned `pass` is reused by the reconciler, so rules are read once per pass.
 */
export async function syncDropZone(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<SyncResult> {
  const forge = forges.author;
  const defaultBranch = await forge.getDefaultBranch();
  const issues = await forge.listReadyIssues(zone.readyLabel);

  const trust = new Map<string, boolean>();
  for (const author of new Set(issues.map((i: ForgeIssue) => i.author))) {
    try {
      trust.set(author, await forge.isTrusted(author));
    } catch {
      trust.set(author, false); // intake fails closed: the issue is picked up on a later pass
    }
  }

  let added = 0;
  let skippedUntrusted = 0;
  const run = db.transaction(() => {
    upsertDropZone(db, {
      id: zone.id,
      repo: zone.repo,
      defaultBranch,
      configJson: JSON.stringify(zone),
    });
    setDropZoneDefaultBranch(db, zone.id, defaultBranch);

    const existing = new Map(listWorkItems(db, zone.id).map((w) => [w.issueNumber, w]));
    for (const issue of issues) {
      if (!trust.get(issue.author)) {
        skippedUntrusted++;
        continue;
      }
      upsertWorkItem(db, {
        dropZoneId: zone.id,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        author: issue.author,
        priority: priorityOf(issue.labels),
        isFix: isFixTitle(issue.title),
        issueCreatedAt: issue.createdAt,
        blockedBy: issue.blockedBy ?? [],
      });
      const prev = existing.get(issue.number);
      if (!prev) added++;
      else if (prev.state === 'done' && prev.reason === 'no longer ready') {
        setWorkItemState(db, prev.id, 'ready');
        added++;
      }
    }

    const listed = new Set(issues.map((i) => i.number));
    for (const w of listWorkItems(db, zone.id, 'ready'))
      if (!listed.has(w.issueNumber)) setWorkItemState(db, w.id, 'done', 'no longer ready');
  });
  run();
  const pass = await zonePass(forges, zone, defaultBranch);
  const parked = await syncParked(db, forges, zone, pass, now);
  return { added, skippedUntrusted, ...parked, pass };
}

async function readPull(forges: ForgePair, number: number | null): Promise<PullFacts | null> {
  if (number === null) return null;
  try {
    return await forges.author.getPull(number);
  } catch {
    return null;
  }
}

/** Puts an item back on the track its PR is on: open → pr_open, merged → done, gone → ready. */
function restoreFromPull(db: Db, item: WorkItem, pr: PullFacts | null, now: Date): void {
  if (pr?.merged) {
    setWorkItemState(db, item.id, 'done', 'merged', now);
    return;
  }
  if (pr && pr.state === 'open') {
    setWorkItemState(db, item.id, 'pr_open', undefined, now);
    return;
  }
  const row = getPullRequest(db, item.id);
  if (row) upsertPullRequest(db, { ...row, state: 'closed' }, now);
  setWorkItemState(db, item.id, 'ready', undefined, now);
}

/**
 * Recovers parked items whose cause is gone: the retry label (once per labelling), a reopened PR
 * or issue, a PR that merged after all, a lifted human block / fixed branch protection, forge
 * data that is readable again, or a maintainer's approval of a gate-changing head.
 */
const MERGE_RETRY_MS = 60 * 60_000;
const GATE_RECHECK_MS = 60 * 60_000;

/** Whether a gate-parked item has a review newer than the newest seen, or is due an hourly look. */
async function gateParkMayHaveChanged(
  db: Db,
  forges: ForgePair,
  itemId: number,
  prNumber: number | null,
  now: Date,
): Promise<boolean> {
  if (prNumber === null) return false;
  let newest: string;
  try {
    newest = newestReviewAt(await forges.author.listReviews(prNumber)) ?? '';
  } catch {
    return false;
  }
  const mark = getParkMark(db, itemId);
  const recent =
    mark.checkedAt !== null && now.getTime() - Date.parse(mark.checkedAt) < GATE_RECHECK_MS;
  if (recent && mark.reviewsSeen !== null && newest <= mark.reviewsSeen) return false;
  setParkMark(db, itemId, newest, now);
  return true;
}

export async function syncParked(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  now: Date,
): Promise<{ retried: number; reopened: number }> {
  let retried = 0;
  let reopened = 0;
  for (const item of listWorkItems(db, zone.id, 'parked')) {
    let labels: string[];
    try {
      labels = await forges.author.getIssueLabels(item.issueNumber);
    } catch {
      continue;
    }
    const prNumber = getPullRequest(db, item.id)?.number ?? item.prNumber;
    const hasRetry = labels.includes(zone.retryLabel);
    if (hasRetry && !item.retryLabelSeen) {
      // Read the PR before consuming the label: a failed read must not pass for a closed PR
      // (that would open a second one). The label stays unconsumed and is tried next pass.
      let pr: PullFacts | null = null;
      if (prNumber !== null) {
        try {
          pr = await forges.author.getPull(prNumber);
        } catch {
          continue;
        }
      }
      resetAttempts(db, item.id);
      deleteFailedOutbox(db, item.id);
      setRetryLabelSeen(db, item.id, true);
      // A stored request-changes on the head would re-heal the same findings; the owner may have
      // waived a criterion in the issue, so the head is reviewed afresh against the new body.
      if (pr?.state === 'open' && pr.headSha) clearRequestChangesOnHead(db, item.id, pr.headSha);
      restoreFromPull(db, item, pr, now);
      retried++;
      continue;
    }
    if (!hasRetry && item.retryLabelSeen) setRetryLabelSeen(db, item.id, false);

    // A PR merged by a human ends the item whatever it was parked for (budgets included).
    const pr = await readPull(forges, prNumber);
    if (pr?.merged) {
      setWorkItemState(db, item.id, 'done', 'merged', now);
      reopened++;
      continue;
    }

    const reason = item.reason ?? '';
    if (reason === 'pr closed' || reason === 'issue closed') {
      let issueOpen = false;
      try {
        issueOpen = (await forges.author.getIssueState(item.issueNumber)) === 'open';
      } catch {
        issueOpen = false;
      }
      if (pr?.state === 'open' && issueOpen) {
        setWorkItemState(db, item.id, 'pr_open', undefined, now);
        reopened++;
      }
    } else if (reason.startsWith('merge rejected')) {
      // A refusal on an unchanged head is often a human-clearable blocker (an unresolved
      // conversation, a dismissed approval). After an hour, forget the failed op and re-decide;
      // a merge that still fails parks again, costing one call per hour.
      const failed = listOutbox(db, ['failed']).filter(
        (o) => o.workItemId === item.id && o.kind === 'merge',
      );
      const age = (o: (typeof failed)[number]) => now.getTime() - Date.parse(o.updatedAt);
      if (failed.length > 0 && failed.every((o) => age(o) >= MERGE_RETRY_MS)) {
        deleteFailedOutbox(db, item.id, 'merge');
        setWorkItemState(db, item.id, 'pr_open', undefined, now);
        reopened++;
      }
    } else if (
      reason === 'human block stands' ||
      reason === HOLD_REASON ||
      reason.startsWith('unsafe branch protection') ||
      reason.startsWith('forge data missing') ||
      reason.startsWith(DENIED_PREFIX) ||
      // A maintainer's approval of the head lifts a gate park: re-decide only once a review newer
      // than the newest seen appears (one cheap read per pass), or hourly.
      (GATE_PARK_PREFIXES.some((p) => reason.startsWith(p)) &&
        (await gateParkMayHaveChanged(db, forges, item.id, prNumber, now)))
    ) {
      const fresh = getWorkItem(db, item.id);
      if (!fresh) continue;
      const action = decide(await buildSnapshot(db, forges, zone, fresh, pass, now));
      if (!(action.kind === 'park' && action.reason === reason)) {
        setWorkItemState(db, item.id, 'pr_open', undefined, now);
        reopened++;
      }
    }
  }
  return { retried, reopened };
}
