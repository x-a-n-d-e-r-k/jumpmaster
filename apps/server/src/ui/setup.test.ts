import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { RecommendAnswer } from '../api/github.js';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { STARTER_WARNING } from '../config.js';
import { openDb } from '../db/open.js';
import { insertStick, stampStick } from '../db/repo.js';
import { DOC } from '../doctor/checks.js';
import { USE_PERMISSIONS } from '../forge/github-app.js';
import { recommendIdentity } from '../github/guidance.js';
import { PRESET_EGRESS } from '../presets.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { appEntryName, serializeAppEntry } from '../vault/github-app-entries.js';
import { openVault } from '../vault/vault.js';
import { NO_AUTHOR } from '../zones/detect.js';
import type { DetectAppBroker } from '../zones/detect-app.js';
import { appCreateSection } from './github.js';
import { escapeHtml } from './pages.js';
import { getWizard, guideSection, SAVE_CREDENTIALS } from './setup.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
const AUTHOR = 'github_pat_' + 'WIZARDAUTHORDUMMY0123456789';
const CLAUDE = 'sk-ant-' + 'oat01-WIZARDCLAUDEDUMMY0123456789';
const BAD = 'github_pat_' + 'WIZARDREFUSEDDUMMY0123456789';
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
async function world(
  o: {
    operator?: boolean;
    file?: Record<string, unknown>;
    /** What GitHub says of the repository the guidance asks about. */
    github?: { ownerType?: 'User' | 'Organization'; private?: boolean };
    /** The broker detection reads through on the owner's author app (#549). */
    appBroker?: DetectAppBroker;
    /** A secrets directory (`JM_SECRETS_DIR`), for file-sourced app entries (#597). */
    secretsDir?: string;
    /** No vault key file: the vault is disabled (#597). */
    noVault?: boolean;
  } = {},
) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-wizard-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  if (o.file) writeFileSync(filePath, JSON.stringify({ dataDir: './data', ...o.file }));
  const store = ConfigStore.open({
    db,
    boot: loadBoot(o.secretsDir ? { JM_SECRETS_DIR: o.secretsDir } : {}, filePath),
    filePath,
    env: { JM_JOIN_TOKEN: 'join-secret-value-4', JM_OPERATOR_TOKEN: TOKEN, JM_DEV_IMAGES: '1' },
    vault: openVault(o.noVault ? undefined : keyFile, db),
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  const codes: string[] = [];
  const tested: string[] = [];
  /** Each token detection read the repository with. */
  const detectTokens: string[] = [];
  const logs: string[] = [];
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
    log: (m) => logs.push(m),
    ...(o.appBroker ? { detectAppBroker: () => o.appBroker as DetectAppBroker } : {}),
    detectForge: (_repo: string, t: string) => ({
      repoAccess: async () => {
        detectTokens.push(t);
        return {
          private: false,
          defaultBranch: 'main',
          permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
          scopes: null,
          tokenExpiresAt: null,
        };
      },
      listDir: async () => Object.keys(NODE_FILES),
      getFileAt: async (_ref: string, path: string) => NODE_FILES[path] ?? null,
    }),
    guidanceForge: (_repo: string, token: string) => ({
      repoAccess: async () => {
        // Without a token GitHub hides a private repository.
        if (token === '' && o.github?.private)
          throw Object.assign(new Error('Not Found'), { status: 404 });
        return {
          private: o.github?.private ?? false,
          defaultBranch: 'main',
          permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
          scopes: null,
          tokenExpiresAt: null,
          ownerType: o.github?.ownerType ?? 'User',
        };
      },
      ownerType: async () => o.github?.ownerType ?? 'User',
      viewerLogin: async () => 'octo-owner',
      listDir: async (_ref: string, path: string) =>
        path === '.github/workflows' ? ['ci.yml'] : Object.keys(NODE_FILES),
      getFileAt: async (_ref: string, path: string) =>
        path === '.github/workflows/ci.yml'
          ? 'on: pull_request\njobs:\n  test:\n    runs-on: x\n'
          : (NODE_FILES[path] ?? null),
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
  return {
    db,
    store,
    codes,
    setup,
    tested,
    detectTokens,
    logs,
    get,
    form,
    call,
    session: s,
    filePath,
  };
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
    // Skipping moves on and is remembered, but resuming judges the install: the Claude token is
    // still unset, so the next visit comes back to it (round 2, B4).
    const later = await w2.form('/setup/advance', { from: 'claude' });
    expect(later.statusCode).toBe(303);
    expect(later.headers.location).toBe('/setup/forge');
    expect(getWizard(w2.db)).toMatchObject({ step: 'forge' });
    expect((await w2.get('/setup/next')).headers.location).toBe('/setup/claude');
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
    expect(doctor.body).toContain('Go to Home');
    // The last step says how the install survives a reboot.
    expect(doctor.body).toContain(`${DOC}#start-at-boot`);
    expect(doctor.body).toContain('docker compose up -d');
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

  test('the wizard disappears once a zone exists or is dismissed, the Credentials tab holds its credential controls, and home links Add a project (now /projects/new, Task 11)', async () => {
    const w = await world();
    const home = await w.get('/');
    expect(home.body).toContain('Finish setting up');
    expect(home.body).toContain('href="/setup/next"');
    expect(home.body).toContain('href="/projects/new"');
    const dismissed = await w.form('/setup/dismiss', {});
    expect(dismissed.statusCode).toBe(303);
    const after = await w.get('/');
    expect(after.body).not.toContain('Finish setting up');
    expect(after.body).toContain('href="/projects/new"');
    // The steps stay reachable for their controls, and /setup/next goes home.
    expect((await w.get('/setup/forge')).statusCode).toBe(200);
    expect((await w.get('/setup/next')).headers.location).toBe('/');

    const v = await world();
    v.store.apply({ dropZones: [zoneDoc('main')] }, { via: 'ctl', principal: token });
    const withZone = await v.get('/');
    expect(withZone.body).not.toContain('Finish setting up');
    expect(withZone.body).toContain('href="/projects/new"');
  });

  test("the doctor step names a check's zone by repository (#99)", async () => {
    const w = await world({ file: { dropZones: [zoneDoc('a')] } });
    w.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(JSON.stringify([{ id: 'zone.clone', zoneId: 'a', status: 'fail', summary: 's' }]));
    const r = (await w.get('/setup/doctor')).body;
    expect(r).toContain('<strong>FAIL</strong> octo/a <code>zone.clone</code>');
  });

  test('a file-mode install sees its zones in the wizard with the adopt offer', async () => {
    const w = await world({ file: { dropZones: [zoneDoc('a'), zoneDoc('b')] } });
    expect(w.store.mode()).toBe('file');
    const r = await w.get('/setup/project');
    expect(r.body).toContain('Your config file holds 2 projects: octo/a, octo/b.');
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

type Answer = { status: number; body: Record<string, unknown> };
type El = { textContent: string; hidden?: boolean; disabled?: boolean };
/** Runs the page's credential-saving script against stub fields: the browser path, without one. */
function runSave(
  fields: Record<string, string>,
  answer: (path: string) => Answer = () => ({ status: 200, body: {} }),
  sudoHidden = false,
) {
  const fetched: string[] = [];
  const out = { textContent: '' };
  const wrap = { hidden: true };
  const focused: string[] = [];
  const scrolled: string[] = [];
  /** Each field's own answer, beneath it; each credential's status line; the Continue button. */
  const fieldOut: Record<string, El> = {};
  const status: Record<string, El> = {};
  const continueButton: El = { textContent: 'Continue', disabled: true };
  const inputs = Object.entries(fields).map(([name, value]) => {
    fieldOut[name] = { textContent: '' };
    status[name] = { textContent: 'Not set yet.' };
    return {
      name,
      value,
      type: 'password',
      disabled: name === 'sudo' && sudoHidden,
      closest: () => wrap,
      focus: () => focused.push(name),
      scrollIntoView: () => scrolled.push(name),
    };
  });
  const attr = (sel: string, a: string) => new RegExp(`\\[${a}="?([A-Za-z]+)"?\\]`).exec(sel)?.[1];
  const form = {
    querySelector: (sel: string) => {
      if (sel === 'input[name=sudo]') return inputs.find((i) => i.name === 'sudo') ?? null;
      const n = attr(sel, 'data-out-for');
      return n ? (fieldOut[n] ?? null) : null;
    },
    querySelectorAll: () => inputs.filter((i) => i.name !== 'sudo'),
  };
  const ctx = vm.createContext({
    document: {
      querySelector: (sel: string) => {
        if (sel.includes('value=continue')) return continueButton;
        const n = attr(sel, 'data-credential');
        return n ? (status[n] ?? null) : null;
      },
    },
    jmFetch: async (path: string) => {
      fetched.push(path);
      const a = answer(path);
      return { ok: a.status < 300, status: a.status, json: async () => a.body };
    },
  });
  vm.runInContext(SAVE_CREDENTIALS.replace(/^<script>|<\/script>$/g, ''), ctx);
  return {
    fetched,
    out,
    wrap,
    focused,
    scrolled,
    fieldOut,
    status,
    continueButton,
    value: (name: string) => inputs.find((i) => i.name === name)?.value,
    result: (ctx.jmSaveCredentials as (f: unknown, o: unknown) => Promise<unknown>)(form, out),
  };
}

describe('the wizard after the sudo window lapses (T10 finding 3)', () => {
  test('a sudo refusal shows the passphrase field, says why, and keeps every token typed', async () => {
    const s = runSave(
      { githubAuthorToken: AUTHOR, githubReviewerToken: 'reviewer-value-123456', sudo: '' },
      () => ({
        status: 403,
        body: { error: 'saving a credential asks for your passphrase again', sudo: 'required' },
      }),
    );
    expect(await s.result).toBe('sudo');
    expect(s.wrap.hidden).toBe(false);
    expect(s.focused).toEqual(['sudo']);
    expect(s.out.textContent).toBe(
      'Saving a credential asks for your passphrase again: enter it above, then Save.',
    );
    // Nothing the operator typed is lost.
    expect(s.value('githubAuthorToken')).toBe(AUTHOR);
    expect(s.value('githubReviewerToken')).toBe('reviewer-value-123456');
  });

  test('a refused token keeps its value and the ones after it; a saved one is cleared', async () => {
    const s = runSave(
      { githubAuthorToken: AUTHOR, githubReviewerToken: 'reviewer-value-123456', sudo: PASS },
      (path) =>
        path.endsWith('githubReviewerToken')
          ? { status: 422, body: { tested: false, status: 401 } }
          : { status: 200, body: {} },
    );
    expect(await s.result).toBe(false);
    expect(s.value('githubAuthorToken')).toBe('');
    expect(s.value('githubReviewerToken')).toBe('reviewer-value-123456');
  });

  test('the forge step always carries the passphrase field, hidden and disabled while sudo is fresh', async () => {
    const w = await world();
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    const body = (await w.get('/setup/forge')).body;
    // Disabled while hidden, so a password manager cannot fill it unseen.
    expect(body).toMatch(
      /<p class="sudo" hidden><label>Your passphrase[^<]*<input type="password" name="sudo" autocomplete="current-password" disabled>/,
    );
  });

  test('a hidden, autofilled passphrase field is not sent; a refused passphrase shows the field', async () => {
    const hidden = runSave({ githubAuthorToken: AUTHOR, sudo: 'autofilled' }, undefined, true);
    expect(await hidden.result).toBe('saved');
    expect(hidden.fetched).toEqual(['/api/control/secrets/githubAuthorToken']);
    const wrong = runSave({ githubAuthorToken: AUTHOR, sudo: 'wrong-passphrase' }, (path) =>
      path === '/api/control/sudo' ? { status: 401, body: {} } : { status: 200, body: {} },
    );
    expect(await wrong.result).toBe(false);
    expect(wrong.wrap.hidden).toBe(false);
    expect(wrong.focused).toEqual(['sudo']);
    expect(wrong.value('githubAuthorToken')).toBe(AUTHOR);
  });

  test("a refusal names the field by its label once, without the route's status beside GitHub's", async () => {
    const s = runSave({ githubAuthorToken: AUTHOR, sudo: PASS }, (path) =>
      path.endsWith('githubAuthorToken')
        ? {
            status: 422,
            body: { tested: false, status: 401, error: 'GitHub rejected this token (401): x.' },
          }
        : { status: 200, body: {} },
    );
    expect(await s.result).toBe(false);
    expect(s.out.textContent).toBe(
      'The author token was not saved: GitHub rejected this token (401): x.',
    );
  });
});

describe('the wizard, round 2', () => {
  test('Save with no value says to enter a token first and never moves on; only Continue and Do this later do', async () => {
    const empty = runSave({ claudeToken: '', sudo: '' });
    expect(await empty.result).toBe('empty');
    expect(empty.out.textContent).toBe('Enter a token first.');
    expect(empty.fetched).toEqual([]);
    // The route tested the GitHub token: its answer says so.
    const filled = runSave(
      { githubAuthorToken: AUTHOR, githubReviewerToken: '', sudo: PASS },
      () => ({
        status: 200,
        body: { tested: true },
      }),
    );
    expect(await filled.result).toBe('saved');
    expect(filled.fetched).toEqual(['/api/control/sudo', '/api/control/secrets/githubAuthorToken']);
    expect(filled.out.textContent).toBe('Saved and tested.');
    // No step's script clicks Continue for the operator.
    const w = await world();
    for (const step of STEPS) {
      const body = (await w.get(`/setup/${step}`)).body;
      expect(body, step).not.toContain('.click()');
    }
    // The starter choice is part of Continue, not of Save: shown above the fields, sent with Continue.
    const forge = (await w.get('/setup/forge')).body;
    expect(forge).toMatch(/<input type="checkbox" name="starter" value="1" form="advance"/);
    const save = forge.slice(forge.indexOf('<form id="forge"'));
    expect(save.slice(0, save.indexOf('</form>'))).not.toContain('name="starter"');
  });

  test('every pattern attribute in the pages compiles under the v flag, as browsers compile it', async () => {
    const w = await world();
    const pages = [...STEPS.map((s) => `/setup/${s}`), '/', '/system'];
    const found: string[] = [];
    for (const url of pages) {
      const body = (await w.get(url)).body;
      for (const m of body.matchAll(/pattern="([^"]*)"/g)) {
        const p = (m[1] as string).replaceAll('&amp;', '&').replaceAll('&quot;', '"');
        found.push(p);
        expect(() => new RegExp(`^(?:${p})$`, 'v'), `${url}: ${p}`).not.toThrow();
      }
    }
    expect(found.length).toBeGreaterThan(0);
    const repo = new RegExp(`^(?:${found[0]})$`, 'v');
    expect(repo.test('octo/demo.js')).toBe(true);
    expect(repo.test('octo/de mo')).toBe(false);
  });

  test('/setup/next resumes at the first step the install still lacks, and a bare /setup after the claim goes there', async () => {
    const w = await world();
    // Every step deferred: still Claude, since there is no Claude token.
    for (const from of STEPS) await w.form('/setup/advance', { from });
    expect((await w.get('/setup/next')).headers.location).toBe('/setup/claude');
    expect((await w.get('/setup')).headers.location).toBe('/setup/next');
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
    expect((await w.get('/setup/next')).headers.location).toBe('/setup/forge');
    await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    expect((await w.get('/setup/next')).headers.location).toBe('/setup/stick');
    insertStick(w.db, { id: 's1', name: 's', tokenHash: 'h', slots: 1 });
    stampStick(
      w.db,
      's1',
      { capabilities: [], imagePolicy: 'signed', version: null, pinnedImages: [] },
      t0,
    );
    expect((await w.get('/setup/next')).headers.location).toBe('/setup/project');
    w.store.apply({ dropZones: [zoneDoc('main')] }, { via: 'ctl', principal: token });
    // A zone exists: the wizard is over, and next is home.
    expect((await w.get('/setup/next')).headers.location).toBe('/');
  });

  test('the project step links the forge step from a detection that needs the token, refuses no checks, and the plan save reads the revision', async () => {
    const w = await world();
    const project = (await w.get('/setup/project')).body;
    expect(project).toContain("a.href = '/setup/forge'");
    expect(project).toContain('Add at least one check.');
    const claude = (await w.get('/setup/claude')).body;
    // The revision is read when the plan is saved, not when the page was rendered.
    expect(claude).toContain("await fetch('/api/control/config')");
    expect(claude).not.toMatch(/expectRevision: \d/);
  });

  test('every plan has a prose label, here and in Settings, and the stored values are unchanged', async () => {
    const w = await world();
    for (const url of ['/setup/claude', '/system/credentials']) {
      const html = (await w.get(url)).body;
      const select = /<select name="plan">(.*?)<\/select>/s.exec(html)?.[1] ?? '';
      const options = [...select.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)];
      expect(
        options.map((o) => o[1]),
        url,
      ).toEqual(['pro', 'max', 'ultra', 'team_standard', 'team_premium', 'enterprise']);
      for (const [, value, label] of options) expect(label, `${url} ${value}`).not.toBe(value);
      expect(
        options.map((o) => o[2]),
        url,
      ).toEqual([
        'Pro',
        'Max ($100/mo)',
        'Ultra ($200/mo)',
        'Team (standard seat)',
        'Team (premium seat)',
        'Enterprise',
      ]);
    }
    // The Claude token field shows what a token looks like.
    expect((await w.get('/setup/claude')).body).toMatch(
      /<input type="password" name="claudeToken" placeholder="sk-ant-oat01-…"/,
    );
  });

  test('the Claude step offers Ultra ($200/mo), and a saved ultra plan is selected on reload (#144)', async () => {
    const w = await world();
    expect((await w.get('/setup/claude')).body).toContain(
      '<option value="ultra">Ultra ($200/mo)</option>',
    );
    const r = await w.call('PATCH', '/api/control/config', {
      patch: { claude: { plan: 'ultra' } },
      expectRevision: w.store.revision(),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(w.store.current().claude.plan).toBe('ultra');
    expect((await w.get('/setup/claude')).body).toContain(
      '<option value="ultra" selected>Ultra ($200/mo)</option>',
    );
  });

  test('the project step offers the GitHub step as a button-styled link when the author token is missing', async () => {
    const w = await world();
    const project = (await w.get('/setup/project')).body;
    expect(project).toContain("a.href = '/setup/forge'; a.className = 'button primary'");
  });

  test('a wizard add says it is part of setup, and Cancel goes back to the project step', async () => {
    const w = await world();
    const add = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/demo', preset: 'node', gates: [{ name: 'test', run: 'npm test' }] },
      returnTo: '/setup/doctor',
      cancelTo: '/setup/project',
    });
    const page = await w.get(add.json().confirm);
    expect(page.body).toContain('This is part of setting up Jumpmaster.');
    expect(page.body).toContain('<a href="/setup/project">Cancel</a>');
    // A cancelTo off this host is ignored for the home page.
    const other = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/other', preset: 'node', gates: [{ name: 'test', run: 'npm test' }] },
      cancelTo: '//evil.example/x',
    });
    const page2 = await w.get(other.json().confirm);
    expect(page2.body).toContain('<a href="/">Cancel</a>');
    expect(page2.body).not.toContain('part of setting up');
    expect(page2.body).not.toContain('evil.example');
  });
});

describe('GitHub guidance in the wizard (Task 7)', () => {
  test('the forge step shows the recommendation before the fields and the project step shows the ruleset file and CODEOWNERS', async () => {
    const w = await world({ operator: true });
    // Before a repository is named: the question comes before the token fields.
    const blank = (await w.get('/setup/forge')).body;
    expect(blank.indexOf('id="recommend-form"')).toBeGreaterThan(-1);
    expect(blank.indexOf('id="recommend-form"')).toBeLessThan(
      blank.indexOf('name="githubAuthorToken"'),
    );
    // A personal public repository, before any token: two GitHub Apps, read without a token.
    const forge = (await w.get('/setup/forge?repo=octo%2Fdemo')).body;
    const rec = forge.indexOf('id="recommendation"');
    expect(rec).toBeGreaterThan(-1);
    expect(rec).toBeLessThan(forge.indexOf('id="github-apps"'));
    expect(forge.indexOf('id="github-apps"')).toBeLessThan(forge.indexOf('id="use-tokens"'));
    expect(forge.indexOf('id="use-tokens"')).toBeLessThan(forge.indexOf('id="tokens"'));
    expect(forge.indexOf('id="tokens"')).toBeLessThan(forge.indexOf('name="githubAuthorToken"'));
    expect(forge).toContain('Two bot accounts as GitHub Apps');
    // The starter cost, once on the step: in the recommendation, not again beside the box.
    const escaped = STARTER_WARNING.replaceAll("'", '&#39;').replaceAll('"', '&quot;');
    expect(forge.split(escaped)).toHaveLength(2);
    expect(forge).not.toContain('id="starter-warning"');
    expect(forge).toContain('href="https://github.com/settings/personal-access-tokens/new?');
    expect(forge).toContain(
      'check the Resource owner field: for an organization it may not pre-fill',
    );
    // Two bots are recommended: the starter box is left for the operator to choose.
    expect(forge).toMatch(/name="starter" value="1" form="advance">/);
    // The checklist, once the author token resolves a login.
    expect(forge).not.toContain('id="checklist"');
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    expect(
      (await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR })).statusCode,
    ).toBe(200);
    const after = (await w.get('/setup/forge?repo=octo%2Fdemo')).body;
    expect(after).toContain('id="checklist"');
    expect(after).toContain('invite octo-owner with the Write role');
    expect(after).not.toContain(AUTHOR);

    // The project step loads the ruleset and CODEOWNERS for the repository it detected.
    const project = (await w.get('/setup/project')).body;
    expect(project).toContain('id="guidance"');
    expect(project).toContain("'/setup/project/github?'");
    const frag = await w.get(
      '/setup/project/github?repo=octo%2Fdemo&identity=two-bot&reviewer=alice',
    );
    expect(frag.statusCode, frag.body).toBe(200);
    expect(frag.body).toContain('id="ruleset"');
    expect(frag.body).toContain('Import a ruleset');
    expect(frag.body).toContain('&quot;required_approving_review_count&quot;: 1');
    expect(frag.body).toContain('id="codeowners"');
    expect(frag.body).toContain('.github/** @alice');
    expect(frag.body).not.toContain(AUTHOR);
    expect((await w.get('/setup/project/github?repo=octo%2Fde%20mo')).statusCode).toBe(400);
  });

  test('a private repository asks about the plan first, and a free plan stops before any token', async () => {
    const w = await world({ github: { ownerType: 'Organization', private: true } });
    const ask = (await w.get('/setup/forge?repo=octo-org%2Fsecret')).body;
    expect(ask).toContain('data-ask');
    expect(ask).toContain('name="paidPlan"');
    expect(ask).toContain('Two bot accounts');
    const stop = (await w.get('/setup/forge?repo=octo-org%2Fsecret&paidPlan=no')).body;
    expect(stop).toContain('data-stop');
    expect(stop).toContain(
      'need a paid plan: make it public or upgrade before any token is created',
    );
    // Stopped: no token links to follow yet.
    expect(stop).not.toContain('id="tokens"');
    const paid = (await w.get('/setup/forge?repo=octo-org%2Fsecret&paidPlan=yes')).body;
    expect(paid).not.toContain('data-stop');
    expect(paid).toContain('id="tokens"');
    // The read token joins the links for a private repository.
    expect(paid).toContain('The read token');
  });
});

describe('the wizard says what it checked (#161)', () => {
  const FAKE_CLAUDE = 'sk-ant-oat01-fake000';
  const CLAUDE_SAVED = 'Saved. The format is right; Claude is first contacted by the first drop.';

  test('a Claude token save contacts no one and says so; a GitHub token save tests it', async () => {
    const w = await world();
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    const claude = await w.call('PUT', '/api/control/secrets/claudeToken', { value: FAKE_CLAUDE });
    expect(claude.statusCode, claude.body).toBe(200);
    expect(claude.json()).toMatchObject({ tested: false });
    expect(claude.json().fingerprint).toEqual(expect.any(String));
    expect(claude.json().setAt).toEqual(expect.any(String));
    // Nothing contacted GitHub (or anyone) for it.
    expect(w.tested).toEqual([]);
    const github = await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    expect(github.statusCode, github.body).toBe(200);
    expect(github.json()).toMatchObject({ tested: true, login: 'octo-owner' });
    expect(w.tested).toEqual(['ok']);
  });

  test("the save script's wording is keyed on the route's tested", async () => {
    expect(SAVE_CREDENTIALS).toContain(CLAUDE_SAVED);
    expect(SAVE_CREDENTIALS).toContain('Saved and tested.');
    expect(SAVE_CREDENTIALS).toMatch(/j\.tested \?/);
    const claude = runSave({ claudeToken: FAKE_CLAUDE, sudo: PASS }, () => ({
      status: 200,
      body: { tested: false, fingerprint: 'abcd1234', setAt: '2026-11-16T10:00:00.000Z' },
    }));
    expect(await claude.result).toBe('saved');
    expect(claude.out.textContent).toBe(CLAUDE_SAVED);
    expect(claude.fieldOut.claudeToken?.textContent).toBe(CLAUDE_SAVED);
    expect(claude.out.textContent).not.toContain('tested');
    const github = runSave({ githubAuthorToken: AUTHOR, sudo: PASS }, () => ({
      status: 200,
      body: { tested: true, fingerprint: 'ef567890', setAt: '2026-11-16T10:00:00.000Z' },
    }));
    expect(await github.result).toBe('saved');
    expect(github.out.textContent).toBe('Saved and tested.');
    expect(github.fieldOut.githubAuthorToken?.textContent).toBe('Saved and tested.');
  });

  test('after a save the status line shows the new state and Continue is enabled, with no reload', async () => {
    const s = runSave({ claudeToken: FAKE_CLAUDE, sudo: PASS }, () => ({
      status: 200,
      body: { tested: false, fingerprint: 'abcd1234', setAt: '2026-11-16T10:00:00.000Z' },
    }));
    expect(s.status.claudeToken?.textContent).toBe('Not set yet.');
    await s.result;
    expect(s.status.claudeToken?.textContent).toBe(
      'Set: fingerprint abcd1234, saved 2026-11-16; kept in the encrypted vault.',
    );
    expect(s.continueButton.disabled).toBe(false);
    const g = runSave({ githubAuthorToken: AUTHOR, sudo: PASS }, () => ({
      status: 200,
      body: { tested: true, fingerprint: 'ef56', login: 'octo-owner', setAt: '2026-11-16T10:00Z' },
    }));
    await g.result;
    expect(g.status.githubAuthorToken?.textContent).toBe(
      'Set: fingerprint ef56, account octo-owner, saved 2026-11-16; kept in the encrypted vault.',
    );
  });

  test('an error shows beneath its own field, which is scrolled into view and focused', async () => {
    const s = runSave(
      { githubAuthorToken: AUTHOR, githubReviewerToken: 'reviewer-value-1', sudo: PASS },
      (path) =>
        path.endsWith('githubReviewerToken')
          ? {
              status: 422,
              body: { tested: false, status: 401, error: 'GitHub rejected this token (401).' },
            }
          : { status: 200, body: { tested: true, fingerprint: 'f1' } },
    );
    expect(await s.result).toBe(false);
    const said = 'The reviewer token was not saved: GitHub rejected this token (401).';
    expect(s.fieldOut.githubReviewerToken?.textContent).toBe(said);
    expect(s.fieldOut.githubAuthorToken?.textContent).toBe('Saved and tested.');
    expect(s.scrolled).toEqual(['githubReviewerToken']);
    expect(s.focused).toEqual(['githubReviewerToken']);
    // Each field on the page has its own answer slot.
    const w = await world();
    const forge = (await w.get('/setup/forge')).body;
    for (const name of ['githubAuthorToken', 'githubReviewerToken', 'githubReadToken'])
      expect(forge).toMatch(
        new RegExp(
          `name="${name}"[^>]*></label>\\s*<small class="field-out" data-out-for="${name}" role="status"></small>`,
        ),
      );
  });

  test('the forge step speaks plain words and puts the mode above the token fields', async () => {
    const w = await world({ github: { ownerType: 'User' } });
    // The operator chose starter: its words come with the token links, still in plain words.
    await w.form('/setup/advance', { from: 'forge', starter: '1' });
    const forge = (await w.get('/setup/forge?repo=octo%2Fdemo')).body;
    expect(forge).toContain('one account');
    const visible = forge.replace(/name="[^"]*"/g, '');
    expect(visible).not.toMatch(/\bauthorMayBeAdmin\b/);
    const text = forge
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]*>/g, ' ');
    expect(text.match(/\b[a-z]+[A-Z][A-Za-z]*\b/g) ?? []).toEqual([]);
    expect(forge.indexOf('name="starter"')).toBeGreaterThan(-1);
    expect(forge.indexOf('name="starter"')).toBeLessThan(forge.indexOf('name="githubAuthorToken"'));
  });
});

describe('creating the GitHub Apps from the forge step (#374, spec §4.1)', () => {
  /** The start forms of a page, each as its hidden fields. */
  const startForms = (html: string): Record<string, string>[] =>
    [
      ...html.matchAll(/<form method="post" action="\/setup\/github-app\/start"[\s\S]*?<\/form>/g),
    ].map((m) =>
      Object.fromEntries(
        [...m[0].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((f) => [
          f[1] as string,
          f[2] as string,
        ]),
      ),
    );
  const SUDO_FIELD =
    '<p class="sudo"><label>Your passphrase (saving a credential asks for it again) <input type="password" name="sudo" autocomplete="current-password"></label></p><p><button>Save</button> <span id="forge-out" role="status"></span></p></form>';

  test('a two-bot guide shows the author and reviewer forms beside the token fields', async () => {
    const w = await world({ github: { ownerType: 'Organization' } });
    const forge = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    expect(startForms(forge)).toEqual([
      { role: 'author', owner: 'octo-org', ownerType: 'Organization' },
      { role: 'reviewer', owner: 'octo-org', ownerType: 'Organization' },
    ]);
    expect(forge).toContain('needs an owner or app manager of that organization');
    // Without sudo: wired to the step's passphrase field, which is on the page.
    expect(forge).toContain('data-sudo-first');
    expect(forge).toContain('form.app-create[data-sudo-first]');
    expect(forge).toContain(SUDO_FIELD);
    // PAT mode is untouched: the token links, fields and the starter warning are still there.
    expect(forge).toContain('id="tokens"');
    expect(forge).toContain('name="githubAuthorToken"');
    expect(forge).toContain('id="starter-warning"');
    // With sudo the buttons submit at once.
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    const held = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    expect(startForms(held)).toHaveLength(2);
    expect(held).not.toContain('data-sudo-first');
  });

  test('a starter choice renders no create buttons and the token part as before, not folded', async () => {
    const w = await world({ github: { ownerType: 'User' } });
    await w.form('/setup/advance', { from: 'forge', starter: '1' });
    const forge = (await w.get('/setup/forge?repo=octo%2Fdemo')).body;
    expect(forge).not.toContain('/setup/github-app/start');
    expect(forge).not.toContain('github-apps');
    expect(forge).toContain('id="tokens"');
    expect(forge).not.toContain('id="use-tokens"');
    const tokens = forge.slice(
      forge.indexOf('id="tokens"'),
      forge.indexOf('</section>', forge.indexOf('id="tokens"')),
    );
    expect(tokens).toContain('The author token');
    expect(tokens).not.toContain('The reviewer token');
    expect(forge).toMatch(/name="starter" value="1" form="advance" checked/);
    expect(forge).toContain(SUDO_FIELD);
    expect(forge).not.toContain('id="starter-warning"');
    const escaped = STARTER_WARNING.replaceAll("'", '&#39;').replaceAll('"', '&quot;');
    expect(forge.split(escaped)).toHaveLength(2);
    for (const name of ['githubAuthorToken', 'githubReviewerToken', 'githubReadToken'])
      expect(forge).toContain(
        `<input type="password" name="${name}" autocomplete="off" spellcheck="false"></label>`,
      );
  });

  test('a stopped guide (a private repository on a free plan) renders no create buttons', async () => {
    const w = await world({ github: { ownerType: 'Organization', private: true } });
    const stop = (await w.get('/setup/forge?repo=octo-org%2Fsecret&paidPlan=no')).body;
    expect(stop).toContain('data-stop');
    expect(stop).not.toContain('/setup/github-app/start');
  });

  test("end to end: the rendered author form's fields start the manifest flow for that owner", async () => {
    const w = await world({ github: { ownerType: 'Organization' } });
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    const forge = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    const author = startForms(forge)[0] as Record<string, string>;
    const org = await w.form('/setup/github-app/start', author);
    expect(org.statusCode, org.body).toBe(200);
    expect(org.body).toMatch(
      /action="https:\/\/github\.com\/organizations\/octo-org\/settings\/apps\/new\?state=[^"]+"/,
    );
    // The personal choice, as the helper renders it for a user's repository.
    const user = appCreateSection(
      { repo: 'alice/demo', ownerType: 'User' },
      { vaultOn: true, sudo: true, existing: {} },
    );
    const personal = startForms(user)[0] as Record<string, string>;
    expect(personal).toEqual({ role: 'author', owner: 'alice', ownerType: 'User' });
    const r = await w.form('/setup/github-app/start', personal);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toMatch(/action="https:\/\/github\.com\/settings\/apps\/new\?state=[^"]+"/);
  });

  test('the step stays in plain words with the apps section on it', async () => {
    const w = await world({ github: { ownerType: 'Organization' } });
    const forge = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    const text = forge
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]*>/g, ' ');
    expect(text.match(/\b[a-z]+[A-Z][A-Za-z]*\b/g) ?? []).toEqual([]);
    // Nothing secret on the page.
    expect(forge).not.toMatch(/[?&]state=|name="state"|PRIVATE KEY|github_pat_/);
    expect(forge).toContain('id="github-apps"');
  });
});

describe('two bots on GitHub Apps, tokens under "Use tokens instead" (#446)', () => {
  const pat = {
    author: 'https://github.com/settings/personal-access-tokens/new?name=author',
    reviewer: 'https://github.com/settings/personal-access-tokens/new?name=reviewer',
    read: 'https://github.com/settings/personal-access-tokens/new?name=read',
  };
  const guide = (
    o: { ownerType?: 'User' | 'Organization'; private?: boolean; paidPlan?: boolean } = {},
  ) => {
    const visibility = o.private ? ('private' as const) : ('public' as const);
    const answer: RecommendAnswer = {
      repo: 'octo/demo',
      ownerType: o.ownerType ?? 'User',
      visibility,
      visible: true,
      recommendation: recommendIdentity({
        ownerType: o.ownerType ?? 'User',
        visibility,
        ...(o.paidPlan === undefined ? {} : { paidPlan: o.paidPlan }),
      }),
      pat,
      checklist: { url: 'https://github.com/octo/demo/settings/access', items: [] },
      logins: {},
    };
    return { repo: 'octo/demo', paidPlan: '', answer };
  };
  const apps = (vaultOn = true) => ({ vaultOn, sudo: true, existing: {} });
  const DETAILS = '<details id="use-tokens"><summary>Use tokens instead</summary>';

  test('a two-bot recommendation without the starter flag folds the token links after the app section', () => {
    const html = guideSection(guide({ private: true, paidPlan: true }), '/setup/forge', apps());
    const details = html.indexOf(DETAILS);
    expect(details).toBeGreaterThan(-1);
    expect(html.indexOf('id="github-apps"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="github-apps"')).toBeLessThan(details);
    const inside = html.slice(details, html.indexOf('</details>'));
    for (const role of ['author', 'reviewer', 'read'])
      expect(inside).toContain(escapeHtml(pat[role as keyof typeof pat]));
    expect(inside).toContain('Pull requests: Read and write');
  });

  test('the starter flag shows the token links as before, starter roles only, and no app section', () => {
    const html = guideSection(
      guide({ private: true, paidPlan: true }),
      '/setup/forge',
      apps(),
      true,
    );
    expect(html).toContain('id="tokens"');
    expect(html).not.toContain('id="use-tokens"');
    expect(html).not.toContain('id="github-apps"');
    expect(html).toContain(escapeHtml(pat.author));
    expect(html).toContain(escapeHtml(pat.read));
    expect(html).not.toContain(escapeHtml(pat.reviewer));
  });

  test('Settings passes no flag: the token links fold whenever two bots are recommended', () => {
    for (const ownerType of ['User', 'Organization'] as const) {
      const html = guideSection(guide({ ownerType }), '/system/credentials', apps());
      expect(html).toContain(DETAILS);
    }
  });

  test('with the vault off the two-bot recommendation, the vault notice and the folded links all render', () => {
    const html = guideSection(guide(), '/setup/forge', apps(false));
    expect(html).toContain('Two bot accounts as GitHub Apps');
    expect(html).toContain('id="apps-vault-off"');
    expect(html).toContain(DETAILS);
    expect(html.indexOf('id="apps-vault-off"')).toBeLessThan(html.indexOf(DETAILS));
  });

  test('a stop recommendation renders no token links, folded or not', () => {
    for (const starter of [false, true]) {
      const html = guideSection(
        guide({ private: true, paidPlan: false }),
        '/setup/forge',
        apps(),
        starter,
      );
      expect(html).toContain('data-stop');
      expect(html).not.toContain('id="tokens"');
      expect(html).not.toContain('id="use-tokens"');
      expect(html).not.toContain('personal-access-tokens/new');
    }
  });

  test('guideSection renders the starter checklist under the starter flag, the two-bot one without it (#484)', () => {
    const g = guide();
    const answer = {
      ...(g.answer as RecommendAnswer),
      repo: 'octo-owner/demo',
      logins: { author: 'octo-owner' },
      checklist: {
        url: 'https://github.com/octo-owner/demo/settings/access',
        items: [
          'nothing to invite: octo-owner owns the repository',
          'invite the reviewer account with the Write role',
          'accept the invitation as the reviewer account',
        ],
      },
    };
    const two = guideSection({ ...g, repo: 'octo-owner/demo', answer }, '/setup/forge', apps());
    expect(two).toContain('id="checklist"');
    expect(two).toContain('invite the reviewer account with the Write role');
    const one = guideSection(
      { ...g, repo: 'octo-owner/demo', answer },
      '/setup/forge',
      apps(),
      true,
    );
    expect(one).toContain('id="checklist"');
    expect(one).toContain('nothing to invite: octo-owner owns the repository');
    expect(one).not.toContain('reviewer account');
    expect(one).not.toMatch(/invite[^<]*reviewer/);
  });

  const withAuthor = async (ownerType: 'User' | 'Organization', starter: boolean) => {
    const w = await world({ github: { ownerType } });
    expect((await w.call('POST', '/api/control/sudo', { passphrase: PASS })).statusCode).toBe(200);
    expect(
      (await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR })).statusCode,
    ).toBe(200);
    if (starter) await w.form('/setup/advance', { from: 'forge', starter: '1' });
    return w;
  };
  const checklistOf = (html: string) =>
    html.slice(
      html.indexOf('id="checklist"'),
      html.indexOf('</section>', html.indexOf('id="checklist"')),
    );

  test('a starter choice on a personal repository shows the starter checklist, no reviewer to invite (#484)', async () => {
    const w = await withAuthor('User', true);
    const forge = (await w.get('/setup/forge?repo=octo-owner%2Fdemo')).body;
    expect(forge).toContain('id="checklist"');
    expect(forge).toContain('nothing to invite: octo-owner owns the repository');
    expect(forge).not.toContain('reviewer account');
    expect(forge).not.toMatch(/invite[^<]*reviewer/);
    expect(forge).not.toContain(AUTHOR);
  });

  test('a starter choice on an organization repository names the author only in the checklist (#484)', async () => {
    const w = await withAuthor('Organization', true);
    const forge = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    const list = checklistOf(forge);
    expect(list).toContain('invite octo-owner with the Write role');
    expect(list).toContain('accept the invitation as octo-owner');
    expect(list).not.toContain('reviewer');
    expect(forge).not.toContain(AUTHOR);
  });

  test('without the starter choice a personal repository keeps both roles, the apps and the folded tokens (#484)', async () => {
    const w = await withAuthor('User', false);
    const forge = (await w.get('/setup/forge?repo=octo-owner%2Fdemo')).body;
    const list = checklistOf(forge);
    expect(list).toContain('nothing to invite: octo-owner owns the repository');
    expect(list).toContain('invite the reviewer account with the Write role');
    expect(list).toContain('accept the invitation as the reviewer account');
    expect(forge).toContain('id="github-apps"');
    expect(forge).toContain('id="use-tokens"');
    expect(forge).not.toContain(AUTHOR);
  });

  test('the forge page of an organization repository still shows the starter warning beside the box', async () => {
    const w = await world({ github: { ownerType: 'Organization' } });
    const forge = (await w.get('/setup/forge?repo=octo-org%2Fdemo')).body;
    expect(forge).toContain('id="starter-warning"');
    const escaped = STARTER_WARNING.replaceAll("'", '&#39;').replaceAll('"', '&quot;');
    expect(forge.split(escaped)).toHaveLength(2);
    expect(forge).toContain(DETAILS);
  });
});

// Issue #549: an install on GitHub Apps holds no author token; detection before the first zone
// reads through the owner's author app.
describe('the project step on GitHub Apps with no author token (#549)', () => {
  // One key for the file: an entry's PEM must load, and generating one per test is slow.
  let pemOnce: string | undefined;
  const pem = () =>
    (pemOnce ??= generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString());
  const MINTED = ['ghs', 'DETECTMINTEDTOKEN0123456789abcdefgh'].join('_');
  const SLUG = 'octo-jm-author';

  /** A fake author app's broker: the calls it took, installed on octo/demo (id 9001) or not. */
  function fakeBroker(installed = true) {
    const calls: { installationFor: string[]; mint: unknown[]; revoked: string[] } = {
      installationFor: [],
      mint: [],
      revoked: [],
    };
    const broker: DetectAppBroker = {
      installationFor: async (owner, repo) => {
        calls.installationFor.push(`${owner}/${repo}`);
        return installed
          ? { installed: true, installationId: 77, permissions: { contents: 'read' } }
          : { installed: false };
      },
      repositoryIdOf: async (installationId, owner, repo) => {
        expect([installationId, owner, repo]).toEqual([77, 'octo', 'demo']);
        return 9001;
      },
      mint: async (args) => {
        calls.mint.push(args);
        return { token: MINTED, expiresAt: new Date(t0.getTime() + 3600_000) };
      },
      revoke: async (t) => {
        calls.revoked.push(t);
      },
    };
    return { broker, calls };
  }

  type Role = 'author' | 'reviewer';
  const entryText = (role: Role) =>
    serializeAppEntry({
      appId: role === 'author' ? '4242' : '4343',
      slug: role === 'author' ? SLUG : 'octo-jm-reviewer',
      clientId: `Iv1.${role}`,
      pem: pem(),
      importedAt: '2026-11-15T10:00:00.000Z',
    });

  async function appsWorld(
    o: {
      installed?: boolean;
      roles?: Role[];
      /** Entries written as `<secretsDir>/github-app/<owner>/<role>.json` files (#597). */
      files?: { owner?: string; role: Role; text?: string }[];
      /** Vault entries for another owner than octo, or holding other text than an entry. */
      vaultFor?: { owner: string; role: Role; text?: string }[];
      noVault?: boolean;
      /** octo's owner directory is a symlink to a directory outside the secrets directory (#609). */
      linkOwner?: boolean;
      /** `github-app/octo` is a dangling symlink or a regular file (#609). */
      strayOwner?: 'dangling' | 'file';
    } = {},
  ) {
    const { broker, calls } = fakeBroker(o.installed ?? true);
    const secretsDir =
      o.files || o.strayOwner ? mkdtempSync(join(tmpdir(), 'jm-wizard-secrets-')) : undefined;
    if (secretsDir) {
      chmodSync(secretsDir, 0o700);
      mkdirSync(join(secretsDir, 'github-app'), { recursive: true, mode: 0o700 });
      chmodSync(join(secretsDir, 'github-app'), 0o700);
    }
    if (secretsDir && o.linkOwner) {
      const real = mkdtempSync(join(tmpdir(), 'jm-wizard-owner-'));
      chmodSync(real, 0o700);
      symlinkSync(real, join(secretsDir, 'github-app', 'octo'));
    }
    if (secretsDir && o.strayOwner === 'dangling')
      symlinkSync(join(secretsDir, 'no-such-owner'), join(secretsDir, 'github-app', 'octo'));
    if (secretsDir && o.strayOwner === 'file')
      writeFileSync(join(secretsDir, 'github-app', 'octo'), entryText('reviewer'), { mode: 0o600 });
    for (const f of o.files ?? []) {
      const dir = join(secretsDir as string, 'github-app', f.owner ?? 'octo');
      if (!(o.linkOwner && (f.owner ?? 'octo') === 'octo')) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      }
      writeFileSync(join(dir, `${f.role}.json`), f.text ?? entryText(f.role), { mode: 0o600 });
    }
    // With no vault to hold it, the Claude token is a secrets-directory file.
    if (o.noVault && secretsDir)
      writeFileSync(join(secretsDir, 'claude_token'), CLAUDE, { mode: 0o600 });
    const w = await world({
      appBroker: broker,
      ...(secretsDir ? { secretsDir } : {}),
      ...(o.noVault ? { noVault: true } : {}),
    });
    const vault = w.store.vault();
    const puts = [
      ...(o.roles ?? (o.files || o.vaultFor ? [] : ['author' as const])).map((role) => ({
        owner: 'octo',
        role,
      })),
      ...(o.vaultFor ?? []),
    ];
    if (puts.length > 0 && vault === 'disabled') throw new Error('expected a vault');
    if (vault !== 'disabled')
      for (const p of puts)
        vault.put(appEntryName(p.owner, p.role), ('text' in p && p.text) || entryText(p.role), {
          now: t0,
        });
    if (secretsDir) w.store.refreshSecrets();
    return { ...w, calls, pem: pem() };
  }

  const pemBody = (p: string) => p.split('\n').filter((l) => l !== '' && !l.startsWith('-----'));
  /** Neither the minted token nor any line of the PEM is in `text`. */
  function secretFree(text: string, p: string) {
    expect(text).not.toContain(MINTED);
    for (const line of pemBody(p)) expect(text).not.toContain(line);
  }

  test('detect answers 200 through the author app, on a token for the repository id with contents: read, shown nowhere', async () => {
    const w = await appsWorld();
    expect(w.store.resolved().githubAuthorToken.source).toBe('missing');
    expect(w.store.current().dropZones).toEqual([]);
    const d = await w.call('POST', '/api/control/detect', { repo: 'octo/demo' });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ preset: 'node', defaultBranch: 'main' });
    expect(d.body).not.toContain(NO_AUTHOR);
    expect(w.calls.installationFor).toEqual(['octo/demo']);
    expect(w.calls.mint).toEqual([
      { installationId: 77, repositoryId: 9001, use: 'drop-read-author' },
    ]);
    expect(USE_PERMISSIONS['drop-read-author']).toEqual({ contents: 'read' });
    // Read with the minted token, then revoked: used for this one detection only.
    expect(w.detectTokens).toEqual([MINTED]);
    expect(w.calls.revoked).toEqual([MINTED]);
    secretFree(d.body, w.pem);
    secretFree(w.logs.join('\n'), w.pem);
    secretFree((await w.get('/setup/project')).body, w.pem);
  });

  test('POST /api/control/zones creates the two-bot zone through the apply path', async () => {
    const w = await appsWorld();
    const add = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/demo', identity: 'two-bot' },
      returnTo: '/setup/doctor',
    });
    expect(add.statusCode, add.body).toBe(409);
    const body = add.json();
    expect(body.error).toBeUndefined();
    expect(body.guarded.map((g: { path: string }) => g.path)).toContain('dropZones[demo].repo');
    secretFree(add.body, w.pem);
    const confirm = await w.get(body.confirm);
    secretFree(confirm.body, w.pem);
    const tokenIn = /name="token" value="([\w-]+)"/.exec(confirm.body)?.[1] as string;
    const done = await w.form(body.confirm, { token: tokenIn, passphrase: PASS });
    expect(done.statusCode).toBe(303);
    expect(w.store.current().dropZones[0]).toMatchObject({
      id: 'demo',
      repo: 'octo/demo',
      identity: 'two-bot',
      preset: 'node',
    });
    expect(w.calls.mint).toHaveLength(1);
    secretFree(w.logs.join('\n'), w.pem);
  });

  test('an author app not installed on the repository: its install link, not NO_AUTHOR, and the page shows it', async () => {
    const w = await appsWorld({ installed: false });
    const d = await w.call('POST', '/api/control/detect', { repo: 'octo/demo' });
    expect(d.statusCode).toBe(409);
    const j = d.json();
    expect(j.error).not.toBe(NO_AUTHOR);
    expect(j.error).toContain(SLUG);
    expect(j.error).toContain('not installed on octo/demo');
    expect(j.error).toContain(`/apps/${SLUG}/installations/new`);
    expect(j.installUrl).toBe(`https://github.com/apps/${SLUG}/installations/new`);
    expect(w.calls.mint).toEqual([]);
    const page = (await w.get('/setup/project')).body;
    expect(page).toContain('a.href = j.installUrl');
  });

  test('no app entry and no token: still 409 NO_AUTHOR', async () => {
    const w = await appsWorld({ roles: [] });
    const d = await w.call('POST', '/api/control/detect', { repo: 'octo/demo' });
    expect(d.statusCode).toBe(409);
    expect(d.json()).toEqual({ error: NO_AUTHOR });
    expect(w.calls.installationFor).toEqual([]);
  });

  test('a starter zone with no token is never read through the app', async () => {
    const w = await appsWorld();
    const add = await w.call('POST', '/api/control/zones', {
      zone: { repo: 'octo/demo', identity: 'starter' },
    });
    expect(add.statusCode).toBe(409);
    expect(add.json()).toEqual({ error: NO_AUTHOR });
    expect(w.calls.installationFor).toEqual([]);
  });

  test('with the author token set, detection reads with the PAT and never calls the app', async () => {
    const w = await appsWorld({ roles: ['author', 'reviewer'] });
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    const d = await w.call('POST', '/api/control/detect', { repo: 'octo/demo' });
    expect(d.statusCode, d.body).toBe(200);
    expect(w.detectTokens).toEqual([AUTHOR]);
    expect(w.calls.installationFor).toEqual([]);
    expect(w.calls.mint).toEqual([]);
  });

  test('/setup/next passes the GitHub step with an author and a reviewer app and no token, and not without', async () => {
    const next = async (roles: ('author' | 'reviewer')[]) => {
      const w = await appsWorld({ roles });
      await w.call('POST', '/api/control/sudo', { passphrase: PASS });
      await w.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
      return (await w.get('/setup/next')).headers.location;
    };
    expect(await next(['author', 'reviewer'])).toBe('/setup/stick');
    expect(await next(['author'])).toBe('/setup/forge');
    expect(await next([])).toBe('/setup/forge');
  });

  // Issue #597: the pair check resolves like appEntry(): vault entries and secrets-directory files.
  describe('/setup/next counts app entries the way detection reads them (#597)', () => {
    const next = async (o: Parameters<typeof appsWorld>[0]) => {
      const w = await appsWorld(o);
      expect(w.store.resolved().githubAuthorToken.source).toBe('missing');
      await w.call('POST', '/api/control/sudo', { passphrase: PASS });
      if (w.store.vault() !== 'disabled')
        await w.call('PUT', '/api/control/secrets/claudeToken', { value: CLAUDE });
      const r = await w.get('/setup/next');
      secretFree(r.body, w.pem);
      secretFree(JSON.stringify(r.headers), w.pem);
      secretFree(w.logs.join('\n'), w.pem);
      return r.headers.location;
    };

    test('file-sourced author and reviewer entries pass the GitHub step; the author alone does not', async () => {
      expect(await next({ files: [{ role: 'author' }, { role: 'reviewer' }] })).toBe(
        '/setup/stick',
      );
      expect(await next({ files: [{ role: 'author' }] })).toBe('/setup/forge');
    });

    test('an author in the vault and a reviewer file for the same owner pass', async () => {
      expect(await next({ roles: ['author'], files: [{ role: 'reviewer' }] })).toBe('/setup/stick');
    });

    test('with the vault disabled, file-sourced entries pass', async () => {
      expect(await next({ noVault: true, files: [{ role: 'author' }, { role: 'reviewer' }] })).toBe(
        '/setup/stick',
      );
    });

    test('a reviewer file holding invalid JSON leaves the step unfinished', async () => {
      expect(
        await next({ roles: ['author'], files: [{ role: 'reviewer', text: '{not json' }] }),
      ).toBe('/setup/forge');
    });

    test('a listed vault entry that cannot be read as an entry leaves the step unfinished', async () => {
      expect(
        await next({
          roles: ['author'],
          vaultFor: [{ owner: 'octo', role: 'reviewer', text: '{x' }],
        }),
      ).toBe('/setup/forge');
    });

    test('an author and a reviewer of different owners leave the step unfinished', async () => {
      expect(
        await next({ roles: ['author'], vaultFor: [{ owner: 'other', role: 'reviewer' }] }),
      ).toBe('/setup/forge');
      expect(
        await next({ files: [{ role: 'author' }, { owner: 'other', role: 'reviewer' }] }),
      ).toBe('/setup/forge');
    });

    // Issue #609: an owner directory reached through a symlink is read by appEntry(), so it counts.
    test('entries under a symlinked owner directory pass the GitHub step', async () => {
      expect(
        await next({ linkOwner: true, files: [{ role: 'author' }, { role: 'reviewer' }] }),
      ).toBe('/setup/stick');
    });

    test('with the vault disabled, entries under a symlinked owner directory pass', async () => {
      expect(
        await next({
          noVault: true,
          linkOwner: true,
          files: [{ role: 'author' }, { role: 'reviewer' }],
        }),
      ).toBe('/setup/stick');
    });

    test('a symlinked owner directory holding the author alone leaves the step unfinished', async () => {
      expect(await next({ linkOwner: true, files: [{ role: 'author' }] })).toBe('/setup/forge');
    });

    test('a dangling symlink as the owner directory leaves the step unfinished', async () => {
      expect(await next({ roles: ['author'], strayOwner: 'dangling' })).toBe('/setup/forge');
    });

    test('a regular file named like an owner leaves the step unfinished', async () => {
      expect(await next({ roles: ['author'], strayOwner: 'file' })).toBe('/setup/forge');
    });
  });
});

// Issue #796: the project step takes owner/name, a GitHub URL or a GitLab project URL.
const GITLAB_URL = 'https://gitlab.example.com/group/sub/project';

type FakeEl = {
  hidden: boolean;
  textContent: string;
  innerHTML: string;
  value: string;
  checked: boolean;
  name: string;
  dataset: Record<string, string>;
  children: FakeEl[];
  listeners: Record<string, (e: unknown) => unknown>;
  [k: string]: unknown;
};

function fakeEl(o: Partial<FakeEl> = {}): FakeEl {
  const el: FakeEl = {
    hidden: false,
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    name: '',
    dataset: {},
    children: [],
    listeners: {},
    ...o,
  };
  Object.assign(el, {
    append: (...kids: unknown[]) => {
      for (const k of kids) if (typeof k === 'object') el.children.push(k as FakeEl);
    },
    addEventListener: (t: string, f: (e: unknown) => unknown) => {
      el.listeners[t] = f;
    },
    querySelector: (sel: string) =>
      el.children.find((c) => sel === `input[name=${c.name}]`) ?? null,
    querySelectorAll: (sel: string) => (sel === 'p' ? el.children : []),
  });
  // `gates.textContent = ''` empties the list, as the DOM does.
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: (v: string) => {
      text = v;
      if (v === '') el.children.length = 0;
    },
  });
  return el;
}

/**
 * Runs the project form's script over a small fake page: detects `input` (answered by
 * `detected`), submits the review as it stands, and returns what the page sent and showed.
 */
async function runProjectForm(
  html: string,
  input: string,
  detected: Record<string, unknown>,
  o: { identity?: string; preset?: string; gates?: { name: string; run: string }[] } = {},
) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] as string)
    .find((s) => s.includes('const HOSTS')) as string;
  expect(script).toBeDefined();
  const els: Record<string, FakeEl> = {};
  const byId = (id: string) => {
    els[id] ??= fakeEl({ hidden: ['project', 'guidance-box', 'gitlab-next'].includes(id) });
    return els[id];
  };
  const preset = fakeEl({ value: 'generic' });
  const admin = fakeEl({ name: 'authorMayBeAdmin' });
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const gets: string[] = [];
  const ctx = vm.createContext({
    document: {
      getElementById: byId,
      createElement: () => fakeEl(),
      querySelector: (sel: string) =>
        sel === 'select[name=preset]'
          ? preset
          : sel === 'input[name=authorMayBeAdmin]'
            ? admin
            : sel === 'input[name=identity]:checked'
              ? { value: o.identity ?? 'two-bot' }
              : null,
      querySelectorAll: () => [],
    },
    location: { href: '' },
    URLSearchParams,
    JSON,
    jmFetch: async (url: string, body: Record<string, unknown>) => {
      posts.push({ url, body });
      const answer =
        url === '/api/control/detect'
          ? { status: 200, json: detected }
          : { status: 409, json: { needsConfirmation: true, confirm: '/confirm/x' } };
      return { ok: answer.status < 300, status: answer.status, json: async () => answer.json };
    },
    fetch: async (url: string) => {
      gets.push(url);
      return { text: async () => '<p>guidance</p>' };
    },
  });
  vm.runInContext(script, ctx);
  await byId('detect').listeners.submit?.({
    preventDefault: () => {},
    target: { project: { value: input } },
  });
  const shownGates = byId('gates').children.map((p) => ({
    name: (p.children[0] as FakeEl).value,
    run: (p.children[1] as FakeEl).value,
  }));
  // The operator's review: the chosen stack and checks.
  if (o.preset) preset.value = o.preset;
  if (o.gates) {
    byId('gates').children.length = 0;
    for (const g of o.gates)
      byId('gates').children.push(
        fakeEl({
          children: [
            fakeEl({ name: 'gate-name', value: g.name }),
            fakeEl({ name: 'gate-run', value: g.run }),
          ],
        }),
      );
    for (const p of byId('gates').children)
      Object.assign(p, {
        querySelector: (sel: string) =>
          p.children.find((c) => sel === `input[name=${c.name}]`) ?? null,
      });
  }
  const form = {
    preset,
    authorMayBeAdmin: admin,
    id: { value: '' },
    querySelector: () => ({ value: o.identity ?? 'two-bot' }),
  };
  await byId('project').listeners.submit?.({ preventDefault: () => {}, target: form });
  return { posts, gets, els: byId, shownGates, ctx };
}

describe('the project step takes a GitLab project URL (#796)', () => {
  test('a GitLab URL is answered with forge, origin and path, with no read, no app and no token, even with no author token', async () => {
    const broker: DetectAppBroker = {
      installationFor: async () => {
        throw new Error('the app broker must not be called');
      },
    } as unknown as DetectAppBroker;
    const w = await world({ appBroker: broker });
    expect(w.store.resolved().githubAuthorToken.source).toBe('missing');
    const d = await w.call('POST', '/api/control/detect', { project: GITLAB_URL });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toEqual({
      forge: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      repo: 'group/sub/project',
    });
    expect(w.detectTokens).toEqual([]);
  });

  test('the page shows one empty gate row, no guidance, the vault entries, and posts zone.project as typed', async () => {
    const w = await world();
    const page = (await w.get('/setup/project')).body;
    const r = await runProjectForm(
      page,
      GITLAB_URL,
      { forge: 'gitlab', baseUrl: 'https://gitlab.example.com', repo: 'group/sub/project' },
      { identity: 'two-bot', preset: 'node', gates: [{ name: 'test', run: 'npm test' }] },
    );
    expect(r.posts[0]).toEqual({ url: '/api/control/detect', body: { project: GITLAB_URL } });
    expect(r.shownGates).toEqual([{ name: '', run: '' }]);
    expect(r.els('found').textContent).toContain('group/sub/project');
    expect(r.els('found').textContent).toContain('https://gitlab.example.com');
    expect(r.els('found').textContent).toMatch(/detection is not available on GitLab yet/);
    expect(r.els('gitlab-next').hidden).toBe(false);
    expect(r.els('author-admin').hidden).toBe(true);
    expect(r.els('guidance-box').hidden).toBe(true);
    expect(r.gets).toEqual([]);
    expect(r.posts[1]?.url).toBe('/api/control/zones');
    expect(r.posts[1]?.body.zone).toEqual({
      project: GITLAB_URL,
      preset: 'node',
      gates: [{ name: 'test', run: 'npm test' }],
      identity: 'two-bot',
      egress: { mode: 'monitor' },
    });
    expect(r.ctx.location).toEqual({ href: '/confirm/x' });
  });

  test('owner/name posts the same zone body as before and loads the guidance; a github.com URL uses its normalized repo', async () => {
    const w = await world();
    const page = (await w.get('/setup/project')).body;
    const detected = {
      forge: 'github',
      repo: 'octo/demo',
      visibility: 'private',
      defaultBranch: 'main',
      preset: 'node',
      gates: [{ name: 'test', run: 'npm test', timeoutSec: 600 }],
      evidence: ['package.json'],
      problems: [],
      admin: true,
    };
    for (const input of ['octo/demo', 'https://github.com/octo/demo']) {
      const r = await runProjectForm(page, input, detected);
      expect(r.posts[0]?.body).toEqual({ project: input });
      expect(r.els('found').textContent).toMatch(/^octo\/demo: private, default branch main/);
      expect(r.els('gitlab-next').hidden).toBe(true);
      expect(r.els('guidance-box').hidden).toBe(false);
      expect(r.gets).toEqual(['/setup/project/github?repo=octo%2Fdemo&identity=two-bot&reviewer=']);
      expect(r.posts[1]?.body.zone).toEqual({
        repo: 'octo/demo',
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test', timeoutSec: 600 }],
        identity: 'two-bot',
        egress: { mode: 'monitor' },
        authorMayBeAdmin: true,
        reviewReadToken: true,
      });
    }
  });

  test('the zone the page builds for GitLab is created through the apply path, after the confirmation', async () => {
    const w = await world();
    const add = await w.call('POST', '/api/control/zones', {
      zone: {
        project: GITLAB_URL,
        preset: 'node',
        gates: [{ name: 'test', run: 'npm test' }],
        identity: 'two-bot',
        egress: { mode: 'monitor' },
      },
      returnTo: '/setup/doctor',
      cancelTo: '/setup/project',
    });
    expect(add.statusCode, add.body).toBe(409);
    const body = add.json();
    expect(body.needsConfirmation).toBe(true);
    const confirm = await w.get(body.confirm);
    expect(confirm.statusCode).toBe(200);
    const tokenIn = /name="token" value="([\w-]+)"/.exec(confirm.body)?.[1] as string;
    const done = await w.form(body.confirm, { token: tokenIn, passphrase: PASS });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/setup/doctor');
    expect(w.store.current().dropZones[0]).toMatchObject({
      id: 'project',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.com' },
      repo: 'group/sub/project',
      preset: 'node',
    });
  });

  test('owner/name and a github.com URL detect through the forge as octo/demo with the usual fields', async () => {
    const w = await world();
    await w.call('POST', '/api/control/sudo', { passphrase: PASS });
    await w.call('PUT', '/api/control/secrets/githubAuthorToken', { value: AUTHOR });
    for (const project of ['octo/demo', 'https://github.com/octo/demo']) {
      const d = await w.call('POST', '/api/control/detect', { project });
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({
        forge: 'github',
        repo: 'octo/demo',
        visibility: 'public',
        defaultBranch: 'main',
        preset: 'node',
      });
      expect(d.body).not.toContain(AUTHOR);
    }
    expect(w.detectTokens).toEqual([AUTHOR, AUTHOR]);
  });

  test('a body with both repo and project, or neither, is refused with 400', async () => {
    const w = await world();
    for (const body of [{ repo: 'octo/demo', project: 'octo/demo' }, {}])
      expect((await w.call('POST', '/api/control/detect', body)).statusCode).toBe(400);
    expect(w.detectTokens).toEqual([]);
  });

  test('a refused input gets the fixed error and is never echoed, nor logged', async () => {
    const w = await world();
    const glpat = 'glpat-' + 'AbCdEfGhIjKlMnOpQrSt';
    for (const [project, error] of [
      [
        'what is this',
        'the repository must be owner/name with a valid GitHub owner and repository name',
      ],
      ['http://gitlab.example.com/group/project', 'a project URL must use https'],
      [
        `https://gitlab.example.com/${glpat}/project`,
        'the project looks like it contains a token: enter owner/name or a project URL',
      ],
    ] as const) {
      const r = await w.call('POST', '/api/control/detect', { project });
      expect(r.statusCode, project).toBe(400);
      expect(r.json()).toEqual({ error });
      expect(r.body).not.toContain(project);
    }
    expect(w.logs.join('\n')).not.toContain(glpat);
    expect(w.detectTokens).toEqual([]);
  });

  test('both forms take any project, with no GitHub-only pattern, and name the vault entries but no refused command', async () => {
    const w = await world();
    for (const url of ['/setup/project', '/projects/new']) {
      const body = (await w.get(url)).body;
      const input = /<input name="project"[^>]*>/.exec(body)?.[0];
      expect(input, url).toBeDefined();
      expect(input, url).not.toContain('pattern=');
      expect(body, url).toContain('<label>Project <input name="project"');
      expect(body, url).not.toContain('name="repo"');
      expect(body, url).toMatch(/owner\/name, a GitHub URL .* or a GitLab project URL/);
      expect(body, url).toContain('gitlab-pat/');
      expect(body, url).toContain('/author</code>');
      expect(body, url).toContain('/reviewer</code> for two bots');
      expect(body, url).not.toContain('ctl secrets set gitlab-pat/');
      // The page decides nothing about the forge itself: no URL or path parsing in its script.
      const script = [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((m) => m[1] as string)
        .find((s) => s.includes('const HOSTS'));
      expect(script, url).toContain("jmFetch('/api/control/detect', { project })");
      expect(script, url).not.toMatch(/new URL\(|\.split\(|\.match\(|\.test\(|RegExp/);
    }
  });
});
