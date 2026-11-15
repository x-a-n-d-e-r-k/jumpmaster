import type { DropResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import {
  activeDropFor,
  getAttempts,
  getDrop,
  getWorkItem,
  insertDrop,
  isKilled,
  setKilled,
  upsertDropZone,
} from '../db/repo.js';
import { engageKill } from '../leases.js';
import { runOp } from '../outbox.js';
import { type Harness, harness, toPrOpen } from '../test/flowHarness.js';
import { tmpDbFile } from '../test/helpers.js';

const WRITES = ['findOrCreatePullRequest', 'createReview', 'merge'];
const gateOk = { name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' };
const approved: DropResult = {
  status: 'completed',
  verdict: { decision: 'approve', summary: 'ok', findings: [] },
  gates: [gateOk],
};

describe('kill switch', () => {
  test('engaging cancels every queued, leased and running drop', async () => {
    const h = await harness();
    await h.reconcile();
    expect(engageKill(h.db, h.now())).toEqual({ cancelled: 1 });
    expect(activeDropFor(h.db, 1)).toBeUndefined();
    const rows = h.db.prepare('SELECT state, finished_at AS f FROM drops').all() as {
      state: string;
      f: string | null;
    }[];
    expect(rows).toEqual([{ state: 'cancelled', f: h.now().toISOString() }]);
  });

  test('while engaged: no lease, no enqueue, no outbox write, no merge', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const before = h.forge.author.calls
      .concat(h.forge.reviewer.calls)
      .filter((c) => WRITES.includes(c.method)).length;
    engageKill(h.db, h.now());
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    await expect(h.lease()).rejects.toThrow();
    const op = {
      kind: 'merge' as const,
      opKey: 'merge:1:s',
      zoneId: 'main',
      itemId: 1,
      payload: { pr: 1, sha: 's', title: 't', message: 'm' },
    };
    const forges = { author: h.forge.author, reviewer: h.forge.reviewer };
    await expect(runOp(h.db, forges, op, h.now())).rejects.toThrow(/kill switch/);
    expect(
      h.forge.author.calls.concat(h.forge.reviewer.calls).filter((c) => WRITES.includes(c.method)),
    ).toHaveLength(before);
    expect(h.forge.state.merges).toHaveLength(0);
  });

  test('a queued drop is not leased once the switch is set', async () => {
    const h = await harness();
    await h.reconcile();
    setKilled(h.db, true, h.now());
    await expect(h.lease()).rejects.toThrow();
    setKilled(h.db, false, h.now());
    await expect(h.lease()).resolves.toBeDefined();
  });

  test('the switch stays engaged across a restart until explicitly reset', () => {
    const file = tmpDbFile();
    const db = openDb(file);
    engageKill(db, new Date());
    db.close();
    const again = openDb(file);
    expect(isKilled(again)).toBe(true);
    setKilled(again, false, new Date());
    expect(isKilled(again)).toBe(false);
  });

  test('a result from a cancelled drop is refused and writes nothing', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    engageKill(h.db, h.now());
    expect(await h.postResult(dropId, epoch, approved)).toBe(409);
    expect(h.forge.state.reviews).toHaveLength(0);
  });

  test('engaging refunds the charge of each cancelled drop', async () => {
    const h = await harness();
    await toPrOpen(h, 'sha1');
    await h.reconcile();
    expect(getAttempts(h.db, 1, 'review').count).toBe(1);
    engageKill(h.db, h.now());
    expect(getAttempts(h.db, 1, 'review').count).toBe(0);
  });

  test('after reset, an item with no branch restarts and one with a branch resumes', async () => {
    const h = await harness();
    await h.reconcile();
    await h.lease();
    engageKill(h.db, h.now());
    await h.reconcile();
    expect(getWorkItem(h.db, 1)?.state).toBe('in_flight');
    setKilled(h.db, false, h.now());
    await h.reconcile();
    expect(h.queuedRoles()).toEqual(['implement']);
    expect(activeDropFor(h.db, 1)?.headSha ?? null).toBeNull();

    engageKill(h.db, h.now());
    h.forge.state.branches.set('agent/issue-1', 'ck1');
    setKilled(h.db, false, h.now());
    await h.reconcile();
    expect(activeDropFor(h.db, 1)).toMatchObject({ role: 'implement', headSha: 'ck1' });
  });

  test('the heartbeat reply tells the stick to hard-kill while engaged', async () => {
    const h = await harness();
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    engageKill(h.db, h.now());
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/drops/${dropId}/heartbeat`,
      headers: h.stickHeaders(),
      payload: { epoch },
    });
    expect(res.json()).toEqual({ cancel: true, hard: true });
  });

  test('a cancel stays hard after a quick reset, so the trooper still gets no checkpoint', async () => {
    const h = await harness();
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    engageKill(h.db, h.now());
    setKilled(h.db, false, h.now());
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/drops/${dropId}/heartbeat`,
      headers: h.stickHeaders(),
      payload: { epoch },
    });
    expect(res.json()).toEqual({ cancel: true, hard: true });
  });

  test('the home page warns that tokens stay valid while engaged', async () => {
    const h = await harness();
    engageKill(h.db, h.now());
    const res = await h.view('/');
    expect(res.body).toMatch(/kill switch is engaged/i);
    expect(res.body).toMatch(/revoke/i);
  });
});

describe('kill switch and crew drops', () => {
  test('engaging the kill switch cancels a crew drop and refunds nothing for it', () => {
    const db = openDb(tmpDbFile());
    upsertDropZone(db, { id: 'main', repo: 'o/r', defaultBranch: 'main', configJson: '{}' });
    insertDrop(db, {
      id: 'c1',
      dropZoneId: 'main',
      workItemId: null,
      role: 'crew-lead',
      state: 'queued',
      chargedKey: 'review',
    });
    expect(engageKill(db, new Date())).toEqual({ cancelled: 1 });
    expect(db.prepare("SELECT state FROM drops WHERE id = 'c1'").get()).toEqual({
      state: 'cancelled',
    });
    expect(db.prepare('SELECT COUNT(*) AS c FROM attempts').get()).toEqual({ c: 0 });
  });
});

describe('kill switch and pending pushes', () => {
  const SHA = 'a'.repeat(40);
  const OPERATOR = { authorization: `Bearer ${'o'.repeat(32)}` };
  const stickPost = (h: Harness, url: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url, headers: h.stickHeaders(), payload });
  const control = (h: Harness, url: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: 'POST', url, headers: OPERATOR, payload });

  /** Leases the implement drop and moves it to running with one heartbeat. */
  async function running(h: Harness): Promise<{ dropId: string; epoch: number }> {
    await h.reconcile();
    const { dropId, epoch } = await h.lease();
    await stickPost(h, `/api/drops/${dropId}/heartbeat`, { epoch });
    return { dropId, epoch };
  }

  test('kill, salvage, release: the pending push gets a grant after release', async () => {
    const h = await harness();
    const { dropId, epoch } = await running(h);
    expect((await control(h, '/api/control/kill', { engaged: true })).json()).toMatchObject({
      engaged: true,
      cancelled: 1,
    });
    // The stick hard-kills the agent container, then salvages its work, switch still on.
    const salvaged = await stickPost(h, '/api/sticks/salvage', { dropId, epoch });
    expect(salvaged.json()).toEqual({ state: 'push_pending' });
    const deadline = getDrop(h.db, dropId)?.pushDeadline;
    let res = await stickPost(h, '/api/sticks/push-token', { dropId, epoch });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ refused: 'killed', retryable: true });
    // Engaged for an hour: retention never runs out meanwhile, and the release credits the hour.
    h.at(60);
    await control(h, '/api/control/kill', { engaged: false });
    expect(getDrop(h.db, dropId)?.pushDeadline).toBe(
      new Date(Date.parse(deadline ?? '') + 60 * 60_000).toISOString(),
    );
    // The reset reconcile starts nothing on the item: its pending push holds it.
    await h.reconcile();
    expect(h.queuedRoles()).toEqual([]);
    res = await stickPost(h, '/api/sticks/push-plan', { dropId, epoch });
    expect(res.json()).toMatchObject({ branch: 'agent/issue-1', salvage: true });
    res = await stickPost(h, '/api/sticks/push-token', { dropId, epoch });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant).toMatchObject({ branch: 'agent/issue-1' });
  });

  test("a paused zone's pending push still gets its grant: pause lets running work finish", async () => {
    const h = await harness();
    const { dropId, epoch } = await running(h);
    const status = await h.postResult(dropId, epoch, {
      status: 'completed',
      role: 'implement',
      headSha: SHA,
      gates: [gateOk],
      push: { kind: 'final', expectSha: SHA },
    } as DropResult);
    expect(status).toBe(200);
    expect(getDrop(h.db, dropId)?.state).toBe('push_pending');
    expect((await control(h, '/api/control/zones/main', { mode: 'paused' })).statusCode).toBe(200);
    h.at(10);
    await h.reconcile();
    expect(getDrop(h.db, dropId)?.state).toBe('push_pending');
    let res = await stickPost(h, '/api/sticks/push-plan', { dropId, epoch });
    expect(res.json()).toMatchObject({ branch: 'agent/issue-1', salvage: false });
    res = await stickPost(h, '/api/sticks/push-token', { dropId, epoch });
    expect(res.statusCode).toBe(200);
    expect(res.json().grant).toMatchObject({ branch: 'agent/issue-1' });
  });
});
