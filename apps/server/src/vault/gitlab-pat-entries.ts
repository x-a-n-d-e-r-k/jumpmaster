import { gitlabBasicAuthAs, isGitLabProjectPath, stripTrailingSlashes } from '@jumpmaster/protocol';
import { ZONE_ID } from '../config.js';
import { GitLabForge, GitLabForgeError } from '../forge/gitlab.js';
import { type ForgeKind, forgeKind, isHttpsOrigin } from '../forge/kind.js';
import { type ScrubSet, serverScrubSet } from '../forge/scrub-set.js';
import type { TestResult } from './credentials.js';
import { APP_ROLES, type AppRole } from './github-app-entries.js';
import { fingerprintOf } from './vault.js';

/**
 * A GitLab zone's bot-user personal access tokens (§9, credential kind `gitlab-pat`), one per role
 * per zone: the vault entry `gitlab-pat/<zoneId>/<role>`. `resolveGitlabPatEntries`
 * (vault/resolution.ts) reads them for the config store.
 *
 * No error and no result holds the token, a refused zone id or role, the base URL or the project
 * path (a token passed in the wrong slot would leak).
 */

export const GITLAB_PAT_ROLES = APP_ROLES;
export type GitLabPatRole = AppRole;

const isRole = (r: unknown): r is GitLabPatRole =>
  typeof r === 'string' && (GITLAB_PAT_ROLES as readonly string[]).includes(r);
const isZoneId = (id: unknown): id is string => typeof id === 'string' && ZONE_ID.test(id);

/** A `gitlab-pat` vault entry's name: `gitlab-pat/<zoneId>/<role>`. */
export type GitlabPatEntryName = `gitlab-pat/${string}/${GitLabPatRole}`;

/** `gitlab-pat/<zoneId>/<role>`; throws (never echoing the input) on a bad zone id or role. */
export function gitlabPatEntryName(zoneId: string, role: GitLabPatRole): GitlabPatEntryName {
  if (!isZoneId(zoneId)) throw new Error('gitlab-pat: the zone id is not a valid zone id');
  if (!isRole(role)) throw new Error('gitlab-pat: the role is not author or reviewer');
  return `gitlab-pat/${zoneId}/${role}`;
}

/** The zone id and role of a `gitlab-pat` entry name, or undefined for any other name. */
export function parseGitlabPatEntryName(
  name: string,
): { zoneId: string; role: GitLabPatRole } | undefined {
  const m = typeof name === 'string' ? /^gitlab-pat\/([^/]+)\/([^/]+)$/.exec(name) : null;
  if (!m) return undefined;
  const [, zoneId, role] = m;
  if (!isZoneId(zoneId) || !isRole(role)) return undefined;
  return { zoneId, role };
}

/** `testGitlabPatEntry`'s problems, exported so a caller can tell them apart. */
export const GITLAB_PAT_REJECTED =
  'GitLab rejected this token (401): it is wrong, expired or revoked';
export const GITLAB_PAT_NOT_GITLAB_ZONE = 'this project is not a GitLab project';
export const GITLAB_PAT_BAD_ZONE =
  "this project's GitLab instance or project path is not valid: check its settings";
export const GITLAB_PAT_FORBIDDEN =
  'GitLab refused this token (403): it needs the read_user or read_api scope';
export const GITLAB_PAT_UNREACHABLE = 'GitLab could not be reached or gave no usable answer';

export type GitLabPatZone = {
  id: string;
  repo: string;
  forge?: ForgeKind | undefined;
  gitlab?: { baseUrl: string } | undefined;
};

/**
 * Tests a GitLab zone's personal access token: `GET /user` on the zone's instance. The token is
 * registered with `scrub` before any request. A result holds a status and fixed words only: never
 * GitLab's body, the error's message, the base URL, the project path or the token. Never throws.
 */
export async function testGitlabPatEntry(
  value: string,
  zone: GitLabPatZone,
  deps: { fetch?: typeof fetch; scrub?: Pick<ScrubSet, 'add'> } = {},
): Promise<TestResult> {
  if (forgeKind(zone) !== 'gitlab')
    return { ok: false, status: null, problem: GITLAB_PAT_NOT_GITLAB_ZONE };
  (deps.scrub ?? serverScrubSet).add(value);
  let forge: GitLabForge;
  try {
    forge = new GitLabForge(
      zone.gitlab?.baseUrl as string,
      zone.repo,
      value,
      deps.fetch ? { fetch: deps.fetch } : {},
    );
  } catch {
    return { ok: false, status: null, problem: GITLAB_PAT_BAD_ZONE };
  }
  try {
    const login = await forge.viewerLogin();
    return { ok: true, result: 'ok', login, live: true };
  } catch (e) {
    const status = e instanceof GitLabForgeError && e.status !== 0 ? e.status : null;
    if (status === 401) return { ok: false, status, problem: GITLAB_PAT_REJECTED };
    if (status === 403) return { ok: false, status, problem: GITLAB_PAT_FORBIDDEN };
    if (status === null) return { ok: false, status, problem: GITLAB_PAT_UNREACHABLE };
    return { ok: false, status };
  }
}

/**
 * `gitlab-pat/<zoneId>/<role>=<fingerprint>` for each present value, and
 * `gitlab-pat/<zoneId>/read=<fingerprint of username:token>` for each resolved read entry, sorted;
 * no secret. What `credentialFingerprint` adds for the resolved GitLab entries.
 */
export function gitlabPatEntryFingerprints(
  entries: Readonly<
    Record<string, { author?: string; reviewer?: string; read?: GitlabReadValue | undefined }>
  >,
): string[] {
  const lines: string[] = [];
  for (const [zoneId, roles] of Object.entries(entries)) {
    for (const role of GITLAB_PAT_ROLES) {
      const v = roles[role];
      if (v !== undefined) lines.push(`${gitlabPatEntryName(zoneId, role)}=${fingerprintOf(v)}`);
    }
    if (roles.read)
      lines.push(
        `${gitlabReadEntryName(zoneId)}=${fingerprintOf(`${roles.read.username}:${roles.read.token}`)}`,
      );
  }
  return lines.sort();
}

/**
 * A GitLab zone's read deploy token (issue #831, ruling 121): the vault entry
 * `gitlab-pat/<zoneId>/read`, a project deploy token with `read_repository` only, which only the
 * clone container uses. It is not a `GITLAB_PAT_ROLES` role: a deploy token can't call `GET /user`,
 * so the role routes, Settings rows, doctor and `pairFor` never see it.
 *
 * Its value is `<username>:<token>`, as GitLab shows both on creation: a deploy token authenticates
 * over git only with its own username. It is split on the first `:`, and both parts are required.
 */
export type GitlabReadValue = { username: string; token: string };

/** A read entry's name: `gitlab-pat/<zoneId>/read`. */
export type GitlabReadEntryName = `gitlab-pat/${string}/read`;

/** `gitlab-pat/<zoneId>/read`; throws (never echoing the input) on a bad zone id. */
export function gitlabReadEntryName(zoneId: string): GitlabReadEntryName {
  if (!isZoneId(zoneId)) throw new Error('gitlab-pat: the zone id is not a valid zone id');
  return `gitlab-pat/${zoneId}/read`;
}

/** The zone id of a read entry name, or undefined for any other name. */
export function parseGitlabReadEntryName(name: string): { zoneId: string } | undefined {
  const m = typeof name === 'string' ? /^gitlab-pat\/([^/]+)\/read$/.exec(name) : null;
  if (!m || !isZoneId(m[1])) return undefined;
  return { zoneId: m[1] };
}

/** `<username>:<token>` split on the first `:`; undefined when either part is empty. */
export function parseGitlabReadValue(value: string): GitlabReadValue | undefined {
  if (typeof value !== 'string') return undefined;
  const i = value.indexOf(':');
  if (i <= 0 || i === value.length - 1) return undefined;
  return { username: value.slice(0, i), token: value.slice(i + 1) };
}

/** The scrub forms of a read entry: the token, the whole value and git's basic-auth form. */
export function gitlabReadSecretForms(read: GitlabReadValue): string[] {
  return [
    read.token,
    `${read.username}:${read.token}`,
    gitlabBasicAuthAs(read.username, read.token),
  ];
}

/** `testGitlabReadEntry`'s problems beside the shared ones. */
export const GITLAB_READ_REJECTED = 'GitLab rejected this deploy token';
export const GITLAB_READ_BAD_VALUE =
  'this deploy token is not in the form <username>:<token>, as GitLab shows them on creation';

const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';

/**
 * Tests a read deploy token with git's smart-HTTP probe: `GET <base>/<project>.git/info/refs
 * ?service=git-upload-pack` with basic auth as `<username>:<token>`, following no redirect. Ok
 * needs a 200 upload-pack advertisement. Every secret form is registered with `scrub` before any
 * request. A result holds a status and fixed words only. Never throws.
 */
export async function testGitlabReadEntry(
  value: string,
  zone: GitLabPatZone,
  deps: { fetch?: typeof fetch; scrub?: Pick<ScrubSet, 'add'> } = {},
): Promise<TestResult> {
  const scrub = deps.scrub ?? serverScrubSet;
  if (typeof value === 'string') scrub.add(value);
  const read = parseGitlabReadValue(value);
  if (read) for (const v of gitlabReadSecretForms(read)) scrub.add(v);
  if (forgeKind(zone) !== 'gitlab')
    return { ok: false, status: null, problem: GITLAB_PAT_NOT_GITLAB_ZONE };
  const baseUrl = zone.gitlab?.baseUrl;
  if (typeof baseUrl !== 'string' || !isHttpsOrigin(baseUrl) || !isGitLabProjectPath(zone.repo))
    return { ok: false, status: null, problem: GITLAB_PAT_BAD_ZONE };
  if (!read) return { ok: false, status: null, problem: GITLAB_READ_BAD_VALUE };
  const url = `${stripTrailingSlashes(baseUrl)}/${zone.repo}.git/info/refs?service=git-upload-pack`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { authorization: `Basic ${gitlabBasicAuthAs(read.username, read.token)}` },
    });
  } catch {
    return { ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE };
  }
  // The body is never read into the result; drop it so the connection is freed.
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403)
    return { ok: false, status: res.status, problem: GITLAB_READ_REJECTED };
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (res.status === 200 && type === UPLOAD_PACK_ADVERTISEMENT)
    return { ok: true, result: 'ok', live: true };
  return { ok: false, status: null, problem: GITLAB_PAT_UNREACHABLE };
}
