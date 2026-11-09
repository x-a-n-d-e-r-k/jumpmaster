// scripts/release-index.sh, run with a fake `docker` on PATH. The fake answers
// `imagetools create --dry-run` with a given index, `imagetools inspect <ref> --raw` from a small
// byte store, and records every call. images.yml also runs the real script against a job-local
// registry on two real per-arch builds (the release-index job).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/release-index.sh');
const d = (c: string) => `sha256:${c.repeat(64)}`;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const REG = 'ghcr.io/o';
const NAME = 'jumpmaster-trooper';
const IMG = 'application/vnd.oci.image.manifest.v1+json';

type Entry = { mediaType: string; digest: string; platform: { os: string; architecture: string } };
const image = (arch: string, digest: string): Entry => ({
  mediaType: IMG,
  digest,
  platform: { os: 'linux', architecture: arch },
});
const attestation = (digest: string): Entry => ({
  mediaType: IMG,
  digest,
  platform: { os: 'unknown', architecture: 'unknown' },
});
const index = (manifests: Entry[]) =>
  JSON.stringify(
    { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests },
    null,
    2,
  );

/** The two per-arch builds (each an index of its image and attestation) and their join. */
const AMD_BUILD = index([image('amd64', d('a')), attestation(d('b'))]);
const ARM_BUILD = index([image('arm64', d('c')), attestation(d('e'))]);
const JOINED = index([
  image('amd64', d('a')),
  attestation(d('b')),
  image('arm64', d('c')),
  attestation(d('e')),
]);

function run(o: {
  release: boolean;
  amd64?: Record<string, string> | null;
  arm64?: Record<string, string> | null;
  /** What `create --dry-run` prints (buildx ends it with a newline). */
  dry?: string;
  /** Bytes `inspect --raw` serves per ref; the joined index is stored under its digest. */
  store?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-index-'));
  mkdirSync(join(dir, 'digests'));
  mkdirSync(join(dir, 'bin'));
  const amd = o.amd64 === undefined ? { [NAME]: d('1') } : o.amd64;
  const arm = o.arm64 === undefined ? { [NAME]: d('2') } : o.arm64;
  if (amd) writeFileSync(join(dir, 'digests/t-amd64.json'), JSON.stringify(amd));
  if (arm) writeFileSync(join(dir, 'digests/t-arm64.json'), JSON.stringify(arm));
  const dry = o.dry ?? JOINED;
  const store = o.store ?? {
    [`${REG}/${NAME}@${d('1')}`]: AMD_BUILD,
    [`${REG}/${NAME}@${d('2')}`]: ARM_BUILD,
    [`${REG}/${NAME}@${sha(dry)}`]: dry,
  };
  writeFileSync(join(dir, 'dry.json'), `${dry}\n`);
  writeFileSync(join(dir, 'store.json'), JSON.stringify(store));
  writeFileSync(
    join(dir, 'bin/docker'),
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "buildx imagetools create --dry-run "*) cat "${dir}/dry.json" ;;
  "buildx imagetools create "*) exit 0 ;;
  "buildx imagetools inspect "*" --raw") jq -j --arg r "$4" '.[$r] // error("no manifest")' "${dir}/store.json" ;;
  *) echo "unexpected docker $*" >&2; exit 9 ;;
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
  return {
    status: r.status,
    stdout: r.stdout + r.stderr,
    out: read('out'),
    calls: read('calls').trim().split('\n').filter(Boolean),
  };
}

describe('release-index.sh', () => {
  test('a release joins both arches by digest and outputs the digest of exactly that index', () => {
    const r = run({ release: true });
    expect(r.status, r.stdout).toBe(0);
    expect(r.out).toBe(`${NAME}=${sha(JOINED)}\n`);
    const create = `-t ${REG}/${NAME}:v0.4.0-rc.1 ${REG}/${NAME}@${d('1')} ${REG}/${NAME}@${d('2')}`;
    expect(r.calls).toContain(`buildx imagetools create --dry-run ${create}`);
    expect(r.calls).toContain(`buildx imagetools create ${create}`);
    // The digest is never read back through the mutable tag: only by digest.
    for (const c of r.calls.filter((c) => c.includes('inspect')))
      expect(c, c).toMatch(/@sha256:[0-9a-f]{64} --raw$/);
    expect(r.calls).toContain(`buildx imagetools inspect ${REG}/${NAME}@${sha(JOINED)} --raw`);
  });

  test('an index that is not exactly every manifest the two builds made is refused, attestations included', () => {
    const cases: [string, string][] = [
      ['one arch only', index([image('amd64', d('a')), attestation(d('b'))])],
      [
        'another image for arm64',
        index([
          image('amd64', d('a')),
          attestation(d('b')),
          image('arm64', d('f')),
          attestation(d('e')),
        ]),
      ],
      ['a third platform', index([...JSON.parse(JOINED).manifests, image('s390x', d('7'))])],
      // The reviewer's probes: a substituted attestation and an extra unknown/unknown manifest.
      [
        'a substituted attestation',
        index([
          image('amd64', d('a')),
          attestation(d('6')),
          image('arm64', d('c')),
          attestation(d('e')),
        ]),
      ],
      ['an extra attestation', index([...JSON.parse(JOINED).manifests, attestation(d('8'))])],
      [
        'an entry without a platform',
        index([...JSON.parse(JOINED).manifests, { mediaType: IMG, digest: d('5') } as Entry]),
      ],
      [
        'a different media type',
        index([
          { ...image('amd64', d('a')), mediaType: 'x' },
          attestation(d('b')),
          image('arm64', d('c')),
          attestation(d('e')),
        ]),
      ],
    ];
    for (const [label, dry] of cases) {
      const r = run({ release: true, dry });
      expect(r.status, label).not.toBe(0);
      expect(r.out, label).toBe('');
      // Refused before anything is pushed.
      expect(
        r.calls.some((c) => c.startsWith('buildx imagetools create -t')),
        label,
      ).toBe(false);
    }
  });

  test('what the registry serves at the digest must be that index, byte for byte', () => {
    const store = {
      [`${REG}/${NAME}@${d('1')}`]: AMD_BUILD,
      [`${REG}/${NAME}@${d('2')}`]: ARM_BUILD,
      // Same manifests, different bytes: not the index whose digest is output.
      [`${REG}/${NAME}@${sha(JOINED)}`]: JSON.stringify(JSON.parse(JOINED)),
    };
    const r = run({ release: true, store });
    expect(r.status).not.toBe(0);
    expect(r.out).toBe('');
    const missing = run({
      release: true,
      store: { [`${REG}/${NAME}@${d('1')}`]: AMD_BUILD, [`${REG}/${NAME}@${d('2')}`]: ARM_BUILD },
    });
    expect(missing.status).not.toBe(0);
  });

  test('a per-arch build that is not the arch it claims is refused', () => {
    const store = {
      [`${REG}/${NAME}@${d('1')}`]: AMD_BUILD,
      [`${REG}/${NAME}@${d('2')}`]: index([image('amd64', d('c')), attestation(d('e'))]),
      [`${REG}/${NAME}@${sha(JOINED)}`]: JOINED,
    };
    expect(run({ release: true, store }).status).not.toBe(0);
  });

  test('a missing arch, a malformed digest or mismatched image sets refuse before any docker call', () => {
    for (const o of [
      { arm64: null },
      { arm64: { [NAME]: 'latest' } },
      { arm64: { 'jumpmaster-egress': d('2') } },
      { amd64: { 'evil;rm': d('1') }, arm64: { 'evil;rm': d('2') } },
    ]) {
      const r = run({ release: true, ...o });
      expect(r.status, JSON.stringify(o)).not.toBe(0);
      expect(r.calls, JSON.stringify(o)).toEqual([]);
    }
  });

  test('a dry run creates no index and passes the amd64 digests through', () => {
    const r = run({ release: false });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toBe(`${NAME}=${d('1')}\n`);
    expect(r.stdout).toContain(`::notice::dry run: no index for ${NAME}`);
  });
});
