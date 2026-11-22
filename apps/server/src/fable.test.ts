import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  ruleBriefing,
  syncParkBriefings,
} from './briefings.js';
import { type ClaudeConfig, type Config, EditableSchema } from './config.js';
import { creditsPass } from './credits.js';
import { applyCrewActions } from './crew/actions.js';
import { enqueueCrew } from './crew/schedule.js';
import { setCrewIssue } from './crew/store.js';
import {
  activeDropFor,
  getDrop,
  getUsageState,
  insertDrop,
  listUsageWindows,
  recordUsageWindows,
  setWorkItemState,
  updateDrop,
} from './db/repo.js';
import {
  FABLE_PLANS,
  FABLE_ROLES,
  fableStatus,
  fableWindow,
  getFableState,
  isFableRequest,
  isFableWindow,
  noteFableSignals,
  ranOnFable,
  resolveModel,
  servedModel,
} from './fable.js';
import { zonePass } from './flow/snapshot.js';
import { buildPayload, promptVersions } from './payloads.js';
import { applyResult } from './results.js';
import { crewWorld, ISSUE_BODY } from './test/crew.js';
import { usageCfg, type ZoneWorld } from './test/fixtures.js';
import { plus, t0 } from './test/helpers.js';
import { renderHome } from './ui/pages.js';
import { ingestRateLimit } from './usage.js';

const FABLE = 'claude-fable-1';
const DAY = 24 * 60 * 60 * 1000;
const cfg = (claude: Partial<ClaudeConfig> = {}): Pick<Config, 'claude'> => ({
  claude: { plan: 'pro', fableWeeklyDropCap: 5, ...claude },
});
const maxPlan = cfg({ plan: 'max', fableModel: FABLE });

const secrets = {
  claudeToken: 'claude-secret',
  githubAuthorToken: 'author-secret',
  githubReviewerToken: 'reviewer-secret',
  joinToken: 'join',
  operatorToken: 'o'.repeat(32),
} as Config['secrets'];

let w: ZoneWorld;
beforeEach(async () => {
  w = await crewWorld();
});

/** A queued diagnose drop for a parked item. */
async function diagnoseDrop(at = t0): Promise<string> {
  const item = w.item(1, 'ready');
  setWorkItemState(w.db, item, 'parked', 'stuck', at);
  syncParkBriefings(w.db, w.zone, at);
  const pass = await zonePass(w.forges, w.zone, 'main');
  const id = await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at);
  if (!id) throw new Error('no diagnose drop');
  return id;
}

/** A finished drop that asked for `model`, created at `at`. */
function pastDrop(id: string, model: string, at: Date): void {
  insertDrop(w.db, {
    id,
    dropZoneId: 'main',
    workItemId: null,
    role: 'diagnose',
    state: 'succeeded',
    createdAt: at.toISOString(),
  });
  updateDrop(w.db, id, { requestedModel: model });
}

describe('which model a drop gets', () => {
  test('pro, team_standard and enterprise never run Fable; diagnose gets the zone model', () => {
    expect(FABLE_ROLES).toEqual(['diagnose', 'arbitrate', 'audit']);
    expect(FABLE_PLANS).toEqual(['max', 'ultra', 'team_premium']);
    for (const plan of ['pro', 'team_standard', 'enterprise'] as const) {
      const c = cfg({ plan, fableModel: FABLE });
      expect(resolveModel(w.db, c, w.zone, 'diagnose', t0)).toBe(w.zone.model);
      expect(fableStatus(w.db, c, t0)).toEqual({
        available: false,
        reason: `plan ${plan} does not include Fable`,
      });
    }
  });

  test('max without fableModel never runs Fable', () => {
    const c = cfg({ plan: 'max' });
    expect(resolveModel(w.db, c, w.zone, 'diagnose', t0)).toBe(w.zone.model);
    expect(fableStatus(w.db, c, t0).reason).toBe('no fableModel is configured');
  });

  test('max with fableModel runs diagnose on Fable and records requested_model', async () => {
    expect(fableStatus(w.db, maxPlan, t0)).toEqual({ available: true, reason: 'available' });
    expect(resolveModel(w.db, maxPlan, w.zone, 'diagnose', t0)).toBe(FABLE);
    for (const plan of ['max', 'ultra', 'team_premium'] as const) {
      expect(resolveModel(w.db, cfg({ plan, fableModel: FABLE }), w.zone, 'diagnose', t0)).toBe(
        FABLE,
      );
    }
    const id = await diagnoseDrop();
    const p = buildPayload(w.db, w.zone, getDrop(w.db, id) as never, secrets, {
      claude: maxPlan.claude,
      now: t0,
    });
    expect(p.model).toBe(FABLE);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
  });

  test('arbitrate runs on Fable when it is available, and on the zone model when not', () => {
    expect(resolveModel(w.db, maxPlan, w.zone, 'arbitrate', t0)).toBe(FABLE);
    expect(
      resolveModel(w.db, cfg({ plan: 'pro', fableModel: FABLE }), w.zone, 'arbitrate', t0),
    ).toBe(w.zone.model);
    expect(resolveModel(w.db, cfg({ plan: 'max' }), w.zone, 'arbitrate', t0)).toBe(w.zone.model);
  });

  test("an audit drop's payload model is the Fable model when Fable is available, and the zone model when not (#385)", async () => {
    const pass = await zonePass(w.forges, w.zone, 'main');
    const enqueue = (at: Date) =>
      enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, at);
    // A lead cycle, the cursor stored at main's head, a merge, the next cycle: an audit drop.
    w.f.state.commit('main', 'chore: base');
    updateDrop(w.db, (await enqueue(t0)) ?? '', { state: 'succeeded' });
    expect(await enqueue(plus(t0, 60_000))).toBeNull();
    w.f.state.commit('main', 'feat: one (#4)');
    updateDrop(w.db, (await enqueue(plus(t0, 61 * 60_000))) ?? '', { state: 'succeeded' });
    const id = (await enqueue(plus(t0, 62 * 60_000))) ?? '';
    expect(getDrop(w.db, id)?.role).toBe('audit');
    const payload = (claude: Pick<Config, 'claude'>) =>
      buildPayload(w.db, w.zone, getDrop(w.db, id) as never, secrets, {
        claude: claude.claude,
        now: t0,
      });
    expect(payload(cfg({ plan: 'pro', fableModel: FABLE })).model).toBe(w.zone.model);
    expect(payload(cfg({ plan: 'max' })).model).toBe(w.zone.model);
    const p = payload(maxPlan);
    expect(p.role).toBe('audit');
    expect(p.model).toBe(FABLE);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
  });

  test('refute, crew-lead, implement, heal and resolve never get Fable by default', () => {
    for (const role of ['refute', 'crew-lead', 'implement', 'heal', 'resolve'] as const) {
      expect(resolveModel(w.db, maxPlan, w.zone, role, t0)).toBe(w.zone.model);
    }
    // Review is a Fable role only while claude.fableReview is on (#605).
    const off = cfg({ plan: 'max', fableModel: FABLE, fableReview: false });
    expect(resolveModel(w.db, off, w.zone, 'review', t0)).toBe(w.zone.model);
  });

  test('a Fable id typed into models.diagnose is replaced by the zone model when Fable is unavailable', () => {
    const zone = { ...w.zone, models: { diagnose: 'claude-fable-9', review: 'r-model' } };
    expect(resolveModel(w.db, cfg(), zone, 'diagnose', t0)).toBe(zone.model);
    expect(resolveModel(w.db, cfg(), zone, 'review', t0)).toBe('r-model');
    expect(
      resolveModel(w.db, cfg(), { ...zone, models: { review: 'FABLE-x' } }, 'review', t0),
    ).toBe(zone.model);
  });

  test('the configured fableModel typed into models counts as Fable even without "fable" in its name', () => {
    const c = cfg({ plan: 'pro', fableModel: 'opus-special' });
    const zone = { ...w.zone, models: { review: 'opus-special' } };
    expect(resolveModel(w.db, c, zone, 'review', t0)).toBe(zone.model);
  });

  test('with the default config no drop changes model', async () => {
    const id = await diagnoseDrop();
    const p = buildPayload(w.db, w.zone, getDrop(w.db, id) as never, secrets);
    expect(p.model).toBe(w.zone.model);
    expect(getDrop(w.db, id)?.requestedModel).toBe(w.zone.model);
  });

  test('the weekly drop cap falls back to the zone model until the oldest Fable drop ages out', () => {
    const c = cfg({ plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 2 });
    pastDrop('f1', FABLE, plus(t0, -6 * DAY));
    pastDrop('z1', w.zone.model, plus(t0, -1 * DAY));
    expect(resolveModel(w.db, c, w.zone, 'diagnose', t0)).toBe(FABLE);
    pastDrop('f2', FABLE, plus(t0, -1 * DAY));
    expect(resolveModel(w.db, c, w.zone, 'diagnose', t0)).toBe(w.zone.model);
    expect(fableStatus(w.db, c, t0).reason).toBe('weekly cap reached (2 Fable drops in 7 days)');
    expect(resolveModel(w.db, c, w.zone, 'diagnose', plus(t0, 1 * DAY + 1000))).toBe(FABLE);
  });

  test('a doctor drop never runs on Fable and never counts toward the weekly cap', () => {
    const c = cfg({ plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 1 });
    const zone = { ...w.zone, models: { doctor: FABLE } };
    expect(resolveModel(w.db, c, zone, 'doctor', t0)).toBe(w.zone.model);
    // A doctor drop recorded as asking for Fable (an older server) does not use the cap up.
    insertDrop(
      w.db,
      {
        id: 'doc',
        dropZoneId: 'main',
        workItemId: null,
        role: 'doctor',
        state: 'succeeded',
        createdAt: plus(t0, -DAY).toISOString(),
      },
      plus(t0, -DAY),
    );
    updateDrop(w.db, 'doc', { requestedModel: FABLE });
    expect(fableStatus(w.db, c, t0).available).toBe(true);
  });
});

describe('refutes of security-touching crew issues (#384)', () => {
  const SECTION = '\n## Security-touching checklist\n\n- D2: fails closed.\n';

  /** A staged crew issue with `body`, ready for a refute. */
  function staged(body: string): number {
    const r = applyCrewActions(
      w.db,
      w.zone,
      {
        fileIssues: [{ key: 'k', objective: 'document-every-endpoint', title: 'Add docs', body }],
      },
      { kind: 'drop', dropId: 'd0' },
      t0,
    );
    const id = r.filed[0] ?? -1;
    setCrewIssue(w.db, id, { state: 'staged', number: 40, bodySha: 'sha-1' }, t0);
    return id;
  }

  /** Enqueues the refute through the real schedule and leases it: the payload's model. */
  async function refuteModel(c: Pick<Config, 'claude'>): Promise<{ id: string; model: string }> {
    const pass = await zonePass(w.forges, w.zone, 'main');
    const id = await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, t0);
    if (!id) throw new Error('no refute drop');
    const drop = getDrop(w.db, id);
    expect(drop?.role).toBe('refute');
    const p = buildPayload(w.db, w.zone, drop as never, secrets, { claude: c.claude, now: t0 });
    return { id, model: p.model };
  }

  const report = (utilization: number) =>
    recordUsageWindows(
      w.db,
      { seven_day_overage_included: { utilization, resetsAt: plus(t0, DAY).toISOString() } },
      plus(t0, -1000),
      'claude-fable-5-2',
    );

  test('the section and Fable available: the refute runs on Fable, recorded as requested_model', async () => {
    staged(`${ISSUE_BODY}${SECTION}`);
    const { id, model } = await refuteModel(maxPlan);
    expect(model).toBe(FABLE);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
    expect(JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}').work).toMatchObject({
      role: 'refute',
      securityTouching: true,
    });
  });

  test('the section with Fable over its weekly limit: the zone model', async () => {
    staged(`${ISSUE_BODY}${SECTION}`);
    report(0.85);
    expect(fableStatus(w.db, maxPlan, t0).available).toBe(false);
    const { id, model } = await refuteModel(maxPlan);
    expect(model).toBe(w.zone.model);
    expect(getDrop(w.db, id)?.requestedModel).toBe(w.zone.model);
  });

  test('another heading level and case counts the same', async () => {
    staged(`${ISSUE_BODY}\n### security-touching CHECKLIST\n\n- x\n`);
    expect((await refuteModel(maxPlan)).model).toBe(FABLE);
  });

  test('an issue without the section: the zone model, and securityTouching false', async () => {
    staged(ISSUE_BODY);
    const { id, model } = await refuteModel(maxPlan);
    expect(model).toBe(w.zone.model);
    expect(JSON.parse(getDrop(w.db, id)?.inputJson ?? '{}').work.securityTouching).toBe(false);
    // As today: refute and crew-lead never get Fable by role.
    for (const role of ['refute', 'crew-lead'] as const) {
      expect(resolveModel(w.db, maxPlan, w.zone, role, t0)).toBe(w.zone.model);
    }
  });

  test('a refute stored before #384 (no securityTouching) of a security-touching issue: the zone model', async () => {
    staged(`${ISSUE_BODY}${SECTION}`);
    const pass = await zonePass(w.forges, w.zone, 'main');
    const id = await enqueueCrew(w.db, w.forges, w.zone, pass, promptVersions(), usageCfg, t0);
    const stored = JSON.parse(getDrop(w.db, id ?? '')?.inputJson ?? '{}');
    delete stored.work.securityTouching;
    w.db.prepare('UPDATE drops SET input_json = ? WHERE id = ?').run(JSON.stringify(stored), id);
    const p = buildPayload(w.db, w.zone, getDrop(w.db, id ?? '') as never, secrets, {
      claude: maxPlan.claude,
      now: t0,
    });
    expect(p.model).toBe(w.zone.model);
  });

  test('{ fable: true } makes any role a Fable role, but never the doctor', () => {
    expect(resolveModel(w.db, maxPlan, w.zone, 'refute', t0, { fable: true })).toBe(FABLE);
    expect(resolveModel(w.db, maxPlan, w.zone, 'refute', t0, { fable: false })).toBe(w.zone.model);
    expect(resolveModel(w.db, maxPlan, w.zone, 'doctor', t0, { fable: true })).toBe(w.zone.model);
    expect(resolveModel(w.db, cfg(), w.zone, 'refute', t0, { fable: true })).toBe(w.zone.model);
  });
});

describe('what the drop reports', () => {
  test('servedModel picks the model with the most output tokens', () => {
    expect(
      servedModel({ a: { outputTokens: 3 }, b: { outputTokens: 9 }, c: { inputTokens: 99 } }),
    ).toBe('b');
    expect(servedModel(undefined)).toBeNull();
    expect(servedModel({})).toBeNull();
  });

  test('the served model is recorded; a Fable request served by another model is shown as such', async () => {
    const id = await diagnoseDrop();
    buildPayload(w.db, w.zone, getDrop(w.db, id) as never, secrets, {
      claude: maxPlan.claude,
      now: t0,
    });
    updateDrop(w.db, id, { state: 'running' });
    const result: DropResult = {
      status: 'completed',
      crew: { diagnosis: 'd', recommendation: 'retry', detail: 'x' },
      gates: [],
      modelUsage: { 'claude-opus-5-5': { outputTokens: 40 }, [FABLE]: { outputTokens: 2 } },
    };
    await applyResult(
      w.db,
      { forges: w.forges, zone: w.zone, secrets: [], usageCfg, claude: maxPlan.claude },
      id,
      result,
      t0,
    );
    expect(getDrop(w.db, id)).toMatchObject({
      requestedModel: FABLE,
      servedModel: 'claude-opus-5-5',
    });
    // The trooper's own report wins when it sent one.
    const id2 = 'reported';
    pastDrop(id2, FABLE, t0);
    updateDrop(w.db, id2, { state: 'running' });
    await applyResult(
      w.db,
      { forges: w.forges, zone: w.zone, secrets: [], usageCfg, claude: maxPlan.claude },
      id2,
      { ...result, servedModel: FABLE },
      t0,
    );
    expect(getDrop(w.db, id2)?.servedModel).toBe(FABLE);
  });
});

describe('ranOnFable', () => {
  const drop = (requestedModel: string | null, servedModel: string | null) =>
    ({ requestedModel, servedModel }) as Parameters<typeof ranOnFable>[1];

  test('a Fable request served by Fable, or with no served model recorded, ran on Fable', () => {
    expect(ranOnFable(maxPlan, drop(FABLE, FABLE))).toBe(true);
    expect(ranOnFable(maxPlan, drop(FABLE, null))).toBe(true);
    expect(ranOnFable(maxPlan, drop('claude-fable-2', 'claude-fable-2'))).toBe(true);
    expect(isFableRequest(maxPlan, drop(FABLE, 'claude-opus-5-5'))).toBe(true);
  });

  test('a Fable request served by another model, or a request for another model, did not', () => {
    expect(ranOnFable(maxPlan, drop(FABLE, 'claude-opus-5-5'))).toBe(false);
    expect(ranOnFable(maxPlan, drop('claude-opus-5-5', null))).toBe(false);
    expect(ranOnFable(maxPlan, drop('claude-opus-5-5', FABLE))).toBe(false);
    expect(ranOnFable(maxPlan, drop(null, FABLE))).toBe(false);
  });
});

describe('Fable signals (best-effort, pending rehearsal)', () => {
  const overage: DropResult = {
    status: 'completed',
    gates: [],
    rateLimit: { status: 'allowed', isUsingOverage: true },
  };

  test('overage on a Fable drop disables Fable and raises one credits_required briefing', () => {
    pastDrop('f1', FABLE, t0);
    pastDrop('f2', FABLE, t0);
    noteFableSignals(w.db, maxPlan, getDrop(w.db, 'f1') as never, overage, t0);
    noteFableSignals(w.db, maxPlan, getDrop(w.db, 'f2') as never, overage, plus(t0, 1000));
    expect(getFableState(w.db).disabledReason).toBe('credits_required');
    expect(fableStatus(w.db, maxPlan, t0)).toEqual({
      available: false,
      reason: 'disabled: credits_required',
    });
    const open = listBriefings(w.db, { state: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'credits_required', zoneId: 'main' });
    expect(open[0]?.options.map((o) => o.effect)).toEqual(['enable_fable', 'none']);
  });

  test('with stopOnOverage off, overage on any other drop raises the briefing without re-enable', () => {
    pastDrop('z1', w.zone.model, t0);
    const off = { ...maxPlan, usage: { stopOnOverage: false } };
    noteFableSignals(w.db, off, getDrop(w.db, 'z1') as never, overage, t0);
    expect(getFableState(w.db).disabledReason).toBeNull();
    const [b] = listBriefings(w.db, { state: 'open' });
    expect(b?.kind).toBe('credits_required');
    expect(b?.options.map((o) => o.effect)).toEqual(['none']);
  });

  test('a Fable-only rate limit pauses Fable, not dispatch', () => {
    const limit = {
      status: 'rejected' as const,
      rateLimitType: 'seven_day_fable',
      resetsAt: '2026-01-03T00:00:00Z',
    };
    pastDrop('f1', FABLE, t0);
    ingestRateLimit(
      w.db,
      limit,
      { dropId: 'f1', workItemId: null, startedAt: t0.toISOString(), outcome: 'rate_limited' },
      usageCfg,
      t0,
    );
    expect(getUsageState(w.db).pausedUntil).toBeNull();
    expect(getFableState(w.db).pausedUntil).toBe('2026-01-03T00:00:00.000Z');
    expect(fableStatus(w.db, maxPlan, t0).available).toBe(false);
    expect(fableStatus(w.db, maxPlan, new Date('2026-01-03T00:00:01Z')).available).toBe(true);
    // Without a reset time: 24 hours.
    noteFableSignals(
      w.db,
      maxPlan,
      getDrop(w.db, 'f1') as never,
      {
        status: 'rate_limited',
        gates: [],
        rateLimit: { status: 'rejected', rateLimitType: 'fable' },
      },
      plus(t0, 5 * DAY),
    );
    expect(getFableState(w.db).pausedUntil).toBe(plus(t0, 6 * DAY).toISOString());
  });

  test('ruling Re-enable Fable clears the disable, in the global credits step', async () => {
    pastDrop('f1', FABLE, t0);
    noteFableSignals(w.db, maxPlan, getDrop(w.db, 'f1') as never, overage, t0);
    const [b] = listBriefings(w.db, { state: 'open' });
    ruleBriefing(w.db, b?.id ?? -1, 'enable', '', t0);
    const deps = { forges: () => w.forges, zone: () => w.zone };
    expect(await applyPendingRulings(w.db, deps, 'main', t0)).toBe(0);
    expect(creditsPass(w.db, t0)).toBe(1);
    expect(getFableState(w.db).disabledReason).toBeNull();
    expect(fableStatus(w.db, maxPlan, t0).available).toBe(true);
  });
});

describe("Fable's budget: its reported weekly window (#381)", () => {
  const FABLE_ID = 'claude-fable-5-2';
  const tomorrow = plus(t0, DAY).toISOString();
  const capped = cfg({ plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 10 });
  let made = 0;
  const fableDrops = (n: number) => {
    for (let i = 0; i < n; i++) pastDrop(`f${made++}`, FABLE, plus(t0, -(i + 1) * 60_000));
  };
  const report = (
    key: string,
    utilization: number,
    model: string | null = FABLE_ID,
    resetsAt: string | undefined = tomorrow,
  ) => recordUsageWindows(w.db, { [key]: { utilization, resetsAt } }, plus(t0, -1000), model);
  const fableMeter = (): string | undefined => {
    const html = renderHome({
      zones: [],
      items: [],
      drops: [],
      usage: {
        gate: 'open',
        state: getUsageState(w.db),
        plan: 'max',
        windows: listUsageWindows(w.db),
      },
    });
    return /<span>Fable \(7-day\)<\/span><b>([^<]*)<\/b>/.exec(html)?.[1];
  };

  test('live install: cap 10, 12 Fable drops, window at 1% → diagnose runs on Fable', async () => {
    fableDrops(12);
    report('seven_day_overage_included', 0.01);
    expect(fableStatus(w.db, capped, t0)).toEqual({ available: true, reason: 'available' });
    const id = await diagnoseDrop();
    const p = buildPayload(w.db, w.zone, getDrop(w.db, id) as never, secrets, {
      claude: capped.claude,
      now: t0,
    });
    expect(p.model).toBe(FABLE);
  });

  test('a window at 85% with the limit at 80% → unavailable; diagnose runs on the zone model', () => {
    report('seven_day_overage_included', 0.85);
    expect(fableStatus(w.db, capped, t0)).toEqual({
      available: false,
      reason: 'Fable weekly usage at 85% (limit 80%)',
    });
    expect(resolveModel(w.db, capped, w.zone, 'diagnose', t0)).toBe(w.zone.model);
  });

  test('the limit is inclusive and follows claude.fableMaxUtilization', () => {
    report('seven_day_overage_included', 0.8);
    expect(fableStatus(w.db, capped, t0).reason).toBe('Fable weekly usage at 80% (limit 80%)');
    const looser = cfg({ ...capped.claude, fableMaxUtilization: 0.9 });
    expect(fableStatus(w.db, looser, t0).available).toBe(true);
    const tighter = cfg({ ...capped.claude, fableMaxUtilization: 0.5 });
    report('seven_day_overage_included', 0.6);
    expect(fableStatus(w.db, tighter, t0).reason).toBe('Fable weekly usage at 60% (limit 50%)');
  });

  test('no window stored: the drop cap applies as before', () => {
    fableDrops(10);
    expect(fableStatus(w.db, capped, t0)).toEqual({
      available: false,
      reason: 'weekly cap reached (10 Fable drops in 7 days)',
    });
  });

  test('a window past its reset is unreported: the drop cap applies', () => {
    fableDrops(2);
    report('seven_day_overage_included', 0.5, FABLE_ID, plus(t0, -60 * 60_000).toISOString());
    expect(fableStatus(w.db, capped, t0)).toEqual({ available: true, reason: 'available' });
    fableDrops(8);
    report('seven_day_overage_included', 0.01, FABLE_ID, plus(t0, -60 * 60_000).toISOString());
    expect(fableStatus(w.db, capped, t0).reason).toBe(
      'weekly cap reached (10 Fable drops in 7 days)',
    );
  });

  test("a per-model window reported by Opus is not Fable's: the drop cap applies", () => {
    report('seven_day_overage_included', 0.95, 'claude-opus-5-5');
    expect(fableStatus(w.db, capped, t0).available).toBe(true);
    fableDrops(10);
    expect(fableStatus(w.db, capped, t0).reason).toBe(
      'weekly cap reached (10 Fable drops in 7 days)',
    );
    expect(fableMeter()).toBe('-');
  });

  test('a read error fails closed', () => {
    w.db.exec('DROP TABLE usage_windows');
    expect(fableStatus(w.db, capped, t0)).toEqual({
      available: false,
      reason: 'Fable usage could not be read',
    });
    expect(resolveModel(w.db, capped, w.zone, 'diagnose', t0)).toBe(w.zone.model);
  });

  test('an invalid utilization fails closed', () => {
    const invalid = { available: false, reason: 'Fable usage report is invalid' };
    report('seven_day_overage_included', -0.1);
    expect(fableStatus(w.db, capped, t0)).toEqual(invalid);
    // NaN as stored in the column (SQLite keeps it as non-numeric text).
    w.db.prepare("UPDATE usage_windows SET utilization = 'NaN'").run();
    expect(fableStatus(w.db, capped, t0)).toEqual(invalid);
    expect(resolveModel(w.db, capped, w.zone, 'diagnose', t0)).toBe(w.zone.model);
  });

  test('a NaN recorded through recordUsageWindows reads as unreported: the drop cap, never unlimited', () => {
    report('seven_day_overage_included', Number.NaN);
    fableDrops(10);
    expect(fableStatus(w.db, capped, t0).reason).toBe(
      'weekly cap reached (10 Fable drops in 7 days)',
    );
  });

  test('both shapes of the Fable window are honoured by the budget and the Floor meter alike', () => {
    expect(fableMeter()).toBe('-');
    report('seven_day_fable', 0.9, null);
    expect(fableStatus(w.db, capped, t0).reason).toBe('Fable weekly usage at 90% (limit 80%)');
    expect(fableMeter()).toBe('90%');
    w.db.exec('DELETE FROM usage_windows');
    report('seven_day_overage_included', 0.42);
    expect(fableStatus(w.db, capped, t0).available).toBe(true);
    expect(fableMeter()).toBe('42%');
    expect(fableWindow(listUsageWindows(w.db))?.key).toBe('seven_day_overage_included');
    expect(
      isFableWindow({
        key: 'seven_day_fable',
        utilization: 0,
        resetsAt: null,
        observedAt: null,
        model: null,
      }),
    ).toBe(true);
  });
});

describe('claude.fableWeeklyDropCap: 0 means no drop cap, and is the default (#399)', () => {
  const drops = (n: number) => {
    for (let i = 0; i < n; i++) pastDrop(`n${i}`, FABLE, plus(t0, -(i + 1) * 60_000));
  };

  test('unset: 50 Fable drops this week and Fable is still available', () => {
    const claude = EditableSchema.shape.claude.parse({ plan: 'ultra', fableModel: FABLE });
    expect(claude.fableWeeklyDropCap).toBe(0);
    drops(50);
    expect(fableStatus(w.db, { claude }, t0)).toEqual({ available: true, reason: 'available' });
  });

  test('a cap of 10: 9 drops is available, 10 reaches the cap', () => {
    const c = cfg({ plan: 'ultra', fableModel: FABLE, fableWeeklyDropCap: 10 });
    drops(9);
    expect(fableStatus(w.db, c, t0)).toEqual({ available: true, reason: 'available' });
    pastDrop('tenth', FABLE, plus(t0, -DAY));
    expect(fableStatus(w.db, c, t0)).toEqual({
      available: false,
      reason: 'weekly cap reached (10 Fable drops in 7 days)',
    });
  });

  test('a cap of 0 with Fable disabled: still unavailable, for the disable', () => {
    const c = cfg({ plan: 'ultra', fableModel: FABLE, fableWeeklyDropCap: 0 });
    w.db
      .prepare(
        "INSERT INTO fable_state (id, disabled_reason, paused_until, updated_at) VALUES (1, 'credits_required', NULL, ?)",
      )
      .run(t0.toISOString());
    expect(fableStatus(w.db, c, t0)).toEqual({
      available: false,
      reason: 'disabled: credits_required',
    });
  });

  test('a cap of 0 with the reported weekly usage over the limit: still unavailable, for usage', () => {
    const c = cfg({ plan: 'ultra', fableModel: FABLE, fableWeeklyDropCap: 0 });
    recordUsageWindows(
      w.db,
      { seven_day_fable: { utilization: 0.9, resetsAt: plus(t0, DAY).toISOString() } },
      plus(t0, -1000),
      null,
    );
    expect(fableStatus(w.db, c, t0)).toEqual({
      available: false,
      reason: 'Fable weekly usage at 90% (limit 80%)',
    });
  });

  test('a cap of 0 still needs a plan that includes Fable and a fableModel', () => {
    expect(
      fableStatus(w.db, cfg({ plan: 'pro', fableModel: FABLE, fableWeeklyDropCap: 0 }), t0),
    ).toMatchObject({ available: false, reason: 'plan pro does not include Fable' });
    expect(fableStatus(w.db, cfg({ plan: 'ultra', fableWeeklyDropCap: 0 }), t0)).toMatchObject({
      available: false,
      reason: 'no fableModel is configured',
    });
  });
});

describe('reviews run on Fable while its budget allows (#605)', () => {
  const R_MODEL = 'r-model';
  const zone = () => ({ ...w.zone, models: { review: R_MODEL } });
  const tomorrow = plus(t0, DAY).toISOString();
  const report = (utilization: number) =>
    recordUsageWindows(
      w.db,
      { seven_day_overage_included: { utilization, resetsAt: tomorrow } },
      plus(t0, -1000),
      'claude-fable-5-2',
    );
  /** A queued review drop for an open pull request. */
  const reviewDrop = (id = 'rv'): string => {
    const item = w.prItem(1, 'h1');
    insertDrop(
      w.db,
      {
        id,
        dropZoneId: 'main',
        workItemId: item,
        role: 'review',
        state: 'queued',
        prNumber: 1,
        headSha: 'h1',
        createdAt: t0.toISOString(),
      },
      t0,
    );
    return id;
  };
  const build = (id: string, claude: ClaudeConfig, z = zone()) =>
    buildPayload(w.db, z, getDrop(w.db, id) as never, secrets, { claude, now: t0 });

  test('utilization 0.3, Fable available: the review gets fableModel, recorded as requested_model', () => {
    report(0.3);
    const id = reviewDrop();
    const p = build(id, maxPlan.claude);
    expect(p.role).toBe('review');
    expect(p.model).toBe(FABLE);
    expect(getDrop(w.db, id)?.requestedModel).toBe(FABLE);
  });

  test("utilization 0.6: the review gets the zone's review model, an audit at the same moment Fable", () => {
    report(0.6);
    const id = reviewDrop();
    expect(build(id, maxPlan.claude).model).toBe(R_MODEL);
    expect(getDrop(w.db, id)?.requestedModel).toBe(R_MODEL);
    expect(resolveModel(w.db, maxPlan, zone(), 'audit', t0)).toBe(FABLE);
    // The threshold follows claude.fableReviewMaxUtilization.
    const looser = cfg({ ...maxPlan.claude, fableReviewMaxUtilization: 0.7 });
    expect(resolveModel(w.db, looser, zone(), 'review', t0)).toBe(FABLE);
    // Inclusive: at the threshold, the zone model.
    const at = cfg({ ...maxPlan.claude, fableReviewMaxUtilization: 0.6 });
    expect(resolveModel(w.db, at, zone(), 'review', t0)).toBe(R_MODEL);
  });

  test('window not reported, cap 10: 6 Fable drops this week gives the zone model; 4 gives Fable', () => {
    const capped = cfg({ plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 10 });
    for (let i = 0; i < 4; i++) pastDrop(`f${i}`, FABLE, plus(t0, -(i + 1) * 60_000));
    expect(resolveModel(w.db, capped, zone(), 'review', t0)).toBe(FABLE);
    for (let i = 4; i < 6; i++) pastDrop(`f${i}`, FABLE, plus(t0, -(i + 1) * 60_000));
    expect(fableStatus(w.db, capped, t0).available).toBe(true);
    expect(resolveModel(w.db, capped, zone(), 'review', t0)).toBe(R_MODEL);
    expect(resolveModel(w.db, capped, zone(), 'diagnose', t0)).toBe(FABLE);
    // A cap of 0 sets no count limit for reviews either.
    const uncapped = cfg({ plan: 'max', fableModel: FABLE, fableWeeklyDropCap: 0 });
    expect(resolveModel(w.db, uncapped, zone(), 'review', t0)).toBe(FABLE);
  });

  test("each unavailable cause gives the zone's review model", () => {
    expect(resolveModel(w.db, cfg({ plan: 'max' }), zone(), 'review', t0)).toBe(R_MODEL);
    expect(resolveModel(w.db, cfg({ plan: 'pro', fableModel: FABLE }), zone(), 'review', t0)).toBe(
      R_MODEL,
    );
    report(0.1);
    const atLimit = cfg({
      ...maxPlan.claude,
      fableMaxUtilization: 0.1,
      fableReviewMaxUtilization: 1,
    });
    expect(fableStatus(w.db, atLimit, t0).available).toBe(false);
    expect(resolveModel(w.db, atLimit, zone(), 'review', t0)).toBe(R_MODEL);
  });

  test('fableReview false: the zone model even at utilization 0', () => {
    report(0);
    const off = cfg({ ...maxPlan.claude, fableReview: false });
    expect(resolveModel(w.db, off, zone(), 'review', t0)).toBe(R_MODEL);
    expect(resolveModel(w.db, maxPlan, zone(), 'review', t0)).toBe(FABLE);
    // A models.review naming Fable behaves as before: Fable while available.
    const named = { ...w.zone, models: { review: FABLE } };
    expect(resolveModel(w.db, off, named, 'review', t0)).toBe(FABLE);
  });

  test('crew roles, implement, heal, resolve and the doctor are unchanged by any review threshold', () => {
    report(0.3);
    const statusOf = (r: number | undefined, on: boolean) =>
      fableStatus(
        w.db,
        cfg({ ...maxPlan.claude, fableReview: on, fableReviewMaxUtilization: r }),
        t0,
      );
    const base = fableStatus(w.db, maxPlan, t0);
    for (const r of [0, 0.2, 0.5, 1, undefined])
      for (const on of [true, false]) expect(statusOf(r, on)).toEqual(base);
    expect(FABLE_ROLES).toEqual(['diagnose', 'arbitrate', 'audit']);
    for (const r of [0, 0.5, 1]) {
      const c = cfg({ ...maxPlan.claude, fableReviewMaxUtilization: r });
      for (const role of ['diagnose', 'arbitrate', 'audit'] as const)
        expect(resolveModel(w.db, c, zone(), role, t0)).toBe(FABLE);
      for (const role of ['implement', 'heal', 'resolve', 'refute', 'crew-lead'] as const)
        expect(resolveModel(w.db, c, zone(), role, t0)).toBe(w.zone.model);
      const doc = { ...w.zone, models: { doctor: FABLE, review: R_MODEL } };
      expect(resolveModel(w.db, c, doc, 'doctor', t0)).toBe(w.zone.model);
      expect(resolveModel(w.db, c, doc, 'doctor', t0, { fable: true })).toBe(w.zone.model);
    }
  });

  test("a review that hits a Fable-only rate limit is replaced on the zone's review model", async () => {
    report(0.3);
    const id = reviewDrop();
    expect(build(id, maxPlan.claude).model).toBe(FABLE);
    updateDrop(w.db, id, { state: 'running' });
    await applyResult(
      w.db,
      { forges: w.forges, zone: zone(), secrets: [], usageCfg, claude: maxPlan.claude },
      id,
      {
        status: 'rate_limited',
        gates: [],
        rateLimit: { status: 'rejected', rateLimitType: 'seven_day_fable', resetsAt: tomorrow },
      },
      t0,
    );
    expect(getDrop(w.db, id)?.state).toBe('cancelled');
    const next = activeDropFor(w.db, getDrop(w.db, id)?.workItemId ?? -1);
    expect(next).toMatchObject({ role: 'review', state: 'queued' });
    const p = build(next?.id ?? '', maxPlan.claude);
    expect(p.model).toBe(R_MODEL);
    expect(getDrop(w.db, next?.id ?? '')?.requestedModel).toBe(R_MODEL);
  });
});
