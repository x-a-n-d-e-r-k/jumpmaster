import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  ruleBriefing,
  syncParkBriefings,
  whyBasis,
} from '../briefings.js';
import type { DropZoneConfig } from '../config.js';
import {
  getDrop,
  getUsageState,
  listEvents,
  setUsageState,
  setWorkItemState,
  updateDrop,
} from '../db/repo.js';
import { zonePass } from '../flow/snapshot.js';
import { promptVersions } from '../payloads.js';
import { applyResult, type ResultDeps } from '../results.js';
import { crewOn, crewWorld, ISSUE_BODY } from '../test/crew.js';
import { usageCfg, type ZoneWorld } from '../test/fixtures.js';
import { plus, t0 } from '../test/helpers.js';
import { applyCrewActions } from './actions.js';
import { crewBodySha, flushCrewOps } from './flush.js';
import { enqueueCrew, nextCrewWork } from './schedule.js';
import { getCrewIssue, listCrewIssues, setCrewIssue } from './store.js';

const MIN = 60_000;

let w: ZoneWorld;
beforeEach(async () => {
  w = await crewWorld();
});

const deps = (zone: DropZoneConfig = w.zone): ResultDeps => ({
  forges: w.forges,
  zone,
  secrets: [],
  usageCfg,
  rand: () => 0.5,
});

/** Enqueues the next crew drop and marks it running, as a lease would. */
async function crewDrop(at = t0, zone: DropZoneConfig = w.zone): Promise<string> {
  const pass = await zonePass(w.forges, zone, 'main');
  const id = await enqueueCrew(w.db, w.forges, zone, pass, promptVersions(), usageCfg, at);
  if (!id) throw new Error('no crew drop enqueued');
  updateDrop(w.db, id, { state: 'running', startedAt: at.toISOString() });
  return id;
}

const completed = (crew: unknown): DropResult => ({ status: 'completed', crew, gates: [] });

const leadOutput = (key = 'add-docs') => ({
  summary: 'Filed one issue.',
  fileIssues: [{ key, objective: 'document-every-endpoint', title: 'Add docs', body: ISSUE_BODY }],
  briefings: [],
});

/** A staged crew issue, as a refute drop sees it. */
function staged(): number {
  const r = applyCrewActions(
    w.db,
    w.zone,
    { fileIssues: leadOutput().fileIssues },
    { kind: 'drop', dropId: 'd0' },
    t0,
  );
  const id = r.filed[0] ?? -1;
  setCrewIssue(w.db, id, { state: 'staged', number: 40, bodySha: 'sha-1' }, t0);
  w.f.state.addIssue({ number: 40, body: ISSUE_BODY, labels: ['agent-staged'] });
  return id;
}

describe('crew-lead results', () => {
  test('a crew-lead result records its actions and stores the report', async () => {
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed(leadOutput()), t0);
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    expect(listCrewIssues(w.db, 'main')).toHaveLength(1);
    const stored = JSON.parse(getDrop(w.db, id)?.resultJson ?? '{}') as {
      crewReport?: unknown;
    };
    expect(stored.crewReport).toEqual({
      filed: [listCrewIssues(w.db, 'main')[0]?.id],
      briefings: [],
      refused: [],
    });
  });

  test('a retried result for a terminal crew drop applies nothing', async () => {
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed(leadOutput()), t0);
    await applyResult(w.db, deps(), id, completed(leadOutput('other')), plus(t0, MIN));
    expect(listCrewIssues(w.db, 'main').map((i) => i.key)).toEqual(['add-docs']);
  });

  test('an invalid crew output fails the drop and applies nothing', async () => {
    const id = await crewDrop();
    const bad = { ...leadOutput(), extra: true };
    await applyResult(w.db, deps(), id, completed(bad), t0);
    expect(getDrop(w.db, id)?.state).toBe('failed');
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    const messages = listEvents(w.db, id).map((e) => String(e.data.message));
    expect(messages.some((m) => m.startsWith('invalid crew output: '))).toBe(true);

    const missing = await crewDrop(plus(t0, 2 * MIN), {
      ...w.zone,
      crew: { ...crewOn, cycleMinutes: 1 },
    });
    await applyResult(w.db, deps(), missing, { status: 'completed', gates: [] }, plus(t0, 2 * MIN));
    expect(getDrop(w.db, missing)?.state).toBe('failed');
  });

  test('a crew drop that is the usage probe releases it on any result', async () => {
    for (const result of [
      completed(leadOutput()),
      { status: 'failed', reason: 'boom', gates: [] } as DropResult,
      completed({ nonsense: 1 }),
    ]) {
      const w2 = await crewWorld();
      w = w2;
      const id = await crewDrop();
      setUsageState(w.db, { probeDropId: id }, t0);
      await applyResult(w.db, deps(), id, result, t0);
      expect(getUsageState(w.db).probeDropId).toBeNull();
    }
  });

  test('a rate-limited crew drop is cancelled and asks for nothing', async () => {
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, { status: 'rate_limited', gates: [] }, t0);
    expect(getDrop(w.db, id)?.state).toBe('cancelled');
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });
});

describe('refute results', () => {
  test('a refute promote with refutePromotes waits a pass with a Reject option before promotion', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, refutePromotes: true } };
    const issue = staged();
    const id = await crewDrop(t0, zone);
    await applyResult(
      w.db,
      deps(zone),
      id,
      completed({ decision: 'promote', findings: ['all good'] }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)).toMatchObject({
      state: 'promote_held',
      holdUntil: null,
      refutedSha: 'sha-1',
    });
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.kind).toBe('promote_held');
    expect(b?.options.map((o) => o.effect)).toEqual(['reject_issue', 'promote_issue']);
    // Within the hold, the flush does not promote.
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 30_000));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
  });

  test('a Reject during the hold rejects; no ruling during it promotes', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, refutePromotes: true } };
    const issue = staged();
    const id = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    ruleBriefing(w.db, b?.id ?? -1, 'reject', '', plus(t0, 10_000));
    const rdeps = { forges: () => w.forges, zone: () => zone };
    await applyPendingRulings(w.db, rdeps, 'main', plus(t0, 20_000));
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 2 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('rejected');

    // A second world: nobody rules, so the hold ends and the issue is promoted.
    w = await crewWorld();
    const other = staged();
    const id2 = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id2, completed({ decision: 'promote', findings: [] }), t0);
    // The live body must match what was staged for the promotion to go ahead.
    setCrewIssue(w.db, other, { bodySha: crewBodySha(ISSUE_BODY) }, t0);
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 2 * MIN)); // starts the hold
    expect(getCrewIssue(w.db, other)?.state).toBe('promote_held');
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 4 * MIN));
    expect(getCrewIssue(w.db, other)?.state).toBe('promoted');
  });

  test('a refute promote without refutePromotes raises a promote briefing and leaves it staged', async () => {
    const issue = staged();
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed({ decision: 'promote', findings: [] }), t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({ kind: 'promote', subject: `issue:${issue}` });
  });

  test('refute revise with an invalid body counts as a rejection', async () => {
    const issue = staged();
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ decision: 'revise', findings: ['too big'], revisedBody: 'just do it' }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)).toMatchObject({
      state: 'rejecting',
      body: ISSUE_BODY,
      findingsJson: JSON.stringify(['too big']),
    });
  });

  test('refute revise with a valid body moves to revising with the new text', async () => {
    const issue = staged();
    const id = await crewDrop();
    const revisedBody = ISSUE_BODY.replace('every endpoint', 'each endpoint');
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ decision: 'revise', findings: [], revisedTitle: 'Add API docs', revisedBody }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)).toMatchObject({
      state: 'revising',
      title: 'Add API docs',
      body: revisedBody,
    });
  });

  test('refute reject moves the issue to rejecting with its findings', async () => {
    const issue = staged();
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed({ decision: 'reject', findings: ['no'] }), t0);
    expect(getCrewIssue(w.db, issue)).toMatchObject({
      state: 'rejecting',
      findingsJson: JSON.stringify(['no']),
    });
  });

  test('a revise at the refute budget raises a refute_exhausted briefing', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, maxRefute: 1 } };
    const issue = staged();
    const id = await crewDrop(t0, zone);
    await applyResult(
      w.db,
      deps(zone),
      id,
      completed({ decision: 'revise', findings: [], revisedBody: `${ISSUE_BODY}\nMore.` }),
      t0,
    );
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({ kind: 'refute_exhausted', subject: `issue:${issue}` });
    expect(b?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
  });
});

describe('diagnose results', () => {
  const diagnosis = {
    diagnosis: 'The test is flaky.',
    recommendation: 'retry',
    detail: 'Re-run it.',
  };

  test('a diagnosis updates the parked briefing beside the server why', async () => {
    const item = w.item(1, 'ready');
    setWorkItemState(w.db, item, 'parked', 'heal budget exhausted', t0);
    syncParkBriefings(w.db, w.zone, t0);
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed(diagnosis), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({
      kind: 'parked',
      why: 'heal budget exhausted',
      diagnosis: 'The test is flaky.',
      diagnosisBasis: whyBasis('heal budget exhausted'),
      recommendation: 'retry: Re-run it.',
    });
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
  });

  test('the diagnosis survives the passes that follow while the item stays parked', async () => {
    const item = w.item(1, 'ready');
    setWorkItemState(w.db, item, 'parked', 'heal budget exhausted', t0);
    syncParkBriefings(w.db, w.zone, t0);
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed(diagnosis), t0);
    syncParkBriefings(w.db, w.zone, plus(t0, MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, 2 * MIN));
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({
      why: 'heal budget exhausted',
      diagnosis: 'The test is flaky.',
      recommendation: 'retry: Re-run it.',
      diagnoseAttempts: 1,
    });
  });

  test('a diagnosis for a briefing already ruled or withdrawn is discarded', async () => {
    for (const end of ['ruled', 'withdrawn'] as const) {
      w = await crewWorld();
      const item = w.item(1, 'ready');
      setWorkItemState(w.db, item, 'parked', 'heal budget exhausted', t0);
      syncParkBriefings(w.db, w.zone, t0);
      const id = await crewDrop();
      const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
      if (end === 'ruled') {
        expect(ruleBriefing(w.db, b?.id ?? -1, 'leave', '', plus(t0, MIN)).ok).toBe(true);
      } else {
        setWorkItemState(w.db, item, 'ready', undefined, plus(t0, MIN)); // left parked
        syncParkBriefings(w.db, w.zone, plus(t0, MIN));
      }
      await applyResult(w.db, deps(), id, completed(diagnosis), plus(t0, 2 * MIN));
      const after = listBriefings(w.db, { zoneId: 'main' }).find((x) => x.id === b?.id);
      expect(after).toMatchObject({ state: end, diagnosis: null, recommendation: '' });
      const messages = listEvents(w.db, id).map((e) => String(e.data.message));
      expect(messages).toContain('diagnosis discarded: the briefing is no longer open');
    }
  });

  test('a diagnosis that lands after the briefing changed is discarded; the new why is diagnosed', async () => {
    const item = w.item(1, 'ready');
    setWorkItemState(w.db, item, 'parked', 'heal budget exhausted', t0);
    syncParkBriefings(w.db, w.zone, t0);
    const id = await crewDrop();
    // While the drop runs, the item parks again for another reason.
    setWorkItemState(w.db, item, 'parked', 'review budget exhausted', plus(t0, MIN));
    syncParkBriefings(w.db, w.zone, plus(t0, MIN));
    await applyResult(w.db, deps(), id, completed(diagnosis), plus(t0, 2 * MIN));
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({
      why: 'review budget exhausted',
      diagnosis: null,
      diagnosisBasis: null,
      recommendation: '',
      diagnoseAttempts: 0,
    });
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    const messages = listEvents(w.db, id).map((e) => String(e.data.message));
    expect(messages).toContain('diagnosis discarded: the briefing changed since it was asked');
    expect(nextCrewWork(w.db, w.zone, plus(t0, 3 * MIN))).toMatchObject({
      role: 'diagnose',
      briefingId: b?.id,
      basis: whyBasis('review budget exhausted'),
    });
  });
});
