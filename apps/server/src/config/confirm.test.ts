import { describe, expect, test } from 'vitest';
import type { Principal } from '../auth/guard.js';
import { plus, t0 } from '../test/helpers.js';
import {
  CONFIRM_MS,
  Confirmations,
  MAX_PENDING_PER_SESSION,
  PENDING_MS,
  type PendingInput,
} from './confirm.js';

const principal: Principal = { kind: 'operator', via: 'session', sessionId: 'sess-a', sudo: false };

function world() {
  const clock = { now: t0 };
  const c = new Confirmations(() => clock.now);
  const input = (doc: unknown = { pollSeconds: 30 }, session = 'sess-a'): PendingInput => ({
    sessionIdHash: session,
    patch: doc,
    expectRevision: 4,
    meta: { via: 'ui', principal },
    guarded: [{ path: 'mcp.enabled', consequence: 'x' }],
    notes: [],
  });
  return { clock, c, input };
}

describe('pending changes', () => {
  test('a pending change is visible to its own session only, and expires after PENDING_MS', () => {
    const { c, input, clock } = world();
    const p = c.addPending(input());
    expect(p.id).toMatch(/^[\w-]{16,}$/);
    expect(p.changeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.expiresAt).toEqual(plus(t0, PENDING_MS));
    expect(c.pending(p.id, 'sess-a')?.id).toBe(p.id);
    expect(c.pending(p.id, 'sess-b')).toBeUndefined();
    clock.now = plus(t0, PENDING_MS);
    expect(c.pending(p.id, 'sess-a')).toBeUndefined();
  });

  test('an eleventh pending change for one session evicts the oldest, and other sessions keep theirs', () => {
    const { c, input } = world();
    const other = c.addPending(input({}, 'sess-b'));
    const ids = Array.from(
      { length: MAX_PENDING_PER_SESSION + 1 },
      (_, i) => c.addPending(input({ pollSeconds: 10 + i })).id,
    );
    expect(c.pending(ids[0] as string, 'sess-a')).toBeUndefined();
    for (const id of ids.slice(1)) expect(c.pending(id, 'sess-a')).toBeDefined();
    expect(c.pending(other.id, 'sess-b')).toBeDefined();
    expect(c.size()).toEqual({ pending: MAX_PENDING_PER_SESSION + 1, confirmations: 0 });
  });
});

describe('confirmations', () => {
  test('one minted by the render is accepted once, and a second use is refused as used', () => {
    const { c, input } = world();
    const p = c.addPending(input());
    const token = c.mintConfirmation(p, 'sess-a');
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(c.consumeConfirmation(token, p, 'sess-a', 4)).toEqual({ ok: true, patch: p.patch });
    // The pending change went with it.
    expect(c.pending(p.id, 'sess-a')).toBeUndefined();
    expect(c.consumeConfirmation(token, p, 'sess-a', 4)).toEqual({ ok: false, reason: 'used' });
  });

  test('a token not minted, one from another session, a changed set and a stale revision are refused', () => {
    const { c, input } = world();
    const p = c.addPending(input());
    const token = c.mintConfirmation(p, 'sess-a');
    expect(c.consumeConfirmation('made-up-token', p, 'sess-a', 4)).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(c.consumeConfirmation(token, p, 'sess-b', 4)).toEqual({ ok: false, reason: 'session' });
    const other = c.addPending(input({ pollSeconds: 99 }));
    expect(c.consumeConfirmation(token, other, 'sess-a', 4)).toEqual({
      ok: false,
      reason: 'changed',
    });
    // The same pending id with a different change set (as a store holding a swapped patch would).
    expect(c.consumeConfirmation(token, { ...p, changeHash: 'f'.repeat(64) }, 'sess-a', 4)).toEqual(
      { ok: false, reason: 'changed' },
    );
    expect(c.consumeConfirmation(token, p, 'sess-a', 5)).toEqual({ ok: false, reason: 'stale' });
    // None of the refusals spent it.
    expect(c.consumeConfirmation(token, p, 'sess-a', 4)).toMatchObject({ ok: true });
  });

  test('an expired confirmation and an expired pending change are refused as expired', () => {
    const { c, input, clock } = world();
    const p = c.addPending(input());
    const token = c.mintConfirmation(p, 'sess-a');
    clock.now = plus(t0, CONFIRM_MS);
    expect(c.consumeConfirmation(token, p, 'sess-a', 4)).toEqual({ ok: false, reason: 'expired' });
    // A fresh render mints again; the pending change itself runs out at PENDING_MS.
    const again = c.mintConfirmation(p, 'sess-a');
    clock.now = plus(t0, PENDING_MS);
    expect(c.consumeConfirmation(again, p, 'sess-a', 4)).toEqual({ ok: false, reason: 'expired' });
  });

  test('a new render replaces the earlier confirmation, and only a hash is kept', () => {
    const { c, input } = world();
    const p = c.addPending(input());
    const first = c.mintConfirmation(p, 'sess-a');
    const second = c.mintConfirmation(p, 'sess-a');
    expect(c.consumeConfirmation(first, p, 'sess-a', 4)).toEqual({ ok: false, reason: 'unknown' });
    expect(JSON.stringify(c.debugRecords())).not.toContain(second);
    expect(c.consumeConfirmation(second, p, 'sess-a', 4)).toMatchObject({ ok: true });
  });

  test("minting for another session's pending change is refused", () => {
    const { c, input } = world();
    const p = c.addPending(input());
    expect(() => c.mintConfirmation(p, 'sess-b')).toThrow(/another session/);
  });
});
