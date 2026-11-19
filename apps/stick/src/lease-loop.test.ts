// The stick's lease loop while its first health check pulls the trooper image (issue #157).
import type { DropPayload, StickStarting } from '@jumpmaster/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LeaseTerms } from './client.js';
import { runLeaseLoop, STARTING_REPORT_MS } from './lease-loop.js';
import { SlotTarget } from './slots.js';

const IMAGE = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
const DROP = { dropId: 'd1', epoch: 1 } as unknown as DropPayload;

type Lease = { free: number; terms: LeaseTerms; starting: StickStarting | null | undefined };

/**
 * A stick whose first health check (the base-image check that pulls the trooper) stays pending
 * until the test releases it, against a server that offers a drop on every lease, even one with no
 * free slot. `created` counts the trooper containers the stick starts.
 */
function harness(slots = 1) {
  let release!: () => void;
  let fail!: (e: Error) => void;
  const firstCheck = new Promise<void>((res, rej) => {
    release = res;
    fail = rej;
  });
  let starting: StickStarting | null | undefined;
  const leases: Lease[] = [];
  const client = {
    reportStarting: (s: StickStarting | null) => {
      starting = s;
    },
    lease: vi.fn(async (free: number, terms: LeaseTerms = {}) => {
      leases.push({ free, terms, starting });
      if (starting === null) starting = undefined;
      return { drop: DROP, skipped: [], slots: null };
    }),
  };
  const created: DropPayload[] = [];
  let stop = false;
  const done = runLeaseLoop({
    client,
    target: new SlotTarget(slots, 4),
    terms: () => ({ capabilities: ['egress-v1'] }),
    firstCheck,
    recheck: async () => {},
    start: (drop) => {
      created.push(drop);
      // A trooper that runs until the test ends.
      return new Promise<void>(() => {});
    },
    image: IMAGE,
    leaseLog: { skipped: () => {}, error: () => {} },
    log: () => {},
    stopped: () => stop,
  });
  return {
    leases,
    created,
    release,
    fail,
    done,
    stop: () => {
      stop = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the lease loop while the first health check is pending (issue #157)', () => {
  test('reports in at once with no free slot, leases no free slot until the check resolves, then leases normally', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    // Seen at once, while the check (and the trooper pull) is still running.
    expect(h.leases).toHaveLength(1);
    expect(h.leases[0]).toEqual({
      free: 0,
      terms: { capabilities: ['egress-v1'] },
      starting: { image: IMAGE },
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.leases.length).toBeGreaterThan(1);
    expect(h.leases.every((l) => l.free === 0 && l.starting?.image === IMAGE)).toBe(true);
    expect(h.created).toEqual([]);
    h.release();
    await vi.advanceTimersByTimeAsync(0);
    // The next lease asks for work, and clears the starting report.
    const after = h.leases.at(-1);
    expect(after).toMatchObject({ free: 1, starting: null });
    expect(h.created).toEqual([DROP]);
    h.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.done;
  });

  test('a server offering a drop while the check is pending: no container is created', async () => {
    const h = harness(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.leases.length).toBeGreaterThan(0);
    expect(h.created).toEqual([]);
    h.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.done;
    expect(h.created).toEqual([]);
  });

  test('a second no-free-slot report comes by 30 s while the check is still pending', async () => {
    expect(STARTING_REPORT_MS).toBeLessThanOrEqual(30_000);
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.leases).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.leases.length).toBeGreaterThanOrEqual(2);
    expect(h.leases[1]).toMatchObject({ free: 0, starting: { image: IMAGE } });
    h.stop();
    h.release();
    await vi.advanceTimersByTimeAsync(60_000);
    await h.done;
  });

  test('a first check that throws ends the loop with its error, as awaiting it did', async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.fail(new Error('engine gone'));
    await expect(h.done).rejects.toThrow('engine gone');
    expect(h.created).toEqual([]);
  });
});

describe('an upgrade offer holds the loop (issue #430)', () => {
  test('while held, leases ask for no slot, no drop starts, and the running count is passed on', async () => {
    const idle: number[] = [];
    let held = false;
    const leases: number[] = [];
    const created: DropPayload[] = [];
    let stop = false;
    const offer = {
      version: '0.6.0',
      image: `ghcr.io/o/jumpmaster-stick@sha256:${'e'.repeat(64)}`,
    };
    const client = {
      upgradeOffer: undefined as typeof offer | undefined,
      reportStarting() {},
      async lease(free: number) {
        leases.push(free);
        client.upgradeOffer = held ? offer : undefined;
        return { drop: free > 0 ? DROP : null, skipped: [], slots: null };
      },
    };
    const answered: (typeof offer | undefined)[] = [];
    const done = runLeaseLoop({
      client,
      target: new SlotTarget(2, 4),
      terms: () => ({ capabilities: [] }),
      firstCheck: Promise.resolve(),
      recheck: async () => {},
      start: (drop) => {
        created.push(drop);
        return new Promise<void>(() => {});
      },
      image: IMAGE,
      leaseLog: { skipped: () => {}, error: () => {} },
      log: () => {},
      stopped: () => stop,
      upgrade: {
        holding: () => held,
        answered: (o) => answered.push(o),
        idle: (running) => idle.push(running),
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(2);
    held = true;
    const at = leases.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(created).toHaveLength(2);
    expect(leases.length).toBeGreaterThan(at);
    expect(leases.slice(at).every((f) => f === 0)).toBe(true);
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((r) => r === 2)).toBe(true);
    expect(answered.at(-1)).toEqual(offer);
    stop = true;
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
  });
});
