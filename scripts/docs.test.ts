// The README and runbooks a stranger installs from: every link resolves, every anchor the code
// and docs point at exists (GitHub's heading slugs), every doctor check id has a troubleshooting
// entry, no image is named by tag, and the cosign commands match what the stick verifies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CONTROL_ROUTES, CTL_VERBS, PAGES } from '../apps/server/src/api/manifest.js';
import { ENV_FIX, VAULT_KEY_WARNING } from '../apps/server/src/bootstrap.js';
import { STARTER_WARNING } from '../apps/server/src/config.js';
import { actionFor, type Pages } from '../apps/server/src/doctor/actions.js';
import { CHECK_IDS, DOC } from '../apps/server/src/doctor/checks.js';
import { makeZone } from '../apps/server/src/test/fixtures.js';
import { GITHUB_ISSUER, identityRegexp } from '../apps/stick/src/verify.js';
import { walk } from './repo-files.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const REPOSITORY = 'x-a-n-d-e-r-k/jumpmaster';
const INSTALL = 'docs/runbooks/install.md';
const OPERATE = 'docs/runbooks/operate.md';

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
    for (const file of DOCS) expect(read(file), file).not.toMatch(/\/Users\/|\/home\/[a-z]/);
    for (const file of ['README.md', INSTALL, OPERATE])
      expect(read(file), file).toContain('your-org/your-repo');
  });

  test('the token helper is safe: bash fence, a prompt on stderr, nothing written on empty input', () => {
    // The scripted install's helper; the README's browser path writes no token file.
    for (const file of [INSTALL]) {
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
    // What the smoke can't cover is named, with the rehearsal that does.
    expect(text).toMatch(/verif\w+ during a drop[^.]*rehearsal 1/i);
  });

  test("the release smoke checks the signature on SHA256SUMS with the stick's identity, and egress-v1", () => {
    const smoke = read('deploy/smoke.sh');
    expect(smoke).toContain('SHA256SUMS.sigstore.json');
    expect(smoke).toContain('verify-blob');
    expect(smoke).toContain(`--certificate-identity-regexp '${identityRegexp(REPOSITORY)}'`);
    expect(smoke).toContain(`--certificate-oidc-issuer ${GITHUB_ISSUER}`);
    expect(smoke).toContain('--certificate-github-workflow-trigger push');
    expect(smoke).toContain(`--certificate-github-workflow-repository ${REPOSITORY}`);
    expect(smoke).toMatch(/capabilities [^\n]*egress-v1/);
  });

  test('cosign_docker mounts only the two release files, read-only, never the install directory', () => {
    const block = /cosign_docker\(\) \{[\s\S]*?\n\}/.exec(read(INSTALL))?.[0] ?? '';
    expect(block).toContain('-v "$PWD/SHA256SUMS:/w/SHA256SUMS:ro"');
    expect(block).toContain('-v "$PWD/SHA256SUMS.sigstore.json:/w/SHA256SUMS.sigstore.json:ro"');
    expect(block.match(/-v /g)).toHaveLength(2);
    expect(block).not.toMatch(/\$PWD:/);
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

/** The fenced blocks of a markdown text, with their info string. */
const fences = (md: string): { lang: string; body: string }[] =>
  [...md.matchAll(/^(```|~~~)(\w*)[^\n]*\n([\s\S]*?)^\1[^\n]*$/gm)].map((m) => ({
    lang: m[2] as string,
    body: m[3] as string,
  }));

/** Shell commands in a block: continuation lines joined, comments and blank lines dropped. */
const commands = (body: string): string[] =>
  body
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

/** A section of a markdown text: from its heading to the next heading of the same or a higher level. */
function section(md: string, heading: RegExp): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? '#').length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0] ?? '').length <= level,
  );
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The `ctl` table operate.md carries, generated from the manifest. */
export function ctlTable(): string {
  const routesOf = (verb: string): string[] =>
    CONTROL_ROUTES.filter((r) =>
      [r.ctl, ...(r.also ?? [])].some((e) => e !== null && e.split(' ')[1] === verb),
    ).map((r) => `\`${r.method} ${r.path}\``);
  const rows = PAGES.flatMap((page) =>
    CTL_VERBS.filter((v) => v.page === page).map(
      (v) =>
        `| ${page} | ${v.forms.map((f) => `\`${f.replaceAll('|', '\\|')}\``).join('<br>')} | ${routesOf(v.verb).join('<br>')} |`,
    ),
  );
  return ['| Page | `ctl` | Route |', '|---|---|---|', ...rows].join('\n');
}

describe('M4.5 docs (Task 15)', () => {
  test("the README's prelude is at most six commands and names no .env, secrets/ or token file", () => {
    const quick = section(read('README.md'), /^## Quickstart/);
    const block = fences(quick)[0];
    expect(block?.lang).toMatch(/^(sh|bash)$/);
    const cmds = commands(block?.body ?? '');
    expect(cmds.length).toBeGreaterThanOrEqual(5);
    expect(cmds.length).toBeLessThanOrEqual(6);
    expect(cmds.join('\n')).not.toMatch(/\.env|secrets\/|_token|put /);
    expect(cmds[0]).toMatch(/^mkdir .* && cd /);
    expect(cmds[1]).toMatch(
      /compose\.yaml images\.lock\.json SHA256SUMS SHA256SUMS\.sigstore\.json/,
    );
    expect(cmds[2]).toMatch(/^cosign verify-blob /);
    expect(cmds[3]).toMatch(/^sha256sum -c SHA256SUMS/);
    expect(cmds[4]).toBe('docker compose up');
    // Then the browser: the setup code's line, the tunnel for a server, and the alternative.
    for (const t of [
      'JUMPMASTER SETUP CODE:',
      'http://127.0.0.1:7420',
      'ssh -L 7420:127.0.0.1:7420 <host>',
      'docker compose up -d',
      'docker compose logs -f jumpmaster',
      'jumpmaster ctl help',
    ])
      expect(quick, t).toContain(t);
    // The scripted install lives in the runbook.
    expect(quick).not.toContain('--profile init');
  });

  test('every ctl verb in the manifest appears in operate.md, whose ctl table is the manifest', () => {
    const text = read(OPERATE);
    for (const v of CTL_VERBS) expect(text, v.verb).toContain(`ctl ${v.verb}`);
    const at = text.indexOf('<!-- ctl-table:start -->');
    const end = text.indexOf('<!-- ctl-table:end -->');
    expect(at).toBeGreaterThan(0);
    expect(text.slice(at + '<!-- ctl-table:start -->'.length, end).trim()).toBe(ctlTable());
    expect(text).toContain('jumpmaster ctl help');
    expect(text).toContain('ctl <verb> --help');
  });

  test('every docs action anchor exists, and each troubleshooting entry names its action', () => {
    const md = read(INSTALL);
    const have = anchors(md);
    const zone = makeZone({ id: '<zone>', repo: 'your-org/your-repo' });
    const none: Pages = { zones: false, settings: false, credentials: false };
    const all: Pages = { zones: true, settings: true, credentials: true };
    for (const id of CHECK_IDS) {
      for (const pages of [none, all]) {
        const a = actionFor(
          { id, zoneId: '<zone>', status: 'fail', summary: 's' },
          { zone, pages },
        );
        if (a?.kind !== 'docs') continue;
        const [base, anchor] = a.href.split('#');
        expect(base, id).toBe(DOC.split('#')[0]);
        expect(have.has(anchor as string), `${id}: #${anchor}`).toBe(true);
      }
      // This build registers every page: its action is named in the entry, word for word.
      const a = actionFor(
        { id, zoneId: '<zone>', status: 'fail', summary: 's' },
        { zone, pages: all },
      );
      const entry = section(md, new RegExp(`^### \`${id.replace('.', '\\.')}\`$`));
      if (a && a.kind !== 'docs') expect(entry, id).toContain(`**Action:** ${a.label}`);
    }
  });

  test('SECURITY.md says why the setup code goes to stderr and that a forwarded log carries it until it is claimed', () => {
    const text = read('SECURITY.md').replace(/\s*\n\s*/g, ' ');
    for (const t of [
      'JUMPMASTER SETUP CODE:',
      "printed once per start on the server's stderr",
      'a log you forward elsewhere carries the code until it is claimed',
      'HttpOnly',
      'SameSite=Strict',
      'x-jm-csrf',
      'AES-256-GCM',
      'secrets/vault_key',
      '`data/` alone holds only ciphertext',
      'Guarded changes',
    ])
      expect(text, t).toContain(t);
  });

  test('the upgrade section names the three steps plus the login claim, and nothing else', () => {
    const up = section(read(INSTALL), /^## Upgrade/);
    const steps = [...up.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => m[2] as string);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/^\*\*Drain\.\*\*/);
    expect(steps[1]).toMatch(/^\*\*Replace `compose\.yaml`\.\*\*/);
    expect(steps[2]).toMatch(/^\*\*`docker compose up -d`\.\*\*/);
    expect(steps[3]).toMatch(/^\*\*Claim the login\.\*\*/);
    for (const t of [
      'may be deleted',
      'secrets/github_reviewer_token',
      'write the export to the config file before you downgrade',
      'returns to file mode with the file',
      'code owner review blocks the reviewer bot',
      '* @<reviewer-bot>',
    ])
      expect(up, t).toContain(t);
  });

  test('every export line in the runbooks carries exec -T, and every passphrase command reads it with read -rs', () => {
    let exports = 0;
    let passphrases = 0;
    for (const file of DOCS) {
      for (const f of fences(read(file)))
        for (const c of commands(f.body)) {
          if (/ctl config export\s*>/.test(c)) {
            exports++;
            expect(c, file).toContain('exec -T');
          }
          if (/ctl passphrase set/.test(c)) {
            passphrases++;
            expect(c, file).toMatch(
              /^read -rs JM_PASS && printf '%s' "\$JM_PASS" \| docker compose exec -T jumpmaster jumpmaster ctl passphrase set/,
            );
          }
        }
      for (const line of read(file).split('\n'))
        if (/ctl config export >/.test(line)) expect(line, file).toContain('exec -T');
    }
    expect(exports).toBeGreaterThanOrEqual(2);
    expect(passphrases).toBeGreaterThanOrEqual(2);
  });

  test("install.md quotes bootstrap's .env fix for a host whose uid is not 1000, and the gateCi order", () => {
    const text = read(INSTALL).replace(/\s*\n\s*/g, ' ');
    expect(text).toContain(ENV_FIX(false));
    expect(text).toMatch(/symlink/);
    expect(read(OPERATE).replace(/\s*\n\s*/g, ' ')).toContain(
      'Upgrade the sticks and the zone images before you set `gateCi: false`',
    );
  });

  test('the prelude says how to install a release candidate, and no doc names a particular tag or a diagnostics export', () => {
    const rc =
      'To install a release candidate (a prerelease, which `latest` skips), replace `latest/download` with `download/<tag>`.';
    for (const file of ['README.md', INSTALL]) {
      const text = read(file).replace(/\s*\n\s*/g, ' ');
      expect(text, file).toContain(rc);
    }
    for (const file of ['README.md', INSTALL, OPERATE, 'SECURITY.md']) {
      expect(read(file), file).not.toMatch(/rc\.1/);
      expect(read(file), file).not.toMatch(/diagnostics export/i);
    }
  });

  test("the upgrade says what bootstrap warns on the first start, and runs the download in the existing directory; SECURITY.md gives the audit table's size", () => {
    const up = section(read(INSTALL), /^## Upgrade/);
    expect(up.replace(/\s*\n\s*/g, ' ')).toContain(
      `jumpmaster bootstrap: warning: ${VAULT_KEY_WARNING}`,
    );
    expect(up).not.toMatch(/mkdir jumpmaster/);
    // Step 2's own commands (an indented fence inside the list), for the directory you are in.
    for (const cmd of [
      /^ {3}for f in compose\.yaml .*curl -fsSLO/m,
      /^ {3}cosign verify-blob /m,
      /^ {3}sha256sum -c SHA256SUMS/m,
    ])
      expect(up).toMatch(cmd);
    expect(read('SECURITY.md').replace(/\s*\n\s*/g, ' ')).toContain('keeps the latest 5000 rows');
  });
});
