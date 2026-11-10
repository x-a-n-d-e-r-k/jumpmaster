import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuditDetail, recordAudit } from '../auth/audit.js';
import { Backoff } from '../auth/backoff.js';
import {
  deleteOperator,
  MAX_PASSPHRASE,
  operatorHash,
  passphraseProblem,
  SetupMode,
  setOperatorPassphrase,
  setupActive,
  setupCodeLine,
  verifyPassphrase,
} from '../auth/operator.js';
import { deleteAllSessions, grantSudo } from '../auth/sessions.js';
import { listBriefings, optionsDigest, ruleBriefing } from '../briefings.js';
import { type Config, mcpConfigOf, secretList } from '../config.js';
import { requestCrewCycle } from '../crew/schedule.js';
import type { Db } from '../db/open.js';
import {
  activeWorkCount,
  getZoneMode,
  insertDrop,
  isKilled,
  setKilled,
  setZoneMode,
  ZONE_MODES,
} from '../db/repo.js';
import { type DoctorEnv, doctorDropWait } from '../doctor/checks.js';
import { DoctorBusyError, latestDoctorRun, processEnv, runDoctor } from '../doctor/run.js';
import type { Forge } from '../forge/github.js';
import { fileIntakeIssue, GoalStubSchema, IntakeIssueSchema, renderGoalStub } from '../intake.js';
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
  /** The in-memory setup code, shared with the setup pages (default: one printing to stderr). */
  setup?: SetupMode;
  /** Per-source backoff for passphrase guesses, shared with the login page. */
  backoff?: Backoff;
}

/** A setup mode whose codes go to stderr, alone on their line (main.ts passes its own). */
export function stderrSetupMode(listen: Config['listen']): SetupMode {
  return new SetupMode((code) => process.stderr.write(`${setupCodeLine(code, listen)}\n`));
}

const DoctorBody = z.strictObject({ zone: z.string().min(1).optional() });
const DoctorDropBody = z.strictObject({
  zone: z.string().min(1),
  cancel: z.literal(true).optional(),
});

const ZoneBody = z.object({ mode: z.enum(ZONE_MODES) });
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
 */
export function registerControlRoutes(app: FastifyInstance, deps: ControlDeps): void {
  const { db, config, now } = deps;
  const setup = deps.setup ?? stderrSetupMode(config.listen);
  const backoff = deps.backoff ?? new Backoff();
  const secrets = secretList(config.secrets);
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
      secrets,
    );
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
      if (!p?.sessionId || !stored || given === undefined || !verifyPassphrase(given, stored)) {
        backoff.fail(req.ip, now());
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
        next: "a new setup code is on the server's output (docker compose logs jumpmaster)",
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
        next: "the new setup code is on the server's output (docker compose logs jumpmaster)",
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
      const sessionsDeleted = deleteAllSessions(db);
      const operator = setOperatorPassphrase(db, body.data.passphrase, now());
      setup.clear();
      audit(req, 'passphrase.set', { result: operator, sessionsDeleted });
      return { operator, sessionsDeleted };
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
      audit(req, 'zone.mode', { mode: body.data.mode }, zone.id);
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
        audit(req, 'briefing.rule', { optionId, rulingId: r.rulingId }, `briefing:${id}`);
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
        audit(req, 'zone.crew-cycle', {}, zone.id);
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
              forges: deps.doctorForgesFor ?? forgesFor,
              ...(deps.readForgeFor ? { readForge: deps.readForgeFor } : {}),
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
    }

    // A doctor drop spends a turn of usage, so it runs only on request, one per zone, and is
    // refused rather than queued where nothing would lease it.
    scope.post('/api/control/doctor/drop', async (req, reply) => {
      const body = DoctorDropBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid body: {"zone": "<id>"}' });
      const zone = config.dropZones.find((z) => z.id === body.data.zone);
      if (!zone) return reply.code(404).send({ error: 'unknown zone' });
      // Cancel: only a queued doctor drop, which nothing has started (a running one finishes).
      if (body.data.cancel) {
        const mine = db
          .prepare(
            `SELECT id, state FROM drops WHERE drop_zone_id = ? AND role = 'doctor'
               AND state IN ('queued','leased','running')`,
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
             AND state IN ('queued','leased','running')`,
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
      const waiting = doctorDropWait(db, config, zone, now());
      return reply.code(202).send({
        dropId,
        zone: zone.id,
        state: 'queued',
        waiting,
        next: `It runs when a stick can take it (${waiting}). Then: jumpmaster ctl doctor ${zone.id}`,
      });
    });

    // The minimal intake. The stub is rendered only; the first issue is filed ready through the
    // outbox, once per idempotency key, and only while the zone acts.
    scope.post<{ Params: { id: string } }>(
      '/api/control/zones/:id/intake/goal-stub',
      async (req, reply) => {
        const zone = config.dropZones.find((z) => z.id === req.params.id);
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
        const zone = config.dropZones.find((z) => z.id === req.params.id);
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
          secretList(config.secrets),
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
      if (!body.data.engaged) {
        setKilled(db, false, now());
        audit(req, 'kill', { engaged: false });
        return { engaged: false, cancelled: 0 };
      }
      const done = engageKill(db, now());
      audit(req, 'kill', { engaged: true, cancelled: done.cancelled });
      return { engaged: true, ...done };
    });
  });
}
