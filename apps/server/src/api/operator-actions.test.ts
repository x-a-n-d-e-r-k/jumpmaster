import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { type Principal, registerGuard } from '../auth/guard.js';
import { sha256Hex } from '../auth/sessions.js';
import { listRulings, raiseBriefing } from '../briefings.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import { getZoneMode, upsertDropZone } from '../db/repo.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { registerControlRoutes } from './control.js';
import {
  type ActionCtx,
  chatPrincipal,
  configPatchAction,
  crewCycleAction,
  ruleAction,
  zoneModeAction,
} from './operator-actions.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const env = {
  JM_CLAUDE_TOKEN: 'claude-secret-value-1',
  JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: TOKEN,
};
const zoneDoc = (id = 'main', extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
  ...extra,
});

const tokenP: Principal = { kind: 'operator', via: 'token', sudo: true };
const sessionP = (hash: string): Principal => ({
  kind: 'operator',
  via: 'session',
  sessionId: hash,
  sudo: false,
});
const chatP = (hash: string, threadId = 7, messageId = 42): Principal =>
  chatPrincipal({ tokenId: 1, scope: 'chat', threadId, messageId, sessionHash: hash });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A db-mode store with zone main applied by the token, and the control routes over it. */
function storeWorld() {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-actions-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, join(dir, 'jumpmaster.config.json')),
    filePath: join(dir, 'jumpmaster.config.json'),
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const seeded = store.apply({ dropZones: [zoneDoc()] }, { via: 'ctl', principal: tokenP });
  if (!seeded.ok) throw new Error(`seed failed: ${JSON.stringify(seeded)}`);
  upsertDropZone(db, { id: 'main', repo: 'octo/main', defaultBranch: 'main', configJson: '{}' });
  const a = Fastify();
  registerGuard(a, { db, config: store, now: () => t0 });
  registerControlRoutes(a, { db, config: store, now: () => t0 });
  app = a;
  const session = operatorSession(db);
  return {
    db,
    store,
    headers: { ...session.headers, host: HOST },
    hash: sha256Hex(session.id),
    ctx: (principal: Principal): ActionCtx => ({
      db,
      now: () => t0,
      config: store.current(),
      principal,
      secrets: [],
    }),
  };
}

/** A db and config with zone main and an open briefing, the control routes over the config. */
function ruleWorld(zone = makeZone({ id: 'main' })) {
  const db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
  const config = {
    listen: { host: '127.0.0.1', port: 7420 },
    dropZones: [zone],
    secrets: { operatorToken: TOKEN },
  } as unknown as Config;
  const kicks: string[] = [];
  const a = Fastify();
  registerGuard(a, { db, config, now: () => t0 });
  registerControlRoutes(a, { db, config, now: () => t0, kick: () => kicks.push('kick') });
  app = a;
  const session = operatorSession(db);
  const briefing = () =>
    raiseBriefing(
      db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: `goal change ${Math.random()}`,
        decision: 'd',
        why: 'w',
        options: [
          { id: 'yes', label: 'Yes', effect: 'none' },
          { id: 'no', label: 'No', effect: 'none' },
        ],
        source: 'crew',
      },
      t0,
    );
  return {
    db,
    kicks,
    briefing,
    headers: { ...session.headers, host: HOST },
    hash: sha256Hex(session.id),
    ctx: (principal: Principal): ActionCtx => ({
      db,
      now: () => t0,
      config,
      principal,
      secrets: [],
      kick: () => kicks.push('kick'),
    }),
  };
}

const rulingRows = (db: Db, briefingId: number) =>
  db
    .prepare(
      `SELECT zone_id, briefing_id, choice, note, created_at, choice_label, choice_effect
       FROM rulings WHERE briefing_id = ?`,
    )
    .all(briefingId) as Record<string, unknown>[];

describe('chatPrincipal', () => {
  test('a chat principal is an operator via chat, carrying the session hash and the turn', () => {
    expect(
      chatPrincipal({ tokenId: 3, scope: 'chat', threadId: 5, messageId: 9, sessionHash: 'abc' }),
    ).toEqual({
      kind: 'operator',
      via: 'chat',
      sessionId: 'abc',
      sudo: false,
      chat: { threadId: 5, messageId: 9 },
    });
  });
});

describe('configPatchAction', () => {
  const removeProtected = { dropZones: [{ id: 'main', protectedPaths: ['GOAL.md'] }] };

  test('D5 a chat principal and a session get the same 409 needsConfirmation for the same guarded patch', async () => {
    const w = storeWorld();
    const asSession = configPatchAction(w.ctx(sessionP(w.hash)), w.store, removeProtected, {});
    const asChat = configPatchAction(w.ctx(chatP(w.hash)), w.store, removeProtected, {});
    expect(asSession.ok).toBe(false);
    expect(asChat.ok).toBe(false);
    if (asSession.ok || asChat.ok) return;
    expect(asSession.status).toBe(409);
    expect(asChat.status).toBe(409);
    expect(asChat.body).toMatchObject({ needsConfirmation: true, confirm: expect.any(String) });
    expect(asChat.body?.guarded).toEqual(asSession.body?.guarded);
    expect([...new Set((asChat.body?.guarded as { path: string }[]).map((g) => g.path))]).toEqual([
      'dropZones[main].protectedPaths',
    ]);
    // The PATCH route answers a session the same way.
    const res = await app?.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: w.headers,
      payload: { patch: removeProtected, expectRevision: w.store.revision() },
    });
    expect(res?.statusCode).toBe(409);
    const http = res?.json() as Record<string, unknown>;
    expect(Object.keys(http).sort()).toEqual(Object.keys(asChat.body ?? {}).sort());
    expect(http.guarded).toEqual(asChat.body?.guarded);
    // The chat's pending change is bound to the browser session it carries.
    const pendingId = String(asChat.body?.pendingId);
    expect(w.store.confirmations.pending(pendingId, w.hash)).toBeDefined();
    expect(asChat.body?.confirm).toBe(`/config/confirm/${pendingId}`);
    expect(w.store.current().dropZones[0]?.protectedPaths).not.toEqual(['GOAL.md']);
  });

  test('D5 a chat principal and a session get the same 403 for a browser-forbidden path', async () => {
    const w = storeWorld();
    const patch = { dropZones: [{ id: 'main', image: 'jm-trooper:other' }] };
    const asSession = configPatchAction(w.ctx(sessionP(w.hash)), w.store, patch, {});
    const asChat = configPatchAction(w.ctx(chatP(w.hash)), w.store, patch, {});
    if (asSession.ok || asChat.ok) throw new Error('expected refusals');
    expect(asSession.status).toBe(403);
    expect(asChat.status).toBe(403);
    expect(asChat.body).toEqual({
      sessionForbidden: ['dropZones[main].image'],
      hint: expect.any(String),
    });
    expect(asChat.body).toEqual(asSession.body);
    const res = await app?.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: w.headers,
      payload: { patch, expectRevision: w.store.revision() },
    });
    expect(res?.statusCode).toBe(403);
    expect(res?.json()).toEqual(asChat.body);
    expect(w.store.current().dropZones[0]?.image).toBe('jm-trooper:dev');
  });

  test('D1 a chat principal never skips confirmation the way the token does', () => {
    const w = storeWorld();
    const before = w.store.revision();
    const asChat = configPatchAction(w.ctx(chatP(w.hash)), w.store, removeProtected, {});
    expect(asChat.ok).toBe(false);
    if (asChat.ok) return;
    expect(asChat.status).toBe(409);
    expect(asChat.body?.needsConfirmation).toBe(true);
    expect(w.store.revision()).toBe(before);
    const asToken = configPatchAction(w.ctx(tokenP), w.store, removeProtected, {});
    expect(asToken.ok).toBe(true);
    expect(w.store.revision()).toBe(before + 1);
    expect(w.store.current().dropZones[0]?.protectedPaths).toEqual(['GOAL.md']);
  });

  test('D2 a chat principal without a session hash cannot propose a guarded change', () => {
    const w = storeWorld();
    const before = w.store.revision();
    const { sessionId: _, ...noHash } = chatP(w.hash);
    const r = configPatchAction(w.ctx(noHash), w.store, removeProtected, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).not.toBe(409);
    expect(r.body?.needsConfirmation).toBeUndefined();
    expect(w.store.revision()).toBe(before);
  });

  test('a chat apply is recorded as revision via ui with a note naming the thread and message', () => {
    const w = storeWorld();
    const r = configPatchAction(w.ctx(chatP(w.hash, 3, 11)), w.store, { pollSeconds: 45 }, {});
    expect(r.ok).toBe(true);
    const rev = w.db
      .prepare('SELECT via, note FROM config_revisions ORDER BY id DESC LIMIT 1')
      .get() as { via: string; note: string };
    expect(rev).toEqual({ via: 'ui', note: 'chat thread 3 message 11' });
    const [row] = listAudit(w.db, 1);
    expect(row).toMatchObject({
      via: 'chat',
      action: 'config.apply',
      detail: { thread: 3, message: 11 },
    });
  });

  test('a stale revision is a 409 conflict', () => {
    const w = storeWorld();
    const r = configPatchAction(
      w.ctx(chatP(w.hash)),
      w.store,
      { pollSeconds: 45 },
      {
        expectRevision: 1,
      },
    );
    if (r.ok) throw new Error('expected a conflict');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ conflict: { expected: 1, actual: w.store.revision() } });
  });
});

describe('ruleAction', () => {
  test('D5 ruleAction as chat records the same ruling, effect and audit action as POST /api/control/briefings/:id/rule', async () => {
    const w = ruleWorld();
    const viaHttp = w.briefing();
    const viaChat = w.briefing();
    const res = await app?.inject({
      method: 'POST',
      url: `/api/control/briefings/${viaHttp}/rule`,
      headers: w.headers,
      payload: { optionId: 'yes', note: 'fine' },
    });
    expect(res?.statusCode).toBe(200);
    const r = ruleAction(w.ctx(chatP(w.hash)), viaChat, 'yes', 'fine', {});
    expect(r).toEqual({ ok: true, value: { rulingId: expect.any(Number) } });
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map(({ briefing_id: _, ...rest }) => rest);
    expect(rulingRows(w.db, viaChat)).toHaveLength(1);
    expect(strip(rulingRows(w.db, viaChat))).toEqual(strip(rulingRows(w.db, viaHttp)));
    const [chatRow, httpRow] = listAudit(w.db, 2);
    expect(chatRow?.action).toBe(httpRow?.action);
    expect(chatRow?.action).toBe('briefing.rule');
    expect(chatRow?.target).toBe(`briefing:${viaChat}`);
    expect(httpRow?.via).toBe('session');
    expect(w.kicks).toEqual(['kick', 'kick']);
  });

  test('CLAIM=PROOF a chat action audit row has via chat and the thread and message ids', () => {
    const w = ruleWorld(
      makeZone({ id: 'main', crew: { ...makeZone().crew, enabled: true } as never }),
    );
    const id = w.briefing();
    expect(ruleAction(w.ctx(chatP(w.hash, 12, 34)), id, 'no', '', {}).ok).toBe(true);
    expect(zoneModeAction(w.ctx(chatP(w.hash, 12, 35)), 'main', 'paused').ok).toBe(true);
    const rows = w.db
      .prepare('SELECT via, action, detail_json AS d FROM control_audit ORDER BY id')
      .all() as { via: string; action: string; d: string }[];
    expect(rows.map((r) => [r.via, r.action, JSON.parse(r.d)])).toEqual([
      [
        'chat',
        'briefing.rule',
        { optionId: 'no', rulingId: expect.any(Number), thread: 12, message: 34 },
      ],
      ['chat', 'zone.mode', { mode: 'paused', thread: 12, message: 35 }],
    ]);
  });

  test('D3 two rulings on one briefing, chat and browser at once, give one ruling and one 409', async () => {
    const w = ruleWorld();
    const id = w.briefing();
    const [http, chat] = await Promise.all([
      app?.inject({
        method: 'POST',
        url: `/api/control/briefings/${id}/rule`,
        headers: w.headers,
        payload: { optionId: 'yes' },
      }),
      Promise.resolve().then(() => ruleAction(w.ctx(chatP(w.hash)), id, 'no', '', {})),
    ]);
    const statuses = [http?.statusCode, chat.ok ? 200 : chat.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(listRulings(w.db, 'main')).toHaveLength(1);
    expect(listAudit(w.db).filter((a) => a.action === 'briefing.rule')).toHaveLength(1);
  });

  test('an unknown briefing is a 404, an unknown option a 400, and neither is audited', () => {
    const w = ruleWorld();
    const id = w.briefing();
    const unknown = ruleAction(w.ctx(chatP(w.hash)), 999, 'yes', '', {});
    expect(unknown).toMatchObject({ ok: false, status: 404, error: 'unknown briefing' });
    const bad = ruleAction(w.ctx(chatP(w.hash)), id, 'maybe', '', {});
    expect(bad).toMatchObject({ ok: false, status: 400, error: 'unknown option' });
    expect(listAudit(w.db)).toEqual([]);
  });
});

describe('zone actions', () => {
  test('zoneModeAction sets the mode and refuses an unknown zone', () => {
    const w = ruleWorld();
    expect(zoneModeAction(w.ctx(chatP(w.hash)), 'main', 'paused')).toEqual({
      ok: true,
      value: { mode: 'paused' },
    });
    expect(getZoneMode(w.db, 'main', 'active')).toBe('paused');
    expect(zoneModeAction(w.ctx(chatP(w.hash)), 'nope', 'paused')).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  test('crewCycleAction asks for a cycle only where the crew is enabled', () => {
    const off = ruleWorld();
    expect(crewCycleAction(off.ctx(chatP(off.hash)), 'main')).toMatchObject({
      ok: false,
      status: 409,
      error: 'crew is not enabled',
    });
    const on = ruleWorld(
      makeZone({ id: 'main', crew: { ...makeZone().crew, enabled: true } as never }),
    );
    expect(crewCycleAction(on.ctx(chatP(on.hash, 1, 2)), 'main')).toEqual({
      ok: true,
      value: { crewCycle: 'due' },
    });
    expect(listAudit(on.db, 1)[0]).toMatchObject({
      via: 'chat',
      action: 'zone.crew-cycle',
      target: 'main',
      detail: { thread: 1, message: 2 },
    });
    expect(on.kicks).toEqual(['kick']);
  });
});
