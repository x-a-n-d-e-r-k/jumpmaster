// Redeeming a GitHub App manifest code (spec docs/superpowers/specs/2026-11-13-github-app-auth.md
// §4.1, bullets Callback and Conversion response, and §13 Task 8). GitHub redirects the browser back
// with a one-time `code`; `POST /app-manifests/{code}/conversions` spends it (spike F2,
// docs/spikes/2026-11-14-github-app.md: a second conversion returns 404) and answers with the new
// app's id, slug, client id, private key, client secret and webhook secret.
//
// The secrets are registered with the server scrub set as soon as the body parses, before any check
// that can throw, so no later error path can log them. The client and webhook secrets are dropped:
// Jumpmaster neither signs users in with the app nor receives webhooks. No error this module throws
// carries the code, the PEM or either secret, and it never retries: a code is single-use.
import { isOwnerName } from '@jumpmaster/protocol';
import { APP_MANIFEST_PERMISSIONS, type ManifestPermissions } from '../github/app-manifest.js';
import { APP_ROLES, type AppRole, isPrivateKeyPem } from '../vault/github-app-entries.js';
import { type ScrubSet, serverScrubSet } from './scrub-set.js';

/** A manifest code as GitHub issues it: a short URL-safe token. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;

/** Permissions no Jumpmaster app may hold, whatever the expected set says. */
const FORBIDDEN = ['administration', 'workflows'] as const;

/** A slug is echoed only when it has a slug's shape (it is not secret, but it is GitHub's text). */
const SLUG_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * A failed redemption. `status` is GitHub's HTTP status (0 for a network failure or a refusal made
 * before any request); `check` names the check that failed on a response that came back.
 */
export class ManifestConversionError extends Error {
  readonly status: number;
  readonly check: string | undefined;
  constructor(message: string, status: number, check?: string) {
    super(message);
    this.name = 'ManifestConversionError';
    this.status = status;
    this.check = check;
  }
}

export type RedeemedApp = {
  appId: number;
  slug: string;
  clientId: string;
  pem: string;
  owner: string;
  role: AppRole;
};

export interface RedeemOptions {
  /** GitHub's API base; `https://api.github.com` by default. */
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  /** Where the secrets are registered for the log scrub; `serverScrubSet` by default. */
  scrub?: Pick<ScrubSet, 'add' | 'addPem'>;
  /** The permissions the app must hold exactly; `APP_MANIFEST_PERMISSIONS[role]` by default. */
  expectedPermissions?: Readonly<ManifestPermissions>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why `permissions` differs from `expected`, naming keys and levels only; undefined when equal. */
function permissionProblem(
  permissions: unknown,
  expected: Readonly<ManifestPermissions>,
): string | undefined {
  if (!isObject(permissions)) return 'the permissions are missing';
  for (const k of FORBIDDEN)
    if (Object.hasOwn(permissions, k)) return `the app holds the forbidden permission ${k}`;
  const keyName = (k: string) => (/^[a-z_]{1,40}$/.test(k) ? k : 'an unexpected key');
  for (const k of Object.keys(permissions))
    if (!Object.hasOwn(expected, k)) return `the app holds the unexpected permission ${keyName(k)}`;
  for (const [k, level] of Object.entries(expected)) {
    if (!Object.hasOwn(permissions, k)) return `the app lacks the permission ${k}`;
    if (permissions[k] !== level) return `the app's ${k} permission is not ${level}`;
  }
  return undefined;
}

/**
 * Spends `code` on GitHub and returns the new app, after checking it belongs to `owner` and holds
 * exactly the permissions the `role`'s manifest asked for. Any failed check rejects with an error
 * telling the operator to delete the app by its slug on GitHub.
 */
export async function redeemManifestCode(
  code: string,
  { owner, role }: { owner: string; role: AppRole },
  opts: RedeemOptions = {},
): Promise<RedeemedApp> {
  // Refused before any request, never echoing the value.
  if (typeof code !== 'string' || !CODE_SHAPE.test(code))
    throw new ManifestConversionError('the manifest code is not a valid code', 0);
  if (typeof owner !== 'string' || !isOwnerName(owner))
    throw new ManifestConversionError('the owner is not a valid GitHub owner name', 0);
  if (!(APP_ROLES as readonly string[]).includes(role))
    throw new ManifestConversionError('the role is not author or reviewer', 0);

  const apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const scrub = opts.scrub ?? serverScrubSet;
  const expected = opts.expectedPermissions ?? APP_MANIFEST_PERMISSIONS[role];

  let res: Response;
  let text: string;
  try {
    res = await doFetch(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    });
    text = await res.text();
  } catch {
    // The failure's own message may hold the URL, and so the code: report only its kind.
    throw new ManifestConversionError('converting the app manifest failed: network error', 0);
  }

  if (res.status === 404)
    throw new ManifestConversionError(
      'this code was already used or has expired; create the app again',
      404,
    );
  if (res.status < 200 || res.status > 299)
    throw new ManifestConversionError(
      `converting the app manifest failed: HTTP ${res.status}`,
      res.status,
    );

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ManifestConversionError(
      "GitHub's conversion response is not JSON; delete the app on GitHub and create it again",
      res.status,
      'body',
    );
  }

  // Secrets first: registered before any check below can throw.
  if (isObject(body)) {
    for (const k of ['client_secret', 'webhook_secret'] as const) {
      const v = body[k];
      if (typeof v === 'string') scrub.add(v);
    }
    if (typeof body.pem === 'string') scrub.addPem(body.pem);
  }

  const slug = isObject(body) && typeof body.slug === 'string' ? body.slug : '';
  const named = SLUG_SHAPE.test(slug) ? `the app ${slug}` : 'the app';
  const reject = (check: string, problem: string): ManifestConversionError =>
    new ManifestConversionError(
      `the new GitHub App failed the ${check} check (${problem}); delete ${named} on GitHub and create it again`,
      res.status,
      check,
    );

  if (!isObject(body)) throw reject('body', 'the response is not a JSON object');
  const { id, client_id: clientId, pem } = body;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw reject('id', 'id is not a positive integer');
  if (slug === '') throw reject('slug', 'slug is not a non-empty string');
  if (typeof clientId !== 'string' || clientId === '')
    throw reject('client_id', 'client_id is not a non-empty string');
  if (typeof pem !== 'string' || !isPrivateKeyPem(pem))
    throw reject('pem', 'pem is not a PEM private key');

  const login = isObject(body.owner) ? body.owner.login : undefined;
  if (typeof login !== 'string' || login.toLowerCase() !== owner.toLowerCase())
    throw reject('owner', `the app is not owned by ${owner}`);

  const problem = permissionProblem(body.permissions, expected);
  if (problem) throw reject('permissions', problem);

  return { appId: id, slug, clientId, pem, owner, role };
}
