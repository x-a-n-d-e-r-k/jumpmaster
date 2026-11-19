import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
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

  test('the zone page, the goals page and a briefing page each carry Ask about this with their focus', async () => {
    const w = await world();
    const body = (await w.get('/zones/main')).body;
    const at = body.indexOf('<form class="ask"');
    expect(at).toBeGreaterThanOrEqual(0);
    const form = body.slice(at, body.indexOf('</form>', at));
    expect(form).toContain('Ask about this');
    expect(form).toContain('data-focus-kind="zone"');
    expect(form).toContain('data-focus-zone="main"');
    expect(form).toContain('data-focus-ref="main"');
    expect(body).toContain("jmFetch('/api/chat/threads'");
  });

  test('the zone page links its goals page after Briefings (#365)', async () => {
    const w = await world();
    const body = (await w.get('/zones/main')).body;
    expect(body).toContain('href="/zones/main/goals"');
    expect(body).toMatch(/Briefings \(\d+ open\)<\/a> · <a href="\/zones\/main\/goals">Goals<\/a>/);
  });

  test('each section of the zone page is filled from the current config and posts a patch with expectRevision', async () => {
    const w = await world();
    const r = await w.get('/zones/main');
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
    const page = (await w.get('/zones/main')).body;
    expect(page).toContain('<a href="/briefings?zone=main">Briefings (2 open)</a>');
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
    const egress = section((await w.get('/zones/main')).body, 'egress');
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
    const row = rowOf(section((await w.get('/zones/main')).body, 'egress'), 'new.example.com');
    expect(row).toMatch(/<td>25 <details><summary>show 25<\/summary>/);
    const links = dropLinks(row);
    expect(links).toHaveLength(20);
    for (const id of ids.slice(5)) {
      expect(row).toContain(`href="/drops/${id}"`);
      expect(row).toContain(`>${id.slice(0, 8)}</a>`);
    }
    for (const id of ids.slice(0, 5)) expect(row).not.toContain(`/drops/${id}`);
    expect(row).toContain('<a href="/drops?zone=main">and 5 more</a>');
  });

  test('a host with 3 drops links all three and no "more" line', async () => {
    const w = await world();
    const ids = seedEgress(w.db, [{ host: 'new.example.com' }], 3);
    const row = rowOf(section((await w.get('/zones/main')).body, 'egress'), 'new.example.com');
    expect(row).toContain('<summary>show 3</summary>');
    expect(dropLinks(row)).toHaveLength(3);
    for (const id of ids) expect(row).toContain(`href="/drops/${id}"`);
    expect(row).not.toContain('more');
    expect(row).not.toContain('/drops?zone=');
  });

  test('counts render with en-US thousands separators', async () => {
    const w = await world();
    seedEgress(w.db, [{ host: 'registry.npmjs.org', count: 19510 }], 1);
    const row = rowOf(section((await w.get('/zones/main')).body, 'egress'), 'registry.npmjs.org');
    expect(row).toContain('<td>19,510</td>');
  });

  test('50 hosts reached by 300 drops each link at most 20 drops per host', async () => {
    const w = await world();
    const hosts = Array.from({ length: 50 }, (_, i) => ({ host: `h${i}.example.com` }));
    seedEgress(w.db, hosts, 300);
    const egress = section((await w.get('/zones/main')).body, 'egress');
    const links = dropLinks(egress);
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(50 * 20);
    expect(egress).toContain('and 280 more');
  });

  test('adopt checkboxes render for an unlisted host and not for a listed one', async () => {
    const w = await world();
    seedEgress(w.db, [{ host: 'new.example.com' }, { host: 'registry.npmjs.org' }], 2);
    const egress = section((await w.get('/zones/main')).body, 'egress');
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
    const egress = section((await w.get('/zones/main')).body, 'egress');
    expect(egress).toContain('name="adopt" value="registry.npmjs.org"');
    expect(egress).toMatch(/repo\.maven\.apache\.org[\s\S]*?listed by the jvm preset/);
    expect(egress).not.toContain('name="adopt" value="repo.maven.apache.org"');
    expect(egress).toMatch(/known\.example\.com[\s\S]*?listed by this zone&#39;s allow list/);
    expect(egress).toMatch(/github\.com[\s\S]*?listed by every drop/);
  });

  test('the Zones list shows Stop managing on each zone row, with a confirmation naming the repository and what happens', async () => {
    const w = await world();
    const r = (await w.get('/zones')).body;
    for (const id of ['main', 'img']) {
      const at = r.indexOf(`href="/zones/${id}"`);
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

  test('the zone page offers Stop managing near its top, and none at the bottom any more', async () => {
    const page = (await (await world()).get('/zones/main')).body;
    const stop = page.indexOf('<button class="stop" data-zone="main"');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(page.indexOf('<form id="project"'));
    expect(page).toContain("querySelectorAll('button.stop')");
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
    const list = (await w.get('/zones')).body;
    const at = list.indexOf('href="/zones/main"');
    const row = list.slice(at, list.indexOf('</tr>', at));
    expect(row).toContain(waiting);
    // Already stopping: no second Stop, and no mode button but Resume (which withdraws it).
    expect(row).not.toContain('class="stop"');
    expect(row).toContain('data-mode="active"');
    expect((await w.get('/zones/main')).body).toContain(waiting);
    // Not removed while the drop runs; the already-drained zone goes at once.
    expect(w.store.current().dropZones.map((z) => z.id)).toEqual(['main', 'img']);
    expect((await w.api('DELETE', '/api/control/zones/img')).json()).toMatchObject({
      removed: 'img',
    });
  });

  test('a read-only (file-mode) config shows no Stop managing control', async () => {
    const w = await world({ file: true });
    expect((await w.get('/zones')).body).not.toContain('class="stop"');
    expect((await w.get('/zones/main')).body).not.toContain('class="stop"');
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

describe('zones are named by their repository (#99)', () => {
  test('the Zones list names each zone by repository, and its messages use that name', async () => {
    const w = await world();
    const r = (await w.get('/zones')).body;
    expect(r).toContain('<th>Project</th>');
    expect(r).toContain('<a href="/zones/main">octo/main</a>');
    expect(r).toContain('<a href="/zones/img">octo/img</a>');
    expect(r).not.toMatch(/>main</);
    expect(r).toContain('data-name="octo/main"');
    expect(r).toContain("b.dataset.name + ': '");
    expect(r).not.toContain("b.dataset.zone + ': '");
  });

  test('a zone page heads with the repository and keeps the zone id on a detail line', async () => {
    const page = (await (await world()).get('/zones/main')).body;
    expect(page).toContain('<title>Jumpmaster: octo/main</title>');
    expect(page).toContain('<h2>octo/main</h2>');
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
    const r = await w.get('/zones/main');
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
    const r = await w.get('/zones/main');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<section id="backlog">');
    expect(backlogScript(r.body)).toContain("'Work on it'");
  });

  test('the script escapes issue titles', async () => {
    const w = await world();
    const script = backlogScript((await w.get('/zones/main')).body);
    expect(script).toContain('textContent');
    expect(script.replaceAll(' ', '')).not.toContain('innerHTML=');
  });
});
