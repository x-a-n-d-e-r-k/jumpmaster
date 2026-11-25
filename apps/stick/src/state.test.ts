import { describe, expect, test } from 'vitest';
import { MAX_PENDING_PUSHES } from './push.js';
import { advertisedCapabilities, canUpgrade, healthLine, leaseTerms, stickInfo } from './state.js';
import { VOLUME_FREE_FLOOR_BYTES } from './volumes.js';

const healthy = { selfCheck: true, freeBytes: VOLUME_FREE_FLOOR_BYTES, clone: false };

test('push-v1 is advertised only after a passing self-check above the floor', () => {
  const caps = (h: { selfCheck: boolean; freeBytes: number | null }) =>
    leaseTerms({ egress: false, policy: 'allowlist', health: { ...h, clone: false }, pending: 0 })
      ?.capabilities;
  expect(caps(healthy)).toEqual(['push-v1']);
  expect(caps({ selfCheck: false, freeBytes: 100 * 2 ** 30 })).toEqual([]);
  // Below the floor there is no lease at all, so nothing is advertised either.
  expect(caps({ selfCheck: true, freeBytes: VOLUME_FREE_FLOOR_BYTES - 1 })).toBeUndefined();
  // Unmeasured: a lease, but never push-v1, whatever the self-check said.
  expect(caps({ selfCheck: true, freeBytes: null })).toEqual([]);
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
      health: { selfCheck: true, freeBytes, clone: false },
      pending: 0,
    });
  expect(terms(VOLUME_FREE_FLOOR_BYTES - 1)).toBeNull();
  expect(terms(0)).toBeNull();
  // Unmeasured is not below the floor: the stick leases non-pushing roles, without push-v1.
  expect(terms(null)).toEqual({ capabilities: ['egress-v1', 'image-verify-v1'] });
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

test('the health line names the real cause', () => {
  const ok = { ok: true } as const;
  expect(
    healthLine({
      selfCheck: false,
      freeBytes: null,
      clone: false,
      base: { ok: false, reason: 'base image t:dev: image not verified: a tag reference' },
    }),
  ).toBe(
    'push-v1 withheld: base image t:dev: image not verified: a tag reference; non-pushing roles still lease',
  );
  expect(healthLine({ selfCheck: false, freeBytes: null, clone: false, base: ok })).toBe(
    'push-v1 withheld: free space could not be measured; non-pushing roles still lease',
  );
  expect(healthLine({ selfCheck: true, freeBytes: 5, clone: false, base: ok })).toBe(
    'free space 5 bytes is below the floor: not leasing',
  );
  expect(
    healthLine({ selfCheck: false, freeBytes: VOLUME_FREE_FLOOR_BYTES, clone: false, base: ok }),
  ).toBe('push-v1 withheld: the volume self-check failed');
  expect(
    healthLine({ selfCheck: true, freeBytes: VOLUME_FREE_FLOOR_BYTES, clone: false, base: ok }),
  ).toBe('volume self-check passed: push-v1 advertised');
});

describe('upgrade-v1 (issue #430)', () => {
  const ID = 'a'.repeat(64);
  const all: Parameters<typeof canUpgrade>[0] = {
    policy: 'signed',
    source: 'server',
    containerId: ID,
    version: '0.5.1',
  };
  const caps = (o: Partial<typeof all>) =>
    leaseTerms({
      egress: false,
      policy: o.policy ?? all.policy,
      health: healthy,
      pending: 0,
      upgrade: canUpgrade({ ...all, ...o }),
    })?.capabilities;

  test('advertised under the signed policy, server images, an own container and a release version', () => {
    expect(caps({})).toEqual(['image-verify-v1', 'push-v1', 'upgrade-v1']);
    expect(caps({ version: '0.6.0-rc.1' })).toContain('upgrade-v1');
  });

  test.each([
    ['the allowlist policy', { policy: 'allowlist' as const }],
    ['registry images', { source: 'registry' as const }],
    ['no own container id', { containerId: undefined }],
    ['a dev version', { version: '0.0.0-dev' }],
    ['an unknown version', { version: 'unknown' }],
  ])('not advertised with %s', (_, o) => {
    expect(caps(o)).not.toContain('upgrade-v1');
  });

  test('never advertised under allowlist, even when asked', () => {
    expect(advertisedCapabilities({ egress: false, policy: 'allowlist', upgrade: true })).toEqual(
      [],
    );
  });
});

describe('egressCeiling in the advert (#780)', () => {
  test('no JM_EGRESS_CEILING: null, so the server leases it as ever', () => {
    expect(stickInfo({}, '1').egressCeiling).toBeNull();
    expect(stickInfo({ JM_EGRESS_CEILING: '  ' }, '1').egressCeiling).toBeNull();
  });

  test('the parsed ceiling, base hosts included', () => {
    expect(stickInfo({ JM_EGRESS_CEILING: 'Registry.npmjs.org' }, '1').egressCeiling).toEqual([
      'api.anthropic.com',
      'github.com',
      'registry.npmjs.org',
    ]);
  });
});

describe('clone-v1 (issue #860)', () => {
  const ok = { ok: true } as const;
  const all = {
    selfCheck: true,
    freeBytes: VOLUME_FREE_FLOOR_BYTES,
    clone: true,
    base: ok as { ok: true } | { ok: false; reason: string },
  };
  const terms = (h: Partial<typeof all>, pending = 0) =>
    leaseTerms({ egress: true, policy: 'signed', health: { ...all, ...h }, pending });

  test('advertised when the base verdict is ok, the clone label is present and the self-check passed above the floor', () => {
    expect(terms({})).toEqual({
      capabilities: ['egress-v1', 'image-verify-v1', 'push-v1', 'clone-v1'],
    });
    expect(advertisedCapabilities({ egress: false, policy: 'allowlist', clone: true })).toEqual([
      'clone-v1',
    ]);
    expect(advertisedCapabilities({ egress: false, policy: 'allowlist', clone: false })).toEqual(
      [],
    );
  });

  test.each([
    ['a refused base image', { base: { ok: false as const, reason: 'refused' } }],
    ['no clone label', { clone: false }],
    ['a failed self-check', { selfCheck: false }],
    ['unmeasured free space', { freeBytes: null }],
  ])('withheld with %s', (_, h) => {
    expect(terms(h)?.capabilities).not.toContain('clone-v1');
  });

  test('withheld when the health carries no base verdict', () => {
    const { base: _b, ...noBase } = all;
    expect(
      leaseTerms({ egress: false, policy: 'allowlist', health: noBase, pending: 0 })?.capabilities,
    ).toEqual(['push-v1']);
  });

  test('below the floor there is no lease at all', () => {
    expect(terms({ freeBytes: VOLUME_FREE_FLOOR_BYTES - 1 })).toBeNull();
  });

  test('at the push cap clone-v1 still goes with noPush', () => {
    expect(terms({}, MAX_PENDING_PUSHES)).toEqual({
      capabilities: ['egress-v1', 'image-verify-v1', 'push-v1', 'clone-v1'],
      noPush: true,
    });
  });
});
