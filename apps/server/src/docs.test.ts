import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

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
