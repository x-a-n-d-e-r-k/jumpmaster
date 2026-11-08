import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { joinToken, loadEnrollment, saveEnrollment, stateDir } from './main.js';

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
