import { describe, expect, test } from 'vitest';
import { linkTarget } from './links.js';

describe('linkTarget (#133)', () => {
  const NEW_TAB = ' target="_blank" rel="noopener noreferrer"';
  test('an absolute http(s) href opens in a new tab', () => {
    expect(linkTarget('https://github.com/o/r/pull/1')).toBe(NEW_TAB);
    expect(linkTarget('http://example.com')).toBe(NEW_TAB);
  });
  test('an in-app href stays in this tab', () => {
    for (const h of ['/work', '/briefings?zone=jm', '#rulings', '?page=2'])
      expect(linkTarget(h), h).toBe('');
  });
  test('javascript: is not treated as external', () => {
    expect(linkTarget('javascript:alert(1)')).toBe('');
  });
});
