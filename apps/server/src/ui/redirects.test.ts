import { describe, expect, test } from 'vitest';
import { harness } from '../test/flowHarness.js';
import { operatorSession } from '../test/helpers.js';
import { REDIRECTS, redirectTarget } from './redirects.js';

const MOVED: [string, string][] = [
  ['/zones', '/projects'],
  ['/zones/new', '/projects/new'],
  ['/zones/jm', '/projects/jm'],
  ['/zones/jm/flags', '/projects/jm/flags'],
  ['/zones/jm/github', '/projects/jm/github'],
  ['/zones/jm/goals', '/projects/jm/goals'],
  ['/zones/jm/intake', '/projects/jm/intake'],
  ['/zones/jm/issues/new', '/projects/jm/issues/new'],
];

describe('old page paths redirect through the table (#631)', () => {
  test('the table holds every moved page', () => {
    expect(REDIRECTS.map((r) => r.from).sort()).toEqual(
      [
        '/zones',
        '/zones/new',
        '/zones/:id',
        '/zones/:id/flags',
        '/zones/:id/github',
        '/zones/:id/goals',
        '/zones/:id/intake',
        '/zones/:id/issues/new',
      ].sort(),
    );
  });

  test.each(MOVED)('GET %s is a 301 to %s', async (from, to) => {
    const h = await harness();
    const res = await h.view(from);
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(to);
  });

  test('the raw query string is kept unchanged', async () => {
    const h = await harness();
    const res = await h.view('/zones/jm/goals?x=1');
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/projects/jm/goals?x=1');
    const raw = await h.view('/zones/jm/flags?saved=3&a=%2F%2F&b');
    expect(raw.headers.location).toBe('/projects/jm/flags?saved=3&a=%2F%2F&b');
  });

  test.each(MOVED)('HEAD %s is a 301', async (from, to) => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'HEAD',
      url: from,
      headers: { cookie: operatorSession(h.db, h.now()).cookie },
    });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe(to);
  });

  test.each(MOVED)('POST %s with a session and no CSRF header is a 308', async (from, to) => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: `${from}?q=1`,
      headers: {
        cookie: operatorSession(h.db, h.now()).cookie,
        // URL drops :80 from an http origin; the harness allows `localhost:80`.
        origin: 'https://localhost:80',
      },
      payload: 'a=1',
    });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe(`${to}?q=1`);
  });

  test('the guard still runs first: a foreign Host is refused, no session goes to login', async () => {
    const h = await harness();
    expect((await h.view('/zones/jm', { host: 'evil.test' })).statusCode).toBe(403);
    const anon = await h.app.inject({ method: 'GET', url: '/zones/jm' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toMatch(/^\/login\?next=/);
  });

  test.each([
    '/zones/%2F%2Fevil.example',
    '/zones/..%2F..%2Fsettings',
    '/zones/https:%2F%2Fevil.example',
    '/zones/%5Cevil',
  ])('%s cannot redirect off the projects path', async (from) => {
    const h = await harness();
    const res = await h.view(from);
    expect(res.statusCode).toBe(301);
    const location = String(res.headers.location);
    expect(location.startsWith('/projects/')).toBe(true);
    expect(location.split('/')).toHaveLength(3);
    expect(location).not.toContain('//');
    expect(location).not.toContain('\\');
  });

  test('redirectTarget encodes each param and keeps the query', () => {
    const entry = REDIRECTS.find((r) => r.from === '/zones/:id/goals');
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(redirectTarget(entry, { id: 'a/b' }, '/zones/a%2Fb/goals?z')).toBe(
      '/projects/a%2Fb/goals?z',
    );
    expect(redirectTarget(entry, { id: 'x' }, '/zones/x/goals')).toBe('/projects/x/goals');
  });
});
