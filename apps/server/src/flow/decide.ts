import type { DropZoneConfig } from '../config.js';
import type { Drop, VerdictRow, WorkItem } from '../db/repo.js';
import type { ChecksFacts, CompareFacts, ForgeReview, PullFacts } from '../forge/github.js';
import type { OpResult } from '../outbox.js';
import { fingerprint } from './budgets.js';

/** Everything `decide` may look at. Assembled fresh each pass; `decide` reads no other state. */
export const HOLD_REASON = 'held by jm:hold label';

export interface Snapshot {
  item: WorkItem;
  zone: DropZoneConfig;
  now: Date;
  activeDrop: Drop | null;
  pr: PullFacts | null;
  /** null = read failed. */
  issueState: 'open' | 'closed' | null;
  /** null = confirmed absent (404) only; a thrown read sets `forgeUnavailable` instead. */
  branchSha: string | null;
  /** null = read failed. */
  compare: CompareFacts | null;
  checks: ChecksFacts;
  /** Name of the first fresh read that threw (other than getPull); null when all reads succeeded. */
  forgeUnavailable: string | null;
  /** The first read refused with 403: a token permission problem, not a transient one. */
  forgeDenied: string | null;
  /** From BranchRules; [] when none. */
  requiredChecks: string[];
  /** Verdicts with headSha === pr.headSha, oldest first. */
  verdictsOnHead: VerdictRow[];
  /** post_review row of the latest verdict on head. */
  reviewOp: OpResult | null;
  /** Row merge:<itemId>:<pr.headSha>. */
  mergeOp: OpResult | null;
  /** Trusted non-bot authors whose latest review is CHANGES_REQUESTED on pr.headSha. */
  trustedChangeRequests: ForgeReview[];
  /** A trusted non-bot author's latest review is CHANGES_REQUESTED on another commit. */
  humanBlockStanding: boolean;
  /** The owner put the hold label on the PR: no agent work, approval or merge. */
  held: boolean;
  /** Changed paths (and rename sources) matching zone.protectedPaths. */
  protectedHits: string[];
  /** PullFiles.complete. */
  filesComplete: boolean;
  /** Gate-invoked scripts changed vs merge base; '<path> unreadable' for an unreadable package.json. */
  gateScriptChanges: string[];
  gateToolChanges: string[];
  /**
   * A trusted non-bot with maintain/admin (or in zone.overrideApprovers) has, as their latest
   * decisive review, APPROVED pr.headSha: gate script and gate tool changes do not park.
   */
  maintainerApproved: boolean;
  /** Command ruled `allow_gate_change` for exactly pr.headSha (a gate_allowances row). */
  commandAllowed: boolean;
  /**
   * Every gate change in full, for Command's briefing: scripts as `name: "<old>" → "<new>"`
   * (merge base → head), tool changes with old → new where the guard knows them.
   */
  gateDetails: { scripts: string[]; tools: string[] };
  /** The newest review's submittedAt on the PR (any author); null when there is none. */
  newestReviewAt: string | null;
  /** null = rules read unavailable; [] when safe or !zone.requireBranchProtection. */
  protectionProblems: string[] | null;
  headFirstSeenAt: string;
  /** work_items.waiting_since. */
  missingSince: string | null;
}

export type Feedback = { source: 'human' | 'review' | 'ci'; text: string };

export type Action =
  | { kind: 'wait'; on: 'drop' | 'ci' | 'forge' | 'outbox' }
  | {
      kind: 'enqueue';
      role: 'review' | 'heal' | 'resolve';
      fingerprint: string;
      feedback?: Feedback;
    }
  | { kind: 'post_review'; verdictId: string }
  | { kind: 'merge'; sha: string }
  | { kind: 'done'; reason: string }
  | { kind: 'park'; reason: string }
  | { kind: 'none' };

/** `now − anchor > zone.ciDeadlineMinutes`. A null anchor has no deadline yet. */
function pastDeadline(s: Snapshot, anchor: string | null): boolean {
  if (anchor === null) return false;
  return s.now.getTime() - Date.parse(anchor) > s.zone.ciDeadlineMinutes * 60_000;
}

/** The token permission each read needs, named in a denied-read park reason. */
const READ_PERMISSION: Record<string, string> = {
  checksFor: 'Commit statuses: read and Actions: read',
  listReviews: 'Pull requests: read',
  listPullFiles: 'Pull requests: read',
  branchSha: 'Contents: read',
  getFileAt: 'Contents: read',
  listDir: 'Contents: read',
};

export const DENIED_PREFIX = 'forge read denied: ';

export const OVERRIDE_HINT = ' (a maintainer can approve this head to allow it)';
export const GATE_PARK_PREFIXES = ['gate script changed: ', 'gate tool changed: '];
const MAX_CHANGE_LIST = 500;

const TRUNCATED = /; … \(\+\d+ more\)/;

/**
 * Whether a park reason is a gate park Command may allow: decide ends such a reason with
 * OVERRIDE_HINT only when the guard read every change it judged, and the list is not cut short
 * (Command must see every change it allows).
 */
export const gateParkAllowable = (reason: string): boolean =>
  GATE_PARK_PREFIXES.some((p) => reason.startsWith(p)) &&
  reason.endsWith(OVERRIDE_HINT) &&
  !TRUNCATED.test(reason);

/** The change list as a park reason shows it: capped, with a count of the rest. */
function changeList(changes: string[]): { list: string; truncated: boolean } {
  let list = '';
  let shown = 0;
  for (const c of changes) {
    const next = shown === 0 ? c : `${list}; ${c}`;
    if (shown > 0 && next.length > MAX_CHANGE_LIST) break;
    list = next;
    shown++;
  }
  if (shown < changes.length) list += `; … (+${changes.length - shown} more)`;
  return { list, truncated: shown < changes.length };
}

/**
 * Every change, so the approver sees them all, capped with a count of the rest. `allRead` is false
 * when any gate change on the head (listed here or not) was not fully read.
 */
function gateParkReason(what: string, changes: string[], allRead: boolean): string {
  const { list } = changeList(changes);
  // The hint is only offered when the guard read everything it judged.
  return `${what}: ${list}${allRead ? OVERRIDE_HINT : UNVERIFIED_NOTE}`;
}

const UNVERIFIED_NOTE = ' (not fully read: merge it by hand)';

/** A change the guard could not read: an unreadable, missing or unsupported file. */
const unverified = (c: string): boolean =>
  c.endsWith(' unreadable') ||
  c === 'lockfile not found' ||
  c.startsWith('lockfile format not supported: ');

/** Waits on missing forge data; past the deadline from `missingSince`, parks naming it. */
function waitForge(s: Snapshot, what: string): Action {
  return pastDeadline(s, s.missingSince)
    ? { kind: 'park', reason: `forge data missing: ${what}` }
    : { kind: 'wait', on: 'forge' };
}

type Finding = { severity?: unknown; file?: unknown; detail?: unknown };

function verdictFeedback(v: VerdictRow): string {
  let findings: Finding[] = [];
  try {
    const parsed: unknown = JSON.parse(v.findingsJson);
    if (Array.isArray(parsed)) findings = parsed as Finding[];
  } catch {
    // Unparseable findings: the summary alone is still useful feedback.
  }
  const lines = findings.map((f) => {
    const sev = typeof f.severity === 'string' ? `[${f.severity}] ` : '';
    const file = typeof f.file === 'string' ? `${f.file}: ` : '';
    return `- ${sev}${file}${String(f.detail ?? '')}`;
  });
  return [v.summary, ...lines].join('\n');
}

function humanFeedback(reviews: ForgeReview[]): string {
  return reviews
    .map((r) => r.body.trim())
    .filter((b) => b !== '')
    .join('\n\n');
}

function ciSatisfied(s: Snapshot): boolean {
  // With CI required, only named required checks count: an unrelated green check (a CLA bot)
  // must not stand in for CI that has not reported yet.
  if (s.zone.ciRequired && s.requiredChecks.length === 0) return false;
  if (s.checks.state === 'success')
    return s.requiredChecks.every((n) => s.checks.names.includes(n));
  return s.checks.state === 'none' && !s.zone.ciRequired && s.requiredChecks.length === 0;
}

/** The PR lifecycle state machine: first matching rule wins. Pure; reads no clock but `s.now`. */
export function decide(s: Snapshot): Action {
  // 1
  if (s.activeDrop) return { kind: 'wait', on: 'drop' };
  // 2: a failed read never becomes an empty list or a deleted branch.
  if (s.pr === null) return waitForge(s, 'pr');
  if (s.forgeDenied !== null) {
    const need = READ_PERMISSION[s.forgeDenied];
    const hint = need ? ` (grant the author token ${need})` : '';
    return { kind: 'park', reason: `${DENIED_PREFIX}${s.forgeDenied}${hint}` };
  }
  if (s.forgeUnavailable !== null) return waitForge(s, s.forgeUnavailable);
  const pr = s.pr;
  // 3
  if (pr.merged || s.mergeOp?.state === 'done') return { kind: 'done', reason: 'merged' };
  // 4
  if (pr.state === 'closed') return { kind: 'park', reason: 'pr closed' };
  // 5: GitHub lag, not an orphan.
  if (pr.headSha === null) return waitForge(s, 'head');
  const head = pr.headSha;
  // 6, 7
  if (s.mergeOp?.state === 'pending' || s.mergeOp?.state === 'unknown') {
    return { kind: 'wait', on: 'outbox' };
  }
  if (s.mergeOp?.state === 'failed') {
    return { kind: 'park', reason: `merge rejected: ${s.mergeOp.error ?? 'unknown error'}` };
  }
  // 8
  if (s.issueState === null) return waitForge(s, 'issue');
  if (s.compare === null) return waitForge(s, 'compare');
  const compare = s.compare;
  // 9
  if (s.issueState === 'closed') {
    return compare.aheadBy === 0
      ? { kind: 'done', reason: 'already on base' }
      : { kind: 'park', reason: 'issue closed' };
  }
  // 10
  if (s.branchSha === null) return { kind: 'park', reason: 'agent branch deleted' };
  // 11
  if (compare.aheadBy === 0) return { kind: 'done', reason: 'already on base' };
  // 12–15 park before any review or heal spend.
  if (s.protectedHits.length > 0) {
    return { kind: 'park', reason: `protected path: ${s.protectedHits[0]}` };
  }
  if (!s.filesComplete) return { kind: 'park', reason: 'protected path: file list truncated' };
  // A maintainer's approval of this exact head, or Command's ruling for it, lets gate changes
  // through; a push changes the head. A change the guard could not fully read is never
  // overridden: a person merges it by hand.
  const allRead = ![...s.gateScriptChanges, ...s.gateToolChanges].some(unverified);
  // Command's allowance counts only when its briefing listed every change (not cut short).
  const listed =
    !changeList(s.gateScriptChanges).truncated && !changeList(s.gateToolChanges).truncated;
  const overridable = (s.maintainerApproved || (s.commandAllowed && listed)) && allRead;
  if (s.gateScriptChanges.length > 0 && !overridable) {
    return {
      kind: 'park',
      reason: gateParkReason('gate script changed', s.gateScriptChanges, allRead),
    };
  }
  if (s.gateToolChanges.length > 0 && !overridable) {
    return {
      kind: 'park',
      reason: gateParkReason('gate tool changed', s.gateToolChanges, allRead),
    };
  }
  if (s.protectionProblems === null) return waitForge(s, 'branch rules');
  if (s.protectionProblems.length > 0) {
    return { kind: 'park', reason: `unsafe branch protection: ${s.protectionProblems.join('; ')}` };
  }
  // Above every enqueue, so a hold also stops agent pushes and spends no budget.
  if (s.held) return { kind: 'park', reason: HOLD_REASON };
  // 16
  if (s.trustedChangeRequests.length > 0) {
    return {
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint([head, 'human', ...s.trustedChangeRequests.map((r) => r.id)]),
      feedback: { source: 'human', text: humanFeedback(s.trustedChangeRequests) },
    };
  }
  // 17: an RC on this head blocks even a later approve on the same head.
  const latestRc = s.verdictsOnHead.findLast((v) => v.decision === 'request_changes');
  if (latestRc) {
    return {
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint([head, latestRc.id]),
      feedback: { source: 'review', text: verdictFeedback(latestRc) },
    };
  }
  // 18: forge `mergeable` is never read (§5.1).
  if (compare.behindBy > 0) {
    return { kind: 'enqueue', role: 'resolve', fingerprint: fingerprint([head, compare.baseSha]) };
  }
  // 19
  const latest = s.verdictsOnHead.at(-1);
  if (latest === undefined)
    return { kind: 'enqueue', role: 'review', fingerprint: fingerprint([head]) };
  // 20
  if (s.humanBlockStanding) return { kind: 'park', reason: 'human block stands' };
  // 21–23. Starter mode has no reviewer identity: the verdict on this head stays in Jumpmaster
  // (shown in the UI), and the merge below rests on it and CI alone.
  if (s.zone.identity !== 'starter') {
    if (s.reviewOp === null) return { kind: 'post_review', verdictId: latest.id };
    if (s.reviewOp.state === 'pending' || s.reviewOp.state === 'unknown') {
      return { kind: 'wait', on: 'outbox' };
    }
    if (s.reviewOp.state === 'failed') {
      return { kind: 'park', reason: `review post failed: ${s.reviewOp.error ?? 'unknown error'}` };
    }
  }
  // 24
  if (s.checks.state === 'failure') {
    return {
      kind: 'enqueue',
      role: 'heal',
      fingerprint: fingerprint([head, 'ci']),
      feedback: { source: 'ci', text: `CI failed on ${head}; reproduce with the gates and fix.` },
    };
  }
  // 25
  if (ciSatisfied(s)) return { kind: 'merge', sha: head };
  // 26
  if (pastDeadline(s, s.headFirstSeenAt)) {
    if (s.checks.state === 'none' && s.requiredChecks.length === 0) {
      return { kind: 'park', reason: 'no pipeline' };
    }
    const missing = s.requiredChecks.filter((n) => !s.checks.names.includes(n));
    if (missing.length > 0) {
      return { kind: 'park', reason: `no CI result: missing ${missing.join(', ')}` };
    }
    // A check that never left the queue usually means no runner matches its labels.
    const queued = s.checks.queued ?? [];
    const stuck =
      s.requiredChecks.length > 0 ? queued.filter((n) => s.requiredChecks.includes(n)) : queued;
    if (stuck.length > 0) {
      return {
        kind: 'park',
        reason: `no CI result: ${stuck.join(', ')} queued and never started (is a runner available for its labels?)`,
      };
    }
    return { kind: 'park', reason: 'no CI result' };
  }
  // 27
  return { kind: 'wait', on: 'ci' };
}
