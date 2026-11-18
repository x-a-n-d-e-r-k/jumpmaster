import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { registerControlRoutes } from '../api/control.js';
import { listAudit } from '../auth/audit.js';
import type { Principal } from '../auth/guard.js';
import { registerGuard } from '../auth/guard.js';
import {
  applyPendingRulings,
  getBriefing,
  listBriefings,
  listRulings,
  raiseBriefing,
} from '../briefings.js';
import { type ChatCard, listCards, renderCard, undoCard } from '../chat/cards.js';
import { createThread } from '../chat/store.js';
import type { Config } from '../config.js';
import { flushCrewOps } from '../crew/flush.js';
import { listCrewIssues } from '../crew/store.js';
import {
  getZoneMode,
  setKilled,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  upsertDropZone,
  upsertWorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { listGoalChanges, openGoalChange } from '../goal-change.js';
import { objectivesDone } from '../goals.js';
import { crewOn, crewWorld, GOAL, ISSUE_BODY } from '../test/crew.js';
import { makeZone, usageCfg } from '../test/fixtures.js';
import { operatorSession, t0 } from '../test/helpers.js';
import { type ChatPrincipal, checkMcpToken, mintChatToken } from './tokens.js';
import { callTool, listTools } from './tools.js';

const HOST = '127.0.0.1:7420';
const OBJECTIVE = 'document-every-endpoint';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function world() {
  const w = await crewWorld();
  upsertDropZone(w.db, {
    id: 'other',
    repo: 'octo/other',
    defaultBranch: 'main',
    configJson: '{}',
  });
  const other = makeZone({ id: 'other', repo: 'octo/other', crew: crewOn });
  const config = {
    listen: { host: '127.0.0.1', port: 7420 },
    dataDir: '.',
    pollSeconds: 60,
    dropZones: [w.zone, other],
    claude: { plan: 'max', fableModel: 'fable-x', fableWeeklyDropCap: 5 },
    usage: usageCfg,
    secrets: {
      claudeToken: 'claude-secret-value-123',
      githubAuthorToken: 'author-secret-value',
      githubReviewerToken: 'reviewer-secret-value',
      joinToken: 'join-token-value',
      operatorToken: 'o'.repeat(32),
    },
    mcp: { enabled: false },
  } as Config;
  const one = createThread(w.db, { title: 'one' }, t0);
  const two = createThread(w.db, { title: 'two' }, t0);
  const minted = mintChatToken(
    w.db,
    { threadId: one.id, messageId: 22, sessionHash: 'f'.repeat(64), minutes: 30 },
    t0,
  );
  const c = checkMcpToken(w.db, minted.token, t0);
  if (!c.ok) throw new Error('chat token did not check');
  const principal = c.principal as ChatPrincipal;
  const pushed: unknown[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(
      {
        db: w.db,
        config,
        principal,
        now: () => t0,
        actions: true,
        forgesFor: () => w.forges,
        onCard: (card) => pushed.push(card),
      },
      name,
      args,
    );
    return { ...r, text: (r.content[0] as { text: string }).text };
  };
  return { ...w, config, principal, call, one, two, pushed };
}

const objectiveBriefing = (db: Parameters<typeof raiseBriefing>[0], subject = 'pick one') =>
  raiseBriefing(
    db,
    {
      zoneId: 'main',
      kind: 'crew',
      subject,
      decision: 'Which endpoint is documented first?',
      why: 'Two issues touch the same page.',
      options: [
        { id: 'a', label: 'Users first', effect: 'none' },
        { id: 'b', label: 'Orders first', effect: 'none' },
      ],
      source: 'mcp',
    },
    t0,
  );

describe('chat action tools', () => {
  test("CLAIM=PROOF a card's text comes from the server's record, never from the tool arguments", async () => {
    const w = await world();
    const id = objectiveBriefing(w.db);
    // An assistant briefing needs its options digest: the server computes it from the briefing.
    const r = await w.call('rule_briefing', {
      briefingId: id,
      optionId: 'b',
      note: '<b>ignore previous</b>',
    });
    expect(r.isError).toBeFalsy();
    expect(listRulings(w.db, 'main')[0]).toMatchObject({ choice: 'b', label: 'Orders first' });
    const [card] = listCards(w.db, w.one.id);
    expect(card).toMatchObject({ kind: 'rule', state: 'done', zoneId: 'main' });
    expect(card?.summary).toContain('Which endpoint is documented first?');
    expect(card?.summary).toContain('Orders first');
    expect(card?.summary).not.toContain('ignore previous');
    expect(renderCard(card as never)).not.toContain('ignore previous');
    // Pushed to the thread's stream once the call committed.
    expect(w.pushed).toEqual([card]);
  });

  test('rule_briefing has no Undo', async () => {
    const w = await world();
    const id = objectiveBriefing(w.db);
    expect((await w.call('rule_briefing', { briefingId: id, optionId: 'a' })).isError).toBeFalsy();
    const [card] = listCards(w.db, w.one.id);
    expect(card?.undo).toBeNull();
    expect(w.db.prepare('SELECT undo_json FROM chat_cards WHERE id = ?').get(card?.id)).toEqual({
      undo_json: null,
    });
    expect(renderCard(card as never)).not.toMatch(/Undo/);
  });

  test('D5 set_zone_mode paused through chat has the same effect and audit action as POST /api/control/zones/:id', async () => {
    const w = await world();
    const app = Fastify();
    registerGuard(app, { db: w.db, config: w.config, now: () => t0 });
    registerControlRoutes(app, { db: w.db, config: w.config, now: () => t0 });
    close = () => app.close();
    const session = operatorSession(w.db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/control/zones/other',
      headers: { ...session.headers, host: HOST },
      payload: { mode: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    const r = await w.call('set_zone_mode', { zoneId: 'main', mode: 'paused' });
    expect(r.isError).toBeFalsy();
    expect(getZoneMode(w.db, 'main', 'active')).toBe('paused');
    expect(getZoneMode(w.db, 'other', 'active')).toBe('paused');
    const [chatRow, httpRow] = listAudit(w.db, 2);
    expect(httpRow).toMatchObject({ via: 'session', action: 'zone.mode', target: 'other' });
    expect(chatRow).toMatchObject({ via: 'chat', action: 'zone.mode', target: 'main' });
    expect(chatRow?.detail).toEqual({ mode: 'paused', thread: w.one.id, message: 22 });
    expect(listCards(w.db, w.one.id)).toEqual([
      expect.objectContaining({ kind: 'pause', state: 'done', zoneId: 'main', undo: null }),
    ]);
    // Resuming is its own kind of card.
    await w.call('set_zone_mode', { zoneId: 'main', mode: 'active' });
    expect(listCards(w.db, w.one.id).at(-1)).toMatchObject({ kind: 'resume', state: 'done' });
    // Observe is not a chat mode.
    expect((await w.call('set_zone_mode', { zoneId: 'main', mode: 'observe' })).isError).toBe(true);
  });

  test('run_crew_cycle asks for a cycle and records a crew_cycle card', async () => {
    const w = await world();
    const r = await w.call('run_crew_cycle', { zoneId: 'main' });
    expect(r.isError).toBeFalsy();
    expect(listAudit(w.db, 1)[0]).toMatchObject({ via: 'chat', action: 'zone.crew-cycle' });
    expect(listCards(w.db, w.one.id)).toEqual([
      expect.objectContaining({ kind: 'crew_cycle', state: 'done', zoneId: 'main' }),
    ]);
  });

  test('mark_objective_done raises the server objective_done briefing and rules Mark it done', async () => {
    const w = await world();
    const r = await w.call('mark_objective_done', { zoneId: 'main', key: OBJECTIVE });
    expect(r.isError).toBeFalsy();
    const [b] = listBriefings(w.db, { zoneId: 'main' }).filter((x) => x.kind === 'objective_done');
    expect(b).toMatchObject({
      source: 'server',
      subject: `objective:${OBJECTIVE}`,
      state: 'ruled',
    });
    const [ruling] = listRulings(w.db, 'main');
    expect(ruling).toMatchObject({ choice: 'done', effect: 'advance_objective' });
    expect(getBriefing(w.db, ruling?.briefingId ?? 0)?.kind).toBe('objective_done');
    expect(objectivesDone(w.db, 'main').has(OBJECTIVE)).toBe(false);
    await applyPendingRulings(w.db, { forges: () => w.forges, zone: () => w.zone }, 'main', t0);
    expect(objectivesDone(w.db, 'main').get(OBJECTIVE)).toBe(ruling?.id);
    expect(listCards(w.db, w.one.id)).toEqual([
      expect.objectContaining({
        kind: 'objective_done',
        state: 'done',
        target: `objective:${OBJECTIVE}`,
        summary: expect.stringContaining('Document every endpoint'),
      }),
    ]);
  });

  test('propose_goal_change records a proposed change and openGoalChange commits only goalPath on jm/goal-change-<id> and opens one PR', async () => {
    const w = await world();
    const text = GOAL.replace('### Ship the CLI', '### Ship the CLI\n\n### Write the user guide');
    const r = await w.call('propose_goal_change', { zoneId: 'main', text });
    expect(r.isError).toBeFalsy();
    const [row] = listGoalChanges(w.db, 'main');
    expect(row).toMatchObject({
      zoneId: 'main',
      source: 'chat',
      sourceRef: `chat:${w.one.id}:22`,
      text,
      state: 'proposed',
      prNumber: null,
    });
    const id = row?.id ?? 0;
    // Nothing reaches the forge until the pass opens it.
    expect(w.f.author.calls.filter((c) => c.method !== 'getFileAt')).toEqual([]);
    expect(listCards(w.db, w.one.id)).toEqual([
      expect.objectContaining({
        kind: 'goal_change',
        state: 'done',
        target: `goal_change:${id}`,
        summary: expect.stringContaining('+ ### Write the user guide'),
      }),
    ]);
    w.f.state.branches.set('main', 'base0');
    w.f.state.files.set('base0:GOAL.md', GOAL);
    expect(await openGoalChange(w.db, w.forges, w.zone, id, t0)).toBe('open');
    const branch = `jm/goal-change-${id}`;
    expect(w.f.state.commits).toEqual([
      expect.objectContaining({ branch, path: 'GOAL.md', parent: 'base0' }),
    ]);
    expect(w.f.state.files.get(`${branch}:GOAL.md`)).toBe(text);
    const pulls = [...w.f.state.pulls.values()].filter((p) => p.headRef === branch);
    expect(pulls).toHaveLength(1);
    expect(listGoalChanges(w.db, 'main')[0]).toMatchObject({
      state: 'open',
      branch,
      prNumber: pulls[0]?.number,
    });
  });

  test('D1 propose_goal_change refuses a text that is not goals or holds a token, with a refused card', async () => {
    const w = await world();
    const bad = await w.call('propose_goal_change', { zoneId: 'main', text: 'just words' });
    expect(bad.isError).toBe(true);
    const token = `ghp_${'b'.repeat(36)}`;
    const secret = await w.call('propose_goal_change', {
      zoneId: 'main',
      text: GOAL.replace('LIGHTHOUSE-TEXT', token),
    });
    expect(secret.isError).toBe(true);
    expect(secret.text).not.toContain(token);
    expect(listGoalChanges(w.db, 'main')).toEqual([]);
    expect(listCards(w.db, w.one.id).map((c) => [c.kind, c.state])).toEqual([
      ['goal_change', 'refused'],
      ['goal_change', 'refused'],
    ]);
    expect(JSON.stringify(listCards(w.db, w.one.id))).not.toContain(token);
    expect(w.f.author.calls.filter((c) => c.method !== 'getFileAt')).toEqual([]);
  });

  test("D1 mark_objective_done refuses a key that isn't in the zone's goals or is already done", async () => {
    const w = await world();
    const unknown = await w.call('mark_objective_done', { zoneId: 'main', key: 'take-over' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/not an objective/);
    // The other zone has no goals read: its keys are not main's.
    const elsewhere = await w.call('mark_objective_done', { zoneId: 'other', key: OBJECTIVE });
    expect(elsewhere.isError).toBe(true);
    expect(
      (await w.call('mark_objective_done', { zoneId: 'main', key: OBJECTIVE })).isError,
    ).toBeFalsy();
    await applyPendingRulings(w.db, { forges: () => w.forges, zone: () => w.zone }, 'main', t0);
    const again = await w.call('mark_objective_done', { zoneId: 'main', key: OBJECTIVE });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already done/);
    expect(listRulings(w.db, 'main')).toHaveLength(1);
    expect(listCards(w.db, w.one.id).map((c) => c.state)).toEqual([
      'refused',
      'refused',
      'done',
      'refused',
    ]);
    // A refused card names no text the model gave.
    expect(listCards(w.db, w.one.id)[0]?.summary).not.toContain('take-over');
  });

  test('D1 a chat token minted for thread 1 records its cards on thread 1 whatever the arguments say', async () => {
    const w = await world();
    // Arguments naming another thread are refused by the tool's own schema.
    const named = await w.call('run_crew_cycle', {
      zoneId: 'main',
      threadId: w.two.id,
      messageId: 99,
    });
    expect(named.isError).toBe(true);
    const id = objectiveBriefing(w.db);
    await w.call('rule_briefing', { briefingId: id, optionId: 'a', note: `thread ${w.two.id}` });
    await w.call('set_zone_mode', { zoneId: 'other', mode: 'paused' });
    expect(listCards(w.db, w.two.id)).toEqual([]);
    const cards = listCards(w.db, w.one.id);
    expect(cards.map((c) => [c.threadId, c.messageId])).toEqual([
      [w.one.id, 22],
      [w.one.id, 22],
    ]);
  });

  test('D2 an action tool refuses under the kill switch and while the usage gate is stopped, recording a refused card', async () => {
    const w = await world();
    setKilled(w.db, true, t0);
    const killed = await w.call('set_zone_mode', { zoneId: 'main', mode: 'paused' });
    expect(killed.isError).toBe(true);
    expect(killed.text).toMatch(/kill switch/);
    expect(getZoneMode(w.db, 'main', 'active')).toBe('active');
    const filedKilled = await w.call('file_staged_issues', {
      zoneId: 'main',
      issues: [{ key: 'k', objective: OBJECTIVE, title: 'T', body: ISSUE_BODY }],
    });
    expect(filedKilled.isError).toBe(true);
    setKilled(w.db, false, t0);
    setUsageState(
      w.db,
      { overageStoppedAt: t0.toISOString(), overageUntil: '2027-01-01T00:00:00.000Z' },
      t0,
    );
    const stopped = await w.call('run_crew_cycle', { zoneId: 'main' });
    expect(stopped.isError).toBe(true);
    expect(stopped.text).toMatch(/usage/);
    const id = objectiveBriefing(w.db);
    expect((await w.call('rule_briefing', { briefingId: id, optionId: 'a' })).isError).toBe(true);
    expect(listRulings(w.db, 'main')).toEqual([]);
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(listCards(w.db, w.one.id).map((c) => [c.kind, c.state])).toEqual([
      ['pause', 'refused'],
      ['file_issues', 'refused'],
      ['crew_cycle', 'refused'],
      ['rule', 'refused'],
    ]);
    expect(
      w.db.prepare("SELECT COUNT(*) AS n FROM control_audit WHERE via = 'chat'").get(),
    ).toEqual({ n: 0 });
  });

  test('CLAIM=PROOF chat-filed issues are staged crew issues with source mcp', async () => {
    const w = await world();
    const r = await w.call('file_staged_issues', {
      zoneId: 'main',
      issues: [
        { key: 'docs-index', objective: OBJECTIVE, title: 'Add a docs index', body: ISSUE_BODY },
      ],
    });
    expect(r.isError).toBeFalsy();
    const [issue] = listCrewIssues(w.db, 'main');
    expect(issue).toMatchObject({
      source: 'mcp',
      sourceRef: String(w.principal.tokenId),
      state: 'filing',
    });
    // Filed on the forge under the staged label only: no trooper picks it up before refute or
    // promotion.
    await flushCrewOps(w.db, w.forges, w.zone, [], t0);
    const filed = listCrewIssues(w.db, 'main')[0];
    expect(filed?.state).toBe('staged');
    const labels = w.f.state.issues.get(filed?.number ?? 0)?.labels ?? [];
    expect(labels).toContain(w.zone.crew.stagedLabel);
    expect(labels).not.toContain(w.zone.readyLabel);
    const [card] = listCards(w.db, w.one.id);
    expect(card).toMatchObject({ kind: 'file_issues', state: 'done', zoneId: 'main' });
    expect(card?.summary).toMatch(/1 staged issue/);
    // raise_briefing records a briefing card too.
    const b = await w.call('raise_briefing', {
      zoneId: 'main',
      briefings: [
        {
          subject: 'order',
          decision: 'Which first?',
          why: 'Both touch one file.',
          options: ['A', 'B'],
          recommendation: 'A',
          onHold: 'nothing',
        },
      ],
    });
    expect(b.isError).toBeFalsy();
    expect(listCards(w.db, w.one.id).at(-1)).toMatchObject({ kind: 'briefing', state: 'done' });
  });

  test('CLAIM=PROOF there is no tool for comments or free issue text', () => {
    expect(
      listTools('chat', { actions: true })
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        'get_goals',
        'list_work',
        'get_work_item',
        'list_briefings',
        'list_rulings',
        'get_queue',
        'list_sticks',
        'get_settings',
        'get_doctor_run',
        'list_open_issues',
        'list_open_pulls',
        'get_drop_transcript',
        'file_staged_issues',
        'raise_briefing',
        'rule_briefing',
        'set_zone_mode',
        'run_crew_cycle',
        'mark_objective_done',
        'queue_issue',
        'retry_parked',
        'close_issue',
        'propose_goal_change',
      ].sort(),
    );
    const byName = new Map(listTools('chat', { actions: true }).map((t) => [t.name, t]));
    for (const name of [
      'file_staged_issues',
      'raise_briefing',
      'set_zone_mode',
      'run_crew_cycle',
      'queue_issue',
      'retry_parked',
      'close_issue',
      'propose_goal_change',
    ]) {
      expect(byName.get(name)?.inputSchema.required).toContain('zoneId');
    }
  });
});

/** Every outbox row, as the forge write it records. */
const outboxRows = (db: Parameters<typeof raiseBriefing>[0]) =>
  (
    db
      .prepare('SELECT op_key AS opKey, kind, payload_json AS payload FROM outbox ORDER BY rowid')
      .all() as {
      opKey: string;
      kind: string;
      payload: string;
    }[]
  ).map((r) => ({ ...r, payload: JSON.parse(r.payload) as Record<string, unknown> }));

/** The browser session that presses Undo. */
const OWNER: Principal = {
  kind: 'operator',
  via: 'session',
  sessionId: 'a'.repeat(64),
  sudo: false,
};

/** A backlog issue (no Jumpmaster label) by a trusted author. */
async function forgeWorld() {
  const w = await world();
  for (const number of [40, 41, 42]) w.f.state.addIssue({ number, title: `Backlog ${number}` });
  const item = (n: number, state: WorkItemState, reason?: string) => {
    const wi = upsertWorkItem(
      w.db,
      {
        dropZoneId: 'main',
        issueNumber: n,
        title: `Issue ${n}`,
        body: 'b',
        author: 'human',
        priority: 0,
        isFix: false,
        issueCreatedAt: t0.toISOString(),
      },
      t0,
    );
    setWorkItemState(w.db, wi.id, state, reason, t0);
    return wi.id;
  };
  const card = (): ChatCard => {
    const c = listCards(w.db, w.one.id).at(-1);
    if (!c) throw new Error('no card');
    return c;
  };
  const writes = (method: string) => w.f.author.calls.filter((c) => c.method === method);
  return { ...w, item, card, writes };
}

describe('chat forge action tools and Undo', () => {
  test('D5 queue_issue through chat and POST /api/control/zones/:id/queue put the same label on', async () => {
    const w = await forgeWorld();
    const app = Fastify();
    registerGuard(app, { db: w.db, config: w.config, now: () => t0 });
    registerControlRoutes(app, {
      db: w.db,
      config: w.config,
      now: () => t0,
      forgesFor: () => w.forges,
    });
    close = () => app.close();
    const session = operatorSession(w.db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/control/zones/main/queue',
      headers: { ...session.headers, host: HOST },
      payload: { issue: 40 },
    });
    expect(res.statusCode).toBe(200);
    const r = await w.call('queue_issue', { zoneId: 'main', issue: 41 });
    expect(r.isError).toBeFalsy();
    expect(w.f.state.issues.get(40)?.labels).toEqual([w.zone.readyLabel]);
    expect(w.f.state.issues.get(41)?.labels).toEqual([w.zone.readyLabel]);
    const [http, chat] = outboxRows(w.db);
    expect(http).toMatchObject({ kind: 'set_labels', payload: { number: 40 } });
    expect(chat?.kind).toBe('set_labels');
    expect(chat?.payload).toEqual({ ...http?.payload, number: 41 });
    const [chatRow, httpRow] = listAudit(w.db, 2);
    expect(httpRow).toMatchObject({ via: 'session', action: 'zone.queue', target: 'main' });
    expect(chatRow).toMatchObject({ via: 'chat', action: 'zone.queue', target: 'main' });
    expect(chatRow?.detail).toMatchObject({ issue: 41, thread: w.one.id, message: 22 });
    expect(w.card()).toMatchObject({
      kind: 'queue',
      state: 'done',
      zoneId: 'main',
      target: 'issue:41',
      link: 'https://github.com/octo/demo/issues/41',
    });
    expect(w.card().summary).toContain(w.zone.readyLabel);
    expect(renderCard(w.card())).toMatch(/Undo/);
    // The same refusals as the route: an issue already Jumpmaster's is not queued again.
    const again = await w.call('queue_issue', { zoneId: 'main', issue: 41 });
    expect(again.isError).toBe(true);
    expect(w.card()).toMatchObject({ kind: 'queue', state: 'refused', undo: null });
  });

  test('close_issue writes state closed with no body and no comment', async () => {
    const w = await forgeWorld();
    const r = await w.call('close_issue', { zoneId: 'main', issue: 42 });
    expect(r.isError).toBeFalsy();
    expect(w.f.state.issues.get(42)?.state).toBe('closed');
    const rows = outboxRows(w.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('update_issue');
    // CLAIM=PROOF: the payload names the issue and the state, and nothing else.
    expect(Object.keys(rows[0]?.payload ?? {}).sort()).toEqual(['number', 'state']);
    expect(rows[0]?.payload).toEqual({ number: 42, state: 'closed' });
    expect(w.writes('updateIssue').map((c) => c.args)).toEqual([[42, { state: 'closed' }]]);
    expect(w.writes('createIssueComment')).toEqual([]);
    expect(w.card()).toMatchObject({ kind: 'close', state: 'done', target: 'issue:42' });
    expect(listAudit(w.db, 1)[0]).toMatchObject({ via: 'chat', action: 'issue.close' });
  });

  test('D1 close_issue refuses an issue whose work item is in flight or has a PR open', async () => {
    const w = await forgeWorld();
    w.item(1, 'in_flight');
    w.item(2, 'pr_open');
    for (const issue of [1, 2]) {
      const r = await w.call('close_issue', { zoneId: 'main', issue });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/in flight|pull request/);
      expect(w.f.state.issues.get(issue)?.state).toBe('open');
      expect(w.card()).toMatchObject({ kind: 'close', state: 'refused', undo: null });
    }
    expect(outboxRows(w.db)).toEqual([]);
    expect(w.writes('updateIssue')).toEqual([]);
  });

  test('retry_parked puts the retry label on a parked item, and Undo takes it off', async () => {
    const w = await forgeWorld();
    const parked = w.item(3, 'parked', 'ci failed');
    const ready = w.item(4, 'ready');
    const no = await w.call('retry_parked', { zoneId: 'main', itemId: ready });
    expect(no.isError).toBe(true);
    expect(no.text).toMatch(/not parked/);
    const r = await w.call('retry_parked', { zoneId: 'main', itemId: parked });
    expect(r.isError).toBeFalsy();
    expect(w.f.state.issues.get(3)?.labels).toContain(w.zone.retryLabel);
    expect(outboxRows(w.db).at(-1)).toMatchObject({
      kind: 'set_labels',
      payload: { number: 3, add: [w.zone.retryLabel], remove: [] },
    });
    expect(w.card()).toMatchObject({ kind: 'retry', state: 'done', target: 'issue:3' });
    const u = await undoCard(w.db, w.forges, w.card(), OWNER, t0);
    expect(u).toEqual({ ok: true, value: { state: 'undone' } });
    expect(w.f.state.issues.get(3)?.labels).not.toContain(w.zone.retryLabel);
    // Another zone's item is not this zone's to retry.
    const elsewhere = await w.call('retry_parked', { zoneId: 'other', itemId: parked });
    expect(elsewhere.isError).toBe(true);
  });

  test('Undo of a queue removes the ready label and marks the card undone', async () => {
    const w = await forgeWorld();
    await w.call('queue_issue', { zoneId: 'main', issue: 40 });
    const card = w.card();
    const u = await undoCard(w.db, w.forges, card, OWNER, t0);
    expect(u).toEqual({ ok: true, value: { state: 'undone' } });
    expect(w.f.state.issues.get(40)?.labels).toEqual([]);
    expect(outboxRows(w.db).at(-1)).toEqual({
      opKey: `labels:main:undo:${card.id}`,
      kind: 'set_labels',
      payload: { number: 40, add: [], remove: [w.zone.readyLabel] },
    });
    expect(w.card()).toMatchObject({ id: card.id, state: 'undone', undoneAt: t0.toISOString() });
    expect(renderCard(w.card())).not.toMatch(/<button/);
    expect(listAudit(w.db, 1)[0]).toMatchObject({
      via: 'session',
      action: 'chat.undo',
      target: `card:${card.id}`,
    });
  });

  test('Undo of a close reopens the issue', async () => {
    const w = await forgeWorld();
    await w.call('close_issue', { zoneId: 'main', issue: 42 });
    const card = w.card();
    const u = await undoCard(w.db, w.forges, card, OWNER, t0);
    expect(u.ok).toBe(true);
    expect(w.f.state.issues.get(42)?.state).toBe('open');
    expect(outboxRows(w.db).at(-1)).toEqual({
      opKey: `reopen:main:${card.id}`,
      kind: 'update_issue',
      payload: { number: 42, state: 'open' },
    });
    expect(w.card().state).toBe('undone');
  });

  test('Undo refuses with changed since when the label is already gone or the issue was reopened by someone else', async () => {
    const w = await forgeWorld();
    await w.call('queue_issue', { zoneId: 'main', issue: 40 });
    const queued = w.card();
    w.f.state.setLabels(40, []);
    await w.call('close_issue', { zoneId: 'main', issue: 42 });
    const closed = w.card();
    w.f.state.reopenIssue(42);
    const rows = outboxRows(w.db).length;
    const writes = w.f.author.calls.length;
    for (const c of [queued, closed]) {
      const u = await undoCard(w.db, w.forges, c, OWNER, t0);
      expect(u).toMatchObject({ ok: false, status: 409 });
      expect(!u.ok && u.error).toMatch(/changed since/);
    }
    expect(outboxRows(w.db)).toHaveLength(rows);
    const after = w.f.author.calls.slice(writes).map((c) => c.method);
    expect(after.filter((m) => m !== 'getIssue')).toEqual([]);
    expect(listCards(w.db, w.one.id).map((c) => c.state)).toEqual(['done', 'done']);
  });

  test('a card already undone is 409, and a card with no Undo is 409', async () => {
    const w = await forgeWorld();
    await w.call('queue_issue', { zoneId: 'main', issue: 40 });
    expect((await undoCard(w.db, w.forges, w.card(), OWNER, t0)).ok).toBe(true);
    const again = await undoCard(w.db, w.forges, w.card(), OWNER, t0);
    expect(again).toMatchObject({ ok: false, status: 409 });
    await w.call('run_crew_cycle', { zoneId: 'main' });
    expect(await undoCard(w.db, w.forges, w.card(), OWNER, t0)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test('D3 two Undo presses on one card make one forge write', async () => {
    const w = await forgeWorld();
    await w.call('queue_issue', { zoneId: 'main', issue: 40 });
    const card = w.card();
    const before = w.writes('setLabels').length;
    // Both presses read the card as done: the opKey dedupes the forge write.
    const results = await Promise.all([
      undoCard(w.db, w.forges, card, OWNER, t0),
      undoCard(w.db, w.forges, card, OWNER, t0),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, status: 409 });
    expect(w.writes('setLabels').length - before).toBe(1);
    expect(outboxRows(w.db).filter((r) => r.opKey === `labels:main:undo:${card.id}`)).toHaveLength(
      1,
    );
    expect(listAudit(w.db, 5).filter((a) => a.action === 'chat.undo')).toHaveLength(1);
  });

  test('D2 undo in observe mode refuses with no outbox row', async () => {
    const w = await forgeWorld();
    await w.call('queue_issue', { zoneId: 'main', issue: 40 });
    const card = w.card();
    const rows = outboxRows(w.db).length;
    setZoneMode(w.db, 'main', 'observe', t0);
    const u = await undoCard(w.db, w.forges, card, OWNER, t0);
    expect(u).toMatchObject({ ok: false, status: 409 });
    expect(!u.ok && u.error).toMatch(/observe/);
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect(await undoCard(w.db, w.forges, card, OWNER, t0)).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(outboxRows(w.db)).toHaveLength(rows);
    expect(w.f.state.issues.get(40)?.labels).toEqual([w.zone.readyLabel]);
    expect(w.card().state).toBe('done');
  });

  test('D2 the forge tools refuse in observe mode and under the kill switch with nothing written', async () => {
    const w = await forgeWorld();
    setZoneMode(w.db, 'main', 'observe', t0);
    expect((await w.call('queue_issue', { zoneId: 'main', issue: 40 })).isError).toBe(true);
    expect((await w.call('close_issue', { zoneId: 'main', issue: 42 })).isError).toBe(true);
    setZoneMode(w.db, 'main', 'active', t0);
    setKilled(w.db, true, t0);
    expect((await w.call('queue_issue', { zoneId: 'main', issue: 40 })).isError).toBe(true);
    expect(outboxRows(w.db)).toEqual([]);
    expect(listCards(w.db, w.one.id).map((c) => c.state)).toEqual([
      'refused',
      'refused',
      'refused',
    ]);
  });
});
