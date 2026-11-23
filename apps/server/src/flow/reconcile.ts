import { randomUUID } from 'node:crypto';
import { agentBranch, type GateResult, type Role, type Verdict } from '@jumpmaster/protocol';
import { applyPendingRulings, syncParkBriefings } from '../briefings.js';
import type { ClaudeConfig, DropZoneConfig, UsageConfig } from '../config.js';
import { flushCrewOps } from '../crew/flush.js';
import type { ImageFetchOpts } from '../crew/images.js';
import { applyArbitrations, applyCrewRetries } from '../crew/results.js';
import { enqueueCrew } from '../crew/schedule.js';
import { flushTriageTrail } from '../crew/trail.js';
import type { Db } from '../db/open.js';
import {
  addBranchUpdateFailure,
  deleteFailedOutbox,
  deleteOutbox,
  ensureZoneMode,
  forgeUpdatedFrom,
  getOutbox,
  getPullRequest,
  getWorkItem,
  getZoneMode,
  hasOpenCreatePr,
  holdingDropFor,
  insertDrop,
  insertVerdict,
  isKilled,
  listObservations,
  listWorkItems,
  recordObservation,
  setBranchUpdateOutcome,
  setParkMark,
  setWorkItemReason,
  setWorkItemState,
  upsertPullRequest,
  verdictsForItem,
  type WorkItem,
} from '../db/repo.js';
import type { PullFacts } from '../forge/github.js';
import { advanceGoalChanges, openGoalChanges } from '../goal-change.js';
import {
  type ForgePair,
  isServerPrBody,
  type MergePayload,
  opKeys,
  type PostReviewPayload,
  resolveUnknown,
  runOp,
  type UpdateBranchPayload,
  type UpdateBranchResult,
} from '../outbox.js';
import { renderReviewBody } from '../results.js';
import {
  enqueueImplement,
  enqueueNext,
  isBlocked,
  openPrCap,
  readyCandidates,
} from '../scheduler.js';
import { baseSyncExhausted, chargeBudget, creditBaseSync } from './budgets.js';
import {
  type Action,
  decide,
  GATE_PARK_PREFIXES,
  isReservationReason,
  reservationReason,
  type Snapshot,
} from './decide.js';
import { malformedRetryCharge } from './malformed.js';
import { buildSnapshot, loginIn, recordGateParkOf, type ZonePass } from './snapshot.js';

export type ReconcileReport = { actions: number; merges: number };

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/.test(e.message);

/** Thrown inside a transaction to roll it back without treating the pass as failed. */
class Rollback extends Error {}

const agentIssue = (headRef: string): number | null => {
  const m = /^agent\/issue-(\d+)$/.exec(headRef);
  return m ? Number(m[1]) : null;
};

/** A PR row that is not closed (a closed row is history: retry resumes past it). */
const hasLivePr = (db: Db, itemId: number): boolean => {
  const row = getPullRequest(db, itemId);
  return row !== undefined && row.state !== 'closed';
};

const parkReason = (db: Db, itemId: number, reason: string, now: Date): void =>
  setWorkItemState(db, itemId, 'parked', reason, now);

const handOpened = (n: number): string => `hand-opened PR on agent branch: #${n}`;

/** Step 2: adopt open agent PRs (an author login, same repo, marker or listing) for lost items. */
async function adopt(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  pulls: PullFacts[],
  now: Date,
): Promise<number> {
  const items = listWorkItems(db, zone.id);
  const refuse = (detail: string) =>
    recordObservation(db, zone.id, null, 'adopt_refused', detail, now);
  const listed = (n: number) => zone.adoptPulls.includes(n);
  const seen = new Set<number>();
  let adopted = 0;
  for (const pr of pulls) {
    seen.add(pr.number);
    const n = agentIssue(pr.headRef);
    if (n === null || pr.headSha === null) continue;
    if (!loginIn(pr.author, pass.authorLogins)) {
      if (listed(pr.number))
        refuse(`#${pr.number} is authored by ${pr.author}, not the author account`);
      continue;
    }
    const item = items.find((i) => i.issueNumber === n);
    if (!item) {
      if (listed(pr.number)) refuse(`#${pr.number} has no work item: label issue #${n} as ready`);
      continue;
    }
    const held = item.state === 'parked' && item.reason === handOpened(pr.number);
    if (item.state !== 'ready' && item.state !== 'in_flight' && !(held && listed(pr.number)))
      continue;
    // The author login alone isn't proof: it may be a person who also opens PRs by hand.
    if (!isServerPrBody(pr.body, item.id) && !listed(pr.number)) continue;
    // No branch is adopted under a drop that may still salvage onto it (Ruling 10).
    if (holdingDropFor(db, item.id, now) || hasLivePr(db, item.id)) continue;
    upsertPullRequest(
      db,
      {
        workItemId: item.id,
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        state: 'open',
      },
      now,
    );
    setWorkItemState(db, item.id, 'pr_open', undefined, now);
    adopted++;
  }
  for (const n of zone.adoptPulls) {
    if (!seen.has(n)) refuse(`#${n} is not an open agent PR`);
  }
  return adopted;
}

/** Step 3 (R12): continue implement work from a pushed agent branch that has no PR. */
async function resume(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  now: Date,
  unknown: Set<number>,
  pulls: PullFacts[],
  authorLogins: readonly string[],
): Promise<number> {
  let acted = 0;
  const observing = getZoneMode(db, zone.id, zone.mode) === 'observe';
  const candidates = listWorkItems(db, zone.id).filter(
    (i) =>
      (i.state === 'in_flight' || (i.state === 'ready' && !isBlocked(i))) &&
      !holdingDropFor(db, i.id, now) &&
      !hasLivePr(db, i.id) &&
      !hasOpenCreatePr(db, i.id),
  );
  for (const item of candidates) {
    let sha: string | null;
    try {
      sha = await forges.author.branchSha(agentBranch(item.issueNumber));
    } catch {
      unknown.add(item.id); // unknown: judge on a later pass, and never start it fresh meanwhile
      continue;
    }
    if (sha === null) {
      if (item.state === 'in_flight') {
        setWorkItemState(db, item.id, 'ready', undefined, now);
        acted++;
      }
      continue;
    }
    // `adopt` already took any PR with the server's marker, so an open one here isn't ours.
    const foreign = pulls.find((p) => p.headRef === agentBranch(item.issueNumber));
    const vouched =
      foreign && loginIn(foreign.author, authorLogins) && zone.adoptPulls.includes(foreign.number);
    if (foreign && !isServerPrBody(foreign.body, item.id) && !vouched) {
      if (observing) {
        recordObservation(db, zone.id, item.id, 'would_park', handOpened(foreign.number), now);
        unknown.add(item.id);
        continue;
      }
      parkReason(db, item.id, handOpened(foreign.number), now);
      acted++;
      continue;
    }
    const resumeSha = sha;
    if (observing) {
      // Recorded here, not in the charge transaction, so no budget moves and the row survives.
      recordObservation(db, zone.id, item.id, 'would_enqueue:resume', `branch at ${sha}`, now);
      unknown.add(item.id);
      continue;
    }
    try {
      db.transaction(() => {
        deleteFailedOutbox(db, item.id, 'create_pr');
        const charge = chargeBudget(db, item.id, 'resume', resumeSha, zone.budgets);
        if (!charge.ok) {
          parkReason(db, item.id, charge.reason, now);
          return;
        }
        const id = enqueueImplement(
          db,
          zone,
          item,
          { headSha: resumeSha, chargedKey: 'resume', promptVersion: versions.implement },
          usageCfg,
          now,
        );
        if (id === null) throw new Rollback();
      })();
      acted++;
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }
  return acted;
}

const CHARGE_KEY = { review: 'review', heal: 'heal', resolve: 'resolve' } as const;

function enqueue(
  db: Db,
  zone: DropZoneConfig,
  s: Snapshot,
  a: Extract<Action, { kind: 'enqueue' }>,
  versions: Record<Role, string>,
  now: Date,
): void {
  const item = s.item;
  try {
    db.transaction(() => {
      const headSha = s.pr?.headSha ?? null;
      // The retry of a malformed run (#659) reuses that drop's charge: it costs no budget.
      // Review keeps its own repeat budget (a failed review never parks), so only heal and resolve.
      const retry =
        a.role === 'review'
          ? undefined
          : malformedRetryCharge(db, item.id, a.role, a.fingerprint, headSha);
      const charge = retry
        ? ({ ok: true, charged: retry.chargedKey ? [retry.chargedKey] : [] } as const)
        : chargeBudget(db, item.id, CHARGE_KEY[a.role], a.fingerprint, zone.budgets);
      if (!charge.ok) {
        parkReason(db, item.id, charge.reason, now);
        return;
      }
      insertDrop(
        db,
        {
          id: randomUUID(),
          dropZoneId: zone.id,
          workItemId: item.id,
          role: a.role,
          state: 'queued',
          fingerprint: a.fingerprint,
          prNumber: s.pr?.number ?? null,
          headSha,
          inputJson: JSON.stringify({
            feedback: a.feedback ?? null,
            // A `ci` heal's code-scanning alerts (#652), raw: the payload builder fences them.
            ...(a.codeScanning ? { codeScanning: a.codeScanning } : {}),
            // Its GitHub Actions failure annotations (#720), raw: fenced by the payload builders.
            ...(a.ciAnnotations ? { ciAnnotations: a.ciAnnotations } : {}),
          }),
          promptVersion: versions[a.role],
          image: zone.image,
          chargedKey: charge.charged.join(',') || null,
          createdAt: now.toISOString(),
        },
        now,
      );
    })();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // already active: the charge rolled back with the insert
  }
}

/** The id a carried verdict gets: the same carry applied twice inserts one row. */
const carriedVerdictId = (fromVerdictId: string, headSha: string): string =>
  `carry:${fromVerdictId}:${headSha}`;

/**
 * Copies the source verdict to the new head (decide proved the change identical after merging the
 * base). The resolve that made the head spends `base_sync` instead of `resolve_total`, once.
 */
function carryVerdict(
  db: Db,
  s: Snapshot,
  a: Extract<Action, { kind: 'carry_verdict' }>,
  now: Date,
): void {
  const from = verdictsForItem(db, s.item.id).find((v) => v.id === a.fromVerdictId);
  if (!from) return; // gone (a new PR forgets verdicts): the next pass reviews the head
  db.transaction(() => {
    const inserted = insertVerdict(db, {
      id: carriedVerdictId(from.id, a.headSha),
      workItemId: s.item.id,
      headSha: a.headSha,
      decision: from.decision,
      forced: false,
      summary: `Carried from ${from.headSha.slice(0, 7)}: the change is identical after merging the base branch.\n\n${from.summary}`,
      findingsJson: from.findingsJson,
      gatesJson: from.gatesJson,
      createdAt: now.toISOString(),
    });
    // A head the forge brought up to date already spent its base_sync, and no resolve_total.
    if (inserted && !forgeUpdatedFrom(db, s.item.id, from.headSha)) creditBaseSync(db, s.item.id);
  })();
}

/** Failed update requests for one head and base before the resolve drop runs instead. */
export const UPDATE_BRANCH_TRIES = 3;

/**
 * Asks the forge to merge the base into the PR head, through the outbox (one request per item,
 * head and base). `updated` spends `base_sync` once and waits for the new head; `head_moved`
 * records nothing; a conflict, no push token, or the third failed request records the
 * `update_conflict` mark. Returns whether the mark was recorded, so the caller enqueues the
 * resolve drop now.
 */
async function updateBranch(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  s: Snapshot,
  a: Extract<Action, { kind: 'update_branch' }>,
  now: Date,
): Promise<boolean> {
  const item = s.item;
  if (!s.pr) return false;
  const conflict = () => setBranchUpdateOutcome(db, item.id, a.headSha, a.baseSha, 'conflict', now);
  // No push grant to write with: the agent path, never a wider token.
  if (!forges.pusher) return conflict();
  const opKey = opKeys.updateBranch(item.id, a.headSha, a.baseSha);
  if (!getOutbox(db, opKey) && baseSyncExhausted(db, item.id, zone.budgets)) {
    parkReason(db, item.id, 'budget exhausted: base-sync', now);
    return false;
  }
  const payload: UpdateBranchPayload = { pr: s.pr.number, headSha: a.headSha, baseSha: a.baseSha };
  const r = await runOp(
    db,
    forges,
    { kind: 'update_branch', opKey, zoneId: item.dropZoneId, itemId: item.id, payload },
    now,
  );
  if (r.state === 'done') {
    const result = r.result as UpdateBranchResult | undefined;
    switch (result?.kind) {
      case 'updated':
        db.transaction(() => {
          if (setBranchUpdateOutcome(db, item.id, a.headSha, a.baseSha, 'updated', now))
            chargeBudget(db, item.id, 'forge_update', opKey, zone.budgets);
        })();
        return false;
      case 'conflict':
      case 'no_token':
        return conflict();
      default:
        return false; // head_moved: the next pass reads the new head
    }
  }
  if (r.state === 'failed') {
    // Sent again on a later pass (the outbox reads the head back first); the third failure for
    // this head and base gives up on the forge, so the item never sticks here.
    return db.transaction(() => {
      deleteOutbox(db, opKey);
      const failures = addBranchUpdateFailure(db, item.id, a.headSha, a.baseSha, now);
      return failures >= UPDATE_BRANCH_TRIES && conflict();
    })();
  }
  return false; // pending or unknown: read back on a later pass
}

async function postReview(
  db: Db,
  forges: ForgePair,
  s: Snapshot,
  verdictId: string,
  secrets: string[],
  now: Date,
): Promise<void> {
  const v = s.verdictsOnHead.find((x) => x.id === verdictId);
  if (!v || !s.pr?.headSha) return;
  const verdict: Verdict = {
    decision: v.decision,
    summary: v.summary,
    findings: JSON.parse(v.findingsJson) as Verdict['findings'],
  };
  const gates = JSON.parse(v.gatesJson) as GateResult[];
  const payload: PostReviewPayload = {
    pr: s.pr.number,
    event: v.decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
    commitId: v.headSha,
    body: renderReviewBody(verdict, gates, secrets),
  };
  await runOp(
    db,
    forges,
    {
      kind: 'post_review',
      opKey: opKeys.review(s.item.id, v.headSha, v.id),
      zoneId: s.item.dropZoneId,
      itemId: s.item.id,
      payload,
    },
    now,
  );
}

async function merge(
  db: Db,
  forges: ForgePair,
  s: Snapshot,
  sha: string,
  now: Date,
): Promise<boolean> {
  if (!s.pr) return false;
  const payload: MergePayload = {
    pr: s.pr.number,
    sha,
    title: s.pr.title,
    message: `Closes #${s.item.issueNumber}`,
  };
  const r = await runOp(
    db,
    forges,
    {
      kind: 'merge',
      opKey: opKeys.merge(s.item.id, sha),
      zoneId: s.item.dropZoneId,
      itemId: s.item.id,
      payload,
    },
    now,
  );
  if (r.state === 'done') {
    upsertPullRequest(
      db,
      {
        workItemId: s.item.id,
        number: s.pr.number,
        headRef: s.pr.headRef,
        headSha: sha,
        state: 'merged',
      },
      now,
    );
    setWorkItemState(db, s.item.id, 'done', 'merged', now);
  }
  return true;
}

/** Observe mode's record of a decision, in place of performing it. */
function observeDecision(db: Db, zoneId: string, s: Snapshot, a: Action, now: Date): void {
  const head = `head ${s.pr?.headSha ?? 'unknown'}`;
  const note = (action: string, detail: string) =>
    recordObservation(db, zoneId, s.item.id, action, detail, now);
  switch (a.kind) {
    case 'enqueue':
      return note(`would_enqueue:${a.role}`, head);
    case 'post_review':
      return note('would_post_review', head);
    case 'carry_verdict':
      return note('would_carry_verdict', `${head} from verdict ${a.fromVerdictId}`);
    case 'merge':
      return note('would_merge', `sha ${a.sha}`);
    case 'update_branch':
      return note('would_update_branch', `${head} onto base ${a.baseSha}`);
    case 'park':
      return note('would_park', a.reason);
    case 'done':
      return note('would_done', a.reason);
    case 'wait':
    case 'none':
      return;
  }
}

/**
 * One reconcile pass for a zone (uses the given `pass`, never reads it itself): resolve unknown
 * outbox ops, adopt lost agent PRs, resume pushed branches, decide every pr_open item, then start
 * new implement work.
 */
export async function reconcileZone(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  secrets: string[],
  now: Date,
  crewImages?: ImageFetchOpts,
  opts: { claude?: ClaudeConfig } = {},
): Promise<ReconcileReport> {
  let actions = 0;
  let merges = 0;
  // A diagnose's CI failures section is redacted with the configured secrets (#720).
  const crewOpts = { ...opts, secrets };
  if (isKilled(db)) return { actions, merges };
  ensureZoneMode(db, zone.id, zone.mode, now);
  const mode = getZoneMode(db, zone.id, zone.mode);
  await resolveUnknown(
    db,
    forges,
    zone.id,
    now,
    zone.outboxDeadlineMinutes ?? zone.ciDeadlineMinutes,
  );
  if (mode === 'active') {
    // Rulings apply only while the zone acts; one made while paused waits for resume. They apply
    // before the flush, so a Reject recorded meanwhile beats a refute hold that has run out (also
    // on the first pass after the crew is enabled again).
    const deps = { forges: () => forges, zone: () => zone };
    actions += await applyPendingRulings(db, deps, zone.id, now);
    // A goal change proposed in the chat (or by a ruling just applied) opens as its PR.
    actions += await openGoalChanges(db, forges, zone, now);
    // A goal change the owner confirmed in the browser is approved and merged at that commit only.
    actions += await advanceGoalChanges(db, forges, zone, now);
    // An arbiter's acting ruling on a review disagreement: the item is retried, as Command's Retry.
    actions += await applyArbitrations(db, deps, zone.id, now);
    // The crew's one action on a parked item on its own diagnosis (#396, #420): a retry as
    // Command's Retry, or a re-run of failed checks then a retry; before the parked briefings, so
    // one it skips is briefed this pass.
    actions += await applyCrewRetries(db, deps, zone.id, now);
    actions += await flushCrewOps(db, forges, zone, secrets, now);
    // In the same pass that confirms crew issue numbers: a split's comment names its children.
    actions += await flushTriageTrail(db, forges, zone, secrets, now);
  }
  // After the rulings: a parked item is briefed on its state as they left it (a Retry has already
  // taken it out of parked), never on the state they were made about.
  syncParkBriefings(db, zone, now);
  const pulls = await forges.author.listOpenAgentPulls('agent/issue-');
  actions += await adopt(db, forges, zone, pass, pulls, now);
  if (mode === 'paused') return { actions, merges };
  const branchUnknown = new Set<number>();
  actions += await resume(
    db,
    forges,
    zone,
    versions,
    usageCfg,
    now,
    branchUnknown,
    pulls,
    pass.authorLogins,
  );

  for (const listed of listWorkItems(db, zone.id, 'pr_open')) {
    const item: WorkItem | undefined = getWorkItem(db, listed.id);
    if (!item) continue;
    const s = await buildSnapshot(db, forges, zone, item, pass, now);
    const a = decide(s);
    if (mode === 'observe') {
      observeDecision(db, zone.id, s, a, now);
      continue;
    }
    // A reserved-out item says whose merge it waits for (the /work list and the status line read
    // it); the reason goes as soon as the wait does.
    const reserved =
      a.kind === 'wait' && a.on === 'merge-reservation' && s.mergeReservedBy
        ? reservationReason(s.mergeReservedBy.issueNumber)
        : null;
    if (reserved !== item.reason && (reserved !== null || isReservationReason(item.reason))) {
      setWorkItemReason(db, item.id, reserved);
    }
    switch (a.kind) {
      case 'enqueue':
        enqueue(db, zone, s, a, versions, now);
        actions++;
        break;
      case 'carry_verdict':
        carryVerdict(db, s, a, now);
        actions++;
        break;
      case 'update_branch': {
        actions++;
        if (!(await updateBranch(db, forges, zone, s, a, now))) break;
        // The forge could not: the resolve drop runs now, as decide asks with the mark.
        const next = decide({ ...s, updateConflict: true });
        if (next.kind === 'enqueue') enqueue(db, zone, s, next, versions, now);
        break;
      }
      case 'post_review':
        // Starter mode never posts (decide doesn't ask); with no reviewer there is no one to post.
        if (forges.reviewer === null) break;
        await postReview(db, forges, s, a.verdictId, secrets, now);
        actions++;
        break;
      case 'merge':
        if (merges >= 1) break;
        if (await merge(db, forges, s, a.sha, now)) merges++;
        actions++;
        break;
      case 'park':
        parkReason(db, item.id, a.reason, now);
        // syncParked re-decides a gate park only once a newer review appears (or hourly).
        if (GATE_PARK_PREFIXES.some((p) => a.reason.startsWith(p))) {
          setParkMark(db, item.id, s.newestReviewAt ?? '', now);
          recordGateParkOf(db, s, now);
        }
        actions++;
        break;
      case 'done':
        setWorkItemState(db, item.id, 'done', a.reason, now);
        actions++;
        break;
      case 'wait':
      case 'none':
        break;
    }
  }

  if (mode === 'observe') {
    const ready = listWorkItems(db, zone.id, 'ready');
    for (const i of ready.filter(isBlocked)) {
      const detail = `blocked by ${i.blockedBy.join(', ')}`;
      recordObservation(db, zone.id, i.id, 'would_wait:blocked', detail, now);
    }
    // Observe runs no drops, so every slot is free except those a resume would take this pass.
    const resumes = listObservations(db, zone.id).filter(
      (o) => o.action === 'would_enqueue:resume' && o.lastAt === now.toISOString(),
    ).length;
    // The same holds as enqueueNext (#291): an open PR changing a file the Placement names, and
    // the zone's open PR cap.
    const candidates = readyCandidates(db, zone.id, branchUnknown);
    for (const { item: i, overlap } of candidates)
      if (overlap !== null)
        recordObservation(db, zone.id, i.id, 'would_wait:overlap', overlap, now);
    const capped = openPrCap(zone, listWorkItems(db, zone.id, 'pr_open').length) !== null;
    const slots = capped ? 0 : Math.max(0, (zone.maxConcurrentImplement ?? 1) - resumes);
    const picks = candidates.filter((c) => c.overlap === null).map((c) => c.item);
    for (const pick of picks.slice(0, slots)) {
      const detail = `issue #${pick.issueNumber}`;
      recordObservation(db, zone.id, pick.id, 'would_enqueue:implement', detail, now);
    }
    await enqueueCrew(db, forges, zone, pass, versions, usageCfg, now, crewImages, crewOpts);
    return { actions, merges };
  }
  if (enqueueNext(db, zone, versions.implement, usageCfg, now, branchUnknown) !== null) actions++;
  // Last, so crew work never takes a place ahead of finishing or implement work.
  if (
    (await enqueueCrew(db, forges, zone, pass, versions, usageCfg, now, crewImages, crewOpts)) !==
    null
  )
    actions++;
  return { actions, merges };
}
