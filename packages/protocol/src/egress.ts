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

/**
 * Hosts every drop under egress reaches: the Claude API and GitHub (clone and push). The monitor
 * rehearsal may extend this; the commit that does records the hosts it observed. Compiled into the
 * stick too, so a stick's egress ceiling always allows them.
 */
export const BASE_EGRESS = ['api.anthropic.com', 'github.com'];

/** Most entries `JM_EGRESS_CEILING` may list. */
export const MAX_CEILING_ENTRIES = 200;

/** A valid entry in canonical form: a name, or `*.` plus a name. */
function canonical(entry: string): string {
  return entry.startsWith('*.')
    ? `*.${normalizeHost(entry.slice(2)) as string}`
    : (normalizeHost(entry) as string);
}

/** Operator text shown in a message: printable ASCII only, cut short. */
const shown = (s: string, max = 100): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, max);

/**
 * A stick's egress ceiling (`JM_EGRESS_CEILING`): null when unset or blank (no ceiling), else its
 * entries, canonical, plus `BASE_EGRESS`, deduplicated and sorted. Throws, with a message that
 * starts with the setting's name, on anything else: an empty item, an entry that isn't a host name
 * or `*.` plus one (an IP, a port, a URL, a bare `*`), or more than 200 entries.
 */
export function egressCeiling(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const items = raw.split(',').map((s) => s.trim());
  if (items.length > MAX_CEILING_ENTRIES)
    throw new Error(
      `JM_EGRESS_CEILING lists ${items.length} entries; at most ${MAX_CEILING_ENTRIES} are allowed`,
    );
  for (const item of items) {
    if (item === '')
      throw new Error('JM_EGRESS_CEILING has an empty entry: separate host names with one comma');
    if (!validAllowEntry(item))
      throw new Error(
        `JM_EGRESS_CEILING entry "${shown(item)}" is not a host name or *. plus a host name (no IPs, ports or URLs)`,
      );
  }
  return [...new Set([...BASE_EGRESS, ...items].map(canonical))].sort();
}

/**
 * Whether the allow-list entry `entry` is within `ceiling`. An entry that isn't valid is never
 * covered (the list reaches the proxy joined with commas, so `*.evil.net,a.example.com` must not
 * pass as one wildcard). A host name is covered as the proxy would allow it; `*.x` only by a valid
 * `*.y` where x is y or a subdomain of it. An invalid ceiling entry covers nothing.
 */
export function entryCovered(entry: string, ceiling: string[]): boolean {
  if (!validAllowEntry(entry)) return false;
  if (!entry.startsWith('*.')) return hostAllowed(entry, ceiling);
  const x = normalizeHost(entry.slice(2)) as string;
  return ceiling.some((c) => {
    if (!c.startsWith('*.') || !validAllowEntry(c)) return false;
    const y = normalizeHost(c.slice(2)) as string;
    return x === y || x.endsWith(`.${y}`);
  });
}

/**
 * Why a stick with `ceiling` refuses a drop (or push) with `egress`, or null when it may run. No
 * ceiling refuses nothing. With one, only `enforce` runs (in `monitor` the proxy lets any public
 * host through, so it would be no ceiling), and only when every allow entry is covered.
 */
export function ceilingRefusal(
  egress: { mode: string; allow: string[] } | undefined,
  ceiling: string[] | null,
): string | null {
  if (ceiling === null) return null;
  const mode = egress?.mode ?? 'off';
  if (!egress || mode !== 'enforce')
    return `this stick's JM_EGRESS_CEILING runs only drops whose egress mode is "enforce"; this one's is "${shown(mode, 32)}"`;
  const outside = egress.allow.filter((e) => !entryCovered(e, ceiling));
  if (outside.length === 0) return null;
  const named = outside.slice(0, 10).map((e) => shown(e));
  const more = outside.length > 10 ? ` and ${outside.length - 10} more` : '';
  return `egress allows hosts outside this stick's JM_EGRESS_CEILING: ${named.join(', ')}${more}`;
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

const V4_PRIVATE: [string, number][] = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];
const v4Private = new BlockList();
for (const [net, prefix] of V4_PRIVATE) v4Private.addSubnet(net, prefix, 'ipv4');
const ULA = v6Bytes('fc00::');

/**
 * Whether `ip` is on a private network: 10/8, 172.16/12, 192.168/16, 100.64/10 (shared address
 * space), fc00::/7, and the IPv4-mapped (`::ffff:0:0/96`, any spelling) forms of the IPv4 ranges.
 * Nothing else: NAT64 forms, loopback, link-local, unspecified, multicast and every other refused
 * range are false, as is anything that isn't an IP address. A proxy opens only these ranges, and
 * only for the hosts `JM_EGRESS_PRIVATE` lists.
 */
export function isPrivateNetworkAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Private.check(ip, 'ipv4');
  if (family !== 6) return false;
  const bytes = v6Bytes(ip);
  if (startsWith(bytes, MAPPED, 96)) return v4Private.check(bytes.slice(12).join('.'), 'ipv4');
  return startsWith(bytes, ULA, 7);
}
