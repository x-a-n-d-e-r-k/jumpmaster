import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArtifactUploadSchema,
  agentBranch,
  type DropResult,
  DropResultSchema,
  dropSecrets,
  FEATURES_HEADER,
  IMAGE_MIRROR_FEATURE,
  ImageFetchSchema,
  isCrewRole,
  isRepoFullName,
  isSafeBranchName,
  type LeaseSkip,
  type PushGrant,
  type PushPlan,
  PushResultSchema,
  pushRequestValid,
  type Role,
  SKIPPED_HEADER,
  SLOTS_HEADER,
  type StickInfo,
  StickInfoSchema,
  StickStartingSchema,
  sha40,
  splitRepoFullName,
  TrooperEventSchema,
  UPGRADE_HEADER,
  type UpgradeOffer,
  UpgradeReportSchema,
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
  autoRequestStickUpgrade,
  type Drop,
  type DropState,
  effectiveSlots,
  enrollFromInvite,
  getDrop,
  getStick,
  getStickByTokenHash,
  getStickUpgrade,
  getWorkItem,
  getZoneMode,
  holdForUpgrade,
  insertStick,
  isKilled,
  isReclaimable,
  killHeldOrRecent,
  latestDropFor,
  liveDropsOn,
  markMinted,
  PUSH_RETENTION_MS,
  reserveGrant,
  revokeGrants,
  type Stick,
  settleStickUpgrade,
  stampStick,
  type UpgradeTarget,
  updateDrop,
  upgradeBehind,
  upgradeEligible,
} from '../db/repo.js';
import { modelFamily } from '../fable.js';
import type { AppBrokers } from '../forge/app-brokers.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { GitHubAppError } from '../forge/github-app.js';
import { createHeldDropTokens, failureOf, type HeldDropTokens } from '../forge/held-tokens.js';
import {
  InstallationCheckError,
  type VerifiedInstallation,
} from '../forge/installation-verifier.js';
import { forgeKind } from '../forge/kind.js';
import type { StickFetches } from '../images/fetches.js';
import type { ImageMirror } from '../images/mirror.js';
import { layoutFor } from '../images/serve.js';
import { codeHash, ENROLL_CODE, INSTALL_TOKEN } from '../install/invite.js';
import {
  type HeldCandidate,
  heartbeat,
  leaseNextDrop,
  missingFor,
  zoneRequirements,
  zonesWaiting,
} from '../leases.js';
import { log as serverLog } from '../log.js';
import type { ForgePair } from '../outbox.js';
import { buildPayload, egressFor, leaseModel, ownZoneSecrets } from '../payloads.js';
import { applyResult, applyUsage, type ResultDeps } from '../results.js';
import {
  dispatchGate,
  heldModelFamilies,
  ingestRateLimit,
  rateLimitFromEvent,
  refundOverrideStart,
} from '../usage.js';
import {
  appInstallationFor,
  credentialFor,
  isAppAuthorZone,
  isAppReviewerZone,
  type ResolvedApps,
} from '../vault/resolution.js';
import { upgradeTargetOf } from './stick-upgrade.js';

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
  /** The image mirror (issue #140); absent, no image is served (and no upgrade offered). */
  images?: Pick<ImageMirror, 'lookup' | 'status'>;
  /**
   * The server's release (`JM_RELEASE_VERSION`), the version sticks are offered (issue #427);
   * default the environment's, else `dev`, which is no release and offers nothing.
   */
  version?: string;
  /** Where the sticks' image downloads are recorded, for /sticks (issue #141). */
  fetches?: StickFetches;
  /**
   * The GitHub App brokers (spec §4.2, issue #224): with them, a zone whose author credential is
   * an app pushes with a contents: write token minted per push. Absent, every push uses the PAT.
   */
  appBrokers?: AppBrokers;
  /** The app entries as they resolved now (`ConfigStore.resolvedApps`); absent, none. */
  resolvedApps?: () => ResolvedApps;
  /**
   * The server's GitHub App token source (spec §4.2, issue #237): with it, a review, crew or doctor
   * drop of an app-reviewer zone clones with a reviewer `contents: read` token minted for the drop
   * alone. Absent, those drops get the read PAT as before.
   */
  appTokens?: Pick<AppTokenSource, 'fresh'>;
  /**
   * Where those per-drop tokens are held until the drop ends (main.ts sweeps it on each
   * lease-expirer tick); absent, the routes keep their own.
   */
  heldReadTokens?: HeldDropTokens;
}

/** `<name>@sha256:<hex>`, the only form an image is asked for by. */
const IMAGE_REF = /^([a-z0-9]+(?:[._-][a-z0-9]+)*)@(sha256:[0-9a-f]{64})$/;

/** A refusal is logged at most this often per stick, zone and reason. */
const SKIP_LOG_MS = 60_000;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A stick enrolls with the join token, or with a one-time code from an invite (issue #138), whose
 * name and trooper count it then takes instead of its own.
 */
const EnrollBody = StickInfoSchema.extend({
  joinToken: z.string().optional(),
  enrollCode: z.string().max(256).optional(),
  name: z.string().min(1),
  slots: z.number().int().min(1),
}).refine((b) => (b.joinToken === undefined) !== (b.enrollCode === undefined));
/**
 * `noPush`: the stick has no room for another pending push, so it takes no pushing role now.
 * `maxSlots`: the most troopers the stick will ever run (an older stick sends none).
 * `slots`: the stick's starting count (`JM_SLOTS`) as it runs now, which refreshes the enrolled
 * one: a stick restarted with a new `JM_SLOTS` keeps it when no desired count is set.
 */
const LeaseBody = StickInfoSchema.extend({
  freeSlots: z.number().int(),
  noPush: z.boolean().optional(),
  maxSlots: z.number().int().min(1).optional(),
  slots: z.number().int().min(1).optional(),
  /** The stick's image download from the mirror (issue #141); `null` once there is none. */
  imageFetch: ImageFetchSchema.nullable().optional(),
  /** The image its first health check is checking (issue #157); `null` once it has a result. */
  starting: StickStartingSchema.nullable().optional(),
  /**
   * Its last upgrade attempt (issue #427). One that fails its schema is dropped, never a 400: an
   * old or confused stick still leases.
   */
  upgrade: UpgradeReportSchema.optional().catch(undefined),
  /** Its engine version and free drop-volume space, for the sticks page (issue #138). */
  health: z
    .object({
      docker: z.string().max(64),
      freeBytes: z.number().int().min(0).nullable(),
    })
    .optional(),
});

const advertOf = (info: StickInfo) => ({
  capabilities: info.capabilities,
  imagePolicy: info.imagePolicy,
  version: info.version ?? null,
  pinnedImages: info.pinnedImages,
});
const HeartbeatBody = z.object({ epoch: z.number() });
/** The largest events batch: the stick posts any event over 1 MiB alone. */
const EVENTS_BODY_LIMIT = 8 * 1024 * 1024;
const EventsBody = z.object({ epoch: z.number(), events: z.array(TrooperEventSchema) });
const ResultBody = z.object({ epoch: z.number(), result: DropResultSchema });
const PushCallBody = z.object({ dropId: z.string().min(1), epoch: z.number() });
const PushResultBody = z.object({ epoch: z.number(), result: PushResultSchema });

/** The roles whose work a push container pushes. */
const PUSHING_ROLES: readonly Role[] = ['implement', 'heal', 'resolve'];
/** A push container reaches GitHub and nothing else. */
const PUSH_EGRESS = ['github.com'];

const LIVE: readonly DropState[] = ['leased', 'running'];
/** The roles that clone with the reviewer's read token (§4.2): never an author's. */
const readsAsReviewer = (role: string): boolean =>
  role === 'review' || role === 'doctor' || isCrewRole(role);
/** The roles whose agent container fetches with the author's read token (§4.2, issue #249). */
const readsAsAuthor = (role: string): boolean =>
  (PUSHING_ROLES as readonly string[]).includes(role);
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

/**
 * The per-model hold of one poll (#747): with some model's own window at the threshold, a queued
 * drop is held when the model buildPayload would resolve for it at lease time is of a held family.
 * Its requested_model is not read: that is written only after the lease. A drop of an unknown zone
 * is not held (the unknown-zone path releases it). Undefined when no family is held.
 */
function modelHeldBy(
  db: Db,
  config: Config,
  now: Date,
): ((drop: HeldCandidate) => boolean) | undefined {
  const held = heldModelFamilies(db, config.usage, now);
  if (held.size === 0) return undefined;
  return (drop) => {
    const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
    if (!zone) return false;
    const family = modelFamily(leaseModel(db, zone, drop, config.claude, now))?.toLowerCase();
    return family !== undefined && held.has(family);
  };
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
  const log = deps.log ?? serverLog;
  const lastLogged = new Map<string, number>();
  const release = deps.version ?? (process.env.JM_RELEASE_VERSION || 'dev');

  /** Whether the mirror has a lock; a read that throws is none, never a failed lease. */
  const mirrorHasLock = (): boolean => {
    try {
      return deps.images?.status().lock === true;
    } catch {
      return false;
    }
  };

  /** What sticks are offered (issue #427): see `upgradeTargetOf`. */
  const upgradeTarget = (): UpgradeTarget | null => upgradeTargetOf(deps.images, release);

  /**
   * The push token each drop was last granted in app mode, so it can be revoked when the drop's
   * reservation is released. In memory only: never in the DB, the vault, an audit row or a log. A
   * token never revoked (restart, cancel, expiry) dies within its hour.
   */
  const heldTokens = new Map<string, { epoch: number; owner: string; token: string }>();
  /** The per-drop reviewer and author read tokens (issues #237, #249), likewise in memory only. */
  const heldReadTokens = deps.heldReadTokens ?? createHeldDropTokens({ log });

  /**
   * The read token minted for this drop alone, held until the drop ends: the reviewer app's for a
   * review, crew or doctor drop of an app-reviewer zone (issue #237), the author app's for an
   * implement, heal or resolve drop of an app-author zone (issue #249). Undefined when the drop
   * fetches as before. Rejects when the mint fails: there is no PAT fallback.
   */
  const dropReadToken = async (zone: DropZoneConfig, drop: Drop): Promise<string | undefined> => {
    if (!deps.appTokens) return undefined;
    const apps = deps.resolvedApps?.() ?? new Map();
    let fresh: Awaited<ReturnType<AppTokenSource['fresh']>>;
    if (readsAsReviewer(drop.role) && isAppReviewerZone(zone, apps))
      fresh = await deps.appTokens.fresh(zone.id, 'reviewer', 'drop-read-reviewer');
    else if (readsAsAuthor(drop.role) && isAppAuthorZone(zone, apps))
      fresh = await deps.appTokens.fresh(zone.id, 'author', 'drop-read-author');
    else return undefined;
    heldReadTokens.hold(drop.id, drop.epoch, fresh);
    return fresh.token;
  };

  /** Revokes the drop's held push token, of any epoch, without waiting and without failing. */
  const revokeHeld = (dropId: string): void => {
    const held = heldTokens.get(dropId);
    if (!held) return;
    heldTokens.delete(dropId);
    const broker = deps.appBrokers?.brokerFor(held.owner, 'author');
    if (!broker) {
      log(
        `push token of drop ${dropId} not revoked: no author app broker (it expires in the hour)`,
      );
      return;
    }
    broker.revoke(held.token).catch((e: unknown) => {
      const why = e instanceof GitHubAppError ? `HTTP ${e.status}` : 'an error';
      log(`revoking the push token of drop ${dropId} failed (${why}); it expires in the hour`);
    });
  };

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
      // Issue #667: a GitLab zone has no push grant until GitLabForge lands; its project path
      // is never made a GitHub remote, whatever its shape.
      if (forgeKind(zone) === 'gitlab') return { refused: 'forge', retryable: false };
      // The grant's owner and name become a git remote: the one name rule (issue #265).
      if (!isRepoFullName(zone.repo)) return { refused: 'repo name', retryable: false };
      if (!pushKindValid(drop)) return { refused: 'kind', retryable: false };
      const item = drop.workItemId === null ? undefined : getWorkItem(db, drop.workItemId);
      if (!item) return { refused: 'branch', retryable: false };
      // Both reach root git in the push container: never an option, a ref name or a range.
      if (!isSafeBranchName(row.base)) return { refused: 'base', retryable: false };
      if (drop.headSha !== null && !sha40.safeParse(drop.headSha).success) {
        return { refused: 'lease', retryable: false };
      }
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

    // Every route but enroll needs a stick's bearer: check it before the body is read, so an
    // unauthenticated client cannot make the server parse an 8 MiB body (issue #644). The
    // handlers still authenticate and check ownership, epoch and state; this only adds a check.
    scope.addHook('onRequest', async (req, reply) => {
      if (req.routeOptions.url === '/api/sticks/enroll') return;
      if (!authStick(req)) return reply.code(401).send({ error: 'unauthorized' });
    });

    scope.post('/api/sticks/enroll', async (req, reply) => {
      const body = EnrollBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const stickId = randomUUID();
      const stickToken = randomBytes(32).toString('hex');
      const { enrollCode, joinToken } = body.data;
      if (enrollCode !== undefined) {
        // The installer's install token (issue #269), or a pending code: looked up by its hash
        // (an equality on a SHA-256, so no timing leaks it); a used, expired, cancelled, spent or
        // unknown one is refused exactly as a wrong join token is.
        const cred = INSTALL_TOKEN.test(enrollCode)
          ? { tokenHash: codeHash(enrollCode) }
          : ENROLL_CODE.test(enrollCode)
            ? { codeHash: codeHash(enrollCode) }
            : undefined;
        const invite = cred
          ? enrollFromInvite(db, cred, now(), {
              id: stickId,
              tokenHash: sha256(stickToken),
              slots: body.data.slots,
              ...advertOf(body.data),
            })
          : undefined;
        if (!invite) return reply.code(401).send({ error: 'unauthorized' });
        if ('nameTaken' in invite) {
          return reply.code(409).send({
            error: `a stick named ${invite.nameTaken} is already enrolled: remove it, or add this stick under another name`,
          });
        }
        return { stickId, stickToken, name: invite.name };
      }
      if (!safeEqual(joinToken ?? '', live().secrets.joinToken)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
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
      // image-mirror-v1 once there is a lock to mirror: a stick with no JM_IMAGE_SOURCE then
      // fetches its images from here (issue #141).
      const features = ['push-v1', ...(mirrorHasLock() ? [IMAGE_MIRROR_FEATURE] : [])];
      reply.header(FEATURES_HEADER, features.join(','));
      /**
       * The trooper count the stick runs at, read afresh (the operator may change it mid-poll) and
       * announced on the answer. True when the stick's live drops already reach it: it is leased
       * nothing, whatever `freeSlots` it asked with, so a lower count holds for an old stick too.
       * 'removed' when the stick is gone or removed (issue #255): the poll answers 401.
       */
      const full = (): boolean | 'removed' => {
        const row = getStick(db, stick.id);
        if (!row) return 'removed';
        const effective = effectiveSlots(row);
        reply.header(SLOTS_HEADER, String(effective));
        return liveDropsOn(db, stick.id) >= effective;
      };
      const unauthorized = () => reply.code(401).send({ error: 'unauthorized' });
      const body = LeaseBody.safeParse(req.body);
      if (!body.success) {
        if (full() === 'removed') return unauthorized();
        return reply.code(400).send({ error: 'invalid body' });
      }
      // A stick that can't run push containers, or has no room for another pending push, gets no
      // pushing role; review, crew and doctor drops still go to it.
      const noPush = body.data.noPush === true || !body.data.capabilities.includes('push-v1');
      const excludeRoles = noPush ? PUSHING_ROLES : [];
      if (body.data.imageFetch !== undefined)
        deps.fetches?.set(stick.id, body.data.imageFetch, now());
      if (body.data.starting !== undefined)
        deps.fetches?.setStarting(stick.id, body.data.starting, now());
      // Every lease call says what the stick can do now, and that it is alive.
      stampStick(db, stick.id, advertOf(body.data), now(), {
        maxSlots: body.data.maxSlots,
        slots: body.data.slots,
        health: body.data.health,
      });
      // The stick's upgrade (issue #427): first its row is settled from what it runs and reports,
      // then an automatic request is made, then the answer is decided (so a lease that reports
      // `refused` gets no offer in its own answer).
      const target = upgradeTarget();
      settleStickUpgrade(db, stick.id, body.data.version ?? null, body.data.upgrade, now());
      if (
        target &&
        live().sticks?.autoUpgrade !== false &&
        upgradeEligible(body.data) &&
        upgradeBehind(body.data.version ?? null, target)
      )
        autoRequestStickUpgrade(db, stick.id, target, now());
      /**
       * The offer, while the stick's row is pending for the current target and it is still
       * eligible: re-read each poll round, so a request made mid-poll ends the poll. Leases it
       * nothing; its running drops go on.
       */
      const offered = (): boolean => {
        const t = upgradeTarget();
        if (!t || !upgradeEligible(body.data)) return false;
        const was = getStickUpgrade(db, stick.id);
        if (!was || was.targetVersion !== t.version || was.image !== t.image) return false;
        const row = holdForUpgrade(db, stick.id, now());
        if (!row) return false;
        const offer: UpgradeOffer = { version: row.targetVersion, image: row.image };
        reply.header(UPGRADE_HEADER, JSON.stringify(offer));
        return true;
      };
      const atStart = full();
      if (atStart === 'removed') return unauthorized();
      if (offered() || atStart || body.data.freeSlots < 1) return reply.code(204).send();
      let closed = false;
      // Not req.raw: IncomingMessage 'close' fires once the body is consumed, not on disconnect.
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) closed = true;
      });
      const deadline = Date.now() + waitMs;
      for (;;) {
        // Re-read each round: a stick removed while this poll waits is leased nothing.
        if (!getStick(db, stick.id)) return unauthorized();
        if (offered()) return reply.code(204).send();
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
          modelHeldBy(db, config, at),
        );
        if (leased) {
          reportSkips(reply, stick, cannot);
          const drop = getDrop(db, leased.dropId) as Drop;
          const zone = config.dropZones.find((z) => z.id === drop.dropZoneId);
          if (!zone) {
            // Release the drop so a misconfigured zone does not strand a lease.
            updateDrop(db, drop.id, { state: 'queued', stickId: null, leaseExpiresAt: null });
            refundOverrideStart(db, leased.overrideUntil, now());
            return reply.code(500).send({ error: `unknown drop zone ${drop.dropZoneId}` });
          }
          let readToken: string | undefined;
          try {
            readToken = await dropReadToken(zone, drop);
          } catch (e) {
            // Back to the queue as an unknown zone's drop goes, unless it moved on meanwhile.
            db.transaction(() => {
              const back = db
                .prepare(
                  `UPDATE drops SET state = 'queued', stick_id = NULL, lease_expires_at = NULL
                   WHERE id = ? AND epoch = ? AND state = 'leased'`,
                )
                .run(drop.id, drop.epoch);
              // The drop never left the server, so neither did its start (#728).
              if (back.changes === 1) refundOverrideStart(db, leased.overrideUntil, now());
            })();
            log(`minting the read token of drop ${drop.id} failed (${failureOf(e)})`);
            return reply.code(503).send({ refused: 'mint failed', retryable: true });
          }
          return buildPayload(db, zone, drop, config.secrets, {
            claude: config.claude,
            now: at,
            ...(readToken ? { readToken } : {}),
          });
        }
        if (closed || Date.now() + pollMs > deadline) {
          reportSkips(reply, stick, cannot);
          return reply.code(204).send();
        }
        await sleep(pollMs);
        // A count lowered while this poll waited holds from the next poll.
        const after = full();
        if (after === 'removed') return unauthorized();
        if (after) {
          reportSkips(reply, stick, cannot);
          return reply.code(204).send();
        }
      }
    });

    // A release image from the server's mirror (issue #140), as an OCI layout tar for one
    // platform, behind the same stick auth as the lease. Only the digests the current or the
    // previous lock names are served; the stick verifies the signatures it carries.
    scope.get<{ Params: { ref: string }; Querystring: { platform?: unknown } }>(
      '/api/sticks/images/:ref/oci.tar',
      async (req, reply) => {
        const stick = authStick(req);
        if (!stick) return reply.code(401).send({ error: 'unauthorized' });
        const platform = req.query.platform;
        if (typeof platform !== 'string' || platform === '')
          return reply.code(400).send({ error: 'platform is required, as os/architecture' });
        const m = IMAGE_REF.exec(req.params.ref);
        if (!m || !deps.images) return reply.code(404).send({ error: 'not in the image lock' });
        const answer = layoutFor(deps.images.lookup(m[1] as string, m[2] as string), platform);
        if (!answer.ok) return reply.code(answer.status).send(answer.body);
        reply.header('etag', answer.etag).header('cache-control', 'no-cache');
        if (req.headers['if-none-match'] === answer.etag) return reply.code(304).send();
        return reply
          .header('content-type', 'application/x-tar')
          .header('content-length', answer.size)
          .send(answer.stream());
      },
    );

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

    // A batch may hold an event of up to 2 MiB, which the stick sends to us whole.
    scope.post<{ Params: { id: string } }>(
      '/api/drops/:id/events',
      { bodyLimit: EVENTS_BODY_LIMIT },
      async (req, reply) => {
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
      },
    );

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
        heldReadTokens.release(drop.id);
        return { state: 'push_pending' };
      }
      updateDrop(db, drop.id, {
        resultJson: JSON.stringify(result),
        finishedAt: at.toISOString(),
      });
      await applyResult(db, rdeps, drop.id, result, at);
      // The drop's work is over: its clone token goes now.
      heldReadTokens.release(drop.id);
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
      revokeHeld(drop.id);
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
      // App mode (§4.2): a contents: write token minted for this push, never the PAT instead.
      let token = secrets.githubAuthorToken;
      let credential: 'app' | 'pat' = 'pat';
      if (deps.appBrokers) {
        const resolution = credentialFor(zone, 'author', deps.resolvedApps?.() ?? new Map());
        if (resolution.ref.kind === 'github-app') {
          credential = 'app';
          const appOwner = resolution.ref.owner;
          const ids = appInstallationFor(zone, 'author');
          if (
            resolution.problem === 'undecryptable' ||
            !ids ||
            !deps.appBrokers.brokerFor(appOwner, 'author')
          ) {
            revokeGrants(db, drop.id, at);
            return reply.code(403).send({ refused: 'app unavailable', retryable: true });
          }
          // Both recorded ids checked against zone.repo before anything mints (issue #267).
          let verified: VerifiedInstallation;
          try {
            verified = await deps.appBrokers.verifiedInstallation(zone, 'author');
          } catch (e) {
            revokeGrants(db, drop.id, at);
            const refused = e instanceof InstallationCheckError && e.refused;
            log(
              `push token of drop ${drop.id} not minted: ${
                e instanceof InstallationCheckError ? e.message : 'the installation check failed'
              }`,
            );
            return reply
              .code(refused ? 403 : 503)
              .send({ refused: 'app unverified', retryable: true });
          }
          const { broker } = verified;
          try {
            const minted = await broker.mint({
              installationId: verified.installationId,
              repositoryId: verified.repositoryId,
              use: 'push',
            });
            token = minted.token;
          } catch (e) {
            revokeGrants(db, drop.id, at);
            const why = e instanceof GitHubAppError ? `HTTP ${e.status}` : 'an error';
            log(`minting the push token of drop ${drop.id} failed (${why})`);
            return reply.code(503).send({ refused: 'mint failed', retryable: true });
          }
          // Released while the mint was in flight (a new attempt, a result): this grant is void.
          const stillReserved = db
            .prepare(
              'SELECT 1 FROM push_tokens WHERE drop_id = ? AND epoch = ? AND revoked_at IS NULL',
            )
            .get(drop.id, drop.epoch);
          if (!stillReserved) {
            broker.revoke(token).catch(() => {
              log(`revoking a void push token of drop ${drop.id} failed; it expires in the hour`);
            });
            return reply.code(503).send({ refused: 'mint failed', retryable: true });
          }
          // A token left from an earlier grant goes before this one is held.
          revokeHeld(drop.id);
          heldTokens.set(drop.id, { epoch: drop.epoch, owner: appOwner, token });
        }
      }
      // checkGrant refused a zone.repo that isn't owner/name, so this split always succeeds.
      const { owner, name } = splitRepoFullName(zone.repo) ?? { owner: '', name: '' };
      const gateSecrets = ownZoneSecrets(secrets, zone.id);
      const grant: PushGrant = {
        token,
        owner,
        name,
        branch: checked.branch,
        base: checked.base,
        // The lease the agent would have pushed with: none for a new branch, the resumed SHA, or
        // the PR head a heal or resolve started from.
        lease: drop.headSha ?? '',
        ...(drop.pushExpectSha !== null ? { expectSha: drop.pushExpectSha } : {}),
        protectedPaths: zone.protectedPaths,
        // Sent only when set, so a trooper from before the field still accepts the grant.
        ...(zone.privateKeyPaths.length > 0 ? { privateKeyPaths: zone.privateKeyPaths } : {}),
        secrets: [
          ...new Set(
            dropSecrets({
              // The forge token the drop's agent container held (Ruling 1), and the author token.
              forgeToken: secrets.githubReadToken ?? secrets.githubAuthorToken,
              authorToken: token,
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
          detail: { drop: drop.id, epoch: drop.epoch, kind: drop.pushKind, credential },
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
      revokeHeld(drop.id);
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
      // After the transaction commits, never inside it: the reservation is gone, so is its token.
      if (refused === null) revokeHeld(drop.id);
      if (refused !== null) return reply.code(409).send({ refused });
      return { state: 'push_pending' };
    });
  });
}
