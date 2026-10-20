import { beforeEach, describe, expect, test } from 'vitest';
import type { Db } from './db/open.js';
import { getDrop, insertDrop, updateDrop } from './db/repo.js';
import { expireLeases, heartbeat, leaseNextDrop } from './leases.js';
import { plus, seedQueuedDrop, t0, workItem } from './test/helpers.js';

let db: Db;
beforeEach(() => {
  db = seedQueuedDrop();
});

describe('leaseNextDrop', () => {
  test('leases oldest queued drop and bumps epoch', () => {
    expect(leaseNextDrop(db, 's1', t0)).toEqual({ dropId: 'd1', epoch: 1 });
    expect(leaseNextDrop(db, 's1', t0)).toBeNull();
    const d = getDrop(db, 'd1')!;
    expect(d.state).toBe('leased');
    expect(d.stickId).toBe('s1');
    expect(d.leaseExpiresAt).toBe(plus(t0, 60_000).toISOString());
  });

  test('picks the oldest of several queued drops', () => {
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
    db.prepare(
      `INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at, updated_at)
       VALUES ('main', 2, 't', 'b', 'a', 'x', 'x'), ('main', 3, 't', 'b', 'a', 'x', 'x')`,
    ).run();
    insertDrop(db, {
      id: 'late',
      dropZoneId: 'main',
      workItemId: 2,
      role: 'r',
      state: 'queued',
      createdAt: plus(t0, 2000).toISOString(),
    });
    insertDrop(db, {
      id: 'early',
      dropZoneId: 'main',
      workItemId: 3,
      role: 'r',
      state: 'queued',
      createdAt: plus(t0, 1000).toISOString(),
    });
    expect(leaseNextDrop(db, 's1', t0)?.dropId).toBe('early');
  });
});

describe('heartbeat', () => {
  test('stale epoch is rejected', () => {
    leaseNextDrop(db, 's1', t0);
    expect(heartbeat(db, 'd1', 's1', 0, t0)).toBe('stale');
  });

  test('stale on stick mismatch', () => {
    leaseNextDrop(db, 's1', t0);
    expect(heartbeat(db, 'd1', 'other', 1, t0)).toBe('stale');
  });

  test('ok extends lease and moves leased to running; startedAt stays the lease time', () => {
    leaseNextDrop(db, 's1', t0);
    expect(heartbeat(db, 'd1', 's1', 1, plus(t0, 10_000))).toBe('ok');
    let d = getDrop(db, 'd1')!;
    expect(d.state).toBe('running');
    expect(d.startedAt).toBe(t0.toISOString());
    expect(d.leaseExpiresAt).toBe(plus(t0, 70_000).toISOString());
    expect(heartbeat(db, 'd1', 's1', 1, plus(t0, 20_000))).toBe('ok');
    d = getDrop(db, 'd1')!;
    expect(d.startedAt).toBe(t0.toISOString());
    expect(d.leaseExpiresAt).toBe(plus(t0, 80_000).toISOString());
  });

  test('cancel when the drop is cancelled', () => {
    leaseNextDrop(db, 's1', t0);
    updateDrop(db, 'd1', { state: 'cancelled' });
    expect(heartbeat(db, 'd1', 's1', 1, t0)).toBe('cancel');
  });

  test('unknown drop is stale', () => {
    expect(heartbeat(db, 'nope', 's1', 1, t0)).toBe('stale');
  });

  test('a heartbeat after expiry is stale', () => {
    leaseNextDrop(db, 's1', t0);
    expireLeases(db, plus(t0, 61_000));
    expect(heartbeat(db, 'd1', 's1', 1, plus(t0, 62_000))).toBe('stale');
  });
});

describe('expireLeases', () => {
  test('expires leases with grace', () => {
    leaseNextDrop(db, 's1', t0);
    expect(expireLeases(db, plus(t0, 61_000))).toBe(1);
    const d = getDrop(db, 'd1')!;
    expect(d.state).toBe('lost');
    expect(d.finishedAt).toBe(plus(t0, 61_000).toISOString());
    expect(workItem(db, 1).state).toBe('in_flight');
    expireLeases(db, plus(t0, 61_000 + 119_000));
    expect(workItem(db, 1).state).toBe('in_flight');
    expireLeases(db, plus(t0, 61_000 + 120_000));
    expect(workItem(db, 1).state).toBe('ready');
  });

  test('does not expire a lease that is still live', () => {
    leaseNextDrop(db, 's1', t0);
    expect(expireLeases(db, plus(t0, 60_000))).toBe(0);
    expect(getDrop(db, 'd1')!.state).toBe('leased');
  });

  test('expires running drops too', () => {
    leaseNextDrop(db, 's1', t0);
    heartbeat(db, 'd1', 's1', 1, plus(t0, 10_000));
    expect(expireLeases(db, plus(t0, 69_000))).toBe(0);
    expect(expireLeases(db, plus(t0, 71_000))).toBe(1);
    expect(getDrop(db, 'd1')!.state).toBe('lost');
  });

  test('keeps the work item in_flight when another active drop exists', () => {
    leaseNextDrop(db, 's1', t0);
    expireLeases(db, plus(t0, 61_000));
    insertDrop(db, {
      id: 'd2',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'queued',
      createdAt: plus(t0, 62_000).toISOString(),
    });
    expireLeases(db, plus(t0, 200_000));
    expect(workItem(db, 1).state).toBe('in_flight');
  });

  test('does not touch a work item whose latest drop is not lost', () => {
    leaseNextDrop(db, 's1', t0);
    expireLeases(db, plus(t0, 61_000));
    insertDrop(db, {
      id: 'd2',
      dropZoneId: 'main',
      workItemId: 1,
      role: 'implement',
      state: 'succeeded',
      createdAt: plus(t0, 62_000).toISOString(),
    });
    expireLeases(db, plus(t0, 400_000));
    expect(workItem(db, 1).state).toBe('in_flight');
  });
});
