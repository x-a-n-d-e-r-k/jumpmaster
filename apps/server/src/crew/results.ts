import {
  type CrewOutput,
  type DropResult,
  isCrewRole,
  parseCrewOutput,
} from '@jumpmaster/protocol';
import { raiseBriefing, whyBasis } from '../briefings.js';
import type { Db } from '../db/open.js';
import { appendEvents, type Drop, type DropState, updateDrop } from '../db/repo.js';
import type { CrewInputJson } from '../payloads.js';
import type { ResultDeps } from '../results.js';
import { applyCrewActions, validateIssueSpec } from './actions.js';
import { PROMOTE_OPTIONS, subjectOf } from './flush.js';
import {
  type CrewIssue,
  getCrewIssue,
  getTriageRequest,
  setCrewIssue,
  setTriageRequest,
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

/** A refute's verdict on a staged crew issue. Nothing happens if the issue has moved on. */
function applyRefute(
  db: Db,
  deps: ResultDeps,
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
  const subject = subjectOf(issue);
  const label = issue.number !== null ? `crew issue #${issue.number}` : `crew issue ${issue.key}`;

  if (out.decision === 'promote') {
    if (zone.crew.refutePromotes) {
      // hold_until is set by the first active flush that sees it (one pass for Command).
      setCrewIssue(db, issue.id, { ...base, state: 'promote_held' }, now);
      raiseBriefing(
        db,
        {
          zoneId: zone.id,
          kind: 'promote_held',
          subject,
          decision: `The refute promoted ${label}. It will be promoted after one active pass unless you reject it.`,
          why: 'Every criterion survived the refute, and this zone lets a refute promote.',
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
        decision: `Promote ${label}?`,
        why: 'Every criterion survived the refute.',
        options: PROMOTE_OPTIONS,
        onHold: label,
        source: 'server',
      },
      now,
    );
    return;
  }

  if (out.decision === 'revise') {
    const title = out.revisedTitle ?? issue.title;
    const body = out.revisedBody ?? issue.body;
    const revised = out.revisedTitle !== undefined || out.revisedBody !== undefined;
    if (revised && validateIssueSpec(title, body).length === 0) {
      setCrewIssue(db, issue.id, { ...base, state: 'revising', title, body }, now);
      if (issue.refuteCount >= zone.crew.maxRefute) {
        raiseBriefing(
          db,
          {
            zoneId: zone.id,
            kind: 'refute_exhausted',
            subject,
            decision: `Promote ${label} as revised?`,
            why: `The refute revised it and its ${zone.crew.maxRefute} refute attempts are used up.`,
            options: PROMOTE_OPTIONS,
            onHold: label,
            source: 'server',
          },
          now,
        );
      }
      return;
    }
    // A revision that is missing or not in the agent-ready format counts as a rejection.
  }
  setCrewIssue(db, issue.id, { ...base, state: 'rejecting' }, now);
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
  db.prepare(
    `UPDATE briefings SET diagnosis = ?, diagnosis_basis = ?, recommendation = ?, updated_at = ?
       WHERE id = ?`,
  ).run(
    out.diagnosis,
    basis,
    `${out.recommendation}: ${out.detail}`,
    now.toISOString(),
    work.briefingId,
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
      const issue = getCrewIssue(db, work.crewIssueId);
      if (issue) applyRefute(db, deps, issue, parsed.value as CrewOutput['refute'], now);
    } else if (role === 'triage' && work?.role === 'triage') {
      const out = parsed.value as CrewOutput['triage'];
      const note = applyTriage(db, deps, drop, work.requestId, out, now);
      return finish(db, drop, 'succeeded', now, note);
    } else if (role === 'diagnose' && work?.role === 'diagnose') {
      const discarded = applyDiagnose(db, work, parsed.value as CrewOutput['diagnose'], now);
      return finish(db, drop, 'succeeded', now, discarded);
    }
    finish(db, drop, 'succeeded', now);
  })();
}
