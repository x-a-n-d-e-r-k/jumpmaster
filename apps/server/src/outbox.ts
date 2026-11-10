import { createHash, randomUUID } from 'node:crypto';
import { redactTokenShapes } from '@jumpmaster/protocol';
import type { Db } from './db/open.js';
import {
  getOutbox,
  insertOutbox,
  isKilled,
  listOutbox,
  type OutboxRow,
  type OutboxState,
  resetDoneOutbox,
  updateOutbox,
} from './db/repo.js';
import {
  type Forge,
  type ForgeError,
  GitHubForge,
  isRateLimited,
  type PullFacts,
} from './forge/github.js';

/**
 * One zone's forge identities: `author` creates PRs and merges, `reviewer` only posts reviews.
 * `reviewer` is null in starter mode: nothing is posted, and every reader uses the author alone.
 */
export type ForgePair = {
  author: Forge;
  reviewer: Forge | null;
  /** Performs merges instead of the author, when the author's account is a repository admin. */
  merger?: Forge;
};

/** The forges for a zone. An admin author must not be the identity that merges. */
export function pairFor(
  zone: { repo: string; authorMayBeAdmin: boolean; identity?: 'two-bot' | 'starter' },
  secrets: { githubAuthorToken: string; githubReviewerToken?: string },
  opts: { requestTimeoutMs?: number } = {},
): ForgePair {
  const [owner = '', name = ''] = zone.repo.split('/');
  const author = new GitHubForge(owner, name, secrets.githubAuthorToken, opts);
  // Starter has no second identity, so the author merges (an admin author included: see
  // authorMayBeAdmin, and the per-pass Administration probe that guards it).
  if (zone.identity === 'starter') return { author, reviewer: null };
  if (!secrets.githubReviewerToken)
    throw new Error('JM_GITHUB_REVIEWER_TOKEN is required for a two-bot zone');
  const reviewer = new GitHubForge(owner, name, secrets.githubReviewerToken, opts);
  return zone.authorMayBeAdmin ? { author, reviewer, merger: reviewer } : { author, reviewer };
}

type PairTokens = {
  githubAuthorToken: string;
  githubReviewerToken?: string;
  githubReadToken?: string;
};

/**
 * A short SHA-256 over the forge tokens, for caching what was built from them. Never shown: it
 * names no token, and a 64-bit prefix of a hash over high-entropy tokens reveals nothing.
 */
export function forgeTokenFingerprint(secrets: PairTokens): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        secrets.githubAuthorToken,
        secrets.githubReviewerToken ?? null,
        secrets.githubReadToken ?? null,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

type PairZone = Parameters<typeof pairFor>[0] & { id: string };

/**
 * The forge pairs, built on first use and rebuilt only when what they were built from changes:
 * the zone's repository, identity and admin setting, and the credential fingerprint. A config
 * revision that leaves those alone keeps the pair (and its connections); a rotated token gets a
 * new one at the next pass. Only the latest pair per zone (timed or not) is kept.
 */
export class ForgePairs {
  private readonly cache = new Map<string, { key: string; pair: ForgePair }>();

  for(zone: PairZone, secrets: PairTokens, opts: { requestTimeoutMs?: number } = {}): ForgePair {
    const slot = `${zone.id}\n${opts.requestTimeoutMs ?? ''}`;
    const key = JSON.stringify([
      zone.repo,
      zone.identity ?? 'two-bot',
      zone.authorMayBeAdmin,
      forgeTokenFingerprint(secrets),
    ]);
    const hit = this.cache.get(slot);
    if (hit && hit.key === key) return hit.pair;
    const pair = pairFor(zone, secrets, opts);
    this.cache.set(slot, { key, pair });
    return pair;
  }

  /** Drops the pairs of zones not in `zoneIds` (removed from the config; drained first, T3). */
  retain(zoneIds: readonly string[]): void {
    const keep = new Set(zoneIds);
    for (const slot of this.cache.keys())
      if (!keep.has(slot.slice(0, slot.indexOf('\n')))) this.cache.delete(slot);
  }

  size(): number {
    return this.cache.size;
  }
}

export type OpKind = OutboxRow['kind'];
export type OpResult = { state: OutboxState; result?: unknown; error?: string };

export type CreatePrPayload = {
  head: string;
  base: string;
  title: string;
  body: string;
  /** Open PRs on this head to accept without the server's marker. */
  adoptPulls?: number[];
};
export type PostReviewPayload = {
  pr: number;
  event: 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  commitId: string;
};
/** The labels a zone's config names, to create where missing (the doctor's label action). */
export type CreateLabelsPayload = {
  labels: { name: string; color: string; description: string }[];
};
export type MergePayload = { pr: number; sha: string; title: string; message: string };
/** `since`: the crew intent's creation time; the marker search looks at issues updated after it. */
export type CreateIssuePayload = { title: string; body: string; labels: string[]; since: string };
/** A body update (the op marker is appended) or, with `state: 'closed'`, a close. */
export type UpdateIssuePayload = {
  number: number;
  title?: string;
  body?: string;
  state?: 'closed';
};
export type SetLabelsPayload = { number: number; add: string[]; remove: string[] };

/** `itemId` is null for a zone-level op; `zoneId` decides the mode check and the outbox row. */
export type Op = {
  kind: OpKind;
  opKey: string;
  zoneId: string;
  itemId: number | null;
  payload: unknown;
};

export const opKeys = {
  pr: (itemId: number, headSha: string) => `pr:${itemId}:${headSha}`,
  review: (itemId: number, headSha: string, dropId: string) =>
    `review:${itemId}:${headSha}:${dropId}`,
  merge: (itemId: number, headSha: string) => `merge:${itemId}:${headSha}`,
  issue: (zoneId: string, objective: string, outputKey: string) =>
    `issue:${zoneId}:${objective}:${outputKey}`,
  update: (crewIssueId: number, sha12: string) => `update:${crewIssueId}:${sha12}`,
  close: (crewIssueId: number) => `close:${crewIssueId}`,
  promote: (crewIssueId: number) => `labels:${crewIssueId}:promote`,
};

/** How far back the last marker search before failing a create looks, for forge clock skew. */
const WIDE_SEARCH_MS = 24 * 60 * 60_000;

/** The final line of every body Jumpmaster writes to a forge. */
export const opMarker = (opKey: string): string => `<!-- jm:op:${opKey} -->`;

/** Whether a PR body ends with the marker the server writes when it opens this item's PR. */
export const isServerPrBody = (body: string, itemId: number): boolean => {
  const last = body.trimEnd().split('\n').pop() ?? '';
  return last.startsWith(`<!-- jm:op:pr:${itemId}:`) && last.endsWith(' -->');
};

const lastLine = (body: string): string => body.trimEnd().split('\n').pop() ?? '';

/**
 * Whether an issue body ends with a marker Jumpmaster writes on issues it files (`issue:`) or
 * rewrites (`update:`). Such an issue is crew-filed whatever its author.
 */
export const isJmIssueBody = (body: string): boolean => {
  const last = lastLine(body).trim();
  return (
    (last.startsWith('<!-- jm:op:issue:') || last.startsWith('<!-- jm:op:update:')) &&
    last.endsWith(' -->')
  );
};

/** The body without its final Jumpmaster marker line, as `body_sha` is computed. */
export const bodyWithoutMarker = (body: string): string => {
  const lines = body.trimEnd().split('\n');
  const last = lines.at(-1)?.trim() ?? '';
  if (last.startsWith('<!-- jm:op:') && last.endsWith(' -->')) lines.pop();
  return lines.join('\n').trimEnd();
};

const withMarker = (body: string, opKey: string): string =>
  `${body.trimEnd()}\n\n${opMarker(opKey)}`;

const isOwnPr = (body: string, opKey: string): boolean =>
  isServerPrBody(body, Number(opKey.split(':')[1]));

/** Marked by the server, or listed by the operator and written by the author account. */
async function ours(
  forges: ForgePair,
  pr: PullFacts,
  opKey: string,
  p: CreatePrPayload,
): Promise<boolean> {
  if (isOwnPr(pr.body, opKey)) return true;
  if (!(p.adoptPulls ?? []).includes(pr.number)) return false;
  return pr.author === (await forges.author.viewerLogin());
}

/** Read-back: the op's result if its effect is visible on the forge, else `null`. */
async function lookup(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      const pr = await forges.author.findOpenPullByHead(p.head);
      return pr && (await ours(forges, pr, opKey, p))
        ? { number: pr.number, created: false }
        : null;
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      if (!forges.reviewer) throw new Error('no reviewer identity (starter mode) to post a review');
      return forges.reviewer.findReviewByMarker(p.pr, opMarker(opKey));
    }
    case 'merge': {
      const p = payload as MergePayload;
      const pr = await forges.author.getPull(p.pr);
      return pr?.merged ? { merged: true } : null;
    }
    case 'create_issue': {
      const p = payload as CreateIssuePayload;
      return forges.author.findIssueByMarker(opMarker(opKey), p.since);
    }
    case 'update_issue': {
      const p = payload as UpdateIssuePayload;
      const issue = await forges.author.getIssue(p.number);
      if (!issue) return null;
      if (p.state === 'closed') return issue.state === 'closed' ? { number: p.number } : null;
      return lastLine(issue.body) === opMarker(opKey) ? { number: p.number } : null;
    }
    case 'create_labels': {
      // Read-back: done when every label exists (by name, as GitHub compares them).
      const p = payload as CreateLabelsPayload;
      const have = new Set((await forges.author.listLabels()).map((l) => l.toLowerCase()));
      return p.labels.every((l) => have.has(l.name.toLowerCase())) ? { created: [] } : null;
    }
    case 'set_labels': {
      const p = payload as SetLabelsPayload;
      const issue = await forges.author.getIssue(p.number);
      if (!issue) return null;
      const has = new Set(issue.labels);
      const matches = p.add.every((l) => has.has(l)) && !p.remove.some((l) => has.has(l));
      return matches ? { number: p.number } : null;
    }
  }
}

/** The last look before a `create_issue` row is failed: a day wider than the normal search. */
async function wideIssueSearch(
  forges: ForgePair,
  row: Pick<OutboxRow, 'kind' | 'opKey' | 'payloadJson'>,
): Promise<{ number: number } | null> {
  if (row.kind !== 'create_issue') return null;
  const p = JSON.parse(row.payloadJson) as CreateIssuePayload;
  const since = new Date(Date.parse(p.since) - WIDE_SEARCH_MS).toISOString();
  try {
    return await forges.author.findIssueByMarker(opMarker(row.opKey), since);
  } catch {
    return null;
  }
}

/** The forge write. Returns `null` when the forge answered but did not perform the effect. */
async function write(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      // Never take over a PR someone opened by hand on the agent branch: it would get merged.
      const open = await forges.author.findOpenPullByHead(p.head);
      if (open && !(await ours(forges, open, opKey, p))) {
        // A 4xx status makes this a failed op, so the item parks with a reason instead of waiting.
        throw Object.assign(new Error(`hand-opened PR on agent branch: #${open.number}`), {
          status: 409,
        });
      }
      const { adoptPulls: _listed, ...input } = p;
      return forges.author.findOrCreatePullRequest({ ...input, body: withMarker(p.body, opKey) });
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      if (!forges.reviewer) throw new Error('no reviewer identity (starter mode) to post a review');
      return forges.reviewer.createReview(p.pr, {
        event: p.event,
        commitId: p.commitId,
        body: withMarker(p.body, opKey),
      });
    }
    case 'merge': {
      const p = payload as MergePayload;
      const r = await (forges.merger ?? forges.author).merge(p.pr, {
        sha: p.sha,
        method: 'squash',
        title: p.title,
        message: p.message,
      });
      return r.merged ? r : null;
    }
    case 'create_issue': {
      const p = payload as CreateIssuePayload;
      const r = await forges.author.createIssue({
        title: p.title,
        body: withMarker(p.body, opKey),
        labels: p.labels,
      });
      return { number: r.number, created: true };
    }
    case 'update_issue': {
      const p = payload as UpdateIssuePayload;
      await forges.author.updateIssue(p.number, {
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.body !== undefined ? { body: withMarker(p.body, opKey) } : {}),
        ...(p.state ? { state: p.state } : {}),
      });
      return { number: p.number };
    }
    case 'set_labels': {
      const p = payload as SetLabelsPayload;
      await forges.author.setLabels(p.number, { add: p.add, remove: p.remove });
      return { number: p.number };
    }
    case 'create_labels': {
      // GET, then create only what is missing, as the author bot: idempotent by name.
      const p = payload as CreateLabelsPayload;
      const have = new Set((await forges.author.listLabels()).map((l) => l.toLowerCase()));
      const created: string[] = [];
      for (const l of p.labels) {
        if (have.has(l.name.toLowerCase())) continue;
        const r = await forges.author.createLabel(l.name, l.color, l.description);
        if (r.created) created.push(l.name);
      }
      return { created };
    }
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function markDone(db: Db, opKey: string, result: unknown, now: Date): OpResult {
  db.transaction(() => {
    updateOutbox(db, opKey, { state: 'done', resultJson: JSON.stringify(result) }, now);
    recordFiledNumber(db, opKey, result, now);
  })();
  return { state: 'done', result };
}

/**
 * A crew issue's create resolved: its row learns the issue number now, wherever the op resolved
 * (written, read back, or found by `resolveUnknown`), so intake knows the issue as crew even while
 * the flush that moves the row on is not running (zone paused, crew disabled, a crash between).
 */
export function recordFiledNumber(db: Db, opKey: string, result: unknown, now: Date): void {
  if (!opKey.startsWith('issue:')) return;
  const number = (result as { number?: unknown } | undefined)?.number;
  if (typeof number !== 'number') return;
  db.prepare(
    `UPDATE crew_issues SET number = ?, updated_at = ?
       WHERE number IS NULL AND 'issue:' || zone_id || ':' || objective || ':' || key = ?`,
  ).run(number, now.toISOString(), opKey);
}

/** Lookup only; never writes to the forge. Visible → `done`, otherwise the row is `unknown`. */
async function readBack(db: Db, forges: ForgePair, row: OutboxRow, now: Date): Promise<OpResult> {
  const payload: unknown = JSON.parse(row.payloadJson);
  let found: unknown;
  try {
    found = await lookup(forges, row.kind, row.opKey, payload);
  } catch (err) {
    if (row.state !== 'unknown') updateOutbox(db, row.opKey, { state: 'unknown' }, now);
    return { state: 'unknown', error: errorMessage(err) };
  }
  if (found) return markDone(db, row.opKey, found, now);
  if (row.state !== 'unknown') updateOutbox(db, row.opKey, { state: 'unknown' }, now);
  return { state: 'unknown' };
}

/** Lookup, then write if the effect is absent. The row must be `pending`. */
async function execute(db: Db, forges: ForgePair, op: Op, now: Date): Promise<OpResult> {
  let found: unknown;
  try {
    found = await lookup(forges, op.kind, op.opKey, op.payload);
  } catch (err) {
    updateOutbox(db, op.opKey, { state: 'unknown', error: errorMessage(err) }, now);
    return { state: 'unknown', error: errorMessage(err) };
  }
  if (found) return markDone(db, op.opKey, found, now);
  try {
    const result = await write(forges, op.kind, op.opKey, op.payload);
    if (result) return markDone(db, op.opKey, result, now);
    const error = `${op.kind} not performed`;
    updateOutbox(db, op.opKey, { state: 'unknown', error }, now);
    return { state: 'unknown', error };
  } catch (err) {
    const status = (err as ForgeError | null)?.status;
    const error = errorMessage(err);
    // A rate limit (403/429) says nothing about the write: leave it to read-back like a 5xx.
    const state: OutboxState =
      status !== undefined && status >= 400 && status < 500 && !isRateLimited(err)
        ? 'failed'
        : 'unknown';
    if (state === 'failed') {
      const found = await wideIssueSearch(forges, {
        kind: op.kind,
        opKey: op.opKey,
        payloadJson: JSON.stringify(op.payload),
      });
      if (found) return markDone(db, op.opKey, found, now);
    }
    updateOutbox(db, op.opKey, { state, error }, now);
    return { state, error };
  }
}

async function fromExisting(
  db: Db,
  forges: ForgePair,
  op: Op,
  row: OutboxRow,
  now: Date,
): Promise<OpResult> {
  switch (row.state) {
    case 'done': {
      const result: unknown = row.resultJson == null ? undefined : JSON.parse(row.resultJson);
      if (row.kind !== 'create_pr') return { state: 'done', result };
      // A PR op stays done while its PR is open or merged; a closed one is opened again.
      const head = (JSON.parse(row.payloadJson) as CreatePrPayload).head;
      if (await forges.author.findOpenPullByHead(head)) return { state: 'done', result };
      const stored = (result as { number?: number } | undefined)?.number;
      if (stored !== undefined && (await forges.author.getPull(stored))?.merged) {
        return { state: 'done', result };
      }
      if (resetDoneOutbox(db, row.opKey, now)) return execute(db, forges, op, now);
      const current = getOutbox(db, row.opKey);
      if (!current) throw new Error(`outbox row ${row.opKey} vanished`);
      return fromExisting(db, forges, op, current, now);
    }
    case 'failed':
      return { state: 'failed', ...(row.error != null ? { error: row.error } : {}) };
    case 'pending':
    case 'unknown':
      return readBack(db, forges, row, now);
  }
}

function zoneMode(db: Db, zoneId: string): string | undefined {
  const row = db.prepare('SELECT mode FROM zone_controls WHERE zone_id = ?').get(zoneId) as
    | { mode: string }
    | undefined;
  return row?.mode;
}

/** Runs one forge write at most once per `opKey` (§5.2). */
export async function runOp(
  db: Db,
  forges: ForgePair,
  op: Op,
  now: Date,
  /**
   * `allowInObserve`: the operator's own label action from the doctor (Task 8), and nothing
   * else: any other kind is still suppressed in observe whatever the caller asks.
   */
  opts: { allowInObserve?: boolean } = {},
): Promise<OpResult> {
  if (isKilled(db)) throw new Error(`kill switch engaged: forge write ${op.kind} refused`);
  // Before any insert: a row left behind would later become `unknown` and park the item.
  const exempt = opts.allowInObserve === true && op.kind === 'create_labels';
  if (!exempt && zoneMode(db, op.zoneId) === 'observe') {
    throw new Error(`observe mode: forge write ${op.kind} suppressed`);
  }
  const existing = getOutbox(db, op.opKey);
  if (existing) return fromExisting(db, forges, op, existing, now);
  const inserted = insertOutbox(db, {
    id: randomUUID(),
    opKey: op.opKey,
    kind: op.kind,
    workItemId: op.itemId,
    zoneId: op.zoneId,
    payloadJson: JSON.stringify(op.payload),
    state: 'pending',
    createdAt: now.toISOString(),
  });
  if (!inserted) {
    const raced = getOutbox(db, op.opKey);
    if (!raced) throw new Error(`outbox row ${op.opKey} vanished`);
    return fromExisting(db, forges, op, raced, now);
  }
  return execute(db, forges, op, now);
}

/**
 * Read-back for every `unknown` row of one zone; returns how many became `done`. A row still
 * unresolved `maxAgeMinutes` after it was created becomes `failed`.
 */
export async function resolveUnknown(
  db: Db,
  forges: ForgePair,
  zoneId: string,
  now: Date,
  maxAgeMinutes: number,
): Promise<number> {
  let resolved = 0;
  for (const row of listOutbox(db, ['unknown'], zoneId)) {
    const r = await readBack(db, forges, row, now);
    if (r.state === 'done') {
      resolved++;
      continue;
    }
    if (now.getTime() - Date.parse(row.createdAt) >= maxAgeMinutes * 60_000) {
      const found = await wideIssueSearch(forges, row);
      if (found) {
        markDone(db, row.opKey, found, now);
        resolved++;
        continue;
      }
      updateOutbox(
        db,
        row.opKey,
        { state: 'failed', error: `unresolved after ${maxAgeMinutes} min` },
        now,
      );
    }
  }
  return resolved;
}

/** Startup: a `pending` row may have reached the forge before a crash, so it becomes `unknown`. */
export function markPendingUnknown(db: Db, now: Date): number {
  const rows = listOutbox(db, ['pending']);
  for (const row of rows) updateOutbox(db, row.opKey, { state: 'unknown' }, now);
  return rows.length;
}

const ZWJ = '\u200d';

/** Cuts `text` to `maxLen` without leaving a code span open. */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const runs = [...cut.matchAll(/`+/g)];
  const last = runs.at(-1);
  return runs.length % 2 === 1 && last ? cut.slice(0, last.index) : cut;
}

/**
 * Makes untrusted text safe to post: redacts secrets, escapes HTML comment markers (so no text can
 * forge a `jm:op:` marker), breaks `@mentions` and autolinks with a zero-width joiner everywhere
 * (code spans included, so no span boundary can revive one), and truncates without splitting a
 * code span.
 */
/**
 * `sanitizeForgeText` for crew-written issue text, which also breaks `#N` and `owner/repo#N`
 * references so a crew issue cannot link, close or notify other issues.
 */
export function sanitizeCrewText(text: string, secrets: string[]): string {
  return sanitizeForgeText(text, secrets)
    .replace(/#(?=\d)/g, `#${ZWJ}`)
    .replace(/\b(gh-)(?=\d)/gi, `$1${ZWJ}`);
}

export function sanitizeForgeText(text: string, secrets: string[], maxLen = 60_000): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  // Token shapes too: a token pasted into a body (an MCP caller's, say) is never configured.
  out = redactTokenShapes(out, '[redacted]');
  out = out.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
  out = out.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, `$1@${ZWJ}`);
  out = out.replaceAll('://', `:${ZWJ}//`);
  out = out.replace(/(^|[^\w])(www)\./gi, `$1$2${ZWJ}.`);
  return truncate(out, maxLen);
}
