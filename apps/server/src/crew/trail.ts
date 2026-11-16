import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getOutbox, getZoneMode, isKilled } from '../db/repo.js';
import {
  type CommentIssuePayload,
  commentMarker,
  type ForgePair,
  type Op,
  opKeys,
  runOp,
  type SetLabelsPayload,
  sanitizeCrewText,
} from '../outbox.js';
import { listTriageRequests, type TriageRequest } from './store.js';

/**
 * The trail a triage outcome leaves on the original issue (#185): one comment, and for a final
 * outcome the label swap. The comment is built from the outcome, the child numbers, the briefing
 * subject and the reason only: never from the issue's own text.
 */
type Trail = { comment: Op; labels?: Op };

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

function trailOf(
  db: Db,
  zone: DropZoneConfig,
  req: TriageRequest,
  secrets: string[],
): Trail | null {
  const n = req.issueNumber;
  const comment = (body: string, questions = false): Op => {
    const key = trailKey(req, questions);
    const payload: CommentIssuePayload = {
      number: n,
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
  };
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
  // Superseded requests and failed ones leave no trail: only these three states do.
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
    return {
      comment: comment(
        `Jumpmaster split this into ${list}. They start once they are reviewed and promoted.`,
      ),
      labels: swap,
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

/**
 * Leaves each triage outcome's trail on its original issue through the outbox, as the author
 * identity: idempotent per request by the comment marker and the op keys (D3). Only in an active
 * zone with the kill switch off. Returns how many ops it ran that were not already done.
 */
export async function flushTriageTrail(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  secrets: string[],
  now: Date,
): Promise<number> {
  if (isKilled(db) || getZoneMode(db, zone.id, zone.mode) !== 'active') return 0;
  let ran = 0;
  for (const req of listTriageRequests(db, zone.id)) {
    const trail = trailOf(db, zone, req, secrets);
    if (!trail) continue;
    for (const op of [trail.comment, trail.labels]) {
      if (!op || getOutbox(db, op.opKey)?.state === 'done') continue;
      try {
        await runOp(db, forges, op, now);
        ran++;
      } catch {
        // A forge read or write failed: tried again next pass.
      }
    }
  }
  return ran;
}
