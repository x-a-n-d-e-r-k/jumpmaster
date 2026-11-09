import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listBriefings, optionsDigest, ruleBriefing } from '../briefings.js';
import { allowedHostsOf, type Config, mcpConfigOf } from '../config.js';
import { requestCrewCycle } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import { activeWorkCount, setKilled, setZoneMode, ZONE_MODES } from '../db/repo.js';
import type { DoctorEnv } from '../doctor/checks.js';
import { DoctorBusyError, latestDoctorRun, processEnv, runDoctor } from '../doctor/run.js';
import type { Forge } from '../forge/github.js';
import { engageKill } from '../leases.js';
import {
  listMcpTokens,
  MAX_TOKEN_DAYS,
  MCP_SCOPES,
  mintMcpToken,
  revokeMcpToken,
} from '../mcp/tokens.js';
import type { ForgePair } from '../outbox.js';

export interface ControlDeps {
  db: Db;
  config: Config;
  now(): Date;
  /** Starts a pass without waiting for it, so a ruling applies promptly. */
  kick?: () => void;
  /** The zone's forges, for the doctor's reads (it never writes). Absent: no doctor routes. */
  forgesFor?(zoneId: string): ForgePair;
  /** A forge on the read token, when one is configured. */
  readForgeFor?(zoneId: string): Forge | undefined;
  /** This process as the doctor sees it (default: read from the process). */
  doctorEnv?: DoctorEnv;
}

const DoctorBody = z.strictObject({ zone: z.string().min(1).optional() });

const ZoneBody = z.object({ mode: z.enum(ZONE_MODES) });
const RuleBody = z.object({
  optionId: z.string().min(1),
  note: z.string().max(2000).optional(),
  /** The option set the ruler saw (from the page or `ctl briefings`). */
  optionsDigest: z.string().max(64).optional(),
});
const KillBody = z.object({ engaged: z.boolean() });
const MintBody = z.strictObject({
  zoneId: z.string().min(1),
  scope: z.enum(MCP_SCOPES),
  days: z.number().int().min(1).max(MAX_TOKEN_DAYS),
  label: z.string().max(80).optional(),
});

function tokenMatches(req: FastifyRequest, expected: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${expected}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Whether a request's Origin may reach a token route: absent (not a browser) or an allowed host. */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
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

    // Open briefings with their option ids, for `ctl rule` without the UI.
    scope.get('/api/control/briefings', async () => ({
      briefings: listBriefings(db, { state: 'open' }).map((b) => ({
        id: b.id,
        zone: b.zoneId,
        kind: b.kind,
        subject: b.subject,
        decision: b.decision,
        options: b.options.map((o) => ({ id: o.id, label: o.label })),
        optionsDigest: optionsDigest(b),
      })),
    }));

    scope.post<{ Params: { id: string } }>(
      '/api/control/briefings/:id/rule',
      async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return reply.code(404).send({ error: 'unknown briefing' });
        }
        const body = RuleBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const { optionId, note, optionsDigest: seen } = body.data;
        const r = ruleBriefing(db, id, optionId, note ?? '', now(), {
          ...(seen ? { optionsDigest: seen } : {}),
        });
        if (!r.ok) {
          const error = { 404: 'unknown briefing', 409: 'already ruled', 400: 'unknown option' };
          return reply.code(r.status).send({ error: r.reason ?? error[r.status] });
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

    // MCP tokens: minted only here, the plain token returned once; registered only with mcp on.
    if (mcpConfigOf(config).enabled) {
      scope.post('/api/control/mcp-tokens', async (req, reply) => {
        const body = MintBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const { zoneId, scope: tokenScope, days, label } = body.data;
        if (!config.dropZones.some((z) => z.id === zoneId)) {
          return reply.code(404).send({ error: 'unknown zone' });
        }
        const minted = mintMcpToken(
          db,
          { zoneId, scope: tokenScope, days, ...(label ? { label } : {}) },
          now(),
        );
        return { ...minted, zoneId, scope: tokenScope, label: label ?? '' };
      });

      scope.get('/api/control/mcp-tokens', async () => ({ tokens: listMcpTokens(db) }));

      scope.delete<{ Params: { id: string } }>(
        '/api/control/mcp-tokens/:id',
        async (req, reply) => {
          const id = Number(req.params.id);
          if (!Number.isInteger(id) || id <= 0 || !revokeMcpToken(db, id, now())) {
            return reply.code(404).send({ error: 'unknown or revoked token' });
          }
          return { id, revoked: true };
        },
      );
    }

    // The readiness doctor: reads only. One run at a time; a second is refused, not queued.
    const forgesFor = deps.forgesFor;
    if (forgesFor) {
      const env = deps.doctorEnv ?? processEnv();
      scope.post('/api/control/doctor', async (req, reply) => {
        const body = DoctorBody.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const zoneId = body.data.zone;
        if (zoneId !== undefined && !config.dropZones.some((z) => z.id === zoneId)) {
          return reply.code(404).send({ error: 'unknown zone' });
        }
        try {
          const run = await runDoctor(
            {
              db,
              config,
              now,
              env,
              forges: forgesFor,
              ...(deps.readForgeFor ? { readForge: deps.readForgeFor } : {}),
            },
            zoneId !== undefined ? { zoneId } : {},
          );
          return { run };
        } catch (e) {
          if (e instanceof DoctorBusyError) return reply.code(409).send({ error: e.message });
          throw e;
        }
      });
      scope.get('/api/control/doctor', async () => ({ run: latestDoctorRun(db) }));
    }

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
