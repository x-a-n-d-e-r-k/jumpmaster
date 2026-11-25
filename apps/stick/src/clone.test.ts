import {
  type CloneGrant,
  ClonePayloadSchema,
  type ClonePlan,
  type CloneResult,
  gitlabBasicAuth,
  gitlabBasicAuthAs,
  READY_LINE,
} from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { CloneClient, CloneGrantReply, ClonePlanReply } from './client.js';
import { type CloneDeps, cloneContainer, cloneNetwork, runClone } from './clone.js';
import type { ContainerDriver, ContainerHandle, DropNet } from './driver.js';
import { sweepDropNetworks } from './runner.js';

const TROOPER = 'jumpmaster-trooper@sha256:own';
const VOLUME = 'jm-mirror-d1-3-0123abcd';
const TOKEN = 'planted-clone-token-0123456789';
const FORGE = {
  kind: 'gitlab',
  host: 'gitlab.example.com',
  project: 'group/proj',
} as unknown as CloneGrant['forge'];
const GRANT: CloneGrant = { token: TOKEN, forge: FORGE, secrets: ['other-secret-value'] };
const PLAN = { forge: FORGE, maxBytes: 1_000_000 } as ClonePlan;
const EGRESS_PLAN = {
  ...PLAN,
  egress: { mode: 'enforce', allow: ['gitlab.example.com'] },
  limits: { memoryMb: 512 },
} as unknown as ClonePlan;
const NET: DropNet = {
  name: 'jm-clone-d1-3',
  subnet: '172.30.0.32/28',
  gateway: '172.30.0.33',
  proxy: '172.30.0.34',
  trooper: '172.30.0.35',
  dns: '172.30.0.36',
  ipRange: '172.30.0.40/29',
};
const resultLine = (r: CloneResult) => `JM_RESULT ${JSON.stringify(r)}`;
const CLONED = resultLine({ status: 'cloned', bytes: 4242 });

/** The clone container's script: lines before the grant, and (when it waits) after it. */
type Script = { before: string[]; after?: string[]; hang?: boolean; stderr?: string };

function fakeDriver(
  script: Script,
  o: { networks?: { name: string; labels: Record<string, string> }[] } = {},
) {
  const order: string[] = [];
  const starts: Parameters<ContainerDriver['start']>[0][] = [];
  const writes: string[] = [];
  const d = {
    order,
    starts,
    writes,
    stdinEnded: false,
    networks: o.networks ?? [],
    /** Set by `active` probes taken while the container runs. */
    activeDuringRun: undefined as boolean | undefined,
    probe: undefined as (() => void) | undefined,
    driver: {
      async start(opts) {
        starts.push(opts);
        order.push(`start ${opts.name}`);
        d.probe?.();
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
            for (const l of script.before) yield l;
            if (script.after) {
              const go = await Promise.race([grantIn.then(() => true), stopped.then(() => false)]);
              if (!go) return;
              for (const l of script.after) yield l;
            }
            if (script.hang) await stopped;
          },
          async wait() {
            return { exitCode: 1 };
          },
          stderrTail: () => script.stderr ?? '',
          async stop() {
            order.push('stop');
            release();
          },
          async kill() {
            order.push('kill');
            release();
          },
          async writeLine(line) {
            if (ended) throw new Error('stdin has ended');
            order.push('write');
            writes.push(line);
            granted();
          },
          endStdin() {
            ended = true;
            d.stdinEnded = true;
          },
        };
        return handle;
      },
      async removeAndWait(name) {
        order.push(`removeAndWait ${name}`);
      },
      async removeVolume(name) {
        order.push(`removeVolume ${name}`);
      },
      async createDropNetwork(name, labels) {
        order.push(`network ${name} ${JSON.stringify(labels)}`);
        return { ...NET, name };
      },
      async startEgressProxy(p) {
        order.push(
          `proxy ${p.env.JM_EGRESS_ALLOW}${p.env.JM_EGRESS_PRIVATE === undefined ? '' : ` private=${p.env.JM_EGRESS_PRIVATE}`}`,
        );
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
            order.push('proxy stop');
            done();
          },
        };
      },
      async removeServices(network) {
        order.push(`teardown ${network}`);
      },
      async listNetworksByLabel() {
        return d.networks;
      },
    } as Partial<ContainerDriver> as ContainerDriver,
  };
  return d;
}

function fakeClient(o: { plan?: ClonePlanReply; grant?: CloneGrantReply; planError?: Error } = {}) {
  const c = {
    order: [] as string[],
    async clonePlan() {
      c.order.push('plan');
      if (o.planError) throw o.planError;
      return o.plan ?? PLAN;
    },
    async cloneGrant() {
      c.order.push('grant');
      return o.grant ?? { grant: GRANT };
    },
  } satisfies CloneClient & Record<string, unknown>;
  return c;
}

function setup(
  script: Script,
  o: Parameters<typeof fakeClient>[0] & { deps?: Partial<CloneDeps> } = {},
) {
  const d = fakeDriver(script);
  const client = fakeClient(o);
  const logs: string[] = [];
  const active = new Set<string>();
  const deps: CloneDeps = {
    client,
    driver: d.driver,
    stickId: 's1',
    image: TROOPER,
    egressImage: 'egress:1',
    subnetPool: '172.30.0.0/16',
    ceiling: null,
    active,
    log: (l: string) => logs.push(l),
    ...o.deps,
  };
  const run = () => runClone({ dropId: 'd1', epoch: 3, volume: VOLUME }, deps);
  return { d, client, logs, active, deps, run };
}

const LABELS = { 'jumpmaster.drop': 'd1', 'jumpmaster.epoch': '3', 'jumpmaster.stick': 's1' };

describe('runClone', () => {
  test('names', () => {
    expect(cloneNetwork('d1', 3)).toBe('jm-clone-d1-3');
    expect(cloneContainer('d1', 3)).toBe('jumpmaster-clone-d1-3');
  });

  test('the happy path with egress: own network and proxy, the grant after ready, the volume kept', async () => {
    const s = setup({ before: ['noise', READY_LINE], after: [CLONED] }, { plan: EGRESS_PLAN });
    s.d.probe = () => {
      s.d.activeDuringRun = s.active.has('jm-clone-d1-3');
    };
    expect(await s.run()).toEqual({ ok: true, bytes: 4242 });

    expect(s.d.order[0]).toBe(`network jm-clone-d1-3 ${JSON.stringify(LABELS)}`);
    expect(s.d.order).toContain('proxy gitlab.example.com');
    const started = s.d.starts[0];
    expect(started?.image).toBe(TROOPER);
    expect(started?.clone).toBe(true);
    expect(started?.mirror).toEqual({ volume: VOLUME, target: '/jm/mirror' });
    expect(started?.mount).toBeUndefined();
    expect(started?.holdStdin).toBe(true);
    expect(started?.name).toBe('jumpmaster-clone-d1-3');
    expect(started?.labels).toEqual(LABELS);
    expect(started?.network).toBe('jm-clone-d1-3');
    expect(started?.egress?.name).toBe('jm-clone-d1-3');
    expect(started?.limits).toEqual({ memoryMb: 512 });
    const payload = ClonePayloadSchema.parse(JSON.parse(started?.payload ?? ''));
    expect(payload).toEqual({ protocol: 1, role: 'clone', dropId: 'd1', epoch: 3, egress: true });
    expect(started?.payload).not.toContain(TOKEN);

    expect(s.client.order).toEqual(['plan', 'grant']);
    expect(s.d.writes).toEqual([JSON.stringify(GRANT)]);
    expect(s.d.stdinEnded).toBe(true);

    expect(s.d.activeDuringRun).toBe(true);
    expect(s.active.has('jm-clone-d1-3')).toBe(false);
    const at = (p: string) => s.d.order.findIndex((l) => l.startsWith(p));
    expect(at('removeAndWait jumpmaster-clone-d1-3')).toBeGreaterThan(at('write'));
    expect(at('proxy stop')).toBeGreaterThan(at('removeAndWait'));
    expect(at('teardown jm-clone-d1-3')).toBeGreaterThan(at('proxy stop'));
    expect(s.d.order).not.toContain(`removeVolume ${VOLUME}`);
  });

  test('a plan whose egress lists a private host starts a proxy with JM_EGRESS_PRIVATE', async () => {
    const plan = {
      ...EGRESS_PLAN,
      egress: {
        mode: 'enforce' as const,
        allow: ['gitlab.example.com'],
        private: ['gitlab.example.com'],
      },
    };
    const s = setup({ before: [READY_LINE], after: [CLONED] }, { plan });
    expect(await s.run()).toEqual({ ok: true, bytes: 4242 });
    expect(s.d.order).toContain('proxy gitlab.example.com private=gitlab.example.com');
  });

  test('without egress: no network, no proxy, no egress in the payload', async () => {
    const s = setup({ before: [READY_LINE], after: [CLONED] });
    expect(await s.run()).toEqual({ ok: true, bytes: 4242 });
    expect(s.d.order.some((l) => l.startsWith('network') || l.startsWith('proxy'))).toBe(false);
    expect(s.d.order.some((l) => l.startsWith('teardown'))).toBe(false);
    expect(s.d.starts[0]?.network).toBeUndefined();
    expect(s.d.starts[0]?.egress).toBeUndefined();
    const payload = ClonePayloadSchema.parse(JSON.parse(s.d.starts[0]?.payload ?? ''));
    expect(payload).not.toHaveProperty('egress');
    expect(s.active.size).toBe(0);
  });

  test('a stale plan returns stale; nothing starts, no grant, the volume goes', async () => {
    const s = setup({ before: [READY_LINE], after: [CLONED] }, { plan: 'stale' });
    expect(await s.run()).toBe('stale');
    expect(s.d.starts).toEqual([]);
    expect(s.client.order).toEqual(['plan']);
    expect(s.d.order.some((l) => l.startsWith('network'))).toBe(false);
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('a refused plan fails with the refusal (redacted) and its retryable; nothing starts', async () => {
    const shaped = `ghp_${'a'.repeat(36)}`;
    const s = setup(
      { before: [READY_LINE], after: [CLONED] },
      { plan: { refused: `kill switch ${shaped}`, retryable: true } },
    );
    const r = await s.run();
    expect(r).toEqual({ ok: false, reason: 'kill switch [REDACTED]', retryable: true });
    expect(s.d.starts).toEqual([]);
    expect(s.client.order).toEqual(['plan']);
    expect(s.d.order.some((l) => l.startsWith('network'))).toBe(false);
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('the ceiling refuses an outside host: nothing is created and the reason names it', async () => {
    const s = setup(
      { before: [READY_LINE], after: [CLONED] },
      {
        plan: EGRESS_PLAN,
        deps: { ceiling: ['github.com'] },
      },
    );
    const r = await s.run();
    expect(r).toMatchObject({ ok: false });
    expect(r !== 'stale' && !r.ok && r.reason).toContain('gitlab.example.com');
    expect(s.d.starts).toEqual([]);
    expect(s.d.order.some((l) => l.startsWith('network') || l.startsWith('proxy'))).toBe(false);
    expect(s.client.order).toEqual(['plan']);
    expect(s.active.size).toBe(0);
  });

  test('no ready line within the ready timeout: stopped, no grant, the volume goes', async () => {
    const s = setup({ before: ['starting'], hang: true }, { deps: { readyTimeoutMs: 20 } });
    const r = await s.run();
    expect(r).toMatchObject({ ok: false });
    expect(s.client.order).toEqual(['plan']);
    expect(s.d.order).toContain('stop');
    expect(s.d.writes).toEqual([]);
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test.each([
    ['refused', { refused: 'kill switch on', retryable: false }],
    ['stale', { stale: true }],
  ] as const)(
    'a %s grant stops the container, writes nothing, and removes the volume',
    async (_n, grant) => {
      const s = setup({ before: [READY_LINE], after: [CLONED] }, { grant });
      const r = await s.run();
      if ('stale' in grant) expect(r).toBe('stale');
      else expect(r).toEqual({ ok: false, reason: 'kill switch on', retryable: false });
      expect(s.d.writes).toEqual([]);
      expect(s.d.order).toContain('stop');
      expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
      expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
    },
  );

  test('a failed result fails with its reason and retryable', async () => {
    const s = setup({
      before: [READY_LINE],
      after: [resultLine({ status: 'failed', reason: 'too big', retryable: false })],
    });
    expect(await s.run()).toEqual({ ok: false, reason: 'too big', retryable: false });
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('an exit without a result line fails', async () => {
    const s = setup({ before: [READY_LINE], after: ['JM_RESULT not json'] });
    const r = await s.run();
    expect(r).toMatchObject({ ok: false });
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('the overall timeout kills the container at once', async () => {
    const s = setup({ before: [READY_LINE], after: [], hang: true }, { deps: { timeoutMs: 30 } });
    expect(await s.run()).toMatchObject({ ok: false, reason: 'clone timed out' });
    expect(s.d.order).toContain('kill');
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('an abort kills the container at once', async () => {
    const ac = new AbortController();
    const s = setup(
      { before: [READY_LINE], after: [], hang: true },
      { deps: { signal: ac.signal } },
    );
    const p = s.run();
    setTimeout(() => ac.abort(), 20);
    expect(await p).toMatchObject({ ok: false, reason: 'halted' });
    expect(s.d.order).toContain('kill');
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('a halt (kill switch) kills the container at once', async () => {
    let halted = false;
    const s = setup(
      { before: [READY_LINE], after: [], hang: true },
      { plan: EGRESS_PLAN, deps: { halted: () => halted, haltPollMs: 5 } },
    );
    const p = s.run();
    setTimeout(() => {
      halted = true;
    }, 20);
    expect(await p).toMatchObject({ ok: false, reason: 'halted' });
    expect(s.d.order).toContain('kill');
    expect(s.d.order).toContain('removeAndWait jumpmaster-clone-d1-3');
    expect(s.d.order).toContain('teardown jm-clone-d1-3');
    expect(s.active.size).toBe(0);
    expect(s.d.order).toContain(`removeVolume ${VOLUME}`);
  });

  test('a container that is not confirmed gone keeps the volume', async () => {
    const s = setup({
      before: [READY_LINE],
      after: [resultLine({ status: 'failed', reason: 'x', retryable: true })],
    });
    s.d.driver.removeAndWait = async () => {
      throw new Error('container not removed');
    };
    expect(await s.run()).toMatchObject({ ok: false });
    expect(s.d.order).not.toContain(`removeVolume ${VOLUME}`);
  });

  describe('the planted token never leaks', () => {
    const forms = [
      ['plain', GRANT, TOKEN],
      ['oauth2 basic auth', GRANT, gitlabBasicAuth(TOKEN)],
      [
        'username basic auth',
        { ...GRANT, username: 'gitlab+deploy-token-7' },
        gitlabBasicAuthAs('gitlab+deploy-token-7', TOKEN),
      ],
    ] as const;
    test.each(forms)('%s, in stderr and in the result reason', async (_n, grant, leaked) => {
      const s = setup(
        {
          before: [READY_LINE],
          after: [
            resultLine({
              status: 'failed',
              reason: `found ${leaked} and other-secret-value in the volume`,
              retryable: false,
            }),
          ],
          stderr: `fatal: ${leaked}`,
        },
        { grant: { grant } },
      );
      const r = await s.run();
      expect(r).toMatchObject({ ok: false });
      const reason = r !== 'stale' && !r.ok ? r.reason : '';
      expect(reason).toContain('[REDACTED]');
      for (const text of [reason, ...s.logs]) {
        expect(text).not.toContain(leaked);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('other-secret-value');
      }
    });
    test.each(forms)('%s, in stderr on an exit without a result', async (_n, grant, leaked) => {
      const s = setup(
        { before: [READY_LINE], after: [], stderr: `fatal: ${leaked}` },
        {
          grant: { grant },
        },
      );
      const r = await s.run();
      expect(r).toMatchObject({ ok: false });
      const reason = r !== 'stale' && !r.ok ? r.reason : '';
      expect(s.logs.join('\n')).toContain('[REDACTED]');
      for (const text of [reason, ...s.logs]) expect(text).not.toContain(leaked);
    });
    test('a token cut by the stderr truncation does not leak its tail', async () => {
      const stderr = `fatal: ${TOKEN}${'x'.repeat(1990)}`;
      const s = setup({ before: [READY_LINE], after: [], stderr });
      await s.run();
      for (const l of s.logs) expect(l).not.toContain(TOKEN.slice(-10));
    });
    test('a token straddling the stderr log cut never appears in part', async () => {
      // 3000 chars; the cut at -2000 lands 10 chars into TOKEN.
      const stderr = `${'x'.repeat(990)}${TOKEN}${'y'.repeat(1980)}`;
      const s = setup({ before: [READY_LINE], after: [], stderr });
      await s.run();
      for (const l of s.logs) expect(l).not.toContain(TOKEN.slice(10));
    });
  });

  test('the real sweep keeps the clone network while it is active and removes it after', async () => {
    const s = setup({ before: [READY_LINE], after: [CLONED] }, { plan: EGRESS_PLAN });
    s.d.networks.push({ name: 'jm-clone-d1-3', labels: LABELS });
    let sweptDuring = -1;
    s.d.probe = () => {
      void sweepDropNetworks(s.d.driver, 's1', s.active).then((n) => {
        sweptDuring = n;
      });
    };
    expect(await s.run()).toEqual({ ok: true, bytes: 4242 });
    expect(sweptDuring).toBe(0);
    const before = s.d.order.length;
    expect(await sweepDropNetworks(s.d.driver, 's1', s.active)).toBe(1);
    expect(s.d.order.slice(before)).toEqual(['teardown jm-clone-d1-3']);
  });
});
