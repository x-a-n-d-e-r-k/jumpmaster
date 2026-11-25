import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';
import { neededCredentialError } from '../api/secrets.js';
import { raiseBriefing } from '../briefings.js';
import { recordCard } from '../chat/cards.js';
import { appendMessage, createThread } from '../chat/store.js';
import { GUARDED_PATHS, type GuardCtx, REFUSED_PATHS } from '../config/guarded.js';
import { LEGACY_READY_LABEL } from '../config/ready-label.js';
import { ZONE_HISTORY_ISSUE } from '../config/store.js';
import { type ConfigIssue, parseEditable } from '../config.js';
import { type Drop, insertDrop, setZoneMode, stampStick, type WorkItem } from '../db/repo.js';
import { type DoctorCheck, SHADOWED_TOKEN_FIX } from '../doctor/checks.js';
import { INTAKE_LIMIT_ERROR } from '../intake.js';
import { modeCardSummary, refusedCardSummary } from '../mcp/chat-actions.js';
import { applyRefusal, DISCOVER_PATH, INSTALLED_PATH } from '../setup/github-app-installed.js';
import { type StatusInput, type StatusZone, statusOf } from '../status.js';
import { ago, world } from '../test/doctorWorld.js';
import { makeZone } from '../test/fixtures.js';
import { harness } from '../test/flowHarness.js';
import { operatorSession, plus, t0 } from '../test/helpers.js';
import { visibleText } from '../test/visible-text.js';
import { FORM_SCRIPT } from '../zones/form.js';
import { FLAGS_SCRIPT } from './flags.js';
import { gitlabSection } from './github.js';
import { codeHtml, ISSUE_SCRIPT } from './pages.js';
import { CONFIG_ANSWER_FN } from './setting-controls.js';
import { CREDENTIALS_SCRIPT, HISTORY_SCRIPT, OTHER_MACHINES_SCRIPT } from './settings.js';
import { fixHtml, projectBody } from './setup.js';
import { projectWords } from './zone-name.js';
import { ISSUES_SCRIPT } from './zones.js';

export { visibleText };

const ZONE_WORD = /\bzones?\b/i;
const FLOOR_WORD = /\bFloor\b/;

/** Each offending match with some context around it, so a failure names the sentence. */
function offenders(text: string): string[] {
  const out: string[] = [];
  for (const re of [new RegExp(ZONE_WORD, 'gi'), new RegExp(FLOOR_WORD, 'g')])
    for (const m of text.matchAll(re))
      out.push(text.slice(Math.max(0, m.index - 60), m.index + 60).trim());
  return out;
}

describe('visibleText', () => {
  test('drops tags, attribute values, code, pre, script and style', () => {
    const html = `<p title="zone">Run <code>jumpmaster ctl zones list</code> for the
      <a href="/zones/x" data-zone="main">project</a></p><pre>zone: main</pre>
      <script>const zone = 1;</script><style>.zone{}</style><!-- zone -->`;
    expect(visibleText(html)).toBe(' Run for the project ');
    expect(offenders(visibleText(html))).toEqual([]);
  });

  test('keeps text that says zone', () => {
    expect(offenders(visibleText('<p>The zone is paused</p><h2>Floor</h2>'))).toHaveLength(2);
  });
});

const PROTECTED = ['.github/**', 'CODEOWNERS', 'GOAL.md'];
const PATCH_NEEDING_CONFIRMATION = {
  dropZones: [
    { id: 'main', ciRequired: false },
    { id: 'merlin', identity: 'starter' },
  ],
};

/**
 * Real doctor findings, not hand-written ones: the doctor run on installs set up so that each
 * check whose fix names the project's own settings fails or warns.
 */
/** A project as a config file states it, valid but for what a test sets. */
const fileZone = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  repo: `octo/${id}`,
  image: 'ghcr.io/octo/drop:1',
  gates: [],
  protectedPaths: PROTECTED,
  ...o,
});

/** The validator's own issues for an invalid file: a starter without CI, a duplicate id. */
function invalidFileIssues(): ConfigIssue[] {
  const starter = parseEditable(
    { dropZones: [fileZone('a', { identity: 'starter', ciRequired: false })] },
    { devImages: true },
  );
  const twin = parseEditable({ dropZones: [fileZone('a'), fileZone('a')] }, { devImages: true });
  const issues = [
    ...('issues' in starter ? starter.issues : []),
    ...('issues' in twin ? twin.issues : []),
  ];
  // Non-vacuous: these are the messages that say zone.
  expect(issues.map((i) => i.message).join('\n')).toMatch(
    /starter zone requires ciRequired[\s\S]*duplicate zone id/,
  );
  return issues;
}

async function doctorFindings(): Promise<DoctorCheck[]> {
  const worlds = [
    // No gates (zone.preset), authorMayBeAdmin for a non-admin (forge.admin).
    world({ zone: { gates: [], authorMayBeAdmin: true } }),
    // The repository looks like node, the project says python (zone.preset).
    world({ zone: { preset: 'python' } }),
    // Starter mode (zone.identity), with a ruleset still asking for an approval.
    (() => {
      const w = world({ zone: { identity: 'starter' } });
      const r = w.f.state.rules.author;
      if (r.kind === 'ok') r.rules.requiredApprovals = 1;
      return w;
    })(),
    // No CI workflow and no required check under ciRequired (forge.ci, forge.branch-rules).
    (() => {
      const w = world();
      w.f.state.dirs.delete('main:.github/workflows');
      for (const id of ['author', 'reviewer'] as const) {
        const r = w.f.state.rules[id];
        if (r.kind === 'ok') r.rules.requiredChecks = [];
      }
      return w;
    })(),
    // The only stick lacks egress-v1 under egress enforce (stick.capabilities).
    (() => {
      const w = world();
      stampStick(
        w.db,
        's1',
        {
          capabilities: ['image-verify-v1', 'push-v1'],
          imagePolicy: 'signed',
          version: '0.4.0',
          pinnedImages: [],
        },
        ago(10_000),
      );
      return w;
    })(),
    // A private repository with a read token but no reviewReadToken (forge.private-clone).
    (() => {
      const w = world({ readToken: true });
      w.f.state.access.author.private = true;
      return w;
    })(),
    // A missing credential (credential.missing).
    (() => {
      const w = world();
      w.deps.credentials = {
        problems: [
          {
            zoneId: 'main',
            kind: 'missing',
            credential: 'claudeToken' as never,
            message: 'no Claude token is set',
          },
        ],
        shadowed: [],
        vaultKey: { status: 'empty' },
      };
      return w;
    })(),
    // A config file the last reload refused, with the validator's own messages (config.file).
    (() => {
      const w = world();
      w.deps.configStatus = {
        mode: 'file',
        filePath: '/config/jm.json',
        revision: 4,
        restartPending: [],
        fileProblem: invalidFileIssues(),
      };
      return w;
    })(),
    // A config file that runs only after an adjustment (config.file, warn).
    (() => {
      const w = world();
      const v = parseEditable({ pollSeconds: 1, dropZones: [fileZone('a')] }, { devImages: true });
      w.deps.configStatus = {
        mode: 'file',
        filePath: '/config/jm.json',
        revision: 4,
        restartPending: [],
        warnings: v.ok ? (v.warnings ?? []) : [],
      };
      return w;
    })(),
    // The legacy ready label, and no labels on the repository: both fixes name a ctl command or
    // an API path (zone.ready-label, forge.labels).
    (() => {
      const w = world({ zone: { readyLabel: LEGACY_READY_LABEL } });
      w.f.state.labels = [];
      return w;
    })(),
    // A doctor drop whose Claude call, service and gate all failed (zone.doctor-drop).
    (() => {
      const w = world();
      insertDrop(
        w.db,
        { id: 'doc1', dropZoneId: 'main', workItemId: null, role: 'doctor', state: 'succeeded' },
        ago(600_000),
      );
      const gates = [
        { name: 'test', exitCode: 2, durationMs: 1, timedOut: false, outputTail: 'FAIL x' },
      ];
      w.db.prepare("UPDATE drops SET result_json = ?, finished_at = ? WHERE id = 'doc1'").run(
        JSON.stringify({
          status: 'completed',
          role: 'doctor',
          gates,
          doctor: {
            claude: { ok: false, error: 'model not found' },
            clone: { ok: true, sha: 'abc1234def' },
            services: [{ name: 'db', ok: false }],
            gates,
          },
        }),
        ago(500_000).toISOString(),
      );
      return w;
    })(),
  ];
  const out: DoctorCheck[] = [];
  for (const w of worlds) out.push(...(await w.run()).filter((c) => c.status !== 'pass'));
  return out;
}

/** The checks `doctorFindings` must reach, so a change to a world can't make the test vacuous. */
const DOCTOR_REACHED = [
  'zone.preset',
  'forge.admin',
  'zone.identity',
  'forge.branch-rules',
  'forge.ci',
  'stick.capabilities',
  'forge.private-clone',
  'credential.missing',
  'zone.doctor-drop',
  'config.file',
  'zone.ready-label',
  'forge.labels',
];

async function seeded(doctor: DoctorCheck[] = []) {
  const h = await harness({
    live: true,
    zone: { ciRequired: true, protectedPaths: PROTECTED },
    extraZones: [
      { id: 'merlin', repo: 'octo/merlin', protectedPaths: PROTECTED },
      { id: 'gone', repo: 'octo/gone', protectedPaths: PROTECTED },
    ],
    // The project's GitHub section reads these, never the network.
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
  const at = h.now();
  setZoneMode(h.db, 'merlin', 'paused', at);
  h.db
    .prepare('INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES (?, ?, ?)')
    .run(
      at.toISOString(),
      at.toISOString(),
      JSON.stringify([
        { id: 'config.listen', zoneId: null, status: 'pass', summary: 'loopback only' },
        {
          id: 'zone.mode',
          zoneId: 'merlin',
          status: 'warn',
          summary: 'the project is paused: no new drop starts in it',
        },
        {
          id: 'forge.labels',
          zoneId: 'main',
          status: 'fail',
          summary: 'label agent-ready is missing',
          fix: 'gh label create agent-ready',
        },
        ...doctor,
      ]),
    );
  // A host a drop reached that no list of the project names (the egress table on Setup). The
  // sync writes the project rows a drop belongs to.
  await h.sync();
  insertDrop(
    h.db,
    { id: 'egress1', dropZoneId: 'main', workItemId: null, role: 'doctor', state: 'succeeded' },
    at,
  );
  h.db
    .prepare(
      `INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, 1, ?, 'egress', ?)`,
    )
    .run(
      'egress1',
      at.toISOString(),
      JSON.stringify({ host: 'new.example.com', decision: 'allowed', count: 2 }),
    );
  const briefing = raiseBriefing(
    h.db,
    {
      zoneId: 'main',
      kind: 'crew',
      subject: 'crew:a',
      decision: 'Which way?',
      why: 'w',
      options: [
        { id: 'o1', label: 'Yes', effect: 'none' },
        { id: 'o2', label: 'No', effect: 'none' },
      ],
      source: 'crew',
    },
    at,
  );
  // A guarded change waiting for its confirmation.
  const s = operatorSession(h.db, at);
  const store = h.store;
  if (!store) throw new Error('live harness has a store');
  const r = await h.app.inject({
    method: 'PATCH',
    url: '/api/control/config',
    headers: s.headers,
    payload: { patch: PATCH_NEEDING_CONFIRMATION, expectRevision: store.revision() },
  });
  expect(r.statusCode, r.body).toBe(409);
  const confirm = r.json().confirm as string;
  // A removed project: its removal is a revision on the History page.
  setZoneMode(h.db, 'gone', 'observe', at);
  const removed = await h.app.inject({
    method: 'DELETE',
    url: '/api/control/zones/gone',
    headers: s.headers,
  });
  expect(removed.statusCode, removed.body).toBe(200);
  // A chat thread focused on a project, with a card.
  const th = createThread(
    h.db,
    { title: 'Ask', focus: { kind: 'zone', zoneId: 'main', ref: 'main' } },
    at,
  );
  const msg = appendMessage(h.db, th.id, { role: 'owner', text: 'pause main', state: 'done' }, at);
  recordCard(
    h.db,
    {
      threadId: th.id,
      messageId: msg.id,
      kind: 'pause',
      zoneId: 'main',
      target: 'main',
      link: '/projects/main',
      state: 'done',
      summary: modeCardSummary('paused', 'main'),
    },
    at,
  );
  // A chat thread opened with Ask from a doctor check on the project, titled by the server.
  const asked = await h.app.inject({
    method: 'POST',
    url: '/api/chat/threads',
    headers: s.headers,
    payload: { focus: { kind: 'doctor', zoneId: 'merlin', ref: 'zone.mode' } },
  });
  expect(asked.statusCode, asked.body).toBeLessThan(300);
  const doctorThread = asked.json().thread.id as string;
  return { h, briefing, confirm, thread: th.id, doctorThread, cookie: s.cookie };
}

describe('every rendered page says project and Home', () => {
  test('no page shows "zone" or "Floor" in its visible text', async () => {
    const doctor = await doctorFindings();
    const reached = new Set(doctor.map((c) => c.id));
    for (const id of DOCTOR_REACHED) expect(reached, id).toContain(id);
    const { h, briefing, confirm, thread, doctorThread, cookie } = await seeded(doctor);
    const urls = [
      '/',
      '/?needs=all',
      `/briefings/${briefing}`,
      '/activity',
      '/activity/work',
      '/activity/drops',
      '/activity/log',
      '/projects',
      '/projects/new',
      '/projects/main',
      '/projects/merlin',
      '/projects/main/setup',
      '/projects/main/flags',
      '/projects/main/work',
      '/projects/main/goals',
      '/projects/main/issues/new',
      '/projects/main/log',
      '/chat',
      `/chat/${thread}`,
      '/system',
      '/system/sticks',
      '/system/sticks/images',
      '/system/credentials',
      '/system/server',
      '/system/advanced',
      '/system/mcp-tokens',
      '/system/history',
      '/setup/claude',
      '/setup/forge',
      '/setup/stick',
      '/setup/project',
      '/setup/doctor',
      INSTALLED_PATH,
    ];
    const found: Record<string, string[]> = {};
    for (const url of urls) {
      const res = await h.view(url);
      expect(res.statusCode, url).toBeLessThan(400);
      const bad = offenders(visibleText(res.body));
      if (bad.length > 0) found[url] = bad;
    }
    // The confirmation page belongs to the session that proposed the change.
    const page = await h.view(confirm, { cookie });
    expect(page.statusCode, confirm).toBe(200);
    const bad = offenders(visibleText(page.body));
    if (bad.length > 0) found[confirm.replace(/[^/]+$/, ':id')] = bad;
    // The doctor thread is the session's own that opened it, and so is its row in the list.
    for (const url of ['/chat', `/chat/${doctorThread}`]) {
      const own = await h.view(url, { cookie });
      expect(own.statusCode, url).toBe(200);
      const badOwn = offenders(visibleText(own.body));
      if (badOwn.length > 0) found[`${url} (own)`] = badOwn;
    }
    // Discovery of GitHub App installations, as the session that asks for it.
    const s = operatorSession(h.db, h.now());
    const discover = await h.app.inject({ method: 'POST', url: DISCOVER_PATH, headers: s.headers });
    expect(discover.statusCode, discover.body).toBe(200);
    const badDiscover = offenders(visibleText(discover.body));
    if (badDiscover.length > 0) found[DISCOVER_PATH] = badDiscover;
    expect(found).toEqual({});
  });

  test('discovery with no project on GitHub Apps says so in project words', async () => {
    const h = await harness({
      live: true,
      zone: { identity: 'starter', ciRequired: true, protectedPaths: PROTECTED },
    });
    const s = operatorSession(h.db, h.now());
    const res = await h.app.inject({ method: 'POST', url: DISCOVER_PATH, headers: s.headers });
    expect(res.statusCode, res.body).toBe(200);
    const text = visibleText(res.body);
    expect(text).toContain('No project uses GitHub Apps.');
    expect(offenders(text)).toEqual([]);
  });

  test('the seed reaches the strings it guards', async () => {
    const { h, confirm, doctorThread, cookie } = await seeded(await doctorFindings());
    // The History page lists the removed project's revision.
    expect(visibleText((await h.view('/system/history')).body)).toContain('remove project gone');
    // The doctor thread is titled by its check, shown as code in the list and on the thread.
    expect((await h.view('/chat', { cookie })).body).toContain(
      'Doctor: <code>zone.mode</code></a>',
    );
    expect((await h.view(`/chat/${doctorThread}`, { cookie })).body).toContain(
      '<h2>Doctor: <code>zone.mode</code>',
    );
    // The egress table marks the observed host no list names.
    expect(visibleText((await h.view('/projects/main/setup')).body)).toMatch(
      /new\.example\.com allowed 2 .*? egress1 not in this project's lists/,
    );
    // Doctor fix text is visible on the doctor page, not tucked away in <pre>.
    const doctor = visibleText((await h.view('/setup/doctor')).body);
    expect(doctor).toContain('Fix: Set authorMayBeAdmin: false in the project.');
    expect(doctor).toContain("or set the project's egress.mode to off");
    // The confirmation page lists the starter consequence, naming the project.
    expect(visibleText((await h.view(confirm, { cookie })).body)).toContain('project merlin: ');
  });

  test('a ctl command and an API path in a doctor fix are set as code on the doctor page', async () => {
    const { h } = await seeded(await doctorFindings());
    const html = (await h.view('/setup/doctor')).body;
    expect(html).toContain('<code>jumpmaster ctl zones set main readyLabel=');
    expect(html).toContain('<code>POST /api/control/zones/main/labels</code>');
    expect(offenders(visibleText(html))).toEqual([]);
  });

  test("the config file's lenient-read warnings on System → Server say project", async () => {
    const { h } = await seeded();
    const store = h.store;
    if (!store) throw new Error('live harness has a store');
    const v = parseEditable({ dropZones: [fileZone('My_App')] }, { devImages: true });
    const warnings = v.ok ? (v.warnings ?? []) : [];
    // Non-vacuous: the validator's own warning says zone.
    expect(warnings.join('\n')).toMatch(/zone id My_App/);
    const real = store.status.bind(store);
    vi.spyOn(store, 'status').mockImplementation(() => ({ ...real(), warnings }));
    const text = visibleText((await h.view('/system/server')).body);
    expect(text).toContain('project id My_App is not lower case letters');
    expect(offenders(text)).toEqual([]);
  });

  test("the Health page shows the config file's fix in project words", async () => {
    const issues = invalidFileIssues();
    const fix = issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    const { h } = await seeded([
      { id: 'config.file', zoneId: null, status: 'fail', summary: 'the file is refused', fix },
      {
        id: 'forge.labels',
        zoneId: 'merlin',
        status: 'fail',
        summary: 'labels missing',
        fix: 'POST /api/control/zones/merlin/labels for drop-zone',
      },
    ]);
    const html = (await h.view('/system')).body;
    const pre = [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1]).join('\n');
    expect(pre).toContain('a starter project requires ciRequired');
    expect(pre).toContain('duplicate project id: a');
    expect(pre).not.toMatch(/starter zone|zone id/);
    // Only the config file's validator prose is translated: another fix stays as written.
    expect(pre).toContain('POST /api/control/zones/merlin/labels for drop-zone');
  });

  test('a stored thread titled before the change, "Zone <id>", reads Project <id>', async () => {
    const { h } = await seeded();
    const old = createThread(
      h.db,
      { title: 'Zone merlin', focus: { kind: 'zone', zoneId: 'merlin', ref: 'merlin' } },
      h.now(),
    );
    const list = visibleText((await h.view('/chat')).body);
    expect(list).toContain('Project merlin');
    expect(offenders(list)).toEqual([]);
    const page = visibleText((await h.view(`/chat/${old.id}`)).body);
    expect(page).toContain('Project merlin');
    expect(offenders(page)).toEqual([]);
  });

  test('a ctl command inside <code> on a page is not a finding', async () => {
    const { h } = await seeded();
    const html = (await h.view('/projects')).body;
    expect(visibleText(`${html}<p>Run <code>jumpmaster ctl zones list</code></p>`)).not.toMatch(
      ZONE_WORD,
    );
  });
});

describe('projectWords on refusals', () => {
  test('a repository or path segment named zone is left alone', () => {
    expect(projectWords("zone x's history is for octo/zone")).toBe(
      "project x's history is for octo/zone",
    );
  });

  test('a refused discovery change says project', () => {
    const text = applyRefusal({
      ok: false,
      issues: [
        { path: 'dropZones.1.githubApp', message: 'githubApp applies to GitHub zones only' },
      ],
    });
    expect(text).toBe('githubApp applies to GitHub projects only');
  });
});

describe('fixHtml', () => {
  test('keeps entities whole and stops a ctl command at a bracket', () => {
    const mirror =
      'Keep the file a current mirror: docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json';
    expect(fixHtml(mirror)).toBe(
      'Keep the file a current mirror: docker compose exec -T jumpmaster <code>jumpmaster ctl config export &gt; config/jumpmaster.config.json.tmp &amp;&amp; mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json</code>',
    );
    expect(fixHtml(SHADOWED_TOKEN_FIX)).toBe(
      'Remove the one you do not mean: delete the file (then <code>jumpmaster ctl secrets reload</code>), or remove the vault entry with <code>jumpmaster ctl secrets remove &lt;name&gt;</code>.',
    );
    expect(fixHtml("it's <b> POST /api/x")).toBe('it&#39;s &lt;b&gt; <code>POST /api/x</code>');
  });
});

describe('codeHtml', () => {
  test('sets backticked text and doctor check ids as code, and nothing else', () => {
    expect(codeHtml('the `zone.mode` check')).toBe('the <code>zone.mode</code> check');
    expect(codeHtml('zone.mode warns: project merlin is paused')).toBe(
      '<code>zone.mode</code> warns: project merlin is paused',
    );
    // Not an id inside a longer word or path, and escaped before it is wrapped.
    expect(codeHtml('xzone.mode zone.mode.x <b>')).toBe('xzone.mode zone.mode.x &lt;b&gt;');
    expect(offenders(visibleText(codeHtml('zone.mode and forge.ci fail')))).toEqual([]);
  });
});

describe('guarded-change words', () => {
  const ctx: GuardCtx = { zoneId: 'main', install: {}, added: false };
  /** Every consequence a rule can say, each way round, as the confirmation page and Home show it. */
  const said = (c: string | string[] | undefined) => (c === undefined ? [] : [c].flat());

  test('every guarded consequence and every added-project consequence says project', () => {
    const lines: string[] = [];
    for (const g of GUARDED_PATHS) {
      const [from, to] = g.kind === 'set' ? [[], ['x']] : [undefined, 'starter'];
      lines.push(...said(g.consequence(from, to, ctx)), ...said(g.consequence(to, from, ctx)));
    }
    for (const r of REFUSED_PATHS)
      lines.push(...said(r.onAdd?.('gitlab', { ...ctx, added: true })));
    expect(lines.length).toBeGreaterThan(GUARDED_PATHS.length);
    expect(lines.filter((l) => offenders(l).length > 0)).toEqual([]);
  });
});

describe('chat card words', () => {
  test('a pause card and a resume card each say what happened to the project', () => {
    expect(modeCardSummary('paused', 'main')).toBe(
      'Paused project main: no new drops start, running ones finish.',
    );
    expect(modeCardSummary('active', 'main')).toBe('Resumed project main: it is active again.');
  });

  test('a refused card for a project the server does not know says project', () => {
    expect(refusedCardSummary('pause', 'unknown zone')).toBe(
      'Pausing a project was refused (unknown project).',
    );
    expect(refusedCardSummary('pause', 'killed')).toBe('Pausing a project was refused (killed).');
  });
});

describe('GitLab project words', () => {
  test("a GitLab project's Setup section says GitLab, in project words", () => {
    const zone = makeZone({
      id: 'lab',
      repo: 'octo/lab',
      forge: 'gitlab',
      gitlab: { baseUrl: 'https://gitlab.example.test' },
    });
    const text = visibleText(gitlabSection(zone, null));
    expect(text).toContain('GitLab');
    expect(text).not.toContain('not supported yet');
    expect(offenders(text)).toEqual([]);
  });
});

const NOW = plus(t0, 60 * 60_000);
const MIN = 60_000;

const item = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 1,
  dropZoneId: 'main',
  issueNumber: 7,
  title: 'Add sum',
  body: 'b',
  author: 'a',
  priority: 0,
  isFix: false,
  issueCreatedAt: t0.toISOString(),
  state: 'ready',
  reason: null,
  prNumber: null,
  retryLabelSeen: false,
  waitingSince: null,
  blockedBy: [],
  ...o,
});

const drop = (o: Partial<Drop> = {}): Drop => ({
  id: 'd1',
  dropZoneId: 'main',
  workItemId: 1,
  role: 'implement',
  state: 'running',
  stickId: 's1',
  epoch: 1,
  leaseExpiresAt: null,
  promptVersion: null,
  image: null,
  resultJson: null,
  createdAt: t0.toISOString(),
  startedAt: plus(NOW, -12 * MIN).toISOString(),
  finishedAt: null,
  fingerprint: null,
  prNumber: null,
  headSha: null,
  inputJson: null,
  chargedKey: null,
  requestedModel: null,
  servedModel: null,
  ...o,
});

const zone = (o: Partial<StatusZone> = {}): StatusZone => ({
  id: 'main',
  mode: 'active',
  items: [],
  drops: [],
  parked: 0,
  credentialProblems: [],
  repo: 'octo/demo',
  ciDeadlineMinutes: 45,
  gateCount: 3,
  ...o,
});

const base = (o: Partial<StatusInput> = {}): StatusInput => ({
  setupActive: false,
  killed: false,
  sticks: { live: 1, slots: 1, busy: 0 },
  doctor: { fails: [] },
  lastPassAt: plus(NOW, -MIN).toISOString(),
  openBriefings: 0,
  zones: [zone()],
  outboxRetrying: [],
  restartPending: false,
  ...o,
});

const failing = (id: string): DoctorCheck => ({ id, zoneId: null, status: 'fail', summary: id });

/** One input per headline branch, each with the facts its detail, action and also lines name. */
const BRANCHES: [string, StatusInput][] = [
  ['setup', base({ setupActive: true })],
  ['killed', base({ killed: true, killedSince: NOW.toISOString() })],
  [
    'credits stop',
    base({
      usage: { gate: 'stopped', overageDropId: 'cd9', overageStoppedAt: 'a', overageUntil: 'b' },
    }),
  ],
  ['usage pause', base({ usagePausedUntil: plus(NOW, 30 * MIN).toISOString() })],
  ['no stick', base({ sticks: { live: 0, slots: 0, busy: 0 } })],
  [
    'working',
    base({
      zones: [
        zone({ items: [item({ state: 'in_flight' })], drops: [drop()], gateEvents: { d1: 1 } }),
        zone({ id: 'merlin', mode: 'paused' }),
      ],
    }),
  ],
  [
    'ci',
    base({
      zones: [
        zone({
          items: [item({ state: 'pr_open', prNumber: 12 })],
          prs: [{ workItemId: 1, number: 12, headFirstSeenAt: plus(NOW, -20 * MIN).toISOString() }],
        }),
      ],
    }),
  ],
  ['throttled', base({ usage: { gate: 'finishing_only' }, zones: [zone({ items: [item()] })] })],
  [
    'credential problem',
    base({
      zones: [
        zone({
          credentialProblems: [
            { zoneId: 'main', kind: 'missing', credential: 'claudeToken', message: 'no token' },
          ],
        }),
      ],
    }),
  ],
  [
    'doctor fails',
    base({
      doctor: { fails: [failing('forge.labels')], finishedAt: NOW.toISOString() },
      lastPassAt: plus(NOW, -2 * MIN).toISOString(),
    }),
  ],
  ['waiting on you', base({ openBriefings: 1 })],
  ['pending changes', base({ pendingChanges: 1 })],
  [
    'all paused',
    base({
      zones: [zone({ mode: 'paused', drops: [drop()] }), zone({ id: 'b', mode: 'observe' })],
    }),
  ],
  [
    'all paused, no projects page',
    base({
      zones: [zone({ mode: 'paused' })],
      pages: { zones: false, settings: false, credentials: false },
    }),
  ],
  [
    'parked',
    base({ zones: [zone({ parked: 1, items: [item({ state: 'parked', reason: 'stuck' })] })] }),
  ],
  [
    'queued, no stick can run',
    base({
      zones: [
        zone({
          items: [item({ state: 'in_flight' })],
          drops: [drop({ state: 'queued', startedAt: null })],
          cannotRun: 'm3: lacks egress-v1',
        }),
      ],
    }),
  ],
  [
    'queued doctor',
    base({
      zones: [
        zone({
          drops: [drop({ role: 'doctor', workItemId: null, state: 'queued', startedAt: null })],
          doctorWait: 'it waits for a slot',
        }),
      ],
    }),
  ],
  ['ready', base({ zones: [zone({ items: [item()] }), zone({ id: 'b', mode: 'paused' })] })],
  [
    'capped',
    base({
      zones: [
        zone({
          items: [item(), item({ id: 2, state: 'pr_open', prNumber: 3 })],
          maxOpenPrs: 1,
        }),
      ],
    }),
  ],
  ['held ready', base({ zones: [zone({ id: 'a' }), zone({ mode: 'paused', items: [item()] })] })],
  ['idle', base()],
  [
    'idle, no projects page',
    base({ zones: [], pages: { zones: false, settings: false, credentials: false } }),
  ],
];

describe('status lines say project', () => {
  test.each(BRANCHES)('%s', (_name, input) => {
    const s = statusOf(input, NOW);
    const words = [
      s.headline,
      s.detail ?? '',
      s.action?.label ?? '',
      ...(s.also ?? []).map((a) => a.text),
    ].join(' | ');
    expect(offenders(words), words).toEqual([]);
  });
});

/**
 * A page script's refusals: what it prints from an API answer, run against the words the server
 * actually answers with (#872). `visibleText` drops `<script>` content, so these are driven here.
 */
describe('refusals a page script prints say project', () => {
  type El = {
    textContent: string;
    value: string;
    hidden: boolean;
    dataset: Record<string, string>;
    children: unknown[];
    listeners: Record<string, ((e: unknown) => unknown)[]>;
    [k: string]: unknown;
  };
  /** A fake element: enough DOM for the scripts' top level and their refusal paths. */
  const fakeEl = (o: Partial<El> = {}): El => {
    const el: El = {
      textContent: '',
      value: '',
      hidden: false,
      dataset: {},
      children: [],
      listeners: {},
      ...o,
    };
    Object.assign(el, {
      addEventListener: (t: string, f: (e: unknown) => unknown) => {
        (el.listeners[t] ??= []).push(f);
      },
      append: (...kids: unknown[]) => {
        for (const k of kids) el.children.push(k);
      },
      replaceChildren: (...kids: unknown[]) => {
        el.children = kids;
        el.textContent = kids.map((k) => (typeof k === 'string' ? k : '')).join('');
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      reset: () => {},
      focus: () => {},
    });
    return el;
  };
  /** Everything an element shows: its text and its children's, depth first. */
  const shown = (el: unknown): string => {
    if (typeof el === 'string') return el;
    const e = el as El;
    return [e.textContent, ...e.children.map(shown)].join(' ');
  };
  const answer = (status: number, body: unknown) => async () => ({
    ok: status < 300,
    status,
    json: async () => body,
  });
  const body = (script: string) => script.replace(/^<script>|<\/script>$/gi, '');

  /** The validator's issues for a starter project with ciRequired: false and one with no image or preset. */
  function validatorIssues(): ConfigIssue[] {
    const { image: _i, ...bare } = fileZone('b');
    const r = parseEditable(
      { dropZones: [fileZone('a', { identity: 'starter', ciRequired: false }), bare] },
      { devImages: true },
    );
    const issues = 'issues' in r ? r.issues : [];
    // Non-vacuous: the validator says zone, under dropZones paths.
    const said = issues.map((i) => `${i.path}: ${i.message}`).join('\n');
    expect(said).toMatch(/dropZones\.0\.[^\n]*starter zone requires ciRequired/);
    expect(said).toMatch(/dropZones\.1[^\n]*: a zone needs image or preset/);
    return issues;
  }

  test('the New issue page past the hourly limit', async () => {
    expect(INTAKE_LIMIT_ERROR).toContain('per project per hour');
    const els: Record<string, El> = {};
    const byId = (id: string) => {
      els[id] ??= fakeEl(id === 'new-issue' ? { dataset: { base: '/b', issues: '/i/' } } : {});
      return els[id];
    };
    const ctx = vm.createContext({
      document: { getElementById: byId, createElement: () => fakeEl() },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      crypto: { randomUUID: () => 'uuid-1' },
      jmFetch: answer(429, { error: INTAKE_LIMIT_ERROR }),
    });
    vm.runInContext(body(ISSUE_SCRIPT), ctx);
    byId('issue-title').value = 'A title';
    for (const fn of byId('issue-form').listeners.submit ?? [])
      await fn({ preventDefault: () => {}, submitter: { disabled: false } });
    const text = shown(byId('issue-status'));
    expect(text).toContain('per project per hour');
    expect(offenders(text), text).toEqual([]);
  });

  test('System, Credentials refusing to remove a credential a project needs', async () => {
    for (const [fnName, arg, name] of [
      ['jmRemoveCredential', 'githubAuthorToken', 'githubAuthorToken'],
      ['jmRemoveGitlabPat', { zone: 'gl', role: 'author' }, 'gitlab-pat/gl/author'],
    ] as const) {
      const ctx = vm.createContext({
        document: { addEventListener: () => {}, querySelectorAll: () => [] },
        encodeURIComponent,
        jmFetch: answer(409, { error: neededCredentialError(name) }),
      });
      vm.runInContext(body(CREDENTIALS_SCRIPT), ctx);
      const status = fakeEl();
      const fn = ctx[fnName] as (...a: unknown[]) => Promise<string>;
      expect(await fn(arg, { sudo: true, passphrase: '' }, status), fnName).toBe('refused');
      expect(status.textContent).toContain(`projects need ${name}: removing it would park them`);
      expect(offenders(status.textContent), status.textContent).toEqual([]);
    }
  });

  test("the wizard's project step, an id with history: the refusal says project and Resume is offered", async () => {
    const html = projectBody('two-bot', { returnTo: '/r', cancelTo: '/c', done: '/d' });
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1] as string)
      .find((s) => s.includes('async function createZone')) as string;
    expect(script).toBeDefined();
    const els: Record<string, El> = {};
    const ctx = vm.createContext({
      document: {
        getElementById: (id: string) => {
          els[id] ??= fakeEl();
          return els[id];
        },
        createElement: () => fakeEl(),
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
      },
      location: { href: '' },
      URLSearchParams,
      JSON,
      jmFetch: answer(400, {
        issues: [{ path: 'dropZones.1.id', message: ZONE_HISTORY_ISSUE }],
        history: { workItems: 3, drops: 2, outbox: 1, crewIssues: 0, goals: 1 },
      }),
    });
    vm.runInContext(script, ctx);
    const out = fakeEl();
    await (ctx.createZone as (...a: unknown[]) => Promise<void>)(
      { repo: 'octo/old', id: 'old' },
      false,
      out,
    );
    expect(out.textContent).toBe(
      'dropZones.1.id: this project has history: pick another id, or resume it',
    );
    const text = shown(out);
    expect(text).toContain('Resume brings back its history (paused)');
    expect(text).toContain('Resume old');
    expect(offenders(text), text).toEqual([]);
  });

  test("the project Setup form's issues and the stop and adopt lines", () => {
    const issues = validatorIssues();
    const placed: Record<string, El> = { image: fakeEl() };
    const ctx = vm.createContext({
      document: {
        querySelector: (sel: string) =>
          placed[/data-issues="([^"]+)"/.exec(sel)?.[1] ?? ''] ?? null,
      },
    });
    vm.runInContext(`${FORM_SCRIPT}\n${ISSUES_SCRIPT}`, ctx);
    for (const index of [0, 1]) {
      const out = fakeEl();
      (ctx.jmShowIssues as (...a: unknown[]) => void)(issues, out, index);
      const text = [out.textContent, placed.image?.textContent].join(' | ');
      expect(offenders(text), text).toEqual([]);
      // The paths shown are kept as the validator gives them.
      expect(out.textContent).toMatch(/dropZones\.\d/);
    }
    expect(placed.image?.textContent).toContain('a project needs image or preset');
    const line = (ctx.jmIssuesText as (i: ConfigIssue[]) => string)(issues);
    expect(line).toContain('a starter project requires ciRequired');
    expect(offenders(line), line).toEqual([]);
  });

  test('the shared setting controls and the advanced settings rows', async () => {
    const issues = validatorIssues();
    const ctx = vm.createContext({});
    vm.runInContext(CONFIG_ANSWER_FN, ctx);
    const status = fakeEl();
    const r = await answer(400, { issues })();
    const said = await (ctx.jmConfigAnswer as (...a: unknown[]) => Promise<string>)(
      r,
      status,
      () => {},
      '/s',
    );
    expect(said).toBe('refused');
    expect(status.textContent).toContain('dropZones.1');
    expect(status.textContent).toContain('a project needs image or preset');
    expect(offenders(status.textContent), status.textContent).toEqual([]);

    const flags = vm.createContext({
      document: {
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      },
    });
    vm.runInContext(body(FLAGS_SCRIPT), flags);
    const above = fakeEl();
    (flags.jmShowFlagIssues as (...a: unknown[]) => void)(issues, { zone: { id: 'a' } }, above);
    expect(above.textContent).toContain('dropZones.0');
    expect(offenders(above.textContent), above.textContent).toEqual([]);

    for (const script of [HISTORY_SCRIPT, OTHER_MACHINES_SCRIPT]) {
      const c = vm.createContext({
        document: { addEventListener: () => {}, querySelectorAll: () => [] },
        jmFetch: answer(400, { issues }),
      });
      vm.runInContext(body(script), c);
      const st = fakeEl();
      const fn = (c.jmRevert ?? c.jmSavePublicUrl) as (...a: unknown[]) => Promise<string>;
      const args =
        c.jmRevert !== undefined
          ? [{ id: 1, revision: 2, readds: [] }, st, () => true, () => {}]
          : ['https://jm.example', st, () => {}];
      expect(await fn(...args)).toBe('refused');
      expect(offenders(st.textContent), st.textContent).toEqual([]);
    }
  });
});
