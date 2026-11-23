/**
 * `verifiedInstallation` (issue #267): a zone's recorded installation id and repository id are
 * checked against `zone.repo` on GitHub before anything mints for it. Each refusal is asserted
 * against the fake's mint log: the zone's mint (`repository_ids`) is never sent.
 */
import { generateKeyPairSync } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { AppEntryRead, AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import { createGitHubAppBroker, type GitHubAppBroker } from './github-app.js';
import {
  appRefusal,
  createInstallationVerifier,
  InstallationCheckError,
  type VerifiableZone,
} from './installation-verifier.js';

const api = 'https://api.github.com';
const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
// Built at runtime so no token-shaped literal sits in the tracked file.
const tokenOf = (n: number) => ['ghs', `VERIFY${String(n).padStart(4, '0')}`.repeat(4)].join('_');

type Answer = number | 'missing' | 'timeout' | 500;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GitHub of one app on `acme`: which installation covers each repository, and its id. */
function fakeGitHub() {
  const calls: Call[] = [];
  let n = 0;
  const state = {
    installation: { 'acme/widgets': 7, 'acme/gadgets': 7 } as Record<string, Answer>,
    ids: { 'acme/widgets': 42, 'acme/gadgets': 99 } as Record<string, number>,
  };
  const record = async (req: Request) => {
    const text = await req.text();
    calls.push({
      method: req.method,
      path: new URL(req.url).pathname,
      body: text ? JSON.parse(text) : undefined,
    });
  };
  /** The probe tokens minted, by the repository they were narrowed to. */
  const probes = new Map<string, string>();
  nock(api)
    .persist()
    .get(/^\/repos\/[^/]+\/[^/]+\/installation$/)
    .reply(async (req: Request) => {
      await record(req);
      const [, , o, r] = new URL(req.url).pathname.split('/');
      const a = state.installation[`${o}/${r}`] ?? 'missing';
      if (a === 'timeout') throw new Error('ETIMEDOUT');
      if (a === 'missing') return [404, { message: 'Not Found' }];
      if (a === 500) return [500, { message: 'boom' }];
      return [200, { id: a, permissions: { contents: 'write' } }];
    })
    .post(/^\/app\/installations\/\d+\/access_tokens$/)
    .reply(async (req: Request) => {
      await record(req);
      const body = calls.at(-1)!.body as { repositories?: string[] };
      const token = tokenOf(++n);
      if (body.repositories) probes.set(token, `acme/${body.repositories[0]}`);
      return [201, { token, expires_at: '2026-11-17T13:00:00Z' }];
    })
    .get(/^\/repos\/[^/]+\/[^/]+$/)
    .reply(async (req: Request) => {
      await record(req);
      const auth = req.headers.get('authorization')?.slice('Bearer '.length) ?? '';
      const repo = new URL(req.url).pathname.slice('/repos/'.length);
      // A probe token reaches only the repository it was narrowed to.
      if (probes.get(auth) !== repo) return [404, { message: 'Not Found' }];
      return [200, { id: state.ids[repo], full_name: repo }];
    })
    .delete('/installation/token')
    .reply(async (req: Request) => {
      await record(req);
      return [204, ''];
    });
  return {
    calls,
    state,
    /** The zone mints: narrowed by repository id (the probe is narrowed by name). */
    mints: () =>
      calls.filter(
        (c) => c.path.endsWith('/access_tokens') && 'repository_ids' in (c.body as object),
      ),
    lookups: () => calls.filter((c) => c.path.endsWith('/installation')),
    idReads: () => calls.filter((c) => c.method === 'GET' && !c.path.endsWith('/installation')),
  };
}

const present = (fingerprint: string): AppEntryRead => ({
  source: 'vault',
  fingerprint,
  entry: { appId: '100', slug: 'jm', clientId: 'c', pem: KEY, importedAt: '2026-11-01' },
});

const ZONE: VerifiableZone = {
  id: 'zone-a',
  repo: 'acme/widgets',
  identity: 'two-bot',
  githubApp: { repositoryId: 42, installations: { author: 7, reviewer: 7 } },
};

let gh: ReturnType<typeof fakeGitHub>;

beforeAll(() => nock.disableNetConnect());
afterAll(() => nock.enableNetConnect());
beforeEach(() => {
  gh = fakeGitHub();
});
afterEach(() => nock.cleanAll());

/** A verifier over one owner's apps, and a mint that goes through it as every mint path does. */
function world() {
  let fingerprint = 'fp-1';
  const apps = (): ResolvedApps =>
    new Map([['acme', { author: present(fingerprint), reviewer: present(fingerprint) }]]);
  const brokers = new Map<string, { fingerprint: string; broker: GitHubAppBroker }>();
  const brokerFor = (owner: string, role: AppRole) => {
    const read = apps().get(owner)?.[role];
    if (!read || read.source === 'missing') return undefined;
    const key = `${owner}/${role}/${read.fingerprint}`;
    let slot = brokers.get(key);
    if (!slot) {
      slot = {
        fingerprint: read.fingerprint,
        broker: createGitHubAppBroker({ appId: '100', privateKey: KEY }),
      };
      brokers.set(key, slot);
    }
    return slot;
  };
  const verifier = createInstallationVerifier({ resolvedApps: apps, brokerFor });
  const mint = async (zone: VerifiableZone, role: AppRole = 'author') => {
    const v = await verifier.verifiedInstallation(zone, role);
    return v.broker.mint({
      installationId: v.installationId,
      repositoryId: v.repositoryId,
      use: role === 'author' ? 'push' : 'server-reviewer',
    });
  };
  return {
    verifier,
    mint,
    rotate: (fp: string) => {
      fingerprint = fp;
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<InstallationCheckError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(InstallationCheckError);
    return e as InstallationCheckError;
  }
  throw new Error('expected a rejection');
}

describe('verifiedInstallation: the examples', () => {
  test('installation 7 covers acme/widgets, whose id is 42: verified, and the mint proceeds', async () => {
    const w = world();
    const v = await w.verifier.verifiedInstallation(ZONE, 'author');
    expect(v).toMatchObject({ owner: 'acme', installationId: 7, repositoryId: 42 });
    await w.mint(ZONE);
    expect(gh.mints()).toHaveLength(1);
    expect(gh.mints()[0]!.body).toMatchObject({ repository_ids: [42] });
    // The probe was narrowed by name to the zone's repository, metadata only.
    const probe = gh.calls.find((c) => c.body && 'repositories' in (c.body as object));
    expect(probe?.body).toEqual({ repositories: ['widgets'], permissions: { metadata: 'read' } });
  });

  test('a recorded repository id of 99 (another acme repository) refuses and mints nothing', async () => {
    const w = world();
    const zone = { ...ZONE, githubApp: { ...ZONE.githubApp!, repositoryId: 99 } };
    const e = await refusal(w.mint(zone));
    expect(e.refused).toBe(true);
    expect(e.message).toBe('zone-a: the recorded author repository id does not match acme/widgets');
    expect(gh.mints()).toEqual([]);
  });

  test('a 404 from installationFor refuses: not installed, and mints nothing', async () => {
    const w = world();
    gh.state.installation['acme/widgets'] = 'missing';
    const e = await refusal(w.mint(ZONE));
    expect(e.refused).toBe(true);
    expect(e.message).toBe('zone-a: the author app is not installed on acme/widgets');
    expect(gh.calls.filter((c) => c.path.endsWith('/access_tokens'))).toEqual([]);
  });

  test('a timeout is not verified, mints nothing, and the next pass verifies again', async () => {
    const w = world();
    gh.state.installation['acme/widgets'] = 'timeout';
    const e = await refusal(w.mint(ZONE));
    expect(e.refused).toBe(false);
    expect(e.message).toContain('zone-a');
    expect(e.message).toContain('author');
    expect(gh.calls.filter((c) => c.path.endsWith('/access_tokens'))).toEqual([]);
    gh.state.installation['acme/widgets'] = 7;
    await w.mint(ZONE);
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints()).toHaveLength(1);
  });
});

describe('verifiedInstallation: the trust boundary', () => {
  test('a mismatched installation id refuses, naming the zone and role, and mints nothing', async () => {
    const w = world();
    const zone = { ...ZONE, githubApp: { repositoryId: 42, installations: { reviewer: 8 } } };
    const e = await refusal(w.mint(zone, 'reviewer'));
    expect(e.refused).toBe(true);
    expect(e.message).toBe(
      'zone-a: the recorded reviewer installation id does not match acme/widgets',
    );
    expect(gh.calls.filter((c) => c.path.endsWith('/access_tokens'))).toEqual([]);
  });

  test("D1: zone A recorded with zone B's repository id (same app, same owner) is refused", async () => {
    const w = world();
    const zoneB: VerifiableZone = {
      id: 'zone-b',
      repo: 'acme/gadgets',
      identity: 'two-bot',
      githubApp: { repositoryId: 99, installations: { author: 7 } },
    };
    await w.mint(zoneB);
    const before = gh.mints().length;
    const zoneA = { ...ZONE, githubApp: { ...ZONE.githubApp!, repositoryId: 99 } };
    const e = await refusal(w.mint(zoneA));
    expect(e.refused).toBe(true);
    expect(gh.mints()).toHaveLength(before);
  });

  test('D2: a 500 while verifying mints nothing and is not cached either way', async () => {
    const w = world();
    gh.state.installation['acme/widgets'] = 500;
    expect((await refusal(w.mint(ZONE))).refused).toBe(false);
    expect((await refusal(w.mint(ZONE))).refused).toBe(false);
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints()).toEqual([]);
    gh.state.installation['acme/widgets'] = 7;
    await w.mint(ZONE);
    expect(gh.lookups()).toHaveLength(3);
  });

  test('a refusal is not remembered forever: corrected on GitHub, the next call verifies', async () => {
    const w = world();
    gh.state.ids['acme/widgets'] = 43;
    await refusal(w.mint(ZONE));
    gh.state.ids['acme/widgets'] = 42;
    await w.mint(ZONE);
    expect(gh.mints()).toHaveLength(1);
  });

  test('absence is not proof: no githubApp, or no id for the role, is not verified and calls nothing', async () => {
    const w = world();
    const none = { id: 'zone-a', repo: 'acme/widgets', identity: 'two-bot' } as VerifiableZone;
    const noRole = { ...ZONE, githubApp: { repositoryId: 42, installations: { author: 7 } } };
    const e1 = await refusal(w.mint(none));
    const e2 = await refusal(w.mint(noRole, 'reviewer'));
    for (const e of [e1, e2]) {
      expect(e.refused).toBe(true);
      expect(e.message).toContain('zone-a');
    }
    expect(e2.message).toContain('reviewer');
    expect(gh.calls).toEqual([]);
  });

  test('a refusal shown as a doctor finding says project, never zone (#629)', async () => {
    const w = world();
    const starter = await refusal(w.mint({ ...ZONE, identity: 'starter' }));
    const none = { id: 'zone-a', repo: 'acme/widgets', identity: 'two-bot' } as VerifiableZone;
    const unrecorded = await refusal(w.mint(none));
    expect(starter.message).toContain('is a starter project');
    expect(unrecorded.message).toContain('the project records no author app installation');
    for (const e of [starter, unrecorded])
      expect(e.message.replaceAll(ZONE.id, '')).not.toMatch(/\bzones?\b/i);
  });

  test('a starter zone and an owner with no app entry are refused without a GitHub call', async () => {
    const w = world();
    await refusal(w.mint({ ...ZONE, identity: 'starter' }));
    await refusal(w.mint({ ...ZONE, repo: 'other/widgets' }));
    expect(gh.calls).toEqual([]);
  });
});

describe('verifiedInstallation: the cache', () => {
  test('a second mint for the same verified zone makes no second verification call; a changed repository id does', async () => {
    const w = world();
    await w.mint(ZONE);
    await w.mint(ZONE);
    expect(gh.lookups()).toHaveLength(1);
    expect(gh.idReads()).toHaveLength(1);
    expect(gh.mints()).toHaveLength(2);
    // The repository id changes (to one that is wrong): verified again, and refused.
    await refusal(w.mint({ ...ZONE, githubApp: { ...ZONE.githubApp!, repositoryId: 99 } }));
    expect(gh.lookups()).toHaveLength(2);
    expect(gh.mints()).toHaveLength(2);
    // And back: verified again, not served from the first pass.
    await w.mint(ZONE);
    expect(gh.lookups()).toHaveLength(3);
  });

  test('a changed installation id, app entry fingerprint or repository re-verifies', async () => {
    const w = world();
    await w.mint(ZONE);
    gh.state.installation['acme/widgets'] = 8;
    await w.mint({ ...ZONE, githubApp: { repositoryId: 42, installations: { author: 8 } } });
    expect(gh.lookups()).toHaveLength(2);
    w.rotate('fp-2');
    await w.mint({ ...ZONE, githubApp: { repositoryId: 42, installations: { author: 8 } } });
    expect(gh.lookups()).toHaveLength(3);
    gh.state.installation['acme/gadgets'] = 8;
    await refusal(
      w.mint({
        ...ZONE,
        repo: 'acme/gadgets',
        githubApp: { repositoryId: 42, installations: { author: 8 } },
      }),
    );
    expect(gh.lookups()).toHaveLength(4);
  });

  test('roles are verified apart', async () => {
    const w = world();
    await w.mint(ZONE, 'author');
    await w.mint(ZONE, 'reviewer');
    expect(gh.lookups()).toHaveLength(2);
  });

  test('a fresh verifier (a server start) verifies again', async () => {
    await world().mint(ZONE);
    await world().mint(ZONE);
    expect(gh.lookups()).toHaveLength(2);
  });
});

describe('appRefusal: the park reason (issue #267)', () => {
  const apps = (): ResolvedApps =>
    new Map([['acme', { author: present('fp'), reviewer: { source: 'missing' } as AppEntryRead }]]);
  test('a refusal of a role the zone uses the app for is the reason', async () => {
    const w = world();
    const zone = { ...ZONE, githubApp: { ...ZONE.githubApp!, repositoryId: 99 } };
    expect(await appRefusal(w.verifier, zone, apps())).toBe(
      'zone-a: the recorded author repository id does not match acme/widgets',
    );
    expect(gh.mints()).toEqual([]);
  });

  test('verified ids, an error, a role on the PAT and a starter zone give none', async () => {
    const w = world();
    expect(await appRefusal(w.verifier, ZONE, apps())).toBeUndefined();
    gh.state.installation['acme/widgets'] = 'timeout';
    const other = { ...ZONE, githubApp: { ...ZONE.githubApp!, installations: { author: 8 } } };
    expect(await appRefusal(w.verifier, other, apps())).toBeUndefined();
    const starter = { ...ZONE, identity: 'starter' as const };
    expect(await appRefusal(w.verifier, starter, apps())).toBeUndefined();
    // Only the author role was asked: the reviewer is on the PAT.
    expect(gh.lookups()).toHaveLength(2);
  });
});
