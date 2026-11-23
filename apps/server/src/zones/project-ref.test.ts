import { containsSecret } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { DropZoneObject } from '../config.js';
import { makeZone } from '../test/fixtures.js';
import { type ProjectRef, parseProjectRef } from './project-ref.js';

/** Issue #724: the project step's input, read as a GitHub or a GitLab project. */

const ACCEPTED: [string, ProjectRef][] = [
  ['owner/name', { forge: 'github', repo: 'owner/name' }],
  ['  owner/name\n', { forge: 'github', repo: 'owner/name' }],
  ['https://github.com/owner/name.git', { forge: 'github', repo: 'owner/name' }],
  ['https://github.com/owner/name/', { forge: 'github', repo: 'owner/name' }],
  ['https://github.com/owner/name/pull/1', { forge: 'github', repo: 'owner/name' }],
  ['https://GitHub.com/owner/name/tree/main?x=1#y', { forge: 'github', repo: 'owner/name' }],
  ['https://www.github.com:443/owner/name', { forge: 'github', repo: 'owner/name' }],
  [
    'https://gitlab.com/group/project',
    { forge: 'gitlab', baseUrl: 'https://gitlab.com', repo: 'group/project' },
  ],
  [
    'https://gitlab.example.com:8443/group/sub/project.git',
    { forge: 'gitlab', baseUrl: 'https://gitlab.example.com:8443', repo: 'group/sub/project' },
  ],
  [
    'https://gitlab.com/group/project/-/merge_requests/3',
    { forge: 'gitlab', baseUrl: 'https://gitlab.com', repo: 'group/project' },
  ],
  [
    'https://gitlab.com/group/project/-/tree/main',
    { forge: 'gitlab', baseUrl: 'https://gitlab.com', repo: 'group/project' },
  ],
  [
    'https://gitlab.com/group/project/?a=b#frag',
    { forge: 'gitlab', baseUrl: 'https://gitlab.com', repo: 'group/project' },
  ],
  [
    'https://GitLab.Example.com/group/project',
    { forge: 'gitlab', baseUrl: 'https://gitlab.example.com', repo: 'group/project' },
  ],
];

// Built at runtime so no token-shaped literal sits in the tracked file.
const GLPAT = ['glpat', 'zqxABCDEFGHIJKLMNOPQRST'].join('-');
const GHP = ['ghp', 'zqxabcdefghijklmnopqrstuvwxyzABCDEFGHI'].join('_');

/** [input, fragments that must never appear in the error] */
const REFUSED: [string, string[]][] = [
  ['http://gitlab.com/zqxgroup/zqxproject', ['zqxgroup', 'zqxproject']],
  ['http://github.com/zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['ftp://gitlab.com/zqxgroup/zqxproject', ['zqxgroup', 'zqxproject']],
  [
    'https://zqxuser:zqxpass@gitlab.com/zqxgroup/zqxproject',
    ['zqxuser', 'zqxpass', 'zqxgroup', 'zqxproject'],
  ],
  ['https://zqxuser@github.com/zqxowner/zqxrepo', ['zqxuser', 'zqxowner', 'zqxrepo']],
  ['https://gitlab.com/zqxonlyone', ['zqxonlyone']],
  ['https://gitlab.com/zqxonlyone/-/tree/main', ['zqxonlyone']],
  ['https://gitlab.com/', []],
  ['https://github.com/zqxowner', ['zqxowner']],
  ['https://github.com/', []],
  ['https://github.com:8443/zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['https://gist.github.com/zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['https://api.github.com/zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['-zqxbad/zqxrepo', ['zqxbad', 'zqxrepo']],
  ['https://github.com/-zqxbad/zqxrepo', ['zqxbad', 'zqxrepo']],
  ['https://gitlab.com/zqxgroup/zqx%20project', ['zqxgroup', 'zqx%20project', 'zqx project']],
  ['', []],
  ['   ', []],
  ['zqxjustone', ['zqxjustone']],
  ['zqxa/zqxb/zqxc', ['zqxa', 'zqxb', 'zqxc']],
  ['not a url at all zqxjunk', ['zqxjunk']],
  ['https://', []],
  ['https://github.com./zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['https://gist.github.com./zqxowner/zqxrepo', ['zqxowner', 'zqxrepo']],
  ['https://gitlab.com./zqxgroup/zqxproject', ['zqxgroup', 'zqxproject']],
  ['https://github.com/zqxow\nner/zqxrepo', ['zqxow', 'zqxrepo']],
  ['https://github.com/zqxowner/zqx\trepo', ['zqxowner', 'zqx']],
  ['https://github.com\\zqxowner\\zqxrepo', ['zqxowner', 'zqxrepo']],
  [GLPAT, [GLPAT]],
  [GHP, [GHP]],
  [`zqxowner/${GHP}`, [GHP, 'zqxowner']],
  [`https://gitlab.com/zqxgroup/${GLPAT}`, [GLPAT, 'zqxgroup']],
  [`https://github.com/zqxowner/${GHP}`, [GHP, 'zqxowner']],
];

describe('parseProjectRef', () => {
  test.each(ACCEPTED)('accepts %j', (input, expected) => {
    expect(parseProjectRef(input)).toEqual(expected);
  });

  test.each(REFUSED)('refuses %j without echoing it', (input, fragments) => {
    const result = parseProjectRef(input);
    expect(result).toEqual({ error: expect.any(String) });
    const error = (result as { error: string }).error;
    expect(error.length).toBeGreaterThan(0);
    if (input.trim() !== '') {
      expect(error).not.toContain(input);
      expect(error).not.toContain(input.trim());
    }
    for (const f of fragments) expect(error).not.toContain(f);
  });

  test('checks for a token before anything else', () => {
    // An http URL would otherwise be refused for its scheme.
    const scheme = parseProjectRef('http://gitlab.com/zqxgroup/zqxproject');
    const token = parseProjectRef(`http://gitlab.com/zqxgroup/${GLPAT}`);
    expect(token).not.toEqual(scheme);
    expect(token).toEqual({ error: expect.stringContaining('token') });
  });

  test('every token fixture is token-shaped and refused as a token', () => {
    for (const input of [GLPAT, GHP, `zqxowner/${GHP}`, `https://github.com/zqxowner/${GHP}`]) {
      expect(containsSecret(input, [])).toBe(true);
      expect(parseProjectRef(input)).toEqual({ error: expect.stringContaining('token') });
    }
  });

  test('refuses empty input as empty, not as a bad repository', () => {
    const empty = parseProjectRef('');
    expect(parseProjectRef('   ')).toEqual(empty);
    expect(empty).not.toEqual(parseProjectRef('zqxjustone'));
  });

  test('refuses a non-string input', () => {
    expect(parseProjectRef(undefined as unknown as string)).toEqual({
      error: expect.any(String),
    });
  });

  test.each(ACCEPTED)('the zone schema accepts the result of %j', (input) => {
    const ref = parseProjectRef(input);
    if ('error' in ref) throw new Error('expected an accepted ref');
    const zone =
      ref.forge === 'gitlab'
        ? {
            ...makeZone(),
            forge: 'gitlab' as const,
            gitlab: { baseUrl: ref.baseUrl },
            repo: ref.repo,
          }
        : { ...makeZone(), forge: 'github' as const, repo: ref.repo };
    const parsed = DropZoneObject.safeParse(zone);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
