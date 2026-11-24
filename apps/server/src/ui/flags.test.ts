import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { RoleSchema } from '@jumpmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { loadBoot } from '../config/boot.js';
import { flagRows } from '../config/catalog.js';
import { ConfigStore } from '../config/store.js';
import { openDb } from '../db/open.js';
import { upsertDropZone } from '../db/repo.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { openVault } from '../vault/vault.js';
import { toMergePatch } from '../zones/form.js';
import { FLAGS_SCRIPT } from './flags.js';

const TOKEN = 'f'.repeat(32);
const HOST = '127.0.0.1:7420';
const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const DIGEST = `ghcr.io/x/trooper@sha256:${'c'.repeat(64)}`;
const zoneDoc = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
  preset: 'node',
  ...extra,
});

/** A db-mode install (or file mode) holding `zones`, with a browser session. */
async function world(o: { file?: boolean; zones?: Record<string, unknown>[] } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-flags-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  const zones = o.zones ?? [zoneDoc('jm')];
  if (o.file) writeFileSync(filePath, JSON.stringify({ dataDir: './data', dropZones: zones }));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, filePath),
    filePath,
    env: { JM_JOIN_TOKEN: 'join-secret-value-5', JM_OPERATOR_TOKEN: TOKEN, JM_DEV_IMAGES: '1' },
    vault: openVault(keyFile, db),
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  if (!o.file) {
    const applied = store.apply({ dropZones: zones }, { via: 'ctl', principal: token });
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
  }
  for (const z of zones)
    upsertDropZone(db, {
      id: String(z.id),
      repo: String(z.repo),
      defaultBranch: 'main',
      configJson: '{}',
    });
  const a = createApp({
    db,
    config: store,
    forgesFor: () => {
      throw new Error('no forge in this test');
    },
    now: () => t0,
    setup: new SetupMode(() => {}),
    backoff: new Backoff(),
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  app = a;
  await setOperatorPassphrase(db, 'a long operator passphrase', t0);
  const s = operatorSession(db);
  const get = (url: string, cookie = true) =>
    a.inject({
      method: 'GET',
      url,
      headers: { host: HOST, ...(cookie ? { cookie: s.cookie } : {}) },
    });
  /** A write as the browser makes it: the session cookie and its CSRF header. */
  const patch = (body: unknown) =>
    a.inject({
      method: 'PATCH',
      url: '/api/control/config',
      headers: { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf },
      payload: body as object,
    });
  return { db, store, get, patch };
}

const zoneOf = (store: ConfigStore, id: string): Record<string, unknown> =>
  ((store.document().dropZones ?? []) as Record<string, unknown>[]).find(
    (z) => z.id === id,
  ) as Record<string, unknown>;

const rowsOf = (store: ConfigStore, id: string) =>
  flagRows('zone', zoneOf(store, id), store.document() as Record<string, unknown>);

/** Every `<tr data-flag="…">…</tr>` of the page, by key, in page order. */
function flagRowsHtml(html: string): [string, string][] {
  return [...html.matchAll(/<tr data-flag="([^"]*)"[^>]*>(.*?)<\/tr>/gs)].map((m) => [
    m[1] as string,
    m[2] as string,
  ]);
}
const rowHtml = (html: string, key: string): string => {
  const r = flagRowsHtml(html).find(([k]) => k === key);
  expect(r, key).toBeDefined();
  return (r as [string, string])[1];
};

type Call = { method: string; path: string; body: unknown };

/** The page's script in a vm, with jmFetch answering as `answer` says. */
function pageScript(
  answer: (call: Call) => { ok: boolean; status: number; json: unknown } = () => ({
    ok: true,
    status: 200,
    json: { revision: 2 },
  }),
  globals: Record<string, unknown> = {},
) {
  const calls: Call[] = [];
  const ctx = vm.createContext({
    document: { addEventListener: () => {}, querySelectorAll: () => [], querySelector: () => null },
    encodeURIComponent,
    ...globals,
    jmFetch: async (path: string, body: unknown, method?: string) => {
      const call = { method: method ?? 'POST', path, body };
      calls.push(call);
      const a = answer(call);
      return { ok: a.ok, status: a.status, json: async () => a.json };
    },
  });
  vm.runInContext(FLAGS_SCRIPT.replace(/^<script>|<\/script>$/gi, ''), ctx);
  const fn = <T>(name: string) => ctx[name] as (...a: unknown[]) => T;
  return { ctx, calls, fn };
}

const field = (key: string, kind: string, value: unknown, original: unknown, explicit = false) => ({
  key,
  kind,
  value,
  original,
  explicit,
});

const stubStatus = () => ({ textContent: '', innerHTML: '' });

/** The zone page's save target, as the form carries it. */
const JM = { savedTo: '/projects/jm/flags', zone: { id: 'jm', index: 0 } };

describe('the advanced settings page, /projects/:id/flags', () => {
  test('lists exactly the zone flagRows, each once, grouped in FlagGroup order and in catalog order', async () => {
    const w = await world();
    const r = await w.get('/projects/jm/flags');
    expect(r.statusCode).toBe(200);
    const rows = rowsOf(w.store, 'jm');
    const keys = flagRowsHtml(r.body).map(([k]) => k);
    expect(keys).toEqual(rows.map((row) => row.key));
    expect(new Set(keys).size).toBe(rows.length);
    // elsewhere rows are included.
    expect(rows.some((row) => row.entry.kind === 'elsewhere')).toBe(true);
    expect(r.body).toContain('Advanced settings · octo/jm');
    expect(r.body).toContain(
      'Every setting for this project. Changes apply at the next pass; one that loosens a safeguard asks you to confirm first.',
    );
    // Group headings in order, only the non-empty ones.
    const heads = [...r.body.matchAll(/<h3 data-group-head="[^"]*">([^<]*)<\/h3>/g)].map(
      (m) => m[1],
    );
    const groups = [...new Set(rows.map((row) => row.entry.group))];
    expect(heads).toEqual(groups.map((g) => g.charAt(0).toUpperCase() + g.slice(1)));
    expect(heads[0]).toBe('Crew');
    expect(r.body).toContain('id="flag-search"');
    // Links both ways.
    expect(r.body).toContain('<a href="/projects/jm/setup#advanced">View the project as JSON</a>');
    expect(r.body).not.toContain('Edit the project as JSON');
    expect(r.body).not.toContain('the JSON editor');
    expect((await w.get('/projects/jm/setup')).body).toContain(
      'All settings, one per row: <a href="/projects/jm/flags">advanced settings</a>',
    );
  });

  test('an unknown zone answers 404, and the page needs a browser session', async () => {
    const w = await world();
    const r = await w.get('/projects/nope/flags');
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe((await w.get('/projects/nope')).body);
    const anon = await w.get('/projects/jm/flags', false);
    expect(anon.statusCode).toBe((await w.get('/projects/jm', false)).statusCode);
    expect(anon.statusCode).not.toBe(200);
  });

  test('every control kind renders, and the locked rows are disabled', async () => {
    const w = await world({
      zones: [
        zoneDoc('jm', {
          crew: { maxDropsPerDay: 60 },
          image: DIGEST,
          preset: undefined,
          egress: { mode: 'monitor', allow: ['a.example.com'] },
        }),
      ],
    });
    const html = (await w.get('/projects/jm/flags')).body;
    // bool: a checkbox (unset refutePromotes shows its default, true), guarded, not set.
    const refute = rowHtml(html, 'crew.refutePromotes');
    expect(refute).toMatch(
      /<input type="checkbox"[^>]*data-path="crew.refutePromotes"[^>]* checked/,
    );
    expect(refute).toContain('asks to confirm a change that loosens it');
    expect(refute).not.toContain('class="set"');
    expect(refute).not.toContain('Reset to default');
    // number: min/step from the catalog; set rows show set and a Reset with the default.
    const max = rowHtml(html, 'crew.maxDropsPerDay');
    expect(max).toMatch(/<input type="number" min="0" step="1"[^>]*value="60"/);
    expect(max).toContain('<span class="set">set</span>');
    expect(max).toMatch(
      /<button type="button" class="reset" data-reset="crew.maxDropsPerDay" title="Default: 0">Reset to default<\/button>/,
    );
    expect(rowHtml(html, 'mergeReservationMinutes')).toContain('max="240"');
    expect(rowHtml(html, 'crew.cycleMinutes')).toContain('step="any"');
    // text, select (optional preset: a "(not set)" first), list.
    expect(rowHtml(html, 'readyLabel')).toMatch(/<input type="text"[^>]*value="drop-ready"/);
    expect(rowHtml(html, 'preset')).toMatch(
      /<select[^>]*><option value=""( selected)?>\(not set\)<\/option>/,
    );
    expect(rowHtml(html, 'identity')).not.toContain('(not set)');
    expect(rowHtml(html, 'egress.allow')).toMatch(/<textarea[^>]*>a.example.com<\/textarea>/);
    // elsewhere: the sentence and a link, no control.
    const gates = rowHtml(html, 'gates');
    expect(gates).toContain('Changed in the Stack section.');
    expect(gates).toContain('href="/projects/jm/setup#stack"');
    expect(gates).not.toContain('data-path=');
    expect(rowHtml(html, 'models')).not.toContain('setup#advanced');
    // An elsewhere row whose sentence names no section links nowhere.
    expect(rowHtml(html, 'id')).not.toContain('<a ');
    expect(rowHtml(html, 'id')).toContain(
      'Fixed once the project exists: remove the project and add it again to change it.',
    );
    for (const k of ['id', 'repo', 'gates']) expect(rowHtml(html, k)).not.toContain('Reset');
    // Locked: repo refused; image and requireSignedImages browser-forbidden.
    const repo = rowHtml(html, 'repo');
    expect(repo).toMatch(/data-path="repo"[^>]* disabled/);
    expect(repo).toContain('fixed once the project exists');
    for (const k of ['image', 'requireSignedImages']) {
      expect(rowHtml(html, k), k).toMatch(new RegExp(`data-path="${k}"[^>]* disabled`));
      expect(rowHtml(html, k)).toContain(
        'set with <code>jumpmaster ctl</code> or in the config file',
      );
      expect(rowHtml(html, k)).not.toContain('Reset to default');
    }
    // A free row is not disabled.
    expect(max).not.toContain('disabled');
    expect(html).toContain('<button id="flags-save">Save changes</button>');
  });

  test('a zone with requireSignedImages unset shows the value it inherits from the install', async () => {
    const w = await world({ zones: [zoneDoc('jm', { preset: undefined, image: DIGEST })] });
    const applied = w.store.apply(
      { ...w.store.document(), requireSignedImages: true },
      { via: 'ctl', principal: token },
    );
    expect(applied.ok, JSON.stringify(applied)).toBe(true);
    const row = rowHtml((await w.get('/projects/jm/flags')).body, 'requireSignedImages');
    expect(row).toMatch(/data-path="requireSignedImages"[^>]* checked disabled/);
    expect(row).not.toContain('class="set"');
  });

  test('in file mode every control is disabled, there is no Save and the adopt banner shows', async () => {
    const w = await world({ file: true });
    const html = (await w.get('/projects/jm/flags')).body;
    expect(html).toContain('Your config file holds these projects');
    expect(html).not.toContain('Save changes');
    expect(html).not.toContain('class="reset"');
    const controls = [...html.matchAll(/<(input|select|textarea)[^>]*data-path="[^"]*"[^>]*>/g)];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c[0]).toMatch(/ disabled/);
  });

  test('config text is escaped', async () => {
    const w = await world({ zones: [zoneDoc('jm', { readyLabel: '<script>x</script>' })] });
    const html = (await w.get('/projects/jm/flags')).body;
    expect(html).not.toContain('<script>x</script>');
    expect(rowHtml(html, 'readyLabel')).toContain('value="&lt;script&gt;x&lt;/script&gt;"');
  });

  test('a saved revision is said at the top, and only a number is echoed', async () => {
    const w = await world();
    expect((await w.get('/projects/jm/flags?saved=3')).body).toContain('Saved as revision 3');
    expect((await w.get('/projects/jm/flags?saved=<b>')).body).not.toContain('Saved as revision');
  });
});

describe('the advanced settings page script', () => {
  test('builds one nested patch of what changed: numbers, trimmed lists, nulls and resets', () => {
    const { fn } = pageScript();
    const patch = fn<unknown>('jmFlagsPatch')([
      field('crew.refutePromotes', 'bool', true, false),
      field('crew.enabled', 'bool', false, false),
      field('crew.maxDropsPerDay', 'number', '30', 24),
      field('maxTurns', 'number', '200', 200),
      field('egress.allow', 'list', ' a.example.com \n\n  b.example.com\n ', ['a.example.com']),
      field('protectedPaths', 'list', 'x\ny', ['x', 'y']),
      field('readyLabel', 'text', '', 'drop-ready', true),
      field('preset', 'select', '', 'node', true),
      field('maxOpenPrs', 'number', '', null, true),
      field('outboxDeadlineMinutes', 'number', '', null),
      { key: 'budgets.maxHeal', kind: 'number', reset: true },
      { key: 'models', kind: 'elsewhere', reset: true },
    ]);
    expect(patch).toEqual({
      crew: { refutePromotes: true, maxDropsPerDay: 30 },
      egress: { allow: ['a.example.com', 'b.example.com'] },
      readyLabel: null,
      preset: null,
      budgets: { maxHeal: null },
      models: null,
    });
    // A number field gives a number.
    expect(
      fn<Record<string, unknown>>('jmFlagsPatch')([field('maxTurns', 'number', '7', 200)]),
    ).toEqual({ maxTurns: 7 });
  });

  test('a save sends one patch for the zone, conditional on the revision, back to this page', async () => {
    const { fn, calls } = pageScript(() => ({ ok: true, status: 200, json: { revision: 9 } }));
    let went = '';
    const r = await fn<Promise<string>>('jmSaveFlags')(
      JM,
      { crew: { refutePromotes: true } },
      4,
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
          patch: { dropZones: [{ id: 'jm', crew: { refutePromotes: true } }] },
          expectRevision: 4,
          returnTo: '/projects/jm/flags',
          cancelTo: '/projects/jm/flags',
        },
      },
    ]);
    expect(went).toBe('/projects/jm/flags?saved=9');
  });

  test('nothing changed sends no request', async () => {
    const { fn, calls } = pageScript();
    const out = stubStatus();
    const patch = fn<unknown>('jmFlagsPatch')([field('maxTurns', 'number', '200', 200)]);
    expect(await fn<Promise<string>>('jmSaveFlags')(JM, patch, 4, out, () => {})).toBe('unchanged');
    expect(out.textContent).toBe('Nothing changed.');
    expect(calls).toEqual([]);
  });

  test('every answer is followed: confirm, conflict and forbidden', async () => {
    const answers: Record<string, { ok: boolean; status: number; json: unknown }> = {
      confirm: {
        ok: false,
        status: 409,
        json: { needsConfirmation: true, confirm: '/config/confirm/x' },
      },
      conflict: { ok: false, status: 409, json: { conflict: { expected: 1, actual: 2 } } },
      forbidden: { ok: false, status: 403, json: { sessionForbidden: ['dropZones[jm].image'] } },
    };
    for (const [want, a] of Object.entries(answers)) {
      const { fn } = pageScript(() => a);
      let went = '';
      const out = stubStatus();
      const r = await fn<Promise<string>>('jmSaveFlags')(
        JM,
        { maxTurns: 1 },
        1,
        out,
        (to: string) => {
          went = to;
        },
      );
      expect(r).toBe(want);
      if (want === 'confirm') expect(went).toBe('/config/confirm/x');
      if (want === 'conflict') expect(out.textContent).toContain('The config changed');
      if (want === 'forbidden') expect(out.textContent).toContain('dropZones[jm].image');
    }
  });

  test('a 400 answer with issues puts each message beside its row, or above the table', async () => {
    const spans: Record<string, { textContent: string }> = {
      'crew.maxDropsPerDay': { textContent: '' },
      'egress.allow': { textContent: '' },
    };
    const document = {
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: (sel: string) => {
        const m = /^\[data-flag-issue="(.*)"\]$/.exec(sel);
        return m ? (spans[m[1] as string] ?? null) : null;
      },
    };
    const { fn } = pageScript(
      () => ({
        ok: false,
        status: 400,
        json: {
          issues: [
            { path: 'dropZones.0.crew.maxDropsPerDay', message: 'too big' },
            { path: 'dropZones.0.egress.allow.1', message: 'not a host' },
            { path: 'dropZones.0.somethingElse', message: 'odd' },
          ],
        },
      }),
      { document },
    );
    const out = stubStatus();
    const r = await fn<Promise<string>>('jmSaveFlags')(JM, { maxTurns: 1 }, 1, out, () => {});
    expect(r).toBe('refused');
    expect(spans['crew.maxDropsPerDay']?.textContent).toBe('too big');
    expect(spans['egress.allow']?.textContent).toBe('not a host');
    expect(out.textContent).toContain('dropZones.0.somethingElse: odd');
    expect(out.textContent).not.toContain('too big');
  });
});

describe('D5: the page writes through the same guards as the Setup form', () => {
  test('sibling-path parity: a guarded change asks for confirmation from both, and nothing changes until then', async () => {
    const w = await world({ zones: [zoneDoc('jm', { crew: { refutePromotes: false } })] });
    const before = w.store.revision();
    const { fn } = pageScript();
    const page = fn<Record<string, unknown>>('jmFlagsPatch')([
      field('crew.refutePromotes', 'bool', true, false, true),
    ]);
    const raw = zoneOf(w.store, 'jm');
    const editor = toMergePatch(raw, { ...raw, crew: { refutePromotes: true } });
    const answers = [];
    for (const zone of [{ id: 'jm', ...page }, editor]) {
      const r = await w.patch({
        patch: { dropZones: [zone] },
        expectRevision: w.store.revision(),
        returnTo: '/projects/jm/flags',
        cancelTo: '/projects/jm/flags',
      });
      expect(r.statusCode).toBe(409);
      const j = r.json() as { needsConfirmation: boolean; guarded: unknown };
      answers.push({ needsConfirmation: j.needsConfirmation, guarded: j.guarded });
    }
    expect(answers[0]?.needsConfirmation).toBe(true);
    expect(answers[0]).toEqual(answers[1]);
    expect(w.store.revision()).toBe(before);
    expect(w.store.current().dropZones[0]?.crew?.refutePromotes).toBe(false);
  });

  test('browser-forbidden: requireSignedImages off is refused from both, and its rows are disabled', async () => {
    const w = await world({
      zones: [zoneDoc('jm', { requireSignedImages: true, preset: undefined, image: DIGEST })],
    });
    const before = w.store.revision();
    const { fn } = pageScript();
    // A synthetic field: the page never offers this control enabled.
    const page = fn<Record<string, unknown>>('jmFlagsPatch')([
      field('requireSignedImages', 'bool', false, true, true),
    ]);
    expect(page).toEqual({ requireSignedImages: false });
    const raw = zoneOf(w.store, 'jm');
    const editor = toMergePatch(raw, { ...raw, requireSignedImages: false });
    for (const zone of [{ id: 'jm', ...page }, editor]) {
      const r = await w.patch({ patch: { dropZones: [zone] }, expectRevision: w.store.revision() });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ sessionForbidden: ['dropZones[jm].requireSignedImages'] });
    }
    expect(w.store.revision()).toBe(before);
    expect(w.store.current().dropZones[0]?.requireSignedImages).toBe(true);
    const html = (await w.get('/projects/jm/flags')).body;
    for (const k of ['requireSignedImages', 'image'])
      expect(rowHtml(html, k)).toMatch(new RegExp(`data-path="${k}"[^>]* disabled`));
  });

  test('reset returns to the default: after the reset patch is applied the row is not explicit and shows the default', async () => {
    const w = await world({ zones: [zoneDoc('jm', { crew: { maxDropsPerDay: 60 } })] });
    const set = rowsOf(w.store, 'jm').find((r) => r.key === 'crew.maxDropsPerDay');
    expect(set).toMatchObject({ explicit: true, value: 60 });
    const { fn } = pageScript();
    const patch = fn<Record<string, unknown>>('jmFlagsPatch')([
      { key: 'crew.maxDropsPerDay', kind: 'number', reset: true },
    ]);
    expect({ dropZones: [{ id: 'jm', ...patch }] }).toEqual({
      dropZones: [{ id: 'jm', crew: { maxDropsPerDay: null } }],
    });
    const r = await w.patch({
      patch: { dropZones: [{ id: 'jm', ...patch }] },
      expectRevision: w.store.revision(),
    });
    expect(r.statusCode, r.body).toBe(200);
    const after = rowsOf(w.store, 'jm').find((row) => row.key === 'crew.maxDropsPerDay');
    expect(after?.explicit).toBe(false);
    expect(after?.value).toEqual(after?.defaultValue);
    const html = rowHtml((await w.get('/projects/jm/flags')).body, 'crew.maxDropsPerDay');
    expect(html).not.toContain('class="set"');
    expect(html).toContain(`value="${String(after?.defaultValue)}"`);
  });
});

describe('per-role models on the advanced settings page (#672)', () => {
  const ROLES = RoleSchema.options;
  const role = ROLES[0] as string;

  test('the models row has one text input per role, with a data-path, and no link to Advanced', async () => {
    const w = await world({ zones: [zoneDoc('jm', { models: { [role]: 'claude-x' } })] });
    const html = rowHtml((await w.get('/projects/jm/flags')).body, 'models');
    const inputs = [...html.matchAll(/<input type="text"[^>]*data-path="models\.([^"]*)"[^>]*>/g)];
    expect(inputs.map((m) => m[1])).toEqual([...ROLES]);
    for (const m of inputs) expect(m[0]).not.toContain('disabled');
    expect(html).toMatch(
      new RegExp(
        `data-path="models\\.${role}"[^>]*data-original="&quot;claude-x&quot;"[^>]*value="claude-x"`,
      ),
    );
    for (const r of ROLES) expect(html).toContain(`<label for="setting-models-${r}">${r}</label>`);
    expect(html).not.toContain('setup#advanced');
    expect(html).toContain('data-flag-issue="models"');
  });

  test("the rows' fields: one per role input, explicit when the role is set", () => {
    const { fn } = pageScript();
    const input = (path: string, original: unknown, value: string) => ({
      disabled: false,
      value,
      checked: false,
      dataset: {
        path,
        kind: 'text',
        original: JSON.stringify(original),
        ...(path.includes('.') ? { explicit: original === null ? '0' : '1' } : {}),
      },
    });
    const els = [input(`models.${role}`, 'a', ''), input('models.review', null, '')];
    const tr = { dataset: { flag: 'models', explicit: '1' }, querySelectorAll: () => els };
    const fields = fn<unknown[]>('jmRowFields')(tr);
    expect(fields).toEqual([
      { key: `models.${role}`, kind: 'text', value: '', original: 'a', explicit: true },
      { key: 'models.review', kind: 'text', value: '', original: null, explicit: false },
    ]);
    expect(fn<unknown>('jmFlagsPatch')(fields)).toEqual({ models: { [role]: null } });
  });

  test('set, clear, an untouched empty role, a Fable model, a stale revision', async () => {
    const w = await world();
    const { fn } = pageScript();
    const send = (fields: unknown[], expectRevision = w.store.revision()) => {
      const patch = fn<Record<string, unknown>>('jmFlagsPatch')(fields);
      return {
        patch,
        r: w.patch({ patch: { dropZones: [{ id: 'jm', ...patch }] }, expectRevision }),
      };
    };
    // Set one role; the others stay empty and send nothing.
    const others = ROLES.filter((r) => r !== role).map((r) =>
      field(`models.${r}`, 'text', '', null, false),
    );
    const set = send([field(`models.${role}`, 'text', 'claude-sonnet-x', null, false), ...others]);
    expect({ dropZones: [{ id: 'jm', ...set.patch }] }).toEqual({
      dropZones: [{ id: 'jm', models: { [role]: 'claude-sonnet-x' } }],
    });
    expect((await set.r).statusCode).toBe(200);
    expect(zoneOf(w.store, 'jm').models).toEqual({ [role]: 'claude-sonnet-x' });

    // A stale revision is refused and nothing changes.
    const stale = send([field(`models.${role}`, 'text', 'other', 'claude-sonnet-x', true)], 1);
    expect((await stale.r).statusCode).toBe(409);
    expect(zoneOf(w.store, 'jm').models).toEqual({ [role]: 'claude-sonnet-x' });

    // A per-role Fable model is accepted, as the store accepts it.
    const fable = send([
      field(`models.${role}`, 'text', 'claude-fable-5-2', 'claude-sonnet-x', true),
    ]);
    expect((await fable.r).statusCode).toBe(200);
    expect(zoneOf(w.store, 'jm').models).toEqual({ [role]: 'claude-fable-5-2' });

    // Clearing sends null for that role, and the key is gone.
    const clear = send([field(`models.${role}`, 'text', '', 'claude-fable-5-2', true), ...others]);
    expect(clear.patch).toEqual({ models: { [role]: null } });
    expect((await clear.r).statusCode).toBe(200);
    expect(Object.hasOwn((zoneOf(w.store, 'jm').models ?? {}) as object, role)).toBe(false);
  });

  test('a role the store refuses shows its issue on the models row', async () => {
    const w = await world();
    const r = await w.patch({
      patch: { dropZones: [{ id: 'jm', models: { notARole: 'x' } }] },
      expectRevision: w.store.revision(),
    });
    expect(r.statusCode).toBe(400);
    const issues = (r.json() as { issues: { path: string; message: string }[] }).issues;
    const span = { textContent: '' };
    const document = {
      addEventListener: () => {},
      querySelectorAll: () => [],
      querySelector: (sel: string) => (sel === '[data-flag-issue="models"]' ? span : null),
    };
    const { fn } = pageScript(() => ({ ok: false, status: 400, json: { issues } }), { document });
    const out = stubStatus();
    expect(
      await fn<Promise<string>>('jmSaveFlags')(JM, { models: { notARole: 'x' } }, 1, out, () => {}),
    ).toBe('refused');
    expect(span.textContent).not.toBe('');
  });

  test('in file mode the role inputs are disabled', async () => {
    const w = await world({ file: true });
    const html = rowHtml((await w.get('/projects/jm/flags')).body, 'models');
    const inputs = [...html.matchAll(/<input[^>]*data-path="models\.[^"]*"[^>]*>/g)];
    expect(inputs).toHaveLength(ROLES.length);
    for (const m of inputs) expect(m[0]).toMatch(/ disabled/);
  });
});
