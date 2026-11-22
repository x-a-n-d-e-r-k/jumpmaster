/**
 * Where a link opens: a link that leaves Jumpmaster (an absolute http(s) URL) opens in a new tab,
 * so the dashboard keeps its place; an in-app link (`/…`, `?…`, `#…`) stays in this tab. Only adds
 * attributes: the href itself is checked and escaped by the caller, as before.
 */
export function linkTarget(href: string): string {
  return /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}

/**
 * A project's page, or one of its sub-pages: `projectHref('jm', 'goals')` is `/projects/jm/goals`
 * (#631). The id is one encoded path segment. Pages re-export it (`ui/pages.ts`) with the older
 * name `zoneHref`; modules outside the UI import it from here.
 */
export const projectHref = (id: string, sub?: string): string =>
  `/projects/${encodeURIComponent(id)}${sub ? `/${sub}` : ''}`;
