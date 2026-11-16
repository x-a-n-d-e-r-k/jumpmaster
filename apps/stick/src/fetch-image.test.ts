// Server-hosted images (issue #141): the stick fetches a missing image's OCI layout from its
// server, verifies it offline and only then loads it. The layouts here are built in the test;
// cosign and the engine are fakes that record their calls.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ImageFetch } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import {
  FETCH_CAP_BYTES,
  FETCH_PROGRESS_MS,
  fetchFromServer,
  type ServerImageDeps,
  stickPlatform,
} from './fetch-image.js';
import { type Entry, PLATFORM, release, slowBody, tar } from './test/layout.js';
import {
  type Cosign,
  type CosignResult,
  execCosign,
  type ImageTrust,
  identityRegexp,
  releaseSigner,
  VerifyCache,
} from './verify.js';

const REPO = 'x-a-n-d-e-r-k/jumpmaster';
const fresh = (p = 'jm-fetch-') => mkdtempSync(join(tmpdir(), p));

/** Reads a tar this module built: name to content. */
function untar(b: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let off = 0;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, ''), 8);
    off += 512;
    out.set(name, b.subarray(off, off + size));
    off += size + ((512 - (size % 512)) % 512);
  }
  return out;
}

type World = {
  deps: ServerImageDeps;
  stateDir: string;
  calls: string[];
  logs: string[];
  reports: (ImageFetch | null)[];
  loadedTar: () => Buffer | undefined;
};

function world(o: {
  answer?: () => Response;
  present?: boolean;
  loadedIds?: (r: ReturnType<typeof release>) => string[];
  r?: ReturnType<typeof release>;
  body?: Buffer;
  capBytes?: number;
}): World {
  const stateDir = fresh('jm-state-');
  const calls: string[] = [];
  const logs: string[] = [];
  const reports: (ImageFetch | null)[] = [];
  let loaded: Buffer | undefined;
  const r = o.r ?? release();
  const body = o.body ?? tar(r.entries);
  const deps: ServerImageDeps = {
    client: {
      async imageLayout(ref, platform) {
        calls.push(`fetch ${ref} ${platform}`);
        return (
          o.answer?.() ??
          new Response(slowBody(body, 1000), {
            status: 200,
            headers: { 'content-length': String(body.length) },
          })
        );
      },
      async reportImageFetch(p) {
        reports.push(p);
      },
    },
    loader: {
      async imageExists(ref) {
        calls.push(`exists ${ref}`);
        return o.present ?? false;
      },
      async loadImage(t: Readable) {
        calls.push('load');
        const chunks: Buffer[] = [];
        for await (const c of t) chunks.push(c as Buffer);
        loaded = Buffer.concat(chunks);
        return o.loadedIds ? o.loadedIds(r) : [r.configDigest];
      },
      async removeImage(id) {
        calls.push(`remove ${id}`);
      },
      async tagImage(id, ref) {
        calls.push(`tag ${id} ${ref}`);
      },
    },
    stateDir,
    platform: PLATFORM,
    log: (l) => logs.push(l),
    ...(o.capBytes !== undefined ? { capBytes: o.capBytes } : {}),
  };
  return { deps, stateDir, calls, logs, reports, loadedTar: () => loaded };
}

/** A cosign that answers from a script and records its calls (and what the layout held). */
function fakeCosign(answer: (args: string[]) => CosignResult) {
  const calls: string[][] = [];
  const sawLayout: boolean[] = [];
  const cosign: Cosign = async (args) => {
    calls.push(args);
    const dir = layoutOf(args);
    sawLayout.push(existsSync(join(dir, 'index.json')) && existsSync(join(dir, 'blobs', 'sha256')));
    return answer(args);
  };
  return { cosign, calls, sawLayout };
}

/** The layout directory of a call: its last argument is the index blob, `<dir>/blobs/sha256/<hex>`. */
const layoutOf = (args: string[]): string => dirname(dirname(dirname(args.at(-1) as string)));

const verified = (): CosignResult => ({ code: 0, stdout: '', stderr: 'Verified OK\n' });

function signedTrust(cosign: Cosign, dir = fresh(), allowed: string[] = []): ImageTrust {
  return {
    policy: 'signed',
    allowed: new Set(allowed),
    signer: releaseSigner(REPO),
    cosign,
    cache: new VerifyCache(join(dir, 'verified.json'), releaseSigner(REPO)),
  };
}

/** Nothing of a fetch is left in the state directory. */
const leftovers = (stateDir: string) =>
  existsSync(join(stateDir, 'image-fetch')) ? readdirSync(join(stateDir, 'image-fetch')) : [];

describe('fetching a missing image from the server (issue #141)', () => {
  test('the stick asks for its own platform', () => {
    expect(stickPlatform('x64')).toBe('linux/amd64');
    expect(stickPlatform('arm64')).toBe('linux/arm64');
    expect(stickPlatform(process.arch)).toMatch(/^linux\//);
  });

  test('happy path: download, cosign verify offline with the pinned identity, load, tag by digest', async () => {
    const r = release();
    const w = world({ r });
    const c = fakeCosign(() => verified());
    const cacheDir = fresh();
    const trust = signedTrust(c.cosign, cacheDir);
    expect(await fetchFromServer(r.ref, trust, w.deps)).toEqual({ ok: true, via: 'cosign' });
    expect(w.calls).toEqual([
      `exists ${r.ref}`,
      `fetch ${r.ref} ${PLATFORM}`,
      'load',
      `tag ${r.configDigest} ${r.ref}`,
    ]);
    expect(c.calls).toHaveLength(1);
    const args = c.calls[0] as string[];
    const dir = layoutOf(args);
    expect(args).toEqual([
      'verify-blob-attestation',
      '--bundle',
      join(dir, 'blobs', 'sha256', r.bundleDigest.slice(7)),
      '--type',
      'https://sigstore.dev/cosign/sign/v1',
      '--trusted-root',
      '/app/sigstore/trusted_root.json',
      '--offline',
      '--certificate-identity-regexp',
      identityRegexp(REPO),
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--certificate-github-workflow-trigger',
      'push',
      '--certificate-github-workflow-repository',
      REPO,
      join(dir, 'blobs', 'sha256', r.indexDigest.slice(7)),
    ]);
    // cosign saw the extracted layout, under the state directory; it is gone now.
    expect(c.sawLayout).toEqual([true]);
    expect(dir.startsWith(join(w.stateDir, 'image-fetch'))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(leftovers(w.stateDir)).toEqual([]);
    // What was loaded: the platform image alone, named by the digest reference.
    const loaded = untar(w.loadedTar() as Buffer);
    expect([...loaded.keys()].sort()).toEqual(
      [
        'index.json',
        'manifest.json',
        'oci-layout',
        `blobs/sha256/${r.configDigest.slice(7)}`,
        `blobs/sha256/${r.layerDigest.slice(7)}`,
        `blobs/sha256/${r.manifestDigest.slice(7)}`,
      ].sort(),
    );
    const index = JSON.parse(String(loaded.get('index.json')));
    expect(index.manifests).toHaveLength(1);
    expect(index.manifests[0]).toMatchObject({
      digest: r.manifestDigest,
      annotations: { 'io.containerd.image.name': r.ref },
    });
    expect(JSON.parse(String(loaded.get('manifest.json')))).toEqual([
      {
        Config: `blobs/sha256/${r.configDigest.slice(7)}`,
        RepoTags: [],
        Layers: [`blobs/sha256/${r.layerDigest.slice(7)}`],
      },
    ]);
    expect(loaded.get(`blobs/sha256/${r.layerDigest.slice(7)}`)).toEqual(
      r.blobs.get(r.layerDigest),
    );
    // Recorded in the verified cache: the next fetch needs no signature check.
    expect(
      JSON.parse(readFileSync(join(cacheDir, 'verified.json'), 'utf8')).entries,
    ).toHaveProperty(r.indexDigest);
    const again = world({ r });
    const c2 = fakeCosign(() => ({ code: 1, stdout: '', stderr: 'Error: no' }));
    expect(await fetchFromServer(r.ref, { ...trust, cosign: c2.cosign }, again.deps)).toEqual({
      ok: true,
      via: 'cache',
    });
    expect(c2.calls).toEqual([]);
    expect(again.calls).toContain('load');
  });

  test('the containerd store reports the manifest digest as the id: that is the image too', async () => {
    const r = release();
    const w = world({ r, loadedIds: (x) => [x.manifestDigest] });
    const c = fakeCosign(() => verified());
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps)).toEqual({
      ok: true,
      via: 'cosign',
    });
    expect(w.calls.at(-1)).toBe(`tag ${r.manifestDigest} ${r.ref}`);
  });

  test('signature failure: the server is no trust anchor. Nothing loads, the directory goes, the event is logged', async () => {
    const r = release();
    const w = world({ r });
    const c = fakeCosign(() => ({
      code: 1,
      stdout: '',
      stderr: 'Error: no matching signatures: none of the expected identities matched\n',
    }));
    const v = await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps);
    expect(v).toEqual({
      ok: false,
      reason: `image not verified: ${r.ref}: cosign exit 1: no matching signatures: none of the expected identities matched`,
    });
    expect(w.calls).not.toContain('load');
    expect(w.calls.some((x) => x.startsWith('tag '))).toBe(false);
    expect(existsSync(layoutOf(c.calls[0] as string[]))).toBe(false);
    expect(leftovers(w.stateDir)).toEqual([]);
    expect(w.logs.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ event: 'image-verify-failed', ref: r.ref, via: 'server' }),
    );
  });

  test('a signature on another digest is refused too', async () => {
    const r = release();
    const w = world({ r });
    const c = fakeCosign(() => ({
      code: 1,
      stdout: '',
      stderr:
        'Error: failed to verify signature: provided artifact digests do not match digests in statement\n',
    }));
    const v = await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps);
    expect(v.ok).toBe(false);
    expect(w.calls).not.toContain('load');
  });

  describe('every verification failure refuses and never loads (issue #167)', () => {
    const r = release();
    const withoutBundle = r.entries.map((e) =>
      e.name === 'index.json'
        ? {
            ...e,
            body: Buffer.from(
              JSON.stringify({
                ...JSON.parse(String(e.body)),
                manifests: JSON.parse(String(e.body)).manifests.filter(
                  (m: { artifactType?: string }) => !m.artifactType,
                ),
              }),
            ),
          }
        : e,
    );
    const slow = join(fresh('jm-slow-cosign-'), 'cosign');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const cases: [string, { cosign?: Cosign; body?: Buffer; timeoutMs?: number }, string][] = [
      [
        'no bundle entry',
        { cosign: fakeCosign(verified).cosign, body: tar(withoutBundle) },
        'no Sigstore bundle',
      ],
      [
        'cosign exit != 0',
        { cosign: fakeCosign(() => ({ code: 1, stdout: '', stderr: 'Error: nope' })).cosign },
        'cosign exit 1: nope',
      ],
      [
        'cosign missing',
        { cosign: execCosign(join(tmpdir(), 'no-such-cosign')) },
        'cosign not found',
      ],
      ['cosign missing from the trust', {}, 'cosign is not available'],
      [
        'a timeout',
        { cosign: execCosign(slow, { PATH: process.env.PATH }), timeoutMs: 200 },
        'timed out after 0.2s',
      ],
      [
        'a thrown cosign call',
        {
          cosign: async () => {
            throw new Error('spawn EACCES');
          },
        },
        'spawn EACCES',
      ],
    ];
    for (const [name, o, why] of cases)
      test(name, async () => {
        const w = world({ r, ...(o.body ? { body: o.body } : {}) });
        const trust: ImageTrust = {
          ...signedTrust(o.cosign as Cosign),
          ...(o.cosign ? {} : { cosign: undefined }),
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        };
        const v = await fetchFromServer(r.ref, trust, w.deps);
        expect(v).toEqual({ ok: false, reason: expect.stringContaining(why) });
        expect(w.calls).not.toContain('load');
        expect(w.calls.some((x) => x.startsWith('tag '))).toBe(false);
        expect(leftovers(w.stateDir)).toEqual([]);
      });
  });

  test('ID mismatch: the loaded image is not the manifest config; it is removed and refused', async () => {
    const r = release();
    const evil = `sha256:${'e'.repeat(64)}`;
    const w = world({ r, loadedIds: () => [evil] });
    const c = fakeCosign(() => verified());
    const v = await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps);
    expect(v).toEqual({
      ok: false,
      reason: `image not verified: ${r.ref}: the engine loaded ${evil}, not the image's config ${r.configDigest}`,
    });
    expect(w.calls).toContain(`remove ${evil}`);
    expect(w.calls.some((x) => x.startsWith('tag '))).toBe(false);
    expect(leftovers(w.stateDir)).toEqual([]);
    // Loading nothing at all is refused the same way.
    const none = world({ r, loadedIds: () => [] });
    expect((await fetchFromServer(r.ref, signedTrust(c.cosign), none.deps)).ok).toBe(false);
  });

  test('a layout whose blob does not hash to its name is refused before cosign or load', async () => {
    const r = release();
    const entries = r.entries.map((e) =>
      e.name === `blobs/sha256/${r.layerDigest.slice(7)}`
        ? { ...e, body: Buffer.from('other bytes') }
        : e,
    );
    const w = world({ r, body: tar(entries) });
    const c = fakeCosign(() => verified());
    const v = await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps);
    expect(v).toEqual({
      ok: false,
      reason: `image fetch refused: ${r.ref}: the layout has blob ${r.layerDigest} does not match its digest`,
    });
    expect(c.calls).toEqual([]);
    expect(w.calls).not.toContain('load');
  });

  test('a layout without the asked-for index, or without this platform, is refused', async () => {
    const r = release();
    const noIndex = world({
      r,
      body: tar(r.entries.filter((e) => e.name !== `blobs/sha256/${r.indexDigest.slice(7)}`)),
    });
    const c = fakeCosign(() => verified());
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), noIndex.deps)).toEqual({
      ok: false,
      reason: `image fetch refused: ${r.ref}: the image index ${r.indexDigest} is not in the layout`,
    });
    const s390 = world({ r });
    s390.deps.platform = 'linux/s390x';
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), s390.deps)).toEqual({
      ok: false,
      reason: `image fetch refused: ${r.ref}: the image index has no linux/s390x image`,
    });
    // arm64's manifest is named but not in the layout.
    const arm = world({ r });
    arm.deps.platform = 'linux/arm64';
    expect((await fetchFromServer(r.ref, signedTrust(c.cosign), arm.deps)).ok).toBe(false);
    expect(c.calls).toEqual([]);
  });

  describe('a tar that would write outside its directory is refused before writing anything there', () => {
    const r = release();
    const trust = () => signedTrust(fakeCosign(() => verified()).cosign);

    test('an entry named ../evil', async () => {
      const w = world({
        r,
        body: tar([{ name: '../evil', body: Buffer.from('x') }, ...r.entries]),
      });
      const v = await fetchFromServer(r.ref, trust(), w.deps);
      expect(v).toEqual({
        ok: false,
        reason: `image fetch refused: ${r.ref}: the layout has a path outside the layout (../evil)`,
      });
      expect(existsSync(join(w.stateDir, 'image-fetch', 'evil'))).toBe(false);
      expect(existsSync(join(w.stateDir, 'evil'))).toBe(false);
      expect(readdirSync(w.stateDir)).toEqual(['image-fetch']);
      expect(leftovers(w.stateDir)).toEqual([]);
      expect(w.calls).not.toContain('load');
      // Deeper too, behind a legitimate prefix.
      const deep = world({
        r,
        body: tar([
          ...r.entries.slice(0, 3),
          { name: 'blobs/../../../evil2', body: Buffer.from('x') },
        ]),
      });
      expect((await fetchFromServer(r.ref, trust(), deep.deps)).ok).toBe(false);
      expect(readdirSync(deep.stateDir)).toEqual(['image-fetch']);
      expect(existsSync(join(deep.stateDir, 'evil2'))).toBe(false);
    });

    test('an absolute path', async () => {
      const outside = fresh('jm-outside-');
      const target = join(outside, 'abs-evil');
      const w = world({ r, body: tar([{ name: target, body: Buffer.from('x') }, ...r.entries]) });
      const v = await fetchFromServer(r.ref, trust(), w.deps);
      expect(v).toEqual({
        ok: false,
        reason: `image fetch refused: ${r.ref}: the layout has an absolute path (${target})`,
      });
      expect(existsSync(target)).toBe(false);
      expect(leftovers(w.stateDir)).toEqual([]);
    });

    test('a symlink pointing outside, and a write through it', async () => {
      const outside = fresh('jm-outside-');
      const victim = join(outside, 'victim');
      writeFileSync(victim, 'untouched');
      const name = `blobs/sha256/${r.layerDigest.slice(7)}`;
      const w = world({
        r,
        body: tar([
          { name: 'blobs/', type: '5' },
          { name: 'blobs/sha256/', type: '5' },
          { name, type: '2', link: victim },
          ...r.entries.filter((e) => e.name === name),
        ]),
      });
      const v = await fetchFromServer(r.ref, trust(), w.deps);
      expect(v).toEqual({
        ok: false,
        reason: `image fetch refused: ${r.ref}: the layout has a symlink entry (${name})`,
      });
      expect(readFileSync(victim, 'utf8')).toBe('untouched');
      expect(leftovers(w.stateDir)).toEqual([]);
      // A hard link and a name a layout doesn't have are refused alike.
      const hard = world({ r, body: tar([{ name: 'index.json', type: '1', link: victim }]) });
      expect(await fetchFromServer(r.ref, trust(), hard.deps)).toMatchObject({
        reason: expect.stringContaining('a hard link entry (index.json)'),
      });
      const odd = world({ r, body: tar([{ name: 'etc/passwd', body: Buffer.from('x') }]) });
      expect(await fetchFromServer(r.ref, trust(), odd.deps)).toMatchObject({
        reason: expect.stringContaining('an entry an image layout does not have (etc/passwd)'),
      });
    });
  });

  test('size cap: a layout over 8 GB by its length is refused unread; one that streams over the cap stops', async () => {
    expect(FETCH_CAP_BYTES).toBe(8 * 1024 ** 3);
    const r = release();
    let cancelled = false;
    const big = world({
      r,
      answer: () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(512));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { 'content-length': String(FETCH_CAP_BYTES + 1) } },
        ),
    });
    const c = fakeCosign(() => verified());
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), big.deps)).toEqual({
      ok: false,
      reason: `image fetch refused: ${r.ref}: the layout is ${FETCH_CAP_BYTES + 1} bytes, over the ${FETCH_CAP_BYTES}-byte cap`,
    });
    expect(cancelled).toBe(true);
    // No length given: counted as it arrives.
    const body = tar(r.entries);
    const streamed = world({
      r,
      capBytes: 2048,
      answer: () => new Response(slowBody(body, 512), { status: 200 }),
    });
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), streamed.deps)).toEqual({
      ok: false,
      reason: `image fetch refused: ${r.ref}: the layout has more than the 2048-byte cap`,
    });
    expect(c.calls).toEqual([]);
    expect(streamed.calls).not.toContain('load');
    expect(leftovers(streamed.stateDir)).toEqual([]);
  });

  test('404 not mirrored: the drop waits with the state the server gives', async () => {
    const r = release();
    const w = world({
      r,
      answer: () => Response.json({ error: 'not mirrored', state: 'fetching' }, { status: 404 }),
    });
    const c = fakeCosign(() => verified());
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps)).toEqual({
      ok: false,
      wait: true,
      reason: `image ${r.ref} not yet mirrored on the server (fetching)`,
    });
    const failed = world({
      r,
      answer: () =>
        Response.json(
          { error: 'not mirrored', state: 'failed: registry said 500' },
          { status: 404 },
        ),
    });
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), failed.deps)).toMatchObject({
      wait: true,
      reason: `image ${r.ref} not yet mirrored on the server (failed: registry said 500)`,
    });
    // Not in the lock at all: refused, not a wait.
    const unlisted = world({
      r,
      answer: () => Response.json({ error: 'not in the image lock' }, { status: 404 }),
    });
    expect(await fetchFromServer(r.ref, signedTrust(c.cosign), unlisted.deps)).toEqual({
      ok: false,
      reason: `image fetch failed: ${r.ref}: not on the server: not in the image lock`,
    });
    expect(c.calls).toEqual([]);
  });

  test('progress: at most one report every 2 s while downloading, the last equal to the total, then none', async () => {
    expect(FETCH_PROGRESS_MS).toBe(2_000);
    const r = release();
    const body = tar(r.entries);
    let t = 0;
    const at: number[] = [];
    const w = world({
      r,
      answer: () =>
        new Response(
          slowBody(body, 512, () => {
            t += 700;
          }),
          { status: 200, headers: { 'content-length': String(body.length) } },
        ),
    });
    w.deps.now = () => t;
    const report = w.deps.client.reportImageFetch;
    w.deps.client.reportImageFetch = async (p) => {
      at.push(t);
      return report(p);
    };
    const c = fakeCosign(() => verified());
    expect((await fetchFromServer(r.ref, signedTrust(c.cosign), w.deps)).ok).toBe(true);
    const progress = w.reports.slice(0, -1) as ImageFetch[];
    expect(w.reports.at(-1)).toBeNull();
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.length).toBeLessThan(body.length / 512);
    // Every report but the final one is at least 2 s after the one before.
    const during = at.slice(0, progress.length - 1);
    for (let i = 1; i < during.length; i++)
      expect((during[i] as number) - (during[i - 1] as number)).toBeGreaterThanOrEqual(2_000);
    for (const p of progress) expect(p).toMatchObject({ ref: r.ref, total: body.length });
    expect(progress.at(-1)).toEqual({ ref: r.ref, done: body.length, total: body.length });
    const done = progress.map((p) => p.done);
    expect([...done].sort((a, b) => a - b)).toEqual(done);
  });

  test('under allowlist no signature is checked; the image is still bound to its digest', async () => {
    const r = release();
    const w = world({ r });
    const trust: ImageTrust = { policy: 'allowlist', allowed: new Set([r.ref]) };
    expect(await fetchFromServer(r.ref, trust, w.deps)).toEqual({ ok: true, via: 'allowlist' });
    expect(w.calls.at(-1)).toBe(`tag ${r.configDigest} ${r.ref}`);
    // A tag is never fetched.
    const tag = world({ r });
    expect(await fetchFromServer('jumpmaster-trooper:dev', trust, tag.deps)).toEqual({
      ok: true,
      via: 'allowlist',
    });
    expect(tag.calls).toEqual([]);
  });

  test('a pinned digest needs no signature; a present image needing none is not fetched', async () => {
    const r = release();
    const c = fakeCosign(() => ({ code: 1, stdout: '', stderr: '' }));
    const pinned = world({ r });
    expect(
      await fetchFromServer(r.ref, signedTrust(c.cosign, fresh(), [r.ref]), pinned.deps),
    ).toEqual({ ok: true, via: 'pinned' });
    expect(pinned.calls).toContain('load');
    const present = world({ r, present: true });
    expect(
      await fetchFromServer(r.ref, signedTrust(c.cosign, fresh(), [r.ref]), present.deps),
    ).toEqual({ ok: true, via: 'pinned' });
    expect(present.calls).toEqual([`exists ${r.ref}`]);
    expect(c.calls).toEqual([]);
    // Present but never verified: verified from the server's layout, not loaded again.
    const unverified = world({ r, present: true });
    const ok = fakeCosign(() => verified());
    expect(await fetchFromServer(r.ref, signedTrust(ok.cosign), unverified.deps)).toEqual({
      ok: true,
      via: 'cosign',
    });
    expect(unverified.calls).not.toContain('load');
  });
});
