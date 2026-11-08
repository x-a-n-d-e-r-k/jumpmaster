import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { joinToken, loadEnrollment, saveEnrollment, stateDir } from './state.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'jm-stick-'));

describe('stick state', () => {
  test('JM_STATE_DIR names the state directory; the default stays ~/.jumpmaster', () => {
    expect(stateDir({ JM_STATE_DIR: '/state' })).toBe('/state');
    expect(stateDir({})).toBe(join(homedir(), '.jumpmaster'));
  });

  test('the stick keeps stick.json under JM_STATE_DIR with mode 0600', () => {
    const dir = join(fresh(), 'state');
    saveEnrollment(stateDir({ JM_STATE_DIR: dir }), {
      serverUrl: 'http://jm:7420',
      stickId: 's1',
      stickToken: 't1',
    });
    const file = join(dir, 'stick.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(loadEnrollment(dir, 'http://jm:7420')).toEqual({ stickId: 's1', stickToken: 't1' });
    // An enrollment for another server is not reused.
    expect(loadEnrollment(dir, 'http://other:7420')).toBeUndefined();
    expect(loadEnrollment(fresh(), 'http://jm:7420')).toBeUndefined();
  });

  test('the join token comes from JM_JOIN_TOKEN or JM_JOIN_TOKEN_FILE', () => {
    const file = join(fresh(), 'join');
    writeFileSync(file, 'join-token-value\n', { mode: 0o600 });
    expect(joinToken({ JM_JOIN_TOKEN_FILE: file })).toBe('join-token-value');
    expect(joinToken({ JM_JOIN_TOKEN: 'from-env' })).toBe('from-env');
    expect(() => joinToken({})).toThrow('JM_JOIN_TOKEN or JM_JOIN_TOKEN_FILE is required');
    expect(() => joinToken({ JM_JOIN_TOKEN: 'x', JM_JOIN_TOKEN_FILE: file })).toThrow(
      /JM_JOIN_TOKEN and JM_JOIN_TOKEN_FILE/,
    );
  });
});

describe('stick entry point', () => {
  // The built entry must run main() however it is launched; a guard that silently returned would
  // leave a stick that exits 0 and runs nothing. Needs `npx tsc -b` (CI's typecheck step).
  const dist = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const wrapper = join(fresh(), 'wrapper.mjs');
  writeFileSync(wrapper, `import ${JSON.stringify(pathToFileURL(dist).href)};\n`);
  const launches: [string, string][] = [
    ['main.js', dist],
    ['main without the .js extension', dist.replace(/\.js$/, '')],
    ['a wrapper that imports it', wrapper],
  ];

  test.each(launches)('launched as %s, it runs and reports missing config', (_how, path) => {
    expect(existsSync(dist), 'build first: npx tsc -b').toBe(true);
    const env = { ...process.env, JM_SERVER_URL: '', JM_STATE_DIR: fresh() };
    const child = spawnSync(process.execPath, [path], { encoding: 'utf8', env, timeout: 10_000 });
    expect(child.stderr).toContain('JM_SERVER_URL is required');
    expect(child.status).toBe(1);
  });
});
