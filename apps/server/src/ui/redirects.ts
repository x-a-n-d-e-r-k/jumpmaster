import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Pages that moved (#614, #631): every old path answers with a redirect straight to its new one.
 * GET (and Fastify's automatic HEAD) gets 301, POST gets 308. Each redirect is an ordinary route,
 * so the guard (`auth/guard.ts`) runs first, as on every page.
 *
 * `to` builds the target from the matched params, which `redirectTarget` has already passed
 * through `encodeURIComponent`: a param is one path segment, never a new one or a scheme.
 */
export interface Redirect {
  /** A Fastify path pattern. */
  from: string;
  /** The new path from the encoded params. */
  to: (params: Record<string, string>) => string;
}

export const REDIRECTS: readonly Redirect[] = [
  { from: '/zones', to: () => '/projects' },
  { from: '/zones/new', to: () => '/projects/new' },
  { from: '/zones/:id', to: (p) => `/projects/${p.id}` },
  { from: '/zones/:id/flags', to: (p) => `/projects/${p.id}/flags` },
  { from: '/zones/:id/github', to: (p) => `/projects/${p.id}/github` },
  { from: '/zones/:id/goals', to: (p) => `/projects/${p.id}/goals` },
  { from: '/zones/:id/intake', to: (p) => `/projects/${p.id}/intake` },
  { from: '/zones/:id/issues/new', to: (p) => `/projects/${p.id}/issues/new` },
];

/** The redirect's `Location`: the entry's template over the encoded params, plus the raw query. */
export function redirectTarget(
  entry: Redirect,
  params: Record<string, string | undefined>,
  rawUrl: string,
): string {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) encoded[k] = encodeURIComponent(v ?? '');
  const q = rawUrl.indexOf('?');
  return entry.to(encoded) + (q === -1 ? '' : rawUrl.slice(q));
}

export function registerRedirects(app: FastifyInstance): void {
  for (const entry of REDIRECTS) {
    const send = (code: 301 | 308) => async (req: FastifyRequest, reply: FastifyReply) =>
      reply.redirect(
        redirectTarget(entry, (req.params ?? {}) as Record<string, string>, req.url),
        code,
      );
    // HEAD comes from Fastify's automatic HEAD route for the GET.
    app.get(entry.from, send(301));
    const post = send(308);
    // Answered before the body is parsed, so any content type gets the 308.
    app.post(entry.from, { onRequest: post }, post);
  }
}
