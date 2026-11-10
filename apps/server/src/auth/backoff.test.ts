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

test('the map is bounded: past its size the oldest source is evicted first', () => {
  const b = new Backoff({ maxTracked: 3 });
  for (let i = 0; i < 1000; i++) b.fail(`10.0.${i >> 8}.${i & 255}`, t0);
  expect(b.size).toBe(3);
  // The newest three are still held; the oldest are forgotten.
  expect(b.check('10.0.3.231', t0).allowed).toBe(false);
  expect(b.check('10.0.0.0', t0).allowed).toBe(true);
  // A repeat offender moves to the newest end and survives eviction.
  const c = new Backoff({ maxTracked: 2 });
  c.fail('a', t0);
  c.fail('b', t0);
  c.fail('a', t0);
  c.fail('c', t0);
  expect(c.check('a', t0).allowed).toBe(false);
  expect(c.check('b', t0).allowed).toBe(true);
});

test('the default bound is 10 000 sources', () => {
  const b = new Backoff();
  for (let i = 0; i < 10_500; i++) b.fail(`k${i}`, t0);
  expect(b.size).toBe(10_000);
});
