// Adding a stick with one pasted line (issue #138): the one-time enrollment code. It is shown once,
// on the result page; the server keeps only its SHA-256, and registers the value with the log
// scrub for as long as this process runs. The installer swaps it for a 30-minute install token
// as its first network call (issue #269), after which the code works nowhere.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/open.js';
import {
  exchangeInvite,
  type InviteKind,
  insertStickInvite,
  inviteCodeSpent,
  type StickInvite,
  stickNameTaken,
} from '../db/repo.js';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';

export const ENROLL_CODE_PREFIX = 'jm_enroll_';
/** How long a code for the pasted line works. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a code in cloud-init user data works (issue #269): it sits in the VPS's metadata. */
export const CLOUD_INIT_TTL_MS = 60 * 60 * 1000;
/** How long the install token the code is swapped for works (issue #269). */
export const INSTALL_TOKEN_TTL_MS = 30 * 60 * 1000;
export const INSTALL_TOKEN_PREFIX = 'jm_install_';
/** The shape of an install token; anything else is never looked up. */
export const INSTALL_TOKEN = /^jm_install_[A-Za-z0-9_-]{43}$/;
/** What a spent code is answered with on the installer's routes. */
export const SPENT_CODE_ERROR =
  'this code was already used to start an install; make a new one on the sticks page';

/** The kinds of invite, as the form names them. */
export const INVITE_KINDS: readonly InviteKind[] = ['line', 'cloud_init'];

/** How long a code of this kind works. */
export const inviteTtl = (kind: InviteKind): number =>
  kind === 'cloud_init' ? CLOUD_INIT_TTL_MS : INVITE_TTL_MS;
/** A stick's name: what `docker logs` and the sticks page show. */
export const STICK_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_INVITE_SLOTS = 64;

/** The shape of a code; anything else is never looked up. */
export const ENROLL_CODE = /^jm_enroll_[A-Za-z0-9_-]{43}$/;

export const codeHash = (code: string): string => createHash('sha256').update(code).digest('hex');

export type InviteRequest = { name: string; slots: number | 'auto'; kind?: InviteKind };

/** Why a request can't make an invite, in words for the form; null when it can. */
export function inviteProblem(db: Db, r: InviteRequest, now: Date): string | null {
  if (!STICK_NAME.test(r.name))
    return 'the name must be 1 to 64 letters, digits, dots, dashes or underscores';
  if (
    r.slots !== 'auto' &&
    (!Number.isInteger(r.slots) || r.slots < 1 || r.slots > MAX_INVITE_SLOTS)
  )
    return `troopers must be Auto or a whole number from 1 to ${MAX_INVITE_SLOTS}`;
  if (r.kind !== undefined && !INVITE_KINDS.includes(r.kind))
    return 'how it will be installed must be Paste a line or Cloud-init user data';
  if (stickNameTaken(db, r.name, now))
    return `a stick or a pending invite is already named ${r.name}`;
  return null;
}

/**
 * Makes an invite for a request `inviteProblem` passed: a fresh code (32 random bytes,
 * base64url), stored by its hash, expiring after `ttlMs` (default: its kind's). The code is
 * returned once, here.
 */
export function createInvite(
  db: Db,
  r: InviteRequest,
  now: Date,
  o: { ttlMs?: number; scrub?: Pick<ScrubSet, 'add'> } = {},
): { invite: StickInvite; code: string } {
  const kind = r.kind ?? 'line';
  const code = `${ENROLL_CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
  (o.scrub ?? serverScrubSet).add(code);
  const invite: StickInvite = {
    id: randomUUID(),
    name: r.name,
    slots: r.slots === 'auto' ? null : r.slots,
    kind,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (o.ttlMs ?? inviteTtl(kind))).toISOString(),
    exchangedAt: null,
    tokenExpiresAt: null,
    usedAt: null,
    stickId: null,
    cancelledAt: null,
  };
  insertStickInvite(db, { ...invite, codeHash: codeHash(code) });
  return { invite, code };
}

/**
 * Swaps a pending code for a fresh install token (issue #269): 32 random bytes, stored by its
 * hash, working for 30 minutes. The code is spent at once. Refused as `spent` when the code was
 * already swapped or enrolled with, else as `unauthorized` (unknown, expired or cancelled).
 */
export function exchangeCode(
  db: Db,
  code: string,
  now: Date,
  scrub: Pick<ScrubSet, 'add'> = serverScrubSet,
): { token: string; invite: StickInvite } | { refused: 'spent' | 'unauthorized' } {
  if (!ENROLL_CODE.test(code)) return { refused: 'unauthorized' };
  const token = `${INSTALL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const invite = exchangeInvite(
    db,
    codeHash(code),
    {
      hash: codeHash(token),
      expiresAt: new Date(now.getTime() + INSTALL_TOKEN_TTL_MS).toISOString(),
    },
    now,
  );
  // Registered only once issued: a refused request (anyone may send one) adds nothing.
  if (invite) {
    scrub.add(token);
    return { token, invite };
  }
  return { refused: inviteCodeSpent(db, codeHash(code)) ? 'spent' : 'unauthorized' };
}
