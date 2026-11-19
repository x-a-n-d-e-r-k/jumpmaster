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
    // Each lease carries the capabilities of the latest health check, and noPush at the cap.
    await client.lease(2, { capabilities: ['push-v1'], noPush: true });
    expect(bodies).toEqual([
      { joinToken: 'join', name: 'n', slots: 2, ...info },
      { freeSlots: 1, ...info },
      { freeSlots: 2, ...info, capabilities: ['push-v1'], noPush: true },
    ]);
  });

  test('enroll sends a one-time code in place of the join token, and returns the name it got', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ stickId: 's', stickToken: 't', name: 'vps-1' }), {
          status: 200,
        });
      }),
    );
    const client = new StickClient('http://127.0.0.1:1', undefined, { info });
    const out = await client.enroll({ enrollCode: 'jm_enroll_x' }, 'stick', 1);
    expect(out).toEqual({ stickId: 's', stickToken: 't', name: 'vps-1' });
    expect(bodies).toEqual([{ enrollCode: 'jm_enroll_x', name: 'stick', slots: 1, ...info }]);
  });

  test('a lease carries the health the stick reports (issue #138)', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }),
    );
    const client = new StickClient('http://127.0.0.1:1', 't', { info });
    await client.lease(1, { capabilities: [], health: { docker: '27.3.1', freeBytes: 5 } });
    expect(bodies).toEqual([
      { freeSlots: 1, ...info, capabilities: [], health: { docker: '27.3.1', freeBytes: 5 } },
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
    expect(await client.lease(1)).toEqual({ drop: null, skipped, slots: null });
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
    expect(await client.lease(1)).toEqual({ drop: null, skipped: [], slots: null });
  });

  test('lease reads the trooper count the server wants from x-jumpmaster-slots, on 200 and 204', async () => {
    const reply = (status: number, slots?: string) =>
      vi.fn(
        async () =>
          new Response(status === 200 ? JSON.stringify(valid) : null, {
            status,
            headers: slots === undefined ? {} : { 'x-jumpmaster-slots': slots },
          }),
      );
    const client = new StickClient('http://127.0.0.1:1', 't', { info });
    vi.stubGlobal('fetch', reply(204, '3'));
    expect((await client.lease(1)).slots).toBe(3);
    vi.stubGlobal('fetch', reply(200, '2'));
    expect((await client.lease(1)).slots).toBe(2);
    // An older server sends none; junk counts as none.
    for (const junk of [undefined, '', 'abc', '0', '1.5', '-1']) {
      vi.stubGlobal('fetch', reply(204, junk));
      expect((await client.lease(1)).slots, String(junk)).toBeNull();
    }
  });

  test('lease sends the stick ceiling as maxSlots, and its starting count as slots', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }),
    );
    await new StickClient('http://127.0.0.1:1', 't', { info, maxSlots: 4, slots: 3 }).lease(0);
    expect(bodies).toEqual([{ freeSlots: 0, ...info, maxSlots: 4, slots: 3 }]);
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

describe('push calls', () => {
  const sha = 'a'.repeat(40);
  const grant = {
    token: 'ghp_secret',
    owner: 'o',
    name: 'r',
    branch: 'agent/issue-1',
    base: 'main',
    lease: '',
    protectedPaths: [],
    secrets: [],
  };
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  const calls: { url: string; body: unknown }[] = [];
  const serve = (...replies: Response[]) => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        const r = replies.shift();
        if (!r) throw new Error('no reply');
        return r;
      }),
    );
  };
  const client = () => new StickClient('http://server.test', 't');

  test('features come from the lease response header, on a payload and on a 204', async () => {
    const c = client();
    expect(c.features.has('push-v1')).toBe(false);
    serve(reply(204, undefined, { 'x-jumpmaster-features': 'push-v1' }));
    await c.lease(1);
    expect(c.features.has('push-v1')).toBe(true);
    serve(reply(200, valid));
    await c.lease(1);
    expect(c.features.has('push-v1')).toBe(false);
  });

  test('heartbeat answers killed for a pending push under the kill switch', async () => {
    serve(reply(200, { cancel: false, hard: false, killed: true }));
    expect(await client().heartbeat('d1', 1)).toBe('killed');
  });

  test('pushPlan parses the plan; 409 is stale; 403 is a refusal', async () => {
    serve(
      reply(200, { branch: 'agent/issue-1', salvage: false }),
      reply(409, { stale: true }),
      reply(403, { refused: 'killed', retryable: true }),
      reply(403, { error: 'nope' }),
    );
    const c = client();
    expect(await c.pushPlan('d1', 2)).toEqual({ branch: 'agent/issue-1', salvage: false });
    expect(calls[0]).toEqual({
      url: 'http://server.test/api/sticks/push-plan',
      body: { dropId: 'd1', epoch: 2 },
    });
    expect(await c.pushPlan('d1', 2)).toBe('stale');
    expect(await c.pushPlan('d1', 2)).toEqual({ refused: 'killed', retryable: true });
    await expect(c.pushPlan('d1', 2)).rejects.toThrow('push-plan failed: 403');
  });

  test('pushGrant tells a grant, a refusal, reserved and stale apart by the body', async () => {
    serve(
      reply(200, { grant }),
      reply(403, { refused: 'killed', retryable: true }),
      reply(409, { refused: 'reserved', retryable: true }),
      reply(409, { stale: true }),
    );
    const c = client();
    expect(await c.pushGrant('d1', 2)).toEqual({ grant });
    expect(await c.pushGrant('d1', 2)).toEqual({ refused: 'killed', retryable: true });
    expect(await c.pushGrant('d1', 2)).toEqual({ refused: 'reserved', retryable: true });
    expect(await c.pushGrant('d1', 2)).toEqual({ stale: true });
    expect(calls[0]?.url).toBe('http://server.test/api/sticks/push-token');
  });

  test('a malformed grant is refused without echoing the body', async () => {
    serve(reply(200, { grant: { token: 'ghp_secret' } }));
    const err = await client()
      .pushGrant('d1', 2)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('ghp_secret');
  });

  test('postPushResult: 200 is ok (Ruling 13), 409 stale, 5xx retried', async () => {
    const result = { status: 'pushed' as const, headSha: sha, alreadyThere: false };
    serve(reply(200, { state: 'done' }), reply(409, { stale: true }), reply(503), reply(200, {}));
    const c = client();
    expect(await c.postPushResult('d1', 2, result)).toBe('ok');
    expect(calls[0]).toEqual({
      url: 'http://server.test/api/drops/d1/push-result',
      body: { epoch: 2, result },
    });
    expect(await c.postPushResult('d1', 2, result)).toBe('stale');
    expect(await c.postPushResult('d1', 2, result)).toBe('ok');
  });

  test('salvage: 200 ok, 409 refused', async () => {
    serve(reply(200, { state: 'push_pending' }), reply(409, { refused: 'state' }));
    const c = client();
    expect(await c.salvage('d1', 2)).toBe('ok');
    expect(calls[0]).toEqual({
      url: 'http://server.test/api/sticks/salvage',
      body: { dropId: 'd1', epoch: 2 },
    });
    expect(await c.salvage('d1', 2)).toBe('refused');
  });

  test('a refused result carries its status, so a 422 is told apart from an outage', async () => {
    serve(reply(422, { error: 'invalid push request' }));
    const err = await client()
      .postResult('d1', 2, { status: 'completed', gates: [] })
      .catch((e: Error & { status?: number }) => e);
    expect((err as { status?: number }).status).toBe(422);
  });
});

describe('server-hosted images (issue #141)', () => {
  const ref = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
  const calls: Call[] = [];
  const serve = (status = 204, body: BodyInit | null = null) => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        calls.push({
          url: String(url),
          method: init.method ?? 'GET',
          headers: init.headers as Record<string, string>,
          body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        return new Response(body, { status });
      }),
    );
  };

  test('a lease carries no imageFetch until a download is reported', async () => {
    serve();
    const c = new StickClient('http://server.test', 't');
    await c.lease(1, { capabilities: ['push-v1'] });
    expect(calls[0]?.body).not.toHaveProperty('imageFetch');
  });

  test('a report is sent at once on a lease with no free slot and the latest terms; null once done', async () => {
    serve();
    const c = new StickClient('http://server.test', 't', { maxSlots: 4, slots: 2 });
    await c.lease(1, { capabilities: ['push-v1', 'egress-v1'], noPush: false });
    await c.reportImageFetch({ ref, done: 5, total: 10 });
    expect(calls[1]).toMatchObject({
      url: 'http://server.test/api/sticks/lease',
      body: {
        freeSlots: 0,
        capabilities: ['push-v1', 'egress-v1'],
        noPush: false,
        maxSlots: 4,
        slots: 2,
        imageFetch: { ref, done: 5, total: 10 },
      },
    });
    // The next regular lease carries it too, until the download ends.
    await c.lease(1, { capabilities: ['push-v1'] });
    expect(calls[2]?.body).toMatchObject({ freeSlots: 1, imageFetch: { ref, done: 5, total: 10 } });
    await c.reportImageFetch(null);
    expect(calls[3]?.body).toMatchObject({ freeSlots: 0, imageFetch: null });
    await c.lease(1);
    expect(calls[4]?.body).not.toHaveProperty('imageFetch');
  });

  test('a report before the first lease waits for it; a failed report is not an error', async () => {
    serve();
    const c = new StickClient('http://server.test', 't');
    await c.reportImageFetch({ ref, done: 1, total: 2 });
    expect(calls).toHaveLength(0);
    await c.lease(1);
    expect(calls[0]?.body).toMatchObject({ imageFetch: { ref, done: 1, total: 2 } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    await expect(c.reportImageFetch({ ref, done: 2, total: 2 })).resolves.toBeUndefined();
  });

  test('a starting report (issue #157) rides every lease while set; null is sent once', async () => {
    serve();
    const c = new StickClient('http://server.test', 't');
    await c.lease(0);
    expect(calls[0]?.body).not.toHaveProperty('starting');
    c.reportStarting({ image: ref });
    // Setting it sends nothing by itself: the caller's lease carries it.
    expect(calls).toHaveLength(1);
    await c.lease(0, { capabilities: [] });
    expect(calls[1]?.body).toMatchObject({ freeSlots: 0, starting: { image: ref } });
    await c.lease(0);
    expect(calls[2]?.body).toMatchObject({ starting: { image: ref } });
    c.reportStarting(null);
    await c.lease(1);
    expect(calls[3]?.body).toMatchObject({ freeSlots: 1, starting: null });
    await c.lease(1);
    expect(calls[4]?.body).not.toHaveProperty('starting');
  });

  test('imageLayout asks for name@digest and the platform with the stick token', async () => {
    serve(200, 'tar');
    const c = new StickClient('http://server.test/', 'tok');
    const res = await c.imageLayout(ref, 'linux/arm64', new AbortController().signal);
    expect(await res.text()).toBe('tar');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `http://server.test/api/sticks/images/jumpmaster-trooper%40sha256%3A${'a'.repeat(64)}/oci.tar?platform=linux%2Farm64`,
      headers: { authorization: 'Bearer tok', 'x-jumpmaster-protocol': '1' },
    });
  });
});

describe('the upgrade offer and report (issue #430)', () => {
  const OFFER = {
    version: '0.6.0',
    image: `ghcr.io/o/jumpmaster-stick@sha256:${'e'.repeat(64)}`,
  };
  const answer = (header?: string, status = 204) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status,
            headers: header === undefined ? {} : { 'x-jumpmaster-upgrade': header },
          }),
      ),
    );

  test('a valid header is held; an answer without it clears it', async () => {
    const client = new StickClient('http://127.0.0.1:1', 't');
    answer(JSON.stringify(OFFER));
    await client.lease(0);
    expect(client.upgradeOffer).toEqual(OFFER);
    answer();
    await client.lease(0);
    expect(client.upgradeOffer).toBeUndefined();
  });

  test('a malformed header is ignored and logged', async () => {
    const logs: string[] = [];
    const client = new StickClient('http://127.0.0.1:1', 't', { log: (l) => logs.push(l) });
    for (const bad of [
      'not json',
      JSON.stringify({ ...OFFER, version: '0.0.0-dev' }),
      JSON.stringify({ ...OFFER, image: `ghcr.io/o/jumpmaster-trooper@sha256:${'e'.repeat(64)}` }),
      JSON.stringify({ ...OFFER, image: 'ghcr.io/o/jumpmaster-stick:latest' }),
    ]) {
      answer(bad);
      await client.lease(0);
      expect(client.upgradeOffer, bad).toBeUndefined();
    }
    expect(logs).toHaveLength(4);
    expect(JSON.parse(logs[0] as string)).toMatchObject({ event: 'upgrade-offer' });
  });

  test('every lease carries the report its hooks give; only a 2xx answer acknowledges it', async () => {
    const bodies: { upgrade?: unknown }[] = [];
    let status = 500;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        bodies.push(JSON.parse(init.body));
        return new Response(status === 204 ? null : '{}', { status });
      }),
    );
    const client = new StickClient('http://127.0.0.1:1', 't');
    const report = { version: '0.6.0', result: 'failed' as const, reason: 'rolled back' };
    const acked: number[] = [];
    client.upgradeHooks = {
      beforeLease: () => ({ report, answered: () => acked.push(bodies.length) }),
    };
    await expect(client.lease(0)).rejects.toThrow(/500/);
    expect(acked).toEqual([]);
    status = 204;
    await client.lease(0);
    expect(acked).toEqual([2]);
    expect(bodies.map((b) => b.upgrade)).toEqual([report, report]);
  });
});
