import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { PRESETS, redact, validAllowEntry } from '@jumpmaster/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditDetail, recordAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import type { Principal } from '../auth/guard.js';
import {
  deleteOperator,
  MAX_PASSPHRASE,
  operatorHash,
  passphraseProblem,
  ScryptBusyError,
  SETUP_CODE_WHERE,
  SetupMode,
  setOperatorPassphrase,
  setupActive,
  setupCodeLine,
  verifyPassphrase,
} from '../auth/operator.js';
import { grantSudo } from '../auth/sessions.js';
import { listBacklog, queueIssue } from '../backlog.js';
import {
  briefingContext,
  dismissZoneBriefings,
  effectText,
  listBriefings,
  optionsDigest,
  ruleBriefing,
} from '../briefings.js';
import { mergeConfigPatch, mergePatch } from '../config/diff.js';
import { configReader, type LiveConfig, statusOf } from '../config/source.js';
import { type ApplyResult, ConfigStore } from '../config/store.js';
import { type Config, mcpConfigOf, secretList } from '../config.js';
import { requestCrewCycle } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import {
  ACTIVE_STATES_SQL,
  activeWorkCount,
  appendEvents,
  cancelStickInvite,
  clearZoneStopping,
  effectiveSlots,
  findStick,
  getDrop,
  getWorkItem,
  getZoneMode,
  insertDrop,
  isKilled,
  listPendingInvites,
  listSticks,
  liveDropsOn,
  removeStick,
  revokeGrants,
  setStickDesiredSlots,
  setWorkItemState,
  setZoneMode,
  stickCeiling,
  updateDrop,
  ZONE_MODES,
  zoneHistoryCounts,
  zoneStopping,
  zoneWaits,
} from '../db/repo.js';
import { pagesOf } from '../doctor/actions.js';
import {
  type DoctorDeps,
  type DoctorEnv,
  doctorDropWait,
  egressSeen,
  labelsCheckOn,
  wantedLabels,
} from '../doctor/checks.js';
import { DoctorBusyError, latestDoctorRun, processEnv, runDoctor } from '../doctor/run.js';
import {
  appInstallationsOf,
  type SuspensionResult,
  suspendAll,
  unsuspendAll,
} from '../forge/app-suspension.js';
import type { AppTokenSource } from '../forge/app-tokens.js';
import { type Forge, GitHubForge } from '../forge/github.js';
import type { GitHubAppBroker } from '../forge/github-app.js';
import type { HeldDropTokens } from '../forge/held-tokens.js';
import type { InstallationVerifier } from '../forge/installation-verifier.js';
import type { ImageMirror } from '../images/mirror.js';
import { fileIntakeIssue, GoalStubSchema, IntakeIssueSchema, renderGoalStub } from '../intake.js';
import { engageKill, expireLeases, releaseKill } from '../leases.js';
import {
  listMcpTokens,
  MAX_TOKEN_DAYS,
  MCP_SCOPES,
  mintMcpToken,
  revokeMcpToken,
} from '../mcp/tokens.js';
import { type ForgePair, runOp } from '../outbox.js';
import {
  checkReach,
  PUBLIC_URL_NEEDED,
  PUBLIC_URL_PAGE,
  publicUrlProblem,
  type ReachDeps,
} from '../reach.js';
import { buildStatus } from '../status.js';
import {
  exportDropJsonl,
  exportDropsJsonl,
  exportWindow,
  withNewlines,
  zoneDropIds,
  zoneRecorded,
} from '../transcripts.js';
import { safeNext } from '../ui/auth-pages.js';
import { MODE_LABELS } from '../ui/pages.js';
import { credentialCreatedAt, shadowedCredentials, type TestDeps } from '../vault/credentials.js';
import type { AppRole } from '../vault/github-app-entries.js';
import type { ResolvedApps } from '../vault/resolution.js';
import {
  type DetectForge,
  type Detection,
  detectFailure,
  detectRepo,
  NO_AUTHOR,
  REPO,
  zoneIdOf,
} from '../zones/detect.js';
import { removalNote, stopZone } from '../zones/stop.js';

export { detectFailure } from '../zones/detect.js';

import type { ZoneGuidance } from '../github/guidance.js';
import {
  type GuidanceForge,
  githubGuidanceForge,
  guidanceFor,
  registerGuidanceRoutes,
} from './github.js';
import {
  type ActionCtx,
  type ActionResult,
  applyOutcome,
  configPatchAction,
  crewCycleAction,
  ruleAction,
  zoneModeAction,
} from './operator-actions.js';
import { registerSecretRoutes } from './secrets.js';

/** A stick's trooper count: an integer of 1 or more (the ceiling is checked against the stick). */
const SlotsBody = z.object({ slots: z.number().int().min(1) });

/** The issue "Work on it" queues: a positive issue number. */
const QueueBody = z.object({ issue: z.number().int().positive() });

export interface ControlDeps {
  db: Db;
  /** Read per request (the config store in the server). */
  config: LiveConfig;
  now(): Date;
  /** Starts a pass without waiting for it, so a ruling applies promptly. */
  kick?: () => void;
  /** The zone's forges, for the doctor's reads (it never writes). Absent: no doctor routes. */
  forgesFor?(zoneId: string): ForgePair;
  /**
   * The intake's forges: they write (one create_issue through the outbox per submission), and
   * their requests time out, so a stalled forge is a 502, not a hang. Defaults to `forgesFor`.
   */
  intakeForgesFor?(zoneId: string): ForgePair;
  /** The doctor's own forges, whose requests time out; defaults to `forgesFor`. */
  doctorForgesFor?(zoneId: string): ForgePair;
  /** A forge on the read token, when one is configured. */
  readForgeFor?(zoneId: string): Forge | undefined;
  /** This process as the doctor sees it (default: read from the process). */
  doctorEnv?: DoctorEnv;
  /** The image mirror, for the doctor's `server.image-mirror` (issue #140). */
  images?: Pick<ImageMirror, 'status'>;
  /** The in-memory setup code, shared with the setup pages (default: one printing to stderr). */
  setup?: SetupMode;
  /** Per-source backoff for passphrase guesses, shared with the login page. */
  backoff?: Backoff;
  /** A forge on a token, for the credential tests on entry (default: GitHub with a deadline). */
  credentialForge?: TestDeps['forge'];
  /** The forge detection reads through, on the author token (default: GitHub, timed out). */
  detectForge?(repo: string, token: string): DetectForge;
  /** The forge the GitHub guidance reads through; an empty token reads anonymously (tests). */
  guidanceForge?(repo: string, token: string): GuidanceForge;
  /** The operator's log (scrubbed); the secret routes never write a value to it. */
  log?: (msg: string) => void;
  /** How the Check reaches `<publicUrl>/healthz` (tests inject a fetch). */
  reach?: ReachDeps;
  /**
   * The kill switch's installation suspension (§4.2): engaging suspends each zone's recorded
   * GitHub App installation, releasing unsuspends it. Absent, the kill route is DB-only.
   */
  appSuspension?: {
    apps: () => ResolvedApps;
    brokerFor(owner: string, role: AppRole): GitHubAppBroker | undefined;
    timeoutMs?: number;
  };
  /**
   * The server's GitHub App token cache (issue #266): engaging the kill switch empties it, and a
   * mint in flight then is neither cached nor handed to a later caller.
   */
  appTokens?: Pick<AppTokenSource, 'clear'>;
  /** The per-drop read tokens (issue #237): the kill switch revokes the cancelled drops' at once. */
  heldReadTokens?: Pick<HeldDropTokens, 'sweep'>;
  /** The app entries as they resolved now, for the doctor's app-reviewer zones (issue #237). */
  resolvedApps?: () => ResolvedApps;
  /**
   * The installation check every mint goes through (issue #267); the doctor's `forge.author` and
   * `forge.reviewer` fail a zone whose recorded ids it refuses.
   */
  installationVerifier?: InstallationVerifier;
}

/** A setup mode whose codes go to stderr, alone on their line (main.ts passes its own). */
export function stderrSetupMode(listen: Config['listen']): SetupMode {
  return new SetupMode((code) => process.stderr.write(`${setupCodeLine(code, listen)}\n`));
}

/** A zone's generated GitHub files, or undefined when GitHub can't be read just now. */
function guidanceReader(
  store: ConfigStore,
  config: Config,
  forgeOf: ((repo: string, token: string) => GuidanceForge) | undefined,
  now: () => Date,
): (zoneId: string) => Promise<ZoneGuidance | undefined> {
  return async (zoneId) => {
    const zone = config.dropZones.find((z) => z.id === zoneId);
    if (!zone) return undefined;
    const r = await guidanceFor(store, config, zone, forgeOf ?? githubGuidanceForge, { now });
    return r.ok ? r.guidance : undefined;
  };
}

/** What the doctor's credential checks read from the store (Task 4). */
function credentialsOf(store: ConfigStore): NonNullable<DoctorDeps['credentials']> {
  const resolved = store.resolved();
  const vault = store.vault();
  const created = credentialCreatedAt('claudeToken', resolved, store.current().claude);
  const keyFile = store.vaultKeyFile();
  return {
    problems: store.problems(),
    shadowed: shadowedCredentials(resolved, vault),
    vaultKey: vault === 'disabled' ? { status: 'disabled' } : vault.keyStatus(),
    ...(keyFile ? { vaultKeyFile: keyFile } : {}),
    ...(created ? { claudeTokenCreatedAt: created } : {}),
    install: {
      claudeToken: resolved.claudeToken.source !== 'missing',
      githubAuthorToken: resolved.githubAuthorToken.source !== 'missing',
    },
  };
}

const DoctorBody = z.strictObject({ zone: z.string().min(1).optional() });
const ExtendRetentionBody = z.object({ hours: z.number().int().min(1).max(168) }).strict();

const DoctorDropBody = z.strictObject({
  zone: z.string().min(1),
  cancel: z.literal(true).optional(),
});

const ZoneBody = z.object({ mode: z.enum(ZONE_MODES) });
/** The ids of the zone's briefings Command was shown and confirmed dismissing. */
const DismissBody = z.object({ ids: z.array(z.number().int().positive()).max(5000) });
const RuleBody = z.object({
  optionId: z.string().min(1),
  note: z.string().max(2000).optional(),
  /** The option set the ruler saw (from the page or `ctl briefings`). */
  optionsDigest: z.string().max(64).optional(),
});
const KillBody = z.object({ engaged: z.boolean() });
const PassphraseBody = z.strictObject({ passphrase: z.string().max(4 * MAX_PASSPHRASE) });
const SudoBody = z.object({
  passphrase: z
    .string()
    .max(4 * MAX_PASSPHRASE)
    .optional(),
});
const MintBody = z.strictObject({
  zoneId: z.string().min(1),
  scope: z.enum(MCP_SCOPES),
  days: z.number().int().min(1).max(MAX_TOKEN_DAYS),
  label: z.string().max(80).optional(),
});

export function tokenMatches(req: FastifyRequest, expected: string): boolean {
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

/**
 * Operator routes. The guard (`auth/guard.ts`) decides who reaches them: the operator token or a
 * browser session with its CSRF header, after the Host and Origin checks, because a container can
 * reach the host's loopback. Every mutating handler records a `control_audit` row from named fields.
 *
 * Every route here is listed in `api/manifest.ts` with the `ctl` invocation that reaches it; a test
 * fails when a route is added without its entry (or its verb).
 */
export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { db, now } = deps;
  const live = configReader(deps.config);
  /** The request's snapshot (taken by the guard), so a handler that awaits sees one revision. */
  const cfg = (req: FastifyRequest): Config => req.jmConfig ?? live();
  const setup = deps.setup ?? stderrSetupMode(live().listen);
  const backoff = deps.backoff ?? new Backoff();
  // The scrub list: the request's snapshot (the secrets before a rotation it made), the secrets
  // now (after it) and every value a rotation retired while this process ran.
  const scrubList = (req: FastifyRequest): string[] => {
    const store = deps.config instanceof ConfigStore ? deps.config : undefined;
    return [
      ...new Set([
        ...secretList(cfg(req).secrets),
        // Only a store rotates credentials while a request runs.
        ...(store ? [...secretList(store.current().secrets), ...store.retired()] : []),
      ]),
    ];
  };
  const audit = (req: FastifyRequest, action: string, detail: AuditDetail, target?: string) =>
    recordAudit(
      db,
      {
        via: req.principal?.via ?? 'token',
        action,
        ...(target === undefined ? {} : { target }),
        detail,
      },
      now(),
      scrubList(req),
    );
  /** The shared actions' context for this request: its principal, snapshot and scrub list. */
  const actx = (req: FastifyRequest): ActionCtx => {
    if (!req.principal) throw new Error('a control route was reached without a principal');
    return {
      db,
      now,
      config: cfg(req),
      principal: req.principal,
      secrets: scrubList(req),
      ...(deps.kick ? { kick: deps.kick } : {}),
    };
  };
  /**
   * Suspends (engaging) or unsuspends (releasing) every zone's recorded app installation, each
   * within its deadline; undefined when there is none to call (PAT mode, or no `appSuspension`).
   * A failure is logged once per installation by owner, role, id and status alone.
   */
  const suspendInstallations = async (
    req: FastifyRequest,
    engaged: boolean,
  ): Promise<SuspensionResult | undefined> => {
    const s = deps.appSuspension;
    if (!s) return undefined;
    const list = appInstallationsOf(cfg(req).dropZones, s.apps());
    if (list.length === 0) return undefined;
    const brokerFor = (owner: string, role: AppRole) => s.brokerFor(owner, role);
    const o = s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs };
    const r = engaged
      ? await suspendAll(list, brokerFor, o)
      : await unsuspendAll(list, brokerFor, o);
    const verb = engaged ? 'suspending' : 'unsuspending';
    for (const f of r.failed)
      deps.log?.(
        `kill switch: ${verb} the ${f.role} app installation ${f.installationId} of ${f.owner} failed (status ${f.status})`,
      );
    return r;
  };
  /** Routes for `ctl` alone: a session is refused, whatever its sudo. */
  const tokenOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.principal?.via === 'token') return true;
    void reply
      .code(403)
      .send({ error: 'this needs the operator token: run it with jumpmaster ctl' });
    return false;
  };

  void app.register(async (scope) => {
    // The guard sets the principal; without one (the guard not registered) nothing gets through.
    scope.addHook('onRequest', async (req, reply) => {
      if (!req.principal) return reply.code(401).send({ error: 'unauthorized' });
    });

    // Sudo: a session re-enters the passphrase to write a credential for five minutes. The token is
    // always sudo, since whoever holds it holds the secrets directory.
    scope.post('/api/control/sudo', async (req, reply) => {
      const p = req.principal;
      if (p?.via === 'token') return { sudo: true, until: null };
      const c = backoff.check(req.ip, now());
      if (!c.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(Math.ceil(c.retryAfterMs / 1000)))
          .send({ error: 'too many wrong passphrases from here: wait and try again' });
      }
      const body = SudoBody.safeParse(req.body ?? {});
      const stored = operatorHash(db);
      const given = body.success ? body.data.passphrase : undefined;
      // Charged before the check (one scrypt run per source at a time); reset when right.
      backoff.fail(req.ip, now());
      let right = false;
      try {
        right =
          p?.sessionId !== undefined &&
          stored !== null &&
          given !== undefined &&
          (await verifyPassphrase(given, stored));
      } catch (e) {
        if (!(e instanceof ScryptBusyError)) throw e;
        return reply.code(503).header('retry-after', '1').send({ error: e.message });
      }
      // A passphrase changed during the wait ended every session, this one included.
      if (!right || !p?.sessionId || operatorHash(db) !== stored) {
        audit(req, 'sudo', { result: 'refused' });
        return reply.code(401).send({ error: 'wrong passphrase' });
      }
      backoff.reset(req.ip);
      const until = grantSudo(db, p.sessionId, now());
      audit(req, 'sudo', { result: 'granted', until });
      return { sudo: true, until };
    });

    // Recovery: the operator row and every session go, and a new setup code is printed.
    scope.post('/api/control/setup/reopen', async (req, reply) => {
      if (!tokenOnly(req, reply)) return reply;
      deleteOperator(db);
      setup.clear();
      setup.rotateSetupCode();
      audit(req, 'setup.reopen', { result: 'reopened' });
      return {
        setup: 'open',
        next: `a new setup code is on ${SETUP_CODE_WHERE}`,
      };
    });

    // A fresh setup code, printed on the server's stderr: never returned to the caller.
    scope.post('/api/control/setup/code', async (req, reply) => {
      if (!tokenOnly(req, reply)) return reply;
      if (!setupActive(db)) {
        return reply.code(409).send({
          error: 'setup is complete: log in, or run jumpmaster ctl setup reopen to start over',
        });
      }
      setup.rotateSetupCode();
      audit(req, 'setup.code', { result: 'printed' });
      return {
        printed: true,
        next: `the new setup code is on ${SETUP_CODE_WHERE}`,
      };
    });

    // Claims a headless install or replaces the passphrase; every session ends either way.
    scope.put('/api/control/passphrase', async (req, reply) => {
      if (!tokenOnly(req, reply)) return reply;
      const body = PassphraseBody.safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ error: 'invalid body: {"passphrase": "…"}' });
      const problem = passphraseProblem(body.data.passphrase);
      if (problem) return reply.code(400).send({ error: problem });
      let set: Awaited<ReturnType<typeof setOperatorPassphrase>>;
      try {
        set = await setOperatorPassphrase(db, body.data.passphrase, now());
      } catch (e) {
        if (!(e instanceof ScryptBusyError)) throw e;
        return reply.code(503).header('retry-after', '1').send({ error: e.message });
      }
      const { result: operator, sessionsDeleted } = set;
      setup.clear();
      audit(req, 'passphrase.set', { result: operator, sessionsDeleted });
      return { operator, sessionsDeleted };
    });

    scope.post<{ Params: { id: string } }>('/api/control/zones/:id', async (req, reply) => {
      const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      const body = ZoneBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid mode' });
      const r = zoneModeAction(actx(req), zone.id, body.data.mode);
      if (!r.ok) return sendFailure(reply, r);
      return { zone: zone.id, mode: r.value.mode };
    });

    // Dismisses the zone's open briefings Command was shown (issue #98), each recorded as one
    // dismissal. No ruling: nothing is ruled, promoted, rejected or closed, on the forge or here.
    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/briefings/dismiss',
      async (req, reply) => {
        const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
        if (!zone) return reply.code(404).send({ error: 'unknown zone' });
        const body = DismissBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const dismissed = dismissZoneBriefings(db, zone.id, body.data.ids, now());
        for (const id of dismissed) {
          audit(req, 'briefing.dismiss', { zone: zone.id, bulk: true }, `briefing:${id}`);
        }
        return { zone: zone.id, dismissed };
      },
    );

    // Each stick's trooper counts (issue #136), for `ctl sticks`.
    scope.get('/api/control/sticks', async () => ({
      sticks: listSticks(db).map((s) => ({
        id: s.id,
        name: s.name,
        slots: effectiveSlots(s),
        enrolledSlots: s.slots,
        desiredSlots: s.desiredSlots,
        maxSlots: stickCeiling(s),
        running: liveDropsOn(db, s.id),
        lastSeenAt: s.lastSeenAt,
      })),
    }));

    // How many troopers a stick runs at once, applied on its next lease answer, no restart. Up to
    // the ceiling it reported (its enrolled count for a stick too old to report one).
    scope.post<{ Params: { id: string } }>('/api/control/sticks/:id/slots', async (req, reply) => {
      const stick = findStick(db, req.params.id);
      if (stick === 'ambiguous')
        return reply
          .code(409)
          .send({ error: `several sticks are named ${req.params.id}: name it by its id` });
      if (!stick) return reply.code(404).send({ error: 'unknown stick' });
      const body = SlotsBody.safeParse(req.body);
      if (!body.success)
        return reply.code(400).send({ error: 'slots must be an integer of 1 or more' });
      const { slots } = body.data;
      const ceiling = stickCeiling(stick);
      if (slots > ceiling)
        return reply.code(400).send({
          error: `stick ${stick.name} allows up to ${ceiling} trooper${ceiling === 1 ? '' : 's'} at once: to allow more, set JM_MAX_SLOTS on that machine and restart the stick`,
        });
      const old = effectiveSlots(stick);
      setStickDesiredSlots(db, stick.id, slots);
      audit(req, 'stick.slots', { old, new: slots }, stick.id);
      return {
        id: stick.id,
        slots: effectiveSlots({ ...stick, desiredSlots: slots }),
        maxSlots: ceiling,
      };
    });

    /** A session needs sudo to add, cancel or remove a stick (issue #138); the token always has it. */
    const stickSudo = (req: FastifyRequest, reply: FastifyReply, what: string): boolean => {
      if (req.principal?.via !== 'session' || req.principal.sudo) return true;
      void reply.code(403).send({
        error: `${what} needs sudo: re-enter the passphrase`,
        sudo: 'required',
      });
      return false;
    };

    // Cancels an invite whose stick has not checked in: its code stops working at once.
    scope.post<{ Params: { id: string } }>(
      '/api/control/sticks/invites/:id/cancel',
      async (req, reply) => {
        if (!stickSudo(req, reply, 'cancelling an invite')) return reply;
        const at = now();
        const pending = listPendingInvites(db, at).filter(
          (i) => i.id === req.params.id || i.name === req.params.id,
        );
        if (pending.length === 0) return reply.code(404).send({ error: 'no pending invite' });
        const invite = cancelStickInvite(db, (pending[0] as { id: string }).id, at);
        if (!invite) return reply.code(404).send({ error: 'no pending invite' });
        audit(req, 'stick.invite_cancel', { name: invite.name }, invite.id);
        return { id: invite.id, name: invite.name, cancelled: true };
      },
    );

    // Removes a stick: its token is revoked (its next request is a 401), and its leased drops that
    // never started are requeued through the lost-stick path.
    scope.post<{ Params: { id: string } }>('/api/control/sticks/:id/remove', async (req, reply) => {
      if (!stickSudo(req, reply, 'removing a stick')) return reply;
      const stick = findStick(db, req.params.id);
      if (stick === 'ambiguous')
        return reply
          .code(409)
          .send({ error: `several sticks are named ${req.params.id}: name it by its id` });
      if (!stick) return reply.code(404).send({ error: 'unknown stick' });
      const at = now();
      // A racing remove may have committed since findStick: then this one removed nothing.
      if (!removeStick(db, stick.id, at)) return reply.code(404).send({ error: 'unknown stick' });
      expireLeases(db, at, cfg(req).usage);
      audit(req, 'stick.remove', { name: stick.name }, stick.id);
      return { id: stick.id, name: stick.name, removed: true };
    });

    // What Jumpmaster is doing and why it waits (§10.3): the home banner's line, for `ctl status`.
    scope.get('/api/control/status', async (req) =>
      buildStatus({
        db,
        config: cfg(req),
        ...(deps.config instanceof ConfigStore ? { store: deps.config } : {}),
        now: now(),
        pages: pagesOf(app),
      }),
    );

    // Open briefings with their option ids, for `ctl rule` without the UI.
    // With what each is about, the evidence and what each option does (#226): it reads on its own.
    scope.get('/api/control/briefings', async (req) => {
      const open = listBriefings(db, { state: 'open' });
      const { about } = briefingContext(db, cfg(req).dropZones, open);
      return {
        briefings: open.map((b) => ({
          id: b.id,
          zone: b.zoneId,
          kind: b.kind,
          subject: b.subject,
          decision: b.decision,
          options: b.options.map((o) => ({
            id: o.id,
            label: o.label,
            effectText: effectText(b.kind, o.effect),
          })),
          optionsDigest: optionsDigest(b),
          about: about.get(b.id) ?? { text: b.subject },
          why: b.why,
          recommendation: b.recommendation,
          onHold: b.onHold,
        })),
      };
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
        const { optionId, note, optionsDigest: seen } = body.data;
        const r = ruleAction(actx(req), id, optionId, note ?? '', {
          ...(seen ? { optionsDigest: seen } : {}),
        });
        if (!r.ok) return sendFailure(reply, r);
        return { briefing: id, rulingId: r.value.rulingId };
      },
    );

    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/crew-cycle',
      async (req, reply) => {
        const r = crewCycleAction(actx(req), req.params.id);
        if (!r.ok) return sendFailure(reply, r);
        return { zone: req.params.id, crewCycle: r.value.crewCycle };
      },
    );

    // The backlog: open issues Jumpmaster has not touched, read as the zone's author identity.
    scope.get<{ Params: { id: string } }>('/api/control/zones/:id/backlog', async (req, reply) => {
      const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      if (!deps.forgesFor)
        return reply.code(503).send({ error: 'this server has no forge to read the backlog from' });
      try {
        return { zone: zone.id, issues: await listBacklog(deps.forgesFor(zone.id).author, zone) };
      } catch (e) {
        const error = `reading the backlog failed: ${(e as Error).message}`;
        return reply.code(502).send({ error: redact(error, scrubList(req)) });
      }
    });

    // "Work on it": the zone's ready label on one backlog issue, through the outbox.
    scope.post<{ Params: { id: string } }>('/api/control/zones/:id/queue', async (req, reply) => {
      const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      if (!deps.forgesFor)
        return reply.code(503).send({ error: 'this server has no forge to label through' });
      const body = QueueBody.safeParse(req.body ?? {});
      if (!body.success)
        return reply.code(400).send({ error: 'invalid body: issue must be a number' });
      const { issue } = body.data;
      const r = await queueIssue(db, deps.forgesFor(zone.id), zone, issue, now());
      if (!r.ok) return reply.code(r.status).send({ error: redact(r.error, scrubList(req)) });
      audit(req, 'zone.queue', { issue, opKey: r.opKey }, zone.id);
      deps.kick?.();
      return { zone: zone.id, issue, label: zone.readyLabel };
    });

    // MCP tokens: minted only here, the plain token returned once; registered only with mcp on.
    // The value is shown, so a session mints only with sudo (the passphrase re-entered within five
    // minutes), as for a credential; the token is always sudo. List and revoke show no value.
    if (mcpConfigOf(live()).enabled) {
      scope.post('/api/control/mcp-tokens', async (req, reply) => {
        if (req.principal?.via === 'session' && !req.principal.sudo)
          return reply.code(403).send({
            error: 'an MCP token is shown once, so minting one needs sudo: re-enter the passphrase',
            sudo: 'required',
          });
        const body = MintBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid body' });
        const { zoneId, scope: tokenScope, days, label } = body.data;
        if (!cfg(req).dropZones.some((z) => z.id === zoneId)) {
          return reply.code(404).send({ error: 'unknown zone' });
        }
        const minted = mintMcpToken(
          db,
          { zoneId, scope: tokenScope, days, ...(label ? { label } : {}) },
          now(),
        );
        audit(req, 'mcp-token.mint', { id: minted.id, scope: tokenScope, days }, zoneId);
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
          audit(req, 'mcp-token.revoke', { id });
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
        if (zoneId !== undefined && !cfg(req).dropZones.some((z) => z.id === zoneId)) {
          return reply.code(404).send({ error: 'unknown zone' });
        }
        const configStatus = statusOf(deps.config);
        const credentials =
          deps.config instanceof ConfigStore ? credentialsOf(deps.config) : undefined;
        try {
          const run = await runDoctor(
            {
              db,
              config: cfg(req),
              now,
              env,
              forges: deps.doctorForgesFor ?? forgesFor,
              ...(deps.readForgeFor ? { readForge: deps.readForgeFor } : {}),
              ...(deps.resolvedApps ? { resolvedApps: deps.resolvedApps } : {}),
              ...(deps.installationVerifier
                ? {
                    verifiedInstallation: (
                      ...a: Parameters<InstallationVerifier['verifiedInstallation']>
                    ) => deps.installationVerifier!.verifiedInstallation(...a),
                  }
                : {}),
              ...(configStatus ? { configStatus } : {}),
              ...(credentials ? { credentials } : {}),
              ...(deps.reach ? { reach: (u: string) => checkReach(u, deps.reach) } : {}),
              ...(deps.images
                ? { imageMirror: () => deps.images?.status() ?? { lock: false, images: [] } }
                : {}),
              // The pages this app registers decide where the fix links go.
              pages: pagesOf(app),
              // The zone's generated GitHub files, for the fix links that bring one along.
              ...(deps.config instanceof ConfigStore
                ? { guidance: guidanceReader(deps.config, cfg(req), deps.guidanceForge, now) }
                : {}),
            },
            zoneId !== undefined ? { zoneId } : {},
          );
          audit(req, 'doctor.run', { runId: run.id }, zoneId);
          return { run };
        } catch (e) {
          if (e instanceof DoctorBusyError) return reply.code(409).send({ error: e.message });
          throw e;
        }
      });
      scope.get('/api/control/doctor', async () => ({ run: latestDoctorRun(db) }));

      // The doctor's label action (forge.labels): the configured labels that are missing,
      // created as the author bot through the outbox. Allowed in observe (it touches no issue),
      // refused while killed, audited either way, then forge.labels runs again.
      scope.post<{ Params: { id: string } }>(
        '/api/control/zones/:id/labels',
        async (req, reply) => {
          const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
          if (!zone) return reply.code(404).send({ error: 'unknown zone' });
          if (isKilled(db)) {
            audit(req, 'labels.create', { result: 'refused: killed' }, zone.id);
            return reply.code(409).send({ error: 'the kill switch is engaged: no forge write' });
          }
          const forges = (deps.intakeForgesFor ?? forgesFor)(zone.id);
          const at = now();
          let created: string[];
          try {
            const r = await runOp(
              db,
              forges,
              {
                kind: 'create_labels',
                // One op per request: each request looks again, by name.
                opKey: `create_labels:${zone.id}:${randomUUID()}`,
                zoneId: zone.id,
                itemId: null,
                payload: { labels: wantedLabels(zone) },
              },
              at,
              { allowInObserve: true },
            );
            if (r.state !== 'done') {
              audit(req, 'labels.create', { result: `failed: ${r.state}` }, zone.id);
              return reply
                .code(502)
                .send({ error: `GitHub did not create the labels (${r.state})` });
            }
            created = ((r.result as { created?: string[] } | undefined)?.created ?? []).slice();
          } catch (e) {
            audit(req, 'labels.create', { result: 'refused' }, zone.id);
            // Fixed strings today (killed, a vanished row); scrubbed anyway, as audit rows are.
            return reply.code(409).send({ error: redact((e as Error).message, scrubList(req)) });
          }
          audit(
            req,
            'labels.create',
            { result: created.length > 0 ? `created: ${created.join(', ')}` : 'none missing' },
            zone.id,
          );
          const check = await labelsCheckOn(zone, forges.author);
          return { created, check };
        },
      );
    }

    // A doctor drop spends a turn of usage, so it runs only on request, one per zone, and is
    // refused rather than queued where nothing would lease it.
    scope.post('/api/control/doctor/drop', async (req, reply) => {
      const body = DoctorDropBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid body: {"zone": "<id>"}' });
      const zone = cfg(req).dropZones.find((z) => z.id === body.data.zone);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      // Cancel: only a queued doctor drop, which nothing has started (a running one finishes).
      if (body.data.cancel) {
        const mine = db
          .prepare(
            `SELECT id, state FROM drops WHERE drop_zone_id = ? AND role = 'doctor'
               AND state IN (${ACTIVE_STATES_SQL})`,
          )
          .get(zone.id) as { id: string; state: string } | undefined;
        if (!mine) return reply.code(404).send({ error: `no doctor drop is queued in ${zone.id}` });
        if (mine.state !== 'queued')
          return reply.code(409).send({
            error: `doctor drop ${mine.id} is already ${mine.state === 'leased' ? 'leased' : 'running'} on a stick; it finishes on its own`,
          });
        const done = db
          .prepare(
            "UPDATE drops SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'",
          )
          .run(now().toISOString(), mine.id);
        if (done.changes === 0)
          return reply.code(409).send({ error: `doctor drop ${mine.id} has just started` });
        audit(req, 'doctor.drop-cancel', { dropId: mine.id }, zone.id);
        return { dropId: mine.id, zone: zone.id, state: 'cancelled' };
      }
      if (isKilled(db))
        return reply.code(409).send({
          error: 'the kill switch is engaged, so no drop would run: jumpmaster ctl unkill first',
        });
      const mode = getZoneMode(db, zone.id, zone.mode);
      if (mode !== 'active')
        return reply.code(409).send({
          error: `zone ${zone.id} is ${mode === 'observe' ? 'in observe mode' : mode}, so no drop would run: jumpmaster ctl resume ${zone.id} first`,
        });
      const active = db
        .prepare(
          `SELECT id, state FROM drops WHERE drop_zone_id = ? AND role = 'doctor'
             AND state IN (${ACTIVE_STATES_SQL})`,
        )
        .get(zone.id) as { id: string; state: string } | undefined;
      if (active)
        return reply
          .code(409)
          .send({ error: `doctor drop ${active.id} is already ${active.state} in ${zone.id}` });
      const dropId = randomUUID();
      insertDrop(
        db,
        { id: dropId, dropZoneId: zone.id, workItemId: null, role: 'doctor', state: 'queued' },
        now(),
      );
      audit(req, 'doctor.drop', { dropId }, zone.id);
      deps.kick?.();
      const waiting = doctorDropWait(db, cfg(req), zone, now());
      return reply.code(202).send({
        dropId,
        zone: zone.id,
        state: 'queued',
        waiting,
        next: `It runs when a stick can take it (${waiting}). Then: jumpmaster ctl doctor ${zone.id}`,
      });
    });

    // A pending push (state push_pending) holds a volume on the stick until its deadline. The
    // operator can give it more time or give it up; both act on push_pending alone.
    scope.post<{ Params: { id: string } }>(
      '/api/control/drops/:id/extend-retention',
      async (req, reply) => {
        const body = ExtendRetentionBody.safeParse(req.body);
        if (!body.success)
          return reply.code(400).send({ error: 'invalid body: {"hours": 1..168}' });
        const { hours } = body.data;
        const at = now();
        const out = db.transaction(() => {
          const drop = getDrop(db, req.params.id);
          if (!drop) return { code: 404 as const, error: 'unknown drop' };
          if (drop.state !== 'push_pending' || drop.pushDeadline === null)
            return {
              code: 409 as const,
              error: `drop ${drop.id} is ${drop.state}, not a pending push: only a pending push has a retention to extend`,
            };
          const pushDeadline = new Date(
            Date.parse(drop.pushDeadline) + hours * 3_600_000,
          ).toISOString();
          updateDrop(db, drop.id, { pushDeadline });
          return { code: 200 as const, dropId: drop.id, pushDeadline };
        })();
        if (out.code !== 200) return reply.code(out.code).send({ error: out.error });
        audit(req, 'extend-retention', { dropId: out.dropId, hours }, out.dropId);
        return { dropId: out.dropId, pushDeadline: out.pushDeadline };
      },
    );

    // Transcript export (issue #195): a drop's stored events, or a zone's drops' in a window, as
    // JSONL. Transcripts hold private code: operator only, and each export is audited. Both routes
    // stream the lines of `exportDropJsonl`, never the whole export as one string.
    const ndjson = (reply: FastifyReply, lines: Iterable<string>) =>
      reply
        .header('content-type', 'application/x-ndjson; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(Readable.from(withNewlines(lines)));
    scope.get<{ Params: { id: string } }>(
      '/api/control/drops/:id/transcript',
      async (req, reply) => {
        const drop = getDrop(db, req.params.id);
        if (!drop) return reply.code(404).send({ error: 'unknown drop' });
        audit(req, 'transcript-export', { dropId: drop.id }, drop.id);
        return ndjson(reply, exportDropJsonl(db, drop.id));
      },
    );
    scope.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
      '/api/control/zones/:id/transcripts',
      async (req, reply) => {
        const zone = req.params.id;
        if (!cfg(req).dropZones.some((z) => z.id === zone) && !zoneRecorded(db, zone))
          return reply.code(404).send({ error: 'unknown zone' });
        const w = exportWindow(req.query ?? {}, now());
        if ('error' in w) return reply.code(400).send({ error: w.error });
        const ids = zoneDropIds(db, zone, w.since, w.until);
        audit(
          req,
          'transcript-export',
          { zone, since: w.since, until: w.until, drops: ids.length },
          zone,
        );
        return ndjson(reply, exportDropsJsonl(db, ids));
      },
    );

    // Cancel a pending push (Ruling 16): the drop is cancelled and its grants revoked, so the stick
    // learns it from the heartbeat and removes its volume. An implement item goes back to ready
    // (as for a lost drop); a heal or resolve item stays pr_open.
    scope.post<{ Params: { id: string } }>('/api/control/drops/:id/cancel', async (req, reply) => {
      const at = now();
      const out = db.transaction(() => {
        const drop = getDrop(db, req.params.id);
        if (!drop) return { code: 404 as const, error: 'unknown drop' };
        if (drop.state !== 'push_pending')
          return {
            code: 409 as const,
            error: `drop ${drop.id} is ${drop.state}, not a pending push: only a pending push is cancelled here`,
          };
        updateDrop(db, drop.id, { state: 'cancelled', finishedAt: at.toISOString() });
        revokeGrants(db, drop.id, at);
        appendEvents(db, drop.id, [
          {
            ts: at.toISOString(),
            kind: 'log',
            data: { message: 'pending push cancelled by operator' },
          },
        ]);
        if (
          drop.role === 'implement' &&
          drop.workItemId !== null &&
          getWorkItem(db, drop.workItemId)?.state === 'in_flight'
        )
          setWorkItemState(db, drop.workItemId, 'ready', undefined, at);
        return { code: 200 as const, dropId: drop.id };
      })();
      if (out.code !== 200) return reply.code(out.code).send({ error: out.error });
      audit(req, 'cancel-push', { dropId: out.dropId }, out.dropId);
      deps.kick?.();
      return { dropId: out.dropId, state: 'cancelled' };
    });

    // The minimal intake. The stub is rendered only; the first issue is filed ready through the
    // outbox, once per idempotency key, and only while the zone acts.
    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/intake/goal-stub',
      async (req, reply) => {
        const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
        if (!zone) return reply.code(404).send({ error: 'unknown zone' });
        const body = GoalStubSchema.safeParse(req.body ?? {});
        if (!body.success) return reply.code(400).send({ error: 'invalid answers' });
        const { template, ...answers } = body.data;
        return { markdown: renderGoalStub(template, answers) };
      },
    );

    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/intake/issue',
      async (req, reply) => {
        const zone = cfg(req).dropZones.find((z) => z.id === req.params.id);
        if (!zone) return reply.code(404).send({ error: 'unknown zone' });
        const forgesFor = deps.intakeForgesFor ?? deps.forgesFor;
        if (!forgesFor)
          return reply.code(503).send({ error: 'this server has no forge to file through' });
        const body = IntakeIssueSchema.safeParse(req.body ?? {});
        if (!body.success)
          return reply.code(400).send({
            error: `invalid issue: ${body.error.issues.map((i) => i.path.join('.') || '(body)').join(', ')}`,
          });
        const out = await fileIntakeIssue(
          db,
          forgesFor(zone.id),
          zone,
          body.data,
          secretList(cfg(req).secrets),
          now(),
        );
        const { status, ...rest } = out;
        // Named fields only: the issue's text is the caller's and stays out of the audit.
        audit(
          req,
          'intake.issue',
          {
            status,
            number: 'number' in rest && typeof rest.number === 'number' ? rest.number : null,
          },
          zone.id,
        );
        if (status === 201) deps.kick?.();
        return reply.code(status).send(rest);
      },
    );

    scope.post('/api/control/kill', async (req, reply) => {
      const body = KillBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid body' });
      const engaged = body.data.engaged;
      // The DB first, committed before any GitHub call: new work is refused (or allowed) at once.
      // The pause is credited to every pending push's retention on release (Ruling 12).
      const done = engaged ? engageKill(db, now()) : (releaseKill(db, now()), { cancelled: 0 });
      // The cancelled drops' clone tokens go now, not at the next lease tick.
      // No cached app token outlives the switch: after release, every token is minted afresh.
      if (engaged) deps.appTokens?.clear();
      if (engaged) deps.heldReadTokens?.sweep(db);
      const today: AuditDetail = engaged ? { engaged, cancelled: done.cancelled } : { engaged };
      const installations = await suspendInstallations(req, engaged);
      if (!installations) {
        audit(req, 'kill', today);
        return { engaged, ...done };
      }
      const { ok, failed } = installations;
      audit(req, 'kill', {
        ...today,
        installationsOk: ok,
        installationsFailed: failed.length,
        ...(failed.length > 0
          ? {
              failedInstallations: failed
                .map((f) => `${f.owner}/${f.role}/${f.installationId}:${f.status}`)
                .join(','),
            }
          : {}),
      });
      return { engaged, ...done, installations };
    });

    if (deps.config instanceof ConfigStore) {
      registerConfigRoutes(
        scope,
        deps.config,
        audit,
        actx,
        tokenOnly,
        deps.detectForge ?? githubDetectForge,
        { db, now, ...(deps.reach ? { reach: deps.reach } : {}) },
      );
      // GitHub guidance (Task 7): reads only, never a forge write.
      registerGuidanceRoutes(scope, {
        store: deps.config,
        now,
        ...(deps.guidanceForge ? { guidanceForge: deps.guidanceForge } : {}),
      });
      registerSecretRoutes(scope, {
        db,
        store: deps.config,
        now,
        audit,
        ...(deps.credentialForge ? { credentialForge: deps.credentialForge } : {}),
      });
    }
  });
}

/** Zone ids with history to resume (`ctl zones add --resume`, T11). */
/** How long one detection request on GitHub may take. */
const DETECT_REQUEST_MS = 30_000;
const githubDetectForge = (repo: string, token: string): DetectForge => {
  const [owner = '', name = ''] = repo.split('/');
  return new GitHubForge(owner, name, token, { requestTimeoutMs: DETECT_REQUEST_MS });
};

const DetectBody = z.strictObject({ repo: z.string().max(200) });
const ZoneAddBody = z.strictObject({
  zone: z.record(z.string(), z.unknown()),
  resume: z.boolean().optional(),
  returnTo: z.string().max(2048).optional(),
  /** Where the confirmation page's Cancel goes (the wizard: back to the project step). */
  cancelTo: z.string().max(2048).optional(),
});
const AdoptBody = z.strictObject({
  hosts: z.array(z.string().max(253)).max(100),
  returnTo: z.string().max(2048).optional(),
  cancelTo: z.string().max(2048).optional(),
});

/** The removal's revision note, within the note limit whatever the id (an M4 file's may be long). */
export { removalNote };

const NO_GATES = 'add at least one check (gate): every change must pass one';
const Resume = z.array(z.string().min(1)).max(100).optional();
/** Where the confirmation page goes after a guarded change is applied: a path on this host. */
const ReturnTo = z.string().max(2048).optional();

// A body naming `__proto__` or `constructor.prototype` never reaches these schemas: Fastify's
// default JSON parser (secure-json-parse) answers 400 first. Behind it, `z.record` would drop an
// own `__proto__` key silently, and the store refuses such keys by name (parseEditable).
// None of these bodies carries a confirmation: only the confirm page's POST does, after the
// passphrase.
const PatchBody = z.strictObject({
  patch: z.record(z.string(), z.unknown()),
  expectRevision: z.number().int().nonnegative(),
  note: z.string().optional(),
  resume: Resume,
  returnTo: ReturnTo,
  cancelTo: ReturnTo,
});
const RollbackBody = z.strictObject({
  id: z.number().int().positive(),
  note: z.string().optional(),
  expectRevision: z.number().int().nonnegative().optional(),
  returnTo: ReturnTo,
  cancelTo: ReturnTo,
});
const NoteBody = z.strictObject({ note: z.string().optional() });
const PublicUrlBody = z.strictObject({ publicUrl: z.string().max(2048).nullable() });
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const ModeBody = z.strictObject({ mode: z.literal('file') });
const ImportBody = z.strictObject({
  config: z.unknown(),
  dryRun: z.boolean().optional(),
  note: z.string().optional(),
  expectRevision: z.number().int().nonnegative().optional(),
  resume: Resume,
  returnTo: ReturnTo,
  cancelTo: ReturnTo,
});
const MAX_REVISIONS = 500;

/** A `returnTo` kept only as a path on this host. */
const returnToOf = (returnTo: string | undefined): { returnTo?: string } =>
  returnTo === undefined ? {} : { returnTo: safeNext(returnTo) };
/** Where the confirmation page's Cancel goes: a path on this host, under `returnTo`'s rule. */
const cancelToOf = (cancelTo: string | undefined): { cancelTo?: string } =>
  cancelTo === undefined ? {} : { cancelTo: safeNext(cancelTo) };

/** A shared action's refusal as the routes answer it: its body when it has one, else `{ error }`. */
const sendFailure = (reply: FastifyReply, r: Extract<ActionResult<unknown>, { ok: false }>) =>
  reply.code(r.status).send(r.body ?? { error: r.error });

/**
 * The config store's routes (§10.3 live config). Both principals read and write; a session's
 * apply is recorded `via: 'ui'`, the token's `via: 'ctl'`. `mode file` is the token's alone. Every
 * successful write is audited from named fields: the revision and the paths, never a value.
 *
 * PATCH, rollback and import go through the store's classifier (§7.5, config/guarded.ts): from a
 * session a guarded change is answered 409 `needsConfirmation` and held until the confirmation
 * page (ui/confirm.ts) confirms it with the passphrase; a session-forbidden one is 403 whatever
 * else the set carries. A removed zone must be drained in observe, for every principal.
 */
function registerConfigRoutes(
  scope: FastifyInstance,
  store: ConfigStore,
  audit: (req: FastifyRequest, action: string, detail: AuditDetail, target?: string) => void,
  actx: (req: FastifyRequest) => ActionCtx,
  tokenOnly: (req: FastifyRequest, reply: FastifyReply) => boolean,
  detectForge: (repo: string, token: string) => DetectForge,
  ctx: { db: Db; now(): Date; reach?: ReachDeps },
): void {
  const { db, now } = ctx;
  // The guard sets a principal on every control route or answers 401; never assume one.
  const principalOf = (req: FastifyRequest): Principal => {
    if (!req.principal) throw new Error('a config route was reached without a principal');
    return req.principal;
  };
  const viaOf = (req: FastifyRequest): 'ui' | 'ctl' =>
    principalOf(req).via === 'token' ? 'ctl' : 'ui';
  /** An apply's answer: 200 with the revision, 400 with issues by path, 409 on a stale revision. */
  const answer = (
    req: FastifyRequest,
    reply: FastifyReply,
    action: string,
    r: ApplyResult,
    extra: AuditDetail = {},
    target?: string,
  ) => {
    const out = applyOutcome(actx(req), action, r, extra, target);
    return out.ok ? out.value : sendFailure(reply, out);
  };
  const invalid = (reply: FastifyReply, shape: string) =>
    reply.code(400).send({ issues: [{ path: '', message: `invalid body: ${shape}` }] });

  /** Detection on the author token, or the reason it cannot run (409 no token, 502 GitHub). */
  const detect = async (
    req: FastifyRequest,
    reply: FastifyReply,
    repo: string,
    preset?: string,
  ): Promise<Detection | undefined> => {
    const token = (req.jmConfig ?? store.current()).secrets.githubAuthorToken;
    if (!token) {
      void reply.code(409).send({ error: NO_AUTHOR });
      return undefined;
    }
    try {
      return await detectRepo(
        detectForge(repo, token),
        repo,
        preset ? { preset: preset as Detection['candidates'][number] } : {},
      );
    } catch (e) {
      void reply.code(502).send({ error: detectFailure(e, repo) });
      return undefined;
    }
  };

  // Detection for the project step and `ctl detect`: GET-only reads, after the REPO pattern. A read
  // changes nothing, so it is not audited.
  scope.post('/api/control/detect', async (req, reply) => {
    const body = DetectBody.safeParse(req.body ?? {});
    if (!body.success || !REPO.test(body.data.repo))
      return reply.code(400).send({ error: 'the repository must be owner/name' });
    const d = await detect(req, reply, body.data.repo);
    return d ?? reply;
  });

  // Adds one zone through the apply path, as the wizard's project step, `ctl zones add` and (later)
  // the zones page do: classified against the add baseline, so a guarded add from a session goes
  // to the confirmation page with `returnTo` kept. Without gates the server detects them.
  // The revision is the store's own, read and applied without an await between: an add lands on
  // whatever is current. A session's add is a pending change carrying that revision, and the
  // confirm refuses it as `stale` if anything was applied meanwhile, so no client revision is sent.
  scope.post('/api/control/zones', async (req, reply) => {
    const body = ZoneAddBody.safeParse(req.body ?? {});
    if (!body.success)
      return invalid(reply, '{"zone": {"repo": "owner/name", …}, "resume"?: true}');
    const { zone, resume, returnTo, cancelTo } = body.data;
    const repo = zone.repo;
    if (typeof repo !== 'string' || !REPO.test(repo))
      return reply
        .code(400)
        .send({ issues: [{ path: 'zone.repo', message: 'the repository must be owner/name' }] });
    const id = typeof zone.id === 'string' && zone.id !== '' ? zone.id : zoneIdOf(repo);
    const config = req.jmConfig ?? store.current();
    const sameRepo = config.dropZones.find((z) => z.repo.toLowerCase() === repo.toLowerCase());
    if (sameRepo)
      return reply.code(409).send({
        error: `${repo} is already zone ${sameRepo.id}: a repository has one zone`,
      });
    if (config.dropZones.some((z) => z.id === id))
      return reply.code(409).send({ error: `zone ${id} exists: pick another id` });
    if (zone.preset !== undefined && !(PRESETS as readonly unknown[]).includes(zone.preset))
      return reply.code(400).send({
        issues: [
          { path: 'zone.preset', message: `the stack preset is one of ${PRESETS.join(', ')}` },
        ],
      });
    if (Array.isArray(zone.gates) && zone.gates.length === 0)
      return reply.code(400).send({ issues: [{ path: 'zone.gates', message: NO_GATES }] });
    const add: Record<string, unknown> = { ...zone, id };
    // The add baseline (and the generated install) starts in monitor, never the schema's off.
    if (add.egress === undefined) add.egress = { mode: 'monitor' };
    if (add.gates === undefined) {
      const d = await detect(
        req,
        reply,
        repo,
        typeof add.preset === 'string' ? add.preset : undefined,
      );
      if (!d) return reply;
      if (!d.preset && add.preset === undefined)
        return reply.code(400).send({
          issues: [
            {
              path: 'zone.preset',
              message: `can't choose a stack preset for ${repo}: ${d.problems.join('; ')}; choose one${d.candidates.length ? ` of ${d.candidates.join(', ')}` : ''}`,
            },
          ],
        });
      if (d.gates.length === 0)
        return reply.code(400).send({
          issues: [
            {
              path: 'zone.gates',
              message: `${NO_GATES}; nothing was detected for ${repo}${d.problems.length ? ` (${d.problems.join('; ')})` : ''}: give the gates`,
            },
          ],
        });
      if (add.preset === undefined) add.preset = d.preset;
      add.gates = d.gates;
      if (d.visibility === 'private' && add.reviewReadToken === undefined)
        add.reviewReadToken = true;
    }
    const doc = store.document();
    const zones = Array.isArray(doc.dropZones) ? doc.dropZones : [];
    const r = store.apply(
      { ...doc, dropZones: [...zones, add] },
      {
        via: viaOf(req),
        principal: principalOf(req),
        expectRevision: store.revision(),
        ...(resume ? { resume: [id] } : {}),
        ...returnToOf(returnTo),
        ...cancelToOf(cancelTo),
      },
    );
    // An id with history: say what Resume would bring back, beside the store's issue.
    if (
      !r.ok &&
      'issues' in r &&
      r.issues.some((i) => i.message.startsWith('this zone has history'))
    )
      return reply.code(400).send({ issues: r.issues, history: zoneHistoryCounts(db, id) });
    const out = answer(req, reply, 'zone.add', r, {}, id);
    if (!r.ok) return out;
    // What was written, so `ctl zones add` (and the page) can say it.
    const written = store.current().dropZones.find((z) => z.id === id);
    return {
      ...(out as object),
      zone: id,
      ...(written?.preset ? { preset: written.preset } : {}),
      egress: written?.egress?.mode ?? 'off',
      gates: written?.gates ?? [],
    };
  });

  /** A zone in the document: its raw entry and its index (where schema issues point). */
  const zoneAt = (id: string) => {
    const doc = store.document();
    const zones = (Array.isArray(doc.dropZones) ? doc.dropZones : []) as Record<string, unknown>[];
    const index = zones.findIndex((z) => z.id === id);
    return index < 0 ? undefined : { zone: zones[index] as Record<string, unknown>, index };
  };

  // The zones page's reads, and `ctl zones list | show`: never a secret, only what the config and
  // the database say about each zone.
  /** A zone being stopped: since when, and what it still waits for. */
  const stoppingOf = (id: string) => {
    const s = zoneStopping(db, id);
    return s ? { stopping: { since: s.since, waits: zoneWaits(db, id) } } : {};
  };

  scope.get('/api/control/zones', async (req) => {
    const config = req.jmConfig ?? store.current();
    const problems = store.problems();
    const run = latestDoctorRun(db);
    return {
      zones: config.dropZones.map((z) => {
        const mode = getZoneMode(db, z.id, z.mode);
        const last = db
          .prepare(
            'SELECT id, role, state, created_at AS createdAt FROM drops WHERE drop_zone_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
          )
          .get(z.id) as { id: string; role: string; state: string; createdAt: string } | undefined;
        return {
          id: z.id,
          repo: z.repo,
          mode,
          modeLabel: MODE_LABELS[mode] ?? mode,
          ...(z.preset ? { preset: z.preset } : {}),
          image: z.image,
          egress: z.egress?.mode ?? 'off',
          identity: z.identity,
          ...(last ? { lastDrop: last } : {}),
          doctorFails: run
            ? run.checks.filter((c) => c.zoneId === z.id && c.status === 'fail').length
            : null,
          problems: problems.filter((p) => p.zoneId === z.id).map((p) => p.message),
          ...stoppingOf(z.id),
        };
      }),
    };
  });

  scope.get<{ Params: { id: string } }>('/api/control/zones/:id', async (req, reply) => {
    const at = zoneAt(req.params.id);
    if (!at) return reply.code(404).send({ error: 'unknown zone' });
    const z = (req.jmConfig ?? store.current()).dropZones.find((x) => x.id === req.params.id);
    const mode = getZoneMode(db, req.params.id, z?.mode ?? 'active');
    return {
      zone: at.zone,
      index: at.index,
      mode,
      modeLabel: MODE_LABELS[mode] ?? mode,
      revision: store.revision(),
      problems: store.problems().filter((p) => p.zoneId === req.params.id),
      ...stoppingOf(req.params.id),
    };
  });

  // Stop managing (removal): one action. The zone goes to observe and is marked stopping; drained,
  // it leaves the document through the apply path at once (200 `removed`), else the server removes
  // it once drained (202 `stopping`, with what it waits for). Only its mode row goes, and its
  // history stays for a later Resume. A file-mode config is refused by the apply path.
  scope.delete<{ Params: { id: string }; Querystring: { returnTo?: string } }>(
    '/api/control/zones/:id',
    async (req, reply) => {
      const id = req.params.id;
      if (!zoneAt(id)) return reply.code(404).send({ error: 'unknown zone' });
      const r = stopZone(db, store, id, {
        via: viaOf(req),
        principal: principalOf(req),
        now: now(),
      });
      if (r.kind === 'stopping') {
        audit(req, 'zone.stop', { ...r.waits }, id);
        return reply.code(202).send({ stopping: id, waits: r.waits });
      }
      const out = answer(req, reply, 'zone.remove', r.result, {}, id);
      return r.kind === 'removed' ? { ...(out as object), removed: id } : out;
    },
  );

  const EGRESS_WINDOW_MS = 14 * 86_400_000;
  scope.get<{ Params: { id: string } }>(
    '/api/control/zones/:id/egress/observed',
    async (req, reply) => {
      if (!zoneAt(req.params.id)) return reply.code(404).send({ error: 'unknown zone' });
      const since = new Date(now().getTime() - EGRESS_WINDOW_MS);
      return { since: since.toISOString(), hosts: egressSeen(db, req.params.id, since).hosts };
    },
  );

  // Adopting observed hosts into the allow list: each entry checked as `egress.allow` checks it,
  // only the ones not already allowed added, and the change is guarded (more reach for drops), so
  // from a browser it goes through the confirmation page.
  scope.post<{ Params: { id: string } }>(
    '/api/control/zones/:id/egress/adopt',
    async (req, reply) => {
      const body = AdoptBody.safeParse(req.body ?? {});
      if (!body.success) return invalid(reply, '{"hosts": ["host", …]}');
      const at = zoneAt(req.params.id);
      if (!at) return reply.code(404).send({ error: 'unknown zone' });
      const { hosts, returnTo, cancelTo } = body.data;
      if (hosts.length === 0)
        return reply
          .code(400)
          .send({ issues: [{ path: 'hosts', message: 'tick at least one host' }] });
      const egressNow = (at.zone.egress ?? {}) as { mode?: string };
      // Adopting never turns egress on: with it off, no allow list is used at all.
      if ((egressNow.mode ?? 'off') === 'off')
        return reply.code(409).send({
          error: `egress is off for zone ${req.params.id}: set it to monitor or enforce first, so the allow list is used`,
        });
      const bad = hosts.flatMap((h, i) =>
        validAllowEntry(h)
          ? []
          : [{ path: `hosts.${i}`, message: `not a host name or *.name: ${h}` }],
      );
      if (bad.length > 0) return reply.code(400).send({ issues: bad });
      // Only what this zone's drops reached in the window: the page offers nothing else.
      const observed = new Set(
        egressSeen(db, req.params.id, new Date(now().getTime() - EGRESS_WINDOW_MS)).hosts.map(
          (h) => h.host,
        ),
      );
      // An entry already on the list is a no-op, observed or not.
      const listed = new Set(
        ((at.zone.egress as { allow?: string[] } | undefined)?.allow ?? []).map(String),
      );
      const unseen = hosts.flatMap((h, i) =>
        observed.has(h) || listed.has(h)
          ? []
          : [
              {
                path: `hosts.${i}`,
                message: `${h} was not observed for zone ${req.params.id} in the last 14 days`,
              },
            ],
      );
      if (unseen.length > 0) return reply.code(400).send({ issues: unseen });
      const egress = (at.zone.egress ?? {}) as { mode?: string; allow?: string[] };
      const allow = Array.isArray(egress.allow) ? egress.allow : [];
      const fresh = [...new Set(hosts)].filter((h) => !allow.includes(h));
      if (fresh.length === 0)
        return reply.code(400).send({
          issues: [{ path: 'hosts', message: 'every ticked host is already allowed' }],
        });
      const note = `adopt observed hosts: ${fresh.join(', ')}`;
      const r = store.apply(
        mergeConfigPatch(store.document(), {
          dropZones: [
            {
              id: req.params.id,
              egress: { mode: egress.mode, allow: [...allow, ...fresh] },
            },
          ],
        }),
        {
          via: viaOf(req),
          principal: principalOf(req),
          expectRevision: store.revision(),
          note: note.length > 500 ? `${note.slice(0, 497)}...` : note,
          ...returnToOf(returnTo),
          ...cancelToOf(cancelTo),
        },
      );
      return answer(req, reply, 'zone.egress-adopt', r, { hosts: fresh.join(', ') }, req.params.id);
    },
  );

  // The address other machines reach this server at (issue #139): set or cleared alone, applied
  // live through the store, audited as `server.public_url` with the address (it is no secret).
  // Guarded (issue #254): a new machine runs the installer from it as root, so a session's change
  // waits for the confirmation page, which returns to the tab and writes the same audit row.
  scope.put('/api/control/server/public-url', async (req, reply) => {
    const body = PublicUrlBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, '{"publicUrl": "https://…" | null}');
    const { publicUrl } = body.data;
    if (publicUrl !== null) {
      const problem = publicUrlProblem(publicUrl);
      if (problem)
        return reply.code(400).send({ issues: [{ path: 'server.publicUrl', message: problem }] });
    }
    const doc = structuredClone(store.document());
    const server = isRecord(doc.server) ? { ...doc.server } : {};
    if (publicUrl === null) delete server.publicUrl;
    else server.publicUrl = publicUrl;
    if (Object.keys(server).length > 0) doc.server = server;
    else delete doc.server;
    const r = store.apply(doc, {
      via: viaOf(req),
      principal: principalOf(req),
      expectRevision: store.revision(),
      returnTo: PUBLIC_URL_PAGE,
      cancelTo: PUBLIC_URL_PAGE,
      audit: { action: 'server.public_url', detail: { publicUrl } },
    });
    const out = answer(req, reply, 'server.public_url', r, { publicUrl });
    return r.ok ? { ...(out as Record<string, unknown>), publicUrl } : out;
  });

  // Check: this server fetches `<publicUrl>/healthz` (5 s) and says Reachable or the failure.
  scope.post('/api/control/server/public-url/check', async (req, reply) => {
    const publicUrl = (req.jmConfig ?? store.current()).server?.publicUrl;
    if (!publicUrl)
      return reply
        .code(409)
        .send({ error: `${PUBLIC_URL_NEEDED}: Settings, Other machines (${PUBLIC_URL_PAGE})` });
    return checkReach(publicUrl, ctx.reach ?? {});
  });

  scope.get('/api/control/config', async () => {
    const b = store.boot();
    const status = store.status();
    return {
      mode: status.mode,
      revision: status.revision,
      config: store.document(),
      boot: { listen: b.listen, dataDir: b.dataDir, source: b.source },
      restartPending: status.restartPending,
      ...(status.filePath ? { filePath: status.filePath } : {}),
      ...(status.fileProblem ? { fileProblem: status.fileProblem } : {}),
      ...(status.fileIgnored ? { fileIgnored: status.fileIgnored } : {}),
      // What the lenient read of the file adjusted to run (ctl config show, the Install tab).
      ...(status.warnings ? { warnings: status.warnings } : {}),
    };
  });

  scope.patch('/api/control/config', async (req, reply) => {
    const body = PatchBody.safeParse(req.body ?? {});
    if (!body.success)
      return invalid(reply, '{"patch": {…}, "expectRevision": <revision>, "note"?: "…"}');
    const { patch, expectRevision, note, resume, returnTo, cancelTo } = body.data;
    const r = configPatchAction(actx(req), store, patch, {
      expectRevision,
      ...(note !== undefined ? { note } : {}),
      ...(resume ? { resume } : {}),
      ...(returnTo !== undefined ? { returnTo } : {}),
      ...(cancelTo !== undefined ? { cancelTo } : {}),
    });
    return r.ok ? r.value : sendFailure(reply, r);
  });

  scope.get<{ Querystring: { limit?: string } }>('/api/control/config/revisions', async (req) => {
    const n = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, MAX_REVISIONS) : 50;
    return { revisions: store.revisions(limit) };
  });

  scope.post('/api/control/config/rollback', async (req, reply) => {
    const body = RollbackBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, '{"id": <revision>, "note"?: "…"}');
    const { id, note, expectRevision, returnTo, cancelTo } = body.data;
    const r = store.rollback(id, {
      principal: principalOf(req),
      ...(note !== undefined ? { note } : {}),
      ...(expectRevision !== undefined ? { expectRevision } : {}),
      ...returnToOf(returnTo),
      ...cancelToOf(cancelTo),
    });
    return answer(req, reply, 'config.rollback', r, { from: id });
  });

  scope.post('/api/control/config/reload', async (req, reply) => {
    const r = store.reload();
    const out = answer(req, reply, 'config.reload', r);
    const ignored = store.status().fileIgnored;
    if (r.ok && store.mode() === 'db' && ignored)
      return { ...(out as object), note: `${ignored}: reload reads the file in file mode only` };
    return out;
  });

  scope.post('/api/control/config/adopt', async (req, reply) => {
    const body = NoteBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, '{"note"?: "…"}');
    const r = store.adopt({
      principal: principalOf(req),
      ...(body.data.note !== undefined ? { note: body.data.note } : {}),
    });
    return answer(req, reply, 'config.adopt', r);
  });

  scope.post('/api/control/config/mode', async (req, reply) => {
    if (!tokenOnly(req, reply)) return reply;
    const body = ModeBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, '{"mode": "file"}');
    const r = store.toFileMode({ principal: principalOf(req) });
    return answer(req, reply, 'config.mode', r, { mode: 'file' });
  });

  scope.get('/api/control/config/export', async (_req, reply) =>
    reply
      .type('application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="jumpmaster.config.json"')
      .send(store.exportJson()),
  );

  scope.post('/api/control/config/import', async (req, reply) => {
    const body = ImportBody.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, '{"config": {…}, "dryRun"?: true}');
    const { config, dryRun, note, expectRevision, resume, returnTo, cancelTo } = body.data;
    const preview = store.preview(config);
    if (dryRun) return { dryRun: true, ...preview };
    const r = store.importDoc(config, {
      via: 'import',
      principal: principalOf(req),
      ...(note !== undefined ? { note } : {}),
      ...(expectRevision !== undefined ? { expectRevision } : {}),
      ...(resume ? { resume } : {}),
      ...returnToOf(returnTo),
      ...cancelToOf(cancelTo),
    });
    const out = answer(req, reply, 'config.import', r);
    return r.ok ? { ...(out as object), changes: preview.changes } : out;
  });
}
