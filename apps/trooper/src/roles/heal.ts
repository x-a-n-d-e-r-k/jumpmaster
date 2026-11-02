import { join } from 'node:path';
import type { DropPayload, DropResult } from '@jumpmaster/protocol';
import { IMPLEMENT_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import {
  acceptOutcome,
  checkpoint,
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

type HealPayload = Extract<DropPayload, { role: 'heal' }>;

/** Heal: address feedback on the PR head and push onto it, leased on that head. */
export async function runHeal(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (payload.role !== 'heal') throw new Error(`not a heal payload: ${payload.role}`);
  const gates: DropResult['gates'] = [];
  return guarded('heal', gates, () => healSteps(payload, deps, ctx, gates));
}

async function healSteps(
  payload: HealPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  gates: DropResult['gates'],
): Promise<DropResult> {
  const forgeToken = payload.credentials.forgeToken as string;
  const base = payload.repo.defaultBranch;
  const target = { owner: payload.repo.owner, name: payload.repo.name };
  const as = ctx.ids?.agent ?? null;
  const { branch, headSha: prHead } = payload.pr;

  const dir = await cloneAndPrepare(payload, deps, ctx);
  await deps.git.mirrorFetch(join(ctx.workdir, 'mirror'), forgeToken, target, [branch]);
  emitEvent(deps, ctx, 'phase', { phase: 'checkout', branch });
  await deps.git.checkoutBranch(dir, branch, prHead, as);

  const push = (expectSha?: string): Promise<string> => {
    emitEvent(deps, ctx, 'phase', { phase: 'push' });
    return deps.git.pushExistingBranch(
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
        ...(expectSha === undefined ? {} : { expectSha }),
      },
    );
  };

  // The server renders the feedback under its own heading; it follows the role prompt as data.
  const prompt = `${payload.prompt}\n\n${payload.feedback}`;
  const outcome = await runAgent(
    payload,
    deps,
    ctx,
    { prompt, outputSchema: IMPLEMENT_OUTPUT_SCHEMA },
    dir,
  );
  const done = (r: Omit<DropResult, 'gates' | 'role'>): DropResult => ({
    ...resultMeta(outcome),
    ...r,
    role: 'heal',
    gates,
  });

  const early = stoppedEarly(outcome);
  if (early !== null) {
    const headSha = await checkpoint(deps, ctx, dir, base, () => push());
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
  await deps.git.commitIfDirty(dir, `fix: address review on #${payload.pr.number}`, as);
  // Compare HEAD, not the commit flag: commits the agent made itself are changes too.
  if ((await deps.git.headSha(dir, as)) === prHead) {
    return done({ status: 'no_changes', reason: structured.summary });
  }

  // Gates test HEAD; the push must carry exactly that commit.
  const gatedSha = await deps.git.headSha(dir, as);
  gates.push(...(await runGatesPhase(payload, deps, ctx, dir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) return done({ status: 'failed', reason: `gate ${failed.name} failed` });

  return done({ status: 'completed', headSha: await push(gatedSha) });
}
