import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { routeClass } from '../auth/guard.js';
import { listBriefings, raiseBriefing, ruleBriefing } from '../briefings.js';
import { DEFAULT_PROTECTED_PATHS } from '../config.js';
import { insertCrewIssue } from '../crew/store.js';
import {
  type DropState,
  insertDrop,
  insertOutbox,
  insertStick,
  setStickDesiredSlots,
  setWorkItemState,
  setZoneMode,
  stampStick,
  updateDrop,
  updateOutbox,
  upsertDropZone,
  upsertWorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { actionFor, PAGES_M45A, pagesOf } from '../doctor/actions.js';
import { CHECK_IDS, DOC } from '../doctor/checks.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { zoneGuidance } from '../github/guidance.js';
import { recordObjectiveDone, zoneObjective } from '../goals.js';
import { opMarker } from '../outbox.js';
import { crewOn, GOAL } from '../test/crew.js';
import { harness } from '../test/flowHarness.js';
import { operatorSession } from '../test/helpers.js';

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

  test('/briefings resolves About and crew keys, and /briefings/<n> shows one briefing (#226)', async () => {
    const h = await crewHarness();
    const at = h.now();
    const issue = insertCrewIssue(h.db, {
      zoneId: 'main',
      key: 'app-push-token',
      source: 'drop',
      objective: 'o',
      title: 'Push tokens in app mode',
      body: 'b',
      priority: null,
      createdAt: at.toISOString(),
      number: 224,
    });
    const id = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'promote',
        subject: `issue:${issue}`,
        decision: 'Promote it?',
        why: 'Land app-push-token before Briefing 999.',
        options: [{ id: 'promote', label: 'Promote', effect: 'promote_issue' }],
        source: 'server',
      },
      at,
    );
    const list = await get(h, '/briefings');
    expect(list.body).toContain('>#224 Push tokens in app mode</a>');
    expect(list.body).toContain(
      'app-push-token (<a href="https://github.com/octo/demo/issues/224" target="_blank" rel="noopener noreferrer">#224</a>)',
    );
    const one = await get(h, `/briefings/${id}`);
    expect(one.statusCode).toBe(200);
    expect(one.body).toContain(`id="briefing-${id}"`);
    expect(one.body).toContain('>#224 Push tokens in app mode</a>');
    expect(one.body).toContain('<a href="/briefings/999">Briefing 999</a>');
    expect((await get(h, '/briefings/999')).statusCode).toBe(404);
    expect((await get(h, '/briefings/abc')).statusCode).toBe(404);
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
    expect(home.body).toContain('<a href="/briefings?zone=main">octo/demo: 1 waiting</a>');
    expect(home.body).not.toContain('Open &lt;b&gt;question&lt;/b&gt;');
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

  const THREE_GOALS = `# Goals

## Lighthouse

Ship it.

## Objectives

- [x] Broker and JWT
- [ ] Manifest flow
- [ ] Release notes
`;

  async function rulingId(h: Awaited<ReturnType<typeof crewHarness>>): Promise<number> {
    const id = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:objective',
        decision: 'Is it done?',
        why: 'w',
        options: [{ id: 'yes', label: 'Yes', effect: 'none' }],
        source: 'crew',
      },
      h.now(),
    );
    const r = ruleBriefing(h.db, id, 'yes', 'done', h.now());
    if (!r.ok) throw new Error('ruling failed');
    return r.rulingId;
  }

  function statusOf(body: string, title: string): string | undefined {
    const m = new RegExp(`<tr><td>${title}</td><td>([^<]*)</td>`).exec(body);
    return m?.[1];
  }

  test('/zones/:id/goals marks done by ruling and names the crew’s current objective (#338)', async () => {
    const h = await crewHarness();
    h.forge.state.files.set('main:GOAL.md', THREE_GOALS);
    await h.sync();
    const rid = await rulingId(h);
    recordObjectiveDone(h.db, 'main', 'manifest-flow', rid, h.now());
    const body = (await get(h, '/zones/main/goals')).body;
    expect(statusOf(body, 'Broker and JWT')).toBe('done');
    expect(statusOf(body, 'Manifest flow')).toBe(`done (ruling #${rid})`);
    expect(statusOf(body, 'Release notes')).toBe('Current objective');
    expect(body.match(/Current objective/g)).toHaveLength(1);
    const current = /<td>Current objective<\/td><td><code>([^<]*)<\/code>/.exec(body)?.[1];
    expect(current).toBe(zoneObjective(h.db, 'main')?.key);
    expect(body).not.toContain('Every objective is done');
  });

  test('/zones/:id/goals says every objective is done when the file and rulings cover all (#338)', async () => {
    const h = await crewHarness();
    h.forge.state.files.set('main:GOAL.md', THREE_GOALS);
    await h.sync();
    const rid = await rulingId(h);
    recordObjectiveDone(h.db, 'main', 'manifest-flow', rid, h.now());
    recordObjectiveDone(h.db, 'main', 'release-notes', rid, h.now());
    const body = (await get(h, '/zones/main/goals')).body;
    expect(zoneObjective(h.db, 'main')).toBeNull();
    expect(body).toContain(
      'Every objective is done. Add the next objective to GOAL.md to give the crew more work.',
    );
    expect(body).not.toContain('Current objective');
    expect(statusOf(body, 'Release notes')).toBe(`done (ruling #${rid})`);
  });

  test('/zones/:id/goals links back to the zone page and to the goal file on GitHub (#365)', async () => {
    const h = await crewHarness();
    await h.sync();
    const body = (await get(h, '/zones/main/goals')).body;
    expect(body).toContain('href="/zones/main"');
    expect(body).toContain('The goals live in GOAL.md in octo/demo.');
    expect(body).toContain('<a href="https://github.com/octo/demo/blob/HEAD/GOAL.md">');
    expect(body).not.toContain('/zones/main/intake');
  });

  test('/zones/:id/goals offers the intake page, not GitHub, when the goal file is missing (#365)', async () => {
    const h = await crewHarness();
    h.forge.state.files.delete('main:GOAL.md');
    await h.sync();
    const body = (await get(h, '/zones/main/goals')).body;
    expect(body).toContain(
      `GOAL.md isn't in the repository yet. <a href="/zones/main/intake">Write one with the intake page</a>.`,
    );
    expect(body).not.toContain('github.com');
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

  test('the drop page tells a pruned transcript from one that never had events', async () => {
    const h = await crewHarness();
    await h.sync();
    for (const id of ['pruned', 'empty'])
      insertDrop(h.db, {
        id,
        dropZoneId: 'main',
        workItemId: null,
        role: 'doctor',
        state: 'succeeded',
        createdAt: h.now().toISOString(),
      });
    h.db
      .prepare(
        `UPDATE drops SET transcript_pruned_at = '2026-11-16T12:00:00.000Z',
           transcript_archive = 'transcripts/main/2026-08/pruned.jsonl.gz' WHERE id = 'pruned'`,
      )
      .run();
    const pruned = (await get(h, '/drops/pruned')).body;
    expect(pruned).toContain(
      'Transcript pruned on 2026-11-16; archived at transcripts/main/2026-08/pruned.jsonl.gz',
    );
    expect(pruned).not.toContain('No events recorded');
    const empty = (await get(h, '/drops/empty')).body;
    expect(empty).toContain('No events recorded');
    expect(empty).not.toContain('Transcript pruned');
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
      '<a href="https://github.com/octo/demo/settings/rules?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Import &lt;the&gt; ruleset</a>',
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
    // D5: a value only the scrub set holds (a minted token) is redacted the same way.
    serverScrubSet.add('minted-only-in-scrub-set-0003');
    try {
      setWorkItemState(
        h.db,
        first?.id as number,
        'parked',
        'push with minted-only-in-scrub-set-0003',
      );
      const minted = await h.view('/api/control/status');
      expect(minted.body).not.toContain('minted-only-in-scrub-set-0003');
      expect((minted.json() as { headline: string }).headline).toBe(
        '1 parked: push with [REDACTED]',
      );
    } finally {
      serverScrubSet.clear();
    }
    setWorkItemState(h.db, first?.id as number, 'parked', 'merge refused for author-token');
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

  describe('/drops?issue= (#496)', () => {
    const five = (h: Awaited<ReturnType<typeof harness>>, zoneId: string) =>
      upsertWorkItem(
        h.db,
        {
          dropZoneId: zoneId,
          issueNumber: 5,
          title: `${zoneId} five`,
          body: 'b',
          author: 'human',
          priority: 2,
          isFix: false,
          issueCreatedAt: '2026-01-01T00:00:00.000Z',
        },
        h.now(),
      );

    test('lists only that zone’s drops for the issue, in every state', async () => {
      const { h, item } = await lists();
      const main5 = five(h, 'main');
      const ref5 = five(h, 'ref');
      drop(h, 'main-5-old', 'failed', 'main', '2026-01-01T00:00:00.000Z', main5.id);
      drop(h, 'main-5-new', 'running', 'main', '2026-01-02T00:00:00.000Z', main5.id);
      drop(h, 'ref-5', 'succeeded', 'ref', '2026-01-01T00:00:00.000Z', ref5.id);
      drop(h, 'main-other', 'failed', 'main', '2026-01-01T00:00:00.000Z', item('main', 'ready').id);
      drop(h, 'main-crew', 'succeeded', 'main');
      const res = await h.view('/drops?zone=main&issue=5');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('>main-5-old</a>');
      expect(res.body).toContain('>main-5-new</a>');
      expect(res.body).not.toContain('ref-5');
      expect(res.body).not.toContain('main-other');
      expect(res.body).not.toContain('main-crew');
      expect(res.body).toContain('Drops for #5 in octo/demo');
      const ref = (await h.view('/drops?zone=ref&issue=5')).body;
      expect(ref).toContain('>ref-5</a>');
      expect(ref).not.toContain('main-5');
    });

    test('the state links keep the issue; links to another zone drop it', async () => {
      const { h } = await lists();
      const body = (await h.view('/drops?zone=main&issue=5&state=failed')).body;
      expect(body).toContain('href="/drops?zone=main&amp;issue=5"');
      expect(body).toContain('href="/drops?zone=main&amp;issue=5&amp;state=active"');
      expect(body).toContain('href="/drops?zone=main&amp;issue=5&amp;state=failed"');
      expect(body).toContain('href="/drops?zone=ref&amp;state=failed"');
      expect(body).toContain('href="/drops?state=failed"');
      expect(body).not.toContain('zone=ref&amp;issue=5');
    });

    test('an issue with no work item, or no drops: the empty line, 200', async () => {
      const { h } = await lists();
      five(h, 'main');
      for (const n of [999, 5]) {
        const res = await h.view(`/drops?zone=main&issue=${n}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(`No drops for #${n} in octo/demo.`);
        expect(res.body).not.toContain('<table');
      }
    });

    test.each([
      ['/drops?issue=5', 'issue needs zone'],
      ['/drops?zone=main&issue=0', 'bad issue'],
      ['/drops?zone=main&issue=-3', 'bad issue'],
      ['/drops?zone=main&issue=x', 'bad issue'],
      ['/drops?zone=main&issue=1.5', 'bad issue'],
      ['/drops?zone=main&issue=05', 'bad issue'],
      ['/drops?zone=main&issue=', 'bad issue'],
      ['/drops?zone=main&issue=5&issue=6', 'bad issue'],
    ])('%s is 404 %s', async (url, text) => {
      const { h } = await lists();
      const res = await h.view(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.body).toBe(text);
    });
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

describe('/briefings grouped by project and paged (#132)', () => {
  /** The harness zone `main` (octo/demo), plus `ref` and `a b` (which needs encoding). */
  async function projects() {
    const h = await harness({
      extraZones: [
        { id: 'ref', repo: 'octo/ref' },
        { id: 'a b', repo: 'octo/spaced' },
      ],
    });
    const raise = (zoneId: string, n: number) => {
      const ids: number[] = [];
      for (let i = 1; i <= n; i++)
        ids.push(
          raiseBriefing(
            h.db,
            {
              zoneId,
              kind: 'crew',
              subject: `crew:${zoneId}-${i}`,
              decision: `Decide ${zoneId} number ${i}?`,
              why: 'w',
              options: [{ id: 'ok', label: 'OK', effect: 'none' }],
              source: 'crew',
            },
            h.now(),
          ),
        );
      return ids;
    };
    return { h, raise };
  }
  const blocks = (html: string): number => html.match(/data-briefing="/g)?.length ?? 0;

  test('the zone view pages 23 briefings: Next only on page 1, Previous only on the last, clamped', async () => {
    const { h, raise } = await projects();
    raise('main', 23);
    const view = async (q: string) => (await h.view(`/briefings?zone=main${q}`)).body;
    const one = await view('');
    expect(blocks(one)).toBe(10);
    expect(one).toContain('Page 1 of 3');
    expect(one).toContain('>Next</a>');
    expect(one).not.toContain('>Previous</a>');
    expect(one).toContain('Decide main number 23?');
    const three = await view('&page=3');
    expect(blocks(three)).toBe(3);
    expect(three).toContain('Page 3 of 3');
    expect(three).toContain('>Previous</a>');
    expect(three).not.toContain('>Next</a>');
    expect(three).toContain('Decide main number 1?');
    // The CSRF token differs per session: compare what the pages show.
    const shown = (html: string) => [
      ...[...html.matchAll(/data-briefing="(\d+)"/g)].map((m) => m[1]),
      html.match(/Page \d+ of \d+/)?.[0],
    ];
    expect(shown(await view('&page=99'))).toEqual(shown(three));
    expect(shown(await view('&page=-1'))).toEqual(shown(one));
    const p2 = await view('&per=20&page=2');
    expect(blocks(p2)).toBe(3);
    expect(p2).toContain('Page 2 of 2');
    expect(p2).toContain('>Previous</a>');
    expect(p2).not.toContain('>Next</a>');
  });

  test.each([
    ['10', 10],
    ['20', 20],
    ['50', 50],
    ['100', 100],
    ['7', 10],
    ['abc', 10],
    ['0', 10],
    ['1000', 10],
    [undefined, 10],
  ])('per=%s shows %i of 120 briefings, on both views', async (per, shown) => {
    const { h, raise } = await projects();
    raise('main', 120);
    const q = per === undefined ? '' : `per=${per}`;
    for (const url of [`/briefings?${q}`, `/briefings?zone=main&${q}`]) {
      const res = await h.view(url);
      expect(res.statusCode).toBe(200);
      expect(blocks(res.body)).toBe(shown);
      expect(res.body).toContain(`per=${shown}" aria-current="page">${shown}</a>`);
    }
  });

  test('rulings page independently: rpage=2 leaves the briefings shown as they were', async () => {
    const { h, raise } = await projects();
    const ids = raise('main', 25);
    for (const id of ids.slice(0, 12)) ruleBriefing(h.db, id, 'ok', `note ${id}`, h.now());
    const shown = (html: string) => [...html.matchAll(/data-briefing="(\d+)"/g)].map((m) => m[1]);
    const one = (await h.view('/briefings?zone=main')).body;
    const two = (await h.view('/briefings?zone=main&rpage=2')).body;
    expect(shown(two)).toEqual(shown(one));
    expect(shown(one)).toHaveLength(10);
    expect(one).toContain(`<td>note ${ids[11]}</td>`);
    expect(one).not.toContain(`<td>note ${ids[0]}</td>`);
    expect(two).toContain(`<td>note ${ids[0]}</td>`);
    expect(two).not.toContain(`<td>note ${ids[11]}</td>`);
  });

  test('the dismiss form on page 1 of 3 dismisses all 23 of the zone, and says so', async () => {
    const { h, raise } = await projects();
    raise('main', 23);
    raise('ref', 2);
    const html = (await h.view('/briefings?zone=main&per=10&page=1')).body;
    expect(html).toContain('Dismiss all 23 briefings of octo/demo');
    const ids = JSON.parse(
      (html.match(/<form id="dismiss-all" [^>]*data-ids="([^"]*)"/)?.[1] ?? '[]').replaceAll(
        '&quot;',
        '"',
      ),
    ) as number[];
    const session = operatorSession(h.db, h.now());
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/control/zones/main/briefings/dismiss',
      headers: session.headers,
      payload: { ids },
    });
    expect(res.statusCode).toBe(200);
    expect(listBriefings(h.db, { zoneId: 'main', state: 'open' })).toEqual([]);
    expect(listBriefings(h.db, { zoneId: 'ref', state: 'open' })).toHaveLength(2);
  });

  test('all projects: sections by count, a paused zone collapsed last and not counted', async () => {
    const { h, raise } = await projects();
    raise('main', 3);
    raise('ref', 12);
    raise('a b', 30);
    setZoneMode(h.db, 'a b', 'paused', h.now());
    const res = await h.view('/briefings');
    expect(res.statusCode).toBe(200);
    const html = res.body;
    const at = (id: string) => html.indexOf(`data-zone="${id}"`);
    expect(at('ref')).toBeLessThan(at('main'));
    expect(at('main')).toBeLessThan(at('a b'));
    expect(html).toContain('<details class="project held" data-zone="a b">');
    expect(html).toContain('<summary>octo/spaced: 30 held while paused</summary>');
    expect(html).toContain('15 decisions waiting');
    expect(html).toContain('Show all 12 in octo/ref');
    expect(html).toContain('href="/briefings?zone=a%20b&amp;per=10"');
    expect(html).not.toMatch(/zone (main|ref|a b)\b/);
  });

  test('the floor card holds one counted line per project and no decision text', async () => {
    const { h, raise } = await projects();
    raise('main', 2);
    raise('a b', 3);
    const home = (await h.view('/')).body;
    const card = home.slice(home.indexOf('<h2>Waiting on you</h2>'));
    const list = card.slice(card.indexOf('<ul>'), card.indexOf('</ul>'));
    expect(list.match(/<li>/g)).toHaveLength(2);
    expect(list).toContain('<a href="/briefings?zone=a%20b">octo/spaced: 3 waiting</a>');
    expect(list).toContain('<a href="/briefings?zone=main">octo/demo: 2 waiting</a>');
    expect(list.indexOf('octo/spaced')).toBeLessThan(list.indexOf('octo/demo'));
    expect(home).not.toContain('Decide ');
  });

  test('an unknown zone is still 404, whatever the paging', async () => {
    const { h } = await projects();
    expect((await h.view('/briefings?zone=nope&per=20&page=2')).statusCode).toBe(404);
  });
});

describe('external links open in a new tab, in-app links do not (#133)', () => {
  test('a sweep over /, /work, /drops, /briefings and /zones/<id>/github', async () => {
    const h = await harness({
      issues: [],
      live: true,
      zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS] },
      guidanceForge: () => ({
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
        listDir: async () => [],
        getFileAt: async () => null,
      }),
    });
    upsertDropZone(h.db, {
      id: 'main',
      repo: h.zone.repo,
      defaultBranch: 'main',
      configJson: '{}',
    });
    const w = upsertWorkItem(
      h.db,
      {
        dropZoneId: 'main',
        issueNumber: 41,
        title: 'with a PR',
        body: 'b',
        author: 'human',
        priority: 2,
        isFix: false,
        issueCreatedAt: '2026-01-01T00:00:00.000Z',
      },
      h.now(),
    );
    setWorkItemState(h.db, w.id, 'pr_open', undefined, h.now());
    h.db.prepare('UPDATE work_items SET pr_number = 77 WHERE id = ?').run(w.id);
    insertDrop(h.db, {
      id: 'sweep-drop',
      dropZoneId: 'main',
      workItemId: w.id,
      role: 'implement',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const anchors: string[] = [];
    for (const url of ['/', '/work', '/drops', '/briefings', '/zones/main/github']) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBe(200);
      anchors.push(...(res.body.match(/<a\b[^>]*>/g) ?? []).map((a) => `${url}: ${a}`));
    }
    const hrefOf = (a: string) => /\shref="([^"]*)"/.exec(a)?.[1] ?? '';
    const external = anchors.filter((a) => hrefOf(a).startsWith('http'));
    // The PR link and GitHub's links are swept, so a missed one fails here.
    expect(external.some((a) => hrefOf(a).endsWith('/pull/77'))).toBe(true);
    expect(external.length).toBeGreaterThan(1);
    for (const a of external) {
      expect(a, a).toContain('target="_blank"');
      expect(a, a).toContain('rel="noopener noreferrer"');
    }
    for (const a of anchors.filter((a) => /^[/?#]/.test(hrefOf(a))))
      expect(a, a).not.toContain('target=');
    for (const a of anchors.filter((a) => a.includes('target="_blank"')))
      expect(a, a).toContain('rel="noopener noreferrer"');
  });

  test('/sticks lists each stick, names its zones by repository, and has a trooper input up to maxSlots', async () => {
    const h = await harness({ zone: { egress: { mode: 'enforce' } } });
    insertStick(h.db, { id: 's1', name: 'm3-stick', tokenHash: 'h1', slots: 1 });
    insertStick(h.db, {
      id: 's2',
      name: 'kidney-shadow',
      tokenHash: 'h2',
      slots: 1,
      capabilities: ['egress-v1'],
    });
    stampStick(
      h.db,
      's2',
      { capabilities: ['egress-v1'], imagePolicy: 'allowlist', version: '0.6.0', pinnedImages: [] },
      h.now(),
      { maxSlots: 4 },
    );
    setStickDesiredSlots(h.db, 's2', 3);
    const res = await h.view('/sticks');
    expect(res.statusCode).toBe(200);
    const html = res.body;
    const row = (name: string) =>
      html.match(
        new RegExp(`<tr[^>]*data-stick="[^"]*">(?:(?!</tr>).)*${name}(?:(?!</tr>).)*</tr>`),
      )?.[0] ?? '';
    const shadow = row('kidney-shadow');
    const m3 = row('m3-stick');
    expect(shadow).toContain('0.6.0');
    expect(shadow).toContain('live');
    expect(shadow).toMatch(/<input[^>]*type="number"[^>]*min="1"[^>]*max="4"[^>]*value="3"/);
    expect(shadow).toContain('data-slots="/api/control/sticks/s2/slots"');
    expect(shadow).toContain('Running now: 0 of 3');
    expect(shadow).not.toContain('JM_MAX_SLOTS');
    expect(m3).toContain('cannot run octo/demo: lacks egress-v1');
    expect(m3).toMatch(/<input[^>]*type="number"[^>]*max="1"[^>]*value="1"/);
    expect(m3).toContain(
      'This stick allows up to 1. To allow more, set <code>JM_MAX_SLOTS</code> on that machine and restart it.',
    );
    expect(m3).toContain('never seen');
    // The harness's own stick, enrolled with 4 and never leased.
    expect(html).toMatch(/<input[^>]*type="number"[^>]*max="4"[^>]*value="4"/);
    // Linked from the nav and from the floor's Sticks summary.
    expect(html).toMatch(/<nav class="topnav"[^>]*>.*<a href="\/sticks">Sticks<\/a>.*<\/nav>/);
    const home = (await h.view('/')).body;
    expect(home).toMatch(/<details id="sticks"[^>]*>.*<a href="\/sticks">.*<\/details>/);
  });

  test('anonymous: /sticks is refused as /work is', async () => {
    const h = await harness();
    const anon = async (url: string) => (await h.app.inject({ method: 'GET', url })).statusCode;
    const work = await anon('/work');
    expect(work).not.toBe(200);
    expect(await anon('/sticks')).toBe(work);
  });

  test("posting through the page's route changes the count the next lease answers with", async () => {
    const h = await harness();
    const id = (h.db.prepare("SELECT id FROM sticks WHERE name = 'h'").get() as { id: string }).id;
    const lease = (maxSlots: number) =>
      h.app.inject({
        method: 'POST',
        url: '/api/sticks/lease',
        headers: h.stickHeaders(),
        payload: { freeSlots: 0, maxSlots },
      });
    expect((await lease(6)).headers['x-jumpmaster-slots']).toBe('4');
    const html = (await h.view('/sticks')).body;
    const url = html.match(/data-slots="([^"]*)"/)?.[1];
    expect(url).toBe(`/api/control/sticks/${id}/slots`);
    const session = operatorSession(h.db, h.now());
    // The page's fetch carries the session's CSRF token; without it the write is refused.
    const bare = await h.app.inject({
      method: 'POST',
      url: url as string,
      headers: { cookie: session.cookie },
      payload: { slots: 6 },
    });
    expect(bare.statusCode).toBe(403);
    const res = await h.app.inject({
      method: 'POST',
      url: url as string,
      headers: session.headers,
      payload: { slots: 6 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id, slots: 6, maxSlots: 6 });
    expect((await lease(6)).headers['x-jumpmaster-slots']).toBe('6');
    expect((await h.view('/sticks')).body).toContain('Running now: 0 of 6');
  });
});

describe('route classes (crew chat, #349)', () => {
  test("routeClass('/mcp/chat') is 'chat-mcp', and /mcp is still 'mcp'", () => {
    expect(routeClass('/mcp/chat')).toBe('chat-mcp');
    expect(routeClass('/mcp')).toBe('mcp');
    expect(routeClass('/mcp/chat/x')).toBe('page');
  });
});
