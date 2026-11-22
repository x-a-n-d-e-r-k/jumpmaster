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

/** The Activity area (#622): its lifecycle board, every project's or one's with `?project=`. */
export const ACTIVITY_HREF = '/activity';

/** The cross-project work list (#622: moved from `/work`). */
export const ACTIVITY_WORK_HREF = `${ACTIVITY_HREF}/work`;

/** The cross-project drop list (#622: moved from `/drops`; a drop's own page stays `/drops/:id`). */
export const ACTIVITY_DROPS_HREF = `${ACTIVITY_HREF}/drops`;

/** The install-wide Log (#621): every project's, or one project's with `?project=`. */
export const ACTIVITY_LOG_HREF = `${ACTIVITY_HREF}/log`;

/** The System area (#623): Health, the doctor's page (moved from `/doctor`). */
export const SYSTEM_HREF = '/system';

/** The sticks page (#623: moved from `/sticks`) and its Add a stick POST. */
export const SYSTEM_STICKS_HREF = `${SYSTEM_HREF}/sticks`;
export const SYSTEM_STICKS_ADD_HREF = `${SYSTEM_STICKS_HREF}/add`;
/** The Sticks area's Images tab (#624). */
export const SYSTEM_STICKS_IMAGES_HREF = `${SYSTEM_STICKS_HREF}/images`;

/** The install's credentials (#623: moved from `/settings/credentials`). */
export const SYSTEM_CREDENTIALS_HREF = `${SYSTEM_HREF}/credentials`;

/** The install settings, then Other machines (#623: from `/settings/install` and `/settings/other-machines`). */
export const SYSTEM_SERVER_HREF = `${SYSTEM_HREF}/server`;

/** Other machines: the second section of Server. */
export const SYSTEM_OTHER_MACHINES_HREF = `${SYSTEM_SERVER_HREF}#other-machines`;

/** Command's MCP tokens (#623: moved from `/settings/mcp-tokens`). */
export const SYSTEM_MCP_TOKENS_HREF = `${SYSTEM_HREF}/mcp-tokens`;

/** The config's revisions (#623: moved from `/settings/history`). */
export const SYSTEM_HISTORY_HREF = `${SYSTEM_HREF}/history`;

/** Every install-wide setting (#623: moved from `/settings/flags`). */
export const SYSTEM_ADVANCED_HREF = `${SYSTEM_HREF}/advanced`;
