import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig, modelFor, secretList } from './config.js';

const fullEnv: Record<string, string | undefined> = {
  JM_CLAUDE_TOKEN: 'a',
  JM_GITHUB_AUTHOR_TOKEN: 'b',
  JM_GITHUB_REVIEWER_TOKEN: 'r',
  JM_JOIN_TOKEN: 'c',
};

function fixture(json: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jm-config-')), 'jumpmaster.config.json');
  writeFileSync(file, JSON.stringify(json));
  return file;
}

const baseZone = {
  id: 'main',
  repo: 'octo/demo',
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
};
const withZone = (extra: Record<string, unknown>) =>
  fixture({ dataDir: './data', dropZones: [{ ...baseZone, ...extra }] });

const minimal = fixture({
  dataDir: './data',
  dropZones: [
    {
      id: 'main',
      repo: 'octo/demo',
      gates: [{ name: 'test', run: 'npm test' }],
      image: 'jm-trooper:dev',
    },
  ],
});

describe('loadConfig', () => {
  test('reviewReadToken without JM_GITHUB_READ_TOKEN is a config error', () => {
    const file = withZone({ reviewReadToken: true });
    expect(() => loadConfig(file, fullEnv)).toThrow(/JM_GITHUB_READ_TOKEN/);
    expect(
      loadConfig(file, { ...fullEnv, JM_GITHUB_READ_TOKEN: 'rd' }).secrets.githubReadToken,
    ).toBe('rd');
  });

  test('missing JM_CLAUDE_TOKEN is a config error', () =>
    expect(() =>
      loadConfig(minimal, {
        JM_GITHUB_AUTHOR_TOKEN: 'x',
        JM_GITHUB_REVIEWER_TOKEN: 'z',
        JM_JOIN_TOKEN: 'y',
      }),
    ).toThrow(/JM_CLAUDE_TOKEN/));

  test('applies defaults', () => {
    const c = loadConfig(minimal, fullEnv);
    expect(c.listen).toEqual({ host: '127.0.0.1', port: 7420 });
    expect(c.pollSeconds).toBe(60);
    expect(c.dropZones[0]).toMatchObject({
      readyLabel: 'agent-ready',
      model: 'claude-opus-5-5',
      maxTurns: 200,
    });
    expect(c.dropZones[0]?.gates[0]?.timeoutMinutes).toBe(20);
    expect(c.secrets).toEqual({
      claudeToken: 'a',
      githubAuthorToken: 'b',
      githubReviewerToken: 'r',
      joinToken: 'c',
    });
    expect(c.usage).toEqual({
      throttleUtilization: 0.9,
      probeJitterSeconds: [30, 90],
    });
  });

  test('rejects a repo that is not owner/name', () => {
    const bad = fixture({
      dataDir: 'd',
      dropZones: [{ id: 'z', repo: 'nope', gates: [], image: 'i' }],
    });
    expect(() => loadConfig(bad, fullEnv)).toThrow(/repo/);
  });

  test('reviewer token is required', () =>
    expect(() => loadConfig(minimal, { ...fullEnv, JM_GITHUB_REVIEWER_TOKEN: undefined })).toThrow(
      /JM_GITHUB_REVIEWER_TOKEN/,
    ));

  test('reviewer and author must differ', () =>
    expect(() =>
      loadConfig(minimal, {
        ...fullEnv,
        JM_GITHUB_REVIEWER_TOKEN: fullEnv.JM_GITHUB_AUTHOR_TOKEN,
      }),
    ).toThrow(/must differ/));

  test('M1 defaults', () =>
    expect(loadConfig(minimal, fullEnv).dropZones[0]).toMatchObject({
      ciRequired: true,
      ciDeadlineMinutes: 45,
      retryLabel: 'agent-retry',
      mergeMethod: 'squash',
      requireBranchProtection: true,
      reviewReadToken: false,
      models: {},
      budgets: {
        maxHeal: 3,
        maxResolve: 2,
        maxResolveTotal: 6,
        maxResume: 2,
        maxReviewRepeat: 2,
        maxNoChange: 1,
      },
    }));

  test('mergeMethod other than squash is refused', () =>
    expect(() => loadConfig(withZone({ mergeMethod: 'rebase' }), fullEnv)).toThrow());

  test('protectedPaths default list', () => {
    const paths = loadConfig(minimal, fullEnv).dropZones[0]?.protectedPaths;
    expect(paths).toContain('.github/**');
    expect(paths).toContain('playwright.config.*');
    expect(paths).toHaveLength(17);
  });

  test('read token is optional and passed through', () => {
    expect(loadConfig(minimal, fullEnv).secrets.githubReadToken).toBeUndefined();
    expect(
      loadConfig(minimal, { ...fullEnv, JM_GITHUB_READ_TOKEN: 'rd' }).secrets.githubReadToken,
    ).toBe('rd');
  });

  test('modelFor falls back to zone model', () => {
    const zone = loadConfig(withZone({ models: { review: 'r' } }), fullEnv).dropZones[0];
    if (!zone) throw new Error('no zone');
    expect(modelFor(zone, 'heal')).toBe(zone.model);
    expect(modelFor(zone, 'review')).toBe('r');
  });

  test('secretList omits an absent read token', () => {
    const c = loadConfig(minimal, fullEnv);
    expect(secretList(c.secrets).sort()).toEqual(['a', 'b', 'c', 'r']);
    expect(secretList({ ...c.secrets, githubReadToken: 'rd' })).toContain('rd');
  });
});
