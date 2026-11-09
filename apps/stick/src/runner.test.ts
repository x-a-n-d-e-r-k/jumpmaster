import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_PREFIX,
  type ArtifactUpload,
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { describe, expect, test } from 'vitest';
import type { DropClient } from './client.js';
import type { ContainerDriver, DropNet } from './driver.js';
import { allowedImages, reapOrphans, runDrop, sweepDropNetworks } from './runner.js';
import { type Cosign, type ImageTrust, releaseSigner, VerifyCache } from './verify.js';

const NET: DropNet = {
  name: 'jm-drop-d1-3',
  subnet: '172.30.0.16/28',
  gateway: '172.30.0.17',
  proxy: '172.30.0.18',
  trooper: '172.30.0.19',
  dns: '172.30.0.20',
  ipRange: '172.30.0.24/29',
};

const TOKEN = 'sk-secret-claude-token';
const payload: DropPayload = DropPayloadSchema.parse({
  protocol: 1,
  dropId: 'd1',
  epoch: 3,
  role: 'implement',
  repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
  issue: { number: 1, title: 't', body: 'b' },
  branch: 'agent/issue-1',
  gates: [],
  model: 'm',
  maxTurns: 5,
  promptVersion: 'v1',
  prompt: 'p',
  image: 'jumpmaster-trooper:test',
  protectedPaths: [],
  credentials: { claudeToken: TOKEN, forgeToken: 'ghs_forge' },
});

function fakeDriver(
  lines: string[],
  opts: {
    hang?: boolean;
    exitCode?: number;
    serviceError?: string;
    stderr?: string;
    /** The proxy's stdout; `hang` keeps it open with no ready line. */
    proxyLines?: string[];
    proxyHang?: boolean;
    netError?: string;
    proxyError?: string;
    networks?: { name: string; labels: Record<string, string> }[];
    /** The trooper image's labels (default: a current trooper's); an Error is thrown instead. */
    imageLabels?: Record<string, string> | Error;
    /** Which images are on the engine already (default: all of them). */
    present?: (ref: string) => boolean;
    pullError?: string;
  } = {},
) {
  const order: string[] = [];
  const d = {
    order,
    started: undefined as Parameters<ContainerDriver['start']>[0] | undefined,
    stopped: false,
    killed: false,
    services: undefined as unknown,
    servicesNet: undefined as DropNet | undefined,
    removedNetworks: [] as string[],
    removedLabels: [] as Record<string, string>[],
    stopGrace: 0,
    net: undefined as { name: string; labels: Record<string, string>; pool: string } | undefined,
    proxy: undefined as Parameters<ContainerDriver['startEgressProxy']>[0] | undefined,
    proxyStopped: false,
    inspected: [] as string[],
    /** Pulls and verification steps, in order, with the container steps in `order` too. */
    images: [] as string[],
    driver: {
      async imageLabels(image) {
        d.inspected.push(image);
        const l = opts.imageLabels ?? { 'org.jumpmaster.trooper.egress': '1' };
        if (l instanceof Error) throw l;
        return l;
      },
      async createDropNetwork(name, labels, pool) {
        order.push('network');
        d.net = { name, labels, pool };
        if (opts.netError) throw new Error(opts.netError);
        return { ...NET, name };
      },
      async startEgressProxy(o) {
        order.push('proxy');
        d.proxy = o;
        if (opts.proxyError) throw new Error(opts.proxyError);
        let release: () => void = () => {};
        const stopped = new Promise<void>((r) => {
          release = r;
        });
        return {
          async *logs() {
            if (opts.proxyHang) {
              await stopped;
              return;
            }
            yield '{"ready":true}';
            await stopped;
            for (const l of opts.proxyLines ?? []) yield l;
          },
          async stop() {
            order.push('proxy-stop');
            d.proxyStopped = true;
            release();
          },
        };
      },
      async listNetworksByLabel() {
        return opts.networks ?? [];
      },
      async removeNetwork() {},
      async imageExists(ref) {
        return opts.present ? opts.present(ref) : true;
      },
      async pullImage(ref) {
        order.push(`pull ${ref}`);
        d.images.push(`pull ${ref}`);
        if (opts.pullError) throw new Error(opts.pullError);
      },
      async engineVersion() {
        return '29.9.2';
      },
      async selfImage() {
        return undefined;
      },
      async probeIsolation() {
        return {
          listenerUp: true,
          gatewayOnHost: false,
          gatewayReachable: false,
          ipv6Disabled: true,
        };
      },
      async start(o) {
        order.push('trooper');
        d.started = o;
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
          release = r;
        });
        return {
          async *logs() {
            for (const l of lines) yield l;
            if (opts.hang) await gate;
          },
          async wait() {
            if (opts.hang) await gate;
            return { exitCode: d.stopped ? 137 : (opts.exitCode ?? 0) };
          },
          stderrTail: () => opts.stderr ?? '',
          async stop(grace: number) {
            d.stopped = true;
            d.stopGrace = grace;
            release();
          },
          async kill() {
            d.killed = true;
            release();
          },
        };
      },
      async listByLabel() {
        return [];
      },
      async remove() {},
      async startServices(dropId, epoch, services, labels, net) {
        order.push('services');
        d.services = { dropId, epoch, names: services.map((s) => s.name), labels };
        d.servicesNet = net;
        if (opts.serviceError) throw new Error(opts.serviceError);
        return `jm-drop-${dropId}-${epoch}`;
      },
      async removeServices(network, labels) {
        order.push('teardown');
        d.removedNetworks.push(network);
        d.removedLabels.push(labels);
      },
      async removeNetworksByLabel() {
        return 0;
      },
    } satisfies ContainerDriver,
  };
  return d;
}

function fakeClient(heartbeatReply: 'ok' | 'cancel' | 'hard_cancel' | 'stale' = 'ok') {
  return {
    events: [] as TrooperEvent[][],
    result: undefined as DropResult | undefined,
    heartbeatReply,
    async postArtifact(
      _dropId: string,
      _epoch: number,
      _a: ArtifactUpload,
    ): Promise<'ok' | 'stale'> {
      return 'ok';
    },
    async heartbeat() {
      return this.heartbeatReply;
    },
    async postEvents(_d: string, _e: number, ev: TrooperEvent[]) {
      this.events.push(ev);
      return 'ok' as const;
    },
    async postResult(_d: string, _e: number, r: DropResult) {
      this.result = r;
      return 'ok' as const;
    },
  } satisfies DropClient & Record<string, unknown>;
}

// The fixture image is not in the default allow-list; every legacy test runs with it allowed.
process.env.JM_ALLOWED_IMAGES = 'jumpmaster-trooper:test';

describe('image allow-list', () => {
  test('uses payload image', async () => {
    const d = fakeDriver(['JM_RESULT {"status":"completed","gates":[]}']);
    await runDrop(
      { ...payload, image: 'reg.example/trooper:1' },
      {
        client: fakeClient(),
        driver: d.driver,
        stickId: 's1',
        image: 'other:1',
        allowedImages: new Set(['reg.example/trooper:1']),
      },
    );
    expect(d.started?.image).toBe('reg.example/trooper:1');
  });

  test('falls back to the stick image when the payload has none', async () => {
    const d = fakeDriver(['JM_RESULT {"status":"completed","gates":[]}']);
    await runDrop(
      { ...payload, image: '' },
      {
        client: fakeClient(),
        driver: d.driver,
        stickId: 's1',
        image: 'other:1',
        allowedImages: new Set(['other:1']),
      },
    );
    expect(d.started?.image).toBe('other:1');
  });

  test('refuses an image outside the allow-list', async () => {
    const d = fakeDriver([]);
    const client = fakeClient();
    await runDrop(
      { ...payload, image: 'evil/trooper:1' },
      {
        client,
        driver: d.driver,
        stickId: 's1',
        allowedImages: new Set(['jumpmaster-trooper:dev']),
      },
    );
    expect(d.started).toBeUndefined();
    expect(client.result).toMatchObject({
      status: 'failed',
      role: 'implement',
      reason: 'image not allowed: evil/trooper:1',
      gates: [],
    });
  });

  test('no prefix match', async () => {
    const d = fakeDriver([]);
    const client = fakeClient();
    await runDrop(
      { ...payload, image: 'jumpmaster-trooper:dev-evil' },
      { client, driver: d.driver, stickId: 's1', allowedImages: allowedImages({}) },
    );
    expect(d.started).toBeUndefined();
    expect(client.result?.reason).toBe('image not allowed: jumpmaster-trooper:dev-evil');
  });

  test('empty JM_ALLOWED_IMAGES means the default', () => {
    expect(allowedImages({ JM_ALLOWED_IMAGES: ' , ' })).toEqual(
      new Set(['jumpmaster-trooper:dev']),
    );
    expect(allowedImages({ JM_TROOPER_IMAGE: 'mine:2' })).toEqual(
      new Set(['mine:2', 'jumpmaster-trooper:dev']),
    );
    expect(allowedImages({ JM_ALLOWED_IMAGES: ' a:1 ,b:2,, ' })).toEqual(new Set(['a:1', 'b:2']));
  });
});

describe('runDrop with services', () => {
  const withDb: DropPayload = {
    ...payload,
    image: 'trooper',
    services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
  };
  const allowed = new Set(['trooper', 'postgres:16']);
  const done = 'JM_RESULT {"status":"completed","headSha":"a","gates":[]}';

  test('a service image off the allow-list fails the drop before any container starts', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    await runDrop(withDb, {
      client,
      driver: d.driver,
      stickId: 's1',
      allowedImages: new Set(['trooper']),
    });
    expect(d.services).toBeUndefined();
    expect(d.started).toBeUndefined();
    expect(client.result).toMatchObject({
      status: 'failed',
      reason: 'image not allowed: postgres:16',
    });
  });

  test('sidecars start first, join the trooper, and are removed on success', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    await runDrop(withDb, { client, driver: d.driver, stickId: 's1', allowedImages: allowed });
    expect(d.started?.network).toBe(`jm-drop-${payload.dropId}-${payload.epoch}`);
    expect(d.removedNetworks).toEqual([`jm-drop-${payload.dropId}-${payload.epoch}`]);
    expect(client.result).toMatchObject({ status: 'completed' });
  });

  test.each([
    ['cancel', 'cancel'],
    ['hard kill', 'hard_cancel'],
  ] as const)('sidecars are removed on %s', async (_n, reply) => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient(reply);
    await runDrop(withDb, {
      client,
      driver: d.driver,
      heartbeatMs: 5,
      stickId: 's1',
      allowedImages: allowed,
    });
    expect(d.removedNetworks).toHaveLength(1);
  });

  test('a service that cannot start fails the drop and cleans up', async () => {
    const d = fakeDriver([done], { serviceError: 'boom' });
    const client = fakeClient();
    await runDrop(withDb, { client, driver: d.driver, stickId: 's1', allowedImages: allowed });
    expect(d.started).toBeUndefined();
    expect(client.result).toMatchObject({ status: 'failed', reason: 'services failed: boom' });
    expect(d.removedNetworks).toHaveLength(1);
  });

  test('stick startup removes networks left by a crashed run', async () => {
    const d = fakeDriver([]);
    let asked: string[] = [];
    d.driver.removeNetworksByLabel = async (k, v) => {
      asked = [k, v];
      return 2;
    };
    await reapOrphans(d.driver, 's1');
    expect(asked).toEqual(['jumpmaster.stick', 's1']);
  });

  test('limits reach the trooper; a zone with none changes nothing', async () => {
    const d = fakeDriver([done]);
    await runDrop(
      { ...payload, image: 'trooper', limits: { pids: 4096 } },
      { client: fakeClient(), driver: d.driver, stickId: 's1', allowedImages: allowed },
    );
    expect(d.started?.limits).toEqual({ pids: 4096 });
    expect(d.services).toBeUndefined();
  });
});

describe('artifacts', () => {
  const bytes = Buffer.from('artifact-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const chunk = (data: Buffer, index: number, total: number, hash = sha256) =>
    `${ARTIFACT_PREFIX}${JSON.stringify({ rule: 'ui', name: 'a.png', mediaType: 'image/png', sha256: hash, index, total, data: data.toString('base64') })}`;
  const done =
    'JM_RESULT {"status":"completed","verdict":{"decision":"approve","summary":"s","findings":[]},"gates":[]}';

  test('chunks reassemble, upload before the result, and stay out of events', async () => {
    const d = fakeDriver([chunk(bytes.subarray(0, 5), 0, 2), chunk(bytes.subarray(5), 1, 2), done]);
    const client = fakeClient();
    const order: string[] = [];
    client.postArtifact = async (_id, _e, a) => {
      order.push('artifact');
      expect(Buffer.from(a.dataBase64, 'base64').equals(bytes)).toBe(true);
      expect(a).toMatchObject({ rule: 'ui', name: 'a.png', sha256 });
      return 'ok';
    };
    const post = client.postResult.bind(client);
    client.postResult = async (...args) => {
      order.push('result');
      return post(...args);
    };
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 1000, stickId: 's1' });
    expect(order).toEqual(['artifact', 'result']);
    expect(client.events.flat()).toEqual([]);
  });

  test('a missing or corrupt chunk uploads nothing', async () => {
    const d = fakeDriver([
      chunk(bytes.subarray(0, 5), 0, 2),
      chunk(bytes.subarray(5), 0, 2, 'f'.repeat(64)),
      done,
    ]);
    const client = fakeClient();
    let uploads = 0;
    client.postArtifact = async () => {
      uploads++;
      return 'ok';
    };
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 1000, stickId: 's1' });
    expect(uploads).toBe(0);
    expect(client.result).toMatchObject({ status: 'completed' });
  });
});

describe('runDrop', () => {
  test('relays events and posts the result', async () => {
    const d = fakeDriver([
      'JM_EVENT {"ts":"t","kind":"phase","data":{"phase":"clone"}}',
      'JM_RESULT {"status":"completed","headSha":"a","gates":[]}',
    ]);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.events.flat()).toHaveLength(1);
    expect(client.result).toMatchObject({ status: 'completed', headSha: 'a' });
  });

  // The trooper finds the payload on a polluted stdin by this prefix (see trooper readPayload).
  test('the payload on stdin starts with its protocol field', async () => {
    const d = fakeDriver(['JM_RESULT {"status":"completed","gates":[]}']);
    await runDrop(payload, {
      client: fakeClient(),
      driver: d.driver,
      heartbeatMs: 10,
      stickId: 's1',
    });
    expect(d.started?.payload.startsWith('{"protocol":')).toBe(true);
  });

  test('exit without result reports failed', async () => {
    const d = fakeDriver(['plain log line'], { exitCode: 2 });
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.result).toEqual({
      status: 'failed',
      role: 'implement',
      reason: 'trooper exited 2 without result',
      gates: [],
    });
  });

  test('exit without result carries the last stderr line, redacted', async () => {
    const stderr = `starting\n\nSyntaxError: Unexpected token in JSON near "${TOKEN}" and ghs_forge\n\n`;
    const d = fakeDriver([], { exitCode: 1, stderr });
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.result?.reason).toBe(
      'trooper exited 1 without result: SyntaxError: Unexpected token in JSON near "[REDACTED]" and [REDACTED]',
    );
  });

  test('Node footer lines are not taken as the reason', async () => {
    const stderr = 'Error: real cause\n    at x (y.js:1:1)\n\nNode.js v26.1.0\n';
    const d = fakeDriver([], { exitCode: 1, stderr });
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.result?.reason).toBe('trooper exited 1 without result: Error: real cause');
  });

  test('a long stderr line is cut to a readable reason', async () => {
    const d = fakeDriver([], { exitCode: 1, stderr: `Error: ${'x'.repeat(2000)}` });
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.result?.reason?.length).toBeLessThanOrEqual(600);
  });

  test('a hard cancel kills the container with no checkpoint stop', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('hard_cancel');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(d.killed).toBe(true);
    expect(d.stopped).toBe(false);
    expect(client.result).toBeUndefined();
  });

  test('an ordinary cancel still stops it gracefully', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('cancel');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(d.stopped).toBe(true);
    expect(d.killed).toBe(false);
  });

  test('a stick that loses the server hard-kills its drop after the limit', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient();
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      throw new Error('network down');
    };
    await runDrop(payload, {
      client,
      driver: d.driver,
      heartbeatMs: 5,
      stickId: 's1',
      lostServerKillBeats: 3,
    });
    expect(beats).toBe(3);
    expect(d.killed).toBe(true);
  });

  test('a heartbeat recovering before the limit resets the count', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient();
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      if (beats === 7) return 'stale';
      if (beats % 3 === 0) return 'ok';
      throw new Error('blip');
    };
    await runDrop(payload, {
      client,
      driver: d.driver,
      heartbeatMs: 5,
      stickId: 's1',
      lostServerKillBeats: 3,
    });
    expect(d.killed).toBe(false);
    expect(d.stopped).toBe(true);
  });

  test('stale heartbeat stops the container with a 30s grace', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('stale');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(d.stopped).toBe(true);
    expect(d.stopGrace).toBe(30_000);
  });

  test('cancel heartbeat stops the container', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('cancel');
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(d.stopped).toBe(true);
  });

  test('payload goes to the driver and no file containing the token is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-stick-test-'));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = dir;
    try {
      const d = fakeDriver(['JM_RESULT {"status":"no_changes","gates":[]}']);
      await runDrop(payload, {
        client: fakeClient(),
        driver: d.driver,
        heartbeatMs: 10,
        stickId: 's1',
      });
      expect(JSON.parse(d.started?.payload ?? '{}').credentials.claudeToken).toBe(TOKEN);
      expect(d.started?.labels).toEqual({
        'jumpmaster.drop': 'd1',
        'jumpmaster.epoch': '3',
        'jumpmaster.stick': 's1',
      });
      for (const f of readdirSync(dir))
        expect(readFileSync(join(dir, f), 'utf8')).not.toContain(TOKEN);
    } finally {
      process.env.TMPDIR = prev;
    }
  });

  test('batches at most 50 events per post', async () => {
    const line = 'JM_EVENT {"ts":"t","kind":"log","data":{}}';
    const d = fakeDriver([
      ...Array(120).fill(line),
      'JM_RESULT {"status":"no_changes","gates":[]}',
    ]);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.events.flat()).toHaveLength(120);
    expect(Math.max(...client.events.map((b) => b.length))).toBeLessThanOrEqual(50);
  });

  test('batches by bytes so a post stays well under the 1 MB body limit', async () => {
    const line = `JM_EVENT {"ts":"t","kind":"log","data":{"s":"${'x'.repeat(60_000)}"}}`;
    const d = fakeDriver([...Array(40).fill(line), 'JM_RESULT {"status":"no_changes","gates":[]}']);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.events.flat()).toHaveLength(40);
    for (const b of client.events) expect(JSON.stringify(b).length).toBeLessThan(600_000);
  });

  test('a real result whose post fails is not overwritten by a synthetic failure', async () => {
    const d = fakeDriver(['JM_RESULT {"status":"completed","headSha":"a","gates":[]}']);
    const posted: DropResult[] = [];
    const client = {
      ...fakeClient(),
      async postResult(_d: string, _e: number, r: DropResult): Promise<'ok'> {
        posted.push(r);
        throw new Error('result failed: 502');
      },
    };
    await expect(
      runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' }),
    ).rejects.toThrow('result failed: 502');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ status: 'completed', headSha: 'a' });
  });

  test('logs() throwing stops the container and posts a failed result', async () => {
    const d = fakeDriver([]);
    const driver: ContainerDriver = {
      ...d.driver,
      async start(o) {
        const h = await d.driver.start(o);
        return {
          ...h,
          async *logs() {
            throw new Error('boom');
          },
        };
      },
    };
    const client = fakeClient();
    await runDrop(payload, { client, driver, heartbeatMs: 10, stickId: 's1' });
    expect(d.stopped).toBe(true);
    expect(client.result).toMatchObject({ status: 'failed', reason: 'stick runner error: boom' });
  });
});

describe('reapOrphans', () => {
  test("force-removes only this stick's labelled containers", async () => {
    const containers = [
      { id: 'mine-1', labels: { 'jumpmaster.stick': 's1' } },
      { id: 'other', labels: { 'jumpmaster.stick': 's2' } },
      { id: 'mine-2', labels: { 'jumpmaster.stick': 's1' } },
      { id: 'unrelated', labels: {} as Record<string, string> },
    ];
    const removed: string[] = [];
    const queried: string[][] = [];
    const driver: ContainerDriver = {
      ...fakeDriver([]).driver,
      async listByLabel(key, value) {
        queried.push([key, value]);
        return containers.filter((c) => c.labels[key] === value).map((c) => c.id);
      },
      async remove(id) {
        removed.push(id);
      },
    };
    expect(await reapOrphans(driver, 's1')).toEqual(['mine-1', 'mine-2']);
    expect(queried).toEqual([['jumpmaster.stick', 's1']]);
    expect(removed).toEqual(['mine-1', 'mine-2']);
  });

  test('one failed removal does not stop the others', async () => {
    const removed: string[] = [];
    const driver: ContainerDriver = {
      ...fakeDriver([]).driver,
      async listByLabel() {
        return ['a', 'b'];
      },
      async remove(id) {
        if (id === 'a') throw new Error('gone');
        removed.push(id);
      },
    };
    expect(await reapOrphans(driver, 's1')).toEqual(['b']);
    expect(removed).toEqual(['b']);
  });
});

describe('egress', () => {
  const done = 'JM_RESULT {"status":"completed","headSha":"a","gates":[]}';
  const enforce: DropPayload = {
    ...payload,
    image: 'trooper',
    egress: { mode: 'enforce', allow: ['api.anthropic.com', 'github.com'] },
  };
  const withDb: DropPayload = {
    ...enforce,
    services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
  };
  const allowed = new Set(['trooper', 'postgres:16']);
  const deps = (d: ReturnType<typeof fakeDriver>, client = fakeClient()) => ({
    client,
    driver: d.driver,
    stickId: 's1',
    allowedImages: allowed,
    egressImage: 'jumpmaster-egress:test',
    egressReadyMs: 50,
    subnetPool: '172.30.0.0/16',
  });

  test('egress off leaves the payload without egress and the trooper on the default network', async () => {
    const d = fakeDriver([done]);
    await runDrop({ ...payload, image: 'trooper' }, deps(d));
    expect(d.net).toBeUndefined();
    expect(d.proxy).toBeUndefined();
    expect(d.started?.egress).toBeUndefined();
    expect(d.started?.network).toBeUndefined();
    expect(d.order).toEqual(['trooper']);
  });

  test('the proxy gets the static .2 address and JM_EGRESS_BIND equal to it', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    await runDrop(withDb, deps(d, client));
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(d.net).toEqual({
      name: 'jm-drop-d1-3',
      labels: { 'jumpmaster.drop': 'd1', 'jumpmaster.epoch': '3', 'jumpmaster.stick': 's1' },
      pool: '172.30.0.0/16',
    });
    expect(d.proxy).toMatchObject({
      name: 'jm-egress-d1-3',
      image: 'jumpmaster-egress:test',
      net: { ...NET },
      env: {
        JM_EGRESS_MODE: 'enforce',
        JM_EGRESS_ALLOW: 'api.anthropic.com,github.com',
        JM_EGRESS_BIND: '172.30.0.18',
      },
    });
    // Ready before services and the trooper; everything torn down after, proxy included.
    expect(d.order).toEqual(['network', 'proxy', 'services', 'trooper', 'proxy-stop', 'teardown']);
    expect(d.servicesNet).toEqual(NET);
    expect(d.started?.egress).toEqual(NET);
    expect(d.started?.network).toBe('jm-drop-d1-3');
    expect(d.removedNetworks).toEqual(['jm-drop-d1-3']);
    // The proxy image is allowed for the proxy only, never as a trooper or service image.
    expect(allowed.has('jumpmaster-egress:test')).toBe(false);
  });

  test('a drop under egress without services still gets its own network and proxy', async () => {
    const d = fakeDriver([done]);
    await runDrop(enforce, deps(d));
    expect(d.order).toEqual(['network', 'proxy', 'trooper', 'proxy-stop', 'teardown']);
    expect(d.services).toBeUndefined();
  });

  test('the egress image never runs as a trooper', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    await runDrop({ ...enforce, image: 'jumpmaster-egress:test' }, deps(d, client));
    expect(client.result?.reason).toBe('image not allowed: jumpmaster-egress:test');
    expect(d.order).toEqual([]);
  });

  test.each([
    ['never prints ready', { proxyHang: true }],
    ['cannot be created', { proxyError: 'image jumpmaster-egress:test is missing' }],
    ['has no network', { netError: 'no free /28 in 172.30.0.0/16' }],
  ])('a proxy that %s fails the drop before any trooper is created', async (_n, o) => {
    const d = fakeDriver([done], o);
    const client = fakeClient();
    await runDrop(withDb, deps(d, client));
    expect(d.started).toBeUndefined();
    expect(d.services).toBeUndefined();
    expect(client.result).toMatchObject({ status: 'failed', role: 'implement', gates: [] });
    expect(client.result?.reason).toMatch(/^egress proxy failed to start: /);
    expect(d.removedNetworks).toEqual(['jm-drop-d1-3']);
    if (!('netError' in o) && !('proxyError' in o)) expect(d.proxyStopped).toBe(true);
  });

  describe('the trooper image must declare egress support (an older one ignores payload.egress)', () => {
    const monitor: DropPayload = { ...enforce, egress: { mode: 'monitor', allow: [] } };
    const MISSING =
      'image trooper does not declare egress support (label org.jumpmaster.trooper.egress=1): it was built on a trooper image older than egress, which ignores the drop\'s egress settings. Rebuild it FROM a current jumpmaster-trooper image, or set the zone\'s egress mode to "off".';
    const different = (v: string) =>
      `image trooper declares egress support org.jumpmaster.trooper.egress=${v}, but this stick runs only org.jumpmaster.trooper.egress=1: the image and the stick come from different releases. Use a trooper image from the stick's release (or a stick that supports ${v}), or set the zone's egress mode to "off".`;
    test.each([
      ['enforce, no label', enforce, {}, MISSING],
      ['monitor, no label', monitor, {}, MISSING],
      // A label can't be removed from an image, so an emptied one counts as missing.
      ['enforce, empty label', enforce, { 'org.jumpmaster.trooper.egress': '' }, MISSING],
      ['enforce, a look-alike key', enforce, { 'jumpmaster.trooper.egress': '1' }, MISSING],
      ['enforce, label 0', enforce, { 'org.jumpmaster.trooper.egress': '0' }, different('0')],
      [
        'enforce, a later version only',
        enforce,
        { 'org.jumpmaster.trooper.egress': '2' },
        different('2'),
      ],
    ])('%s: fails the drop before any network, proxy or trooper', async (_n, p, labels, reason) => {
      const d = fakeDriver([done], { imageLabels: labels });
      const client = fakeClient();
      await runDrop(p, deps(d, client));
      expect(d.inspected).toEqual(['trooper']);
      expect(d.order).toEqual([]);
      expect(d.started).toBeUndefined();
      expect(client.result).toMatchObject({ status: 'failed', role: 'implement', gates: [] });
      expect(client.result?.reason).toBe(reason);
    });

    test('a label value is cut short and stripped of control characters in the reason', async () => {
      const d = fakeDriver([done], {
        imageLabels: { 'org.jumpmaster.trooper.egress': `9\n${'x'.repeat(200)}` },
      });
      const client = fakeClient();
      await runDrop(enforce, deps(d, client));
      expect(client.result?.reason).toContain('org.jumpmaster.trooper.egress=9?xxxx');
      expect(client.result?.reason).not.toContain('x'.repeat(65));
    });

    test('an image the engine cannot inspect fails the drop closed', async () => {
      const d = fakeDriver([done], { imageLabels: new Error('no such image') });
      const client = fakeClient();
      await runDrop(enforce, deps(d, client));
      expect(d.order).toEqual([]);
      expect(client.result).toMatchObject({ status: 'failed', gates: [] });
      expect(client.result?.reason).toBe(
        'cannot inspect image trooper for egress support: no such image',
      );
    });

    test('a current trooper image runs the drop under egress', async () => {
      const d = fakeDriver([done]);
      const client = fakeClient();
      await runDrop(monitor, deps(d, client));
      expect(d.inspected).toEqual(['trooper']);
      expect(client.result).toMatchObject({ status: 'completed' });
      expect(d.order).toEqual(['network', 'proxy', 'trooper', 'proxy-stop', 'teardown']);
    });

    test('egress off never inspects the image: an older image still runs', async () => {
      const d = fakeDriver([done], { imageLabels: {} });
      const client = fakeClient();
      await runDrop({ ...payload, image: 'trooper' }, deps(d, client));
      expect(d.inspected).toEqual([]);
      expect(client.result).toMatchObject({ status: 'completed' });
      expect(d.order).toEqual(['trooper']);
    });
  });

  test('more services than a /28 holds fails the drop closed', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    const many = Array.from({ length: 7 }, (_, i) => ({
      name: `s${i}`,
      image: 'postgres:16',
      port: 5432,
      readyTimeoutSeconds: 60,
    }));
    await runDrop({ ...enforce, services: many }, deps(d, client));
    expect(client.result?.reason).toMatch(/at most 6 services/);
    expect(d.order).toEqual([]);
  });

  test('egress log lines become aggregated egress events, capped at 200 hosts', async () => {
    const line = (host: string, decision: string, reason?: string) =>
      JSON.stringify({ at: 't', host, port: 443, decision, ...(reason ? { reason } : {}) });
    const proxyLines = [
      line('github.com', 'allow'),
      line('github.com', 'allow'),
      line('github.com', 'allow'),
      line('example.com', 'deny', 'not allowed'),
      line('example.com', 'deny', 'not allowed'),
      line('cdn.example.net', 'allow', 'unlisted'),
      'not json',
      '{"ready":true}',
      ...Array.from({ length: 250 }, (_, i) => line(`h${i}.exfil.test`, 'deny', 'not allowed')),
    ];
    const d = fakeDriver(
      [
        // A trooper can't forge an egress event: only the stick's own reading of the proxy counts.
        'JM_EVENT {"ts":"t","kind":"egress","data":{"host":"forged.test","decision":"allow","count":1}}',
        done,
      ],
      { proxyLines },
    );
    const calls: string[] = [];
    const client = fakeClient();
    const postEvents = client.postEvents.bind(client);
    client.postEvents = async (...a) => {
      calls.push('events');
      return postEvents(...a);
    };
    const postResult = client.postResult.bind(client);
    client.postResult = async (...a) => {
      calls.push('result');
      return postResult(...a);
    };
    await runDrop(enforce, deps(d, client));
    const egress = client.events.flat().filter((e) => e.kind === 'egress');
    const byHost = new Map(egress.map((e) => [`${e.data.decision} ${e.data.host}`, e.data.count]));
    expect(byHost.get('allow github.com')).toBe(3);
    expect(byHost.get('deny example.com')).toBe(2);
    expect(byHost.get('unlisted cdn.example.net')).toBe(1);
    expect(byHost.has('allow forged.test')).toBe(false);
    // 200 per decision: the denied flood is cut, the allowed and unlisted hosts are all shown.
    const hosts = egress.filter((e) => !e.data.overflow);
    expect(hosts.filter((e) => e.data.decision === 'deny')).toHaveLength(200);
    expect(hosts).toHaveLength(202);
    expect(egress.filter((e) => e.data.overflow).map((e) => e.data)).toEqual([
      expect.objectContaining({ decision: 'deny', hosts: 51, count: 51, overflow: true }),
    ]);
    // Every batch stays within the events limit, and they all land before the result.
    expect(client.events.every((b) => b.length <= 50)).toBe(true);
    expect(calls.at(-1)).toBe('result');
    expect(calls.filter((c) => c === 'result')).toHaveLength(1);
  });

  test('teardown and the periodic sweep remove proxies and drop networks by label', async () => {
    const d = fakeDriver([], {
      networks: [
        {
          name: 'jm-drop-live-1',
          labels: { 'jumpmaster.drop': 'live', 'jumpmaster.epoch': '1', 'jumpmaster.stick': 's1' },
        },
        {
          name: 'jm-drop-old-2',
          labels: { 'jumpmaster.drop': 'old', 'jumpmaster.epoch': '2', 'jumpmaster.stick': 's1' },
        },
      ],
    });
    const removed = await sweepDropNetworks(d.driver, 's1', new Set(['jm-drop-live-1']));
    expect(removed).toBe(1);
    expect(d.removedNetworks).toEqual(['jm-drop-old-2']);
    // removeServices takes the proxy too: it carries the drop's labels and the service label.
    expect(d.removedLabels).toEqual([
      { 'jumpmaster.drop': 'old', 'jumpmaster.epoch': '2', 'jumpmaster.stick': 's1' },
    ]);
    // A running drop's network is in the active set while it runs, and out of it after.
    const active = new Set<string>();
    let during = false;
    const live = fakeDriver([done]);
    const start = live.driver.start;
    live.driver.start = async (o) => {
      during = active.has('jm-drop-d1-3');
      return start(o);
    };
    await runDrop(enforce, { ...deps(live), active });
    expect(during).toBe(true);
    expect(active.size).toBe(0);
  });
});

describe('image trust: verify, then pull, then create', () => {
  const done = 'JM_RESULT {"status":"completed","gates":[]}';
  const dg = (c: string) => `sha256:${c.repeat(64)}`;
  const TROOPER = `ghcr.io/o/jumpmaster-trooper@${dg('1')}`;
  const EGRESS = `ghcr.io/o/jumpmaster-egress@${dg('2')}`;
  const DB = `ghcr.io/o/postgres@${dg('3')}`;
  const signedPayload: DropPayload = {
    ...payload,
    image: TROOPER,
    egress: { mode: 'enforce', allow: ['github.com'] },
    services: [{ name: 'db', image: DB, port: 5432, readyTimeoutSeconds: 60 }],
  };
  /** A cosign that verifies exactly the digests in `good`, recording what it was asked. */
  const cosignFor = (good: string[], calls: string[] = []) => {
    const cosign: Cosign = async (args) => {
      const ref = args.at(-1) as string;
      calls.push(ref);
      const digest = ref.split('@')[1] as string;
      if (!good.includes(digest))
        return { code: 10, stdout: '', stderr: 'Error: no signatures found' };
      return {
        code: 0,
        stdout: JSON.stringify([{ critical: { image: { 'docker-manifest-digest': digest } } }]),
        stderr: '',
      };
    };
    return { cosign, calls };
  };
  const trust = (cosign: Cosign, allowed: string[] = []): ImageTrust => ({
    policy: 'signed',
    allowed: new Set(allowed),
    signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster'),
    cosign,
    cache: new VerifyCache(
      join(mkdtempSync(join(tmpdir(), 'jm-trust-')), 'verified.json'),
      releaseSigner('x-a-n-d-e-r-k/jumpmaster'),
      { now: () => new Date('2026-11-08T12:00:00Z') },
    ),
  });
  const deps = (
    d: ReturnType<typeof fakeDriver>,
    t: ImageTrust,
    client = fakeClient(),
    log: string[] = [],
  ) => ({
    client,
    driver: d.driver,
    stickId: 's1',
    trust: t,
    egressImage: EGRESS,
    egressReadyMs: 50,
    subnetPool: '172.30.0.0/16',
    log: (l: string) => log.push(l),
  });

  test('runDrop verifies, then pulls, the trooper, egress and service images before creating any container', async () => {
    const d = fakeDriver([done], { present: () => false });
    // cosign asks the registry; nothing is downloaded until every image has verified.
    const c = cosignFor([dg('1'), dg('2'), dg('3')], d.order);
    const client = fakeClient();
    const log: string[] = [];
    await runDrop(signedPayload, deps(d, trust(c.cosign), client, log));
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(d.order).toEqual([
      TROOPER,
      EGRESS,
      DB,
      `pull ${TROOPER}`,
      `pull ${EGRESS}`,
      `pull ${DB}`,
      'network',
      'proxy',
      'services',
      'trooper',
      'proxy-stop',
      'teardown',
    ]);
    // Every container is created from the verified digest reference itself.
    expect(d.started?.image).toBe(TROOPER);
    expect(d.proxy?.image).toBe(EGRESS);
    expect(log.map((l) => JSON.parse(l)).filter((l) => l.event === 'image-verified')).toEqual([
      { event: 'image-verified', dropId: 'd1', ref: TROOPER, via: 'cosign' },
      { event: 'image-verified', dropId: 'd1', ref: EGRESS, via: 'cosign' },
      { event: 'image-verified', dropId: 'd1', ref: DB, via: 'cosign' },
    ]);
  });

  test.each([
    ['trooper', dg('1')],
    ['egress proxy', dg('2')],
    ['service', dg('3')],
  ])(
    'an unverified %s image fails the drop before anything is pulled or created',
    async (_n, bad) => {
      const d = fakeDriver([done], { present: () => false });
      const good = [dg('1'), dg('2'), dg('3')].filter((x) => x !== bad);
      const client = fakeClient();
      await runDrop(signedPayload, deps(d, trust(cosignFor(good).cosign), client));
      expect(client.result).toMatchObject({ status: 'failed', role: 'implement', gates: [] });
      expect(client.result?.reason).toMatch(
        new RegExp(`^image not verified: \\S+@${bad}: cosign exit 10: no signatures found$`),
      );
      // Under signed an unsigned image is never downloaded, not even the ones that did verify.
      expect(d.images).toEqual([]);
      expect(d.order).toEqual([]);
      expect(d.started).toBeUndefined();
      expect(d.inspected).toEqual([]);
    },
  );

  test('under signed, a tag ref is refused before any pull, cosign call or container', async () => {
    for (const p of [
      { ...signedPayload, image: 'jumpmaster-trooper:dev' },
      {
        ...signedPayload,
        services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
      },
    ]) {
      const d = fakeDriver([done], { present: () => false });
      const c = cosignFor([dg('1'), dg('2'), dg('3')]);
      const client = fakeClient();
      await runDrop(p, deps(d, trust(c.cosign), client));
      expect(client.result?.reason).toMatch(/^image not verified: \S+: a tag reference;/);
      expect(d.order).toEqual([]);
      expect(c.calls).toEqual([]);
    }
    // The egress proxy too.
    const d = fakeDriver([done]);
    const client = fakeClient();
    await runDrop(signedPayload, {
      ...deps(d, trust(cosignFor([]).cosign), client),
      egressImage: 'jumpmaster-egress:dev',
    });
    expect(client.result?.reason).toMatch(
      /^image not verified: jumpmaster-egress:dev: a tag reference;/,
    );
    expect(d.order).toEqual([]);
  });

  test('a missing image is pulled by digest before create; a pull failure fails the drop naming the ref', async () => {
    const present = new Set([EGRESS, DB]);
    const d = fakeDriver([done], { present: (r) => present.has(r) });
    const client = fakeClient();
    await runDrop(
      signedPayload,
      deps(d, trust(cosignFor([dg('1'), dg('2'), dg('3')]).cosign), client),
    );
    expect(d.images).toEqual([`pull ${TROOPER}`]);
    expect(client.result).toMatchObject({ status: 'completed' });

    const e = fakeDriver([done], { present: () => false, pullError: 'manifest unknown\nmore' });
    const c = cosignFor([dg('1'), dg('2'), dg('3')]);
    const failed = fakeClient();
    await runDrop(signedPayload, deps(e, trust(c.cosign), failed));
    expect(failed.result).toMatchObject({ status: 'failed', gates: [] });
    expect(failed.result?.reason).toBe(`image pull failed: ${TROOPER}: manifest unknown`);
    expect(e.order).toEqual([`pull ${TROOPER}`]);
    // Verified first, so cosign was asked about all three.
    expect(c.calls).toEqual([TROOPER, EGRESS, DB]);
  });

  test('a pinned digest runs without cosign; a cached one without asking again', async () => {
    const d = fakeDriver([done]);
    const c = cosignFor([dg('1'), dg('2')]);
    const t = trust(c.cosign, [DB]);
    const log: string[] = [];
    await runDrop(signedPayload, deps(d, t, fakeClient(), log));
    await runDrop(signedPayload, deps(fakeDriver([done]), t, fakeClient(), log));
    expect(c.calls).toEqual([TROOPER, EGRESS]);
    const via = log
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'image-verified')
      .map((l) => l.via);
    expect(via).toEqual(['cosign', 'cosign', 'pinned', 'cache', 'cache', 'pinned']);
  });

  test('allowlist policy behaves exactly as in M3: no pull, no inspection, no cosign for tags', async () => {
    const d = fakeDriver([done], { present: () => false });
    const client = fakeClient();
    await runDrop(
      { ...payload, image: 'trooper' },
      {
        client,
        driver: d.driver,
        stickId: 's1',
        trust: { policy: 'allowlist', allowed: new Set(['trooper']) },
      },
    );
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(d.order).toEqual(['trooper']);
    // A digest the allow-list names is pulled when it's missing (the only change: it can run).
    const pin = `reg.example/trooper@${dg('9')}`;
    const e = fakeDriver([done], { present: () => false });
    await runDrop(
      { ...payload, image: pin },
      {
        client: fakeClient(),
        driver: e.driver,
        stickId: 's1',
        trust: { policy: 'allowlist', allowed: new Set([pin]) },
      },
    );
    expect(e.order).toEqual([`pull ${pin}`, 'trooper']);
  });
});
