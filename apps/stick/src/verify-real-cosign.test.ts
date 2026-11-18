// CLAIM = PROOF (issue #167): the stick's layout verification, run with the REAL cosign v3.1.4 on
// the real v0.4.0-rc.2 signature (fixtures/rc2-stick) and the trusted root the images ship
// (images/sigstore/trusted_root.json). Set COSIGN_BIN to a cosign v3.1.4 binary to run it (the CI
// images job runs it inside the stick image, with COSIGN_BIN=/usr/local/bin/cosign); without one
// it is skipped by name. cosign's HTTPS goes to a dead proxy and its HOME and TUF_ROOT are empty, so a
// pass proves the check needs nothing but the pinned root.
import { describe, expect, test } from 'vitest';
import { PINNED_ROOT, RC2_REPOSITORY, rc2Layout } from './test/rc2.js';
import { execCosign, type ImageTrust, releaseSigner, verifyLayout } from './verify.js';

const COSIGN_BIN = process.env.COSIGN_BIN ?? '';

function trust(repo = RC2_REPOSITORY): ImageTrust {
  return {
    policy: 'signed',
    allowed: new Set(),
    signer: releaseSigner(repo, '0.4.0-rc.2'),
    // Every HTTPS request cosign might make goes to a dead proxy: a pass needs no network.
    cosign: execCosign(COSIGN_BIN, {
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
    }),
    trustedRoot: PINNED_ROOT,
  };
}

const ref = (digest: string) => `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${digest}`;

describe.skipIf(!COSIGN_BIN)('real cosign (COSIGN_BIN) on the rc.2 fixtures, offline', () => {
  test('verified for the untouched index', async () => {
    const l = rc2Layout();
    expect(await verifyLayout(l.dir, ref(l.digest), trust())).toEqual({ ok: true, via: 'cosign' });
  });

  test('refused for the index with one byte appended, even when the layout names it as signed', async () => {
    const l = rc2Layout({ relabelIndex: true });
    const v = await verifyLayout(l.dir, ref(l.digest), trust());
    expect(v).toEqual({
      ok: false,
      reason: expect.stringContaining(
        'provided artifact digests do not match digests in statement',
      ),
    });
  });

  test('refused for another identity', async () => {
    const l = rc2Layout();
    const v = await verifyLayout(l.dir, ref(l.digest), trust('someone-else/jumpmaster'));
    expect(v).toEqual({
      ok: false,
      reason: expect.stringContaining('no matching CertificateIdentity'),
    });
  });
});
