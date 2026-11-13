import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readSecret, readSecretFile } from '@jumpmaster/protocol';
import { fingerprintOf, type Vault, VaultKeyError, type VaultMeta } from './vault.js';

/**
 * The credentials (§7.5): which there are, where each comes from, and how each is tested on entry.
 * A credential is read, in order, from its variable (`NAME_FILE` or `NAME`, as M4 read it), from
 * a file named for it under the secrets directory (the four install-wide ones), from the vault, or
 * it is missing. A file or a variable is the operator's and wins; the vault serves what is not
 * there. Values never leave this module except as `Resolved[name].value`.
 */

export const INSTALL_CREDENTIALS = [
  'claudeToken',
  'githubAuthorToken',
  'githubReviewerToken',
  'githubReadToken',
] as const;
export type InstallCredential = (typeof INSTALL_CREDENTIALS)[number];
/** The last form is a zone's gate secret (today's `JM_ZONE_SECRET_<ZONE>_<NAME>`). */
export type CredentialName = InstallCredential | `zone:${string}:${string}`;

/** The file each install-wide credential is read from under the secrets directory. */
export const SECRET_FILES: Record<InstallCredential, string> = {
  claudeToken: 'claude_token',
  githubAuthorToken: 'github_author_token',
  githubReviewerToken: 'github_reviewer_token',
  githubReadToken: 'github_read_token',
};

/** The variable each install-wide credential is read from (`NAME` or `NAME_FILE`). */
export const CREDENTIAL_VARS: Record<InstallCredential, string> = {
  claudeToken: 'JM_CLAUDE_TOKEN',
  githubAuthorToken: 'JM_GITHUB_AUTHOR_TOKEN',
  githubReviewerToken: 'JM_GITHUB_REVIEWER_TOKEN',
  githubReadToken: 'JM_GITHUB_READ_TOKEN',
};

/** What a person reads beside each name. */
export const CREDENTIAL_ROLES: Record<InstallCredential, string> = {
  claudeToken: 'Claude token (claude setup-token): runs the agent in every drop',
  githubAuthorToken: 'GitHub author token: opens and merges the agent PRs',
  githubReviewerToken: 'GitHub reviewer token: posts reviews (two-bot zones)',
  githubReadToken: 'GitHub read token: lets review drops read a private repository',
};

/** Shorter gate secrets can't be redacted without mangling ordinary output. */
export const MIN_GATE_SECRET = 8;

export const gateSecretName = (zoneId: string, name: string): CredentialName =>
  `zone:${zoneId}:${name}`;

/** The variable of a gate secret, as M4 named it. */
export const gateSecretVar = (zoneId: string, name: string): string =>
  `JM_ZONE_SECRET_${zoneId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name}`;

export const isInstallCredential = (n: string): n is InstallCredential =>
  (INSTALL_CREDENTIALS as readonly string[]).includes(n);

/** `zone:<id>:<NAME>` split, or undefined. */
export function parseGateSecretName(n: string): { zoneId: string; name: string } | undefined {
  const m = /^zone:(.+):([A-Z][A-Z0-9_]*)$/.exec(n);
  return m ? { zoneId: m[1] as string, name: m[2] as string } : undefined;
}

export const isCredentialName = (n: string): n is CredentialName =>
  isInstallCredential(n) || parseGateSecretName(n) !== undefined;

export type ResolvedCredential = {
  value?: string;
  source: 'file' | 'env' | 'vault' | 'missing';
  /** The file it was read from, or the variable for a plain environment value. */
  path?: string;
  fingerprint?: string;
  setAt?: string;
  declaredCreatedAt?: string;
  testedAt?: string;
  testResult?: string;
  login?: string;
  /** A vault entry that does not decrypt under the current key (doctor `vault.key`). */
  undecryptable?: true;
};

export type Resolved = Record<CredentialName, ResolvedCredential> &
  Record<InstallCredential, ResolvedCredential>;

const fromVaultMeta = (m: VaultMeta): Partial<ResolvedCredential> => ({
  fingerprint: m.fingerprint,
  setAt: m.createdAt,
  ...(m.declaredCreatedAt ? { declaredCreatedAt: m.declaredCreatedAt } : {}),
  ...(m.testedAt ? { testedAt: m.testedAt } : {}),
  ...(m.testResult ? { testResult: m.testResult } : {}),
  ...(m.login ? { login: m.login } : {}),
});

function fromVault(vault: Vault | 'disabled', name: string): ResolvedCredential {
  if (vault === 'disabled') return { source: 'missing' };
  const meta = vault.meta(name);
  if (!meta) return { source: 'missing' };
  try {
    const value = vault.get(name) as string;
    return { value, source: 'vault', ...fromVaultMeta(meta) };
  } catch (e) {
    if (!(e instanceof VaultKeyError)) throw e;
    return { source: 'missing', undecryptable: true, fingerprint: meta.fingerprint };
  }
}

/** A variable (`NAME_FILE` or `NAME`) as a resolved credential, or undefined when it is unset. */
function fromEnv(
  env: NodeJS.ProcessEnv,
  variable: string,
  warn: ((msg: string) => void) | undefined,
): ResolvedCredential | undefined {
  let shimmed: string | undefined;
  const value = readSecret(env, variable, (msg) => {
    shimmed = msg;
    warn?.(msg);
  });
  if (value === undefined || value === '') return undefined;
  const filePath = env[`${variable}_FILE`];
  if (filePath) {
    const dir = env.JM_SECRETS_DIR;
    const path =
      shimmed && dir
        ? join(dir, SECRET_FILES[installOfVar(variable) as InstallCredential] ?? '')
        : filePath;
    return { value, source: 'file', path, fingerprint: fingerprintOf(value) };
  }
  return { value, source: 'env', path: variable, fingerprint: fingerprintOf(value) };
}

/** Whether a name exists in the directory at all, a dangling link included. */
const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const installOfVar = (variable: string): InstallCredential | undefined =>
  INSTALL_CREDENTIALS.find((n) => CREDENTIAL_VARS[n] === variable);

/**
 * Every install-wide credential, and the gate secrets named, resolved from their variable, the
 * file named for them under `secretsDir`, the vault, or missing. An unreadable file or variable
 * throws naming it (never the value), so the start says which; a vault entry that does not
 * decrypt is `missing` with `undecryptable` (the doctor's `vault.key`).
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv,
  secretsDir: string | undefined,
  vault: Vault | 'disabled',
  o: { gateSecrets?: { zoneId: string; name: string }[]; warn?: (msg: string) => void } = {},
): Resolved {
  const out = {} as Resolved;
  for (const name of INSTALL_CREDENTIALS) {
    const set = (r: ResolvedCredential) =>
      Object.defineProperty(out, name, { value: r, enumerable: true });
    const viaEnv = fromEnv(env, CREDENTIAL_VARS[name], o.warn);
    if (viaEnv) {
      set(viaEnv);
      continue;
    }
    const path = secretsDir ? join(secretsDir, SECRET_FILES[name]) : undefined;
    // lstat, not exists: a dangling link named for a credential is the operator's file, broken,
    // and the read below names it, as it names a dangling `*_FILE` path.
    if (path && present(path)) {
      const value = readSecretFile(path, SECRET_FILES[name]);
      set({ value, source: 'file', path, fingerprint: fingerprintOf(value) });
      continue;
    }
    set(fromVault(vault, name));
  }
  for (const g of o.gateSecrets ?? []) {
    const name = gateSecretName(g.zoneId, g.name);
    const r = fromEnv(env, gateSecretVar(g.zoneId, g.name), o.warn) ?? fromVault(vault, name);
    Object.defineProperty(out, name, { value: r, enumerable: true });
  }
  return out;
}

export type Shadowed = {
  name: CredentialName;
  path: string;
  fileFingerprint: string;
  vaultFingerprint: string;
};

/** Credentials set by a file (or variable) and in the vault with a different value: the file wins. */
export function shadowedCredentials(resolved: Resolved, vault: Vault | 'disabled'): Shadowed[] {
  if (vault === 'disabled') return [];
  const out: Shadowed[] = [];
  for (const [name, r] of Object.entries(resolved) as [CredentialName, ResolvedCredential][]) {
    if (r.source !== 'file' && r.source !== 'env') continue;
    const meta = vault.meta(name);
    if (meta && r.fingerprint && meta.fingerprint !== r.fingerprint)
      out.push({
        name,
        path: r.path ?? '',
        fileFingerprint: r.fingerprint,
        vaultFingerprint: meta.fingerprint,
      });
  }
  return out;
}

/**
 * A hash over the forge credentials' fingerprints (the forge pair cache's key): it changes with
 * any of them and holds none.
 */
export function credentialFingerprint(resolved: Resolved): string {
  const parts = (['githubAuthorToken', 'githubReviewerToken', 'githubReadToken'] as const).map(
    (n) => `${n}=${resolved[n]?.fingerprint ?? ''}`,
  );
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * When a credential was created, for its age: a vault credential's declared date (else the day it
 * was set), whatever the config mode; for one the vault does not hold, `claude.tokenCreatedAt`.
 * The Credentials tab, its banner and the doctor all read it here, so they agree.
 */
export function credentialCreatedAt(
  name: CredentialName,
  resolved: Resolved,
  claude: { tokenCreatedAt?: string },
): string | undefined {
  const r = resolved[name];
  if (r?.source === 'vault') return r.declaredCreatedAt ?? r.setAt?.slice(0, 10);
  return name === 'claudeToken' ? claude.tokenCreatedAt : undefined;
}

/** What a test on entry says: never the value, never GitHub's error text. */
export type TestResult =
  | { ok: true; result: string; login?: string }
  | { ok: false; status: number | null; permission?: string; problem?: string };

export type TestDeps = {
  zones: readonly { id: string; repo: string }[];
  /** A forge on `token` for `repo`: its account's login and its access to the repository. */
  forge(
    token: string,
    repo: string,
  ): {
    viewerLogin(): Promise<string>;
    repoAccess(): Promise<unknown>;
  };
};

/**
 * A refused test in words a page can show: what GitHub's status means and what to do next.
 * Built from the status and the permission GitHub names, never from GitHub's message or the value.
 */
export function refusalWords(status: number | null, permission?: string): string {
  if (status === 401)
    return "GitHub rejected this token (401): it is expired, revoked or mistyped. Make a new one (the GitHub step and each project's GitHub page have the links).";
  if (status === 403)
    return `GitHub refused it (403): the token lacks a permission${permission ? ` (it needs ${permission})` : ''}, or an organization policy or a rate limit refused it. Edit the token on GitHub to add the permission, or wait and try again.`;
  if (status === 404)
    return "The token can't see a project's repository (404): on GitHub, add the repository to the token's repository access.";
  if (status === null) return 'GitHub did not answer: check this host reaches api.github.com.';
  return `GitHub did not accept the test (HTTP ${status}): try again in a moment.`;
}

/** The status GitHub answered and the permission it says the endpoint accepts; nothing else. */
function refusalOf(e: unknown): { ok: false; status: number | null; permission?: string } {
  const status =
    e && typeof e === 'object' && 'status' in e && typeof e.status === 'number' ? e.status : null;
  const headers =
    e && typeof e === 'object' && 'response' in e
      ? (e.response as { headers?: Record<string, unknown> } | undefined)?.headers
      : undefined;
  const accepted = headers?.['x-accepted-github-permissions'];
  return {
    ok: false,
    status,
    ...(typeof accepted === 'string' && /^[a-z_]+=[a-z]+(, ?[a-z_]+=[a-z]+)*$/.test(accepted)
      ? { permission: accepted }
      : {}),
  };
}

/**
 * Tests a value before it is stored: a forge author or reviewer token for its login and its
 * access to every zone's repository; the read token for its login; the Claude token by shape only
 * (the doctor drop is the live proof); a gate secret by its length. A failure returns the HTTP
 * status and the permission GitHub names, and nothing else: no message, no body, no value.
 */
export async function testCredential(
  name: CredentialName,
  value: string,
  deps: TestDeps,
): Promise<TestResult> {
  if (name === 'claudeToken')
    return value.startsWith('sk-ant-')
      ? { ok: true, result: 'shape ok: the doctor drop is the live proof' }
      : {
          ok: false,
          status: null,
          problem: 'a Claude token from claude setup-token starts with sk-ant-',
        };
  if (parseGateSecretName(name))
    return value.length >= MIN_GATE_SECRET
      ? { ok: true, result: 'length ok' }
      : { ok: false, status: null, problem: 'a gate secret is at least 8 characters' };
  const first = deps.zones[0];
  const repo = first?.repo ?? 'octocat/Hello-World';
  try {
    const login = await deps.forge(value, repo).viewerLogin();
    if (name === 'githubAuthorToken' || name === 'githubReviewerToken')
      for (const z of deps.zones) await deps.forge(value, z.repo).repoAccess();
    return { ok: true, result: 'ok', login };
  } catch (e) {
    return refusalOf(e);
  }
}
