// Pulling images a drop needs. Only digest references are pulled: the registry is content-
// addressed, so what is pulled is exactly what is verified and then created. A tag is never
// pulled (the allow-list policy keeps M3's behaviour: a missing tag fails at create).
import type { ContainerDriver } from './driver.js';
import { digestOf } from './verify.js';

export const PULL_TIMEOUT_MS = 10 * 60_000;
export const PULL_PROGRESS_MS = 10_000;

export type PullDeps = {
  driver: Pick<ContainerDriver, 'imageExists' | 'pullImage'>;
  timeoutMs?: number;
  progressMs?: number;
  log?: (line: string) => void;
  /** Milliseconds, for the progress throttle. */
  now?: () => number;
};

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]?.trim().slice(0, 300) ?? '';

/**
 * Pulls `ref` by digest when the engine doesn't have it, within the timeout, logging progress at
 * most every 10 seconds. Throws `image pull failed: <ref>: <first line>`.
 */
export async function pullImage(ref: string, deps: PullDeps): Promise<void> {
  if (!digestOf(ref)) return;
  if (await deps.driver.imageExists(ref)) return;
  const timeoutMs = deps.timeoutMs ?? PULL_TIMEOUT_MS;
  const every = deps.progressMs ?? PULL_PROGRESS_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  let last = Number.NEGATIVE_INFINITY;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      // Settle as a timeout first; aborting then makes the pull itself reject.
      reject(new Error(`timed out after ${timeoutMs / 1000}s`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    await Promise.race([
      deps.driver.pullImage(
        ref,
        (e) => {
          const t = now();
          if (t - last < every) return;
          last = t;
          const status = typeof e.status === 'string' ? e.status.slice(0, 100) : 'pulling';
          log(JSON.stringify({ event: 'image-pull', ref, status }));
        },
        controller.signal,
      ),
      timedOut,
    ]);
  } catch (e) {
    controller.abort();
    throw new Error(`image pull failed: ${ref}: ${firstLine(e)}`);
  } finally {
    clearTimeout(timer);
  }
  log(JSON.stringify({ event: 'image-pull', ref, status: 'done' }));
}
