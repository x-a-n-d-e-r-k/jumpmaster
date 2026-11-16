/**
 * Where a link opens: a link that leaves Jumpmaster (an absolute http(s) URL) opens in a new tab,
 * so the dashboard keeps its place; an in-app link (`/…`, `?…`, `#…`) stays in this tab. Only adds
 * attributes: the href itself is checked and escaped by the caller, as before.
 */
export function linkTarget(href: string): string {
  return /^https?:\/\//i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
}
