import { describe, expect, test } from 'vitest';
import { sliceWhole } from './slice-whole.js';

describe('sliceWhole', () => {
  test('a short text is kept whole', () => {
    expect(sliceWhole('abc', 5)).toBe('abc');
  });
  test('a cut inside a surrogate pair backs off one unit', () => {
    expect(sliceWhole('ab\u{1F600}c', 3)).toBe('ab');
  });
  test('a pair ending at the cut is kept', () => {
    expect(sliceWhole('ab\u{1F600}c', 4)).toBe('ab\u{1F600}');
  });
});
