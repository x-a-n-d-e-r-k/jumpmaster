import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../auth/audit.js';
import type { Backoff } from '../auth/backoff.js';
import {
  OperatorExistsError,
  operatorHash,
  passphraseProblem,
  ScryptBusyError,
  SETUP_CLAIM_MS,
  type SetupMode,
  setOperatorPassphrase,
  setupActive,
  verifyPassphrase,
} from '../auth/operator.js';
import {
  clearCookie,
  createSession,
  deleteSession,
  parseCookies,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SETUP_COOKIE,
  setCookie,
} from '../auth/sessions.js';
import type { LiveConfig } from '../config/source.js';
import type { Db } from '../db/open.js';
import { escapeHtml, page } from './pages.js';

export interface AuthPageDeps {
  db: Db;
  config: LiveConfig;
  now(): Date;
  setup: SetupMode;
  backoff: Backoff;
}

/** Longer than any passphrase may be, so an oversized one fails like a wrong one. */
const MAX_FIELD = 4096;
const LoginBody = z.object({
  passphrase: z.string().max(MAX_FIELD),
  next: z.string().max(MAX_FIELD).optional(),
});
const CodeBody = z.object({ code: z.string().max(64) });
const PassphraseBody = z.object({
  passphrase: z.string().max(MAX_FIELD),
  confirm: z.string().max(MAX_FIELD),
});

/** `next` only as a path on this server: one leading slash, no scheme, no `//host`, no backslash. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  // No backslash (some browsers read it as a slash) and no control character.
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  return next;
}

const CODE_HELP =
  "<p>The setup code is printed on the server's own output when it starts, on a line beginning <code>JUMPMASTER SETUP CODE:</code>. Under Docker Compose, read it with <code>docker compose logs jumpmaster</code>. Each restart prints a new code, and <code>jumpmaster ctl setup-code</code> prints a fresh one.</p>";

const error = (e?: string) => (e ? `<p class="error"><strong>${escapeHtml(e)}</strong></p>` : '');

export function renderSetupCode(e?: string): string {
  return page(
    `<h2>Set up Jumpmaster</h2><p>This install has no operator yet. Enter the setup code to claim it, then choose the passphrase you will log in with.</p>${error(e)}${CODE_HELP}<form method="post" action="/setup/code"><p><label>Setup code <input name="code" autocomplete="off" required placeholder="XXXX-XXXX-XXXX"></label> <button>Continue</button></p></form>`,
    { chrome: false },
  );
}

export function renderSetupPassphrase(e?: string): string {
  return page(
    `<h2>Choose the operator passphrase</h2><p>At least 12 characters. It is the browser login for this install; <code>jumpmaster ctl</code> keeps using the operator token.</p>${error(e)}<form method="post" action="/setup/passphrase"><p><label>Passphrase <input type="password" name="passphrase" autocomplete="new-password" minlength="12" maxlength="256" required></label></p><p><label>Again <input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="256" required></label></p><p><button>Save and log in</button></p></form>`,
    { chrome: false },
  );
}

export function renderLogin(next: string, e?: string): string {
  return page(
    `<h2>Log in</h2>${error(e)}<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password" required autofocus></label> <button>Log in</button></p></form><p><small>Forgot it? With the operator token, <code>jumpmaster ctl passphrase set</code> sets a new one.</small></p>`,
    { chrome: false },
  );
}

/** A page that says what happened and where to go next, without a form. */
const notice = (title: string, body: string): string =>
  page(`<h2>${escapeHtml(title)}</h2><p>${body}</p>`, { chrome: false });

const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').send(body);

/**
 * The login and first-run pages: `/login`, `/logout`, `/setup`, `/setup/code` and
 * `/setup/passphrase`. The guard has already run the Host and Origin checks on them; each credential
 * POST is held by the per-source backoff and charges it only on a wrong credential.
 */
export function registerAuthPages(app: FastifyInstance, deps: AuthPageDeps): void {
  const { db, now, setup, backoff } = deps;

  /** Refuses a source still waiting; true when the request may go on. */
  const admitted = (req: FastifyRequest, reply: FastifyReply, render: () => string): boolean => {
    const c = backoff.check(req.ip, now());
    if (c.allowed) return true;
    void html(reply.header('retry-after', String(Math.ceil(c.retryAfterMs / 1000))), 429, render());
    return false;
  };

  const startSession = (reply: FastifyReply): void => {
    const s = createSession(db, now());
    reply.header('set-cookie', [
      setCookie(SESSION_COOKIE, s.id, SESSION_ABSOLUTE_MS / 1000),
      clearCookie(SETUP_COOKIE),
    ]);
  };

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    if (setupActive(db)) return reply.redirect('/setup', 302);
    return html(reply, 200, renderLogin(safeNext(req.query.next)));
  });

  app.post('/login', async (req, reply) => {
    if (setupActive(db)) return reply.redirect('/setup', 303);
    const body = LoginBody.safeParse(req.body ?? {});
    const next = safeNext(body.success ? body.data.next : undefined);
    const wait = 'Too many wrong passphrases from here: wait a moment and try again.';
    if (!admitted(req, reply, () => renderLogin(next, wait))) return reply;
    const stored = operatorHash(db);
    // Charged before the check, so one source holds at most one scrypt run at a time and cannot
    // fill the queue alone; a right passphrase resets it below.
    backoff.fail(req.ip, now());
    let right = false;
    try {
      right =
        body.success && stored !== null && (await verifyPassphrase(body.data.passphrase, stored));
    } catch (e) {
      if (!(e instanceof ScryptBusyError)) throw e;
      return html(reply.header('retry-after', '1'), 503, renderLogin(next, e.message));
    }
    if (!right) return html(reply, 401, renderLogin(next, 'That passphrase is not right.'));
    // The passphrase may have changed while this check waited: the old one no longer logs in.
    if (operatorHash(db) !== stored) {
      return html(
        reply,
        401,
        renderLogin(next, 'The passphrase changed while you were logging in. Log in again.'),
      );
    }
    backoff.reset(req.ip);
    // The id is rotated: whatever session the browser held ends here.
    const held = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (held) deleteSession(db, held);
    startSession(reply);
    return reply.redirect(next, 303);
  });

  app.post('/logout', async (req, reply) => {
    const held = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (held) deleteSession(db, held);
    return reply.header('set-cookie', clearCookie(SESSION_COOKIE)).redirect('/login', 303);
  });

  const claimOf = (req: FastifyRequest): string =>
    parseCookies(req.headers.cookie)[SETUP_COOKIE] ?? '';

  app.get('/setup', async (req, reply) => {
    if (!setupActive(db)) return reply.redirect('/', 302);
    return html(
      reply,
      200,
      setup.claimValid(claimOf(req), now()) ? renderSetupPassphrase() : renderSetupCode(),
    );
  });

  const complete = () =>
    notice(
      'Setup is complete',
      'This install already has an operator. <a href="/login">Log in</a>.',
    );

  app.post('/setup/code', async (req, reply) => {
    if (!setupActive(db)) return html(reply, 409, complete());
    const wait = 'Too many wrong codes from here: wait a moment and try again.';
    if (!admitted(req, reply, () => renderSetupCode(wait))) return reply;
    const body = CodeBody.safeParse(req.body ?? {});
    const claim = body.success ? setup.accept(body.data.code, now()) : null;
    if (!claim) {
      backoff.fail(req.ip, now());
      return html(reply, 401, renderSetupCode('That is not the current setup code.'));
    }
    backoff.reset(req.ip);
    return reply
      .header('set-cookie', setCookie(SETUP_COOKIE, claim, SETUP_CLAIM_MS / 1000))
      .redirect('/setup', 303);
  });

  app.post('/setup/passphrase', async (req, reply) => {
    if (!setupActive(db)) return html(reply, 409, complete());
    if (!setup.claimValid(claimOf(req), now())) {
      return html(
        reply,
        403,
        notice(
          'Enter the setup code first',
          'The setup code was not entered here, or more than ten minutes ago. A code works once: print a fresh one with <code>jumpmaster ctl setup-code</code> (or restart the server), then <a href="/setup">enter it</a>.',
        ),
      );
    }
    const body = PassphraseBody.safeParse(req.body ?? {});
    if (!body.success) return html(reply, 400, renderSetupPassphrase('Fill in both fields.'));
    const problem = passphraseProblem(body.data.passphrase);
    if (problem)
      return html(
        reply,
        400,
        renderSetupPassphrase(`${problem[0]?.toUpperCase()}${problem.slice(1)}.`),
      );
    if (body.data.passphrase !== body.data.confirm) {
      return html(reply, 400, renderSetupPassphrase('The two passphrases differ.'));
    }
    try {
      await setOperatorPassphrase(db, body.data.passphrase, now(), { expect: 'claim' });
    } catch (e) {
      // A double submit, or `ctl passphrase set`, claimed the install while this one hashed.
      if (e instanceof OperatorExistsError) return html(reply, 409, complete());
      if (!(e instanceof ScryptBusyError)) throw e;
      return html(reply.header('retry-after', '1'), 503, renderSetupPassphrase(e.message));
    }
    setup.clear();
    // No session exists yet: the claim is the system's act on the setup code's word.
    recordAudit(db, { via: 'system', action: 'setup.claim', detail: { result: 'claimed' } }, now());
    startSession(reply);
    // T6's wizard lives at /setup/next; until it lands, home.
    return reply.redirect('/', 303);
  });
}
