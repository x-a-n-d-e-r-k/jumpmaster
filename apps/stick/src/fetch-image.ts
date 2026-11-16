// Fetching a missing image from the Jumpmaster server (issue #141), so a stick needs to reach
// only its server. The server sends one platform of a mirrored release image as an OCI image
// layout tar; the stick trusts none of it:
// - the tar is extracted in one pass under the state directory, refusing any link, absolute or
//   `..` path, or name a layout doesn't have, and over 8 GB; every blob must hash to its name;
// - the layout is bound to the digest asked for: that digest's blob is the multi-arch index and
//   its entry for this stick's platform is the manifest loaded, so the image id the engine must
//   report is the index digest (Docker's containerd store) or that manifest's config (classic);
// - under `signed`, the release workflow's Sigstore bundle on the digest asked for is checked
//   with `cosign verify-blob-attestation` on the index's bytes, fully offline against the trusted
//   root the stick image ships (issue #167; a pin or a digest verified before needs none);
// - only then is the image loaded (a tar the stick builds from the files it checked: a sparse
//   index, this platform alone, named by the digest reference; issue #168), its id checked, and
//   it is named by its digest reference.
// The temporary directory is removed whatever happens. A stick in `server` mode never contacts
// the registry; an image the server has not mirrored yet makes the drop wait.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ImageFetch } from '@jumpmaster/protocol';
import type { StickClient } from './client.js';
import type { ImageLoader } from './driver.js';
import type { ImageSource } from './pull.js';
import {
  canonicalRef,
  digestOf,
  type ImageTrust,
  type Verdict,
  verifiedWithoutSignature,
  verifyLayout,
} from './verify.js';

/** The largest layout tar a stick accepts. */
export const FETCH_CAP_BYTES = 8 * 1024 ** 3;
/** The whole fetch: download, verification and load. */
export const FETCH_TIMEOUT_MS = 30 * 60_000;
/** Progress goes to the server at most this often. */
export const FETCH_PROGRESS_MS = 2_000;
/** `oci-layout`, `index.json` and `manifest.json` are small; and so are an index and a manifest. */
const META_CAP_BYTES = 4 * 1024 * 1024;

const BLOCK = 512;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LAYOUT_FILES = new Set(['oci-layout', 'index.json', 'manifest.json']);
const LAYOUT_DIRS = new Set(['blobs', 'blobs/sha256']);

export type ServerImageDeps = {
  client: Pick<StickClient, 'imageLayout' | 'reportImageFetch'>;
  loader: ImageLoader;
  /** The stick's state directory: downloads go to a temporary directory under it. */
  stateDir: string;
  /** The stick's own platform, `os/architecture` (see `stickPlatform`). */
  platform: string;
  log: (line: string) => void;
  capBytes?: number;
  timeoutMs?: number;
  progressMs?: number;
  /** Milliseconds, for the progress throttle. */
  now?: () => number;
};

/** Where missing images come from, decided per use, and how to fetch from the server. */
export type ServerImages = { source: () => ImageSource; deps: ServerImageDeps };

/** A fetch's outcome: `wait` when the server has not mirrored the image yet. */
export type Fetched = Verdict | { ok: false; reason: string; wait: true };

/** The server-fetch deps when this stick fetches from its server now; undefined: the registry. */
export function fromServer(trust: ImageTrust): ServerImageDeps | undefined {
  return trust.server?.source() === 'server' ? trust.server.deps : undefined;
}

const ARCH: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'arm',
  ia32: '386',
  ppc64: 'ppc64le',
  s390x: 's390x',
  riscv64: 'riscv64',
};

/** This stick's platform as an image index names it. */
export function stickPlatform(arch: string = process.arch): string {
  return `linux/${ARCH[arch] ?? arch}`;
}

/** A refusal of the layout the server sent: nothing of it is loaded. */
class LayoutRefused extends Error {}

/** Reads a byte stream in exact pieces, counting every byte against the cap. */
class Bytes {
  readonly #it: AsyncIterator<Uint8Array>;
  #buf: Buffer = Buffer.alloc(0);
  #eof = false;
  #count = 0;

  constructor(
    src: AsyncIterable<Uint8Array>,
    private readonly onBytes: (count: number) => void,
  ) {
    this.#it = src[Symbol.asyncIterator]();
  }

  async #more(): Promise<boolean> {
    if (this.#eof) return false;
    const n = await this.#it.next();
    if (n.done) {
      this.#eof = true;
      return false;
    }
    const b = Buffer.from(n.value);
    this.#count += b.length;
    this.onBytes(this.#count);
    this.#buf = this.#buf.length === 0 ? b : Buffer.concat([this.#buf, b]);
    return true;
  }

  /** Exactly `n` bytes; null at the end of the stream; throws when it ends part-way. */
  async exact(n: number): Promise<Buffer | null> {
    while (this.#buf.length < n) {
      if (await this.#more()) continue;
      if (this.#buf.length === 0) return null;
      throw new LayoutRefused('the tar ends part-way through an entry');
    }
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  /** The next `n` bytes, in pieces as they arrive. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.#buf.length === 0 && !(await this.#more()))
        throw new LayoutRefused('the tar ends part-way through an entry');
      const piece = this.#buf.subarray(0, Math.min(left, this.#buf.length));
      this.#buf = this.#buf.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }

  /** Reads to the end and discards it (still counted against the cap). */
  async drain(): Promise<void> {
    this.#buf = Buffer.alloc(0);
    while (await this.#more()) this.#buf = Buffer.alloc(0);
  }

  /** Stops reading: the rest of the stream is not wanted. */
  async close(): Promise<void> {
    await this.#it.return?.().catch(() => {});
  }
}

const field = (h: Buffer, start: number, len: number): string => {
  const raw = h.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return (nul < 0 ? raw : raw.subarray(0, nul)).toString('utf8');
};

/** One ustar header: its name (with the ustar prefix), size and type, checksum checked. */
function parseHeader(h: Buffer): { name: string; size: number; type: string } {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
  const declared = Number.parseInt(field(h, 148, 8).trim(), 8);
  if (declared !== sum) throw new LayoutRefused('a tar header with a bad checksum');
  if (((h[124] as number) & 0x80) !== 0)
    throw new LayoutRefused('a tar entry with a base-256 size');
  const sizeText = field(h, 124, 12).trim();
  if (!/^[0-7]+$/.test(sizeText)) throw new LayoutRefused('a tar entry with no size');
  const size = Number.parseInt(sizeText, 8);
  const name = field(h, 0, 100);
  const ustar = h.subarray(257, 262).toString('latin1') === 'ustar';
  const prefix = ustar ? field(h, 345, 155) : '';
  const flag = h[156] as number;
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size,
    type: flag === 0 ? '0' : String.fromCharCode(flag),
  };
}

/** The layout path of an entry, or why it is refused. Links and odd types never get this far. */
function entryPath(name: string, type: string): string {
  if (type === '1' || type === '2')
    throw new LayoutRefused(`a ${type === '2' ? 'symlink' : 'hard link'} entry (${name})`);
  if (type !== '0' && type !== '5')
    throw new LayoutRefused(`an entry of tar type ${JSON.stringify(type)} (${name})`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw new LayoutRefused(`an absolute path (${name})`);
  if (/[\\\0]/.test(name)) throw new LayoutRefused(`an entry name with a backslash (${name})`);
  const parts = name.split('/');
  if (parts.includes('..')) throw new LayoutRefused(`a path outside the layout (${name})`);
  const clean = parts.filter((p) => p !== '' && p !== '.').join('/');
  const known =
    type === '5'
      ? LAYOUT_DIRS.has(clean)
      : LAYOUT_FILES.has(clean) ||
        (clean.startsWith('blobs/sha256/') && HEX64.test(clean.slice('blobs/sha256/'.length)));
  if (!known) throw new LayoutRefused(`an entry an image layout does not have (${name})`);
  return clean;
}

/**
 * Extracts an OCI image layout tar into `dir` (which must exist and be empty), entry by entry.
 * Refuses (throws) on a link, an absolute or `..` path, a name a layout doesn't have, a duplicate,
 * a blob whose content doesn't hash to its name, and more than `cap` bytes read in all. Nothing
 * is ever written outside `dir`.
 */
export async function extractLayout(
  src: AsyncIterable<Uint8Array>,
  dir: string,
  o: { cap: number; onBytes?: (count: number) => void },
): Promise<void> {
  const bytes = new Bytes(src, (count) => {
    if (count > o.cap) throw new LayoutRefused(`more than the ${o.cap}-byte cap`);
    o.onBytes?.(count);
  });
  const seen = new Set<string>();
  try {
    for (;;) {
      const h = await bytes.exact(BLOCK);
      if (!h) throw new LayoutRefused('a tar with no end marker');
      if (h.every((b) => b === 0)) {
        // The second end block and any padding the writer added: read, so the whole download
        // is counted.
        await bytes.drain();
        return;
      }
      const e = parseHeader(h);
      const path = entryPath(e.name, e.type);
      if (seen.has(path)) throw new LayoutRefused(`a duplicate entry (${e.name})`);
      seen.add(path);
      const pad = (BLOCK - (e.size % BLOCK)) % BLOCK;
      if (e.type === '5') {
        if (e.size !== 0) throw new LayoutRefused(`a directory with content (${e.name})`);
        mkdirSync(join(dir, path), { recursive: true, mode: 0o700 });
        continue;
      }
      const blob = path.startsWith('blobs/') ? path.slice('blobs/sha256/'.length) : undefined;
      if (!blob && e.size > META_CAP_BYTES)
        throw new LayoutRefused(`${path} of ${e.size} bytes, over ${META_CAP_BYTES}`);
      if (blob) mkdirSync(join(dir, 'blobs', 'sha256'), { recursive: true, mode: 0o700 });
      const hash = createHash('sha256');
      // `wx`: never through an existing file or link.
      const f = await open(join(dir, path), 'wx', 0o600);
      try {
        for await (const piece of bytes.take(e.size)) {
          hash.update(piece);
          await f.write(piece);
        }
      } finally {
        await f.close();
      }
      if (blob && hash.digest('hex') !== blob)
        throw new LayoutRefused(`blob sha256:${blob} does not match its digest`);
      if (pad > 0 && !(await bytes.exact(pad)))
        throw new LayoutRefused('the tar ends part-way through an entry');
    }
  } finally {
    await bytes.close();
  }
}

type Descriptor = { mediaType: string; digest: string; size: number };

/** What the layout holds for this stick, bound to the digest asked for. */
export type BoundLayout = {
  /** The signed multi-arch index: the digest asked for, and its blob's size. */
  index: { digest: string; size: number };
  /** The platform manifest the signed index names for this stick's platform. */
  manifest: Descriptor & { platform: Record<string, string> };
  /** Its config digest: the image id the engine must report. */
  config: string;
  layers: string[];
};

/** The path of a blob the layout must hold. */
function blobPath(dir: string, digest: unknown, what: string): string {
  if (typeof digest !== 'string' || !DIGEST.test(digest))
    throw new LayoutRefused(`${what} has no sha256 digest`);
  const path = join(dir, 'blobs', 'sha256', digest.slice(7));
  if (!existsSync(path)) throw new LayoutRefused(`${what} ${digest} is not in the layout`);
  return path;
}

/** A small blob's content (an index or a manifest), capped. */
function blob(dir: string, digest: unknown, what: string): Buffer {
  const path = blobPath(dir, digest, what);
  if (statSync(path).size > META_CAP_BYTES) throw new LayoutRefused(`${what} is too large`);
  return readFileSync(path);
}

function json(b: Buffer, what: string): Record<string, unknown> {
  if (b.length > META_CAP_BYTES) throw new LayoutRefused(`${what} is too large`);
  try {
    const v = JSON.parse(b.toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // below
  }
  throw new LayoutRefused(`${what} is not JSON`);
}

/**
 * Binds the extracted layout to `digest`: its blob is the image index the signatures name, whose
 * entry for `platform` is the manifest to load, whose config and layers are all present. Every
 * blob was hashed on extraction, so what is read here is exactly what the digests name.
 */
export function bindLayout(dir: string, digest: string, platform: string): BoundLayout {
  const indexBytes = blob(dir, digest, 'the image index');
  const index = json(indexBytes, 'the image index');
  const manifests = Array.isArray(index.manifests) ? index.manifests : [];
  const [os, architecture, variant] = platform.split('/');
  const entry = manifests.find((m: unknown) => {
    const p = (m as { platform?: Record<string, unknown> } | null)?.platform;
    return (
      p?.os === os &&
      p?.architecture === architecture &&
      (variant === undefined || p?.variant === variant)
    );
  }) as (Partial<Descriptor> & { platform: Record<string, string> }) | undefined;
  if (!entry) throw new LayoutRefused(`the image index has no ${platform} image`);
  const m = json(blob(dir, entry.digest, 'the platform manifest'), 'the platform manifest');
  const config = (m.config as { digest?: unknown } | undefined)?.digest;
  blobPath(dir, config, 'the image config');
  const layers = (Array.isArray(m.layers) ? m.layers : []).map(
    (l: unknown) => (l as { digest?: unknown } | null)?.digest,
  );
  for (const l of layers) blobPath(dir, l, 'a layer');
  return {
    index: { digest, size: indexBytes.length },
    manifest: {
      mediaType:
        typeof entry.mediaType === 'string'
          ? entry.mediaType
          : 'application/vnd.oci.image.manifest.v1+json',
      digest: entry.digest as string,
      size: typeof entry.size === 'number' ? entry.size : 0,
      platform: entry.platform,
    },
    config: config as string,
    layers: layers as string[],
  };
}

/** A ustar header for a regular file owned by root, mode 0644. */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  const octal = (v: number, len: number) => `${v.toString(8).padStart(len - 1, '0')}\0`;
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** The OCI media type of an image index. */
export const IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';

/**
 * The `index.json` of the tar `docker load` gets: exactly one entry, the signed multi-arch index
 * (a sparse one: only this platform's blobs travel), named `<registry>/<name>@<index digest>` for
 * the containerd image store, which then resolves that reference to the index digest (issue
 * #168). The installer writes the same bytes in shell (apps/server/src/install/stick-sh.ts).
 */
export function loadIndexJson(bound: BoundLayout, ref: string): Buffer {
  const name = canonicalRef(ref);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: IMAGE_INDEX_MEDIA_TYPE,
      manifests: [
        {
          mediaType: IMAGE_INDEX_MEDIA_TYPE,
          digest: bound.index.digest,
          size: bound.index.size,
          annotations: {
            'io.containerd.image.name': name,
            'org.opencontainers.image.ref.name': name,
          },
        },
      ],
    }),
  );
}

/**
 * The tar `docker load` gets: built by the stick from the files it checked, holding the sparse
 * index, this platform's manifest, config and layers (no signature artifact, no other platform),
 * named `ref` for the containerd image store and listed in `manifest.json` for the classic one.
 */
export function loadTar(dir: string, bound: BoundLayout, ref: string): Readable {
  const path = (d: string) => `blobs/sha256/${d.slice(7)}`;
  const docker = [{ Config: path(bound.config), RepoTags: [], Layers: bound.layers.map(path) }];
  const files: { name: string; bytes?: Buffer; file?: string }[] = [
    { name: 'oci-layout', bytes: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    { name: 'index.json', bytes: loadIndexJson(bound, ref) },
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(docker)) },
    ...[...new Set([bound.index.digest, bound.manifest.digest, bound.config, ...bound.layers])].map(
      (d) => ({
        name: path(d),
        file: join(dir, path(d)),
      }),
    ),
  ];
  async function* chunks(): AsyncGenerator<Buffer> {
    for (const f of files) {
      const body = f.bytes;
      if (body) {
        yield tarHeader(f.name, body.length);
        yield body;
        const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
        if (pad > 0) yield Buffer.alloc(pad, 0);
        continue;
      }
      const file = f.file as string;
      const size = statSync(file).size;
      yield tarHeader(f.name, size);
      for await (const c of createReadStream(file)) yield c as Buffer;
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad > 0) yield Buffer.alloc(pad, 0);
    }
    yield Buffer.alloc(2 * BLOCK, 0);
  }
  return Readable.from(chunks());
}

/** Progress to the server, at most once every `every` ms, in order, never failing the fetch. */
function progressReporter(ref: string, deps: ServerImageDeps) {
  const every = deps.progressMs ?? FETCH_PROGRESS_MS;
  const now = deps.now ?? Date.now;
  let last = Number.NEGATIVE_INFINITY;
  let chain = Promise.resolve();
  const send = (p: ImageFetch | null) => {
    chain = chain.then(() => deps.client.reportImageFetch(p)).catch(() => {});
  };
  return {
    bytes(done: number, total: number) {
      const t = now();
      if (t - last < every) return;
      last = t;
      send({ ref, done, total: Math.max(total, done) });
    },
    /** The last report: `done` of `done` when the download completed; then none. */
    async end(done: number | null) {
      if (done !== null) send({ ref, done, total: done });
      send(null);
      await chain;
    },
  };
}

const message = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0]?.trim().slice(0, 300) ?? '';

/**
 * Downloads `ref`'s layout for this stick's platform into `dir`. A 404 `not mirrored` is a wait,
 * with the state the server gives; any other failure refuses.
 */
async function download(
  ref: string,
  dir: string,
  deps: ServerImageDeps,
  signal: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string; wait?: true }> {
  const cap = deps.capBytes ?? FETCH_CAP_BYTES;
  const failed = (why: string) => ({
    ok: false as const,
    reason: `image fetch failed: ${ref}: ${why}`,
  });
  let res: Response;
  try {
    res = await deps.client.imageLayout(ref, deps.platform, signal);
  } catch (e) {
    return failed(`the server did not answer: ${message(e)}`);
  }
  if (res.status === 404) {
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
      state?: unknown;
    } | null;
    if (body?.error === 'not mirrored')
      return {
        ok: false,
        wait: true,
        reason: `image ${ref} not yet mirrored on the server (${typeof body.state === 'string' ? body.state.slice(0, 200) : 'unknown'})`,
      };
    return failed(
      `not on the server: ${typeof body?.error === 'string' ? body.error.slice(0, 200) : '404'}`,
    );
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    return failed(`the server answered ${res.status}`);
  }
  const length = Number(res.headers.get('content-length') ?? '');
  const total = Number.isSafeInteger(length) && length > 0 ? length : 0;
  if (total > cap) {
    await res.body.cancel().catch(() => {});
    return {
      ok: false,
      reason: `image fetch refused: ${ref}: the layout is ${total} bytes, over the ${cap}-byte cap`,
    };
  }
  const progress = progressReporter(ref, deps);
  let done = 0;
  try {
    await extractLayout(res.body as AsyncIterable<Uint8Array>, dir, {
      cap,
      onBytes: (count) => {
        done = count;
        progress.bytes(count, total);
      },
    });
  } catch (e) {
    await progress.end(null);
    if (e instanceof LayoutRefused)
      return { ok: false, reason: `image fetch refused: ${ref}: the layout has ${e.message}` };
    return failed(message(e));
  }
  await progress.end(done);
  return { ok: true };
}

/**
 * Makes `ref` present on the engine from the server, verified: the `server` mode counterpart of
 * verifying and then pulling. Under `allowlist` the caller has checked the allow-list (the proxy
 * image is allowed only as the proxy); under `signed` this decides, offline. An image already
 * present that needs no signature check is not fetched. Never throws.
 */
export async function fetchFromServer(
  ref: string,
  trust: ImageTrust,
  deps: ServerImageDeps,
): Promise<Fetched> {
  const digest = digestOf(ref);
  // A tag is never fetched, as it is never pulled; under signed it is refused.
  if (!digest)
    return trust.policy === 'signed'
      ? (verifiedWithoutSignature(ref, trust) ?? {
          ok: false,
          reason: `image not verified: ${ref}`,
        })
      : { ok: true, via: 'allowlist' };
  const known: Verdict | null =
    trust.policy === 'allowlist'
      ? { ok: true, via: 'allowlist' }
      : verifiedWithoutSignature(ref, trust);
  if (known && !known.ok) return known;
  if (!known && !trust.cosign)
    return { ok: false, reason: `image not verified: ${ref}: cosign is not available` };
  const present = await deps.loader.imageExists(ref).catch(() => false);
  if (present && known) return known;

  const base = join(deps.stateDir, 'image-fetch');
  let dir: string;
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(base, 'fetch-'));
  } catch (e) {
    return { ok: false, reason: `image fetch failed: ${ref}: ${message(e)}` };
  }
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const got = await download(ref, dir, deps, controller.signal);
    if (!got.ok) return controller.signal.aborted ? timedOut(ref, timeoutMs) : got;
    let bound: BoundLayout;
    try {
      bound = bindLayout(dir, digest, deps.platform);
    } catch (e) {
      if (e instanceof LayoutRefused)
        return { ok: false, reason: `image fetch refused: ${ref}: ${e.message}` };
      throw e;
    }
    let verdict: Verdict = known ?? { ok: false, reason: '' };
    if (!known) {
      verdict = await verifyLayout(dir, ref, trust);
      if (!verdict.ok) {
        deps.log(
          JSON.stringify({
            event: 'image-verify-failed',
            ref,
            via: 'server',
            reason: verdict.reason,
          }),
        );
        return verdict;
      }
    }
    // Verified now; already on the engine, nothing to load.
    if (present) return verdict;
    let ids: string[];
    try {
      ids = await deps.loader.loadImage(loadTar(dir, bound, ref), controller.signal);
    } catch (e) {
      if (controller.signal.aborted) return timedOut(ref, timeoutMs);
      return { ok: false, reason: `image load failed: ${ref}: ${message(e)}` };
    }
    // The containerd image store reports the index digest as the id (the tar names the sparse
    // index); the classic store, the platform config's digest. Both are bound to the digest asked
    // for; anything else is removed and refused.
    const expected = new Set([bound.index.digest, bound.config]);
    const wrong = ids.filter((id) => !expected.has(id));
    const id = ids.find((i) => expected.has(i));
    if (!id || wrong.length > 0) {
      for (const w of wrong) await deps.loader.removeImage(w).catch(() => {});
      return {
        ok: false,
        reason: `image not verified: ${ref}: the engine loaded ${wrong[0] ?? 'no image'}, not the image's index ${bound.index.digest} (containerd store) or config ${bound.config} (classic store)`,
      };
    }
    try {
      await deps.loader.tagImage(id, ref);
    } catch (e) {
      return { ok: false, reason: `image load failed: ${ref}: ${message(e)}` };
    }
    deps.log(JSON.stringify({ event: 'image-fetch', ref, status: 'loaded', id }));
    return verdict;
  } catch (e) {
    return { ok: false, reason: `image fetch failed: ${ref}: ${message(e)}` };
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}

const timedOut = (ref: string, ms: number): Fetched => ({
  ok: false,
  reason: `image fetch failed: ${ref}: timed out after ${ms / 1000}s`,
});
