// The README and runbooks a stranger installs from: every link resolves, every anchor the code
// and docs point at exists (GitHub's heading slugs), every doctor check id has a troubleshooting
// entry, no image is named by tag, and the cosign commands match what the stick verifies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { STARTER_WARNING } from '../apps/server/src/config.js';
import { GITHUB_ISSUER, identityRegexp } from '../apps/stick/src/verify.js';
import { walk } from './repo-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const REPOSITORY = 'x-a-n-d-e-r-k/jumpmaster';
const INSTALL = 'docs/runbooks/install.md';

const DOCS = [
  'README.md',
  'SECURITY.md',
  ...readdirSync(join(ROOT, 'docs/runbooks'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/runbooks/${f}`),
];

/** Markdown without fenced code blocks, where links and headings don't count. */
const prose = (md: string): string => md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes, repeats numbered. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every anchor a markdown file has. */
export function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of prose(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1] as string);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of md.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1] as string);
  return out;
}

describe('slug', () => {
  test("follows GitHub's rules", () => {
    expect(slug('Step 3: Create the tokens')).toBe('step-3-create-the-tokens');
    expect(slug('`forge.author-reads`')).toBe('forgeauthor-reads');
    expect(slug('What a stick needs to verify images')).toBe('what-a-stick-needs-to-verify-images');
    expect(slug('Upgrade (drain first)')).toBe('upgrade-drain-first');
    expect([...anchors('# A\n## A\n```\n# not a heading\n```\n')]).toEqual(['a', 'a-1']);
  });
});

describe('the README and runbooks', () => {
  test('every relative link in README.md and docs/runbooks/*.md resolves', () => {
    const broken: string[] = [];
    for (const file of DOCS) {
      for (const m of prose(read(file)).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1] as string;
        if (/^[a-z]+:/i.test(target)) continue; // https:, mailto:
        const [path = '', anchor] = target.split('#');
        const resolved = path === '' ? file : normalize(join(dirname(file), path));
        if (!existsSync(join(ROOT, resolved))) {
          broken.push(`${file}: ${target} (no ${resolved})`);
          continue;
        }
        if (anchor && resolved.endsWith('.md') && !anchors(read(resolved)).has(anchor))
          broken.push(`${file}: ${target} (no #${anchor} in ${resolved})`);
      }
    }
    expect(broken).toEqual([]);
  });

  test('every install.md anchor the code or docs point at exists', () => {
    const have = anchors(read(INSTALL));
    const files = walk(ROOT, ['apps', 'packages', 'docs/runbooks', 'deploy', 'skills', 'images'])
      .filter((f) => /\.(ts|md|sh|ya?ml|tmpl)$/.test(f) && !/\.test\.ts$/.test(f))
      .concat(['README.md', 'SECURITY.md']);
    const missing: string[] = [];
    let found = 0;
    for (const file of files) {
      const text = read(file);
      const refs = [
        ...[...text.matchAll(/install\.md#([A-Za-z0-9_-]+)/g)].map((m) => m[1] as string),
        // Code that builds the URL from the doctor's DOC constant.
        ...[...text.matchAll(/\$\{DOC\}#([A-Za-z0-9_-]+)/g)].map((m) => m[1] as string),
        // The doctor's checks name an anchor through doc('…').
        ...(file === 'apps/server/src/doctor/checks.ts'
          ? [...text.matchAll(/\bdoc\('([a-z0-9-]+)'\)/g)].map((m) => m[1] as string)
          : []),
        // The same file's own links.
        ...(file === INSTALL
          ? [...prose(text).matchAll(/\]\(#([A-Za-z0-9_-]+)\)/g)].map((m) => m[1] as string)
          : []),
      ];
      for (const a of refs) {
        found++;
        if (!have.has(a)) missing.push(`${file}: #${a}`);
      }
    }
    expect(found).toBeGreaterThan(20);
    expect([...new Set(missing)]).toEqual([]);
  });

  test('every doctor check id exists as an anchor in install.md', () => {
    const src = read('apps/server/src/doctor/checks.ts');
    const ids = new Set([...src.matchAll(/\bid: '([a-z]+\.[a-z-]+)'/g)].map((m) => m[1] as string));
    // The two per-identity checks are template strings over who = author | reviewer.
    expect(src).toContain('id: `forge.${who}`');
    expect(src).toContain('id: `forge.${who}-reads`');
    for (const who of ['author', 'reviewer']) ids.add(`forge.${who}`).add(`forge.${who}-reads`);
    expect(ids.size).toBeGreaterThan(20);
    const have = anchors(read(INSTALL));
    expect([...ids].filter((id) => !have.has(slug(`\`${id}\``)))).toEqual([]);
  });

  test('README and install.md mention no tag-ref image', () => {
    // An image name with a :tag and no @sha256 digest after it.
    const tagRef =
      /\b((?:ghcr\.io|docker\.io|registry\.[\w.-]+)\/[\w./-]+|jumpmaster-[a-z-]+|postgres|redis|node|python|alpine):[\w][\w.-]*(?!\S*@sha256:)/g;
    for (const file of ['README.md', INSTALL]) {
      const hits = [...read(file).matchAll(tagRef)]
        .map((m) => m[0])
        .filter((h) => !/:(\d+|\/\/)/.test(h.slice(h.lastIndexOf(':')))); // ports, URLs
      expect(hits, file).toEqual([]);
    }
  });

  test('the cosign commands in SECURITY.md and install.md use the same identity as verify.ts', () => {
    const want = identityRegexp(REPOSITORY);
    for (const file of ['SECURITY.md', INSTALL]) {
      const text = read(file);
      const cmds = [...text.matchAll(/cosign (?:verify|verify-blob)\b[\s\S]*?(?=\n\S|\n\n|```)/g)];
      expect(cmds.length, file).toBeGreaterThanOrEqual(2);
      for (const [cmd] of cmds) {
        expect(cmd, file).toContain(`--certificate-identity-regexp '${want}'`);
        expect(cmd, file).toContain(`--certificate-oidc-issuer ${GITHUB_ISSUER}`);
        expect(cmd, file).toContain('--certificate-github-workflow-trigger push');
        expect(cmd, file).toContain(`--certificate-github-workflow-repository ${REPOSITORY}`);
      }
    }
  });

  test('README and install.md state the starter-mode cost in the doctor’s own words', () => {
    for (const file of ['README.md', INSTALL])
      expect(read(file).replace(/\s*\n\s*(?:>\s*)?/g, ' '), file).toContain(STARTER_WARNING);
  });

  test("install.md carries what a stick needs, and links the release runbook's section", () => {
    const text = read(INSTALL);
    for (const host of [
      'ghcr.io',
      'pkg-containers.githubusercontent.com',
      'tuf-repo-cdn.sigstore.dev',
      'rekor.sigstore.dev',
      'fulcio.sigstore.dev',
    ])
      expect(text).toContain(host);
    expect(text).toContain('release.md#what-a-stick-needs-to-verify-images');
  });

  test('the public docs name no personal path, and use placeholders for the user’s repository', () => {
    for (const file of ['README.md', INSTALL]) {
      const text = read(file);
      expect(text, file).not.toMatch(/\/Users\/|\/home\/[a-z]/);
      expect(text, file).toContain('your-org/your-repo');
    }
  });

  test('the token helper is safe: bash fence, a prompt on stderr, nothing written on empty input', () => {
    for (const file of ['README.md', INSTALL]) {
      const text = read(file);
      const fence = /```(\w*)\n(?:(?!```)[\s\S])*?^put\(\) \{[\s\S]*?^```/m.exec(text);
      expect(fence, file).not.toBeNull();
      expect(fence?.[1], file).toBe('bash');
      const body = fence?.[0] ?? '';
      expect(body, file).toContain('IFS= read -rs t');
      expect(body, file).toContain('[ -z "$t" ]');
      expect(body, file).toContain('return 1');
      expect(body, file).toMatch(/printf 'Paste[^\n]*>&2/);
      // Never a token echoed into a file.
      expect(text, file).not.toMatch(/echo [^\n|]*> *secrets\//);
      expect(text, file).toContain('install -m 0600');
    }
  });

  test('the install needs no Compose override file or version floor', () => {
    for (const file of ['README.md', INSTALL]) {
      expect(read(file), file).not.toContain('compose.override.yaml');
      expect(read(file), file).not.toMatch(/Compose 2\.24/);
    }
  });

  test('the release runbook makes the release-path compose smoke the first post-tag step', () => {
    const text = read('docs/runbooks/release.md');
    expect(text).toContain('deploy/smoke.sh --release v0.4.0-rc.1');
  });

  test('install.md is reached from the README and the older runbooks', () => {
    for (const file of [
      'README.md',
      'docs/runbooks/m1-loop.md',
      'docs/runbooks/m2-cutover.md',
      'docs/runbooks/m3-crew.md',
    ])
      expect(read(file), file).toMatch(/install\.md/);
    expect(relative(ROOT, join(ROOT, INSTALL))).toBe(INSTALL);
  });
});
