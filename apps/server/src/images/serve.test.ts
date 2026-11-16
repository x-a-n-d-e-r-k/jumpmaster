import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ScrubSet } from '../forge/scrub-set.js';
import {
  type FakeImage,
  type FakeRegistry,
  type SignatureMode,
  startFakeRegistry,
} from '../test/fake-registry.js';
import { ImageMirror } from './mirror.js';
import {
  COSIGN_LAYOUT,
  LAYOUT_ANNOTATIONS,
  type LayoutAnswer,
  layoutFor,
  tarHeader,
} from './serve.js';

let fake: FakeRegistry | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A strict ustar reader: every header's checksum, sizes, padding and the two closing blocks. */
function parseTar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  expect(tar.length % 512).toBe(0);
  let off = 0;
  for (;;) {
    const h = tar.subarray(off, off + 512);
    expect(h.length).toBe(512);
    if (h.every((b) => b === 0)) {
      expect(tar.subarray(off + 512, off + 1024).every((b) => b === 0)).toBe(true);
      expect(off + 1024).toBe(tar.length);
      return files;
    }
    const field = (start: number, len: number) =>
      h
        .subarray(start, start + len)
        .toString('ascii')
        .replace(/\0.*$/s, '')
        .trim();
    const name = field(0, 100);
    const size = Number.parseInt(field(124, 12), 8);
    const declared = Number.parseInt(field(148, 8), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    expect(sum, `checksum of ${name}`).toBe(declared);
    expect(h.subarray(257, 263).toString('ascii')).toBe('ustar\0');
    const type = String.fromCharCode(h[156] as number);
    off += 512;
    if (type === '0') {
      expect(files.has(name)).toBe(false);
      files.set(name, Buffer.from(tar.subarray(off, off + size)));
      off += size + ((512 - (size % 512)) % 512);
    } else expect(type).toBe('5');
  }
}

async function read(a: LayoutAnswer): Promise<Buffer> {
  if (!a.ok) throw new Error(JSON.stringify(a.body));
  const chunks: Buffer[] = [];
  for await (const c of a.stream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

type LayoutIndex = {
  schemaVersion: number;
  manifests: {
    mediaType: string;
    digest: string;
    size: number;
    platform?: { os: string; architecture: string };
    annotations?: Record<string, string>;
  }[];
};

async function mirrored(
  signatures: SignatureMode = 'referrers-tag',
): Promise<{ m: ImageMirror; img: FakeImage; dir: string }> {
  fake = await startFakeRegistry();
  const img = fake.addImage('jumpmaster-trooper', { signatures });
  const dir = mkdtempSync(join(tmpdir(), 'jm-serve-'));
  const m = new ImageMirror({
    dataDir: dir,
    scheme: () => 'http',
    scrub: new ScrubSet(),
    log: () => {},
  });
  m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
  expect(await m.syncOnce()).toBe(0);
  return { m, img, dir };
}

describe('the OCI layout a stick downloads (issue #140)', () => {
  test('the amd64 tar is a valid OCI layout: oci-layout, an index naming exactly the amd64 manifest, every blob it references, and the signature', async () => {
    const { m, img } = await mirrored();
    const a = layoutFor(m.lookup(img.name, img.digest), 'linux/amd64');
    const tar = await read(a);
    expect(a.ok && a.size).toBe(tar.length);
    expect(a.ok && a.etag).toBe(`"${img.platforms['linux/amd64']?.manifest}"`);
    const files = parseTar(tar);

    expect(JSON.parse(files.get('oci-layout')?.toString() ?? '')).toEqual({
      imageLayoutVersion: '1.0.0',
    });
    const index = JSON.parse(files.get('index.json')?.toString() ?? '') as LayoutIndex;
    expect(index.schemaVersion).toBe(2);
    const images = index.manifests.filter((d) => d.platform);
    expect(images.map((d) => d.digest)).toEqual([img.platforms['linux/amd64']?.manifest]);
    expect(images[0]?.platform).toEqual({ os: 'linux', architecture: 'amd64' });
    expect(images[0]?.annotations).toMatchObject({
      [LAYOUT_ANNOTATIONS.refName]: `${fake?.registry}/${img.name}@${img.digest}`,
      [LAYOUT_ANNOTATIONS.index]: img.digest,
    });
    // cosign's layout conventions: the signed multi-arch index under kind imageIndex (the digest
    // the signatures name), so the stick verifies the index digest, not the
    // platform manifest's. The bundle referrer carries no cosign kind: it is not a legacy sigs image.
    const kinds = index.manifests.filter((d) => d.annotations?.[COSIGN_LAYOUT.kind]);
    expect(kinds.map((d) => [d.annotations?.[COSIGN_LAYOUT.kind], d.digest])).toEqual([
      [COSIGN_LAYOUT.imageIndex, img.digest],
    ]);
    expect(kinds[0]?.mediaType).toBe('application/vnd.oci.image.index.v1+json');
    expect(kinds[0]?.annotations?.[LAYOUT_ANNOTATIONS.refName]).toBeUndefined();
    const sigs = index.manifests.filter((d) => d.annotations?.[LAYOUT_ANNOTATIONS.signs]);
    expect(sigs.map((d) => d.digest)).toEqual([img.signature.manifest]);
    expect(sigs[0]?.annotations?.[LAYOUT_ANNOTATIONS.signs]).toBe(img.digest);
    // Only the platform manifest is named: nothing else is loaded as a named image.
    expect(
      index.manifests
        .filter((d) => d.annotations?.[LAYOUT_ANNOTATIONS.refName])
        .map((d) => d.digest),
    ).toEqual([img.platforms['linux/amd64']?.manifest]);
    expect(index.manifests).toHaveLength(3);

    // `docker load` on the classic store reads manifest.json: exactly the amd64 image.
    const amd = img.platforms['linux/amd64'];
    expect(JSON.parse(files.get('manifest.json')?.toString() ?? '')).toEqual([
      {
        Config: `blobs/sha256/${amd?.blobs[0]?.slice(7)}`,
        RepoTags: [],
        Layers: (amd?.blobs.slice(1) ?? []).map((d) => `blobs/sha256/${d.slice(7)}`),
      },
    ]);

    // Every blob is what its name says, every descriptor's size is right.
    const blobs = [...files.keys()].filter((f) => f.startsWith('blobs/sha256/'));
    for (const f of blobs) expect(sha(files.get(f) as Buffer)).toBe(`sha256:${f.slice(13)}`);
    for (const d of index.manifests)
      expect(files.get(`blobs/sha256/${d.digest.slice(7)}`)?.length).toBe(d.size);
    const want = [
      img.digest,
      img.platforms['linux/amd64']?.manifest as string,
      ...(img.platforms['linux/amd64']?.blobs ?? []),
      img.signature.manifest,
      ...img.signature.blobs,
    ].map((d) => `blobs/sha256/${d.slice(7)}`);
    expect(blobs.sort()).toEqual([...new Set(want)].sort());
    // The amd64 manifest's own references are all present.
    const manifest = JSON.parse(
      files.get(`blobs/sha256/${img.platforms['linux/amd64']?.manifest.slice(7)}`)?.toString() ??
        '',
    ) as { config: { digest: string }; layers: { digest: string }[] };
    for (const d of [manifest.config, ...manifest.layers])
      expect(files.has(`blobs/sha256/${d.digest.slice(7)}`)).toBe(true);
    // No arm64 content travels with it.
    expect(files.has(`blobs/sha256/${img.platforms['linux/arm64']?.manifest.slice(7)}`)).toBe(
      false,
    );
  });

  test("a legacy .sig signature is the layout's cosign sigs entry, unnamed", async () => {
    const { m, img } = await mirrored('legacy');
    const files = parseTar(await read(layoutFor(m.lookup(img.name, img.digest), 'linux/amd64')));
    const index = JSON.parse(files.get('index.json')?.toString() ?? '') as LayoutIndex;
    const byKind = Object.fromEntries(
      index.manifests
        .filter((d) => d.annotations?.[COSIGN_LAYOUT.kind])
        .map((d) => [d.annotations?.[COSIGN_LAYOUT.kind], d]),
    );
    expect(Object.keys(byKind).sort()).toEqual(
      [COSIGN_LAYOUT.imageIndex, COSIGN_LAYOUT.sigs].sort(),
    );
    expect(byKind[COSIGN_LAYOUT.imageIndex]?.digest).toBe(img.digest);
    const sig = byKind[COSIGN_LAYOUT.sigs];
    expect(sig?.digest).toBe(img.signature.manifest);
    expect(sig?.annotations?.[LAYOUT_ANNOTATIONS.refName]).toBeUndefined();
    expect(sig?.annotations?.[LAYOUT_ANNOTATIONS.signs]).toBe(img.digest);
    for (const d of [sig?.digest ?? '', ...img.signature.blobs])
      expect(files.has(`blobs/sha256/${d.slice(7)}`)).toBe(true);
  });

  test('an arm64 request gives the arm64 manifest', async () => {
    const { m, img } = await mirrored();
    const files = parseTar(await read(layoutFor(m.lookup(img.name, img.digest), 'linux/arm64')));
    const index = JSON.parse(files.get('index.json')?.toString() ?? '') as LayoutIndex;
    expect(index.manifests.filter((d) => d.platform).map((d) => d.digest)).toEqual([
      img.platforms['linux/arm64']?.manifest,
    ]);
  });

  test('an unknown platform is 404', async () => {
    const { m, img } = await mirrored();
    expect(layoutFor(m.lookup(img.name, img.digest), 'linux/s390x')).toEqual({
      ok: false,
      status: 404,
      body: { error: 'unknown platform' },
    });
    expect(layoutFor(m.lookup(img.name, img.digest), 'constructor')).toMatchObject({
      status: 404,
    });
  });

  test('a digest the lock does not list is 404', async () => {
    const { m, img } = await mirrored();
    expect(layoutFor(m.lookup(img.name, `sha256:${'0'.repeat(64)}`), 'linux/amd64')).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not in the image lock' },
    });
    expect(layoutFor(m.lookup('jumpmaster-egress', img.digest), 'linux/amd64')).toMatchObject({
      status: 404,
    });
  });

  test('an image not yet mirrored is 404 with its state', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper');
    const m = new ImageMirror({
      dataDir: mkdtempSync(join(tmpdir(), 'jm-serve-')),
      scheme: () => 'http',
      scrub: new ScrubSet(),
      log: () => {},
    });
    m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    expect(layoutFor(m.lookup(img.name, img.digest), 'linux/amd64')).toEqual({
      ok: false,
      status: 404,
      body: { error: 'not mirrored', state: 'pending' },
    });
    fake.corrupt(img.platforms['linux/amd64']?.blobs[0] as string);
    await m.syncOnce();
    const a = layoutFor(m.lookup(img.name, img.digest), 'linux/amd64');
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.body.state).toMatch(/^failed: /);
  });

  test('a blob gone from the store is not served as a short tar', async () => {
    const { m, img, dir } = await mirrored();
    const layer = img.platforms['linux/amd64']?.blobs[1] as string;
    rmSync(join(dir, 'images', 'blobs', 'sha256', layer.slice(7)));
    expect(layoutFor(m.lookup(img.name, img.digest), 'linux/amd64')).toMatchObject({
      ok: false,
      status: 404,
      body: { error: 'not mirrored' },
    });
  });

  test('tar headers carry a valid checksum and refuse a name too long for ustar', () => {
    const files = parseTar(
      Buffer.concat([tarHeader('a', 1), Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]),
    );
    expect(files.get('a')?.toString()).toBe('x');
    expect(() => tarHeader('x'.repeat(101), 0)).toThrow(/too long/);
  });
});
