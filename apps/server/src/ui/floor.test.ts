import { expect, test } from 'vitest';
import { listBriefings, raiseBriefing } from '../briefings.js';
import { listOutbox, setZoneMode } from '../db/repo.js';
import { harness } from '../test/flowHarness.js';

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
  expect(home).toContain('Decide crew:m1 in main?');
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
  expect(home).toContain('Decide crew:s1 in shadow?');
  expect(home).toContain('Decide crew:s2 in shadow?');
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
