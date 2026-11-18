import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { withCsrf } from '../auth/guard.js';
import type { ApplyResult, ConfigStore } from '../config/store.js';
import type { AppBrokers } from '../forge/app-brokers.js';
import { GitHubAppError } from '../forge/github-app.js';
import { escapeHtml, page } from '../ui/pages.js';
import { APP_ROLES, type AppRole, ownerOfRepo } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';

/**
 * GitHub App installation discovery (spec 2026-11-13-github-app-auth §4.1, §4.2, §13 Task 8).
 *
 * - `GET /setup/github-app/installed` (no session: GitHub's `setup_url` redirect comes without the
 *   Strict cookie): renders a same-origin form to discovery. It never reads the query: the
 *   `installation_id` GitHub sends along is never trusted, used or echoed.
 * - `POST /setup/github-app/discover` (a page: a session, same-origin): asks GitHub, per two-bot
 *   zone and role with an app, for the installation on `zone.repo` and the repository's id, and
 *   proposes the ids it returned as one guarded change, which the operator confirms with the
 *   passphrase on `/config/confirm/<pendingId>`.
 *
 * No log line or page carries a token, a JWT or a PEM: the broker's errors are already scrubbed.
 */

export type InstallationDiscoveryDeps = {
  store: ConfigStore;
  appBrokers?: Pick<AppBrokers, 'brokerFor'>;
  /** The app entries as they resolve now (for each app's slug); the store's by default. */
  resolvedApps?: () => ResolvedApps;
  log: (msg: string) => void;
};

export const INSTALLED_PATH = '/setup/github-app/installed';
export const DISCOVER_PATH = '/setup/github-app/discover';

type Found = { installationId: number; repositoryId: number };

export type RoleOutcome =
  | ({ kind: 'installed' } & Found)
  | { kind: 'not-installed'; slug?: string }
  | { kind: 'no-app' }
  | { kind: 'up-to-date' }
  | { kind: 'error'; message: string };

export type ZoneOutcome = {
  id: string;
  repo: string;
  roles: Partial<Record<AppRole, RoleOutcome>>;
  refused?: string;
};

type Recorded = { repositoryId?: unknown; installations?: Record<string, unknown> };

const UNEXPECTED = 'asking GitHub failed unexpectedly';

/** A failure as the page and log may show it: the broker's scrubbed message, or a fixed text. */
const messageOf = (e: unknown): string => (e instanceof GitHubAppError ? e.message : UNEXPECTED);

/**
 * Asks GitHub for every two-bot zone's installation ids, and builds the document that records the
 * new ones. Returns the document only when something changed. Ids GitHub did not return are never
 * set, and recorded ids are never removed.
 */
export async function discoverInstallations(
  doc: Record<string, unknown>,
  o: {
    brokerFor: AppBrokers['brokerFor'];
    apps: ResolvedApps;
    log: (msg: string) => void;
  },
): Promise<{ zones: ZoneOutcome[]; next?: Record<string, unknown> }> {
  const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
  const outcomes: ZoneOutcome[] = [];
  let changed = false;
  const nextZones: Record<string, unknown>[] = [];
  for (const zone of zones) {
    const id = String(zone.id);
    const repo = String(zone.repo);
    if (zone.identity === 'starter') {
      nextZones.push(zone);
      continue;
    }
    const outcome: ZoneOutcome = { id, repo, roles: {} };
    outcomes.push(outcome);
    let owner: string;
    try {
      owner = ownerOfRepo(repo);
    } catch {
      outcome.refused = 'the repository is not OWNER/NAME';
      nextZones.push(zone);
      continue;
    }
    const name = repo.split('/')[1] as string;
    const found: Partial<Record<AppRole, Found>> = {};
    for (const role of APP_ROLES) {
      const broker = o.brokerFor(owner, role);
      if (!broker) {
        outcome.roles[role] = { kind: 'no-app' };
        continue;
      }
      try {
        const inst = await broker.installationFor(owner, name);
        if (!inst.installed) {
          const read = o.apps.get(owner)?.[role];
          outcome.roles[role] =
            read && read.source !== 'missing'
              ? { kind: 'not-installed', slug: read.entry.slug }
              : { kind: 'not-installed' };
          continue;
        }
        const repositoryId = await broker.repositoryIdOf(inst.installationId, owner, name);
        found[role] = { installationId: inst.installationId, repositoryId };
      } catch (e) {
        const message = messageOf(e);
        outcome.roles[role] = { kind: 'error', message };
        o.log(`github app installation discovery: zone ${id}, ${role}: ${message}`);
      }
    }
    const roles = APP_ROLES.filter((r) => found[r]);
    const repoIds = new Set(roles.map((r) => (found[r] as Found).repositoryId));
    const recorded = (zone.githubApp ?? undefined) as Recorded | undefined;
    if (repoIds.size > 1) {
      outcome.refused = `the author and reviewer apps see different repository ids for ${repo}`;
    } else if (
      repoIds.size === 1 &&
      recorded?.repositoryId !== undefined &&
      !repoIds.has(recorded.repositoryId as number)
    ) {
      outcome.refused = `the recorded repository id ${String(recorded.repositoryId)} is not the one GitHub returned for ${repo}`;
    }
    if (outcome.refused) {
      for (const r of roles) delete outcome.roles[r];
      nextZones.push(zone);
      continue;
    }
    const installations: Record<string, unknown> = { ...(recorded?.installations ?? {}) };
    let zoneChanged = false;
    for (const role of roles) {
      const f = found[role] as Found;
      if (recorded?.repositoryId === f.repositoryId && installations[role] === f.installationId) {
        outcome.roles[role] = { kind: 'up-to-date' };
        continue;
      }
      outcome.roles[role] = { kind: 'installed', ...f };
      installations[role] = f.installationId;
      zoneChanged = true;
    }
    if (zoneChanged) {
      const repositoryId = (found[roles[0] as AppRole] as Found).repositoryId;
      nextZones.push({ ...zone, githubApp: { ...recorded, repositoryId, installations } });
      changed = true;
    } else nextZones.push(zone);
  }
  return changed
    ? { zones: outcomes, next: { ...doc, dropZones: nextZones } }
    : { zones: outcomes };
}

const para = (text: string, cls = '') =>
  `<p${cls ? ` class="${cls}"` : ''}>${escapeHtml(text)}</p>`;

function roleLine(repo: string, o: RoleOutcome | undefined, refused?: string): string {
  if (refused) return `refused: ${escapeHtml(refused)}`;
  if (!o) return 'no app yet';
  switch (o.kind) {
    case 'installed':
      return `installed: installation ${escapeHtml(o.installationId)}, repository ${escapeHtml(o.repositoryId)}`;
    case 'up-to-date':
      return 'up to date';
    case 'no-app':
      return 'no app yet';
    case 'error':
      return `error: ${escapeHtml(o.message)}`;
    case 'not-installed': {
      const text = `not installed on ${escapeHtml(repo)}`;
      if (!o.slug) return text;
      const link = `https://github.com/apps/${encodeURIComponent(o.slug)}/installations/new`;
      return `${text}: install it at <a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;
    }
  }
}

function applyRefusal(r: Exclude<ApplyResult, { ok: true }>): string | undefined {
  if ('needsConfirmation' in r) return undefined;
  if ('issues' in r) return r.issues.map((i) => i.message).join('; ');
  if ('conflict' in r) return 'the config changed meanwhile: find the installations again';
  if ('sessionForbidden' in r)
    return `a browser session may not change ${r.sessionForbidden.join(', ')}`;
  return 'the change was refused';
}

export function registerGitHubAppInstalledRoutes(
  app: FastifyInstance,
  deps: InstallationDiscoveryDeps,
): void {
  const { store, log } = deps;
  const apps = deps.resolvedApps ?? (() => store.resolvedApps());

  app.get(INSTALLED_PATH, async (_req, reply) =>
    reply
      .code(200)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(
        page(
          '<h2>The GitHub App is installed</h2>' +
            para(
              "Jumpmaster asks GitHub for each zone's installation and repository ids, and proposes them as a change you confirm with your passphrase.",
            ) +
            `<form method="post" action="${DISCOVER_PATH}">` +
            '<button type="submit">Find the installations</button></form>',
          { chrome: false, title: 'GitHub App installed' },
        ),
      ),
  );

  const sessionPage = (req: FastifyRequest, reply: FastifyReply, status: number, body: string) =>
    reply
      .code(status)
      .header('referrer-policy', 'no-referrer')
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, page(body, { title: 'GitHub App installations' })));

  app.post(DISCOVER_PATH, async (req, reply) => {
    const principal = req.principal;
    if (!principal) return reply.code(401).type('text/plain').send('log in first');
    const expectRevision = store.revision();
    const doc = store.document() as Record<string, unknown>;
    const { zones, next } = await discoverInstallations(doc, {
      brokerFor: (owner, role) => deps.appBrokers?.brokerFor(owner, role),
      apps: apps(),
      log,
    });
    let result = '';
    if (next) {
      const r = store.apply(next, {
        via: 'ui',
        principal,
        expectRevision,
        note: 'record GitHub App installation ids',
        returnTo: INSTALLED_PATH,
        cancelTo: INSTALLED_PATH,
      });
      if (r.ok) result = para(`The ids are recorded as revision ${r.revision}.`);
      else if ('needsConfirmation' in r) {
        const href = `/config/confirm/${encodeURIComponent(r.needsConfirmation.pendingId)}`;
        result =
          para('Nothing is recorded until you confirm the change with your passphrase.') +
          `<p><a href="${escapeHtml(href)}">Review and confirm</a></p>`;
      } else result = para(`The change was not proposed: ${applyRefusal(r)}`, 'warn');
    } else result = para('Nothing to record.');
    const list = zones
      .map(
        (z) =>
          `<h3>${escapeHtml(z.id)} (${escapeHtml(z.repo)})</h3>` +
          (z.refused ? para(`Zone ${z.id} refused: ${z.refused}`, 'warn') : '') +
          '<ul>' +
          APP_ROLES.map(
            (role) => `<li>${escapeHtml(role)}: ${roleLine(z.repo, z.roles[role], z.refused)}</li>`,
          ).join('') +
          '</ul>',
      )
      .join('');
    return sessionPage(
      req,
      reply,
      200,
      '<h2>GitHub App installations</h2>' +
        (zones.length ? list : para('No zone uses GitHub Apps.')) +
        result,
    );
  });
}
