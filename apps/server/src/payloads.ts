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
} from '@jumpmaster/protocol';
import {
  type ClaudeConfig,
  type Config,
  DEFAULT_PIDS_LIMIT,
  type DropZoneConfig,
} from './config.js';
import type { Db } from './db/open.js';
import { type Drop, getPullRequest, listWorkItems, updateDrop } from './db/repo.js';
import { resolveModel } from './fable.js';
import type { Feedback } from './flow/decide.js';
import { PRESET_EGRESS } from './presets.js';

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

/**
 * Quotes heading lines and breaks up code fences and data-fence markers so text from a forge
 * cannot forge prompt structure.
 */
export function neutralise(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? `> ${line}` : line))
    .join('\n')
    .replaceAll('```', '`\u200b`\u200b`')
    .replaceAll('<<<', '<\u200b<\u200b<');
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
      : '## Automated review findings (data, untrusted)';
  return `${heading}\n\n${fence(dropId, 'feedback', neutralise(f.text))}`;
}

/** How many of the latest author reports a reviewer sees. */
const MAX_REPORTS = 3;

type ReportRow = { role: string; headSha: string | null; resultJson: string };
type StoredResult = { status?: unknown; headSha?: unknown; summary?: unknown };

/** Results on which a current trooper always sends its report. */
const carriesReport = (role: string, r: StoredResult): boolean =>
  r.status === 'completed' || (role === 'heal' && r.status === 'no_changes');

/**
 * The author's reports for the reviewer: every succeeded implement and heal run on this item that
 * should carry one, oldest first, the last few fenced and labelled by the head each produced.
 */
function authorReports(db: Db, drop: Drop): string {
  const rows = db
    .prepare(
      `SELECT role, head_sha AS headSha, result_json AS resultJson FROM drops
       WHERE work_item_id = ? AND role IN ('implement', 'heal') AND state = 'succeeded'
         AND result_json IS NOT NULL
       ORDER BY created_at, rowid`,
    )
    .all(drop.workItemId) as ReportRow[];
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
    .slice(-MAX_REPORTS)
    .map(({ row, result }) => {
      const head = typeof result.headSha === 'string' ? result.headSha : (row.headSha ?? 'unknown');
      return `### Report for ${head.slice(0, 7)} (${row.role})\n\n${neutralise(String(result.summary))}`;
    });
  const body =
    reports.length > 0
      ? fence(drop.id, 'author-reports', reports.join('\n\n'))
      : 'No author report was recorded for this pull request.';
  const latest = runs.at(-1);
  const olderTrooper =
    latest !== undefined && !('summary' in latest.result)
      ? '\nThe latest author run came from an older trooper that sends no report, so for this review an acceptance criterion that needs a command run and reported, with no evidence, is `minor`, not `major`.'
      : '';
  return `## Author reports (data)\n\n${body}\n\nThe head under review is ${drop.headSha ?? 'unknown'}.${olderTrooper}`;
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
    | { role: 'refute'; crewIssueId: number }
    | { role: 'crew-lead' };
  input: string;
};

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
    ...(hasCustomLimits(zone) ? { limits: zone.limits } : {}),
    ...(zone.attribution === false ? { attribution: false } : {}),
    ...egressField(zone),
    prompt: `${templates[role]}\n\n${stored.input}`,
    credentials: {
      claudeToken: secrets.claudeToken,
      ...(zone.reviewReadToken && secrets.githubReadToken
        ? { forgeToken: secrets.githubReadToken }
        : {}),
    },
  };
  if (role !== 'diagnose') return { ...common, role };
  const work = stored.work;
  const itemId = work.role === 'diagnose' ? work.itemId : null;
  const pr = itemId === null ? undefined : getPullRequest(db, itemId);
  const item =
    itemId === null ? undefined : listWorkItems(db, zone.id).find((w) => w.id === itemId);
  return {
    ...common,
    role,
    ...(pr && pr.state === 'open' && pr.headSha && item
      ? {
          checkout: {
            number: pr.number,
            branch: agentBranch(item.issueNumber),
            headSha: pr.headSha,
          },
        }
      : {}),
  };
}

const DEFAULT_CLAUDE: ClaudeConfig = { plan: 'pro', fableWeeklyDropCap: 5 };

/**
 * The payload for a leased drop. The model comes from `resolveModel` (Fable only where the declared
 * plan includes it) and is recorded on the drop as `requested_model`.
 */
export function buildPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  secrets: Config['secrets'],
  o: { claude?: ClaudeConfig; now?: Date } = {},
): DropPayload {
  const model = resolveModel(
    db,
    { claude: o.claude ?? DEFAULT_CLAUDE },
    zone,
    drop.role as Role,
    o.now ?? new Date(),
  );
  // Records requested_model on the drop as a side effect (the Fable weekly cap counts it).
  updateDrop(db, drop.id, { requestedModel: model });
  if (isCrewRole(drop.role)) return buildCrewPayload(db, zone, drop, drop.role, secrets, model);
  const item = listWorkItems(db, zone.id).find((w) => w.id === drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  const role = drop.role as Role;
  const branch = agentBranch(item.issueNumber);
  const common = {
    protocol: 1 as const,
    dropId: drop.id,
    epoch: drop.epoch,
    repo: { owner, name, defaultBranch: row.defaultBranch },
    issue: { number: item.issueNumber, title: item.title, body: item.body },
    branch,
    gates: zone.gates,
    model,
    maxTurns: zone.maxTurns,
    promptVersion: promptVersions()[role],
    image: zone.image,
    protectedPaths: zone.protectedPaths,
    ...(zone.verification.length > 0 ? { verification: zone.verification } : {}),
    ...(zone.services.length > 0 ? { services: zone.services } : {}),
    ...(hasCustomLimits(zone) ? { limits: zone.limits } : {}),
    ...(secrets.zoneSecrets?.[zone.id] ? { gateSecrets: secrets.zoneSecrets[zone.id] } : {}),
    ...(zone.attribution === false ? { attribution: false } : {}),
    ...egressField(zone),
    prompt: `${templates[role]}\n\n## Issue (data)\n\n${fence(drop.id, 'issue', `#${item.issueNumber}: ${neutralise(item.title)}\n\n${neutralise(item.body)}`)}`,
  };
  const author = { claudeToken: secrets.claudeToken, forgeToken: secrets.githubAuthorToken };
  const pr = () => {
    if (drop.prNumber === null || drop.headSha === null) {
      throw new Error(`${role} drop ${drop.id} has no pull request`);
    }
    return { number: drop.prNumber, branch, headSha: drop.headSha };
  };

  switch (role) {
    case 'implement':
      return {
        ...common,
        role,
        credentials: author,
        resume: drop.headSha !== null,
        resumeSha: drop.headSha ?? undefined,
      };
    case 'review':
      return {
        ...common,
        role,
        pr: pr(),
        prompt: `${common.prompt}\n\n${authorReports(db, drop)}`,
        credentials: {
          claudeToken: secrets.claudeToken,
          ...(zone.reviewReadToken && secrets.githubReadToken
            ? { forgeToken: secrets.githubReadToken }
            : {}),
        },
      };
    case 'heal': {
      const input = JSON.parse(drop.inputJson ?? '{}') as { feedback?: Feedback };
      if (!input.feedback) throw new Error(`heal drop ${drop.id} has no feedback`);
      return {
        ...common,
        role,
        pr: pr(),
        credentials: author,
        feedback: renderFeedback(input.feedback, drop.id),
      };
    }
    case 'resolve':
      return { ...common, role, pr: pr(), credentials: author };
    default:
      throw new Error(`unknown drop role ${String(drop.role)}`);
  }
}
