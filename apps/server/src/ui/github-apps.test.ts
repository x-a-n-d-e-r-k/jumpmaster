import { describe, expect, test } from 'vitest';
import type { RecommendAnswer } from '../api/github.js';
import { recommendIdentity } from '../github/guidance.js';
import { type AppCreateOptions, appCreateSection } from './github.js';
import { type ForgeGuide, guideSection } from './setup.js';

/** Spec 2026-11-13-github-app-auth §4.1: creating the author and reviewer apps (#374). */

const pat = {
  author: 'https://github.com/settings/personal-access-tokens/new?name=author',
  reviewer: 'https://github.com/settings/personal-access-tokens/new?name=reviewer',
  read: 'https://github.com/settings/personal-access-tokens/new?name=read',
};

function answer(
  o: {
    repo?: string;
    ownerType?: 'User' | 'Organization';
    identity?: 'two-bot' | 'starter';
    stop?: string;
  } = {},
): RecommendAnswer {
  const ownerType = o.ownerType ?? 'Organization';
  const base = recommendIdentity({ ownerType, visibility: 'public' });
  return {
    repo: o.repo ?? 'acme/demo',
    ownerType,
    visibility: 'public',
    visible: true,
    recommendation: {
      ...base,
      identity: o.identity ?? 'two-bot',
      ...(o.stop ? { stop: o.stop } : {}),
    },
    pat,
    checklist: { url: 'https://github.com/acme/demo/settings/access', items: ['Add the bots'] },
    logins: {},
  };
}

const guide = (a: RecommendAnswer): ForgeGuide => ({ repo: a.repo, paidPlan: '', answer: a });
const on = (o: Partial<AppCreateOptions> = {}): AppCreateOptions => ({
  vaultOn: true,
  sudo: true,
  existing: {},
  ...o,
});

/** Each `<form …>…</form>` posting to the start route. */
const startForms = (html: string): string[] =>
  [...html.matchAll(/<form[^>]*action="\/setup\/github-app\/start"[\s\S]*?<\/form>/g)].map(
    (m) => m[0],
  );
const field = (form: string, name: string): string | undefined =>
  new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(form)?.[1];

const ORG_NOTE = 'needs an owner or app manager of that organization';

describe('appCreateSection', () => {
  test('two-bot, organization owner acme: two forms, the organization preselected, and the note', () => {
    const html = appCreateSection(answer(), on());
    expect(html).toContain('GitHub Apps (recommended for two bots)');
    const forms = startForms(html);
    expect(forms).toHaveLength(2);
    expect(forms.map((f) => field(f, 'role'))).toEqual(['author', 'reviewer']);
    for (const f of forms) {
      expect(f).toContain('method="post"');
      expect(field(f, 'owner')).toBe('acme');
      expect(field(f, 'ownerType')).toBe('Organization');
    }
    expect(html).toContain('Create the author app');
    expect(html).toContain('Create the reviewer app');
    expect(html).toMatch(
      /<input type="radio" name="app-owner-type" value="Organization"[^>]* checked>/,
    );
    expect(html).toMatch(
      /<input type="radio" name="app-owner-type" value="User"(?![^>]* checked)[^>]*>/,
    );
    expect(html).toContain('My personal account');
    expect(html).toContain('The organization <code>acme</code>');
    // The login field is empty and required: the conversion checks owner.login against it.
    expect(html).toMatch(/<input id="app-owner-login"[^>]* value=""[^>]* required/);
    expect(html).toContain(ORG_NOTE);
    expect(html).toMatch(/<p[^>]*id="app-org-note"(?![^>]*hidden)[^>]*>/);
    expect(html).toContain("installing it on the organization's repositories needs an owner");
  });

  test('two-bot, user owner alice: the personal choice preselected with her login, no organization option', () => {
    const html = appCreateSection(answer({ repo: 'alice/demo', ownerType: 'User' }), on());
    expect(html).toMatch(/<input type="radio" name="app-owner-type" value="User"[^>]* checked>/);
    expect(html).not.toContain('value="Organization"');
    expect(html).not.toContain('The organization');
    expect(html).not.toContain(ORG_NOTE);
    expect(html).toMatch(/<input id="app-owner-login"[^>]* value="alice"/);
    const forms = startForms(html);
    expect(forms).toHaveLength(2);
    for (const f of forms) {
      expect(field(f, 'owner')).toBe('alice');
      expect(field(f, 'ownerType')).toBe('User');
    }
  });

  test('the personal choice sends the entered login: the script copies it into each form', () => {
    const html = appCreateSection(answer(), on());
    const script = /<script>\n([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain('app-owner-login');
    expect(script).toContain('.owner.value');
    expect(script).toContain('.ownerType.value');
    expect(script).toContain('reportValidity');
  });

  test('an existing author entry shows its slug and install link instead of the author form', () => {
    const html = appCreateSection(answer(), on({ existing: { author: { slug: 'jm-author-x' } } }));
    const forms = startForms(html);
    expect(forms.map((f) => field(f, 'role'))).toEqual(['reviewer']);
    expect(html).not.toContain('Create the author app');
    expect(html).toContain('Created: <code>jm-author-x</code>');
    expect(html).toContain('href="https://github.com/apps/jm-author-x/installations/new"');
  });

  test('both entries present: no forms and no owner choice, only the two install links', () => {
    const html = appCreateSection(
      answer(),
      on({ existing: { author: { slug: 'a-app' }, reviewer: { slug: 'r-app' } } }),
    );
    expect(startForms(html)).toEqual([]);
    expect(html).not.toContain('app-owner-type');
    expect(html).toContain('https://github.com/apps/a-app/installations/new');
    expect(html).toContain('https://github.com/apps/r-app/installations/new');
  });

  test('the vault off: no forms, a message, and a link to the Credentials tab', () => {
    const html = appCreateSection(answer(), on({ vaultOn: false }));
    expect(html).not.toContain('/setup/github-app/start');
    expect(html).not.toContain('<form');
    expect(html).toContain('The vault must be on first');
    expect(html).toContain('href="/settings/credentials"');
  });

  test('without sudo the forms are wired to ask for the passphrase first; with sudo they are not', () => {
    const without = startForms(appCreateSection(answer(), on({ sudo: false })));
    expect(without).toHaveLength(2);
    for (const f of without) expect(f).toContain('data-sudo-first');
    const withSudo = startForms(appCreateSection(answer(), on({ sudo: true })));
    for (const f of withSudo) expect(f).not.toContain('data-sudo-first');
  });

  test('the owner, the login and a slug are escaped', () => {
    const owner = '<script>owner';
    const slug = '<script>alert(1)</script>';
    const html = appCreateSection(
      answer({ repo: `${owner}/demo`, ownerType: 'Organization' }),
      on({ existing: { reviewer: { slug } } }),
    );
    const user = appCreateSection(answer({ repo: `${owner}/demo`, ownerType: 'User' }), on());
    for (const h of [html, user]) {
      expect(h.replace(/<script>\n[\s\S]*?<\/script>/, '')).not.toMatch(/<script>(owner|alert)/);
      expect(h).toContain('&lt;script&gt;owner');
    }
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The install link's slug is URL-encoded inside the GitHub href.
    expect(html).toContain(
      'https://github.com/apps/%3Cscript%3Ealert(1)%3C%2Fscript%3E/installations/new',
    );
  });

  test('no PEM, client id, state or token is in the section: the input carries only slugs', () => {
    const html = appCreateSection(answer(), on({ existing: { author: { slug: 'jm-author-x' } } }));
    expect(html).not.toContain('PRIVATE KEY');
    expect(html).not.toMatch(/name="state"|state=/);
    expect(html).not.toContain('github_pat_');
  });
});

describe('guideSection with the apps argument', () => {
  test('two-bot: the section follows the recommendation and precedes the token links', () => {
    const html = guideSection(guide(answer()), '/setup/forge', on());
    expect(startForms(html)).toHaveLength(2);
    expect(html.indexOf('id="recommendation"')).toBeLessThan(html.indexOf('id="github-apps"'));
    expect(html.indexOf('id="github-apps"')).toBeLessThan(html.indexOf('id="tokens"'));
  });

  test('a starter or a stopped recommendation renders no create buttons and is unchanged', () => {
    for (const a of [
      answer({ repo: 'alice/demo', ownerType: 'User', identity: 'starter' }),
      answer({ stop: 'a private repository on a free plan needs a paid plan' }),
    ]) {
      const html = guideSection(guide(a), '/setup/forge', on());
      expect(html).not.toContain('/setup/github-app/start');
      expect(html).toBe(guideSection(guide(a), '/setup/forge'));
    }
  });

  test('the vault off leaves the token links as they are', () => {
    const g = guide(answer());
    const html = guideSection(g, '/setup/forge', on({ vaultOn: false }));
    expect(html).not.toContain('/setup/github-app/start');
    expect(html.replace(/\n<section id="github-apps">[\s\S]*?<\/section>/, '')).toBe(
      guideSection(g, '/setup/forge'),
    );
  });

  test('without the argument nothing of the apps is rendered', () => {
    for (const a of [answer(), answer({ repo: 'alice/demo', ownerType: 'User' })]) {
      const html = guideSection(guide(a));
      expect(html).not.toContain('github-apps');
      expect(html).not.toContain('/setup/github-app/start');
      expect(html).toBe(guideSection(guide(a), '/setup/forge', undefined));
    }
  });
});
