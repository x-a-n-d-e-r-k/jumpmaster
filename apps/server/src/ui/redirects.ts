import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PROJECTS_HREF, projectHref } from './links.js';

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
  /** The new path, without the query (`registerRedirects` keeps the request's). */
  to: (params: Record<string, string>, query: string) => string;
};

/** The request's own query string, `?…` included, or `''`. */
const keep = (query: string): string => (query ? `?${query}` : '');

const project =
  (sub?: string) =>
  (p: Record<string, string>, q: string): string =>
    `${projectHref(p.id ?? '', sub)}${keep(q)}`;

export const REDIRECTS: readonly Redirect[] = [
  { from: '/zones', to: (_p, q) => `${PROJECTS_HREF}${keep(q)}` },
  { from: '/zones/new', to: (_p, q) => `${PROJECTS_HREF}/new${keep(q)}` },
  { from: '/zones/:id', to: project() },
  { from: '/zones/:id/flags', to: project('flags') },
  { from: '/zones/:id/github', to: project('github') },
  { from: '/zones/:id/goals', to: project('goals') },
  { from: '/zones/:id/intake', to: project('intake') },
  { from: '/zones/:id/issues/new', to: project('issues/new') },
];

/** The raw query string of a request, without the `?`. */
const queryOf = (url: string): string => {
  const at = url.indexOf('?');
  return at === -1 ? '' : url.slice(at + 1);
};

/** Registers every entry of `table`: GET and HEAD answer 301, POST answers 308. */
export function registerRedirects(
  app: FastifyInstance,
  table: readonly Redirect[] = REDIRECTS,
): void {
  for (const r of table) {
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
