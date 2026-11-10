import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PROTECTED_PATHS, STARTER_WARNING } from '../config.js';
import { makeZone } from '../test/fixtures.js';
import {
  CODEOWNERS_PLACEHOLDER,
  codeownersNewFileUrl,
  codeownersText,
  collaboratorChecklist,
  PAT_PERMISSIONS,
  PLAN_QUESTION,
  PRIVATE_PLAN_STOP,
  patTemplateUrl,
  RESOURCE_OWNER_NOTE,
  recommendIdentity,
  rulesetJson,
  zoneGuidance,
} from './guidance.js';

const repo = { owner: 'octo-org', name: 'demo' };
const twoBot = makeZone({ repo: 'octo-org/demo', identity: 'two-bot' });
const starter = makeZone({ repo: 'octo/demo', identity: 'starter', authorMayBeAdmin: true });

/** The query of a template URL as [name, value] pairs, in order. */
const query = (url: string): [string, string][] => [...new URL(url).searchParams.entries()];

/** The install runbook's ruleset JSON (the `gh api … rulesets` block under Branch rules). */
function runbookRuleset(): unknown {
  const md = readFileSync(new URL('../../../../docs/runbooks/install.md', import.meta.url), 'utf8');
  const m = /rulesets --input - <<'JSON'\n([\s\S]*?)\nJSON\n/.exec(md);
  if (!m?.[1]) throw new Error('the runbook ruleset block moved');
  return JSON.parse(m[1]);
}

describe('pre-filled token links', () => {
  test('the author, reviewer and read template URLs carry exactly the runbook permissions once each and never Workflows or Administration', () => {
    // The install runbook's table (Tokens), in GitHub's parameter names.
    expect(PAT_PERMISSIONS).toEqual({
      author: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        metadata: 'read',
        statuses: 'read',
        actions: 'read',
      },
      reviewer: { pull_requests: 'write', contents: 'read', metadata: 'read' },
      read: { contents: 'read', metadata: 'read' },
    });
    for (const role of ['author', 'reviewer', 'read'] as const) {
      const url = patTemplateUrl(role, repo, { expirationDays: 90 });
      expect(url.startsWith('https://github.com/settings/personal-access-tokens/new?')).toBe(true);
      const q = query(url);
      const names = q.map(([k]) => k);
      // Every parameter is one GitHub documents for this page, each once.
      expect(new Set(names).size).toBe(names.length);
      const meta = ['name', 'description', 'target_name', 'expires_in'];
      const perms = Object.fromEntries(q.filter(([k]) => !meta.includes(k)));
      expect(perms).toEqual(PAT_PERMISSIONS[role]);
      expect(names).not.toContain('workflows');
      expect(names).not.toContain('administration');
      expect(Object.values(perms).every((v) => v === 'read' || v === 'write')).toBe(true);
      const get = (k: string) => new URL(url).searchParams.get(k);
      expect(get('target_name')).toBe('octo-org');
      expect(get('expires_in')).toBe('90');
      expect((get('name') ?? '').length).toBeLessThanOrEqual(40);
      expect(get('description')).toContain('octo-org/demo');
      expect(get('description')).toContain('Only select repositories');
    }
    // Without an expiry the parameter is left out (GitHub's default, or the owner's policy).
    expect(new URL(patTemplateUrl('read', repo, {})).searchParams.has('expires_in')).toBe(false);
    expect(() => patTemplateUrl('read', repo, { expirationDays: 400 })).toThrow();
    expect(RESOURCE_OWNER_NOTE).toBe(
      'check the Resource owner field: for an organization it may not pre-fill',
    );
  });
});

describe('the ruleset file', () => {
  test('the ruleset JSON equals the runbook field for field, lists each detected job as a required check, and needs 1 approval for two-bot and 0 for starter', () => {
    const one = JSON.parse(
      rulesetJson(twoBot, { defaultBranch: 'main', ciJobs: [{ workflow: 'ci.yml', job: 'test' }] }),
    );
    expect(one).toEqual(runbookRuleset());
    const jobs = [
      { workflow: 'ci.yml', job: 'test' },
      { workflow: 'ci.yml', job: 'Lint' },
      { workflow: 'e2e.yml', job: 'test' },
    ];
    const r = JSON.parse(rulesetJson(starter, { defaultBranch: 'trunk', ciJobs: jobs }));
    expect(r.bypass_actors).toEqual([]);
    expect(r.enforcement).toBe('active');
    expect(r.target).toBe('branch');
    const pr = r.rules.find((x: { type: string }) => x.type === 'pull_request');
    expect(pr.parameters.required_approving_review_count).toBe(0);
    expect(pr.parameters.dismiss_stale_reviews_on_push).toBe(true);
    const checks = r.rules.find((x: { type: string }) => x.type === 'required_status_checks');
    // One check per name (two workflows may report the same name), each from GitHub Actions.
    expect(checks.parameters.required_status_checks).toEqual([
      { context: 'test', integration_id: 15368 },
      { context: 'Lint', integration_id: 15368 },
    ]);
    // No detected job: no empty rule GitHub would refuse; the page says to add the checks.
    const none = JSON.parse(rulesetJson(twoBot, { defaultBranch: 'main', ciJobs: [] }));
    expect(none.rules.map((x: { type: string }) => x.type)).toEqual(['pull_request']);
  });
});

describe('the identity recommendation', () => {
  test('recommendIdentity: user and public is starter with authorMayBeAdmin and the starter warning; organization is two-bot; private on a free plan stops before any token; private with the plan unknown asks', () => {
    const user = recommendIdentity({ ownerType: 'User', visibility: 'public', owner: 'octo' });
    expect(user).toMatchObject({ identity: 'starter', authorMayBeAdmin: true });
    expect(user.reason).toContain(STARTER_WARNING);
    expect(user.reason).toContain('fine-grained');
    expect(user.stop).toBeUndefined();
    expect(user.ask).toBeUndefined();

    const org = recommendIdentity({
      ownerType: 'Organization',
      visibility: 'public',
      owner: 'octo-org',
    });
    expect(org).toMatchObject({ identity: 'two-bot', authorMayBeAdmin: false });
    expect(org.reason).toContain('organization must allow fine-grained');
    expect(org.links).toEqual([
      {
        label: 'the organization (Settings → Personal access tokens)',
        url: 'https://github.com/octo-org',
      },
    ]);

    for (const ownerType of ['User', 'Organization'] as const) {
      const free = recommendIdentity({ ownerType, visibility: 'private', paidPlan: false });
      expect(free.stop).toBe(PRIVATE_PLAN_STOP);
      const unknown = recommendIdentity({ ownerType, visibility: 'private' });
      expect(unknown.ask).toBe(PLAN_QUESTION);
      expect(unknown.stop).toBeUndefined();
      const paid = recommendIdentity({ ownerType, visibility: 'private', paidPlan: true });
      expect(paid.stop).toBeUndefined();
      expect(paid.ask).toBeUndefined();
    }
    expect(PRIVATE_PLAN_STOP).toBe(
      'rulesets on a private repository need a paid plan: make it public or upgrade before any token is created',
    );
  });
});

describe('CODEOWNERS and collaborators', () => {
  test('codeownersText writes one line per protected path naming each reviewer, and the new-file link targets .github/CODEOWNERS on the default branch', () => {
    const zone = makeZone({ protectedPaths: ['.github/**', 'CLAUDE.md', 'vitest.config.*'] });
    const text = codeownersText(zone, ['alice', '@octo-org/maintainers']);
    const lines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual([
      '.github/** @alice @octo-org/maintainers',
      'CLAUDE.md @alice @octo-org/maintainers',
      'vitest.config.* @alice @octo-org/maintainers',
    ]);
    // The default set is all writable as CODEOWNERS patterns.
    const all = codeownersText(makeZone({ protectedPaths: DEFAULT_PROTECTED_PATHS }), ['alice']);
    expect(all.split('\n').filter((l) => l.endsWith(' @alice'))).toHaveLength(
      DEFAULT_PROTECTED_PATHS.length,
    );
    // A pattern CODEOWNERS cannot express (negation, a character class, a space) is left out and
    // said, never written half-right.
    const odd = codeownersText(makeZone({ protectedPaths: ['!x', 'src/[ab].ts', 'a b', 'ok'] }), [
      'alice',
    ]);
    expect(odd).toContain('ok @alice');
    expect(odd).not.toMatch(/^!x/m);
    expect(odd).toContain('# not expressible in CODEOWNERS: !x, src/[ab].ts, a b');
    // No login yet: a placeholder the step asks to replace.
    expect(codeownersText(zone, [])).toContain(`.github/** ${CODEOWNERS_PLACEHOLDER}`);
    // A login that is not one is refused, so nothing but logins reaches the file.
    expect(() => codeownersText(zone, ['alice bob'])).toThrow();
    expect(() => codeownersText(zone, ['al\nice'])).toThrow();
    expect(codeownersNewFileUrl(repo, 'main')).toBe(
      'https://github.com/octo-org/demo/new/main?filename=.github%2FCODEOWNERS',
    );
    expect(codeownersNewFileUrl(repo, 'release/v1')).toBe(
      'https://github.com/octo-org/demo/new/release/v1?filename=.github%2FCODEOWNERS',
    );
  });

  test('the collaborator checklist names the resolved bot logins with the Write role', () => {
    expect(collaboratorChecklist(twoBot, { author: 'jm-author', reviewer: 'jm-reviewer' })).toEqual(
      {
        url: 'https://github.com/octo-org/demo/settings/access',
        items: [
          'invite jm-author with the Write role',
          'accept the invitation as jm-author',
          'invite jm-reviewer with the Write role',
          'accept the invitation as jm-reviewer',
        ],
      },
    );
    // Starter: no reviewer; the owner's own account needs no invitation.
    expect(collaboratorChecklist(starter, { author: 'octo', reviewer: 'someone' }).items).toEqual([
      'nothing to invite: octo owns the repository',
    ]);
    // Not resolved yet: named by role, not guessed.
    expect(collaboratorChecklist(twoBot, {}).items).toEqual([
      'invite the author account with the Write role',
      'accept the invitation as the author account',
      'invite the reviewer account with the Write role',
      'accept the invitation as the reviewer account',
    ]);
  });
});

describe('zoneGuidance', () => {
  const SECRETS = [
    'github_pat_11AAAAAAA0secretsecretsecret',
    'ghp_classicclassicclassicclassic',
    'sk-ant-oat01-claudeclaudeclaude',
  ];

  test('every generated URL is under github.com and no generated text carries a credential', () => {
    for (const zone of [
      twoBot,
      starter,
      makeZone({ repo: 'octo/private', reviewReadToken: true }),
    ]) {
      const g = zoneGuidance(
        zone,
        {
          defaultBranch: 'main',
          ciJobs: [{ workflow: 'ci.yml', job: 'test' }],
          ownerType: zone.identity === 'starter' ? 'User' : 'Organization',
          visibility: zone.reviewReadToken ? 'private' : 'public',
        },
        { author: 'jm-author', reviewer: 'jm-reviewer', codeowners: ['alice'] },
      );
      const urls = [
        g.pat.author,
        g.pat.reviewer,
        g.pat.read,
        g.codeowners.newFileUrl,
        g.checklist.url,
        g.rulesUrl,
        ...(g.recommendation.links ?? []).map((l) => l.url),
      ];
      for (const u of urls) {
        expect(u.startsWith('https://github.com/'), u).toBe(true);
        expect(new URL(u).host).toBe('github.com');
      }
      const all = JSON.stringify(g);
      for (const s of SECRETS) expect(all).not.toContain(s);
      expect(all).not.toMatch(/github_pat_|ghp_|gho_|sk-ant-/);
      expect(g.ruleset.filename).toMatch(/^jumpmaster-[a-z0-9-]+-ruleset\.json$/);
      expect(g.codeowners.filename).toBe('.github/CODEOWNERS');
      expect(g.rulesUrl).toBe(`https://github.com/${zone.repo}/settings/rules`);
    }
  });
});
