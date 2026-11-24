import { type CrewLeadOutput, protectedPathMatches } from '@jumpmaster/protocol';
import { OBJECTIVE_PREFIX, raiseBriefing } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode, isKilled } from '../db/repo.js';
import { GOAL_CHANGE_PREFIX, proposeGoalChange } from '../goal-change.js';
import { getGoals, zoneObjective } from '../goals.js';
import { type CrewIssueState, insertCrewIssue, normTitle } from './store.js';

/** Lower case, punctuation and repeated whitespace collapsed: how two titles are compared. */
export const normaliseTitle = normTitle;

/** Where a crew action came from: a crew drop's result, or (later) a zone-scoped MCP token. */
export type CrewSource = { kind: 'drop'; dropId: string } | { kind: 'mcp'; tokenId: number };

export type CrewActionInput = Partial<
  Pick<CrewLeadOutput, 'fileIssues' | 'briefings' | 'objectiveDone' | 'goalChange'>
>;

export type ApplyReport = { filed: number[]; briefings: number[]; refused: string[] };

/**
 * How a triage drop files through the same path as the lead: `objective` is the one objective
 * (`triage:#N`) its issues may carry besides the ladder's, `allOrNothing` files no issue at all
 * when any is refused, and `ownBriefing` raises a drop's briefing under `crew:<subject>` as given
 * (the triage request's own, already scoped by issue number) instead of under the current
 * objective with one open per objective.
 */
export type ApplyOptions = { objective?: string; allOrNothing?: boolean; ownBriefing?: boolean };

/** Thrown inside the transaction to roll back an all-or-nothing batch with a refusal. */
class Refused extends Error {}

/** Crew issues that hold a slot: not yet promoted, and not rejected or failed. */
export const OPEN_STATES: readonly CrewIssueState[] = [
  'filing',
  'staged',
  'promote_held',
  'promoting',
  'revising',
];

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const UNCHECKED = /^\s*[-*+]\s+\[ \]\s+\S/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** The lines under each `##`-level heading, keyed by lower-cased heading text. */
function sectionLines(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    const h = HEADING.exec(line);
    if (h) {
      current = [];
      out.set((h[1] ?? '').toLowerCase(), current);
      continue;
    }
    current?.push(line);
  }
  return out;
}

/**
 * The issue has a `## Security-touching checklist` section, matched like `validateIssueSpec`'s
 * sections: any heading level, any case. A heading inside a fence counts too (errs toward Fable).
 */
export const isSecurityTouching = (body: string): boolean =>
  sectionLines(body).has('security-touching checklist');

/**
 * The drop-ready format (§8.3). An empty list means valid; otherwise each entry is a short reason
 * that never echoes the issue's text.
 */
export function validateIssueSpec(title: string, body: string): string[] {
  const reasons: string[] = [];
  const sections = sectionLines(body);
  const criteria = sections.get('acceptance criteria') ?? [];
  if (!criteria.some((l) => UNCHECKED.test(l)))
    reasons.push('no "## Acceptance criteria" checklist');
  const tests = [...(sections.get('tests') ?? []), ...(sections.get('required tests') ?? [])];
  if (!tests.some((l) => LIST_ITEM.test(l)))
    reasons.push('no "## Tests" or "## Required tests" list');
  if (/[\r\n]/.test(title)) reasons.push('the title has a line break');
  if (title.includes('jm:op:') || body.includes('jm:op:')) reasons.push('contains "jm:op:"');
  return reasons;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_LEVEL = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** An inline code span with no whitespace inside: how an issue names a path. */
const CODE_SPAN = /`([^`\s]+)`/g;
/** A line that says its paths stay as they are. */
const KEEPS = /protected|unchanged|not changed/i;

/**
 * The protected globs an issue body asks to change, sorted and de-duplicated: a path in an inline
 * code span (outside fenced blocks and any `## Out of scope` section, on a line that does not say
 * `protected`, `unchanged` or `not changed`) that matches a glob through `protectedPathMatches`,
 * the push check's matcher. A miss only falls back to the push check refusing the branch.
 */
export function protectedPathsNamed(body: string, protectedPaths: readonly string[]): string[] {
  const found = new Set<string>();
  let fence: string | null = null;
  let outOfScope: number | null = null;
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (
        f?.[1] &&
        f[1][0] === fence[0] &&
        f[1].length >= fence.length &&
        !line.slice(f[0].length).trim()
      )
        fence = null;
      continue;
    }
    if (f?.[1]) {
      fence = f[1];
      continue;
    }
    const h = HEADING_LEVEL.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      if (outOfScope !== null && level <= outOfScope) outOfScope = null;
      if ((h[2] ?? '').toLowerCase() === 'out of scope') outOfScope = level;
    }
    if (outOfScope !== null || KEEPS.test(line)) continue;
    for (const m of line.matchAll(CODE_SPAN)) {
      const path = (m[1] ?? '').replace(/^(?:\.\/)+/, '');
      if (!path) continue;
      for (const glob of protectedPaths) if (protectedPathMatches(path, glob)) found.add(glob);
    }
  }
  return [...found].sort();
}

/**
 * Why an issue is held back from an implementer: its drop-ready format reasons, then each
 * protected glob it names. Empty means it may go to a work item.
 */
export function issueGateReasons(
  title: string,
  body: string,
  protectedPaths: readonly string[],
): string[] {
  return [
    ...validateIssueSpec(title, body),
    ...protectedPathsNamed(body, protectedPaths).map(
      (g) => `protected path ${g} named in the issue`,
    ),
  ];
}

/** Free crew-issue slots: `maxStaged` less the open crew issues, floored at 0. */
export function crewIssueSlots(db: Db, zone: DropZoneConfig): number {
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM crew_issues
         WHERE zone_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(', ')})`,
    )
    .get(zone.id, ...OPEN_STATES) as { n: number };
  return Math.max(0, zone.crew.maxStaged - n);
}

const sourceRefOf = (s: CrewSource): string => (s.kind === 'drop' ? s.dropId : String(s.tokenId));

/**
 * The crew's report that the current objective is finished, raised as a server briefing whose
 * "Mark it done" ruling records it done (`advance_objective`). Only a crew drop may report it, and
 * only for the zone's current objective; a second report while it is open updates the briefing.
 */
function objectiveDoneBriefing(
  db: Db,
  zone: DropZoneConfig,
  done: NonNullable<CrewActionInput['objectiveDone']>,
  source: CrewSource,
  now: Date,
): number | { refused: string } {
  if (source.kind !== 'drop') return { refused: 'an MCP source cannot report it' };
  const current = zoneObjective(db, zone.id);
  if (!current || current.key !== done.key) return { refused: 'not the current objective' };
  return raiseBriefing(
    db,
    {
      zoneId: zone.id,
      kind: 'objective_done',
      subject: `${OBJECTIVE_PREFIX}${current.key}`,
      decision: `Mark objective "${current.title}" done?`,
      why: done.why,
      options: [
        { id: 'done', label: 'Mark it done', effect: 'advance_objective' },
        { id: 'keep', label: 'Keep it open', effect: 'none' },
      ],
      onHold: 'All crew filing for the next objective',
      source: 'server',
      sourceRef: sourceRefOf(source),
    },
    now,
  );
}

/**
 * The crew lead's proposed goal file, recorded as a proposed goal change and raised as a server
 * briefing whose "Open the PR" ruling opens it (`open_goal_change`). Only a crew drop may propose
 * through here (the chat has its own tool), one at a time: another proposal is refused while a
 * crew goal change waits for its ruling. Merging still needs the owner's browser confirmation.
 */
export function goalChangeBriefing(
  db: Db,
  zone: DropZoneConfig,
  change: NonNullable<CrewActionInput['goalChange']>,
  source: CrewSource,
  now: Date,
): number | { refused: string } {
  if (source.kind !== 'drop') return { refused: 'an MCP source cannot propose it' };
  const waiting = db
    .prepare(
      `SELECT g.id FROM goal_changes g JOIN briefings b
         ON b.zone_id = g.zone_id AND b.subject = ? || g.id AND b.state = 'open'
       WHERE g.zone_id = ? AND g.source = 'crew' AND g.state = 'proposed' ORDER BY g.id LIMIT 1`,
    )
    .get(GOAL_CHANGE_PREFIX, zone.id) as { id: number } | undefined;
  if (waiting) return { refused: `goal change ${waiting.id} is waiting for a ruling` };
  const proposed = proposeGoalChange(
    db,
    zone,
    { text: change.text, source: 'crew', sourceRef: source.dropId },
    now,
  );
  if (!proposed.ok) return { refused: proposed.error };
  const path = zone.crew.goalPath;
  return raiseBriefing(
    db,
    {
      zoneId: zone.id,
      kind: 'goal_change',
      subject: `${GOAL_CHANGE_PREFIX}${proposed.id}`,
      decision: `Open a pull request changing ${path} as the crew lead proposes?`,
      why: change.why,
      options: [
        { id: 'open', label: 'Open the PR', effect: 'open_goal_change' },
        { id: 'no', label: 'Leave the goals as they are', effect: 'none' },
      ],
      onHold: `Nothing: ${path} stays as it is until you confirm the PR in the browser`,
      source: 'server',
      sourceRef: source.dropId,
    },
    now,
  );
}

/**
 * Records the crew's proposed actions as intents, in one transaction that touches only the
 * database: forge writes happen later in `flushCrewOps`. Nothing is recorded unless the zone is
 * active with the kill switch off.
 */
export function applyCrewActions(
  db: Db,
  zone: DropZoneConfig,
  input: CrewActionInput,
  source: CrewSource,
  now: Date,
  opts: ApplyOptions = {},
): ApplyReport {
  const issues = input.fileIssues ?? [];
  const briefs = input.briefings ?? [];
  const done = input.objectiveDone;
  const goalChange = input.goalChange;
  const report: ApplyReport = { filed: [], briefings: [], refused: [] };
  const run = db.transaction((): ApplyReport => {
    const mode = getZoneMode(db, zone.id, zone.mode);
    const blocked = isKilled(db)
      ? 'kill switch is engaged'
      : mode !== 'active'
        ? `zone is ${mode}`
        : null;
    if (blocked) {
      for (const i of issues) report.refused.push(`${i.key}: ${blocked}`);
      briefs.forEach((_, n) => {
        report.refused.push(`briefing ${n + 1}: ${blocked}`);
      });
      if (done) report.refused.push(`objectiveDone ${done.key}: ${blocked}`);
      if (goalChange) report.refused.push(`goalChange: ${blocked}`);
      return report;
    }

    const goals = getGoals(db, zone.id)?.parse;
    const ladder = new Set(goals?.ok ? goals.objectives.map((o) => o.key) : []);
    if (opts.objective !== undefined) ladder.add(opts.objective);
    const keyUsed = db.prepare('SELECT 1 FROM crew_issues WHERE zone_id = ? AND key = ?');
    const titleUsed = db.prepare(
      `SELECT 1 FROM crew_issues WHERE zone_id = ? AND objective = ? AND title_norm = ?
         AND state NOT IN ('rejected', 'failed') LIMIT 1`,
    );
    const recentlyRejected = db.prepare(
      `SELECT 1 FROM crew_issues WHERE zone_id = ? AND objective = ? AND title_norm = ?
         AND state = 'rejected' AND updated_at > ? LIMIT 1`,
    );
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let slots = crewIssueSlots(db, zone);
    for (const i of issues) {
      const refuse = (why: string) => report.refused.push(`${i.key}: ${why}`);
      if (!ladder.has(i.objective)) {
        refuse(`objective "${i.objective.slice(0, 60)}" is not on the ladder`);
        continue;
      }
      if (keyUsed.get(zone.id, i.key)) {
        refuse('key already used');
        continue;
      }
      if (titleUsed.get(zone.id, i.objective, normaliseTitle(i.title))) {
        refuse('duplicate of an open crew issue');
        continue;
      }
      if (recentlyRejected.get(zone.id, i.objective, normaliseTitle(i.title), weekAgo)) {
        refuse('duplicate of a crew issue rejected in the last 7 days');
        continue;
      }
      const reasons = validateIssueSpec(i.title, i.body);
      if (reasons.length > 0) {
        refuse(reasons.join('; '));
        continue;
      }
      const named = protectedPathsNamed(i.body, zone.protectedPaths);
      if (named.length > 0) {
        refuse(named.map((g) => `names protected path ${g}`).join('; '));
        continue;
      }
      if (slots <= 0) {
        refuse('no free slot');
        continue;
      }
      slots--;
      report.filed.push(
        insertCrewIssue(db, {
          zoneId: zone.id,
          key: i.key,
          source: source.kind,
          sourceRef: sourceRefOf(source),
          objective: i.objective,
          title: i.title,
          body: i.body,
          priority: i.priority ?? null,
          createdAt: now.toISOString(),
        }),
      );
    }
    if (opts.allOrNothing && report.refused.length > 0) throw new Refused();

    // An MCP briefing is the assistant's, under its own `mcp:` prefix: it can never update a
    // crew-drop briefing (`crew:`) or a server one, and Command can tell it from the crew's.
    const mcp = source.kind === 'mcp';
    // A lead's briefing is scoped to the current objective, with one open per objective: a run
    // that sees the same stuck state may update it (same subject) but not ask again in new words.
    const perObjective = !mcp && !opts.ownBriefing;
    const objectiveKey = perObjective ? (zoneObjective(db, zone.id)?.key ?? 'none') : '';
    const scope = `crew:${objectiveKey}:`;
    const openForObjective = db.prepare(
      `SELECT id, subject FROM briefings WHERE zone_id = ? AND state = 'open'
         AND substr(subject, 1, ?) = ? ORDER BY id LIMIT 1`,
    );
    briefs.forEach((b, n) => {
      const subject = mcp ? `mcp:${b.subject}` : `${perObjective ? scope : 'crew:'}${b.subject}`;
      if (perObjective) {
        const open = openForObjective.get(zone.id, scope.length, scope) as
          | { id: number; subject: string }
          | undefined;
        if (open && open.subject !== subject) {
          report.refused.push(
            `briefing ${n + 1}: briefing ${open.id} is open for objective ${objectiveKey}`,
          );
          return;
        }
      }
      report.briefings.push(
        raiseBriefing(
          db,
          {
            zoneId: zone.id,
            kind: 'crew',
            // Prefixed so it can never update a server briefing (item:, issue:, credits:).
            subject,
            decision: b.decision,
            why: b.why,
            options: b.options.map((label, n) => ({ id: `o${n + 1}`, label, effect: 'none' })),
            recommendation: b.recommendation,
            onHold: b.onHold,
            source: mcp ? 'mcp' : 'crew',
            sourceRef: sourceRefOf(source),
          },
          now,
        ),
      );
    });
    if (done) {
      const id = objectiveDoneBriefing(db, zone, done, source, now);
      if (typeof id === 'number') report.briefings.push(id);
      else report.refused.push(`objectiveDone ${done.key}: ${id.refused}`);
    }
    if (goalChange) {
      const id = goalChangeBriefing(db, zone, goalChange, source, now);
      if (typeof id === 'number') report.briefings.push(id);
      else report.refused.push(`goalChange: ${id.refused}`);
    }
    return report;
  });
  try {
    return run();
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    // Rolled back: nothing filed, nothing briefed.
    return { filed: [], briefings: [], refused: report.refused };
  }
}
