import Fastify, { type FastifyInstance } from 'fastify';
import { registerControlRoutes } from './api/control.js';
import { registerStickRoutes, type StickRouteDeps } from './api/sticks.js';
import { getArtifact, listArtifacts, readArtifact } from './artifacts.js';
import { listBriefings, listRulings } from './briefings.js';
import { allowedHostsOf } from './config.js';
import { listCrewIssues } from './crew/store.js';
import {
  type AttemptKey,
  getAttempts,
  getDrop,
  getPullRequest,
  getUsageState,
  getZoneMode,
  isKilled,
  latestRateLimitEvent,
  latestVerdict,
  listEvents,
  listObservations,
  listOutbox,
  listRecentDrops,
  listWorkItems,
} from './db/repo.js';
import { fableStatus } from './fable.js';
import { getGoals } from './goals.js';
import { lastSyncResult } from './sync.js';
import {
  type CrewLine,
  type ItemDetail,
  renderBriefings,
  renderDrop,
  renderGoals,
  renderHome,
  renderObservations,
} from './ui/pages.js';
import { dispatchGate } from './usage.js';

const ATTEMPT_KEYS: AttemptKey[] = [
  'heal',
  'resolve',
  'resolve_total',
  'resume',
  'review',
  'no_change',
  'heal_no_change',
  'rate_limit',
];

/** Fastify instance with stick and UI routes registered; the caller listens. Logger stays off: payloads carry tokens. */
export function createApp(deps: StickRouteDeps & { kick?: () => void }): FastifyInstance {
  const app = Fastify({ logger: false });
  // Pages have no login, so a foreign Host could read them through DNS rebinding. Stick routes
  // authenticate with their own token and may arrive on any address a stick can reach.
  const allowedHosts = allowedHostsOf(deps.config);
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/')) return;
    if (!allowedHosts.includes(req.headers.host ?? '')) {
      return reply.code(403).type('text/plain').send('forbidden host');
    }
  });
  registerStickRoutes(app, deps);
  registerControlRoutes(app, deps);

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
      killed: isKilled(db),
      modes: Object.fromEntries(config.dropZones.map((z) => [z.id, getZoneMode(db, z.id, z.mode)])),
      items,
      drops: listRecentDrops(db),
      lastRateLimit: latestRateLimitEvent(db),
      now: at,
      usage: { gate: dispatchGate(db, config.usage, at), state: getUsageState(db) },
      details,
      outbox: listOutbox(db, ['unknown', 'failed']),
      briefings: listBriefings(db, { state: 'open' }),
      crew: config.dropZones.map((z): CrewLine => {
        const last = db
          .prepare(
            `SELECT created_at AS at FROM drops WHERE drop_zone_id = ? AND role = 'crew-lead'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(z.id) as { at: string } | undefined;
        const next = last
          ? new Date(Date.parse(last.at) + z.crew.cycleMinutes * 60_000).toISOString()
          : null;
        return {
          zoneId: z.id,
          enabled: z.crew.enabled,
          lastCycle: last?.at ?? null,
          nextDue: next !== null && Date.parse(next) > at.getTime() ? next : null,
          fable: fableStatus(db, config, at).reason,
        };
      }),
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/briefings', async (_req, reply) => {
    const { db, config } = deps;
    const holds = new Map<string, string>();
    for (const z of config.dropZones) {
      for (const c of listCrewIssues(db, z.id, ['promote_held'])) {
        if (c.holdUntil) holds.set(`issue:${c.id}`, c.holdUntil);
      }
    }
    const html = renderBriefings({
      open: listBriefings(db, { state: 'open' }),
      rulings: config.dropZones.flatMap((z) => listRulings(db, z.id)),
      zones: config.dropZones,
      holds,
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get<{ Params: { id: string } }>('/zones/:id/goals', async (req, reply) => {
    const { db, config } = deps;
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    const html = renderGoals({
      zone,
      goals: getGoals(db, zone.id),
      crewIssues: listCrewIssues(db, zone.id),
      items: listWorkItems(db, zone.id),
      skippedCrewUnpromoted: lastSyncResult(zone.id)?.skippedCrewUnpromoted ?? [],
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/observations', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(renderObservations(listObservations(deps.db))),
  );

  app.get<{ Params: { id: string } }>('/artifacts/:id', async (req, reply) => {
    const row = getArtifact(deps.db, Number(req.params.id));
    if (!row) return reply.code(404).type('text/plain').send('not found');
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .type(row.mediaType)
      .send(readArtifact(deps.config.dataDir, row));
  });

  app.get<{ Params: { id: string } }>('/drops/:id', async (req, reply) => {
    const drop = getDrop(deps.db, req.params.id);
    if (!drop) return reply.code(404).type('text/plain').send('not found');
    return reply
      .type('text/html; charset=utf-8')
      .send(renderDrop(drop, listEvents(deps.db, drop.id), listArtifacts(deps.db, drop.id)));
  });

  return app;
}
