/**
 * The forge a zone lives on (spec §5.5, issue #667). A zone without `forge` is a GitHub zone, as
 * every zone was before GitLab: nothing fills the key in, so a stored document stays as it was.
 */
export const FORGE_KINDS = ['github', 'gitlab'] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** The zone's effective forge: `github` unless it says `gitlab`. */
export function forgeKind(zone: { forge?: ForgeKind | undefined }): ForgeKind {
  return zone.forge === 'gitlab' ? 'gitlab' : 'github';
}

/**
 * Said, unchanged, wherever a GitLab zone is refused until `GitLabForge` lands. Never the base URL
 * or the project path.
 */
export const GITLAB_UNSUPPORTED = 'GitLab zones are not supported yet';

/**
 * Whether `s` is an `https://` origin, with at most a trailing slash: no credentials, path, query
 * or fragment.
 */
export function isHttpsOrigin(s: string): boolean {
  if (typeof s !== 'string' || !/^https:\/\//i.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return false;
  const bare = s.endsWith('/') ? s.slice(0, -1) : s;
  return bare.toLowerCase() === u.origin.toLowerCase();
}
