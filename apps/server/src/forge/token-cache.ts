/**
 * In-memory cache for the server's own installation tokens (spec §4.2, §13 Task 5).
 *
 * Tokens live only in process memory: never in the vault, on disk or in a log. Every minted
 * token goes to `register` (the redaction scrub set) before any caller sees it. A token is
 * re-minted once fewer than ten minutes of its life remain; the spec states that threshold for
 * the author token and is silent for the reviewer token, so the same rule applies to both.
 *
 * Unsuspending an installation brings its old tokens back, so a mint in progress when its key is
 * invalidated or the cache cleared (the kill switch) is never cached once it completes.
 *
 * The key includes the token's use (§4.2's table), so tokens narrowed to different permission sets
 * never share a slot: a `contents: read` token is never handed out for a `pull_requests: write` use.
 */

export interface TokenKey {
  owner: string;
  role: 'author' | 'reviewer';
  repositoryId: number;
  /** The use the token is narrowed for: a key of `USE_PERMISSIONS` in `github-app.ts`. */
  use: string;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

export interface TokenCacheDeps {
  /** Mints an installation token narrowed to the key's repository and role. */
  mint: (key: TokenKey) => Promise<MintedToken>;
  /** Adds a token to redaction. */
  register: (token: string) => void;
  /** The current time in epoch milliseconds. */
  now: () => number;
}

export interface TokenCache {
  token(key: TokenKey): Promise<string>;
  /** Drops the key's cached token and detaches any mint in progress for it (on a 401). */
  invalidate(key: TokenKey): void;
  /** Drops every cached token and detaches every mint in progress (the kill switch). */
  clear(): void;
}

/** A cached token is re-minted once less than this much of its life remains. */
export const REMINT_THRESHOLD_MS = 10 * 60 * 1000;

/** Raised when a token cannot be minted. Its message names only the role and owner. */
export class TokenCacheError extends Error {
  constructor(key: TokenKey, options?: { cause?: unknown }) {
    super(`could not mint the ${key.role} installation token for ${key.owner}`, options);
    this.name = 'TokenCacheError';
  }
}

/** A mint in progress; its identity marks whether it is still the key's current mint. */
interface Flight {
  promise: Promise<string>;
}

const keyId = (key: TokenKey): string => JSON.stringify([key.owner, key.role, key.repositoryId, key.use]);

export function createTokenCache({ mint, register, now }: TokenCacheDeps): TokenCache {
  const cached = new Map<string, MintedToken>();
  const inFlight = new Map<string, Flight>();

  const fresh = (entry: MintedToken | undefined): entry is MintedToken =>
    entry !== undefined && entry.expiresAt.getTime() - now() >= REMINT_THRESHOLD_MS;

  function start(id: string, key: TokenKey): Promise<string> {
    // The flight is registered before mint runs, so the body can tell whether it is still current.
    const flight: Flight = { promise: Promise.resolve('') };
    inFlight.set(id, flight);
    flight.promise = (async () => {
      let minted: MintedToken | undefined;
      let cause: unknown;
      try {
        minted = await mint({ ...key });
        register(minted.token);
      } catch (err) {
        minted = undefined;
        cause = err;
      }
      // Still current only if no invalidate or clear detached this mint since it started.
      const attached = inFlight.get(id) === flight;
      if (attached) inFlight.delete(id);
      if (minted === undefined) throw new TokenCacheError(key, { cause });
      if (attached) cached.set(id, minted);
      return minted.token;
    })();
    return flight.promise;
  }

  return {
    token(key) {
      const id = keyId(key);
      const entry = cached.get(id);
      if (fresh(entry)) return Promise.resolve(entry.token);
      return inFlight.get(id)?.promise ?? start(id, key);
    },
    invalidate(key) {
      const id = keyId(key);
      cached.delete(id);
      inFlight.delete(id);
    },
    clear() {
      cached.clear();
      inFlight.clear();
    },
  };
}

/**
 * Wires one cache key to the forge's token-provider interface (`TokenProvider` in `github.ts`,
 * matched by shape: this module imports nothing).
 */
export function cachedTokenProvider(
  cache: TokenCache,
  key: TokenKey,
): { token(): Promise<string>; invalidate(): void } {
  return {
    token: () => cache.token(key),
    invalidate: () => cache.invalidate(key),
  };
}
