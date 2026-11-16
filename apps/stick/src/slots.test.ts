import { describe, expect, test } from 'vitest';
import { enrolledSlots, maxSlotsFor, SlotTarget } from './slots.js';
import { subnetBlocks } from './subnets.js';

describe('the stick ceiling', () => {
  test('JM_MAX_SLOTS when set; otherwise max(4, JM_SLOTS)', () => {
    expect(maxSlotsFor({}, 1)).toBe(4);
    expect(maxSlotsFor({}, 6)).toBe(6);
    expect(maxSlotsFor({ JM_MAX_SLOTS: '2' }, 1)).toBe(2);
    expect(maxSlotsFor({ JM_MAX_SLOTS: '10' }, 1)).toBe(10);
  });

  test('JM_MAX_SLOTS=abc, 0 or 1.5 fails with a clear message', () => {
    for (const bad of ['abc', '0', '1.5', '-2'])
      expect(() => maxSlotsFor({ JM_MAX_SLOTS: bad }, 1)).toThrow(
        `JM_MAX_SLOTS must be an integer of 1 or more, not ${bad}`,
      );
  });

  test('maxSlots is capped by the number of /28 blocks in the drop subnet pool', () => {
    expect(subnetBlocks('172.30.0.0/27')).toBe(2);
    expect(subnetBlocks('172.30.0.0/28')).toBe(1);
    expect(subnetBlocks('172.30.0.0/16')).toBe(4096);
    expect(maxSlotsFor({ JM_DROP_SUBNET_POOL: '172.30.0.0/27' }, 1)).toBe(2);
    expect(maxSlotsFor({ JM_DROP_SUBNET_POOL: '172.30.0.0/27', JM_MAX_SLOTS: '8' }, 1)).toBe(2);
  });

  test('JM_SLOTS is the count requested at enrollment, an integer of 1 or more', () => {
    expect(enrolledSlots({})).toBe(1);
    expect(enrolledSlots({ JM_SLOTS: '3' })).toBe(3);
    expect(() => enrolledSlots({ JM_SLOTS: '0' })).toThrow('JM_SLOTS must be an integer >= 1');
  });
});

describe('the running target', () => {
  test('follows a header of 3 when maxSlots is 4', () => {
    const t = new SlotTarget(1, 4);
    t.follow(3);
    expect(t.target).toBe(3);
    expect(t.free(0)).toBe(3);
  });

  test('a header of 6 is capped at 4', () => {
    const t = new SlotTarget(1, 4);
    t.follow(6);
    expect(t.target).toBe(4);
  });

  test('with no header the stick uses JM_SLOTS', () => {
    const t = new SlotTarget(2, 4);
    expect(t.target).toBe(2);
    t.follow(null);
    expect(t.target).toBe(2);
    // A header seen once, then gone (a downgraded server): back to JM_SLOTS.
    t.follow(3);
    t.follow(null);
    expect(t.target).toBe(2);
  });

  test('lowering from 3 to 1 with 3 running leases nothing until running drops below 1', () => {
    const t = new SlotTarget(1, 4);
    t.follow(3);
    expect(t.free(2)).toBe(1);
    t.follow(1);
    // Nothing is stopped: the stick just asks for no drop.
    expect(t.free(3)).toBe(0);
    expect(t.free(2)).toBe(0);
    expect(t.free(1)).toBe(0);
    expect(t.free(0)).toBe(1);
  });
});
