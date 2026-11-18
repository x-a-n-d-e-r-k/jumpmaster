import type { z } from 'zod';
import { DropZoneObject, EditableSchema } from '../config.js';
import {
  effective,
  GUARDED_PATHS,
  NOT_GUARDED,
  REFUSED_PATHS,
  SESSION_FORBIDDEN,
} from './guarded.js';
import { defOf, schemaLeaves } from './schema-leaves.js';

/**
 * The settings catalog (issue #321): every leaf of the editable config, in plain words, with its
 * group, the control that edits it and its guard. The flags pages render from it; a test keeps it
 * complete against the schema, as `guarded.test.ts` keeps the guard tables complete. Defaults,
 * bounds, options and guards are read from the schema and the guard tables, never copied here.
 */

export type FlagScope = 'zone' | 'install';
export type FlagGroup =
  | 'crew'
  | 'retries'
  | 'pace'
  | 'labels'
  | 'models'
  | 'transcripts'
  | 'safety'
  | 'other';
export type FlagKind = 'bool' | 'number' | 'text' | 'select' | 'list' | 'elsewhere';
export type FlagGuard = 'free' | 'guarded' | 'browser-forbidden' | 'refused';

export interface FlagEntry {
  /** The path as guarded.ts writes it: 'dropZones[].crew.refutePromotes', 'pollSeconds'. */
  path: string;
  group: FlagGroup;
  /** Plain words, at most 60 characters, never the key itself. */
  label: string;
  /** One or two sentences: what it does, and what changes when it is changed. */
  help: string;
  kind: FlagKind;
  /** kind 'elsewhere': one sentence saying where it is changed, e.g. 'Changed in the Stack section.' */
  elsewhere?: string;
}

export interface FlagRow {
  entry: FlagEntry;
  scope: FlagScope;
  /** The path within its document: 'crew.refutePromotes' for a zone, 'pollSeconds' for the install. */
  key: string;
  /** What it runs with (guarded.ts `effective`). */
  value: unknown;
  defaultValue: unknown;
  /** The document sets the key itself. */
  explicit: boolean;
  guard: FlagGuard;
  /** kind 'select': the enum's values. */
  options?: readonly string[];
  /** kind 'number': from the schema's checks. */
  min?: number;
  max?: number;
  integer?: boolean;
}

const GROUPS: readonly FlagGroup[] = [
  'crew',
  'retries',
  'pace',
  'labels',
  'models',
  'transcripts',
  'safety',
  'other',
];
const ZONE_PREFIX = 'dropZones[].';

const scopeOf = (path: string): FlagScope => (path.startsWith(ZONE_PREFIX) ? 'zone' : 'install');
const keyOf = (path: string): string =>
  path.startsWith(ZONE_PREFIX) ? path.slice(ZONE_PREFIX.length) : path;

const GUARDS = new Map<string, FlagGuard>([
  ...GUARDED_PATHS.map((g): [string, FlagGuard] => [g.path, 'guarded']),
  ...SESSION_FORBIDDEN.map((g): [string, FlagGuard] => [g.path, 'browser-forbidden']),
  ...REFUSED_PATHS.map((g): [string, FlagGuard] => [g.path, 'refused']),
  ...NOT_GUARDED.map((g): [string, FlagGuard] => [g.path, 'free']),
]);

/** The guard of a path; a path no table names is guarded, as `classify` fails closed. */
const guardOf = (path: string): FlagGuard => GUARDS.get(path) ?? 'guarded';

const LABEL_KEYS = ['readyLabel', 'retryLabel', 'triageLabel', 'triagedLabel', 'crew.stagedLabel'];
const PACE_KEYS = [
  'maxConcurrentImplement',
  'maxOpenPrs',
  'mergeReservationMinutes',
  'ciDeadlineMinutes',
  'outboxDeadlineMinutes',
  'pollSeconds',
];

/** The group of a scope-relative key: the first rule that matches wins. */
function groupOf(key: string, guard: FlagGuard): FlagGroup {
  const under = (prefix: string) => key.startsWith(`${prefix}.`);
  if (LABEL_KEYS.includes(key)) return 'labels';
  if (under('crew')) return 'crew';
  if (under('budgets')) return 'retries';
  if (under('transcripts')) return 'transcripts';
  if (['model', 'models', 'maxTurns'].includes(key) || under('claude')) return 'models';
  if (PACE_KEYS.includes(key) || under('usage')) return 'pace';
  if (guard === 'guarded' || guard === 'browser-forbidden') return 'safety';
  return 'other';
}

type Words = Omit<FlagEntry, 'group'>;

const STACK = 'Changed in the Stack section.';
const ADVANCED = "Changed in the zone's JSON editor (Advanced section).";

const z_ = (key: string, label: string, help: string, kind: FlagKind, elsewhere?: string) =>
  w(`${ZONE_PREFIX}${key}`, label, help, kind, elsewhere);
function w(path: string, label: string, help: string, kind: FlagKind, elsewhere?: string): Words {
  return { path, label, help, kind, ...(elsewhere ? { elsewhere } : {}) };
}

const BUDGET_TAIL = 'When it is used up, the item is parked for a person to look at.';

const WORDS: Words[] = [
  // Install-wide.
  w(
    'pollSeconds',
    'Seconds between passes',
    'How often Jumpmaster looks for new issues, pull requests and finished drops. A smaller number reacts sooner and calls GitHub more often.',
    'number',
  ),
  w(
    'usage.throttleUtilization',
    'Slow down at this share of the usage limit',
    'When Claude usage reaches this share of the plan limit (0 to 1), no new drops start until it falls again. Lower keeps more headroom for your own use.',
    'number',
  ),
  w(
    'usage.probeJitterSeconds',
    'Random wait before a usage check (seconds)',
    'The lowest and highest number of seconds Jumpmaster waits at random before checking Claude usage, so checks do not all land at once.',
    'elsewhere',
    'Changed with jumpmaster ctl settings set or in the config file.',
  ),
  w(
    'usage.stopOnOverage',
    'Stop all work when usage credits are spent',
    'When a drop reports it is running on paid usage credits, all dispatch stops. Turned off, work goes on and only a briefing is raised.',
    'bool',
  ),
  w(
    'claude.plan',
    'Your Claude plan',
    'The Claude plan you declare (it is not detected). It decides which models and caps Jumpmaster may use.',
    'select',
  ),
  w(
    'claude.fableModel',
    'Fable model name',
    'The Fable model drops may use on a plan that includes it. Unset, no drop runs on Fable.',
    'text',
  ),
  w(
    'claude.fableWeeklyDropCap',
    'Fable drops per week (0 = no limit)',
    "The most drops that may run on Fable in any trailing seven days, applied only until Claude reports Fable's weekly limit. 0 means no count limit: Fable is paced by its reported weekly usage and the usage gate.",
    'number',
  ),
  w(
    'claude.fableMaxUtilization',
    'Fable stops at this share of its weekly limit',
    'Fable runs while Claude reports its weekly limit under this share (0 to 1). Lower keeps more of Fable for your own use; until Claude has reported it, the weekly drop cap applies instead.',
    'number',
  ),
  w(
    'claude.tokenCreatedAt',
    'Date the Claude token was made',
    'When claude setup-token made the token (YYYY-MM-DD). Such tokens last a year, and the doctor warns from day 330.',
    'text',
  ),
  w(
    'requireSignedImages',
    'Run only signed images',
    'Drops run only images whose signatures a stick has verified. Turning it off lets unsigned images run with your credentials, and a browser session cannot do that.',
    'bool',
  ),
  w(
    'mcp.enabled',
    'Turn on the MCP server',
    "Command's MCP server accepts tokens at /mcp after the next restart. Off, no MCP client can reach Jumpmaster.",
    'bool',
  ),
  w(
    'mcp.maxBodyBytes',
    'Largest MCP request (bytes)',
    'The largest request body the MCP server accepts. A bigger request is refused.',
    'number',
  ),
  w(
    'mcp.writesPerHour',
    'MCP writes per token per hour',
    'How many write calls one MCP token may make in any trailing hour before it is refused.',
    'number',
  ),
  w(
    'mcp.callsPerHour',
    'MCP calls per token per hour',
    'How many tool calls of any kind one MCP token may make in any trailing hour before it is refused.',
    'number',
  ),
  w(
    'mcp.maxOpenBriefings',
    'Open MCP briefings per zone',
    'How many briefings raised through MCP a zone may hold open at once. More are refused until some are closed.',
    'number',
  ),
  w(
    'chat.model',
    'Chat model',
    'The Claude model the crew chat answers with. Each new message uses the model set when it starts.',
    'text',
  ),
  w(
    'chat.maxConcurrentTurns',
    'Chat answers at once',
    'How many chat threads may be answered at the same time. More messages wait their turn.',
    'number',
  ),
  w(
    'chat.turnMinutes',
    'Longest chat answer (minutes)',
    'How long one chat answer may run before it is stopped and the message marked failed.',
    'number',
  ),
  w(
    'server.publicUrl',
    'Address other machines use',
    'The https address a new stick reaches this server at, to download the installer and enroll. Unset, no machine can be added.',
    'elsewhere',
    'Changed in the Other machines tab.',
  ),

  // A zone: the project.
  z_(
    'id',
    'Zone name',
    "The zone's key in addresses, the API and jumpmaster ctl. A different name is a new zone.",
    'elsewhere',
    'Fixed once the zone exists: remove the zone and add it again to change it.',
  ),
  z_(
    'repo',
    'GitHub repository',
    "The owner/name of the repository this zone works on. It can't change: remove the zone and add a new one.",
    'text',
  ),
  z_(
    'mode',
    'Starting mode',
    'Whether a new zone starts active, paused or observing. It is used only until an operator stores a mode.',
    'select',
  ),
  z_(
    'adoptPulls',
    'Open pull requests to take over',
    'Pull request numbers Jumpmaster takes over at cutover even without its marker. It may then merge them.',
    'elsewhere',
    'Changed in the Project section.',
  ),
  z_(
    'mergeMethod',
    'How pull requests are merged',
    'The merge method for agent pull requests. Squash is the only one the schema accepts.',
    'select',
  ),
  z_(
    'attribution',
    'Credit Claude as co-author',
    'Pull requests carry a Claude co-author trailer and attribution. Off, agents add none.',
    'bool',
  ),

  // A zone: labels.
  z_(
    'readyLabel',
    'Label that marks an issue ready',
    'Issues with this label are picked up for work. Renaming it to a label already on many issues dispatches them all.',
    'text',
  ),
  z_(
    'retryLabel',
    'Label that asks for a retry',
    'Putting this label on parked work asks Jumpmaster to try it again.',
    'text',
  ),
  z_(
    'triageLabel',
    'Label for issues that need triage',
    'A ready human issue that is not in the drop-ready format is moved to this label for triage. It must differ from the other labels.',
    'text',
  ),
  z_(
    'triagedLabel',
    'Label for issues triage has finished',
    'Put on an issue once triage has split it or found it is not agent work, replacing the triage label. It must differ from the other labels.',
    'text',
  ),
  z_(
    'triage.gate',
    'Send unformatted issues to triage',
    'With the crew on, a ready human issue that is not in the drop-ready format waits for triage. Off, every trusted ready issue is worked as it is.',
    'bool',
  ),

  // A zone: the stack.
  z_(
    'preset',
    'Stack preset',
    'A prebuilt image for a language stack, with the hosts it needs. A preset that adds hosts asks for confirmation.',
    'select',
  ),
  z_(
    'image',
    'Trooper image',
    'The image drops run in, when no preset is used. It decides what runs with your credentials, so a browser session cannot change it.',
    'text',
  ),
  z_(
    'gates',
    'Checks run before a push',
    'The commands each drop runs, like tests and lint, before its work is pushed. They run inside the drop without credentials.',
    'elsewhere',
    STACK,
  ),
  z_(
    'verification',
    'Reviewer verification steps',
    'Steps a reviewer drop runs to check a pull request, inside the drop like the gates.',
    'elsewhere',
    STACK,
  ),
  z_(
    'services',
    'Services beside each drop',
    'Images the stick runs beside every drop, such as a database. A new image asks for confirmation.',
    'elsewhere',
    STACK,
  ),
  z_(
    'limits.pids',
    'Most processes in a drop',
    'The most processes a drop container may run at once. Raising it gives builds more room.',
    'number',
  ),
  z_(
    'limits.memoryMb',
    'Memory for a drop (MB)',
    'The memory a drop container may use. Unset, the stick decides.',
    'number',
  ),
  z_(
    'limits.shmMb',
    'Shared memory for a drop (MB)',
    'The shared memory a drop container gets, which some browsers and databases need.',
    'number',
  ),
  z_(
    'gateCi',
    'Run checks with CI=true',
    'Gates run with CI=true, so installs keep to the lockfile. Off, an install may resolve afresh and run what it resolved.',
    'bool',
  ),
  z_(
    'trustPnpmBuildBlocking',
    "Trust pnpm's build-script blocking",
    'Accept new registry packages in the lockfile when the project pins pnpm 10 or later, which blocks install scripts. Turn on only when the image really runs that pnpm.',
    'bool',
  ),

  // A zone: egress.
  z_(
    'egress.mode',
    'Internet access control',
    'Off: drops reach any host. Monitor: what they reach is recorded. Enforce: only the listed hosts. Loosening it asks for confirmation.',
    'select',
  ),
  z_(
    'egress.allow',
    'Extra hosts drops may reach',
    'Hosts beyond the base and preset lists that drops may send data to. Each new host asks for confirmation.',
    'list',
  ),

  // A zone: merging.
  z_(
    'identity',
    'GitHub accounts used',
    'Two-bot uses an author and a reviewer account. Starter uses the author alone, which can then merge any green pull request.',
    'select',
  ),
  z_(
    'ciRequired',
    'CI must pass before a merge',
    'Agent pull requests merge only once CI passes. Off, they merge without CI.',
    'bool',
  ),
  z_(
    'requireBranchProtection',
    'Branch rules must be in place',
    'Agent pull requests merge only when branch protection is set up. Off, they merge without it.',
    'bool',
  ),
  z_(
    'authorMayBeAdmin',
    'The author account may be an admin',
    'Allows the author account to be a repository admin, as with a personal repository. An admin can bypass branch rules.',
    'bool',
  ),
  z_(
    'reviewReadToken',
    'Give review drops the read token',
    'Review drops get a read token, which a private repository needs. Off, they get no token.',
    'bool',
  ),
  z_(
    'protectedPaths',
    'Paths a person must review',
    'Changes to files matching these patterns never merge without a human review. Removing one asks for confirmation.',
    'list',
  ),
  z_(
    'privateKeyPaths',
    'Paths where private keys may be pushed',
    'Patterns where a pushed private key is allowed, for throwaway test keys. Empty, a private key is refused everywhere.',
    'list',
  ),
  z_(
    'overrideApprovers',
    'People who may override check changes',
    'Logins whose approval lets a change to a gate script or tool through. Protected paths are never overridden.',
    'list',
  ),
  z_(
    'gateSecrets',
    'Secrets given to checks',
    "Names of secrets passed to gate steps. Any pull request's gate code can read them, so each new one asks for confirmation.",
    'list',
  ),
  z_(
    'botLogins',
    'Accounts treated as bots',
    "Logins whose comments are ignored as a bot's, and whose ready issues count as crew-filed.",
    'list',
  ),
  z_(
    'authorLoginAliases',
    'Other logins of the author account',
    "Logins whose pull requests on agent branches are adopted as the author's, such as an old bot's login.",
    'list',
  ),
  z_(
    'requireSignedImages',
    'Run only signed images in this zone',
    "Drops of this zone run only signed images. Unset, the install's setting applies; a zone can't be weaker than the install.",
    'bool',
  ),
  z_(
    'githubApp.repositoryId',
    'GitHub App repository id',
    "The numeric id of the repository app tokens are minted for. It is checked against the zone's repository before any token is minted.",
    'number',
  ),
  z_(
    'githubApp.installations.author',
    'Author app installation id',
    'The installation id author tokens are minted from. Changing it asks for confirmation.',
    'number',
  ),
  z_(
    'githubApp.installations.reviewer',
    'Reviewer app installation id',
    'The installation id reviewer tokens are minted from. Changing it asks for confirmation.',
    'number',
  ),

  // A zone: pace.
  z_(
    'maxConcurrentImplement',
    'Implement drops at once',
    'How many implement drops may run at the same time in this zone. More finishes sooner and uses more of the plan.',
    'number',
  ),
  z_(
    'maxOpenPrs',
    'Most open pull requests',
    'No new implement drop starts while the zone has this many open pull requests. Unset, there is no cap.',
    'number',
  ),
  z_(
    'mergeReservationMinutes',
    'Minutes the oldest approval holds the merge',
    'The oldest approved pull request keeps the next merge for this long, so younger ones wait. 0 turns it off.',
    'number',
  ),
  z_(
    'ciDeadlineMinutes',
    'Minutes to wait for CI',
    'How long to wait for CI on a pull request before giving up on it. A missing CI never merges.',
    'number',
  ),
  z_(
    'outboxDeadlineMinutes',
    'Minutes a GitHub write may stay unknown',
    'How long a write to GitHub may stay unconfirmed before it is reported. Unset, the CI deadline is used.',
    'number',
  ),

  // A zone: models.
  z_(
    'model',
    'Model drops run',
    'The Claude model drops in this zone run, unless a role has its own. It may not name Fable.',
    'text',
  ),
  z_(
    'models',
    'Model for each role',
    'A model for each drop role, such as implement or review, in place of the zone model.',
    'elsewhere',
    ADVANCED,
  ),
  z_(
    'maxTurns',
    'Most turns in a drop',
    'The most turns an agent takes in one drop before it stops. More lets hard work finish and spends more.',
    'number',
  ),

  // A zone: retries.
  z_(
    'budgets.maxHeal',
    'Tries to fix a failing pull request',
    `How many times a drop may try to fix a pull request whose checks fail. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxResolve',
    'Tries to resolve a conflict in a row',
    `How many times in a row a drop may try to resolve a merge conflict. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxResolveTotal',
    'Tries to resolve conflicts in all',
    `How many conflict resolutions one item may have in all. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxResume',
    'Times an interrupted drop resumes',
    `How many times a drop that stopped part way may be resumed. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxReviewRepeat',
    'Reviews asking for the same change',
    `How many times a review may repeat the same request. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxNoChange',
    'Drops that change nothing',
    `How many drops in a row may finish without changing anything. ${BUDGET_TAIL}`,
    'number',
  ),
  z_(
    'budgets.maxBaseSync',
    'Clean catch-ups with the main branch',
    `How many times an approved pull request may merge in the main branch cleanly and keep its approval. ${BUDGET_TAIL}`,
    'number',
  ),

  // A zone: transcripts.
  z_(
    'transcripts.retainDays',
    'Days to keep drop transcripts',
    "A finished drop's events are pruned after this many days; 0 keeps them forever. The drop's result is always kept.",
    'number',
  ),
  z_(
    'transcripts.archive',
    'Archive transcripts before pruning',
    'Pruned transcripts are kept as a compressed file first. Off, pruning deletes them for good.',
    'bool',
  ),

  // A zone: the crew.
  z_(
    'crew.enabled',
    'Turn on the crew',
    'The crew reads the goal file and files issues of its own. They wait under the staged label until Command promotes them.',
    'bool',
  ),
  z_(
    'crew.goalPath',
    'Goal file the crew reads',
    'The file in the repository the crew reads its objectives from. It must be a protected path, so no drop can change it.',
    'text',
  ),
  z_(
    'crew.cycleMinutes',
    'Minutes between crew passes',
    'How often the crew looks at the goal and the repository. Smaller means more crew drops.',
    'number',
  ),
  z_(
    'crew.maxDropsPerDay',
    'Crew drops per day (0 = no limit)',
    'The most crew drops (planning, refutes, triage, diagnosis) in a trailing 24 hours. 0 means no limit: Claude usage paces the crew instead, and Jumpmaster pauses when the subscription runs out and tries again after it resets.',
    'number',
  ),
  z_(
    'crew.stagedLabel',
    'Label for crew issues waiting',
    'Issues the crew files wait under this label until Command promotes them. It must differ from the ready label.',
    'text',
  ),
  z_(
    'crew.maxStaged',
    'Most crew issues waiting',
    'The crew files no more issues while this many wait under the staged label.',
    'number',
  ),
  z_(
    'crew.refutePromotes',
    'A crew refute may promote an issue',
    'Lets a crew refute promote a staged issue to ready, so agent-filed work is dispatched. It still waits one pass with a Reject option.',
    'bool',
  ),
  z_(
    'crew.maxRefute',
    'Crew refutes of one issue',
    'How many times the crew may refute one staged issue before it is left for Command.',
    'number',
  ),
  z_(
    'crew.maxTriage',
    'Triage tries on one issue',
    'How many triage attempts one issue text gets before it is put to Command as failed.',
    'number',
  ),
  z_(
    'crew.arbiter',
    'Let a Fable arbiter settle disagreements',
    'When reviewers and the crew keep disagreeing, a Fable agent rules on the evidence and acts on its ruling. Turned off, every such case is put to you, as before.',
    'bool',
  ),
];

/** Every setting, in plain words, with its group. */
export const FLAGS: readonly FlagEntry[] = WORDS.map((e) => ({
  ...e,
  group: groupOf(keyOf(e.path), guardOf(e.path)),
}));

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The key is present in the document itself, at every level. */
function present(doc: Record<string, unknown>, key: string): boolean {
  let v: unknown = doc;
  for (const k of key.split('.')) {
    if (!isPlain(v) || !Object.hasOwn(v, k)) return false;
    v = v[k];
  }
  return true;
}

type Check = { check?: string; format?: string; value?: number; inclusive?: boolean };

/** The bounds of a number schema, read from its checks. */
function bounds(s: z.ZodType): Pick<FlagRow, 'min' | 'max' | 'integer'> {
  const checks = ((defOf(s).checks as { _zod: { def: Check } }[] | undefined) ?? []).map(
    (c) => c._zod.def,
  );
  const integer = checks.some((c) => c.check === 'number_format' && /int/.test(c.format ?? ''));
  const out: Pick<FlagRow, 'min' | 'max' | 'integer'> = integer ? { integer } : {};
  for (const c of checks) {
    if (c.value === undefined) continue;
    if (c.check === 'greater_than') {
      // `.positive()` is exclusive: an integer starts at the next one; a non-integer's control
      // starts at the bound and the server still refuses it.
      out.min = c.inclusive || !integer ? c.value : Math.floor(c.value) + 1;
    } else if (c.check === 'less_than') {
      out.max = c.inclusive || !integer ? c.value : Math.ceil(c.value) - 1;
    }
  }
  return out;
}

/** The values of an enum or literal schema. */
function optionsOf(s: z.ZodType): string[] {
  const def = defOf(s);
  if (def.type === 'literal') return (def.values as unknown[]).map(String);
  return Object.values(def.entries as Record<string, string>);
}

/** Paths a zone needs and has no default for: their default is undefined. */
const ZONE_REQUIRED = ['id', 'repo', 'gates'];

/**
 * The rows of a scope, from its document as stored (unparsed): a zone (`doc`, with the install
 * document for its fallbacks), or the install (`doc` and `install` the same document). Ordered by
 * group, then by label.
 */
export function flagRows(
  scope: FlagScope,
  doc: Record<string, unknown>,
  install: Record<string, unknown>,
): FlagRow[] {
  const leaves = schemaLeaves();
  const parsed = (
    scope === 'zone' ? DropZoneObject.parse(doc) : EditableSchema.parse(doc)
  ) as Record<string, unknown>;
  const minimal = (
    scope === 'zone'
      ? DropZoneObject.parse({ id: 'z', repo: 'o/r', gates: [] })
      : EditableSchema.parse({})
  ) as Record<string, unknown>;
  const rows = FLAGS.filter((e) => scopeOf(e.path) === scope).map((entry): FlagRow => {
    const key = keyOf(entry.path);
    const leaf = leaves.get(entry.path) as z.ZodType;
    const noDefault = scope === 'zone' && ZONE_REQUIRED.includes(key);
    return {
      entry,
      scope,
      key,
      value: effective(parsed, key, install),
      defaultValue: noDefault ? undefined : effective(minimal, key, install),
      explicit: present(doc, key),
      guard: guardOf(entry.path),
      ...(entry.kind === 'select' ? { options: optionsOf(leaf) } : {}),
      ...(entry.kind === 'number' ? bounds(leaf) : {}),
    };
  });
  return rows.sort(
    (a, b) =>
      GROUPS.indexOf(a.entry.group) - GROUPS.indexOf(b.entry.group) ||
      a.entry.label.localeCompare(b.entry.label),
  );
}
