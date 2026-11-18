import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { APP_MANIFEST_PERMISSIONS } from '../github/app-manifest.js';
import type { AppRole } from '../vault/github-app-entries.js';
import { ManifestConversionError, redeemManifestCode } from './app-manifest-conversion.js';
import { serverScrubSet } from './scrub-set.js';

const API = 'http://fake-github.test';
const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const PEM_LINE = PEM.split('\n')[1] as string;
const CODE = 'CODEabc123_manifest-xyz';
// Recognisable fixture secrets, built at runtime.
const CLIENT_SECRET = ['clientsecret', 'S'.repeat(32)].join('-');
const WEBHOOK_SECRET = ['webhooksecret', 'W'.repeat(32)].join('-');
const SLUG = 'jumpmaster-acme-author';

type Call = { url: string; method: string; headers: Headers };

function body(role: AppRole, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456,
    slug: SLUG,
    client_id: 'Iv1.abcdef0123456789',
    pem: PEM,
    client_secret: CLIENT_SECRET,
    webhook_secret: WEBHOOK_SECRET,
    owner: { login: 'acme', type: 'Organization' },
    permissions: { ...APP_MANIFEST_PERMISSIONS[role] },
    ...over,
  };
}

/** A fake GitHub: an injected fetch that records each call and answers with `reply`. */
function fake(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    });
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const json = (status: number, b: unknown) =>
  new Response(typeof b === 'string' ? b : JSON.stringify(b), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

function expectClean(err: Error, extra: string[] = []) {
  const e = err as Error & { cause?: unknown };
  const text = [
    String(e),
    e.message,
    e.stack ?? '',
    JSON.stringify(e),
    e.cause === undefined ? '' : String(e.cause),
    e.cause === undefined ? '' : JSON.stringify(e.cause),
  ].join('\n');
  for (const s of [CODE, PEM, PEM.trim(), PEM_LINE, CLIENT_SECRET, WEBHOOK_SECRET, ...extra])
    expect(text.includes(s)).toBe(false);
}

function expectScrubbed() {
  const values = serverScrubSet.values();
  expect(values).toContain(CLIENT_SECRET);
  expect(values).toContain(WEBHOOK_SECRET);
  expect(values).toContain(PEM);
  expect(values).toContain(PEM_LINE);
}

beforeEach(() => serverScrubSet.clear());
afterEach(() => serverScrubSet.clear());

describe('redeemManifestCode', () => {
  test.each(['author', 'reviewer'] as const)('happy path for the %s app', async (role) => {
    const gh = fake(() => json(201, body(role)));
    const r = await redeemManifestCode(
      CODE,
      { owner: 'acme', role },
      { apiBase: API, fetch: gh.fetch },
    );
    expect(gh.calls).toHaveLength(1);
    const [c] = gh.calls as [Call];
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API}/app-manifests/${CODE}/conversions`);
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.headers.get('accept')).toBe('application/vnd.github+json');
    expect(r).toEqual({
      appId: 123456,
      slug: SLUG,
      clientId: 'Iv1.abcdef0123456789',
      pem: PEM,
      owner: 'acme',
      role,
    });
    expect(Object.keys(r).sort()).toEqual(
      ['appId', 'clientId', 'owner', 'pem', 'role', 'slug'].sort(),
    );
    expect(JSON.stringify(r)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(r)).not.toContain(WEBHOOK_SECRET);
    expectScrubbed();
  });

  test('defaults the api base to api.github.com without reaching it', async () => {
    const gh = fake(() => json(201, body('author')));
    await redeemManifestCode(CODE, { owner: 'acme', role: 'author' }, { fetch: gh.fetch });
    expect(gh.calls[0]?.url).toBe(`https://api.github.com/app-manifests/${CODE}/conversions`);
  });

  test('the owner is compared case-insensitively', async () => {
    const gh = fake(() => json(201, body('author')));
    const r = await redeemManifestCode(
      CODE,
      { owner: 'Acme', role: 'author' },
      { apiBase: API, fetch: gh.fetch },
    );
    expect(r.owner).toBe('Acme');
  });

  test('a different owner is rejected naming the slug', async () => {
    const gh = fake(() => json(201, body('author', { owner: { login: 'other' } })));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toContain(SLUG);
    expect(err.message).toMatch(/delete the app/);
    expect(err.message).toMatch(/owner/);
    expectClean(err);
    expectScrubbed();
  });

  const permissionCases: [string, AppRole, Record<string, string>][] = [
    ['one extra key', 'author', { ...APP_MANIFEST_PERMISSIONS.author, deployments: 'read' }],
    [
      'one missing key',
      'author',
      Object.fromEntries(
        Object.entries(APP_MANIFEST_PERMISSIONS.author).filter(([k]) => k !== 'issues'),
      ),
    ],
    ['one level changed', 'reviewer', { ...APP_MANIFEST_PERMISSIONS.reviewer, contents: 'read' }],
    [
      'administration added',
      'reviewer',
      { ...APP_MANIFEST_PERMISSIONS.reviewer, administration: 'read' },
    ],
  ];
  test.each(permissionCases)('permissions with %s are rejected', async (_, role, permissions) => {
    const gh = fake(() => json(201, body(role, { permissions })));
    const err = await caught(
      redeemManifestCode(CODE, { owner: 'acme', role }, { apiBase: API, fetch: gh.fetch }),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toContain(SLUG);
    expect(err.message).toMatch(/permission/);
    expectClean(err);
    expectScrubbed();
  });

  test('a forbidden permission is rejected even when expected', async () => {
    const gh = fake(() =>
      json(201, body('author', { permissions: { contents: 'write', workflows: 'write' } })),
    );
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        {
          apiBase: API,
          fetch: gh.fetch,
          expectedPermissions: { contents: 'write', workflows: 'write' },
        },
      ),
    );
    expect(err.message).toMatch(/workflows/);
    expect(err.message).toContain(SLUG);
    expectClean(err);
  });

  test('404 says the code was already used, with no retry', async () => {
    const gh = fake(() => json(404, { message: 'Not Found' }));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err.message).toMatch(/already used or has expired; create the app again/);
    expect(gh.calls).toHaveLength(1);
    expectClean(err);
  });

  test('500 names only the status, with no retry', async () => {
    const gh = fake(() => json(500, { message: `boom ${CODE} ${CLIENT_SECRET}` }));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).not.toMatch(/boom/);
    expect((err as ManifestConversionError).status).toBe(500);
    expect(gh.calls).toHaveLength(1);
    expectClean(err);
  });

  test('a network error names only the failure kind', async () => {
    const gh = fake(() => {
      throw new TypeError(`fetch failed for ${API}/app-manifests/${CODE}/conversions`);
    });
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toMatch(/network error/);
    expect(gh.calls).toHaveLength(1);
    expectClean(err);
  });

  test.each(['../x', 'a'.repeat(300), '', 'a/b', 'a b'])(
    'the code %j is refused with no request',
    async (code) => {
      const gh = fake(() => json(201, body('author')));
      const err = await caught(
        redeemManifestCode(
          code,
          { owner: 'acme', role: 'author' },
          { apiBase: API, fetch: gh.fetch },
        ),
      );
      expect(gh.calls).toHaveLength(0);
      expect(err).toBeInstanceOf(ManifestConversionError);
      if (code.length > 2) expectClean(err, [code]);
    },
  );

  test('a body without a pem is rejected and its secrets still scrubbed', async () => {
    const b = body('author');
    delete b.pem;
    const gh = fake(() => json(201, b));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toMatch(/pem/);
    expect(err.message).toContain(SLUG);
    expect(serverScrubSet.values()).toContain(CLIENT_SECRET);
    expect(serverScrubSet.values()).toContain(WEBHOOK_SECRET);
    expectClean(err);
  });

  test.each([
    ['a non-positive id', { id: 0 }],
    ['a string id', { id: '12' }],
    ['an empty slug', { slug: '' }],
    ['an empty client_id', { client_id: '' }],
    ['a pem that is not a private key', { pem: 'not a pem at all, just text' }],
  ])('%s is rejected', async (_, over) => {
    const gh = fake(() => json(201, body('author', over)));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expect(err.message).toMatch(/delete the app/);
    expectClean(err);
    expect(serverScrubSet.values()).toContain(CLIENT_SECRET);
  });

  test('a body that is not JSON is rejected', async () => {
    const gh = fake(() => json(201, 'not json'));
    const err = await caught(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    );
    expect(err).toBeInstanceOf(ManifestConversionError);
    expectClean(err);
  });

  test('a bad owner or role is refused with no request', async () => {
    const gh = fake(() => json(201, body('author')));
    await expect(
      redeemManifestCode(
        CODE,
        { owner: '-bad-', role: 'author' },
        { apiBase: API, fetch: gh.fetch },
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      redeemManifestCode(
        CODE,
        { owner: 'acme', role: 'admin' as AppRole },
        { apiBase: API, fetch: gh.fetch },
      ),
    ).rejects.toThrow(/role/);
    expect(gh.calls).toHaveLength(0);
  });
});
