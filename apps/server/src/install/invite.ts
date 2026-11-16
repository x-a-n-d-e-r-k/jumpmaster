// Adding a stick with one pasted line (issue #138): the one-time enrollment code. It is shown once,
// on the result page; the server keeps only its SHA-256, and registers the value with the log
// scrub for as long as this process runs.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/open.js';
import { insertStickInvite, type StickInvite, stickNameTaken } from '../db/repo.js';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';

export const ENROLL_CODE_PREFIX = 'jm_enroll_';
/** How long a code works. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** A stick's name: what `docker logs` and the sticks page show. */
export const STICK_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_INVITE_SLOTS = 64;

/** The shape of a code; anything else is never looked up. */
export const ENROLL_CODE = /^jm_enroll_[A-Za-z0-9_-]{43}$/;

export const codeHash = (code: string): string => createHash('sha256').update(code).digest('hex');

export type InviteRequest = { name: string; slots: number | 'auto' };

/** Why a request can't make an invite, in words for the form; null when it can. */
export function inviteProblem(db: Db, r: InviteRequest, now: Date): string | null {
  if (!STICK_NAME.test(r.name))
    return 'the name must be 1 to 64 letters, digits, dots, dashes or underscores';
  if (
    r.slots !== 'auto' &&
    (!Number.isInteger(r.slots) || r.slots < 1 || r.slots > MAX_INVITE_SLOTS)
  )
    return `troopers must be Auto or a whole number from 1 to ${MAX_INVITE_SLOTS}`;
  if (stickNameTaken(db, r.name, now))
    return `a stick or a pending invite is already named ${r.name}`;
  return null;
}

/**
 * Makes an invite for a request `inviteProblem` passed: a fresh code (32 random bytes,
 * base64url), stored by its hash, expiring in 24 hours. The code is returned once, here.
 */
export function createInvite(
  db: Db,
  r: InviteRequest,
  now: Date,
  scrub: Pick<ScrubSet, 'add'> = serverScrubSet,
): { invite: StickInvite; code: string } {
  const code = `${ENROLL_CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
  scrub.add(code);
  const invite: StickInvite = {
    id: randomUUID(),
    name: r.name,
    slots: r.slots === 'auto' ? null : r.slots,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    usedAt: null,
    stickId: null,
    cancelledAt: null,
  };
  insertStickInvite(db, { ...invite, codeHash: codeHash(code) });
  return { invite, code };
}
