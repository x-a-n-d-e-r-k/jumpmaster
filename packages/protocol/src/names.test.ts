import { describe, expect, test } from 'vitest';
import { isOwnerName, isRepoFullName, isRepoName, splitRepoFullName } from './names.js';

describe('GitHub owner and repository names', () => {
  test.each([
    ['acme', true],
    ['a-b-c', true],
    ['a'.repeat(39), true],
    ['a'.repeat(40), false],
    ['-acme', false],
    ['acme-', false],
    ['ac--me', false],
    ['ac_me', false],
    ['', false],
    [`ghp_${'A'.repeat(36)}`, false],
  ])('owner %j → %s', (name, ok) => expect(isOwnerName(name)).toBe(ok));

  test.each([
    ['widgets', true],
    ['wid.gets-2', true],
    ['_x', true],
    ['.', false],
    ['..', false],
    ['widgets?x', false],
    ['wid%2Fgets', false],
    ['"x"', false],
    ['', false],
    ['a'.repeat(101), false],
    [`ghp_${'A'.repeat(36)}`, false],
  ])('repository %j → %s', (name, ok) => expect(isRepoName(name)).toBe(ok));

  test('owner/name: one slash, each half passing', () => {
    expect(isRepoFullName('acme/widgets')).toBe(true);
    expect(isRepoFullName('acme/widgets/x')).toBe(false);
    expect(isRepoFullName('acme')).toBe(false);
    expect(splitRepoFullName('acme/wid.gets-2')).toEqual({ owner: 'acme', name: 'wid.gets-2' });
    expect(splitRepoFullName('acme/..')).toBeNull();
  });
});
