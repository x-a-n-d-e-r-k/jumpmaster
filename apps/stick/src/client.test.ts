import { afterEach, expect, test, vi } from 'vitest';
import { StickClient } from './client.js';

afterEach(() => vi.unstubAllGlobals());

const valid = {
  protocol: 1,
  dropId: 'd1',
  epoch: 1,
  role: 'implement',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  gates: [],
  model: 'm',
  maxTurns: 5,
  promptVersion: 'v1',
  prompt: 'p',
  image: 'jumpmaster-trooper:test',
  protectedPaths: [],
  credentials: { claudeToken: 'c', forgeToken: 'f' },
};

const stubFetch = (body: unknown, status = 200) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

test('lease returns a schema-valid payload', async () => {
  stubFetch(valid);
  const p = await new StickClient('http://127.0.0.1:1', 't').lease(1);
  expect(p?.dropId).toBe('d1');
});

test('lease rejects a payload that fails the schema', async () => {
  stubFetch({ ...valid, credentials: undefined });
  await expect(new StickClient('http://127.0.0.1:1', 't').lease(1)).rejects.toThrow(
    /invalid lease payload/,
  );
});

test('a heartbeat to a hung server fails instead of waiting forever', async () => {
  vi.stubGlobal(
    'fetch',
    (_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      }),
  );
  const client = new StickClient('http://server.test', 't', { heartbeatTimeoutMs: 5 });
  await expect(client.heartbeat('d1', 1)).rejects.toThrow('timed out');
});
