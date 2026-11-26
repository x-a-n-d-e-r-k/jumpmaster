import { readFileSync } from 'node:fs';
import type { DropResult } from '@jumpmaster/protocol';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
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
import { GitHubForge } from '../forge/github.js';
import { expireLeases } from '../leases.js';
import { type ForgePair, unsanitizeForgeText } from '../outbox.js';
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
import { lastHealFeedback } from './inputs.js';
import {
  applyArbitrations,
  applyCrewResult,
  applyCrewRetries,
  crewMayRetry,
  crewParkKind,
  foundByAudit,
} from './results.js';
import { enqueueCrew, nextCrewWork } from './schedule.js';
import {
  getCrewIssue,
  getCrewRetry,
  getTriageRequest,
  insertCrewRetry,
  listAudits,
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
        'crew.refutePromotes for this project: ' +
        `jumpmaster ctl zones set ${w.zone.id} crew.refutePromotes=true`,
    );
    expect(b?.options.map((o) => o.effect)).toEqual(['promote_issue', 'reject_issue']);
  });

  test('a passing refute with refutePromotes on says it goes ahead in about a minute unless rejected', async () => {
    const zone = { ...w.zone, crew: { ...crewOn, refutePromotes: true } };
    staged();
    const id = await crewDrop(t0, zone);
    await applyResult(w.db, deps(zone), id, completed({ decision: 'promote', findings: [] }), t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open' });
    expect(b?.kind).toBe('promote_held');
    expect(b?.decision).toBe(
      'A reviewer found nothing to fix in crew issue #40. It goes ahead in about a minute ' +
        'unless you reject it.',
    );
    expect(b?.decision).toContain('in about a minute');
    expect(b?.decision).not.toContain('next pass');
    expect(b?.why).toBe(
      'The crew filed crew issue #40 as staged, and a second agent reviewed it against the code ' +
        'and the spec and found nothing wrong, vague or untestable. This project lets a passing ' +
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

describe('a diagnose that failed only because the head moved (#709)', () => {
  const stale = (reason = 'head moved: expected abc, got def'): DropResult => ({
    status: 'failed',
    reason,
    gates: [],
  });
  const diagnoseDrops = () =>
    (w.db.prepare(`SELECT id FROM drops WHERE role = 'diagnose'`).all() as { id: string }[]).length;
  const counters = (id: number) =>
    w.db
      .prepare(
        'SELECT diagnose_attempts AS a, diagnose_stale_reruns AS r FROM briefings WHERE id = ?',
      )
      .get(id) as { a: number; r: number };
  let item = -1;
  function parked(): number {
    item = w.item(1, 'ready');
    setWorkItemState(w.db, item, 'parked', 'budget exhausted: heal', t0);
    syncParkBriefings(w.db, w.zone, t0);
    const [b] = listBriefings(w.db, { zoneId: 'main', state: 'open', kind: 'parked' });
    return b?.id ?? -1;
  }

  test('a stale failure → the next pass diagnoses the same briefing again', async () => {
    const b = parked();
    const id = await crewDrop();
    expect(counters(b)).toEqual({ a: 1, r: 0 });
    await applyResult(w.db, deps(), id, stale(), plus(t0, MIN));
    expect(getDrop(w.db, id)?.state).toBe('failed');
    expect(counters(b)).toEqual({ a: 0, r: 1 });
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).toMatchObject({
      role: 'diagnose',
      briefingId: b,
    });
  });

  test('"stale info" is stale too', async () => {
    const b = parked();
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, stale('stale info: the PR changed'), plus(t0, MIN));
    expect(counters(b)).toEqual({ a: 0, r: 1 });
  });

  test('D3: three stale failures → three diagnose drops in all; a fourth pass schedules none', async () => {
    const b = parked();
    for (let i = 0; i < 3; i++) {
      const id = await crewDrop(plus(t0, 2 * i * MIN));
      await applyResult(w.db, deps(), id, stale(), plus(t0, (2 * i + 1) * MIN));
    }
    expect(diagnoseDrops()).toBe(3);
    expect(counters(b)).toEqual({ a: 1, r: 2 });
    expect(nextCrewWork(w.db, w.zone, plus(t0, 10 * MIN))).not.toMatchObject({
      role: 'diagnose',
    });
    const pass = await zonePass(w.forges, w.zone, 'main');
    await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, plus(t0, 10 * MIN));
    expect(diagnoseDrops()).toBe(3);
  });

  test('any other failure counts as the one attempt: no rerun', async () => {
    const b = parked();
    const id = await crewDrop();
    await applyResult(w.db, deps(), id, stale('claude exit 1'), plus(t0, MIN));
    expect(counters(b)).toEqual({ a: 1, r: 0 });
    expect(nextCrewWork(w.db, w.zone, plus(t0, 2 * MIN))).not.toMatchObject({
      role: 'diagnose',
    });
  });

  test('a briefing ruled or withdrawn before the stale result lands is not rediagnosed', async () => {
    for (const end of ['ruled', 'withdrawn'] as const) {
      w = await crewWorld();
      const b = parked();
      const id = await crewDrop();
      if (end === 'ruled') {
        expect(ruleBriefing(w.db, b, 'leave', '', plus(t0, MIN)).ok).toBe(true);
      } else {
        setWorkItemState(w.db, item, 'ready', undefined, plus(t0, MIN));
        syncParkBriefings(w.db, w.zone, plus(t0, MIN));
      }
      const before = counters(b);
      await applyResult(w.db, deps(), id, stale(), plus(t0, 2 * MIN));
      expect(counters(b), end).toEqual(before);
      expect(nextCrewWork(w.db, w.zone, plus(t0, 3 * MIN)), end).not.toMatchObject({
        role: 'diagnose',
      });
    }
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

describe('audit results (#385)', () => {
  // A day on, clear of any lead cycle the tests above ran at t0.
  const at = (m: number) => plus(t0, 24 * 60 * MIN + m * MIN);
  const AUDIT_ISSUE = {
    title: 'Cap the retry count the merged change left unbounded',
    body: `## Context

src/retry.ts:12 loops without a cap; the merged change dropped the check.

## Acceptance criteria

- [ ] retries stop after 3

## Required tests

- a test that a fourth retry is not attempted
`,
  };

  /** A running audit drop for the commit merged after the cursor, and that commit's SHA. */
  async function auditDrop(zone: DropZoneConfig = w.zone): Promise<{ id: string; sha: string }> {
    w.f.state.commit('main', 'chore: base');
    const lead1 = await crewDrop(at(0), zone);
    updateDrop(w.db, lead1, { state: 'succeeded' });
    const pass = await zonePass(w.forges, zone, 'main');
    // The first audit pass stores the cursor at the head.
    expect(
      await enqueueCrew(w.db, w.forges, zone, pass, promptVersions(), usageCfg, at(1)),
    ).toBeNull();
    const sha = w.f.state.commit('main', 'feat: retries (#12)');
    const lead2 = await crewDrop(at(61), zone);
    updateDrop(w.db, lead2, { state: 'succeeded' });
    const id = await crewDrop(at(62), zone);
    expect(getDrop(w.db, id)?.role).toBe('audit');
    return { id, sha };
  }

  const auditRow = () => listAudits(w.db, 'main')[0];

  test('holds: the audit is settled holds and nothing is filed', async () => {
    const { id, sha } = await auditDrop();
    await applyResult(w.db, deps(), id, completed({ verdict: 'holds', findings: [] }), at(63));
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    expect(auditRow()).toMatchObject({ sha, dropId: id, state: 'holds', crewIssueId: null });
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });

  test('a refutation files one staged crew issue under audit:<sha7>, its body ending with the audit line', async () => {
    const { id, sha } = await auditDrop();
    const sha7 = sha.slice(0, 7);
    await applyResult(
      w.db,
      deps(),
      id,
      completed({
        verdict: 'refuted',
        findings: ['src/retry.ts:12 has no cap'],
        issue: { ...AUDIT_ISSUE, body: `${AUDIT_ISSUE.body}\n\n` },
      }),
      at(63),
    );
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    const filed = listCrewIssues(w.db, 'main');
    expect(filed).toHaveLength(1);
    const c = filed[0];
    expect(c).toMatchObject({
      key: `audit-${sha7}`,
      objective: `audit:${sha7}`,
      title: AUDIT_ISSUE.title,
      source: 'drop',
      sourceRef: id,
      state: 'filing',
    });
    expect(c?.body.split('\n').at(-1)).toBe(`Found by the audit of ${sha}.`);
    expect(c?.body).toBe(`${AUDIT_ISSUE.body.trim()}\n\n${foundByAudit(sha)}`);
    expect(auditRow()).toMatchObject({ state: 'filed', crewIssueId: c?.id, reason: null });

    // The only forge op it leads to is the staged issue's create_issue, through flushCrewOps.
    await flushCrewOps(w.db, w.forges, w.zone, [], at(64));
    const ops = listOutbox(w.db, ['pending', 'unknown', 'done', 'failed'], 'main');
    expect(ops.map((o) => o.kind)).toEqual(['create_issue']);
    expect(getCrewIssue(w.db, c?.id ?? -1)?.state).toBe('staged');
    const n = getCrewIssue(w.db, c?.id ?? -1)?.number ?? -1;
    expect(w.f.state.issues.get(n)?.labels).toContain('agent-staged');
    // No revert, reopen, comment or merge: no forge write but the create.
    const writes = w.f.author.calls.filter((x) =>
      [
        'updateIssue',
        'setLabels',
        'createIssueComment',
        'findOrCreatePullRequest',
        'merge',
        'createReview',
        'updateBranch',
      ].includes(x.method),
    );
    expect(writes).toEqual([]);
    // Next it is refuted like any crew issue.
    expect(nextCrewWork(w.db, w.zone, at(65))).toEqual({ role: 'refute', crewIssueId: c?.id });
  });

  test('a refutation naming a protected path in a code span is refused and files nothing', async () => {
    const zone = { ...w.zone, protectedPaths: ['.github/**'] };
    const { id } = await auditDrop(zone);
    const body = AUDIT_ISSUE.body.replace(
      'src/retry.ts:12',
      'SECRET-TEXT in `.github/workflows/ci.yml`',
    );
    await applyResult(
      w.db,
      deps(zone),
      id,
      completed({ verdict: 'refuted', findings: [], issue: { ...AUDIT_ISSUE, body } }),
      at(63),
    );
    expect(getDrop(w.db, id)?.state).toBe('succeeded');
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    const row = auditRow();
    expect(row?.state).toBe('refused');
    expect(row?.reason).toMatch(/protected path/);
    // The reasons never echo the issue's text.
    expect(row?.reason).not.toContain('SECRET-TEXT');
    expect(row?.reason).not.toContain('audit-');
  });

  test('a refutation without ## Required tests is refused and files nothing', async () => {
    const { id } = await auditDrop();
    const body = AUDIT_ISSUE.body.slice(0, AUDIT_ISSUE.body.indexOf('## Required tests'));
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ verdict: 'refuted', findings: [], issue: { ...AUDIT_ISSUE, body } }),
      at(63),
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(auditRow()?.state).toBe('refused');
    expect(auditRow()?.crewIssueId).toBeNull();
  });

  test('a body over the limit once the audit line is added is refused', async () => {
    const { id } = await auditDrop();
    const body = `${AUDIT_ISSUE.body}\n${'x'.repeat(12_000 - AUDIT_ISSUE.body.length - 1)}`;
    expect(body.length).toBeLessThanOrEqual(12_000);
    await applyResult(
      w.db,
      deps(),
      id,
      completed({ verdict: 'refuted', findings: [], issue: { ...AUDIT_ISSUE, body } }),
      at(63),
    );
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
    expect(auditRow()).toMatchObject({ state: 'refused' });
    expect(auditRow()?.reason).toMatch(/12000/);
  });

  test('a failed drop ends failed with its reason', async () => {
    const { id } = await auditDrop();
    await applyResult(
      w.db,
      deps(),
      id,
      { status: 'failed', reason: 'crew modified the tree', gates: [] },
      at(63),
    );
    expect(getDrop(w.db, id)?.state).toBe('failed');
    expect(auditRow()?.state).toBe('failed');
    expect(auditRow()?.reason).toContain('crew modified the tree');
    expect(listCrewIssues(w.db, 'main')).toEqual([]);
  });

  test('an invalid output ends failed', async () => {
    const { id } = await auditDrop();
    await applyResult(w.db, deps(), id, completed({ verdict: 'refuted', findings: [] }), at(63));
    expect(getDrop(w.db, id)?.state).toBe('failed');
    expect(auditRow()?.state).toBe('failed');
    expect(auditRow()?.reason).toMatch(/^invalid crew output: issue/);
  });

  test('a rate-limited drop ends failed, and the commit is not audited again', async () => {
    const { id } = await auditDrop();
    await applyResult(w.db, deps(), id, { status: 'rate_limited', gates: [] }, at(63));
    expect(auditRow()).toMatchObject({ state: 'failed', reason: 'the drop was rate-limited' });
    // The cursor has moved past it: the next cycle finds nothing new.
    const lead = await crewDrop(at(124));
    updateDrop(w.db, lead, { state: 'succeeded' });
    const pass = await zonePass(w.forges, w.zone, 'main');
    expect(
      await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at(125)),
    ).toBeNull();
    expect(listAudits(w.db, 'main')).toHaveLength(1);
  });

  test('a lost drop ends failed on the next pass', async () => {
    const { id } = await auditDrop();
    updateDrop(w.db, id, { state: 'lost' });
    const pass = await zonePass(w.forges, w.zone, 'main');
    await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at(63));
    expect(auditRow()).toMatchObject({
      state: 'failed',
      reason: 'the audit drop ended without a verdict',
    });
  });

  test('a re-delivered verdict acts once', async () => {
    const { id } = await auditDrop();
    const drop = getDrop(w.db, id) as Drop;
    const out = completed({ verdict: 'refuted', findings: [], issue: AUDIT_ISSUE });
    await applyCrewResult(w.db, deps(), drop, out, at(63));
    await applyCrewResult(w.db, deps(), drop, out, at(64));
    expect(listCrewIssues(w.db, 'main')).toHaveLength(1);
    expect(auditRow()?.state).toBe('filed');
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
    expect(again?.decision).toBe(
      'Issue #1 is parked again after the crew retried it once. Retry it, close it as done, or leave it?',
    );
    expect(again?.why).toMatch(
      new RegExp(
        `^The crew already retried this once on ${retriedAt.slice(0, 10)}\\. Its diagnosis: `,
      ),
    );
    expect(again?.why).toContain(`It told the next attempt: ${INSTRUCTION}`);
    expect(again?.options.map((o) => o.effect)).toEqual(['retry_item', 'close_item', 'none']);
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
    expect(openBriefing(h)).toMatchObject({
      decision: 'Issue #1 is parked. Retry it, close it as done, or leave it?',
    });
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

describe('the crew acts once on a parked PR on its own diagnosis (#420)', () => {
  const gateOk = { name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' };
  const INSTRUCTION =
    'Merge main again; the conflict in config.ts is resolved by keeping both keys.';
  const DIAGNOSIS = 'The last resolve ran out of budget on a conflict in config.ts.';
  const diag = (o: Record<string, unknown> = {}) => ({
    diagnosis: DIAGNOSIS,
    recommendation: 'retry',
    detail: 'Retry it with the fix.',
    instruction: INSTRUCTION,
    ...o,
  });
  const rerun = (checks: string[] = ['images']) => ({
    diagnosis: 'The images step failed on a registry timeout; it passed on the parent commit.',
    recommendation: 'rerun_checks',
    detail: 'Re-run the images check.',
    checks,
  });
  const IMAGES_FAILED = {
    state: 'failure' as const,
    names: ['ci', 'images'],
    failed: [{ name: 'images', conclusion: 'failure' }],
  };

  type Park =
    | 'budget exhausted: resolve'
    | 'budget exhausted: base-sync'
    | 'heal made no changes (CI)'
    | 'heal blocked (CI)'
    | 'gate script changed'
    | 'human hold'
    | 'hand-opened conflict'
    | 'no_changes'
    | 'review disagreement'
    | 'heal made no changes (review)'
    | 'heal blocked (review)'
    | 'heal failed a gate (CI)'
    | 'heal failed a gate (review)'
    | 'heal failed a gate (human)';

  const item = (h: Harness) => listWorkItems(h.db, 'main').find((i) => i.id === 1);
  const briefings = (h: Harness) =>
    listBriefings(h.db, { zoneId: 'main', kind: 'parked' }).filter((b) => b.subject === 'item:1');
  const openBriefing = (h: Harness) => briefings(h).find((b) => b.state === 'open');
  const rows = (h: Harness) =>
    (h.db.prepare('SELECT COUNT(*) AS n FROM crew_retries').get() as { n: number }).n;
  const count = (h: Harness, table: string) =>
    (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const prNumber = (h: Harness) => getPullRequest(h.db, 1)?.number ?? -1;
  async function diagnose(h: Harness, result: DropResult): Promise<string> {
    const { dropId, epoch, payload } = await h.lease();
    expect(payload.role).toBe('diagnose');
    expect(await h.postResult(dropId, epoch, result)).toBe(204);
    return dropId;
  }
  /** No crew result ever writes a ruling or a gate allowance: checked after every case. */
  function noRulings(h: Harness, name = ''): void {
    expect(count(h, 'rulings'), name).toBe(0);
    expect(count(h, 'gate_allowances'), name).toBe(0);
  }

  /** A zone that requires CI, with branch rules that require the `ci` check. */
  async function ciHarness(): Promise<Harness> {
    const h = await harness({
      zone: { crew: crewOn, triage: { gate: false }, ciRequired: true },
    });
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
    return h;
  }
  const plain = () => harness({ zone: { crew: crewOn, triage: { gate: false } } });

  /** PR at head 1, approved, the `images` check failed: a heal on CI feedback is queued. */
  async function toCiHeal(h: Harness): Promise<void> {
    await toPrOpen(h, headN(1));
    await h.reconcile();
    await h.finishDrop('review', {
      status: 'completed',
      gates: [gateOk],
      verdict: { decision: 'approve', summary: 'ok', findings: [] },
    });
    h.forge.state.checks.set(headN(1), IMAGES_FAILED);
    for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
  }

  /** PR at head 1, changes requested by the automated review: a heal on review feedback. */
  async function toReviewHeal(h: Harness): Promise<void> {
    await toPrOpen(h, headN(1));
    await h.reconcile();
    await h.finishDrop('review', {
      status: 'completed',
      gates: [gateOk],
      verdict: {
        decision: 'request_changes',
        summary: 'no',
        findings: [{ severity: 'major', detail: 'cover the empty list' }],
      },
    });
    for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
  }

  /** PR at head 1, changes requested by a trusted person: a heal on human feedback. */
  async function toHumanHeal(h: Harness): Promise<void> {
    await toPrOpen(h, headN(1));
    h.forge.state.review({
      author: 'alice',
      state: 'CHANGES_REQUESTED',
      body: 'cover the empty list',
      commitId: headN(1),
    });
    for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
  }

  const GATE_FAILED = 'gate test failed';
  /** The heal commits locally, its `test` gate fails, and it pushes nothing (#675). */
  async function healFailsGate(h: Harness, reason = GATE_FAILED): Promise<void> {
    await h.finishDrop('heal', {
      status: 'failed',
      reason,
      gates: [{ ...gateOk, exitCode: 1 }],
    });
    expect(item(h)).toMatchObject({ state: 'parked', reason });
  }

  /** Two heals that change nothing on the same findings park the item. */
  async function healsNoChanges(h: Harness): Promise<void> {
    await h.finishDrop('heal', { status: 'no_changes', gates: [gateOk] });
    await h.reconcile();
    await h.finishDrop('heal', { status: 'no_changes', gates: [gateOk] });
  }

  const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });
  /** Head `sha` of the PR changes the `test` gate script, or leaves it as on the base. */
  function gateChange(h: Harness, sha: string, changed = true): void {
    h.forge.state.pullFiles.set(prNumber(h), {
      files: [{ path: 'package.json' }],
      complete: true,
    });
    h.forge.state.files.set('base0:package.json', pkg({ test: 'vitest' }));
    h.forge.state.files.set(
      `${sha}:package.json`,
      pkg({ test: changed ? 'vitest --passWithNoTests' : 'vitest' }),
    );
  }

  /**
   * Issue 1 parked on `park` through the real flow where it can be (its state set directly where
   * the flow would take a budget's worth of rounds), then a pass raises its briefing and queues
   * its diagnose drop.
   */
  async function parkedOn(park: Park): Promise<Harness> {
    let h: Harness;
    switch (park) {
      case 'budget exhausted: resolve':
      case 'budget exhausted: base-sync':
      case 'hand-opened conflict': {
        h = await plain();
        await toPrOpen(h, headN(1));
        const reason =
          park === 'hand-opened conflict' ? 'hand-opened PR on agent branch: #9' : park;
        setWorkItemState(h.db, 1, 'parked', reason, h.now());
        break;
      }
      case 'heal made no changes (CI)':
        h = await ciHarness();
        await toCiHeal(h);
        await healsNoChanges(h);
        break;
      case 'heal blocked (CI)':
        h = await ciHarness();
        await toCiHeal(h);
        await h.finishDrop('heal', {
          status: 'blocked',
          reason: 'cannot reproduce the images failure; re-run the job',
          gates: [gateOk],
        });
        break;
      case 'heal made no changes (review)':
        h = await plain();
        await toReviewHeal(h);
        await healsNoChanges(h);
        break;
      case 'heal blocked (review)':
        h = await plain();
        await toReviewHeal(h);
        await h.finishDrop('heal', { status: 'blocked', reason: 'blocked', gates: [gateOk] });
        break;
      case 'heal failed a gate (CI)':
        h = await ciHarness();
        await toCiHeal(h);
        await healFailsGate(h);
        break;
      case 'heal failed a gate (review)':
        h = await plain();
        await toReviewHeal(h);
        await healFailsGate(h);
        break;
      case 'heal failed a gate (human)':
        h = await plain();
        await toHumanHeal(h);
        await healFailsGate(h);
        break;
      case 'gate script changed':
        h = await plain();
        await toPrOpen(h, headN(1));
        gateChange(h, headN(1));
        await h.reconcile();
        break;
      case 'human hold': {
        h = await plain();
        await toPrOpen(h, headN(1));
        const pull = h.forge.state.pulls.get(prNumber(h));
        if (pull) pull.labels = ['jm:hold'];
        await h.reconcile();
        break;
      }
      case 'no_changes':
        h = await plain();
        for (let n = 0; n < 5 && item(h)?.state !== 'parked'; n++) {
          await h.reconcile();
          await h.finishDrop('implement', { status: 'no_changes', gates: [] });
        }
        expect(item(h)?.reason).toBe('no_changes');
        break;
      case 'review disagreement':
        // The arbiter off, so the diagnose runs as it does for any park the arbiter does not take.
        h = await arbiterHarness({ zone: { crew: { ...crewOn, arbiter: false } } });
        await toHealsExhausted(h);
        break;
    }
    await h.reconcile();
    expect(item(h)?.state, park).toBe('parked');
    expect(openBriefing(h), park).toBeDefined();
    expect(h.queuedRoles(), park).toEqual(['diagnose']);
    return h;
  }

  const ACCEPTED: Park[] = [
    'budget exhausted: resolve',
    'budget exhausted: base-sync',
    'heal made no changes (CI)',
    'heal blocked (CI)',
    'heal failed a gate (CI)',
    'heal failed a gate (review)',
    'heal failed a gate (human)',
  ];
  const REFUSED: Park[] = [
    'human hold',
    'hand-opened conflict',
    'no_changes',
    'review disagreement',
    'heal made no changes (review)',
    'heal blocked (review)',
  ];

  describe('crewMayRetry', () => {
    test.each([...ACCEPTED, 'gate script changed' as Park])(
      'accepts %s with an open PR',
      async (park) => {
        const h = await parkedOn(park);
        expect(crewMayRetry(h.db, h.zone, 1)).toBe(true);
        const off = { ...h.zone, crew: { ...h.zone.crew, autoRetry: false } };
        expect(crewMayRetry(h.db, off, 1)).toBe(false);
      },
    );

    test.each(REFUSED)('refuses %s', async (park) => {
      const h = await parkedOn(park);
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
    });

    test('refuses an accepted reason once the PR is closed', async () => {
      const h = await parkedOn('budget exhausted: resolve');
      const pr = getPullRequest(h.db, 1);
      upsertPullRequest(h.db, { ...(pr as never), state: 'closed' }, h.now());
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
    });
  });

  test.each(ACCEPTED)(
    '%s: a retry is recorded once, withdraws the briefing, and the item is retried',
    async (park) => {
      const h = await parkedOn(park);
      const raised = openBriefing(h);
      const dropId = await diagnose(h, completed(diag()));
      expect(getCrewRetry(h.db, 1)).toMatchObject({
        kind: 'retry',
        briefingId: raised?.id,
        dropId,
        instruction: INSTRUCTION,
        appliedAt: null,
      });
      expect(briefings(h).find((b) => b.id === raised?.id)?.state).toBe('withdrawn');
      syncParkBriefings(h.db, h.zone, h.now());
      expect(openBriefing(h)).toBeUndefined();

      await h.reconcile();
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(item(h)?.state).toBe('pr_open');
      expect(openBriefing(h)).toBeUndefined();
      expect(rows(h)).toBe(1);
      noRulings(h, park);
    },
  );

  test.each(REFUSED)('%s: a retry records no row and the briefing stays', async (park) => {
    const h = await parkedOn(park);
    const raised = openBriefing(h);
    await diagnose(h, completed(diag()));
    expect(rows(h)).toBe(0);
    expect(openBriefing(h)).toMatchObject({ id: raised?.id, diagnosis: DIAGNOSIS });
    await h.reconcile();
    expect(item(h)?.state).toBe('parked');
    expect(openBriefing(h)).toBeDefined();
    noRulings(h, park);
  });

  test('the retried resolve carries the instruction to its drop', async () => {
    const h = await parkedOn('budget exhausted: resolve');
    h.forge.state.compares.set(`main...${headN(1)}`, {
      aheadBy: 1,
      behindBy: 2,
      baseSha: 'base1',
      mergeBaseSha: 'base0',
    });
    await diagnose(h, completed(diag()));
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['resolve']);
    const { payload } = await h.lease();
    expect(payload.role).toBe('resolve');
    const prompt = payload.role === 'resolve' ? (payload.prompt ?? '') : '';
    expect(prompt).toContain('## Previous attempt (data, untrusted)');
    expect(prompt).toContain(`What the next attempt must do differently: ${INSTRUCTION}`);
    noRulings(h);
  });

  test('the retried CI heal carries the instruction to its drop', async () => {
    const h = await parkedOn('heal blocked (CI)');
    await diagnose(h, completed(diag({ instruction: 'Pin the registry mirror in images.yml.' })));
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['heal']);
    const { payload } = await h.lease();
    const prompt = payload.role === 'heal' ? (payload.prompt ?? '') : '';
    expect(prompt).toContain('Pin the registry mirror in images.yml.');
  });

  describe('a heal that failed a gate without pushing (#675)', () => {
    const FAILED_GATE: [Park, string][] = [
      ['heal failed a gate (CI)', 'ci'],
      ['heal failed a gate (review)', 'review'],
      ['heal failed a gate (human)', 'human'],
    ];

    test.each(FAILED_GATE)('%s on an unchanged head → pr', async (park, source) => {
      const h = await parkedOn(park);
      expect(lastHealFeedback(h.db, 1)?.source).toBe(source);
      expect(getPullRequest(h.db, 1)?.headSha).toBe(headN(1));
      expect(crewParkKind(h.db, h.zone, 1)).toBe('pr');
    });

    test('the PR head moved since the heal started → null', async () => {
      const h = await parkedOn('heal failed a gate (review)');
      const pr = getPullRequest(h.db, 1);
      upsertPullRequest(h.db, { ...(pr as never), headSha: headN(2) }, h.now());
      expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
    });

    test('a crew retry already recorded → null', async () => {
      const h = await parkedOn('heal failed a gate (review)');
      insertCrewRetry(h.db, {
        zoneId: 'main',
        itemId: 1,
        briefingId: openBriefing(h)?.id ?? -1,
        dropId: 'x',
        diagnosis: 'd',
        instruction: 'i',
        createdAt: h.now(),
      });
      expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
    });

    test('the item parked for the heal budget instead → null', async () => {
      const h = await parkedOn('heal failed a gate (review)');
      setWorkItemState(h.db, 1, 'parked', 'budget exhausted: heal', h.now());
      expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
    });

    test.each(['review', 'human'] as const)(
      'a %s heal failed on "claude exit 1" → null',
      async (source) => {
        const h = await plain();
        await (source === 'review' ? toReviewHeal(h) : toHumanHeal(h));
        await healFailsGate(h, 'claude exit 1');
        expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
      },
    );

    test('the PR closed → null', async () => {
      const h = await parkedOn('heal failed a gate (review)');
      const pr = getPullRequest(h.db, 1);
      upsertPullRequest(h.db, { ...(pr as never), state: 'closed' }, h.now());
      expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
    });

    test('a diagnose recommending retry → one retry applied, back to pr_open, a new heal queued', async () => {
      const h = await parkedOn('heal failed a gate (CI)');
      const raised = openBriefing(h);
      const instruction = 'Run the empty-list test locally before committing; it fails on [].';
      await diagnose(h, completed(diag({ instruction })));
      expect(getCrewRetry(h.db, 1)).toMatchObject({ kind: 'retry', instruction, appliedAt: null });
      expect(briefings(h).find((b) => b.id === raised?.id)?.state).toBe('withdrawn');
      await h.reconcile();
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(item(h)?.state).toBe('pr_open');
      expect(h.queuedRoles()).toEqual(['heal']);
      const { payload } = await h.lease();
      const prompt = payload.role === 'heal' ? (payload.prompt ?? '') : '';
      expect(prompt).toContain(instruction);
      expect(openBriefing(h)).toBeUndefined();
      expect(rows(h)).toBe(1);
      noRulings(h);
    });

    test('on review feedback (#628): the retry reviews the head afresh, then heals; no second retry', async () => {
      const h = await parkedOn('heal failed a gate (review)');
      const raised = openBriefing(h);
      await diagnose(h, completed(diag()));
      expect(getCrewRetry(h.db, 1)).toMatchObject({ kind: 'retry', appliedAt: null });
      expect(briefings(h).find((b) => b.id === raised?.id)?.state).toBe('withdrawn');
      await h.reconcile();
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(item(h)?.state).toBe('pr_open');
      // As any retry: the stored request-changes on the head is cleared, so it is reviewed again.
      expect(h.queuedRoles()).toEqual(['review']);
      await h.finishDrop('review', {
        status: 'completed',
        gates: [gateOk],
        verdict: {
          decision: 'request_changes',
          summary: 'no',
          findings: [{ severity: 'major', detail: 'cover the empty list' }],
        },
      });
      for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
      expect(h.queuedRoles()).toEqual(['heal']);
      expect(openBriefing(h)).toBeUndefined();
      // The heal fails its gate again: the item parks, and the crew may not retry it a second time.
      await healFailsGate(h);
      expect(crewParkKind(h.db, h.zone, 1)).toBeNull();
      expect(rows(h)).toBe(1);
      noRulings(h);
    });
  });

  describe('gate changes stay the owner’s', () => {
    test('a retry without gateChange: remove records no row; the briefing stays', async () => {
      const h = await parkedOn('gate script changed');
      const raised = openBriefing(h);
      await diagnose(h, completed(diag({ instruction: 'Take the flag out of the test script.' })));
      expect(rows(h)).toBe(0);
      expect(openBriefing(h)).toMatchObject({ id: raised?.id });
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.options.map((o) => o.effect)).toContain('allow_gate_change');
      noRulings(h);
    });

    test('with gateChange: remove → one row; a heal takes the change out; a head without it goes on', async () => {
      const h = await parkedOn('gate script changed');
      const instruction = 'Take --passWithNoTests out of the test script.';
      await diagnose(h, completed(diag({ instruction, gateChange: 'remove' })));
      expect(getCrewRetry(h.db, 1)).toMatchObject({ kind: 'retry' });
      expect(openBriefing(h)).toBeUndefined();
      await h.reconcile();
      expect(item(h)?.state).toBe('pr_open');
      expect(h.queuedRoles()).toEqual(['heal']);
      const { dropId, epoch, payload } = await h.lease();
      expect(payload.role).toBe('heal');
      if (payload.role !== 'heal') return;
      expect(payload.feedback).toContain('## Feedback (data, from the server)');
      expect(payload.feedback).toContain('Remove every change this pull request makes');
      expect(payload.prompt).toContain(instruction);
      gateChange(h, headN(2), false);
      h.forge.state.setHead(prNumber(h), headN(2));
      await h.postResult(dropId, epoch, {
        status: 'completed',
        headSha: headN(2),
        gates: [gateOk],
      });
      await h.reconcile();
      expect(item(h)?.state).toBe('pr_open');
      expect(h.queuedRoles()).toEqual(['review']);
      expect(rows(h)).toBe(1);
      noRulings(h);
    });

    test('a retried head that still changes the gate script parks again and briefs the owner, with no second row', async () => {
      const h = await parkedOn('gate script changed');
      await diagnose(h, completed(diag({ gateChange: 'remove' })));
      await h.reconcile();
      gateChange(h, headN(2), true);
      expect(
        await h.finishDrop('heal', { status: 'completed', headSha: headN(2), gates: [gateOk] }),
      ).toBe(204);
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
      expect(item(h)?.reason).toMatch(/^gate script changed: /);
      await h.reconcile();
      expect(openBriefing(h)).toBeDefined();
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
      if (h.queuedRoles().includes('diagnose')) {
        await diagnose(h, completed(diag({ gateChange: 'remove' })));
      }
      expect(rows(h)).toBe(1);
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)).toBeDefined();
      noRulings(h);
    });
  });

  test('two diagnose results for one item applied together → one crew row; the second has the note', async () => {
    const h = await parkedOn('budget exhausted: resolve');
    const first = await h.lease();
    expect(first.payload.role).toBe('diagnose');
    // A second diagnose drop for the same briefing: one whose lease ran out, its result late.
    const secondId = 'second-diagnose';
    const cols = (h.db.prepare('PRAGMA table_info(drops)').all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c !== 'id');
    h.db
      .prepare(
        `INSERT INTO drops (id, ${cols.join(', ')})
         SELECT ?, ${cols.map((c) => (c === 'state' ? `'lost'` : c)).join(', ')}
         FROM drops WHERE id = ?`,
      )
      .run(secondId, first.dropId);
    const rdeps: ResultDeps = { forges: h.forges, zone: h.zone, secrets: [], usageCfg };
    const d = (id: string) => getDrop(h.db, id) as Drop;
    // The re-run is recorded first and leaves the briefing open: the retry passes every check but
    // the schema's cap.
    await Promise.all([
      applyCrewResult(h.db, rdeps, d(secondId), completed(rerun()), h.now()),
      applyCrewResult(h.db, rdeps, d(first.dropId), completed(diag()), h.now()),
    ]);
    expect(rows(h)).toBe(1);
    expect(getCrewRetry(h.db, 1)).toMatchObject({ dropId: secondId, kind: 'rerun' });
    const second = listEvents(h.db, first.dropId).map((e) => String(e.data.message));
    expect(second).toContain('crew retry not recorded: the item has one already');
    noRulings(h);
  });

  describe('rerun_checks, against GitHub faked by nock', () => {
    const api = 'https://api.github.com';
    const gh = new GitHubForge('o', 'r', 'tok');
    beforeAll(() => {
      nock.disableNetConnect();
    });
    afterEach(() => {
      nock.cleanAll();
    });
    afterAll(() => {
      nock.enableNetConnect();
    });

    /** The harness's forges, with the author's re-run going to GitHub (nock). */
    const withGitHub = (h: Harness): ForgePair => ({
      ...h.forges,
      author: { ...h.forge.author, rerunFailedChecks: gh.rerunFailedChecks.bind(gh) },
    });
    const ghDeps = (h: Harness) => ({ forges: () => withGitHub(h), zone: () => h.zone });
    /**
     * Workflow run 11 on `sha` has a failed `images` job, run 12 a passing `lint` job; run 11 is
     * `status11` (completed unless said).
     */
    function actionsOn(sha: string, status11 = 'completed'): void {
      nock(api)
        .get('/repos/o/r/actions/runs')
        .query((q) => q.head_sha === sha)
        .reply(200, {
          total_count: 2,
          workflow_runs: [
            { id: 11, status: status11 },
            { id: 12, status: 'completed' },
          ],
        });
      nock(api)
        .get('/repos/o/r/actions/runs/11/jobs')
        .query(true)
        .reply(200, {
          total_count: 1,
          jobs: [{ name: 'images', status: 'completed', conclusion: 'failure' }],
        });
      nock(api)
        .get('/repos/o/r/actions/runs/12/jobs')
        .query(true)
        .reply(200, {
          total_count: 1,
          jobs: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
        });
    }
    async function rerunRecorded(checks: string[]): Promise<Harness> {
      const h = await parkedOn('heal blocked (CI)');
      h.forge.state.checks.set(headN(1), { ...IMAGES_FAILED, names: ['ci', 'images', 'lint'] });
      await diagnose(h, completed(rerun(checks)));
      expect(getCrewRetry(h.db, 1)).toMatchObject({ kind: 'rerun', checks, appliedAt: null });
      // The briefing stays open until the checks are re-run.
      expect(openBriefing(h)).toBeDefined();
      return h;
    }

    test('a failed check on the current head → one rerun-failed-jobs POST per matching run, then the item is retried', async () => {
      const h = await rerunRecorded(['images']);
      actionsOn(headN(1));
      const post = nock(api).post('/repos/o/r/actions/runs/11/rerun-failed-jobs').reply(201, {});
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(1);
      expect(post.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(getCrewRetry(h.db, 1)?.rerunAt).not.toBeNull();
      expect(item(h)?.state).toBe('pr_open');
      syncParkBriefings(h.db, h.zone, h.now());
      expect(openBriefing(h)).toBeUndefined();
      noRulings(h);
    });

    test.each([
      ['a passing check', 'lint'],
      ['a check not on the head', 'deploy'],
    ])('%s → no POST, and the briefing stays', async (_name, check) => {
      const h = await rerunRecorded([check]);
      // Nothing is mocked and the network is off: any request to GitHub would be refused.
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'skipped' });
      expect(getCrewRetry(h.db, 1)?.reason).toContain('is not a failed check');
      syncParkBriefings(h.db, h.zone, h.now());
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.why).toContain(`The crew tried to re-run ${check}: `);
      noRulings(h);
    });

    test('a check that failed on an older head only → no POST, and the briefing stays', async () => {
      const h = await rerunRecorded(['images']);
      // The PR moved on since: images failed on head 1, the head is now 2.
      h.forge.state.setHead(prNumber(h), headN(2));
      const pr = getPullRequest(h.db, 1);
      upsertPullRequest(h.db, { ...(pr as never), headSha: headN(2) }, h.now());
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'skipped' });
      syncParkBriefings(h.db, h.zone, h.now());
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.why).toContain('The crew tried to re-run images: ');
    });

    test('403 → no retry, the row settled skipped, and the why says why', async () => {
      const h = await rerunRecorded(['images']);
      actionsOn(headN(1));
      nock(api)
        .post('/repos/o/r/actions/runs/11/rerun-failed-jobs')
        .reply(403, { message: 'Resource not accessible by personal access token' });
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({
        outcome: 'skipped',
        reason:
          'GitHub refused the re-run (HTTP 403): the token may lack the Actions write permission',
      });
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.why).toMatch(
        /^The crew tried to re-run images: GitHub refused the re-run \(HTTP 403\): the token may lack the Actions write permission\./,
      );
      // It was the item's one crew action.
      expect(crewMayRetry(h.db, h.zone, 1)).toBe(false);
      expect(rows(h)).toBe(1);
      noRulings(h);
    });

    test('a run still in progress (#772) → waits unclaimed; once it completes, exactly one re-run and the item is retried', async () => {
      const h = await rerunRecorded(['images']);
      actionsOn(headN(1), 'in_progress');
      // No POST is mocked and the network is off: a POST on this pass would reject.
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      // Run 11 in progress stops the read: run 12's jobs are not read.
      nock.cleanAll();
      expect(getCrewRetry(h.db, 1)).toMatchObject({
        appliedAt: null,
        outcome: null,
        rerunAt: null,
      });
      expect(item(h)?.state).toBe('parked');
      actionsOn(headN(1));
      const post = nock(api).post('/repos/o/r/actions/runs/11/rerun-failed-jobs').reply(201, {});
      const later = plus(h.now(), 5 * 60_000);
      // Two passes together: the claim decides which posts.
      const n = await Promise.all([
        applyCrewRetries(h.db, ghDeps(h), 'main', later),
        applyCrewRetries(h.db, ghDeps(h), 'main', later),
      ]);
      expect(n[0] + n[1]).toBe(1);
      expect(post.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(getCrewRetry(h.db, 1)?.rerunAt).not.toBeNull();
      expect(item(h)?.state).toBe('pr_open');
      noRulings(h);
    });

    test('run 11 re-run, then run 12 refused 403 "already running" (#925) → the re-run is recorded, never posted again, and the item is retried', async () => {
      const h = await rerunRecorded(['images']);
      nock(api)
        .get('/repos/o/r/actions/runs')
        .query((q) => q.head_sha === headN(1))
        .reply(200, {
          total_count: 2,
          workflow_runs: [
            { id: 11, status: 'completed' },
            { id: 12, status: 'completed' },
          ],
        });
      for (const id of [11, 12]) {
        nock(api)
          .get(`/repos/o/r/actions/runs/${id}/jobs`)
          .query(true)
          .reply(200, {
            total_count: 1,
            jobs: [{ name: 'images', status: 'completed', conclusion: 'failure' }],
          });
      }
      const post = nock(api).post('/repos/o/r/actions/runs/11/rerun-failed-jobs').reply(201, {});
      nock(api)
        .post('/repos/o/r/actions/runs/12/rerun-failed-jobs')
        .reply(403, { message: 'This workflow is already running' });
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(1);
      expect(post.isDone()).toBe(true);
      expect(nock.pendingMocks()).toEqual([]);
      expect(getCrewRetry(h.db, 1)?.rerunAt).not.toBeNull();
      // Nothing is mocked and the network is off: a second POST for run 11 would be refused.
      await applyCrewRetries(h.db, ghDeps(h), 'main', plus(h.now(), 5 * 60_000));
      expect(nock.pendingMocks()).toEqual([]);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'retried' });
      expect(item(h)?.state).toBe('pr_open');
      noRulings(h);
    });

    test('still running 61 minutes after the row was recorded (#772) → skipped, and the item stays parked', async () => {
      const h = await rerunRecorded(['images']);
      actionsOn(headN(1), 'in_progress');
      const late = plus(h.now(), 61 * 60_000);
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', late)).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({
        outcome: 'skipped',
        reason: 'the workflow run is still in progress',
      });
      syncParkBriefings(h.db, h.zone, late);
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.why).toContain(
        'The crew tried to re-run images: the workflow run is still in progress',
      );
      noRulings(h);
    });

    test('a head that moved while waiting (#772) → skipped with the head reason', async () => {
      const h = await rerunRecorded(['images']);
      actionsOn(headN(1), 'in_progress');
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ appliedAt: null, outcome: null });
      h.forge.state.setHead(prNumber(h), headN(2));
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', plus(h.now(), 60_000))).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({
        outcome: 'skipped',
        reason: "the pull request's head moved",
      });
      expect(item(h)?.state).toBe('parked');
    });

    test('the forge throwing → the same as 403, never a retry', async () => {
      const h = await rerunRecorded(['images']);
      nock(api).get('/repos/o/r/actions/runs').query(true).replyWithError('socket hang up');
      expect(await applyCrewRetries(h.db, ghDeps(h), 'main', h.now())).toBe(0);
      expect(getCrewRetry(h.db, 1)).toMatchObject({ outcome: 'skipped' });
      await h.reconcile();
      await h.reconcile();
      expect(item(h)?.state).toBe('parked');
      expect(openBriefing(h)?.why).toContain('The crew tried to re-run images: ');
      expect(rows(h)).toBe(1);
      noRulings(h);
    });

    test('rerun_checks on a gate-change park records nothing', async () => {
      const h = await parkedOn('gate script changed');
      await diagnose(h, completed(rerun()));
      expect(rows(h)).toBe(0);
      expect(openBriefing(h)).toBeDefined();
    });
  });
});
