import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { registerControlRoutes } from '../api/control.js';
import { listAudit } from '../auth/audit.js';
import { registerGuard } from '../auth/guard.js';
import {
  applyPendingRulings,
  getBriefing,
  listBriefings,
  listRulings,
  raiseBriefing,
} from '../briefings.js';
import { listCards, renderCard } from '../chat/cards.js';
import { createThread } from '../chat/store.js';
import type { Config } from '../config.js';
import { flushCrewOps } from '../crew/flush.js';
import { listCrewIssues } from '../crew/store.js';
import { getZoneMode, setKilled, setUsageState, upsertDropZone } from '../db/repo.js';
import { objectivesDone } from '../goals.js';
import { crewOn, crewWorld, ISSUE_BODY } from '../test/crew.js';
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
      ].sort(),
    );
    const byName = new Map(listTools('chat', { actions: true }).map((t) => [t.name, t]));
    for (const name of [
      'file_staged_issues',
      'raise_briefing',
      'set_zone_mode',
      'run_crew_cycle',
    ]) {
      expect(byName.get(name)?.inputSchema.required).toContain('zoneId');
    }
  });
});
