import { ZONE_ID } from '../config.js';
import { GitLabForge, GitLabForgeError } from '../forge/gitlab.js';
import { type ForgeKind, forgeKind } from '../forge/kind.js';
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

/** `gitlab-pat/<zoneId>/<role>`; throws (never echoing the input) on a bad zone id or role. */
export function gitlabPatEntryName(zoneId: string, role: GitLabPatRole): string {
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
 * `gitlab-pat/<zoneId>/<role>=<fingerprint>` for each present value, sorted; no secret. What
 * `credentialFingerprint` adds for the resolved GitLab entries.
 */
export function gitlabPatEntryFingerprints(
  entries: Readonly<Record<string, { author?: string; reviewer?: string }>>,
): string[] {
  const lines: string[] = [];
  for (const [zoneId, roles] of Object.entries(entries))
    for (const role of GITLAB_PAT_ROLES) {
      const v = roles[role];
      if (v !== undefined) lines.push(`${gitlabPatEntryName(zoneId, role)}=${fingerprintOf(v)}`);
    }
  return lines.sort();
}
