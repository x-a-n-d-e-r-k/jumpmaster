import { randomUUID } from 'node:crypto';
import type { DropZoneConfig } from './config.js';
import type { Db } from './db/open.js';
import { insertDrop, listWorkItems, setWorkItemState } from './db/repo.js';
import { rankItems } from './sync.js';

/** M0 runs one drop per zone: enqueue the top-ranked ready item unless a drop is already active. */
export function enqueueNext(db: Db, zone: DropZoneConfig, promptVersion: string): string | null {
  return db.transaction((): string | null => {
    const active = db
      .prepare(
        `SELECT 1 FROM drops WHERE drop_zone_id = ? AND state IN ('queued', 'leased', 'running') LIMIT 1`,
      )
      .get(zone.id);
    if (active) return null;
    const top = rankItems(listWorkItems(db, zone.id, 'ready'))[0];
    if (!top) return null;
    const id = randomUUID();
    insertDrop(db, {
      id,
      dropZoneId: zone.id,
      workItemId: top.id,
      role: 'implement',
      state: 'queued',
      promptVersion,
      image: zone.image,
    });
    setWorkItemState(db, top.id, 'in_flight');
    return id;
  })();
}
