import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  type BootstrapDeps,
  CHOWN_FIX,
  ENV_FIX,
  MACHINE_SECRETS,
  runBootstrap,
} from './bootstrap.js';

const ME = process.getuid?.() ?? 1000;
const MY_GID = process.getgid?.() ?? 1000;
const mode = (p: string) => statSync(p).mode & 0o777;
const empty = () => mkdtempSync(join(tmpdir(), 'jm-boot-'));

/** Runs bootstrap as this process's uid, with `owners` faking a path's owner (by relative path). */
function run(dir: string, args: string[] = [], over: Partial<BootstrapDeps> = {}, owners = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fake = owners as Record<string, number>;
  const deps: BootstrapDeps = {
    dir,
    uid: ME,
    gid: MY_GID,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    lstat: (p: string): Stats => {
      const st = lstatSync(p);
      const rel = p === dir ? '.' : p.slice(dir.length + 1);
      if (rel in fake)
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: fake[rel] });
      return st;
    },
    ...over,
  };
  const code = runBootstrap(args, deps);
  return { code, out: out.join('\n'), err: err.join('\n'), all: [...out, ...err].join('\n') };
}

describe('jumpmaster bootstrap', () => {
  test('bootstrap creates secrets/ and data/ 0700 and the three machine secrets 0600 once, tightens looser modes, is idempotent and prints no value', () => {
    expect(MACHINE_SECRETS).toEqual(['join_token', 'operator_token', 'vault_key']);
    const dir = empty();
    const first = run(dir);
    expect(first.code, first.all).toBe(0);
    expect(mode(join(dir, 'secrets'))).toBe(0o700);
    expect(mode(join(dir, 'data'))).toBe(0o700);
    // config/ exists before compose binds it, so the engine never makes it as root.
    expect(statSync(join(dir, 'config')).isDirectory()).toBe(true);
    const values: string[] = [];
    for (const name of MACHINE_SECRETS) {
      const p = join(dir, 'secrets', name);
      expect(mode(p)).toBe(0o600);
      const text = readFileSync(p, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(Buffer.from(text.trim(), 'base64url')).toHaveLength(32);
      expect(text.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      values.push(text.trim());
      expect(first.out).toContain(`secrets/${name}`);
    }
    expect(new Set(values).size).toBe(3);
    expect(first.out).toContain('secrets/');
    expect(first.out).toContain('data/');
    // No temporary file is left behind.
    expect(readdirSync(join(dir, 'secrets')).sort()).toEqual([...MACHINE_SECRETS].sort());

    // A rerun changes nothing and says so.
    const again = run(dir);
    expect(again.code, again.all).toBe(0);
    for (const [i, name] of MACHINE_SECRETS.entries())
      expect(readFileSync(join(dir, 'secrets', name), 'utf8').trim()).toBe(values[i]);
    expect(again.out).not.toMatch(/generated|created|tightened/);
    expect(again.out).toMatch(/nothing to do/);

    // Looser modes are tightened, and named.
    chmodSync(join(dir, 'secrets'), 0o755);
    chmodSync(join(dir, 'data'), 0o775);
    chmodSync(join(dir, 'secrets', 'operator_token'), 0o644);
    const tight = run(dir);
    expect(tight.code, tight.all).toBe(0);
    expect(mode(join(dir, 'secrets'))).toBe(0o700);
    expect(mode(join(dir, 'data'))).toBe(0o700);
    expect(mode(join(dir, 'secrets', 'operator_token'))).toBe(0o600);
    expect(tight.out).toMatch(/tightened secrets\/ to 0700/);
    expect(tight.out).toMatch(/tightened data\/ to 0700/);
    expect(tight.out).toMatch(/tightened secrets\/operator_token to 0600/);

    for (const r of [first, again, tight]) for (const v of values) expect(r.all).not.toContain(v);
  });

  test("an existing credential file and a directory the user made are kept; an operator's own files are not touched", () => {
    const dir = empty();
    mkdirSync(join(dir, 'secrets'), { mode: 0o700 });
    writeFileSync(join(dir, 'secrets', 'claude_token'), 'sk-ant-oat01-BOOTDUMMY\n', {
      mode: 0o644,
    });
    writeFileSync(join(dir, 'secrets', 'join_token'), 'mine\n', { mode: 0o600 });
    const r = run(dir);
    expect(r.code, r.all).toBe(0);
    expect(readFileSync(join(dir, 'secrets', 'join_token'), 'utf8')).toBe('mine\n');
    // Credentials are the operator's: bootstrap generates and tightens only its own three.
    expect(mode(join(dir, 'secrets', 'claude_token'))).toBe(0o644);
    expect(r.all).not.toContain('BOOTDUMMY');
    expect(r.all).not.toContain('mine');
  });

  test('bootstrap on a root-owned directory prints the chown line, on another uid the .env line, and exits 1 either way', () => {
    expect(CHOWN_FIX(1000, 1000)).toBe(
      'the directories were created as root (docker compose run with sudo, or by the engine): run  sudo chown -R 1000:1000 secrets data  and start again',
    );
    expect(ENV_FIX).toBe(
      `set JM_UID and JM_GID in .env to your user: printf 'JM_UID=%s\\nJM_GID=%s\\n' "$(id -u)" "$(id -g)" > .env`,
    );
    for (const [owner, line] of [
      [0, CHOWN_FIX(ME, MY_GID)],
      [ME + 1, ENV_FIX],
    ] as const) {
      for (const which of ['secrets', 'data', 'secrets/vault_key']) {
        const dir = empty();
        expect(run(dir).code).toBe(0);
        const r = run(dir, [], {}, { [which]: owner });
        expect([which, r.code]).toEqual([which, 1]);
        expect(r.err).toContain(line);
        expect(r.err).toContain(which);
      }
    }
    // A root-owned secrets/ the process cannot write (the engine made it): nothing is created.
    if (ME !== 0) {
      const dir = empty();
      mkdirSync(join(dir, 'secrets'), { mode: 0o500 });
      const r = run(dir, [], {}, { secrets: 0 });
      chmodSync(join(dir, 'secrets'), 0o700);
      expect(r.code).toBe(1);
      expect(r.err).toContain(CHOWN_FIX(ME, MY_GID));
      expect(readdirSync(join(dir, 'secrets'))).toEqual([]);
    }
  });

  test('an install directory it cannot write is named with the fix for its owner', () => {
    if (ME === 0) return; // root writes anyway
    for (const [owner, line] of [
      [0, 'sudo chown'],
      [ME + 1, ENV_FIX],
      [ME, 'mount /install read-write'],
    ] as const) {
      const dir = empty();
      chmodSync(dir, 0o555);
      const r = run(dir, [], {}, { '.': owner });
      chmodSync(dir, 0o755);
      expect([owner, r.code]).toEqual([owner, 1]);
      expect(r.err).toContain(line);
      expect(existsSync(join(dir, 'secrets'))).toBe(false);
    }
    // One it cannot even search (another user's 0700 directory): the same fix, not a stack trace.
    for (const [owner, line] of [
      [0, 'sudo chown'],
      [ME + 1, ENV_FIX],
    ] as const) {
      const dir = empty();
      mkdirSync(join(dir, 'secrets'), { mode: 0o700 });
      chmodSync(dir, 0o600);
      let r: ReturnType<typeof run>;
      try {
        r = run(dir, [], {}, { '.': owner });
      } finally {
        chmodSync(dir, 0o755);
      }
      expect([owner, r.code]).toEqual([owner, 1]);
      expect(r.err).toContain(line);
      expect(r.err).toMatch(/the install directory is not readable/);
    }
  });

  test('bootstrap refuses uid 0 as init does, unless --allow-root', () => {
    const dir = empty();
    const r = run(dir, [], { uid: 0 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to run as root \(uid 0\)/);
    expect(r.err).toContain('JM_UID');
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
    // As root, files root made are its own: the owner check uses the running uid.
    const allowed = run(dir, ['--allow-root'], { uid: ME }, {});
    expect(allowed.code, allowed.all).toBe(0);
  });

  test('a directory argument overrides the install directory; extra or unknown arguments are usage errors', () => {
    const dir = empty();
    const other = empty();
    const r = run(dir, [other]);
    expect(r.code, r.all).toBe(0);
    expect(existsSync(join(other, 'secrets', 'join_token'))).toBe(true);
    expect(existsSync(join(dir, 'secrets'))).toBe(false);
    for (const args of [['a', 'b'], ['--bogus']]) {
      const u = run(dir, args);
      expect(u.code).toBe(2);
      expect(u.err).toMatch(/usage: jumpmaster bootstrap/);
    }
    const help = run(dir, ['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/usage: jumpmaster bootstrap/);
  });

  test('a secrets path that is a file, or a secret that is a directory, is refused', () => {
    const dir = empty();
    writeFileSync(join(dir, 'secrets'), '');
    const r = run(dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/secrets is not a directory/);
    const d2 = empty();
    mkdirSync(join(d2, 'secrets', 'vault_key'), { recursive: true });
    const r2 = run(d2);
    expect(r2.code).toBe(1);
    expect(r2.err).toMatch(/secrets\/vault_key is not a regular file/);
  });
});
