import { randomUUID } from 'node:crypto';
import type { Db } from './db/open.js';
import {
  getOutbox,
  insertOutbox,
  listOutbox,
  type OutboxRow,
  type OutboxState,
  resetDoneOutbox,
  updateOutbox,
} from './db/repo.js';
import type { Forge, ForgeError } from './forge/github.js';

/** One zone's forge identities: `author` creates PRs and merges, `reviewer` only posts reviews. */
export type ForgePair = { author: Forge; reviewer: Forge };

export type OpKind = OutboxRow['kind'];
export type OpResult = { state: OutboxState; result?: unknown; error?: string };

export type CreatePrPayload = { head: string; base: string; title: string; body: string };
export type PostReviewPayload = {
  pr: number;
  event: 'APPROVE' | 'REQUEST_CHANGES';
  body: string;
  commitId: string;
};
export type MergePayload = { pr: number; sha: string; title: string; message: string };

export type Op = { kind: OpKind; opKey: string; itemId: number; payload: unknown };

export const opKeys = {
  pr: (itemId: number, headSha: string) => `pr:${itemId}:${headSha}`,
  review: (itemId: number, headSha: string, dropId: string) =>
    `review:${itemId}:${headSha}:${dropId}`,
  merge: (itemId: number, headSha: string) => `merge:${itemId}:${headSha}`,
};

/** The final line of every body Jumpmaster writes to a forge. */
export const opMarker = (opKey: string): string => `<!-- jm:op:${opKey} -->`;

const withMarker = (body: string, opKey: string): string =>
  `${body.trimEnd()}\n\n${opMarker(opKey)}`;

/** Read-back: the op's result if its effect is visible on the forge, else `null`. */
async function lookup(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      const pr = await forges.author.findOpenPullByHead(p.head);
      return pr ? { number: pr.number, created: false } : null;
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      return forges.reviewer.findReviewByMarker(p.pr, opMarker(opKey));
    }
    case 'merge': {
      const p = payload as MergePayload;
      const pr = await forges.author.getPull(p.pr);
      return pr?.merged ? { merged: true } : null;
    }
  }
}

/** The forge write. Returns `null` when the forge answered but did not perform the effect. */
async function write(forges: ForgePair, kind: OpKind, opKey: string, payload: unknown) {
  switch (kind) {
    case 'create_pr': {
      const p = payload as CreatePrPayload;
      return forges.author.findOrCreatePullRequest({ ...p, body: withMarker(p.body, opKey) });
    }
    case 'post_review': {
      const p = payload as PostReviewPayload;
      return forges.reviewer.createReview(p.pr, {
        event: p.event,
        commitId: p.commitId,
        body: withMarker(p.body, opKey),
      });
    }
    case 'merge': {
      const p = payload as MergePayload;
      const r = await forges.author.merge(p.pr, {
        sha: p.sha,
        method: 'squash',
        title: p.title,
        message: p.message,
      });
      return r.merged ? r : null;
    }
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function markDone(db: Db, opKey: string, result: unknown, now: Date): OpResult {
  updateOutbox(db, opKey, { state: 'done', resultJson: JSON.stringify(result) }, now);
  return { state: 'done', result };
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
    const state: OutboxState =
      status !== undefined && status >= 400 && status < 500 ? 'failed' : 'unknown';
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

/** Runs one forge write at most once per `opKey` (§5.2). */
export async function runOp(db: Db, forges: ForgePair, op: Op, now: Date): Promise<OpResult> {
  const existing = getOutbox(db, op.opKey);
  if (existing) return fromExisting(db, forges, op, existing, now);
  const inserted = insertOutbox(db, {
    id: randomUUID(),
    opKey: op.opKey,
    kind: op.kind,
    workItemId: op.itemId,
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
export function sanitizeForgeText(text: string, secrets: string[], maxLen = 60_000): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  out = out.replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
  out = out.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, `$1@${ZWJ}`);
  out = out.replaceAll('://', `:${ZWJ}//`);
  out = out.replace(/(^|[^\w])(www)\./gi, `$1$2${ZWJ}.`);
  return truncate(out, maxLen);
}
