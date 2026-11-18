import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import type { Principal } from '../auth/guard.js';
import { routeClass } from '../auth/guard.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { sha256Hex } from '../auth/sessions.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { createAppBrokers } from '../forge/app-brokers.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';

const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
const env = {
  JM_CLAUDE_TOKEN: 'claude-secret-value-1',
  JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};
const tokenPrincipal: Principal = { kind: 'operator', via: 'token', sudo: true };
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const PEM_BODY = PEM.split('\n').find((l) => l.length > 40) as string;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

const APP_IDS: Record<AppRole, string> = { author: '100', reviewer: '200' };
const SLUGS: Record<AppRole, string> = { author: 'acme-author', reviewer: 'acme-reviewer' };

const zone = (id: string, repo: string, extra: Record<string, unknown> = {}) => ({
  id,
  repo,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
  ...extra,
});

let app: FastifyInstance | undefined;
let server: Server | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** What the fake GitHub answers for one app (by app id) and repository (`owner/name`). */
type Answer = { status: number } | { installationId: number; repositoryId: number };

/** A fake GitHub on a local port: installations per app and repository; tokens it mints. */
async function fakeGitHub(answers: Record<string, Record<string, Answer>>) {
  const requests: { method: string; url: string }[] = [];
  const tokens: string[] = [];
  const tokenRepo = new Map<string, number>();
  let n = 0;
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    requests.push({ method, url });
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const appId = (() => {
      try {
        const claims = JSON.parse(
          Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString(),
        ) as { iss?: unknown };
        return String(claims.iss);
      } catch {
        return '';
      }
    })();
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const inst = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url);
      if (method === 'GET' && inst) {
        const a = answers[appId]?.[`${inst[1]}/${inst[2]}`];
        if (!a) return send(404, { message: 'Not Found' });
        if ('status' in a) return send(a.status, { message: `boom ${bearer}` });
        return send(200, { id: a.installationId, permissions: { metadata: 'read' } });
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
      if (method === 'POST' && mint) {
        const { repositories } = JSON.parse(body) as { repositories: string[] };
        const found = Object.entries(answers[appId] ?? {}).find(
          ([repo, a]) =>
            'installationId' in a &&
            a.installationId === Number(mint[1]) &&
            repo.endsWith(`/${repositories[0]}`),
        );
        if (!found) return send(404, { message: 'Not Found' });
        n += 1;
        const token = `ghs_${'m'.repeat(30)}${String(n).padStart(6, '0')}`;
        tokens.push(token);
        tokenRepo.set(token, (found[1] as { repositoryId: number }).repositoryId);
        return send(201, { token, expires_at: '2030-01-01T00:00:00Z' });
      }
      if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+$/.test(url)) {
        const id = tokenRepo.get(bearer);
        return id === undefined ? send(404, { message: 'Not Found' }) : send(200, { id });
      }
      if (method === 'DELETE' && url === '/installation/token') return send(204);
      send(404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { apiBase: `http://127.0.0.1:${port}`, requests, tokens };
}

const read = (role: AppRole): AppEntryRead => ({
  entry: {
    appId: APP_IDS[role],
    slug: SLUGS[role],
    clientId: `Iv23li${role}`,
    pem: PEM,
    importedAt: '2026-11-01T00:00:00.000Z',
  },
  source: 'vault',
  fingerprint: `fp-${role}`,
});

async function world(o: {
  zones: Record<string, unknown>[];
  /** The app roles `acme` has an entry for. */
  roles?: AppRole[];
  answers?: Record<string, Record<string, Answer>>;
}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-app-installed-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, join(dir, 'none.json')),
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const seeded = store.apply({ dropZones: o.zones }, { via: 'ctl', principal: tokenPrincipal });
  expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
  await setOperatorPassphrase(db, PASS, t0);
  const gh = await fakeGitHub(o.answers ?? {});
  const roles = o.roles ?? ['author'];
  const apps: ResolvedApps = new Map([
    [
      'acme',
      {
        author: roles.includes('author') ? read('author') : { source: 'missing' },
        reviewer: roles.includes('reviewer') ? read('reviewer') : { source: 'missing' },
      },
    ],
  ]);
  const secrets: string[] = [];
  const appBrokers = createAppBrokers({
    apps: () => apps,
    apiBase: gh.apiBase,
    onSecret: (s) => secrets.push(s),
  });
  const logs: string[] = [];
  const a = createApp({
    db,
    config: store,
    forgesFor: () => ({}) as never,
    now: () => t0,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    log: (m) => logs.push(m),
    appBrokers,
    resolvedApps: () => apps,
  });
  app = a;
  const s = operatorSession(db, t0);
  const bodies: string[] = [];
  const keep = <R extends { body: string }>(r: R) => {
    bodies.push(r.body);
    return r;
  };
  const installed = async (query = '') =>
    keep(
      await a.inject({
        method: 'GET',
        url: `/setup/github-app/installed${query}`,
        headers: { host: HOST },
      }),
    );
  const discover = async (headers: Record<string, string> = { cookie: s.cookie }) =>
    keep(
      await a.inject({
        method: 'POST',
        url: '/setup/github-app/discover',
        headers: {
          host: HOST,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          ...headers,
        },
        payload: '',
      }),
    );
  const pendingIdOf = (html: string): string | undefined =>
    /href="\/config\/confirm\/([^"]+)"/.exec(html)?.[1];
  const confirm = async (id: string) => {
    const page = keep(
      await a.inject({
        method: 'GET',
        url: `/config/confirm/${id}`,
        headers: { host: HOST, cookie: s.cookie },
      }),
    );
    expect(page.statusCode, page.body).toBe(200);
    const token = /name="token" value="([\w-]+)"/.exec(page.body)?.[1] as string;
    return keep(
      await a.inject({
        method: 'POST',
        url: `/config/confirm/${id}`,
        headers: {
          host: HOST,
          origin: ORIGIN,
          cookie: s.cookie,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: new URLSearchParams({ token, passphrase: PASS }).toString(),
      }),
    );
  };
  const zoneOf = (id: string) => store.current().dropZones.find((z) => z.id === id);
  const pendingDoc = (id: string) =>
    store.confirmations.pending(id, sha256Hex(s.id))?.patch as
      | { dropZones: Record<string, unknown>[] }
      | undefined;
  return {
    db,
    store,
    gh,
    logs,
    secrets,
    bodies,
    session: s,
    installed,
    discover,
    pendingIdOf,
    confirm,
    zoneOf,
    pendingDoc,
  };
}

describe('routeClass', () => {
  test('the installed page needs no session; discovery is a page', () => {
    expect(routeClass('/setup/github-app/installed')).toBe('auth');
    expect(routeClass('/setup/github-app/discover')).toBe('page');
  });
});

describe('GET /setup/github-app/installed', () => {
  test('with no cookie: 200, the Find form, no-store, and never the installation_id', async () => {
    const w = await world({ zones: [zone('main', 'acme/demo')] });
    const r = await w.installed('?installation_id=999&setup_action=install');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatch(/<form method="post" action="\/setup\/github-app\/discover">/);
    expect(r.body).toContain('Find the installations');
    // The value is not echoed: the page is the same with or without the query. (The shared
    // stylesheet's skip link sits at `left:-999px`, so the text outside it is what is checked.)
    expect(r.body).toBe((await w.installed()).body);
    expect(r.body.replace(/<style>[\s\S]*?<\/style>/g, '')).not.toContain('999');
    expect(w.gh.requests).toEqual([]);
  });
});

describe('POST /setup/github-app/discover', () => {
  test('proposes the ids GitHub returned as one pending guarded change, applied once confirmed', async () => {
    const w = await world({
      zones: [zone('main', 'acme/demo')],
      answers: { [APP_IDS.author]: { 'acme/demo': { installationId: 11, repositoryId: 22 } } },
    });
    // The id GitHub sent along is never used.
    expect((await w.installed('?installation_id=999')).statusCode).toBe(200);
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('installed');
    const id = w.pendingIdOf(r.body);
    expect(id).toBeDefined();
    expect(r.body).toContain('Review and confirm');
    // Nothing is written before the confirmation.
    expect(w.zoneOf('main')?.githubApp).toBeUndefined();
    const c = await w.confirm(id as string);
    expect(c.statusCode, c.body).toBe(303);
    expect(c.headers.location).toBe('/setup/github-app/installed');
    expect(w.zoneOf('main')?.githubApp).toEqual({
      repositoryId: 22,
      installations: { author: 11 },
    });
    expect(JSON.stringify(w.store.document())).not.toContain('999');
  });

  test('an app not installed on the repository: its install link, and no pending change', async () => {
    const w = await world({ zones: [zone('main', 'acme/demo')] });
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('not installed on acme/demo');
    expect(r.body).toContain('https://github.com/apps/acme-author/installations/new');
    expect(w.pendingIdOf(r.body)).toBeUndefined();
    expect(r.body).toContain('no app yet'); // the reviewer
  });

  test('starter zones and zones whose owner has no app entry are not in the change', async () => {
    const w = await world({
      zones: [
        zone('main', 'acme/demo'),
        zone('solo', 'acme/solo', { identity: 'starter', ciRequired: true }),
        zone('other', 'globex/web'),
      ],
      answers: {
        [APP_IDS.author]: {
          'acme/demo': { installationId: 11, repositoryId: 22 },
          'acme/solo': { installationId: 11, repositoryId: 33 },
        },
      },
    });
    const r = await w.discover();
    const id = w.pendingIdOf(r.body) as string;
    expect(id).toBeDefined();
    const doc = w.pendingDoc(id);
    const byId = Object.fromEntries((doc?.dropZones ?? []).map((z) => [z.id, z]));
    expect(byId.main?.githubApp).toEqual({ repositoryId: 22, installations: { author: 11 } });
    expect(byId.solo?.githubApp).toBeUndefined();
    expect(byId.other?.githubApp).toBeUndefined();
    expect(w.gh.requests.some((q) => q.url.includes('solo') || q.url.includes('globex'))).toBe(
      false,
    );
  });

  test('ids already recorded and equal: up to date, and no pending change', async () => {
    const w = await world({
      zones: [
        zone('main', 'acme/demo', {
          githubApp: { repositoryId: 22, installations: { author: 11 } },
        }),
      ],
      answers: { [APP_IDS.author]: { 'acme/demo': { installationId: 11, repositoryId: 22 } } },
    });
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('up to date');
    expect(w.pendingIdOf(r.body)).toBeUndefined();
  });

  test('different repository ids between the roles refuse that zone alone, naming it', async () => {
    const w = await world({
      roles: ['author', 'reviewer'],
      zones: [zone('alpha', 'acme/alpha'), zone('beta', 'acme/beta')],
      answers: {
        [APP_IDS.author]: {
          'acme/alpha': { installationId: 11, repositoryId: 22 },
          'acme/beta': { installationId: 11, repositoryId: 44 },
        },
        [APP_IDS.reviewer]: {
          'acme/alpha': { installationId: 12, repositoryId: 23 },
          'acme/beta': { installationId: 12, repositoryId: 44 },
        },
      },
    });
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toMatch(/alpha[\s\S]*refused/);
    const doc = w.pendingDoc(w.pendingIdOf(r.body) as string);
    const byId = Object.fromEntries((doc?.dropZones ?? []).map((z) => [z.id, z]));
    expect(byId.alpha?.githubApp).toBeUndefined();
    expect(byId.beta?.githubApp).toEqual({
      repositoryId: 44,
      installations: { author: 11, reviewer: 12 },
    });
  });

  test('a recorded repository id that differs from GitHub refuses that zone and leaves it unchanged', async () => {
    const recorded = { repositoryId: 21, installations: { author: 11 } };
    const w = await world({
      zones: [zone('main', 'acme/demo', { githubApp: recorded })],
      answers: { [APP_IDS.author]: { 'acme/demo': { installationId: 11, repositoryId: 22 } } },
    });
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('refused');
    expect(r.body).toContain('main');
    expect(w.pendingIdOf(r.body)).toBeUndefined();
    expect(w.zoneOf('main')?.githubApp).toEqual(recorded);
  });

  test('a GitHub 500 for one zone is shown for it, and the other zones proceed', async () => {
    const w = await world({
      zones: [zone('alpha', 'acme/alpha'), zone('beta', 'acme/beta')],
      answers: {
        [APP_IDS.author]: {
          'acme/alpha': { status: 500 },
          'acme/beta': { installationId: 11, repositoryId: 44 },
        },
      },
    });
    const r = await w.discover();
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('HTTP 500');
    const doc = w.pendingDoc(w.pendingIdOf(r.body) as string);
    const byId = Object.fromEntries((doc?.dropZones ?? []).map((z) => [z.id, z]));
    expect(byId.alpha?.githubApp).toBeUndefined();
    expect(byId.beta?.githubApp).toEqual({ repositoryId: 44, installations: { author: 11 } });
  });

  test('without a session: 401 and no GitHub request; a foreign Origin: 403', async () => {
    const w = await world({
      zones: [zone('main', 'acme/demo')],
      answers: { [APP_IDS.author]: { 'acme/demo': { installationId: 11, repositoryId: 22 } } },
    });
    const anon = await w.discover({});
    expect(anon.statusCode).toBe(401);
    const foreign = await w.discover({ cookie: w.session.cookie, origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(w.gh.requests).toEqual([]);
  });

  test('no token, JWT or PEM in the log or any response body', async () => {
    const w = await world({
      roles: ['author', 'reviewer'],
      zones: [zone('alpha', 'acme/alpha'), zone('beta', 'acme/beta')],
      answers: {
        [APP_IDS.author]: {
          'acme/alpha': { status: 500 },
          'acme/beta': { installationId: 11, repositoryId: 44 },
        },
        [APP_IDS.reviewer]: { 'acme/beta': { installationId: 12, repositoryId: 44 } },
      },
    });
    const r = await w.discover();
    await w.confirm(w.pendingIdOf(r.body) as string);
    expect(w.gh.tokens.length).toBeGreaterThan(0);
    for (const text of [...w.logs, ...w.bodies]) {
      for (const t of w.gh.tokens) expect(text).not.toContain(t);
      for (const s of w.secrets) expect(text).not.toContain(s);
      expect(text).not.toMatch(JWT);
      expect(text).not.toContain(PEM_BODY);
      expect(text).not.toContain('PRIVATE KEY');
    }
  });
});
