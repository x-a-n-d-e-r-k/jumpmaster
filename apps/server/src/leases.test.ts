import { beforeEach, describe, expect, test } from 'vitest';
import type { Db } from './db/open.js';
import {
  getDrop,
  getUsageState,
  insertDrop,
  setKilled,
  setUsageState,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import {
  expireLeases,
  heartbeat,
  leaseExpirer,
  leaseNextDrop,
  missingFor,
  zoneRequirements,
} from './leases.js';
import { makeZone } from './test/fixtures.js';
import { plus, seedQueuedDrop, t0, workItem } from './test/helpers.js';

let db: Db;
beforeEach(() => {
  db = seedQueuedDrop();
});

describe('leaseNextDrop', () => {
  test('leases oldest queued drop and bumps epoch', () => {
    expect(leaseNextDrop(db, 's1', t0, 'open')).toEqual({ dropId: 'd1', epoch: 1 });
    expect(leaseNextDrop(db, 's1', t0, 'open')).toBeNull();
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
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('early');
  });
});

describe('heartbeat', () => {
  test('stale epoch is rejected', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    expect(heartbeat(db, 'd1', 's1', 0, t0)).toBe('stale');
  });

  test('stale on stick mismatch', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    expect(heartbeat(db, 'd1', 'other', 1, t0)).toBe('stale');
  });

  test('ok extends lease and moves leased to running; startedAt stays the lease time', () => {
    leaseNextDrop(db, 's1', t0, 'open');
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
    leaseNextDrop(db, 's1', t0, 'open');
    updateDrop(db, 'd1', { state: 'cancelled' });
    expect(heartbeat(db, 'd1', 's1', 1, t0)).toBe('cancel');
  });

  test('unknown drop is stale', () => {
    expect(heartbeat(db, 'nope', 's1', 1, t0)).toBe('stale');
  });

  test('a heartbeat after expiry is stale', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    expireLeases(db, plus(t0, 61_000));
    expect(heartbeat(db, 'd1', 's1', 1, plus(t0, 62_000))).toBe('stale');
  });
});

describe('expireLeases', () => {
  test('expires leases with grace', () => {
    leaseNextDrop(db, 's1', t0, 'open');
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
    leaseNextDrop(db, 's1', t0, 'open');
    expect(expireLeases(db, plus(t0, 60_000))).toBe(0);
    expect(getDrop(db, 'd1')!.state).toBe('leased');
  });

  test('expires running drops too', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    heartbeat(db, 'd1', 's1', 1, plus(t0, 10_000));
    expect(expireLeases(db, plus(t0, 69_000))).toBe(0);
    expect(expireLeases(db, plus(t0, 71_000))).toBe(1);
    expect(getDrop(db, 'd1')!.state).toBe('lost');
  });

  test('keeps the work item in_flight when another active drop exists', () => {
    leaseNextDrop(db, 's1', t0, 'open');
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
    leaseNextDrop(db, 's1', t0, 'open');
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

describe('leaseExpirer', () => {
  test('the first run after startup extends live leases instead of losing them', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    const expire = leaseExpirer(db);
    expect(expire(plus(t0, 5 * 60_000))).toBe(0);
    expect(getDrop(db, 'd1')!.state).toBe('leased');
    expect(Date.parse(getDrop(db, 'd1')!.leaseExpiresAt!)).toBeGreaterThan(
      plus(t0, 5 * 60_000).getTime(),
    );
  });

  test('a gap longer than the lease TTL (the server slept) extends rather than expires', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    const expire = leaseExpirer(db);
    expire(plus(t0, 10_000));
    expect(expire(plus(t0, 10_000 + 30 * 60_000))).toBe(0);
    expect(getDrop(db, 'd1')!.state).toBe('leased');
  });

  test('regular ticks still expire a silent stick', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    const expire = leaseExpirer(db);
    let lost = 0;
    for (let ms = 10_000; ms <= 200_000; ms += 10_000) lost += expire(plus(t0, ms));
    expect(lost).toBe(1);
    expect(getDrop(db, 'd1')!.state).toBe('lost');
  });
});

describe('crew drops', () => {
  const crew = (id: string, role: string, at: number) =>
    insertDrop(db, {
      id,
      dropZoneId: 'main',
      workItemId: null,
      role,
      state: 'queued',
      createdAt: plus(t0, at).toISOString(),
    });

  test('an older crew drop leases after a newer implement or review drop', () => {
    db.prepare("UPDATE drops SET created_at = ? WHERE id = 'd1'").run(plus(t0, 5000).toISOString());
    crew('c1', 'crew-lead', 0);
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('d1');
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('c1');
  });

  test('a finishing drop leases before an older implement drop', () => {
    db.prepare(
      `INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at, updated_at)
       VALUES ('main', 2, 't', 'b', 'a', 'x', 'x')`,
    ).run();
    insertDrop(db, {
      id: 'rev',
      dropZoneId: 'main',
      workItemId: 2,
      role: 'review',
      state: 'queued',
      createdAt: plus(t0, 9000).toISOString(),
    });
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('rev');
  });

  test('the probe also leases a crew drop last', () => {
    db.prepare("UPDATE drops SET created_at = ? WHERE id = 'd1'").run(plus(t0, 5000).toISOString());
    crew('c1', 'crew-lead', 0);
    expect(leaseNextDrop(db, 's1', t0, 'probe')?.dropId).toBe('d1');
  });

  test('expireLeases marks a lost crew drop and touches no work item', () => {
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
    crew('c1', 'crew-lead', 0);
    leaseNextDrop(db, 's1', t0, 'open');
    const before = workItem(db, 1);
    expect(expireLeases(db, plus(t0, 61_000))).toBe(1);
    expect(getDrop(db, 'c1')?.state).toBe('lost');
    expect(expireLeases(db, plus(t0, 400_000))).toBe(0);
    expect(workItem(db, 1)).toEqual(before);
  });
});

describe('doctor drops', () => {
  const queue = (id: string, role: string, at: number) =>
    insertDrop(db, {
      id,
      dropZoneId: 'main',
      workItemId: null,
      role,
      state: 'queued',
      createdAt: plus(t0, at).toISOString(),
    });

  test('a doctor drop leases after crew drops and never while paused, observe, killed or usage-paused', () => {
    // The oldest is the doctor drop; it still goes last.
    queue('doc', 'doctor', -9000);
    queue('c1', 'crew-lead', 5000);
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('d1');
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('c1');
    for (const gate of ['closed', 'stopped', 'probe', 'credits_resume'] as const)
      expect(leaseNextDrop(db, 's1', t0, gate)).toBeNull();
    for (const mode of ['paused', 'observe']) {
      db.prepare(
        "INSERT OR REPLACE INTO zone_controls (zone_id, mode, updated_at) VALUES ('main', ?, 'x')",
      ).run(mode);
      expect(leaseNextDrop(db, 's1', t0, 'open')).toBeNull();
    }
    db.prepare("UPDATE zone_controls SET mode = 'active' WHERE zone_id = 'main'").run();
    setKilled(db, true, t0);
    expect(leaseNextDrop(db, 's1', t0, 'open')).toBeNull();
    setKilled(db, false, t0);
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('doc');
  });

  test('under finishing_only a doctor drop leases after finishing work; implement and crew wait', () => {
    // An operator-requested readiness check with one small Claude call: the throttle holds new
    // work, not the check that tells the operator whether the zone can run it.
    queue('doc', 'doctor', -9000);
    queue('c1', 'crew-lead', -8000);
    const item = upsertWorkItem(db, {
      dropZoneId: 'main',
      issueNumber: 77,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    insertDrop(db, {
      id: 'r1',
      dropZoneId: 'main',
      workItemId: item.id,
      role: 'review',
      state: 'queued',
      createdAt: plus(t0, 5000).toISOString(),
    });
    expect(leaseNextDrop(db, 's1', t0, 'finishing_only')?.dropId).toBe('r1');
    expect(leaseNextDrop(db, 's1', t0, 'finishing_only')?.dropId).toBe('doc');
    expect(leaseNextDrop(db, 's1', t0, 'finishing_only')).toBeNull();
    expect(getDrop(db, 'd1')?.state).toBe('queued');
    expect(getDrop(db, 'c1')?.state).toBe('queued');
  });

  test('the usage probe never selects a doctor drop', () => {
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
    queue('doc', 'doctor', 0);
    expect(leaseNextDrop(db, 's1', t0, 'probe')).toBeNull();
    expect(getUsageState(db).probeDropId).toBeNull();
    expect(getDrop(db, 'doc')?.state).toBe('queued');
  });
});

describe('stick capabilities, per zone', () => {
  const m3 = { capabilities: [], imagePolicy: 'allowlist' as const };

  test('zoneRequirements: egress-v1 unless egress is off; image-verify-v1 and signed when required', () => {
    const req = (zone: Parameters<typeof zoneRequirements>[0], signed?: boolean) => {
      const r = zoneRequirements(zone, signed === undefined ? {} : { requireSignedImages: signed });
      return { caps: [...r.caps].sort(), signed: r.signed };
    };
    expect(req(makeZone())).toEqual({ caps: [], signed: false });
    expect(req(makeZone({ egress: { mode: 'off' } }))).toEqual({ caps: [], signed: false });
    expect(req(makeZone({ egress: { mode: 'monitor' } }))).toEqual({
      caps: ['egress-v1'],
      signed: false,
    });
    expect(req(makeZone({ egress: { mode: 'enforce' } }), true)).toEqual({
      caps: ['egress-v1', 'image-verify-v1'],
      signed: true,
    });
    expect(req(makeZone(), false)).toEqual({ caps: [], signed: false });
    // A zone can only strengthen the install-wide setting, never weaken it.
    expect(req(makeZone({ requireSignedImages: true }), false)).toEqual({
      caps: ['image-verify-v1'],
      signed: true,
    });
    expect(req(makeZone({ requireSignedImages: false }), true)).toEqual({
      caps: ['image-verify-v1'],
      signed: true,
    });
  });

  test('missingFor names each missing capability and a policy that is not signed', () => {
    const need = zoneRequirements(makeZone({ egress: { mode: 'enforce' } }), {
      requireSignedImages: true,
    });
    expect(missingFor(m3, need)).toEqual(['egress-v1', 'image-verify-v1', 'image-policy:signed']);
    expect(
      missingFor({ capabilities: ['image-verify-v1', 'egress-v1'], imagePolicy: 'signed' }, need),
    ).toEqual([]);
    expect(
      missingFor(
        { capabilities: ['egress-v1', 'image-verify-v1'], imagePolicy: 'allowlist' },
        need,
      ),
    ).toEqual(['image-policy:signed']);
    // An unknown capability string never satisfies a requirement it doesn't name.
    expect(
      missingFor(
        { capabilities: ['egress-v2'], imagePolicy: 'allowlist' },
        zoneRequirements(makeZone({ egress: { mode: 'monitor' } }), {}),
      ),
    ).toEqual(['egress-v1']);
    expect(missingFor(m3, zoneRequirements(makeZone(), {}))).toEqual([]);
  });

  function secondZone() {
    upsertDropZone(db, {
      id: 'locked',
      repo: 'octo/locked',
      defaultBranch: 'main',
      configJson: '{}',
    });
    const w = upsertWorkItem(db, {
      dropZoneId: 'locked',
      issueNumber: 9,
      title: 't',
      body: 'b',
      author: 'a',
      priority: 0,
      isFix: false,
      issueCreatedAt: t0.toISOString(),
    });
    // Older than d1, so it would lease first if it were not excluded.
    insertDrop(db, {
      id: 'x1',
      dropZoneId: 'locked',
      workItemId: w.id,
      role: 'implement',
      state: 'queued',
      createdAt: plus(t0, -60_000).toISOString(),
    });
  }

  test('an excluded zone is skipped and its drop stays queued, untouched', () => {
    secondZone();
    expect(leaseNextDrop(db, 's1', t0, 'open', ['locked'])).toEqual({ dropId: 'd1', epoch: 1 });
    expect(leaseNextDrop(db, 's1', t0, 'open', ['locked'])).toBeNull();
    expect(getDrop(db, 'x1')).toMatchObject({
      state: 'queued',
      stickId: null,
      epoch: 0,
      leaseExpiresAt: null,
      startedAt: null,
    });
    // Without the exclusion the older drop leases first.
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('x1');
  });

  test('a probe never picks a drop from an excluded zone', () => {
    secondZone();
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
    expect(leaseNextDrop(db, 's1', t0, 'probe', ['locked'])).toBeNull();
    expect(getUsageState(db).probeDropId).toBeNull();
    expect(getDrop(db, 'x1')?.state).toBe('queued');
    setUsageState(db, { probeDropId: null }, t0);
    expect(leaseNextDrop(db, 's1', t0, 'probe')?.dropId).toBe('x1');
  });

  test('a credits resume never picks a drop from an excluded zone', () => {
    secondZone();
    const bound = getDrop(db, 'x1')?.workItemId ?? null;
    setUsageState(db, { overageResumeWorkItemId: bound }, t0);
    expect(leaseNextDrop(db, 's1', t0, 'credits_resume', ['locked'])).toBeNull();
    expect(leaseNextDrop(db, 's1', t0, 'credits_resume')?.dropId).toBe('x1');
  });
});
