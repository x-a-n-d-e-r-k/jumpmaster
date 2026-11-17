import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ScrubSet } from '../forge/scrub-set.js';
import type { ImageLockFile } from '../presets.js';
import {
  COSIGN_SIMPLESIGNING,
  type FakeImage,
  type FakeRegistry,
  SIGSTORE_BUNDLE,
  startFakeRegistry,
} from '../test/fake-registry.js';
import {
  ImageMirror,
  MAX_SIGNATURE_ARTIFACTS,
  MAX_SIGNATURE_BLOB_BYTES,
  type MirrorDeps,
  SIGNATURE_ARTIFACT_TYPES,
} from './mirror.js';
import type { MirrorIndex } from './store.js';

let fake: FakeRegistry | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const tmp = () => mkdtempSync(join(tmpdir(), 'jm-mirror-'));
const hex = (d: string) => d.slice('sha256:'.length);
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const SERVER_DIGEST = `sha256:${'5'.repeat(64)}`;

function mirrorOn(dataDir: string, o: Partial<MirrorDeps> & { logs?: string[] } = {}) {
  const logs = o.logs ?? [];
  return new ImageMirror({
    dataDir,
    scheme: () => 'http',
    scrub: o.scrub ?? new ScrubSet(),
    log: (l) => logs.push(l),
    sleep: async () => {},
    ...o,
  });
}

const indexOf = (dataDir: string): MirrorIndex =>
  JSON.parse(readFileSync(join(dataDir, 'images', 'index.json'), 'utf8')) as MirrorIndex;

describe('the image mirror (issue #140)', () => {
  test('mirrors every lock image for amd64 and arm64 with its signatures, each blob checked', async () => {
    fake = await startFakeRegistry();
    const trooper = fake.addImage('jumpmaster-trooper', { signatures: 'referrers-tag' });
    const egress = fake.addImage('jumpmaster-egress', { signatures: 'legacy' });
    const stick = fake.addImage('jumpmaster-stick', { signatures: 'referrers-api' });
    const lock: ImageLockFile = {
      registry: fake.registry,
      images: {
        'jumpmaster-trooper': trooper.digest,
        'jumpmaster-egress': egress.digest,
        'jumpmaster-stick': stick.digest,
        // The server's own image: no stick runs it, so it is not mirrored.
        'jumpmaster-server': SERVER_DIGEST,
      },
    };
    const dir = tmp();
    const m = mirrorOn(dir);
    m.setLock(lock);
    expect(await m.syncOnce()).toBe(0);

    const idx = indexOf(dir);
    for (const img of [trooper, egress, stick]) {
      const rec = idx.images[`${img.name}@${img.digest}`];
      expect(rec?.state).toBe('complete');
      expect(Object.keys(rec?.platforms ?? {}).sort()).toEqual(['linux/amd64', 'linux/arm64']);
      expect(rec?.signatures.map((s) => s.manifest.digest)).toEqual([img.signature.manifest]);
      const all = [
        img.digest,
        ...Object.values(img.platforms).flatMap((p) => [p.manifest, ...p.blobs]),
        img.signature.manifest,
        ...img.signature.blobs,
      ];
      for (const d of all) {
        const path = join(dir, 'images', 'blobs', 'sha256', hex(d));
        expect(existsSync(path), d).toBe(true);
        expect(sha(readFileSync(path))).toBe(d);
      }
    }
    expect(Object.keys(idx.images).some((k) => k.startsWith('jumpmaster-server'))).toBe(false);
    expect(fake.requests.some((r) => r.path.includes('jumpmaster-server'))).toBe(false);
    expect(m.status()).toMatchObject({ lock: true });
    expect(m.status().images.map((i) => [i.name, i.state])).toEqual([
      ['jumpmaster-egress', 'complete'],
      ['jumpmaster-stick', 'complete'],
      ['jumpmaster-trooper', 'complete'],
    ]);
  });

  test('a referrers API that answers an empty list still has its fallback tag checked', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper', { signatures: 'referrers-tag-empty-api' });
    const dir = tmp();
    const m = mirrorOn(dir);
    m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    expect(await m.syncOnce()).toBe(0);
    const rec = indexOf(dir).images[`${img.name}@${img.digest}`];
    expect(rec?.state).toBe('complete');
    expect(rec?.signatures.map((s) => s.manifest.digest)).toEqual([img.signature.manifest]);
  });

  test('never asks for a tag: manifests by digest, and only the signature tags cosign derives from a lock digest', async () => {
    fake = await startFakeRegistry();
    const a = fake.addImage('jumpmaster-trooper');
    const b = fake.addImage('jumpmaster-egress', { signatures: 'legacy' });
    const m = mirrorOn(tmp());
    m.setLock({ registry: fake.registry, images: { [a.name]: a.digest, [b.name]: b.digest } });
    await m.syncOnce();
    const lockHex = [a.digest, b.digest].map(hex);
    const manifestRefs = fake.requests
      .map((r) => /\/manifests\/(.+)$/.exec(r.path)?.[1])
      .filter((x): x is string => x !== undefined);
    expect(manifestRefs.length).toBeGreaterThan(0);
    for (const ref of manifestRefs) {
      if (/^sha256:[0-9a-f]{64}$/.test(ref)) continue;
      const sig = /^sha256-([0-9a-f]{64})(\.sig)?$/.exec(ref);
      expect(sig, `a tag was requested: ${ref}`).not.toBeNull();
      expect(lockHex).toContain(sig?.[1]);
    }
    expect(manifestRefs).not.toContain('latest');
    // Nothing is asked of the registry again once complete: no polling for newer images.
    const before = fake.requests.length;
    expect(await m.syncOnce()).toBe(0);
    expect(fake.requests.length).toBe(before);
  });

  test('a blob whose bytes do not match its digest never lands, and its image fails', async () => {
    fake = await startFakeRegistry();
    const bad = fake.addImage('jumpmaster-trooper');
    const good = fake.addImage('jumpmaster-egress');
    const layer = bad.platforms['linux/arm64']?.blobs[1] as string;
    fake.corrupt(layer);
    const dir = tmp();
    const logs: string[] = [];
    const m = mirrorOn(dir, { logs });
    m.setLock({
      registry: fake.registry,
      images: { [bad.name]: bad.digest, [good.name]: good.digest },
    });
    expect(await m.syncOnce()).toBe(1);
    expect(existsSync(join(dir, 'images', 'blobs', 'sha256', hex(layer)))).toBe(false);
    expect(readdirSync(join(dir, 'images', 'tmp')).filter((f) => f.endsWith('.partial'))).toEqual(
      [],
    );
    const rec = indexOf(dir).images[`${bad.name}@${bad.digest}`];
    expect(rec?.state).toBe('failed');
    expect(rec?.error).toContain(layer);
    expect(indexOf(dir).images[`${good.name}@${good.digest}`]?.state).toBe('complete');
    expect(logs.some((l) => l.includes('failed') && l.includes(layer))).toBe(true);
  });

  test('an image with no signature is not mirrored: the stick could not verify it', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
    const m = mirrorOn(tmp());
    m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    expect(await m.syncOnce()).toBe(1);
    expect(m.status().images[0]).toMatchObject({ state: 'failed' });
    expect(m.status().images[0]?.error).toMatch(/no cosign signature/);
  });

  test('a single-platform index mirrors the platform it lists', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper', { platforms: ['linux/amd64'] });
    const m = mirrorOn(tmp());
    m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    expect(await m.syncOnce()).toBe(0);
    expect(m.status().images[0]?.platforms).toEqual(['linux/amd64']);
  });

  describe('a private registry', () => {
    const TOKEN = 'ghp_' + 'registryReadTokenValue0123456789';

    test('anonymous is refused, then the read token is exchanged and the bearer it gets is used', async () => {
      fake = await startFakeRegistry({ privateToken: TOKEN });
      const img = fake.addImage('jumpmaster-trooper');
      const dir = tmp();
      const logs: string[] = [];
      const scrub = new ScrubSet();
      const m = mirrorOn(dir, { token: () => TOKEN, logs, scrub });
      m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
      expect(await m.syncOnce()).toBe(0);

      const tokenCalls = fake.requests.filter((r) => r.path === '/token');
      expect(tokenCalls[0]?.authorization).toBeUndefined();
      expect(tokenCalls.some((r) => r.authorization?.startsWith('Basic '))).toBe(true);
      const v2 = fake.requests.filter((r) => r.path.startsWith('/v2/') && r.authorization);
      expect(v2.length).toBeGreaterThan(0);
      for (const r of v2) expect(fake.exchanged).toContain(r.authorization?.slice(7));
      expect(r0(v2).authorization).toMatch(/^Bearer exchanged-/);
      // Registered for the log scrub, and never written anywhere.
      expect(scrub.values()).toContain(TOKEN);
      expect(scrub.values()).toContain(fake.exchanged[0]);
      expect(logs.join('\n')).not.toContain(TOKEN);
      expect(readFileSync(join(dir, 'images', 'index.json'), 'utf8')).not.toContain(TOKEN);
    });

    test('with no read token, the image fails saying which credential to set; the reason holds no secret', async () => {
      fake = await startFakeRegistry({ privateToken: TOKEN });
      const img = fake.addImage('jumpmaster-trooper');
      const logs: string[] = [];
      const m = mirrorOn(tmp(), { logs });
      m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
      expect(await m.syncOnce()).toBe(1);
      expect(m.status().images[0]?.error).toMatch(/registryReadToken/);
    });

    test('a wrong read token fails, and neither it nor a log line carries the value', async () => {
      fake = await startFakeRegistry({ privateToken: TOKEN });
      const img = fake.addImage('jumpmaster-trooper');
      const wrong = 'ghp_' + 'wrongTokenValue0000000000000000';
      const logs: string[] = [];
      const dir = tmp();
      const m = mirrorOn(dir, { token: () => wrong, logs });
      m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
      expect(await m.syncOnce()).toBe(1);
      expect(m.status().images[0]?.error).toMatch(/refused the registryReadToken/);
      expect(logs.join('\n')).not.toContain(wrong);
      expect(readFileSync(join(dir, 'images', 'index.json'), 'utf8')).not.toContain(wrong);
    });
  });

  test('with no lock nothing is fetched', async () => {
    fake = await startFakeRegistry();
    fake.addImage('jumpmaster-trooper');
    const m = mirrorOn(tmp());
    m.setLock(undefined);
    m.start();
    await m.idle();
    expect(await m.syncOnce()).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(m.status()).toEqual({ lock: false, images: [] });
  });

  test('runs in the background, retrying a failed image with backoff until it completes', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper');
    const layer = img.platforms['linux/amd64']?.blobs[1] as string;
    fake.corrupt(layer);
    const waits: number[] = [];
    const m = mirrorOn(tmp(), {
      backoffMs: [10, 20],
      sleep: async (ms) => {
        waits.push(ms);
        // The registry serves good bytes again after the second failure.
        if (waits.length === 2) fake?.heal(layer);
      },
    });
    m.setLock({ registry: fake.registry, images: { [img.name]: img.digest } });
    m.start();
    await m.idle();
    expect(waits).toEqual([10, 20]);
    expect(m.status().images[0]).toMatchObject({ state: 'complete' });
  });

  test('a new lock keeps the previous lock listed; the one before it is dropped', async () => {
    fake = await startFakeRegistry();
    const v1 = fake.addImage('jumpmaster-trooper');
    const v2 = fake.addImage('jumpmaster-trooper');
    const v3 = fake.addImage('jumpmaster-trooper');
    const dir = tmp();
    const m = mirrorOn(dir);
    const lockOf = (d: string) => ({
      registry: fake?.registry ?? '',
      images: { 'jumpmaster-trooper': d },
    });
    m.setLock(lockOf(v1.digest));
    await m.syncOnce();
    m.setLock(lockOf(v2.digest));
    await m.syncOnce();
    expect(m.lookup('jumpmaster-trooper', v1.digest)).toMatchObject({
      listed: true,
      complete: true,
    });
    expect(m.lookup('jumpmaster-trooper', v2.digest)).toMatchObject({
      listed: true,
      complete: true,
    });
    // An upgrade is a restart: the store remembers which lock was current.
    const again = mirrorOn(dir);
    again.setLock(lockOf(v3.digest));
    expect(again.lookup('jumpmaster-trooper', v1.digest)).toEqual({ listed: false });
    expect(again.lookup('jumpmaster-trooper', v2.digest)).toMatchObject({ complete: true });
    expect(again.lookup('jumpmaster-trooper', v3.digest)).toMatchObject({
      listed: true,
      complete: false,
    });
    expect(again.status().images.map((i) => [i.digest, i.current])).toEqual([
      [v3.digest, true],
      [v2.digest, false],
    ]);
  });

  test('a restart with the same lock keeps what is complete and fetches nothing', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper');
    const dir = tmp();
    const lock = { registry: fake.registry, images: { [img.name]: img.digest } };
    const m = mirrorOn(dir);
    m.setLock(lock);
    await m.syncOnce();
    const before = fake.requests.length;
    const again = mirrorOn(dir);
    again.setLock(lock);
    expect(await again.syncOnce()).toBe(0);
    expect(fake.requests.length).toBe(before);
    expect(again.status().images[0]).toMatchObject({ state: 'complete' });
  });
});

describe('the signature artifacts stored are bounded (issue #257)', () => {
  const MiB = 1024 * 1024;
  const blobPath = (dir: string, d: string) => join(dir, 'images', 'blobs', 'sha256', hex(d));
  const partials = (dir: string) =>
    readdirSync(join(dir, 'images', 'tmp')).filter((f) => f.endsWith('.partial'));

  async function run(img: FakeImage, logs: string[] = []) {
    const dir = tmp();
    const m = mirrorOn(dir, { logs });
    m.setLock({ registry: fake?.registry ?? '', images: { [img.name]: img.digest } });
    const failed = await m.syncOnce();
    const rec = indexOf(dir).images[`${img.name}@${img.digest}`];
    return { dir, m, failed, rec, stored: rec?.signatures.map((s) => s.manifest.digest) ?? [] };
  }

  test('the caps and accepted types are exported', () => {
    expect(MAX_SIGNATURE_ARTIFACTS).toBe(16);
    expect(MAX_SIGNATURE_BLOB_BYTES).toBe(4 * MiB);
    expect(SIGNATURE_ARTIFACT_TYPES).toContain(SIGSTORE_BUNDLE);
    expect(SIGNATURE_ARTIFACT_TYPES).toContain(COSIGN_SIMPLESIGNING);
  });

  for (const via of ['referrers-api', 'referrers-tag'] as const)
    test(`a list of 500 referrers (${via}): 16 stored, the rest skipped and logged`, async () => {
      fake = await startFakeRegistry();
      const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
      const sigs = Array.from({ length: 500 }, () => fake?.addSignature(img, { via }));
      const legacy = fake.addSignature(img, { via: 'legacy' });
      const logs: string[] = [];
      const r = await run(img, logs);
      expect(r.rec?.state).toBe('complete');
      expect(r.stored).toEqual([...sigs.slice(0, 16).map((s) => s?.manifest), legacy.manifest]);
      expect(existsSync(blobPath(r.dir, sigs[16]?.manifest as string))).toBe(false);
      expect(logs.some((l) => /484 .*skipped/.test(l))).toBe(true);
      // Nothing past the cap is even fetched.
      const asked = new Set(fake.requests.map((q) => q.path.split('/').pop()));
      expect(asked.has(sigs[16]?.manifest)).toBe(false);
    });

  test('a referrer of an unrelated artifact type is not stored', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper');
    const sbom = fake.addSignature(img, { artifactType: 'application/spdx+json' });
    // No artifactType: the config's media type decides.
    const untyped = fake.addSignature(img, {
      artifactType: null,
      configMediaType: 'application/vnd.example.thing',
    });
    const typedByConfig = fake.addSignature(img, {
      artifactType: null,
      configMediaType: SIGSTORE_BUNDLE,
    });
    const r = await run(img);
    expect(r.rec?.state).toBe('complete');
    expect(r.stored).toEqual([img.signature.manifest, typedByConfig.manifest]);
    for (const d of [sbom.manifest, untyped.manifest, sbom.blobs[1], untyped.blobs[1]])
      expect(existsSync(blobPath(r.dir, d as string))).toBe(false);
  });

  for (const via of ['referrers-api', 'referrers-tag', 'legacy'] as const) {
    test(`${via}: a layer declaring 1 KiB but streaming 5 MiB is not stored, its partial removed`, async () => {
      fake = await startFakeRegistry();
      const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
      const big = fake.addSignature(img, {
        via,
        layer: Buffer.alloc(5 * MiB, 1),
        declaredSize: 1024,
      });
      const good = via === 'legacy' ? undefined : fake.addSignature(img, { via });
      const logs: string[] = [];
      const r = await run(img, logs);
      expect(existsSync(blobPath(r.dir, big.blobs[1] as string))).toBe(false);
      expect(existsSync(blobPath(r.dir, big.manifest))).toBe(false);
      expect(partials(r.dir)).toEqual([]);
      expect(r.stored).not.toContain(big.manifest);
      expect(logs.some((l) => l.includes(big.manifest) && /skipped/.test(l))).toBe(true);
      if (good) expect(r.stored).toEqual([good.manifest]);
    });

    test(`${via}: a layer declaring more than 4 MiB is refused unfetched; exactly 4 MiB is stored`, async () => {
      fake = await startFakeRegistry();
      const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
      const over = fake.addSignature(img, { via, layer: Buffer.alloc(4 * MiB + 1, 2) });
      const r1 = await run(img);
      expect(r1.stored).toEqual([]);
      expect(existsSync(blobPath(r1.dir, over.blobs[1] as string))).toBe(false);
      expect(fake.requests.some((q) => q.path.endsWith(over.blobs[1] as string))).toBe(false);

      const img2 = fake.addImage('jumpmaster-egress', { signatures: 'none' });
      const exact = fake.addSignature(img2, { via, layer: Buffer.alloc(4 * MiB, 3) });
      const r2 = await run(img2);
      expect(r2.rec?.state).toBe('complete');
      expect(r2.stored).toEqual([exact.manifest]);
      expect(existsSync(blobPath(r2.dir, exact.blobs[1] as string))).toBe(true);
    });

    test(`${via}: a signature manifest over 1 MiB is not stored`, async () => {
      fake = await startFakeRegistry();
      const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
      const fat = fake.addSignature(img, { via, padManifest: MiB });
      const logs: string[] = [];
      const r = await run(img, logs);
      expect(r.stored).toEqual([]);
      expect(existsSync(blobPath(r.dir, fat.manifest))).toBe(false);
      expect(logs.some((l) => l.includes(fat.manifest) && /too large/.test(l))).toBe(true);
    });
  }

  test('only oversized referrers: the image is refused, its status no signature (never "mirrored")', async () => {
    fake = await startFakeRegistry();
    const img = fake.addImage('jumpmaster-trooper', { signatures: 'none' });
    fake.addSignature(img, { layer: Buffer.alloc(5 * MiB, 1), declaredSize: 1024 });
    fake.addSignature(img, { layer: Buffer.alloc(4 * MiB + 1, 1) });
    fake.addSignature(img, { via: 'legacy', layer: Buffer.alloc(4 * MiB + 1, 1) });
    const r = await run(img);
    expect(r.failed).toBe(1);
    expect(r.rec?.state).toBe('failed');
    expect(r.rec?.signatures).toEqual([]);
    expect(r.m.status().images[0]).toMatchObject({ state: 'failed' });
    expect(r.m.status().images[0]?.error).toMatch(/no cosign signature/);
  });
});

const r0 = <T>(xs: T[]): T => xs[0] as T;
