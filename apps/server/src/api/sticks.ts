import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArtifactUploadSchema,
  DropResultSchema,
  type LeaseSkip,
  SKIPPED_HEADER,
  type StickInfo,
  StickInfoSchema,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { storeArtifact } from '../artifacts.js';
import { configReader, type LiveConfig } from '../config/source.js';
import { type Config, secretList } from '../config.js';
import { noteOverage } from '../credits.js';
import type { Db } from '../db/open.js';
import {
  appendEvents,
  type Drop,
  getDrop,
  getStickByTokenHash,
  insertStick,
  type Stick,
  stampStick,
  updateDrop,
} from '../db/repo.js';
import { heartbeat, leaseNextDrop, missingFor, zoneRequirements, zonesWaiting } from '../leases.js';
import type { ForgePair } from '../outbox.js';
import { buildPayload } from '../payloads.js';
import { applyResult } from '../results.js';
import { dispatchGate, ingestRateLimit, rateLimitFromEvent } from '../usage.js';

const ArtifactBody = ArtifactUploadSchema.extend({ epoch: z.number() });

export interface StickRouteDeps {
  db: Db;
  /** Read per request: a lease builds its payload from the config as it is at that moment. */
  config: LiveConfig;
  forgesFor(zoneId: string): ForgePair;
  now(): Date;
  /** Jitter source for usage pauses; defaults to `Math.random`. */
  rand?: () => number;
  leaseWaitMs?: number;
  leasePollMs?: number;
  /** Starts a pass without waiting for it (a credits stop briefs Command at once). */
  kick?: () => void;
  /** Where a refused lease is logged; defaults to the server's stderr log. */
  log?: (line: string) => void;
}

/** A refusal is logged at most this often per stick, zone and reason. */
const SKIP_LOG_MS = 60_000;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EnrollBody = StickInfoSchema.extend({
  joinToken: z.string(),
  name: z.string().min(1),
  slots: z.number().int().min(1),
});
const LeaseBody = StickInfoSchema.extend({ freeSlots: z.number().int() });

const advertOf = (info: StickInfo) => ({
  capabilities: info.capabilities,
  imagePolicy: info.imagePolicy,
  version: info.version ?? null,
  pinnedImages: info.pinnedImages,
});
const HeartbeatBody = z.object({ epoch: z.number() });
const EventsBody = z.object({ epoch: z.number(), events: z.array(TrooperEventSchema) });
const ResultBody = z.object({ epoch: z.number(), result: DropResultSchema });

export function registerStickRoutes(app: FastifyInstance, deps: StickRouteDeps): void {
  const { db, now } = deps;
  const live = configReader(deps.config);
  const waitMs = deps.leaseWaitMs ?? 25_000;
  const pollMs = deps.leasePollMs ?? 1000;
  // The app runs with Fastify's logger off; the server's own log is stderr.
  const log = deps.log ?? ((line: string) => console.error(`[jumpmaster] ${line}`));
  const lastLogged = new Map<string, number>();

  /** Zones this stick can't run, with what it lacks for each (config order). */
  const incapable = (info: StickInfo, config: Config): LeaseSkip[] =>
    config.dropZones
      .map((zone) => ({
        zoneId: zone.id,
        missing: missingFor(info, zoneRequirements(zone, config)),
      }))
      .filter((s) => s.missing.length > 0);

  /** Names the skipped zones on the response, and logs each refusal at most once a minute. */
  const reportSkips = (reply: FastifyReply, stick: Stick, cannot: LeaseSkip[]) => {
    const waiting = zonesWaiting(
      db,
      cannot.map((c) => c.zoneId),
    );
    const skipped = cannot.filter((c) => waiting.has(c.zoneId));
    if (skipped.length === 0) return;
    reply.header(SKIPPED_HEADER, encodeURIComponent(JSON.stringify(skipped)));
    const at = Date.now();
    for (const s of skipped) {
      const key = `${stick.id}\n${s.zoneId}\n${s.missing.join(',')}`;
      const last = lastLogged.get(key);
      if (last !== undefined && at - last < SKIP_LOG_MS) continue;
      lastLogged.set(key, at);
      log(
        `lease: stick ${stick.id} ${JSON.stringify(stick.name)} skipped zone ${s.zoneId}: it lacks ${s.missing.join(', ')}`,
      );
    }
  };

  const authStick = (req: FastifyRequest): Stick | undefined => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    return m?.[1] ? getStickByTokenHash(db, sha256(m[1])) : undefined;
  };

  /** Authenticates, checks the drop belongs to the caller, and the lease is live with this epoch. */
  const liveDrop = (
    req: FastifyRequest,
    reply: FastifyReply,
    dropId: string,
    epoch: number,
    opts: { requireLive: boolean },
  ): Drop | undefined => {
    const stick = authStick(req);
    if (!stick) {
      reply.code(401).send({ error: 'unauthorized' });
      return undefined;
    }
    const drop = getDrop(db, dropId);
    if (!drop) {
      reply.code(404).send({ error: 'unknown drop' });
      return undefined;
    }
    const live = drop.state === 'leased' || drop.state === 'running';
    if (drop.stickId !== stick.id || drop.epoch !== epoch || (opts.requireLive && !live)) {
      reply.code(409).send({ error: 'stale' });
      return undefined;
    }
    return drop;
  };

  app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (req.headers['x-jumpmaster-protocol'] !== '1') {
        return reply.code(426).send({ error: 'unsupported protocol version' });
      }
    });

    scope.post('/api/sticks/enroll', async (req, reply) => {
      const body = EnrollBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      if (!safeEqual(body.data.joinToken, live().secrets.joinToken)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const stickId = randomUUID();
      const stickToken = randomBytes(32).toString('hex');
      insertStick(db, {
        id: stickId,
        name: body.data.name,
        tokenHash: sha256(stickToken),
        slots: body.data.slots,
        ...advertOf(body.data),
      });
      return { stickId, stickToken };
    });

    scope.post('/api/sticks/lease', async (req, reply) => {
      const stick = authStick(req);
      if (!stick) return reply.code(401).send({ error: 'unauthorized' });
      const body = LeaseBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      // Every lease call says what the stick can do now, and that it is alive.
      stampStick(db, stick.id, advertOf(body.data), now());
      if (body.data.freeSlots < 1) return reply.code(204).send();
      const cannot = incapable(body.data, live());
      const exclude = cannot.map((c) => c.zoneId);

      let closed = false;
      // Not req.raw: IncomingMessage 'close' fires once the body is consumed, not on disconnect.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) closed = true;
      });
      const deadline = Date.now() + waitMs;
      for (;;) {
        const at = now();
        // Each poll reads the config afresh: the payload is built from the one the lease saw.
        const config = live();
        const leased = leaseNextDrop(db, stick.id, at, dispatchGate(db, config.usage, at), exclude);
        if (leased) {
          reportSkips(reply, stick, cannot);
          const drop = getDrop(db, leased.dropId) as Drop;
          const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
          if (!zone) {
            // Release the drop so a misconfigured zone does not strand a lease.
            updateDrop(db, drop.id, { state: 'queued', stickId: null, leaseExpiresAt: null });
            return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
          }
          return buildPayload(db, zone, drop, config.secrets, { claude: config.claude, now: at });
        }
        if (closed || Date.now() + pollMs > deadline) {
          reportSkips(reply, stick, cannot);
          return reply.code(204).send();
        }
        await sleep(pollMs);
      }
    });

    scope.post<{ Params: { id: string } }>('/api/drops/:id/heartbeat', async (req, reply) => {
      const stick = authStick(req);
      if (!stick) return reply.code(401).send({ error: 'unauthorized' });
      const body = HeartbeatBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const out = heartbeat(db, req.params.id, stick.id, body.data.epoch, now());
      if (out === 'stale') return reply.code(409).send({ error: 'stale' });
      return { cancel: out !== 'ok', hard: out === 'hard_cancel' };
    });

    scope.post<{ Params: { id: string } }>(
      '/api/drops/:id/artifacts',
      { bodyLimit: 8 * 1024 * 1024 },
      async (req, reply) => {
        const body = ArtifactBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const drop = liveDrop(req, reply, req.params.id, body.data.epoch, { requireLive: true });
        if (!drop) return reply;
        const bytes = Buffer.from(body.data.dataBase64, 'base64');
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (hash !== body.data.sha256) return reply.code(400).send({ error: 'hash mismatch' });
        try {
          storeArtifact(db, live().dataDir, drop.id, { ...body.data, bytes });
        } catch (e) {
          return reply.code(400).send({ error: e instanceof Error ? e.message : 'refused' });
        }
        return reply.code(204).send();
      },
    );

    scope.post<{ Params: { id: string } }>('/api/drops/:id/events', async (req, reply) => {
      const body = EventsBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, req.params.id, body.data.epoch, { requireLive: true });
      if (!drop) return reply;
      appendEvents(db, drop.id, body.data.events);
      const config = live();
      let stopped = false;
      for (const ev of body.data.events) {
        if (ev.kind !== 'rate_limit') continue;
        const data = rateLimitFromEvent(ev.data);
        if (!data) continue;
        // First, whatever else the report means (a Fable limit returns early below).
        const at = now();
        const ts = Date.parse(ev.ts);
        const reportedAt = Number.isFinite(ts) ? new Date(Math.min(ts, at.getTime())) : at;
        if (noteOverage(db, config.usage, drop, data, null, at, reportedAt)) stopped = true;
        ingestRateLimit(
          db,
          data,
          {
            dropId: drop.id,
            workItemId: drop.workItemId,
            startedAt: drop.startedAt,
            outcome: null,
          },
          config.usage,
          now(),
          deps.rand ?? Math.random,
        );
      }
      if (stopped) deps.kick?.();
      return reply.code(204).send();
    });

    scope.post<{ Params: { id: string } }>('/api/drops/:id/result', async (req, reply) => {
      const body = ResultBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, req.params.id, body.data.epoch, { requireLive: true });
      if (!drop) return reply;
      const config = live();
      const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
      if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
      const at = now();
      updateDrop(db, drop.id, {
        resultJson: JSON.stringify(body.data.result),
        finishedAt: at.toISOString(),
      });
      await applyResult(
        db,
        {
          forges: deps.forgesFor(zone.id),
          zone,
          secrets: secretList(config.secrets),
          usageCfg: config.usage,
          rand: deps.rand ?? Math.random,
          claude: config.claude,
        },
        drop.id,
        body.data.result,
        at,
      );
      return reply.code(204).send();
    });
  });
}
