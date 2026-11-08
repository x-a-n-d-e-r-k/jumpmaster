import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CrewDropPayload,
  type CrewRole,
  crewOutputJsonSchema,
  type DropPayload,
  type DropResult,
  isCrewRole,
  parseCrewOutput,
} from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import { redact } from '../redact.js';
import {
  acceptOutcome,
  cloneAndPrepare,
  emitEvent,
  guarded,
  type RoleCtx,
  resultMeta,
  runAgent,
  stoppedEarly,
} from './shared.js';

/** Every string in a crew output, redacted; numbers, booleans and structure kept. */
function redactDeep(v: unknown, secrets: string[]): unknown {
  if (typeof v === 'string') return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, secrets)]));
  }
  return v;
}

/**
 * The empty, root-owned working directory a crew agent runs from. The clone is reached only through
 * `--add-dir`, so its CLAUDE.md, `.claude/` and `.mcp.json` are never loaded as instructions.
 */
function crewCwd(ctx: RoleCtx): string {
  const dir = join(ctx.workdir, 'crew-cwd');
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  return dir;
}

/**
 * A crew role (crew-lead, refute, diagnose): a read-only clone, no gates, no verification, no
 * services, never a commit or a push. The structured output goes back to the server, which decides
 * what, if anything, it leads to.
 */
export async function runCrew(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (!isCrewRole(payload.role)) throw new Error(`not a crew payload: ${payload.role}`);
  const crew = payload as CrewDropPayload;
  return guarded(crew.role, [], () => crewSteps(crew, crew.role, deps, ctx));
}

async function crewSteps(
  payload: CrewDropPayload,
  role: CrewRole,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  const as = ctx.ids?.agent ?? null;
  const clone = await cloneAndPrepare(payload, deps, ctx);
  if (payload.role === 'diagnose' && payload.checkout) {
    emitEvent(deps, ctx, 'phase', { phase: 'checkout', branch: payload.checkout.branch });
    await deps.git.checkoutBranch(clone, payload.checkout.branch, payload.checkout.headSha, as);
  } else {
    // A local branch at origin/<default>, so the clone has a HEAD; it is never pushed.
    await deps.git.prepareBranch(clone, 'jm-crew', payload.repo.defaultBranch, as);
  }
  // The repo's agent instructions (`.claude/`, `CLAUDE*.md`, `.mcp.json`) are removed so nothing in
  // the clone can load as instructions, whatever the CLI's discovery rules. As the clone's owner:
  // root has no DAC_OVERRIDE. Never committed back: a crew drop never pushes, and the snapshot is after.
  const stripped = await deps.git.removeInstructionFiles(clone, as);
  if (stripped.length > 0) emitEvent(deps, ctx, 'phase', { phase: 'strip', removed: stripped });
  const cwd = crewCwd(ctx);
  const before = await deps.git.treeState(clone, as);
  const outcome = await runAgent(
    payload,
    deps,
    ctx,
    { prompt: payload.prompt, outputSchema: crewOutputJsonSchema(role), addDirs: [clone] },
    cwd,
  );
  const done = (r: Omit<DropResult, 'gates' | 'role'>): DropResult => ({
    ...resultMeta(outcome),
    ...r,
    role,
    gates: [],
  });

  const early = stoppedEarly(outcome);
  if (early !== null) return done({ status: early });
  const accepted = acceptOutcome(outcome);
  if (!accepted.ok) return done({ status: 'failed', reason: accepted.reason });
  if (accepted.result.isError) {
    return done({
      status: 'failed',
      reason: `claude error: ${accepted.result.terminalReason ?? 'unknown'}`,
    });
  }
  // Any change, a commit included, fails the drop; nothing is ever pushed from here.
  if ((await deps.git.treeState(clone, as)) !== before) {
    return done({ status: 'failed', reason: 'crew modified the tree' });
  }
  const parsed = parseCrewOutput(role, accepted.result.structured);
  if (!parsed.ok)
    return done({ status: 'failed', reason: `invalid crew output: ${parsed.reason}` });
  return done({ status: 'completed', crew: redactDeep(parsed.value, ctx.secrets) });
}
