// Per-drop /28 networks under egress, carved by the stick from its own pool so a busy host never
// exhausts the engine's default address pools (one /16 or /20 each).
import type { DropNet } from './driver.js';

export const DEFAULT_DROP_SUBNET_POOL = '172.30.0.0/16';
const BLOCK = 16; // a /28

type Cidr = { base: number; size: number };

function parseV4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
    return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

const formatV4 = (n: number): string =>
  [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** An IPv4 CIDR, or null for anything else (IPv6, garbage, a host address with a prefix). */
function parseCidr(cidr: string): Cidr | null {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const base = parseV4(m[1] as string);
  const prefix = Number(m[2]);
  if (base === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  if (base % size !== 0) return null;
  return { base, size };
}

const overlaps = (a: Cidr, b: Cidr): boolean =>
  a.base < b.base + b.size && b.base < a.base + a.size;

/** The stick's pool: `JM_DROP_SUBNET_POOL`, an IPv4 network of /28 or wider. */
export function dropSubnetPool(env: NodeJS.ProcessEnv): string {
  const pool = (env.JM_DROP_SUBNET_POOL ?? '').trim() || DEFAULT_DROP_SUBNET_POOL;
  const c = parseCidr(pool);
  if (!c || c.size < BLOCK)
    throw new Error(`JM_DROP_SUBNET_POOL must be an IPv4 network of /28 or wider, not ${pool}`);
  return pool;
}

/** The first /28 of `pool` that overlaps none of `existing` (IPv4 subnets held by any network). */
export function allocateSubnet(existing: string[], pool: string): string {
  const p = parseCidr(pool);
  if (!p) throw new Error(`bad subnet pool ${pool}`);
  const held = existing.map(parseCidr).filter((c): c is Cidr => c !== null);
  for (let base = p.base; base + BLOCK <= p.base + p.size; base += BLOCK) {
    const candidate = { base, size: BLOCK };
    if (!held.some((h) => overlaps(h, candidate))) return `${formatV4(base)}/28`;
  }
  throw new Error(
    `no free /28 in ${pool}: leaked drop networks, or a pool too small for the slots`,
  );
}

/**
 * Fixed addresses in a drop's /28: `.1` the gateway, `.2` the proxy, `.3` the trooper, `.4` the
 * dead DNS upstream (never assigned, so the engine's resolver forwards external names nowhere),
 * and services from `.8/29`.
 */
export function dropLayout(name: string, subnet: string): DropNet {
  const c = parseCidr(subnet);
  if (!c || c.size !== BLOCK) throw new Error(`a drop subnet must be a /28, not ${subnet}`);
  const at = (offset: number) => formatV4(c.base + offset);
  return {
    name,
    subnet,
    gateway: at(1),
    proxy: at(2),
    trooper: at(3),
    dns: at(4),
    ipRange: `${at(8)}/29`,
  };
}
