import type { CrewRole } from '@jumpmaster/protocol';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getPullRequest, getWorkItem } from '../db/repo.js';
import type { ZonePass } from '../flow/snapshot.js';
import { currentObjective, getGoals } from '../goals.js';
import type { ForgePair } from '../outbox.js';
import { crewTemplate, fence, neutralise } from '../payloads.js';
import { isCrewFiled } from '../sync.js';
import { crewIssueSlots } from './actions.js';
import { getCrewIssue, listCrewIssues } from './store.js';

/** The most a crew prompt (template plus input) may weigh, in UTF-8 bytes. */
export const MAX_CREW_PROMPT_BYTES = 100_000;

/**
 * One block of crew input. `trusted` is Command's own text (GOAL.md, rulings, config); `data` is
 * forge or crew text; `untrusted` is agent-written text (verdicts, drop reasons).
 */
type Section = {
  title: string;
  name: string;
  kind: 'trusted' | 'data' | 'untrusted';
  text: string;
};

const LABEL = {
  trusted: '(trusted instructions)',
  data: '(data)',
  untrusted: '(data, untrusted)',
} as const;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a character. */
function cutUtf8(s: string, max: number): string {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= max) return s;
  let end = Math.max(0, max);
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString('utf8');
}

const renderSection = (dropId: string, s: Section): string =>
  `## ${s.title} ${LABEL[s.kind]}\n\n${fence(dropId, s.name, s.text)}`;

const NOTE_RESERVE = 600;
const CUT_MARK = '\n[cut to fit the prompt limit]';

/**
 * Renders the sections in order, cutting from the last one back until template plus input fit in
 * `MAX_CREW_PROMPT_BYTES`, and says what was cut. Section text is neutralised before it is measured.
 */
function assemble(role: CrewRole, dropId: string, raw: Section[]): string {
  const budget = MAX_CREW_PROMPT_BYTES - bytes(`${crewTemplate(role)}\n\n`);
  const sections = raw.map((s) => ({ ...s, text: neutralise(s.text) }));
  const render = (list: Section[]) => list.map((s) => renderSection(dropId, s)).join('\n\n');
  let out = render(sections);
  if (bytes(out) <= budget) return out;

  const target = budget - NOTE_RESERVE;
  const cut: string[] = [];
  const omitted: string[] = [];
  for (let i = sections.length - 1; i >= 0 && bytes(render(sections)) > target; i--) {
    const s = sections[i] as Section;
    const excess = bytes(render(sections)) - target;
    const keep = bytes(s.text) - excess - bytes(CUT_MARK);
    if (keep >= 200) {
      sections[i] = { ...s, text: `${cutUtf8(s.text, keep)}${CUT_MARK}` };
      cut.push(s.name);
    } else {
      sections.splice(i, 1);
      omitted.push(s.name);
    }
  }
  out = render(sections);
  const note = [
    `## Truncation note ${LABEL.trusted}`,
    '',
    `The input was over the ${MAX_CREW_PROMPT_BYTES}-byte prompt limit.`,
    ...(cut.length > 0 ? [`Cut short: ${cut.join(', ')}.`] : []),
    ...(omitted.length > 0 ? [`Left out: ${omitted.join(', ')}.`] : []),
  ].join('\n');
  return `${out}\n\n${note}`;
}

function goalsSection(db: Db, zone: DropZoneConfig): Section {
  const row = getGoals(db, zone.id);
  const text = !row
    ? `${zone.crew.goalPath} has not been read yet.`
    : row.parse.ok
      ? (row.raw ?? '')
      : `${zone.crew.goalPath} could not be used: ${row.parse.error}`;
  return { title: zone.crew.goalPath, name: 'goals', kind: 'trusted', text };
}

type RulingLine = {
  id: number;
  briefingId: number;
  choice: string;
  note: string;
  createdAt: string;
  decision: string;
  optionsJson: string;
};

/** Command's recent rulings, newest first. */
function rulings(db: Db, zoneId: string, limit = 20): RulingLine[] {
  return db
    .prepare(
      `SELECT r.id, r.briefing_id AS briefingId, r.choice, r.note, r.created_at AS createdAt,
         b.decision, b.options_json AS optionsJson
       FROM rulings r JOIN briefings b ON b.id = r.briefing_id
       WHERE r.zone_id = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(zoneId, limit) as RulingLine[];
}

/**
 * The lead's input: GOAL.md, the current objective and Command's rulings as instructions; the crew
 * issues, free slots and trusted open issues as data. Issues by untrusted authors (or whose trust
 * lookup failed) appear only as a count, crew-filed issues only from the database, and no comment
 * is ever read.
 */
export async function crewLeadInput(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  _pass: ZonePass,
  _now: Date,
  dropId: string,
): Promise<string> {
  const goals = getGoals(db, zone.id);
  const current = goals ? currentObjective(goals.parse) : null;
  const ruled = rulings(db, zone.id);

  const crewIssues = listCrewIssues(db, zone.id);
  const byObjective = new Map<string, string[]>();
  for (const c of crewIssues) {
    const line = `- [${c.state}] ${c.key}: ${c.title}${c.number !== null ? ` (#${c.number})` : ''}`;
    byObjective.set(c.objective, [...(byObjective.get(c.objective) ?? []), line]);
  }
  const crewText = [
    `Free slots: ${crewIssueSlots(db, zone)} (file at most this many issues).`,
    ...(crewIssues.length === 0
      ? ['', 'No crew issues yet.']
      : [...byObjective].flatMap(([objective, lines]) => [
          '',
          `Objective ${objective}:`,
          ...lines,
        ])),
  ].join('\n');

  const known = new Set(crewIssues.flatMap((c) => (c.number === null ? [] : [c.number])));
  // The staged label marks a crew issue whose number the database may not know yet.
  const open = (await forges.author.listOpenIssues()).filter(
    (i) =>
      !known.has(i.number) && !isCrewFiled(i, zone) && !i.labels.includes(zone.crew.stagedLabel),
  );
  const trust = new Map<string, boolean>();
  for (const author of new Set(open.map((i) => i.author))) {
    try {
      trust.set(author, await forges.author.isTrusted(author));
    } catch {
      trust.set(author, false); // a failed lookup counts as untrusted
    }
  }
  const shown = open.filter((i) => trust.get(i.author)).sort((a, b) => a.number - b.number);
  const hidden = open.length - shown.length;
  const issuesText = [
    hidden === 1
      ? '1 open issue by an untrusted author is not shown.'
      : `${hidden} open issues by untrusted authors are not shown.`,
    ...shown.map(
      (i) =>
        `\n#${i.number}: ${i.title}\nLabels: ${i.labels.join(', ') || '(none)'}\n\n${i.body.trim()}`,
    ),
  ].join('\n');

  return assemble('crew-lead', dropId, [
    goalsSection(db, zone),
    {
      title: 'Current objective',
      name: 'objective',
      kind: 'trusted',
      text: current
        ? `Key: ${current.key}\nTitle: ${current.title}\n\n${current.body}`
        : 'No objective is open.',
    },
    {
      title: "Command's rulings",
      name: 'rulings',
      kind: 'trusted',
      text:
        ruled.length === 0
          ? 'No rulings yet.'
          : ruled
              .map(
                (r) =>
                  `Ruling ${r.id} on briefing ${r.briefingId}: option ${r.choice}${r.note ? `; note: ${r.note}` : ''} (${r.createdAt})`,
              )
              .join('\n'),
    },
    {
      title: 'Ruled briefings',
      name: 'ruled-briefings',
      kind: 'data',
      text:
        ruled.length === 0
          ? 'None.'
          : ruled
              .map((r) => {
                const options = JSON.parse(r.optionsJson) as { id: string; label: string }[];
                const label = options.find((o) => o.id === r.choice)?.label ?? r.choice;
                return `Briefing ${r.briefingId}: ${r.decision}\nChosen: ${label}`;
              })
              .join('\n\n'),
    },
    { title: 'Crew issues', name: 'crew-issues', kind: 'data', text: crewText },
    { title: 'Open issues', name: 'open-issues', kind: 'data', text: issuesText },
  ]);
}

/** The refute input: the goals and protected paths as instructions, the crew issue as data. */
export function refuteInput(
  db: Db,
  zone: DropZoneConfig,
  crewIssueId: number,
  dropId: string,
): string {
  const issue = getCrewIssue(db, crewIssueId);
  if (!issue) throw new Error(`unknown crew issue ${crewIssueId}`);
  return assemble('refute', dropId, [
    goalsSection(db, zone),
    {
      title: 'Protected paths',
      name: 'protected-paths',
      kind: 'trusted',
      text: zone.protectedPaths.map((p) => `- ${p}`).join('\n') || '(none)',
    },
    {
      title: 'Crew issue',
      name: 'crew-issue',
      kind: 'data',
      text: `Objective: ${issue.objective}\nTitle: ${issue.title}\n\n${issue.body}`,
    },
  ]);
}

type DropLine = { role: string; state: string; createdAt: string; resultJson: string | null };
type VerdictLine = { headSha: string; decision: string; summary: string; findingsJson: string };

/**
 * The diagnose input: the issue as data, and everything an agent wrote (the park reason, drop
 * reasons, verdicts) fenced as untrusted data.
 */
export function diagnoseInput(
  db: Db,
  zone: DropZoneConfig,
  itemId: number,
  dropId: string,
): string {
  const item = getWorkItem(db, itemId);
  if (!item || item.dropZoneId !== zone.id) throw new Error(`unknown work item ${itemId}`);
  const pr = getPullRequest(db, itemId);
  const drops = db
    .prepare(
      `SELECT role, state, created_at AS createdAt, result_json AS resultJson FROM drops
       WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20`,
    )
    .all(itemId) as DropLine[];
  const verdicts = db
    .prepare(
      `SELECT head_sha AS headSha, decision, summary, findings_json AS findingsJson FROM verdicts
       WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5`,
    )
    .all(itemId) as VerdictLine[];
  const reasonOf = (d: DropLine): string => {
    try {
      const r = JSON.parse(d.resultJson ?? '{}') as { status?: unknown; reason?: unknown };
      return [r.status, r.reason].filter((x) => typeof x === 'string').join(': ');
    } catch {
      return '';
    }
  };
  return assemble('diagnose', dropId, [
    {
      title: 'Issue',
      name: 'issue',
      kind: 'data',
      text: `#${item.issueNumber}: ${item.title}\n\n${item.body}`,
    },
    {
      title: 'Pull request',
      name: 'pull-request',
      kind: 'data',
      text: pr
        ? `#${pr.number} (${pr.state}) on ${pr.headRef} at ${pr.headSha}`
        : 'No pull request.',
    },
    {
      title: 'Why it parked',
      name: 'park-reason',
      kind: 'untrusted',
      text: item.reason ?? 'No reason recorded.',
    },
    {
      title: 'Drops, newest first',
      name: 'drop-reasons',
      kind: 'untrusted',
      text:
        drops.map((d) => `- ${d.role} ${d.state} ${d.createdAt}: ${reasonOf(d)}`).join('\n') ||
        'No drops.',
    },
    {
      title: 'Review verdicts, newest first',
      name: 'verdicts',
      kind: 'untrusted',
      text:
        verdicts
          .map((v) => {
            const findings = JSON.parse(v.findingsJson) as { severity: string; detail: string }[];
            return [
              `Head ${v.headSha}: ${v.decision}. ${v.summary}`,
              ...findings.map((f) => `- ${f.severity}: ${f.detail}`),
            ].join('\n');
          })
          .join('\n\n') || 'No verdicts.',
    },
  ]);
}
