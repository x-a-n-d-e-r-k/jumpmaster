import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  advertisedCapabilities,
  enrollCredential,
  enrollStick,
  joinToken,
  loadEnrollment,
  loadRelease,
  RELEASE_FILE,
  saveEnrollment,
  stateDir,
  stickVersion,
} from './state.js';

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

describe('enrolling with a one-time code (issue #138)', () => {
  test('JM_ENROLL_CODE or JM_ENROLL_CODE_FILE is sent instead of the join token', () => {
    const file = join(fresh(), 'enroll_code');
    writeFileSync(file, 'jm_enroll_from-file\n', { mode: 0o600 });
    expect(enrollCredential({ JM_ENROLL_CODE_FILE: file, JM_JOIN_TOKEN: 'j' })).toEqual({
      enrollCode: 'jm_enroll_from-file',
    });
    expect(enrollCredential({ JM_ENROLL_CODE: 'jm_enroll_env' })).toEqual({
      enrollCode: 'jm_enroll_env',
    });
    // Without a code, the join token as ever.
    expect(enrollCredential({ JM_JOIN_TOKEN: 'join' })).toEqual({ joinToken: 'join' });
    expect(() => enrollCredential({})).toThrow(
      'JM_JOIN_TOKEN or JM_JOIN_TOKEN_FILE (or JM_ENROLL_CODE_FILE) is required',
    );
  });

  test('a stick enrolling with a code file leaves no file behind', async () => {
    const dir = fresh();
    const file = join(dir, 'enroll_code');
    writeFileSync(file, 'jm_enroll_once\n', { mode: 0o600 });
    const sent: unknown[] = [];
    const lines: string[] = [];
    const client = {
      enroll: async (cred: unknown, name: string, slots: number) => {
        sent.push({ cred, name, slots });
        return { stickId: 's9', stickToken: 't9', name: 'vps-1' };
      },
    };
    const env = { JM_ENROLL_CODE_FILE: file, JM_STICK_NAME: 'stick' };
    const stickId = await enrollStick(client, env, dir, 'http://jm:7420', 2, (l) => lines.push(l));
    expect(stickId).toBe('s9');
    expect(sent).toEqual([{ cred: { enrollCode: 'jm_enroll_once' }, name: 'stick', slots: 2 }]);
    expect(existsSync(file)).toBe(false);
    expect(loadEnrollment(dir, 'http://jm:7420')).toEqual({ stickId: 's9', stickToken: 't9' });
    expect(lines).toEqual(['enrolled as vps-1 (s9)']);
    // A refused enrollment keeps the file (the installer reports the error; a retry can use it).
    writeFileSync(file, 'jm_enroll_twice\n', { mode: 0o600 });
    const refusing = {
      enroll: async () => {
        throw new Error('enroll: 401');
      },
    };
    await expect(
      enrollStick(refusing, env, fresh(), 'http://jm:7420', 1, () => {}),
    ).rejects.toThrow('enroll: 401');
    expect(existsSync(file)).toBe(true);
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

  test('an invalid JM_MAX_SLOTS fails at start with a clear message', () => {
    expect(existsSync(dist), 'build first: npx tsc -b').toBe(true);
    const env = {
      ...process.env,
      JM_SERVER_URL: 'http://127.0.0.1:1',
      JM_MAX_SLOTS: 'abc',
      JM_STATE_DIR: fresh(),
    };
    const child = spawnSync(process.execPath, [dist], { encoding: 'utf8', env, timeout: 10_000 });
    expect(child.stderr).toContain('JM_MAX_SLOTS must be an integer of 1 or more, not abc');
    expect(child.status).toBe(1);
  });

  test.each(['10.0.0.1', 'a.example.com,,b.example.com', '*'])(
    'an invalid JM_EGRESS_CEILING (%s) stops the stick at start, never read as no ceiling',
    (v) => {
      expect(existsSync(dist), 'build first: npx tsc -b').toBe(true);
      const env = {
        ...process.env,
        JM_SERVER_URL: 'http://127.0.0.1:1',
        JM_EGRESS_CEILING: v,
        JM_STATE_DIR: fresh(),
      };
      const child = spawnSync(process.execPath, [dist], { encoding: 'utf8', env, timeout: 10_000 });
      expect(child.stderr).toMatch(/^JM_EGRESS_CEILING/m);
      expect(child.status).toBe(1);
    },
  );
});

describe('the version the stick reports', () => {
  test('a release stick reports its release; a build without one reports its package version as -dev', () => {
    expect(stickVersion({ version: '0.4.0-rc.1', repository: 'o/r' })).toBe('0.4.0-rc.1');
    expect(stickVersion({ version: null, repository: 'o/r' })).toMatch(/^\d+\.\d+\.\d+-dev$/);
    expect(stickVersion(undefined)).toMatch(/-dev$/);
    expect(stickVersion(undefined)).not.toBe('0.0.0');
  });

  test('loadRelease reads the file the image build writes, and nothing else counts', () => {
    const dir = fresh();
    const file = join(dir, 'release.json');
    writeFileSync(file, JSON.stringify({ version: '1.2.3', repository: 'o/r' }));
    expect(loadRelease(file)).toEqual({ version: '1.2.3', repository: 'o/r' });
    writeFileSync(file, JSON.stringify({ version: '', repository: 7 }));
    expect(loadRelease(file)).toEqual({ version: null, repository: null });
    writeFileSync(file, 'not json');
    expect(loadRelease(file)).toBeUndefined();
    expect(loadRelease(join(dir, 'absent.json'))).toBeUndefined();
    // In the image, /app/release.json sits three levels above dist/state.js.
    expect(RELEASE_FILE.pathname.endsWith('/release.json')).toBe(true);
  });
});

test('a stick advertises image-verify-v1 only under the signed policy', () => {
  expect(advertisedCapabilities({ egress: false, policy: 'allowlist' })).toEqual([]);
  expect(advertisedCapabilities({ egress: true, policy: 'allowlist' })).toEqual(['egress-v1']);
  expect(advertisedCapabilities({ egress: false, policy: 'signed' })).toEqual(['image-verify-v1']);
  expect(advertisedCapabilities({ egress: true, policy: 'signed' })).toEqual([
    'egress-v1',
    'image-verify-v1',
  ]);
});
