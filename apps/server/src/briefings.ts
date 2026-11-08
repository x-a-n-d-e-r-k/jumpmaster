import type { DropZoneConfig } from './config.js';
import { crewBodySha, liveCrewBody } from './crew/flush.js';
import { getCrewIssue, setCrewIssue } from './crew/store.js';
import type { Db } from './db/open.js';
import {
  activeDropFor,
  getPullRequest,
  getWorkItem,
  listWorkItems,
  recordGateAllowance,
  setWorkItemState,
} from './db/repo.js';
import { enableFable } from './fable.js';
import { gateParkAllowable } from './flow/decide.js';
import type { ForgePair } from './outbox.js';
import { retryParkedItem } from './sync.js';

export type BriefingKind =
  | 'parked'
  | 'promote'
  | 'promote_held'
  | 'refute_exhausted'
  | 'crew'
  | 'credits_required';
export type Effect =
  | 'none'
  | 'retry_item'
  | 'promote_issue'
  | 'reject_issue'
  | 'restage_issue'
  | 'enable_fable'
  | 'allow_gate_change';
/**
 * `sha` is set by the server on an `allow_gate_change` option: the head it was offered for. A crew
 * briefing carries effect `none` only, so it can never offer one.
 */
export type BriefingOption = { id: string; label: string; effect: Effect; sha?: string };
export type BriefingState = 'open' | 'ruled' | 'withdrawn';

export type NewBriefing = {
  zoneId: string;
  kind: BriefingKind;
  /** What the briefing is about (`item:<id>`, `issue:<crewIssueId>`, or crew text). */
  subject: string;
  decision: string;
  why: string;
  options: BriefingOption[];
  recommendation?: string;
  onHold?: string;
  source: 'server' | 'crew';
  sourceRef?: string | null;
};

export type Briefing = Required<Omit<NewBriefing, 'sourceRef'>> & {
  id: number;
  sourceRef: string | null;
  state: BriefingState;
  diagnoseAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type Ruling = {
  id: number;
  zoneId: string;
  briefingId: number;
  choice: string;
  note: string;
  createdAt: string;
  appliedAt: string | null;
  applyError: string | null;
};

const BRIEFING_COLS = `id, zone_id AS zoneId, kind, subject, decision, why, options_json AS optionsJson,
  recommendation, on_hold AS onHold, source, source_ref AS sourceRef, state,
  diagnose_attempts AS diagnoseAttempts, created_at AS createdAt, updated_at AS updatedAt`;

const RULING_COLS = `id, zone_id AS zoneId, briefing_id AS briefingId, choice, note,
  created_at AS createdAt, applied_at AS appliedAt, apply_error AS applyError`;

type BriefingRow = Omit<Briefing, 'options'> & { optionsJson: string };
const toBriefing = ({ optionsJson, ...r }: BriefingRow): Briefing => ({
  ...r,
  options: JSON.parse(optionsJson) as BriefingOption[],
});

/**
 * Raises a briefing, or updates the open one on the same subject. A crew-raised briefing may only
 * carry options with effect `none`: only the server defines effects.
 */
export function raiseBriefing(db: Db, b: NewBriefing, now: Date): number {
  if (b.source === 'crew' && b.options.some((o) => o.effect !== 'none')) {
    throw new Error('a crew briefing may only carry options with effect none');
  }
  const at = now.toISOString();
  const params = {
    zoneId: b.zoneId,
    kind: b.kind,
    subject: b.subject,
    decision: b.decision,
    why: b.why,
    optionsJson: JSON.stringify(b.options),
    recommendation: b.recommendation ?? '',
    onHold: b.onHold ?? '',
    source: b.source,
    sourceRef: b.sourceRef ?? null,
    at,
  };
  return db.transaction(() => {
    const open = db
      .prepare(`SELECT id FROM briefings WHERE zone_id = ? AND subject = ? AND state = 'open'`)
      .get(b.zoneId, b.subject) as { id: number } | undefined;
    if (open) {
      db.prepare(
        `UPDATE briefings SET kind = @kind, decision = @decision, why = @why,
           options_json = @optionsJson, recommendation = @recommendation, on_hold = @onHold,
           source = @source, source_ref = @sourceRef, updated_at = @at WHERE id = @id`,
      ).run({ ...params, id: open.id });
      return open.id;
    }
    const r = db
      .prepare(
        `INSERT INTO briefings (zone_id, kind, subject, decision, why, options_json, recommendation,
           on_hold, source, source_ref, state, created_at, updated_at)
         VALUES (@zoneId, @kind, @subject, @decision, @why, @optionsJson, @recommendation, @onHold,
           @source, @sourceRef, 'open', @at, @at)`,
      )
      .run(params);
    return Number(r.lastInsertRowid);
  })();
}

export function withdrawBriefing(db: Db, zoneId: string, subject: string, now: Date): void {
  db.prepare(
    `UPDATE briefings SET state = 'withdrawn', updated_at = ?
       WHERE zone_id = ? AND subject = ? AND state = 'open'`,
  ).run(now.toISOString(), zoneId, subject);
}

export function listBriefings(
  db: Db,
  q: { zoneId?: string; state?: BriefingState } = {},
): Briefing[] {
  const rows = db
    .prepare(
      `SELECT ${BRIEFING_COLS} FROM briefings
         WHERE (@zoneId IS NULL OR zone_id = @zoneId) AND (@state IS NULL OR state = @state)
         ORDER BY id`,
    )
    .all({ zoneId: q.zoneId ?? null, state: q.state ?? null }) as BriefingRow[];
  return rows.map(toBriefing);
}

function getBriefing(db: Db, id: number): Briefing | undefined {
  const r = db.prepare(`SELECT ${BRIEFING_COLS} FROM briefings WHERE id = ?`).get(id) as
    | BriefingRow
    | undefined;
  return r && toBriefing(r);
}

/** Whether an open briefing exists on `subject`. */
export function hasOpenBriefing(db: Db, zoneId: string, subject: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM briefings WHERE zone_id = ? AND subject = ? AND state = 'open'`)
      .get(zoneId, subject) !== undefined
  );
}

/**
 * Records Command's ruling in one transaction; it is applied by the next pass. A briefing is
 * ruled once: a second ruling (another tab) is 409.
 */
export function ruleBriefing(
  db: Db,
  id: number,
  optionId: string,
  note: string,
  now: Date,
): { ok: true; rulingId: number } | { ok: false; status: 404 | 409 | 400 } {
  return db.transaction(() => {
    const b = getBriefing(db, id);
    if (!b) return { ok: false as const, status: 404 as const };
    if (!b.options.some((o) => o.id === optionId)) {
      return { ok: false as const, status: 400 as const };
    }
    const at = now.toISOString();
    const won = db
      .prepare(
        `UPDATE briefings SET state = 'ruled', updated_at = ? WHERE id = ? AND state = 'open'`,
      )
      .run(at, id).changes;
    if (won === 0) return { ok: false as const, status: 409 as const };
    const r = db
      .prepare(
        `INSERT INTO rulings (zone_id, briefing_id, choice, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(b.zoneId, id, optionId, note, at);
    return { ok: true as const, rulingId: Number(r.lastInsertRowid) };
  })();
}

export function listRulings(db: Db, zoneId: string, limit = 50): Ruling[] {
  return db
    .prepare(`SELECT ${RULING_COLS} FROM rulings WHERE zone_id = ? ORDER BY id DESC LIMIT ?`)
    .all(zoneId, limit) as Ruling[];
}

export type RulingDeps = {
  forges(zoneId: string): ForgePair;
  zone(zoneId: string): DropZoneConfig;
};

const ISSUE_ACTIONABLE = new Set(['staged', 'promote_held', 'promoting']);

const idOf = (subject: string, prefix: string): number | null => {
  if (!subject.startsWith(prefix)) return null;
  const n = Number(subject.slice(prefix.length));
  return Number.isInteger(n) ? n : null;
};

/**
 * Applies one effect to the briefing's subject. Idempotent: an effect whose subject has moved on
 * does nothing. Returns false when it could not run yet (try again next pass); throws on error.
 */
export async function applyEffect(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  subject: string,
  effect: Effect,
  now: Date,
): Promise<boolean> {
  switch (effect) {
    case 'none':
      return true;
    case 'retry_item': {
      const id = idOf(subject, 'item:');
      if (id === null) throw new Error(`retry_item needs an item subject, got ${subject}`);
      const item = getWorkItem(db, id);
      if (!item || item.state !== 'parked') return true;
      return retryParkedItem(db, deps.forges(zoneId), item, now);
    }
    case 'promote_issue':
    case 'reject_issue': {
      const id = idOf(subject, 'issue:');
      if (id === null) throw new Error(`${effect} needs a crew issue subject, got ${subject}`);
      const issue = getCrewIssue(db, id);
      if (!issue) return true;
      if (effect === 'reject_issue' && issue.state === 'promoted') {
        // Promoted, perhaps by a write in flight when Command ruled: still rejectable until the
        // work starts. Closing the issue (rejecting) takes it out of intake.
        const item =
          issue.number === null
            ? undefined
            : listWorkItems(db, issue.zoneId).find((w) => w.issueNumber === issue.number);
        if (item && (item.state !== 'ready' || activeDropFor(db, item.id))) {
          throw new Error('already started');
        }
        if (item) setWorkItemState(db, item.id, 'done', 'rejected by Command', now);
        setCrewIssue(db, id, { state: 'rejecting' }, now);
        return true;
      }
      if (!ISSUE_ACTIONABLE.has(issue.state)) return true;
      const state = effect === 'promote_issue' ? 'promoting' : 'rejecting';
      setCrewIssue(db, id, { state }, now);
      return true;
    }
    case 'restage_issue': {
      // Takes the body as edited on the forge, so a fresh refute judges what will be promoted.
      const id = idOf(subject, 'issue:');
      if (id === null) throw new Error(`restage_issue needs a crew issue subject, got ${subject}`);
      const issue = getCrewIssue(db, id);
      if (!issue || issue.state !== 'staged' || issue.number === null) return true;
      const live = await deps.forges(zoneId).author.getIssue(issue.number);
      if (!live) return false;
      const body = liveCrewBody(live.body);
      setCrewIssue(
        db,
        id,
        { body, bodySha: crewBodySha(body), refutedSha: null, refuteCount: 0 },
        now,
      );
      return true;
    }
    case 'enable_fable':
      enableFable(db, now);
      return true;
    case 'allow_gate_change':
      throw new Error('allow_gate_change applies only through a ruling');
  }
}

const NOT_ALLOWABLE = 'allow_gate_change needs a server parked briefing with a head';

/**
 * Applies an `allow_gate_change` ruling: records Command's allowance of the option's head for the
 * item. Allows nothing (throws `head moved`) when the PR's head is no longer that SHA. Idempotent;
 * an item that left parked meanwhile is left alone. Returns false when the PR can't be read yet.
 */
export async function applyGateAllowance(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  ruling: { id: number; subject: string; kind: BriefingKind; source: 'server' | 'crew' },
  option: BriefingOption,
  now: Date,
): Promise<boolean> {
  const itemId = idOf(ruling.subject, 'item:');
  if (ruling.source !== 'server' || ruling.kind !== 'parked' || itemId === null || !option.sha) {
    throw new Error(NOT_ALLOWABLE);
  }
  const item = getWorkItem(db, itemId);
  if (!item || item.dropZoneId !== zoneId || item.state !== 'parked') return true;
  const prNumber = getPullRequest(db, item.id)?.number ?? item.prNumber;
  if (prNumber === null) throw new Error('no pull request');
  let pr: Awaited<ReturnType<ForgePair['author']['getPull']>>;
  try {
    pr = await deps.forges(zoneId).author.getPull(prNumber);
  } catch {
    return false;
  }
  if (!pr || pr.state !== 'open' || pr.merged) throw new Error('pull request not open');
  if (pr.headSha !== option.sha) throw new Error('head moved');
  recordGateAllowance(db, { itemId, headSha: option.sha, rulingId: ruling.id }, now);
  return true;
}

/**
 * Applies the zone's recorded rulings that are neither applied nor failed, each exactly once. A
 * failed effect records `apply_error` and is not tried again. Returns how many were applied.
 */
export async function applyPendingRulings(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  now: Date,
): Promise<number> {
  const pending = db
    .prepare(
      `SELECT r.id, r.choice, b.subject, b.kind, b.source, b.options_json AS optionsJson
         FROM rulings r JOIN briefings b ON b.id = r.briefing_id
       WHERE r.zone_id = ? AND r.applied_at IS NULL AND r.apply_error IS NULL ORDER BY r.id`,
    )
    .all(zoneId) as {
    id: number;
    choice: string;
    subject: string;
    kind: BriefingKind;
    source: 'server' | 'crew';
    optionsJson: string;
  }[];
  let applied = 0;
  for (const r of pending) {
    const option = (JSON.parse(r.optionsJson) as BriefingOption[]).find((o) => o.id === r.choice);
    try {
      if (!option) throw new Error(`option ${r.choice} is not on the briefing`);
      const done =
        option.effect === 'allow_gate_change'
          ? await applyGateAllowance(db, deps, zoneId, r, option, now)
          : await applyEffect(db, deps, zoneId, r.subject, option.effect, now);
      if (!done) continue;
      db.prepare('UPDATE rulings SET applied_at = ? WHERE id = ?').run(now.toISOString(), r.id);
      applied++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare('UPDATE rulings SET apply_error = ? WHERE id = ?').run(message, r.id);
    }
  }
  return applied;
}

/**
 * One open `parked` briefing per parked item, withdrawn once the item leaves parked. An item
 * whose briefing was ruled (Leave parked) is not briefed again until it parks again.
 */
export function syncParkBriefings(db: Db, zone: DropZoneConfig, now: Date): void {
  const parked = listWorkItems(db, zone.id, 'parked');
  const parkedIds = new Set(parked.map((i) => i.id));
  for (const b of listBriefings(db, { zoneId: zone.id, state: 'open' })) {
    if (b.kind !== 'parked') continue;
    const id = idOf(b.subject, 'item:');
    if (id === null || !parkedIds.has(id)) withdrawBriefing(db, zone.id, b.subject, now);
  }
  const parkedAt = db.prepare('SELECT updated_at AS at FROM work_items WHERE id = ?');
  const ruledSince = db.prepare(
    `SELECT 1 FROM briefings WHERE zone_id = ? AND subject = ? AND state = 'ruled'
       AND updated_at >= ? LIMIT 1`,
  );
  for (const item of parked) {
    const subject = `item:${item.id}`;
    if (hasOpenBriefing(db, zone.id, subject)) continue;
    const at = (parkedAt.get(item.id) as { at: string }).at;
    if (ruledSince.get(zone.id, subject, at)) continue;
    const reason = item.reason ?? 'no reason recorded';
    const options: BriefingOption[] = [
      { id: 'retry', label: 'Retry', effect: 'retry_item' },
      { id: 'leave', label: 'Leave parked', effect: 'none' },
    ];
    // A fully read gate park may be let through for the head it was judged on (the last head
    // read); the reason lists every change, so Command sees what it allows.
    const head = getPullRequest(db, item.id)?.headSha;
    if (head && gateParkAllowable(reason)) {
      options.push({
        id: 'allow',
        label: `Allow these gate changes for ${head.slice(0, 7)}`,
        effect: 'allow_gate_change',
        sha: head,
      });
    }
    raiseBriefing(
      db,
      {
        zoneId: zone.id,
        kind: 'parked',
        subject,
        decision: `Issue #${item.issueNumber} is parked. Retry it?`,
        why: reason,
        options,
        recommendation: '',
        onHold: `Issue #${item.issueNumber}`,
        source: 'server',
      },
      now,
    );
  }
}
