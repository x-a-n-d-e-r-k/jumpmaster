// How many troopers this stick runs at once: its ceiling, fixed at start, and the target the
// server sets on every lease answer (`x-jumpmaster-slots`), applied live.
import { dropSubnetPool, subnetBlocks } from './subnets.js';

/** `JM_SLOTS`: the count the stick asks for at enrollment, and runs at until the server says. */
export function enrolledSlots(env: NodeJS.ProcessEnv): number {
  const slots = Number(env.JM_SLOTS ?? '1');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('JM_SLOTS must be an integer >= 1');
  return slots;
}

/**
 * The most troopers this machine will ever run: `JM_MAX_SLOTS` when set, otherwise
 * `max(4, JM_SLOTS)` (so no stick configured for more today loses capacity), capped in either
 * case at the number of /28 blocks in its drop subnet pool (one per drop under egress).
 */
export function maxSlotsFor(env: NodeJS.ProcessEnv, slots: number): number {
  const raw = (env.JM_MAX_SLOTS ?? '').trim();
  let max = Math.max(4, slots);
  if (raw !== '') {
    if (!/^[0-9]+$/.test(raw) || Number(raw) < 1)
      throw new Error(`JM_MAX_SLOTS must be an integer of 1 or more, not ${raw}`);
    max = Number(raw);
  }
  return Math.min(max, subnetBlocks(dropSubnetPool(env)));
}

/**
 * The running target: the server's count capped at the ceiling, or `JM_SLOTS` when the server
 * sends none (an older server). Lowering it stops nothing: the stick leases until it is reached.
 */
export class SlotTarget {
  target: number;

  constructor(
    private readonly initial: number,
    readonly max: number,
  ) {
    this.target = Math.min(initial, max);
  }

  /** Applies the count a lease answer carried (null: none). */
  follow(told: number | null): void {
    this.target = Math.min(told ?? this.initial, this.max);
  }

  /** How many more drops the stick may take with `running` troopers running. */
  free(running: number): number {
    return Math.max(0, this.target - running);
  }
}
