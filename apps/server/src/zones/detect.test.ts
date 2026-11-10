import { describe, expect, test } from 'vitest';
import { type DetectForge, detectRepo, REPO, RepoNameError, zoneIdOf } from './detect.js';

type Repo = { private?: boolean; admin?: boolean; branch?: string; files: Record<string, string> };

/** A forge that records every call: detection is GET-only, on the default branch root. */
function fakeForge(repo: Repo) {
  const calls: string[] = [];
  const forge: DetectForge = {
    async repoAccess() {
      calls.push('repoAccess');
      return {
        private: repo.private ?? false,
        defaultBranch: repo.branch ?? 'main',
        permissions: {
          admin: repo.admin ?? false,
          maintain: false,
          push: true,
          triage: true,
          pull: true,
        },
        scopes: null,
        tokenExpiresAt: null,
      };
    },
    async listDir(ref, path) {
      calls.push(`listDir ${ref} ${JSON.stringify(path)}`);
      return Object.keys(repo.files);
    },
    async getFileAt(ref, path) {
      calls.push(`getFileAt ${ref} ${path}`);
      return repo.files[path] ?? null;
    },
  };
  return { forge, calls };
}

const NODE = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check .' } }),
  'package-lock.json': '{}',
  'README.md': '# demo',
};

describe('detectRepo', () => {
  test('reads visibility, the default branch and its root build files, and proposes a preset and gates', async () => {
    const { forge, calls } = fakeForge({
      private: true,
      admin: true,
      branch: 'trunk',
      files: NODE,
    });
    const d = await detectRepo(forge, 'octo/demo');
    expect(d).toMatchObject({
      visibility: 'private',
      defaultBranch: 'trunk',
      preset: 'node',
      candidates: ['node'],
      admin: true,
    });
    expect(d.gates.map((g) => g.name)).toContain('test');
    // GET-only: the access read, the root listing on the default branch, and the build files.
    expect(calls).toEqual([
      'repoAccess',
      'listDir trunk ""',
      'getFileAt trunk package.json',
      'getFileAt trunk package-lock.json',
    ]);
  });

  test('a repository name that fails the REPO pattern is refused before any forge call', async () => {
    for (const bad of [
      'octo',
      'octo/demo/x',
      '../etc',
      'octo/de mo',
      'https://github.com/octo/demo',
    ]) {
      const { forge, calls } = fakeForge({ files: NODE });
      await expect(detectRepo(forge, bad)).rejects.toBeInstanceOf(RepoNameError);
      expect(calls).toEqual([]);
      expect(REPO.test(bad)).toBe(false);
    }
  });

  test('no preset when nothing is recognised, with the problems said', async () => {
    const { forge } = fakeForge({ files: { 'README.md': '#' } });
    const d = await detectRepo(forge, 'octo/empty');
    expect(d.preset).toBeUndefined();
    expect(d.problems.length).toBeGreaterThan(0);
    expect(d.visibility).toBe('public');
  });

  test('a chosen preset is detected as that preset', async () => {
    const { forge } = fakeForge({ files: NODE });
    const d = await detectRepo(forge, 'octo/demo', { preset: 'node' });
    expect(d.preset).toBe('node');
  });

  test('zoneIdOf: the repository name in lower case, letters, digits and dashes', () => {
    expect(zoneIdOf('Octo/My_Repo.js')).toBe('my-repo-js');
    expect(zoneIdOf('octo/___')).toBe('main');
  });
});
