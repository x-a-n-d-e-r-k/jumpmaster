import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChatEvent, ChatTurnRequest } from '@jumpmaster/protocol';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import type { TrooperIdentities } from '../privilege.js';
import * as privilege from '../privilege.js';
import { runChatTurn, toolSummary } from './turn.js';

vi.mock('../privilege.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../privilege.js')>();
  return { ...real, sweepUid: vi.fn(() => 0) };
});

// Fake credentials, split after their prefixes so no tracked line is token-shaped.
const CLAUDE_TOKEN = 'sk-ant-oat01-' + 'c'.repeat(40);
const MCP_TOKEN = 'jmm_' + 'm'.repeat(40);
const ZONE_TOKEN = 'ghs_' + 'z'.repeat(36);
const OTHER_ZONE_TOKEN = 'github_pat_' + 'p'.repeat(40);

const tmp = mkdtempSync(join(realpathSync(tmpdir()), 'chat-turn-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.mocked(privilege.sweepUid).mockClear());

const ids: TrooperIdentities = {
  agent: { uid: 10001, gid: 10001, home: join(tmp, 'agent') },
  gate: { uid: 10002, gid: 10002, home: join(tmp, 'gate') },
};

const req = (over: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({
  protocol: 1,
  turnId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  resumeSession: null,
  prompt: 'what is open?',
  systemPrompt: 'You are the crew chat for this install.',
  model: 'claude-opus-5-5',
  maxTurns: 20,
  deadlineMs: 600_000,
  claudeToken: CLAUDE_TOKEN,
  mcp: { url: 'http://jumpmaster:7420/mcp/chat', token: MCP_TOKEN },
  zones: [],
  ...over,
});

type Spawned = {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
  killed: boolean;
  systemPrompt?: string;
};

/**
 * A `spawn` that records what it was asked to run and replays `stdout` lines, then `stderr`, then
 * exits with `code`. With `hang`, it never exits on its own: only a kill ends it.
 */
function fakeSpawn(o: { stdout?: string[]; stderr?: string; code?: number; hang?: boolean }) {
  const calls: Spawned[] = [];
  const spawn = (cmd: string, args: string[], opts: SpawnOptions): ChildProcess => {
    const rec: Spawned = { cmd, args, opts, killed: false };
    const file = args[args.indexOf('--append-system-prompt-file') + 1];
    if (file && existsSync(file)) rec.systemPrompt = readFileSync(file, 'utf8');
    calls.push(rec);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin: null, pid: 4242 });
    let closed = false;
    const close = (code: number | null, sig: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit('close', code, sig));
    };
    child.kill = (() => {
      rec.killed = true;
      close(null, 'SIGKILL');
      return true;
    }) as ChildProcess['kill'];
    setImmediate(() => {
      for (const l of o.stdout ?? []) stdout.write(`${l}\n`);
      if (o.stderr) stderr.write(o.stderr);
      if (!o.hang) close(o.code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const FIXTURE = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Let me look.' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'Read',
          input: { file_path: '/chat/repos/main/work/a.txt' },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] },
  }),
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1_790_000_000,
      rateLimitType: 'five_hour',
    },
  }),
  'not json',
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't2',
          name: 'mcp__jumpmaster__list_issues',
          input: { zoneId: 'main' },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Two are open.' }] },
  }),
  JSON.stringify({
    type: 'result',
    is_error: false,
    num_turns: 3,
    session_id: 'sess-1',
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
];

describe('runChatTurn', () => {
  test('CLAIM=PROOF claude runs as the agent uid with the Claude and MCP tokens in its environment and no forge token', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: FIXTURE });
    const root = mkdtempSync(join(tmp, 'root-'));
    const synced: string[] = [];
    const zones = [
      {
        id: 'main',
        owner: 'o',
        name: 'r',
        defaultBranch: 'main',
        token: ZONE_TOKEN,
        extraRefs: [],
      },
      {
        id: 'web',
        owner: 'o',
        name: 'w',
        defaultBranch: 'main',
        token: OTHER_ZONE_TOKEN,
        extraRefs: [],
      },
    ];
    // The forge tokens are in the trooper's own environment too: they must not be passed on.
    vi.stubEnv('GH_TOKEN', ZONE_TOKEN);
    vi.stubEnv('JM_SOMETHING', OTHER_ZONE_TOKEN);
    try {
      const events = await collect(
        runChatTurn(req({ zones }), new AbortController().signal, {
          spawn,
          root,
          ids,
          sync: async (r, z, as) => {
            expect(r).toBe(root);
            expect(as).toEqual(ids.agent);
            synced.push(z.id);
            return z.id === 'main'
              ? { workDir: join(r, z.id, 'work') }
              : { unavailable: 'fetch failed' };
          },
        }),
      );
      expect(events.slice(0, 2)).toEqual([
        { type: 'zone', zoneId: 'main', state: 'fetched' },
        { type: 'zone', zoneId: 'web', state: 'unavailable', reason: 'fetch failed' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(synced).toEqual(['main', 'web']);
    expect(calls).toHaveLength(1);
    const c = calls[0] as Spawned;
    const argv = [c.cmd, ...c.args];
    expect(argv.slice(0, 2)).toEqual(['setpriv', '--reuid=10001']);
    expect(argv).toContain('claude');
    // claude starts in <root>, entered after the uid drop, and reads only the fetched zone.
    expect(argv).toContain(root);
    const addDirs = argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : []));
    expect(addDirs).toEqual([join(root, 'main', 'work')]);

    const env = c.opts.env as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLAUDE_TOKEN);
    expect(env.JM_CHAT_MCP_TOKEN).toBe(MCP_TOKEN);
    expect(env.HOME).toBe(ids.agent.home);
    for (const [k, v] of Object.entries(env)) {
      for (const t of [ZONE_TOKEN, OTHER_ZONE_TOKEN]) expect(v, k).not.toBe(t);
      expect(v ?? '', k).not.toContain('ghs_');
    }
    // Neither token is in argv: the MCP config names the variable.
    for (const a of argv) {
      expect(a).not.toContain(MCP_TOKEN);
      expect(a).not.toContain(CLAUDE_TOKEN);
      expect(a).not.toContain(ZONE_TOKEN);
    }
    // The system prompt file holds the chat rules and the server's prompt; it is gone afterwards.
    expect(c.systemPrompt).toContain('jm-data');
    expect(c.systemPrompt).toContain('You are the crew chat for this install.');
    const file = c.args[c.args.indexOf('--append-system-prompt-file') + 1] as string;
    expect(existsSync(file)).toBe(false);
  });

  test('stream lines map to session, text, tool, rate_limit and result events in order', async () => {
    const { spawn } = fakeSpawn({ stdout: FIXTURE });
    const events = await collect(
      runChatTurn(req(), new AbortController().signal, { spawn, root: tmp, ids: null }),
    );
    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'text', text: 'Let me look.' },
      {
        type: 'tool',
        name: 'Read',
        summary: 'read /chat/repos/main/work/a.txt',
        id: 't1',
        input: { file_path: '/chat/repos/main/work/a.txt' },
      },
      { type: 'tool_result', id: 't1', text: 'a', truncated: false, totalLines: 1, isError: false },
      {
        type: 'rate_limit',
        data: {
          status: 'allowed_warning',
          resetsAt: new Date(1_790_000_000 * 1000).toISOString(),
          rateLimitType: 'five_hour',
        },
      },
      {
        type: 'tool',
        name: 'list_issues',
        summary: 'list_issues in main',
        id: 't2',
        input: { zoneId: 'main' },
      },
      { type: 'text', text: 'Two are open.' },
      {
        type: 'result',
        isError: false,
        numTurns: 3,
        sessionId: 'sess-1',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
  });

  test('a resume that Claude reports as unknown ends with error session_lost', async () => {
    const { spawn, calls } = fakeSpawn({
      stderr: 'Error: No conversation found with session ID: sess-old\n',
      code: 1,
    });
    const events = await collect(
      runChatTurn(req({ resumeSession: 'sess-old' }), new AbortController().signal, {
        spawn,
        root: tmp,
        ids: null,
      }),
    );
    const c = calls[0] as Spawned;
    expect(c.args[c.args.indexOf('--resume') + 1]).toBe('sess-old');
    expect(events).toEqual([{ type: 'error', code: 'session_lost', message: expect.any(String) }]);
  });

  test('any other failed exit ends with error claude_failed and no stderr detail', async () => {
    const { spawn } = fakeSpawn({ stderr: `boom ${CLAUDE_TOKEN}`, code: 2 });
    const events = await collect(
      runChatTurn(req(), new AbortController().signal, { spawn, root: tmp, ids: null }),
    );
    expect(events).toEqual([{ type: 'error', code: 'claude_failed', message: expect.any(String) }]);
    expect(JSON.stringify(events)).not.toContain(CLAUDE_TOKEN);
  });

  test('the deadline aborts claude and ends with error deadline', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: [FIXTURE[0] as string], hang: true });
    const events = await collect(
      runChatTurn(req({ deadlineMs: 50 }), new AbortController().signal, { spawn, root: tmp, ids }),
    );
    expect(calls[0]?.killed).toBe(true);
    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'error', code: 'deadline', message: expect.any(String) },
    ]);
    expect(privilege.sweepUid).toHaveBeenCalledWith(10001);
  });

  test('an abort sweeps the agent uid', async () => {
    const { spawn, calls } = fakeSpawn({ stdout: [FIXTURE[0] as string], hang: true });
    const ac = new AbortController();
    const seen: ChatEvent[] = [];
    for await (const e of runChatTurn(req(), ac.signal, { spawn, root: tmp, ids })) {
      seen.push(e);
      if (e.type === 'session') ac.abort();
    }
    expect(calls[0]?.killed).toBe(true);
    expect(privilege.sweepUid).toHaveBeenCalledWith(10001);
    expect(seen[0]).toEqual({ type: 'session', sessionId: 'sess-1' });
  });
});

/** The events a stream of the given messages (then a result) gives, without the result. */
async function streamEvents(...msgs: unknown[]): Promise<ChatEvent[]> {
  const { spawn } = fakeSpawn({
    stdout: [
      ...msgs.map((m) => JSON.stringify(m)),
      JSON.stringify({ type: 'result', is_error: false }),
    ],
  });
  const events = await collect(
    runChatTurn(req(), new AbortController().signal, { spawn, root: tmp, ids: null }),
  );
  return events.filter((e) => e.type !== 'result');
}

const toolUse = (id: unknown, name: string, input: unknown) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResults = (...content: unknown[]) => ({ type: 'user', message: { content } });

describe('tool steps', () => {
  test('a Read tool_use and its tool_result give a tool event with id and input, then a tool_result', async () => {
    const events = await streamEvents(
      toolUse('t1', 'Read', { file_path: 'a.txt' }),
      toolResults({ type: 'tool_result', tool_use_id: 't1', content: 'one\ntwo' }),
    );
    expect(events).toEqual([
      {
        type: 'tool',
        name: 'Read',
        summary: 'read a.txt',
        id: 't1',
        input: { file_path: 'a.txt' },
      },
      {
        type: 'tool_result',
        id: 't1',
        text: 'one\ntwo',
        truncated: false,
        totalLines: 2,
        isError: false,
      },
    ]);
  });

  test('a long result is cut to 65536 characters with the uncut line count; a short one is not', async () => {
    const line = `${'x'.repeat(99)}\n`;
    const long = line.repeat(1000);
    expect(long.length).toBe(100_000);
    const events = await streamEvents(
      toolResults(
        { type: 'tool_result', tool_use_id: 'big', content: long },
        { type: 'tool_result', tool_use_id: 'small', content: 'ok', is_error: true },
      ),
    );
    expect(events).toEqual([
      {
        type: 'tool_result',
        id: 'big',
        text: long.slice(0, 65536),
        truncated: true,
        totalLines: 1001,
        isError: false,
      },
      {
        type: 'tool_result',
        id: 'small',
        text: 'ok',
        truncated: false,
        totalLines: 1,
        isError: true,
      },
    ]);
  });

  test('array content joins its text parts and names the others; missing content is empty', async () => {
    const events = await streamEvents(
      toolResults(
        {
          type: 'tool_result',
          tool_use_id: 'a',
          content: [
            { type: 'text', text: 'seen' },
            { type: 'image', source: {} },
          ],
        },
        { type: 'tool_result', tool_use_id: 'b' },
      ),
    );
    expect(events).toEqual([
      {
        type: 'tool_result',
        id: 'a',
        text: 'seen\n[image]',
        truncated: false,
        totalLines: 2,
        isError: false,
      },
      { type: 'tool_result', id: 'b', text: '', truncated: false, totalLines: 0, isError: false },
    ]);
  });

  test('an input over 4096 characters of JSON is sent as a truncated preview', async () => {
    const input = { command: 'y'.repeat(10_000) };
    const [e] = await streamEvents(toolUse('t1', 'Bash', input));
    expect(e).toMatchObject({ type: 'tool', id: 't1' });
    const sent = (e as { input?: Record<string, unknown> }).input;
    expect(sent).toEqual({ _truncated: true, preview: JSON.stringify(input).slice(0, 4096) });
    expect((sent?.preview as string).length).toBe(4096);
  });

  test('an array input or a missing id is left out of the tool event', async () => {
    const events = await streamEvents(toolUse('', 'Read', ['a']), toolUse(7, 'Read', null));
    expect(events).toEqual([
      { type: 'tool', name: 'Read', summary: 'read' },
      { type: 'tool', name: 'Read', summary: 'read' },
    ]);
  });

  test('a tool_result block without a tool_use_id yields no event', async () => {
    const events = await streamEvents(
      toolResults(
        { type: 'tool_result', content: 'x' },
        { type: 'tool_result', tool_use_id: '', content: 'x' },
        { type: 'text', text: 'not a result' },
        { type: 'tool_result', tool_use_id: 'ok', content: 'x' },
      ),
      { type: 'user', message: { content: 'plain' } },
    );
    expect(events).toEqual([
      { type: 'tool_result', id: 'ok', text: 'x', truncated: false, totalLines: 1, isError: false },
    ]);
  });
});

describe('toolSummary', () => {
  test('names each tool call in one short line, and ignores anything that is not one', () => {
    expect(toolSummary({ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } })).toEqual({
      name: 'Grep',
      summary: 'searched for TODO',
    });
    expect(toolSummary({ type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } })).toEqual({
      name: 'Glob',
      summary: 'listed **/*.ts',
    });
    expect(
      toolSummary({ type: 'tool_use', name: 'Bash', input: { command: 'git log -5' } }),
    ).toEqual({ name: 'Bash', summary: 'ran git log -5' });
    const long = toolSummary({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'x'.repeat(500) },
    });
    expect(long?.summary.length).toBeLessThanOrEqual(200);
    expect(toolSummary({ type: 'text', text: 'hi' })).toBeNull();
    expect(toolSummary(null)).toBeNull();
    expect(toolSummary({ type: 'tool_use' })).toBeNull();
  });
});
