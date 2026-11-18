import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { originAllowed, tokenMatches } from '../api/control.js';
import { configReader, type LiveConfig } from '../config/source.js';
import { allowedHostsOf, type Config } from '../config.js';
import type { Db } from '../db/open.js';
import { setupActive } from './operator.js';
import { loadSession, parseCookies, SESSION_COOKIE } from './sessions.js';

/**
 * The one operator, through `ctl`'s machine token, a browser session, or a chat turn the owner's
 * message started. A chat principal is treated exactly as a session (guarded changes wait for the
 * browser's confirmation, browser-forbidden paths are refused) and is audited as `chat`.
 */
export type Principal = {
  kind: 'operator';
  via: 'token' | 'session' | 'chat';
  /**
   * The SHA-256 of the session id (never the id itself). For a chat principal, the session that
   * posted the owner's message: a pending change is confirmed by that browser.
   */
  sessionId?: string;
  sudo: boolean;
  /** The chat turn behind a chat principal: its audit rows carry both ids. */
  chat?: { threadId: number; messageId: number };
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard on control routes and pages; null elsewhere. */
    principal: Principal | null;
    /**
     * The config as it was when the guard ran: one snapshot per request, so a handler that awaits
     * never acts on two revisions (or authenticates on one token and audits with another).
     * Null on stick routes, which read their own.
     */
    jmConfig: Config | null;
  }
}

export interface GuardDeps {
  db: Db;
  /** Read per request (the operator token); the allowed hosts are boot settings. */
  config: LiveConfig;
  now(): Date;
}

/** The CSRF token of each session principal, kept off the principal itself. */
const csrfOf = new WeakMap<Principal, string>();

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * How a route is guarded: stick routes, the installer's, `/mcp` and `/mcp/chat` authenticate
 * themselves; `auth` routes (login, logout, setup) need no principal; `control` routes need one;
 * everything else is a page.
 */
export type RouteClass =
  | 'stick'
  | 'install'
  | 'mcp'
  | 'chat-mcp'
  | 'health'
  | 'auth'
  | 'control'
  | 'page';

export function routeClass(path: string): RouteClass {
  if (path.startsWith('/api/sticks/') || path.startsWith('/api/drops/')) return 'stick';
  // The stick installer (issue #138): the script is public and holds no secret; the image and
  // cosign downloads authenticate with the one-time code. Reached at server.publicUrl, any Host.
  if (path.startsWith('/install/')) return 'install';
  if (path === '/mcp') return 'mcp';
  // The chat service's MCP endpoint: reached as `jumpmaster:<port>` on the compose network, so no
  // Host check, and never by a browser, so any Origin is refused.
  if (path === '/mcp/chat') return 'chat-mcp';
  // `{ ok, version }` and nothing else: other machines check the address they reach us at.
  if (path === '/healthz') return 'health';
  if (path.startsWith('/api/')) return 'control';
  // Only the claim itself needs no session; the wizard's steps under /setup/ are pages.
  if (
    path === '/login' ||
    path === '/logout' ||
    path === '/setup' ||
    path === '/setup/code' ||
    path === '/setup/passphrase' ||
    // GitHub's redirect after creating an app comes without the Strict session cookie: the
    // callback only consumes the state and redeems the code; Finish (a page) saves the app.
    path === '/setup/github-app/callback' ||
    // GitHub's setup_url redirect after an install, likewise without the cookie: it only renders
    // a same-origin form to the discovery page, and never reads the query.
    path === '/setup/github-app/installed'
  )
    return 'auth';
  return 'page';
}

/**
 * The operator behind a request: a matching Bearer token (always sudo), or else a live session
 * cookie. A request that presents a Bearer header is judged on it alone.
 */
export function authenticate(
  req: FastifyRequest,
  deps: GuardDeps,
  config: Config = configReader(deps.config)(),
): Principal | null {
  if (req.headers.authorization !== undefined) {
    return tokenMatches(req, config.secrets.operatorToken)
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
 * everything but stick routes and `/mcp/chat` (which refuses any Origin instead); the Origin check on every non-GET but `/mcp` (which keeps its own);
 * then the route class: control routes need the token or a session (with CSRF on a non-GET), pages
 * need a session (or go to `/setup` while setup is open, else `/login`), auth routes need neither.
 * A request refused here never reaches a handler, so it charges no backoff.
 */
export function registerGuard(app: FastifyInstance, deps: GuardDeps): void {
  const allowed = allowedHostsOf(configReader(deps.config)());
  const live = configReader(deps.config);
  app.decorateRequest('principal', null);
  app.decorateRequest('jmConfig', null);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    // The matched pattern where there is one, so the class follows the route that will run.
    const cls = routeClass(req.routeOptions.url ?? path);
    if (cls === 'stick' || cls === 'install' || cls === 'health') return;
    if (cls === 'chat-mcp') {
      // Only the chat service calls it, and it sends no Origin: a browser always does on a POST.
      if (req.headers.origin !== undefined) {
        return reply.code(403).type('text/plain').send('forbidden origin');
      }
      return;
    }
    const config = live();
    req.jmConfig = config;
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
      const principal = authenticate(req, deps, config);
      if (!principal) return reply.code(401).send({ error: 'unauthorized' });
      if (!requireCsrf(req, principal)) {
        return reply.code(403).send({ error: 'missing or wrong x-jm-csrf header' });
      }
      req.principal = principal;
      return;
    }
    // A page: a browser session only (a page never takes the token).
    const principal = req.headers.cookie ? authenticate(withoutBearer(req), deps, config) : null;
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
