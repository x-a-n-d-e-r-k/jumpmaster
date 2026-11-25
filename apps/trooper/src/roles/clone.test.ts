import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  type CloneGrant,
  type ClonePayload,
  type CloneResult,
  READY_LINE,
  RESULT_PREFIX,
} from '@jumpmaster/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { initBare, mirrorFetch, setSpawn } from '../git.js';
import { CLONE_MIRROR_DIR, type CloneDeps, mirrorHolds, runClone } from './clone.js';

const TOKEN = 'dtok-Zx9plain0123456789ab';
const USER = 'gitlab+deploy-token-7';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const FORMS = [TOKEN, `${USER}:${TOKEN}`, b64(`${USER}:${TOKEN}`), b64(`oauth2:${TOKEN}`)];
const GITLAB = {
  kind: 'gitlab' as const,
  origin: 'https://git.example.internal:8443',
  projectPath: 'group/project',
};

const payload: ClonePayload = { protocol: 1, role: 'clone', dropId: 'd7', epoch: 1 };
const grant = (over: Partial<CloneGrant> = {}): CloneGrant => ({
  token: TOKEN,
  username: USER,
  forge: GITLAB,
  secrets: ['zone-secret-xyz'],
  ...over,
});

let tmp: string;
let origin: string;
let n = 0;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A bare origin with `main`, `feature`, and any extra branches. */
function makeOrigin(extra: string[] = []): string {
  const dir = join(tmp, `origin-${n++}.git`);
  const seed = `${dir}-seed`;
  git(tmp, 'init', '-q', '--bare', '-b', 'main', dir);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  for (const b of ['feature', ...extra]) git(seed, 'branch', b);
  git(seed, 'push', '-q', dir, '--all');
  return dir;
}

beforeAll(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'clonerole-'));
  origin = makeOrigin();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => setSpawn(null));

type Run = { result: CloneResult; lines: string[]; log: string[]; mirror: string };

/**
 * Runs the role with the grant on stdin. The real `initBare`, and the real `mirrorFetch` pointed at
 * `from` over file://; `after` runs once the fetch is done.
 */
async function run(
  o: {
    grant?: CloneGrant | string;
    from?: string | null;
    after?: (mirror: string) => void;
    early?: boolean;
  } = {},
): Promise<Run> {
  const mirror = join(tmp, `mirror-${n++}`);
  const lines: string[] = [];
  const log: string[] = [];
  const stdin = new PassThrough();
  const line = typeof o.grant === 'string' ? o.grant : JSON.stringify(o.grant ?? grant());
  if (o.early !== false) stdin.write(`${line}\n`);
  const from = o.from === undefined ? origin : o.from;
  const deps: CloneDeps = {
    stdin,
    mirrorDir: mirror,
    emit: (l) => {
      lines.push(l);
      if (l === READY_LINE) log.push(`ready(unread=${stdin.readableLength > 0})`);
    },
    git: {
      initBare: async (d) => {
        log.push('init');
        await initBare(d);
      },
      mirrorFetch: async (d, t, target, refs, opts) => {
        log.push(`fetch ${refs.join(',')}`);
        await mirrorFetch(d, t, from ? { ...target, url: `file://${from}` } : target, refs, opts);
        o.after?.(d);
      },
    },
  };
  const result = await runClone(payload, deps);
  return { result, lines, log, mirror };
}

const resultOf = (r: Run): CloneResult => {
  const last = r.lines.at(-1) as string;
  expect(last.startsWith(RESULT_PREFIX)).toBe(true);
  return JSON.parse(last.slice(RESULT_PREFIX.length)) as CloneResult;
};

const noSecretIn = (lines: string[]) => {
  for (const l of lines) for (const f of FORMS) expect(l).not.toContain(f);
};

test('the production mirror is the fixed /jm/mirror', () => {
  expect(CLONE_MIRROR_DIR).toBe('/jm/mirror');
});

test('ready comes first: a grant written before it is still unread then', async () => {
  const r = await run();
  expect(r.lines[0]).toBe(READY_LINE);
  expect(r.log).toEqual(['ready(unread=true)', 'init', 'fetch *']);
});

test('a file:// fetch leaves a bare mirror with every head, the fixed config and no hooks', async () => {
  const r = await run();
  expect(r.result.status).toBe('cloned');
  expect(resultOf(r)).toEqual(r.result);
  if (r.result.status !== 'cloned') throw new Error('not cloned');
  expect(r.result.bytes).toBeGreaterThan(0);
  const heads = git(r.mirror, 'for-each-ref', '--format=%(refname)').split('\n').sort();
  expect(heads).toEqual(['refs/heads/feature', 'refs/heads/main']);
  expect(readFileSync(join(r.mirror, 'config'), 'utf8')).toBe(
    '[core]\n\trepositoryformatversion = 0\n\tbare = true\n',
  );
  expect(existsSync(join(r.mirror, 'hooks'))).toBe(false);
  // No checkout: a bare repository has no working tree.
  expect(existsSync(join(r.mirror, 'a.txt'))).toBe(false);
  expect(r.lines).toHaveLength(2);
  noSecretIn(r.lines);
});

describe('the recorded fetch for a GitLab forge', () => {
  type Call = { argv: string[]; env: NodeJS.ProcessEnv };
  /** Real git for init; the fetch is recorded and `fetch` stands in for it. */
  const record = (fetch: string): Call[] => {
    const calls: Call[] = [];
    setSpawn((cmd, args, opts) => {
      if (!args.includes('fetch')) return spawn(cmd, args, opts);
      calls.push({ argv: [cmd, ...args], env: (opts.env ?? {}) as NodeJS.ProcessEnv });
      return spawn('sh', ['-c', fetch], { ...opts, cwd: '/' });
    });
    return calls;
  };

  test.each([
    ['the deploy-token username', USER, USER],
    ['oauth2 when no username is given', undefined, 'oauth2'],
  ])(
    'authenticates as %s, scoped to <origin>/, with redirects refused',
    async (_, username, as) => {
      const calls = record('exit 0');
      const g = grant();
      if (username === undefined) delete g.username;
      const r = await run({ grant: g, from: null });
      expect(r.result.status).toBe('cloned');
      expect(calls).toHaveLength(1);
      const c = calls[0] as Call;
      expect(c.env.GIT_CONFIG_KEY_0).toBe('http.https://git.example.internal:8443/.extraheader');
      expect(c.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${b64(`${as}:${TOKEN}`)}`);
      expect(c.env.GIT_CONFIG_KEY_1).toBe('http.followRedirects');
      expect(c.env.GIT_CONFIG_VALUE_1).toBe('false');
      expect(c.env.GIT_CONFIG_COUNT).toBe('2');
      expect(c.argv).toContain('https://git.example.internal:8443/group/project.git');
      expect(c.argv).toContain('+refs/heads/*:refs/heads/*');
      expect(c.argv).toContain('core.hooksPath=/dev/null');
      expect(c.argv).not.toContain('--recurse-submodules');
      for (const a of c.argv) for (const f of FORMS) expect(a).not.toContain(f);
      noSecretIn(r.lines);
    },
  );

  test('a refused credential fails retryable, with a reason that holds no token', async () => {
    record(
      `echo "remote: HTTP Basic: Access denied for ${FORMS.join(' ')}" >&2; ` +
        `echo "fatal: Authentication failed (401) ${TOKEN}" >&2; exit 128`,
    );
    const r = await run({ from: null });
    expect(r.result).toMatchObject({ status: 'failed', retryable: true });
    if (r.result.status !== 'failed') throw new Error('not failed');
    expect(r.result.reason).toContain('Authentication failed');
    for (const f of FORMS) expect(r.result.reason).not.toContain(f);
    expect(resultOf(r)).toEqual(r.result);
    noSecretIn(r.lines);
  });
});

describe('the token search after the fetch', () => {
  const user = (t: string) => [t, `${USER}:${t}`, b64(`${USER}:${t}`)];

  test.each([
    ['plain', TOKEN],
    ['basic-auth', b64(`${USER}:${TOKEN}`)],
  ])('a token in a fetched ref name (%s form) fails the clone', async (_, form) => {
    const leaky = makeOrigin([`leak-${form}`]);
    const r = await run({ from: leaky });
    expect(existsSync(join(r.mirror, 'refs/heads', `leak-${form}`))).toBe(true);
    expect(r.result).toEqual({
      status: 'failed',
      reason: 'the mirror holds the clone token',
      retryable: false,
    });
    noSecretIn(r.lines);
  });

  test.each([
    ['plain', TOKEN],
    ['username:token', `${USER}:${TOKEN}`],
    ['basic-auth', b64(`${USER}:${TOKEN}`)],
  ])(
    'a token written into a mirror file (%s form) fails the clone, removing nothing',
    async (_, form) => {
      const r = await run({
        after: (m) => {
          mkdirSync(join(m, 'logs'), { recursive: true });
          writeFileSync(join(m, 'logs', 'note'), `before ${form} after`);
        },
      });
      expect(r.result).toEqual({
        status: 'failed',
        reason: 'the mirror holds the clone token',
        retryable: false,
      });
      expect(existsSync(join(r.mirror, 'logs', 'note'))).toBe(true);
      noSecretIn(r.lines);
    },
  );

  test('mirrorHolds finds a needle split across read chunks, and nothing in a clean tree', () => {
    const dir = join(tmp, `walk-${n++}`);
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'clean'), 'x'.repeat(100));
    expect(mirrorHolds(dir, user(TOKEN), 16)).toBe(false);
    writeFileSync(join(dir, 'a', 'b', 'big'), `${'y'.repeat(37)}${TOKEN}${'z'.repeat(50)}`);
    expect(mirrorHolds(dir, user(TOKEN), 16)).toBe(true);
  });
});

test('a malformed grant fails final, and no fetch runs', async () => {
  const r = await run({ grant: '{"token":"x"}' });
  expect(r.result).toMatchObject({ status: 'failed', retryable: false });
  expect(r.log).toEqual(['ready(unread=true)']);
});

test('stdin closing before the grant fails retryable', async () => {
  const mirror = join(tmp, `mirror-${n++}`);
  const stdin = new PassThrough();
  stdin.end();
  const lines: string[] = [];
  const r = await runClone(payload, {
    stdin,
    mirrorDir: mirror,
    emit: (l) => void lines.push(l),
    git: { initBare, mirrorFetch },
  });
  expect(r).toMatchObject({ status: 'failed', retryable: true });
  expect(lines[0]).toBe(READY_LINE);
});
