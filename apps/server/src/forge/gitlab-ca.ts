// The fetch the server's own GitLab calls use (issue #919, spec §9, design spec §5.5): for a zone
// with `gitlab.caCert`, one that trusts the system roots plus that zone's private CA certificates.
//
// Node's global fetch bundles its own undici, and an Agent from a separately installed undici is
// not guaranteed to work as its `dispatcher` when the versions differ. So the CA's Agent is paired
// with the installed undici's own `fetch`, never with the global one.
//
// Verification is never turned off: the Agent only widens the trusted CA list. Its errors are replaced by a
// fixed one, so none holds PEM text, and a cache key holds only a digest of the bundle.

import { createHash } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

/** What the CA's Agent is built from: the system roots and the zone's certificates. */
export type GitlabCaAgentOptions = { connect: { ca: string[] } };

/** The fetch the Agent is paired with: it must accept that Agent as `dispatcher`. */
export type DispatcherFetch = (
  input: string | URL | Request,
  init: RequestInit & { dispatcher: Dispatcher },
) => Promise<Response>;

/** Seams for tests: the Agent factory and the fetch it is used with. */
export type GitlabCaDeps = {
  agentFactory?: (opts: GitlabCaAgentOptions) => Dispatcher;
  fetch?: DispatcherFetch;
};

const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** A short digest of a CA bundle, or null without one: never the PEM. */
export function gitlabCaDigest(caCert: string | undefined): string | null {
  if (!caCert) return null;
  return createHash('sha256').update(caCert).digest('hex').slice(0, 16);
}

const defaultDeps: GitlabCaDeps = {};
/** Per deps (the defaults or a test's), the CA fetch per bundle digest. */
const caches = new WeakMap<GitlabCaDeps, Map<string, typeof fetch>>();

/** Said in place of any error of a CA fetch, which could hold the bundle. */
const FAILED = 'GitLab request failed';

/**
 * The fetch for a GitLab zone's `gitlab.caCert`. Without one (undefined or empty) it is the global
 * `fetch` itself. With one it sends through an undici Agent whose `connect.ca` is
 * `tls.rootCertificates` plus every certificate in the bundle, one per distinct bundle.
 */
export function gitlabFetchFor(
  caCert: string | undefined,
  deps: GitlabCaDeps = defaultDeps,
): typeof fetch {
  const digest = gitlabCaDigest(caCert);
  if (digest === null || caCert === undefined) return globalThis.fetch;
  let cache = caches.get(deps);
  if (!cache) {
    cache = new Map();
    caches.set(deps, cache);
  }
  const hit = cache.get(digest);
  if (hit) return hit;
  const made = caFetch(caCert, deps);
  cache.set(digest, made);
  return made;
}

function caFetch(caCert: string, deps: GitlabCaDeps): typeof fetch {
  const zoneCerts = caCert.match(PEM_CERT) ?? [];
  const opts: GitlabCaAgentOptions = { connect: { ca: [...rootCertificates, ...zoneCerts] } };
  const dispatcher = (deps.agentFactory ?? ((o) => new Agent(o)))(opts);
  const send = deps.fetch ?? (undiciFetch as unknown as DispatcherFetch);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await send(input, { ...init, dispatcher });
    } catch (e) {
      throw scrubbed(e);
    }
  }) as typeof fetch;
}

/**
 * The error to rethrow, never the original: its message or cause (undici's TLS error included)
 * could quote the bundle. An abort or timeout keeps its name, as callers tell those apart by it.
 */
function scrubbed(e: unknown): Error {
  const err = new TypeError(FAILED);
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))
    err.name = e.name;
  return err;
}
