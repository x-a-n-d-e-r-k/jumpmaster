import { createHash } from 'node:crypto';
import { isBacklogIssue } from './backlog.js';
import { withdrawBriefing } from './briefings.js';
import { type DropZoneConfig, triageGateOn } from './config.js';
import { issueGateReasons } from './crew/actions.js';
import {
  getCrewIssueByNumber,
  listTriageRequests,
  recordTriageRequest,
  setTriageRequest,
  TRIAGE_WITHDRAWN,
} from './crew/store.js';
import type { Db } from './db/open.js';
import {
  clearRequestChangesOnHead,
  deleteFailedOutbox,
  getGateAllowance,
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
import {
  buildSnapshot,
  newestReviewAt,
  recordGateParkOf,
  type ZonePass,
  zonePass,
} from './flow/snapshot.js';
import type {
  ChecksFacts,
  ForgeIssue,
  IssueFacts,
  IssueStateReason,
  PullFacts,
} from './forge/github.js';
import { refreshGoals } from './goals.js';
import { confirmIntakeIssues } from './intake.js';
import { log } from './log.js';
import { type ForgePair, isJmIssueBody, runOp, type SetLabelsPayload } from './outbox.js';

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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Crew-filed: the body ends with a Jumpmaster issue marker, or the author is a bot by type or by
 * the zone's list. The marker decides whatever the login, since the author identity may be the
 * operator's own account.
 */
export function isCrewFiled(issue: ForgeIssue, zone: DropZoneConfig): boolean {
  if (isJmIssueBody(issue.body)) return true;
  // The extra signals apply only with the crew on, so an M2 zone's intake is unchanged.
  if (!zone.crew?.enabled) return false;
  return issue.authorType === 'Bot' || (zone.botLogins ?? []).includes(issue.author);
}

/**
 * A ready issue that still carries the staged label had its ready label added by hand: a
 * promotion swaps one for the other in a single write, so the two never meet otherwise.
 */
const isStagedAndReady = (issue: ForgeIssue, zone: DropZoneConfig): boolean =>
  zone.crew?.stagedLabel !== undefined && issue.labels.includes(zone.crew.stagedLabel);

/** Why a ready work item for a crew issue that is not (or no longer) promoted was retired. */
const CREW_NOT_PROMOTED = 'crew issue not promoted';

/**
 * Why a ready work item whose human issue fails the drop-ready format, or names a protected path,
 * was retired.
 */
const NEEDS_TRIAGE = 'needs triage';

/** Done reasons an item comes back from once its issue is admitted again. */
const REVIVABLE = new Set(['no longer ready', CREW_NOT_PROMOTED, NEEDS_TRIAGE]);

/**
 * One relabel per issue text: a re-run (or the ready label put back on the same text) finds the
 * op already recorded; an edit that still fails the format is sent to triage again.
 */
const triageOpKey = (zoneId: string, issue: ForgeIssue): string =>
  `labels:triage:${zoneId}:${issue.number}:${createHash('sha256')
    .update(`${issue.title}\n${issue.body}`)
    .digest('hex')
    .slice(0, 12)}`;

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
  /** Ready crew-filed issues with no recorded promotion: never started (§7.1). */
  skippedCrewUnpromoted: number[];
  /** Set when classifying an issue failed: this pass added nothing and marked nothing done. */
  intakeSkipped?: string;
  /** Trusted human ready issues held back for failing the drop-ready format (#183). */
  sentToTriage: number;
  retried: number;
  reopened: number;
  /** The zone's rules read for this pass; hand it to `reconcileZone`. */
  pass: ZonePass;
};

/**
 * Syncs ready issues into work items, reads the zone pass once, then recovers parked items
 * (`syncParked`). The returned `pass` is reused by the reconciler, so rules are read once per pass.
 */
/** Each zone's last sync result, kept in memory for the zone page (lost on restart). */
const lastSyncs = new Map<string, SyncResult>();

/** The zone's last sync result in this process, if any. */
export const lastSyncResult = (zoneId: string): SyncResult | undefined => lastSyncs.get(zoneId);

export async function syncDropZone(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<SyncResult> {
  const forge = forges.author;
  const defaultBranch = await forge.getDefaultBranch();
  const issues = await forge.listReadyIssues(zone.readyLabel);

  // Crew provenance first: a crew issue starts only once its promotion is recorded. An issue is
  // crew if a crew row of this zone has its number (whatever its body says now, and with the
  // crew on or off), if it is crew-filed by marker or author, or if it carries the staged label.
  const skippedCrewUnpromoted: number[] = [];
  const crewPromoted = new Set<number>();
  let intakeSkipped: string | undefined;
  try {
    // An intake issue whose create resolved after its request is promoted before it is judged.
    confirmIntakeIssues(db, zone.id, now);
    for (const issue of issues) {
      const row = getCrewIssueByNumber(db, zone.id, issue.number);
      const staged = isStagedAndReady(issue, zone);
      if (!row && !staged && !isCrewFiled(issue, zone)) continue;
      if (row?.state === 'promoted' && !staged) {
        crewPromoted.add(issue.number);
      } else {
        skippedCrewUnpromoted.push(issue.number);
      }
    }
  } catch (err) {
    intakeSkipped = `classifying ready issues failed: ${errorText(err)}`;
  }
  const crewNumbers = new Set([...crewPromoted, ...skippedCrewUnpromoted]);
  const human = intakeSkipped ? [] : issues.filter((i) => !crewNumbers.has(i.number));

  const trust = new Map<string, boolean>();
  for (const author of new Set(human.map((i: ForgeIssue) => i.author))) {
    try {
      trust.set(author, await forge.isTrusted(author));
    } catch {
      trust.set(author, false); // intake fails closed: the issue is picked up on a later pass
    }
  }

  let added = 0;
  let skippedUntrusted = 0;
  const gateOn = triageGateOn(zone);
  /** Gated issues to relabel once the transaction commits (forge writes are async). */
  const toTriage: ForgeIssue[] = [];
  /** Gated issues: their ready items are retired below. */
  const gated = new Set<number>();
  const run = db.transaction(() => {
    upsertDropZone(db, {
      id: zone.id,
      repo: zone.repo,
      defaultBranch,
      configJson: JSON.stringify(zone),
    });
    setDropZoneDefaultBranch(db, zone.id, defaultBranch);
    if (intakeSkipped) return;

    const existing = new Map(listWorkItems(db, zone.id).map((w) => [w.issueNumber, w]));
    for (const issue of issues) {
      if (skippedCrewUnpromoted.includes(issue.number)) continue;
      if (!crewPromoted.has(issue.number) && !trust.get(issue.author)) {
        skippedUntrusted++;
        continue;
      }
      const prev = existing.get(issue.number);
      // The triage gate: a trusted human issue only (crew-promoted ones were validated when
      // filed) that fails the drop-ready format or names a protected path the push check would
      // refuse. An item already in flight is left alone, with no relabel under it.
      if (
        gateOn &&
        !crewPromoted.has(issue.number) &&
        issueGateReasons(issue.title, issue.body, zone.protectedPaths).length > 0
      ) {
        if (prev && prev.state !== 'ready' && prev.state !== 'done') continue;
        gated.add(issue.number);
        toTriage.push(issue);
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
      if (!prev) added++;
      else if (prev.state === 'done' && REVIVABLE.has(prev.reason ?? '')) {
        setWorkItemState(db, prev.id, 'ready');
        added++;
      }
    }

    const listed = new Set(issues.map((i) => i.number));
    for (const w of listWorkItems(db, zone.id, 'ready')) {
      if (!listed.has(w.issueNumber)) setWorkItemState(db, w.id, 'done', 'no longer ready');
      // Admitted before it was known as crew (a window with no recorded number): it does not
      // start. An item already in flight is out of reach here.
      else if (skippedCrewUnpromoted.includes(w.issueNumber)) {
        setWorkItemState(db, w.id, 'done', CREW_NOT_PROMOTED);
      } else if (gated.has(w.issueNumber)) setWorkItemState(db, w.id, 'done', NEEDS_TRIAGE);
    }
  });
  run();
  for (const issue of toTriage) await sendToTriage(db, forges, zone, issue, now);
  if (zone.crew?.enabled) await recordTriage(db, forges, zone, now);
  // The ladder is read whenever a goal file is configured, crew on or off: one file read per
  // pass, no usage, and the goals page, the intake and MCP's get_goals rely on it.
  if (zone.crew?.goalPath) {
    try {
      await refreshGoals(db, forge, zone, defaultBranch, now);
    } catch (err) {
      // The last good ladder stays; the sync goes on.
      log(`zone ${zone.id}: reading ${zone.crew.goalPath} failed: ${errorText(err)}`);
    }
  }
  const pass = await zonePass(forges, zone, defaultBranch);
  const parked = await syncParked(db, forges, zone, pass, now);
  const result: SyncResult = {
    added,
    skippedUntrusted,
    skippedCrewUnpromoted,
    sentToTriage: toTriage.length,
    ...(intakeSkipped ? { intakeSkipped } : {}),
    ...parked,
    pass,
  };
  lastSyncs.set(zone.id, result);
  return result;
}

/**
 * Swaps the ready label for the triage label, once per issue text (the outbox op key). A write
 * refused before it is recorded (observe mode, the kill switch) is logged and tried again next
 * pass; a failed op is logged and stays failed. Either way the issue stays held back.
 */
async function sendToTriage(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  issue: ForgeIssue,
  now: Date,
): Promise<void> {
  const payload: SetLabelsPayload = {
    number: issue.number,
    add: [zone.triageLabel],
    remove: [zone.readyLabel],
  };
  try {
    const r = await runOp(
      db,
      forges,
      {
        kind: 'set_labels',
        opKey: triageOpKey(zone.id, issue),
        zoneId: zone.id,
        itemId: null,
        payload,
      },
      now,
    );
    if (r.state === 'failed') {
      log(`zone ${zone.id}: sending #${issue.number} to triage failed: ${r.error ?? ''}`);
    }
  } catch (err) {
    log(`zone ${zone.id}: sending #${issue.number} to triage: ${errorText(err)}`);
  }
}

/** Backlog-sent requests are recorded only while fewer open ones than this wait (#467). */
export const BACKLOG_TRIAGE_PACE = 3;

/**
 * Records a triage request for each open triage-labeled issue by a trusted author, once per body
 * text. With `crew.triageBacklog` on, open backlog issues (no Jumpmaster label or body) are sent
 * too, a few at a time, lowest number first, and an untouched open request whose issue has left
 * both listings is superseded. An untrusted author's issue, or one whose trust lookup failed, is
 * never recorded. A failed listing is logged and tried again next pass.
 */
async function recordTriage(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<void> {
  const trust = new Map<string, boolean>();
  /** Write access, read once per author per pass; a failed lookup counts as untrusted. */
  const trusted = async (login: string): Promise<boolean> => {
    let t = trust.get(login);
    if (t === undefined) {
      try {
        t = await forges.author.isTrusted(login);
      } catch {
        t = false;
      }
      trust.set(login, t);
    }
    return t;
  };
  const gateOn = triageGateOn(zone);
  /** Records the issue's current text; the same text gives the same gate reasons on either path. */
  const record = (issue: ForgeIssue): number | null => {
    // Why the gate holds it back, for the triage input.
    const reasons = gateOn ? issueGateReasons(issue.title, issue.body, zone.protectedPaths) : [];
    return recordTriageRequest(db, zone.id, issue, now, reasons);
  };

  let labeled: ForgeIssue[] | null = null;
  try {
    labeled = await forges.author.listOpenIssues(zone.triageLabel);
  } catch (err) {
    log(`zone ${zone.id}: listing triage issues failed: ${errorText(err)}`);
  }
  for (const issue of labeled ?? []) {
    if (isCrewFiled(issue, zone)) continue;
    if (!(await trusted(issue.author))) continue;
    record(issue);
  }

  if (!zone.crew?.triageBacklog) return;
  let open: ForgeIssue[];
  try {
    open = await forges.author.listOpenIssues();
  } catch (err) {
    log(`zone ${zone.id}: listing backlog issues failed: ${errorText(err)}`);
    return;
  }
  const backlog = open.filter((i) => isBacklogIssue(i, zone)).sort((a, b) => a.number - b.number);
  // An untouched request whose issue was closed, labeled ready or otherwise taken out of both
  // listings before its drop ran is withdrawn: nothing is written to the forge for it, and the
  // same text is sent again if the issue comes back (`recordTriageRequest` reopens it).
  if (labeled !== null) {
    const present = new Set([...backlog, ...labeled].map((i) => i.number));
    for (const r of listTriageRequests(db, zone.id)) {
      if (r.state === 'open' && r.attempts === 0 && !present.has(r.issueNumber))
        setTriageRequest(db, r.id, { state: 'done', reason: TRIAGE_WITHDRAWN }, now);
    }
  }
  const skip = new Set((zone.crew.backlogSkipLabels ?? []).map((l) => l.toLowerCase()));
  // Paced on the open requests for backlog issues only: label-sent ones are not limited.
  const inBacklog = new Set(backlog.map((i) => i.number));
  const openCount = (): number =>
    listTriageRequests(db, zone.id).filter(
      (r) => r.state === 'open' && inBacklog.has(r.issueNumber),
    ).length;
  for (const issue of backlog) {
    if (openCount() >= BACKLOG_TRIAGE_PACE) break;
    if (isCrewFiled(issue, zone)) continue;
    if (issue.labels.some((l) => skip.has(l.toLowerCase()))) continue;
    if (!(await trusted(issue.author))) continue;
    record(issue);
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
 * data that is readable again, or a maintainer's approval (or Command's allowance) of a
 * gate-changing head.
 */
const MERGE_RETRY_MS = 60 * 60_000;

/** How often a no-CI park probes its head's checks. */
const CI_PROBE_MS = 5 * 60_000;

/** A park on CI that hadn't reported by the deadline (decide step 26). */
const isNoCiPark = (reason: string): boolean =>
  reason === 'no pipeline' || reason.startsWith('no CI result');
const GATE_RECHECK_MS = 60 * 60_000;

/**
 * Whether a gate-parked item has a review newer than the newest seen, a Command allowance for its
 * head recorded since it was last re-decided, or is due an hourly look.
 */
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
  const row = getPullRequest(db, itemId);
  const allowance = row ? getGateAllowance(db, itemId, row.number, row.headSha) : undefined;
  const newAllowance =
    allowance !== undefined && (mark.checkedAt === null || allowance.ruledAt >= mark.checkedAt);
  if (recent && !newAllowance && mark.reviewsSeen !== null && newest <= mark.reviewsSeen) {
    return false;
  }
  setParkMark(db, itemId, newest, now);
  return true;
}

/**
 * What the retry label does to a parked item: attempts reset, failed ops forgotten, and the item
 * back on its PR's track. Returns false, changing nothing, when the PR can't be read.
 */
export async function retryParkedItem(
  db: Db,
  forges: ForgePair,
  item: WorkItem,
  now: Date,
): Promise<boolean> {
  const prNumber = getPullRequest(db, item.id)?.number ?? item.prNumber;
  // Read the PR before consuming the label: a failed read must not pass for a closed PR
  // (that would open a second one). The label stays unconsumed and is tried next pass.
  let pr: PullFacts | null = null;
  if (prNumber !== null) {
    try {
      pr = await forges.author.getPull(prNumber);
    } catch {
      return false;
    }
  }
  resetAttempts(db, item.id);
  deleteFailedOutbox(db, item.id);
  setRetryLabelSeen(db, item.id, true);
  // A stored request-changes on the head would re-heal the same findings; the owner may have
  // waived a criterion in the issue, so the head is reviewed afresh against the new body.
  if (pr?.state === 'open' && pr.headSha) clearRequestChangesOnHead(db, item.id, pr.headSha);
  restoreFromPull(db, item, pr, now);
  return true;
}

/** The done reason for an item whose issue was closed on the forge, from GitHub's state reason. */
function closedIssueReason(stateReason: IssueStateReason | undefined): string {
  if (stateReason === 'completed') return 'issue closed as completed';
  if (stateReason === 'not_planned') return 'issue closed as not planned';
  return 'issue closed';
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
      if (await retryParkedItem(db, forges, item, now)) retried++;
      continue;
    }
    if (!hasRetry && item.retryLabelSeen) setRetryLabelSeen(db, item.id, false);

    // A PR merged by a human ends the item whatever it was parked for (budgets included).
    // `prKnown` is false only when the PR read failed: a PR the forge no longer has reads `null`.
    let pr: PullFacts | null = null;
    let prKnown = true;
    if (prNumber !== null) {
      try {
        pr = await forges.author.getPull(prNumber);
      } catch {
        prKnown = false;
      }
    }
    if (pr?.merged) {
      setWorkItemState(db, item.id, 'done', 'merged', now);
      reopened++;
      continue;
    }

    // One issue read per parked item per pass; a failed read skips the item, as the label read.
    let issue: IssueFacts | null;
    try {
      issue = await forges.author.getIssue(item.issueNumber);
    } catch {
      continue;
    }
    if (!issue) continue;
    // An issue closed on the forge (by hand, say) ends the item when no open PR could still be
    // merged: nothing is written to the forge, and its parked briefing has nothing left to rule.
    if (issue.state === 'closed' && prKnown && pr?.state !== 'open') {
      setWorkItemState(db, item.id, 'done', closedIssueReason(issue.stateReason), now);
      withdrawBriefing(db, zone.id, `item:${item.id}`, now);
      reopened++;
      continue;
    }

    const reason = item.reason ?? '';
    if (reason === 'pr closed' || reason === 'issue closed') {
      if (pr?.state === 'open' && issue.state === 'open') {
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
    } else if (isNoCiPark(reason)) {
      // CI that reports after the deadline (a runner came back, a lost webhook) clears the park.
      // Probe the head's checks at most every few minutes; re-decide only once CI has finished,
      // and leave the park only for an outcome that acts on it (merge, heal, done). A wait (a
      // transient forge read) or another park keeps it parked, so nothing churns.
      if (!pr?.headSha) continue;
      const mark = getParkMark(db, item.id);
      if (mark.checkedAt !== null && now.getTime() - Date.parse(mark.checkedAt) < CI_PROBE_MS) {
        continue;
      }
      setParkMark(db, item.id, mark.reviewsSeen ?? '', now);
      let checks: ChecksFacts;
      try {
        checks = await forges.author.checksFor(pr.headSha);
      } catch {
        continue;
      }
      if (checks.state !== 'success' && checks.state !== 'failure') continue;
      const fresh = getWorkItem(db, item.id);
      if (!fresh) continue;
      const action = decide(await buildSnapshot(db, forges, zone, fresh, pass, now));
      if (action.kind !== 'park' && action.kind !== 'wait') {
        setWorkItemState(db, item.id, 'pr_open', undefined, now);
        reopened++;
      }
    } else if (
      reason === 'human block stands' ||
      reason === HOLD_REASON ||
      reason.startsWith('unsafe branch protection') ||
      reason.startsWith('forge data missing') ||
      reason.startsWith(DENIED_PREFIX) ||
      // A maintainer's approval of the head, or Command's allowance of it, lifts a gate park:
      // re-decide only once a review newer than the newest seen appears (one cheap read per
      // pass) or an allowance is recorded, or hourly.
      (GATE_PARK_PREFIXES.some((p) => reason.startsWith(p)) &&
        (await gateParkMayHaveChanged(db, forges, item.id, prNumber, now)))
    ) {
      const fresh = getWorkItem(db, item.id);
      if (!fresh) continue;
      const s = await buildSnapshot(db, forges, zone, fresh, pass, now);
      const action = decide(s);
      if (action.kind === 'park' && action.reason === reason) {
        // Still parked on the same changes, perhaps on a new head: brief what was judged now.
        if (GATE_PARK_PREFIXES.some((p) => reason.startsWith(p))) recordGateParkOf(db, s, now);
      } else {
        setWorkItemState(db, item.id, 'pr_open', undefined, now);
        reopened++;
      }
    }
  }
  return { retried, reopened };
}
