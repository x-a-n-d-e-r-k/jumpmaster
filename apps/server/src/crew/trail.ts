import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getOutbox, getZoneMode, isKilled, listOutbox, type OutboxRow } from '../db/repo.js';
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
  getTriageRequest,
  listTriageRequests,
  setTriageRequest,
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

/**
 * Checks an `already-done` request's evidence against the forge (#466): the original issue is
 * open with the text triaged; every cited pull is merged to the default branch; every cited issue
 * is another issue (not a pull request) closed as completed. Reads only. The reason it refuses
 * names numbers only, never forge or agent text.
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
    const defaultBranch = await forges.author.getDefaultBranch();
    for (const p of pulls) {
      const pull = await forges.author.getPull(p);
      if (!pull) return refused(`#${p} not found`);
      if (pull.merged !== true) return refused(`#${p} is not merged`);
      if (pull.baseRef !== defaultBranch)
        return refused(`#${p} was not merged to the default branch`);
    }
    for (const i of issues) {
      if (i === n) return refused(`#${i} is this issue`);
      const issue = await forges.author.getIssue(i);
      if (!issue) return refused(`#${i} not found`);
      if (issue.pullRequest === true) return refused(`#${i} is a pull request, not an issue`);
      if (issue.state !== 'closed') return refused(`#${i} is not closed`);
      if (issue.stateReason !== 'completed') return refused(`#${i} was not closed as completed`);
    }
  } catch {
    // D2: a lookup that failed proves nothing.
    return refused('a cited item could not be read');
  }
  return { kind: 'verified' };
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

/** Runs each op not already done; a failure is tried again next pass. Counts the ops it ran. */
async function runEach(db: Db, forges: ForgePair, ops: Op[], now: Date): Promise<number> {
  let ran = 0;
  for (const op of ops) {
    if (getOutbox(db, op.opKey)?.state === 'done') continue;
    try {
      await runOp(db, forges, op, now);
      ran++;
    } catch {
      // A forge read or write failed: tried again next pass.
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
    // The close waits until its comment and label swap are done (#466).
    if (trail.close && trailOps.every((op) => getOutbox(db, op.opKey)?.state === 'done')) {
      ran += await runEach(db, forges, [trail.close], now);
    }
    if (children && trailOps.every((op) => getOutbox(db, op.opKey)?.state === 'done')) {
      ran += await closeSplitParent(db, forges, zone, req, children, now);
    }
  }
  return ran;
}
