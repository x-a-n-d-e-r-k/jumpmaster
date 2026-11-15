import { execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PushGrant } from '@jumpmaster/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  authHeader,
  checkoutBranch,
  cloneRepo,
  commitIfDirty,
  headSha,
  mergeBase,
  mirrorFetch,
  prepareBranch,
  pushStaged,
  setSpawn,
  setWorkRoot,
  stageFromAgent,
} from './git.js';

let tmp: string;
let work: string;
const B = 'agent/issue-1';
const TOKEN = 'tok-0123456789abcdef-push';
const HARDENED =
  'env GIT_NO_LAZY_FETCH=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack';
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const noSweep = () => undefined;

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
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'gitpush-'));
  work = join(tmp, 'work');
  mkdirSync(work);
  setWorkRoot(work);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setSpawn(null));

const leftovers = () => readdirSync(work).filter((e) => e.startsWith('push-'));

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

type World = Awaited<ReturnType<typeof world>>;

const grantFor = (w: World, over: Partial<PushGrant> = {}): PushGrant => ({
  token: TOKEN,
  owner: 'o',
  name: 'r',
  branch: B,
  base: 'main',
  lease: w.s0,
  protectedPaths: ['.github/**'],
  secrets: [],
  ...over,
});

async function stage(w: World, branch = B) {
  const r = await stageFromAgent(w.dir, branch, { sweep: noSweep });
  if ('nothing' in r) throw new Error(`staged nothing: ${r.nothing}`);
  return r;
}

/** Stage B from the working copy, then push it with a grant against the world's origin. */
async function stageAndPush(w: World, over: Partial<PushGrant> = {}) {
  const grant = grantFor(w, over);
  const r = await stage(w, grant.branch);
  return pushStaged(r.pushDir, grant, { remoteUrl: w.target.url });
}

function markerScript(w: World, marker: string, name = 'evil.sh'): string {
  const script = join(w.base, name);
  writeFileSync(script, `#!/bin/sh\necho ran >> ${marker}\ncat\n`);
  chmodSync(script, 0o755);
  return script;
}

describe('stageFromAgent', () => {
  test('staging never runs root git in the working copy', async () => {
    const w = await world('planted');
    writeFileSync(join(w.dir, 'c.txt'), 'c\n');
    await commitIfDirty(w.dir, 'feat: c');
    const head = await headSha(w.dir);
    const marker = join(w.base, 'marker');
    const script = markerScript(w, marker);
    git(w.dir, 'config', 'core.fsmonitor', script);
    git(w.dir, 'config', 'filter.x.clean', script);
    git(w.dir, 'config', 'core.sshCommand', script);
    writeFileSync(join(w.dir, '.git/info/attributes'), '* filter=x\n');
    const evilHooks = join(w.base, 'evil-hooks');
    mkdirSync(evilHooks);
    for (const h of ['pre-commit', 'post-checkout', 'reference-transaction', 'post-upload-pack']) {
      for (const d of [evilHooks, join(w.dir, '.git/hooks')]) {
        writeFileSync(join(d, h), `#!/bin/sh\necho ran >> ${marker}\n`);
        chmodSync(join(d, h), 0o755);
      }
    }
    const included = join(w.base, 'included.gitconfig');
    writeFileSync(included, `[core]\n\thooksPath = ${evilHooks}\n\tfsmonitor = ${script}\n`);
    git(w.dir, 'config', 'includeIf.gitdir:/.path', included);
    const rec = recordSpawn();
    const r = await stage(w);
    expect(r.head).toBe(head);
    expect(existsSync(marker)).toBe(false);
    for (const c of rec.calls) {
      expect(c.cwd?.startsWith(w.dir) ?? false).toBe(false);
      expect(c.env.GIT_DIR?.startsWith(w.dir) ?? false).toBe(false);
    }
    rmSync(r.pushDir, { recursive: true, force: true });
  });

  test("upload-pack's fsmonitor and hooks are disabled", async () => {
    const w = await world('uploadpack');
    writeFileSync(join(w.dir, 'u.txt'), 'u\n');
    await commitIfDirty(w.dir, 'feat: u');
    const marker = join(w.base, 'marker');
    const script = markerScript(w, marker);
    git(w.dir, 'config', 'core.fsmonitor', script);
    for (const h of ['post-upload-pack', 'pre-upload-pack', 'reference-transaction']) {
      writeFileSync(join(w.dir, '.git/hooks', h), `#!/bin/sh\necho ran >> ${marker}\n`);
      chmodSync(join(w.dir, '.git/hooks', h), 0o755);
    }
    const rec = recordSpawn();
    const r = await stage(w);
    expect(existsSync(marker)).toBe(false);
    const fetch = rec.calls.find((c) => c.argv.includes(`file://${w.dir}`));
    const up = fetch?.argv.find((a) => a.startsWith('--upload-pack='));
    expect(up).toContain(HARDENED);
    expect(fetch?.argv.filter((a) => a.includes('refs/'))).toEqual([
      `+refs/heads/${B}:refs/heads/${B}`,
    ]);
    rmSync(r.pushDir, { recursive: true, force: true });
  });

  test('a promisor remote in the working copy is never fetched', async () => {
    const w = await world('promisor');
    writeFileSync(join(w.dir, 'p.txt'), 'promised blob\n');
    await commitIfDirty(w.dir, 'feat: p');
    const blob = git(w.dir, 'rev-parse', 'HEAD:p.txt');
    // A full copy that still has the blob, served through a marker upload-pack.
    const promisor = join(w.base, 'promisor.git');
    git(w.base, 'clone', '-q', '--bare', '--no-local', w.dir, promisor);
    git(promisor, 'fetch', '-q', `file://${w.dir}`, `+refs/heads/${B}:refs/heads/${B}`);
    const marker = join(w.base, 'marker');
    const up = join(w.base, 'marker-upload-pack.sh');
    writeFileSync(up, `#!/bin/sh\necho ran >> ${marker}\nexec git-upload-pack "$@"\n`);
    chmodSync(up, 0o755);
    git(w.dir, 'config', 'core.repositoryformatversion', '1');
    git(w.dir, 'config', 'extensions.partialClone', 'evil');
    git(w.dir, 'config', 'remote.evil.url', `file://${promisor}`);
    git(w.dir, 'config', 'remote.evil.promisor', 'true');
    git(w.dir, 'config', 'remote.evil.uploadpack', up);
    unlinkSync(join(w.dir, '.git/objects', blob.slice(0, 2), blob.slice(2)));
    await stageFromAgent(w.dir, B, { sweep: noSweep }).then(
      (r) => {
        if ('pushDir' in r) rmSync(r.pushDir, { recursive: true, force: true });
      },
      () => undefined,
    );
    expect(existsSync(marker)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  test('an oversized working copy fails before the token', async () => {
    const w = await world('oversized');
    writeFileSync(
      join(w.dir, 'big.bin'),
      Buffer.from(Array.from({ length: 1_000_000 }, () => Math.floor(Math.random() * 256))),
    );
    await commitIfDirty(w.dir, 'feat: big');
    const rec = recordSpawn();
    await expect(
      stageFromAgent(w.dir, B, {
        sweep: noSweep,
        limits: { timeoutMs: 120_000, maxBytes: 10_000 },
      }),
    ).rejects.toThrow(/^push fetch too large/);
    for (const c of rec.calls) {
      expect(Object.values(c.env).some((v) => String(v).includes('AUTHORIZATION'))).toBe(false);
    }
    expect(leftovers()).toEqual([]);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('a slow agent fetch times out before the token, and the sweep still runs', async () => {
    const w = await world('slow');
    const order: string[] = [];
    await expect(
      stageFromAgent(w.dir, B, {
        sweep: () => void order.push('sweep'),
        limits: { timeoutMs: 1, maxBytes: 1e12 },
      }),
    ).rejects.toThrow(/^push fetch timed out$/);
    expect(order).toEqual(['sweep', 'sweep']);
    expect(leftovers()).toEqual([]);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('a missing branch is nothing', async () => {
    const w = await world('missing');
    await expect(stageFromAgent(w.dir, 'agent/issue-404', { sweep: noSweep })).resolves.toEqual({
      nothing: 'branch not in the working copy',
    });
    expect(leftovers()).toEqual([]);
  });

  test('the sweep runs before and after the agent fetch', async () => {
    const w = await world('order');
    const order: string[] = [];
    recordSpawn((c) => {
      if (c.argv.includes(`file://${w.dir}`)) order.push('agent-fetch');
    });
    const r = await stageFromAgent(w.dir, B, { sweep: () => void order.push('sweep') });
    expect(order).toEqual(['sweep', 'agent-fetch', 'sweep']);
    if ('pushDir' in r) rmSync(r.pushDir, { recursive: true, force: true });
  });

  test('the sweep also runs after a failed or empty agent fetch', async () => {
    const w = await world('order-fail');
    writeFileSync(
      join(w.dir, 'big2.bin'),
      Buffer.from(Array.from({ length: 200_000 }, () => Math.floor(Math.random() * 256))),
    );
    await commitIfDirty(w.dir, 'feat: big2');
    const order: string[] = [];
    recordSpawn((c) => {
      if (c.argv.includes(`file://${w.dir}`)) order.push('agent-fetch');
    });
    const sweep = () => void order.push('sweep');
    await expect(
      stageFromAgent(w.dir, B, { sweep, limits: { timeoutMs: 120_000, maxBytes: 10_000 } }),
    ).rejects.toThrow(/too large/);
    expect(order).toEqual(['sweep', 'agent-fetch', 'sweep']);
    order.length = 0;
    await expect(stageFromAgent(w.dir, 'agent/issue-404', { sweep })).resolves.toHaveProperty(
      'nothing',
    );
    expect(order).toEqual(['sweep', 'agent-fetch', 'sweep']);
    expect(leftovers()).toEqual([]);
  });
});

describe('pushStaged', () => {
  test('new branch', async () => {
    const w = await world('newbranch');
    git(w.dir, 'switch', '-q', '-c', 'agent/issue-2');
    writeFileSync(join(w.dir, 'n.txt'), 'n\n');
    await commitIfDirty(w.dir, 'feat: n');
    const head = await headSha(w.dir);
    const rec = recordSpawn();
    expect(await stageAndPush(w, { branch: 'agent/issue-2', lease: '', expectSha: head })).toEqual({
      status: 'pushed',
      headSha: head,
      alreadyThere: false,
    });
    expect(w.remoteTip('agent/issue-2')).toBe(head);
    // The token rides only in the env of root calls in a root-owned bare repo.
    const tokenCalls = rec.calls.filter((c) =>
      Object.values(c.env).some((v) => String(v).includes(authHeader(TOKEN))),
    );
    expect(tokenCalls.length).toBeGreaterThan(0);
    for (const c of tokenCalls) {
      expect(c.argv.join(' ')).not.toContain(TOKEN);
      expect(c.env.GIT_DIR?.startsWith(w.dir) ?? true).toBe(false);
    }
    expect(leftovers()).toEqual([]);
  });

  test('protected path and rename source', async () => {
    const w = await world('protected');
    git(w.dir, 'mv', '.github/x.yml', 'y.yml');
    await commitIfDirty(w.dir, 'chore: move');
    const r = await stageAndPush(w);
    expect(r).toEqual({
      status: 'failed',
      reason: 'protected path .github/x.yml',
      retryable: false,
    });
    expect(w.remoteTip()).toBe(w.s0);
    expect(leftovers()).toEqual([]);
  });

  test('protected dotfile', async () => {
    const w = await world('dotfile');
    mkdirSync(join(w.dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(w.dir, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n');
    await commitIfDirty(w.dir, 'chore: add tool');
    const r = await stageAndPush(w, { protectedPaths: ['node_modules/**'] });
    expect(r).toEqual({
      status: 'failed',
      reason: 'protected path node_modules/.bin/tool',
      retryable: false,
    });
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('secret in an added line', async () => {
    const w = await world('secret');
    writeFileSync(join(w.dir, 'leak.txt'), 'value=plain-looking-secret-1234\n');
    await commitIfDirty(w.dir, 'feat: leak');
    const r = await stageAndPush(w, { secrets: ['plain-looking-secret-1234'] });
    expect(r).toEqual({ status: 'failed', reason: 'secret in diff', retryable: false });
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('non-agent author', async () => {
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
    const r = await stageAndPush(w);
    expect(r).toEqual({ status: 'failed', reason: 'foreign commit identity', retryable: false });
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('expectSha mismatch', async () => {
    const w = await world('gated');
    const gated = await headSha(w.dir);
    writeFileSync(join(w.dir, 'late.txt'), 'after the gates\n');
    await commitIfDirty(w.dir, 'feat: late');
    const r = await stageAndPush(w, { expectSha: gated });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toMatch(/^pushed branch is not the gated commit/);
    expect(r.retryable).toBe(false);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('stale remote', async () => {
    const w = await world('stale');
    const h = w.human();
    git(h, 'switch', '-q', B);
    git(h, 'commit', '-q', '--allow-empty', '-m', 'move');
    git(h, 'push', '-q', 'origin', B);
    const moved = w.remoteTip();
    writeFileSync(join(w.dir, 'm.txt'), 'm\n');
    await commitIfDirty(w.dir, 'feat: m');
    const r = await stageAndPush(w);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toMatch(/^stale info: /);
    expect(r.retryable).toBe(false);
    expect(w.remoteTip()).toBe(moved);
  });

  test('already there', async () => {
    const w = await world('already');
    writeFileSync(join(w.dir, 'al.txt'), 'al\n');
    await commitIfDirty(w.dir, 'feat: al');
    const head = await headSha(w.dir);
    // An earlier attempt pushed it and died before reporting.
    git(w.dir, 'push', '-q', w.origin, `HEAD:refs/heads/${B}`);
    expect(await stageAndPush(w, { expectSha: head })).toEqual({
      status: 'pushed',
      headSha: head,
      alreadyThere: true,
    });
  });

  test('checkpoint with nothing ahead', async () => {
    const w = await world('nothingahead');
    expect(await stageAndPush(w)).toEqual({ status: 'nothing', reason: 'nothing ahead' });
    expect(leftovers()).toEqual([]);
  });

  test('base fetch network failure is retryable', async () => {
    const w = await world('network');
    writeFileSync(join(w.dir, 'net.txt'), 'net\n');
    await commitIfDirty(w.dir, 'feat: net');
    const secret = 'secret-in-the-url-0987';
    const grant = grantFor(w, { secrets: [secret] });
    const r = await stage(w);
    const res = await pushStaged(r.pushDir, grant, {
      remoteUrl: `file://${join(w.base, `gone-${secret}.git`)}`,
    });
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.retryable).toBe(true);
    expect(res.reason).not.toContain(secret);
    expect(res.reason).not.toContain(TOKEN);
    expect(res.reason.length).toBeLessThanOrEqual(2000);
    expect(w.remoteTip()).toBe(w.s0);
    expect(leftovers()).toEqual([]);
  });

  test('a remote decline with the branch unchanged is not retryable', async () => {
    const w = await world('declined');
    writeFileSync(join(w.dir, 'dc.txt'), 'dc\n');
    await commitIfDirty(w.dir, 'feat: dc');
    const secret = 'hook-echoed-secret-5678';
    const hook = join(w.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\necho "denied by policy ${secret}" >&2\nexit 1\n`);
    chmodSync(hook, 0o755);
    const r = await stageAndPush(w, { secrets: [secret] });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.retryable).toBe(false);
    expect(r.reason).toContain('denied by policy');
    expect(r.reason).not.toContain(secret);
    expect(r.reason.length).toBeLessThanOrEqual(2000);
    expect(w.remoteTip()).toBe(w.s0);
    expect(leftovers()).toEqual([]);
  });

  test('a stalled push times out and is retryable', async () => {
    const w = await world('stalled');
    writeFileSync(join(w.dir, 'st.txt'), 'st\n');
    await commitIfDirty(w.dir, 'feat: st');
    const hook = join(w.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexec sleep 20\n');
    chmodSync(hook, 0o755);
    const grant = grantFor(w);
    const r = await stage(w);
    const t0 = Date.now();
    const res = await pushStaged(r.pushDir, grant, { remoteUrl: w.target.url, timeoutMs: 3_000 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(res).toMatchObject({ status: 'failed', retryable: true });
    expect(w.remoteTip()).toBe(w.s0);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  test('a timeout kills the whole process group, not only git', async () => {
    const w = await world('group');
    writeFileSync(join(w.dir, 'gr.txt'), 'gr\n');
    await commitIfDirty(w.dir, 'feat: gr');
    // The hook stands in for git-remote-https: a grandchild of git push that could hold the token.
    const pidFile = join(w.base, 'hook.pid');
    const hook = join(w.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`);
    chmodSync(hook, 0o755);
    const r = await stage(w);
    const res = await pushStaged(r.pushDir, grantFor(w), {
      remoteUrl: w.target.url,
      timeoutMs: 3_000,
    });
    expect(res).toMatchObject({ status: 'failed', retryable: true });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const gone = () => {
      try {
        const st = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
        return st.trim() === '' || st.trim().startsWith('Z');
      } catch {
        return true; // ps exits 1 when the pid does not exist
      }
    };
    const t0 = Date.now();
    while (!gone() && Date.now() - t0 < 5_000) await new Promise((ok) => setTimeout(ok, 100));
    const dead = gone();
    if (!dead) process.kill(pid, 'SIGKILL');
    expect(dead).toBe(true);
  }, 30_000);

  test('an exit 1 with no porcelain rejection is retryable', async () => {
    const w = await world('noporcelain');
    writeFileSync(join(w.dir, 'np.txt'), 'np\n');
    await commitIfDirty(w.dir, 'feat: np');
    const r = await stage(w);
    // A push that fails with git's generic summary but no `[rejected]` line from the remote.
    setSpawn((cmd, args, opts: SpawnOptions) =>
      args.includes('--porcelain')
        ? spawn('sh', ['-c', `echo "error: failed to push some refs to 'x'" >&2; exit 1`], opts)
        : spawn(cmd, args, opts),
    );
    const res = await pushStaged(r.pushDir, grantFor(w), { remoteUrl: w.target.url });
    expect(res).toMatchObject({ status: 'failed', retryable: true });
    expect(w.remoteTip()).toBe(w.s0);
    expect(leftovers()).toEqual([]);
  });

  test('nothing is read from a mirror', async () => {
    const w = await world('nomirror');
    writeFileSync(join(w.dir, 'nm.txt'), 'nm\n');
    await commitIfDirty(w.dir, 'feat: nm');
    const head = await headSha(w.dir);
    const rec = recordSpawn();
    expect(await stageAndPush(w, { expectSha: head })).toMatchObject({ status: 'pushed' });
    expect(rec.calls.length).toBeGreaterThan(0);
    for (const c of rec.calls) {
      const all = [...c.argv, c.cwd ?? '', ...Object.values(c.env).map(String)];
      expect(all.some((a) => a.includes(w.mirror))).toBe(false);
    }
  });
});

/** Carried over from the deleted in-container push suites: the same refusals, now on the push path. */
describe('pushStaged: guard cases carried over from the in-container push', () => {
  test('a protected path git would C-quote (non-ASCII) is still refused', async () => {
    const w = await world('quoted');
    mkdirSync(join(w.dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(w.dir, '.github', 'workflows', 'é.yml'), 'on: push\n');
    await commitIfDirty(w.dir, 'ci: add');
    expect(await stageAndPush(w)).toEqual({
      status: 'failed',
      reason: 'protected path .github/workflows/é.yml',
      retryable: false,
    });
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('a bare protected directory entry (e.g. a .claude symlink) is refused', async () => {
    const w = await world('bare-dir');
    symlinkSync('docs', join(w.dir, '.claude'));
    await commitIfDirty(w.dir, 'chore: link');
    expect(await stageAndPush(w, { protectedPaths: ['.claude/**'] })).toEqual({
      status: 'failed',
      reason: 'protected path .claude',
      retryable: false,
    });
    expect(w.remoteTip()).toBe(w.s0);
  });

  test('a known secret value in a commit message is refused', async () => {
    const w = await world('secret-msg');
    writeFileSync(join(w.dir, 'ok.txt'), 'fine\n');
    await commitIfDirty(w.dir, 'feat: plain-looking-secret-1234');
    expect(await stageAndPush(w, { secrets: ['plain-looking-secret-1234'] })).toEqual({
      status: 'failed',
      reason: 'secret in diff',
      retryable: false,
    });
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
    const head = await headSha(w.dir);
    expect(await stageAndPush(w, { expectSha: head })).toMatchObject({
      status: 'pushed',
      headSha: head,
    });
    expect(w.remoteTip()).toBe(head);
  });

  test('an agent origin/<base> pointing at its own tip does not bypass the guard', async () => {
    const w = await world('fakebase');
    git(w.dir, 'mv', '.github/x.yml', 'y.yml');
    await commitIfDirty(w.dir, 'chore: move');
    git(w.dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(w.dir, 'update-ref', 'refs/heads/main', 'HEAD');
    expect(await stageAndPush(w)).toMatchObject({
      status: 'failed',
      reason: 'protected path .github/x.yml',
    });
    expect(w.remoteTip()).toBe(w.s0);
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
    const head = await headSha(w.dir);
    expect(await stageAndPush(w, { lease: s1, expectSha: head })).toMatchObject({
      status: 'pushed',
      headSha: head,
    });
  });

  test('a new-branch lease never overwrites a branch that already exists', async () => {
    const w = await world('exists');
    writeFileSync(join(w.dir, 'z.txt'), 'z\n');
    await commitIfDirty(w.dir, 'feat: z');
    const r = await stageAndPush(w, { lease: '' });
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.reason).toMatch(/^stale info: /);
    expect(r.retryable).toBe(false);
    expect(w.remoteTip()).toBe(w.s0);
  });

  test("the working copy's pushurl and insteadOf never redirect the push", async () => {
    const w = await world('redirect');
    writeFileSync(join(w.dir, 'p.txt'), 'p\n');
    await commitIfDirty(w.dir, 'feat: p');
    const decoy = join(w.base, 'decoy.git');
    git(w.base, 'init', '--bare', '-q', decoy);
    git(w.dir, 'config', 'remote.origin.pushurl', `file://${decoy}`);
    git(w.dir, 'config', `url.file://${decoy}.insteadOf`, w.target.url);
    expect(await stageAndPush(w)).toMatchObject({ status: 'pushed' });
    expect(git(decoy, 'for-each-ref')).toBe('');
    expect(w.remoteTip()).toBe(await headSha(w.dir));
  });

  test('every token-bearing call names a root bare repo as both GIT_DIR and GIT_COMMON_DIR', async () => {
    const w = await world('tokencalls');
    writeFileSync(join(w.dir, 'd.txt'), 'd\n');
    await commitIfDirty(w.dir, 'feat: d');
    const rec = recordSpawn();
    expect(await stageAndPush(w)).toMatchObject({ status: 'pushed' });
    const tokenCalls = rec.calls.filter((c) =>
      Object.values(c.env).some((v) => String(v).includes(authHeader(TOKEN))),
    );
    expect(tokenCalls.length).toBeGreaterThan(0);
    for (const c of tokenCalls) {
      expect(c.env.GIT_DIR).toBeTruthy();
      expect(c.env.GIT_DIR?.startsWith(w.dir)).toBe(false);
      expect(c.env.GIT_COMMON_DIR).toBe(c.env.GIT_DIR);
      expect(c.cwd?.startsWith(w.dir) ?? false).toBe(false);
    }
  });

  test('a commondir planted during the agent fetch does not redirect the push', async () => {
    const w = await world('commondir');
    writeFileSync(join(w.dir, 'k.txt'), 'k\n');
    await commitIfDirty(w.dir, 'feat: k');
    const decoy = join(w.base, 'decoy.git');
    git(w.base, 'init', '--bare', '-q', decoy);
    const evil = join(w.base, 'evil-common');
    git(w.base, 'init', '--bare', '-q', evil);
    git(evil, 'config', `url.file://${decoy}.insteadOf`, w.target.url);
    recordSpawn((c) => {
      if (c.argv.includes(`file://${w.dir}`) && c.env.GIT_DIR) {
        writeFileSync(join(c.env.GIT_DIR, 'commondir'), `${evil}\n`);
      }
    });
    expect(await stageAndPush(w)).toMatchObject({ status: 'pushed' });
    expect(w.remoteTip()).toBe(await headSha(w.dir));
    expect(git(decoy, 'for-each-ref')).toBe('');
  });

  test('inherited GIT_* config and a global gitconfig never redirect the push', async () => {
    const w = await world('globalcfg');
    writeFileSync(join(w.dir, 'g.txt'), 'g\n');
    await commitIfDirty(w.dir, 'feat: g');
    const decoy = join(w.base, 'decoy2.git');
    git(w.base, 'init', '--bare', '-q', decoy);
    const home = join(w.base, 'evil-home');
    mkdirSync(home);
    writeFileSync(
      join(home, '.gitconfig'),
      `[url "file://${decoy}"]\n\tinsteadOf = ${w.target.url}\n`,
    );
    const saved = { ...process.env };
    process.env.HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${decoy}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = w.target.url;
    try {
      expect(await stageAndPush(w)).toMatchObject({ status: 'pushed' });
    } finally {
      process.env = saved;
    }
    expect(git(decoy, 'for-each-ref')).toBe('');
    expect(w.remoteTip()).toBe(await headSha(w.dir));
  });
});
