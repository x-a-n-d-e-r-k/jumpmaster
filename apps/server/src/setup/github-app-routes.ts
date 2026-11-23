import { randomInt } from 'node:crypto';
import { isOwnerName } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordAudit } from '../auth/audit.js';
import { withCsrf } from '../auth/guard.js';
import { getSetting, setSetting } from '../config/revisions.js';
import type { ConfigStore } from '../config/store.js';
import type { Db } from '../db/open.js';
import { ManifestConversionError, redeemManifestCode } from '../forge/app-manifest-conversion.js';
import { serverScrubSet } from '../forge/scrub-set.js';
import { appManifest, appRegistrationUrl, isPlainHttpBase } from '../github/app-manifest.js';
import { PROJECT_URL } from '../project.js';
import { publicOrigin } from '../reach.js';
import { SYSTEM_HREF } from '../ui/links.js';
import { breadcrumb, escapeHtml, page } from '../ui/pages.js';
import { APP_ROLES, type AppRole, appEntryName } from '../vault/github-app-entries.js';
import type { AppManifestStore } from './app-manifest-state.js';

/**
 * The GitHub App manifest routes (spec 2026-11-13-github-app-auth §4.1, §13 Task 8).
 *
 * - `POST /setup/github-app/start` (a page, with sudo): mints a state bound to the session, owner
 *   and role, and renders the form that posts the role's manifest to the owner's registration URL.
 * - `GET /setup/github-app/callback` (no session: GitHub's redirect comes without the Strict
 *   cookie): consumes the state and redeems the code at once; the app is held pending for the
 *   session the state was bound to.
 * - `POST /setup/github-app/finish` (a page, same-origin, so it carries the cookie): claims the
 *   pending app for its own session and writes the vault entry.
 *
 * No log line, error, audit row or page carries the code, the state (but in the start form), the
 * PEM, the client secret or the webhook secret.
 */

export type GitHubAppRouteDeps = {
  db: Db;
  store: ConfigStore;
  now(): Date;
  log: (msg: string) => void;
  manifestStore: AppManifestStore;
  /** The conversion's fetch and API base (tests inject a fake GitHub). */
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  /** Where the code and state are registered for the log scrub; the server's set by default. */
  scrub?: { add(secret: string): void };
};

const OWNER_TYPES = ['User', 'Organization'] as const;
type OwnerType = (typeof OWNER_TYPES)[number];

const INSTALL_ID = /^[a-z0-9]{8}$/;
const INSTALL_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The install's id in its app names, made once (8 lowercase letters or digits) and kept in the
 * settings table. It is not a secret: it tells two installs' apps apart on one owner.
 */
export function installIdOf(db: Db, now: Date): string {
  const stored = getSetting(db, 'github_app.install_id');
  if (typeof stored === 'string' && INSTALL_ID.test(stored)) return stored;
  let id = '';
  for (let i = 0; i < 8; i++) id += INSTALL_ID_ALPHABET[randomInt(INSTALL_ID_ALPHABET.length)];
  setSetting(db, 'github_app.install_id', id, now);
  return id;
}

/** A URL as it may be logged: the values of `code` and `state` replaced with `[redacted]`. */
export function redactManifestUrl(url: string): string {
  return url.replace(/([?&](?:code|state)=)[^&#]*/g, '$1[redacted]');
}

/** Drops expired states and pendings, and says once per discarded app to delete it on GitHub. */
export function sweepPendingApps(
  store: Pick<AppManifestStore, 'sweep'>,
  log: (msg: string) => void,
): void {
  for (const d of store.sweep())
    log(
      `github app ${d.slug} (the ${d.role} app for ${d.owner}) was not finished within ten minutes and was discarded: delete it on GitHub (https://github.com/settings/apps), then create it again`,
    );
}

const isRole = (v: unknown): v is AppRole =>
  typeof v === 'string' && (APP_ROLES as readonly string[]).includes(v);
const isOwnerType = (v: unknown): v is OwnerType =>
  typeof v === 'string' && (OWNER_TYPES as readonly string[]).includes(v);

const NO_VAULT =
  'The vault is off, so the new app could not be saved. Turn the vault on first (System, Credentials), then create the app.';

export function registerGitHubAppRoutes(app: FastifyInstance, deps: GitHubAppRouteDeps): void {
  const { db, store, now, log, manifestStore } = deps;
  const scrub = deps.scrub ?? serverScrubSet;

  /** A session page (start and finish): the navigation and the session's CSRF meta. */
  const sessionPage = (req: FastifyRequest, reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(
        withCsrf(
          req,
          page(
            breadcrumb([
              { label: 'System', href: SYSTEM_HREF },
              { label: 'Setup', href: '/setup/claude' },
              { label: 'GitHub', href: '/setup/forge' },
              { label: 'Create a GitHub App' },
            ]) + body,
            { title: 'Create a GitHub App' },
          ),
        ),
      );

  /** A callback page: no session, never cached, never a Referer. */
  const callbackPage = (reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(page(body, { chrome: false, title: 'Create a GitHub App' }));

  const para = (text: string, cls = '') =>
    `<p${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</p>`;

  app.post('/setup/github-app/start', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { owner, role, ownerType } = body;
    if (
      typeof owner !== 'string' ||
      !isOwnerName(owner) ||
      !isRole(role) ||
      !isOwnerType(ownerType)
    )
      return sessionPage(
        req,
        reply,
        400,
        `<h2>Create a GitHub App</h2>${para('Name a GitHub owner, the role (author or reviewer) and whether the owner is a user or an organization.', 'warn')}`,
      );
    const p = req.principal;
    if (!p?.sudo || !p.sessionId)
      return sessionPage(
        req,
        reply,
        403,
        `<h2>Create a GitHub App</h2>${para('Creating an app needs sudo: enter the passphrase again, then start over.', 'warn')}`,
      );
    if (store.vault() === 'disabled')
      return sessionPage(req, reply, 409, `<h2>Create a GitHub App</h2>${para(NO_VAULT, 'warn')}`);
    let state: string;
    try {
      state = manifestStore.mintState({ sessionId: p.sessionId, owner, role });
    } catch {
      return sessionPage(
        req,
        reply,
        429,
        `<h2>Create a GitHub App</h2>${para('Too many app creations are in progress: try again in a few minutes.', 'warn')}`,
      );
    }
    scrub.add(state);
    const config = req.jmConfig ?? store.current();
    const baseUrl = publicOrigin(config) ?? `${req.protocol}://${req.headers.host ?? ''}`;
    const manifest = appManifest(role, {
      baseUrl,
      installId: installIdOf(db, now()),
      projectUrl: PROJECT_URL,
    });
    const action = appRegistrationUrl(owner, ownerType, state);
    const warning = isPlainHttpBase(baseUrl)
      ? para(
          `This server is reached at ${baseUrl}, over plain HTTP: the code GitHub sends back crosses the network in clear text, and it is redeemed for the app's private key. Use HTTPS (set server.publicUrl to an https:// address) to fix this.`,
          'warn',
        )
      : '';
    return sessionPage(
      req,
      reply,
      200,
      `<h2>Create the ${escapeHtml(role)} app for ${escapeHtml(owner)}</h2>` +
        para(
          `GitHub will show the app ${manifest.name} with its permissions. Create it there, and GitHub sends you back here to finish.`,
        ) +
        warning +
        `<form method="post" action="${escapeHtml(action)}">` +
        `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
        '<button type="submit">Continue to GitHub</button></form>',
    );
  });

  app.get('/setup/github-app/callback', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const code = typeof q.code === 'string' ? q.code : '';
    const state = typeof q.state === 'string' ? q.state : '';
    const binding = manifestStore.consumeState(state);
    if (!binding)
      return callbackPage(
        reply,
        400,
        `<h2>Create a GitHub App</h2>${para('This link has expired or was already used: start again from Jumpmaster. If GitHub made an app, delete it there first.', 'warn')}`,
      );
    // Only once the state is ours: an unauthenticated caller must not be able to fill
    // (and evict real secrets from) the bounded server scrub set, or hide words of their
    // choosing from the log. A state that does not match is never logged on that path.
    // From here both are scrubbed from every later log line, before anything can fail.
    if (code !== '') scrub.add(code);
    scrub.add(state);
    let redeemed: Awaited<ReturnType<typeof redeemManifestCode>>;
    try {
      redeemed = await redeemManifestCode(code, binding, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
      });
    } catch (e) {
      const conversion = e instanceof ManifestConversionError;
      const status = conversion && (e.status === 0 || e.status === 404) ? 400 : 502;
      const message = conversion
        ? e.message
        : 'converting the app manifest failed; delete the app on GitHub and create it again';
      log(
        `github app: creating the ${binding.role} app for ${binding.owner} failed at ${redactManifestUrl(req.url)}: ${message}`,
      );
      return callbackPage(
        reply,
        status,
        `<h2>The app was not created</h2>${para(message, 'warn')}`,
      );
    }
    let id: string;
    try {
      id = manifestStore.putPending(binding.sessionId, {
        ...redeemed,
        appId: String(redeemed.appId),
      });
    } catch {
      log(
        `github app ${redeemed.slug} (the ${binding.role} app for ${binding.owner}) could not be held for Finish: delete it on GitHub`,
      );
      return callbackPage(
        reply,
        503,
        `<h2>The app was not saved</h2>${para(`Too many apps are waiting to be finished. Delete the app ${redeemed.slug} on GitHub, then create it again in a few minutes.`, 'warn')}`,
      );
    }
    return callbackPage(
      reply,
      200,
      `<h2>Finish creating ${escapeHtml(redeemed.slug)}</h2>` +
        para(
          `GitHub made the ${binding.role} app for ${binding.owner}. Finish within ten minutes to save it in the vault.`,
        ) +
        '<form method="post" action="/setup/github-app/finish">' +
        `<input type="hidden" name="id" value="${escapeHtml(id)}">` +
        '<button type="submit">Finish</button></form>',
    );
  });

  app.post('/setup/github-app/finish', async (req, reply) => {
    const p = req.principal;
    if (store.vault() === 'disabled')
      return sessionPage(req, reply, 409, `<h2>Create a GitHub App</h2>${para(NO_VAULT, 'warn')}`);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = manifestStore.claimPending(body.id, p?.sessionId);
    if (!pending)
      return sessionPage(
        req,
        reply,
        400,
        `<h2>The app was not saved</h2>${para('This finish link has expired, was already used or belongs to another session: the app was not saved. Delete it on GitHub and create it again.', 'warn')}`,
      );
    const { owner, role, slug, appId, clientId, pem } = pending;
    const r = store.putAppEntry(owner, role, {
      appId,
      slug,
      clientId,
      pem,
      importedAt: now().toISOString(),
    });
    if (!r.ok) {
      log(
        `github app ${slug} (the ${role} app for ${owner}) could not be saved: delete it on GitHub and create it again`,
      );
      return sessionPage(
        req,
        reply,
        500,
        `<h2>The app was not saved</h2>${para(`Saving the app ${slug} failed. Delete it on GitHub and create it again.`, 'warn')}`,
      );
    }
    recordAudit(
      db,
      {
        via: p?.via ?? 'session',
        action: 'github-app.create',
        target: appEntryName(owner, role),
        detail: { owner, role, slug, appId },
      },
      now(),
      [pem],
    );
    log(`github app ${slug} saved as the ${role} app for ${owner}`);
    const install = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
    return sessionPage(
      req,
      reply,
      200,
      `<h2>Saved ${escapeHtml(slug)}</h2>` +
        para(
          `The ${role} app for ${owner} is in the vault. Install it on the repositories it works on:`,
        ) +
        `<p><a href="${escapeHtml(install)}">${escapeHtml(install)}</a></p>`,
    );
  });
}
