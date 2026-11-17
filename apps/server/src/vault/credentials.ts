import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readSecret, readSecretFile } from '@jumpmaster/protocol';
import { appJwt } from '../forge/github-app.js';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';
import { APP_ROLES, appEntryName, type GitHubAppEntry } from './github-app-entries.js';
import type { ResolvedApps } from './resolution.js';
import { fingerprintOf, type Vault, VaultKeyError, type VaultMeta } from './vault.js';

/**
 * The credentials (§7.5): which there are, where each comes from, and how each is tested on entry.
 * A credential is read, in order, from its variable (`NAME_FILE` or `NAME`, as M4 read it), from
 * a file named for it under the secrets directory (the four install-wide ones), from the vault, or
 * it is missing. A file or a variable is the operator's and wins; the vault serves what is not
 * there. With Settings' "Prefer the vault" on, a vault entry wins instead. Values never leave this module except as `Resolved[name].value`.
 */

export const INSTALL_CREDENTIALS = [
  'claudeToken',
  'githubAuthorToken',
  'githubReviewerToken',
  'githubReadToken',
  'registryReadToken',
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
  registryReadToken: 'registry_read_token',
};

/** The variable each install-wide credential is read from (`NAME` or `NAME_FILE`). */
export const CREDENTIAL_VARS: Record<InstallCredential, string> = {
  claudeToken: 'JM_CLAUDE_TOKEN',
  githubAuthorToken: 'JM_GITHUB_AUTHOR_TOKEN',
  githubReviewerToken: 'JM_GITHUB_REVIEWER_TOKEN',
  githubReadToken: 'JM_GITHUB_READ_TOKEN',
  registryReadToken: 'JM_REGISTRY_READ_TOKEN',
};

/** What a person reads beside each name. */
export const CREDENTIAL_ROLES: Record<InstallCredential, string> = {
  claudeToken: 'Claude token (claude setup-token): runs the agent in every drop',
  githubAuthorToken: 'GitHub author token: opens and merges the agent PRs',
  githubReviewerToken: 'GitHub reviewer token: posts reviews (two-bot zones)',
  githubReadToken: 'GitHub read token: lets review drops read a private repository',
  registryReadToken:
    'Registry read token: lets the server mirror the release images from a private registry',
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
  /** The other sources that also hold a value, which this one overrides (never their values). */
  overriding?: OtherSource[];
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

/** Another source that also holds a value for a credential: the one in use overrides it. */
export type OtherSource = { source: 'file' | 'env' | 'vault'; path?: string };

/**
 * Picks the source in use among those that hold a value, in order: the variable, the file by
 * name, the vault; or the vault first when `preferVault` is on. The rest are listed as
 * `overriding` (by source and variable or path, never a value). The file by name is read only
 * when it is the one in use.
 */
function pick(
  viaEnv: ResolvedCredential | undefined,
  filePath: string | undefined,
  readFile: () => ResolvedCredential,
  viaVault: ResolvedCredential,
  preferVault: boolean,
): ResolvedCredential {
  const vaultHolds = viaVault.source === 'vault';
  const candidates: (OtherSource & { take(): ResolvedCredential })[] = [];
  if (viaEnv)
    candidates.push({
      source: viaEnv.source as 'file' | 'env',
      ...(viaEnv.path ? { path: viaEnv.path } : {}),
      take: () => viaEnv,
    });
  if (filePath) candidates.push({ source: 'file', path: filePath, take: readFile });
  if (vaultHolds) {
    const v = { source: 'vault' as const, take: () => viaVault };
    if (preferVault) candidates.unshift(v);
    else candidates.push(v);
  }
  const [first, ...rest] = candidates;
  if (!first) return viaVault;
  const chosen = first.take();
  const overriding = rest.map(({ source, path }) => ({ source, ...(path ? { path } : {}) }));
  return overriding.length > 0 ? { ...chosen, overriding } : chosen;
}

/**
 * Every install-wide credential, and the gate secrets named, resolved from their variable, the
 * file named for them under `secretsDir`, the vault, or missing; with `preferVault`, a vault entry
 * comes first. An unreadable file or variable throws naming it (never the value), so the start
 * says which; a vault entry that does not decrypt is `missing` with `undecryptable` (the doctor's
 * `vault.key`) when nothing else holds a value.
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv,
  secretsDir: string | undefined,
  vault: Vault | 'disabled',
  o: {
    gateSecrets?: { zoneId: string; name: string }[];
    warn?: (msg: string) => void;
    preferVault?: boolean;
  } = {},
): Resolved {
  const out = {} as Resolved;
  const prefer = o.preferVault === true;
  for (const name of INSTALL_CREDENTIALS) {
    const viaEnv = fromEnv(env, CREDENTIAL_VARS[name], o.warn);
    const path = secretsDir ? join(secretsDir, SECRET_FILES[name]) : undefined;
    // lstat, not exists: a dangling link named for a credential is the operator's file, broken,
    // and the read names it, as it names a dangling `*_FILE` path.
    const filePath = path && present(path) ? path : undefined;
    const readFile = (): ResolvedCredential => {
      const value = readSecretFile(filePath as string, SECRET_FILES[name]);
      return { value, source: 'file', path: filePath, fingerprint: fingerprintOf(value) };
    };
    const r = pick(viaEnv, filePath, readFile, fromVault(vault, name), prefer);
    Object.defineProperty(out, name, { value: r, enumerable: true });
  }
  for (const g of o.gateSecrets ?? []) {
    const name = gateSecretName(g.zoneId, g.name);
    const viaEnv = fromEnv(env, gateSecretVar(g.zoneId, g.name), o.warn);
    const r = pick(
      viaEnv,
      undefined,
      () => ({ source: 'missing' }),
      fromVault(vault, name),
      prefer,
    );
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
 * A hash over the forge credentials' fingerprints (the forge pair cache's key for a zone with an
 * app role, `pairKey` in outbox.ts; a PAT-only zone keeps its key from before): it changes with
 * any of them, and with any present app entry (by entry name, sorted), and holds none. With no
 * present app entry it is the PAT-only value.
 */
export function credentialFingerprint(resolved: Resolved, apps?: ResolvedApps): string {
  const parts = (['githubAuthorToken', 'githubReviewerToken', 'githubReadToken'] as const).map(
    (n) => `${n}=${resolved[n]?.fingerprint ?? ''}`,
  );
  parts.push(...appEntryFingerprints(apps));
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Each present app entry as `<entry name>=<fingerprint>`, sorted: what `credentialFingerprint`
 * adds for the apps, and what the config store compares to tell a changed app entry (issue #266).
 * Holds no secret.
 */
export function appEntryFingerprints(apps?: ResolvedApps): string[] {
  const out: string[] = [];
  for (const [owner, reads] of apps ?? [])
    for (const role of APP_ROLES) {
      const r = reads[role];
      if (r.source !== 'missing') out.push(`${appEntryName(owner, role)}=${r.fingerprint}`);
    }
  return out.sort();
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
  /** `live`: the provider itself answered (GitHub); without it only the value's form was checked. */
  | { ok: true; result: string; login?: string; live?: true }
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

const REJECTED = 'GitHub rejected this token (401): it is expired, revoked or mistyped.';

/**
 * A refused test in words a page can show: what GitHub's status means and what to do next.
 * Built from the status, the permission GitHub names and where the credential comes from (its
 * variable or file, so a 401 says where to change it), never from GitHub's message or the value.
 */
export function refusalWords(
  status: number | null,
  permission?: string,
  from?: Pick<ResolvedCredential, 'source' | 'path'>,
): string {
  if (status === 401) {
    if (from?.source === 'env' && from.path)
      return `${REJECTED} It comes from the environment variable ${from.path}: make a new token on GitHub, set ${from.path} to it where the server's environment is set, and restart the server.`;
    if (from?.source === 'file' && from.path)
      return `${REJECTED} It is read from the file ${from.path}: make a new token on GitHub, replace the file's contents with it, and restart the server.`;
    return `${REJECTED} Make a new one (the GitHub step and each project's GitHub page have the links).`;
  }
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
 * access to every zone's repository; the read token for its login; the registry read token by its
 * length (the image mirror is its live proof); the Claude token by shape only
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
  if (name === 'registryReadToken')
    // Not a forge token: the registry is the judge, and the image mirror asks it (Sticks, Images).
    return value.length >= MIN_GATE_SECRET
      ? { ok: true, result: 'stored: the image mirror is the live proof (Sticks, Images)' }
      : { ok: false, status: null, problem: 'a registry token is at least 8 characters' };
  const first = deps.zones[0];
  const repo = first?.repo ?? 'octocat/Hello-World';
  try {
    const login = await deps.forge(value, repo).viewerLogin();
    if (name === 'githubAuthorToken' || name === 'githubReviewerToken')
      for (const z of deps.zones) await deps.forge(value, z.repo).repoAccess();
    return { ok: true, result: 'ok', login, live: true };
  } catch (e) {
    return refusalOf(e);
  }
}

const APP_KEY_REJECTED =
  "GitHub rejected this app's key (401): it is the wrong key or it was revoked. Generate a new private key on the app's page and import it again.";
const APP_ID_MISMATCH =
  "GitHub says this key belongs to a different app than the entry's app id: re-import the app";
const APP_SLUG_MISMATCH =
  "GitHub names this app differently from the entry's slug: re-import the app";

/**
 * Tests a GitHub App entry (§4.4): signs the app JWT with the entry's key and calls `GET /app`.
 * A 401 means a wrong or revoked key; a 200 must name the entry's app id and slug. The PEM and the
 * JWT are registered with `scrub` before the request is sent. Like `testCredential`, a result
 * holds a status and fixed words only: never GitHub's body, an id, a slug, the key or the JWT.
 */
export async function testAppEntry(
  entry: GitHubAppEntry,
  deps: {
    apiBase?: string;
    now?: () => number;
    scrub?: Pick<ScrubSet, 'add' | 'addPem'>;
  } = {},
): Promise<TestResult> {
  const scrub = deps.scrub ?? serverScrubSet;
  const apiBase = (deps.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const now = deps.now ?? Date.now;
  scrub.addPem(entry.pem);
  let jwt: string;
  try {
    jwt = appJwt(entry.appId, entry.pem, Math.floor(now() / 1000));
  } catch {
    // The exception text can quote key material.
    return { ok: false, status: null, problem: 'the private key could not be used to sign' };
  }
  scrub.add(jwt);
  let res: Response;
  try {
    res = await fetch(`${apiBase}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    return { ok: false, status: null, problem: 'GitHub could not be reached' };
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: 401, problem: APP_KEY_REJECTED };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status };
  }
  let body: { id?: unknown; slug?: unknown } | null;
  try {
    body = (await res.json()) as { id?: unknown; slug?: unknown } | null;
  } catch {
    return { ok: false, status: 200 };
  }
  if (String(body?.id) !== entry.appId) return { ok: false, status: 200, problem: APP_ID_MISMATCH };
  if (body?.slug !== entry.slug) return { ok: false, status: 200, problem: APP_SLUG_MISMATCH };
  return { ok: true, result: 'ok', login: `${entry.slug}[bot]` };
}
