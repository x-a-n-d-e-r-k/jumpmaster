import { createHash, randomBytes } from 'node:crypto';
import {
  ARTIFACT_PREFIX,
  ArtifactChunkSchema,
  type ArtifactUpload,
  ceilingRefusal,
  type DropPayload,
  type DropResult,
  DropResultSchema,
  EVENT_PART_PREFIX,
  EVENT_PREFIX,
  isPushingRole,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  payloadSecrets,
  RESULT_PREFIX,
  redact,
  redactTokenShapes,
  type TrooperEvent,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { Ack, CloneClient, DropClient } from './client.js';
import { runClone, TROOPER_CLONE_LABEL, TROOPER_CLONE_VERSION } from './clone.js';
import type { ContainerDriver, DropNet, VolumeInfo } from './driver.js';
import {
  type EgressSession,
  egressImage,
  startEgress,
  stickCeiling,
  trooperEgressRefusal,
} from './egress.js';
import { EventAssembler } from './event-assembler.js';
import { fetchFromServer, fromServer } from './fetch-image.js';
import type { ImageHold, StickImages } from './image-gc.js';
import { pullImage } from './pull.js';
import {
  type PendingPushes,
  PUSH_BACKOFF_MAX_MS,
  pushContainer,
  TROOPER_MIRROR_LABEL,
  TROOPER_MIRROR_VERSION,
  TROOPER_PUSH_LABEL,
  TROOPER_PUSH_VERSION,
} from './push.js';
import { dropSubnetPool } from './subnets.js';
import { digestOf, type ImageTrust, verifyBaseImage, verifyImage } from './verify.js';
import {
  createMirrorVolume,
  MIRROR_LABEL,
  MIRROR_MOUNT,
  prepareVolume,
  REMOVE_TIMEOUT_MS,
  REPO_MOUNT,
  VOLUME_LABEL,
} from './volumes.js';

/** Services a drop network holds under egress: `.8` to `.14` of its /28. */
const MAX_EGRESS_SERVICES = 6;

/**
 * The stick's own trooper image: it runs the volume init, self-check and push containers, never a
 * drop's agent. The release stick image bakes it by digest; an empty value is the dev default.
 */
export const TROOPER_IMAGE = process.env.JM_TROOPER_IMAGE || 'jumpmaster-trooper:dev';
const STOP_GRACE_MS = 30_000;
const MAX_BATCH = 50;
/**
 * Keeps an events POST far below the server's 8 MiB limit for it: a batch is ≤ 512 KiB of events
 * plus one, an event is ≤ 2 MiB, and an event over {@link SOLO_EVENT_BYTES} is posted alone.
 */
const MAX_BATCH_BYTES = 512 * 1024;
const SOLO_EVENT_BYTES = 1024 * 1024;
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
 * Each removal is confirmed (`removeAndWait`); `unconfirmed` are those the engine never showed
 * gone, so no pending push may be rediscovered yet (Ruling 14). Volumes are never removed here.
 */
export async function reapOrphans(
  driver: ContainerDriver,
  stickId: string,
): Promise<{ removed: string[]; unconfirmed: string[] }> {
  const removed: string[] = [];
  const unconfirmed: string[] = [];
  for (const id of await driver.listByLabel(STICK_LABEL, stickId)) {
    let ours = false;
    try {
      await driver.remove(id);
      ours = true;
    } catch {
      // already gone (AutoRemove) or racing another cleanup: the confirmation below decides
    }
    try {
      await driver.removeAndWait(id, REMOVE_TIMEOUT_MS);
      if (ours) removed.push(id);
    } catch {
      unconfirmed.push(id);
    }
  }
  await driver.removeNetworksByLabel(STICK_LABEL, stickId).catch(() => 0);
  return { removed, unconfirmed };
}

/** Marks the self-check's own short-lived volume (never a drop's). */
export const SELFCHECK_LABEL = 'jumpmaster.selfcheck';

/**
 * The latest volume self-check. `freeBytes` is null when it couldn't be measured, which counts as
 * below the floor. `clone`: the base trooper image carries the clone label (read in the same
 * inspection as the push label), so it can run a drop's clone container.
 */
export type VolumeHealth = { selfCheck: boolean; freeBytes: number | null; clone: boolean };

/** The latest verdict on the stick's own trooper image (Ruling 17). */
export type BaseVerdict = { ok: true } | { ok: false; reason: string };

/** What a health check found: the base image's verdict, then the volume self-check's. */
export type StickHealth = VolumeHealth & { base: BaseVerdict };

/**
 * The volume self-check, at startup and in every sweep (Ruling 18): the trooper image carries
 * the push label, a fresh volume takes the init container, and the agent can write to it. The
 * free space is measured from inside a container on that volume, so it is the engine's volume
 * filesystem wherever the stick itself runs. Never throws; the volume is removed after.
 */
export async function volumeSelfCheck(
  driver: ContainerDriver,
  image: string,
  stickId: string,
): Promise<VolumeHealth> {
  const name = `jm-selfcheck-${stickId}-${randomBytes(4).toString('hex')}`;
  const labels = { [STICK_LABEL]: stickId, [SELFCHECK_LABEL]: '1' };
  let clone = false;
  try {
    const imageLabels = await driver.imageLabels(image).catch(() => ({}) as Record<string, string>);
    const pushLabel = imageLabels[TROOPER_PUSH_LABEL] === TROOPER_PUSH_VERSION;
    clone = imageLabels[TROOPER_CLONE_LABEL] === TROOPER_CLONE_VERSION;
    await driver.createVolume(name, labels);
    try {
      const init = await driver
        .initVolume({ name: `${name}-init`, image, volume: name, labels })
        .catch(() => -1);
      const probe = await driver
        .probeVolume({ name: `${name}-probe`, image, volume: name, labels })
        .catch(() => undefined);
      return {
        selfCheck: pushLabel && init === 0 && probe?.writable === true,
        freeBytes: probe?.freeBytes ?? null,
        clone,
      };
    } finally {
      // A leaked self-check volume is the sweep's to remove.
      await driver.removeVolume(name).catch(() => {});
    }
  } catch {
    return { selfCheck: false, freeBytes: null, clone };
  }
}

/**
 * The stick's health, at startup and in every sweep: the base image is verified (and pulled)
 * first, and only a verified image runs the volume self-check. A refused base image withholds
 * push-v1 and leaves the free space unmeasured (which never stops leasing on its own).
 */
export async function stickHealth(
  driver: ContainerDriver,
  o: { image: string; stickId: string; trust: ImageTrust; log: (line: string) => void },
): Promise<StickHealth> {
  const base = await verifyBaseImage(o.image, { trust: o.trust, driver, log: o.log });
  if (!base.ok) return { selfCheck: false, freeBytes: null, clone: false, base };
  return { ...(await volumeSelfCheck(driver, o.image, o.stickId)), base };
}

/**
 * The stick's health over time: single-flight checks (a sweep and a floor wait never run two at
 * once), the latest result, and whether a check is in flight (so the sweep leaves its self-check
 * volume alone).
 */
export class HealthMonitor {
  private current: StickHealth = {
    selfCheck: false,
    freeBytes: null,
    clone: false,
    base: { ok: false, reason: 'base image not checked yet' },
  };
  private inFlight: Promise<StickHealth> | undefined;

  constructor(
    private readonly driver: ContainerDriver,
    private readonly o: {
      image: string;
      stickId: string;
      trust: ImageTrust;
      log: (line: string) => void;
    },
  ) {}

  latest(): StickHealth {
    return this.current;
  }

  busy(): boolean {
    return this.inFlight !== undefined;
  }

  /** Runs a check, or joins the one in flight. */
  check(): Promise<StickHealth> {
    this.inFlight ??= stickHealth(this.driver, this.o)
      .then((h) => {
        this.current = h;
        return h;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }
}

/**
 * Before the first lease: reap this stick's orphans, then rediscover its pending pushes. Each
 * volume waits only on its own drop's containers (Ruling 14 is per drop): an orphan the engine
 * can't confirm gone keeps its own drop's volume back, never another's.
 */
export async function recoverAtStartup(
  driver: ContainerDriver,
  client: Pick<DropClient, 'salvage'>,
  stickId: string,
  pending: PendingPushes,
  log: (line: string) => void = (line) => console.log(line),
): Promise<{ removed: string[]; unconfirmed: string[] }> {
  const reaped = await reapOrphans(driver, stickId);
  await rediscoverPending(driver, client, stickId, pending, log);
  return reaped;
}

/**
 * One drop volume no live drop or pending push holds: once both containers that could hold it
 * (the agent's and the push container) are confirmed gone, the server decides. `salvage` ok: it
 * joins `PendingPushes`; refused: it is removed; no answer: it stays for the next sweep.
 */
async function reconcileVolume(
  driver: ContainerDriver,
  client: Pick<DropClient, 'salvage'>,
  pending: PendingPushes,
  v: VolumeInfo,
  log: (line: string) => void,
): Promise<void> {
  const dropId = v.labels['jumpmaster.drop'];
  const epoch = Number(v.labels['jumpmaster.epoch']);
  const say = (what: string, extra: Record<string, unknown> = {}) =>
    log(JSON.stringify({ event: 'volume', dropId, epoch, volume: v.name, what, ...extra }));
  if (!dropId || !Number.isInteger(epoch)) return;
  try {
    await driver.removeAndWait(agentName(dropId, epoch), REMOVE_TIMEOUT_MS);
    await driver.removeAndWait(pushContainer(dropId, epoch), REMOVE_TIMEOUT_MS);
  } catch (e) {
    say('container not removed: volume kept', { error: message(e) });
    return;
  }
  let answer: 'ok' | 'refused';
  try {
    answer = await client.salvage(dropId, epoch);
  } catch (e) {
    say('salvage unanswered: volume kept', { error: redactTokenShapes(message(e)) });
    return;
  }
  if (answer === 'ok') {
    const held = pending.get(dropId);
    if (held && held.volume !== v.name) {
      say('another volume holds this drop: volume kept');
      return;
    }
    pending.add(dropId, { epoch, volume: v.name });
    say('rediscovered: push pending');
    return;
  }
  await driver.removeVolume(v.name).then(
    () => say('salvage refused: volume removed'),
    (e: unknown) => say('volume not removed', { error: message(e) }),
  );
}

/** This stick's drop repo volumes (not the self-check's or a mirror), as the engine lists them. */
async function dropVolumes(driver: ContainerDriver, stickId: string): Promise<VolumeInfo[]> {
  return (await driver.listVolumesByLabel(STICK_LABEL, stickId)).filter(
    (v) => v.labels[VOLUME_LABEL] === '1' && v.labels[MIRROR_LABEL] !== '1',
  );
}

/**
 * At startup, after `reapOrphans` has confirmed every container gone and before the first lease:
 * every drop volume of this stick is asked about (`salvage`), so a push the stick was holding (or
 * a volume it kept for want of an answer) is not lost with the process.
 */
export async function rediscoverPending(
  driver: ContainerDriver,
  client: Pick<DropClient, 'salvage'>,
  stickId: string,
  pending: PendingPushes,
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  for (const v of await dropVolumes(driver, stickId))
    await reconcileVolume(driver, client, pending, v, log);
}

/**
 * The 10-minute sweep's volumes. A volume a live drop (`dropId:epoch`) or a pending push holds
 * stays. Any other drop volume is reconciled as at startup (refused: removed). A leaked
 * self-check volume is removed, unless a self-check is in flight (it may be that check's). A
 * mirror volume no live drop holds is removed outright: it is never salvaged, and a pending push
 * never needs it. A failed removal is left for the next sweep.
 */
export async function sweepVolumes(
  driver: ContainerDriver,
  client: Pick<DropClient, 'salvage'>,
  stickId: string,
  pending: PendingPushes,
  live: ReadonlySet<string>,
  log: (line: string) => void = (line) => console.log(line),
  o: { selfCheckBusy?: () => boolean } = {},
): Promise<void> {
  const listed = await driver.listVolumesByLabel(STICK_LABEL, stickId);
  // Read after the listing: a self-check that started since may own a listed volume. One that
  // starts later creates a volume this listing doesn't hold.
  const checking = o.selfCheckBusy?.() ?? false;
  for (const v of listed) {
    if (v.labels[SELFCHECK_LABEL] === '1') {
      if (!checking) await driver.removeVolume(v.name).catch(() => {});
      continue;
    }
    const dropId = v.labels['jumpmaster.drop'] ?? '';
    if (v.labels[MIRROR_LABEL] === '1') {
      if (!live.has(`${dropId}:${v.labels['jumpmaster.epoch']}`))
        await driver.removeVolume(v.name).catch(() => {});
      continue;
    }
    if (v.labels[VOLUME_LABEL] !== '1') continue;
    if (live.has(`${dropId}:${v.labels['jumpmaster.epoch']}`)) continue;
    if (pending.get(dropId)?.volume === v.name) continue;
    await reconcileVolume(driver, client, pending, v, log);
  }
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
/**
 * The grace a stick that lost its server gives the agent container before it kills it (Ruling 14):
 * long enough to checkpoint onto the volume. The container never holds a write token, so the
 * lease running out meanwhile lets nothing reach the forge.
 */
export const LOST_SERVER_GRACE_MS = 60_000;
/** First wait before re-sending a result the server could not be reached for. */
const RESULT_RETRY_MS = 5_000;
const OLD_SERVER = 'server too old for push containers: deploy the server first';
const OLD_IMAGE = 'trooper image too old for push containers';

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
  /** The clone routes are used only for a drop whose payload asks for a provided mirror. */
  client: DropClient & CloneClient;
  driver: ContainerDriver;
  stickId: string;
  heartbeatMs?: number;
  /** Consecutive failed heartbeats before a hard kill. A kill can't reach a cut-off stick. */
  lostServerKillBeats?: number;
  image?: string;
  /**
   * The image policy and what it trusts (main builds it at startup). Without it: the allow-list
   * policy over `allowedImages`, else over `allowedImages(process.env)`.
   */
  trust?: ImageTrust;
  /** Defaults to `allowedImages(process.env)`; used only when `trust` is not given. */
  allowedImages?: Set<string>;
  /**
   * The egress proxy image; defaults to `JM_EGRESS_IMAGE`. Under the allow-list policy it is
   * allowed for the proxy only; under signed it is pulled and verified like the others.
   */
  egressImage?: string;
  /** Where image pull and verification lines go (default stdout). */
  log?: (line: string) => void;
  egressReadyMs?: number;
  /** Defaults to `JM_DROP_SUBNET_POOL`. */
  subnetPool?: string;
  /**
   * Drop networks in use, so the periodic sweep leaves them alone; a drop's clone network joins
   * it too. Unset: a set of the drop's own.
   */
  active?: Set<string>;
  /**
   * `TROOPER_IMAGE`: runs the volume's init container and a provided-mirror drop's clone
   * container (never a drop's image).
   */
  trooperImage?: string;
  /** Where a pushing drop's volume goes once its agent container is gone. */
  pending?: PendingPushes;
  /**
   * The latest verdict on `trooperImage`. Refused: a pushing or provided-mirror drop fails before
   * its volume's init container or its clone container (or anything else) starts.
   */
  baseImage?: () => BaseVerdict;
  /** First wait before re-sending a held result (doubling, capped). */
  resultRetryMs?: number;
  /**
   * The stick's images (issue #425): a container start holds the lock shared, so the image sweep
   * never runs meanwhile, and marks its recorded images used now.
   */
  images?: Pick<StickImages, 'lock' | 'used'>;
  /**
   * The stick's egress ceiling (main reads `JM_EGRESS_CEILING` once at startup): `undefined`
   * reads it from the environment, `null` means none.
   */
  ceiling?: string[] | null;
};

/** Starts containers from `refs`: never during an image sweep; each recorded image used now. */
function starting<T>(deps: RunDeps, refs: string[], start: () => Promise<T>): Promise<T> {
  const images = deps.images;
  if (!images) return start();
  return images.lock.shared(async () => {
    for (const ref of refs) images.used(ref);
    return start();
  });
}

/**
 * What becomes of a pushing drop's volume once its agent container is confirmed gone: queued for
 * the push loop, removed, or (when the answer is unknown) kept for rediscovery.
 */
type Disposition = 'push' | 'remove' | 'keep';
type VolumeFate = { decide: () => Promise<Disposition> };

/**
 * A drop's one heartbeat (issue #239): it starts when the drop is accepted, so the lease holds
 * while its images are prepared, and runs on to the end of its container. Before a container
 * exists an answer only sets the flags (`halted` then stops the preparation); once one runs, it
 * reacts through `onStop` and `onKill`.
 */
type DropBeat = {
  stale: boolean;
  cancelled: boolean;
  /** Hard-cancelled (the kill switch). */
  hard: boolean;
  /** Stopped by the lost-server rule: the epoch is fenced, as a kill used to fence it. */
  lost: boolean;
  /** Set by a running container: stop it (with a grace) or kill it. */
  onStop?: (graceMs?: number) => void;
  onKill?: () => void;
  /** Whether the drop must not go on: stale, cancelled or lost. */
  halted: () => boolean;
  /** Clears the interval; no beat goes out after it. Idempotent. */
  stop: () => void;
};

function startBeat(client: DropClient, dropId: string, epoch: number, deps: RunDeps): DropBeat {
  const lostLimit = deps.lostServerKillBeats ?? DEFAULT_LOST_SERVER_KILL_BEATS;
  let failedBeats = 0;
  let stopped = false;
  const beat: DropBeat = {
    stale: false,
    cancelled: false,
    hard: false,
    lost: false,
    halted: () => beat.stale || beat.cancelled || beat.lost,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
  const timer = setInterval(async () => {
    // After a hard kill or the lost-server stop no beat goes out: a server back inside the grace
    // must not see a live lease, and must find the drop lost (or salvage it from the push result).
    if (stopped || beat.hard || beat.lost) return;
    try {
      const r = await client.heartbeat(dropId, epoch);
      failedBeats = 0;
      // `killed` is for a pending push only; a running drop under the kill switch is hard-cancelled.
      if (r === 'ok' || r === 'killed') return;
      if (r === 'hard_cancel') {
        beat.cancelled = true;
        beat.hard = true;
        beat.onKill?.();
        return;
      }
      if (r === 'stale') beat.stale = true;
      else beat.cancelled = true;
      beat.onStop?.();
    } catch {
      // Keep going through a blip. Past the limit the lease is ending anyway: stop with a grace
      // (Ruling 14). Only a push-requested result is posted after that (held, then salvaged).
      failedBeats++;
      if (failedBeats >= lostLimit && !beat.lost) {
        beat.lost = true;
        beat.onStop?.(LOST_SERVER_GRACE_MS);
      }
    }
  }, deps.heartbeatMs ?? 15_000);
  return beat;
}

export async function runDrop(payload: DropPayload, deps: RunDeps): Promise<void> {
  // The lease lapses unless renewed: beat from acceptance on, through the image preparation.
  const beat = startBeat(deps.client, payload.dropId, payload.epoch, deps);
  // The images this drop holds from the sweep (issue #439), let go however the drop ends.
  const holds: ImageHold[] = [];
  try {
    await prepareAndRun(payload, deps, beat, holds);
  } finally {
    beat.stop();
    for (const h of holds) h.release();
  }
}

async function prepareAndRun(
  payload: DropPayload,
  deps: RunDeps,
  beat: DropBeat,
  holds: ImageHold[],
): Promise<void> {
  const { client, driver } = deps;
  const { dropId, epoch } = payload;
  const image = payload.image || deps.image || TROOPER_IMAGE;
  const trust: ImageTrust = deps.trust ?? {
    policy: 'allowlist',
    allowed: deps.allowedImages ?? allowedImages(process.env),
  };
  const log = deps.log ?? ((line: string) => console.log(line));
  const pushes = isPushingRole(payload.role);
  // Ruling 11: a server without push-v1 expects the trooper to push. Run nothing, post nothing and
  // never heartbeat, so it sees the drop lost and requeues it rather than parking the item.
  if (pushes && !client.features?.has('push-v1')) {
    beat.stop();
    log(OLD_SERVER);
    return;
  }
  // What an operator checks after a change, with no restart: the gate timeouts this drop runs with
  // and which forge token it carries, as the 8-character SHA-256 prefix Settings shows.
  const forgeToken =
    'forgeToken' in payload.credentials ? payload.credentials.forgeToken : undefined;
  log(
    JSON.stringify({
      event: 'drop-start',
      dropId,
      role: payload.role,
      gates: ('gates' in payload ? (payload.gates ?? []) : []).map((g) => ({
        name: g.name,
        timeoutMinutes: g.timeoutMinutes,
      })),
      ...(forgeToken
        ? { forgeToken: createHash('sha256').update(forgeToken).digest('hex').slice(0, 8) }
        : {}),
    }),
  );
  const services = ('services' in payload ? payload.services : undefined) ?? [];
  const egress = payload.egress;
  // The beat stops before a failure is posted. A drop the server already gave up (stale, cancelled
  // or lost) gets no result: it would be refused.
  const fail = async (reason: string) => {
    beat.stop();
    if (beat.halted()) return;
    await client.postResult(dropId, epoch, {
      status: 'failed',
      role: payload.role,
      reason,
      gates: [],
    });
  };
  // The stick's egress ceiling, before anything else: a drop outside it reads no base image and
  // verifies, pulls or creates nothing. Checked on what this stick received, so the server can't
  // widen it.
  let ceiling: string[] | null;
  let outside: string | null;
  try {
    ceiling = stickCeiling(deps.ceiling);
    outside = ceilingRefusal(egress, ceiling);
  } catch (e) {
    // An unreadable JM_EGRESS_CEILING is never read as no ceiling.
    ceiling = [];
    outside = e instanceof Error ? e.message : String(e);
  }
  if (outside) {
    log(JSON.stringify({ event: 'drop-refused', dropId, epoch, reason: outside }));
    await fail(outside);
    return;
  }
  /** A heartbeat answer (or the lost-server limit) ended the drop: prepare nothing more. */
  const halted = () => {
    if (!beat.halted()) return false;
    beat.stop();
    log(JSON.stringify({ event: 'drop-halted', dropId, epoch, ...haltReason(beat) }));
    return true;
  };
  // A provided mirror is cloned by the stick's own trooper image, whatever the drop's role.
  const provided = payload.repo.mirror === 'provided';
  const base = pushes || provided ? deps.baseImage?.() : undefined;
  if (base && !base.ok) {
    log(JSON.stringify({ event: 'drop-refused', dropId, epoch, reason: base.reason }));
    await fail(base.reason);
    return;
  }
  // A provided mirror's clone may run under egress (its plan says), so its proxy is verified too.
  const proxyImage =
    egress || provided ? (deps.egressImage ?? egressImage(process.env)) : undefined;
  // Every image this drop would create a container from: the trooper, its proxy, its services.
  const images: { ref: string; proxy?: true }[] = [
    { ref: image },
    ...(proxyImage ? [{ ref: proxyImage, proxy: true as const }] : []),
    ...services.map((s) => ({ ref: s.image })),
  ];
  // The allow-list lets the proxy image run as the proxy only (never as a trooper or service).
  const decide = (i: { ref: string; proxy?: true }) =>
    i.proxy && trust.policy === 'allowlist'
      ? Promise.resolve({ ok: true as const, via: 'allowlist' as const })
      : verifyImage(i.ref, trust);
  // First what needs no network: a tag under signed, or an image off the allow-list.
  for (const i of images) {
    if (halted()) return;
    // Under signed only the tag check is offline; verifyImage refuses a tag without cosign.
    if (trust.policy === 'signed' && digestOf(i.ref)) continue;
    const v = await decide(i);
    if (!v.ok) {
      await fail(v.reason);
      return;
    }
  }
  if (egress && services.length > MAX_EGRESS_SERVICES) {
    await fail(`egress allows at most ${MAX_EGRESS_SERVICES} services per drop`);
    return;
  }
  // Then verify (cosign asks the registry: under signed nothing is downloaded until every image
  // has verified), then pull digest references, all before any container exists.
  const unique = [...new Map(images.map((i) => [i.ref, i])).values()];
  const server = fromServer(trust);
  if (server) {
    // Server-hosted images (issue #141): each missing image comes from the server and is
    // verified offline before it loads. The registry is never asked, not even to verify.
    // Every image is held before the first fetch, until the drop ends (issue #439): a sweep a
    // load starts (this drop's or another's) never removes one found present before its
    // container is created.
    const hold = server.images?.hold();
    if (hold) {
      holds.push(hold);
      for (const i of unique) hold.add(i.ref);
    }
    for (const i of unique) {
      if (halted()) return;
      const v = await fetchFromServer(i.ref, trust, server, { hold });
      if (!v.ok) {
        if ('wait' in v) {
          // Not mirrored yet: no result and no heartbeat, so the lease lapses and the drop is
          // leased again later, by when the server may have it.
          beat.stop();
          log(JSON.stringify({ event: 'drop-waiting', dropId, epoch, reason: v.reason }));
          return;
        }
        await fail(v.reason);
        return;
      }
      if (trust.policy === 'signed')
        log(JSON.stringify({ event: 'image-verified', dropId, ref: i.ref, via: v.via }));
    }
  } else if (trust.policy === 'signed') {
    for (const i of unique) {
      if (halted()) return;
      const v = await decide(i);
      if (!v.ok) {
        await fail(v.reason);
        return;
      }
      log(JSON.stringify({ event: 'image-verified', dropId, ref: i.ref, via: v.via }));
    }
  }
  for (const i of server ? [] : unique) {
    if (halted()) return;
    try {
      await pullImage(i.ref, { driver, log });
    } catch (e) {
      await fail(e instanceof Error ? e.message : String(e));
      return;
    }
  }
  if (halted()) return;
  // Inspected once, for whichever of egress and push support this drop needs.
  let labelsOf: Promise<Record<string, string>> | undefined;
  const trooperLabels = () => {
    labelsOf ??= driver.imageLabels(image);
    return labelsOf;
  };
  if (egress) {
    // A trooper older than egress ignores payload.egress: refuse it before anything is created,
    // with a reason the operator can act on, rather than a drop that fails for want of a network.
    let refusal: string | null;
    try {
      refusal = trooperEgressRefusal(image, await trooperLabels());
    } catch (e) {
      refusal = `cannot inspect image ${image} for egress support: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (refusal) {
      await fail(refusal);
      return;
    }
  }
  if (pushes) {
    // The push container stages from this image's agent home: one without the label can't.
    let labels: Record<string, string>;
    try {
      labels = await trooperLabels();
    } catch (e) {
      await fail(`cannot inspect image ${image} for push support: ${message(e)}`);
      return;
    }
    if (labels[TROOPER_PUSH_LABEL] !== TROOPER_PUSH_VERSION) {
      await fail(OLD_IMAGE);
      return;
    }
  }
  if (provided) {
    // An agent image that can't read a provided mirror would clone with a token it never gets.
    let labels: Record<string, string>;
    try {
      labels = await trooperLabels();
    } catch (e) {
      await fail(`cannot inspect image ${image} for mirror support: ${message(e)}`);
      return;
    }
    if (labels[TROOPER_MIRROR_LABEL] !== TROOPER_MIRROR_VERSION) {
      await fail(`trooper image ${image} cannot read a provided mirror`);
      return;
    }
  }
  // The drop network and its clone network share one active set.
  const active = deps.active ?? new Set<string>();
  let mirror: string | undefined;
  if (provided) {
    if (halted()) return;
    let created: string;
    try {
      created = await createMirrorVolume(driver, { dropId, epoch, stickId: deps.stickId });
    } catch (e) {
      await fail(`mirror volume failed: ${message(e)}`);
      return;
    }
    // runClone removes the volume on every outcome but success. Its output is never posted.
    const outcome = await runClone(
      { dropId, epoch, volume: created },
      {
        client,
        driver,
        stickId: deps.stickId,
        image: deps.trooperImage ?? TROOPER_IMAGE,
        ...(proxyImage !== undefined ? { egressImage: proxyImage } : {}),
        ...(deps.egressReadyMs !== undefined ? { egressReadyMs: deps.egressReadyMs } : {}),
        ...(deps.subnetPool !== undefined ? { subnetPool: deps.subnetPool } : {}),
        ceiling,
        active,
        log,
        halted: beat.halted,
      },
    );
    if (outcome === 'stale') {
      beat.stale = true;
      halted();
      return;
    }
    if (!outcome.ok) {
      // Retry semantics for a failed clone come with the server's side (spec step 6).
      if (halted()) return;
      await fail(outcome.reason);
      return;
    }
    mirror = created;
  }
  // Each later path removes the mirror volume once the agent container is confirmed gone; the
  // repo volume's settling asks the engine the same question, so it is asked once.
  let agentRemoval: Promise<void> | undefined;
  const agentGone = () => {
    agentRemoval ??= driver.removeAndWait(agentName(dropId, epoch), REMOVE_TIMEOUT_MS);
    return agentRemoval;
  };
  try {
    await runAgent();
  } finally {
    if (mirror) await settleMirror(mirror);
  }

  async function settleMirror(volume: string): Promise<void> {
    const say = (what: string, extra: Record<string, unknown> = {}) =>
      log(JSON.stringify({ event: 'mirror', dropId, epoch, what, volume, ...extra }));
    try {
      await agentGone();
    } catch (e) {
      // Still possibly mounted by a running agent: the sweep removes it later.
      say('agent container not removed: mirror volume kept', { error: message(e) });
      return;
    }
    await driver.removeVolume(volume).catch((e: unknown) => {
      say('mirror volume not removed', { error: message(e) });
    });
  }

  async function runAgent(): Promise<void> {
    let volume: string | undefined;
    if (pushes) {
      if (halted()) return;
      try {
        volume = await prepareVolume(driver, {
          dropId,
          epoch,
          stickId: deps.stickId,
          image: deps.trooperImage ?? TROOPER_IMAGE,
        });
      } catch (e) {
        await fail(`repo volume failed: ${message(e)}`);
        return;
      }
    }
    // Until the agent's run says otherwise, the volume goes once its container is gone.
    const fate: VolumeFate = { decide: async () => 'remove' };
    const labels = {
      'jumpmaster.drop': dropId,
      'jumpmaster.epoch': String(epoch),
      [STICK_LABEL]: deps.stickId,
    };
    const network = services.length > 0 || egress ? `jm-drop-${dropId}-${epoch}` : undefined;
    let net: DropNet | undefined;
    let session: EgressSession | undefined;
    if (network) active.add(network);
    try {
      if (halted()) return;
      if (egress && network) {
        // Fail closed: no network, no proxy or no ready line means no trooper.
        try {
          const pool = deps.subnetPool ?? dropSubnetPool(process.env);
          net = await driver.createDropNetwork(network, labels, pool);
          const proxy = proxyImage ?? egressImage(process.env);
          const dropNet = net;
          session = await starting(deps, [proxy], () =>
            startEgress(
              driver,
              {
                dropId,
                epoch,
                egress,
                net: dropNet,
                image: proxy,
                labels,
                ...(deps.egressReadyMs !== undefined ? { readyMs: deps.egressReadyMs } : {}),
              },
              ceiling,
            ),
          );
        } catch (e) {
          await fail(`egress proxy failed to start: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        console.log(JSON.stringify({ event: 'egress', dropId, mode: egress.mode, proxy: 'ready' }));
      }
      if (services.length > 0) {
        if (halted()) return;
        try {
          await starting(
            deps,
            services.map((s) => s.image),
            () => driver.startServices(dropId, epoch, services, labels, net),
          );
        } catch (e) {
          await fail(`services failed: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      if (halted()) return;
      await runContainer(
        payload,
        deps,
        beat,
        image,
        labels,
        network,
        net,
        session,
        volume,
        fate,
        mirror,
      );
    } finally {
      if (session) await session.stop();
      if (network) await driver.removeServices(network, labels).catch(() => {});
      if (network) active.delete(network);
      if (volume) await settleVolume(payload, deps, volume, fate, log, agentGone);
    }
  }
}

/**
 * The end of a pushing drop's agent run. Nothing joins `PendingPushes`, and no volume is removed,
 * until `removeAndWait` has confirmed the agent container gone (Ruling 14). Only then is the
 * volume's fate decided (a salvage call included) and carried out.
 */
async function settleVolume(
  payload: DropPayload,
  deps: RunDeps,
  volume: string,
  fate: VolumeFate,
  log: (line: string) => void,
  /** `removeAndWait` on the agent container, asked once per drop. */
  agentGone: () => Promise<void>,
): Promise<void> {
  const { driver } = deps;
  const { dropId, epoch } = payload;
  const say = (what: string, extra: Record<string, unknown> = {}) =>
    log(JSON.stringify({ event: 'volume', dropId, epoch, what, ...extra }));
  try {
    await agentGone();
  } catch (e) {
    say('agent container not removed: volume kept, no push', { error: message(e) });
    return;
  }
  let fateIs: Disposition;
  try {
    fateIs = await fate.decide();
  } catch (e) {
    say('salvage unanswered: volume kept', { error: redactTokenShapes(message(e)) });
    return;
  }
  if (fateIs === 'keep') return;
  if (fateIs === 'push' && deps.pending) {
    deps.pending.add(dropId, { epoch, volume });
    say('push pending');
    return;
  }
  if (fateIs === 'push') say('no push queue: volume removed');
  await driver.removeVolume(volume).catch((e: unknown) => {
    say('volume not removed', { error: message(e) });
  });
}

const agentName = (dropId: string, epoch: number) => `jumpmaster-drop-${dropId}-${epoch}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function runContainer(
  payload: DropPayload,
  deps: RunDeps,
  beat: DropBeat,
  image: string,
  labels: Record<string, string>,
  network: string | undefined,
  net: DropNet | undefined,
  session: EgressSession | undefined,
  volume: string | undefined,
  fate: VolumeFate,
  /** The provided mirror, mounted read-only beside the repo volume. */
  mirror: string | undefined,
): Promise<void> {
  const { client, driver } = deps;
  const { dropId, epoch } = payload;
  const handle = await starting(deps, [image], () =>
    driver.start({
      image,
      payload: JSON.stringify(payload),
      name: agentName(dropId, epoch),
      labels,
      ...(network ? { network } : {}),
      ...(net ? { egress: net } : {}),
      ...(payload.limits ? { limits: payload.limits } : {}),
      ...(volume ? { mount: { volume, target: REPO_MOUNT } } : {}),
      ...(mirror ? { mirror: { volume: mirror, target: MIRROR_MOUNT } } : {}),
    }),
  );

  let stopping: Promise<void> | undefined;
  let killing: Promise<void> | undefined;
  const stop = (graceMs = STOP_GRACE_MS) => {
    stopping ??= handle.stop(graceMs).catch(() => {});
    return stopping;
  };

  let pending: TrooperEvent[] = [];
  let pendingBytes = 0;
  let flushing = Promise.resolve();
  const queue = (ev: TrooperEvent, bytes: number) => {
    const solo = bytes > SOLO_EVENT_BYTES;
    if (pending.length > 0 && (solo || pendingBytes + bytes > MAX_BATCH_BYTES)) void flush();
    pending.push(ev);
    pendingBytes += bytes;
    if (solo || pending.length >= MAX_BATCH) void flush();
  };
  /** An event from the trooper, whole or assembled from parts. */
  const relay = (ev: TrooperEvent) => {
    // Egress events come from the stick's own reading of the proxy, never the trooper.
    if (ev.kind === 'egress') return;
    queue(ev, Buffer.byteLength(JSON.stringify(ev)));
  };
  const flush = () => {
    if (pending.length === 0) return flushing;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    flushing = flushing.then(async () => {
      try {
        if ((await client.postEvents(dropId, epoch, batch)) === 'stale') {
          beat.stale = true;
          void stop();
        }
      } catch {
        // events are best-effort; the result is what matters
      }
    });
    return flushing;
  };

  const hardKill = () => {
    killing ??= handle.kill().catch(() => {});
    return killing;
  };
  // The drop's one heartbeat, running since it was accepted, now acts on the container.
  beat.onStop = (graceMs) => void stop(graceMs);
  beat.onKill = () => void hardKill();
  // An answer that came between the last preparation check and the start.
  if (beat.hard) void hardKill();
  else if (beat.lost) void stop(LOST_SERVER_GRACE_MS);
  else if (beat.halted()) void stop();
  const flusher = setInterval(() => void flush(), FLUSH_MS);

  const artifacts = new ArtifactAssembler();
  const parts = new EventAssembler();
  const uploads: Promise<unknown>[] = [];
  let result: DropResult | undefined;
  let postedReal = false;
  try {
    for await (const line of handle.logs()) {
      if (line.startsWith(ARTIFACT_PREFIX)) {
        const done = artifacts.add(line.slice(ARTIFACT_PREFIX.length));
        if (done) uploads.push(client.postArtifact(dropId, epoch, done).catch(() => 'stale'));
      } else if (line.startsWith(EVENT_PREFIX)) {
        const ev = TrooperEventSchema.safeParse(safeJson(line.slice(EVENT_PREFIX.length)));
        // A malformed event line is dropped.
        if (ev.success) relay(ev.data);
      } else if (line.startsWith(EVENT_PART_PREFIX)) {
        for (const ev of parts.add(line.slice(EVENT_PART_PREFIX.length))) relay(ev);
      } else if (line.startsWith(RESULT_PREFIX)) {
        try {
          result = DropResultSchema.parse(JSON.parse(line.slice(RESULT_PREFIX.length)));
        } catch {
          // malformed result: treated as missing
        }
      }
    }
    // The trooper's output has ended: an event still missing parts never will be complete.
    for (const ev of parts.finish()) relay(ev);
    const { exitCode } = await handle.wait();
    // The proxy logs each tunnel as it closes: stop it, then report the drop's egress.
    if (session)
      for (const ev of await session.finish()) queue(ev, Buffer.byteLength(JSON.stringify(ev)));
    await flush();
    // Before the result: the server checks for these when it reads the verdict.
    await Promise.allSettled(uploads);
    await stopping;
    // The server no longer owns this epoch (stale) or already cancelled it: it would 409 a result.
    // A hard cancel (the kill switch) still asks to save the killed agent's work.
    // A stale drop (a 409: the lease went past the server's grace) was stopped gracefully and may
    // have checkpointed onto the volume: the server salvages it while the item is still reclaimable
    // and refuses otherwise, and only then is the volume removed (Ruling 14 holds either way).
    if ((beat.hard || beat.stale) && volume) fate.decide = () => salvaged(client, dropId, epoch);
    if (beat.stale || beat.cancelled) return;
    if (beat.lost && !(result?.push && volume)) {
      // Fenced like the old kill: nothing posted, so a server that answers again sees the drop
      // lost. Its answer about the volume is unknown, so it stays for rediscovery to salvage.
      fate.decide = async () => 'keep';
      return;
    }
    if (result) {
      postedReal = true;
      if (result.push && volume) {
        const ack = await holdResult(client, dropId, epoch, result, deps.resultRetryMs);
        // Accepted: the push loop takes the volume. Refused 409 (the drop went lost while the
        // result was held): ask to salvage it before anything is removed (Ruling 14). Given up on
        // a lasting server error: heartbeats stop with this run, the lease lapses, and the volume
        // stays for the sweep to salvage.
        fate.decide =
          ack === 'ok'
            ? async () => 'push'
            : ack === 'gave_up'
              ? async () => 'keep'
              : () => salvaged(client, dropId, epoch);
      } else {
        await client.postResult(dropId, epoch, result);
      }
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
    if (beat.lost && volume) fate.decide = async () => 'keep';
    if (!beat.stale && !beat.cancelled && !beat.lost) {
      const reason = `stick runner error: ${e instanceof Error ? e.message : String(e)}`;
      await client
        .postResult(dropId, epoch, { status: 'failed', role: payload.role, reason, gates: [] })
        .catch(() => {});
    }
  } finally {
    beat.stop();
    clearInterval(flusher);
  }
}

/** Why the preparation stopped, for the `drop-halted` line. */
function haltReason(beat: DropBeat): { reason: string } {
  if (beat.lost) return { reason: 'server unreachable' };
  if (beat.stale) return { reason: 'stale' };
  return { reason: beat.hard ? 'hard_cancel' : 'cancel' };
}

/** `push` when the server accepts a salvage of this drop's volume, else `remove`. */
async function salvaged(client: DropClient, dropId: string, epoch: number): Promise<Disposition> {
  return (await client.salvage(dropId, epoch)) === 'ok' ? 'push' : 'remove';
}

/**
 * Consecutive 5xx answers after which a held push result is given up: a server that answers but
 * keeps failing (say, a drop zone it no longer knows) would otherwise hold the item for ever while
 * heartbeats renew its lease. With the result backoff that is about 15 minutes.
 */
export const HELD_RESULT_MAX_5XX = 8;

/**
 * Posts a push-requested result, re-sending it from memory while the server can't be reached (a
 * network error, retried for as long as it lasts) or answers with a 5xx (given up after
 * HELD_RESULT_MAX_5XX in a row: `gave_up`). Any other refusal (a 422 push request) is thrown.
 */
async function holdResult(
  client: DropClient,
  dropId: string,
  epoch: number,
  result: DropResult,
  firstMs = RESULT_RETRY_MS,
): Promise<Ack | 'gave_up'> {
  let serverErrors = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.postResult(dropId, epoch, result);
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      if (typeof status === 'number' && status < 500) throw e;
      if (typeof status === 'number') {
        if (++serverErrors >= HELD_RESULT_MAX_5XX) return 'gave_up';
      } else serverErrors = 0;
      const ms = Math.min(PUSH_BACKOFF_MAX_MS, firstMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

const MAX_STDERR_REASON = 500;
/** Stack frames and the lines Node prints after a crash: they say nothing about its cause. */
const NODE_FOOTER = /^(at |Node\.js v\d|\(Use `node --trace-)/;
/**
 * zod rejecting the payload's `role` discriminator (v3 and v4 wordings): as the trooper's one-line
 * `payload rejected: role: …`, or as a raw ZodError whose issue has the path ["role"].
 */
const ROLE_REJECTED = [
  /payload rejected: role: Invalid discriminator value/,
  /"(?:note|message)":\s*"(?:No matching discriminator|Invalid discriminator value)[^"]*"[^\]}]*"path":\s*\[\s*"role"\s*\]/,
  /"path":\s*\[\s*"role"\s*\][^}]*"(?:note|message)":\s*"(?:No matching discriminator|Invalid discriminator value)/,
];

/** Names the exit and, when the trooper said why on stderr, its last line with every credential scrubbed. */
function noResultReason(exitCode: number, stderr: string, payload: DropPayload): string {
  const base = `trooper exited ${exitCode} without result`;
  // A trooper built before this role existed rejects the payload's role. Its own words (zod's
  // discriminator error, on one line or as raw JSON) don't say what to do; this does.
  if (ROLE_REJECTED.some((re) => re.test(stderr)))
    return `${base}: the zone's image ${payload.image} is older than the ${payload.role} role (its trooper rejected the payload's role); rebuild the zone image on the current trooper (FROM the release's preset), or use the release's preset image`;
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !NODE_FOOTER.test(l))
    .at(-1);
  if (!last) return base;
  return `${base}: ${redact(last, payloadSecrets(payload)).slice(0, MAX_STDERR_REASON)}`;
}
