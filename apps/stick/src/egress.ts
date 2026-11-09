// Egress, stick side: one proxy per drop, started on the drop's own network and waited for before
// anything else runs there. A proxy that never says it is ready fails the drop, so a drop under
// egress never runs without its only exit being the proxy.
import type { DropPayload, TrooperEvent } from '@jumpmaster/protocol';
import type { ContainerDriver, DropNet, IsolationFacts, ProxyHandle } from './driver.js';
import { dropSubnetPool } from './subnets.js';

/** The proxy image. Until image verification lands it is allowed automatically, for the proxy only. */
export const egressImage = (env: NodeJS.ProcessEnv): string =>
  (env.JM_EGRESS_IMAGE ?? '').trim() || 'jumpmaster-egress:dev';

export const EGRESS_READY_MS = 30_000;
/** Hosts itemised per decision per drop; the rest are counted in one overflow event each. */
export const MAX_EGRESS_HOSTS = 200;
const DRAIN_MS = 10_000;

type Decision = 'allow' | 'deny' | 'unlisted';
const DECISIONS: Decision[] = ['deny', 'unlisted', 'allow'];

/**
 * Sums the proxy's per-tunnel lines into one count per host and decision. The cap is per decision,
 * so a flood of refusals (free to generate) can never push an allowed or unlisted host out of the
 * table; what doesn't fit is counted per decision, in hosts and connections.
 */
export class EgressTally {
  private readonly counts = new Map<string, { host: string; decision: Decision; count: number }>();
  private readonly shown: Record<Decision, number> = { allow: 0, deny: 0, unlisted: 0 };
  private readonly overflow = new Map<Decision, Map<string, number>>();

  add(line: string): void {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    const l = v as { host?: unknown; decision?: unknown; reason?: unknown };
    if (typeof l.host !== 'string' || (l.decision !== 'allow' && l.decision !== 'deny')) return;
    const decision: Decision =
      l.decision === 'deny' ? 'deny' : l.reason === 'unlisted' ? 'unlisted' : 'allow';
    const host = l.host.slice(0, 253);
    const key = `${decision}\u0000${host}`;
    const seen = this.counts.get(key);
    if (seen) {
      seen.count++;
      return;
    }
    if (this.shown[decision] < MAX_EGRESS_HOSTS) {
      this.shown[decision]++;
      this.counts.set(key, { host, decision, count: 1 });
      return;
    }
    const over = this.overflow.get(decision) ?? new Map<string, number>();
    this.overflow.set(decision, over);
    // Distinct overflow hosts are counted up to a bound, so the stick's memory stays bounded too.
    if (over.has(host) || over.size < 100_000) over.set(host, (over.get(host) ?? 0) + 1);
  }

  events(ts = new Date().toISOString()): TrooperEvent[] {
    const out: TrooperEvent[] = [...this.counts.values()].map((c) => ({
      ts,
      kind: 'egress',
      data: { host: c.host, decision: c.decision, count: c.count },
    }));
    for (const decision of DECISIONS) {
      const over = this.overflow.get(decision);
      if (!over || over.size === 0) continue;
      let count = 0;
      for (const n of over.values()) count += n;
      out.push({
        ts,
        kind: 'egress',
        data: {
          host: `(${over.size} more ${decision} hosts)`,
          decision,
          count,
          hosts: over.size,
          overflow: true,
        },
      });
    }
    return out;
  }
}

/** A drop's running proxy: stop it and collect its aggregated events. */
export type EgressSession = {
  /** Stops the proxy, drains its last lines and returns the drop's egress events. */
  finish(): Promise<TrooperEvent[]>;
  stop(): Promise<void>;
};

/** Reads lines until `{"ready":true}`; false when the stream ends or the time runs out first. */
async function waitReady(it: AsyncIterator<string>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const next = await Promise.race([
      it.next(),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), left);
      }),
    ]);
    clearTimeout(timer);
    if (next === 'timeout' || next.done) return false;
    try {
      if ((JSON.parse(next.value) as { ready?: unknown }).ready === true) return true;
    } catch {
      // not a JSON line: keep reading
    }
  }
}

/**
 * Starts the drop's proxy at the network's `.2`, bound there only, and waits for its ready line.
 * Throws (after stopping it) when the proxy can't start or isn't ready in time.
 */
export async function startEgress(
  driver: ContainerDriver,
  o: {
    dropId: string;
    epoch: number;
    egress: NonNullable<DropPayload['egress']>;
    net: DropNet;
    image: string;
    labels: Record<string, string>;
    readyMs?: number;
    /** Where the proxy limits come from (default process.env). */
    env?: NodeJS.ProcessEnv;
  },
): Promise<EgressSession> {
  const env = o.env ?? process.env;
  const limits = Object.fromEntries(
    ['JM_EGRESS_MAX_TUNNELS', 'JM_EGRESS_MAX_CONNECTIONS'].flatMap((k) =>
      env[k] ? [[k, env[k] as string]] : [],
    ),
  );
  const readyMs = o.readyMs ?? EGRESS_READY_MS;
  const handle: ProxyHandle = await driver.startEgressProxy({
    name: `jm-egress-${o.dropId}-${o.epoch}`,
    image: o.image,
    net: o.net,
    env: {
      JM_EGRESS_MODE: o.egress.mode,
      JM_EGRESS_ALLOW: o.egress.allow.join(','),
      JM_EGRESS_BIND: o.net.proxy,
      ...limits,
    },
    labels: o.labels,
  });
  const it = handle.logs()[Symbol.asyncIterator]();
  if (!(await waitReady(it, readyMs))) {
    await handle.stop().catch(() => {});
    throw new Error(`no ready line within ${Math.round(readyMs / 1000)}s`);
  }
  const tally = new EgressTally();
  const drained = (async () => {
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      tally.add(r.value);
    }
  })().catch(() => {});
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= handle.stop().catch(() => {});
    return stopping;
  };
  return {
    stop,
    async finish() {
      await stop();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([drained, new Promise((r) => (timer = setTimeout(r, DRAIN_MS)))]);
      clearTimeout(timer);
      return tally.events();
    },
  };
}

/**
 * The oldest Docker Engine egress is checked against. Below it the stick never advertises
 * egress-v1, whatever the probe says (the bridge driver accepts options it doesn't know).
 */
export const MIN_ENGINE_VERSION = '27.0';

/** Whether an engine version (`29.9.2`, `28.0.0-rc.1`) is at least `min` (`major.minor`). */
export function engineAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)/.exec(v.trim());
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  const [am, an, bm, bn] = [a[1], a[2], b[1], b[2]].map(Number) as [number, number, number, number];
  return am > bm || (am === bm && an >= bn);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Whether this stick can enforce egress, so may advertise `egress-v1`. Run once at startup:
 * - the proxy image is on the engine, the subnet pool is valid, and the engine is recent enough;
 * - on a real drop network, behaviourally: a container with the drop's settings can't reach a
 *   listener on the host at the gateway, the gateway holds no host address, and IPv6 is off in it;
 * - the proxy image starts on that network, bound to `.2`, and prints its ready line.
 * Any failure means no egress-v1, with the reason, and the zone's drops stay queued. A drop still
 * fails closed if any of it breaks later.
 */
export async function egressCapability(
  driver: ContainerDriver,
  env: NodeJS.ProcessEnv,
  o: { readyMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const image = egressImage(env);
  if (!(await driver.imageExists(image).catch(() => false)))
    return { ok: false, reason: `the egress proxy image ${image} is not on this engine` };
  let pool: string;
  try {
    pool = dropSubnetPool(env);
  } catch (e) {
    return { ok: false, reason: message(e) };
  }
  const version = await driver.engineVersion().catch(() => '');
  if (!engineAtLeast(version, MIN_ENGINE_VERSION))
    return {
      ok: false,
      reason: `Docker Engine ${version || 'unknown'} is older than ${MIN_ENGINE_VERSION}, the oldest egress is checked against`,
    };
  const host = (env.HOSTNAME ?? '').replace(/[^a-zA-Z0-9_.-]/g, '') || 'stick';
  const name = `jm-egress-probe-${host}`;
  const labels = { 'jumpmaster.egress-probe': name };
  // A probe left by a crash is removed first (its proxy carries these labels).
  await driver.removeServices(name, labels).catch(() => {});
  let net: DropNet;
  try {
    net = await driver.createDropNetwork(name, labels, pool);
  } catch (e) {
    return { ok: false, reason: `cannot create a drop network: ${message(e)}` };
  }
  try {
    let facts: IsolationFacts;
    try {
      facts = await driver.probeIsolation(net, image);
    } catch (e) {
      return { ok: false, reason: `the isolation probe failed: ${message(e)}` };
    }
    if (!facts.listenerUp)
      return { ok: false, reason: 'the isolation probe could not start its host listener' };
    if (facts.gatewayOnHost)
      return {
        ok: false,
        reason: `the engine put the drop gateway ${net.gateway} on the host: inhibit_ipv4 is not honoured`,
      };
    if (facts.gatewayReachable)
      return {
        ok: false,
        reason: `a drop container reached a host listener at its gateway ${net.gateway}`,
      };
    if (!facts.ipv6Disabled)
      return { ok: false, reason: 'IPv6 could not be disabled in a drop container' };
    try {
      const session = await startEgress(driver, {
        dropId: `probe-${host}`,
        epoch: 0,
        egress: { mode: 'enforce', allow: [] },
        net,
        image,
        labels,
        ...(o.readyMs !== undefined ? { readyMs: o.readyMs } : {}),
      });
      await session.stop();
    } catch (e) {
      return {
        ok: false,
        reason: `the egress proxy did not start on a drop network: ${message(e)}`,
      };
    }
    return { ok: true };
  } finally {
    await driver.removeServices(name, labels).catch(() => {});
  }
}
