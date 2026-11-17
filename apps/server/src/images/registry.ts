// A reader of one repository on an OCI distribution registry (issue #140), over global `fetch`.
// It reads by digest: manifests and blobs are named by `sha256:…`, and the only names it ever
// asks for besides are the signature tags cosign derives from a digest (`sha256-<hex>` and
// `sha256-<hex>.sig`). It never resolves a tag, so it can't be pointed at "latest".
//
// Auth: an anonymous token from the registry's token service first (public packages). When that
// is refused, the read token (`registryReadToken`) is exchanged for a bearer at the same token
// service with Basic auth, as GHCR expects. The read token is sent only to a token service on the
// registry's own host and scheme, and both it and every bearer are registered with the scrub set.
//
// Outbound addresses the registry names (issue #256): a token service off the registry's own origin
// must be https and not a loopback, link-local, private or unique-local IP literal nor localhost,
// and its answer is never a redirect. Manifest and blob requests follow redirects (blobs live on
// storage hosts) only to https, and the bearer is not carried off the registry's origin.
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { ScrubSet } from '../forge/scrub-set.js';

export const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export const DOCKER_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
export const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const MANIFEST_ACCEPT = [OCI_INDEX, OCI_MANIFEST, DOCKER_LIST, DOCKER_MANIFEST].join(', ');

/** A manifest larger than this is refused (real ones are a few KiB). */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type FetchLike = typeof fetch;

/** A registry refusal or a transport failure, in words that hold no secret. */
export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type RegistryDeps = {
  /** The read token, read when an anonymous token is refused; undefined when none is set. */
  token?: () => string | undefined;
  scrub: Pick<ScrubSet, 'add'>;
  fetch?: FetchLike;
  /** `https` unless told otherwise (the tests' fake registry speaks plain HTTP on loopback). */
  scheme?: (host: string) => 'http' | 'https';
};

/** How many redirects a manifest or blob request follows. */
const MAX_REDIRECTS = 5;

const TOKEN_SERVICE_REFUSED = 'the registry named a token service that is not allowed';

function v4Refused(a: number, b: number): boolean {
  return (
    a === 0 || // 0.0.0.0/8: "this host"
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** An IPv6 literal as eight 16-bit groups, or undefined. */
function v6Groups(ip: string): number[] | undefined {
  let s = ip;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = (dotted[2] as string).split('.').map(Number);
    tail.push(
      ((o[0] as number) << 8) | (o[1] as number),
      ((o[2] as number) << 8) | (o[3] as number),
    );
    s = (dotted[1] as string).endsWith('::')
      ? (dotted[1] as string)
      : (dotted[1] as string).slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((g) => Number.parseInt(g, 16)));
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  return groups.some((g) => Number.isNaN(g)) ? undefined : groups;
}

/**
 * Whether a URL hostname (as `new URL` serializes it: IPv4 normalized, IPv6 bracketed) is
 * localhost or an IP literal in a loopback, link-local, private or unique-local range, including
 * an IPv4-mapped IPv6 one. Names are not resolved.
 */
export function isRefusedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIPv4(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return v4Refused(a, b);
  }
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (!isIPv6(bare)) return false;
  const g = v6Groups(bare);
  if (!g) return true; // An IPv6 literal we can't read is not trusted.
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeros(7) && ((g[7] as number) === 0 || (g[7] as number) === 1)) return true; // :: and ::1
  if (zeros(5) && (g[5] === 0xffff || g[5] === 0)) {
    // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible (::a.b.c.d).
    return v4Refused((g[6] as number) >> 8, (g[6] as number) & 0xff);
  }
  const first = g[0] as number;
  return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
}

type Challenge = { realm: string; service?: string; scope?: string };

/** `Bearer realm="…",service="…",scope="…"`, or undefined. */
export function parseChallenge(header: string | null): Challenge | undefined {
  if (!header || !/^Bearer\s/i.test(header)) return undefined;
  const out: Record<string, string> = {};
  for (const m of header.slice(7).matchAll(/([a-zA-Z]+)="([^"]*)"/g))
    out[(m[1] as string).toLowerCase()] = m[2] as string;
  if (!out.realm) return undefined;
  return {
    realm: out.realm,
    ...(out.service ? { service: out.service } : {}),
    ...(out.scope ? { scope: out.scope } : {}),
  };
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type Manifest = { mediaType: string; digest: string; bytes: Buffer };

/** One repository (`<owner>/<name>`) on one registry host. */
export class RegistryClient {
  readonly #base: string;
  readonly #fetch: FetchLike;
  #bearer: string | undefined;
  /** Set once anonymous access was refused: every later token comes from the read token. */
  #credentialed = false;

  constructor(
    readonly host: string,
    readonly repository: string,
    readonly deps: RegistryDeps,
  ) {
    const scheme = deps.scheme?.(host) ?? 'https';
    this.#base = `${scheme}://${host}`;
    this.#fetch = deps.fetch ?? ((...a) => fetch(...a));
  }

  /** A manifest by digest, its bytes checked against the digest. */
  async manifest(digest: string): Promise<Manifest> {
    if (!DIGEST.test(digest)) throw new RegistryError(`not a digest: ${digest}`);
    const m = await this.#manifest(digest);
    if (!m) throw new RegistryError(`manifest ${digest} not found`, 404);
    if (m.digest !== digest)
      throw new RegistryError(`manifest ${digest}: the registry served bytes of ${m.digest}`);
    return m;
  }

  /**
   * A signature tag cosign derives from `digest` (`sha256-<hex>` or `sha256-<hex>.sig`), or
   * undefined when the registry has none. Nothing else can be asked for by name.
   */
  async signatureTag(digest: string, suffix: '' | '.sig'): Promise<Manifest | undefined> {
    if (!DIGEST.test(digest)) throw new RegistryError(`not a digest: ${digest}`);
    return this.#manifest(`sha256-${digest.slice(7)}${suffix}`);
  }

  /** The OCI 1.1 referrers of `digest`, or undefined when the registry has no referrers API. */
  async referrers(digest: string): Promise<Manifest | undefined> {
    if (!DIGEST.test(digest)) throw new RegistryError(`not a digest: ${digest}`);
    const res = await this.#get(`/v2/${this.repository}/referrers/${digest}`, OCI_INDEX);
    if (res.status === 404 || res.status === 400 || res.status === 405) {
      await drain(res);
      return undefined;
    }
    if (!res.ok) throw await refusal(res, `referrers of ${digest}`);
    const bytes = await readCapped(res, MAX_MANIFEST_BYTES, `referrers of ${digest}`);
    return { mediaType: OCI_INDEX, digest: `sha256:${sha256Hex(bytes)}`, bytes };
  }

  /** A blob's body, unchecked: the store checks it as it arrives. */
  async blob(digest: string): Promise<ReadableStream<Uint8Array>> {
    if (!DIGEST.test(digest)) throw new RegistryError(`not a digest: ${digest}`);
    const res = await this.#get(`/v2/${this.repository}/blobs/${digest}`, '*/*');
    if (!res.ok) throw await refusal(res, `blob ${digest}`);
    if (!res.body) throw new RegistryError(`blob ${digest}: empty answer`);
    return res.body;
  }

  async #manifest(reference: string): Promise<Manifest | undefined> {
    const res = await this.#get(`/v2/${this.repository}/manifests/${reference}`, MANIFEST_ACCEPT);
    if (res.status === 404) {
      await drain(res);
      return undefined;
    }
    if (!res.ok) throw await refusal(res, `manifest ${reference}`);
    const bytes = await readCapped(res, MAX_MANIFEST_BYTES, `manifest ${reference}`);
    let mediaType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    try {
      const parsed = JSON.parse(bytes.toString()) as { mediaType?: unknown };
      if (typeof parsed.mediaType === 'string') mediaType = parsed.mediaType;
    } catch {
      throw new RegistryError(`manifest ${reference} is not JSON`);
    }
    return { mediaType, digest: `sha256:${sha256Hex(bytes)}`, bytes };
  }

  /** GET with the bearer held, authorizing on a 401 challenge (once anonymously, then the token). */
  async #get(path: string, accept: string): Promise<Response> {
    let res = await this.#send(path, accept);
    if (res.status !== 401) return res;
    const challenge = parseChallenge(res.headers.get('www-authenticate'));
    await drain(res);
    if (!challenge) throw new RegistryError(`${path}: refused (401) with no token challenge`, 401);
    if (!this.#credentialed) {
      const anon = await this.#exchange(challenge, undefined);
      if (anon) {
        this.#bearer = anon;
        res = await this.#send(path, accept);
        if (res.status !== 401 && res.status !== 403) return res;
        await drain(res);
      }
      this.#credentialed = true;
    }
    const token = this.deps.token?.();
    if (!token)
      throw new RegistryError(
        'the registry refused anonymous access: set the registryReadToken credential (JM_REGISTRY_READ_TOKEN) to a token that can read the packages',
        401,
      );
    const bearer = await this.#exchange(challenge, token);
    if (!bearer)
      throw new RegistryError(
        'the registry refused the registryReadToken credential: it needs read access to the packages',
        401,
      );
    this.#bearer = bearer;
    res = await this.#send(path, accept);
    if (res.status === 401 || res.status === 403) {
      await drain(res);
      throw new RegistryError(
        `the registry refused the registryReadToken credential for ${this.repository} (${res.status})`,
        res.status,
      );
    }
    return res;
  }

  /**
   * One GET, following redirects itself: only to https (or the registry's own origin), at most
   * MAX_REDIRECTS, and with the bearer only on the registry's own origin.
   */
  async #send(path: string, accept: string): Promise<Response> {
    const origin = new URL(this.#base).origin;
    let url = new URL(`${this.#base}${path}`);
    for (let hop = 0; ; hop++) {
      const own = url.origin === origin;
      let res: Response;
      try {
        res = await this.#fetch(url, {
          redirect: 'manual',
          headers: {
            Accept: accept,
            ...(own && this.#bearer ? { Authorization: `Bearer ${this.#bearer}` } : {}),
          },
        });
      } catch {
        // The exception may quote the request; say only where.
        throw new RegistryError(`${url.host} could not be reached`);
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      const location = res.headers.get('location');
      await drain(res);
      if (!location)
        throw new RegistryError(`${path}: the registry answered ${res.status}`, res.status);
      if (hop >= MAX_REDIRECTS) throw new RegistryError(`${path}: too many redirects`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new RegistryError(`${path}: the registry redirected to something that is not a URL`);
      }
      if (next.protocol !== 'https:' && next.origin !== origin)
        throw new RegistryError(`${path}: the registry redirected to ${next.host} without https`);
      url = next;
    }
  }

  /** A bearer from the token service, anonymously or with the read token; undefined if refused. */
  async #exchange(c: Challenge, token: string | undefined): Promise<string | undefined> {
    let realm: URL;
    try {
      realm = new URL(c.realm);
    } catch {
      throw new RegistryError('the registry named a token service that is not a URL');
    }
    const base = new URL(this.#base);
    const own = realm.host === base.host && realm.protocol === base.protocol;
    // Off the registry's own origin (which is https outside the tests), only a public https host.
    if (!own && (realm.protocol !== 'https:' || isRefusedHost(realm.hostname)))
      throw new RegistryError(TOKEN_SERVICE_REFUSED);
    if (token !== undefined && !own)
      // The read token goes to the registry's own token service, never to a host it names.
      throw new RegistryError(
        `the registry's token service is on ${realm.host}, not ${base.host}: the read token is not sent there`,
      );
    if (c.service) realm.searchParams.set('service', c.service);
    realm.searchParams.set('scope', `repository:${this.repository}:pull`);
    if (token !== undefined) this.deps.scrub.add(token);
    let res: Response;
    try {
      res = await this.#fetch(realm, {
        // A token service answers; it does not send the request on somewhere else.
        redirect: 'error',
        headers:
          token === undefined
            ? {}
            : { Authorization: `Basic ${Buffer.from(`jumpmaster:${token}`).toString('base64')}` },
      });
    } catch {
      throw new RegistryError(`the token service on ${realm.host} could not be reached`);
    }
    if (res.status === 401 || res.status === 403) {
      await drain(res);
      return undefined;
    }
    if (!res.ok) {
      await drain(res);
      throw new RegistryError(`the token service answered ${res.status}`, res.status);
    }
    let body: { token?: unknown; access_token?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RegistryError('the token service answered something other than JSON');
    }
    const bearer =
      typeof body.token === 'string'
        ? body.token
        : typeof body.access_token === 'string'
          ? body.access_token
          : undefined;
    if (!bearer) throw new RegistryError('the token service answered no token');
    this.deps.scrub.add(bearer);
    return bearer;
  }
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** A refusal in words: the status and what was asked for, never the registry's body. */
async function refusal(res: Response, what: string): Promise<RegistryError> {
  await drain(res);
  return new RegistryError(`${what}: the registry answered ${res.status}`, res.status);
}

async function readCapped(res: Response, max: number, what: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  if (!res.body) return Buffer.alloc(0);
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > max) {
      await res.body.cancel().catch(() => undefined);
      throw new RegistryError(`${what} is larger than ${max} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
