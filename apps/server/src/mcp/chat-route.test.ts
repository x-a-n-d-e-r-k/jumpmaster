import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { listCards } from '../chat/cards.js';
import type { Config, McpConfig } from '../config.js';
import { upsertDropZone } from '../db/repo.js';
import { crewOn, crewWorld } from '../test/crew.js';
import { makeZone, usageCfg } from '../test/fixtures.js';
import { t0 } from '../test/helpers.js';
import { mintChatToken, mintMcpToken } from './tokens.js';

const OP = 'o'.repeat(32);
/** How the chat service reaches the server on the compose network: not an allowed host. */
const CHAT_HOST = 'jumpmaster:7420';
const SESSION = 'f'.repeat(64);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(o: { mcp?: Partial<McpConfig> } = {}) {
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
      operatorToken: OP,
    },
    mcp: { enabled: true, ...o.mcp },
  } as Config;
  const logs: string[] = [];
  app = createApp({
    db: w.db,
    config,
    forgesFor: () => w.forges as never,
    now: () => t0,
    log: (msg: string) => logs.push(msg),
  });
  const write = mintMcpToken(w.db, { zoneId: 'main', scope: 'write', days: 30 }, t0);
  const read = mintMcpToken(w.db, { zoneId: 'main', scope: 'read', days: 30 }, t0);
  const chat = mintChatToken(
    w.db,
    { threadId: 11, messageId: 22, sessionHash: SESSION, minutes: 30 },
    t0,
  );
  return {
    ...w,
    config,
    logs,
    write: write.token,
    read: read.token,
    chat: chat.token,
    chatId: chat.id,
  };
}

const BASE = {
  host: CHAT_HOST,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function post(
  token: string | undefined,
  body: unknown,
  o: { url?: string; headers?: Record<string, string> } = {},
) {
  return (app as FastifyInstance).inject({
    method: 'POST',
    url: o.url ?? '/mcp/chat',
    headers: {
      ...BASE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...o.headers,
    },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let seq = 0;
type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function rpc(token: string, method: string, params: unknown = {}, url?: string) {
  const r = await post(
    token,
    { jsonrpc: '2.0', id: ++seq, method, params },
    url ? { url, headers: { host: '127.0.0.1:7420' } } : {},
  );
  expect(r.statusCode).toBe(200);
  return r.json() as { result?: unknown; error?: { code: number; message: string } };
}

async function call(
  token: string,
  name: string,
  args: unknown = {},
  url?: string,
): Promise<ToolResult> {
  const r = await rpc(token, 'tools/call', { name, arguments: args }, url);
  expect(r.error).toBeUndefined();
  return r.result as ToolResult;
}

const textOf = (r: ToolResult): string => r.content.map((c) => c.text).join('\n');
/** The per-response fence nonce, which differs on every call. */
const withoutNonce = (s: string): string =>
  s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'NONCE');

type AuditRow = {
  tokenId: number | null;
  zoneId: string | null;
  tool: string;
  outcome: string;
  detail: string;
};
const audit = (s: Setup): AuditRow[] =>
  s.db
    .prepare(
      `SELECT token_id AS tokenId, zone_id AS zoneId, tool, outcome, detail
         FROM mcp_audit WHERE tool NOT IN ('mint', 'revoke') ORDER BY id`,
    )
    .all() as AuditRow[];

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const READ_TOOLS = [
  'get_goals',
  'list_work',
  'get_work_item',
  'list_briefings',
  'list_rulings',
  'get_queue',
];
/** The chat's own read tools (Task 9), which take their own arguments. */
const CHAT_READ_TOOLS = [
  'list_sticks',
  'get_settings',
  'get_doctor_run',
  'list_open_issues',
  'list_open_pulls',
  'get_drop_transcript',
];
/** The zone write tools and the chat's action tools (Tasks 13 and 14): each records a card. */
const ACTION_TOOLS = [
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
];
const ALL_TOOLS = [...READ_TOOLS, ...CHAT_READ_TOOLS, ...ACTION_TOOLS].sort();

describe('/mcp/chat', () => {
  test('D1: a zone read or write token is refused on /mcp/chat', async () => {
    const s = await setup();
    for (const token of [s.read, s.write]) {
      const r = await post(token, LIST);
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await post(undefined, LIST)).statusCode).toBe(401);
    expect((await post(OP, LIST)).statusCode).toBe(401);
    expect(audit(s).every((a) => a.tool === 'auth' && a.outcome === 'refused')).toBe(true);
    expect(audit(s)).toHaveLength(4);
  });

  test('D1: a chat token is refused on /mcp', async () => {
    const s = await setup();
    const r = await post(s.chat, LIST, { url: '/mcp', headers: { host: '127.0.0.1:7420' } });
    expect(r.statusCode).toBe(401);
    expect(audit(s)).toEqual([
      expect.objectContaining({ tokenId: s.chatId, tool: 'auth', outcome: 'refused' }),
    ]);
    // The zone token still works there.
    const ok = await post(s.read, LIST, { url: '/mcp', headers: { host: '127.0.0.1:7420' } });
    expect(ok.statusCode).toBe(200);
  });

  test('CLAIM=PROOF: /mcp/chat answers with mcp.enabled false', async () => {
    const s = await setup({ mcp: { enabled: false } });
    const r = await post(s.chat, LIST);
    expect(r.statusCode).toBe(200);
    const tools = (r.json() as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    // /mcp itself stays unregistered.
    expect(
      (await post(s.read, LIST, { url: '/mcp', headers: { host: '127.0.0.1:7420' } })).statusCode,
    ).toBe(404);
  });

  test('D1: an Origin header on /mcp/chat is 403', async () => {
    const s = await setup();
    for (const origin of [
      'http://127.0.0.1:7420',
      'http://jumpmaster:7420',
      'null',
      'https://evil.example',
    ]) {
      const r = await post(s.chat, LIST, { headers: { origin } });
      expect(r.statusCode).toBe(403);
    }
    // Refused before the token is checked or the tool runs.
    expect(audit(s)).toEqual([]);
    expect(
      s.db.prepare('SELECT last_used_at AS u FROM mcp_tokens WHERE id = ?').get(s.chatId),
    ).toEqual({ u: null });
  });

  test('D1: a chat tool call with an unknown zoneId is refused unknown zone', async () => {
    const s = await setup();
    for (const args of [{ zoneId: 'nope' }, {}, { zoneId: 5 }, { zoneId: '*' }]) {
      const r = await call(s.chat, 'get_goals', args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/unknown zone/);
      expect(textOf(r)).not.toMatch(/lighthouse/i);
    }
    const rows = audit(s);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toEqual({
        tokenId: s.chatId,
        zoneId: null,
        tool: 'get_goals',
        outcome: 'refused',
        detail: 'unknown zone',
      });
    }
  });

  test('tools/list for a chat token lists the six zone read tools, each requiring zoneId, the chat read tools, and the action tools', async () => {
    const s = await setup();
    const r = await rpc(s.chat, 'tools/list');
    const tools = (
      r.result as {
        tools: {
          name: string;
          inputSchema: { properties?: Record<string, { type?: string }>; required?: string[] };
        }[];
      }
    ).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    for (const t of tools.filter((t) => READ_TOOLS.includes(t.name))) {
      expect(t.inputSchema.properties?.zoneId).toEqual(expect.objectContaining({ type: 'string' }));
      expect(t.inputSchema.required).toContain('zoneId');
    }
    expect(tools.find((t) => t.name === 'get_work_item')?.inputSchema.required).toEqual(
      expect.arrayContaining(['number', 'zoneId']),
    );
    // An action through the route acts as the chat, is audited, and records a card on the
    // token's own thread and message.
    const w = await call(s.chat, 'set_zone_mode', { zoneId: 'main', mode: 'paused' });
    expect(w.isError).toBeFalsy();
    expect(audit(s).at(-1)).toEqual(
      expect.objectContaining({ tokenId: s.chatId, tool: 'set_zone_mode', outcome: 'ok' }),
    );
    expect(listCards(s.db, 11)).toEqual([
      expect.objectContaining({ messageId: 22, kind: 'pause', state: 'done' }),
    ]);
  });

  test('D5: get_goals for zoneId main through a chat token answers what a main read token answers', async () => {
    const s = await setup();
    const viaChat = await call(s.chat, 'get_goals', { zoneId: 'main' });
    const viaRead = await call(s.read, 'get_goals', {}, '/mcp');
    expect(viaChat.isError).toBeFalsy();
    expect(textOf(viaChat)).toMatch(/Lighthouse/);
    expect(withoutNonce(textOf(viaChat))).toBe(withoutNonce(textOf(viaRead)));
    // The other zone answers for itself, not for main.
    expect(textOf(await call(s.chat, 'get_goals', { zoneId: 'other' }))).toMatch(/^Zone other/);
    // Extra arguments are still refused by the tool's own schema, after zoneId is taken off.
    const extra = await call(s.chat, 'get_goals', { zoneId: 'main', x: 1 });
    expect(extra.isError).toBe(true);
    expect(audit(s).at(-1)).toEqual(
      expect.objectContaining({ outcome: 'refused', detail: 'invalid arguments' }),
    );
  });

  test('D2: a tool that throws answers internal error and audits error', async () => {
    const s = await setup();
    s.db.exec('DROP TABLE goals');
    const r = await post(s.chat, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_goals', arguments: { zoneId: 'main' } },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { id: number; error?: { code: number; message: string } };
    expect(body.id).toBe(9);
    expect(body.error).toEqual({ code: -32603, message: 'internal error' });
    expect(audit(s).at(-1)).toEqual({
      tokenId: s.chatId,
      zoneId: 'main',
      tool: 'get_goals',
      outcome: 'error',
      detail: 'SQLITE_ERROR',
    });
    expect(s.logs.some((l) => l.includes('get_goals'))).toBe(true);
  });

  test('CLAIM=PROOF: each chat call is audited under the chat token id, whose row names the thread and message', async () => {
    const s = await setup();
    await call(s.chat, 'get_goals', { zoneId: 'main' });
    await call(s.chat, 'list_work', { zoneId: 'other' });
    await call(s.chat, 'get_queue', { zoneId: 'nope' });
    const rows = s.db
      .prepare(
        `SELECT a.tool, a.zone_id AS zoneId, a.outcome, t.scope, t.chat_thread_id AS threadId,
           t.chat_message_id AS messageId, t.session_hash AS sessionHash
           FROM mcp_audit a JOIN mcp_tokens t ON t.id = a.token_id
          WHERE a.tool NOT IN ('mint', 'revoke') ORDER BY a.id`,
      )
      .all();
    const chatRow = { scope: 'chat', threadId: 11, messageId: 22, sessionHash: SESSION };
    expect(rows).toEqual([
      { tool: 'get_goals', zoneId: 'main', outcome: 'ok', ...chatRow },
      { tool: 'list_work', zoneId: 'other', outcome: 'ok', ...chatRow },
      { tool: 'get_queue', zoneId: null, outcome: 'refused', ...chatRow },
    ]);
  });
});
