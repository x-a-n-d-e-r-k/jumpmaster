import { describe, expect, test } from 'vitest';
import { PULL_PROGRESS_MS, PULL_TIMEOUT_MS, pullImage } from './pull.js';

const REF = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;

function fakeDriver(o: {
  exists?: boolean;
  events?: Record<string, unknown>[];
  error?: Error;
  hang?: boolean;
}) {
  const calls: string[] = [];
  return {
    calls,
    driver: {
      async imageExists(ref: string) {
        calls.push(`exists ${ref}`);
        return o.exists ?? false;
      },
      async pullImage(
        ref: string,
        onProgress: (e: Record<string, unknown>) => void,
        signal: AbortSignal,
      ) {
        calls.push(`pull ${ref}`);
        for (const e of o.events ?? []) onProgress(e);
        if (o.hang)
          await new Promise<void>((_r, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        if (o.error) throw o.error;
      },
    },
  };
}

describe('pullImage', () => {
  test('an image already on the engine is not pulled', async () => {
    const d = fakeDriver({ exists: true });
    await pullImage(REF, { driver: d.driver });
    expect(d.calls).toEqual([`exists ${REF}`]);
  });

  test('a missing digest image is pulled by its digest reference', async () => {
    const d = fakeDriver({});
    await pullImage(REF, { driver: d.driver });
    expect(d.calls).toEqual([`exists ${REF}`, `pull ${REF}`]);
  });

  test('a tag is never pulled: the allow-list policy behaves as in M3', async () => {
    const d = fakeDriver({});
    await pullImage('jumpmaster-trooper:dev', { driver: d.driver });
    expect(d.calls).toEqual([]);
  });

  test('a failure names the ref and only the first line of the error', async () => {
    const d = fakeDriver({ error: new Error('manifest unknown\nsecond line with detail') });
    await expect(pullImage(REF, { driver: d.driver })).rejects.toThrow(
      new Error(`image pull failed: ${REF}: manifest unknown`),
    );
  });

  test('a pull that outlasts the timeout is aborted and fails', async () => {
    expect(PULL_TIMEOUT_MS).toBe(10 * 60_000);
    const d = fakeDriver({ hang: true });
    await expect(pullImage(REF, { driver: d.driver, timeoutMs: 30 })).rejects.toThrow(
      `image pull failed: ${REF}: timed out after 0.03s`,
    );
  });

  test('progress is logged at most every 10 seconds', async () => {
    expect(PULL_PROGRESS_MS).toBe(10_000);
    let t = 0;
    const events = [0, 1000, 9999, 10_000, 15_000, 20_001].map((at) => ({
      at,
      status: 'Downloading',
    }));
    const log: string[] = [];
    const d = fakeDriver({ events });
    await pullImage(REF, {
      driver: {
        ...d.driver,
        async pullImage(ref, onProgress, signal) {
          for (const e of events) {
            t = e.at;
            onProgress(e);
          }
          return d.driver.pullImage(ref, () => {}, signal);
        },
      },
      now: () => t,
      log: (l) => log.push(l),
    });
    const lines = log.map((l) => JSON.parse(l));
    expect(
      lines.filter((l) => l.event === 'image-pull' && l.status === 'Downloading'),
    ).toHaveLength(3);
    expect(lines.at(-1)).toEqual({ event: 'image-pull', ref: REF, status: 'done' });
  });
});
