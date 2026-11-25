import { describe, expect, test } from 'vitest';
import { setKilled, setZoneMode } from './db/repo.js';
import { reconcileZone } from './flow/reconcile.js';
import { zonePass } from './flow/snapshot.js';
import { gitBlobSha } from './forge/github.js';
import {
  advanceGoalChanges,
  checksPass,
  confirmGoalChange,
  GOAL_CHANGE_BRANCH,
  GOAL_TEXT_MAX,
  getGoalChange,
  goalChangeCommitMessage,
  goalChangeDiff,
  goalChangePullBody,
  goalChangePullTitle,
  openGoalChange,
  proposeGoalChange,
} from './goal-change.js';
import { opMarker } from './outbox.js';
import { promptVersions } from './payloads.js';
import { crewWorld, GOAL } from './test/crew.js';
import { FORGE_WRITES } from './test/fakes.js';
import { makeZone, usageCfg } from './test/fixtures.js';
import { gitlabPipelineReads } from './test/gitlab-pipeline-reads.js';
import { t0 } from './test/helpers.js';

const NEW_GOAL = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the user guide');
/** A phrase only the model's text holds: it must reach the file and nothing else. */
const MODEL_WORDS = 'ZEBRA-PHRASE-FROM-THE-MODEL';
const BASE = 'base0';

async function world(o: Parameters<typeof crewWorld>[0] = {}) {
  const w = await crewWorld(o);
  w.f.state.branches.set('main', BASE);
  w.f.state.files.set(`${BASE}:GOAL.md`, GOAL);
  const writes = () =>
    [...w.f.author.calls, ...w.f.reviewer.calls].filter((c) =>
      (FORGE_WRITES as string[]).includes(c.method),
    );
  const calls = (method: string) => w.f.author.calls.filter((c) => c.method === method);
  const propose = (text = NEW_GOAL) => {
    const r = proposeGoalChange(w.db, w.zone, { text, source: 'chat', sourceRef: 'chat:1:22' }, t0);
    if (!r.ok) throw new Error(r.error);
    return r.id;
  };
  const open = (id: number, now = t0) => openGoalChange(w.db, w.forges, w.zone, id, now);
  const pass = async (now = t0) => {
    const p = await zonePass(w.forges, w.zone, 'main');
    return reconcileZone(w.db, w.forges, w.zone, p, promptVersions(), usageCfg, [], now);
  };
  return { ...w, writes, calls, propose, open, pass };
}

describe('goal changes (#362)', () => {
  test('openGoalChange commits only goalPath on jm/goal-change-<id> from the default branch and opens one PR', async () => {
    const w = await world();
    const id = w.propose();
    expect(getGoalChange(w.db, id)).toMatchObject({ state: 'proposed', zoneId: 'main' });
    expect(await w.open(id)).toBe('open');
    const branch = GOAL_CHANGE_BRANCH(id);
    expect(branch).toBe(`jm/goal-change-${id}`);
    expect(w.calls('createBranch').map((c) => c.args)).toEqual([[branch, BASE]]);
    const puts = w.calls('putFile').map((c) => c.args[0]);
    expect(puts).toEqual([
      {
        branch,
        path: 'GOAL.md',
        content: NEW_GOAL,
        message: goalChangeCommitMessage('GOAL.md', id),
        expectBlobSha: gitBlobSha(GOAL),
      },
    ]);
    expect(w.f.state.commits.map((c) => c.path)).toEqual(['GOAL.md']);
    const pulls = [...w.f.state.pulls.values()].filter((p) => p.headRef === branch);
    expect(pulls).toHaveLength(1);
    const head = w.f.state.branches.get(branch);
    expect(pulls[0]).toMatchObject({ baseRef: 'main', author: 'author-bot', headSha: head });
    expect(getGoalChange(w.db, id)).toMatchObject({
      state: 'open',
      baseSha: BASE,
      branch,
      prNumber: pulls[0]?.number,
      headSha: head,
      error: null,
    });
    // Only the author identity writes, and only these three calls.
    expect(w.writes().map((c) => `${c.identity}:${c.method}`)).toEqual([
      'author:createBranch',
      'author:putFile',
      'author:findOrCreatePullRequest',
    ]);
    // The card's diff is computed from the stored base text and the proposed text.
    expect(goalChangeDiff(w.db, id)).toContain('+ ### Write the user guide');
  });

  test('CLAIM=PROOF the PR title, body and commit message are fixed text with no model words', async () => {
    const w = await world();
    const id = w.propose(NEW_GOAL.replace('LIGHTHOUSE-TEXT', MODEL_WORDS));
    expect(await w.open(id)).toBe('open');
    const [pr] = w.calls('findOrCreatePullRequest').map((c) => c.args[0]) as {
      title: string;
      body: string;
    }[];
    const [put] = w.calls('putFile').map((c) => c.args[0]) as {
      message: string;
      content: string;
    }[];
    expect(put?.message).toBe(`Update GOAL.md (goal change ${id}, confirmed in Jumpmaster)`);
    expect(pr?.title).toBe(goalChangePullTitle('GOAL.md', id));
    expect(pr?.body).toBe(goalChangePullBody('GOAL.md', id));
    expect(pr?.body.trimEnd().endsWith(opMarker(`goal:${id}`))).toBe(true);
    // The model's words are in the file, and in no other argument of any forge call.
    expect(put?.content).toContain(MODEL_WORDS);
    const elsewhere = w.f.author.calls.map((c) =>
      c.method === 'putFile' ? { ...(c.args[0] as object), content: '' } : c.args,
    );
    expect(JSON.stringify(elsewhere)).not.toContain(MODEL_WORDS);
    expect(JSON.stringify(getGoalChange(w.db, id)?.error ?? '')).not.toContain(MODEL_WORDS);
  });

  test("D1 a text that doesn't parse as goals, is too long or contains a token is refused before any forge call", async () => {
    const w = await world();
    const refuse = (text: string) =>
      proposeGoalChange(w.db, w.zone, { text, source: 'chat', sourceRef: 'chat:1:22' }, t0);
    expect(refuse('# Goals\n\nNo objectives here.\n')).toMatchObject({ ok: false });
    expect(refuse(`${NEW_GOAL}\n${'x'.repeat(GOAL_TEXT_MAX)}`)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/64000/),
    });
    const token = `ghp_${'a'.repeat(36)}`;
    const secret = refuse(NEW_GOAL.replace('LIGHTHOUSE-TEXT', token));
    expect(secret).toMatchObject({ ok: false });
    expect(JSON.stringify(secret)).not.toContain(token);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM goal_changes').get()).toEqual({ n: 0 });
    // A row that somehow holds a bad text is refused by the open, before any forge call.
    w.db
      .prepare(
        `INSERT INTO goal_changes (id, zone_id, source, text, text_sha256, state, created_at,
           updated_at) VALUES (9, 'main', 'crew', ?, 'x', 'proposed', ?, ?)`,
      )
      .run(NEW_GOAL.replace('LIGHTHOUSE-TEXT', token), t0.toISOString(), t0.toISOString());
    expect(await w.open(9)).toBe('refused');
    expect(getGoalChange(w.db, 9)).toMatchObject({ state: 'refused' });
    expect(getGoalChange(w.db, 9)?.error).not.toContain(token);
    expect(w.writes()).toEqual([]);
    expect(w.f.author.calls.filter((c) => c.method !== 'getFileAt')).toEqual([]);
  });

  test('D2 a createBranch or putFile failure leaves state proposed with an error and retries next pass; observe mode and the kill switch write nothing', async () => {
    const w = await world();
    const id = w.propose();
    w.f.author.failNext('createBranch', '5xx');
    await w.pass();
    expect(getGoalChange(w.db, id)).toMatchObject({
      state: 'proposed',
      error: expect.stringMatching(/branch/),
    });
    w.f.author.failNext('putFile', 'throw');
    await w.pass();
    expect(getGoalChange(w.db, id)).toMatchObject({
      state: 'proposed',
      error: expect.stringMatching(/commit/),
    });
    expect(w.calls('findOrCreatePullRequest').filter((c) => c.args[0])).toHaveLength(0);
    await w.pass();
    expect(getGoalChange(w.db, id)).toMatchObject({ state: 'open', error: null });

    // Observe mode and the kill switch: a proposed change waits, and nothing is written.
    const v = await world();
    const other = v.propose();
    setZoneMode(v.db, 'main', 'observe', t0);
    await v.pass();
    expect(await v.open(other)).toBe('retry');
    setZoneMode(v.db, 'main', 'paused', t0);
    expect(await v.open(other)).toBe('retry');
    setZoneMode(v.db, 'main', 'active', t0);
    setKilled(v.db, true, t0);
    await v.pass();
    expect(await v.open(other)).toBe('retry');
    expect(v.writes()).toEqual([]);
    expect(getGoalChange(v.db, other)).toMatchObject({ state: 'proposed' });
    setKilled(v.db, false, t0);
    await v.pass();
    expect(getGoalChange(v.db, other)).toMatchObject({ state: 'open' });
  });

  test('D3 two passes opening the same change make one branch and one PR', async () => {
    const w = await world();
    const id = w.propose();
    // The commit landed but its answer was lost: the next pass finds it rather than committing again.
    w.f.author.failNext('putFile', '5xx-after-success');
    expect(await w.open(id)).toBe('retry');
    expect(await w.open(id)).toBe('open');
    expect(await w.open(id)).toBe('open');
    // A PR whose answer was lost: findOrCreatePullRequest finds it.
    const id2 = w.propose(NEW_GOAL.replace('user guide', 'admin guide'));
    w.f.author.failNext('findOrCreatePullRequest', '5xx-after-success');
    expect(await w.open(id2)).toBe('retry');
    expect(await w.open(id2)).toBe('open');
    for (const n of [id, id2]) {
      const branch = GOAL_CHANGE_BRANCH(n);
      expect([...w.f.state.pulls.values()].filter((p) => p.headRef === branch)).toHaveLength(1);
      expect(w.f.state.commits.filter((c) => c.branch === branch)).toHaveLength(1);
    }
    // A branch made by a lost answer is found again, and createBranch on its SHA is success.
    await w.f.author.createBranch(
      GOAL_CHANGE_BRANCH(id2),
      w.f.state.branches.get(GOAL_CHANGE_BRANCH(id2)) ?? '',
    );
    await expect(w.f.author.createBranch(GOAL_CHANGE_BRANCH(id2), 'elsewhere')).rejects.toThrow();
  });

  test('CLAIM=PROOF the goal-change branch is not an agent branch', async () => {
    const w = await world();
    const id = w.propose();
    await w.pass();
    expect(getGoalChange(w.db, id)).toMatchObject({ state: 'open' });
    expect(GOAL_CHANGE_BRANCH(id).startsWith('agent/issue-')).toBe(false);
    expect(await w.f.author.listOpenAgentPulls('agent/issue-')).toEqual([]);
    // Another pass adopts nothing: no work item is made of the goal-change PR.
    await w.pass();
    const items = w.db
      .prepare('SELECT COUNT(*) AS n FROM work_items WHERE pr_number IS NOT NULL')
      .get();
    expect(items).toEqual({ n: 0 });
  });
});

describe('approving and merging a goal change (#363)', () => {
  /** A world whose goal change is open as its PR, with the required check green on its head. */
  async function opened(o: Parameters<typeof crewWorld>[0] = {}) {
    const w = await world(o);
    const id = w.propose();
    expect(await w.open(id)).toBe('open');
    const c = getGoalChange(w.db, id);
    const pr = c?.prNumber as number;
    const head = c?.headSha as string;
    w.f.state.checks.set(head, { state: 'success', names: ['ci'] });
    const advance = (now = t0) => advanceGoalChanges(w.db, w.forges, w.zone, now);
    const ops = (kind: string) =>
      w.db.prepare('SELECT op_key AS opKey FROM outbox WHERE kind = ?').all(kind) as {
        opKey: string;
      }[];
    const forgeCalls = (method: string) =>
      [...w.f.author.calls, ...w.f.reviewer.calls].filter((c) => c.method === method);
    return { ...w, id, pr, head, advance, ops, forgeCalls };
  }

  test('CLAIM=PROOF a goal change is never merged before the owner confirms in the browser', async () => {
    const w = await opened();
    expect(getGoalChange(w.db, w.id)?.state).toBe('open');
    expect(await w.advance()).toBe(0);
    await w.pass();
    await w.pass();
    expect(w.ops('post_review')).toEqual([]);
    expect(w.ops('merge')).toEqual([]);
    expect(w.forgeCalls('createReview')).toEqual([]);
    expect(w.forgeCalls('merge')).toEqual([]);
    expect(w.f.state.merges).toEqual([]);
    expect(getGoalChange(w.db, w.id)?.state).toBe('open');
  });

  test('a confirmed change is approved by the reviewer on the confirmed SHA, then squash-merged at it', async () => {
    const w = await opened();
    expect(confirmGoalChange(w.db, w.id, w.head, t0)).toBe(true);
    await w.pass();
    expect(
      w.f.reviewer.calls.filter((c) => c.method === 'createReview').map((c) => c.args[0]),
    ).toEqual([w.pr]);
    const review = w.f.state.reviews.find((r) => r.pr === w.pr);
    expect(review).toMatchObject({ author: 'reviewer-bot', state: 'APPROVED', commitId: w.head });
    expect(w.f.state.merges).toEqual([
      {
        number: w.pr,
        sha: w.head,
        title: goalChangePullTitle('GOAL.md', w.id),
        message: goalChangeCommitMessage('GOAL.md', w.id),
      },
    ]);
    expect(w.forgeCalls('merge').map((c) => (c.args[1] as { method: string }).method)).toEqual([
      'squash',
    ]);
    expect(getGoalChange(w.db, w.id)).toMatchObject({
      state: 'merged',
      confirmedSha: w.head,
      error: null,
    });
  });

  test('Review Focus 5 a head that moved after confirmation is never merged', async () => {
    const w = await opened();
    expect(confirmGoalChange(w.db, w.id, w.head, t0)).toBe(true);
    // Someone pushes to the branch after the owner confirmed: the head is B now.
    w.f.state.setHead(w.pr, 'sha-B');
    w.f.state.checks.set('sha-B', { state: 'success', names: ['ci'] });
    await w.advance();
    await w.pass();
    const c = getGoalChange(w.db, w.id);
    expect(c?.state).toBe('refused');
    expect(c?.error).toMatch(/propose .*again/i);
    expect(c?.error).toMatch(/changed after you confirmed/);
    expect(w.ops('merge')).toEqual([]);
    expect(w.ops('post_review')).toEqual([]);
    expect(w.f.state.merges).toEqual([]);
  });

  test('Review Focus 5 a goal file that moved on the default branch is never merged', async () => {
    const w = await opened();
    expect(confirmGoalChange(w.db, w.id, w.head, t0)).toBe(true);
    w.f.state.files.set('main:GOAL.md', `${GOAL}\n### Someone else's objective\n`);
    await w.advance();
    expect(getGoalChange(w.db, w.id)).toMatchObject({
      state: 'refused',
      error: expect.stringMatching(/propose .*again/i),
    });
    expect(w.f.state.merges).toEqual([]);
  });

  test('D1 a PR touching any file besides goalPath, or not opened by the server, is never merged by this path', async () => {
    // Another file beside GOAL.md.
    const a = await opened();
    a.f.state.pullFiles.set(a.pr, {
      files: [{ path: 'GOAL.md' }, { path: 'src/evil.ts' }],
      complete: true,
    });
    confirmGoalChange(a.db, a.id, a.head, t0);
    await a.advance();
    expect(getGoalChange(a.db, a.id)).toMatchObject({ state: 'refused' });
    // A cut-short list proves nothing either.
    const b = await opened();
    b.f.state.pullFiles.set(b.pr, { files: [{ path: 'GOAL.md' }], complete: false });
    confirmGoalChange(b.db, b.id, b.head, t0);
    await b.advance();
    expect(getGoalChange(b.db, b.id)).toMatchObject({ state: 'refused' });
    // A rename onto GOAL.md is not a change of GOAL.md only.
    const r = await opened();
    r.f.state.pullFiles.set(r.pr, {
      files: [{ path: 'GOAL.md', previousPath: 'OTHER.md' }],
      complete: true,
    });
    confirmGoalChange(r.db, r.id, r.head, t0);
    await r.advance();
    expect(getGoalChange(r.db, r.id)).toMatchObject({ state: 'refused' });
    // A PR whose body does not end with the server's marker for this change.
    const c = await opened();
    const pull = c.f.state.pulls.get(c.pr);
    if (pull) pull.body = 'Opened by hand.';
    confirmGoalChange(c.db, c.id, c.head, t0);
    await c.advance();
    expect(getGoalChange(c.db, c.id)).toMatchObject({ state: 'refused' });
    for (const w of [a, b, r, c]) {
      expect(w.ops('merge')).toEqual([]);
      expect(w.ops('post_review')).toEqual([]);
      expect(w.f.state.merges).toEqual([]);
    }
  });

  test('D2 a checks read failure waits and merges nothing', async () => {
    const w = await opened();
    confirmGoalChange(w.db, w.id, w.head, t0);
    w.f.author.failNext('checksFor', '5xx');
    expect(await w.advance()).toBe(0);
    expect(getGoalChange(w.db, w.id)).toMatchObject({
      state: 'confirmed',
      error: expect.stringMatching(/checks/),
    });
    expect(w.ops('merge')).toEqual([]);
    expect(w.f.state.merges).toEqual([]);
    // Checks still running: it waits too.
    w.f.state.checks.set(w.head, { state: 'pending', names: [] });
    await w.advance();
    expect(getGoalChange(w.db, w.id)?.state).toBe('confirmed');
    expect(w.f.state.merges).toEqual([]);
    // Green: the next pass merges.
    w.f.state.checks.set(w.head, { state: 'success', names: ['ci'] });
    await w.advance();
    expect(getGoalChange(w.db, w.id)).toMatchObject({ state: 'merged', error: null });
  });

  test('D3 two passes merge once', async () => {
    const w = await opened();
    confirmGoalChange(w.db, w.id, w.head, t0);
    await Promise.all([w.advance(), w.advance()]);
    await w.advance();
    await w.pass();
    expect(w.f.state.merges).toHaveLength(1);
    expect(w.ops('merge')).toEqual([{ opKey: `merge:goal-${w.id}:${w.head}` }]);
    expect(w.ops('post_review')).toHaveLength(1);
    expect(getGoalChange(w.db, w.id)?.state).toBe('merged');
  });

  test('D3 a second confirmation of one change is refused', async () => {
    const w = await opened();
    expect(confirmGoalChange(w.db, w.id, w.head, t0)).toBe(true);
    expect(confirmGoalChange(w.db, w.id, w.head, t0)).toBe(false);
    expect(confirmGoalChange(w.db, w.id, 'other', t0)).toBe(false);
    expect(getGoalChange(w.db, w.id)?.confirmedSha).toBe(w.head);
  });

  test('in starter mode (no reviewer) it merges with the author alone when the branch rules allow, as agent PRs do', async () => {
    const w = await opened({ identity: 'starter' });
    expect(w.forges.reviewer).toBeNull();
    confirmGoalChange(w.db, w.id, w.head, t0);
    await w.advance();
    expect(w.forgeCalls('createReview')).toEqual([]);
    expect(w.ops('post_review')).toEqual([]);
    expect(w.f.state.merges.map((m) => m.sha)).toEqual([w.head]);
    expect(getGoalChange(w.db, w.id)?.state).toBe('merged');

    // Rules that ask for an approval nobody can give in starter mode: it waits, merging nothing.
    const v = await opened({ identity: 'starter' });
    const rules = v.f.state.rules.author;
    if (rules.kind === 'ok') rules.rules.requiredApprovals = 1;
    confirmGoalChange(v.db, v.id, v.head, t0);
    await v.advance();
    expect(getGoalChange(v.db, v.id)).toMatchObject({
      state: 'confirmed',
      error: expect.stringMatching(/branch protection/),
    });
    expect(v.f.state.merges).toEqual([]);
  });

  test('observe mode and the kill switch merge nothing', async () => {
    const w = await opened();
    confirmGoalChange(w.db, w.id, w.head, t0);
    setZoneMode(w.db, 'main', 'observe', t0);
    await w.pass();
    expect(await w.advance()).toBe(0);
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect(await w.advance()).toBe(0);
    expect(w.f.state.merges).toEqual([]);
    expect(getGoalChange(w.db, w.id)?.state).toBe('confirmed');
  });
  test('#645 an open change whose PR was closed by hand without merging is closed at the next pass', async () => {
    const w = await opened();
    const pull = w.f.state.pulls.get(w.pr);
    if (!pull) throw new Error('no pull');
    pull.state = 'closed';
    await w.pass();
    expect(getGoalChange(w.db, w.id)?.state).toBe('closed');
    expect(w.f.state.merges).toEqual([]);
  });

  test('#645 an open change whose PR merged outside Jumpmaster is merged at the next pass', async () => {
    const w = await opened();
    const pull = w.f.state.pulls.get(w.pr);
    if (!pull) throw new Error('no pull');
    pull.state = 'closed';
    pull.merged = true;
    await w.pass();
    expect(getGoalChange(w.db, w.id)).toMatchObject({ state: 'merged' });
    expect(w.ops('merge')).toEqual([]);
  });

  test("#645 a forge error reading an open change's PR leaves it open", async () => {
    const w = await opened();
    const pull = w.f.state.pulls.get(w.pr);
    if (!pull) throw new Error('no pull');
    pull.state = 'closed';
    for (let i = 0; i < 10; i++) w.f.author.failNext('getPull', '5xx');
    await w.pass();
    expect(getGoalChange(w.db, w.id)?.state).toBe('open');
  });
});

describe('checksPass on GitLab reads (#885)', () => {
  const zone = makeZone({ ciRequired: true });

  test('a green GitLab pipeline passes the required pipeline', async () => {
    const r = await gitlabPipelineReads('green');
    expect(r.requiredChecks).toEqual(['pipeline']);
    expect(checksPass(zone, r.requiredChecks, r.checks)).toBe(true);
  });

  test.each(['none', 'running', 'failed', 'jobless-failed'] as const)(
    'a GitLab head with pipeline %s does not pass',
    async (c) => {
      const r = await gitlabPipelineReads(c);
      expect(checksPass(zone, r.requiredChecks, r.checks)).toBe(false);
    },
  );
});
