import { describe, expect, test } from 'vitest';
import type { ContainerDriver, IsolationFacts } from './driver.js';
import {
  EgressTally,
  egressCapability,
  egressImage,
  engineAtLeast,
  MAX_EGRESS_HOSTS,
  MIN_ENGINE_VERSION,
  startEgress,
} from './egress.js';
import { stickInfo } from './state.js';
import { type Cosign, releaseSigner } from './verify.js';

const GOOD: IsolationFacts = {
  listenerUp: true,
  gatewayOnHost: false,
  gatewayReachable: false,
  ipv6Disabled: true,
};

/** Just the calls the capability probe makes. */
function probeDriver(
  o: {
    image?: boolean;
    netError?: string;
    version?: string;
    facts?: Partial<IsolationFacts>;
    probeError?: string;
    proxyReady?: boolean;
    self?: string;
    present?: boolean;
    pullError?: string;
  } = {},
) {
  const calls: string[] = [];
  let pulled = false;
  const driver = {
    async imageExists(image: string) {
      calls.push(`image ${image}`);
      return pulled || (o.present ?? o.image ?? true);
    },
    async pullImage(ref: string) {
      calls.push(`pull ${ref}`);
      if (o.pullError) throw new Error(o.pullError);
      pulled = true;
    },
    async selfImage() {
      calls.push('self');
      return o.self;
    },
    async engineVersion() {
      calls.push('version');
      return o.version ?? '29.9.2';
    },
    async createDropNetwork(name: string, _labels: Record<string, string>, pool: string) {
      calls.push(`create ${name} ${pool}`);
      if (o.netError) throw new Error(o.netError);
      return { name, gateway: '172.30.0.1', proxy: '172.30.0.2' } as never;
    },
    async probeIsolation(net: { name: string }, images: { host: string; drop: string }) {
      calls.push(`isolation ${net.name} host=${images.host} drop=${images.drop}`);
      if (o.probeError) throw new Error(o.probeError);
      return { ...GOOD, ...o.facts };
    },
    async startEgressProxy(p: { name: string; env: Record<string, string> }) {
      calls.push(`proxy ${p.name} bind=${p.env.JM_EGRESS_BIND}`);
      return {
        async *logs() {
          if (o.proxyReady !== false) yield '{"ready":true}';
        },
        async stop() {
          calls.push('proxy-stop');
        },
      };
    },
    async removeServices(name: string, labels: Record<string, string>) {
      calls.push(`teardown ${name} ${JSON.stringify(labels)}`);
    },
    async removeNetwork(name: string) {
      calls.push(`remove ${name}`);
    },
  } as unknown as ContainerDriver;
  return { driver, calls };
}

describe('the egress capability', () => {
  test('the stick advertises egress-v1 only when it can enforce it', async () => {
    const ok = probeDriver();
    expect(await egressCapability(ok.driver, { HOSTNAME: 'h1' }, { readyMs: 50 })).toEqual({
      ok: true,
    });
    // It proves isolation behaviourally on a real drop network, then that the proxy image starts
    // there and says it is ready, and tears the probe down.
    const labels = JSON.stringify({ 'jumpmaster.egress-probe': 'jm-egress-probe-h1' });
    expect(ok.calls).toEqual([
      'image jumpmaster-egress:dev',
      'version',
      `teardown jm-egress-probe-h1 ${labels}`,
      'create jm-egress-probe-h1 172.30.0.0/16',
      'self',
      'isolation jm-egress-probe-h1 host=jumpmaster-egress:dev drop=jumpmaster-egress:dev',
      'proxy jm-egress-probe-h1-0 bind=172.30.0.2',
      'proxy-stop',
      `teardown jm-egress-probe-h1 ${labels}`,
    ]);

    const noImage = probeDriver({ image: false });
    expect(
      await egressCapability(noImage.driver, { JM_EGRESS_IMAGE: 'reg/egress@sha256:ab' }),
    ).toEqual({
      ok: false,
      reason: 'the egress proxy image reg/egress@sha256:ab is not on this engine',
    });
    const noNet = probeDriver({ netError: 'internal networks are not supported' });
    expect(await egressCapability(noNet.driver, {})).toEqual({
      ok: false,
      reason: 'cannot create a drop network: internal networks are not supported',
    });
    const badPool = probeDriver();
    expect(
      await egressCapability(badPool.driver, { JM_DROP_SUBNET_POOL: 'fd00::/48' }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/JM_DROP_SUBNET_POOL/) });

    expect(stickInfo({}, '1', ['egress-v1']).capabilities).toEqual(['egress-v1']);
    expect(stickInfo({}, '1').capabilities).toEqual([]);
  });

  test('an engine older than the minimum is refused before any probe', async () => {
    expect(MIN_ENGINE_VERSION).toBe('27.0');
    for (const version of ['20.10.24', '26.1.4', 'unknown', '']) {
      const d = probeDriver({ version });
      const r = await egressCapability(d.driver, {}, { readyMs: 50 });
      expect(r, version).toEqual({
        ok: false,
        reason: `Docker Engine ${version || 'unknown'} is older than ${MIN_ENGINE_VERSION}, the oldest egress is checked against`,
      });
      expect(d.calls.some((c) => c.startsWith('create'))).toBe(false);
    }
    expect(engineAtLeast('27.0.0', '27.0')).toBe(true);
    expect(engineAtLeast('29.9.2', '27.0')).toBe(true);
    expect(engineAtLeast('28.0.0-rc.1', '27.0')).toBe(true);
    expect(engineAtLeast('26.99.0', '27.0')).toBe(false);
    expect(engineAtLeast('100.0', '27.0')).toBe(true);
  });

  test.each([
    [
      'the gateway holds a host address (inhibit_ipv4 ignored)',
      { gatewayOnHost: true },
      'the engine put the drop gateway 172.30.0.1 on the host: inhibit_ipv4 is not honoured',
    ],
    [
      'a host listener answers at the gateway',
      { gatewayReachable: true },
      'a drop container reached a host listener at its gateway 172.30.0.1',
    ],
    [
      'the probe could not listen on the host',
      { listenerUp: false },
      'the isolation probe could not start its host listener',
    ],
    [
      'IPv6 could not be disabled',
      { ipv6Disabled: false },
      'IPv6 could not be disabled in a drop container',
    ],
  ])('no egress-v1 when %s', async (_n, facts, reason) => {
    const d = probeDriver({ facts });
    expect(await egressCapability(d.driver, { HOSTNAME: 'h1' }, { readyMs: 50 })).toEqual({
      ok: false,
      reason,
    });
    // The probe network is removed whatever the outcome.
    expect(d.calls.at(-1)).toMatch(/^teardown jm-egress-probe-h1/);
    expect(d.calls.some((c) => c.startsWith('proxy '))).toBe(false);
  });

  test('no egress-v1 when the probe fails or the proxy image never says it is ready', async () => {
    const broken = probeDriver({ probeError: 'sysctl not allowed' });
    expect(await egressCapability(broken.driver, {}, { readyMs: 50 })).toEqual({
      ok: false,
      reason: 'the isolation probe failed: sysctl not allowed',
    });
    const silent = probeDriver({ proxyReady: false });
    expect(await egressCapability(silent.driver, {}, { readyMs: 50 })).toEqual({
      ok: false,
      reason: 'the egress proxy did not start on a drop network: no ready line within 0s',
    });
    expect(silent.calls.at(-1)).toMatch(/^teardown/);
  });

  test('the stick passes its proxy limits on to every proxy', async () => {
    const d = probeDriver();
    const env: Record<string, string> = {};
    (d.driver as unknown as { startEgressProxy: unknown }).startEgressProxy = async (p: {
      env: Record<string, string>;
    }) => {
      Object.assign(env, p.env);
      return {
        async *logs() {
          yield '{"ready":true}';
        },
        async stop() {},
      };
    };
    const s = await startEgress(d.driver, {
      dropId: 'd',
      epoch: 1,
      egress: { mode: 'enforce', allow: ['github.com'] },
      net: { proxy: '172.30.0.2' } as never,
      image: 'i',
      labels: {},
      readyMs: 50,
      env: { JM_EGRESS_MAX_TUNNELS: '256', JM_EGRESS_MAX_CONNECTIONS: '512', JM_OTHER: 'x' },
    });
    await s.stop();
    expect(env).toEqual({
      JM_EGRESS_MODE: 'enforce',
      JM_EGRESS_ALLOW: 'github.com',
      JM_EGRESS_BIND: '172.30.0.2',
      JM_EGRESS_MAX_TUNNELS: '256',
      JM_EGRESS_MAX_CONNECTIONS: '512',
    });
  });

  test("the host-side probe runs from the stick's own image, the drop side from the proxy image", async () => {
    const d = probeDriver({ self: 'sha256:stickimage' });
    expect(await egressCapability(d.driver, { HOSTNAME: 'h1' }, { readyMs: 50 })).toEqual({
      ok: true,
    });
    expect(d.calls).toContain(
      'isolation jm-egress-probe-h1 host=sha256:stickimage drop=jumpmaster-egress:dev',
    );
  });

  describe('under the signed image policy', () => {
    const EG = `ghcr.io/o/jumpmaster-egress@sha256:${'e'.repeat(64)}`;
    const cosign =
      (code: number): Cosign =>
      async () =>
        code === 0
          ? {
              code: 0,
              stdout: JSON.stringify([
                { critical: { image: { 'docker-manifest-digest': `sha256:${'e'.repeat(64)}` } } },
              ]),
              stderr: '',
            }
          : { code, stdout: '', stderr: 'Error: no signatures found' };
    const trust = (code = 0) => ({
      policy: 'signed' as const,
      allowed: new Set<string>(),
      signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster'),
      cosign: cosign(code),
    });

    test('the proxy image is pulled by digest and verified before any probe container runs', async () => {
      const d = probeDriver({ present: false });
      const r = await egressCapability(
        d.driver,
        { HOSTNAME: 'h1', JM_EGRESS_IMAGE: EG },
        { readyMs: 50, trust: trust(), log: () => {} },
      );
      expect(r).toEqual({ ok: true });
      expect(d.calls.slice(0, 3)).toEqual([`image ${EG}`, `pull ${EG}`, `image ${EG}`]);
      // No stick image to run the host side from: the verified proxy image runs it.
      expect(d.calls).toContain(`isolation jm-egress-probe-h1 host=${EG} drop=${EG}`);
    });

    test('a tag, an unverified or an unpullable proxy image means no egress-v1, and no probe', async () => {
      const cases: [
        Record<string, string>,
        ReturnType<typeof trust>,
        Parameters<typeof probeDriver>[0],
        RegExp,
      ][] = [
        [
          {},
          trust(),
          {},
          /^the egress proxy image jumpmaster-egress:dev is not a digest reference; under the signed image policy set JM_EGRESS_IMAGE to the release's proxy by digest$/,
        ],
        [
          { JM_EGRESS_IMAGE: EG },
          trust(10),
          {},
          /^the egress proxy image is not verified: image not verified: .*: cosign exit 10: no signatures found$/,
        ],
        [
          { JM_EGRESS_IMAGE: EG },
          trust(),
          { present: false, pullError: 'denied' },
          /^image pull failed: .*: denied$/,
        ],
      ];
      for (const [env, t, o, reason] of cases) {
        const d = probeDriver(o);
        const r = await egressCapability(
          d.driver,
          { HOSTNAME: 'h1', ...env },
          { readyMs: 50, trust: t, log: () => {} },
        );
        expect(r.ok, reason.source).toBe(false);
        expect(r.ok || r.reason).toMatch(reason);
        expect(d.calls.some((c) => c.startsWith('create') || c.startsWith('isolation'))).toBe(
          false,
        );
      }
    });
  });

  test('JM_EGRESS_IMAGE names the proxy image', () => {
    expect(egressImage({})).toBe('jumpmaster-egress:dev');
    expect(egressImage({ JM_EGRESS_IMAGE: ' reg/e@sha256:1 ' })).toBe('reg/e@sha256:1');
  });
});

const line = (host: string, decision: string, reason?: string) =>
  JSON.stringify({ at: 't', host, port: 443, decision, ...(reason ? { reason } : {}) });

describe('EgressTally', () => {
  test('ignores the ready line, malformed lines and unknown decisions; trims long hosts', () => {
    const t = new EgressTally();
    t.add('{"ready":true}');
    t.add('nope');
    t.add('{"host":"a.test","decision":"maybe"}');
    t.add(JSON.stringify({ host: 'x'.repeat(5000), decision: 'deny', reason: 'bad target' }));
    const ev = t.events('t');
    expect(ev).toHaveLength(1);
    expect((ev[0]?.data.host as string).length).toBe(253);
  });

  test('refusals cannot push allowed or unlisted hosts out: the cap is per decision', () => {
    expect(MAX_EGRESS_HOSTS).toBe(200);
    const t = new EgressTally();
    // An agent floods refusals first...
    for (let i = 0; i < 500; i++) t.add(line(`x${i}.invalid`, 'deny', 'port not allowed'));
    // ...then leaks through monitor mode, and uses an allowed host.
    t.add(line('evil.example', 'allow', 'unlisted'));
    t.add(line('github.com', 'allow'));
    const ev = t.events('t');
    const shown = (d: string) => ev.filter((e) => e.data.decision === d && !e.data.overflow);
    expect(shown('unlisted').map((e) => e.data.host)).toEqual(['evil.example']);
    expect(shown('allow').map((e) => e.data.host)).toEqual(['github.com']);
    expect(shown('deny')).toHaveLength(200);
    // Overflow is counted per decision, so the page can say which kind was cut.
    expect(ev.filter((e) => e.data.overflow).map((e) => e.data)).toEqual([
      { host: '(300 more deny hosts)', decision: 'deny', count: 300, hosts: 300, overflow: true },
    ]);
  });

  test('each decision overflows on its own, counting hosts and connections', () => {
    const t = new EgressTally();
    for (let i = 0; i < 203; i++) {
      t.add(line(`u${i}.example`, 'allow', 'unlisted'));
      if (i >= 200) t.add(line(`u${i}.example`, 'allow', 'unlisted'));
    }
    const over = t.events('t').filter((e) => e.data.overflow);
    expect(over.map((e) => e.data)).toEqual([
      { host: '(3 more unlisted hosts)', decision: 'unlisted', count: 6, hosts: 3, overflow: true },
    ]);
  });
});
