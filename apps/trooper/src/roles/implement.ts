import { type DropPayload, type DropResult, IMPLEMENT_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import {
  cloneAndPrepare,
  emitEvent,
  pushSweep,
  type RoleCtx,
  resultMeta,
  runAgent,
  runGatesPhase,
} from './shared.js';

/** The M0 implement flow: fresh branch, one Claude run, commit, gates, push. */
export async function runImplement(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  const gates: DropResult['gates'] = [];
  try {
    return await implementSteps(payload, deps, ctx, gates);
  } catch (err) {
    // Gates already run are still reported, as in M0.
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err), gates };
  }
}

async function implementSteps(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  gates: DropResult['gates'],
): Promise<DropResult> {
  const forgeToken = payload.credentials.forgeToken as string;
  const base = payload.repo.defaultBranch;
  const target = { owner: payload.repo.owner, name: payload.repo.name };
  const as = ctx.ids?.agent ?? null;
  const repoDir = await cloneAndPrepare(payload, deps, ctx);
  // Fail fast: the push refuses an existing branch, so don't burn a whole Claude run first.
  if (await deps.git.remoteBranchExists(target, payload.branch, forgeToken)) {
    return {
      status: 'failed',
      reason: `branch ${payload.branch} already exists on remote`,
      gates: [],
    };
  }
  emitEvent(deps, ctx, 'phase', { phase: 'branch', branch: payload.branch });
  await deps.git.prepareBranch(repoDir, payload.branch, base, as);

  const outcome = await runAgent(
    payload,
    deps,
    ctx,
    { prompt: payload.prompt, outputSchema: IMPLEMENT_OUTPUT_SCHEMA },
    repoDir,
  );
  const done = (r: Omit<DropResult, 'gates'>): DropResult => ({
    ...resultMeta(outcome),
    ...r,
    gates,
  });

  const result = outcome.results.at(-1);
  const exitNote = outcome.exitCode === null ? '' : ` (claude exit ${outcome.exitCode})`;
  if (result === undefined)
    return done({ status: 'failed', reason: `claude produced no result${exitNote}` });
  if (result.isError) {
    return done({
      status: 'failed',
      reason: `claude error: ${result.terminalReason ?? 'unknown'}${exitNote}`,
    });
  }
  const structured = result.structured as { status?: string; summary?: string } | undefined;
  if (structured?.status === 'BLOCKED') {
    return done({ status: 'blocked', reason: structured.summary ?? 'blocked' });
  }
  if (structured?.status !== 'COMPLETE') {
    return done({
      status: 'failed',
      reason: `claude returned no valid structured output${exitNote}`,
    });
  }

  emitEvent(deps, ctx, 'phase', { phase: 'commit' });
  await deps.git.commitIfDirty(repoDir, `feat: implement #${payload.issue.number}`, as);
  if ((await deps.git.aheadOfBase(repoDir, base, as)) === 0) {
    return done({ status: 'no_changes', reason: structured.summary });
  }

  gates.push(...(await runGatesPhase(payload, deps, ctx, repoDir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

  emitEvent(deps, ctx, 'phase', { phase: 'push' });
  const headSha = await deps.git.pushNewBranch(
    repoDir,
    payload.branch,
    forgeToken,
    target,
    pushSweep(deps, ctx),
    { as, base, protectedPaths: payload.protectedPaths },
  );
  return done({ status: 'completed', headSha });
}
