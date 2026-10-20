import { execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
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
  authHeader,
  checkoutBranch,
  cloneForGates,
  cloneRepo,
  commitIfDirty,
  headSha,
  mergeBase,
  mirrorFetch,
  prepareBranch,
  pushExistingBranch,
  pushNewBranch,
  remoteBranchSha,
  runGit,
  setSpawn,
} from './git.js';

let tmp: string;
const B = 'agent/issue-1';
const guard = { base: 'main', protectedPaths: ['.github/**'] };
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
  const s0 = await pushNewBranch(dir, B, 't', target);
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

describe('root git never runs in the working copy', () => {
  test('planted fsmonitor, hook and clean filter never run on the root path', async () => {
    const w = await world('planted');
    writeFileSync(join(w.dir, 'c.txt'), 'c\n');
    await commitIfDirty(w.dir, 'feat: c');
    const marker = join(w.base, 'marker');
    const script = join(w.base, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
    chmodSync(script, 0o755);
    git(w.dir, 'config', 'core.fsmonitor', script);
    git(w.dir, 'config', 'filter.x.clean', script);
    writeFileSync(join(w.dir, '.git/info/attributes'), '* filter=x\n');
    const hook = join(w.dir, '.git/hooks/pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran >> ${marker}\n`);
    chmodSync(hook, 0o755);
    await pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard);
    expect(existsSync(marker)).toBe(false);
  });

  test('every token-bearing git call sets GIT_DIR outside the working copy', async () => {
    const w = await world('tokencalls');
    writeFileSync(join(w.dir, 'd.txt'), 'd\n');
    await commitIfDirty(w.dir, 'feat: d');
    const rec = recordSpawn();
    await pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard);
    const tokenCalls = rec.calls.filter((c) =>
      Object.values(c.env).some((v) => String(v).includes(authHeader('t'))),
    );
    expect(tokenCalls.length).toBeGreaterThan(0);
    for (const c of tokenCalls) {
      expect(c.env.GIT_DIR).toBeTruthy();
      expect(c.env.GIT_DIR?.startsWith(w.dir)).toBe(false);
      expect(c.env.GIT_COMMON_DIR).toBe(c.env.GIT_DIR);
      expect(c.cwd?.startsWith(w.dir) ?? false).toBe(false);
    }
  });

  test('the push fetch takes only the branch ref', async () => {
    const w = await world('onlyref');
    git(w.dir, 'branch', 'evil');
    writeFileSync(join(w.dir, 'e.txt'), 'e\n');
    await commitIfDirty(w.dir, 'feat: e');
    const rec = recordSpawn();
    await pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard);
    const fetch = rec.calls.find(
      (c) => c.argv.includes('fetch') && c.argv.includes(`file://${w.dir}`),
    );
    expect(fetch?.argv.filter((a) => a.includes('refs/'))).toEqual([
      `+refs/heads/${B}:refs/heads/${B}`,
    ]);
  });

  test('second sweep runs after the tokenless fetch', async () => {
    const w = await world('order');
    writeFileSync(join(w.dir, 'o.txt'), 'o\n');
    await commitIfDirty(w.dir, 'feat: o');
    const order: string[] = [];
    recordSpawn((c) => {
      if (c.argv.includes('fetch') && c.argv.includes(`file://${w.dir}`)) order.push('agent-fetch');
      if (c.argv.includes('push')) order.push('push');
    });
    await pushExistingBranch(w.dir, B, 't', w.target, w.s0, () => void order.push('sweep'), guard);
    expect(order).toEqual(['sweep', 'agent-fetch', 'sweep', 'push']);
  });

  test('a planted commondir in the bare repo does not change the push config', async () => {
    const w = await world('commondir');
    writeFileSync(join(w.dir, 'k.txt'), 'k\n');
    await commitIfDirty(w.dir, 'feat: k');
    const decoy = join(w.base, 'decoy.git');
    git(w.base, 'init', '--bare', '-q', decoy);
    const evil = join(w.base, 'evil-common');
    git(w.base, 'init', '--bare', '-q', evil);
    git(evil, 'config', `url.file://${decoy}.insteadOf`, w.target.url);
    recordSpawn((c) => {
      if (c.argv.includes('fetch') && c.argv.includes(`file://${w.dir}`) && c.env.GIT_DIR) {
        writeFileSync(join(c.env.GIT_DIR, 'commondir'), `${evil}\n`);
      }
    });
    await pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard);
    expect(w.remoteTip()).toBe(await headSha(w.dir));
    expect(git(decoy, 'for-each-ref')).toBe('');
  });
});

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

describe('the pre-push guard', () => {
  test('push refuses a protected path, including a rename source', async () => {
    const w = await world('protected');
    git(w.dir, 'mv', '.github/x.yml', 'y.yml');
    await commitIfDirty(w.dir, 'chore: move');
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard),
    ).rejects.toThrow(/^protected path \.github\/x\.yml/);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('push refuses a commit with a foreign author', async () => {
    const w = await world('foreign');
    git(
      w.dir,
      '-c',
      'user.name=Mallory',
      '-c',
      'user.email=m@x',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard),
    ).rejects.toThrow(/^foreign commit identity/);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('a resolve merge of human base commits passes the identity check', async () => {
    const w = await world('resolvemerge');
    const h = w.human();
    writeFileSync(join(h, 'h.txt'), 'h\n');
    git(h, 'add', '.');
    git(h, 'commit', '-q', '-m', 'human work');
    git(h, 'push', '-q', 'origin', 'main');
    await mirrorFetch(w.mirror, 't', w.target, ['main']);
    expect(await mergeBase(w.dir, 'main', null)).toBe('clean');
    await expect(pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard)).resolves.toBe(
      await headSha(w.dir),
    );
  });

  test('an agent origin/<base> pointing at its own tip does not bypass the guard', async () => {
    const w = await world('fakebase');
    git(w.dir, 'mv', '.github/x.yml', 'y.yml');
    await commitIfDirty(w.dir, 'chore: move');
    git(w.dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard),
    ).rejects.toThrow(/^protected path/);
  });

  test('human commits already on the remote pass the identity check', async () => {
    const w = await world('humanonremote');
    const h = w.human();
    git(h, 'switch', '-q', B);
    writeFileSync(join(h, 'hh.txt'), 'hh\n');
    git(h, 'add', '.');
    git(h, 'commit', '-q', '-m', 'human fix');
    git(h, 'push', '-q', 'origin', B);
    const s1 = w.remoteTip();
    await mirrorFetch(w.mirror, 't', w.target, [B]);
    await checkoutBranch(w.dir, B, s1, null);
    writeFileSync(join(w.dir, 'ag.txt'), 'ag\n');
    await commitIfDirty(w.dir, 'feat: agent on top');
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, s1, undefined, guard),
    ).resolves.toBeTruthy();
  });

  test('pushExistingBranch refuses when the remote moved', async () => {
    const w = await world('moved');
    const h = w.human();
    git(h, 'switch', '-q', B);
    git(h, 'commit', '-q', '--allow-empty', '-m', 'move');
    git(h, 'push', '-q', 'origin', B);
    writeFileSync(join(w.dir, 'm.txt'), 'm\n');
    await commitIfDirty(w.dir, 'feat: m');
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, guard),
    ).rejects.toThrow(/^stale info/);
  });

  test('an oversized or slow agent pack aborts the push', async () => {
    const w = await world('bigpack');
    writeFileSync(
      join(w.dir, 'big.bin'),
      Buffer.from(Array.from({ length: 2_000_000 }, () => Math.floor(Math.random() * 256))),
    );
    await commitIfDirty(w.dir, 'feat: big');
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, {
        ...guard,
        limits: { timeoutMs: 120_000, maxBytes: 1_000_000 },
      }),
    ).rejects.toThrow(/push fetch (too large|timed out)/);
    await expect(
      pushExistingBranch(w.dir, B, 't', w.target, w.s0, undefined, {
        ...guard,
        limits: { timeoutMs: 1, maxBytes: 1e12 },
      }),
    ).rejects.toThrow(/push fetch (too large|timed out)/);
    expect(w.remoteTip()).toBe(w.s0);
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
