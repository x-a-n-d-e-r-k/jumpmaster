import { createPrivateKey } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_SECRET_FILE_BYTES } from '@jumpmaster/protocol';
import { isOwnerName } from '../forge/github.js';
import type { InstallCredential, OtherSource } from './credentials.js';
import { fingerprintOf, type Vault, VaultKeyError } from './vault.js';

/**
 * GitHub App credentials, keyed by owner and role (§4.4): the vault entry
 * `github-app/<owner>/<role>`, or the file `<secrets>/github-app/<owner>/<role>.json`, holds one
 * app's `{ appId, slug, clientId, pem, importedAt }`. Owners are case-insensitive on GitHub, so
 * the owner is lowercased in every name: `Acme/x` and `acme/y` share one entry.
 *
 * No error, and nothing returned other than `entry`, holds a PEM, a line of one, the JSON text or
 * any field's value; a refused owner or repository is never echoed either (a token passed in the
 * wrong slot would leak).
 */

export type GitHubAppEntry = {
  appId: string;
  slug: string;
  clientId: string;
  pem: string;
  importedAt: string;
};

export const APP_ROLES = ['author', 'reviewer'] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Which credential a zone uses for a role: its owner's app, or an install-wide PAT. */
export type CredentialRef =
  | { kind: 'github-app'; owner: string }
  | { kind: 'github-pat'; name: InstallCredential };

const isAppRole = (r: string): r is AppRole => (APP_ROLES as readonly string[]).includes(r);

/** The owner, lowercased; throws (never echoing the input) when it is not a GitHub owner name. */
function normalOwner(owner: string): string {
  if (typeof owner !== 'string' || !isOwnerName(owner))
    throw new Error('github-app: the owner is not a valid GitHub owner name');
  return owner.toLowerCase();
}

function checkRole(role: string): asserts role is AppRole {
  if (!isAppRole(role)) throw new Error('github-app: the role is not author or reviewer');
}

/** `github-app/<lowercased owner>/<role>`. */
export function appEntryName(owner: string, role: AppRole): string {
  checkRole(role);
  return `github-app/${normalOwner(owner)}/${role}`;
}

/** The owner and role of an app entry name, or undefined for any other name. */
export function parseAppEntryName(name: string): { owner: string; role: AppRole } | undefined {
  const m = /^github-app\/([^/]+)\/([^/]+)$/.exec(name);
  if (!m) return undefined;
  const [, owner, role] = m as unknown as [string, string, string];
  if (!isAppRole(role) || !isOwnerName(owner) || owner !== owner.toLowerCase()) return undefined;
  return { owner, role };
}

/** The lowercased owner of `owner/name`; throws (never echoing the input) on anything else. */
export function ownerOfRepo(repo: string): string {
  const parts = typeof repo === 'string' ? repo.split('/') : [];
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name || !isOwnerName(owner))
    throw new Error('github-app: a repository is OWNER/NAME with a valid GitHub OWNER name');
  return owner.toLowerCase();
}

const FIELDS = ['appId', 'slug', 'clientId', 'pem', 'importedAt'] as const;

/** One PKCS#1 (`RSA PRIVATE KEY`) or PKCS#8 (`PRIVATE KEY`) block, base64 lines of at most 64. */
const PEM_BLOCK =
  /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/]{1,64}={0,2}\r?\n)+-----END \1PRIVATE KEY-----(?:\r?\n)?$/;
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isPrivateKeyPem(pem: string): boolean {
  if (!PEM_BLOCK.test(pem)) return false;
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

function isIsoDateTime(s: string): boolean {
  const m = ISO_DATE_TIME.exec(s);
  if (!m) return false;
  const [, y, mo, d, h, mi, sec, oh, om] = m.map(Number) as number[];
  const days = new Date(Date.UTC(y as number, mo as number, 0)).getUTCDate();
  return (
    (mo as number) >= 1 &&
    (mo as number) <= 12 &&
    (d as number) >= 1 &&
    (d as number) <= days &&
    (h as number) <= 23 &&
    (mi as number) <= 59 &&
    (sec as number) <= 59 &&
    (Number.isNaN(oh) || (oh as number) <= 23) &&
    (Number.isNaN(om) || (om as number) <= 59)
  );
}

const refuse = (problem: string): Error => new Error(`github-app entry: ${problem}`);

/** An unknown key is named only when it looks like a field name, never when it might be a value. */
const knownLooking = (k: string): string => (/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(k) ? k : '');

/**
 * Parses and checks an entry's JSON text: every field present, of its shape, and nothing else.
 * A refusal names the field, never its value, the PEM or the text.
 */
export function parseAppEntry(json: string): GitHubAppEntry {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    throw refuse('is not valid JSON');
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o))
    throw refuse('must be a JSON object');
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec))
    if (!(FIELDS as readonly string[]).includes(k)) {
      const shown = knownLooking(k);
      throw refuse(shown ? `unknown field ${shown}` : 'an unknown field');
    }
  for (const f of FIELDS) {
    if (!Object.hasOwn(rec, f)) throw refuse(`field ${f} is missing`);
    const v = rec[f];
    if (typeof v !== 'string') throw refuse(`field ${f} must be a string`);
    if (v === '') throw refuse(`field ${f} is empty`);
  }
  const e = rec as GitHubAppEntry;
  if (!/^[0-9]+$/.test(e.appId)) throw refuse('field appId must be decimal digits');
  if (!isPrivateKeyPem(e.pem))
    throw refuse('field pem must be one PKCS#1 or PKCS#8 PEM private-key block');
  if (!isIsoDateTime(e.importedAt)) throw refuse('field importedAt must be an ISO-8601 date-time');
  return {
    appId: e.appId,
    slug: e.slug,
    clientId: e.clientId,
    pem: e.pem,
    importedAt: e.importedAt,
  };
}

/** Canonical JSON: keys in the order appId, slug, clientId, pem, importedAt, no whitespace. */
export function serializeAppEntry(entry: GitHubAppEntry): string {
  return JSON.stringify({
    appId: entry.appId,
    slug: entry.slug,
    clientId: entry.clientId,
    pem: entry.pem,
    importedAt: entry.importedAt,
  });
}

export type AppEntryRead =
  | {
      entry: GitHubAppEntry;
      source: 'file' | 'vault';
      path?: string;
      fingerprint: string;
      overriding?: OtherSource[];
    }
  | { source: 'missing'; undecryptable?: true };

const errno = (e: unknown): string | undefined =>
  e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined;

/** Whether a name exists in the directory at all, a dangling link included. */
const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * An entry file's text, with the checks a secret file gets (opened non-blocking, a regular file,
 * not group- or world-writable, at most 64 KiB), but whitespace kept: a PEM spans lines. Errors
 * name the path, never the contents.
 */
function readEntryFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0));
  } catch (e) {
    const code = errno(e);
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error(`${path} is not readable by uid ${process.getuid?.() ?? '?'}`);
    if (code === 'ENOENT') throw new Error(`${path} does not exist`);
    throw new Error(`${path} cannot be opened (${code ?? 'error'})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
    if ((stat.mode & 0o022) !== 0)
      throw new Error(`${path} is group- or world-writable; chmod go-w it`);
    if (stat.size > MAX_SECRET_FILE_BYTES) throw new Error(`${path} is larger than 64 KiB`);
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buffer, length, buffer.length - length, null);
      } catch (e) {
        throw new Error(`${path} cannot be read (${errno(e) ?? 'error'})`);
      }
      if (n === 0) break;
      length += n;
      if (length > MAX_SECRET_FILE_BYTES) throw new Error(`${path} is larger than 64 KiB`);
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Parses, with a refusal's message prefixed by where the text came from (never the text). */
function parseFrom(where: string, text: string): GitHubAppEntry {
  try {
    return parseAppEntry(text);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

/**
 * An owner's app entry for a role, from the file `<secretsDir>/github-app/<owner>/<role>.json` or
 * the vault entry `github-app/<owner>/<role>`, as `pick` in credentials.ts orders them: the file
 * wins, or with `preferVault` the vault does, and the other one is listed in `overriding`. A
 * disabled vault holds nothing; a vault entry that won't decrypt is `missing` with
 * `undecryptable` when no file holds one. The fingerprint is of the canonical serialization, so a
 * file and a vault entry holding the same app agree. Only the source in use is parsed: a broken
 * entry the other source overrides does not stop the read.
 */
export function readAppEntry(
  o: { vault: Vault | 'disabled'; secretsDir?: string; preferVault?: boolean },
  owner: string,
  role: AppRole,
): AppEntryRead {
  const name = appEntryName(owner, role);
  const lower = normalOwner(owner);
  const path = o.secretsDir ? join(o.secretsDir, 'github-app', lower, `${role}.json`) : undefined;
  const filePath = path && present(path) ? path : undefined;

  let vaultText: string | undefined;
  let undecryptable = false;
  if (o.vault !== 'disabled' && o.vault.meta(name)) {
    try {
      vaultText = o.vault.get(name);
    } catch (e) {
      if (!(e instanceof VaultKeyError)) throw e;
      undecryptable = true;
    }
  }

  type Candidate = OtherSource & { take(): AppEntryRead & { source: 'file' | 'vault' } };
  const candidates: Candidate[] = [];
  if (filePath)
    candidates.push({
      source: 'file',
      path: filePath,
      take: () => {
        const entry = parseFrom(filePath, readEntryFile(filePath));
        return {
          entry,
          source: 'file',
          path: filePath,
          fingerprint: fingerprintOf(serializeAppEntry(entry)),
        };
      },
    });
  if (vaultText !== undefined) {
    const text = vaultText;
    const v: Candidate = {
      source: 'vault',
      take: () => {
        const entry = parseFrom(`the vault entry ${name}`, text);
        return { entry, source: 'vault', fingerprint: fingerprintOf(serializeAppEntry(entry)) };
      },
    };
    if (o.preferVault === true) candidates.unshift(v);
    else candidates.push(v);
  }
  const [first, ...rest] = candidates;
  if (!first)
    return undecryptable ? { source: 'missing', undecryptable: true } : { source: 'missing' };
  const chosen = first.take();
  const overriding = rest.map(({ source, path: p }) => ({ source, ...(p ? { path: p } : {}) }));
  return overriding.length > 0 ? { ...chosen, overriding } : chosen;
}
