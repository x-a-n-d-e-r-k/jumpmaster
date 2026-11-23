import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { ScrubSet } from '../forge/scrub-set.js';
import { fakeGitLab } from '../test/fake-gitlab.js';
import {
  GITLAB_PAT_REJECTED,
  gitlabPatEntryFingerprints,
  gitlabPatEntryName,
  parseGitlabPatEntryName,
  testGitlabPatEntry,
} from './gitlab-pat-entries.js';
import { fingerprintOf } from './vault.js';

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
