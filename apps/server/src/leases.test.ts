import { beforeEach, describe, expect, test } from 'vitest';
import type { Db } from './db/open.js';
import {
  activeDropFor,
  getDrop,
  getUsageState,
  insertDrop,
  insertStick,
  listEvents,
  reclaimableDropFor,
  removeStick,
  reserveGrant,
  setKilled,
  setUsageState,
  setWorkItemState,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
} from './db/repo.js';
import {
  doctorMayLease,
  engageKill,
  expireLeases,
  heartbeat,
  leaseExpirer,
  leaseNextDrop,
  missingFor,
  releaseKill,
  zoneRequirements,
} from './leases.js';
import { makeZone } from './test/fixtures.js';
import { plus, seedQueuedDrop, t0, workItem } from './test/helpers.js';
import { setUsageOverride } from './usage.js';

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

describe('leaseNextDrop and a per-model hold (#747)', () => {
  const queue = (id: string, role: string, at: number) => {
    const crew = ['crew-lead', 'refute', 'diagnose', 'triage', 'arbitrate', 'audit', 'doctor'];
    const wi = crew.includes(role)
      ? { id: null }
      : (db
          .prepare(
            `INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at, updated_at)
         VALUES ('main', ?, 't', 'b', 'a', 'x', 'x') RETURNING id`,
          )
          .get(100 + at) as { id: number });
    insertDrop(db, {
      id,
      dropZoneId: 'main',
      workItemId: wi.id,
      role,
      state: 'queued',
      createdAt: plus(t0, at).toISOString(),
    });
  };
  const holdA = (d: { id: string }) => d.id === 'A';
  beforeEach(() => {
    db.prepare("UPDATE drops SET state = 'succeeded' WHERE id = 'd1'").run();
  });

  test('a held implement drop is skipped for the next, and stays queued, untouched', () => {
    queue('A', 'implement', 1000);
    queue('B', 'implement', 2000);
    const before = getDrop(db, 'A');
    expect(leaseNextDrop(db, 's1', t0, 'open', [], [], holdA)?.dropId).toBe('B');
    expect(getDrop(db, 'A')).toEqual(before);
    expect(getDrop(db, 'A')?.state).toBe('queued');
    expect(leaseNextDrop(db, 's1', t0, 'open', [], [], holdA)).toBeNull();
  });

  test('the predicate is shown the drop it judges', () => {
    queue('A', 'implement', 1000);
    const seen: unknown[] = [];
    leaseNextDrop(db, 's1', t0, 'open', [], [], (d) => {
      seen.push(d);
      return true;
    });
    expect(seen).toEqual([{ id: 'A', role: 'implement', dropZoneId: 'main', inputJson: null }]);
  });

  test.each(['review', 'heal', 'resolve', 'doctor'])(
    'a %s drop it would hold still leases',
    (role) => {
      queue('A', role, 1000);
      expect(leaseNextDrop(db, 's1', t0, 'open', [], [], () => true)?.dropId).toBe('A');
    },
  );

  test('under override a held drop takes no start, and the next eligible drop is leased', () => {
    setUsageOverride(db, { starts: 3, hours: 3, by: 'token' }, t0);
    queue('A', 'implement', 1000);
    queue('B', 'implement', 2000);
    expect(leaseNextDrop(db, 's1', t0, 'override', [], [], holdA)?.dropId).toBe('B');
    expect(getUsageState(db).overrideStartsLeft).toBe(2);
    expect(getDrop(db, 'A')?.state).toBe('queued');
    expect(leaseNextDrop(db, 's1', t0, 'override', [], [], holdA)).toBeNull();
    expect(getUsageState(db).overrideStartsLeft).toBe(2);
  });

  test('with no predicate nothing is held', () => {
    queue('A', 'implement', 1000);
    expect(leaseNextDrop(db, 's1', t0, 'open')?.dropId).toBe('A');
  });
});

describe('leaseNextDrop and a removed stick (issue #255)', () => {
  test('a removed stick is leased nothing, even called directly; a live one is', () => {
    removeStick(db, 's1', t0);
    expect(leaseNextDrop(db, 's1', t0, 'open')).toBeNull();
    expect(getDrop(db, 'd1')).toMatchObject({ state: 'queued', stickId: null });
    insertStick(db, { id: 's2', name: 'stick-2', tokenHash: 'h2', slots: 1 });
    expect(leaseNextDrop(db, 's2', t0, 'open')).toEqual({ dropId: 'd1', epoch: 1 });
  });

  test('a lease and a removal in either order: never leased to a removed stick with a live lease', () => {
    // Lease first, then removal: the lease is ended at once, and the next expireLeases takes it
    // down the lost-stick path.
    leaseNextDrop(db, 's1', t0, 'open');
    removeStick(db, 's1', t0);
    const leased = getDrop(db, 'd1')!;
    expect(leased.state).toBe('leased');
    expect(new Date(leased.leaseExpiresAt!).getTime()).toBeLessThan(t0.getTime());
    expect(expireLeases(db, t0)).toBe(1);
    expect(getDrop(db, 'd1')?.state).toBe('lost');

    // Removal first, then lease: the drop stays queued.
    const other = seedQueuedDrop();
    removeStick(other, 's1', t0);
    expect(leaseNextDrop(other, 's1', t0, 'open')).toBeNull();
    expect(getDrop(other, 'd1')?.state).toBe('queued');
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

  test('the lease expirer reads the current usage settings on each run', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    const reads: number[] = [];
    let current = { throttleUtilization: 0.9, probeJitterSeconds: [30, 90] as [number, number] };
    const expire = leaseExpirer(db, () => {
      reads.push(current.throttleUtilization);
      return current;
    });
    expire(plus(t0, 10_000));
    current = { ...current, throttleUtilization: 0.5 };
    expire(plus(t0, 20_000));
    expire(plus(t0, 30_000));
    // Read once per run, after the startup run, and the second run already saw the new value.
    expect(reads).toEqual([0.5, 0.5]);
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
    // An operator-requested readiness check (one Claude call plus the zone's gates): the throttle holds new
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

  test('doctorMayLease: open, finishing_only and override only', () => {
    const gates = [
      'open',
      'finishing_only',
      'override',
      'closed',
      'stopped',
      'probe',
      'credits_resume',
    ] as const;
    expect(gates.filter(doctorMayLease)).toEqual(['open', 'finishing_only', 'override']);
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

  describe('the egress ceiling (#780)', () => {
    const zone = (mode: 'off' | 'monitor' | 'enforce', allow: string[] = []) =>
      makeZone({ egress: { mode, allow } });
    const stick = (egressCeiling: string[] | null | undefined) => ({
      capabilities: ['egress-v1'],
      imagePolicy: 'allowlist' as const,
      ...(egressCeiling === undefined ? {} : { egressCeiling }),
    });
    const ceiling = ['api.anthropic.com', 'github.com', 'registry.npmjs.org'];

    test('zoneRequirements carries what egressFor gives the zone\'s drops', () => {
      expect(zoneRequirements(zone('off'), {}).egress).toBeUndefined();
      expect(zoneRequirements(zone('enforce', ['Registry.npmjs.org']), {}).egress).toEqual({
        mode: 'enforce',
        allow: ['api.anthropic.com', 'github.com', 'registry.npmjs.org'],
      });
      // The preset's hosts are in it too.
      expect(
        zoneRequirements(makeZone({ preset: 'go', egress: { mode: 'enforce' } }), {}).egress
          ?.allow,
      ).toContain('proxy.golang.org');
    });

    test('a stick with no ceiling (null or none sent) is judged as before', () => {
      const need = zoneRequirements(zone('monitor', ['anything.example.com']), {});
      expect(missingFor(stick(null), need)).toEqual([]);
      expect(missingFor(stick(undefined), need)).toEqual([]);
    });

    test('hosts outside the ceiling are named; a covered zone is runnable', () => {
      expect(missingFor(stick(ceiling), zoneRequirements(zone('enforce'), {}))).toEqual([]);
      expect(
        missingFor(
          stick(ceiling),
          zoneRequirements(zone('enforce', ['registry.npmjs.org', 'gitlab.example.com']), {}),
        ),
      ).toEqual(['egress-ceiling:gitlab.example.com']);
    });

    test('monitor, or off, with a ceiling: egress-ceiling:mode', () => {
      expect(missingFor(stick(ceiling), zoneRequirements(zone('monitor'), {}))).toEqual([
        'egress-ceiling:mode',
      ]);
      expect(missingFor(stick(ceiling), zoneRequirements(zone('off'), {}))).toEqual([
        'egress-ceiling:mode',
      ]);
    });

    test('at most 3 hosts, each cut to 100 characters, then +N', () => {
      const long = `${'a'.repeat(120)}.example.com`;
      const need = zoneRequirements(
        zone('enforce', ['a.example.com', long, 'c.example.com', 'd.example.com', 'e.example.com']),
        {},
      );
      expect(missingFor(stick(ceiling), need)).toEqual([
        `egress-ceiling:a.example.com+${'a'.repeat(100)}+c.example.com+2`,
      ]);
    });

    test('invalid ceiling entries (a bare *, an IP) cover nothing', () => {
      const need = zoneRequirements(zone('enforce', ['gitlab.example.com']), {});
      expect(missingFor(stick(['*', '203.0.113.7', '*.*']), need)).toEqual([
        'egress-ceiling:api.anthropic.com+github.com+gitlab.example.com',
      ]);
      // An empty ceiling (what an unparseable stored one reads as) covers nothing either.
      expect(missingFor(stick([]), need)).toEqual([
        'egress-ceiling:api.anthropic.com+github.com+gitlab.example.com',
      ]);
    });
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

describe('pending pushes', () => {
  const SHA = 'a'.repeat(40);
  const HOUR = 3_600_000;

  /** d1 as the result route leaves it: push_pending on s1 at epoch 1, deadline `deadlineMs` after t0. */
  function pendingPush(o: { role?: string; headSha?: string | null; deadlineMs?: number } = {}) {
    updateDrop(db, 'd1', {
      role: o.role ?? 'implement',
      state: 'push_pending',
      stickId: 's1',
      epoch: 1,
      headSha: o.headSha ?? null,
      pushKind: 'final',
      pushExpectSha: SHA,
      pushDeadline: plus(t0, o.deadlineMs ?? 24 * HOUR).toISOString(),
      resultJson: JSON.stringify({ status: 'completed', headSha: SHA, gates: [] }),
      runningAt: t0.toISOString(),
      finishedAt: t0.toISOString(),
      usageApplied: 1,
    });
  }
  const liveGrants = (): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE revoked_at IS NULL').get() as {
        n: number;
      }
    ).n;
  const drops = () =>
    db
      .prepare('SELECT id, state, head_sha AS headSha FROM drops ORDER BY created_at, rowid')
      .all() as { id: string; state: string; headSha: string | null }[];

  test('engageKill leaves pending pushes in place', () => {
    pendingPush();
    expect(engageKill(db, t0)).toEqual({ cancelled: 0 });
    expect(getDrop(db, 'd1')).toMatchObject({ state: 'push_pending', pushKind: 'final' });
  });

  test('retention never expires while killed, and release credits the pause', () => {
    pendingPush({ deadlineMs: HOUR });
    engageKill(db, plus(t0, 30 * 60_000));
    // Long past the deadline, but the switch is on.
    expireLeases(db, plus(t0, 5 * HOUR));
    expect(getDrop(db, 'd1')?.state).toBe('push_pending');
    // Released after 4 h 30 min engaged: the deadline moves out by exactly that.
    expect(releaseKill(db, plus(t0, 5 * HOUR))).toBe(4.5 * HOUR);
    expect(getDrop(db, 'd1')?.pushDeadline).toBe(plus(t0, 5.5 * HOUR).toISOString());
    expireLeases(db, plus(t0, 5.5 * HOUR - 1));
    expect(getDrop(db, 'd1')?.state).toBe('push_pending');
    expireLeases(db, plus(t0, 5.5 * HOUR + 1));
    expect(getDrop(db, 'd1')?.state).toBe('lost');
    // A release with the switch already off credits nothing.
    pendingPush({ deadlineMs: 6 * HOUR });
    expect(releaseKill(db, plus(t0, 6 * HOUR))).toBe(0);
    expect(getDrop(db, 'd1')?.pushDeadline).toBe(plus(t0, 6 * HOUR).toISOString());
  });

  test('retention expiry requeues the item for a charged resume', () => {
    pendingPush({ headSha: 'prior1', deadlineMs: HOUR });
    reserveGrant(db, 'd1', 1, t0);
    expect(expireLeases(db, plus(t0, HOUR + 1))).toBe(1);
    const d = getDrop(db, 'd1');
    expect(d).toMatchObject({ state: 'lost', runningAt: null });
    expect(d?.finishedAt).toBe(plus(t0, HOUR + 1).toISOString());
    expect(liveGrants()).toBe(0);
    expect(listEvents(db, 'd1').map((e) => e.data)).toContainEqual({
      message: 'push retention expired',
    });
    // Back to ready: the reconciler's charged resume picks the pushed commit up from the branch.
    expect(activeDropFor(db, 1)).toBeUndefined();
    expect(workItem(db, 1).state).toBe('ready');
    // Given up on: never reclaimable, so a salvage can't bring it back.
    expect(reclaimableDropFor(db, 1, plus(t0, HOUR + 2))).toBeUndefined();
  });

  test('retention expiry with nothing pushed yet sends the item back to ready', () => {
    pendingPush({ deadlineMs: HOUR });
    expireLeases(db, plus(t0, HOUR + 1));
    expect(getDrop(db, 'd1')?.state).toBe('lost');
    expect(activeDropFor(db, 1)).toBeUndefined();
    expect(workItem(db, 1).state).toBe('ready');
  });

  test('retention expiry leaves heal and resolve items pr_open', () => {
    for (const role of ['heal', 'resolve']) {
      db = seedQueuedDrop();
      setWorkItemState(db, 1, 'pr_open');
      pendingPush({ role, headSha: 'prhead', deadlineMs: HOUR });
      expireLeases(db, plus(t0, HOUR + 1));
      expect(getDrop(db, 'd1')?.state, role).toBe('lost');
      expect(activeDropFor(db, 1), role).toBeUndefined();
      expireLeases(db, plus(t0, 2 * HOUR));
      expect(workItem(db, 1).state, role).toBe('pr_open');
    }
  });

  test('a lost running drop holds its item for the reclaim window', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    heartbeat(db, 'd1', 's1', 1, plus(t0, 10_000));
    const lostAt = plus(t0, 71_000);
    expect(expireLeases(db, lostAt)).toBe(1);
    expect(reclaimableDropFor(db, 1, lostAt)?.id).toBe('d1');
    // Past the lost grace, still within the window: the item holds.
    expireLeases(db, plus(lostAt, 5 * 60_000));
    expect(workItem(db, 1).state).toBe('in_flight');
    expireLeases(db, plus(lostAt, 15 * 60_000));
    expect(workItem(db, 1).state).toBe('in_flight');
    // The window has passed: it requeues as today.
    expect(reclaimableDropFor(db, 1, plus(lostAt, 15 * 60_000 + 1))).toBeUndefined();
    expireLeases(db, plus(lostAt, 15 * 60_000 + 1));
    expect(workItem(db, 1).state).toBe('ready');
  });

  test('a drop lost before it ever ran requeues after the lost grace, as today', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    expireLeases(db, plus(t0, 61_000));
    expect(reclaimableDropFor(db, 1, plus(t0, 61_000))).toBeUndefined();
    expireLeases(db, plus(t0, 181_000));
    expect(workItem(db, 1).state).toBe('ready');
  });

  test('server restart: pending pushes survive and running drops get a lease period', () => {
    leaseNextDrop(db, 's1', t0, 'open');
    heartbeat(db, 'd1', 's1', 1, plus(t0, 10_000));
    db.prepare(
      `INSERT INTO work_items (drop_zone_id, issue_number, title, body, author, issue_created_at, updated_at, state)
       VALUES ('main', 2, 't', 'b', 'a', 'x', 'x', 'in_flight')`,
    ).run();
    insertDrop(db, {
      id: 'p1',
      dropZoneId: 'main',
      workItemId: 2,
      role: 'implement',
      state: 'queued',
      createdAt: t0.toISOString(),
    });
    const deadline = plus(t0, 24 * HOUR).toISOString();
    updateDrop(db, 'p1', {
      state: 'push_pending',
      stickId: 's1',
      epoch: 1,
      pushKind: 'final',
      pushDeadline: deadline,
      runningAt: t0.toISOString(),
      finishedAt: t0.toISOString(),
    });
    // The server was down for an hour: its first run after startup.
    const back = plus(t0, HOUR);
    const expire = leaseExpirer(db);
    expect(expire(back)).toBe(0);
    expect(getDrop(db, 'd1')).toMatchObject({
      state: 'running',
      leaseExpiresAt: plus(back, 60_000).toISOString(),
    });
    expect(getDrop(db, 'p1')).toMatchObject({
      state: 'push_pending',
      pushDeadline: deadline,
      leaseExpiresAt: null,
    });
    // Regular ticks: the pending push stays; the running drop is lost only if it stays silent.
    expect(expire(plus(back, 10_000))).toBe(0);
    expect(expire(plus(back, 61_000))).toBe(1);
    expect(drops()).toEqual([
      { id: 'd1', state: 'lost', headSha: null },
      { id: 'p1', state: 'push_pending', headSha: null },
    ]);
  });
});
