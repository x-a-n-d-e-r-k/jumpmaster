import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { raiseBriefing, ruleBriefing } from '../briefings.js';
import { DEFAULT_PROTECTED_PATHS } from '../config.js';
import { insertCrewIssue } from '../crew/store.js';
import {
  type DropState,
  insertDrop,
  insertOutbox,
  insertStick,
  setWorkItemState,
  stampStick,
  updateDrop,
  updateOutbox,
  upsertDropZone,
  upsertWorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { actionFor, PAGES_M45A, pagesOf } from '../doctor/actions.js';
import { CHECK_IDS, DOC } from '../doctor/checks.js';
import { zoneGuidance } from '../github/guidance.js';
import { opMarker } from '../outbox.js';
import { crewOn, GOAL } from '../test/crew.js';
import { harness } from '../test/flowHarness.js';

const get = async (h: Awaited<ReturnType<typeof harness>>, url: string) => h.view(url);

async function crewHarness() {
  const h = await harness({
    zone: { crew: crewOn },
    issues: [
      {
        number: 1,
        title: 'Issue 1',
        body: 'b',
        author: 'human',
        labels: ['agent-ready'],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        number: 12,
        title: 'Crew issue nobody promoted',
        body: `x\n\n${opMarker('issue:main:o:k')}`,
        author: 'human',
        labels: ['agent-ready'],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  h.forge.state.files.set('main:GOAL.md', GOAL);
  return h;
}

describe('UI routes', () => {
  test('/doctor shows the latest run, escaped, and refuses a foreign Host', async () => {
    const h = await harness();
    const foreign = await h.view('/doctor', { host: 'evil.test' });
    expect(foreign.statusCode).toBe(403);
    expect((await get(h, '/doctor')).body).toContain('No doctor run has finished yet');
    const checks = [
      { id: 'config.listen', zoneId: null, status: 'pass', summary: 'loopback only' },
      {
        id: 'forge.labels',
        zoneId: 'main',
        status: 'fail',
        summary: 'missing <script>',
        fix: 'gh label create agent-ready',
        doc: 'docs/runbooks/install.md#labels',
      },
    ];
    h.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(JSON.stringify(checks));
    const html = (await get(h, '/doctor')).body;
    expect(html).toContain('missing &lt;script&gt;');
    expect(html).toMatch(/<tr class="fail">.*forge\.labels/);
    expect(html).toContain('gh label create agent-ready');
    expect(html).toContain('1 pass, 0 warn, 1 fail, 0 skip');
    expect(html).toContain(
      'data-doctor="/api/control/doctor/drop" data-body="{&quot;zone&quot;:&quot;main&quot;}"',
    );
  });

  test('the home page names an enrolled stick that cannot run an enforce zone', async () => {
    const h = await harness({ zone: { egress: { mode: 'enforce' } } });
    insertStick(h.db, { id: 's1', name: 'm3-stick', tokenHash: 'h1', slots: 1 });
    insertStick(h.db, {
      id: 's2',
      name: 'new-stick',
      tokenHash: 'h2',
      slots: 1,
      capabilities: ['egress-v1'],
    });
    const html = (await get(h, '/')).body;
    expect(html).toMatch(/m3-stick<\/td>.*cannot run octo\/demo: lacks egress-v1/);
    expect(html).toMatch(/new-stick<\/td>.*all zones/);
  });

  test('/briefings lists open briefings and recorded rulings', async () => {
    const h = await crewHarness();
    const at = h.now();
    const open = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:a',
        decision: 'Open <b>question</b>',
        why: 'w',
        options: [
          { id: 'o1', label: 'Yes', effect: 'none' },
          { id: 'o2', label: 'No', effect: 'none' },
        ],
        source: 'crew',
      },
      at,
    );
    const ruled = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:b',
        decision: 'Answered',
        why: 'w',
        options: [
          { id: 'o1', label: 'Yes', effect: 'none' },
          { id: 'o2', label: 'No', effect: 'none' },
        ],
        source: 'crew',
      },
      at,
    );
    ruleBriefing(h.db, ruled, 'o2', 'not now', at);
    const res = await get(h, '/briefings');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Open &lt;b&gt;question&lt;/b&gt;');
    expect(res.body).toContain(`data-briefing="${open}"`);
    expect(res.body).not.toContain(`data-briefing="${ruled}"`);
    expect(res.body).toContain('not now');
    const home = await get(h, '/');
    expect(home.body).toContain('Waiting on you');
    expect(home.body).toContain('Open &lt;b&gt;question&lt;/b&gt;');
    expect(home.body).toContain('<h2>Crew</h2>');
  });

  test('/zones/:id/goals shows the ladder, crew issues and the skipped list from the last sync', async () => {
    const h = await crewHarness();
    await h.sync();
    insertCrewIssue(h.db, {
      zoneId: 'main',
      key: 'add-docs',
      source: 'drop',
      objective: 'document-every-endpoint',
      title: 'Add docs',
      body: 'b',
      priority: null,
      state: 'staged',
      number: 30,
      createdAt: h.now().toISOString(),
    });
    const res = await get(h, '/zones/main/goals');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Objectives (goal ladder)');
    expect(res.body).toContain('Document every endpoint');
    expect(res.body).toContain('Add docs');
    expect(res.body).toContain('Crew issues not started (no recorded promotion)');
    expect(res.body).toContain('#12');
  });

  test('an unknown zone on /zones/:id/goals is 404', async () => {
    const h = await crewHarness();
    expect((await get(h, '/zones/nope/goals')).statusCode).toBe(404);
  });

  test('the drop page shows the models', async () => {
    const h = await crewHarness();
    await h.sync();
    insertDrop(h.db, {
      id: 'cd',
      dropZoneId: 'main',
      workItemId: null,
      role: 'diagnose',
      state: 'succeeded',
      createdAt: h.now().toISOString(),
    });
    updateDrop(h.db, 'cd', { requestedModel: 'claude-fable-1', servedModel: 'claude-opus-5-5' });
    const res = await get(h, '/drops/cd');
    expect(res.body).toContain(
      'Served model: claude-opus-5-5 (mismatch: requested claude-fable-1)',
    );
  });

  test('the intake page renders for a known zone and is 404 for an unknown one', async () => {
    const h = await crewHarness();
    const res = await get(h, '/zones/main/intake');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("the first issue doesn't need GOAL.md merged first");
    expect((await get(h, '/zones/nope/intake')).statusCode).toBe(404);
  });

  test.each(['/briefings', '/zones/main/goals', '/zones/main/intake'])(
    'a foreign Host cannot read %s',
    async (url) => {
      const h = await crewHarness();
      const res = await h.view(url, { host: 'evil.test' });
      expect(res.statusCode).toBe(403);
    },
  );
});

describe('doctor fix links (Task 8)', () => {
  test('in the M4.5a configuration every action href is a registered page, a github.com page or a runbook anchor', async () => {
    const h = await harness({ live: true, zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS] } });
    const runbook = readFileSync(
      join(import.meta.dirname, '../../../../docs/runbooks/install.md'),
      'utf8',
    );
    // GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes.
    const anchors = new Set(
      [...runbook.matchAll(/^#+ (.+)$/gm)].map((m) =>
        (m[1] as string)
          .toLowerCase()
          .replace(/[^\w\- ]/g, '')
          .replace(/ /g, '-'),
      ),
    );
    const guidance = zoneGuidance(
      h.zone,
      { defaultBranch: 'main', ciJobs: [], ownerType: 'User', visibility: 'public' },
      {},
    );
    // This build's pages, as the doctor route derives them: Task 9 adds the Credentials tab,
    // Task 11 the zones page and Task 13 the Install and History tabs.
    const pages = pagesOf(h.app);
    expect(pages).toEqual({ ...PAGES_M45A, credentials: true, zones: true, settings: true });
    const seen = new Set<string>();
    for (const id of CHECK_IDS)
      for (const g of [undefined, guidance])
        for (const summary of ['claudeToken: no Claude token', 'githubAuthorToken: none']) {
          const a = actionFor(
            {
              id,
              zoneId: h.zone.id,
              status: 'fail',
              summary,
              credentials: [summary.split(':')[0] as string],
            },
            { zone: h.zone, pages, ...(g ? { guidance: g } : {}) },
          );
          if (!a) continue;
          const key = `${a.method ?? 'GET'} ${a.href}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (a.kind === 'forge') expect(a.href, id).toMatch(/^https:\/\/github\.com\//);
          else if (a.kind === 'docs') {
            const [base, anchor] = a.href.split('#');
            expect(base, id).toBe(DOC);
            expect(anchors.has(anchor as string), `${id} #${anchor}`).toBe(true);
          } else if (a.method === 'POST') {
            const pattern = a.href.replace(`/${h.zone.id}/`, '/:id/');
            expect(h.app.hasRoute({ method: 'POST', url: pattern }), `${id} ${pattern}`).toBe(true);
          } else {
            // Registered: the page answers (a GitHub page may say GitHub is unreadable here).
            const r = await h.view(a.href.split('#')[0] as string);
            expect([id, a.href, r.statusCode]).not.toEqual([id, a.href, 404]);
          }
        }
    expect(seen.size).toBeGreaterThan(10);
    // Every credential check now links to the tab, and the tab answers.
    for (const id of ['credential.missing', 'forge.author', 'claude.token-age', 'vault.key'])
      expect(
        actionFor({ id, zoneId: null, status: 'fail', summary: 'x' }, { pages })?.href,
        id,
      ).toBe('/settings/credentials');
    expect(seen.has('GET /settings/credentials')).toBe(true);
    expect((await h.view('/settings/credentials')).statusCode).toBe(200);
  });

  test('the doctor page renders fails first with their action links escaped and artifact downloads', async () => {
    const h = await harness();
    const checks = [
      { id: 'config.listen', zoneId: null, status: 'pass', summary: 'loopback only' },
      { id: 'zone.egress', zoneId: 'main', status: 'warn', summary: 'monitor' },
      {
        id: 'forge.branch-rules',
        zoneId: 'main',
        status: 'fail',
        summary: 'no rules',
        action: {
          kind: 'forge',
          label: 'Import <the> ruleset',
          href: 'https://github.com/octo/demo/settings/rules?a=1&b=2',
          artifact: { filename: 'rules "x".json', text: '{"rules": ["<x>"]}' },
        },
      },
      {
        id: 'forge.labels',
        zoneId: 'main',
        status: 'fail',
        summary: 'missing',
        action: {
          kind: 'app',
          label: 'Create the missing labels',
          href: '/api/control/zones/main/labels',
          method: 'POST',
        },
      },
      {
        id: 'config.uid',
        zoneId: null,
        status: 'fail',
        summary: 'bad',
        action: { kind: 'docs', label: 'Read', href: 'javascript:alert(1)' },
      },
    ];
    h.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(JSON.stringify(checks));
    const html = (await get(h, '/doctor')).body;
    const order = [...html.matchAll(/<tr class="(\w+)">/g)].map((m) => m[1]);
    expect(order).toEqual(['fail', 'fail', 'fail', 'warn', 'pass']);
    expect(html).toContain(
      '<a href="https://github.com/octo/demo/settings/rules?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">Import &lt;the&gt; ruleset</a>',
    );
    // The artifact as a download, its name and text escaped and encoded.
    expect(html).toContain(
      `<a download="rules &quot;x&quot;.json" href="data:text/plain;charset=utf-8,${encodeURIComponent('{"rules": ["<x>"]}')}">Download rules &quot;x&quot;.json</a>`,
    );
    // A write is a button behind the CSRF header, never a link.
    expect(html).toContain(
      '<button data-doctor="/api/control/zones/main/labels" data-body="{}">Create the missing labels</button>',
    );
    expect(html).not.toContain('href="/api/control/zones/main/labels"');
    // An href that is neither a path here nor https is not rendered as a link.
    expect(html).not.toContain('javascript:alert');
  });
});

describe('the status line (Task 12)', () => {
  test('the home page opens with the status banner and its action link, and titles the page with the headline', async () => {
    const h = await harness({ live: true, zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS] } });
    // A live stick and a parked item whose reason carries markup.
    insertStick(h.db, { id: 'live', name: 'stick-live', tokenHash: 'hl', slots: 1 });
    stampStick(
      h.db,
      'live',
      { capabilities: ['egress-v1'], imagePolicy: 'allowlist', version: '1', pinnedImages: [] },
      h.now(),
    );
    await h.sync();
    const [first] = h.db.prepare('SELECT id FROM work_items').all() as { id: number }[];
    setWorkItemState(h.db, first?.id as number, 'parked', 'no CI result: <ci> & friends');
    const api = await h.view('/api/control/status');
    expect(api.statusCode).toBe(200);
    const status = api.json() as { headline: string; action?: { href: string } };
    expect(status.headline).toBe('1 parked: no CI result: <ci> & friends');
    const home = (await h.view('/')).body;
    // The status line is the first thing in the page's content, beside the kill switch.
    const body = home.slice(home.indexOf('<main id="main">') + '<main id="main">'.length);
    expect(
      body.startsWith('<div class="floor-head"><div class="status" data-waiting-on="you">'),
    ).toBe(true);
    expect(body).toContain('<strong>1 parked: no CI result: &lt;ci&gt; &amp; friends</strong>');
    expect(body).toContain(`<a href="${status.action?.href}">`);
    expect(home).toContain(
      '<title>Jumpmaster: 1 parked: no CI result: &lt;ci&gt; &amp; friends</title>',
    );
    expect(home).not.toContain('<ci>');
    // Redacted where it is built (M5): a reason that quotes a secret value never shows it.
    setWorkItemState(h.db, first?.id as number, 'parked', 'merge refused for author-token');
    const redacted = (await h.view('/api/control/status')).json() as { headline: string };
    expect(redacted.headline).toBe('1 parked: merge refused for [REDACTED]');
    // No secret of the install reaches the line, the page or the route.
    for (const secret of ['claude-token', 'author-token', 'reviewer-token', 'o'.repeat(32), 'join'])
      for (const text of [
        api.body,
        home.slice(
          home.indexOf('<div class="status"'),
          home.indexOf('</div>', home.indexOf('<div class="status"')),
        ),
      ])
        expect(text).not.toContain(secret);
  });

  test('queued work no live stick can run names the missing capability, read the way the lease route reads it', async () => {
    const h = await harness({
      live: true,
      zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS], egress: { mode: 'enforce' } },
    });
    // The harness stick enrolled without capabilities; keep it live.
    for (const { id } of h.db.prepare('SELECT id FROM sticks').all() as { id: string }[])
      stampStick(
        h.db,
        id,
        { capabilities: [], imagePolicy: 'allowlist', version: '1', pinnedImages: [] },
        h.now(),
      );
    await h.sync();
    const [first] = h.db.prepare('SELECT id FROM work_items').all() as { id: number }[];
    setWorkItemState(h.db, first?.id as number, 'in_flight');
    insertDrop(h.db, {
      id: 'q1',
      dropZoneId: 'main',
      workItemId: first?.id as number,
      role: 'implement',
      state: 'queued',
    });
    const status = (await h.view('/api/control/status')).json() as { headline: string };
    expect(status.headline).toBe(
      'Queued: 1 issue; no stick can run zone main: no live stick has egress-v1',
    );
    // The floor names the zone by its repository (#99); the API, read by `ctl status`, keeps the id.
    const home = (await h.view('/')).body;
    expect(home).toContain(
      '<strong>Queued: 1 issue; no stick can run zone octo/demo: no live stick has egress-v1</strong>',
    );
    expect(home).toContain(
      '<title>Jumpmaster: Queued: 1 issue; no stick can run zone octo/demo: no live stick has egress-v1</title>',
    );
    expect(home).not.toContain('zone main');
  });

  test('the status route needs the operator, as every control route does', async () => {
    const h = await harness({ live: true, zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS] } });
    const anon = await h.app.inject({
      method: 'GET',
      url: '/api/control/status',
      headers: { host: 'localhost:80' },
    });
    expect(anon.statusCode).toBe(401);
  });
});

describe('/work and /drops list pages (#119)', () => {
  async function lists() {
    const h = await harness({ extraZones: [{ id: 'ref', repo: 'octo/ref' }] });
    for (const z of [h.zone, { id: 'ref', repo: 'octo/ref' }])
      upsertDropZone(h.db, { id: z.id, repo: z.repo, defaultBranch: 'main', configJson: '{}' });
    let n = 100;
    const item = (zoneId: string, state: WorkItemState, title = `${zoneId}-${state}-${n}`) => {
      const w = upsertWorkItem(
        h.db,
        {
          dropZoneId: zoneId,
          issueNumber: n++,
          title,
          body: 'b',
          author: 'human',
          priority: 2,
          isFix: false,
          issueCreatedAt: '2026-01-01T00:00:00.000Z',
        },
        h.now(),
      );
      if (state !== 'ready') setWorkItemState(h.db, w.id, state, undefined, h.now());
      return w;
    };
    return { h, item };
  }
  const drop = (
    h: Awaited<ReturnType<typeof harness>>,
    id: string,
    state: DropState,
    zoneId = 'main',
    createdAt = '2026-01-01T00:00:00.000Z',
    workItemId: number | null = null,
  ) =>
    insertDrop(h.db, {
      id,
      dropZoneId: zoneId,
      workItemId,
      role: workItemId === null ? 'crew-lead' : 'implement',
      state,
      createdAt,
    });

  test('?zone= keeps that zone’s rows only, and names the zone by repository', async () => {
    const { h, item } = await lists();
    item('main', 'parked', 'main parked one');
    item('main', 'parked', 'main parked two');
    item('ref', 'parked', 'ref parked');
    const res = await h.view('/work?zone=main&state=parked');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('main parked one');
    expect(res.body).toContain('main parked two');
    expect(res.body).not.toContain('ref parked');
    expect(res.body).toContain('Parked work in octo/demo');
    expect(res.body).not.toContain('zone main');
    // Filter links name each zone by its repository and keep the state.
    expect(res.body).toContain('href="/work?zone=ref&amp;state=parked">octo/ref</a>');
    expect(res.body).toMatch(/href="\/work\?state=parked"[^>]*>All projects<\/a>/);
    expect(res.body).toMatch(
      /<a href="\/work\?zone=main&amp;state=parked" aria-current="page">octo\/demo<\/a>/,
    );
    expect(res.body).toMatch(
      /<a href="\/work\?zone=main&amp;state=parked" aria-current="page">Parked<\/a>/,
    );
  });

  test('?state=parked drops a ready row; the default shows everything but done', async () => {
    const { h, item } = await lists();
    item('main', 'ready', 'is ready');
    item('main', 'in_flight', 'is in flight');
    item('main', 'pr_open', 'is pr open');
    item('ref', 'parked', 'is parked');
    item('main', 'done', 'is done');
    const parked = (await h.view('/work?state=parked')).body;
    expect(parked).toContain('is parked');
    expect(parked).not.toContain('is ready');
    const all = await h.view('/work');
    expect(all.statusCode).toBe(200);
    for (const t of ['is ready', 'is in flight', 'is pr open', 'is parked'])
      expect(all.body).toContain(t);
    expect(all.body).not.toContain('is done');
    expect(all.body).toContain('All active work');
  });

  test('an issue title is escaped on /work', async () => {
    const { h, item } = await lists();
    item('main', 'ready', '<script>x</script>');
    const body = (await h.view('/work')).body;
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).not.toContain('<script>x</script>');
  });

  test('no matching rows: the empty line, and no table', async () => {
    const { h, item } = await lists();
    item('ref', 'parked');
    const work = (await h.view('/work?zone=main&state=parked')).body;
    expect(work).toContain('No parked work in octo/demo.');
    expect(work).not.toContain('<table');
    const drops = (await h.view('/drops?zone=ref')).body;
    expect(drops).toContain('No drops in octo/ref.');
    expect(drops).not.toContain('<table');
  });

  test('/drops?state=active keeps queued, leased, running and push_pending', async () => {
    const { h, item } = await lists();
    for (const s of ['queued', 'leased', 'running', 'push_pending', 'succeeded'] as const)
      drop(h, `drop-${s}`, s, 'main', '2026-01-01T00:00:00.000Z', item('main', 'in_flight').id);
    const body = (await h.view('/drops?state=active')).body;
    for (const s of ['queued', 'leased', 'running', 'push_pending'])
      expect(body).toContain(`>drop-${s}</a>`);
    expect(body).not.toContain('drop-succeeded');
    expect(body).toContain('All active drops');
  });

  test('/drops?zone= keeps that zone’s drops, newest first', async () => {
    const { h } = await lists();
    drop(h, 'old-main', 'succeeded', 'main', '2026-01-01T00:00:00.000Z');
    drop(h, 'new-main', 'failed', 'main', '2026-01-02T00:00:00.000Z');
    drop(h, 'ref-drop', 'succeeded', 'ref');
    const body = (await h.view('/drops?zone=main')).body;
    expect(body).not.toContain('ref-drop');
    expect(body.indexOf('>new-main<')).toBeGreaterThan(-1);
    expect(body.indexOf('>new-main<')).toBeLessThan(body.indexOf('>old-main<'));
    expect(body).toContain('Drops in octo/demo');
  });

  test('/drops shows the newest 200, and says so only when more exist', async () => {
    const { h } = await lists();
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    for (let i = 0; i < 200; i++)
      drop(h, `d${String(i).padStart(3, '0')}`, 'succeeded', 'main', at(i));
    const two = (await h.view('/drops')).body;
    expect(two.match(/<a href="\/drops\/d\d+">/g)).toHaveLength(200);
    expect(two).not.toContain('Showing the newest 200');
    drop(h, 'd200', 'succeeded', 'main', at(200));
    const more = (await h.view('/drops')).body;
    expect(more.match(/<a href="\/drops\/d\d+">/g)).toHaveLength(200);
    expect(more).toContain('Showing the newest 200');
    expect(more).toContain('>d200<');
    expect(more).not.toContain('>d000<');
  });

  test.each([
    ['/work?zone=nope', 'no such zone'],
    ['/drops?zone=nope', 'no such zone'],
    ['/work?state=bogus', 'no such state'],
    ['/drops?state=bogus', 'no such state'],
    ['/work?state=cancelled', 'no such state'],
  ])('%s is 404 %s', async (url, text) => {
    const { h } = await lists();
    const res = await h.view(url);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe(text);
  });

  test('the floor (#120): totals and a card per zone, every count linked, no ledgers', async () => {
    const { h, item } = await lists();
    item('main', 'parked');
    item('main', 'parked');
    item('ref', 'ready');
    const merged = item('main', 'pr_open');
    drop(h, 'live-ref', 'running', 'ref');
    const at = (hours: number) => new Date(h.now().getTime() - hours * 3_600_000);
    const merge = (key: string, state: 'done' | 'failed', hoursAgo: number) => {
      insertOutbox(h.db, {
        id: key,
        opKey: key,
        kind: 'merge',
        workItemId: merged.id,
        zoneId: 'main',
        payloadJson: '{}',
        state: 'pending',
        createdAt: at(hoursAgo).toISOString(),
      });
      updateOutbox(h.db, key, { state }, at(hoursAgo));
    };
    merge('m-23h', 'done', 23);
    merge('m-25h', 'done', 25);
    merge('m-failed', 'failed', 1);
    const home = (await h.view('/')).body;
    const tile = (key: string, scope: string) => {
      const from = home.indexOf(scope);
      const m = home
        .slice(from)
        .match(new RegExp(`<a class="tile" data-tile="${key}" href="([^"]*)"><b[^>]*>([^<]*)</b>`));
      return m ? { href: m[1], n: m[2] } : undefined;
    };
    expect(tile('running', 'class="totals"')).toEqual({ href: '/drops?state=active', n: '1' });
    expect(tile('queued', 'class="totals"')).toEqual({ href: '/work?state=ready', n: '1' });
    expect(tile('parked', 'class="totals"')).toEqual({ href: '/work?state=parked', n: '2' });
    expect(tile('merged', 'class="totals"')).toEqual({ href: '/work?state=done', n: '1' });
    expect(tile('merged', 'data-zone="main"')).toEqual({
      href: '/work?zone=main&amp;state=done',
      n: '1',
    });
    expect(tile('running', 'data-zone="ref"')).toEqual({
      href: '/drops?zone=ref&amp;state=active',
      n: '1',
    });
    // The failed merge counts as blocked on main's card; main comes first, then ref.
    expect(home).toContain('<a href="/work?zone=main&amp;state=parked">2 parked</a>');
    expect(home).toContain('1 forge write unknown or failed');
    expect(home.indexOf('data-zone="main"')).toBeLessThan(home.indexOf('data-zone="ref"'));
    expect(home).toContain('data-state="blocked" data-zone="main"');
    expect(home).toContain('data-state="working" data-zone="ref"');
    expect(home).toContain('<a href="/zones/ref">octo/ref</a>');
    for (const gone of ['<h2>Work items</h2>', '<h2>Drops</h2>', '<h2>Drop zones</h2>'])
      expect(home).not.toContain(gone);
    expect(home).toMatch(/<details id="sticks"[^>]*><summary>Sticks: \d+ live/);
  });

  test('anonymous: /work and /drops are refused as /briefings is', async () => {
    const { h } = await lists();
    const anon = async (url: string) => (await h.app.inject({ method: 'GET', url })).statusCode;
    const briefings = await anon('/briefings');
    expect(briefings).not.toBe(200);
    expect(await anon('/work')).toBe(briefings);
    expect(await anon('/drops')).toBe(briefings);
  });

  test('the floor links its counts to the list pages, and the nav has Work and Drops', async () => {
    const { h } = await lists();
    const home = (await h.view('/')).body;
    expect(home).toContain('href="/work?state=ready"');
    expect(home).toContain('href="/drops?state=active"');
    expect(home).toMatch(/<nav class="topnav"[^>]*>.*<a href="\/work">Work<\/a>.*<\/nav>/);
    expect(home).toMatch(/<nav class="topnav"[^>]*>.*<a href="\/drops">Drops<\/a>.*<\/nav>/);
  });
});
