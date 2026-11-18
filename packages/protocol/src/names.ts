import { containsSecret } from './redact.js';

/**
 * GitHub owner and repository names: one rule for the zone config, the drop payload, the push
 * grant, the forge and the app broker, since each of these strings ends up in a URL or a git remote.
 */

/** A GitHub user or organisation login: letters, digits and single inner hyphens, at most 39 characters. */
const OWNER_NAME = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
/** A GitHub repository name: letters, digits, `.`, `_` and `-`, at most 100 characters. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function isOwnerName(owner: string): boolean {
  return typeof owner === 'string' && OWNER_NAME.test(owner) && owner.length <= 39;
}

// A token's characters are all legal in a repository name, so token shapes are refused by shape.
export function isRepoName(repo: string): boolean {
  return (
    typeof repo === 'string' &&
    REPO_NAME.test(repo) &&
    repo !== '.' &&
    repo !== '..' &&
    !containsSecret(repo, [])
  );
}

/** `owner/name`, split, when each half passes its rule; otherwise null. */
export function splitRepoFullName(full: string): { owner: string; name: string } | null {
  if (typeof full !== 'string') return null;
  const parts = full.split('/');
  if (parts.length !== 2) return null;
  const [owner = '', name = ''] = parts;
  return isOwnerName(owner) && isRepoName(name) ? { owner, name } : null;
}

/** Whether `full` is `owner/name` with a valid GitHub owner and repository name. */
export function isRepoFullName(full: string): boolean {
  return splitRepoFullName(full) !== null;
}
