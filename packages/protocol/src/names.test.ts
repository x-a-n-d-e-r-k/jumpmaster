import { describe, expect, test } from 'vitest';
import {
  isGitLabProjectPath,
  isOwnerName,
  isRepoFullName,
  isRepoName,
  splitRepoFullName,
} from './names.js';

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

describe('GitLab project paths (issue #667)', () => {
  // Built at runtime so no token-shaped literal sits in the tracked file.
  const TOKEN = ['glpat', 'abcdefghijklmnopqrst'].join('-');
  const GH_TOKEN = ['ghp', 'A'.repeat(36)].join('_');
  test.each([
    ['acme/app', true],
    ['group/sub/project', true],
    ['a/b/c/d/e', true],
    ['my_group/my.project-2', true],
    ['G1/x', true],
    ['app', false],
    ['', false],
    ['acme/', false],
    ['/app', false],
    ['acme//app', false],
    ['acme/../app', false],
    ['acme/./app', false],
    ['acme/..', false],
    ['acme/app.git', false],
    ['acme/app.atom', false],
    ['acme/sub.git/app', false],
    ['acme/-app', false],
    ['acme/app-', false],
    ['acme/.app', false],
    ['acme/app.', false],
    ['_acme/app', false],
    ['acme/app_', false],
    ['acme/a pp', false],
    ['acme/app?x', false],
    ['acme/app%2F', false],
    ['acme/app#x', false],
    ['acme\\app', false],
    [`acme/${GH_TOKEN}`, false],
    [`${GH_TOKEN}/app`, false],
    [`acme/sub/${TOKEN}`, false],
  ])('%j → %s', (path, ok) => expect(isGitLabProjectPath(path)).toBe(ok));

  test('a non-string is refused', () => {
    expect(isGitLabProjectPath(undefined as unknown as string)).toBe(false);
  });
});
