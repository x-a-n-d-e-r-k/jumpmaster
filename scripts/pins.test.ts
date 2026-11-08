// The pin policy, as one generic scan of the repository (plan: Global Constraints, "Pinning").
// - Every image reference in images/**, deploy/** and .github/workflows/** is an @sha256 digest.
// - Every `uses:` names a full 40-hex commit SHA.
// - Every downloaded binary in a Dockerfile has a checksum check within three lines.
// - Every npm dependency added after the pre-M4 snapshot is an exact version.
// The 14-day age rule is a PR checklist line, not a test.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { LOCAL_IMAGE_FILES, walk } from './repo-files.js';

export type Finding = { file: string; line: number; message: string };

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const IS_DIGEST = /@sha256:[0-9a-f]{64}$/;
const IS_SHA = /@[0-9a-f]{40}$/;
const CHECKSUM = /sha256sum\s+-c|sha512sum\s+-c|--checksum/;
const unquote = (s: string): string => s.replace(/^['"]|['"]$/g, '');

export function scanDockerfile(
  file: string,
  text: string,
  local: typeof LOCAL_IMAGE_FILES = LOCAL_IMAGE_FILES,
): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  const stages = new Set<string>();
  const report = (index: number, message: string) =>
    findings.push({ file, line: index + 1, message });
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      const ref = from[1] as string;
      const allowedLocal = local[file]?.image === ref;
      // `${BASE}` resolves from an ARG whose default is checked below; `scratch` is no image.
      if (!ref.includes('$') && ref !== 'scratch' && !stages.has(ref.toLowerCase())) {
        if (!IS_DIGEST.test(ref) && !allowedLocal)
          report(i, `FROM ${ref} is not pinned by @sha256 digest`);
      }
      if (from[2]) stages.add(from[2].toLowerCase());
    }
    const copy = /^COPY\s+(?:.*\s)?--from=(\S+)/i.exec(line);
    if (copy) {
      const ref = copy[1] as string;
      if (!/^\d+$/.test(ref) && !stages.has(ref.toLowerCase()) && !IS_DIGEST.test(ref))
        report(i, `COPY --from=${ref} is neither a build stage nor an @sha256 digest`);
    }
    const arg = /^ARG\s+(BASE|[A-Z0-9_]*_IMAGE)=(\S+)/.exec(line);
    if (arg && !IS_DIGEST.test(unquote(arg[2] as string)))
      report(i, `ARG ${arg[1]} default is not an @sha256 digest`);
    if (/^ADD\s+(?:.*\s)?https?:\/\//i.test(line)) {
      // --checksum is a flag of this ADD; a later instruction's flag doesn't cover it.
      if (!/\s--checksum=sha(256|384|512):/.test(line))
        report(i, 'ADD of a URL without --checksum=sha256:… on the same instruction');
    } else if (/\b(curl|wget)\b/.test(line) && /https?:\/\//.test(line)) {
      const window = lines.slice(i, i + 4).join('\n');
      if (!CHECKSUM.test(window))
        report(i, 'download without sha256sum -c, sha512sum -c or --checksum within three lines');
    }
  });
  return findings;
}

export function scanYaml(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#')) return;
    const uses = /^(?:-\s+)?uses:\s*(\S+)/.exec(line);
    if (uses) {
      const ref = unquote(uses[1] as string);
      if (ref.startsWith('docker://')) {
        if (!IS_DIGEST.test(ref))
          findings.push({ file, line: i + 1, message: `uses: ${ref} is not an @sha256 digest` });
      } else if (!ref.startsWith('./') && !IS_SHA.test(ref)) {
        findings.push({
          file,
          line: i + 1,
          message: `uses: ${ref} is not a full 40-hex commit SHA`,
        });
      }
    }
    const image = /^(?:-\s+)?image:\s*(\S+)/.exec(line);
    if (image) {
      const ref = unquote(image[1] as string);
      // A ${VAR:-default} placeholder is the operator's override; its default is checked by the
      // compose tests that render it.
      if (!ref.includes('${') && !IS_DIGEST.test(ref))
        findings.push({ file, line: i + 1, message: `image: ${ref} is not an @sha256 digest` });
    }
  });
  return findings;
}

export type PackageFile = { file: string; json: Record<string, unknown> };

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export function scanPackages(
  packages: PackageFile[],
  snapshot: Record<string, string[]>,
): Finding[] {
  const workspace = new Set(packages.map((p) => p.json.name).filter((n) => typeof n === 'string'));
  const findings: Finding[] = [];
  for (const { file, json } of packages) {
    const before = new Set(snapshot[file] ?? []);
    for (const field of DEP_FIELDS) {
      const deps = (json[field] ?? {}) as Record<string, string>;
      for (const [name, version] of Object.entries(deps)) {
        if (before.has(name) || workspace.has(name) || EXACT.test(version)) continue;
        findings.push({
          file,
          line: 0,
          message: `${field}.${name} is "${version}"; a new dependency needs an exact version`,
        });
      }
    }
  }
  return findings;
}

const isDockerfile = (path: string): boolean => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base === 'Dockerfile' || base.startsWith('Dockerfile.') || base.endsWith('.Dockerfile');
};

export function scanRepo(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const file of walk(root, ['images', 'deploy', '.github/workflows'])) {
    const text = () => readFileSync(join(root, file), 'utf8');
    if (isDockerfile(file)) findings.push(...scanDockerfile(file, text()));
    else if (/\.ya?ml$/.test(file)) findings.push(...scanYaml(file, text()));
  }
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const pkgFiles = ['package.json'];
  for (const pattern of rootPkg.workspaces ?? []) {
    const dir = pattern.replace(/\/\*$/, '');
    for (const name of readdirSync(join(root, dir))) {
      const file = `${dir}/${name}/package.json`;
      try {
        statSync(join(root, file));
        pkgFiles.push(file);
      } catch {
        // A directory without a package.json is not a workspace.
      }
    }
  }
  const snapshot = JSON.parse(
    readFileSync(join(root, 'scripts/fixtures/pre-m4-deps.json'), 'utf8'),
  ) as Record<string, string[]>;
  findings.push(
    ...scanPackages(
      pkgFiles.map((file) => ({
        file,
        json: JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>,
      })),
      snapshot,
    ),
  );
  return findings;
}

const DIGEST = `node:24-bookworm-slim@sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);

describe('pin scan', () => {
  test('a FROM, COPY --from or ARG image default without @sha256 is reported with file and line', () => {
    const text = [
      `FROM ${DIGEST} AS build`,
      'FROM node:24-bookworm-slim',
      'COPY --from=build /out /opt/x',
      'COPY --from=alpine:3.20 /bin/sh /bin/sh',
      `COPY --from=${DIGEST} /x /x`,
      'ARG BASE=node:24',
      'ARG TOOL_IMAGE=ghcr.io/o/tool:1',
      `ARG BASE_IMAGE=${DIGEST}`,
      'FROM ${BASE}',
      'FROM jumpmaster-trooper:dev',
      'FROM --platform=linux/amd64 debian:12',
      '# FROM commented:out',
    ].join('\n');
    expect(scanDockerfile('images/x/Dockerfile', text)).toEqual([
      { file: 'images/x/Dockerfile', line: 2, message: expect.stringMatching(/FROM.*digest/) },
      {
        file: 'images/x/Dockerfile',
        line: 4,
        message: expect.stringMatching(/COPY --from.*digest/),
      },
      { file: 'images/x/Dockerfile', line: 6, message: expect.stringMatching(/ARG BASE.*digest/) },
      { file: 'images/x/Dockerfile', line: 7, message: expect.stringMatching(/ARG TOOL_IMAGE/) },
      { file: 'images/x/Dockerfile', line: 10, message: expect.stringMatching(/FROM.*digest/) },
      { file: 'images/x/Dockerfile', line: 11, message: expect.stringMatching(/FROM.*digest/) },
    ]);
  });

  test('a build-stage reference passes; an unlisted local tag fails; a listed file may use only its image', () => {
    const stage = `FROM ${DIGEST} AS Build\nCOPY --from=build /a /a\nCOPY --from=0 /b /b\n`;
    expect(scanDockerfile('images/a/Dockerfile', stage)).toEqual([]);
    // A stage name used before it is declared is not a stage yet.
    expect(
      scanDockerfile('images/a/Dockerfile', `COPY --from=later /a /a\nFROM ${DIGEST} AS later`),
    ).toHaveLength(1);
    const local = 'FROM jumpmaster-trooper:dev\n';
    expect(scanDockerfile('images/trooper/e2e/Dockerfile', local)).toEqual([]);
    expect(scanDockerfile('images/other/Dockerfile', local)).toHaveLength(1);
    expect(
      scanDockerfile('images/trooper/e2e/Dockerfile', 'FROM jumpmaster-stick:dev\n'),
    ).toHaveLength(1);
    for (const entry of Object.values(LOCAL_IMAGE_FILES))
      expect(entry.reason.length).toBeGreaterThan(10);
  });

  test('a uses: on a tag or short SHA is reported', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      `      - uses: actions/checkout@${SHA} # v7`,
      '      - uses: actions/checkout@v4',
      `      - uses: actions/checkout@${SHA.slice(0, 7)}`,
      '      - uses: ./.github/actions/local',
      `      - uses: docker://alpine:3.20`,
      `      - uses: 'actions/setup-node@${SHA}'`,
      '    container:',
      '      image: node:24',
      '    services:',
      '      db:',
      `        image: "postgres@sha256:${'c'.repeat(64)}"`,
      '      # uses: actions/checkout@v1',
    ].join('\n');
    expect(scanYaml('.github/workflows/x.yml', text)).toEqual([
      { file: '.github/workflows/x.yml', line: 5, message: expect.stringMatching(/uses:.*SHA/) },
      { file: '.github/workflows/x.yml', line: 6, message: expect.stringMatching(/uses:.*SHA/) },
      { file: '.github/workflows/x.yml', line: 8, message: expect.stringMatching(/digest/) },
      {
        file: '.github/workflows/x.yml',
        line: 11,
        message: expect.stringMatching(/image:.*digest/),
      },
    ]);
  });

  test('a compose image: outside a ${…} placeholder must be a digest', () => {
    const text = [
      'services:',
      '  jumpmaster:',
      '    image: ${JM_SERVER_IMAGE:-ghcr.io/o/server@sha256:' + 'd'.repeat(64) + '}',
      '  stick:',
      '    image: ghcr.io/o/stick:latest',
      '  egress:',
      `    image: ghcr.io/o/egress@sha256:${'e'.repeat(64)}`,
    ].join('\n');
    expect(scanYaml('deploy/compose.yml', text)).toEqual([
      { file: 'deploy/compose.yml', line: 5, message: expect.stringMatching(/image:.*digest/) },
    ]);
  });

  test('a download line without a checksum within three lines is reported', () => {
    const text = [
      `FROM ${DIGEST}`,
      'RUN curl -fsSLo /tmp/cosign https://example.test/cosign \\',
      ' && echo "abc  /tmp/cosign" | sha256sum -c - \\',
      ' && install /tmp/cosign /usr/local/bin/cosign',
      'RUN wget -q https://example.test/uv.tgz -O /tmp/uv.tgz',
      'RUN true',
      'RUN true',
      'RUN true',
      'RUN echo "x  /tmp/uv.tgz" | sha256sum -c -',
      'ADD https://example.test/a.tgz /tmp/a.tgz',
      'ADD --checksum=sha256:abc https://example.test/b.tgz /tmp/b.tgz',
      'RUN curl -fsSL https://example.test/c -o /tmp/c && sha512sum -c /tmp/c.sha512',
      'RUN curl --version',
    ].join('\n');
    expect(scanDockerfile('images/x/Dockerfile', text)).toEqual([
      { file: 'images/x/Dockerfile', line: 5, message: expect.stringMatching(/checksum/) },
      { file: 'images/x/Dockerfile', line: 10, message: expect.stringMatching(/checksum/) },
    ]);
  });

  test('a new npm dependency with ^ or ~ is reported; a pre-M4 caret dependency is not', () => {
    const packages: PackageFile[] = [
      {
        file: 'apps/server/package.json',
        json: {
          name: '@jumpmaster/server',
          dependencies: { fastify: '^5.12.7', 'left-pad': '^1.3.0', '@jumpmaster/protocol': '*' },
          devDependencies: { nock: '^14.0.17', tilde: '~2.0.0', exact: '1.2.3', pre: '1.0.0-rc.1' },
        },
      },
      {
        file: 'apps/egress/package.json',
        json: {
          name: '@jumpmaster/egress',
          dependencies: { fastify: '^5.12.7', '@jumpmaster/protocol': '*' },
          optionalDependencies: { star: '*', latest: 'latest' },
        },
      },
      { file: 'packages/protocol/package.json', json: { name: '@jumpmaster/protocol' } },
    ];
    const snapshot = { 'apps/server/package.json': ['fastify', 'nock', '@jumpmaster/protocol'] };
    expect(scanPackages(packages, snapshot).map((f) => [f.file, f.message])).toEqual([
      ['apps/server/package.json', expect.stringMatching(/left-pad.*exact/)],
      ['apps/server/package.json', expect.stringMatching(/tilde.*exact/)],
      // A pre-M4 name in another package is still new there.
      ['apps/egress/package.json', expect.stringMatching(/fastify.*exact/)],
      ['apps/egress/package.json', expect.stringMatching(/star.*exact/)],
      ['apps/egress/package.json', expect.stringMatching(/latest.*exact/)],
    ]);
  });

  test('the pre-M4 snapshot names only dependencies that existed when it was taken', () => {
    const snapshot = JSON.parse(
      readFileSync(join(ROOT, 'scripts/fixtures/pre-m4-deps.json'), 'utf8'),
    ) as Record<string, string[]>;
    expect(snapshot['apps/server/package.json']).toContain('fastify');
    expect(snapshot['package.json']).toEqual(['@biomejs/biome', 'typescript', 'vitest']);
    expect(Object.keys(snapshot).sort()).toEqual([
      'apps/server/package.json',
      'apps/stick/package.json',
      'apps/trooper/package.json',
      'package.json',
      'packages/protocol/package.json',
    ]);
  });

  test('dependabot watches the images and the PR template carries the age rule', () => {
    const dependabot = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');
    expect(dependabot).toMatch(/package-ecosystem: docker\n\s+directories:\n\s+- "\/images\/\*"/);
    const template = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
    expect(template).toContain(
      'new dependencies: exact pin, version and release date ≥14 days old recorded in the commit',
    );
  });

  test('the repository passes the scan', () => {
    const findings = scanRepo(ROOT);
    expect(findings).toEqual([]);
  });

  test('the repository scan reads the files it claims to', () => {
    // Guards against a scan that silently finds nothing: the shipped trooper Dockerfile and CI
    // workflow are in scope, and a planted bad line in either would be reported.
    const files = walk(ROOT, ['images', 'deploy', '.github/workflows']);
    expect(files).toContain('images/trooper/Dockerfile');
    expect(files).toContain('.github/workflows/ci.yml');
  });
});
