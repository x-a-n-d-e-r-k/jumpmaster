import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { appliedDetail } from '../api/operator-actions.js';
import { recordAudit } from '../auth/audit.js';
import type { Backoff } from '../auth/backoff.js';
import { requireCsrf, withCsrf } from '../auth/guard.js';
import { operatorHash, ScryptBusyError, verifyPassphrase } from '../auth/operator.js';
import type { ConsumeFailure, Pending } from '../config/confirm.js';
import type { ConfigStore } from '../config/store.js';
import { secretList } from '../config.js';
import type { Db } from '../db/open.js';
import { safeNext } from './auth-pages.js';
import { breadcrumb, type Crumb, escapeHtml, page } from './pages.js';

export interface ConfirmPageDeps {
  db: Db;
  store: ConfigStore;
  now(): Date;
  /** The per-source backoff the login, setup and sudo share: the passphrase here is a guess too. */
  backoff: Backoff;
  /** Told of each pending change this page applies, with the documents before and after it. */
  onApplied?(
    pending: Pending,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    revision: number,
  ): void;
}

/** Longer than any passphrase may be, so an oversized one fails like a wrong one. */
const MAX_FIELD = 4096;
const PassphraseBody = z.object({ passphrase: z.string().max(MAX_FIELD) });

/**
 * The operator passphrase a page's form carries (`passphrase` in the body), checked as the sudo
 * for one change: `backoff` while this source waits (nothing is charged or checked), else the
 * attempt is charged before the check (as the login is) and a right passphrase resets it. `busy`
 * when the passphrase check is saturated; `wrong` also when the passphrase changed meanwhile
 * (which ended every session, this one included).
 */
export async function checkPassphrase(
  req: FastifyRequest,
  deps: { db: Db; now(): Date; backoff: Backoff },
): Promise<'ok' | 'wrong' | 'busy' | 'backoff'> {
  const { db, now, backoff } = deps;
  if (!backoff.check(req.ip, now()).allowed) return 'backoff';
  const body = PassphraseBody.safeParse(req.body ?? {});
  const stored = operatorHash(db);
  backoff.fail(req.ip, now());
  let right = false;
  try {
    right =
      body.success && stored !== null && (await verifyPassphrase(body.data.passphrase, stored));
  } catch (e) {
    if (e instanceof ScryptBusyError) return 'busy';
    throw e;
  }
  if (!right || operatorHash(db) !== stored) return 'wrong';
  backoff.reset(req.ip);
  return 'ok';
}

/** What a page says when the passphrase check is saturated (`busy`). */
export const BUSY = new ScryptBusyError().message;

/** How long this source still waits, in whole seconds (at least one), for `retry-after`. */
export const retryAfterSeconds = (backoff: Backoff, req: FastifyRequest, now: Date): string => {
  const c = backoff.check(req.ip, now);
  return String(Math.max(1, Math.ceil(c.allowed ? 0 : c.retryAfterMs / 1000)));
};
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

export const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').send(body);

/** Home › the page: a guarded change waits on Home's Needs you. */
const HOME_TRAIL: readonly Crumb[] = [{ label: 'Home', href: '/' }];

/** A one-paragraph page under `trail` (Home by default), the title its last breadcrumb step. */
export const notice = (title: string, body: string, trail: readonly Crumb[] = HOME_TRAIL): string =>
  page(
    `${breadcrumb([...trail, { label: escapeHtml(title) }])}<h2>${escapeHtml(title)}</h2><p>${body}</p>`,
  );

const GONE_TEXT =
  'This change is not waiting for confirmation: it was confirmed, it expired (after ten minutes), the server restarted, or it belongs to another session. Start the change again.';
const GONE = notice('Nothing to confirm', GONE_TEXT);

/**
 * A frame's start: the `jm-csrf` meta `withCsrf` fills, so the dialog's script has the token its
 * POST needs from the same response that minted the confirmation.
 */
const FRAME_CSRF = '<meta name="jm-csrf" content="">';
/**
 * How every frame begins, whatever token `withCsrf` fills in: the chat's dialog injects a response
 * only when it starts so (#579), never a login or setup page a redirect led to.
 */
export const FRAME_START = '<meta name="jm-csrf" content="';
/** The frame's GONE: the same words without the page around them (or a way off the thread). */
const GONE_FRAME = `${FRAME_CSRF}<p><strong>Nothing to confirm.</strong> ${GONE_TEXT}</p>`;

/** Where Cancel (and a refusal's way back) goes: the change's `cancelTo`, else home. */
const cancelOf = (pending: Pending): string =>
  pending.cancelTo ? safeNext(pending.cancelTo) : '/';

/**
 * Each consequence verbatim, the notes beside them, the passphrase and the minted token. As a
 * `frame` (the chat's confirm dialog, #503) it is the same content without the page: no heading
 * (the dialog has its own), no navigation, and Cancel a button that closes the dialog.
 */
export function renderConfirm(
  pending: Pending,
  token: string,
  error?: string,
  o: { frame?: boolean } = {},
): string {
  // A change proposed by the setup wizard says so, so the operator knows where they are.
  const setup = pending.returnTo?.startsWith('/setup/')
    ? '<p><strong>This is part of setting up Jumpmaster.</strong> Confirm to continue to the next step, or cancel to go back.</p>'
    : '';
  const items = pending.guarded.map((g) => `<li>${escapeHtml(g.consequence)}</li>`).join('');
  const notes =
    pending.notes.length > 0
      ? `<p>Also note:</p><ul>${pending.notes.map((n) => `<li><code>${escapeHtml(n.path)}</code>: ${escapeHtml(n.note)}</li>`).join('')}</ul>`
      : '';
  const err = error ? `<p class="error"><strong>${escapeHtml(error)}</strong></p>` : '';
  const cancel = o.frame
    ? '<button type="button" data-cancel>Cancel</button>'
    : `<a href="${escapeHtml(cancelOf(pending))}">Cancel</a>`;
  const body = `${setup}<p>This change weakens a guard (§7.5). If you confirm it:</p><ul>${items}</ul>${notes}${err}<form method="post" action="/config/confirm/${escapeHtml(pending.id)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password" required autofocus></label></p><p><button class="primary">Confirm</button> ${cancel}</p></form><p><small>The confirmation is good for five minutes and once. <code>jumpmaster ctl</code> makes the same change with the operator token.</small></p>`;
  return o.frame
    ? `${FRAME_CSRF}${body}`
    : page(
        `${breadcrumb([...HOME_TRAIL, { label: 'Confirm a guarded change' }])}<h2>Confirm a guarded change</h2>${body}`,
      );
}

/** Whether a POST asked for the dialog's JSON answers rather than the page's HTML. */
const wantsJson = (req: FastifyRequest): boolean =>
  /\bapplication\/json\b/i.test(String(req.headers.accept ?? ''));

const json = (reply: FastifyReply, status: number, body: Record<string, unknown>) =>
  reply.code(status).send(body);

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
  const render = (req: FastifyRequest, pending: Pending, error?: string, frame = false) =>
    withCsrf(
      req,
      renderConfirm(
        pending,
        store.confirmations.mintConfirmation(pending, pending.sessionIdHash),
        error,
        { frame },
      ),
    );

  app.get<{ Params: { id: string }; Querystring: { frame?: string } }>(
    '/config/confirm/:id',
    async (req, reply) => {
      const frame = req.query.frame === '1';
      const pending = pendingOf(req);
      if (!pending) return html(reply, 404, withCsrf(req, frame ? GONE_FRAME : GONE));
      return html(reply, 200, render(req, pending, undefined, frame));
    },
  );

  /*
   * One handler for the page's form and the dialog's: every check, charge, audit and `onApplied`
   * below runs the same for both. Only the answer differs: with `Accept: application/json` (the
   * dialog, which must also carry the session's `x-jm-csrf`) it is JSON and never a redirect.
   */
  app.post<{ Params: { id: string } }>('/config/confirm/:id', async (req, reply) => {
    const principal = req.principal;
    const asJson = wantsJson(req);
    if (asJson && (!principal || !requireCsrf(req, principal)))
      return json(reply, 403, { error: 'csrf' });
    const pending = pendingOf(req);
    if (!principal)
      return asJson ? json(reply, 404, { error: 'gone' }) : html(reply, 404, withCsrf(req, GONE));
    const token = (req.body as { token?: unknown } | undefined)?.token;
    // A replay of a confirmation already used says so, rather than that nothing waits.
    if (!pending && typeof token === 'string' && store.confirmations.wasUsed(token))
      return asJson
        ? json(reply, 409, { error: 'used' satisfies ConsumeFailure })
        : html(reply, 409, withCsrf(req, notice('Not applied', escapeHtml(REASON.used(0)))));
    if (!pending)
      return asJson ? json(reply, 404, { error: 'gone' }) : html(reply, 404, withCsrf(req, GONE));
    const checked = await checkPassphrase(req, deps);
    if (checked === 'backoff') {
      const retryAfter = retryAfterSeconds(backoff, req, now());
      reply.header('retry-after', retryAfter);
      return asJson
        ? json(reply, 429, { error: 'backoff', retryAfter: Number(retryAfter) })
        : html(
            reply,
            429,
            render(
              req,
              pending,
              'Too many wrong passphrases from here: wait a moment and try again.',
            ),
          );
    }
    if (checked === 'busy') {
      reply.header('retry-after', '1');
      return asJson
        ? json(reply, 503, { error: 'busy' })
        : html(reply, 503, render(req, pending, BUSY));
    }
    const body = ConfirmBody.safeParse(req.body ?? {});
    if (checked === 'wrong' || !body.success)
      return asJson
        ? json(reply, 401, { error: 'passphrase' })
        : html(reply, 401, render(req, pending, 'That passphrase is not right.'));
    const before = store.document();
    let r: ReturnType<ConfigStore['apply']>;
    try {
      r = store.apply(pending.patch, {
        ...pending.meta,
        principal,
        expectRevision: pending.expectRevision,
        confirmation: { pendingId: pending.id, token: body.data.token },
      });
    } catch (e) {
      // Nothing was applied: the page's answer is the server's usual 500, the dialog's says so.
      if (!asJson) throw e;
      req.log.error({ err: e }, 'applying a confirmed change failed');
      return json(reply, 500, { error: 'failed' });
    }
    if (r.ok) {
      deps.onApplied?.(pending, before, store.document(), r.revision);
      recordAudit(
        db,
        {
          via: 'session',
          action: pending.meta.audit?.action ?? ACTION_OF[pending.meta.via],
          detail: { ...appliedDetail(r), ...pending.meta.audit?.detail },
        },
        now(),
        // The request's snapshot, the secrets now and the retired ones (T3 review M6).
        [
          ...new Set([
            ...secretList((req.jmConfig ?? store.current()).secrets),
            ...secretList(store.current().secrets),
            ...store.retired(),
          ]),
        ],
      );
      if (asJson) return json(reply, 200, { applied: true, revision: r.revision });
      if (pending.returnTo) return reply.redirect(safeNext(pending.returnTo), 303);
      return html(
        reply,
        200,
        withCsrf(
          req,
          notice(
            'Applied',
            `The change is applied as revision ${r.revision}; it takes effect at the next pass.`,
          ),
        ),
      );
    }
    if (asJson) {
      if ('confirmation' in r) return json(reply, 409, { error: r.confirmation });
      if ('sessionForbidden' in r)
        return json(reply, 403, { error: 'forbidden', paths: r.sessionForbidden });
      return json(reply, 400, { error: 'invalid' });
    }
    if ('confirmation' in r)
      return html(
        reply,
        409,
        withCsrf(
          req,
          notice(
            'Not applied',
            `${escapeHtml(REASON[r.confirmation](store.revision()))} <a href="${escapeHtml(cancelOf(pending))}">Start the change again</a>`,
          ),
        ),
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
