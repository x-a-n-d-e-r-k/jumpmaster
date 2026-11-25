import { describe, expect, test } from 'vitest';
import {
  BASE_EGRESS,
  ceilingRefusal,
  egressCeiling,
  entryCovered,
  isPrivateNetworkAddress,
} from './egress.js';

describe('egressCeiling', () => {
  test('unset, empty and blank mean no ceiling', () => {
    expect(egressCeiling(undefined)).toBeNull();
    expect(egressCeiling('')).toBeNull();
    expect(egressCeiling('   ')).toBeNull();
  });

  test('a valid list is canonical, deduplicated, sorted and includes the base', () => {
    expect(egressCeiling(' registry.npmjs.org , GitLab.Example.com.,*.Example.COM')).toEqual(
      [...BASE_EGRESS, '*.example.com', 'gitlab.example.com', 'registry.npmjs.org'].sort(),
    );
    expect(egressCeiling('GitLab.Example.com.')).toEqual(
      [...BASE_EGRESS, 'gitlab.example.com'].sort(),
    );
    expect(egressCeiling('github.com,github.com')).toEqual([...BASE_EGRESS].sort());
  });

  test.each([
    'a.example.com,,b.example.com',
    ',',
    'a.example.com,',
    '10.0.0.1',
    '::1',
    'gitlab.example.com:443',
    'https://gitlab.example.com',
    '*',
    '*.',
    'gitlab .example.com',
  ])('%j throws, naming the setting', (raw) => {
    expect(() => egressCeiling(raw)).toThrow(/^JM_EGRESS_CEILING/);
  });

  test('200 entries pass and 201 throw', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`).join(',');
    expect(egressCeiling(list(200))).toHaveLength(200 + BASE_EGRESS.length);
    expect(() => egressCeiling(list(201))).toThrow(/^JM_EGRESS_CEILING/);
  });
});

describe('entryCovered', () => {
  test.each([
    ['*.git.example.com', ['*.example.com'], true],
    ['*.example.com', ['*.example.com'], true],
    ['*.com', ['*.example.com'], false],
    ['example.com', ['*.example.com'], false],
    ['*.git.example.com', ['git.example.com'], false],
    ['gitlab.example.com', ['gitlab.example.com'], true],
    ['A.Example.COM.', ['*.example.com'], true],
    ['*.Git.Example.COM.', ['*.example.com'], true],
  ])('%s against %j → %s', (entry, ceiling, want) => {
    expect(entryCovered(entry, ceiling)).toBe(want);
  });

  test.each([
    ['*.evil.net,a.example.com', ['*.example.com']],
    ['a.example.com,evil.net', ['*.example.com']],
    ['example.com.evil.net', ['example.com']],
    ['notexample.com', ['*.example.com']],
    ['*.notexample.com', ['*.example.com']],
    ['exаmple.com', ['example.com']], // Cyrillic а
    ['a.exаmple.com', ['*.example.com']],
    [' evil.net', ['*.example.com']],
    [' a.example.com', ['*.example.com']],
    ['', ['*.example.com']],
    ['10.0.0.1', ['*.example.com']],
    ['*', ['*.example.com']],
    ['a.example.com', ['*.']],
    ['*.a.example.com', ['*.']],
  ])('evasion: %j against %j is not covered', (entry, ceiling) => {
    expect(entryCovered(entry, ceiling)).toBe(false);
  });
});

describe('ceilingRefusal', () => {
  const ceiling = egressCeiling('gitlab.example.com,registry.npmjs.org') as string[];
  const allow = [...BASE_EGRESS, 'registry.npmjs.org', 'gitlab.example.com'];

  test('no ceiling refuses nothing', () => {
    expect(ceilingRefusal(undefined, null)).toBeNull();
    expect(ceilingRefusal({ mode: 'monitor', allow: ['evil.net'] }, null)).toBeNull();
  });

  test('a covered drop in enforce runs', () => {
    expect(ceilingRefusal({ mode: 'enforce', allow }, ceiling)).toBeNull();
  });

  test('an empty allow list in enforce runs', () => {
    expect(ceilingRefusal({ mode: 'enforce', allow: [] }, ceiling)).toBeNull();
  });

  test('absent egress, monitor and an unknown mode are refused, naming the mode', () => {
    expect(ceilingRefusal(undefined, ceiling)).toMatch(/JM_EGRESS_CEILING.*enforce.*"off"/);
    expect(ceilingRefusal({ mode: 'monitor', allow }, ceiling)).toMatch(
      /JM_EGRESS_CEILING.*enforce.*"monitor"/,
    );
    expect(ceilingRefusal({ mode: 'Enforce', allow }, ceiling)).toMatch(/"Enforce"/);
  });

  test('an uncovered entry is refused, naming it', () => {
    const r = ceilingRefusal({ mode: 'enforce', allow: [...allow, 'evil.example.net'] }, ceiling);
    expect(r).toMatch(/JM_EGRESS_CEILING/);
    expect(r).toContain('evil.example.net');
    expect(r).not.toContain('gitlab.example.com');
  });

  test('a refusal names at most 10 entries, printable and cut to 100, then the count', () => {
    const bad = Array.from({ length: 12 }, (_, i) => `evil${i}.net`);
    const r = ceilingRefusal({ mode: 'enforce', allow: bad }, ceiling) as string;
    for (let i = 0; i < 10; i++) expect(r).toContain(`evil${i}.net`);
    expect(r).not.toContain('evil10.net');
    expect(r).toContain('and 2 more');
    const odd = ceilingRefusal(
      { mode: 'enforce', allow: [`x\u0000\n${'a'.repeat(200)}`] },
      ceiling,
    ) as string;
    expect(odd).not.toMatch(/[^\x20-\x7e]/);
    expect(odd).not.toContain('a'.repeat(100));
  });
});

describe('isPrivateNetworkAddress', () => {
  test.each([
    '10.0.0.0',
    '10.1.2.3',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.255',
    '100.64.0.1',
    '100.127.255.254',
    'fc00::1',
    'fd12:3456:789a::1',
    '::ffff:10.1.2.3',
    '::ffff:a01:203',
    '0:0:0:0:0:ffff:172.16.0.1',
    '::FFFF:192.168.1.1',
    '::ffff:100.64.0.1',
  ])('%s is a private-network address', (ip) => {
    expect(isPrivateNetworkAddress(ip)).toBe(true);
  });

  test.each([
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    '::ffff:169.254.169.254',
    'fe80::1',
    '0.0.0.0',
    '::',
    '224.0.0.1',
    'ff02::1',
    '255.255.255.255',
    '192.0.2.1',
    '2001:db8::1',
    '198.18.0.1',
    '2002:a01:203::1',
    'fec0::1',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '172.32.0.1',
    '100.128.0.1',
    '64:ff9b::a01:203',
    '64:ff9b::10.1.2.3',
    '::ffff:0:10.1.2.3',
    '::10.1.2.3',
    'gitlab.internal',
    '',
    '10.1.2.3/8',
  ])('%s is not a private-network address', (ip) => {
    expect(isPrivateNetworkAddress(ip)).toBe(false);
  });
});
