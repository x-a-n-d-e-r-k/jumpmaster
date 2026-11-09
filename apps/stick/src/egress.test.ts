import { describe, expect, test } from 'vitest';
import type { ContainerDriver } from './driver.js';
import { EgressTally, egressCapability, egressImage } from './egress.js';
import { stickInfo } from './state.js';

/** Just the calls the capability probe makes. */
function probeDriver(o: { image?: boolean; netError?: string } = {}) {
  const calls: string[] = [];
  const driver = {
    async imageExists(image: string) {
      calls.push(`image ${image}`);
      return o.image ?? true;
    },
    async createDropNetwork(name: string, _labels: Record<string, string>, pool: string) {
      calls.push(`create ${name} ${pool}`);
      if (o.netError) throw new Error(o.netError);
      return { name } as never;
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
    expect(await egressCapability(ok.driver, { HOSTNAME: 'h1' })).toEqual({ ok: true });
    // It proves it can make a drop network on its pool, and cleans the probe up.
    expect(ok.calls).toEqual([
      'image jumpmaster-egress:dev',
      'remove jm-egress-probe-h1',
      'create jm-egress-probe-h1 172.30.0.0/16',
      'remove jm-egress-probe-h1',
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
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/JM_DROP_SUBNET_POOL/),
    });

    expect(stickInfo({}, '1', ['egress-v1']).capabilities).toEqual(['egress-v1']);
    expect(stickInfo({}, '1').capabilities).toEqual([]);
  });

  test('JM_EGRESS_IMAGE names the proxy image', () => {
    expect(egressImage({})).toBe('jumpmaster-egress:dev');
    expect(egressImage({ JM_EGRESS_IMAGE: ' reg/e@sha256:1 ' })).toBe('reg/e@sha256:1');
  });
});

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
});
