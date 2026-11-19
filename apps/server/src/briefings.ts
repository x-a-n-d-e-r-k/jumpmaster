import { createHash } from 'node:crypto';
import { DropResultSchema, redact } from '@jumpmaster/protocol';
import type { DropZoneConfig } from './config.js';
import { applyCreditsEffect } from './credits.js';
import { crewBodySha, liveCrewBody } from './crew/flush.js';
import {
  type CrewIssue,
  getArbitration,
  getCrewIssue,
  getCrewRetry,
  issueArbitrationSubject,
  listCrewIssues,
  setCrewIssue,
} from './crew/store.js';
import type { Db } from './db/open.js';
import {
  ACTIVE_STATES_SQL,
  activeDropFor,
  type GatePark,
  getGatePark,
  getPullRequest,
  getWorkItem,
  getZoneMode,
  isKilled,
  listWorkItems,
  recordGateAllowance,
  setWorkItemState,
  type WorkItem,
} from './db/repo.js';
import { enableFable } from './fable.js';
import { GATE_PARK_PREFIXES, gateParkAllowable } from './flow/decide.js';
import { gateDigest } from './flow/snapshot.js';
import { serverScrubSet } from './forge/scrub-set.js';
import { gateFailureWhy } from './gate-output.js';
import {
  closeProposedGoalChange,
  GOAL_CHANGE_PREFIX,
  getGoalChange,
  openGoalChange,
} from './goal-change.js';
import { GOAL_KEY, recordObjectiveDone } from './goals.js';
import type { ForgePair } from './outbox.js';
import { retryParkedItem } from './sync.js';

export type BriefingKind =
  | 'parked'
  | 'promote'
  | 'promote_held'
  | 'refute_exhausted'
  | 'crew'
  | 'credits_required'
  | 'objective_done'
  | 'goal_change';
/** Every option effect the server defines. */
export const EFFECTS = [
  'none',
  'retry_item',
  'promote_issue',
  'reject_issue',
  'restage_issue',
  'enable_fable',
  'allow_gate_change',
  'resume_after_credits',
  'advance_objective',
  'open_goal_change',
] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * What each option effect does, in one line beside its label on the page and in `ctl briefings`.
 * `byKind` says it more exactly for a kind whose `none` means something else (Leave parked, Noted).
 */
export const EFFECT_TEXT: Record<
  Effect,
  { text: string; byKind?: Partial<Record<BriefingKind, string>> }
> = {
  none: {
    text: 'recorded as guidance for the crew; nothing changes on GitHub',
    byKind: {
      parked: 'the item stays parked; nothing runs and nothing changes on GitHub',
      credits_required: 'recorded; nothing runs on credits and nothing changes on GitHub',
    },
  },
  retry_item: {
    text: 'the parked item goes back to work: an agent runs it again from where it parked',
  },
  promote_issue: { text: 'the issue gets the ready label; an implementer takes it as written' },
  reject_issue: { text: 'the issue is closed; the crew may file a replacement' },
  restage_issue: {
    text: 'the issue text is taken as edited on GitHub, and a fresh refute reviews it before any promotion',
  },
  enable_fable: { text: 'drops may run on Fable again; nothing changes on GitHub' },
  allow_gate_change: {
    text: 'the gate changes listed are allowed for this head only; the item can then merge',
  },
  resume_after_credits: {
    text: 'drops start again and run on credits until the limit given; nothing changes on GitHub',
  },
  advance_objective: {
    text: 'the objective is recorded as done; the crew moves to the next one in the goal file',
  },
  open_goal_change: {
    text: 'a pull request changing the goal file is opened; it merges only after you confirm it in the browser',
  },
};

/** The line beside an option's label: what choosing it does. */
export const effectText = (kind: BriefingKind, effect: Effect): string =>
  EFFECT_TEXT[effect].byKind?.[kind] ?? EFFECT_TEXT[effect].text;
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
/** `dismissed`: Command took it off the floor without ruling; its condition is not ruled on. */
export type BriefingState = 'open' | 'ruled' | 'withdrawn' | 'dismissed';
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
  /** The chosen option's effect, as recorded when Command ruled (`null` if unknown). */
  effect: Effect | null;
  /** The chosen option's label, as recorded when Command ruled (`null` if unknown). */
  label: string | null;
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

/**
 * Writes a diagnosis beside a briefing's server-written why: `basis` is the `whyBasis` of the why
 * it answers, so a refresh that changes the why clears it. With `spent`, the briefing counts as
 * diagnosed (`diagnose_attempts` at least 1), so no diagnose drop runs on top.
 */
export function recordDiagnosis(
  db: Db,
  briefingId: number,
  d: { diagnosis: string; basis: string; recommendation: string },
  now: Date,
  opts: { spent?: boolean } = {},
): void {
  db.prepare(
    `UPDATE briefings SET diagnosis = ?, diagnosis_basis = ?, recommendation = ?, updated_at = ?
       WHERE id = ?`,
  ).run(d.diagnosis, d.basis, d.recommendation, now.toISOString(), briefingId);
  if (opts.spent) {
    db.prepare(
      'UPDATE briefings SET diagnose_attempts = MAX(diagnose_attempts, 1) WHERE id = ?',
    ).run(briefingId);
  }
}

const BRIEFING_COLS = `id, zone_id AS zoneId, kind, subject, decision, why, options_json AS optionsJson,
  recommendation, on_hold AS onHold, source, source_ref AS sourceRef, state,
  diagnose_attempts AS diagnoseAttempts, diagnosis, diagnosis_basis AS diagnosisBasis,
  created_at AS createdAt, updated_at AS updatedAt`;

const RULING_COLS = `r.id, r.zone_id AS zoneId, r.briefing_id AS briefingId, r.choice, r.note,
  r.created_at AS createdAt, r.applied_at AS appliedAt, r.apply_error AS applyError,
  r.choice_label AS choiceLabel, r.choice_effect AS choiceEffect,
  b.diagnosis, b.options_json AS optionsJson`;

/**
 * A short digest of what a briefing shows Command (decision, why, recommendation, on hold, and
 * the options' ids, labels and effects): given by the page and `ctl briefings`, so a ruling can
 * say what it was made on.
 */
export const optionsDigest = (
  b: Pick<Briefing, 'decision' | 'why' | 'recommendation' | 'onHold' | 'options'>,
): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        b.decision,
        b.why,
        b.recommendation,
        b.onHold,
        b.options.map((o) => [o.id, o.label, o.effect]),
      ]),
    )
    .digest('hex')
    .slice(0, 16);

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

/**
 * Withdraws every open briefing of a zone (issue #178): the zone was removed, so nothing will
 * rule them. Returns how many were withdrawn.
 */
export function withdrawZoneBriefings(db: Db, zoneId: string, now: Date): number {
  return db
    .prepare(
      `UPDATE briefings SET state = 'withdrawn', updated_at = ? WHERE zone_id = ? AND state = 'open'`,
    )
    .run(now.toISOString(), zoneId).changes;
}

/** Withdraws every open briefing whose zone is not among `zoneIds`; returns how many. */
export function withdrawBriefingsOutside(db: Db, zoneIds: readonly string[], now: Date): number {
  return db
    .prepare(
      `UPDATE briefings SET state = 'withdrawn', updated_at = ?
         WHERE state = 'open' AND zone_id NOT IN (SELECT value FROM json_each(?))`,
    )
    .run(now.toISOString(), JSON.stringify(zoneIds)).changes;
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

/** A zone whose open briefings the floor holds back: one line for the lot, not each briefing. */
export type HeldZone = { zoneId: string; repo: string; mode: string; count: number };

/** Modes in which a zone starts no work, so its briefings wait off the floor (issue #98). */
export const HELD_MODES: ReadonlySet<string> = new Set(['paused', 'observe']);

/**
 * Briefing kinds that are notices with a veto, not requests: they go ahead unless Command stops
 * them, so they never count as needing Command (#449).
 */
export const NOTICE_KINDS: ReadonlySet<BriefingKind> = new Set<BriefingKind>(['promote_held']);

/** Whether an open briefing is a notice (goes ahead unless stopped), not one that needs Command. */
export const isNotice = (b: Pick<Briefing, 'kind'>): boolean => NOTICE_KINDS.has(b.kind);

/**
 * The open briefings the floor lists as needing Command, the notices that go ahead unless Command
 * stops them, and the zones (paused or observing) whose briefings it holds back (every kind). Only
 * the floor's view: the briefings are unchanged, and resuming the zone lists them again. A
 * briefing of a zone not among `zones` (removed from the config) is not counted at all (#178).
 */
export function floorBriefings(
  db: Db,
  zones: readonly Pick<DropZoneConfig, 'id' | 'repo' | 'mode'>[],
): { listed: Briefing[]; notices: Briefing[]; held: HeldZone[] } {
  const open = listBriefings(db, { state: 'open' });
  const held = zones
    .map((z) => ({ zoneId: z.id, repo: z.repo, mode: getZoneMode(db, z.id, z.mode), count: 0 }))
    .filter((z) => HELD_MODES.has(z.mode));
  const byZone = new Map(held.map((z) => [z.zoneId, z]));
  const configured = new Set(zones.map((z) => z.id));
  const listed: Briefing[] = [];
  const notices: Briefing[] = [];
  for (const b of open) {
    if (!configured.has(b.zoneId)) continue;
    const h = byZone.get(b.zoneId);
    if (h) h.count++;
    else if (isNotice(b)) notices.push(b);
    else listed.push(b);
  }
  return { listed, notices, held: held.filter((z) => z.count > 0) };
}

export function getBriefing(db: Db, id: number): Briefing | undefined {
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
 * ruled once: a second ruling (another tab) is 409. The chosen option's label and effect are
 * recorded with it. An assistant (MCP) briefing can be rewritten while open, so a ruling on one
 * must name the option set it was made on (`optionsDigest`); otherwise, or if they changed, 409.
 */
export function ruleBriefing(
  db: Db,
  id: number,
  optionId: string,
  note: string,
  now: Date,
  seen: { optionsDigest?: string } = {},
):
  | { ok: true; rulingId: number }
  | { ok: false; status: 404 | 409 | 400; reason?: 'options changed' } {
  return db.transaction(() => {
    const b = getBriefing(db, id);
    if (!b) return { ok: false as const, status: 404 as const };
    const option = b.options.find((o) => o.id === optionId);
    if (!option) return { ok: false as const, status: 400 as const };
    if (b.source === 'mcp' && seen.optionsDigest !== optionsDigest(b)) {
      return { ok: false as const, status: 409 as const, reason: 'options changed' as const };
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
        `INSERT INTO rulings (zone_id, briefing_id, choice, note, created_at, choice_label,
           choice_effect) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.zoneId, id, optionId, note, at, option.label, option.effect);
    return { ok: true as const, rulingId: Number(r.lastInsertRowid) };
  })();
}

/**
 * Dismisses the zone's open briefings among `ids` (the ones Command was shown), each as one
 * dismissal: no ruling is recorded, so no effect applies and nothing is written to the forge.
 * Returns the ids dismissed; another zone's briefing, or one no longer open, is left alone.
 */
export function dismissZoneBriefings(
  db: Db,
  zoneId: string,
  ids: readonly number[],
  now: Date,
): number[] {
  const dismiss = db.prepare(
    `UPDATE briefings SET state = 'dismissed', updated_at = ?
       WHERE id = ? AND zone_id = ? AND state = 'open'`,
  );
  return db.transaction(() =>
    [...new Set(ids)].filter((id) => dismiss.run(now.toISOString(), id, zoneId).changes === 1),
  )();
}

/** Whether every one of `ids` names a briefing of `zoneId` (and there is at least one). */
export function allBriefingsOfZone(db: Db, zoneId: string, ids: readonly number[]): boolean {
  if (ids.length === 0) return false;
  const of = db.prepare(`SELECT zone_id AS zoneId FROM briefings WHERE id = ?`);
  return ids.every((id) => (of.get(id) as { zoneId: string } | undefined)?.zoneId === zoneId);
}

/** listRulings' limit for every ruling: SQLite reads a negative LIMIT as none. */
export const ALL_RULINGS = -1;

export function listRulings(db: Db, zoneId: string, limit = 50): Ruling[] {
  const rows = db
    .prepare(
      `SELECT ${RULING_COLS} FROM rulings r JOIN briefings b ON b.id = r.briefing_id
         WHERE r.zone_id = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(zoneId, limit) as (Omit<Ruling, 'effect' | 'label'> & {
    optionsJson: string;
    choiceLabel: string | null;
    choiceEffect: Effect | null;
  })[];
  return rows.map(({ optionsJson, choiceLabel, choiceEffect, ...r }) => {
    // Rulings from before v14 recorded no snapshot: fall back to the briefing's options.
    const current = (JSON.parse(optionsJson) as BriefingOption[]).find((o) => o.id === r.choice);
    return {
      ...r,
      effect: choiceEffect ?? current?.effect ?? null,
      label: choiceLabel ?? current?.label ?? null,
    };
  });
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

/** What an `objective_done` briefing is about: `objective:<goal key>`. */
export const OBJECTIVE_PREFIX = 'objective:';

/**
 * Applies one effect to the briefing's subject. Idempotent: an effect whose subject has moved on
 * does nothing. Returns false when it could not run yet (try again next pass); throws on error.
 * `ruling` is the ruling applying it and its briefing's source: `advance_objective` and
 * `open_goal_change` apply only through a ruling on a server briefing.
 */
export async function applyEffect(
  db: Db,
  deps: RulingDeps,
  zoneId: string,
  subject: string,
  effect: Effect,
  now: Date,
  ruling: { rulingId?: number; source?: BriefingSource } = {},
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
    case 'advance_objective': {
      // The key is the briefing's own subject: a late ruling marks only what it was raised for.
      const key = subject.startsWith(OBJECTIVE_PREFIX)
        ? subject.slice(OBJECTIVE_PREFIX.length)
        : '';
      if (!GOAL_KEY.test(key)) {
        throw new Error(`advance_objective needs an objective subject, got ${subject}`);
      }
      if (ruling.rulingId === undefined || ruling.source !== 'server') {
        throw new Error('advance_objective applies only through a ruling');
      }
      recordObjectiveDone(db, zoneId, key, ruling.rulingId, now);
      return true;
    }
    case 'open_goal_change': {
      // The change is the briefing's own subject: a ruling opens only what it was raised for.
      const id = idOf(subject, GOAL_CHANGE_PREFIX);
      if (id === null) {
        throw new Error(`open_goal_change needs a goal-change subject, got ${subject}`);
      }
      if (ruling.rulingId === undefined || ruling.source !== 'server') {
        throw new Error('open_goal_change applies only through a ruling');
      }
      const change = getGoalChange(db, id);
      if (!change || change.zoneId !== zoneId || change.source !== 'crew') {
        throw new Error('no such goal change from the crew');
      }
      // Opens the PR and nothing more: merging waits for the owner's confirmation in the browser.
      const opened = await openGoalChange(db, deps.forges(zoneId), deps.zone(zoneId), id, now);
      if (opened === 'retry') return false;
      if (opened === 'refused') {
        throw new Error(getGoalChange(db, id)?.error ?? 'goal change refused');
      }
      return true;
    }
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
/**
 * A Promote or Re-stage on an assistant's (MCP) staged issue applies with the crew off: the server
 * raised its briefing, the promotion is the same label write the crew's path makes, and a re-stage
 * (one forge read) earns a fresh Promote briefing for the edited body.
 */
function promotesWithoutCrew(db: Db, effect: Effect, subject: string): boolean {
  if (effect !== 'promote_issue' && effect !== 'restage_issue') return false;
  const id = idOf(subject, 'issue:');
  return id !== null && getCrewIssue(db, id)?.source === 'mcp';
}

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
      if (
        WAITS_FOR_CREW.has(option.effect) &&
        !deps.zone(zoneId).crew?.enabled &&
        !promotesWithoutCrew(db, option.effect, r.subject)
      )
        continue;
      const done =
        option.effect === 'allow_gate_change'
          ? await applyGateAllowance(db, deps, zoneId, r, option, now)
          : await applyEffect(db, deps, zoneId, r.subject, option.effect, now, {
              rulingId: r.id,
              source: r.source,
            });
      if (!done) continue;
      if (r.kind === 'goal_change' && r.source === 'server' && option.effect === 'none') {
        // Leave the goals as they are: the crew's proposal is closed, so nothing ever opens it.
        const id = idOf(r.subject, GOAL_CHANGE_PREFIX);
        if (id !== null) closeProposedGoalChange(db, zoneId, id, now);
      }
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
 * A dismissed briefing counts as answered the same way. An item with a crew retry recorded and not
 * yet applied is not briefed: the crew is retrying it (#396).
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
    `SELECT 1 FROM briefings b WHERE b.zone_id = ? AND b.subject = ?
       AND b.state IN ('ruled','dismissed')
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
    // The crew retries it on its own diagnosis (#396) once a pass applies it: not Command's yet.
    const crewRetry = getCrewRetry(db, item.id);
    if (crewRetry && crewRetry.appliedAt === null) continue;
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

/** A park reason the trooper gives when a gate went red (implement, heal and resolve). */
const GATE_FAILED = /^gate (.+) failed$/;

/**
 * A `gate <name> failed` park in plain words: `gateFailureWhy` of the red gate of that name in the
 * newest drop of the item whose stored result failed for that very reason, then the reason.
 * Undefined for any other park, or when no stored result matches (or parses): the why is then the
 * reason, as before. A pure function of stored rows, so every pass gives the same why.
 */
function gateFailureParkWhy(db: Db, item: WorkItem): string | undefined {
  const reason = item.reason ?? '';
  const gateName = GATE_FAILED.exec(reason)?.[1];
  if (gateName === undefined) return undefined;
  // json_valid first: json_extract throws on a result_json that does not parse.
  const row = db
    .prepare(
      `SELECT result_json AS resultJson FROM drops
       WHERE work_item_id = ?
         AND CASE WHEN json_valid(result_json)
           THEN json_extract(result_json, '$.status') = 'failed'
             AND json_extract(result_json, '$.reason') = ?
           ELSE 0 END
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(item.id, reason) as { resultJson: string } | undefined;
  if (!row) return undefined;
  const result = DropResultSchema.safeParse(JSON.parse(row.resultJson));
  if (!result.success) return undefined;
  const gate = result.data.gates.find(
    (g) => g.name === gateName && (g.timedOut || g.exitCode !== 0),
  );
  if (!gate) return undefined;
  return `${gateFailureWhy(gate)}\n\nPark reason: ${reason}`;
}

/** How long a parked briefing waits for its first diagnose drop before the rule form returns. */
export const DIAGNOSE_WAIT_MINUTES = 60;

/**
 * Whether the crew is still to diagnose a parked briefing, so the page shows that in place of the
 * rule form: open and undiagnosed, with the zone's crew able to run (enabled, kill switch off,
 * zone active), and either a diagnose drop for it active, or none run yet and the briefing raised
 * (or refreshed) less than `DIAGNOSE_WAIT_MINUTES` ago. The bound keeps a crew that never gets to
 * it (a closed usage gate) from hiding the question for good.
 */
export function diagnosePending(db: Db, zone: DropZoneConfig, b: Briefing, now: Date): boolean {
  if (b.kind !== 'parked' || b.state !== 'open' || b.diagnosis !== null) return false;
  if (!zone.crew?.enabled || isKilled(db)) return false;
  if (getZoneMode(db, zone.id, zone.mode) !== 'active') return false;
  const active = db
    .prepare(
      `SELECT 1 FROM drops WHERE drop_zone_id = ? AND role = 'diagnose'
         AND state IN (${ACTIVE_STATES_SQL})
         AND CASE WHEN json_valid(input_json)
           THEN json_extract(input_json, '$.work.briefingId') = ? ELSE 0 END LIMIT 1`,
    )
    .get(zone.id, b.id);
  if (active) return true;
  return (
    b.diagnoseAttempts === 0 &&
    now.getTime() - Date.parse(b.updatedAt) < DIAGNOSE_WAIT_MINUTES * 60_000
  );
}

/** The ids of `briefings` the crew is still to diagnose (`diagnosePending`), each by its zone. */
export function pendingDiagnoses(
  db: Db,
  zones: readonly DropZoneConfig[],
  briefings: readonly Briefing[],
  now: Date,
): Set<number> {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const pending = new Set<number>();
  for (const b of briefings) {
    const zone = byId.get(b.zoneId);
    if (zone && diagnosePending(db, zone, b, now)) pending.add(b.id);
  }
  return pending;
}

/** The most of the crew's diagnosis a parked-again briefing quotes. */
export const MAX_CREW_RETRY_DIAGNOSIS = 500;

/**
 * The parked-again why's opening (#396, #420): when the crew retried the item, its diagnosis (cut)
 * and what it told the next attempt; when it re-ran checks, which and its diagnosis; when the
 * forge refused that re-run, which checks and why. Agent-written, so redacted (the server's scrub
 * set and token shapes); the page escapes it.
 */
function crewRetriedWhy(db: Db, itemId: number): string | undefined {
  const r = getCrewRetry(db, itemId);
  if (r === undefined || r.appliedAt === null) return undefined;
  const secrets = [...serverScrubSet.values()];
  const checks = redact(r.checks.join(', '), secrets);
  if (r.kind === 'rerun' && r.outcome === 'skipped' && r.reason) {
    return `The crew tried to re-run ${checks}: ${redact(r.reason, secrets)}.`;
  }
  if (r.outcome !== 'retried') return undefined;
  // Redacted before it is cut, so a cut cannot leave part of a secret that no longer matches.
  const full = redact(r.diagnosis, secrets);
  const diagnosis =
    full.length > MAX_CREW_RETRY_DIAGNOSIS ? `${full.slice(0, MAX_CREW_RETRY_DIAGNOSIS)}…` : full;
  if (r.kind === 'rerun') {
    return `The crew already re-ran ${checks} and retried this once on ${r.appliedAt.slice(0, 10)}. Its diagnosis: ${diagnosis}.`;
  }
  return `The crew already retried this once on ${r.appliedAt.slice(0, 10)}. Its diagnosis: ${diagnosis}. It told the next attempt: ${redact(r.instruction, secrets)}`;
}

/** The parked briefing the server raises for `item` now. */
function parkBriefing(db: Db, zoneId: string, item: WorkItem): NewBriefing {
  const reason = item.reason ?? 'no reason recorded';
  const options: BriefingOption[] = [
    { id: 'retry', label: 'Retry', effect: 'retry_item' },
    { id: 'leave', label: 'Leave parked', effect: 'none' },
  ];
  let decision = `Issue #${item.issueNumber} is parked. Retry it?`;
  let why = gateFailureParkWhy(db, item) ?? reason;
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
  // A gate park keeps its own words: its decision is to read the diff, and its why is cut to fit.
  const crewRetried = park ? undefined : crewRetriedWhy(db, item.id);
  if (crewRetried !== undefined) {
    // A refused re-run did not retry the item: it is parked as it was.
    if (getCrewRetry(db, item.id)?.outcome === 'retried') {
      decision = `Issue #${item.issueNumber} parked again after the crew retried it once. Retry it?`;
    }
    why = `${crewRetried}\n\n${why}`;
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

/** What a briefing is about, resolved for a reader: an issue's number and title, linked. */
export type About = { text: string; url?: string };

/** An issue (or pull request: GitHub redirects) of the zone's repository. */
export const issueUrl = (repo: string, n: number): string =>
  `https://github.com/${repo}/issues/${n}`;

/**
 * A briefing's subject resolved: `issue:<crewIssueId>` and `item:<workItemId>` to `#<n> <title>`
 * linked to the zone's repository (a crew issue not filed yet by its key), `crew:<text>` to the
 * text, and anything else as it is.
 */
export function briefingAbout(
  db: Db,
  zone: Pick<DropZoneConfig, 'repo'> | undefined,
  b: Pick<Briefing, 'subject'>,
): About {
  const linked = (n: number, title: string): About => ({
    text: `#${n} ${title}`,
    ...(zone ? { url: issueUrl(zone.repo, n) } : {}),
  });
  const issueId = idOf(b.subject, 'issue:');
  if (issueId !== null) {
    const c = getCrewIssue(db, issueId);
    if (c)
      return c.number === null
        ? { text: `crew issue ${c.key} (not filed yet)` }
        : linked(c.number, c.title);
  }
  const itemId = idOf(b.subject, 'item:');
  if (itemId !== null) {
    const item = getWorkItem(db, itemId);
    if (item) return linked(item.issueNumber, item.title);
  }
  if (b.subject.startsWith('crew:')) return { text: b.subject.slice('crew:'.length) };
  return { text: b.subject };
}

/** The zone's filed crew issues by key: a key named in a briefing gets its `#<number>`. */
export function crewKeyNumbers(db: Db, zoneId: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const c of listCrewIssues(db, zoneId)) if (c.number !== null) keys.set(c.key, c.number);
  return keys;
}

/** The line a `refute_exhausted` briefing ends with: written here, never by a model. */
export const REFUTE_RECOMMENDATION =
  "Promote if the last review's findings were only wording; reject if it found a design problem.";
/** The most of one finding a briefing quotes; the drop page has the full text. */
export const MAX_FINDING = 400;

type RefuteVerdict = { decision?: unknown; findings?: unknown };

const minuteUtc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const quote = (finding: string): string => {
  const flat = finding.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_FINDING ? flat : `${flat.slice(0, MAX_FINDING - 1)}…`;
};

/** How a crew issue is named in a briefing's text. */
const crewIssueName = (c: Pick<CrewIssue, 'number' | 'key' | 'title'>): string =>
  c.number === null
    ? `Crew issue ${c.key} (not filed yet), ${c.title},`
    : `#${c.number} ${c.title}`;

/** One stored refute verdict on a crew issue: its drop, when it finished, its decision and findings. */
export type RefuteVerdictLine = { id: string; at: string; decision: string; findings: string[] };

/**
 * The stored verdicts of the issue's current refute attempts, oldest first: the latest
 * `refuteCount` refute drops that returned a decision. A drop that died without one is not a
 * verdict.
 */
export function refuteVerdicts(db: Db, issue: CrewIssue): RefuteVerdictLine[] {
  const rows = db
    .prepare(
      `SELECT id, created_at AS createdAt, finished_at AS finishedAt, result_json AS resultJson
         FROM drops WHERE drop_zone_id = ? AND role = 'refute'
           AND json_extract(input_json, '$.work.crewIssueId') = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(issue.zoneId, issue.id, Math.max(issue.refuteCount, 1)) as {
    id: string;
    createdAt: string;
    finishedAt: string | null;
    resultJson: string | null;
  }[];
  return rows.reverse().flatMap((r) => {
    let crew: RefuteVerdict | undefined;
    try {
      crew = (JSON.parse(r.resultJson ?? 'null') as { crew?: RefuteVerdict } | null)?.crew;
    } catch {
      crew = undefined;
    }
    if (!crew || typeof crew.decision !== 'string') return [];
    const findings = Array.isArray(crew.findings)
      ? crew.findings.filter((f): f is string => typeof f === 'string')
      : [];
    return [{ id: r.id, at: r.finishedAt ?? r.createdAt, decision: crew.decision, findings }];
  });
}

/** The most of an arbiter's reasons a briefing quotes; the drop page has the full text. */
export const MAX_ARBITER_QUOTE = 1500;

const RULED: Record<string, string> = {
  A: 'A (promote it as it reads)',
  B: 'B (the findings stand; reject it)',
  insufficient_evidence: 'that the evidence is insufficient',
};

/**
 * What the arbiter said about the issue's current text, when its ruling is settled: the ruling and
 * its reasons, or why it could not rule. Empty when there is no settled arbitration for this text.
 */
function arbiterPart(db: Db, issue: CrewIssue): string {
  if (issue.bodySha === null) return '';
  const a = getArbitration(db, issueArbitrationSubject(issue.id), issue.bodySha);
  if (!a || a.state === 'pending') return '';
  const link = `full text: /drops/${a.dropId}`;
  if (a.state !== 'ruled' || a.ruling === null) {
    return `The arbiter could not rule: ${a.reason ?? 'no reason recorded'}. ${link}`;
  }
  const who = a.reason === 'did not run on Fable' ? 'The arbiter' : 'A Fable arbiter';
  const acted =
    a.acted || a.ruling === 'insufficient_evidence'
      ? ''
      : ` It was not acted on: ${a.reason ?? 'no reason recorded'}.`;
  return `${who} ruled ${RULED[a.ruling] ?? a.ruling}: ${quoteUpTo(a.because ?? '', MAX_ARBITER_QUOTE)}${acted} ${link}`;
}

const quoteUpTo = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * A `refute_exhausted` briefing's why, from the stored refute drops of the issue's current attempts:
 * how often it was reviewed, then each review's date and findings (each cut to MAX_FINDING, with
 * the drop page for the full text), then what the arbiter ruled on this text, if it ruled, then
 * REFUTE_RECOMMENDATION.
 */
export function refuteExhaustedWhy(db: Db, issue: CrewIssue): string {
  const reviews = refuteVerdicts(db, issue);
  const name = crewIssueName(issue);
  const k = reviews.length;
  const times = k === 1 ? 'once' : `${k} times`;
  const head =
    k === 0
      ? `${name} was never reviewed: its ${issue.refuteCount} refute attempts ended without a verdict.`
      : reviews.every((r) => r.decision === 'revise')
        ? `${name} was reviewed ${times}. Each review asked for changes, and the last revision hasn't been reviewed.`
        : `${name} was reviewed ${times}, and its current text hasn't been reviewed: the refute attempts are used up.`;
  const lines = [head];
  reviews.forEach((r, i) => {
    lines.push('', `Review ${i + 1} (${minuteUtc(r.at)}), asked to ${r.decision}:`);
    if (r.findings.length === 0) lines.push('  (no findings)');
    r.findings.forEach((f, j) => {
      lines.push(`  ${j + 1}. ${quote(f)}`);
    });
    lines.push(`  full text: /drops/${r.id}`);
  });
  const arbiter = arbiterPart(db, issue);
  const tail = `${arbiter ? `\n\n${arbiter}` : ''}\n\n${REFUTE_RECOMMENDATION}`;
  let body = lines.join('\n');
  if (body.length + tail.length > MAX_BRIEFING_WHY) {
    const cut = '\n… (cut: the drop pages have every finding)';
    body = body.slice(0, MAX_BRIEFING_WHY - tail.length - cut.length) + cut;
  }
  return body + tail;
}

/** What the page and `ctl briefings` show beside the briefings: each one's About, each zone's keys. */
export function briefingContext(
  db: Db,
  zones: readonly Pick<DropZoneConfig, 'id' | 'repo'>[],
  briefings: readonly Briefing[],
): { about: Map<number, About>; crewKeys: Map<string, Map<string, number>> } {
  const byId = new Map(zones.map((z) => [z.id, z]));
  return {
    about: new Map(briefings.map((b) => [b.id, briefingAbout(db, byId.get(b.zoneId), b)])),
    crewKeys: new Map(zones.map((z) => [z.id, crewKeyNumbers(db, z.id)])),
  };
}
