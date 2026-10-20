import { join } from 'node:path';
import { type DropPayload, type DropResult, IMPLEMENT_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import {
  acceptOutcome,
  checkpoint,
  cloneAndPrepare,
  emitEvent,
  pushSweep,
  type RoleCtx,
  resultMeta,
  runAgent,
  runGatesPhase,
  stoppedEarly,
} from './shared.js';

/**
 * Implement: a fresh branch (or the resumed one), one Claude run, then commit, gates and a guarded
 * push. A limit or turn cap checkpoints the work instead so the server can resume it.
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
  const forgeToken = payload.credentials.forgeToken as string;
  const base = payload.repo.defaultBranch;
  const target = { owner: payload.repo.owner, name: payload.repo.name };
  const as = ctx.ids?.agent ?? null;
  const resumeSha = payload.resume ? payload.resumeSha : undefined;
  if (payload.resume && resumeSha === undefined) throw new Error('resume requires resumeSha');

  const repoDir = await cloneAndPrepare(payload, deps, ctx);
  if (resumeSha !== undefined) {
    emitEvent(deps, ctx, 'phase', { phase: 'resume', branch: payload.branch });
    await deps.git.mirrorFetch(join(ctx.workdir, 'mirror'), forgeToken, target, [payload.branch]);
    await deps.git.checkoutBranch(repoDir, payload.branch, resumeSha, as);
  } else {
    // Fail fast: the server resumes items whose branch exists, so a fresh drop must not find one.
    if ((await deps.git.remoteBranchSha(target, payload.branch, forgeToken)) !== null) {
      return {
        status: 'failed',
        reason: `branch ${payload.branch} already exists on remote`,
        gates,
      };
    }
    emitEvent(deps, ctx, 'phase', { phase: 'branch', branch: payload.branch });
    await deps.git.prepareBranch(repoDir, payload.branch, base, as);
  }

  const guard = { as, base, protectedPaths: payload.protectedPaths, secrets: ctx.secrets };
  const push = (expectSha?: string): Promise<string> => {
    emitEvent(deps, ctx, 'phase', { phase: 'push' });
    const o = expectSha === undefined ? guard : { ...guard, expectSha };
    return resumeSha !== undefined
      ? deps.git.pushExistingBranch(
          repoDir,
          payload.branch,
          forgeToken,
          target,
          resumeSha,
          pushSweep(deps, ctx),
          o,
        )
      : deps.git.pushNewBranch(
          repoDir,
          payload.branch,
          forgeToken,
          target,
          pushSweep(deps, ctx),
          o,
        );
  };

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
    const headSha = await checkpoint(deps, ctx, repoDir, base, () => push());
    return done(headSha === undefined ? { status: early } : { status: early, headSha });
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

  // Gates test HEAD; the push must carry exactly that commit.
  const gatedSha = await deps.git.headSha(repoDir, as);
  gates.push(...(await runGatesPhase(payload, deps, ctx, repoDir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

  return done({ status: 'completed', headSha: await push(gatedSha) });
}
