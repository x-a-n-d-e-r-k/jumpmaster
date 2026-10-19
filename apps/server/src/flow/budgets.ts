import { createHash } from 'node:crypto';
import type { Budgets } from '../config.js';
import type { Db } from '../db/open.js';
import { type AttemptKey, getAttempts, setAttempts } from '../db/repo.js';

export const RATE_LIMIT_REQUEUE_MAX = 3;

export type ChargeResult = { ok: true; charged: AttemptKey[] } | { ok: false; reason: string };

/** sha256 of the parts joined with NUL, first 16 hex chars. */
export function fingerprint(parts: (string | number | null)[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

const exhausted = (key: string): ChargeResult => ({
  ok: false,
  reason: `budget exhausted: ${key}`,
});

function bump(db: Db, itemId: number, key: AttemptKey): void {
  const a = getAttempts(db, itemId, key);
  setAttempts(db, itemId, key, a.count + 1, a.lastFingerprint);
}

/**
 * Charges one budget key. Over the limit nothing is written. Callers run this in the same
 * transaction as the drop insert and store `charged.join(',')` as the drop's `chargedKey`.
 */
export function chargeBudget(
  db: Db,
  itemId: number,
  key: 'heal' | 'resolve' | 'resume' | 'review',
  fp: string,
  budgets: Budgets,
): ChargeResult {
  switch (key) {
    case 'heal':
    case 'resume': {
      const limit = key === 'heal' ? budgets.maxHeal : budgets.maxResume;
      if (getAttempts(db, itemId, key).count >= limit) return exhausted(key);
      bump(db, itemId, key);
      return { ok: true, charged: [key] };
    }
    case 'review': {
      const a = getAttempts(db, itemId, key);
      const count = a.lastFingerprint === fp ? a.count + 1 : 1;
      if (count > budgets.maxReviewRepeat) return exhausted(key);
      setAttempts(db, itemId, key, count, fp);
      return { ok: true, charged: [key] };
    }
    case 'resolve': {
      const total = getAttempts(db, itemId, 'resolve_total');
      if (total.count >= budgets.maxResolveTotal) return exhausted('resolve-total');
      const r = getAttempts(db, itemId, 'resolve');
      const repeat = r.lastFingerprint === fp;
      if (repeat && r.count >= budgets.maxResolve) return exhausted('resolve');
      setAttempts(db, itemId, 'resolve_total', total.count + 1, total.lastFingerprint);
      if (!repeat) {
        setAttempts(db, itemId, 'resolve', r.count, fp);
        return { ok: true, charged: ['resolve_total'] };
      }
      setAttempts(db, itemId, 'resolve', r.count + 1, fp);
      return { ok: true, charged: ['resolve', 'resolve_total'] };
    }
  }
}

function chargeCounter(db: Db, itemId: number, key: AttemptKey, limit: number): boolean {
  const a = getAttempts(db, itemId, key);
  if (a.count >= limit) return false;
  setAttempts(db, itemId, key, a.count + 1, a.lastFingerprint);
  return true;
}

export const chargeResolveConflict = (db: Db, itemId: number, budgets: Budgets): boolean =>
  chargeCounter(db, itemId, 'resolve', budgets.maxResolve);

export const chargeNoChange = (db: Db, itemId: number, budgets: Budgets): boolean =>
  chargeCounter(db, itemId, 'no_change', budgets.maxNoChange);

export const chargeRateLimitRequeue = (db: Db, itemId: number): boolean =>
  chargeCounter(db, itemId, 'rate_limit', RATE_LIMIT_REQUEUE_MAX);

/** Undoes a charge: -1 (floor 0) on each key of the comma-separated `chargedKey`. */
export function refundCharge(db: Db, itemId: number, chargedKey: string | null): void {
  if (!chargedKey) return;
  for (const key of chargedKey.split(',') as AttemptKey[]) {
    const a = getAttempts(db, itemId, key);
    setAttempts(db, itemId, key, Math.max(0, a.count - 1), a.lastFingerprint);
  }
}
