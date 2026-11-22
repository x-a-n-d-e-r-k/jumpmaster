import type { DropResult } from '@jumpmaster/protocol';
import type { Db } from '../db/open.js';

/**
 * The failure reasons of a malformed agent run: two final results, none, or a trooper that exited
 * without one (the trooper's `acceptOutcome` and the stick runner's). A glitch of the run, not a
 * finding about the code. `claude exit N` is not one: it can be a real failure such as auth.
 */
const MALFORMED_REASON =
  /^(multiple results|claude produced no result|session mismatch|trooper exited \d+ without result)/;

export const isMalformedReason = (reason: string | null | undefined): boolean =>
  MALFORMED_REASON.test(reason ?? '');

export const isMalformedRun = (result: DropResult): boolean =>
  result.status === 'failed' && isMalformedReason(result.reason);

type Row = { id: string; resultJson: string | null };

function storedReason(resultJson: string | null): string | undefined {
  try {
    const r = JSON.parse(resultJson ?? 'null') as { status?: unknown; reason?: unknown } | null;
    return r?.status === 'failed' && typeof r.reason === 'string' ? r.reason : undefined;
  } catch {
    return undefined;
  }
}

/** The failed drops of an item, role and head (`null` matches a null head) that ended malformed. */
export function malformedDrops(
  db: Db,
  itemId: number,
  role: string,
  headSha: string | null,
): string[] {
  const rows = db
    .prepare(
      `SELECT id, result_json AS resultJson FROM drops
       WHERE work_item_id = ? AND role = ? AND head_sha IS ? AND state = 'failed'`,
    )
    .all(itemId, role, headSha) as Row[];
  return rows.filter((r) => isMalformedReason(storedReason(r.resultJson))).map((r) => r.id);
}

/**
 * Whether drop `dropId`'s malformed run gets its one retry: no other drop of the same item, role
 * and head ended malformed. Read from stored drop rows, so repeated passes cannot loop.
 */
export function malformedRetryDue(
  db: Db,
  dropId: string,
  itemId: number,
  role: string,
  headSha: string | null,
): boolean {
  return malformedDrops(db, itemId, role, headSha).every((id) => id === dropId);
}

/**
 * The charge a heal or resolve about to be enqueued reuses, or undefined when it must be charged:
 * it reuses the failed drop's when the item's latest drop of `role` was the one malformed run
 * retried on this head with this fingerprint, so the retry costs no budget.
 */
export function malformedRetryCharge(
  db: Db,
  itemId: number,
  role: string,
  fingerprint: string,
  headSha: string | null,
): { chargedKey: string | null } | undefined {
  const last = db
    .prepare(
      `SELECT id, state, fingerprint, head_sha AS headSha, charged_key AS chargedKey,
              result_json AS resultJson
       FROM drops WHERE work_item_id = ? AND role = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId, role) as
    | (Row & {
        state: string;
        fingerprint: string | null;
        headSha: string | null;
        chargedKey: string | null;
      })
    | undefined;
  if (
    !last ||
    last.state !== 'failed' ||
    last.fingerprint !== fingerprint ||
    last.headSha !== headSha ||
    !isMalformedReason(storedReason(last.resultJson))
  ) {
    return undefined;
  }
  const malformed = malformedDrops(db, itemId, role, headSha);
  return malformed.length === 1 ? { chargedKey: last.chargedKey } : undefined;
}
