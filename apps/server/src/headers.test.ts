/**
 * Framing (issue #260): every HTML page forbids framing, so a same-site page on another port
 * cannot frame the UI with the session attached. Proven over the registered route list, not a
 * sample: a page added later is walked too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, test } from 'vitest';
import { routesOf } from './app.js';
import { storeArtifact } from './artifacts.js';
import { raiseBriefing } from './briefings.js';
import { harness, toPrOpen } from './test/flowHarness.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const FRAME_CSP = "frame-ancestors 'none'";

const isHtml = (res: LightMyRequestResponse): boolean =>
  String(res.headers['content-type'] ?? '').startsWith('text/html');

function expectNoFraming(res: LightMyRequestResponse, url: string): void {
  expect(res.headers['x-frame-options'], url).toBe('DENY');
  expect(String(res.headers['content-security-policy']), url).toContain(FRAME_CSP);
}

/** A live app with a drop, an artifact, a briefing and the zone `main`, for the `:id` routes. */
async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'jm-headers-'));
  const h = await harness({
    live: true,
    dataDir,
    zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
  });
  await toPrOpen(h, '7368613100000000000000000000000000000000');
  await h.reconcile();
  const { dropId } = await h.lease();
  const artifact = storeArtifact(h.db, dataDir, dropId, {
    rule: 'ui',
    name: 'a.png',
    mediaType: 'image/png',
    bytes: PNG,
  });
  const briefing = raiseBriefing(
    h.db,
    {
      zoneId: 'main',
      kind: 'promote',
      subject: 'issue:1',
      decision: 'Promote it?',
      why: 'because',
      options: [{ id: 'promote', label: 'Promote', effect: 'promote_issue' }],
      source: 'server',
    },
    h.now(),
  );
  /** A concrete path for a registered pattern, its `:id` filled with a real row's id. */
  const concrete = (pattern: string): string => {
    const id = pattern.startsWith('/drops/')
      ? dropId
      : pattern.startsWith('/artifacts/')
        ? String(artifact.id)
        : pattern.startsWith('/briefings/')
          ? String(briefing)
          : pattern.startsWith('/projects/')
            ? 'main'
            : '1';
    return pattern.replace(/:[A-Za-z]+/g, id).replace(/\*$/, '');
  };
  return { h, artifact, concrete };
}

describe('framing headers (issue #260)', () => {
  test('every registered GET route that answers HTML carries both headers, in setup, logged out and logged in', async () => {
    const { h, concrete } = await world();
    const gets = routesOf(h.app).filter((r) => r.method === 'GET');
    expect(gets.length).toBeGreaterThan(20);
    const htmlUrls = new Set<string>();
    const walk = async (get: (url: string) => Promise<LightMyRequestResponse>) => {
      for (const r of gets) {
        const url = concrete(r.url);
        const res = await get(url);
        if (isHtml(res)) {
          htmlUrls.add(r.url);
          expectNoFraming(res, url);
        } else if (res.headers['content-security-policy'] === undefined) {
          // Non-HTML, without a policy of its own: untouched.
          expect(res.headers['x-frame-options'], url).toBeUndefined();
        }
      }
    };
    const anonymous = (url: string) => h.app.inject({ method: 'GET', url });
    // No operator yet: setup mode, where every page sends the browser to /setup.
    await walk(anonymous);
    // The first view makes the operator; then logged in, and logged out (sent to /login).
    await walk((url) => h.view(url));
    await walk(anonymous);
    // The walk reached the pages, not only redirects and errors.
    for (const page of [
      '/',
      '/login',
      '/setup',
      '/projects',
      '/projects/:id',
      '/drops/:id',
      '/sticks',
    ])
      expect(htmlUrls, page).toContain(page);
  });

  test('the artifacts route keeps its sandbox policy and gains frame-ancestors', async () => {
    const { h, artifact } = await world();
    const res = await h.view(`/artifacts/${artifact.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      "sandbox; default-src 'none'; frame-ancestors 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  test('a JSON route gets neither header', async () => {
    const { h } = await world();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/control/status',
      headers: { authorization: `Bearer ${'o'.repeat(32)}`, host: 'localhost:80' },
    });
    expect(String(res.headers['content-type'])).toContain('application/json');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeUndefined();
    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.headers['x-frame-options']).toBeUndefined();
    expect(health.headers['content-security-policy']).toBeUndefined();
  });

  test('the error path: the pages a refused request is sent to, and an HTML error page', async () => {
    const { h } = await world();
    const setup = await h.app.inject({ method: 'GET', url: '/doctor' });
    expect(setup.statusCode).toBe(302);
    expect(setup.headers.location).toBe('/setup');
    const setupPage = await h.app.inject({ method: 'GET', url: '/setup' });
    expect(isHtml(setupPage)).toBe(true);
    expectNoFraming(setupPage, '/setup');
    await h.view('/');
    const out = await h.app.inject({ method: 'GET', url: '/doctor' });
    expect(out.statusCode).toBe(302);
    const login = await h.app.inject({ method: 'GET', url: String(out.headers.location) });
    expect(login.statusCode).toBe(200);
    expect(isHtml(login)).toBe(true);
    expectNoFraming(login, 'login');
    // A wrong passphrase: the login page again, as a 401.
    const wrong = await h.app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'passphrase=wrong',
    });
    expect(wrong.statusCode).toBe(401);
    expect(isHtml(wrong)).toBe(true);
    expectNoFraming(wrong, 'POST /login');
  });
});
