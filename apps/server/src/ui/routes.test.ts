import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { routeClass } from '../auth/guard.js';
import { sha256Hex } from '../auth/sessions.js';
import { listBriefings, raiseBriefing, ruleBriefing } from '../briefings.js';
import { recordCard } from '../chat/cards.js';
import { appendMessage, createThread } from '../chat/store.js';
import { DEFAULT_PROTECTED_PATHS } from '../config.js';
import { insertCrewIssue } from '../crew/store.js';
import {
  type DropState,
  insertDrop,
  insertOutbox,
  insertStick,
  listWorkItems,
  recordObservation,
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
import { harness, toPrOpen } from '../test/flowHarness.js';
import { operatorSession } from '../test/helpers.js';
import { renderSticks } from './sticks.js';

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
    const foreign = await h.view('/system', { host: 'evil.test' });
    expect(foreign.statusCode).toBe(403);
    expect((await get(h, '/system')).body).toContain('No doctor run has finished yet');
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
    const html = (await get(h, '/system')).body;
    expect(html).toContain('missing &lt;script&gt;');
    expect(html).toMatch(/<tr class="fail">.*forge\.labels/);
    expect(html).toContain('gh label create agent-ready');
    expect(html).toContain('1 pass, 0 warn, 1 fail, 0 skip');
    expect(html).toContain(
      'data-doctor="/api/control/doctor/drop" data-body="{&quot;zone&quot;:&quot;main&quot;}"',
    );
  });

  test("the home page counts each enrolled stick's troopers and names a zone one cannot run", async () => {
    const h = await harness({ zone: { egress: { mode: 'enforce' } } });
    insertStick(h.db, { id: 's1', name: 'm3-stick', tokenHash: 'h1', slots: 1 });
    insertStick(h.db, {
      id: 's2',
      name: 'new-stick',
      tokenHash: 'h2',
      slots: 1,
      capabilities: ['egress-v1'],
    });
    // Home's Capacity counts each stick's troopers (#625) and says what one cannot run.
    const html = (await get(h, '/')).body;
    expect(html).toMatch(
      /m3-stick: 0 of 1 troopers busy( <small class="muted">offline<\/small>)? <small class="cannot-run">cannot run octo\/demo: lacks egress-v1<\/small><\/li>/,
    );
    expect(html).toMatch(
      /new-stick: 0 of 1 troopers busy( <small class="muted">offline<\/small>)?<\/li>/,
    );
  });

  test('/briefings/<n> resolves About and crew keys and shows one briefing (#226)', async () => {
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
    const one = await get(h, `/briefings/${id}`);
    expect(one.body).toContain(
      'app-push-token (<a href="https://github.com/octo/demo/issues/224" target="_blank" rel="noopener noreferrer">#224</a>)',
    );
    expect(one.statusCode).toBe(200);
    expect(one.body).toContain(`id="briefing-${id}"`);
    expect(one.body).toContain('>#224 Push tokens in app mode</a>');
    expect(one.body).toContain('<a href="/briefings/999">Briefing 999</a>');
    expect((await get(h, '/briefings/999')).statusCode).toBe(404);
    expect((await get(h, '/briefings/abc')).statusCode).toBe(404);
  });

  test('Home lists open briefings; recorded rulings are on the Log (#621, #625)', async () => {
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
    const res = await get(h, `/briefings/${open}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`data-briefing="${open}"`);
    const log = await get(h, '/projects/main/log?kind=rulings');
    expect(log.statusCode).toBe(200);
    expect(log.body).toContain('not now');
    const home = await get(h, '/');
    expect(home.body).toContain('<h2>Needs you</h2>');
    expect(home.body).toContain('octo/demo: Open &lt;b&gt;question&lt;/b&gt;');
    expect(home.body).toContain(`<a href="/briefings/${open}">Answer</a>`);
    expect(home.body).not.toContain(`/briefings/${ruled}"`);
    expect(home.body).not.toContain('not now');
    expect(home.body).not.toContain('<h2>Crew</h2>');
  });

  test('/projects/:id/goals shows the ladder, crew issues and the skipped list from the last sync', async () => {
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
    const res = await get(h, '/projects/main/goals');
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

  test('/projects/:id/goals marks done by ruling and names the crew’s current objective (#338)', async () => {
    const h = await crewHarness();
    h.forge.state.files.set('main:GOAL.md', THREE_GOALS);
    await h.sync();
    const rid = await rulingId(h);
    recordObjectiveDone(h.db, 'main', 'manifest-flow', rid, h.now());
    const body = (await get(h, '/projects/main/goals')).body;
    expect(statusOf(body, 'Broker and JWT')).toBe('done');
    expect(statusOf(body, 'Manifest flow')).toBe(`done (ruling #${rid})`);
    expect(statusOf(body, 'Release notes')).toBe('Current objective');
    expect(body.match(/Current objective/g)).toHaveLength(1);
    const current = /<td>Current objective<\/td><td><code>([^<]*)<\/code>/.exec(body)?.[1];
    expect(current).toBe(zoneObjective(h.db, 'main')?.key);
    expect(body).not.toContain('Every objective is done');
  });

  test('/projects/:id/goals says every objective is done when the file and rulings cover all (#338)', async () => {
    const h = await crewHarness();
    h.forge.state.files.set('main:GOAL.md', THREE_GOALS);
    await h.sync();
    const rid = await rulingId(h);
    recordObjectiveDone(h.db, 'main', 'manifest-flow', rid, h.now());
    recordObjectiveDone(h.db, 'main', 'release-notes', rid, h.now());
    const body = (await get(h, '/projects/main/goals')).body;
    expect(zoneObjective(h.db, 'main')).toBeNull();
    expect(body).toContain(
      'Every objective is done. Add the next objective to GOAL.md to give the crew more work.',
    );
    expect(body).not.toContain('Current objective');
    expect(statusOf(body, 'Release notes')).toBe(`done (ruling #${rid})`);
  });

  test('/projects/:id/goals links back to the zone page and to the goal file on GitHub (#365)', async () => {
    const h = await crewHarness();
    await h.sync();
    const body = (await get(h, '/projects/main/goals')).body;
    expect(body).toContain('href="/projects/main"');
    expect(body).toContain('The goals live in GOAL.md in octo/demo.');
    expect(body).toContain('<a href="https://github.com/octo/demo/blob/HEAD/GOAL.md">');
    expect(body).not.toContain('/projects/main/intake');
    // GOAL.md is there: the stub builder is closed, after the ladder and the crew issues (#620).
    expect(body).toContain('<details id="goal-stub"><summary>Draft a GOAL.md</summary>');
    expect(body.indexOf('id="goal-stub"')).toBeGreaterThan(body.indexOf('<h2>Crew issues</h2>'));
  });

  test('/projects/:id/goals offers the stub builder, not GitHub, when the goal file is missing (#365, #620)', async () => {
    const h = await crewHarness();
    h.forge.state.files.delete('main:GOAL.md');
    await h.sync();
    const body = (await get(h, '/projects/main/goals')).body;
    expect(body).toContain(
      `GOAL.md isn't in the repository yet. <a href="#goal-stub">Draft one with the GOAL.md stub builder</a>.`,
    );
    expect(body).not.toContain('github.com');
    expect(body).toContain('<details id="goal-stub" open><summary>Draft a GOAL.md</summary>');
    expect(body.indexOf('id="goal-stub"')).toBeLessThan(
      body.indexOf('<h2>Objectives (goal ladder)</h2>'),
    );
  });

  test('an unknown zone on /projects/:id/goals is 404', async () => {
    const h = await crewHarness();
    expect((await get(h, '/projects/nope/goals')).statusCode).toBe(404);
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

  test('/projects/:id/goals carries the stub builder, posting to the intake API (#620)', async () => {
    const h = await crewHarness();
    await h.sync();
    const body = (await get(h, '/projects/main/goals')).body;
    expect(body).toContain('<form id="stub-form">');
    expect(body).toContain('data-base="/api/control/zones/main/intake"');
    expect(body).toContain("await call('/goal-stub', body)");
    expect(body).toContain(
      'To file an issue, use <a href="/projects/main/issues/new"><strong>New issue</strong></a>',
    );
  });

  test('/projects/:id/goals shows the crew row first, next due as a relative time (#620)', async () => {
    const h = await crewHarness();
    await h.sync();
    const last = new Date(h.now().getTime() - 10 * 60_000).toISOString();
    insertDrop(h.db, {
      id: 'lead',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'succeeded',
      createdAt: last,
    });
    const body = (await get(h, '/projects/main/goals')).body;
    const row = body.match(/<section id="crew">.*?<\/section>/)?.[0] ?? '';
    expect(row).toContain('<td>on</td>');
    expect(row).toContain(`<time datetime="${last}" title="${last}">10 min ago</time>`);
    expect(row).toMatch(/<td><time datetime="[^"]+" title="[^"]+">in \d+ (min|h|d)<\/time><\/td>/);
    expect(body.indexOf('<section id="crew">')).toBeLessThan(
      body.indexOf('<h2>Objectives (goal ladder)</h2>'),
    );
  });

  test('/projects/:id/intake is a 301 to the stub builder on Goals (#620)', async () => {
    const h = await crewHarness();
    for (const url of ['/projects/main/intake', '/zones/main/intake']) {
      const res = await get(h, url);
      expect([url, res.statusCode, res.headers.location]).toEqual([
        url,
        301,
        '/projects/main/goals#goal-stub',
      ]);
    }
  });

  test('/projects/:id/issues/new is the issue form alone, and 404 for an unknown zone (#500)', async () => {
    const h = await crewHarness();
    const res = await get(h, '/projects/main/issues/new');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('New issue: ');
    expect(res.body).toContain('<form id="issue-form">');
    expect(res.body).toContain('maxlength="120"');
    expect(res.body).toContain('data-base="/api/control/zones/main/intake"');
    expect(res.body).not.toContain('stub-form');
    expect((await get(h, '/projects/nope/issues/new')).statusCode).toBe(404);
  });

  test.each(['/briefings', '/projects/main/goals', '/projects/main/issues/new'])(
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
      ).toBe('/system/credentials');
    expect(seen.has('GET /system/credentials')).toBe(true);
    expect((await h.view('/system/credentials')).statusCode).toBe(200);
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
    const html = (await get(h, '/system')).body;
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
  test('the home page opens with its Home heading, then the status banner and its action link (#625)', async () => {
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
    // The status line follows the Home heading, beside the kill switch.
    const body = home.slice(home.indexOf('<main id="main">') + '<main id="main">'.length);
    expect(
      body.startsWith(
        '<h2 class="page-h">Home</h2><div class="floor-head"><div class="status" data-waiting-on="you">',
      ),
    ).toBe(true);
    expect(body).toContain('<strong>1 parked: no CI result: &lt;ci&gt; &amp; friends</strong>');
    expect(body).toContain(`<a href="${status.action?.href}">`);
    expect(home).toContain('<title>Jumpmaster: Home</title>');
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
      'Queued: 1 issue; no stick can run project main: no live stick has egress-v1',
    );
    // The floor names the zone by its repository (#99); the API, read by `ctl status`, keeps the id.
    const home = (await h.view('/')).body;
    expect(home).toContain(
      '<strong>Queued: 1 issue; no stick can run project octo/demo: no live stick has egress-v1</strong>',
    );
    expect(home).toContain('<title>Jumpmaster: Home</title>');
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

  test('a project’s work keeps that zone’s rows only, and names the zone by repository', async () => {
    const { h, item } = await lists();
    item('main', 'parked', 'main parked one');
    item('main', 'parked', 'main parked two');
    item('ref', 'parked', 'ref parked');
    const res = await h.view('/projects/main/work?state=parked');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('main parked one');
    expect(res.body).toContain('main parked two');
    expect(res.body).not.toContain('ref parked');
    expect(res.body).toContain('Parked work in octo/demo');
    expect(res.body).not.toContain('zone main');
    expect(res.body).toMatch(
      /<a href="\/projects\/main\/work\?state=parked" aria-current="page">Parked<\/a>/,
    );
    // /work's project filter names each zone by its repository, keeps the state and goes to the
    // project's own list (#619).
    const all = (await h.view('/activity/work?state=parked')).body;
    expect(all).toContain('href="/projects/ref/work?state=parked">octo/ref</a>');
    expect(all).toMatch(/href="\/activity\/work\?state=parked"[^>]*>All projects<\/a>/);
  });

  test('?state=parked drops a ready row; the default shows everything but done', async () => {
    const { h, item } = await lists();
    item('main', 'ready', 'is ready');
    item('main', 'in_flight', 'is in flight');
    item('main', 'pr_open', 'is pr open');
    item('ref', 'parked', 'is parked');
    item('main', 'done', 'is done');
    const parked = (await h.view('/activity/work?state=parked')).body;
    expect(parked).toContain('is parked');
    expect(parked).not.toContain('is ready');
    const all = await h.view('/activity/work');
    expect(all.statusCode).toBe(200);
    for (const t of ['is ready', 'is in flight', 'is pr open', 'is parked'])
      expect(all.body).toContain(t);
    expect(all.body).not.toContain('is done');
    expect(all.body).toContain('All active work');
  });

  test('an issue title is escaped on /work', async () => {
    const { h, item } = await lists();
    item('main', 'ready', '<script>x</script>');
    const body = (await h.view('/activity/work')).body;
    expect(body).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(body).not.toContain('<script>x</script>');
  });

  test('no matching rows: the empty line, and no table', async () => {
    const { h, item } = await lists();
    item('ref', 'parked');
    const work = (await h.view('/projects/main/work?state=parked')).body;
    expect(work).toContain('No parked work in octo/demo.');
    expect(work).not.toContain('<table');
    const drops = (await h.view('/activity/drops?zone=ref')).body;
    expect(drops).toContain('No drops in octo/ref.');
    expect(drops).not.toContain('<table');
  });

  test('/activity/drops?state=active keeps queued, leased, running and push_pending', async () => {
    const { h, item } = await lists();
    for (const s of ['queued', 'leased', 'running', 'push_pending', 'succeeded'] as const)
      drop(h, `drop-${s}`, s, 'main', '2026-01-01T00:00:00.000Z', item('main', 'in_flight').id);
    const body = (await h.view('/activity/drops?state=active')).body;
    for (const s of ['queued', 'leased', 'running', 'push_pending'])
      expect(body).toContain(`href="/drops/drop-${s}"`);
    expect(body).not.toContain('drop-succeeded');
    expect(body).toContain('All active drops');
  });

  test('/activity/drops?zone= keeps that zone’s drops, newest first', async () => {
    const { h } = await lists();
    drop(h, 'old-main', 'succeeded', 'main', '2026-01-01T00:00:00.000Z');
    drop(h, 'new-main', 'failed', 'main', '2026-01-02T00:00:00.000Z');
    drop(h, 'ref-drop', 'succeeded', 'ref');
    const body = (await h.view('/activity/drops?zone=main&kind=all')).body;
    expect(body).not.toContain('ref-drop');
    expect(body.indexOf('title="new-main"')).toBeGreaterThan(-1);
    expect(body.indexOf('title="new-main"')).toBeLessThan(body.indexOf('title="old-main"'));
    expect(body).toContain('Drops in octo/demo');
  });

  describe('/activity/drops?issue= (#496)', () => {
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
      const res = await h.view('/activity/drops?zone=main&issue=5');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('title="main-5-old"');
      expect(res.body).toContain('title="main-5-new"');
      expect(res.body).not.toContain('ref-5');
      expect(res.body).not.toContain('main-other');
      expect(res.body).not.toContain('main-crew');
      expect(res.body).toContain('Drops for #5 in octo/demo');
      const ref = (await h.view('/activity/drops?zone=ref&issue=5')).body;
      expect(ref).toContain('title="ref-5"');
      expect(ref).not.toContain('main-5');
    });

    test('the state links keep the issue; links to another zone drop it', async () => {
      const { h } = await lists();
      const body = (await h.view('/activity/drops?zone=main&issue=5&state=failed')).body;
      expect(body).toContain('href="/activity/drops?zone=main&amp;issue=5"');
      expect(body).toContain('href="/activity/drops?zone=main&amp;issue=5&amp;state=active"');
      expect(body).toContain('href="/activity/drops?zone=main&amp;issue=5&amp;state=failed"');
      expect(body).toContain('href="/activity/drops?zone=ref&amp;state=failed"');
      expect(body).toContain('href="/activity/drops?state=failed"');
      expect(body).not.toContain('zone=ref&amp;issue=5');
    });

    test('an issue with no work item, or no drops: the empty line, 200', async () => {
      const { h } = await lists();
      five(h, 'main');
      for (const n of [999, 5]) {
        const res = await h.view(`/activity/drops?zone=main&issue=${n}`);
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain(`No drops for #${n} in octo/demo.`);
        expect(res.body).not.toContain('<table');
      }
    });

    test.each([
      ['/activity/drops?issue=5', 'issue needs zone'],
      ['/activity/drops?zone=main&issue=0', 'bad issue'],
      ['/activity/drops?zone=main&issue=-3', 'bad issue'],
      ['/activity/drops?zone=main&issue=x', 'bad issue'],
      ['/activity/drops?zone=main&issue=1.5', 'bad issue'],
      ['/activity/drops?zone=main&issue=05', 'bad issue'],
      ['/activity/drops?zone=main&issue=', 'bad issue'],
      ['/activity/drops?zone=main&issue=5&issue=6', 'bad issue'],
    ])('%s is 404 %s', async (url, text) => {
      const { h } = await lists();
      const res = await h.view(url);
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.body).toBe(text);
    });
  });

  describe('/projects/:zone/work/:issue (#498, #619)', () => {
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
    const gates = (test: number) =>
      JSON.stringify({
        status: 'completed',
        gates: [
          { name: 'lint', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' },
          { name: 'test', exitCode: test, durationMs: 1, timedOut: false, outputTail: '' },
        ],
      });

    test('lists every attempt oldest first, each with its own gates', async () => {
      const { h } = await lists();
      const w = five(h, 'main');
      const at = (d: number) => `2026-01-0${d}T00:00:00.000Z`;
      // Inserted out of order: the page orders by time, not by insertion.
      insertDrop(h.db, {
        id: 'impl-ok-0000',
        dropZoneId: 'main',
        workItemId: w.id,
        role: 'implement',
        state: 'succeeded',
        createdAt: at(3),
        prNumber: 42,
      });
      insertDrop(h.db, {
        id: 'impl-bad-0000',
        dropZoneId: 'main',
        workItemId: w.id,
        role: 'implement',
        state: 'failed',
        createdAt: at(1),
      });
      insertDrop(h.db, {
        // The issue's "diagnose" step: `diagnose` is a crew role with no work item (a schema
        // CHECK), so the middle attempt is the item's review.
        id: 'review-00000',
        dropZoneId: 'main',
        workItemId: w.id,
        role: 'review',
        state: 'succeeded',
        createdAt: at(2),
      });
      updateDrop(h.db, 'impl-bad-0000', { resultJson: gates(1) });
      updateDrop(h.db, 'impl-ok-0000', { resultJson: gates(0) });
      const res = await h.view('/projects/main/work/5');
      expect(res.statusCode).toBe(200);
      const body = res.body;
      const rows = body.match(/<tr class="attempt">.*?<\/tr>/g) ?? [];
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('href="/drops/impl-bad-0000"');
      expect(rows[0]).toContain('<span class="gate fail">test: fail</span>');
      expect(rows[0]).toContain('<span class="gate pass">lint: pass</span>');
      expect(rows[0]).toContain('implement');
      expect(rows[1]).toContain('href="/drops/review-00000"');
      expect(rows[1]).toContain('<td>review</td>');
      expect(rows[2]).toContain('href="/drops/impl-ok-0000"');
      expect(rows[2]).toContain('<span class="gate pass">test: pass</span>');
      expect(rows[2]).toContain('<span class="gate pass">lint: pass</span>');
      expect(rows[2]).not.toContain('fail');
      expect(rows[2]).toContain('#42');
      // One breadcrumb, Projects › the project › Work › the issue, and the drop-list link.
      expect(body.match(/aria-label="Breadcrumb"/g)).toHaveLength(1);
      expect(body).toContain(
        '<ol><li><a href="/projects">Projects</a></li><li><a href="/projects/main">octo/demo</a></li><li><a href="/projects/main/work">Work</a></li><li><span aria-current="page">#5</span></li></ol>',
      );
      expect(body).toContain(
        'href="/activity/drops?zone=main&amp;issue=5">All drops for this issue</a>',
      );
    });

    test('two zones with #5: each page lists only its own zone’s drops', async () => {
      const { h } = await lists();
      const a = five(h, 'main');
      const b = five(h, 'ref');
      drop(h, 'main-five-1', 'failed', 'main', '2026-01-01T00:00:00.000Z', a.id);
      drop(h, 'ref-five-11', 'failed', 'ref', '2026-01-01T00:00:00.000Z', b.id);
      const main = (await h.view('/projects/main/work/5')).body;
      expect(main).toContain('href="/drops/main-five-1"');
      expect(main).not.toContain('ref-five');
      expect(main).toContain('main five');
      const ref = (await h.view('/projects/ref/work/5')).body;
      expect(ref).toContain('href="/drops/ref-five-11"');
      expect(ref).not.toContain('main-five');
    });

    test.each([
      '/projects/main/work/0',
      '/projects/main/work/x',
      '/projects/main/work/05',
      '/projects/main/work/1.5',
      '/projects/nope/work/5',
      '/projects/main/work/999',
    ])('%s is 404', async (url) => {
      const { h } = await lists();
      five(h, 'main');
      const res = await h.view(url);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('not found');
    });
  });

  test('/drops shows the newest 200, and says so only when more exist', async () => {
    const { h } = await lists();
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    for (let i = 0; i < 200; i++)
      drop(h, `d${String(i).padStart(3, '0')}`, 'succeeded', 'main', at(i));
    const two = (await h.view('/activity/drops?kind=all')).body;
    expect(two.match(/<a href="\/drops\/d\d+"/g)).toHaveLength(200);
    expect(two).not.toContain('Showing the newest 200');
    drop(h, 'd200', 'succeeded', 'main', at(200));
    const more = (await h.view('/activity/drops?kind=all')).body;
    expect(more.match(/<a href="\/drops\/d\d+"/g)).toHaveLength(200);
    expect(more).toContain('Showing the newest 200');
    expect(more).toContain('title="d200"');
    expect(more).not.toContain('title="d000"');
  });

  describe('/activity/drops?kind= (#497)', () => {
    const ids = (body: string) =>
      [...body.matchAll(/<a href="\/drops\/([^"]+)"/g)].map((m) => m[1]);

    test('the default lists issue work; crew, doctor and all list theirs', async () => {
      const { h, item } = await lists();
      for (const id of ['crew-1', 'crew-2', 'crew-3']) drop(h, id, 'succeeded');
      drop(h, 'work-1', 'succeeded', 'main', undefined, item('main', 'in_flight').id);
      drop(h, 'work-2', 'failed', 'main', undefined, item('main', 'in_flight').id);
      insertDrop(h.db, {
        id: 'doc-1',
        dropZoneId: 'main',
        workItemId: null,
        role: 'doctor',
        state: 'succeeded',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(ids((await h.view('/activity/drops')).body).sort()).toEqual(['work-1', 'work-2']);
      expect(ids((await h.view('/activity/drops?kind=work')).body).sort()).toEqual([
        'work-1',
        'work-2',
      ]);
      expect(ids((await h.view('/activity/drops?kind=crew')).body).sort()).toEqual([
        'crew-1',
        'crew-2',
        'crew-3',
      ]);
      expect(ids((await h.view('/activity/drops?kind=doctor')).body)).toEqual(['doc-1']);
      expect(ids((await h.view('/activity/drops?kind=all')).body)).toHaveLength(6);
    });

    test('the filter applies before the limit: 250 crew drops hide no issue drop', async () => {
      const { h, item } = await lists();
      const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
      for (let i = 0; i < 5; i++)
        drop(h, `work-${i}`, 'succeeded', 'main', at(i), item('main', 'in_flight').id);
      for (let i = 0; i < 250; i++) drop(h, `crew-${i}`, 'succeeded', 'main', at(10 + i));
      const body = (await h.view('/activity/drops')).body;
      expect(ids(body).sort()).toEqual(['work-0', 'work-1', 'work-2', 'work-3', 'work-4']);
      expect(body).not.toContain('Showing the newest');
    });

    test('kind=bogus is 404 bad kind', async () => {
      const { h } = await lists();
      const res = await h.view('/activity/drops?kind=bogus');
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('bad kind');
    });

    test('kind links keep zone and state; zone and state links keep kind', async () => {
      const { h } = await lists();
      const body = (await h.view('/activity/drops?zone=main&state=failed&kind=crew')).body;
      expect(body).toContain('<a href="/activity/drops?zone=main&amp;state=failed">Issue work</a>');
      expect(body).toContain(
        '<a href="/activity/drops?zone=main&amp;state=failed&amp;kind=crew" aria-current="page">Crew</a>',
      );
      expect(body).toContain(
        '<a href="/activity/drops?zone=main&amp;state=failed&amp;kind=doctor">Doctor</a>',
      );
      expect(body).toContain(
        '<a href="/activity/drops?zone=main&amp;state=failed&amp;kind=all">All kinds</a>',
      );
      expect(body).toContain('href="/activity/drops?zone=ref&amp;state=failed&amp;kind=crew"');
      expect(body).toContain('href="/activity/drops?zone=main&amp;state=active&amp;kind=crew"');
    });
  });

  test.each([
    ['/activity/drops?zone=nope', 'no such zone'],
    ['/activity/work?state=bogus', 'no such state'],
    ['/activity/drops?state=bogus', 'no such state'],
    ['/activity/drops?kind=', 'bad kind'],
    ['/activity/drops?kind=all&kind=crew', 'bad kind'],
    ['/activity/work?state=cancelled', 'no such state'],
  ])('%s is 404 %s', async (url, text) => {
    const { h } = await lists();
    const res = await h.view(url);
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toBe(text);
  });

  test("Home (#625): Pipeline's five numbers are the Activity board's, each linked; a row per project", async () => {
    const { h, item } = await lists();
    item('main', 'parked');
    item('main', 'parked');
    item('ref', 'ready');
    item('ref', 'pr_open');
    const running = item('ref', 'ready');
    const merged = item('main', 'done');
    drop(h, 'live-ref', 'running', 'ref', undefined, running.id);
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
    merge('m-failed', 'failed', 1);
    const home = (await h.view('/')).body;
    const board = (await h.view('/activity')).body;
    const pipeline = home.slice(home.indexOf('id="pipeline"'));
    const tile = (key: string) => {
      const m = pipeline.match(
        new RegExp(`<a class="tile" data-tile="${key}" href="([^"]*)"><b[^>]*>([^<]*)</b>`),
      );
      return m ? { href: m[1], n: m[2] } : undefined;
    };
    const column = (key: string) =>
      board.match(
        new RegExp(`data-column="${key}"><h3>[^<]*<span class="count">([^<]*)</span>`),
      )?.[1];
    const expected = {
      ready: ['/activity/work?state=ready', '1'],
      running: ['/activity/drops?state=active&amp;kind=all', '1'],
      'in-review': ['/activity/work?state=pr_open', '1'],
      parked: ['/activity/work?state=parked', '2'],
      merged: ['/activity/work?state=done', '1'],
    } as const;
    for (const [key, [href, n]] of Object.entries(expected)) {
      expect(tile(key), key).toEqual({ href, n });
      expect(column(key), key).toBe(n);
      const list = await h.view(href.replaceAll('&amp;', '&'));
      expect(list.statusCode, href).toBe(200);
    }
    // A row per project: the failed merge counts as blocked on main, which comes first.
    expect(home).toContain('1 forge write unknown or failed');
    expect(home.indexOf('data-zone="main"')).toBeLessThan(home.indexOf('data-zone="ref"'));
    expect(home).toContain('data-state="blocked" data-zone="main"');
    expect(home).toContain('data-state="working" data-zone="ref"');
    expect(home).toContain('<a href="/projects/ref">octo/ref</a>');
    for (const gone of ['<h2>Work items</h2>', '<h2>Drops</h2>', '<h2>Drop zones</h2>'])
      expect(home).not.toContain(gone);
  });

  test('anonymous: /work and /drops are refused as / is', async () => {
    const { h } = await lists();
    const anon = async (url: string) => (await h.app.inject({ method: 'GET', url })).statusCode;
    const briefings = await anon('/');
    expect(briefings).not.toBe(200);
    expect(await anon('/activity/work')).toBe(briefings);
    expect(await anon('/activity/drops')).toBe(briefings);
  });

  test('the floor links its counts to the list pages, and the nav has Work and Drops', async () => {
    const { h } = await lists();
    const home = (await h.view('/')).body;
    expect(home).toContain('href="/activity/work?state=ready"');
    expect(home).toContain('href="/activity/drops?state=active&amp;kind=all"');
    expect(home).toMatch(
      /<nav class="topnav"[^>]*>.*<a href="\/activity" data-area="activity">Activity<\/a>.*<\/nav>/,
    );
  });
});

describe('external links open in a new tab, in-app links do not (#133)', () => {
  test('a sweep over /, /work, /drops, /briefings and /projects/<id>/setup', async () => {
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
    for (const url of ['/', '/activity/work', '/activity/drops', '/projects/main/setup']) {
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
    const res = await h.view('/system/sticks');
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
    // Linked from the System sub-nav, Sticks current (#623), and from the floor's Sticks summary.
    expect(html).toMatch(/<nav class="topnav"[^>]*>.*<a href="\/system"[^>]*>System<\/a>.*<\/nav>/);
    expect(html).toContain('<a href="/system/sticks" aria-current="page">Sticks</a>');
    const home = (await h.view('/')).body;
    expect(home).toMatch(/<div id="sticks">.*<a href="\/system\/sticks">Manage sticks<\/a>/);
  });

  test('anonymous: /sticks is refused as /work is', async () => {
    const h = await harness();
    const anon = async (url: string) => (await h.app.inject({ method: 'GET', url })).statusCode;
    const work = await anon('/activity/work');
    expect(work).not.toBe(200);
    expect(await anon('/system/sticks')).toBe(work);
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
    const html = (await h.view('/system/sticks')).body;
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
    expect((await h.view('/system/sticks')).body).toContain('Running now: 0 of 6');
  });
});

describe('route classes (crew chat, #349)', () => {
  test("routeClass('/mcp/chat') is 'chat-mcp', and /mcp is still 'mcp'", () => {
    expect(routeClass('/mcp/chat')).toBe('chat-mcp');
    expect(routeClass('/mcp')).toBe('mcp');
    expect(routeClass('/mcp/chat/x')).toBe('page');
  });
});

describe("this session's pending guarded changes under Waiting on you (#507)", () => {
  const OPERATOR = { authorization: `Bearer ${'o'.repeat(32)}`, host: 'localhost:80' };
  /** How many guarded-change rows Home's Needs you lists. */
  const needsYou = (body: string) =>
    String(body.match(/<li class="needs-row" data-kind="change">/g)?.length ?? 0);

  async function staged() {
    const h = await harness({ live: true, zone: { protectedPaths: [...DEFAULT_PROTECTED_PATHS] } });
    const store = h.store;
    if (!store) throw new Error('no store');
    const a = operatorSession(h.db, h.now());
    const b = operatorSession(h.db, h.now());
    const stage = (sid: string, consequence: string, secret: string) =>
      store.confirmations.addPending({
        sessionIdHash: sha256Hex(sid),
        patch: { pollSeconds: 30, secret },
        expectRevision: store.revision(),
        meta: { via: 'ui' } as never,
        guarded: [{ path: 'mcp.enabled', consequence }],
        notes: [],
      });
    return { h, a, b, stage };
  }

  test("D1: session A's floor lists A's pending change; session B's neither lists nor counts it", async () => {
    const { h, a, b, stage } = await staged();
    const p = stage(a.id, 'Turns on the MCP server for A', 'PATCH-SECRET-A');
    const mine = (await h.view('/', { cookie: a.cookie })).body;
    expect(mine).toContain('Turns on the MCP server for A');
    expect(mine).toContain(`<a href="/config/confirm/${p.id}">Review and confirm</a>`);
    expect(mine).toMatch(/expires <span data-live-ignore><time [^>]*>in 10 min<\/time>/);
    expect(mine).not.toContain('PATCH-SECRET-A');
    expect(needsYou(mine)).toBe('1');
    const card = mine.slice(mine.indexOf('id="waiting-on-you"'));
    expect(card.slice(0, card.indexOf('</section>'))).toContain(
      `<a href="/config/confirm/${p.id}">Review and confirm</a>`,
    );
    const theirs = (await h.view('/', { cookie: b.cookie })).body;
    expect(theirs).not.toContain('Turns on the MCP server for A');
    expect(theirs).not.toContain(p.id);
    expect(needsYou(theirs)).toBe('0');
    expect(theirs).toContain('Nothing needs you');
  });

  test('a control-token request to / lists none', async () => {
    const { h, a, stage } = await staged();
    const p = stage(a.id, 'Turns on the MCP server for A', 'PATCH-SECRET-A');
    // Pages take a session only: a token alone is sent to log in, and is shown no pending change.
    const res = await h.app.inject({ method: 'GET', url: '/', headers: OPERATOR });
    expect(res.statusCode).toBe(302);
    expect(res.body).not.toContain('Turns on the MCP server for A');
    expect(res.body).not.toContain(p.id);
    expect(res.body).not.toContain('Review and confirm');
  });

  test('a chat-staged change says "from chat:" with the thread link; a settings-staged one does not', async () => {
    const { h, a, stage } = await staged();
    const fromChat = stage(a.id, 'Chat change', 's1');
    const fromSettings = stage(a.id, 'Settings change', 's2');
    const th = createThread(h.db, { title: 'Tune main' }, h.now());
    const msg = appendMessage(h.db, th.id, { role: 'owner', text: 'x', state: 'done' }, h.now());
    recordCard(
      h.db,
      {
        threadId: th.id,
        messageId: msg.id,
        kind: 'setting',
        state: 'pending',
        link: `/config/confirm/${fromChat.id}`,
        summary: 'Turn on MCP',
        undo: { paths: ['mcp.enabled'], what: 'MCP' },
      },
      h.now(),
    );
    const body = (await h.view('/', { cookie: a.cookie })).body;
    const row = (id: string) =>
      [...body.matchAll(/<li class="needs-row" data-kind="change">.*?<\/li>/g)]
        .map((m) => m[0])
        .find((r) => r.includes(`/config/confirm/${id}"`)) ?? '';
    expect(row(fromChat.id)).toContain(`from chat: <a href="/chat/${th.id}">Tune main</a>`);
    expect(row(fromSettings.id)).toContain('Settings change');
    expect(row(fromSettings.id)).not.toContain('from chat:');
    expect(row(fromSettings.id)).not.toContain('/chat/');
    // Oldest first.
    expect(body.indexOf('Chat change')).toBeLessThan(body.indexOf('Settings change'));
    expect(needsYou(body)).toBe('2');
  });
});

describe('project pages live under /projects (issue #615)', () => {
  /** A seeded store install: the zone `jm` with a drop in flight, and a second zone. */
  async function seeded() {
    const h = await harness({
      live: true,
      zone: { id: 'jm', protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
      extraZones: [
        { id: 'ref', repo: 'octo/ref', protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
      ],
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
    await toPrOpen(h, '7368613100000000000000000000000000000000');
    await h.reconcile();
    return h;
  }
  const PROJECT_PAGES = ['', '/setup', '/goals', '/issues/new', '/flags', '/work'];

  test.each(PROJECT_PAGES)(
    '/projects/<id>%s is 200 for a known zone and 404 for an unknown one',
    async (sub) => {
      const h = await seeded();
      expect((await h.view(`/projects/jm${sub}`)).statusCode).toBe(200);
      expect((await h.view(`/projects/nope${sub}`)).statusCode).toBe(404);
    },
  );

  test.each(PROJECT_PAGES)('/projects/jm%s carries the project header and tab bar', async (sub) => {
    const h = await seeded();
    const body = (await h.view(`/projects/jm${sub}`)).body;
    expect(body).toContain('<nav class="settings-tabs project-tabs" aria-label="Project tabs">');
    expect(body).toContain('<header class="project-header">');
    expect(body).toContain('href="/projects/jm/issues/new">New issue</a>');
  });

  test('/projects and /projects/new are 200', async () => {
    const h = await seeded();
    expect((await h.view('/projects')).statusCode).toBe(200);
    expect((await h.view('/projects/new')).statusCode).toBe(200);
  });

  test('the top bar and the list say Projects; a project is one repository', async () => {
    const h = await seeded();
    const list = (await h.view('/projects')).body;
    expect(list).toContain(
      '<a href="/projects" aria-current="page" data-area="projects">Projects</a>',
    );
    expect(list).not.toContain('>Zones</a>');
    expect(list).toContain('<h2>Projects</h2>');
    expect(list).toContain('<p>A project is one repository Jumpmaster works on.</p>');
    expect(list).not.toContain('<h2>Zones</h2>');
  });

  test('a sweep: no rendered page links to a /zones page path', async () => {
    const h = await seeded();
    const seen = new Set<string>();
    for (const url of [
      '/',
      '/projects',
      '/projects/jm',
      '/projects/jm/goals',
      '/projects/jm/setup',
      '/projects/jm/work',
      '/activity',
      '/activity/work',
      '/activity/drops',
      '/system',
      '/system/credentials',
      '/system/advanced',
    ]) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBe(200);
      const hrefs = [...res.body.matchAll(/\bhref="([^"]*)"/g)].map((m) => m[1] ?? '');
      expect(hrefs.length, url).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href.startsWith('/zones'), `${url} links ${href}`).toBe(false);
        // The GitHub guide moved into Setup (#618): links go to its section, not the old page.
        expect(href, `${url} links ${href}`).not.toMatch(/^\/projects\/[^/]+\/github\b/);
        // A project's work moved under it (#619): no link to /work/<zone>/… or /work?zone=.
        expect(href, `${url} links ${href}`).not.toMatch(/^\/work\/[^/?#]/);
        expect(href, `${url} links ${href}`).not.toMatch(/^\/work\?(.*&(amp;)?)?zone=/);
        // The cross-project lists moved under Activity (#622).
        expect(href, `${url} links ${href}`).not.toMatch(/^\/(work|drops)(\?|$)/);
        // The stub builder moved into Goals (#620): links go to its section.
        expect(href, `${url} links ${href}`).not.toMatch(/^\/projects\/[^/]+\/intake\b/);
        seen.add(/#(github|goal-stub)$/.test(href) ? href : href.replace(/#.*$/, ''));
      }
      // Nor any page path in a script or a form target: only the API keeps /zones.
      expect(res.body.replaceAll('/api/control/zones', ''), url).not.toMatch(/["'`]\/zones\b/);
    }
    // Non-vacuous: the pages did render the hand-written project links the sweep guards.
    for (const href of [
      '/projects',
      '/projects/jm',
      '/projects/jm/setup#github',
      '/projects/jm/goals',
      '/projects/jm/issues/new',
      '/projects/jm/flags',
      '/projects/jm/setup',
      '/projects/ref/flags',
      '/projects/jm/work',
    ])
      expect(seen, href).toContain(href);
    // Non-vacuous for work items: a rendered page linked one, under its project.
    expect([...seen].some((x) => /^\/projects\/jm\/work\/[1-9]\d*$/.test(x))).toBe(true);
  });
});

describe("a project's Work tab (#619)", () => {
  async function seeded() {
    const h = await harness({ zone: { id: 'jm' }, extraZones: [{ id: 'ref', repo: 'octo/ref' }] });
    for (const z of [h.zone, { id: 'ref', repo: 'octo/ref' }])
      upsertDropZone(h.db, { id: z.id, repo: z.repo, defaultBranch: 'main', configJson: '{}' });
    const item = (zoneId: string, n: number, state: WorkItemState, title: string) => {
      const w = upsertWorkItem(
        h.db,
        {
          dropZoneId: zoneId,
          issueNumber: n,
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
    item('jm', 487, 'ready', 'jm ready one');
    item('jm', 488, 'parked', 'jm parked one');
    item('jm', 489, 'done', 'jm done one');
    item('ref', 487, 'ready', 'ref ready one');
    return h;
  }

  test('/projects/jm/work lists only jm’s items, with the tab bar (Work current) and New issue', async () => {
    const h = await seeded();
    const res = await h.view('/projects/jm/work');
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain('jm ready one');
    expect(body).toContain('jm parked one');
    expect(body).not.toContain('jm done one');
    expect(body).not.toContain('ref ready one');
    expect(body).toContain('<nav class="settings-tabs project-tabs" aria-label="Project tabs">');
    expect(body).toContain('<a href="/projects/jm/work" aria-current="page">Work</a>');
    expect(body).toContain('href="/projects/jm/issues/new">New issue</a>');
    // New issue sits at the top: in the header, before the list.
    expect(body.indexOf('>New issue</a>')).toBeLessThan(body.indexOf('jm ready one'));
    // The same state filters as /work, on the project's own path; no project filter.
    expect(body).toContain('<a href="/projects/jm/work" aria-current="page">Active</a>');
    for (const s of ['ready', 'in_flight', 'pr_open', 'parked', 'done'])
      expect(body).toContain(`href="/projects/jm/work?state=${s}"`);
    expect(body).not.toContain('aria-label="Project"><p>');
    expect(body).toContain('<a href="/projects/jm/work/487">jm ready one</a>');
  });

  test('/projects/jm/work?state=parked filters', async () => {
    const h = await seeded();
    const res = await h.view('/projects/jm/work?state=parked');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('jm parked one');
    expect(res.body).not.toContain('jm ready one');
    expect(res.body).toContain(
      '<a href="/projects/jm/work?state=parked" aria-current="page">Parked</a>',
    );
    const done = (await h.view('/projects/jm/work?state=done')).body;
    expect(done).toContain('jm done one');
    expect(done).not.toContain('jm parked one');
  });

  test('/projects/jm/work/487 renders the item with the project header and tab bar', async () => {
    const h = await seeded();
    const res = await h.view('/projects/jm/work/487');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('jm ready one');
    expect(res.body).not.toContain('ref ready one');
    expect(res.body).toContain('<header class="project-header">');
    expect(res.body).toContain('<a href="/projects/jm/work" aria-current="page">Work</a>');
    expect(res.body).toContain('<h3>Attempts</h3>');
  });

  test.each([
    '/projects/nope/work',
    '/projects/nope/work/487',
    '/projects/jm/work/999',
    '/projects/jm/work/0',
    '/projects/jm/work/x',
    '/projects/jm/work?state=bogus',
  ])('%s is 404', async (url) => {
    const h = await seeded();
    expect((await h.view(url)).statusCode).toBe(404);
  });

  test('/work’s rows and project filters link straight to the project pages', async () => {
    const h = await seeded();
    const body = (await h.view('/activity/work')).body;
    expect(body).toContain('<a href="/projects/jm/work/487">jm ready one</a>');
    expect(body).toContain('<a href="/projects/ref/work/487">ref ready one</a>');
    expect(body).toContain('href="/projects/ref/work">octo/ref</a>');
  });
});

describe('the Log (#621)', () => {
  /** A project with an observe decision on its issue 1 and a ruling, a minute apart. */
  async function logged() {
    const h = await harness({});
    await h.sync();
    const item = listWorkItems(h.db, 'main')[0];
    if (!item) throw new Error('no item');
    const at = h.now();
    const before = new Date(at.getTime() - 60_000);
    recordObservation(h.db, 'main', item.id, 'would_enqueue:implement', 'issue #1', before);
    const b = raiseBriefing(
      h.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:log',
        decision: 'Log it?',
        why: 'w',
        options: [
          { id: 'o1', label: 'Yes', effect: 'none' },
          { id: 'o2', label: 'No', effect: 'none' },
        ],
        source: 'crew',
      },
      at,
    );
    const r = ruleBriefing(h.db, b, 'o2', 'ruled in the log', at);
    if (!r.ok) throw new Error('not ruled');
    return { h, b, rulingId: r.rulingId, item };
  }
  const rowsOf = (html: string) => html.match(/<tr class="log-[a-z]+">.*?<\/tr>/g) ?? [];

  test('/projects/main/log shows both kinds newest first, with the Log tab current', async () => {
    const { h, b } = await logged();
    const res = await get(h, '/projects/main/log');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/projects/main/log" aria-current="page">Log</a>');
    const rows = rowsOf(res.body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(`<a href="/briefings/${b}">Briefing ${b}</a>`);
    expect(rows[0]).toContain('ruled in the log');
    expect(rows[1]).toContain('Would start implementing <a href="/projects/main/work/1">#1</a>');
  });

  test('/projects/main/log?kind=rulings shows only rulings', async () => {
    const { h, rulingId } = await logged();
    const res = await get(h, '/projects/main/log?kind=rulings');
    expect(res.statusCode).toBe(200);
    const rows = rowsOf(res.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^<tr class="log-ruling">/);
    expect(rows[0]).toContain(`Ruling ${rulingId}</a>`);
    expect(res.body).not.toContain('start implementing');
    expect(res.body).toContain('aria-current="page">Rulings</a>');
    const observed = rowsOf((await get(h, '/projects/main/log?kind=observed')).body);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatch(/^<tr class="log-observed">/);
  });

  test("/activity/log?project=main equals the project tab's rows", async () => {
    const { h } = await logged();
    for (const kind of ['', 'kind=rulings', 'kind=observed']) {
      const tab = rowsOf((await get(h, `/projects/main/log${kind ? `?${kind}` : ''}`)).body);
      const global = await get(h, `/activity/log?project=main${kind ? `&${kind}` : ''}`);
      expect(global.statusCode).toBe(200);
      expect(tab.length).toBeGreaterThan(0);
      expect(rowsOf(global.body)).toEqual(tab);
    }
    // Unfiltered, the same entries carry a Project column.
    const all = await get(h, '/activity/log');
    expect(all.body).toContain('<th>Project</th>');
    expect(rowsOf(all.body)).toHaveLength(2);
    expect(rowsOf(all.body)[0]).toContain('<td>octo/demo</td>');
  });

  test('an unknown project or kind is a 404', async () => {
    const { h } = await logged();
    for (const url of [
      '/activity/log?project=nope',
      '/activity/log?kind=nope',
      '/projects/nope/log',
      '/projects/main/log?kind=nope',
    ])
      expect((await get(h, url)).statusCode, url).toBe(404);
  });
});

describe('the Activity board (#622)', () => {
  async function board() {
    const h = await harness({ extraZones: [{ id: 'ref', repo: 'octo/ref' }] });
    for (const z of [h.zone, { id: 'ref', repo: 'octo/ref' }])
      upsertDropZone(h.db, { id: z.id, repo: z.repo, defaultBranch: 'main', configJson: '{}' });
    let n = 200;
    const item = (zoneId: string, state: WorkItemState, title: string) => {
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
    const merged = (zoneId: string, title: string, hoursAgo: number) => {
      const w = item(zoneId, 'done', title);
      const at = new Date(h.now().getTime() - hoursAgo * 3_600_000);
      const key = `merge-${w.id}`;
      insertOutbox(h.db, {
        id: key,
        opKey: key,
        kind: 'merge',
        workItemId: w.id,
        zoneId,
        payloadJson: '{}',
        state: 'pending',
        createdAt: at.toISOString(),
      });
      updateOutbox(h.db, key, { state: 'done' }, at);
      return w;
    };
    return { h, item, merged };
  }
  /** Each column's card titles, by its data-column key. */
  const columns = (html: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const m of html.matchAll(
      /<section class="board-col" data-column="([a-z-]+)">(.*?)<\/section>/g,
    ))
      out[m[1] ?? ''] = [
        ...(m[2] ?? '').matchAll(
          /<article class="board-card"[^>]*>.*?<a href="[^"]*">#\d+ ([^<]*)<\/a>/g,
        ),
      ].map((c) => c[1] ?? '');
    return out;
  };

  test('/activity has the sub-nav and five columns, each with its seeded item', async () => {
    const { h, item, merged } = await board();
    item('main', 'ready', 'a ready one');
    const running = item('main', 'in_flight', 'a running one');
    insertDrop(h.db, {
      id: 'run-1',
      dropZoneId: 'main',
      workItemId: running.id,
      role: 'implement',
      state: 'running',
      createdAt: h.now().toISOString(),
    });
    item('ref', 'pr_open', 'a reviewed one');
    item('main', 'parked', 'a parked one');
    merged('main', 'merged an hour ago', 1);
    merged('main', 'merged 25 hours ago', 25);
    const res = await get(h, '/activity');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(
      '<nav class="subnav" aria-label="Activity"><p><a href="/activity" aria-current="page">Board</a> · <a href="/activity/work">Work</a> · <a href="/activity/drops">Drops</a> · <a href="/activity/log">Log</a></p></nav>',
    );
    const cols = columns(res.body);
    expect(Object.keys(cols)).toEqual(['ready', 'running', 'in-review', 'parked', 'merged']);
    const titles = (k: string) => (cols[k] ?? []).filter((t) => !t.startsWith('Issue '));
    expect(titles('ready')).toEqual(['a ready one']);
    expect(titles('running')).toEqual(['a running one']);
    expect(titles('in-review')).toEqual(['a reviewed one']);
    expect(titles('parked')).toEqual(['a parked one']);
    expect(titles('merged')).toEqual(['merged an hour ago']);
    // The 25-hour-old merge is in no column.
    expect(Object.values(cols).flat()).not.toContain('merged 25 hours ago');
    expect(res.body).not.toContain('merged 25 hours ago');
    // A card names its project and links its work-item page.
    expect(res.body).toMatch(
      /octo\/ref<\/span> <a href="\/projects\/ref\/work\/\d+">#\d+ a reviewed one<\/a>/,
    );
    // Project filter links across the top.
    expect(res.body).toContain('<a href="/activity?project=ref">octo/ref</a>');
    const ref = columns((await get(h, '/activity?project=ref')).body);
    expect(Object.values(ref).flat()).toEqual(['a reviewed one']);
    expect((await get(h, '/activity?project=nope')).statusCode).toBe(404);
  });

  test('a column with 25 items shows 20 cards and "and 5 more" to the filtered list', async () => {
    const { h, item } = await board();
    for (let i = 0; i < 25; i++) item('main', 'parked', `parked ${i}`);
    const body = (await get(h, '/activity')).body;
    expect(columns(body).parked).toHaveLength(20);
    expect(body).toContain('data-column="parked"><h3>Parked <span class="count">25</span></h3>');
    expect(body).toContain('<a href="/activity/work?state=parked">and 5 more</a>');
    const main = (await get(h, '/activity?project=main')).body;
    expect(main).toContain('<a href="/projects/main/work?state=parked">and 5 more</a>');
  });

  test('/activity/drops?kind=crew behaves as /drops?kind=crew did', async () => {
    const { h, item } = await board();
    const w = item('main', 'in_flight', 'issue work');
    insertDrop(h.db, {
      id: 'crew-drop-1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'succeeded',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    insertDrop(h.db, {
      id: 'work-drop-1',
      dropZoneId: 'main',
      workItemId: w.id,
      role: 'implement',
      state: 'succeeded',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await get(h, '/activity/drops?kind=crew');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/drops/crew-drop-1"');
    expect(res.body).not.toContain('href="/drops/work-drop-1"');
    expect(res.body).toContain('<a href="/activity/drops?kind=crew" aria-current="page">Crew</a>');
    expect(res.body).toContain('aria-label="Activity"');
    const work = await get(h, '/activity/work?state=in_flight');
    expect(work.statusCode).toBe(200);
    expect(work.body).toContain('issue work');
    expect(work.body).toContain('<a href="/activity/work" aria-current="page">Work</a>');
  });

  test('a sweep: no rendered href is the old /work or /drops list', async () => {
    const { h, item } = await board();
    const w = item('main', 'parked', 'swept');
    insertDrop(h.db, {
      id: 'sweep-1',
      dropZoneId: 'main',
      workItemId: w.id,
      role: 'implement',
      state: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    let checked = 0;
    for (const url of [
      '/',
      '/activity',
      '/activity/work',
      '/activity/drops',
      '/activity/log',
      '/drops/sweep-1',
      `/projects/main/work/${w.issueNumber}`,
      '/system',
    ]) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBe(200);
      for (const m of res.body.matchAll(/\bhref="([^"]*)"/g)) {
        const href = m[1] ?? '';
        checked++;
        expect(href, `${url} links ${href}`).not.toMatch(/^\/(work|drops)(\?|$)/);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('the System area (#623)', () => {
  const PAGES: [string, string][] = [
    ['/system', 'Health'],
    ['/system/sticks', 'Sticks'],
    ['/system/credentials', 'Credentials'],
    ['/system/server', 'Server'],
    ['/system/mcp-tokens', 'MCP tokens'],
    ['/system/history', 'History'],
    ['/system/advanced', 'Advanced'],
  ];
  const system = () =>
    harness({
      live: true,
      zone: { protectedPaths: ['.github/**', 'CODEOWNERS', 'GOAL.md'] },
    });
  /** The System sub-nav of a page: its links in order, and the one marked current. */
  const subnav = (html: string) => {
    const at = html.indexOf('<nav class="subnav" aria-label="System">');
    const nav = at === -1 ? '' : html.slice(at, html.indexOf('</nav>', at));
    return {
      count: html.split('<nav class="subnav" aria-label="System">').length - 1,
      links: [...nav.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]),
      current: [...nav.matchAll(/<a href="([^"]*)" aria-current="page">([^<]*)<\/a>/g)].map((m) => [
        m[1],
        m[2],
      ]),
    };
  };

  test.each(PAGES)('%s answers 200 with the System sub-nav, %s current', async (url, label) => {
    const h = await system();
    const res = await h.view(url);
    expect(res.statusCode).toBe(200);
    const nav = subnav(res.body);
    expect(nav.count).toBe(1);
    expect(nav.links).toEqual(PAGES.map(([href, l]) => [href, l]));
    expect(nav.current).toEqual([[url, label]]);
    // The settings tab strip is gone.
    expect(res.body).not.toContain('settings-tabs"');
  });

  test('Health is the doctor page, titled Health, and the top nav links System', async () => {
    const h = await system();
    const body = (await h.view('/system')).body;
    expect(body).toContain('<title>Jumpmaster: Health</title>');
    expect(body).toContain('<h2>Health</h2>');
    expect(body).toContain('data-doctor="/api/control/doctor"');
    expect(body).toMatch(/<nav class="topnav"[^>]*>.*<a href="\/system"[^>]*>System<\/a>.*<\/nav>/);
  });

  test('Zone problems is on Health, once and above the check table, and not on Credentials', async () => {
    const h = await system();
    const count = (html: string, s: string) => html.split(s).length - 1;
    const health = (await h.view('/system')).body;
    const credentials = (await h.view('/system/credentials')).body;
    expect(count(health, 'Project problems')).toBe(1);
    expect(count(credentials, 'Project problems')).toBe(0);
    // Above the check table, once a run has one.
    h.db
      .prepare(
        "INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)",
      )
      .run(JSON.stringify([{ id: 'config.uid', zoneId: null, status: 'fail', summary: 'bad' }]));
    const ran = (await h.view('/system')).body;
    const table = ran.indexOf('<th>Status</th>');
    expect(table).toBeGreaterThan(-1);
    expect(ran.indexOf('<h3>Project problems</h3>')).toBeGreaterThan(-1);
    expect(ran.indexOf('<h3>Project problems</h3>')).toBeLessThan(table);
    expect(count(ran, 'Project problems')).toBe(1);
  });

  test('Server is the install settings followed by Other machines', async () => {
    const h = await system();
    const body = (await h.view('/system/server')).body;
    const install = body.indexOf('<form id="install"');
    const other = body.indexOf('<h3 id="other-machines">Other machines</h3>');
    expect(install).toBeGreaterThan(-1);
    expect(other).toBeGreaterThan(install);
    expect(body).toContain('<form id="public-url-form"');
    // The install script finds its form by id: no other element may carry it.
    expect(body.split('id="install"').length - 1).toBe(1);
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("/system/sticks/images is the Sticks area's Images tab, Sticks current in the sub-nav (#624)", async () => {
    const h = await system();
    const res = await h.view('/system/sticks/images');
    expect(res.statusCode).toBe(200);
    expect(subnav(res.body).current).toEqual([['/system/sticks', 'Sticks']]);
    expect(res.body).toContain('<a href="/system/sticks/images" aria-current="page">Images</a>');
    expect(res.body).toContain('<h2>Images</h2>');
    // The sticks page links it, and holds no image rows.
    const sticks = (await h.view('/system/sticks')).body;
    expect(sticks).toContain('<a href="/system/sticks/images">Images</a>');
    expect(sticks).not.toContain('data-image=');
  });

  test('a form on /system/sticks posts to /system/sticks/add', async () => {
    const h = await system();
    const body = (await h.view('/system/sticks')).body;
    // With no public address the page says how to set one instead of offering the form.
    expect(body).toContain('href="/system/server#other-machines"');
    const html = renderSticks({
      sticks: [],
      zones: [],
      now: new Date(),
      publicUrl: 'https://jm.example',
    });
    const forms = [...html.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    expect(forms).toContain('<form id="add-stick" method="post" action="/system/sticks/add">');
    // The form's script posts there too.
    expect(body).toContain("jmSticks('/system/sticks/add'");
    expect(body).not.toContain("'/sticks/add'");
  });

  test('a sweep: no rendered href or form action starts with /settings, /doctor or /sticks', async () => {
    const h = await system();
    let checked = 0;
    for (const url of [
      '/',
      '/activity',
      '/projects',
      `/projects/${h.zone.id}`,
      `/projects/${h.zone.id}/setup`,
      ...PAGES.map(([u]) => u),
    ]) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBe(200);
      for (const m of res.body.matchAll(/\b(?:href|action)="([^"]*)"/g)) {
        const target = m[1] ?? '';
        checked++;
        expect(target, `${url} links ${target}`).not.toMatch(/^\/(settings|doctor|sticks)\b/);
      }
      // Nor a script's page path: only the API keeps these words.
      expect(res.body, url).not.toMatch(/["'`]\/(settings|doctor|sticks)\b/);
    }
    expect(checked).toBeGreaterThan(50);
  });
});
