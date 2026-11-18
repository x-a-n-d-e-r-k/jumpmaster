import { createHash } from 'node:crypto';
import { containsSecret } from '@jumpmaster/protocol';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { getDropZoneDefaultBranch, getZoneMode, isKilled } from './db/repo.js';
import { gitBlobSha } from './forge/github.js';
import { getGoals, parseGoals } from './goals.js';
import { type ForgePair, opMarker } from './outbox.js';

/**
 * Goal changes (#336 crew chat, #362): the only path that writes a zone's goal file. The chat (or
 * the crew lead) proposes a new GOAL.md text; the next active pass commits it, and nothing else,
 * on `jm/goal-change-<id>` as the author identity and opens one PR. Its commit message, title and
 * body are the server's fixed words: the proposed text goes into the file and nowhere else. It is
 * merged later, only after the owner confirms it in the browser (`advanceGoalChanges`).
 */

/** The branch a goal change is committed on. Never an agent branch (`agent/issue-`). */
export const GOAL_CHANGE_BRANCH = (id: number): string => `jm/goal-change-${id}`;

/** The longest goal text a change may propose, in characters. */
export const GOAL_TEXT_MAX = 64_000;

export type GoalChangeSource = 'chat' | 'crew';
export type GoalChangeState = 'proposed' | 'open' | 'confirmed' | 'merged' | 'refused' | 'closed';

export type GoalChange = {
  id: number;
  zoneId: string;
  source: GoalChangeSource;
  sourceRef: string | null;
  text: string;
  textSha256: string;
  baseSha: string | null;
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  state: GoalChangeState;
  confirmedSha: string | null;
  confirmedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const COLS = `id, zone_id AS zoneId, source, source_ref AS sourceRef, text, text_sha256 AS textSha256,
  base_sha AS baseSha, branch, pr_number AS prNumber, head_sha AS headSha, state,
  confirmed_sha AS confirmedSha, confirmed_at AS confirmedAt, error, created_at AS createdAt,
  updated_at AS updatedAt`;

export function getGoalChange(db: Db, id: number): GoalChange | undefined {
  return db.prepare(`SELECT ${COLS} FROM goal_changes WHERE id = ?`).get(id) as
    | GoalChange
    | undefined;
}

/** A zone's goal changes, oldest first; only those in `state` when given. */
export function listGoalChanges(db: Db, zoneId: string, state?: GoalChangeState): GoalChange[] {
  return (
    state === undefined
      ? db.prepare(`SELECT ${COLS} FROM goal_changes WHERE zone_id = ? ORDER BY id`).all(zoneId)
      : db
          .prepare(`SELECT ${COLS} FROM goal_changes WHERE zone_id = ? AND state = ? ORDER BY id`)
          .all(zoneId, state)
  ) as GoalChange[];
}

type Patch = Partial<
  Pick<GoalChange, 'baseSha' | 'branch' | 'prNumber' | 'headSha' | 'state' | 'error'>
>;

const COLUMN: Record<keyof Patch, string> = {
  baseSha: 'base_sha',
  branch: 'branch',
  prNumber: 'pr_number',
  headSha: 'head_sha',
  state: 'state',
  error: 'error',
};

function update(db: Db, id: number, patch: Patch, now: Date): void {
  const keys = Object.keys(patch) as (keyof Patch)[];
  const sets = keys.map((k) => `${COLUMN[k]} = @${k}`);
  db.prepare(
    `UPDATE goal_changes SET ${[...sets, 'updated_at = @at'].join(', ')} WHERE id = @id`,
  ).run({ ...patch, at: now.toISOString(), id });
}

/**
 * Why a goal text may not be proposed, in the server's own words (never quoting the text), or
 * null when it may: it must parse as goals, be at most `GOAL_TEXT_MAX` characters and hold no
 * token or secret.
 */
export function goalTextProblem(text: string, secrets: string[] = []): string | null {
  if (text.length > GOAL_TEXT_MAX) {
    return `the goals text is longer than ${GOAL_TEXT_MAX} characters`;
  }
  if (containsSecret(text, secrets)) return 'the goals text contains a token or secret';
  const parsed = parseGoals(text);
  if (!parsed.ok) return `the text does not parse as goals: ${parsed.error}`;
  return null;
}

/** Records a proposed change to the zone's goal file. Writes nothing to the forge. */
export function proposeGoalChange(
  db: Db,
  zone: DropZoneConfig,
  o: { text: string; source: GoalChangeSource; sourceRef: string },
  now: Date,
): { ok: true; id: number } | { ok: false; error: string } {
  const problem = goalTextProblem(o.text);
  if (problem) return { ok: false, error: problem };
  const at = now.toISOString();
  const row = db
    .prepare(
      `INSERT INTO goal_changes (zone_id, source, source_ref, text, text_sha256, state,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?) RETURNING id`,
    )
    .get(
      zone.id,
      o.source,
      o.sourceRef,
      o.text,
      createHash('sha256').update(o.text).digest('hex'),
      at,
      at,
    ) as { id: number };
  return { ok: true, id: row.id };
}

/** The goal-change commit's message: fixed words, with no text of the proposal's. */
export const goalChangeCommitMessage = (goalPath: string, id: number): string =>
  `Update ${goalPath} (goal change ${id}, confirmed in Jumpmaster)`;

/** The goal-change PR's title: fixed words. */
export const goalChangePullTitle = (goalPath: string, id: number): string =>
  `Update ${goalPath} (goal change ${id})`;

/** The goal-change PR's body: fixed words, ending with the change's op marker. */
export const goalChangePullBody = (goalPath: string, id: number): string =>
  [
    `This pull request changes ${goalPath} only, as proposed in Jumpmaster (goal change ${id}).`,
    '',
    'Jumpmaster merges it only after the owner confirms it in the browser, at the commit they confirmed.',
    '',
    opMarker(`goal:${id}`),
  ].join('\n');

/** A forge error as the server's own words: its HTTP status, never its message. */
function failure(step: string, err: unknown): string {
  const status = (err as { status?: unknown } | null)?.status;
  return `could not ${step} (${typeof status === 'number' ? `HTTP ${status}` : 'no answer'})`;
}

/**
 * Opens a proposed goal change as a PR: makes `jm/goal-change-<id>` from the default branch,
 * commits the proposed text as the zone's goal file (and nothing else) as the author identity, and
 * finds or opens its PR. Each step is idempotent, so a pass that failed partway is completed by
 * the next. `retry` leaves the change proposed (with an error when a forge call failed); under the
 * kill switch, or while the zone is not active, it writes nothing.
 */
export async function openGoalChange(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  id: number,
  now: Date,
): Promise<'open' | 'retry' | 'refused'> {
  const row = getGoalChange(db, id);
  if (!row || row.zoneId !== zone.id) return 'refused';
  if (row.state === 'open' || row.state === 'confirmed' || row.state === 'merged') return 'open';
  if (row.state !== 'proposed') return 'refused';
  if (isKilled(db) || getZoneMode(db, zone.id, zone.mode) !== 'active') return 'retry';
  const refuse = (error: string) => {
    update(db, id, { state: 'refused', error }, now);
    return 'refused' as const;
  };
  const problem = goalTextProblem(row.text);
  if (problem) return refuse(problem);

  const author = forges.author;
  const path = zone.crew.goalPath;
  const branch = GOAL_CHANGE_BRANCH(id);
  let step = 'read the default branch';
  try {
    const defaultBranch =
      getDropZoneDefaultBranch(db, zone.id) ?? (await author.getDefaultBranch());
    let base = row.baseSha;
    if (base === null) {
      base = await author.branchSha(defaultBranch);
      if (base === null) throw new Error('no default branch');
      update(db, id, { baseSha: base, branch }, now);
    }
    step = 'make the branch';
    let head = await author.branchSha(branch);
    if (head === null) {
      await author.createBranch(branch, base);
      head = base;
    }
    step = 'commit the goal file';
    const onBranch = await author.getFileAt(head, path);
    if (onBranch !== row.text) {
      // Only the server commits here, once, on the base: a branch that moved elsewhere is not ours.
      if (head !== base) return refuse(`${branch} holds another change; propose it again`);
      const put = await author.putFile({
        branch,
        path,
        content: row.text,
        message: goalChangeCommitMessage(path, id),
        expectBlobSha: onBranch === null ? null : gitBlobSha(onBranch),
      });
      head = put.commitSha;
    } else if (head === base) {
      return refuse(`the proposed text is what ${path} already says`);
    }
    update(db, id, { headSha: head }, now);
    step = 'open the pull request';
    const pr = await author.findOrCreatePullRequest({
      head: branch,
      base: defaultBranch,
      title: goalChangePullTitle(path, id),
      body: goalChangePullBody(path, id),
    });
    update(db, id, { state: 'open', prNumber: pr.number, error: null }, now);
    return 'open';
  } catch (err) {
    update(db, id, { error: failure(step, err) }, now);
    return 'retry';
  }
}

/** Opens every proposed goal change of the zone (a reconcile pass, while the zone is active). */
export async function openGoalChanges(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<number> {
  let opened = 0;
  for (const c of listGoalChanges(db, zone.id, 'proposed')) {
    if ((await openGoalChange(db, forges, zone, c.id, now)) === 'open') opened++;
  }
  return opened;
}

/** Lines of `a` and `b` as a line diff: `  ` kept, `- ` removed, `+ ` added. */
export function lineDiff(a: string, b: string): string[] {
  const x = a.replace(/\r\n?/g, '\n').split('\n');
  const y = b.replace(/\r\n?/g, '\n').split('\n');
  // Past this many cells the table is too big to be worth it: everything removed, then added.
  if (x.length * y.length > 4_000_000) {
    return [...x.map((l) => `- ${l}`), ...y.map((l) => `+ ${l}`)];
  }
  const n = x.length;
  const m = y.length;
  // lcs[i][j]: the longest common subsequence of x[i..] and y[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        x[i] === y[j]
          ? (below[j + 1] as number) + 1
          : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(`  ${x[i]}`);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push(`- ${x[i]}`);
      i++;
    } else {
      out.push(`+ ${y[j]}`);
      j++;
    }
  }
  for (; i < n; i++) out.push(`- ${x[i]}`);
  for (; j < m; j++) out.push(`+ ${y[j]}`);
  return out;
}

/**
 * The change's diff for its card, computed on the server from the stored base text (the zone's
 * goal file as last read) and the proposed text: only the lines removed and added.
 */
export function goalChangeDiff(db: Db, id: number): string {
  const c = getGoalChange(db, id);
  if (!c) return '';
  const base = getGoals(db, c.zoneId)?.raw ?? '';
  return lineDiff(base, c.text)
    .filter((l) => !l.startsWith('  '))
    .join('\n');
}
