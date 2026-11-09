import { createHash } from 'node:crypto';
import { containsSecret } from '@jumpmaster/protocol';
import { z } from 'zod';
import type { DropZoneConfig } from './config.js';
import {
  type CrewIssue,
  getCrewIssue,
  INTAKE_SOURCE,
  insertCrewIssue,
  listCrewIssues,
  setCrewIssue,
} from './crew/store.js';
import type { Db } from './db/open.js';
import { getOutbox, getZoneMode, isKilled } from './db/repo.js';
import {
  type CreateIssuePayload,
  type ForgePair,
  type OpResult,
  opKeys,
  runOp,
  sanitizeForgeText,
} from './outbox.js';

/**
 * The minimal in-app intake: a `GOAL.md` stub rendered for Command to commit by pull request, and
 * a first issue filed ready through the outbox. Only Command's own form fields, behind the operator
 * token, reach the forge as a ready issue.
 */

export const INTAKE_TEMPLATES = ['existing', 'idea', 'partial'] as const;
export type IntakeTemplate = (typeof INTAKE_TEMPLATES)[number];

/** The objective every intake issue is filed under: the stub's first, and current, objective. */
export const INTAKE_OBJECTIVE = '1';

/** The issue sections, in order (§8.3); the intake skills' template uses the same headings. */
export const ISSUE_SPEC_HEADINGS = [
  'Context',
  'Acceptance criteria',
  'Required tests',
  'Out of scope',
] as const;

/** Filings one zone may make in a trailing hour (counted in `crew_issues`). */
export const INTAKE_PER_HOUR = 10;

const item = (max: number) => z.string().trim().min(1).max(max);

export const GoalStubSchema = z.strictObject({
  template: z.enum(INTAKE_TEMPLATES),
  lighthouse: item(2000),
  objectives: z.array(item(200)).min(1).max(5),
  nonGoals: z.array(item(300)).max(10).optional(),
  constraints: z.array(item(300)).max(10).optional(),
});
export type GoalStubInput = Omit<z.infer<typeof GoalStubSchema>, 'template'>;

export const IssueSpecSchema = z.strictObject({
  title: item(120),
  context: item(4000),
  acceptance: z.array(item(300)).min(1).max(15),
  tests: z.array(item(300)).min(1).max(10),
  outOfScope: z.array(item(300)).max(10).optional(),
});
export type IssueSpec = z.infer<typeof IssueSpecSchema>;

export const IntakeIssueSchema = IssueSpecSchema.extend({ idempotencyKey: z.uuid() });

/** One line: every run of whitespace (line breaks included) folded to a space. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Free text as markdown that adds no structure: a line that would open a heading, a fence or a
 * list item is escaped, so it reads as text and no section boundary moves.
 */
const plainBlock = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (/^\s*(#|`{3}|~{3}|[-*+]\s|\d+[.)]\s)/.test(l) ? `\\${l}` : l))
    .join('\n')
    .trim();

/** A list item's text, which may not start another structure either. */
const listText = (s: string): string => {
  const line = oneLine(s);
  return /^(#|`{3}|~{3}|[-*+]\s|\[[ xX]\])/.test(line) ? `\\${line}` : line;
};

const STARTING_POINT: Record<IntakeTemplate, string> = {
  existing:
    'An existing codebase with its own conventions. Agents follow what is already there, and each objective builds on code that works today.',
  idea: 'A new project, starting from an idea. The first objectives lay down the skeleton, the gates and CI before any feature.',
  partial:
    'A partly built project. The first objectives finish or repair what is half done before anything new starts.',
};

/**
 * A `GOAL.md` stub. Whatever the answers hold, it parses with `parseGoals`, with the first
 * objective current: objectives are single-line unchecked items, and free text cannot open a
 * section, a fence or a list.
 */
export function renderGoalStub(t: IntakeTemplate, a: GoalStubInput): string {
  const objectives = a.objectives.map((o, i) => `- [ ] ${listText(o) || `Objective ${i + 1}`}`);
  const list = (items: string[] | undefined) =>
    items && items.length > 0 ? items.map((s) => `- ${listText(s)}`).join('\n') : '- None yet.';
  return [
    '# Goal',
    '',
    '## Lighthouse',
    '',
    plainBlock(a.lighthouse) || 'Not stated yet.',
    '',
    '## Starting point',
    '',
    STARTING_POINT[t],
    '',
    '## Objectives',
    '',
    ...objectives,
    '',
    '## Non-goals',
    '',
    list(a.nonGoals),
    '',
    '## Constraints',
    '',
    list(a.constraints),
    '',
  ].join('\n');
}

/** An agent-ready issue body (§8.3): context, a checklist of criteria, tests, and what is out. */
export function renderIssueSpec(i: Omit<IssueSpec, 'title'> & { title?: string }): string {
  const [context, criteria, tests, out] = ISSUE_SPEC_HEADINGS;
  const outOfScope = i.outOfScope ?? [];
  return [
    `## ${context}`,
    '',
    plainBlock(i.context),
    '',
    `## ${criteria}`,
    '',
    ...i.acceptance.map((c) => `- [ ] ${listText(c)}`),
    '',
    `## ${tests}`,
    '',
    ...i.tests.map((c) => `- ${listText(c)}`),
    '',
    `## ${out}`,
    '',
    ...(outOfScope.length > 0 ? outOfScope.map((c) => `- ${listText(c)}`) : ['Nothing stated.']),
    '',
  ].join('\n');
}

/** The crew-issue key for a submission: `intake-` and 12 hex of sha256 of its idempotency key. */
export const intakeKey = (idempotencyKey: string): string =>
  `intake-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12)}`;

type KeyStore = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

/**
 * The page's idempotency key for one submission of `content`: the stored one while the server has
 * not confirmed this content, else a fresh one. Self-contained: the page embeds its source.
 */
export function submitKey(store: KeyStore, content: string, mint: () => string): string {
  let h = 0x811c9dc5;
  let g = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
    g = Math.imul(g ^ c, 0x5bd1e995) >>> 0;
  }
  const slot = `jm-intake:${h.toString(16)}${g.toString(16)}:${content.length}`;
  const kept = store.getItem(slot);
  if (kept) return kept;
  const key = mint();
  store.setItem(slot, key);
  return key;
}

/** Forgets the key for `content` once the server confirmed it. Self-contained, as above. */
export function forgetSubmitKey(store: KeyStore, content: string): void {
  let h = 0x811c9dc5;
  let g = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
    g = Math.imul(g ^ c, 0x5bd1e995) >>> 0;
  }
  store.removeItem(`jm-intake:${h.toString(16)}${g.toString(16)}:${content.length}`);
}

/** Intake filings the zone made in the trailing hour, counted in the database (restarts keep it). */
function filingsLastHour(db: Db, zoneId: string, now: Date): number {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  return (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM crew_issues WHERE zone_id = ? AND source = ? AND created_at > ?',
      )
      .get(zoneId, INTAKE_SOURCE, since) as { n: number }
  ).n;
}

/** How long a `filing` intake row may lack its outbox row before it is given up as failed. */
export const INTAKE_ORPHAN_MS = 10 * 60_000;

export type IntakeOutcome =
  | { status: 201 | 200; key: string; number: number; state: 'promoted'; repeated?: true }
  | { status: 202; key: string; state: 'filing' }
  | { status: 200; key: string; state: string; number: number | null; repeated: true }
  | { status: 400 | 409 | 429 | 502; error: string };

const opKeyOf = (zoneId: string, key: string): string =>
  opKeys.issue(zoneId, INTAKE_OBJECTIVE, key);

/** Moves an intake row on from the create op's outcome: done → promoted, failed → failed. */
function settle(db: Db, row: CrewIssue, r: OpResult, now: Date): CrewIssue {
  const number = (r.result as { number?: unknown } | undefined)?.number;
  if (r.state === 'done' && typeof number === 'number')
    setCrewIssue(db, row.id, { state: 'promoted', number }, now);
  else if (r.state === 'failed') setCrewIssue(db, row.id, { state: 'failed' }, now);
  return getCrewIssue(db, row.id) ?? row;
}

function outcome(row: CrewIssue, created: boolean, error?: string): IntakeOutcome {
  if (row.state === 'promoted' && row.number !== null)
    return created
      ? { status: 201, key: row.key, number: row.number, state: 'promoted' }
      : { status: 200, key: row.key, number: row.number, state: 'promoted', repeated: true };
  if (row.state === 'filing') return { status: 202, key: row.key, state: 'filing' };
  if (row.state === 'failed')
    return {
      status: 502,
      error: `GitHub refused the issue, so nothing was filed${error ? ` (${error.split('\n')[0]?.slice(0, 200)})` : ''}. Change what it refused and submit again: the page starts a fresh submission.`,
    };
  return { status: 200, key: row.key, state: row.state, number: row.number, repeated: true };
}

/**
 * Files Command's first issue as ready, once per idempotency key. A repeat returns the existing
 * row (finishing an unresolved create by read-back, never a second create).
 */
export async function fileIntakeIssue(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  input: z.infer<typeof IntakeIssueSchema>,
  secrets: string[],
  now: Date,
): Promise<IntakeOutcome> {
  // A secret never reaches the database or the forge: refused before anything is stored, as the
  // MCP write path refuses it.
  const { idempotencyKey: _key, ...text } = input;
  if (containsSecret(JSON.stringify(text), secrets))
    return {
      status: 400,
      error: 'the issue contains a token or secret: remove it and submit again',
    };
  const key = intakeKey(input.idempotencyKey);
  const existing = listCrewIssues(db, zone.id).find((r) => r.key === key);
  if (existing && existing.source !== INTAKE_SOURCE)
    return { status: 409, error: 'that idempotency key is in use; submit again for a fresh one' };
  if (existing && existing.state !== 'filing') return outcome(existing, false);
  if (isKilled(db))
    return { status: 409, error: 'the kill switch is engaged: nothing is filed until unkill' };
  const mode = getZoneMode(db, zone.id, zone.mode);
  if (mode !== 'active')
    return {
      status: 409,
      error: `zone ${zone.id} is ${mode === 'observe' ? 'in observe mode' : mode}: nothing is filed until it is active again`,
    };
  let row = existing;
  if (!row) {
    if (filingsLastHour(db, zone.id, now) >= INTAKE_PER_HOUR)
      return {
        status: 429,
        error: `at most ${INTAKE_PER_HOUR} intake issues per zone per hour; try again later`,
      };
    const id = insertCrewIssue(db, {
      zoneId: zone.id,
      key,
      source: INTAKE_SOURCE,
      objective: INTAKE_OBJECTIVE,
      title: input.title,
      body: renderIssueSpec(input),
      priority: null,
      createdAt: now.toISOString(),
    });
    row = getCrewIssue(db, id);
    if (!row) throw new Error(`intake row ${id} vanished`);
  }
  // Command's own text, still made safe to post: no secret, no forged marker, no mention.
  const payload: CreateIssuePayload = {
    title: sanitizeForgeText(oneLine(row.title), secrets, 120),
    body: sanitizeForgeText(row.body, secrets),
    labels: [zone.readyLabel],
    since: row.createdAt,
  };
  let r: OpResult;
  try {
    r = await runOp(
      db,
      forges,
      {
        kind: 'create_issue',
        opKey: opKeyOf(zone.id, key),
        zoneId: zone.id,
        itemId: null,
        payload,
      },
      now,
    );
  } catch (e) {
    return { status: 409, error: (e as Error).message };
  }
  return outcome(settle(db, row, r, now), existing === undefined, r.error);
}

/**
 * Confirms intake rows whose create resolved after their request (by a repeat, or reconcile's
 * read-back): done → promoted, so the next sync admits the issue; failed → failed. Reads only.
 */
export function confirmIntakeIssues(db: Db, zoneId: string, now: Date): number {
  let moved = 0;
  for (const row of listCrewIssues(db, zoneId, ['filing'])) {
    if (row.source !== INTAKE_SOURCE) continue;
    const op = getOutbox(db, opKeyOf(zoneId, row.key));
    if (!op) {
      // No outbox row: the request stopped before `runOp` inserted one (a crash, or a mode change
      // in between), so no forge call was made. Past a grace period it is given up as failed, so
      // it holds no slot and the page can submit afresh.
      if (now.getTime() - Date.parse(row.createdAt) >= INTAKE_ORPHAN_MS) {
        setCrewIssue(db, row.id, { state: 'failed' }, now);
        moved++;
      }
      continue;
    }
    if (op.state !== 'done' && op.state !== 'failed') continue;
    let result: unknown;
    try {
      result = op.resultJson == null ? undefined : JSON.parse(op.resultJson);
    } catch {
      result = undefined;
    }
    const before = row.state;
    if (settle(db, row, { state: op.state, result }, now).state !== before) moved++;
  }
  return moved;
}
