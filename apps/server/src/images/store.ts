// The image mirror's content-addressed store (issue #140): `<dataDir>/images/blobs/sha256/<hex>`,
// and `<dataDir>/images/index.json` recording which images are complete. A blob is written to a
// temporary file while its SHA-256 is computed and moved into place only when it matches its
// digest: a mismatch deletes the partial file, so a blob in the store is always what it names.
import { createHash, randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DIGEST } from './registry.js';

/** A descriptor as the store records it (OCI's shape, the fields the layout needs). */
export type Descriptor = {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
};

export type ImageState = 'pending' | 'fetching' | 'complete' | 'failed';

/** One mirrored image, keyed `<name>@<index digest>`. */
export type ImageRecord = {
  name: string;
  registry: string;
  /** The index digest the lock names. */
  digest: string;
  state: ImageState;
  /** Why the last attempt failed, in words that hold no secret. */
  error?: string;
  attempts: number;
  updatedAt: string;
  /** The index manifest itself. */
  index?: Descriptor;
  /** Each mirrored platform (`linux/amd64`): its manifest and the blobs it references. */
  platforms: Record<string, { manifest: Descriptor; blobs: Descriptor[] }>;
  /** The cosign signature artifacts of the index digest: each manifest and its blobs. */
  signatures: { manifest: Descriptor; blobs: Descriptor[] }[];
  /** Bytes of every blob the image holds, counted once. */
  size: number;
};

export type MirrorIndex = {
  version: 1;
  /** Keys (`<name>@<digest>`) of the current lock's mirrored images. */
  current: string[];
  /** The lock before it: still served, so sticks on the previous release keep working. */
  previous: string[];
  images: Record<string, ImageRecord>;
};

export class DigestMismatch extends Error {}

/** A blob the registry served more of than it declared, or than the caller's cap allows. */
export class BlobTooLarge extends DigestMismatch {}

export const imageKey = (name: string, digest: string): string => `${name}@${digest}`;

const emptyIndex = (): MirrorIndex => ({
  version: 1,
  current: [],
  previous: [],
  images: {},
});

/** Every digest a record names: its index, each platform's manifest and blobs, each signature's. */
export function referencedDigests(rec: ImageRecord): string[] {
  return [
    ...(rec.index ? [rec.index.digest] : []),
    ...Object.values(rec.platforms ?? {}).flatMap((p) => [
      p.manifest.digest,
      ...p.blobs.map((b) => b.digest),
    ]),
    ...(rec.signatures ?? []).flatMap((s) => [s.manifest.digest, ...s.blobs.map((b) => b.digest)]),
  ];
}

export type StoreOptions = {
  /** Deletes one file (tests inject a failing one). */
  unlink?: (path: string) => void;
};

export class ImageStore {
  readonly blobDir: string;
  readonly #tmp: string;
  readonly #indexPath: string;
  readonly #unlink: (path: string) => void;

  constructor(
    readonly dir: string,
    o: StoreOptions = {},
  ) {
    this.#unlink = o.unlink ?? unlinkSync;
    this.blobDir = join(dir, 'blobs', 'sha256');
    this.#tmp = join(dir, 'tmp');
    this.#indexPath = join(dir, 'index.json');
    mkdirSync(this.blobDir, { recursive: true });
    // A partial file left by a crash is never a blob: start the temporary directory empty.
    rmSync(this.#tmp, { recursive: true, force: true });
    mkdirSync(this.#tmp, { recursive: true });
  }

  blobPath(digest: string): string {
    if (!DIGEST.test(digest)) throw new Error(`not a digest: ${digest}`);
    return join(this.blobDir, digest.slice(7));
  }

  has(digest: string): boolean {
    return existsSync(this.blobPath(digest));
  }

  size(digest: string): number {
    return statSync(this.blobPath(digest)).size;
  }

  read(digest: string): Buffer {
    return readFileSync(this.blobPath(digest));
  }

  /** Stores bytes already in memory (a manifest), checked against `digest`. */
  putBytes(digest: string, bytes: Uint8Array): void {
    const target = this.blobPath(digest);
    const got = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (got !== digest) throw new DigestMismatch(`${digest}: the bytes served hash to ${got}`);
    if (existsSync(target)) return;
    const tmp = this.#tmpPath(digest);
    writeFileSync(tmp, bytes);
    renameSync(tmp, target);
  }

  /**
   * Streams a blob into the store, hashing as it arrives. It lands only when the bytes hash to
   * `digest` (and are no more than `size`, when known, nor than `max`); otherwise the partial file
   * is deleted and `DigestMismatch` thrown (`BlobTooLarge` when it was too many bytes).
   */
  async putStream(
    digest: string,
    body: AsyncIterable<Uint8Array>,
    size: number | undefined,
    max?: number,
  ): Promise<void> {
    if (max !== undefined && size !== undefined && size > max) {
      for await (const _ of body) break;
      throw new BlobTooLarge(`${digest}: ${size} bytes is over the ${max} byte cap`);
    }
    const target = this.blobPath(digest);
    if (existsSync(target)) {
      for await (const _ of body) break;
      return;
    }
    const tmp = this.#tmpPath(digest);
    const hash = createHash('sha256');
    const out = createWriteStream(tmp, { mode: 0o644 });
    let total = 0;
    try {
      for await (const chunk of body) {
        total += chunk.byteLength;
        if (size !== undefined && total > size)
          throw new BlobTooLarge(`${digest}: the registry served more than its ${size} bytes`);
        if (max !== undefined && total > max)
          throw new BlobTooLarge(`${digest}: the registry served more than the ${max} byte cap`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r));
      }
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve())),
      );
      const got = `sha256:${hash.digest('hex')}`;
      if (got !== digest) throw new DigestMismatch(`${digest}: the bytes served hash to ${got}`);
      if (size !== undefined && total !== size)
        throw new DigestMismatch(`${digest}: the registry served ${total} of ${size} bytes`);
      renameSync(tmp, target);
    } catch (e) {
      // Wait for the stream to close: it opens its file lazily, and could create it after the rm.
      if (!out.closed) await new Promise<void>((r) => out.destroy().once('close', () => r()));
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  /** Bytes of every blob in the store, on disk. */
  bytesOnDisk(): number {
    let total = 0;
    for (const e of readdirSync(this.blobDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      try {
        total += statSync(join(this.blobDir, e.name)).size;
      } catch {
        // Gone since the listing: it counts for nothing.
      }
    }
    return total;
  }

  /**
   * Deletes every file in the blob directory whose digest `keep` does not hold (issue #426). Only
   * the blob directory is listed: the temporary directory and `index.json` are never touched. A
   * file that cannot be deleted is reported to `onError` and the rest are still deleted; a failure
   * to list the directory throws, having deleted nothing.
   */
  removeUnreferenced(
    keep: Set<string>,
    onError?: (file: string, e: unknown) => void,
  ): { removed: number; bytes: number } {
    let removed = 0;
    let bytes = 0;
    for (const e of readdirSync(this.blobDir, { withFileTypes: true })) {
      if (!e.isFile() || keep.has(`sha256:${e.name}`)) continue;
      const path = join(this.blobDir, e.name);
      try {
        const size = statSync(path).size;
        this.#unlink(path);
        removed++;
        bytes += size;
      } catch (err) {
        onError?.(e.name, err);
      }
    }
    return { removed, bytes };
  }

  readIndex(): MirrorIndex {
    if (!existsSync(this.#indexPath)) return emptyIndex();
    try {
      const raw = JSON.parse(readFileSync(this.#indexPath, 'utf8')) as Partial<MirrorIndex>;
      if (raw.version !== 1 || typeof raw.images !== 'object' || raw.images === null)
        return emptyIndex();
      return {
        version: 1,
        current: Array.isArray(raw.current) ? raw.current : [],
        previous: Array.isArray(raw.previous) ? raw.previous : [],
        images: raw.images,
      };
    } catch {
      return emptyIndex();
    }
  }

  writeIndex(index: MirrorIndex): void {
    const tmp = join(this.#tmp, `index-${randomBytes(6).toString('hex')}.json`);
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmp, this.#indexPath);
  }

  #tmpPath(digest: string): string {
    return join(this.#tmp, `${digest.slice(7)}.${randomBytes(6).toString('hex')}.partial`);
  }
}
