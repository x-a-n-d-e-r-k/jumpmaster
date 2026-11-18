import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { registerControlRoutes } from '../api/control.js';
import type { ActionCtx } from '../api/operator-actions.js';
import { createApp } from '../app.js';
import { listAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import { type Principal, registerGuard } from '../auth/guard.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { sha256Hex } from '../auth/sessions.js';
import {
  applyPendingRulings,
  getBriefing,
  listBriefings,
  listRulings,
  raiseBriefing,
} from '../briefings.js';
import { type ChatCard, listCards, renderCard, undoSettingCard } from '../chat/cards.js';
import { createThread } from '../chat/store.js';
import { loadBoot } from '../config/boot.js';
import { mergeConfigPatch } from '../config/diff.js';
import { ConfigStore } from '../config/store.js';
import type { Config } from '../config.js';
import { flushCrewOps } from '../crew/flush.js';
import { listCrewIssues } from '../crew/store.js';
import { openDb } from '../db/open.js';
import { getZoneMode, setKilled, setUsageState, upsertDropZone } from '../db/repo.js';
import { listGoalChanges, openGoalChange } from '../goal-change.js';
import { objectivesDone } from '../goals.js';
import { crewOn, crewWorld, GOAL, ISSUE_BODY } from '../test/crew.js';
import { makeZone, usageCfg } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
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
        'change_setting',
        'propose_goal_change',
      ].sort(),
    );
    const byName = new Map(listTools('chat', { actions: true }).map((t) => [t.name, t]));
    for (const name of [
      'file_staged_issues',
      'raise_briefing',
      'set_zone_mode',
      'run_crew_cycle',
      'propose_goal_change',
    ]) {
      expect(byName.get(name)?.inputSchema.required).toContain('zoneId');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// change_setting (Task 15): through the config store, as the browser session the chat acts for.

const PASS = 'a long operator passphrase';
const ORIGIN = `http://${HOST}`;
const storeEnv = {
  JM_CLAUDE_TOKEN: 'claude-secret-value-1',
  JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};
const tokenP: Principal = { kind: 'operator', via: 'token', sudo: true };
const mainZone = {
  id: 'main',
  repo: 'octo/main',
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
};

/**
 * A store-backed install with zone main, the app over it (the confirm page and the PATCH route),
 * two browser sessions, and a chat token minted for a message session one posted.
 */
async function settingWorld(o: { fileMode?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-chat-setting-'));
  const file = join(dir, 'jumpmaster.config.json');
  if (o.fileMode) writeFileSync(file, JSON.stringify({ dataDir: './data', dropZones: [mainZone] }));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, file),
    filePath: file,
    env: storeEnv,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  if (!o.fileMode) {
    const seeded = store.apply({ dropZones: [mainZone] }, { via: 'ctl', principal: tokenP });
    if (!seeded.ok) throw new Error(`seed failed: ${JSON.stringify(seeded)}`);
  }
  upsertDropZone(db, { id: 'main', repo: 'octo/main', defaultBranch: 'main', configJson: '{}' });
  await setOperatorPassphrase(db, PASS, t0);
  const app = createApp({
    db,
    config: store,
    forgesFor: () => ({}) as never,
    now: () => t0,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  close = () => app.close();
  const one = operatorSession(db);
  const two = operatorSession(db);
  const thread = createThread(db, { title: 'settings' }, t0);
  const minted = mintChatToken(
    db,
    { threadId: thread.id, messageId: 31, sessionHash: sha256Hex(one.id), minutes: 30 },
    t0,
  );
  const c = checkMcpToken(db, minted.token, t0);
  if (!c.ok) throw new Error('chat token did not check');
  const principal = c.principal as ChatPrincipal;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await callTool(
      { db, config: store.current(), store, principal, now: () => t0, actions: true },
      name,
      args,
    );
    return { ...r, text: (r.content[0] as { text: string }).text };
  };
  const tokenIn = (html: string) => /name="token" value="([\w-]+)"/.exec(html)?.[1] as string;
  const confirmAs = async (id: string, s: typeof one) => {
    const page = await app.inject({
      method: 'GET',
      url: `/config/confirm/${id}`,
      headers: { host: HOST, cookie: s.cookie },
    });
    if (page.statusCode !== 200) return page;
    return app.inject({
      method: 'POST',
      url: `/config/confirm/${id}`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: s.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token: tokenIn(page.body), passphrase: PASS }).toString(),
    });
  };
  const actx = (): ActionCtx => ({
    db,
    now: () => t0,
    config: store.current(),
    principal: sessionPrincipal(sha256Hex(one.id)),
    secrets: [],
  });
  return { db, store, app, one, two, thread, principal, call, confirmAs, actx };
}

const sessionPrincipal = (hash: string): Principal => ({
  kind: 'operator',
  via: 'session',
  sessionId: hash,
  sudo: false,
});

const zoneOf = (store: ConfigStore) => store.current().dropZones[0];

describe('change_setting', () => {
  test('a free setting applies as the chat, with a done card that can be undone', async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].maxOpenPrs': 4 },
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(w.store.revision()).toBe(before + 1);
    expect(zoneOf(w.store)?.maxOpenPrs).toBe(4);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ kind: 'setting', state: 'done', zoneId: 'main' });
    expect(card?.summary).toContain('Most open pull requests');
    expect(card?.summary).toContain(`revision ${before + 1}`);
    expect(card?.undo).toMatchObject({ revision: before + 1 });
    expect(renderCard(card as never)).toMatch(/Undo/);
    const audit = listAudit(w.db, 1)[0];
    expect(audit).toMatchObject({ via: 'chat', action: 'config.apply' });
    expect(audit?.detail).toMatchObject({ thread: w.thread.id, message: 31 });
    // Undo restores it, and marks the card undone.
    const undone = undoSettingCard(w.actx(), w.store, card as ChatCard);
    expect(undone.ok).toBe(true);
    expect(zoneOf(w.store)?.maxOpenPrs).toBeUndefined();
    expect(listCards(w.db, w.thread.id)[0]).toMatchObject({ state: 'undone' });
    // A card already undone is refused.
    const again = undoSettingCard(w.actx(), w.store, listCards(w.db, w.thread.id)[0] as ChatCard);
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  test('D5 change_setting on a guarded path answers pending with the same pendingId shape the PATCH route gives a session, and its card offers Confirm linking /config/confirm/<id>', async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].protectedPaths': ['GOAL.md'] },
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(w.store.revision()).toBe(before);
    const answer = JSON.parse(r.text) as Record<string, unknown>;
    const http = await w.app.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: { host: HOST, cookie: w.two.cookie, 'x-jm-csrf': w.two.csrf },
      payload: {
        patch: { dropZones: [{ id: 'main', protectedPaths: ['GOAL.md'] }] },
        expectRevision: before,
      },
    });
    expect(http.statusCode).toBe(409);
    const body = http.json() as Record<string, unknown>;
    expect(answer).toMatchObject({
      needsConfirmation: true,
      pendingId: expect.any(String),
      confirm: `/config/confirm/${answer.pendingId}`,
    });
    for (const k of Object.keys(body)) expect(answer).toHaveProperty(k);
    expect(String(answer.pendingId)).toMatch(
      new RegExp(`^[\\w-]{${String(body.pendingId).length}}$`),
    );
    expect(answer.guarded).toEqual(body.guarded);
    // Bound to the session that posted the owner's message, returning to the thread.
    const pending = w.store.confirmations.pending(String(answer.pendingId), sha256Hex(w.one.id));
    expect(pending).toBeDefined();
    expect(pending?.returnTo).toBe(`/chat/${w.thread.id}`);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({
      kind: 'setting',
      state: 'pending',
      link: `/config/confirm/${answer.pendingId}`,
      undo: null,
    });
    const html = renderCard(card as never);
    expect(html).toContain(`href="/config/confirm/${answer.pendingId}"`);
    expect(html).toMatch(/>Confirm</);
    expect(html).not.toMatch(/Undo/);
  });

  test("D5 confirming the chat's pending change on the confirm page with the posting session applies it", async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].protectedPaths': ['GOAL.md'] },
    });
    const { pendingId } = JSON.parse(r.text) as { pendingId: string };
    const res = await w.confirmAs(pendingId, w.one);
    // Applied, the page goes back to the thread.
    expect(res.statusCode, res.body).toBe(303);
    expect(res.headers.location).toBe(`/chat/${w.thread.id}`);
    expect(w.store.revision()).toBe(before + 1);
    expect(zoneOf(w.store)?.protectedPaths).toEqual(['GOAL.md']);
  });

  test("D1 a different browser session cannot confirm the chat's pending change", async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].protectedPaths': ['GOAL.md'] },
    });
    const { pendingId } = JSON.parse(r.text) as { pendingId: string };
    const res = await w.confirmAs(pendingId, w.two);
    expect(res.statusCode).toBe(404);
    const post = await w.app.inject({
      method: 'POST',
      url: `/config/confirm/${pendingId}`,
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: w.two.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token: 'x'.repeat(43), passphrase: PASS }).toString(),
    });
    expect(post.statusCode).toBe(404);
    expect(w.store.revision()).toBe(before);
  });

  test('D5 a browser-forbidden path is refused 403 and the card says to use jumpmaster ctl or the config file', async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].image': 'evil/image:latest' },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/403/);
    expect(w.store.revision()).toBe(before);
    expect(zoneOf(w.store)?.image).toBe('jm-trooper:dev');
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ kind: 'setting', state: 'refused', undo: null });
    expect(card?.summary).toContain('set it with `jumpmaster ctl` or in the config file');
    expect(card?.summary).not.toContain('evil/image');
  });

  test('a path the catalog does not name is refused, and the card names no text the model gave', async () => {
    const w = await settingWorld();
    const r = await w.call('change_setting', { zoneId: 'main', set: { 'dropZones[].repo2': 'x' } });
    expect(r.isError).toBe(true);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ kind: 'setting', state: 'refused' });
    expect(card?.summary).not.toContain('repo2');
  });

  test("a value the store refuses is refused with fixed words on the card, never the store's message quoting it", async () => {
    const w = await settingWorld();
    const before = w.store.revision();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].crew.goalPath': 'MODEL-CHOSEN-TEXT.md' },
    });
    expect(r.isError).toBe(true);
    expect(w.store.revision()).toBe(before);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ kind: 'setting', state: 'refused' });
    expect(card?.summary).toContain('the config store refused the value');
    expect(card?.summary).not.toContain('MODEL-CHOSEN-TEXT');
  });

  test('Undo of an object-valued setting removes the keys the change added', async () => {
    const w = await settingWorld();
    const seeded = w.store.apply(
      mergeConfigPatch(w.store.document(), {
        dropZones: [{ id: 'main', models: { review: 'claude-sonnet-5-5' } }],
      }),
      { via: 'ctl', principal: tokenP },
    );
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].models': { implement: 'claude-opus-5-5' } },
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(zoneOf(w.store)?.models).toEqual({
      review: 'claude-sonnet-5-5',
      implement: 'claude-opus-5-5',
    });
    const [card] = listCards(w.db, w.thread.id);
    const u = undoSettingCard(w.actx(), w.store, card as ChatCard);
    expect(u.ok).toBe(true);
    expect(zoneOf(w.store)?.models).toEqual({ review: 'claude-sonnet-5-5' });
    expect(listCards(w.db, w.thread.id)[0]).toMatchObject({ state: 'undone' });
  });

  test("Review Focus 4 Undo refuses with changed since when the path's value moved after the change", async () => {
    const w = await settingWorld();
    await w.call('change_setting', { zoneId: 'main', set: { 'dropZones[].maxOpenPrs': 4 } });
    const [card] = listCards(w.db, w.thread.id);
    // Someone else sets it again.
    const moved = w.store.apply(
      mergeConfigPatch(w.store.document(), { dropZones: [{ id: 'main', maxOpenPrs: 9 }] }),
      { via: 'ctl', principal: tokenP },
    );
    expect(moved.ok).toBe(true);
    const rev = w.store.revision();
    const r = undoSettingCard(w.actx(), w.store, card as ChatCard);
    expect(r).toMatchObject({ ok: false, status: 409 });
    if (r.ok) return;
    expect(r.error).toMatch(/changed since/);
    expect(w.store.revision()).toBe(rev);
    expect(zoneOf(w.store)?.maxOpenPrs).toBe(9);
    expect(listCards(w.db, w.thread.id)[0]).toMatchObject({ state: 'done' });
  });

  test('an Undo that would loosen a guard goes pending like any other change', async () => {
    const w = await settingWorld();
    const tighter = [...(zoneOf(w.store)?.protectedPaths ?? []), 'docs/**'];
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].protectedPaths': tighter },
    });
    expect(r.isError, r.text).toBeFalsy();
    expect(zoneOf(w.store)?.protectedPaths).toEqual(tighter);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ state: 'done' });
    const rev = w.store.revision();
    const u = undoSettingCard(w.actx(), w.store, card as ChatCard);
    expect(u).toMatchObject({ ok: false, status: 409 });
    if (u.ok) return;
    expect(u.body).toMatchObject({ needsConfirmation: true, pendingId: expect.any(String) });
    expect(w.store.revision()).toBe(rev);
    expect(zoneOf(w.store)?.protectedPaths).toEqual(tighter);
  });

  test("D2 change_setting in file mode is refused with the store's file-mode message and no revision", async () => {
    const w = await settingWorld({ fileMode: true });
    expect(w.store.mode()).toBe('file');
    const before = w.store.revision();
    const revs = () =>
      (w.db.prepare('SELECT COUNT(*) AS n FROM config_revisions').get() as { n: number }).n;
    const count = revs();
    const r = await w.call('change_setting', {
      zoneId: 'main',
      set: { 'dropZones[].maxOpenPrs': 4 },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/config is managed by the file/);
    expect(w.store.revision()).toBe(before);
    expect(revs()).toBe(count);
    const [card] = listCards(w.db, w.thread.id);
    expect(card).toMatchObject({ kind: 'setting', state: 'refused' });
    expect(card?.summary).toMatch(/config is managed by the file/);
  });
});
