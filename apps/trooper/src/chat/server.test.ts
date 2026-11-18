import { request } from 'node:http';
import type { ChatEvent, ChatTurnRequest } from '@jumpmaster/protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { startChatServer } from './server.js';

const turn = (over: Partial<ChatTurnRequest> = {}): ChatTurnRequest => ({
  protocol: 1,
  turnId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  resumeSession: null,
  prompt: 'what is open?',
  systemPrompt: 'You are the crew chat.',
  model: 'claude-opus-5-5',
  maxTurns: 20,
  deadlineMs: 600_000,
  claudeToken: 'sk-ant-oat01-x',
  mcp: { url: 'http://jumpmaster:7420/mcp/chat', token: 'jmm_abc' },
  zones: [],
  ...over,
});

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

type RunTurn = Parameters<typeof startChatServer>[0]['runTurn'];
const start = async (
  runTurn: RunTurn,
  health?: () => Promise<{ claude: boolean; forge: boolean }>,
) => {
  const s = await startChatServer({
    listen: '127.0.0.1:0',
    runTurn,
    ...(health ? { health } : {}),
  });
  servers.push(s);
  return s;
};

const post = async (port: number, body: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type'), text };
};
const lines = (text: string) =>
  text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as ChatEvent);

describe('the chat service', () => {
  test('POST /turns streams each event as one NDJSON line', async () => {
    const seen: ChatTurnRequest[] = [];
    const events: ChatEvent[] = [
      { type: 'session', sessionId: 's1' },
      { type: 'text', text: 'line one\nline two' },
      { type: 'result', isError: false, numTurns: 1, sessionId: 's1' },
    ];
    const s = await start(async function* (req) {
      seen.push(req);
      yield* events;
    });
    const r = await post(s.port, JSON.stringify(turn()));
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/^application\/x-ndjson/);
    expect(r.text.endsWith('\n')).toBe(true);
    expect(r.text.split('\n').filter((l) => l !== '')).toHaveLength(3);
    expect(lines(r.text)).toEqual(events);
    expect(seen).toEqual([turn()]);
  });

  test('a body that fails the schema answers one error event bad_request and never calls runTurn', async () => {
    const runTurn = vi.fn(async function* (): AsyncGenerator<ChatEvent> {});
    const s = await start(runTurn);
    for (const body of [
      'not json',
      JSON.stringify({ ...turn(), extra: 1 }),
      JSON.stringify(turn({ mcp: { url: 'http://jumpmaster:7420/mcp/chat', token: 'x' } })),
    ]) {
      const r = await post(s.port, body);
      expect(r.status).toBe(400);
      const out = lines(r.text);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ type: 'error', code: 'bad_request' });
    }
    expect(runTurn).not.toHaveBeenCalled();
  });

  test('a second POST with a running turnId answers error busy', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const s = await start(async function* () {
      yield { type: 'text', text: 'working' };
      await held;
    });
    const first = post(s.port, JSON.stringify(turn()));
    await vi.waitFor(async () => {
      const second = await post(s.port, JSON.stringify(turn()));
      expect(second.status).toBe(409);
      expect(lines(second.text)).toEqual([
        { type: 'error', code: 'busy', message: expect.any(String) },
      ]);
    });
    release();
    expect(lines((await first).text)).toEqual([{ type: 'text', text: 'working' }]);
    // Once it ended, the same turnId may run again.
    const again = await post(s.port, JSON.stringify(turn()));
    expect(again.status).toBe(200);
  });

  test('a turn runner that throws ends the stream with error claude_failed and no detail', async () => {
    const s = await start(async function* () {
      yield { type: 'text', text: 'hi' };
      throw new Error('boom sk-ant-oat01-SECRET');
    });
    const r = await post(s.port, JSON.stringify(turn()));
    const out = lines(r.text);
    expect(out[1]).toMatchObject({ type: 'error', code: 'claude_failed' });
    expect(r.text).not.toContain('SECRET');
  });

  test('a client disconnect aborts the turn', async () => {
    let signal: AbortSignal | undefined;
    let finished = false;
    const s = await start(async function* (_req, sig) {
      signal = sig;
      try {
        yield { type: 'text', text: 'started' };
        await new Promise<void>((resolve) => sig.addEventListener('abort', () => resolve()));
      } finally {
        finished = true;
      }
    });
    await new Promise<void>((resolve, reject) => {
      const body = JSON.stringify(turn());
      const req = request(
        {
          host: '127.0.0.1',
          port: s.port,
          path: '/turns',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on('error', () => {});
      req.on('close', () => resolve());
      req.once('error', reject);
      req.end(body);
    });
    await vi.waitFor(() => {
      expect(signal?.aborted).toBe(true);
      expect(finished).toBe(true);
    });
  });

  test('CLAIM=PROOF the request body is never written to stdout or stderr', async () => {
    const writes: string[] = [];
    const capture = (chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const s = await start(async function* (req) {
      yield { type: 'text', text: `model ${req.model}` };
      throw new Error(`failed with ${req.claudeToken}`);
    });
    const good = turn({ claudeToken: 'sk-ant-oat01-TESTTOKEN' });
    await post(s.port, JSON.stringify(good));
    // A refused body (unknown key) and a malformed one, both carrying the token.
    await post(s.port, JSON.stringify({ ...good, extra: 'TESTTOKEN' }));
    await post(s.port, `{"claudeToken":"sk-ant-oat01-TESTTOKEN"`);
    // The server did log the turn (or the spy proves nothing), by its id only.
    expect(writes.some((w) => w.includes(good.turnId))).toBe(true);
    for (const w of writes) expect(w).not.toContain('TESTTOKEN');
  });

  test('GET /healthz answers ok, claude and forge from the probes', async () => {
    const s = await start(
      async function* () {},
      async () => ({ claude: true, forge: false }),
    );
    const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, claude: true, forge: false });
    const s2 = await start(
      async function* () {},
      async () => ({ claude: true, forge: true }),
    );
    expect(await (await fetch(`http://127.0.0.1:${s2.port}/healthz`)).json()).toEqual({
      ok: true,
      claude: true,
      forge: true,
    });
    expect((await fetch(`http://127.0.0.1:${s.port}/nope`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${s.port}/turns`)).status).toBe(405);
  });
});
