import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../auth/audit.js';
import type { Backoff } from '../auth/backoff.js';
import { withCsrf } from '../auth/guard.js';
import { type DropZoneConfig, secretList } from '../config.js';
import type { Db } from '../db/open.js';
import {
  confirmGoalChange,
  type GoalChange,
  getGoalChange,
  goalChangeDiff,
} from '../goal-change.js';
import type { ForgePair } from '../outbox.js';
import { BUSY, checkPassphrase, html, notice, retryAfterSeconds } from './confirm.js';
import { goalConfirmHref } from './links.js';
import { breadcrumb, type Crumb, escapeHtml, PROJECTS_HREF, page, zoneHref } from './pages.js';

/**
 * The owner's confirmation of a goal change (#363, ruling R13): the page shows the change's diff
 * and the commit it would merge, and takes the operator passphrase (the confirm page's check and
 * backoff). Only a browser session reaches it (pages never take the token). The pass then merges
 * the PR at that commit and no other (`advanceGoalChanges`).
 */
export interface GoalConfirmDeps {
  db: Db;
  now(): Date;
  /** The per-source backoff the login, setup and sudo share. */
  backoff: Backoff;
  /** The zone's forges, to read the PR's head when the owner confirms. */
  forgesFor(zoneId: string): ForgePair;
}

export { goalConfirmHref };

const ConfirmBody = z.object({ headSha: z.string().min(1).max(200) });

type Found = { change: GoalChange; zone: DropZoneConfig };

const NOT_FOUND = notice('Nothing to confirm', 'There is no such goal change.', [
  { label: 'Projects', href: PROJECTS_HREF },
]);

/** A goal change's breadcrumb: Projects › the project › Goals. */
const goalsTrail = (zone: DropZoneConfig): Crumb[] => [
  { label: 'Projects', href: PROJECTS_HREF },
  { label: escapeHtml(zone.repo), href: zoneHref(zone.id) },
  { label: 'Goals', href: `${zoneHref(zone.id)}/goals` },
];

/** What a change that is not open says instead of a form. */
function notOpen(f: Found): string {
  const back = `<a href="${escapeHtml(zoneHref(f.zone.id))}/goals">Back to the goals</a>`;
  const words: Record<GoalChange['state'], string> = {
    proposed: 'This change has no pull request yet. It opens at the next pass; come back then.',
    open: '',
    confirmed:
      'This change is already confirmed. Jumpmaster approves and merges it at the next pass.',
    merged: 'This change is merged.',
    refused: 'This change was refused, so it will not be merged.',
    closed: 'This change was closed, so it will not be merged.',
  };
  const error = f.change.error ? ` ${escapeHtml(f.change.error)}.` : '';
  return notice(
    'Nothing to confirm',
    `${escapeHtml(words[f.change.state])}${error} ${back}`,
    goalsTrail(f.zone),
  );
}

/** The diff, the PR and its head SHA, the passphrase and the Approve and merge button. */
export function renderGoalConfirm(db: Db, f: Found, error?: string): string {
  const { change: c, zone } = f;
  const path = zone.crew.goalPath;
  const diff = goalChangeDiff(db, c.id);
  const err = error ? `<p class="error"><strong>${escapeHtml(error)}</strong></p>` : '';
  return page(
    breadcrumb([...goalsTrail(zone), { label: 'Approve and merge' }]) +
      `<h2>Approve and merge a change of ${escapeHtml(path)}</h2>` +
      `<p>Goal change ${escapeHtml(c.id)} in ${escapeHtml(zone.repo)}, pull request #${escapeHtml(c.prNumber)}. If you confirm, Jumpmaster approves and merges it at commit <code>${escapeHtml(c.headSha)}</code> and no other. If the pull request changes after that, it is not merged.</p>` +
      `<p>The lines removed and added:</p><pre>${escapeHtml(diff)}</pre>${err}` +
      `<form method="post" action="${escapeHtml(goalConfirmHref(c.id))}"><input type="hidden" name="headSha" value="${escapeHtml(c.headSha)}"><p><label>Operator passphrase <input type="password" name="passphrase" autocomplete="current-password" required autofocus></label></p><p><button>Approve and merge</button> <a href="${escapeHtml(zoneHref(zone.id))}/goals">Cancel</a></p></form>`,
  );
}

export function registerGoalConfirmPages(app: FastifyInstance, deps: GoalConfirmDeps): void {
  const { db, now, backoff } = deps;

  const find = (req: FastifyRequest<{ Params: { id: string } }>): Found | undefined => {
    if (!/^\d{1,15}$/.test(req.params.id)) return undefined;
    const change = getGoalChange(db, Number(req.params.id));
    const zone = req.jmConfig?.dropZones.find((z) => z.id === change?.zoneId);
    return change && zone ? { change, zone } : undefined;
  };
  const send = (req: FastifyRequest, reply: FastifyReply, status: number, body: string) =>
    html(reply, status, withCsrf(req, body));

  app.get<{ Params: { id: string } }>('/goal-changes/:id/confirm', async (req, reply) => {
    const f = find(req);
    if (!f) return send(req, reply, 404, NOT_FOUND);
    if (f.change.state !== 'open') return send(req, reply, 409, notOpen(f));
    return send(req, reply, 200, renderGoalConfirm(db, f));
  });

  app.post<{ Params: { id: string } }>('/goal-changes/:id/confirm', async (req, reply) => {
    // The guard let a browser session alone through (a page never takes the token).
    if (req.principal?.via !== 'session') return send(req, reply, 401, NOT_FOUND);
    const f = find(req);
    if (!f) return send(req, reply, 404, NOT_FOUND);
    if (f.change.state !== 'open') return send(req, reply, 409, notOpen(f));
    const checked = await checkPassphrase(req, deps);
    if (checked === 'backoff')
      return send(
        req,
        reply.header('retry-after', retryAfterSeconds(backoff, req, now())),
        429,
        renderGoalConfirm(
          db,
          f,
          'Too many wrong passphrases from here: wait a moment and try again.',
        ),
      );
    if (checked === 'busy')
      return send(req, reply.header('retry-after', '1'), 503, renderGoalConfirm(db, f, BUSY));
    if (checked === 'wrong')
      return send(req, reply, 401, renderGoalConfirm(db, f, 'That passphrase is not right.'));

    const body = ConfirmBody.safeParse(req.body ?? {});
    const shown = body.success ? body.data.headSha : null;
    const back = `<a href="${escapeHtml(zoneHref(f.zone.id))}/goals">Back to the goals</a>`;
    const moved = () =>
      send(
        req,
        reply,
        409,
        notice(
          'Not confirmed',
          `The pull request is not at the commit Jumpmaster made for this change any more, so it can't be confirmed. Propose the change again. ${back}`,
          goalsTrail(f.zone),
        ),
      );
    // Only the commit the server made, whose diff this page shows, may be confirmed.
    if (shown === null || shown !== f.change.headSha) return moved();
    // And only while it is the PR's head now.
    let head: string | null;
    try {
      const pr =
        f.change.prNumber === null
          ? null
          : await deps.forgesFor(f.zone.id).author.getPull(f.change.prNumber);
      head = pr && pr.state === 'open' && !pr.merged ? pr.headSha : null;
    } catch {
      return send(
        req,
        reply,
        502,
        renderGoalConfirm(db, f, 'Could not read the pull request from GitHub: try again.'),
      );
    }
    if (head !== shown) return moved();
    const at = now();
    if (!confirmGoalChange(db, f.change.id, shown, at))
      return send(
        req,
        reply,
        409,
        notOpen({ ...f, change: getGoalChange(db, f.change.id) ?? f.change }),
      );
    recordAudit(
      db,
      {
        via: 'session',
        action: 'goal.confirm',
        target: `goal-change:${f.change.id}`,
        detail: { zone: f.zone.id, pr: f.change.prNumber, sha: shown },
      },
      at,
      req.jmConfig ? secretList(req.jmConfig.secrets) : [],
    );
    return send(
      req,
      reply,
      200,
      notice(
        'Confirmed',
        `Jumpmaster approves and merges pull request #${escapeHtml(f.change.prNumber)} at commit <code>${escapeHtml(shown)}</code> at the next pass, once its required checks pass. ${back}`,
        goalsTrail(f.zone),
      ),
    );
  });
}
