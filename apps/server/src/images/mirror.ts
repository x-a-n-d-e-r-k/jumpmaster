// The server's mirror of the release's images (issue #140): every image the release lock names
// (the stick, the troopers and the egress proxy; not the server's own), for linux/amd64 and
// linux/arm64, with the cosign signature artifacts of its index digest. The server is a cache,
// not a trust anchor: a stick verifies those signatures itself before it loads anything.
//
// It fetches only the digests the lock names. It never resolves a tag and never polls the
// registry for newer images: new images arrive with a new lock, when the operator upgrades the
// server. It runs in the background on start and when the lock changes, retrying a failed image
// with backoff and recording its last error.

import { join } from 'node:path';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';
import type { ImageLockFile } from '../presets.js';
import {
  DOCKER_LIST,
  type FetchLike,
  OCI_INDEX,
  RegistryClient,
  type RegistryDeps,
} from './registry.js';
import {
  type Descriptor,
  type ImageRecord,
  type ImageState,
  ImageStore,
  imageKey,
  type MirrorIndex,
} from './store.js';

/** The platforms a stick runs on. */
export const MIRRORED_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;

/** Lock images no stick runs: the server's own image. */
const NOT_FOR_STICKS = new Set(['jumpmaster-server']);

/** A repository name component: nothing that walks a path or a URL. */
const IMAGE_NAME = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** How long to wait before each retry of a failed pass (the last repeats). */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;

export type MirrorDeps = {
  /** The server's data directory: the store is `<dataDir>/images`. */
  dataDir: string;
  /** The `registryReadToken` credential as it is now, when set. */
  token?: () => string | undefined;
  scrub?: Pick<ScrubSet, 'add' | 'values'>;
  log?: (line: string) => void;
  fetch?: FetchLike;
  scheme?: RegistryDeps['scheme'];
  /** Waits `ms`, or less when `signal` aborts (tests pass one that returns at once). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffMs?: readonly number[];
  now?: () => Date;
};

export type ImageStatus = {
  name: string;
  digest: string;
  /** `<registry>/<name>@<digest>` */
  ref: string;
  state: ImageState;
  error?: string;
  platforms: string[];
  size: number;
  /** In the current lock (false: the previous one's, still served). */
  current: boolean;
};

export type MirrorStatus = { lock: boolean; images: ImageStatus[] };

/** What the store holds for an image a stick asked for, if the lock lists it. */
export type Lookup =
  | { listed: false }
  | { listed: true; record: ImageRecord; store: ImageStore; complete: boolean };

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type ManifestJson = {
  mediaType?: string;
  manifests?: (Descriptor & {
    platform?: { os?: string; architecture?: string; variant?: string };
    subject?: unknown;
  })[];
  config?: Descriptor;
  layers?: Descriptor[];
  subject?: { digest?: string };
  artifactType?: string;
};

/** Only the fields the layout needs, from a descriptor the registry served (data, not trusted). */
function descriptor(d: unknown, what: string): Descriptor {
  const o = (d ?? {}) as Record<string, unknown>;
  if (
    typeof o.mediaType !== 'string' ||
    typeof o.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(o.digest) ||
    typeof o.size !== 'number' ||
    !Number.isSafeInteger(o.size) ||
    o.size < 0
  )
    throw new Error(`${what}: a descriptor without a sha256 digest, media type and size`);
  const annotations =
    o.annotations && typeof o.annotations === 'object' && !Array.isArray(o.annotations)
      ? Object.fromEntries(
          Object.entries(o.annotations as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === 'string',
          ),
        )
      : undefined;
  return {
    mediaType: o.mediaType,
    digest: o.digest,
    size: o.size,
    ...(typeof o.artifactType === 'string' ? { artifactType: o.artifactType } : {}),
    ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

const parse = (bytes: Buffer, what: string): ManifestJson => {
  try {
    return JSON.parse(bytes.toString()) as ManifestJson;
  } catch {
    throw new Error(`${what} is not JSON`);
  }
};

/** The images of a lock a stick runs, with where each lives. */
export function mirroredImages(
  lock: ImageLockFile,
): { name: string; digest: string; registry: string }[] {
  return Object.entries(lock.images)
    .filter(([name]) => !NOT_FOR_STICKS.has(name) && IMAGE_NAME.test(name))
    .map(([name, digest]) => ({ name, digest, registry: lock.registry }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export class ImageMirror {
  readonly store: ImageStore;
  readonly #deps: MirrorDeps;
  readonly #scrub: Pick<ScrubSet, 'add' | 'values'>;
  readonly #log: (line: string) => void;
  #index: MirrorIndex;
  #hasLock = false;
  #running: Promise<void> | undefined;
  #again = false;
  #stopped = false;
  #wake = new AbortController();

  constructor(deps: MirrorDeps) {
    this.#deps = deps;
    this.#scrub = deps.scrub ?? serverScrubSet;
    this.#log = deps.log ?? ((line) => console.error(`[jumpmaster] ${line}`));
    this.store = new ImageStore(join(deps.dataDir, 'images'));
    this.#index = this.store.readIndex();
    // A pass that died mid-fetch left `fetching`: it starts again.
    for (const r of Object.values(this.#index.images))
      if (r.state === 'fetching') r.state = 'pending';
  }

  /**
   * The lock as it is now (undefined: none, the server runs from a checkout). A lock that names
   * other images makes the old one the previous lock, whose images are still served; images of
   * neither leave the index (their blobs stay: no garbage collection yet).
   */
  setLock(lock: ImageLockFile | undefined): void {
    this.#hasLock = lock !== undefined;
    const wanted = lock ? mirroredImages(lock) : [];
    const keys = wanted.map((w) => imageKey(w.name, w.digest));
    const idx = this.#index;
    const same = keys.length === idx.current.length && keys.every((k) => idx.current.includes(k));
    if (!same) {
      if (idx.current.length > 0) idx.previous = idx.current.filter((k) => !keys.includes(k));
      idx.current = keys;
    }
    const at = this.#now();
    for (const w of wanted) {
      const key = imageKey(w.name, w.digest);
      const had = idx.images[key];
      if (had && had.registry === w.registry) continue;
      idx.images[key] = {
        name: w.name,
        registry: w.registry,
        digest: w.digest,
        state: 'pending',
        attempts: 0,
        updatedAt: at,
        platforms: {},
        signatures: [],
        size: 0,
      };
    }
    const keep = new Set([...idx.current, ...idx.previous]);
    for (const k of Object.keys(idx.images)) if (!keep.has(k)) delete idx.images[k];
    this.#persist();
  }

  /** Starts a background pass (or asks the running one to go again), without waiting for it. */
  start(): void {
    if (this.#stopped) return;
    if (this.#running) {
      this.#again = true;
      this.#wake.abort();
      return;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
    });
  }

  /** Resolves when no pass is running (tests). */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  stop(): void {
    this.#stopped = true;
    this.#wake.abort();
  }

  /**
   * One pass: every image of the current lock not yet complete, one attempt each. Returns how
   * many failed.
   */
  async syncOnce(): Promise<number> {
    let failed = 0;
    for (const key of [...this.#index.current]) {
      if (this.#stopped) break;
      const rec = this.#index.images[key];
      if (!rec || rec.state === 'complete') continue;
      if (!(await this.#mirror(rec))) failed++;
    }
    return failed;
  }

  status(): MirrorStatus {
    const idx = this.#index;
    const row = (key: string, current: boolean): ImageStatus[] => {
      const r = idx.images[key];
      if (!r) return [];
      return [
        {
          name: r.name,
          digest: r.digest,
          ref: `${r.registry}/${r.name}@${r.digest}`,
          state: r.state,
          ...(r.error ? { error: r.error } : {}),
          platforms: Object.keys(r.platforms).sort(),
          size: r.size,
          current,
        },
      ];
    };
    return {
      lock: this.#hasLock,
      images: [
        ...idx.current.flatMap((k) => row(k, true)),
        ...idx.previous.flatMap((k) => row(k, false)),
      ],
    };
  }

  /** The record of `<name>@<digest>` when the current or the previous lock lists it. */
  lookup(name: string, digest: string): Lookup {
    const key = imageKey(name, digest);
    const idx = this.#index;
    const rec = idx.images[key];
    if (!rec || !(idx.current.includes(key) || idx.previous.includes(key)))
      return { listed: false };
    return { listed: true, record: rec, store: this.store, complete: rec.state === 'complete' };
  }

  async #loop(): Promise<void> {
    let attempt = 0;
    const backoff = this.#deps.backoffMs ?? BACKOFF_MS;
    for (;;) {
      this.#again = false;
      let failed: number;
      try {
        failed = await this.syncOnce();
      } catch (e) {
        this.#log(`image mirror: pass failed: ${this.#clean(errorText(e))}`);
        failed = 1;
      }
      if (this.#stopped) return;
      if (this.#again) {
        attempt = 0;
        continue;
      }
      if (failed === 0) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 60_000;
      attempt++;
      this.#wake = new AbortController();
      await (this.#deps.sleep ?? defaultSleep)(delay, this.#wake.signal);
      if (this.#stopped) return;
    }
  }

  /** One attempt at one image; true when it is complete. */
  async #mirror(rec: ImageRecord): Promise<boolean> {
    rec.state = 'fetching';
    rec.attempts++;
    delete rec.error;
    rec.updatedAt = this.#now();
    this.#persist();
    try {
      const got = await this.#fetch(rec);
      rec.index = got.index;
      rec.platforms = got.platforms;
      rec.signatures = got.signatures;
      rec.size = got.size;
      rec.state = 'complete';
      rec.updatedAt = this.#now();
      this.#persist();
      this.#log(`image mirror: ${rec.name}@${rec.digest} complete`);
      return true;
    } catch (e) {
      rec.state = 'failed';
      rec.error = this.#clean(errorText(e));
      rec.updatedAt = this.#now();
      this.#persist();
      this.#log(`image mirror: ${rec.name}@${rec.digest} failed: ${rec.error}`);
      return false;
    }
  }

  async #fetch(
    rec: ImageRecord,
  ): Promise<Pick<ImageRecord, 'index' | 'platforms' | 'signatures' | 'size'>> {
    const [host = '', ...path] = rec.registry.split('/');
    const client = new RegistryClient(host, [...path, rec.name].join('/'), {
      scrub: this.#scrub,
      ...(this.#deps.token ? { token: this.#deps.token } : {}),
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
      ...(this.#deps.scheme ? { scheme: this.#deps.scheme } : {}),
    });
    const sizes = new Map<string, number>();
    const keep = (d: Descriptor) => sizes.set(d.digest, d.size);

    const index = await client.manifest(rec.digest);
    if (index.mediaType !== OCI_INDEX && index.mediaType !== DOCKER_LIST)
      throw new Error(`${rec.digest} is not a multi-arch index (${index.mediaType})`);
    this.store.putBytes(index.digest, index.bytes);
    const indexDesc: Descriptor = {
      mediaType: index.mediaType,
      digest: index.digest,
      size: index.bytes.length,
    };
    keep(indexDesc);
    const entries = parse(index.bytes, 'the index').manifests ?? [];

    const platforms: ImageRecord['platforms'] = {};
    for (const p of MIRRORED_PLATFORMS) {
      const [os, architecture] = p.split('/');
      const entry = entries.find(
        (m) => m.platform?.os === os && m.platform?.architecture === architecture,
      );
      if (!entry) continue;
      const desc = descriptor(entry, `the index's ${p} entry`);
      const m = await client.manifest(desc.digest);
      this.store.putBytes(m.digest, m.bytes);
      const manifest: Descriptor = {
        mediaType: m.mediaType || desc.mediaType,
        digest: m.digest,
        size: m.bytes.length,
      };
      keep(manifest);
      const blobs = await this.#blobs(client, parse(m.bytes, `the ${p} manifest`), p);
      for (const b of blobs) keep(b);
      platforms[p] = { manifest, blobs };
    }
    if (Object.keys(platforms).length === 0)
      throw new Error(`the index lists neither ${MIRRORED_PLATFORMS.join(' nor ')}`);

    const signatures = await this.#signatures(client, rec.digest);
    if (signatures.length === 0)
      throw new Error(
        `no cosign signature was found for ${rec.digest}: a stick verifies the signature, so the image is not mirrored without one`,
      );
    for (const s of signatures) {
      keep(s.manifest);
      for (const b of s.blobs) keep(b);
    }
    const size = [...sizes.values()].reduce((a, b) => a + b, 0);
    return { index: indexDesc, platforms, signatures, size };
  }

  /** A manifest's config and layers, each fetched into the store unless it is there already. */
  async #blobs(client: RegistryClient, m: ManifestJson, what: string): Promise<Descriptor[]> {
    if (!m.config || !Array.isArray(m.layers))
      throw new Error(`the ${what} manifest has no config or layers`);
    const out = [descriptor(m.config, `the ${what} config`)];
    for (const [i, l] of m.layers.entries()) out.push(descriptor(l, `the ${what} layer ${i}`));
    for (const b of out) {
      if (this.store.has(b.digest)) continue;
      await this.store.putStream(b.digest, await client.blob(b.digest), b.size);
    }
    return out;
  }

  /**
   * The cosign signature artifacts of `digest`, as the release workflow's cosign writes them:
   * OCI 1.1 referrers (from the referrers API, else its `sha256-<hex>` fallback tag, which is
   * what GHCR holds), and the legacy `sha256-<hex>.sig` tag. Each is stored with its blobs.
   */
  async #signatures(client: RegistryClient, digest: string): Promise<ImageRecord['signatures']> {
    const out: ImageRecord['signatures'] = [];
    const seen = new Set<string>();
    const list = (await client.referrers(digest)) ?? (await client.signatureTag(digest, ''));
    const referrers = list ? (parse(list.bytes, 'the referrers list').manifests ?? []) : [];
    for (const [i, r] of referrers.entries()) {
      const desc = descriptor(r, `referrer ${i}`);
      if (seen.has(desc.digest)) continue;
      const m = await client.manifest(desc.digest);
      const body = parse(m.bytes, `referrer ${desc.digest}`);
      // A referrer of another digest is not this image's signature.
      if (body.subject?.digest !== digest) continue;
      this.store.putBytes(m.digest, m.bytes);
      const blobs = await this.#blobs(client, body, `referrer ${desc.digest}`);
      seen.add(desc.digest);
      out.push({
        manifest: {
          ...desc,
          mediaType: m.mediaType || desc.mediaType,
          size: m.bytes.length,
          ...(typeof body.artifactType === 'string' ? { artifactType: body.artifactType } : {}),
        },
        blobs,
      });
    }
    const legacy = await client.signatureTag(digest, '.sig');
    if (legacy && !seen.has(legacy.digest)) {
      const body = parse(legacy.bytes, 'the .sig manifest');
      this.store.putBytes(legacy.digest, legacy.bytes);
      const blobs = await this.#blobs(client, body, 'the .sig manifest');
      out.push({
        manifest: {
          mediaType: legacy.mediaType,
          digest: legacy.digest,
          size: legacy.bytes.length,
          annotations: { 'org.opencontainers.image.ref.name': `sha256-${digest.slice(7)}.sig` },
        },
        blobs,
      });
    }
    return out;
  }

  /** Words with every known secret taken out (the read token, bearers it was exchanged for). */
  #clean(msg: string): string {
    const values = [this.#deps.token?.(), ...this.#scrub.values()]
      .filter((v): v is string => typeof v === 'string' && v.length >= 8)
      .sort((a, b) => b.length - a.length);
    return values.reduce((m, v) => m.split(v).join('[redacted]'), msg);
  }

  #persist(): void {
    this.store.writeIndex(this.#index);
  }

  #now(): string {
    return (this.#deps.now?.() ?? new Date()).toISOString();
  }
}
