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
import { insertDrop, setZoneMode, upsertDropZone, upsertWorkItem } from '../db/repo.js';
import { actionFor, pagesOf } from '../doctor/actions.js';
import type { DoctorCheck } from '../doctor/checks.js';
import { operatorSession, t0, tmpDbFile } from '../test/helpers.js';
import { openVault } from '../vault/vault.js';
import { formToZone, zoneToForm } from '../zones/form.js';

const TOKEN = 'o'.repeat(32);
const HOST = '127.0.0.1:7420';
const ORIGIN = `http://${HOST}`;
const PASS = 'a long operator passphrase';
const CLAUDE = 'sk-ant-oat01-ZONESCLAUDEDUMMY0123456789';
const AUTHOR = 'github_pat_ZONESAUTHORDUMMY0123456789';
const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };
const esc = (s: string) => s.replaceAll("'", '&#39;').replaceAll('"', '&quot;');

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const zoneDoc = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 20 }],
  preset: 'node',
  egress: { mode: 'monitor', allow: ['known.example.com'] },
  ...extra,
});

/**
 * A db-mode install (or file mode with `file`) with two zones: `main` (two-bot, no reviewer token,
 * so a credential problem) and `img` (an explicit image, starter).
 */
async function world(o: { file?: boolean } = {}) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-zones-'));
  const keyFile = join(dir, 'vault_key');
  writeFileSync(keyFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const filePath = join(dir, 'jumpmaster.config.json');
  const zones = [
    zoneDoc('main'),
    zoneDoc('img', {
      preset: undefined,
      image: `ghcr.io/x/trooper@sha256:${'c'.repeat(64)}`,
      identity: 'starter',
      authorMayBeAdmin: true,
    }),
  ];
  if (o.file) writeFileSync(filePath, JSON.stringify({ dataDir: './data', dropZones: zones }));
  const env = {
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
    JM_DEV_IMAGES: '1',
    JM_CLAUDE_TOKEN: CLAUDE,
    JM_GITHUB_AUTHOR_TOKEN: AUTHOR,
  };
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, filePath),
    filePath,
    env,
    vault: openVault(keyFile, db),
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  if (!o.file) store.apply({ dropZones: zones }, { via: 'ctl', principal: token });
  for (const z of zones)
    upsertDropZone(db, { id: z.id, repo: z.repo, defaultBranch: 'main', configJson: '{}' });
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
  await setOperatorPassphrase(db, PASS, t0);
  const s = operatorSession(db);
  const get = (url: string) =>
    a.inject({ method: 'GET', url, headers: { host: HOST, cookie: s.cookie } });
  const api = (method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, asToken = false) =>
    a.inject({
      method,
      url,
      headers: asToken
        ? { host: HOST, authorization: `Bearer ${TOKEN}` }
        : { host: HOST, cookie: s.cookie, 'x-jm-csrf': s.csrf },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  return { db, store, app: a, get, api, session: s };
}

/** The `<form id=…>` element's HTML, for section assertions. */
const section = (html: string, id: string): string => {
  const at = html.indexOf(`<form id="${id}"`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf('</form>', at));
};

describe('the zones page', () => {
  test('/zones lists every zone with its plain-English mode, egress mode, identity and credential problem, links its page, and owns the home page add link', async () => {
    const w = await world();
    setZoneMode(w.db, 'img', 'observe', t0);
    const r = await w.get('/zones');
    expect(r.statusCode).toBe(200);
    for (const id of ['main', 'img']) {
      expect(r.body).toContain(`href="/zones/${id}"`);
      expect(r.body).toContain(`href="/zones/${id}/github"`);
    }
    expect(r.body).toContain('active: takes ready issues and runs drops');
    expect(r.body).toContain('observe: plans and records, but writes nothing to GitHub');
    expect(r.body).toContain('monitor');
    expect(r.body).toContain('starter');
    // main is two-bot with no reviewer token: its problem, linked to the Credentials tab.
    expect(r.body).toMatch(/reviewer token[^<]*<\/span> <a href="\/settings\/credentials">/);
    // Only the transitions that apply: main is active (Pause, Observe), img observes (Resume, Pause).
    const row = (id: string) => {
      const at = r.body.indexOf(`href="/zones/${id}"`);
      return r.body.slice(at, r.body.indexOf('</tr>', at));
    };
    expect(row('main')).toContain('data-mode="paused"');
    expect(row('main')).toContain('data-mode="observe"');
    expect(row('main')).not.toContain('data-mode="active"');
    expect(row('img')).toContain('data-mode="active"');
    expect(row('img')).toContain('data-mode="paused"');
    expect(row('img')).not.toContain('data-mode="observe"');
    expect(r.body).toContain('href="/zones/new"');
    const home = await w.get('/');
    expect(home.body).toContain('<a href="/zones/new">Add a project</a>');
    expect(home.body).not.toContain('href="/setup/project"');
    expect(home.body).toContain('href="/zones"');
  });

  test('each section of the zone page is filled from the current config and posts a patch with expectRevision', async () => {
    const w = await world();
    const r = await w.get('/zones/main');
    expect(r.statusCode).toBe(200);
    for (const id of ['project', 'stack', 'egress', 'merging', 'advanced']) section(r.body, id);
    expect(section(r.body, 'project')).toContain('name="readyLabel" value="agent-ready"');
    expect(section(r.body, 'stack')).toContain('<option value="node" selected>');
    expect(section(r.body, 'stack')).toContain('name="gate.run" value="npm test"');
    expect(section(r.body, 'egress')).toContain('known.example.com');
    expect(section(r.body, 'merging')).toContain('name="ciRequired" value="1" checked');
    expect(r.body).toContain(`const REVISION = ${w.store.revision()};`);
    expect(r.body).toContain(
      "jmFetch('/api/control/config', { patch: { dropZones: [patch] }, expectRevision: REVISION",
    );
    expect(r.body).toContain('function formToZone(');
    // What the browser would send for the Project section, posted as the page posts it.
    const fields = { ...zoneToForm(w.store.current().dropZones[0] as never), readyLabel: 'go' };
    const { id, readyLabel, retryLabel, adoptPulls } = formToZone(fields) as Record<
      string,
      unknown
    >;
    const res = await w.api('PATCH', '/api/control/config', {
      patch: { dropZones: [{ id, readyLabel, retryLabel, adoptPulls }] },
      expectRevision: w.store.revision(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(w.store.current().dropZones.map((z) => z.readyLabel)).toEqual(['go', 'agent-ready']);
  });

  test('a schema issue is rendered beside the field its path names', async () => {
    const w = await world();
    const page = (await w.get('/zones/main')).body;
    // Every field the issue mapping names has a place on the page for its issue.
    for (const f of ['readyLabel', 'gates', 'ciDeadlineMinutes', 'egress.allow', 'advanced'])
      expect(page, f).toContain(`data-issues="${f}"`);
    expect(page).toContain('const ZONE_INDEX = 0;');
    expect(page).toContain('issueField(i.path, ZONE_INDEX)');
    const r = await w.api('PATCH', '/api/control/config', {
      patch: { dropZones: [{ id: 'main', ciDeadlineMinutes: 'soon' }] },
      expectRevision: w.store.revision(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().issues[0].path).toBe('dropZones.0.ciDeadlineMinutes');
  });

  test('a guarded change from a session goes to the confirmation page and succeeds with the token', async () => {
    const w = await world();
    const page = (await w.get('/zones/main')).body;
    expect(page).toContain('j.needsConfirmation');
    expect(page).toContain('returnTo: "/zones/main#" + section');
    const patch = { dropZones: [{ id: 'main', ciRequired: false }] };
    const s = await w.api('PATCH', '/api/control/config', {
      patch,
      expectRevision: w.store.revision(),
      returnTo: '/zones/main#merging',
      cancelTo: '/zones/main',
    });
    expect(s.statusCode).toBe(409);
    const confirm = await w.get(s.json().confirm);
    expect(confirm.body).toContain('Agent PRs in main will merge without CI');
    expect(confirm.body).toContain('<a href="/zones/main">Cancel</a>');
    const t = await w.api(
      'PATCH',
      '/api/control/config',
      { patch, expectRevision: w.store.revision() },
      true,
    );
    expect(t.statusCode).toBe(200);
    expect(w.store.current().dropZones[0]?.ciRequired).toBe(false);
    // A session-forbidden change renders the note.
    expect(page).toContain('j.sessionForbidden');
    expect(page).toContain('set with <code>jumpmaster ctl</code> or in the config file');
  });

  test('the image and the repo are read-only on the page with their notes', async () => {
    const w = await world();
    const img = (await w.get('/zones/img')).body;
    expect(section(img, 'stack')).toContain(`ghcr.io/x/trooper@sha256:${'c'.repeat(64)}`);
    expect(section(img, 'stack')).not.toContain('name="image"');
    expect(section(img, 'stack')).toContain(
      'set with <code>jumpmaster ctl</code> or in the config file',
    );
    expect(section(img, 'project')).toContain('octo/img');
    expect(section(img, 'project')).not.toContain('name="repo"');
    expect(section(img, 'project')).toContain('remove and re-add to change');
    // The starter warning, verbatim, in Merging.
    expect(section(img, 'merging')).toContain(esc(STARTER_WARNING));
    // readyLabel carries its note.
    expect(section(img, 'project')).toContain(
      'renaming to a label already on many issues dispatches them all',
    );
  });

  test('in file mode the zone page is read-only and shows the adopt banner', async () => {
    const w = await world({ file: true });
    const r = await w.get('/zones/main');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Your config file holds these zones');
    expect(r.body).toContain("'/api/control/config/adopt'");
    for (const id of ['project', 'stack', 'egress', 'merging', 'advanced']) {
      expect(section(r.body, id)).toContain('<fieldset disabled>');
      expect(section(r.body, id)).not.toContain('<button>Save');
    }
    expect((await w.get('/zones')).body).not.toContain('href="/zones/new"');
  });

  test('an id with history offers Resume, and resume brings the history back under a fresh mode row', async () => {
    const w = await world();
    const add = (await w.get('/zones/new')).body;
    expect(add).toContain('j.history');
    expect(add).toContain('resume: true');
    expect(add).toContain('name="id"');
    // A removed zone with history comes back paused, whatever row it left.
    upsertDropZone(w.db, { id: 'old', repo: 'octo/old', defaultBranch: 'main', configJson: '{}' });
    upsertWorkItem(w.db, {
      dropZoneId: 'old',
      issueNumber: 1,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    const zone = {
      repo: 'octo/old',
      id: 'old',
      preset: 'node',
      gates: [{ name: 't', run: 'true' }],
    };
    const refused = await w.api('POST', '/api/control/zones', { zone }, true);
    expect(refused.json().history).toMatchObject({ workItems: 1 });
    const resumed = await w.api('POST', '/api/control/zones', { zone, resume: true }, true);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await w.get('/zones')).body).toMatch(/old<\/a>[\s\S]*?paused: starts nothing new/);
  });

  test('the egress section lists observed hosts with their drops and marks those no preset lists', async () => {
    const w = await world();
    for (const [drop, host] of [
      ['d1', 'new.example.com'],
      ['d2', 'registry.npmjs.org'],
    ] as const) {
      insertDrop(w.db, {
        id: drop,
        dropZoneId: 'main',
        workItemId: null,
        role: 'doctor',
        state: 'succeeded',
        createdAt: t0.toISOString(),
      });
      w.db
        .prepare(
          `INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, 1, ?, 'egress', ?)`,
        )
        .run(drop, t0.toISOString(), JSON.stringify({ host, decision: 'allowed', count: 2 }));
    }
    const egress = section((await w.get('/zones/main')).body, 'egress');
    expect(egress).toContain('Observed in the last 14 days');
    expect(egress).toMatch(
      /new\.example\.com[\s\S]*?href="\/drops\/d1"[\s\S]*?not in this zone&#39;s lists/,
    );
    expect(egress).toMatch(/registry\.npmjs\.org[\s\S]*?listed by the node preset/);
    expect(egress).toContain('name="adopt" value="new.example.com"');
    expect(egress).toContain('Adopt ticked');
    // The residual, beside the button: a host may have been reached by a hostile drop.
    expect(egress).toContain(
      'a drop that misbehaved may have reached it: adopt only hosts you recognise',
    );
  });

  test("a host is judged against this zone's own lists: another preset's host gets a tick box", async () => {
    const w = await world();
    // A jvm zone reached npm's registry: the node preset lists it, but this zone's drops are
    // allowed only the base, the jvm preset's hosts and the zone's own entries.
    const r = await w.api(
      'PATCH',
      '/api/control/config',
      { patch: { dropZones: [{ id: 'main', preset: 'jvm' }] }, expectRevision: w.store.revision() },
      true,
    );
    expect(r.statusCode, r.body).toBe(200);
    insertDrop(w.db, {
      id: 'j1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'doctor',
      state: 'succeeded',
      createdAt: t0.toISOString(),
    });
    for (const [seq, host] of [
      [1, 'registry.npmjs.org'],
      [2, 'repo.maven.apache.org'],
      [3, 'known.example.com'],
      [4, 'github.com'],
    ] as const)
      w.db
        .prepare(
          `INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES ('j1', ?, ?, 'egress', ?)`,
        )
        .run(seq, t0.toISOString(), JSON.stringify({ host, decision: 'allowed', count: 1 }));
    const egress = section((await w.get('/zones/main')).body, 'egress');
    expect(egress).toContain('name="adopt" value="registry.npmjs.org"');
    expect(egress).toMatch(/repo\.maven\.apache\.org[\s\S]*?listed by the jvm preset/);
    expect(egress).not.toContain('name="adopt" value="repo.maven.apache.org"');
    expect(egress).toMatch(/known\.example\.com[\s\S]*?listed by this zone&#39;s allow list/);
    expect(egress).toMatch(/github\.com[\s\S]*?listed by every drop/);
  });

  test('the Remove button has no confirmation branch: removal is not a guarded change', async () => {
    const page = (await (await world()).get('/zones/main')).body;
    const remove = page.slice(page.indexOf("getElementById('remove')"));
    expect(remove.slice(0, remove.indexOf('});'))).not.toContain('needsConfirmation');
  });

  test('pause, resume and observe from the zones page keep the existing guards', async () => {
    const w = await world();
    const page = (await w.get('/zones')).body;
    expect(page).toContain(
      "jmFetch('/api/control/zones/' + encodeURIComponent(b.dataset.zone), { mode: b.dataset.mode })",
    );
    // Observe with work running is refused as before.
    upsertWorkItem(w.db, {
      dropZoneId: 'main',
      issueNumber: 2,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(w.db, {
      id: 'busy',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'queued',
      createdAt: t0.toISOString(),
    });
    const r = await w.api('POST', '/api/control/zones/main', { mode: 'observe' });
    expect(r.statusCode).toBe(409);
    expect((await w.api('POST', '/api/control/zones/main', { mode: 'paused' })).statusCode).toBe(
      200,
    );
  });

  test('zone doctor checks now link to the zone page sections', async () => {
    const w = await world();
    const pages = pagesOf(w.app);
    expect(pages.zones).toBe(true);
    const zone = w.store.current().dropZones[0] as never;
    const page = (await w.get('/zones/main')).body;
    for (const [id, anchor] of [
      ['zone.preset', 'stack'],
      ['zone.services', 'stack'],
      ['zone.egress', 'egress'],
      ['zone.identity', 'merging'],
      ['zone.goals', 'advanced'],
      ['zone.crew-cap', 'advanced'],
    ] as const) {
      const check: DoctorCheck = { id, zoneId: 'main', status: 'fail', summary: 'x' };
      expect(actionFor(check, { zone, pages })?.href, id).toBe(`/zones/main#${anchor}`);
      expect(page, anchor).toContain(`id="${anchor}"`);
    }
    expect(
      actionFor({ id: 'zone.mode', zoneId: 'main', status: 'warn', summary: 'x' }, { zone, pages })
        ?.href,
    ).toBe('/zones');
  });

  test('the zone page shows no secret', async () => {
    const w = await world();
    for (const url of ['/zones', '/zones/main', '/zones/img', '/zones/new']) {
      const r = await w.get(url);
      for (const v of [CLAUDE, AUTHOR, TOKEN, 'join-secret-value-4'])
        expect(r.body, url).not.toContain(v);
    }
  });

  test('forge- and user-supplied text is escaped', async () => {
    const w = await world();
    await w.api(
      'PATCH',
      '/api/control/config',
      {
        patch: { dropZones: [{ id: 'main', readyLabel: '"><script>alert(1)</script>' }] },
        expectRevision: w.store.revision(),
      },
      true,
    );
    const r = (await w.get('/zones/main')).body;
    expect(r).not.toContain('<script>alert(1)</script>');
    expect(r).toContain('&quot;&gt;&lt;script&gt;');
    expect(ORIGIN).toBeDefined();
  });
});
