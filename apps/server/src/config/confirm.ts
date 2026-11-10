import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Classification } from './guarded.js';
import { canonicalJson, hashOf } from './revisions.js';
import type { ApplyMeta } from './store.js';

/**
 * Guarded changes from a browser session wait here until the operator confirms them on the
 * confirmation page (§7.5). Both records live in memory only: a restart drops them, and the
 * operator starts the change again.
 *
 * A **pending** change is the whole document a session asked for, bound to that session, the
 * revision it was judged against and the hash of its content. A **confirmation** is minted only
 * when the confirmation page renders: a random value whose SHA-256 alone is kept, bound to the
 * pending change, the session, the change hash and the base revision, accepted once and within
 * `CONFIRM_MS`. Nothing a script can read without rendering the page (the CSRF meta included)
 * lets it compute one, and the page's POST must also carry the passphrase.
 */

export const PENDING_MS = 10 * 60_000;
export const CONFIRM_MS = 5 * 60_000;
/** Per session, so a script spamming guarded patches cannot grow memory: the oldest goes. */
export const MAX_PENDING_PER_SESSION = 10;

export type Pending = {
  id: string;
  sessionIdHash: string;
  /** The whole editable document to apply (a merge patch already merged, or a rollback's). */
  patch: unknown;
  changeHash: string;
  expectRevision: number;
  meta: ApplyMeta;
  /** A path on this host the confirm POST redirects to after applying (the wizard's next step). */
  returnTo?: string;
  /** Where the page's Cancel goes (a path on this host); home when absent. */
  cancelTo?: string;
  expiresAt: Date;
  /** What the page states verbatim, and the notes it shows beside them. */
  guarded: Classification['guarded'];
  notes: Classification['notes'];
};

export type PendingInput = Omit<Pending, 'id' | 'changeHash' | 'expiresAt'>;

export type Confirmation = {
  tokenHash: Buffer;
  pendingId: string;
  sessionIdHash: string;
  changeHash: string;
  expectRevision: number;
  expiresAt: Date;
};

export type ConsumeFailure = 'unknown' | 'used' | 'session' | 'changed' | 'stale' | 'expired';
export type Consumed = { ok: true; patch: unknown } | { ok: false; reason: ConsumeFailure };

const sha256 = (v: string): Buffer => createHash('sha256').update(v).digest();
const sameHash = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** The hash a pending change and its confirmation are bound to. */
export const changeHashOf = (doc: unknown): string => hashOf(canonicalJson(doc));

export class Confirmations {
  private readonly pendings = new Map<string, Pending>();
  /** By pending id: one live confirmation per pending change (a new render replaces it). */
  private readonly confirmations = new Map<string, Confirmation>();
  /** Hashes of consumed tokens, until their record would have expired, so a replay says `used`. */
  private readonly used = new Map<string, Date>();

  constructor(private readonly now: () => Date) {}

  addPending(input: PendingInput): Pending {
    this.sweep();
    const at = this.now();
    const p: Pending = {
      ...input,
      id: randomBytes(16).toString('base64url'),
      changeHash: changeHashOf(input.patch),
      expiresAt: new Date(at.getTime() + PENDING_MS),
    };
    const mine = [...this.pendings.values()].filter((x) => x.sessionIdHash === p.sessionIdHash);
    // Insertion order is age order: evict from the front.
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_SESSION + 1)))
      this.drop(old.id);
    this.pendings.set(p.id, p);
    return p;
  }

  /** A live pending change of this session; another session's is invisible. */
  pending(id: string, sessionIdHash: string): Pending | undefined {
    const p = this.pendings.get(id);
    if (!p || p.sessionIdHash !== sessionIdHash) return undefined;
    if (this.now().getTime() >= p.expiresAt.getTime()) return undefined;
    return p;
  }

  /**
   * Called by the confirmation page's render only. Returns the plain token once; only its hash is
   * kept, and a later render replaces it.
   */
  mintConfirmation(pending: Pending, sessionIdHash: string): string {
    if (pending.sessionIdHash !== sessionIdHash)
      throw new Error('a confirmation cannot be minted for another session');
    const token = randomBytes(32).toString('base64url');
    const at = this.now().getTime();
    this.confirmations.set(pending.id, {
      tokenHash: sha256(token),
      pendingId: pending.id,
      sessionIdHash,
      changeHash: pending.changeHash,
      expectRevision: pending.expectRevision,
      expiresAt: new Date(Math.min(at + CONFIRM_MS, pending.expiresAt.getTime())),
    });
    return token;
  }

  /**
   * Checks the token against the pending change it is used for: its hash, the pending id, the
   * session, the change hash, the revision and expiry. Accepted: the record and the pending change
   * are deleted and the patch is returned. A refusal spends nothing.
   */
  consumeConfirmation(
    token: string,
    pending: Pending,
    sessionIdHash: string,
    revision: number,
  ): Consumed {
    const given = sha256(token);
    const at = this.now().getTime();
    const hex = given.toString('hex');
    const usedUntil = this.used.get(hex);
    if (usedUntil && at < usedUntil.getTime() + PENDING_MS) return { ok: false, reason: 'used' };
    const record = [...this.confirmations.values()].find((c) => sameHash(c.tokenHash, given));
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.sessionIdHash !== sessionIdHash || pending.sessionIdHash !== sessionIdHash)
      return { ok: false, reason: 'session' };
    if (record.pendingId !== pending.id || record.changeHash !== pending.changeHash)
      return { ok: false, reason: 'changed' };
    const stored = this.pendings.get(pending.id);
    if (!stored || stored.changeHash !== record.changeHash) return { ok: false, reason: 'changed' };
    if (at >= record.expiresAt.getTime() || at >= stored.expiresAt.getTime())
      return { ok: false, reason: 'expired' };
    if (revision !== record.expectRevision || revision !== stored.expectRevision)
      return { ok: false, reason: 'stale' };
    this.used.set(hex, record.expiresAt);
    this.drop(pending.id);
    return { ok: true, patch: stored.patch };
  }

  /**
   * The store's use: the confirmation names its pending change, and `doc` must be that change.
   * A pending change already gone answers from the token alone (`used` after a use, else
   * `unknown`); one of another session answers `session`.
   */
  consumeFor(
    confirmation: { pendingId: string; token: string },
    doc: unknown,
    sessionIdHash: string,
    revision: number,
  ): Consumed {
    const pending = this.pendings.get(confirmation.pendingId);
    if (!pending) {
      return { ok: false, reason: this.wasUsed(confirmation.token) ? 'used' : 'unknown' };
    }
    if (changeHashOf(doc) !== pending.changeHash) {
      // Offered for a different change set; another session's pending change says so first.
      return {
        ok: false,
        reason: pending.sessionIdHash !== sessionIdHash ? 'session' : 'changed',
      };
    }
    return this.consumeConfirmation(confirmation.token, pending, sessionIdHash, revision);
  }

  /** Whether this token confirmed a change already (kept until its record would have expired). */
  wasUsed(token: string): boolean {
    return this.used.has(sha256(token).toString('hex'));
  }

  size(): { pending: number; confirmations: number } {
    return { pending: this.pendings.size, confirmations: this.confirmations.size };
  }

  /** The stored confirmation records, for tests that check no plain token is kept. */
  debugRecords(): Confirmation[] {
    return [...this.confirmations.values()];
  }

  private drop(pendingId: string): void {
    this.pendings.delete(pendingId);
    this.confirmations.delete(pendingId);
  }

  /** Forgets what ran out long enough ago that no answer depends on it any more. */
  private sweep(): void {
    const at = this.now().getTime();
    for (const p of this.pendings.values())
      if (at >= p.expiresAt.getTime() + PENDING_MS) this.drop(p.id);
    for (const [hex, until] of this.used)
      if (at >= until.getTime() + PENDING_MS) this.used.delete(hex);
  }
}
