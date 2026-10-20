import { dirname, join } from 'node:path';
import { agentBranch } from '@jumpmaster/protocol';
import type { DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import {
  activeDropFor,
  getDropZoneDefaultBranch,
  getOutbox,
  getPullRequest,
  type OutboxRow,
  setWaitingSince,
  upsertPullRequest,
  verdictsForHead,
  type WorkItem,
} from '../db/repo.js';
import type { ChecksFacts, ForgeReview, PullFacts, PullFiles } from '../forge/github.js';
import { type ForgePair, type OpResult, opKeys } from '../outbox.js';
import type { Snapshot } from './decide.js';
import {
  branchProtectionProblems,
  gateScriptChanges,
  gateToolChanges,
  protectedPathHits,
} from './guards.js';

/** Read once per zone per pass and shared by the parked-item sync and the reconciler. */
export type ZonePass = {
  /** `[authorLogin, reviewerLogin]`, in that order. */
  botLogins: string[];
  requiredChecks: string[];
  protectionProblems: string[] | null;
};

export async function zonePass(
  forges: ForgePair,
  zone: DropZoneConfig,
  baseBranch: string,
): Promise<ZonePass> {
  const [authorLogin, reviewerLogin, authorRules, reviewerRules] = await Promise.all([
    forges.author.viewerLogin(),
    forges.reviewer.viewerLogin(),
    forges.author.getBranchRules(baseBranch),
    forges.reviewer.getBranchRules(baseBranch),
  ]);
  return {
    botLogins: [authorLogin, reviewerLogin],
    requiredChecks: authorRules.kind === 'ok' ? authorRules.rules.requiredChecks : [],
    protectionProblems: branchProtectionProblems(
      { author: authorRules, reviewer: reviewerRules },
      zone,
    ),
  };
}

export function toOpResult(row: OutboxRow | undefined): OpResult | null {
  if (!row) return null;
  let result: unknown;
  if (row.resultJson) {
    try {
      result = JSON.parse(row.resultJson);
    } catch {
      result = undefined;
    }
  }
  return {
    state: row.state,
    ...(result !== undefined ? { result } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

/** Reviews that count: non-bot authors, no op markers, trusted (lookup failures are untrusted). */
async function trustedReviews(
  forges: ForgePair,
  reviews: ForgeReview[],
  bots: string[],
  markUnavailable: (method: string) => void,
): Promise<ForgeReview[]> {
  const candidates = reviews.filter((r) => !bots.includes(r.author) && !r.body.includes('jm:op:'));
  const trust = new Map<string, boolean>();
  for (const author of new Set(candidates.map((r) => r.author))) {
    try {
      trust.set(author, await forges.author.isTrusted(author));
    } catch {
      trust.set(author, false);
      markUnavailable('isTrusted');
    }
  }
  return candidates.filter((r) => trust.get(r.author) === true);
}

/** Each author's latest decisive review (COMMENTED reviews neither set nor clear a block). */
function latestDecisive(reviews: ForgeReview[]): ForgeReview[] {
  const latest = new Map<string, ForgeReview>();
  for (const r of reviews) {
    if (r.state === 'COMMENTED') continue;
    const prev = latest.get(r.author);
    if (!prev || Date.parse(r.submittedAt) >= Date.parse(prev.submittedAt)) latest.set(r.author, r);
  }
  return [...latest.values()];
}

const isPackageJson = (p: string): boolean => p === 'package.json' || p.endsWith('/package.json');

async function readFile(
  forges: ForgePair,
  ref: string,
  path: string,
): Promise<{ ok: true; text: string | null } | { ok: false }> {
  try {
    return { ok: true, text: await forges.author.getFileAt(ref, path) };
  } catch {
    return { ok: false };
  }
}

async function gateChanges(
  forges: ForgePair,
  zone: DropZoneConfig,
  files: PullFiles['files'],
  mergeBaseSha: string,
  headSha: string,
): Promise<{ scripts: string[]; tools: string[] }> {
  const scripts = new Set<string>();
  const tools = new Set<string>();
  const paths = new Set<string>();
  for (const f of files) {
    for (const p of [f.path, f.previousPath]) if (p && isPackageJson(p)) paths.add(p);
  }
  for (const path of paths) {
    const [basePkg, headPkg] = await Promise.all([
      readFile(forges, mergeBaseSha, path),
      readFile(forges, headSha, path),
    ]);
    if (!basePkg.ok || !headPkg.ok) {
      scripts.add(`${path} unreadable`);
      continue;
    }
    for (const s of gateScriptChanges(zone.gates, basePkg.text, headPkg.text)) scripts.add(s);
    const lockPath = join(dirname(path), 'package-lock.json');
    const [baseLock, headLock] = await Promise.all([
      readFile(forges, mergeBaseSha, lockPath),
      readFile(forges, headSha, lockPath),
    ]);
    for (const t of gateToolChanges(
      zone.gates,
      basePkg.text,
      headPkg.text,
      baseLock.ok ? baseLock.text : null,
      headLock.ok ? headLock.text : null,
    )) {
      tools.add(t);
    }
  }
  return { scripts: [...scripts], tools: [...tools] };
}

/**
 * Assembles everything `decide` reads for one pr_open item. Forge facts are read fresh; failed
 * reads fail closed (see `Snapshot` field docs). Upserts `pull_requests` and maintains
 * `work_items.waiting_since`.
 */
export async function buildSnapshot(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  item: WorkItem,
  pass: ZonePass,
  now: Date,
): Promise<Snapshot> {
  let forgeUnavailable: string | null = null;
  const unavailable = (method: string) => {
    forgeUnavailable ??= method;
  };
  const base = getDropZoneDefaultBranch(db, zone.id) ?? 'main';
  const prRow = getPullRequest(db, item.id);
  const number = prRow?.number ?? item.prNumber;

  let pr: PullFacts | null = null;
  if (number !== null) {
    try {
      pr = await forges.author.getPull(number);
    } catch {
      pr = null;
    }
  }
  let issueState: Snapshot['issueState'] = null;
  try {
    issueState = await forges.author.getIssueState(item.issueNumber);
  } catch {
    issueState = null;
  }

  const headSha = pr?.headSha ?? null;
  let branchSha: string | null = null;
  try {
    branchSha = await forges.author.branchSha(pr?.headRef ?? agentBranch(item.issueNumber));
  } catch {
    unavailable('branchSha');
  }

  let compare: Snapshot['compare'] = null;
  let checks: ChecksFacts = { state: 'none', names: [] };
  let reviews: ForgeReview[] = [];
  let files: PullFiles = { files: [], complete: false };
  if (pr && headSha) {
    try {
      compare = await forges.author.compare(base, headSha);
    } catch {
      compare = null;
    }
    try {
      checks = await forges.author.checksFor(headSha);
    } catch {
      unavailable('checksFor');
    }
    try {
      reviews = await forges.author.listReviews(pr.number);
    } catch {
      unavailable('listReviews');
    }
    try {
      files = await forges.author.listPullFiles(pr.number);
    } catch {
      unavailable('listPullFiles');
    }
  }

  const trusted = latestDecisive(
    await trustedReviews(forges, reviews, pass.botLogins, unavailable),
  );
  const blocks = trusted.filter((r) => r.state === 'CHANGES_REQUESTED');
  const trustedChangeRequests = blocks
    .filter((r) => r.commitId === headSha)
    .sort((a, b) => a.id - b.id);
  const humanBlockStanding = blocks.some((r) => r.commitId !== headSha);

  const gate =
    compare && headSha
      ? await gateChanges(forges, zone, files.files, compare.mergeBaseSha, headSha)
      : { scripts: [], tools: [] };

  if (pr && headSha) {
    upsertPullRequest(
      db,
      {
        workItemId: item.id,
        number: pr.number,
        headRef: pr.headRef,
        headSha,
        state: pr.merged ? 'merged' : pr.state,
      },
      now,
    );
  }
  const headFirstSeenAt = getPullRequest(db, item.id)?.headFirstSeenAt ?? now.toISOString();

  const missing =
    pr === null ||
    issueState === null ||
    compare === null ||
    forgeUnavailable !== null ||
    pass.protectionProblems === null;
  const missingSince = missing ? (item.waitingSince ?? now.toISOString()) : null;
  if (missingSince !== item.waitingSince) setWaitingSince(db, item.id, missingSince);

  const verdictsOnHead = headSha ? verdictsForHead(db, item.id, headSha) : [];
  const latest = verdictsOnHead.at(-1);
  const reviewOp =
    latest && headSha
      ? toOpResult(getOutbox(db, opKeys.review(item.id, headSha, latest.id)))
      : null;
  const mergeOp = headSha ? toOpResult(getOutbox(db, opKeys.merge(item.id, headSha))) : null;

  return {
    item,
    zone,
    now,
    activeDrop: activeDropFor(db, item.id) ?? null,
    pr,
    issueState,
    branchSha,
    compare,
    checks,
    forgeUnavailable,
    requiredChecks: pass.requiredChecks,
    verdictsOnHead,
    reviewOp,
    mergeOp,
    trustedChangeRequests,
    humanBlockStanding,
    protectedHits: protectedPathHits(files.files, zone.protectedPaths),
    filesComplete: files.complete,
    gateScriptChanges: gate.scripts,
    gateToolChanges: gate.tools,
    protectionProblems: pass.protectionProblems,
    headFirstSeenAt,
    missingSince,
  };
}
