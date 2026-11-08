import { basename, dirname, join } from 'node:path';
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
import {
  type ChecksFacts,
  type ForgeReview,
  isHeld,
  type PullFacts,
  type PullFiles,
} from '../forge/github.js';
import { type ForgePair, type OpResult, opKeys } from '../outbox.js';
import type { Snapshot } from './decide.js';
import {
  branchProtectionProblems,
  dependenciesChanged,
  gateScriptChanges,
  gateToolChanges,
  LOCKFILES,
  lockfileChanges,
  pnpmBlocksBuilds,
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

/** The newest review's submittedAt (ISO strings sort by time); null when there is none. */
export const newestReviewAt = (reviews: ForgeReview[]): string | null =>
  reviews.reduce<string | null>(
    (max, r) => (max === null || r.submittedAt > max ? r.submittedAt : max),
    null,
  );

/**
 * Whether someone may let this head's gate changes through: among trusted reviewers' latest
 * decisive reviews (a later change request or a dismissal cancels an approval), an APPROVED on
 * exactly `headSha` by a non-bot with maintain/admin, or listed in `zone.overrideApprovers`.
 */
async function maintainerApprovedHead(
  forges: ForgePair,
  zone: DropZoneConfig,
  latest: ForgeReview[],
  headSha: string,
  bots: string[],
  unavailable: (method: string) => void,
): Promise<boolean> {
  const listed = new Set(zone.overrideApprovers.map((l) => l.toLowerCase()));
  const botSet = new Set(bots.map((b) => b.toLowerCase()));
  for (const r of latest) {
    const login = r.author.toLowerCase();
    if (r.state !== 'APPROVED' || r.commitId !== headSha) continue;
    if (botSet.has(login) || login.endsWith('[bot]')) continue;
    if (listed.has(login)) return true;
    try {
      if (await forges.author.isMaintainer(r.author)) return true;
    } catch {
      unavailable('isMaintainer');
    }
  }
  return false;
}

const isPackageJson = (p: string): boolean => p === 'package.json' || p.endsWith('/package.json');

/**
 * Answered reads (404s included) by `sha:path`, per forge. Callers pass commit SHAs only, whose
 * contents never change. Least recently used entries go first past either bound.
 */
const FILE_CACHE_ENTRIES = 256;
const FILE_CACHE_BYTES = 64 * 1024 * 1024;
const fileCaches = new WeakMap<object, { files: Map<string, string | null>; bytes: number }>();

function cached(forge: object, key: string): { hit: boolean; text: string | null } {
  const c = fileCaches.get(forge);
  if (!c?.files.has(key)) return { hit: false, text: null };
  const text = c.files.get(key) ?? null;
  c.files.delete(key);
  c.files.set(key, text);
  return { hit: true, text };
}

function remember(forge: object, key: string, text: string | null): void {
  let c = fileCaches.get(forge);
  if (!c) {
    c = { files: new Map(), bytes: 0 };
    fileCaches.set(forge, c);
  }
  const size = (t: string | null | undefined) => t?.length ?? 0;
  if (size(text) > FILE_CACHE_BYTES) return;
  c.files.set(key, text);
  c.bytes += size(text);
  for (const [k, v] of c.files) {
    if (c.files.size <= FILE_CACHE_ENTRIES && c.bytes <= FILE_CACHE_BYTES) break;
    c.files.delete(k);
    c.bytes -= size(v);
  }
}

/** A 404 is `text: null`; a thrown read is the forge being unavailable (the pass waits). */
async function readFile(
  forges: ForgePair,
  sha: string,
  path: string,
  unavailable: (method: string, err?: unknown) => void,
): Promise<{ ok: true; text: string | null } | { ok: false }> {
  const key = `${sha}:${path}`;
  const hit = cached(forges.author, key);
  if (hit.hit) return { ok: true, text: hit.text };
  try {
    const text = await forges.author.getFileAt(sha, path);
    remember(forges.author, key, text);
    return { ok: true, text };
  } catch (err) {
    unavailable('getFileAt', err);
    return { ok: false };
  }
}

async function gateChanges(
  forges: ForgePair,
  zone: DropZoneConfig,
  files: PullFiles['files'],
  mergeBaseSha: string,
  headSha: string,
  unavailable: (method: string) => void,
): Promise<{ scripts: string[]; tools: string[] }> {
  const scripts = new Set<string>();
  const tools = new Set<string>();
  const pkgPaths = new Set<string>();
  // Every lockfile in the PR is checked, and each changed package.json's lockfile when its
  // dependencies change; a workspace's packages share one lockfile, checked once.
  const lockPaths = new Set<string>();
  for (const f of files) {
    for (const p of [f.path, f.previousPath]) {
      if (p && isPackageJson(p)) pkgPaths.add(p);
      else if (p && LOCKFILES.includes(basename(p))) lockPaths.add(p);
    }
  }
  for (const path of pkgPaths) {
    const [basePkg, headPkg] = await Promise.all([
      readFile(forges, mergeBaseSha, path, unavailable),
      readFile(forges, headSha, path, unavailable),
    ]);
    if (!basePkg.ok || !headPkg.ok) continue; // marked unavailable: decide waits
    for (const s of gateScriptChanges(zone.gates, basePkg.text, headPkg.text)) scripts.add(s);
    for (const t of gateToolChanges(zone.gates, basePkg.text, headPkg.text)) tools.add(t);
    if (!dependenciesChanged(basePkg.text, headPkg.text)) continue;
    const lock = await findLockfile(forges, headSha, dirname(path), unavailable);
    if (lock === undefined) continue;
    if (lock === null) tools.add('lockfile not found');
    else lockPaths.add(lock);
  }
  for (const path of lockPaths) {
    const pkgPath = join(dirname(path), 'package.json');
    const [baseLock, headLock, headPkg] = await Promise.all([
      readFile(forges, mergeBaseSha, path, unavailable),
      readFile(forges, headSha, path, unavailable),
      readFile(forges, headSha, pkgPath, unavailable),
    ]);
    if (!baseLock.ok || !headLock.ok || !headPkg.ok) continue;
    const opts = { pnpmBlocksBuilds: pnpmBlocksBuilds(headPkg.text) };
    for (const t of lockfileChanges(path, baseLock.text, headLock.text, opts)) tools.add(t);
  }
  return { scripts: [...scripts], tools: [...tools] };
}

/**
 * The lockfile governing a directory at `ref`: the first lockfile found walking up to the repo
 * root. null when there is none; undefined when a read failed (marked unavailable).
 */
async function findLockfile(
  forges: ForgePair,
  ref: string,
  dir: string,
  unavailable: (method: string, err?: unknown) => void,
): Promise<string | null | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    const here = d === '.' ? '' : d;
    for (const name of LOCKFILES) {
      const path = here ? `${here}/${name}` : name;
      const read = await readFile(forges, ref, path, unavailable);
      if (!read.ok) return undefined;
      if (read.text !== null) return path;
    }
    if (here === '') return null;
  }
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
  let forgeDenied: string | null = null;
  const unavailable = (method: string, err?: unknown) => {
    forgeUnavailable ??= method;
    if ((err as { status?: number } | undefined)?.status === 403) forgeDenied ??= method;
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
  } catch (err) {
    unavailable('branchSha', err);
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
    // Checks matter only when CI is required or branch protection requires named checks; a
    // private repo's checks need a token permission a zone without CI shouldn't have to grant.
    if (zone.ciRequired || pass.requiredChecks.length > 0) {
      try {
        checks = await forges.author.checksFor(headSha);
      } catch (err) {
        unavailable('checksFor', err);
      }
    }
    try {
      reviews = await forges.author.listReviews(pr.number);
    } catch (err) {
      unavailable('listReviews', err);
    }
    try {
      files = await forges.author.listPullFiles(pr.number);
    } catch (err) {
      unavailable('listPullFiles', err);
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
      ? await gateChanges(forges, zone, files.files, compare.mergeBaseSha, headSha, unavailable)
      : { scripts: [], tools: [] };
  const maintainerApproved =
    headSha !== null && (gate.scripts.length > 0 || gate.tools.length > 0)
      ? await maintainerApprovedHead(forges, zone, trusted, headSha, pass.botLogins, unavailable)
      : false;

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
    forgeDenied,
    requiredChecks: pass.requiredChecks,
    verdictsOnHead,
    reviewOp,
    mergeOp,
    trustedChangeRequests,
    humanBlockStanding,
    held: pr !== null && isHeld(pr),
    protectedHits: protectedPathHits(files.files, zone.protectedPaths),
    filesComplete: files.complete,
    gateScriptChanges: gate.scripts,
    gateToolChanges: gate.tools,
    maintainerApproved,
    newestReviewAt: newestReviewAt(reviews),
    protectionProblems: pass.protectionProblems,
    headFirstSeenAt,
    missingSince,
  };
}
