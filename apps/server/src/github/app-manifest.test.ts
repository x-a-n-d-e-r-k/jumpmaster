import { describe, expect, test } from 'vitest';
import { APP_ROLES } from '../vault/github-app-entries.js';
import {
  APP_MANIFEST_PERMISSIONS,
  appManifest,
  appRegistrationUrl,
  isPlainHttpBase,
} from './app-manifest.js';
import { PAT_PERMISSIONS } from './guidance.js';

const opts = {
  baseUrl: 'https://jm.example:7431/',
  installId: 'ab12cd',
  projectUrl: 'https://github.com/jumpmaster/jumpmaster',
};

describe('appManifest', () => {
  test('the author manifest is the §4.1 shape', () => {
    const m = appManifest('author', opts);
    expect(m).toStrictEqual({
      name: 'Jumpmaster author (ab12cd)',
      url: 'https://github.com/jumpmaster/jumpmaster',
      description:
        'Pushes agent branches and opens, labels and merges pull requests for one Jumpmaster install.',
      redirect_url: 'https://jm.example:7431/setup/github-app/callback',
      setup_url: 'https://jm.example:7431/setup/github-app/installed',
      setup_on_update: true,
      public: false,
      default_events: [],
      default_permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
        statuses: 'read',
        checks: 'read',
        actions: 'read',
      },
    });
    expect(m).not.toHaveProperty('hook_attributes');
  });

  test('the reviewer manifest asks contents: write (spike F12)', () => {
    const m = appManifest('reviewer', opts);
    expect(m).toStrictEqual({
      name: 'Jumpmaster reviewer (ab12cd)',
      url: 'https://github.com/jumpmaster/jumpmaster',
      description:
        'Reviews and approves or requests changes on pull requests for one Jumpmaster install.',
      redirect_url: 'https://jm.example:7431/setup/github-app/callback',
      setup_url: 'https://jm.example:7431/setup/github-app/installed',
      setup_on_update: true,
      public: false,
      default_events: [],
      default_permissions: { pull_requests: 'write', contents: 'write', metadata: 'read' },
    });
    expect(m).not.toHaveProperty('hook_attributes');
  });

  test("the author's set is the author PAT's plus checks: read", () => {
    expect(APP_MANIFEST_PERMISSIONS.author).toStrictEqual({
      ...PAT_PERMISSIONS.author,
      checks: 'read',
    });
  });

  test.each(APP_ROLES)('%s never asks administration or workflows', (role) => {
    const p = appManifest(role, opts).default_permissions;
    expect(p).not.toHaveProperty('administration');
    expect(p).not.toHaveProperty('workflows');
  });

  test.each([
    ['administration', 'read'],
    ['workflows', 'write'],
  ] as const)('a table asking %s is refused', (permission, level) => {
    for (const role of APP_ROLES) {
      const table = {
        ...APP_MANIFEST_PERMISSIONS,
        [role]: { ...APP_MANIFEST_PERMISSIONS[role], [permission]: level },
      };
      expect(() => appManifest(role, opts, table)).toThrow(
        `a manifest never asks for ${permission}`,
      );
    }
  });

  test.each(['ABC', 'a b', '', 'abcdefghijklm'])('installId %j is refused', (installId) => {
    let err: unknown;
    try {
      appManifest('author', { ...opts, installId });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    if (installId) expect((err as Error).message).not.toContain(installId);
  });

  test.each(['ftp://x', 'not a url', 'javascript:alert(1)', 'https://jm.example/path', ''])(
    'baseUrl %j is refused',
    (baseUrl) => {
      let err: unknown;
      try {
        appManifest('author', { ...opts, baseUrl });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      if (baseUrl) expect((err as Error).message).not.toContain(baseUrl);
    },
  );

  test('an http base without a trailing slash is kept as it is', () => {
    const m = appManifest('author', { ...opts, baseUrl: 'http://localhost:7431' });
    expect(m.redirect_url).toBe('http://localhost:7431/setup/github-app/callback');
  });

  test('a 12-character install id fits the 34-character name limit', () => {
    const m = appManifest('reviewer', { ...opts, installId: 'abcdefghijkl' });
    expect(m.name).toBe('Jumpmaster reviewer (abcdefghijkl)');
    expect(m.name.length).toBeLessThanOrEqual(34);
  });
});

describe('appRegistrationUrl', () => {
  test('User gives the personal URL', () => {
    expect(appRegistrationUrl('acme-co', 'User', 'st1')).toBe(
      'https://github.com/settings/apps/new?state=st1',
    );
  });

  test('Organization gives the organization URL', () => {
    expect(appRegistrationUrl('acme-co', 'Organization', 'st1')).toBe(
      'https://github.com/organizations/acme-co/settings/apps/new?state=st1',
    );
  });

  test('the state is encoded and round-trips', () => {
    const state = 'a&b=c d/e?';
    for (const type of ['User', 'Organization'] as const) {
      const u = new URL(appRegistrationUrl('acme-co', type, state));
      expect(u.searchParams.get('state')).toBe(state);
      expect([...u.searchParams.keys()]).toEqual(['state']);
    }
  });

  test('a bad owner is refused without echoing it', () => {
    for (const type of ['User', 'Organization'] as const) {
      expect(() => appRegistrationUrl('a/b', type, 's')).toThrow(Error);
      try {
        appRegistrationUrl('a/b', type, 's');
      } catch (e) {
        expect((e as Error).message).not.toContain('a/b');
      }
    }
  });
});

describe('isPlainHttpBase', () => {
  test.each([
    ['http://jm.example:7431', true],
    ['https://jm.example', false],
    ['http://localhost:7431', false],
    ['http://127.0.0.1:7431', false],
    ['http://[::1]:7431', false],
  ])('%s → %s', (url, plain) => {
    expect(isPlainHttpBase(url)).toBe(plain);
  });
});
