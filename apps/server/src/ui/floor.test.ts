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
import { type FloorCounts, floorCounts, listHref } from './floor.js';
import { type HomeState, renderHome } from './pages.js';

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
  expect(home).toContain('<a href="/briefings?zone=main">octo/demo: 1 waiting</a>');
  expect(home).not.toContain('octo/shadow: 2 waiting');
  expect(home).not.toContain('Decide crew:m1 in main?');
  expect(home).not.toContain('Decide crew:s1 in shadow?');
  expect(home).not.toContain('Decide crew:s2 in shadow?');
  expect(home).toContain('1 decision waiting');
  expect(home).toContain('Waiting on you: 1 briefing');
  expect(home).toContain(
    '<a href="/briefings?zone=shadow">octo/shadow: paused, 2 briefings held</a>',
  );
  // Untouched, and still reachable from that link.
  expect(listBriefings(h.db, { zoneId: 'shadow', state: 'open' })).toHaveLength(2);
  const view = (await h.view('/briefings?zone=shadow')).body;
  expect(view).toContain('Decide crew:s1 in shadow?');
  expect(view).toContain('Decide crew:s2 in shadow?');
  expect(view).not.toContain('Decide crew:m1 in main?');
  expect(view).toContain('Dismiss all 2 briefings of octo/shadow');
  expect(view).toContain('data-ask="Dismiss 2 briefings of octo/shadow?');
  expect(view).toContain('data-zone="shadow"');
});

test('a zone in observe is collapsed too', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'observe', h.now());
  const home = (await h.view('/')).body;
  expect(home).not.toContain('Decide crew:s1 in shadow?');
  expect(home).toContain('octo/shadow: observe, 2 briefings held');
});

test('resuming the paused zone lists its briefings on the floor again', async () => {
  const h = await twoZones();
  setZoneMode(h.db, 'shadow', 'paused', h.now());
  setZoneMode(h.db, 'shadow', 'active', h.now());
  const home = (await h.view('/')).body;
  expect(home).toContain('<a href="/briefings?zone=shadow">octo/shadow: 2 waiting</a>');
  expect(home).toContain('<a href="/briefings?zone=main">octo/demo: 1 waiting</a>');
  expect(home.indexOf('octo/shadow: 2 waiting')).toBeLessThan(home.indexOf('octo/demo: 1 waiting'));
  expect(home).toContain('3 decisions waiting');
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
  expect(home).toContain('<a class="tile" data-tile="needs-you" href="/briefings"><b>1</b>');
  expect(home).toContain('Waiting on you: 1 briefing');
  expect(home).not.toContain('Waiting on you: 2 briefings');
  expect(home).toContain('1 decision waiting');
});

test('only a promote_held open: Needs you is 0, and the Floor shows no notice count', async () => {
  const h = await oneZone();
  raiseBriefing(h.db, held('main', 'issue:1'), h.now());
  const home = (await h.view('/')).body;
  expect(home).toContain('<a class="tile" data-tile="needs-you" href="/briefings"><b>0</b>');
  expect(home).not.toContain('Waiting on you: 1 briefing');
  expect(home).not.toContain('Going ahead unless you stop it');
  expect(home).toContain('Nothing is waiting on you.');
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
  expect(home).toContain('<a class="tile" data-tile="needs-you" href="/briefings"><b>0</b>');
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

  test('a held card reads PAUSED or OBSERVING by mode, after working ones (#495)', () => {
    const paused = renderHome(
      home({
        zones: [zone('A')],
        modes: { A: 'paused' },
        items: [wi('A', 'ready'), wi('A', 'ready'), wi('A', 'ready')],
      }),
    );
    expect(paused).toMatch(
      /data-state="held" data-zone="A">.*?<span class="card-state">PAUSED<\/span>/,
    );
    const observing = renderHome(
      home({ zones: [zone('A')], modes: { A: 'observe' }, items: [wi('A', 'ready')] }),
    );
    expect(observing).toContain('<span class="card-state">OBSERVING</span>');
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

describe('the dashboard', () => {
  const cardOrder = (html: string) =>
    [...html.matchAll(/class="card zone-card" data-state="([^"]+)" data-zone="([^"]+)"/g)].map(
      (m) => `${m[2]}:${m[1]}`,
    );

  test('cards render needs-you, then blocked, working and idle, whatever the configured order', () => {
    const html = renderHome(
      home({
        zones: [zone('idle'), zone('work'), zone('block'), zone('need')],
        items: [wi('block', 'parked')],
        drops: [dr('work', 'running')],
        briefings: [br('need')],
      }),
    );
    expect(cardOrder(html)).toEqual([
      'need:needs-you',
      'block:blocked',
      'work:working',
      'idle:idle',
    ]);
    expect(html).toContain('Idle: nothing queued or running.');
  });

  test('a working card shows zero Working counts as 0', () => {
    const html = renderHome(home({ zones: [zone('A')], drops: [dr('A', 'running')] }));
    const card = html.slice(html.indexOf('data-zone="A"'));
    expect(card).toContain('href="/projects/A/work?state=ready"><b>0</b><span>Queued</span>');
  });

  test('a merge count that failed to load shows "–", never 0', () => {
    const html = renderHome(home({ zones: [zone('A')], merges24h: undefined }));
    const tiles = [...html.matchAll(/<a class="tile" data-tile="merged"[^>]*>.*?<\/a>/g)].map(
      (m) => m[0],
    );
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(t).toContain('<b title="unavailable">–</b>');
      expect(t).not.toContain('>0<');
    }
    expect(
      floorCounts(home({ zones: [zone('A')], merges24h: undefined }), NOW).totals.merged24h,
    ).toBeNull();
  });

  test('zone links carry the zone id URL-encoded', () => {
    const B = zone('a b');
    const html = renderHome(home({ zones: [zone('A'), B], items: [wi('a b', 'parked')] }));
    expect(listHref('/activity/work', 'a b', 'parked')).toBe('/projects/a%20b/work?state=parked');
    expect(html).toContain('<a href="/projects/a%20b/work?state=parked">1 parked</a>');
    expect(html).toContain('href="/projects/a%20b"');
    expect(html).toContain('href="/activity/drops?zone=a%20b&amp;state=active&amp;kind=all"');
    expect(html).toMatch(/data-tile="running" href="\/activity\/drops\?[^"]*kind=all"/);
    const needs = renderHome(home({ zones: [B], briefings: [br('a b')] }));
    expect(needs).toContain('<a href="/briefings?zone=a%20b">1 briefing needs you</a>');
  });

  test('the totals strip links each count to its list', () => {
    const html = renderHome(home({ zones: [zone('A')] }));
    const strip = html.slice(
      html.indexOf('<nav class="totals"'),
      html.indexOf('</nav>', html.indexOf('<nav class="totals"')),
    );
    for (const href of [
      '/activity/drops?state=active&amp;kind=all',
      '/activity/work?state=ready',
      '/activity/work?state=pr_open',
      '/activity/work?state=done',
      '/activity/work?state=parked',
      '/briefings',
    ])
      expect(strip).toContain(`href="${href}"`);
  });

  test('the removed sections are gone, and sticks are collapsed', () => {
    const html = renderHome(home({ zones: [zone('A')], items: [wi('A', 'ready')], sticks: [] }));
    for (const h of [
      '<h2>Work items</h2>',
      '<h2>Drops</h2>',
      '<h2>Drop zones</h2>',
      '<h2>Outbox</h2>',
      '<h2>Up next</h2>',
      '<h2>Last rate limit</h2>',
    ])
      expect(html).not.toContain(h);
    expect(html).toContain('<details id="sticks"');
    expect(html).toContain('<summary>Sticks: 0 live</summary>');
  });

  test('no zones: no totals strip, and "No project yet"', () => {
    const html = renderHome(home({ zones: [], setup: { active: false, addProject: true } }));
    expect(html).not.toContain('class="totals"');
    expect(html).toContain('No project yet');
    expect(html).toContain('<a href="/projects/new">Add a project</a>');
  });
});

describe('pending guarded changes on the floor (#507)', () => {
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
  const strip = (html: string) =>
    html.slice(
      html.indexOf('<nav class="totals"'),
      html.indexOf('</nav>', html.indexOf('<nav class="totals"')),
    );

  test('one pending change and no briefings: Needs you = 1', () => {
    const state = home({ zones: [zone('A')], briefings: [], pending: [{ change: pending() }] });
    expect(floorCounts(state, NOW).totals.needsYou).toBe(1);
    expect(floorCounts(home({ zones: [zone('A')], briefings: [] }), NOW).totals.needsYou).toBe(0);
    expect(strip(renderHome(state))).toContain('<b>1</b><span>Needs you</span>');
  });

  test('a row: the first guarded item, "and N more", expiry and the Review and confirm link', () => {
    const one = renderHome(
      home({ zones: [zone('A')], briefings: [], pending: [{ change: pending() }] }),
    );
    expect(one).toContain('Turns on the MCP server');
    expect(one).not.toContain('more</');
    expect(one).toContain('expires in 7 min');
    expect(one).toContain('<a href="/config/confirm/pend-1">Review and confirm</a>');
    expect(one).not.toContain('from chat:');
    const three = renderHome(
      home({
        zones: [zone('A')],
        briefings: [],
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

  const tileHref = (html: string) =>
    /<a class="tile" data-tile="needs-you" href="([^"]*)">/.exec(strip(html))?.[1];

  test('with only a pending change, the Needs you tile links to where the change is listed (#585)', () => {
    const html = renderHome(
      home({ zones: [zone('A')], briefings: [], pending: [{ change: pending() }] }),
    );
    const tile = tileHref(html);
    expect(tile).not.toBe('/briefings');
    expect(tile).toBe('#waiting-on-you');
    const card = html.slice(html.indexOf('id="waiting-on-you"'));
    expect(html).toContain('id="waiting-on-you"');
    expect(card).toContain('<a href="/config/confirm/pend-1">Review and confirm</a>');
    expect(html).not.toContain('PATCH-ONLY-VALUE-x9');
  });

  test('with briefings only, the Needs you tile links to /briefings (#585)', () => {
    const html = renderHome(home({ zones: [zone('A')], briefings: [br('A')] }));
    expect(strip(html)).toContain('<b>1</b><span>Needs you</span>');
    expect(tileHref(html)).toBe('/briefings');
  });

  test('with briefings and a pending change, the tile leads to the card listing both (#585)', () => {
    const html = renderHome(
      home({ zones: [zone('A')], briefings: [br('A')], pending: [{ change: pending() }] }),
    );
    expect(strip(html)).toContain('<b>2</b><span>Needs you</span>');
    expect(tileHref(html)).toBe('#waiting-on-you');
    const card = html.slice(html.indexOf('id="waiting-on-you"'));
    expect(card.slice(0, card.indexOf('</section>'))).toContain(
      '<a href="/config/confirm/pend-1">Review and confirm</a>',
    );
    expect(card.slice(0, card.indexOf('</section>'))).toContain(
      '1 decision waiting. <a href="/briefings">',
    );
  });

  test('with nothing waiting, the tile still links to /briefings (#585)', () => {
    const html = renderHome(home({ zones: [zone('A')], briefings: [] }));
    expect(tileHref(html)).toBe('/briefings');
  });

  test('the row never renders a value that is only in the patch', () => {
    const html = renderHome(
      home({ zones: [zone('A')], briefings: [], pending: [{ change: pending() }] }),
    );
    expect(html).toContain('Review and confirm');
    expect(html).not.toContain('PATCH-ONLY-VALUE-x9');
    expect(html).not.toContain('secretOnlyInPatch');
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

test('the Floor row of a credits stop on a removed zone leads to a page that lists it (#593)', async () => {
  const h = await twoZones();
  for (const zoneId of ['old', '']) {
    raiseBriefing(
      h.db,
      { ...brief(zoneId, 'credits:stop:d1'), kind: 'credits_required' as const },
      h.now(),
    );
  }
  const home = (await h.view('/')).body;
  const rows = [...home.matchAll(/<li><a href="([^"]*)">([^<]*): 1 waiting<\/a><\/li>/g)];
  const stops = rows.filter((m) => !(m[1] ?? '').includes('zone=main'));
  expect(stops.map((m) => m[2])).toEqual(expect.arrayContaining(['old', 'All dispatch stopped']));
  expect(home).toContain('<a href="/briefings?zone=main">octo/demo: 1 waiting</a>');
  for (const [, href = '', label = ''] of stops) {
    expect(label).not.toBe('');
    expect(href).not.toContain('zone=');
    const res = await h.view(href.replaceAll('&amp;', '&'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Decide credits:stop:d1 in old?');
    expect(res.body).toContain('Decide credits:stop:d1 in ?');
  }
  const own = listBriefings(h.db, { state: 'open' }).filter((b) => b.zoneId !== 'main');
  for (const b of own.filter((x) => x.subject.startsWith('credits:stop'))) {
    const page = await h.view(`/briefings/${b.id}`);
    expect(page.statusCode).toBe(200);
    for (const [, href = ''] of page.body.matchAll(/href="(\/briefings[^"]*)"/g)) {
      const res = await h.view(href.replaceAll('&amp;', '&'));
      expect(res.statusCode).toBe(200);
    }
  }
  expect((await h.view('/briefings?zone=old')).statusCode).toBe(404);
});
