import Fastify, { type FastifyInstance } from 'fastify';
import { type ControlDeps, registerControlRoutes, stderrSetupMode } from './api/control.js';
import { runningSince } from './api/secrets.js';
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
} from './briefings.js';
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
  getAttempts,
  getDrop,
  getGateAllowance,
  getPullRequest,
  getUsageState,
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
import { latestDoctorRun } from './doctor/run.js';
import { fableStatus } from './fable.js';
import type { AppTokenSource } from './forge/app-tokens.js';
import type { Forge } from './forge/github.js';
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
import { buildStatus } from './status.js';
import { lastSyncResult } from './sync.js';
import { transcriptPruned } from './transcripts.js';
import { registerAuthPages } from './ui/auth-pages.js';
import { registerConfirmPages } from './ui/confirm.js';
import { registerGithubPages } from './ui/github.js';
import {
  type CrewLine,
  DROP_LIST_LIMIT,
  DROP_STATES,
  type HomeState,
  type ItemDetail,
  pageParams,
  renderBriefing,
  renderBriefings,
  renderDoctor,
  renderDrop,
  renderDropList,
  renderGoals,
  renderHome,
  renderIntake,
  renderObservations,
  renderWorkList,
  STORE_NAV,
  STORE_NAV_SLOT,
  type StickLine,
  WORK_STATES,
} from './ui/pages.js';
import { claudeTokenDays, registerSettingsPages } from './ui/settings.js';
import { registerSetupPages, wizardActive } from './ui/setup.js';
import { renderInviteResult, renderSticks, type StickRow } from './ui/sticks.js';
import { zoneTextNamer } from './ui/zone-name.js';
import { registerZonesPages } from './ui/zones.js';
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

/** Per work item: its PR head, whether Command allowed its gate change, verdict and attempts. */
function itemDetails(db: Db, items: readonly WorkItem[]): Map<number, ItemDetail> {
  const details = new Map<number, ItemDetail>();
  for (const i of items) {
    const v = latestVerdict(db, i.id);
    const pr = getPullRequest(db, i.id);
    details.set(i.id, {
      ...(pr ? { headSha: pr.headSha } : {}),
      ...(pr && getGateAllowance(db, i.id, pr.number, pr.headSha)
        ? { gateAllowedSha: pr.headSha }
        : {}),
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

/** The most active drops the floor reads: far above any slot count. */
const FLOOR_DROP_LIMIT = 1000;

/**
 * Merges done in the 24 hours before `at`, each with its item's zone, for the floor's Merged
 * (24h) counts. A failed read leaves `merges24h` out: the floor says "unavailable", not 0.
 */
function floorMerges(db: Db, at: Date): { merges24h?: Array<{ zoneId: string; at: string }> } {
  try {
    return { merges24h: listMergesSince(db, new Date(at.getTime() - 24 * 3_600_000)) };
  } catch {
    return {};
  }
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
    cannotRun: config.dropZones
      .map((z) => ({ zoneId: z.id, missing: missingFor(s, zoneRequirements(z, config)) }))
      .filter((c) => c.missing.length > 0),
  };
}

export function createApp(
  deps: StickRouteDeps & {
    kick?: () => void;
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
    appTokens?: Pick<AppTokenSource, 'fresh' | 'clear'>;
    /** The kill switch's installation suspension (§4.2); absent, the kill route is DB-only. */
    appSuspension?: ControlDeps['appSuspension'];
    /** The installation check every mint goes through (issue #267), for the doctor. */
    installationVerifier?: ControlDeps['installationVerifier'];
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
  registerChatMcpRoute(app, deps);
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
  // The confirmation page for a session's guarded config change (§7.5): with the store only.
  if (deps.config instanceof ConfigStore) {
    // Every page's navigation gains the store-only pages (Zones, Settings).
    app.addHook('onSend', async (_req, reply, payload) =>
      typeof payload === 'string' && String(reply.getHeader('content-type')).startsWith('text/html')
        ? payload.replace(STORE_NAV_SLOT, STORE_NAV)
        : payload,
    );
    registerConfirmPages(app, { db: deps.db, store: deps.config, now: deps.now, backoff });
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
    // The GitHub half of setup for a zone: links and generated files, never a forge write.
    registerGithubPages(app, {
      store: deps.config,
      now: deps.now,
      ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
    });
    // The zones page (Task 11): every zone, a page per zone, and the add page.
    registerZonesPages(app, { db: deps.db, store: deps.config, now: deps.now });
  }

  // Every stick and its trooper count (issue #136): the count is set through the control route.
  app.get('/sticks', async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
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
        };
      }),
      pending: listPendingInvites(db, deps.now()),
      zones: config.dropZones,
      now: deps.now(),
      ...(publicOrigin(config) ? { publicUrl: publicOrigin(config) as string } : {}),
      ...(deps.images ? { images: deps.images.status() } : {}),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  // Add a stick (issue #138): a session with sudo makes a one-time code, shown once on the page
  // this answers with (never cached). A refusal is JSON for the form to show.
  app.post('/sticks/add', async (req, reply) => {
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
        error: `${PUBLIC_URL_NEEDED} first: Settings, Other machines (${PUBLIC_URL_PAGE})`,
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
    const items = config.dropZones.flatMap((z) => listWorkItems(db, z.id));
    const floor = floorBriefings(db, config.dropZones);
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
      }),
      ...(deps.config instanceof ConfigStore
        ? { claudeTokenDays: claudeTokenDays(deps.config, at) }
        : {}),
      zones: config.dropZones,
      killed: isKilled(db),
      modes: Object.fromEntries(config.dropZones.map((z) => [z.id, getZoneMode(db, z.id, z.mode)])),
      items,
      drops: listDrops(db, { states: ACTIVE_DROP_STATES, limit: FLOOR_DROP_LIMIT }),
      now: at,
      usage: usageView(db, config, at),
      ...floorMerges(db, at),
      outbox: listOutbox(db, ['unknown', 'failed']),
      briefings: floor.listed,
      heldBriefings: floor.held,
      sticks: listSticks(db).map((s) => stickLine(s, config)),
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
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  // Every open briefing grouped by project, or one zone's paged (`?zone=`: where the floor's lines
  // and the zone page link, with that zone's bulk dismiss). `per`, `page` and `rpage` never refuse.
  app.get<{ Querystring: { zone?: string; per?: string; page?: string; rpage?: string } }>(
    '/briefings',
    async (req, reply) => {
      const { db } = deps;
      const config = cfg(req);
      const zoneId = typeof req.query.zone === 'string' ? req.query.zone : undefined;
      const zone = zoneId === undefined ? undefined : config.dropZones.find((z) => z.id === zoneId);
      if (zoneId !== undefined && !zone)
        return reply.code(404).type('text/plain').send('no such zone');
      const zones = zone ? [zone] : config.dropZones;
      const holds = new Map<string, string>();
      for (const z of zones) {
        for (const c of listCrewIssues(db, z.id, ['promote_held'])) {
          if (c.holdUntil) holds.set(`issue:${c.id}`, c.holdUntil);
        }
      }
      const open = listBriefings(db, { state: 'open', ...(zone ? { zoneId: zone.id } : {}) });
      const html = renderBriefings({
        open,
        ...briefingContext(db, config.dropZones, open),
        // Every ruling: each project counts its own, and pages or shows its newest `per`.
        rulings: zones.flatMap((z) => listRulings(db, z.id, ALL_RULINGS)),
        zones: config.dropZones,
        holds,
        modes: Object.fromEntries(
          config.dropZones.map((z) => [z.id, getZoneMode(db, z.id, z.mode)]),
        ),
        ...pageParams(req.query),
        ...(zone ? { zone: { id: zone.id, mode: getZoneMode(db, zone.id, zone.mode) } } : {}),
      });
      return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
    },
  );

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
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Querystring: { zone?: string; state?: string } }>('/work', async (req, reply) => {
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
  });

  app.get<{ Querystring: { zone?: string; state?: string } }>('/drops', async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
    const f = listFilter(req.query, config.dropZones, ['all', 'active', ...DROP_STATES] as const);
    if ('refuse' in f) return reply.code(404).type('text/plain').send(f.refuse);
    const state = f.state ?? 'all';
    const found = listDrops(db, {
      ...(f.zone !== undefined ? { zoneId: f.zone } : {}),
      ...(state === 'all' ? {} : { states: state === 'active' ? ACTIVE_DROP_STATES : [state] }),
      limit: DROP_LIST_LIMIT + 1,
    });
    const html = renderDropList({
      zones: config.dropZones,
      ...(f.zone !== undefined ? { zone: f.zone } : {}),
      state,
      drops: found.slice(0, DROP_LIST_LIMIT),
      items: config.dropZones.flatMap((z) => listWorkItems(db, z.id)),
      limited: found.length > DROP_LIST_LIMIT,
      now: deps.now(),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Params: { id: string } }>('/zones/:id/goals', async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    const html = renderGoals({
      zone,
      zones: config.dropZones,
      goals: getGoals(db, zone.id),
      crewIssues: listCrewIssues(db, zone.id),
      items: listWorkItems(db, zone.id),
      skippedCrewUnpromoted: lastSyncResult(zone.id)?.skippedCrewUnpromoted ?? [],
      doneByRuling: objectivesDone(db, zone.id),
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Params: { id: string } }>('/zones/:id/intake', async (req, reply) => {
    const zones = cfg(req).dropZones;
    const zone = zones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, renderIntake(zone, zones)));
  });

  app.get('/doctor', async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderDoctor(latestDoctorRun(deps.db), cfg(req).dropZones))),
  );

  app.get('/observations', async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderObservations(listObservations(deps.db), cfg(req).dropZones))),
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
          ),
        ),
      );
  });

  return app;
}
