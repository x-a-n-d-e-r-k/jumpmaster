/**
 * The backlog (crew chat, slice 1): the open issues Jumpmaster has not touched, and the owner's
 * "Work on it", which puts the zone's ready label on one of them through the outbox, so intake
 * picks it up on its next pass exactly as it would a hand-labeled issue.
 */
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { getZoneMode, isKilled } from './db/repo.js';
import type { Forge, IssueFacts } from './forge/github.js';
import { type ForgePair, isJmIssueBody, runOp, type SetLabelsPayload } from './outbox.js';

/**
 * Every label that makes an issue Jumpmaster's (ruling R15): ready, retry, the crew's staged
 * label, and both triage labels.
 */
export function jmLabelNames(
  zone: Pick<DropZoneConfig, 'readyLabel' | 'retryLabel' | 'crew' | 'triageLabel' | 'triagedLabel'>,
): string[] {
  return [
    ...new Set([
      zone.readyLabel,
      zone.retryLabel,
      zone.crew.stagedLabel,
      zone.triageLabel,
      zone.triagedLabel,
    ]),
  ];
}

export type BacklogIssue = {
  number: number;
  title: string;
  author: string;
  createdAt: string;
  /** Whether intake would take it once queued: its author has write access. */
  startable: boolean;
  /** Why it is not startable; absent when it is. */
  reason?: string;
};

const UNTRUSTED_REASON = 'its author has no write access to the repository, so intake skips it';

/** GitHub compares label names without case. */
function jmLabelOn(labels: string[], zone: DropZoneConfig): string | undefined {
  const ours = new Set(jmLabelNames(zone).map((l) => l.toLowerCase()));
  return labels.find((l) => ours.has(l.toLowerCase()));
}

/** Whether an issue is already Jumpmaster's: one of its labels, or a body it wrote. */
function jmReason(issue: Pick<IssueFacts, 'labels' | 'body'>, zone: DropZoneConfig) {
  const label = jmLabelOn(issue.labels, zone);
  if (label !== undefined) return `it already carries the Jumpmaster label ${label}`;
  if (isJmIssueBody(issue.body)) return 'it was filed by Jumpmaster';
  return undefined;
}

/**
 * The backlog rule: an issue is in the backlog when it carries no Jumpmaster label and no body
 * Jumpmaster wrote. Sync's backlog triage (#467) reads the same rule.
 */
export function isBacklogIssue(
  issue: Pick<IssueFacts, 'labels' | 'body'>,
  zone: DropZoneConfig,
): boolean {
  return jmReason(issue, zone) === undefined;
}

/** Whether `login` has write access; a failed read counts as no, as intake's does (`sync.ts`). */
async function trusted(forge: Forge, login: string): Promise<boolean> {
  try {
    return await forge.isTrusted(login);
  } catch {
    return false;
  }
}

/**
 * The zone's open issues with no Jumpmaster label and no Jumpmaster body, oldest listing order
 * kept. Each author is checked once; an author without write access makes the row unstartable.
 */
export async function listBacklog(forge: Forge, zone: DropZoneConfig): Promise<BacklogIssue[]> {
  const open = (await forge.listOpenIssues()).filter((i) => isBacklogIssue(i, zone));
  const trust = new Map<string, boolean>();
  for (const author of new Set(open.map((i) => i.author))) {
    trust.set(author, await trusted(forge, author));
  }
  return open.map((i) => ({
    number: i.number,
    title: i.title,
    author: i.author,
    createdAt: i.createdAt,
    ...(trust.get(i.author) ? { startable: true } : { startable: false, reason: UNTRUSTED_REASON }),
  }));
}

/** The outbox key of one queue request: `labels:<zone>:queue:<n>:<epoch ms>`. */
export function queueOpKey(zoneId: string, n: number, now: Date): string {
  return `labels:${zoneId}:queue:${n}:${now.getTime()}`;
}

export type QueueResult =
  | { ok: true; opKey: string }
  | { ok: false; status: 404 | 409 | 502; error: string };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Puts the zone's ready label on issue `n` through one `set_labels` op, as the author identity.
 * Refused (409, nothing written) under the kill switch, in observe mode, and for an issue that is
 * closed, a pull request, already Jumpmaster's, or by an author intake would skip. The issue is
 * read again first, so a page that is out of date never labels something it should not; a failed
 * read is a 502 with nothing written.
 */
export async function queueIssue(
  db: Db,
  forges: ForgePair,
  zone: DropZoneConfig,
  n: number,
  now: Date,
): Promise<QueueResult> {
  const refuse = (error: string): QueueResult => ({ ok: false, status: 409, error });
  if (isKilled(db)) return refuse('the kill switch is engaged: nothing is written to the forge');
  if (getZoneMode(db, zone.id, zone.mode) === 'observe')
    return refuse(`project ${zone.id} is in observe mode: nothing is written to the forge`);

  let issue: IssueFacts | null;
  try {
    issue = await forges.author.getIssue(n);
  } catch (err) {
    return { ok: false, status: 502, error: `reading issue #${n} failed: ${errorText(err)}` };
  }
  if (issue === null) return { ok: false, status: 404, error: `no issue #${n}` };
  if (issue.pullRequest) return refuse(`#${n} is a pull request, not an issue`);
  if (issue.state !== 'open') return refuse(`issue #${n} is closed`);
  const why = jmReason(issue, zone);
  if (why !== undefined) return refuse(`issue #${n} is not in the backlog: ${why}`);
  if (issue.author === undefined || !(await trusted(forges.author, issue.author)))
    return refuse(`issue #${n} cannot be started: ${UNTRUSTED_REASON}`);

  const opKey = queueOpKey(zone.id, n, now);
  const payload: SetLabelsPayload = { number: n, add: [zone.readyLabel], remove: [] };
  let state: string;
  let error: string | undefined;
  try {
    ({ state, error } = await runOp(
      db,
      forges,
      { kind: 'set_labels', opKey, zoneId: zone.id, itemId: null, payload },
      now,
    ));
  } catch (err) {
    // The kill switch or observe mode, engaged between the check above and the write.
    return refuse(errorText(err));
  }
  // `unknown` is left to the outbox's read-back, as every other forge write is.
  if (state === 'failed')
    return { ok: false, status: 502, error: `labeling issue #${n} failed: ${error ?? state}` };
  return { ok: true, opKey };
}
