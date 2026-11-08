import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ruleBriefing } from '../briefings.js';
import { allowedHostsOf, type Config } from '../config.js';
import { requestCrewCycle } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import { activeWorkCount, setKilled, setZoneMode, ZONE_MODES } from '../db/repo.js';
import { engageKill } from '../leases.js';

export interface ControlDeps {
  db: Db;
  config: Config;
  now(): Date;
  /** Starts a pass without waiting for it, so a ruling applies promptly. */
  kick?: () => void;
}

const ZoneBody = z.object({ mode: z.enum(ZONE_MODES) });
const RuleBody = z.object({ optionId: z.string().min(1), note: z.string().max(2000).optional() });
const KillBody = z.object({ engaged: z.boolean() });

function tokenMatches(req: FastifyRequest, expected: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${expected}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined) return true; // Not a browser: the CLI sends no Origin.
  try {
    return allowed.includes(new URL(origin).host);
  } catch {
    return false;
  }
}

/** Operator routes. The token is required because a container can reach the host's loopback. */
export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { db, config, now } = deps;
  const allowed = allowedHostsOf(config);

  void app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (!tokenMatches(req, config.secrets.operatorToken)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (
        !allowed.includes(req.headers.host ?? '') ||
        !originAllowed(req.headers.origin, allowed)
      ) {
        return reply.code(403).send({ error: 'forbidden host or origin' });
      }
    });

    scope.post<{ Params: { id: string } }>('/api/control/zones/:id', async (req, reply) => {
      const zone = config.dropZones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      const body = ZoneBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid mode' });
      if (body.data.mode === 'observe') {
        const active = activeWorkCount(db, zone.id);
        if (active > 0) {
          return reply
            .code(409)
            .send({ error: `${active} active drops or forge writes: pause and drain first` });
        }
      }
      setZoneMode(db, zone.id, body.data.mode, now());
      return { zone: zone.id, mode: body.data.mode };
    });

    scope.post<{ Params: { id: string } }>(
      '/api/control/briefings/:id/rule',
      async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return reply.code(404).send({ error: 'unknown briefing' });
        }
        const body = RuleBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const r = ruleBriefing(db, id, body.data.optionId, body.data.note ?? '', now());
        if (!r.ok) {
          const error = { 404: 'unknown briefing', 409: 'already ruled', 400: 'unknown option' };
          return reply.code(r.status).send({ error: error[r.status] });
        }
        deps.kick?.();
        return { briefing: id, rulingId: r.rulingId };
      },
    );

    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/crew-cycle',
      async (req, reply) => {
        const zone = config.dropZones.find((z) => z.id === req.params.id);
        if (!zone) return reply.code(404).send({ error: 'unknown zone' });
        if (!zone.crew?.enabled) return reply.code(409).send({ error: 'crew is not enabled' });
        requestCrewCycle(zone.id, now());
        deps.kick?.();
        return { zone: zone.id, crewCycle: 'due' };
      },
    );

    scope.post('/api/control/kill', async (req, reply) => {
      const body = KillBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      if (!body.data.engaged) {
        setKilled(db, false, now());
        return { engaged: false, cancelled: 0 };
      }
      return { engaged: true, ...engageKill(db, now()) };
    });
  });
}
