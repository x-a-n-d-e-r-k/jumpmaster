import { describe, expect, test } from 'vitest';
import { type Briefing, floorBriefings, listBriefings, raiseBriefing } from '../briefings.js';
import type { Pending } from '../config/confirm.js';
import type { DropZoneConfig } from '../config.js';
import {
  type Drop,
  type DropState,
  insertOutbox,
  listMergesSince,
  listOutbox,
  type OutboxRow,
  setZoneMode,
  updateOutbox,
  upsertDropZone,
  upsertWorkItem,
  type WorkItem,
  type WorkItemState,
} from '../db/repo.js';
import { harness } from '../test/flowHarness.js';
import {
  type FailingCheck,
  type FloorCounts,
  floorCounts,
  listHref,
  NEEDS_CAP,
  type NeedsRow,
  rankNeeds,
} from './floor.js';
import { BOARD_COLUMNS, type HomeState, renderBoard, renderHome } from './pages.js';

const OPERATOR = { authorization: `Bearer ${'o'.repeat(32)}`, host: 'localhost:80' };

const brief = (zoneId: string, subject: string) => ({
  zoneId,
  kind: 'crew' as const,
  subject,
  decision: `Decide ${subject} in ${zoneId}?`,
  why: 'w',
  options: [{ id: 'ok', label: 'OK', effect: 'none' as const }],
  source: 'crew' as const,
});

async function twoZones() {
  const h = await harness({ extraZones: [{ id: 'shadow', repo: 'octo/shadow' }] });
  raiseBriefing(h.db, brief('main', 'crew:m1'), h.now());
  raiseBriefing(h.db, brief('shadow', 'crew:s1'), h.now());
  raiseBriefing(h.db, brief('shadow', 'crew:s2'), h.now());
  // The stick checks in, so the status line is not about a missing runner.
  await h.app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: h.stickHeaders(),
    payload: { freeSlots: 1, capabilities: ['push-v1'] },
  });
  return h;
}

test('the floor lists only an active zone’s briefings; a paused zone gets one collapsed line', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'paused', h.now());
  const home = (await h.view('/')).body;
  expect(home).toContain('octo/demo: Decide crew:m1 in main?');
  expect(home).not.toContain('Decide crew:s1 in shadow?');
  expect(home).not.toContain('Decide crew:s2 in shadow?');
  expect(home).toContain('Waiting on you: 1 briefing');
  expect(home).toContain(
    '<a class="muted" href="/projects/shadow">octo/shadow: paused, 2 briefings held</a>',
  );
  // Untouched, and still listed on that project's page.
  expect(listBriefings(h.db, { zoneId: 'shadow', state: 'open' })).toHaveLength(2);
  const view = await h.view('/briefings?zone=shadow');
  expect([view.statusCode, view.headers.location]).toEqual([301, '/projects/shadow']);
});

test('a zone in observe is collapsed too', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'observe', h.now());
  const home = (await h.view('/')).body;
  expect(home).not.toContain('Decide crew:s1 in shadow?');
  expect(home).toContain('octo/shadow: observing, 2 briefings held');
});

test('resuming the paused zone lists its briefings on the floor again', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'paused', h.now());
  setZoneMode(h.db, 'shadow', 'active', h.now());
  const home = (await h.view('/')).body;
  expect(home).toContain('octo/shadow: Decide crew:s1 in shadow?');
  expect(home).toContain('octo/shadow: Decide crew:s2 in shadow?');
  expect(home).toContain('octo/demo: Decide crew:m1 in main?');
  expect(home.match(/data-kind="briefing"/g)).toHaveLength(3);
  expect(home).toContain('Waiting on you: 3 briefings');
  expect(home).not.toContain('briefings held');
});

test('bulk dismiss dismisses exactly that zone’s briefings and writes no outbox entry', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'paused', h.now());
  const ids = listBriefings(h.db, { zoneId: 'shadow', state: 'open' }).map((b) => b.id);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/control/zones/shadow/briefings/dismiss',
    headers: OPERATOR,
    payload: { ids },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ zone: 'shadow', dismissed: ids });
  expect(listBriefings(h.db, { zoneId: 'shadow', state: 'open' })).toEqual([]);
  expect(listBriefings(h.db, { zoneId: 'main', state: 'open' })).toHaveLength(1);
  expect(listOutbox(h.db, ['pending', 'unknown', 'failed', 'done'])).toEqual([]);
  const audited = h.db
    .prepare("SELECT target FROM control_audit WHERE action = 'briefing.dismiss' ORDER BY id")
    .all() as { target: string }[];
  expect(audited.map((a) => a.target)).toEqual(ids.map((id) => `briefing:${id}`));
  expect((await h.view('/')).body).not.toContain('briefings held');
});

test("a stored doctor run's failing project check reaches Home's Needs you; a warn, a pass and an install-wide fail do not", async () => {
  const h = await twoZones();
  h.db
    .prepare("INSERT INTO doctor_runs (started_at, finished_at, results_json) VALUES ('a', 'b', ?)")
    .run(
      JSON.stringify([
        { id: 'zone.labels', zoneId: 'shadow', status: 'fail', summary: 'labels missing' },
        { id: 'zone.warned', zoneId: 'shadow', status: 'warn', summary: 'w' },
        { id: 'zone.passed', zoneId: 'main', status: 'pass', summary: 'p' },
        { id: 'install.wide', zoneId: null, status: 'fail', summary: 'i' },
        { id: 'zone.gone', zoneId: 'removed', status: 'fail', summary: 'g' },
      ]),
    );
  const home = (await h.view('/')).body;
  const at = home.indexOf('id="waiting-on-you"');
  const needs = home.slice(at, home.indexOf('</section>', at));
  const checks = needs.match(/<li class="needs-row" data-kind="check">.*?<\/li>/g) ?? [];
  expect(checks).toEqual([
    expect.stringContaining(
      'octo/shadow: 1 failing check (zone.labels) <a href="/system">Fix in System</a>',
    ),
  ]);
  expect(needs).not.toContain('zone.warned');
  expect(needs).not.toContain('zone.passed');
  expect(needs).not.toContain('install.wide');
  expect(needs).not.toContain('zone.gone');
});

test('Home lists the first 10 Needs you rows; /?needs=all lists every one', async () => {
  const h = await twoZones();
  for (let n = 0; n < 12; n++) raiseBriefing(h.db, brief('main', `crew:b${n}`), h.now());
  const rows = (body: string) => body.match(/<li class="needs-row"/g)?.length ?? 0;
  const capped = (await h.view('/')).body;
  expect(rows(capped)).toBe(10);
  expect(capped).toContain('5 more. <a href="/?needs=all#waiting-on-you">Show all 15</a>');
  const all = (await h.view('/?needs=all')).body;
  expect(rows(all)).toBe(15);
  expect(all).not.toContain('Show all');
});

test('bulk dismiss refuses an unknown zone', async () => {
  const h = await twoZones();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/control/zones/nope/briefings/dismiss',
    headers: OPERATOR,
    payload: { ids: [1] },
  });
  expect(res.statusCode).toBe(404);
});

// --- briefings of a zone no longer in the config (#178) ---

test('bulk dismiss reaches the open briefings of a removed zone', async () => {
  const h = await twoZones();
  raiseBriefing(h.db, brief('old', 'crew:o1'), h.now());
  raiseBriefing(h.db, brief('old', 'crew:o2'), h.now());
  const ids = listBriefings(h.db, { zoneId: 'old', state: 'open' }).map((b) => b.id);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/control/zones/old/briefings/dismiss',
    headers: OPERATOR,
    payload: { ids },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ zone: 'old', dismissed: ids });
  expect(listBriefings(h.db, { zoneId: 'old' }).map((b) => b.state)).toEqual([
    'dismissed',
    'dismissed',
  ]);
  expect(listBriefings(h.db, { zoneId: 'shadow', state: 'open' })).toHaveLength(2);
});

test('bulk dismiss for a removed zone refuses ids that are not all its own', async () => {
  const h = await twoZones();
  raiseBriefing(h.db, brief('old', 'crew:o1'), h.now());
  const old = listBriefings(h.db, { zoneId: 'old' }).map((b) => b.id);
  const main = listBriefings(h.db, { zoneId: 'main' }).map((b) => b.id);
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/control/zones/old/briefings/dismiss',
    headers: OPERATOR,
    payload: { ids: [...old, ...main] },
  });
  expect(res.statusCode).toBe(404);
  expect(listBriefings(h.db, { state: 'open' })).toHaveLength(4);
});

test('an orphan open briefing counts neither on the Floor nor in the status headline', async () => {
  const h = await twoZones();
  raiseBriefing(h.db, brief('old', 'crew:o1'), h.now());
  const f = floorBriefings(h.db, [
    { id: 'main', repo: 'octo/demo', mode: 'active' },
    { id: 'shadow', repo: 'octo/shadow', mode: 'active' },
  ]);
  expect(f.listed.map((b) => b.zoneId)).toEqual(['main', 'shadow', 'shadow']);
  const home = (await h.view('/')).body;
  expect(home).toContain('Waiting on you: 3 briefings');
  expect(home).not.toContain('Waiting on you: 4 briefings');
  const status = await h.app.inject({
    method: 'GET',
    url: '/api/control/status',
    headers: OPERATOR,
  });
  expect(status.json().headline).toBe('Waiting on you: 3 briefings');
});

// --- a held promotion is a notice, not a briefing that needs Command (#449) ---

const held = (zoneId: string, subject: string) => ({
  zoneId,
  kind: 'promote_held' as const,
  subject,
  decision: `Hold ${subject}. It goes ahead in about a minute unless you reject it.`,
  why: 'w',
  options: [
    { id: 'reject', label: 'Reject', effect: 'reject_issue' as const },
    { id: 'promote', label: 'Promote now', effect: 'promote_issue' as const },
  ],
  source: 'server' as const,
});
const parked = (zoneId: string, subject: string) => ({
  ...brief(zoneId, subject),
  kind: 'parked' as const,
  decision: `Parked ${subject}?`,
  source: 'server' as const,
});

/** One zone with its stick checked in, so the status line is about briefings. */
async function oneZone() {
  const h = await harness();
  await h.app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: h.stickHeaders(),
    payload: { freeSlots: 1, capabilities: ['push-v1'] },
  });
  return h;
}

test('an open promote_held is a notice: Needs you and the headline count only the parked one', async () => {
  const h = await oneZone();
  raiseBriefing(h.db, held('main', 'issue:1'), h.now());
  raiseBriefing(h.db, parked('main', 'item:2'), h.now());
  const f = floorBriefings(h.db, [{ id: 'main', repo: 'octo/demo', mode: 'active' }]);
  expect(f.listed.map((b) => b.kind)).toEqual(['parked']);
  expect(f.notices.map((b) => b.kind)).toEqual(['promote_held']);
  expect(f.held).toEqual([]);
  const home = (await h.view('/')).body;
  expect(home.match(/data-kind="briefing"/g)).toHaveLength(1);
  expect(home).toContain('Parked item:2?');
  expect(home).not.toContain('Hold issue:1');
  expect(home).toContain('Waiting on you: 1 briefing');
  expect(home).not.toContain('Waiting on you: 2 briefings');
});

test('only a promote_held open: Needs you is 0, and the Floor shows no notice count', async () => {
  const h = await oneZone();
  raiseBriefing(h.db, held('main', 'issue:1'), h.now());
  const home = (await h.view('/')).body;
  expect(home).not.toContain('data-kind="briefing"');
  expect(home).not.toContain('Waiting on you: 1 briefing');
  expect(home).not.toContain('Going ahead unless you stop it');
  expect(home).toContain('Nothing needs you');
});

test('a promote_held in a paused zone is held with its other briefings, as before', async () => {
  const h = await oneZone();
  raiseBriefing(h.db, held('main', 'issue:1'), h.now());
  raiseBriefing(h.db, parked('main', 'item:2'), h.now());
  setZoneMode(h.db, 'main', 'paused', h.now());
  const f = floorBriefings(h.db, [{ id: 'main', repo: 'octo/demo', mode: 'active' }]);
  expect(f).toMatchObject({ listed: [], notices: [], held: [{ zoneId: 'main', count: 2 }] });
  const home = (await h.view('/')).body;
  expect(home).toContain('octo/demo: paused, 2 briefings held');
  expect(home).not.toContain('data-kind="briefing"');
});

test('floorCounts never counts a notice as needs-you, on the card or in the totals', () => {
  const notice = { ...br('A'), kind: 'promote_held' as const };
  const f = floorCounts(home({ zones: [zone('A')], briefings: [notice, br('A')] }), NOW);
  expect(zoneOf(f, 'A').counts.needsYou).toBe(1);
  expect(f.totals.needsYou).toBe(1);
  const only = floorCounts(home({ zones: [zone('A')], briefings: [notice] }), NOW);
  expect(zoneOf(only, 'A').counts.needsYou).toBe(0);
  expect(zoneOf(only, 'A').state).not.toBe('needs-you');
});

// --- floorCounts and the dashboard's renderers (#120) ---

const NOW = new Date('2026-06-01T12:00:00.000Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const zone = (id: string, repo = `octo/${id.replaceAll(' ', '-')}`): DropZoneConfig => ({
  id,
  repo,
  readyLabel: 'agent-ready',
  gates: [],
  image: 'img',
  model: 'm',
  maxTurns: 200,
});

let nextId = 1;
const wi = (zoneId: string, state: WorkItemState): WorkItem => {
  const id = nextId++;
  return {
    id,
    dropZoneId: zoneId,
    issueNumber: id,
    title: `t${id}`,
    body: 'b',
    author: 'a',
    priority: 2,
    isFix: false,
    issueCreatedAt: '2026-01-01T00:00:00.000Z',
    state,
    reason: null,
    prNumber: null,
    retryLabelSeen: false,
    waitingSince: null,
    blockedBy: [],
  };
};
const dr = (zoneId: string, state: DropState): Drop => ({
  id: `d${nextId++}`,
  dropZoneId: zoneId,
  workItemId: null,
  role: 'implement',
  state,
  stickId: null,
  epoch: 1,
  leaseExpiresAt: null,
  promptVersion: null,
  image: null,
  resultJson: null,
  createdAt: ago(1),
  startedAt: ago(1),
  finishedAt: null,
});
const br = (zoneId: string): Briefing =>
  ({
    id: nextId++,
    zoneId,
    kind: 'crew',
    subject: `s${nextId}`,
    decision: 'Decide?',
    why: 'w',
    options: [],
    recommendation: '',
    onHold: '',
    source: 'crew',
    createdAt: ago(1),
  }) as unknown as Briefing;

const home = (s: Partial<HomeState> & { zones: DropZoneConfig[] }): HomeState => ({
  items: [],
  drops: [],
  merges24h: [],
  now: NOW,
  ...s,
});
const zoneOf = (f: FloorCounts, id: string) => {
  const z = f.zones.find((x) => x.zoneId === id);
  if (!z) throw new Error(`no zone ${id}`);
  return z;
};

describe('floorCounts', () => {
  test('counts per zone without crossing zones, and totals across the install', () => {
    const A = zone('A');
    const B = zone('B');
    const f = floorCounts(
      home({
        zones: [A, B],
        items: [wi('A', 'parked'), wi('A', 'parked')],
        drops: [dr('B', 'running'), dr('B', 'queued')],
      }),
      NOW,
    );
    expect(zoneOf(f, 'A').counts).toMatchObject({ parked: 2, running: 0 });
    expect(zoneOf(f, 'B').counts).toMatchObject({ parked: 0, running: 1 });
    expect(f.totals).toMatchObject({ parked: 2, running: 1 });
  });

  test.each<[string, Partial<HomeState>, string]>([
    [
      'a briefing and a parked item',
      { briefings: [br('A')], items: [wi('A', 'parked')] },
      'needs-you',
    ],
    ['parked only', { items: [wi('A', 'parked')] }, 'blocked'],
    ['running only', { drops: [dr('A', 'running')] }, 'working'],
    ['nothing', {}, 'idle'],
  ])('card state: %s is %s', (_name, s, expected) => {
    const f = floorCounts(home({ zones: [zone('A')], ...s }), NOW);
    expect(zoneOf(f, 'A').state).toBe(expected);
  });

  const ready = (n: number) => Array.from({ length: n }, () => wi('A', 'ready'));
  test.each<[string, string, Partial<HomeState>, string]>([
    ['paused, 3 ready, none running', 'paused', { items: ready(3) }, 'held'],
    ['paused, one running', 'paused', { drops: [dr('A', 'running')] }, 'working'],
    ['observe, 2 ready', 'observe', { items: ready(2) }, 'held'],
    ['active, 3 ready', 'active', { items: ready(3) }, 'working'],
    ['paused, one parked', 'paused', { items: [wi('A', 'parked')] }, 'blocked'],
  ])('held card state (#495): %s', (_name, mode, s, expected) => {
    const f = floorCounts(home({ zones: [zone('A')], modes: { A: mode }, ...s }), NOW);
    expect(zoneOf(f, 'A').state).toBe(expected);
  });

  test("a held project's row reads its held sentence, PAUSED or OBSERVING by mode, after working ones (#495, #625)", () => {
    const paused = renderHome(
      home({
        zones: [zone('A')],
        modes: { A: 'paused' },
        items: [wi('A', 'ready'), wi('A', 'ready'), wi('A', 'ready')],
      }),
    );
    expect(paused).toMatch(
      /data-state="held" data-zone="A">.*?<span class="state">PAUSED: 0 running, 3 queued, 0 PRs open, 0 merged \(24h\)\.<\/span>/,
    );
    const observing = renderHome(
      home({ zones: [zone('A')], modes: { A: 'observe' }, items: [wi('A', 'ready')] }),
    );
    expect(observing).toContain('<span class="state">OBSERVING: 0 running, 1 queued');
    const order = renderHome(
      home({
        zones: [zone('I'), zone('H'), zone('W')],
        modes: { H: 'paused' },
        drops: [dr('W', 'running')],
      }),
    );
    const at = (id: string) => order.indexOf(`data-zone="${id}"`);
    expect(at('W')).toBeLessThan(at('H'));
    expect(at('H')).toBeLessThan(at('I'));
  });

  test("a paused zone's briefings are held, not needs-you, on the card and in the totals", () => {
    const f = floorCounts(
      home({
        zones: [zone('A'), zone('B')],
        modes: { A: 'paused' },
        briefings: [br('A'), br('A'), br('A'), br('B')],
      }),
      NOW,
    );
    const a = zoneOf(f, 'A');
    expect(a.counts.needsYou).toBe(0);
    expect(a.counts.held).toBe(3);
    expect(a.state).not.toBe('needs-you');
    expect(f.totals.needsYou).toBe(1);
    // As the app passes them: held back by floorBriefings.
    const g = floorCounts(
      home({
        zones: [zone('A')],
        modes: { A: 'paused' },
        heldBriefings: [{ zoneId: 'A', repo: 'octo/A', mode: 'paused', count: 3 }],
      }),
      NOW,
    );
    expect(zoneOf(g, 'A').counts).toMatchObject({ needsYou: 0, held: 3 });
    expect(g.totals.needsYou).toBe(0);
    const html = renderHome(
      home({ zones: [zone('A')], modes: { A: 'paused' }, briefings: [br('A'), br('A'), br('A')] }),
    );
    expect(html).toContain('3 held while paused');
  });

  test('Merged (24h) counts a merge done 23 hours ago, not one 25 hours ago', () => {
    const f = floorCounts(
      home({
        zones: [zone('A')],
        merges24h: [
          { zoneId: 'A', at: ago(23) },
          { zoneId: 'A', at: ago(25) },
        ],
      }),
      NOW,
    );
    expect(zoneOf(f, 'A').counts.merged24h).toBe(1);
    expect(f.totals.merged24h).toBe(1);
  });

  test('outbox ops unknown or failed count on the zone of their item; no live stick that can run it blocks', () => {
    const A = zone('A');
    const item = wi('A', 'pr_open');
    const op = { workItemId: item.id, zoneId: '', state: 'failed' } as OutboxRow;
    const stick = (cannot: string[]) => ({
      id: 's',
      name: 's',
      version: null,
      lastSeenAt: ago(0),
      capabilities: [],
      imagePolicy: 'p',
      cannotRun: cannot.map((zoneId) => ({ zoneId, missing: ['x'] })),
    });
    const f = floorCounts(
      home({ zones: [A, zone('B')], items: [item], outbox: [op], sticks: [stick(['B'])] }),
      NOW,
    );
    expect(zoneOf(f, 'A').counts).toMatchObject({ outbox: 1, noStick: false });
    expect(zoneOf(f, 'A').state).toBe('blocked');
    expect(zoneOf(f, 'B').counts).toMatchObject({ outbox: 0, noStick: true });
  });
});

test('the merge query reads merges done in the window, with the zone of their item', async () => {
  const h = await harness({ extraZones: [{ id: 'shadow', repo: 'octo/shadow' }] });
  upsertDropZone(h.db, {
    id: 'shadow',
    repo: 'octo/shadow',
    defaultBranch: 'main',
    configJson: '{}',
  });
  const w = upsertWorkItem(
    h.db,
    {
      dropZoneId: 'shadow',
      issueNumber: 5,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 2,
      isFix: false,
      issueCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    h.now(),
  );
  const at = (hours: number) => new Date(h.now().getTime() - hours * 3_600_000);
  const op = (
    key: string,
    kind: 'merge' | 'create_pr',
    state: 'done' | 'failed',
    hours: number,
  ) => {
    insertOutbox(h.db, {
      id: key,
      opKey: key,
      kind,
      workItemId: w.id,
      zoneId: '',
      payloadJson: '{}',
      state: 'pending',
      createdAt: at(hours).toISOString(),
    });
    updateOutbox(h.db, key, { state }, at(hours));
  };
  op('done-23h', 'merge', 'done', 23);
  op('done-25h', 'merge', 'done', 25);
  op('failed-1h', 'merge', 'failed', 1);
  op('pr-1h', 'create_pr', 'done', 1);
  expect(listMergesSince(h.db, at(24))).toEqual([
    { zoneId: 'shadow', at: at(23).toISOString(), workItemId: w.id },
  ]);
});

describe('Home (#625)', () => {
  const pending = (over: Partial<Pending> = {}): Pending => ({
    id: 'pend-1',
    sessionIdHash: 'sess-a',
    patch: { mcp: { enabled: true, secretOnlyInPatch: 'PATCH-ONLY-VALUE-x9' } },
    changeHash: 'h',
    expectRevision: 3,
    meta: {
      via: 'ui',
      principal: { kind: 'operator', via: 'session', sessionId: 'sess-a', sudo: false },
    },
    expiresAt: new Date(NOW.getTime() + 7 * 60_000),
    guarded: [{ path: 'mcp.enabled', consequence: 'Turns on the MCP server' }],
    notes: [],
    ...over,
  });
  const fail = (zoneId: string, id = 'forge.labels'): FailingCheck => ({
    zoneId,
    id,
    summary: `${id} fails`,
  });
  /** Home's Needs you section, start to end. */
  const needsOf = (html: string) => {
    const at = html.indexOf('id="waiting-on-you"');
    return html.slice(at, html.indexOf('</section>', at));
  };
  const kinds = (html: string) =>
    [...needsOf(html).matchAll(/<li class="needs-row" data-kind="([^"]+)">/g)].map((m) => m[1]);

  test('Needs you ranks a failing check, a pending change, a briefing and a parked item in that order, whatever the order given', () => {
    // Seeded in reverse: the parked item first, the failing check last.
    const rows: NeedsRow[] = [
      { kind: 'parked', what: 'p', action: { label: 'Open', href: '/p' } },
      { kind: 'briefing', what: 'b', action: { label: 'Answer', href: '/b' } },
      { kind: 'change', what: 'c', action: { label: 'Review and confirm', href: '/c' } },
      { kind: 'check', what: 'k', action: { label: 'Fix in System', href: '/system' } },
    ];
    expect(rankNeeds(rows).map((r) => r.kind)).toEqual(['check', 'change', 'briefing', 'parked']);
    // Non-vacuous: the insertion order is the reverse of the ranking.
    expect(rows.map((r) => r.kind)).not.toEqual(['check', 'change', 'briefing', 'parked']);
    // And as Home renders them, from each source.
    const html = renderHome(
      home({
        zones: [zone('A')],
        items: [wi('A', 'parked')],
        briefings: [br('A')],
        pending: [{ change: pending() }],
        doctorFails: [fail('A')],
      }),
    );
    expect(kinds(html)).toEqual(['check', 'change', 'briefing', 'parked']);
    const needs = needsOf(html);
    expect(needs).toContain('<span class="chip">Failing check</span>');
    expect(needs).toContain('<span class="chip">Guarded change</span>');
    expect(needs).toContain('<span class="chip">Briefing</span>');
    expect(needs).toContain('<span class="chip">Parked</span>');
    expect(needs).toContain('<a href="/system">Fix in System</a>');
    expect(needs).toContain('<a href="/config/confirm/pend-1">Review and confirm</a>');
    expect(needs).toMatch(/<a href="\/briefings\/\d+">Answer<\/a>/);
    expect(needs).toMatch(/<a href="\/projects\/A\/work\/\d+">Open<\/a>/);
    // One action link per row (a chat link aside, which only a chat-staged change has).
    for (const row of needs.match(/<li class="needs-row".*?<\/li>/g) ?? [])
      expect(row.match(/<a /g)).toHaveLength(1);
  });

  test('failing checks are grouped per project, and only a configured project counts', () => {
    const html = renderHome(
      home({
        zones: [zone('A'), zone('B')],
        doctorFails: [fail('A', 'one'), fail('B', 'two'), fail('A', 'three'), fail('gone', 'x')],
      }),
    );
    const rows = needsOf(html).match(/<li class="needs-row".*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('octo/A: 2 failing checks (one, three)');
    expect(rows[1]).toContain('octo/B: 1 failing check (two)');
  });

  test('Needs you lists the first NEEDS_CAP rows, ranked, then "Show all"; with needsAll, every row', () => {
    const backlog = {
      zones: [zone('A')],
      items: Array.from({ length: 15 }, () => wi('A', 'parked')),
      briefings: Array.from({ length: 15 }, () => br('A')),
      doctorFails: [fail('A')],
    };
    const capped = renderHome(home(backlog));
    // The check outranks the backlog, so it is never cut.
    expect(kinds(capped)).toEqual(['check', ...Array<string>(NEEDS_CAP - 1).fill('briefing')]);
    expect(needsOf(capped)).toContain(
      `<p class="more">${31 - NEEDS_CAP} more. <a href="/?needs=all#waiting-on-you">Show all 31</a></p>`,
    );
    // Projects, Capacity and Pipeline still follow.
    expect(capped).toContain('id="projects"');
    const all = renderHome(home({ ...backlog, needsAll: true }));
    expect(kinds(all)).toHaveLength(31);
    expect(needsOf(all)).not.toContain('class="more"');
    // At the cap exactly, nothing is cut and no link shows.
    const exact = renderHome(
      home({ zones: [zone('A')], briefings: Array.from({ length: NEEDS_CAP }, () => br('A')) }),
    );
    expect(kinds(exact)).toHaveLength(NEEDS_CAP);
    expect(needsOf(exact)).not.toContain('Show all');
  });

  test('"Nothing needs you" shows only when every source is empty', () => {
    const empty = renderHome(home({ zones: [zone('A')] }));
    expect(needsOf(empty)).toContain('<p class="empty">Nothing needs you</p>');
    const only: [string, Partial<HomeState>][] = [
      ['check', { doctorFails: [fail('A')] }],
      ['change', { pending: [{ change: pending() }] }],
      ['briefing', { briefings: [br('A')] }],
      ['parked', { items: [wi('A', 'parked')] }],
    ];
    for (const [kind, over] of only) {
      const html = renderHome(home({ zones: [zone('A')], ...over }));
      expect(needsOf(html), kind).not.toContain('Nothing needs you');
      expect(kinds(html), kind).toEqual([kind]);
    }
  });

  test('only a parked work item is a Needs you row; ready, running, in review and done ones are not', () => {
    const html = renderHome(
      home({
        zones: [zone('A')],
        items: [
          wi('A', 'ready'),
          wi('A', 'in_flight'),
          wi('A', 'pr_open'),
          wi('A', 'done'),
          wi('A', 'parked'),
        ],
      }),
    );
    expect(kinds(html)).toEqual(['parked']);
    const none = renderHome(
      home({ zones: [zone('A')], items: [wi('A', 'ready'), wi('A', 'pr_open')] }),
    );
    expect(kinds(none)).toEqual([]);
    expect(needsOf(none)).toContain('Nothing needs you');
  });

  test('a pending change row: the first guarded item, "and N more", expiry, and the chat it came from; never the patch', () => {
    const one = renderHome(home({ zones: [zone('A')], pending: [{ change: pending() }] }));
    expect(one).toContain('Turns on the MCP server');
    // The expiry is a relativeTime the live script ignores, not minutes written by hand.
    expect(one).toMatch(
      /<small class="expiry">expires <span data-live-ignore><time datetime="[^"]+" title="[^"]+">in 7 min<\/time><\/span><\/small>/,
    );
    expect(one).not.toContain('from chat:');
    expect(one).not.toContain('PATCH-ONLY-VALUE-x9');
    expect(one).not.toContain('secretOnlyInPatch');
    const three = renderHome(
      home({
        zones: [zone('A')],
        pending: [
          {
            change: pending({
              guarded: [
                { path: 'a', consequence: 'First <thing>' },
                { path: 'b', consequence: 'Second' },
                { path: 'c', consequence: 'Third' },
              ],
            }),
            chat: { threadId: 42, title: 'Tune <the> zone' },
          },
        ],
      }),
    );
    expect(three).toContain('First &lt;thing&gt; and 2 more');
    expect(three).not.toContain('Second');
    expect(three).toContain('from chat: <a href="/chat/42">Tune &lt;the&gt; zone</a>');
  });

  test("a briefing row's time is relative, and a held zone's briefing or a notice is not a row", () => {
    const html = renderHome(
      home({
        zones: [zone('A'), zone('B')],
        modes: { B: 'paused' },
        briefings: [br('A'), br('B'), { ...br('A'), kind: 'promote_held' } as Briefing],
      }),
    );
    expect(kinds(html)).toEqual(['briefing']);
    expect(needsOf(html)).toContain(`<time datetime="${ago(1)}"`);
    expect(needsOf(html)).toContain('1 h ago');
  });

  test('a project row: name, mode badge, state sentence, New issue and Open; needs-you first', () => {
    const html = renderHome(
      home({
        zones: [zone('idle'), zone('work'), zone('block'), zone('need')],
        items: [wi('block', 'parked')],
        drops: [dr('work', 'running')],
        briefings: [br('need')],
      }),
    );
    const order = [
      ...html.matchAll(/class="project-row" data-state="([^"]+)" data-zone="([^"]+)"/g),
    ].map((m) => `${m[2]}:${m[1]}`);
    expect(order).toEqual(['need:needs-you', 'block:blocked', 'work:working', 'idle:idle']);
    expect(html).toContain(
      '<li class="project-row" data-state="idle" data-zone="idle"><a href="/projects/idle">octo/idle</a> <span class="badge ok">active</span> <span class="state">Idle: nothing queued or running.</span> <a href="/projects/idle/issues/new">New issue</a> <a href="/projects/idle">Open</a></li>',
    );
    expect(html).toContain(
      'Needs you: 0 running, 0 queued, 0 PRs open, 0 merged (24h), 1 briefing needs you.',
    );
  });

  test('zone links carry the zone id URL-encoded', () => {
    const B = zone('a b');
    const html = renderHome(home({ zones: [zone('A'), B], items: [wi('a b', 'parked')] }));
    expect(listHref('/activity/work', 'a b', 'parked')).toBe('/projects/a%20b/work?state=parked');
    expect(html).toContain('href="/projects/a%20b"');
    expect(html).toContain('href="/projects/a%20b/issues/new"');
    expect(html).toMatch(/href="\/projects\/a%20b\/work\/\d+">Open<\/a>/);
  });

  test('Pipeline: five numbers, each linking to Activity filtered to that state', () => {
    const html = renderHome(home({ zones: [zone('A')] }));
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    const tiles = [
      ...pipeline.matchAll(
        /<a class="tile" data-tile="([^"]+)" href="([^"]*)"><b>(\d+)<\/b><span>([^<]+)<\/span>/g,
      ),
    ].map((m) => [m[1], m[2], m[4]]);
    expect(tiles).toEqual([
      ['ready', '/activity/work?state=ready', 'Ready'],
      ['running', '/activity/drops?state=active&amp;kind=all', 'Running'],
      ['in-review', '/activity/work?state=pr_open', 'In review'],
      ['parked', '/activity/work?state=parked', 'Parked'],
      ['merged', '/activity/work?state=done', 'Merged (24 h)'],
    ]);
  });

  test('the Pipeline numbers equal the counts the Activity board shows for the same state', () => {
    const zones = [zone('A'), zone('B')];
    const busy = wi('B', 'ready');
    const done = wi('A', 'done');
    const old = wi('B', 'done');
    const items = [
      wi('A', 'ready'),
      wi('A', 'ready'),
      busy,
      wi('A', 'in_flight'),
      wi('B', 'pr_open'),
      wi('A', 'parked'),
      wi('B', 'parked'),
      wi('B', 'parked'),
      done,
      old,
    ];
    const drops = [{ ...dr('B', 'running'), workItemId: busy.id }, dr('A', 'running')];
    const merges = [
      { zoneId: 'A', at: ago(2), workItemId: done.id },
      { zoneId: 'B', at: ago(30), workItemId: old.id },
    ];
    const html = renderHome(home({ zones, items, drops, merges24h: merges }));
    const board = renderBoard({ zones, items, drops, merges, now: NOW });
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    const shown: Record<string, string | undefined> = {};
    const counted: Record<string, string | undefined> = {};
    for (const c of BOARD_COLUMNS) {
      shown[c] = new RegExp(`data-tile="${c}" href="[^"]*"><b>(\\d+)</b>`).exec(pipeline)?.[1];
      counted[c] = new RegExp(`data-column="${c}"><h3>[^<]*<span class="count">(\\d+)</span>`).exec(
        board,
      )?.[1];
    }
    expect(shown).toEqual(counted);
    // Non-vacuous: every column has its own, nonzero count.
    expect(shown).toEqual({ ready: '2', running: '2', 'in-review': '1', parked: '3', merged: '1' });
  });

  test('a merge count that failed to load shows "–", never 0', () => {
    const html = renderHome(home({ zones: [zone('A')], merges24h: undefined }));
    const pipeline = html.slice(html.indexOf('id="pipeline"'));
    expect(pipeline).toContain(
      '<a class="tile" data-tile="merged" href="/activity/work?state=done"><b title="unavailable">–</b>',
    );
  });

  test("no element of class tile remains but Pipeline's, and the removed sections are gone", () => {
    const html = renderHome(
      home({
        zones: [zone('A'), zone('B')],
        items: [wi('A', 'ready'), wi('B', 'parked')],
        drops: [dr('A', 'running')],
        briefings: [br('A')],
        sticks: [],
      }),
    );
    const at = html.indexOf('id="pipeline"');
    const outside = html.slice(0, at) + html.slice(html.indexOf('</section>', at));
    expect(outside).not.toMatch(/class="[^"]*\btiles?\b[^"]*"/);
    expect(html.slice(at).match(/class="tile"/g)).toHaveLength(5);
    for (const h of [
      'class="totals" aria-label="Totals"',
      'class="card zone-card"',
      'Running now',
      '<h2>Crew</h2>',
      '<h2>Work items</h2>',
      '<h2>Drops</h2>',
      '<h2>Up next</h2>',
      'Overage',
      '<dt>Gate</dt>',
    ])
      expect(html, h).not.toContain(h);
    // The kill switch stays where it is, until the top-bar slice.
    expect(html).toContain('<form id="kill">');
    // Top to bottom: Needs you, Projects, Capacity, Pipeline.
    const order = ['id="waiting-on-you"', 'id="projects"', 'id="capacity"', 'id="pipeline"'].map(
      (x) => html.indexOf(x),
    );
    expect(order.every((x) => x > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<title>Jumpmaster: Home</title>');
  });

  test('no zones: "No project yet", and the Add a project link', () => {
    const html = renderHome(home({ zones: [], setup: { active: false, addProject: true } }));
    expect(html).toContain('No project yet');
    expect(html).toContain('<a href="/projects/new">Add a project</a>');
  });
});

test('a credits stop briefing is listed whatever its zone, configured or not (#541)', async () => {
  const h = await twoZones();
  const stop = (zoneId: string) => ({
    ...brief(zoneId, 'credits:stop:d1'),
    kind: 'credits_required' as const,
  });
  raiseBriefing(h.db, stop('old'), h.now());
  raiseBriefing(h.db, stop(''), h.now());
  raiseBriefing(h.db, brief('old', 'crew:o1'), h.now());
  const f = floorBriefings(h.db, [
    { id: 'main', repo: 'octo/demo', mode: 'active' },
    { id: 'shadow', repo: 'octo/shadow', mode: 'active' },
  ]);
  expect(f.listed.map((b) => [b.zoneId, b.subject])).toEqual([
    ['main', 'crew:m1'],
    ['shadow', 'crew:s1'],
    ['shadow', 'crew:s2'],
    ['old', 'credits:stop:d1'],
    ['', 'credits:stop:d1'],
  ]);
});

test('a paused zone that is still configured holds its credits stop briefing (#541)', async () => {
  const h = await twoZones();
  raiseBriefing(
    h.db,
    { ...brief('shadow', 'credits:stop:d1'), kind: 'credits_required' as const },
    h.now(),
  );
  const f = floorBriefings(h.db, [
    { id: 'main', repo: 'octo/demo', mode: 'active' },
    { id: 'shadow', repo: 'octo/shadow', mode: 'paused' },
  ]);
  expect(f.listed.map((b) => b.subject)).toEqual(['crew:m1']);
  expect(f.held).toMatchObject([{ zoneId: 'shadow', count: 3 }]);
});

test('the Home row of a credits stop on a removed zone leads to a page that shows it (#593, #625)', async () => {
  const h = await twoZones();
  for (const zoneId of ['old', '']) {
    raiseBriefing(
      h.db,
      { ...brief(zoneId, 'credits:stop:d1'), kind: 'credits_required' as const },
      h.now(),
    );
  }
  const home = (await h.view('/')).body;
  const rows = [
    ...home.matchAll(
      /<li class="needs-row" data-kind="briefing">.*?([^>]*): Decide credits:stop:d1 in [^<]*<.*?<a href="([^"]*)">Answer<\/a><\/li>/g,
    ),
  ];
  expect(rows.map((m) => (m[1] ?? '').trim()).sort()).toEqual(['All dispatch stopped', 'old']);
  for (const [, , href = ''] of rows) {
    expect(href).toMatch(/^\/briefings\/\d+$/);
    const res = await h.view(href);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Decide credits:stop:d1 in');
    // Every briefings link on it lands without a redirect chain.
    for (const [, link = ''] of res.body.matchAll(/href="(\/briefings[^"]*)"/g)) {
      const next = await h.view(link.replaceAll('&amp;', '&'));
      expect(next.statusCode, link).toBe(200);
    }
  }
});
