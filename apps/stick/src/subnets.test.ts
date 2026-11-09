import { describe, expect, test } from 'vitest';
import { allocateSubnet, DEFAULT_DROP_SUBNET_POOL, dropLayout, dropSubnetPool } from './subnets.js';

describe('allocateSubnet', () => {
  test('allocateSubnet skips subnets held by existing networks and retries on conflict', () => {
    const pool = '172.30.0.0/16';
    expect(allocateSubnet([], pool)).toBe('172.30.0.0/28');
    // Held exactly, overlapped by a wider network, or by a narrower one inside it.
    expect(allocateSubnet(['172.30.0.0/28'], pool)).toBe('172.30.0.16/28');
    expect(allocateSubnet(['172.30.0.0/27'], pool)).toBe('172.30.0.32/28');
    expect(allocateSubnet(['172.30.0.4/30', '172.30.0.16/28'], pool)).toBe('172.30.0.32/28');
    // A network covering the whole pool leaves nothing.
    expect(() => allocateSubnet(['172.16.0.0/12'], pool)).toThrow(/no free \/28/);
    // Other address families and unrelated subnets are ignored.
    expect(allocateSubnet(['fd00::/64', '10.0.0.0/8', 'garbage'], pool)).toBe('172.30.0.0/28');
    // A retry after a create conflict passes the refused subnet back in as held.
    const first = allocateSubnet([], pool);
    expect(allocateSubnet([first], pool)).not.toBe(first);
  });

  test('a small pool runs out after its last /28', () => {
    const pool = '10.9.0.0/27';
    const a = allocateSubnet([], pool);
    const b = allocateSubnet([a], pool);
    expect([a, b]).toEqual(['10.9.0.0/28', '10.9.0.16/28']);
    expect(() => allocateSubnet([a, b], pool)).toThrow(/no free \/28 in 10\.9\.0\.0\/27/);
  });

  test('the pool comes from JM_DROP_SUBNET_POOL, an IPv4 network of /28 or wider', () => {
    expect(DEFAULT_DROP_SUBNET_POOL).toBe('172.30.0.0/16');
    expect(dropSubnetPool({})).toBe('172.30.0.0/16');
    expect(dropSubnetPool({ JM_DROP_SUBNET_POOL: '10.200.0.0/20' })).toBe('10.200.0.0/20');
    for (const bad of ['10.200.0.1/20', '10.200.0.0/29', 'fd00::/48', '10.200.0.0', 'x'])
      expect(() => dropSubnetPool({ JM_DROP_SUBNET_POOL: bad }), bad).toThrow(
        /JM_DROP_SUBNET_POOL/,
      );
  });
});

describe('dropLayout', () => {
  test('.1 gateway, .2 proxy, .3 trooper, .4 dead DNS, services from .8/29', () => {
    expect(dropLayout('jm-drop-d1-3', '172.30.4.32/28')).toEqual({
      name: 'jm-drop-d1-3',
      subnet: '172.30.4.32/28',
      gateway: '172.30.4.33',
      proxy: '172.30.4.34',
      trooper: '172.30.4.35',
      dns: '172.30.4.36',
      ipRange: '172.30.4.40/29',
    });
  });
});
