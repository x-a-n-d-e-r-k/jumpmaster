import type { DropPayload, DropResult, Role } from '@jumpmaster/protocol';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createApp } from '../app.js';
import { syncParkBriefings } from '../briefings.js';
import { ConfigStore } from '../config/store.js';
import type { ClaudeConfig, Config, DropZoneConfig, UsageConfig } from '../config.js';
import { creditsPass } from '../credits.js';
import type { Db } from '../db/open.js';
import { openDb } from '../db/open.js';
import { type ReconcileReport, reconcileZone } from '../flow/reconcile.js';
import type { ImageMirror, ImageStatus } from '../images/mirror.js';
import type { ForgePair } from '../outbox.js';
import { promptVersions } from '../payloads.js';
import { syncDropZone } from '../sync.js';
import { crewOn } from './crew.js';
import { type FakeForge, type FakeForgeState, type FakeIssue, fakeForgePair } from './fakes.js';
import { makeZone, usageCfg } from './fixtures.js';
import { operatorSession, tmpDbFile } from './helpers.js';

const PROTO = { 'x-jumpmaster-protocol': '1' };
const START = new Date('2026-01-01T00:00:00Z');

export interface Harness {
  db: Db;
  forge: { author: FakeForge; reviewer: FakeForge; state: FakeForgeState };
  /** The pair every pass and route uses. */
  forges: ForgePair;
  zone: DropZoneConfig;
  app: FastifyInstance;
  now(): Date;
  /** Advances the injected clock by `minutes`. */
  at(minutes: number): Date;
  sync(): Promise<void>;
  /**
   * As the server's pass: the global credits step, `syncDropZone` (which reads the zone pass
   * once), then `reconcileZone` with that pass.
   */
  reconcile(): Promise<ReconcileReport>;
  queuedRoles(): Role[];
  /** Headers for a stick route, enrolling on first use. */
  stickHeaders(): Record<string, string>;
  /** The harness stick's id. */
  stickId: string;
  /** Enrolls another stick: its id and the headers for its stick routes. */
  enrollStick(name: string): Promise<{ stickId: string; headers: Record<string, string> }>;
  /**
   * A raw lease call (the harness stick's headers unless given), so a 204 with its headers can be
   * read. `body` is sent as is: `freeSlots` defaults to 1.
   */
  leaseRaw(
    body?: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
  /** Deletes all workflow rows and resets usage; the forge state is kept. */
  wipeDbKeepIssues(): void;
  lease(): Promise<{ dropId: string; epoch: number; payload: DropPayload }>;
  postResult(dropId: string, epoch: number, result: DropResult): Promise<number>;
  /** Leases the next drop (it must have `role`), simulates its push, and posts `result`. */
  finishDrop(role: Role, result: DropResult): Promise<number>;
  /** GETs a page as the logged-in operator (a session made at the current clock). */
  view(url: string, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** With `live`: the config store the app and every pass read (db mode, applied as `ctl`). */
  store?: ConfigStore;
}

export async function harness(
  opts: {
    zone?: Partial<DropZoneConfig>;
    issues?: FakeIssue[];
    zoneSecrets?: Record<string, string>;
    dataDir?: string;
    usage?: Partial<UsageConfig>;
    /** Called when a route asks for a pass at once. */
    kick?: () => void;
    /**
     * Run on a config store, as the server does: the app reads it per request and `reconcile` once
     * per pass, so a revision applied between passes is the next pass's. The zone must be one
     * `parseEditable` accepts (its protectedPaths must cover crew.goalPath).
     */
    live?: boolean;
    /** More zones beside the harness's own (configured only: the harness drives its own zone). */
    extraZones?: Partial<DropZoneConfig>[];
    /**
     * The zone's push grant (`ForgePair.pusher`): `true` is the fake author forge, as in PAT mode.
     * Absent, the pair has none, and a behind PR always gets a resolve drop.
     */
    pusher?: true | ForgePair['pusher'];
    /** The GitHub reads the zone's GitHub page makes (with `live`). */
    guidanceForge?: Parameters<typeof createApp>[0]['guidanceForge'];
    /** The declared Claude plan (default `pro`: no Fable). */
    claude?: ClaudeConfig;
    /** The server's release version (`JM_RELEASE_VERSION`); default `dev`. */
    version?: string;
    /** The image mirror the stick routes read (`fakeMirror`); absent, none. */
    images?: Pick<ImageMirror, 'lookup' | 'status'>;
    /** The install's `sticks` settings. */
    sticks?: Config['sticks'];
    /** The lease long-poll's wait and round (default 0: one round). */
    leaseWaitMs?: number;
    leasePollMs?: number;
  } = {},
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
  const f = fakeForgePair({ issues, trusted: ['human', 'alice'] });
  const zone = makeZone({ ciRequired: false, ...opts.zone });
  // Starter mode: no reviewer identity, no reviewer token, and rules that need no approval.
  const starter = zone.identity === 'starter';
  if (starter)
    f.state.rules.author = {
      kind: 'ok',
      rules: {
        requiredApprovals: 0,
        dismissStaleOnPush: false,
        requiredChecks: zone.ciRequired ? ['ci'] : [],
        unpinnedChecks: [],
        viewerCanBypass: false,
        viewerIsAdmin: false,
        requiresPullRequest: true,
      },
    };
  const pusher: ForgePair['pusher'] =
    opts.pusher === true ? async () => ({ forge: f.author, release: async () => {} }) : opts.pusher;
  const forges: ForgePair = {
    author: f.author,
    reviewer: starter ? null : f.reviewer,
    ...(pusher ? { pusher } : {}),
  };
  const config: Config = {
    listen: { host: '127.0.0.1', port: 0, allowedHosts: ['localhost:80'] },
    dataDir: opts.dataDir ?? '.',
    pollSeconds: 60,
    dropZones: [zone, ...(opts.extraZones ?? []).map((z) => makeZone(z))],
    claude: opts.claude ?? { plan: 'pro', fableWeeklyDropCap: 5 },
    secrets: {
      claudeToken: 'claude-token',
      githubAuthorToken: 'author-token',
      ...(starter ? {} : { githubReviewerToken: 'reviewer-token' }),
      joinToken: 'join',
      operatorToken: 'o'.repeat(32),
      ...(opts.zoneSecrets ? { zoneSecrets: { [zone.id]: opts.zoneSecrets } } : {}),
    },
    usage: { ...usageCfg, ...opts.usage },
    ...(opts.sticks ? { sticks: opts.sticks } : {}),
  };
  let clock = START;
  const rand = () => 0;
  const store = opts.live ? liveStore(db, config, () => clock) : undefined;
  /** The config a pass or request reads: the store's current one when live. */
  const current = (): Config => store?.current() ?? config;
  const zoneNow = (): DropZoneConfig =>
    store ? (current().dropZones.find((z) => z.id === zone.id) ?? zone) : zone;
  const app = createApp({
    db,
    config: store ?? config,
    forgesFor: () => forges,
    now: () => clock,
    rand,
    leaseWaitMs: opts.leaseWaitMs ?? 0,
    leasePollMs: opts.leasePollMs ?? 0,
    version: opts.version ?? 'dev',
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.kick ? { kick: opts.kick } : {}),
    ...(opts.guidanceForge ? { guidanceForge: opts.guidanceForge } : {}),
  });
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/sticks/enroll',
    headers: PROTO,
    payload: { joinToken: 'join', name: 'h', slots: 4 },
  });
  const { stickToken, stickId } = enroll.json() as { stickToken: string; stickId: string };
  const auth = { ...PROTO, authorization: `Bearer ${stickToken}` };

  const h: Harness = {
    view(url, headers = {}) {
      return app.inject({
        method: 'GET',
        url,
        headers: { cookie: operatorSession(db, clock).cookie, ...headers },
      });
    },
    db,
    forge: f,
    forges,
    zone,
    app,
    ...(store ? { store } : {}),
    now: () => clock,
    at(minutes) {
      clock = new Date(clock.getTime() + minutes * 60_000);
      return clock;
    },
    async sync() {
      await syncDropZone(db, forges, zoneNow(), clock);
    },
    async reconcile() {
      // One config per pass, read at its start, as main.ts does.
      const c = current();
      const z = zoneNow();
      creditsPass(db, clock);
      const { pass } = await syncDropZone(db, forges, z, clock);
      return reconcileZone(db, forges, z, pass, promptVersions(), c.usage, [], clock, undefined, {
        claude: c.claude,
      });
    },
    stickHeaders: () => auth,
    stickId,
    async enrollStick(name) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sticks/enroll',
        headers: PROTO,
        payload: { joinToken: 'join', name, slots: 4 },
      });
      const j = res.json() as { stickToken: string; stickId: string };
      return {
        stickId: j.stickId,
        headers: { ...PROTO, authorization: `Bearer ${j.stickToken}` },
      };
    },
    leaseRaw(body = {}, headers = auth) {
      return app.inject({
        method: 'POST',
        url: '/api/sticks/lease',
        headers,
        payload: { freeSlots: 1, ...body },
      });
    },
    queuedRoles() {
      return (
        db
          .prepare(`SELECT role FROM drops WHERE state = 'queued' ORDER BY created_at, rowid`)
          .all() as { role: Role }[]
      ).map((r) => r.role);
    },
    wipeDbKeepIssues() {
      db.exec(`DELETE FROM outbox; DELETE FROM attempts; DELETE FROM branch_updates; DELETE FROM verdicts;
        DELETE FROM pull_requests; DELETE FROM drop_events; DELETE FROM drops;
        DELETE FROM work_items; DELETE FROM usage_windows;
        UPDATE usage_state SET status = NULL, paused_until = NULL, five_hour_util = NULL,
          five_hour_resets_at = NULL, seven_day_util = NULL, seven_day_resets_at = NULL,
          observed_at = NULL, paused_at = NULL, pause_confirmed = 0, probe_drop_id = NULL,
          probe_not_before = NULL, cause_drop_id = NULL, cause_work_item_id = NULL,
          overage_stopped_at = NULL, overage_drop_id = NULL, overage_until = NULL,
          overage_signal_json = NULL, overage_resume_until = NULL, overage_resume_drop_id = NULL,
          overage_resume_work_item_id = NULL, overage_resumed_at = NULL, overage_probe_since = NULL,
          override_until = NULL, override_starts = NULL, override_starts_left = NULL,
          override_by = NULL;`);
    },
    async lease() {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sticks/lease',
        headers: auth,
        payload: { freeSlots: 1, capabilities: ['push-v1'] },
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
        else if (payload.role === 'heal' || payload.role === 'resolve') {
          f.state.setHead(payload.pr.number, result.headSha);
        }
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

/**
 * Reconcile (queues implement) → implement completed at `sha`: the item is pr_open with PR 1 and
 * no drop is queued yet (the next reconcile would queue its review).
 */
export async function toPrOpen(h: Harness, sha: string): Promise<void> {
  await h.reconcile();
  const status = await h.finishDrop('implement', {
    status: 'completed',
    headSha: sha,
    gates: [{ name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' }],
  });
  if (status !== 204) throw new Error(`implement result returned ${status}`);
}

const gateOk = { name: 'test', exitCode: 0, durationMs: 10, timedOut: false, outputTail: '' };

/** The `n`th head of a harness item's PR: forty hex characters. */
export const headN = (n: number): string => `${n.toString(16).padStart(2, '0')}`.padEnd(40, 'a');

/**
 * Where one heal round's feedback comes from: the reviewer's request-changes, a trusted person's
 * change request on the head (after the reviewer's), or CI failing on a head the reviewer approved
 * (the zone must require CI).
 */
export type HealRound = 'review' | 'human' | 'ci';

/**
 * Drives issue 1 through the real flow until it parks on `budget exhausted: heal`: implement at
 * head 1, then one heal per round (head n+1 each), then a review that requests changes on the last
 * head with no heal left. Its parked briefing is raised before returning, as the next pass would.
 * `rounds` must spend the zone's `maxHeal`. No crew drop runs: without GOAL.md no lead cycle does.
 */
export async function toHealsExhausted(
  h: Harness,
  rounds: HealRound[] = ['review', 'review', 'review'],
): Promise<void> {
  if (h.zone.ciRequired) {
    // Branch rules that require the check CI reports, so a required-CI zone is safe to run.
    for (const id of ['author', 'reviewer'] as const) {
      const r = h.forge.state.rules[id];
      if (r.kind === 'ok') r.rules.requiredChecks = ['ci'];
    }
  }
  await toPrOpen(h, headN(1));
  for (const [i, round] of rounds.entries()) {
    const head = headN(i + 1);
    await h.reconcile();
    const decision = round === 'ci' ? 'approve' : 'request_changes';
    await h.finishDrop('review', {
      status: 'completed',
      gates: [gateOk],
      verdict: {
        decision,
        summary: `round ${i + 1}`,
        findings: decision === 'approve' ? [] : [{ severity: 'major', detail: `finding ${i + 1}` }],
      },
    });
    if (round === 'human') {
      h.forge.state.review({ state: 'CHANGES_REQUESTED', body: 'please fix', commitId: head });
    }
    if (round === 'ci') {
      h.forge.state.checks.set(head, {
        state: 'failure',
        names: ['ci'],
        failed: [{ name: 'ci', conclusion: 'failure' }],
      });
    }
    for (let n = 0; n < 5 && !h.queuedRoles().includes('heal'); n++) await h.reconcile();
    await h.finishDrop('heal', {
      status: 'completed',
      headSha: headN(i + 2),
      gates: [gateOk],
      summary: `healed round ${i + 1}`,
    });
  }
  await h.reconcile();
  await h.finishDrop('review', {
    status: 'completed',
    gates: [gateOk],
    verdict: {
      decision: 'request_changes',
      summary: 'still wrong',
      findings: [{ severity: 'major', detail: 'the last finding' }],
    },
  });
  await h.reconcile();
  syncParkBriefings(h.db, h.zone, h.now());
}

/** A declared plan with Fable available. */
export const FABLE_CLAUDE: ClaudeConfig = {
  plan: 'max',
  fableModel: 'claude-fable-1',
  fableWeeklyDropCap: 50,
};

/**
 * A harness with the crew (and its arbiter) on, Fable available, and issue intake ungated, so its
 * issue 1 runs the real flow while crew work is scheduled beside it.
 */
export function arbiterHarness(
  o: { zone?: Partial<DropZoneConfig>; claude?: ClaudeConfig } = {},
): Promise<Harness> {
  return harness({
    zone: { crew: crewOn, triage: { gate: false }, ...o.zone },
    claude: o.claude ?? FABLE_CLAUDE,
  });
}

/** An arbiter's output: ruling `ruling`, reversible, not a product question. */
export const ruling = (
  r: 'A' | 'B' | 'insufficient_evidence',
  o: Partial<{
    because: string;
    instruction: string;
    reversible: boolean;
    productQuestion: boolean;
  }> = {},
) => ({
  ruling: r,
  because: o.because ?? `ruled ${r} on the evidence`,
  wouldReverse: 'a failing test',
  reversible: o.reversible ?? true,
  productQuestion: o.productQuestion ?? false,
  instruction: o.instruction ?? `do the ${r} thing`,
});

/**
 * Plays issue 1's review rounds until it leaves `pr_open`: each queued review answers `decide`'s
 * verdict for the head, each heal pushes a fresh head from `nextHead` on. Returns the last head.
 */
export async function reviewRounds(
  h: Harness,
  decide: (round: number) => 'approve' | 'request_changes',
  nextHead = 20,
): Promise<number> {
  let head = nextHead;
  for (let round = 0; round < 12; round++) {
    const state = (
      h.db.prepare('SELECT state FROM work_items WHERE id = 1').get() as { state: string }
    ).state;
    const queued = h.queuedRoles().filter((r) => r === 'review' || r === 'heal');
    if (state !== 'pr_open' || queued.length === 0) break;
    if (queued[0] === 'review') {
      const decision = decide(round);
      await h.finishDrop('review', {
        status: 'completed',
        gates: [gateOk],
        verdict: {
          decision,
          summary: `again ${round}`,
          findings: decision === 'approve' ? [] : [{ severity: 'major', detail: `again ${round}` }],
        },
      });
    } else {
      await h.finishDrop('heal', { status: 'completed', headSha: headN(head++), gates: [gateOk] });
    }
    await h.reconcile();
  }
  return head;
}

/** A db-mode store holding `config`'s editable part as revision 2, with `config`'s secrets. */
function liveStore(db: Db, config: Config, now: () => Date): ConfigStore {
  const store = ConfigStore.open({
    db,
    boot: {
      listen: {
        host: config.listen.host,
        port: config.listen.port,
        allowedHosts: config.listen.allowedHosts ?? [],
        tlsTerminated: false,
      },
      dataDir: config.dataDir,
      source: { listen: 'env', dataDir: 'env' },
    },
    env: {},
    now,
    secretsFor: () => config.secrets,
  });
  const { listen: _l, dataDir: _d, secrets: _s, ...editable } = config;
  const r = store.apply(editable, {
    via: 'ctl',
    principal: { kind: 'operator', via: 'token', sudo: true },
  });
  if (!r.ok) throw new Error(`harness config refused: ${JSON.stringify(r)}`);
  return store;
}

/** The digest of the stick image `fakeMirror` holds. */
export const STICK_DIGEST = `sha256:${'5'.repeat(64)}`;
export const MIRROR_REGISTRY = 'ghcr.io/owner';

/**
 * A mirror whose current lock holds a `jumpmaster-stick` image (unless `stick: false`), complete
 * unless `complete: false`. `throws` makes its status or lookup throw. Every field is read afresh,
 * so a test may change them on the returned object.
 */
export function fakeMirror(
  o: { stick?: boolean; complete?: boolean; throws?: 'status' | 'lookup' } = {},
): Pick<ImageMirror, 'lookup' | 'status'> & {
  stick: boolean;
  complete: boolean;
  throws?: 'status' | 'lookup';
} {
  const m = {
    stick: o.stick ?? true,
    complete: o.complete ?? true,
    ...(o.throws ? { throws: o.throws } : {}),
    status() {
      if (m.throws === 'status') throw new Error('the index is unreadable');
      const image = (name: string, digest: string): ImageStatus => ({
        name,
        digest,
        ref: `${MIRROR_REGISTRY}/${name}@${digest}`,
        state: m.complete ? 'complete' : 'pending',
        platforms: [],
        size: 0,
        current: true,
      });
      return {
        lock: true,
        images: [
          image('jumpmaster-trooper', `sha256:${'7'.repeat(64)}`),
          ...(m.stick ? [image('jumpmaster-stick', STICK_DIGEST)] : []),
        ],
      };
    },
    lookup(name: string, digest: string) {
      if (m.throws === 'lookup') throw new Error('the store is unreadable');
      if (!m.stick || name !== 'jumpmaster-stick' || digest !== STICK_DIGEST)
        return { listed: false as const };
      return {
        listed: true as const,
        complete: m.complete,
        record: {} as never,
        store: {} as never,
      };
    },
  };
  return m;
}
