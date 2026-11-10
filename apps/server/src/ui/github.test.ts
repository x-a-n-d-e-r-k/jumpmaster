import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { GuidanceForge } from '../api/github.js';
import { createApp } from '../app.js';
import { setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { RESOURCE_OWNER_NOTE } from '../github/guidance.js';
import { MATRIX_AND_REUSABLE_NOTE } from '../github/workflows.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { escapeHtml } from './pages.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const AUTHOR = 'github_pat_PAGEAUTHORDUMMY01234567890';
const REVIEWER = 'github_pat_PAGEREVIEWERDUMMY0123456789';
const CLAUDE = 'sk-ant-oat01-PAGECLAUDEDUMMY0123456789';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A job name a workflow could carry: forge text, rendered escaped or not at all. */
const HOSTILE_JOB = '<img src=x onerror=alert(1)>';
const CI_YML = `on: pull_request\njobs:\n  test:\n    name: "${HOSTILE_JOB}"\n    runs-on: x\n`;

function forgeFor(o: { ownerType?: 'User' | 'Organization'; fail?: number } = {}) {
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
    listDir: async (_ref: string, path: string) => (path === '.github/workflows' ? ['ci.yml'] : []),
    getFileAt: async (_ref: string, path: string) =>
      path === '.github/workflows/ci.yml' ? CI_YML : null,
  });
}

async function world(o: { ownerType?: 'User' | 'Organization'; fail?: number } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-ghpage-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, undefined),
    env: {
      JM_CLAUDE_TOKEN: CLAUDE,
      JM_GITHUB_AUTHOR_TOKEN: AUTHOR,
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
        identity: 'two-bot',
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test' }],
        egress: { mode: 'monitor' },
      },
    },
  });
  if (added.statusCode !== 200) throw new Error(added.body);
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
    expect(html).toContain('two bot accounts');
    // What the zone runs as now, beside the recommendation.
    expect(html).toContain('This zone runs as two-bot');
    expect(html).toContain(RESOURCE_OWNER_NOTE);
    expect(html).toContain('Only select repositories');
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
    expect(links(html)).toContain(
      'https://github.com/octo-org/demo/new/main?filename=.github%2FCODEOWNERS',
    );
    // Forge text is escaped wherever it appears; no external link but GitHub's.
    expect(html).not.toContain(HOSTILE_JOB);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    for (const l of links(html).filter((l) => /^[a-z]+:/i.test(l)))
      expect(l.startsWith('https://github.com/') || l.startsWith('data:application/json'), l).toBe(
        true,
      );
    for (const secret of [AUTHOR, REVIEWER, CLAUDE, TOKEN]) expect(html).not.toContain(secret);
  });

  test('an unknown zone is 404; a refused read says why, escaped, and links the GitHub step', async () => {
    const w = await world({ fail: 401 });
    expect((await w.get('/zones/nope/github')).statusCode).toBe(404);
    const r = await w.get('/zones/demo/github');
    expect(r.statusCode).toBe(502);
    expect(r.body).toContain('GitHub rejected the author token (401)');
    expect(r.body).not.toContain('<b>');
    expect(r.body).toContain('href="/setup/forge"');
  });

  test('home and the doctor page link each zone’s GitHub page', async () => {
    const w = await world();
    expect((await w.get('/')).body).toContain('href="/zones/demo/github"');
    expect((await w.get('/doctor')).body).toContain('href="/zones/demo/github"');
  });
});
