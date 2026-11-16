// OCI image layouts built from the real v0.4.0-rc.2 stick signature (fixtures/rc2-stick), the
// way the server's mirror serves them (apps/server/src/images/serve.ts): the signed multi-arch
// index under kind `dev.cosignproject.cosign/imageIndex`, and the Sigstore bundle referrer
// annotated with the digest it signs. Shared by the stick's tests and the installer's (issue #167).
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = new URL('../fixtures/rc2-stick/', import.meta.url);
const fixture = (name: string): Buffer => readFileSync(new URL(name, FIXTURES));

export const sha256 = (b: Buffer): string =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** The index digest the rc.2 release signed. */
export const RC2_DIGEST = 'sha256:fe7ce13397db0abea97769ccbcedc17ebfd6d2c12cf9f10851102cd06aa94d55';
/** The repository whose release workflow signed it. */
export const RC2_REPOSITORY = 'x-a-n-d-e-r-k/jumpmaster';
export const RC2_INDEX = fixture('index.json');
export const RC2_BUNDLE_MANIFEST = fixture('bundle-manifest.json');
export const RC2_BUNDLE = fixture('bundle.json');
/** The trusted root the images ship (images/sigstore/trusted_root.json). */
export const PINNED_ROOT = fileURLToPath(
  new URL('../../../../images/sigstore/trusted_root.json', import.meta.url),
);

export type Rc2Case = {
  /** The index blob's bytes are not the signed ones (one byte appended), under the signed name. */
  tamperIndex?: boolean;
  /**
   * The index with one byte appended, stored and announced under its own digest, with the rc.2
   * bundle claimed as its signature: only cosign can tell.
   */
  relabelIndex?: boolean;
  /** No bundle referrer in the layout's index.json. */
  noBundle?: boolean;
  /** The bundle layer's bytes differ from its manifest's digest. */
  tamperBundle?: boolean;
};

export type Rc2Layout = { dir: string; digest: string; indexBlob: string; bundleBlob: string };

/** Writes an rc.2 layout into a new directory (or `dir`), and says what it holds. */
export function rc2Layout(o: Rc2Case = {}, dir = mkdtempSync(join(tmpdir(), 'jm-rc2-'))) {
  const blobs = join(dir, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  const put = (name: string, b: Buffer) => {
    const path = join(blobs, name.slice(7));
    writeFileSync(path, b);
    return path;
  };
  const appended = Buffer.concat([RC2_INDEX, Buffer.from('\n')]);
  const digest = o.relabelIndex ? sha256(appended) : RC2_DIGEST;
  const indexBlob = put(digest, o.tamperIndex || o.relabelIndex ? appended : RC2_INDEX);
  put(sha256(RC2_BUNDLE_MANIFEST), RC2_BUNDLE_MANIFEST);
  const bundleBlob = put(
    sha256(RC2_BUNDLE),
    o.tamperBundle ? Buffer.concat([RC2_BUNDLE, Buffer.from(' ')]) : RC2_BUNDLE,
  );
  const manifest = JSON.parse(RC2_BUNDLE_MANIFEST.toString('utf8')) as { artifactType: string };
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.index.v1+json',
        digest,
        size: (o.relabelIndex ? appended : RC2_INDEX).length,
        annotations: { kind: 'dev.cosignproject.cosign/imageIndex' },
      },
      ...(o.noBundle
        ? []
        : [
            {
              mediaType: 'application/vnd.oci.image.manifest.v1+json',
              digest: sha256(RC2_BUNDLE_MANIFEST),
              size: RC2_BUNDLE_MANIFEST.length,
              artifactType: manifest.artifactType,
              annotations: {
                'dev.sigstore.bundle.content': 'dsse-envelope',
                'dev.jumpmaster.signature.of': digest,
              },
            },
          ]),
    ],
  };
  writeFileSync(join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  writeFileSync(join(dir, 'manifest.json'), '[]');
  return { dir, digest, indexBlob, bundleBlob } satisfies Rc2Layout;
}

/** What a fake cosign accepts: the real rc.2 signature on the pinned root, as real cosign would. */
export type FakeCosignExpect = {
  /** sha256 hex of the trusted root it must be given. */
  rootSha256: string;
  /** The identity the rc.2 certificate satisfies. */
  identityRegexp: string;
  repository: string;
};

/**
 * A cosign stand-in (POSIX sh) that checks the exact `verify-blob-attestation` arguments, that
 * HOME and TUF_ROOT are one empty directory and that the trusted root is the pinned one (exit 2
 * otherwise), then answers as the real cosign does on the rc.2 fixtures: Verified OK for the rc.2
 * bundle on the rc.2 index bytes under its identity, and cosign's own errors for anything else.
 * It needs sha256sum, cut and ls on PATH, and logs to $LOG when that is set. $COSIGN_FAIL makes
 * it fail; $COSIGN_SLEEP makes it sleep first.
 */
export function fakeCosignScript(e: FakeCosignExpect): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const hex = (b: Buffer) => sha256(b).slice(7);
  return `#!/bin/sh
[ -z "\${LOG:-}" ] || echo "cosign $*" >>"$LOG"
[ -z "\${COSIGN_SLEEP:-}" ] || sleep "$COSIGN_SLEEP"
if [ -n "\${COSIGN_FAIL:-}" ]; then echo 'Error: no matching signatures' >&2; exit 1; fi
bad() { echo "Error: $*" >&2; exit 2; }
[ $# = 17 ] && [ "$1" = verify-blob-attestation ] && [ "$2" = --bundle ] && [ "$4" = --type ] &&
  [ "$5" = https://sigstore.dev/cosign/sign/v1 ] && [ "$6" = --trusted-root ] && [ "$8" = --offline ] &&
  [ "$9" = --certificate-identity-regexp ] && [ "\${11}" = --certificate-oidc-issuer ] &&
  [ "\${12}" = https://token.actions.githubusercontent.com ] &&
  [ "\${13}" = --certificate-github-workflow-trigger ] && [ "\${14}" = push ] &&
  [ "\${15}" = --certificate-github-workflow-repository ] || bad "unexpected arguments: $*"
[ -n "\${HOME:-}" ] && [ "$HOME" = "\${TUF_ROOT:-}" ] && [ -d "$HOME" ] && [ -z "$(ls -A "$HOME")" ] ||
  bad 'HOME and TUF_ROOT are not one empty directory'
[ "$(sha256sum "$7" | cut -d ' ' -f 1)" = ${q(e.rootSha256)} ] || bad 'not the pinned trusted root'
[ "$(sha256sum "$3" | cut -d ' ' -f 1)" = ${q(hex(RC2_BUNDLE))} ] || { echo 'Error: bundle does not parse' >&2; exit 1; }
if [ "\${10}" != ${q(e.identityRegexp)} ] || [ "\${16}" != ${q(e.repository)} ]; then
  echo 'Error: failed to verify certificate identity: no matching CertificateIdentity found' >&2; exit 1
fi
if [ "$(sha256sum "\${17}" | cut -d ' ' -f 1)" != ${q(hex(RC2_INDEX))} ]; then
  echo 'Error: failed to verify signature: provided artifact digests do not match digests in statement' >&2; exit 1
fi
echo 'Verified OK' >&2
`;
}
