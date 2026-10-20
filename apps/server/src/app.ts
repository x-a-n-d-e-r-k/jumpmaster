import Fastify, { type FastifyInstance } from 'fastify';
import { registerStickRoutes, type StickRouteDeps } from './api/sticks.js';
import {
  type AttemptKey,
  getAttempts,
  getDrop,
  getPullRequest,
  getUsageState,
  latestRateLimitEvent,
  latestVerdict,
  listEvents,
  listOutbox,
  listRecentDrops,
  listWorkItems,
} from './db/repo.js';
import { type ItemDetail, renderDrop, renderHome } from './ui/pages.js';
import { dispatchGate } from './usage.js';

const ATTEMPT_KEYS: AttemptKey[] = [
  'heal',
  'resolve',
  'resolve_total',
  'resume',
  'review',
  'no_change',
  'rate_limit',
];

/** Fastify instance with stick and UI routes registered; the caller listens. Logger stays off: payloads carry tokens. */
export function createApp(deps: StickRouteDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  registerStickRoutes(app, deps);

  app.get('/', async (_req, reply) => {
    const { db, config, now } = deps;
    const at = now();
    const items = config.dropZones.flatMap((z) => listWorkItems(db, z.id));
    const details = new Map<number, ItemDetail>();
    for (const i of items) {
      const v = latestVerdict(db, i.id);
      const pr = getPullRequest(db, i.id);
      details.set(i.id, {
        ...(pr ? { headSha: pr.headSha } : {}),
        ...(v ? { verdict: { decision: v.decision, forced: v.forced, summary: v.summary } } : {}),
        attempts: Object.fromEntries(ATTEMPT_KEYS.map((k) => [k, getAttempts(db, i.id, k).count])),
      });
    }
    const html = renderHome({
      zones: config.dropZones,
      items,
      drops: listRecentDrops(db),
      lastRateLimit: latestRateLimitEvent(db),
      now: at,
      usage: { gate: dispatchGate(db, config.usage, at), state: getUsageState(db) },
      details,
      outbox: listOutbox(db, ['unknown', 'failed']),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: { id: string } }>('/drops/:id', async (req, reply) => {
    const drop = getDrop(deps.db, req.params.id);
    if (!drop) return reply.code(404).type('text/plain').send('not found');
    return reply
      .type('text/html; charset=utf-8')
      .send(renderDrop(drop, listEvents(deps.db, drop.id)));
  });

  return app;
}
