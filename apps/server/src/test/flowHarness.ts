import type { DropPayload, DropResult, Role } from '@jumpmaster/protocol';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../app.js';
import type { Config, DropZoneConfig } from '../config.js';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import { getDropZoneDefaultBranch } from '../db/repo.js';
import { type ReconcileReport, reconcileZone } from '../flow/reconcile.js';
import { zonePass } from '../flow/snapshot.js';
import type { ForgeIssue } from '../forge/github.js';
import { promptVersions } from '../payloads.js';
import { syncDropZone } from '../sync.js';
import { type FakeForge, type FakeForgeState, fakeForgePair } from './fakes.js';
import { makeZone, usageCfg } from './fixtures.js';
import { tmpDbFile } from './helpers.js';

const PROTO = { 'x-jumpmaster-protocol': '1' };
const START = new Date('2026-01-01T00:00:00Z');

export interface Harness {
  db: Db;
  forge: { author: FakeForge; reviewer: FakeForge; state: FakeForgeState };
  zone: DropZoneConfig;
  app: FastifyInstance;
  now(): Date;
  /** Advances the injected clock by `minutes`. */
  at(minutes: number): Date;
  sync(): Promise<void>;
  /** `syncDropZone`, then `zonePass` once, then `reconcileZone` with that pass. */
  reconcile(): Promise<ReconcileReport>;
  queuedRoles(): Role[];
  /** Deletes all workflow rows and resets usage; the forge state is kept. */
  wipeDbKeepIssues(): void;
  lease(): Promise<{ dropId: string; epoch: number; payload: DropPayload }>;
  postResult(dropId: string, epoch: number, result: DropResult): Promise<number>;
  /** Leases the next drop (it must have `role`), simulates its push, and posts `result`. */
  finishDrop(role: Role, result: DropResult): Promise<number>;
}

export async function harness(
  opts: { zone?: Partial<DropZoneConfig>; issues?: ForgeIssue[] } = {},
): Promise<Harness> {
  const db = openDb(tmpDbFile());
  const issues = opts.issues ?? [
    {
      number: 1,
      title: 'Issue 1',
      body: 'b',
      author: 'human',
      labels: ['agent-ready'],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const f = fakeForgePair({ issues, trusted: ['human'] });
  const forges = { author: f.author, reviewer: f.reviewer };
  const zone = makeZone({ ciRequired: false, ...opts.zone });
  const config: Config = {
    listen: { host: '127.0.0.1', port: 0 },
    dataDir: '.',
    pollSeconds: 60,
    dropZones: [zone],
    secrets: {
      claudeToken: 'claude-token',
      githubAuthorToken: 'author-token',
      githubReviewerToken: 'reviewer-token',
      joinToken: 'join',
    },
    usage: usageCfg,
  };
  let clock = START;
  const rand = () => 0;
  const app = createApp({
    db,
    config,
    forgesFor: () => forges,
    now: () => clock,
    rand,
    leaseWaitMs: 0,
    leasePollMs: 0,
  });
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: PROTO,
    payload: { joinToken: 'join', name: 'h', slots: 4 },
  });
  const { stickToken } = enroll.json() as { stickToken: string };
  const auth = { ...PROTO, authorization: `Bearer ${stickToken}` };

  const h: Harness = {
    db,
    forge: f,
    zone,
    app,
    now: () => clock,
    at(minutes) {
      clock = new Date(clock.getTime() + minutes * 60_000);
      return clock;
    },
    async sync() {
      await syncDropZone(db, forges.author, zone);
    },
    async reconcile() {
      await syncDropZone(db, forges.author, zone);
      const base = getDropZoneDefaultBranch(db, zone.id) ?? 'main';
      const pass = await zonePass(forges, zone, base);
      return reconcileZone(db, forges, zone, pass, promptVersions(), usageCfg, [], clock);
    },
    queuedRoles() {
      return (
        db
          .prepare(`SELECT role FROM drops WHERE state = 'queued' ORDER BY created_at, rowid`)
          .all() as { role: Role }[]
      ).map((r) => r.role);
    },
    wipeDbKeepIssues() {
      db.exec(`DELETE FROM outbox; DELETE FROM attempts; DELETE FROM verdicts;
        DELETE FROM pull_requests; DELETE FROM drop_events; DELETE FROM drops;
        DELETE FROM work_items;
        UPDATE usage_state SET status = NULL, paused_until = NULL, five_hour_util = NULL,
          five_hour_resets_at = NULL, seven_day_util = NULL, seven_day_resets_at = NULL,
          observed_at = NULL, paused_at = NULL, pause_confirmed = 0, probe_drop_id = NULL,
          probe_not_before = NULL, cause_drop_id = NULL, cause_work_item_id = NULL;`);
    },
    async lease() {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sticks/lease',
        headers: auth,
        payload: { freeSlots: 1 },
      });
      if (res.statusCode !== 200) throw new Error(`lease returned ${res.statusCode}`);
      const payload = res.json() as DropPayload;
      return { dropId: payload.dropId, epoch: payload.epoch, payload };
    },
    async postResult(dropId, epoch, result) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/drops/${dropId}/result`,
        headers: auth,
        payload: { epoch, result },
      });
      return res.statusCode;
    },
    async finishDrop(role, result) {
      const { dropId, epoch, payload } = await h.lease();
      if (payload.role !== role) throw new Error(`expected a ${role} drop, leased ${payload.role}`);
      const pushed = result.status === 'completed' || result.status === 'interrupted';
      if (pushed && result.headSha) {
        if (payload.role === 'implement') f.state.branches.set(payload.branch, result.headSha);
        else if (payload.role !== 'review') f.state.setHead(payload.pr.number, result.headSha);
      }
      return h.postResult(dropId, epoch, result);
    },
  };
  return h;
}

/** Implement completed at `sha` → reconcile → review approved; stops before the merging reconcile. */
export async function toApproved(h: Harness, sha: string): Promise<void> {
  await h.reconcile();
  const status = await h.finishDrop('implement', {
    status: 'completed',
    headSha: sha,
    gates: [{ name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' }],
  });
  if (status !== 204) throw new Error(`implement result returned ${status}`);
  await h.reconcile();
  const review = await h.finishDrop('review', {
    status: 'completed',
    gates: [{ name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' }],
    verdict: { decision: 'approve', summary: 'ok', findings: [] },
  });
  if (review !== 204) throw new Error(`review result returned ${review}`);
}
