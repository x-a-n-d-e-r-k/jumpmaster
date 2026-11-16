import { expect, test } from 'vitest';
import { FETCH_SHOWN_MS, StickFetches } from './fetches.js';

test('a report is shown while fresh, and not once the stick has been quiet for a minute', () => {
  const f = new StickFetches();
  const at = new Date('2026-11-16T00:00:00Z');
  const p = { ref: `x@sha256:${'a'.repeat(64)}`, done: 1, total: 2 };
  f.set('s1', p, at);
  expect(f.get('s1', new Date(at.getTime() + FETCH_SHOWN_MS))).toEqual(p);
  expect(f.get('s2', at)).toBeUndefined();
  expect(f.get('s1', new Date(at.getTime() + FETCH_SHOWN_MS + 1))).toBeUndefined();
  expect(f.get('s1', at)).toBeUndefined();
});
