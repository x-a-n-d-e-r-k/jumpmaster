import {
  ceilingRefusal,
  gitlabBasicAuth,
  type PushGrant,
  type PushPayload,
  PushPayloadSchema,
  type PushResult,
  PushResultSchema,
  READY_LINE,
  RESULT_PREFIX,
  redact,
  redactTokenShapes,
} from '@jumpmaster/protocol';
import type { PlanReply, PushClient } from './client.js';
import type { ContainerDriver, ContainerHandle, DropNet } from './driver.js';
import { type EgressSession, egressImage, startEgress, stickCeiling } from './egress.js';
import { dropSubnetPool } from './subnets.js';
import { REMOVE_TIMEOUT_MS, REPO_MOUNT } from './volumes.js';

/** How long a push container may take to stage before it prints `READY_LINE`, and to push after. */
export const READY_TIMEOUT_MS = 10 * 60_000;
/** The longest wait between two attempts at one pending push. */
export const PUSH_BACKOFF_MAX_MS = 5 * 60_000;
const PUSH_BACKOFF_BASE_MS = 15_000;
/** How often the push loop looks for due entries. */
export const PUSH_LOOP_MS = 15_000;
/** Push containers one stick runs at once. They hold no lease slot. */
export const MAX_CONCURRENT_PUSHES = 2;
/** At this many pending pushes the stick leases with `noPush`: no pushing role until one clears. */
export const MAX_PENDING_PUSHES = 8;
/** Push containers that exit without a result line before the push is given up as failed. */
export const NO_RESULT_RETRIES = 3;
/** Every trooper image from the push-container release carries it; older ones can't push. */
export const TROOPER_PUSH_LABEL = 'org.jumpmaster.trooper.push';
export const TROOPER_PUSH_VERSION = '1';
/**
 * Every trooper image from the provided-mirror release carries it: its agent roles read a drop's
 * read-only mirror at `/jm/mirror` and make no remote call. The runner refuses a provided-mirror
 * drop whose image lacks it.
 */
export const TROOPER_MIRROR_LABEL = 'org.jumpmaster.trooper.mirror';
export const TROOPER_MIRROR_VERSION = '1';
const STOP_GRACE_MS = 30_000;
const NO_RESULT_REASON = 'push container exited without a result';

/** A drop whose work waits on its volume to be pushed. */
export type PushEntry = {
  dropId: string;
  epoch: number;
  volume: string;
  attempts: number;
  /** When it is next due (ms since the epoch). */
  nextAt: number;
  /** Attempts whose push container exited without a result line. */
  noResult: number;
};

export type PushOutcome = 'done' | 'retry' | 'killed' | 'cancelled';

/**
 * What the stick redacts from a push container's output once it holds the grant: the token and the
 * grant's secrets, and for a GitLab grant the base64 of `oauth2:<token>` the trooper sends to it.
 */
export function grantSecrets(grant: PushGrant): string[] {
  return [grant.token, ...grant.secrets, ...(grant.forge ? [gitlabBasicAuth(grant.token)] : [])];
}

/** `min(PUSH_BACKOFF_MAX_MS, 15 s · 2^attempts)`. */
export function backoffMs(attempts: number): number {
  return Math.min(PUSH_BACKOFF_MAX_MS, PUSH_BACKOFF_BASE_MS * 2 ** attempts);
}

const pushNetwork = (dropId: string, epoch: number) => `jm-push-${dropId}-${epoch}`;
export const pushContainer = (dropId: string, epoch: number) =>
  `jumpmaster-push-${dropId}-${epoch}`;

/**
 * The pending pushes this stick holds, by drop. Only a path that has confirmed the agent
 * container gone (`removeAndWait`) may `add` (Ruling 14); the volume then belongs to the entry.
 */
export class PendingPushes {
  private readonly entries = new Map<string, PushEntry>();

  size(): number {
    return this.entries.size;
  }

  get(dropId: string): PushEntry | undefined {
    return this.entries.get(dropId);
  }

  /** Due at once. A drop already held is replaced (a newer epoch supersedes it). */
  add(dropId: string, o: { epoch: number; volume: string }, now = Date.now()): void {
    this.entries.set(dropId, {
      dropId,
      epoch: o.epoch,
      volume: o.volume,
      attempts: 0,
      nextAt: now,
      noResult: 0,
    });
  }

  /** With `epoch`, only that epoch's entry: an older attempt never removes a newer one. */
  remove(dropId: string, epoch?: number): void {
    const e = this.entries.get(dropId);
    if (!e || (epoch !== undefined && e.epoch !== epoch)) return;
    this.entries.delete(dropId);
  }

  /** Entries whose time has come, oldest due first. */
  due(now: number): PushEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt);
  }

  /** Puts an entry off by its backoff, then counts the attempt. */
  backoff(dropId: string, now: number, epoch?: number): void {
    const e = this.entries.get(dropId);
    if (!e || (epoch !== undefined && e.epoch !== epoch)) return;
    e.nextAt = now + backoffMs(e.attempts);
    e.attempts++;
  }

  /** The `jm-push-*` networks live entries may hold, for the sweep's active set. */
  networks(): Set<string> {
    return new Set([...this.entries.values()].map((e) => pushNetwork(e.dropId, e.epoch)));
  }
}

export type PushDeps = {
  client: PushClient;
  driver: ContainerDriver;
  stickId: string;
  /** `TROOPER_IMAGE`: the stick's own verified trooper image, never a drop's image. */
  image: string;
  pending: PendingPushes;
  log?: (line: string) => void;
  heartbeatMs?: number;
  readyTimeoutMs?: number;
  /** The egress proxy image; defaults to `JM_EGRESS_IMAGE`. */
  egressImage?: string;
  egressReadyMs?: number;
  /** Defaults to `JM_DROP_SUBNET_POOL`. */
  subnetPool?: string;
  /**
   * The stick's egress ceiling (main reads `JM_EGRESS_CEILING` once at startup): `undefined`
   * reads it from the environment, `null` means none.
   */
  ceiling?: string[] | null;
};

type Line = { line: string } | 'end' | 'timeout' | 'aborted';

/**
 * One attempt at a pending push: plan, push container, ready, grant, result. The grant is written
 * only to the container this call started, and only after it printed `READY_LINE`. Every path
 * removes that container before it returns; the volume goes only when the push is over.
 */
export async function pushOnce(entry: PushEntry, deps: PushDeps): Promise<PushOutcome> {
  const { client, driver, pending } = deps;
  const { dropId, epoch, volume } = entry;
  const log = deps.log ?? ((line: string) => console.log(line));
  const say = (what: string, extra: Record<string, unknown> = {}) =>
    log(JSON.stringify({ event: 'push', dropId, epoch, what, ...extra }));
  /** The push is over on the server: the volume and the entry go. */
  let finished = false;

  let plan: PlanReply;
  try {
    plan = await client.pushPlan(dropId, epoch);
  } catch (e) {
    say('plan failed', { error: redactTokenShapes(message(e)) });
    return 'retry';
  }
  if (plan === 'stale') {
    say('stale');
    await removeVolume(driver, volume, say);
    pending.remove(dropId, epoch);
    return 'done';
  }
  if ('refused' in plan) {
    // Held back (the kill switch, an observing zone): nothing starts, the volume stays, and the
    // entry backs off until the server lets pushes through again.
    say('plan refused', {
      refused: redactTokenShapes(plan.refused),
      retryable: plan.retryable,
    });
    return 'retry';
  }
  // The stick's egress ceiling, as for a drop. A plan's hosts are within the base today, so only
  // its mode refuses it: the push waits, volume kept, until its zone is in enforce or the ceiling
  // is removed. A pushed result is never thrown away over a setting.
  let ceiling: string[] | null;
  let outside: string | null;
  try {
    ceiling = stickCeiling(deps.ceiling);
    outside = ceilingRefusal(plan.egress, ceiling);
  } catch (e) {
    ceiling = [];
    outside = message(e);
  }
  if (outside) {
    say('plan refused by the egress ceiling', { reason: outside });
    return 'retry';
  }

  const labels = {
    'jumpmaster.drop': dropId,
    'jumpmaster.epoch': String(epoch),
    'jumpmaster.stick': deps.stickId,
  };
  const name = pushContainer(dropId, epoch);
  const network = pushNetwork(dropId, epoch);
  let net: DropNet | undefined;
  let session: EgressSession | undefined;
  let handle: ContainerHandle | undefined;
  let secrets: string[] = [];
  try {
    if (plan.egress) {
      net = await driver.createDropNetwork(
        network,
        labels,
        deps.subnetPool ?? dropSubnetPool(process.env),
      );
      session = await startEgress(
        driver,
        {
          dropId,
          epoch,
          egress: plan.egress,
          net,
          image: deps.egressImage ?? egressImage(process.env),
          labels,
          ...(deps.egressReadyMs !== undefined ? { readyMs: deps.egressReadyMs } : {}),
        },
        ceiling,
      );
    }
    const payload: PushPayload = PushPayloadSchema.parse({
      protocol: 1,
      role: 'push',
      dropId,
      epoch,
      branch: plan.branch,
      salvage: plan.salvage,
      ...(net ? { egress: true } : {}),
    });
    handle = await driver.start({
      image: deps.image,
      payload: JSON.stringify(payload),
      name,
      labels,
      ...(net ? { network, egress: net } : {}),
      ...(plan.limits ? { limits: plan.limits } : {}),
      mount: { volume, target: REPO_MOUNT },
      holdStdin: true,
    });
    const run = await drive(handle, entry, deps, (s) => {
      secrets = s;
    });
    const scrub = (text: string) => redact(text, secrets);
    if (run === 'killed') {
      say('killed: volume kept');
      return 'killed';
    }
    if (run === 'cancelled' || run === 'stale') {
      say(run);
      finished = true;
      return run === 'cancelled' ? 'cancelled' : 'done';
    }
    if (run === 'retry') return 'retry';

    let result: PushResult;
    if (typeof run === 'object' && 'refused' in run) {
      // Server strings, safe to log; scrubbed anyway.
      say('grant refused', { refused: redactTokenShapes(run.refused), retryable: run.retryable });
      handle.endStdin();
      await handle.stop(STOP_GRACE_MS).catch(() => {});
      if (run.retryable) return 'retry';
      // Final (role, repo, kind, branch): the server applies Ruling 7 to this failure.
      result = { status: 'failed', reason: run.refused, retryable: false };
    } else if (run === 'no-result') {
      entry.noResult++;
      say('no result', { count: entry.noResult });
      if (entry.noResult < NO_RESULT_RETRIES) return 'retry';
      result = { status: 'failed', reason: NO_RESULT_REASON, retryable: false };
    } else {
      result = run.result;
    }
    const ack = await client.postPushResult(dropId, epoch, result);
    say('result', {
      status: result.status,
      ...('reason' in result ? { reason: scrub(result.reason) } : {}),
      ack,
    });
    if (ack === 'stale') {
      finished = true;
      return 'done';
    }
    if (result.status === 'failed' && result.retryable) return 'retry';
    finished = true;
    return 'done';
  } catch (e) {
    say('attempt failed', { error: redact(message(e), secrets) });
    return 'retry';
  } finally {
    if (handle) {
      handle.endStdin();
      await handle.stop(STOP_GRACE_MS).catch(() => {});
    }
    let gone = true;
    await driver.removeAndWait(name, REMOVE_TIMEOUT_MS).catch((e: unknown) => {
      gone = false;
      say('push container not removed', { error: message(e) });
    });
    if (session) await session.stop().catch(() => {});
    if (net) await driver.removeServices(network, labels).catch(() => {});
    if (finished) {
      // A container still holding the volume makes this fail; the sweep finds the volume later.
      if (gone) await removeVolume(driver, volume, say);
      pending.remove(dropId, epoch);
    }
  }
}

type Run =
  | { result: PushResult }
  | { refused: string; retryable: boolean }
  | 'no-result'
  | 'retry'
  | 'killed'
  | 'cancelled'
  | 'stale';

/** Reads the container through ready, the grant and its result, under its heartbeat. */
async function drive(
  handle: ContainerHandle,
  entry: PushEntry,
  deps: PushDeps,
  onSecrets: (s: string[]) => void,
): Promise<Run> {
  const { client } = deps;
  const { dropId, epoch } = entry;
  let abort: 'killed' | 'cancelled' | 'stale' | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<'aborted'>((r) => {
    onAbort = () => r('aborted');
  });
  const stopFor = (why: 'killed' | 'cancelled' | 'stale', hard: boolean) => {
    if (abort) return;
    abort = why;
    onAbort();
    handle.endStdin();
    void (hard ? handle.kill() : handle.stop(STOP_GRACE_MS)).catch(() => {});
  };
  const hb = setInterval(async () => {
    if (abort) return;
    try {
      const beat = await client.heartbeat(dropId, epoch);
      // The kill switch: killed at once (no grace), so nothing reaches GitHub; the volume stays.
      if (beat === 'killed') stopFor('killed', true);
      else if (beat === 'cancel') stopFor('cancelled', false);
      else if (beat === 'hard_cancel') stopFor('cancelled', true);
      else if (beat === 'stale') stopFor('stale', false);
    } catch {
      // The push needs the server for its grant anyway; a blip changes nothing here.
    }
  }, deps.heartbeatMs ?? 15_000);

  const it = handle.logs()[Symbol.asyncIterator]();
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  /** The next line that matters (ready or a result), the end of the logs, a timeout or an abort. */
  const next = async (wantReady: boolean, deadline: number): Promise<Line> => {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      let timer: NodeJS.Timeout | undefined;
      const r = await Promise.race([
        it.next(),
        aborted,
        new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), left);
        }),
      ]);
      clearTimeout(timer);
      if (r === 'aborted' || r === 'timeout') return r;
      if (r.done) return 'end';
      if ((wantReady && r.value === READY_LINE) || r.value.startsWith(RESULT_PREFIX)) {
        return { line: r.value };
      }
    }
  };
  const resultOf = (line: string): PushResult | undefined => {
    try {
      return PushResultSchema.parse(JSON.parse(line.slice(RESULT_PREFIX.length)));
    } catch {
      return undefined;
    }
  };
  /** After the logs ended: the exit, unless an abort explains it. */
  const ended = async (): Promise<Run> => {
    await handle.wait();
    return abort ?? 'no-result';
  };

  try {
    const first = await next(true, Date.now() + timeoutMs);
    if (first === 'aborted') return abort ?? 'retry';
    if (first === 'timeout') return 'retry';
    if (first === 'end') return await ended();
    if (first.line !== READY_LINE) {
      // An exit before ready with a result line: that result is the attempt's.
      const r = resultOf(first.line);
      return r ? { result: r } : 'no-result';
    }

    const reply = await Promise.race([client.pushGrant(dropId, epoch), aborted]);
    if (reply === 'aborted') return abort ?? 'retry';
    if ('stale' in reply) return 'stale';
    if ('refused' in reply) {
      // The grant never reaches this container; pushOnce stops it.
      return { refused: reply.refused, retryable: reply.retryable };
    }
    if (abort) return abort;
    const { grant } = reply;
    onSecrets(grantSecrets(grant));
    // Only this call's own container, which has just printed ready, ever gets the grant.
    await handle.writeLine(JSON.stringify(grant));
    handle.endStdin();

    const last = await next(false, Date.now() + timeoutMs);
    if (last === 'aborted') return abort ?? 'retry';
    if (last === 'timeout') return 'retry';
    if (last === 'end') return await ended();
    const r = resultOf(last.line);
    return r ? { result: r } : 'no-result';
  } finally {
    clearInterval(hb);
  }
}

async function removeVolume(
  driver: ContainerDriver,
  volume: string,
  say: (what: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  await driver.removeVolume(volume).catch((e: unknown) => {
    say('volume not removed', { volume, error: message(e) });
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Runs due entries, at most `max` at a time, never the same drop twice at once. It holds no lease
 * slot (Ruling 15). `tick` resolves once the runs it started have finished.
 */
export function createPushLoop(
  pending: PendingPushes,
  run: (entry: PushEntry) => Promise<PushOutcome>,
  o: {
    max?: number;
    now?: () => number;
    /**
     * Whether push containers may start: false while the base image is refused, so no push runs
     * from an unverified image. Entries (and their volumes) stay queued until it verifies.
     */
    ready?: () => boolean;
  } = {},
) {
  const max = o.max ?? MAX_CONCURRENT_PUSHES;
  const now = o.now ?? Date.now;
  const live = new Set<string>();
  return {
    running: () => live.size,
    tick(): Promise<void> {
      if (o.ready && !o.ready()) return Promise.resolve();
      const started: Promise<void>[] = [];
      for (const entry of pending.due(now())) {
        if (live.size >= max) break;
        if (live.has(entry.dropId)) continue;
        live.add(entry.dropId);
        started.push(
          run(entry)
            .catch((): PushOutcome => 'retry')
            .then((outcome) => {
              if (outcome === 'done' || outcome === 'cancelled') {
                pending.remove(entry.dropId, entry.epoch);
              } else pending.backoff(entry.dropId, now(), entry.epoch);
            })
            .finally(() => live.delete(entry.dropId)),
        );
      }
      return Promise.all(started).then(() => {});
    },
  };
}
