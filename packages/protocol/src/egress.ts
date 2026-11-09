// Egress host and address rules, shared by the proxy (which enforces them), the server (which
// validates a zone's allow list) and the stick. Node's standard library only, and no import of
// the rest of the protocol package: the egress image ships this module without zod.
import { BlockList, isIP } from 'node:net';

/** The proxy's fixed name on a drop network, and its port. The trooper derives its proxy from these. */
export const EGRESS_PROXY_ALIAS = 'jm-egress';
export const EGRESS_PROXY_PORT = 3128;
export const EGRESS_PROXY_URL = `http://${EGRESS_PROXY_ALIAS}:${EGRESS_PROXY_PORT}`;

/** One JSON line per tunnel (or refusal) on the proxy's stdout. */
export type EgressLogLine = {
  at: string;
  host: string;
  port: number;
  decision: 'allow' | 'deny';
  /** Why a request was denied, or `unlisted` for a host monitor mode let through. */
  reason?: string;
  bytesUp?: number;
  bytesDown?: number;
  ms?: number;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host name in canonical form (lowercase, one trailing dot stripped), or null when it is not a
 * plain DNS name: IP literals of any form, non-ASCII, labels outside `[a-z0-9-]`, a label over 63
 * characters or a name over 253. The last label must start with a letter, so the numeric forms
 * `getaddrinfo` reads as addresses (`127.1`, `2130706433`, `0x7f000001`) are refused too.
 */
export function normalizeHost(h: string): string | null {
  if (typeof h !== 'string' || h.length === 0 || h.length > 254) return null;
  if (!/^[\x21-\x7e]+$/.test(h)) return null;
  let s = h.toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.length === 0 || s.length > 253 || isIP(s) !== 0) return null;
  const labels = s.split('.');
  if (!labels.every((l) => LABEL.test(l))) return null;
  if (!/^[a-z]/.test(labels.at(-1) as string)) return null;
  return s;
}

/** An allow-list entry: a host name, or `*.` plus a host name (subdomains only, never the apex). */
export function validAllowEntry(entry: string): boolean {
  if (typeof entry !== 'string') return false;
  const name = entry.startsWith('*.') ? entry.slice(2) : entry;
  return normalizeHost(name) !== null;
}

/** Whether `host` (normalised here) is on the list. Invalid hosts and entries never match. */
export function hostAllowed(host: string, list: string[]): boolean {
  const h = normalizeHost(host);
  if (h === null) return false;
  for (const entry of list) {
    if (entry.startsWith('*.')) {
      const suffix = normalizeHost(entry.slice(2));
      if (suffix !== null && h.endsWith(`.${suffix}`)) return true;
    } else if (normalizeHost(entry) === h) return true;
  }
  return false;
}

const V4_REFUSED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  // 6to4 relay anycast (deprecated): not in the plan's list, refused anyway.
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const V6_REFUSED: [string, number][] = [
  // ::/96 covers ::, ::1 and every IPv4-compatible address.
  ['::', 96],
  ['100::', 64],
  ['2001::', 32],
  // Benchmarking: not in the plan's list, refused anyway.
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  // IPv4-translated (RFC 2765) and local-use NAT64 (RFC 8215): not in the plan's list, refused.
  ['::ffff:0:0:0', 96],
  ['64:ff9b:1::', 48],
  ['fc00::', 7],
  // Deprecated site-local: not in the plan's list, refused anyway.
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
];

const v4Refused = new BlockList();
for (const [net, prefix] of V4_REFUSED) v4Refused.addSubnet(net, prefix, 'ipv4');
const v6Refused = new BlockList();
for (const [net, prefix] of V6_REFUSED) v6Refused.addSubnet(net, prefix, 'ipv6');

/** The 16 bytes of an IPv6 address (which `isIP` has accepted). */
function v6Bytes(ip: string): number[] {
  let text = ip;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail.push(...(dotted[1] as string).split('.').map(Number));
    text = `${text.slice(0, dotted.index)}0:0`;
  }
  const [head = '', rest] = text.split('::');
  const words = (s: string) => (s === '' ? [] : s.split(':').map((w) => Number.parseInt(w, 16)));
  const hi = words(head);
  const lo = rest === undefined ? [] : words(rest);
  const all = [...hi, ...new Array(8 - hi.length - lo.length).fill(0), ...lo];
  const bytes = all.flatMap((w) => [w >> 8, w & 0xff]);
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True when the first `bits` bits of `bytes` equal those of `prefix`. */
function startsWith(bytes: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const b = 7 - (i % 8);
    if ((((bytes[i >> 3] as number) >> b) & 1) !== ((((prefix[i >> 3] ?? 0) as number) >> b) & 1))
      return false;
  }
  return true;
}

const MAPPED = v6Bytes('::ffff:0:0');
const NAT64 = v6Bytes('64:ff9b::');

/**
 * Whether the proxy may connect to `ip`. False for anything that isn't an IP address, every
 * private, reserved, documentation, multicast and transition range above, and for IPv4-mapped
 * (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses whose embedded IPv4 address isn't public.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !v4Refused.check(ip, 'ipv4');
  if (family !== 6) return false;
  const bytes = v6Bytes(ip);
  for (const prefix of [MAPPED, NAT64]) {
    if (startsWith(bytes, prefix, 96)) return isPublicAddress(bytes.slice(12).join('.'));
  }
  // Checked as bytes rebuilt into canonical text, so every spelling of an address is judged alike.
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2)
    words.push((((bytes[i] as number) << 8) | (bytes[i + 1] as number)).toString(16));
  return !v6Refused.check(words.join(':'), 'ipv6');
}
