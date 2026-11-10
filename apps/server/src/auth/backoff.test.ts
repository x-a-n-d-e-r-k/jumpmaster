import { expect, test } from 'vitest';
import { plus, t0 } from '../test/helpers.js';
import { BACKOFF, Backoff } from './backoff.js';

test('BACKOFF is 1 s doubling to 5 min', () => {
  expect(BACKOFF).toEqual({ startMs: 1000, factor: 2, maxMs: 300_000 });
});

test('each failure doubles the wait from 1 s, capped at 5 min, and never locks', () => {
  const b = new Backoff();
  expect(b.check('a', t0)).toEqual({ allowed: true });
  let at = t0;
  const waits: number[] = [];
  for (let i = 0; i < 12; i++) {
    b.fail('a', at);
    const c = b.check('a', at);
    if (c.allowed) throw new Error('expected a wait');
    waits.push(c.retryAfterMs);
    at = plus(at, c.retryAfterMs);
    // Once the wait has passed the source may try again: a wait, never a lock.
    expect(b.check('a', at)).toEqual({ allowed: true });
  }
  expect(waits).toEqual([
    1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
  ]);
});

test('the wait shrinks as time passes and other sources are unaffected', () => {
  const b = new Backoff();
  b.fail('a', t0);
  b.fail('a', plus(t0, 1000));
  expect(b.check('a', plus(t0, 1500))).toEqual({ allowed: false, retryAfterMs: 1500 });
  expect(b.check('b', t0)).toEqual({ allowed: true });
});

test('reset clears a source', () => {
  const b = new Backoff();
  b.fail('a', t0);
  b.reset('a');
  expect(b.check('a', t0)).toEqual({ allowed: true });
  b.fail('a', t0);
  expect(b.check('a', t0)).toEqual({ allowed: false, retryAfterMs: 1000 });
});
