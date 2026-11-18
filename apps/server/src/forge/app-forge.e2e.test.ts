/**
 * End to end (spec docs/superpowers/specs/2026-11-13-github-app-auth.md §4.3): the real chain
 * `createAppTokenSource` (JWTs signed with generated RSA keys) → `provider` and `grant` →
 * `GitHubForge` with an app identity, against a recording fake GitHub built on nock. No request
 * leaves the process (`nock.disableNetConnect()`), and none reaches `GET /user`.
 */
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { inspect } from 'node:util';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { openDb } from '../db/open.js';
import {
  getOutbox,
  getWorkItem,
  insertOutbox,
  upsertDropZone,
  upsertWorkItem,
} from '../db/repo.js';
import { branchProtectionProblems } from '../flow/guards.js';
import { reconcileZone } from '../flow/reconcile.js';
import { zonePass } from '../flow/snapshot.js';
import { log } from '../log.js';
import {
  type ForgePair,
  ForgePairs,
  opKeys,
  opMarker,
  pairOptionsFor,
  resolveUnknown,
} from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { makeZone, usageCfg } from '../test/fixtures.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import type { Resolved } from '../vault/credentials.js';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { type AppTokenSource, type AppTokenZone, createAppTokenSource } from './app-tokens.js';
import type { BranchRulesRead } from './github.js';
import { GitHubForge } from './github.js';
import { USE_PERMISSIONS } from './github-app.js';
import { serverScrubSet } from './scrub-set.js';

const api = 'https://api.github.com';
const OWNER = 'acme';
const REPO = 'demo';
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const REPOSITORY_ID = 4242;
const HOUR = 60 * 60 * 1000;

const keyPair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

type App = {
  role: AppRole;
  appId: string;
  slug: string;
  installationId: number;
  pem: string;
  publicKey: string;
  /** What the installation grants on the repository. */
  grant: Record<string, string>;
};

const APPS: Record<AppRole, App> = {
  author: {
    role: 'author',
    appId: '100',
    slug: 'acme-author',
    installationId: 11,
    ...(({ privateKey, publicKey }) => ({ pem: privateKey, publicKey }))(keyPair()),
    grant: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
  },
  reviewer: {
    role: 'reviewer',
    appId: '200',
    slug: 'acme-reviewer',
    installationId: 77,
    ...(({ privateKey, publicKey }) => ({ pem: privateKey, publicKey }))(keyPair()),
    grant: { contents: 'read', pull_requests: 'write', metadata: 'read' },
  },
};
/** The install-wide PATs the pair is also given: an app role must never send them. */
const PATS = {
  githubAuthorToken: ['ghp', 'PATAUTHOR'.padEnd(36, 'A')].join('_'),
  githubReviewerToken: ['ghp', 'PATREVIEWER'.padEnd(36, 'R')].join('_'),
};

const BOT = { author: 'acme-author[bot]', reviewer: 'acme-reviewer[bot]' } as const;

const ZONE = makeZone({
  id: 'main',
  repo: `${OWNER}/${REPO}`,
  identity: 'two-bot',
  requireBranchProtection: true,
  authorLoginAliases: ['legacy-bot'],
  githubApp: {
    repositoryId: REPOSITORY_ID,
    installations: { author: APPS.author.installationId, reviewer: APPS.reviewer.installationId },
  },
});

/** Every request the fake GitHub saw. */
interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string;
  body: unknown;
  /** The app whose JWT signed it, when it carried a valid one. */
  jwtOf?: AppRole;
  /** The app whose minted server-use token it carried. */
  tokenOf?: AppRole;
}

type Reply = [number, unknown] | [number, unknown, Record<string, string>];
type Route = { method: string; path: string | RegExp; reply: (c: Call) => Reply };

const b64urlJson = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** The app whose key signed `jwt`, or undefined when no app's key did. */
function signerOf(jwt: string): AppRole | undefined {
  const [head = '', body = '', sig = ''] = jwt.split('.');
  let iss: unknown;
  try {
    iss = (b64urlJson(body) as { iss?: unknown }).iss;
  } catch {
    return undefined;
  }
  for (const app of Object.values(APPS)) {
    if (iss !== app.appId) continue;
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      createPublicKey(app.publicKey),
      Buffer.from(sig, 'base64url'),
    );
    return ok ? app.role : undefined;
  }
  return undefined;
}

/**
 * A recording fake GitHub. The app endpoints (installation lookup, mint, the #267 probe's repository
 * read and revoke) are built in; any other request must carry a server-use token minted here, and
 * is answered by the test's `routes` (404 and recorded as unrouted when none matches).
 */
function fakeGitHub() {
  const calls: Call[] = [];
  const routes: Route[] = [];
  const unrouted: string[] = [];
  /** Server-use tokens minted per role, and their expiry as GitHub sent it. */
  const minted: { role: AppRole; token: string; expiresAt: string }[] = [];
  const probes: { role: AppRole; token: string }[] = [];
  let mintCount = 0;

  const expiresAt = () => {
    const sec = Math.floor(Date.now() / 1000) * 1000 + HOUR;
    return new Date(sec).toISOString().replace('.000Z', 'Z');
  };

  async function handle(req: Request): Promise<Reply> {
    const url = new URL(req.url);
    const text = await req.text();
    const authorization = req.headers.get('authorization') ?? '';
    const call: Call = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      authorization,
      body: text ? JSON.parse(text) : undefined,
    };
    const bearer = /^Bearer (eyJ\S+)$/.exec(authorization)?.[1];
    if (bearer) {
      const role = signerOf(bearer);
      if (role) call.jwtOf = role;
    }
    const credential = authorization.replace(/^(Bearer|token) /, '');
    const own = minted.find((m) => m.token === credential);
    if (own) call.tokenOf = own.role;
    calls.push(call);

    const repoPath = `/repos/${OWNER}/${REPO}`;
    const mintPath = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(call.path);
    if (mintPath) {
      const app = call.jwtOf ? APPS[call.jwtOf] : undefined;
      if (!app) return [401, { message: 'A JSON web token could not be decoded' }];
      if (Number(mintPath[1]) !== app.installationId) return [404, { message: 'Not Found' }];
      const body = call.body as { repositories?: unknown; repository_ids?: unknown };
      mintCount += 1;
      // Built at runtime so no token-shaped literal sits in the tracked file.
      if ('repositories' in body) {
        const token = ['ghs', `PROBE${app.role}${mintCount}`.padEnd(36, 'P')].join('_');
        probes.push({ role: app.role, token });
        return [201, { token, expires_at: expiresAt() }];
      }
      const token = ['ghs', `MINT${app.role}${mintCount}`.padEnd(36, 'M')].join('_');
      const exp = expiresAt();
      minted.push({ role: app.role, token, expiresAt: exp });
      return [201, { token, expires_at: exp, permissions: body }];
    }
    if (call.method === 'GET' && call.path === `${repoPath}/installation`) {
      const app = call.jwtOf ? APPS[call.jwtOf] : undefined;
      if (!app) return [401, { message: 'A JSON web token could not be decoded' }];
      return [200, { id: app.installationId, permissions: app.grant }];
    }
    const probe = probes.find((p) => `Bearer ${p.token}` === authorization);
    if (probe) {
      if (call.method === 'GET' && call.path === repoPath) return [200, { id: REPOSITORY_ID }];
      if (call.method === 'DELETE' && call.path === '/installation/token') return [204, ''];
      return [403, { message: 'Resource not accessible by integration' }];
    }
    if (!call.tokenOf) return [401, { message: 'Bad credentials' }];
    const route = routes.find(
      (r) =>
        r.method === call.method &&
        (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)),
    );
    if (!route) {
      unrouted.push(`${call.method} ${call.path}`);
      return [404, { message: 'Not Found' }];
    }
    return route.reply(call);
  }

  const scope = nock(api).persist();
  for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    scope.intercept(() => true, m).reply(async (req: Request) => handle(req));

  const isProbeMint = (c: Call) =>
    c.path.endsWith('/access_tokens') && 'repositories' in (c.body as object);
  return {
    calls,
    routes,
    unrouted,
    minted,
    probes,
    route(method: string, path: string | RegExp, reply: (c: Call) => Reply) {
      routes.push({ method, path, reply });
    },
    /** The server-use mints (narrowed by repository id), the #267 probe left out. */
    mints: (role?: AppRole) =>
      calls.filter(
        (c) =>
          c.path.endsWith('/access_tokens') &&
          !isProbeMint(c) &&
          (role === undefined || c.jwtOf === role),
      ),
    probeMints: (role?: AppRole) =>
      calls.filter((c) => isProbeMint(c) && (role === undefined || c.jwtOf === role)),
    /** The forge's own requests: those carrying a minted server-use token. */
    forgeCalls: (role?: AppRole) =>
      calls.filter((c) => c.tokenOf !== undefined && (role === undefined || c.tokenOf === role)),
  };
}

let gh: ReturnType<typeof fakeGitHub>;
let userMock: nock.Scope;
const noMatch: string[] = [];
const onNoMatch = (req: { method?: string; path?: string }) =>
  noMatch.push(`${req.method} ${req.path}`);
/** Every console line written while a test ran (the server log goes to console.error). */
const captured: string[] = [];
/** Every value a forge returned and every error it raised, serialized. */
const outputs: string[] = [];
const keep = <T>(v: T): T => {
  outputs.push(typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)));
  return v;
};

beforeAll(() => {
  nock.disableNetConnect();
  nock.emitter.on('no match', onNoMatch);
});
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      captured.push(a.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: 6 }))).join(' '));
    });
  // Registered first, so it would answer a `GET /user`: it must stay pending.
  userMock = nock(api)
    .get('/user')
    .reply(403, { message: 'Resource not accessible by integration' });
  gh = fakeGitHub();
});
afterEach(() => {
  try {
    expect(userMock.isDone()).toBe(false);
    expect(gh.calls.filter((c) => c.path === '/user')).toEqual([]);
    // Every repository request carried a minted server-use token, or a JWT for the app endpoints.
    for (const c of gh.calls.filter((c) => c.path.startsWith(REPO_PATH)))
      expect(
        c.tokenOf !== undefined ||
          c.jwtOf !== undefined ||
          gh.probes.some((p) => c.authorization === `Bearer ${p.token}`),
      ).toBe(true);
    expect(noMatch).toEqual([]);
    expect(gh.unrouted).toEqual([]);
    // No secret in anything the file saw: logs, returned values and errors.
    const secrets = [
      ...gh.minted.map((m) => m.token),
      ...gh.probes.map((p) => p.token),
      APPS.author.pem,
      APPS.reviewer.pem,
      ...Object.values(PATS),
      ...gh.calls.flatMap((c) => /^Bearer (eyJ\S+)$/.exec(c.authorization)?.slice(1) ?? []),
    ];
    // No request carried a PAT: every role is its app.
    for (const c of gh.calls)
      for (const p of Object.values(PATS)) expect(c.authorization).not.toContain(p);
    for (const text of [...captured, ...outputs]) {
      for (const s of secrets) expect(text).not.toContain(s);
      expect(text).not.toContain('PRIVATE KEY');
    }
  } finally {
    noMatch.length = 0;
    captured.length = 0;
    outputs.length = 0;
    serverScrubSet.clear();
    vi.restoreAllMocks();
    nock.cleanAll();
  }
});
afterAll(() => {
  nock.emitter.removeListener('no match', onNoMatch);
  nock.enableNetConnect();
});

const entryOf = (app: App): AppEntryRead => ({
  entry: {
    appId: app.appId,
    slug: app.slug,
    clientId: `Iv1.${app.appId}`,
    pem: app.pem,
    importedAt: '2026-11-01T00:00:00Z',
  },
  source: 'file',
  fingerprint: `fp-${app.role}`,
});

/**
 * One zone on `acme`, both apps resolved, and its pair as the live server builds it (main.ts):
 * `pairOptionsFor` over the resolved credentials and a real `createAppTokenSource`, through
 * `ForgePairs`.
 */
function world(): {
  source: AppTokenSource;
  pair: ForgePair;
  author: GitHubForge;
  reviewer: GitHubForge;
} {
  const zones: AppTokenZone[] = [ZONE];
  const apps: ResolvedApps = new Map([
    [OWNER, { author: entryOf(APPS.author), reviewer: entryOf(APPS.reviewer) }],
  ]);
  const source = createAppTokenSource({
    resolvedApps: () => apps,
    zones: () => zones,
    add: (s) => serverScrubSet.add(s),
  });
  const pair = new ForgePairs().for(
    ZONE,
    PATS,
    pairOptionsFor(ZONE, { resolved: {} as Resolved, apps }, source),
  );
  const { author, reviewer } = pair;
  if (!(author instanceof GitHubForge) || !(reviewer instanceof GitHubForge))
    throw new Error('expected GitHub forges');
  return { source, pair, author, reviewer };
}

/** `GET /repos` as GitHub sends it, with every permission set (an app forge must ignore them). */
const repoBody = {
  id: REPOSITORY_ID,
  full_name: `${OWNER}/${REPO}`,
  private: true,
  default_branch: 'main',
  owner: { login: OWNER, type: 'Organization' },
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
};

describe('mint and cache', () => {
  test('one server-use mint per role, under a JWT, narrowed by repository id, reused', async () => {
    const { author, reviewer } = world();
    gh.route('GET', REPO_PATH, () => [200, repoBody]);

    expect(keep(await author.getDefaultBranch())).toBe('main');
    expect(keep(await author.getDefaultBranch())).toBe('main');
    expect(keep(await reviewer.getDefaultBranch())).toBe('main');
    expect(keep(await reviewer.getDefaultBranch())).toBe('main');

    for (const role of ['author', 'reviewer'] as const) {
      const mints = gh.mints(role);
      expect(mints).toHaveLength(1);
      const [mint] = mints;
      expect(mint?.method).toBe('POST');
      expect(mint?.path).toBe(`/app/installations/${APPS[role].installationId}/access_tokens`);
      expect(mint?.authorization).toMatch(/^Bearer eyJ/);
      expect(mint?.jwtOf).toBe(role);
      expect(mint?.body).toEqual({
        repository_ids: [REPOSITORY_ID],
        permissions: USE_PERMISSIONS[`server-${role}`],
      });
      // The #267 verification ran once, and is not counted above.
      expect(gh.probeMints(role)).toHaveLength(1);
      const token = gh.minted.find((m) => m.role === role)?.token;
      const reads = gh.calls.filter((c) => c.method === 'GET' && c.path === REPO_PATH && c.tokenOf);
      expect(reads.filter((c) => c.tokenOf === role)).toHaveLength(2);
      for (const c of gh.forgeCalls(role)) expect(c.authorization).toBe(`token ${token}`);
    }
    expect(gh.minted).toHaveLength(2);
  });

  test('viewerLogin is <slug>[bot] and sends no request', async () => {
    const { author, reviewer } = world();
    expect(keep(await author.viewerLogin())).toBe(BOT.author);
    expect(keep(await reviewer.viewerLogin())).toBe(BOT.reviewer);
    expect(gh.calls).toEqual([]);
  });
});

describe('getBranchRules on an app token', () => {
  const branchRules = (rulesets: { id: number; types: string[] }[]) =>
    gh.route('GET', `${REPO_PATH}/rules/branches/main`, () => [
      200,
      rulesets.flatMap(({ id, types }) =>
        types.map((type) => ({
          type,
          ruleset_id: id,
          ...(type === 'pull_request'
            ? {
                parameters: {
                  required_approving_review_count: 1,
                  dismiss_stale_reviews_on_push: true,
                },
              }
            : type === 'required_status_checks'
              ? {
                  parameters: {
                    required_status_checks: [{ context: 'test', integration_id: 15368 }],
                  },
                }
              : {}),
        })),
      ),
    ]);
  const ruleset = (id: number, body: Record<string, unknown>) =>
    gh.route('GET', `${REPO_PATH}/rulesets/${id}`, (c) => {
      expect(c.query.get('includes_parents')).toBe('true');
      return [200, { id, enforcement: 'active', ...body }];
    });

  test.each([
    ['a reported current_user_can_bypass', { current_user_can_bypass: 'always' }, 'yes'],
    ['a reported never', { current_user_can_bypass: 'never' }, 'no'],
    [
      'an absent field with an Integration bypass actor of this app id',
      { bypass_actors: [{ actor_type: 'Integration', actor_id: 100, bypass_mode: 'always' }] },
      'yes',
    ],
    [
      'an absent field with an Integration bypass actor of another app',
      { bypass_actors: [{ actor_type: 'Integration', actor_id: 200, bypass_mode: 'always' }] },
      'no',
    ],
    ['an absent field with nothing visible', {}, 'unknown'],
  ])('%s', async (_what, body, can) => {
    const { author } = world();
    branchRules([{ id: 1, types: ['pull_request'] }]);
    ruleset(1, { name: 'protect-main', ...body });
    const read = keep(await author.getBranchRules('main'));
    expect(read).toMatchObject({
      kind: 'ok',
      rules: {
        asApp: true,
        viewerIsAdmin: false,
        viewerCanBypass: can === 'yes',
        bypass: [{ rulesetId: 1, name: 'protect-main', restrictUpdatesOnly: false, can }],
      },
    });
    expect(gh.calls.filter((c) => c.path.includes('/collaborators/'))).toEqual([]);
    expect(gh.forgeCalls('author').length).toBeGreaterThan(0);
  });

  describe('branchProtectionProblems on the app forges (two-bot, protection required)', () => {
    const reads = async () => {
      const { author, reviewer } = world();
      const rules = {
        author: keep(await author.getBranchRules('main')),
        reviewer: keep(await reviewer.getBranchRules('main')),
      } satisfies { author: BranchRulesRead; reviewer: BranchRulesRead };
      return branchProtectionProblems(rules, ZONE);
    };
    const authorActor = { actor_type: 'Integration', actor_id: 100, bypass_mode: 'always' };

    test('an author bypass on an update-only jumpmaster-merge is not "bot can bypass"', async () => {
      branchRules([
        { id: 1, types: ['pull_request', 'required_status_checks'] },
        { id: 2, types: ['update'] },
      ]);
      ruleset(1, { name: 'protect-main', bypass_actors: [] });
      ruleset(2, { name: 'jumpmaster-merge', bypass_actors: [authorActor] });
      expect(await reads()).toEqual([]);
    });

    test('an author bypass on any other ruleset is "bot can bypass"', async () => {
      branchRules([
        { id: 1, types: ['pull_request', 'required_status_checks'] },
        { id: 2, types: ['update'] },
      ]);
      ruleset(1, { name: 'protect-main', bypass_actors: [authorActor] });
      ruleset(2, { name: 'jumpmaster-merge', bypass_actors: [authorActor] });
      expect(await reads()).toEqual(['bot can bypass']);
    });
  });
});

describe('repoAccess on an app token', () => {
  test('the grant gives the permissions, scopes are null, the expiry is the mint', async () => {
    const { author } = world();
    gh.route('GET', REPO_PATH, () => [
      200,
      repoBody,
      // Headers only a PAT's answer would carry: an app forge must not read them.
      {
        'x-oauth-scopes': 'repo, admin:org',
        'github-authentication-token-expiration': '2030-01-01 00:00:00 UTC',
      },
    ]);
    const access = keep(await author.repoAccess());
    const mint = gh.minted.find((m) => m.role === 'author');
    expect(access).toEqual({
      private: true,
      defaultBranch: 'main',
      permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
      scopes: null,
      tokenExpiresAt: new Date(String(mint?.expiresAt)).toISOString(),
      ownerType: 'Organization',
    });
    // The grant was read under the author app's JWT, besides the #267 verification's lookup.
    const lookups = gh.calls.filter((c) => c.path === `${REPO_PATH}/installation`);
    expect(lookups).toHaveLength(2);
    for (const c of lookups) {
      expect(c.authorization).toMatch(/^Bearer eyJ/);
      expect(c.jwtOf).toBe('author');
    }
    expect(gh.mints('author')).toHaveLength(1);
  });
});

describe('marker reads', () => {
  const marker = '<!-- jm:op:k1 -->';

  test('findIssueByMarker asks for creator=acme-author[bot]', async () => {
    const { author } = world();
    gh.route('GET', `${REPO_PATH}/issues`, (c) => [
      200,
      c.query.get('creator') === BOT.author
        ? [
            { number: 1, body: `x\n${marker}`, user: { login: 'someone' } },
            { number: 2, body: `x\n${marker}`, user: { login: BOT.author } },
          ]
        : [],
    ]);
    expect(keep(await author.findIssueByMarker(marker, '2026-01-01T00:00:00Z'))).toEqual({
      number: 2,
    });
    const [list] = gh.forgeCalls('author').filter((c) => c.path === `${REPO_PATH}/issues`);
    expect(list?.query.get('creator')).toBe(BOT.author);
  });

  const review = (id: number, login: string) => ({
    id,
    user: { login },
    state: 'APPROVED',
    commit_id: 'h1',
    body: `ok\n\n${marker}`,
    submitted_at: '2026-11-18T00:00:00Z',
  });

  test('findReviewByMarker matches only a review by the reviewer app', async () => {
    const { reviewer } = world();
    gh.route('GET', `${REPO_PATH}/pulls/5/reviews`, () => [
      200,
      [review(1, 'other[bot]'), review(2, BOT.reviewer)],
    ]);
    expect(keep(await reviewer.findReviewByMarker(5, marker))).toEqual({ id: 2 });
  });

  test('findReviewByMarker ignores a matching review by other[bot]', async () => {
    const { reviewer } = world();
    gh.route('GET', `${REPO_PATH}/pulls/5/reviews`, () => [200, [review(1, 'other[bot]')]]);
    expect(keep(await reviewer.findReviewByMarker(5, marker))).toBeNull();
    expect(gh.forgeCalls('reviewer')).toHaveLength(1);
  });
});

describe('adoption through resolveUnknown', () => {
  const head = 'agent/issue-1';

  test.each([
    ['the author app', BOT.author, 1],
    ['an authorLoginAliases entry', 'legacy-bot', 1],
    ['a stranger', 'mallory', 0],
  ])('a listed PR by %s', async (_who, login, adopted) => {
    const { author, reviewer } = world();
    const db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: ZONE.repo, defaultBranch: 'main', configJson: '{}' });
    const itemId = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 1,
      title: 'Issue 1',
      body: 'b',
      author: 'alice',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    }).id;
    const opKey = opKeys.pr(itemId, 'h1');
    insertOutbox(db, {
      id: 'row-1',
      opKey,
      kind: 'create_pr',
      workItemId: itemId,
      zoneId: 'main',
      payloadJson: JSON.stringify({
        head,
        base: 'main',
        title: 'Issue 1',
        body: 'Closes #1',
        adoptPulls: [7],
        authorLoginAliases: ZONE.authorLoginAliases,
      }),
      state: 'unknown',
      createdAt: t0.toISOString(),
    });
    gh.route('GET', `${REPO_PATH}/pulls`, (c) => {
      expect(c.query.get('head')).toBe(`${OWNER}:${head}`);
      return [
        200,
        [
          {
            number: 7,
            title: 'hand-opened',
            state: 'open',
            merged_at: null,
            user: { login },
            head: { sha: 'h1', ref: head, repo: { full_name: `${OWNER}/${REPO}` } },
            base: { ref: 'main' },
            body: 'no marker here',
            labels: [],
          },
        ],
      ];
    });
    const forges: ForgePair = { author, reviewer };
    expect(keep(await resolveUnknown(db, forges, 'main', t0, 45))).toBe(adopted);
    const row = keep(getOutbox(db, opKey));
    expect(row?.state).toBe(adopted ? 'done' : 'unknown');
    if (adopted) expect(JSON.parse(String(row?.resultJson))).toEqual({ number: 7, created: false });
    expect(gh.forgeCalls('author')).toHaveLength(1);
  });
});

describe('adoption in a reconcile pass (flow/reconcile.ts)', () => {
  test('an open agent PR by acme-author[bot] with the server marker is adopted', async () => {
    const { pair } = world();
    // Paused: the pass resolves the outbox, lists and adopts, and starts nothing.
    const zone = { ...ZONE, mode: 'paused' as const };
    const db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: ZONE.repo, defaultBranch: 'main', configJson: '{}' });
    const itemId = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 1,
      title: 'Issue 1',
      body: 'b',
      author: 'alice',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    }).id;
    gh.route('GET', `${REPO_PATH}/rules/branches/main`, () => [200, []]);
    const pull = (number: number, login: string) => ({
      number,
      title: `PR ${number}`,
      state: 'open',
      merged_at: null,
      user: { login },
      head: { sha: `h${number}`, ref: 'agent/issue-1', repo: { full_name: `${OWNER}/${REPO}` } },
      base: { ref: 'main' },
      body: `work\n${opMarker(opKeys.pr(itemId, `h${number}`))}`,
      labels: [],
    });
    gh.route('GET', `${REPO_PATH}/pulls`, () => [200, [pull(5, 'mallory'), pull(7, BOT.author)]]);
    const zp = keep(await zonePass(pair, zone, 'main'));
    expect(zp.authorLogins).toContain(BOT.author);
    const now = new Date();
    keep(await reconcileZone(db, pair, zone, zp, promptVersions(), usageCfg, [], now));
    expect(keep(getWorkItem(db, itemId))).toMatchObject({ state: 'pr_open', prNumber: 7 });
    const lists = gh.forgeCalls('author').filter((c) => c.path === `${REPO_PATH}/pulls`);
    expect(lists).toHaveLength(1);
    expect(lists[0]?.authorization).toBe(
      `token ${gh.minted.find((m) => m.role === 'author')?.token}`,
    );
  });
});

describe('isTrusted on an app token', () => {
  test('a write role is trusted, read with the minted token', async () => {
    const { author } = world();
    gh.route('GET', `${REPO_PATH}/collaborators/alice/permission`, () => [
      200,
      { permission: 'write', role_name: 'write', user: { login: 'alice' } },
    ]);
    expect(keep(await author.isTrusted('alice'))).toBe(true);
    const [read] = gh.forgeCalls('author');
    expect(read?.authorization).toBe(`token ${gh.minted[0]?.token}`);
  });

  test('a 404 is not trusted', async () => {
    const { author } = world();
    gh.route('GET', `${REPO_PATH}/collaborators/mallory/permission`, () => [
      404,
      { message: 'Not Found' },
    ]);
    expect(keep(await author.isTrusted('mallory'))).toBe(false);
    expect(gh.forgeCalls('author')).toHaveLength(1);
  });
});

describe('secrets', () => {
  test('a refused read: the error and the log quote neither the token nor the PEM', async () => {
    const { author } = world();
    gh.route('GET', `${REPO_PATH}/issues/9`, () => [
      403,
      { message: 'Resource not accessible by integration' },
    ]);
    let error: unknown;
    try {
      await author.getIssue(9);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).toBe(403);
    // Everything an error carries, its request and response included.
    keep(inspect(error, { depth: 8 }));
    keep(String((error as Error).stack));
    // The server logs a failed read as it would.
    log(`reading issue 9 failed: ${(error as Error).message} ${inspect(error, { depth: 8 })}`);
    expect(captured.length).toBeGreaterThan(0);
    // The read did carry the token: the assertions in afterEach are not vacuous.
    expect(gh.forgeCalls('author')).toHaveLength(1);
    expect(gh.minted).toHaveLength(1);
  });
});
