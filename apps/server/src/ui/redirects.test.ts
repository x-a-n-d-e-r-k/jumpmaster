import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { harness } from '../test/flowHarness.js';
import { REDIRECTS, registerRedirects } from './redirects.js';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

/** A bare app with only the redirect table: what the table itself answers. */
function bare() {
  const app = Fastify();
  registerRedirects(app);
  apps.push(app);
  return app;
}

const MOVED: [string, string][] = [
  ['/zones', '/projects'],
  ['/zones/new', '/projects/new'],
  ['/zones/jm', '/projects/jm'],
  ['/zones/jm/github', '/projects/jm/github'],
  ['/zones/jm/goals', '/projects/jm/goals'],
  ['/zones/jm/intake', '/projects/jm/intake'],
  ['/zones/jm/issues/new', '/projects/jm/issues/new'],
  ['/zones/jm/flags', '/projects/jm/flags'],
];

describe('the redirect table (issue #615)', () => {
  test.each(MOVED)('GET %s is a 301 to %s', async (from, to) => {
    const res = await bare().inject({ method: 'GET', url: from });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(to);
  });

  test.each(MOVED)('the query string is kept: %s?x=1', async (from, to) => {
    const res = await bare().inject({ method: 'GET', url: `${from}?x=1&y=a%20b` });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(`${to}?x=1&y=a%20b`);
  });

  test('the issue example: /zones/jm/goals?x=1 goes to /projects/jm/goals?x=1', async () => {
    const res = await bare().inject({ method: 'GET', url: '/zones/jm/goals?x=1' });
    expect([res.statusCode, res.headers.location]).toEqual([301, '/projects/jm/goals?x=1']);
  });

  test.each(MOVED)('HEAD %s is a 301 to %s', async (from, to) => {
    const res = await bare().inject({ method: 'HEAD', url: from });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(to);
  });

  test.each(MOVED)('POST %s is a 308 to %s, the query kept', async (from, to) => {
    const res = await bare().inject({ method: 'POST', url: `${from}?q=2`, payload: { a: 1 } });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`${to}?q=2`);
  });

  test('every entry goes straight to a /projects path: one hop, never another moved path', async () => {
    const app = bare();
    for (const r of REDIRECTS) {
      const url = r.from.replace(/:id/g, 'jm');
      const res = await app.inject({ method: 'GET', url });
      const location = String(res.headers.location);
      expect(location.startsWith('/projects'), url).toBe(true);
      // The target is not itself redirected.
      expect((await app.inject({ method: 'GET', url: location })).statusCode, location).toBe(404);
    }
  });

  describe('open-redirect evasion (D4): a param is one encoded path segment', () => {
    test.each([
      '/zones/%2F%2Fevil.example',
      '/zones/..%2F..%2Fsettings',
      '/zones/https:%2F%2Fevil.example',
      '/zones/%5Cevil',
    ])('%s stays under /projects/', async (url) => {
      const app = bare();
      for (const [suffix, method] of [
        ['', 'GET'],
        ['', 'HEAD'],
        ['', 'POST'],
        ['/goals', 'GET'],
      ] as const) {
        const res = await app.inject({ method, url: `${url}${suffix}` });
        expect(res.statusCode, `${method} ${url}${suffix}`).toBe(method === 'POST' ? 308 : 301);
        const location = String(res.headers.location);
        expect(location.startsWith('/projects/'), location).toBe(true);
        // Exactly one more path segment after /projects (and the fixed sub-path, if any).
        const rest = location.slice('/projects/'.length).split('/');
        expect(rest, location).toHaveLength(suffix ? 2 : 1);
        // The segment has no slash, backslash or dot-segment a browser would act on.
        expect(rest[0], location).not.toMatch(/[/\\]/);
        expect(rest[0], location).not.toMatch(/^\.\.?$/);
        // Resolved against an origin, it stays on that origin and under /projects/.
        const resolved = new URL(location, 'https://jm.example');
        expect(resolved.origin, location).toBe('https://jm.example');
        expect(resolved.pathname.startsWith('/projects/'), location).toBe(true);
      }
    });
  });

  test('in the app: a logged-in operator on an old path is sent to the new one, which renders', async () => {
    const h = await harness({
      live: true,
      zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
    });
    for (const [from, to] of [
      ['/zones', '/projects'],
      ['/zones/main?x=1', '/projects/main?x=1'],
      ['/zones/main/goals', '/projects/main/goals'],
    ]) {
      const res = await h.view(from);
      expect([from, res.statusCode, res.headers.location]).toEqual([from, 301, to]);
      expect((await h.view(to)).statusCode, to).toBe(200);
    }
  });
});
