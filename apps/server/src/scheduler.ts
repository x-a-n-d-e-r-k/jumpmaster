import { randomUUID } from 'node:crypto';
import type { DropZoneConfig, UsageConfig } from './config.js';
import type { Db } from './db/open.js';
import { insertDrop, listWorkItems, setWorkItemState, type WorkItem } from './db/repo.js';
import { rankItems } from './sync.js';
import { dispatchGate } from './usage.js';

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && /UNIQUE constraint failed/.test(e.message);

/**
 * The single path for new implement drops (Task 9's interrupted / rate-limited replacements are the
 * only other implement inserts). Refuses unless the usage gate is `open` or `probe` and no implement
 * drop is active in the zone; an item that already has an active drop returns null.
 */
export function enqueueImplement(
  db: Db,
  zone: DropZoneConfig,
  item: WorkItem,
  o: { headSha: string | null; chargedKey: string | null; promptVersion: string },
  usageCfg: UsageConfig,
  now: Date,
): string | null {
  const gate = dispatchGate(db, usageCfg, now);
  if (gate !== 'open' && gate !== 'probe') return null;
  return db.transaction((): string | null => {
    const activeImplement = db
      .prepare(
        `SELECT 1 FROM drops WHERE drop_zone_id = ? AND role = 'implement'
           AND state IN ('queued', 'leased', 'running') LIMIT 1`,
      )
      .get(zone.id);
    if (activeImplement) return null;
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

/** Enqueue the top-ranked ready item (at most one active implement drop per zone). */
export function enqueueNext(
  db: Db,
  zone: DropZoneConfig,
  promptVersion: string,
  usageCfg: UsageConfig,
  now: Date,
  /** Items not to start fresh this pass (their agent branch could not be read). */
  skip: ReadonlySet<number> = new Set(),
): string | null {
  const top = rankItems(listWorkItems(db, zone.id, 'ready').filter((i) => !skip.has(i.id)))[0];
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
