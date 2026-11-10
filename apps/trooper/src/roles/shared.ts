import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  type CrewDropPayload,
  type DropPayload,
  type DropResult,
  EVENT_PREFIX,
  type GateResult,
  type ItemDropPayload,
  isCrewRole,
  type RateLimitEventData,
  REPORT_MAX_CHARS,
  type ServiceSpec,
  servedModel,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { buildClaudeArgs, type ParsedLine, parseStreamLine } from '../claude.js';
import { capEventData } from '../events.js';
import { scrubEnv } from '../gates.js';
import type { TrooperDeps } from '../main.js';
import { sweepUid, type TrooperIdentities } from '../privilege.js';
import { redact } from '../redact.js';

/** A payload for a role that runs the agent: every role but `doctor`. */
export type AgentPayload = ItemDropPayload | CrewDropPayload;

export type RoleCtx = { workdir: string; secrets: string[]; ids: TrooperIdentities | null };
export type RoleRunner = (
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
) => Promise<DropResult>;

export type ResultLine = Extract<ParsedLine, { type: 'result' }>;

export interface AgentOutcome {
  exitCode: number | null;
  results: ResultLine[];
  initSessionId: string | null;
  /** A `rejected` report was seen. */
  rateLimited: boolean;
  /** The last rate-limit report of any status. */
  rateLimit?: RateLimitEventData;
  terminalReason?: string;
  /** The trooper was told to stop (SIGTERM/SIGINT) while the agent ran. */
  aborted?: boolean;
}

export function emitEvent(
  deps: TrooperDeps,
  ctx: RoleCtx,
  kind: TrooperEvent['kind'],
  data: Record<string, unknown>,
): void {
  const ev: TrooperEvent = {
    ts: new Date().toISOString(),
    kind,
    data: capEventData(data, ctx.secrets),
  };
  deps.emit(redact(EVENT_PREFIX + JSON.stringify(ev), ctx.secrets));
}

/** The agent's working copy: under its own home in container mode, else in the workdir. */
/** The root-owned mirror, never inside the agent's home. */
export function mirrorDirOf(ctx: RoleCtx): string {
  return join(ctx.workdir, 'mirror');
}

export function repoDirOf(ctx: RoleCtx): string {
  return ctx.ids ? join(ctx.ids.agent.home, 'repo') : join(ctx.workdir, 'repo');
}

/** Clones through the root mirror at `<workdir>/mirror`; returns the working copy. */
export async function cloneAndPrepare(
  payload: AgentPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<string> {
  const dir = repoDirOf(ctx);
  emitEvent(deps, ctx, 'phase', { phase: 'clone' });
  await deps.git.cloneRepo({
    owner: payload.repo.owner,
    name: payload.repo.name,
    // Review may run without a forge token (public repo); git then clones anonymously.
    token: payload.credentials.forgeToken ?? '',
    dir,
    mirrorDir: mirrorDirOf(ctx),
    as: ctx.ids?.agent ?? null,
  });
  return dir;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The `--settings` file for the agent: no hooks, and no attribution when the zone says so. */
export function agentSettings(payload: AgentPayload): Record<string, unknown> {
  if (payload.attribution !== false) return { hooks: {} };
  return { hooks: {}, includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } };
}

/** The appended system prompt for a crew role: where the read-only clone is. */
export function crewSystemPrompt(addDirs: string[]): string {
  const where = addDirs.map((d) => `- ${d}`).join('\n');
  return `Your working directory is empty on purpose. The repository is cloned, read-only for this task, at:\n${where}\nRead it there. Never modify, commit or push anything in it.\n`;
}

/**
 * Runs Claude with `cwd` as its working directory, as the agent identity, and collects what the
 * stream reported. `addDirs` are passed as `--add-dir` (a crew role reads its clone that way, so
 * the clone's own instructions are never loaded).
 */
export async function runAgent(
  payload: AgentPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  o: { prompt: string; outputSchema: object; gateResults?: GateResult[]; addDirs?: string[] },
  cwd: string,
): Promise<AgentOutcome> {
  const systemPromptFile = join(ctx.workdir, 'system.md');
  const settingsFile = join(ctx.workdir, 'settings.json');
  const crew = isCrewRole(payload.role);
  writeFileSync(
    systemPromptFile,
    crew
      ? crewSystemPrompt(o.addDirs ?? [])
      : agentSystemPrompt(payload as ItemDropPayload, o.gateResults),
  );
  writeFileSync(settingsFile, JSON.stringify(agentSettings(payload)));

  emitEvent(deps, ctx, 'phase', { phase: 'claude' });
  const args = buildClaudeArgs({
    prompt: o.prompt,
    model: payload.model,
    maxTurns: payload.maxTurns,
    systemPromptFile,
    settingsFile,
    outputSchema: o.outputSchema,
    ...(o.addDirs && o.addDirs.length > 0 ? { addDirs: o.addDirs } : {}),
  });
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env, ctx.secrets),
    ...(crew ? {} : serviceEnv(payload as ItemDropPayload)),
    CLAUDE_CODE_OAUTH_TOKEN: payload.credentials.claudeToken,
  };
  // Instructions in an --add-dir directory load only with this set; a crew role must never load them.
  delete env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
  const out: AgentOutcome = {
    exitCode: null,
    results: [],
    initSessionId: null,
    rateLimited: false,
  };
  for await (const line of deps.runClaude(args, env, cwd, ctx.ids?.agent ?? null, deps.signal)) {
    const parsed = parseStreamLine(line);
    if (parsed.type === 'ignored') continue;
    if (parsed.type === 'init') {
      out.initSessionId ??= parsed.sessionId;
    } else if (parsed.type === 'result') {
      out.results.push(parsed);
      out.terminalReason = parsed.terminalReason;
      emitEvent(deps, ctx, 'agent', {
        result: true,
        isError: parsed.isError,
        terminalReason: parsed.terminalReason,
      });
    } else if (parsed.type === 'rate_limit') {
      const data: RateLimitEventData = stripUndefined({
        status: parsed.status,
        resetsAt: parsed.resetsAt,
        rateLimitType: parsed.rateLimitType,
        unifiedWindows: parsed.unifiedWindows,
        isUsingOverage: parsed.isUsingOverage,
        overageStatus: parsed.overageStatus,
        overageResetsAt: parsed.overageResetsAt,
      });
      // The result keeps the last report, except that a drop that ran on credits keeps its latest
      // report saying so, windows included: the credit moment, not the in-plan state after a reset
      // (the server's backstop when live events were lost). A later rejection still wins.
      const held = out.rateLimit?.isUsingOverage === true && data.isUsingOverage !== true;
      if (!held) out.rateLimit = data;
      else if (data.status === 'rejected') out.rateLimit = { ...data, isUsingOverage: true };
      if (data.status === 'rejected') out.rateLimited = true;
      emitEvent(deps, ctx, 'rate_limit', data);
    } else {
      const r = parsed.raw as { type?: unknown; exitCode?: unknown };
      // A null exit code means a signal killed claude: never a clean exit.
      if (r.type === 'claude_stderr')
        out.exitCode = typeof r.exitCode === 'number' ? r.exitCode : -1;
      emitEvent(deps, ctx, 'agent', { raw: parsed.raw });
    }
  }
  // spawnClaude reports a non-zero exit as a claude_stderr line; a stream that ends without one exited 0.
  out.exitCode ??= 0;
  if (deps.signal?.aborted) out.aborted = true;
  return out;
}

export type Acceptance = { ok: true; result: ResultLine } | { ok: false; reason: string };

/** A result counts only from a clean exit, exactly once, and from the session that started. */
export function acceptOutcome(o: AgentOutcome): Acceptance {
  if (o.exitCode !== 0) return { ok: false, reason: `claude exit ${o.exitCode}` };
  if (o.results.length === 0) return { ok: false, reason: 'claude produced no result' };
  if (o.results.length > 1) return { ok: false, reason: 'multiple results' };
  const [result] = o.results as [ResultLine];
  if (o.initSessionId === null || result.sessionId !== o.initSessionId) {
    return { ok: false, reason: 'session mismatch' };
  }
  return { ok: true, result };
}

/** Whether the agent stopped early (limit or turn cap) and its work should be checkpointed. */
export function stoppedEarly(o: AgentOutcome): 'rate_limited' | 'interrupted' | null {
  if (o.rateLimited) return 'rate_limited';
  if (o.aborted) return 'interrupted';
  const reason = o.results.at(-1)?.terminalReason;
  return reason !== undefined && reason !== 'completed' ? 'interrupted' : null;
}

/** What a gate step's extra environment comes from (an item drop's payload, or a doctor drop's). */
export type GateEnvSource = {
  gateSecrets?: Record<string, string>;
  services?: ServiceSpec[];
  gateCi?: boolean;
};

/**
 * Gate secrets, service addresses and CI, set for a gate step after its environment is scrubbed.
 * CI=true makes `pnpm install` frozen: it refuses a lockfile that disagrees with package.json, or
 * with a pnpmfile the lockfile doesn't record, instead of rewriting it and running what it
 * resolved. The zone's `gateCi: false` (payload `gateCi`) sets CI=false; a gate secret can't.
 */
export function gateExtraEnv(
  payload: GateEnvSource,
  hostOf: (service: ServiceSpec) => string = (s) => s.name,
): NodeJS.ProcessEnv {
  return {
    ...payload.gateSecrets,
    ...serviceEnv(payload, hostOf),
    CI: payload.gateCi === false ? 'false' : 'true',
  };
}

/** Service addresses. Unlike gate secrets, the agent gets these too. */
function serviceEnv(
  payload: GateEnvSource,
  hostOf: (service: ServiceSpec) => string = (s) => s.name,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const s of payload.services ?? []) {
    const key = s.name.toUpperCase().replace(/-/g, '_');
    env[`JM_SERVICE_${key}_HOST`] = hostOf(s);
    env[`JM_SERVICE_${key}_PORT`] = String(s.port);
  }
  return env;
}

/**
 * The agent's appended system prompt: the gates, gate-only variables, and reachable services. A
 * reviewer gets the gate results it is judging instead of an instruction to make them pass.
 */
export function agentSystemPrompt(payload: ItemDropPayload, gateResults?: GateResult[]): string {
  if (payload.role === 'review') {
    return `${gateResultsNote(payload, gateResults ?? [])}${gateOnlyNote(payload)}${servicesNote(payload)}`;
  }
  const gateList = payload.gates.map((g) => `- ${g.name}: ${g.run}`).join('\n');
  return `Before finishing, run these commands and make them pass:\n${gateList}\n${gateOnlyNote(payload)}${servicesNote(payload)}`;
}

function gateResultsNote(payload: ItemDropPayload, results: GateResult[]): string {
  if (payload.gates.length === 0) return 'This zone has no gates.\n';
  if (results.length === 0) return 'No gate results were recorded for this head.\n';
  const runOf = new Map(payload.gates.map((g) => [g.name, g.run]));
  const lines = results.map((r) => {
    const run = runOf.get(r.name);
    const label = run === undefined ? r.name : `${r.name} (${run})`;
    if (r.timedOut) return `- ${label}: timed out after ${r.durationMs} ms`;
    return `- ${label}: exit ${r.exitCode ?? 'none'}, ${r.durationMs} ms, timed out: no`;
  });
  return `The gates ran on this head, in a separate step, before you started. Results:\n${lines.join('\n')}\n`;
}

/** Without this the agent doesn't know a sidecar exists, and skips work that needs it. */
function servicesNote(payload: ItemDropPayload): string {
  const services = payload.services ?? [];
  if (services.length === 0) return '';
  const lines = services.map((s) => {
    const key = s.name.toUpperCase().replace(/-/g, '_');
    return `- ${s.name} (${s.image}): host in $JM_SERVICE_${key}_HOST, port in $JM_SERVICE_${key}_PORT`;
  });
  return `\nThese services are running for this task and you can reach them:\n${lines.join('\n')}\nWhen the issue or the project's docs need one (for example a database URL for a test suite), build its address from these variables.\n`;
}

/** Without this the agent reads a missing secret as a blocker, and stops with finished work. */
function gateOnlyNote(payload: ItemDropPayload): string {
  const names = Object.keys(payload.gateSecrets ?? {});
  if (names.length === 0) return '';
  return `\nThese variables exist only in the gate step, which runs separately after you finish: ${names.join(', ')}. You don't have them, by design. A command that fails only because one is missing is not a problem and not a reason to stop. Run what you can, and finish normally.\n`;
}

/** Resolves once each service accepts a TCP connection; throws naming the first that doesn't. */
export async function waitForServices(
  services: ServiceSpec[],
  hostOf: (service: ServiceSpec) => string,
): Promise<void> {
  for (const s of services) {
    const deadline = Date.now() + s.readyTimeoutSeconds * 1000;
    while (!(await canConnect(hostOf(s), s.port))) {
      if (Date.now() >= deadline) {
        throw new Error(`service ${s.name} was not ready after ${s.readyTimeoutSeconds}s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1000 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * Gates see committed HEAD only. In container mode the agent uid is swept first and the gates run
 * as the gate uid in a fresh clone; otherwise they run in the working copy, as in M0.
 */
export async function runGatesPhase(
  payload: ItemDropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  dir: string,
  /** Test seam: services are reached by name on the drop's network. */
  hostOf: (service: ServiceSpec) => string = (s) => s.name,
): Promise<GateResult[]> {
  const services = payload.services ?? [];
  await waitForServices(services, hostOf);
  emitEvent(deps, ctx, 'phase', { phase: 'gates' });
  const env = scrubEnv(process.env, ctx.secrets);
  const extraEnv = gateExtraEnv(payload, hostOf);
  let results: GateResult[];
  if (ctx.ids) {
    (deps.privilege?.sweepUid ?? sweepUid)(ctx.ids.agent.uid);
    const gateDir = join(ctx.ids.gate.home, 'repo');
    await deps.git.cloneForGates(dir, gateDir, ctx.ids);
    results = await deps.runGates(payload.gates, {
      cwd: gateDir,
      env,
      extraEnv,
      secrets: ctx.secrets,
      as: ctx.ids.gate,
    });
  } else {
    results = await deps.runGates(payload.gates, { cwd: dir, env, extraEnv, secrets: ctx.secrets });
  }
  for (const g of results) {
    emitEvent(deps, ctx, 'gate', {
      name: g.name,
      exitCode: g.exitCode,
      timedOut: g.timedOut,
      durationMs: g.durationMs,
      outputTail: g.outputTail,
    });
  }
  return results;
}

/** The sweep every push runs: the M0 sweep plus, in container mode, both unprivileged uids. */
export function pushSweep(deps: TrooperDeps, ctx: RoleCtx): () => void {
  return () => {
    deps.git.sweepProcesses();
    if (!ctx.ids) return;
    const sweep = deps.privilege?.sweepUid ?? sweepUid;
    sweep(ctx.ids.agent.uid);
    sweep(ctx.ids.gate.uid);
  };
}

/**
 * Commits whatever the agent left as a checkpoint and pushes it when the branch is ahead of base.
 * Returns the pushed sha, or undefined when there was nothing to checkpoint.
 */
export async function checkpoint(
  deps: TrooperDeps,
  ctx: RoleCtx,
  dir: string,
  base: string,
  push: () => Promise<string>,
): Promise<string | undefined> {
  const as = ctx.ids?.agent ?? null;
  emitEvent(deps, ctx, 'phase', { phase: 'checkpoint' });
  await deps.git.commitIfDirty(dir, 'wip: checkpoint', as);
  if ((await deps.git.aheadOfBase(dir, base, as)) === 0) return undefined;
  return push();
}

/** Catches a role's thrown error as `failed`, keeping the gates already run. */
export async function guarded(
  role: DropPayload['role'],
  gates: GateResult[],
  steps: () => Promise<DropResult>,
): Promise<DropResult> {
  try {
    return await steps();
  } catch (err) {
    return {
      status: 'failed',
      role,
      reason: err instanceof Error ? err.message : String(err),
      gates,
    };
  }
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * The agent's summary as an author report, cut to what the protocol accepts. Always present (empty
 * when the agent gave none): the server reads a missing key as an older trooper.
 */
export function reportOf(summary: string | undefined): { summary: string } {
  return { summary: (summary ?? '').slice(0, REPORT_MAX_CHARS) };
}

/** Usage metadata from the last result line, without undefined keys. */
export function resultMeta(outcome: AgentOutcome): Partial<DropResult> {
  const last = outcome.results.at(-1);
  return stripUndefined({
    usage: asRecord(last?.usage),
    modelUsage: asRecord(last?.modelUsage),
    servedModel: servedModel(last?.modelUsage) ?? undefined,
    numTurns: last?.numTurns,
    rateLimit: outcome.rateLimit,
  });
}
