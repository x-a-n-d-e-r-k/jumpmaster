import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACTIVITY_DROPS_HREF,
  ACTIVITY_LOG_HREF,
  ACTIVITY_WORK_HREF,
  PROJECTS_HREF,
  projectHref,
  SYSTEM_ADVANCED_HREF,
  SYSTEM_CREDENTIALS_HREF,
  SYSTEM_HISTORY_HREF,
  SYSTEM_HREF,
  SYSTEM_MCP_TOKENS_HREF,
  SYSTEM_SERVER_HREF,
  SYSTEM_STICKS_ADD_HREF,
  SYSTEM_STICKS_HREF,
} from './links.js';

/**
 * The pages that moved, and where each one went (issue #615 and the rest of epic #614). Every
 * moved page answers its old path here, one hop straight to the final path: 301 for GET and HEAD,
 * 308 for POST, the query string kept.
 *
 * `to` builds the target only from this table's template and the matched params, each param
 * URI-encoded (`projectHref` does it), so a param is always exactly one path segment: an encoded
 * slash, a dot segment, a scheme or a backslash can't send the browser off-site.
 */
export type Redirect = {
  /** A fastify path pattern: the old path. */
  from: string;
  /**
   * A query parameter that marks the old page: the request is redirected only when it carries the
   * parameter, non-empty. Its (first) value becomes the `id` param and it leaves the kept query.
   * Such an entry does not own the path: the page at `from` without the parameter stays.
   */
  query?: string;
  /** The new path, without the query (`registerRedirects` keeps the request's). */
  to: (params: Record<string, string>, query: string) => string;
};

/** The request's own query string, `?…` included, or `''`. */
const keep = (query: string): string => (query ? `?${query}` : '');

/** A fixed page, the query kept, then `#hash` if given (it comes last). */
const to =
  (path: string, hash?: string) =>
  (_p: Record<string, string>, q: string): string =>
    `${path}${keep(q)}${hash ? `#${hash}` : ''}`;

/** A project's page or sub-page, the query kept, then `#hash` if given (it comes last). */
const project =
  (sub?: string, hash?: string) =>
  (p: Record<string, string>, q: string): string =>
    `${projectHref(p.id ?? '', sub)}${keep(q)}${hash ? `#${hash}` : ''}`;

export const REDIRECTS: readonly Redirect[] = [
  { from: '/zones', to: (_p, q) => `${PROJECTS_HREF}${keep(q)}` },
  { from: '/zones/new', to: (_p, q) => `${PROJECTS_HREF}/new${keep(q)}` },
  { from: '/zones/:id', to: project() },
  { from: '/zones/:id/flags', to: project('flags') },
  // The GitHub guide is a section of Setup (#618).
  { from: '/zones/:id/github', to: project('setup', 'github') },
  { from: `${PROJECTS_HREF}/:id/github`, to: project('setup', 'github') },
  { from: '/zones/:id/goals', to: project('goals') },
  // The GOAL.md stub builder is a section of Goals (#620).
  { from: '/zones/:id/intake', to: project('goals', 'goal-stub') },
  { from: `${PROJECTS_HREF}/:id/intake`, to: project('goals', 'goal-stub') },
  { from: '/zones/:id/issues/new', to: project('issues/new') },
  // A project's work and its items (#619). A query entry is checked before any route, so
  // `/work?zone=` goes to the project's tab and only the zone-less list goes to Activity (#622).
  { from: '/work', query: 'zone', to: project('work') },
  { from: '/work', to: (_p, q) => `${ACTIVITY_WORK_HREF}${keep(q)}` },
  // The drop list is Activity's (#622); a drop's own page (`/drops/:id`) does not move.
  { from: '/drops', to: (_p, q) => `${ACTIVITY_DROPS_HREF}${keep(q)}` },
  {
    from: '/work/:zone/:issue',
    to: (p, q) =>
      `${projectHref(p.zone ?? '', `work/${encodeURIComponent(p.issue ?? '')}`)}${keep(q)}`,
  },
  // The observations list is the Log (#621): a project's tab, or the install-wide log.
  { from: '/observations', query: 'zone', to: project('log') },
  { from: '/observations', to: (_p, q) => `${ACTIVITY_LOG_HREF}${keep(q)}` },
  // The install-wide pages are the System area (#623).
  { from: '/doctor', to: to(SYSTEM_HREF) },
  { from: '/sticks', to: to(SYSTEM_STICKS_HREF) },
  { from: '/sticks/add', to: to(SYSTEM_STICKS_ADD_HREF) },
  { from: '/settings', to: to(SYSTEM_CREDENTIALS_HREF) },
  { from: '/settings/credentials', to: to(SYSTEM_CREDENTIALS_HREF) },
  { from: '/settings/install', to: to(SYSTEM_SERVER_HREF) },
  // Other machines is the second section of Server.
  { from: '/settings/other-machines', to: to(SYSTEM_SERVER_HREF, 'other-machines') },
  { from: '/settings/mcp-tokens', to: to(SYSTEM_MCP_TOKENS_HREF) },
  { from: '/settings/history', to: to(SYSTEM_HISTORY_HREF) },
  { from: '/settings/flags', to: to(SYSTEM_ADVANCED_HREF) },
  // The briefings list is Home's Needs you (#625), a zone's is its project; `/briefings/:id` stays.
  { from: '/briefings', query: 'zone', to: project() },
  { from: '/briefings', to: to('/', 'waiting-on-you') },
];

/** The raw query string of a request, without the `?`. */
const queryOf = (url: string): string => {
  const at = url.indexOf('?');
  return at === -1 ? '' : url.slice(at + 1);
};

/** The query string without every `name=…` pair, the other pairs kept byte for byte. */
const without = (query: string, name: string): string =>
  query
    .split('&')
    .filter((pair) => pair !== '' && paramName(pair) !== name)
    .join('&');

/** A query pair's decoded name (`+` is a space), or `''` when it does not decode. */
function paramName(pair: string): string {
  const at = pair.indexOf('=');
  try {
    return decodeURIComponent((at === -1 ? pair : pair.slice(0, at)).replaceAll('+', ' '));
  } catch {
    return '';
  }
}

/**
 * Registers every entry of `table`: GET and HEAD answer 301, POST answers 308. A path entry is a
 * route; a query entry (`query`) is a hook, since the page at its path stays for other requests.
 */
export function registerRedirects(
  app: FastifyInstance,
  table: readonly Redirect[] = REDIRECTS,
): void {
  const byQuery = table.filter((r) => r.query !== undefined);
  if (byQuery.length > 0) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return;
      const at = req.url.indexOf('?');
      if (at === -1) return;
      const path = req.url.slice(0, at);
      const query = req.url.slice(at + 1);
      for (const r of byQuery) {
        const name = r.query ?? '';
        const id = new URLSearchParams(query).get(name);
        if (path !== r.from || !id) continue;
        return reply
          .code(req.method === 'POST' ? 308 : 301)
          .header('location', r.to({ id }, without(query, name)))
          .send();
      }
    });
  }
  for (const r of table) {
    if (r.query !== undefined) continue;
    const handler = (code: 301 | 308) => async (req: FastifyRequest, reply: FastifyReply) =>
      reply
        .code(code)
        .header('location', r.to(req.params as Record<string, string>, queryOf(req.url)))
        .send();
    // Fastify answers HEAD from the GET route (exposeHeadRoutes), with the same 301.
    app.get(r.from, handler(301));
    app.post(r.from, handler(308));
  }
}
