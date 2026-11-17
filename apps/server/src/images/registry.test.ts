import { describe, expect, test } from 'vitest';
import { type FetchLike, isRefusedHost, RegistryClient, RegistryError } from './registry.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REFUSED = 'the registry named a token service that is not allowed';

type Call = { url: string; init: RequestInit | undefined };
type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that records every URL it is asked for and answers from `route`. */
function recorder(route: Route) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    return route(new URL(url), init);
  };
  return { calls, fetch };
}

const challenge = (realm: string) =>
  new Response(null, {
    status: 401,
    headers: { 'www-authenticate': `Bearer realm="${realm}",service="reg"` },
  });

const bearerOf = (init: RequestInit | undefined): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.Authorization;

/** A registry on ghcr.io that challenges with `realm` and serves a blob to any bearer `good`. */
function registryWith(realm: string, tokenRoute?: Route) {
  return recorder((url, init) => {
    if (url.host === 'ghcr.io' && url.pathname.startsWith('/v2/')) {
      if (bearerOf(init) === 'Bearer good') return new Response('blob-bytes');
      return challenge(realm);
    }
    if (tokenRoute) return tokenRoute(url, init);
    return Response.json({ token: 'good' });
  });
}

const client = (fetch: FetchLike, token?: string) =>
  new RegistryClient('ghcr.io', 'o/x', {
    fetch,
    scrub: { add: () => undefined },
    ...(token ? { token: () => token } : {}),
  });

describe('the token service a registry names (issue #256)', () => {
  test('an https realm on the registry host is exchanged, as today', async () => {
    const r = registryWith('https://ghcr.io/token');
    const body = await client(r.fetch).blob(DIGEST);
    expect(await new Response(body).text()).toBe('blob-bytes');
    const token = r.calls.find((c) => new URL(c.url).pathname === '/token');
    expect(token?.init?.redirect).toBe('error');
  });

  for (const realm of [
    'http://ghcr.io/token',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:10.0.0.1]/',
    'https://2130706433/token',
    'https://localhost/token',
    'https://[::1]/token',
    'https://[fd00::1]/token',
    'https://[fe80::1]/token',
    'https://192.168.1.1/token',
    'https://172.16.0.1/token',
  ]) {
    test(`a realm of ${realm} is refused and never asked`, async () => {
      const r = registryWith(realm);
      const err = await client(r.fetch)
        .blob(DIGEST)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RegistryError);
      expect((err as Error).message).toBe(REFUSED);
      expect(r.calls.every((c) => new URL(c.url).host === 'ghcr.io')).toBe(true);
      expect(r.calls.some((c) => !new URL(c.url).pathname.startsWith('/v2/'))).toBe(false);
    });
  }

  test('a refused realm is refused with a read token too, and the token is never sent', async () => {
    const r = registryWith('https://169.254.169.254/latest/meta-data');
    await expect(client(r.fetch, 'read-secret').blob(DIGEST)).rejects.toThrow(REFUSED);
    expect(JSON.stringify(r.calls)).not.toContain(
      Buffer.from('jumpmaster:read-secret').toString('base64'),
    );
    expect(r.calls.every((c) => new URL(c.url).host === 'ghcr.io')).toBe(true);
  });

  test('an https realm on another public host works anonymously: the bearer is used on the retry', async () => {
    const r = registryWith('https://auth.docker.io/token');
    const body = await client(r.fetch).blob(DIGEST);
    expect(await new Response(body).text()).toBe('blob-bytes');
    expect(r.calls.map((c) => new URL(c.url).host)).toEqual([
      'ghcr.io',
      'auth.docker.io',
      'ghcr.io',
    ]);
    expect(bearerOf(r.calls[2]?.init)).toBe('Bearer good');
  });

  test('the read token is not sent to a token service on another host', async () => {
    const r = registryWith('https://auth.docker.io/token', (url, init) =>
      bearerOf(init)?.startsWith('Basic')
        ? Response.json({ token: 'good' })
        : new Response(null, { status: 401 }),
    );
    await expect(client(r.fetch, 'read-secret').blob(DIGEST)).rejects.toThrow(
      'the read token is not sent there',
    );
    const basic = Buffer.from('jumpmaster:read-secret').toString('base64');
    expect(JSON.stringify(r.calls)).not.toContain(basic);
    expect(r.calls.every((c) => !bearerOf(c.init)?.startsWith('Basic'))).toBe(true);
  });

  test('a token service answering a redirect fails the exchange; the target is never asked', async () => {
    // A fetch that honours `redirect` as undici does: 'error' throws on a 3xx.
    const r = recorder((url, init) => {
      if (url.host === 'ghcr.io') return challenge('https://auth.example/token');
      if (url.host === 'auth.example') {
        if (init?.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect');
        return r.fetch('https://10.0.0.5/', init);
      }
      return Response.json({ token: 'good' });
    });
    await expect(client(r.fetch).blob(DIGEST)).rejects.toThrow(RegistryError);
    expect(r.calls.some((c) => new URL(c.url).host === '10.0.0.5')).toBe(false);
  });
});

describe('redirects of manifests and blobs (issue #256)', () => {
  const redirecting = (location: string) =>
    recorder((url, init) => {
      if (url.host === 'ghcr.io') {
        if (init?.redirect !== 'manual') throw new Error('the client must follow redirects itself');
        return new Response(null, { status: 307, headers: { location } });
      }
      return new Response('stored-bytes');
    });

  test('a blob redirected to https storage is followed, without the bearer', async () => {
    const r = redirecting('https://storage.example/blob?sig=1');
    const body = await client(r.fetch).blob(DIGEST);
    expect(await new Response(body).text()).toBe('stored-bytes');
    expect(r.calls.map((c) => c.url)).toEqual([
      `https://ghcr.io/v2/o/x/blobs/${DIGEST}`,
      'https://storage.example/blob?sig=1',
    ]);
  });

  test('a blob redirected to http is refused and never asked', async () => {
    const r = redirecting('http://storage.example/blob');
    await expect(client(r.fetch).blob(DIGEST)).rejects.toThrow(RegistryError);
    expect(r.calls.some((c) => c.url.startsWith('http:'))).toBe(false);
  });

  test('a manifest redirected to http is refused and never asked', async () => {
    const r = redirecting('http://storage.example/manifest');
    await expect(client(r.fetch).manifest(DIGEST)).rejects.toThrow(RegistryError);
    expect(r.calls.some((c) => c.url.startsWith('http:'))).toBe(false);
  });

  test('a redirect loop ends in a refusal', async () => {
    const r = redirecting('https://ghcr.io/again');
    await expect(client(r.fetch).blob(DIGEST)).rejects.toThrow(RegistryError);
    expect(r.calls.length).toBeLessThan(20);
  });
});

describe('isRefusedHost', () => {
  test.each([
    ['127.0.0.1', true],
    ['127.255.0.9', true],
    ['10.1.2.3', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['0.0.0.0', true],
    ['[::1]', true],
    ['[::]', true],
    ['[fe80::1]', true],
    ['[febf::1]', true],
    ['[fc00::1]', true],
    ['[fdff::1]', true],
    ['[::ffff:a00:1]', true],
    ['[::ffff:808:808]', false],
    ['[2001:db8::1]', false],
    ['localhost', true],
    ['localhost.', true],
    ['a.localhost', true],
    ['8.8.8.8', false],
    ['ghcr.io', false],
  ])('%s → %s', (host, refused) => {
    expect(isRefusedHost(host)).toBe(refused);
  });
});
