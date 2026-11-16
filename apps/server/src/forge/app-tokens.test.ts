import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AppEntryRead, AppRole, GitHubAppEntry } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { type AppTokenZone, createAppTokenSource } from './app-tokens.js';
import { USE_PERMISSIONS } from './github-app.js';
import { ScrubSet } from './scrub-set.js';

const api = 'https://api.github.com';
const T0 = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;

const pem = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
const KEY_A = pem();
const KEY_B = pem();

// Built at runtime so no token-shaped literal sits in the tracked file.
const tokenOf = (n: number) => ['ghs', `MINTED${String(n).padStart(4, '0')}`.repeat(4)].join('_');

/** Every request the fake GitHub saw. */
interface Call {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

/** A recording fake GitHub: the installation lookup answers `installed`, each mint a new token. */
function fakeGitHub() {
  const calls: Call[] = [];
  const minted: string[] = [];
  const jwts: string[] = [];
  const state = { installed: { status: 200, id: 77 } as { status: number; id?: number } };
  const record = async (req: Request): Promise<Call> => {
    const text = await req.text();
    const authorization = req.headers.get('authorization') ?? '';
    const call: Call = {
      method: req.method,
      path: new URL(req.url).pathname,
      authorization,
      body: text ? JSON.parse(text) : undefined,
    };
    if (authorization.startsWith('Bearer eyJ')) jwts.push(authorization.slice('Bearer '.length));
    calls.push(call);
    return call;
  };
  nock(api)
    .persist()
    .get(/^\/repos\/[^/]+\/[^/]+\/installation$/)
    .reply(async (req: Request) => {
      await record(req);
      const { status, id } = state.installed;
      return status === 200
        ? [200, { id, permissions: { contents: 'read', pull_requests: 'write' } }]
        : [status, { message: 'Not Found' }];
    })
    .post(/^\/app\/installations\/\d+\/access_tokens$/)
    .reply(async (req: Request) => {
      await record(req);
      const token = tokenOf(minted.length + 1);
      minted.push(token);
      return [201, { token, expires_at: new Date(clock + HOUR).toISOString() }];
    });
  return {
    calls,
    minted,
    jwts,
    state,
    mints: () => calls.filter((c) => c.path.endsWith('/access_tokens')),
    lookups: () => calls.filter((c) => c.path.endsWith('/installation')),
  };
}

let clock = T0;
let gh: ReturnType<typeof fakeGitHub>;
const captured: string[] = [];
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeAll(() => {
  nock.disableNetConnect();
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
    consoleSpies.push(
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
      }),
    );
});
beforeEach(() => {
  clock = T0;
  gh = fakeGitHub();
});
afterEach(() => {
  nock.cleanAll();
});
afterAll(() => {
  for (const s of consoleSpies) s.mockRestore();
  nock.enableNetConnect();
});

const entry = (appId: string, key: string): GitHubAppEntry => ({
  appId,
  slug: `app-${appId}`,
  clientId: `Iv1.${appId}`,
  pem: key,
  importedAt: '2026-11-01T00:00:00Z',
});
const present = (appId: string, key: string, fingerprint: string) => ({
  entry: entry(appId, key),
  source: 'file' as const,
  fingerprint,
});

const ZONE: AppTokenZone = {
  id: 'main',
  repo: 'Octo/demo',
  identity: 'two-bot',
  githubApp: { repositoryId: 4242, installations: { author: 11, reviewer: 77 } },
};

/** A world: one zone, both apps on its owner, and a source over a fresh scrub set. */
function world(o: { zone?: AppTokenZone; reviewer?: AppEntryRead } = {}) {
  const zones: AppTokenZone[] = [o.zone ?? ZONE];
  const apps = new Map<string, Record<AppRole, AppEntryRead>>([
    [
      'octo',
      {
        author: present('100', KEY_A, 'fp-author'),
        reviewer: o.reviewer ?? present('200', KEY_A, 'fp-1'),
      },
    ],
  ]);
  const scrub = new ScrubSet();
  const source = createAppTokenSource({
    resolvedApps: (): ResolvedApps => apps,
    zones: () => zones,
    now: () => clock,
    add: (s) => scrub.add(s),
  });
  return { zones, apps, scrub, source };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error('expected a rejection');
}

/** Every error message and cause in the chain, serialized. */
function serialized(e: unknown): string {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; cur !== undefined && i < 10; i++) {
    const err = cur as Error;
    out.push(
      String(err),
      err?.message ?? '',
      err?.stack ?? '',
      JSON.stringify(err),
      JSON.stringify(Object.getOwnPropertyNames(err ?? {}).map((k) => [k, (err as never)[k]])),
    );
    cur = err?.cause;
  }
  return out.join('\n');
}

const pemLines = (key: string) =>
  key.split('\n').filter((l) => l && !l.startsWith('-----') && l.length >= 40);

describe('createAppTokenSource', () => {
  test('checks the installation once, mints once narrowed to the repository and use, then serves from the cache', async () => {
    const w = world();
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    expect(gh.calls).toEqual([]);
    const t1 = await p.token();
    expect(t1).toBe(gh.minted[0]);
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /repos/Octo/demo/installation',
      'POST /app/installations/77/access_tokens',
    ]);
    expect(gh.mints()[0]!.body).toEqual({
      repository_ids: [4242],
      permissions: { contents: 'read' },
    });
    clock += 30 * 60 * 1000;
    expect(await p.token()).toBe(t1);
    // A second provider for the same zone, role and use shares the cache.
    expect(await w.source.provider('main', 'reviewer', 'drop-read-reviewer').token()).toBe(t1);
    expect(gh.calls).toHaveLength(2);
  });

  test('a mismatched installation id rejects, naming the repository and role, and mints nothing', async () => {
    const w = world();
    gh.state.installed = { status: 200, id: 999 };
    const e = await rejection(w.source.provider('main', 'reviewer', 'drop-read-reviewer').token());
    expect(e.message).toContain('Octo/demo');
    expect(e.message).toContain('reviewer');
    expect(gh.lookups()).toHaveLength(1);
    expect(gh.mints()).toEqual([]);
  });

  test('a 404 from the installation lookup rejects and mints nothing; a later call checks again', async () => {
    const w = world();
    gh.state.installed = { status: 404 };
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    const e = await rejection(p.token());
    expect(e.message).toContain('Octo/demo');
    expect(e.message).toContain('not installed');
    expect(gh.mints()).toEqual([]);
    // A failed check is not remembered.
    gh.state.installed = { status: 200, id: 77 };
    expect(await p.token()).toBe(gh.minted[0]);
    expect(gh.lookups()).toHaveLength(2);
  });

  test('no recorded installation, an undecryptable entry and a starter zone each reject with no PAT and no GitHub call', async () => {
    const PAT = 'github_pat_' + 'SHOULDNEVERBEUSEDSHOULDNEVER';
    const cases = [
      world({
        zone: { ...ZONE, githubApp: { repositoryId: 4242, installations: { author: 11 } } },
      }),
      world({ zone: { id: 'main', repo: 'Octo/demo', identity: 'two-bot' } }),
      world({ reviewer: { source: 'missing', undecryptable: true } }),
      world({ zone: { id: 'main', repo: 'Octo/demo', identity: 'starter' } }),
    ];
    const messages: string[] = [];
    for (const w of cases) {
      const e = await rejection(
        w.source.provider('main', 'reviewer', 'drop-read-reviewer').token(),
      );
      expect(e.message).toContain('Octo/demo');
      expect(e.message).not.toContain(PAT);
      messages.push(e.message);
    }
    expect(messages[0]).toContain('records no reviewer app installation');
    expect(messages[1]).toContain('records no reviewer app installation');
    expect(messages[2]).toContain("can't be decrypted");
    expect(messages[3]).toContain('starter');
    expect(gh.calls).toEqual([]);
  });

  test('server-reviewer and drop-read-reviewer tokens for one owner and role are minted and cached apart', async () => {
    const w = world();
    const read = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    const server = w.source.provider('main', 'reviewer', 'server-reviewer');
    const r = await read.token();
    const s = await server.token();
    expect(r).not.toBe(s);
    expect(gh.mints().map((c) => (c.body as { permissions: unknown }).permissions)).toEqual([
      USE_PERMISSIONS['drop-read-reviewer'],
      USE_PERMISSIONS['server-reviewer'],
    ]);
    expect(await read.token()).toBe(r);
    expect(await server.token()).toBe(s);
    // One installation check covers both uses.
    expect(gh.lookups()).toHaveLength(1);
    expect(gh.mints()).toHaveLength(2);
  });

  test('a use the role does not mint is refused', async () => {
    const w = world();
    const e = await rejection(w.source.provider('main', 'reviewer', 'push').token());
    expect(e.message).toContain('reviewer');
    expect(gh.calls).toEqual([]);
  });

  test('a changed fingerprint rebuilds the broker, checks and mints again, and never returns the old token', async () => {
    const w = world();
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    const before = await p.token();
    const firstJwt = gh.calls[0]!.authorization;
    w.apps.set('octo', {
      author: present('100', KEY_A, 'fp-author'),
      reviewer: present('200', KEY_B, 'fp-2'),
    });
    const after = await p.token();
    expect(after).not.toBe(before);
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints()).toHaveLength(2);
    // Signed with the new key: a different JWT.
    expect(gh.lookups()[1]!.authorization).not.toBe(firstJwt);
    expect(await p.token()).toBe(after);
  });

  test('a changed recorded installation id checks and mints again, and never returns the old token', async () => {
    const w = world();
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    const server = w.source.provider('main', 'reviewer', 'server-reviewer');
    const before = await p.token();
    const serverBefore = await server.token();
    gh.state.installed = { status: 200, id: 78 };
    w.zones[0] = { ...ZONE, githubApp: { repositoryId: 4242, installations: { reviewer: 78 } } };
    const after = await p.token();
    expect(after).not.toBe(before);
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints().at(-1)!.path).toBe('/app/installations/78/access_tokens');
    // The other use's token from before the change is dropped too.
    expect(await server.token()).not.toBe(serverBefore);
  });

  test('a changed id that no longer matches GitHub rejects, and the token from before is not returned', async () => {
    const w = world();
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    await p.token();
    w.zones[0] = { ...ZONE, githubApp: { repositoryId: 4242, installations: { reviewer: 78 } } };
    await rejection(p.token());
    expect(gh.mints()).toHaveLength(1);
  });

  test('every token, JWT and the PEM go to the scrub set; no error, cause or log line carries one', async () => {
    const w = world();
    const p = w.source.provider('main', 'reviewer', 'drop-read-reviewer');
    await p.token();
    await w.source.provider('main', 'reviewer', 'server-reviewer').token();
    const errors: unknown[] = [];
    // A failing lookup, a mismatch and a failing mint, each through the same source.
    gh.state.installed = { status: 200, id: 999 };
    w.zones[0] = { ...ZONE, githubApp: { repositoryId: 4242, installations: { reviewer: 79 } } };
    errors.push(await rejection(p.token()));
    gh.state.installed = { status: 404 };
    errors.push(await rejection(p.token()));
    nock.cleanAll();
    nock(api)
      .get(/installation$/)
      .reply(200, { id: 79, permissions: {} })
      .post(/access_tokens$/)
      .reply(401, { message: `Bad credentials ${gh.minted[0]}` });
    errors.push(await rejection(p.token()));

    const values = w.scrub.values();
    const secrets = [...gh.minted, ...gh.jwts, KEY_A, ...pemLines(KEY_A)];
    expect(gh.minted).toHaveLength(2);
    expect(gh.jwts.length).toBeGreaterThanOrEqual(4);
    for (const s of [...gh.minted, ...gh.jwts, KEY_A]) expect(values).toContain(s);
    const text = [...errors.map(serialized), ...captured].join('\n');
    for (const s of secrets) expect(text.includes(s)).toBe(false);
  });
});
