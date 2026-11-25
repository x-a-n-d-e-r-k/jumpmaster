import { randomUUID } from 'node:crypto';
import type { DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import {
  ACTIVE_STATES_SQL,
  getZoneMode,
  insertDrop,
  isKilled,
  listOpenPrTouches,
  listWorkItems,
  setWorkItemReason,
  setWorkItemState,
  type WorkItem,
} from './db/repo.js';
import { rankItems } from './sync.js';
import { dispatchGate, gateQueuesImplement } from './usage.js';
import type { CredentialProblem } from './vault/problems.js';

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/.test(e.message);

/**
 * The single path for new implement drops (Task 9's interrupted / rate-limited replacements are the
 * only other implement inserts). Refuses unless the usage gate is `open`, `override` or `probe` and no
 * implement drop is active in the zone; an item that already has an active drop returns null.
 */
export function enqueueImplement(
  db: Db,
  zone: DropZoneConfig,
  item: WorkItem,
  o: { headSha: string | null; chargedKey: string | null; promptVersion: string },
  usageCfg: UsageConfig,
  now: Date,
): string | null {
  if (isKilled(db)) return null;
  const mode = getZoneMode(db, zone.id, zone.mode);
  if (mode === 'paused' || mode === 'observe') return null;
  if (!gateQueuesImplement(dispatchGate(db, usageCfg, now))) return null;
  return db.transaction((): string | null => {
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM drops WHERE drop_zone_id = ? AND role = 'implement'
           AND state IN (${ACTIVE_STATES_SQL})`,
      )
      .get(zone.id) as { n: number };
    if (n >= (zone.maxConcurrentImplement ?? 1)) return null;
    const id = randomUUID();
    try {
      insertDrop(db, {
        id,
        dropZoneId: zone.id,
        workItemId: item.id,
        role: 'implement',
        state: 'queued',
        promptVersion: o.promptVersion,
        image: zone.image,
        headSha: o.headSha,
        chargedKey: o.chargedKey,
        createdAt: now.toISOString(),
      });
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    setWorkItemState(db, item.id, 'in_flight', undefined, now);
    return id;
  })();
}

/** A ready item with an open native blocker waits; work already started is not affected. */
export const isBlocked = (item: WorkItem): boolean => item.blockedBy.length > 0;

/** Fenced code: a line opening or closing a ``` or ~~~ block. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const PLACEMENT_HEADING = /^\s{0,3}(?:>\s*)?##\s+Placement\s*#*\s*$/i;
const NEXT_HEADING = /^\s{0,3}(?:>\s*)?#{1,2}\s/;
/** An inline code span: a run of backticks, its content, and the same run closing it. */
const CODE_SPAN = /(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;
const FILE_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/;

/**
 * The repository paths an issue's `## Placement` section names (#291): its inline code spans
 * (outside fenced blocks, up to the next `##` heading) with no whitespace inside, that contain a
 * `/` or end in a file extension. A leading `./` goes; a trailing `/` marks a directory. Sorted
 * and de-duplicated; `[]` with no Placement section.
 */
export function placementPaths(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => PLACEMENT_HEADING.test(l));
  if (start < 0) return [];
  const paths = new Set<string>();
  let fence: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const f = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    if (NEXT_HEADING.test(line)) break;
    for (const m of line.matchAll(CODE_SPAN)) {
      const span = (m[2] ?? '').trim();
      if (span === '' || /\s/.test(span) || span.includes('://')) continue;
      if (!span.includes('/') && !FILE_EXTENSION.test(span)) continue;
      const path = span.replace(/^(?:\.\/)+/, '');
      if (path !== '' && path !== '/') paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Whether two paths overlap: equal, or one a directory (trailing `/`) holding the other. */
const pathsOverlap = (a: string, b: string): boolean =>
  a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));

/**
 * The reason a ready item carries while an open PR changes a file its Placement names, or an item
 * building now names one in its own Placement (`#` the PR's or the building issue's number).
 */
export const OVERLAP_PREFIX = 'waiting: overlaps #';
export const overlapReason = (pr: number, path: string): string =>
  `${OVERLAP_PREFIX}${pr} on ${path}`;
export const isOverlapReason = (reason: string | null): boolean =>
  reason?.startsWith(OVERLAP_PREFIX) === true;

type OpenTouches = ReturnType<typeof listOpenPrTouches>;

/** An item building now (`in_flight`), with the paths its Placement names (#843). */
type InFlightPlacement = { itemId: number; issue: number; paths: string[] };

/** The zone's `in_flight` items, each with its Placement paths. */
function inFlightPlacements(db: Db, zoneId: string): InFlightPlacement[] {
  return listWorkItems(db, zoneId, 'in_flight').map((i) => ({
    itemId: i.id,
    issue: i.issueNumber,
    paths: placementPaths(i.body),
  }));
}

/**
 * The first overlap of a ready item with the zone's open PRs (#291) and with the Placement of the
 * items building now (#843), in sorted order (by path, then PR or issue number), as its waiting
 * reason; null when none. An open PR with an unknown file list and an item whose Placement names
 * no path overlap nothing. A directory match names the more specific path.
 */
export function overlapOf(
  item: Pick<WorkItem, 'id' | 'body'>,
  open: OpenTouches,
  building: readonly InFlightPlacement[] = [],
): string | null {
  const mine = placementPaths(item.body);
  if (mine.length === 0) return null;
  const hits: { path: string; pr: number }[] = [];
  const touches = [
    ...open.flatMap((o) =>
      o.files === null || o.prNumber === null
        ? []
        : [{ itemId: o.itemId, n: o.prNumber, files: o.files }],
    ),
    ...building.map((b) => ({ itemId: b.itemId, n: b.issue, files: b.paths })),
  ];
  for (const o of touches) {
    if (o.itemId === item.id) continue;
    for (const p of mine)
      for (const f of o.files)
        if (pathsOverlap(p, f)) hits.push({ path: p.length >= f.length ? p : f, pr: o.n });
  }
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.pr - b.pr));
  const first = hits[0];
  return first ? overlapReason(first.pr, first.path) : null;
}

/** The cap's words when the zone has `maxOpenPrs` or more items in `pr_open`, else null. */
export function openPrCap(
  zone: Pick<DropZoneConfig, 'maxOpenPrs'>,
  openCount: number,
): string | null {
  const cap = zone.maxOpenPrs;
  return cap !== undefined && openCount >= cap
    ? `waiting: ${openCount} open PRs (cap ${cap})`
    : null;
}

/**
 * The ready items a new implement drop may start, ranked, each with the overlap that holds it
 * back or null: an open PR changing a file its Placement names (#291), or an item building now
 * whose Placement overlaps its own (#843). `skip` items and blocked items are left out.
 */
export function readyCandidates(
  db: Db,
  zoneId: string,
  skip: ReadonlySet<number> = new Set(),
): { item: WorkItem; overlap: string | null }[] {
  const open = listOpenPrTouches(db, zoneId);
  const building = inFlightPlacements(db, zoneId);
  return rankItems(
    listWorkItems(db, zoneId, 'ready').filter((i) => !skip.has(i.id) && !isBlocked(i)),
  ).map((item) => ({ item, overlap: overlapOf(item, open, building) }));
}

/**
 * Enqueue the top-ranked unblocked ready item no open PR overlaps (#291), within the zone's
 * implement concurrency and its `maxOpenPrs` cap. Each ready item's overlap is kept as its reason
 * (`waiting: overlaps #<pr> on <path>`), cleared once the PR no longer overlaps it.
 */
export function enqueueNext(
  db: Db,
  zone: DropZoneConfig,
  promptVersion: string,
  usageCfg: UsageConfig,
  now: Date,
  /** Items not to start fresh this pass (their agent branch could not be read). */
  skip: ReadonlySet<number> = new Set(),
): string | null {
  const candidates = readyCandidates(db, zone.id, skip);
  for (const { item, overlap } of candidates) {
    if (overlap !== item.reason && (overlap !== null || isOverlapReason(item.reason)))
      setWorkItemReason(db, item.id, overlap);
  }
  if (openPrCap(zone, listWorkItems(db, zone.id, 'pr_open').length) !== null) return null;
  const top = candidates.find((c) => c.overlap === null)?.item;
  if (!top) return null;
  return enqueueImplement(
    db,
    zone,
    top,
    { headSha: null, chargedKey: null, promptVersion },
    usageCfg,
    now,
  );
}

/** Zones parked for a credential problem, with the reason (the queue reason; T12's status). */
const holds = new Map<string, string>();

/** Why a zone's dispatch waits on its credentials, or undefined. */
export const zoneHold = (zoneId: string): string | undefined => holds.get(zoneId);

/**
 * One zone's turn in a pass. A zone with a credential problem is parked: nothing of it runs (no
 * sync, no dispatch, no forge write), with `credentials: <message>` as its reason, said once when
 * it starts and once when it ends. Its drops already running keep their payloads. A zone whose
 * recorded GitHub App ids GitHub refuses is parked the same way, with `app: <message>`.
 */
export async function zonePass(
  zone: Pick<DropZoneConfig, 'id'>,
  problems: readonly CredentialProblem[],
  run: () => Promise<void>,
  log: (line: string) => void = () => {},
  /**
   * Why GitHub refuses the zone's recorded app ids (issue #267), or undefined when they verify or
   * the check could not run (it runs again next pass). Asked only when the credentials are in order.
   */
  appRefusal?: () => Promise<string | undefined>,
): Promise<{ held: string | null }> {
  const first = problems[0];
  const refused = first ? undefined : await appRefusal?.();
  const reason = first ? `credentials: ${first.message}` : refused ? `app: ${refused}` : undefined;
  if (reason) {
    if (holds.get(zone.id) !== reason) log(`zone ${zone.id} parked: ${reason}`);
    holds.set(zone.id, reason);
    return { held: reason };
  }
  if (holds.delete(zone.id)) log(`zone ${zone.id}: credentials in order, dispatch resumes`);
  await run();
  return { held: null };
}
