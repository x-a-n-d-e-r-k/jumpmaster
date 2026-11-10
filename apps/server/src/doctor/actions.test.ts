import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { patTemplateUrl, repoOf, zoneGuidance } from '../github/guidance.js';
import { makeZone } from '../test/fixtures.js';
import { ACTION_IDS, actionFor, NO_ACTION, PAGES_M45A, type Pages } from './actions.js';
import { CHECK_IDS, DOC, type DoctorCheck } from './checks.js';

const zone = makeZone({ id: 'web', repo: 'octo/web' });
const fail = (id: string, o: Partial<DoctorCheck> = {}): DoctorCheck => ({
  id,
  zoneId: id.startsWith('zone.') || id.startsWith('forge.') ? 'web' : null,
  status: 'fail',
  summary: 's',
  ...o,
});
const guidance = zoneGuidance(
  zone,
  {
    defaultBranch: 'trunk',
    ciJobs: [
      { workflow: 'ci.yml', job: 'test' },
      { workflow: 'ci.yml', job: 'lint' },
    ],
    ownerType: 'User',
    visibility: 'public',
  },
  { author: 'jm-author', reviewer: 'jm-reviewer', codeowners: ['alice'] },
);
const all: Pages = { zones: true, settings: true, credentials: true };

describe('the action table', () => {
  test('every doctor check id has an action or a reason in NO_ACTION, and the install runbook lists the same ids', () => {
    const covered = [...ACTION_IDS, ...Object.keys(NO_ACTION)].sort();
    expect(covered).toEqual([...CHECK_IDS].sort());
    for (const why of Object.values(NO_ACTION)) expect(why.length).toBeGreaterThan(10);
    const runbook = readFileSync(
      join(import.meta.dirname, '../../../../docs/runbooks/install.md'),
      'utf8',
    );
    const listed = [...runbook.matchAll(/^### `([a-z]+\.[a-z-]+)`$/gm)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual([...CHECK_IDS].sort());
  });

  test('the docs fallback is the check own runbook anchor, or the anchor named by the check', () => {
    expect(actionFor(fail('config.uid'), { pages: PAGES_M45A })).toEqual({
      kind: 'docs',
      label: 'Read the runbook: config.uid',
      href: `${DOC}#configuid`,
    });
    expect(actionFor(fail('config.uid', { doc: `${DOC}#uid` }), { pages: PAGES_M45A })?.href).toBe(
      `${DOC}#uid`,
    );
  });
});

describe('where each fail leads', () => {
  test('a zone check links to its zone page section once the zones page exists and to the runbook before', () => {
    const egress = fail('zone.egress', { doc: `${DOC}#egress` });
    expect(actionFor(egress, { zone, pages: all })).toEqual({
      kind: 'app',
      label: 'Edit the egress of web',
      href: '/zones/web#egress',
    });
    expect(actionFor(egress, { zone, pages: PAGES_M45A })).toMatchObject({
      kind: 'docs',
      href: `${DOC}#egress`,
    });
    expect(actionFor(fail('zone.mode'), { zone, pages: all })?.href).toBe('/zones');
    expect(actionFor(fail('zone.mode'), { zone, pages: PAGES_M45A })?.href).toBe('/');
    const odd = makeZone({ id: 'a b<c', repo: 'octo/x' });
    expect(actionFor(fail('zone.preset'), { zone: odd, pages: all })?.href).toBe(
      '/zones/a%20b%3Cc#preset',
    );
  });

  test('a credential check links to the Credentials tab, and before it exists to the wizard step that sets it', () => {
    for (const id of ['credential.missing', 'forge.author', 'claude.token-age', 'vault.key'])
      expect(actionFor(fail(id), { zone, pages: all })).toMatchObject({
        kind: 'app',
        href: '/settings/credentials',
      });
    expect(
      actionFor(fail('credential.missing', { summary: 'claudeToken: no Claude token is set' }), {
        pages: PAGES_M45A,
      })?.href,
    ).toBe('/setup/claude');
    expect(actionFor(fail('claude.token-age'), { pages: PAGES_M45A })?.href).toBe('/setup/claude');
    expect(actionFor(fail('forge.reviewer'), { zone, pages: PAGES_M45A })?.href).toBe(
      '/setup/forge',
    );
    expect(
      actionFor(fail('vault.key', { doc: `${DOC}#tokens` }), { pages: PAGES_M45A }),
    ).toMatchObject({ kind: 'docs' });
  });

  test('forge.branch-rules and forge.codeowners carry the generated file as an artifact, and forge.ci names the detected jobs', () => {
    expect(actionFor(fail('forge.branch-rules'), { zone, guidance, pages: PAGES_M45A })).toEqual({
      kind: 'forge',
      label: 'Import the ruleset file on GitHub',
      href: 'https://github.com/octo/web/settings/rules',
      artifact: { filename: guidance.ruleset.filename, text: guidance.ruleset.text },
    });
    expect(actionFor(fail('forge.codeowners'), { zone, guidance, pages: PAGES_M45A })).toEqual({
      kind: 'forge',
      label: 'Create .github/CODEOWNERS on GitHub',
      href: guidance.codeowners.newFileUrl,
      artifact: { filename: 'CODEOWNERS', text: guidance.codeowners.text },
    });
    expect(actionFor(fail('forge.ci'), { zone, guidance, pages: PAGES_M45A })).toEqual({
      kind: 'forge',
      label: 'Open GitHub Actions (detected jobs: test, lint)',
      href: 'https://github.com/octo/web/actions',
    });
    // Without the guidance (GitHub unreadable), the zone's GitHub page has every file.
    expect(actionFor(fail('forge.branch-rules'), { zone, pages: PAGES_M45A })).toEqual({
      kind: 'app',
      label: 'Get the ruleset file for web',
      href: '/zones/web/github',
    });
  });

  test('forge.author-reads and forge.reviewer-reads link the template URL for that role', () => {
    for (const role of ['author', 'reviewer'] as const)
      expect(actionFor(fail(`forge.${role}-reads`), { zone, pages: PAGES_M45A })).toEqual({
        kind: 'forge',
        label: `Make a ${role} token with the right permissions`,
        href: patTemplateUrl(role, repoOf(zone), { expirationDays: 90 }),
      });
  });

  test('forge.labels offers the create action as a POST, never a link; the doctor drop is its run button', () => {
    expect(actionFor(fail('forge.labels'), { zone, pages: PAGES_M45A })).toEqual({
      kind: 'app',
      label: 'Create the missing labels',
      href: '/api/control/zones/web/labels',
      method: 'POST',
    });
    expect(actionFor(fail('zone.doctor-drop'), { zone, pages: PAGES_M45A })).toEqual({
      kind: 'app',
      label: 'Run a doctor drop for web',
      href: '/api/control/doctor/drop',
      method: 'POST',
      body: { zone: 'web' },
    });
  });

  test('a passing check has no action', () => {
    expect(actionFor({ ...fail('forge.labels'), status: 'pass' }, { zone, pages: all })).toBe(
      undefined,
    );
  });
});
