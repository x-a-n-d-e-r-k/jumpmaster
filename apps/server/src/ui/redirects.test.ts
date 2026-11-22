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
  ['/zones/jm/goals', '/projects/jm/goals'],
  ['/zones/jm/issues/new', '/projects/jm/issues/new'],
  ['/zones/jm/flags', '/projects/jm/flags'],
  ['/work/jm/487', '/projects/jm/work/487'],
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

  test.each(['/zones/jm/github', '/projects/jm/github'])(
    'the GitHub guide %s is a 301 to the GitHub section of Setup, the query kept before the hash (#618)',
    async (from) => {
      const app = bare();
      const get = await app.inject({ method: 'GET', url: from });
      expect([get.statusCode, get.headers.location]).toEqual([301, '/projects/jm/setup#github']);
      const head = await app.inject({ method: 'HEAD', url: from });
      expect([head.statusCode, head.headers.location]).toEqual([301, '/projects/jm/setup#github']);
      const q = await app.inject({ method: 'GET', url: `${from}?reviewer=alice` });
      expect([q.statusCode, q.headers.location]).toEqual([
        301,
        '/projects/jm/setup?reviewer=alice#github',
      ]);
      const post = await app.inject({ method: 'POST', url: `${from}?x=1` });
      expect([post.statusCode, post.headers.location]).toEqual([
        308,
        '/projects/jm/setup?x=1#github',
      ]);
    },
  );

  test.each(['/zones/jm/intake', '/projects/jm/intake'])(
    'the GOAL.md stub page %s is a 301 to the stub builder on Goals, the query kept before the hash (#620)',
    async (from) => {
      const app = bare();
      const get = await app.inject({ method: 'GET', url: from });
      expect([get.statusCode, get.headers.location]).toEqual([301, '/projects/jm/goals#goal-stub']);
      const head = await app.inject({ method: 'HEAD', url: from });
      expect([head.statusCode, head.headers.location]).toEqual([
        301,
        '/projects/jm/goals#goal-stub',
      ]);
      const q = await app.inject({ method: 'GET', url: `${from}?x=1` });
      expect([q.statusCode, q.headers.location]).toEqual([301, '/projects/jm/goals?x=1#goal-stub']);
      const post = await app.inject({ method: 'POST', url: `${from}?x=1` });
      expect([post.statusCode, post.headers.location]).toEqual([
        308,
        '/projects/jm/goals?x=1#goal-stub',
      ]);
    },
  );

  describe("a project's work (#619)", () => {
    test('/work/jm/487 is a 301 to /projects/jm/work/487', async () => {
      const res = await bare().inject({ method: 'GET', url: '/work/jm/487' });
      expect([res.statusCode, res.headers.location]).toEqual([301, '/projects/jm/work/487']);
    });

    test('/work?zone=jm&state=done is a 301 to /projects/jm/work?state=done', async () => {
      const app = bare();
      for (const [url, to] of [
        ['/work?zone=jm&state=done', '/projects/jm/work?state=done'],
        ['/work?state=done&zone=jm', '/projects/jm/work?state=done'],
        ['/work?zone=jm', '/projects/jm/work'],
        ['/work?zone=jm&x=a%20b', '/projects/jm/work?x=a%20b'],
        ['/work?zone=a%2Fb', '/projects/a%2Fb/work'],
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers.location]).toEqual([url, 301, to]);
        const head = await app.inject({ method: 'HEAD', url });
        expect([url, head.statusCode, head.headers.location]).toEqual([url, 301, to]);
        const post = await app.inject({ method: 'POST', url });
        expect([url, post.statusCode, post.headers.location]).toEqual([url, 308, to]);
      }
    });

    test('/work without a zone is not redirected; it still renders in the app', async () => {
      const app = bare();
      for (const url of ['/work', '/work?state=parked', '/work?zone=']) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers.location]).toEqual([url, 404, undefined]);
      }
      // Non-vacuous: the same bare app does redirect the zoned list.
      expect((await app.inject({ method: 'GET', url: '/work?zone=jm' })).statusCode).toBe(301);
      const h = await harness({});
      for (const url of ['/work', '/work?state=parked']) {
        const res = await h.view(url);
        expect([url, res.statusCode]).toEqual([url, 200]);
        expect(res.body, url).toContain('work</h2>');
      }
      const zoned = await h.view('/work?zone=main&state=parked');
      expect([zoned.statusCode, zoned.headers.location]).toEqual([
        301,
        '/projects/main/work?state=parked',
      ]);
      expect((await h.view('/projects/main/work?state=parked')).statusCode).toBe(200);
    });
  });

  describe('the observations list is the Log (#621)', () => {
    test('/observations is a 301 to /activity/log, the query kept; POST is a 308', async () => {
      const app = bare();
      for (const [url, to] of [
        ['/observations', '/activity/log'],
        ['/observations?x=a%20b', '/activity/log?x=a%20b'],
        ['/observations?zone=', '/activity/log?zone='],
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers.location]).toEqual([url, 301, to]);
        const head = await app.inject({ method: 'HEAD', url });
        expect([url, head.statusCode, head.headers.location]).toEqual([url, 301, to]);
        const post = await app.inject({ method: 'POST', url });
        expect([url, post.statusCode, post.headers.location]).toEqual([url, 308, to]);
      }
    });

    test('/observations?zone=jm is a 301 to /projects/jm/log, the rest of the query kept', async () => {
      const app = bare();
      for (const [url, to] of [
        ['/observations?zone=jm', '/projects/jm/log'],
        ['/observations?zone=jm&kind=rulings', '/projects/jm/log?kind=rulings'],
        ['/observations?zone=a%2Fb', '/projects/a%2Fb/log'],
      ]) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers.location]).toEqual([url, 301, to]);
        const head = await app.inject({ method: 'HEAD', url });
        expect([url, head.statusCode, head.headers.location]).toEqual([url, 301, to]);
        const post = await app.inject({ method: 'POST', url });
        expect([url, post.statusCode, post.headers.location]).toEqual([url, 308, to]);
      }
    });

    test('in the app, both land on a page that renders', async () => {
      const h = await harness({});
      for (const [from, to] of [
        ['/observations', '/activity/log'],
        ['/observations?zone=main', '/projects/main/log'],
      ]) {
        const res = await h.view(from);
        expect([from, res.statusCode, res.headers.location]).toEqual([from, 301, to]);
        expect((await h.view(to)).statusCode, to).toBe(200);
      }
    });
  });

  test('every entry goes straight to a /projects or /activity path: one hop, never another moved path', async () => {
    const app = bare();
    for (const r of REDIRECTS) {
      const path = r.from.replace(/:id|:zone/g, 'jm').replace(':issue', '487');
      const url = r.query ? `${path}?${r.query}=jm` : path;
      const res = await app.inject({ method: 'GET', url });
      const location = String(res.headers.location);
      expect(/^\/(projects|activity)\//.test(location) || location === '/projects', url).toBe(true);
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
