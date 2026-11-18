// Test helpers for server-hosted images (issue #141): OCI layout tars built in the test, the
// way the server's mirror serves them, and a slow response body.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A tar entry; `type` '2' is a symlink to `link`. */
export type Entry = { name: string; body?: Buffer; type?: string; link?: string };

function header(name: string, size: number, type: string, link = ''): Buffer {
  const h = Buffer.alloc(512, 0);
  const octal = (v: number, len: number) => `${v.toString(8).padStart(len - 1, '0')}\0`;
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = e.body ?? Buffer.alloc(0);
    parts.push(header(e.name, body.length, e.type ?? '0', e.link));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

/** A two-platform release image, as the server's layout for one platform holds it. */
export function release(o: { tamperIndexEntry?: boolean } = {}) {
  const blobs = new Map<string, Buffer>();
  const add = (b: Buffer) => {
    const d = sha(b);
    blobs.set(d, b);
    return d;
  };
  const layer = Buffer.from('layer bytes '.repeat(100));
  const config = Buffer.from(JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: {} }));
  const configDigest = add(config);
  const layerDigest = add(layer);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: config.length,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
          digest: layerDigest,
          size: layer.length,
        },
      ],
    }),
  );
  const manifestDigest = add(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
          platform: { os: 'linux', architecture: 'amd64' },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${'7'.repeat(64)}`,
          size: 10,
          platform: { os: 'linux', architecture: 'arm64' },
        },
      ],
    }),
  );
  const indexDigest = add(index);
  const ref = `ghcr.io/o/jumpmaster-trooper@${indexDigest}`;
  // The release's Sigstore bundle on the index, an OCI 1.1 referrer. cosign is a fake in these
  // tests, so its signature need not match; it is the real v0.4.0-rc.2 bundle, whose certificate
  // carries the release tag the stick's version floor reads (issue #270).
  const bundle = readFileSync(new URL('../fixtures/rc2-stick/bundle.json', import.meta.url));
  const bundleDigest = add(bundle);
  const bundleManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      layers: [
        {
          mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          digest: bundleDigest,
          size: bundle.length,
        },
      ],
      subject: { digest: indexDigest },
    }),
  );
  const bundleManifestDigest = add(bundleManifest);
  const layoutIndex = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: manifestDigest,
          size: manifest.length,
        },
        {
          mediaType: 'application/vnd.oci.image.index.v1+json',
          digest: indexDigest,
          size: index.length,
          annotations: { kind: 'dev.cosignproject.cosign/imageIndex' },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: bundleManifestDigest,
          size: bundleManifest.length,
          artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          annotations: { 'dev.jumpmaster.signature.of': indexDigest },
        },
      ],
    }),
  );
  const entries: Entry[] = [
    { name: 'oci-layout', body: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    { name: 'index.json', body: layoutIndex },
    { name: 'manifest.json', body: Buffer.from('[]') },
    { name: 'blobs/', type: '5' },
    { name: 'blobs/sha256/', type: '5' },
    ...[...blobs].map(([d, body]) => ({ name: `blobs/sha256/${d.slice(7)}`, body })),
  ];
  return {
    entries,
    ref,
    indexDigest,
    manifestDigest,
    configDigest,
    layerDigest,
    bundleDigest,
    blobs,
  };
}

export const PLATFORM = 'linux/amd64';

/** A response body that yields `chunks`, advancing the fake clock between them. */
export function slowBody(
  bytes: Buffer,
  chunk: number,
  tick?: () => void,
): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= bytes.length) return c.close();
      tick?.();
      c.enqueue(new Uint8Array(bytes.subarray(off, off + chunk)));
      off += chunk;
    },
  });
}
