import { type DropPayload, type DropResult, IMPLEMENT_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import { repoTarget } from '../git.js';
import type { TrooperDeps } from '../main.js';
import {
  acceptOutcome,
  checkpoint,
  cloneAndPrepare,
  completedWith,
  earlyStop,
  emitEvent,
  mirrorDirOf,
  mirrorProvided,
  type RoleCtx,
  reportOf,
  resultMeta,
  runAgent,
  runGatesPhase,
  stoppedEarly,
} from './shared.js';

/**
 * Implement: a fresh branch (or the resumed one), one Claude run, then commit and gates. It never
 * pushes: a completed result asks for a final push of the gated commit, and a limit or turn cap
 * asks for a checkpoint push so the server can resume it. The push container does the push.
 */
export async function runImplement(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (payload.role !== 'implement') throw new Error(`not an implement payload: ${payload.role}`);
  const gates: DropResult['gates'] = [];
  try {
    return await implementSteps(payload, deps, ctx, gates);
  } catch (err) {
    // Gates already run are still reported, as in M0.
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err), gates };
  }
}

type ImplementPayload = Extract<DropPayload, { role: 'implement' }>;

async function implementSteps(
  payload: ImplementPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  gates: DropResult['gates'],
): Promise<DropResult> {
  const base = payload.repo.defaultBranch;
  const target = repoTarget(payload.repo);
  const as = ctx.ids?.agent ?? null;
  const resumeSha = payload.resume ? payload.resumeSha : undefined;
  if (payload.resume && resumeSha === undefined) throw new Error('resume requires resumeSha');

  // A provided mirror already holds every head: nothing is fetched and the remote is never asked.
  const provided = mirrorProvided(payload);
  const mirrorDir = mirrorDirOf(ctx, payload);
  const repoDir = await cloneAndPrepare(payload, deps, ctx);
  if (resumeSha !== undefined) {
    emitEvent(deps, ctx, 'phase', { phase: 'resume', branch: payload.branch });
    if (!provided) {
      const forgeToken = payload.credentials.forgeToken as string;
      await deps.git.mirrorFetch(mirrorDir, forgeToken, target, [payload.branch]);
    }
    await deps.git.checkoutBranch(repoDir, payload.branch, resumeSha, as);
  } else {
    // Fail fast: the server resumes items whose branch exists, so a fresh drop must not find one.
    const existing = provided
      ? await deps.git.mirrorBranchSha(mirrorDir, payload.branch)
      : await deps.git.remoteBranchSha(
          target,
          payload.branch,
          payload.credentials.forgeToken as string,
        );
    if (existing !== null) {
      return {
        status: 'failed',
        reason: `branch ${payload.branch} already exists on remote`,
        gates,
      };
    }
    emitEvent(deps, ctx, 'phase', { phase: 'branch', branch: payload.branch });
    await deps.git.prepareBranch(repoDir, payload.branch, base, as);
  }

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

  const early = stoppedEarly(outcome);
  if (early !== null) {
    return done(earlyStop(early, await checkpoint(deps, ctx, repoDir, base)));
  }

  const accepted = acceptOutcome(outcome);
  if (!accepted.ok) return done({ status: 'failed', reason: accepted.reason });
  const result = accepted.result;
  if (result.isError) {
    return done({
      status: 'failed',
      reason: `claude error: ${result.terminalReason ?? 'unknown'}`,
    });
  }
  const structured = result.structured as { status?: string; summary?: string } | undefined;
  if (structured?.status === 'BLOCKED') {
    return done({ status: 'blocked', reason: structured.summary ?? 'blocked' });
  }
  if (structured?.status !== 'COMPLETE') {
    return done({ status: 'failed', reason: 'claude returned no valid structured output' });
  }

  emitEvent(deps, ctx, 'phase', { phase: 'commit' });
  await deps.git.commitIfDirty(repoDir, `feat: implement #${payload.issue.number}`, as);
  if ((await deps.git.aheadOfBase(repoDir, base, as)) === 0) {
    return done({ status: 'no_changes', reason: structured.summary });
  }

  // Gates test HEAD; the push container must push exactly that commit.
  const gatedSha = await deps.git.headSha(repoDir, as);
  gates.push(...(await runGatesPhase(payload, deps, ctx, repoDir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

  return done({ ...completedWith(gatedSha), ...reportOf(structured.summary) });
}
