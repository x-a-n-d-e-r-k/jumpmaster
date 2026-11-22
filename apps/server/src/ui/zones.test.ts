import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import type { GuidanceForge } from '../api/github.js';
import { createApp } from '../app.js';
import { Backoff } from '../auth/backoff.js';
import { SetupMode, setOperatorPassphrase } from '../auth/operator.js';
import { raiseBriefing } from '../briefings.js';
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
const CLAUDE = 'sk-ant-' + 'oat01-ZONESCLAUDEDUMMY0123456789';
const AUTHOR = 'github_pat_' + 'ZONESAUTHORDUMMY0123456789';
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

/** A public repository with one CI job, as the GitHub section's guidance reads it. */
const fakeGuidanceForge = (_repo: string, _token: string): GuidanceForge => ({
  repoAccess: async () => ({
    private: false,
    defaultBranch: 'main',
    permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
    scopes: null,
    tokenExpiresAt: null,
    ownerType: 'Organization',
  }),
  ownerType: async () => 'Organization',
  viewerLogin: async () => 'jm-author',
  listDir: async (_ref: string, path: string) => (path === '.github/workflows' ? ['ci.yml'] : []),
  getFileAt: async (_ref: string, path: string) =>
    path === '.github/workflows/ci.yml'
      ? 'on: pull_request\njobs:\n  test:\n    runs-on: x\n'
      : null,
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
    // GitHub as the Setup tab's GitHub section reads it (#618): never the network in a test.
    guidanceForge: fakeGuidanceForge,
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

/** The Setup form's `<section id=…>` HTML, for section assertions. */
const section = (html: string, id: string): string => {
  const at = html.indexOf(`<section id="${id}" class="setup-section`);
  expect(at, id).toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf('</section>', at));
};

describe('the zones page', () => {
  test('/projects lists every zone with its plain-English mode, egress mode, identity and credential problem, links its page, and owns the home page add link', async () => {
    const w = await world();
    setZoneMode(w.db, 'img', 'observe', t0);
    const r = await w.get('/projects');
    expect(r.statusCode).toBe(200);
    for (const id of ['main', 'img']) {
      expect(r.body).toContain(`href="/projects/${id}"`);
      expect(r.body).toContain(`href="/projects/${id}/setup#github"`);
    }
    expect(r.body).toContain('active: takes ready issues and runs drops');
    expect(r.body).toContain('observe: plans and records, but writes nothing to GitHub');
    expect(r.body).toContain('monitor');
    expect(r.body).toContain('starter');
    // main is two-bot with no reviewer token: its problem, linked to the Credentials tab.
    expect(r.body).toMatch(/reviewer token[^<]*<\/span> <a href="\/settings\/credentials">/);
    // Only the transitions that apply: main is active (Pause, Observe), img observes (Resume, Pause).
    const row = (id: string) => {
      const at = r.body.indexOf(`href="/projects/${id}"`);
      return r.body.slice(at, r.body.indexOf('</tr>', at));
    };
    expect(row('main')).toContain('data-mode="paused"');
    expect(row('main')).toContain('data-mode="observe"');
    expect(row('main')).not.toContain('data-mode="active"');
    expect(row('img')).toContain('data-mode="active"');
    expect(row('img')).toContain('data-mode="paused"');
    expect(row('img')).not.toContain('data-mode="observe"');
    expect(r.body).toContain('href="/projects/new"');
    const home = await w.get('/');
    expect(home.body).toContain('<a href="/projects/new">Add a project</a>');
    expect(home.body).not.toContain('href="/setup/project"');
    expect(home.body).toContain('href="/projects"');
  });

  test('the zone page, the goals page and a briefing page each carry Ask about this with their focus', async () => {
    const w = await world();
    const body = (await w.get('/projects/main/setup')).body;
    const at = body.indexOf('<form class="ask"');
    expect(at).toBeGreaterThanOrEqual(0);
    const form = body.slice(at, body.indexOf('</form>', at));
    expect(form).toContain('Ask about this');
    expect(form).toContain('data-focus-kind="zone"');
    expect(form).toContain('data-focus-zone="main"');
    expect(form).toContain('data-focus-ref="main"');
    expect(body).toContain("jmFetch('/api/chat/threads'");
  });

  test('the setup page links its goals page from the project tabs (#365, #616)', async () => {
    const w = await world();
    const body = (await w.get('/projects/main/setup')).body;
    expect(body).toContain('<a href="/projects/main/goals">Goals</a>');
    expect(body).toMatch(/Briefings \(\d+ open\)<\/a>/);
  });

  test('the zone page header links its New issue page (#500)', async () => {
    const w = await world();
    const body = (await w.get('/projects/main/setup')).body;
    expect(body).toContain('<a href="/projects/main/issues/new">New issue</a>');
  });

  test('each section of the zone page is filled from the current config and posts a patch with expectRevision', async () => {
    const w = await world();
    const r = await w.get('/projects/main/setup');
    expect(r.statusCode).toBe(200);
    for (const id of ['project', 'stack', 'egress', 'merging', 'advanced']) section(r.body, id);
    expect(section(r.body, 'project')).toContain('name="readyLabel" value="drop-ready"');
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
    expect(w.store.current().dropZones.map((z) => z.readyLabel)).toEqual(['go', 'drop-ready']);
  });

  test("the zone page links to the zone's briefings with their count", async () => {
    const w = await world();
    for (const subject of ['crew:a', 'crew:b'])
      raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: 'crew',
          subject,
          decision: 'd',
          why: 'w',
          options: [{ id: 'ok', label: 'OK', effect: 'none' }],
          source: 'crew',
        },
        t0,
      );
    const page = (await w.get('/projects/main/setup')).body;
    expect(page).toContain('<a href="/briefings?zone=main">Briefings (2 open)</a>');
  });

  test('a schema issue is rendered beside the field its path names', async () => {
    const w = await world();
    const page = (await w.get('/projects/main/setup')).body;
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
    const page = (await w.get('/projects/main/setup')).body;
    expect(page).toContain('j.needsConfirmation');
    expect(page).toContain('const BASE = "/projects/main/setup";');
    expect(page).toContain('returnTo: BASE, cancelTo: BASE');
    const patch = { dropZones: [{ id: 'main', ciRequired: false }] };
    const s = await w.api('PATCH', '/api/control/config', {
      patch,
      expectRevision: w.store.revision(),
      returnTo: '/projects/main/setup#merging',
      cancelTo: '/projects/main/setup',
    });
    expect(s.statusCode).toBe(409);
    const confirm = await w.get(s.json().confirm);
    expect(confirm.body).toContain('Agent PRs in main will merge without CI');
    expect(confirm.body).toContain('<a href="/projects/main/setup">Cancel</a>');
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
    const img = (await w.get('/projects/img/setup')).body;
    expect(section(img, 'stack')).toContain(`ghcr.io/x/trooper@sha256:${'c'.repeat(64)}`);
    expect(section(img, 'stack')).not.toContain('name="image"');
    expect(section(img, 'stack')).toContain(
      'set with <code>jumpmaster ctl</code> or in the config file',
    );
    expect(section(img, 'project')).toContain('octo/img');
    expect(section(img, 'project')).not.toContain('name="repo"');
    expect(section(img, 'project')).toContain('remove and re-add to change');
    // The starter warning in Merging, its label once.
    expect(section(img, 'merging')).toContain(esc(STARTER_WARNING.replace(/^starter mode: /i, '')));
    // readyLabel carries its note.
    expect(section(img, 'project')).toContain(
      'renaming to a label already on many issues dispatches them all',
    );
  });

  test('in file mode the zone page is read-only and shows the adopt banner', async () => {
    const w = await world({ file: true });
    const r = await w.get('/projects/main/setup');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Your config file holds these zones');
    expect(r.body).toContain("'/api/control/config/adopt'");
    for (const id of ['project', 'stack', 'egress', 'merging', 'advanced']) section(r.body, id);
    const form = r.body.slice(r.body.indexOf('<form id="setup-form"'));
    expect(form.slice(0, form.indexOf('<section'))).toContain('<fieldset disabled>');
    expect(r.body).not.toContain('id="save-bar"');
    expect(r.body).not.toContain('id="setup-script"');
    expect((await w.get('/projects')).body).not.toContain('href="/projects/new"');
  });

  test('an id with history offers Resume, and resume brings the history back under a fresh mode row', async () => {
    const w = await world();
    const add = (await w.get('/projects/new')).body;
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
    expect((await w.get('/projects')).body).toMatch(/old<\/a>[\s\S]*?paused: starts nothing new/);
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
    const egress = section((await w.get('/projects/main/setup')).body, 'egress');
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

  /** Seeds `drops` drops in `main`, oldest first, each reaching every host in `hosts`. */
  const seedEgress = (
    db: ReturnType<typeof openDb>,
    hosts: { host: string; count?: number }[],
    drops: number,
    prefix = 'drop',
  ) => {
    const ids = Array.from(
      { length: drops },
      (_, i) => `${prefix}${String(i).padStart(5, '0')}xyz`,
    );
    db.transaction(() => {
      ids.forEach((id, i) => {
        insertDrop(db, {
          id,
          dropZoneId: 'main',
          workItemId: null,
          role: 'doctor',
          state: 'succeeded',
          createdAt: new Date(t0.getTime() - (drops - i) * 1000).toISOString(),
        });
        hosts.forEach((h, seq) =>
          db
            .prepare(
              `INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, ?, ?, 'egress', ?)`,
            )
            .run(
              id,
              seq + 1,
              t0.toISOString(),
              JSON.stringify({ host: h.host, decision: 'allow', count: h.count ?? 1 }),
            ),
        );
      });
    })();
    return ids;
  };
  /** The observed table row for `host`. */
  const rowOf = (egress: string, host: string): string => {
    const at = egress.indexOf(`<tr><td>${host}</td>`);
    expect(at, host).toBeGreaterThanOrEqual(0);
    return egress.slice(at, egress.indexOf('</tr>', at));
  };
  const dropLinks = (html: string) => html.match(/href="\/drops\/[^"?]+"/g) ?? [];

  test('the observed table has Host, Decision, Connections, Drops, Listed and Adopt columns', async () => {
    const w = await world();
    seedEgress(w.db, [{ host: 'new.example.com', count: 4 }], 2);
    const egress = section((await w.get('/projects/main/setup')).body, 'egress');
    expect(egress).toContain(
      '<tr><th>Host</th><th>Decision</th><th>Connections</th><th>Drops</th><th>Listed</th><th>Adopt</th></tr>',
    );
    expect(rowOf(egress, 'new.example.com')).toMatch(
      /^<tr><td>new\.example\.com<\/td><td>allow<\/td><td>8<\/td><td>2 /,
    );
  });

  test('a host with 25 drops shows the count and links the newest 20, then "and 5 more"', async () => {
    const w = await world();
    const ids = seedEgress(w.db, [{ host: 'new.example.com' }], 25);
    const row = rowOf(
      section((await w.get('/projects/main/setup')).body, 'egress'),
      'new.example.com',
    );
    expect(row).toMatch(/<td>25 <details><summary>show 25<\/summary>/);
    const links = dropLinks(row);
    expect(links).toHaveLength(20);
    for (const id of ids.slice(5)) {
      expect(row).toContain(`href="/drops/${id}"`);
      expect(row).toContain(`>${id.slice(0, 8)}</a>`);
    }
    for (const id of ids.slice(0, 5)) expect(row).not.toContain(`/drops/${id}`);
    expect(row).toContain('<a href="/drops?zone=main&amp;kind=all">and 5 more</a>');
  });

  test('"and M more" opens a drops list that includes the doctor drops it counts', async () => {
    const w = await world();
    const ids = seedEgress(w.db, [{ host: 'new.example.com' }], 25);
    const row = rowOf(
      section((await w.get('/projects/main/setup')).body, 'egress'),
      'new.example.com',
    );
    const href = /<a href="(\/drops\?[^"]+)">and 5 more<\/a>/.exec(row)?.[1];
    expect(href).toBeDefined();
    const list = (await w.get(href!.replaceAll('&amp;', '&'))).body;
    for (const id of ids.slice(0, 5)) expect(list).toContain(`/drops/${id}`);
  });

  test('a host with 3 drops links all three and no "more" line', async () => {
    const w = await world();
    const ids = seedEgress(w.db, [{ host: 'new.example.com' }], 3);
    const row = rowOf(
      section((await w.get('/projects/main/setup')).body, 'egress'),
      'new.example.com',
    );
    expect(row).toContain('<summary>show 3</summary>');
    expect(dropLinks(row)).toHaveLength(3);
    for (const id of ids) expect(row).toContain(`href="/drops/${id}"`);
    expect(row).not.toContain('more');
    expect(row).not.toContain('/drops?zone=');
  });

  test('counts render with en-US thousands separators', async () => {
    const w = await world();
    seedEgress(w.db, [{ host: 'registry.npmjs.org', count: 19510 }], 1);
    const row = rowOf(
      section((await w.get('/projects/main/setup')).body, 'egress'),
      'registry.npmjs.org',
    );
    expect(row).toContain('<td>19,510</td>');
  });

  test('50 hosts reached by 300 drops each link at most 20 drops per host', async () => {
    const w = await world();
    const hosts = Array.from({ length: 50 }, (_, i) => ({ host: `h${i}.example.com` }));
    seedEgress(w.db, hosts, 300);
    const egress = section((await w.get('/projects/main/setup')).body, 'egress');
    const links = dropLinks(egress);
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(50 * 20);
    expect(egress).toContain('and 280 more');
  });

  test('adopt checkboxes render for an unlisted host and not for a listed one', async () => {
    const w = await world();
    seedEgress(w.db, [{ host: 'new.example.com' }, { host: 'registry.npmjs.org' }], 2);
    const egress = section((await w.get('/projects/main/setup')).body, 'egress');
    expect(rowOf(egress, 'new.example.com')).toContain(
      '<input type="checkbox" name="adopt" value="new.example.com">',
    );
    const listed = rowOf(egress, 'registry.npmjs.org');
    expect(listed).toContain('listed by the node preset');
    expect(listed).not.toContain('name="adopt"');
    expect(egress).toContain('Adopt ticked');
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
    const egress = section((await w.get('/projects/main/setup')).body, 'egress');
    expect(egress).toContain('name="adopt" value="registry.npmjs.org"');
    expect(egress).toMatch(/repo\.maven\.apache\.org[\s\S]*?listed by the jvm preset/);
    expect(egress).not.toContain('name="adopt" value="repo.maven.apache.org"');
    expect(egress).toMatch(/known\.example\.com[\s\S]*?listed by this zone&#39;s allow list/);
    expect(egress).toMatch(/github\.com[\s\S]*?listed by every drop/);
  });

  test('the Zones list shows Stop managing on each zone row, with a confirmation naming the repository and what happens', async () => {
    const w = await world();
    const r = (await w.get('/projects')).body;
    for (const id of ['main', 'img']) {
      const at = r.indexOf(`href="/projects/${id}"`);
      const row = r.slice(at, r.indexOf('</tr>', at));
      expect(row).toContain(`<button class="stop" data-zone="${id}"`);
      expect(row).toContain('Stop managing</button>');
      const confirm = row.match(/data-confirm="([^"]*)"/)?.[1] ?? '';
      expect(confirm).toContain(`octo/${id}`);
      expect(confirm).toContain('no new work');
      expect(confirm).toContain('Open pull requests are left as they are');
      expect(confirm).toContain('history is kept, for a later Resume');
    }
    // One confirmed click, one call: the removal's DELETE, no guarded-change branch.
    const script = r.slice(r.indexOf("querySelectorAll('button.stop')"));
    expect(script).toContain('if (!confirm(b.dataset.confirm)) return;');
    expect(script).toContain("encodeURIComponent(b.dataset.zone), {}, 'DELETE')");
    expect(script.slice(0, script.indexOf('});'))).not.toContain('needsConfirmation');
  });

  test('the setup page offers Stop managing only in its Danger zone, after the settings (#617)', async () => {
    const page = (await (await world()).get('/projects/main/setup')).body;
    const danger = page.slice(page.indexOf('<section id="danger"'));
    expect(page.indexOf('<section id="danger"')).toBeGreaterThan(
      page.indexOf('</form>', page.indexOf('<form id="setup-form"')),
    );
    expect(danger).toContain('<h3>Danger zone</h3>');
    expect(danger).toContain('Type <code>octo/main</code> to confirm');
    expect(danger).toContain('id="stop-managing" disabled>Stop managing this project</button>');
    expect(danger).toContain('Open pull requests are left as they are');
    expect(page.match(/class="stop/g)).toHaveLength(1);
    expect(page).not.toContain('<h3>Remove</h3>');
  });

  test('a stopping zone shows as stopping with what it waits for, by count, on the list and its page', async () => {
    const w = await world();
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
      state: 'running',
      createdAt: t0.toISOString(),
    });
    const r = await w.api('DELETE', '/api/control/zones/main');
    expect(r.statusCode, r.body).toBe(202);
    const waiting = 'stopping: waiting for 1 running drop, 0 pending pushes, 0 outbox writes';
    const list = (await w.get('/projects')).body;
    const at = list.indexOf('href="/projects/main"');
    const row = list.slice(at, list.indexOf('</tr>', at));
    expect(row).toContain(waiting);
    // Already stopping: no second Stop, and no mode button but Resume (which withdraws it).
    expect(row).not.toContain('class="stop"');
    expect(row).toContain('data-mode="active"');
    expect((await w.get('/projects/main/setup')).body).toContain(waiting);
    // Not removed while the drop runs; the already-drained zone goes at once.
    expect(w.store.current().dropZones.map((z) => z.id)).toEqual(['main', 'img']);
    expect((await w.api('DELETE', '/api/control/zones/img')).json()).toMatchObject({
      removed: 'img',
    });
  });

  test('a read-only (file-mode) config shows no Stop managing control', async () => {
    const w = await world({ file: true });
    expect((await w.get('/projects')).body).not.toContain('class="stop"');
    expect((await w.get('/projects/main/setup')).body).not.toContain('class="stop"');
  });

  test('pause, resume and observe from the zones page keep the existing guards', async () => {
    const w = await world();
    const page = (await w.get('/projects')).body;
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
    const page = (await w.get('/projects/main/setup')).body;
    for (const [id, anchor] of [
      ['zone.preset', 'stack'],
      ['zone.services', 'stack'],
      ['zone.egress', 'egress'],
      ['zone.identity', 'merging'],
      ['zone.goals', 'advanced'],
      ['zone.crew-cap', 'advanced'],
    ] as const) {
      const check: DoctorCheck = { id, zoneId: 'main', status: 'fail', summary: 'x' };
      expect(actionFor(check, { zone, pages })?.href, id).toBe(`/projects/main/setup#${anchor}`);
      expect(page, anchor).toContain(`id="${anchor}"`);
    }
    expect(
      actionFor({ id: 'zone.mode', zoneId: 'main', status: 'warn', summary: 'x' }, { zone, pages })
        ?.href,
    ).toBe('/projects');
  });

  test('the zone page shows no secret', async () => {
    const w = await world();
    for (const url of ['/projects', '/projects/main', '/projects/img', '/projects/new']) {
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
    const r = (await w.get('/projects/main/setup')).body;
    expect(r).not.toContain('<script>alert(1)</script>');
    expect(r).toContain('&quot;&gt;&lt;script&gt;');
    expect(ORIGIN).toBeDefined();
  });
});

describe('zones are named by their repository (#99)', () => {
  test('the Zones list names each zone by repository, and its messages use that name', async () => {
    const w = await world();
    const r = (await w.get('/projects')).body;
    expect(r).toContain('<th>Project</th>');
    expect(r).toContain('<a href="/projects/main">octo/main</a>');
    expect(r).toContain('<a href="/projects/img">octo/img</a>');
    expect(r).not.toMatch(/>main</);
    expect(r).toContain('data-name="octo/main"');
    expect(r).toContain("b.dataset.name + ': '");
    expect(r).not.toContain("b.dataset.zone + ': '");
  });

  test('a zone page heads with the repository and keeps the zone id on a detail line', async () => {
    const page = (await (await world()).get('/projects/main/setup')).body;
    expect(page).toContain('<title>Jumpmaster: octo/main</title>');
    expect(page).toContain('<h2>octo/main <span class="badge ok">active</span></h2>');
    expect(page).not.toContain('<h2>Zone main</h2>');
    expect(section(page, 'advanced')).toContain('Zone id: <code>main</code>');
  });
});

/** The Backlog section's script source. */
const backlogScript = (html: string): string => {
  const at = html.indexOf('<script id="backlog-script">');
  expect(at).toBeGreaterThanOrEqual(0);
  return html.slice(at, html.indexOf('</script>', at));
};

describe('the Backlog section (#346)', () => {
  test('the zone page has a Backlog section that loads from the backlog route', async () => {
    const w = await world();
    const r = await w.get('/projects/main/setup');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<section id="backlog">');
    expect(r.body).toContain('id="backlog-rows"');
    expect(r.body).toContain(
      'Issues with no Jumpmaster label. Work on it puts the ready label on.',
    );
    const script = backlogScript(r.body);
    expect(script).toContain("'/api/control/zones/'+");
    expect(script).toContain("'/backlog'");
    expect(script).toContain("'/queue'");
    expect(script).toContain("'Work on it'");
    expect(script).toContain('Queued: the next pass picks it up');
  });

  test('in file mode the Backlog section still shows', async () => {
    const w = await world({ file: true });
    const r = await w.get('/projects/main/setup');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<section id="backlog">');
    expect(backlogScript(r.body)).toContain("'Work on it'");
  });

  test('the script escapes issue titles', async () => {
    const w = await world();
    const script = backlogScript((await w.get('/projects/main/setup')).body);
    expect(script).toContain('textContent');
    expect(script.replaceAll(' ', '')).not.toContain('innerHTML=');
  });
});

/** The Merging section's starter-mode warning paragraph (opening tag through `</p>`). */
const starterWarning = (html: string): string | undefined => {
  const m = /<p class="warn" id="starter-warning"[^>]*>[\s\S]*?<\/p>/.exec(
    section(html, 'merging'),
  );
  return m?.[0];
};
const isHidden = (p: string | undefined) => p === undefined || /^<p[^>]*\shidden[\s>]/.test(p);

/** The identity script source (without its tags). */
const identityScript = (html: string): string => {
  const at = html.indexOf('<script id="identity-script">');
  expect(at).toBeGreaterThanOrEqual(0);
  return html.slice(at + '<script id="identity-script">'.length, html.indexOf('</script>', at));
};

describe('the starter-mode warning (#494)', () => {
  test('a two-bot zone hides it; a starter zone shows it', async () => {
    const w = await world();
    expect(isHidden(starterWarning((await w.get('/projects/main/setup')).body))).toBe(true);
    const img = starterWarning((await w.get('/projects/img/setup')).body);
    expect(img).toBeDefined();
    expect(isHidden(img)).toBe(false);
    expect(img).toContain('<strong>Starter mode:</strong> the author token can merge any green PR');
  });

  test('the theme lets `hidden` win over `.warn{display:block}`', async () => {
    const w = await world();
    expect((await w.get('/projects/main/setup')).body).toContain(
      '[hidden]{display:none!important}',
    );
  });

  test('the label is never doubled, for either identity', async () => {
    const w = await world();
    for (const id of ['main', 'img']) {
      const merging = section((await w.get(`/projects/${id}/setup`)).body, 'merging');
      expect(merging).not.toMatch(/starter mode:(\s|<\/strong>)*starter mode/i);
      const p = starterWarning((await w.get(`/projects/${id}/setup`)).body) ?? '';
      expect(p.replace(/<[^>]+>/g, '')).not.toMatch(/starter mode:\s*starter mode/i);
    }
  });

  test('a read-only page follows the same rule', async () => {
    const w = await world({ file: true });
    expect(isHidden(starterWarning((await w.get('/projects/main/setup')).body))).toBe(true);
    const img = starterWarning((await w.get('/projects/img/setup')).body);
    expect(img).toBeDefined();
    expect(isHidden(img)).toBe(false);
  });

  test('the page script toggles it as the Accounts select changes, with no fetch', async () => {
    const w = await world();
    const script = identityScript((await w.get('/projects/main/setup')).body);
    const listeners: Record<string, (() => void)[]> = {};
    const select = {
      value: 'two-bot',
      addEventListener: (ev: string, fn: () => void) => {
        (listeners[ev] ??= []).push(fn);
      },
    };
    const warning = { hidden: true };
    const document = {
      querySelector: (sel: string) => (sel === '#identity select[name=identity]' ? select : null),
      getElementById: (id: string) => (id === 'starter-warning' ? warning : null),
    };
    let fetched = 0;
    vm.runInContext(
      script,
      vm.createContext({
        document,
        fetch: () => {
          fetched++;
          return Promise.reject(new Error('no fetch'));
        },
      }),
    );
    const change = (v: string) => {
      select.value = v;
      for (const fn of listeners.change ?? []) fn();
    };
    expect(warning.hidden).toBe(true);
    change('starter');
    expect(warning.hidden).toBe(false);
    change('two-bot');
    expect(warning.hidden).toBe(true);
    expect(fetched).toBe(0);
  });
});

/** The project tab bar's links, as `[label, href, current]`. */
const tabsOf = (html: string): [string, string, boolean][] => {
  const at = html.indexOf('<nav class="settings-tabs project-tabs"');
  expect(at).toBeGreaterThanOrEqual(0);
  const nav = html.slice(at, html.indexOf('</nav>', at));
  return [...nav.matchAll(/<a href="([^"]*)"( aria-current="page")?>([^<]*)<\/a>/g)].map((m) => [
    m[3] ?? '',
    m[1] ?? '',
    m[2] !== undefined,
  ]);
};

/** The HTML of the Overview section with `id`, or undefined when absent. */
const block = (html: string, id: string): string | undefined => {
  const at = html.indexOf(`<section id="${id}">`);
  return at === -1 ? undefined : html.slice(at, html.indexOf('</section>', at));
};

const seedItem = (db: ReturnType<typeof openDb>, n: number, minutes: number, title = `Item ${n}`) =>
  upsertWorkItem(
    db,
    {
      dropZoneId: 'main',
      issueNumber: n,
      title,
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    },
    new Date(t0.getTime() - minutes * 60_000),
  );

const seedGoals = (db: ReturnType<typeof openDb>, done: boolean[]) =>
  db
    .prepare(
      "INSERT INTO goals (zone_id, parser_version, parse_json, read_at) VALUES ('main', 1, ?, ?)",
    )
    .run(
      JSON.stringify({
        ok: true,
        lighthouse: 'l',
        sections: {},
        objectives: done.map((d, i) => ({
          key: `o${i}`,
          title: `Objective ${i}`,
          done: d,
          body: '',
        })),
      }),
      t0.toISOString(),
    );

describe('a project: tabs, header and Overview (#616)', () => {
  test('the tab bar has five tabs: Overview current on the project page, Setup on /setup', async () => {
    const w = await world();
    const overview = tabsOf((await w.get('/projects/main')).body);
    expect(overview).toEqual([
      ['Overview', '/projects/main', true],
      ['Work', '/projects/main/work', false],
      ['Goals', '/projects/main/goals', false],
      ['Setup', '/projects/main/setup', false],
      ['Log', '/projects/main/log', false],
    ]);
    const setup = tabsOf((await w.get('/projects/main/setup')).body);
    expect(setup.filter(([, , c]) => c).map(([l]) => l)).toEqual(['Setup']);
    expect(setup).toHaveLength(5);
    const goals = tabsOf((await w.get('/projects/main/goals')).body);
    expect(goals.filter(([, , c]) => c).map(([l]) => l)).toEqual(['Goals']);
  });

  test('every project page heads with the repository, mode badge, Ask, Pause or Resume and New issue', async () => {
    const w = await world();
    for (const url of ['/projects/main', '/projects/main/setup', '/projects/main/goals']) {
      const body = (await w.get(url)).body;
      expect(body, url).toContain('<h2>octo/main <span class="badge ok">active</span></h2>');
      expect(body, url).toContain('data-focus-zone="main"');
      expect(body, url).toContain('data-mode="paused">Pause</button>');
      expect(body, url).toContain('<a href="/projects/main/issues/new">New issue</a>');
    }
    expect((await w.get('/projects/main')).body).toContain('data-focus-kind="zone"');
    setZoneMode(w.db, 'main', 'paused', t0);
    const paused = (await w.get('/projects/main')).body;
    expect(paused).toContain('<span class="badge warn-b">paused</span>');
    expect(paused).toContain('data-mode="active">Resume</button>');
  });

  test('Setup holds the forms and the Backlog; the Overview holds none of them', async () => {
    const w = await world();
    const setup = (await w.get('/projects/main/setup')).body;
    for (const id of ['project', 'stack', 'egress', 'merging', 'advanced']) section(setup, id);
    expect(setup).toContain('<section id="backlog">');
    const overview = (await w.get('/projects/main')).body;
    expect(overview).not.toContain('<section id="egress"');
    expect(overview).not.toContain('<section id="merging"');
    expect(overview).not.toContain('<form id="setup-form"');
    expect(overview).not.toContain('<section id="backlog">');
    expect(overview).not.toContain('const REVISION');
  });

  test('the Overview shows its briefings, failing check, 10 newest items and the objective', async () => {
    const w = await world();
    for (const subject of ['crew:a', 'crew:b'])
      raiseBriefing(
        w.db,
        {
          zoneId: 'main',
          kind: 'crew',
          subject,
          decision: `Decide ${subject}`,
          why: 'w',
          options: [{ id: 'ok', label: 'OK', effect: 'none' }],
          source: 'crew',
        },
        t0,
      );
    w.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(
        JSON.stringify([
          { id: 'zone.ok', zoneId: 'main', status: 'pass', summary: 'fine' },
          { id: 'zone.labels', zoneId: 'main', status: 'fail', summary: 'labels missing' },
          { id: 'zone.other', zoneId: 'img', status: 'fail', summary: 'not this project' },
        ]),
      );
    // Item n was updated n minutes ago: 1 is the newest, 12 the oldest.
    for (let n = 1; n <= 12; n++) seedItem(w.db, n, n);
    const one = w.db
      .prepare("SELECT id FROM work_items WHERE drop_zone_id = 'main' AND issue_number = 1")
      .get() as { id: number };
    for (const [i, role] of (['implement', 'review'] as const).entries())
      insertDrop(w.db, {
        id: `d${i}`,
        dropZoneId: 'main',
        workItemId: one.id,
        role,
        state: 'succeeded',
        createdAt: new Date(t0.getTime() - (10 - i) * 1000).toISOString(),
      });
    seedGoals(w.db, [true, true, true, true, true, true, false]);

    const body = (await w.get('/projects/main')).body;
    const needs = block(body, 'needs-you') ?? '';
    expect(needs).toMatch(/<a href="\/briefings\/\d+">Decide crew:a<\/a>/);
    expect(needs).toMatch(/<a href="\/briefings\/\d+">Decide crew:b<\/a>/);
    expect(needs).toContain('<a href="/doctor">zone.labels</a>: labels missing');
    expect(needs).not.toContain('not this project');
    expect(needs).not.toContain('Nothing needs you');

    const recent = block(body, 'recent-work') ?? '';
    const numbers = [...recent.matchAll(/href="\/projects\/main\/work\/(\d+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(recent).toContain('implement → review');
    expect(recent).toContain('1 min ago');
    expect(recent).toContain('<span class="badge');

    const objective = block(body, 'objective') ?? '';
    expect(objective).toContain('<a href="/projects/main/goals">Objective 6</a>: 6 of 7 done');

    const health = block(body, 'health') ?? '';
    expect(health).toContain('Doctor: <a href="/doctor">fail</a>');
    expect(health).toContain('Egress: monitor');
    expect(health).toContain('Accounts: two-bot');

    // The State sentence is the floor card's: 2 briefings need this project.
    expect(block(body, 'state')).toContain('Needs you: ');
    expect(block(body, 'state')).toContain('2 briefings need you');
  });

  test('an empty project: no Objective block, "No work yet" and "Nothing needs you"', async () => {
    const w = await world();
    const body = (await w.get('/projects/main')).body;
    expect(block(body, 'objective')).toBeUndefined();
    expect(block(body, 'recent-work')).toContain('No work yet.');
    expect(block(body, 'needs-you')).toContain('Nothing needs you.');
    expect(block(body, 'state')).toContain('Idle: nothing queued or running.');
    expect(block(body, 'health')).toContain('Doctor: <a href="/doctor">not run yet</a>');
  });

  test('a work title is escaped on the Overview', async () => {
    const w = await world();
    seedItem(w.db, 7, 1, '<img src=x onerror=alert(1)>');
    const recent = block((await w.get('/projects/main')).body, 'recent-work') ?? '';
    expect(recent).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(recent).not.toContain('<img');
  });

  test('an unknown project has no setup page', async () => {
    const w = await world();
    expect((await w.get('/projects/nope/setup')).statusCode).toBe(404);
    expect((await w.get('/projects/nope')).statusCode).toBe(404);
  });
});

const unescape = (s: string) =>
  s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

type Listeners = Record<string, ((e: unknown) => void)[]>;
type FakeEl = {
  id?: string;
  tagName: string;
  name: string;
  type: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  listeners: Listeners;
  addEventListener(ev: string, fn: (e: unknown) => void): void;
  fire(ev: string, e?: unknown): unknown;
  closest(): null;
};

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1] ?? '') : undefined;
};

function fakeEl(o: Partial<FakeEl> & { tagName: string }): FakeEl {
  const el: FakeEl = {
    name: '',
    type: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    listeners: {},
    addEventListener(ev, fn) {
      (el.listeners[ev] ??= []).push(fn);
    },
    fire(ev, e = {}) {
      let last: unknown;
      for (const fn of el.listeners[ev] ?? []) last = fn(e);
      return last;
    },
    closest: () => null,
    ...o,
  };
  return el;
}

/** The form's controls, in document order, as the browser would hold them. */
function controlsOf(formHtml: string): FakeEl[] {
  const re =
    /<input\b[^>]*>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>|<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  return [...formHtml.matchAll(re)].map((m) => {
    const tag = m[0];
    if (tag.startsWith('<input'))
      return fakeEl({
        tagName: 'INPUT',
        name: attr(tag, 'name') ?? '',
        type: attr(tag, 'type') ?? 'text',
        value: attr(tag, 'value') ?? '',
        checked: /\schecked[\s>]/.test(tag),
      });
    if (tag.startsWith('<textarea'))
      return fakeEl({
        tagName: 'TEXTAREA',
        name: attr(m[1] ?? '', 'name') ?? '',
        type: 'textarea',
        value: unescape(m[2] ?? ''),
      });
    const options = [...(m[4] ?? '').matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    const chosen = options.find((o) => /selected/.test(o[2] ?? '')) ?? options[0];
    return fakeEl({
      tagName: 'SELECT',
      name: attr(m[3] ?? '', 'name') ?? '',
      type: 'select-one',
      value: unescape(chosen?.[1] ?? ''),
    });
  });
}

/**
 * Runs the Setup page's script (#617) against a fake DOM built from the page's own HTML. `jmFetch`
 * forwards to the real API with the operator's session, so every answer is the server's.
 */
async function setupPageRun(w: Awaited<ReturnType<typeof world>>, id = 'main') {
  const html = (await w.get(`/projects/${id}/setup`)).body;
  const at = html.indexOf('<form id="setup-form"');
  expect(at).toBeGreaterThanOrEqual(0);
  const formHtml = html.slice(at, html.indexOf('</form>', at));
  const elements = controlsOf(formHtml);
  const form = Object.assign(fakeEl({ tagName: 'FORM' }), {
    elements,
    querySelector: (sel: string) =>
      sel === 'select[name=identity]'
        ? elements.find((e) => e.tagName === 'SELECT' && e.name === 'identity')
        : null,
  });
  const byId = new Map<string, FakeEl>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    const key = m[1] ?? '';
    if (key === 'setup-form' || byId.has(key)) continue;
    const tag = html.slice(html.lastIndexOf('<', m.index), html.indexOf('>', m.index) + 1);
    byId.set(
      key,
      fakeEl({
        id: key,
        tagName: 'X',
        disabled: /\sdisabled[\s>]/.test(tag),
        hidden: /\shidden[\s>]/.test(tag),
      }),
    );
  }
  const issues = new Map(
    [...html.matchAll(/data-issues="([^"]+)"/g)].map((m) => [
      m[1] ?? '',
      fakeEl({ tagName: 'SPAN' }),
    ]),
  );
  const document = {
    getElementById: (key: string) => (key === 'setup-form' ? form : (byId.get(key) ?? null)),
    querySelector: (sel: string) => {
      const m = /^\[data-issues="(.+)"\]$/.exec(sel);
      return m ? (issues.get(m[1] ?? '') ?? null) : null;
    },
    querySelectorAll: (sel: string) => (sel === '.issue' ? [...issues.values()] : []),
  };
  const windowListeners: Listeners = {};
  const location = { href: `/projects/${id}/setup`, hash: '', reloads: 0, reload: () => {} };
  location.reload = () => {
    location.reloads++;
  };
  const calls: { url: string; body: Record<string, unknown>; method: string }[] = [];
  const pending: Promise<unknown>[] = [];
  const jmFetch = (url: string, body: Record<string, unknown>, method = 'POST') => {
    calls.push({ url, body, method });
    const p = w.api(method as 'POST' | 'PATCH' | 'DELETE', url, body).then((r) => ({
      ok: r.statusCode >= 200 && r.statusCode < 300,
      status: r.statusCode,
      json: async () => r.json(),
    }));
    pending.push(p);
    return p;
  };
  const script = html.slice(
    html.indexOf('<script id="setup-script">') + '<script id="setup-script">'.length,
    html.indexOf('</script>', html.indexOf('<script id="setup-script">')),
  );
  vm.runInContext(
    script,
    vm.createContext({
      document,
      location,
      jmFetch,
      window: {
        addEventListener: (ev: string, fn: (e: unknown) => void) => {
          (windowListeners[ev] ??= []).push(fn);
        },
      },
    }),
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.all(pending);
      await new Promise((r) => setImmediate(r));
    }
  };
  const control = (name: string) => {
    const el = elements.find((e) => e.name === name && e.type !== 'hidden');
    expect(el, name).toBeDefined();
    return el as FakeEl;
  };
  const el = (key: string) => {
    const e = byId.get(key);
    expect(e, key).toBeDefined();
    return e as FakeEl;
  };
  return {
    html,
    elements,
    calls,
    location,
    issues,
    control,
    el,
    /** Types into a field, as the browser's `input` event bubbles to the form. */
    set(name: string, value: string) {
      control(name).value = value;
      form.fire('input', {});
    },
    tick(name: string, on: boolean) {
      control(name).checked = on;
      form.fire('change', {});
    },
    async save() {
      form.fire('submit', { preventDefault: () => {} });
      await settle();
    },
    discard: () => el('discard').fire('click'),
    count: () => el('save-count').textContent,
    leaving() {
      let prevented = false;
      for (const fn of windowListeners.beforeunload ?? [])
        fn({
          preventDefault: () => {
            prevented = true;
          },
        });
      return prevented;
    },
    settle,
  };
}

describe('Setup is one form with one save bar (#617)', () => {
  test('the page has a section list for wide screens, a select for narrow ones, and the seven sections', async () => {
    const w = await world();
    const html = (await w.get('/projects/main/setup')).body;
    const labels = [
      ['project', 'Repository &amp; labels'],
      ['github', 'GitHub'],
      ['stack', 'Stack &amp; checks'],
      ['egress', 'Egress'],
      ['merging', 'Merging'],
      ['advanced', 'Advanced'],
      ['danger', 'Danger zone'],
    ];
    const nav = html.slice(
      html.indexOf('<nav class="setup-nav"'),
      html.indexOf('</nav>', html.indexOf('<nav class="setup-nav"')),
    );
    expect([...nav.matchAll(/<a href="#([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual(
      labels,
    );
    const jump = html.slice(
      html.indexOf('<select id="setup-jump"'),
      html.indexOf('</select>', html.indexOf('<select id="setup-jump"')),
    );
    expect(
      [...jump.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]),
    ).toEqual(labels);
    for (const [id] of labels) expect(html).toContain(`<section id="${id}" class="setup-section`);
    expect(html).toContain('.setup-nav{position:sticky');
    expect(html).toContain(
      '@media (max-width:899.98px){.setup-layout{display:block}.setup-nav{display:none}.setup-jump{display:block',
    );
    // One form, one Save.
    expect(html.match(/<form id="setup-form"/g)).toHaveLength(1);
    expect(html.match(/>Save<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain('data-section=');
  });

  test('one change in Egress and one in Merging send one request whose patch holds exactly those two', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    expect(p.count()).toBe('0 unsaved changes');
    expect(p.el('save').disabled).toBe(true);
    expect(p.control('egress.mode').value).toBe('monitor');
    expect(p.control('ciDeadlineMinutes').value).not.toBe('90');
    p.set('egress.mode', 'enforce');
    p.set('ciDeadlineMinutes', '90');
    expect(p.count()).toBe('2 unsaved changes');
    expect(p.el('save').disabled).toBe(false);
    await p.save();
    expect(p.calls).toHaveLength(1);
    const call = p.calls[0];
    expect(call?.method).toBe('PATCH');
    expect(call?.url).toBe('/api/control/config');
    expect(call?.body.patch).toEqual({
      dropZones: [{ id: 'main', egress: { mode: 'enforce' }, ciDeadlineMinutes: 90 }],
    });
    expect(call?.body.expectRevision).toBeTypeOf('number');
    // The server took both, and nothing else changed.
    const main = w.store.current().dropZones[0];
    expect(main?.egress).toEqual({ mode: 'enforce', allow: ['known.example.com'] });
    expect(main?.ciDeadlineMinutes).toBe(90);
    expect(main?.readyLabel).toBe('drop-ready');
  });

  test('the unsaved count is 0 after a successful save, and the page reloads without asking', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    p.set('readyLabel', 'go');
    expect(p.count()).toBe('1 unsaved change');
    expect(p.leaving()).toBe(true);
    await p.save();
    expect(w.store.current().dropZones[0]?.readyLabel).toBe('go');
    expect(p.count()).toBe('0 unsaved changes');
    expect(p.location.reloads).toBe(1);
    expect(p.leaving()).toBe(false);
  });

  test('a server reply with a field issue renders the message beside that field, and the bar counts it', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    p.set('ciDeadlineMinutes', 'soon');
    await p.save();
    expect(p.calls).toHaveLength(1);
    const message = p.issues.get('ciDeadlineMinutes')?.textContent ?? '';
    expect(message).not.toBe('');
    for (const [name, span] of p.issues)
      if (name !== 'ciDeadlineMinutes') expect(span.textContent, name).toBe('');
    expect(p.el('save-out').textContent).toBe('1 field error');
    // Still unsaved, still the typed value.
    expect(p.count()).toBe('1 unsaved change');
    expect(p.control('ciDeadlineMinutes').value).toBe('soon');
    expect(p.location.reloads).toBe(0);
  });

  test('Discard restores the original values', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    const before = p.elements.map((e) => [e.name, e.value, e.checked]);
    p.set('egress.allow', 'other.example.com');
    p.set('readyLabel', 'go');
    p.tick('ciRequired', false);
    p.set('identity', 'starter');
    expect(p.count()).toBe('4 unsaved changes');
    p.discard();
    expect(p.elements.map((e) => [e.name, e.value, e.checked])).toEqual(before);
    expect(p.count()).toBe('0 unsaved changes');
    expect(p.el('starter-warning').hidden).toBe(true);
    expect(p.leaving()).toBe(false);
    expect(p.calls).toHaveLength(0);
  });

  test('leaving the page with unsaved changes asks first', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    expect(p.leaving()).toBe(false);
    p.set('retryLabel', 'again');
    expect(p.leaving()).toBe(true);
  });

  test('a guarded change goes to the confirmation page and leaves the form as it was typed', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    p.tick('ciRequired', false);
    await p.save();
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]?.body).toMatchObject({
      patch: { dropZones: [{ id: 'main', ciRequired: false }] },
      returnTo: '/projects/main/setup',
      cancelTo: '/projects/main/setup',
    });
    expect(p.location.href).toMatch(/^\/config\/confirm\//);
    const confirm = await w.get(p.location.href);
    expect(confirm.body).toContain('Agent PRs in main will merge without CI');
    // Not applied, and the form still holds the change: unsaved until confirmed.
    expect(w.store.current().dropZones[0]?.ciRequired).toBe(true);
    expect(p.control('ciRequired').checked).toBe(false);
    expect(p.count()).toBe('1 unsaved change');
    expect(p.location.reloads).toBe(0);
  });

  test('Stop managing stays disabled until the exact repository name is typed, then removes the project', async () => {
    const w = await world();
    const p = await setupPageRun(w);
    const typed = p.el('stop-confirm');
    const stop = p.el('stop-managing');
    expect(stop.disabled).toBe(true);
    for (const v of ['', 'octo/mai', 'OCTO/MAIN', 'Octo/Main', 'octo/main ', 'main']) {
      typed.value = v;
      typed.fire('input');
      expect(stop.disabled, v).toBe(true);
      stop.fire('click');
    }
    await p.settle();
    expect(p.calls).toHaveLength(0);
    typed.value = 'octo/main';
    typed.fire('input');
    expect(stop.disabled).toBe(false);
    stop.fire('click');
    await p.settle();
    expect(p.calls).toEqual([{ url: '/api/control/zones/main', body: {}, method: 'DELETE' }]);
    expect(p.location.href).toBe('/projects');
    expect(w.store.current().dropZones.map((z) => z.id)).toEqual(['img']);
  });

  test('the Advanced JSON is a read-only view with a link to advanced settings, and is never sent', async () => {
    const w = await world();
    const adv = section((await w.get('/projects/main/setup')).body, 'advanced');
    expect(adv).toMatch(/<textarea id="zone-json" readonly[^>]*>/);
    expect(adv).not.toMatch(/<textarea[^>]*\sname=/);
    expect(adv).toContain('<a href="/projects/main/flags">advanced settings</a>');
    expect(adv).toContain('&quot;repo&quot;: &quot;octo/main&quot;');
  });

  test('with readOnly every field is disabled and there is no save bar or Stop managing', async () => {
    const w = await world({ file: true });
    const html = (await w.get('/projects/main/setup')).body;
    const at = html.indexOf('<form id="setup-form">');
    const form = html.slice(at, html.indexOf('</form>', at));
    expect(form.startsWith('<form id="setup-form"><fieldset disabled>')).toBe(true);
    // Every settings control is in a disabled fieldset; the GitHub section between them is the
    // guide (copy buttons, the code owners login), which is not a setting.
    const fieldsets = [...form.matchAll(/<fieldset( disabled)?>([\s\S]*?)<\/fieldset>/g)];
    expect(fieldsets.length).toBe(2);
    for (const f of fieldsets) expect(f[1]).toBe(' disabled');
    const controls = (s: string) => s.match(/<(input|textarea|select|button)\b/g)?.length ?? 0;
    const inFieldsets = fieldsets.reduce((n, f) => n + controls(f[2] ?? ''), 0);
    expect(inFieldsets).toBeGreaterThan(10);
    // Between the fieldsets: the GitHub section, whose only named control is the code owners login.
    const between = form.slice(form.indexOf('</fieldset>'), form.lastIndexOf('<fieldset'));
    expect(between).toContain('<section id="github" class="setup-section"><h3>GitHub</h3>');
    expect(controls(form)).toBe(inFieldsets + controls(between));
    expect([...between.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1])).toEqual(['reviewer']);
    expect(html).not.toContain('id="save-bar"');
    expect(html).not.toContain('unsaved change');
    expect(html).not.toContain('id="setup-script"');
    expect(html).not.toContain('id="stop-confirm"');
    expect(section(html, 'danger')).toContain('removing it from the config file');
  });
});

describe('Setup has a GitHub section with each step’s doctor status (#618)', () => {
  const doctorRun = (w: Awaited<ReturnType<typeof world>>, checks: Partial<DoctorCheck>[]) =>
    w.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(JSON.stringify(checks.map((c) => ({ zoneId: 'main', summary: '', ...c }))));
  const chip = (html: string, step: string): string => {
    const at = html.indexOf(`<p class="step-status" data-step="${step}">`);
    expect(at, step).toBeGreaterThan(-1);
    return html.slice(at, html.indexOf('</p>', at));
  };

  test('a failing branch-rules check shows the ruleset step missing, with the finding; a passing private-clone shows access done', async () => {
    const w = await world();
    doctorRun(w, [
      { id: 'forge.branch-rules', status: 'fail', summary: 'no ruleset requires a pull request' },
      { id: 'forge.private-clone', status: 'pass', summary: 'octo/main is public' },
    ]);
    const github = (await w.get('/projects/main/setup')).body;
    expect(chip(github, 'ruleset')).toContain('data-status="missing">missing</span>');
    expect(chip(github, 'ruleset')).toContain('no ruleset requires a pull request');
    expect(chip(github, 'access')).toContain('data-status="done">done</span>');
    expect(chip(github, 'codeowners')).toContain('data-status="not-checked">not checked</span>');
  });

  test('with no doctor run every step shows not checked, and none shows done', async () => {
    const w = await world();
    const html = (await w.get('/projects/main/setup')).body;
    for (const step of ['access', 'ruleset', 'codeowners', 'labels'])
      expect(chip(html, step)).toContain('data-status="not-checked">not checked</span>');
    expect(html).not.toContain('data-status="done"');
    expect(html).not.toContain('>done</span>');
  });

  test('the downloads and their file names are unchanged', async () => {
    const w = await world();
    const html = (await w.get('/projects/main/setup')).body;
    expect(html).toMatch(
      /<a href="data:application\/json;charset=utf-8,[^"]+" download="jumpmaster-main-ruleset\.json">Download jumpmaster-main-ruleset\.json<\/a> <button type="button" data-copy="ruleset-text">Copy<\/button>/,
    );
    expect(html).toContain('<pre id="ruleset-text">');
    expect(html).toContain('<button type="button" data-copy="codeowners-text">Copy</button>');
    expect(html).toContain('Create <code>.github/CODEOWNERS</code> on GitHub</a>');
    expect(html).toContain('navigator.clipboard.writeText');
  });
});
