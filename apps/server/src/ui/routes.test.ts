import { describe, expect, test } from 'vitest';
import { raiseBriefing, ruleBriefing } from '../briefings.js';
import { insertCrewIssue } from '../crew/store.js';
import { insertDrop, insertStick, updateDrop } from '../db/repo.js';
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
