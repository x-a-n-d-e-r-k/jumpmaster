import type { Db } from '../db/open.js';

/** A finished doctor drop (no work item needed) with its events' `data_json` stored verbatim. */
export function addTranscriptDrop(
  db: Db,
  d: {
    id: string;
    zone: string;
    createdAt: string;
    events?: { kind: string; dataJson: string; ts?: string }[];
    stickId?: string | null;
    finishedAt?: string | null;
    requestedModel?: string | null;
    servedModel?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO drops (id, drop_zone_id, work_item_id, role, state, stick_id, created_at,
       finished_at, requested_model, served_model)
     VALUES (?, ?, NULL, 'doctor', 'succeeded', ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.zone,
    d.stickId ?? null,
    d.createdAt,
    d.finishedAt ?? null,
    d.requestedModel ?? null,
    d.servedModel ?? null,
  );
  const ins = db.prepare(
    'INSERT INTO drop_events (drop_id, seq, ts, kind, data_json) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction(() => {
    (d.events ?? []).forEach((e, i) =>
      ins.run(d.id, i + 1, e.ts ?? d.createdAt, e.kind, e.dataJson),
    );
  })();
}
