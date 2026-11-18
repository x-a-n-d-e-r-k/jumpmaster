// Image trust. Under the `allowlist` policy (the default, M3's behaviour) an image runs if
// JM_ALLOWED_IMAGES names it exactly. Under `signed` (the stick image's policy) it runs only by
// digest, and only if the operator pinned that exact reference or cosign verifies a keyless
// signature from this repository's release workflow on a version tag, pushed by a `push`
// trigger, and that tag is at or above the stick's own release version (issue #270: the version
// floor, read from the signing certificate after cosign verified it). Every failure refuses: a tag, a non-zero exit, a timeout, output that doesn't parse,
// or a signed digest that isn't the one asked for. Successes are cached by digest for 7 days in a
// root-only file, so a short Sigstore outage doesn't stop images the stick already verified.
// An image the server sent (issue #141) is verified fully offline (issue #167): the release's
// Sigstore bundle, checked by `cosign verify-blob-attestation` on the signed index's own bytes
// against the trusted root the stick image ships, in an empty HOME.
import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ImagePolicy, ImagePolicySchema } from '@jumpmaster/protocol';
import { fetchFromServer, fromServer, type ServerImages } from './fetch-image.js';
import { type PullDeps, pullImage } from './pull.js';
import { allowedImages } from './runner.js';
import { stateDir } from './state.js';

/** The cosign the stick image ships; startup under `signed` refuses any other. */
export const COSIGN_VERSION = 'v3.1.4';
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const VERIFY_TIMEOUT_MS = 60_000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A verified-at this far in the future is a clock or a forgery, not a success. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Sigstore's public-good trusted root, as the stick image ships it (images/sigstore). */
export const TRUSTED_ROOT_PATH = '/app/sigstore/trusted_root.json';
/** The predicate type of the statement the release's `cosign sign` bundles. */
export const SIGN_PREDICATE_TYPE = 'https://sigstore.dev/cosign/sign/v1';
/** The artifactType of an OCI 1.1 Sigstore bundle referrer. */
export const BUNDLE_ARTIFACT_TYPE = 'application/vnd.dev.sigstore.bundle.v0.3+json';
/** The server's layout annotation on a signature artifact: the digest it signs. */
export const SIGNATURE_OF = 'dev.jumpmaster.signature.of';
/** cosign's layout `kind` of the signed multi-arch index. */
export const IMAGE_INDEX_KIND = 'dev.cosignproject.cosign/imageIndex';

/** Who may sign the images this stick runs. Built from the repository, never from free text. */
export type Signer = {
  identityRegexp: string;
  issuer: string;
  trigger: 'push';
  repository: string;
  /**
   * This stick's own release version (/app/release.json): a signature counts only if it comes
   * from a release tag at or above it (issue #270). Null when the stick has none, which refuses
   * every signature.
   */
  floor: string | null;
};

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The certificate identity of `release.yml` in `repository`, run for a version tag: anchored at
 * both ends, so no other workflow, branch, tag shape or repository matches. It accepts every
 * version; the floor (`checkFloor`) then refuses a tag older than the stick.
 */
export function identityRegexp(repository: string): string {
  return `^https://github\\.com/${escape(repository)}/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$`;
}

export function releaseSigner(repository: string, floor: string | null): Signer {
  if (!REPOSITORY.test(repository))
    throw new Error(`the trusted signer must be a GitHub owner/name, not ${repository}`);
  return {
    identityRegexp: identityRegexp(repository),
    issuer: GITHUB_ISSUER,
    trigger: 'push',
    repository,
    floor,
  };
}

/**
 * What a cache entry was verified against: entries under another signer, or under another version
 * floor (a stick upgraded since), don't count.
 */
export const signerKey = (s: Signer): string =>
  JSON.stringify([s.identityRegexp, s.issuer, s.trigger, s.repository, s.floor]);

/** A release version: `X.Y.Z` or `X.Y.Z-rc.N`; `rc` null for a final release. */
export type ReleaseVersion = { major: number; minor: number; patch: number; rc: number | null };

const RELEASE_VERSION =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-rc\.(0|[1-9][0-9]{0,8}))?$/;

/** `X.Y.Z` or `X.Y.Z-rc.N` (no `v`), or null for anything else. */
export function parseReleaseVersion(v: string): ReleaseVersion | null {
  const m = RELEASE_VERSION.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4]),
  };
}

/** Semver order on release versions: `X.Y.Z-rc.N` < `X.Y.Z`, and `rc.N` < `rc.M` when N < M. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc - b.rc;
}

export const NO_RELEASE_VERSION = 'this stick has no release version';
export const NO_RELEASE_TAG = 'image signature carries no release tag';

/**
 * Whether a signature from release tag `tag` (`vX.Y.Z` or `vX.Y.Z-rc.N`; null when the signature
 * names none) may run on a stick whose own version is `own`: only at or above it (issue #270).
 * A missing or unparseable version or tag refuses; nothing falls back to "any release".
 */
export function checkFloor(
  tag: string | null,
  own: string | null,
): { ok: true } | { ok: false; reason: string } {
  const mine = own === null ? null : parseReleaseVersion(own);
  if (!mine) return { ok: false, reason: NO_RELEASE_VERSION };
  const theirs = tag?.startsWith('v') ? parseReleaseVersion(tag.slice(1)) : null;
  if (!theirs || tag === null) return { ok: false, reason: NO_RELEASE_TAG };
  if (compareReleaseVersions(theirs, mine) < 0)
    return { ok: false, reason: `image signed for ${tag}, older than this stick (${own})` };
  return { ok: true };
}

/**
 * The release tag in a signing identity: `<tag>` of
 * `https://github.com/<repository>/.github/workflows/release.yml@refs/tags/<tag>`, or null for
 * any other identity (another workflow or repository, a branch ref, no ref).
 */
export function releaseTagOf(identity: string, repository: string): string | null {
  const prefix = `https://github.com/${repository}/.github/workflows/release.yml@refs/tags/`;
  if (!identity.startsWith(prefix)) return null;
  const tag = identity.slice(prefix.length);
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : null;
}

/**
 * The URI SANs of a DER or PEM certificate, as node:crypto reads them. Null when it doesn't
 * parse. An entry Node had to quote (one holding a separator) is dropped, never split.
 */
export function certificateUris(cert: Buffer | string): string[] | null {
  let x: X509Certificate;
  try {
    x = new X509Certificate(cert);
  } catch {
    return null;
  }
  const san = x.subjectAltName;
  if (!san) return [];
  return san
    .split(', ')
    .filter((e) => e.startsWith('URI:'))
    .map((e) => e.slice(4));
}

/**
 * The release tag the signing certificate of a Sigstore bundle carries (its one URI SAN, on
 * `repository`'s release workflow), or null when the bundle has no certificate, the certificate
 * has no such SAN, or more than one.
 */
export function bundleReleaseTag(bundle: Buffer | string, repository: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(bundle.toString());
  } catch {
    return null;
  }
  const material = (v as { verificationMaterial?: unknown } | null)?.verificationMaterial as
    | {
        certificate?: { rawBytes?: unknown };
        x509CertificateChain?: { certificates?: { rawBytes?: unknown }[] };
      }
    | undefined;
  const raw =
    material?.certificate?.rawBytes ?? material?.x509CertificateChain?.certificates?.[0]?.rawBytes;
  if (typeof raw !== 'string' || raw === '') return null;
  const uris = certificateUris(Buffer.from(raw, 'base64'));
  if (!uris || uris.length !== 1) return null;
  return releaseTagOf(uris[0] as string, repository);
}

const DIGEST_REF = /^[^\s@-][^\s@]*@(sha256:[0-9a-f]{64})$/;

/** The digest of `name@sha256:<64 hex>`, or null for anything else (a tag, a flag, junk). */
export function digestOf(ref: string): string | null {
  return DIGEST_REF.exec(ref)?.[1] ?? null;
}

/**
 * `name@sha256:…` for a digest reference: a `name:tag@sha256:…` loses its tag, which the digest
 * overrides anyway (a registry port before the last `/` stays).
 */
export function canonicalRef(ref: string): string {
  const at = ref.lastIndexOf('@');
  if (at < 0) return ref;
  const name = ref.slice(0, at);
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  return `${colon > slash ? name.slice(0, colon) : name}${ref.slice(at)}`;
}

export type CosignResult = { code: number | null; stdout: string; stderr: string; error?: string };
/** `env` replaces those variables for this call only (an empty HOME and TUF_ROOT, say). */
export type Cosign = (
  args: string[],
  o: { timeoutMs: number; env?: Record<string, string> },
) => Promise<CosignResult>;

/**
 * The only variables cosign gets: where to find binaries, its home and temp dir, the TUF cache,
 * the CA store and an outbound proxy. No stick secret, and nothing (SIGSTORE_*, TUF_MIRROR,
 * COSIGN_*) that would change what it trusts.
 */
export const COSIGN_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TUF_ROOT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Variables cosign reads that would repoint its trust root or behaviour. */
const COSIGN_TRUST_VARS = /^(SIGSTORE_|COSIGN_|TUF_MIRROR$)/;

/** Runs cosign with `execFile` (no shell), a timeout, and only the COSIGN_ENV variables. */
export function execCosign(bin = 'cosign', env: NodeJS.ProcessEnv = process.env): Cosign {
  const childEnv = Object.fromEntries(
    COSIGN_ENV.flatMap((k) => (env[k] !== undefined ? [[k, env[k] as string]] : [])),
  ) as NodeJS.ProcessEnv;
  return (args, o) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: o.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...childEnv, ...o.env },
          encoding: 'utf8',
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: unknown };
          if (e.code === 'ENOENT')
            return resolve({ code: null, stdout, stderr, error: `cosign not found at ${bin}` });
          if (e.killed)
            return resolve({
              code: null,
              stdout,
              stderr,
              error: `timed out after ${o.timeoutMs / 1000}s`,
            });
          if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
          resolve({ code: null, stdout, stderr, error: e.message });
        },
      );
    });
}

type CacheFile = { version: 1; signer: string; entries: Record<string, string> };

/**
 * Digests cosign verified, with when. Only successes; persisted root-owned 0600 (the stick runs
 * as root in its image), and ignored whole if the file doesn't parse, isn't owned by this
 * process's user, is readable or writable by anyone else, or was written for another signer.
 */
export class VerifyCache {
  private entries: Record<string, string> | undefined;
  private readonly key: string;
  private readonly ttlMs: number;
  private readonly uid: number | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly file: string,
    signer: Signer,
    o: { ttlMs?: number; uid?: number; now?: () => Date } = {},
  ) {
    this.key = signerKey(signer);
    this.ttlMs = o.ttlMs ?? CACHE_TTL_MS;
    this.uid = o.uid ?? process.getuid?.();
    this.now = o.now ?? (() => new Date());
  }

  private load(): Record<string, string> {
    if (this.entries) return this.entries;
    this.entries = {};
    try {
      if (!existsSync(this.file)) return this.entries;
      const st = statSync(this.file);
      if (!st.isFile() || (st.mode & 0o777) !== 0o600) return this.entries;
      if (this.uid !== undefined && st.uid !== this.uid) return this.entries;
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CacheFile> | null;
      if (!v || v.version !== 1 || v.signer !== this.key) return this.entries;
      if (!v.entries || typeof v.entries !== 'object' || Array.isArray(v.entries))
        return this.entries;
      for (const [digest, at] of Object.entries(v.entries))
        if (/^sha256:[0-9a-f]{64}$/.test(digest) && typeof at === 'string')
          this.entries[digest] = at;
    } catch {
      // Unreadable or malformed: start empty; the next success rewrites it.
    }
    return this.entries;
  }

  has(digest: string): boolean {
    const at = Date.parse(this.load()[digest] ?? '');
    if (Number.isNaN(at)) return false;
    const now = this.now().getTime();
    return at <= now + CLOCK_SKEW_MS && now - at < this.ttlMs;
  }

  /** Records a success and rewrites the file atomically; a write failure only loses the cache. */
  add(digest: string): void {
    const entries = this.load();
    const now = this.now().getTime();
    // Expired, unparsable and future-dated entries all go.
    for (const [d, at] of Object.entries(entries)) {
      const t = Date.parse(at);
      if (!(now - t < this.ttlMs) || t > now + CLOCK_SKEW_MS) delete entries[d];
    }
    entries[digest] = new Date(now).toISOString();
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const body: CacheFile = { version: 1, signer: this.key, entries };
      writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      // The success still stands for this drop; only the persisted copy is lost.
    }
  }
}

export type ImageTrust = {
  policy: ImagePolicy;
  /** `allowlist`: the images allowed. `signed`: digest pins that need no signature. */
  allowed: ReadonlySet<string>;
  signer?: Signer;
  cosign?: Cosign;
  cache?: VerifyCache;
  timeoutMs?: number;
  /** Fetching missing images from the Jumpmaster server (issue #141); absent, the registry. */
  server?: ServerImages;
  /** The trusted root a server layout is verified against; default TRUSTED_ROOT_PATH. */
  trustedRoot?: string;
};

export type Verdict =
  | { ok: true; via: 'allowlist' | 'pinned' | 'cache' | 'cosign' }
  | { ok: false; reason: string };

/** The line of cosign's stderr that says why, without its `Error: ` prefix. */
function cosignWhy(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const line = lines.find((l) => l.startsWith('Error:')) ?? lines.at(-1) ?? '';
  return line.replace(/^Error:\s*/, '').slice(0, 300);
}

/** A verdict cosign must still give, on `digest`, with how to say no. */
type NeedsSignature = { digest: string; refuse: (why: string) => Verdict };

/** Whether `ref` may run under `trust`, and how that was decided. Never throws. */
export async function verifyImage(ref: string, trust: ImageTrust): Promise<Verdict> {
  const pre = decideWithoutCosign(ref, trust);
  if ('ok' in pre) return pre;
  if (!trust.cosign) return pre.refuse('cosign is not available');
  const signer = trust.signer as Signer;
  return runCosign(
    [...identityArgs(signer), '--output', 'json', '--', ref],
    pre.digest,
    trust,
    pre.refuse,
  );
}

/**
 * Everything decided without cosign: the allow-list, a tag under signed, a pin, a cached
 * success, no signer; otherwise the digest cosign must verify.
 */
function decideWithoutCosign(ref: string, trust: ImageTrust): Verdict | NeedsSignature {
  const refuseTag = (why: string): Verdict => ({
    ok: false,
    reason: `image not verified: ${ref}: ${why}`,
  });
  if (trust.policy === 'allowlist')
    return trust.allowed.has(ref)
      ? { ok: true, via: 'allowlist' }
      : { ok: false, reason: `image not allowed: ${ref}` };
  const digest = digestOf(ref);
  if (!digest)
    return refuseTag(
      'a tag reference; under the signed image policy images run only by digest (name@sha256:<64 hex>)',
    );
  // A pin is a name and a digest; a tag on either side doesn't change what runs.
  const canonical = canonicalRef(ref);
  const pins = [...trust.allowed].filter((p) => digestOf(p) !== null);
  if (pins.some((p) => canonicalRef(p) === canonical)) return { ok: true, via: 'pinned' };
  const elsewhere = pins.find((p) => digestOf(p) === digest);
  const hint = elsewhere
    ? `; JM_ALLOWED_IMAGES pins this digest as ${elsewhere}, under another name: a pin matches only the same name and digest`
    : '';
  const refuse = (why: string): Verdict => ({
    ok: false,
    reason: `image not verified: ${ref}: ${why}${hint}`,
  });
  if (!trust.signer) return refuse('this stick has no trusted signer');
  // No version, no floor: every signature is refused, never accepted as "any release" (#270).
  const floor = trust.signer.floor;
  if (floor === null || !parseReleaseVersion(floor)) return refuse(NO_RELEASE_VERSION);
  if (trust.cache?.has(digest)) return { ok: true, via: 'cache' };
  return { digest, refuse };
}

/** The pinned identity flags: who may have signed (issue #141 keeps them for offline checks). */
const identityArgs = (signer: Signer): string[] => [
  '--certificate-identity-regexp',
  signer.identityRegexp,
  '--certificate-oidc-issuer',
  signer.issuer,
  '--certificate-github-workflow-trigger',
  signer.trigger,
  '--certificate-github-workflow-repository',
  signer.repository,
];

/**
 * Runs `cosign verify <args>` and reads its verdict: a success only when cosign exits 0 and every
 * payload it printed names `digest`. A success is cached.
 */
async function runCosign(
  args: string[],
  digest: string,
  trust: ImageTrust,
  refuse: (why: string) => Verdict,
): Promise<Verdict> {
  const cosign = trust.cosign;
  if (!cosign) return refuse('cosign is not available');
  let r: CosignResult;
  try {
    r = await cosign(['verify', ...args], { timeoutMs: trust.timeoutMs ?? VERIFY_TIMEOUT_MS });
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  if (r.error) return refuse(r.error);
  if (r.code !== 0) {
    const why = cosignWhy(r.stderr);
    return refuse(`cosign exit ${r.code}${why ? `: ${why}` : ''}`);
  }
  let payloads: unknown;
  try {
    payloads = JSON.parse(r.stdout.trim());
  } catch {
    return refuse('cosign output does not parse');
  }
  const signed = Array.isArray(payloads)
    ? payloads.map(
        (p) =>
          (p as { critical?: { image?: { 'docker-manifest-digest'?: unknown } } } | null)?.critical
            ?.image?.['docker-manifest-digest'],
      )
    : [];
  if (signed.length === 0 || signed.some((d) => typeof d !== 'string'))
    return refuse('cosign output names no signed digest');
  const other = signed.find((d) => d !== digest);
  if (other !== undefined) return refuse(`cosign verified ${other}, not ${digest}`);
  // The release tag each signature's certificate names (cosign reports its SAN as
  // `optional.Subject`): one at or above this stick's version is needed (issue #270).
  const signer = trust.signer as Signer;
  let floor: { ok: true } | { ok: false; reason: string } = { ok: false, reason: NO_RELEASE_TAG };
  for (const p of payloads as { optional?: { Subject?: unknown } | null }[]) {
    const subject = p?.optional?.Subject;
    const tag = typeof subject === 'string' ? releaseTagOf(subject, signer.repository) : null;
    floor = checkFloor(tag, signer.floor);
    if (floor.ok) break;
  }
  if (!floor.ok) return refuse(floor.reason);
  trust.cache?.add(digest);
  return { ok: true, via: 'cosign' };
}

/** Index, manifest and bundle blobs are small; a larger one is refused unread. */
export const META_CAP_BYTES = 4 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class Refused extends Error {}

/** A small JSON object from `path`, or a refusal naming `what`. */
function readObject(path: string, what: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Refused(`the layout has no ${what}`);
  if (statSync(path).size > META_CAP_BYTES) throw new Refused(`${what} is too large`);
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // below
  }
  throw new Refused(`${what} is not JSON`);
}

/**
 * The path of blob `digest` in `dir`, after checking its content hashes to it. Every blob checked
 * here is small (an index, a signature manifest, a bundle): one over `META_CAP_BYTES` is refused
 * before it is read (issue #257).
 */
function checkedBlob(dir: string, digest: unknown, what: string): string {
  if (typeof digest !== 'string' || !SHA256.test(digest))
    throw new Refused(`${what} has no sha256 digest`);
  const path = join(dir, 'blobs', 'sha256', digest.slice(7));
  const st = existsSync(path) ? statSync(path) : undefined;
  if (!st?.isFile()) throw new Refused(`${what} ${digest} is not in the layout`);
  if (st.size > META_CAP_BYTES) throw new Refused(`${what} is too large`);
  const got = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  if (got !== digest) throw new Refused(`${what} does not hash to ${digest}`);
  return path;
}

type Descriptor = { digest?: unknown; artifactType?: unknown; annotations?: unknown };
const annotation = (d: Descriptor, key: string): unknown =>
  d.annotations && typeof d.annotations === 'object'
    ? (d.annotations as Record<string, unknown>)[key]
    : undefined;

/**
 * Verifies that the layout in `dir` carries the release workflow's signature on image index
 * `digest`, fully offline (issue #167). The steps:
 * 1. `index.json` names the image index `digest` (kind `dev.cosignproject.cosign/imageIndex`),
 *    whose blob hashes to `digest`;
 * 2. every entry annotated `dev.jumpmaster.signature.of: digest` with the Sigstore bundle
 *    artifactType is a manifest of one layer, the bundle, each hash-checked;
 * 3. `cosign verify-blob-attestation` checks each bundle on the index blob with the pinned
 *    identity and `trustedRoot`, `--offline`, its HOME and TUF_ROOT an empty temporary directory
 *    (so no cache and no TUF fetch can stand in for the pinned root).
 * Verified when one bundle verifies; otherwise refused with why, naming cosign's last error.
 * Never throws. The installer (apps/server/src/install/stick-sh.ts) runs the same steps in sh.
 */
export async function verifyIndexBundles(
  dir: string,
  digest: string,
  o: { signer: Signer; cosign?: Cosign; trustedRoot: string; timeoutMs: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const bundles: string[] = [];
  let indexBlob: string;
  try {
    const index = readObject(join(dir, 'index.json'), 'index.json');
    const entries = (Array.isArray(index.manifests) ? index.manifests : []).filter(
      (m: unknown): m is Descriptor => m !== null && typeof m === 'object',
    );
    if (!entries.some((m) => m.digest === digest && annotation(m, 'kind') === IMAGE_INDEX_KIND))
      throw new Refused(`the layout has no image index ${digest}`);
    indexBlob = checkedBlob(dir, digest, 'the image index blob');
    const signatures = entries.filter(
      (m) => annotation(m, SIGNATURE_OF) === digest && m.artifactType === BUNDLE_ARTIFACT_TYPE,
    );
    if (signatures.length === 0)
      throw new Refused(`the layout has no Sigstore bundle signing ${digest}`);
    for (const s of signatures) {
      const what = `the signature manifest ${String(s.digest)}`;
      const m = readObject(checkedBlob(dir, s.digest, what), what);
      const layers = Array.isArray(m.layers) ? m.layers : [];
      if (layers.length !== 1) throw new Refused(`${what} does not hold exactly one layer`);
      const layer = (layers[0] as Descriptor | null)?.digest;
      bundles.push(checkedBlob(dir, layer, `the Sigstore bundle ${String(layer)}`));
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const cosign = o.cosign;
  if (!cosign) return { ok: false, reason: 'cosign is not available' };
  let why = '';
  for (const bundle of bundles) {
    const home = mkdtempSync(join(tmpdir(), 'jm-cosign-'));
    try {
      const r = await cosign(
        [
          'verify-blob-attestation',
          '--bundle',
          bundle,
          '--type',
          SIGN_PREDICATE_TYPE,
          '--trusted-root',
          o.trustedRoot,
          '--offline',
          ...identityArgs(o.signer),
          indexBlob,
        ],
        { timeoutMs: o.timeoutMs, env: { HOME: home, TUF_ROOT: home } },
      );
      if (!r.error && r.code === 0) {
        // Verified; now its age: the certificate's release tag against this stick's (#270).
        const floor = checkFloor(
          bundleReleaseTag(readFileSync(bundle), o.signer.repository),
          o.signer.floor,
        );
        if (floor.ok) return { ok: true };
        why = floor.reason;
        continue;
      }
      const line = cosignWhy(r.stderr);
      why = r.error ?? `cosign exit ${r.code}${line ? `: ${line}` : ''}`;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  return { ok: false, reason: why };
}

/**
 * Verifies `ref` from an OCI image layout the server sent (issue #141), fully offline with the
 * pinned trusted root (issue #167, `verifyIndexBundles`). Nothing is asked of the registry or of
 * Sigstore; the server is no trust anchor, since what it sent must carry the release workflow's
 * signature on `ref`'s digest. A success is cached. Never throws.
 */
export async function verifyLayout(dir: string, ref: string, trust: ImageTrust): Promise<Verdict> {
  const pre = decideWithoutCosign(ref, trust);
  if ('ok' in pre) return pre;
  if (!trust.cosign) return pre.refuse('cosign is not available');
  const r = await verifyIndexBundles(dir, pre.digest, {
    signer: trust.signer as Signer,
    cosign: trust.cosign,
    trustedRoot: trust.trustedRoot ?? TRUSTED_ROOT_PATH,
    timeoutMs: trust.timeoutMs ?? VERIFY_TIMEOUT_MS,
  });
  if (!r.ok) return pre.refuse(r.reason);
  trust.cache?.add(pre.digest);
  return { ok: true, via: 'cosign' };
}

/**
 * Under signed, a decision that needs no signature check: a refusal, a pin or a digest verified
 * before; `null` when only a signature can decide. Under allowlist, the allow-list's answer.
 */
export function verifiedWithoutSignature(ref: string, trust: ImageTrust): Verdict | null {
  const pre = decideWithoutCosign(ref, trust);
  return 'ok' in pre ? pre : null;
}

/** What the stick image's build recorded (/app/release.json). */
export type ReleaseInfo = { version?: string | null; repository?: string | null };

const isDigestRef = (ref: string) => digestOf(ref) !== null;

/**
 * The image trust this stick runs with, checked at startup. Under `signed` it refuses to start,
 * with the reason, when cosign is missing or not the pinned version, when a pin is not a digest,
 * or when there is no trusted signer. JM_TRUSTED_SIGNER_REPOSITORY (for forks) overrides the
 * repository built into the image, and is logged.
 */
export async function prepareImageTrust(
  env: NodeJS.ProcessEnv,
  deps: { cosign: Cosign; release?: ReleaseInfo; log: (line: string) => void },
): Promise<ImageTrust> {
  return buildTrust(env, deps);
}

/**
 * The stick's own trooper image (`TROOPER_IMAGE`) runs its init, self-check and push containers,
 * so it is verified under the image policy like a drop's image, then pulled (Ruling 17). A failure
 * never stops the stick: it is logged loudly and push-v1 is withheld while it stands (the stick
 * still leases non-pushing roles); every sweep checks again, so a fixed image recovers.
 */
export async function verifyBaseImage(
  image: string,
  deps: { trust: ImageTrust; driver: PullDeps['driver']; log: (line: string) => void },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const refuse = (why: string) => {
    const reason = `base image ${image}: ${why}`;
    deps.log(
      JSON.stringify({ event: 'base-image', image, ok: false, effect: 'push-v1 withheld', reason }),
    );
    return { ok: false as const, reason };
  };
  const server = fromServer(deps.trust);
  if (server) {
    // From the server, verified offline before it loads (issue #141); the allow-list as ever.
    if (deps.trust.policy === 'allowlist') {
      const v = await verifyImage(image, deps.trust);
      if (!v.ok) return refuse(v.reason);
    }
    const v = await fetchFromServer(image, deps.trust, server);
    return v.ok ? { ok: true } : refuse(v.reason);
  }
  const v = await verifyImage(image, deps.trust);
  if (!v.ok) return refuse(v.reason);
  try {
    await pullImage(image, { driver: deps.driver, log: deps.log });
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  return { ok: true };
}

async function buildTrust(
  env: NodeJS.ProcessEnv,
  deps: { cosign: Cosign; release?: ReleaseInfo; log: (line: string) => void },
): Promise<ImageTrust> {
  const policy = ImagePolicySchema.safeParse(env.JM_IMAGE_POLICY || 'allowlist');
  if (!policy.success)
    throw new Error(`JM_IMAGE_POLICY must be allowlist or signed, not ${env.JM_IMAGE_POLICY}`);
  if (policy.data === 'allowlist') return { policy: 'allowlist', allowed: allowedImages(env) };

  for (const name of Object.keys(env).sort())
    if (COSIGN_TRUST_VARS.test(name) && env[name] !== undefined)
      throw new Error(`${name} is set: it would change what cosign trusts; unset it`);

  const pins = (env.JM_ALLOWED_IMAGES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const pin of pins)
    if (!isDigestRef(pin))
      throw new Error(
        `JM_ALLOWED_IMAGES entry ${pin} is not a digest reference (name@sha256:<64 hex>); under the signed image policy every pin must be one`,
      );
  for (const name of ['JM_TROOPER_IMAGE', 'JM_EGRESS_IMAGE']) {
    const v = (env[name] ?? '').trim();
    if (v && !isDigestRef(v))
      throw new Error(
        `${name} ${v} is not a digest reference (name@sha256:<64 hex>), which the signed image policy requires`,
      );
  }

  const built = deps.release?.repository ?? undefined;
  // The version floor (issue #270): a signature counts only from this release or a later one.
  const version = deps.release?.version ?? null;
  const floor = version !== null && parseReleaseVersion(version) ? version : null;
  if (floor === null)
    deps.log(
      JSON.stringify({
        event: 'no-release-version',
        version,
        effect: 'every signed image is refused',
        reason: NO_RELEASE_VERSION,
      }),
    );
  const override = (env.JM_TRUSTED_SIGNER_REPOSITORY ?? '').trim();
  let signer: Signer;
  if (override) {
    if (!REPOSITORY.test(override))
      throw new Error(`JM_TRUSTED_SIGNER_REPOSITORY must be a GitHub owner/name, not ${override}`);
    signer = releaseSigner(override, floor);
    deps.log(
      JSON.stringify({
        event: 'trusted-signer-override',
        repository: override,
        built: built ?? null,
      }),
    );
  } else if (built) {
    signer = releaseSigner(built, floor);
  } else {
    throw new Error(
      'no trusted signer: this stick image was built without RELEASE_REPOSITORY, so it cannot verify signed images. Use a release stick image, set JM_TRUSTED_SIGNER_REPOSITORY=<owner/name> for a fork, or JM_IMAGE_POLICY=allowlist',
    );
  }

  const v = await deps.cosign(['version', '--json'], { timeoutMs: 10_000 }).catch(
    (e: unknown): CosignResult => ({
      code: null,
      stdout: '',
      stderr: '',
      error: e instanceof Error ? e.message : String(e),
    }),
  );
  if (v.error || v.code !== 0)
    throw new Error(
      `${v.error ?? `cosign version exited ${v.code}`}: JM_IMAGE_POLICY=signed needs cosign ${COSIGN_VERSION} (the stick image ships it)`,
    );
  let found: unknown;
  try {
    found = (JSON.parse(v.stdout) as { gitVersion?: unknown }).gitVersion;
  } catch {
    found = undefined;
  }
  if (typeof found !== 'string') throw new Error('cosign version does not parse');
  if (found !== COSIGN_VERSION)
    throw new Error(`cosign is ${found}, not the pinned ${COSIGN_VERSION}`);

  // cosign keeps the Sigstore TUF root here; the stick's state directory is its only writable one.
  const dir = stateDir(env);
  const tuf = env.TUF_ROOT || join(dir, 'sigstore');
  mkdirSync(tuf, { recursive: true, mode: 0o700 });
  chmodSync(tuf, 0o700);

  return {
    policy: 'signed',
    allowed: new Set(pins),
    signer,
    cosign: deps.cosign,
    cache: new VerifyCache(join(dir, 'verified.json'), signer),
  };
}
