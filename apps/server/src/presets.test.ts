import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRESETS } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import {
  DETECT_FILES,
  detectPreset,
  loadImageLock,
  PRESET_EGRESS,
  presetImage,
  resolveImage,
  SHIPPED_PYTHONS,
} from './presets.js';

const gates = (files: Record<string, string | null>) =>
  detectPreset(files).gates.map((g) => `${g.name}: ${g.run}`);

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

describe('detectPreset: node', () => {
  test('package.json with pnpm-lock.yaml yields pnpm install --frozen-lockfile then pnpm test', () => {
    const r = detectPreset({ 'package.json': pkg({ test: 'vitest' }), 'pnpm-lock.yaml': 'x' });
    expect(r.preset).toBe('node');
    expect(r.candidates).toEqual(['node']);
    expect(gates({ 'package.json': pkg({ test: 'vitest' }), 'pnpm-lock.yaml': 'x' })).toEqual([
      'install: pnpm install --frozen-lockfile',
      'test: pnpm test',
    ]);
    expect(r.problems).toEqual([]);
    expect(r.evidence.join('\n')).toMatch(/pnpm-lock\.yaml/);
  });

  test('each lockfile picks its package manager, and none means npm install', () => {
    const s = pkg({ test: 't' });
    expect(gates({ 'package.json': s, 'yarn.lock': 'x' })).toEqual([
      'install: yarn install --immutable',
      'test: yarn test',
    ]);
    expect(gates({ 'package.json': s, 'package-lock.json': '{}' })).toEqual([
      'install: npm ci',
      'test: npm test',
    ]);
    expect(gates({ 'package.json': s, 'package-lock.json': null })).toEqual([
      'install: npm install',
      'test: npm test',
    ]);
  });

  test('package.json scripts decide which of test, typecheck and lint gates exist', () => {
    expect(
      gates({
        'package.json': pkg({ lint: 'biome check', typecheck: 'tsc', build: 'tsc -b', test: 'x' }),
        'package-lock.json': '{}',
      }),
    ).toEqual([
      'install: npm ci',
      'test: npm test',
      'typecheck: npm run typecheck',
      'lint: npm run lint',
    ]);
    expect(gates({ 'package.json': pkg({ lint: 'eslint .' }), 'yarn.lock': 'x' })).toEqual([
      'install: yarn install --immutable',
      'lint: yarn run lint',
    ]);
  });

  test('a package.json with no test script is a problem, and a broken one too', () => {
    expect(detectPreset({ 'package.json': pkg({ lint: 'x' }) }).problems.join()).toMatch(
      /no "test" script/,
    );
    const broken = detectPreset({ 'package.json': '{ not json' });
    expect(broken.preset).toBe('node');
    expect(broken.gates).toEqual([]);
    expect(broken.problems.join()).toMatch(/package\.json does not parse/);
  });
});

describe('detectPreset: python', () => {
  test('uv.lock yields uv sync --frozen and uv run pytest', () => {
    const r = detectPreset({
      'pyproject.toml': '[project]\nname = "x"\ndependencies = ["pytest"]\n',
      'uv.lock': 'version = 1',
    });
    expect(r.preset).toBe('python');
    expect(r.gates.map((g) => `${g.name}: ${g.run}`)).toEqual([
      'install: uv sync --frozen',
      'test: uv run pytest',
    ]);
    expect(r.problems).toEqual([]);
  });

  test('requirements.txt and requirements-dev.txt yield a venv install of both, then pytest', () => {
    expect(gates({ 'requirements.txt': 'flask\n', 'requirements-dev.txt': 'pytest\n' })).toEqual([
      "install: python3 -m venv .venv && .venv/bin/pip install -r 'requirements.txt' -r 'requirements-dev.txt'",
      'test: .venv/bin/python -m pytest',
    ]);
    expect(gates({ 'requirements.txt': 'pytest\n' })).toEqual([
      "install: python3 -m venv .venv && .venv/bin/pip install -r 'requirements.txt'",
      'test: .venv/bin/python -m pytest',
    ]);
  });

  test('requirement files are quoted, and a name with shell characters is never read', () => {
    const r = detectPreset({
      'requirements.txt': 'pytest',
      'requirements-test.v2.txt': 'x',
      'requirements; curl x | sh #.txt': 'x',
      "requirements$(id)'.txt": 'x',
      'requirements dev.txt': 'x',
    });
    expect(r.gates[0]?.run).toBe(
      "python3 -m venv .venv && .venv/bin/pip install -r 'requirements.txt' -r 'requirements-test.v2.txt'",
    );
    expect(r.evidence.join('\n')).not.toMatch(/curl|\$\(|dev\.txt/);
    // A repository whose only requirements file has such a name is not python at all.
    expect(detectPreset({ 'requirements;x.txt': 'pytest' }).preset).toBeNull();
  });

  test('pyproject.toml or setup.py alone installs the project editable', () => {
    for (const file of ['pyproject.toml', 'setup.py'])
      expect(gates({ [file]: 'pytest' })).toEqual([
        'install: python3 -m venv .venv && .venv/bin/pip install -e .',
        'test: .venv/bin/python -m pytest',
      ]);
  });

  test('requires-python >= 3.13 is a problem naming the shipped versions', () => {
    const r = detectPreset({
      'pyproject.toml':
        '[project]\nname = "x"\nrequires-python = ">=3.13"\ndependencies = ["pytest"]\n',
      'uv.lock': 'x',
    });
    expect(r.preset).toBe('python');
    expect(r.problems).toEqual([
      'needs Python >=3.13; the preset ships 3.11 and 3.12; uv will download it under egress monitor or with objects.githubusercontent.com allowed',
    ]);
  });

  test('requires-python that only 3.12 meets builds the venv with python3.12', () => {
    const r = detectPreset({
      'pyproject.toml': "[project]\nrequires-python = '>=3.12,<4'\n# pytest\n",
    });
    expect(r.problems).toEqual([]);
    expect(r.gates[0]?.run).toBe('python3.12 -m venv .venv && .venv/bin/pip install -e .');
    // Both shipped versions qualify: the Debian python3 is used.
    expect(
      detectPreset({ 'pyproject.toml': 'requires-python = "~=3.11"\npytest' }).gates[0]?.run,
    ).toMatch(/^python3 -m venv/);
  });

  test('specifier forms: ==3.12.*, !=, < and an unreadable value', () => {
    const problems = (spec: string) =>
      detectPreset({ 'pyproject.toml': `requires-python = "${spec}"\npytest` }).problems;
    expect(problems('==3.12.*')).toEqual([]);
    expect(problems('>=3.10,!=3.11.*,!=3.12.*')[0]).toMatch(/^needs Python >=3\.10,!=3\.11\.\*/);
    expect(problems('<3.11')[0]).toMatch(/^needs Python <3\.11;/);
    expect(problems('>= banana')[0]).toMatch(/can't read requires-python/);
    expect(SHIPPED_PYTHONS.map((v) => v.split('.').slice(0, 2).join('.'))).toEqual([
      '3.11',
      '3.12',
    ]);
  });

  test('no mention of pytest is a problem, but the gate is still written', () => {
    const r = detectPreset({ 'requirements.txt': 'flask\n' });
    expect(r.gates.map((g) => g.name)).toEqual(['install', 'test']);
    expect(r.problems.join()).toMatch(/pytest/);
  });
});

describe('detectPreset: go and jvm', () => {
  test('go.mod yields build, vet and test', () => {
    expect(gates({ 'go.mod': 'module x\n\ngo 1.27\n' })).toEqual([
      'build: go build ./...',
      'vet: go vet ./...',
      'test: go test ./...',
    ]);
  });

  test('mvnw, pom.xml and gradlew each yield their build', () => {
    expect(gates({ mvnw: '#!/bin/sh', 'pom.xml': '<project/>' })).toEqual([
      'verify: ./mvnw -B -ntp verify',
    ]);
    expect(gates({ 'pom.xml': '<project/>' })).toEqual(['verify: mvn -B -ntp verify']);
    expect(gates({ gradlew: '#!/bin/sh', 'build.gradle.kts': '' })).toEqual([
      'check: ./gradlew --no-daemon check',
    ]);
  });

  test('build.gradle without gradlew is a problem, not a gate', () => {
    for (const file of ['build.gradle', 'build.gradle.kts']) {
      const r = detectPreset({ [file]: 'plugins {}' });
      expect(r.preset).toBe('jvm');
      expect(r.gates).toEqual([]);
      expect(r.problems.join()).toMatch(/without a gradlew wrapper/);
    }
  });
});

describe('detectPreset: ambiguity and absence', () => {
  test('package.json plus pyproject.toml is ambiguous and lists both candidates', () => {
    const r = detectPreset({ 'package.json': pkg({ test: 'x' }), 'pyproject.toml': 'pytest' });
    expect(r.preset).toBeNull();
    expect(r.candidates).toEqual(['node', 'python']);
    expect(r.gates).toEqual([]);
    expect(r.problems.join()).toMatch(/more than one stack/);
  });

  test('no recognised file yields preset null and no gates', () => {
    const r = detectPreset({ 'README.md': '# hi', 'package.json': null });
    expect(r).toEqual({
      preset: null,
      candidates: [],
      gates: [],
      evidence: [],
      problems: ['no recognised build file at the repository root'],
    });
  });

  test('DETECT_FILES covers every signal detection reads', () => {
    for (const f of [
      'package.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'package-lock.json',
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'setup.py',
      'uv.lock',
      'go.mod',
      'mvnw',
      'pom.xml',
      'gradlew',
      'build.gradle',
      'build.gradle.kts',
    ])
      expect(DETECT_FILES).toContain(f);
    expect(DETECT_FILES.every((f) => !f.includes('/'))).toBe(true);
  });
});

describe('preset images and egress', () => {
  test('PRESET_EGRESS node includes nodejs.org and objects.githubusercontent.com', () => {
    expect(Object.keys(PRESET_EGRESS).sort()).toEqual([...PRESETS].sort());
    expect(PRESET_EGRESS.node).toEqual(
      expect.arrayContaining([
        'registry.npmjs.org',
        'nodejs.org',
        'objects.githubusercontent.com',
        'codeload.github.com',
      ]),
    );
    expect(PRESET_EGRESS.python).toEqual(
      expect.arrayContaining([
        'pypi.org',
        'files.pythonhosted.org',
        'objects.githubusercontent.com',
      ]),
    );
    expect(PRESET_EGRESS.go).toEqual(
      expect.arrayContaining(['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com']),
    );
    expect(PRESET_EGRESS.jvm).toEqual(
      expect.arrayContaining([
        'repo.maven.apache.org',
        'repo1.maven.org',
        'services.gradle.org',
        'plugins.gradle.org',
        'downloads.gradle.org',
        'plugins-artifacts.gradle.org',
      ]),
    );
    for (const hosts of Object.values(PRESET_EGRESS))
      for (const h of hosts) expect(h).toMatch(/^[a-z0-9.-]+$/);
  });

  const D = `sha256:${'a'.repeat(64)}`;
  const E = `sha256:${'b'.repeat(64)}`;

  test('presetImage uses the lock digest, and the dev tag without a lock', () => {
    const lock = { 'jumpmaster-trooper': D, 'jumpmaster-trooper-python': E };
    expect(presetImage('python', lock, 'ghcr.io/o/r')).toBe(
      `ghcr.io/o/r/jumpmaster-trooper-python@${E}`,
    );
    // The base trooper image doubles as the node preset.
    expect(presetImage('node', lock, 'ghcr.io/o/r')).toBe(`ghcr.io/o/r/jumpmaster-trooper@${D}`);
    expect(presetImage('go', undefined, 'ghcr.io/o/r')).toBe('jumpmaster-trooper-go:dev');
    expect(presetImage('node', undefined, undefined)).toBe('jumpmaster-trooper:dev');
    // A lock that lacks the preset, or a lock with no registry, is an error, never a dev tag.
    expect(() => presetImage('jvm', lock, 'ghcr.io/o/r')).toThrow(/jumpmaster-trooper-jvm/);
    expect(() => presetImage('python', lock, undefined)).toThrow(/registry/);
  });

  test('resolveImage: an explicit image wins, else the preset image', () => {
    expect(resolveImage({ image: 'mine@x', preset: 'go' }, undefined)).toBe('mine@x');
    expect(resolveImage({ preset: 'go' }, undefined)).toBe('jumpmaster-trooper-go:dev');
    expect(() => resolveImage({}, undefined)).toThrow(/image or preset/);
  });

  test('loadImageLock reads a lock of digests, and is undefined when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-lock-'));
    expect(loadImageLock(join(dir, 'missing.json'))).toBeUndefined();
    const ok = join(dir, 'ok.json');
    writeFileSync(
      ok,
      JSON.stringify({ registry: 'ghcr.io/o/r', images: { 'jumpmaster-trooper': D } }),
    );
    expect(loadImageLock(ok)).toEqual({
      registry: 'ghcr.io/o/r',
      images: { 'jumpmaster-trooper': D },
    });
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({ registry: 'ghcr.io/o/r', images: { 'jumpmaster-trooper': 'latest' } }),
    );
    expect(() => loadImageLock(bad)).toThrow(/jumpmaster-trooper/);
    const torn = join(dir, 'torn.json');
    writeFileSync(torn, '{');
    expect(() => loadImageLock(torn)).toThrow(/torn\.json/);
  });
});
