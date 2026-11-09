import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DoctorDropPayload,
  type DoctorResult,
  type DropPayload,
  type DropResult,
  type GateResult,
  type RateLimitEventData,
  servedModel,
} from '@jumpmaster/protocol';
import { scrubEnv } from '../gates.js';
import type { TrooperDeps } from '../main.js';
import { sweepUid } from '../privilege.js';
import { redact } from '../redact.js';
import {
  emitEvent,
  gateExtraEnv,
  mirrorDirOf,
  type RoleCtx,
  repoDirOf,
  waitForServices,
} from './shared.js';

/** The probe: one fixed line, answered in one turn with no tool. Nothing from the repository. */
export const DOCTOR_PROBE = 'Reply with the single word: ok';

const MAX_ERROR = 500;

const errorText = (err: unknown, secrets: string[]): string =>
  redact(
    String(err instanceof Error ? err.message : err)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' '),
    secrets,
  ).slice(0, MAX_ERROR);

/**
 * The doctor role: proves on the zone's own stick, image and egress policy what the server can't
 * check from outside.
 *  1. Clone the default branch through the root mirror, with the read token or anonymously.
 *  2. Ask Claude one fixed line: one turn, every tool off, from an empty root-owned directory.
 *  3. Wait for each service, then run each gate as the gate user, credential-less; a red gate does
 *     not stop the others.
 * It never commits or pushes, and holds no write token. Its findings go back in `result.doctor`.
 */
export async function runDoctorRole(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (payload.role !== 'doctor') throw new Error(`not a doctor payload: ${payload.role}`);
  const as = ctx.ids?.agent ?? null;

  // 1. The clone.
  const dir = repoDirOf(ctx);
  let clone: DoctorResult['clone'];
  emitEvent(deps, ctx, 'phase', { phase: 'clone' });
  try {
    await deps.git.cloneRepo({
      owner: payload.repo.owner,
      name: payload.repo.name,
      token: payload.credentials.readToken ?? '',
      dir,
      mirrorDir: mirrorDirOf(ctx),
      as,
    });
    // A local branch at origin/<default>, so the clone has a HEAD; never pushed.
    await deps.git.prepareBranch(dir, 'jm-doctor', payload.repo.defaultBranch, as);
    clone = { ok: true, sha: await deps.git.headSha(dir, as) };
  } catch (err) {
    clone = { ok: false, error: errorText(err, ctx.secrets) };
  }

  // 2. The Claude probe.
  const probe = await claudeProbe(payload, deps, ctx);

  // 3. Services, then each gate on its own.
  const services: DoctorResult['services'] = [];
  for (const s of payload.services ?? []) {
    try {
      await waitForServices([s], (x) => x.name);
      services.push({ name: s.name, ok: true });
    } catch {
      services.push({ name: s.name, ok: false });
    }
  }
  const gates = clone.ok ? await runEachGate(payload, deps, ctx, dir) : [];

  const doctor: DoctorResult = { claude: probe.claude, clone, services, gates };
  return {
    status: 'completed',
    role: 'doctor',
    gates,
    doctor,
    ...(probe.rateLimit ? { rateLimit: probe.rateLimit } : {}),
    ...(probe.claude.servedModel ? { servedModel: probe.claude.servedModel } : {}),
  };
}

/** Runs one fixed prompt and reads the stream itself: an error field anywhere is the reason. */
async function claudeProbe(
  payload: DoctorDropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<{ claude: DoctorResult['claude']; rateLimit?: RateLimitEventData }> {
  const cwd = join(ctx.workdir, 'doctor-cwd');
  mkdirSync(cwd, { mode: 0o755 });
  chmodSync(cwd, 0o755);
  const settingsFile = join(ctx.workdir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ hooks: {} }));
  emitEvent(deps, ctx, 'phase', { phase: 'claude' });
  const args = [
    '-p',
    DOCTOR_PROBE,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    payload.model,
    '--max-turns',
    '1',
    '--tools',
    '',
    '--settings',
    settingsFile,
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
  ];
  const env: NodeJS.ProcessEnv = {
    ...scrubEnv(process.env, ctx.secrets),
    CLAUDE_CODE_OAUTH_TOKEN: payload.credentials.claudeToken,
  };
  let errorField: string | null = null;
  let resultLine: Record<string, unknown> | null = null;
  let exit: string | null = null;
  let rateLimit: RateLimitEventData | undefined;
  try {
    for await (const raw of deps.runClaude(args, env, cwd, ctx.ids?.agent ?? null, deps.signal)) {
      let m: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(raw);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
        m = v as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof m.error === 'string' && errorField === null) errorField = m.error;
      if (m.type === 'result') resultLine = m;
      else if (m.type === 'claude_stderr') {
        const stderr = typeof m.stderr === 'string' ? m.stderr : '';
        exit = `claude exit ${typeof m.exitCode === 'number' ? m.exitCode : 'by signal'}${stderr ? `: ${stderr}` : ''}`;
      } else if (m.type === 'rate_limit_event') {
        const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
        const status = info.status;
        if (status === 'allowed' || status === 'allowed_warning' || status === 'rejected') {
          rateLimit = {
            status,
            ...(typeof info.rateLimitType === 'string'
              ? { rateLimitType: info.rateLimitType }
              : {}),
            ...(typeof info.isUsingOverage === 'boolean'
              ? { isUsingOverage: info.isUsingOverage }
              : {}),
            ...(typeof info.overageStatus === 'string'
              ? { overageStatus: info.overageStatus }
              : {}),
          };
          const resets = info.resetsAt;
          if (typeof resets === 'number' || typeof resets === 'string') {
            const t = new Date(
              typeof resets === 'number' && resets < 1e12 ? resets * 1000 : resets,
            );
            if (Number.isFinite(t.getTime())) rateLimit.resetsAt = t.toISOString();
          }
          emitEvent(deps, ctx, 'rate_limit', rateLimit);
        }
      }
    }
  } catch (err) {
    exit = `claude did not start: ${err instanceof Error ? err.message : String(err)}`;
  }
  const fail = (why: string) => ({
    claude: { ok: false, error: redact(why, ctx.secrets).slice(0, MAX_ERROR) },
    ...(rateLimit ? { rateLimit } : {}),
  });
  if (rateLimit?.status === 'rejected')
    return fail(
      `the Claude usage limit was reached${rateLimit.resetsAt ? ` (resets ${rateLimit.resetsAt})` : ''}`,
    );
  if (errorField !== null) {
    const text = typeof resultLine?.result === 'string' ? `: ${resultLine.result}` : '';
    return fail(`${errorField}${text}`);
  }
  if (exit !== null) return fail(exit);
  if (resultLine === null) return fail('claude produced no result');
  if (resultLine.is_error === true) {
    const text = typeof resultLine.result === 'string' ? resultLine.result : '';
    return fail(
      `claude error: ${String(resultLine.subtype ?? 'unknown')}${text ? `: ${text}` : ''}`,
    );
  }
  const model = servedModel(resultLine.modelUsage);
  return {
    claude: { ok: true, ...(model ? { servedModel: model } : {}) },
    ...(rateLimit ? { rateLimit } : {}),
  };
}

/**
 * Every gate, each on its own so one red gate does not hide the next, as the gate user in a fresh
 * clone of HEAD (container mode) with no credential in its environment.
 */
async function runEachGate(
  payload: DoctorDropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  dir: string,
): Promise<GateResult[]> {
  emitEvent(deps, ctx, 'phase', { phase: 'gates' });
  const env = scrubEnv(process.env, ctx.secrets);
  const extraEnv = gateExtraEnv(payload);
  let cwd = dir;
  if (ctx.ids) {
    (deps.privilege?.sweepUid ?? sweepUid)(ctx.ids.agent.uid);
    cwd = join(ctx.ids.gate.home, 'repo');
    await deps.git.cloneForGates(dir, cwd, ctx.ids);
  }
  const results: GateResult[] = [];
  for (const gate of payload.gates) {
    const [r] = await deps.runGates([gate], {
      cwd,
      env,
      extraEnv,
      secrets: ctx.secrets,
      ...(ctx.ids ? { as: ctx.ids.gate } : {}),
    });
    if (!r) continue;
    results.push(r);
    emitEvent(deps, ctx, 'gate', {
      name: r.name,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      outputTail: r.outputTail,
    });
  }
  return results;
}
