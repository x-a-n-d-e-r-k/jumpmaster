// GitLab project access tokens (spec docs/superpowers/specs/2026-11-13-github-app-auth.md, §9 and
// §13 item 12). With one short-lived bootstrap personal access token (`api` scope, from a
// Maintainer or Owner) the server mints a zone's author and reviewer project access tokens, each
// carrying `self_rotate`, and each later rotates itself before it expires.
//
// Standalone and unwired: no vault entry is read, nothing is stored. Every token passed in or
// received is added to the server scrub set before a function returns or throws, and no error
// carries token text: only GitLab's HTTP status and numeric ids are named.
import { stripTrailingSlashes } from '@jumpmaster/protocol';
import { serverScrubSet } from './scrub-set.js';

export type GitLabRole = 'author' | 'reviewer';

/** GitLab access levels: Developer 30, Maintainer 40. Owner (50) is never requested. */
export const MAX_ACCESS_LEVEL = 40;

/**
 * Both roles are Developer with `api` and `self_rotate`. The reviewer gets the same as the author so
 * an operator grants and reasons about one level: Developer can comment on and approve merge
 * requests, and nothing a reviewer does needs Maintainer.
 */
export const ROLE_DEFAULTS: Readonly<
  Record<GitLabRole, { name: string; accessLevel: number; scopes: readonly string[] }>
> = {
  author: { name: 'jumpmaster-author', accessLevel: 30, scopes: ['api', 'self_rotate'] },
  reviewer: { name: 'jumpmaster-reviewer', accessLevel: 30, scopes: ['api', 'self_rotate'] },
};

const FORBIDDEN_SCOPES = ['sudo', 'admin_mode'];
const DEFAULT_LIFETIME_DAYS = 30;
const MAX_LIFETIME_DAYS = 365;
const ROTATE_WITHIN_DAYS = 7;
const DAY_MS = 86_400_000;

export interface GitLabCallOptions {
  fetch?: typeof fetch;
  /** The clock in milliseconds. */
  now?: () => number;
}

export interface MintOptions extends GitLabCallOptions {
  accessLevel?: number;
  scopes?: readonly string[];
  /** A Date, or a GitLab date (YYYY-MM-DD). Capped at 365 days from now. */
  expiresAt?: Date | string;
}

export interface MintedProjectToken {
  id: number;
  token: string;
  expiresAt: string;
  scopes: string[];
  accessLevel: number;
  botUserId: number;
}

/** Any failure of this module. Its message names only an HTTP status and numeric ids. */
export class GitLabTokenError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GitLabTokenError';
    this.status = status;
  }
}

/** GitLab answered 401 or 403: the token is wrong, expired, or lacks the rights. */
export class GitLabAuthError extends GitLabTokenError {
  constructor(what: string, status: number) {
    super(`${what} failed: HTTP ${status} (not authorized)`, status);
    this.name = 'GitLabAuthError';
  }
}

/** GitLab answered 404: no such project, or the token cannot see it. */
export class GitLabNotFoundError extends GitLabTokenError {
  constructor(what: string) {
    super(`${what} failed: HTTP 404 (not found)`, 404);
    this.name = 'GitLabNotFoundError';
  }
}

/** A mint request refused here, before anything was sent. */
export class GitLabTokenRequestError extends GitLabTokenError {
  constructor(message: string) {
    super(message, 0);
    this.name = 'GitLabTokenRequestError';
  }
}

/** A minted token refused on its response; `tokenId` names it so the caller can revoke it. */
export class GitLabTokenRefusedError extends GitLabTokenError {
  readonly tokenId: number;
  constructor(tokenId: number, reason: string) {
    super(`minted project access token ${tokenId} refused: ${reason}; revoke it`, 0);
    this.name = 'GitLabTokenRefusedError';
    this.tokenId = tokenId;
  }
}

const apiBase = (baseUrl: string) => `${stripTrailingSlashes(baseUrl)}/api/v4`;

const scrubAdd = (token: unknown) => {
  if (typeof token === 'string' && token !== '') serverScrubSet.add(token);
};

/** YYYY-MM-DD, in UTC. */
const gitlabDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A GitLab date (YYYY-MM-DD) is read as midnight UTC; anything else as Date parses it. */
function toMs(v: Date | string | number): number {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
}

function cappedExpiry(requested: Date | string | undefined, nowMs: number): string {
  const max = nowMs + MAX_LIFETIME_DAYS * DAY_MS;
  if (requested === undefined) return gitlabDate(nowMs + DEFAULT_LIFETIME_DAYS * DAY_MS);
  const ms = toMs(requested);
  if (Number.isNaN(ms)) throw new GitLabTokenRequestError('expiresAt is not a date');
  return gitlabDate(Math.min(ms, max));
}

async function call(
  f: typeof fetch,
  what: string,
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { 'PRIVATE-TOKEN': token, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // PRIVATE-TOKEN is a custom header, so fetch would forward it across a cross-origin
      // redirect. The token goes only to the base URL's host: a redirect is never followed.
      redirect: 'manual',
    });
  } catch {
    // The cause may echo the request; it is not reported.
    throw new GitLabTokenError(`${what} failed: network error`);
  }
  const text = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403) throw new GitLabAuthError(what, res.status);
  if (res.status === 404) throw new GitLabNotFoundError(what);
  // An opaque redirect (status 0, browsers) or a 3xx; its Location is never reported.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))
    throw new GitLabTokenError(
      `${what} failed: HTTP ${res.status} (redirect not followed)`,
      res.status,
    );
  if (res.status < 200 || res.status >= 300)
    throw new GitLabTokenError(`${what} failed: HTTP ${res.status}`, res.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitLabTokenError(`${what} failed: response is not JSON`, res.status);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The numeric id of a project given as `group/project` (or a numeric id). */
export async function resolveProjectId(
  baseUrl: string,
  bootstrapToken: string,
  pathOrId: string | number,
  opts: GitLabCallOptions = {},
): Promise<number> {
  scrubAdd(bootstrapToken);
  const ref = encodeURIComponent(String(pathOrId));
  const j = await call(
    opts.fetch ?? fetch,
    'resolving the GitLab project',
    'GET',
    `${apiBase(baseUrl)}/projects/${ref}`,
    bootstrapToken,
  );
  const id = isRecord(j) ? j.id : undefined;
  if (typeof id !== 'number' || !Number.isInteger(id))
    throw new GitLabTokenError('resolving the GitLab project failed: response has no id');
  return id;
}

/** Mints the role's project access token with the bootstrap token, checking what comes back. */
export async function mintProjectToken(
  baseUrl: string,
  bootstrapToken: string,
  projectId: number,
  role: GitLabRole,
  opts: MintOptions = {},
): Promise<MintedProjectToken> {
  scrubAdd(bootstrapToken);
  if (!Object.hasOwn(ROLE_DEFAULTS, role))
    throw new GitLabTokenRequestError('unknown project token role');
  if (!Number.isInteger(projectId) || projectId <= 0)
    throw new GitLabTokenRequestError('project id must be a positive integer');
  const defaults = ROLE_DEFAULTS[role];
  const accessLevel = opts.accessLevel ?? defaults.accessLevel;
  const scopes = [...(opts.scopes ?? defaults.scopes)];
  if (!Number.isInteger(accessLevel) || accessLevel > MAX_ACCESS_LEVEL)
    throw new GitLabTokenRequestError(
      `access level ${accessLevel} is above Maintainer (${MAX_ACCESS_LEVEL})`,
    );
  if (!scopes.includes('self_rotate'))
    throw new GitLabTokenRequestError('scopes must include self_rotate');
  for (const s of FORBIDDEN_SCOPES)
    if (scopes.includes(s)) throw new GitLabTokenRequestError(`scope ${s} may not be requested`);
  const nowMs = (opts.now ?? Date.now)();
  const body = {
    name: defaults.name,
    scopes,
    access_level: accessLevel,
    expires_at: cappedExpiry(opts.expiresAt, nowMs),
  };

  const what = `minting the ${role} token on project ${projectId}`;
  const j = await call(
    opts.fetch ?? fetch,
    what,
    'POST',
    `${apiBase(baseUrl)}/projects/${projectId}/access_tokens`,
    bootstrapToken,
    body,
  );
  if (!isRecord(j)) throw new GitLabTokenError(`${what} failed: response is not an object`);
  scrubAdd(j.token);
  const id = typeof j.id === 'number' ? j.id : NaN;
  const gotScopes = Array.isArray(j.scopes) ? j.scopes.filter((s) => typeof s === 'string') : [];
  if (typeof j.token !== 'string' || j.token === '' || !Number.isInteger(id))
    throw new GitLabTokenError(`${what} failed: response has no token or id`);
  if (!gotScopes.includes('self_rotate'))
    throw new GitLabTokenRefusedError(id, 'its scopes lack self_rotate');
  if (j.access_level !== accessLevel)
    throw new GitLabTokenRefusedError(id, `its access level is not ${accessLevel}`);
  if (typeof j.expires_at !== 'string' || typeof j.user_id !== 'number')
    throw new GitLabTokenRefusedError(id, 'the response lacks expires_at or user_id');
  return {
    id,
    token: j.token,
    expiresAt: j.expires_at,
    scopes: gotScopes,
    accessLevel,
    botUserId: j.user_id,
  };
}

/** Rotates a project access token with itself; the old token stops working. */
export async function rotateSelf(
  baseUrl: string,
  projectToken: string,
  projectId: number,
  expiresAt?: Date | string,
  opts: GitLabCallOptions = {},
): Promise<{ token: string; expiresAt: string }> {
  scrubAdd(projectToken);
  if (!Number.isInteger(projectId) || projectId <= 0)
    throw new GitLabTokenRequestError('project id must be a positive integer');
  const body =
    expiresAt === undefined
      ? {}
      : { expires_at: cappedExpiry(expiresAt, (opts.now ?? Date.now)()) };
  const what = `rotating the project token on project ${projectId}`;
  const j = await call(
    opts.fetch ?? fetch,
    what,
    'POST',
    `${apiBase(baseUrl)}/projects/${projectId}/access_tokens/self/rotate`,
    projectToken,
    body,
  );
  if (!isRecord(j)) throw new GitLabTokenError(`${what} failed: response is not an object`);
  scrubAdd(j.token);
  if (typeof j.token !== 'string' || j.token === '' || typeof j.expires_at !== 'string')
    throw new GitLabTokenError(`${what} failed: response has no token or expiry`);
  return { token: j.token, expiresAt: j.expires_at };
}

/** True when strictly fewer than 7 days remain before `expiresAt`, or it has passed. */
export function needsRotation(expiresAt: Date | string, now: Date | number): boolean {
  const exp = toMs(expiresAt);
  if (Number.isNaN(exp)) return true;
  return exp - toMs(now) < ROTATE_WITHIN_DAYS * DAY_MS;
}
