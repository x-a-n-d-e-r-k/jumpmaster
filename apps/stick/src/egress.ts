// Egress, stick side: one proxy per drop, started on the drop's own network and waited for before
// anything else runs there. A proxy that never says it is ready fails the drop, so a drop under
// egress never runs without its only exit being the proxy.
import type { DropPayload, TrooperEvent } from '@jumpmaster/protocol';
import type { ContainerDriver, DropNet, ProxyHandle } from './driver.js';
import { dropSubnetPool } from './subnets.js';

/** The proxy image. Until image verification lands it is allowed automatically, for the proxy only. */
export const egressImage = (env: NodeJS.ProcessEnv): string =>
  (env.JM_EGRESS_IMAGE ?? '').trim() || 'jumpmaster-egress:dev';

export const EGRESS_READY_MS = 30_000;
/** Hosts itemised per drop; the rest are counted in one overflow event. */
export const MAX_EGRESS_HOSTS = 200;
const DRAIN_MS = 10_000;

type Decision = 'allow' | 'deny' | 'unlisted';

/** Sums the proxy's per-tunnel lines into one count per host and decision. */
export class EgressTally {
  private readonly counts = new Map<string, { host: string; decision: Decision; count: number }>();
  private overflow = 0;

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
    if (seen) seen.count++;
    else if (this.counts.size < MAX_EGRESS_HOSTS)
      this.counts.set(key, { host, decision, count: 1 });
    else this.overflow++;
  }

  events(ts = new Date().toISOString()): TrooperEvent[] {
    const out: TrooperEvent[] = [...this.counts.values()].map((c) => ({
      ts,
      kind: 'egress',
      data: { host: c.host, decision: c.decision, count: c.count },
    }));
    if (this.overflow > 0)
      out.push({
        ts,
        kind: 'egress',
        data: {
          host: `(more than ${MAX_EGRESS_HOSTS} hosts)`,
          decision: 'mixed',
          count: this.overflow,
          overflow: true,
        },
      });
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
  },
): Promise<EgressSession> {
  const readyMs = o.readyMs ?? EGRESS_READY_MS;
  const handle: ProxyHandle = await driver.startEgressProxy({
    name: `jm-egress-${o.dropId}-${o.epoch}`,
    image: o.image,
    net: o.net,
    env: {
      JM_EGRESS_MODE: o.egress.mode,
      JM_EGRESS_ALLOW: o.egress.allow.join(','),
      JM_EGRESS_BIND: o.net.proxy,
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
 * Whether this stick can enforce egress, so may advertise `egress-v1`: the proxy image is on the
 * engine, the subnet pool is valid, and the engine creates an internal drop network on it. Run once
 * at startup; a drop still fails closed if any of it breaks later.
 */
export async function egressCapability(
  driver: ContainerDriver,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const image = egressImage(env);
  if (!(await driver.imageExists(image).catch(() => false)))
    return { ok: false, reason: `the egress proxy image ${image} is not on this engine` };
  let pool: string;
  try {
    pool = dropSubnetPool(env);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const name = `jm-egress-probe-${(env.HOSTNAME ?? '').replace(/[^a-zA-Z0-9_.-]/g, '') || 'stick'}`;
  await driver.removeNetwork(name).catch(() => {});
  try {
    await driver.createDropNetwork(name, { 'jumpmaster.egress-probe': '1' }, pool);
  } catch (e) {
    return {
      ok: false,
      reason: `cannot create a drop network: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  await driver.removeNetwork(name).catch(() => {});
  return { ok: true };
}
