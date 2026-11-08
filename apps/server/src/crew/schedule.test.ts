import { beforeEach, describe, expect, test } from 'vitest';
import {
  listBriefings,
  raiseBriefing,
  ruleBriefing,
  syncParkBriefings,
  whyBasis,
} from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import {
  getDrop,
  insertDrop,
  insertStick,
  listObservations,
  setKilled,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  updateDrop,
} from '../db/repo.js';
import { reconcileZone } from '../flow/reconcile.js';
import { zonePass } from '../flow/snapshot.js';
import { refreshGoals } from '../goals.js';
import { leaseNextDrop } from '../leases.js';
import { promptVersions } from '../payloads.js';
import { crewOn, crewWorld, ISSUE_BODY } from '../test/crew.js';
import { makeZone, usageCfg, type ZoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { applyCrewActions } from './actions.js';
import { type CrewInputJson, enqueueCrew, nextCrewWork, requestCrewCycle } from './schedule.js';
import { getCrewIssue, setCrewIssue } from './store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

let w: ZoneWorld;
beforeEach(async () => {
  w = await crewWorld();
});

async function enqueue(at = t0, zone: DropZoneConfig = w.zone): Promise<string | null> {
  const pass = await zonePass(w.forges, zone, 'main');
  return enqueueCrew(w.db, w.forges, zone, pass, promptVersions(), usageCfg, at);
}

const work = (id: string) =>
  (JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}') as CrewInputJson).work;

/** Finishes a crew drop so the next one may start. */
const finish = (id: string) => updateDrop(w.db, id, { state: 'succeeded' });

function stagedIssue(key = 'add-docs'): number {
  const r = applyCrewActions(
    w.db,
    w.zone,
    {
      fileIssues: [
        { key, objective: 'document-every-endpoint', title: `Do ${key}`, body: ISSUE_BODY },
      ],
    },
    { kind: 'drop', dropId: 'd0' },
    t0,
  );
  const id = r.filed[0] ?? -1;
  setCrewIssue(w.db, id, { state: 'staged', number: 40, bodySha: 'sha-1' }, t0);
  return id;
}

function parkedItem(): number {
  const id = w.item(1, 'ready');
  setWorkItemState(w.db, id, 'parked', 'heal budget exhausted', t0);
  syncParkBriefings(w.db, w.zone, t0);
  return id;
}

describe('enqueueCrew', () => {
  test('nothing is enqueued when disabled, paused, killed, throttled or over the daily cap', async () => {
    expect(await enqueue(t0, makeZone())).toBeNull(); // crew.enabled defaults to false

    setZoneMode(w.db, 'main', 'paused', t0);
    expect(await enqueue()).toBeNull();
    setZoneMode(w.db, 'main', 'active', t0);

    setKilled(w.db, true, t0);
    expect(await enqueue()).toBeNull();
    setKilled(w.db, false, t0);

    setUsageState(
      w.db,
      { status: 'allowed', fiveHourUtil: 0.95, observedAt: t0.toISOString() },
      t0,
    );
    expect(await enqueue()).toBeNull(); // finishing_only
    setUsageState(w.db, { fiveHourUtil: 0.1 }, t0);

    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 2, cycleMinutes: 1 } };
    let at = t0;
    for (let n = 0; n < 2; n++) {
      const id = await enqueue(at, capped);
      expect(id).not.toBeNull();
      finish(id ?? '');
      at = plus(at, 2 * MIN);
    }
    expect(await enqueue(at, capped)).toBeNull();
    // The cap is a trailing 24 hours.
    expect(await enqueue(plus(t0, 25 * HOUR), capped)).not.toBeNull();
  });

  test('rate-limited and lost crew drops do not count toward maxDropsPerDay', async () => {
    const capped = { ...w.zone, crew: { ...crewOn, maxDropsPerDay: 1, cycleMinutes: 1 } };
    const a = (await enqueue(t0, capped)) ?? '';
    updateDrop(w.db, a, { state: 'lost' });
    const b = (await enqueue(plus(t0, 2 * MIN), capped)) ?? '';
    expect(b).not.toBe('');
    updateDrop(w.db, b, {
      state: 'cancelled',
      resultJson: JSON.stringify({ status: 'rate_limited', gates: [] }),
    });
    const c = (await enqueue(plus(t0, 4 * MIN), capped)) ?? '';
    expect(c).not.toBe('');
    finish(c);
    expect(await enqueue(plus(t0, 6 * MIN), capped)).toBeNull();
  });

  test('an unparsed GOAL.md blocks the lead cycle but not diagnose or refute', async () => {
    w.f.state.files.set('main:GOAL.md', '# nothing here');
    const issue = stagedIssue();
    await refreshGoals(w.db, w.f.author, w.zone, 'main', t0);
    parkedItem();
    const d = (await enqueue()) ?? '';
    expect(work(d).role).toBe('diagnose');
    finish(d);
    const r = (await enqueue(plus(t0, MIN))) ?? '';
    expect(work(r)).toEqual({ role: 'refute', crewIssueId: issue });
    finish(r);
    setCrewIssue(w.db, issue, { refutedSha: 'sha-1' }, t0);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toEqual({ role: 'crew-lead' });
    expect(await enqueue(plus(t0, 2 * MIN))).toBeNull();
  });

  test('with one slot, crew drops lease only after queued item drops, and still lease once the queue drains', async () => {
    insertStick(w.db, { id: 'stick', name: 'stick', tokenHash: 'h', slots: 1 });
    const crew = (await enqueue()) ?? '';
    const item = w.item(2, 'in_flight');
    insertDrop(w.db, {
      id: 'impl',
      dropZoneId: 'main',
      workItemId: item,
      role: 'implement',
      state: 'queued',
      createdAt: plus(t0, MIN).toISOString(),
    });
    expect(leaseNextDrop(w.db, 'stick', plus(t0, 2 * MIN), 'open')?.dropId).toBe('impl');
    updateDrop(w.db, 'impl', { state: 'succeeded' });
    expect(leaseNextDrop(w.db, 'stick', plus(t0, 3 * MIN), 'open')?.dropId).toBe(crew);
  });

  test('diagnose precedes refute precedes the lead cycle; one crew drop at a time', async () => {
    const issue = stagedIssue();
    const item = parkedItem();
    const [briefing] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({
      role: 'diagnose',
      briefingId: briefing?.id,
      itemId: item,
      basis: whyBasis(briefing?.why ?? 'no briefing'),
    });
    const d = (await enqueue()) ?? '';
    expect(work(d).role).toBe('diagnose');
    // Counted at enqueue: diagnose runs once per parked briefing.
    expect(listBriefings(w.db, { zoneId: 'main' })[0]?.diagnoseAttempts).toBe(1);
    expect(await enqueue(plus(t0, MIN))).toBeNull(); // one crew drop at a time
    finish(d);
    const r = (await enqueue(plus(t0, 2 * MIN))) ?? '';
    expect(work(r)).toEqual({ role: 'refute', crewIssueId: issue });
    expect(getCrewIssue(w.db, issue)?.refuteCount).toBe(1);
    finish(r);
    setCrewIssue(w.db, issue, { refutedSha: 'sha-1' }, t0);
    const l = (await enqueue(plus(t0, 3 * MIN))) ?? '';
    expect(work(l)).toEqual({ role: 'crew-lead' });
    finish(l);
    // The next cycle waits cycleMinutes.
    expect(nextCrewWork(w.db, w.zone, plus(t0, 30 * MIN))).toBeNull();
    expect(nextCrewWork(w.db, w.zone, plus(t0, 64 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('a refute is retried until maxRefute, and again once the body changes', async () => {
    const issue = stagedIssue();
    setCrewIssue(w.db, issue, { refuteCount: 2 }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    setCrewIssue(w.db, issue, { refuteCount: 1, refutedSha: 'sha-1' }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    setCrewIssue(w.db, issue, { bodySha: 'sha-2' }, t0);
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'refute', crewIssueId: issue });
  });

  test('a staged issue whose refute budget ran out unjudged is put to Command, once', async () => {
    const issue = stagedIssue();
    setCrewIssue(w.db, issue, { refuteCount: 2 }, t0); // two refute drops died without a verdict
    expect(nextCrewWork(w.db, w.zone, t0)).toEqual({ role: 'crew-lead' });
    nextCrewWork(w.db, w.zone, plus(t0, MIN));
    const open = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'refute_exhausted', subject: `issue:${issue}` });
    expect(open[0]?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
  });

  test('a ruling newer than the last cycle makes the lead cycle due at once', async () => {
    const l = (await enqueue()) ?? '';
    finish(l);
    expect(nextCrewWork(w.db, w.zone, plus(t0, 5 * MIN))).toBeNull();
    const b = raiseBriefing(
      w.db,
      {
        zoneId: 'main',
        kind: 'crew',
        subject: 'crew:x',
        decision: 'd',
        why: 'w',
        options: [
          { id: 'o1', label: 'a', effect: 'none' },
          { id: 'o2', label: 'b', effect: 'none' },
        ],
        source: 'crew',
      },
      t0,
    );
    ruleBriefing(w.db, b, 'o1', '', plus(t0, 6 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 7 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('a ruling on a parked or credits briefing does not make the lead cycle due', async () => {
    finish((await enqueue()) ?? '');
    parkedItem();
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    ruleBriefing(w.db, b?.id ?? -1, 'leave', '', plus(t0, 2 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 3 * MIN))).toBeNull();
  });

  test('crew-cycle makes the lead cycle due now', async () => {
    finish((await enqueue()) ?? '');
    expect(nextCrewWork(w.db, w.zone, plus(t0, 5 * MIN))).toBeNull();
    requestCrewCycle('main', plus(t0, 5 * MIN));
    expect(nextCrewWork(w.db, w.zone, plus(t0, 6 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('observe records would_enqueue:crew-lead and creates no drop', async () => {
    setZoneMode(w.db, 'main', 'observe', t0);
    expect(await enqueue()).toBeNull();
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 });
    expect(listObservations(w.db, 'main').map((o) => o.action)).toEqual([
      'would_enqueue:crew-lead',
    ]);
  });

  test('the rendered input is stored on the drop', async () => {
    const id = (await enqueue()) ?? '';
    const stored = JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}') as CrewInputJson;
    expect(stored.input).toContain('LIGHTHOUSE-TEXT');
    expect(stored.input).toContain(`<<<jm-data:${id}:begin`);
    expect(getDrop(w.db, id)).toMatchObject({
      role: 'crew-lead',
      workItemId: null,
      state: 'queued',
      promptVersion: promptVersions()['crew-lead'],
    });
  });

  test('reconcileZone enqueues crew work after implement work, and none with the crew off', async () => {
    w.item(1, 'ready');
    const pass = await zonePass(w.forges, w.zone, 'main');
    await reconcileZone(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, [], t0);
    const roles = w.db
      .prepare('SELECT role FROM drops ORDER BY rowid')
      .all()
      .map((r) => (r as { role: string }).role);
    expect(roles).toEqual(['implement', 'crew-lead']);

    const off = await crewWorld({ crew: makeZone().crew });
    const offPass = await zonePass(off.forges, off.zone, 'main');
    await reconcileZone(off.db, off.forges, off.zone, offPass, promptVersions(), usageCfg, [], t0);
    expect(off.db.prepare('SELECT COUNT(*) AS n FROM drops').get()).toEqual({ n: 0 });
  });
});
