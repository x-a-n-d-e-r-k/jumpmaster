import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { grantSudo, sha256Hex } from '../auth/sessions.js';
import { loadBoot, RESTART_PATHS } from '../config/boot.js';
import { flagRows } from '../config/catalog.js';
import { ConfigStore, startVault } from '../config/store.js';
import { openDb } from '../db/open.js';
import { insertDrop, recordUsageWindows, setZoneMode, upsertDropZone } from '../db/repo.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { gateSecretName } from '../vault/credentials.js';
import { appEntryName, serializeAppEntry } from '../vault/github-app-entries.js';
import { GITLAB_READ_BAD_VALUE } from '../vault/gitlab-pat-entries.js';
import { fingerprintOf, openVault, VAULT_KEY_IN_DATA_DIR } from '../vault/vault.js';
import { FLAGS_SCRIPT, renderFlagsForm } from './flags.js';
import { LIVE_MARKER } from './pages.js';
import { RESTART_NOTE } from './setting-controls.js';
import {
  CREDENTIALS_SCRIPT,
  HISTORY_SCRIPT,
  INSTALL_SCRIPT,
  MCP_TOKENS_SCRIPT,
  OTHER_MACHINES_SCRIPT,
  roleOf,
  TOKEN_BANNER_DAYS,
} from './settings.js';
import { CLAUDE_SAVED } from './setup.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const PASS = 'a long operator passphrase';
const CLAUDE = 'sk-ant-' + 'oat01-TABCLAUDEDUMMY0123456789';
const AUTHOR = 'github_pat_' + 'TABAUTHORDUMMY0123456789';
const REVIEWER = 'github_pat_' + 'TABREVIEWERFILEDUMMY0123456789';
const READ = 'github_pat_' + 'TABREADENVDUMMY0123456789';
const DAY = 86_400_000;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * An install with a vault, a secrets directory holding the reviewer token as a file, and one
 * two-bot zone on a private repository (so the missing read token is a zone problem).
 */
async function world(
  o: {
    env?: Record<string, string>;
    now?: Date;
    dbMode?: boolean;
    dbFile?: string;
    /** File mode: more keys in the config file. */
    file?: Record<string, unknown>;
    /** Db mode: a document applied with the token before the app starts. */
    doc?: Record<string, unknown>;
    /** The HTTP status GitHub refuses every credential test with. */
    forgeRefuses?: number;
    /** No JM_VAULT_KEY_FILE: the vault starts as the settings leave it (off, at first). */
    vaultOff?: boolean;
  } = {},
) {
  const dbFile = o.dbFile ?? tmpDbFile();
  const db = openDb(dbFile);
  const dir = mkdtempSync(join(tmpdir(), 'jm-tab-'));
  const secrets = join(dir, 'secrets');
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, 'github_reviewer_token'), `${REVIEWER}\n`, { mode: 0o600 });
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  // Db mode: no file (as compose starts an empty install); file mode: a zone in the file.
  if (!o.dbMode)
    writeFileSync(
      filePath,
      JSON.stringify({
        dataDir: './data',
        dropZones: [
          {
            id: 'main',
            repo: 'octo/demo',
            gates: [{ name: 'test', run: 'npm test' }],
            image: 'jm-trooper:dev',
            reviewReadToken: true,
          },
        ],
        ...o.file,
      }),
    );
  const env = {
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
    JM_SECRETS_DIR: secrets,
    ...o.env,
  };
  let clock = o.now ?? t0;
  const store = ConfigStore.open({
    db,
    boot: loadBoot(env, filePath),
    filePath,
    env,
    vault: o.vaultOff ? startVault(env, db) : openVault(keyFile, db),
    now: () => clock,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  if (o.doc) {
    const r = store.apply(o.doc, { via: 'ctl', principal: BEARER });
    if (!r.ok) throw new Error(`the fixture document was refused: ${JSON.stringify(r)}`);
  }
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no zone forge in this test');
    },
    now: () => clock,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    credentialForge: () => ({
      viewerLogin: async () => {
        if (o.forgeRefuses)
          throw Object.assign(new Error('Bad credentials'), { status: o.forgeRefuses });
        return 'octo-<author>';
      },
      repoAccess: async () => ({}),
    }),
    // What GitHub says of a repository the Credentials tab's guide names: an organization's,
    // public, read without a token (#374).
    guidanceForge: () => ({
      repoAccess: async () => ({
        private: false,
        defaultBranch: 'main',
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
        scopes: null,
        tokenExpiresAt: null,
        ownerType: 'Organization' as const,
      }),
      ownerType: async () => 'Organization' as const,
      viewerLogin: async () => 'octo-bot',
      listDir: async () => [],
      getFileAt: async () => null,
    }),
  });
  app = a;
  await setOperatorPassphrase(db, PASS, clock);
  let s = operatorSession(db, clock);
  const browser = () => ({ host: HOST, cookie: s.cookie });
  const api = () => ({ host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf });
  return {
    db,
    dbFile,
    store,
    secrets,
    /** A sudo grant for the page's session (as `POST /api/control/sudo` gives). */
    sudo: () => grantSudo(db, sha256Hex(s.id), clock),
    /** Moves the clock; the operator logs in again (a session idles out after 12 hours). */
    at(d: Date) {
      clock = d;
      s = operatorSession(db, clock);
    },
    get: (url: string) => a.inject({ method: 'GET', url, headers: browser() }),
    /** A GET with no session. */
    anon: (url: string) => a.inject({ method: 'GET', url, headers: { host: HOST } }),
    call: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body: unknown) =>
      a.inject({ method, url, headers: api(), payload: body as object }),
    /** `ctl`: the operator token. */
    token: (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
      a.inject({
        method,
        url,
        headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
        ...(body === undefined ? {} : { payload: body as object }),
      }),
  };
}

const BEARER = { kind: 'operator', via: 'token', sudo: true } as const;
const ZONE = {
  id: 'main',
  repo: 'octo/demo',
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
};

/** The row of one credential, from `<tr data-credential="name">` to its `</tr>`. */
const rowOf = (html: string, name: string): string => {
  const at = html.indexOf(`<tr data-credential="${name}"`);
  if (at < 0) throw new Error(`no row for ${name}`);
  return html.slice(at, html.indexOf('</tr>', at));
};

describe('the credentials tab', () => {
  test('the credentials page shows source and path, fingerprint, login and dates for each credential, and no value; the zone problems are on Health', async () => {
    const w = await world();
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    const claude = await w.call('PUT', '/api/control/secrets/claudeToken', {
      value: CLAUDE,
      declaredCreatedAt: '2025-12-01',
    });
    expect(claude.statusCode, claude.body).toBe(200);
    expect(
      (await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR })).statusCode,
    ).toBe(200);
    const r = await w.get('/system/credentials');
    expect(r.statusCode).toBe(200);
    const html = r.body;
    // The System sub-nav (#623), Credentials current.
    expect(html).toContain('<nav class="subnav" aria-label="System">');
    expect(html).toContain('<a href="/system/credentials" aria-current="page">Credentials</a>');

    const c = rowOf(html, 'claudeToken');
    expect(c).toContain('Claude token (claude setup-token)');
    expect(c).toContain('vault');
    expect(c).toContain(`<code>${fingerprintOf(CLAUDE)}</code>`);
    expect(c).toContain(t0.toISOString().slice(0, 10)); // set at
    expect(c).toContain('2025-12-01'); // created at, as declared
    // The last test and its result, as the route recorded it on entry.
    expect(c).toContain(
      `<td data-col="test">shape ok: the doctor drop is the live proof <small>${t0.toISOString().slice(0, 10)}`,
    );

    const author = rowOf(html, 'githubAuthorToken');
    expect(author).toContain(`<code>${fingerprintOf(AUTHOR)}</code>`);
    // A login is GitHub's text: escaped.
    expect(author).toContain('<td data-col="login">octo-&lt;author&gt;</td>');
    expect(author).not.toContain('octo-<author>');

    const reviewer = rowOf(html, 'githubReviewerToken');
    expect(reviewer).toContain('file');
    expect(reviewer).toContain(join(w.secrets, 'github_reviewer_token'));
    expect(reviewer).toContain(`<code>${fingerprintOf(REVIEWER)}</code>`);

    expect(rowOf(html, 'githubReadToken')).toMatch(/not set/);

    // Every zone's credential problems, with their messages: on Health once, not here (#623).
    const problems = w.store.problems();
    expect(problems.some((p) => p.credential === 'githubReadToken')).toBe(true);
    const health = (await w.get('/system')).body;
    const count = (h: string, s: string) => h.split(s).length - 1;
    expect(count(health, '<h3>Project problems</h3>')).toBe(1);
    expect(count(html, 'Project problems')).toBe(0);
    expect(html).not.toContain('<ul class="problems">');
    for (const p of problems) {
      const message = p.message.replaceAll("'", '&#39;');
      expect(health).toContain(message);
      expect(count(health, `${message}</li>`)).toBe(1);
    }
    // Each problem names its zone by repository (#99).
    expect(health).toContain('<li><strong>octo/demo</strong> (');
    // Above the check table.
    const table = health.indexOf('<th>Status</th>');
    if (table !== -1) expect(health.indexOf('<h3>Project problems</h3>')).toBeLessThan(table);

    for (const secret of [CLAUDE, AUTHOR, REVIEWER, TOKEN, 'join-secret-value-4'])
      expect(html).not.toContain(secret);
  });

  test('Replace is disabled with the managed-by text for a file credential, and for a vault one opens a sudo prompt and PUTs the value only in the body', async () => {
    const w = await world({ env: { JM_GITHUB_READ_TOKEN: READ } });
    const html = (await w.get('/system/credentials')).body;
    // File and environment credentials: read-only, with where they come from and how to change it.
    // A variable or file credential is never a dead button: Replace moves credentials to the vault.
    const reviewer = rowOf(html, 'githubReviewerToken');
    expect(reviewer).not.toMatch(/<button[^>]*disabled[^>]*>Replace<\/button>/);
    expect(reviewer).toContain(
      '<button type="button" class="use-vault" data-name="githubReviewerToken">Replace</button>',
    );
    expect(reviewer).toContain(
      `managed by ${join(w.secrets, 'github_reviewer_token')}: replace that file and run <code>jumpmaster ctl secrets reload</code>`,
    );
    expect(reviewer).not.toContain('type="password"');
    expect(reviewer).not.toContain('class="remove"');
    const read = rowOf(html, 'githubReadToken');
    expect(read).not.toMatch(/<button[^>]*disabled[^>]*>Replace<\/button>/);
    expect(read).toContain(
      '<button type="button" class="use-vault" data-name="githubReadToken">Replace</button>',
    );
    expect(read).toContain('set by the environment variable JM_GITHUB_READ_TOKEN');
    // Its click turns the vault on (if off) and prefers it, then reloads to show the Replace form.
    expect(html).toContain("querySelectorAll('button.use-vault')");
    expect(html).toMatch(/use-vault[\s\S]*\/api\/control\/secrets\/vault\/prefer/);
    expect(html).not.toContain(READ);
    // A credential the vault can hold: a password field, never prefilled, and the Claude date.
    const claude = rowOf(html, 'claudeToken');
    expect(claude).toMatch(
      /<form class="replace" data-name="claudeToken">.*<input type="password" name="value" autocomplete="off"/,
    );
    expect(claude).not.toMatch(/name="value"[^>]* value=/);
    expect(claude).toContain('name="declaredCreatedAt"');
    // A session without sudo is asked for the passphrase first.
    expect(html).toContain('data-sudo="0"');
    expect(html).toContain('id="sudo-prompt" hidden');
    expect(html).toContain(CREDENTIALS_SCRIPT);
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    expect((await w.get('/system/credentials')).body).toContain('data-sudo="1"');

    // The browser path, without a browser: the script's replace, on a stub fetch.
    const prompted = await runReplace({ name: 'claudeToken', value: CLAUDE, sudo: false });
    expect(prompted.result).toBe('sudo');
    expect(prompted.calls).toEqual([]);
    const done = await runReplace({
      name: 'claudeToken',
      value: CLAUDE,
      declaredCreatedAt: '2026-01-01',
      sudo: false,
      passphrase: PASS,
    });
    expect(done.result).toBe('saved');
    expect(done.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/control/sudo',
      'PUT /api/control/secrets/claudeToken',
    ]);
    expect(done.calls[1]?.body).toEqual({ value: CLAUDE, declaredCreatedAt: '2026-01-01' });
    for (const c of done.calls) expect(c.path).not.toContain(CLAUDE);
    // The running-drops line comes back from the route and is shown.
    expect(done.status).toContain('2 running drops still carry the previous token');
    // Sudo already held: no prompt, one PUT.
    const held = await runReplace({ name: 'githubAuthorToken', value: AUTHOR, sudo: true });
    expect(held.calls.map((c) => c.method)).toEqual(['PUT']);
    // Test and remove go through the same routes, after sudo.
    const tested = await runAction('test', 'claudeToken');
    expect(tested.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/control/secrets/claudeToken/test',
    ]);
    const removed = await runAction('remove', 'claudeToken');
    expect(removed.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /api/control/secrets/claudeToken',
    ]);
  });

  test('a refused test (401) of an environment or file credential says where to change it and to restart, without the value', async () => {
    const w = await world({ env: { JM_GITHUB_READ_TOKEN: READ }, forgeRefuses: 401 });
    // The page's script, its fetch answered by the real route.
    const ctx = vm.createContext({
      document: { addEventListener: () => {}, querySelectorAll: () => [] },
      encodeURIComponent,
      jmFetch: async (path: string, body: unknown, method?: string) => {
        const r = await w.call((method ?? 'POST') as 'POST', path, body);
        return { ok: r.statusCode < 300, status: r.statusCode, json: async () => r.json() };
      },
    });
    vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
    const testOf = async (name: string) => {
      const status = stubStatus();
      const fn = ctx.jmTestCredential as (...a: unknown[]) => Promise<string>;
      const result = await fn(name, { sudo: false, passphrase: PASS }, status);
      return { result, text: status.textContent };
    };
    const env = await testOf('githubReadToken');
    expect(env.result).toBe('failed');
    expect(env.text).toBe(
      "githubReadToken: GitHub rejected this token (401): it is expired, revoked or mistyped. It comes from the environment variable JM_GITHUB_READ_TOKEN: make a new token on GitHub, set JM_GITHUB_READ_TOKEN to it where the server's environment is set, and restart the server.",
    );
    const file = await testOf('githubReviewerToken');
    expect(file.text).toBe(
      `githubReviewerToken: GitHub rejected this token (401): it is expired, revoked or mistyped. It is read from the file ${join(w.secrets, 'github_reviewer_token')}: make a new token on GitHub, replace the file's contents with it, and restart the server.`,
    );
    for (const t of [env.text, file.text]) {
      expect(t).not.toContain(READ);
      expect(t).not.toContain(REVIEWER);
      expect(t).not.toContain('/api/');
    }
  });

  test('a Claude token past day 330 shows the expiry banner on the tab and on home', async () => {
    expect(TOKEN_BANNER_DAYS).toBe(330);
    const banner = /class="warn token-age"/;
    // Db mode: a vault token's "Made on" dates it (in file mode the file's claude.tokenCreatedAt
    // does, for the doctor and this banner alike).
    const w = await world({ dbMode: true });
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    const made = new Date(t0.getTime() - 331 * DAY).toISOString().slice(0, 10);
    expect(
      (
        await w.call('PUT', '/api/control/secrets/claudeToken', {
          value: CLAUDE,
          declaredCreatedAt: made,
        })
      ).statusCode,
    ).toBe(200);
    for (const url of ['/system/credentials', '/']) {
      const body = (await w.get(url)).body;
      expect(body, url).toMatch(banner);
      expect(body, url).toContain('The Claude token is 331 days old');
      expect(body, url).toContain('href="/system/credentials"');
    }
    // Past its year: the banner says it has expired.
    w.at(plus(t0, 40 * DAY));
    expect((await w.get('/')).body).toContain('past its one-year life');
    // A young token: no banner anywhere.
    const fresh = await world({ dbMode: true });
    await fresh.call('POST', '/api/control/sudo', { passphrase: PASS });
    await fresh.call('PUT', '/api/control/secrets/claudeToken', {
      value: CLAUDE,
      declaredCreatedAt: new Date(t0.getTime() - 329 * DAY).toISOString().slice(0, 10),
    });
    for (const url of ['/system/credentials', '/'])
      expect((await fresh.get(url)).body, url).not.toMatch(banner);
  });

  test('/settings is a 301 to System, Credentials (#623); home links System', async () => {
    const w = await world();
    const r = await w.get('/settings');
    expect(r.statusCode).toBe(301);
    expect(r.headers.location).toBe('/system/credentials');
    // Home links to it.
    expect((await w.get('/')).body).toContain('<a href="/system" data-area="system">System</a>');
  });

  test("the wizard's Claude and forge controls are here: the plan, the token date, the repository recommendation and its token links", async () => {
    const w = await world();
    const html = (await w.get('/system/credentials')).body;
    // The Claude plan (file mode: shown where it is set).
    expect(html).toMatch(/Plan <strong>pro<\/strong> \(set in the config file\)/);
    // The recommendation form, reading GitHub without writing.
    expect(html).toContain('<form method="get" action="/system/credentials" id="recommend-form">');
  });
});

describe('creating the GitHub Apps from the Credentials tab (#374, spec §4.1)', () => {
  const CLIENT_ID = 'Iv23liSettingsTab01';

  test('a two-bot guide shows the create forms, wired to ask for the passphrase without sudo', async () => {
    const w = await world();
    const r = await w.get('/system/credentials?repo=acme%2Fdemo');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('GitHub Apps (recommended for two bots)');
    const forms =
      r.body.match(/<form method="post" action="\/setup\/github-app\/start"[^>]*>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const f of forms) expect(f).toContain('data-sudo-first');
    expect(r.body).toContain('<input type="hidden" name="owner" value="acme">');
    expect(r.body).toContain('<input type="hidden" name="ownerType" value="Organization">');
    expect(r.body).toContain('needs an owner or app manager of that organization');
    // The page's sudo mechanism answers the hook.
    expect(r.body).toContain('form.app-create[data-sudo-first]');
    expect(r.body).toContain('id="sudo-prompt"');
    w.sudo();
    const held = await w.get('/system/credentials?repo=acme%2Fdemo');
    expect(held.body).not.toMatch(/action="\/setup\/github-app\/start"[^>]*data-sudo-first/);
  });

  test("an app entry for the guide's owner in the vault shows its slug, never its PEM or client id", async () => {
    const w = await world();
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('expected a vault');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const pemLines = pem.split('\n').filter((l) => l !== '' && !l.startsWith('-----'));
    vault.put(
      appEntryName('acme', 'author'),
      serializeAppEntry({
        appId: '77',
        slug: 'jm-author-acme',
        clientId: CLIENT_ID,
        pem,
        importedAt: '2026-11-15T10:00:00.000Z',
      }),
      { now: t0 },
    );
    const r = await w.get('/system/credentials?repo=Acme%2Fdemo');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Created: <code>jm-author-acme</code>');
    expect(r.body).toContain('https://github.com/apps/jm-author-acme/installations/new');
    expect(r.body).not.toContain('Create the author app');
    expect(r.body).toContain('Create the reviewer app');
    expect(r.body).not.toContain(CLIENT_ID);
    expect(r.body).not.toContain('PRIVATE KEY');
    for (const l of pemLines) expect(r.body).not.toContain(l);
  });

  test('a broken entry file counts as none: the page renders 200 with the button', async () => {
    const w = await world();
    mkdirSync(join(w.secrets, 'github-app', 'acme'), { recursive: true });
    writeFileSync(join(w.secrets, 'github-app', 'acme', 'author.json'), '{ broken', {
      mode: 0o644,
    });
    const r = await w.get('/system/credentials?repo=acme%2Fdemo');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Create the author app');
    expect(r.body).not.toContain('{ broken');
  });

  test('the vault off: no buttons, a link to turn it on, and the token links as before', async () => {
    const w = await world({ vaultOff: true });
    const r = await w.get('/system/credentials?repo=acme%2Fdemo');
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('/setup/github-app/start');
    expect(r.body).toContain('The vault must be on first');
    expect(r.body).toContain('id="tokens"');
  });
});

describe('the credentials tab, round 2', () => {
  test('Replace with an empty field says to enter a token first, inline, and sends nothing', async () => {
    const empty = await runReplace({ name: 'claudeToken', value: '', sudo: true });
    expect(empty.result).toBe('empty');
    expect(empty.status).toBe('Enter a token first.');
    expect(empty.calls).toEqual([]);
    // Inline: each Replace form carries its own status beside the button.
    const w = await world();
    const claude = rowOf((await w.get('/system/credentials')).body, 'claudeToken');
    expect(claude).toMatch(
      /<button>Replace<\/button> <span class="replace-out" role="status"><\/span><\/form>/,
    );
  });

  test('a file-mode install dates a vault Claude token by the vault: the row and the banner agree', async () => {
    const w = await world(); // file mode: the zone is in the config file
    expect(w.store.mode()).toBe('file');
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    const made = new Date(t0.getTime() - 331 * DAY).toISOString().slice(0, 10);
    await w.call('PUT', '/api/control/secrets/claudeToken', {
      value: CLAUDE,
      declaredCreatedAt: made,
    });
    const tab = (await w.get('/system/credentials')).body;
    expect(rowOf(tab, 'claudeToken')).toContain(`<td data-col="created">${made}</td>`);
    for (const body of [tab, (await w.get('/')).body])
      expect(body).toContain('The Claude token is 331 days old');
  });

  test('the Remove dialog says the removal is refused while a zone needs the credential', () => {
    expect(CREDENTIALS_SCRIPT).toContain(
      'Jumpmaster refuses to remove it while a project still needs it',
    );
    expect(CREDENTIALS_SCRIPT).not.toMatch(/park until/);
  });

  test('an undecryptable vault entry can be removed', async () => {
    const first = await world({ dbMode: true });
    await first.call('POST', '/api/control/sudo', { passphrase: PASS });
    await first.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
    // The same database under another vault key: the stored value no longer decrypts.
    const w = await world({ dbMode: true, dbFile: first.dbFile });
    const row = rowOf((await w.get('/system/credentials')).body, 'claudeToken');
    expect(row).toContain('does not decrypt');
    expect(row).toContain(
      '<button type="button" class="remove" data-name="claudeToken">Remove</button>',
    );
  });

  test('no running-drops line when no drop carries the old value; Test and Replace both offer a refresh', async () => {
    const none = await runReplace({ name: 'claudeToken', value: CLAUDE, sudo: true, running: 0 });
    // Nothing contacted Claude: the answer says what was checked, never "tested" (#161).
    expect(none.status).toBe(CLAUDE_SAVED);
    const github = await runReplace({
      name: 'githubAuthorToken',
      value: 'github_pat_' + 'SETTINGSDUMMY0123456789',
      sudo: true,
      running: 0,
    });
    expect(github.status).toBe('Saved and tested.');
    expect(none.appended).toContain('Refresh the list');
    const some = await runReplace({ name: 'claudeToken', value: CLAUDE, sudo: true, running: 2 });
    expect(some.status).toContain('2 running drops still carry the previous token');
    const tested = await runAction('test', 'claudeToken');
    expect(tested.result).toBe('ok');
    expect(tested.appended).toContain('<a href="/system/credentials">Refresh the list</a>');
  });
});

/** The row of one install setting, from `<tr data-setting="path">` to its `</tr>`. */
const settingRow = (html: string, path: string): string => {
  const at = html.indexOf(`<tr data-setting="${path}"`);
  if (at < 0) throw new Error(`no row for ${path}`);
  return html.slice(at, html.indexOf('</tr>', at));
};

describe('the ultra plan (#144)', () => {
  test('both plan lists offer Ultra ($200/mo); choosing it is saved and shown selected on reload', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    for (const url of ['/system/credentials', '/system/server']) {
      const html = (await w.get(url)).body;
      expect(html, url).toMatch(/<option value="ultra"[^>]*>Ultra \(\$200\/mo\)<\/option>/);
      // The other plans have prose labels too (#161).
      expect(html, url).toMatch(/<option value="max"[^>]*>Max \(\$100\/mo\)<\/option>/);
    }
    const r = await w.call('PATCH', '/api/control/config', {
      patch: { claude: { plan: 'ultra' } },
      expectRevision: w.store.revision(),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.current().claude.plan).toBe('ultra');
    for (const url of ['/system/credentials', '/system/server'])
      expect((await w.get(url)).body, url).toMatch(/<option value="ultra" selected>/);
    // The floor follows the saved plan: no 5-hour meter, Fable's and Opus's windows as stored.
    recordUsageWindows(
      w.db,
      { seven_day_fable: { utilization: 0.42 }, seven_day_opus: { utilization: 0.3 } },
      t0,
      null,
    );
    const floor = (await w.get('/')).body;
    expect(floor).not.toContain('<span>5-hour</span>');
    expect(floor).toMatch(/<span>Fable \(7-day\)<\/span><b>42%<\/b>/);
    expect(floor).toMatch(/<span>Opus \(7-day\)<\/span><b>30%<\/b>/);
  });
});

describe('settings, part two (Task 13)', () => {
  test('the install tab marks mcp.enabled as restart-needed, shows the boot settings read-only with their source, and applies the rest live', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const r = await w.get('/system/server');
    expect(r.statusCode).toBe(200);
    const html = r.body;
    // Not a live page (#404): only the Floor and the briefings refresh themselves.
    expect(html).not.toContain(LIVE_MARKER);
    // The System sub-nav, Server current (#623).
    expect(html).toContain('<a href="/system/server" aria-current="page">Server</a>');
    for (const tab of ['credentials', 'mcp-tokens', 'history'])
      expect(html).toContain(`<a href="/system/${tab}">`);

    // mcp.enabled (and the body limit) only apply at the next start: said beside each.
    expect(settingRow(html, 'mcp.enabled')).toContain('takes effect at the next restart');
    expect(settingRow(html, 'mcp.maxBodyBytes')).toContain('takes effect at the next restart');
    expect(settingRow(html, 'pollSeconds')).not.toContain('restart');
    expect(settingRow(html, 'claude.fableWeeklyDropCap')).toContain('0 = no limit');
    // #605: the Fable model is for every Fable role, reviews included; the review controls sit beside it.
    expect(settingRow(html, 'claude.fableModel')).not.toContain('the Fable reviewer');
    expect(settingRow(html, 'claude.fableReview')).toContain('checked');
    expect(settingRow(html, 'claude.fableReviewMaxUtilization')).toContain('value="0.5"');
    for (const path of [
      'pollSeconds',
      'usage.throttleUtilization',
      'usage.stopOnOverage',
      'claude.plan',
      'claude.fableModel',
      'claude.fableWeeklyDropCap',
      'claude.fableMaxUtilization',
      'claude.fableReview',
      'claude.fableReviewMaxUtilization',
      'requireSignedImages',
      'mcp.writesPerHour',
      'mcp.callsPerHour',
      'mcp.maxOpenBriefings',
    ])
      expect(settingRow(html, path)).toContain(`data-path="${path}"`);

    // Boot settings: values and where each is set (db mode: the environment), never an input.
    const boot = html.slice(html.indexOf('<h3>Boot settings</h3>'));
    expect(boot).toContain('127.0.0.1');
    expect(boot).toContain('./data');
    for (const name of [
      'JM_LISTEN_HOST',
      'JM_LISTEN_PORT',
      'JM_ALLOWED_HOSTS',
      'JM_TLS_TERMINATED',
      'JM_DATA_DIR',
    ])
      expect(boot).toContain(name);
    expect(html).not.toMatch(/data-path="(listen|dataDir)/);
    expect(html).not.toContain('restart-pending');

    // A session's change applies live: the next pass reads it, no restart.
    const live = await w.call('PATCH', '/api/control/config', {
      patch: { pollSeconds: 30 },
      expectRevision: w.store.revision(),
    });
    expect(live.statusCode, live.body).toBe(200);
    expect(live.json()).toMatchObject({ restartNeeded: [] });
    expect(w.store.current().pollSeconds).toBe(30);
    // mcp.enabled from ctl: accepted, then the tab carries the restart-pending badge.
    const mcp = await w.token('PATCH', '/api/control/config', {
      patch: { mcp: { enabled: true } },
      expectRevision: w.store.revision(),
    });
    expect(mcp.json()).toMatchObject({ restartNeeded: ['mcp.enabled'] });
    const after = (await w.get('/system/server')).body;
    expect(after).toMatch(/class="warn restart-pending"[^>]*>.*Restart pending.*mcp\.enabled/s);
    expect(after).toContain('docker compose restart jumpmaster');

    // The page's save: only what changed, conditional on the revision drawn, back to this tab.
    const { ctx, calls } = pageScript(INSTALL_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const patch = (ctx.jmInstallPatch as (f: unknown[]) => unknown)([
      { path: 'pollSeconds', kind: 'number', value: '45', original: 30 },
      { path: 'usage.throttleUtilization', kind: 'number', value: '0.9', original: 0.9 },
      { path: 'claude.fableModel', kind: 'text', value: '', original: null },
      { path: 'claude.plan', kind: 'select', value: 'max', original: 'pro' },
      { path: 'mcp.callsPerHour', kind: 'number', value: '120', original: 120 },
    ]);
    expect(patch).toEqual({ pollSeconds: 45, claude: { plan: 'max' } });
    const out = stubStatus();
    const saved = await (ctx.jmSaveInstall as (...a: unknown[]) => Promise<string>)(
      patch,
      7,
      out,
      () => {},
    );
    expect(saved).toBe('saved');
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/control/config',
        body: {
          patch: { pollSeconds: 45, claude: { plan: 'max' } },
          expectRevision: 7,
          returnTo: '/system/server',
          cancelTo: '/system/server',
        },
      },
    ]);
    const none = await (ctx.jmSaveInstall as (...a: unknown[]) => Promise<string>)(
      {},
      7,
      out,
      () => {},
    );
    expect(none).toBe('unchanged');
    expect(calls).toHaveLength(1);

    // File mode: every value read-only where the file sets it, with the reader's warnings.
    const f = await world({ file: { pollSeconds: 1 } });
    const file = (await f.get('/system/server')).body;
    expect(file).toContain('set in the config file');
    expect(file).toMatch(/<fieldset disabled>/);
    expect(file).toContain('pollSeconds 1 is outside 5..86400: running with 5; set it in range');
    expect(file.slice(file.indexOf('<h3>Boot settings</h3>'))).toContain(
      join(f.secrets, '..', 'jumpmaster.config.json'),
    );
    for (const secret of [TOKEN, 'join-secret-value-4', REVIEWER]) {
      expect(html).not.toContain(secret);
      expect(file).not.toContain(secret);
    }
  });

  test('requireSignedImages weakening is offered only as the ctl-or-file note, and stopOnOverage to false goes to the confirmation page', async () => {
    const w = await world({ dbMode: true, doc: { requireSignedImages: true } });
    const html = (await w.get('/system/server')).body;
    const signed = settingRow(html, 'requireSignedImages');
    // On, and not a control a session can turn off: the note says where it is turned off.
    expect(signed).toMatch(
      /<input type="checkbox" id="setting-requireSignedImages" data-path="requireSignedImages"[^>]* checked disabled>/,
    );
    expect(signed).toContain(
      'to turn it off, set with <code>jumpmaster ctl</code> or in the config file',
    );
    // The guarded ones say they ask first.
    expect(settingRow(html, 'usage.stopOnOverage')).toContain(
      'turning it off asks for confirmation',
    );
    expect(settingRow(html, 'mcp.enabled')).toContain('turning it on asks for confirmation');

    // The route agrees: a session may never weaken it.
    const weaken = await w.call('PATCH', '/api/control/config', {
      patch: { requireSignedImages: false },
      expectRevision: w.store.revision(),
    });
    expect(weaken.statusCode).toBe(403);
    expect(weaken.json()).toMatchObject({ sessionForbidden: ['requireSignedImages'] });
    // stopOnOverage to false: held for the confirmation page, which then returns to this tab.
    const stop = await w.call('PATCH', '/api/control/config', {
      patch: { usage: { stopOnOverage: false } },
      expectRevision: w.store.revision(),
      returnTo: '/system/server',
      cancelTo: '/system/server',
    });
    expect(stop.statusCode).toBe(409);
    const j = stop.json() as { needsConfirmation: boolean; confirm: string };
    expect(j.needsConfirmation).toBe(true);
    const confirm = await w.get(j.confirm);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('Dispatch will continue on usage credits');
    expect(confirm.body).toContain('<a href="/system/server">Cancel</a>');
    expect(w.store.current().usage.stopOnOverage).not.toBe(false);

    // The page follows the route's answer: to the confirmation page, or the ctl-or-file note.
    let went = '';
    const held = pageScript(INSTALL_SCRIPT, () => ({
      ok: false,
      status: 409,
      json: { needsConfirmation: true, confirm: '/config/confirm/abc' },
    }));
    const r1 = await (held.ctx.jmSaveInstall as (...a: unknown[]) => Promise<string>)(
      { usage: { stopOnOverage: false } },
      3,
      stubStatus(),
      (to: string) => {
        went = to;
      },
    );
    expect([r1, went]).toEqual(['confirm', '/config/confirm/abc']);
    const forbidden = pageScript(INSTALL_SCRIPT, () => ({
      ok: false,
      status: 403,
      json: { sessionForbidden: ['requireSignedImages'] },
    }));
    const out = stubStatus();
    const r2 = await (forbidden.ctx.jmSaveInstall as (...a: unknown[]) => Promise<string>)(
      { requireSignedImages: false },
      3,
      out,
      () => {},
    );
    expect(r2).toBe('forbidden');
    expect(out.textContent).toContain('set with jumpmaster ctl or in the config file');
  });

  test('the MCP tokens tab mints a token shown once, lists tokens without values and revokes one', async () => {
    const w = await world({ dbMode: true, doc: { mcp: { enabled: true }, dropZones: [ZONE] } });
    const first = await w.token('POST', '/api/control/mcp-tokens', {
      zoneId: 'main',
      scope: 'write',
      days: 30,
      label: 'laptop <one>',
    });
    expect(first.statusCode).toBe(200);
    const value = (first.json() as { token: string }).token;
    const html = (await w.get('/system/mcp-tokens')).body;
    expect(html).toContain('<a href="/system/mcp-tokens" aria-current="page">MCP tokens</a>');
    // The mint form: the zone, the scope, the days (1 to 90) and a label.
    expect(html).toMatch(/<form id="mint">/);
    // The zone is named by its repository; the value sent stays the id (#99).
    expect(html).toContain('<option value="main">octo/demo</option>');
    expect(html).toMatch(
      /<select name="scope"><option value="read"[^>]*>read<\/option><option value="write">/,
    );
    expect(html).toMatch(/<input type="number" name="days" min="1" max="90"/);
    expect(html).toContain('data-sudo="0"');
    // The list: id, zone, scope, label (escaped), dates, and Revoke; never the value or its hash.
    const row = html.slice(html.indexOf('<tr data-token="1"'));
    expect(row).toContain('<td>1</td><td>octo/demo</td>');
    expect(html).toContain('data-zones="{&quot;main&quot;:&quot;octo/demo&quot;}"');
    expect(row).toContain('laptop &lt;one&gt;');
    expect(row).toContain('<button type="button" class="revoke" data-id="1">Revoke</button>');
    expect(html).not.toContain(value);
    expect(html).not.toMatch(/token_hash|tokenHash/);

    // The script: no sudo and no passphrase asks for it and sends nothing.
    const s = mcpScript();
    const out = stubStatus();
    const reveal = { textContent: '', hidden: true };
    const c = { zoneId: 'main', zoneName: 'octo/demo', scope: 'read', days: '7', label: '' };
    expect(
      await (s.ctx.jmMintToken as (...a: unknown[]) => Promise<string>)(
        c,
        { sudo: false, passphrase: '' },
        out,
        reveal,
      ),
    ).toBe('sudo');
    expect(s.calls).toEqual([]);
    expect(reveal.textContent).toBe('');
    // With the passphrase: sudo first, then the mint; the value is shown once, in its own element.
    const done = await (s.ctx.jmMintToken as (...a: unknown[]) => Promise<string>)(
      c,
      { sudo: false, passphrase: PASS },
      out,
      reveal,
    );
    expect(done).toBe('minted');
    expect(s.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /api/control/sudo',
      'POST /api/control/mcp-tokens',
    ]);
    expect(s.calls[1]?.body).toEqual({ zoneId: 'main', scope: 'read', days: 7 });
    expect(reveal).toEqual({ textContent: 'jmm_shownonce', hidden: false });
    expect(out.textContent).toContain('shown this once');
    expect(out.textContent).toContain('Token 2 for octo/demo (read)');
    // Revoke: one DELETE, no sudo needed (it shows nothing).
    const revoked = await (s.ctx.jmRevokeToken as (...a: unknown[]) => Promise<string>)(
      '1',
      stubStatus(),
    );
    expect(revoked).toBe('revoked');
    expect(s.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/control/mcp-tokens/1' });

    // Through the real routes: a session mints after sudo, and revokes.
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    const minted = await w.call('POST', '/api/control/mcp-tokens', {
      zoneId: 'main',
      scope: 'read',
      days: 7,
    });
    expect(minted.statusCode).toBe(200);
    expect((await w.call('DELETE', '/api/control/mcp-tokens/1', {})).statusCode).toBe(200);
    const listed = (await w.get('/system/mcp-tokens')).body;
    expect(listed).toContain('data-sudo="1"');
    expect(listed.slice(listed.indexOf('<tr data-token="1"'))).toMatch(/revoked/);
    expect(listed).not.toContain((minted.json() as { token: string }).token);

    // With the MCP server off, the tab says how to turn it on instead.
    const off = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const offHtml = (await off.get('/system/mcp-tokens')).body;
    expect(offHtml).toContain('<a href="/system/server">');
    expect(offHtml).not.toContain('<form id="mint">');
  });

  test('history lists revisions with their changes, guarded and re-add marks, and Revert posts a rollback with the id', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const added = w.store.revision();
    expect(
      (
        await w.token('PATCH', '/api/control/config', {
          patch: { pollSeconds: 30 },
          expectRevision: added,
        })
      ).statusCode,
    ).toBe(200);
    const poll = w.store.revision();
    // The zone has history, is drained in observe, and is removed.
    upsertDropZone(w.db, {
      id: 'main',
      repo: 'octo/demo',
      defaultBranch: 'main',
      configJson: '{}',
    });
    insertDrop(w.db, {
      id: 'h1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'doctor',
      state: 'succeeded',
      createdAt: t0.toISOString(),
    });
    setZoneMode(w.db, 'main', 'observe', t0);
    expect((await w.token('DELETE', '/api/control/zones/main')).statusCode).toBe(200);
    const removed = w.store.revision();

    const html = (await w.get('/system/history')).body;
    expect(html).toContain('<a href="/system/history" aria-current="page">History</a>');
    const rev = (id: number) => rowIn(html, id);
    // Its changes, path by path; the zone add was guarded (its code runs with the Claude token).
    expect(rev(poll)).toContain('pollSeconds');
    expect(rev(poll)).not.toContain('class="mark guarded"');
    expect(rev(added)).toContain('class="mark guarded"');
    expect(rev(removed)).toContain('remove project main');
    // Reverting to the revision that held the zone re-adds it: said on the button before it runs.
    expect(rev(added)).toMatch(
      /<button type="button" class="revert" data-id="\d+" data-readds="\[&quot;main&quot;\]">Revert<\/button>/,
    );
    expect(rev(added)).toContain('re-adds project main');
    // The current revision has no Revert.
    expect(rev(removed)).not.toContain('class="revert"');

    // From a session this re-add sets a zone's image, which a session never does: refused, with
    // where to do it (the page says the same).
    const back = await w.call('POST', '/api/control/config/rollback', {
      id: added,
      expectRevision: removed,
      returnTo: '/system/history',
      cancelTo: '/system/history',
    });
    expect(back.statusCode).toBe(403);
    expect(back.json()).toMatchObject({ sessionForbidden: ['dropZones[main].image'] });
    // From ctl it applies, and history marks the re-add.
    expect((await w.token('POST', '/api/control/config/rollback', { id: added })).statusCode).toBe(
      200,
    );
    const again = (await w.get('/system/history')).body;
    const top = again.slice(again.indexOf(`<tr data-revision="${w.store.revision()}"`));
    expect(top.slice(0, top.indexOf('</tr>'))).toContain('class="mark readds"');
    expect(top.slice(0, top.indexOf('</tr>'))).toContain('re-added main');

    // A revert that weakens a guard goes through the confirmation page, then back to History.
    const patch = (stopOnOverage: boolean) =>
      w.token('PATCH', '/api/control/config', {
        patch: { usage: { stopOnOverage } },
        expectRevision: w.store.revision(),
      });
    expect((await patch(false)).statusCode).toBe(200);
    const weak = w.store.revision();
    expect((await patch(true)).statusCode).toBe(200);
    expect(rowIn((await w.get('/system/history')).body, weak)).toContain('class="mark guarded"');
    const held = await w.call('POST', '/api/control/config/rollback', {
      id: weak,
      expectRevision: w.store.revision(),
      returnTo: '/system/history',
      cancelTo: '/system/history',
    });
    expect(held.statusCode).toBe(409);
    const confirm = await w.get((held.json() as { confirm: string }).confirm);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('<a href="/system/history">Cancel</a>');
    expect(w.store.current().usage.stopOnOverage).toBe(true);

    // The page's Revert: asks first (naming the re-add), then posts the rollback with the id.
    let asked = '';
    let went = '';
    const s = pageScript(HISTORY_SCRIPT, () => ({
      ok: false,
      status: 409,
      json: { needsConfirmation: true, confirm: '/config/confirm/xyz' },
    }));
    const result = await (s.ctx.jmRevert as (...a: unknown[]) => Promise<string>)(
      { id: 2, revision: 4, readds: ['main'] },
      stubStatus(),
      (q: string) => {
        asked = q;
        return true;
      },
      (to: string) => {
        went = to;
      },
    );
    expect(asked).toContain('re-adds project main');
    expect(s.calls).toEqual([
      {
        method: 'POST',
        path: '/api/control/config/rollback',
        body: {
          id: 2,
          expectRevision: 4,
          returnTo: '/system/history',
          cancelTo: '/system/history',
        },
      },
    ]);
    expect([result, went]).toEqual(['confirm', '/config/confirm/xyz']);
    // Cancelled at the question: nothing is sent.
    const no = pageScript(HISTORY_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    expect(
      await (no.ctx.jmRevert as (...a: unknown[]) => Promise<string>)(
        { id: 2, revision: 4, readds: [] },
        stubStatus(),
        () => false,
        () => {},
      ),
    ).toBe('cancelled');
    expect(no.calls).toEqual([]);
  });
});

describe('settings, part two: browser findings (Task 13, fix round 1)', () => {
  test('B1: after a mint the token list is refreshed in place, so the new token is listed while its value stays shown', async () => {
    const listed = {
      tokens: [
        {
          id: 2,
          zoneId: 'main',
          scope: 'read',
          label: 'my <laptop>',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2099-01-08T00:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    };
    const gets: string[] = [];
    const s = mcpScript({
      fetch: async (path: string) => {
        gets.push(path);
        return { ok: true, status: 200, json: async () => listed };
      },
    });
    const reveal = { textContent: '', hidden: true };
    const list = {
      innerHTML: '<p>No MCP tokens yet.</p>',
      dataset: { zones: JSON.stringify({ main: 'octo/demo' }) },
    };
    const done = await (s.ctx.jmMintToken as (...a: unknown[]) => Promise<string>)(
      { zoneId: 'main', scope: 'read', days: '7', label: 'my <laptop>' },
      { sudo: true, passphrase: '' },
      stubStatus(),
      reveal,
      list,
    );
    expect(done).toBe('minted');
    expect(gets).toEqual(['/api/control/mcp-tokens']);
    expect(list.innerHTML).toContain('<tr data-token="2">');
    // The redrawn row names the zone as the server's does (#99).
    expect(list.innerHTML).toContain('<td>2</td><td>octo/demo</td>');
    expect(list.innerHTML).toContain('my &lt;laptop&gt;');
    expect(list.innerHTML).toContain(
      '<button type="button" class="revoke" data-id="2">Revoke</button>',
    );
    expect(list.innerHTML).not.toContain('No MCP tokens yet');
    expect(list.innerHTML).not.toContain('jmm_shownonce');
    expect(reveal).toEqual({ textContent: 'jmm_shownonce', hidden: false });
    // The page holds the list in that container, so the script can replace it.
    const w = await world({ dbMode: true, doc: { mcp: { enabled: true }, dropZones: [ZONE] } });
    expect((await w.get('/system/mcp-tokens')).body).toMatch(
      /<div id="token-list" data-zones="[^"]*"><p>No MCP tokens yet.<\/p><\/div>/,
    );
  });

  test('B2: each boot setting names where its value really comes from, the default included', async () => {
    const bootRow = (html: string, path: string) => {
      const at = html.indexOf(`<tr data-boot="${path}"`);
      if (at < 0) throw new Error(`no boot row ${path}`);
      return html.slice(at, html.indexOf('</tr>', at));
    };
    // Db mode, no listen or data variable set: every row is the default, with how to set it.
    const none = (await (await world({ dbMode: true })).get('/system/server')).body;
    for (const [path, env] of [
      ['listen.host', 'JM_LISTEN_HOST'],
      ['listen.port', 'JM_LISTEN_PORT'],
      ['listen.allowedHosts', 'JM_ALLOWED_HOSTS'],
      ['listen.tlsTerminated', 'JM_TLS_TERMINATED=1'],
      ['dataDir', 'JM_DATA_DIR'],
    ] as const) {
      const row = bootRow(none, path);
      expect([path, row]).toEqual([
        path,
        expect.stringContaining(`the default; set <code>${env}</code>`),
      ]);
      expect(row).not.toContain('the environment:');
    }
    // Set in the environment: said so, for each.
    const set = await world({
      dbMode: true,
      env: {
        JM_LISTEN_HOST: '0.0.0.0',
        JM_LISTEN_PORT: '7420',
        JM_ALLOWED_HOSTS: '127.0.0.1:7420',
        JM_TLS_TERMINATED: '1',
        JM_DATA_DIR: '/data',
      },
    });
    const env = (await set.get('/system/server')).body;
    for (const name of ['JM_LISTEN_HOST', 'JM_LISTEN_PORT', 'JM_ALLOWED_HOSTS', 'JM_DATA_DIR'])
      expect(env).toContain(`the environment: <code>${name}</code>`);
    expect(bootRow(env, 'listen.tlsTerminated')).toContain(
      'the environment: <code>JM_TLS_TERMINATED=1</code>',
    );
    // File mode, a file with dataDir and no listen: dataDir from the file, the listen rows default.
    const f = await world();
    const file = (await f.get('/system/server')).body;
    expect(bootRow(file, 'dataDir')).toContain('the config file');
    for (const path of ['listen.host', 'listen.port', 'listen.allowedHosts'])
      expect(bootRow(file, path)).toContain(
        `the default; set <code>${path}</code> in the config file`,
      );
    expect(bootRow(file, 'listen.tlsTerminated')).toContain(
      'the default; set <code>JM_TLS_TERMINATED=1</code> or <code>listen.tlsTerminated</code> in the config file',
    );
    // And a file that sets listen: the file.
    const g = await world({
      file: { listen: { host: '127.0.0.1', port: 7420, tlsTerminated: true } },
    });
    const gHtml = (await g.get('/system/server')).body;
    for (const path of ['listen.host', 'listen.port', 'listen.tlsTerminated'])
      expect(bootRow(gHtml, path)).toContain('the config file');
    expect(bootRow(gHtml, 'listen.allowedHosts')).toContain('the default');
  });

  test('B3: Install Save says the revision it saved, and the restart note when one applies', async () => {
    let went = '';
    const s = pageScript(INSTALL_SCRIPT, () => ({
      ok: true,
      status: 200,
      json: { revision: 9, changed: ['pollSeconds'], restartNeeded: [] },
    }));
    const r = await (s.ctx.jmSaveInstall as (...a: unknown[]) => Promise<string>)(
      { pollSeconds: 45 },
      8,
      stubStatus(),
      (to: string) => {
        went = to;
      },
    );
    expect([r, went]).toEqual(['saved', '/system/server?saved=9']);
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const saved = (await w.get('/system/server?saved=2')).body;
    expect(saved).toContain(
      '<p class="saved" role="status">Saved as revision 2: it takes effect at the next pass.</p>',
    );
    // Only a revision number is echoed; anything else says nothing.
    for (const q of ['?saved=<b>', '?saved=1e3', '?saved=', ''])
      expect((await w.get(`/system/server${q}`)).body).not.toContain('class="saved"');
    // A save that needs a restart: the badge on the reloaded page says it.
    await w.token('PATCH', '/api/control/config', {
      patch: { mcp: { enabled: true } },
      expectRevision: w.store.revision(),
    });
    const after = (await w.get(`/system/server?saved=${w.store.revision()}`)).body;
    expect(after).toContain(`Saved as revision ${w.store.revision()}`);
    expect(after).toContain('restart-pending');
  });

  test('a stored value with more decimals than a step allows still saves: every number input takes any value (review M2)', async () => {
    const w = await world({
      dbMode: true,
      doc: { usage: { throttleUtilization: 0.855 }, dropZones: [ZONE] },
    });
    const html = (await w.get('/system/server')).body;
    expect(settingRow(html, 'usage.throttleUtilization')).toMatch(
      /<input type="number" min="0" max="1" step="any" id="setting-usage-throttleUtilization"[^>]* value="0.855">/,
    );
    // No fractional step anywhere that a stored value could fall between.
    for (const m of html.matchAll(/<input type="number"[^>]*>/g))
      expect(m[0]).toMatch(/step="(any|1)"/);
  });

  test('B4: every Install control and the MCP form fields have an accessible name', async () => {
    const w = await world({ dbMode: true, doc: { mcp: { enabled: true }, dropZones: [ZONE] } });
    const html = (await w.get('/system/server')).body;
    const controls = [...html.matchAll(/<(input|select)[^>]*data-path="([^"]+)"[^>]*>/g)];
    expect(controls.length).toBe(15);
    for (const [tag, , path] of controls) {
      const id = /id="([^"]+)"/.exec(tag as string)?.[1];
      expect([path, id]).toEqual([path, expect.any(String)]);
      expect(html).toContain(`<label for="${id}"><code>${path}</code></label>`);
    }
    const mcp = (await w.get('/system/mcp-tokens')).body;
    const start = mcp.indexOf('<form id="mint">');
    const form = mcp.slice(start, mcp.indexOf('</form>', start));
    for (const name of ['zoneId', 'scope', 'days', 'label'])
      expect(form).toMatch(new RegExp(`<label>[A-Z][a-z]+ <(input|select)[^>]* name="${name}"`));
  });
});

describe('the Other machines tab (issue #254)', () => {
  test('a held change goes to the confirmation page; a refusal says why', async () => {
    let went = '';
    const held = pageScript(OTHER_MACHINES_SCRIPT, () => ({
      ok: false,
      status: 409,
      json: { needsConfirmation: true, confirm: '/config/confirm/abc' },
    }));
    const save = held.ctx.jmSavePublicUrl as (...a: unknown[]) => Promise<string>;
    const out = stubStatus();
    expect(
      await save('https://a.b.ts.net', out, (to: string) => {
        went = to;
      }),
    ).toBe('confirm');
    expect(went).toBe('/config/confirm/abc');
    expect(held.calls).toEqual([
      {
        method: 'PUT',
        path: '/api/control/server/public-url',
        body: { publicUrl: 'https://a.b.ts.net' },
      },
    ]);
    const bad = pageScript(OTHER_MACHINES_SCRIPT, () => ({
      ok: false,
      status: 400,
      json: { issues: [{ path: 'server.publicUrl', message: 'must be a plain https origin' }] },
    }));
    const out2 = stubStatus();
    expect(
      await (bad.ctx.jmSavePublicUrl as (...a: unknown[]) => Promise<string>)('x', out2, () => {}),
    ).toBe('refused');
    expect(out2.textContent).toBe('must be a plain https origin');
  });

  test('jmGo redraws this page when only the hash differs, and navigates otherwise', () => {
    const at = (href: string) => {
      const u = new URL(href);
      const loc = {
        href,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        reloads: 0,
        reload() {
          loc.reloads += 1;
        },
      };
      const s = pageScript(OTHER_MACHINES_SCRIPT, () => ({ ok: true, status: 200, json: {} }), {
        location: loc,
        URL,
      });
      (s.ctx.jmGo as (to: string) => void)('/system/server#other-machines');
      return loc;
    };
    const same = at('http://h/system/server');
    expect(same.reloads).toBe(1);
    expect(same.hash).toBe('#other-machines');
    expect(same.href).toBe('http://h/system/server');
    const other = at('http://h/config/confirm/abc');
    expect(other.reloads).toBe(0);
    expect(other.href).toBe('/system/server#other-machines');
    const query = at('http://h/system/server?saved=3');
    expect(query.reloads).toBe(0);
    expect(query.href).toBe('/system/server#other-machines');
  });
});

/** One revision's row on the History tab. */
const rowIn = (html: string, id: number): string => {
  const at = html.indexOf(`<tr data-revision="${id}"`);
  if (at < 0) throw new Error(`no revision ${id}`);
  return html.slice(at, html.indexOf('</tr>', at));
};

/** A page script run against a recording `jmFetch` that answers with `answer()`. */
function pageScript(
  script: string,
  answer: (call: Call) => { ok: boolean; status: number; json: unknown },
  globals: Record<string, unknown> = {},
) {
  const calls: Call[] = [];
  const ctx = vm.createContext({
    document: { addEventListener: () => {}, querySelectorAll: () => [] },
    encodeURIComponent,
    Date,
    ...globals,
    jmFetch: async (path: string, body: unknown, method?: string) => {
      const call = { method: method ?? 'POST', path, body };
      calls.push(call);
      const a = answer(call);
      return { ok: a.ok, status: a.status, json: async () => a.json };
    },
  });
  vm.runInContext(script.replace(/^<script>|<\/script>$/gi, ''), ctx);
  return { ctx, calls };
}

/** The MCP tokens script: sudo answers, then the mint returns a value once. */
function mcpScript(globals: Record<string, unknown> = {}) {
  return pageScript(
    MCP_TOKENS_SCRIPT,
    (c) =>
      c.path === '/api/control/sudo'
        ? { ok: true, status: 200, json: { sudo: true } }
        : c.method === 'DELETE'
          ? { ok: true, status: 200, json: { id: 1, revoked: true } }
          : {
              ok: true,
              status: 200,
              json: {
                id: 2,
                token: 'jmm_shownonce',
                expiresAt: '2026-01-08T00:00:00.000Z',
                zoneId: 'main',
                scope: 'read',
                label: '',
              },
            },
    globals,
  );
}

type Call = { method: string; path: string; body: unknown };

describe('Credentials tab after sudo lapses (T10 finding 3, red team I1)', () => {
  const lapsed = {
    status: 403,
    body: { error: 'saving a credential asks for your passphrase again', sudo: 'required' },
  };
  test('replace, test and remove answer sudo on a lapsed-sudo refusal, so the page opens the prompt', async () => {
    const { ctx } = scriptContext(0, lapsed);
    const fn = (n: string) => ctx[n] as (...a: unknown[]) => Promise<string>;
    for (const [name, args] of [
      ['jmReplaceCredential', [{ name: 'githubAuthorToken', value: 'v-123456789' }]],
      ['jmTestCredential', ['githubAuthorToken']],
      ['jmRemoveCredential', ['githubAuthorToken']],
    ] as const) {
      const state = { sudo: true, passphrase: '' };
      const status = stubStatus();
      expect(await fn(name)(...args, state, status), name).toBe('sudo');
      expect(state.sudo, name).toBe(false);
      expect(status.textContent, name).toContain('passphrase');
    }
  });

  test('the page records a lapse, and keeps a typed token unless it was saved', () => {
    expect(CREDENTIALS_SCRIPT).toContain("root.dataset.sudo = s.sudo ? '1' : '0';");
    expect(CREDENTIALS_SCRIPT).toContain("if (outcome === 'saved') field.value = '';");
  });
});

/** Runs the tab's script against stubs: `jmReplaceCredential` with a recording fetch. */
async function runReplace(o: {
  name: string;
  value: string;
  declaredCreatedAt?: string;
  sudo: boolean;
  passphrase?: string;
  running?: number;
}) {
  const { ctx, calls } = scriptContext(o.running ?? 2);
  const status = stubStatus();
  const result = await (ctx.jmReplaceCredential as (...a: unknown[]) => Promise<string>)(
    {
      name: o.name,
      value: o.value,
      ...(o.declaredCreatedAt ? { declaredCreatedAt: o.declaredCreatedAt } : {}),
    },
    { sudo: o.sudo, passphrase: o.passphrase ?? '' },
    status,
  );
  return { result, calls, status: status.textContent, appended: status.appended };
}

/** A status element: its text, and the HTML the script appends after it. */
function stubStatus() {
  const s = {
    textContent: '',
    appended: '',
    insertAdjacentHTML(_where: string, html: string) {
      s.appended += html;
    },
  };
  return s;
}

async function runAction(kind: 'test' | 'remove', name: string) {
  const { ctx, calls } = scriptContext(2);
  const status = stubStatus();
  const fn = (kind === 'test' ? ctx.jmTestCredential : ctx.jmRemoveCredential) as (
    ...a: unknown[]
  ) => Promise<string>;
  const result = await fn(name, { sudo: true, passphrase: '' }, status);
  return { result, calls, status: status.textContent, appended: status.appended };
}

function scriptContext(
  running: number,
  refuse?: { status: number; body: Record<string, unknown> },
) {
  const calls: Call[] = [];
  const ctx = vm.createContext({
    document: { addEventListener: () => {}, querySelectorAll: () => [] },
    encodeURIComponent,
    jmFetch: async (path: string, body: unknown, method?: string) => {
      calls.push({ method: method ?? 'POST', path, body });
      if (refuse && path !== '/api/control/sudo')
        return { ok: false, status: refuse.status, json: async () => refuse.body };
      const json =
        method === 'PUT'
          ? {
              // As the route answers: only a GitHub token is tested against its provider.
              tested: !path.endsWith('/claudeToken'),
              runningDropsWithPrevious: running,
              hint: `${running} running drops still carry the previous token, and the pass running now keeps it until it ends: revoke it on GitHub after they finish`,
            }
          : { tested: true, result: 'ok' };
      return { ok: true, status: 200, json: async () => json };
    },
  });
  vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
  return { ctx, calls };
}

test("a gate secret's role names its zone by repository (#99)", () => {
  const zones = [{ id: 'ref', repo: 'octo/reference' }];
  expect(roleOf(gateSecretName('ref', 'NPM'), zones)).toBe(
    'gate secret NPM for octo/reference: gate steps can read it',
  );
});

describe('turning the vault on and preferring it (#101)', () => {
  test('#258: with the vault off, the key-in-the-data-directory warning shows only when no secrets directory is set', async () => {
    const data = mkdtempSync(join(tmpdir(), 'jm-data-258-'));
    const without = await world({
      vaultOff: true,
      env: { JM_SECRETS_DIR: '' },
      file: { dataDir: data },
    });
    let html = (await without.get('/system/credentials')).body;
    expect(html).toContain(VAULT_KEY_IN_DATA_DIR);
    expect(html).toContain('<button type="button" id="vault-on">Turn on the vault</button>');
    // Turning it on still works.
    expect((await without.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(
      200,
    );
    expect((await without.call('POST', '/api/control/secrets/vault/on', {})).statusCode).toBe(200);
    html = (await without.get('/system/credentials')).body;
    expect(html).not.toContain('id="vault-on"');
    expect(readFileSync(join(data, 'vault', 'vault_key'), 'utf8')).not.toBe('');
    const withDir = await world({ vaultOff: true });
    html = (await withDir.get('/system/credentials')).body;
    expect(html).toContain('id="vault-on"');
    expect(html).not.toContain(VAULT_KEY_IN_DATA_DIR);
  });

  test('with the vault off the tab offers Turn on the vault; turned on, it offers Prefer the vault and Copy into the vault', async () => {
    const w = await world({ vaultOff: true, env: { JM_GITHUB_READ_TOKEN: READ } });
    let html = (await w.get('/system/credentials')).body;
    expect(html).toContain('<button type="button" id="vault-on">Turn on the vault</button>');
    expect(html).not.toContain('id="prefer-vault"');
    expect(rowOf(html, 'githubReadToken')).not.toContain('Copy into the vault');
    // The page's button POSTs here (with sudo); the key never reaches the page.
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    expect((await w.call('POST', '/api/control/secrets/vault/on', {})).statusCode).toBe(200);
    const key = readFileSync(join(w.secrets, 'vault_key'), 'utf8').trim();
    html = (await w.get('/system/credentials')).body;
    expect(html).not.toContain(key);
    expect(html).not.toContain('id="vault-on"');
    expect(html).toMatch(
      /<input type="checkbox" id="prefer-vault"(?! checked)[^>]*> Prefer the vault/,
    );
    // An empty vault turned on here can be turned off.
    expect(html).toContain('<button type="button" id="vault-off">Turn off the vault</button>');
    const read = rowOf(html, 'githubReadToken');
    expect(read).toContain('environment variable <code>JM_GITHUB_READ_TOKEN</code>');
    expect(read).toContain(
      '<button type="button" class="copy" data-name="githubReadToken">Copy into the vault</button>',
    );
    const reviewer = rowOf(html, 'githubReviewerToken');
    expect(reviewer).toContain('Copy into the vault');
    expect(html).not.toContain(READ);
    expect(html).not.toContain(REVIEWER);
  });

  test('each row says which source is in use and which it overrides; prefer flips it live; turn off waits for the entries to go', async () => {
    const w = await world({ vaultOff: true, env: { JM_GITHUB_READ_TOKEN: READ } });
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('POST', '/api/control/secrets/vault/on', {});
    const copy = await w.call('POST', '/api/control/secrets/githubReadToken/copy-to-vault', {});
    expect(copy.statusCode).toBe(200);
    expect(copy.body).not.toContain(READ);
    let html = (await w.get('/system/credentials')).body;
    expect(rowOf(html, 'githubReadToken')).toContain(
      'environment variable <code>JM_GITHUB_READ_TOKEN</code>, overriding the vault',
    );
    expect(html).not.toContain('id="vault-off"');
    expect(html).toContain('remove them first');
    expect(
      (await w.call('POST', '/api/control/secrets/vault/prefer', { prefer: true })).statusCode,
    ).toBe(200);
    html = (await w.get('/system/credentials')).body;
    expect(html).toMatch(/<input type="checkbox" id="prefer-vault" checked[^>]*> Prefer the vault/);
    expect(rowOf(html, 'githubReadToken')).toContain(
      'vault (encrypted), overriding <code>JM_GITHUB_READ_TOKEN</code>',
    );
    expect(rowOf(html, 'githubReadToken')).not.toContain('Copy into the vault');
    expect(html).not.toContain(READ);
  });

  test('a copied entry behind a variable has Remove, and once removed the vault can be turned off', async () => {
    const w = await world({ vaultOff: true, env: { JM_GITHUB_READ_TOKEN: READ } });
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('POST', '/api/control/secrets/vault/on', {});
    await w.call('POST', '/api/control/secrets/githubReadToken/copy-to-vault', {});
    let html = (await w.get('/system/credentials')).body;
    expect(rowOf(html, 'githubReadToken')).toContain(
      '<button type="button" class="remove" data-name="githubReadToken">Remove from the vault</button>',
    );
    // The page's Remove sends a DELETE; the variable stays in use, and Turn off comes back.
    const rm = await w.call('DELETE', '/api/control/secrets/githubReadToken', undefined);
    expect(rm.statusCode).toBe(200);
    expect(rm.body).not.toContain(READ);
    html = (await w.get('/system/credentials')).body;
    expect(rowOf(html, 'githubReadToken')).not.toContain('class="remove"');
    expect(rowOf(html, 'githubReadToken')).toContain(
      'environment variable <code>JM_GITHUB_READ_TOKEN</code>',
    );
    expect(html).toContain('<button type="button" id="vault-off">Turn off the vault</button>');
    expect(html).not.toContain(READ);
  });

  test('the page script posts the switches with sudo and never sends a value', () => {
    expect(CREDENTIALS_SCRIPT).toContain("'/api/control/secrets/vault/on'");
    expect(CREDENTIALS_SCRIPT).toContain("'/api/control/secrets/vault/off'");
    expect(CREDENTIALS_SCRIPT).toContain("'/api/control/secrets/vault/prefer', { prefer:");
    expect(CREDENTIALS_SCRIPT).toContain("'/copy-to-vault', {}");
  });
});

describe('the advanced settings page for the install, /settings/flags (issue #323)', () => {
  const REF = { ...ZONE, id: 'ref', repo: 'octo/ref' };
  const installRows = (store: ConfigStore) => {
    const doc = store.document() as Record<string, unknown>;
    return flagRows('install', doc, doc);
  };
  /** Every `<tr data-flag="…">…</tr>` of the page, by key, in page order. */
  const flagRowsHtml = (html: string): [string, string][] =>
    [...html.matchAll(/<tr data-flag="([^"]*)"[^>]*>(.*?)<\/tr>/gs)].map((m) => [
      m[1] as string,
      m[2] as string,
    ]);
  const flagRow = (html: string, key: string): string => {
    const r = flagRowsHtml(html).find(([k]) => k === key);
    if (!r) throw new Error(`no row for ${key}`);
    return r[1];
  };
  const field = (
    key: string,
    kind: string,
    value: unknown,
    original: unknown,
    explicit = false,
  ) => ({
    key,
    kind,
    value,
    original,
    explicit,
  });

  test('lists exactly the install flagRows, one link per zone, and the same auth as the other tabs', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE, REF] } });
    const r = await w.get('/system/advanced');
    expect(r.statusCode).toBe(200);
    const rows = installRows(w.store);
    expect(rows.length).toBeGreaterThan(0);
    const keys = flagRowsHtml(r.body).map(([k]) => k);
    expect(keys).toEqual(rows.map((row) => row.key));
    expect(keys).toContain('pollSeconds');
    // No zone setting is a row here.
    expect(keys.some((k) => k.startsWith('dropZones'))).toBe(false);
    expect(r.body).toContain('Advanced settings · this install');
    expect(r.body).toContain('Each project has its own advanced settings:');
    const links = [...r.body.matchAll(/<a href="(\/projects\/[^"]*\/flags)">/g)].map((m) => m[1]);
    expect(links).toEqual(['/projects/main/flags', '/projects/ref/flags']);
    // pollSeconds: a number input in Pace with the schema's bounds.
    const pace = r.body.slice(r.body.indexOf('<section data-group="pace">'));
    expect(pace.slice(0, pace.indexOf('</section>'))).toContain('data-flag="pollSeconds"');
    expect(flagRow(r.body, 'pollSeconds')).toMatch(
      /<input type="number" min="5" max="86400" step="1"[^>]*data-path="pollSeconds"/,
    );
    expect(r.body).toContain('<button id="flags-save">Save changes</button>');
    // The elsewhere rows: publicUrl links to the Other machines tab; the jitter says ctl or file.
    expect(flagRow(r.body, 'server.publicUrl')).toContain(
      'Changed under Other machines, on System, Server. <a href="/system/server#other-machines">',
    );
    const jitter = flagRow(r.body, 'usage.probeJitterSeconds');
    expect(jitter).toContain('Changed with jumpmaster ctl settings set or in the config file.');
    expect(jitter).not.toContain('<a ');
    // D1: as the other settings pages, no session gets no page.
    const anon = await w.anon('/system/advanced');
    expect(anon.statusCode).toBe((await w.anon('/system/server')).statusCode);
    expect(anon.statusCode).not.toBe(200);
  });

  test('the System sub-nav ends with Advanced after History, linking to /system/advanced', async () => {
    const w = await world({ dbMode: true });
    const install = (await w.get('/system/server')).body;
    const nav = install.slice(install.indexOf('<nav class="subnav" aria-label="System">'));
    const tabs = nav.slice(0, nav.indexOf('</nav>'));
    expect(tabs).toMatch(/History<\/a> · <a href="\/system\/advanced">Advanced<\/a><\/p>$/);
    expect((await w.get('/system/advanced')).body).toContain(
      '<a href="/system/advanced" aria-current="page">Advanced</a>',
    );
  });

  test('in file mode every control is disabled, there is no Save, under the install banner', async () => {
    const w = await world();
    const html = (await w.get('/system/advanced')).body;
    expect(html).toContain('(file mode), so they are read-only here');
    expect(html).not.toContain('Save changes');
    expect(html).not.toContain('class="reset"');
    const controls = [...html.matchAll(/<(input|select|textarea)[^>]*data-path="[^"]*"[^>]*>/g)];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c[0]).toMatch(/ disabled/);
    expect(html).toContain('<a href="/projects/main/flags">');
  });

  test('every row whose key is in RESTART_PATHS says so, and no other row does', async () => {
    const w = await world({ dbMode: true });
    const html = (await w.get('/system/advanced')).body;
    const rows = flagRowsHtml(html);
    expect(rows.filter(([k]) => (RESTART_PATHS as readonly string[]).includes(k))).toHaveLength(
      RESTART_PATHS.length,
    );
    for (const [key, row] of rows)
      expect(row.includes(RESTART_NOTE), key).toBe(
        (RESTART_PATHS as readonly string[]).includes(key),
      );
  });

  test('the script builds { pollSeconds: 30 } for that change, null for a reset, and saves to this page', async () => {
    const { ctx, calls } = pageScript(FLAGS_SCRIPT, () => ({
      ok: true,
      status: 200,
      json: { revision: 8 },
    }));
    const build = ctx.jmFlagsPatch as (f: unknown[]) => Record<string, unknown>;
    const patch = build([
      field('pollSeconds', 'number', '30', 60, true),
      field('usage.throttleUtilization', 'number', '0.9', 0.9),
    ]);
    expect(patch).toEqual({ pollSeconds: 30 });
    expect(build([{ key: 'pollSeconds', reset: true }])).toEqual({ pollSeconds: null });
    let went = '';
    const r = await (ctx.jmSaveFlags as (...a: unknown[]) => Promise<string>)(
      { savedTo: '/system/advanced' },
      patch,
      5,
      stubStatus(),
      (to: string) => {
        went = to;
      },
    );
    expect(r).toBe('saved');
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/api/control/config',
        body: {
          patch: { pollSeconds: 30 },
          expectRevision: 5,
          returnTo: '/system/advanced',
          cancelTo: '/system/advanced',
        },
      },
    ]);
    expect(went).toBe('/system/advanced?saved=8');
  });

  test('pollSeconds 60 → 30 from this page is applied', async () => {
    const w = await world({ dbMode: true, doc: { pollSeconds: 60 } });
    const { ctx } = pageScript(FLAGS_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const patch = (ctx.jmFlagsPatch as (f: unknown[]) => unknown)([
      field('pollSeconds', 'number', '30', 60, true),
    ]);
    const r = await w.call('PATCH', '/api/control/config', {
      patch,
      expectRevision: w.store.revision(),
      returnTo: '/system/advanced',
      cancelTo: '/system/advanced',
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.current().pollSeconds).toBe(30);
    expect((await w.get('/system/advanced?saved=2')).body).toContain('Saved as revision 2');
    expect((await w.get('/system/advanced?saved=<b>')).body).not.toContain('Saved as revision');
  });

  test('D5 parity (guarded): turning stopOnOverage off from this page and from /settings/install gets the same 409', async () => {
    const w = await world({ dbMode: true, doc: { usage: { stopOnOverage: true } } });
    const before = w.store.revision();
    const flags = pageScript(FLAGS_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const install = pageScript(INSTALL_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const mine = (flags.ctx.jmFlagsPatch as (f: unknown[]) => unknown)([
      field('usage.stopOnOverage', 'bool', false, true, true),
    ]);
    const theirs = (install.ctx.jmInstallPatch as (f: unknown[]) => unknown)([
      { path: 'usage.stopOnOverage', kind: 'bool', value: false, original: true },
    ]);
    expect(mine).toEqual({ usage: { stopOnOverage: false } });
    expect(mine).toEqual(theirs);
    const answers = [];
    for (const [patch, to] of [
      [mine, '/system/advanced'],
      [theirs, '/system/server'],
    ] as const) {
      const r = await w.call('PATCH', '/api/control/config', {
        patch,
        expectRevision: w.store.revision(),
        returnTo: to,
        cancelTo: to,
      });
      expect(r.statusCode).toBe(409);
      const j = r.json() as { needsConfirmation: boolean; guarded: unknown; confirm: string };
      answers.push({ needsConfirmation: j.needsConfirmation, guarded: j.guarded });
      if (to === '/system/advanced')
        expect((await w.get(j.confirm)).body).toContain('<a href="/system/advanced">Cancel</a>');
    }
    expect(answers[0]?.needsConfirmation).toBe(true);
    expect(answers[0]).toEqual(answers[1]);
    expect(w.store.revision()).toBe(before);
    expect(w.store.current().usage.stopOnOverage).toBe(true);
  });

  test('D5 parity (forbidden): requireSignedImages off is refused from both, and the row is disabled only while on', async () => {
    const off = await world({ dbMode: true });
    const offRow = flagRow((await off.get('/system/advanced')).body, 'requireSignedImages');
    expect(offRow).toMatch(/<input type="checkbox"[^>]*data-path="requireSignedImages"[^>]*>/);
    expect(offRow).not.toContain('disabled');
    // Off: it can be turned on and saved.
    const { ctx } = pageScript(FLAGS_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const build = ctx.jmFlagsPatch as (f: unknown[]) => unknown;
    const on = await off.call('PATCH', '/api/control/config', {
      patch: build([field('requireSignedImages', 'bool', true, false)]),
      expectRevision: off.store.revision(),
    });
    expect(on.statusCode, on.body).not.toBe(403);

    const w = await world({ dbMode: true, doc: { requireSignedImages: true } });
    const before = w.store.revision();
    const row = flagRow((await w.get('/system/advanced')).body, 'requireSignedImages');
    expect(row).toMatch(/data-path="requireSignedImages"[^>]* checked disabled/);
    expect(row).toContain('set with <code>jumpmaster ctl</code> or in the config file');
    // A synthetic field: the page never offers this control enabled while it's on.
    const mine = build([field('requireSignedImages', 'bool', false, true, true)]);
    const install = pageScript(INSTALL_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const theirs = (install.ctx.jmInstallPatch as (f: unknown[]) => unknown)([
      { path: 'requireSignedImages', kind: 'bool', value: false, original: true },
    ]);
    expect(mine).toEqual(theirs);
    for (const patch of [mine, theirs]) {
      const r = await w.call('PATCH', '/api/control/config', {
        patch,
        expectRevision: w.store.revision(),
      });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ sessionForbidden: ['requireSignedImages'] });
    }
    expect(w.store.revision()).toBe(before);
    expect(w.store.current().requireSignedImages).toBe(true);
  });

  test('the zone and install pages render through the same exported renderFlagsForm', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE, REF] } });
    const doc = w.store.document() as Record<string, unknown>;
    const note = 'set with <code>jumpmaster ctl</code> or in the config file';
    const install = renderFlagsForm({
      scope: 'install',
      rows: flagRows('install', doc, doc),
      target: { savedTo: '/system/advanced' },
      revision: w.store.revision(),
      readOnly: false,
      forbiddenNote: note,
    });
    expect((await w.get('/system/advanced')).body).toContain(install);
    const zone = (doc.dropZones as Record<string, unknown>[])[1] as Record<string, unknown>;
    const zoneForm = renderFlagsForm({
      scope: 'zone',
      rows: flagRows('zone', zone, doc),
      target: { savedTo: '/projects/ref/flags', zone: { id: 'ref', index: 1 } },
      revision: w.store.revision(),
      readOnly: false,
      forbiddenNote: note,
    });
    expect((await w.get('/projects/ref/flags')).body).toContain(zoneForm);
    expect(install).not.toEqual(zoneForm);
  });
});

describe("each owner's GitHub App pair on the Credentials tab (#375, spec §4.1/§4.4)", () => {
  const API = 'https://api.github.com';
  const pemOf = () =>
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
  const linesOf = (pem: string) =>
    pem
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('-----'));
  const AUTHOR_ENTRY = {
    appId: '901',
    slug: 'jm-a',
    clientId: 'Iv23liAppTabAuthor001',
    pem: pemOf(),
    importedAt: '2026-11-15T10:00:00.000Z',
  };
  const REVIEWER_ENTRY = {
    appId: '902',
    slug: 'jm-r',
    clientId: 'Iv23liAppTabReviewer2',
    pem: pemOf(),
    importedAt: '2026-11-16T10:00:00.000Z',
  };
  const zoneOn = (id: string, repo: string, extra: object = {}) => ({
    ...ZONE,
    id,
    repo,
    ...extra,
  });
  const TWO_OWNERS = { dropZones: [zoneOn('web', 'acme/web'), zoneOn('api', 'alice/api')] };

  beforeAll(() => nock.disableNetConnect());
  afterAll(() => nock.enableNetConnect());
  afterEach(() => nock.cleanAll());

  /** Two two-bot owners; the vault holds acme's pair and nothing for alice. */
  async function twoOwners(o: { slug?: string } = {}) {
    const w = await world({ dbMode: true, doc: TWO_OWNERS });
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('expected a vault');
    vault.put(
      appEntryName('acme', 'author'),
      serializeAppEntry({ ...AUTHOR_ENTRY, ...(o.slug ? { slug: o.slug } : {}) }),
      { now: t0 },
    );
    vault.put(appEntryName('acme', 'reviewer'), serializeAppEntry(REVIEWER_ENTRY), { now: t0 });
    w.store.refreshSecrets();
    return w;
  }
  /** The row of one app entry, from `<tr data-app="owner/role">` to its `</tr>`. */
  const appRowOf = (html: string, owner: string, role: string): string => {
    const at = html.indexOf(`<tr data-app="${owner}/${role}"`);
    if (at < 0) throw new Error(`no app row for ${owner}/${role}`);
    return html.slice(at, html.indexOf('</tr>', at));
  };
  const sectionOf = (html: string): string => {
    const at = html.indexOf('<section id="app-entries"');
    if (at < 0) throw new Error('no app-entries section');
    return html.slice(at, html.indexOf('</section>', at));
  };

  test('two owners: acme has its slugs, install links and Test buttons; alice is not created and has no Test', async () => {
    const w = await twoOwners();
    const r = await w.get('/system/credentials');
    expect(r.statusCode).toBe(200);
    const section = sectionOf(r.body);
    expect(section).toContain('GitHub App entries');
    expect(section).not.toContain('GitHub Apps (recommended for two bots)');
    const a = appRowOf(r.body, 'acme', 'author');
    expect(a).toContain('acme');
    expect(a).toContain('author');
    expect(a).toContain('vault');
    expect(a).toContain('<a href="https://github.com/apps/jm-a">jm-a</a>');
    expect(a).toContain('901');
    expect(a).toContain('2026-11-15');
    expect(a).toContain('href="https://github.com/apps/jm-a/installations/new"');
    expect(a).toContain(
      '<button type="button" class="app-test" data-owner="acme" data-role="author">Test</button>',
    );
    const rv = appRowOf(r.body, 'acme', 'reviewer');
    expect(rv).toContain('jm-r');
    expect(rv).toContain('902');
    expect(rv).toContain('href="https://github.com/apps/jm-r/installations/new"');
    expect(rv).toContain('class="app-test" data-owner="acme" data-role="reviewer"');
    for (const role of ['author', 'reviewer']) {
      const row = appRowOf(r.body, 'alice', role);
      expect(row).toContain('Not created yet: one app pair per GitHub owner');
      expect(row).toContain('not created');
      expect(row).not.toContain('<button');
      expect(row).not.toContain('installations/new');
    }
    // Every app button has its own class: CREDENTIALS_SCRIPT binds button.test to the PAT route.
    expect(section).not.toMatch(/class="test"/);
  });

  test('a file entry shows its path; the last test shows once recorded', async () => {
    const w = await twoOwners();
    mkdirSync(join(w.secrets, 'github-app', 'alice'), { recursive: true, mode: 0o700 });
    const file = join(w.secrets, 'github-app', 'alice', 'author.json');
    writeFileSync(file, serializeAppEntry({ ...AUTHOR_ENTRY, slug: 'jm-alice' }), { mode: 0o600 });
    w.store.refreshSecrets();
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('expected a vault');
    vault.recordTest(appEntryName('acme', 'author'), { at: t0, result: 'ok as jm-a[bot]' });
    w.store.refreshSecrets();
    const html = (await w.get('/system/credentials')).body;
    const alice = appRowOf(html, 'alice', 'author');
    expect(alice).toContain(`file <code>${file}</code>`);
    expect(alice).toContain('https://github.com/apps/jm-alice/installations/new');
    expect(alice).toContain('class="app-test"');
    expect(appRowOf(html, 'acme', 'author')).toContain('ok as jm-a[bot]');
    expect(appRowOf(html, 'acme', 'author')).toContain(t0.toISOString().slice(0, 10));
  });

  test('Test posts to the app route and shows its result or its error, never the PEM, the client id, nor a request to github.com but the faked one', async () => {
    const w = await twoOwners();
    const jwts: string[] = [];
    const scope = nock(API, {
      reqheaders: {
        authorization: (v: string) => {
          jwts.push(v);
          return true;
        },
      },
    })
      .get('/app')
      .reply(200, { slug: 'jm-a', id: 901 })
      .get('/app')
      .reply(401, { message: 'A JSON web token could not be decoded' });
    const calls: string[] = [];
    const answers: { tested: boolean; result?: string; login?: string; error?: string }[] = [];
    const ctx = vm.createContext({
      document: { addEventListener: () => {}, querySelectorAll: () => [] },
      encodeURIComponent,
      jmFetch: async (path: string, body: unknown, method?: string) => {
        calls.push(`${method ?? 'POST'} ${path}`);
        const r = await w.call((method ?? 'POST') as 'POST', path, body);
        if (path.endsWith('/test')) answers.push(r.json());
        return { ok: r.statusCode < 300, status: r.statusCode, json: async () => r.json() };
      },
    });
    vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
    const fn = ctx.jmTestApp as (...a: unknown[]) => Promise<string>;
    const run = async (role: string) => {
      const status = stubStatus();
      const result = await fn('acme', role, { sudo: false, passphrase: PASS }, status);
      return { result, text: status.textContent, appended: status.appended };
    };
    const ok = await run('author');
    const refused = await run('reviewer');
    expect(calls).toEqual([
      'POST /api/control/sudo',
      'POST /api/control/secrets/github-app/acme/author/test',
      'POST /api/control/sudo',
      'POST /api/control/secrets/github-app/acme/reviewer/test',
    ]);
    const [good, bad] = answers;
    expect(good?.tested).toBe(true);
    expect(bad?.tested).toBe(false);
    expect(ok.result).toBe('tested');
    expect(ok.text).toBe(
      `github-app/acme/author: ${good?.result}${good?.login ? ` (${good.login})` : ''}`,
    );
    expect(refused.result).toBe('failed');
    expect(bad?.error).toContain('401');
    expect(refused.text).toBe(`github-app/acme/reviewer: ${bad?.error}`);
    expect(scope.isDone()).toBe(true);
    expect(jwts).toHaveLength(2);
    for (const t of [ok.text, refused.text, ok.appended, refused.appended]) {
      for (const e of [AUTHOR_ENTRY, REVIEWER_ENTRY]) {
        expect(t).not.toContain(e.clientId);
        for (const l of linesOf(e.pem)) expect(t).not.toContain(l);
      }
      for (const j of jwts) expect(t).not.toContain(j.replace(/^Bearer /, ''));
    }
  });

  test('a refusal the route answers (sudo lapsed, 404) shows its error', async () => {
    const lapsed = pageScript(CREDENTIALS_SCRIPT, (c) =>
      c.path === '/api/control/sudo'
        ? { ok: true, status: 200, json: { sudo: true } }
        : { ok: false, status: 404, json: { error: 'unknown app entry' } },
    );
    const status = stubStatus();
    const fn = lapsed.ctx.jmTestApp as (...a: unknown[]) => Promise<string>;
    expect(await fn('a&b', 'author', { sudo: true, passphrase: '' }, status)).toBe('refused');
    expect(lapsed.calls.map((c) => c.path)).toEqual([
      '/api/control/secrets/github-app/a%26b/author/test',
    ]);
    expect(status.textContent).toBe('github-app/a&b/author: 404 unknown app entry');
    const none = stubStatus();
    expect(await fn('acme', 'author', { sudo: false, passphrase: '' }, none)).toBe('sudo');
  });

  test('an entry the vault cannot decrypt says so, with no Test button', async () => {
    const w = await world({ dbMode: true, doc: TWO_OWNERS });
    const otherKey = join(mkdtempSync(join(tmpdir(), 'jm-other-')), 'other_key');
    writeFileSync(otherKey, randomBytes(32).toString('base64url'), { mode: 0o600 });
    openVault(otherKey, w.db).put(appEntryName('acme', 'author'), serializeAppEntry(AUTHOR_ENTRY), {
      now: t0,
    });
    w.store.refreshSecrets();
    const html = (await w.get('/system/credentials')).body;
    const row = appRowOf(html, 'acme', 'author');
    expect(row).toContain('does not decrypt');
    expect(row).not.toContain('<button');
    expect(row).not.toContain('Not created yet');
    expect(html).not.toContain(AUTHOR_ENTRY.clientId);
  });

  test('Replace key (#487): a vault row has the button and a PEM form naming the app page; file, missing and undecryptable rows have none', async () => {
    const w = await twoOwners();
    mkdirSync(join(w.secrets, 'github-app', 'alice'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(w.secrets, 'github-app', 'alice', 'author.json'),
      serializeAppEntry({ ...AUTHOR_ENTRY, slug: 'jm-alice' }),
      { mode: 0o600 },
    );
    w.store.refreshSecrets();
    const html = (await w.get('/system/credentials')).body;
    const a = appRowOf(html, 'acme', 'author');
    expect(a).toContain(
      '<button type="button" class="app-test" data-owner="acme" data-role="author">Test</button> <button type="button" class="app-replace" data-owner="acme" data-role="author">Replace key</button>',
    );
    expect(a).toContain('<form class="app-key" data-owner="acme" data-role="author" hidden>');
    expect(a).toMatch(/<textarea name="pem"[^>]*><\/textarea>/);
    expect(a).toContain('https://github.com/apps/jm-a');
    expect(a).toContain('<strong>Private keys</strong>');
    expect(appRowOf(html, 'acme', 'reviewer')).toContain('class="app-replace"');
    // A file row is replaced in its file; a missing row has no key.
    expect(appRowOf(html, 'alice', 'author')).toContain('class="app-test"');
    expect(appRowOf(html, 'alice', 'author')).not.toContain('Replace key');
    expect(appRowOf(html, 'alice', 'reviewer')).not.toContain('Replace key');
    expect(html).not.toContain('PRIVATE KEY');
    for (const e of [AUTHOR_ENTRY, REVIEWER_ENTRY]) {
      expect(html).not.toContain(e.clientId);
      for (const l of linesOf(e.pem)) expect(html).not.toContain(l);
    }
    // An undecryptable row has none either.
    const u = await world({ dbMode: true, doc: TWO_OWNERS });
    const otherKey = join(mkdtempSync(join(tmpdir(), 'jm-other-')), 'other_key');
    writeFileSync(otherKey, randomBytes(32).toString('base64url'), { mode: 0o600 });
    openVault(otherKey, u.db).put(appEntryName('acme', 'author'), serializeAppEntry(AUTHOR_ENTRY), {
      now: t0,
    });
    u.store.refreshSecrets();
    const uh = (await u.get('/system/credentials')).body;
    expect(appRowOf(uh, 'acme', 'author')).not.toContain('Replace key');
    expect(sectionOf(uh)).not.toContain('app-replace');
  });

  test('Replace key (#487): sudo first, the PEM in a PUT body, the result and the delete-the-old-key line; a refusal shows its error', async () => {
    const pem = pemOf();
    const ok = pageScript(CREDENTIALS_SCRIPT, (c) =>
      c.path === '/api/control/sudo'
        ? { ok: true, status: 200, json: { sudo: true } }
        : { ok: true, status: 200, json: { replaced: true, result: 'ok', login: 'jm-a[bot]' } },
    );
    const fn = ok.ctx.jmReplaceAppKey as (...a: unknown[]) => Promise<string>;
    const status = stubStatus();
    const state = { sudo: false, passphrase: PASS };
    expect(await fn({ owner: 'acme', role: 'author', pem }, state, status)).toBe('replaced');
    expect(ok.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/control/sudo',
      'PUT /api/control/secrets/github-app/acme/author/key',
    ]);
    expect(ok.calls[1]?.body).toEqual({ pem });
    expect(status.textContent).toContain('github-app/acme/author: the new key tested ok');
    expect(status.textContent).toContain('delete the old key');
    expect(status.textContent).not.toContain(linesOf(pem)[0]);

    const refused = pageScript(CREDENTIALS_SCRIPT, () => ({
      ok: false,
      status: 422,
      json: { tested: false, status: 401, error: 'GitHub rejected this key' },
    }));
    const rfn = refused.ctx.jmReplaceAppKey as (...a: unknown[]) => Promise<string>;
    const out = stubStatus();
    expect(await rfn({ owner: 'acme', role: 'author', pem }, { sudo: true }, out)).toBe('refused');
    expect(out.textContent).toBe(
      'github-app/acme/author: the key was not replaced (422): GitHub rejected this key',
    );
    const lapsed = pageScript(CREDENTIALS_SCRIPT, () => ({
      ok: false,
      status: 403,
      json: { error: 'replacing a key asks for your passphrase again', sudo: 'required' },
    }));
    const lfn = lapsed.ctx.jmReplaceAppKey as (...a: unknown[]) => Promise<string>;
    const s2 = { sudo: true, passphrase: '' };
    expect(await lfn({ owner: 'acme', role: 'author', pem }, s2, stubStatus())).toBe('sudo');
    expect(s2.sudo).toBe(false);
    const none = stubStatus();
    expect(
      await lfn({ owner: 'acme', role: 'author', pem }, { sudo: false, passphrase: '' }, none),
    ).toBe('sudo');
    expect(await lfn({ owner: 'acme', role: 'author', pem: '  ' }, { sudo: true }, none)).toBe(
      'empty',
    );
  });

  test('Replace key (#559): a key with blank lines around it is sent and replaced; a whitespace-only paste sends nothing', async () => {
    const pem = pemOf();
    const padded = `\n\n${pem}\n  \n`;
    const ok = pageScript(CREDENTIALS_SCRIPT, () => ({
      ok: true,
      status: 200,
      json: { replaced: true, result: 'ok', login: 'jm-a[bot]' },
    }));
    const fn = ok.ctx.jmReplaceAppKey as (...a: unknown[]) => Promise<string>;
    const status = stubStatus();
    expect(await fn({ owner: 'acme', role: 'author', pem: padded }, { sudo: true }, status)).toBe(
      'replaced',
    );
    expect(ok.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /api/control/secrets/github-app/acme/author/key',
    ]);
    const sent = (ok.calls[0]?.body as { pem: string }).pem;
    expect([padded, padded.trim()]).toContain(sent);
    expect(status.textContent).not.toContain(linesOf(pem)[0]);

    const blank = pageScript(CREDENTIALS_SCRIPT, () => ({ ok: true, status: 200, json: {} }));
    const bfn = blank.ctx.jmReplaceAppKey as (...a: unknown[]) => Promise<string>;
    const out = stubStatus();
    expect(
      await bfn({ owner: 'acme', role: 'author', pem: '\n  \r\n\t\n' }, { sudo: true }, out),
    ).toBe('empty');
    expect(out.textContent).toBe('Paste the new private key first.');
    expect(blank.calls).toEqual([]);
  });

  test('only starter zones: the two-bot-mode line and no app rows', async () => {
    const w = await world({
      dbMode: true,
      doc: { dropZones: [zoneOn('solo', 'solo/x', { identity: 'starter', ciRequired: true })] },
    });
    const html = (await w.get('/system/credentials')).body;
    const section = sectionOf(html);
    expect(section).toContain('GitHub Apps are for two-bot mode: starter projects use tokens.');
    expect(section).not.toContain('<tr data-app=');
    expect(section).not.toContain('app-test');
  });

  test('the page holds neither PEM body lines nor client ids of the stored entries', async () => {
    const w = await twoOwners();
    const raw = (await w.get('/system/credentials')).body;
    // CLAIM = PROOF: the fixture entries carry both, and the vault hands them back.
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('expected a vault');
    const stored = w.store.resolvedApps().get('acme');
    expect(stored?.author.source).toBe('vault');
    if (stored?.author.source !== 'vault') throw new Error('expected a vault entry');
    expect(stored.author.entry.clientId).toBe(AUTHOR_ENTRY.clientId);
    expect(stored.author.entry.pem).toBe(AUTHOR_ENTRY.pem);
    for (const e of [AUTHOR_ENTRY, REVIEWER_ENTRY]) {
      expect(raw).not.toContain(e.clientId);
      for (const l of linesOf(e.pem)) expect(raw).not.toContain(l);
    }
    expect(raw).not.toContain('PRIVATE KEY');
  });

  test('a slug with <script> is HTML-escaped in the page and URL-encoded in both links', async () => {
    const slug = 'x"><script>alert(1)</script>';
    const w = await twoOwners({ slug });
    const html = (await w.get('/system/credentials')).body;
    const row = appRowOf(html, 'acme', 'author');
    expect(html).not.toContain('<script>alert(1)</script>');
    const enc = encodeURIComponent(slug);
    expect(row).toContain(`href="https://github.com/apps/${enc}"`);
    expect(row).toContain(`href="https://github.com/apps/${enc}/installations/new"`);
    expect(row).toContain('x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('with ?repo=acme%2Fdemo the page has one id="github-apps" and the create forms still render', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [zoneOn('web', 'acme/demo')] } });
    const r = await w.get('/system/credentials?repo=acme%2Fdemo');
    expect(r.statusCode).toBe(200);
    expect(r.body.match(/id="github-apps"/g) ?? []).toHaveLength(1);
    expect(r.body.match(/id="app-entries"/g) ?? []).toHaveLength(1);
    expect(r.body).toContain('GitHub Apps (recommended for two bots)');
    expect(
      r.body.match(/<form method="post" action="\/setup\/github-app\/start"[^>]*>/g) ?? [],
    ).toHaveLength(2);
    expect(appRowOf(r.body, 'acme', 'author')).toContain('Not created yet');
  });

  test('a PAT-only install: each PAT row is as before, and no app button has the test class', async () => {
    const w = await world({ env: { JM_GITHUB_READ_TOKEN: READ } });
    const html = (await w.get('/system/credentials')).body;
    const at = (s: string) => s.replaceAll(w.secrets, '<secrets>');
    expect(PAT_ROWS).not.toEqual({});
    for (const [name, row] of Object.entries(PAT_ROWS)) expect(at(rowOf(html, name))).toBe(row);
    expect(sectionOf(html)).not.toMatch(/class="test"/);
    const testButtons = Object.values(PAT_ROWS)
      .join('')
      .match(/class="test"/g)?.length;
    expect(html.match(/class="test"/g)?.length).toBe(testButtons);
  });
});

/** Each PAT row of the default world (READ in the environment) as it rendered before #375. */
const PAT_ROWS: Record<string, string> = {
  claudeToken:
    '<tr data-credential="claudeToken"><td><code>claudeToken</code><br><small>Claude token (claude setup-token): runs the agent in every drop</small></td><td data-col="source">not set</td><td data-col="fingerprint">-</td><td data-col="login">-</td><td data-col="set">-</td><td data-col="created">-</td><td data-col="test">-</td><td data-col="actions"><form class="replace" data-name="claudeToken"><input type="password" name="value" autocomplete="off" spellcheck="false" aria-label="New value for claudeToken"> <label>Made on <input type="date" name="declaredCreatedAt"></label> <button>Replace</button> <span class="replace-out" role="status"></span></form></td>',
  githubAuthorToken:
    '<tr data-credential="githubAuthorToken"><td><code>githubAuthorToken</code><br><small>GitHub author token: opens and merges the agent PRs</small></td><td data-col="source">not set</td><td data-col="fingerprint">-</td><td data-col="login">-</td><td data-col="set">-</td><td data-col="created">-</td><td data-col="test">-</td><td data-col="actions"><form class="replace" data-name="githubAuthorToken"><input type="password" name="value" autocomplete="off" spellcheck="false" aria-label="New value for githubAuthorToken"> <button>Replace</button> <span class="replace-out" role="status"></span></form></td>',
  githubReviewerToken:
    '<tr data-credential="githubReviewerToken"><td><code>githubReviewerToken</code><br><small>GitHub reviewer token: posts reviews (two-bot projects)</small></td><td data-col="source">file <code><secrets>/github_reviewer_token</code></td><td data-col="fingerprint"><code>de6463b3</code></td><td data-col="login">-</td><td data-col="set">-</td><td data-col="created">-</td><td data-col="test">-</td><td data-col="actions"><button type="button" class="use-vault" data-name="githubReviewerToken">Replace</button> <button type="button" class="test" data-name="githubReviewerToken">Test</button> <button type="button" class="copy" data-name="githubReviewerToken">Copy into the vault</button> <small>managed by <secrets>/github_reviewer_token: replace that file and run <code>jumpmaster ctl secrets reload</code> to change it there. Replace stores a new value in the vault, which then wins over variables and files.</small></td>',
  githubReadToken:
    '<tr data-credential="githubReadToken"><td><code>githubReadToken</code><br><small>GitHub read token: lets review drops read a private repository</small></td><td data-col="source">environment variable <code>JM_GITHUB_READ_TOKEN</code></td><td data-col="fingerprint"><code>7ba50946</code></td><td data-col="login">-</td><td data-col="set">-</td><td data-col="created">-</td><td data-col="test">-</td><td data-col="actions"><button type="button" class="use-vault" data-name="githubReadToken">Replace</button> <button type="button" class="test" data-name="githubReadToken">Test</button> <button type="button" class="copy" data-name="githubReadToken">Copy into the vault</button> <small>set by the environment variable JM_GITHUB_READ_TOKEN: change it where the server\'s environment is set, and restart the server, to change it there. Replace stores a new value in the vault, which then wins over variables and files.</small></td>',
};

describe("each GitLab zone's gitlab-pat entries on the Credentials tab (#821, spec §9)", () => {
  // Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
  const glpat = (c: string) => ['glpat', c.repeat(20)].join('-');
  const GL_AUTHOR = glpat('A');
  const GL_REVIEWER = glpat('R');
  const GL_LEFTOVER = glpat('L');
  const gitlab = { forge: 'gitlab', gitlab: { baseUrl: 'https://gitlab.example.test' } };
  const GITLAB_DOC = {
    dropZones: [
      { ...ZONE, id: 'gl', repo: 'acme/widgets', ...gitlab },
      { ...ZONE, id: 'solo', repo: 'acme/solo', ...gitlab, identity: 'starter', ciRequired: true },
    ],
  };
  const glRowOf = (html: string, zone: string, role: string): string => {
    const at = html.indexOf(`<tr data-gitlab-pat="${zone}/${role}"`);
    if (at < 0) throw new Error(`no row for ${zone}/${role}`);
    return html.slice(at, html.indexOf('</tr>', at));
  };
  const withoutScripts = (html: string) => html.replace(/<script>[\s\S]*?<\/script>/gi, '');

  test('a two-bot zone shows its author and reviewer rows, with name, fingerprint and test result, never a token', async () => {
    const w = await world({ dbMode: true, doc: GITLAB_DOC });
    const put = (zone: string, role: 'author' | 'reviewer', value: string, login: string) => {
      const r = w.store.putGitlabPat(zone, role, value, { result: 'ok', login });
      if (!r.ok) throw new Error(JSON.stringify(r));
    };
    put('gl', 'author', GL_AUTHOR, 'gl-author-bot');
    put('gl', 'reviewer', GL_REVIEWER, 'gl-reviewer-bot');
    const html = (await w.get('/system/credentials')).body;
    const markup = withoutScripts(html);
    expect(markup).toContain('<section id="gitlab-pats"><h3>GitLab tokens</h3>');
    const today = t0.toISOString().slice(0, 10);
    for (const [role, value] of [
      ['author', GL_AUTHOR],
      ['reviewer', GL_REVIEWER],
    ] as const) {
      const row = glRowOf(markup, 'gl', role);
      expect(row).toContain(`<code>gitlab-pat/gl/${role}</code>`);
      expect(row).toContain('<td data-col="zone">gl</td>');
      expect(row).toContain(`<td data-col="role">${role}</td>`);
      expect(row).toContain('<td data-col="set">set</td>');
      expect(row).toContain(`<code>${fingerprintOf(value)}</code>`);
      expect(row).toContain(`<td data-col="set-at">${today}</td>`);
      expect(row).toContain(`<td data-col="test">ok <small>${today}</small></td>`);
      expect(row).toContain(
        `<form class="gitlab-set" data-zone="gl" data-role="${role}"><input type="password" name="value" autocomplete="off"`,
      );
      expect(row).not.toMatch(/name="value"[^>]* value=/);
      expect(row).toContain(
        `<button type="button" class="gitlab-test" data-zone="gl" data-role="${role}">Test</button>`,
      );
      expect(row).toContain(
        `<button type="button" class="gitlab-remove" data-zone="gl" data-role="${role}">Remove</button>`,
      );
    }
    // In the views' order: the zones as configured, author before reviewer.
    const order = ['gl/author', 'gl/reviewer', 'solo/author'].map((k) =>
      markup.indexOf(`data-gitlab-pat="${k}"`),
    );
    expect(order.every((n, i) => n >= 0 && (i === 0 || n > (order[i - 1] as number)))).toBe(true);
    for (const t of [GL_AUTHOR, GL_REVIEWER]) expect(html).not.toContain(t);
  });

  test('a starter zone shows its author only; a leftover reviewer shows, offering only Remove', async () => {
    const w = await world({ dbMode: true, doc: GITLAB_DOC });
    let markup = withoutScripts((await w.get('/system/credentials')).body);
    const author = glRowOf(markup, 'solo', 'author');
    expect(author).toContain('<td data-col="set">not set</td>');
    expect(author).toContain('class="gitlab-set"');
    // Not set: nothing to test or remove.
    expect(author).not.toContain('class="gitlab-test"');
    expect(author).not.toContain('class="gitlab-remove"');
    expect(markup).not.toContain('data-gitlab-pat="solo/reviewer"');
    // A reviewer left from two-bot mode.
    const vault = w.store.vault();
    if (vault === 'disabled') throw new Error('expected a vault');
    vault.put('gitlab-pat/solo/reviewer', GL_LEFTOVER, { now: t0 });
    w.store.refreshSecrets();
    const html = (await w.get('/system/credentials')).body;
    markup = withoutScripts(html);
    const leftover = glRowOf(markup, 'solo', 'reviewer');
    expect(leftover).toContain(
      '<button type="button" class="gitlab-remove" data-zone="solo" data-role="reviewer">Remove</button>',
    );
    expect(leftover).not.toContain('class="gitlab-set"');
    expect(leftover).not.toContain('class="gitlab-test"');
    expect(leftover).not.toContain('type="password"');
    expect(html).not.toContain(GL_LEFTOVER);
  });

  test("an undecryptable entry says it can't be decrypted", async () => {
    const w = await world({ dbMode: true, doc: GITLAB_DOC });
    const otherKey = join(mkdtempSync(join(tmpdir(), 'jm-other-')), 'other_key');
    writeFileSync(otherKey, randomBytes(32).toString('base64url'), { mode: 0o600 });
    openVault(otherKey, w.db).put('gitlab-pat/gl/author', GL_AUTHOR, { now: t0 });
    w.store.refreshSecrets();
    const html = (await w.get('/system/credentials')).body;
    const row = glRowOf(withoutScripts(html), 'gl', 'author');
    expect(row).toContain('<td data-col="set">can&#39;t be decrypted</td>');
    expect(row).toContain(`<code>${fingerprintOf(GL_AUTHOR)}</code>`);
    expect(row).not.toContain('class="gitlab-test"');
    expect(html).not.toContain(GL_AUTHOR);
  });

  test('a GitHub-only config has its sections and no GitLab section or gitlab-pat text outside the script', async () => {
    const w = await world();
    const markup = withoutScripts((await w.get('/system/credentials')).body);
    expect(markup).toContain('<th>Credential</th><th>Source</th>');
    expect(markup).toContain('<section id="app-entries">');
    expect(markup).toContain('id="sudo-prompt"');
    expect(markup).toContain('<h3>Claude</h3>');
    expect(markup).toMatch(/Plan <strong>pro<\/strong>/);
    expect(markup).toContain('<h3>GitHub</h3>');
    expect(markup).not.toContain('GitLab tokens');
    expect(markup).not.toContain('gitlab-pat');
    expect(markup).not.toContain('gitlab-pats');
  });

  describe("each GitLab zone's read deploy token gitlab-pat/<zone>/read (#875)", () => {
    const D_USER = 'gitlab+deploy-token-42';
    const D_TOKEN = ['gldt', 'D'.repeat(20)].join('-');
    const D_VALUE = `${D_USER}:${D_TOKEN}`;

    test('each GitLab zone, starter or two-bot, has a read row with a username field and a password field', async () => {
      const w = await world({ dbMode: true, doc: GITLAB_DOC });
      const html = (await w.get('/system/credentials')).body;
      const markup = withoutScripts(html);
      for (const zone of ['gl', 'solo']) {
        const row = glRowOf(markup, zone, 'read');
        expect(row).toContain(`<code>gitlab-pat/${zone}/read</code>`);
        expect(row).toContain(`<td data-col="zone">${zone}</td>`);
        expect(row).toContain('<td data-col="role">read</td>');
        expect(row).toContain('<td data-col="set">not set</td>');
        expect(row).toContain('<td data-col="fingerprint">-</td>');
        expect(row).toContain('<td data-col="set-at">-</td>');
        expect(row).toContain('<td data-col="test">-</td>');
        expect(row).toContain(
          `<form class="gitlab-read-set" data-zone="${zone}" data-role="read"><input type="text" name="username" autocomplete="off"`,
        );
        expect(row).toMatch(/<input type="password" name="token" autocomplete="off"/);
        expect(row).not.toContain('name="value"');
        // Not set: nothing to test or remove.
        expect(row).not.toContain('class="gitlab-test"');
        expect(row).not.toContain('class="gitlab-remove"');
      }
      // After the author and reviewer of its zone.
      const order = ['gl/author', 'gl/reviewer', 'gl/read', 'solo/author', 'solo/read'].map((k) =>
        markup.indexOf(`data-gitlab-pat="${k}"`),
      );
      expect(order.every((n, i) => n >= 0 && (i === 0 || n > (order[i - 1] as number)))).toBe(true);
    });

    test('once set: its fingerprint, dates, Test and Remove; never the token or the username', async () => {
      const w = await world({ dbMode: true, doc: GITLAB_DOC });
      const r = w.store.putGitlabRead('gl', D_VALUE, { result: 'ok' });
      if (!r.ok) throw new Error(JSON.stringify(r));
      const html = (await w.get('/system/credentials')).body;
      const row = glRowOf(withoutScripts(html), 'gl', 'read');
      const today = t0.toISOString().slice(0, 10);
      expect(row).toContain('<td data-col="set">set</td>');
      expect(row).toContain(`<code>${fingerprintOf(D_VALUE)}</code>`);
      expect(row).toContain(`<td data-col="set-at">${today}</td>`);
      expect(row).toContain(`<td data-col="test">ok <small>${today}</small></td>`);
      expect(row).toContain(
        '<button type="button" class="gitlab-test" data-zone="gl" data-role="read">Test</button>',
      );
      expect(row).toContain(
        '<button type="button" class="gitlab-remove" data-zone="gl" data-role="read">Remove</button>',
      );
      expect(row).not.toMatch(/name="(username|token)"[^>]* value=/);
      for (const t of [D_USER, D_TOKEN, D_VALUE]) expect(html).not.toContain(t);
    });

    test('an undecryptable read entry offers Remove, not Test', async () => {
      const w = await world({ dbMode: true, doc: GITLAB_DOC });
      const otherKey = join(mkdtempSync(join(tmpdir(), 'jm-other-')), 'other_key');
      writeFileSync(otherKey, randomBytes(32).toString('base64url'), { mode: 0o600 });
      openVault(otherKey, w.db).put('gitlab-pat/solo/read', D_VALUE, { now: t0 });
      w.store.refreshSecrets();
      const html = (await w.get('/system/credentials')).body;
      const row = glRowOf(withoutScripts(html), 'solo', 'read');
      expect(row).toContain('<td data-col="set">can&#39;t be decrypted</td>');
      expect(row).toContain(
        '<button type="button" class="gitlab-remove" data-zone="solo" data-role="read">Remove</button>',
      );
      expect(row).not.toContain('class="gitlab-test"');
      for (const t of [D_USER, D_TOKEN]) expect(html).not.toContain(t);
    });

    test('the intro names the read token as optional and used for the clone; the author token stays for API calls and pushes', async () => {
      const w = await world({ dbMode: true, doc: GITLAB_DOC });
      const markup = withoutScripts((await w.get('/system/credentials')).body);
      const at = markup.indexOf('<section id="gitlab-pats">');
      const intro = markup.slice(at, markup.indexOf('</p>', at));
      expect(intro).toContain('The read token is optional');
      expect(intro).toContain('project deploy token with only <code>read_repository</code>');
      expect(intro).toContain('drops clone with it instead of the author token');
      expect(intro).toContain('without it, the clone container uses the author token');
      expect(intro).toContain("the author token stays the bot's token for API calls and pushes");
      expect(intro).not.toMatch(/only for push/i);
    });

    test('no GitLab zone: no section and no read row', async () => {
      const w = await world();
      const markup = withoutScripts((await w.get('/system/credentials')).body);
      expect(markup).not.toContain('gitlab-pats');
      expect(markup).not.toContain('gitlab-read-set');
      expect(markup).not.toContain('/read');
    });

    describe('the page script', () => {
      type Answer = { status: number; body: Record<string, unknown> };
      const runRead = async (o: {
        zone: string;
        username: string;
        token: string;
        state?: object;
        answer?: Answer;
      }) => {
        const calls: Call[] = [];
        const ctx = vm.createContext({
          document: { addEventListener: () => {}, querySelectorAll: () => [] },
          encodeURIComponent,
          jmFetch: async (path: string, body: unknown, method?: string) => {
            calls.push({ method: method ?? 'POST', path, body });
            const a = path === '/api/control/sudo' ? { status: 200, body: {} } : o.answer;
            const ans = a ?? { status: 200, body: { tested: true, result: 'ok' } };
            return { ok: ans.status < 300, status: ans.status, json: async () => ans.body };
          },
        });
        vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
        const username = { value: o.username };
        const token = { value: o.token };
        const status = stubStatus();
        const state = { sudo: true, passphrase: '', ...o.state };
        const fn = ctx.jmSetGitlabRead as (...a: unknown[]) => Promise<string>;
        const result = await fn({ zone: o.zone, username, token }, state, status);
        return { result, calls, username, token, status: status.textContent };
      };

      test('Set sends {"value": "<username>:<token>"} to the read route and clears both fields', async () => {
        const r = await runRead({ zone: 'gl', username: D_USER, token: D_TOKEN });
        expect(r.result).toBe('saved');
        expect(r.calls).toEqual([
          {
            method: 'PUT',
            path: '/api/control/secrets/gitlab-pat/gl/read',
            body: { value: D_VALUE },
          },
        ]);
        expect(r.username.value).toBe('');
        expect(r.token.value).toBe('');
        for (const t of [D_USER, D_TOKEN]) expect(r.status).not.toContain(t);
      });

      test('an empty username or token sends nothing, not even sudo', async () => {
        for (const [username, token] of [
          ['', D_TOKEN],
          [D_USER, ''],
        ]) {
          const r = await runRead({
            zone: 'gl',
            username: username as string,
            token: token as string,
            state: { sudo: false, passphrase: PASS },
          });
          expect(r.result).toBe('empty');
          expect(r.calls).toEqual([]);
        }
      });

      test('without sudo, the fields are kept for after the passphrase', async () => {
        const r = await runRead({
          zone: 'gl',
          username: D_USER,
          token: D_TOKEN,
          state: { sudo: false },
        });
        expect(r.result).toBe('sudo');
        expect(r.calls).toEqual([]);
        expect(r.token.value).toBe(D_TOKEN);
      });

      test('a 400 GITLAB_READ_BAD_VALUE shows that text, never the input; the fields are cleared', async () => {
        const r = await runRead({
          zone: 'gl',
          username: D_USER,
          token: D_TOKEN,
          answer: { status: 400, body: { error: GITLAB_READ_BAD_VALUE } },
        });
        expect(r.result).toBe('refused');
        expect(r.status).toContain(GITLAB_READ_BAD_VALUE);
        for (const t of [D_USER, D_TOKEN]) expect(r.status).not.toContain(t);
        expect(r.username.value).toBe('');
        expect(r.token.value).toBe('');
      });

      test('the page wires the read form', () => {
        expect(CREDENTIALS_SCRIPT).toContain("querySelectorAll('form.gitlab-read-set')");
      });
    });
  });

  describe('the page script', () => {
    type Answer = { status: number; body: Record<string, unknown> };
    const run = async (
      fnName: 'jmSetGitlabPat' | 'jmTestGitlabPat' | 'jmRemoveGitlabPat',
      o: { zone: string; role: string; value?: string; state?: object; answer?: Answer },
    ) => {
      const calls: Call[] = [];
      const ctx = vm.createContext({
        document: { addEventListener: () => {}, querySelectorAll: () => [] },
        encodeURIComponent,
        jmFetch: async (path: string, body: unknown, method?: string) => {
          calls.push({ method: method ?? 'POST', path, body });
          const a = path === '/api/control/sudo' ? { status: 200, body: {} } : o.answer;
          const ans = a ?? { status: 200, body: { tested: true, result: 'ok', login: 'gl-bot' } };
          return { ok: ans.status < 300, status: ans.status, json: async () => ans.body };
        },
      });
      vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
      const field = { value: o.value ?? '' };
      const status = stubStatus();
      const state = { sudo: true, passphrase: '', ...o.state };
      const fn = ctx[fnName] as (...a: unknown[]) => Promise<string>;
      const result = await fn({ zone: o.zone, role: o.role, field }, state, status);
      return { result, calls, field, state, status: status.textContent };
    };

    test('Set, Test and Remove go to the zone and role, each encoded on its own, with the token in the PUT body only', async () => {
      const set = await run('jmSetGitlabPat', { zone: 'a b/c', role: 'author', value: GL_AUTHOR });
      expect(set.result).toBe('saved');
      expect(set.calls).toEqual([
        {
          method: 'PUT',
          path: '/api/control/secrets/gitlab-pat/a%20b%2Fc/author',
          body: { value: GL_AUTHOR },
        },
      ]);
      expect(set.field.value).toBe('');
      expect(set.status).not.toContain(GL_AUTHOR);
      const tested = await run('jmTestGitlabPat', { zone: 'a b/c', role: 'reviewer' });
      expect(tested.result).toBe('tested');
      expect(tested.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/control/secrets/gitlab-pat/a%20b%2Fc/reviewer/test',
      ]);
      expect(tested.status).toContain('ok (gl-bot)');
      const removed = await run('jmRemoveGitlabPat', { zone: 'a b/c', role: 'reviewer' });
      expect(removed.result).toBe('removed');
      expect(removed.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'DELETE /api/control/secrets/gitlab-pat/a%20b%2Fc/reviewer',
      ]);
      for (const c of [...set.calls, ...tested.calls, ...removed.calls])
        expect(c.path).not.toContain(GL_AUTHOR);
      // An empty field sends nothing.
      const empty = await run('jmSetGitlabPat', { zone: 'gl', role: 'author', value: '' });
      expect(empty.result).toBe('empty');
      expect(empty.calls).toEqual([]);
    });

    test('without sudo, the passphrase first; a lapsed sudo answers sudo and opens the prompt', async () => {
      const none = await run('jmSetGitlabPat', {
        zone: 'gl',
        role: 'author',
        value: GL_AUTHOR,
        state: { sudo: false },
      });
      expect(none.result).toBe('sudo');
      expect(none.calls).toEqual([]);
      const typed = await run('jmTestGitlabPat', {
        zone: 'gl',
        role: 'author',
        state: { sudo: false, passphrase: PASS },
      });
      expect(typed.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /api/control/sudo',
        'POST /api/control/secrets/gitlab-pat/gl/author/test',
      ]);
      const lapsed = {
        status: 403,
        body: { error: 'saving a credential asks for your passphrase again', sudo: 'required' },
      };
      for (const fnName of ['jmSetGitlabPat', 'jmTestGitlabPat', 'jmRemoveGitlabPat'] as const) {
        const r = await run(fnName, {
          zone: 'gl',
          role: 'author',
          value: GL_AUTHOR,
          answer: lapsed,
        });
        expect(r.result, fnName).toBe('sudo');
        expect(r.state.sudo, fnName).toBe(false);
        expect(r.status, fnName).toContain('passphrase');
      }
    });

    test("a refusal shows the server's error (422, 409); the input is cleared after the request", async () => {
      const failed = await run('jmSetGitlabPat', {
        zone: 'gl',
        role: 'author',
        value: GL_AUTHOR,
        answer: {
          status: 422,
          body: { tested: false, status: 401, error: 'GitLab rejected this token (401)' },
        },
      });
      expect(failed.result).toBe('refused');
      expect(failed.status).toContain('GitLab rejected this token (401)');
      expect(failed.status).toContain('422');
      expect(failed.field.value).toBe('');
      for (const [fnName, error] of [
        ['jmSetGitlabPat', 'the vault is off'],
        ['jmSetGitlabPat', 'a starter project has no reviewer token'],
        ['jmTestGitlabPat', 'the vault is off'],
        ['jmRemoveGitlabPat', 'projects need gitlab-pat/gl/author: removing it would park them'],
      ] as const) {
        const r = await run(fnName, {
          zone: 'gl',
          role: 'author',
          value: GL_AUTHOR,
          answer: { status: 409, body: { error } },
        });
        expect(r.result, fnName).toBe('refused');
        expect(r.status, fnName).toContain(error);
        if (fnName === 'jmSetGitlabPat') expect(r.field.value, fnName).toBe('');
      }
      // A test GitLab refuses comes back as tested: false, with its words.
      const testFailed = await run('jmTestGitlabPat', {
        zone: 'gl',
        role: 'author',
        answer: { status: 200, body: { tested: false, status: 401, error: 'GitLab said no' } },
      });
      expect(testFailed.result).toBe('failed');
      expect(testFailed.status).toContain('GitLab said no');
    });

    test('the page wires the rows and confirms Remove with the vault rows’ words', () => {
      expect(CREDENTIALS_SCRIPT).toContain("querySelectorAll('form.gitlab-set')");
      expect(CREDENTIALS_SCRIPT).toContain("querySelectorAll('button.gitlab-test')");
      expect(CREDENTIALS_SCRIPT).toContain("querySelectorAll('button.gitlab-remove')");
      expect(CREDENTIALS_SCRIPT).toContain(
        "'Remove ' + name + ' from the vault? Jumpmaster refuses to remove it while a project still needs it.'",
      );
    });
  });
});
