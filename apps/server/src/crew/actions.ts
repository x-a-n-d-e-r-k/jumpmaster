import type { CrewLeadOutput } from '@jumpmaster/protocol';
import { raiseBriefing } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getZoneMode, isKilled } from '../db/repo.js';
import { getGoals } from '../goals.js';
import { type CrewIssueState, insertCrewIssue, normTitle } from './store.js';

/** Lower case, punctuation and repeated whitespace collapsed: how two titles are compared. */
export const normaliseTitle = normTitle;

/** Where a crew action came from: a crew drop's result, or (later) a zone-scoped MCP token. */
export type CrewSource = { kind: 'drop'; dropId: string } | { kind: 'mcp'; tokenId: number };

export type CrewActionInput = Partial<Pick<CrewLeadOutput, 'fileIssues' | 'briefings'>>;

export type ApplyReport = { filed: number[]; briefings: number[]; refused: string[] };

/** Crew issues that hold a slot: not yet promoted, and not rejected or failed. */
const OPEN_STATES: CrewIssueState[] = ['filing', 'staged', 'promote_held', 'promoting', 'revising'];

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
 * The agent-ready format (§8.3). An empty list means valid; otherwise each entry is a short reason
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
): ApplyReport {
  const issues = input.fileIssues ?? [];
  const briefs = input.briefings ?? [];
  const report: ApplyReport = { filed: [], briefings: [], refused: [] };
  return db.transaction(() => {
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
      return report;
    }

    const goals = getGoals(db, zone.id)?.parse;
    const ladder = new Set(goals?.ok ? goals.objectives.map((o) => o.key) : []);
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

    for (const b of briefs) {
      report.briefings.push(
        raiseBriefing(
          db,
          {
            zoneId: zone.id,
            kind: 'crew',
            // Prefixed so a crew subject can never update a server briefing (item:, issue:).
            subject: `crew:${b.subject}`,
            decision: b.decision,
            why: b.why,
            options: b.options.map((label, n) => ({ id: `o${n + 1}`, label, effect: 'none' })),
            recommendation: b.recommendation,
            onHold: b.onHold,
            source: 'crew',
            sourceRef: sourceRefOf(source),
          },
          now,
        ),
      );
    }
    return report;
  })();
}
