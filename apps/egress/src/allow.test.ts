import { describe, expect, test } from 'vitest';
import { hostAllowed, isPublicAddress, normalizeHost, validAllowEntry } from './allow.js';

describe('normalizeHost', () => {
  test('normalizeHost lowercases, strips one trailing dot and refuses IP literals and non-ASCII', () => {
    expect(normalizeHost('GitHub.COM')).toBe('github.com');
    expect(normalizeHost('github.com.')).toBe('github.com');
    expect(normalizeHost('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHost('a-b.example.com')).toBe('a-b.example.com');
    for (const bad of [
      'github.com..', // one trailing dot only
      '.github.com',
      '',
      '.',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      '[::1]',
      '[2001:db8::1]',
      '::ffff:127.0.0.1',
      // inet_aton forms getaddrinfo would accept as addresses: no real TLD starts with a digit
      '127.1',
      '2130706433',
      '0x7f000001',
      '0177.0.0.1',
      'bücher.example', // non-ASCII
      'Key.example', // the Kelvin sign lowercases to an ASCII k: refused before lowercasing
      'github.com\u0000.evil',
      'git hub.com',
      'github.com:443',
      'github.com/path',
      'user@github.com',
      'a_b.example.com',
      '-a.example.com',
      'a-.example.com',
      `${'a'.repeat(64)}.example.com`,
      `${'a.'.repeat(126)}com`, // 255 characters
    ])
      expect(normalizeHost(bad), JSON.stringify(bad)).toBeNull();
    expect(normalizeHost(`${'a'.repeat(63)}.example.com`)).not.toBeNull();
    expect(normalizeHost(`${'a.'.repeat(125)}com`)).toHaveLength(253);
  });
});

describe('hostAllowed', () => {
  test('*.example.com matches a.example.com but not example.com or badexample.com', () => {
    const list = ['*.example.com', 'github.com'];
    expect(hostAllowed('a.example.com', list)).toBe(true);
    expect(hostAllowed('b.a.example.com', list)).toBe(true);
    expect(hostAllowed('example.com', list)).toBe(false);
    expect(hostAllowed('badexample.com', list)).toBe(false);
    expect(hostAllowed('github.com', list)).toBe(true);
    expect(hostAllowed('api.github.com', list)).toBe(false);
    expect(hostAllowed('github.com.evil.test', list)).toBe(false);
    // Case and one trailing dot are normalised on both sides.
    expect(hostAllowed('GitHub.com.', ['GITHUB.COM.'])).toBe(true);
    // An invalid host never matches, even a list with a bare wildcard.
    expect(hostAllowed('127.0.0.1', ['*.0.0.1', '127.0.0.1'])).toBe(false);
    expect(hostAllowed('anything.test', ['*'])).toBe(false);
  });

  test('validAllowEntry takes a name or *. plus a name, nothing else', () => {
    for (const ok of ['github.com', '*.githubusercontent.com', 'Registry.NPMjs.org.'])
      expect(validAllowEntry(ok), ok).toBe(true);
    for (const bad of [
      '*',
      '*.',
      '*.*.example.com',
      'a.*.example.com',
      '*example.com',
      '1.2.3.4',
      '*.1.2.3.4',
      'github.com/path',
      'https://github.com',
      'github.com:443',
      '[::1]',
    ])
      expect(validAllowEntry(bad), bad).toBe(false);
  });
});

describe('isPublicAddress', () => {
  test('isPublicAddress refuses every listed range, including ::/96, 2002::/16, 2001::/32 and 100::/64', () => {
    const refused = [
      // IPv4
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      // IPv6
      '::',
      '::1',
      '::127.0.0.1', // ::/96, IPv4-compatible
      '::8.8.8.8', // refused whatever it embeds
      '100::1',
      '2001::1', // Teredo
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      '2001:10::1',
      '2001:20::1', // ORCHIDv2 (2001:20::/28)
      '2001:2f:ffff::1',
      '2001:db8::1',
      '2002:c000:0204::1', // 6to4
      '2002:0808:0808::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      '::ffff:169.254.169.254',
      '::ffff:7f00:1', // the same mapped address in hex
      '64:ff9b::127.0.0.1',
      '64:ff9b::a9fe:a9fe', // 169.254.169.254 through NAT64
      // Not public either: not IP addresses at all.
      'localhost',
      '',
      '1.2.3',
    ];
    for (const ip of refused) expect(isPublicAddress(ip), ip).toBe(false);
    const allowed = [
      '1.1.1.1',
      '8.8.8.8',
      '140.82.112.3',
      '100.63.255.255',
      '100.128.0.1',
      '172.15.255.255',
      '172.32.0.1',
      '192.0.1.1',
      '198.20.0.1',
      '2606:4700:4700::1111',
      '2001:4860:4860::8888',
      '2001:30::1', // just past 2001:20::/28
      '::ffff:8.8.8.8',
      '64:ff9b::808:808', // 8.8.8.8 through NAT64
    ];
    for (const ip of allowed) expect(isPublicAddress(ip), ip).toBe(true);
  });

  test('a name resolving to host.docker.internal-style private addresses is refused', () => {
    // Docker Desktop answers host.docker.internal with the VM's host address, a Linux engine with
    // the bridge gateway, and the metadata service sits at link-local: none is public.
    for (const ip of ['192.168.65.254', '192.168.65.2', '172.17.0.1', 'fdc4:f303:9324::254'])
      expect(isPublicAddress(ip), ip).toBe(false);
  });
});
