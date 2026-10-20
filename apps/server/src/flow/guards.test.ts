import type { GateSpec } from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import { DEFAULT_PROTECTED_PATHS, type DropZoneConfig } from '../config.js';
import type { BranchRules, BranchRulesRead } from '../forge/github.js';
import {
  branchProtectionProblems,
  gateScriptChanges,
  gateToolChanges,
  invokedScripts,
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

  test('a rename out of a protected path is a hit', () =>
    expect(
      protectedPathHits([{ path: 'x.yml', previousPath: '.github/workflows/ci.yml' }], defaults),
    ).toEqual(['.github/workflows/ci.yml']));

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
      gateToolChanges(
        g,
        pkg({}, { vitest: '^3' }),
        pkg({}, { vitest: 'npm:evil@1' }),
        lock({}),
        lock({}),
      ),
    ).toEqual(['vitest: npm:evil@1']));

  test('a new dependency with an install script is a gate tool change', () =>
    expect(
      gateToolChanges(
        g,
        pkg({}),
        pkg({}, { leftpad: '^1' }),
        lock({}),
        lock({ 'node_modules/leftpad': { version: '1.0.0', hasInstallScript: true } }),
      ),
    ).toEqual(['install script: leftpad']));

  test('changed dependencies with an unreadable lockfile fail closed', () =>
    expect(gateToolChanges(g, pkg({}), pkg({}, { a: '1' }), lock({}), null)).toEqual([
      'lockfile unreadable',
    ]));

  test('an unchanged install-script package is not reported', () => {
    const l = lock({ 'node_modules/esbuild': { version: '0.20.0', hasInstallScript: true } });
    expect(
      gateToolChanges(g, pkg({}, { esbuild: '0.20.0' }), pkg({}, { esbuild: '0.20.0' }), l, l),
    ).toEqual([]);
  });

  test('overrides, resolutions and runner config keys are flagged', () =>
    expect(
      gateToolChanges(
        g,
        pkg({}),
        pkg({}, {}, { overrides: { a: '1' }, resolutions: { b: '2' }, jest: { x: 1 } }),
        lock({}),
        lock({}),
      ),
    ).toEqual(['overrides changed', 'resolutions changed', 'jest config changed']));

  test('a runner version change is flagged', () =>
    expect(
      gateToolChanges(
        g,
        pkg({ test: 'vitest run' }, { vitest: '^3.0.0' }),
        pkg({ test: 'vitest run' }, { vitest: '^3.1.0' }),
        lock({}),
        lock({}),
      ),
    ).toEqual(['vitest version changed']));

  test('a plain registry dependency bump is not a tool change', () =>
    expect(
      gateToolChanges(
        g,
        pkg({ test: 'vitest run' }, { lodash: '^4.0.0' }),
        pkg({ test: 'vitest run' }, { lodash: '^4.1.0' }),
        lock({}),
        lock({}),
      ),
    ).toEqual([]));
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

  test('safe rules give no problems', () =>
    expect(branchProtectionProblems({ author: rules(), reviewer: rules() }, zone)).toEqual([]));

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
