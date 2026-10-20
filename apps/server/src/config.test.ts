import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.js';

const fullEnv = { JM_CLAUDE_TOKEN: 'a', JM_GITHUB_AUTHOR_TOKEN: 'b', JM_JOIN_TOKEN: 'c' };

function fixture(json: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jm-config-')), 'jumpmaster.config.json');
  writeFileSync(file, JSON.stringify(json));
  return file;
}

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
  test('missing JM_CLAUDE_TOKEN is a config error', () =>
    expect(() => loadConfig(minimal, { JM_GITHUB_AUTHOR_TOKEN: 'x', JM_JOIN_TOKEN: 'y' })).toThrow(
      /JM_CLAUDE_TOKEN/,
    ));

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
    expect(c.secrets).toEqual({ claudeToken: 'a', githubAuthorToken: 'b', joinToken: 'c' });
  });

  test('rejects a repo that is not owner/name', () => {
    const bad = fixture({
      dataDir: 'd',
      dropZones: [{ id: 'z', repo: 'nope', gates: [], image: 'i' }],
    });
    expect(() => loadConfig(bad, fullEnv)).toThrow(/repo/);
  });
});
