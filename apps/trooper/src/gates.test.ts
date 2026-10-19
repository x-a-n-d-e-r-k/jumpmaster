import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runGates, scrubEnv } from './gates.js';

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gates-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('gates cannot see credentials', async () => {
  const [r] = await runGates([{ name: 'env', run: 'env', timeoutMinutes: 1 }], {
    cwd: tmp,
    env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'tok', JM_X: 'y' },
    secrets: ['tok'],
  });
  expect(r!.outputTail).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN|JM_X/);
});

test('scrubEnv drops named keys, JM_ prefix and secret values', () => {
  const out = scrubEnv(
    {
      PATH: '/bin',
      GH_TOKEN: 'a',
      GITHUB_TOKEN: 'b',
      GIT_ASKPASS: 'c',
      ANTHROPIC_API_KEY: 'd',
      JM_Z: 'e',
      OTHER: 'leak',
      KEEP: 'ok',
    },
    ['leak'],
  );
  expect(out).toEqual({ PATH: '/bin', KEEP: 'ok' });
});

test('kills a gate past its timeout', async () => {
  const [r] = await runGates([{ name: 'hang', run: 'sleep 30', timeoutMinutes: 1 }], {
    cwd: tmp,
    env: process.env,
    secrets: [],
    timeoutScale: 200,
  });
  expect(r).toMatchObject({ timedOut: true, exitCode: null });
});

test('stops at first failure', async () => {
  const rs = await runGates(
    [
      { name: 'a', run: 'exit 3', timeoutMinutes: 1 },
      { name: 'b', run: 'true', timeoutMinutes: 1 },
    ],
    { cwd: tmp, env: process.env, secrets: [] },
  );
  expect(rs.map((r) => [r.name, r.exitCode])).toEqual([['a', 3]]);
});

test('outputTail is redacted and capped at the last 4000 chars', async () => {
  const [r] = await runGates(
    [{ name: 'big', run: 'echo sekret; yes x | head -c 20000; echo; echo END', timeoutMinutes: 1 }],
    { cwd: tmp, env: process.env, secrets: ['sekret'] },
  );
  expect(r!.outputTail.length).toBeLessThanOrEqual(4000);
  expect(r!.outputTail.endsWith('END\n')).toBe(true);
  const [r2] = await runGates([{ name: 's', run: 'echo sekret', timeoutMinutes: 1 }], {
    cwd: tmp,
    env: process.env,
    secrets: ['sekret'],
  });
  expect(r2!.outputTail).toBe('[REDACTED]\n');
});
