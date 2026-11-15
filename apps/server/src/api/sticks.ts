import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArtifactUploadSchema,
  agentBranch,
  type DropResult,
  DropResultSchema,
  dropSecrets,
  FEATURES_HEADER,
  type LeaseSkip,
  type PushGrant,
  type PushPlan,
  PushResultSchema,
  pushRequestValid,
  type Role,
  SKIPPED_HEADER,
  type StickInfo,
  StickInfoSchema,
  TrooperEventSchema,
} from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { storeArtifact } from '../artifacts.js';
import { recordAudit } from '../auth/audit.js';
import { configReader, type LiveConfig } from '../config/source.js';
import { type Config, type DropZoneConfig, secretList } from '../config.js';
import { noteOverage } from '../credits.js';
import type { Db } from '../db/open.js';
import {
  activeDropFor,
  appendEvents,
  type Drop,
  type DropState,
  getDrop,
  getStickByTokenHash,
  getWorkItem,
  getZoneMode,
  insertStick,
  isKilled,
  isReclaimable,
  killHeldOrRecent,
  latestDropFor,
  markMinted,
  PUSH_RETENTION_MS,
  reserveGrant,
  revokeGrants,
  type Stick,
  stampStick,
  updateDrop,
} from '../db/repo.js';
import { heartbeat, leaseNextDrop, missingFor, zoneRequirements, zonesWaiting } from '../leases.js';
import type { ForgePair } from '../outbox.js';
import { buildPayload, egressFor, ownZoneSecrets } from '../payloads.js';
import { applyResult, applyUsage, type ResultDeps } from '../results.js';
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
/** `noPush`: the stick has no room for another pending push, so it takes no pushing role now. */
const LeaseBody = StickInfoSchema.extend({
  freeSlots: z.number().int(),
  noPush: z.boolean().optional(),
});

const advertOf = (info: StickInfo) => ({
  capabilities: info.capabilities,
  imagePolicy: info.imagePolicy,
  version: info.version ?? null,
  pinnedImages: info.pinnedImages,
});
const HeartbeatBody = z.object({ epoch: z.number() });
const EventsBody = z.object({ epoch: z.number(), events: z.array(TrooperEventSchema) });
const ResultBody = z.object({ epoch: z.number(), result: DropResultSchema });
const PushCallBody = z.object({ dropId: z.string().min(1), epoch: z.number() });
const PushResultBody = z.object({ epoch: z.number(), result: PushResultSchema });

/** The roles whose work a push container pushes. */
const PUSHING_ROLES: readonly Role[] = ['implement', 'heal', 'resolve'];
/** A push container reaches GitHub and nothing else. */
const PUSH_EGRESS = ['github.com'];

const LIVE: readonly DropState[] = ['leased', 'running'];
const PENDING: readonly DropState[] = ['push_pending'];
const STALE = { error: 'stale', stale: true } as const;

type Refusal = { refused: string; retryable: boolean };

/** The result body without its push request, when it has one (to tell a refused push from junk). */
function withoutPush(body: unknown): { body: unknown; hadPush: boolean } {
  if (typeof body !== 'object' || body === null) return { body, hadPush: false };
  const result = (body as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null || !('push' in result)) {
    return { body, hadPush: false };
  }
  const { push: _push, ...rest } = result as Record<string, unknown>;
  return { body: { ...body, result: rest }, hadPush: true };
}

/** What a pending push of this drop may push: the kind its role may ask for, with its SHA. */
function pushKindValid(drop: Drop): boolean {
  switch (drop.pushKind) {
    case 'final':
      return drop.pushExpectSha !== null;
    case 'checkpoint':
    case 'salvage':
      return drop.role !== 'resolve';
    default:
      return false;
  }
}

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

  /** Authenticates and checks the drop belongs to the caller at this epoch, in any state. */
  const ownDrop = (
    req: FastifyRequest,
    reply: FastifyReply,
    dropId: string,
    epoch: number,
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
    if (drop.stickId !== stick.id || drop.epoch !== epoch) {
      reply.code(409).send(STALE);
      return undefined;
    }
    return drop;
  };

  /** `ownDrop`, and the drop is in one of `states` (by default: its lease is live). */
  const liveDrop = (
    req: FastifyRequest,
    reply: FastifyReply,
    dropId: string,
    epoch: number,
    states: readonly DropState[] = LIVE,
  ): Drop | undefined => {
    const drop = ownDrop(req, reply, dropId, epoch);
    if (!drop) return undefined;
    if (!states.includes(drop.state)) {
      reply.code(409).send(STALE);
      return undefined;
    }
    return drop;
  };

  const resultDeps = (config: Config, zone: DropZoneConfig): ResultDeps => ({
    forges: deps.forgesFor(zone.id),
    zone,
    secrets: secretList(config.secrets),
    usageCfg: config.usage,
    rand: deps.rand ?? Math.random,
    claude: config.claude,
  });

  /**
   * What holds every push back for now (retryable): the kill switch, or the zone observing. A
   * paused zone still pushes: pause means its running work finishes, and a push is the end of it.
   */
  const pushHeld = (zoneId: string): Refusal | null => {
    if (isKilled(db)) return { refused: 'killed', retryable: true };
    if (getZoneMode(db, zoneId, 'active') === 'observe') {
      return { refused: 'zone observe', retryable: true };
    }
    return null;
  };

  /**
   * Every check a push grant needs, made afresh (Ruling 20), then the drop's one reservation. Runs
   * in one transaction, so two requests can't both reserve.
   */
  const checkGrant = (
    drop: Drop,
    zone: DropZoneConfig,
    at: Date,
  ): Refusal | { branch: string; base: string } =>
    db.transaction((): Refusal | { branch: string; base: string } => {
      const held = pushHeld(zone.id);
      if (held) return held;
      if (!PUSHING_ROLES.includes(drop.role as Role)) return { refused: 'role', retryable: false };
      const row = db
        .prepare('SELECT repo, default_branch AS base FROM drop_zones WHERE id = ?')
        .get(drop.dropZoneId) as { repo: string; base: string } | undefined;
      if (!row || row.repo !== zone.repo) return { refused: 'repo mismatch', retryable: false };
      if (!pushKindValid(drop)) return { refused: 'kind', retryable: false };
      const item = drop.workItemId === null ? undefined : getWorkItem(db, drop.workItemId);
      if (!item) return { refused: 'branch', retryable: false };
      if (reserveGrant(db, drop.id, drop.epoch, at) === 'reserved') {
        return { refused: 'reserved', retryable: true };
      }
      return { branch: agentBranch(item.issueNumber), base: row.base };
    })();

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
      // Announced on every answer: a stick refuses pushing roles from a server without it.
      reply.header(FEATURES_HEADER, 'push-v1');
      const body = LeaseBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      // A stick that can't run push containers, or has no room for another pending push, gets no
      // pushing role; review, crew and doctor drops still go to it.
      const noPush = body.data.noPush === true || !body.data.capabilities.includes('push-v1');
      const excludeRoles = noPush ? PUSHING_ROLES : [];
      // Every lease call says what the stick can do now, and that it is alive.
      stampStick(db, stick.id, advertOf(body.data), now());
      if (body.data.freeSlots < 1) return reply.code(204).send();
      let closed = false;
      // Not req.raw: IncomingMessage 'close' fires once the body is consumed, not on disconnect.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) closed = true;
      });
      const deadline = Date.now() + waitMs;
      for (;;) {
        const at = now();
        // Each poll reads the config afresh, and judges what the stick can run against it: the
        // payload is built from the config the lease saw.
        const config = live();
        const cannot = incapable(body.data, config);
        const exclude = cannot.map((c) => c.zoneId);
        const leased = leaseNextDrop(
          db,
          stick.id,
          at,
          dispatchGate(db, config.usage, at),
          exclude,
          excludeRoles,
        );
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
      if (out === 'stale') return reply.code(409).send(STALE);
      // `cancel` stays false for `killed`: the push container stops and its volume is kept.
      if (out === 'killed') return { cancel: false, hard: false, killed: true };
      return { cancel: out !== 'ok', hard: out === 'hard_cancel' };
    });

    scope.post<{ Params: { id: string } }>(
      '/api/drops/:id/artifacts',
      { bodyLimit: 8 * 1024 * 1024 },
      async (req, reply) => {
        const body = ArtifactBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const drop = liveDrop(req, reply, req.params.id, body.data.epoch);
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
      const drop = liveDrop(req, reply, req.params.id, body.data.epoch);
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
      let body = ResultBody.safeParse(req.body);
      // A push the schema refuses (salvage from the agent, a final without its SHA) is a refused
      // push request (422), not a malformed body.
      let pushRefused = false;
      if (!body.success) {
        const bare = withoutPush(req.body);
        const rest = ResultBody.safeParse(bare.body);
        if (!bare.hadPush || !rest.success) {
          return reply.code(400).send({ error: 'invalid body' });
        }
        body = rest;
        pushRefused = true;
      }
      const drop = ownDrop(req, reply, req.params.id, body.data.epoch);
      if (!drop) return reply;
      // A repeat of a push-requested result from this stick and epoch (Ruling 13).
      if (drop.state === 'push_pending') return { state: 'push_pending' };
      if (!LIVE.includes(drop.state)) return reply.code(409).send(STALE);
      const result = body.data.result;
      if (pushRefused || !pushRequestValid(result, drop.role as Role)) {
        return reply.code(422).send({ error: 'invalid push request' });
      }
      const config = live();
      const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
      if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
      const at = now();
      const rdeps = resultDeps(config, zone);
      const push = result.push;
      if (push) {
        // The agent's run is over: its usage counts now (the probe is released), and the outcome
        // waits for the push container's result.
        db.transaction(() => {
          updateDrop(db, drop.id, {
            state: 'push_pending',
            resultJson: JSON.stringify(result),
            finishedAt: at.toISOString(),
            pushKind: push.kind,
            pushExpectSha: push.expectSha ?? null,
            pushDeadline: new Date(at.getTime() + PUSH_RETENTION_MS).toISOString(),
          });
          applyUsage(db, rdeps, drop, result, at);
          updateDrop(db, drop.id, { usageApplied: 1 });
        })();
        return { state: 'push_pending' };
      }
      updateDrop(db, drop.id, {
        resultJson: JSON.stringify(result),
        finishedAt: at.toISOString(),
      });
      await applyResult(db, rdeps, drop.id, result, at);
      return reply.code(204).send();
    });

    scope.post('/api/sticks/push-plan', async (req, reply) => {
      const body = PushCallBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, body.data.dropId, body.data.epoch, PENDING);
      if (!drop) return reply;
      const zone = live().dropZones.find((z) => z.id === drop.dropZoneId);
      if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
      const item = drop.workItemId === null ? undefined : getWorkItem(db, drop.workItemId);
      if (!item) return reply.code(500).send({ error: `drop ${drop.id} has no work item` });
      // Refused now rather than at the grant: no push container starts, or stages the branch,
      // only to be turned away. The grant checks again (Ruling 20).
      const held = pushHeld(zone.id);
      if (held) return reply.code(403).send(held);
      // A new attempt: a reservation left by one that died is no longer held against it.
      revokeGrants(db, drop.id, now());
      const egress = egressFor(zone);
      const plan: PushPlan = {
        branch: agentBranch(item.issueNumber),
        salvage: drop.pushKind === 'salvage',
        limits: zone.limits,
        ...(egress ? { egress: { mode: egress.mode, allow: PUSH_EGRESS } } : {}),
      };
      return plan;
    });

    scope.post('/api/sticks/push-token', async (req, reply) => {
      const body = PushCallBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = liveDrop(req, reply, body.data.dropId, body.data.epoch, PENDING);
      if (!drop) return reply;
      const config = live();
      const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
      if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
      const at = now();
      const checked = checkGrant(drop, zone, at);
      if ('refused' in checked) {
        return reply.code(checked.refused === 'reserved' ? 409 : 403).send(checked);
      }
      const { secrets } = config;
      const [owner = '', name = ''] = zone.repo.split('/');
      const gateSecrets = ownZoneSecrets(secrets, zone.id);
      const grant: PushGrant = {
        token: secrets.githubAuthorToken,
        owner,
        name,
        branch: checked.branch,
        base: checked.base,
        // The lease the agent would have pushed with: none for a new branch, the resumed SHA, or
        // the PR head a heal or resolve started from.
        lease: drop.headSha ?? '',
        ...(drop.pushExpectSha !== null ? { expectSha: drop.pushExpectSha } : {}),
        protectedPaths: zone.protectedPaths,
        secrets: [
          ...new Set(
            dropSecrets({
              // The forge token the drop's agent container held (Ruling 1), and the author token.
              forgeToken: secrets.githubReadToken ?? secrets.githubAuthorToken,
              authorToken: secrets.githubAuthorToken,
              claudeToken: secrets.claudeToken,
              ...(gateSecrets ? { gateSecrets } : {}),
            }),
          ),
        ],
      };
      markMinted(db, drop.id, drop.epoch, at);
      // Names and ids only: never the token.
      recordAudit(
        db,
        {
          via: 'system',
          action: 'push-token',
          target: drop.id,
          detail: { drop: drop.id, epoch: drop.epoch, kind: drop.pushKind },
        },
        at,
        secretList(secrets),
      );
      return { grant };
    });

    scope.post<{ Params: { id: string } }>('/api/drops/:id/push-result', async (req, reply) => {
      const body = PushResultBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = ownDrop(req, reply, req.params.id, body.data.epoch);
      if (!drop) return reply;
      const at = now();
      revokeGrants(db, drop.id, at);
      if (drop.state !== 'push_pending') {
        // A retry after a lost response: the drop left push_pending through this epoch's push.
        if (drop.pushKind !== null) return { state: drop.state };
        return reply.code(409).send(STALE);
      }
      const config = live();
      const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
      if (!zone) return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
      let stored: DropResult;
      try {
        stored = DropResultSchema.parse(JSON.parse(drop.resultJson ?? 'null'));
      } catch {
        return reply.code(500).send({ error: `pending push ${drop.id} has no stored result` });
      }
      const r = body.data.result;
      // Nothing was pushed: the stored status, from the last commit that was (Ruling 7).
      const fromPrior: DropResult = { ...stored, headSha: drop.headSha ?? undefined };
      let outcome: DropResult;
      if (r.status === 'pushed' && drop.pushKind === 'final' && r.headSha !== drop.pushExpectSha) {
        // The gates passed on the expected SHA only: any other head is not this drop's work.
        outcome = { ...stored, status: 'failed', reason: 'pushed branch is not the gated commit' };
      } else if (r.status === 'pushed') {
        outcome = { ...stored, headSha: r.headSha };
      } else if (r.status === 'failed' && r.retryable) {
        return { state: 'push_pending' };
      } else if (r.status === 'nothing' && drop.pushKind === 'salvage') {
        // No work to save: lost, and the item requeues as for any lost drop. Its salvage is
        // done, so it is not reclaimable again (no running_at).
        updateDrop(db, drop.id, { state: 'lost', finishedAt: at.toISOString(), runningAt: null });
        return { state: 'lost' };
      } else if (drop.pushKind === 'final') {
        outcome = { ...stored, status: 'failed', reason: r.reason };
      } else {
        outcome = fromPrior;
      }
      await applyResult(db, resultDeps(config, zone), drop.id, outcome, at);
      return { state: getDrop(db, drop.id)?.state };
    });

    scope.post('/api/sticks/salvage', async (req, reply) => {
      const body = PushCallBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const drop = ownDrop(req, reply, body.data.dropId, body.data.epoch);
      if (!drop) return reply;
      const at = now();
      const refused = db.transaction((): string | null => {
        const d = getDrop(db, drop.id) as Drop;
        // Rediscovered as it was left: it continues, and an older attempt's reservation goes.
        if (d.state === 'push_pending') {
          revokeGrants(db, d.id, at);
          return null;
        }
        // Resolve never checkpoints, so it has nothing to salvage.
        if (d.role !== 'implement' && d.role !== 'heal') return 'role';
        const { hard } = db
          .prepare('SELECT hard_cancel AS hard FROM drops WHERE id = ?')
          .get(d.id) as {
          hard: number;
        };
        const reclaimable = isReclaimable(db, d.id, at);
        // A kill-cancelled drop is bounded too: it must still be its item's latest drop on an
        // open item, and the switch on or released within the reclaim window. A volume found
        // days later must not reopen work that has moved on.
        const item = d.workItemId === null ? undefined : getWorkItem(db, d.workItemId);
        const killed =
          d.state === 'cancelled' &&
          hard === 1 &&
          item !== undefined &&
          (item.state === 'in_flight' || item.state === 'pr_open') &&
          latestDropFor(db, item.id)?.id === d.id &&
          killHeldOrRecent(db, at);
        if (!reclaimable && !killed) return 'state';
        if (d.workItemId !== null && activeDropFor(db, d.workItemId)) return 'active drop';
        const synthetic: DropResult = {
          status: 'interrupted',
          role: d.role as Role,
          gates: [],
          reason: 'salvaged',
        };
        updateDrop(db, d.id, {
          state: 'push_pending',
          resultJson: JSON.stringify(synthetic),
          pushKind: 'salvage',
          pushExpectSha: null,
          pushDeadline: new Date(at.getTime() + PUSH_RETENTION_MS).toISOString(),
          usageApplied: 1,
        });
        // The agent container is gone: a later cancel of the pending push is an ordinary one.
        db.prepare('UPDATE drops SET hard_cancel = 0 WHERE id = ?').run(d.id);
        revokeGrants(db, d.id, at);
        return null;
      })();
      if (refused !== null) return reply.code(409).send({ refused });
      return { state: 'push_pending' };
    });
  });
}
