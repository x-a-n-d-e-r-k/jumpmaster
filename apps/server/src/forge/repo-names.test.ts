import { generateKeyPairSync } from 'node:crypto';
import { DropPayloadSchema, isOwnerName, isRepoName, PushGrantSchema } from '@jumpmaster/protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DropZoneObject } from '../config.js';
import { REPO } from '../zones/detect.js';
import { GitHubForge } from './github.js';
import { createGitHubAppBroker } from './github-app.js';

/**
 * Issue #265 (D5): one owner and repository name rule, the same answer at every site a name
 * becomes a URL or a git remote. One table, six sites.
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

// Built at runtime so no token-shaped literal sits in the tracked file.
const TOKEN_OWNER = ['ghp', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'].join('_');
const TOKEN_NAME = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'].join('_');

/** [owner, name, accepted] */
const TABLE: [string, string, boolean][] = [
  ['acme', 'widgets', true],
  ['acme', 'wid.gets-2', true],
  ['a-b', '_x', true],
  ['acme', 'widgets?x', false],
  ['acme', 'wid%2Fgets', false],
  ['acme', '"x"', false],
  ['-acme', 'widgets', false],
  ['acme', '..', false],
  ['acme', '.', false],
  ['acme', 'wid gets', false],
  ['acme', 'wid#gets', false],
  ['ac/me', 'widgets', false],
  ['acme-', 'widgets', false],
  ['a'.repeat(40), 'widgets', false],
  ['acme', 'w'.repeat(101), false],
  ['', 'widgets', false],
  ['acme', '', false],
  [TOKEN_OWNER, 'widgets', false],
  ['acme', TOKEN_NAME, false],
];

const zone = (repo: string) => ({
  id: 'main',
  repo,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
});

const payload = (owner: string, name: string) => ({
  protocol: 1,
  dropId: 'drop-1',
  epoch: 1,
  role: 'implement',
  repo: { owner, name, defaultBranch: 'main' },
  issue: { number: 7, title: 't', body: 'b' },
  branch: 'agent/issue-7',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'm',
  maxTurns: 10,
  promptVersion: 'v1',
  prompt: 'p',
  image: 'jumpmaster-trooper:test',
  protectedPaths: [],
  credentials: { claudeToken: 'c', forgeToken: 'f' },
});

const grant = (owner: string, name: string) => ({
  token: 'tok',
  owner,
  name,
  branch: 'agent/issue-7',
  base: 'main',
  lease: '',
  protectedPaths: [],
  secrets: [],
});

/** Every text an error carries: message, stack, serialized properties, and zod issues. */
const textOf = (e: unknown): string =>
  e instanceof Error
    ? [e.message, String(e), e.stack ?? '', JSON.stringify(e), JSON.stringify({ ...e })].join('\n')
    : JSON.stringify(e);

type Site = (owner: string, name: string) => Promise<{ ok: boolean; error?: string }>;

const zodSite =
  (parse: (o: string, n: string) => { success: boolean; error?: unknown }): Site =>
  async (o, n) => {
    const r = parse(o, n);
    return r.success ? { ok: true } : { ok: false, error: textOf(r.error) };
  };

const fetches: string[] = [];

const SITES: Record<string, Site> = {
  'isOwnerName/isRepoName': async (o, n) => ({ ok: isOwnerName(o) && isRepoName(n) }),
  'zone schema': zodSite((o, n) => DropZoneObject.safeParse(zone(`${o}/${n}`))),
  'drop payload schema': zodSite((o, n) => DropPayloadSchema.safeParse(payload(o, n))),
  'push grant schema': zodSite((o, n) => PushGrantSchema.safeParse(grant(o, n))),
  'GitHubForge constructor': async (o, n) => {
    try {
      new GitHubForge(o, n, 'not-a-real-token');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: textOf(e) };
    }
  },
  installationFor: async (o, n) => {
    const broker = createGitHubAppBroker({ appId: '1', privateKey });
    const before = fetches.length;
    try {
      await broker.installationFor(o, n);
      expect(fetches.length).toBe(before + 1);
      return { ok: true };
    } catch (e) {
      // Refused before any request: no fetch made.
      expect(fetches.length).toBe(before);
      return { ok: false, error: textOf(e) };
    }
  },
};

describe('one owner and repository name rule at every site (issue #265, D5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    fetches.length = 0;
  });

  const stubFetch = () =>
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      fetches.push(String(url));
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });

  test.each(Object.keys(SITES))('%s: the same accept/refuse result as the table', async (site) => {
    stubFetch();
    for (const [owner, name, accepted] of TABLE) {
      const r = await SITES[site]!(owner, name);
      expect(r.ok, `${site} ${JSON.stringify(`${owner}/${name}`)}`).toBe(accepted);
      if (r.error !== undefined) {
        // The error names the field, never the refused value.
        if (owner.length >= 3 && !isOwnerName(owner)) expect(r.error).not.toContain(owner);
        if (name.length >= 3 && !isRepoName(name)) expect(r.error).not.toContain(name);
      }
    }
  });

  test('zone add and detect (REPO) agree with the table too', () => {
    for (const [owner, name, accepted] of TABLE)
      expect(REPO.test(`${owner}/${name}`), `${owner}/${name}`).toBe(accepted);
  });

  test('the broker refuses a bad name with no fetch and without echoing it, at every entry point', async () => {
    stubFetch();
    const broker = createGitHubAppBroker({ appId: '1', privateKey });
    for (const [owner, name] of [
      [TOKEN_OWNER, 'widgets'],
      ['acme', TOKEN_NAME],
      ['acme', 'widgets?x'],
    ] as const) {
      for (const call of [
        () => broker.installationFor(owner, name),
        () => broker.repositoryIdOf(9, owner, name),
      ]) {
        const e = await call().then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(e).toBeInstanceOf(Error);
        const text = textOf(e);
        expect(text).not.toContain(owner === 'acme' ? name : owner);
        expect(text).not.toContain('ghp_');
      }
    }
    expect(fetches).toEqual([]);
  });

  test('a token-shaped owner is refused at every site and absent from every error', async () => {
    stubFetch();
    for (const [site, run] of Object.entries(SITES)) {
      const r = await run(TOKEN_OWNER, 'widgets');
      expect(r.ok, site).toBe(false);
      expect(r.error ?? '', site).not.toContain(TOKEN_OWNER);
      expect(r.error ?? '', site).not.toContain('ghp_');
    }
  });
});
