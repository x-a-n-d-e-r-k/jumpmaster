import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { originAllowed, tokenMatches } from '../api/control.js';
import { allowedHostsOf, type Config } from '../config.js';
import type { Db } from '../db/open.js';
import { setupActive } from './operator.js';
import { loadSession, parseCookies, SESSION_COOKIE } from './sessions.js';

/** The one operator, through `ctl`'s machine token or a browser session. */
export type Principal = {
  kind: 'operator';
  via: 'token' | 'session';
  /** The SHA-256 of the session id (never the id itself). */
  sessionId?: string;
  sudo: boolean;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard on control routes and pages; null elsewhere. */
    principal: Principal | null;
  }
}

export interface GuardDeps {
  db: Db;
  config: Config;
  now(): Date;
}

/** The CSRF token of each session principal, kept off the principal itself. */
const csrfOf = new WeakMap<Principal, string>();

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * How a route is guarded: stick routes and `/mcp` authenticate themselves; `auth` routes (login,
 * logout, setup) need no principal; `control` routes need one; everything else is a page.
 */
export type RouteClass = 'stick' | 'mcp' | 'auth' | 'control' | 'page';

export function routeClass(path: string): RouteClass {
  if (path.startsWith('/api/sticks/') || path.startsWith('/api/drops/')) return 'stick';
  if (path === '/mcp') return 'mcp';
  if (path.startsWith('/api/')) return 'control';
  if (path === '/login' || path === '/logout' || path === '/setup' || path.startsWith('/setup/'))
    return 'auth';
  return 'page';
}

/**
 * The operator behind a request: a matching Bearer token (always sudo), or else a live session
 * cookie. A request that presents a Bearer header is judged on it alone.
 */
export function authenticate(req: FastifyRequest, deps: GuardDeps): Principal | null {
  if (req.headers.authorization !== undefined) {
    return tokenMatches(req, deps.config.secrets.operatorToken)
      ? { kind: 'operator', via: 'token', sudo: true }
      : null;
  }
  const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!id) return null;
  const now = deps.now();
  const s = loadSession(deps.db, id, now);
  if (!s) return null;
  const p: Principal = {
    kind: 'operator',
    via: 'session',
    sessionId: s.idHash,
    sudo: s.sudoUntil !== null && Date.parse(s.sudoUntil) > now.getTime(),
  };
  csrfOf.set(p, s.csrf);
  return p;
}

/** A session's non-GET must carry `x-jm-csrf` equal to the session's token; the token needs none. */
export function requireCsrf(req: FastifyRequest, principal: Principal): boolean {
  if (principal.via === 'token' || SAFE_METHODS.has(req.method)) return true;
  const want = csrfOf.get(principal);
  const given = req.headers['x-jm-csrf'];
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A page's HTML with its session's CSRF token in the `jm-csrf` meta `page()` leaves empty. */
export function withCsrf(req: FastifyRequest, html: string): string {
  const csrf = req.principal ? csrfOf.get(req.principal) : undefined;
  if (!csrf) return html;
  return html.replace(
    '<meta name="jm-csrf" content="">',
    `<meta name="jm-csrf" content="${csrf}">`,
  );
}

function refuse(reply: FastifyReply, cls: RouteClass, status: number, error: string) {
  return cls === 'control'
    ? reply.code(status).send({ error })
    : reply.code(status).type('text/plain').send(error);
}

/**
 * The one place that decides who may reach what. In order: the Host check (DNS rebinding) on
 * everything but stick routes; the Origin check on every non-GET but `/mcp` (which keeps its own);
 * then the route class: control routes need the token or a session (with CSRF on a non-GET), pages
 * need a session (or go to `/setup` while setup is open, else `/login`), auth routes need neither.
 * A request refused here never reaches a handler, so it charges no backoff.
 */
export function registerGuard(app: FastifyInstance, deps: GuardDeps): void {
  const allowed = allowedHostsOf(deps.config);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    // The matched pattern where there is one, so the class follows the route that will run.
    const cls = routeClass(req.routeOptions.url ?? path);
    if (cls === 'stick') return;
    if (!allowed.includes(req.headers.host ?? '')) {
      return refuse(
        reply,
        cls,
        403,
        cls === 'control' ? 'forbidden host or origin' : 'forbidden host',
      );
    }
    if (cls === 'mcp') return;
    // Login, setup and logged-in pages (which carry the CSRF meta) are never cached.
    if (cls === 'auth' || cls === 'page') reply.header('cache-control', 'no-store');
    if (!SAFE_METHODS.has(req.method) && !originAllowed(req.headers.origin, allowed)) {
      return refuse(
        reply,
        cls,
        403,
        cls === 'control' ? 'forbidden host or origin' : 'forbidden origin',
      );
    }
    if (cls === 'auth') return;
    if (cls === 'control') {
      const principal = authenticate(req, deps);
      if (!principal) return reply.code(401).send({ error: 'unauthorized' });
      if (!requireCsrf(req, principal)) {
        return reply.code(403).send({ error: 'missing or wrong x-jm-csrf header' });
      }
      req.principal = principal;
      return;
    }
    // A page: a browser session only (a page never takes the token).
    const principal = req.headers.cookie ? authenticate(withoutBearer(req), deps) : null;
    if (principal?.via === 'session') {
      req.principal = principal;
      return;
    }
    if (setupActive(deps.db)) return reply.redirect('/setup', 302);
    if (SAFE_METHODS.has(req.method)) {
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`, 302);
    }
    return reply.code(401).type('text/plain').send('log in first');
  });
}

/** The request as a page sees it: the session cookie decides, whatever Bearer header came along. */
function withoutBearer(req: FastifyRequest): FastifyRequest {
  if (req.headers.authorization === undefined) return req;
  const { authorization: _, ...headers } = req.headers;
  return { method: req.method, headers } as unknown as FastifyRequest;
}
