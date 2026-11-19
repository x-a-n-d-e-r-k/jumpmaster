// A fake of the OCI distribution API on a local HTTP port, for the image mirror's tests (issue
// #140). Everything is built in the test: a two-platform index with small random layers, a
// buildx-style attestation manifest, and a cosign signature artifact, published the way the
// release workflow's cosign does (an OCI 1.1 referrer under the `sha256-<hex>` fallback tag) or
// the legacy `sha256-<hex>.sig` tag. No blob is committed.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
export const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip';
export const OCI_EMPTY = 'application/vnd.oci.empty.v1+json';
export const SIGSTORE_BUNDLE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
export const COSIGN_SIMPLESIGNING = 'application/vnd.dev.cosign.simplesigning.v1+json';

export const sha256 = (b: Buffer | string): string =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;

type Descriptor = { mediaType: string; digest: string; size: number; [k: string]: unknown };

export type FakeImage = {
  name: string;
  /** The index digest the lock names. */
  digest: string;
  platforms: Record<string, { manifest: string; blobs: string[] }>;
  /** The signature artifact's manifest digest and its blobs. */
  signature: { manifest: string; blobs: string[] };
};

/**
 * How the signature is published: an OCI 1.1 referrer under the `sha256-<hex>` fallback tag (no
 * referrers API, GHCR's case), the same tag behind a referrers API that answers an empty list,
 * a referrer the referrers API lists, the legacy `.sig` tag, or none.
 */
export type SignatureMode =
  | 'referrers-tag'
  | 'referrers-tag-empty-api'
  | 'referrers-api'
  | 'legacy'
  | 'none';

export type FakeRegistry = {
  /** `127.0.0.1:<port>` */
  host: string;
  /** `<host>/<owner>`: the lock's `registry`. */
  registry: string;
  owner: string;
  /** `sharedLayer`: one more layer on each platform, so images can share a blob. */
  addImage(
    name: string,
    o?: { platforms?: string[]; signatures?: SignatureMode; sharedLayer?: Buffer },
  ): FakeImage;
  /**
   * Publishes one more signature artifact signing `img` where `via` says: listed by the referrers
   * API, in the `sha256-<hex>` fallback tag's list, or as the legacy `.sig` tag (replacing it).
   * `layer` is the artifact's one layer (a small bundle by default); `declaredSize` is the size
   * its descriptor claims; `artifactType` null leaves it out (the config's media type then says).
   */
  addSignature(
    img: FakeImage,
    o?: {
      via?: 'referrers-api' | 'referrers-tag' | 'legacy';
      artifactType?: string | null;
      configMediaType?: string;
      layer?: Buffer;
      declaredSize?: number;
      /** Bytes of padding in an annotation, to grow the manifest. */
      padManifest?: number;
    },
  ): { manifest: string; blobs: string[] };
  /** Serve other bytes for this blob from now on. */
  corrupt(digest: string): void;
  /** Serve the right bytes again. */
  heal(digest: string): void;
  /**
   * Holds every request for this blob until `release()`; `requested` resolves when the first
   * one arrives.
   */
  hold(digest: string): { requested: Promise<void>; release(): void };
  requests: { method: string; path: string; authorization?: string }[];
  /** Bearer tokens handed out by a token exchange made with the read token. */
  exchanged: string[];
  close(): Promise<void>;
};

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

/**
 * Starts the fake. `privateToken` set: anonymous token requests are refused (401), and a Basic
 * exchange whose password is that token answers a fresh bearer. Unset: anonymous is enough.
 */
export async function startFakeRegistry(
  o: { privateToken?: string; owner?: string } = {},
): Promise<FakeRegistry> {
  const owner = o.owner ?? 'jm';
  const blobs = new Map<string, Buffer>();
  const corrupted = new Set<string>();
  const manifests = new Map<string, { mediaType: string; bytes: Buffer }>();
  const referrers = new Map<string, Descriptor[]>();
  const requests: FakeRegistry['requests'] = [];
  const exchanged: string[] = [];
  const valid = new Set<string>();
  const tagLists = new Map<string, Descriptor[]>();
  const held = new Map<string, { arrived: () => void; released: Promise<void> }>();

  const blob = (mediaType: string, bytes: Buffer): Descriptor => {
    const digest = sha256(bytes);
    blobs.set(digest, bytes);
    return { mediaType, digest, size: bytes.length };
  };
  const manifest = (repo: string, mediaType: string, v: unknown, tag?: string): Descriptor => {
    const bytes = json(v);
    const digest = sha256(bytes);
    manifests.set(`${repo}@${digest}`, { mediaType, bytes });
    if (tag) manifests.set(`${repo}:${tag}`, { mediaType, bytes });
    return { mediaType, digest, size: bytes.length };
  };

  const server: Server = createServer((req, res) => {
    void handle(req).then(
      (r) => {
        res.writeHead(r.status, r.headers ?? {});
        res.end(r.body);
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Answer = { status: number; headers?: Record<string, string>; body?: Buffer | string };

  async function handle(req: IncomingMessage): Promise<Answer> {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const authorization = req.headers.authorization;
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      ...(authorization ? { authorization } : {}),
    });
    if (url.pathname === '/token') {
      const basic = /^Basic (.+)$/.exec(authorization ?? '');
      if (basic?.[1]) {
        const [, password] = Buffer.from(basic[1], 'base64').toString().split(':');
        if (!o.privateToken || password !== o.privateToken) return { status: 401 };
        const token = `exchanged-${randomBytes(12).toString('hex')}`;
        exchanged.push(token);
        valid.add(token);
        return { status: 200, body: JSON.stringify({ token }) };
      }
      if (o.privateToken) return { status: 401, body: '{"errors":[{"code":"DENIED"}]}' };
      const token = `anon-${randomBytes(12).toString('hex')}`;
      valid.add(token);
      return { status: 200, body: JSON.stringify({ token }) };
    }
    const bearer = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    if (!bearer || !valid.has(bearer))
      return {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="http://${host}/token",service="fake",scope="repository:${owner}/x:pull"`,
        },
      };
    const m = /^\/v2\/(.+)\/(manifests|blobs|referrers)\/([^/]+)$/.exec(url.pathname);
    if (!m) return { status: 404 };
    const [, repo, kind, ref] = m as unknown as [string, string, string, string];
    if (kind === 'blobs') {
      const h = held.get(ref);
      if (h) {
        h.arrived();
        await h.released;
      }
      const b = blobs.get(ref);
      if (!b) return { status: 404 };
      const body = corrupted.has(ref) ? Buffer.from(b).fill(0x41) : b;
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body };
    }
    if (kind === 'referrers') {
      const list = referrers.get(`${repo}@${ref}`);
      if (!list) return { status: 404 };
      return {
        status: 200,
        headers: { 'content-type': OCI_INDEX },
        body: json({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: list }),
      };
    }
    const key = ref.startsWith('sha256:') ? `${repo}@${ref}` : `${repo}:${ref}`;
    const found = manifests.get(key);
    if (!found) return { status: 404 };
    return {
      status: 200,
      headers: { 'content-type': found.mediaType, 'docker-content-digest': sha256(found.bytes) },
      body: found.bytes,
    };
  }

  return {
    host,
    registry: `${host}/${owner}`,
    owner,
    requests,
    exchanged,
    addSignature(img, o = {}) {
      const repo = `${owner}/${img.name}`;
      const hex = img.digest.slice('sha256:'.length);
      const via = o.via ?? 'referrers-tag';
      const artifactType = o.artifactType === undefined ? SIGSTORE_BUNDLE : o.artifactType;
      const config = blob(o.configMediaType ?? OCI_EMPTY, Buffer.from('{}'));
      const bytes =
        o.layer ?? json({ mediaType: SIGSTORE_BUNDLE, sig: randomBytes(8).toString('hex') });
      const layer = { ...blob(artifactType ?? SIGSTORE_BUNDLE, bytes) };
      if (o.declaredSize !== undefined) layer.size = o.declaredSize;
      const subject = { mediaType: OCI_INDEX, digest: img.digest, size: 0 };
      const body = {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        ...(artifactType !== null && via !== 'legacy' ? { artifactType } : {}),
        config,
        layers: [layer],
        ...(via !== 'legacy' ? { subject } : {}),
        annotations: { pad: 'x'.repeat(o.padManifest ?? 0) },
      };
      if (via === 'legacy') {
        const sig = manifest(repo, OCI_MANIFEST, body, `sha256-${hex}.sig`);
        return { manifest: sig.digest, blobs: [config.digest, layer.digest] };
      }
      const sig = manifest(repo, OCI_MANIFEST, body);
      const desc = { ...sig, ...(artifactType !== null ? { artifactType } : {}) };
      const key = `${repo}@${img.digest}`;
      if (via === 'referrers-api') referrers.set(key, [...(referrers.get(key) ?? []), desc]);
      else {
        const list = [...(tagLists.get(key) ?? []), desc];
        tagLists.set(key, list);
        manifest(
          repo,
          OCI_INDEX,
          { schemaVersion: 2, mediaType: OCI_INDEX, manifests: list },
          `sha256-${hex}`,
        );
      }
      return { manifest: sig.digest, blobs: [config.digest, layer.digest] };
    },
    corrupt: (digest) => corrupted.add(digest),
    heal: (digest) => corrupted.delete(digest),
    hold(digest) {
      let arrived = () => {};
      let release = () => {};
      const requested = new Promise<void>((r) => {
        arrived = r;
      });
      const released = new Promise<void>((r) => {
        release = r;
      });
      held.set(digest, { arrived, released });
      return {
        requested,
        release: () => {
          held.delete(digest);
          release();
        },
      };
    },
    addImage(name, opts = {}) {
      const repo = `${owner}/${name}`;
      const platforms = opts.platforms ?? ['linux/amd64', 'linux/arm64'];
      const out: FakeImage['platforms'] = {};
      const entries: Descriptor[] = [];
      for (const p of platforms) {
        const [os, architecture] = p.split('/') as [string, string];
        const layers = [0, 1].map(() =>
          blob(OCI_LAYER, randomBytes(200 + Math.floor(Math.random() * 900))),
        );
        if (opts.sharedLayer) layers.push(blob(OCI_LAYER, opts.sharedLayer));
        const config = blob(OCI_CONFIG, json({ os, architecture, rootfs: { type: 'layers' } }));
        const m = manifest(repo, OCI_MANIFEST, {
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          config,
          layers,
        });
        out[p] = { manifest: m.digest, blobs: [config.digest, ...layers.map((l) => l.digest)] };
        entries.push({ ...m, platform: { os, architecture } });
      }
      // buildx's provenance attestation: listed in the index, never mirrored.
      const att = blob('application/vnd.in-toto+json', randomBytes(64));
      const attM = manifest(repo, OCI_MANIFEST, {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: blob(OCI_CONFIG, json({})),
        layers: [att],
      });
      entries.push({ ...attM, platform: { os: 'unknown', architecture: 'unknown' } });
      const index = manifest(repo, OCI_INDEX, {
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: entries,
      });
      const hex = index.digest.slice('sha256:'.length);
      const mode = opts.signatures ?? 'referrers-tag';
      let signature: FakeImage['signature'] = { manifest: '', blobs: [] };
      if (mode === 'legacy') {
        const payload = blob(COSIGN_SIMPLESIGNING, json({ critical: { image: index.digest } }));
        const sig = manifest(
          repo,
          OCI_MANIFEST,
          {
            schemaVersion: 2,
            mediaType: OCI_MANIFEST,
            config: blob(OCI_CONFIG, json({ rootfs: { type: 'layers' } })),
            layers: [{ ...payload, annotations: { 'dev.cosignproject.cosign/signature': 'c2ln' } }],
          },
          `sha256-${hex}.sig`,
        );
        signature = { manifest: sig.digest, blobs: [payload.digest] };
      } else if (mode !== 'none') {
        const empty = blob(OCI_EMPTY, Buffer.from('{}'));
        const bundle = blob(SIGSTORE_BUNDLE, json({ mediaType: SIGSTORE_BUNDLE, sig: 'fake' }));
        const sig = manifest(repo, OCI_MANIFEST, {
          schemaVersion: 2,
          mediaType: OCI_MANIFEST,
          artifactType: SIGSTORE_BUNDLE,
          config: empty,
          layers: [bundle],
          subject: index,
          annotations: {
            'dev.sigstore.bundle.predicateType': 'https://sigstore.dev/cosign/sign/v1',
          },
        });
        const desc = { ...sig, artifactType: SIGSTORE_BUNDLE };
        if (mode === 'referrers-api') referrers.set(`${repo}@${index.digest}`, [desc]);
        else {
          if (mode === 'referrers-tag-empty-api') referrers.set(`${repo}@${index.digest}`, []);
          tagLists.set(`${repo}@${index.digest}`, [desc]);
          manifest(
            repo,
            OCI_INDEX,
            { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [desc] },
            `sha256-${hex}`,
          );
        }
        signature = { manifest: sig.digest, blobs: [empty.digest, bundle.digest] };
      }
      return { name, digest: index.digest, platforms: out, signature };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
