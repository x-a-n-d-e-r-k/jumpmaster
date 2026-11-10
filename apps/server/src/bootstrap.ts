// `jumpmaster bootstrap [dir]`: prepares a compose install directory before the server and the
// stick start (compose's `bootstrap` service runs it, as the host user, with the install directory
// mounted read-write at /install), so `docker compose up` works from an empty directory:
//   - secrets/ and data/, mode 0700 (created, or tightened when they are this user's);
//   - config/, created when missing, so the engine never makes it as root;
//   - secrets/join_token, secrets/operator_token and secrets/vault_key: 32 random bytes each,
//     base64url, mode 0600, written atomically and only when absent; tightened to 0600 when looser.
// A directory or file it cannot own is named with the fix for whoever owns it, and it exits 1, so
// the server does not start. It prints names, never a value. Idempotent.
//
// Exit codes: 0 ready, 1 refused (the reason and the fix are printed), 2 usage.
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DOC } from './doctor/checks.js';

export type BootstrapDeps = {
  /** The install directory (`/install` in the bootstrap container). */
  dir: string;
  /** `process.getuid()` / `getgid()`, or null where there are none. */
  uid: number | null;
  gid: number | null;
  out(line: string): void;
  err(line: string): void;
  /** `lstatSync`, replaceable in tests (an owner cannot be faked otherwise). */
  lstat?: (path: string) => Stats;
};

/** The secrets bootstrap generates: the stick's join token, ctl's operator token, the vault key. */
export const MACHINE_SECRETS = ['join_token', 'operator_token', 'vault_key'] as const;

export const USAGE = 'usage: jumpmaster bootstrap [install-dir] [--allow-root]';

/** The fix when root owns what bootstrap must write. */
export const CHOWN_FIX = (uid: number, gid: number): string =>
  `the directories were created as root (docker compose run with sudo, or by the engine): run  sudo chown -R ${uid}:${gid} secrets data  and start again`;

/** The fix when another user owns it: run the containers as the directory's owner. */
export const ENV_FIX = `set JM_UID and JM_GID in .env to your user: printf 'JM_UID=%s\\nJM_GID=%s\\n' "$(id -u)" "$(id -g)" > .env`;

const errno = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/**
 * Writes a generated secret only when absent, atomically: the whole value goes to a 0600 file
 * beside it, which is then linked into place (refused when the name exists), so no reader ever
 * sees a partial key and a rerun never replaces one. Returns whether it was created.
 */
export function createSecretOnce(
  path: string,
  text: string,
  link: (from: string, to: string) => void = linkSync,
): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  let linked = false;
  try {
    link(tmp, path);
    linked = true;
  } catch (e) {
    const code = errno(e);
    if (code === 'EEXIST') return false;
    // A filesystem without hard links (some network and FUSE mounts): an exclusive write, which
    // still never replaces a key, though a crash mid-write could leave a short one.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS')
      throw e;
  } finally {
    unlinkSync(tmp);
  }
  if (linked) return true;
  try {
    writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (e) {
    if (errno(e) === 'EEXIST') return false;
    throw e;
  }
}

/** A refusal: what, and the fix. */
class Refusal extends Error {}

export function runBootstrap(argv: string[], deps: BootstrapDeps): number {
  const { out, err } = deps;
  const lstat = deps.lstat ?? lstatSync;
  let dir = deps.dir;
  let allowRoot = false;
  let given = 0;
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      out(USAGE);
      return 0;
    }
    if (a === '--allow-root') allowRoot = true;
    else if (!a.startsWith('-') && given === 0) {
      dir = a;
      given++;
    } else {
      err(`jumpmaster bootstrap: unexpected argument ${a}`);
      err(USAGE);
      return 2;
    }
  }
  const uid = deps.uid;
  const gid = deps.gid ?? uid;
  if (uid === 0 && !allowRoot) {
    err(
      `jumpmaster bootstrap: refusing to run as root (uid 0): the server holds your GitHub and Claude tokens and runs as the user that owns the install's files. Set JM_UID and JM_GID in .env to an ordinary user (id -u, id -g); compose defaults them to 1000 (${DOC}#uid).`,
    );
    return 1;
  }

  const done: string[] = [];
  /** Root (only with --allow-root) may write anything: ownership is not its to check. */
  const owns = (st: Stats): boolean => uid === 0 || st.uid === uid;
  /** The fix for `rel`, owned by `owner` (or by this user and still not writable). */
  const fixFor = (rel: string, owner: number | undefined, why: string): Refusal => {
    const fix =
      owner === 0
        ? rel === '.'
          ? `the install directory is owned by root: run  sudo chown ${uid}:${gid} .  in it, and start again`
          : CHOWN_FIX(uid ?? 0, gid ?? 0)
        : owner !== undefined && owner !== uid
          ? ENV_FIX
          : 'mount /install read-write (compose mounts the install directory as .:/install), owned by the JM_UID user';
    const where = rel === '.' ? 'the install directory' : rel;
    return new Refusal(`${where} ${why}: ${fix}`);
  };
  const ownerOf = (rel: string): number | undefined => {
    try {
      return lstat(rel === '.' ? dir : join(dir, rel)).uid;
    } catch {
      return undefined;
    }
  };
  /** A directory under the install directory: made when missing, owned and tightened when not. */
  const ensureDir = (rel: string, tighten: boolean): void => {
    const path = join(dir, rel);
    let st: Stats;
    try {
      st = lstat(path);
    } catch (e) {
      // Another user's 0700 directory cannot even be searched.
      if (errno(e) === 'EACCES') throw fixFor('.', ownerOf('.'), 'is not readable (EACCES)');
      if (errno(e) !== 'ENOENT') throw e;
      try {
        mkdirSync(path, { mode: 0o700 });
        // The umask cannot loosen 0700, but a directory made by a looser default is set exactly.
        chmodSync(path, tighten ? 0o700 : 0o755);
      } catch (m) {
        throw fixFor('.', ownerOf('.'), `is not writable (${errno(m) ?? 'error'})`);
      }
      done.push(`created ${rel}/${tighten ? ' (0700)' : ''}`);
      return;
    }
    if (!st.isDirectory()) throw new Refusal(`${rel} is not a directory: move it aside`);
    if (!tighten) return;
    if (!owns(st)) throw fixFor(rel, st.uid, `is owned by uid ${st.uid}, not ${uid}`);
    if ((st.mode & 0o777) !== 0o700) {
      chmodSync(path, 0o700);
      done.push(`tightened ${rel}/ to 0700`);
    }
  };
  /** A machine secret: generated when absent, owned and tightened when present. */
  const ensureSecret = (name: string): void => {
    const rel = `secrets/${name}`;
    const path = join(dir, rel);
    let st: Stats | undefined;
    try {
      st = lstat(path);
    } catch (e) {
      if (errno(e) === 'EACCES')
        throw fixFor('secrets', ownerOf('secrets'), 'is not readable (EACCES)');
      if (errno(e) !== 'ENOENT') throw e;
    }
    if (!st) {
      try {
        if (createSecretOnce(path, `${randomBytes(32).toString('base64url')}\n`)) {
          done.push(`generated ${rel} (0600)`);
          return;
        }
      } catch (e) {
        throw fixFor('secrets', ownerOf('secrets'), `is not writable (${errno(e) ?? 'error'})`);
      }
      st = lstat(path); // made by a concurrent run: check it as an existing one
    }
    if (!st.isFile()) throw new Refusal(`${rel} is not a regular file: move it aside`);
    if (!owns(st)) throw fixFor(rel, st.uid, `is owned by uid ${st.uid}, not ${uid}`);
    if ((st.mode & 0o077) !== 0) {
      chmodSync(path, 0o600);
      done.push(`tightened ${rel} to 0600`);
    }
  };

  try {
    ensureDir('secrets', true);
    ensureDir('data', true);
    ensureDir('config', false);
    for (const name of MACHINE_SECRETS) ensureSecret(name);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    for (const d of done) out(`jumpmaster bootstrap: ${d}`);
    err(`jumpmaster bootstrap: ${e.message}`);
    return 1;
  }
  for (const d of done) out(`jumpmaster bootstrap: ${d}`);
  if (done.length === 0)
    out(
      'jumpmaster bootstrap: nothing to do: secrets/, data/ and the machine secrets are in place',
    );
  return 0;
}

/** The real dependencies, for the CLI. */
export function bootstrapMain(argv: string[]): number {
  return runBootstrap(argv, {
    dir: process.env.JM_INSTALL_DIR || process.cwd(),
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
