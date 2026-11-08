import { readFileSync } from 'node:fs';
import type { GateSpec } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PROTECTED_PATHS, type DropZoneConfig } from '../config.js';
import type { BranchRules, BranchRulesRead } from '../forge/github.js';
import {
  branchProtectionProblems,
  dependenciesChanged,
  gateBins,
  gateScriptChanges,
  gateToolChanges,
  invokedScripts,
  lockfileChanges,
  parsePnpmLock,
  pnpmBlocksBuilds,
  protectedPathHits,
} from './guards.js';

const defaults = DEFAULT_PROTECTED_PATHS;

/** package.json text. */
const pkg = (
  scripts: Record<string, string>,
  deps: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): string => JSON.stringify({ name: 'x', scripts, dependencies: deps, ...extra });
const scripts = (text: string): Record<string, string> =>
  (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
/** package-lock.json v3 text. */
const lock = (packages: Record<string, Record<string, unknown>>): string =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

const gate = (run: string): GateSpec => ({ name: 'g', run, timeoutMinutes: 20 });
const g = [gate('npm test')];

describe('protectedPathHits', () => {
  test('matches nested CODEOWNERS and jumpmaster*.json', () =>
    expect(
      protectedPathHits(
        [{ path: 'docs/CODEOWNERS' }, { path: 'jumpmaster.prod.json' }, { path: 'src/a.ts' }],
        defaults,
      ),
    ).toEqual(['docs/CODEOWNERS', 'jumpmaster.prod.json']));

  test("a bare entry named like a protected directory (a '.claude' symlink) is a hit", () =>
    expect(protectedPathHits([{ path: '.claude' }, { path: '.github' }], defaults)).toEqual([
      '.claude',
      '.github',
    ]));

  test('a rename out of a protected path is a hit', () =>
    expect(
      protectedPathHits([{ path: 'x.yml', previousPath: '.github/workflows/ci.yml' }], defaults),
    ).toEqual(['.github/workflows/ci.yml']));

  test('package-manager config, hooks and patches are protected by default', () => {
    const paths = [
      'pnpm-workspace.yaml',
      '.pnpmfile.cjs',
      'pnpmfile.cjs',
      'patches/vitest@4.1.0.patch',
      '.yarnrc',
      '.yarnrc.yml',
      'npm-shrinkwrap.json',
      'packages/a/.npmrc',
    ];
    expect(
      protectedPathHits(
        paths.map((path) => ({ path })),
        defaults,
      ),
    ).toEqual(paths);
  });

  test('ordinary source files are not hits', () =>
    expect(protectedPathHits([{ path: 'src/index.ts' }, { path: 'README.md' }], defaults)).toEqual(
      [],
    ));
});

describe('invokedScripts', () => {
  const s = {
    test: 'npm run unit',
    unit: 'vitest',
    lint: 'biome check',
    'e2e:a': 'x',
    'e2e:b': 'y',
  };

  test('npm test follows npm run indirection and adds pre/post', () =>
    expect([...(invokedScripts(g, s) as Set<string>)].sort()).toEqual(
      ['posttest', 'postunit', 'pretest', 'preunit', 'test', 'unit'].sort(),
    ));

  test('npm t, npm run-script, node --run, pnpm and yarn are classified', () => {
    for (const run of [
      'npm t',
      'npm run-script test',
      'node --run test',
      'pnpm test',
      'yarn run test',
    ]) {
      expect(invokedScripts([gate(run)], s)).not.toBe('all');
      expect((invokedScripts([gate(run)], s) as Set<string>).has('unit')).toBe(true);
    }
    expect((invokedScripts([gate('npm -w pkg run lint')], s) as Set<string>).has('lint')).toBe(
      true,
    );
  });

  test('run-p name:* globs are expanded', () => {
    const r = invokedScripts([gate('npm run all')], { ...s, all: 'run-p e2e:*' }) as Set<string>;
    expect(r.has('e2e:a')).toBe(true);
    expect(r.has('e2e:b')).toBe(true);
  });

  test('an unclassified gate command fails closed', () =>
    expect(invokedScripts([gate('turbo test')], scripts(pkg({})))).toBe('all'));
});

describe('gateScriptChanges', () => {
  test('gate script change is detected through npm run indirection', () =>
    expect(
      gateScriptChanges(
        [{ name: 't', run: 'npm test', timeoutMinutes: 20 }],
        pkg({ test: 'npm run unit', unit: 'vitest' }),
        pkg({ test: 'npm run unit', unit: 'exit 0' }),
      ),
    ).toEqual(['unit']));

  test('pretest hooks and unclassified gate commands fail closed', () => {
    expect(
      gateScriptChanges(
        [{ name: 't', run: 'npm test', timeoutMinutes: 20 }],
        pkg({ test: 'vitest' }),
        pkg({ test: 'vitest', pretest: 'x' }),
      ),
    ).toEqual(['pretest']);
    expect(
      invokedScripts([{ name: 't', run: 'turbo test', timeoutMinutes: 20 }], scripts(pkg({}))),
    ).toBe('all');
  });

  test('an unclassified gate makes every changed script count', () =>
    expect(gateScriptChanges([gate('make check')], pkg({ a: '1' }), pkg({ a: '2' }))).toEqual([
      'a',
    ]));

  test('adding a dependency is not a gate script change', () =>
    expect(
      gateScriptChanges(g, pkg({ test: 'vitest' }), pkg({ test: 'vitest' }, { leftpad: '^1' })),
    ).toEqual([]));

  test('an unrelated script change is not a gate change', () =>
    expect(
      gateScriptChanges(
        g,
        pkg({ test: 'vitest', build: 'tsc' }),
        pkg({ test: 'vitest', build: 'tsc -b' }),
      ),
    ).toEqual([]));
});

describe('gateToolChanges', () => {
  test('gateToolChanges flags an npm: alias for the runner', () =>
    expect(
      gateToolChanges(g, pkg({}, { vitest: '^3' }), pkg({}, { vitest: 'npm:evil@1' })),
    ).toEqual(['vitest: npm:evil@1']));

  test('workspace:, catalog:, portal: and jsr: specs are not registry specs', () =>
    expect(
      gateToolChanges(
        g,
        pkg({}),
        pkg({}, { a: 'workspace:*', b: 'catalog:', c: 'portal:../c', d: 'jsr:@std/fs@1' }),
      ),
    ).toEqual(['a: workspace:*', 'b: catalog:', 'c: portal:../c', 'd: jsr:@std/fs@1']));

  test('overrides, resolutions and runner config keys are flagged', () =>
    expect(
      gateToolChanges(
        g,
        pkg({}),
        pkg({}, {}, { overrides: { a: '1' }, resolutions: { b: '2' }, jest: { x: 1 } }),
      ),
    ).toEqual(['overrides changed', 'resolutions changed', 'jest config changed']));

  test('every changed key of the pnpm field is flagged', () =>
    expect(
      gateToolChanges(
        g,
        pkg({}, {}, { pnpm: { overrides: { a: '1' }, onlyBuiltDependencies: ['esbuild'] } }),
        pkg(
          {},
          {},
          {
            pnpm: {
              overrides: { a: '2' },
              onlyBuiltDependencies: ['esbuild'],
              dangerouslyAllowAllBuilds: true,
            },
          },
        ),
      ),
    ).toEqual(['pnpm.overrides changed', 'pnpm.dangerouslyAllowAllBuilds changed']));

  test('a packageManager or devEngines change is flagged once', () => {
    expect(
      gateToolChanges(
        g,
        pkg({}, {}, { packageManager: 'pnpm@9.15.0' }),
        pkg({}, {}, { packageManager: 'pnpm@10.4.1', devEngines: { runtime: { name: 'node' } } }),
      ),
    ).toEqual(['package manager changed']);
  });

  test('a runner version change is flagged', () =>
    expect(
      gateToolChanges(
        g,
        pkg({ test: 'vitest run' }, { vitest: '^3.0.0' }),
        pkg({ test: 'vitest run' }, { vitest: '^3.1.0' }),
      ),
    ).toEqual(['vitest version changed']));

  test('a plain registry dependency bump is not a tool change', () =>
    expect(
      gateToolChanges(
        g,
        pkg({ test: 'vitest run' }, { lodash: '^4.0.0' }),
        pkg({ test: 'vitest run' }, { lodash: '^4.1.0' }),
      ),
    ).toEqual([]));
});

describe('dependenciesChanged', () => {
  test('is true only when a dependency field changes', () => {
    expect(dependenciesChanged(pkg({ a: '1' }), pkg({ a: '2' }))).toBe(false);
    expect(dependenciesChanged(pkg({}), pkg({}, { a: '1' }))).toBe(true);
  });
});

describe('pnpmBlocksBuilds', () => {
  test('is true only when packageManager pins pnpm 10 or later', () => {
    const pm = (packageManager?: string) => pkg({}, {}, packageManager ? { packageManager } : {});
    expect(pnpmBlocksBuilds(pm('pnpm@10.4.1'))).toBe(true);
    expect(pnpmBlocksBuilds(pm('pnpm@11.0.0+sha512.abc'))).toBe(true);
    expect(pnpmBlocksBuilds(pm('pnpm@9.15.0'))).toBe(false);
    expect(pnpmBlocksBuilds(pm('npm@10.9.0'))).toBe(false);
    expect(pnpmBlocksBuilds(pm())).toBe(false);
    expect(pnpmBlocksBuilds(null)).toBe(false);
  });
});

describe('lockfileChanges: npm', () => {
  test('a new package with an install script is reported', () =>
    expect(
      lockfileChanges(
        'package-lock.json',
        lock({}),
        lock({ 'node_modules/leftpad': { version: '1.0.0', hasInstallScript: true } }),
      ),
    ).toEqual(['install script: leftpad']));

  test('npm-shrinkwrap.json is read as an npm lockfile', () =>
    expect(
      lockfileChanges(
        'npm-shrinkwrap.json',
        lock({}),
        lock({ 'node_modules/leftpad': { version: '1.0.0', hasInstallScript: true } }),
      ),
    ).toEqual(['install script: leftpad']));

  test('an unchanged install-script package is not reported', () => {
    const l = lock({ 'node_modules/esbuild': { version: '0.20.0', hasInstallScript: true } });
    expect(lockfileChanges('package-lock.json', l, l)).toEqual([]);
  });

  test('a missing, empty or malformed lockfile is unreadable, never everything added', () => {
    const l = lock({ 'node_modules/esbuild': { version: '0.20.0', hasInstallScript: true } });
    for (const [base, head] of [
      [lock({}), null],
      [lock({}), ''],
      ['', l],
      ['{', l],
    ] as const) {
      expect(lockfileChanges('package-lock.json', base, head)).toEqual(['lockfile unreadable']);
    }
  });

  const reg = (name: string, version: string, host = 'registry.npmjs.org') => ({
    version,
    resolved: `https://${host}/${name}/-/${name}-${version}.tgz`,
    integrity: `sha512-${name}${version}`,
  });
  const npm = (base: string, head: string, gateBins: string[] = []) =>
    lockfileChanges('package-lock.json', base, head, { pnpmBlocksBuilds: false, gateBins });

  test('a new or changed entry resolved off the registry host is reported', () => {
    const base = lock({ 'node_modules/a': reg('a', '1.0.0') });
    expect(
      npm(
        base,
        lock({
          'node_modules/a': { ...reg('a', '1.0.0'), resolved: 'https://evil.example/a.tgz' },
          'node_modules/b': { version: '1.0.0', resolved: 'git+ssh://git@example.test/b.git' },
          'node_modules/c': reg('c', '1.0.0'),
        }),
      ),
    ).toEqual([
      'a: non-registry resolved https://evil.example/a.tgz',
      'b: non-registry resolved git+ssh://git@example.test/b.git',
    ]);
  });

  test('the registry host base entries already use is accepted', () => {
    const base = lock({ 'node_modules/a': reg('a', '1.0.0', 'npm.example.test') });
    const head = lock({
      'node_modules/a': reg('a', '1.0.0', 'npm.example.test'),
      'node_modules/b': reg('b', '2.0.0', 'npm.example.test'),
    });
    expect(npm(base, head)).toEqual([]);
  });

  test('a linked entry is reported', () =>
    expect(
      npm(lock({}), lock({ 'node_modules/vitest': { resolved: 'tools/fake', link: true } })),
    ).toEqual(['vitest: linked to tools/fake']));

  test('a gate tool changed in the lockfile alone is reported, by name or by bin', () => {
    const base = lock({
      'node_modules/vitest': reg('vitest', '3.0.0'),
      'node_modules/typescript': { ...reg('typescript', '5.0.0'), bin: { tsc: 'bin/tsc' } },
      'node_modules/lodash': reg('lodash', '4.0.0'),
    });
    const head = lock({
      'node_modules/vitest': reg('vitest', '3.0.1'),
      'node_modules/typescript': { ...reg('typescript', '5.0.1'), bin: { tsc: 'bin/tsc' } },
      'node_modules/lodash': reg('lodash', '4.0.1'),
    });
    expect(npm(base, head, ['vitest', 'tsc'])).toEqual([
      'vitest version changed in lockfile',
      'typescript version changed in lockfile',
    ]);
    expect(npm(base, head)).toEqual([]);
  });
});

describe('gateBins', () => {
  test('first words of invoked scripts and npx targets', () =>
    expect(
      gateBins(
        [gate('npm test'), gate('npx --yes eslint .')],
        pkg({ test: 'npm run unit', unit: 'vitest run', lint: 'biome check' }),
      ).sort(),
    ).toEqual(['biome', 'eslint', 'npm', 'vitest'])); // npx is unclassified: every script counts
});

describe('lockfileChanges: unsupported formats', () => {
  test('yarn and bun lockfiles are named, not parsed', () => {
    for (const file of ['yarn.lock', 'bun.lock', 'bun.lockb']) {
      expect(lockfileChanges(`web/${file}`, 'a', 'b')).toEqual([
        `lockfile format not supported: ${file}`,
      ]);
    }
  });
});

describe('pnpm lockfile', () => {
  const sample = readFileSync(new URL('../test/pnpm-lock.v9.yaml', import.meta.url), 'utf8');
  const unpinned = { pnpmBlocksBuilds: false };
  const pnpm10 = { pnpmBlocksBuilds: true };
  const pnpm = (base: string | null, head: string | null, opts = unpinned) =>
    lockfileChanges('pnpm-lock.yaml', base, head, opts);
  /** The sample with an entry added after a section header. */
  const withEntry = (text: string, section: string, entry: string): string =>
    text.replace(`\n${section}:\n\n`, `\n${section}:\n\n${entry}\n`);
  const typesNode26 = (lockText: string, resolution = '{integrity: sha512-bmV3}') =>
    withEntry(
      withEntry(lockText, 'packages', `  '@types/node@26.6.5':\n    resolution: ${resolution}\n`),
      'snapshots',
      "  '@types/node@26.6.5':\n    dependencies:\n      undici-types: 7.18.2\n",
    );

  test('the real v9 sample parses: quoted, scoped, peer-suffixed and non-registry keys', () => {
    const l = parsePnpmLock(sample);
    expect(l?.major).toBe(9);
    expect([...(l?.packages.keys() ?? [])]).toEqual(
      expect.arrayContaining([
        '@csstools/css-calc@3.1.1',
        'esbuild@0.28.2',
        'xlsx@file:vendor/xlsx-0.20.3.tgz',
      ]),
    );
    expect([...(l?.snapshots.keys() ?? [])]).toEqual(
      expect.arrayContaining([
        '@csstools/css-calc@3.1.1(@csstools/css-parser-algorithms@4.0.0(@csstools/css-tokenizer@4.0.0))(@csstools/css-tokenizer@4.0.0)',
        'undici-types@7.18.2',
      ]),
    );
    expect(l?.snapshots.get('undici-types@7.18.2')).toEqual({});
  });

  test('an unchanged lockfile reports nothing, even with a non-registry entry', () =>
    expect(pnpm(sample, sample)).toEqual([]));

  test('a new package key (pnpm < 10 or unpinned) is a dependency added', () =>
    expect(pnpm(sample, typesNode26(sample))).toEqual([
      'dependency added: @types/node@26.6.5 (verified: registry integrity only; install scripts may run)',
    ]));

  test('with pnpm 10 pinned a new registry package is accepted', () =>
    expect(pnpm(sample, typesNode26(sample), pnpm10)).toEqual([]));

  test('a new package with a non-registry resolution is reported even with pnpm 10', () =>
    expect(
      pnpm(sample, typesNode26(sample, '{tarball: https://example.test/x.tgz}'), pnpm10),
    ).toEqual(['@types/node: non-registry resolution']));

  test('a changed entry under an existing key is reported (packages and snapshots)', () => {
    const head = sample
      .replace('sha512-HKVLS8dvII', 'sha512-AAAAAAAAAA')
      .replace(
        "  '@types/node@25.5.0':\n    dependencies:\n",
        "  '@types/node@25.5.0':\n    optionalDependencies:\n",
      );
    expect(pnpm(sample, head, pnpm10)).toEqual([
      'lockfile entry changed: esbuild@0.28.2',
      'lockfile entry changed: @types/node@25.5.0',
    ]);
  });

  test('a new snapshot that aliases a dependency is reported', () => {
    const head = withEntry(
      sample,
      'snapshots',
      '  vitest@4.1.11(vite@7.3.7):\n    dependencies:\n      vite: evil@1.0.0\n',
    );
    expect(pnpm(sample, head, pnpm10)).toEqual(['vitest: non-registry dependency vite']);
  });

  test('an importer pointed at a link or alias is reported', () => {
    const head = sample.replace('        version: 0.28.2\n', '        version: link:./fake\n');
    expect(pnpm(sample, head, pnpm10)).toEqual(['esbuild: non-registry version link:./fake']);
  });

  test('settings, overrides, patches, pnpmfile and catalogs changes are reported', () => {
    const head = `${sample
      .replace('autoInstallPeers: true', 'autoInstallPeers: false')
      .replace("  '@babel/core@<7.29.6': ^7.29.6\n", '')}
patchedDependencies:
  vitest: patches/vitest.patch

pnpmfileChecksum: sha256-abc

catalogs:
  default:
    vitest:
      specifier: ^4
      version: 4.1.11
`;
    expect(pnpm(sample, head, pnpm10)).toEqual([
      'settings changed',
      'overrides changed',
      'patchedDependencies changed',
      'pnpmfileChecksum changed',
      'catalogs changed',
    ]);
  });

  test('no base lockfile: every package is new', () =>
    expect(pnpm(null, sample)).toEqual(
      expect.arrayContaining([
        'xlsx: non-registry resolution',
        'dependency added: esbuild@0.28.2 (verified: registry integrity only; install scripts may run)',
        'dependency added: @csstools/css-calc@3.1.1 (verified: registry integrity only; install scripts may run)',
      ]),
    ));

  test('v6: a new requiresBuild package is an install script; others are added', () => {
    const v6 = (extra: string) => `lockfileVersion: '6.0'

devDependencies:
  vitest:
    specifier: ^1.0.0
    version: 1.0.0

packages:

  /vitest@1.0.0:
    resolution: {integrity: sha512-dml0}
    dev: true
${extra}`;
    const head = v6(`
  /esbuild@0.19.0:
    resolution: {integrity: sha512-ZXNi}
    requiresBuild: true
    dev: true

  /@types/node@20.0.0(typescript@5.0.0):
    resolution: {integrity: sha512-dHlw}
    dev: true
`);
    expect(pnpm(v6(''), head)).toEqual([
      'install script: esbuild',
      'dependency added: @types/node@20.0.0 (verified: registry integrity only; install scripts may run)',
    ]);
  });

  test('double-quoted keys are read', () => {
    const head = withEntry(
      sample,
      'packages',
      '  "left-pad@1.3.0":\n    resolution: {integrity: sha512-bGVm}\n',
    );
    expect(pnpm(sample, head)).toEqual([
      'dependency added: left-pad@1.3.0 (verified: registry integrity only; install scripts may run)',
    ]);
  });

  test('anything unexpected is unreadable', () => {
    for (const head of [
      null,
      '',
      sample.replace("lockfileVersion: '9.0'", "lockfileVersion: '5.4'"),
      sample.replace("lockfileVersion: '9.0'", 'lockfileVersion: banana'),
      `---\n${sample}`,
      sample.replace('    resolution:', '\tresolution:'),
      sample.replace('    engines:', '     engines:'),
      sample.replace('    hasBin: true', '        hasBin: true'),
      `${sample}\nsurprise:\n  a: 1\n`,
      `${sample}\n# comment\n`,
      'packages: [}',
    ]) {
      expect(pnpm(sample, head)).toEqual(['lockfile unreadable']);
    }
    expect(pnpm('', sample)).toEqual(['lockfile unreadable']);
    expect(pnpm('lockfileVersion: 1', sample)).toEqual(['lockfile unreadable']);
  });

  describe('layout tricks that hid an alias from the line reader', () => {
    const base = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^3.0.0
        version: 3.0.0

packages:

  vite@5.0.0:
    resolution: {integrity: sha512-AAAA}

  vitest@3.0.0:
    resolution: {integrity: sha512-BBBB}

snapshots:

  vite@5.0.0: {}

  vitest@3.0.0:
    dependencies:
      vite: 5.0.0
`;
    /** vitest bumped to 3.0.1, whose snapshot is `snapshot`, plus a registry `evil` package. */
    const bump = (snapshot: string) =>
      `${base
        .replace('version: 3.0.0', 'version: 3.0.1')
        .replace(
          '  vitest@3.0.0:\n    resolution: {integrity: sha512-BBBB}\n',
          '  vitest@3.0.1:\n    resolution: {integrity: sha512-CCCC}\n\n  evil@1.0.0:\n    resolution: {integrity: sha512-EVIL}\n',
        )
        .replace(
          '  vitest@3.0.0:\n    dependencies:\n      vite: 5.0.0\n',
          snapshot,
        )}\n  evil@1.0.0: {}\n`;
    const alias = 'vitest: non-registry dependency vite';

    test('control: the plain layout is caught', () =>
      expect(
        pnpm(base, bump('  vitest@3.0.1:\n    dependencies:\n      vite: evil@1.0.0\n'), pnpm10),
      ).toContain(alias));

    test('a trailing space after dependencies: is still read', () =>
      expect(
        pnpm(base, bump('  vitest@3.0.1:\n    dependencies: \n      vite: evil@1.0.0\n'), pnpm10),
      ).toContain(alias));

    test('an inline flow map of dependencies is still read', () =>
      expect(
        pnpm(base, bump('  vitest@3.0.1:\n    dependencies: {vite: evil@1.0.0}\n'), pnpm10),
      ).toContain(alias));

    test('an anchor is refused', () =>
      expect(
        pnpm(base, bump('  vitest@3.0.1:\n    dependencies: &d\n      vite: evil@1.0.0\n'), pnpm10),
      ).toEqual(['lockfile unreadable']));

    test('a lone carriage return is refused', () =>
      expect(
        pnpm(
          base,
          bump(
            '  vitest@3.0.1:\n    transitivePeerDependencies:\r      - foo\r    dependencies:\r      vite: evil@1.0.0\n',
          ),
          pnpm10,
        ),
      ).toEqual(['lockfile unreadable']));

    test('a lone carriage return cannot hide an importer version', () =>
      expect(
        pnpm(
          base,
          base.replace(
            '        version: 3.0.0\n',
            '        version: 3.0.0\r      vite:\r        specifier: ^5\r        version: link:./fake\n',
          ),
          pnpm10,
        ),
      ).toEqual(['lockfile unreadable']));

    test('a duplicate key (a second, tarball resolution) is refused', () =>
      expect(
        pnpm(
          base,
          base.replace(
            '    resolution: {integrity: sha512-BBBB}\n',
            '    resolution: {integrity: sha512-BBBB}\n    resolution: {tarball: https://example.test/v.tgz}\n',
          ),
          pnpm10,
        ),
      ).toEqual(['lockfile unreadable']));

    test('aliases, tags and merge keys are refused', () => {
      for (const head of [
        base.replace('      vite: 5.0.0\n', '      vite: *x\n'),
        base.replace('  vite@5.0.0: {}\n', '  vite@5.0.0: !!map {}\n'),
        base.replace('  vite@5.0.0: {}\n', '  vite@5.0.0:\n    <<: {a: 1}\n'),
      ]) {
        expect(pnpm(base, head, pnpm10)).toEqual(['lockfile unreadable']);
      }
    });

    test('quoted values with * & ! are not mistaken for YAML syntax', () => {
      const head = base.replace(
        '  vite@5.0.0:\n    resolution: {integrity: sha512-AAAA}\n',
        "  vite@5.0.0:\n    resolution: {integrity: sha512-AAAA}\n    peerDependencies:\n      a: '*'\n      b: '!x & y'\n    deprecated: use x & y instead!\n",
      );
      expect(pnpm(base, head, pnpm10)).toEqual(['lockfile entry changed: vite@5.0.0']);
    });

    test('requiresBuild is read by YAML truthiness', () => {
      const v6 = (extra: string) =>
        `lockfileVersion: '6.0'\n\npackages:\n\n  /vitest@1.0.0:\n    resolution: {integrity: sha512-dml0}\n${extra}`;
      expect(
        pnpm(
          v6(''),
          v6(
            '\n  /evil@1.0.0:\n    resolution: {integrity: sha512-ZXZp}\n    requiresBuild: True\n',
          ),
          pnpm10,
        ),
      ).toEqual(['install script: evil']);
    });
  });
});

describe('branchProtectionProblems', () => {
  const zone = { requireBranchProtection: true, ciRequired: true } as DropZoneConfig;
  const rules = (r: Partial<BranchRules> = {}): BranchRulesRead => ({
    kind: 'ok',
    rules: {
      requiredApprovals: 1,
      dismissStaleOnPush: true,
      requiredChecks: ['ci'],
      unpinnedChecks: [],
      viewerCanBypass: false,
      viewerIsAdmin: false,
      ...r,
    },
  });

  test('a merge queue or required deployments make the server unable to merge', () =>
    expect(
      branchProtectionProblems(
        {
          author: rules({ unsupportedRules: ['merge_queue', 'required_deployments'] }),
          reviewer: rules(),
        },
        zone,
      ),
    ).toEqual(['unsupported rule: merge_queue', 'unsupported rule: required_deployments']));

  test('safe rules give no problems', () =>
    expect(branchProtectionProblems({ author: rules(), reviewer: rules() }, zone)).toEqual([]));

  test('an admin author is unsafe unless the zone opts in', () =>
    expect(
      branchProtectionProblems({ author: rules({ viewerIsAdmin: true }), reviewer: rules() }, zone),
    ).toEqual(['bot is admin']));

  describe('authorMayBeAdmin', () => {
    const optedIn = { ...zone, authorMayBeAdmin: true };

    test('allows an admin author', () =>
      expect(
        branchProtectionProblems(
          { author: rules({ viewerIsAdmin: true }), reviewer: rules() },
          optedIn,
        ),
      ).toEqual([]));

    test('still refuses an admin reviewer', () =>
      expect(
        branchProtectionProblems(
          { author: rules(), reviewer: rules({ viewerIsAdmin: true }) },
          optedIn,
        ),
      ).toEqual(['bot is admin']));

    test('still refuses an author who can bypass the ruleset', () =>
      expect(
        branchProtectionProblems(
          { author: rules({ viewerIsAdmin: true, viewerCanBypass: true }), reviewer: rules() },
          optedIn,
        ),
      ).toEqual(['bot can bypass']));
  });

  test('branchProtectionProblems lists every missing setting', () =>
    expect(
      branchProtectionProblems(
        {
          author: rules({
            requiredApprovals: 0,
            dismissStaleOnPush: false,
            viewerCanBypass: true,
            unpinnedChecks: ['ci'],
            requiredChecks: [],
          }),
          reviewer: rules({ viewerIsAdmin: true }),
        },
        zone,
      ),
    ).toEqual([
      'approvals < 1',
      'stale approvals not dismissed',
      'bot can bypass',
      'required check not pinned: ci',
      'no required checks',
      'bot is admin',
    ]));

  test('no ruleset is reported', () =>
    expect(branchProtectionProblems({ author: { kind: 'none' }, reviewer: rules() }, zone)).toEqual(
      ['no ruleset'],
    ));

  test('branchProtectionProblems returns null when a read is unavailable', () =>
    expect(
      branchProtectionProblems({ author: rules(), reviewer: { kind: 'unavailable' } }, zone),
    ).toBeNull());

  test('nothing is judged when protection is not required', () =>
    expect(
      branchProtectionProblems(
        { author: { kind: 'unavailable' }, reviewer: { kind: 'none' } },
        { ...zone, requireBranchProtection: false },
      ),
    ).toEqual([]));
});
