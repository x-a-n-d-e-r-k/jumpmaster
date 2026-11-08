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
import type { ContainerDriver } from './driver.js';
import { allowedImages, reapOrphans, runDrop } from './runner.js';

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
  opts: { hang?: boolean; exitCode?: number; serviceError?: string; stderr?: string } = {},
) {
  const d = {
    started: undefined as Parameters<ContainerDriver['start']>[0] | undefined,
    stopped: false,
    killed: false,
    services: undefined as unknown,
    removedNetworks: [] as string[],
    stopGrace: 0,
    driver: {
      async start(o) {
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
      async startServices(dropId, epoch, services, labels) {
        d.services = { dropId, epoch, names: services.map((s) => s.name), labels };
        if (opts.serviceError) throw new Error(opts.serviceError);
        return `jm-drop-${dropId}-${epoch}`;
      },
      async removeServices(network) {
        d.removedNetworks.push(network);
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
