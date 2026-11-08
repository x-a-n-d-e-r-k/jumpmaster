import type { DropResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { type Briefing, listBriefings, listRulings } from '../briefings.js';
import { ctlRequest } from '../ctl.js';
import { getUsageState } from '../db/repo.js';
import { type Harness, harness } from '../test/flowHarness.js';

const GREEN = [{ name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' }];
const OPERATOR = { authorization: `Bearer ${'o'.repeat(32)}`, host: 'localhost:80' };

const issues = [1, 2].map((n) => ({
  number: n,
  title: `Issue ${n}`,
  body: 'b',
  author: 'human',
  labels: ['agent-ready'],
  createdAt: '2026-01-01T00:00:00.000Z',
}));

/** A live report as the trooper posts it: plan exhausted for the week, this drop on credits. */
const creditsEvent = (h: Harness, o: Record<string, unknown> = {}) => ({
  ts: h.now().toISOString(),
  kind: 'rate_limit',
  data: {
    status: 'allowed',
    resetsAt: '2026-01-04T00:00:00.000Z',
    rateLimitType: 'seven_day',
    unifiedWindows: {
      five_hour: { utilization: 0.5, resetsAt: '2026-01-01T03:00:00.000Z' },
      seven_day: { utilization: 1, resetsAt: '2026-01-04T00:00:00.000Z' },
    },
    isUsingOverage: true,
    overageStatus: 'allowed',
    ...o,
  },
});

async function postEvents(h: Harness, dropId: string, epoch: number, events: unknown[]) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/drops/${dropId}/events`,
    headers: h.stickHeaders(),
    payload: { epoch, events },
  });
  return res.statusCode;
}

async function leaseStatus(h: Harness): Promise<number> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sticks/lease',
    headers: h.stickHeaders(),
    payload: { freeSlots: 1 },
  });
  return res.statusCode;
}

const openStop = (h: Harness): Briefing[] =>
  listBriefings(h.db, { state: 'open' }).filter((b) => b.subject.startsWith('credits:stop:'));

describe('a drop on usage credits stops dispatch', () => {
  test('a live event stops the next lease of every role before the result; Resume lets the queue run', async () => {
    let kicks = 0;
    const h = await harness({
      issues,
      zone: { maxConcurrentImplement: 2 },
      kick: () => {
        kicks++;
      },
    });
    await h.reconcile();
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['implement', 'implement']);
    const d1 = await h.lease();
    h.at(1);
    expect(await postEvents(h, d1.dropId, d1.epoch, [creditsEvent(h)])).toBe(204);
    expect(kicks).toBe(1);
    // The other implement stays queued.
    expect(await leaseStatus(h)).toBe(204);
    // The running drop finishes; its review is queued but does not lease either.
    h.at(1);
    h.forge.state.branches.set(d1.payload.branch, 'a1');
    expect(
      await h.postResult(d1.dropId, d1.epoch, { status: 'completed', headSha: 'a1', gates: GREEN }),
    ).toBe(204);
    await h.reconcile();
    expect(h.queuedRoles()).toContain('review');
    expect(await leaseStatus(h)).toBe(204);

    const [b, ...more] = openStop(h);
    expect(more).toEqual([]);
    expect(b?.subject).toBe(`credits:stop:${d1.dropId}`);
    const home = await h.app.inject({ method: 'GET', url: '/' });
    expect(home.body).toContain(`stopped: drop ${d1.dropId} ran on usage credits`);
    expect(home.body).toContain('Overage status');

    const rule = await h.app.inject({
      method: 'POST',
      url: `/api/control/briefings/${b?.id}/rule`,
      headers: OPERATOR,
      payload: { optionId: 'resume' },
    });
    expect(rule.statusCode).toBe(200);
    h.at(1);
    await h.reconcile();
    expect(getUsageState(h.db).overageResumeUntil).toBe('2026-01-01T03:00:00.000Z');
    expect(openStop(h)).toEqual([]);
    // Queued drops lease after Resume, finishing work first.
    const next = await h.lease();
    expect(next.payload.role).toBe('review');
    // The resumed item's review runs on credits too: expected within the horizon, counted.
    h.at(1);
    expect(await postEvents(h, next.dropId, next.epoch, [creditsEvent(h)])).toBe(204);
    expect(getUsageState(h.db).overageStoppedAt).toBeNull();
    const page = await h.app.inject({ method: 'GET', url: '/' });
    expect(page.body).toContain('resumed on credits until 2026-01-01T03:00:00.000Z; 1 drop');
  });

  test('the result alone stops when the live events were lost', async () => {
    const h = await harness({ issues, zone: { maxConcurrentImplement: 2 } });
    await h.reconcile();
    await h.reconcile();
    const d1 = await h.lease();
    const result: DropResult = {
      status: 'failed',
      gates: GREEN,
      rateLimit: { status: 'allowed', rateLimitType: 'seven_day', isUsingOverage: true },
    };
    expect(await h.postResult(d1.dropId, d1.epoch, result)).toBe(204);
    expect(h.queuedRoles()).toEqual(['implement']);
    expect(await leaseStatus(h)).toBe(204);
    await h.reconcile();
    expect(openStop(h)[0]?.why).toContain('outcome: failed');
  });

  test('a Fable-type limit event on credits still stops', async () => {
    const h = await harness({ issues, zone: { maxConcurrentImplement: 2 } });
    await h.reconcile();
    await h.reconcile();
    const d1 = await h.lease();
    const ev = creditsEvent(h, { rateLimitType: 'seven_day_fable', unifiedWindows: undefined });
    expect(await postEvents(h, d1.dropId, d1.epoch, [ev])).toBe(204);
    expect(await leaseStatus(h)).toBe(204);
  });

  test('stopOnOverage false: the event changes nothing and the queue leases', async () => {
    const h = await harness({
      issues,
      zone: { maxConcurrentImplement: 2 },
      usage: { stopOnOverage: false },
    });
    await h.reconcile();
    await h.reconcile();
    const d1 = await h.lease();
    // Windows under the throttle, so only the credits flag could close the gate.
    const ev = creditsEvent(h, { unifiedWindows: { five_hour: { utilization: 0.5 } } });
    expect(await postEvents(h, d1.dropId, d1.epoch, [ev])).toBe(204);
    expect(await leaseStatus(h)).toBe(200);
  });

  test('ctl briefings lists the stop with its options; ctl rule resumes with a ruling on record', async () => {
    const h = await harness({ issues });
    await h.reconcile();
    const d1 = await h.lease();
    await postEvents(h, d1.dropId, d1.epoch, [creditsEvent(h)]);
    await h.reconcile();
    const list = ctlRequest(['briefings']);
    expect(list).toEqual({ path: '/api/control/briefings', method: 'GET' });
    const res = await h.app.inject({ method: 'GET', url: list?.path ?? '', headers: OPERATOR });
    expect(res.statusCode).toBe(200);
    const [b] = (
      res.json() as { briefings: { id: number; subject: string; options: { id: string }[] }[] }
    ).briefings;
    expect(b?.subject).toBe(`credits:stop:${d1.dropId}`);
    expect(b?.options.map((o) => o.id)).toEqual(['resume', 'noted']);
    const unauth = await h.app.inject({ method: 'GET', url: '/api/control/briefings' });
    expect(unauth.statusCode).toBe(401);

    const rule = ctlRequest(['rule', String(b?.id), 'resume']);
    await h.app.inject({
      method: 'POST',
      url: rule?.path ?? '',
      headers: OPERATOR,
      payload: rule?.body as object,
    });
    await h.reconcile();
    expect(listRulings(h.db, 'main')[0]).toMatchObject({ choice: 'resume', applyError: null });
    expect(listRulings(h.db, 'main')[0]?.appliedAt).not.toBeNull();
    expect(openStop(h)).toEqual([]);
  });
});
