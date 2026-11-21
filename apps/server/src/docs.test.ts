import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_READY_LABEL } from './config.js';
import { SHADOWED_APP_FIX, SHADOWED_TOKEN_FIX } from './doctor/checks.js';

/**
 * SECURITY.md's statements about GitHub App mode (issue #471), and the sections that must not
 * change: the cosign commands under "Verifying a release" are checked by
 * apps/stick/src/verify.test.ts, and the reporting policy and scope are the project's promise.
 */

const SECURITY = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');

/** The text from a `## ` heading to the next `## ` heading (exclusive). */
function section(heading: string): string {
  const start = SECURITY.indexOf(`\n${heading}\n`);
  if (start < 0) return '';
  const end = SECURITY.indexOf('\n## ', start + 1);
  return SECURITY.slice(start + 1, end < 0 ? undefined : end + 1);
}

const REPORTING = [
  '## Reporting a vulnerability',
  '',
  "**Please do not open a public issue.** Report privately through GitHub's",
  '[private vulnerability reporting](https://github.com/x-a-n-d-e-r-k/jumpmaster/security/advisories/new).',
  '',
  'Include what you can: affected version or commit, a description of the issue, steps to reproduce,',
  "and the impact you expect. You should get an acknowledgement within 3 business days. We'll keep",
  "you updated as we investigate and credit you in the advisory unless you'd rather stay anonymous.",
  '',
  '',
].join('\n');

const SCOPE = [
  '## Scope',
  '',
  'In scope: the Jumpmaster app, the stick agent, trooper images, the MCP server, and the published',
  'container images. Of particular interest:',
  '',
  '- credential exposure (Claude tokens, forge tokens, vault contents)',
  '- prompt injection that lets untrusted issue, PR, or comment text steer an agent',
  "- escaping a drop container or reaching another project's data",
  "- bypassing the orchestrator's merge checks or branch protection",
  '',
  'Out of scope: vulnerabilities in Claude Code, GitHub, GitLab, Docker, or Kubernetes themselves —',
  'please report those to their maintainers.',
  '',
  '',
].join('\n');

const VERIFYING = [
  '## Verifying a release',
  '',
  'Every release image (server, stick, trooper and its python, go and jvm presets, and the egress',
  'proxy) is published to GHCR by digest and signed with [cosign](https://docs.sigstore.dev/) keyless',
  "signing by this repository's release workflow, from a version tag on `main`. The stick checks",
  'the same signature before it runs a trooper or proxy image. Each GitHub Release also carries',
  '`compose.yaml` and `images.lock.json` (every image by digest), a `SHA256SUMS` over them, and',
  '`SHA256SUMS.sigstore.json`, the signature bundle for `SHA256SUMS`.',
  '',
  "Check an image (take its digest from the release's `images.lock.json`):",
  '',
  '```sh',
  'cosign verify \\',
  "  --certificate-identity-regexp '^https://github\\.com/x-a-n-d-e-r-k/jumpmaster/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$' \\",
  '  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\',
  '  --certificate-github-workflow-trigger push \\',
  '  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \\',
  '  ghcr.io/x-a-n-d-e-r-k/jumpmaster-server@sha256:<digest>',
  '```',
  '',
  'Check the release files, in the directory you downloaded them to:',
  '',
  '```sh',
  'cosign verify-blob --bundle SHA256SUMS.sigstore.json \\',
  "  --certificate-identity-regexp '^https://github\\.com/x-a-n-d-e-r-k/jumpmaster/\\.github/workflows/release\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$' \\",
  '  --certificate-oidc-issuer https://token.actions.githubusercontent.com \\',
  '  --certificate-github-workflow-trigger push \\',
  '  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \\',
  '  SHA256SUMS',
  'sha256sum -c SHA256SUMS',
  '```',
  '',
  'Without cosign installed, run it from its own image, pinned by digest (cosign v3.1.4). Prefix',
  'either command with it; for `verify-blob`, the current directory is mounted at `/w`:',
  '',
  '```sh',
  'docker run --rm -v "$PWD:/w" -w /w ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d verify ...',
  '```',
  '',
  'A signature proves the image was built and signed by `release.yml` in this repository, from a',
  '`push` of a version tag. Only repository administrators can create, move or delete version tags',
  '(a tag ruleset on `refs/tags/v*`): that is the control on who can mint a release. The workflow',
  'additionally refuses a tag whose commit is not on `main`. Images are published for linux/amd64',
  'and linux/arm64 under one digest.',
  '',
  'A signature is never withdrawn: every image this workflow has ever signed keeps verifying. A',
  'stick under the `signed` image policy has a floor, though: it runs a drop or service image only',
  "if its signature comes from a release tag at or above the stick's own release version (read from",
  "the signing certificate's `release.yml@refs/tags/<tag>` identity; `vX.Y.Z-rc.N` sorts below",
  "`vX.Y.Z`). An older release's image is refused with `image signed for <tag>, older than this stick",
  '(<version>)`, a signature naming no release tag with `image signature carries no release tag`,',
  'and a stick built without a release version refuses every signed image. So a newer server works',
  "with older sticks, but no one can select an older trooper for a stick. The stick's own and egress",
  "images, pinned by digest at install, are outside this rule; above the floor, the newest release's",
  '`images.lock.json` decides which image a zone runs.',
  '',
  '',
].join('\n');

describe('SECURITY.md in app mode', () => {
  test('drops the PAT-mode-today caveat', () => {
    expect(SECURITY).not.toContain('Jumpmaster runs in PAT mode today');
  });

  test('names where the app private key lives, and its reach', () => {
    expect(SECURITY).toContain('github-app/<owner>/<role>');
    expect(SECURITY).toContain('secrets/github-app/<owner>/<role>.json');
    expect(SECURITY).toContain('All repositories');
  });

  test('says no app has the Administration or Workflows permission', () => {
    const at = SECURITY.indexOf('No app has');
    expect(at).toBeGreaterThanOrEqual(0);
    const sentence = SECURITY.slice(at, SECURITY.indexOf('.', at));
    expect(sentence).toMatch(/administration/i);
    expect(sentence).toMatch(/workflows/i);
    expect(SECURITY).not.toContain('administration: write');
    expect(SECURITY).not.toContain('workflows: write');
  });

  test.each([
    ['## Reporting a vulnerability', REPORTING],
    ['## Scope', SCOPE],
    ['## Verifying a release', VERIFYING],
  ])('%s is unchanged', (heading, recorded) => {
    expect(section(heading)).toBe(recorded);
  });
});

describe('credential.shadowed covers GitHub App entry files (issue #551)', () => {
  const INSTALL = readFileSync(
    new URL('../../../docs/runbooks/install.md', import.meta.url),
    'utf8',
  );

  test('SECURITY.md\'s "File secrets by name" names the app entry file with credential.shadowed', () => {
    const start = SECURITY.indexOf('\n### File secrets by name\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = SECURITY.indexOf('\n#', start + 1);
    const text = SECURITY.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
    expect(text).toContain('`secrets/github-app/<owner>/<role>.json`');
    expect(text).toContain('`credential.shadowed`');
  });

  test("the install runbook's credential.shadowed section mentions app entry files and how to resolve them", () => {
    const start = INSTALL.indexOf('\n### `credential.shadowed`\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = INSTALL.indexOf('\n### ', start + 1);
    const text = INSTALL.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
    expect(text).toContain('`secrets/github-app/<owner>/<role>.json`');
    expect(text).toContain('`jumpmaster ctl secrets reload`');
  });

  /** The `jumpmaster ctl …` commands a text names, and whether it tells to replace the entry. */
  const actionsOf = (text: string) => ({
    commands: [
      ...new Set(
        [...text.matchAll(/jumpmaster ctl secrets (reload|remove [^\s`.,)]+)/g)].map((m) => m[1]),
      ),
    ].sort(),
    deletesFile: /delete the file/.test(text),
  });

  test("the runbook's app entry paragraph names the same actions as the doctor's fix, and no Replace key (issue #599)", () => {
    const start = INSTALL.indexOf('\n### `credential.shadowed`\n');
    const end = INSTALL.indexOf('\n### ', start + 1);
    const section = INSTALL.slice(start, end);
    const app = section.slice(section.indexOf('GitHub App entry files')).replace(/\s+/g, ' ');
    const token = section.slice(0, section.indexOf('GitHub App entry files')).replace(/\s+/g, ' ');
    expect(actionsOf(app)).toEqual(actionsOf(SHADOWED_APP_FIX));
    expect(actionsOf(app).commands).toEqual(['reload', 'remove github-app/<owner>/<role>']);
    expect(actionsOf(token).commands).toEqual(actionsOf(SHADOWED_TOKEN_FIX).commands);
    // Replace key is named only to say it does not clear the warning.
    expect(app).not.toMatch(/replace the vault entry/i);
    expect(app).toContain('Replace key does not');
    expect(app).not.toContain("does not take an app entry's name");
  });
});

describe('operate runbook: adding a repository or an owner on GitHub Apps (issue #553)', () => {
  const OPERATE = readFileSync(
    new URL('../../../docs/runbooks/operate.md', import.meta.url),
    'utf8',
  );
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  /** The text of the GitHub Apps section, from its heading to the next `#### ` heading. */
  function appsSection(): string {
    const start = OPERATE.indexOf('\n### GitHub Apps\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = OPERATE.indexOf('\n#### ', start + 1);
    return OPERATE.slice(start, end < 0 ? undefined : end);
  }

  /** The numbered steps of the procedure that starts at `lead`, each flattened to one line. */
  function steps(lead: string): string[] {
    const text = appsSection();
    const start = text.indexOf(lead);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n\n**', start + lead.length);
    const body = text.slice(start, end < 0 ? undefined : end);
    return body
      .split(/\n(?=\d+\. )/)
      .slice(1)
      .map(flat);
  }

  /** The index of the first step containing `needle`; fails when none does. */
  function stepOf(list: string[], needle: string): number {
    const i = list.findIndex((s) => s.includes(needle));
    expect(i, `no step mentions ${needle}`).toBeGreaterThanOrEqual(0);
    return i;
  }

  const ADD_ZONE = '[Add a project](#add-a-project)';

  test('Adding an owner: create the pair, install both apps, add the zone, then find the installations', () => {
    const s = steps('**Adding an owner**');
    const pair = stepOf(s, '**Create the author app**');
    const install = stepOf(s, '**Install it on the repository**');
    const zone = stepOf(s, ADD_ZONE);
    const find = stepOf(s, '**Find the installations**');
    const rules = stepOf(s, '[Branch rules](install.md#branch-rules)');
    expect(pair).toBeLessThan(zone);
    expect(install).toBeLessThan(zone);
    expect(pair).toBeLessThanOrEqual(install);
    expect(zone).toBeLessThan(find);
    expect(find).toBeLessThan(rules);
    expect(s[rules]).toMatch(/doctor/);
  });

  test('Adding an owner: the install step names a link that exists before the zone, not the Credentials rows', () => {
    const s = steps('**Adding an owner**');
    const install = s[stepOf(s, '**Install it on the repository**')] as string;
    expect(install).toContain('`/setup/forge`');
    expect(install).toContain('**Finish**');
    expect(install).not.toContain("row's **Install** link");
    for (const step of s.slice(0, stepOf(s, ADD_ZONE)))
      expect(step).not.toMatch(/rows (then )?appear/);
  });

  test('the GitHub App entries rows are listed for the owners of configured two-bot zones', () => {
    expect(flat(appsSection())).toContain(
      'rows are listed only for the owners of configured two-bot zones',
    );
  });

  test('Adding a repository on an owner with a pair: the installation covers it before the zone is added', () => {
    const s = steps('**Adding a repository on an owner that already has a pair.**');
    const cover = stepOf(s, '**Only select repositories**');
    const zone = stepOf(s, ADD_ZONE);
    expect(cover).toBeLessThan(zone);
    expect(s[cover]).toMatch(/author app/);
    // What Detect answers when the author app's installation does not cover the repository.
    expect(s[zone]).toContain('is not installed on');
    expect(s[zone]).toContain('**Detect**');
  });

  test("the operate runbook points at the install runbook's Project step for the order", () => {
    expect(appsSection()).toContain('(install.md#step-4-the-setup-wizard)');
  });

  test('starter mode and "Use tokens instead" text is unchanged, and no secret appears', () => {
    expect(flat(appsSection())).toContain(
      flat(`**Starter mode and tokens.** Starter-mode zones, and two-bot zones that chose "Use tokens
instead", are unchanged: they keep using the token rows above ([Credentials and
rotation](#credentials-and-rotation)), and nothing here applies to them.`),
    );
    const text = appsSection();
    expect(text).not.toMatch(/-----BEGIN/);
    expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
    expect(text).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
  });
});

describe('runbooks after the New issue split (#581)', () => {
  const dir = new URL('../../../docs/runbooks/', import.meta.url);
  const read = (f: string) => readFileSync(new URL(f, dir), 'utf8');

  test('operate.md quotes the idle status line statusOf prints for the default ready label', () => {
    expect(read('operate.md')).toContain(
      `Idle: no ready issues. Label one ${DEFAULT_READY_LABEL} or file a new issue`,
    );
  });

  test('no runbook sends the operator to Intake to file an issue; install.md names /issues/new', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    const stale = [
      'from Intake',
      'from the intake page',
      "from the zone's Intake page",
      'intake page (`/zones/<id>/intake`) files',
    ];
    for (const f of files) {
      const text = read(f);
      for (const phrase of stale) expect(text, `${f}: ${phrase}`).not.toContain(phrase);
    }
    expect(read('install.md')).toContain('/issues/new');
  });
});
