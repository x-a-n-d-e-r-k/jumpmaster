import { join } from 'node:path';
import type { DropPayload, DropResult, MergeOutcome } from '@jumpmaster/protocol';
import { IMPLEMENT_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import {
  type AgentOutcome,
  acceptOutcome,
  cloneAndPrepare,
  emitEvent,
  guarded,
  pushSweep,
  type RoleCtx,
  resultMeta,
  runAgent,
  runGatesPhase,
  stoppedEarly,
} from './shared.js';

type ResolvePayload = Extract<DropPayload, { role: 'resolve' }>;

/**
 * Resolve: merge the base into the PR branch. A clean merge needs no agent; conflicts go to Claude,
 * and the merge must be concluded with no markers left before gates and a leased push.
 */
export async function runResolve(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (payload.role !== 'resolve') throw new Error(`not a resolve payload: ${payload.role}`);
  const gates: DropResult['gates'] = [];
  const state: { mergeOutcome?: MergeOutcome } = {};
  const r = await guarded('resolve', gates, () => resolveSteps(payload, deps, ctx, gates, state));
  return state.mergeOutcome === undefined ? r : { ...r, mergeOutcome: state.mergeOutcome };
}

async function resolveSteps(
  payload: ResolvePayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  gates: DropResult['gates'],
  state: { mergeOutcome?: MergeOutcome },
): Promise<DropResult> {
  const forgeToken = payload.credentials.forgeToken as string;
  const base = payload.repo.defaultBranch;
  const target = { owner: payload.repo.owner, name: payload.repo.name };
  const as = ctx.ids?.agent ?? null;
  const { branch, headSha: prHead } = payload.pr;

  const dir = await cloneAndPrepare(payload, deps, ctx);
  await deps.git.mirrorFetch(join(ctx.workdir, 'mirror'), forgeToken, target, [branch, base]);
  emitEvent(deps, ctx, 'phase', { phase: 'checkout', branch });
  await deps.git.checkoutBranch(dir, branch, prHead, as);

  emitEvent(deps, ctx, 'phase', { phase: 'merge', base });
  const merge = await deps.git.mergeBase(dir, base, as);
  state.mergeOutcome = merge;
  let outcome: AgentOutcome | undefined;
  const done = (r: Omit<DropResult, 'gates' | 'role'>): DropResult => ({
    ...(outcome ? resultMeta(outcome) : {}),
    ...r,
    role: 'resolve',
    gates,
  });
  if (merge === 'up_to_date') return done({ status: 'no_changes' });

  if (merge === 'conflicts') {
    outcome = await runAgent(
      payload,
      deps,
      ctx,
      { prompt: payload.prompt, outputSchema: IMPLEMENT_OUTPUT_SCHEMA },
      dir,
    );
    // A half-resolved merge is not checkpointed: the next resolve starts the merge afresh.
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
    const structured = accepted.result.structured as
      | { status?: string; summary?: string }
      | undefined;
    if (structured?.status === 'BLOCKED') {
      return done({ status: 'blocked', reason: structured.summary ?? 'blocked' });
    }
    if (structured?.status !== 'COMPLETE') {
      return done({ status: 'failed', reason: 'claude returned no valid structured output' });
    }
    const markers = await deps.git.conflictMarkers(dir, as);
    if (markers.length > 0) {
      return done({ status: 'failed', reason: `conflict markers left in ${markers.join(', ')}` });
    }
    emitEvent(deps, ctx, 'phase', { phase: 'commit' });
    await deps.git.commitIfDirty(dir, `Merge origin/${base}`, as);
    if (await deps.git.mergeInProgress(dir, as)) {
      return done({ status: 'failed', reason: 'merge not concluded' });
    }
  }

  // Gates test HEAD; the push must carry exactly that commit.
  const gatedSha = await deps.git.headSha(dir, as);
  gates.push(...(await runGatesPhase(payload, deps, ctx, dir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

  emitEvent(deps, ctx, 'phase', { phase: 'push' });
  const headSha = await deps.git.pushExistingBranch(
    dir,
    branch,
    forgeToken,
    target,
    prHead,
    pushSweep(deps, ctx),
    {
      as,
      base,
      protectedPaths: payload.protectedPaths,
      secrets: ctx.secrets,
      expectSha: gatedSha,
    },
  );
  return done({ status: 'completed', headSha });
}
