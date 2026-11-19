import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { scrub } from '../scrub.js';
import {
  GitLabAuthError,
  GitLabNotFoundError,
  GitLabTokenError,
  GitLabTokenRefusedError,
  GitLabTokenRequestError,
  mintProjectToken,
  needsRotation,
  resolveProjectId,
  rotateSelf,
} from './gitlab-tokens.js';
import { serverScrubSet } from './scrub-set.js';

const GITLAB = 'https://gitlab.com';
const SELF_MANAGED = 'https://git.example.internal';
// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const BOOTSTRAP = glpat('B');
const MINTED = glpat('M');
const ROTATED = glpat('R');
const ALL_TOKENS = [BOOTSTRAP, MINTED, ROTATED];

// 2026-11-19T12:00:00Z
const NOW = Date.UTC(2026, 10, 19, 12);
const now = () => NOW;
const DAY = 86_400_000;

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => {
  nock.cleanAll();
  serverScrubSet.clear();
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function expectClean(err: unknown) {
  expect(err).toBeInstanceOf(GitLabTokenError);
  const e = err as Error;
  const text = [
    e.message,
    String(e),
    e.stack ?? '',
    JSON.stringify(e),
    JSON.stringify(Object.getOwnPropertyNames(e).map((k) => [k, (e as never)[k]])),
  ].join('\n');
  for (const t of ALL_TOKENS) expect(text.includes(t)).toBe(false);
}

function mintResponse(over: Record<string, unknown> = {}) {
  return {
    id: 9001,
    name: 'jumpmaster-author',
    token: MINTED,
    expires_at: '2026-12-19',
    scopes: ['api', 'self_rotate'],
    access_level: 30,
    user_id: 777,
    ...over,
  };
}

describe('resolveProjectId', () => {
  test('URL-encodes a group/sub/project path and sends PRIVATE-TOKEN', async () => {
    const scope = nock(GITLAB, { reqheaders: { 'private-token': BOOTSTRAP } })
      .get('/api/v4/projects/group%2Fsub%2Fproject')
      .reply(200, { id: 4242, path_with_namespace: 'group/sub/project' });
    expect(await resolveProjectId(GITLAB, BOOTSTRAP, 'group/sub/project')).toBe(4242);
    scope.done();
    expect(serverScrubSet.values()).toContain(BOOTSTRAP);
  });

  test('a numeric id is passed through to the lookup', async () => {
    const scope = nock(GITLAB).get('/api/v4/projects/17').reply(200, { id: 17 });
    expect(await resolveProjectId(GITLAB, BOOTSTRAP, 17)).toBe(17);
    scope.done();
  });

  test('404 → typed not-found error', async () => {
    nock(GITLAB)
      .get('/api/v4/projects/group%2Fmissing')
      .reply(404, { message: '404 Project Not Found' });
    const err = await caught(resolveProjectId(GITLAB, BOOTSTRAP, 'group/missing'));
    expect(err).toBeInstanceOf(GitLabNotFoundError);
    expect((err as GitLabNotFoundError).status).toBe(404);
    expectClean(err);
  });

  test.each([401, 403])('%i → typed auth error', async (status) => {
    nock(GITLAB).get('/api/v4/projects/g%2Fp').reply(status, { message: BOOTSTRAP });
    const err = await caught(resolveProjectId(GITLAB, BOOTSTRAP, 'g/p'));
    expect(err).toBeInstanceOf(GitLabAuthError);
    expectClean(err);
  });
});

describe('mintProjectToken', () => {
  test('author defaults: name, scopes, access level 30, expiry 30 days out; maps every field', async () => {
    let body: Record<string, unknown> | undefined;
    const scope = nock(GITLAB, { reqheaders: { 'private-token': BOOTSTRAP } })
      .post('/api/v4/projects/4242/access_tokens', (b) => {
        body = b;
        return true;
      })
      .reply(201, mintResponse());
    const r = await mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', { now });
    scope.done();
    expect(body).toEqual({
      name: 'jumpmaster-author',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      expires_at: '2026-12-19',
    });
    expect(r).toEqual({
      id: 9001,
      token: MINTED,
      expiresAt: '2026-12-19',
      scopes: ['api', 'self_rotate'],
      accessLevel: 30,
      botUserId: 777,
    });
    expect(serverScrubSet.values()).toEqual(expect.arrayContaining([BOOTSTRAP, MINTED]));
  });

  test('reviewer defaults', async () => {
    let body: Record<string, unknown> | undefined;
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens', (b) => {
        body = b;
        return true;
      })
      .reply(201, mintResponse({ name: 'jumpmaster-reviewer' }));
    await mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'reviewer', { now });
    expect(body).toEqual({
      name: 'jumpmaster-reviewer',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      expires_at: '2026-12-19',
    });
  });

  test('overrides replace the role defaults', async () => {
    let body: Record<string, unknown> | undefined;
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens', (b) => {
        body = b;
        return true;
      })
      .reply(201, mintResponse({ scopes: ['read_api', 'self_rotate'], access_level: 40 }));
    await mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'reviewer', {
      now,
      accessLevel: 40,
      scopes: ['read_api', 'self_rotate'],
      expiresAt: '2027-01-10',
    });
    expect(body).toEqual({
      name: 'jumpmaster-reviewer',
      scopes: ['read_api', 'self_rotate'],
      access_level: 40,
      expires_at: '2027-01-10',
    });
  });

  test('an expiresAt 400 days out is capped at 365 days', async () => {
    let body: Record<string, unknown> | undefined;
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens', (b) => {
        body = b;
        return true;
      })
      .reply(201, mintResponse());
    await mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', {
      now,
      expiresAt: new Date(NOW + 400 * DAY),
    });
    expect(body?.expires_at).toBe('2027-11-19');
  });

  test('a self-managed base URL is the host the request goes to', async () => {
    const scope = nock(SELF_MANAGED)
      .post('/api/v4/projects/5/access_tokens')
      .reply(201, mintResponse());
    const r = await mintProjectToken(`${SELF_MANAGED}/`, BOOTSTRAP, 5, 'author', { now });
    scope.done();
    expect(r.token).toBe(MINTED);
  });

  test.each([
    ['access level 50', { accessLevel: 50 }],
    ['scopes without self_rotate', { scopes: ['api'] }],
    ['scopes with sudo', { scopes: ['api', 'self_rotate', 'sudo'] }],
    ['scopes with admin_mode', { scopes: ['api', 'self_rotate', 'admin_mode'] }],
  ])('refuses %s before any request', async (_label, over) => {
    const scope = nock(GITLAB).post(/.*/).reply(201, mintResponse());
    const err = await caught(mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', { now, ...over }));
    expect(err).toBeInstanceOf(GitLabTokenRequestError);
    expectClean(err);
    expect(scope.isDone()).toBe(false);
    expect(serverScrubSet.values()).toContain(BOOTSTRAP);
  });

  test.each([
    ['scopes missing self_rotate', { scopes: ['api'] }],
    ['a different access_level', { access_level: 40 }],
  ])('a response with %s is refused, naming only the token id', async (_label, over) => {
    nock(GITLAB).post('/api/v4/projects/4242/access_tokens').reply(201, mintResponse(over));
    const err = await caught(mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', { now }));
    expect(err).toBeInstanceOf(GitLabTokenRefusedError);
    expect((err as GitLabTokenRefusedError).tokenId).toBe(9001);
    expect((err as Error).message).toContain('9001');
    expectClean(err);
    expect(serverScrubSet.values()).toContain(MINTED);
  });

  test.each([
    [401, GitLabAuthError],
    [403, GitLabAuthError],
    [404, GitLabNotFoundError],
  ])('%i → typed error with no token text', async (status, type) => {
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens')
      .reply(status, { message: `bad ${BOOTSTRAP}` });
    const err = await caught(mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', { now }));
    expect(err).toBeInstanceOf(type);
    expect((err as GitLabTokenError).status).toBe(status);
    expectClean(err);
  });

  test('an injected fetch is used', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(mintResponse()), { status: 201 });
    };
    const r = await mintProjectToken(GITLAB, BOOTSTRAP, 1, 'author', { now, fetch: fakeFetch });
    expect(calls).toEqual(['https://gitlab.com/api/v4/projects/1/access_tokens']);
    expect(r.id).toBe(9001);
  });

  test('the log scrub redacts the bootstrap and minted tokens after a mint', async () => {
    nock(GITLAB).post('/api/v4/projects/4242/access_tokens').reply(201, mintResponse());
    await mintProjectToken(GITLAB, BOOTSTRAP, 4242, 'author', { now });
    expect(serverScrubSet.values()).toEqual(expect.arrayContaining([BOOTSTRAP, MINTED]));
    const line = scrub(`bootstrap=${BOOTSTRAP} minted=${MINTED}`, undefined);
    expect(line).toBe('bootstrap=[redacted] minted=[redacted]');
  });
});

describe('rotateSelf', () => {
  test('sends the old project token, returns the new one; both are in the scrub set', async () => {
    let body: Record<string, unknown> | undefined;
    const scope = nock(GITLAB, { reqheaders: { 'private-token': MINTED } })
      .post('/api/v4/projects/4242/access_tokens/self/rotate', (b) => {
        body = b;
        return true;
      })
      .reply(200, { id: 9002, token: ROTATED, expires_at: '2027-01-18' });
    const r = await rotateSelf(GITLAB, MINTED, 4242, '2027-01-18', { now });
    scope.done();
    expect(body).toEqual({ expires_at: '2027-01-18' });
    expect(r).toEqual({ token: ROTATED, expiresAt: '2027-01-18' });
    expect(serverScrubSet.values()).toEqual(expect.arrayContaining([MINTED, ROTATED]));
  });

  test('without expiresAt, no expiry is sent', async () => {
    let raw: unknown;
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens/self/rotate', (b) => {
        raw = b;
        return true;
      })
      .reply(200, { id: 9002, token: ROTATED, expires_at: '2026-11-26' });
    const r = await rotateSelf(GITLAB, MINTED, 4242);
    expect(raw === '' || (typeof raw === 'object' && raw !== null && !('expires_at' in raw))).toBe(
      true,
    );
    expect(r.token).toBe(ROTATED);
  });

  test.each([
    [401, GitLabAuthError],
    [403, GitLabAuthError],
    [404, GitLabNotFoundError],
  ])('%i → typed error with no token text', async (status, type) => {
    nock(GITLAB)
      .post('/api/v4/projects/4242/access_tokens/self/rotate')
      .reply(status, { message: MINTED });
    const err = await caught(rotateSelf(GITLAB, MINTED, 4242, undefined, { now }));
    expect(err).toBeInstanceOf(type);
    expectClean(err);
    expect(serverScrubSet.values()).toContain(MINTED);
  });
});

describe('needsRotation', () => {
  const at = (days: number) => new Date(NOW + days * DAY).toISOString();
  test('8 days left → false', () => expect(needsRotation(at(8), NOW)).toBe(false));
  test('exactly 7 days left → false', () => expect(needsRotation(at(7), NOW)).toBe(false));
  test('6 days left → true', () => expect(needsRotation(at(6), NOW)).toBe(true));
  test('already expired → true', () => expect(needsRotation(at(-1), NOW)).toBe(true));
  test('a GitLab date (YYYY-MM-DD) is read as midnight UTC', () => {
    const midnight = Date.UTC(2026, 10, 26);
    expect(needsRotation('2026-11-26', midnight - 7 * DAY)).toBe(false);
    expect(needsRotation('2026-11-26', midnight - 7 * DAY + 1)).toBe(true);
    expect(needsRotation('2026-11-26', new Date(midnight - 8 * DAY))).toBe(false);
  });
});
