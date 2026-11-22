import { describe, expect, test } from 'vitest';
import { stripTrailingSlashes } from './strings.js';

describe('stripTrailingSlashes', () => {
  test.each(['', '/', 'a', 'a/', 'a///', 'a/b/', '//a//', 'http://chat:7430///'])(
    '%j matches the regex it replaces',
    (s) => {
      expect(stripTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''));
    },
  );

  test('strips a configured base URL', () => {
    expect(stripTrailingSlashes('http://chat:7430///')).toBe('http://chat:7430');
  });

  test('a long run of slashes before another character is returned unchanged, quickly', () => {
    const s = `http://h:1${'/'.repeat(1e5)}x`;
    const t0 = performance.now();
    expect(stripTrailingSlashes(s)).toBe(s);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
