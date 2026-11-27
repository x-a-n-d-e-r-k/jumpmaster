import { randomUUID } from 'node:crypto';
import {
  type CrewOutput,
  type DropResult,
  isCrewRole,
  parseCrewOutput,
} from '@jumpmaster/protocol';
import {
  type RulingDeps,
  raiseBriefing,
  recordDiagnosis,
  whyBasis,
  withdrawBriefing,
} from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  appendEvents,
  type Drop,
  type DropState,
  getDrop,
  getPullRequest,
  getWorkItem,
  insertDrop,
  updateDrop,
} from '../db/repo.js';
import { ranOnFable } from '../fable.js';
import { chargeBudget, fingerprint } from '../flow/budgets.js';
import type { Feedback } from '../flow/decide.js';
import { log as serverLog } from '../log.js';
import type { ForgePair } from '../outbox.js';
import { type CrewInputJson, promptVersions } from '../payloads.js';
import { type ResultDeps, STALE_REASON } from '../results.js';
import { retryParkedItem } from '../sync.js';
import {
  applyCrewActions,
  applyCrewActionsTracked,
  isSecurityTouching,
  issueText,
  mainTexts,
  noteCopyCheck,
  protectedPathsNamed,
  validateIssueSpec,
} from './actions.js';
import { PROMOTE_OPTIONS, subjectOf } from './flush.js';
import { lastHealFeedback } from './inputs.js';
import { cutChars, MAX_REFUSED_CHARS } from './refused.js';
import {
  briefItemRuling,
  HEAL_EXHAUSTED,
  itemArbitrationFailed,
  raiseRefuteExhausted,
} from './schedule.js';
import {
  type CrewIssue,
  type CrewIssuePatch,
  type CrewRetry,
  claimArbitrationApply,
  claimCrewRetryApply,
  getArbitrationByDrop,
  getAuditByDrop,
  getCrewIssue,
  getCrewRetry,
  getTriageRequest,
  insertCrewRetry,
  insertDoneClaim,
  itemArbitrationSubject,
  listUnappliedCrewRetries,
  markCrewRerun,
  releaseArbitrationApply,
  releaseCrewRetryApply,
  setCrewIssue,
  setTriageRequest,
  settleArbitration,
  settleAudit,
  settleCrewRetry,
  unappliedItemArbitrations,
} from './store.js';

const log = (db: Db, drop: Drop, now: Date, message: string) =>
  appendEvents(db, drop.id, [{ ts: now.toISOString(), kind: 'log', data: { message } }]);

function finish(db: Db, drop: Drop, state: DropState, now: Date, message?: string): void {
  updateDrop(db, drop.id, { state });
  if (message) log(db, drop, now, message);
}

function storedWork(drop: Drop): CrewInputJson['work'] | null {
  try {
    return (JSON.parse(drop.inputJson ?? 'null') as CrewInputJson | null)?.work ?? null;
  } catch {
    return null;
  }
}

const labelOf = (issue: CrewIssue): string =>
  issue.number !== null ? `crew issue #${issue.number}` : `crew issue ${issue.key}`;

/**
 * Who passed a staged issue, a refute or an arbiter's ruling A, in the briefings' words: `found`
 * opens the decision, `reviewed` (Promote briefing) and `held` (hold notice) say what they did.
 */
export type ReviewWhy = { found: string; reviewed: string; held: string };

const REFUTE_WHY: ReviewWhy = {
  found: 'A reviewer found nothing to fix in',
  reviewed:
    'a second agent reviewed it against the code and the spec, looking for criteria that are ' +
    'wrong, vague or untestable, and found none.',
  held:
    'a second agent reviewed it against the code and the spec and found nothing wrong, vague or ' +
    'untestable.',
};

/**
 * A staged issue that passed review (a refute's `promote`, or an arbiter's ruling A). With
 * `crew.refutePromotes` on it becomes `promote_held`, ready after a one-minute hold unless Command rejects it;
 * off, it stays staged and Command gets a Promote briefing. Never further than a refute could.
 * With `attended`, it takes the off branch whatever the setting, and the why adds that line.
 */
export function promoteAfterReview(
  db: Db,
  deps: Pick<ResultDeps, 'zone'>,
  issue: CrewIssue,
  base: CrewIssuePatch,
  why: ReviewWhy,
  now: Date,
  attended?: string,
): void {
  const { zone } = deps;
  const subject = subjectOf(issue);
  const label = labelOf(issue);
  if (zone.crew.refutePromotes && attended === undefined) {
    // hold_until is set by the first active flush that sees it (one pass for Command).
    setCrewIssue(db, issue.id, { ...base, state: 'promote_held' }, now);
    raiseBriefing(
      db,
      {
        zoneId: zone.id,
        kind: 'promote_held',
        subject,
        decision: `${why.found} ${label}. It goes ahead in about a minute unless you reject it.`,
        why:
          `The crew filed ${label} as staged, and ${why.held} This project lets a passing review ` +
          'promote (crew.refutePromotes is on), so you only need to act to stop it.',
        options: [
          { id: 'reject', label: 'Reject', effect: 'reject_issue' },
          { id: 'promote', label: 'Promote now', effect: 'promote_issue' },
        ],
        onHold: label,
        source: 'server',
      },
      now,
    );
    return;
  }
  setCrewIssue(db, issue.id, base, now);
  raiseBriefing(
    db,
    {
      zoneId: zone.id,
      kind: 'promote',
      subject,
      decision: `${why.found} ${label}. Promote it so an agent can start?`,
      why:
        `The crew filed ${label} as staged, so no agent works on it yet. ${capitalise(why.reviewed)} ` +
        'Promote gives it the ready label; Reject closes it. To let a passing ' +
        'review promote on its own, with a notice you can still reject, set crew.refutePromotes ' +
        `for this project: jumpmaster ctl zones set ${zone.id} crew.refutePromotes=true` +
        (attended === undefined ? '' : `\n${attended}`),
      options: PROMOTE_OPTIONS,
      onHold: label,
      source: 'server',
    },
    now,
  );
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

type RefuteWork = Extract<CrewInputJson['work'], { role: 'refute' }>;

/** The why's extra line for a security-touching issue whose review did not run on Fable. */
export const SECURITY_NO_FABLE =
  'This issue is security-touching and its review ran without Fable.';

/**
 * A security-touching issue (the flag stored at enqueue or its body's section: either is enough)
 * refuted by a drop that did not run on Fable, as the server recorded it (requested and served
 * model, never the agent's word). With no claude config nothing says what Fable is: it fails
 * closed, as not on Fable.
 */
function withoutFable(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: RefuteWork,
  issue: CrewIssue,
): boolean {
  if (work.securityTouching !== true && !isSecurityTouching(issue.body)) return false;
  const recorded = getDrop(db, drop.id) ?? drop;
  return !deps.claude || !ranOnFable({ claude: deps.claude }, recorded);
}

/**
 * A refute's verdict on a staged crew issue. Nothing happens if the issue has moved on. A revise
 * at the refute budget is kept like any other: once staged again, the schedule's exhausted step
 * (the one place a refute_exhausted briefing is raised) judges the revised text.
 */
function applyRefute(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: RefuteWork,
  issue: CrewIssue,
  out: CrewOutput['refute'],
  now: Date,
): void {
  if (issue.state !== 'staged') return;
  const { zone } = deps;
  const base = {
    refutedSha: issue.bodySha,
    findingsJson: JSON.stringify(out.findings),
  };

  if (out.decision === 'promote') {
    const attended = withoutFable(db, deps, drop, work, issue) ? SECURITY_NO_FABLE : undefined;
    promoteAfterReview(db, deps, issue, base, REFUTE_WHY, now, attended);
    return;
  }

  if (out.decision === 'revise') {
    const title = out.revisedTitle ?? issue.title;
    const body = out.revisedBody ?? issue.body;
    const revised = out.revisedTitle !== undefined || out.revisedBody !== undefined;
    const copied = revised
      ? noteCopyCheck(db, zone.id, mainTexts(db, zone.id))(issueText(title, body))
      : null;
    if (
      revised &&
      copied === null &&
      validateIssueSpec(title, body).length === 0 &&
      protectedPathsNamed(body, zone.protectedPaths).length === 0
    ) {
      setCrewIssue(db, issue.id, { ...base, state: 'revising', title, body }, now);
      return;
    }
    // A revision that is missing, not in the drop-ready format, naming a protected path or
    // copying a ruling note counts as a rejection. The note refusal joins the findings: it names
    // the ruling, never the note's words.
    if (copied !== null) {
      const findings = [...out.findings, `revision refused: ${copied}`];
      setCrewIssue(
        db,
        issue.id,
        { ...base, findingsJson: JSON.stringify(findings), state: 'rejecting' },
        now,
      );
      return;
    }
  }
  setCrewIssue(db, issue.id, { ...base, state: 'rejecting' }, now);
}

/** An acting ruling A, in the briefings' words: the drop page has the full ruling. */
const arbiterWhy = (dropId: string): ReviewWhy => {
  const did =
    "a Fable arbiter weighed every reviewer's findings against the code after the refutes ran " +
    `out, and ruled it complete, unambiguous and safe to implement (full ruling: /drops/${dropId}).`;
  return { found: 'A Fable arbiter found nothing to fix in', reviewed: did, held: did };
};

type ArbitrateWork = Extract<CrewInputJson['work'], { role: 'arbitrate' }>;
type IssueArbitrateWork = Extract<ArbitrateWork, { subject: 'issue' }>;
type ItemArbitrateWork = Extract<ArbitrateWork, { subject: 'item' }>;

/** The crew issue an arbitration judged, if it is still staged with the text judged. */
function judgedIssue(db: Db, work: IssueArbitrateWork): CrewIssue | undefined {
  const issue = getCrewIssue(db, work.crewIssueId);
  return issue && issue.state === 'staged' && issue.bodySha === work.basis ? issue : undefined;
}

/**
 * An arbitrate drop that came to nothing (rate-limited, failed, invalid output): its arbitration
 * is `failed` with the reason and Command is asked as before: on a crew issue that still reads as
 * judged, its refute_exhausted briefing; on an item, its parked briefing carries the reason as its
 * diagnosis. Fails closed: nothing is promoted or retried.
 */
function arbitrationFailed(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: ArbitrateWork,
  reason: string,
  now: Date,
): void {
  const row = getArbitrationByDrop(db, drop.id);
  if (!row) return;
  if (work.subject === 'item') {
    itemArbitrationFailed(db, row, reason, now);
    return;
  }
  if (!settleArbitration(db, row.id, { state: 'failed', reason }, now)) return;
  const issue = judgedIssue(db, work);
  if (issue) raiseRefuteExhausted(db, deps.zone, issue, now);
}

/**
 * Why a ruling may not act, if it may not: only a ruling A or B that is reversible, is not a
 * product question, and ran on Fable as the server recorded it (never what the agent says it ran
 * on) acts. The same rule for a crew issue and an item.
 */
function noActReason(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  out: CrewOutput['arbitrate'],
): string | undefined {
  const recorded = getDrop(db, drop.id) ?? drop;
  return out.ruling === 'insufficient_evidence'
    ? 'insufficient evidence'
    : !out.reversible
      ? 'not reversible'
      : out.productQuestion
        ? 'a product question'
        : // No claude config: nothing says what Fable is here, so it fails closed.
          !deps.claude || !ranOnFable({ claude: deps.claude }, recorded)
          ? 'did not run on Fable'
          : undefined;
}

/**
 * An arbiter's ruling on a crew issue that ran out of refutes. Settled once, from `pending` only. A
 * ruling on a text that changed (or an issue no longer staged) is discarded. It acts only by
 * `noActReason`'s rule: A promotes as a passing refute would, B rejects. Anything else is put to
 * Command, with the reason in the briefing's why. Returns a note for the drop's log, if any.
 */
export function applyIssueArbitration(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: IssueArbitrateWork,
  out: CrewOutput['arbitrate'],
  now: Date,
): string | undefined {
  const row = getArbitrationByDrop(db, drop.id);
  if (!row || row.state !== 'pending') return 'ruling not applied: its arbitration is settled';
  const issue = judgedIssue(db, work);
  if (!issue) {
    const reason = 'the issue changed or moved on since it was asked';
    settleArbitration(db, row.id, { state: 'discarded', reason }, now);
    return `ruling discarded: ${reason}`;
  }
  const reason = noActReason(db, deps, drop, out);
  const acts = reason === undefined;
  const settled = settleArbitration(
    db,
    row.id,
    {
      state: 'ruled',
      ruling: out.ruling,
      acted: acts,
      because: out.because,
      instruction: out.instruction,
      ...(reason !== undefined ? { reason } : {}),
    },
    now,
  );
  if (!settled) return undefined;
  if (!acts) {
    raiseRefuteExhausted(db, deps.zone, issue, now);
    return `ruling ${out.ruling} not acted on: ${reason}`;
  }
  const base = { refutedSha: issue.bodySha };
  if (out.ruling === 'A') {
    promoteAfterReview(db, deps, issue, base, arbiterWhy(drop.id), now);
  } else {
    setCrewIssue(db, issue.id, { ...base, state: 'rejecting' }, now);
  }
  return undefined;
}

/** A ruling's side, in the parked briefing's words. */
const ITEM_SIDE = {
  A: 'for the reviewer: the change does not yet meet the issue',
  B: 'for the author: the change meets the issue, and the remaining findings are not defects',
} as const;

/**
 * An arbiter's ruling on a review disagreement (a parked item whose heals ran out). Settled once,
 * from `pending` only. A ruling on an item no longer parked on its heals, or whose PR head moved
 * from the one in dispute, is discarded. One that acts (`noActReason`) is only recorded here:
 * `applyArbitrations` retries the item next pass, as Command's Retry. One that does not becomes
 * the parked briefing's diagnosis, and the item stays parked. Returns a note for the drop's log.
 */
export function applyItemArbitration(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: ItemArbitrateWork,
  out: CrewOutput['arbitrate'],
  now: Date,
): string | undefined {
  const row = getArbitrationByDrop(db, drop.id);
  if (!row || row.state !== 'pending') return 'ruling not applied: its arbitration is settled';
  const item = getWorkItem(db, work.itemId);
  const pr = getPullRequest(db, work.itemId);
  if (
    !item ||
    item.state !== 'parked' ||
    item.reason !== HEAL_EXHAUSTED ||
    !pr ||
    pr.state !== 'open' ||
    pr.headSha !== work.headSha
  ) {
    const reason = 'the item moved on since it was asked';
    settleArbitration(db, row.id, { state: 'discarded', reason }, now);
    return `ruling discarded: ${reason}`;
  }
  const reason = noActReason(db, deps, drop, out);
  const acts = reason === undefined;
  const settled = settleArbitration(
    db,
    row.id,
    {
      state: 'ruled',
      ruling: out.ruling,
      acted: acts,
      because: out.because,
      instruction: out.instruction,
      ...(reason !== undefined ? { reason } : {}),
    },
    now,
  );
  if (!settled || acts) return undefined;
  const ruled =
    out.ruling === 'insufficient_evidence'
      ? 'The arbiter found the evidence insufficient to rule'
      : `The arbiter ruled ${ITEM_SIDE[out.ruling]}`;
  briefItemRuling(
    db,
    item.id,
    `${ruled} (not acted on: ${reason}). ${out.because}`,
    out.instruction.trim() !== '' ? out.instruction : (reason ?? ''),
    now,
  );
  return `ruling ${out.ruling} not acted on: ${reason}`;
}

/**
 * Applies the zone's acting item rulings, each once: a still-parked item is retried exactly as
 * Command's Retry does (`retryParkedItem`: attempts reset, the request-changes on its head
 * cleared, so the head is reviewed afresh). It never approves or merges: the item still needs an
 * approving verdict on its head and CI. `applied_at` is claimed first, so two passes retry once; a
 * PR that can't be read releases it for the next pass. Returns how many were applied.
 */
export async function applyArbitrations(
  db: Db,
  deps: { forges(zoneId: string): ForgePair },
  zoneId: string,
  now: Date,
): Promise<number> {
  let applied = 0;
  for (const row of unappliedItemArbitrations(db, zoneId)) {
    if (!claimArbitrationApply(db, row.id, now)) continue;
    const item = getWorkItem(db, Number(row.subject.slice('item:'.length)));
    if (item?.state === 'parked' && !(await retryParkedItem(db, deps.forges(zoneId), item, now))) {
      releaseArbitrationApply(db, row.id, now);
      continue;
    }
    applied++;
  }
  return applied;
}

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && 'code' in e && String(e.code).startsWith('SQLITE_CONSTRAINT');

/** The park reasons of an item with an open PR the crew may act on (#420), besides heals. */
const PR_PARK_REASONS = new Set(['budget exhausted: resolve', 'budget exhausted: base-sync']);
/** The park of a heal that changed nothing on findings it had already seen. */
export const HEAL_NO_CHANGES = 'heal made no changes for the same findings';
/** The reason of a heal that failed a gate, and so did not push (`roles/heal.ts` in the trooper). */
const HEAL_GATE_FAILED = /^gate .+ failed$/;
/** The gate-script guard's park reason opens with this (`flow/guards.ts`, `decide`). */
export const GATE_SCRIPT_PARK = 'gate script changed: ';

/**
 * Which crew action a parked item allows: `implement` for a failed first implementation with no
 * pull request (#396); `pr` for an item with an open PR parked on a resolve or base-sync budget,
 * by a heal on CI feedback that changed nothing or stopped blocked (#420), or by a heal on any
 * feedback that failed a gate and pushed nothing (#675); `gate` for a
 * gate-script park, which the crew may only retry to remove the change.
 */
export type CrewParkKind = 'implement' | 'pr' | 'gate';

/**
 * The crew action the item allows, if any: `crew.autoRetry` on, the item parked in the zone, no
 * crew action ever recorded for it, and a park the crew may act on (`CrewParkKind`). Read from
 * server-recorded rows only, never from an agent's report. A heal park counts only when the newest
 * heal's stored feedback came from CI (a review's findings are the arbiter's, a person's are
 * theirs), or when that heal failed a gate and the PR head is still the one it started from:
 * nothing was pushed, so there is nothing to arbitrate. A human hold, a hand-opened conflict, a `no_changes` implement, credits, the heal budget
 * (a review disagreement) or any other reason allows none.
 */
export function crewParkKind(db: Db, zone: DropZoneConfig, itemId: number): CrewParkKind | null {
  return getCrewRetry(db, itemId) === undefined ? parkKind(db, zone, itemId) : null;
}

/** `crewParkKind` before the one-per-item cap, which the schema enforces when it is recorded. */
function parkKind(db: Db, zone: DropZoneConfig, itemId: number): CrewParkKind | null {
  if (!zone.crew.autoRetry) return null;
  const item = getWorkItem(db, itemId);
  if (!item || item.dropZoneId !== zone.id || item.state !== 'parked') return null;
  const pr = getPullRequest(db, itemId);
  const newest = db
    .prepare(
      `SELECT role, state, head_sha AS headSha, result_json AS resultJson FROM drops
       WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as
    | { role: string; state: string; headSha: string | null; resultJson: string | null }
    | undefined;
  if (item.prNumber === null && pr === undefined) {
    return newest?.role === 'implement' && newest.state === 'failed' ? 'implement' : null;
  }
  if (pr?.state !== 'open' || !pr.headSha) return null;
  const reason = item.reason ?? '';
  if (PR_PARK_REASONS.has(reason)) return 'pr';
  if (reason.startsWith(GATE_SCRIPT_PARK)) return 'gate';
  const ciHeal = lastHealFeedback(db, itemId)?.source === 'ci';
  if (reason === HEAL_NO_CHANGES) return ciHeal ? 'pr' : null;
  if (newest?.role !== 'heal') return null;
  let result: { status?: unknown; reason?: unknown } = {};
  try {
    result = (JSON.parse(newest.resultJson ?? '{}') ?? {}) as typeof result;
  } catch {
    return null;
  }
  // A heal that failed a gate pushed nothing when the head is still the one it started from:
  // a retry starts from the same head, whoever's feedback it answered (#675).
  if (
    newest.state === 'failed' &&
    typeof result.reason === 'string' &&
    HEAL_GATE_FAILED.test(result.reason) &&
    reason === result.reason &&
    newest.headSha !== null &&
    newest.headSha === pr.headSha
  ) {
    return 'pr';
  }
  if (!ciHeal) return null;
  const parkedFor = typeof result.reason === 'string' ? result.reason : 'blocked';
  if (result.status === 'blocked' && reason === parkedFor) return 'pr';
  return null;
}

/** Whether the crew may act on the parked item on its own diagnosis (`crewParkKind`). */
export function crewMayRetry(db: Db, zone: DropZoneConfig, itemId: number): boolean {
  return crewParkKind(db, zone, itemId) !== null;
}

type DiagnoseWork = Extract<CrewInputJson['work'], { role: 'diagnose' }>;

/** Stale diagnose failures rerun per briefing before one counts as its attempt (#709, D3). */
export const MAX_DIAGNOSE_STALE_RERUNS = 2;

/**
 * A diagnose drop that failed only because the item's head moved while it ran (`STALE_REASON`)
 * gives its attempt back, so the next pass diagnoses afresh at the current basis: only while the
 * briefing is still the open park on the item, and at most `MAX_DIAGNOSE_STALE_RERUNS` times per
 * briefing (the stored counter bounds a head that keeps moving). Any other failure is the attempt.
 */
function rerunStaleDiagnose(db: Db, work: DiagnoseWork, result: DropResult): void {
  if (result.status !== 'failed' || !STALE_REASON.test(result.reason ?? '')) return;
  db.prepare(
    `UPDATE briefings SET diagnose_attempts = diagnose_attempts - 1,
       diagnose_stale_reruns = diagnose_stale_reruns + 1
     WHERE id = ? AND state = 'open' AND kind = 'parked' AND subject = ?
       AND diagnose_attempts > 0 AND diagnose_stale_reruns < ?`,
  ).run(work.briefingId, itemArbitrationSubject(work.itemId), MAX_DIAGNOSE_STALE_RERUNS);
}

/**
 * Records a diagnosis on the parked briefing it was asked for, beside the server's why, if that
 * briefing is still open and its why is still the one diagnosed (`basis`). The diagnosis is always
 * kept, as the record of what the crew saw. On an item the crew may act on (`crewParkKind`), it
 * also records the crew's one action, in this transaction; `applyCrewRetries` acts on it next
 * active pass (it reads the forge):
 * - a `retry` with an instruction withdraws the briefing. On a gate-change park it is taken only
 *   with `gateChange: 'remove'`: the crew never allows a gate change, only takes it out.
 * - a `rerun_checks` on an item with an open PR (not a gate park) leaves the briefing open: it is
 *   withdrawn once the item is retried, and says why if the forge refused.
 * A second action for the item is refused by the schema, and leaves the diagnosis only. An
 * `already_done` records a `verifying` claim with the briefing's basis (#536), on any parked item:
 * nothing is written to the forge until the trail pass has verified its evidence. Returns
 * why it was discarded, if it was, or what the crew does.
 */
function applyDiagnose(
  db: Db,
  deps: Pick<ResultDeps, 'zone'>,
  drop: Drop,
  work: DiagnoseWork,
  out: CrewOutput['diagnose'],
  now: Date,
): string | undefined {
  const row = db
    .prepare(`SELECT why FROM briefings WHERE id = ? AND state = 'open'`)
    .get(work.briefingId) as { why: string } | undefined;
  if (!row) return 'diagnosis discarded: the briefing is no longer open';
  const basis = whyBasis(row.why);
  // A drop queued before v12 carries no basis: it is accepted, as it was then.
  if (work.basis !== undefined && work.basis !== basis) {
    return 'diagnosis discarded: the briefing changed since it was asked';
  }
  recordDiagnosis(
    db,
    work.briefingId,
    { diagnosis: out.diagnosis, basis, recommendation: `${out.recommendation}: ${out.detail}` },
    now,
  );
  const base = {
    zoneId: deps.zone.id,
    itemId: work.itemId,
    briefingId: work.briefingId,
    dropId: drop.id,
    diagnosis: out.diagnosis,
    createdAt: now,
  };
  let record: () => void;
  let note: string;
  if (out.recommendation === 'retry') {
    const instruction = out.instruction?.trim() ?? '';
    if (instruction === '') return undefined;
    const kind = parkKind(db, deps.zone, work.itemId);
    if (kind === null) return undefined;
    if (kind === 'gate' && out.gateChange !== 'remove') {
      return 'crew retry not recorded: a gate-change park is retried only to remove the change';
    }
    record = () => {
      insertCrewRetry(db, { ...base, instruction: out.instruction ?? instruction });
      withdrawBriefing(db, deps.zone.id, `item:${work.itemId}`, now);
    };
    note = 'the crew retries the item on this diagnosis';
  } else if (out.recommendation === 'rerun_checks') {
    const checks = [...new Set((out.checks ?? []).map((c) => c.trim()).filter((c) => c !== ''))];
    if (checks.length === 0) return undefined;
    if (parkKind(db, deps.zone, work.itemId) !== 'pr') return undefined;
    record = () => insertCrewRetry(db, { ...base, kind: 'rerun', instruction: '', checks });
    note = `the crew re-runs ${checks.join(', ')} on this diagnosis`;
  } else if (out.recommendation === 'already_done') {
    const evidence = {
      ...(out.evidence?.pulls?.length ? { pulls: out.evidence.pulls } : {}),
      ...(out.evidence?.issues?.length ? { issues: out.evidence.issues } : {}),
    };
    // Recorded only: the trail pass verifies every cited item before anything is written (#536).
    try {
      insertDoneClaim(
        db,
        {
          zoneId: deps.zone.id,
          itemId: work.itemId,
          briefingId: work.briefingId,
          dropId: drop.id,
          basis,
          diagnosis: out.diagnosis,
          evidence,
        },
        now,
      );
    } catch (e) {
      // D3: a claim on the item is verifying already, or this drop recorded one.
      if (isUniqueViolation(e)) return 'done claim not recorded: one is verifying already';
      throw e;
    }
    return 'the crew claims the item already done; the server verifies it';
  } else {
    return undefined;
  }
  try {
    db.transaction(record)();
  } catch (e) {
    // Another result recorded the item's one crew action first: the diagnosis stands alone.
    if (isUniqueViolation(e)) return 'crew retry not recorded: the item has one already';
    throw e;
  }
  return note;
}

/** The forge's refusal of a re-run, in plain words for the briefing (never its raw answer). */
function rerunRefusal(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 403) {
    return 'GitHub refused the re-run (HTTP 403): the token may lack the Actions write permission';
  }
  if (status === 404) return 'GitHub found no workflow run to re-run (HTTP 404)';
  if (typeof status === 'number') return `GitHub refused the re-run (HTTP ${status})`;
  return 'the forge could not be reached';
}

/** How long a rerun waits for its workflow run to complete, from the row's `created_at` (#772). */
export const RERUN_WAIT_MS = 60 * 60_000;

/**
 * Re-runs a rerun row's failed checks on the PR's current head (#420). Only names the forge reads
 * as failed on the head the server records are re-run; anything else, a refusal or an error
 * settles the row `skipped` with why. Returns `retry` once any run is re-run (or re-run by an
 * earlier pass), `wait` when a read failed or the workflow run is still in progress with nothing
 * re-run (the claim is released for the next pass, #772), or `skipped`. A row that would still wait RERUN_WAIT_MS after it was
 * recorded is `skipped` instead.
 */
async function rerunChecks(
  db: Db,
  forges: ForgePair,
  row: CrewRetry,
  itemId: number,
  now: Date,
): Promise<'retry' | 'wait' | 'skipped'> {
  if (row.rerunAt !== null) return 'retry';
  const skip = (reason: string): 'skipped' => {
    settleCrewRetry(db, row.id, 'skipped', reason);
    return 'skipped';
  };
  const stored = getPullRequest(db, itemId);
  if (!stored || stored.state !== 'open' || !stored.headSha) {
    return skip('the pull request is no longer open');
  }
  let failed: Set<string>;
  try {
    const pull = await forges.author.getPull(stored.number);
    if (pull?.state !== 'open') return skip('the pull request is no longer open');
    if (pull.headSha !== stored.headSha) return skip("the pull request's head moved");
    failed = new Set((await forges.author.checksFor(stored.headSha)).failed.map((f) => f.name));
  } catch {
    releaseCrewRetryApply(db, row.id, now);
    return 'wait';
  }
  const unknown = row.checks.filter((c) => !failed.has(c));
  if (unknown.length > 0) {
    return skip(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a failed check' : 'are not failed checks'} on the pull request's current head`,
    );
  }
  try {
    const { runIds, running } = await forges.author.rerunFailedChecks(
      stored.number,
      stored.headSha,
      row.checks,
    );
    // A run already re-run is recorded even when a later one was found running (#925): a later
    // pass must never re-run it again.
    if (running && runIds.length === 0) {
      if (now.getTime() - Date.parse(row.createdAt) > RERUN_WAIT_MS) {
        return skip('the workflow run is still in progress');
      }
      releaseCrewRetryApply(db, row.id, now);
      return 'wait';
    }
    if (runIds.length === 0) return skip('GitHub has no failed workflow run of it to re-run');
  } catch (e) {
    return skip(rerunRefusal(e));
  }
  markCrewRerun(db, row.id, now);
  return 'retry';
}

/** The heal a crew gate-change retry runs: server words, the crew's instruction rides beside. */
export const GATE_REMOVAL_FEEDBACK =
  'Remove every change this pull request makes to the scripts the gates run, so the gates run as they do on the base branch. The crew judged the issue does not need the change; the owner has not allowed it.';

/**
 * Queues the heal that takes a gate change out of the PR (#420), on its current head, charged to
 * the heal budget as any heal. The guard judges the head it pushes: one that still changes a gate
 * script parks again, and the owner is briefed.
 */
function enqueueGateRemoval(db: Db, zone: DropZoneConfig, itemId: number, now: Date): void {
  const pr = getPullRequest(db, itemId);
  if (!pr || pr.state !== 'open' || !pr.headSha) return;
  const fp = fingerprint([pr.headSha, 'crew-gate-removal']);
  db.transaction(() => {
    const charge = chargeBudget(db, itemId, 'heal', fp, zone.budgets);
    if (!charge.ok) return;
    insertDrop(
      db,
      {
        id: randomUUID(),
        dropZoneId: zone.id,
        workItemId: itemId,
        role: 'heal',
        state: 'queued',
        fingerprint: fp,
        prNumber: pr.number,
        headSha: pr.headSha,
        inputJson: JSON.stringify({
          feedback: { source: 'crew', text: GATE_REMOVAL_FEEDBACK } satisfies Feedback,
        }),
        promptVersion: promptVersions().heal,
        image: zone.image,
        chargedKey: charge.charged.join(',') || null,
        createdAt: now.toISOString(),
      },
      now,
    );
  })();
}

/**
 * Applies the zone's recorded crew actions, each once (#396, #420). A row is claimed by its
 * `applied_at` first, so two passes act once. With `crew.autoRetry` now off, or the item no longer
 * parked, it is `skipped`: the next `syncParkBriefings` briefs Command as usual. A rerun first
 * re-runs the named failed checks (`rerunChecks`); one the forge refused is `skipped` with why.
 * Then the item is retried exactly as Command's Retry (`retryParkedItem`), and a gate-change retry
 * queues the heal that removes the change. A PR read that fails releases the claim for the next
 * pass. Never an allowance or a ruling. Returns how many items were retried.
 */
export async function applyCrewRetries(
  db: Db,
  deps: Pick<RulingDeps, 'forges' | 'zone'>,
  zoneId: string,
  now: Date,
): Promise<number> {
  let retried = 0;
  for (const row of listUnappliedCrewRetries(db, zoneId)) {
    if (!claimCrewRetryApply(db, row.id, now)) continue;
    const item = getWorkItem(db, row.itemId);
    const zone = deps.zone(zoneId);
    if (!zone.crew.autoRetry || item?.state !== 'parked') {
      settleCrewRetry(db, row.id, 'skipped');
      continue;
    }
    const forges = deps.forges(zoneId);
    if (row.kind === 'rerun' && (await rerunChecks(db, forges, row, item.id, now)) !== 'retry') {
      continue;
    }
    const gate = row.kind === 'retry' && (item.reason ?? '').startsWith(GATE_SCRIPT_PARK);
    if (!(await retryParkedItem(db, forges, item, now))) {
      releaseCrewRetryApply(db, row.id, now);
      continue;
    }
    if (gate) enqueueGateRemoval(db, zone, item.id, now);
    settleCrewRetry(db, row.id, 'retried');
    retried++;
  }
  return retried;
}

/** The line a triage child's body ends with; it counts toward the 12000-character limit. */
export const triagedFrom = (n: number): string => `Triaged from #${n}.`;

const MAX_ISSUE_BODY = 12_000;
const MAX_ERROR = 500;

/**
 * A triage attempt that came to nothing: `attempts` goes up and, at `maxTriage`, the request is
 * `failed` and put to Command once. The briefing carries the error only, never the issue's text.
 * Only an `open` request counts: the trail sets a refused `verifying` one back to `open` first.
 */
export function triageFailed(
  db: Db,
  deps: Pick<ResultDeps, 'zone'>,
  requestId: number,
  error: string,
  now: Date,
): void {
  const req = getTriageRequest(db, requestId);
  if (!req || req.state !== 'open') return;
  const attempts = req.attempts + 1;
  const max = deps.zone.crew.maxTriage;
  if (attempts < max) {
    setTriageRequest(db, req.id, { attempts }, now);
    return;
  }
  const briefingId = raiseBriefing(
    db,
    {
      zoneId: req.zoneId,
      kind: 'crew',
      subject: `triage:#${req.issueNumber}`,
      decision: `triage of #${req.issueNumber} failed`,
      why: `Its ${max} triage attempts ended without a usable result. Last error: ${error.slice(0, MAX_ERROR)}`,
      options: [{ id: 'ack', label: 'Triage it by hand', effect: 'none' }],
      onHold: `#${req.issueNumber}`,
      source: 'server',
    },
    now,
  );
  setTriageRequest(db, req.id, { attempts, state: 'failed', reason: 'failed', briefingId }, now);
}

/**
 * A triage drop's outcome on its request. `split` files every child through `applyCrewActions`,
 * all or nothing, under objective `triage:#N`; `questions` raises its briefing and waits on it;
 * `not-agent-work` closes the request with its reason; `already-done` waits in `verifying` with
 * its reason and evidence until the trail has checked every cited item (#466). The original
 * issue is never written here.
 */
function applyTriage(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  requestId: number,
  out: CrewOutput['triage'],
  now: Date,
): string | undefined {
  const req = getTriageRequest(db, requestId);
  if (!req || req.state !== 'open') return 'triage discarded: the request is no longer open';
  const n = req.issueNumber;
  const source = { kind: 'drop' as const, dropId: drop.id };
  if (out.outcome === 'split') {
    const children = out.children ?? [];
    const tooLong = children.filter(
      (c) => `${c.body.trimEnd()}\n\n${triagedFrom(n)}`.length > MAX_ISSUE_BODY,
    );
    if (tooLong.length > 0) {
      const error = `split refused: ${tooLong.length} child body over ${MAX_ISSUE_BODY} characters with its triage line`;
      triageFailed(db, deps, req.id, error, now);
      return error;
    }
    const objective = `triage:#${n}`;
    const report = applyCrewActions(
      db,
      deps.zone,
      {
        fileIssues: children.map((c) => ({
          key: c.key,
          objective,
          title: c.title,
          body: `${c.body.trimEnd()}\n\n${triagedFrom(n)}`,
          ...(c.priority !== undefined ? { priority: c.priority } : {}),
        })),
      },
      source,
      now,
      { objective, allOrNothing: true },
    );
    if (report.refused.length > 0) {
      // The reasons without the agent's keys: they never echo the issue's text.
      const reasons = report.refused.map((r) => r.slice(r.indexOf(': ') + 2));
      const error = `split refused: ${reasons.join('; ')}`;
      triageFailed(db, deps, req.id, error, now);
      return error;
    }
    setTriageRequest(db, req.id, { state: 'done', outcome: 'split' }, now);
    return undefined;
  }
  if (out.outcome === 'questions' && out.briefing) {
    const report = applyCrewActions(
      db,
      deps.zone,
      // Prefixed with the issue number so it never updates another open crew briefing.
      { briefings: [{ ...out.briefing, subject: `#${n} ${out.briefing.subject}` }] },
      source,
      now,
      { ownBriefing: true },
    );
    const briefingId = report.briefings[0];
    if (briefingId === undefined) {
      const error = 'questions refused: the briefing was not recorded';
      triageFailed(db, deps, req.id, error, now);
      return error;
    }
    setTriageRequest(db, req.id, { state: 'waiting', outcome: 'questions', briefingId }, now);
    return undefined;
  }
  if (out.outcome === 'already-done' && out.evidence) {
    const evidence = {
      pulls: [...new Set(out.evidence.pulls ?? [])],
      issues: [...new Set(out.evidence.issues ?? [])],
    };
    setTriageRequest(
      db,
      req.id,
      {
        state: 'verifying',
        outcome: 'already-done',
        reason: (out.reason ?? '').slice(0, MAX_ERROR),
        evidence,
      },
      now,
    );
    return undefined;
  }
  setTriageRequest(
    db,
    req.id,
    { state: 'done', outcome: 'not-agent-work', reason: out.reason ?? '' },
    now,
  );
  return undefined;
}

/** The line a refuted audit's issue body ends with; it counts toward the 12000-character limit. */
export const foundByAudit = (sha: string): string => `Found by the audit of ${sha}.`;

type AuditWork = Extract<CrewInputJson['work'], { role: 'audit' }>;

/** An audit drop that came to nothing: its audit is `failed` with the reason. Never retried. */
function auditFailed(db: Db, drop: Drop, reason: string, now: Date): void {
  const row = getAuditByDrop(db, drop.id);
  if (row) settleAudit(db, row.id, { state: 'failed', reason: reason.slice(0, MAX_ERROR) }, now);
}

/**
 * An audit's verdict on a merged commit. `holds` settles it; `refuted` files its one fix-forward
 * issue as a staged crew issue through `applyCrewActions` (key `audit-<sha7>`, objective
 * `audit:<sha7>`), all or nothing, so it is refuted like any crew issue before work starts. A
 * refused issue files nothing, and the reasons never echo its text. Nothing else is written: no
 * revert, reopen or comment. Returns a note for the drop's log, if any.
 */
function applyAudit(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  work: AuditWork,
  out: CrewOutput['audit'],
  now: Date,
): string | undefined {
  const row = getAuditByDrop(db, drop.id);
  if (!row || row.state !== 'running') return 'verdict not applied: its audit is settled';
  if (out.verdict === 'holds' || !out.issue) {
    settleAudit(db, row.id, { state: 'holds' }, now);
    return undefined;
  }
  const sha7 = work.sha.slice(0, 7);
  const body = `${out.issue.body.trim()}\n\n${foundByAudit(work.sha)}`;
  const refused = (reason: string) => {
    settleAudit(db, row.id, { state: 'refused', reason }, now);
    return `refutation refused: ${reason}`;
  };
  if (body.length > MAX_ISSUE_BODY) {
    return refused(`the issue body is over ${MAX_ISSUE_BODY} characters with its audit line`);
  }
  const objective = `audit:${sha7}`;
  const report = applyCrewActions(
    db,
    deps.zone,
    { fileIssues: [{ key: `audit-${sha7}`, objective, title: out.issue.title, body }] },
    { kind: 'drop', dropId: drop.id },
    now,
    { objective, allOrNothing: true },
  );
  const filed = report.filed[0];
  if (report.refused.length > 0 || filed === undefined) {
    // The reasons without the key: they never echo the issue's text.
    const reasons = report.refused.map((r) => r.slice(r.indexOf(': ') + 2));
    return refused(reasons.join('; ') || 'nothing was filed');
  }
  settleAudit(db, row.id, { state: 'filed', crewIssueId: filed }, now);
  return undefined;
}

/**
 * A crew drop's result. The output is validated per role; only then is it recorded as intents in
 * the database (never a forge write). Its usage, the probe's release included, is `applyUsage`'s.
 */
export async function applyCrewResult(
  db: Db,
  deps: ResultDeps,
  drop: Drop,
  result: DropResult,
  now: Date,
): Promise<void> {
  db.transaction(() => {
    const role = drop.role;
    if (!isCrewRole(role)) return finish(db, drop, 'failed', now, `unknown crew role ${role}`);
    const work = storedWork(drop);
    // A triage attempt that came to nothing counts against the request's `maxTriage`.
    const failed = (error: string) => {
      if (role === 'triage' && work?.role === 'triage') {
        triageFailed(db, deps, work.requestId, error, now);
      } else if (role === 'arbitrate' && work?.role === 'arbitrate') {
        arbitrationFailed(db, deps, drop, work, error, now);
      } else if (role === 'audit') {
        auditFailed(db, drop, error, now);
      }
    };
    if (result.status === 'rate_limited') {
      failed('the drop was rate-limited');
      return finish(db, drop, 'cancelled', now);
    }
    if (result.status !== 'completed') {
      failed(`the drop ${result.status}: ${result.reason ?? ''}`);
      if (role === 'diagnose' && work?.role === 'diagnose') rerunStaleDiagnose(db, work, result);
      return finish(db, drop, 'failed', now, result.reason ?? result.status);
    }
    const parsed =
      result.crew === undefined
        ? ({ ok: false, reason: 'missing' } as const)
        : parseCrewOutput(role, result.crew);
    if (!parsed.ok) {
      failed(`invalid crew output: ${parsed.reason}`);
      return finish(db, drop, 'failed', now, `invalid crew output: ${parsed.reason}`);
    }
    if (role === 'crew-lead') {
      const out = parsed.value as CrewOutput['crew-lead'];
      const { report, refusedIssues } = applyCrewActionsTracked(
        db,
        deps.zone,
        out,
        { kind: 'drop', dropId: drop.id },
        now,
      );
      // `refusedIssues` says which proposal each entry refused, so the next lead input shows that
      // proposal's own title even when a key repeats in the output (#934).
      updateDrop(db, drop.id, {
        state: 'succeeded',
        resultJson: JSON.stringify({ ...result, crewReport: { ...report, refusedIssues } }),
      });
      // One line per refusal: the zone and the entry (a key and the server's reason), never a body.
      for (const entry of report.refused) {
        serverLog(
          `zone ${deps.zone.id}: crew lead proposal refused: ${cutChars(entry, MAX_REFUSED_CHARS)}`,
        );
      }
      return;
    }
    if (role === 'refute' && work?.role === 'refute') {
      // Kept on the drop: a refute_exhausted briefing quotes every review's findings from it.
      updateDrop(db, drop.id, { resultJson: JSON.stringify(result) });
      const issue = getCrewIssue(db, work.crewIssueId);
      if (issue) {
        applyRefute(db, deps, drop, work, issue, parsed.value as CrewOutput['refute'], now);
      }
    } else if (role === 'triage' && work?.role === 'triage') {
      const out = parsed.value as CrewOutput['triage'];
      const note = applyTriage(db, deps, drop, work.requestId, out, now);
      return finish(db, drop, 'succeeded', now, note);
    } else if (role === 'arbitrate' && work?.role === 'arbitrate') {
      // Kept on the drop: its page is where the full ruling is read.
      updateDrop(db, drop.id, { resultJson: JSON.stringify(result) });
      const out = parsed.value as CrewOutput['arbitrate'];
      const note =
        work.subject === 'item'
          ? applyItemArbitration(db, deps, drop, work, out, now)
          : applyIssueArbitration(db, deps, drop, work, out, now);
      return finish(db, drop, 'succeeded', now, note);
    } else if (role === 'audit' && work?.role === 'audit') {
      // Kept on the drop: its page is where the findings are read.
      updateDrop(db, drop.id, { resultJson: JSON.stringify(result) });
      const note = applyAudit(db, deps, drop, work, parsed.value as CrewOutput['audit'], now);
      return finish(db, drop, 'succeeded', now, note);
    } else if (role === 'diagnose' && work?.role === 'diagnose') {
      const out = parsed.value as CrewOutput['diagnose'];
      const note = applyDiagnose(db, deps, drop, work, out, now);
      return finish(db, drop, 'succeeded', now, note);
    }
    finish(db, drop, 'succeeded', now);
  })();
}
