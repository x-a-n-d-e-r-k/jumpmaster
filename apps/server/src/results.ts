import { randomUUID } from 'node:crypto';
import {
  agentBranch,
  type DropResult,
  type GateResult,
  type Role,
  type Verdict,
} from '@jumpmaster/protocol';
import type { DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  type Drop,
  type DropState,
  getDrop,
  getUsageState,
  getWorkItem,
  insertDrop,
  insertVerdict,
  setWorkItemState,
  updateDrop,
  upsertPullRequest,
  type WorkItem,
} from './db/repo.js';
import {
  chargeBudget,
  chargeNoChange,
  chargeRateLimitRequeue,
  chargeResolveConflict,
  refundCharge,
} from './flow/budgets.js';
import {
  type CreatePrPayload,
  type ForgePair,
  opKeys,
  type PostReviewPayload,
  runOp,
  sanitizeForgeText,
} from './outbox.js';
import { promptVersions } from './payloads.js';
import { ingestRateLimit, releaseProbe } from './usage.js';

/** `usageCfg` and `rand` are consumed by the usage ingest and probe release (Task 10). */
export type ResultDeps = {
  forges: ForgePair;
  zone: DropZoneConfig;
  secrets: string[];
  usageCfg: UsageConfig;
  rand?: () => number;
};

const TERMINAL: ReadonlySet<DropState> = new Set(['succeeded', 'failed', 'lost', 'cancelled']);

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function gateTable(gates: GateResult[]): string {
  const rows = gates.map((g) => {
    const exit = g.timedOut ? 'timeout' : g.exitCode === null ? 'n/a' : String(g.exitCode);
    return `| ${cell(g.name)} | ${exit} | ${(g.durationMs / 1000).toFixed(1)} |`;
  });
  return ['| Gate | Exit | Duration (s) |', '| --- | --- | --- |', ...rows].join('\n');
}

/** A gate that did not exit 0 (timed out, non-zero, or no exit code) is red. */
const isRed = (g: GateResult): boolean => g.timedOut || g.exitCode !== 0;

/** A code span that survives backticks inside `s`. */
function codeSpan(s: string): string {
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${s} ${fence}` : `${fence}${s}${fence}`;
}

/** Review body: summary, findings as a list (files in code spans), red gates; all sanitised. */
export function renderReviewBody(v: Verdict, gates: GateResult[], secrets: string[]): string {
  const lines = [v.summary.trim()];
  if (v.findings.length > 0) {
    lines.push('', '### Findings', '');
    for (const f of v.findings) {
      const where = f.file ? ` ${codeSpan(cell(f.file))}` : '';
      lines.push(`- **${f.severity}**${where}: ${cell(f.detail)}`);
    }
  }
  const red = gates.filter(isRed);
  if (red.length > 0) {
    const names = red.map(
      (g) =>
        `${codeSpan(cell(g.name))} (${g.timedOut ? 'timeout' : `exit ${g.exitCode ?? 'n/a'}`})`,
    );
    lines.push('', `Gates failed: ${names.join(', ')}`);
  }
  return sanitizeForgeText(lines.join('\n'), secrets);
}

type Ctx = { db: Db; deps: ResultDeps; drop: Drop; item: WorkItem; now: Date };

const finish = (c: Ctx, state: DropState) => updateDrop(c.db, c.drop.id, { state });

const park = (c: Ctx, reason: string, dropState: DropState) => {
  setWorkItemState(c.db, c.item.id, 'parked', reason, c.now);
  finish(c, dropState);
};

/** Inserts the replacement for `c.drop`, which must already be terminal. */
function insertReplacement(c: Ctx, headSha: string | null, chargedKey: string | null): void {
  const role = c.drop.role as Role;
  insertDrop(
    c.db,
    {
      id: randomUUID(),
      dropZoneId: c.drop.dropZoneId,
      workItemId: c.item.id,
      role,
      state: 'queued',
      promptVersion: promptVersions()[role],
      image: c.deps.zone.image,
      fingerprint: c.drop.fingerprint,
      prNumber: c.drop.prNumber,
      inputJson: c.drop.inputJson,
      headSha,
      chargedKey,
    },
    c.now,
  );
}

/** Continuation of an interrupted drop: charged to `resume`, parked when that is exhausted. */
function continueInterrupted(c: Ctx, headSha: string | null): void {
  c.db.transaction(() => {
    const charge = chargeBudget(
      c.db,
      c.item.id,
      'resume',
      c.drop.fingerprint ?? '',
      c.deps.zone.budgets,
    );
    if (!charge.ok) return park(c, charge.reason, 'succeeded');
    finish(c, 'succeeded');
    insertReplacement(c, headSha, charge.charged.join(','));
  })();
}

function rateLimited(c: Ctx, wasProbe: boolean, result: DropResult): void {
  c.db.transaction(() => {
    const usage = getUsageState(c.db);
    const paused =
      usage.status === 'rejected' ||
      (usage.pausedUntil !== null && Date.parse(usage.pausedUntil) > c.now.getTime());
    if (!paused || !(wasProbe || chargeRateLimitRequeue(c.db, c.item.id))) {
      return park(c, 'rate limit: requeue refused', 'cancelled');
    }
    finish(c, 'cancelled');
    refundCharge(c.db, c.item.id, c.drop.chargedKey);
    insertReplacement(c, result.headSha ?? c.drop.headSha, null);
  })();
}

async function implementResult(c: Ctx, result: DropResult): Promise<void> {
  const { db, item } = c;
  switch (result.status) {
    case 'completed': {
      const headSha = result.headSha;
      if (!headSha) return park(c, 'completed without headSha', 'failed');
      const base = db
        .prepare('SELECT default_branch AS defaultBranch FROM drop_zones WHERE id = ?')
        .get(c.drop.dropZoneId) as { defaultBranch: string };
      const head = agentBranch(item.issueNumber);
      const body = [
        `Implements #${item.issueNumber}.`,
        '',
        '### Gates',
        '',
        gateTable(result.gates),
        '',
        `Closes #${item.issueNumber}`,
      ].join('\n');
      const payload: CreatePrPayload = {
        head,
        base: base.defaultBranch,
        title: item.title,
        body: sanitizeForgeText(body, c.deps.secrets),
      };
      const op = await runOp(
        db,
        c.deps.forges,
        { kind: 'create_pr', opKey: opKeys.pr(item.id, headSha), itemId: item.id, payload },
        c.now,
      );
      db.transaction(() => {
        if (op.state === 'done') {
          const number = (op.result as { number: number }).number;
          upsertPullRequest(
            db,
            { workItemId: item.id, number, headRef: head, headSha, state: 'open' },
            c.now,
          );
          setWorkItemState(db, item.id, 'pr_open', undefined, c.now);
        } else if (op.state === 'failed') {
          return park(c, `create pr failed: ${op.error ?? 'unknown error'}`, 'succeeded');
        }
        // `unknown`: the item stays in_flight until adoption or reconcile settles the op.
        finish(c, 'succeeded');
      })();
      return;
    }
    case 'interrupted':
      return continueInterrupted(c, result.headSha ?? c.drop.headSha);
    case 'no_changes':
      return db.transaction(() => {
        if (!chargeNoChange(db, item.id, c.deps.zone.budgets)) {
          return park(c, 'no_changes', 'succeeded');
        }
        setWorkItemState(db, item.id, 'ready', undefined, c.now);
        finish(c, 'succeeded');
      })();
    default:
      if (result.status === 'failed' && IMPLEMENT_FENCED.test(result.reason ?? '')) {
        // Another trooper (or a human) owns the branch now: resume() continues from it.
        return db.transaction(() => {
          setWorkItemState(db, item.id, 'ready', undefined, c.now);
          finish(c, 'failed');
        })();
      }
      return park(
        c,
        result.reason ?? result.status,
        result.status === 'failed' ? 'failed' : 'succeeded',
      );
  }
}

const IMPLEMENT_FENCED = /^(stale info|branch \S+ already exists on remote)/;

async function reviewResult(c: Ctx, result: DropResult): Promise<void> {
  const { db, drop, item } = c;
  const verdict = result.status === 'completed' ? result.verdict : undefined;
  if (!verdict || drop.prNumber === null || drop.headSha === null) {
    // A failed review leaves the item pr_open; the next same-head review is charged as a repeat.
    return finish(c, 'failed');
  }
  const forced = verdict.decision === 'approve' && result.gates.some(isRed);
  const decision = forced ? 'request_changes' : verdict.decision;
  insertVerdict(db, {
    id: drop.id,
    workItemId: item.id,
    headSha: drop.headSha,
    decision,
    forced,
    summary: verdict.summary,
    findingsJson: JSON.stringify(verdict.findings),
    gatesJson: JSON.stringify(result.gates),
    createdAt: c.now.toISOString(),
  });
  const payload: PostReviewPayload = {
    pr: drop.prNumber,
    event: decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
    commitId: drop.headSha,
    body: renderReviewBody({ ...verdict, decision }, result.gates, c.deps.secrets),
  };
  await runOp(
    db,
    c.deps.forges,
    {
      kind: 'post_review',
      opKey: opKeys.review(item.id, drop.headSha, drop.id),
      itemId: item.id,
      payload,
    },
    c.now,
  );
  finish(c, 'succeeded');
}

const STALE_REASON = /^(head moved|stale info)/;

function pushResult(c: Ctx, result: DropResult): void {
  const { db, drop, item } = c;
  const role = drop.role as 'heal' | 'resolve';
  db.transaction(() => {
    switch (result.status) {
      case 'completed': {
        if (!result.headSha || drop.prNumber === null) {
          return park(c, 'completed without headSha', 'failed');
        }
        if (
          role === 'resolve' &&
          result.mergeOutcome === 'conflicts' &&
          !chargeResolveConflict(db, item.id, c.deps.zone.budgets)
        ) {
          return park(c, 'budget exhausted: resolve', 'succeeded');
        }
        upsertPullRequest(
          db,
          {
            workItemId: item.id,
            number: drop.prNumber,
            headRef: agentBranch(item.issueNumber),
            headSha: result.headSha,
            state: 'open',
          },
          c.now,
        );
        return finish(c, 'succeeded');
      }
      case 'interrupted':
        if (role === 'heal' && result.headSha) return continueInterrupted(c, result.headSha);
        return finish(c, 'succeeded');
      case 'no_changes':
        return finish(c, 'succeeded');
      default:
        if (result.status === 'failed' && STALE_REASON.test(result.reason ?? '')) {
          return finish(c, 'failed');
        }
        return park(
          c,
          result.reason ?? result.status,
          result.status === 'failed' ? 'failed' : 'succeeded',
        );
    }
  })();
}

/**
 * Applies a finished drop's result per role (see the Task 9 table). A drop already terminal is a
 * no-op, so stick retries are safe. Forge writes go through the outbox.
 */
export async function applyResult(
  db: Db,
  deps: ResultDeps,
  dropId: string,
  result: DropResult,
  now: Date,
): Promise<void> {
  const drop = getDrop(db, dropId);
  if (!drop) throw new Error(`unknown drop ${dropId}`);
  if (TERMINAL.has(drop.state)) return;
  const wasProbe = drop.id === getUsageState(db).probeDropId;
  const item = getWorkItem(db, drop.workItemId);
  if (!item) throw new Error(`unknown work item ${drop.workItemId}`);
  const c: Ctx = { db, deps, drop, item, now };
  const rand = deps.rand ?? Math.random;

  if (result.rateLimit) {
    ingestRateLimit(
      db,
      result.rateLimit,
      {
        dropId: drop.id,
        workItemId: drop.workItemId,
        startedAt: drop.startedAt,
        outcome: result.status,
      },
      deps.usageCfg,
      now,
      rand,
    );
  }
  try {
    if (result.status === 'rate_limited') return rateLimited(c, wasProbe, result);
    switch (drop.role) {
      case 'implement':
        return await implementResult(c, result);
      case 'review':
        return await reviewResult(c, result);
      case 'heal':
      case 'resolve':
        return await pushResult(c, result);
      default:
        throw new Error(`unknown drop role ${drop.role}`);
    }
  } finally {
    releaseProbe(db, drop.id, deps.usageCfg, now, rand);
  }
}
