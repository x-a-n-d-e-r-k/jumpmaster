// scripts/release-index.sh, run with a fake `docker` on PATH. The fake answers `imagetools
// inspect` from a small manifest store and records every call. The real script was also run once
// against a local registry with two real per-arch builds (see m4d-report.md).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/release-index.sh');
const d = (c: string) => `sha256:${c.repeat(64)}`;
const REG = 'ghcr.io/o';

/** A per-arch build: an index of one image manifest and its attestation manifest. */
const perArch = (arch: string, image: string, att: string) => ({
  manifests: [
    { digest: image, platform: { os: 'linux', architecture: arch } },
    { digest: att, platform: { os: 'unknown', architecture: 'unknown' } },
  ],
});

function run(o: {
  release: boolean;
  amd64?: Record<string, string>;
  arm64?: Record<string, string>;
  /** What `inspect --raw` returns for each ref (the created index under its index digest). */
  store?: Record<string, unknown>;
  indexDigest?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-index-'));
  mkdirSync(join(dir, 'digests'));
  mkdirSync(join(dir, 'bin'));
  if (o.amd64) writeFileSync(join(dir, 'digests/t-amd64.json'), JSON.stringify(o.amd64));
  if (o.arm64) writeFileSync(join(dir, 'digests/t-arm64.json'), JSON.stringify(o.arm64));
  writeFileSync(join(dir, 'store.json'), JSON.stringify(o.store ?? {}));
  // The fake docker: logs its args; `inspect … --format` prints the index digest, `--raw`
  // prints the stored manifest for the ref.
  writeFileSync(
    join(dir, 'bin/docker'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "buildx imagetools create "*) exit 0 ;;
  *"--format"*) printf '{"digest":"%s"}\\n' "${o.indexDigest ?? ''}" ;;
  *"--raw"*) ref="$4"; jq -c --arg r "$ref" '.[$r] // empty' "${dir}/store.json" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'out'), '');
  const r = spawnSync('bash', ['--norc', '--noprofile', SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      GROUP: 't',
      REGISTRY: REG,
      VERSION: '0.4.0-rc.1',
      RELEASE: String(o.release),
      GITHUB_OUTPUT: join(dir, 'out'),
    },
  });
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: r.status, stdout: r.stdout, out: read('out'), calls: read('calls') };
}

const AMD = { 'jumpmaster-trooper': d('1') };
const ARM = { 'jumpmaster-trooper': d('2') };
const INDEX = d('9');
const goodStore = (index: unknown) => ({
  [`${REG}/jumpmaster-trooper@${d('1')}`]: perArch('amd64', d('a'), d('b')),
  [`${REG}/jumpmaster-trooper@${d('2')}`]: perArch('arm64', d('c'), d('e')),
  [`${REG}/jumpmaster-trooper@${INDEX}`]: index,
});
const joined = {
  manifests: [
    ...perArch('amd64', d('a'), d('b')).manifests,
    ...perArch('arm64', d('c'), d('e')).manifests,
  ],
};

describe('release-index.sh', () => {
  test('a release joins both arches by digest and outputs the index digest', () => {
    const r = run({
      release: true,
      amd64: AMD,
      arm64: ARM,
      store: goodStore(joined),
      indexDigest: INDEX,
    });
    expect(r.status, r.stdout).toBe(0);
    expect(r.out).toBe(`jumpmaster-trooper=${INDEX}\n`);
    expect(r.calls.split('\n')[0]).toBe(
      `buildx imagetools create -t ${REG}/jumpmaster-trooper:v0.4.0-rc.1 ${REG}/jumpmaster-trooper@${d('1')} ${REG}/jumpmaster-trooper@${d('2')}`,
    );
  });

  test('an index that is not exactly the two builds just made is refused', () => {
    const cases: [string, unknown][] = [
      ['one arch only', { manifests: perArch('amd64', d('a'), d('b')).manifests }],
      [
        'another image for arm64',
        {
          manifests: [
            ...perArch('amd64', d('a'), d('b')).manifests,
            ...perArch('arm64', d('f'), d('e')).manifests,
          ],
        },
      ],
      [
        'a third platform',
        {
          manifests: [
            ...joined.manifests,
            { digest: d('7'), platform: { os: 'linux', architecture: 's390x' } },
          ],
        },
      ],
    ];
    for (const [label, index] of cases) {
      const r = run({
        release: true,
        amd64: AMD,
        arm64: ARM,
        store: goodStore(index),
        indexDigest: INDEX,
      });
      expect(r.status, label).not.toBe(0);
      expect(r.out, label).toBe('');
    }
    // The per-arch builds themselves must be the arch they claim.
    const swapped = {
      ...goodStore(joined),
      [`${REG}/jumpmaster-trooper@${d('2')}`]: perArch('amd64', d('c'), d('e')),
    };
    expect(
      run({ release: true, amd64: AMD, arm64: ARM, store: swapped, indexDigest: INDEX }).status,
    ).not.toBe(0);
    // No digest back from the registry.
    expect(
      run({ release: true, amd64: AMD, arm64: ARM, store: goodStore(joined), indexDigest: 'null' })
        .status,
    ).not.toBe(0);
  });

  test('a missing arch, a malformed digest or mismatched image sets refuse before any docker call', () => {
    for (const o of [
      { amd64: AMD },
      { amd64: AMD, arm64: { 'jumpmaster-trooper': 'latest' } },
      { amd64: AMD, arm64: { 'jumpmaster-egress': d('2') } },
      { amd64: { 'evil;rm': d('1') }, arm64: { 'evil;rm': d('2') } },
    ]) {
      const r = run({ release: true, ...o, store: goodStore(joined), indexDigest: INDEX });
      expect(r.status, JSON.stringify(o)).not.toBe(0);
      expect(r.calls, JSON.stringify(o)).toBe('');
    }
  });

  test('a dry run creates no index and passes the amd64 digests through', () => {
    const r = run({ release: false, amd64: AMD, arm64: ARM });
    expect(r.status).toBe(0);
    expect(r.calls).toBe('');
    expect(r.out).toBe(`jumpmaster-trooper=${d('1')}\n`);
    expect(r.stdout).toContain('::notice::dry run: no index for jumpmaster-trooper');
  });
});
