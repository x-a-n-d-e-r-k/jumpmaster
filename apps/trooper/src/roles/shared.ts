import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DropPayload,
  type DropResult,
  EVENT_PREFIX,
  type GateResult,
  type RateLimitEventData,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { buildClaudeArgs, type ParsedLine, parseStreamLine } from '../claude.js';
import { capEventData } from '../events.js';
import { scrubEnv } from '../gates.js';
import type { TrooperDeps } from '../main.js';
import { sweepUid, type TrooperIdentities } from '../privilege.js';
import { redact } from '../redact.js';

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
export function repoDirOf(ctx: RoleCtx): string {
  return ctx.ids ? join(ctx.ids.agent.home, 'repo') : join(ctx.workdir, 'repo');
}

/** Clones through the root mirror at `<workdir>/mirror`; returns the working copy. */
export async function cloneAndPrepare(
  payload: DropPayload,
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
    mirrorDir: join(ctx.workdir, 'mirror'),
    as: ctx.ids?.agent ?? null,
  });
  return dir;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Runs Claude in `dir` as the agent identity and collects what the stream reported. */
export async function runAgent(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  o: { prompt: string; outputSchema: object },
  dir: string,
): Promise<AgentOutcome> {
  const systemPromptFile = join(ctx.workdir, 'system.md');
  const settingsFile = join(ctx.workdir, 'settings.json');
  const gateList = payload.gates.map((g) => `- ${g.name}: ${g.run}`).join('\n');
  writeFileSync(
    systemPromptFile,
    `Before finishing, run these commands and make them pass:\n${gateList}\n`,
  );
  writeFileSync(settingsFile, JSON.stringify({ hooks: {} }));

  emitEvent(deps, ctx, 'phase', { phase: 'claude' });
  const args = buildClaudeArgs({
    prompt: o.prompt,
    model: payload.model,
    maxTurns: payload.maxTurns,
    systemPromptFile,
    settingsFile,
    outputSchema: o.outputSchema,
  });
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env, ctx.secrets),
    CLAUDE_CODE_OAUTH_TOKEN: payload.credentials.claudeToken,
  };
  const out: AgentOutcome = {
    exitCode: null,
    results: [],
    initSessionId: null,
    rateLimited: false,
  };
  for await (const line of deps.runClaude(args, env, dir, ctx.ids?.agent ?? null, deps.signal)) {
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
      });
      out.rateLimit = data;
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

/**
 * Gates see committed HEAD only. In container mode the agent uid is swept first and the gates run
 * as the gate uid in a fresh clone; otherwise they run in the working copy, as in M0.
 */
export async function runGatesPhase(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  dir: string,
): Promise<GateResult[]> {
  emitEvent(deps, ctx, 'phase', { phase: 'gates' });
  const env = scrubEnv(process.env, ctx.secrets);
  let results: GateResult[];
  if (ctx.ids) {
    (deps.privilege?.sweepUid ?? sweepUid)(ctx.ids.agent.uid);
    const gateDir = join(ctx.ids.gate.home, 'repo');
    await deps.git.cloneForGates(dir, gateDir, ctx.ids);
    results = await deps.runGates(payload.gates, {
      cwd: gateDir,
      env,
      secrets: ctx.secrets,
      as: ctx.ids.gate,
    });
  } else {
    results = await deps.runGates(payload.gates, { cwd: dir, env, secrets: ctx.secrets });
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

/** Usage metadata from the last result line, without undefined keys. */
export function resultMeta(outcome: AgentOutcome): Partial<DropResult> {
  const last = outcome.results.at(-1);
  return stripUndefined({
    usage: asRecord(last?.usage),
    modelUsage: asRecord(last?.modelUsage),
    numTurns: last?.numTurns,
    rateLimit: outcome.rateLimit,
  });
}
