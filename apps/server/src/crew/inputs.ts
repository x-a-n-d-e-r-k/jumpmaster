import { type CrewRole, redact } from '@jumpmaster/protocol';
import { refuteVerdicts } from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { getPullRequest, getWorkItem } from '../db/repo.js';
import type { Feedback } from '../flow/decide.js';
import type { ZonePass } from '../flow/snapshot.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { failureText, newestFailure } from '../gate-output.js';
import { type GoalChange, listGoalChangesWithStanding } from '../goal-change.js';
import { getGoals, objectivesDone, zoneObjective } from '../goals.js';
import { type ForgePair, unsanitizeForgeText } from '../outbox.js';
import {
  ciAnnotationsOf,
  ciFailureLines,
  crewTemplate,
  fence,
  gatherAuthorReports,
  neutralise,
} from '../payloads.js';
import { isCrewFiled } from '../sync.js';
import { crewIssueSlots } from './actions.js';
import {
  type CrewIssue,
  commandRejection,
  getCrewIssue,
  getTriageRequest,
  issueArbitrationSubject,
  listCrewIssues,
} from './store.js';

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

/**
 * The zone's goal changes in flight (#645), one line each in the server's own words: ids, states
 * and PR numbers only, never the proposed text. A crew proposal is in flight only while it is in
 * front of Command (#754): its briefing open, or Command's "Open the PR" ruling waiting to apply.
 * One whose briefing was dismissed or withdrawn is left out: nothing will rule on it or open it.
 */
function goalChangesText(db: Db, zoneId: string): string {
  const pr = (c: GoalChange) => (c.prNumber === null ? '' : ` (pull request #${c.prNumber})`);
  const lines = listGoalChangesWithStanding(db, zoneId).flatMap((c): string[] => {
    switch (c.state) {
      case 'proposed':
        if (c.source !== 'crew') {
          return [`Goal change ${c.id}: proposed; its pull request opens at the next pass.`];
        }
        switch (c.standing) {
          case 'awaiting_ruling':
            return [
              `Goal change ${c.id}: proposed; waits for Command's ruling on its goal-change briefing.`,
            ];
          case 'opening':
            return [
              `Goal change ${c.id}: proposed; Command ruled to open it, and its pull request opens at a coming pass.`,
            ];
          default:
            return [];
        }
      case 'open':
        return [
          `Goal change ${c.id}${pr(c)}: open; waits for Command to approve and merge it in Jumpmaster. Work under the objectives it adds waits until it merges.`,
        ];
      case 'confirmed':
        return [
          `Goal change ${c.id}${pr(c)}: confirmed; Jumpmaster merges it once its checks pass.`,
        ];
      default:
        return [];
    }
  });
  return lines.length === 0 ? 'No goal changes in flight.' : lines.join('\n');
}

/** The zone's open briefings raised by the crew, oldest first. */
function openCrewBriefings(db: Db, zoneId: string): OpenBriefingLine[] {
  return db
    .prepare(
      `SELECT id, subject, decision, options_json AS optionsJson FROM briefings
       WHERE zone_id = ? AND state = 'open' AND source = 'crew' ORDER BY id`,
    )
    .all(zoneId) as OpenBriefingLine[];
}

/** How many rejected issues the lead's input explains, and how far back (#784). */
export const MAX_REJECTED_SHOWN = 5;
const REJECTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The most characters of one rejection's reason the lead sees, counted after redaction. */
export const MAX_REJECTION_REASON = 2000;

/**
 * Why a rejected crew issue was rejected, in the order the spec gives: Command's ruling, if it
 * rejected it (with its note, since it can't be replaced); then the latest ruled arbitration's
 * `because` and `instruction`, else the issue's latest refute findings.
 */
function rejectionReason(db: Db, issue: CrewIssue): string {
  const parts: string[] = [];
  const command = commandRejection(db, issue);
  if (command) parts.push(`Rejected by Command${command.note ? `; note: ${command.note}` : '.'}`);
  const arbitration = db
    .prepare(
      `SELECT because, instruction FROM arbitrations
         WHERE zone_id = ? AND subject = ? AND state = 'ruled'
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get(issue.zoneId, issueArbitrationSubject(issue.id)) as
    | { because: string | null; instruction: string | null }
    | undefined;
  if (arbitration) {
    parts.push(
      `The arbiter ruled: ${arbitration.because ?? '(no reason given)'}`,
      ...(arbitration.instruction ? [`Its instruction: ${arbitration.instruction}`] : []),
    );
  } else if (issue.findingsJson !== null) {
    let findings: string[] = [];
    try {
      const parsed = JSON.parse(issue.findingsJson) as unknown;
      if (Array.isArray(parsed)) findings = parsed.filter((f) => typeof f === 'string');
    } catch {
      findings = [];
    }
    parts.push(
      'The last review found:',
      ...(findings.length === 0 ? ['(no findings)'] : findings.map((f) => `- ${f}`)),
    );
  }
  return parts.length === 0 ? 'No reason was recorded.' : parts.join('\n');
}

/**
 * The zone's crew issues of the current objective rejected in the last 7 days, newest first, at
 * most `MAX_REJECTED_SHOWN`, each with its reason: redacted with `secrets` and the scrub set and
 * cut to `MAX_REJECTION_REASON` characters here, neutralised and fenced by `assemble`.
 */
function rejectedIssuesText(
  db: Db,
  zoneId: string,
  objective: string | null,
  now: Date,
  secrets: string[],
): string {
  if (objective === null) return 'No objective is open.';
  const since = new Date(now.getTime() - REJECTED_WINDOW_MS).toISOString();
  const rows = (
    db
      .prepare(
        `SELECT id FROM crew_issues WHERE zone_id = ? AND objective = ? AND state = 'rejected'
           AND updated_at > ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(zoneId, objective, since, MAX_REJECTED_SHOWN) as { id: number }[]
  ).flatMap((r) => getCrewIssue(db, r.id) ?? []);
  if (rows.length === 0)
    return 'No issue of the current objective was rejected in the last 7 days.';
  const scrub = [...secrets, ...serverScrubSet.values()];
  return rows
    .map((c) => {
      const reason = [...redact(rejectionReason(db, c), scrub)]
        .slice(0, MAX_REJECTION_REASON)
        .join('');
      const number = c.number !== null ? ` (#${c.number})` : '';
      return `- ${c.key}: ${c.title}${number}\n  Reason:\n${reason}`;
    })
    .join('\n\n');
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
  now: Date,
  dropId: string,
  secrets: string[] = [],
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
      title: 'Goal changes in flight',
      name: 'goal-changes',
      kind: 'trusted',
      text: goalChangesText(db, zone.id),
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
    {
      title: 'Rejected issues of the current objective',
      name: 'rejected-issues',
      kind: 'data',
      text: rejectedIssuesText(db, zone.id, current?.key ?? null, now, secrets),
    },
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
    ...(req.lastError
      ? [
          {
            // Server-written: why the last verdict was refused, naming numbers only (#466).
            title: 'Last attempt refused',
            name: 'last-refusal',
            kind: 'trusted' as const,
            text: req.lastError,
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
 * reasons, verdicts) fenced as untrusted data. `secrets` are the configured secrets
 * (`secretList`): the CI failures section is redacted with them as the heal's is (#720).
 */
export function diagnoseInput(
  db: Db,
  zone: DropZoneConfig,
  itemId: number,
  dropId: string,
  secrets: string[] = [],
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
    {
      // #395's renderer: redacted here, neutralised and fenced by `assemble`.
      title: 'Last failure',
      name: 'last-failure',
      kind: 'untrusted',
      text: lastFailureText(db, itemId),
    },
    ...ciFailuresSection(db, itemId, pr?.headSha ?? null, secrets),
  ]);
}

/**
 * The `ci-failures` section of a diagnose input (#720): the GitHub Actions failure annotations the
 * item's newest heal stored, when that heal was a `ci` heal, redacted here with the configured
 * secrets and the scrub set (as the heal's `redactionList` does), and neutralised and fenced by
 * `assemble`. A ci heal that pushed leaves the PR on a newer head than the one its failures were
 * read on (the usual heal-budget park), so the section then names both heads. None for any other
 * heal or no annotations.
 */
function ciFailuresSection(
  db: Db,
  itemId: number,
  headSha: string | null,
  secrets: string[],
): Section[] {
  const row = db
    .prepare(
      `SELECT input_json AS inputJson, head_sha AS headSha FROM drops
       WHERE work_item_id = ? AND role = 'heal'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as { inputJson: string | null; headSha: string | null } | undefined;
  if (!row) return [];
  let input: { feedback?: Feedback | null; ciAnnotations?: unknown } | null;
  try {
    input = JSON.parse(row.inputJson ?? 'null');
  } catch {
    return [];
  }
  if (input?.feedback?.source !== 'ci') return [];
  const text = ciFailureLines(ciAnnotationsOf(input.ciAnnotations), [
    ...secrets,
    ...serverScrubSet.values(),
  ]);
  if (text === '') return [];
  const note =
    headSha !== null && row.headSha !== null && row.headSha !== headSha
      ? `Read on head ${row.headSha}; the PR head is now ${headSha}.\n`
      : '';
  return [{ title: 'CI failures', name: 'ci-failures', kind: 'data', text: note + text }];
}

/** How the item's newest implement drop failed or was lost, as an implement retry reads it. */
function lastFailureText(db: Db, itemId: number): string {
  const f = newestFailure(db, itemId);
  return f
    ? failureText(f, [...serverScrubSet.values()])
    : 'The newest implement attempt did not fail.';
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

type AuditWork = { role: 'audit'; sha: string; message: string };

/** The pull request a merge or squash message names last, as `(#N)` at the end of its subject. */
export function mergedPrNumber(message: string): number | null {
  const subject = message.trim().split('\n')[0]?.trim() ?? '';
  const m = /\(#(\d+)\)$/.exec(subject) ?? /\(#(\d+)\)$/.exec(message.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The audit input for one merged commit: the goals, the protected paths and the commit (its full
 * SHA and the default branch, written here) as instructions; the commit message and the merged
 * issue (the zone's work item whose PR the message names, if any) as data.
 */
export function auditInput(db: Db, zone: DropZoneConfig, work: AuditWork, dropId: string): string {
  const branch =
    (
      db.prepare('SELECT default_branch AS b FROM drop_zones WHERE id = ?').get(zone.id) as
        | { b: string }
        | undefined
    )?.b ?? 'main';
  const pr = mergedPrNumber(work.message);
  const item =
    pr === null
      ? undefined
      : (db
          .prepare(
            `SELECT issue_number AS issueNumber, title, body FROM work_items
             WHERE drop_zone_id = ? AND pr_number = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(zone.id, pr) as { issueNumber: number; title: string; body: string } | undefined);
  return assemble('audit', dropId, [
    goalsSection(db, zone),
    {
      title: 'Protected paths',
      name: 'protected-paths',
      kind: 'trusted',
      text: zone.protectedPaths.map((p) => `- ${p}`).join('\n') || '(none)',
    },
    {
      title: 'Commit',
      name: 'commit',
      kind: 'trusted',
      text: `SHA: ${work.sha}\nDefault branch: ${branch}\n\nRun \`git show ${work.sha}\` to read it.`,
    },
    { title: 'Commit message', name: 'commit-message', kind: 'data', text: work.message },
    {
      title: 'Merged issue',
      name: 'merged-issue',
      kind: 'data',
      text: item
        ? `Issue #${item.issueNumber}\nTitle: ${item.title}\n\n${item.body}`
        : 'No Jumpmaster issue found for this commit.',
    },
  ]);
}
