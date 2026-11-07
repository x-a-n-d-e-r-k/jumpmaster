import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/open.js';
import { activeWorkCount, setKilled, setZoneMode, ZONE_MODES } from '../db/repo.js';
import { engageKill } from '../leases.js';

export interface ControlDeps {
  db: Db;
  config: Config;
  now(): Date;
}

const ZoneBody = z.object({ mode: z.enum(ZONE_MODES) });
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
  const allowed = config.listen.allowedHosts ?? [
    `127.0.0.1:${config.listen.port}`,
    `localhost:${config.listen.port}`,
  ];

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
