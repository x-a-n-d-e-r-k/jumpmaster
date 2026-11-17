import { withBasicAuth } from '@jumpmaster/protocol';
import { log } from '../log.js';

/** How many evictable values the scrub set holds; past it, the oldest is evicted first. */
export const SCRUB_SET_LIMIT = 4096;

/** Said at the first eviction of a process and every `EVICTION_WARN_EVERY`th after. */
export const EVICTION_WARNING =
  'scrub set full: oldest minted values are no longer scrubbed by value';
export const EVICTION_WARN_EVERY = 1000;

/** Shorter values are never registered, matching `containsSecret`'s threshold. */
const MIN_SECRET_LENGTH = 8;

/** A base64 line of a PEM at least this long is registered on its own. */
const MIN_PEM_LINE_LENGTH = 40;

const GITHUB_TOKEN_PREFIX = /^(gh[spuor]_|github_pat_)/;

/**
 * Secrets minted while this process runs (installation tokens, the app key, the JWTs signed with
 * it) that no configured secret list holds. Values stay past their expiry, since a log line may
 * still carry one, and leave only on eviction. Key material (an app private key, the vault key) is
 * pinned: never evicted and not counted toward `limit`. Minted values (tokens, JWTs, registry
 * bearers, invite codes) stay evictable; the first eviction, and every 1,000th after, is logged.
 */
export class ScrubSet {
  // A Map keeps insertion order: its first key is the oldest.
  readonly #values = new Map<string, true>();
  readonly #pinned = new Set<string>();
  #evictions = 0;

  constructor(
    readonly limit: number = SCRUB_SET_LIMIT,
    // Called through a closure: `log.ts` imports this module (through `scrub.ts`), so `log` may
    // not be bound yet when the server-wide set below is built.
    private readonly warn: (line: string) => void = (line) => log(line),
  ) {}

  /** Registers `secret` for good: it is never evicted and does not count toward the limit. */
  pin(secret: string): void {
    if (secret.length < MIN_SECRET_LENGTH) return;
    this.#values.delete(secret);
    this.#pinned.add(secret);
  }

  /** Registers `secret`, and for a GitHub token also its git basic-auth form. */
  add(secret: string): void {
    if (GITHUB_TOKEN_PREFIX.test(secret)) {
      for (const v of withBasicAuth(secret)) this.#put(v);
    } else {
      this.#put(secret);
    }
  }

  /**
   * Pins a private key: the PEM whole, its joined base64 body, and each long base64 line. Key
   * material stays in use as long as the config holds it, so it is never evicted.
   */
  addPem(pem: string): void {
    this.pin(pem);
    this.pin(pem.trim());
    const lines = pem
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('-----'));
    this.pin(lines.join(''));
    for (const l of lines) if (l.length >= MIN_PEM_LINE_LENGTH) this.pin(l);
  }

  /** The registered values: pinned first, then the evictable ones, oldest first. */
  values(): string[] {
    return [...this.#pinned, ...this.#values.keys()];
  }

  /** Forgets every value, pinned ones too, and the eviction count (tests). */
  clear(): void {
    this.#values.clear();
    this.#pinned.clear();
    this.#evictions = 0;
  }

  #put(value: string): void {
    if (value.length < MIN_SECRET_LENGTH || this.#pinned.has(value)) return;
    // Re-adding moves the value to the newest position.
    this.#values.delete(value);
    this.#values.set(value, true);
    while (this.#values.size > this.limit) {
      const oldest = this.#values.keys().next().value as string;
      this.#values.delete(oldest);
      if (this.#evictions++ % EVICTION_WARN_EVERY === 0) this.warn(EVICTION_WARNING);
    }
  }
}

/** The server-wide set; the log scrub (`scrub.ts`) and the server redactors (`redactionList`) read it. */
export const serverScrubSet = new ScrubSet();
