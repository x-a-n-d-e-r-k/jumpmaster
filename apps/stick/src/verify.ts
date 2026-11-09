// Image trust. Under the `allowlist` policy (the default, M3's behaviour) an image runs if
// JM_ALLOWED_IMAGES names it exactly. Under `signed` (the stick image's policy) it runs only by
// digest, and only if the operator pinned that exact reference or cosign verifies a keyless
// signature from this repository's release workflow on a version tag, pushed by a `push`
// trigger. Every failure refuses: a tag, a non-zero exit, a timeout, output that doesn't parse,
// or a signed digest that isn't the one asked for. Successes are cached by digest for 7 days in a
// root-only file, so a short Sigstore outage doesn't stop images the stick already verified.
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type ImagePolicy, ImagePolicySchema } from '@jumpmaster/protocol';
import { allowedImages } from './runner.js';
import { stateDir } from './state.js';

/** The cosign the stick image ships; startup under `signed` refuses any other. */
export const COSIGN_VERSION = 'v3.1.4';
export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const VERIFY_TIMEOUT_MS = 60_000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A verified-at this far in the future is a clock or a forgery, not a success. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Who may sign the images this stick runs. Built from the repository, never from free text. */
export type Signer = {
  identityRegexp: string;
  issuer: string;
  trigger: 'push';
  repository: string;
};

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The certificate identity of `release.yml` in `repository`, run for a version tag: anchored at
 * both ends, so no other workflow, branch, tag shape or repository matches.
 */
export function identityRegexp(repository: string): string {
  return `^https://github\\.com/${escape(repository)}/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$`;
}

export function releaseSigner(repository: string): Signer {
  if (!REPOSITORY.test(repository))
    throw new Error(`the trusted signer must be a GitHub owner/name, not ${repository}`);
  return {
    identityRegexp: identityRegexp(repository),
    issuer: GITHUB_ISSUER,
    trigger: 'push',
    repository,
  };
}

/** What a cache entry was verified against: entries under another signer don't count. */
export const signerKey = (s: Signer): string =>
  JSON.stringify([s.identityRegexp, s.issuer, s.trigger, s.repository]);

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
export type Cosign = (args: string[], o: { timeoutMs: number }) => Promise<CosignResult>;

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
        { timeout: o.timeoutMs, maxBuffer: 8 * 1024 * 1024, env: childEnv, encoding: 'utf8' },
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

/** Whether `ref` may run under `trust`, and how that was decided. Never throws. */
export async function verifyImage(ref: string, trust: ImageTrust): Promise<Verdict> {
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
  const { signer, cosign } = trust;
  if (!signer) return refuse('this stick has no trusted signer');
  if (trust.cache?.has(digest)) return { ok: true, via: 'cache' };
  if (!cosign) return refuse('cosign is not available');
  let r: CosignResult;
  try {
    r = await cosign(
      [
        'verify',
        '--certificate-identity-regexp',
        signer.identityRegexp,
        '--certificate-oidc-issuer',
        signer.issuer,
        '--certificate-github-workflow-trigger',
        signer.trigger,
        '--certificate-github-workflow-repository',
        signer.repository,
        '--output',
        'json',
        '--',
        ref,
      ],
      { timeoutMs: trust.timeoutMs ?? VERIFY_TIMEOUT_MS },
    );
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
  trust.cache?.add(digest);
  return { ok: true, via: 'cosign' };
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
  const override = (env.JM_TRUSTED_SIGNER_REPOSITORY ?? '').trim();
  let signer: Signer;
  if (override) {
    if (!REPOSITORY.test(override))
      throw new Error(`JM_TRUSTED_SIGNER_REPOSITORY must be a GitHub owner/name, not ${override}`);
    signer = releaseSigner(override);
    deps.log(
      JSON.stringify({
        event: 'trusted-signer-override',
        repository: override,
        built: built ?? null,
      }),
    );
  } else if (built) {
    signer = releaseSigner(built);
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
