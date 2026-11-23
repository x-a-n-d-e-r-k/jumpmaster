import {
  type PushGrant,
  PushPayloadSchema,
  type PushPlan,
  type PushResult,
  READY_LINE,
} from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { Beat, GrantReply, PlanReply, PushClient } from './client.js';
import type { ContainerDriver, ContainerHandle, DropNet } from './driver.js';
import {
  backoffMs,
  createPushLoop,
  grantSecrets,
  MAX_CONCURRENT_PUSHES,
  NO_RESULT_RETRIES,
  PendingPushes,
  PUSH_BACKOFF_MAX_MS,
  type PushEntry,
  type PushOutcome,
  pushOnce,
} from './push.js';

const SHA = 'b'.repeat(40);
const BASE = 'jumpmaster-trooper@sha256:base';
const VOLUME = 'jm-drop-d1-3-0123abcd';
const GRANT: PushGrant = {
  token: 'ghp_grant_token_value',
  owner: 'o',
  name: 'r',
  branch: 'agent/issue-1',
  base: 'main',
  lease: '',
  protectedPaths: [],
  secrets: ['ghp_grant_token_value'],
};
const PLAN: PushPlan = { branch: 'agent/issue-1', salvage: false };
const NET: DropNet = {
  name: 'jm-push-d1-3',
  subnet: '172.30.0.32/28',
  gateway: '172.30.0.33',
  proxy: '172.30.0.34',
  trooper: '172.30.0.35',
  dns: '172.30.0.36',
  ipRange: '172.30.0.40/29',
};
const resultLine = (r: PushResult) => `JM_RESULT ${JSON.stringify(r)}`;
const PUSHED = resultLine({ status: 'pushed', headSha: SHA, alreadyThere: false });

/** One push container's script: lines before the grant, and (when it waits) after it. */
type Script = { before: string[]; after?: string[]; hang?: boolean; exitCode?: number };

function fakeDriver(scripts: Script[], opts: { proxyStopError?: boolean } = {}) {
  const order: string[] = [];
  const starts: Parameters<ContainerDriver['start']>[0][] = [];
  /** Lines written to each started container's stdin, by start index. */
  const writes: string[][] = [];
  const d = {
    order,
    starts,
    writes,
    removedVolumes: [] as string[],
    stops: 0,
    driver: {
      async start(o) {
        const i = starts.length;
        starts.push(o);
        writes.push([]);
        order.push(`start ${o.name}`);
        const s = scripts[i] ?? scripts.at(-1) ?? { before: [] };
        let release: () => void = () => {};
        const stopped = new Promise<void>((r) => {
          release = r;
        });
        let granted: () => void = () => {};
        const grantIn = new Promise<void>((r) => {
          granted = r;
        });
        let ended = false;
        const handle: ContainerHandle = {
          async *logs() {
            for (const l of s.before) {
              order.push(`emit ${l.slice(0, 20)}`);
              yield l;
            }
            if (s.after) {
              const go = await Promise.race([grantIn.then(() => true), stopped.then(() => false)]);
              if (!go) return;
              for (const l of s.after) {
                order.push(`emit ${l.slice(0, 20)}`);
                yield l;
              }
            }
            if (s.hang) await stopped;
          },
          async wait() {
            return { exitCode: s.exitCode ?? 0 };
          },
          stderrTail: () => '',
          async stop() {
            d.stops++;
            order.push('stop');
            release();
          },
          async kill() {
            order.push('kill');
            release();
          },
          async writeLine(line) {
            if (ended) throw new Error('stdin has ended');
            order.push(`write ${i}`);
            writes[i]?.push(line);
            granted();
          },
          endStdin() {
            ended = true;
          },
        };
        return handle;
      },
      async removeAndWait(name) {
        order.push(`removeAndWait ${name}`);
      },
      async removeVolume(name) {
        order.push(`removeVolume ${name}`);
        d.removedVolumes.push(name);
      },
      async createDropNetwork(name) {
        order.push(`network ${name}`);
        return { ...NET, name };
      },
      async startEgressProxy(o) {
        order.push(`proxy ${o.env.JM_EGRESS_ALLOW}`);
        let done: () => void = () => {};
        const end = new Promise<void>((r) => {
          done = r;
        });
        return {
          async *logs() {
            yield '{"ready":true}';
            await end;
          },
          async stop() {
            done();
            if (opts.proxyStopError) throw new Error('proxy stop failed');
          },
        };
      },
      async removeServices(network) {
        order.push(`teardown ${network}`);
      },
    } as Partial<ContainerDriver> as ContainerDriver,
  };
  return d;
}

function fakeClient(o: { plan?: PlanReply; grants?: GrantReply[]; beat?: Beat } = {}) {
  const c = {
    posted: [] as PushResult[],
    planCalls: 0,
    grantCalls: 0,
    beat: o.beat ?? ('ok' as Beat),
    postReply: 'ok' as 'ok' | 'stale',
    async heartbeat() {
      return c.beat;
    },
    async pushPlan() {
      c.planCalls++;
      return o.plan ?? PLAN;
    },
    async pushGrant() {
      c.grantCalls++;
      return (o.grants ?? []).shift() ?? { grant: GRANT };
    },
    async postPushResult(_d: string, _e: number, r: PushResult) {
      c.posted.push(r);
      return c.postReply;
    },
  } satisfies PushClient & Record<string, unknown>;
  return c;
}

function setup(scripts: Script[], o: Parameters<typeof fakeClient>[0] = {}) {
  const d = fakeDriver(scripts);
  const client = fakeClient(o);
  const pending = new PendingPushes();
  pending.add('d1', { epoch: 3, volume: VOLUME }, 0);
  const entry = pending.get('d1') as PushEntry;
  const logs: string[] = [];
  const deps = {
    client,
    driver: d.driver,
    stickId: 's1',
    image: BASE,
    pending,
    heartbeatMs: 5,
    log: (l: string) => logs.push(l),
  };
  return { d, client, pending, entry, deps, logs };
}

describe('pushOnce', () => {
  test('the push container uses the base image, one mount, its own network, and no token in its payload', async () => {
    const s = setup([{ before: [READY_LINE], after: [PUSHED] }], {
      plan: { ...PLAN, egress: { mode: 'allowlist', allow: ['github.com'] } },
    });
    expect(await pushOnce(s.entry, { ...s.deps, egressImage: 'egress:1' })).toBe('done');
    const started = s.d.starts[0];
    expect(started?.image).toBe(BASE);
    expect(started?.name).toBe('jumpmaster-push-d1-3');
    expect(started?.mount).toEqual({ volume: VOLUME, target: '/home/agent/repo' });
    expect(started?.holdStdin).toBe(true);
    expect(started?.network).toBe('jm-push-d1-3');
    expect(started?.egress?.name).toBe('jm-push-d1-3');
    expect(s.d.order).toContain('proxy github.com');
    const payload = PushPayloadSchema.parse(JSON.parse(started?.payload ?? ''));
    expect(payload).toEqual({
      protocol: 1,
      role: 'push',
      dropId: 'd1',
      epoch: 3,
      branch: 'agent/issue-1',
      salvage: false,
      egress: true,
    });
    expect(started?.payload).not.toContain(GRANT.token);
    expect(s.pending.networks()).toEqual(new Set());
    expect(s.d.order).toContain('teardown jm-push-d1-3');
  });

  test('without egress it runs on the plain network the agent would have had', async () => {
    const s = setup([{ before: [READY_LINE], after: [PUSHED] }]);
    await pushOnce(s.entry, s.deps);
    expect(s.d.starts[0]?.network).toBeUndefined();
    expect(s.d.starts[0]?.egress).toBeUndefined();
    const payload = PushPayloadSchema.parse(JSON.parse(s.d.starts[0]?.payload ?? ''));
    expect(payload).not.toHaveProperty('egress');
  });

  test('writes the grant only after ready, only to the container it started, then ends stdin', async () => {
    const s = setup(
      [
        { before: [READY_LINE], hang: true },
        { before: [READY_LINE], after: [PUSHED] },
      ],
      { grants: [{ refused: 'reserved', retryable: true }] },
    );
    expect(await pushOnce(s.entry, s.deps)).toBe('retry');
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    // The refused attempt's container never got a line; the second got exactly the grant.
    expect(s.d.writes).toEqual([[], [JSON.stringify(GRANT)]]);
    const ready = s.d.order.lastIndexOf(`emit ${READY_LINE}`);
    const write = s.d.order.indexOf('write 1');
    expect(ready).toBeGreaterThan(s.d.order.indexOf('start jumpmaster-push-d1-3', 1));
    expect(write).toBeGreaterThan(ready);
    expect(s.client.posted).toEqual([{ status: 'pushed', headSha: SHA, alreadyThere: false }]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
    // The grant is never logged.
    expect(s.logs.join('\n')).not.toContain(GRANT.token);
  });

  test('no grant is asked for, or written, when the container never says ready', async () => {
    const s = setup([{ before: ['staging...'], hang: true }]);
    expect(await pushOnce(s.entry, { ...s.deps, readyTimeoutMs: 20 })).toBe('retry');
    expect(s.client.grantCalls).toBe(0);
    expect(s.d.writes).toEqual([[]]);
    expect(s.d.order).toContain('stop');
    expect(s.d.removedVolumes).toEqual([]);
  });

  test('retries a refused grant with capped backoff and keeps the volume', async () => {
    const s = setup([{ before: [READY_LINE], hang: true }], {
      grants: [{ refused: 'killed', retryable: true }],
    });
    expect(await pushOnce(s.entry, s.deps)).toBe('retry');
    expect(s.d.order).toContain('stop');
    expect(s.d.order).toContain('removeAndWait jumpmaster-push-d1-3');
    expect(s.d.removedVolumes).toEqual([]);
    expect(s.client.posted).toEqual([]);
    expect(s.pending.size()).toBe(1);
    // Backoff: min(PUSH_BACKOFF_MAX_MS, 15 s * 2^attempts).
    expect([0, 1, 2, 3, 4, 5, 10].map(backoffMs)).toEqual([
      15_000,
      30_000,
      60_000,
      120_000,
      240_000,
      PUSH_BACKOFF_MAX_MS,
      PUSH_BACKOFF_MAX_MS,
    ]);
    s.pending.backoff('d1', 1_000);
    expect(s.entry.attempts).toBe(1);
    expect(s.entry.nextAt).toBe(16_000);
    expect(s.pending.due(15_999)).toEqual([]);
    expect(s.pending.due(16_000)).toEqual([s.entry]);
  });

  test('killed keeps the volume; cancel removes it', async () => {
    const killed = setup([{ before: [READY_LINE], hang: true }], { beat: 'killed' });
    // The grant request hangs until the heartbeat stops the container.
    killed.client.pushGrant = () => new Promise<GrantReply>(() => {});
    expect(await pushOnce(killed.entry, killed.deps)).toBe('killed');
    // Killed at once, with no graceful stop first: nothing may reach GitHub.
    const kill = killed.d.order.indexOf('kill');
    expect(kill).toBeGreaterThan(-1);
    expect(killed.d.order.slice(0, kill)).not.toContain('stop');
    expect(killed.d.removedVolumes).toEqual([]);
    expect(killed.pending.size()).toBe(1);
    expect(killed.d.writes).toEqual([[]]);

    const cancelled = setup([{ before: [], hang: true }], { beat: 'cancel' });
    expect(await pushOnce(cancelled.entry, cancelled.deps)).toBe('cancelled');
    expect(cancelled.d.order).toContain('stop');
    const removed = cancelled.d.order.indexOf(`removeVolume ${VOLUME}`);
    expect(removed).toBeGreaterThan(
      cancelled.d.order.indexOf('removeAndWait jumpmaster-push-d1-3'),
    );
    expect(cancelled.pending.size()).toBe(0);
    expect(cancelled.client.posted).toEqual([]);
  });

  test('a refused plan starts nothing, keeps the volume and backs off', async () => {
    const s = setup([{ before: [READY_LINE], hang: true }], {
      plan: { refused: 'zone observe', retryable: true },
    });
    expect(await pushOnce(s.entry, s.deps)).toBe('retry');
    expect(s.d.order).toEqual([]);
    expect(s.d.removedVolumes).toEqual([]);
    expect(s.client.grantCalls).toBe(0);
    expect(s.pending.size()).toBe(1);
    expect(s.logs.some((l) => l.includes('plan refused') && l.includes('zone observe'))).toBe(true);
  });

  test('a stale plan removes the volume and the entry', async () => {
    const s = setup([{ before: [] }], { plan: 'stale' });
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.d.starts).toEqual([]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
  });

  test('a stale grant stops the container and removes the volume and the entry', async () => {
    const s = setup([{ before: [READY_LINE], hang: true }], { grants: [{ stale: true }] });
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.d.writes).toEqual([[]]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
  });

  test('an exit before ready with a result line posts that result', async () => {
    const s = setup([{ before: [resultLine({ status: 'nothing', reason: 'no branch' })] }]);
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.client.grantCalls).toBe(0);
    expect(s.client.posted).toEqual([{ status: 'nothing', reason: 'no branch' }]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
  });

  test('a retryable failure keeps the volume; a final one removes it', async () => {
    const retry = setup([
      {
        before: [READY_LINE],
        after: [resultLine({ status: 'failed', reason: 'net', retryable: true })],
      },
    ]);
    expect(await pushOnce(retry.entry, retry.deps)).toBe('retry');
    expect(retry.client.posted).toHaveLength(1);
    expect(retry.d.removedVolumes).toEqual([]);

    const final = setup([
      {
        before: [READY_LINE],
        after: [resultLine({ status: 'failed', reason: 'declined', retryable: false })],
      },
    ]);
    expect(await pushOnce(final.entry, final.deps)).toBe('done');
    expect(final.d.removedVolumes).toEqual([VOLUME]);
  });

  test('a stale answer to the push result removes the volume', async () => {
    const s = setup([{ before: [READY_LINE], after: [PUSHED] }]);
    s.client.postReply = 'stale';
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
  });

  test('exit before ready without a result retries, then fails after three', async () => {
    const s = setup([{ before: ['crashed'], exitCode: 1 }]);
    const outcomes: PushOutcome[] = [];
    for (let i = 0; i < NO_RESULT_RETRIES; i++) outcomes.push(await pushOnce(s.entry, s.deps));
    expect(outcomes).toEqual(['retry', 'retry', 'done']);
    expect(s.client.posted).toEqual([
      { status: 'failed', reason: 'push container exited without a result', retryable: false },
    ]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
  });
});

describe('PendingPushes and the push loop', () => {
  test('networks() names the jm-push network of every live entry', () => {
    const p = new PendingPushes();
    p.add('d1', { epoch: 3, volume: 'v1' }, 0);
    p.add('d2', { epoch: 1, volume: 'v2' }, 0);
    expect(p.networks()).toEqual(new Set(['jm-push-d1-3', 'jm-push-d2-1']));
    p.remove('d1');
    expect(p.size()).toBe(1);
    expect(p.networks()).toEqual(new Set(['jm-push-d2-1']));
  });

  test('pending pushes wait while the base image is refused, then run once it verifies', async () => {
    const pending = new PendingPushes();
    pending.add('d7', { epoch: 4, volume: 'jm-drop-d7-4-0123abcd' }, 0);
    let verified = false;
    const ran: string[] = [];
    const loop = createPushLoop(
      pending,
      async (e) => {
        ran.push(e.dropId);
        return 'done';
      },
      { now: () => 0, ready: () => verified },
    );
    await loop.tick();
    // Refused: nothing runs (no push container from an unverified image), the entry stays queued.
    expect(ran).toEqual([]);
    expect(pending.get('d7')).toMatchObject({ attempts: 0, volume: 'jm-drop-d7-4-0123abcd' });
    verified = true;
    await loop.tick();
    expect(ran).toEqual(['d7']);
    expect(pending.size()).toBe(0);
  });

  test('the push loop runs at most two at a time and never holds a lease slot', async () => {
    const pending = new PendingPushes();
    for (const id of ['a', 'b', 'c', 'd']) pending.add(id, { epoch: 1, volume: `v-${id}` }, 0);
    let now = 0;
    let live = 0;
    let most = 0;
    const gates = new Map<string, () => void>();
    const ran: string[] = [];
    const loop = createPushLoop(
      pending,
      (e) =>
        new Promise<PushOutcome>((resolve) => {
          live++;
          most = Math.max(most, live);
          ran.push(e.dropId);
          gates.set(e.dropId, () => {
            live--;
            resolve(e.dropId === 'a' ? 'retry' : 'done');
          });
        }),
      { now: () => now },
    );
    expect(MAX_CONCURRENT_PUSHES).toBe(2);
    const first = loop.tick();
    // A second tick while both run starts nothing more, and never the same entry twice.
    void loop.tick();
    expect(ran).toEqual(['a', 'b']);
    expect(loop.running()).toBe(2);
    gates.get('a')?.();
    gates.get('b')?.();
    await first;
    // `a` backs off; `b` is done and gone.
    expect(pending.get('a')?.attempts).toBe(1);
    expect(pending.get('b')).toBeUndefined();
    now = 1;
    const second = loop.tick();
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
    gates.get('c')?.();
    gates.get('d')?.();
    await second;
    expect(most).toBe(2);
    expect(pending.size()).toBe(1);
    now = 15_000;
    void loop.tick();
    expect(ran.at(-1)).toBe('a');
  });

  test('a run that throws backs off rather than ending the loop', async () => {
    const pending = new PendingPushes();
    pending.add('a', { epoch: 1, volume: 'v' }, 0);
    const loop = createPushLoop(pending, async () => {
      throw new Error('boom');
    });
    await loop.tick();
    expect(pending.get('a')?.attempts).toBe(1);
  });
});

describe('fix round 1', () => {
  test('a final grant refusal stops the container, posts a final failure and removes the volume', async () => {
    const s = setup([{ before: [READY_LINE], hang: true }], {
      grants: [{ refused: 'repo mismatch', retryable: false }],
    });
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.client.posted).toEqual([
      { status: 'failed', reason: 'repo mismatch', retryable: false },
    ]);
    expect(s.d.writes).toEqual([[]]);
    expect(s.d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
    expect(s.logs.join('\n')).toContain('repo mismatch');
  });

  test('a retryable refusal is logged and keeps backing off', async () => {
    const s = setup([{ before: [READY_LINE], hang: true }], {
      grants: [{ refused: 'reserved', retryable: true }],
    });
    expect(await pushOnce(s.entry, s.deps)).toBe('retry');
    expect(s.client.posted).toEqual([]);
    expect(s.d.removedVolumes).toEqual([]);
    expect(s.logs.join('\n')).toContain('reserved');
  });

  test("an older epoch's attempt never removes or backs off a newer epoch's entry", async () => {
    const s = setup([{ before: [] }], { plan: 'stale' });
    const old = s.entry;
    s.pending.add('d1', { epoch: 4, volume: 'jm-drop-d1-4-0123abcd' }, 0);
    expect(await pushOnce(old, s.deps)).toBe('done');
    expect(s.pending.get('d1')?.epoch).toBe(4);
    s.pending.remove('d1', 3);
    s.pending.backoff('d1', 1_000, 3);
    expect(s.pending.get('d1')).toMatchObject({ epoch: 4, attempts: 0, nextAt: 0 });

    const loop = createPushLoop(s.pending, async () => 'done');
    const pending = new PendingPushes();
    pending.add('x', { epoch: 1, volume: 'v1' }, 0);
    const replaced = createPushLoop(pending, async () => {
      pending.add('x', { epoch: 2, volume: 'v2' }, 0);
      return 'retry';
    });
    await replaced.tick();
    expect(pending.get('x')).toMatchObject({ epoch: 2, attempts: 0 });
    await loop.tick();
    expect(s.pending.size()).toBe(0);
  });

  test('a failing proxy stop still tears down the network and settles the entry', async () => {
    const d = fakeDriver([{ before: [READY_LINE], after: [PUSHED] }], { proxyStopError: true });
    const s = setup([]);
    const deps = { ...s.deps, driver: d.driver, egressImage: 'egress:1' };
    s.client.pushPlan = async () => ({
      ...PLAN,
      egress: { mode: 'allowlist' as const, allow: ['github.com'] },
    });
    expect(await pushOnce(s.entry, deps)).toBe('done');
    expect(d.order).toContain('teardown jm-push-d1-3');
    expect(d.removedVolumes).toEqual([VOLUME]);
    expect(s.pending.size()).toBe(0);
  });
});

describe('a GitLab grant (#716)', () => {
  // Not token-shaped: only the explicit entries can redact it.
  const TOKEN = 'plain-gitlab-token-0123456789';
  const GL_BASIC = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
  const GL_GRANT: PushGrant = {
    ...GRANT,
    token: TOKEN,
    secrets: [],
    forge: { kind: 'gitlab', origin: 'https://gitlab.com', projectPath: 'g/sub/p' },
  };

  test("the push container's echo of the oauth2 header is redacted from the stick's log", async () => {
    const failed = resultLine({
      status: 'failed',
      reason: `fatal: AUTHORIZATION: basic ${GL_BASIC} refused`,
      retryable: false,
    });
    const s = setup([{ before: [READY_LINE], after: [failed] }], {
      grants: [{ grant: GL_GRANT }],
    });
    expect(await pushOnce(s.entry, s.deps)).toBe('done');
    expect(s.d.writes).toEqual([[JSON.stringify(GL_GRANT)]]);
    const log = s.logs.join('\n');
    expect(log).toContain('[REDACTED]');
    expect(log).not.toContain(GL_BASIC);
    expect(log).not.toContain(TOKEN);
  });

  test('grantSecrets adds the oauth2 form only for a GitLab grant', () => {
    expect(grantSecrets(GRANT)).toEqual([GRANT.token, ...GRANT.secrets]);
    expect(grantSecrets(GL_GRANT)).toEqual([TOKEN, GL_BASIC]);
  });
});
