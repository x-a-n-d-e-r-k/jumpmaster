// The invite's life (issues #138, #269): pending, exchanged for an install token, then used or
// cancelled; a cloud-init invite lives an hour, a line invite a day.
import { describe, expect, test } from 'vitest';
import { openDb } from '../db/open.js';
import {
  cancelInviteByToken,
  enrollFromInvite,
  inviteState,
  listPendingInvites,
  stickNameTaken,
} from '../db/repo.js';
import { ScrubSet } from '../forge/scrub-set.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  CLOUD_INIT_TTL_MS,
  codeHash,
  createInvite,
  exchangeCode,
  INSTALL_TOKEN,
  INSTALL_TOKEN_TTL_MS,
  INVITE_TTL_MS,
  inviteTtl,
} from './invite.js';

const at = (ms: number) => new Date(t0.getTime() + ms);
const stick = (id: string) => ({ id, tokenHash: `h-${id}`, slots: 1 });

describe('createInvite', () => {
  test('takes the TTL and stores the kind: a line invite 24 hours, a cloud-init one 1 hour', () => {
    const db = openDb(tmpDbFile());
    expect(INVITE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(CLOUD_INIT_TTL_MS).toBe(60 * 60 * 1000);
    expect(inviteTtl('line')).toBe(INVITE_TTL_MS);
    expect(inviteTtl('cloud_init')).toBe(CLOUD_INIT_TTL_MS);
    const scrub = new ScrubSet();
    const line = createInvite(db, { name: 'a', slots: 'auto', kind: 'line' }, t0, {
      ttlMs: inviteTtl('line'),
      scrub,
    });
    const cloud = createInvite(db, { name: 'b', slots: 2, kind: 'cloud_init' }, t0, {
      ttlMs: inviteTtl('cloud_init'),
      scrub,
    });
    expect(line.invite).toMatchObject({ kind: 'line', expiresAt: at(INVITE_TTL_MS).toISOString() });
    expect(cloud.invite).toMatchObject({
      kind: 'cloud_init',
      expiresAt: at(60 * 60 * 1000).toISOString(),
    });
    expect(listPendingInvites(db, t0).map((i) => [i.name, i.kind, i.expiresAt])).toEqual([
      ['a', 'line', line.invite.expiresAt],
      ['b', 'cloud_init', cloud.invite.expiresAt],
    ]);
    // The cloud-init code is dead after its hour.
    expect(exchangeCode(db, cloud.code, at(CLOUD_INIT_TTL_MS + 1), scrub)).toEqual({
      refused: 'unauthorized',
    });
  });
});

describe('exchangeCode', () => {
  test('issues one 30-minute token for a pending code, then refuses the code as spent', () => {
    const db = openDb(tmpDbFile());
    const scrub = new ScrubSet();
    const { invite, code } = createInvite(db, { name: 'a', slots: 'auto' }, t0, { scrub });
    const first = exchangeCode(db, code, t0, scrub);
    if (!('token' in first)) throw new Error('no token');
    expect(first.token).toMatch(INSTALL_TOKEN);
    expect(INSTALL_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
    expect(scrub.values()).toContain(first.token);
    expect(inviteState(db, invite.id, t0)).toBe('exchanged');
    const before = scrub.values().length;
    expect(exchangeCode(db, code, t0, scrub)).toEqual({ refused: 'spent' });
    // A refused exchange (anyone may send one) registers nothing with the scrub set.
    expect(exchangeCode(db, `jm_enroll_${'Z'.repeat(43)}`, t0, scrub)).toEqual({
      refused: 'unauthorized',
    });
    expect(scrub.values()).toHaveLength(before);
    // The code no longer enrolls; the token does.
    expect(enrollFromInvite(db, { codeHash: codeHash(code) }, t0, stick('s0'))).toBeUndefined();
  });

  test('D3: of many exchanges of one code, exactly one gets a token', () => {
    const db = openDb(tmpDbFile());
    const { code } = createInvite(db, { name: 'a', slots: 'auto' }, t0, { scrub: new ScrubSet() });
    const results = Array.from({ length: 5 }, () => exchangeCode(db, code, t0, new ScrubSet()));
    expect(results.filter((r) => 'token' in r)).toHaveLength(1);
  });
});

describe('the exchanged invite', () => {
  function exchanged() {
    const db = openDb(tmpDbFile());
    const scrub = new ScrubSet();
    const { invite, code } = createInvite(db, { name: 'a', slots: 'auto' }, t0, { scrub });
    const r = exchangeCode(db, code, t0, scrub);
    if (!('token' in r)) throw new Error('no token');
    return { db, invite, token: r.token, tokenHash: codeHash(r.token) };
  }

  test('enrolls with its token once, and is then used', () => {
    const { db, invite, tokenHash } = exchanged();
    const e = enrollFromInvite(db, { tokenHash }, t0, stick('s1'));
    expect(e).toMatchObject({ name: 'a', stickId: 's1' });
    expect(inviteState(db, invite.id, t0)).toBe('used');
    expect(enrollFromInvite(db, { tokenHash }, t0, stick('s2'))).toBeUndefined();
  });

  test('cancel: idempotent while the token lives, then enrollment is refused', () => {
    const { db, invite, tokenHash } = exchanged();
    expect(cancelInviteByToken(db, tokenHash, t0)).toBe(true);
    expect(cancelInviteByToken(db, tokenHash, at(1000))).toBe(true);
    expect(inviteState(db, invite.id, t0)).toBe('cancelled');
    expect(enrollFromInvite(db, { tokenHash }, at(2000), stick('s1'))).toBeUndefined();
    expect(stickNameTaken(db, 'a', t0)).toBe(false);
  });

  test('with its token expired it counts as cancelled: not pending, name free, nothing enrolls or cancels', () => {
    const { db, invite, tokenHash } = exchanged();
    const later = at(INSTALL_TOKEN_TTL_MS + 1);
    expect(inviteState(db, invite.id, at(INSTALL_TOKEN_TTL_MS - 1))).toBe('exchanged');
    expect(inviteState(db, invite.id, later)).toBe('cancelled');
    expect(listPendingInvites(db, later)).toEqual([]);
    expect(stickNameTaken(db, 'a', later)).toBe(false);
    expect(enrollFromInvite(db, { tokenHash }, later, stick('s1'))).toBeUndefined();
    expect(cancelInviteByToken(db, tokenHash, later)).toBe(false);
  });
});
