import { expect, test } from 'vitest';
import { MAX_PENDING_PUSHES } from './push.js';
import { advertisedCapabilities, leaseTerms } from './state.js';
import { VOLUME_FREE_FLOOR_BYTES } from './volumes.js';

const healthy = { selfCheck: true, freeBytes: VOLUME_FREE_FLOOR_BYTES };

test('push-v1 is advertised only after a passing self-check above the floor', () => {
  const caps = (health: { selfCheck: boolean; freeBytes: number | null }) =>
    leaseTerms({ egress: false, policy: 'allowlist', health, pending: 0 })?.capabilities;
  expect(caps(healthy)).toEqual(['push-v1']);
  expect(caps({ selfCheck: false, freeBytes: 100 * 2 ** 30 })).toEqual([]);
  // Below the floor there is no lease at all, so nothing is advertised either.
  expect(caps({ selfCheck: true, freeBytes: VOLUME_FREE_FLOOR_BYTES - 1 })).toBeUndefined();
  expect(advertisedCapabilities({ egress: true, policy: 'signed', push: true })).toEqual([
    'egress-v1',
    'image-verify-v1',
    'push-v1',
  ]);
  expect(advertisedCapabilities({ egress: false, policy: 'allowlist' })).toEqual([]);
});

test('below the floor the stick does not lease', () => {
  const terms = (freeBytes: number | null) =>
    leaseTerms({
      egress: true,
      policy: 'signed',
      health: { selfCheck: true, freeBytes },
      pending: 0,
    });
  expect(terms(VOLUME_FREE_FLOOR_BYTES - 1)).toBeNull();
  // A measurement that failed counts as below the floor.
  expect(terms(null)).toBeNull();
  expect(terms(VOLUME_FREE_FLOOR_BYTES)).toEqual({
    capabilities: ['egress-v1', 'image-verify-v1', 'push-v1'],
  });
});

test('at the cap the lease says noPush', () => {
  const terms = (pending: number) =>
    leaseTerms({ egress: false, policy: 'allowlist', health: healthy, pending });
  expect(MAX_PENDING_PUSHES).toBe(8);
  expect(terms(MAX_PENDING_PUSHES - 1)).toEqual({ capabilities: ['push-v1'] });
  expect(terms(MAX_PENDING_PUSHES)).toEqual({ capabilities: ['push-v1'], noPush: true });
  expect(terms(MAX_PENDING_PUSHES + 1)?.noPush).toBe(true);
});
