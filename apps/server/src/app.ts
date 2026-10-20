import Fastify, { type FastifyInstance } from 'fastify';
import { registerStickRoutes, type StickRouteDeps } from './api/sticks.js';
import {
  getDrop,
  latestRateLimitEvent,
  listEvents,
  listRecentDrops,
  listWorkItems,
} from './db/repo.js';
import { renderDrop, renderHome } from './ui/pages.js';

/** Fastify instance with stick and UI routes registered; the caller listens. Logger stays off: payloads carry tokens. */
export function createApp(deps: StickRouteDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  registerStickRoutes(app, deps);

  app.get('/', async (_req, reply) => {
    const { db, config, now } = deps;
    const items = config.dropZones.flatMap((z) => listWorkItems(db, z.id));
    const html = renderHome({
      zones: config.dropZones,
      items,
      drops: listRecentDrops(db),
      lastRateLimit: latestRateLimitEvent(db),
      now: now(),
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
