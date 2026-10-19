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
const FLUSH_MS = 1000;

export async function runDrop(
  payload: DropPayload,
  deps: { client: DropClient; driver: ContainerDriver; heartbeatMs?: number; image?: string },
): Promise<void> {
  const { client, driver } = deps;
  const { dropId, epoch } = payload;
  const handle = await driver.start({
    image: deps.image ?? TROOPER_IMAGE,
    payload: JSON.stringify(payload),
    name: `jumpmaster-drop-${dropId}-${epoch}`,
    labels: { 'jumpmaster.drop': dropId, 'jumpmaster.epoch': String(epoch) },
  });

  let stale = false;
  let cancelled = false;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= handle.stop(STOP_GRACE_MS).catch(() => {});
    return stopping;
  };

  let pending: TrooperEvent[] = [];
  let flushing = Promise.resolve();
  const flush = () => {
    if (pending.length === 0) return flushing;
    const batch = pending;
    pending = [];
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
  try {
    for await (const line of handle.logs()) {
      if (line.startsWith(EVENT_PREFIX)) {
        try {
          pending.push(TrooperEventSchema.parse(JSON.parse(line.slice(EVENT_PREFIX.length))));
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
    await client.postResult(
      dropId,
      epoch,
      result ?? {
        status: 'failed',
        reason: `trooper exited ${exitCode} without result`,
        gates: [],
      },
    );
  } catch (e) {
    await stop();
    if (!stale && !cancelled) {
      const reason = `stick runner error: ${e instanceof Error ? e.message : String(e)}`;
      await client
        .postResult(dropId, epoch, { status: 'failed', reason, gates: [] })
        .catch(() => {});
    }
  } finally {
    clearInterval(hb);
    clearInterval(flusher);
  }
}
