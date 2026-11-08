import { createHash } from 'node:crypto';
import type { DropZoneConfig } from './config.js';
import { applyCreditsEffect } from './credits.js';
import { crewBodySha, liveCrewBody } from './crew/flush.js';
import { getCrewIssue, setCrewIssue } from './crew/store.js';
import type { Db } from './db/open.js';
import {
  activeDropFor,
  type GatePark,
  getGatePark,
  getPullRequest,
  getWorkItem,
  listWorkItems,
  recordGateAllowance,
  setWorkItemState,
  type WorkItem,
} from './db/repo.js';
import { enableFable } from './fable.js';
import { GATE_PARK_PREFIXES, gateParkAllowable } from './flow/decide.js';
import { gateDigest } from './flow/snapshot.js';
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
  | 'allow_gate_change'
  | 'resume_after_credits';
/**
 * `sha` is set by the server on an `allow_gate_change` option: the head it was offered for. A crew
 * briefing carries effect `none` only, so it can never offer one.
 */
export type BriefingOption = {
  id: string;
  label: string;
  effect: Effect;
  sha?: string;
  /** With `sha`: the merge base and gateDigest of the changes the briefing listed. */
  mergeBase?: string;
  digest?: string;
  prNumber?: number;
};
export type BriefingState = 'open' | 'ruled' | 'withdrawn';
/**
 * Who raised a briefing: the server, a crew drop, or Command's own assistant over MCP. Only the
 * server defines effects; `crew` and `mcp` briefings carry effect `none` only.
 */
export type BriefingSource = 'server' | 'crew' | 'mcp';

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
  source: BriefingSource;
  sourceRef?: string | null;
};

export type Briefing = Required<Omit<NewBriefing, 'sourceRef'>> & {
  id: number;
  sourceRef: string | null;
  state: BriefingState;
  diagnoseAttempts: number;
  /** A parked briefing's diagnosis by the crew, shown beside the server-built `why`. */
  diagnosis: string | null;
  /** `whyBasis` of the `why` the diagnosis was about. */
  diagnosisBasis: string | null;
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
  /** The ruled briefing's diagnosis, if it had one: what Command read when it ruled. */
  diagnosis: string | null;
  /** The chosen option's effect (`null` if the option is not on the briefing). */
  effect: Effect | null;
};

/**
 * Effects that move a crew issue toward work (or read the forge for it): with the zone's crew
 * disabled they wait, recorded, and apply once it is enabled again. `reject_issue` never waits:
 * it is Command's brake on a promoted issue before its work starts.
 */
export const WAITS_FOR_CREW: ReadonlySet<Effect> = new Set<Effect>([
  'promote_issue',
  'restage_issue',
]);

/**
 * What a diagnosis is about: the sha256 of the server-built `why` it was asked for. A diagnosis is
 * shown only while the briefing's `why` still hashes to it.
 */
export const whyBasis = (why: string): string => createHash('sha256').update(why).digest('hex');

const BRIEFING_COLS = `id, zone_id AS zoneId, kind, subject, decision, why, options_json AS optionsJson,
  recommendation, on_hold AS onHold, source, source_ref AS sourceRef, state,
  diagnose_attempts AS diagnoseAttempts, diagnosis, diagnosis_basis AS diagnosisBasis,
  created_at AS createdAt, updated_at AS updatedAt`;

const RULING_COLS = `r.id, r.zone_id AS zoneId, r.briefing_id AS briefingId, r.choice, r.note,
  r.created_at AS createdAt, r.applied_at AS appliedAt, r.apply_error AS applyError,
  b.diagnosis, b.options_json AS optionsJson`;

type BriefingRow = Omit<Briefing, 'options'> & { optionsJson: string };
const toBriefing = ({ optionsJson, ...r }: BriefingRow): Briefing => ({
  ...r,
  options: JSON.parse(optionsJson) as BriefingOption[],
});

/**
 * Raises a briefing, or updates the open one on the same subject. A crew-raised briefing may only
 * carry options with effect `none`: only the server defines effects. Never touches a diagnosis:
 * `syncParkBriefings` decides when one no longer applies.
 */
export function raiseBriefing(db: Db, b: NewBriefing, now: Date): number {
  if (b.source !== 'server' && b.options.some((o) => o.effect !== 'none')) {
    throw new Error(`a ${b.source} briefing may only carry options with effect none`);
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
  const rows = db
    .prepare(
      `SELECT ${RULING_COLS} FROM rulings r JOIN briefings b ON b.id = r.briefing_id
         WHERE r.zone_id = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(zoneId, limit) as (Omit<Ruling, 'effect'> & { optionsJson: string })[];
  return rows.map(({ optionsJson, ...r }) => ({
    ...r,
    effect:
      (JSON.parse(optionsJson) as BriefingOption[]).find((o) => o.id === r.choice)?.effect ?? null,
  }));
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
    case 'resume_after_credits':
      applyCreditsEffect(db, subject, effect, now);
      return true;
  }
}

const NOT_ALLOWABLE = 'allow_gate_change needs a server parked briefing with a head';
/** An Allow ruled on a briefing that no longer says what the item is parked on. */
const OUT_OF_DATE = 'briefing out of date';
/** PR reads that fail (other than a 404) before an allow ruling gives up. */
const MAX_APPLY_ATTEMPTS = 10;

/**
 * Applies an `allow_gate_change` ruling: records Command's allowance of the option's head for the
 * item. Allows nothing (throws `head moved`) when the PR's head is no longer that SHA. Idempotent;
 * an item that left parked meanwhile is left alone. Returns false when the PR can't be read yet.
 */
export async function applyGateAllowance(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  ruling: {
    id: number;
    subject: string;
    kind: BriefingKind;
    source: BriefingSource;
    why: string;
  },
  option: BriefingOption,
  now: Date,
): Promise<boolean> {
  const itemId = idOf(ruling.subject, 'item:');
  const { sha, mergeBase, digest, prNumber } = option;
  if (ruling.source !== 'server' || ruling.kind !== 'parked' || itemId === null) {
    throw new Error(NOT_ALLOWABLE);
  }
  if (!sha || !mergeBase || !digest || prNumber === undefined) throw new Error(NOT_ALLOWABLE);
  const item = getWorkItem(db, itemId);
  if (!item || item.dropZoneId !== zoneId || item.state !== 'parked') return true;
  // Command allowed what its briefing showed: the briefing raised now must be the same one.
  const current = parkBriefing(db, zoneId, item);
  const allowNow = current.options.find((o) => o.effect === 'allow_gate_change');
  if (current.why !== ruling.why || JSON.stringify(allowNow) !== JSON.stringify(option)) {
    throw new Error(OUT_OF_DATE);
  }
  // (parkBriefing offers Allow only while the item's current PR is the one judged.)
  let pr: Awaited<ReturnType<ForgePair['author']['getPull']>>;
  try {
    pr = await deps.forges(zoneId).author.getPull(prNumber);
  } catch {
    // Not a 404 (that reads as null): try again next pass, but not forever.
    const tries = db
      .prepare(
        'UPDATE rulings SET apply_attempts = apply_attempts + 1 WHERE id = ? RETURNING apply_attempts AS n',
      )
      .get(ruling.id) as { n: number } | undefined;
    if ((tries?.n ?? MAX_APPLY_ATTEMPTS) >= MAX_APPLY_ATTEMPTS)
      throw new Error('forge unavailable');
    return false;
  }
  if (!pr || pr.state !== 'open' || pr.merged) throw new Error('pull request not open');
  if (pr.headSha !== sha) throw new Error('head moved');
  recordGateAllowance(
    db,
    { itemId, prNumber, headSha: sha, mergeBaseSha: mergeBase, digest, rulingId: ruling.id },
    now,
  );
  return true;
}

/**
 * Applies the zone's recorded rulings that are neither applied nor failed, each exactly once. A
 * failed effect records `apply_error` and is not tried again. A ruling whose effect waits for the
 * crew (`WAITS_FOR_CREW`) stays pending while the zone's crew is disabled. `credits:*` rulings are
 * the pass's global step (`creditsPass`), in any zone mode. Returns how many were applied.
 */
export async function applyPendingRulings(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  now: Date,
): Promise<number> {
  const pending = db
    .prepare(
      `SELECT r.id, r.choice, b.subject, b.kind, b.source, b.why, b.options_json AS optionsJson
         FROM rulings r JOIN briefings b ON b.id = r.briefing_id
       WHERE r.zone_id = ? AND r.applied_at IS NULL AND r.apply_error IS NULL
         AND b.subject NOT LIKE 'credits:%' ORDER BY r.id`,
    )
    .all(zoneId) as {
    id: number;
    choice: string;
    subject: string;
    kind: BriefingKind;
    source: BriefingSource;
    why: string;
    optionsJson: string;
  }[];
  let applied = 0;
  for (const r of pending) {
    const option = (JSON.parse(r.optionsJson) as BriefingOption[]).find((o) => o.id === r.choice);
    try {
      if (!option) throw new Error(`option ${r.choice} is not on the briefing`);
      if (WAITS_FOR_CREW.has(option.effect) && !deps.zone(zoneId).crew?.enabled) continue;
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
 * One open `parked` briefing per parked item, withdrawn once the item leaves parked, and refreshed
 * while open when what it would say has changed (a new head judged, a park that became or stopped
 * being fully read). A refresh keeps the crew's diagnosis and recommendation while the server-built
 * `why` is unchanged; when the `why` changes they no longer apply: they are cleared and the
 * briefing is diagnosed afresh. An item whose briefing was ruled is not briefed again until it
 * parks again or its gate park is judged afresh (a new head, merge base or change list), unless
 * the ruling was refused as out of date: then Command is asked again about what it is parked on.
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
    `SELECT 1 FROM briefings b WHERE b.zone_id = ? AND b.subject = ? AND b.state = 'ruled'
       AND b.updated_at >= ?
       AND NOT EXISTS (SELECT 1 FROM rulings r WHERE r.briefing_id = b.id AND r.apply_error = ?)
     LIMIT 1`,
  );
  const forget = db.prepare(
    `UPDATE briefings SET diagnosis = NULL, diagnosis_basis = NULL, diagnose_attempts = 0
       WHERE id = ?`,
  );
  const open = new Map(
    listBriefings(db, { zoneId: zone.id, state: 'open' }).map((b) => [b.subject, b]),
  );
  for (const item of parked) {
    const subject = `item:${item.id}`;
    const want = parkBriefing(db, zone.id, item);
    const current = open.get(subject);
    if (current) {
      const whySame = current.why === want.why;
      const same =
        whySame &&
        current.decision === want.decision &&
        JSON.stringify(current.options) === JSON.stringify(want.options);
      if (same) continue;
      db.transaction(() => {
        raiseBriefing(db, { ...want, recommendation: whySame ? current.recommendation : '' }, now);
        if (!whySame) forget.run(current.id);
      })();
      continue;
    }
    const parkedAtTime = (parkedAt.get(item.id) as { at: string }).at;
    const judged = GATE_PARK_PREFIXES.some((p) => (item.reason ?? '').startsWith(p))
      ? getGatePark(db, item.id)?.recordedAt
      : undefined;
    const at = judged && judged > parkedAtTime ? judged : parkedAtTime;
    if (ruledSince.get(zone.id, subject, at, OUT_OF_DATE)) continue;
    raiseBriefing(db, want, now);
  }
}

/** The most a briefing's why carries; a longer gate change list is cut and not allowable. */
export const MAX_BRIEFING_WHY = 8000;
const CUT_NOTE = '\n… (cut: too long to review here; merge it by hand)';

/**
 * A gate park's why: the park reason, then every change it judged in full (scripts old → new,
 * tool changes old → new where known). `complete` is false when it had to be cut.
 */
export function gateParkWhy(reason: string, park: GatePark): { why: string; complete: boolean } {
  const lines = [
    reason,
    '',
    `Every gate change on head ${park.headSha.slice(0, 7)} (merge base ${park.mergeBaseSha.slice(0, 7)}, PR #${park.prNumber}):`,
  ];
  if (park.details.scripts.length > 0) {
    lines.push('gate script changed:', ...park.details.scripts.map((d) => `  ${d}`));
  }
  if (park.details.tools.length > 0) {
    lines.push('gate tool changed:', ...park.details.tools.map((d) => `  ${d}`));
  }
  const full = lines.join('\n');
  if (full.length <= MAX_BRIEFING_WHY) return { why: full, complete: true };
  return { why: full.slice(0, MAX_BRIEFING_WHY - CUT_NOTE.length) + CUT_NOTE, complete: false };
}

/** The parked briefing the server raises for `item` now. */
function parkBriefing(db: Db, zoneId: string, item: WorkItem): NewBriefing {
  const reason = item.reason ?? 'no reason recorded';
  const options: BriefingOption[] = [
    { id: 'retry', label: 'Retry', effect: 'retry_item' },
    { id: 'leave', label: 'Leave parked', effect: 'none' },
  ];
  let decision = `Issue #${item.issueNumber} is parked. Retry it?`;
  let why = reason;
  const park = GATE_PARK_PREFIXES.some((p) => reason.startsWith(p))
    ? getGatePark(db, item.id)
    : undefined;
  if (park) {
    const g = gateParkWhy(reason, park);
    why = g.why;
    const sha7 = park.headSha.slice(0, 7);
    decision = `Issue #${item.issueNumber} is parked on a gate change. Read the PR diff at ${sha7} on the forge before ruling.`;
    // Allowable only for the head it judged, when every change is listed and was fully read.
    const pr = getPullRequest(db, item.id);
    const current = pr?.headSha === park.headSha && pr.number === park.prNumber;
    if (g.complete && current && gateParkAllowable(reason)) {
      const digest = gateDigest(park.details);
      options.push({
        // Bound to the head and changes shown: a page showing an older briefing can't rule this.
        id: `allow-${park.headSha.slice(0, 12)}-${digest.slice(0, 8)}`,
        label: `Allow these gate changes for ${sha7}`,
        effect: 'allow_gate_change',
        sha: park.headSha,
        mergeBase: park.mergeBaseSha,
        digest,
        prNumber: park.prNumber,
      });
    }
  }
  return {
    zoneId,
    kind: 'parked',
    subject: `item:${item.id}`,
    decision,
    why,
    options,
    recommendation: '',
    onHold: `Issue #${item.issueNumber}`,
    source: 'server',
  };
}
