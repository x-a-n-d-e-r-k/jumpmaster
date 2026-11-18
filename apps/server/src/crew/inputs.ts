import type { CrewRole } from '@jumpmaster/protocol';
import { refuteVerdicts } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getPullRequest, getWorkItem } from '../db/repo.js';
import type { Feedback } from '../flow/decide.js';
import type { ZonePass } from '../flow/snapshot.js';
import { getGoals, objectivesDone, zoneObjective } from '../goals.js';
import { type ForgePair, unsanitizeForgeText } from '../outbox.js';
import { crewTemplate, fence, gatherAuthorReports, neutralise } from '../payloads.js';
import { isCrewFiled } from '../sync.js';
import { crewIssueSlots } from './actions.js';
import { getCrewIssue, getTriageRequest, listCrewIssues } from './store.js';

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
  // Forge and crew text (data) loses the outbox's mention-breaking joiners first.
  const sections = raw.map((s) => ({
    ...s,
    text: neutralise(s.kind === 'data' ? unsanitizeForgeText(s.text) : s.text),
  }));
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

/**
 * The goal file as read, with each objective done only by Command's ruling listed after it as
 * `<title> (done by ruling <id>)`: the file itself is never written.
 */
function goalsSection(db: Db, zone: DropZoneConfig): Section {
  const row = getGoals(db, zone.id);
  if (!row) {
    const text = `${zone.crew.goalPath} has not been read yet.`;
    return { title: zone.crew.goalPath, name: 'goals', kind: 'trusted', text };
  }
  if (!row.parse.ok) {
    const text = `${zone.crew.goalPath} could not be used: ${row.parse.error}`;
    return { title: zone.crew.goalPath, name: 'goals', kind: 'trusted', text };
  }
  const ruled = objectivesDone(db, zone.id);
  const byRuling = row.parse.objectives.flatMap((o) => {
    const id = ruled.get(o.key);
    return o.done || id === undefined ? [] : [`- ${o.title} (done by ruling ${id})`];
  });
  const text = [
    row.raw ?? '',
    ...(byRuling.length === 0
      ? []
      : ['', 'Objectives Command ruled done (not yet marked in the file):', ...byRuling]),
  ].join('\n');
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

type OpenBriefingLine = { id: number; subject: string; decision: string; optionsJson: string };

/** The zone's open briefings raised by the crew, oldest first. */
function openCrewBriefings(db: Db, zoneId: string): OpenBriefingLine[] {
  return db
    .prepare(
      `SELECT id, subject, decision, options_json AS optionsJson FROM briefings
       WHERE zone_id = ? AND state = 'open' AND source = 'crew' ORDER BY id`,
    )
    .all(zoneId) as OpenBriefingLine[];
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
  const current = zoneObjective(db, zone.id);
  const ruled = rulings(db, zone.id);
  const openBriefings = openCrewBriefings(db, zone.id);

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
      title: 'Open briefings',
      name: 'open-briefings',
      kind: 'trusted',
      text:
        openBriefings.length === 0
          ? 'No open briefings.'
          : openBriefings
              .map((b) => {
                const options = JSON.parse(b.optionsJson) as { label: string }[];
                return `Briefing ${b.id} (${b.subject}): ${b.decision}\nOptions: ${options.map((o) => o.label).join('; ')}`;
              })
              .join('\n\n'),
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

/** The two positions an arbiter weighs on a crew issue whose refutes ran out: written here. */
export const ISSUE_POSITIONS = [
  'A: the issue as it reads now is complete, unambiguous and safe to implement; promote it.',
  "B: the reviewers' findings stand; it should not be implemented as written; reject it.",
].join('\n');

/**
 * The arbitrate input for a crew issue that ran out of refutes: the goals, the protected paths and
 * the two positions as instructions, the crew issue as data, and every stored refute verdict on it,
 * oldest first, as untrusted data.
 */
export function arbitrateIssueInput(
  db: Db,
  zone: DropZoneConfig,
  work: { crewIssueId: number },
  dropId: string,
): string {
  const issue = getCrewIssue(db, work.crewIssueId);
  if (!issue) throw new Error(`unknown crew issue ${work.crewIssueId}`);
  const reviews = refuteVerdicts(db, issue);
  return assemble('arbitrate', dropId, [
    goalsSection(db, zone),
    {
      title: 'Protected paths',
      name: 'protected-paths',
      kind: 'trusted',
      text: zone.protectedPaths.map((p) => `- ${p}`).join('\n') || '(none)',
    },
    { title: 'Positions', name: 'positions', kind: 'trusted', text: ISSUE_POSITIONS },
    {
      title: 'Crew issue',
      name: 'crew-issue',
      kind: 'data',
      text: `Objective: ${issue.objective}\nTitle: ${issue.title}\n\n${issue.body}`,
    },
    {
      title: 'Refute reviews, oldest first',
      name: 'refute-reviews',
      kind: 'untrusted',
      text:
        reviews
          .map((r, i) =>
            [
              `Review ${i + 1} (${r.at}), asked to ${r.decision}:`,
              ...(r.findings.length === 0 ? ['(no findings)'] : r.findings.map((f) => `- ${f}`)),
            ].join('\n'),
          )
          .join('\n\n') || 'No reviews.',
    },
  ]);
}

/**
 * The triage input: GOAL.md, the current objective, the protected paths and Command's rulings on
 * this request's briefing as instructions; the ruled briefing's text, the free slots and the
 * issue's title and body as data. The issue is fenced like the lead's open issues, so its text can
 * never close the fence or pass for instructions.
 */
export function triageInput(
  db: Db,
  zone: DropZoneConfig,
  requestId: number,
  dropId: string,
): string {
  const req = getTriageRequest(db, requestId);
  if (!req || req.zoneId !== zone.id) throw new Error(`unknown triage request ${requestId}`);
  const current = zoneObjective(db, zone.id);
  const ruled =
    req.briefingId === null
      ? []
      : (db
          .prepare(
            `SELECT r.choice, r.note, r.created_at AS createdAt, b.decision,
               b.options_json AS optionsJson
             FROM rulings r JOIN briefings b ON b.id = r.briefing_id
             WHERE r.briefing_id = ? AND r.zone_id = ? ORDER BY r.id`,
          )
          .all(req.briefingId, zone.id) as {
          choice: string;
          note: string;
          createdAt: string;
          decision: string;
          optionsJson: string;
        }[]);
  return assemble('triage', dropId, [
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
      title: 'Protected paths',
      name: 'protected-paths',
      kind: 'trusted',
      text: zone.protectedPaths.map((p) => `- ${p}`).join('\n') || '(none)',
    },
    ...(req.gateReasons && req.gateReasons.length > 0
      ? [
          {
            // Server-written: the format's fixed reasons and the zone's own globs, never issue text.
            title: 'Why this issue is in triage',
            name: 'gate-reasons',
            kind: 'trusted' as const,
            text: req.gateReasons.map((r) => `- ${r}`).join('\n'),
          },
        ]
      : []),
    {
      title: "Command's rulings on this issue",
      name: 'rulings',
      kind: 'trusted',
      text:
        ruled.length === 0
          ? 'No rulings yet.'
          : ruled
              .map(
                (r) =>
                  `Ruling on briefing ${req.briefingId}: option ${r.choice}${r.note ? `; note: ${r.note}` : ''} (${r.createdAt})`,
              )
              .join('\n'),
    },
    {
      title: 'Ruled briefing',
      name: 'ruled-briefing',
      kind: 'data',
      text:
        ruled.length === 0
          ? 'None.'
          : ruled
              .map((r) => {
                const options = JSON.parse(r.optionsJson) as { id: string; label: string }[];
                const label = options.find((o) => o.id === r.choice)?.label ?? r.choice;
                return `Briefing ${req.briefingId}: ${r.decision}\nChosen: ${label}`;
              })
              .join('\n\n'),
    },
    {
      title: 'Crew issue slots',
      name: 'slots',
      kind: 'data',
      text: `Free slots: ${crewIssueSlots(db, zone)} (file at most this many children).`,
    },
    {
      title: 'Issue',
      name: 'issue',
      kind: 'data',
      text: `#${req.issueNumber}: ${req.title}\n\n${req.body.trim()}`,
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
      text: verdictsText(db, itemId),
    },
  ]);
}

/** The item's latest review verdicts, newest first, with their findings: as diagnose reads them. */
function verdictsText(db: Db, itemId: number): string {
  const verdicts = db
    .prepare(
      `SELECT head_sha AS headSha, decision, summary, findings_json AS findingsJson FROM verdicts
       WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5`,
    )
    .all(itemId) as VerdictLine[];
  return (
    verdicts
      .map((v) => {
        const findings = JSON.parse(v.findingsJson) as { severity: string; detail: string }[];
        return [
          `Head ${v.headSha}: ${v.decision}. ${v.summary}`,
          ...findings.map((f) => `- ${f.severity}: ${f.detail}`),
        ].join('\n');
      })
      .join('\n\n') || 'No verdicts.'
  );
}

/** The two positions an arbiter weighs on a review disagreement: written here. */
export const ITEM_POSITIONS = [
  'A: the reviewer is right: the change does not yet meet the issue.',
  'B: the author is right: the change meets the issue, and the remaining findings are not defects.',
].join('\n');

/** The feedback of the item's newest heal drop, as it was stored at enqueue, if any. */
export function lastHealFeedback(db: Db, itemId: number): Feedback | null {
  const row = db
    .prepare(
      `SELECT input_json AS inputJson FROM drops WHERE work_item_id = ? AND role = 'heal'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as { inputJson: string | null } | undefined;
  try {
    const f = (JSON.parse(row?.inputJson ?? 'null') as { feedback?: Feedback } | null)?.feedback;
    return f && typeof f.source === 'string' && typeof f.text === 'string' ? f : null;
  } catch {
    return null;
  }
}

/**
 * The arbitrate input for a review disagreement on a parked item: the goals and the two positions
 * as instructions, the issue and the PR as data, and the verdicts, the author's reports and the
 * last heal's feedback, all agent-written, as untrusted data.
 */
export function arbitrateItemInput(
  db: Db,
  zone: DropZoneConfig,
  work: { itemId: number; headSha: string },
  dropId: string,
): string {
  const item = getWorkItem(db, work.itemId);
  if (!item || item.dropZoneId !== zone.id) throw new Error(`unknown work item ${work.itemId}`);
  const pr = getPullRequest(db, work.itemId);
  const { reports } = gatherAuthorReports(db, work.itemId);
  const feedback = lastHealFeedback(db, work.itemId);
  return assemble('arbitrate', dropId, [
    goalsSection(db, zone),
    { title: 'Positions', name: 'positions', kind: 'trusted', text: ITEM_POSITIONS },
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
      text: pr ? `#${pr.number} at head ${work.headSha}` : 'No pull request.',
    },
    {
      title: 'Review verdicts on this item, newest first',
      name: 'verdicts',
      kind: 'untrusted',
      text: verdictsText(db, work.itemId),
    },
    {
      title: 'Author reports',
      name: 'author-reports',
      kind: 'untrusted',
      text:
        reports
          .map((r) => `Report for ${r.head.slice(0, 7)} (${r.role}):\n${r.summary}`)
          .join('\n\n') || 'No author report was recorded.',
    },
    {
      title: 'Last heal feedback',
      name: 'heal-feedback',
      kind: 'untrusted',
      text: feedback ? `From ${feedback.source}:\n${feedback.text}` : 'No heal feedback.',
    },
  ]);
}
