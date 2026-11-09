// Stack presets: which prebuilt trooper image a zone runs, which hosts its installs reach, and the
// gates `init` and the doctor propose from the repository's root files. Detection runs once, on
// the default branch, never at dispatch: the gates it proposes are written into the config, and
// repository content is data here, never instructions.
import { existsSync, readFileSync } from 'node:fs';
import type { GateSpec, Preset } from '@jumpmaster/protocol';
import { PRESETS } from '@jumpmaster/protocol';

/** Hosts a preset's installs and toolchain downloads reach, for the egress allow-list. */
export const PRESET_EGRESS: Record<Preset, string[]> = {
  // node-gyp fetches headers from nodejs.org; prebuilt binaries come from GitHub release assets.
  node: [
    'registry.npmjs.org',
    'nodejs.org',
    'objects.githubusercontent.com',
    'codeload.github.com',
  ],
  // uv-managed Pythons are GitHub release assets.
  python: ['pypi.org', 'files.pythonhosted.org', 'objects.githubusercontent.com'],
  // The image sets GOTOOLCHAIN=local, so no toolchain download (those come from
  // storage.googleapis.com, a generic object store that takes anonymous writes to any bucket that
  // allows them: never allow-list it). A repository needing a newer Go fails loudly instead.
  go: ['proxy.golang.org', 'sum.golang.org'],
  jvm: [
    'repo.maven.apache.org',
    'repo1.maven.org',
    'services.gradle.org',
    'plugins.gradle.org',
    'downloads.gradle.org',
    'plugins-artifacts.gradle.org',
  ],
};

/** The Pythons the python preset ships: Debian's python3 and one installed by uv at build. */
export const SHIPPED_PYTHONS = ['3.11.2', '3.12.15'] as const;

/** Image name to its index digest (`sha256:…`). */
export type ImageLock = Record<string, string>;
/** The release's lock file: the registry the images live in, and their digests. */
export type ImageLockFile = { registry: string; images: ImageLock };

export const IMAGE_LOCK_PATH = '/app/images.lock.json';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REGISTRY = /^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*$/;

/** The release lock, or undefined when the file is absent. A malformed lock stops startup. */
export function loadImageLock(path: string = IMAGE_LOCK_PATH): ImageLockFile | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`image lock ${path} does not parse: ${(e as Error).message}`);
  }
  const { registry, images } = (raw ?? {}) as { registry?: unknown; images?: unknown };
  if (typeof registry !== 'string' || !REGISTRY.test(registry))
    throw new Error(`image lock ${path}: registry must be a registry path like ghcr.io/owner`);
  if (typeof images !== 'object' || images === null || Array.isArray(images))
    throw new Error(`image lock ${path}: images must map image names to digests`);
  const out: ImageLock = {};
  for (const [name, digest] of Object.entries(images)) {
    if (typeof digest !== 'string' || !DIGEST.test(digest))
      throw new Error(`image lock ${path}: ${name} is not a sha256 digest`);
    out[name] = digest;
  }
  return { registry, images: out };
}

const imageName = (p: Preset): string =>
  p === 'node' ? 'jumpmaster-trooper' : `jumpmaster-trooper-${p}`;

/**
 * A preset's image: `<registry>/<name>@<digest>` with a lock, `<name>:dev` (a local build) without
 * one. The base trooper image is the node preset. A lock that lacks the image is an error, never a
 * fall back to a tag.
 */
export function presetImage(p: Preset, lock: ImageLock | undefined, registry: string | undefined) {
  const name = imageName(p);
  if (!lock) return `${name}:dev`;
  const digest = lock[name];
  if (!digest) throw new Error(`the image lock has no ${name}`);
  if (!registry) throw new Error(`the image lock has no registry for ${name}`);
  return `${registry}/${name}@${digest}`;
}

/** A zone's image: its explicit `image`, else its preset's. */
export function resolveImage(
  zone: { image?: string | undefined; preset?: Preset | undefined },
  lock: ImageLockFile | undefined,
): string {
  if (zone.image) return zone.image;
  if (!zone.preset) throw new Error('a zone needs image or preset');
  return presetImage(zone.preset, lock?.images, lock?.registry);
}

/** Root paths detection reads. Any other `requirements*.txt` a caller passes counts as well. */
export const DETECT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'requirements-dev.txt',
  'uv.lock',
  'go.mod',
  'mvnw',
  'pom.xml',
  'gradlew',
  'build.gradle',
  'build.gradle.kts',
] as const;

export type Detection = {
  preset: Preset | null;
  candidates: Preset[];
  gates: GateSpec[];
  evidence: string[];
  problems: string[];
};

type Files = Record<string, string | null>;
type Found = { gates: GateSpec[]; evidence: string[]; problems: string[] };

const gate = (name: string, run: string): GateSpec => ({ name, run, timeoutMinutes: 20 });
const has = (files: Files, path: string): boolean => typeof files[path] === 'string';
const requirementFiles = (files: Files): string[] =>
  Object.keys(files)
    // Repository names are data: only plain names are read, and they are quoted in gates.
    .filter((f) => /^requirements[\w.-]*\.txt$/.test(f) && has(files, f))
    .sort((a, b) =>
      a === 'requirements.txt' ? -1 : b === 'requirements.txt' ? 1 : a < b ? -1 : 1,
    );

const SIGNALS: Record<Preset, (files: Files) => string[]> = {
  node: (f) => (has(f, 'package.json') ? ['package.json'] : []),
  python: (f) => [
    ...['pyproject.toml', 'setup.py'].filter((p) => has(f, p)),
    ...requirementFiles(f),
  ],
  go: (f) => (has(f, 'go.mod') ? ['go.mod'] : []),
  jvm: (f) =>
    ['mvnw', 'pom.xml', 'gradlew', 'build.gradle', 'build.gradle.kts'].filter((p) => has(f, p)),
};

function detectNode(files: Files): Found {
  const evidence = ['package.json'];
  const pm = has(files, 'pnpm-lock.yaml')
    ? { name: 'pnpm', lock: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile' }
    : has(files, 'yarn.lock')
      ? { name: 'yarn', lock: 'yarn.lock', install: 'yarn install --immutable' }
      : has(files, 'package-lock.json')
        ? { name: 'npm', lock: 'package-lock.json', install: 'npm ci' }
        : { name: 'npm', lock: null, install: 'npm install' };
  evidence.push(pm.lock ? `${pm.lock}: ${pm.name}` : 'no lockfile: npm install');
  let scripts: Record<string, unknown>;
  try {
    const json = JSON.parse(files['package.json'] as string) as { scripts?: unknown };
    scripts =
      typeof json.scripts === 'object' && json.scripts !== null
        ? (json.scripts as Record<string, unknown>)
        : {};
  } catch {
    return { gates: [], evidence, problems: ['package.json does not parse'] };
  }
  const gates = [gate('install', pm.install)];
  const problems: string[] = [];
  for (const key of ['test', 'typecheck', 'lint']) {
    if (typeof scripts[key] !== 'string') continue;
    gates.push(gate(key, key === 'test' ? `${pm.name} test` : `${pm.name} run ${key}`));
    evidence.push(`scripts.${key}`);
  }
  if (typeof scripts.test !== 'string')
    problems.push('package.json has no "test" script, so no test gate was written');
  return { gates, evidence, problems };
}

/** One clause of a PEP 440 specifier, against a full version. */
function satisfies(version: number[], clause: string): boolean | null {
  const m = /^(~=|===|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause.trim());
  if (!m) return null;
  const [, op, raw = '', star] = m;
  const want = raw.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return Math.sign(d);
    }
    return 0;
  };
  const prefix = (p: number[]) => p.every((n, i) => version[i] === n);
  if (star) {
    if (op === '==') return prefix(want);
    if (op === '!=') return !prefix(want);
    return null;
  }
  switch (op) {
    case '==':
    case '===':
      return cmp(version, want) === 0;
    case '!=':
      return cmp(version, want) !== 0;
    case '<':
      return cmp(version, want) < 0;
    case '<=':
      return cmp(version, want) <= 0;
    case '>':
      return cmp(version, want) > 0;
    case '>=':
      return cmp(version, want) >= 0;
    default: // ~=
      return want.length >= 2 && cmp(version, want) >= 0 && prefix(want.slice(0, -1));
  }
}

/** The shipped Pythons that meet a specifier, or null when it can't be read. */
function pythonsFor(spec: string): string[] | null {
  const clauses = spec.split(',').filter((c) => c.trim() !== '');
  const out: string[] = [];
  for (const v of SHIPPED_PYTHONS) {
    const version = v.split('.').map(Number);
    let ok = true;
    for (const c of clauses) {
      const r = satisfies(version, c);
      if (r === null) return null;
      ok &&= r;
    }
    if (ok) out.push(v);
  }
  return out;
}

const minor = (v: string) => v.split('.').slice(0, 2).join('.');

function detectPython(files: Files): Found {
  const evidence = SIGNALS.python(files);
  const problems: string[] = [];
  const text = (p: string) => (has(files, p) ? (files[p] as string) : '');
  const spec =
    /^\s*requires-python\s*=\s*["']([^"']*)["']/m.exec(text('pyproject.toml'))?.[1] ??
    /python_requires\s*=\s*["']([^"']*)["']/.exec(text('setup.py'))?.[1];
  let python = 'python3';
  if (spec !== undefined) {
    evidence.push(`requires-python ${spec}`);
    const fits = pythonsFor(spec);
    const shipped = SHIPPED_PYTHONS.map(minor).join(' and ');
    if (fits === null) problems.push(`can't read requires-python "${spec}"`);
    else if (fits.length === 0)
      problems.push(
        `needs Python ${spec}; the preset ships ${shipped}; uv will download it under egress monitor or with objects.githubusercontent.com allowed`,
      );
    else if (!fits.includes(SHIPPED_PYTHONS[0])) python = `python${minor(fits[0] as string)}`;
  }
  const reqs = requirementFiles(files);
  let gates: GateSpec[];
  if (has(files, 'uv.lock') && has(files, 'pyproject.toml')) {
    evidence.push('uv.lock: uv');
    gates = [gate('install', 'uv sync --frozen'), gate('test', 'uv run pytest')];
  } else {
    const install =
      reqs.length > 0
        ? `.venv/bin/pip install ${reqs.map((r) => `-r '${r}'`).join(' ')}`
        : '.venv/bin/pip install -e .';
    gates = [
      gate('install', `${python} -m venv .venv && ${install}`),
      gate('test', '.venv/bin/python -m pytest'),
    ];
  }
  const read = ['pyproject.toml', 'setup.py', 'uv.lock', ...reqs].map(text).join('\n');
  if (!/\bpytest\b/.test(read))
    problems.push('no pytest dependency found; the test gate runs pytest');
  return { gates, evidence, problems };
}

function detectGo(): Found {
  return {
    gates: [
      gate('build', 'go build ./...'),
      gate('vet', 'go vet ./...'),
      gate('test', 'go test ./...'),
    ],
    evidence: ['go.mod'],
    problems: [],
  };
}

function detectJvm(files: Files): Found {
  const evidence = SIGNALS.jvm(files);
  if (has(files, 'mvnw'))
    return { gates: [gate('verify', './mvnw -B -ntp verify')], evidence, problems: [] };
  if (has(files, 'pom.xml'))
    return { gates: [gate('verify', 'mvn -B -ntp verify')], evidence, problems: [] };
  if (has(files, 'gradlew'))
    return { gates: [gate('check', './gradlew --no-daemon check')], evidence, problems: [] };
  return {
    gates: [],
    evidence,
    problems: [
      'build.gradle without a gradlew wrapper: the preset ships no Gradle; commit the wrapper (gradle wrapper)',
    ],
  };
}

/** The preset and gates the repository's root files suggest. */
export function detectPreset(files: Files): Detection {
  const candidates = PRESETS.filter((p) => SIGNALS[p](files).length > 0);
  if (candidates.length === 0)
    return {
      preset: null,
      candidates: [],
      gates: [],
      evidence: [],
      problems: ['no recognised build file at the repository root'],
    };
  if (candidates.length > 1)
    return {
      preset: null,
      candidates,
      gates: [],
      evidence: candidates.flatMap((p) => SIGNALS[p](files)),
      problems: [
        `more than one stack at the root (${candidates.join(', ')}): set preset and gates explicitly`,
      ],
    };
  const preset = candidates[0] as Preset;
  const found =
    preset === 'node'
      ? detectNode(files)
      : preset === 'python'
        ? detectPython(files)
        : preset === 'go'
          ? detectGo()
          : detectJvm(files);
  return { preset, candidates, ...found };
}
