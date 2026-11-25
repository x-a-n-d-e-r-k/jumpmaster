import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import {
  type CloneGrant,
  type ClonePayload,
  type CloneResult,
  gitlabBasicAuthAs,
  READY_LINE,
  RESULT_PREFIX,
  withBasicAuth,
} from '@jumpmaster/protocol';
import type { initBare, mirrorFetch } from '../git.js';
import { redact } from '../redact.js';
import { readCloneGrant, StdinClosedError } from '../stdin.js';

/**
 * Where the clone container builds the drop's mirror, and where an agent container later finds it
 * (mounted read-only). Fixed, so the stick and the provided-mirror roles agree on it.
 */
export const CLONE_MIRROR_DIR = '/jm/mirror';

export interface CloneDeps {
  /** The rest of stdin after the payload line: the grant arrives here, after the ready line. */
  stdin: Readable;
  emit(line: string): void;
  /** The bare mirror's directory: `CLONE_MIRROR_DIR` in production. */
  mirrorDir: string;
  git: { initBare: typeof initBare; mirrorFetch: typeof mirrorFetch };
}

const REASON_MAX = 2000;
const LEAK_REASON = 'the mirror holds the clone token';

/** The token as it can appear: plain, as `username:token`, and in git's basic-auth (base64) form. */
export const cloneTokenForms = (token: string, username = 'oauth2'): string[] => [
  token,
  `${username}:${token}`,
  gitlabBasicAuthAs(username, token),
];

/** Every secret a clone's output is redacted of: the grant's own, and each form of the token. */
export const cloneGrantSecrets = (g: CloneGrant): string[] => [
  ...g.secrets,
  ...cloneTokenForms(g.token, g.username),
  ...(g.username !== undefined ? cloneTokenForms(g.token) : []),
  ...withBasicAuth(g.token),
];

const CHUNK = 1024 * 1024;

/** True when the regular file at `path` holds any of `needles`, read in `chunk`-byte pieces. */
function fileHolds(path: string, needles: Buffer[], chunk: number): boolean {
  const longest = Math.max(...needles.map((b) => b.length));
  const fd = openSync(path, 'r');
  try {
    // Keep the last `longest - 1` bytes of each piece, so a needle split across two is found.
    let carry = Buffer.alloc(0);
    const buf = Buffer.alloc(chunk);
    for (;;) {
      const got = readSync(fd, buf, 0, chunk, null);
      if (got === 0) return false;
      const window = Buffer.concat([carry, buf.subarray(0, got)]);
      if (needles.some((nd) => window.includes(nd))) return true;
      carry = window.subarray(Math.max(0, window.length - (longest - 1)));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * True when any path under `root` (relative to it), any symlink's target, or any regular file's
 * raw bytes holds one of `needles`. Never follows a link; object contents are not decompressed, so
 * this catches what git or the remote wrote in plain form (config, refs, logs, ref names).
 */
export function mirrorHolds(root: string, needles: string[], chunk = CHUNK): boolean {
  const wanted = needles.filter((s) => s.length > 0);
  if (wanted.length === 0) return false;
  const bytes = wanted.map((s) => Buffer.from(s));
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (wanted.some((s) => relative(root, path).includes(s))) return true;
      const st = lstatSync(path);
      if (st.isDirectory()) {
        if (walk(path)) return true;
      } else if (st.isSymbolicLink()) {
        if (wanted.some((s) => readlinkSync(path).includes(s))) return true;
      } else if (st.isFile() && fileHolds(path, bytes, chunk)) {
        return true;
      }
    }
    return false;
  };
  return walk(root);
}

/** The total size of the regular files under `root`, never following a link. */
function treeBytes(root: string): number {
  let total = 0;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = lstatSync(path);
    if (st.isDirectory()) total += treeBytes(path);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

/** Redacts the reason, bounds it, and serialises the result line with the same secrets. */
function finish(r: CloneResult, secrets: string[], emit: (l: string) => void): CloneResult {
  const out: CloneResult =
    r.status === 'cloned' ? r : { ...r, reason: redact(r.reason, secrets).slice(0, REASON_MAX) };
  // Redact the serialised line too: JSON escaping could otherwise hide a secret from the reason pass.
  emit(redact(RESULT_PREFIX + JSON.stringify(out), secrets));
  return out;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The clone container's role. No agent runs here; the token arrives last.
 *
 * 1. print the ready line; only then read the grant (which carries the token) from stdin;
 * 2. create the root-owned bare mirror: fixed config, no hooks;
 * 3. fetch every head from the grant's GitLab project: no checkout, no submodules, the auth header
 *    only on `<origin>/`, as the grant's username (else `oauth2`), and redirects refused;
 * 4. search every path and file under the mirror for the token's forms; a hit fails the clone.
 *
 * Prints exactly one result line, redacted of the token in every form.
 */
export async function runClone(_payload: ClonePayload, deps: CloneDeps): Promise<CloneResult> {
  // No secret is known before the grant; redact still strips anything token-shaped.
  let secrets: string[] = [];
  const done = (r: CloneResult) => finish(r, secrets, deps.emit);
  const fail = (reason: string, retryable: boolean) =>
    done({ status: 'failed', reason, retryable });
  try {
    deps.emit(READY_LINE);
    let grant: CloneGrant;
    try {
      grant = await readCloneGrant(deps.stdin);
    } catch (e) {
      // The stick went away after ready: retryable. A malformed grant is final.
      if (e instanceof StdinClosedError) return fail(e.message, true);
      return fail(message(e), false);
    }
    secrets = cloneGrantSecrets(grant);
    const mirror = deps.mirrorDir;
    try {
      await deps.git.initBare(mirror);
    } catch (e) {
      return fail(`mirror setup failed: ${message(e)}`, false);
    }
    try {
      await deps.git.mirrorFetch(
        mirror,
        grant.token,
        { owner: '', name: '', forge: grant.forge },
        ['*'],
        {
          ...(grant.username !== undefined ? { username: grant.username } : {}),
          refuseRedirects: true,
        },
      );
    } catch (e) {
      // A network fault or a refused credential: the server may retry with a fresh grant.
      return fail(`clone fetch failed: ${message(e)}`, true);
    }
    // Removes nothing: the stick drops the whole volume with the failed drop.
    if (mirrorHolds(mirror, cloneTokenForms(grant.token, grant.username))) {
      return fail(LEAK_REASON, false);
    }
    return done({ status: 'cloned', bytes: treeBytes(mirror) });
  } catch (e) {
    return fail(message(e), false);
  }
}
