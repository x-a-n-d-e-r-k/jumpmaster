// Issue #427: the server offers each capable stick behind its release an upgrade on the lease
// answer, through the real enroll and lease routes and the real database.
import { UPGRADE_HEADER, UpgradeOfferSchema } from '@jumpmaster/protocol';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, test } from 'vitest';
import {
  getStick,
  getStickUpgrade,
  removeStick,
  requestStickUpgrade,
  type Stick,
  stickUpgradeStatus,
  UPGRADE_TIMEOUT_REASON,
  type UpgradeTarget,
} from '../db/repo.js';
import {
  fakeMirror,
  type Harness,
  harness,
  MIRROR_REGISTRY,
  STICK_DIGEST,
} from '../test/flowHarness.js';

const IMAGE = `${MIRROR_REGISTRY}/jumpmaster-stick@${STICK_DIGEST}`;
const TARGET: UpgradeTarget = { version: '0.6.0', image: IMAGE };
/** An eligible stick on 0.5.1. */
const A = { capabilities: ['push-v1', 'upgrade-v1'], imagePolicy: 'signed', version: '0.5.1' };

type Opts = Parameters<typeof harness>[0];
/** Server 0.6.0 with the stick image mirrored, unless `o` says otherwise. */
const world = (o: Opts = {}): Promise<Harness> =>
  harness({ version: '0.6.0', images: fakeMirror(), ...o });

const offerOf = (res: LightMyRequestResponse) => {
  const raw = res.headers[UPGRADE_HEADER];
  return raw === undefined ? undefined : UpgradeOfferSchema.parse(JSON.parse(String(raw)));
};
const rows = (h: Harness): number =>
  (h.db.prepare('SELECT COUNT(*) AS n FROM stick_upgrades').get() as { n: number }).n;
const row = (h: Harness, id = h.stickId) => getStickUpgrade(h.db, id);
const stick = (h: Harness, id = h.stickId): Stick => getStick(h.db, id) as Stick;
/** Reconciles until a drop is queued. */
async function queueDrop(h: Harness): Promise<void> {
  for (let i = 0; i < 5 && h.queuedRoles().length === 0; i++) await h.reconcile();
  expect(h.queuedRoles().length).toBeGreaterThan(0);
}
const dropOf = (res: LightMyRequestResponse) => res.json() as { dropId: string; epoch: number };

describe('the offer', () => {
  test('an eligible stick on 0.5.1 under a 0.6.0 server: 204, the header naming the lock digest, no drop', async () => {
    const h = await world();
    await queueDrop(h);
    const res = await h.leaseRaw(A);
    expect(res.statusCode).toBe(204);
    expect(offerOf(res)).toEqual({ version: '0.6.0', image: IMAGE });
    expect(h.queuedRoles()).toHaveLength(1);
    expect(row(h)).toMatchObject({ targetVersion: '0.6.0', image: IMAGE, state: 'pending' });
    expect(row(h)?.requestedBy).toBe('auto');
    // Every answer while it is pending carries it, a full stick's too.
    const again = await h.leaseRaw({ ...A, freeSlots: 0 });
    expect(again.statusCode).toBe(204);
    expect(offerOf(again)?.version).toBe('0.6.0');
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({ status: 'upgrading' });
  });

  test('auto off and no request: the drop is leased, no header, no row', async () => {
    const h = await world({ sticks: { autoUpgrade: false } });
    await queueDrop(h);
    const res = await h.leaseRaw(A);
    expect(res.statusCode).toBe(200);
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(rows(h)).toBe(0);
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({ status: 'available' });
  });

  test('a request made during a long poll ends it with 204 and the header, and leases nothing', async () => {
    const h = await world({ sticks: { autoUpgrade: false }, leaseWaitMs: 5000, leasePollMs: 10 });
    const poll = h.leaseRaw(A);
    await new Promise((r) => setTimeout(r, 50));
    expect(rows(h)).toBe(0);
    requestStickUpgrade(h.db, h.stickId, TARGET, 'command', h.now());
    await queueDrop(h);
    const res = await poll;
    expect(res.statusCode).toBe(204);
    expect(offerOf(res)).toEqual({ version: '0.6.0', image: IMAGE });
    expect(h.queuedRoles()).toHaveLength(1);
  });

  test('a running drop is untouched: heartbeat and result answer as before; the next lease has the header and no drop', async () => {
    const h = await world({ sticks: { autoUpgrade: false } });
    await queueDrop(h);
    const leased = await h.leaseRaw(A);
    expect(leased.statusCode).toBe(200);
    const { dropId, epoch } = dropOf(leased);
    requestStickUpgrade(h.db, h.stickId, TARGET, 'command', h.now());
    const beat = await h.app.inject({
      method: 'POST',
      url: `/api/drops/${dropId}/heartbeat`,
      headers: h.stickHeaders(),
      payload: { epoch },
    });
    expect(beat.statusCode).toBe(200);
    expect(beat.json()).toEqual({ cancel: false, hard: false });
    // Another drop waits; the stick has free slots, yet is leased none.
    h.db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES ('other', ?, NULL, 'doctor', 'queued', ?)`,
      )
      .run(h.zone.id, h.now().toISOString());
    const next = await h.leaseRaw({ ...A, freeSlots: 3 });
    expect(next.statusCode).toBe(204);
    expect(offerOf(next)?.version).toBe('0.6.0');
    expect(
      await h.postResult(dropId, epoch, {
        status: 'completed',
        headSha: 'a'.repeat(40),
        gates: [{ name: 'test', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' }],
      }),
    ).toBe(204);
  });
});

describe('eligibility and versions', () => {
  test('without upgrade-v1: no row, needs-reinstall; under the allowlist policy: no row', async () => {
    const h = await world();
    const res = await h.leaseRaw({ ...A, capabilities: ['push-v1'], version: '0.4.4' });
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(rows(h)).toBe(0);
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({ status: 'needs-reinstall' });
    await h.leaseRaw({ ...A, imagePolicy: 'allowlist' });
    expect(rows(h)).toBe(0);
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({ status: 'needs-reinstall' });
  });

  test('0.0.0-dev, dev and unknown are never behind; the same version or a newer one is up to date', async () => {
    const h = await world();
    for (const version of ['0.0.0-dev', 'dev', 'unknown', '0.6.0', '0.7.0']) {
      const res = await h.leaseRaw({ ...A, version });
      expect(res.headers[UPGRADE_HEADER], version).toBeUndefined();
      expect(stickUpgradeStatus(h.db, stick(h), TARGET), version).toEqual({ status: 'up-to-date' });
    }
    expect(rows(h)).toBe(0);
  });

  test('0.9.0 is behind 0.10.0', async () => {
    const h = await world({ version: '0.10.0' });
    const res = await h.leaseRaw({ ...A, version: '0.9.0' });
    expect(offerOf(res)?.version).toBe('0.10.0');
  });

  test('no target, no offer and no row: a dev server, no stick image, an incomplete mirror, a throwing read', async () => {
    const cases: [string, Opts][] = [
      ['a dev server', { version: 'dev' }],
      ['no mirror', { images: undefined }],
      ['a lock without a stick image', { images: fakeMirror({ stick: false }) }],
      ['an incomplete mirror', { images: fakeMirror({ complete: false }) }],
      ['a throwing status', { images: fakeMirror({ throws: 'status' }) }],
      ['a throwing lookup', { images: fakeMirror({ throws: 'lookup' }) }],
    ];
    for (const [what, o] of cases) {
      const h = await world(o);
      await queueDrop(h);
      const res = await h.leaseRaw(A);
      expect(res.statusCode, what).toBe(200);
      expect(res.headers[UPGRADE_HEADER], what).toBeUndefined();
      expect(rows(h), what).toBe(0);
      expect(stickUpgradeStatus(h.db, stick(h), null)).toEqual({ status: 'none' });
    }
  });

  test('a pending row is not offered once the mirror loses the image: drops are leased again', async () => {
    const images = fakeMirror();
    const h = await world({ images });
    await h.leaseRaw(A);
    expect(row(h)?.state).toBe('pending');
    images.complete = false;
    await queueDrop(h);
    const res = await h.leaseRaw(A);
    expect(res.statusCode).toBe(200);
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
  });
});

describe('settling', () => {
  test('the advertised target version settles ok and drops resume', async () => {
    const h = await world();
    await h.leaseRaw(A);
    await queueDrop(h);
    const res = await h.leaseRaw({ ...A, version: '0.6.0' });
    expect(res.statusCode).toBe(200);
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(row(h)?.state).toBe('ok');
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({ status: 'up-to-date' });
  });

  test('a claimed ok on the old version settles nothing', async () => {
    const h = await world();
    await h.leaseRaw(A);
    const res = await h.leaseRaw({ ...A, upgrade: { version: '0.6.0', result: 'ok' } });
    expect(offerOf(res)?.version).toBe('0.6.0');
    expect(row(h)?.state).toBe('pending');
  });

  test('refused settles with its reason; that answer has no header, the drop is leased, and auto never asks again', async () => {
    const h = await world();
    await h.leaseRaw(A);
    await queueDrop(h);
    const report = { version: '0.6.0', result: 'refused', reason: 'signature check failed' };
    const res = await h.leaseRaw({ ...A, upgrade: report });
    expect(res.statusCode).toBe(200);
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(row(h)).toMatchObject({ state: 'refused', reason: 'signature check failed' });
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({
      status: 'refused',
      reason: 'signature check failed',
    });
    const later = await h.leaseRaw(A);
    expect(later.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(row(h)?.state).toBe('refused');
  });

  test('failed settles with its reason; a later lease on the target settles ok from failed', async () => {
    const h = await world();
    await h.leaseRaw(A);
    await h.leaseRaw({ ...A, upgrade: { version: '0.6.0', result: 'failed', reason: 'no start' } });
    expect(row(h)).toMatchObject({ state: 'failed', reason: 'no start' });
    expect(stickUpgradeStatus(h.db, stick(h), TARGET)).toEqual({
      status: 'failed',
      reason: 'no start',
    });
    await h.leaseRaw(A);
    expect(row(h)?.state).toBe('failed');
    await h.leaseRaw({ ...A, version: '0.6.0' });
    expect(row(h)).toMatchObject({ state: 'ok' });
  });

  test('a report for another version is ignored', async () => {
    const h = await world();
    await h.leaseRaw(A);
    await h.leaseRaw({ ...A, upgrade: { version: '0.7.0', result: 'refused', reason: 'x' } });
    expect(row(h)?.state).toBe('pending');
  });

  test('a malformed upgrade field (a 2,000-character reason) is ignored, never a 400', async () => {
    const h = await world();
    await h.leaseRaw(A);
    for (const upgrade of [
      { version: '0.6.0', result: 'refused', reason: 'x'.repeat(2000) },
      { version: '0.6.0', result: 'exploded' },
      'refused',
      null,
    ]) {
      const res = await h.leaseRaw({ ...A, upgrade });
      expect(res.statusCode, JSON.stringify(upgrade)).toBe(204);
      expect(offerOf(res)?.version).toBe('0.6.0');
      expect(row(h)?.state).toBe('pending');
    }
  });

  test("stick B's report for 0.6.0 leaves stick A's row pending (D1)", async () => {
    const h = await world();
    await h.leaseRaw(A);
    const b = await h.enrollStick('b');
    await h.leaseRaw(
      { ...A, version: '0.6.0', upgrade: { version: '0.6.0', result: 'refused', reason: 'x' } },
      b.headers,
    );
    await h.leaseRaw(
      { ...A, upgrade: { version: '0.6.0', result: 'failed', reason: 'x' } },
      b.headers,
    );
    expect(row(h)?.state).toBe('pending');
    // B (back on 0.5.1, eligible) got its own row in that lease, after its report was settled.
    expect(row(h, b.stickId)?.state).toBe('pending');
  });
});

describe('the drain timeout', () => {
  test('it counts only while the stick has no live drop; then 30 minutes fail it and drops are leased again', async () => {
    const h = await world({ sticks: { autoUpgrade: false } });
    await queueDrop(h);
    const leased = await h.leaseRaw(A);
    expect(leased.statusCode).toBe(200);
    const { dropId, epoch } = dropOf(leased);
    requestStickUpgrade(h.db, h.stickId, TARGET, 'command', h.now());
    for (let m = 0; m < 4; m++) {
      h.at(10);
      const beat = await h.app.inject({
        method: 'POST',
        url: `/api/drops/${dropId}/heartbeat`,
        headers: h.stickHeaders(),
        payload: { epoch },
      });
      expect(beat.statusCode).toBe(200);
      const res = await h.leaseRaw(A);
      expect(res.statusCode).toBe(204);
      expect(offerOf(res)?.version).toBe('0.6.0');
      expect(row(h)?.drainedSince).toBeNull();
    }
    expect(row(h)?.state).toBe('pending');
    expect(
      await h.postResult(dropId, epoch, {
        status: 'completed',
        headSha: 'a'.repeat(40),
        gates: [{ name: 'test', exitCode: 0, durationMs: 1, timedOut: false, outputTail: '' }],
      }),
    ).toBe(204);
    h.db
      .prepare(
        `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, created_at)
         VALUES ('next', ?, NULL, 'doctor', 'queued', ?)`,
      )
      .run(h.zone.id, h.now().toISOString());
    const drained = await h.leaseRaw(A);
    expect(drained.statusCode).toBe(204);
    expect(row(h)?.drainedSince).toBe(h.now().toISOString());
    h.at(29);
    expect((await h.leaseRaw(A)).statusCode).toBe(204);
    h.at(1);
    const res = await h.leaseRaw(A);
    expect(res.statusCode).toBe(200);
    expect(res.headers[UPGRADE_HEADER]).toBeUndefined();
    expect(dropOf(res).dropId).toBe('next');
    expect(row(h)).toMatchObject({ state: 'failed', reason: UPGRADE_TIMEOUT_REASON });
    // A timed-out row settles ok once the stick arrives on the target.
    await h.leaseRaw({ ...A, version: '0.6.0' });
    expect(row(h)?.state).toBe('ok');
  });
});

describe('concurrency and removal', () => {
  test('two concurrent requests leave one row (D3)', async () => {
    const h = await world({ sticks: { autoUpgrade: false } });
    await Promise.all([
      Promise.resolve().then(() => requestStickUpgrade(h.db, h.stickId, TARGET, 'command')),
      Promise.resolve().then(() => requestStickUpgrade(h.db, h.stickId, TARGET, 'auto')),
    ]);
    expect(rows(h)).toBe(1);
    expect(row(h)?.state).toBe('pending');
  });

  test('two concurrent leases from a behind stick with auto on leave one row (D3)', async () => {
    const h = await world();
    const [a, b] = await Promise.all([h.leaseRaw(A), h.leaseRaw(A)]);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    expect(rows(h)).toBe(1);
  });

  test('a new request replaces the row', async () => {
    const h = await world();
    await h.leaseRaw(A);
    await h.leaseRaw({ ...A, upgrade: { version: '0.6.0', result: 'refused', reason: 'no' } });
    requestStickUpgrade(h.db, h.stickId, TARGET, 'command', h.now());
    expect(row(h)).toMatchObject({ state: 'pending', reason: null, requestedBy: 'command' });
    expect(rows(h)).toBe(1);
  });

  test('removing a stick deletes its row', async () => {
    const h = await world();
    await h.leaseRaw(A);
    expect(rows(h)).toBe(1);
    removeStick(h.db, h.stickId, h.now());
    expect(rows(h)).toBe(0);
  });
});
