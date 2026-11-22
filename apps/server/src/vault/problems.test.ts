import { describe, expect, test } from 'vitest';
import type { DropZoneConfig } from '../config.js';
import { makeZone } from '../test/fixtures.js';
import type { Resolved, ResolvedCredential } from './credentials.js';
import { credentialProblems } from './problems.js';
import type { ResolvedApps } from './resolution.js';
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
          'no Claude token is set: enter it under System, Credentials, or write secrets/claude_token',
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
          'gate secret NPM_TOKEN is not set: enter it under System, Credentials, or set JM_ZONE_SECRET_WEB_NPM_TOKEN',
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

describe('the read token in app mode (issue #237)', () => {
  const entry = {
    source: 'vault',
    fingerprint: 'fp',
    entry: { appId: '9', slug: 'rev', clientId: 'c', pem: 'unused', importedAt: '2026-11-01' },
  } as const;
  const owner = (z: DropZoneConfig) => z.repo.split('/')[0]!.toLowerCase();
  const appsFor = (z: DropZoneConfig): ResolvedApps =>
    new Map([[owner(z), { author: entry, reviewer: entry }]]);
  const recorded = (installations: { author?: number; reviewer?: number }) => ({
    githubApp: { repositoryId: 5, installations },
  });

  test('an app-reviewer zone with reviewReadToken and no read token is not parked', () => {
    const z = zone({ reviewReadToken: true, ...recorded({ author: 1, reviewer: 2 }) });
    expect(credentialProblems(z, full(), appsFor(z))).toEqual([]);
  });

  test('a PAT zone in that state still is', () => {
    const z = zone({ reviewReadToken: true });
    expect(credentialProblems(z, full(), new Map()).map((p) => [p.kind, p.credential])).toEqual([
      ['missing', 'githubReadToken'],
    ]);
  });

  test('an app zone with no recorded reviewer installation still is', () => {
    const z = zone({ reviewReadToken: true, ...recorded({ author: 1 }) });
    expect(credentialProblems(z, full(), appsFor(z)).map((p) => [p.kind, p.credential])).toEqual([
      ['missing', 'githubReadToken'],
    ]);
  });
});

describe('PAT requirements for GitHub App roles (issue #458)', () => {
  const PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nfixture-pem-body-458\n-----END RSA PRIVATE KEY-----';
  const entry = {
    source: 'vault',
    fingerprint: 'fp',
    entry: { appId: '9', slug: 'bot', clientId: 'c', pem: PEM, importedAt: '2026-11-01' },
  } as const;
  const absent = { source: 'missing' } as const;
  const broken = { source: 'missing', undecryptable: true } as const;
  type Read = typeof entry | typeof absent | typeof broken;
  const owner = (z: DropZoneConfig) => z.repo.split('/')[0]!.toLowerCase();
  const appsOf = (z: DropZoneConfig, author: Read, reviewer: Read): ResolvedApps =>
    new Map([[owner(z), { author, reviewer }]]);
  const TOKENS = [
    'sk-ant-oat01-x',
    'github_pat_author',
    'github_pat_reviewer',
    'ghp_classic_458',
    'github_pat_leftover',
  ];
  const seen: string[] = [];
  const run = (z: DropZoneConfig, r: Resolved, a: ResolvedApps) => {
    const out = credentialProblems(z, r, a);
    seen.push(...out.map((p) => p.message));
    return out;
  };
  const shape = (z: DropZoneConfig, r: Resolved, a: ResolvedApps) =>
    run(z, r, a).map((p) => [p.kind, p.credential]);

  test('a two-bot zone with both app entries and no PATs has no problems', () => {
    const z = zone();
    const r = full({ githubAuthorToken: missing, githubReviewerToken: missing });
    expect(run(z, r, appsOf(z, entry, entry))).toEqual([]);
  });

  test('an author app with authorMayBeAdmin and no author PAT has no problems', () => {
    const z = zone({ authorMayBeAdmin: true });
    expect(run(z, full({ githubAuthorToken: missing }), appsOf(z, entry, absent))).toEqual([]);
    // A leftover classic author PAT is unused, so not the wrong kind either.
    expect(
      run(z, full({ githubAuthorToken: has('ghp_classic_458') }), appsOf(z, entry, absent)),
    ).toEqual([]);
  });

  test('hybrid: an author app needs only the reviewer PAT', () => {
    const z = zone();
    const a = appsOf(z, entry, absent);
    expect(run(z, full({ githubAuthorToken: missing }), a)).toEqual([]);
    expect(shape(z, full({ githubAuthorToken: missing, githubReviewerToken: missing }), a)).toEqual(
      [['missing', 'githubReviewerToken']],
    );
  });

  test('hybrid: a reviewer PAT equal to a leftover author PAT is not the same account', () => {
    const z = zone();
    const r = full({
      githubAuthorToken: has('github_pat_leftover', { login: 'bot' }),
      githubReviewerToken: has('github_pat_leftover', { login: 'bot' }),
    });
    expect(run(z, r, appsOf(z, entry, absent))).toEqual([]);
  });

  test('a reviewer app needs no reviewer PAT', () => {
    const z = zone();
    expect(run(z, full({ githubReviewerToken: missing }), appsOf(z, absent, entry))).toEqual([]);
  });

  test('an undecryptable author entry parks the zone on the author PAT, PAT set or not', () => {
    const z = zone();
    const a = appsOf(z, broken, entry);
    const without = run(z, full({ githubAuthorToken: missing, githubReviewerToken: missing }), a);
    expect(without.map((p) => [p.kind, p.credential])).toEqual([['missing', 'githubAuthorToken']]);
    expect(without[0]!.message).toContain(`github-app/${owner(z)}/author`);
    expect(without[0]!.message).toMatch(/undecryptable/);
    expect(without[0]!.message).toMatch(/import the entry again|restore the vault key/);
    const withPat = run(z, full({ githubReviewerToken: missing }), a);
    expect(withPat).toEqual(without);
    // A classic PAT with authorMayBeAdmin adds no kind problem: the PAT is not in use.
    expect(
      shape(
        zone({ authorMayBeAdmin: true }),
        full({ githubAuthorToken: has('ghp_classic_458') }),
        a,
      ),
    ).toEqual([['missing', 'githubAuthorToken']]);
  });

  test('an undecryptable reviewer entry parks the zone on the reviewer PAT', () => {
    const z = zone();
    const out = run(z, full(), appsOf(z, entry, broken));
    expect(out.map((p) => [p.kind, p.credential])).toEqual([['missing', 'githubReviewerToken']]);
    expect(out[0]!.message).toContain(`github-app/${owner(z)}/reviewer`);
  });

  test('a starter zone ignores app entries for its owner', () => {
    const z = zone({ identity: 'starter' });
    const a = appsOf(z, entry, entry);
    expect(run(z, full({ githubReviewerToken: missing }), a)).toEqual([]);
    expect(shape(z, full({ githubAuthorToken: has('ghp_classic_458') }), a)).toEqual([
      ['kind', 'githubAuthorToken'],
    ]);
    expect(shape(z, full({ githubAuthorToken: missing }), a)).toEqual([
      ['missing', 'githubAuthorToken'],
    ]);
  });

  test('no message carries a token value or PEM text', () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) {
      for (const t of TOKENS) expect(m).not.toContain(t);
      expect(m).not.toContain('fixture-pem-body-458');
      expect(m).not.toContain('BEGIN RSA');
    }
  });
});
