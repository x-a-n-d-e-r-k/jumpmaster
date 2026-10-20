import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  agentSpawnOptions,
  asAgentArgv,
  readAgentFile,
  sweepUid,
  trooperIdentities,
} from './privilege.js';

const containerEnv = {
  JM_CONTAINER: '1',
  JM_AGENT_UID: '10001',
  JM_AGENT_GID: '10001',
  JM_AGENT_HOME: '/home/agent',
  JM_GATE_UID: '10002',
  JM_GATE_GID: '10002',
  JM_GATE_HOME: '/home/gate',
};

function fakeProc(procs: Record<number, { ruid: number; euid: number }>): string {
  const root = mkdtempSync(join(tmpdir(), 'jm-proc-'));
  for (const [pid, { ruid, euid }] of Object.entries(procs)) {
    mkdirSync(join(root, pid));
    writeFileSync(
      join(root, pid, 'status'),
      `Name:\tnode\nPid:\t${pid}\nUid:\t${ruid}\t${euid}\t${euid}\t${euid}\nGid:\t0\t0\t0\t0\n`,
    );
  }
  mkdirSync(join(root, 'self')); // non-numeric entries are ignored
  return root;
}

describe('trooperIdentities', () => {
  test('no identity outside container mode', () =>
    expect(trooperIdentities({}, () => 0)).toBeNull());

  test('no identity when not root', () =>
    expect(trooperIdentities(containerEnv, () => 1000)).toBeNull());

  test('identity in container as root', () =>
    expect(trooperIdentities(containerEnv, () => 0)).toEqual({
      agent: { uid: 10001, gid: 10001, home: '/home/agent' },
      gate: { uid: 10002, gid: 10002, home: '/home/gate' },
    }));

  test('gate and agent are distinct uids with distinct homes', () => {
    const ids = trooperIdentities(containerEnv, () => 0);
    if (!ids) throw new Error('no identities');
    expect(ids.gate.uid).not.toBe(ids.agent.uid);
    expect(ids.gate.home).not.toBe(ids.agent.home);
  });

  test('a missing or root uid in the env gives no identity', () => {
    expect(trooperIdentities({ ...containerEnv, JM_GATE_UID: undefined }, () => 0)).toBeNull();
    expect(trooperIdentities({ ...containerEnv, JM_AGENT_UID: '0' }, () => 0)).toBeNull();
  });
});

describe('sweepUid', () => {
  test('sweepUid kills only that uid', () => {
    const proc = fakeProc({
      10: { ruid: 10001, euid: 10001 },
      11: { ruid: 0, euid: 10001 },
      12: { ruid: 10002, euid: 10002 },
      1: { ruid: 0, euid: 0 },
    });
    const killed: number[] = [];
    expect(sweepUid(10001, (pid) => void killed.push(pid), proc)).toBe(2);
    expect(killed.sort()).toEqual([10, 11]);
  });

  test('a process that exits during the sweep is skipped', () => {
    const proc = fakeProc({ 20: { ruid: 10001, euid: 10001 } });
    const kill = () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    expect(sweepUid(10001, kill, proc)).toBe(0);
  });
});

describe('spawning as another uid', () => {
  const ids = trooperIdentities(containerEnv, () => 0);
  if (!ids) throw new Error('no identities');

  test('asAgentArgv wraps with setpriv', () =>
    expect(asAgentArgv(ids.agent, ['git', 'status'])).toEqual([
      'setpriv',
      '--reuid=10001',
      '--regid=10001',
      '--clear-groups',
      '--',
      'sh',
      '-c',
      'umask 022; exec "$@"',
      'jm-agent',
      'git',
      'status',
    ]));

  test('without an identity argv is unchanged', () =>
    expect(asAgentArgv(null, ['git', 'status'])).toEqual(['git', 'status']));

  test('the agent argv sets umask 0022 and no supplementary group', () => {
    const a = asAgentArgv(ids.agent, ['x']);
    expect(a).toContain('--clear-groups');
    expect(a).toContain('umask 022; exec "$@"');
    expect(a.at(-1)).toBe('x');
    expect(agentSpawnOptions(ids.agent, {})).not.toHaveProperty('umask');
  });

  test('spawn options set HOME and CLAUDE_CONFIG_DIR', () => {
    expect(agentSpawnOptions(ids.agent, { PATH: '/bin', HOME: '/root' })).toEqual({
      env: { PATH: '/bin', HOME: '/home/agent', CLAUDE_CONFIG_DIR: '/home/agent/.claude' },
    });
    expect(agentSpawnOptions(null, { HOME: '/root' })).toEqual({ env: { HOME: '/root' } });
  });
});

describe('readAgentFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-read-'));

  test('reads a regular file', async () => {
    const p = join(dir, 'ok.txt');
    writeFileSync(p, 'hello');
    await expect(readAgentFile(p, null)).resolves.toBe('hello');
  });

  test('readAgentFile refuses a symlink', async () => {
    const p = join(dir, 'link');
    symlinkSync('/etc/hosts', p);
    await expect(readAgentFile(p, null)).rejects.toThrow();
  });

  test('refuses a file over maxBytes', async () => {
    const p = join(dir, 'big.txt');
    writeFileSync(p, 'x'.repeat(100));
    await expect(readAgentFile(p, null, 10)).rejects.toThrow(/too large/);
  });
});
