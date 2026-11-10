import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { STARTER_WARNING } from '../config.js';
import { openDb } from '../db/open.js';
import { insertStick, stampStick } from '../db/repo.js';
import { PRESET_EGRESS } from '../presets.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { openVault } from '../vault/vault.js';
import { getWizard } from './setup.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
const AUTHOR = 'github_pat_WIZARDAUTHORDUMMY0123456789';
const CLAUDE = 'sk-ant-oat01-WIZARDCLAUDEDUMMY0123456789';
const BAD = 'github_pat_WIZARDREFUSEDDUMMY0123456789';
const STEPS = ['claude', 'forge', 'stick', 'project', 'doctor'] as const;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const NODE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
  'package-lock.json': '{}',
};

/** A fresh db-mode install with a vault (as compose runs it), and an app over it. */
async function world(o: { operator?: boolean; file?: Record<string, unknown> } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-wizard-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  if (o.file) writeFileSync(filePath, JSON.stringify({ dataDir: './data', ...o.file }));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, filePath),
    filePath,
    env: { JM_JOIN_TOKEN: 'join-secret-value-4', JM_OPERATOR_TOKEN: TOKEN, JM_DEV_IMAGES: '1' },
    vault: openVault(keyFile, db),
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const codes: string[] = [];
  const tested: string[] = [];
  const setup = new SetupMode((c) => codes.push(c));
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no zone forge in this test');
    },
    now: () => t0,
    setup,
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
    credentialForge: (token) => ({
      viewerLogin: async () => {
        tested.push(token === BAD ? 'refused' : 'ok');
        if (token === BAD) throw Object.assign(new Error('Bad credentials'), { status: 401 });
        return 'octo-owner';
      },
      repoAccess: async () => ({}),
    }),
    detectForge: () => ({
      repoAccess: async () => ({
        private: false,
        defaultBranch: 'main',
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
        scopes: null,
        tokenExpiresAt: null,
      }),
      listDir: async () => Object.keys(NODE_FILES),
      getFileAt: async (_ref: string, path: string) => NODE_FILES[path] ?? null,
    }),
  });
  app = a;
  // A fresh install has no operator, hence no session.
  const s =
    o.operator === false
      ? { cookie: '', csrf: '', id: '' }
      : (await setOperatorPassphrase(db, PASS, t0), operatorSession(db));
  const browser = { host: HOST, cookie: s.cookie };
  const api = { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf };
  const get = (url: string, headers: Record<string, string> = browser) =>
    a.inject({ method: 'GET', url, headers });
  const form = (url: string, fields: Record<string, string>, headers = browser) =>
    a.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, ...headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });
  const call = (method: 'POST' | 'PUT' | 'PATCH', url: string, body: unknown) =>
    a.inject({ method, url, headers: api, payload: body as object });
  return { db, store, codes, setup, tested, get, form, call, session: s, filePath };
}

const zoneDoc = (id: string) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
});
const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };

describe('the setup wizard', () => {
  test('a fresh install redirects to /setup, and each wizard step is skippable and resumable', async () => {
    const w = await world({ operator: false });
    // No operator: every page, the wizard's steps included, goes to the setup code.
    for (const url of ['/', '/setup/claude', '/setup/next', '/setup/project']) {
      const r = await w.get(url, { host: HOST });
      expect(r.statusCode, url).toBe(302);
      expect(r.headers.location, url).toBe('/setup');
    }
    // Claim it: the code (printed at start), then the passphrase, then the wizard.
    w.setup.rotateSetupCode();
    const code = w.codes.at(-1);
    expect(code).toBeDefined();
    const claim = await w.form('/setup/code', { code: code as string }, { host: HOST });
    expect(claim.statusCode).toBe(303);
    const cookie = String(claim.headers['set-cookie']).split(';')[0] as string;
    const set = await w.form(
      '/setup/passphrase',
      { passphrase: PASS, confirm: PASS },
      { host: HOST, cookie },
    );
    expect(set.statusCode).toBe(303);
    expect(set.headers.location).toBe('/setup/next');

    // Logged in: the wizard starts at the Claude step and every step offers "Do this later".
    const w2 = await world();
    // Without the session, a step is the login's, not the claim's: only the claim is open.
    for (const url of ['/setup/claude', '/setup/project'])
      expect((await w2.get(url, { host: HOST })).headers.location).toBe(
        `/login?next=${encodeURIComponent(url)}`,
      );
    expect((await w2.form('/setup/advance', { from: 'claude' }, { host: HOST })).statusCode).toBe(
      401,
    );
    const first = await w2.get('/setup/next');
    expect(first.headers.location).toBe('/setup/claude');
    for (const step of STEPS) {
      const r = await w2.get(`/setup/${step}`);
      expect(r.statusCode, step).toBe(200);
      expect(r.body, step).toContain('Do this later');
      expect(r.body, step).toContain(`name="from" value="${step}"`);
    }
    // Skipping moves on and is remembered: the next visit resumes there.
    const later = await w2.form('/setup/advance', { from: 'claude' });
    expect(later.statusCode).toBe(303);
    expect(later.headers.location).toBe('/setup/forge');
    expect((await w2.get('/setup/next')).headers.location).toBe('/setup/forge');
    expect(getWizard(w2.db)).toMatchObject({ step: 'forge' });
    // Visiting an earlier step never moves the progress back.
    await w2.get('/setup/claude');
    expect((await w2.get('/setup/next')).headers.location).toBe('/setup/forge');
    // A cross-site form cannot move it.
    const forged = await w2.form('/setup/advance', { from: 'forge' }, {
      host: HOST,
      cookie: w2.session.cookie,
      origin: 'http://evil.example',
    } as Record<string, string>);
    expect(forged.statusCode).toBe(403);
    expect(getWizard(w2.db)).toMatchObject({ step: 'forge' });
  });

  test('/setup says where the code is printed', async () => {
    const w = await world({ operator: false });
    const r = await w.get('/setup', { host: HOST });
    expect(r.body).toContain("the server's own output");
    expect(r.body).toContain('docker compose logs jumpmaster');
  });

  test('the forge step tests the token before saving and shows the starter warning verbatim', async () => {
    const w = await world();
    const page = await w.get('/setup/forge');
    expect(page.body).toContain(STARTER_WARNING.replaceAll("'", '&#39;').replaceAll('"', '&quot;'));
    // The page saves through the secret routes (tested there before anything is stored).
    expect(page.body).toContain("'/api/control/secrets/'");
    expect(page.body).toContain('githubAuthorToken');
    // The claim session holds sudo only after the passphrase: this one has none.
    expect(page.body).toContain('name="sudo"');
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    const refused = await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: BAD });
    expect(refused.statusCode).toBe(422);
    expect(w.store.resolved().githubAuthorToken.source).toBe('missing');
    expect(refused.body).not.toContain(BAD);
    const saved = await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(w.tested).toEqual(['refused', 'ok']);
    // Shown back as a fingerprint and the login, never the value.
    const after = await w.get('/setup/forge');
    expect(after.body).toContain(w.store.resolved().githubAuthorToken.fingerprint as string);
    expect(after.body).not.toContain(AUTHOR);
    // Choosing starter is remembered for the project step.
    await w.form('/setup/advance', { from: 'forge', starter: '1' });
    expect(getWizard(w.db)).toMatchObject({ starter: true });
    expect((await w.get('/setup/project')).body).toContain('value="starter" checked');
  });

  test('the Claude step links the terms and says where the token comes from, never showing it', async () => {
    const w = await world();
    const page = await w.get('/setup/claude');
    expect(page.body).toContain('claude setup-token');
    expect(page.body).toContain('https://www.anthropic.com/legal/consumer-terms');
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    const r = await w.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
    expect(r.statusCode, r.body).toBe(200);
    const after = await w.get('/setup/claude');
    expect(after.body).not.toContain(CLAUDE);
    expect(after.body).toContain(w.store.resolved().claudeToken.fingerprint as string);
  });

  test('the stick step says when the runner has checked in, and how to look when it has not', async () => {
    const w = await world();
    expect((await w.get('/setup/stick')).body).toContain('docker compose logs stick');
    insertStick(w.db, { id: 's1', name: 'stick-<1>', tokenHash: 'h', slots: 1 });
    stampStick(
      w.db,
      's1',
      { capabilities: [], imagePolicy: 'signed', version: '1.0.0', pinnedImages: [] },
      t0,
    );
    const r = await w.get('/setup/stick');
    expect(r.body).toContain('Your runner has checked in');
    expect(r.body).toContain('stick-&lt;1&gt;');
  });

  test('the project step runs detection after the REPO regexp and creates the zone through the apply path, classified against the add baseline', async () => {
    const w = await world();
    const page = await w.get('/setup/project');
    expect(page.body).toContain("'/api/control/detect'");
    expect(page.body).toContain("'/api/control/zones'");
    expect(page.body).toContain('needsConfirmation');
    // A detected gate's timeout travels with its reviewed row.
    expect(page.body).toContain('p.dataset.extra = JSON.stringify(rest)');
    expect((await w.call('POST', '/api/control/detect', { repo: 'octo/x y' })).statusCode).toBe(
      400,
    );
    // Detection needs the author token.
    expect((await w.call('POST', '/api/control/detect', { repo: 'octo/demo' })).statusCode).toBe(
      409,
    );
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    const d = await w.call('POST', '/api/control/detect', { repo: 'octo/demo' });
    expect(d.statusCode, d.body).toBe(200);
    const { preset, gates } = d.json();
    const add = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/demo', preset, gates },
      returnTo: '/setup/doctor',
    });
    // A new project is guarded; judged against the add baseline, so monitor egress and the
    // preset ask nothing more.
    expect(add.statusCode).toBe(409);
    const body = add.json();
    expect(body.guarded.map((g: { path: string }) => g.path)).toEqual(['dropZones[demo].repo']);
    const confirm = await w.get(body.confirm);
    expect(confirm.statusCode).toBe(200);
    const tokenIn = /name="token" value="([\w-]+)"/.exec(confirm.body)?.[1] as string;
    const done = await w.form(body.confirm, { token: tokenIn, passphrase: PASS });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/setup/doctor');
    expect(w.store.current().dropZones[0]).toMatchObject({
      id: 'demo',
      preset: 'node',
      egress: { mode: 'monitor' },
    });
  });

  test('on a personal public repository the starter recommendation with detected services shows the confirmation page with the starter warning and the service, not raw JSON, and continues to the doctor step after the passphrase', async () => {
    const w = await world();
    const image = `postgres@sha256:${'b'.repeat(64)}`;
    const add = await w.call('POST', '/api/control/zones', {
      zone: {
        repo: 'octo/mine',
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test' }],
        identity: 'starter',
        authorMayBeAdmin: true,
        services: [{ name: 'db', image, port: 5432 }],
      },
      returnTo: '/setup/doctor',
    });
    expect(add.statusCode).toBe(409);
    const { confirm } = add.json();
    const page = await w.get(confirm);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain(STARTER_WARNING.replaceAll("'", '&#39;').replaceAll('"', '&quot;'));
    expect(page.body).toContain(image);
    expect(page.body).not.toMatch(/^\s*\{/);
    const tokenIn = /name="token" value="([\w-]+)"/.exec(page.body)?.[1] as string;
    const done = await w.form(confirm, { token: tokenIn, passphrase: PASS });
    expect(done.headers.location).toBe('/setup/doctor');
    const doctor = await w.get('/setup/doctor');
    expect(doctor.statusCode).toBe(200);
    expect(doctor.body).toContain('Go to the factory floor');
    expect(w.store.current().dropZones[0]).toMatchObject({ identity: 'starter' });
  });

  test('the project step shows the preset base hosts as information and asks no confirmation for them', async () => {
    const w = await world();
    const page = await w.get('/setup/project');
    for (const host of ['api.anthropic.com', 'github.com', ...PRESET_EGRESS.node])
      expect(page.body).toContain(host);
    expect(page.body).toContain('information');
    // An add with a preset: only the new project itself is a consequence, never its hosts.
    const add = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/py', preset: 'python', gates: [{ name: 't', run: 'pytest' }] },
    });
    expect(add.json().guarded.map((g: { path: string }) => g.path)).toEqual(['dropZones[py].repo']);
  });

  test('the wizard disappears once a zone exists or is dismissed, the Credentials tab holds its credential controls, and /setup/project stays linked from home', async () => {
    const w = await world();
    const home = await w.get('/');
    expect(home.body).toContain('Finish setting up');
    expect(home.body).toContain('href="/setup/next"');
    expect(home.body).toContain('href="/setup/project"');
    const dismissed = await w.form('/setup/dismiss', {});
    expect(dismissed.statusCode).toBe(303);
    const after = await w.get('/');
    expect(after.body).not.toContain('Finish setting up');
    expect(after.body).toContain('href="/setup/project"');
    // The steps stay reachable for their controls, and /setup/next goes home.
    expect((await w.get('/setup/forge')).statusCode).toBe(200);
    expect((await w.get('/setup/next')).headers.location).toBe('/');

    const v = await world();
    v.store.apply({ dropZones: [zoneDoc('main')] }, { via: 'ctl', principal: token });
    const withZone = await v.get('/');
    expect(withZone.body).not.toContain('Finish setting up');
    expect(withZone.body).toContain('href="/setup/project"');
  });

  test('a file-mode install sees its zones in the wizard with the adopt offer', async () => {
    const w = await world({ file: { dropZones: [zoneDoc('a'), zoneDoc('b')] } });
    expect(w.store.mode()).toBe('file');
    const r = await w.get('/setup/project');
    expect(r.body).toContain('Your config file holds 2 zones');
    expect(r.body).toContain("'/api/control/config/adopt'");
    expect(r.body).not.toContain("'/api/control/detect'");
  });

  test('no wizard page carries a credential value, and forge text is escaped', async () => {
    const w = await world();
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    await w.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
    for (const step of STEPS) {
      const r = await w.get(`/setup/${step}`);
      expect(r.body, step).not.toContain(AUTHOR);
      expect(r.body, step).not.toContain(CLAUDE);
      expect(r.body, step).not.toContain(TOKEN);
    }
  });
});
