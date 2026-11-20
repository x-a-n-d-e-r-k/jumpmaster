// The README and runbooks a stranger installs from: every link resolves, every anchor the code
// and docs point at exists (GitHub's heading slugs), every doctor check id has a troubleshooting
// entry, no image is named by tag, and the cosign commands match what the stick verifies.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CONTROL_ROUTES, CTL_VERBS, PAGES } from '../apps/server/src/api/manifest.js';
import { DELETE_OLD_KEY } from '../apps/server/src/api/secrets.js';
import { ENV_FIX, VAULT_KEY_WARNING } from '../apps/server/src/bootstrap.js';
import { STARTER_WARNING } from '../apps/server/src/config.js';
import { actionFor, type Pages } from '../apps/server/src/doctor/actions.js';
import { CHECK_IDS, DOC } from '../apps/server/src/doctor/checks.js';
import { makeZone } from '../apps/server/src/test/fixtures.js';
import { parseAppEntry } from '../apps/server/src/vault/github-app-entries.js';
import { healthLine } from '../apps/stick/src/state.js';
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

  test('Start at boot covers each host, and the from-source supervisors', () => {
    const md = read(INSTALL);
    const at = md.indexOf('\n## Start at boot\n');
    expect(at).toBeGreaterThan(0);
    const section = md.slice(at + 1, md.indexOf('\n## ', at + 1));
    for (const s of [
      'restart: unless-stopped',
      'systemctl enable',
      'Start Docker Desktop when you sign in',
      'Automatically log in as',
      // A foreground `up` ended with Ctrl+C is a manual stop: the services then stay down at boot.
      'Ctrl+C',
      'docker compose up -d',
      // Host-process installs: launchd, a systemd user unit kept alive without a login, Task Scheduler.
      '<key>KeepAlive</key>',
      'loginctl enable-linger',
      'schtasks',
    ])
      expect(section, s).toContain(s);
  });

  test('the M4.5 gate runbook states the bar and points at the session it measures', () => {
    const md = read('docs/runbooks/m4-5-gate.md');
    for (const s of [
      'at most 6 commands and 10 minutes',
      'zero file edits',
      'zero shell commands after `docker compose up`',
      'zero blocking questions',
      'under 60 minutes',
      'operate.md#the-operability-session',
      // The two assertions read from the stick's drop-start line.
      '"event":"drop-start"',
      'timeoutMinutes',
      'forgeToken',
      // Only the implement drop carries the author token; the review drop that follows does not.
      `grep '"role":"implement"'`,
      // Steps 4 and 5 need a drop: the author scripts a second issue after the revoke.
      'second issue',
      // M4's session is the baseline column.
      'Before (M4)',
      // The rerun rule and the two-part split.
      'That run counts only for the',
      'M4.5a gate is steps 1–3 and 7',
    ])
      expect(md, s).toContain(s);
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
  // A `# comment` inside a fenced block is not a heading.
  let fenced = false;
  const end = lines.findIndex((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    return i > start && !fenced && /^#+ /.test(l) && (l.match(/^#+/)?.[0] ?? '').length <= level;
  });
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
  test("the README's prelude downloads, verifies and starts, and names no .env, secrets/ or token file", () => {
    const quick = section(read('README.md'), /^## Quickstart/);
    const block = fences(quick)[0];
    expect(block?.lang).toMatch(/^(sh|bash)$/);
    const cmds = commands(block?.body ?? '');
    expect(cmds.join('\n')).not.toMatch(/\.env|secrets\/|_token|put /);
    const at = (re: RegExp) => cmds.findIndex((c) => re.test(c));
    const order = [
      at(/^setopt interactive_comments 2>\/dev\/null$/),
      at(/^VERSION=latest$/),
      at(/^if .*base=/),
      at(/^mkdir .* && cd /),
      at(/compose\.yaml images\.lock\.json SHA256SUMS SHA256SUMS\.sigstore\.json/),
      at(/^cosign verify-blob /),
      at(/^sha256sum -c SHA256SUMS/),
      at(/^docker compose up$/),
    ];
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cmds).toHaveLength(8);
    // Then the browser: the setup code's line, the tunnel for a server, and the alternative.
    for (const t of [
      'JUMPMASTER SETUP CODE:',
      'http://127.0.0.1:7420/setup',
      'ssh -L 7420:127.0.0.1:7420 <host>',
      'docker compose up -d',
      'the setup code is in `docker compose logs jumpmaster`',
      'jumpmaster ctl help',
    ])
      expect(quick.replace(/\s*\n\s*/g, ' '), t).toContain(t);
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
    const rc = 'for example VERSION=v0.4.0-rc.1';
    for (const file of ['README.md', INSTALL]) {
      const text = read(file);
      const flat = text.replace(/\s*\n\s*/g, ' ');
      expect(flat, file).not.toContain('replace `latest/download`');
      expect(flat, file).toContain(
        'A 404 here means there is no stable release yet: set VERSION to the newest tag on the releases page.',
      );
      expect(text, file).not.toContain('curl -fsSLO');
      expect(text, file).toContain(rc);
    }
    for (const file of ['README.md', INSTALL, OPERATE, 'SECURITY.md']) {
      // The one tag a doc names is the example of a release candidate's VERSION.
      expect(read(file).replaceAll(rc, ''), file).not.toMatch(/rc\.1/);
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
      /^ {3}for f in compose\.yaml .*curl -fSLO/m,
      /^ {3}cosign verify-blob /m,
      /^ {3}sha256sum -c SHA256SUMS/m,
    ])
      expect(up).toMatch(cmd);
    expect(read('SECURITY.md').replace(/\s*\n\s*/g, ' ')).toContain('keeps the latest 5000 rows');
  });
});

describe('push container docs (push-container Task 14)', () => {
  const flat = (md: string) => md.replace(/\s*\n\s*/g, ' ');

  test("install.md quotes the stick's own push-v1 health lines and the old-server refusal", () => {
    const md = read(INSTALL);
    const sticks = section(md, /^### Sticks$/);
    const ok = { ok: true as const };
    const big = 20 * 2 ** 30;
    for (const line of [
      healthLine({ selfCheck: true, freeBytes: big, base: ok }),
      healthLine({ selfCheck: false, freeBytes: big, base: ok }),
      healthLine({ selfCheck: true, freeBytes: null, base: ok }),
      healthLine({
        selfCheck: false,
        freeBytes: null,
        base: { ok: false, reason: 'base image <ref>: <reason>' },
      }),
      healthLine({ selfCheck: true, freeBytes: 1, base: ok }).replace('1 bytes', '<n> bytes'),
    ])
      expect(sticks, line).toContain(`\`${line}\``);
    const oldServer = /const OLD_SERVER = '([^']+)'/.exec(read('apps/stick/src/runner.ts'))?.[1];
    expect(oldServer).toBeDefined();
    expect(flat(sticks)).toContain(`\`${oldServer}\``);
    for (const s of ['**Deploy order.** Upgrade the server first', 'JM_ALLOWED_IMAGES', '10 GiB'])
      expect(flat(sticks), s).toContain(s);
  });

  test('operate.md covers pending pushes: retention, extension, cancel, the kill switch', () => {
    const pending = flat(section(read(OPERATE), /^## Pending pushes$/));
    for (const s of [
      'ctl drops extend-retention <dropId> <hours>',
      'ctl drops cancel <dropId>',
      '24 hours',
      '**Kill switch.**',
      'ctl unkill',
      'charged as a resume',
    ])
      expect(pending, s).toContain(s);
  });

  test('SECURITY.md describes the push container and the PAT-mode caveat', () => {
    const sec = flat(section(read('SECURITY.md'), /^## Where the write token goes$/));
    for (const s of [
      '**The token arrives last.**',
      '**The PAT-mode caveat.**',
      'GIT_NO_LAZY_FETCH=1',
      'githubReadToken',
    ])
      expect(sec, s).toContain(s);
  });

  test('the GitHub App spec §4.2 carries the corrections as built', () => {
    const spec = flat(
      section(
        read('docs/superpowers/specs/2026-11-13-github-app-auth.md'),
        /^### 4\.2 Installing, the broker and drops$/,
      ),
    );
    for (const s of [
      'docker.ts:585',
      '`leaseExpirer` already',
      'resolve never checkpoints',
      'not "as today"',
      '`Init: true`',
      'advertises `push-v1` on each lease',
      'the stick reads only the labels',
      '**Corrections as built**',
      'Ruling',
    ])
      expect(spec, s).toContain(s);
  });
});

describe('a first install from the docs (issue 160)', () => {
  const flat = (md: string) => md.replace(/\s*\n\s*/g, ' ');
  const FILES = ['compose.yaml', 'images.lock.json', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'];
  const BASE = `https://github.com/${REPOSITORY}/releases`;
  const quickBlock = () => fences(section(read('README.md'), /^## Quickstart/))[0]?.body ?? '';
  const step1Block = () =>
    fences(section(read(INSTALL), /^### Step 1: Download and verify the release/))[0]?.body ?? '';
  const upgradeBlock = () =>
    (
      section(read(INSTALL), /^## Upgrade/).match(/^ {3}```bash\n([\s\S]*?)^ {3}```$/m)?.[1] ?? ''
    ).replace(/^ {3}/gm, '');
  const has = (shell: string) => spawnSync(shell, ['-c', 'true']).status === 0;

  /** The block's lines up to its download loop, run in an empty directory with a stub curl. */
  function download(shell: string, body: string, version: string): string[] {
    const lines = body.split('\n');
    const loop = lines.findIndex((l) => l.startsWith('for f in compose.yaml'));
    expect(loop).toBeGreaterThan(0);
    const script = lines
      .slice(0, loop + 1)
      .map((l) => (l === 'VERSION=latest' ? `VERSION=${version}` : l))
      .join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'jm-quickstart-'));
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'work')]);
    writeFileSync(
      join(bin, 'curl'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nfor a; do u=$a; done\n: > "${u##*/}"\n',
    );
    chmodSync(join(bin, 'curl'), 0o755);
    const log = join(dir, 'curl.log');
    // zsh reads the paste line by line, as an interactive shell does, with its interactive default.
    const pre = shell === 'zsh' ? 'unsetopt interactive_comments\n' : '';
    const r = spawnSync(shell, shell === 'zsh' ? ['-f'] : [], {
      cwd: join(dir, 'work'),
      input: `${pre}${script}\n`,
      env: { PATH: `${bin}:${process.env.PATH}`, CURL_LOG: log, HOME: dir },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    for (const f of FILES)
      expect(
        existsSync(join(dir, 'work', 'jumpmaster', f)) || existsSync(join(dir, 'work', f)),
        f,
      ).toBe(true);
    return readFileSync(log, 'utf8').trim().split('\n');
  }

  test('the README block carries the VERSION switch and shows curl errors', () => {
    const block = quickBlock();
    expect(block).toContain('VERSION=latest');
    expect(block).toContain('releases/download/$VERSION/');
    expect(block).toContain('releases/latest/download/');
    expect(block).not.toContain('curl -fsSLO');
    expect(block).toContain('curl -fSLO');
    expect(block).toMatch(/^# .*latest.* skips pre-releases/m);
    expect(block).toMatch(/^sha256sum -c SHA256SUMS +# macOS: shasum -a 256 -c SHA256SUMS$/m);
  });

  for (const shell of ['bash', 'zsh'])
    test.skipIf(!has(shell))(
      `pasted into ${shell}, each download block fetches the four files for latest and for a tag`,
      () => {
        for (const [name, body] of [
          ['README', quickBlock()],
          ['install.md step 1', step1Block()],
          ['install.md upgrade', upgradeBlock()],
        ] as const) {
          const urls = (v: string) => download(shell, body, v).map((l) => l.split(' ').at(-1));
          expect(urls('latest'), name).toEqual(FILES.map((f) => `${BASE}/latest/download/${f}`));
          expect(urls('v0.4.0-rc.1'), name).toEqual(
            FILES.map((f) => `${BASE}/download/v0.4.0-rc.1/${f}`),
          );
          for (const l of download(shell, body, 'latest')) expect(l, name).toMatch(/^-fSLO /);
        }
      },
    );

  test('the README and install.md blocks are the same download and checks', () => {
    expect(step1Block()).toBe(quickBlock().replace(/\ndocker compose up\n$/, '\n'));
  });

  test('the README says how to verify without cosign, with the same cosign_docker install.md defines', () => {
    const quick = section(read('README.md'), /^## Quickstart/);
    const def = (md: string) => md.match(/^cosign_docker\(\) \{\n[\s\S]*?^\}$/m)?.[0];
    expect(quick).toMatch(/^\*\*No cosign\?\*\*/m);
    expect(def(quick)).toBeDefined();
    expect(def(quick)).toBe(def(section(read(INSTALL), /^### Step 1:/)));
    expect(flat(quick)).toContain('`cosign_docker` in place of `cosign`');
  });

  test('no doc counts the commands, and each names the address the server prints', () => {
    const steps = [2, 3].map((n) => section(read(INSTALL), new RegExp(`^### Step ${n}:`)));
    for (const [name, text] of [
      ['README', section(read('README.md'), /^## Quickstart/)],
      ['install.md step 2', steps[0] as string],
      ['install.md step 3', steps[1] as string],
    ] as const) {
      expect(text, name).toContain('http://127.0.0.1:7420/setup');
      expect(text.replaceAll('http://127.0.0.1:7420/setup', ''), name).not.toMatch(
        /https?:\/\/127\.0\.0\.1:7420/,
      );
    }
    for (const file of ['README.md', INSTALL])
      expect(flat(read(file)), file).not.toMatch(/\b(five|four|six) (shell )?commands\b/i);
  });

  test('both say where the passphrase step lands, and where the setup code is after up -d', () => {
    const quick = flat(section(read('README.md'), /^## Quickstart/));
    const step4 = flat(section(read(INSTALL), /^### Step 4:/));
    for (const text of [quick, step4]) {
      expect(text).toContain("the wizard's first step (Claude)");
      expect(text).toContain('**Finish setup**');
    }
    const logs = 'the setup code is in `docker compose logs jumpmaster`';
    expect(quick).toContain(logs);
    expect(flat(section(read(INSTALL), /^### Step 2:/))).toContain(logs);
    expect(flat(section(read(INSTALL), /^### Start, claim and check it/))).toContain(logs);
  });
});

describe('rotating a GitHub App private key (issue 504)', () => {
  const rotation = () => section(read(OPERATE), /^#### Rotating an app's private key$/);
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  test('operate.md has the rotation section, and drops "not covered here yet"', () => {
    expect(anchors(read(OPERATE))).toContain('rotating-an-apps-private-key');
    expect(read(OPERATE)).not.toContain('not covered here yet');
    const text = flat(rotation());
    for (const s of ['**Replace key**', '`ctl secrets reload`', 'delete the old key', '365 days'])
      expect(text, s).toContain(s);
    expect(text).toContain('](#kill-switch)');
  });

  test("the runbook and the server's DELETE_OLD_KEY hint agree where the old key is deleted", () => {
    expect(DELETE_OLD_KEY).toContain("the app's GitHub page, under Private keys");
    expect(flat(rotation())).toContain('**Private keys**');
    expect(flat(rotation())).toMatch(/delete the old key on the app's GitHub page/i);
  });

  test("SECURITY.md's private key section links to the rotation steps", () => {
    const key = flat(section(read('SECURITY.md'), /^### The GitHub App private key$/));
    expect(key).toContain('(docs/runbooks/operate.md#rotating-an-apps-private-key)');
    expect(key).toContain('**Replace key**');
    expect(key).toMatch(/no API/);
  });

  test("install.md's forge.author points at Replace key, not at importing the app again", () => {
    const author = flat(section(read(INSTALL), /^### `forge\.author`$/));
    expect(author).not.toContain('importing the app again with it');
    expect(author).toContain('**Replace key**');
    expect(author).toContain('(operate.md#rotating-an-apps-private-key)');
    // The wrong-app and slug-mismatch bullets stay.
    expect(author).toContain("the key belongs to another app than the entry's: re-import the app");
    expect(author).toContain("add the old login to the zone's `authorLoginAliases`");
  });

  const fileSourced = () => {
    const text = flat(rotation());
    const start = text.indexOf('**A file-sourced entry**');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('**From a script.**', start);
    return text.slice(start, end === -1 ? undefined : end);
  };

  test('the file-sourced steps set importedAt, which the key-age warning reads', () => {
    const file = fileSourced();
    expect(file).toContain('`importedAt`');
    expect(file).toContain('`pem`');
    expect(file).toMatch(/\\n/);
    expect(file).toMatch(/JSON/);
    expect(file).toMatch(/key-age warning/);
    expect(file).toContain('0600');
    expect(file).toContain('`ctl secrets reload`');
    // One copy-paste command that builds the values from the downloaded .pem without echoing it.
    expect(file).toContain('--rawfile pem');
    expect(file).toMatch(/umask 077/);
    expect(file).not.toMatch(/\bcat\b|\becho\b/);
  });

  test('the fields the file-sourced steps name are fields parseAppEntry requires', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const good = {
      appId: '123456',
      slug: 'acme-jumpmaster-author',
      clientId: 'Iv23liClientId0001',
      pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      importedAt: '2026-11-15T10:00:00.000Z',
    };
    expect(parseAppEntry(JSON.stringify(good)).importedAt).toBe(good.importedAt);
    const file = fileSourced();
    for (const f of ['pem', 'importedAt'] as const) {
      const { [f]: _dropped, ...rest } = good;
      expect(() => parseAppEntry(JSON.stringify(rest)), f).toThrow(`field ${f} is missing`);
      expect(file, f).toContain(`\`${f}\``);
    }
    // The doctor's key-age check reads the same field.
    const checks = read('apps/server/src/doctor/checks.ts');
    expect(checks).toContain('Date.parse(entry.importedAt)');
  });

  test('the rotation docs show no key or token literal', () => {
    for (const text of [
      rotation(),
      section(read('SECURITY.md'), /^### The GitHub App private key$/),
    ])
      expect(text).not.toMatch(
        /-----BEGIN|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_|MII[A-Za-z0-9+/]{8,}/,
      );
  });
});
