import { describe, expect, test } from 'vitest';
import type { DropZoneConfig } from '../config.js';
import { makeZone } from '../test/fixtures.js';
import type { Resolved, ResolvedCredential } from './credentials.js';
import { credentialProblems } from './problems.js';
import { fingerprintOf } from './vault.js';

const has = (value: string, extra: Partial<ResolvedCredential> = {}): ResolvedCredential => ({
  value,
  source: 'vault',
  fingerprint: fingerprintOf(value),
  ...extra,
});
const missing: ResolvedCredential = { source: 'missing' };
const full = (over: Partial<Resolved> = {}): Resolved =>
  ({
    claudeToken: has('sk-ant-oat01-x'),
    githubAuthorToken: has('github_pat_author', { login: 'author-bot' }),
    githubReviewerToken: has('github_pat_reviewer', { login: 'reviewer-bot' }),
    githubReadToken: missing,
    ...over,
  }) as Resolved;
const zone = (over: Partial<DropZoneConfig> = {}) => makeZone({ id: 'web', ...over });
const kinds = (z: DropZoneConfig, r: Resolved) =>
  credentialProblems(z, r).map((p) => [p.kind, p.credential]);

describe('credentialProblems', () => {
  test('a complete two-bot zone has none, and unknown logins produce none', () => {
    expect(credentialProblems(zone(), full())).toEqual([]);
    const fileSourced = full({
      githubAuthorToken: { value: 'github_pat_a', source: 'file', path: '/secrets/a' },
      githubReviewerToken: { value: 'github_pat_r', source: 'file', path: '/secrets/r' },
    });
    expect(credentialProblems(zone(), fileSourced)).toEqual([]);
  });

  test('no Claude token is one problem in every zone', () => {
    expect(credentialProblems(zone(), full({ claudeToken: missing }))).toEqual([
      {
        zoneId: 'web',
        kind: 'missing',
        credential: 'claudeToken',
        message:
          'no Claude token is set: enter it under Settings, Credentials, or write secrets/claude_token',
      },
    ]);
  });

  test('each rule produces exactly one problem', () => {
    expect(kinds(zone(), full({ githubAuthorToken: missing }))).toEqual([
      ['missing', 'githubAuthorToken'],
    ]);
    expect(kinds(zone(), full({ githubReviewerToken: missing }))).toEqual([
      ['missing', 'githubReviewerToken'],
    ]);
    // Starter needs no reviewer token, but a fine-grained author token.
    expect(kinds(zone({ identity: 'starter' }), full({ githubReviewerToken: missing }))).toEqual(
      [],
    );
    expect(
      kinds(zone({ identity: 'starter' }), full({ githubAuthorToken: has('ghp_classic') })),
    ).toEqual([['kind', 'githubAuthorToken']]);
    expect(
      kinds(zone({ authorMayBeAdmin: true }), full({ githubAuthorToken: has('ghp_classic') })),
    ).toEqual([['kind', 'githubAuthorToken']]);
    expect(kinds(zone({ reviewReadToken: true }), full())).toEqual([
      ['missing', 'githubReadToken'],
    ]);
    expect(
      kinds(
        zone(),
        full({ githubReviewerToken: has('github_pat_reviewer', { login: 'author-bot' }) }),
      ),
    ).toEqual([['same', 'githubReviewerToken']]);
    // The same value is the same account, logins recorded or not.
    expect(
      kinds(
        zone(),
        full({
          githubAuthorToken: { value: 'github_pat_x', source: 'file' },
          githubReviewerToken: { value: 'github_pat_x', source: 'file' },
        }),
      ),
    ).toEqual([['same', 'githubReviewerToken']]);
  });

  test('a gate secret the zone declares and nobody set is missing; a short one is the wrong kind', () => {
    const z = zone({ gateSecrets: ['NPM_TOKEN', 'SHORT'] });
    const r = full({
      'zone:web:SHORT': has('abc'),
      'zone:web:NPM_TOKEN': missing,
    } as Partial<Resolved>);
    expect(credentialProblems(z, r)).toEqual([
      {
        zoneId: 'web',
        kind: 'missing',
        credential: 'zone:web:NPM_TOKEN',
        message:
          'gate secret NPM_TOKEN is not set: enter it under Settings, Credentials, or set JM_ZONE_SECRET_WEB_NPM_TOKEN',
      },
      {
        zoneId: 'web',
        kind: 'kind',
        credential: 'zone:web:SHORT',
        message: 'gate secret SHORT is shorter than 8 characters, too short to redact from logs',
      },
    ]);
  });

  test('a problem message never carries a value', () => {
    const r = full({ githubAuthorToken: has('ghp_classic_value_1234') });
    for (const p of credentialProblems(zone({ identity: 'starter' }), r))
      expect(p.message).not.toContain('ghp_classic_value_1234');
  });
});
