import { execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertRootOwnedDir,
  checkoutBranch,
  cloneForGates,
  cloneRepo,
  commitIfDirty,
  mergeBase,
  mirrorFetch,
  prepareBranch,
  remoteBranchSha,
  removeInstructionFiles,
  runGit,
  setSpawn,
} from './git.js';

let tmp: string;
const B = 'agent/issue-1';
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

type Call = { argv: string[]; cwd: string | undefined; env: NodeJS.ProcessEnv };
function recordSpawn(cb?: (c: Call) => void): { calls: Call[] } {
  const calls: Call[] = [];
  setSpawn((cmd, args, opts: SpawnOptions) => {
    const c: Call = {
      argv: [cmd, ...args],
      cwd: opts.cwd as string | undefined,
      env: (opts.env ?? {}) as NodeJS.ProcessEnv,
    };
    calls.push(c);
    cb?.(c);
    return spawn(cmd, args, opts);
  });
  return { calls };
}

beforeAll(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'gitguard-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setSpawn(null));

/** Own origin (main: a.txt, .github/x.yml by a human), a working copy with B pushed at s0. */
async function world(name: string) {
  const base = join(tmp, name);
  mkdirSync(base);
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  git(base, 'init', '--bare', '-q', '-b', 'main', origin);
  git(base, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'Human');
  git(seed, 'config', 'user.email', 'human@example.com');
  mkdirSync(join(seed, '.github'));
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  writeFileSync(join(seed, '.github/x.yml'), 'x: 1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', origin, 'main');
  const target = { owner: 'o', name: 'r', url: `file://${origin}` };
  const dir = join(base, 'repo');
  const mirror = join(base, 'mirror');
  await cloneRepo({ owner: 'o', name: 'r', token: 't', dir, mirrorDir: mirror, url: target.url });
  await prepareBranch(dir, B, 'main');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  await commitIfDirty(dir, 'feat: b');
  // Seed the remote branch with plain git: the agent's first commit, as an earlier push left it.
  git(dir, 'push', '-q', origin, `HEAD:refs/heads/${B}`);
  const s0 = git(dir, 'rev-parse', 'HEAD');
  const remoteTip = (b = B) => git(origin, 'rev-parse', `refs/heads/${b}`);
  /** A human clone of origin, for moving the remote. */
  const human = () => {
    const h = join(base, `human-${Math.random().toString(36).slice(2)}`);
    git(base, 'clone', '-q', origin, h);
    git(h, 'config', 'user.name', 'Human');
    git(h, 'config', 'user.email', 'human@example.com');
    return h;
  };
  return { base, origin, seed, target, dir, mirror, s0, remoteTip, human };
}

describe('the root mirror', () => {
  test('a symlinked or renamed mirror makes mirrorFetch throw', async () => {
    const w = await world('mirrorswap');
    const evilRepo = join(w.base, 'evil.git');
    git(w.base, 'init', '--bare', '-q', evilRepo);
    renameSync(w.mirror, `${w.mirror}.x`);
    symlinkSync(evilRepo, w.mirror);
    await expect(mirrorFetch(w.mirror, 't', w.target, ['main'])).rejects.toThrow(
      /unsafe root git dir/,
    );
  });

  test('assertRootOwnedDir rejects a writable or symlinked ancestor', () => {
    const parent = mkdtempSync(join(tmp, 'own-'));
    const child = join(parent, 'c');
    mkdirSync(child);
    expect(() => assertRootOwnedDir(child)).not.toThrow();
    chmodSync(parent, 0o777);
    expect(() => assertRootOwnedDir(child, () => 0)).toThrow(/^unsafe root git dir: /);
    chmodSync(parent, 0o755);
    const link = join(tmp, `link-${Math.random().toString(36).slice(2)}`);
    symlinkSync(child, link);
    expect(() => assertRootOwnedDir(link, () => 0)).toThrow(/^unsafe root git dir: /);
    expect(() => assertRootOwnedDir(link)).toThrow(/^unsafe root git dir: /);
  });
});

describe('working copy and helpers', () => {
  test('extra config appends after the auth header', async () => {
    const w = await world('extracfg');
    const rec = recordSpawn();
    await runGit(undefined, ['rev-parse', '--git-dir'], 't', {
      gitDir: w.mirror,
      extraConfig: [['a.b', 'c']],
    });
    const env = rec.calls[0]?.env ?? {};
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_CONFIG_KEY_1).toBe('a.b');
    expect(env.GIT_CONFIG_VALUE_1).toBe('c');
  });

  test('runGit refuses a token with an agent identity or outside a root git dir', async () => {
    await expect(
      runGit(tmp, ['status'], 't', { as: { uid: 10001, gid: 10001, home: '/h' } }),
    ).rejects.toThrow(/agent identity/);
    await expect(runGit(tmp, ['status'], 't')).rejects.toThrow(/root-owned git dir/);
  });

  test('checkoutBranch detects a moved head', async () => {
    const w = await world('headmoved');
    await mirrorFetch(w.mirror, 't', w.target, [B]);
    await expect(checkoutBranch(w.dir, B, 'f'.repeat(40), null)).rejects.toThrow(
      /^head moved: expected f+ got [0-9a-f]+/,
    );
  });

  test('mergeBase reports conflicts and leaves markers', async () => {
    const w = await world('conflict');
    const h = w.human();
    writeFileSync(join(h, 'a.txt'), 'human\n');
    git(h, 'commit', '-q', '-am', 'human a');
    git(h, 'push', '-q', 'origin', 'main');
    writeFileSync(join(w.dir, 'a.txt'), 'agent\n');
    await commitIfDirty(w.dir, 'feat: agent a');
    await mirrorFetch(w.mirror, 't', w.target, ['main']);
    expect(await mergeBase(w.dir, 'main', null)).toBe('conflicts');
    expect(readFileSync(join(w.dir, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  });

  test('mergeBase reports up_to_date when base has not moved', async () => {
    const w = await world('uptodate');
    await mirrorFetch(w.mirror, 't', w.target, ['main']);
    expect(await mergeBase(w.dir, 'main', null)).toBe('up_to_date');
  });

  test('remoteBranchSha returns the tip or null', async () => {
    const w = await world('lsr');
    expect(await remoteBranchSha(w.target, B, 't')).toBe(w.s0);
    expect(await remoteBranchSha(w.target, 'agent/issue-404', 't')).toBeNull();
  });

  test('agent git calls trust exactly the root-owned mirror; root calls trust nothing', async () => {
    const agent = { uid: 10001, gid: 10001, home: '/home/agent' };
    const base = join(tmp, 'safe-dir');
    mkdirSync(base);
    const mirror = join(base, 'mirror');
    const calls: Call[] = [];
    setSpawn((cmd, args, opts) => {
      calls.push({
        argv: [cmd, ...args],
        cwd: opts.cwd as string,
        env: (opts.env ?? {}) as NodeJS.ProcessEnv,
      });
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    await cloneRepo({
      owner: 'o',
      name: 'r',
      token: 't',
      dir: '/home/agent/repo',
      mirrorDir: mirror,
      as: agent,
    });
    await mergeBase('/home/agent/repo', 'main', agent).catch(() => undefined);
    // git strips GIT_CONFIG_COUNT/PARAMETERS from a local upload-pack's env, but not
    // GIT_CONFIG_GLOBAL: agent calls get a root-written global config naming the mirror.
    const agentCalls = calls.filter((c) => c.argv.includes('--reuid=10001'));
    const rootCalls = calls.filter((c) => !c.argv.includes('setpriv'));
    expect(agentCalls.length).toBeGreaterThan(0);
    for (const c of agentCalls) {
      const file = c.env.GIT_CONFIG_GLOBAL ?? '';
      expect(file).not.toBe('/dev/null');
      expect(readFileSync(file, 'utf8')).toBe(`[safe]\n\tdirectory = ${mirror}\n`);
      const keys = Object.entries(c.env).filter(([k]) => /^GIT_CONFIG_KEY_\d+$/.test(k));
      expect(keys.map(([, v]) => v)).not.toContain('safe.directory');
    }
    expect(rootCalls.length).toBeGreaterThan(0);
    for (const c of rootCalls) expect(c.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  test('an agent git call starts in / and enters its 0700 working copy after the uid drop', async () => {
    const agent = { uid: 10001, gid: 10001, home: '/home/agent' };
    const calls: Call[] = [];
    setSpawn((cmd, args, opts) => {
      calls.push({ argv: [cmd, ...args], cwd: opts.cwd as string, env: {} });
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    await commitIfDirty('/home/agent/repo', 'm', agent);
    await removeInstructionFiles('/home/agent/repo', agent);
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c.cwd).toBe('/');
      const at = c.argv.indexOf('jm-agent');
      expect(c.argv.slice(at - 1, at + 2)).toEqual([
        'umask 022; cd -- "$1" && shift && exec "$@"',
        'jm-agent',
        '/home/agent/repo',
      ]);
    }
  });

  test('cloneForGates runs no git in the agent repo as the gate uid', async () => {
    const fakeIds = {
      agent: { uid: 10001, gid: 10001, home: '/home/agent' },
      gate: { uid: 10002, gid: 10002, home: '/home/gate' },
    };
    const dir = '/home/agent/repo';
    const calls: Call[] = [];
    setSpawn((cmd, args, opts) => {
      calls.push({ argv: [cmd, ...args], cwd: opts.cwd as string, env: {} });
      const child = new EventEmitter() as ReturnType<typeof spawn>;
      Object.assign(child, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    await cloneForGates(dir, '/home/gate/repo', fakeIds);
    const gateCalls = calls.filter((c) => c.argv.includes(`--reuid=${fakeIds.gate.uid}`));
    expect(gateCalls.length).toBeGreaterThan(0);
    for (const c of gateCalls) {
      expect(c.cwd?.startsWith(dir) ?? false).toBe(false);
      expect(c.argv.join(' ')).not.toContain(` ${dir}`);
    }
  });
});
