import {
  type DropPayload,
  type DropResult,
  REVIEW_OUTPUT_SCHEMA,
  type Verdict,
  VerdictSchema,
} from '@jumpmaster/protocol';
import type { TrooperDeps } from '../main.js';
import { redact } from '../redact.js';
import {
  acceptOutcome,
  cloneAndPrepare,
  emitEvent,
  type RoleCtx,
  resultMeta,
  runAgent,
  runGatesPhase,
  stoppedEarly,
} from './shared.js';

type ReviewPayload = Extract<DropPayload, { role: 'review' }>;

/**
 * Review: check out the PR head, run the gates, then ask Claude for a verdict. Never commits or
 * pushes; the server binds the verdict to `pr.headSha` and posts it with the reviewer identity.
 */
export async function runReview(
  payload: DropPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
): Promise<DropResult> {
  if (payload.role !== 'review') throw new Error(`not a review payload: ${payload.role}`);
  const gates: DropResult['gates'] = [];
  try {
    return await reviewSteps(payload, deps, ctx, gates);
  } catch (err) {
    return {
      status: 'failed',
      role: 'review',
      reason: err instanceof Error ? err.message : String(err),
      gates,
    };
  }
}

async function reviewSteps(
  payload: ReviewPayload,
  deps: TrooperDeps,
  ctx: RoleCtx,
  gates: DropResult['gates'],
): Promise<DropResult> {
  const as = ctx.ids?.agent ?? null;
  const dir = await cloneAndPrepare(payload, deps, ctx);
  emitEvent(deps, ctx, 'phase', { phase: 'checkout', branch: payload.pr.branch });
  await deps.git.checkoutBranch(dir, payload.pr.branch, payload.pr.headSha, as);

  gates.push(...(await runGatesPhase(payload, deps, ctx, dir)));
  const failed = gates.find((g) => g.timedOut || g.exitCode !== 0);
  if (failed) {
    const detail = failed.timedOut ? `gate ${failed.name} timed out` : `gate ${failed.name} failed`;
    return {
      status: 'completed',
      role: 'review',
      verdict: clean(
        {
          decision: 'request_changes',
          summary: detail,
          findings: [{ severity: 'blocker', detail }],
        },
        ctx.secrets,
      ),
      gates,
    };
  }

  // Recorded after the gates, so their build output is not mistaken for an edit by the reviewer.
  const before = await deps.git.treeState(dir, as);
  const outcome = await runAgent(
    payload,
    deps,
    ctx,
    { prompt: payload.prompt, outputSchema: REVIEW_OUTPUT_SCHEMA },
    dir,
  );
  const done = (r: Omit<DropResult, 'gates' | 'role'>): DropResult => ({
    ...resultMeta(outcome),
    ...r,
    role: 'review',
    gates,
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
  if ((await deps.git.treeState(dir, as)) !== before) {
    return done({ status: 'failed', reason: 'review modified the tree' });
  }
  const parsed = VerdictSchema.safeParse(accepted.result.structured);
  if (!parsed.success)
    return done({ status: 'failed', reason: 'claude returned no valid verdict' });
  return done({ status: 'completed', verdict: clean(parsed.data, ctx.secrets) });
}

function clean(v: Verdict, secrets: string[]): Verdict {
  const r = (s: string): string => redact(s, secrets);
  return {
    decision: v.decision,
    summary: r(v.summary),
    findings: v.findings.map((f) => ({
      severity: f.severity,
      ...(f.file === undefined ? {} : { file: r(f.file) }),
      detail: r(f.detail),
    })),
  };
}
