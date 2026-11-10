import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig, parseEditable, splitConfigFile } from './config.js';
import { createSecretOnce, type InitDeps, type InitForge, runInit } from './init.js';

const AUTHOR = 'github_pat_INITAUTHORDUMMY0123456789';
const CLASSIC = 'ghp_INITCLASSICDUMMY0123456789';
const REVIEWER = 'github_pat_INITREVIEWERDUMMY0123456789';
const READ = 'github_pat_INITREADDUMMY0123456789';
const CLAUDE = 'sk-ant-oat01-INITCLAUDEDUMMY0123456789';
const ENV_FILE = 'JM_UID=1000\nJM_GID=1000\n# mine\nJM_SLOTS=2\n';
const IDENTITY_MAP = '         0          0 4294967295\n';
const digest = (c: string) => `sha256:${c.repeat(64)}`;

type Repo = { private?: boolean; admin?: boolean; files: Record<string, string> };

function fakeForge(repo: Repo, seen: { token?: string; repo?: string } = {}) {
  return (name: string, token: string): InitForge => {
    seen.token = token;
    seen.repo = name;
    return {
      async repoAccess() {
        return {
          private: repo.private ?? false,
          defaultBranch: 'main',
          permissions: {
            admin: repo.admin ?? false,
            maintain: false,
            push: true,
            triage: true,
            pull: true,
          },
          scopes: null,
          tokenExpiresAt: null,
        };
      },
      async listDir(ref: string, path: string) {
        expect(ref).toBe('main');
        expect(path).toBe('');
        return Object.keys(repo.files);
      },
      async getFileAt(ref: string, path: string) {
        expect(ref).toBe('main');
        return repo.files[path] ?? null;
      },
    };
  };
}

const NODE_REPO: Repo = {
  files: {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check .' } }),
    'package-lock.json': '{}',
    'README.md': '# demo',
  },
};

/** An install directory with the token files the operator writes before `init`. */
function installDir(opts: { author?: string; reviewer?: boolean; read?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jm-init-'));
  writeFileSync(join(dir, '.env'), ENV_FILE);
  mkdirSync(join(dir, 'secrets'), { mode: 0o700 });
  const put = (name: string, value: string) =>
    writeFileSync(join(dir, 'secrets', name), `${value}\n`, { mode: 0o600 });
  put('github_author_token', opts.author ?? AUTHOR);
  put('claude_token', CLAUDE);
  if (opts.reviewer !== false) put('github_reviewer_token', REVIEWER);
  if (opts.read) put('github_read_token', READ);
  return dir;
}

function run(dir: string, args: string[], over: Partial<InitDeps> = {}, repo: Repo = NODE_REPO) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: InitDeps = {
    dir,
    uid: 1000,
    uidMap: IDENTITY_MAP,
    forge: fakeForge(repo),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return runInit(args, deps).then((code) => ({
    code,
    out: out.join('\n'),
    err: err.join('\n'),
    all: [...out, ...err].join('\n'),
  }));
}

const configOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'config', 'jumpmaster.config.json'), 'utf8'));
const mode = (p: string) => statSync(p).mode & 0o777;

/** The image lock a release-built server image carries. */
function lockFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jm-lock-')), 'images.lock.json');
  const images = Object.fromEntries(
    ['jumpmaster-trooper', 'jumpmaster-trooper-python', 'jumpmaster-trooper-go'].map((n, i) => [
      n,
      digest(String(i + 1)),
    ]),
  );
  writeFileSync(file, JSON.stringify({ registry: 'ghcr.io/x-a-n-d-e-r-k', images }));
  return file;
}

/** The environment compose gives the server for this install directory. */
function serverEnv(dir: string, opts: { reviewer?: boolean; read?: boolean } = {}) {
  const s = (n: string) => join(dir, 'secrets', n);
  return {
    JM_CLAUDE_TOKEN_FILE: s('claude_token'),
    JM_GITHUB_AUTHOR_TOKEN_FILE: s('github_author_token'),
    ...(opts.reviewer === false
      ? {}
      : { JM_GITHUB_REVIEWER_TOKEN_FILE: s('github_reviewer_token') }),
    ...(opts.read ? { JM_GITHUB_READ_TOKEN_FILE: s('github_read_token') } : {}),
    JM_JOIN_TOKEN_FILE: s('join_token'),
    JM_OPERATOR_TOKEN_FILE: s('operator_token'),
  };
}

describe('jumpmaster init', () => {
  test('init writes a config loadConfig accepts with the generated secret files', async () => {
    const dir = installDir();
    const r = await run(dir, ['--repo', 'octo/demo']);
    expect(r.code, r.all).toBe(0);
    const config = loadConfig(join(dir, 'config', 'jumpmaster.config.json'), serverEnv(dir), {
      imageLockPath: lockFile(),
    });
    expect(config.dataDir).toBe('/data');
    // Every key init writes is one the store knows: adopting it into db mode is refused for none.
    const { editable } = splitConfigFile(
      'jumpmaster.config.json',
      readFileSync(join(dir, 'config', 'jumpmaster.config.json'), 'utf8'),
    );
    expect(parseEditable(editable, { imageLockPath: lockFile(), strict: true }).ok).toBe(true);
    expect(config.listen).toEqual({
      host: '0.0.0.0',
      port: 7420,
      allowedHosts: ['127.0.0.1:7420', 'localhost:7420'],
    });
    expect(config.requireSignedImages).toBe(true);
    const zone = config.dropZones[0];
    expect(zone?.repo).toBe('octo/demo');
    expect(zone?.image).toBe(`ghcr.io/x-a-n-d-e-r-k/jumpmaster-trooper@${digest('1')}`);
    expect(zone?.ciRequired).toBe(true);
    expect(zone?.crew.enabled).toBe(false);
    expect(zone?.identity).toBe('two-bot');
    expect(config.secrets.joinToken.length).toBeGreaterThanOrEqual(32);
    expect(config.secrets.operatorToken.length).toBeGreaterThanOrEqual(32);
    expect(config.secrets.operatorToken).not.toBe(config.secrets.joinToken);
    for (const d of ['config', 'data', 'secrets']) expect(existsSync(join(dir, d))).toBe(true);
    // The Claude token file's date stands in for the day setup-token ran.
    expect(configOf(dir).claude.tokenCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('init with a node fixture writes preset node, its gates and egress monitor', async () => {
    const dir = installDir();
    const seen: { token?: string; repo?: string } = {};
    const r = await run(dir, ['--repo', 'octo/demo'], { forge: fakeForge(NODE_REPO, seen) });
    expect(r.code, r.all).toBe(0);
    expect(seen).toEqual({ token: AUTHOR, repo: 'octo/demo' });
    const zone = configOf(dir).dropZones[0];
    expect(zone).toMatchObject({
      id: 'demo',
      repo: 'octo/demo',
      preset: 'node',
      egress: { mode: 'monitor' },
      identity: 'two-bot',
      ciRequired: true,
      crew: { enabled: false },
    });
    expect(zone.image).toBeUndefined();
    expect(zone.gates).toEqual([
      { name: 'install', run: 'npm ci', timeoutMinutes: 20 },
      { name: 'test', run: 'npm test', timeoutMinutes: 20 },
      { name: 'lint', run: 'npm run lint', timeoutMinutes: 20 },
    ]);
    expect(zone.reviewReadToken).toBeUndefined();
    expect(r.out).toContain('preset node');
    expect(r.out).toContain('docker compose up -d');
    expect(r.out).toContain('docker compose exec jumpmaster jumpmaster ctl doctor');
  });

  test('init exits 2 on ambiguous detection, 3 on an existing config, 4 on a read-only mount', async () => {
    const mixed: Repo = { files: { 'package.json': '{}', 'go.mod': 'module x\n' } };
    const ambiguous = installDir();
    const a = await run(ambiguous, ['--repo', 'octo/demo'], {}, mixed);
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/node, go/);
    expect(a.err).toContain('--preset');
    expect(existsSync(join(ambiguous, 'config', 'jumpmaster.config.json'))).toBe(false);
    // --preset settles it, with that stack's gates.
    const chosen = await run(ambiguous, ['--repo', 'octo/demo', '--preset', 'go'], {}, mixed);
    expect(chosen.code, chosen.all).toBe(0);
    expect(configOf(ambiguous).dropZones[0].preset).toBe('go');
    expect(configOf(ambiguous).dropZones[0].gates.map((g: { run: string }) => g.run)).toContain(
      'go test ./...',
    );

    const again = await run(ambiguous, ['--repo', 'octo/demo', '--preset', 'go']);
    expect(again.code).toBe(3);
    expect(again.err).toContain('--force');
    const forced = await run(ambiguous, ['--repo', 'octo/demo', '--preset', 'node', '--force']);
    expect(forced.code, forced.all).toBe(0);
    expect(configOf(ambiguous).dropZones[0].preset).toBe('node');

    if (process.getuid?.() !== 0) {
      const readOnly = installDir();
      chmodSync(readOnly, 0o555);
      const ro = await run(readOnly, ['--repo', 'octo/demo']);
      chmodSync(readOnly, 0o755);
      expect(ro.code).toBe(4);
      expect(ro.err).toContain('mount /install read-write');
    }
  });

  test('init as a non-root uid against a writable mount succeeds; as uid 0 it refuses without --allow-root', async () => {
    const user = await run(installDir(), ['--repo', 'octo/demo'], { uid: 1000 });
    expect(user.code, user.all).toBe(0);
    const rootDir = installDir();
    const root = await run(rootDir, ['--repo', 'octo/demo'], { uid: 0 });
    expect(root.code).toBe(1);
    expect(root.err).toMatch(/uid 0/);
    expect(root.err).toContain('JM_UID');
    expect(existsSync(join(rootDir, 'config', 'jumpmaster.config.json'))).toBe(false);
    const allowed = await run(rootDir, ['--repo', 'octo/demo', '--allow-root'], { uid: 0 });
    expect(allowed.code, allowed.all).toBe(0);
  });

  test('init refuses under rootless Docker (a user-namespace uid map)', async () => {
    const dir = installDir();
    const r = await run(dir, ['--repo', 'octo/demo'], { uidMap: '0 1000 1\n1 100000 65536\n' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rootless Docker is not supported in this release/);
    expect(existsSync(join(dir, 'config'))).toBe(false);
  });

  test('init never writes a secret value to stdout or stderr', async () => {
    const dir = installDir();
    const ok = await run(dir, ['--repo', 'octo/demo']);
    const failed = await run(installDir({ author: CLASSIC }), [
      '--repo',
      'octo/demo',
      '--identity',
      'starter',
    ]);
    expect(failed.code).toBe(1);
    const join_ = readFileSync(join(dir, 'secrets', 'join_token'), 'utf8').trim();
    const operator = readFileSync(join(dir, 'secrets', 'operator_token'), 'utf8').trim();
    for (const text of [ok.all, failed.all])
      for (const secret of [AUTHOR, CLASSIC, REVIEWER, CLAUDE, join_, operator])
        expect(text).not.toContain(secret);
  });

  test('generated secret files are 0600 and not overwritten on a rerun', async () => {
    const dir = installDir();
    expect((await run(dir, ['--repo', 'octo/demo'])).code).toBe(0);
    const files = ['join_token', 'operator_token'].map((n) => join(dir, 'secrets', n));
    const before = files.map((f) => readFileSync(f, 'utf8'));
    for (const f of files) expect(mode(f)).toBe(0o600);
    expect((await run(dir, ['--repo', 'octo/demo', '--force'])).code).toBe(0);
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
    // The operator's own token files are never touched.
    expect(readFileSync(join(dir, 'secrets', 'github_author_token'), 'utf8')).toBe(`${AUTHOR}\n`);
  });

  test('init writes secrets/vault_key with mode 0600: 32 random bytes, base64url, kept on a rerun, never printed', async () => {
    const dir = installDir();
    const first = await run(dir, ['--repo', 'octo/demo']);
    expect(first.code).toBe(0);
    const key = join(dir, 'secrets', 'vault_key');
    expect(mode(key)).toBe(0o600);
    const text = readFileSync(key, 'utf8').trim();
    expect(Buffer.from(text, 'base64url')).toHaveLength(32);
    expect(first.all).toContain('secrets/vault_key');
    expect(first.all).not.toContain(text);
    expect((await run(dir, ['--repo', 'octo/demo', '--force'])).code).toBe(0);
    expect(readFileSync(key, 'utf8').trim()).toBe(text);
  });

  test('a missing author token is named by its file, and nothing is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-init-'));
    const r = await run(dir, ['--repo', 'octo/demo']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('secrets/github_author_token');
    expect(existsSync(join(dir, 'config', 'jumpmaster.config.json'))).toBe(false);
  });

  test('a token GitHub refuses is reported by status, not echoed', async () => {
    const dir = installDir();
    const refusing = () => ({
      async repoAccess(): Promise<never> {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      },
      async listDir() {
        return [];
      },
      async getFileAt() {
        return null;
      },
    });
    const r = await run(dir, ['--repo', 'octo/demo'], { forge: refusing });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/401/);
    expect(r.all).not.toContain(AUTHOR);
  });

  const envOf = (dir: string) => readFileSync(join(dir, '.env'), 'utf8');

  test('a private repository turns on reviewReadToken and wires the read token in .env', async () => {
    const dir = installDir({ read: true });
    const r = await run(dir, ['--repo', 'octo/demo'], {}, { ...NODE_REPO, private: true });
    expect(r.code, r.all).toBe(0);
    expect(configOf(dir).dropZones[0].reviewReadToken).toBe(true);
    const env = envOf(dir);
    expect(env.startsWith(ENV_FILE)).toBe(true);
    expect(env).toContain('JM_READ_TOKEN_FILE=/run/secrets/github_read_token\n');
    expect(env).toContain('JM_READ_TOKEN_SRC=./secrets/github_read_token\n');
    expect(env).not.toContain('JM_REVIEWER_TOKEN');
    expect(existsSync(join(dir, 'compose.override.yaml'))).toBe(false);
    expect(() =>
      loadConfig(join(dir, 'config', 'jumpmaster.config.json'), serverEnv(dir, { read: true }), {
        imageLockPath: lockFile(),
      }),
    ).not.toThrow();
    // Without the read token file, init says what to create.
    const missing = installDir();
    const m = await run(missing, ['--repo', 'octo/demo'], {}, { ...NODE_REPO, private: true });
    expect(m.code).toBe(0);
    expect(m.out).toContain('secrets/github_read_token');
  });

  test('starter mode needs no reviewer token, unwires it in .env and states the cost', async () => {
    const dir = installDir({ reviewer: false });
    const r = await run(dir, ['--repo', 'octo/demo', '--identity', 'starter']);
    expect(r.code, r.all).toBe(0);
    expect(configOf(dir).dropZones[0].identity).toBe('starter');
    expect(r.out).toContain('the author token can merge any green PR');
    const env = envOf(dir);
    expect(env).toContain('JM_REVIEWER_TOKEN_FILE=\n');
    expect(env).toContain('JM_REVIEWER_TOKEN_SRC=/dev/null\n');
    expect(() =>
      loadConfig(
        join(dir, 'config', 'jumpmaster.config.json'),
        serverEnv(dir, { reviewer: false }),
        { imageLockPath: lockFile() },
      ),
    ).not.toThrow();
    // Rerunning keeps one block; a two-bot rerun removes it and keeps the operator's own lines.
    expect((await run(dir, ['--repo', 'octo/demo', '--identity', 'starter', '--force'])).code).toBe(
      0,
    );
    expect(envOf(dir).match(/JM_REVIEWER_TOKEN_FILE/g)).toHaveLength(1);
    writeFileSync(join(dir, 'secrets', 'github_reviewer_token'), `${REVIEWER}\n`, { mode: 0o600 });
    expect((await run(dir, ['--repo', 'octo/demo', '--force'])).code).toBe(0);
    expect(envOf(dir)).toBe(ENV_FILE);
  });

  test('starter mode refuses a classic author token', async () => {
    const dir = installDir({ author: CLASSIC, reviewer: false });
    const r = await run(dir, ['--repo', 'octo/demo', '--identity', 'starter']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('fine-grained');
    expect(existsSync(join(dir, 'config', 'jumpmaster.config.json'))).toBe(false);
  });

  test('an author account that is a repository admin is named, and --author-may-be-admin sets it', async () => {
    const admin: Repo = { ...NODE_REPO, admin: true };
    const dir = installDir({ reviewer: false });
    const warned = await run(dir, ['--repo', 'octo/demo', '--identity', 'starter'], {}, admin);
    expect(warned.code).toBe(0);
    expect(warned.out).toContain('--author-may-be-admin');
    expect(configOf(dir).dropZones[0].authorMayBeAdmin).toBeUndefined();
    const set = await run(
      dir,
      ['--repo', 'octo/demo', '--identity', 'starter', '--author-may-be-admin', '--force'],
      {},
      admin,
    );
    expect(set.code).toBe(0);
    expect(configOf(dir).dropZones[0].authorMayBeAdmin).toBe(true);
  });

  test('--force is named as rewriting the whole config', async () => {
    const dir = installDir();
    expect((await run(dir, ['--repo', 'octo/demo'])).code).toBe(0);
    const again = await run(dir, ['--repo', 'octo/demo']);
    expect(again.code).toBe(3);
    expect(again.err).toMatch(/rewrites the whole config/);
    expect(again.err).toMatch(/gates|egress/);
  });

  test('a config/ directory init cannot write is exit 4 with the chown fix, not a stack trace', async () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    const dir = installDir();
    mkdirSync(join(dir, 'config'), { mode: 0o555 });
    const r = await run(dir, ['--repo', 'octo/demo']);
    chmodSync(join(dir, 'config'), 0o755);
    expect(r.code).toBe(4);
    expect(r.err).toContain('config');
    expect(r.err).toContain('sudo chown -R');
  });

  test('a token file others can read is tightened to 0600, and init says so', async () => {
    const dir = installDir();
    chmodSync(join(dir, 'secrets', 'claude_token'), 0o644);
    const r = await run(dir, ['--repo', 'octo/demo']);
    expect(r.code, r.all).toBe(0);
    expect(mode(join(dir, 'secrets', 'claude_token'))).toBe(0o600);
    expect(r.out).toContain('secrets/claude_token');
    expect(r.out).toMatch(/0600/);
  });

  test('--offline writes the config without reading GitHub, and needs --preset', async () => {
    const never = () => {
      throw new Error('the forge must not be used offline');
    };
    const dir = installDir({ reviewer: false });
    const r = await run(
      dir,
      ['--repo', 'octo/demo', '--offline', '--preset', 'node', '--identity', 'starter'],
      { forge: never },
    );
    expect(r.code, r.all).toBe(0);
    const zone = configOf(dir).dropZones[0];
    expect(zone).toMatchObject({
      preset: 'node',
      identity: 'starter',
      egress: { mode: 'monitor' },
    });
    expect(zone.gates).toEqual([]);
    expect(zone.reviewReadToken).toBeUndefined();
    expect(r.out).toMatch(/offline/);
    expect(r.out).toMatch(/no gates were written/);
    expect(mode(join(dir, 'secrets', 'join_token'))).toBe(0o600);
    const priv = installDir({ read: true });
    const p = await run(
      priv,
      ['--repo', 'octo/demo', '--offline', '--preset', 'python', '--private'],
      {
        forge: never,
      },
    );
    expect(p.code, p.all).toBe(0);
    expect(configOf(priv).dropZones[0].reviewReadToken).toBe(true);
    const noPreset = await run(installDir(), ['--repo', 'octo/demo', '--offline'], {
      forge: never,
    });
    expect(noPreset.code).toBe(2);
    expect(noPreset.err).toContain('--preset');
  });

  test('--help prints usage and exits 0', async () => {
    for (const flag of ['--help', '-h']) {
      const r = await run(installDir(), [flag]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/usage: jumpmaster init/);
    }
  });

  test('uid 0 is refused with the reason, and --allow-root is named as a last resort', async () => {
    const r = await run(installDir(), ['--repo', 'octo/demo'], { uid: 0 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/root/);
    expect(r.err).toMatch(/adduser|useradd/);
    expect(r.err).toContain('--allow-root');
  });

  test('usage errors exit 2', async () => {
    for (const args of [
      [],
      ['--repo', 'not-a-repo'],
      ['--repo', 'o/r', '--preset', 'cobol'],
      ['--repo', 'o/r', '--identity', 'solo'],
      ['--repo', 'o/r', '--bogus'],
      ['--repo', 'o/r', '--private'],
    ]) {
      const r = await run(installDir(), args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toMatch(/usage: jumpmaster init/);
    }
  });
});

test('createSecretOnce falls back to an exclusive write where hard links are not supported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-nolink-'));
  const path = join(dir, 'vault_key');
  const noLinks = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  expect(createSecretOnce(path, 'k1\n', noLinks)).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe('k1\n');
  expect(mode(path)).toBe(0o600);
  expect(createSecretOnce(path, 'k2\n', noLinks)).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe('k1\n');
  expect(readdirSync(dir)).toEqual(['vault_key']);
});
