import { createHash } from 'node:crypto';
import {
  ARTIFACT_PREFIX,
  ArtifactChunkSchema,
  type ArtifactUpload,
  type DropPayload,
  type DropResult,
  DropResultSchema,
  EVENT_PREFIX,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  payloadSecrets,
  RESULT_PREFIX,
  redact,
  type TrooperEvent,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { DropClient } from './client.js';
import type { ContainerDriver, DropNet } from './driver.js';
import { type EgressSession, egressImage, startEgress } from './egress.js';
import { dropSubnetPool } from './subnets.js';

/** Services a drop network holds under egress: `.8` to `.14` of its /28. */
const MAX_EGRESS_SERVICES = 6;

export const TROOPER_IMAGE = process.env.JM_TROOPER_IMAGE ?? 'jumpmaster-trooper:dev';
const STOP_GRACE_MS = 30_000;
const MAX_BATCH = 50;
/** Keeps an events POST far below the server's 1 MB body limit (each event is ≤ 64 KB). */
const MAX_BATCH_BYTES = 512 * 1024;
const FLUSH_MS = 1000;
export const STICK_LABEL = 'jumpmaster.stick';
const DEFAULT_IMAGE = 'jumpmaster-trooper:dev';

/**
 * Images this stick will run, matched exactly (no prefix or tag wildcards). `JM_ALLOWED_IMAGES` is
 * a comma list; unset or empty allows only the configured trooper image and the dev default.
 */
export function allowedImages(env: NodeJS.ProcessEnv): Set<string> {
  const listed = (env.JM_ALLOWED_IMAGES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (listed.length > 0) return new Set(listed);
  return new Set([...(env.JM_TROOPER_IMAGE ? [env.JM_TROOPER_IMAGE] : []), DEFAULT_IMAGE]);
}

/**
 * Force-removes trooper containers this stick left behind (e.g. it crashed mid-drop), so a
 * re-leased drop never runs alongside a still-live agent. Other sticks' containers are untouched.
 */
export async function reapOrphans(driver: ContainerDriver, stickId: string): Promise<string[]> {
  const removed: string[] = [];
  for (const id of await driver.listByLabel(STICK_LABEL, stickId)) {
    try {
      await driver.remove(id);
      removed.push(id);
    } catch {
      // already gone (AutoRemove) or racing another cleanup
    }
  }
  await driver.removeNetworksByLabel(STICK_LABEL, stickId).catch(() => 0);
  return removed;
}

/**
 * Removes this stick's drop networks that no running drop holds, with whatever is left on them
 * (services and proxies carry the drop's labels). Runs every 10 minutes, not only at start: a
 * leaked network holds a /28 of a small pool. Returns how many it removed.
 */
export async function sweepDropNetworks(
  driver: ContainerDriver,
  stickId: string,
  active: Set<string>,
): Promise<number> {
  let removed = 0;
  for (const n of await driver.listNetworksByLabel(STICK_LABEL, stickId)) {
    if (active.has(n.name)) continue;
    const drop = n.labels['jumpmaster.drop'];
    const epoch = n.labels['jumpmaster.epoch'];
    // Without the drop labels the container filter would be too wide: leave it for a restart.
    if (!drop || !epoch) continue;
    await driver
      .removeServices(n.name, {
        'jumpmaster.drop': drop,
        'jumpmaster.epoch': epoch,
        [STICK_LABEL]: stickId,
      })
      .catch(() => {});
    removed++;
  }
  return removed;
}

/** At the 15-second beat this is inside the server's 60-second lease. */
const DEFAULT_LOST_SERVER_KILL_BEATS = 3;

/** Rebuilds artifacts from their stdout chunks. A file that fails its hash is dropped. */
class ArtifactAssembler {
  private readonly parts = new Map<string, Buffer[]>();
  private bytes = 0;
  private finished = 0;

  add(json: string): ArtifactUpload | null {
    const chunk = ArtifactChunkSchema.safeParse(safeJson(json));
    if (!chunk.success || this.finished >= MAX_ARTIFACTS) return null;
    const { sha256, index, total, data, rule, name, mediaType } = chunk.data;
    const decoded = Buffer.from(data, 'base64');
    this.bytes += decoded.length;
    if (this.bytes > MAX_ARTIFACTS * MAX_ARTIFACT_BYTES) return null;
    const parts = this.parts.get(sha256) ?? [];
    this.parts.set(sha256, parts);
    parts[index] = decoded;
    if (index !== total - 1) return null;
    this.parts.delete(sha256);
    const whole = Buffer.concat(parts.filter(Boolean));
    if (createHash('sha256').update(whole).digest('hex') !== sha256) return null;
    this.finished++;
    return { rule, name, mediaType, sha256, dataBase64: whole.toString('base64') };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type RunDeps = {
  client: DropClient;
  driver: ContainerDriver;
  stickId: string;
  heartbeatMs?: number;
  /** Consecutive failed heartbeats before a hard kill. A kill can't reach a cut-off stick. */
  lostServerKillBeats?: number;
  image?: string;
  /** Defaults to `allowedImages(process.env)`. */
  allowedImages?: Set<string>;
  /** The egress proxy image; defaults to `JM_EGRESS_IMAGE`. Allowed for the proxy only. */
  egressImage?: string;
  egressReadyMs?: number;
  /** Defaults to `JM_DROP_SUBNET_POOL`. */
  subnetPool?: string;
  /** Drop networks in use, so the periodic sweep leaves them alone. */
  active?: Set<string>;
};

export async function runDrop(payload: DropPayload, deps: RunDeps): Promise<void> {
  const { client, driver } = deps;
  const { dropId, epoch } = payload;
  const image = payload.image || deps.image || TROOPER_IMAGE;
  if (!(deps.allowedImages ?? allowedImages(process.env)).has(image)) {
    await client.postResult(dropId, epoch, {
      status: 'failed',
      role: payload.role,
      reason: `image not allowed: ${image}`,
      gates: [],
    });
    return;
  }
  const allowed = deps.allowedImages ?? allowedImages(process.env);
  const services = ('services' in payload ? payload.services : undefined) ?? [];
  const blocked = services.find((s) => !allowed.has(s.image));
  if (blocked) {
    await client.postResult(dropId, epoch, {
      status: 'failed',
      role: payload.role,
      reason: `image not allowed: ${blocked.image}`,
      gates: [],
    });
    return;
  }
  const egress = payload.egress;
  const fail = (reason: string) =>
    client.postResult(dropId, epoch, { status: 'failed', role: payload.role, reason, gates: [] });
  if (egress && services.length > MAX_EGRESS_SERVICES) {
    await fail(`egress allows at most ${MAX_EGRESS_SERVICES} services per drop`);
    return;
  }
  const labels = {
    'jumpmaster.drop': dropId,
    'jumpmaster.epoch': String(epoch),
    [STICK_LABEL]: deps.stickId,
  };
  const network = services.length > 0 || egress ? `jm-drop-${dropId}-${epoch}` : undefined;
  let net: DropNet | undefined;
  let session: EgressSession | undefined;
  if (network) deps.active?.add(network);
  try {
    if (egress && network) {
      // Fail closed: no network, no proxy or no ready line means no trooper.
      try {
        const pool = deps.subnetPool ?? dropSubnetPool(process.env);
        net = await driver.createDropNetwork(network, labels, pool);
        session = await startEgress(driver, {
          dropId,
          epoch,
          egress,
          net,
          image: deps.egressImage ?? egressImage(process.env),
          labels,
          ...(deps.egressReadyMs !== undefined ? { readyMs: deps.egressReadyMs } : {}),
        });
      } catch (e) {
        await fail(`egress proxy failed to start: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      console.log(JSON.stringify({ event: 'egress', dropId, mode: egress.mode, proxy: 'ready' }));
    }
    if (services.length > 0) {
      try {
        await driver.startServices(dropId, epoch, services, labels, net);
      } catch (e) {
        await fail(`services failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    await runContainer(payload, deps, image, labels, network, net, session);
  } finally {
    if (session) await session.stop();
    if (network) await driver.removeServices(network, labels).catch(() => {});
    if (network) deps.active?.delete(network);
  }
}

async function runContainer(
  payload: DropPayload,
  deps: RunDeps,
  image: string,
  labels: Record<string, string>,
  network: string | undefined,
  net: DropNet | undefined,
  session: EgressSession | undefined,
): Promise<void> {
  const { client, driver } = deps;
  const { dropId, epoch } = payload;
  const handle = await driver.start({
    image,
    payload: JSON.stringify(payload),
    name: `jumpmaster-drop-${dropId}-${epoch}`,
    labels,
    ...(network ? { network } : {}),
    ...(net ? { egress: net } : {}),
    ...(payload.limits ? { limits: payload.limits } : {}),
  });

  let stale = false;
  let cancelled = false;
  let stopping: Promise<void> | undefined;
  let killing: Promise<void> | undefined;
  const stop = () => {
    stopping ??= handle.stop(STOP_GRACE_MS).catch(() => {});
    return stopping;
  };

  let pending: TrooperEvent[] = [];
  let pendingBytes = 0;
  let flushing = Promise.resolve();
  const queue = (ev: TrooperEvent, bytes: number) => {
    if (pending.length > 0 && pendingBytes + bytes > MAX_BATCH_BYTES) void flush();
    pending.push(ev);
    pendingBytes += bytes;
    if (pending.length >= MAX_BATCH) void flush();
  };
  const flush = () => {
    if (pending.length === 0) return flushing;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    flushing = flushing.then(async () => {
      try {
        if ((await client.postEvents(dropId, epoch, batch)) === 'stale') {
          stale = true;
          void stop();
        }
      } catch {
        // events are best-effort; the result is what matters
      }
    });
    return flushing;
  };

  const hardKill = () => {
    cancelled = true;
    killing ??= handle.kill().catch(() => {});
    return killing;
  };
  const lostLimit = deps.lostServerKillBeats ?? DEFAULT_LOST_SERVER_KILL_BEATS;
  let failedBeats = 0;
  const hb = setInterval(async () => {
    if (killing) return;
    try {
      const r = await client.heartbeat(dropId, epoch);
      failedBeats = 0;
      if (r === 'ok') return;
      if (r === 'hard_cancel') {
        void hardKill();
        return;
      }
      if (r === 'stale') stale = true;
      else cancelled = true;
      void stop();
    } catch {
      // Keep going through a blip. Past the limit the lease is ending anyway.
      failedBeats++;
      if (failedBeats >= lostLimit) void hardKill();
    }
  }, deps.heartbeatMs ?? 15_000);
  const flusher = setInterval(() => void flush(), FLUSH_MS);

  const artifacts = new ArtifactAssembler();
  const uploads: Promise<unknown>[] = [];
  let result: DropResult | undefined;
  let postedReal = false;
  try {
    for await (const line of handle.logs()) {
      if (line.startsWith(ARTIFACT_PREFIX)) {
        const done = artifacts.add(line.slice(ARTIFACT_PREFIX.length));
        if (done) uploads.push(client.postArtifact(dropId, epoch, done).catch(() => 'stale'));
      } else if (line.startsWith(EVENT_PREFIX)) {
        try {
          const ev = TrooperEventSchema.parse(JSON.parse(line.slice(EVENT_PREFIX.length)));
          // Egress events come from the stick's own reading of the proxy, never the trooper.
          if (ev.kind === 'egress') continue;
          queue(ev, Buffer.byteLength(line));
        } catch {
          // malformed event line: drop it
        }
      } else if (line.startsWith(RESULT_PREFIX)) {
        try {
          result = DropResultSchema.parse(JSON.parse(line.slice(RESULT_PREFIX.length)));
        } catch {
          // malformed result: treated as missing
        }
      }
    }
    const { exitCode } = await handle.wait();
    // The proxy logs each tunnel as it closes: stop it, then report the drop's egress.
    if (session)
      for (const ev of await session.finish()) queue(ev, Buffer.byteLength(JSON.stringify(ev)));
    await flush();
    // Before the result: the server checks for these when it reads the verdict.
    await Promise.allSettled(uploads);
    await stopping;
    // The server no longer owns this epoch (stale) or already cancelled it: it would 409 a result.
    if (stale || cancelled) return;
    if (result) {
      postedReal = true;
      await client.postResult(dropId, epoch, result);
    } else {
      await client.postResult(dropId, epoch, {
        status: 'failed',
        role: payload.role,
        reason: noResultReason(exitCode, handle.stderrTail(), payload),
        gates: [],
      });
    }
  } catch (e) {
    await stop();
    // A real result that could not be delivered must not be replaced by a synthetic failure
    // (the server would lose result_json); surface the error to the caller instead.
    if (postedReal) throw e;
    if (!stale && !cancelled) {
      const reason = `stick runner error: ${e instanceof Error ? e.message : String(e)}`;
      await client
        .postResult(dropId, epoch, { status: 'failed', role: payload.role, reason, gates: [] })
        .catch(() => {});
    }
  } finally {
    clearInterval(hb);
    clearInterval(flusher);
  }
}

const MAX_STDERR_REASON = 500;
/** Stack frames and the lines Node prints after a crash: they say nothing about its cause. */
const NODE_FOOTER = /^(at |Node\.js v\d|\(Use `node --trace-)/;

/** Names the exit and, when the trooper said why on stderr, its last line with every credential scrubbed. */
function noResultReason(exitCode: number, stderr: string, payload: DropPayload): string {
  const base = `trooper exited ${exitCode} without result`;
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NODE_FOOTER.test(l))
    .at(-1);
  if (!last) return base;
  return `${base}: ${redact(last, payloadSecrets(payload)).slice(0, MAX_STDERR_REASON)}`;
}
