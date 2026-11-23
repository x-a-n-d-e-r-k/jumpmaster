import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Config, DropZoneConfig } from '../config.js';
import { one, world } from '../test/doctorWorld.js';
import { makeZone } from '../test/fixtures.js';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { createAppTokenSource } from './app-tokens.js';
import { GitHubForge } from './github.js';
import { makeReadForgeFor, type ReadForgeConfig } from './read-forge.js';
import { ScrubSet } from './scrub-set.js';

const api = 'https://api.github.com';
const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
// Built at runtime so no token-shaped literal sits in the tracked file.
const MINTED = ['ghs', 'READFORGE'.repeat(5)].join('_');
const READ_TOKEN = ['github', 'pat', 'READREADREADREADREAD1234'].join('_');

/** Every request nock answered or refused, as `METHOD path`. */
const seen: string[] = [];
const onRequest = (req: { method?: string; path?: string }) =>
  seen.push(`${req.method} ${req.path}`);

beforeAll(() => {
  nock.disableNetConnect();
  nock.emitter.on('no match', onRequest);
});
beforeEach(() => {
  seen.length = 0;
});
afterEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  nock.emitter.removeListener('no match', onRequest);
  nock.enableNetConnect();
});

const appZone = (o: Partial<DropZoneConfig> = {}) =>
  makeZone({
    repo: 'octo/demo',
    githubApp: { repositoryId: 4242, installations: { reviewer: 77 } },
    ...o,
  });

const reviewerApp = (): ResolvedApps =>
  new Map<string, Record<AppRole, AppEntryRead>>([
    [
      'octo',
      {
        author: { source: 'missing' },
        reviewer: {
          entry: {
            appId: '200',
            slug: 'rev',
            clientId: 'Iv1.200',
            pem: KEY,
            importedAt: '2026-11-01T00:00:00Z',
          },
          source: 'file',
          fingerprint: 'fp',
        },
      },
    ],
  ]);

function live(o: { zone?: DropZoneConfig; readToken?: boolean; apps?: ResolvedApps }) {
  const config: ReadForgeConfig = {
    dropZones: [o.zone ?? appZone()],
    secrets: (o.readToken ? { githubReadToken: READ_TOKEN } : {}) as Config['secrets'],
  };
  const apps = o.apps ?? new Map();
  return { current: () => config, resolvedApps: () => apps };
}

function source(l: ReturnType<typeof live>) {
  return createAppTokenSource({
    resolvedApps: l.resolvedApps,
    zones: () => l.current().dropZones,
    add: (s) => new ScrubSet().add(s),
  });
}

/**
 * Records the GitHub App endpoints, answering a matching installation, the repository id check
 * (issue #267: a metadata probe, the repository read and its revoke) and one mint.
 */
function appEndpoints() {
  return nock(api)
    .get('/repos/octo/demo/installation')
    .reply(200, () => {
      seen.push('GET /repos/octo/demo/installation');
      return { id: 77, permissions: {} };
    })
    .post('/app/installations/77/access_tokens', (b: { repositories?: string[] }) =>
      Boolean(b.repositories),
    )
    .reply(201, { token: 'probe-token', expires_at: '2099-01-01T00:00:00Z' })
    .get('/repos/octo/demo')
    .reply(200, { id: 4242 })
    .delete('/installation/token')
    .reply(204)
    .post('/app/installations/77/access_tokens')
    .reply(201, () => {
      seen.push('POST /app/installations/77/access_tokens');
      return { token: MINTED, expires_at: '2099-01-01T00:00:00Z' };
    });
}

const contents = (token: string) =>
  nock(api, { reqheaders: { authorization: `token ${token}` } })
    .get('/repos/octo/demo/contents')
    .query(true)
    .reply(200, [{ name: 'package.json' }]);

const appCalls = () => seen.filter((s) => /\/installation|access_tokens|^\w+ \/app\b/.test(s));

describe('makeReadForgeFor', () => {
  test('with the reviewer app and no read token, the forge sends the minted drop-read token', async () => {
    const l = live({ apps: reviewerApp() });
    const scope = appEndpoints();
    const read = contents(MINTED);
    const forge = makeReadForgeFor(l, source(l))('main');
    expect(forge).toBeInstanceOf(GitHubForge);
    expect(await forge!.listDir('main', '')).toEqual(['package.json']);
    expect(scope.isDone()).toBe(true);
    expect(read.isDone()).toBe(true);
  });

  test('app-first: with the reviewer app and the read token both set, the forge sends the minted token', async () => {
    const l = live({ apps: reviewerApp(), readToken: true });
    const scope = appEndpoints();
    const read = contents(MINTED);
    const forge = makeReadForgeFor(l, source(l))('main');
    expect(await forge!.listDir('main', '')).toEqual(['package.json']);
    expect(read.isDone()).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  test('a PAT zone with the read token set reads with it, even when its owner has a reviewer app entry but no recorded installation', async () => {
    const l = live({
      apps: reviewerApp(),
      readToken: true,
      zone: appZone({ githubApp: { repositoryId: 4242, installations: { author: 11 } } }),
    });
    const read = contents(READ_TOKEN);
    const forge = makeReadForgeFor(l, source(l))('main');
    expect(await forge!.listDir('main', '')).toEqual(['package.json']);
    expect(read.isDone()).toBe(true);
    expect(appCalls()).toEqual([]);
  });

  test('with no app entries it is the read-token forge as before; with neither it is undefined', async () => {
    const pat = live({ zone: makeZone({ repo: 'octo/demo' }), readToken: true });
    const read = contents(READ_TOKEN);
    const forge = makeReadForgeFor(pat, source(pat))('main');
    expect(forge).toBeInstanceOf(GitHubForge);
    expect(await forge!.listDir('main', '')).toEqual(['package.json']);
    expect(read.isDone()).toBe(true);
    // Without a source at all, too.
    expect(makeReadForgeFor(pat)('main')).toBeInstanceOf(GitHubForge);

    const neither = live({ zone: makeZone({ repo: 'octo/demo' }) });
    expect(makeReadForgeFor(neither, source(neither))('main')).toBeUndefined();
    expect(makeReadForgeFor(pat, source(pat))('elsewhere')).toBeUndefined();
    expect(appCalls()).toEqual([]);
  });

  test('no forge from the app unless the reviewer resolves to it cleanly and an installation is recorded', () => {
    const noInstall = live({
      apps: reviewerApp(),
      zone: appZone({ githubApp: { repositoryId: 4242, installations: { author: 11 } } }),
    });
    expect(makeReadForgeFor(noInstall, source(noInstall))('main')).toBeUndefined();
    const undecryptable = live({
      apps: new Map([
        [
          'octo',
          { author: { source: 'missing' }, reviewer: { source: 'missing', undecryptable: true } },
        ],
      ]) as ResolvedApps,
    });
    expect(makeReadForgeFor(undecryptable, source(undecryptable))('main')).toBeUndefined();
    const starter = live({
      apps: reviewerApp(),
      zone: makeZone({ repo: 'octo/demo', identity: 'starter' }),
    });
    expect(makeReadForgeFor(starter, source(starter))('main')).toBeUndefined();
    const noSource = live({ apps: reviewerApp() });
    expect(makeReadForgeFor(noSource)('main')).toBeUndefined();
    expect(appCalls()).toEqual([]);
  });
});

describe('the doctor with makeReadForgeFor', () => {
  test('forge.private-clone with the reviewer app and no read token passes through the app token', async () => {
    const w = world({
      zone: { githubApp: { repositoryId: 4242, installations: { reviewer: 77 } } },
    });
    w.f.state.access.author.private = true;
    const l = live({ zone: w.zone, apps: reviewerApp() });
    w.deps.readForge = makeReadForgeFor(l, source(l));
    w.deps.resolvedApps = l.resolvedApps;
    const scope = appEndpoints();
    const read = contents(MINTED);
    const got = one(await w.run(), 'forge.private-clone');
    expect(got.status).toBe('pass');
    expect(got.summary).toContain('rev');
    expect(scope.isDone()).toBe(true);
    expect(read.isDone()).toBe(true);
  });

  test('forge.private-clone fails naming the reviewer app when the app is not installed on the repository', async () => {
    const w = world({
      zone: { githubApp: { repositoryId: 4242, installations: { reviewer: 77 } } },
    });
    w.f.state.access.author.private = true;
    const l = live({ zone: w.zone, apps: reviewerApp() });
    w.deps.readForge = makeReadForgeFor(l, source(l));
    w.deps.resolvedApps = l.resolvedApps;
    nock(api).get('/repos/octo/demo/installation').reply(404, { message: 'Not Found' });
    const got = one(await w.run(), 'forge.private-clone');
    expect(got.status).toBe('fail');
    expect(got.summary).toContain('reviewer GitHub App (rev)');
    expect(got.fix).toContain('Install the reviewer GitHub App (rev)');
  });

  test('a PAT install passes forge.private-clone through the read token and calls no app endpoint', async () => {
    const w = world({ readToken: true, zone: { reviewReadToken: true } });
    w.f.state.access.author.private = true;
    const l = {
      current: () => ({ dropZones: [w.zone], secrets: w.config.secrets }),
      resolvedApps: (): ResolvedApps => new Map(),
    };
    w.deps.readForge = makeReadForgeFor(l, source(l));
    nock(api)
      .get('/repos/octo/demo/contents')
      .query(true)
      .reply(200, [{ name: 'package.json' }]);
    expect(one(await w.run(), 'forge.private-clone')).toMatchObject({ status: 'pass' });
    expect(appCalls()).toEqual([]);
  });
});

describe('a GitLab zone (issue #667)', () => {
  test('gets no read forge, even with the read token set, and nothing is sent', () => {
    const gitlab = makeZone({
      repo: 'acme/app',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    });
    const l = live({ zone: gitlab, readToken: true, apps: reviewerApp() });
    expect(makeReadForgeFor(l, source(l))('main')).toBeUndefined();
    expect(makeReadForgeFor(l)('main')).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("a GitHub zone's read forge is unchanged, forge absent or github", () => {
    for (const zone of [
      makeZone({ repo: 'octo/demo' }),
      makeZone({ repo: 'octo/demo', forge: 'github' }),
    ]) {
      const l = live({ zone, readToken: true });
      expect(makeReadForgeFor(l)('main')).toBeInstanceOf(GitHubForge);
    }
  });
});
