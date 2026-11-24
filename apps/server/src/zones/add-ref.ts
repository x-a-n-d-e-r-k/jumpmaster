import { isGitLabProjectPath } from '@jumpmaster/protocol';
import { forgeKind, isHttpsOrigin } from '../forge/kind.js';
import { parseProjectRef } from './project-ref.js';

/**
 * Where a zone added through `POST /api/control/zones` lives (issue #777): read before the GitHub
 * `REPO` check. `github` hands `zone` (with `repo` set) to the GitHub path unchanged; `gitlab`
 * carries the zone as it will be stored; `error` is a 400 issue whose text never echoes the input.
 */
export type ZoneAddRef =
  | { forge: 'github'; zone: Record<string, unknown> }
  | { forge: 'gitlab'; zone: Record<string, unknown>; baseUrl: string; repo: string }
  | { error: { path: string; message: string } };

export const PROJECT_ALONE = 'give project alone: not together with repo, forge or gitlab';
export const GITLAB_REPO = 'a GitLab zone needs repo: a GitLab project path, group/.../project';
export const GITLAB_BASE_URL =
  'a GitLab zone needs gitlab.baseUrl: an https:// origin, with no credentials, path, query or fragment';
export const GITLAB_PRESET_GATES =
  'a GitLab zone needs its stack preset and its gates: give the preset and the gates (detection reads GitHub only for now)';

/**
 * Reads `zone.project` with `parseProjectRef`, or an explicit `forge: 'gitlab'`, into the zone to
 * add. `project` is removed from the zone; a GitHub `project` becomes `repo` and nothing else.
 * Any other zone (`repo` with no `forge: 'gitlab'`) is passed through as it came.
 */
export function readZoneAdd(zone: Record<string, unknown>): ZoneAddRef {
  if ('project' in zone) {
    const { project, ...rest } = zone;
    if ('repo' in rest || 'forge' in rest || 'gitlab' in rest)
      return { error: { path: 'zone.project', message: PROJECT_ALONE } };
    const ref = parseProjectRef(project as string);
    if ('error' in ref) return { error: { path: 'zone.project', message: ref.error } };
    if (ref.forge === 'github') return { forge: 'github', zone: { ...rest, repo: ref.repo } };
    return {
      forge: 'gitlab',
      zone: { ...rest, forge: 'gitlab', gitlab: { baseUrl: ref.baseUrl }, repo: ref.repo },
      baseUrl: ref.baseUrl,
      repo: ref.repo,
    };
  }
  if (zone.forge !== 'gitlab') return { forge: 'github', zone };
  const { repo, gitlab } = zone;
  if (typeof repo !== 'string' || !isGitLabProjectPath(repo))
    return { error: { path: 'zone.repo', message: GITLAB_REPO } };
  const baseUrl = (gitlab as { baseUrl?: unknown } | null | undefined)?.baseUrl;
  if (
    typeof gitlab !== 'object' ||
    gitlab === null ||
    typeof baseUrl !== 'string' ||
    !isHttpsOrigin(baseUrl)
  )
    return { error: { path: 'zone.gitlab.baseUrl', message: GITLAB_BASE_URL } };
  return { forge: 'gitlab', zone, baseUrl, repo };
}

/**
 * A GitLab zone's default id: the project path's last segment, normalized as `zoneIdOf` does
 * (lower case, runs of anything but `a-z0-9-` to `-`, trimmed, at most 63, `main` if empty).
 */
export const gitlabZoneIdOf = (repo: string): string =>
  (repo.split('/').at(-1) ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '') || 'main';

/** The origin of a base URL, lower case; empty for none (a GitHub zone) or an unreadable one. */
function originOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).origin.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

type ZoneWhere = {
  forge?: 'github' | 'gitlab' | undefined;
  gitlab?: { baseUrl: string } | undefined;
  repo: string;
};

/**
 * Whether two zones name the same project: the same forge, the same instance origin (GitHub has
 * none) and the same repository or project path, each compared case-insensitively.
 */
export function sameProject(a: ZoneWhere, b: ZoneWhere): boolean {
  return (
    forgeKind(a) === forgeKind(b) &&
    originOf(a.gitlab?.baseUrl) === originOf(b.gitlab?.baseUrl) &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}
