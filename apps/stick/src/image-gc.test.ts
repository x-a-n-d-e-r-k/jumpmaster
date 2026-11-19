// Removing release images the stick loaded once they are no longer needed (issue #425): the
// sweep over `images.json`, with the runner tests' fake driver and a temporary state directory.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { fetchFromServer, type ServerImageDeps } from './fetch-image.js';
import {
  IMAGES_FILE,
  ImageLock,
  type ImageRecords,
  readImageRecords,
  StickImages,
  sweepImages,
} from './image-gc.js';
import { fakeDriver } from './test/fake-driver.js';
import { PLATFORM, release, slowBody, tar } from './test/layout.js';
import type { ImageTrust } from './verify.js';

const REPO = 'ghcr.io/o/jumpmaster-trooper';
const EGRESS = 'ghcr.io/o/jumpmaster-egress';
// Digest order is neither the order of use nor its reverse: a sweep that sorts by digest fails.
const T1 = `${REPO}@sha256:${'b'.repeat(64)}`;
const T2 = `${REPO}@sha256:${'d'.repeat(64)}`;
const T3 = `${REPO}@sha256:${'a'.repeat(64)}`;
const T4 = `${REPO}@sha256:${'c'.repeat(64)}`;
const at = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();
const idOf = (ref: string) => `sha256:id-${ref.slice(-6)}`;

function stateWith(records: ImageRecords): string {
  const dir = mkdtempSync(join(tmpdir(), 'jm-images-'));
  writeFileSync(join(dir, IMAGES_FILE), JSON.stringify(records));
  return dir;
}

const recorded = (...refs: [string, number][]): ImageRecords =>
  Object.fromEntries(
    refs.map(([ref, day]) => [
      ref,
      { repository: ref.slice(0, ref.lastIndexOf('@')), lastUsedAt: at(day) },
    ]),
  );

/** T1 < T2 < T3 < T4 by last use, none in a container. */
const fourTroopers = () => recorded([T1, 1], [T2, 2], [T3, 3], [T4, 4]);

function setup(
  records: ImageRecords | string,
  o: Parameters<typeof fakeDriver>[1] & { keep?: string[] } = {},
) {
  const stateDir =
    typeof records === 'string'
      ? (() => {
          const dir = mkdtempSync(join(tmpdir(), 'jm-images-'));
          writeFileSync(join(dir, IMAGES_FILE), records);
          return dir;
        })()
      : stateWith(records);
  const imageIds =
    o.imageIds ??
    (typeof records === 'string'
      ? {}
      : Object.fromEntries(Object.keys(records).map((r) => [r, idOf(r)])));
  const d = fakeDriver([], { ...o, imageIds });
  const logs: string[] = [];
  const deps = {
    driver: d.driver,
    stateDir,
    keep: o.keep ?? [],
    lock: new ImageLock(),
    log: (l: string) => logs.push(l),
  };
  return { d, deps, stateDir, logs, imageIds };
}

const removes = (gc: string[]) => gc.filter((c) => c.startsWith('remove '));

describe('the image sweep (issue #425)', () => {
  test('four recorded digests: the two least recently used are removed, never forced', async () => {
    const s = setup(fourTroopers(), { keep: [T4] });
    const r = await sweepImages(s.deps);
    expect([...r.removed].sort()).toEqual([T1, T2].sort());
    expect(removes(s.d.gc).sort()).toEqual([`remove ${T1}`, `remove ${T2}`].sort());
    expect(Object.keys(readImageRecords(s.stateDir).records).sort()).toEqual([T3, T4].sort());
    expect(r.kept).toBe(2);
    expect(r.failed).toEqual([]);
    expect(s.logs.map((l) => JSON.parse(l))).toEqual([
      { event: 'image-sweep', removed: r.removed, kept: 2, failed: [] },
    ]);
  });

  test('without the configured image, the keep count alone keeps the two newest', async () => {
    const s = setup(fourTroopers());
    expect((await sweepImages(s.deps)).removed.sort()).toEqual([T1, T2].sort());
  });

  test('a stopped container still using the oldest image keeps it', async () => {
    const s = setup(fourTroopers(), {
      keep: [T4],
      // A stopped drop container, listed by its image id (created by a reference since removed).
      containers: [{ id: 'c1', image: idOf(T1), imageId: idOf(T1) }],
    });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([T2]);
    expect(removes(s.d.gc)).toEqual([`remove ${T2}`]);
    expect(Object.keys(readImageRecords(s.stateDir).records)).toContain(T1);
  });

  test('a container created by the reference keeps its image too', async () => {
    const s = setup(fourTroopers(), {
      containers: [{ id: 'c1', image: T2, imageId: 'sha256:other' }],
    });
    expect((await sweepImages(s.deps)).removed).toEqual([T1]);
  });

  test('JM_TROOPER_IMAGE naming the oldest digest keeps it', async () => {
    const s = setup(fourTroopers(), {
      keep: [`ghcr.io/o/jumpmaster-trooper:v0.4.0@sha256:${'b'.repeat(64)}`, `${EGRESS}:dev`],
    });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([T2]);
    expect(removes(s.d.gc)).not.toContain(`remove ${T1}`);
  });

  test('an image in Docker but not in the file is never removed, even old and unused', async () => {
    const operator = `${REPO}@sha256:${'0'.repeat(64)}`;
    const s = setup(recorded([T3, 3], [T4, 4]), {
      imageIds: { [operator]: 'sha256:op', [T3]: idOf(T3), [T4]: idOf(T4) },
    });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([]);
    expect(removes(s.d.gc)).toEqual([]);
    expect(s.imageIds[operator]).toBe('sha256:op');
  });

  test('the two newest are counted per repository', async () => {
    const E1 = `${EGRESS}@sha256:${'1'.repeat(64)}`;
    const s = setup({ ...fourTroopers(), ...recorded([E1, 1]) });
    const r = await sweepImages(s.deps);
    expect(r.removed.sort()).toEqual([T1, T2].sort());
    expect(Object.keys(readImageRecords(s.stateDir).records)).toContain(E1);
  });

  test('fail closed: a container list that throws means no remove at all', async () => {
    const s = setup(fourTroopers(), { listContainersError: new Error('engine down') });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([]);
    expect(removes(s.d.gc)).toEqual([]);
    expect(s.d.gc).toEqual(['containers']);
    expect(Object.keys(readImageRecords(s.stateDir).records)).toHaveLength(4);
    expect(JSON.parse(s.logs[0] as string)).toMatchObject({
      event: 'image-sweep',
      removed: [],
      kept: 4,
      failed: [],
      aborted: expect.stringContaining('engine down'),
    });
  });

  test('a remove refused 409 in use keeps the image and its entry; the next is still removed', async () => {
    const s = setup(fourTroopers(), {
      removeImageError: (ref) =>
        ref === T1
          ? Object.assign(new Error('conflict: image is in use by container c9'), {
              statusCode: 409,
            })
          : undefined,
    });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([T2]);
    expect(r.failed).toEqual([{ ref: T1, reason: expect.stringContaining('in use') }]);
    expect(removes(s.d.gc).sort()).toEqual([`remove ${T1}`, `remove ${T2}`].sort());
    expect(Object.keys(readImageRecords(s.stateDir).records).sort()).toEqual([T1, T3, T4].sort());
    expect(s.imageIds[T1]).toBe(idOf(T1));
    expect(r.kept).toBe(3);
  });

  test('an image already gone drops its entry', async () => {
    const s = setup(fourTroopers(), { imageIds: { [T3]: idOf(T3), [T4]: idOf(T4) } });
    const r = await sweepImages(s.deps);
    expect(r.removed.sort()).toEqual([T1, T2].sort());
    expect(Object.keys(readImageRecords(s.stateDir).records).sort()).toEqual([T3, T4].sort());
  });

  test('a corrupt images.json is treated as empty: no removals, the file rewritten valid', async () => {
    const s = setup('{"not": json', { imageIds: { [T1]: idOf(T1) } });
    const r = await sweepImages(s.deps);
    expect(r.removed).toEqual([]);
    expect(removes(s.d.gc)).toEqual([]);
    expect(JSON.parse(readFileSync(join(s.stateDir, IMAGES_FILE), 'utf8'))).toEqual({});
    expect(readImageRecords(s.stateDir).valid).toBe(true);
  });

  test('entries of the wrong shape make the file invalid too', async () => {
    const s = setup(JSON.stringify({ [T1]: { repository: REPO } }));
    expect((await sweepImages(s.deps)).removed).toEqual([]);
    expect(readImageRecords(s.stateDir)).toEqual({ records: {}, valid: true });
  });
});

/** A server fetch whose loader shares the sweep's call log, under allowlist (no cosign). */
function fetchWorld(images: StickImages, stateDir: string, calls: string[], status = 200) {
  const r = release();
  const body = tar(r.entries);
  const deps: ServerImageDeps = {
    client: {
      async imageLayout() {
        calls.push('fetch');
        return status === 200
          ? new Response(slowBody(body, 1000), {
              status: 200,
              headers: { 'content-length': String(body.length) },
            })
          : new Response('{"error":"nope"}', { status });
      },
      async reportImageFetch() {},
    },
    loader: {
      async imageExists() {
        return false;
      },
      async loadImage(t: Readable) {
        calls.push('load');
        for await (const _ of t);
        return [r.configDigest];
      },
      async removeImage() {},
      async tagImage() {
        calls.push('tag');
      },
    },
    stateDir,
    platform: PLATFORM,
    log: () => {},
    images,
  };
  const trust: ImageTrust = { policy: 'allowlist', allowed: new Set([r.ref]) };
  return { r, deps, trust };
}

describe('recording what the stick loads (issue #425)', () => {
  test('a successful load from the server writes an entry', async () => {
    const s = setup({});
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
      now: () => new Date(at(19)),
    });
    const w = fetchWorld(images, s.stateDir, []);
    expect(await fetchFromServer(w.r.ref, w.trust, w.deps)).toEqual({
      ok: true,
      via: 'allowlist',
    });
    await images.idle();
    expect(readImageRecords(s.stateDir).records).toEqual({
      [w.r.ref]: { repository: REPO, lastUsedAt: at(19) },
    });
  });

  test('a refused fetch writes none', async () => {
    const s = setup({});
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
    });
    const w = fetchWorld(images, s.stateDir, [], 403);
    expect((await fetchFromServer(w.r.ref, w.trust, w.deps)).ok).toBe(false);
    await images.idle();
    expect(readImageRecords(s.stateDir).records).toEqual({});
  });

  test('a container start updates the entry it uses, and records nothing new', () => {
    const s = setup(recorded([T1, 1]));
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
      now: () => new Date(at(19)),
    });
    images.used(T1);
    images.used(T2);
    images.used('jumpmaster-trooper:dev');
    expect(readImageRecords(s.stateDir).records).toEqual({
      [T1]: { repository: REPO, lastUsedAt: at(19) },
    });
  });

  test('a sweep started with a fetch waits for it, and keeps what the fetch just loaded', async () => {
    const r = release();
    const old1 = `${REPO}@sha256:${'1'.repeat(64)}`;
    const old2 = `${REPO}@sha256:${'2'.repeat(64)}`;
    const s = setup(recorded([old1, 1], [old2, 2]), {
      imageIds: { [old1]: idOf(old1), [old2]: idOf(old2), [r.ref]: r.configDigest },
    });
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
      now: () => new Date(at(19)),
    });
    // One log for both: the fetch's engine calls and the sweep's.
    const calls = s.d.gc;
    const w = fetchWorld(images, s.stateDir, calls);
    const fetched = fetchFromServer(w.r.ref, w.trust, w.deps);
    const swept = images.sweep();
    const [v, result] = await Promise.all([fetched, swept]);
    await images.idle();
    expect(v.ok).toBe(true);
    // The sweep looked at containers only once the fetch had loaded and named its image.
    expect(calls.indexOf('containers')).toBeGreaterThan(calls.indexOf('tag'));
    expect(result.removed).toEqual([old1]);
    expect(removes(calls)).not.toContain(`remove ${w.r.ref}`);
    expect(Object.keys(readImageRecords(s.stateDir).records).sort()).toEqual(
      [old2, w.r.ref].sort(),
    );
  });
});

describe('images a drop holds (issue #439)', () => {
  const PG = 'ghcr.io/o/pg';
  const P1 = `${PG}@sha256:${'1'.repeat(64)}`;
  const P2 = `${PG}@sha256:${'2'.repeat(64)}`;
  const P3 = `${PG}@sha256:${'3'.repeat(64)}`;
  /** P1 < P2 < P3 by last use: P1 is the one beyond the two newest. */
  function world() {
    const s = setup(recorded([P1, 1], [P2, 2], [P3, 3]));
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
      now: () => new Date(at(19)),
    });
    const calls = s.d.gc;
    const w = fetchWorld(images, s.stateDir, calls);
    const deps = {
      ...w.deps,
      loader: { ...w.deps.loader, imageExists: async (ref: string) => ref === P1 },
    };
    const trust: ImageTrust = { policy: 'allowlist', allowed: new Set([P1, w.r.ref]) };
    return { s, images, calls, w, deps, trust };
  }

  test('an image a fetch found present is not swept before its container starts', async () => {
    const { s, images, calls, w, deps, trust } = world();
    const hold = images.hold();
    // The drop's service image is present: nothing is fetched.
    expect(await fetchFromServer(P1, trust, deps, hold)).toEqual({ ok: true, via: 'allowlist' });
    // Its next image is new to the stick: the load starts a sweep.
    expect((await fetchFromServer(w.r.ref, trust, deps, hold)).ok).toBe(true);
    await images.idle();
    // No container has started yet; the drop still needs P1.
    expect(removes(calls)).not.toContain(`remove ${P1}`);
    expect(Object.keys(readImageRecords(s.stateDir).records)).toContain(P1);
  });

  test("another drop's fresh load does not sweep an image this drop found present", async () => {
    const { s, images, calls, w, deps, trust } = world();
    const first = images.hold();
    const second = images.hold();
    expect((await fetchFromServer(P1, trust, deps, first)).ok).toBe(true);
    expect((await fetchFromServer(w.r.ref, trust, deps, second)).ok).toBe(true);
    await images.idle();
    expect(removes(calls)).not.toContain(`remove ${P1}`);
    expect(Object.keys(readImageRecords(s.stateDir).records)).toContain(P1);
  });

  test('once the drop ends, a later sweep removes the image beyond the two newest', async () => {
    const { s, images, calls, w, deps, trust } = world();
    const hold = images.hold();
    expect((await fetchFromServer(P1, trust, deps, hold)).ok).toBe(true);
    expect((await fetchFromServer(w.r.ref, trust, deps, hold)).ok).toBe(true);
    await images.idle();
    expect(removes(calls)).not.toContain(`remove ${P1}`);
    hold.release();
    // Released twice is the same as once.
    hold.release();
    const r = await images.sweep();
    expect(r.removed).toContain(P1);
    expect(Object.keys(readImageRecords(s.stateDir).records)).not.toContain(P1);
  });

  test('a hold keeps an image until every drop holding it has ended', async () => {
    const { s, images } = world();
    const a = images.hold();
    const b = images.hold();
    a.add(P1);
    b.add(P1);
    a.release();
    expect((await images.sweep()).removed).toEqual([]);
    b.release();
    expect((await images.sweep()).removed).toEqual([P1]);
    expect(Object.keys(readImageRecords(s.stateDir).records).sort()).toEqual([P2, P3]);
  });

  test('a refused fetch holds nothing; a tag is never held', async () => {
    const { images, deps } = world();
    const hold = images.hold();
    const refused: ImageTrust = { policy: 'allowlist', allowed: new Set([P1]) };
    const failing = {
      ...deps,
      loader: { ...deps.loader, imageExists: async () => false },
      client: {
        ...deps.client,
        imageLayout: async () => new Response('{"error":"nope"}', { status: 403 }),
      },
    };
    expect((await fetchFromServer(P1, refused, failing, hold)).ok).toBe(false);
    hold.add('ghcr.io/o/pg:16');
    expect((await images.sweep()).removed).toEqual([P1]);
  });

  test('a held image is kept while the container list still fails closed', async () => {
    const s = setup(recorded([P1, 1], [P2, 2], [P3, 3]), {
      listContainersError: new Error('engine down'),
    });
    const images = new StickImages({
      driver: s.d.driver,
      stateDir: s.stateDir,
      keep: [],
      log: () => {},
    });
    images.hold().add(P2);
    const r = await images.sweep();
    expect(r.aborted).toMatch(/container list failed/);
    expect(removes(s.d.gc)).toEqual([]);
  });
});

describe('the image lock', () => {
  test('shared holders run together; an exclusive one waits for them and holds back later ones', async () => {
    const lock = new ImageLock();
    const log: string[] = [];
    let release1: () => void = () => {};
    const a = lock.shared(async () => {
      log.push('a start');
      await new Promise<void>((r) => {
        release1 = r;
      });
      log.push('a end');
    });
    const b = lock.shared(async () => {
      log.push('b');
    });
    const x = lock.exclusive(async () => {
      log.push('x');
    });
    const c = lock.shared(async () => {
      log.push('c');
    });
    await Promise.resolve();
    expect(log).toEqual(['a start', 'b']);
    release1();
    await Promise.all([a, b, x, c]);
    expect(log).toEqual(['a start', 'b', 'a end', 'x', 'c']);
  });
});
