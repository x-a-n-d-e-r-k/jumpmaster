import { gitlabBasicAuthAs } from '@jumpmaster/protocol';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { gitlabFetchFor } from '../forge/gitlab-ca.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { fakeGitLab } from '../test/fake-gitlab.js';
import {
  GITLAB_PAT_BAD_ZONE,
  GITLAB_PAT_NOT_GITLAB_ZONE,
  GITLAB_PAT_REJECTED,
  GITLAB_PAT_UNREACHABLE,
  GITLAB_READ_BAD_VALUE,
  GITLAB_READ_REJECTED,
  gitlabPatEntryFingerprints,
  gitlabPatEntryName,
  gitlabReadEntryName,
  parseGitlabPatEntryName,
  parseGitlabReadEntryName,
  parseGitlabReadValue,
  testGitlabPatEntry,
  testGitlabReadEntry,
} from './gitlab-pat-entries.js';
import { fingerprintOf } from './vault.js';

// gitlab-ca.ts as it is, but spied on, so a test can hand a CA zone a fetch of its own.
vi.mock('../forge/gitlab-ca.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../forge/gitlab-ca.js')>();
  return { ...real, gitlabFetchFor: vi.fn(real.gitlabFetchFor) };
});

const BASE = 'https://gitlab.example.test';
const PROJECT = 'acme/widgets';
// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const GOOD = glpat('G');
const WRONG = glpat('W');
const NOSCOPE = glpat('N');

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
afterEach(() => nock.cleanAll());

const zone = (over: Record<string, unknown> = {}) => ({
  id: 'gl',
  repo: PROJECT,
  forge: 'gitlab' as const,
  gitlab: { baseUrl: BASE },
  ...over,
});

function setup() {
  const fake = fakeGitLab({ baseUrl: BASE, project: { id: 7, path: PROJECT } });
  fake.addUser({ username: 'gl-author-bot', token: GOOD, scopes: ['read_user'] });
  fake.addUser({ username: 'gl-api-bot', token: glpat('A'), scopes: ['read_api'] });
  fake.addUser({ username: 'gl-noscope-bot', token: NOSCOPE, scopes: ['write_repository'] });
  return fake;
}

function expectClean(result: unknown, ...secrets: string[]) {
  const text = JSON.stringify(result);
  for (const s of [BASE, PROJECT, 'gitlab.example.test', ...secrets])
    expect(text.includes(s)).toBe(false);
}

describe('gitlabPatEntryName and parseGitlabPatEntryName', () => {
  test('round-trip for both roles', () => {
    for (const role of ['author', 'reviewer'] as const) {
      const name = gitlabPatEntryName('my-zone', role);
      expect(name).toBe(`gitlab-pat/my-zone/${role}`);
      expect(parseGitlabPatEntryName(name)).toEqual({ zoneId: 'my-zone', role });
    }
  });

  test('throws without echoing an invalid zone id or role', () => {
    for (const [id, role] of [
      [`Bad_${GOOD}`, 'author'],
      ['', 'author'],
      ['-x', 'reviewer'],
      ['ok', `maintainer${GOOD}`],
    ] as const) {
      let message = '';
      try {
        gitlabPatEntryName(id, role as 'author');
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).not.toBe('');
      expect(message.includes(GOOD)).toBe(false);
      if (id) expect(message.includes(id)).toBe(false);
    }
  });

  test('parse returns undefined for anything else', () => {
    for (const n of [
      'github-app/acme/author',
      'gitlab-pat/zone/maintainer',
      'gitlab-pat/Zone/author',
      'gitlab-pat/-zone/author',
      'gitlab-pat/zone/author/extra',
      'gitlab-pat/a/b/author',
      'gitlab-pat//author',
      'gitlab-pat/zone',
      'x/gitlab-pat/zone/author',
      '',
    ])
      expect(parseGitlabPatEntryName(n)).toBeUndefined();
  });
});

describe('testGitlabPatEntry', () => {
  test('a good token returns the fake user login, read_user or read_api', async () => {
    const fake = setup();
    const scrub = new ScrubSet();
    const r = await testGitlabPatEntry(GOOD, zone(), { scrub });
    expect(r).toEqual({ ok: true, result: 'ok', login: 'gl-author-bot', live: true });
    expect(fake.requests.map((q) => `${q.method} ${q.path}`)).toEqual(['GET /api/v4/user']);
    expect(scrub.values()).toContain(GOOD);
    const r2 = await testGitlabPatEntry(glpat('A'), zone(), { scrub });
    expect(r2).toEqual({ ok: true, result: 'ok', login: 'gl-api-bot', live: true });
  });

  test('a wrong token gives 401 and the fixed words', async () => {
    setup();
    const scrub = new ScrubSet();
    const r = await testGitlabPatEntry(WRONG, zone(), { scrub });
    expect(r).toEqual({ ok: false, status: 401, problem: GITLAB_PAT_REJECTED });
    expect(GITLAB_PAT_REJECTED).toBe(
      'GitLab rejected this token (401): it is wrong, expired or revoked',
    );
    expectClean(r, WRONG);
    expect(scrub.values()).toContain(WRONG);
  });

  test('a token without a read scope gives 403 and no GitLab text', async () => {
    setup();
    const r = await testGitlabPatEntry(NOSCOPE, zone(), { scrub: new ScrubSet() });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, status: 403 });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/insufficient_scope|privileges|access token/i);
    expectClean(r, NOSCOPE);
  });

  test('refuses a GitHub zone without sending a request', async () => {
    const fake = setup();
    for (const z of [zone({ forge: undefined }), zone({ forge: 'github' })]) {
      const scrub = new ScrubSet();
      const r = await testGitlabPatEntry(GOOD, z, { scrub });
      expect(r).toMatchObject({ ok: false, status: null });
      expect((r as { problem?: string }).problem).toBeTruthy();
      expectClean(r, GOOD);
    }
    expect(fake.requests).toEqual([]);
  });

  test('an invalid project path or base URL returns status null and fixed words', async () => {
    const fake = setup();
    for (const z of [
      zone({ repo: `bad path ${GOOD}` }),
      zone({ gitlab: { baseUrl: `http://${GOOD}@x` } }),
      zone({ gitlab: undefined }),
    ]) {
      const scrub = new ScrubSet();
      const r = await testGitlabPatEntry(GOOD, z, { scrub });
      expect(r).toMatchObject({ ok: false, status: null });
      expect((r as { problem?: string }).problem).toBeTruthy();
      expectClean(r, GOOD, 'bad path');
    }
    expect(fake.requests).toEqual([]);
  });

  test('a network failure returns status null and never throws', async () => {
    const r = await testGitlabPatEntry(GOOD, zone(), {
      scrub: new ScrubSet(),
      fetch: async () => {
        throw new Error(`boom ${GOOD} ${BASE}`);
      },
    });
    expect(r).toMatchObject({ ok: false, status: null });
    expectClean(r, GOOD);
  });

  test('a server error carries its status and no body', async () => {
    const r = await testGitlabPatEntry(GOOD, zone(), {
      scrub: new ScrubSet(),
      fetch: async () => new Response(`{"message":"secret ${PROJECT}"}`, { status: 500 }),
    });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expectClean(r, GOOD);
    expect(JSON.stringify(r).includes('secret')).toBe(false);
  });

  test('the token is in the scrub set before the request is sent', async () => {
    const scrub = new ScrubSet();
    let seen = false;
    await testGitlabPatEntry(GOOD, zone(), {
      scrub,
      fetch: async () => {
        seen = scrub.values().includes(GOOD);
        return new Response(JSON.stringify({ username: 'u' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(seen).toBe(true);
  });
});

describe('gitlabPatEntryFingerprints', () => {
  test('sorted lines of present values, matching fingerprintOf, holding no value', () => {
    const a = glpat('a');
    const b = glpat('b');
    const c = glpat('c');
    const lines = gitlabPatEntryFingerprints({
      zeta: { reviewer: a },
      alpha: { author: b, reviewer: c },
      empty: {},
    });
    expect(lines).toEqual([
      `gitlab-pat/alpha/author=${fingerprintOf(b)}`,
      `gitlab-pat/alpha/reviewer=${fingerprintOf(c)}`,
      `gitlab-pat/zeta/reviewer=${fingerprintOf(a)}`,
    ]);
    expect([...lines].sort()).toEqual(lines);
    for (const v of [a, b, c]) expect(lines.join('\n').includes(v)).toBe(false);
    expect(gitlabPatEntryFingerprints({})).toEqual([]);
  });
});

describe('gitlabPatEntryFingerprints with read entries (issue #831)', () => {
  test('a read entry adds its own line; the existing lines are unchanged', () => {
    const a = glpat('a');
    const b = glpat('b');
    const dt = glpat('d');
    const without = gitlabPatEntryFingerprints({ alpha: { author: a, reviewer: b } });
    const withRead = gitlabPatEntryFingerprints({
      alpha: { author: a, reviewer: b, read: { username: 'gitlab+deploy-token-5', token: dt } },
    });
    expect(withRead).toEqual(
      [...without, `gitlab-pat/alpha/read=${fingerprintOf(`gitlab+deploy-token-5:${dt}`)}`].sort(),
    );
    for (const v of [dt, 'gitlab+deploy-token-5']) expect(withRead.join('\n')).not.toContain(v);
  });
});

describe('gitlabReadEntryName and parseGitlabReadEntryName (issue #831)', () => {
  test('round-trip', () => {
    const name = gitlabReadEntryName('my-zone');
    expect(name).toBe('gitlab-pat/my-zone/read');
    expect(parseGitlabReadEntryName(name)).toEqual({ zoneId: 'my-zone' });
  });

  test('throws without echoing a bad zone id', () => {
    for (const id of [`Bad_${GOOD}`, '', '-x']) {
      let message = '';
      try {
        gitlabReadEntryName(id);
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).not.toBe('');
      expect(message.includes(GOOD)).toBe(false);
      if (id) expect(message.includes(id)).toBe(false);
    }
  });

  test('parse returns undefined for anything else; the PAT parse refuses read', () => {
    expect(parseGitlabPatEntryName('gitlab-pat/z/read')).toBeUndefined();
    for (const n of [
      'gitlab-pat/z/author',
      'gitlab-pat/Z/read',
      'gitlab-pat/z/read/x',
      'gitlab-pat//read',
      'x/gitlab-pat/z/read',
      '',
    ])
      expect(parseGitlabReadEntryName(n)).toBeUndefined();
  });
});

describe('parseGitlabReadValue (issue #831)', () => {
  test('splits on the first colon', () => {
    expect(parseGitlabReadValue(`gitlab+deploy-token-3:${GOOD}`)).toEqual({
      username: 'gitlab+deploy-token-3',
      token: GOOD,
    });
    expect(parseGitlabReadValue('user:to:ken:x')).toEqual({ username: 'user', token: 'to:ken:x' });
  });

  test('no colon, an empty username or an empty token is undefined', () => {
    for (const v of [GOOD, `:${GOOD}`, 'user:', ':', ''])
      expect(parseGitlabReadValue(v)).toBeUndefined();
  });
});

describe('testGitlabReadEntry (issue #831)', () => {
  const USER = 'gitlab+deploy-token-42';
  const TOKEN = ['gldt', 'R'.repeat(20)].join('-');
  const VALUE = `${USER}:${TOKEN}`;
  const BASIC = gitlabBasicAuthAs(USER, TOKEN);
  const PATH = `/${PROJECT}.git/info/refs`;
  const QUERY = { service: 'git-upload-pack' };
  const ADVERT = { 'content-type': 'application/x-git-upload-pack-advertisement' };

  const clean = (r: unknown) => expectClean(r, TOKEN, USER, BASIC, VALUE);
  const holds = (scrub: ScrubSet) =>
    expect(scrub.values()).toEqual(expect.arrayContaining([TOKEN, VALUE, BASIC]));

  test('200 with the upload-pack advertisement is ok, sent with basic auth', async () => {
    const scope = nock(BASE, { reqheaders: { authorization: `Basic ${BASIC}` } })
      .get(PATH)
      .query(QUERY)
      .reply(200, '001e# service=git-upload-pack\n', ADVERT);
    const scrub = new ScrubSet();
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub });
    expect(r).toEqual({ ok: true, result: 'ok', live: true });
    expect(scope.isDone()).toBe(true);
    clean(r);
    holds(scrub);
  });

  test('a base URL with a trailing slash hits the single-slash path', async () => {
    const scope = nock(BASE).get(PATH).query(QUERY).reply(200, '', ADVERT);
    const r = await testGitlabReadEntry(VALUE, zone({ gitlab: { baseUrl: `${BASE}/` } }), {
      scrub: new ScrubSet(),
    });
    expect(r).toEqual({ ok: true, result: 'ok', live: true });
    expect(scope.isDone()).toBe(true);
  });

  test('200 of another content type is not ok', async () => {
    nock(BASE)
      .get(PATH)
      .query(QUERY)
      .reply(200, `<html>${PROJECT}</html>`, { 'content-type': 'text/html' });
    const scrub = new ScrubSet();
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub });
    expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    clean(r);
    holds(scrub);
  });

  test.each([401, 403])('%i is the rejected problem with its status', async (status) => {
    nock(BASE).get(PATH).query(QUERY).reply(status, `denied ${USER}`);
    const scrub = new ScrubSet();
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub });
    expect(r).toEqual({ ok: false, status, problem: GITLAB_READ_REJECTED });
    expect(GITLAB_READ_REJECTED).toBe('GitLab rejected this deploy token');
    clean(r);
    holds(scrub);
  });

  test('another status is unreachable', async () => {
    nock(BASE).get(PATH).query(QUERY).reply(500, `oops ${PROJECT}`);
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub: new ScrubSet() });
    expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    clean(r);
  });

  test('a 302 elsewhere is not followed and sends no Authorization there', async () => {
    nock(BASE)
      .get(PATH)
      .query(QUERY)
      .reply(302, '', { location: 'https://elsewhere.example.test/steal' });
    let elsewhere = 0;
    nock('https://elsewhere.example.test')
      .get(/.*/)
      .reply(function () {
        elsewhere += 1;
        return [200, '', ADVERT];
      })
      .persist();
    const scrub = new ScrubSet();
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub });
    expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    expect(elsewhere).toBe(0);
    clean(r);
    holds(scrub);
  });

  test('a network error is unreachable and never throws', async () => {
    nock(BASE).get(PATH).query(QUERY).replyWithError(`boom ${VALUE} ${BASE}`);
    const scrub = new ScrubSet();
    const r = await testGitlabReadEntry(VALUE, zone(), { scrub });
    expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    clean(r);
    holds(scrub);
  });

  test('uses an injected fetch with manual redirects', async () => {
    const calls: RequestInit[] = [];
    const r = await testGitlabReadEntry(VALUE, zone(), {
      scrub: new ScrubSet(),
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response('', { status: 200, headers: ADVERT });
      },
    });
    expect(r).toEqual({ ok: true, result: 'ok', live: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe('manual');
  });

  test('a GitHub zone is refused without a request', async () => {
    for (const z of [zone({ forge: undefined }), zone({ forge: 'github' })]) {
      const r = await testGitlabReadEntry(VALUE, z, {
        scrub: new ScrubSet(),
        fetch: async () => {
          throw new Error('no request expected');
        },
      });
      expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_NOT_GITLAB_ZONE });
      clean(r);
    }
  });

  test('a bad project path or base URL is refused without a request', async () => {
    for (const z of [
      zone({ repo: `bad path ${TOKEN}` }),
      zone({ gitlab: { baseUrl: `http://${TOKEN}@x` } }),
      zone({ gitlab: undefined }),
    ]) {
      const scrub = new ScrubSet();
      const r = await testGitlabReadEntry(VALUE, z, {
        scrub,
        fetch: async () => {
          throw new Error('no request expected');
        },
      });
      expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_BAD_ZONE });
      clean(r);
      expect(JSON.stringify(r)).not.toContain('bad path');
      holds(scrub);
    }
  });

  test('an unparseable value is a fixed problem without a request', async () => {
    for (const v of [TOKEN, `:${TOKEN}`, `${USER}:`]) {
      const r = await testGitlabReadEntry(v, zone(), {
        scrub: new ScrubSet(),
        fetch: async () => {
          throw new Error('no request expected');
        },
      });
      expect(r).toEqual({ ok: false, status: null, problem: GITLAB_READ_BAD_VALUE });
      clean(r);
    }
  });
});

describe('a zone with gitlab.caCert (issue #919)', () => {
  const CA = `-----BEGIN CERTIFICATE-----\nQ0FDQUNBQ0FDQUNBQ0FDQUNBQ0FDQUNB\n-----END CERTIFICATE-----\n`;
  const caZone = () => zone({ gitlab: { baseUrl: BASE, caCert: CA } });
  const READ_VALUE = `gitlab+deploy-token-1:${['gldt', 'C'.repeat(20)].join('-')}`;
  const ADVERT = { 'content-type': 'application/x-git-upload-pack-advertisement' };
  const noPem = (r: unknown) => {
    const text = JSON.stringify(r);
    expect(text).not.toContain('BEGIN');
    expect(text).not.toContain('Q0FDQUNB');
  };

  /** Hands the next gitlabFetchFor call `caFetch`, and records what it was asked for. */
  function withCaFetch(caFetch: typeof fetch) {
    vi.mocked(gitlabFetchFor).mockClear();
    vi.mocked(gitlabFetchFor).mockReturnValueOnce(caFetch);
    return () => vi.mocked(gitlabFetchFor).mock.calls;
  }

  test('testGitlabPatEntry sends through the CA fetch', async () => {
    const caFetch = vi.fn(async () => Response.json({ id: 1, username: 'ca-bot' }));
    const calls = withCaFetch(caFetch as unknown as typeof fetch);
    const r = await testGitlabPatEntry(GOOD, caZone(), { scrub: new ScrubSet() });
    expect(r).toEqual({ ok: true, result: 'ok', login: 'ca-bot', live: true });
    expect(calls()).toEqual([[CA]]);
    expect(caFetch).toHaveBeenCalledTimes(1);
  });

  test('testGitlabReadEntry sends through the CA fetch', async () => {
    const caFetch = vi.fn(async () => new Response('', { status: 200, headers: ADVERT }));
    const calls = withCaFetch(caFetch as unknown as typeof fetch);
    const r = await testGitlabReadEntry(READ_VALUE, caZone(), { scrub: new ScrubSet() });
    expect(r).toEqual({ ok: true, result: 'ok', live: true });
    expect(calls()).toEqual([[CA]]);
    expect(caFetch).toHaveBeenCalledTimes(1);
  });

  test('a zone without a CA gets the global fetch', async () => {
    setup();
    vi.mocked(gitlabFetchFor).mockClear();
    const r = await testGitlabPatEntry(GOOD, zone(), { scrub: new ScrubSet() });
    expect(r).toMatchObject({ ok: true, login: 'gl-author-bot' });
    expect(vi.mocked(gitlabFetchFor).mock.results[0]?.value).toBe(globalThis.fetch);
  });

  test('an injected deps.fetch still wins', async () => {
    vi.mocked(gitlabFetchFor).mockClear();
    const injected = vi.fn(async () => Response.json({ id: 2, username: 'injected-bot' }));
    const r = await testGitlabPatEntry(GOOD, caZone(), {
      scrub: new ScrubSet(),
      fetch: injected as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: true, login: 'injected-bot' });
    const readFetch = vi.fn(async () => new Response('', { status: 200, headers: ADVERT }));
    const r2 = await testGitlabReadEntry(READ_VALUE, caZone(), {
      scrub: new ScrubSet(),
      fetch: readFetch as unknown as typeof fetch,
    });
    expect(r2).toEqual({ ok: true, result: 'ok', live: true });
    expect(injected).toHaveBeenCalledTimes(1);
    expect(readFetch).toHaveBeenCalledTimes(1);
    expect(gitlabFetchFor).not.toHaveBeenCalled();
  });

  test('a failing CA fetch gives the unreachable result with no PEM text', async () => {
    const real =
      await vi.importActual<typeof import('../forge/gitlab-ca.js')>('../forge/gitlab-ca.js');
    // The real CA fetch over a failing transport whose error quotes the bundle.
    const failing = () =>
      real.gitlabFetchFor(CA, {
        agentFactory: () => ({}) as never,
        fetch: async () => {
          throw new TypeError(`fetch failed: ${CA}`, { cause: new Error(CA) });
        },
      });
    withCaFetch(failing());
    const r = await testGitlabPatEntry(GOOD, caZone(), { scrub: new ScrubSet() });
    expect(r).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    noPem(r);
    withCaFetch(failing());
    const r2 = await testGitlabReadEntry(READ_VALUE, caZone(), { scrub: new ScrubSet() });
    expect(r2).toEqual({ ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE });
    noPem(r2);
  });
});
