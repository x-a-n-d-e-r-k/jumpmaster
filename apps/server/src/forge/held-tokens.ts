/**
 * The tokens minted for one drop each (spec docs/superpowers/specs/2026-11-13-github-app-auth.md,
 * §4.2): the reviewer's `contents: read` clone token of a review, crew or doctor drop (issue #237),
 * and the author's `contents: read` fetch token of an implement, heal or resolve drop (issue #249).
 *
 * Held in memory only, keyed by drop id and epoch, with the owner whose app minted it: never in
 * the DB, the vault, an audit row, an event or a log. Each is revoked when its drop ends:
 * - at once, when the drop's result is accepted (`release`);
 * - by the sweep, on each lease-expirer tick and after the kill switch, once its drop is no longer
 *   `leased` or `running` at that epoch (an expired or lost lease, a cancel, the kill switch).
 *
 * A revoke is fire and forget: one that fails is logged without the token, and the token expires
 * within its hour. A token lost to a restart dies the same way.
 */
import type { Db } from '../db/open.js';
import { AppTokenError } from './app-tokens.js';
import { GitHubAppError } from './github-app.js';

export interface HeldToken {
  owner: string;
  token: string;
  revoke(): Promise<void>;
}

export interface HeldDropTokens {
  /** Holds the drop's token for this epoch; a token already held for it is revoked first. */
  hold(dropId: string, epoch: number, held: HeldToken): void;
  /** Revokes every token held for the drop, of any epoch. */
  release(dropId: string): void;
  /** Revokes every token whose drop is no longer `leased` or `running` at its epoch. */
  sweep(db: Db): void;
  /** How many tokens are held (for tests and status). */
  size(): number;
  /** Whether this exact token is held (tests). */
  holds(token: string): boolean;
}

/** Why a GitHub App call failed, in words that never carry a secret. */
export function failureOf(e: unknown): string {
  if (e instanceof GitHubAppError) return `HTTP ${e.status}`;
  if (e instanceof AppTokenError) {
    if (e.cause instanceof GitHubAppError) return `HTTP ${e.cause.status}`;
    return e.message;
  }
  return 'an error';
}

const LIVE = new Set(['leased', 'running']);

export function createHeldDropTokens(o: {
  log: (line: string) => void;
  /** What the token is, for the log lines (default "read token"). */
  what?: string;
}): HeldDropTokens {
  const what = o.what ?? 'read token';
  /** Per drop id, per epoch. */
  const held = new Map<string, Map<number, HeldToken>>();

  const revoke = (dropId: string, h: HeldToken): void => {
    h.revoke().catch((e: unknown) => {
      o.log(
        `revoking the ${what} of drop ${dropId} failed (${failureOf(e)}); it expires in the hour`,
      );
    });
  };

  const drop = (dropId: string, epoch: number): void => {
    const epochs = held.get(dropId);
    const h = epochs?.get(epoch);
    if (!epochs || !h) return;
    epochs.delete(epoch);
    if (epochs.size === 0) held.delete(dropId);
    revoke(dropId, h);
  };

  return {
    hold(dropId, epoch, h) {
      drop(dropId, epoch);
      const epochs = held.get(dropId) ?? new Map<number, HeldToken>();
      epochs.set(epoch, h);
      held.set(dropId, epochs);
    },
    release(dropId) {
      for (const epoch of [...(held.get(dropId)?.keys() ?? [])]) drop(dropId, epoch);
    },
    sweep(db) {
      const read = db.prepare('SELECT state, epoch FROM drops WHERE id = ?');
      for (const [dropId, epochs] of [...held]) {
        const row = read.get(dropId) as { state: string; epoch: number } | undefined;
        for (const epoch of [...epochs.keys()])
          if (!row || row.epoch !== epoch || !LIVE.has(row.state)) drop(dropId, epoch);
      }
    },
    size() {
      let n = 0;
      for (const epochs of held.values()) n += epochs.size;
      return n;
    },
    holds(token) {
      for (const epochs of held.values())
        for (const h of epochs.values()) if (h.token === token) return true;
      return false;
    },
  };
}
