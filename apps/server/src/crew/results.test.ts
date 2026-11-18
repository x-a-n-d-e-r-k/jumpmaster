import { readFileSync } from 'node:fs';
import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  MAX_BRIEFING_WHY,
  REFUTE_RECOMMENDATION,
  ruleBriefing,
  syncParkBriefings,
  whyBasis,
} from '../briefings.js';
import type { ClaudeConfig, Config, DropZoneConfig } from '../config.js';
import {
  type Drop,
  getAttempts,
  getDrop,
  getPullRequest,
  getUsageState,
  listEvents,
  listOutbox,
  listWorkItems,
  setUsageState,
  setWorkItemState,
  setZoneMode,
  updateDrop,
  upsertPullRequest,
} from '../db/repo.js';
import { zonePass } from '../flow/snapshot.js';
import { expireLeases } from '../leases.js';
import { unsanitizeForgeText } from '../outbox.js';
import { buildPayload, promptVersions } from '../payloads.js';
import { applyResult, type ResultDeps } from '../results.js';
import { syncDropZone } from '../sync.js';
import { crewOn, crewWorld, ISSUE_BODY, parsedCrew } from '../test/crew.js';
import { makeZone, usageCfg, type ZoneWorld } from '../test/fixtures.js';
import {
  arbiterHarness,
  FABLE_CLAUDE,
  type Harness,
  harness,
  headN,
  ruling,
  toHealsExhausted,
  toPrOpen,
} from '../test/flowHarness.js';
import { plus, t0 } from '../test/helpers.js';
import { applyCrewActions } from './actions.js';
import { crewBodySha, flushCrewOps } from './flush.js';
import { applyArbitrations, applyCrewResult, applyCrewRetries, crewMayRetry } from './results.js';
import { enqueueCrew, nextCrewWork } from './schedule.js';
import {
  getCrewIssue,
  getCrewRetry,
  getTriageRequest,
  insertCrewRetry,
  listCrewIssues,
  listTriageRequests,
  recordTriageRequest,
  setCrewIssue,
} from './store.js';

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

  test('a refute promote on a zone whose config leaves refutePromotes out is held, not asked (#318)', async () => {
    const zone = { ...w.zone, crew: parsedCrew() };
    const issue = staged();
    const id = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
    const open = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(open.map((b) => b.kind)).toEqual(['promote_held']);
    expect(open[0]?.subject).toBe(`issue:${issue}`);
  });

  test('a refute promote with refutePromotes false raises a promote briefing and leaves it staged', async () => {
    const zone = { ...w.zone, crew: parsedCrew({ refutePromotes: false }) };
    const issue = staged();
    const id = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b).toMatchObject({ kind: 'promote', subject: `issue:${issue}` });
  });

  test('a passing refute with refutePromotes off says what the review found and names the setting', async () => {
    expect(w.zone.id).not.toBe('jm');
    staged();
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.kind).toBe('promote');
    expect(b?.decision).toBe(
      'A reviewer found nothing to fix in crew issue #40. Promote it so an agent can start?',
    );
    expect(b?.why).toBe(
      'The crew filed crew issue #40 as staged, so no agent works on it yet. A second agent ' +
        'reviewed it against the code and the spec, looking for criteria that are wrong, vague ' +
        'or untestable, and found none. Promote gives it the ready label; Reject closes it. To ' +
        'let a passing review promote on its own, with a notice you can still reject, set ' +
        'crew.refutePromotes for this zone: ' +
        `jumpmaster ctl zones set ${w.zone.id} crew.refutePromotes=true`,
    );
    expect(b?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
  });

  test('a passing refute with refutePromotes on says it becomes ready unless rejected', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, refutePromotes: true } };
    staged();
    const id = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.kind).toBe('promote_held');
    expect(b?.decision).toBe(
      'A reviewer found nothing to fix in crew issue #40. It becomes ready on the next pass ' +
        'unless you reject it.',
    );
    expect(b?.why).toBe(
      'The crew filed crew issue #40 as staged, and a second agent reviewed it against the code ' +
        'and the spec and found nothing wrong, vague or untestable. This zone lets a passing ' +
        'review promote (crew.refutePromotes is on), so you only need to act to stop it.',
    );
    expect(b?.why).not.toContain('jumpmaster ctl zones set');
  });

  test('a passing refute on an issue with no number names it by its key', async () => {
    const issue = staged();
    setCrewIssue(w.db, issue, { number: null }, t0);
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.decision).toBe(
      'A reviewer found nothing to fix in crew issue add-docs. Promote it so an agent can start?',
    );
    expect(b?.why).toContain('The crew filed crew issue add-docs as staged');
    expect(b?.why).not.toContain('#');
  });

  test("no refute briefing uses the crew's internal words", async () => {
    for (const refutePromotes of [false, true]) {
      w = await crewWorld();
      const zone = { ...w.zone, crew: { ...crewOn, refutePromotes } };
      staged();
      const id = await crewDrop(t0, zone);
      await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
      const all = listBriefings(w.db, { zoneId: 'main' });
      expect(all).toHaveLength(1);
      for (const b of all) {
        for (const text of [b.decision, b.why]) {
          expect(text).not.toContain('survived the refute');
          expect(text).not.toContain('refute verdict');
        }
      }
    }
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

  test('refute revise whose revised body names a protected path is not taken (#247)', async () => {
    const issue = staged();
    const id = await crewDrop();
    const revisedBody = ISSUE_BODY.replace('The API has no docs.', 'Also edit `CODEOWNERS`.');
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ decision: 'revise', findings: ['f'], revisedBody }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'rejecting', body: ISSUE_BODY });
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

  test('a revise at the refute budget is kept as a revision; no briefing is raised here', async () => {
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
    expect(getCrewIssue(w.db, issue)).toMatchObject({
      state: 'revising',
      body: `${ISSUE_BODY}\nMore.`,
    });
    expect(listBriefings(w.db, { zoneId: 'main', state: 'open' })).toEqual([]);
  });
});

describe('refutes of security-touching issues (#384)', () => {
  const FABLE = 'claude-fable-1';
  const fable: ClaudeConfig = { plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 5 };
  const secrets = {
    claudeToken: 'claude-secret',
    githubAuthorToken: 'author-secret',
    githubReviewerToken: 'reviewer-secret',
    joinToken: 'join',
    operatorToken: 'o'.repeat(32),
  } as Config['secrets'];
  const SECURE_BODY = `${ISSUE_BODY}\n## Security-touching checklist\n\n- D2: fails closed.\n`;
  const NOTE = 'This issue is security-touching and its review ran without Fable.';
  const zoneOn = (): DropZoneConfig => ({ ...w.zone, crew: { ...crewOn, refutePromotes: true } });
  const fdeps = (zone: DropZoneConfig): ResultDeps => ({ ...deps(zone), claude: fable });

  /** A staged crew issue with `body`. */
  function stagedWith(body: string): number {
    const id = staged();
    setCrewIssue(w.db, id, { body }, t0);
    return id;
  }

  /** Enqueues the refute and leases it with `claude` as the payload's config. */
  async function leasedRefute(zone: DropZoneConfig, claude: ClaudeConfig): Promise<string> {
    const id = await crewDrop(t0, zone);
    expect(getDrop(w.db, id)?.role).toBe('refute');
    buildPayload(w.db, zone, getDrop(w.db, id) as never, secrets, { claude, now: t0 });
    return id;
  }

  const promote = completed({ decision: 'promote', findings: [] });
  const open = () => listBriefings(w.db, { zoneId: 'main', state: 'open' });
  const expectBriefed = (issue: number) => {
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'staged', refutedSha: 'sha-1' });
    expect(open().map((b) => b.kind)).toEqual(['promote']);
    expect(open()[0]?.why).toContain(NOTE);
  };

  test('on Fable: a promote is held as for any issue', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await leasedRefute(zone, fable);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
    expect(open().map((b) => b.kind)).toEqual(['promote_held']);
    expect(open()[0]?.why).not.toContain(NOTE);
  });

  test('Fable unavailable: the refute ran on the zone model and its promote is briefed, even with refutePromotes on', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const unavailable: ClaudeConfig = { ...fable, plan: 'pro' };
    const id = await leasedRefute(zone, unavailable);
    expect(getDrop(w.db, id)?.requestedModel).toBe(zone.model);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expectBriefed(issue);
  });

  test('an issue without the section on the zone model: held as today', async () => {
    const zone = zoneOn();
    const issue = stagedWith(ISSUE_BODY);
    const id = await leasedRefute(zone, fable);
    expect(getDrop(w.db, id)?.requestedModel).toBe(zone.model);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
    expect(open().map((b) => b.kind)).toEqual(['promote_held']);
  });

  test('a refute stored before #384 (no field) of a security-touching issue: zone model, briefed', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await crewDrop(t0, zone);
    const stored = JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}');
    delete stored.work.securityTouching;
    w.db.prepare('UPDATE drops SET input_json = ? WHERE id = ?').run(JSON.stringify(stored), id);
    buildPayload(w.db, zone, getDrop(w.db, id) as never, secrets, { claude: fable, now: t0 });
    expect(getDrop(w.db, id)?.requestedModel).toBe(zone.model);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expectBriefed(issue);
  });

  test('D2: a Fable request served by another model is briefed, not held', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await leasedRefute(zone, fable);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
    await applyResult(
      w.db,
      fdeps(zone),
      id,
      { ...promote, modelUsage: { 'claude-opus-5-5': { outputTokens: 40 } } },
      t0,
    );
    expect(getDrop(w.db, id)?.servedModel).toBe('claude-opus-5-5');
    expectBriefed(issue);
  });

  test('D2: with no claude config on the result side, it fails closed: briefed', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await leasedRefute(zone, fable);
    await applyResult(w.db, deps(zone), id, promote, t0);
    expectBriefed(issue);
  });

  test('D5: the stored flag alone forces the briefing', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await leasedRefute(zone, { ...fable, plan: 'pro' });
    // The body no longer has the section; the flag stored at enqueue still says it is.
    setCrewIssue(w.db, issue, { body: ISSUE_BODY }, t0);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expectBriefed(issue);
  });

  test('D5: the body check alone forces the briefing', async () => {
    const zone = zoneOn();
    const issue = stagedWith(ISSUE_BODY);
    const id = await leasedRefute(zone, fable);
    expect(JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}').work.securityTouching).toBe(false);
    setCrewIssue(w.db, issue, { body: `${ISSUE_BODY}\n### security-touching CHECKLIST\n` }, t0);
    await applyResult(w.db, fdeps(zone), id, promote, t0);
    expectBriefed(issue);
  });

  test('revise and reject are unchanged', async () => {
    const zone = zoneOn();
    const issue = stagedWith(SECURE_BODY);
    const id = await leasedRefute(zone, { ...fable, plan: 'pro' });
    await applyResult(
      w.db,
      fdeps(zone),
      id,
      completed({ decision: 'reject', findings: ['x'] }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)?.state).toBe('rejecting');
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

describe('triage results (#184)', () => {
  /** #179's shape: two complaints in two sentences, plus a screenshot. */
  const TEXT_179 = {
    title: 'Usage page: overage gauge and Fable usage',
    body: [
      'The overage gauge shows OVERAGE-SENTENCE even though overage is not enabled for my account.',
      '',
      'Also I want to see FABLE-SENTENCE usage somewhere on the page.',
      '',
      '![screenshot](https://github.com/user-attachments/assets/179-usage.png)',
    ].join('\n'),
  };
  const child = (key: string, body = ISSUE_BODY) => ({ key, title: `Child ${key}`, body });
  const briefing = {
    subject: 'fable usage',
    decision: 'Drop the gauge, estimate it, or wait?',
    why: "Fable usage isn't in the usage API we read.",
    options: ['Drop the gauge', 'Estimate it', 'Wait'],
    recommendation: 'Drop the gauge',
    onHold: 'the Fable half of #179',
  };

  /** #179 on the forge with the triage label, and its open request. */
  function request179(): number {
    w.f.state.addIssue({ number: 179, ...TEXT_179, author: 'human', labels: ['jm-triage'] });
    return (
      recordTriageRequest(w.db, 'main', { number: 179, ...TEXT_179, author: 'human' }, t0) ?? -1
    );
  }

  async function triageDrop(at = t0): Promise<string> {
    const id = await crewDrop(at);
    expect(getDrop(w.db, id)?.role).toBe('triage');
    return id;
  }

  /** Every outbox op and forge write that names `n`. */
  const writesOn = (n: number) => [
    ...listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main').filter(
      (o) => (JSON.parse(o.payloadJson) as { number?: number }).number === n,
    ),
    ...w.f.author.calls.filter(
      (c) =>
        ['updateIssue', 'setLabels', 'createComment', 'commentIssue'].includes(c.method) &&
        c.args[0] === n,
    ),
  ];

  test('split with two valid children files two staged crew issues ending with the triage line', async () => {
    const req = request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: 's',
        outcome: 'split',
        children: [child('hide-overage-gauge'), child('report-fable-usage')],
      }),
      t0,
    );
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'done', outcome: 'split' });
    const filed = listCrewIssues(w.db, 'main');
    expect(filed).toHaveLength(2);
    for (const c of filed) {
      expect(c.objective).toBe('triage:#179');
      expect(c.body.endsWith('Triaged from #179.')).toBe(true);
      expect(c.source).toBe('drop');
      expect(c.sourceRef).toBe(id);
    }
    // D5: the same flush stages them as it stages the lead's.
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    const staged = listCrewIssues(w.db, 'main');
    expect(staged.map((c) => c.state)).toEqual(['staged', 'staged']);
    for (const c of staged) {
      expect(c.number).not.toBeNull();
      expect(w.f.state.issues.get(c.number ?? -1)?.labels).toContain('agent-staged');
      // Written with the crew's broken reference (`#` + joiner), so #179 gets no backlink.
      const body = w.f.state.issues.get(c.number ?? -1)?.issue?.body ?? '';
      expect(body).not.toContain('Triaged from #179.');
      expect(unsanitizeForgeText(body)).toContain('Triaged from #179.');
    }
  });

  test('D5: a triage child is staged and refutable, like a lead-filed one', async () => {
    request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: 's', outcome: 'split', children: [child('hide-overage-gauge')] }),
      t0,
    );
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, MIN));
    const [c] = listCrewIssues(w.db, 'main');
    expect(c?.state).toBe('staged');
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toEqual({
      role: 'refute',
      crewIssueId: c?.id,
    });
    const r = await crewDrop(plus(t0, 2 * MIN));
    await applyResult(w.db, deps(), r, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open', kind: 'promote' });
    expect(b?.subject).toBe(`issue:${c?.id}`);
  });

  test('CLAIM = PROOF: a full triage cycle enqueues no outbox op on the original issue', async () => {
    const req = request179();
    const q = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      q,
      completed({ summary: 's', outcome: 'questions', briefing }),
      t0,
    );
    const b = getTriageRequest(w.db, req)?.briefingId ?? -1;
    ruleBriefing(w.db, b, 'o1', 'drop the gauge', plus(t0, MIN));
    const s = await triageDrop(plus(t0, 2 * MIN));
    await applyResult(
      w.db,
      deps(),
      s,
      completed({ summary: 's', outcome: 'split', children: [child('hide-overage-gauge')] }),
      plus(t0, 2 * MIN),
    );
    await flushCrewOps(w.db, w.forges, w.zone, [], plus(t0, 3 * MIN));
    expect(getTriageRequest(w.db, req)?.state).toBe('done');
    expect(listCrewIssues(w.db, 'main').map((c) => c.state)).toEqual(['staged']);
    expect(writesOn(179)).toEqual([]);
    expect(w.f.state.issues.get(179)?.issue).toMatchObject(TEXT_179);
    expect(w.f.state.issues.get(179)?.labels).toEqual(['jm-triage']);
  });

  test('split with one valid and one invalid child files nothing and counts an attempt', async () => {
    const req = request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: 's',
        outcome: 'split',
        children: [child('good'), child('bad', 'No sections at all.')],
      }),
      t0,
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'open', attempts: 1 });
    const messages = listEvents(w.db, id).map((e) => String(e.data.message));
    expect(messages.some((m) => m.includes('Acceptance criteria'))).toBe(true);
  });

  test('D4: a child body containing jm:op: is refused on the triage path too', async () => {
    const req = request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: 's',
        outcome: 'split',
        children: [child('forged', `${ISSUE_BODY}\n<!-- jm:op:issue:main:x:y -->`)],
      }),
      t0,
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'open', attempts: 1 });
  });

  test('a child body that the triage line pushes over 12000 characters is refused', async () => {
    const req = request179();
    const id = await triageDrop();
    const long = `${ISSUE_BODY}${'x'.repeat(12_000 - ISSUE_BODY.length)}`;
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: 's', outcome: 'split', children: [child('long', long)] }),
      t0,
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(getTriageRequest(w.db, req)?.attempts).toBe(1);
  });

  test('questions raises one briefing and waits; a ruling reopens it and reaches the next input as an instruction', async () => {
    const req = request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: 's', outcome: 'questions', briefing }),
      t0,
    );
    const open = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: 'crew',
      source: 'crew',
      subject: 'crew:#179 fable usage',
    });
    expect(getTriageRequest(w.db, req)).toMatchObject({
      state: 'waiting',
      outcome: 'questions',
      briefingId: open[0]?.id,
    });
    expect(listCrewIssues(w.db, 'main')).toEqual([]);

    ruleBriefing(w.db, open[0]?.id ?? -1, 'o1', 'RULING-NOTE: drop it', plus(t0, MIN));
    const next = await triageDrop(plus(t0, 2 * MIN));
    expect(getTriageRequest(w.db, req)?.state).toBe('open');
    const input = (JSON.parse(getDrop(w.db, next)?.inputJson ?? '{}') as { input: string }).input;
    const trusted = input.slice(0, input.indexOf('(data)'));
    expect(trusted).toContain('RULING-NOTE: drop it');
    expect(trusted).toContain(`Ruling on briefing ${open[0]?.id}: option o1`);
  });

  test('not-agent-work closes the request with its reason and files nothing', async () => {
    const req = request179();
    const id = await triageDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        summary: 's',
        outcome: 'not-agent-work',
        reason: 'a question; answered in docs/runbooks/install.md',
      }),
      t0,
    );
    expect(getTriageRequest(w.db, req)).toMatchObject({
      state: 'done',
      outcome: 'not-agent-work',
      reason: 'a question; answered in docs/runbooks/install.md',
    });
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(listBriefings(w.db, { zoneId: 'main' })).toEqual([]);
  });

  test('three failures with maxTriage 2: failed, with exactly one briefing free of the issue text', async () => {
    const req = request179();
    const results: DropResult[] = [
      completed({ summary: 's', outcome: 'split', briefing }), // invalid
      { status: 'rate_limited', gates: [] },
      { status: 'failed', reason: 'boom', gates: [] },
    ];
    const drops: string[] = [];
    for (const [n, r] of results.entries()) {
      // The third arrives for a drop queued before the request failed.
      const id = n < 2 ? await triageDrop(plus(t0, n * MIN)) : (drops[0] ?? '');
      if (n < 2) drops.push(id);
      else updateDrop(w.db, id, { state: 'running' });
      await applyResult(w.db, deps(), id, r, plus(t0, n * MIN));
    }
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'failed', attempts: 2 });
    const all = listBriefings(w.db, { zoneId: 'main' });
    expect(all).toHaveLength(1);
    const [b] = all;
    expect(b).toMatchObject({ source: 'server', decision: 'triage of #179 failed' });
    expect(getTriageRequest(w.db, req)?.briefingId).toBe(b?.id);
    expect(b?.why).toContain('rate-limited');
    const text = JSON.stringify(b);
    for (const piece of [
      'OVERAGE-SENTENCE',
      'FABLE-SENTENCE',
      '179-usage.png',
      TEXT_179.title,
      'overage gauge shows',
    ]) {
      expect(text, piece).not.toContain(piece);
    }
    // A failed request is never scheduled again.
    expect(nextCrewWork(w.db, w.zone, plus(t0, 5 * MIN))).toEqual({ role: 'crew-lead' });
  });

  test('a split refused for its children names no issue text in the failure briefing', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, maxTriage: 1 } };
    const req = request179();
    const id = await crewDrop(t0, zone);
    await applyResult(
      w.db,
      deps(zone),
      id,
      completed({
        summary: 's',
        outcome: 'split',
        children: [{ key: 'overage-sentence', title: 'OVERAGE-SENTENCE', body: 'FABLE-SENTENCE' }],
      }),
      t0,
    );
    expect(getTriageRequest(w.db, req)?.state).toBe('failed');
    const [b] = listBriefings(w.db, { zoneId: 'main' });
    expect(b?.why).toContain('split refused');
    expect(JSON.stringify(b)).not.toMatch(/OVERAGE-SENTENCE|FABLE-SENTENCE|overage-sentence/);
  });
});

describe('D5: a body naming a protected path is stopped at every entry point (#247)', () => {
  const NAMES_CI = ISSUE_BODY.replace(
    'The API has no docs.',
    'Add a docs job to `.github/workflows/ci.yml`.',
  );
  const child = { key: 'ci-docs', title: 'Docs job', body: NAMES_CI };

  test('sync gate: a trusted human ready issue goes to triage, not to a work item', async () => {
    w.f.state.addIssue({
      number: 300,
      title: 'Docs job',
      body: NAMES_CI,
      author: 'human',
      labels: [w.zone.readyLabel],
    });
    await syncDropZone(w.db, w.forges, w.zone, t0);
    expect(listWorkItems(w.db, 'main').map((i) => i.issueNumber)).not.toContain(300);
    const reqs = listTriageRequests(w.db, 'main').filter((r) => r.issueNumber === 300);
    expect(reqs.map((r) => r.gateReasons)).toEqual([
      ['protected path .github/** named in the issue'],
    ]);
  });

  test('applyCrewActions from a lead and from an MCP source', () => {
    for (const source of [
      { kind: 'drop', dropId: 'd1' },
      { kind: 'mcp', tokenId: 7 },
    ] as const) {
      const r = applyCrewActions(
        w.db,
        w.zone,
        { fileIssues: [{ ...child, objective: 'document-every-endpoint' }] },
        source,
        t0,
      );
      expect(r.filed).toEqual([]);
      expect(r.refused).toEqual(['ci-docs: names protected path .github/**']);
    }
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });

  test('a triage split: nothing filed, one failed attempt', async () => {
    w.f.state.addIssue({
      number: 179,
      title: 'T',
      body: 'b',
      author: 'human',
      labels: ['jm-triage'],
    });
    const req =
      recordTriageRequest(
        w.db,
        'main',
        { number: 179, title: 'T', body: 'b', author: 'human' },
        t0,
      ) ?? -1;
    const id = await crewDrop();
    expect(getDrop(w.db, id)?.role).toBe('triage');
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ summary: 's', outcome: 'split', children: [child] }),
      t0,
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(getTriageRequest(w.db, req)).toMatchObject({ state: 'open', attempts: 1 });
  });

  test('a refute revise', async () => {
    const issue = staged();
    const id = await crewDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ decision: 'revise', findings: [], revisedBody: NAMES_CI }),
      t0,
    );
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'rejecting', body: ISSUE_BODY });
  });
});

describe('arbiter rulings on crew issues out of refutes (#382)', () => {
  const FABLE = 'claude-fable-1';
  const fable: ClaudeConfig = { plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 5 };
  const secrets = {
    claudeToken: 'claude-secret',
    githubAuthorToken: 'author-secret',
    githubReviewerToken: 'reviewer-secret',
    joinToken: 'join',
    operatorToken: 'o'.repeat(32),
  } as Config['secrets'];
  const zoneWith = (o: Partial<DropZoneConfig['crew']> = {}): DropZoneConfig => ({
    ...w.zone,
    crew: { ...crewOn, maxRefute: 3, refutePromotes: true, ...o },
  });
  const arbDeps = (zone: DropZoneConfig): ResultDeps => ({ ...deps(zone), claude: fable });
  const ruling = (o: Record<string, unknown> = {}) => ({
    ruling: 'A',
    because: 'Every finding was wording; the cited lines exist as described.',
    wouldReverse: 'A cited endpoint that does not exist.',
    reversible: true,
    productQuestion: false,
    instruction: 'Promote the issue.',
    ...o,
  });

  /** Runs one refute drop on the issue to a result, as the trooper would return it. */
  async function refute(zone: DropZoneConfig, at: Date, result: DropResult): Promise<void> {
    const id = await crewDrop(at, zone);
    expect(getDrop(w.db, id)?.role).toBe('refute');
    await applyResult(w.db, deps(zone), id, result, at);
  }

  /**
   * Issue #50 out of refutes: three refutes each asked to revise, the flush staged each revision,
   * and the last one is unrefuted (the results-site path).
   */
  async function exhaustedByRevise(zone: DropZoneConfig): Promise<number> {
    const issue = staged();
    setCrewIssue(w.db, issue, { number: 50 }, t0);
    w.f.state.addIssue({ number: 50, body: ISSUE_BODY, labels: ['agent-staged'] });
    for (let i = 0; i < 3; i++) {
      const at = plus(t0, i * 10 * MIN);
      await refute(
        zone,
        at,
        completed({
          decision: 'revise',
          findings: [`finding ${i}`],
          revisedBody: `${ISSUE_BODY}\nRevision ${i}.`,
        }),
      );
      expect(getCrewIssue(w.db, issue)?.state).toBe('revising');
      await flushCrewOps(w.db, w.forges, zone, [], plus(at, MIN));
      expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    }
    expect(getCrewIssue(w.db, issue)?.refuteCount).toBe(3);
    return issue;
  }

  /** The same issue at the cap with one verdict and dead refute drops (the schedule-site path). */
  async function exhaustedByDeadDrops(zone: DropZoneConfig): Promise<number> {
    const issue = staged();
    setCrewIssue(w.db, issue, { number: 50 }, t0);
    w.f.state.addIssue({ number: 50, body: ISSUE_BODY, labels: ['agent-staged'] });
    await refute(
      zone,
      t0,
      completed({ decision: 'revise', findings: ['finding 0'], revisedBody: `${ISSUE_BODY}\nR.` }),
    );
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, MIN));
    await refute(zone, plus(t0, 10 * MIN), { status: 'failed', gates: [], reason: 'boom' });
    await refute(zone, plus(t0, 20 * MIN), { status: 'rate_limited', gates: [] });
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'staged', refuteCount: 3 });
    return issue;
  }

  /** Enqueues the arbitrate drop with Fable available and leases it on `model`. */
  async function arbitrateDrop(
    zone: DropZoneConfig,
    at = plus(t0, 60 * MIN),
    claude: ClaudeConfig = fable,
  ): Promise<string> {
    const pass = await zonePass(w.forges, zone, 'main');
    const id = await enqueueCrew(
      w.db,
      w.forges,
      zone,
      pass,
      promptVersions(),
      usageCfg,
      at,
      undefined,
      { claude },
    );
    if (!id) throw new Error('no arbitrate drop');
    expect(getDrop(w.db, id)?.role).toBe('arbitrate');
    // The lease records requested_model as the payload is built.
    buildPayload(w.db, zone, getDrop(w.db, id) as never, secrets, { claude, now: at });
    updateDrop(w.db, id, { state: 'running', startedAt: at.toISOString() });
    return id;
  }

  const arbitration = () =>
    w.db
      .prepare(
        `SELECT state, ruling, acted, because, instruction, reason FROM arbitrations ORDER BY id`,
      )
      .all() as {
      state: string;
      ruling: string | null;
      acted: number;
      because: string | null;
      instruction: string | null;
      reason: string | null;
    }[];
  const open = () => listBriefings(w.db, { zoneId: 'main', state: 'open' });
  const exhaustedOpen = () => open().filter((b) => b.kind === 'refute_exhausted');

  test('ruling A, reversible, on Fable: promote_held with the hold briefing, and no refute_exhausted', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const sha = getCrewIssue(w.db, issue)?.bodySha;
    const id = await arbitrateDrop(zone);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
    await applyResult(w.db, arbDeps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'promote_held', refutedSha: sha });
    const [b] = open();
    expect(b?.kind).toBe('promote_held');
    expect(b?.options.map((o) => o.effect)).toEqual(['reject_issue', 'promote_issue']);
    expect(b?.decision).toContain('A Fable arbiter found nothing to fix in crew issue #50');
    expect(b?.why).toContain(`/drops/${id}`);
    expect(exhaustedOpen()).toEqual([]);
    expect(arbitration()).toEqual([
      {
        state: 'ruled',
        ruling: 'A',
        acted: 1,
        because: ruling().because,
        instruction: 'Promote the issue.',
        reason: null,
      },
    ]);
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    // Still held one pass, then promoted only if the Reject option was not taken.
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 62 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
  });

  test('ruling A with crew.refutePromotes off: a promote briefing, never a promotion', async () => {
    const zone = zoneWith({ refutePromotes: false });
    const issue = await exhaustedByRevise(zone);
    const sha = getCrewIssue(w.db, issue)?.bodySha;
    const id = await arbitrateDrop(zone);
    await applyResult(w.db, arbDeps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)).toMatchObject({ state: 'staged', refutedSha: sha });
    expect(open().map((b) => b.kind)).toEqual(['promote']);
    expect(open()[0]?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
    // Judged now: the schedule neither arbitrates it again nor puts it to Command as exhausted.
    const pass = await zonePass(w.forges, zone, 'main');
    await enqueueCrew(
      w.db,
      w.forges,
      zone,
      pass,
      promptVersions(),
      usageCfg,
      plus(t0, 70 * MIN),
      undefined,
      { claude: fable },
    );
    expect(exhaustedOpen()).toEqual([]);
    expect(arbitration()).toHaveLength(1);
  });

  test('ruling B: the issue goes rejecting, and the flush closes it', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    await applyResult(
      w.db,
      arbDeps(zone),
      id,
      completed(ruling({ ruling: 'B' })),
      plus(t0, 61 * MIN),
    );
    expect(getCrewIssue(w.db, issue)?.state).toBe('rejecting');
    expect(exhaustedOpen()).toEqual([]);
    expect(arbitration()[0]).toMatchObject({ state: 'ruled', ruling: 'B', acted: 1 });
    await flushCrewOps(w.db, w.forges, zone, [], plus(t0, 62 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('rejected');
    expect((await w.f.author.getIssue(50))?.state).toBe('closed');
  });

  test.each([
    [
      { ruling: 'insufficient_evidence' },
      'insufficient evidence',
      'ruled that the evidence is insufficient',
    ],
    [{ productQuestion: true }, 'a product question', 'ruled A'],
    [{ reversible: false }, 'not reversible', 'ruled A'],
    [{ ruling: 'B', productQuestion: true }, 'a product question', 'ruled B'],
  ])(
    'a ruling %o does not act: staged, and the briefing as today ends with %s',
    async (o, reason, said) => {
      const zone = zoneWith();
      const issue = await exhaustedByRevise(zone);
      const id = await arbitrateDrop(zone);
      await applyResult(w.db, arbDeps(zone), id, completed(ruling(o)), plus(t0, 61 * MIN));
      expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
      expect(arbitration()[0]).toMatchObject({ state: 'ruled', acted: 0, reason });
      const [b] = exhaustedOpen();
      expect(b?.subject).toBe(`issue:${issue}`);
      expect(b?.why).toContain(`A Fable arbiter ${said}`);
      expect(b?.why).toContain(ruling().because);
      if (o.ruling !== 'insufficient_evidence')
        expect(b?.why).toContain(`It was not acted on: ${reason}.`);
      expect(b?.why).toContain(`/drops/${id}`);
      expect(b?.why.endsWith(REFUTE_RECOMMENDATION)).toBe(true);
      expect(b?.why.length).toBeLessThanOrEqual(MAX_BRIEFING_WHY);
      expect(open()).toHaveLength(1);
    },
  );

  test('ruling A on a drop that asked for the zone model does not act: "did not run on Fable"', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    updateDrop(w.db, id, { requestedModel: zone.model });
    await applyResult(w.db, arbDeps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    expect(arbitration()[0]).toMatchObject({
      ruling: 'A',
      acted: 0,
      reason: 'did not run on Fable',
    });
    expect(exhaustedOpen()[0]?.why).toContain('did not run on Fable');
    expect(exhaustedOpen()[0]?.why).toContain('The arbiter ruled A');
  });

  test('ruling A from a Fable request served by another model does not act', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    await applyResult(
      w.db,
      arbDeps(zone),
      id,
      { ...completed(ruling()), modelUsage: { 'claude-opus-5-5': { outputTokens: 40 } } },
      plus(t0, 61 * MIN),
    );
    expect(getDrop(w.db, id)?.servedModel).toBe('claude-opus-5-5');
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    expect(arbitration()[0]?.reason).toBe('did not run on Fable');
    expect(exhaustedOpen()).toHaveLength(1);
  });

  test('ruling A with no claude config on the result side does not act (D2)', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    await applyResult(w.db, deps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    expect(arbitration()[0]?.reason).toBe('did not run on Fable');
  });

  test.each([
    ['rate-limited', { status: 'rate_limited', gates: [] } as DropResult, 'rate-limited'],
    ['failed', { status: 'failed', gates: [], reason: 'boom' } as DropResult, 'boom'],
    [
      'missing ruling',
      completed({ ...ruling(), ruling: undefined }) as DropResult,
      'invalid crew output',
    ],
    ['no output', { status: 'completed', gates: [] } as DropResult, 'invalid crew output'],
  ])(
    'D2: a %s arbitrate drop leaves the issue staged and raises the briefing',
    async (_n, result, reason) => {
      const zone = zoneWith();
      const issue = await exhaustedByRevise(zone);
      const id = await arbitrateDrop(zone);
      await applyResult(w.db, arbDeps(zone), id, result, plus(t0, 61 * MIN));
      expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
      expect(arbitration()[0]).toMatchObject({ state: 'failed', acted: 0, ruling: null });
      expect(arbitration()[0]?.reason).toContain(reason);
      const [b] = exhaustedOpen();
      expect(b?.why).toContain('The arbiter could not rule:');
      expect(b?.why).toContain(reason);
      expect(open().filter((x) => x.kind !== 'refute_exhausted')).toEqual([]);
    },
  );

  test('the same completed result applied twice acts once', async () => {
    const zone = zoneWith({ refutePromotes: false });
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    const drop = getDrop(w.db, id);
    if (!drop) throw new Error('no drop');
    const result = completed(ruling({ ruling: 'B' }));
    await applyCrewResult(w.db, arbDeps(zone), drop, result, plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('rejecting');
    // Command reopens it; a re-delivered ruling must not reject it again.
    setCrewIssue(w.db, issue, { state: 'staged' }, plus(t0, 62 * MIN));
    const before = arbitration();
    await applyCrewResult(w.db, arbDeps(zone), drop, result, plus(t0, 63 * MIN));
    expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
    expect(arbitration()).toEqual(before);
  });

  test('a ruling on a body that changed since enqueue is discarded, with no state change', async () => {
    const zone = zoneWith();
    const issue = await exhaustedByRevise(zone);
    const id = await arbitrateDrop(zone);
    setCrewIssue(w.db, issue, { bodySha: 'sha-new' }, plus(t0, 60 * MIN));
    const before = getCrewIssue(w.db, issue);
    await applyResult(w.db, arbDeps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
    expect(getCrewIssue(w.db, issue)).toEqual(before);
    expect(arbitration()[0]).toMatchObject({ state: 'discarded', ruling: null, acted: 0 });
    expect(open()).toEqual([]);
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
  });

  describe('D5: both former raise sites take the same arbitration path', () => {
    for (const [name, exhaust] of [
      ['a revise at the cap (the former results site)', exhaustedByRevise],
      ['dead refute drops at the cap (the schedule site)', exhaustedByDeadDrops],
    ] as const) {
      test(`${name}: one arbitration, then ruling A acts and insufficient evidence briefs`, async () => {
        const zone = zoneWith();
        const issue = await exhaust(zone);
        expect(exhaustedOpen()).toEqual([]);
        const id = await arbitrateDrop(zone);
        expect(arbitration()).toHaveLength(1);
        // No second arbitration of this text while it is in flight, nor a briefing.
        const pass = await zonePass(w.forges, zone, 'main');
        await enqueueCrew(
          w.db,
          w.forges,
          zone,
          pass,
          promptVersions(),
          usageCfg,
          plus(t0, 60 * MIN + 1),
          undefined,
          { claude: fable },
        );
        expect(arbitration()).toHaveLength(1);
        expect(exhaustedOpen()).toEqual([]);
        await applyResult(
          w.db,
          arbDeps(zone),
          id,
          completed(ruling({ ruling: 'insufficient_evidence' })),
          plus(t0, 61 * MIN),
        );
        expect(getCrewIssue(w.db, issue)?.state).toBe('staged');
        expect(exhaustedOpen()).toHaveLength(1);
        expect(exhaustedOpen()[0]?.why).toContain('ruled that the evidence is insufficient');
      });

      test(`${name}: ruling A promotes as a passing refute would`, async () => {
        const zone = zoneWith();
        const issue = await exhaust(zone);
        const id = await arbitrateDrop(zone);
        await applyResult(w.db, arbDeps(zone), id, completed(ruling()), plus(t0, 61 * MIN));
        expect(getCrewIssue(w.db, issue)?.state).toBe('promote_held');
        expect(open().map((b) => b.kind)).toEqual(['promote_held']);
      });
    }

    test('applyRefute raises no refute_exhausted briefing of its own', () => {
      const src = readFileSync(new URL('./results.ts', import.meta.url), 'utf8');
      const start = src.indexOf('function applyRefute(');
      const end = src.indexOf('\n}\n', start);
      const body = src.slice(start, end);
      expect(start).toBeGreaterThan(-1);
      expect(body).not.toContain('refute_exhausted');
      expect(body).not.toContain('raiseRefuteExhausted');
      expect(body).not.toContain('refuteExhaustedWhy');
      // The schedule is the one place a refute_exhausted briefing is raised.
      const raised = ['./results.ts', './schedule.ts', './flush.ts', './actions.ts'].filter((f) =>
        readFileSync(new URL(f, import.meta.url), 'utf8').includes("kind: 'refute_exhausted'"),
      );
      expect(raised).toEqual(['./schedule.ts']);
    });
  });
});

describe('arbiter rulings on review disagreements (#383)', () => {
  /** Issue #61's story on issue 1: three review heals ran out, and its arbitrate drop is leased. */
  async function leasedRuling(): Promise<{ h: Harness; dropId: string; epoch: number }> {
    const h = await arbiterHarness();
    await toHealsExhausted(h);
    await h.reconcile(); // queues the arbitrate drop
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('arbitrate');
    return { h, dropId, epoch };
  }
  const itemDeps = (h: Harness) => ({ forges: () => h.forges });
  const row = (h: Harness) =>
    h.db
      .prepare(
        `SELECT state, ruling, acted, because, instruction, reason, applied_at AS appliedAt
         FROM arbitrations WHERE subject = 'item:1'`,
      )
      .get() as Record<string, unknown>;
  const briefing = (h: Harness) =>
    listBriefings(h.db, { zoneId: 'main', kind: 'parked' }).find((b) => b.subject === 'item:1');
  const getPulls = (h: Harness) => h.forge.author.calls.filter((c) => c.method === 'getPull');
  const item = (h: Harness) => listWorkItems(h.db, 'main').find((i) => i.id === 1);

  test('ruling B, reversible, on Fable → recorded only; the next pass retries #61 and its review carries the ruling', async () => {
    const { h, dropId, epoch } = await leasedRuling();
    const because = "finding 2 asks for a test the issue's Out of scope excludes";
    expect(await h.postResult(dropId, epoch, completed(ruling('B', { because })))).toBe(204);
    // Acting needs a forge read: the result only records it.
    expect(row(h)).toMatchObject({ state: 'ruled', ruling: 'B', acted: 1, appliedAt: null });
    expect(item(h)?.state).toBe('parked');
    expect(getDrop(h.db, dropId)?.state).toBe('succeeded');

    await h.reconcile();
    expect(row(h)?.appliedAt).not.toBeNull();
    expect(item(h)?.state).toBe('pr_open');
    expect(getAttempts(h.db, 1, 'heal').count).toBe(0);
    // The parked briefing is withdrawn once the item leaves parked.
    expect(briefing(h)?.state).not.toBe('open');
    // The request-changes on the head was cleared: the head is reviewed afresh, with the ruling.
    expect(h.queuedRoles()).toEqual(['review']);
    const { payload } = await h.lease();
    expect(payload.role === 'review' && payload.prompt).toContain(
      '## Arbiter ruling (data, untrusted)',
    );
    expect(payload.role === 'review' && payload.prompt).toContain(because);
    expect(payload.role === 'review' && payload.prompt).toContain('Ruled for the author');
  });

  test('ruling A → the same retry; the review requests changes again, and the heal carries the ruling and its instruction', async () => {
    const { h, dropId, epoch } = await leasedRuling();
    await h.postResult(
      dropId,
      epoch,
      completed(ruling('A', { instruction: 'cover the empty-list case in the handler' })),
    );
    await h.reconcile();
    expect(item(h)?.state).toBe('pr_open');
    await h.finishDrop('review', {
      status: 'completed',
      gates: [],
      verdict: { decision: 'request_changes', summary: 'still', findings: [] },
    });
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    const { payload } = await h.lease();
    expect(payload.role).toBe('heal');
    const prompt = payload.role === 'heal' ? payload.prompt : '';
    expect(prompt).toContain('## Arbiter ruling (data, untrusted)');
    expect(prompt).toContain('Ruled for the reviewer');
    expect(prompt).toContain('cover the empty-list case in the handler');
  });

  test('insufficient evidence → #61 stays parked, its briefing shows the reasons, and no diagnose runs', async () => {
    const { h, dropId, epoch } = await leasedRuling();
    await h.postResult(
      dropId,
      epoch,
      completed(ruling('insufficient_evidence', { because: 'neither side cited a line' })),
    );
    expect(row(h)).toMatchObject({ state: 'ruled', acted: 0, reason: 'insufficient evidence' });
    const b = briefing(h);
    expect(b).toMatchObject({ state: 'open', diagnoseAttempts: 1 });
    expect(b?.diagnosis).toContain('neither side cited a line');
    expect(b?.diagnosisBasis).toBe(whyBasis(b?.why ?? ''));
    expect(b?.recommendation).toBe('needs_command: do the insufficient_evidence thing');
    expect(await applyArbitrations(h.db, itemDeps(h), 'main', h.now())).toBe(0);
    await h.reconcile();
    expect(item(h)?.state).toBe('parked');
    expect(h.queuedRoles()).toEqual([]);
    // The briefing keeps its diagnosis across passes.
    expect(briefing(h)?.diagnosis).toContain('neither side cited a line');
  });

  test('a product question or an irreversible ruling is not acted on: the owner is briefed', async () => {
    for (const o of [{ productQuestion: true }, { reversible: false }]) {
      const { h, dropId, epoch } = await leasedRuling();
      await h.postResult(dropId, epoch, completed(ruling('B', o)));
      expect(row(h)).toMatchObject({ state: 'ruled', acted: 0 });
      expect(briefing(h)).toMatchObject({ state: 'open', diagnoseAttempts: 1 });
      expect(briefing(h)?.recommendation).toBe('needs_command: do the B thing');
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
    }
  });

  test('a result after the head moved, or after the item left parked, is discarded', async () => {
    const moved = await leasedRuling();
    const pr = getPullRequest(moved.h.db, 1);
    upsertPullRequest(moved.h.db, { ...(pr as never), headSha: headN(9) }, moved.h.now());
    await moved.h.postResult(moved.dropId, moved.epoch, completed(ruling('B')));
    expect(row(moved.h)).toMatchObject({ state: 'discarded', acted: 0 });
    expect(await applyArbitrations(moved.h.db, itemDeps(moved.h), 'main', moved.h.now())).toBe(0);
    expect(item(moved.h)?.state).toBe('parked');

    const retried = await leasedRuling();
    retried.h.forge.state.setLabels(1, ['agent-ready', 'agent-retry']);
    await retried.h.sync();
    expect(item(retried.h)?.state).toBe('pr_open');
    await retried.h.postResult(retried.dropId, retried.epoch, completed(ruling('B')));
    expect(row(retried.h)).toMatchObject({ state: 'discarded' });
  });

  test('D2: a failed drop, an invalid output, and a ruling from a non-Fable drop each leave #61 parked, diagnosed, never retried', async () => {
    const cases: [string, (h: Harness) => DropResult][] = [
      ['failed', () => ({ status: 'failed', reason: 'boom', gates: [] })],
      ['invalid', () => completed({ ruling: 'B' })],
      ['missing', () => ({ status: 'completed', gates: [] })],
      ['rate-limited', () => ({ status: 'rate_limited', gates: [] })],
      ['not on Fable', () => ({ ...completed(ruling('B')), servedModel: 'claude-sonnet-9' })],
    ];
    for (const [name, result] of cases) {
      const { h, dropId, epoch } = await leasedRuling();
      await h.postResult(dropId, epoch, result(h));
      expect(row(h)?.acted, name).toBe(0);
      expect(['failed', 'ruled'], name).toContain(row(h)?.state);
      expect(briefing(h), name).toMatchObject({ state: 'open', diagnoseAttempts: 1 });
      expect(briefing(h)?.diagnosis, name).toBeTruthy();
      expect(briefing(h)?.recommendation, name).toMatch(/^needs_command: /);
      expect(await applyArbitrations(h.db, itemDeps(h), 'main', h.now()), name).toBe(0);
      await h.reconcile();
      expect(item(h)?.state, name).toBe('parked');
      // Never retried: the heal attempts stay spent.
      expect(getAttempts(h.db, 1, 'heal').count, name).toBe(h.zone.budgets.maxHeal);
      expect(h.queuedRoles(), name).toEqual([]);
    }
  });

  test('D3: two applyArbitrations calls on one ruling retry once; a failed PR read waits for the next pass', async () => {
    const { h, dropId, epoch } = await leasedRuling();
    await h.postResult(dropId, epoch, completed(ruling('B')));
    h.forge.author.failNext('getPull', 'throw');
    expect(await applyArbitrations(h.db, itemDeps(h), 'main', h.now())).toBe(0);
    expect(row(h)?.appliedAt).toBeNull();
    expect(item(h)?.state).toBe('parked');

    const before = getPulls(h).length;
    const counts = await Promise.all([
      applyArbitrations(h.db, itemDeps(h), 'main', h.now()),
      applyArbitrations(h.db, itemDeps(h), 'main', h.now()),
    ]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(getPulls(h).length - before).toBe(1);
    expect(await applyArbitrations(h.db, itemDeps(h), 'main', h.now())).toBe(0);
    expect(item(h)?.state).toBe('pr_open');
  });

  test('a re-delivered result settles once', async () => {
    const { h, dropId } = await leasedRuling();
    const drop = getDrop(h.db, dropId) as Drop;
    const deps: ResultDeps = {
      forges: h.forges,
      zone: h.zone,
      secrets: [],
      usageCfg,
      claude: FABLE_CLAUDE,
    };
    await applyCrewResult(h.db, deps, drop, completed(ruling('B')), h.now());
    await applyCrewResult(h.db, deps, drop, completed(ruling('insufficient_evidence')), h.now());
    expect(row(h)).toMatchObject({ state: 'ruled', ruling: 'B', acted: 1 });
    expect(briefing(h)?.diagnoseAttempts).toBe(0);
  });
});

describe('the crew retries a failed implementation once on its own diagnosis (#396)', () => {
  const TAIL =
    ' FAIL  scripts/no-token-literals.test.ts > no tracked file holds a token-shaped literal\n' +
    'AssertionError: expected [ …(1) ] to deeply equal []';
  const redGate = { name: 'test', exitCode: 1, durationMs: 1, timedOut: false, outputTail: TAIL };
  const INSTRUCTION =
    'Build fake tokens from parts at runtime, as scripts/no-token-literals.test.ts says; no whole token literal in any test file.';
  const DIAGNOSIS = 'The implement drop wrote whole fake tokens into test files.';
  const diag = (o: Record<string, unknown> = {}) => ({
    diagnosis: DIAGNOSIS,
    recommendation: 'retry',
    detail: 'Retry it with the fix.',
    instruction: INSTRUCTION,
    ...o,
  });
  const implementFailed: DropResult = {
    status: 'failed',
    reason: 'gate test failed',
    gates: [redGate],
  };

  /** Issue 1 with the crew on: its implement fails the test gate, it parks and is briefed. */
  async function parked(zone: Partial<DropZoneConfig> = {}): Promise<Harness> {
    const h = await harness({
      zone: { crew: crewOn, triage: { gate: false }, ...zone },
    });
    await h.reconcile();
    expect(await h.finishDrop('implement', implementFailed)).toBe(204);
    await h.reconcile(); // raises the parked briefing and queues its diagnose drop
    return h;
  }
  const item = (h: Harness) => listWorkItems(h.db, 'main').find((i) => i.id === 1);
  const briefings = (h: Harness) =>
    listBriefings(h.db, { zoneId: 'main', kind: 'parked' }).filter((b) => b.subject === 'item:1');
  const openBriefing = (h: Harness) => briefings(h).find((b) => b.state === 'open');
  const rows = (h: Harness) =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM crew_retries').get() as { n: number }).n;
  const implementDrops = (h: Harness) =>
    (
      h.db
        .prepare(`SELECT COUNT(*) AS n FROM drops WHERE role = 'implement' AND work_item_id = 1`)
        .get() as { n: number }
    ).n;
  const retryDeps = (h: Harness, zone: DropZoneConfig = h.zone) => ({
    forges: () => h.forges,
    zone: () => zone,
  });
  async function diagnose(h: Harness, result: DropResult): Promise<string> {
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('diagnose');
    expect(await h.postResult(dropId, epoch, result)).toBe(204);
    return dropId;
  }

  test('#348: retry with an instruction withdraws the briefing; the next pass retries; the implement prompt carries it', async () => {
    const h = await parked();
    const raised = openBriefing(h);
    expect(raised).toBeDefined();
    expect(item(h)?.state).toBe('parked');
    const dropId = await diagnose(h, completed(diag()));
    // Recorded in the result's transaction: the row, the diagnosis kept, the briefing withdrawn.
    expect(getCrewRetry(h.db, 1)).toMatchObject({
      zoneId: 'main',
      briefingId: raised?.id,
      dropId,
      diagnosis: DIAGNOSIS,
      instruction: INSTRUCTION,
      appliedAt: null,
      outcome: null,
    });
    const withdrawn = briefings(h).find((b) => b.id === raised?.id);
    expect(withdrawn).toMatchObject({ state: 'withdrawn', diagnosis: DIAGNOSIS });
    expect(withdrawn?.recommendation).toBe('retry: Retry it with the fix.');
    expect(item(h)?.state).toBe('parked');
    // Nothing raises it again before the apply.
    syncParkBriefings(h.db, h.zone, h.now());
    expect(openBriefing(h)).toBeUndefined();

    await h.reconcile();
    expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
    expect(getCrewRetry(h.db, 1)?.appliedAt).not.toBeNull();
    expect(item(h)?.state).not.toBe('parked');
    expect(openBriefing(h)).toBeUndefined();
    expect(h.queuedRoles()).toEqual(['implement']);
    // No ruling was made by the owner.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM rulings').get()).toEqual({ n: 0 });
    const { payload } = await h.lease();
    const prompt = payload.role === 'implement' ? (payload.prompt ?? '') : '';
    const section = prompt.slice(prompt.indexOf('## Previous attempt (data, untrusted)'));
    expect(section).toContain('no-token-literals.test.ts > no tracked file');
    expect(section).toContain(
      `The crew diagnosed this failure and retried the item once. Its diagnosis: ${DIAGNOSIS}. What the next attempt must do differently: ${INSTRUCTION}`,
    );
  });

  test('the retried implement passes: a PR opens, as for any implement drop', async () => {
    const h = await parked();
    await diagnose(h, completed(diag()));
    await toPrOpen(h, headN(1));
    expect(item(h)?.state).toBe('pr_open');
    expect(rows(h)).toBe(1);
  });

  test('CLAIM = PROOF: it fails again → parked, briefed as already retried, diagnosed, never retried twice', async () => {
    const h = await parked();
    await diagnose(h, completed(diag()));
    await h.reconcile();
    const retriedAt = getCrewRetry(h.db, 1)?.appliedAt ?? '';
    expect(await h.finishDrop('implement', implementFailed)).toBe(204);
    await h.reconcile();
    expect(item(h)?.state).toBe('parked');
    const again = openBriefing(h);
    expect(again?.decision).toBe('Issue #1 parked again after the crew retried it once. Retry it?');
    expect(again?.why).toMatch(
      new RegExp(
        `^The crew already retried this once on ${retriedAt.slice(0, 10)}\\. Its diagnosis: `,
      ),
    );
    expect(again?.why).toContain(`It told the next attempt: ${INSTRUCTION}`);
    expect(again?.options.map((o) => o.effect)).toEqual(['retry_item', 'none']);
    expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);

    await diagnose(h, completed(diag({ diagnosis: 'Same again.' })));
    expect(rows(h)).toBe(1);
    expect(openBriefing(h)).toMatchObject({ id: again?.id, diagnosis: 'Same again.' });
    const before = implementDrops(h);
    await h.reconcile();
    await h.reconcile();
    expect(item(h)?.state).toBe('parked');
    expect(implementDrops(h)).toBe(before);
    expect(openBriefing(h)?.why).toContain('The crew already retried this once');
  });

  test('CLAIM = PROOF: a direct second insert for the item is refused by the schema', async () => {
    const h = await parked();
    const b = openBriefing(h);
    const row = {
      zoneId: 'main',
      itemId: 1,
      briefingId: b?.id ?? -1,
      dropId: 'd1',
      diagnosis: 'd',
      instruction: 'i',
      createdAt: h.now(),
    };
    insertCrewRetry(h.db, row);
    expect(() => insertCrewRetry(h.db, { ...row, dropId: 'd2' })).toThrow(/UNIQUE/);
    expect(rows(h)).toBe(1);
  });

  test('needs_command, leave_parked, retry with no instruction, setting off: the diagnosis is shown, nothing retries', async () => {
    const cases: [string, Record<string, unknown>, Partial<DropZoneConfig>][] = [
      ['needs_command', diag({ recommendation: 'needs_command' }), {}],
      ['leave_parked', diag({ recommendation: 'leave_parked' }), {}],
      ['no instruction', diag({ instruction: undefined }), {}],
      ['setting off', diag(), { crew: { ...crewOn, autoRetry: false } }],
    ];
    for (const [name, out, zone] of cases) {
      const h = await parked(zone);
      await diagnose(h, completed(out));
      expect(rows(h), name).toBe(0);
      expect(openBriefing(h)?.diagnosis, name).toBe(DIAGNOSIS);
      await h.reconcile();
      await h.reconcile();
      expect(item(h)?.state, name).toBe('parked');
      expect(openBriefing(h), name).toBeDefined();
      expect(h.queuedRoles(), name).toEqual([]);
    }
  });

  test('D2: a diagnose that fails, is lost, rate-limited or invalid → no row, the briefing open, still parked after two passes', async () => {
    const cases: [string, DropResult | 'lost'][] = [
      ['failed', { status: 'failed', reason: 'boom', gates: [] }],
      ['rate-limited', { status: 'rate_limited', gates: [] }],
      ['invalid', completed({ ...diag(), extra: true })],
      ['empty instruction', completed(diag({ instruction: '' }))],
      ['missing', { status: 'completed', gates: [] }],
      ['lost', 'lost'],
    ];
    for (const [name, result] of cases) {
      const h = await parked();
      if (result === 'lost') {
        const { payload } = await h.lease();
        expect(payload.role).toBe('diagnose');
        h.at(24 * 60);
        expect(expireLeases(h.db, h.now())).toBe(1);
      } else {
        await diagnose(h, result);
      }
      expect(rows(h), name).toBe(0);
      expect(openBriefing(h), name).toBeDefined();
      await h.reconcile();
      await h.reconcile();
      expect(rows(h), name).toBe(0);
      expect(item(h)?.state, name).toBe('parked');
      expect(openBriefing(h), name).toBeDefined();
    }
  });

  test('D2: the setting turned off between record and apply → skipped, and the briefing is raised again that pass', async () => {
    const h = await parked();
    await diagnose(h, completed(diag()));
    expect(openBriefing(h)).toBeUndefined();
    const off = { ...h.zone, crew: { ...h.zone.crew, autoRetry: false } };
    // As reconcileZone runs it: the crew retries, then the parked briefings.
    expect(await applyCrewRetries(h.db, retryDeps(h, off), 'main', h.now())).toBe(0);
    syncParkBriefings(h.db, off, h.now());
    expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'skipped' });
    expect(item(h)?.state).toBe('parked');
    expect(openBriefing(h)).toMatchObject({ decision: 'Issue #1 is parked. Retry it?' });
    expect(await applyCrewRetries(h.db, retryDeps(h), 'main', h.now())).toBe(0);
    expect(item(h)?.state).toBe('parked');
  });

  test('an item no longer parked at apply → skipped', async () => {
    const h = await parked();
    await diagnose(h, completed(diag()));
    setWorkItemState(h.db, 1, 'ready', undefined, h.now());
    expect(await applyCrewRetries(h.db, retryDeps(h), 'main', h.now())).toBe(0);
    expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'skipped' });
  });

  test('D3: two retry results for the same item, applied in turn → one row, one implement drop', async () => {
    const h = await parked();
    const first = await h.lease();
    expect(first.payload.role).toBe('diagnose');
    // Its lease runs out; the item parks on a new reason, so the why changes and is diagnosed afresh.
    h.at(24 * 60);
    expect(expireLeases(h.db, h.now())).toBe(1);
    h.db.prepare(`UPDATE work_items SET reason = 'gate test failed (again)' WHERE id = 1`).run();
    await h.reconcile();
    expect(openBriefing(h)?.diagnoseAttempts).toBe(1);
    const second = await h.lease();
    expect(second.payload.role).toBe('diagnose');
    const d = (id: string) => getDrop(h.db, id) as Drop;
    const rdeps: ResultDeps = { forges: h.forges, zone: h.zone, secrets: [], usageCfg };
    await applyCrewResult(h.db, rdeps, d(second.dropId), completed(diag()), h.now());
    await applyCrewResult(h.db, rdeps, d(first.dropId), completed(diag()), h.now());
    expect(rows(h)).toBe(1);
    expect(getCrewRetry(h.db, 1)?.dropId).toBe(second.dropId);
    const before = implementDrops(h);
    await h.reconcile();
    await h.reconcile();
    expect(implementDrops(h) - before).toBe(1);
  });

  test('D3: two applyCrewRetries together on one row retry once', async () => {
    const h = await parked();
    await diagnose(h, completed(diag()));
    const counts = await Promise.all([
      applyCrewRetries(h.db, retryDeps(h), 'main', h.now()),
      applyCrewRetries(h.db, retryDeps(h), 'main', h.now()),
    ]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(item(h)?.state).toBe('ready');
    const before = implementDrops(h);
    await h.reconcile();
    expect(implementDrops(h) - before).toBe(1);
    expect(h.queuedRoles()).toEqual(['implement']);
  });

  test('paused and observe zones do not apply; the kill switch stops it', async () => {
    for (const mode of ['paused', 'observe'] as const) {
      const h = await parked();
      await diagnose(h, completed(diag()));
      setZoneMode(h.db, 'main', mode, h.now());
      await h.reconcile();
      expect(getCrewRetry(h.db, 1)?.appliedAt, mode).toBeNull();
      expect(item(h)?.state, mode).toBe('parked');
    }
  });

  describe('crewMayRetry', () => {
    test('true for a failed implement park with no PR and no row', async () => {
      const h = await parked();
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(true);
      expect(crewMayRetry(h.db, { ...h.zone, crew: { ...h.zone.crew, autoRetry: false } }, 1)).toBe(
        false,
      );
    });

    test('false with a row', async () => {
      const h = await parked();
      insertCrewRetry(h.db, {
        zoneId: 'main',
        itemId: 1,
        briefingId: openBriefing(h)?.id ?? -1,
        dropId: 'x',
        diagnosis: 'd',
        instruction: 'i',
        createdAt: h.now(),
      });
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
    });

    test('false for a heals-exhausted park (newest drop a review, with a PR)', async () => {
      const h = await arbiterHarness();
      await toHealsExhausted(h);
      expect(item(h)?.state).toBe('parked');
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
    });

    test('false for an item with a PR, a heal as newest drop, or not parked', async () => {
      const h = await parked();
      upsertPullRequest(
        h.db,
        {
          workItemId: 1,
          number: 7,
          headRef: 'agent/issue-1',
          headSha: headN(1),
          state: 'open',
        } as never,
        h.now(),
      );
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);

      const heal = await parked();
      heal.db
        .prepare(
          `UPDATE drops SET role = 'heal' WHERE id = (SELECT id FROM drops WHERE work_item_id = 1
             ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
        )
        .run();
      expect(crewMayRetry(heal.db, heal.zone, 1)).toBe(false);

      const prNumber = await parked();
      prNumber.db.prepare('UPDATE work_items SET pr_number = 9 WHERE id = 1').run();
      expect(crewMayRetry(prNumber.db, prNumber.zone, 1)).toBe(false);

      const ready = await parked();
      setWorkItemState(ready.db, 1, 'ready', undefined, ready.now());
      expect(crewMayRetry(ready.db, ready.zone, 1)).toBe(false);
    });

    test('false for a budget, rate-limit, completed-without-head or no-changes park (newest implement not failed)', async () => {
      const results: [string, DropResult][] = [
        ['blocked', { status: 'blocked', reason: 'blocked', gates: [] }],
        ['no_changes', { status: 'no_changes', gates: [] }],
        ['interrupted, budget', { status: 'interrupted', gates: [] }],
      ];
      const checked: string[] = [];
      for (const [name, result] of results) {
        const h = await harness({
          zone: {
            crew: crewOn,
            triage: { gate: false },
            budgets: { ...makeZone().budgets, maxResume: 0 },
          },
        });
        await h.reconcile();
        await h.finishDrop('implement', result);
        await h.reconcile();
        if (item(h)?.state !== 'parked') continue;
        checked.push(name);
        expect(crewMayRetry(h.db, h.zone, 1), name).toBe(false);
      }
      expect(checked).toContain('blocked');
    });
  });
});
