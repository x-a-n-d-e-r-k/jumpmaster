import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  agentBranch,
  CREW_ROLES,
  type CrewRole,
  type DropPayload,
  type EgressPayload,
  isCrewRole,
  normalizeHost,
  type Role,
  redact,
  type TriageImage,
  type TriageImageSkipped,
} from '@jumpmaster/protocol';
import { COMMAND_VIAS } from './briefings.js';
import {
  type ClaudeConfig,
  type Config,
  DEFAULT_PIDS_LIMIT,
  type DropZoneConfig,
} from './config.js';
import { appliedItemArbitration, getCrewRetry } from './crew/store.js';
import type { Db } from './db/open.js';
import { type Drop, getPullRequest, listWorkItems, updateDrop, type WorkItem } from './db/repo.js';
import { resolveModel } from './fable.js';
import type { CodeScanning, Feedback } from './flow/decide.js';
import { malformedDrops } from './flow/malformed.js';
import { type CrewRetryNote, lastFailure, renderLastFailure } from './gate-output.js';
import { unsanitizeForgeText } from './outbox.js';
import { PRESET_EGRESS } from './presets.js';
import { redactionList } from './scrub.js';

const ROLES: Role[] = ['implement', 'review', 'heal', 'resolve', ...CREW_ROLES];

// Same relative depth from src (vitest) and dist (built): up to apps/, then trooper/.
const templates = Object.fromEntries(
  ROLES.map((r) => [
    r,
    readFileSync(new URL(`../../trooper/prompts/${r}.md`, import.meta.url), 'utf8'),
  ]),
) as Record<Role, string>;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const VERSIONS = Object.fromEntries(
  ROLES.map((r) => [r, sha256(templates[r]).slice(0, 12)]),
) as Record<Role, string>;

/** First 12 hex of sha256(prompt template), per role; recorded on every drop. */
export const promptVersions = (): Record<Role, string> => VERSIONS;

/** A crew role's prompt template; the rendered input follows it. */
export const crewTemplate = (role: CrewRole): string => templates[role];

/** A zone's own gate secrets: never an inherited member (a zone named toString has none). */
export function ownZoneSecrets(
  secrets: { zoneSecrets?: Record<string, Record<string, string>> },
  zoneId: string,
): Record<string, string> | undefined {
  const all = secrets.zoneSecrets;
  return all && Object.hasOwn(all, zoneId) ? all[zoneId] : undefined;
}

/** Zero-width and invisible format characters that could hide a heading's `#` from the test. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff\u00ad]/g;

/**
 * Quotes heading lines and breaks up code fences and data-fence markers so text from a forge
 * cannot forge prompt structure. Line endings are normalised to `\n` and invisible characters
 * removed first, so neither a bare `\r` nor a zero-width character can hide a heading. Idempotent:
 * the zero-width spaces it inserts are removed and put back on a second pass.
 */
export function neutralise(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? `> ${line}` : line))
    .join('\n')
    .replaceAll('```', '`\u200b`\u200b`')
    .replaceAll('<<<', '<\u200b<\u200b<');
}

/**
 * The crew's retry of the item (#396), for an implement drop of that retry: the row says
 * `retried`, the drop was created at or after it was applied, and no implement drop of the item
 * since then failed. So it rides every attempt of the crew's retry (an interrupted one's
 * continuation too) and stops once that retry fails.
 *
 * One failure does not end it: the malformed run that got its one retry (#659), by results.ts's
 * rule. That is a null-head drop that ended malformed and is the item's only such implement drop
 * across its whole history, so its retry is another attempt of the same crew retry. Any other
 * malformed failure parked the item.
 */
function crewRetryNote(
  db: Db,
  itemId: number,
  drop: Pick<Drop, 'id' | 'createdAt'>,
): CrewRetryNote | undefined {
  const r = getCrewRetry(db, itemId);
  if (
    r?.kind !== 'retry' ||
    r.outcome !== 'retried' ||
    r.appliedAt === null ||
    drop.createdAt < r.appliedAt
  ) {
    return undefined;
  }
  const malformed = malformedDrops(db, itemId, 'implement', null);
  const retried = malformed.length === 1 ? malformed[0] : null;
  const failedSince = db
    .prepare(
      // One created at applied_at's very instant counts only if inserted after the diagnose drop
      // that asked for the retry: the failure it diagnosed was inserted before it.
      `SELECT 1 FROM drops WHERE work_item_id = ? AND role = 'implement' AND state = 'failed'
         AND id <> ? AND id IS NOT ? AND created_at <= @until
         AND (created_at > @from
           OR (created_at = @from AND rowid > COALESCE((SELECT rowid FROM drops WHERE id = ?), 0)))
       LIMIT 1`,
    )
    .get(itemId, drop.id, retried, r.dropId, { from: r.appliedAt, until: drop.createdAt });
  return failedSince ? undefined : { diagnosis: r.diagnosis, instruction: r.instruction };
}

/**
 * The crew's retry of an item with an open PR (#420), for a heal or resolve drop of that retry:
 * the row says `retried`, the drop was created at or after it was applied, and the item was not
 * briefed as parked since. So it rides every drop of the crew's retry and stops once the item
 * parks again.
 */
function crewPrRetryNote(
  db: Db,
  item: Pick<WorkItem, 'id' | 'dropZoneId'>,
  drop: Pick<Drop, 'createdAt'>,
): CrewRetryNote | undefined {
  const r = getCrewRetry(db, item.id);
  if (
    r?.kind !== 'retry' ||
    r.outcome !== 'retried' ||
    r.appliedAt === null ||
    drop.createdAt < r.appliedAt
  ) {
    return undefined;
  }
  const parkedSince = db
    .prepare(
      `SELECT 1 FROM briefings WHERE zone_id = ? AND kind = 'parked' AND subject = ?
         AND created_at > ? AND created_at <= ? LIMIT 1`,
    )
    .get(item.dropZoneId, `item:${item.id}`, r.appliedAt, drop.createdAt);
  return parkedSince ? undefined : { diagnosis: r.diagnosis, instruction: r.instruction };
}

/**
 * Command's direction for this drop (#535): the note of the item's latest applied Retry ruling,
 * when Command made it (the browser or `ctl`, never the chat assistant) and wrote one. It rides
 * every drop of the item created at or after the ruling applied, until a parked briefing for the
 * item is created after that: the item parked again.
 */
function commandDirection(
  db: Db,
  item: Pick<WorkItem, 'id' | 'dropZoneId'>,
  drop: Pick<Drop, 'createdAt'>,
): string | undefined {
  const subject = `item:${item.id}`;
  const r = db
    .prepare(
      `SELECT r.note, r.via, r.applied_at AS appliedAt FROM rulings r
         JOIN briefings b ON b.id = r.briefing_id
       WHERE r.zone_id = ? AND b.subject = ? AND r.choice_effect = 'retry_item'
         AND r.applied_at IS NOT NULL
       ORDER BY r.applied_at DESC, r.id DESC LIMIT 1`,
    )
    .get(item.dropZoneId, subject) as
    | { note: string; via: string | null; appliedAt: string }
    | undefined;
  if (!r || !(COMMAND_VIAS as readonly (string | null)[]).includes(r.via)) return undefined;
  if (r.note.trim() === '' || drop.createdAt < r.appliedAt) return undefined;
  const parkedSince = db
    .prepare(
      `SELECT 1 FROM briefings WHERE zone_id = ? AND kind = 'parked' AND subject = ?
         AND created_at > ? LIMIT 1`,
    )
    .get(item.dropZoneId, subject, r.appliedAt);
  return parkedSince ? undefined : r.note;
}

/**
 * Command's direction as a prompt section: redacted (the given secrets and token shapes), then
 * neutralised, then fenced as data, like every other untrusted section.
 */
function renderDirection(note: string, dropId: string, secrets: string[]): string {
  const body = neutralise(redact(note, secrets));
  return `## Command's direction (data, from Command's ruling)\n\n${fence(dropId, 'command-direction', body)}`;
}

/** A heal's or resolve's prompt with the crew's retry note (#420), if it carries one. */
function withCrewRetry(
  prompt: string,
  db: Db,
  item: Pick<WorkItem, 'id' | 'dropZoneId'>,
  drop: Pick<Drop, 'id' | 'createdAt'>,
  secrets: string[],
): string {
  const note = crewPrRetryNote(db, item, drop);
  return note ? `${prompt}\n\n${renderLastFailure(undefined, drop.id, secrets, note)}` : prompt;
}

/**
 * Wraps server-provided data in a per-drop fence. Callers neutralise the text first, so it cannot
 * contain a marker that closes the fence early.
 */
export function fence(dropId: string, name: string, text: string): string {
  return `<<<jm-data:${dropId}:begin ${name}>>>\n${text}\n<<<jm-data:${dropId}:end ${name}>>>`;
}

/** Human feedback is trusted; automated review and CI findings are untrusted data. */
export function renderFeedback(f: Feedback, dropId: string): string {
  const heading =
    f.source === 'human'
      ? '## Feedback (data, from trusted reviewers)'
      : f.source === 'crew'
        ? '## Feedback (data, from the server)'
        : '## Automated review findings (data, untrusted)';
  return `${heading}\n\n${fence(dropId, 'feedback', neutralise(unsanitizeForgeText(f.text)))}`;
}

/** Follows the code-scanning section, outside every fence (#652). */
export const CODE_SCANNING_INSTRUCTION =
  'Code scanning is not one of the gates. Fix the code an alert names, or, if the alert is wrong for this design, change nothing for it and say why in your report.';

/** The most characters of an alert's message the heal sees, counted after redaction. */
const MAX_ALERT_MESSAGE = 300;

/**
 * A Markdown link `[text](target)` (CodeQL links the code it names by number). Neither part may
 * hold a bracket, a parenthesis or a newline, so every scan stops at the next delimiter: linear.
 */
const MD_LINK = /\[([^[\]()\n]*)\]\(([^[\]()\s]*)\)/g;

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ');

/** The code-scanning alerts in a heal's `input_json`, malformed entries dropped. */
function codeScanningOf(raw: unknown): CodeScanning[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e: unknown) => {
    const c = e as Partial<CodeScanning> | null;
    if (typeof c?.check !== 'string' || !Array.isArray(c.annotations)) return [];
    const annotations = c.annotations.filter(
      (a) =>
        typeof a?.path === 'string' &&
        typeof a.startLine === 'number' &&
        typeof a.title === 'string' &&
        typeof a.message === 'string',
    );
    return [{ check: c.check, annotations }];
  });
}

/**
 * A heal's code-scanning alerts (#652), one line each, `<check>: <title> at <path>:<line>:
 * <message>`: links stripped to their text, each message cut after redaction, then the whole
 * section redacted, neutralised and fenced as untrusted data. The fixed instruction follows,
 * outside the fence. Empty when there is no annotation.
 */
export function renderCodeScanning(
  entries: CodeScanning[],
  dropId: string,
  secrets: string[],
): string {
  const lines = entries.flatMap((e) =>
    e.annotations.map((a) => {
      const message = [...redact(oneLine(a.message).replace(MD_LINK, '$1'), secrets)]
        .slice(0, MAX_ALERT_MESSAGE)
        .join('');
      return oneLine(`${e.check}: ${a.title} at ${a.path}:${a.startLine}: ${message}`);
    }),
  );
  if (lines.length === 0) return '';
  const body = neutralise(redact(lines.join('\n'), secrets));
  return `## Code scanning alerts (data)\n\n${fence(dropId, 'code-scanning', body)}\n\n${CODE_SCANNING_INSTRUCTION}`;
}

/** Follows the ci-failures section, outside every fence (#720). */
export const CI_FAILURES_INSTRUCTION =
  "These are the failures CI reported. If a test fails only in CI, compare CI's environment with yours (environment variables, tool versions) before changing code.";

/** The most characters of a CI failure annotation's message an agent sees, after redaction. */
const MAX_CI_MESSAGE = 600;

/** The GitHub Actions failure annotations in a heal's `input_json` (#720), malformed ones dropped. */
export const ciAnnotationsOf = (raw: unknown): CodeScanning[] => codeScanningOf(raw);

/**
 * A heal's GitHub Actions failure annotations (#720), one line each, `<check>: <path>:<startLine>
 * <title>: <message>`, each message cut after redaction, and the whole text redacted again. Not
 * neutralised or fenced: the caller does both. Empty when there is no annotation.
 */
export function ciFailureLines(entries: CodeScanning[], secrets: string[]): string {
  const lines = entries.flatMap((e) =>
    e.annotations.map((a) => {
      const message = [...redact(oneLine(a.message), secrets)].slice(0, MAX_CI_MESSAGE).join('');
      return oneLine(`${e.check}: ${a.path}:${a.startLine} ${a.title}: ${message}`);
    }),
  );
  return redact(lines.join('\n'), secrets);
}

/**
 * A heal's GitHub Actions failure annotations (#720), redacted, neutralised and fenced as data as
 * `renderCodeScanning` does, the fixed instruction after it, outside the fence. Empty when there
 * is no annotation.
 */
export function renderCiFailures(
  entries: CodeScanning[],
  dropId: string,
  secrets: string[],
): string {
  const lines = ciFailureLines(entries, secrets);
  if (lines === '') return '';
  return `## CI failures (data)\n\n${fence(dropId, 'ci-failures', neutralise(lines))}\n\n${CI_FAILURES_INSTRUCTION}`;
}

/** How many of the latest author reports a reviewer sees. */
const MAX_REPORTS = 3;

type ReportRow = { role: string; headSha: string | null; resultJson: string };
type StoredResult = { status?: unknown; headSha?: unknown; summary?: unknown };

/** Results on which a current trooper always sends its report. */
const carriesReport = (role: string, r: StoredResult): boolean =>
  r.status === 'completed' || (role === 'heal' && r.status === 'no_changes');

/** One author report: the run that wrote it, the head it produced and its summary as sent. */
export type AuthorReport = { role: string; head: string; summary: string };

/**
 * Every succeeded implement and heal run on the item that should carry a report, oldest first:
 * `reports` are those that sent a non-empty summary, `latestSentNone` is true when the newest run
 * came from an older trooper that sends none. The reviewer and the arbiter both read these.
 */
export function gatherAuthorReports(
  db: Db,
  itemId: number | null,
): { reports: AuthorReport[]; latestSentNone: boolean } {
  const rows = db
    .prepare(
      `SELECT role, head_sha AS headSha, result_json AS resultJson FROM drops
       WHERE work_item_id = ? AND role IN ('implement', 'heal') AND state = 'succeeded'
         AND result_json IS NOT NULL
       ORDER BY created_at, rowid`,
    )
    .all(itemId) as ReportRow[];
  const runs = rows
    .map((row) => {
      try {
        return { row, result: JSON.parse(row.resultJson) as StoredResult };
      } catch {
        return null;
      }
    })
    .filter((r): r is { row: ReportRow; result: StoredResult } => r !== null)
    .filter(({ row, result }) => carriesReport(row.role, result));
  const reports = runs
    .filter(({ result }) => typeof result.summary === 'string' && result.summary.trim() !== '')
    .map(({ row, result }) => ({
      role: row.role,
      head: typeof result.headSha === 'string' ? result.headSha : (row.headSha ?? 'unknown'),
      summary: String(result.summary),
    }));
  const latest = runs.at(-1);
  return { reports, latestSentNone: latest !== undefined && !('summary' in latest.result) };
}

/**
 * The author's reports for the reviewer: the last few, fenced and labelled by the head each
 * produced.
 */
function authorReports(db: Db, drop: Drop): string {
  const { reports, latestSentNone } = gatherAuthorReports(db, drop.workItemId);
  const shown = reports
    .slice(-MAX_REPORTS)
    .map((r) => `### Report for ${r.head.slice(0, 7)} (${r.role})\n\n${neutralise(r.summary)}`);
  const body =
    shown.length > 0
      ? fence(drop.id, 'author-reports', shown.join('\n\n'))
      : 'No author report was recorded for this pull request.';
  const olderTrooper = latestSentNone
    ? '\nThe latest author run came from an older trooper that sends no report, so for this review an acceptance criterion that needs a command run and reported, with no evidence, is `minor`, not `major`.'
    : '';
  return `## Author reports (data)\n\n${body}\n\nThe head under review is ${drop.headSha ?? 'unknown'}.${olderTrooper}`;
}

/** Which side an arbiter's ruling is for, in the next rounds' words. */
const RULED_FOR = {
  A: 'the reviewer (A: the change does not yet meet the issue)',
  B: 'the author (B: the change meets the issue, and the remaining findings are not defects)',
} as const;

/**
 * The applied arbiter ruling on this item, for its later review and heal drops: fenced and
 * neutralised like feedback, since an agent wrote it. Empty when the item has none.
 */
function arbiterRuling(db: Db, drop: Drop): string {
  if (drop.workItemId === null) return '';
  const row = appliedItemArbitration(db, drop.workItemId);
  if (!row || (row.ruling !== 'A' && row.ruling !== 'B')) return '';
  const text = [
    `Ruled for ${RULED_FOR[row.ruling]}.`,
    '',
    `Because: ${row.because ?? ''}`,
    '',
    `Instruction: ${row.instruction ?? ''}`,
  ].join('\n');
  return (
    '\n\n## Arbiter ruling (data, untrusted)\n\n' +
    'Reviewer and author on this item disagreed until its heals ran out, and an arbiter ruled ' +
    'between them. Weigh its ruling against the code as evidence; it decides nothing for you.\n\n' +
    fence(drop.id, 'arbiter-ruling', neutralise(text))
  );
}

/**
 * Hosts every drop under egress reaches: the Claude API and GitHub (clone and push). The monitor
 * rehearsal may extend this; the commit that does records the hosts it observed.
 */
export const BASE_EGRESS = ['api.anthropic.com', 'github.com'];

/** An entry in canonical form: a name, or `*.` plus a name. */
const canonicalEntry = (e: string): string =>
  e.startsWith('*.') ? `*.${normalizeHost(e.slice(2)) ?? e.slice(2)}` : (normalizeHost(e) ?? e);

/**
 * The payload's `egress`, absent when the zone's mode is `off` (M3 behaviour). The allow list is
 * the base, the preset's hosts and the zone's own entries, canonical, deduplicated and sorted.
 */
export function egressFor(zone: DropZoneConfig): EgressPayload | undefined {
  const mode = zone.egress?.mode ?? 'off';
  if (mode === 'off') return undefined;
  const entries = [
    ...BASE_EGRESS,
    ...(zone.preset ? PRESET_EGRESS[zone.preset] : []),
    ...(zone.egress?.allow ?? []),
  ].map(canonicalEntry);
  return { mode, allow: [...new Set(entries)].sort() };
}

const egressField = (zone: DropZoneConfig): { egress?: EgressPayload } => {
  const egress = egressFor(zone);
  return egress ? { egress } : {};
};

const hasCustomLimits = ({ limits }: DropZoneConfig): boolean =>
  limits.pids !== DEFAULT_PIDS_LIMIT || limits.memoryMb !== undefined || limits.shmMb !== undefined;

/** What a crew drop stores in `input_json`: its work and the rendered (fenced) input. */
export type CrewInputJson = {
  work:
    | {
        role: 'diagnose';
        briefingId: number;
        itemId: number;
        /** `whyBasis` of the briefing's why when asked; absent on drops queued before v12. */
        basis?: string;
      }
    | {
        role: 'refute';
        crewIssueId: number;
        /** The crew issue was security-touching at enqueue (#384); absent on older drops. */
        securityTouching?: boolean;
      }
    | { role: 'triage'; requestId: number }
    | {
        role: 'arbitrate';
        subject: 'issue';
        crewIssueId: number;
        /** The crew issue's `body_sha` when asked: the text the ruling is about. */
        basis: string;
      }
    | {
        role: 'arbitrate';
        subject: 'item';
        itemId: number;
        /** The item's parked briefing the ruling answers when it does not act. */
        briefingId: number;
        /** The PR head in dispute when asked: a ruling that lands after it moved is discarded. */
        headSha: string;
        basis: 'review';
      }
    | {
        role: 'audit';
        /** The merged first-parent commit audited, a full SHA on the default branch. */
        sha: string;
        /** Its commit message as the forge reported it. */
        message: string;
      }
    | { role: 'crew-lead' };
  input: string;
  /** A triage drop's issue images, fetched and checked at enqueue (`crew/images.ts`). */
  images?: TriageImage[];
  /** One short reason per image URL not fetched. */
  imagesSkipped?: TriageImageSkipped[];
};

/**
 * The drop asks for Fable beyond its role: a refute whose stored work says the crew issue is
 * security-touching. Unreadable input, another role or a missing field is false (today's model).
 */
export function fableWanted(drop: Pick<Drop, 'inputJson'>): boolean {
  try {
    const stored = JSON.parse(drop.inputJson ?? 'null') as Partial<CrewInputJson> | null;
    const work = stored?.work;
    return work?.role === 'refute' && work.securityTouching === true;
  } catch {
    return false;
  }
}

/**
 * A crew drop: the template plus the input rendered at enqueue. It never carries the author or
 * reviewer token: at most the read token, on the same terms as review.
 */
function buildCrewPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  role: CrewRole,
  secrets: Config['secrets'],
  model: string,
  readToken: string | undefined,
): DropPayload {
  const stored = JSON.parse(drop.inputJson ?? 'null') as CrewInputJson | null;
  if (!stored || typeof stored.input !== 'string') {
    throw new Error(`crew drop ${drop.id} has no input`);
  }
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  const common = {
    protocol: 1 as const,
    dropId: drop.id,
    epoch: drop.epoch,
    repo: { owner, name, defaultBranch: row.defaultBranch },
    model,
    maxTurns: zone.maxTurns,
    promptVersion: promptVersions()[role],
    image: zone.image,
    protectedPaths: zone.protectedPaths,
    ...(zone.privateKeyPaths.length > 0 ? { privateKeyPaths: zone.privateKeyPaths } : {}),
    ...(hasCustomLimits(zone) ? { limits: zone.limits } : {}),
    ...(zone.attribution === false ? { attribution: false } : {}),
    ...egressField(zone),
    prompt: `${templates[role]}\n\n${stored.input}`,
    credentials: {
      claudeToken: secrets.claudeToken,
      ...(readToken ? { forgeToken: readToken } : {}),
    },
  };
  if (role === 'triage') {
    return {
      ...common,
      role,
      ...(stored.images && stored.images.length > 0 ? { images: stored.images } : {}),
      ...(stored.imagesSkipped && stored.imagesSkipped.length > 0
        ? { imagesSkipped: stored.imagesSkipped }
        : {}),
    };
  }
  const work = stored.work;
  const checkout =
    work.role === 'diagnose'
      ? itemCheckout(db, zone, work.itemId)
      : work.role === 'arbitrate' && work.subject === 'item'
        ? itemCheckout(db, zone, work.itemId, work.headSha)
        : undefined;
  if (role === 'diagnose' || role === 'arbitrate') {
    return { ...common, role, ...(checkout ? { checkout } : {}) };
  }
  return { ...common, role };
}

/**
 * The parked PR a diagnose or an item's arbitration reads: the item's open PR, at `headSha` when
 * given (the head in dispute) or else its current head. None when the PR is not open.
 */
function itemCheckout(
  db: Db,
  zone: DropZoneConfig,
  itemId: number,
  headSha?: string,
): { number: number; branch: string; headSha: string } | undefined {
  const pr = getPullRequest(db, itemId);
  const item = listWorkItems(db, zone.id).find((w) => w.id === itemId);
  const head = headSha ?? pr?.headSha;
  if (!pr || pr.state !== 'open' || !head || !item) return undefined;
  return { number: pr.number, branch: agentBranch(item.issueNumber), headSha: head };
}

/**
 * A doctor drop: the zone's image, gates, services, gate secrets and egress, on the default branch.
 * No issue, branch, prompt or write token: at most the read token, on the same terms as review.
 */
function buildDoctorPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  secrets: Config['secrets'],
  model: string,
  readToken: string | undefined,
): DropPayload {
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  return {
    // The trooper finds the payload on stdin by its leading protocol field.
    protocol: 1 as const,
    dropId: drop.id,
    epoch: drop.epoch,
    role: 'doctor',
    repo: { owner, name, defaultBranch: row.defaultBranch },
    model,
    image: zone.image,
    gates: zone.gates,
    ...(zone.services.length > 0 ? { services: zone.services } : {}),
    ...(hasCustomLimits(zone) ? { limits: zone.limits } : {}),
    ...(ownZoneSecrets(secrets, zone.id) ? { gateSecrets: ownZoneSecrets(secrets, zone.id) } : {}),
    ...(zone.gateCi === false ? { gateCi: false } : {}),
    ...egressField(zone),
    credentials: {
      claudeToken: secrets.claudeToken,
      ...(readToken ? { readToken } : {}),
    },
  };
}

const DEFAULT_CLAUDE: ClaudeConfig = {
  plan: 'pro',
  fableWeeklyDropCap: 0,
  fableReview: true,
  fableReviewMaxUtilization: 0.5,
};

/**
 * The model a drop runs on when it is leased at `now`: what buildPayload resolves and records as
 * `requested_model`. A queued drop has no `requested_model` yet; the lease route reads this to hold
 * drops on a model whose own usage window is at the threshold (#747).
 */
export function leaseModel(
  db: Db,
  zone: DropZoneConfig,
  drop: Pick<Drop, 'role' | 'inputJson'>,
  claude: ClaudeConfig | undefined,
  now: Date,
): string {
  return resolveModel(db, { claude: claude ?? DEFAULT_CLAUDE }, zone, drop.role as Role, now, {
    fable: fableWanted(drop),
  });
}

/**
 * The payload for a leased drop. The model comes from `resolveModel` (Fable only where the declared
 * plan includes it) and is recorded on the drop as `requested_model`.
 *
 * `readToken`: the app's `contents: read` token minted for this drop alone, by the role's app:
 * - the reviewer app's (issue #237) for a review, crew or doctor drop, which clones with it in
 *   place of the read PAT, whatever `reviewReadToken` says; absent, those drops get the read PAT
 *   only when the zone sets `reviewReadToken`;
 * - the author app's (issue #249) for an implement, heal or resolve drop, which fetches with it in
 *   place of any PAT; absent, those drops get `githubReadToken ?? githubAuthorToken` (Ruling 1).
 */
export function buildPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  secrets: Config['secrets'],
  o: { claude?: ClaudeConfig; now?: Date; readToken?: string } = {},
): DropPayload {
  const model = leaseModel(db, zone, drop, o.claude, o.now ?? new Date());
  // Records requested_model on the drop as a side effect (the Fable weekly cap counts it).
  updateDrop(db, drop.id, { requestedModel: model });
  // The clone token of review, crew and doctor drops (never an author's).
  const readToken =
    o.readToken ??
    (zone.reviewReadToken && secrets.githubReadToken ? secrets.githubReadToken : undefined);
  if (isCrewRole(drop.role))
    return buildCrewPayload(db, zone, drop, drop.role, secrets, model, readToken);
  if (drop.role === 'doctor') return buildDoctorPayload(db, zone, drop, secrets, model, readToken);
  const item = listWorkItems(db, zone.id).find((w) => w.id === drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  const role = drop.role as Role;
  // Forge text loses the outbox's mention-breaking joiners, so quoted values arrive as written.
  const title = unsanitizeForgeText(item.title);
  const body = unsanitizeForgeText(item.body);
  const branch = agentBranch(item.issueNumber);
  const direction = commandDirection(db, item, drop);
  const common = {
    protocol: 1 as const,
    dropId: drop.id,
    epoch: drop.epoch,
    repo: { owner, name, defaultBranch: row.defaultBranch },
    issue: { number: item.issueNumber, title, body },
    branch,
    gates: zone.gates,
    model,
    maxTurns: zone.maxTurns,
    promptVersion: promptVersions()[role],
    image: zone.image,
    protectedPaths: zone.protectedPaths,
    ...(zone.privateKeyPaths.length > 0 ? { privateKeyPaths: zone.privateKeyPaths } : {}),
    ...(zone.verification.length > 0 ? { verification: zone.verification } : {}),
    ...(zone.services.length > 0 ? { services: zone.services } : {}),
    ...(hasCustomLimits(zone) ? { limits: zone.limits } : {}),
    ...(ownZoneSecrets(secrets, zone.id) ? { gateSecrets: ownZoneSecrets(secrets, zone.id) } : {}),
    ...(zone.gateCi === false ? { gateCi: false } : {}),
    ...(zone.attribution === false ? { attribution: false } : {}),
    ...egressField(zone),
    // Command's direction, if any, follows the issue: before any crew note or previous attempt.
    prompt: `${templates[role]}\n\n## Issue (data)\n\n${fence(drop.id, 'issue', `#${item.issueNumber}: ${neutralise(title)}\n\n${neutralise(body)}`)}${direction ? `\n\n${renderDirection(direction, drop.id, redactionList(secrets))}` : ''}`,
  };
  // Ruling 1: the agent container only fetches (the push container pushes with a grant), so it
  // gets the read token when one is configured. In PAT mode without one it still holds the author
  // token for its fetch; it never pushes with it. In an app-author zone the lease passes the author
  // app's per-drop read token (issue #249), and no PAT is used.
  const fetchCredentials = {
    claudeToken: secrets.claudeToken,
    forgeToken: o.readToken ?? secrets.githubReadToken ?? secrets.githubAuthorToken,
  };
  const pr = () => {
    if (drop.prNumber === null || drop.headSha === null) {
      throw new Error(`${role} drop ${drop.id} has no pull request`);
    }
    return { number: drop.prNumber, branch, headSha: drop.headSha };
  };

  switch (role) {
    case 'implement': {
      // A retry learns how the last attempt failed (#395), and what the crew told it when the
      // crew retried it (#396): untrusted, redacted, fenced.
      const failure = lastFailure(db, item.id, drop);
      const crewRetry = crewRetryNote(db, item.id, drop);
      return {
        ...common,
        role,
        ...(failure || crewRetry
          ? {
              prompt: `${common.prompt}\n\n${renderLastFailure(failure, drop.id, redactionList(secrets), crewRetry)}`,
            }
          : {}),
        credentials: fetchCredentials,
        resume: drop.headSha !== null,
        resumeSha: drop.headSha ?? undefined,
      };
    }
    case 'review':
      return {
        ...common,
        role,
        pr: pr(),
        prompt: `${common.prompt}\n\n${authorReports(db, drop)}${arbiterRuling(db, drop)}`,
        credentials: {
          claudeToken: secrets.claudeToken,
          ...(readToken ? { forgeToken: readToken } : {}),
        },
      };
    case 'heal': {
      const input = JSON.parse(drop.inputJson ?? '{}') as {
        feedback?: Feedback;
        codeScanning?: unknown;
        ciAnnotations?: unknown;
      };
      if (!input.feedback) throw new Error(`heal drop ${drop.id} has no feedback`);
      const feedback = renderFeedback(input.feedback, drop.id);
      // Each set of annotations in its own fence (#652, #720).
      const sections = [
        renderCodeScanning(codeScanningOf(input.codeScanning), drop.id, redactionList(secrets)),
        renderCiFailures(ciAnnotationsOf(input.ciAnnotations), drop.id, redactionList(secrets)),
      ].filter((x) => x !== '');
      return {
        ...common,
        role,
        pr: pr(),
        prompt: withCrewRetry(
          `${common.prompt}${arbiterRuling(db, drop)}`,
          db,
          item,
          drop,
          redactionList(secrets),
        ),
        credentials: fetchCredentials,
        feedback: [feedback, ...sections].join('\n\n'),
      };
    }
    case 'resolve':
      return {
        ...common,
        role,
        pr: pr(),
        prompt: withCrewRetry(common.prompt, db, item, drop, redactionList(secrets)),
        credentials: fetchCredentials,
      };
    default:
      throw new Error(`unknown drop role ${String(drop.role)}`);
  }
}
