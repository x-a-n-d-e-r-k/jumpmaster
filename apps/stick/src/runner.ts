import {
  type DropPayload,
  type DropResult,
  DropResultSchema,
  EVENT_PREFIX,
  RESULT_PREFIX,
  type TrooperEvent,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { DropClient } from './client.js';
import type { ContainerDriver } from './driver.js';

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
  return removed;
}

export async function runDrop(
  payload: DropPayload,
  deps: {
    client: DropClient;
    driver: ContainerDriver;
    stickId: string;
    heartbeatMs?: number;
    image?: string;
    /** Defaults to `allowedImages(process.env)`. */
    allowedImages?: Set<string>;
  },
): Promise<void> {
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
  const handle = await driver.start({
    image,
    payload: JSON.stringify(payload),
    name: `jumpmaster-drop-${dropId}-${epoch}`,
    labels: {
      'jumpmaster.drop': dropId,
      'jumpmaster.epoch': String(epoch),
      [STICK_LABEL]: deps.stickId,
    },
  });

  let stale = false;
  let cancelled = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= handle.stop(STOP_GRACE_MS).catch(() => {});
    return stopping;
  };

  let pending: TrooperEvent[] = [];
  let pendingBytes = 0;
  let flushing = Promise.resolve();
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

  const hb = setInterval(async () => {
    try {
      const r = await client.heartbeat(dropId, epoch);
      if (r === 'ok') return;
      if (r === 'stale') stale = true;
      else cancelled = true;
      void stop();
    } catch {
      // transient network error: keep going, the next beat retries
    }
  }, deps.heartbeatMs ?? 15_000);
  const flusher = setInterval(() => void flush(), FLUSH_MS);

  let result: DropResult | undefined;
  let postedReal = false;
  try {
    for await (const line of handle.logs()) {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          const ev = TrooperEventSchema.parse(JSON.parse(line.slice(EVENT_PREFIX.length)));
          const bytes = Buffer.byteLength(line);
          if (pending.length > 0 && pendingBytes + bytes > MAX_BATCH_BYTES) void flush();
          pending.push(ev);
          pendingBytes += bytes;
          if (pending.length >= MAX_BATCH) void flush();
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
    await flush();
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
        reason: `trooper exited ${exitCode} without result`,
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
