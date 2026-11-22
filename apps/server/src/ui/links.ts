/**
 * Where a link opens: a link that leaves Jumpmaster (an absolute http(s) URL) opens in a new tab,
 * so the dashboard keeps its place; an in-app link (`/…`, `?…`, `#…`) stays in this tab. Only adds
 * attributes: the href itself is checked and escaped by the caller, as before.
 */
export function linkTarget(href: string): string {
  return /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

/** The projects list page (issue #615: project pages moved from `/zones`). */
export const PROJECTS_HREF = '/projects';

/**
 * A project's page, or one of its sub-pages (`goals`, `github`, `issues/new`…). The id is
 * URI-encoded, so it is always exactly one path segment.
 */
export const projectHref = (id: string, sub?: string): string =>
  `${PROJECTS_HREF}/${encodeURIComponent(id)}${sub ? `/${sub}` : ''}`;

/** A project's GitHub setup: the GitHub section of its Setup tab (#618). */
export const githubSetupHref = (id: string): string => `${projectHref(id, 'setup')}#github`;
