import type { DropResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  applyPendingRulings,
  listBriefings,
  ruleBriefing,
  syncParkBriefings,
} from './briefings.js';
import type { ClaudeConfig, Config } from './config.js';
import { enqueueCrew } from './crew/schedule.js';
import { getDrop, getUsageState, insertDrop, setWorkItemState, updateDrop } from './db/repo.js';
import {
  FABLE_PLANS,
  FABLE_ROLES,
  fableStatus,
  getFableState,
  noteFableSignals,
  resolveModel,
  servedModel,
} from './fable.js';
import { zonePass } from './flow/snapshot.js';
import { buildPayload, promptVersions } from './payloads.js';
import { applyResult } from './results.js';
import { crewWorld } from './test/crew.js';
import { usageCfg, type ZoneWorld } from './test/fixtures.js';
import { plus, t0 } from './test/helpers.js';
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
    expect(FABLE_ROLES).toEqual(['diagnose']);
    expect(FABLE_PLANS).toEqual(['max', 'team_premium']);
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
    for (const plan of ['max', 'team_premium'] as const) {
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

  test('refute and crew-lead never get Fable by default', () => {
    for (const role of ['refute', 'crew-lead', 'implement', 'review'] as const) {
      expect(resolveModel(w.db, maxPlan, w.zone, role, t0)).toBe(w.zone.model);
    }
  });

  test('a Fable id typed into models.diagnose is replaced by the zone model when Fable is unavailable', () => {
    const zone = { ...w.zone, models: { diagnose: 'claude-fable-9', review: 'r-model' } };
    expect(resolveModel(w.db, cfg(), zone, 'diagnose', t0)).toBe(zone.model);
    expect(resolveModel(w.db, cfg(), zone, 'review', t0)).toBe('r-model');
    expect(
      resolveModel(w.db, cfg(), { ...zone, models: { review: 'FABLE-x' } }, 'review', t0),
    ).toBe(zone.model);
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

  test('overage on any other drop raises the briefing without the re-enable option', () => {
    pastDrop('z1', w.zone.model, t0);
    noteFableSignals(w.db, maxPlan, getDrop(w.db, 'z1') as never, overage, t0);
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

  test('ruling Re-enable Fable clears the disable', async () => {
    pastDrop('f1', FABLE, t0);
    noteFableSignals(w.db, maxPlan, getDrop(w.db, 'f1') as never, overage, t0);
    const [b] = listBriefings(w.db, { state: 'open' });
    ruleBriefing(w.db, b?.id ?? -1, 'enable', '', t0);
    const deps = { forges: () => w.forges, zone: () => w.zone };
    expect(await applyPendingRulings(w.db, deps, 'main', t0)).toBe(1);
    expect(getFableState(w.db).disabledReason).toBeNull();
    expect(fableStatus(w.db, maxPlan, t0).available).toBe(true);
  });
});
