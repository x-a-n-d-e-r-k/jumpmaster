// pairFor and ForgePairs for a GitLab zone (issue #718): a GitLabForge pair built from the
// gitlab-pat tokens a caller passes in `PairOptions.gitlabTokens`, against the fake GitLab with
// the network shut.
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { GitHubForge } from './forge/github.js';
import { GitLabForge } from './forge/gitlab.js';
import { gitlabFetchFor } from './forge/gitlab-ca.js';
import { GITLAB_UNSUPPORTED } from './forge/kind.js';
import { ForgePairs, type PairOptions, pairFor, pairKey, pairOptionsFor } from './outbox.js';
import { ACCESS, type FakeGitLab, fakeGitLab } from './test/fake-gitlab.js';
import type { Resolved } from './vault/credentials.js';
import type { ResolvedGitlabPats } from './vault/resolution.js';

// gitlab-ca.ts as it is, but spied on, so a test can hand a CA zone's forges a fetch of its own.
vi.mock('./forge/gitlab-ca.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./forge/gitlab-ca.js')>();
  return { ...real, gitlabFetchFor: vi.fn(real.gitlabFetchFor) };
});

const GITLAB = 'https://gitlab.example.com';
const OTHER_GITLAB = 'https://gitlab.other.example.com';
const PROJECT = { id: 77, path: 'group/sub/project' };

// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
const AUTHOR = glpat('A');
const REVIEWER = glpat('R');
const ROTATED = glpat('N');
const alnum = (n: number) => 'aB3'.repeat(Math.ceil(n / 3)).slice(0, n);
const github = { githubAuthorToken: `ghp_${alnum(36)}`, githubReviewerToken: `ghp_${alnum(35)}x` };

const twoBot = {
  id: 'lab',
  repo: PROJECT.path,
  authorMayBeAdmin: false,
  identity: 'two-bot' as const,
  forge: 'gitlab' as const,
  gitlab: { baseUrl: GITLAB },
};
const starter = { ...twoBot, identity: 'starter' as const };
const tokens = { author: AUTHOR, reviewer: REVIEWER };

const noMatch: string[] = [];
const onNoMatch = (req: { method?: string; path?: string }) =>
  noMatch.push(`${req.method} ${req.path}`);
let fakes: FakeGitLab[] = [];

beforeAll(() => {
  nock.disableNetConnect();
  nock.emitter.on('no match', onNoMatch);
});
afterEach(() => {
  try {
    expect(noMatch).toEqual([]);
    for (const gl of fakes) expect(gl.unknown).toEqual([]);
  } finally {
    for (const gl of fakes) gl.stop();
    fakes = [];
    noMatch.length = 0;
    nock.cleanAll();
  }
});
afterAll(() => {
  nock.emitter.removeListener('no match', onNoMatch);
  nock.enableNetConnect();
});

function setup(baseUrl = GITLAB) {
  const gl = fakeGitLab({ baseUrl, project: PROJECT });
  fakes.push(gl);
  gl.addUser({ username: 'author-bot', token: AUTHOR, accessLevel: ACCESS.developer });
  gl.addUser({ username: 'reviewer-bot', token: REVIEWER, accessLevel: ACCESS.developer });
  return gl;
}

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error('expected a throw');
}

function expectClean(e: Error, ...secrets: string[]) {
  const text = `${e.message}\n${e.stack ?? ''}\n${JSON.stringify(e)}\n${String(e.cause ?? '')}`;
  for (const s of secrets) expect(text).not.toContain(s);
}

describe('pairFor for a GitLab zone with gitlabTokens', () => {
  test('two-bot: author and reviewer GitLabForges, each on the base URL with its own token', async () => {
    const gl = setup();
    const pair = pairFor(twoBot, github, { gitlabTokens: tokens, requestTimeoutMs: 5000 });
    expect(pair.author).toBeInstanceOf(GitLabForge);
    expect(pair.reviewer).toBeInstanceOf(GitLabForge);
    expect(pair.reviewer).not.toBe(pair.author);
    expect(pair.merger).toBeUndefined();
    expect(await pair.author.viewerLogin()).toBe('author-bot');
    expect(await pair.reviewer?.viewerLogin()).toBe('reviewer-bot');
    expect(gl.requests.map((r) => [r.path, r.user])).toEqual([
      ['/api/v4/user', 'author-bot'],
      ['/api/v4/user', 'reviewer-bot'],
    ]);
    const push = await pair.pusher?.();
    expect(push?.forge).toBe(pair.author);
    await expect(push?.release()).resolves.toBeUndefined();
    expect(gl.requests).toHaveLength(2);
  });

  test('starter: an author GitLabForge, no reviewer, and the author pusher', async () => {
    const gl = setup();
    const pair = pairFor(starter, github, { gitlabTokens: { author: AUTHOR } });
    expect(pair.author).toBeInstanceOf(GitLabForge);
    expect(pair.reviewer).toBeNull();
    expect(pair.merger).toBeUndefined();
    const push = await pair.pusher?.();
    expect(push?.forge).toBe(pair.author);
    await push?.release();
    expect(await pair.author.viewerLogin()).toBe('author-bot');
    expect(gl.requests.map((r) => r.user)).toEqual(['author-bot']);
  });

  test('authorMayBeAdmin routes merges to the reviewer', () => {
    const pair = pairFor({ ...twoBot, authorMayBeAdmin: true }, github, { gitlabTokens: tokens });
    expect(pair.reviewer).toBeInstanceOf(GitLabForge);
    expect(pair.merger).toBe(pair.reviewer);
  });

  test('a two-bot zone without a reviewer token throws a fixed, clean message', () => {
    const e = thrown(() => pairFor(twoBot, github, { gitlabTokens: { author: AUTHOR } }));
    expect(e.message).toBe('a GitLab reviewer token is required for a two-bot zone');
    expectClean(e, AUTHOR, GITLAB, 'gitlab.example', PROJECT.path, 'group/sub');
    expect(
      thrown(() => pairFor(twoBot, github, { gitlabTokens: { author: AUTHOR, reviewer: '' } }))
        .message,
    ).toBe(e.message);
  });

  test('no gitlab.baseUrl throws a fixed, clean message and makes no request', () => {
    const gl = setup();
    const { gitlab: _, ...noBase } = twoBot;
    for (const zone of [noBase, { ...starter, gitlab: undefined }]) {
      const e = thrown(() => pairFor(zone, github, { gitlabTokens: tokens }));
      expect(e.message).toBe('a GitLab zone needs gitlab.baseUrl');
      expectClean(e, AUTHOR, REVIEWER, PROJECT.path, 'group/sub');
    }
    expect(gl.requests).toEqual([]);
  });

  test('without gitlabTokens it still throws GITLAB_UNSUPPORTED and makes no request', () => {
    const gl = setup();
    for (const zone of [twoBot, starter]) {
      const e = thrown(() => pairFor(zone, github));
      expect(e.message).toBe('GitLab zones are not supported yet');
    }
    expect(gl.requests).toEqual([]);
  });

  test('app refs and app callbacks are ignored: none is called', async () => {
    const gl = setup();
    const opts: PairOptions = {
      gitlabTokens: tokens,
      refs: {
        author: { kind: 'github-app', owner: 'acme' },
        reviewer: { kind: 'github-app', owner: 'acme' },
      },
      appTokens: vi.fn(),
      appIdentity: vi.fn(),
      appGrant: vi.fn(),
      pushToken: vi.fn(),
      authorUsesApp: true,
    };
    for (const zone of [twoBot, { ...twoBot, authorMayBeAdmin: true }, starter]) {
      const pair = pairFor(zone, github, opts);
      expect(pair.author).toBeInstanceOf(GitLabForge);
      const push = await pair.pusher?.();
      expect(push?.forge).toBe(pair.author);
      await push?.release();
    }
    expect(opts.appTokens).not.toHaveBeenCalled();
    expect(opts.appIdentity).not.toHaveBeenCalled();
    expect(opts.appGrant).not.toHaveBeenCalled();
    expect(opts.pushToken).not.toHaveBeenCalled();
    // The pair key ignores the refs too, so no resolved credentials are needed.
    expect(() => pairKey(twoBot, github, opts)).not.toThrow();
    expect(gl.requests).toEqual([]);
  });
});

describe('pairKey for a GitLab zone', () => {
  const key = (zone: Parameters<typeof pairKey>[0], t: PairOptions['gitlabTokens']) =>
    pairKey(zone, github, t ? { gitlabTokens: t } : {});

  test('differs for either rotated token and for another base URL', () => {
    const base = key(twoBot, tokens);
    expect(key(twoBot, tokens)).toBe(base);
    expect(key(twoBot, { author: ROTATED, reviewer: REVIEWER })).not.toBe(base);
    expect(key(twoBot, { author: AUTHOR, reviewer: ROTATED })).not.toBe(base);
    expect(key(twoBot, { author: AUTHOR })).not.toBe(base);
    expect(key({ ...twoBot, gitlab: { baseUrl: OTHER_GITLAB } }, tokens)).not.toBe(base);
    expect(key(twoBot, undefined)).not.toBe(base);
  });

  test('names no token', () => {
    const k = key(twoBot, tokens);
    expect(k).not.toContain(AUTHOR);
    expect(k).not.toContain(REVIEWER);
  });

  test("a GitHub zone's key ignores gitlabTokens", () => {
    const hub = { ...twoBot, repo: 'o/r', forge: undefined, gitlab: undefined };
    expect(pairKey(hub, github, { gitlabTokens: tokens })).toBe(pairKey(hub, github));
    expect(pairFor(hub, github, { gitlabTokens: tokens }).author).toBeInstanceOf(GitHubForge);
  });
});

describe('ForgePairs for a GitLab zone', () => {
  test('reuses the pair for the same tokens and base URL', () => {
    const pairs = new ForgePairs();
    const first = pairs.for(twoBot, github, { gitlabTokens: tokens });
    expect(pairs.for({ ...twoBot }, github, { gitlabTokens: { ...tokens } })).toBe(first);
  });

  test('rebuilds after a token rotation', () => {
    const pairs = new ForgePairs();
    const first = pairs.for(twoBot, github, { gitlabTokens: tokens });
    const rotated = pairs.for(twoBot, github, {
      gitlabTokens: { author: AUTHOR, reviewer: ROTATED },
    });
    expect(rotated).not.toBe(first);
    expect(pairs.for(twoBot, github, { gitlabTokens: { author: AUTHOR, reviewer: ROTATED } })).toBe(
      rotated,
    );
  });

  test('rebuilds after a base URL change, and the new pair talks to the new instance', async () => {
    setup();
    const other = setup(OTHER_GITLAB);
    const pairs = new ForgePairs();
    const first = pairs.for(twoBot, github, { gitlabTokens: tokens });
    const moved = { ...twoBot, gitlab: { baseUrl: OTHER_GITLAB } };
    const second = pairs.for(moved, github, { gitlabTokens: tokens });
    expect(second).not.toBe(first);
    expect(await second.author.viewerLogin()).toBe('author-bot');
    expect(other.requests.map((r) => r.user)).toEqual(['author-bot']);
  });
});

describe('pairOptionsFor for a GitLab zone (issue #764)', () => {
  const resolved = {} as Resolved;
  const creds = { resolved, apps: new Map() };
  // No app source is ever consulted for a GitLab zone.
  const never = () => {
    throw new Error('the app token source was called');
  };
  const src = { fresh: vi.fn(never), provider: vi.fn(never), grant: vi.fn(never) };
  const patsOf = (roles: { author?: string; reviewer?: string }): ResolvedGitlabPats =>
    new Map([[twoBot.id, roles]]);
  const of = (zone: Parameters<typeof pairOptionsFor>[0], pats?: ResolvedGitlabPats) =>
    pairOptionsFor(zone, creds, src, pats);

  test('resolved gitlab-pats give gitlabTokens, the reviewer only when it resolved', () => {
    expect(of(twoBot, patsOf(tokens))).toEqual({ gitlabTokens: tokens });
    expect(of(starter, patsOf({ author: AUTHOR }))).toEqual({ gitlabTokens: { author: AUTHOR } });
    expect(of(twoBot, patsOf({ author: AUTHOR }))).toEqual({ gitlabTokens: { author: AUTHOR } });
    expect(pairFor(starter, github, of(starter, patsOf({ author: AUTHOR }))).author).toBeInstanceOf(
      GitLabForge,
    );
    expect(pairFor(twoBot, github, of(twoBot, patsOf(tokens))).reviewer).toBeInstanceOf(
      GitLabForge,
    );
    expect(src.fresh).not.toHaveBeenCalled();
  });

  test('no author pat gives no gitlabTokens, and pairFor refuses with GITLAB_UNSUPPORTED', () => {
    for (const pats of [undefined, new Map(), patsOf({}), patsOf({ reviewer: REVIEWER })]) {
      const opts = of(twoBot, pats);
      expect(opts.gitlabTokens).toBeUndefined();
      expect(thrown(() => pairFor(twoBot, github, opts)).message).toBe(GITLAB_UNSUPPORTED);
      expect(thrown(() => new ForgePairs().for(twoBot, github, opts)).message).toBe(
        GITLAB_UNSUPPORTED,
      );
    }
    // Another zone's pats are not this zone's.
    expect(of(twoBot, new Map([['other', tokens]])).gitlabTokens).toBeUndefined();
  });

  test("a GitHub zone's options and pinned key are as before, whatever the gitlab-pats", () => {
    const hub = { id: 'hub', repo: 'o/r', authorMayBeAdmin: false, identity: 'two-bot' as const };
    const hubPats: ResolvedGitlabPats = new Map([['hub', tokens]]);
    const before = pairOptionsFor(hub, creds, src);
    expect(before).toEqual({});
    expect(pairOptionsFor(hub, creds, src, hubPats)).toEqual(before);
    const PINNED = '["o/r","two-bot",false,"af14c68180fea0c1"]';
    // The same tokens as outbox.test.ts's pinned PAT-mode key.
    expect(pairKey(hub, github)).toBe(PINNED);
    expect(pairKey(hub, github, pairOptionsFor(hub, creds, src, hubPats))).toBe(PINNED);
  });

  test('a rotated gitlab-pat changes pairKey, and ForgePairs builds a new pair', () => {
    const key = (pats: ResolvedGitlabPats) => pairKey(twoBot, github, of(twoBot, pats));
    const base = key(patsOf(tokens));
    expect(key(patsOf({ ...tokens }))).toBe(base);
    expect(key(patsOf({ author: ROTATED, reviewer: REVIEWER }))).not.toBe(base);
    expect(key(patsOf({ author: AUTHOR, reviewer: ROTATED }))).not.toBe(base);
    const pairs = new ForgePairs();
    const first = pairs.for(twoBot, github, of(twoBot, patsOf(tokens)));
    expect(pairs.for(twoBot, github, of(twoBot, patsOf({ ...tokens })))).toBe(first);
    expect(pairs.for(twoBot, github, of(twoBot, patsOf({ ...tokens, author: ROTATED })))).not.toBe(
      first,
    );
  });
});

// Issue #919: a zone's gitlab.caCert. Two fake certificate blocks: nothing here parses them.
const pemBlock = (body: string) =>
  `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
const CA_ONE = pemBlock('Q0FPTkVDQU9ORUNBT05FQ0FPTkVDQU9ORQ');
const CA_TWO = pemBlock('Q0FUV09DQVRXT0NBVFdPQ0FUV09DQVRXTw');

describe('pairFor for a GitLab zone with gitlab.caCert (issue #919)', () => {
  const withCa = (caCert: string) => ({ ...twoBot, gitlab: { baseUrl: GITLAB, caCert } });

  test('both forges send through the CA fetch for the zone', async () => {
    const caFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('PRIVATE-TOKEN');
      const username = token === AUTHOR ? 'author-bot' : 'reviewer-bot';
      return Response.json({ id: 1, username });
    });
    vi.mocked(gitlabFetchFor).mockClear();
    vi.mocked(gitlabFetchFor).mockReturnValueOnce(caFetch as unknown as typeof fetch);
    const pair = pairFor(withCa(CA_ONE), github, { gitlabTokens: tokens });
    expect(vi.mocked(gitlabFetchFor).mock.calls).toEqual([[CA_ONE]]);
    expect(await pair.author.viewerLogin()).toBe('author-bot');
    expect(await pair.reviewer?.viewerLogin()).toBe('reviewer-bot');
    expect(caFetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${GITLAB}/api/v4/user`,
      `${GITLAB}/api/v4/user`,
    ]);
  });

  test('a zone without a CA keeps the global fetch', async () => {
    const gl = setup();
    vi.mocked(gitlabFetchFor).mockClear();
    const pair = pairFor(twoBot, github, { gitlabTokens: tokens });
    expect(vi.mocked(gitlabFetchFor).mock.calls).toEqual([[undefined]]);
    expect(vi.mocked(gitlabFetchFor).mock.results[0]?.value).toBe(globalThis.fetch);
    expect(await pair.author.viewerLogin()).toBe('author-bot');
    expect(await pair.reviewer?.viewerLogin()).toBe('reviewer-bot');
    expect(gl.requests).toHaveLength(2);
  });

  test('pairKey changes when the CA is added, changed or removed, and never holds PEM text', () => {
    const none = pairKey(twoBot, github, { gitlabTokens: tokens });
    const one = pairKey(withCa(CA_ONE), github, { gitlabTokens: tokens });
    const two = pairKey(withCa(CA_TWO), github, { gitlabTokens: tokens });
    expect(one).not.toBe(none);
    expect(two).not.toBe(one);
    expect(two).not.toBe(none);
    expect(pairKey(withCa(CA_ONE), github, { gitlabTokens: tokens })).toBe(one);
    for (const k of [one, two]) {
      expect(k).not.toContain('BEGIN');
      expect(k).not.toContain('CERTIFICATE');
      expect(k).not.toContain('Q0FPTkVD');
      expect(k).not.toContain('Q0FUV09D');
    }
  });

  test('a zone with no CA keeps the key it had before', () => {
    const k = JSON.parse(pairKey(twoBot, github, { gitlabTokens: tokens })) as unknown[];
    const tail = k.at(-1) as unknown[];
    expect(tail).toHaveLength(3);
    expect(tail.slice(0, 2)).toEqual(['forge:gitlab', GITLAB]);
    expect(tail[2]).toMatch(/^[0-9a-f]{16}$/);
    // An empty caCert is no CA.
    expect(pairKey(withCa(''), github, { gitlabTokens: tokens })).toBe(JSON.stringify(k));
  });

  test('ForgePairs rebuilds the pair when the CA is added, changed or removed', () => {
    const pairs = new ForgePairs();
    const opts = { gitlabTokens: tokens };
    const p0 = pairs.for(twoBot, github, opts);
    const p1 = pairs.for(withCa(CA_ONE), github, opts);
    expect(p1).not.toBe(p0);
    expect(pairs.for(withCa(CA_ONE), github, opts)).toBe(p1);
    const p2 = pairs.for(withCa(CA_TWO), github, opts);
    expect(p2).not.toBe(p1);
    expect(pairs.for(twoBot, github, opts)).not.toBe(p2);
  });
});
