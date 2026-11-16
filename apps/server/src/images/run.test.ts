import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ScrubSet } from '../forge/scrub-set.js';
import { IMAGE_LOCK_PATH } from '../presets.js';
import { type FakeRegistry, startFakeRegistry } from '../test/fake-registry.js';
import { imageLockPath, startImageMirror } from './run.js';

let fake: FakeRegistry | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const base = (dir: string, logs: string[]) => ({
  dataDir: dir,
  scheme: () => 'http' as const,
  scrub: new ScrubSet(),
  log: (l: string) => logs.push(l),
  sleep: async () => {},
  watch: false as const,
});

describe('running the mirror from the lock file (issue #140)', () => {
  test('the lock is the server image one, or JM_IMAGES_LOCK', () => {
    expect(imageLockPath({})).toBe(IMAGE_LOCK_PATH);
    expect(imageLockPath({ JM_IMAGES_LOCK: '/srv/lock.json' })).toBe('/srv/lock.json');
  });

  test('starts in the background from the lock, and follows a changed lock', async () => {
    fake = await startFakeRegistry();
    const a = fake.addImage('jumpmaster-trooper');
    const b = fake.addImage('jumpmaster-trooper');
    const dir = mkdtempSync(join(tmpdir(), 'jm-run-'));
    const lock = join(dir, 'images.lock.json');
    const write = (d: string) =>
      writeFileSync(
        lock,
        JSON.stringify({ registry: fake?.registry, images: { 'jumpmaster-trooper': d } }),
      );
    write(a.digest);
    const logs: string[] = [];
    const run = startImageMirror({ ...base(dir, logs), lockPath: lock });
    await run.mirror.idle();
    expect(run.mirror.status().images.map((i) => [i.digest, i.state])).toEqual([
      [a.digest, 'complete'],
    ]);

    write(b.digest);
    run.reload();
    await run.mirror.idle();
    expect(run.mirror.status().images.map((i) => [i.digest, i.state, i.current])).toEqual([
      [b.digest, 'complete', true],
      [a.digest, 'complete', false],
    ]);

    // A lock that does not parse is said, and the mirror keeps the one it had.
    writeFileSync(lock, '{nope');
    run.reload();
    expect(logs.some((l) => l.includes('does not parse'))).toBe(true);
    expect(run.mirror.status().lock).toBe(true);
    run.stop();
  });

  test('no lock file: nothing is fetched and the status says so', async () => {
    fake = await startFakeRegistry();
    const dir = mkdtempSync(join(tmpdir(), 'jm-run-'));
    const run = startImageMirror({ ...base(dir, []), lockPath: join(dir, 'absent.json') });
    await run.mirror.idle();
    expect(run.mirror.status()).toEqual({ lock: false, images: [] });
    expect(fake.requests).toEqual([]);
    run.stop();
  });
});
