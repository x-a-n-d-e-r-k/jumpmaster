import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isOwnerName } from '@jumpmaster/protocol';
import { APP_ROLES, type AppRole } from '../vault/github-app-entries.js';

/**
 * The two short-lived records of the GitHub App manifest flow (spec §4.1, State and Callback).
 *
 * A *state* is minted when the operator starts creating an app; it is single-use, bound to the
 * session, the owner and the role, and lives ten minutes. The github.com callback arrives without
 * the session cookie, so it can only consume the state. The converted app is then held *pending*,
 * bound to that session, until a same-origin Finish POST claims it. A pending not claimed in ten
 * minutes is discarded by `sweep()`, which reports it (never its PEM) so the operator can be told
 * to delete it on GitHub.
 *
 * Both maps are keyed by the SHA-256 of the random value: raw states and pending ids are never
 * held, and the lookup does not compare secret strings. Nothing here logs, and no error, string
 * form or JSON form of the store carries a PEM or a state.
 */

export const STATE_TTL_MS = 10 * 60_000;
export const PENDING_TTL_MS = 10 * 60_000;
export const MAX_STATES = 64;
export const MAX_PENDINGS = 16;
const TOKEN_BYTES = 32;

export type StateBinding = { sessionId: string; owner: string; role: AppRole };

/** The app converted from the manifest code, waiting for the operator's Finish. */
export type PendingApp = {
  appId: string;
  slug: string;
  clientId: string;
  pem: string;
  owner: string;
  role: AppRole;
};

/** What `sweep()` reports of a discarded pending: enough to say "delete `<slug>` on GitHub". */
export type DiscardedApp = { owner: string; role: AppRole; slug: string };

export type AppManifestStoreOptions = {
  now?: () => number;
  randomBytes?: (n: number) => Buffer;
};

type StateRecord = StateBinding & { expiresAt: number };
type PendingRecord = { sessionId: string; app: PendingApp; expiresAt: number };

const isAppRole = (r: unknown): r is AppRole =>
  typeof r === 'string' && (APP_ROLES as readonly string[]).includes(r);

const keyOf = (token: string): string => createHash('sha256').update(token).digest('hex');

export class AppManifestStore {
  readonly #now: () => number;
  readonly #random: (n: number) => Buffer;
  readonly #states = new Map<string, StateRecord>();
  readonly #pendings = new Map<string, PendingRecord>();

  constructor(opts: AppManifestStoreOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#random = opts.randomBytes ?? cryptoRandomBytes;
  }

  /** A fresh single-use state for this session, owner and role; throws when they are invalid or the store is full. */
  mintState(binding: { sessionId: string; owner: string; role: AppRole }): string {
    const { sessionId, owner, role } = binding;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('manifest state: the session is missing');
    }
    if (typeof owner !== 'string' || !isOwnerName(owner)) {
      throw new Error('manifest state: the owner is not a valid GitHub owner name');
    }
    if (!isAppRole(role)) {
      throw new Error(`manifest state: the role must be one of ${APP_ROLES.join(', ')}`);
    }
    const now = this.#now();
    for (const [k, r] of this.#states) if (r.expiresAt <= now) this.#states.delete(k);
    if (this.#states.size >= MAX_STATES) {
      throw new Error('manifest state: too many app creations in progress; try again later');
    }
    const state = this.#random(TOKEN_BYTES).toString('base64url');
    this.#states.set(keyOf(state), {
      sessionId,
      owner: owner.toLowerCase(),
      role,
      expiresAt: now + STATE_TTL_MS,
    });
    return state;
  }

  /** The binding of a live state, once; undefined for anything else. Never throws. */
  consumeState(state: unknown): StateBinding | undefined {
    if (typeof state !== 'string' || state === '') return undefined;
    const key = keyOf(state);
    const rec = this.#states.get(key);
    if (!rec) return undefined;
    this.#states.delete(key);
    if (rec.expiresAt <= this.#now()) return undefined;
    return { sessionId: rec.sessionId, owner: rec.owner, role: rec.role };
  }

  /** Holds a converted app for this session; returns its pending id. Throws when full. */
  putPending(sessionId: string, app: PendingApp): string {
    const now = this.#now();
    let live = 0;
    for (const r of this.#pendings.values()) if (r.expiresAt > now) live++;
    if (live >= MAX_PENDINGS) {
      throw new Error('pending app: too many apps waiting to be finished; try again later');
    }
    const id = this.#random(TOKEN_BYTES).toString('base64url');
    this.#pendings.set(keyOf(id), { sessionId, app: { ...app }, expiresAt: now + PENDING_TTL_MS });
    return id;
  }

  /**
   * The pending app, once, to its own session before it expires; else undefined. Another
   * session's claim leaves it in place; an expired one stays for `sweep()` to report.
   */
  claimPending(id: unknown, sessionId: unknown): PendingApp | undefined {
    if (typeof id !== 'string' || id === '' || typeof sessionId !== 'string') return undefined;
    const key = keyOf(id);
    const rec = this.#pendings.get(key);
    if (!rec || rec.expiresAt <= this.#now() || rec.sessionId !== sessionId) return undefined;
    this.#pendings.delete(key);
    return rec.app;
  }

  /** Drops expired states and pendings; reports each discarded pending (owner, role, slug) once. */
  sweep(): DiscardedApp[] {
    const now = this.#now();
    for (const [k, r] of this.#states) if (r.expiresAt <= now) this.#states.delete(k);
    const discarded: DiscardedApp[] = [];
    for (const [k, r] of this.#pendings) {
      if (r.expiresAt > now) continue;
      this.#pendings.delete(k);
      discarded.push({ owner: r.app.owner, role: r.app.role, slug: r.app.slug });
    }
    return discarded;
  }

  toJSON(): Record<string, never> {
    return {};
  }

  toString(): string {
    return '[AppManifestStore]';
  }
}
