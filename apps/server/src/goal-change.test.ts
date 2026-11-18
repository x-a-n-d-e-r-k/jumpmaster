import { describe, expect, test } from 'vitest';
import { setKilled, setZoneMode } from './db/repo.js';
import { reconcileZone } from './flow/reconcile.js';
import { zonePass } from './flow/snapshot.js';
import { gitBlobSha } from './forge/github.js';
import {
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
import { usageCfg } from './test/fixtures.js';
import { t0 } from './test/helpers.js';

const NEW_GOAL = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the user guide');
/** A phrase only the model's text holds: it must reach the file and nothing else. */
const MODEL_WORDS = 'ZEBRA-PHRASE-FROM-THE-MODEL';
const BASE = 'base0';

async function world() {
  const w = await crewWorld();
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
