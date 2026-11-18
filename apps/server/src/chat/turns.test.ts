import type { ChatEvent, ChatTurnRequest } from '@jumpmaster/protocol';
import { describe, expect, test, vi } from 'vitest';
import type { Config, DropZoneConfig } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import {
  getDrop,
  getUsageState,
  listUsageWindows,
  setUsageState,
  upsertDropZone,
} from '../db/repo.js';
import type { AppTokenSource, FreshToken } from '../forge/app-tokens.js';
import { checkMcpToken } from '../mcp/tokens.js';
import { makeZone } from '../test/fixtures.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import { dispatchGate } from '../usage.js';
import type { AppEntryRead } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import type { ChatServiceClient } from './service.js';
import {
  appendMessage,
  type ChatMessage,
  createThread,
  getThread,
  listMessages,
  setThreadSession,
} from './store.js';
import {
  ChatTurns,
  chatMcpUrl,
  chatRateLimitSource,
  GATE_REFUSAL,
  HISTORY_MAX_CHARS,
  type HubEvent,
  SERVICE_STOPPED,
} from './turns.js';

// Built at runtime so no token-shaped literal sits in the tracked file.
const CLAUDE = ['sk', 'ant', 'oat01', 'CHATTURNCLAUDETOKEN0123456789'].join('-');
const READ_PAT = ['github', 'pat', 'CHATTURNREADREADREAD3456'].join('_');
// Not token-shaped and not a configured secret: only the turn's own list can redact it.
const APP_READ = 'reviewer-read-NOTSHAPED-7f3a9c';

type Script = (req: ChatTurnRequest, signal: AbortSignal, n: number) => AsyncIterable<ChatEvent>;

function fakeService(script: Script) {
  const requests: ChatTurnRequest[] = [];
  const client: ChatServiceClient = {
    runTurn(req, signal) {
      requests.push(req);
      return script(req, signal, requests.length);
    },
    health: async () => null,
  };
  return { client, requests };
}

const done = (text = 'ok'): Script =>
  async function* () {
    yield { type: 'text', text };
    yield { type: 'result', isError: false };
  };

function deferred() {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
}

const reviewerEntry: AppEntryRead = {
  source: 'vault',
  fingerprint: 'fp-r',
  entry: { appId: '43', slug: 'jm-reviewer', clientId: 'c', pem: 'pem', importedAt: '2026-11-01' },
};
const appsFor = (owner: string): ResolvedApps =>
  new Map([[owner, { author: { source: 'missing' }, reviewer: reviewerEntry }]]);

const patZone = makeZone({ id: 'main', repo: 'acme/demo' });
const appZone = makeZone({
  id: 'app',
  repo: 'octo/app',
  githubApp: { repositoryId: 6660, installations: { reviewer: 88 } },
});

function configOf(o: {
  zones?: DropZoneConfig[];
  read?: boolean;
  chat?: Partial<Config['chat']>;
}): Config {
  return {
    listen: { host: '0.0.0.0', port: 7420 },
    dataDir: '/data',
    pollSeconds: 60,
    dropZones: o.zones ?? [patZone],
    usage: { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] },
    claude: { plan: 'max', fableWeeklyDropCap: 0 },
    chat: o.chat ?? {},
    secrets: {
      claudeToken: CLAUDE,
      githubAuthorToken: ['github', 'pat', 'CHATTURNAUTHORAUTHOR9999'].join('_'),
      ...(o.read === false ? {} : { githubReadToken: READ_PAT }),
      joinToken: 'join-me',
      operatorToken: 'o'.repeat(32),
    },
  } as Config;
}

function fakeAppTokens(token = APP_READ) {
  const revoke = vi.fn(async () => {});
  const fresh = vi.fn(
    async (): Promise<FreshToken> => ({ token, expiresAt: new Date(), owner: 'octo', revoke }),
  );
  const source: Pick<AppTokenSource, 'fresh'> = { fresh };
  return { source, fresh, revoke };
}

function world(
  script: Script,
  o: {
    config?: Config;
    apps?: ResolvedApps;
    appTokens?: Pick<AppTokenSource, 'fresh'>;
  } = {},
) {
  const db: Db = openDb(tmpDbFile());
  const config = o.config ?? configOf({});
  for (const z of config.dropZones) {
    upsertDropZone(db, { id: z.id, repo: z.repo, defaultBranch: 'trunk', configJson: '{}' });
  }
  const service = fakeService(script);
  const lines: string[] = [];
  const log = vi.fn((m: string) => {
    lines.push(m);
  });
  let clock = t0;
  const turns = new ChatTurns({
    db,
    config,
    now: () => clock,
    service: service.client,
    mcpUrl: chatMcpUrl(7420),
    resolvedApps: () => o.apps ?? new Map(),
    ...(o.appTokens ? { appTokens: o.appTokens } : {}),
    log,
  });
  const owner = (threadId: number, text: string): ChatMessage =>
    appendMessage(db, threadId, { role: 'owner', text, state: 'queued', sessionHash: 'h' }, clock);
  return {
    db,
    turns,
    service,
    lines,
    owner,
    advance(ms: number) {
      clock = plus(clock, ms);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const messageById = (db: Db, threadId: number, id: number) =>
  listMessages(db, threadId).find((m) => m.id === id);

describe('ChatTurns', () => {
  test('a second message waits for the running turn', async () => {
    const gate = deferred();
    const w = world(async function* (req, _s, n) {
      if (n === 1) await gate.p;
      yield { type: 'text', text: `reply to ${req.prompt}` };
      yield { type: 'result', isError: false };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    const first = w.owner(th.id, 'one');
    w.turns.enqueue(th.id);
    const second = w.owner(th.id, 'two');
    w.turns.enqueue(th.id);
    const third = w.owner(th.id, 'three');
    w.turns.enqueue(th.id);
    await settle();
    expect(w.service.requests.map((r) => r.prompt)).toEqual(['one']);
    expect(messageById(w.db, th.id, first.id)?.state).toBe('running');
    expect(messageById(w.db, th.id, second.id)?.state).toBe('queued');
    gate.open();
    await w.turns.idle();
    expect(w.service.requests.map((r) => r.prompt)).toEqual(['one', 'two', 'three']);
    for (const m of [first, second, third]) {
      expect(messageById(w.db, th.id, m.id)?.state).toBe('done');
    }
    const assistant = listMessages(w.db, th.id).filter((m) => m.role === 'assistant');
    expect(assistant.map((m) => m.text)).toEqual([
      'reply to one',
      'reply to two',
      'reply to three',
    ]);
  });

  test('turns beyond chat.maxConcurrentTurns wait', async () => {
    const gate = deferred();
    const w = world(
      async function* (_r, _s, n) {
        if (n === 1) await gate.p;
        yield { type: 'result', isError: false };
      },
      { config: configOf({ chat: { maxConcurrentTurns: 1 } }) },
    );
    const a = createThread(w.db, { title: 'a' }, t0);
    const b = createThread(w.db, { title: 'b' }, t0);
    w.owner(a.id, 'in a');
    w.turns.enqueue(a.id);
    w.owner(b.id, 'in b');
    w.turns.enqueue(b.id);
    await settle();
    expect(w.service.requests.map((r) => r.prompt)).toEqual(['in a']);
    gate.open();
    await w.turns.idle();
    expect(w.service.requests.map((r) => r.prompt)).toEqual(['in a', 'in b']);
  });

  test('two threads run in parallel under the cap', async () => {
    const gate = deferred();
    const w = world(async function* () {
      await gate.p;
      yield { type: 'result', isError: false };
    });
    const a = createThread(w.db, { title: 'a' }, t0);
    const b = createThread(w.db, { title: 'b' }, t0);
    w.owner(a.id, 'in a');
    w.turns.enqueue(a.id);
    w.owner(b.id, 'in b');
    w.turns.enqueue(b.id);
    await settle();
    expect(w.service.requests).toHaveLength(2);
    gate.open();
    await w.turns.idle();
  });

  test('a dropped stream fails the message and revokes the token', async () => {
    const apps = fakeAppTokens();
    const w = world(
      async function* () {
        yield { type: 'text', text: 'half an' };
        throw new Error('socket hang up');
      },
      {
        config: configOf({ zones: [patZone, appZone] }),
        apps: appsFor('octo'),
        appTokens: apps.source,
      },
    );
    const th = createThread(w.db, { title: 't' }, t0);
    const m = w.owner(th.id, 'hello');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    const stored = messageById(w.db, th.id, m.id);
    expect(stored?.state).toBe('failed');
    expect(stored?.error).toBe('The chat service stopped answering');
    expect(SERVICE_STOPPED).toBe('The chat service stopped answering');
    const req = w.service.requests[0];
    expect(req).toBeDefined();
    expect(checkMcpToken(w.db, req?.mcp.token, t0)).toMatchObject({ ok: false, reason: 'revoked' });
    expect(apps.fresh).toHaveBeenCalledTimes(1);
    expect(apps.revoke).toHaveBeenCalledTimes(1);
    // The thread stays usable: the next message runs.
    w.owner(th.id, 'again');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(w.service.requests).toHaveLength(2);
  });

  test('a stream that ends with no result fails the message the same way', async () => {
    const w = world(async function* () {
      yield { type: 'text', text: 'and then nothing' };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    const m = w.owner(th.id, 'hello');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(messageById(w.db, th.id, m.id)).toMatchObject({
      state: 'failed',
      error: SERVICE_STOPPED,
    });
  });

  test('the chat token is revoked when the turn ends, and its lifetime is chat.turnMinutes', async () => {
    let liveDuringTurn: unknown;
    let db!: Db;
    const w = world(
      async function* (req) {
        liveDuringTurn = checkMcpToken(db, req.mcp.token, t0);
        yield { type: 'result', isError: false };
      },
      { config: configOf({ chat: { turnMinutes: 7 } }) },
    );
    db = w.db;
    const th = createThread(w.db, { title: 't' }, t0);
    const m = w.owner(th.id, 'hello');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(liveDuringTurn).toMatchObject({
      ok: true,
      principal: { scope: 'chat', threadId: th.id, messageId: m.id, sessionHash: 'h' },
    });
    const req = w.service.requests[0];
    expect(req?.deadlineMs).toBe(7 * 60_000);
    expect(checkMcpToken(w.db, req?.mcp.token, t0)).toMatchObject({ ok: false, reason: 'revoked' });
    const row = w.db
      .prepare(`SELECT created_at AS c, expires_at AS e FROM mcp_tokens WHERE scope = 'chat'`)
      .get() as { c: string; e: string };
    expect(Date.parse(row.e) - Date.parse(row.c)).toBe(7 * 60_000);
  });

  test('a stopped or closed usage gate refuses the turn with the reason and calls no service', async () => {
    for (const gate of ['stopped', 'closed'] as const) {
      const w = world(done());
      if (gate === 'stopped') setUsageState(w.db, { overageStoppedAt: t0.toISOString() }, t0);
      else setUsageState(w.db, { pausedUntil: plus(t0, 3_600_000).toISOString() }, t0);
      expect(dispatchGate(w.db, configOf({}).usage, t0)).toBe(gate);
      const th = createThread(w.db, { title: 't' }, t0);
      const m = w.owner(th.id, 'hello');
      w.turns.enqueue(th.id);
      await w.turns.idle();
      expect(w.service.requests).toHaveLength(0);
      expect(messageById(w.db, th.id, m.id)).toMatchObject({
        state: 'failed',
        error: GATE_REFUSAL[gate],
      });
      expect(GATE_REFUSAL[gate]).toMatch(/^[A-Z][^{}]+\.$/);
      const minted = w.db.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens`).get() as { n: number };
      expect(minted.n).toBe(0);
    }
  });

  test("session_lost clears the thread's session and runs the turn once more with the server-written summary", async () => {
    let sessionAtRetry: string | null | undefined;
    let db!: Db;
    let threadId = 0;
    const w = world(async function* (_req, _s, n) {
      if (n === 1) {
        yield { type: 'error', code: 'session_lost', message: 'No conversation found' };
        return;
      }
      sessionAtRetry = getThread(db, threadId)?.claudeSessionId;
      yield { type: 'text', text: 'picked up again' };
      yield { type: 'result', isError: false };
    });
    db = w.db;
    const th = createThread(w.db, { title: 't' }, t0);
    threadId = th.id;
    setThreadSession(w.db, th.id, 'sess-1', t0);
    for (let i = 1; i <= 25; i++) {
      const tag = `<m${String(i).padStart(2, '0')}>`;
      appendMessage(
        w.db,
        th.id,
        { role: i % 2 ? 'owner' : 'assistant', text: `${tag}${'x'.repeat(2000)}`, state: 'done' },
        t0,
      );
    }
    const m = w.owner(th.id, 'where were we?');
    w.turns.enqueue(th.id);
    await w.turns.idle();

    const [first, second] = w.service.requests;
    expect(first?.resumeSession).toBe('sess-1');
    expect(first?.prompt).toBe('where were we?');
    expect(second?.resumeSession).toBeNull();
    expect(sessionAtRetry).toBeNull();
    const prompt = second?.prompt ?? '';
    expect(prompt.startsWith('<<<jm-data:')).toBe(true);
    const endAt = prompt.indexOf('>>>', prompt.indexOf(':end history'));
    expect(endAt).toBeGreaterThan(0);
    const summary = prompt.slice(0, endAt + 3);
    expect(summary.length).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    // The newest messages are kept; nothing older than the last 20 is.
    expect(summary).toContain('<m25>');
    expect(summary).not.toContain('<m05>');
    expect(prompt.endsWith('where were we?')).toBe(true);
    expect(messageById(w.db, th.id, m.id)?.state).toBe('done');
    expect(w.service.requests).toHaveLength(2);
  });

  test('the summary holds the last 20 messages when they fit', async () => {
    const w = world(async function* (_req, _s, n) {
      if (n === 1) yield { type: 'error', code: 'session_lost', message: 'gone' };
      else yield { type: 'result', isError: false };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    setThreadSession(w.db, th.id, 'sess-1', t0);
    for (let i = 1; i <= 22; i++) {
      appendMessage(
        w.db,
        th.id,
        { role: 'owner', text: `<m${String(i).padStart(2, '0')}>`, state: 'done' },
        t0,
      );
    }
    w.owner(th.id, 'now');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    const prompt = w.service.requests[1]?.prompt ?? '';
    expect(prompt).not.toContain('<m02>');
    for (let i = 3; i <= 22; i++) expect(prompt).toContain(`<m${String(i).padStart(2, '0')}>`);
  });

  test('a second session_lost fails the message instead of looping', async () => {
    const w = world(async function* () {
      yield { type: 'error', code: 'session_lost', message: 'gone' };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    setThreadSession(w.db, th.id, 'sess-1', t0);
    const m = w.owner(th.id, 'hi');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(w.service.requests).toHaveLength(2);
    expect(messageById(w.db, th.id, m.id)?.state).toBe('failed');
  });

  test('no stored message, error or log line contains the Claude token or a read token', async () => {
    const apps = fakeAppTokens();
    const echo = `claude ${CLAUDE} read ${READ_PAT} app ${APP_READ}`;
    const w = world(
      async function* () {
        yield { type: 'text', text: echo };
        yield { type: 'tool', name: 'Read', summary: `read ${echo}` };
        yield { type: 'error', code: 'claude_failed', message: `claude exited: ${echo}` };
      },
      {
        config: configOf({ zones: [patZone, appZone] }),
        apps: appsFor('octo'),
        appTokens: apps.source,
      },
    );
    const events: HubEvent[] = [];
    const th = createThread(w.db, { title: 't' }, t0);
    w.turns.subscribe(th.id, 0, (e) => events.push(e));
    w.owner(th.id, 'hi');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    // The request did carry them: the check below is not vacuous.
    const req = JSON.stringify(w.service.requests[0]);
    for (const secret of [CLAUDE, READ_PAT, APP_READ]) expect(req).toContain(secret);

    const stored = JSON.stringify(listMessages(w.db, th.id));
    expect(stored).toContain('[REDACTED]');
    expect(w.lines.join('\n')).toContain('[REDACTED]');
    for (const secret of [CLAUDE, READ_PAT, APP_READ]) {
      expect(stored).not.toContain(secret);
      expect(w.lines.join('\n')).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
    }
    expect(listMessages(w.db, th.id).some((m) => m.role === 'tool')).toBe(true);
  });

  test('the request carries every configured zone, with token null and state unavailable for a zone without a read credential', async () => {
    const apps = fakeAppTokens();
    const w = world(done(), {
      config: configOf({ zones: [patZone, appZone], read: false }),
      apps: appsFor('octo'),
      appTokens: apps.source,
    });
    const events: HubEvent[] = [];
    const th = createThread(w.db, { title: 't' }, t0);
    w.turns.subscribe(th.id, 0, (e) => events.push(e));
    w.owner(th.id, 'hi');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    const req = w.service.requests[0];
    expect(req?.zones).toEqual([
      {
        id: 'main',
        owner: 'acme',
        name: 'demo',
        defaultBranch: 'trunk',
        token: null,
        extraRefs: [],
      },
      {
        id: 'app',
        owner: 'octo',
        name: 'app',
        defaultBranch: 'trunk',
        token: APP_READ,
        extraRefs: [],
      },
    ]);
    const zoneEvents = events.map((e) => e.event).filter((e) => e.type === 'zone');
    expect(zoneEvents).toEqual([
      expect.objectContaining({ type: 'zone', zoneId: 'main', state: 'unavailable' }),
    ]);
    expect(req?.systemPrompt).toContain('(trusted)');
    expect(req?.systemPrompt).toMatch(/main.*unavailable/);
    expect(req?.mcp.url).toBe('http://jumpmaster:7420/mcp/chat');
    expect(req?.claudeToken).toBe(CLAUDE);
    expect(req?.model).toBe('claude-opus-5-5');
  });

  test('tool events are stored as tool messages and text as one assistant message', async () => {
    const w = world(async function* () {
      yield { type: 'session', sessionId: 'sess-new' };
      yield { type: 'text', text: 'Looking.' };
      yield { type: 'tool', name: 'Read', summary: 'read GOAL.md' };
      yield { type: 'text', text: 'Found it.' };
      yield { type: 'result', isError: false, sessionId: 'sess-new' };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    w.owner(th.id, 'hi');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    const rest = listMessages(w.db, th.id).slice(1);
    expect(rest.map((m) => [m.role, m.text, m.state])).toEqual([
      ['tool', 'read GOAL.md', 'done'],
      ['assistant', 'Looking.\n\nFound it.', 'done'],
    ]);
    expect(getThread(w.db, th.id)?.claudeSessionId).toBe('sess-new');
  });

  test('subscribe replays stored messages after the seq, then live events', async () => {
    const w = world(done('live'));
    const th = createThread(w.db, { title: 't' }, t0);
    appendMessage(w.db, th.id, { role: 'owner', text: 'old', state: 'done' }, t0);
    appendMessage(w.db, th.id, { role: 'assistant', text: 'older reply', state: 'done' }, t0);
    const events: HubEvent[] = [];
    const off = w.turns.subscribe(th.id, 1, (e) => events.push(e));
    expect(events.map((e) => e.seq)).toEqual([2]);
    w.owner(th.id, 'new');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(events.some((e) => e.event.type === 'text')).toBe(true);
    expect(events.map((e) => e.event)).toContainEqual(
      expect.objectContaining({
        type: 'message',
        message: expect.objectContaining({ role: 'assistant', text: 'live' }),
      }),
    );
    // The owner message's end comes last.
    expect(events.at(-1)?.event).toMatchObject({
      type: 'message',
      message: { role: 'owner', text: 'new', state: 'done' },
    });
    off();
    const before = events.length;
    w.owner(th.id, 'after unsubscribe');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(events).toHaveLength(before);
  });
});

describe('chat usage', () => {
  test('each rate_limit event goes to ingestRateLimit with a chat source', async () => {
    const resetsAt = plus(t0, 60 * 60_000).toISOString();
    const w = world(async function* () {
      yield {
        type: 'rate_limit',
        data: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          unifiedWindows: { five_hour: { utilization: 0.95, resetsAt } },
        },
      };
      yield { type: 'text', text: 'hi' };
      yield { type: 'result', isError: false };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    const m = w.owner(th.id, 'how much is left?');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    expect(messageById(w.db, th.id, m.id)?.state).toBe('done');
    expect(getUsageState(w.db).fiveHourUtil).toBe(0.95);
    expect(listUsageWindows(w.db)).toContainEqual(
      expect.objectContaining({ key: 'five_hour', utilization: 0.95, resetsAt }),
    );
  });

  test('a chat source id never matches a real drop id', () => {
    const db = openDb(tmpDbFile());
    const src = chatRateLimitSource(7, 3, t0.toISOString());
    expect(src).toEqual({
      dropId: 'chat:7:3',
      workItemId: null,
      startedAt: t0.toISOString(),
      outcome: null,
    });
    expect(src.dropId.startsWith('chat:')).toBe(true);
    expect(getDrop(db, src.dropId)).toBeUndefined();
  });

  test("the result's usage is stored on the assistant message", async () => {
    const usage = { input_tokens: 12, output_tokens: 34 };
    const w = world(async function* () {
      yield { type: 'text', text: 'answer' };
      yield { type: 'result', isError: false, usage };
    });
    const th = createThread(w.db, { title: 't' }, t0);
    w.owner(th.id, 'q');
    w.turns.enqueue(th.id);
    await w.turns.idle();
    const reply = listMessages(w.db, th.id).find((m) => m.role === 'assistant');
    expect(reply?.text).toBe('answer');
    expect(reply?.usage).toEqual(usage);
  });
});
