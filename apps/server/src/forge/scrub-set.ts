import { withBasicAuth } from '@jumpmaster/protocol';

/** How many values the scrub set holds; past it, the oldest is evicted first. */
export const SCRUB_SET_LIMIT = 4096;

/** Shorter values are never registered, matching `containsSecret`'s threshold. */
const MIN_SECRET_LENGTH = 8;

/** A base64 line of a PEM at least this long is registered on its own. */
const MIN_PEM_LINE_LENGTH = 40;

const GITHUB_TOKEN_PREFIX = /^(gh[spuor]_|github_pat_)/;

/**
 * Secrets minted while this process runs (installation tokens, the app key, the JWTs signed with
 * it) that no configured secret list holds. Values stay past their expiry, since a log line may
 * still carry one, and leave only on eviction. The log scrub is the only reader of `values()`.
 */
export class ScrubSet {
  // A Map keeps insertion order: its first key is the oldest.
  readonly #values = new Map<string, true>();

  constructor(readonly limit: number = SCRUB_SET_LIMIT) {}

  /** Registers `secret`, and for a GitHub token also its git basic-auth form. */
  add(secret: string): void {
    if (GITHUB_TOKEN_PREFIX.test(secret)) {
      for (const v of withBasicAuth(secret)) this.#put(v);
    } else {
      this.#put(secret);
    }
  }

  /** Registers a PEM whole, its joined base64 body, and each long base64 line. */
  addPem(pem: string): void {
    this.#put(pem);
    this.#put(pem.trim());
    const lines = pem
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('-----'));
    this.#put(lines.join(''));
    for (const l of lines) if (l.length >= MIN_PEM_LINE_LENGTH) this.#put(l);
  }

  /** The registered values, oldest first. */
  values(): string[] {
    return [...this.#values.keys()];
  }

  /** Forgets every value (tests). */
  clear(): void {
    this.#values.clear();
  }

  #put(value: string): void {
    if (value.length < MIN_SECRET_LENGTH) return;
    // Re-adding moves the value to the newest position.
    this.#values.delete(value);
    this.#values.set(value, true);
    while (this.#values.size > this.limit) {
      const oldest = this.#values.keys().next().value as string;
      this.#values.delete(oldest);
    }
  }
}

/** The server-wide set; the log scrub (`scrub.ts`) reads it. */
export const serverScrubSet = new ScrubSet();
