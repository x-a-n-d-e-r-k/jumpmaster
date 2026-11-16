// Verifying a layout the server sent, fully offline (issue #167): the index blob must hash to the
// digest asked for, a Sigstore bundle referrer must sign it, and `cosign verify-blob-attestation`
// must accept that bundle on the index bytes with only the pinned trusted root, in an empty HOME.
// cosign is a fake here; verify-real-cosign.test.ts runs the real one on the same fixtures.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RC2_BUNDLE_MANIFEST, RC2_DIGEST, RC2_REPOSITORY, rc2Layout, sha256 } from './test/rc2.js';
import {
  type Cosign,
  type CosignResult,
  execCosign,
  type ImageTrust,
  identityRegexp,
  releaseSigner,
  SIGN_PREDICATE_TYPE,
  TRUSTED_ROOT_PATH,
  verifyIndexBundles,
  verifyLayout,
} from './verify.js';

const REF = `ghcr.io/x-a-n-d-e-r-k/jumpmaster-stick@${RC2_DIGEST}`;

type Call = { args: string[]; env: Record<string, string> | undefined; homeEmpty: boolean };

/** A cosign that records its calls and whether HOME was an empty directory when it ran. */
function fakeCosign(answer: (args: string[]) => CosignResult | Promise<CosignResult>) {
  const calls: Call[] = [];
  const cosign: Cosign = async (args, o) => {
    const home = o.env?.HOME;
    const homeEmpty =
      home !== undefined &&
      existsSync(home) &&
      statSync(home).isDirectory() &&
      readdirSync(home).length === 0;
    calls.push({ args, env: o.env, homeEmpty });
    return answer(args);
  };
  return { cosign, calls };
}

const ok = (): CosignResult => ({ code: 0, stdout: '', stderr: 'Verified OK\n' });

function trust(cosign: Cosign | undefined, repo = RC2_REPOSITORY): ImageTrust {
  return {
    policy: 'signed',
    allowed: new Set(),
    signer: releaseSigner(repo),
    ...(cosign ? { cosign } : {}),
  };
}

describe('verifying a server layout offline with the pinned trusted root', () => {
  test('the rc.2 layout verifies for fe7ce133…: one blob attestation check, offline, pinned root, empty HOME and TUF_ROOT', async () => {
    const l = rc2Layout();
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual({ ok: true, via: 'cosign' });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0] as Call;
    expect(c.args).toEqual([
      'verify-blob-attestation',
      '--bundle',
      l.bundleBlob,
      '--type',
      'https://sigstore.dev/cosign/sign/v1',
      '--trusted-root',
      '/app/sigstore/trusted_root.json',
      '--offline',
      '--certificate-identity-regexp',
      identityRegexp(RC2_REPOSITORY),
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--certificate-github-workflow-trigger',
      'push',
      '--certificate-github-workflow-repository',
      RC2_REPOSITORY,
      l.indexBlob,
    ]);
    expect(TRUSTED_ROOT_PATH).toBe('/app/sigstore/trusted_root.json');
    expect(SIGN_PREDICATE_TYPE).toBe('https://sigstore.dev/cosign/sign/v1');
    for (const a of c.args) expect(a).not.toMatch(/insecure/);
    // HOME and TUF_ROOT: one empty temporary directory, gone afterwards.
    expect(c.homeEmpty).toBe(true);
    expect(c.env?.TUF_ROOT).toBe(c.env?.HOME);
    expect((c.env?.HOME as string).startsWith(tmpdir())).toBe(true);
    expect(existsSync(c.env?.HOME as string)).toBe(false);
  });

  test('the trusted root is the one the trust names, when it names one', async () => {
    const l = rc2Layout();
    const f = fakeCosign(ok);
    const root = join(l.dir, 'root.json');
    expect(await verifyLayout(l.dir, REF, { ...trust(f.cosign), trustedRoot: root })).toMatchObject(
      { ok: true },
    );
    const args = f.calls[0]?.args as string[];
    expect(args[args.indexOf('--trusted-root') + 1]).toBe(root);
  });

  test('a success is cached; a cache hit needs no cosign', async () => {
    const l = rc2Layout();
    const added: string[] = [];
    const cache = { has: () => false, add: (d: string) => added.push(d) };
    const t = { ...trust(fakeCosign(ok).cosign), cache } as unknown as ImageTrust;
    expect(await verifyLayout(l.dir, REF, t)).toEqual({ ok: true, via: 'cosign' });
    expect(added).toEqual([RC2_DIGEST]);
  });

  test('one bundle verifying is enough', async () => {
    const l = rc2Layout();
    // A second referrer whose bundle cosign refuses, listed first.
    const index = JSON.parse(readFileSync(join(l.dir, 'index.json'), 'utf8'));
    const other = Buffer.from('{"not":"a bundle"}');
    const otherManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        layers: [{ mediaType: 'x', digest: sha256(other), size: other.length }],
      }),
    );
    writeFileSync(join(l.dir, 'blobs', 'sha256', sha256(other).slice(7)), other);
    writeFileSync(join(l.dir, 'blobs', 'sha256', sha256(otherManifest).slice(7)), otherManifest);
    index.manifests.splice(1, 0, {
      ...index.manifests[1],
      digest: sha256(otherManifest),
      size: otherManifest.length,
    });
    writeFileSync(join(l.dir, 'index.json'), JSON.stringify(index));
    const f = fakeCosign((args) =>
      args.includes(l.bundleBlob)
        ? ok()
        : { code: 1, stdout: '', stderr: 'Error: bundle does not parse\n' },
    );
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual({ ok: true, via: 'cosign' });
    expect(f.calls).toHaveLength(2);
  });
});

describe('every failure refuses, with a reason', () => {
  const refused = (why: RegExp | string) => ({
    ok: false,
    reason: expect.stringMatching(
      typeof why === 'string' ? why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : why,
    ),
  });

  test('an index blob whose hash is not D: refused before cosign', async () => {
    const l = rc2Layout({ tamperIndex: true });
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused(`image not verified: ${REF}: the image index blob does not hash to ${RC2_DIGEST}`),
    );
    expect(f.calls).toEqual([]);
  });

  test('a layout whose index.json names no image index D: refused', async () => {
    const l = rc2Layout();
    writeFileSync(join(l.dir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [] }));
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused(`the layout has no image index ${RC2_DIGEST}`),
    );
    expect(f.calls).toEqual([]);
  });

  test('no bundle entry: refused', async () => {
    const l = rc2Layout({ noBundle: true });
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused(`the layout has no Sigstore bundle signing ${RC2_DIGEST}`),
    );
    expect(f.calls).toEqual([]);
  });

  test('a bundle whose layer hash mismatches: refused before cosign', async () => {
    const l = rc2Layout({ tamperBundle: true });
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused(/the Sigstore bundle (sha256:[0-9a-f]{64}) does not hash to \1/),
    );
    expect(f.calls).toEqual([]);
  });

  test('a bundle manifest with other than one layer: refused', async () => {
    const l = rc2Layout();
    const m = JSON.parse(RC2_BUNDLE_MANIFEST.toString('utf8'));
    m.layers = [...m.layers, ...m.layers];
    const b = Buffer.from(JSON.stringify(m));
    writeFileSync(join(l.dir, 'blobs', 'sha256', sha256(b).slice(7)), b);
    const index = JSON.parse(readFileSync(join(l.dir, 'index.json'), 'utf8'));
    index.manifests[1].digest = sha256(b);
    writeFileSync(join(l.dir, 'index.json'), JSON.stringify(index));
    const f = fakeCosign(ok);
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused('does not hold exactly one layer'),
    );
    expect(f.calls).toEqual([]);
  });

  test('cosign exit != 0: refused, naming its last error line', async () => {
    const l = rc2Layout();
    const f = fakeCosign(() => ({
      code: 1,
      stdout: '',
      stderr:
        'Flag --offline has been deprecated\nError: failed to verify certificate identity: no matching CertificateIdentity found\nerror during command execution: x\n',
    }));
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(
      refused(
        `image not verified: ${REF}: cosign exit 1: failed to verify certificate identity: no matching CertificateIdentity found`,
      ),
    );
  });

  test('cosign missing: refused', async () => {
    const l = rc2Layout();
    expect(await verifyLayout(l.dir, REF, trust(undefined))).toEqual(
      refused('cosign is not available'),
    );
    const absent = execCosign(join(tmpdir(), 'no-such-cosign'));
    expect(await verifyLayout(l.dir, REF, trust(absent))).toEqual(refused('cosign not found at'));
  });

  test('a timeout: refused', async () => {
    const l = rc2Layout();
    const bin = join(l.dir, 'slow-cosign');
    writeFileSync(bin, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const t = { ...trust(execCosign(bin, { PATH: process.env.PATH })), timeoutMs: 200 };
    expect(await verifyLayout(l.dir, REF, t)).toEqual(refused('timed out after 0.2s'));
  });

  test('a thrown cosign call refuses, never accepts', async () => {
    const l = rc2Layout();
    const f = fakeCosign(() => {
      throw new Error('spawn EACCES');
    });
    expect(await verifyLayout(l.dir, REF, trust(f.cosign))).toEqual(refused('spawn EACCES'));
  });

  test('the function itself refuses a layout with no index.json, never throws', async () => {
    const f = fakeCosign(ok);
    const r = await verifyIndexBundles(join(tmpdir(), 'jm-no-layout'), RC2_DIGEST, {
      signer: releaseSigner(RC2_REPOSITORY),
      cosign: f.cosign,
      trustedRoot: TRUSTED_ROOT_PATH,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
});
