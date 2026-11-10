import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { raiseBriefing, ruleBriefing } from '../briefings.js';
import { DEFAULT_PROTECTED_PATHS } from '../config.js';
import { insertCrewIssue } from '../crew/store.js';
import { insertDrop, insertStick, updateDrop } from '../db/repo.js';
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
    expect(html).toMatch(/m3-stick<\/td>.*cannot run main: lacks egress-v1/);
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
    // This build's pages, as the doctor route derives them: Task 9 adds the Credentials tab and
    // Task 11 the zones page.
    const pages = pagesOf(h.app);
    expect(pages).toEqual({ ...PAGES_M45A, credentials: true, zones: true });
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
