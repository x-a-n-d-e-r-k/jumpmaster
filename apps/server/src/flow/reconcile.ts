import { randomUUID } from 'node:crypto';
import { agentBranch, type GateResult, type Role, type Verdict } from '@jumpmaster/protocol';
import type { DropZoneConfig, UsageConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  activeDropFor,
  deleteFailedOutbox,
  getPullRequest,
  getWorkItem,
  hasOpenCreatePr,
  insertDrop,
  listWorkItems,
  setWorkItemState,
  upsertPullRequest,
  type WorkItem,
} from '../db/repo.js';
import {
  type ForgePair,
  type MergePayload,
  opKeys,
  type PostReviewPayload,
  resolveUnknown,
  runOp,
} from '../outbox.js';
import { renderReviewBody } from '../results.js';
import { enqueueImplement, enqueueNext } from '../scheduler.js';
import { chargeBudget } from './budgets.js';
import { type Action, decide, type Snapshot } from './decide.js';
import { buildSnapshot, type ZonePass } from './snapshot.js';

export type ReconcileReport = { actions: number; merges: number };

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/.test(e.message);

/** Thrown inside a transaction to roll it back without treating the pass as failed. */
class Rollback extends Error {}

const agentIssue = (headRef: string): number | null => {
  const m = /^agent\/issue-(\d+)$/.exec(headRef);
  return m ? Number(m[1]) : null;
};

/** A PR row that is not closed (a closed row is history: retry resumes past it). */
const hasLivePr = (db: Db, itemId: number): boolean => {
  const row = getPullRequest(db, itemId);
  return row !== undefined && row.state !== 'closed';
};

const parkReason = (db: Db, itemId: number, reason: string, now: Date): void =>
  setWorkItemState(db, itemId, 'parked', reason, now);

/** Step 2: adopt open agent PRs (author bot, same repo) for items that lost track of them. */
async function adopt(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  now: Date,
): Promise<number> {
  const authorLogin = pass.botLogins[0];
  const pulls = await forges.author.listOpenAgentPulls('agent/issue-');
  let adopted = 0;
  for (const pr of pulls) {
    const n = agentIssue(pr.headRef);
    if (n === null || pr.author !== authorLogin || pr.headSha === null) continue;
    const item = listWorkItems(db, zone.id).find((i) => i.issueNumber === n);
    if (!item || (item.state !== 'ready' && item.state !== 'in_flight')) continue;
    if (activeDropFor(db, item.id) || hasLivePr(db, item.id)) continue;
    upsertPullRequest(
      db,
      {
        workItemId: item.id,
        number: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        state: 'open',
      },
      now,
    );
    setWorkItemState(db, item.id, 'pr_open', undefined, now);
    adopted++;
  }
  return adopted;
}

/** Step 3 (R12): continue implement work from a pushed agent branch that has no PR. */
async function resume(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  now: Date,
): Promise<number> {
  let acted = 0;
  const candidates = listWorkItems(db, zone.id).filter(
    (i) =>
      (i.state === 'ready' || i.state === 'in_flight') &&
      !activeDropFor(db, i.id) &&
      !hasLivePr(db, i.id) &&
      !hasOpenCreatePr(db, i.id),
  );
  for (const item of candidates) {
    let sha: string | null;
    try {
      sha = await forges.author.branchSha(agentBranch(item.issueNumber));
    } catch {
      continue; // unknown: judge on a later pass
    }
    if (sha === null) {
      if (item.state === 'in_flight') {
        setWorkItemState(db, item.id, 'ready', undefined, now);
        acted++;
      }
      continue;
    }
    const resumeSha = sha;
    try {
      db.transaction(() => {
        deleteFailedOutbox(db, item.id, 'create_pr');
        const charge = chargeBudget(db, item.id, 'resume', resumeSha, zone.budgets);
        if (!charge.ok) {
          parkReason(db, item.id, charge.reason, now);
          return;
        }
        const id = enqueueImplement(
          db,
          zone,
          item,
          { headSha: resumeSha, chargedKey: 'resume', promptVersion: versions.implement },
          usageCfg,
          now,
        );
        if (id === null) throw new Rollback();
      })();
      acted++;
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }
  return acted;
}

const CHARGE_KEY = { review: 'review', heal: 'heal', resolve: 'resolve' } as const;

function enqueue(
  db: Db,
  zone: DropZoneConfig,
  s: Snapshot,
  a: Extract<Action, { kind: 'enqueue' }>,
  versions: Record<Role, string>,
  now: Date,
): void {
  const item = s.item;
  try {
    db.transaction(() => {
      const charge = chargeBudget(db, item.id, CHARGE_KEY[a.role], a.fingerprint, zone.budgets);
      if (!charge.ok) {
        parkReason(db, item.id, charge.reason, now);
        return;
      }
      insertDrop(
        db,
        {
          id: randomUUID(),
          dropZoneId: zone.id,
          workItemId: item.id,
          role: a.role,
          state: 'queued',
          fingerprint: a.fingerprint,
          prNumber: s.pr?.number ?? null,
          headSha: s.pr?.headSha ?? null,
          inputJson: JSON.stringify({ feedback: a.feedback ?? null }),
          promptVersion: versions[a.role],
          image: zone.image,
          chargedKey: charge.charged.join(',') || null,
          createdAt: now.toISOString(),
        },
        now,
      );
    })();
  } catch (e) {
    if (!isUniqueViolation(e)) throw e; // already active: the charge rolled back with the insert
  }
}

async function postReview(
  db: Db,
  forges: ForgePair,
  s: Snapshot,
  verdictId: string,
  secrets: string[],
  now: Date,
): Promise<void> {
  const v = s.verdictsOnHead.find((x) => x.id === verdictId);
  if (!v || !s.pr?.headSha) return;
  const verdict: Verdict = {
    decision: v.decision,
    summary: v.summary,
    findings: JSON.parse(v.findingsJson) as Verdict['findings'],
  };
  const gates = JSON.parse(v.gatesJson) as GateResult[];
  const payload: PostReviewPayload = {
    pr: s.pr.number,
    event: v.decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
    commitId: v.headSha,
    body: renderReviewBody(verdict, gates, secrets),
  };
  await runOp(
    db,
    forges,
    {
      kind: 'post_review',
      opKey: opKeys.review(s.item.id, v.headSha, v.id),
      itemId: s.item.id,
      payload,
    },
    now,
  );
}

async function merge(
  db: Db,
  forges: ForgePair,
  s: Snapshot,
  sha: string,
  now: Date,
): Promise<boolean> {
  if (!s.pr) return false;
  const payload: MergePayload = {
    pr: s.pr.number,
    sha,
    title: s.pr.title,
    message: `Closes #${s.item.issueNumber}`,
  };
  const r = await runOp(
    db,
    forges,
    { kind: 'merge', opKey: opKeys.merge(s.item.id, sha), itemId: s.item.id, payload },
    now,
  );
  if (r.state === 'done') {
    upsertPullRequest(
      db,
      {
        workItemId: s.item.id,
        number: s.pr.number,
        headRef: s.pr.headRef,
        headSha: sha,
        state: 'merged',
      },
      now,
    );
    setWorkItemState(db, s.item.id, 'done', 'merged', now);
  }
  return true;
}

/**
 * One reconcile pass for a zone (uses the given `pass`, never reads it itself): resolve unknown
 * outbox ops, adopt lost agent PRs, resume pushed branches, decide every pr_open item, then start
 * new implement work.
 */
export async function reconcileZone(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  pass: ZonePass,
  versions: Record<Role, string>,
  usageCfg: UsageConfig,
  secrets: string[],
  now: Date,
): Promise<ReconcileReport> {
  let actions = 0;
  let merges = 0;
  await resolveUnknown(db, forges, zone.id, now, zone.ciDeadlineMinutes);
  actions += await adopt(db, forges, zone, pass, now);
  actions += await resume(db, forges, zone, versions, usageCfg, now);

  for (const listed of listWorkItems(db, zone.id, 'pr_open')) {
    const item: WorkItem | undefined = getWorkItem(db, listed.id);
    if (!item) continue;
    const s = await buildSnapshot(db, forges, zone, item, pass, now);
    const a = decide(s);
    switch (a.kind) {
      case 'enqueue':
        enqueue(db, zone, s, a, versions, now);
        actions++;
        break;
      case 'post_review':
        await postReview(db, forges, s, a.verdictId, secrets, now);
        actions++;
        break;
      case 'merge':
        if (merges >= 1) break;
        if (await merge(db, forges, s, a.sha, now)) merges++;
        actions++;
        break;
      case 'park':
        parkReason(db, item.id, a.reason, now);
        actions++;
        break;
      case 'done':
        setWorkItemState(db, item.id, 'done', a.reason, now);
        actions++;
        break;
      case 'wait':
      case 'none':
        break;
    }
  }

  if (enqueueNext(db, zone, versions.implement, usageCfg, now) !== null) actions++;
  return { actions, merges };
}
