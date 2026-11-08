import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig, modelFor, secretList, zoneSecrets } from './config.js';

const fullEnv: Record<string, string | undefined> = {
  JM_CLAUDE_TOKEN: 'a',
  JM_GITHUB_AUTHOR_TOKEN: 'b',
  JM_GITHUB_REVIEWER_TOKEN: 'r',
  JM_JOIN_TOKEN: 'c',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
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
    expect(c.listen).toMatchObject({ host: '127.0.0.1', port: 7420 });
    expect(c.pollSeconds).toBe(60);
    expect(c.dropZones[0]).toMatchObject({
      readyLabel: 'agent-ready',
      model: 'claude-opus-5-5',
      maxTurns: 200,
    });
    expect(c.dropZones[0]?.gates[0]?.timeoutMinutes).toBe(20);
    expect(c.secrets).toEqual({
      operatorToken: 'o'.repeat(32),
      claudeToken: 'a',
      githubAuthorToken: 'b',
      githubReviewerToken: 'r',
      joinToken: 'c',
    });
    expect(c.usage).toEqual({
      throttleUtilization: 0.9,
      probeJitterSeconds: [30, 90],
      stopOnOverage: true,
    });
  });

  test('rejects a repo that is not owner/name', () => {
    const bad = fixture({
      dataDir: 'd',
      dropZones: [{ id: 'z', repo: 'nope', gates: [], image: 'i' }],
    });
    expect(() => loadConfig(bad, fullEnv)).toThrow(/repo/);
  });

  test('the operator token is required, long, and unique', () => {
    expect(() => loadConfig(minimal, { ...fullEnv, JM_OPERATOR_TOKEN: undefined })).toThrow(
      /JM_OPERATOR_TOKEN/,
    );
    expect(() => loadConfig(minimal, { ...fullEnv, JM_OPERATOR_TOKEN: 'short' })).toThrow(
      /at least 32/,
    );
    const same = 'x'.repeat(32);
    expect(() =>
      loadConfig(minimal, { ...fullEnv, JM_OPERATOR_TOKEN: same, JM_JOIN_TOKEN: same }),
    ).toThrow(/must differ/);
  });

  test('allowed hosts default to loopback on the listen port', () => {
    expect(loadConfig(minimal, fullEnv).listen.allowedHosts).toEqual([
      '127.0.0.1:7420',
      'localhost:7420',
    ]);
  });

  test('a zone mode defaults to active', () =>
    expect(loadConfig(minimal, fullEnv).dropZones[0]?.mode).toBe('active'));

  test('reviewer token is required', () =>
    expect(() => loadConfig(minimal, { ...fullEnv, JM_GITHUB_REVIEWER_TOKEN: undefined })).toThrow(
      /JM_GITHUB_REVIEWER_TOKEN/,
    ));

  describe('services and limits', () => {
    test('default to none and the 512 process limit', () =>
      expect(loadConfig(minimal, fullEnv).dropZones[0]).toMatchObject({
        services: [],
        limits: { pids: 512 },
      }));

    test('a service name that is not a DNS label is refused', () =>
      expect(() =>
        loadConfig(withZone({ services: [{ name: 'Bad_Name', image: 'i', port: 1 }] }), fullEnv),
      ).toThrow(/services/));

    test('duplicate service names are refused', () =>
      expect(() =>
        loadConfig(
          withZone({
            services: [
              { name: 'db', image: 'i', port: 1 },
              { name: 'db', image: 'j', port: 2 },
            ],
          }),
          fullEnv,
        ),
      ).toThrow(/duplicate service/));
  });

  describe('gateSecrets', () => {
    const declared = () => withZone({ gateSecrets: ['TEST_DB_URL'] });
    const value = { JM_ZONE_SECRET_MAIN_TEST_DB_URL: 'postgres://local/test' };

    test('a declared secret with no env value stops the server at startup', () =>
      expect(() => loadConfig(declared(), fullEnv)).toThrow(/JM_ZONE_SECRET_MAIN_TEST_DB_URL/));

    test('a value under 8 characters is refused', () =>
      expect(() =>
        loadConfig(declared(), { ...fullEnv, JM_ZONE_SECRET_MAIN_TEST_DB_URL: 'short' }),
      ).toThrow(/at least 8/));

    test.each([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'CLAUDE_X',
      'GIT_DIR',
      'JM_X',
      'PATH',
      'HOME',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'lower',
    ])('the name %s is refused', (name) =>
      expect(() => loadConfig(withZone({ gateSecrets: [name] }), fullEnv)).toThrow(
        /gate secret name/,
      ),
    );

    test('values reach zoneSecrets and the redaction list', () => {
      const c = loadConfig(declared(), { ...fullEnv, ...value });
      expect(zoneSecrets(c, 'main')).toEqual({ TEST_DB_URL: 'postgres://local/test' });
      expect(secretList(c.secrets)).toContain('postgres://local/test');
    });

    test('a zone id with punctuation maps to an underscored variable', () => {
      const file = withZone({ id: 'my-zone', gateSecrets: ['A_B'] });
      expect(() => loadConfig(file, fullEnv)).toThrow(/JM_ZONE_SECRET_MY_ZONE_A_B/);
    });
  });

  describe('authorMayBeAdmin', () => {
    const optedIn = () => withZone({ authorMayBeAdmin: true });

    test('refuses an author token that is not fine-grained', () =>
      expect(() =>
        loadConfig(optedIn(), { ...fullEnv, JM_GITHUB_AUTHOR_TOKEN: 'ghp_classic' }),
      ).toThrow(/fine-grained/));

    test('accepts a fine-grained author token', () =>
      expect(
        loadConfig(optedIn(), { ...fullEnv, JM_GITHUB_AUTHOR_TOKEN: 'github_pat_x' }).dropZones[0]
          ?.authorMayBeAdmin,
      ).toBe(true));
  });

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
    expect(paths).toEqual(expect.arrayContaining(['pnpm-workspace.yaml', 'patches/**']));
    expect(paths).toHaveLength(29);
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
    expect(secretList(c.secrets).sort()).toEqual(['a', 'b', 'c', 'o'.repeat(32), 'r'].sort());
    expect(secretList({ ...c.secrets, githubReadToken: 'rd' })).toContain('rd');
  });
});

describe('crew config', () => {
  test('crew defaults keep a zone off, with botLogins empty', () => {
    const z = loadConfig(minimal, fullEnv).dropZones[0];
    expect(z?.crew).toEqual({
      enabled: false,
      goalPath: 'GOAL.md',
      cycleMinutes: 60,
      maxDropsPerDay: 24,
      stagedLabel: 'agent-staged',
      maxStaged: 3,
      refutePromotes: false,
      maxRefute: 2,
    });
    expect(z?.botLogins).toEqual([]);
  });

  test('crew.enabled with an unprotected goalPath is a config error', () => {
    expect(() =>
      loadConfig(withZone({ crew: { enabled: true, goalPath: 'docs/GOALS.md' } }), fullEnv),
    ).toThrow(/goalPath/);
    expect(() =>
      loadConfig(
        withZone({ crew: { enabled: true, goalPath: 'GOAL.md' }, protectedPaths: ['.github/**'] }),
        fullEnv,
      ),
    ).toThrow(/goalPath/);
    expect(
      loadConfig(withZone({ crew: { enabled: true } }), fullEnv).dropZones[0]?.crew.enabled,
    ).toBe(true);
    // Off, the path is not checked.
    expect(() =>
      loadConfig(withZone({ crew: { goalPath: 'docs/GOALS.md' } }), fullEnv),
    ).not.toThrow();
  });

  test('crew.enabled with stagedLabel equal to readyLabel is a config error', () => {
    expect(() =>
      loadConfig(withZone({ crew: { enabled: true, stagedLabel: 'agent-ready' } }), fullEnv),
    ).toThrow(/stagedLabel/);
  });

  test('claude defaults to the pro plan with no Fable and a weekly cap of 5', () => {
    expect(loadConfig(minimal, fullEnv).claude).toEqual({ plan: 'pro', fableWeeklyDropCap: 5 });
    const c = loadConfig(
      fixture({
        dataDir: './data',
        dropZones: [baseZone],
        claude: { plan: 'max', fableModel: 'claude-fable-1', fableWeeklyDropCap: 3 },
      }),
      fullEnv,
    );
    expect(c.claude).toEqual({ plan: 'max', fableModel: 'claude-fable-1', fableWeeklyDropCap: 3 });
    expect(() =>
      loadConfig(
        fixture({ dataDir: './data', dropZones: [baseZone], claude: { plan: 'gold' } }),
        fullEnv,
      ),
    ).toThrow(/claude.plan/);
  });

  test('mcp defaults to off, with a 256 KiB body limit, 20 writes and 600 calls an hour and 5 open briefings', () => {
    expect(loadConfig(minimal, fullEnv).mcp).toEqual({
      enabled: false,
      maxBodyBytes: 262_144,
      writesPerHour: 20,
      callsPerHour: 600,
      maxOpenBriefings: 5,
    });
    const c = loadConfig(
      fixture({
        dataDir: './data',
        dropZones: [baseZone],
        mcp: { enabled: true, writesPerHour: 3 },
      }),
      fullEnv,
    );
    expect(c.mcp).toMatchObject({ enabled: true, writesPerHour: 3, maxOpenBriefings: 5 });
    expect(() =>
      loadConfig(
        fixture({ dataDir: './data', dropZones: [baseZone], mcp: { enabled: 'yes' } }),
        fullEnv,
      ),
    ).toThrow(/mcp.enabled/);
  });

  test('a zone model naming Fable is a config error', () => {
    expect(() => loadConfig(withZone({ model: 'claude-Fable-1' }), fullEnv)).toThrow(/model/);
  });

  test('crew.maxRefute must be at least 1', () => {
    expect(() => loadConfig(withZone({ crew: { maxRefute: 0 } }), fullEnv)).toThrow(/maxRefute/);
  });
});

describe('shipped example config', () => {
  test('parses, declares the default plan, and ships crew and MCP disabled', () => {
    const example = new URL('../../../examples/jumpmaster.config.json', import.meta.url).pathname;
    const config = loadConfig(example, fullEnv);
    expect(config.claude.plan).toBe('pro');
    expect(config.claude.fableModel).toBeUndefined();
    expect(config.dropZones[0]?.crew.enabled).toBe(false);
    expect(config.mcp?.enabled).toBe(false);
    expect(JSON.parse(readFileSync(example, 'utf8')).mcp).toEqual({ enabled: false });
  });
});
