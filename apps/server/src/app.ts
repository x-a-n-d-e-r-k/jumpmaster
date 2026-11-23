import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type ControlDeps, registerControlRoutes, stderrSetupMode } from './api/control.js';
import { runningSince } from './api/secrets.js';
import { stickUpgradeView, upgradeTargetOf } from './api/stick-upgrade.js';
import { registerStickRoutes, type StickRouteDeps } from './api/sticks.js';
import { getArtifact, listArtifacts, readArtifact } from './artifacts.js';
import { recordAudit } from './auth/audit.js';
import { Backoff } from './auth/backoff.js';
import { registerGuard, requireCsrf, withCsrf } from './auth/guard.js';
import type { SetupMode } from './auth/operator.js';
import {
  ALL_RULINGS,
  briefingContext,
  floorBriefings,
  getBriefing,
  listBriefings,
  listRulings,
  pendingDiagnoses,
} from './briefings.js';
import { type ChatCard, listCards, settleSettingCard } from './chat/cards.js';
import { type ChatTurnHub, registerChatRoutes, threadIdOf } from './chat/routes.js';
import { getThread, listMessages, listThreads } from './chat/store.js';
import { configReader } from './config/source.js';
import { ConfigStore } from './config/store.js';
import type { Config } from './config.js';
import { creditDropsSince, creditSignal } from './credits.js';
import { listCrewIssues } from './crew/store.js';
import type { Db } from './db/open.js';
import {
  ACTIVE_DROP_STATES,
  type AttemptKey,
  effectiveSlots,
  findWorkItem,
  getAttempts,
  getDrop,
  getGateAllowance,
  getPullRequest,
  getUsageState,
  getWorkItem,
  getZoneMode,
  type InviteKind,
  isKilled,
  latestRateLimitEvent,
  latestVerdict,
  listDrops,
  listEvents,
  listMergesSince,
  listObservations,
  listOutbox,
  listPendingInvites,
  listSticks,
  listUsageWindows,
  listWorkItems,
  liveDropsOn,
  type Stick,
  stickCeiling,
  type WorkItem,
} from './db/repo.js';
import { pagesOf } from './doctor/actions.js';
import type { ChatHealth } from './doctor/checks.js';
import { latestDoctorRun } from './doctor/run.js';
import { fableStatus } from './fable.js';
import type { AppTokenSource } from './forge/app-tokens.js';
import type { Forge } from './forge/github.js';
import { listGoalChanges } from './goal-change.js';
import { getGoals, objectivesDone } from './goals.js';
import { StickFetches } from './images/fetches.js';
import { createInvite, inviteProblem, inviteTtl } from './install/invite.js';
import { type InstallRouteDeps, registerInstallRoutes } from './install/routes.js';
import { cloudInit, installLine } from './install/stick-sh.js';
import { missingFor, zoneRequirements } from './leases.js';
import { registerChatMcpRoute, registerMcpRoute } from './mcp/server.js';
import type { ForgePair } from './outbox.js';
import {
  PUBLIC_URL_NEEDED,
  PUBLIC_URL_PAGE,
  publicOrigin,
  type ReachDeps,
  type TailscaleDeps,
} from './reach.js';
import { AppManifestStore } from './setup/app-manifest-state.js';
import { registerGitHubAppInstalledRoutes } from './setup/github-app-installed.js';
import { registerGitHubAppRoutes } from './setup/github-app-routes.js';
import { buildStatus, projectFails } from './status.js';
import { lastSyncResult } from './sync.js';
import { transcriptPruned } from './transcripts.js';
import { registerAuthPages } from './ui/auth-pages.js';
import { renderChatList, renderThread } from './ui/chat.js';
import { registerConfirmPages } from './ui/confirm.js';
import type { FloorInputs, PendingLine } from './ui/floor.js';
import { githubSectionRenderer } from './ui/github.js';
import { registerGoalConfirmPages } from './ui/goal-confirm.js';
import {
  SYSTEM_HREF,
  SYSTEM_STICKS_ADD_HREF,
  SYSTEM_STICKS_HREF,
  SYSTEM_STICKS_IMAGES_HREF,
} from './ui/links.js';
import {
  ACTIVITY_DROPS_HREF,
  ACTIVITY_HREF,
  ACTIVITY_LOG_HREF,
  ACTIVITY_WORK_HREF,
  type CrewLine,
  DROP_KINDS,
  DROP_LIST_LIMIT,
  DROP_STATES,
  type DropKind,
  type HomeState,
  type ItemDetail,
  LOG_KINDS,
  type LogKind,
  PROJECTS_HREF,
  renderBoard,
  renderBriefing,
  renderDoctor,
  renderDrop,
  renderDropList,
  renderGoals,
  renderHome,
  renderLog,
  renderNewIssue,
  renderWorkItem,
  renderWorkList,
  STORE_NAV,
  STORE_NAV_SLOT,
  type StickLine,
  SYSTEM_STORE_NAV,
  SYSTEM_STORE_NAV_SLOT,
  WORK_STATES,
} from './ui/pages.js';
import { registerRedirects } from './ui/redirects.js';
import { claudeTokenDays, registerSettingsPages } from './ui/settings.js';
import { registerSetupPages, wizardActive } from './ui/setup.js';
import { renderInviteResult, renderStickImages, renderSticks, type StickRow } from './ui/sticks.js';
import { zoneTextNamer } from './ui/zone-name.js';
import { projectHeaderFor, registerZonesPages } from './ui/zones.js';
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
  'base_sync',
];

/** The Floor's gate allowance line: the head Command's allowance covers, and where it came from. */
function gateAllowedOf(
  db: Db,
  itemId: number,
  pr: { number: number; headSha: string } | undefined,
): Pick<ItemDetail, 'gateAllowedSha' | 'gateCarriedFrom'> {
  const a = pr ? getGateAllowance(db, itemId, pr.number, pr.headSha) : undefined;
  if (!a) return {};
  return {
    gateAllowedSha: a.headSha,
    ...(a.carriedFromHead ? { gateCarriedFrom: a.carriedFromHead } : {}),
  };
}

/** Per work item: its PR head, whether Command allowed its gate change, verdict and attempts. */
function itemDetails(db: Db, items: readonly WorkItem[]): Map<number, ItemDetail> {
  const details = new Map<number, ItemDetail>();
  for (const i of items) {
    const v = latestVerdict(db, i.id);
    const pr = getPullRequest(db, i.id);
    details.set(i.id, {
      ...(pr ? { headSha: pr.headSha } : {}),
      ...gateAllowedOf(db, i.id, pr),
      ...(v ? { verdict: { decision: v.decision, forced: v.forced, summary: v.summary } } : {}),
      attempts: Object.fromEntries(ATTEMPT_KEYS.map((k) => [k, getAttempts(db, i.id, k).count])),
    });
  }
  return details;
}

/**
 * The list pages' filters: `zone` among the configured zones, `state` among `states`. A missing
 * parameter stays unset; an unknown one (or a repeated one) is refused, answered 404 as /briefings.
 */
function listFilter<S extends string>(
  query: { zone?: unknown; state?: unknown },
  zones: readonly { id: string }[],
  states: readonly S[],
): { zone?: string; state?: S } | { refuse: string } {
  const { zone, state } = query;
  if (zone !== undefined && !zones.some((z) => z.id === zone)) return { refuse: 'no such zone' };
  if (state !== undefined && !(states as readonly unknown[]).includes(state))
    return { refuse: 'no such state' };
  return {
    ...(typeof zone === 'string' ? { zone } : {}),
    ...(state !== undefined ? { state: state as S } : {}),
  };
}

/**
 * /drops' `issue` filter: a positive integer, written plainly, and only with `zone` (issue numbers
 * are per repository). Unset when absent; refused, answered 404, otherwise.
 */
function issueFilter(
  issue: unknown,
  zone: string | undefined,
): number | undefined | { refuse: string } {
  if (issue === undefined) return undefined;
  if (zone === undefined) return { refuse: 'issue needs zone' };
  if (typeof issue !== 'string' || !/^[1-9]\d*$/.test(issue)) return { refuse: 'bad issue' };
  const n = Number(issue);
  return Number.isSafeInteger(n) ? n : { refuse: 'bad issue' };
}

/** /drops' `kind` filter: one of DROP_KINDS, issue work when absent; refused otherwise. */
function kindFilter(kind: unknown): DropKind | { refuse: string } {
  if (kind === undefined) return 'work';
  return (DROP_KINDS as readonly unknown[]).includes(kind)
    ? (kind as DropKind)
    : { refuse: 'bad kind' };
}

/** The most active drops the floor reads: far above any slot count. */
const FLOOR_DROP_LIMIT = 1000;

/**
 * Merges done in the 24 hours before `at`, each with its item's zone, for the floor's Merged
 * (24h) counts. A failed read leaves `merges24h` out: the floor says "unavailable", not 0.
 */
function floorMerges(db: Db, at: Date): { merges24h?: ReturnType<typeof listMergesSince> } {
  try {
    return { merges24h: listMergesSince(db, new Date(at.getTime() - 24 * 3_600_000)) };
  } catch {
    return {};
  }
}

/**
 * A zone's crew line, on Floor and on its Goals tab (#620): on or off, when its last lead cycle's
 * drop was created, when the next is due by time (null once due), and Fable's status.
 */
function crewLine(db: Db, config: Config, z: Config['dropZones'][number], at: Date): CrewLine {
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
}

/** Fastify instance with stick and UI routes registered; the caller listens. Logger stays off: payloads carry tokens. */
/** The home page's usage section: the gate, the stored state and the credits stop's counts. */
function usageView(db: Db, config: Config, at: Date): NonNullable<HomeState['usage']> {
  const state = getUsageState(db);
  const last = latestRateLimitEvent(db)?.data.overageStatus;
  return {
    gate: dispatchGate(db, config.usage, at),
    state,
    plan: config.claude.plan,
    windows: listUsageWindows(db),
    creditDropsSinceResume:
      state.overageResumedAt === null ? 0 : creditDropsSince(db, state.overageResumedAt),
    overageStatus:
      typeof last === 'string' ? last : (creditSignal(state)?.rateLimit.overageStatus ?? null),
  };
}

const FRAME_ANCESTORS = "frame-ancestors 'none'";
const ROUTES = new WeakMap<FastifyInstance, { method: string; url: string }[]>();

/** The routes an app from `createApp` registered (HEAD included, as Fastify adds it). */
export function routesOf(app: FastifyInstance): { method: string; url: string }[] {
  return [...(ROUTES.get(app) ?? [])];
}

/** A stick as the floor lists it, with the zones it can't run and what it lacks for each. */
function stickLine(s: Stick, config: Config): StickLine {
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    lastSeenAt: s.lastSeenAt,
    capabilities: s.capabilities,
    imagePolicy: s.imagePolicy,
    slots: effectiveSlots(s),
    cannotRun: config.dropZones
      .map((z) => ({ zoneId: z.id, missing: missingFor(s, zoneRequirements(z, config)) }))
      .filter((c) => c.missing.length > 0),
  };
}

/**
 * What the floor's zone cards count, read from the database: shared by the floor and a project's
 * Overview (#616), whose State sentence is its floor card's.
 */
function floorInputs(db: Db, config: Config, at: Date): FloorInputs {
  const floor = floorBriefings(db, config.dropZones);
  return {
    zones: config.dropZones,
    modes: Object.fromEntries(config.dropZones.map((z) => [z.id, getZoneMode(db, z.id, z.mode)])),
    items: config.dropZones.flatMap((z) => listWorkItems(db, z.id)),
    drops: listDrops(db, { states: ACTIVE_DROP_STATES, limit: FLOOR_DROP_LIMIT }),
    ...floorMerges(db, at),
    outbox: listOutbox(db, ['unknown', 'failed']),
    briefings: floor.listed,
    heldBriefings: floor.held,
    sticks: listSticks(db).map((s) => stickLine(s, config)),
  };
}

export function createApp(
  deps: StickRouteDeps & {
    kick?: () => void;
    /** Starts a chat thread's next queued turn; absent, owner messages wait as `queued`. */
    chatTurns?: ChatTurnHub;
    /** The chat service's health, for the doctor (`ChatServiceClient.health`); absent without one. */
    chatHealth?: ChatHealth;
    /** A forge on the read token, for the doctor (absent without `JM_GITHUB_READ_TOKEN`). */
    readForgeFor?: (zoneId: string) => Forge | undefined;
    /** The doctor's forges (requests time out); defaults to `forgesFor`. */
    doctorForgesFor?: (zoneId: string) => ForgePair;
    /** The intake's forges (requests time out); defaults to `forgesFor`. */
    intakeForgesFor?: (zoneId: string) => ForgePair;
    /** The operator's log, scrubbed of secrets (main.ts); MCP's internal errors go here. */
    log?: (msg: string) => void;
    /** The in-memory setup code (main.ts prints the first at start); default prints to stderr. */
    setup?: SetupMode;
    /** Per-source backoff shared by the setup code, the login and sudo. */
    backoff?: Backoff;
    /** The forge detection reads through (tests); default GitHub on the author token. */
    detectForge?: ControlDeps['detectForge'];
    /** The broker detection reads through on the owner's author app (tests); default GitHub's. */
    detectAppBroker?: ControlDeps['detectAppBroker'];
    /** The forge the GitHub guidance reads through (tests); default GitHub. */
    guidanceForge?: ControlDeps['guidanceForge'];
    /** The forge a credential test reads through (tests); default GitHub. */
    credentialForge?: ControlDeps['credentialForge'];
    /** What `/healthz` says; default the release version (`JM_RELEASE_VERSION`), else `dev`. */
    version?: string;
    /** The Check's fetch and the tailscale CLI lookup (tests inject both). */
    reach?: ReachDeps & { tailscale?: TailscaleDeps };
    /** The stick installer's signer and cosign (issue #138); defaults from the environment. */
    install?: Pick<
      InstallRouteDeps,
      'signerRepository' | 'cosignDir' | 'cosignSha256' | 'trustedRootFile'
    >;
    /** Where an invite's code is registered for the log scrub (default the server's set). */
    scrub?: { add(secret: string): void };
    /** The app token source: drops mint from it, and the kill switch clears its cache. */
    appTokens?: Pick<AppTokenSource, 'fresh' | 'clear' | 'provider'>;
    /** The kill switch's installation suspension (§4.2); absent, the kill route is DB-only. */
    appSuspension?: ControlDeps['appSuspension'];
    /** The installation check every mint goes through (issue #267), for the doctor. */
    installationVerifier?: ControlDeps['installationVerifier'];
    /** The installation grant of a zone's role app (issue #457), for the doctor. */
    appGrants?: ControlDeps['appGrants'];
    /** The GitHub App manifest flow's states and pendings (main.ts sweeps it); default a new one. */
    appManifestStore?: AppManifestStore;
    /** The manifest conversion's fetch and API base (tests inject a fake GitHub). */
    appManifestFetch?: typeof globalThis.fetch;
    appManifestApiBase?: string;
  },
): FastifyInstance {
  // Every page reads the config once per request: the store swaps it on each applied revision.
  const live = configReader(deps.config);
  // Behind a TLS terminator on this host (issue #261), `req.ip` is the client the terminator names
  // in X-Forwarded-For, believed only from a loopback peer: the per-source backoff then counts each
  // client apart. Nothing else reads forwarded headers: the guard judges the real Host and Origin.
  // A boot setting, so read once.
  const app = Fastify({
    logger: false,
    ...(live().listen.tlsTerminated === true ? { trustProxy: 'loopback' } : {}),
  });
  // Every route as registered, for the control manifest's test (api/manifest.ts).
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });
  ROUTES.set(app, routes);
  // No page may be framed (issue #260): a same-site page on another port would carry the Strict
  // session cookie into the frame. Every HTML response, error pages included, and any response with
  // a policy of its own (the artifacts route keeps its sandbox) forbids it; nothing else changes.
  app.addHook('onSend', async (_req, reply, payload) => {
    const csp = reply.getHeader('content-security-policy');
    const html = String(reply.getHeader('content-type') ?? '').startsWith('text/html');
    if (!html && csp === undefined) return payload;
    reply.header(
      'content-security-policy',
      csp === undefined ? FRAME_ANCESTORS : `${String(csp)}; ${FRAME_ANCESTORS}`,
    );
    reply.header('x-frame-options', 'DENY');
    return payload;
  });
  /** The request's snapshot (taken by the guard). */
  const cfg = (req: { jmConfig: Config | null }): Config => req.jmConfig ?? live();
  /** Whether a pending change still waits for this request's session (#503). */
  const pendingLiveFor =
    (req: FastifyRequest) =>
    (pendingId: string): boolean => {
      const sid = req.principal?.via === 'session' ? req.principal.sessionId : undefined;
      return (
        sid !== undefined &&
        deps.config instanceof ConfigStore &&
        deps.config.confirmations.pending(pendingId, sid) !== undefined
      );
    };
  /**
   * The request's session's unexpired pending guarded changes, oldest first, each with the chat
   * thread whose pending card links to it (#507). None for any principal but a browser session.
   */
  const pendingLinesFor = (req: FastifyRequest): PendingLine[] => {
    const sid = req.principal?.via === 'session' ? req.principal.sessionId : undefined;
    if (sid === undefined || !(deps.config instanceof ConfigStore)) return [];
    const chatOf = deps.db.prepare(
      `SELECT t.id AS threadId, t.title AS title FROM chat_cards c
         JOIN chat_threads t ON t.id = c.thread_id
        WHERE c.state = 'pending' AND c.link = ? ORDER BY c.id DESC LIMIT 1`,
    );
    return deps.config.confirmations.pendingFor(sid).map((change): PendingLine => {
      const chat = chatOf.get(`/config/confirm/${change.id}`) as
        | { threadId: number; title: string }
        | undefined;
      return chat ? { change, chat } : { change };
    });
  };
  // The login and setup pages post plain HTML forms.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  // Host, Origin, session, CSRF and token: one hook decides for every route (auth/guard.ts).
  registerGuard(app, deps);
  const setup = deps.setup ?? stderrSetupMode(live().listen);
  const backoff = deps.backoff ?? new Backoff();
  registerAuthPages(app, { ...deps, setup, backoff });
  const fetches = deps.fetches ?? new StickFetches();
  registerStickRoutes(app, { ...deps, fetches });
  registerControlRoutes(app, { ...deps, setup, backoff });
  registerMcpRoute(app, deps);
  // The chat service's endpoint (chat tokens only): always on, so the chat needs no setup step.
  registerChatMcpRoute(app, {
    ...deps,
    // A chat action's card goes to its thread's stream as soon as its call commits.
    ...(deps.chatTurns?.publishCard
      ? { onCard: (card: ChatCard) => deps.chatTurns?.publishCard?.(card) }
      : {}),
  });
  // The crew chat's threads (browser sessions only): an owner message waits as `queued` for a turn.
  registerChatRoutes(app, {
    db: deps.db,
    config: deps.config,
    now: deps.now,
    forgesFor: deps.forgesFor,
    ...(deps.config instanceof ConfigStore ? { store: deps.config } : {}),
    ...(deps.chatTurns ? { turns: deps.chatTurns } : {}),
  });
  // The stick installer (issue #138): the script, cosign and the stick image, at publicUrl.
  registerInstallRoutes(app, {
    db: deps.db,
    config: deps.config,
    now: deps.now,
    ...(deps.images ? { images: deps.images } : {}),
    ...(deps.scrub ? { scrub: deps.scrub } : {}),
    ...deps.install,
  });
  // Other machines check the address they reach this server at (issue #139): no auth, any Host,
  // and `{ ok, version }` only: no config, counts or names.
  const version = deps.version ?? (process.env.JM_RELEASE_VERSION || 'dev');
  app.get('/healthz', async (_req, reply) =>
    reply.header('cache-control', 'no-store').send({ ok: true, version }),
  );
  // The owner's confirmation of a goal change (#363): the diff, the passphrase, then the pass merges.
  registerGoalConfirmPages(app, {
    db: deps.db,
    now: deps.now,
    backoff,
    forgesFor: deps.forgesFor,
  });
  // The confirmation page for a session's guarded config change (§7.5): with the store only.
  if (deps.config instanceof ConfigStore) {
    // Every page's navigation gains the store-only pages (Projects, and System's settings pages).
    app.addHook('onSend', async (_req, reply, payload) =>
      typeof payload === 'string' && String(reply.getHeader('content-type')).startsWith('text/html')
        ? payload
            .replace(STORE_NAV_SLOT, STORE_NAV)
            .replace(SYSTEM_STORE_NAV_SLOT, SYSTEM_STORE_NAV)
        : payload,
    );
    registerConfirmPages(app, {
      db: deps.db,
      store: deps.config,
      now: deps.now,
      backoff,
      // A chat's pending setting card becomes done, with its Undo, once its change is confirmed.
      onApplied: (pending, before, after, revision) => {
        const card = settleSettingCard(deps.db, pending.id, before, after, revision);
        if (card) deps.chatTurns?.publishCard?.(card);
      },
    });
    // The setup wizard: thin frames over the secret, zone, config and doctor routes.
    registerSetupPages(app, {
      db: deps.db,
      store: deps.config,
      now: deps.now,
      ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
    });
    // Creating a GitHub App from a manifest (§4.1): start, the github.com callback, and Finish.
    registerGitHubAppRoutes(app, {
      db: deps.db,
      store: deps.config,
      now: deps.now,
      log: deps.log ?? (() => {}),
      manifestStore: deps.appManifestStore ?? new AppManifestStore(),
      ...(deps.appManifestFetch ? { fetch: deps.appManifestFetch } : {}),
      ...(deps.appManifestApiBase ? { apiBase: deps.appManifestApiBase } : {}),
      ...(deps.scrub ? { scrub: deps.scrub } : {}),
    });
    // After an install (§4.1, §4.2): GitHub's setup_url page, and discovery of each zone's ids.
    registerGitHubAppInstalledRoutes(app, {
      store: deps.config,
      log: deps.log ?? (() => {}),
      ...(deps.appBrokers ? { appBrokers: deps.appBrokers } : {}),
      ...(deps.resolvedApps ? { resolvedApps: deps.resolvedApps } : {}),
    });
    // Settings: Credentials (Task 9), Install, MCP tokens and History (Task 13).
    registerSettingsPages(app, {
      db: deps.db,
      store: deps.config,
      now: deps.now,
      runningSince: (since) => runningSince(deps.db, since),
      ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
      ...(deps.reach?.tailscale ? { tailscale: deps.reach.tailscale } : {}),
    });
    // The zones page (Task 11): every zone, a page per zone, and the add page.
    const store = deps.config;
    registerZonesPages(app, {
      db: deps.db,
      store,
      now: deps.now,
      floor: (at) => floorInputs(deps.db, store.current(), at),
      // The Setup tab's GitHub section (#618): the guide, read from GitHub, with each step's status.
      github: githubSectionRenderer({
        store,
        now: deps.now,
        ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
        ...(deps.appTokens ? { appTokens: deps.appTokens } : {}),
      }),
    });
  }
  // The pages that moved (issue #615): each old path answers 301/308 straight to its new one.
  registerRedirects(app);

  // Every stick and its trooper count (issue #136): the count is set through the control route.
  app.get(SYSTEM_STICKS_HREF, async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
    const target = upgradeTargetOf(deps.images, version);
    const html = renderSticks({
      sticks: listSticks(db).map((s): StickRow => {
        const fetching = fetches.get(s.id, deps.now());
        const starting = fetches.starting(s.id, deps.now());
        return {
          ...stickLine(s, config),
          slots: effectiveSlots(s),
          maxSlots: stickCeiling(s),
          reported: s.maxSlots !== null,
          running: liveDropsOn(db, s.id),
          ...(fetching ? { fetching } : {}),
          ...(starting ? { starting } : {}),
          dockerVersion: s.dockerVersion,
          freeBytes: s.freeBytes,
          upgrade: stickUpgradeView(db, s, target),
        };
      }),
      pending: listPendingInvites(db, deps.now()),
      zones: config.dropZones,
      now: deps.now(),
      ...(publicOrigin(config) ? { publicUrl: publicOrigin(config) as string } : {}),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  // The release images the server mirrors for sticks (issue #140), on their own tab (#624).
  app.get(SYSTEM_STICKS_IMAGES_HREF, async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderStickImages(deps.images?.status()))),
  );

  // Add a stick (issue #138): a session with sudo makes a one-time code, shown once on the page
  // this answers with (never cached). A refusal is JSON for the form to show.
  app.post(SYSTEM_STICKS_ADD_HREF, async (req, reply) => {
    const p = req.principal;
    if (!p || !requireCsrf(req, p))
      return reply.code(403).send({ error: 'missing or wrong x-jm-csrf header' });
    if (!p.sudo)
      return reply.code(403).send({
        error: 'adding a stick shows a one-time code, so it needs sudo: re-enter the passphrase',
        sudo: 'required',
      });
    const config = cfg(req);
    const serverUrl = publicOrigin(config);
    if (!serverUrl)
      return reply.code(409).send({
        error: `${PUBLIC_URL_NEEDED} first: System, Server, Other machines (${PUBLIC_URL_PAGE})`,
        settings: PUBLIC_URL_PAGE,
      });
    const body = (req.body ?? {}) as { name?: unknown; slots?: unknown; kind?: unknown };
    const request = {
      name: typeof body.name === 'string' ? body.name : '',
      slots: body.slots === 'auto' ? ('auto' as const) : Number(body.slots),
      // How it will be installed (issue #269): the pasted line by default.
      kind: (body.kind === undefined ? 'line' : String(body.kind)) as InviteKind,
    };
    const at = deps.now();
    const problem = inviteProblem(deps.db, request, at);
    if (problem) return reply.code(400).send({ error: problem });
    const { invite, code } = createInvite(deps.db, request, at, {
      ttlMs: inviteTtl(request.kind),
      ...(deps.scrub ? { scrub: deps.scrub } : {}),
    });
    // The name, never the code (which is scrubbed here too, should it ever reach a field).
    recordAudit(
      deps.db,
      {
        via: p.via,
        action: 'stick.invite',
        target: invite.id,
        detail: {
          name: invite.name,
          slots: invite.slots ?? 'auto',
          kind: invite.kind,
          expiresAt: invite.expiresAt,
        },
      },
      at,
      [code],
    );
    const html = renderInviteResult({
      name: invite.name,
      slots: invite.slots,
      expiresAt: invite.expiresAt,
      ...(invite.kind === 'cloud_init'
        ? { kind: 'cloud_init' as const, cloudInit: cloudInit(serverUrl, code) }
        : { kind: 'line' as const, line: installLine(serverUrl, code) }),
    });
    return reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, html));
  });

  app.get('/', async (req, reply) => {
    const { db, now } = deps;
    const config = cfg(req);
    const at = now();
    const pending = pendingLinesFor(req);
    const html = renderHome({
      setup: {
        // The frame shows until a zone exists or it is dismissed (a store install only).
        active: deps.config instanceof ConfigStore && wizardActive(db, config),
        // "Add a project" lives at the wizard's step until the zones page takes the link over.
        addProject: deps.config instanceof ConfigStore,
      },
      settings: deps.config instanceof ConfigStore,
      status: buildStatus({
        db,
        config,
        ...(deps.config instanceof ConfigStore ? { store: deps.config } : {}),
        now: at,
        pages: pagesOf(app),
        // The floor names zones by repository (#99); `ctl status` keeps the id.
        zoneName: zoneTextNamer(config.dropZones),
        pendingChanges: pending.length,
      }),
      ...(deps.config instanceof ConfigStore
        ? { claudeTokenDays: claudeTokenDays(deps.config, at) }
        : {}),
      ...floorInputs(db, config, at),
      killed: isKilled(db),
      now: at,
      usage: usageView(db, config, at),
      pending,
      doctorFails: projectFails(latestDoctorRun(db)?.checks ?? [], config.dropZones),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  // `/briefings` and `/briefings?zone=` redirect to Home's Needs you and the project (#625).

  // One briefing, open or not, with its rulings: where `Briefing n` and `ctl briefings` link.
  app.get<{ Params: { id: string } }>('/briefings/:id', async (req, reply) => {
    const { db } = deps;
    const id = /^[1-9][0-9]{0,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
    const b = id > 0 ? getBriefing(db, id) : undefined;
    if (!b) return reply.code(404).type('text/plain').send('no such briefing');
    const config = cfg(req);
    const holds = new Map<string, string>();
    for (const c of listCrewIssues(db, b.zoneId, ['promote_held'])) {
      if (c.holdUntil) holds.set(`issue:${c.id}`, c.holdUntil);
    }
    const ctx = briefingContext(db, config.dropZones, [b]);
    const about = ctx.about.get(b.id);
    const keys = ctx.crewKeys.get(b.zoneId);
    const html = renderBriefing({
      briefing: b,
      rulings: listRulings(db, b.zoneId, ALL_RULINGS),
      zones: config.dropZones,
      holds,
      ...(about ? { about } : {}),
      ...(keys ? { crewKeys: keys } : {}),
      pending: pendingDiagnoses(db, config.dropZones, [b], deps.now()).has(b.id),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  // The Activity board (#622): every project's work items in lifecycle columns, or one project's.
  app.get<{ Querystring: { project?: string } }>(ACTIVITY_HREF, async (req, reply) => {
    const { db } = deps;
    const zones = cfg(req).dropZones;
    const project = req.query.project;
    if (project !== undefined && !zones.some((z) => z.id === project))
      return reply.code(404).type('text/plain').send('no such project');
    const shown = zones.filter((z) => project === undefined || z.id === project);
    const items = shown.flatMap((z) => listWorkItems(db, z.id));
    const ids = new Set(items.map((i) => i.id));
    const drops = shown.flatMap((z) =>
      listDrops(db, { zoneId: z.id, states: ACTIVE_DROP_STATES, limit: -1 }),
    );
    const now = deps.now();
    const { merges24h } = floorMerges(db, now);
    const merges = merges24h?.filter((m) => m.workItemId !== null && ids.has(m.workItemId));
    const merged = new Set(merges?.map((m) => m.workItemId));
    const html = renderBoard({
      zones,
      ...(project !== undefined ? { zone: project } : {}),
      items,
      drops,
      ...(merges ? { merges } : {}),
      // Details (attempts, verdict) for the items the board can show: not the older done ones.
      details: itemDetails(
        db,
        items.filter((i) => i.state !== 'done' || merged.has(i.id)),
      ),
      now,
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Querystring: { zone?: string; state?: string } }>(
    ACTIVITY_WORK_HREF,
    async (req, reply) => {
      const { db } = deps;
      const config = cfg(req);
      const f = listFilter(req.query, config.dropZones, ['active', ...WORK_STATES] as const);
      if ('refuse' in f) return reply.code(404).type('text/plain').send(f.refuse);
      const state = f.state ?? 'active';
      const items = config.dropZones
        .filter((z) => f.zone === undefined || z.id === f.zone)
        .flatMap((z) => listWorkItems(db, z.id))
        .filter((i) => (state === 'active' ? i.state !== 'done' : i.state === state));
      const html = renderWorkList({
        zones: config.dropZones,
        ...(f.zone !== undefined ? { zone: f.zone } : {}),
        state,
        items,
        details: itemDetails(db, items),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  // A project's work (#619): its list under the project header, Work current, and each item.
  app.get<{ Params: { id: string }; Querystring: { state?: string } }>(
    `${PROJECTS_HREF}/:id/work`,
    async (req, reply) => {
      const { db } = deps;
      const zones = cfg(req).dropZones;
      const zone = zones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).type('text/plain').send('not found');
      const f = listFilter({ state: req.query.state }, zones, ['active', ...WORK_STATES] as const);
      if ('refuse' in f) return reply.code(404).type('text/plain').send(f.refuse);
      const state = f.state ?? 'active';
      const items = listWorkItems(db, zone.id).filter((i) =>
        state === 'active' ? i.state !== 'done' : i.state === state,
      );
      const html = renderWorkList({
        zones,
        zone: zone.id,
        header: projectHeaderFor(db, zone, zones, 'work'),
        state,
        items,
        details: itemDetails(db, items),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  app.get<{ Params: { id: string; issue: string } }>(
    `${PROJECTS_HREF}/:id/work/:issue`,
    async (req, reply) => {
      const { db } = deps;
      const zones = cfg(req).dropZones;
      const zone = zones.find((z) => z.id === req.params.id);
      const n = issueFilter(req.params.issue, zone?.id);
      const item = zone && typeof n === 'number' ? findWorkItem(db, zone.id, n) : undefined;
      if (!zone || !item) return reply.code(404).type('text/plain').send('not found');
      // SQLite's LIMIT -1 is no limit: the page shows every attempt.
      const drops = listDrops(db, { zoneId: item.dropZoneId, workItemId: item.id, limit: -1 });
      const detail = itemDetails(db, [item]).get(item.id);
      const html = renderWorkItem({
        item,
        zones,
        ...(detail ? { detail } : {}),
        drops,
        now: deps.now(),
        header: projectHeaderFor(db, zone, zones, 'work'),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  app.get<{ Querystring: { zone?: string; state?: string; issue?: string; kind?: string } }>(
    ACTIVITY_DROPS_HREF,
    async (req, reply) => {
      const { db } = deps;
      const config = cfg(req);
      const f = listFilter(req.query, config.dropZones, ['all', 'active', ...DROP_STATES] as const);
      if ('refuse' in f) return reply.code(404).type('text/plain').send(f.refuse);
      const issue = issueFilter(req.query.issue, f.zone);
      if (typeof issue === 'object') return reply.code(404).type('text/plain').send(issue.refuse);
      const kind = kindFilter(req.query.kind);
      if (typeof kind === 'object') return reply.code(404).type('text/plain').send(kind.refuse);
      const state = f.state ?? 'all';
      const item =
        issue === undefined || f.zone === undefined ? undefined : findWorkItem(db, f.zone, issue);
      // An issue without a work item has no drops.
      const found =
        issue !== undefined && item === undefined
          ? []
          : listDrops(db, {
              ...(f.zone !== undefined ? { zoneId: f.zone } : {}),
              ...(item !== undefined ? { workItemId: item.id } : {}),
              ...(kind === 'all' ? {} : { kind }),
              ...(state === 'all'
                ? {}
                : { states: state === 'active' ? ACTIVE_DROP_STATES : [state] }),
              limit: DROP_LIST_LIMIT + 1,
            });
      const html = renderDropList({
        zones: config.dropZones,
        ...(f.zone !== undefined ? { zone: f.zone } : {}),
        ...(issue !== undefined ? { issue } : {}),
        state,
        kind,
        drops: found.slice(0, DROP_LIST_LIMIT),
        items: config.dropZones.flatMap((z) => listWorkItems(db, z.id)),
        limited: found.length > DROP_LIST_LIMIT,
        now: deps.now(),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  app.get<{ Params: { id: string } }>(`${PROJECTS_HREF}/:id/goals`, async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    const now = deps.now();
    const html = renderGoals({
      zone,
      zones: config.dropZones,
      goals: getGoals(db, zone.id),
      crewIssues: listCrewIssues(db, zone.id),
      items: listWorkItems(db, zone.id),
      skippedCrewUnpromoted: lastSyncResult(zone.id)?.skippedCrewUnpromoted ?? [],
      doneByRuling: objectivesDone(db, zone.id),
      goalChanges: listGoalChanges(db, zone.id),
      mode: getZoneMode(db, zone.id, zone.mode),
      openBriefings: listBriefings(db, { zoneId: zone.id, state: 'open' }).length,
      crew: crewLine(db, config, zone, now),
      now,
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Params: { id: string } }>(`${PROJECTS_HREF}/:id/issues/new`, async (req, reply) => {
    const zones = cfg(req).dropZones;
    const zone = zones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    return reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderNewIssue(zone, zones, projectHeaderFor(deps.db, zone, zones))));
  });

  // The crew chat's pages: without the chat service (an older compose file) `/chat` names the
  // one command that adds it.
  app.get('/chat', async (req, reply) =>
    reply.type('text/html; charset=utf-8').send(
      withCsrf(
        req,
        renderChatList(listThreads(deps.db), {
          serviceMissing: deps.chatTurns === undefined,
          zones: cfg(req).dropZones,
          now: deps.now(),
        }),
      ),
    ),
  );

  app.get<{ Params: { id: string } }>('/chat/:id', async (req, reply) => {
    const id = threadIdOf(req.params.id);
    const thread = id === undefined ? undefined : getThread(deps.db, id);
    if (!thread) return reply.code(404).type('text/plain').send('not found');
    return reply.type('text/html; charset=utf-8').send(
      withCsrf(
        req,
        renderThread(thread, listMessages(deps.db, thread.id), listCards(deps.db, thread.id), {
          zones: cfg(req).dropZones,
          now: deps.now(),
          // A pending card's change still waits only while the viewing session can confirm it.
          ...(deps.config instanceof ConfigStore ? { pendingLive: pendingLiveFor(req) } : {}),
        }),
      ),
    );
  });

  // Health (#623): the doctor's latest run, and a store install's zone problems above it.
  app.get(SYSTEM_HREF, async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        withCsrf(
          req,
          renderDoctor(
            latestDoctorRun(deps.db),
            cfg(req).dropZones,
            deps.config instanceof ConfigStore ? deps.config.problems() : undefined,
          ),
        ),
      ),
  );

  // The Log (#621): observe mode's decisions in words and the rulings, newest first. A project's
  // tab and the install-wide page share the renderer; `kind` and `project` refuse what they don't know.
  const logOf = (db: Db, zones: readonly { id: string }[], zoneId?: string) => {
    const shown = zones.filter((z) => zoneId === undefined || z.id === zoneId);
    const issues = new Map(
      shown.flatMap((z) => listWorkItems(db, z.id)).map((i) => [i.id, i.issueNumber]),
    );
    return {
      observations: listObservations(db, zoneId).map((o) => ({
        ...o,
        issueNumber: o.itemId === null ? null : (issues.get(o.itemId) ?? null),
      })),
      rulings: shown.flatMap((z) => listRulings(db, z.id, ALL_RULINGS)),
    };
  };
  const logKind = (kind: unknown): LogKind | undefined =>
    kind === undefined ? 'all' : LOG_KINDS.find((k) => k === kind);

  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    `${PROJECTS_HREF}/:id/log`,
    async (req, reply) => {
      const zones = cfg(req).dropZones;
      const zone = zones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).type('text/plain').send('not found');
      const kind = logKind(req.query.kind);
      if (!kind) return reply.code(404).type('text/plain').send('no such kind');
      const html = renderLog({
        zones,
        zone: zone.id,
        header: projectHeaderFor(deps.db, zone, zones, 'log'),
        kind,
        ...logOf(deps.db, zones, zone.id),
        now: deps.now(),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  app.get<{ Querystring: { project?: string; kind?: string } }>(
    ACTIVITY_LOG_HREF,
    async (req, reply) => {
      const zones = cfg(req).dropZones;
      const project = req.query.project;
      if (project !== undefined && !zones.some((z) => z.id === project))
        return reply.code(404).type('text/plain').send('no such project');
      const kind = logKind(req.query.kind);
      if (!kind) return reply.code(404).type('text/plain').send('no such kind');
      const html = renderLog({
        zones,
        ...(project !== undefined ? { zone: project } : {}),
        kind,
        ...logOf(deps.db, zones, project),
        now: deps.now(),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

  app.get<{ Params: { id: string } }>('/artifacts/:id', async (req, reply) => {
    const row = getArtifact(deps.db, Number(req.params.id));
    if (!row) return reply.code(404).type('text/plain').send('not found');
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .type(row.mediaType)
      .send(readArtifact(cfg(req).dataDir, row));
  });

  app.get<{ Params: { id: string } }>('/drops/:id', async (req, reply) => {
    const drop = getDrop(deps.db, req.params.id);
    if (!drop) return reply.code(404).type('text/plain').send('not found');
    const item = drop.workItemId === null ? undefined : getWorkItem(deps.db, drop.workItemId);
    return reply
      .type('text/html; charset=utf-8')
      .send(
        withCsrf(
          req,
          renderDrop(
            drop,
            listEvents(deps.db, drop.id),
            listArtifacts(deps.db, drop.id),
            transcriptPruned(deps.db, drop.id),
            { ...(item ? { item } : {}), zones: cfg(req).dropZones, now: deps.now() },
          ),
        ),
      );
  });

  return app;
}
