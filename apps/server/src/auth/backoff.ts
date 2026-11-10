/** Wait after the first failure, the factor per further failure, and the cap. */
export const BACKOFF = { startMs: 1000, factor: 2, maxMs: 300_000 } as const;

/** Past this many tracked sources, entries whose wait ended a cap ago are dropped. */
const MAX_TRACKED = 10_000;

type Entry = { failures: number; untilMs: number };

/**
 * Per-source backoff for credential guesses (the setup code, the passphrase). A source that fails
 * waits 1 s, then 2 s, doubling to 5 min; it is never locked out, and no global key exists, so one
 * source cannot stall another. Callers charge `fail` only for an attempt that passed the Host and
 * Origin checks and then failed its credential, and `reset` on success.
 */
export class Backoff {
  private readonly entries = new Map<string, Entry>();

  check(key: string, now: Date): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const e = this.entries.get(key);
    const wait = e ? e.untilMs - now.getTime() : 0;
    return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true };
  }

  fail(key: string, now: Date): void {
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const wait = Math.min(BACKOFF.startMs * BACKOFF.factor ** (failures - 1), BACKOFF.maxMs);
    this.entries.set(key, { failures, untilMs: now.getTime() + wait });
    if (this.entries.size > MAX_TRACKED) this.prune(now);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: Date): void {
    for (const [k, e] of this.entries) {
      if (e.untilMs + BACKOFF.maxMs < now.getTime()) this.entries.delete(k);
    }
  }
}
