import type { DropResult } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import {
  activeDropFor,
  getAttempts,
  getWorkItem,
  insertDrop,
  isKilled,
  setKilled,
  upsertDropZone,
} from '../db/repo.js';
import { engageKill } from '../leases.js';
import { runOp } from '../outbox.js';
import { harness, toPrOpen } from '../test/flowHarness.js';
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
    const res = await h.app.inject({ method: 'GET', url: '/' });
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
