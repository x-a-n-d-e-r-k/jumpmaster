/**
 * The zone's GitHub guidance, app-first (§4.4, issue #437): an app-author zone's repository is read
 * through its author app's server-author token, PAT or not; every other zone reads as before.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../app.js';
import { setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import type { Config, DropZoneConfig } from '../config.js';
import { runCtl } from '../ctl.js';
import { openDb } from '../db/open.js';
import { AppTokenError, type AppTokenSource } from '../forge/app-tokens.js';
import { mergeRulesetJson } from '../github/guidance.js';
import { APP_ENTRIES, APP_SECRETS } from '../test/app-guidance-fixture.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import type { AppEntryRead } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { guidanceReader } from './control.js';
import { type GuidanceForge, guidanceFor } from './github.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
// Built at runtime so no token-shaped literal sits in the tracked file.
const AUTHOR = ['github', 'pat', 'GHTESTAUTHORDUMMY0123456789'].join('_');
const REVIEWER = ['github', 'pat', 'GHTESTREVIEWERDUMMY0123456789'].join('_');
const minted = (n: number) => ['ghs', `MINTED${String(n).padStart(4, '0')}`.repeat(4)].join('_');
const SENTINEL = ['ghs', 'SENTINELSENTINELSENTINEL'].join('_');

const baseEnv = {
  JM_CLAUDE_TOKEN: ['sk-ant', 'oat01-GHTESTCLAUDEDUMMY0123456789'].join('-'),
  JM_GITHUB_REVIEWER_TOKEN: REVIEWER,
  JM_JOIN_TOKEN: 'join-secret-value-7',
  JM_OPERATOR_TOKEN: TOKEN,
  JM_DEV_IMAGES: '1',
};
const withPat = { ...baseEnv, JM_GITHUB_AUTHOR_TOKEN: AUTHOR };

const entry = (appId: string, slug: string, fingerprint: string): AppEntryRead => ({
  source: 'vault',
  fingerprint,
  entry: { appId, slug, clientId: 'c', pem: 'not-a-key', importedAt: '2026-11-01' },
});
const missing: AppEntryRead = { source: 'missing' };
const authorApp = entry('42', 'jm-author-app', 'fp-a1');
const reviewerApp = entry('43', 'jm-reviewer-app', 'fp-r1');

const appsOf = (author: AppEntryRead, reviewer: AppEntryRead = missing): ResolvedApps =>
  new Map([['octo-org', { author, reviewer }]]);

const zoneOf = (o: {
  identity?: 'two-bot' | 'starter';
  installations?: { author?: number; reviewer?: number };
}): DropZoneConfig =>
  makeZone({
    id: 'demo',
    repo: 'octo-org/demo',
    identity: o.identity ?? 'two-bot',
    ...(o.installations ? { githubApp: { repositoryId: 1, installations: o.installations } } : {}),
  } as Partial<DropZoneConfig>);
const authorZone = zoneOf({ installations: { author: 11 } });
const twoAppZone = zoneOf({ installations: { author: 11, reviewer: 12 } });

const CI_YML =
  'on: pull_request\njobs:\n  test:\n    runs-on: x\n  lint:\n    name: Lint\n    runs-on: x\n';

/** A fake GitHub per token, recording every call and every token a forge was built on. */
function fakeForge() {
  const calls: string[] = [];
  const tokens: string[] = [];
  const forgeOf = (_repo: string, token: string): GuidanceForge => {
    tokens.push(token);
    return {
      async repoAccess() {
        calls.push('repoAccess');
        return {
          private: false,
          defaultBranch: 'main',
          permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
          scopes: null,
          tokenExpiresAt: null,
          ownerType: 'Organization' as const,
        };
      },
      async ownerType() {
        calls.push('ownerType');
        return 'Organization' as const;
      },
      async viewerLogin() {
        calls.push('viewerLogin');
        if (token === AUTHOR) return 'pat-author';
        if (token === REVIEWER) return 'pat-reviewer';
        throw Object.assign(new Error('Requires authentication'), { status: 401 });
      },
      async listDir(_ref: string, path: string) {
        calls.push(`listDir ${path}`);
        return path === '.github/workflows' ? ['ci.yml'] : [];
      },
      async getFileAt(_ref: string, path: string) {
        calls.push(`getFileAt ${path}`);
        return path === '.github/workflows/ci.yml' ? CI_YML : null;
      },
    };
  };
  return { calls, tokens, forgeOf };
}

/** A fake app token source: each `token()` returns the next of `tokens` (or rejects). */
function fakeSource(next: () => Promise<string>) {
  const asked: unknown[][] = [];
  const source: Pick<AppTokenSource, 'provider'> = {
    provider(...args) {
      asked.push(args);
      return { token: next };
    },
  };
  return { source, asked };
}
const counting = () => {
  let n = 0;
  return fakeSource(async () => minted(++n));
};

function storeWith(
  env: Record<string, string>,
  apps: ResolvedApps,
  zones: DropZoneConfig[],
): { store: ConfigStore; config: Config } {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-ghguide-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, undefined),
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const config = { ...store.current(), dropZones: zones };
  vi.spyOn(store, 'current').mockReturnValue(config);
  vi.spyOn(store, 'resolvedApps').mockReturnValue(apps);
  return { store, config };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guidanceFor, app-first', () => {
  test('an app-author zone with no author PAT reads on the provider token; the author is the app bot', async () => {
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [authorZone]);
    const f = fakeForge();
    const s = counting();
    const r = await guidanceFor(store, config, authorZone, f.forgeOf, {
      now: () => t0,
      appTokens: s.source,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.asked).toEqual([['demo', 'author', 'server-author']]);
    expect(f.tokens[0]).toBe(minted(1));
    expect(r.logins.author).toBe('jm-author-app[bot]');
    // A PAT reviewer's login is read as today.
    expect(r.logins.reviewer).toBe('pat-reviewer');
    // A token read: the workflow job names were read.
    expect(f.calls).toContain('getFileAt .github/workflows/ci.yml');
    expect(r.guidance.ruleset.text).toContain('Lint');
  });

  test('an app-author zone with an author PAT set still reads on the app, never the PAT', async () => {
    const { store, config } = storeWith(withPat, appsOf(authorApp), [authorZone]);
    const f = fakeForge();
    const r = await guidanceFor(store, config, authorZone, f.forgeOf, {
      now: () => t0,
      appTokens: counting().source,
    });
    expect(r.ok && r.logins.author).toBe('jm-author-app[bot]');
    expect(f.tokens).not.toContain(AUTHOR);
    expect(f.tokens[0]).toBe(minted(1));
  });

  test('a two-app zone takes both logins from the entries, never GET /user', async () => {
    const { store, config } = storeWith(withPat, appsOf(authorApp, reviewerApp), [twoAppZone]);
    const f = fakeForge();
    const r = await guidanceFor(store, config, twoAppZone, f.forgeOf, {
      now: () => t0,
      appTokens: counting().source,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logins).toEqual({ author: 'jm-author-app[bot]', reviewer: 'jm-reviewer-app[bot]' });
    expect(f.calls).not.toContain('viewerLogin');
  });

  test('a re-minted token hits the cache: the repository is read once', async () => {
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [authorZone]);
    const f = fakeForge();
    const s = counting();
    const opts = { now: () => t0, appTokens: s.source };
    expect((await guidanceFor(store, config, authorZone, f.forgeOf, opts)).ok).toBe(true);
    expect((await guidanceFor(store, config, authorZone, f.forgeOf, opts)).ok).toBe(true);
    expect(f.calls.filter((c) => c === 'repoAccess')).toHaveLength(1);
  });

  test('a rotated author key, another app or a changed reviewer credential misses the cache', async () => {
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [twoAppZone]);
    const f = fakeForge();
    const opts = { now: () => t0, appTokens: counting().source };
    const reads = () => f.calls.filter((c) => c === 'repoAccess').length;
    await guidanceFor(store, config, twoAppZone, f.forgeOf, opts);
    expect(reads()).toBe(1);
    vi.spyOn(store, 'resolvedApps').mockReturnValue(appsOf(entry('42', 'jm-author-app', 'fp-a2')));
    await guidanceFor(store, config, twoAppZone, f.forgeOf, opts);
    expect(reads()).toBe(2);
    vi.spyOn(store, 'resolvedApps').mockReturnValue(appsOf(entry('99', 'jm-author-app', 'fp-a2')));
    await guidanceFor(store, config, twoAppZone, f.forgeOf, opts);
    expect(reads()).toBe(3);
    vi.spyOn(store, 'resolvedApps').mockReturnValue(
      appsOf(entry('99', 'jm-author-app', 'fp-a2'), reviewerApp),
    );
    await guidanceFor(store, config, twoAppZone, f.forgeOf, opts);
    expect(reads()).toBe(4);
    // The same entries again: a hit.
    await guidanceFor(store, config, twoAppZone, f.forgeOf, opts);
    expect(reads()).toBe(4);
  });

  test('an app read that GitHub answers 404 is kept as a token read is', async () => {
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [authorZone]);
    const f = fakeForge();
    let reads = 0;
    const forgeOf = (repo: string, token: string): GuidanceForge => ({
      ...f.forgeOf(repo, token),
      async repoAccess() {
        reads++;
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    const opts = { now: () => t0, appTokens: counting().source };
    const r1 = await guidanceFor(store, config, authorZone, forgeOf, opts);
    const r2 = await guidanceFor(store, config, authorZone, forgeOf, opts);
    expect(r1).toMatchObject({ ok: false, status: 502 });
    expect(r2).toEqual(r1);
    expect(reads).toBe(1);
    // A token read never falls back to the anonymous owner-type read.
    expect(f.calls).not.toContain('ownerType');
  });

  test('a PAT-only zone without an author PAT is still 409 NO_AUTHOR', async () => {
    const zone = zoneOf({});
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [zone]);
    const r = await guidanceFor(store, config, zone, fakeForge().forgeOf, {
      now: () => t0,
      appTokens: counting().source,
    });
    expect(r).toEqual({ ok: false, status: 409, error: expect.stringMatching(/author token/) });
  });

  test('a mint failure is a fixed 502 that quotes neither the token nor the error', async () => {
    for (const err of [
      new AppTokenError(`refused ${SENTINEL}`),
      new Error(`GitHub said {"message":"${SENTINEL}"}`),
    ]) {
      const { store, config } = storeWith(baseEnv, appsOf(authorApp), [authorZone]);
      const f = fakeForge();
      const r = await guidanceFor(store, config, authorZone, f.forgeOf, {
        now: () => t0,
        appTokens: fakeSource(() => Promise.reject(err)).source,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.status).toBe(502);
      expect(r.error).toContain('octo-org/demo');
      expect(r.error).toMatch(/author GitHub App/);
      expect(r.error).not.toContain(SENTINEL);
      expect(f.calls).toEqual([]);
    }
  });
});

describe('the callers', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function routeWorld(
    env: Record<string, string>,
    apps: ResolvedApps,
    zone: DropZoneConfig,
    appTokens?: Pick<AppTokenSource, 'provider'>,
  ) {
    const { store } = storeWith(env, apps, [zone]);
    const f = fakeForge();
    const logs: string[] = [];
    const a = createApp({
      db: openDb(tmpDbFile()),
      config: store,
      forgesFor: () => {
        throw new Error('no zone forge in this test');
      },
      now: () => t0,
      leaseWaitMs: 0,
      leasePollMs: 0,
      log: (m) => logs.push(m),
      guidanceForge: f.forgeOf,
      ...(appTokens ? { appTokens: { ...appTokens, fresh: vi.fn(), clear: vi.fn() } } : {}),
    });
    app = a;
    const get = (url: string) =>
      a.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}`, host: HOST },
      });
    return { store, f, logs, get };
  }

  test('the API route answers 200 for an app-author zone with no author PAT, and no token leaks', async () => {
    const s = counting();
    const w = routeWorld(baseEnv, appsOf(authorApp), authorZone, s.source);
    const r = await w.get('/api/control/zones/demo/github?reviewer=alice');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().ruleset.text).toContain('Lint');
    expect(r.json()).not.toHaveProperty('logins');
    expect(w.f.tokens).toContain(minted(1));
    expect(r.body).not.toContain(minted(1));
    expect(w.logs.join('\n')).not.toContain(minted(1));
  });

  test('the API route answers a mint failure 502 without the error text', async () => {
    const s = fakeSource(() => Promise.reject(new Error(`token ${SENTINEL}`)));
    const w = routeWorld(baseEnv, appsOf(authorApp), authorZone, s.source);
    const r = await w.get('/api/control/zones/demo/github');
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain(SENTINEL);
    expect(w.logs.join('\n')).not.toContain(SENTINEL);
  });

  test('a starter zone or a two-bot zone without an app entry reads on the PAT, byte for byte as without a token source', async () => {
    const elsewhere = { author: authorApp, reviewer: reviewerApp };
    const cases: [DropZoneConfig, ResolvedApps][] = [
      // A starter zone whose owner has both apps: PATs, always.
      [zoneOf({ identity: 'starter' }), new Map([['octo-org', elsewhere]])],
      // A two-bot zone whose owner has no entry, in an install that has another owner's.
      [
        zoneOf({ installations: { author: 11 } }),
        new Map([
          ['octo-org', { author: missing, reviewer: missing }],
          ['elsewhere', elsewhere],
        ]),
      ],
    ];
    for (const [zone, other] of cases) {
      const s = counting();
      const withSource = routeWorld(withPat, other, zone, s.source);
      const a = await withSource.get('/api/control/zones/demo/github?reviewer=alice');
      await app?.close();
      const without = routeWorld(withPat, other, zone);
      const b = await without.get('/api/control/zones/demo/github?reviewer=alice');
      expect(a.statusCode, a.body).toBe(200);
      expect(a.body).toBe(b.body);
      expect(withSource.f.tokens).toContain(AUTHOR);
      expect(s.asked).toEqual([]);
    }
  });

  test('the doctor guidance reader returns guidance for an app-author zone with no author PAT', async () => {
    const { store, config } = storeWith(baseEnv, appsOf(authorApp), [authorZone]);
    const f = fakeForge();
    const read = guidanceReader(store, config, f.forgeOf, () => t0, counting().source);
    const g = await read('demo');
    expect(g?.ruleset.text).toContain('Lint');
    // Without the source, as before: no author PAT, no guidance.
    expect(await guidanceReader(store, config, f.forgeOf, () => t0)('demo')).toBeUndefined();
  });
});

/** The fixture entries as the vault reads them: a key, a client secret and a token-like value. */
const fixtureRead = (role: 'author' | 'reviewer', appId?: string): AppEntryRead => ({
  source: 'vault',
  fingerprint: `fp-${role}`,
  entry: { ...APP_ENTRIES[role], ...(appId !== undefined ? { appId } : {}) },
});
const fixtureApps = (o: { reviewer?: boolean; authorId?: string } = {}): ResolvedApps =>
  new Map([
    [
      'octo-org',
      {
        author: fixtureRead('author', o.authorId),
        reviewer: o.reviewer === false ? missing : fixtureRead('reviewer'),
      },
    ],
  ]);
const INSTALL_AUTHOR = `install the author GitHub App ${APP_ENTRIES.author.slug} on octo-org/demo (no invitation needed)`;
const INSTALL_REVIEWER = `install the reviewer GitHub App ${APP_ENTRIES.reviewer.slug} on octo-org/demo (no invitation needed)`;

describe('guidanceFor, the zone apps reach the guidance (issue #482)', () => {
  const read = async (
    apps: ResolvedApps,
    zone: DropZoneConfig,
    o: { appTokens?: boolean; env?: Record<string, string> } = {},
  ) => {
    const { store, config } = storeWith(o.env ?? withPat, apps, [zone]);
    const r = await guidanceFor(store, config, zone, fakeForge().forgeOf, {
      now: () => t0,
      reviewers: ['alice'],
      ...(o.appTokens === false ? {} : { appTokens: counting().source }),
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  test('a two-app zone gets the merge ruleset, the app CODEOWNERS and the install checklist', async () => {
    const r = await read(fixtureApps(), twoAppZone);
    const g = r.guidance;
    expect(g.mergeRuleset?.text).toBe(mergeRulesetJson(Number(APP_ENTRIES.author.appId)));
    expect(g.codeowners.text).not.toMatch(/^\* @/m);
    expect(g.codeowners.text).toContain(APP_ENTRIES.reviewer.slug);
    expect(g.checklist.items).toEqual([INSTALL_AUTHOR, INSTALL_REVIEWER]);
    const json = JSON.stringify(r);
    for (const secret of Object.values(APP_SECRETS)) expect(json).not.toContain(secret);
  });

  test('the apps are read without a token source too: they need only the public id and slug', async () => {
    const r = await read(fixtureApps(), twoAppZone, { appTokens: false });
    expect(r.guidance.mergeRuleset?.text).toBe(mergeRulesetJson(Number(APP_ENTRIES.author.appId)));
  });

  test('a hybrid zone (app author, PAT reviewer) keeps the reviewer catch-all and a mixed checklist', async () => {
    const r = await read(fixtureApps({ reviewer: false }), authorZone);
    const g = r.guidance;
    expect(g.mergeRuleset).toBeUndefined();
    expect(g.codeowners.text).toMatch(/^\* @pat-reviewer$/m);
    expect(g.checklist.items).toEqual([
      INSTALL_AUTHOR,
      'invite pat-reviewer with the Write role',
      'accept the invitation as pat-reviewer',
    ]);
  });

  test('an app reviewer entry on a zone with no recorded reviewer installation is not a two-app zone', async () => {
    const r = await read(fixtureApps(), authorZone);
    expect(r.guidance.mergeRuleset).toBeUndefined();
    expect(r.guidance.checklist.items[0]).toBe(INSTALL_AUTHOR);
    expect(r.guidance.checklist.items).toHaveLength(3);
  });

  test('a PAT two-bot zone and a starter zone are unchanged by app entries they do not resolve to', async () => {
    const patZone = zoneOf({});
    const starter = zoneOf({ identity: 'starter', installations: { author: 11, reviewer: 12 } });
    const none: ResolvedApps = new Map();
    for (const zone of [patZone, starter]) {
      const without = await read(none, zone);
      const withEntries = await read(fixtureApps(), zone);
      expect(withEntries).toEqual(without);
      expect(withEntries.guidance.mergeRuleset).toBeUndefined();
    }
  });

  test("an author entry with appId '0' answers the guidance without a merge ruleset", async () => {
    const r = await read(fixtureApps({ authorId: '0' }), twoAppZone);
    expect(r.guidance.mergeRuleset).toBeUndefined();
    expect(r.guidance.codeowners.text).toBeTypeOf('string');
  });
});

describe('the two-app callers (issue #482)', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function twoAppWorld(apps: ResolvedApps) {
    const { store } = storeWith(withPat, apps, [twoAppZone]);
    const db = openDb(tmpDbFile());
    const a = createApp({
      db,
      config: store,
      forgesFor: () => {
        throw new Error('no zone forge in this test');
      },
      now: () => t0,
      leaseWaitMs: 0,
      leasePollMs: 0,
      log: () => undefined,
      guidanceForge: fakeForge().forgeOf,
      appTokens: { ...counting().source, fresh: vi.fn(), clear: vi.fn() },
    });
    app = a;
    await setOperatorPassphrase(db, 'a long operator passphrase', t0);
    const s = operatorSession(db);
    return {
      api: (url: string) =>
        a.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}`, host: HOST } }),
      page: (url: string) =>
        a.inject({ method: 'GET', url, headers: { host: HOST, cookie: s.cookie } }),
    };
  }

  test('the route JSON has the merge ruleset, the page renders it, ctl prints it; no secret leaks', async () => {
    const w = await twoAppWorld(fixtureApps());
    const r = await w.api('/api/control/zones/demo/github?reviewer=alice');
    expect(r.statusCode, r.body).toBe(200);
    const text = mergeRulesetJson(Number(APP_ENTRIES.author.appId));
    expect(r.json().mergeRuleset.text).toBe(text);
    const page = await w.page('/projects/demo/github');
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('<section id="merge-ruleset">');

    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = (async () => new Response(r.body, { status: 200 })) as typeof fetch;
    const code = await runCtl(
      ['github', 'demo', 'merge-ruleset'],
      { JM_OPERATOR_TOKEN: TOKEN },
      fetchImpl,
      (l) => out.push(l),
      (l) => err.push(l),
      async () => '',
    );
    expect(code, err.join('\n')).toBe(0);
    expect(out.join('\n')).toBe(text.trimEnd());

    for (const body of [r.body, page.body, [...out, ...err].join('\n')])
      for (const secret of Object.values(APP_SECRETS)) expect(body).not.toContain(secret);
  });

  test("an author appId of '0' does not answer 500: the guidance comes without a merge ruleset", async () => {
    const w = await twoAppWorld(fixtureApps({ authorId: '0' }));
    const r = await w.api('/api/control/zones/demo/github');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).not.toHaveProperty('mergeRuleset');
    const page = await w.page('/projects/demo/github');
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('<section id="merge-ruleset">');
  });
});
