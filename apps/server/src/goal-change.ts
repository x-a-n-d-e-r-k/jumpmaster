import { createHash } from 'node:crypto';
import { containsSecret } from '@jumpmaster/protocol';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { getDropZoneDefaultBranch, getZoneMode, isKilled } from './db/repo.js';
import { branchProtectionProblems } from './flow/guards.js';
import { type ChecksFacts, gitBlobSha } from './forge/github.js';
import { getGoals, parseGoals } from './goals.js';
import {
  type ForgePair,
  type MergePayload,
  opKeys,
  opMarker,
  type PostReviewPayload,
  runOp,
} from './outbox.js';

/**
 * Goal changes (#336 crew chat, #362): the only path that writes a zone's goal file. The chat (or
 * the crew lead) proposes a new GOAL.md text; the next active pass commits it, and nothing else,
 * on `jm/goal-change-<id>` as the author identity and opens one PR. Its commit message, title and
 * body are the server's fixed words: the proposed text goes into the file and nowhere else. It is
 * merged later, only after the owner confirms it in the browser (`advanceGoalChanges`).
 */

/** The branch a goal change is committed on. Never an agent branch (`agent/issue-`). */
export const GOAL_CHANGE_BRANCH = (id: number): string => `jm/goal-change-${id}`;

/** What a `goal_change` briefing is about: `goal-change:<id>`. */
export const GOAL_CHANGE_PREFIX = 'goal-change:';

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

/**
 * Where a crew proposal still `proposed` stands with Command (#754): `awaiting_ruling` while an
 * open `goal-change:<id>` briefing asks for it; `opening` once Command ruled "Open the PR" and that
 * ruling waits to be applied (kill switch, zone not active, forge error); `unbriefed` otherwise
 * (its briefing dismissed or withdrawn, or a "leave the goals" ruling about to close it): nothing
 * is in front of Command and nothing opens it.
 */
export type CrewProposalStanding = 'awaiting_ruling' | 'opening' | 'unbriefed';

/** A goal change with, for a crew proposal still `proposed`, where it stands with Command. */
export type GoalChangeWithStanding = GoalChange & { standing?: CrewProposalStanding };

export function crewProposalStanding(db: Db, zoneId: string, id: number): CrewProposalStanding {
  const subject = `${GOAL_CHANGE_PREFIX}${id}`;
  const open = db
    .prepare(`SELECT 1 FROM briefings WHERE zone_id = ? AND subject = ? AND state = 'open' LIMIT 1`)
    .get(zoneId, subject);
  if (open) return 'awaiting_ruling';
  const opening = db
    .prepare(
      `SELECT 1 FROM rulings r JOIN briefings b ON b.id = r.briefing_id
       WHERE b.zone_id = ? AND b.subject = ? AND r.choice_effect = 'open_goal_change'
         AND r.applied_at IS NULL AND r.apply_error IS NULL LIMIT 1`,
    )
    .get(zoneId, subject);
  return opening ? 'opening' : 'unbriefed';
}

/** A zone's goal changes, oldest first, each crew proposal with its standing. */
export function listGoalChangesWithStanding(db: Db, zoneId: string): GoalChangeWithStanding[] {
  return listGoalChanges(db, zoneId).map((c) =>
    c.source === 'crew' && c.state === 'proposed'
      ? { ...c, standing: crewProposalStanding(db, zoneId, c.id) }
      : c,
  );
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

/** Closes a goal change still proposed (the owner declined to open it). Idempotent. */
export function closeProposedGoalChange(db: Db, zoneId: string, id: number, now: Date): void {
  const c = getGoalChange(db, id);
  if (c?.zoneId === zoneId && c.state === 'proposed') update(db, id, { state: 'closed' }, now);
}

/**
 * Opens every goal change of the zone proposed in the chat (a reconcile pass, while the zone is
 * active). A crew proposal opens only through its briefing's ruling (`open_goal_change`).
 */
export async function openGoalChanges(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<number> {
  let opened = 0;
  for (const c of listGoalChanges(db, zone.id, 'proposed')) {
    if (c.source !== 'chat') continue;
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

/**
 * Records the owner's confirmation of an open goal change at `sha` (the confirm page, after the
 * passphrase and after reading the PR head). One change is confirmed once: false when it is not
 * open any more, or `sha` is not the commit the server made for it.
 */
export function confirmGoalChange(db: Db, id: number, sha: string, now: Date): boolean {
  const at = now.toISOString();
  const r = db
    .prepare(
      `UPDATE goal_changes SET state = 'confirmed', confirmed_sha = @sha, confirmed_at = @at,
         error = NULL, updated_at = @at
       WHERE id = @id AND state = 'open' AND head_sha = @sha`,
    )
    .run({ id, sha, at });
  return r.changes === 1;
}

/** Why a change must be proposed again, in the server's words. */
const AGAIN = 'propose the change again';

/** The reviewer's approval of a goal change: fixed words, with no text of the proposal's. */
export const goalChangeReviewBody = (goalPath: string, id: number): string =>
  `Approved by Jumpmaster: the owner confirmed this change of ${goalPath} (goal change ${id}) in the browser, at this commit.`;

/**
 * Whether the zone's required checks pass on `sha`, as the flow judges an agent PR (with CI
 * required, only the named required checks count).
 */
function checksPass(zone: DropZoneConfig, required: string[], c: ChecksFacts): boolean {
  if (zone.ciRequired && required.length === 0) return false;
  if (c.state === 'success') return required.every((n) => c.names.includes(n));
  return c.state === 'none' && !zone.ciRequired && required.length === 0;
}

/**
 * One confirmed change, one step on: reads its PR and merges it only when the server opened it
 * (its body ends with `opMarker('goal:<id>')`), it changes the zone's goal file and nothing else
 * (a complete list), its head is still the SHA the owner confirmed, the goal file on the default
 * branch is still the one the change was made from, the branch rules are safe, and the required
 * checks pass. Then the reviewer approves the confirmed SHA (none in starter mode, as agent PRs)
 * and the PR is squash-merged at it, both through the outbox. Anything that can only come right by
 * proposing again refuses the change; a read that failed, or checks not yet green, waits.
 */
async function advanceGoalChange(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  c: GoalChange,
  now: Date,
): Promise<boolean> {
  const sha = c.confirmedSha;
  const path = zone.crew.goalPath;
  const refuse = (why: string) => {
    update(db, c.id, { state: 'refused', error: `${why}: ${AGAIN}` }, now);
    return true;
  };
  const wait = (error: string) => {
    if (error !== c.error) update(db, c.id, { error }, now);
    return false;
  };
  if (sha === null || c.prNumber === null) return refuse('the change has no confirmed commit');
  const author = forges.author;
  let step = 'read the pull request';
  try {
    const pr = await author.getPull(c.prNumber);
    if (pr === null) return refuse('the pull request is gone');
    if (pr.merged) {
      update(db, c.id, { state: 'merged', error: null }, now);
      return true;
    }
    if (pr.state !== 'open') {
      update(db, c.id, { state: 'closed', error: `the pull request was closed: ${AGAIN}` }, now);
      return true;
    }
    const lastLine = pr.body.trimEnd().split('\n').pop() ?? '';
    if (lastLine !== opMarker(`goal:${c.id}`) || pr.headRef !== GOAL_CHANGE_BRANCH(c.id))
      return refuse('the pull request is not the one Jumpmaster opened for this change');
    if (pr.headSha !== sha)
      return refuse('the pull request changed after you confirmed it, so it is not merged');
    step = 'list the changed files';
    const files = await author.listPullFiles(pr.number);
    const only = files.files[0];
    if (
      !files.complete ||
      files.files.length !== 1 ||
      only?.path !== path ||
      only.previousPath !== undefined
    )
      return refuse(`the pull request changes more than ${path}`);
    step = 'read the goal file';
    const [onBase, onDefault, confirmed] = await Promise.all([
      c.baseSha === null ? Promise.resolve(null) : author.getFileAt(c.baseSha, path),
      author.getFileAt(pr.baseRef, path),
      author.getFileAt(sha, path),
    ]);
    if (confirmed !== c.text)
      return refuse(`${path} at the confirmed commit is not the proposed text`);
    if (onDefault !== onBase) return refuse(`${path} changed on ${pr.baseRef} since the proposal`);
    step = 'read the branch rules';
    const reviewer = forges.reviewer;
    const [authorRules, reviewerRules] = await Promise.all([
      author.getBranchRules(pr.baseRef),
      reviewer ? reviewer.getBranchRules(pr.baseRef) : null,
    ]);
    const problems = branchProtectionProblems(
      { author: authorRules, reviewer: reviewerRules },
      zone,
    );
    if (problems === null) return wait('could not read the branch rules: waiting');
    if (problems.length > 0)
      return wait(`unsafe branch protection: ${problems.join('; ')}: waiting`);
    const required = authorRules.kind === 'ok' ? authorRules.rules.requiredChecks : [];
    step = 'read the checks';
    const checks = await author.checksFor(sha);
    if (checks.state === 'failure') return wait(`the checks failed on ${sha.slice(0, 7)}: waiting`);
    if (!checksPass(zone, required, checks))
      return wait(`waiting for the required checks on ${sha.slice(0, 7)}`);
  } catch (err) {
    return wait(failure(step, err));
  }

  // Starter mode has no reviewer identity: the author merges alone, as agent PRs do.
  if (forges.reviewer !== null) {
    const review: PostReviewPayload = {
      pr: c.prNumber,
      event: 'APPROVE',
      commitId: sha,
      body: goalChangeReviewBody(path, c.id),
    };
    const r = await runOp(
      db,
      forges,
      {
        kind: 'post_review',
        opKey: opKeys.goalReview(c.id, sha),
        zoneId: zone.id,
        itemId: null,
        payload: review,
      },
      now,
    );
    if (r.state === 'failed') return wait('could not post the approval: waiting');
    if (r.state !== 'done') return false;
  }
  const merge: MergePayload = {
    pr: c.prNumber,
    sha,
    title: goalChangePullTitle(path, c.id),
    message: goalChangeCommitMessage(path, c.id),
  };
  const m = await runOp(
    db,
    forges,
    {
      kind: 'merge',
      opKey: opKeys.goalMerge(c.id, sha),
      zoneId: zone.id,
      itemId: null,
      payload: merge,
    },
    now,
  );
  if (m.state === 'done') {
    update(db, c.id, { state: 'merged', error: null }, now);
    return true;
  }
  if (m.state === 'failed') return wait('could not merge the pull request: waiting');
  return false;
}

/**
 * An open change whose PR ended outside Jumpmaster (#645): it follows the forge's own state only,
 * `merged` when the PR merged and `closed` when it was closed without merging. A PR still open, one
 * the forge does not return, or a read that failed leaves the row as it is.
 */
async function reconcileOpenGoalChange(
  db: Db,
  forges: ForgePair,
  c: GoalChange,
  now: Date,
): Promise<boolean> {
  if (c.prNumber === null) return false;
  let pr: Awaited<ReturnType<ForgePair['author']['getPull']>>;
  try {
    pr = await forges.author.getPull(c.prNumber);
  } catch {
    return false;
  }
  if (pr === null) return false;
  if (pr.merged) {
    update(db, c.id, { state: 'merged', error: null }, now);
    return true;
  }
  if (pr.state !== 'open') {
    update(db, c.id, { state: 'closed', error: `the pull request was closed: ${AGAIN}` }, now);
    return true;
  }
  return false;
}

/**
 * Merges every goal change of the zone the owner confirmed, each only at the commit they confirmed
 * (a reconcile pass, while the zone is active). The only path that merges a change of the goal
 * file: agent PRs touching it park on the protected path. An open change whose PR was closed or
 * merged by hand follows it (#645). Returns how many changes moved on.
 */
export async function advanceGoalChanges(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  now: Date,
): Promise<number> {
  if (isKilled(db) || getZoneMode(db, zone.id, zone.mode) !== 'active') return 0;
  let moved = 0;
  for (const c of listGoalChanges(db, zone.id, 'open')) {
    if (await reconcileOpenGoalChange(db, forges, c, now)) moved++;
  }
  for (const c of listGoalChanges(db, zone.id, 'confirmed')) {
    if (await advanceGoalChange(db, forges, zone, c, now)) moved++;
  }
  return moved;
}
