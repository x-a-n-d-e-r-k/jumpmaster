import { isOwnerName } from '@jumpmaster/protocol';
import type { AppRole } from '../vault/github-app-entries.js';
import { FORBIDDEN, PAT_PERMISSIONS } from './guidance.js';

/**
 * GitHub App manifests (spec 2026-11-13-github-app-auth §4.1): the JSON the wizard's
 * **Create the author app** and **Create the reviewer app** forms POST to GitHub's registration
 * URL for the chosen owner. Pure: no route, no network call.
 *
 * `hook_attributes` is left out (Jumpmaster polls; spike F5b found GitHub accepts that). Neither
 * manifest ever asks `administration` or `workflows`, checked on the object about to be emitted,
 * as `patTemplateUrl` refuses them in a token template.
 */

const GITHUB = 'https://github.com';

export type ManifestPermissions = Record<string, 'read' | 'write'>;

/**
 * What each app asks at registration. The author's is the author PAT's plus `checks: read`; the
 * reviewer asks `contents: write` because an app's approval counts only with it (spike F12).
 * Every reviewer token is still narrowed when minted (`USE_PERMISSIONS` in forge/github-app.ts).
 */
export const APP_MANIFEST_PERMISSIONS: Record<AppRole, ManifestPermissions> = {
  author: { ...PAT_PERMISSIONS.author, checks: 'read' },
  reviewer: { pull_requests: 'write', contents: 'write', metadata: 'read' },
};

const DESCRIPTIONS: Record<AppRole, string> = {
  author:
    'Pushes agent branches and opens, labels and merges pull requests for one Jumpmaster install.',
  reviewer: 'Reviews and approves or requests changes on pull requests for one Jumpmaster install.',
};

/** GitHub's limit on an app's name. */
export const APP_NAME_MAX = 34;
const INSTALL_ID = /^[a-z0-9]{4,12}$/;

export type AppManifest = {
  name: string;
  url: string;
  description: string;
  redirect_url: string;
  setup_url: string;
  setup_on_update: true;
  public: false;
  default_events: string[];
  default_permissions: ManifestPermissions;
};

/** The base URL as an origin with no trailing slash; throws (never echoing it) otherwise. */
function origin(baseUrl: string): string {
  const refuse = () => new Error('the base URL is not an absolute http: or https: origin');
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw refuse();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw refuse();
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    throw refuse();
  return u.origin;
}

/** The §4.1 manifest for `role`. `permissions` is the table to read; tests inject one. */
export function appManifest(
  role: AppRole,
  opts: { baseUrl: string; installId: string; projectUrl: string },
  permissions: Record<AppRole, ManifestPermissions> = APP_MANIFEST_PERMISSIONS,
): AppManifest {
  const base = origin(opts.baseUrl);
  if (typeof opts.installId !== 'string' || !INSTALL_ID.test(opts.installId))
    throw new Error('the install id is 4 to 12 lowercase letters or digits');
  const name = `Jumpmaster ${role} (${opts.installId})`;
  if (name.length > APP_NAME_MAX)
    throw new Error(`an app name is at most ${APP_NAME_MAX} characters`);
  const manifest: AppManifest = {
    name,
    url: opts.projectUrl,
    description: DESCRIPTIONS[role],
    redirect_url: `${base}/setup/github-app/callback`,
    setup_url: `${base}/setup/github-app/installed`,
    setup_on_update: true,
    public: false,
    default_events: [],
    default_permissions: { ...permissions[role] },
  };
  for (const permission of Object.keys(manifest.default_permissions))
    if (FORBIDDEN.has(permission)) throw new Error(`a manifest never asks for ${permission}`);
  return manifest;
}

/** GitHub's app-registration page for the owner: the personal one or the organization's. */
export function appRegistrationUrl(
  owner: string,
  ownerType: 'User' | 'Organization',
  state: string,
): string {
  if (typeof owner !== 'string' || !isOwnerName(owner))
    throw new Error('the owner is not a GitHub account name');
  const q = new URLSearchParams({ state });
  const path =
    ownerType === 'Organization'
      ? `/organizations/${owner}/settings/apps/new`
      : '/settings/apps/new';
  return `${GITHUB}${path}?${q.toString()}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when the base URL is neither HTTPS nor loopback: the wizard warns (§4.1 Plain HTTP). */
export function isPlainHttpBase(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return true;
  }
  if (u.protocol === 'https:') return false;
  return !LOOPBACK.has(u.hostname);
}
