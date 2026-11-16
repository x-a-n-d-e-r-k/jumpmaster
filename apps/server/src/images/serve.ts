// One mirrored image for one platform as an OCI image layout tar (issue #140), for a stick to
// load and verify. It follows cosign's local-layout conventions (sigstore/cosign
// pkg/oci/layout), which find entries by their `kind` annotation:
// - the platform manifest, named with the original reference: the image a stick loads;
// - the signed multi-arch index under kind `dev.cosignproject.cosign/imageIndex`: the bytes the
//   signatures name (the index's digest), not the platform manifest's;
// - a legacy `sha256-<hex>.sig` signature image under kind `dev.cosignproject.cosign/sigs`;
// - OCI 1.1 signature referrers (sigstore bundles) listed with their artifactType and no kind,
//   which the stick and the installer verify on the index bytes, offline (issue #167).
// This layout is never loaded as it is: it serves verification (issue #167). Sticks and the
// installer load only a tar they build from the verified files (issue #168): a sparse index,
// named `<registry>/<name>@<index digest>`, with one platform's blobs and no signature.
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Lookup } from './mirror.js';
import type { Descriptor, ImageRecord } from './store.js';

const BLOCK = 512;

export const LAYOUT_ANNOTATIONS = {
  /** The reference a stick asked for, `<registry>/<name>@<index digest>`. */
  refName: 'org.opencontainers.image.ref.name',
  /** The name containerd and `docker load` give the loaded image. */
  containerdName: 'io.containerd.image.name',
  /** The multi-arch index this manifest belongs to: the digest the signatures name. */
  index: 'dev.jumpmaster.image.index',
  /** On a signature artifact: the digest it signs. */
  signs: 'dev.jumpmaster.signature.of',
} as const;

/** cosign's local OCI layout annotations: `kind` says what an index.json entry is. */
export const COSIGN_LAYOUT = {
  kind: 'kind',
  imageIndex: 'dev.cosignproject.cosign/imageIndex',
  sigs: 'dev.cosignproject.cosign/sigs',
} as const;

const LEGACY_SIG = /^sha256-[0-9a-f]{64}\.sig$/;

/** What a request for a layout gets: the tar, or why not. */
export type LayoutAnswer =
  | { ok: true; size: number; etag: string; stream(): Readable }
  | { ok: false; status: 404; body: { error: string; state?: string } };

type Entry = { name: string; size: number; dir?: true } & (
  | { bytes: Buffer }
  | { path: string }
  | { dir: true }
);

const pad = (n: number): number => (BLOCK - (n % BLOCK)) % BLOCK;

/** A ustar header for a regular file (or a directory) owned by root, mode 0644 (0755). */
export function tarHeader(name: string, size: number, dir = false): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar name too long: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  const octal = (v: number, len: number) => `${v.toString(8).padStart(len - 1, '0')}\0`;
  h.write(name, 0, 100, 'utf8');
  h.write(octal(dir ? 0o755 : 0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(dir ? 0 : size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(dir ? '5' : '0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** The record's state as a stick reads it: `failed: <reason>` for a failure. */
export const stateWords = (r: ImageRecord): string =>
  r.state === 'failed' ? `failed: ${r.error ?? 'unknown'}` : r.state;

/**
 * The layout of `<name>@<digest>` for `platform`, or a 404 naming why: not in the current or the
 * previous lock, not fully mirrored (with its state), or no such platform.
 */
export function layoutFor(lookup: Lookup, platform: string): LayoutAnswer {
  if (!lookup.listed) return { ok: false, status: 404, body: { error: 'not in the image lock' } };
  const { record: r, store } = lookup;
  if (!lookup.complete || !r.index)
    return { ok: false, status: 404, body: { error: 'not mirrored', state: stateWords(r) } };
  const p = Object.hasOwn(r.platforms, platform) ? r.platforms[platform] : undefined;
  if (!p) return { ok: false, status: 404, body: { error: 'unknown platform' } };

  const [os, architecture] = platform.split('/');
  const ref = `${r.registry}/${r.name}@${r.digest}`;
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        ...p.manifest,
        platform: { os, architecture },
        annotations: {
          [LAYOUT_ANNOTATIONS.refName]: ref,
          [LAYOUT_ANNOTATIONS.containerdName]: ref,
          [LAYOUT_ANNOTATIONS.index]: r.digest,
        },
      },
      { ...r.index, annotations: { [COSIGN_LAYOUT.kind]: COSIGN_LAYOUT.imageIndex } },
      ...r.signatures.map((s) => {
        const { [LAYOUT_ANNOTATIONS.refName]: tag, ...rest } = s.manifest.annotations ?? {};
        const legacy = !s.manifest.artifactType && tag !== undefined && LEGACY_SIG.test(tag);
        return {
          ...s.manifest,
          annotations: {
            ...rest,
            ...(legacy ? { [COSIGN_LAYOUT.kind]: COSIGN_LAYOUT.sigs } : {}),
            [LAYOUT_ANNOTATIONS.signs]: r.digest,
          },
        };
      }),
    ],
  };
  const [config, ...layers] = p.blobs;
  const blobPath = (d: Descriptor) => `blobs/sha256/${d.digest.slice(7)}`;
  const dockerManifest = config
    ? [{ Config: blobPath(config), RepoTags: [], Layers: layers.map(blobPath) }]
    : [];
  const blobs = new Map<string, Descriptor>();
  for (const d of [
    r.index,
    p.manifest,
    ...p.blobs,
    ...r.signatures.flatMap((s) => [s.manifest, ...s.blobs]),
  ])
    blobs.set(d.digest, d);
  for (const d of blobs.values())
    if (!store.has(d.digest) || store.size(d.digest) !== d.size)
      return {
        ok: false,
        status: 404,
        body: {
          error: 'not mirrored',
          state: `failed: blob ${d.digest} is missing from the store`,
        },
      };

  const layout = Buffer.from('{"imageLayoutVersion":"1.0.0"}');
  const indexBytes = Buffer.from(JSON.stringify(index));
  const dockerBytes = Buffer.from(JSON.stringify(dockerManifest));
  const entries: Entry[] = [
    { name: 'oci-layout', size: layout.length, bytes: layout },
    { name: 'index.json', size: indexBytes.length, bytes: indexBytes },
    { name: 'manifest.json', size: dockerBytes.length, bytes: dockerBytes },
    { name: 'blobs/', size: 0, dir: true },
    { name: 'blobs/sha256/', size: 0, dir: true },
    ...[...blobs.values()].map(
      (d): Entry => ({
        name: blobPath(d),
        size: d.size,
        path: store.blobPath(d.digest),
      }),
    ),
  ];
  const size =
    entries.reduce((n, e) => n + BLOCK + (e.dir ? 0 : e.size + pad(e.size)), 0) + 2 * BLOCK;
  return {
    ok: true,
    size,
    etag: `"${p.manifest.digest}"`,
    stream: () => Readable.from(tarChunks(entries)),
  };
}

async function* tarChunks(entries: Entry[]): AsyncGenerator<Buffer> {
  for (const e of entries) {
    yield tarHeader(e.name, e.size, e.dir === true);
    if (e.dir) continue;
    if ('bytes' in e) yield e.bytes;
    else if ('path' in e) for await (const c of createReadStream(e.path)) yield c as Buffer;
    const p = pad(e.size);
    if (p > 0) yield Buffer.alloc(p, 0);
  }
  yield Buffer.alloc(2 * BLOCK, 0);
}
