import Fastify, { type FastifyInstance } from 'fastify';
import { type ControlDeps, registerControlRoutes, stderrSetupMode } from './api/control.js';
import { registerStickRoutes, type StickRouteDeps } from './api/sticks.js';
import { getArtifact, listArtifacts, readArtifact } from './artifacts.js';
import { Backoff } from './auth/backoff.js';
import { registerGuard, withCsrf } from './auth/guard.js';
import type { SetupMode } from './auth/operator.js';
import { listBriefings, listRulings } from './briefings.js';
import { configReader } from './config/source.js';
import { ConfigStore } from './config/store.js';
import type { Config } from './config.js';
import { creditDropsSince, creditSignal } from './credits.js';
import { listCrewIssues } from './crew/store.js';
import type { Db } from './db/open.js';
import {
  type AttemptKey,
  getAttempts,
  getDrop,
  getGateAllowance,
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
  listSticks,
  listWorkItems,
} from './db/repo.js';
import { latestDoctorRun } from './doctor/run.js';
import { fableStatus } from './fable.js';
import type { Forge } from './forge/github.js';
import { getGoals } from './goals.js';
import { missingFor, zoneRequirements } from './leases.js';
import { registerMcpRoute } from './mcp/server.js';
import type { ForgePair } from './outbox.js';
import { lastSyncResult } from './sync.js';
import { registerAuthPages } from './ui/auth-pages.js';
import { registerConfirmPages } from './ui/confirm.js';
import { registerGithubPages } from './ui/github.js';
import {
  type CrewLine,
  type HomeState,
  type ItemDetail,
  renderBriefings,
  renderDoctor,
  renderDrop,
  renderGoals,
  renderHome,
  renderIntake,
  renderObservations,
  type StickLine,
} from './ui/pages.js';
import { registerSetupPages, wizardActive } from './ui/setup.js';
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
/** The home page's usage section: the gate, the stored state and the credits stop's counts. */
function usageView(db: Db, config: Config, at: Date): NonNullable<HomeState['usage']> {
  const state = getUsageState(db);
  const last = latestRateLimitEvent(db)?.data.overageStatus;
  return {
    gate: dispatchGate(db, config.usage, at),
    state,
    creditDropsSinceResume:
      state.overageResumedAt === null ? 0 : creditDropsSince(db, state.overageResumedAt),
    overageStatus:
      typeof last === 'string' ? last : (creditSignal(state)?.rateLimit.overageStatus ?? null),
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
  },
): FastifyInstance {
  const app = Fastify({ logger: false });
  // Every page reads the config once per request: the store swaps it on each applied revision.
  const live = configReader(deps.config);
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
  registerStickRoutes(app, deps);
  registerControlRoutes(app, { ...deps, setup, backoff });
  registerMcpRoute(app, deps);
  // The confirmation page for a session's guarded config change (§7.5): with the store only.
  if (deps.config instanceof ConfigStore) {
    registerConfirmPages(app, { db: deps.db, store: deps.config, now: deps.now, backoff });
    // The setup wizard: thin frames over the secret, zone, config and doctor routes.
    registerSetupPages(app, {
      db: deps.db,
      store: deps.config,
      now: deps.now,
      ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
    });
    // The GitHub half of setup for a zone: links and generated files, never a forge write.
    registerGithubPages(app, {
      store: deps.config,
      ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
    });
  }

  app.get('/', async (req, reply) => {
    const { db, now } = deps;
    const config = cfg(req);
    const at = now();
    const items = config.dropZones.flatMap((z) => listWorkItems(db, z.id));
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
    const html = renderHome({
      setup: {
        // The frame shows until a zone exists or it is dismissed (a store install only).
        active: deps.config instanceof ConfigStore && wizardActive(db, config),
        // "Add a project" lives at the wizard's step until the zones page takes the link over.
        addProject: deps.config instanceof ConfigStore,
      },
      zones: config.dropZones,
      killed: isKilled(db),
      modes: Object.fromEntries(config.dropZones.map((z) => [z.id, getZoneMode(db, z.id, z.mode)])),
      items,
      drops: listRecentDrops(db),
      lastRateLimit: latestRateLimitEvent(db),
      now: at,
      usage: usageView(db, config, at),
      details,
      outbox: listOutbox(db, ['unknown', 'failed']),
      briefings: listBriefings(db, { state: 'open' }),
      sticks: listSticks(db).map(
        (s): StickLine => ({
          id: s.id,
          name: s.name,
          version: s.version,
          lastSeenAt: s.lastSeenAt,
          capabilities: s.capabilities,
          imagePolicy: s.imagePolicy,
          cannotRun: config.dropZones
            .map((z) => ({ zoneId: z.id, missing: missingFor(s, zoneRequirements(z, config)) }))
            .filter((c) => c.missing.length > 0),
        }),
      ),
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

  app.get('/briefings', async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
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
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Params: { id: string } }>('/zones/:id/goals', async (req, reply) => {
    const { db } = deps;
    const config = cfg(req);
    const zone = config.dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    const html = renderGoals({
      zone,
      goals: getGoals(db, zone.id),
      crewIssues: listCrewIssues(db, zone.id),
      items: listWorkItems(db, zone.id),
      skippedCrewUnpromoted: lastSyncResult(zone.id)?.skippedCrewUnpromoted ?? [],
    });
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, html));
  });

  app.get<{ Params: { id: string } }>('/zones/:id/intake', async (req, reply) => {
    const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
    if (!zone) return reply.code(404).type('text/plain').send('not found');
    return reply.type('text/html; charset=utf-8').send(withCsrf(req, renderIntake(zone)));
  });

  app.get('/doctor', async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderDoctor(latestDoctorRun(deps.db), cfg(req).dropZones))),
  );

  app.get('/observations', async (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(withCsrf(req, renderObservations(listObservations(deps.db)))),
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
          renderDrop(drop, listEvents(deps.db, drop.id), listArtifacts(deps.db, drop.id)),
        ),
      );
  });

  return app;
}
