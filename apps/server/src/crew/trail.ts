import { recordDiagnosis, whyBasis, withdrawBriefing } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  deleteOutbox,
  getOutbox,
  getWorkItem,
  getZoneMode,
  isKilled,
  listOutbox,
  type OutboxRow,
  setWorkItemState,
} from '../db/repo.js';
import {
  type AddBlockedByPayload,
  type CommentIssuePayload,
  commentMarker,
  type ForgePair,
  type Op,
  opKeys,
  runOp,
  type SetLabelsPayload,
  sanitizeCrewText,
  type UpdateIssuePayload,
} from '../outbox.js';
import { triageFailed } from './results.js';
import {
  type DoneClaim,
  type DoneEvidence,
  getDoneClaim,
  getTriageRequest,
  listTriageRequests,
  listVerifyingDoneClaims,
  setTriageRequest,
  settleDoneClaim,
  type TriageRequest,
  triageBodySha,
} from './store.js';

/**
 * The trail a triage outcome leaves on the original issue (#185): one comment, and for a final
 * outcome the label swap. The comment is built from the outcome, the child numbers, the briefing
 * subject and the reason only: never from the issue's own text.
 */
type Trail = { comment: Op; labels?: Op; close?: Op };

/** The comment marker key: one per request, and one more for a `questions` wait before it. */
export const trailKey = (req: Pick<TriageRequest, 'issueNumber' | 'id'>, questions = false) =>
  `triage:${req.issueNumber}:${req.id}${questions ? ':questions' : ''}`;

/** The split's child numbers in issue order, or null while any child's create is not done. */
function childNumbers(db: Db, zone: DropZoneConfig, req: TriageRequest): number[] | null {
  const rows = db
    .prepare(
      `SELECT c.objective, c.key, c.number FROM crew_issues c JOIN drops d ON d.id = c.source_ref
         WHERE c.zone_id = ? AND c.source = 'drop' AND c.objective = ?
           AND json_extract(d.input_json, '$.work.role') = 'triage'
           AND json_extract(d.input_json, '$.work.requestId') = ?
         ORDER BY c.id`,
    )
    .all(zone.id, `triage:#${req.issueNumber}`, req.id) as {
    objective: string;
    key: string;
    number: number | null;
  }[];
  if (rows.length === 0) return null;
  const numbers: number[] = [];
  for (const r of rows) {
    const op = getOutbox(db, opKeys.issue(zone.id, r.objective, r.key));
    if (op?.state !== 'done') return null;
    const filed =
      r.number ?? (JSON.parse(op.resultJson ?? 'null') as { number?: number } | null)?.number;
    if (typeof filed !== 'number') return null;
    numbers.push(filed);
  }
  return numbers.sort((a, b) => a - b);
}

/** The briefing's subject as the crew wrote it, without the server's `crew:#N ` prefix. */
function briefingSubject(db: Db, req: TriageRequest): string | null {
  if (req.briefingId === null) return null;
  const row = db.prepare('SELECT subject FROM briefings WHERE id = ?').get(req.briefingId) as
    | { subject: string }
    | undefined;
  if (!row) return null;
  const prefix = `crew:#${req.issueNumber} `;
  return row.subject.startsWith(prefix) ? row.subject.slice(prefix.length) : row.subject;
}

/** A trail comment op on the request's issue, found again by the marker for `key`. */
function commentOp(zone: DropZoneConfig, req: TriageRequest, key: string, body: string): Op {
  const payload: CommentIssuePayload = {
    number: req.issueNumber,
    body,
    marker: commentMarker(zone.id, key),
  };
  return {
    kind: 'comment_issue',
    opKey: `comment:${zone.id}:${key}`,
    zoneId: zone.id,
    itemId: null,
    payload,
  };
}

function trailOf(
  db: Db,
  zone: DropZoneConfig,
  req: TriageRequest,
  secrets: string[],
  notCopied: string[] = [],
): Trail | null {
  const n = req.issueNumber;
  const comment = (body: string, questions = false): Op =>
    commentOp(zone, req, trailKey(req, questions), body);
  const swap: Op = {
    kind: 'set_labels',
    opKey: `labels:${zone.id}:triage:${req.id}`,
    zoneId: zone.id,
    itemId: null,
    payload: {
      number: n,
      add: [zone.triagedLabel],
      remove: [zone.triageLabel],
    } satisfies SetLabelsPayload,
  };
  // Superseded, verifying and failed requests leave no trail: only these states do.
  if (req.outcome === 'questions' && req.state === 'waiting') {
    const subject = briefingSubject(db, req);
    if (subject === null) return null;
    return {
      comment: comment(
        `Jumpmaster needs a decision before this can be worked: ${sanitizeCrewText(subject, secrets)}. It continues once that is answered.`,
        true,
      ),
    };
  }
  if (req.state !== 'done') return null;
  if (req.outcome === 'split') {
    const numbers = childNumbers(db, zone, req);
    if (numbers === null) return null;
    const list = numbers.map((c) => `#${c}`).join(', ');
    const skipped =
      notCopied.length > 0
        ? ` Blockers in another repository were not copied to them: ${notCopied.join(', ')}.`
        : '';
    return {
      comment: comment(
        `Jumpmaster split this into ${list}. They start once they are reviewed and promoted.${skipped}`,
      ),
      labels: swap,
    };
  }
  if (req.outcome === 'already-done') {
    const cited = citedNumbers(req);
    if (cited.length === 0) return null;
    const reason = sanitizeCrewText(
      (req.reason ?? '').slice(0, MAX_REASON).replace(/[\s.]+$/, ''),
      secrets,
    );
    const done = cited.map((c) => `#${c}`).join(', ');
    const close = zone.crew.closeDone;
    return {
      comment: comment(
        close
          ? `The crew found this already done: ${reason}. Done in: ${done}. Closing it. Reopen the issue if something is missing.`
          : `The crew found this already done: ${reason}. Done in: ${done}. Close the issue if nothing is missing.`,
      ),
      labels: swap,
      ...(close ? { close: closeDoneOp(zone, req) } : {}),
    };
  }
  if (req.outcome === 'not-agent-work') {
    return {
      comment: comment(
        `Jumpmaster won't work this as an agent task: ${sanitizeCrewText(req.reason ?? '', secrets)}`,
      ),
      labels: swap,
    };
  }
  return null;
}

/** The longest reason a trail comment quotes, as the triage schema allows. */
const MAX_REASON = 500;

/** An `already-done` request's verified pulls then issues, each once, as numbers only. */
function citedNumbers(req: TriageRequest): number[] {
  const all = [...(req.evidence?.pulls ?? []), ...(req.evidence?.issues ?? [])];
  return [...new Set(all.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

/** The close of an issue found already done: its own key, never a split parent's (#466). */
function closeDoneOp(zone: DropZoneConfig, req: TriageRequest): Op {
  return {
    kind: 'update_issue',
    opKey: `close:${zone.id}:triage-done:${req.id}`,
    zoneId: zone.id,
    itemId: null,
    payload: {
      number: req.issueNumber,
      state: 'closed',
      stateReason: 'completed',
    } satisfies UpdateIssuePayload,
  };
}

type Verdict = { kind: 'verified' } | { kind: 'superseded' } | { kind: 'refused'; why: string };

/** `verifyCited`'s answer: why it refused names numbers only, never forge or agent text. */
export type CitedVerdict = { ok: true } | { ok: false; why: string };

/**
 * Checks what a crew verdict cites as having done the work on issue `issueNumber`, against the
 * forge (#466, #536): every cited pull is merged to the default branch; every cited issue is
 * another issue (not a pull request, not `issueNumber`) closed as completed. Reads only. A lookup
 * that throws refuses (D2): a failed read proves nothing. Shared by triage and diagnose (D5).
 */
export async function verifyCited(
  forges: ForgePair,
  issueNumber: number,
  evidence: DoneEvidence | null | undefined,
): Promise<CitedVerdict> {
  const refused = (why: string): CitedVerdict => ({ ok: false, why });
  const pulls = evidence?.pulls ?? [];
  const issues = evidence?.issues ?? [];
  if (pulls.length + issues.length === 0) return refused('nothing was cited');
  try {
    const defaultBranch = await forges.author.getDefaultBranch();
    for (const p of pulls) {
      const pull = await forges.author.getPull(p);
      if (!pull) return refused(`#${p} not found`);
      if (pull.merged !== true) return refused(`#${p} is not merged`);
      if (pull.baseRef !== defaultBranch)
        return refused(`#${p} was not merged to the default branch`);
    }
    for (const i of issues) {
      if (i === issueNumber) return refused(`#${i} is this issue`);
      const issue = await forges.author.getIssue(i);
      if (!issue) return refused(`#${i} not found`);
      if (issue.pullRequest === true) return refused(`#${i} is a pull request, not an issue`);
      if (issue.state !== 'closed') return refused(`#${i} is not closed`);
      if (issue.stateReason !== 'completed') return refused(`#${i} was not closed as completed`);
    }
  } catch {
    return refused('a cited item could not be read');
  }
  return { ok: true };
}

/**
 * Checks an `already-done` request's evidence against the forge (#466): the original issue is
 * open with the text triaged, then `verifyCited`. Reads only. The reason it refuses names numbers
 * only, never forge or agent text.
 */
async function verifyEvidence(forges: ForgePair, req: TriageRequest): Promise<Verdict> {
  const n = req.issueNumber;
  const refused = (why: string): Verdict => ({ kind: 'refused', why: `evidence refused: ${why}` });
  const pulls = req.evidence?.pulls ?? [];
  const issues = req.evidence?.issues ?? [];
  if (pulls.length + issues.length === 0) return refused('nothing was cited');
  try {
    const original = await forges.author.getIssue(n);
    if (
      !original ||
      original.state !== 'open' ||
      original.pullRequest === true ||
      triageBodySha(original.body) !== req.bodySha
    ) {
      return { kind: 'superseded' };
    }
  } catch {
    // D2: a lookup that failed proves nothing.
    return refused('a cited item could not be read');
  }
  const cited = await verifyCited(forges, n, req.evidence);
  return cited.ok ? { kind: 'verified' } : refused(cited.why);
}

/**
 * Settles each `verifying` request (#466): verified, it is `done` and its trail comments (and
 * closes, with `crew.closeDone`); the original issue closed or edited meanwhile supersedes it,
 * writing nothing; any other failure is a failed triage attempt, the request `open` again with
 * the refusal kept for the retry's input. Writes nothing to the forge. Returns how many it settled.
 */
async function verifyRequests(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<number> {
  let settled = 0;
  for (const req of listTriageRequests(db, zone.id)) {
    if (req.state !== 'verifying') continue;
    const verdict = await verifyEvidence(forges, req);
    db.transaction(() => {
      // Re-read: a new body may have superseded it while the forge was read.
      if (getTriageRequest(db, req.id)?.state !== 'verifying') return;
      if (verdict.kind === 'verified') {
        setTriageRequest(db, req.id, { state: 'done', outcome: 'already-done' }, now);
      } else if (verdict.kind === 'superseded') {
        // No outcome: a superseded request leaves no trail.
        setTriageRequest(db, req.id, { state: 'done', outcome: null, reason: 'superseded' }, now);
      } else {
        const back = { state: 'open', outcome: null, reason: null, evidence: null } as const;
        setTriageRequest(db, req.id, { ...back, lastError: verdict.why }, now);
        triageFailed(db, { zone }, req.id, verdict.why, now);
      }
      settled++;
    })();
  }
  return settled;
}

/** A blocker in another repository as GitHub names it: `owner/name#N`. */
const OTHER_REPO_BLOCKER = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#\d{1,10}$/;

const linkPrefix = (zone: DropZoneConfig, req: TriageRequest) =>
  `blocked-by:${zone.id}:triage:${req.id}:`;

function linkOp(zone: DropZoneConfig, req: TriageRequest, child: number, blocker: number): Op {
  return {
    kind: 'add_blocked_by',
    opKey: `${linkPrefix(zone, req)}${child}:${blocker}`,
    zoneId: zone.id,
    itemId: null,
    payload: { issue: child, blocker, repo: zone.repo } satisfies AddBlockedByPayload,
  };
}

const opOfRow = (row: OutboxRow): Op => ({
  kind: row.kind,
  opKey: row.opKey,
  zoneId: row.zoneId,
  itemId: row.workItemId,
  payload: JSON.parse(row.payloadJson) as unknown,
});

/**
 * The "blocked by" links a split's parts inherit from the parent (#297), and the parent's open
 * blockers that are not copied (another repository, or unreadable), for the trail comment to name.
 * The parent's blockers are read only until the trail comment is recorded: after that (and for a
 * split whose trail ran before #297) only the link ops already recorded and not done are retried.
 * `null`: the parent's blockers could not be read; nothing is written this pass.
 */
async function inheritedLinks(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  req: TriageRequest,
  children: number[],
): Promise<{ ops: Op[]; notCopied: string[] } | null> {
  if (getOutbox(db, `comment:${zone.id}:${trailKey(req)}`)) {
    const prefix = linkPrefix(zone, req);
    const ops = listOutbox(db, ['pending', 'unknown'], zone.id)
      .filter((r) => r.kind === 'add_blocked_by' && r.opKey.startsWith(prefix))
      .map(opOfRow);
    return { ops, notCopied: [] };
  }
  let read: Awaited<ReturnType<ForgePair['author']['listBlockedBy']>>;
  try {
    read = await forges.author.listBlockedBy(req.issueNumber);
  } catch {
    return null;
  }
  const open = read.blockers.filter((b) => b.open);
  const here = open.filter((b) => b.repo.toLowerCase() === zone.repo.toLowerCase());
  const notCopied = open
    .filter((b) => !here.includes(b))
    .map((b) => `${b.repo}#${b.number}`)
    .filter((name) => OTHER_REPO_BLOCKER.test(name));
  const unreadable = read.unreadable + open.length - here.length - notCopied.length;
  if (unreadable > 0)
    notCopied.push(`${unreadable} unreadable blocker${unreadable === 1 ? '' : 's'}`);
  const ops = children.flatMap((c) => here.map((b) => linkOp(zone, req, c, b.number)));
  return { ops, notCopied };
}

/**
 * Closes a split's parent once every part it recorded is closed, for any reason (#297): a comment
 * naming the parts, then the close. Only after the split's own trail comment and label swap are
 * done. Any failed read of a part closes nothing this pass. Returns how many ops it ran.
 */
async function closeSplitParent(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  req: TriageRequest,
  children: number[],
  now: Date,
): Promise<number> {
  const close: Op = {
    kind: 'update_issue',
    opKey: `close:${zone.id}:triage:${req.id}`,
    zoneId: zone.id,
    itemId: null,
    payload: {
      number: req.issueNumber,
      state: 'closed',
      stateReason: 'completed',
    } satisfies UpdateIssuePayload,
  };
  if (getOutbox(db, close.opKey)?.state === 'done') return 0;
  try {
    for (const c of children) {
      if ((await forges.author.getIssueState(c)) !== 'closed') return 0;
    }
  } catch {
    return 0; // D2: a part's state is unknown, so the parent stays open this pass.
  }
  const list = children.map((c) => `#${c}`).join(', ');
  const comment = commentOp(
    zone,
    req,
    `${trailKey(req)}:closed`,
    `All parts of this split are closed (${list}). Closing.`,
  );
  let ran = 0;
  for (const op of [comment, close]) {
    if (getOutbox(db, op.opKey)?.state === 'done') continue;
    try {
      const r = await runOp(db, forges, op, now);
      ran++;
      if (r.state !== 'done') return ran; // the close waits until its comment is done
    } catch {
      return ran;
    }
  }
  return ran;
}

/**
 * Runs each op not already done, through `runOp`, and counts the ops it ran. A later pass never
 * writes an op again: one whose answer was lost (`unknown`) is only read back, and one refused
 * (`failed`) stays failed. A close that must be sent again goes through `runOnce` instead.
 */
async function runEach(db: Db, forges: ForgePair, ops: Op[], now: Date): Promise<number> {
  let ran = 0;
  for (const op of ops) {
    if (getOutbox(db, op.opKey)?.state === 'done') continue;
    try {
      await runOp(db, forges, op, now);
      ran++;
    } catch {
      // A forge read threw: the row is read back next pass.
    }
  }
  return ran;
}

/**
 * Leaves each triage outcome's trail on its original issue through the outbox, as the author
 * identity: idempotent per request by the comment marker and the op keys (D3). For a split, the
 * parts first inherit the parent's open blockers, and the parent closes once every part is closed
 * (#297). An `already-done` verdict is verified first, reads only, also in observe (#466). Ops
 * run only in an active zone, and nothing runs with the kill switch on. Returns how many ops it
 * ran that were not already done.
 */
export async function flushTriageTrail(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  secrets: string[],
  now: Date,
): Promise<number> {
  if (isKilled(db)) return 0;
  // Reads only, so also in observe: the trail it leaves waits for an active zone.
  await verifyRequests(db, forges, zone, now);
  if (getZoneMode(db, zone.id, zone.mode) !== 'active') return 0;
  let ran = 0;
  for (const req of listTriageRequests(db, zone.id)) {
    const children =
      req.state === 'done' && req.outcome === 'split' ? childNumbers(db, zone, req) : null;
    let notCopied: string[] = [];
    if (children) {
      const links = await inheritedLinks(db, forges, zone, req, children);
      if (!links) continue; // the parent's blockers are unreadable: tried again next pass
      notCopied = links.notCopied;
      ran += await runEach(db, forges, links.ops, now);
    }
    const trail = trailOf(db, zone, req, secrets, notCopied);
    if (!trail) continue;
    const trailOps = [trail.comment, ...(trail.labels ? [trail.labels] : [])];
    ran += await runEach(db, forges, trailOps, now);
    // The close waits until its comment and label swap are done (#466). A close not done is sent
    // again each pass until it is (#545); one that finds the issue closed is done with no write.
    if (
      trail.close &&
      getOutbox(db, trail.close.opKey)?.state !== 'done' &&
      trailOps.every((op) => getOutbox(db, op.opKey)?.state === 'done')
    ) {
      await runOnce(db, forges, trail.close, now);
      ran++;
    }
    if (children && trailOps.every((op) => getOutbox(db, op.opKey)?.state === 'done')) {
      ran += await closeSplitParent(db, forges, zone, req, children, now);
    }
  }
  ran += await flushDoneClaims(db, forges, zone, secrets, now);
  return ran;
}

/** The work item's state once a verified claim closed its issue. */
export const CLAIM_DONE_REASON = 'already done (crew, verified)';
/** The briefing's recommendation once a claim was refused: the reason follows. */
export const CLAIM_REFUSED = "the crew's claim that this is already done was refused: ";

/** A claim's forge writes, found again by keys derived from its id (D3). */
export const claimKeys = (zoneId: string, claimId: number) => ({
  comment: `comment:${zoneId}:crew-done:${claimId}`,
  marker: commentMarker(zoneId, `crew-done:${claimId}`),
  close: `close:${zoneId}:crew-done:${claimId}`,
  retract: `comment:${zoneId}:crew-done-retract:${claimId}`,
  retractMarker: commentMarker(zoneId, `crew-done-retract:${claimId}`),
});

/** The follow-up on an issue whose closing comment was sent by a claim that no longer stands. */
export const claimRetractComment = (why: string): string =>
  `The crew is no longer closing this issue: ${why}. It stays open.`;

/** A claim's cited pulls then issues, each once, as `#N` (numbers only). */
const citedList = (e: DoneEvidence): string =>
  [...new Set([...(e.pulls ?? []), ...(e.issues ?? [])])].map((n) => `#${n}`).join(', ');

/** The closing comment: the diagnosis redacted, then cut to `MAX_REASON` (#536). */
export function claimComment(claim: Pick<DoneClaim, 'diagnosis' | 'evidence'>, secrets: string[]) {
  const diagnosis = sanitizeCrewText(claim.diagnosis, secrets)
    .slice(0, MAX_REASON)
    .replace(/[\s.]+$/, '');
  return `The crew found this already done: ${diagnosis}. Done in: ${citedList(claim.evidence)}. Closing it. Reopen the issue if something is missing.`;
}

type ClaimCheck =
  | { kind: 'verified' }
  | { kind: 'superseded'; why: string }
  | { kind: 'refused'; why: string };

/** The claim's briefing, if it is still open with the basis the claim was made on. */
function claimBriefing(db: Db, claim: DoneClaim): string | null {
  const b = db
    .prepare(`SELECT why FROM briefings WHERE id = ? AND kind = 'parked' AND state = 'open'`)
    .get(claim.briefingId) as { why: string } | undefined;
  if (!b) return 'the parked briefing is no longer open';
  if (whyBasis(b.why) !== claim.basis) return 'the parked briefing changed';
  return null;
}

/** The facts on the server a claim still needs: the item parked, its briefing open, same basis. */
function claimStands(db: Db, claim: DoneClaim): string | null {
  const item = getWorkItem(db, claim.itemId);
  if (!item || item.state !== 'parked') return 'the item is no longer parked';
  return claimBriefing(db, claim);
}

/**
 * Checks a claim (#536): the item still parked, its briefing open on the same basis, its issue
 * still open, then every cited item by `verifyCited`. Reads only. A lookup that throws refuses.
 */
async function checkClaim(db: Db, forges: ForgePair, claim: DoneClaim): Promise<ClaimCheck> {
  const stale = claimStands(db, claim);
  if (stale) return { kind: 'superseded', why: stale };
  const n = getWorkItem(db, claim.itemId)?.issueNumber ?? 0;
  try {
    const issue = await forges.author.getIssue(n);
    if (!issue || issue.state !== 'open') return { kind: 'superseded', why: `#${n} is closed` };
  } catch {
    return { kind: 'refused', why: `#${n} could not be read` };
  }
  const cited = await verifyCited(forges, n, claim.evidence);
  return cited.ok ? { kind: 'verified' } : { kind: 'refused', why: cited.why };
}

/**
 * Settles a refused claim: once, with the reason on the parked briefing as `needs_command`, as
 * `briefItemRuling` does. The item stays parked; the claim is not tried again.
 */
function refuseClaim(db: Db, claim: DoneClaim, why: string, now: Date): void {
  db.transaction(() => {
    if (!settleDoneClaim(db, claim.id, 'refused', why, now)) return;
    briefClaim(db, claim, `${CLAIM_REFUSED}${why}`, now);
  })();
}

/** Puts `recommendation` on the claim's still-open briefing, as `needs_command`. */
function briefClaim(db: Db, claim: DoneClaim, recommendation: string, now: Date): void {
  const b = db
    .prepare(`SELECT why, diagnosis FROM briefings WHERE id = ? AND state = 'open'`)
    .get(claim.briefingId) as { why: string; diagnosis: string | null } | undefined;
  if (!b) return;
  recordDiagnosis(
    db,
    claim.briefingId,
    {
      diagnosis: b.diagnosis ?? claim.diagnosis,
      basis: whyBasis(b.why),
      recommendation: `needs_command: ${recommendation}`,
    },
    now,
    { spent: true },
  );
}

/**
 * Runs `op` unless it is done; whether it is done now. A failure is tried again next pass: a
 * refused (4xx) comment sent nothing, and one whose answer was lost is read back by its marker; a
 * close not done is sent again (closing a closed issue changes nothing), as Close as done does.
 */
async function runOnce(db: Db, forges: ForgePair, op: Op, now: Date): Promise<boolean> {
  const row = getOutbox(db, op.opKey);
  if (row?.state === 'done') return true;
  if (row && (row.state === 'failed' || op.kind === 'update_issue')) deleteOutbox(db, op.opKey);
  try {
    return (await runOp(db, forges, op, now)).state === 'done';
  } catch {
    return false;
  }
}

/**
 * Settles a claim whose closing comment was sent but which no longer stands (#591): its close
 * outbox row (not done) removed so no pass sends it, then, only while the issue is still open, one
 * follow-up comment by keys derived from the claim, then the claim `superseded` with `why`. The
 * item is left as the ruling set it. A read or follow-up not done leaves the claim `verifying` for
 * the next pass, which checks again. Returns how many ops it ran.
 */
async function retractClaim(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  claim: DoneClaim,
  why: string,
  now: Date,
): Promise<number> {
  const keys = claimKeys(zone.id, claim.id);
  const close = getOutbox(db, keys.close);
  if (close && close.state !== 'done') deleteOutbox(db, keys.close);
  let ran = 0;
  const n = getWorkItem(db, claim.itemId)?.issueNumber;
  const sent = getOutbox(db, keys.retract);
  if (n !== undefined && sent?.state !== 'done') {
    // A follow-up maybe sent is read back by its marker; otherwise only an open issue gets one.
    let post = sent !== undefined && sent.state !== 'failed';
    if (!post) {
      try {
        post = (await forges.author.getIssue(n))?.state === 'open';
      } catch {
        return ran;
      }
    }
    if (post) {
      ran++;
      const op: Op = {
        kind: 'comment_issue',
        opKey: keys.retract,
        zoneId: zone.id,
        itemId: null,
        payload: {
          number: n,
          body: claimRetractComment(why),
          marker: keys.retractMarker,
        } satisfies CommentIssuePayload,
      };
      if (!(await runOnce(db, forges, op, now))) return ran;
    }
  }
  settleDoneClaim(db, claim.id, 'superseded', why, now);
  return ran;
}

/**
 * Settles each `verifying` claim that a parked item is already done (#536), only in an active
 * zone with the kill switch off. A claim the server's facts no longer back (the item no longer
 * parked, its briefing not open or changed, its issue closed) is superseded and writes nothing. A
 * cited item that fails `verifyCited`, or a lookup that throws, refuses it: the reason goes on the
 * briefing as `needs_command`. Verified, with `crew.closeDone`: a comment, then the issue closed as
 * completed, then the item `done` and its briefing withdrawn, each once by keys derived from the
 * claim (D3); a write not done leaves it `verifying` for the next pass, which checks again that it
 * stands before the close (#591): one no longer standing is retracted by `retractClaim`. Without `crew.closeDone`
 * it is `done` and the briefing names what verified it. Returns how many ops it ran.
 */
export async function flushDoneClaims(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  secrets: string[],
  now: Date,
): Promise<number> {
  if (isKilled(db) || getZoneMode(db, zone.id, zone.mode) !== 'active') return 0;
  let ran = 0;
  for (const claim of listVerifyingDoneClaims(db, zone.id)) {
    const keys = claimKeys(zone.id, claim.id);
    const comment = getOutbox(db, keys.comment);
    // A comment sent (or maybe sent) commits the claim: it was verified before it was written.
    const committed = comment !== undefined && comment.state !== 'failed';
    if (committed) {
      // Sent the comment, the claim still closes only while it stands (#591): a ruling or a
      // changed briefing since then supersedes it, before any close is sent.
      const stale = claimStands(db, claim);
      if (stale) {
        ran += await retractClaim(db, forges, zone, claim, stale, now);
        continue;
      }
    } else {
      const check = await checkClaim(db, forges, claim);
      // Re-read: a ruling or another pass may have moved it while the forge was read.
      if (getDoneClaim(db, claim.id)?.state !== 'verifying') continue;
      if (check.kind !== 'verified') {
        if (check.kind === 'superseded')
          settleDoneClaim(db, claim.id, 'superseded', check.why, now);
        else refuseClaim(db, claim, check.why, now);
        continue;
      }
      const stale = claimStands(db, claim);
      if (stale) {
        settleDoneClaim(db, claim.id, 'superseded', stale, now);
        continue;
      }
      if (!zone.crew.closeDone) {
        db.transaction(() => {
          if (!settleDoneClaim(db, claim.id, 'done', null, now)) return;
          briefClaim(db, claim, `verified already done in ${citedList(claim.evidence)}`, now);
        })();
        continue;
      }
    }
    const item = getWorkItem(db, claim.itemId);
    if (!item) continue;
    const commentOp: Op = {
      kind: 'comment_issue',
      opKey: keys.comment,
      zoneId: zone.id,
      itemId: null,
      payload: {
        number: item.issueNumber,
        body: claimComment(claim, secrets),
        marker: keys.marker,
      } satisfies CommentIssuePayload,
    };
    const closeOp: Op = {
      kind: 'update_issue',
      opKey: keys.close,
      zoneId: zone.id,
      itemId: null,
      payload: {
        number: item.issueNumber,
        state: 'closed',
        stateReason: 'completed',
      } satisfies UpdateIssuePayload,
    };
    // The close waits until its comment is done.
    let done = true;
    for (const op of [commentOp, closeOp]) {
      if (getOutbox(db, op.opKey)?.state !== 'done') ran++;
      if (!(await runOnce(db, forges, op, now))) {
        done = false;
        break;
      }
    }
    if (!done) continue;
    db.transaction(() => {
      if (!settleDoneClaim(db, claim.id, 'done', null, now)) return;
      if (getWorkItem(db, claim.itemId)?.state === 'parked') {
        setWorkItemState(db, claim.itemId, 'done', CLAIM_DONE_REASON, now);
      }
      withdrawBriefing(db, zone.id, `item:${claim.itemId}`, now);
    })();
  }
  return ran;
}
