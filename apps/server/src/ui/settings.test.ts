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
import { operatorSession, plus, t0, tmpDbFile } from '../test/helpers.js';
import { fingerprintOf, openVault } from '../vault/vault.js';
import { CREDENTIALS_SCRIPT, TOKEN_BANNER_DAYS } from './settings.js';

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
  o: { env?: Record<string, string>; now?: Date; dbMode?: boolean; dbFile?: string } = {},
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
    call: (method: 'POST' | 'PUT', url: string, body: unknown) =>
      a.inject({ method, url, headers: api(), payload: body as object }),
  };
}

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
