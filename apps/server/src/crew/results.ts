import {
  type CrewOutput,
  type DropResult,
  isCrewRole,
  parseCrewOutput,
} from '@jumpmaster/protocol';
import { raiseBriefing, recordDiagnosis, whyBasis } from '../briefings.js';
import type { Db } from '../db/open.js';
import {
  appendEvents,
  type Drop,
  type DropState,
  getDrop,
  getPullRequest,
  getWorkItem,
  updateDrop,
} from '../db/repo.js';
import { ranOnFable } from '../fable.js';
import type { ForgePair } from '../outbox.js';
import type { CrewInputJson } from '../payloads.js';
import type { ResultDeps } from '../results.js';
import { retryParkedItem } from '../sync.js';
import {
  applyCrewActions,
  isSecurityTouching,
  protectedPathsNamed,
  validateIssueSpec,
} from './actions.js';
import { PROMOTE_OPTIONS, subjectOf } from './flush.js';
import {
  briefItemRuling,
  HEAL_EXHAUSTED,
  itemArbitrationFailed,
  raiseRefuteExhausted,
} from './schedule.js';
import {
  type CrewIssue,
  type CrewIssuePatch,
  claimArbitrationApply,
  getArbitrationByDrop,
  getAuditByDrop,
  getCrewIssue,
  getTriageRequest,
  releaseArbitrationApply,
  setCrewIssue,
  setTriageRequest,
  settleArbitration,
  settleAudit,
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
 * `crew.refutePromotes` on it becomes `promote_held`, ready next pass unless Command rejects it;
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
        decision: `${why.found} ${label}. It becomes ready on the next pass unless you reject it.`,
        why:
          `The crew filed ${label} as staged, and ${why.held} This zone lets a passing review ` +
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
        `for this zone: jumpmaster ctl zones set ${zone.id} crew.refutePromotes=true` +
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
    if (
      revised &&
      validateIssueSpec(title, body).length === 0 &&
      protectedPathsNamed(body, zone.protectedPaths).length === 0
    ) {
      setCrewIssue(db, issue.id, { ...base, state: 'revising', title, body }, now);
      return;
    }
    // A revision that is missing, not in the drop-ready format or naming a protected path counts
    // as a rejection.
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

/**
 * Records a diagnosis on the parked briefing it was asked for, beside the server's why, if that
 * briefing is still open and its why is still the one diagnosed (`basis`). Returns why it was
 * discarded, if it was.
 */
function applyDiagnose(
  db: Db,
  work: { briefingId: number; basis?: string },
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
  return undefined;
}

/** The line a triage child's body ends with; it counts toward the 12000-character limit. */
export const triagedFrom = (n: number): string => `Triaged from #${n}.`;

const MAX_ISSUE_BODY = 12_000;
const MAX_ERROR = 500;

/**
 * A triage attempt that came to nothing: `attempts` goes up and, at `maxTriage`, the request is
 * `failed` and put to Command once. The briefing carries the error only, never the issue's text.
 */
function triageFailed(db: Db, deps: ResultDeps, requestId: number, error: string, now: Date): void {
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
 * `not-agent-work` closes the request with its reason. The original issue is never written.
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
      const report = applyCrewActions(db, deps.zone, out, { kind: 'drop', dropId: drop.id }, now);
      updateDrop(db, drop.id, {
        state: 'succeeded',
        resultJson: JSON.stringify({ ...result, crewReport: report }),
      });
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
      const discarded = applyDiagnose(db, work, parsed.value as CrewOutput['diagnose'], now);
      return finish(db, drop, 'succeeded', now, discarded);
    }
    finish(db, drop, 'succeeded', now);
  })();
}
