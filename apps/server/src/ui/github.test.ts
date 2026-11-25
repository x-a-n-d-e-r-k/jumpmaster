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
import { type Db, openDb } from '../db/open.js';
import type { DoctorCheck } from '../doctor/checks.js';
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
import { visibleText } from '../test/visible-text.js';
import { fingerprintOf, openVault } from '../vault/vault.js';
import { githubSection, gitlabSection, mergeRulesetSection, stepStatus } from './github.js';
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
  test('GET /projects/:id/github holds the recommendation, the token links, the checklist, the ruleset file and CODEOWNERS, escaped and without a credential', async () => {
    const w = await world();
    const r = await w.get('/projects/demo/setup?reviewer=alice');
    expect(r.statusCode, r.body).toBe(200);
    const html = r.body;
    // A section of Setup (#618), after Repository & labels and before Stack & checks.
    expect(html).toContain('<section id="github" class="setup-section"><h3>GitHub</h3>');
    expect(html.indexOf('id="project"')).toBeLessThan(html.indexOf('id="github"'));
    expect(html.indexOf('id="github"')).toBeLessThan(html.indexOf('id="stack"'));
    expect(html).toContain('<a href="#github">GitHub</a>');
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
    expect(html).toContain('This project runs as two-bot');
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
    const html = (await (await world()).get('/projects/demo/setup')).body;
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
      await (await world({ noCi: true, identity: 'starter' })).get('/projects/demo/setup')
    ).body;
    const note = html.indexOf('a pull request must exist');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(html.indexOf('download="'));
    expect(html).toContain('with zero approvals');
    expect(html).toContain(escapeHtml(STARTER_CODEOWNERS_NOTE));
  });

  test('a two-bot zone folds its token links under Use tokens instead; a starter zone shows them as before; a personal starter zone is not the recommendation', async () => {
    const two = (await (await world()).get('/projects/demo/setup')).body;
    const details = two.indexOf('<details id="use-tokens"><summary>Use tokens instead</summary>');
    expect(details).toBeGreaterThan(-1);
    expect(details).toBeLessThan(two.indexOf('id="tokens"'));
    expect(two.indexOf('id="tokens"')).toBeLessThan(two.indexOf('</details>'));
    expect(two).toContain('The reviewer token');
    expect(two).not.toContain('not the recommendation above');
    await app?.close();
    vi.restoreAllMocks();

    const starter = (
      await (await world({ ownerType: 'User', identity: 'starter' })).get('/projects/demo/setup')
    ).body;
    expect(starter).toContain('id="tokens"');
    expect(starter).not.toContain('id="use-tokens"');
    expect(starter).not.toContain('The reviewer token');
    expect(starter).toContain('This project runs as starter');
    expect(starter).toContain('not the recommendation above');
  });

  test('an app-author zone with no author PAT renders its guidance on the author app, not the no-author message', async () => {
    const appToken = ['ghs', 'PAGEAPPTOKEN'.repeat(3)].join('_');
    const without = await (await world({ noAuthor: true })).get('/projects/demo/setup');
    expect(without.statusCode).toBe(200);
    expect(without.body).toContain('Set or replace the tokens');
    await app?.close();
    vi.restoreAllMocks();
    const r = await (await world({ noAuthor: true, authorApp: { token: appToken } })).get(
      '/projects/demo/setup',
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('id="ruleset"');
    expect(r.body).toContain('jumpmaster-demo-ruleset.json');
    expect(r.body).not.toContain('Set or replace the tokens');
    expect(r.body).not.toContain(appToken);
  });

  test('an unknown zone is 404; a refused read says why in the GitHub section, escaped, and links the GitHub step', async () => {
    const w = await world({ fail: 401 });
    expect((await w.get('/projects/nope/setup')).statusCode).toBe(404);
    const r = await w.get('/projects/demo/setup');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('GitHub rejected the author token (401)');
    expect(r.body).toContain('<section id="github" class="setup-section"><h3>GitHub</h3>');
    expect(r.body).not.toContain('<b>');
    expect(r.body).toContain('href="/setup/forge"');
  });

  test('home links each zone’s page, which links its GitHub section, as the doctor page does', async () => {
    const w = await world();
    expect((await w.get('/')).body).toContain('href="/projects/demo"');
    expect((await w.get('/projects/demo')).body).toContain('href="/projects/demo/setup#github"');
    expect((await w.get('/system')).body).toContain('href="/projects/demo/setup#github"');
  });

  test('the code owners form is outside the settings form, and asks for the Setup page again', async () => {
    const html = (await (await world()).get('/projects/demo/setup?reviewer=alice')).body;
    const start = html.indexOf('<form id="setup-form"');
    expect(start).toBeGreaterThan(-1);
    const form = html.slice(start, html.indexOf('</form>', start));
    // No form inside Setup's form: the login names its own form instead.
    expect(form.slice(1)).not.toContain('<form');
    expect(form).toContain('<input name="reviewer" form="github-reviewer-form" value="alice"');
    expect(html).toContain(
      '<form id="github-reviewer-form" method="get" action="/projects/demo/setup#github"></form>',
    );
  });

  test('the downloads and their file names are unchanged', async () => {
    const html = (await (await world()).get('/projects/demo/setup')).body;
    expect(html).toContain(
      'download="jumpmaster-demo-ruleset.json">Download jumpmaster-demo-ruleset.json</a>',
    );
    expect(html).toMatch(
      /<a href="data:application\/json;charset=utf-8,[^"]+" download="jumpmaster-demo-ruleset.json">/,
    );
    expect(html).toContain('<button type="button" data-copy="ruleset-text">Copy</button>');
    expect(html).toContain('<button type="button" data-copy="codeowners-text">Copy</button>');
    expect(html).toContain('<pre id="codeowners-text">');
    expect(html).toContain('Create <code>.github/CODEOWNERS</code> on GitHub</a>');
    // The copy buttons' script, once.
    expect(html.split('navigator.clipboard.writeText').length).toBe(2);
  });
});

/** A finished doctor run with these checks. */
function doctorRun(db: Db, checks: Partial<DoctorCheck>[]) {
  db.prepare(
    "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
  ).run(JSON.stringify(checks.map((c) => ({ zoneId: 'demo', summary: '', ...c }))));
}

/** The status paragraph of a step in a page. */
const chipOf = (html: string, step: string): string => {
  const at = html.indexOf(`<p class="step-status" data-step="${step}">`);
  expect(at, step).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf('</p>', at));
};

describe('each step of the GitHub section shows its doctor status (#618)', () => {
  test('a failing branch-rules check makes the ruleset missing, with the finding; the account and clone checks passing make access done', async () => {
    const w = await world();
    doctorRun(w.db, [
      { id: 'forge.branch-rules', status: 'fail', summary: 'no ruleset <b>protects</b> main' },
      { id: 'forge.ci', status: 'pass', summary: 'ci reports' },
      { id: 'forge.private-clone', status: 'pass', summary: 'public' },
      { id: 'forge.author', status: 'pass', summary: 'author has write' },
      { id: 'forge.reviewer', status: 'pass', summary: 'reviewer has write' },
      { id: 'forge.codeowners', status: 'warn', summary: 'no CODEOWNERS file' },
      // Another zone's labels pass: not this zone's.
      { id: 'forge.labels', status: 'pass', zoneId: 'other' },
    ]);
    const html = (await w.get('/projects/demo/setup')).body;
    const ruleset = chipOf(html, 'ruleset');
    expect(ruleset).toContain('data-status="missing">missing</span>');
    expect(ruleset).toContain('no ruleset &lt;b&gt;protects&lt;/b&gt; main');
    expect(ruleset).not.toContain('ci reports');
    expect(chipOf(html, 'access')).toContain('data-status="done">done</span>');
    expect(chipOf(html, 'codeowners')).toContain('data-status="check">check</span>');
    expect(chipOf(html, 'codeowners')).toContain('no CODEOWNERS file');
    expect(chipOf(html, 'labels')).toContain('data-status="not-checked">not checked</span>');
    // Each chip sits in its own step.
    const at = (s: string) => html.indexOf(s);
    expect(at('id="checklist"')).toBeLessThan(at('data-step="access"'));
    expect(at('data-step="access"')).toBeLessThan(at('id="ruleset"'));
    expect(at('id="ruleset"')).toBeLessThan(at('data-step="ruleset"'));
    expect(at('id="codeowners"')).toBeLessThan(at('data-step="codeowners"'));
  });

  test('with no doctor run every step is not checked, never done', async () => {
    const w = await world();
    const html = (await w.get('/projects/demo/setup')).body;
    for (const step of ['access', 'ruleset', 'codeowners', 'labels']) {
      expect(chipOf(html, step)).toContain('data-status="not-checked">not checked</span>');
      expect(chipOf(html, step)).not.toContain('done');
    }
    expect(html).not.toContain('data-status="done"');
  });

  test('a run with no matching check, or only part of a step, is not checked; all passing is done', async () => {
    const w = await world();
    doctorRun(w.db, [
      { id: 'forge.ci', status: 'pass' },
      { id: 'forge.labels', status: 'skip', summary: 'skipped' },
      { id: 'forge.codeowners', status: 'pass' },
    ]);
    const html = (await w.get('/projects/demo/setup')).body;
    expect(chipOf(html, 'ruleset')).toContain('data-status="not-checked"');
    expect(chipOf(html, 'labels')).toContain('data-status="not-checked"');
    expect(chipOf(html, 'access')).toContain('data-status="not-checked"');
    expect(chipOf(html, 'codeowners')).toContain('data-status="done"');
  });

  test('with GitHub unreadable the section still lists every step with its status', async () => {
    const w = await world({ fail: 401 });
    doctorRun(w.db, [
      { id: 'forge.private-clone', status: 'pass' },
      { id: 'forge.author', status: 'pass' },
      { id: 'forge.reviewer', status: 'pass' },
    ]);
    const html = (await w.get('/projects/demo/setup')).body;
    expect(html).toContain('<ul id="github-steps">');
    expect(chipOf(html, 'access')).toContain('data-status="done"');
    expect(chipOf(html, 'ruleset')).toContain('data-status="not-checked"');
  });
});

describe('stepStatus', () => {
  const c = (id: string, status: DoctorCheck['status'], zoneId: string | null = 'z') =>
    ({ id, status, zoneId, summary: `${id} ${status}` }) as DoctorCheck;
  test('maps pass, fail, warn and absence; an empty result is never done', () => {
    expect(stepStatus(null, 'z', 'access').state).toBe('not-checked');
    expect(stepStatus([], 'z', 'access').state).toBe('not-checked');
    const access = [c('forge.author', 'pass'), c('forge.reviewer', 'pass')];
    expect(stepStatus([...access, c('forge.private-clone', 'pass')], 'z', 'access').state).toBe(
      'done',
    );
    expect(
      stepStatus(
        [...access, c('forge.private-clone', 'pass', 'y')].map((x) => ({ ...x, zoneId: 'y' })),
        'z',
        'access',
      ).state,
    ).toBe('not-checked');
    expect(stepStatus([c('forge.labels', 'fail')], 'z', 'labels')).toEqual({
      state: 'missing',
      findings: ['forge.labels fail'],
    });
    expect(stepStatus([c('forge.labels', 'warn')], 'z', 'labels').state).toBe('check');
    expect(
      stepStatus([c('forge.branch-rules', 'pass'), c('forge.ci', 'warn')], 'z', 'ruleset').state,
    ).toBe('check');
    expect(
      stepStatus([c('forge.branch-rules', 'pass'), c('forge.ci', 'pass')], 'z', 'ruleset').state,
    ).toBe('done');
  });
});

describe("the access step is judged by the accounts' access (#679)", () => {
  const c = (id: string, status: DoctorCheck['status'], zoneId: string | null = 'z') =>
    ({ id, status, zoneId, summary: `${id} ${status}` }) as DoctorCheck;

  test('access is missing when an account lacks the Write role, even on a public repository', () => {
    const checks = [
      c('forge.author', 'pass'),
      c('forge.reviewer', 'fail'),
      c('forge.private-clone', 'pass'),
    ];
    const s = stepStatus(checks, 'z', 'access');
    expect(s.state).toBe('missing');
    expect(s.findings).toHaveLength(1);
    expect(s.findings).toEqual(['forge.reviewer fail']);
  });

  test('a failing author is missing too, with its finding', () => {
    const checks = [
      c('forge.author', 'fail'),
      c('forge.reviewer', 'pass'),
      c('forge.private-clone', 'pass'),
    ];
    expect(stepStatus(checks, 'z', 'access')).toEqual({
      state: 'missing',
      findings: ['forge.author fail'],
    });
  });

  test('a warning from either account check is check, with the summary', () => {
    for (const who of ['forge.author', 'forge.reviewer']) {
      const checks = ['forge.author', 'forge.reviewer', 'forge.private-clone'].map((id) =>
        c(id, id === who ? 'warn' : 'pass'),
      );
      expect(stepStatus(checks, 'z', 'access')).toEqual({
        state: 'check',
        findings: [`${who} warn`],
      });
    }
  });

  test('access is not done from the private-clone check alone', () => {
    expect(stepStatus([c('forge.private-clone', 'pass')], 'z', 'access').state).toBe('not-checked');
  });

  test('access is done when all three pass', () => {
    const checks = [
      c('forge.author', 'pass'),
      c('forge.reviewer', 'pass'),
      c('forge.private-clone', 'pass'),
    ];
    expect(stepStatus(checks, 'z', 'access')).toEqual({ state: 'done', findings: [] });
  });

  test('a starter zone, its reviewer skipped by design, is done when the other two pass', () => {
    const checks = [
      c('forge.author', 'pass'),
      c('forge.reviewer', 'skip'),
      c('forge.private-clone', 'pass'),
    ];
    expect(stepStatus(checks, 'z', 'access', true).state).toBe('done');
    // Without the starter flag a skipped reviewer is never done.
    expect(stepStatus(checks, 'z', 'access').state).toBe('not-checked');
    // A starter zone is still missing when its author fails.
    expect(
      stepStatus([c('forge.author', 'fail'), c('forge.private-clone', 'pass')], 'z', 'access', true)
        .state,
    ).toBe('missing');
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
    const html = githubSection(zone, { ok: true, guidance: g, reviewer: '' }, null);
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
    const plain = githubSection(zone, { ok: true, guidance: pat, reviewer: '' }, null);
    expect(plain).not.toContain('merge-ruleset');
    // The section is the only thing it adds.
    const { mergeRuleset: _, ...without } = g;
    expect(githubSection(zone, { ok: true, guidance: without, reviewer: '' }, null)).toBe(
      html.replace(`${section}\n`, ''),
    );
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
    const html = githubSection(zone, { ok: true, guidance: g, reviewer: '' }, null);
    expect(html).not.toContain(hostile);
    expect(html).toContain(escapeHtml(hostile));
  });
});

describe("a GitHub zone's Setup section is pinned (#879)", () => {
  const detection = {
    defaultBranch: 'main',
    ciJobs: [{ workflow: 'ci.yml', job: 'test' }],
    ownerType: 'Organization' as const,
    visibility: 'public' as const,
  };
  const logins = { author: 'jm-author', reviewer: 'jm-reviewer', codeowners: ['alice'] };
  const checks = [
    { id: 'forge.branch-rules', status: 'fail', summary: 'no ruleset <b>protects</b> main' },
    { id: 'forge.ci', status: 'pass', summary: 'ci reports' },
    { id: 'forge.author', status: 'pass', summary: 'author has write' },
    { id: 'forge.codeowners', status: 'warn', summary: 'no CODEOWNERS file' },
  ].map((c) => ({ zoneId: 'demo', ...c }) as DoctorCheck);

  test('two-bot, starter and a refused read render exactly as before', async () => {
    const two = makeZone({ id: 'demo', repo: 'octo-org/demo', identity: 'two-bot' });
    const starter = makeZone({ id: 'demo', repo: 'octo-org/demo', identity: 'starter' });
    const html = [
      githubSection(
        two,
        { ok: true, guidance: zoneGuidance(two, detection, logins), reviewer: 'alice' },
        checks,
      ),
      githubSection(
        starter,
        { ok: true, guidance: zoneGuidance(starter, detection, logins), reviewer: '' },
        null,
      ),
      githubSection(two, { ok: false, error: 'GitHub rejected the author token (401)' }, checks),
    ].join('\n<!-- next -->\n');
    await expect(html).toMatchFileSnapshot('./__snapshots__/github-section.html');
  });
});

describe("a GitLab zone's Setup section (#879)", () => {
  const gl = (o: Partial<DropZoneConfig> = {}) =>
    makeZone({
      id: 'lab',
      repo: 'acme/<sub>/widgets',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.test' },
      identity: 'two-bot',
      ...o,
    } as Partial<DropZoneConfig>);
  const run = (rows: [string, DoctorCheck['status'], string][]) =>
    rows.map(([id, status, summary]) => ({ id, status, summary, zoneId: 'lab' }) as DoctorCheck);

  /** The step's whole list item, from its label to its chip's end. */
  const stepOf = (html: string, step: string): string => {
    const at = html.indexOf(`<li data-gitlab-step="${step}">`);
    expect(at, step).toBeGreaterThan(-1);
    const next = html.indexOf('<li data-gitlab-step=', at + 1);
    return html.slice(at, next > -1 ? next : html.indexOf('</ol>', at));
  };

  /** Asserts no GitHub wording in a section's visible text or markup. */
  const gitlabWordsOnly = (html: string) => {
    const text = visibleText(html);
    expect(text).not.toMatch(/GitHub step/i);
    expect(text).not.toMatch(/ruleset/i);
    expect(text).not.toMatch(/not supported yet/i);
    expect(text).not.toMatch(/GitHub/);
    expect(text).not.toMatch(/(^|\s)gh /);
    expect(html).not.toContain('<code>gh');
    expect(html).not.toContain('/setup/forge');
  };

  test('a two-bot zone: the GitLab heading, the project on its instance, four steps with their doctor status, the entry names and the links', () => {
    const html = gitlabSection(
      gl(),
      run([
        ['forge.author', 'pass', 'author is Developer'],
        ['forge.reviewer', 'fail', 'the reviewer user <rev> is Maintainer'],
        ['forge.private-clone', 'pass', 'public'],
        ['forge.branch-rules', 'pass', 'protected'],
        ['forge.ci', 'pass', 'pipelines'],
        ['forge.codeowners', 'warn', 'no CODEOWNERS file'],
        ['forge.labels', 'pass', 'labels exist'],
      ]),
    );
    expect(html).toContain('<section id="github" class="setup-section"><h3>GitLab</h3>');
    expect(html).not.toContain('<h3>GitHub</h3>');
    // The project by its path on its instance, escaped.
    expect(html).toContain('<code>acme/&lt;sub&gt;/widgets</code>');
    expect(html).toContain('<code>https://gitlab.example.test</code>');
    expect(html).not.toContain('<sub>');
    // The four steps, in order, each with its chip.
    const order = ['access', 'ruleset', 'codeowners', 'labels'].map((s) =>
      html.indexOf(`data-gitlab-step="${s}"`),
    );
    expect(order.every((n) => n > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const access = stepOf(html, 'access');
    expect(access).toContain('Bot tokens and access');
    expect(access).toContain('data-status="missing">missing</span>');
    expect(access).toContain('the reviewer user &lt;rev&gt; is Maintainer');
    expect(access).not.toContain('author is Developer');
    expect(stepOf(html, 'ruleset')).toContain('Protected branch, approvals and pipelines');
    expect(stepOf(html, 'ruleset')).toContain('data-status="done">done</span>');
    expect(stepOf(html, 'codeowners')).toContain('Code owners');
    expect(stepOf(html, 'codeowners')).toContain('data-status="check">check</span>');
    expect(stepOf(html, 'codeowners')).toContain('no CODEOWNERS file');
    expect(stepOf(html, 'labels')).toContain('data-status="done">done</span>');
    // The entry names, and where they are set.
    for (const role of ['author', 'reviewer', 'read'])
      expect(access).toContain(`<code>gitlab-pat/lab/${role}</code>`);
    expect(access).toContain('href="/system/credentials"');
    expect(visibleText(access)).toMatch(/optional/i);
    // The roles: Developer or Maintainer, nothing above, no sudo or admin_mode.
    const text = visibleText(html);
    expect(text).toContain('Developer');
    expect(text).toContain('never above Maintainer');
    expect(html).toContain('<code>sudo</code>');
    expect(html).toContain('<code>admin_mode</code>');
    // The doctor's fixes.
    expect(html).toContain('href="/system"');
    gitlabWordsOnly(html);
  });

  test('a starter zone is not judged on the reviewer and has no reviewer entry', () => {
    const zone = gl({ identity: 'starter' });
    const html = gitlabSection(
      zone,
      run([
        ['forge.author', 'pass', 'author ok'],
        ['forge.reviewer', 'fail', 'no reviewer token'],
        ['forge.private-clone', 'pass', 'public'],
      ]),
    );
    const access = stepOf(html, 'access');
    expect(access).toContain('data-status="done">done</span>');
    expect(access).not.toContain('no reviewer token');
    expect(access).toContain('<code>gitlab-pat/lab/author</code>');
    expect(access).toContain('<code>gitlab-pat/lab/read</code>');
    expect(access).not.toContain('gitlab-pat/lab/reviewer');
    gitlabWordsOnly(html);
  });

  test('with no doctor run every chip is not checked', () => {
    const html = gitlabSection(gl(), null);
    for (const step of ['access', 'ruleset', 'codeowners', 'labels'])
      expect(stepOf(html, step)).toContain('data-status="not-checked">not checked</span>');
    expect(html).not.toContain('data-status="done"');
    expect(html.split('data-status=').length - 1).toBe(4);
  });

  test('the Setup page shows it with no guidance read, and never a token or its fingerprint', async () => {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-glpage-'));
    const keyFile = join(dir, 'vault_key');
    const { writeFileSync } = await import('node:fs');
    const { randomBytes } = await import('node:crypto');
    writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const vault = openVault(keyFile, db);
    if (vault === 'disabled' || !vault) throw new Error('no vault');
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, undefined),
      env: { JM_JOIN_TOKEN: 'join-secret-value-7', JM_OPERATOR_TOKEN: TOKEN, JM_DEV_IMAGES: '1' },
      vault,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    const applied = store.apply(
      {
        dropZones: [
          {
            id: 'lab',
            repo: 'acme/widgets',
            forge: 'gitlab',
            gitlab: { baseUrl: 'https://gitlab.example.test' },
            gates: [{ name: 'test', run: 'npm test' }],
            image: 'jm-trooper:dev',
          },
        ],
      },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
    const planted = {
      'gitlab-pat/lab/author': glpat('A'),
      'gitlab-pat/lab/reviewer': glpat('R'),
      'gitlab-pat/lab/read': `gitlab+deploy-token-9:${['gldt', 'D'.repeat(20)].join('-')}`,
    };
    for (const [name, value] of Object.entries(planted)) vault.put(name, value, { now: t0 });
    const calls: string[] = [];
    const a = createApp({
      db,
      config: store,
      forgesFor: () => {
        throw new Error('no zone forge in this test');
      },
      now: () => t0,
      leaseWaitMs: 0,
      leasePollMs: 0,
      guidanceForge: (repo) => {
        calls.push(repo);
        return forgeFor()(repo, '');
      },
    });
    app = a;
    await setOperatorPassphrase(db, 'a long operator passphrase', t0);
    const s = operatorSession(db);
    doctorRun(db, [{ id: 'forge.author', status: 'pass', zoneId: 'lab', summary: 'author ok' }]);
    const r = await a.inject({
      method: 'GET',
      url: '/projects/lab/setup',
      headers: { host: HOST, cookie: s.cookie },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h3>GitLab</h3>');
    expect(r.body).toContain('<code>gitlab-pat/lab/author</code>');
    expect(calls).toEqual([]);
    for (const value of Object.values(planted)) {
      expect(r.body).not.toContain(value);
      expect(r.body).not.toContain(escapeHtml(value));
      expect(r.body).not.toContain(fingerprintOf(value));
    }
  });
});
