import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listAudit } from '../auth/audit.js';
import { listBriefings, raiseBriefing } from '../briefings.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { type Db, openDb } from '../db/open.js';
import {
  getZoneMode,
  insertDrop,
  setZoneMode,
  updateDrop,
  upsertDropZone,
  upsertWorkItem,
  zoneStopping,
} from '../db/repo.js';
import { plus, t0, tmpDbFile } from '../test/helpers.js';
import { removeZone, stopZone, sweepStopping, withdrawOrphanBriefings } from './stop.js';

const env = {
  JM_CLAUDE_TOKEN: 'sk-ant-' + 'oat01-STOPCLAUDEDUMMY0123456789',
  JM_GITHUB_AUTHOR_TOKEN: 'github_pat_' + 'STOPAUTHORDUMMY0123456789',
  JM_GITHUB_REVIEWER_TOKEN: 'github_pat_' + 'STOPREVIEWERDUMMY0123456789',
  JM_JOIN_TOKEN: 'join-secret-value-4',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};
const token = { kind: 'operator' as const, via: 'token' as const, sudo: true };
const zd = (id: string) => ({
  id,
  repo: `octo/${id}`,
  gates: [{ name: 'test', run: 'npm test' }],
  image: 'jm-trooper:dev',
});

const dir = () => mkdtempSync(join(tmpdir(), 'jm-stop-'));
const openStore = (db: Db, lock: string, filePath?: string) =>
  ConfigStore.open({
    db,
    boot: loadBoot({}, filePath),
    ...(filePath ? { filePath } : {}),
    env,
    now: () => t0,
    imageLockPath: lock,
  });

function world() {
  const file = tmpDbFile();
  const lock = join(dir(), 'no-lock.json');
  const db = openDb(file);
  const store = openStore(db, lock);
  store.apply({ dropZones: [zd('a'), zd('b')] }, { via: 'ctl', principal: token });
  for (const id of ['a', 'b']) {
    upsertDropZone(db, { id, repo: `octo/${id}`, defaultBranch: 'main', configJson: '{}' });
    setZoneMode(db, id, 'active', t0);
  }
  return { file, lock, db, store };
}

/** A running implement drop in zone `a`. */
function runningDrop(db: Db) {
  const item = upsertWorkItem(db, {
    dropZoneId: 'a',
    issueNumber: 1,
    title: 't',
    body: 'b',
    author: 'x',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  });
  insertDrop(db, {
    id: 'd1',
    dropZoneId: 'a',
    workItemId: item.id,
    role: 'implement',
    state: 'running',
    createdAt: t0.toISOString(),
  });
}

const ids = (store: ConfigStore) => store.current().dropZones.map((z) => z.id);

describe('stopping a zone', () => {
  test('an active zone with a running drop goes to observe, stays while the drop runs, and goes once it finishes', () => {
    const { db, store } = world();
    runningDrop(db);
    const r = stopZone(db, store, 'a', { via: 'ui', principal: token, now: t0 });
    expect(r).toEqual({ kind: 'stopping', waits: { drops: 1, pushes: 0, outbox: 0 } });
    expect(getZoneMode(db, 'a', 'active')).toBe('observe');
    expect(zoneStopping(db, 'a')).toEqual({ since: t0.toISOString(), via: 'ui' });
    expect(sweepStopping(db, store, plus(t0, 1000))).toEqual([]);
    expect(ids(store)).toEqual(['a', 'b']);
    updateDrop(db, 'd1', { state: 'succeeded' });
    expect(sweepStopping(db, store, plus(t0, 2000))).toEqual(['a']);
    expect(ids(store)).toEqual(['b']);
    // Its mode row (and with it the mark) goes; its history stays for a later Resume.
    expect(zoneStopping(db, 'a')).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM drops WHERE drop_zone_id = 'a'").get()).toEqual({
      n: 1,
    });
    expect(listAudit(db)[0]).toMatchObject({ action: 'zone.remove', target: 'a', via: 'system' });
    // A sweep with nothing stopping does nothing.
    expect(sweepStopping(db, store, plus(t0, 3000))).toEqual([]);
  });

  test('an already-drained zone is removed at once', () => {
    const { db, store } = world();
    const r = stopZone(db, store, 'a', { via: 'ctl', principal: token, now: t0 });
    expect(r.kind).toBe('removed');
    expect(ids(store)).toEqual(['b']);
    expect(zoneStopping(db, 'a')).toBeUndefined();
  });

  test('a zone marked stopping before a restart is removed once drained after it', () => {
    const { file, lock, db, store } = world();
    runningDrop(db);
    expect(stopZone(db, store, 'a', { via: 'ui', principal: token, now: t0 }).kind).toBe(
      'stopping',
    );
    db.close();
    const db2 = openDb(file);
    const store2 = openStore(db2, lock);
    expect(ids(store2)).toEqual(['a', 'b']);
    expect(sweepStopping(db2, store2, plus(t0, 1000))).toEqual([]);
    updateDrop(db2, 'd1', { state: 'failed' });
    expect(sweepStopping(db2, store2, plus(t0, 2000))).toEqual(['a']);
    expect(ids(store2)).toEqual(['b']);
  });

  test('in file mode nothing is marked: the refusal is the apply path’s', () => {
    const d = dir();
    const filePath = join(d, 'jumpmaster.config.json');
    writeFileSync(filePath, JSON.stringify({ dataDir: './data', dropZones: [zd('a')] }));
    const db = openDb(tmpDbFile());
    const store = openStore(db, join(d, 'no-lock.json'), filePath);
    setZoneMode(db, 'a', 'active', t0);
    const r = stopZone(db, store, 'a', { via: 'ctl', principal: token, now: t0 });
    expect(r.kind).toBe('refused');
    expect(getZoneMode(db, 'a', 'active')).toBe('active');
    expect(zoneStopping(db, 'a')).toBeUndefined();
  });
});

const brief = (zoneId: string, subject: string) => ({
  zoneId,
  kind: 'parked' as const,
  subject,
  decision: `Parked ${subject}?`,
  why: 'w',
  options: [{ id: 'retry', label: 'Retry', effect: 'none' as const }],
  source: 'server' as const,
});
const states = (db: Db, zoneId: string) => listBriefings(db, { zoneId }).map((b) => b.state);

describe('removing a zone withdraws its open briefings (#178)', () => {
  test('only the removed zone’s open briefings are withdrawn, with one audit entry', () => {
    const { db, store } = world();
    for (const z of ['a', 'b'])
      for (const s of ['item:1', 'item:2']) raiseBriefing(db, brief(z, s), t0);
    const r = stopZone(db, store, 'a', {
      via: 'ctl',
      principal: token,
      now: t0,
    });
    expect(r.kind).toBe('removed');
    expect(states(db, 'a')).toEqual(['withdrawn', 'withdrawn']);
    expect(states(db, 'b')).toEqual(['open', 'open']);
    const withdrawals = listAudit(db).filter((a) => a.action === 'briefing.withdraw');
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({
      target: 'a',
      detail: { count: 2, reason: 'zone removed' },
    });
  });

  test('a zone removed by the stopping sweep once drained has its briefings withdrawn', () => {
    const { db, store } = world();
    runningDrop(db);
    raiseBriefing(db, brief('a', 'item:1'), t0);
    raiseBriefing(db, brief('b', 'item:1'), t0);
    expect(stopZone(db, store, 'a', { via: 'ui', principal: token, now: t0 }).kind).toBe(
      'stopping',
    );
    expect(states(db, 'a')).toEqual(['open']);
    updateDrop(db, 'd1', { state: 'succeeded' });
    expect(sweepStopping(db, store, plus(t0, 1000))).toEqual(['a']);
    expect(states(db, 'a')).toEqual(['withdrawn']);
    expect(states(db, 'b')).toEqual(['open']);
  });

  test('a removal refused for a revision conflict withdraws nothing', () => {
    const { db, store } = world();
    raiseBriefing(db, brief('a', 'item:1'), t0);
    const r = removeZone(db, store, 'a', {
      via: 'ctl',
      principal: token,
      expectRevision: store.revision() - 1,
      now: t0,
    });
    expect(r.ok).toBe(false);
    expect(ids(store)).toEqual(['a', 'b']);
    expect(states(db, 'a')).toEqual(['open']);
    expect(listAudit(db).filter((a) => a.action === 'briefing.withdraw')).toEqual([]);
  });

  test('a removal refused in file mode withdraws nothing', () => {
    const d = dir();
    const filePath = join(d, 'jumpmaster.config.json');
    writeFileSync(filePath, JSON.stringify({ dataDir: './data', dropZones: [zd('a')] }));
    const db = openDb(tmpDbFile());
    const store = openStore(db, join(d, 'no-lock.json'), filePath);
    raiseBriefing(db, brief('a', 'item:1'), t0);
    expect(stopZone(db, store, 'a', { via: 'ctl', principal: token, now: t0 }).kind).toBe(
      'refused',
    );
    expect(states(db, 'a')).toEqual(['open']);
  });
});

describe('the start-up sweep of orphan briefings (#178)', () => {
  test('withdraws only briefings of zones not in the config, once', () => {
    const { db, store } = world();
    raiseBriefing(db, brief('a', 'item:1'), t0);
    raiseBriefing(db, brief('old', 'item:1'), t0);
    raiseBriefing(db, brief('old', 'item:2'), t0);
    expect(withdrawOrphanBriefings(db, store, t0)).toBe(2);
    expect(states(db, 'old')).toEqual(['withdrawn', 'withdrawn']);
    expect(states(db, 'a')).toEqual(['open']);
    const audited = () => listAudit(db).filter((a) => a.action === 'briefing.withdraw');
    expect(audited()).toHaveLength(1);
    expect(audited()[0]).toMatchObject({ via: 'system', detail: { count: 2 } });
    // A second run changes nothing more.
    expect(withdrawOrphanBriefings(db, store, plus(t0, 1000))).toBe(0);
    expect(states(db, 'a')).toEqual(['open']);
    expect(audited()).toHaveLength(1);
  });
});
