// A layout's signature manifest or bundle is stat'ed before it is read (issue #257): one over
// `META_CAP_BYTES` is refused unread, so a hostile server cannot make the stick buffer it.
import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RC2_BUNDLE_MANIFEST, RC2_DIGEST, rc2Layout, sha256 } from './test/rc2.js';
import { type Cosign, META_CAP_BYTES, releaseSigner, verifyIndexBundles } from './verify.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const reads = (path: string) =>
  vi.mocked(fs.readFileSync).mock.calls.filter((c) => String(c[0]) === path).length;

const cosign: Cosign = async () => ({ code: 0, stdout: '', stderr: '' });
const verify = (dir: string) =>
  verifyIndexBundles(dir, RC2_DIGEST, {
    signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
    cosign,
    trustedRoot: '/nonexistent',
    timeoutMs: 1000,
  });

afterEach(() => vi.mocked(fs.readFileSync).mockClear());

describe('an oversized signature file is refused before it is read', () => {
  test('a bundle blob of META_CAP_BYTES + 1: refused, never read', async () => {
    const l = rc2Layout();
    fs.truncateSync(l.bundleBlob, META_CAP_BYTES + 1);
    vi.mocked(fs.readFileSync).mockClear();
    const r = await verify(l.dir);
    expect(r).toEqual({
      ok: false,
      reason: expect.stringMatching(/the Sigstore bundle .* is too large$/),
    });
    expect(reads(l.bundleBlob)).toBe(0);
  });

  test('a signature manifest of META_CAP_BYTES + 1: refused, never read', async () => {
    const l = rc2Layout();
    const manifest = join(l.dir, 'blobs', 'sha256', sha256(RC2_BUNDLE_MANIFEST).slice(7));
    fs.truncateSync(manifest, META_CAP_BYTES + 1);
    vi.mocked(fs.readFileSync).mockClear();
    const r = await verify(l.dir);
    expect(r).toEqual({
      ok: false,
      reason: expect.stringMatching(/signature manifest .* is too large$/),
    });
    expect(reads(manifest)).toBe(0);
  });

  test('a bundle of exactly META_CAP_BYTES is read (and fails its hash, not the cap)', async () => {
    const l = rc2Layout();
    fs.truncateSync(l.bundleBlob, META_CAP_BYTES);
    const r = await verify(l.dir);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/does not hash to/) });
  });

  test('the rc.2 layout still passes the checks and reaches cosign', async () => {
    const l = rc2Layout();
    expect(await verify(l.dir)).toEqual({ ok: true });
  });
});
