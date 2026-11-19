// Removing release images the stick loaded once they are no longer needed (issue #425). Every
// image `fetchFromServer` loads is recorded in `<state>/images.json`; a container start updates
// its record's `lastUsedAt`. The sweep's only candidates are those records: an image the stick
// did not load (its own image, an operator's, a dev build) is never touched. Of the candidates it
// keeps anything a container (running or stopped) uses, the configured trooper and egress images,
// and the two most recently used digests per repository; the rest it removes, never forced.
// A sweep never overlaps an image fetch or a container start: those hold `ImageLock` shared, the
// sweep holds it exclusively. Between the two, a drop holds its images (`StickImages.hold`, issue
// #439): from before its first fetch until it ends, the sweep keeps every image the drop needs,
// whatever the keep count, so an image found present is still there when its container starts.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalRef, digestOf } from './verify.js';

export const IMAGES_FILE = 'images.json';
/** Recorded digests kept per repository, by `lastUsedAt` (fixed; not a setting). */
export const KEEP_PER_REPOSITORY = 2;

export type ImageRecord = { repository: string; lastUsedAt: string };
/** `<repository>@<digest>` to its record. */
export type ImageRecords = Record<string, ImageRecord>;

/** A container (running or not): the reference it was created from and its image id. */
export type ContainerInfo = { id: string; image: string; imageId: string };

/** What the sweep needs of the engine. */
export interface ImageGcDriver {
  /** The id of the image `ref` names, or undefined when the engine has no such image. */
  imageId(ref: string): Promise<string | undefined>;
  /** Removes `ref`, never forced: gone already is fine; in use (409) or any other error throws. */
  removeImageRef(ref: string): Promise<void>;
  /** Every container on the engine, running or stopped. */
  listContainers(): Promise<ContainerInfo[]>;
}

export type SweepResult = {
  removed: string[];
  kept: number;
  failed: { ref: string; reason: string }[];
  /** Set when the sweep removed nothing because it couldn't see which images are in use. */
  aborted?: string;
};

/**
 * Fetches and container starts hold this shared (any number at once); the sweep holds it alone.
 * First come, first served: a waiting sweep holds back later fetches, so it is never starved.
 * A holder that is free is granted synchronously, within the call.
 */
export class ImageLock {
  #readers = 0;
  #writer = false;
  readonly #queue: { write: boolean; grant: () => void }[] = [];

  shared<T>(fn: () => Promise<T>): Promise<T> {
    return this.#run(false, fn);
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#run(true, fn);
  }

  #free(write: boolean): boolean {
    return write ? !this.#writer && this.#readers === 0 : !this.#writer;
  }

  #take(write: boolean): void {
    if (write) this.#writer = true;
    else this.#readers++;
  }

  async #run<T>(write: boolean, fn: () => Promise<T>): Promise<T> {
    if (this.#queue.length === 0 && this.#free(write)) this.#take(write);
    else
      await new Promise<void>((grant) => {
        this.#queue.push({ write, grant });
      });
    try {
      return await fn();
    } finally {
      if (write) this.#writer = false;
      else this.#readers--;
      this.#pump();
    }
  }

  #pump(): void {
    for (;;) {
      const next = this.#queue[0];
      if (!next || !this.#free(next.write)) return;
      this.#queue.shift();
      this.#take(next.write);
      next.grant();
    }
  }
}

const isRecord = (v: unknown): v is ImageRecord =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as ImageRecord).repository === 'string' &&
  typeof (v as ImageRecord).lastUsedAt === 'string';

/** The records, and whether the file was valid (a missing file is valid and empty). */
export function readImageRecords(stateDir: string): { records: ImageRecords; valid: boolean } {
  let text: string;
  try {
    text = readFileSync(join(stateDir, IMAGES_FILE), 'utf8');
  } catch (e) {
    return { records: {}, valid: (e as NodeJS.ErrnoException).code === 'ENOENT' };
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([k, r]) => digestOf(k) !== null && isRecord(r)))
        return { records: Object.fromEntries(entries) as ImageRecords, valid: true };
    }
  } catch {
    // below
  }
  return { records: {}, valid: false };
}

/** Writes the records atomically: a temporary file, then a rename over the old one. */
export function writeImageRecords(stateDir: string, records: ImageRecords): void {
  const path = join(stateDir, IMAGES_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** `<repository>@<digest>` for a digest reference; undefined for a tag. */
export function recordKey(ref: string): { key: string; repository: string } | undefined {
  if (!digestOf(ref)) return undefined;
  const key = canonicalRef(ref);
  return { key, repository: key.slice(0, key.lastIndexOf('@')) };
}

/** Records a load of `ref` (now its last use); true when the digest was not recorded before. */
export function recordImage(stateDir: string, ref: string, now: Date = new Date()): boolean {
  const k = recordKey(ref);
  if (!k) return false;
  const { records } = readImageRecords(stateDir);
  const fresh = !(k.key in records);
  records[k.key] = { repository: k.repository, lastUsedAt: now.toISOString() };
  writeImageRecords(stateDir, records);
  return fresh;
}

/** A container started from `ref`: its record (only one the stick made) is used now. */
export function touchImage(stateDir: string, ref: string, now: Date = new Date()): void {
  const k = recordKey(ref);
  if (!k) return;
  const { records, valid } = readImageRecords(stateDir);
  const r = records[k.key];
  if (!valid || !r) return;
  records[k.key] = { ...r, lastUsedAt: now.toISOString() };
  writeImageRecords(stateDir, records);
}

export type SweepDeps = {
  driver: ImageGcDriver;
  stateDir: string;
  /** The stick's configured images (`JM_TROOPER_IMAGE`, `JM_EGRESS_IMAGE`): always kept. */
  keep: string[];
  lock: ImageLock;
  log: (line: string) => void;
  /** Records held by drops that have not ended (keys as `recordKey` gives them): always kept. */
  held?: () => ReadonlySet<string>;
};

const message = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]?.trim().slice(0, 300) ?? '';

const usedAt = (r: ImageRecord): number => {
  const t = Date.parse(r.lastUsedAt);
  return Number.isFinite(t) ? t : 0;
};

/** Removes the recorded images no longer needed (see the top of this file). */
export function sweepImages(deps: SweepDeps): Promise<SweepResult> {
  return deps.lock.exclusive(async () => {
    const { records, valid } = readImageRecords(deps.stateDir);
    // An unreadable file is treated as empty, and rewritten valid.
    if (!valid) writeImageRecords(deps.stateDir, records);
    const result: SweepResult = { removed: [], kept: 0, failed: [] };
    const done = () => {
      result.kept = Object.keys(records).length;
      deps.log(
        JSON.stringify({
          event: 'image-sweep',
          removed: result.removed,
          kept: result.kept,
          failed: result.failed,
          ...(result.aborted ? { aborted: result.aborted } : {}),
        }),
      );
      return result;
    };
    let containers: ContainerInfo[];
    try {
      containers = await deps.driver.listContainers();
    } catch (e) {
      // Fail closed: without the container list nothing is known to be unused.
      result.aborted = `the container list failed: ${message(e)}`;
      return done();
    }
    const usedIds = new Set(containers.map((c) => c.imageId));
    const usedRefs = new Set(containers.map((c) => canonicalRef(c.image)));
    const configured = new Set(deps.keep.flatMap((r) => recordKey(r)?.key ?? []));
    const byRepository = new Map<string, string[]>();
    for (const [key, r] of Object.entries(records))
      byRepository.set(r.repository, [...(byRepository.get(r.repository) ?? []), key]);
    const candidates: string[] = [];
    for (const keys of byRepository.values()) {
      keys.sort(
        (a, b) =>
          usedAt(records[b] as ImageRecord) - usedAt(records[a] as ImageRecord) || (a < b ? -1 : 1),
      );
      candidates.push(...keys.slice(KEEP_PER_REPOSITORY));
    }
    let changed = !valid;
    const held = deps.held?.() ?? new Set<string>();
    for (const ref of candidates) {
      if (configured.has(ref) || usedRefs.has(ref) || held.has(ref)) continue;
      try {
        const id = await deps.driver.imageId(ref);
        if (id && usedIds.has(id)) continue;
        await deps.driver.removeImageRef(ref);
      } catch (e) {
        result.failed.push({ ref, reason: message(e) });
        continue;
      }
      delete records[ref];
      changed = true;
      result.removed.push(ref);
    }
    if (changed) writeImageRecords(deps.stateDir, records);
    return done();
  });
}

/**
 * The images one drop needs, kept from every sweep until `release` (the drop has ended). A tag is
 * never recorded, so never held.
 */
export interface ImageHold {
  add(ref: string): void;
  release(): void;
}

/**
 * The stick's images: the lock, the records and the sweep, as fetches and starts use them. A load
 * of a digest not recorded before starts a sweep (which waits for the lock to be free).
 */
export class StickImages {
  readonly lock = new ImageLock();
  #idle: Promise<unknown> = Promise.resolve();
  /** Record key to the number of drops holding it. */
  readonly #held = new Map<string, number>();

  constructor(
    private readonly o: {
      driver: ImageGcDriver;
      stateDir: string;
      keep: string[];
      log: (line: string) => void;
      now?: () => Date;
    },
  ) {}

  #now(): Date {
    return this.o.now?.() ?? new Date();
  }

  sweep(): Promise<SweepResult> {
    const s = sweepImages({ ...this.o, lock: this.lock, held: () => new Set(this.#held.keys()) });
    this.#idle = Promise.allSettled([this.#idle, s]);
    return s;
  }

  /** A new hold for one drop: what it adds is kept until it is released (once; again is a no-op). */
  hold(): ImageHold {
    const keys = new Set<string>();
    let released = false;
    return {
      add: (ref) => {
        const k = recordKey(ref)?.key;
        if (released || !k || keys.has(k)) return;
        keys.add(k);
        this.#held.set(k, (this.#held.get(k) ?? 0) + 1);
      },
      release: () => {
        if (released) return;
        released = true;
        for (const k of keys) {
          const n = (this.#held.get(k) ?? 1) - 1;
          if (n > 0) this.#held.set(k, n);
          else this.#held.delete(k);
        }
      },
    };
  }

  /** `fetchFromServer` loaded `ref`. Never throws. */
  loaded(ref: string): void {
    let fresh = false;
    try {
      fresh = recordImage(this.o.stateDir, ref, this.#now());
    } catch (e) {
      this.o.log(JSON.stringify({ event: 'image-record-failed', ref, reason: message(e) }));
    }
    if (fresh) void this.sweep().catch(() => {});
  }

  /** A container is starting from `ref`. Never throws. */
  used(ref: string): void {
    try {
      touchImage(this.o.stateDir, ref, this.#now());
    } catch (e) {
      this.o.log(JSON.stringify({ event: 'image-record-failed', ref, reason: message(e) }));
    }
  }

  /** Settles once every sweep started so far has. */
  idle(): Promise<void> {
    return this.#idle.then(() => {});
  }
}
