import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { insertDrop, setZoneMode, upsertDropZone } from '../db/repo.js';
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { fingerprintOf, openVault } from '../vault/vault.js';
import {
  CREDENTIALS_SCRIPT,
  HISTORY_SCRIPT,
  INSTALL_SCRIPT,
  MCP_TOKENS_SCRIPT,
  TOKEN_BANNER_DAYS,
} from './settings.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const PASS = 'a long operator passphrase';
const CLAUDE = 'sk-ant-oat01-TABCLAUDEDUMMY0123456789';
const AUTHOR = 'github_pat_TABAUTHORDUMMY0123456789';
const REVIEWER = 'github_pat_TABREVIEWERFILEDUMMY0123456789';
const READ = 'github_pat_TABREADENVDUMMY0123456789';
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
    vault: openVault(keyFile, db),
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
      viewerLogin: async () => 'octo-<author>',
      repoAccess: async () => ({}),
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
    /** Moves the clock; the operator logs in again (a session idles out after 12 hours). */
    at(d: Date) {
      clock = d;
      s = operatorSession(db, clock);
    },
    get: (url: string) => a.inject({ method: 'GET', url, headers: browser() }),
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
  test('the credentials tab shows source and path, fingerprint, login and dates for each credential, the zone problems, and no value', async () => {
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
    const r = await w.get('/settings/credentials');
    expect(r.statusCode).toBe(200);
    const html = r.body;
    // The tabs, as Task 13 will grow them.
    expect(html).toContain('<nav class="settings-tabs">');
    expect(html).toContain('<strong>Credentials</strong>');

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

    // Every zone's credential problems, with their messages.
    const problems = w.store.problems();
    expect(problems.some((p) => p.credential === 'githubReadToken')).toBe(true);
    expect(html).toContain('<h3>Zone problems</h3>');
    for (const p of problems) expect(html).toContain(p.message.replaceAll("'", '&#39;'));

    for (const secret of [CLAUDE, AUTHOR, REVIEWER, TOKEN, 'join-secret-value-4'])
      expect(html).not.toContain(secret);
  });

  test('Replace is disabled with the managed-by text for a file credential, and for a vault one opens a sudo prompt and PUTs the value only in the body', async () => {
    const w = await world({ env: { JM_GITHUB_READ_TOKEN: READ } });
    const html = (await w.get('/settings/credentials')).body;
    // File and environment credentials: read-only, with where they come from and how to change it.
    const reviewer = rowOf(html, 'githubReviewerToken');
    expect(reviewer).toMatch(/<button[^>]*disabled[^>]*>Replace<\/button>/);
    expect(reviewer).toContain(
      `managed by ${join(w.secrets, 'github_reviewer_token')}: replace that file and run <code>jumpmaster ctl secrets reload</code>`,
    );
    expect(reviewer).not.toContain('type="password"');
    expect(reviewer).not.toContain('class="remove"');
    const read = rowOf(html, 'githubReadToken');
    expect(read).toMatch(/<button[^>]*disabled[^>]*>Replace<\/button>/);
    expect(read).toContain('set by the environment variable JM_GITHUB_READ_TOKEN');
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
    expect((await w.get('/settings/credentials')).body).toContain('data-sudo="1"');

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
    for (const url of ['/settings/credentials', '/']) {
      const body = (await w.get(url)).body;
      expect(body, url).toMatch(banner);
      expect(body, url).toContain('The Claude token is 331 days old');
      expect(body, url).toContain('href="/settings/credentials"');
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
    for (const url of ['/settings/credentials', '/'])
      expect((await fresh.get(url)).body, url).not.toMatch(banner);
  });

  test('/settings redirects to the credentials tab until the other tabs exist', async () => {
    const w = await world();
    const r = await w.get('/settings');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/settings/credentials');
    // Home links to it.
    expect((await w.get('/')).body).toContain('<a href="/settings">Settings</a>');
  });

  test("the wizard's Claude and forge controls are here: the plan, the token date, the repository recommendation and its token links", async () => {
    const w = await world();
    const html = (await w.get('/settings/credentials')).body;
    // The Claude plan (file mode: shown where it is set).
    expect(html).toMatch(/Plan <strong>pro<\/strong> \(set in the config file\)/);
    // The recommendation form, reading GitHub without writing.
    expect(html).toContain(
      '<form method="get" action="/settings/credentials" id="recommend-form">',
    );
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
    const claude = rowOf((await w.get('/settings/credentials')).body, 'claudeToken');
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
    const tab = (await w.get('/settings/credentials')).body;
    expect(rowOf(tab, 'claudeToken')).toContain(`<td data-col="created">${made}</td>`);
    for (const body of [tab, (await w.get('/')).body])
      expect(body).toContain('The Claude token is 331 days old');
  });

  test('the Remove dialog says the removal is refused while a zone needs the credential', () => {
    expect(CREDENTIALS_SCRIPT).toContain(
      'Jumpmaster refuses to remove it while a zone still needs it',
    );
    expect(CREDENTIALS_SCRIPT).not.toMatch(/park until/);
  });

  test('an undecryptable vault entry can be removed', async () => {
    const first = await world({ dbMode: true });
    await first.call('POST', '/api/control/sudo', { passphrase: PASS });
    await first.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
    // The same database under another vault key: the stored value no longer decrypts.
    const w = await world({ dbMode: true, dbFile: first.dbFile });
    const row = rowOf((await w.get('/settings/credentials')).body, 'claudeToken');
    expect(row).toContain('does not decrypt');
    expect(row).toContain(
      '<button type="button" class="remove" data-name="claudeToken">Remove</button>',
    );
  });

  test('no running-drops line when no drop carries the old value; Test and Replace both offer a refresh', async () => {
    const none = await runReplace({ name: 'claudeToken', value: CLAUDE, sudo: true, running: 0 });
    expect(none.status).toBe('Saved and tested.');
    expect(none.appended).toContain('Refresh the list');
    const some = await runReplace({ name: 'claudeToken', value: CLAUDE, sudo: true, running: 2 });
    expect(some.status).toContain('2 running drops still carry the previous token');
    const tested = await runAction('test', 'claudeToken');
    expect(tested.result).toBe('ok');
    expect(tested.appended).toContain('<a href="/settings/credentials">Refresh the list</a>');
  });
});

/** The row of one install setting, from `<tr data-setting="path">` to its `</tr>`. */
const settingRow = (html: string, path: string): string => {
  const at = html.indexOf(`<tr data-setting="${path}"`);
  if (at < 0) throw new Error(`no row for ${path}`);
  return html.slice(at, html.indexOf('</tr>', at));
};

describe('settings, part two (Task 13)', () => {
  test('the install tab marks mcp.enabled as restart-needed, shows the boot settings read-only with their source, and applies the rest live', async () => {
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const r = await w.get('/settings/install');
    expect(r.statusCode).toBe(200);
    const html = r.body;
    // Each tab a path, the current one in bold; /settings goes to the first.
    expect(html).toContain('<strong>Install</strong>');
    for (const tab of ['credentials', 'mcp-tokens', 'history'])
      expect(html).toContain(`<a href="/settings/${tab}">`);
    const s = await w.get('/settings');
    expect([s.statusCode, s.headers.location]).toEqual([302, '/settings/credentials']);

    // mcp.enabled (and the body limit) only apply at the next start: said beside each.
    expect(settingRow(html, 'mcp.enabled')).toContain('takes effect at the next restart');
    expect(settingRow(html, 'mcp.maxBodyBytes')).toContain('takes effect at the next restart');
    expect(settingRow(html, 'pollSeconds')).not.toContain('restart');
    for (const path of [
      'pollSeconds',
      'usage.throttleUtilization',
      'usage.stopOnOverage',
      'claude.plan',
      'claude.fableModel',
      'claude.fableWeeklyDropCap',
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
    const after = (await w.get('/settings/install')).body;
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
          returnTo: '/settings/install',
          cancelTo: '/settings/install',
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
    const file = (await f.get('/settings/install')).body;
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
    const html = (await w.get('/settings/install')).body;
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
      returnTo: '/settings/install',
      cancelTo: '/settings/install',
    });
    expect(stop.statusCode).toBe(409);
    const j = stop.json() as { needsConfirmation: boolean; confirm: string };
    expect(j.needsConfirmation).toBe(true);
    const confirm = await w.get(j.confirm);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('Dispatch will continue on usage credits');
    expect(confirm.body).toContain('<a href="/settings/install">Cancel</a>');
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
    const html = (await w.get('/settings/mcp-tokens')).body;
    expect(html).toContain('<strong>MCP tokens</strong>');
    // The mint form: the zone, the scope, the days (1 to 90) and a label.
    expect(html).toMatch(/<form id="mint">/);
    expect(html).toContain('<option value="main">main</option>');
    expect(html).toMatch(
      /<select name="scope"><option value="read"[^>]*>read<\/option><option value="write">/,
    );
    expect(html).toMatch(/<input type="number" name="days" min="1" max="90"/);
    expect(html).toContain('data-sudo="0"');
    // The list: id, zone, scope, label (escaped), dates, and Revoke; never the value or its hash.
    const row = html.slice(html.indexOf('<tr data-token="1"'));
    expect(row).toContain('laptop &lt;one&gt;');
    expect(row).toContain('<button type="button" class="revoke" data-id="1">Revoke</button>');
    expect(html).not.toContain(value);
    expect(html).not.toMatch(/token_hash|tokenHash/);

    // The script: no sudo and no passphrase asks for it and sends nothing.
    const s = mcpScript();
    const out = stubStatus();
    const reveal = { textContent: '', hidden: true };
    const c = { zoneId: 'main', scope: 'read', days: '7', label: '' };
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
    const listed = (await w.get('/settings/mcp-tokens')).body;
    expect(listed).toContain('data-sudo="1"');
    expect(listed.slice(listed.indexOf('<tr data-token="1"'))).toMatch(/revoked/);
    expect(listed).not.toContain((minted.json() as { token: string }).token);

    // With the MCP server off, the tab says how to turn it on instead.
    const off = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const offHtml = (await off.get('/settings/mcp-tokens')).body;
    expect(offHtml).toContain('<a href="/settings/install">');
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

    const html = (await w.get('/settings/history')).body;
    expect(html).toContain('<strong>History</strong>');
    const rev = (id: number) => rowIn(html, id);
    // Its changes, path by path; the zone add was guarded (its code runs with the Claude token).
    expect(rev(poll)).toContain('pollSeconds');
    expect(rev(poll)).not.toContain('class="mark guarded"');
    expect(rev(added)).toContain('class="mark guarded"');
    expect(rev(removed)).toContain('remove zone main');
    // Reverting to the revision that held the zone re-adds it: said on the button before it runs.
    expect(rev(added)).toMatch(
      /<button type="button" class="revert" data-id="\d+" data-readds="\[&quot;main&quot;\]">Revert<\/button>/,
    );
    expect(rev(added)).toContain('re-adds zone main');
    // The current revision has no Revert.
    expect(rev(removed)).not.toContain('class="revert"');

    // From a session this re-add sets a zone's image, which a session never does: refused, with
    // where to do it (the page says the same).
    const back = await w.call('POST', '/api/control/config/rollback', {
      id: added,
      expectRevision: removed,
      returnTo: '/settings/history',
      cancelTo: '/settings/history',
    });
    expect(back.statusCode).toBe(403);
    expect(back.json()).toMatchObject({ sessionForbidden: ['dropZones[main].image'] });
    // From ctl it applies, and history marks the re-add.
    expect((await w.token('POST', '/api/control/config/rollback', { id: added })).statusCode).toBe(
      200,
    );
    const again = (await w.get('/settings/history')).body;
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
    expect(rowIn((await w.get('/settings/history')).body, weak)).toContain('class="mark guarded"');
    const held = await w.call('POST', '/api/control/config/rollback', {
      id: weak,
      expectRevision: w.store.revision(),
      returnTo: '/settings/history',
      cancelTo: '/settings/history',
    });
    expect(held.statusCode).toBe(409);
    const confirm = await w.get((held.json() as { confirm: string }).confirm);
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('<a href="/settings/history">Cancel</a>');
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
    expect(asked).toContain('re-adds zone main');
    expect(s.calls).toEqual([
      {
        method: 'POST',
        path: '/api/control/config/rollback',
        body: {
          id: 2,
          expectRevision: 4,
          returnTo: '/settings/history',
          cancelTo: '/settings/history',
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
    const list = { innerHTML: '<p>No MCP tokens yet.</p>' };
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
    expect(list.innerHTML).toContain('my &lt;laptop&gt;');
    expect(list.innerHTML).toContain(
      '<button type="button" class="revoke" data-id="2">Revoke</button>',
    );
    expect(list.innerHTML).not.toContain('No MCP tokens yet');
    expect(list.innerHTML).not.toContain('jmm_shownonce');
    expect(reveal).toEqual({ textContent: 'jmm_shownonce', hidden: false });
    // The page holds the list in that container, so the script can replace it.
    const w = await world({ dbMode: true, doc: { mcp: { enabled: true }, dropZones: [ZONE] } });
    expect((await w.get('/settings/mcp-tokens')).body).toMatch(
      /<div id="token-list"><p>No MCP tokens yet.<\/p><\/div>/,
    );
  });

  test('B2: each boot setting names where its value really comes from, the default included', async () => {
    const bootRow = (html: string, path: string) => {
      const at = html.indexOf(`<tr data-boot="${path}"`);
      if (at < 0) throw new Error(`no boot row ${path}`);
      return html.slice(at, html.indexOf('</tr>', at));
    };
    // Db mode, no listen or data variable set: every row is the default, with how to set it.
    const none = (await (await world({ dbMode: true })).get('/settings/install')).body;
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
    const env = (await set.get('/settings/install')).body;
    for (const name of ['JM_LISTEN_HOST', 'JM_LISTEN_PORT', 'JM_ALLOWED_HOSTS', 'JM_DATA_DIR'])
      expect(env).toContain(`the environment: <code>${name}</code>`);
    expect(bootRow(env, 'listen.tlsTerminated')).toContain(
      'the environment: <code>JM_TLS_TERMINATED=1</code>',
    );
    // File mode, a file with dataDir and no listen: dataDir from the file, the listen rows default.
    const f = await world();
    const file = (await f.get('/settings/install')).body;
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
    const gHtml = (await g.get('/settings/install')).body;
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
    expect([r, went]).toEqual(['saved', '/settings/install?saved=9']);
    const w = await world({ dbMode: true, doc: { dropZones: [ZONE] } });
    const saved = (await w.get('/settings/install?saved=2')).body;
    expect(saved).toContain(
      '<p class="saved" role="status">Saved as revision 2: it takes effect at the next pass.</p>',
    );
    // Only a revision number is echoed; anything else says nothing.
    for (const q of ['?saved=<b>', '?saved=1e3', '?saved=', ''])
      expect((await w.get(`/settings/install${q}`)).body).not.toContain('class="saved"');
    // A save that needs a restart: the badge on the reloaded page says it.
    await w.token('PATCH', '/api/control/config', {
      patch: { mcp: { enabled: true } },
      expectRevision: w.store.revision(),
    });
    const after = (await w.get(`/settings/install?saved=${w.store.revision()}`)).body;
    expect(after).toContain(`Saved as revision ${w.store.revision()}`);
    expect(after).toContain('restart-pending');
  });

  test('B4: every Install control and the MCP form fields have an accessible name', async () => {
    const w = await world({ dbMode: true, doc: { mcp: { enabled: true }, dropZones: [ZONE] } });
    const html = (await w.get('/settings/install')).body;
    const controls = [...html.matchAll(/<(input|select)[^>]*data-path="([^"]+)"[^>]*>/g)];
    expect(controls.length).toBe(12);
    for (const [tag, , path] of controls) {
      const id = /id="([^"]+)"/.exec(tag as string)?.[1];
      expect([path, id]).toEqual([path, expect.any(String)]);
      expect(html).toContain(`<label for="${id}"><code>${path}</code></label>`);
    }
    const mcp = (await w.get('/settings/mcp-tokens')).body;
    const start = mcp.indexOf('<form id="mint">');
    const form = mcp.slice(start, mcp.indexOf('</form>', start));
    for (const name of ['zoneId', 'scope', 'days', 'label'])
      expect(form).toMatch(new RegExp(`<label>[A-Z][a-z]+ <(input|select)[^>]* name="${name}"`));
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
  vm.runInContext(script.replace(/^<script>|<\/script>$/g, ''), ctx);
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

function scriptContext(running: number) {
  const calls: Call[] = [];
  const ctx = vm.createContext({
    document: { addEventListener: () => {}, querySelectorAll: () => [] },
    encodeURIComponent,
    jmFetch: async (path: string, body: unknown, method?: string) => {
      calls.push({ method: method ?? 'POST', path, body });
      const json =
        method === 'PUT'
          ? {
              tested: true,
              runningDropsWithPrevious: running,
              hint: `${running} running drops still carry the previous token, and the pass running now keeps it until it ends: revoke it on GitHub after they finish`,
            }
          : { tested: true, result: 'ok' };
      return { ok: true, status: 200, json: async () => json };
    },
  });
  vm.runInContext(CREDENTIALS_SCRIPT.replace(/^<script>|<\/script>$/g, ''), ctx);
  return { ctx, calls };
}
