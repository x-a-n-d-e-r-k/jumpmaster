import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appliedDetail } from '../api/control.js';
import { recordAudit } from '../auth/audit.js';
import type { Backoff } from '../auth/backoff.js';
import { withCsrf } from '../auth/guard.js';
import { operatorHash, ScryptBusyError, verifyPassphrase } from '../auth/operator.js';
import type { ConsumeFailure, Pending } from '../config/confirm.js';
import type { ConfigStore } from '../config/store.js';
import { secretList } from '../config.js';
import type { Db } from '../db/open.js';
import { safeNext } from './auth-pages.js';
import { escapeHtml, page } from './pages.js';

export interface ConfirmPageDeps {
  db: Db;
  store: ConfigStore;
  now(): Date;
  /** The per-source backoff the login, setup and sudo share: the passphrase here is a guess too. */
  backoff: Backoff;
}

/** Longer than any passphrase may be, so an oversized one fails like a wrong one. */
const MAX_FIELD = 4096;
const ConfirmBody = z.object({
  token: z.string().max(256),
  passphrase: z.string().max(MAX_FIELD),
});

const ACTION_OF: Record<Pending['meta']['via'], string> = {
  ui: 'config.apply',
  ctl: 'config.apply',
  import: 'config.import',
  rollback: 'config.rollback',
};

const REASON: Record<ConsumeFailure, (revision: number) => string> = {
  unknown: () =>
    'This confirmation is not one this page made (a newer render replaces it): open the page again.',
  used: () => 'This confirmation was already used: the change it confirmed is applied.',
  session: () =>
    'This confirmation belongs to another session: confirm the change where it was made.',
  changed: () => 'This confirmation was made for a different change: open the page for this one.',
  stale: (revision) =>
    `The config changed since this change was proposed (revision ${revision} is current): start the change again.`,
  expired: () => 'This confirmation expired: open the page again, or start the change again.',
};

const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').send(body);

const notice = (title: string, body: string): string =>
  page(`<h2>${escapeHtml(title)}</h2><p>${body}</p>`);

const GONE = notice(
  'Nothing to confirm',
  'This change is not waiting for confirmation: it was confirmed, it expired (after ten minutes), the server restarted, or it belongs to another session. Start the change again. <a href="/">Home</a>',
);

/** Each consequence verbatim, the notes beside them, the passphrase and the minted token. */
export function renderConfirm(pending: Pending, token: string, error?: string): string {
  const items = pending.guarded.map((g) => `<li>${escapeHtml(g.consequence)}</li>`).join('');
  const notes =
    pending.notes.length > 0
      ? `<p>Also note:</p><ul>${pending.notes.map((n) => `<li><code>${escapeHtml(n.path)}</code>: ${escapeHtml(n.note)}</li>`).join('')}</ul>`
      : '';
  const err = error ? `<p class="error"><strong>${escapeHtml(error)}</strong></p>` : '';
  return page(
    `<h2>Confirm a guarded change</h2><p>This change weakens a guard (§7.5). If you confirm it:</p><ul>${items}</ul>${notes}${err}<form method="post" action="/config/confirm/${escapeHtml(pending.id)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password" required autofocus></label></p><p><button>Confirm</button> <a href="/">Cancel</a></p></form><p><small>The confirmation is good for five minutes and once. <code>jumpmaster ctl</code> makes the same change with the operator token.</small></p>`,
  );
}

/**
 * `GET /config/confirm/:pendingId` renders the consequences of a session's pending guarded change
 * and mints a confirmation into the form; `POST` checks the passphrase (the sudo for this change;
 * a wrong one charges the per-source backoff), then has the store consume the confirmation and
 * apply the pending document with its base revision unchanged. Pages take a session only, and the
 * guard's Host and Origin checks have already run on the POST.
 */
export function registerConfirmPages(app: FastifyInstance, deps: ConfirmPageDeps): void {
  const { db, store, now, backoff } = deps;

  const pendingOf = (req: FastifyRequest<{ Params: { id: string } }>): Pending | undefined => {
    const sid = req.principal?.via === 'session' ? req.principal.sessionId : undefined;
    return sid ? store.confirmations.pending(req.params.id, sid) : undefined;
  };
  const render = (req: FastifyRequest, pending: Pending, error?: string) =>
    withCsrf(
      req,
      renderConfirm(
        pending,
        store.confirmations.mintConfirmation(pending, pending.sessionIdHash),
        error,
      ),
    );

  app.get<{ Params: { id: string } }>('/config/confirm/:id', async (req, reply) => {
    const pending = pendingOf(req);
    if (!pending) return html(reply, 404, withCsrf(req, GONE));
    return html(reply, 200, render(req, pending));
  });

  app.post<{ Params: { id: string } }>('/config/confirm/:id', async (req, reply) => {
    const principal = req.principal;
    const pending = pendingOf(req);
    const token = (req.body as { token?: unknown } | undefined)?.token;
    // A replay of a confirmation already used says so, rather than that nothing waits.
    if (!pending && typeof token === 'string' && store.confirmations.wasUsed(token))
      return html(reply, 409, withCsrf(req, notice('Not applied', escapeHtml(REASON.used(0)))));
    if (!principal || !pending) return html(reply, 404, withCsrf(req, GONE));
    const c = backoff.check(req.ip, now());
    if (!c.allowed)
      return html(
        reply.header('retry-after', String(Math.ceil(c.retryAfterMs / 1000))),
        429,
        render(req, pending, 'Too many wrong passphrases from here: wait a moment and try again.'),
      );
    const body = ConfirmBody.safeParse(req.body ?? {});
    const stored = operatorHash(db);
    // Charged before the check, as the login is; a right passphrase resets it.
    backoff.fail(req.ip, now());
    let right = false;
    try {
      right =
        body.success && stored !== null && (await verifyPassphrase(body.data.passphrase, stored));
    } catch (e) {
      if (!(e instanceof ScryptBusyError)) throw e;
      return html(reply.header('retry-after', '1'), 503, render(req, pending, e.message));
    }
    // A passphrase changed during the wait ended every session, this one included.
    if (!right || !body.success || operatorHash(db) !== stored)
      return html(reply, 401, render(req, pending, 'That passphrase is not right.'));
    backoff.reset(req.ip);
    const r = store.apply(pending.patch, {
      ...pending.meta,
      principal,
      expectRevision: pending.expectRevision,
      confirmation: { pendingId: pending.id, token: body.data.token },
    });
    if (r.ok) {
      recordAudit(
        db,
        { via: 'session', action: ACTION_OF[pending.meta.via], detail: appliedDetail(r) },
        now(),
        secretList(store.current().secrets),
      );
      if (pending.returnTo) return reply.redirect(safeNext(pending.returnTo), 303);
      return html(
        reply,
        200,
        withCsrf(
          req,
          notice(
            'Applied',
            `The change is applied as revision ${r.revision}; it takes effect at the next pass. <a href="/">Home</a>`,
          ),
        ),
      );
    }
    if ('confirmation' in r)
      return html(
        reply,
        409,
        withCsrf(req, notice('Not applied', escapeHtml(REASON[r.confirmation](store.revision())))),
      );
    if ('sessionForbidden' in r)
      return html(
        reply,
        403,
        withCsrf(
          req,
          notice(
            'Not applied',
            `A browser session may never change ${escapeHtml(r.sessionForbidden.join(', '))}: set it with <code>jumpmaster ctl</code> or in the config file.`,
          ),
        ),
      );
    const issues =
      'issues' in r
        ? r.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')
        : 'the change could not be applied';
    return html(reply, 400, withCsrf(req, notice('Not applied', escapeHtml(issues))));
  });
}
