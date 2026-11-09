import { afterEach, describe, expect, test, vi } from 'vitest';
import { leaseLogger, StickClient } from './client.js';
import { stickInfo } from './state.js';

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
  expect(p.drop?.dropId).toBe('d1');
  expect(p.skipped).toEqual([]);
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

describe('capabilities and lease logging', () => {
  const info = {
    capabilities: [],
    imagePolicy: 'allowlist' as const,
    version: '0.0.0',
    pinnedImages: [`ghcr.io/o/svc@sha256:${'d'.repeat(64)}`],
  };

  test('lease and enroll send what the stick advertises', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ stickId: 's', stickToken: 't' }), { status: 200 });
      }),
    );
    const client = new StickClient('http://127.0.0.1:1', undefined, { info });
    await client.enroll('join', 'n', 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }),
    );
    await client.lease(1);
    expect(bodies).toEqual([
      { joinToken: 'join', name: 'n', slots: 2, ...info },
      { freeSlots: 1, ...info },
    ]);
  });

  test('lease reports the zones the server skipped, on a payload and on a 204', async () => {
    const skipped = [{ zoneId: 'z', missing: ['egress-v1'] }];
    const header = { 'x-jumpmaster-skipped': encodeURIComponent(JSON.stringify(skipped)) };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204, headers: header })),
    );
    const client = new StickClient('http://127.0.0.1:1', 't', { info });
    expect(await client.lease(1)).toEqual({ drop: null, skipped });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(valid), { status: 200, headers: header })),
    );
    const out = await client.lease(1);
    expect(out.drop?.dropId).toBe('d1');
    expect(out.skipped).toEqual(skipped);
    // A malformed header is ignored, not fatal.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, { status: 204, headers: { 'x-jumpmaster-skipped': '%7Bnot' } }),
      ),
    );
    expect(await client.lease(1)).toEqual({ drop: null, skipped: [] });
  });

  test('a non-2xx lease error carries the response body, truncated', async () => {
    stubFetch({ error: 'unknown drop zone ghost' }, 500);
    await expect(new StickClient('http://127.0.0.1:1', 't', { info }).lease(1)).rejects.toThrow(
      'lease failed: 500 {"error":"unknown drop zone ghost"}',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5000), { status: 400 })),
    );
    const err = await new StickClient('http://127.0.0.1:1', 't', { info })
      .lease(1)
      .catch((e: Error) => e);
    expect((err as Error).message.length).toBeLessThan(600);
  });

  test('the stick logs a non-2xx lease body and skip reasons at most once a minute', () => {
    let now = 0;
    const lines: string[] = [];
    const log = leaseLogger(
      (l) => lines.push(l),
      () => now,
    );
    const skipped = [{ zoneId: 'z', missing: ['egress-v1', 'image-policy:signed'] }];
    log.skipped(skipped);
    log.skipped(skipped);
    log.error('lease failed: 409 {"error":"x"}');
    log.error('lease failed: 409 {"error":"x"}');
    now = 59_999;
    log.skipped(skipped);
    log.error('lease failed: 409 {"error":"x"}');
    expect(lines).toEqual([
      'lease: zone z skipped: this stick lacks egress-v1, image-policy:signed',
      'lease error: lease failed: 409 {"error":"x"}',
    ]);
    now = 60_000;
    log.skipped(skipped);
    log.error('lease failed: 409 {"error":"x"}');
    // A different reason is new, so it logs at once; an empty skip list logs nothing.
    log.skipped([{ zoneId: 'y', missing: ['egress-v1'] }]);
    log.skipped([]);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('lease: zone y skipped: this stick lacks egress-v1');
  });

  test('stickInfo: no capability yet, the policy from JM_IMAGE_POLICY, digest pins only', () => {
    const pin = `ghcr.io/o/svc@sha256:${'e'.repeat(64)}`;
    expect(stickInfo({ JM_ALLOWED_IMAGES: `jumpmaster-trooper:dev, ${pin}` }, '1.2.3')).toEqual({
      capabilities: [],
      imagePolicy: 'allowlist',
      version: '1.2.3',
      pinnedImages: [pin],
    });
    expect(stickInfo({ JM_IMAGE_POLICY: 'signed' }, '1').imagePolicy).toBe('signed');
    expect(() => stickInfo({ JM_IMAGE_POLICY: 'open' }, '1')).toThrow(/JM_IMAGE_POLICY/);
    expect(stickInfo({ JM_IMAGE_POLICY: '' }, '1').imagePolicy).toBe('allowlist');
  });
});
