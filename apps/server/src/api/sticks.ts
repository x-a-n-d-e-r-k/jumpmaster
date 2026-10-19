import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  agentBranch,
  type DropPayload,
  DropResultSchema,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config, DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  appendEvents,
  type Drop,
  getDrop,
  getStickByTokenHash,
  insertStick,
  listWorkItems,
  type Stick,
  updateDrop,
} from '../db/repo.js';
import type { Forge } from '../forge/github.js';
import { heartbeat, leaseNextDrop } from '../leases.js';
import { applyResult } from '../results.js';

export interface StickRouteDeps {
  db: Db;
  config: Config;
  forgeFor(zoneId: string): Forge;
  now(): Date;
  leaseWaitMs?: number;
  leasePollMs?: number;
}

// Same relative depth from src/api (vitest) and dist/api (built): up to apps/, then trooper/.
const template = readFileSync(
  new URL('../../../trooper/prompts/implement.md', import.meta.url),
  'utf8',
);

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** First 12 hex of sha256(prompt template); recorded on every drop. */
export const promptVersion = (): string => sha256(template).slice(0, 12);

export function buildPayload(
  db: Db,
  zone: DropZoneConfig,
  drop: Drop,
  secrets: Config['secrets'],
): DropPayload {
  const item = listWorkItems(db, zone.id).find((w) => w.id === drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);
  const row = db
    .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
    .get(zone.id) as { defaultBranch: string };
  const [owner = '', name = ''] = zone.repo.split('/');
  return {
    protocol: 1,
    dropId: drop.id,
    epoch: drop.epoch,
    role: 'implement',
    repo: { owner, name, defaultBranch: row.defaultBranch },
    issue: { number: item.issueNumber, title: item.title, body: item.body },
    branch: agentBranch(item.issueNumber),
    gates: zone.gates,
    model: zone.model,
    maxTurns: zone.maxTurns,
    promptVersion: promptVersion(),
    prompt: `${template}\n\n## Issue #${item.issueNumber}: ${item.title}\n\n${item.body}`,
    credentials: { claudeToken: secrets.claudeToken, forgeToken: secrets.githubAuthorToken },
  };
}

const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const EnrollBody = z.object({
  joinToken: z.string(),
  name: z.string().min(1),
  slots: z.number().int().min(1),
});
const LeaseBody = z.object({ freeSlots: z.number().int() });
const HeartbeatBody = z.object({ epoch: z.number() });
const EventsBody = z.object({ epoch: z.number(), events: z.array(TrooperEventSchema) });
const ResultBody = z.object({ epoch: z.number(), result: DropResultSchema });

export function registerStickRoutes(app: FastifyInstance, deps: StickRouteDeps): void {
  const { db, config, now } = deps;
  const waitMs = deps.leaseWaitMs ?? 25_000;
  const pollMs = deps.leasePollMs ?? 1000;

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
      if (!safeEqual(body.data.joinToken, config.secrets.joinToken)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const stickId = randomUUID();
      const stickToken = randomBytes(32).toString('hex');
      insertStick(db, {
        id: stickId,
        name: body.data.name,
        tokenHash: sha256(stickToken),
        slots: body.data.slots,
      });
      return { stickId, stickToken };
    });

    scope.post('/api/sticks/lease', async (req, reply) => {
      const stick = authStick(req);
      if (!stick) return reply.code(401).send({ error: 'unauthorized' });
      const body = LeaseBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      if (body.data.freeSlots < 1) return reply.code(204).send();

      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      const deadline = Date.now() + waitMs;
      for (;;) {
        const leased = leaseNextDrop(db, stick.id, now());
        if (leased) {
          const drop = getDrop(db, leased.dropId) as Drop;
          const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
          if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
          return buildPayload(db, zone, drop, config.secrets);
        }
        if (closed || Date.now() + pollMs > deadline) return reply.code(204).send();
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
      return { cancel: out === 'cancel' };
    });

    scope.post<{ Params: { id: string } }>('/api/drops/:id/events', async (req, reply) => {
      const body = EventsBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, req.params.id, body.data.epoch, { requireLive: true });
      if (!drop) return reply;
      appendEvents(db, drop.id, body.data.events);
      return reply.code(204).send();
    });

    scope.post<{ Params: { id: string } }>('/api/drops/:id/result', async (req, reply) => {
      const body = ResultBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, req.params.id, body.data.epoch, { requireLive: true });
      if (!drop) return reply;
      updateDrop(db, drop.id, {
        resultJson: JSON.stringify(body.data.result),
        finishedAt: now().toISOString(),
      });
      await applyResult(db, deps.forgeFor(drop.dropZoneId), drop.id, body.data.result);
      return reply.code(204).send();
    });
  });
}
