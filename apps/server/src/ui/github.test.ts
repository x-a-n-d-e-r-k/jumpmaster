import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GuidanceForge } from '../api/github.js';
import { createApp } from '../app.js';
import { setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import type { DropZoneConfig } from '../config.js';
import { openDb } from '../db/open.js';
import {
  EXPIRATION_NOTE,
  RESOURCE_OWNER_NOTE,
  STARTER_CODEOWNERS_NOTE,
  zoneGuidance,
} from '../github/guidance.js';
import { MATRIX_AND_REUSABLE_NOTE } from '../github/workflows.js';
import { APP_ENTRIES, APP_SECRETS, guidanceAppsOf } from '../test/app-guidance-fixture.js';
import { makeZone } from '../test/fixtures.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { mergeRulesetSection, zonePage } from './github.js';
import { escapeHtml, FAVICON_HREF } from './pages.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const AUTHOR = 'github_pat_' + 'PAGEAUTHORDUMMY01234567890';
const REVIEWER = 'github_pat_' + 'PAGEREVIEWERDUMMY0123456789';
const CLAUDE = 'sk-ant-' + 'oat01-PAGECLAUDEDUMMY0123456789';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

/** A job name a workflow could carry: forge text, rendered escaped or not at all. */
const HOSTILE_JOB = '<img src=x onerror=alert(1)>';
const CI_YML = `on: pull_request\njobs:\n  test:\n    name: "${HOSTILE_JOB}"\n    runs-on: x\n`;

type Opts = {
  ownerType?: 'User' | 'Organization';
  fail?: number;
  noCi?: boolean;
  identity?: 'two-bot' | 'starter';
  /** No author PAT in the install. */
  noAuthor?: boolean;
  /** An author app for the zone's owner, its installation recorded, and a token source for it. */
  authorApp?: { token: string };
};

function forgeFor(o: Opts = {}) {
  return (_repo: string, token: string): GuidanceForge => ({
    repoAccess: async () => {
      if (o.fail) throw Object.assign(new Error('Bad credentials <b>'), { status: o.fail });
      return {
        private: false,
        defaultBranch: 'main',
        permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
        scopes: null,
        tokenExpiresAt: null,
        ownerType: o.ownerType ?? 'Organization',
      };
    },
    ownerType: async () => o.ownerType ?? 'Organization',
    viewerLogin: async () => (token === AUTHOR ? 'jm-author' : 'jm-reviewer'),
    listDir: async (_ref: string, path: string) =>
      path === '.github/workflows' && !o.noCi ? ['ci.yml'] : [],
    getFileAt: async (_ref: string, path: string) =>
      path === '.github/workflows/ci.yml' ? CI_YML : null,
  });
}

async function world(o: Opts = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-ghpage-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, undefined),
    env: {
      JM_CLAUDE_TOKEN: CLAUDE,
      ...(o.noAuthor ? {} : { JM_GITHUB_AUTHOR_TOKEN: AUTHOR }),
      JM_GITHUB_REVIEWER_TOKEN: REVIEWER,
      JM_JOIN_TOKEN: 'join-secret-value-7',
      JM_OPERATOR_TOKEN: TOKEN,
      JM_DEV_IMAGES: '1',
    },
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no zone forge in this test');
    },
    now: () => t0,
    leaseWaitMs: 0,
    leasePollMs: 0,
    guidanceForge: forgeFor(o),
    ...(o.authorApp
      ? {
          appTokens: {
            provider: () => ({ token: async () => o.authorApp?.token ?? '' }),
            fresh: vi.fn(),
            clear: vi.fn(),
          },
        }
      : {}),
  });
  app = a;
  await setOperatorPassphrase(db, 'a long operator passphrase', t0);
  const s = operatorSession(db);
  const added = await a.inject({
    method: 'POST',
    url: '/api/control/zones',
    headers: { authorization: `Bearer ${TOKEN}`, host: HOST },
    payload: {
      zone: {
        repo: 'octo-org/demo',
        identity: o.identity ?? 'two-bot',
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test' }],
        egress: { mode: 'monitor' },
      },
    },
  });
  if (added.statusCode !== 200) throw new Error(added.body);
  if (o.authorApp) {
    // The installation discovery's ids and the owner's author entry, as the store would hold them.
    const cfg = store.current();
    const dropZones = cfg.dropZones.map(
      (z) =>
        ({
          ...z,
          githubApp: { repositoryId: 1, installations: { author: 11 } },
        }) as DropZoneConfig,
    );
    vi.spyOn(store, 'current').mockReturnValue({ ...cfg, dropZones });
    vi.spyOn(store, 'resolvedApps').mockReturnValue(
      new Map([
        [
          'octo-org',
          {
            author: {
              source: 'vault',
              fingerprint: 'fp-a',
              entry: {
                appId: '42',
                slug: 'jm-author-app',
                clientId: 'c',
                pem: 'not-a-key',
                importedAt: '2026-11-01',
              },
            },
            reviewer: { source: 'missing' },
          },
        ],
      ]),
    );
  }
  const get = (url: string) =>
    a.inject({ method: 'GET', url, headers: { host: HOST, cookie: s.cookie } });
  return { db, store, get };
}

/** Every href and src in a page. */
const links = (html: string): string[] =>
  [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => (m[1] ?? '').replaceAll('&amp;', '&'));

describe('the GitHub page of a zone', () => {
  test('GET /zones/:id/github holds the recommendation, the token links, the checklist, the ruleset file and CODEOWNERS, escaped and without a credential', async () => {
    const w = await world();
    const r = await w.get('/zones/demo/github?reviewer=alice');
    expect(r.statusCode, r.body).toBe(200);
    const html = r.body;
    // Named by its repository, not its zone id (#99).
    expect(html).toContain('<h2>GitHub for octo-org/demo</h2>');
    // The order the operator works in: accounts, tokens, collaborators, ruleset, CODEOWNERS.
    const at = (s: string) => html.indexOf(s);
    for (const s of [
      'id="recommendation"',
      'id="tokens"',
      'id="checklist"',
      'id="ruleset"',
      'id="codeowners"',
    ])
      expect(at(s), s).toBeGreaterThan(-1);
    expect(at('id="recommendation"')).toBeLessThan(at('id="tokens"'));
    expect(at('id="tokens"')).toBeLessThan(at('id="ruleset"'));
    expect(at('id="ruleset"')).toBeLessThan(at('id="codeowners"'));
    expect(html).toContain('Two bot accounts as GitHub Apps');
    // What the zone runs as now, beside the recommendation.
    expect(html).toContain('This zone runs as two-bot');
    expect(html).toContain(RESOURCE_OWNER_NOTE);
    expect(html).toContain('Only select repositories');
    // T10 finding 4: a new token per install, and a later project is added by editing it.
    // One token per account per install: a second project edits it rather than making another.
    expect(html).toContain('rather than reusing one made for another tool or install');
    expect(html).toContain(
      "If this install already has this account's token, edit its repository access instead",
    );
    expect(html).not.toContain('not one made for another project');
    expect(html).toContain("edit this token's repository access on GitHub to add it");
    expect(html).toContain('invite jm-author with the Write role');
    expect(html).toContain('accept the invitation as jm-reviewer');
    // The ruleset: shown, downloadable, and the two-line import with the rulesets link.
    expect(html).toContain('jumpmaster-demo-ruleset.json');
    expect(html).toContain('download="jumpmaster-demo-ruleset.json"');
    expect(html).toContain('Import a ruleset');
    expect(html).toContain('href="https://github.com/octo-org/demo/settings/rules"');
    expect(html).toContain(escapeHtml(MATRIX_AND_REUSABLE_NOTE));
    // CODEOWNERS with the typed login, and its new-file link.
    expect(html).toContain('.github/** @alice');
    // Two-bot: the reviewer bot opens the file, and an existing catch-all must name it too.
    expect(html).toContain('* @jm-reviewer');
    expect(html).toContain('add the reviewer bot to it, or nothing will merge');
    expect(links(html)).toContain(
      'https://github.com/octo-org/demo/new/main?filename=.github%2FCODEOWNERS',
    );
    // Forge text is escaped wherever it appears; no external link but GitHub's (the tab icon is our own data URI).
    expect(html).not.toContain(HOSTILE_JOB);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    for (const l of links(html).filter((l) => /^[a-z]+:/i.test(l) && l !== FAVICON_HREF))
      expect(l.startsWith('https://github.com/') || l.startsWith('data:application/json'), l).toBe(
        true,
      );
    for (const secret of [AUTHOR, REVIEWER, CLAUDE, TOKEN]) expect(html).not.toContain(secret);
  });

  test('the token step is short numbered steps, in the order they are done, with the lifetime note', async () => {
    const html = (await (await world()).get('/zones/demo/github')).body;
    const steps = /<ol id="token-steps">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    const order = [
      'Sign in as',
      'Resource owner',
      'Only select repositories',
      'Generate token',
      'Paste it',
    ];
    const at = order.map((w) => steps.indexOf(w));
    expect(
      at.every((i) => i >= 0),
      steps,
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(steps).toContain('re-select the organization');
    expect(html).toContain(escapeHtml(EXPIRATION_NOTE));
  });

  test('with no CI the warning comes before the download and says what the file still requires; starter says Jumpmaster parks protected paths', async () => {
    const html = (
      await (await world({ noCi: true, identity: 'starter' })).get('/zones/demo/github')
    ).body;
    const note = html.indexOf('a pull request must exist');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf('download="'));
    expect(html).toContain('with zero approvals');
    expect(html).toContain(escapeHtml(STARTER_CODEOWNERS_NOTE));
  });

  test('a two-bot zone folds its token links under Use tokens instead; a starter zone shows them as before; a personal starter zone is not the recommendation', async () => {
    const two = (await (await world()).get('/zones/demo/github')).body;
    const details = two.indexOf('<details id="use-tokens"><summary>Use tokens instead</summary>');
    expect(details).toBeGreaterThan(-1);
    expect(details).toBeLessThan(two.indexOf('id="tokens"'));
    expect(two.indexOf('id="tokens"')).toBeLessThan(two.indexOf('</details>'));
    expect(two).toContain('The reviewer token');
    expect(two).not.toContain('not the recommendation above');
    await app?.close();
    vi.restoreAllMocks();

    const starter = (
      await (await world({ ownerType: 'User', identity: 'starter' })).get('/zones/demo/github')
    ).body;
    expect(starter).toContain('id="tokens"');
    expect(starter).not.toContain('id="use-tokens"');
    expect(starter).not.toContain('The reviewer token');
    expect(starter).toContain('This zone runs as starter');
    expect(starter).toContain('not the recommendation above');
  });

  test('an app-author zone with no author PAT renders its guidance on the author app, not the no-author message', async () => {
    const appToken = ['ghs', 'PAGEAPPTOKEN'.repeat(3)].join('_');
    const without = await (await world({ noAuthor: true })).get('/zones/demo/github');
    expect(without.statusCode).toBe(409);
    expect(without.body).toContain('Set or replace the tokens');
    await app?.close();
    vi.restoreAllMocks();
    const r = await (await world({ noAuthor: true, authorApp: { token: appToken } })).get(
      '/zones/demo/github',
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('id="ruleset"');
    expect(r.body).toContain('jumpmaster-demo-ruleset.json');
    expect(r.body).not.toContain('Set or replace the tokens');
    expect(r.body).not.toContain(appToken);
  });

  test('an unknown zone is 404; a refused read says why, escaped, and links the GitHub step', async () => {
    const w = await world({ fail: 401 });
    expect((await w.get('/zones/nope/github')).statusCode).toBe(404);
    const r = await w.get('/zones/demo/github');
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('GitHub rejected the author token (401)');
    expect(r.body).toContain('<h2>GitHub for octo-org/demo</h2>');
    expect(r.body).not.toContain('<b>');
    expect(r.body).toContain('href="/setup/forge"');
  });

  test('home links each zone’s page, which links its GitHub page, as the doctor page does', async () => {
    const w = await world();
    expect((await w.get('/')).body).toContain('href="/zones/demo"');
    expect((await w.get('/zones/demo')).body).toContain('href="/zones/demo/github"');
    expect((await w.get('/doctor')).body).toContain('href="/zones/demo/github"');
  });
});

describe('the merge ruleset section (two-app zones)', () => {
  const zone = makeZone({ id: 'demo', repo: 'octo-org/demo', identity: 'two-bot' });
  const detection = {
    defaultBranch: 'main',
    ciJobs: [{ workflow: 'ci.yml', job: 'test' }],
    ownerType: 'Organization' as const,
    visibility: 'public' as const,
  };
  const logins = { author: 'jm-author', reviewer: 'jm-reviewer', codeowners: ['alice'] };

  test('a two-app guidance renders the merge ruleset next to the main one; otherwise the page is unchanged', () => {
    const g = zoneGuidance(zone, detection, logins, {}, guidanceAppsOf(APP_ENTRIES));
    const html = zonePage(zone, [zone], g, '');
    const merge = g.mergeRuleset;
    if (!merge) throw new Error('no merge ruleset');
    expect(html).toContain('<section id="merge-ruleset">');
    expect(html.indexOf('id="ruleset"')).toBeLessThan(html.indexOf('id="merge-ruleset"'));
    expect(html.indexOf('id="merge-ruleset"')).toBeLessThan(html.indexOf('id="codeowners"'));
    const section = mergeRulesetSection(merge, g.rulesUrl);
    expect(html).toContain(section);
    expect(section).toContain(escapeHtml(merge.note));
    expect(section).toContain('href="https://github.com/octo-org/demo/settings/rules"');
    expect(section).toContain('New ruleset → Import a ruleset');
    expect(section).toContain('<code>jumpmaster-demo-merge-ruleset.json</code>');
    expect(section).toContain('download="jumpmaster-demo-merge-ruleset.json"');
    expect(section).toContain('data-copy="merge-ruleset-text"');
    expect(section).toContain(`<pre id="merge-ruleset-text">${escapeHtml(merge.text)}</pre>`);
    expect(section).not.toMatch(/no bypass/i);
    // The checklist installs the apps.
    expect(html).toContain('install the author GitHub App acme-jm-author on octo-org/demo');
    // Only the id and the slug went in: no key, secret or token comes out.
    const json = JSON.stringify(g);
    for (const s of Object.values(APP_SECRETS)) {
      expect(json).not.toContain(s);
      expect(html).not.toContain(s);
      expect(html).not.toContain(escapeHtml(s));
    }
    expect(html).not.toContain('PRIVATE KEY');

    // Without apps, no section, and the page is what it was.
    const pat = zoneGuidance(zone, detection, logins);
    const plain = zonePage(zone, [zone], pat, '');
    expect(plain).not.toContain('merge-ruleset');
    // The section is the only thing it adds.
    const { mergeRuleset: _, ...without } = g;
    expect(zonePage(zone, [zone], without, '')).toBe(html.replace(`${section}\n`, ''));
  });

  test('a slug with markup is escaped in the checklist and the note', () => {
    const hostile = '<script>alert(1)</script>';
    const g = zoneGuidance(
      zone,
      detection,
      logins,
      {},
      {
        author: { appId: 7, slug: hostile },
        reviewer: { slug: hostile },
      },
    );
    expect(g.mergeRuleset?.note).toContain(hostile);
    expect(g.checklist.items.join('\n')).toContain(hostile);
    const html = zonePage(zone, [zone], g, '');
    expect(html).not.toContain(hostile);
    expect(html).toContain(escapeHtml(hostile));
  });
});
