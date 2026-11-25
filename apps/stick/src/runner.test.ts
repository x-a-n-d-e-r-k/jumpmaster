import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_PREFIX,
  type ArtifactUpload,
  type CloneGrant,
  type DropPayload,
  DropPayloadSchema,
  type DropResult,
  gitlabBasicAuth,
  gitlabBasicAuthAs,
  READY_LINE,
  type TrooperEvent,
} from '@jumpmaster/protocol';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// The real trooper's output, fed through the stick: the two ends of the event protocol.
import { eventLines } from '../../trooper/src/events.js';
import type { CloneClient, CloneGrantReply, ClonePlanReply, DropClient } from './client.js';
import type { ContainerDriver, DropNet } from './driver.js';
import type { ServerImageDeps, ServerImages } from './fetch-image.js';
import { IMAGES_FILE, StickImages } from './image-gc.js';
import type { ImageSource } from './pull.js';
import { PendingPushes } from './push.js';
import {
  allowedImages,
  HELD_RESULT_MAX_5XX,
  HealthMonitor,
  LOST_SERVER_GRACE_MS,
  reapOrphans,
  recoverAtStartup,
  rediscoverPending,
  runDrop,
  stickHealth,
  sweepDropNetworks,
  sweepVolumes,
  volumeSelfCheck,
} from './runner.js';
import { fakeDriver, NET } from './test/fake-driver.js';
import { release, tar } from './test/layout.js';
import { type Cosign, type ImageTrust, releaseSigner, VerifyCache } from './verify.js';

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

const CLONE_TOKEN = 'planted-clone-token-0123456789';
const CLONE_FORGE = {
  kind: 'gitlab',
  host: 'gitlab.example.com',
  project: 'group/proj',
} as unknown as CloneGrant['forge'];
const CLONE_GRANT: CloneGrant = {
  token: CLONE_TOKEN,
  forge: CLONE_FORGE,
  secrets: [],
  username: 'bot',
};

function fakeClient(heartbeatReply: 'ok' | 'cancel' | 'hard_cancel' | 'stale' = 'ok') {
  return {
    features: new Set(['push-v1']) as ReadonlySet<string>,
    events: [] as TrooperEvent[][],
    result: undefined as DropResult | undefined,
    salvageReply: 'refused' as 'ok' | 'refused',
    salvaged: 0,
    async salvage() {
      this.salvaged++;
      return this.salvageReply;
    },
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
      this.results.push(r);
      this.result = r;
      return 'ok' as const;
    },
    results: [] as DropResult[],
    /** The clone routes: a plan with no egress and a grant, unless a test says otherwise. */
    planReply: { forge: CLONE_FORGE, maxBytes: 1_000_000 } as ClonePlanReply,
    grantReply: { grant: CLONE_GRANT } as CloneGrantReply,
    cloneCalls: [] as string[],
    async clonePlan(_d: string, _e: number) {
      this.cloneCalls.push('plan');
      return this.planReply;
    },
    async cloneGrant(_d: string, _e: number) {
      this.cloneCalls.push('grant');
      return this.grantReply;
    },
  } satisfies DropClient & CloneClient & Record<string, unknown>;
}

/** What a pushing drop's agent run adds around its container (the volume, then its removal). */
const VOLUME_START = ['volume jm-drop-d1-3', 'init jumpmaster-trooper:dev'];
const VOLUME_END = ['removeAndWait jumpmaster-drop-d1-3', 'removeVolume jm-drop-d1-3'];

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
  const done =
    'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}';

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

describe('container starts and the image sweep (issue #425)', () => {
  test('a start waits for a running sweep, then marks its recorded images used', async () => {
    const trooper = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
    const db = `postgres@sha256:${'b'.repeat(64)}`;
    const stateDir = mkdtempSync(join(tmpdir(), 'jm-images-'));
    const old = '2026-11-01T00:00:00.000Z';
    writeFileSync(
      join(stateDir, IMAGES_FILE),
      JSON.stringify({
        [trooper]: { repository: 'ghcr.io/o/jumpmaster-trooper', lastUsedAt: old },
        [db]: { repository: 'postgres', lastUsedAt: old },
      }),
    );
    const d = fakeDriver([
      'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}',
    ]);
    const images = new StickImages({
      driver: d.driver,
      stateDir,
      keep: [],
      log: () => {},
      now: () => new Date('2026-11-19T00:00:00.000Z'),
    });
    let endSweep: () => void = () => {};
    const sweep = images.lock.exclusive(
      () =>
        new Promise<void>((r) => {
          endSweep = r;
        }),
    );
    const run = runDrop(
      {
        ...payload,
        image: trooper,
        services: [{ name: 'db', image: db, port: 5432, readyTimeoutSeconds: 60 }],
      },
      {
        client: fakeClient(),
        driver: d.driver,
        stickId: 's1',
        allowedImages: new Set([trooper, db]),
        images,
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(d.order).not.toContain('services');
    expect(d.order).not.toContain('trooper');
    endSweep();
    await Promise.all([sweep, run]);
    expect(d.order).toContain('trooper');
    const records = JSON.parse(readFileSync(join(stateDir, IMAGES_FILE), 'utf8'));
    expect(records[trooper].lastUsedAt).toBe('2026-11-19T00:00:00.000Z');
    expect(records[db].lastUsedAt).toBe('2026-11-19T00:00:00.000Z');
  });
});

describe('images a drop holds until it ends (issue #439)', () => {
  const done = 'JM_RESULT {"status":"completed","gates":[]}';
  const PG = 'ghcr.io/o/pg';
  const P1 = `${PG}@sha256:${'1'.repeat(64)}`;
  const P2 = `${PG}@sha256:${'2'.repeat(64)}`;
  const P3 = `${PG}@sha256:${'3'.repeat(64)}`;
  const day = (n: number) => new Date(Date.UTC(2026, 10, n)).toISOString();
  /**
   * Three recorded pg digests (P1 the least recently used), P1 on the engine, and the server
   * serving a release trooper image not loaded yet. A service start from a removed image fails,
   * as the engine's would.
   */
  function world() {
    const r = release();
    const stateDir = mkdtempSync(join(tmpdir(), 'jm-images-'));
    writeFileSync(
      join(stateDir, IMAGES_FILE),
      JSON.stringify(
        Object.fromEntries(
          [P1, P2, P3].map((ref, i) => [ref, { repository: PG, lastUsedAt: day(i + 1) }]),
        ),
      ),
    );
    const d = fakeDriver([done], {
      imageIds: { [P1]: 'sha256:id-1', [P2]: 'sha256:id-2', [P3]: 'sha256:id-3' },
    });
    const startServices = d.driver.startServices.bind(d.driver);
    d.driver.startServices = async (...args: Parameters<typeof startServices>) => {
      for (const svc of args[2])
        if (d.gc.includes(`remove ${svc.image}`)) throw new Error(`image ${svc.image} is missing`);
      return startServices(...args);
    };
    const clock = { day: 19 };
    const images = new StickImages({
      driver: d.driver,
      stateDir,
      keep: [],
      log: () => {},
      now: () => new Date(day(clock.day)),
    });
    const loaded = new Set<string>();
    const deps: ServerImageDeps = {
      client: {
        async imageLayout() {
          return new Response(tar(r.entries), { status: 200 });
        },
        async reportImageFetch() {},
      },
      loader: {
        async imageExists(ref) {
          return ref === P1 || loaded.has(ref);
        },
        async loadImage(t) {
          for await (const _ of t);
          loaded.add(r.ref);
          return [r.configDigest];
        },
        async removeImage() {},
        async tagImage() {},
      },
      stateDir,
      platform: 'linux/amd64',
      log: () => {},
      images,
    };
    const trust: ImageTrust = {
      policy: 'allowlist',
      allowed: new Set([P1, r.ref, 'jumpmaster-trooper:test']),
      server: { source: () => 'server', deps },
    };
    return { r, d, images, trust, stateDir, clock };
  }
  const db = { name: 'db', image: P1, port: 5432, readyTimeoutSeconds: 60 };

  test("a present service image survives the sweep the drop's own trooper load starts", async () => {
    const { r, d, images, trust } = world();
    const client = fakeClient();
    await runDrop(
      { ...payload, image: r.ref, services: [db] },
      { client, driver: d.driver, stickId: 's1', trust, images },
    );
    await images.idle();
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(d.order).toContain('services');
    expect(d.order).toContain('trooper');
    // The load did start a sweep; it left the drop's service image alone.
    expect(d.gc).toContain('containers');
    expect(d.gc).not.toContain(`remove ${P1}`);
  });

  test("another drop's load does not sweep the image a running drop found present; its end releases it", async () => {
    const { r, d, images, trust, stateDir, clock } = world();
    // The first drop stops after its images are ready and before any container starts.
    let reached: () => void = () => {};
    const paused = new Promise<void>((res) => {
      reached = res;
    });
    let resume: () => void = () => {};
    const gate = new Promise<void>((res) => {
      resume = res;
    });
    const labels = d.driver.imageLabels.bind(d.driver);
    d.driver.imageLabels = async (image: string) => {
      if (image === 'jumpmaster-trooper:test') {
        reached();
        await gate;
      }
      return labels(image);
    };
    const first = fakeClient();
    const one = runDrop(
      { ...payload, services: [db] },
      { client: first, driver: d.driver, stickId: 's1', trust, images },
    );
    await paused;
    const second = fakeClient();
    await runDrop(
      { ...payload, dropId: 'd2', image: r.ref },
      { client: second, driver: d.driver, stickId: 's1', trust, images },
    );
    await images.idle();
    expect(second.result).toMatchObject({ status: 'completed' });
    expect(d.gc).toContain('containers');
    expect(d.gc).not.toContain(`remove ${P1}`);
    resume();
    await one;
    expect(first.result).toMatchObject({ status: 'completed' });
    expect(d.order).toContain('services');
    // The drop has ended. Once P2 and P3 are used again, P1 is beyond the two newest and no
    // container uses it: the next sweep removes it.
    clock.day = 20;
    images.used(P2);
    images.used(P3);
    expect((await images.sweep()).removed).toContain(P1);
    const records = JSON.parse(readFileSync(join(stateDir, IMAGES_FILE), 'utf8'));
    expect(Object.keys(records)).not.toContain(P1);
  });

  test('a drop that fails before any container starts releases what it held', async () => {
    const { d, images, trust } = world();
    const client = fakeClient();
    d.driver.imageLabels = async () => {
      throw new Error('inspect failed');
    };
    await runDrop(
      { ...payload, services: [db] },
      { client, driver: d.driver, stickId: 's1', trust, images },
    );
    expect(client.result).toMatchObject({ status: 'failed' });
    expect(d.order).not.toContain('services');
    expect((await images.sweep()).removed).toEqual([P1]);
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

describe('events sent in parts', () => {
  const RESULT =
    'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}';
  const TS = '2026-11-16T10:00:00.000Z';
  let ids = 0;
  const lines = (kind: TrooperEvent['kind'], data: Record<string, unknown>) =>
    eventLines(kind, data, [TOKEN], { ts: TS, id: () => ++ids });
  const run = async (out: string[]) => {
    const client = fakeClient();
    await runDrop(payload, {
      client,
      driver: fakeDriver([...out, RESULT]).driver,
      heartbeatMs: 1000,
      stickId: 's1',
    });
    return client;
  };

  test('a 300 KB event is stored byte-identical to what the trooper serialized', async () => {
    const data = { text: `${'é'.repeat(50_000)}${'w'.repeat(200_000)}`, tool: 'Read' };
    const out = lines('agent', data);
    expect(out).toHaveLength(7);
    const client = await run(out);
    const stored = client.events.flat();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0])).toBe(JSON.stringify({ ts: TS, kind: 'agent', data }));
    expect(stored[0]?.data).not.toHaveProperty('truncated');
    // Over 256 KB but under 1 MiB: batched as usual.
    expect(client.result).toMatchObject({ status: 'completed' });
  });

  test('a 3 MB event keeps its first 2 MiB, flagged with its size', async () => {
    const data = { text: 'v'.repeat(3_000_000) };
    const client = await run(lines('agent', data));
    const [ev] = client.events.flat();
    expect(ev?.data).toMatchObject({ truncated: true, bytes: 3_000_011 });
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeGreaterThan(2 * 1024 * 1024 - 1024);
  });

  test('a secret is redacted in the stored event', async () => {
    const data = { text: `${'a'.repeat(46_000)}${TOKEN}${'b'.repeat(100_000)}` };
    const client = await run(lines('agent', data));
    const stored = JSON.stringify(client.events.flat());
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain('[REDACTED]');
  });

  test('order is kept between assembled and single-line events', async () => {
    const big = lines('agent', { text: 'c'.repeat(150_000) });
    const out = [
      ...lines('phase', { phase: 'clone' }),
      big[0] as string,
      ...lines('phase', { phase: 'claude' }),
      ...big.slice(1, -1),
      ...lines('agent', { text: 'small' }),
      big.at(-1) as string,
      ...lines('phase', { phase: 'gates' }),
    ];
    const client = await run(out);
    expect(client.events.flat().map((e) => e.data.phase ?? e.data.text)).toEqual([
      'clone',
      'claude',
      'small',
      'c'.repeat(150_000),
      'gates',
    ]);
  });

  test('parts out of order are assembled', async () => {
    const out = lines('agent', { text: 'o'.repeat(200_000) });
    const client = await run(out.toReversed());
    expect(client.events.flat()).toEqual([
      { ts: TS, kind: 'agent', data: { text: 'o'.repeat(200_000) } },
    ]);
  });

  test('D5: an assembled egress event from the trooper is dropped, like a single line', async () => {
    const out = [
      ...lines('egress', { host: 'forged.test', decision: 'allow', pad: 'p'.repeat(100_000) }),
      ...lines('egress', { host: 'forged-small.test', decision: 'allow' }),
      ...lines('phase', { phase: 'clone' }),
    ];
    expect(out.length).toBeGreaterThan(3);
    const client = await run(out);
    expect(client.events.flat().map((e) => e.kind)).toEqual(['phase']);
  });

  test('the trooper killed after part 3 of 7: no event, one log naming the parts', async () => {
    const out = lines('agent', { text: 'k'.repeat(300_000) });
    expect(out).toHaveLength(7);
    const id = JSON.parse((out[0] as string).slice('JM_EVENT_PART '.length)).id;
    const client = await run(out.slice(0, 3));
    const stored = client.events.flat();
    expect(stored).toEqual([
      {
        ts: expect.any(String),
        kind: 'log',
        data: { message: `event ${id} incomplete: 3 of 7 parts` },
      },
    ]);
  });

  test('an event over 1 MiB is posted in a batch of its own', async () => {
    const out = [
      ...lines('phase', { phase: 'clone' }),
      ...lines('agent', { text: 'm'.repeat(1_200_000) }),
      ...lines('phase', { phase: 'gates' }),
    ];
    const client = await run(out);
    expect(client.events.map((b) => b.map((e) => e.kind))).toEqual([
      ['phase'],
      ['agent'],
      ['phase'],
    ]);
  });
});

describe('runDrop', () => {
  test('relays events and posts the result', async () => {
    const d = fakeDriver([
      'JM_EVENT {"ts":"t","kind":"phase","data":{"phase":"clone"}}',
      'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}',
    ]);
    const client = fakeClient();
    await runDrop(payload, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.events.flat()).toHaveLength(1);
    expect(client.result).toMatchObject({
      status: 'completed',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
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

  test('drop-start is logged before an early refusal, and a doctor drop logs no forgeToken or read token', async () => {
    const refused: string[] = [];
    await runDrop(
      { ...payload, image: 'evil/trooper:1' },
      {
        client: fakeClient(),
        driver: fakeDriver([]).driver,
        stickId: 's1',
        allowedImages: new Set(['jumpmaster-trooper:dev']),
        log: (l) => refused.push(l),
      },
    );
    expect(JSON.parse(refused[0] as string)).toMatchObject({
      event: 'drop-start',
      dropId: payload.dropId,
    });
    const read = 'read-token-value-0987654321';
    const doctor = DropPayloadSchema.parse({
      protocol: 1,
      dropId: 'd2',
      epoch: 1,
      role: 'doctor',
      repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
      model: 'm',
      image: 'jumpmaster-trooper:test',
      gates: [{ name: 'lint', run: 'npm run lint', timeoutMinutes: 5 }],
      credentials: { claudeToken: TOKEN, readToken: read },
    });
    const logged: string[] = [];
    await runDrop(doctor, {
      client: fakeClient(),
      driver: fakeDriver([], { exitCode: 1 }).driver,
      heartbeatMs: 10,
      stickId: 's1',
      log: (l) => logged.push(l),
    });
    expect(logged.map((l) => JSON.parse(l)).find((l) => l.event === 'drop-start')).toEqual({
      event: 'drop-start',
      dropId: 'd2',
      role: 'doctor',
      gates: [{ name: 'lint', timeoutMinutes: 5 }],
    });
    for (const l of logged) expect(l).not.toContain(read);
  });

  test('a stderr tail containing the read token is redacted in noResultReason', async () => {
    const read = 'read-token-value-1234567890';
    const doctor = DropPayloadSchema.parse({
      protocol: 1,
      dropId: 'd1',
      epoch: 3,
      role: 'doctor',
      repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
      model: 'm',
      image: 'jumpmaster-trooper:test',
      gates: [],
      credentials: { claudeToken: TOKEN, readToken: read },
    });
    const basic = Buffer.from(`x-access-token:${read}`).toString('base64');
    const d = fakeDriver([], { exitCode: 1, stderr: `fatal: clone with ${read} as ${basic}\n` });
    const client = fakeClient();
    await runDrop(doctor, { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
    expect(client.result).toEqual({
      status: 'failed',
      role: 'doctor',
      reason: 'trooper exited 1 without result: fatal: clone with [REDACTED] as [REDACTED]',
      gates: [],
    });
  });

  describe('a trooper image older than the role', () => {
    const doctor = () =>
      DropPayloadSchema.parse({
        protocol: 1,
        dropId: 'd1',
        epoch: 3,
        role: 'doctor',
        repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
        model: 'm',
        image: 'jumpmaster-trooper:test',
        gates: [],
        credentials: { claudeToken: TOKEN },
      });
    const stderrs = {
      // What a trooper with describeFatal prints when its schema has no such role.
      'one line': `payload rejected: role: Invalid discriminator value. Expected 'implement' | 'review' | 'heal'\n`,
      // An older trooper's raw ZodError: its message is the issues as indented JSON.
      'raw zod JSON': `ZodError: [\n  {\n    "code": "invalid_union",\n    "note": "No matching discriminator",\n    "path": [\n      "role"\n    ],\n    "message": "Invalid discriminator value. Expected 'implement' | 'review'"\n  }\n]\n    at x (y.js:1:1)\n\nNode.js v24.1.0\n`,
    };
    for (const [form, stderr] of Object.entries(stderrs))
      test(`says to rebuild the zone image on the current trooper (${form})`, async () => {
        const d = fakeDriver([], { exitCode: 1, stderr });
        const client = fakeClient();
        await runDrop(doctor(), { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
        const reason = client.result?.reason ?? '';
        expect(reason).toMatch(/^trooper exited 1 without result: /);
        expect(reason).toContain(
          "the zone's image jumpmaster-trooper:test is older than the doctor role",
        );
        expect(reason).toContain('rebuild the zone image on the current trooper');
        expect(reason).not.toContain('Invalid discriminator value');
      });

    test('a discriminator error on another path, with "role" elsewhere, keeps the trooper line', async () => {
      const stderr =
        "loading prompts/role.md\npayload rejected: egress.kind: Invalid discriminator value. Expected 'proxy'\n";
      const d = fakeDriver([], { exitCode: 1, stderr });
      const client = fakeClient();
      await runDrop(doctor(), { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
      expect(client.result?.reason).toBe(
        "trooper exited 1 without result: payload rejected: egress.kind: Invalid discriminator value. Expected 'proxy'",
      );
    });

    test('another payload rejection keeps the trooper line', async () => {
      const stderr = 'payload rejected: repo.owner: Invalid input\n';
      const d = fakeDriver([], { exitCode: 1, stderr });
      const client = fakeClient();
      await runDrop(doctor(), { client, driver: d.driver, heartbeatMs: 10, stickId: 's1' });
      expect(client.result?.reason).toBe(
        'trooper exited 1 without result: payload rejected: repo.owner: Invalid input',
      );
    });
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

  test('a stick that loses the server stops its drop, with a grace, after the limit', async () => {
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
    expect(beats).toBeGreaterThanOrEqual(3);
    expect(d.stopGrace).toBe(LOST_SERVER_GRACE_MS);
    expect(d.killed).toBe(false);
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
      // Assigning undefined would store the string "undefined", and every later tmpdir() would
      // point there (CI runners have no TMPDIR).
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
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
    const d = fakeDriver([
      'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}',
    ]);
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
    expect(posted[0]).toMatchObject({
      status: 'completed',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
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
    expect(await reapOrphans(driver, 's1')).toEqual({
      removed: ['mine-1', 'mine-2'],
      unconfirmed: [],
    });
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
    expect(await reapOrphans(driver, 's1')).toEqual({ removed: ['b'], unconfirmed: [] });
    expect(removed).toEqual(['b']);
  });

  test('each removal is confirmed; one the engine cannot confirm is reported', async () => {
    const confirmed: string[] = [];
    const driver: ContainerDriver = {
      ...fakeDriver([]).driver,
      async listByLabel() {
        return ['a', 'b'];
      },
      async removeAndWait(name) {
        if (name === 'a') throw new Error('container not removed');
        confirmed.push(name);
      },
    };
    expect(await reapOrphans(driver, 's1')).toEqual({ removed: ['b'], unconfirmed: ['a'] });
    expect(confirmed).toEqual(['b']);
  });

  test('reapOrphans never removes volumes', async () => {
    const d = fakeDriver([]);
    const driver: ContainerDriver = {
      ...d.driver,
      async listByLabel() {
        return ['a'];
      },
    };
    await reapOrphans(driver, 's1');
    expect(d.order.filter((o) => o.startsWith('removeVolume'))).toEqual([]);
  });
});

/** An engine holding volumes (by name, with labels), for the startup and sweep checks. */
function volumeWorld(
  vols: { name: string; labels: Record<string, string> }[],
  o: {
    probe?: { freeBytes: number; writable: boolean } | Error;
    initExit?: number;
    labels?: Record<string, string>;
    unremovable?: string[];
  } = {},
) {
  const d = fakeDriver([], o.labels ? { imageLabels: o.labels } : {});
  const volumes = new Map(vols.map((v) => [v.name, v.labels]));
  const log: string[] = [];
  const driver: ContainerDriver = {
    ...d.driver,
    async listVolumesByLabel(key, value) {
      return [...volumes]
        .filter(([, l]) => l[key] === value)
        .map(([name, labels]) => ({ name, labels }));
    },
    async createVolume(name, labels) {
      log.push(`createVolume ${name.replace(/-[0-9a-f]{8}$/, '')}`);
      volumes.set(name, labels);
    },
    async removeVolume(name) {
      log.push(`removeVolume ${name.replace(/-[0-9a-f]{8}$/, '')}`);
      volumes.delete(name);
    },
    async initVolume(i) {
      log.push(`init ${i.image} ${i.name.replace(/-[0-9a-f]{8}-init$/, '-init')}`);
      return o.initExit ?? 0;
    },
    async probeVolume(p) {
      log.push(`probe ${p.image} ${p.name.replace(/-[0-9a-f]{8}-probe$/, '-probe')}`);
      if (o.probe instanceof Error) throw o.probe;
      return o.probe ?? { freeBytes: 100 * 2 ** 30, writable: true };
    },
    async removeAndWait(name) {
      log.push(`removeAndWait ${name}`);
      if (o.unremovable?.includes(name)) throw new Error('container not removed');
    },
  };
  return { driver, volumes, log };
}

const dropVolume = (stick: string, drop: string, epoch: number) => ({
  name: `jm-drop-${drop}-${epoch}-0123abcd`,
  labels: {
    'jumpmaster.stick': stick,
    'jumpmaster.drop': drop,
    'jumpmaster.epoch': String(epoch),
    'jumpmaster.volume': '1',
  },
});

const mirrorVolume = (stick: string, drop: string, epoch: number) => ({
  name: `jm-mirror-${drop}-${epoch}-0123abcd`,
  labels: {
    'jumpmaster.stick': stick,
    'jumpmaster.drop': drop,
    'jumpmaster.epoch': String(epoch),
    'jumpmaster.mirror': '1',
  },
});

function salvager(replies: Record<string, 'ok' | 'refused' | Error>) {
  const asked: string[] = [];
  return {
    asked,
    async salvage(dropId: string, epoch: number): Promise<'ok' | 'refused'> {
      asked.push(`${dropId}:${epoch}`);
      const r = replies[dropId] ?? 'refused';
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

describe('volume self-check', () => {
  test('a passing self-check measures free space on a fresh volume, then removes it', async () => {
    const w = volumeWorld([], { probe: { freeBytes: 42 * 2 ** 30, writable: true } });
    expect(await volumeSelfCheck(w.driver, 'trooper@x', 's1')).toEqual({
      selfCheck: true,
      freeBytes: 42 * 2 ** 30,
      clone: false,
    });
    expect(w.log).toEqual([
      'createVolume jm-selfcheck-s1',
      'init trooper@x jm-selfcheck-s1-init',
      'probe trooper@x jm-selfcheck-s1-probe',
      'removeVolume jm-selfcheck-s1',
    ]);
    expect(w.volumes.size).toBe(0);
  });

  test('is withdrawn when a later sweep fails', async () => {
    // A failed init, an unwritable volume or an image without the push label: no pass.
    for (const o of [
      { initExit: 1 },
      { probe: { freeBytes: 100 * 2 ** 30, writable: false } },
      { labels: {} },
    ]) {
      const w = volumeWorld([], o);
      const h = await volumeSelfCheck(w.driver, 'trooper@x', 's1');
      expect(h.selfCheck, JSON.stringify(o)).toBe(false);
      expect(w.volumes.size).toBe(0);
    }
    // A measurement that fails is below the floor (null), and never throws.
    const broken = volumeWorld([], { probe: new Error('no stat') });
    expect(await volumeSelfCheck(broken.driver, 'trooper@x', 's1')).toEqual({
      selfCheck: false,
      freeBytes: null,
      clone: false,
    });
    const dead: ContainerDriver = {
      ...broken.driver,
      async createVolume() {
        throw new Error('engine down');
      },
    };
    expect(await volumeSelfCheck(dead, 'trooper@x', 's1')).toEqual({
      selfCheck: false,
      freeBytes: null,
      clone: false,
    });
  });
});

describe('rediscovery', () => {
  test('rediscovers a pending push whose push container died with the stick', async () => {
    // The stick died mid-push: its push container was reaped, its volume is still there.
    const w = volumeWorld([dropVolume('s1', 'd7', 4), dropVolume('s2', 'other', 1)]);
    const client = salvager({ d7: 'ok' });
    const pending = new PendingPushes();
    await rediscoverPending(w.driver, client, 's1', pending, () => {});
    expect(client.asked).toEqual(['d7:4']);
    expect(pending.get('d7')).toMatchObject({
      dropId: 'd7',
      epoch: 4,
      volume: 'jm-drop-d7-4-0123abcd',
      attempts: 0,
    });
    // No entry before both containers that could hold the volume are confirmed gone.
    expect(w.log).toEqual([
      'removeAndWait jumpmaster-drop-d7-4',
      'removeAndWait jumpmaster-push-d7-4',
    ]);
    expect(w.volumes.has('jm-drop-d7-4-0123abcd')).toBe(true);
  });

  test('rediscovery never salvages, keeps or removes a mirror volume', async () => {
    const w = volumeWorld([mirrorVolume('s1', 'd7', 4), mirrorVolume('s1', 'd8', 2)]);
    const client = salvager({ d7: 'ok' });
    const pending = new PendingPushes();
    await rediscoverPending(w.driver, client, 's1', pending, () => {});
    expect(client.asked).toEqual([]);
    expect(pending.size()).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.volumes.size).toBe(2);
  });

  test('a refused rediscovery removes the volume', async () => {
    const w = volumeWorld([dropVolume('s1', 'd7', 4)]);
    const pending = new PendingPushes();
    await rediscoverPending(w.driver, salvager({ d7: 'refused' }), 's1', pending, () => {});
    expect(pending.size()).toBe(0);
    expect(w.volumes.size).toBe(0);
    expect(w.log.at(-1)).toBe('removeVolume jm-drop-d7-4');
  });

  test('an unanswered salvage or an unconfirmed container keeps the volume, with no entry', async () => {
    const w = volumeWorld([dropVolume('s1', 'd7', 4), dropVolume('s1', 'd8', 2)], {
      unremovable: ['jumpmaster-drop-d8-2'],
    });
    const client = salvager({ d7: new Error('server down'), d8: 'ok' });
    const pending = new PendingPushes();
    await rediscoverPending(w.driver, client, 's1', pending, () => {});
    expect(pending.size()).toBe(0);
    // d8's agent container was never confirmed gone: the server is not even asked.
    expect(client.asked).toEqual(['d7:4']);
    expect(w.volumes.size).toBe(2);
  });
});

describe('startup recovery and health', () => {
  test('an unconfirmed orphan blocks only its own drop: other volumes are still rediscovered', async () => {
    const w = volumeWorld([dropVolume('s1', 'd7', 4), dropVolume('s1', 'd8', 2)], {
      unremovable: ['orphan-x', 'jumpmaster-drop-d8-2'],
    });
    const driver: ContainerDriver = {
      ...w.driver,
      async listByLabel() {
        return ['orphan-x'];
      },
    };
    const client = salvager({ d7: 'ok', d8: 'ok' });
    const pending = new PendingPushes();
    const reaped = await recoverAtStartup(driver, client, 's1', pending, () => {});
    expect(reaped.unconfirmed).toEqual(['orphan-x']);
    expect(pending.get('d7')?.volume).toBe('jm-drop-d7-4-0123abcd');
    expect(pending.get('d8')).toBeUndefined();
    expect(client.asked).toEqual(['d7:4']);
    // The reap ran first.
    expect(w.log[0]).toBe('removeAndWait orphan-x');
  });

  test('a base image that fails verification withholds push-v1 and runs nothing from it', async () => {
    const w = volumeWorld([]);
    const log: string[] = [];
    const refused = await stickHealth(w.driver, {
      image: 'jumpmaster-trooper:dev',
      stickId: 's1',
      trust: { policy: 'allowlist', allowed: new Set(['other:1']) },
      log: (l) => log.push(l),
    });
    expect(refused).toEqual({
      selfCheck: false,
      freeBytes: null,
      clone: false,
      base: {
        ok: false,
        reason: 'base image jumpmaster-trooper:dev: image not allowed: jumpmaster-trooper:dev',
      },
    });
    expect(w.log).toEqual([]);
    expect(log.join('\n')).toMatch(/push-v1 withheld/);
    // Fixed (here: now allowed), the next check recovers.
    const fixed = await stickHealth(w.driver, {
      image: 'jumpmaster-trooper:dev',
      stickId: 's1',
      trust: { policy: 'allowlist', allowed: new Set(['jumpmaster-trooper:dev']) },
      log: () => {},
    });
    expect(fixed).toEqual({
      selfCheck: true,
      freeBytes: 100 * 2 ** 30,
      clone: false,
      base: { ok: true },
    });
  });

  test('the health records the clone label from the base image, and none from a refused one', async () => {
    const CURRENT = {
      'org.jumpmaster.trooper.push': '1',
      'org.jumpmaster.trooper.clone': '1',
    };
    const trusted = { policy: 'allowlist' as const, allowed: new Set(['jumpmaster-trooper:dev']) };
    const o = { image: 'jumpmaster-trooper:dev', stickId: 's1', log: () => {} };
    const w = volumeWorld([], { labels: CURRENT });
    expect(await stickHealth(w.driver, { ...o, trust: trusted })).toEqual({
      selfCheck: true,
      freeBytes: 100 * 2 ** 30,
      clone: true,
      base: { ok: true },
    });
    // The same inspection as the push label: the image is read once.
    const inspected: string[] = [];
    const counting: ContainerDriver = {
      ...w.driver,
      async imageLabels(i) {
        inspected.push(i);
        return CURRENT;
      },
    };
    await volumeSelfCheck(counting, 'trooper@x', 's1');
    expect(inspected).toEqual(['trooper@x']);
    // A wrong value is no label.
    const old = volumeWorld([], { labels: { ...CURRENT, 'org.jumpmaster.trooper.clone': '2' } });
    expect((await stickHealth(old.driver, { ...o, trust: trusted })).clone).toBe(false);
    // A refused base image reads as not carrying it, and nothing is inspected.
    const refusedWorld = volumeWorld([], { labels: CURRENT });
    const refused = await stickHealth(refusedWorld.driver, {
      ...o,
      trust: { policy: 'allowlist', allowed: new Set(['other:1']) },
    });
    expect(refused.clone).toBe(false);
    expect(refused.base.ok).toBe(false);
    // Before the first check: no clone label.
    const monitor = new HealthMonitor(w.driver, { ...o, trust: trusted });
    expect(monitor.latest().clone).toBe(false);
    await monitor.check();
    expect(monitor.latest().clone).toBe(true);
  });

  test('a sweep never removes the volume of a self-check in flight', async () => {
    const w = volumeWorld([]);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // The probe waits until the sweep has run, as a floor-wait check racing a sweep would.
    const driver: ContainerDriver = {
      ...w.driver,
      async probeVolume(p) {
        await held;
        if (![...w.volumes.keys()].some((n) => n.startsWith('jm-selfcheck-')))
          throw new Error('volume gone');
        return w.driver.probeVolume(p);
      },
    };
    const monitor = new HealthMonitor(driver, {
      image: 'jumpmaster-trooper:dev',
      stickId: 's1',
      trust: { policy: 'allowlist', allowed: new Set(['jumpmaster-trooper:dev']) },
      log: () => {},
    });
    const check = monitor.check();
    await new Promise((r) => setTimeout(r, 5));
    expect(monitor.busy()).toBe(true);
    await sweepVolumes(driver, salvager({}), 's1', new PendingPushes(), new Set(), () => {}, {
      selfCheckBusy: () => monitor.busy(),
    });
    release();
    expect(await check).toMatchObject({ selfCheck: true, freeBytes: 100 * 2 ** 30 });
    expect(monitor.latest().freeBytes).toBe(100 * 2 ** 30);
    expect(monitor.busy()).toBe(false);
    // With no check in flight, a leaked self-check volume goes.
    w.volumes.set('jm-selfcheck-s1-deadbeef', {
      'jumpmaster.stick': 's1',
      'jumpmaster.selfcheck': '1',
    });
    await sweepVolumes(driver, salvager({}), 's1', new PendingPushes(), new Set(), () => {}, {
      selfCheckBusy: () => monitor.busy(),
    });
    expect(w.volumes.size).toBe(0);
  });
});

describe('the sweep', () => {
  test('the sweep keeps live and pending volumes and networks', async () => {
    const w = volumeWorld([
      dropVolume('s1', 'live', 1),
      dropVolume('s1', 'queued', 3),
      dropVolume('s1', 'stray', 2),
      dropVolume('s2', 'theirs', 1),
      {
        name: 'jm-selfcheck-s1-0123abcd',
        labels: { 'jumpmaster.stick': 's1', 'jumpmaster.selfcheck': '1' },
      },
    ]);
    const pending = new PendingPushes();
    pending.add('queued', { epoch: 3, volume: 'jm-drop-queued-3-0123abcd' });
    const client = salvager({});
    await sweepVolumes(w.driver, client, 's1', pending, new Set(['live:1']), () => {});
    expect([...w.volumes.keys()].sort()).toEqual([
      'jm-drop-live-1-0123abcd',
      'jm-drop-queued-3-0123abcd',
      'jm-drop-theirs-1-0123abcd',
    ]);
    // Only the stray volume was asked about (and refused); a leaked self-check volume just goes.
    expect(client.asked).toEqual(['stray:2']);
    // Networks: a live drop's and a pending push's stay, the rest go.
    const nets = fakeDriver([], {
      networks: [
        { name: 'jm-drop-live-1', labels: { 'jumpmaster.drop': 'live', 'jumpmaster.epoch': '1' } },
        {
          name: 'jm-push-queued-3',
          labels: { 'jumpmaster.drop': 'queued', 'jumpmaster.epoch': '3' },
        },
        {
          name: 'jm-push-stray-2',
          labels: { 'jumpmaster.drop': 'stray', 'jumpmaster.epoch': '2' },
        },
      ],
    });
    const n = await sweepDropNetworks(
      nets.driver,
      's1',
      new Set(['jm-drop-live-1', ...pending.networks()]),
    );
    expect(n).toBe(1);
    expect(nets.removedNetworks).toEqual(['jm-push-stray-2']);
  });

  test('the sweep removes dead mirror volumes and keeps live ones, with no salvage', async () => {
    const w = volumeWorld([
      mirrorVolume('s1', 'live', 1),
      mirrorVolume('s1', 'dead', 2),
      // The live drop's other epoch is dead.
      mirrorVolume('s1', 'live', 0),
      mirrorVolume('s2', 'theirs', 1),
    ]);
    const client = salvager({ dead: 'ok', live: 'ok' });
    const pending = new PendingPushes();
    await sweepVolumes(w.driver, client, 's1', pending, new Set(['live:1']), () => {});
    expect([...w.volumes.keys()].sort()).toEqual([
      'jm-mirror-live-1-0123abcd',
      'jm-mirror-theirs-1-0123abcd',
    ]);
    expect(client.asked).toEqual([]);
    expect(pending.size()).toBe(0);
  });

  test('a live drop keeps both its repo and its mirror volume', async () => {
    const w = volumeWorld([dropVolume('s1', 'live', 1), mirrorVolume('s1', 'live', 1)]);
    const client = salvager({});
    await sweepVolumes(w.driver, client, 's1', new PendingPushes(), new Set(['live:1']), () => {});
    expect(w.volumes.size).toBe(2);
    expect(w.log).toEqual([]);
    expect(client.asked).toEqual([]);
  });

  test("a pending push keeps its repo volume while the drop's dead mirror goes", async () => {
    const w = volumeWorld([dropVolume('s1', 'queued', 3), mirrorVolume('s1', 'queued', 3)]);
    const pending = new PendingPushes();
    pending.add('queued', { epoch: 3, volume: 'jm-drop-queued-3-0123abcd' });
    const client = salvager({});
    await sweepVolumes(w.driver, client, 's1', pending, new Set(), () => {});
    expect([...w.volumes.keys()]).toEqual(['jm-drop-queued-3-0123abcd']);
    expect(client.asked).toEqual([]);
    expect(pending.get('queued')?.volume).toBe('jm-drop-queued-3-0123abcd');
  });

  test('a failed mirror removal does not throw and is retried by the next sweep', async () => {
    const w = volumeWorld([mirrorVolume('s1', 'dead', 2)]);
    let fail = true;
    const driver: ContainerDriver = {
      ...w.driver,
      async removeVolume(name) {
        if (fail) throw new Error('volume is in use');
        return w.driver.removeVolume(name);
      },
    };
    const client = salvager({});
    await expect(
      sweepVolumes(driver, client, 's1', new PendingPushes(), new Set(), () => {}),
    ).resolves.toBeUndefined();
    expect(w.volumes.size).toBe(1);
    fail = false;
    await sweepVolumes(driver, client, 's1', new PendingPushes(), new Set(), () => {});
    expect(w.volumes.size).toBe(0);
    expect(client.asked).toEqual([]);
  });

  test('a stray volume the server salvages joins the pending pushes', async () => {
    const w = volumeWorld([dropVolume('s1', 'kept', 5)]);
    const pending = new PendingPushes();
    await sweepVolumes(w.driver, salvager({ kept: 'ok' }), 's1', pending, new Set(), () => {});
    expect(pending.get('kept')?.volume).toBe('jm-drop-kept-5-0123abcd');
    expect(w.volumes.size).toBe(1);
  });
});

describe('egress', () => {
  const done =
    'JM_RESULT {"status":"completed","headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gates":[]}';
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
    expect(d.order).toEqual([...VOLUME_START, 'trooper', ...VOLUME_END]);
  });

  test('a payload whose egress lists a private host starts a proxy with JM_EGRESS_PRIVATE', async () => {
    const d = fakeDriver([done]);
    const client = fakeClient();
    const egress = {
      mode: 'enforce' as const,
      allow: ['api.anthropic.com', 'github.com', 'gitlab.internal.example'],
      private: ['gitlab.internal.example'],
    };
    await runDrop({ ...enforce, egress }, { ...deps(d, client), ceiling: null });
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(d.proxy?.env).toEqual({
      JM_EGRESS_MODE: 'enforce',
      JM_EGRESS_ALLOW: 'api.anthropic.com,github.com,gitlab.internal.example',
      JM_EGRESS_BIND: '172.30.0.18',
      JM_EGRESS_PRIVATE: 'gitlab.internal.example',
    });
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
    expect(d.order).toEqual([
      ...VOLUME_START,
      'network',
      'proxy',
      'services',
      'trooper',
      'proxy-stop',
      'teardown',
      ...VOLUME_END,
    ]);
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
    expect(d.order).toEqual([
      ...VOLUME_START,
      'network',
      'proxy',
      'trooper',
      'proxy-stop',
      'teardown',
      ...VOLUME_END,
    ]);
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
      expect(d.order).toEqual([
        ...VOLUME_START,
        'network',
        'proxy',
        'trooper',
        'proxy-stop',
        'teardown',
        ...VOLUME_END,
      ]);
    });

    test('egress off never checks egress support: an image without it still runs', async () => {
      const d = fakeDriver([done], { imageLabels: { 'org.jumpmaster.trooper.push': '1' } });
      const client = fakeClient();
      await runDrop({ ...payload, image: 'trooper' }, deps(d, client));
      expect(d.inspected).toEqual(['trooper']); // for push support only
      expect(client.result).toMatchObject({ status: 'completed' });
      expect(d.order).toEqual([...VOLUME_START, 'trooper', ...VOLUME_END]);
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
  /**
   * A cosign that verifies exactly the digests in `good`, recording what it was asked; each
   * signature's certificate names release tag `tags[digest]`, else v0.4.0-rc.2.
   */
  const cosignFor = (good: string[], calls: string[] = [], tags: Record<string, string> = {}) => {
    const cosign: Cosign = async (args) => {
      const ref = args.at(-1) as string;
      calls.push(ref);
      const digest = ref.split('@')[1] as string;
      if (!good.includes(digest))
        return { code: 10, stdout: '', stderr: 'Error: no signatures found' };
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            critical: { image: { 'docker-manifest-digest': digest } },
            optional: {
              Subject: `https://github.com/x-a-n-d-e-r-k/jumpmaster/.github/workflows/release.yml@refs/tags/${tags[digest] ?? 'v0.4.0-rc.2'}`,
            },
          },
        ]),
        stderr: '',
      };
    };
    return { cosign, calls };
  };
  const trust = (cosign: Cosign, allowed: string[] = []): ImageTrust => ({
    policy: 'signed',
    allowed: new Set(allowed),
    signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
    cosign,
    cache: new VerifyCache(
      join(mkdtempSync(join(tmpdir(), 'jm-trust-')), 'verified.json'),
      releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
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
      ...VOLUME_START,
      'network',
      'proxy',
      'services',
      'trooper',
      'proxy-stop',
      'teardown',
      ...VOLUME_END,
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

  test('runDrop logs the gates with their timeouts and the forge token fingerprint, never the token', async () => {
    const d = fakeDriver([done], { present: () => false });
    const c = cosignFor([dg('1'), dg('2'), dg('3')], d.order);
    const log: string[] = [];
    // A changed timeout (7, not the default 20) is what the operator looks for.
    const p = {
      ...signedPayload,
      gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 7 }],
    } as typeof signedPayload & {
      gates: { name: string; timeoutMinutes: number }[];
      credentials: { forgeToken?: string };
    };
    const token = p.credentials.forgeToken as string;
    expect(token).toBeTruthy();
    await runDrop(p, deps(d, trust(c.cosign), fakeClient(), log));
    // One line an operator reads with docker compose logs stick: the gate timeouts this drop runs
    // with, and which token it carries, in the 8-character form Settings shows.
    expect(log.map((l) => JSON.parse(l)).find((l) => l.event === 'drop-start')).toEqual({
      event: 'drop-start',
      dropId: 'd1',
      role: signedPayload.role,
      gates: p.gates.map((g) => ({ name: g.name, timeoutMinutes: g.timeoutMinutes })),
      forgeToken: createHash('sha256').update(token).digest('hex').slice(0, 8),
    });
    for (const l of log) expect(l).not.toContain(token);
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

  test.each([
    ['trooper', dg('1')],
    ['service', dg('3')],
  ])(
    'a %s image signed by an older release than this stick fails the drop, as any unverified image does (D5)',
    async (_n, old) => {
      const d = fakeDriver([done], { present: () => false });
      // The same old signature (v0.4.0-rc.1 on a 0.4.0-rc.2 stick), on the drop or a service image.
      const c = cosignFor([dg('1'), dg('2'), dg('3')], [], { [old]: 'v0.4.0-rc.1' });
      const client = fakeClient();
      await runDrop(signedPayload, deps(d, trust(c.cosign), client));
      expect(client.result).toMatchObject({ status: 'failed', role: 'implement', gates: [] });
      expect(client.result?.reason).toMatch(
        new RegExp(
          `^image not verified: \\S+@${old}: image signed for v0\\.4\\.0-rc\\.1, older than this stick \\(0\\.4\\.0-rc\\.2\\)$`,
        ),
      );
      expect(d.images).toEqual([]);
      expect(d.order).toEqual([]);
      expect(d.started).toBeUndefined();
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
    expect(d.order).toEqual([...VOLUME_START, 'trooper', ...VOLUME_END]);
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
    expect(e.order).toEqual([`pull ${pin}`, ...VOLUME_START, 'trooper', ...VOLUME_END]);
  });

  describe('the stick egress ceiling (JM_EGRESS_CEILING)', () => {
    const ceiling = ['api.anthropic.com', 'github.com', 'gitlab.example.com', 'registry.npmjs.org'];
    const covered: DropPayload = {
      ...signedPayload,
      egress: {
        mode: 'enforce',
        allow: ['api.anthropic.com', 'github.com', 'gitlab.example.com', 'registry.npmjs.org'],
      },
    };
    /** Runs `p` on a stick with `ceil`, recording every engine, cosign and base-image call. */
    const run = async (p: DropPayload, ceil: string[] | null) => {
      const d = fakeDriver([done], { present: () => false });
      const c = cosignFor([dg('1'), dg('2'), dg('3')], d.order);
      const client = fakeClient();
      let baseRead = 0;
      await runDrop(p, {
        ...deps(d, trust(c.cosign), client),
        ceiling: ceil,
        baseImage: () => {
          baseRead++;
          return { ok: true };
        },
      });
      return { d, client, baseRead };
    };
    const nothingStarted = (r: Awaited<ReturnType<typeof run>>) => {
      // No image verified (cosign calls land in order), pulled or inspected; no network, volume,
      // proxy, service or trooper.
      expect(r.d.order).toEqual([]);
      expect(r.d.images).toEqual([]);
      expect(r.d.inspected).toEqual([]);
      expect(r.d.net).toBeUndefined();
      expect(r.d.proxy).toBeUndefined();
      expect(r.d.services).toBeUndefined();
      expect(r.d.started).toBeUndefined();
      expect(r.baseRead).toBe(0);
    };

    test('an uncovered host fails the drop with the reason, and nothing is verified, pulled or started', async () => {
      const r = await run(
        {
          ...covered,
          egress: { mode: 'enforce', allow: [...covered.egress!.allow, 'evil.example.net'] },
        },
        ceiling,
      );
      expect(r.client.result).toMatchObject({ status: 'failed' });
      expect(r.client.result?.reason).toMatch(/JM_EGRESS_CEILING.*evil\.example\.net/);
      nothingStarted(r);
    });

    test.each([
      [
        'monitor',
        { ...covered, egress: { mode: 'monitor' as const, allow: covered.egress!.allow } },
        '"monitor"',
      ],
      ['no egress at all', { ...covered, egress: undefined }, '"off"'],
    ])('%s fails the drop the same way', async (_name, p, mode) => {
      const r = await run(p, ceiling);
      expect(r.client.result).toMatchObject({ status: 'failed' });
      expect(r.client.result?.reason).toContain(mode);
      nothingStarted(r);
    });

    test("a covered drop runs, and the proxy gets the payload's own list", async () => {
      const r = await run(covered, ceiling);
      expect(r.client.result).toMatchObject({ status: 'completed' });
      expect(r.d.proxy?.env).toMatchObject({
        JM_EGRESS_MODE: 'enforce',
        JM_EGRESS_ALLOW: 'api.anthropic.com,github.com,gitlab.example.com,registry.npmjs.org',
      });
    });

    test('without a ceiling a monitor drop runs as today', async () => {
      const r = await run(
        { ...covered, egress: { mode: 'monitor', allow: ['anything.example.net'] } },
        null,
      );
      expect(r.client.result).toMatchObject({ status: 'completed' });
      expect(r.d.proxy?.env).toMatchObject({ JM_EGRESS_MODE: 'monitor' });
    });
  });
});

describe('push containers: the agent run on a volume', () => {
  const SHA = 'c'.repeat(40);
  const PUSH_RESULT = `JM_RESULT ${JSON.stringify({
    status: 'completed',
    headSha: SHA,
    push: { kind: 'final', expectSha: SHA },
    gates: [],
  })}`;
  const AGENT = 'jumpmaster-drop-d1-3';
  const VOL = 'removeVolume jm-drop-d1-3';

  /** A pending-push queue that records, in the driver's order, when an entry is added. */
  function queue(order: string[]) {
    const pending = new PendingPushes();
    const add = pending.add.bind(pending);
    pending.add = (dropId, o, now) => {
      order.push(`add ${dropId}`);
      expect(o.volume).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
      add(dropId, o, now);
    };
    return pending;
  }

  const deps = (d: ReturnType<typeof fakeDriver>, client: ReturnType<typeof fakeClient>) => ({
    client,
    driver: d.driver,
    heartbeatMs: 5,
    stickId: 's1',
    trooperImage: 'trooper:base',
    pending: queue(d.order),
    resultRetryMs: 1,
  });

  test('a refused base image fails a pushing drop before anything starts from it', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    await runDrop(payload, {
      ...deps(d, client),
      baseImage: () => ({ ok: false, reason: 'base image trooper:base: image not allowed' }),
    });
    expect(d.order).toEqual([]);
    expect(d.started).toBeUndefined();
    expect(client.result).toMatchObject({
      status: 'failed',
      reason: 'base image trooper:base: image not allowed',
    });
  });

  test('the volume is prepared from the base image before the agent container, its only mount', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    await runDrop(payload, deps(d, fakeClient()));
    expect(d.order.slice(0, 3)).toEqual(['volume jm-drop-d1-3', 'init trooper:base', 'trooper']);
    expect(d.started?.image).toBe('jumpmaster-trooper:test');
    expect(d.started?.mount?.volume).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
    expect(d.started?.mount?.target).toBe('/home/agent/repo');
  });

  test('posts the push-requested result before any push container', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(client.result?.push).toEqual({ kind: 'final', expectSha: SHA });
    // runDrop starts only the agent container: the push loop owns the rest.
    expect(d.order.filter((x) => x === 'trooper')).toHaveLength(1);
    expect(o.pending.size()).toBe(1);
    expect(d.order).not.toContain(VOL);
  });

  test('starts the push container only after the agent container is removed', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const o = deps(d, fakeClient());
    await runDrop(payload, o);
    const removed = d.order.indexOf(`removeAndWait ${AGENT}`);
    expect(removed).toBeGreaterThan(-1);
    expect(d.order.indexOf('add d1')).toBeGreaterThan(removed);
  });

  test('an agent container that is not confirmed gone gets no entry and keeps its volume', async () => {
    const d = fakeDriver([PUSH_RESULT], { removeError: true });
    const o = deps(d, fakeClient());
    await runDrop(payload, o);
    expect(o.pending.size()).toBe(0);
    expect(d.order).not.toContain(VOL);
  });

  test('a result without push removes the volume', async () => {
    const d = fakeDriver(['JM_RESULT {"status":"no_changes","gates":[]}']);
    const o = deps(d, fakeClient());
    await runDrop(payload, o);
    expect(o.pending.size()).toBe(0);
    expect(d.order.indexOf(VOL)).toBeGreaterThan(d.order.indexOf(`removeAndWait ${AGENT}`));
  });

  test('holds the result in memory while the server is unreachable', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    let tries = 0;
    client.postResult = async (_d, _e, r) => {
      tries++;
      if (tries < 4) throw new Error('fetch failed');
      client.result = r;
      return 'ok';
    };
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(tries).toBe(4);
    expect(o.pending.size()).toBe(1);
  });

  test('a 409 on a held result triggers salvage, not removal', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    client.salvageReply = 'ok';
    client.postResult = async () => 'stale';
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(client.salvaged).toBe(1);
    expect(o.pending.size()).toBe(1);
    expect(d.order).not.toContain(VOL);

    // Refused: now the volume goes.
    const d2 = fakeDriver([PUSH_RESULT]);
    const refused = fakeClient();
    refused.postResult = async () => 'stale';
    const o2 = deps(d2, refused);
    await runDrop(payload, o2);
    expect(refused.salvaged).toBe(1);
    expect(o2.pending.size()).toBe(0);
    expect(d2.order).toContain(VOL);
  });

  test('a push request the server refuses (422) removes the volume', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    client.postResult = async () => {
      throw Object.assign(new Error('result failed: 422'), { status: 422 });
    };
    const o = deps(d, client);
    await expect(runDrop(payload, o)).rejects.toThrow('422');
    expect(client.salvaged).toBe(0);
    expect(o.pending.size()).toBe(0);
    expect(d.order).toContain(VOL);
  });

  test('lost server stops with a 60 s grace', async () => {
    expect(LOST_SERVER_GRACE_MS).toBe(60_000);
    const d = fakeDriver([], { hang: true });
    const client = fakeClient();
    client.heartbeat = async () => {
      throw new Error('network down');
    };
    await runDrop(payload, { ...deps(d, client), lostServerKillBeats: 3 });
    expect(d.stopped).toBe(true);
    expect(d.stopGrace).toBe(LOST_SERVER_GRACE_MS);
    expect(d.killed).toBe(false);
  });

  test('the server returns during the grace: no beat, no result, the volume kept', async () => {
    const d = fakeDriver([], { hang: true, stopDelayMs: 60 });
    const client = fakeClient();
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      if (beats <= 3) throw new Error('network down');
      return 'ok';
    };
    const o = deps(d, client);
    await runDrop(payload, { ...o, lostServerKillBeats: 3 });
    expect(d.stopGrace).toBe(LOST_SERVER_GRACE_MS);
    // The lease is never refreshed after the stop, and no synthetic failure is posted.
    expect(beats).toBe(3);
    expect(client.result).toBeUndefined();
    // The server's answer is unknown: the volume stays for rediscovery, with no entry.
    expect(o.pending.size()).toBe(0);
    expect(d.order).not.toContain(VOL);
  });

  test('a push result after a lost-server stop is still held and posted', async () => {
    const d = fakeDriver([PUSH_RESULT], { hang: true, stopDelayMs: 20 });
    const client = fakeClient();
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      throw new Error('network down');
    };
    const o = deps(d, client);
    await runDrop(payload, { ...o, lostServerKillBeats: 3 });
    expect(beats).toBe(3);
    expect(client.result?.push).toEqual({ kind: 'final', expectSha: SHA });
    expect(o.pending.size()).toBe(1);
  });

  test('hard cancel kills, then salvages', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('hard_cancel');
    client.salvageReply = 'ok';
    let salvagedAt = -1;
    const salvage = client.salvage.bind(client);
    client.salvage = async () => {
      salvagedAt = d.order.length;
      d.order.push('salvage');
      return salvage();
    };
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(d.killed).toBe(true);
    expect(d.stopped).toBe(false);
    expect(client.result).toBeUndefined();
    expect(salvagedAt).toBeGreaterThan(d.order.indexOf(`removeAndWait ${AGENT}`));
    expect(d.order.indexOf('add d1')).toBeGreaterThan(salvagedAt);
    expect(d.order).not.toContain(VOL);
  });

  test('salvage starts no push container until the killed agent container is removed', async () => {
    const d = fakeDriver([], { hang: true, removeError: true });
    const client = fakeClient('hard_cancel');
    client.salvageReply = 'ok';
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(d.killed).toBe(true);
    expect(o.pending.size()).toBe(0);
    expect(d.order).not.toContain(VOL);
  });

  test('a cancelled drop removes its volume without salvage', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('cancel');
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(client.salvaged).toBe(0);
    expect(o.pending.size()).toBe(0);
    expect(d.order.indexOf(VOL)).toBeGreaterThan(d.order.indexOf(`removeAndWait ${AGENT}`));
  });

  test('a stale drop asks to salvage its checkpointed volume after the agent is gone', async () => {
    const d = fakeDriver([], { hang: true });
    const client = fakeClient('stale');
    client.salvageReply = 'ok';
    let salvagedAt = -1;
    const salvage = client.salvage.bind(client);
    client.salvage = async () => {
      salvagedAt = d.order.length;
      d.order.push('salvage');
      return salvage();
    };
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(d.stopped).toBe(true);
    expect(client.result).toBeUndefined();
    expect(client.salvaged).toBe(1);
    expect(salvagedAt).toBeGreaterThan(d.order.indexOf(`removeAndWait ${AGENT}`));
    expect(d.order.indexOf('add d1')).toBeGreaterThan(salvagedAt);
    expect(d.order).not.toContain(VOL);

    // Refused (the item is no longer reclaimable): the volume goes.
    const d2 = fakeDriver([], { hang: true });
    const refused = fakeClient('stale');
    const o2 = deps(d2, refused);
    await runDrop(payload, o2);
    expect(refused.salvaged).toBe(1);
    expect(o2.pending.size()).toBe(0);
    expect(d2.order).toContain(VOL);
  });

  test('a held result gives up after HELD_RESULT_MAX_5XX server errors and keeps the volume', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    let tries = 0;
    client.postResult = async () => {
      tries++;
      throw Object.assign(new Error('result failed: 500'), { status: 500 });
    };
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      return 'ok';
    };
    const o = deps(d, client);
    await runDrop(payload, o);
    expect(tries).toBe(HELD_RESULT_MAX_5XX);
    expect(client.salvaged).toBe(0);
    expect(o.pending.size()).toBe(0);
    expect(d.order).not.toContain(VOL);
    // The lease is left to lapse: no beat after giving up.
    const after = beats;
    await new Promise((r) => setTimeout(r, 30));
    expect(beats).toBe(after);
  });

  test('network errors between server errors keep a held result going', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    let tries = 0;
    client.postResult = async (_d, _e, r) => {
      tries++;
      if (tries === 3 * HELD_RESULT_MAX_5XX) {
        client.result = r;
        return 'ok';
      }
      if (tries % 2 === 0) throw new Error('fetch failed');
      throw Object.assign(new Error('result failed: 503'), { status: 503 });
    };
    const o = { ...deps(d, client), resultRetryMs: 0 };
    await runDrop(payload, o);
    expect(tries).toBe(3 * HELD_RESULT_MAX_5XX);
    expect(o.pending.size()).toBe(1);
  });

  test('a pushing role from a server without push-v1 is never started and gets no result', async () => {
    const d = fakeDriver([PUSH_RESULT]);
    const client = fakeClient();
    client.features = new Set();
    let beats = 0;
    client.heartbeat = async () => {
      beats++;
      return 'ok';
    };
    const lines: string[] = [];
    await runDrop(payload, { ...deps(d, client), log: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 20));
    expect(d.order).toEqual([]);
    expect(client.result).toBeUndefined();
    expect(beats).toBe(0);
    expect(lines).toContain('server too old for push containers: deploy the server first');
  });

  test('a non-pushing role runs on a server without push-v1, with no volume', async () => {
    const review = DropPayloadSchema.parse({
      ...payload,
      role: 'review',
      pr: { number: 2, branch: 'agent/issue-1', headSha: 'a'.repeat(40) },
    });
    const d = fakeDriver(['JM_RESULT {"status":"completed","gates":[]}']);
    const client = fakeClient();
    client.features = new Set();
    await runDrop(review, deps(d, client));
    expect(d.order).toEqual(['trooper']);
    expect(d.started?.mount).toBeUndefined();
    expect(client.result?.status).toBe('completed');
  });

  test('refuses an image without the push label', async () => {
    const d = fakeDriver([PUSH_RESULT], {
      imageLabels: { 'org.jumpmaster.trooper.egress': '1' },
    });
    const client = fakeClient();
    await runDrop(payload, deps(d, client));
    expect(client.result).toMatchObject({
      status: 'failed',
      reason: 'trooper image too old for push containers',
    });
    expect(d.order).toEqual([]);
  });
});

describe('server-hosted images (issue #141)', () => {
  const done = 'JM_RESULT {"status":"completed","gates":[]}';
  const r = release();
  const p: DropPayload = { ...payload, image: r.ref };
  /** The server: serves the release's layout, or answers 404 `not mirrored`. */
  function serverImages(o: { source?: ImageSource; mirrored?: boolean } = {}) {
    const calls: string[] = [];
    let loaded = false;
    const deps: ServerImageDeps = {
      client: {
        async imageLayout(ref) {
          calls.push(`fetch ${ref}`);
          if (o.mirrored === false)
            return Response.json({ error: 'not mirrored', state: 'fetching' }, { status: 404 });
          return new Response(tar(r.entries), { status: 200 });
        },
        async reportImageFetch() {},
      },
      loader: {
        async imageExists() {
          return loaded;
        },
        async loadImage(t) {
          for await (const _ of t);
          calls.push('load');
          loaded = true;
          return [r.configDigest];
        },
        async removeImage() {},
        async tagImage(id, ref) {
          calls.push(`tag ${id} ${ref}`);
        },
      },
      stateDir: mkdtempSync(join(tmpdir(), 'jm-state-')),
      platform: 'linux/amd64',
      log: () => {},
    };
    const server: ServerImages = { source: () => o.source ?? 'server', deps };
    return { server, calls };
  }
  /** cosign: offline layout checks pass for the release; any registry call is recorded. */
  function cosign() {
    const registry: string[][] = [];
    const local: string[][] = [];
    const c: Cosign = async (args) => {
      const offline = args[0] === 'verify-blob-attestation' && args.includes('--offline');
      (offline ? local : registry).push(args);
      // Registry mode (`cosign verify`) still reads the signed digest from the output.
      return {
        code: 0,
        stdout: offline
          ? ''
          : JSON.stringify([
              {
                critical: { image: { 'docker-manifest-digest': r.indexDigest } },
                optional: {
                  Subject:
                    'https://github.com/x-a-n-d-e-r-k/jumpmaster/.github/workflows/release.yml@refs/tags/v0.4.0-rc.2',
                },
              },
            ]),
        stderr: '',
      };
    };
    return { cosign: c, registry, local };
  }
  const trust = (c: Cosign, server: ServerImages): ImageTrust => ({
    policy: 'signed',
    allowed: new Set(),
    signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
    cosign: c,
    cache: new VerifyCache(
      join(mkdtempSync(join(tmpdir(), 'jm-trust-')), 'verified.json'),
      releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
    ),
    server,
  });

  test('a missing image comes from the server, verified offline and loaded, then the drop runs; the registry is never asked', async () => {
    const d = fakeDriver([done], { present: () => false });
    const s = serverImages();
    const c = cosign();
    const client = fakeClient();
    const log: string[] = [];
    await runDrop(p, {
      client,
      driver: d.driver,
      stickId: 's1',
      trust: trust(c.cosign, s.server),
      log: (l) => log.push(l),
    });
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(s.calls).toEqual([`fetch ${r.ref}`, 'load', `tag ${r.configDigest} ${r.ref}`]);
    expect(c.local).toHaveLength(1);
    // No registry: neither the driver's pull (spied) nor cosign's online verify.
    expect(d.images).toEqual([]);
    expect(c.registry).toEqual([]);
    expect(d.started?.image).toBe(r.ref);
    expect(log.map((l) => JSON.parse(l))).toContainEqual({
      event: 'image-verified',
      dropId: 'd1',
      ref: r.ref,
      via: 'cosign',
    });
  });

  test('a server image signed by a release older than this stick is refused after its offline check, never loaded (#270)', async () => {
    const d = fakeDriver([done], { present: () => false });
    const s = serverImages();
    const c = cosign();
    const client = fakeClient();
    // The layout's bundle is the v0.4.0-rc.2 one; this stick is 0.4.0.
    const t: ImageTrust = {
      ...trust(c.cosign, s.server),
      signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0'),
    };
    t.cache = undefined;
    await runDrop(p, { client, driver: d.driver, stickId: 's1', trust: t, log: () => {} });
    expect(client.result).toMatchObject({
      status: 'failed',
      reason: `image not verified: ${r.ref}: image signed for v0.4.0-rc.2, older than this stick (0.4.0)`,
    });
    expect(c.local).toHaveLength(1);
    expect(s.calls).toEqual([`fetch ${r.ref}`]);
    expect(d.started).toBeUndefined();
  });

  test('404 not mirrored: the drop waits with the server state, posts nothing and never pulls', async () => {
    const d = fakeDriver([done], { present: () => false });
    const s = serverImages({ mirrored: false });
    const c = cosign();
    const client = fakeClient();
    const log: string[] = [];
    await runDrop(p, {
      client,
      driver: d.driver,
      stickId: 's1',
      trust: trust(c.cosign, s.server),
      log: (l) => log.push(l),
    });
    expect(client.result).toBeUndefined();
    expect(d.started).toBeUndefined();
    expect(d.images).toEqual([]);
    expect(c.registry).toEqual([]);
    expect(c.local).toEqual([]);
    expect(log.map((l) => JSON.parse(l))).toContainEqual({
      event: 'drop-waiting',
      dropId: 'd1',
      epoch: 3,
      reason: `image ${r.ref} not yet mirrored on the server (fetching)`,
    });
  });

  test('404 not mirrored: no heartbeat after drop-waiting, so the lease lapses', async () => {
    vi.useFakeTimers();
    try {
      const d = fakeDriver([done], { present: () => false });
      const s = serverImages({ mirrored: false });
      const c = cosign();
      const client = fakeClient();
      const order: string[] = [];
      client.heartbeat = async () => {
        order.push('beat');
        return 'ok';
      };
      const run = runDrop(p, {
        client,
        driver: d.driver,
        stickId: 's1',
        heartbeatMs: 1000,
        trust: trust(c.cosign, s.server),
        log: (l) => {
          if (JSON.parse(l).event === 'drop-waiting') order.push('waiting');
        },
      });
      await vi.advanceTimersByTimeAsync(10);
      await run;
      expect(order).toContain('waiting');
      await vi.advanceTimersByTimeAsync(5000);
      expect(order.slice(order.indexOf('waiting') + 1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('registry mode behaves as before: verify against the registry, then pull', async () => {
    const d = fakeDriver([done], { present: () => false });
    const s = serverImages({ source: 'registry' });
    const c = cosign();
    const verify = c.cosign;
    const client = fakeClient();
    await runDrop(p, {
      client,
      driver: d.driver,
      stickId: 's1',
      // The registry's cosign names the asked-for digest, as the fixture release signs it.
      trust: trust(verify, s.server),
    });
    expect(client.result).toMatchObject({ status: 'completed' });
    expect(s.calls).toEqual([]);
    expect(c.local).toEqual([]);
    expect(c.registry).toHaveLength(1);
    expect(d.images).toEqual([`pull ${r.ref}`]);
  });
});

describe('the heartbeat while images are prepared (issue #239)', () => {
  const HB = 1000;
  const REF = `ghcr.io/o/jumpmaster-trooper@sha256:${'7'.repeat(64)}`;
  const p: DropPayload = { ...payload, image: REF };
  const done = 'JM_RESULT {"status":"completed","gates":[]}';
  /** A driver whose pull of the trooper image takes `ms`. */
  const slowPull = (ms: number, lines = [done]) => {
    const d = fakeDriver(lines, { present: () => false });
    d.driver.pullImage = async (ref) => {
      d.order.push(`pull ${ref}`);
      await new Promise((r) => setTimeout(r, ms));
    };
    return d;
  };
  /** A client that counts its beats and records them in `order` too. */
  const counting = (order: string[], reply: 'ok' | 'cancel' | 'stale' = 'ok') => {
    const client = fakeClient(reply);
    let results = 0;
    const c = Object.assign(client, {
      beats: 0,
      results: () => results,
      async heartbeat() {
        c.beats++;
        order.push('beat');
        return c.heartbeatReply;
      },
      async postResult(_d: string, _e: number, r: DropResult) {
        results++;
        order.push('result');
        client.result = r;
        return 'ok' as const;
      },
    });
    return c;
  };
  const deps = (d: ReturnType<typeof fakeDriver>, client: DropClient, extra = {}) => ({
    client,
    driver: d.driver,
    heartbeatMs: HB,
    stickId: 's1',
    allowedImages: new Set([REF]),
    log: () => {},
    ...extra,
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a slow pull longer than several intervals: heartbeats go out before the container exists', async () => {
    const d = slowPull(5.5 * HB);
    const client = counting(d.order);
    const run = runDrop(p, deps(d, client));
    await vi.advanceTimersByTimeAsync(6 * HB);
    await run;
    const first = d.order.indexOf('trooper');
    expect(first).toBeGreaterThan(-1);
    expect(d.order.slice(0, first).filter((s) => s === 'beat').length).toBeGreaterThanOrEqual(2);
    expect(client.result).toMatchObject({ status: 'completed' });
  });

  test('a cancel answer during a slow pull: no container is created and nothing is posted', async () => {
    const d = slowPull(5.5 * HB);
    const client = counting(d.order, 'cancel');
    const run = runDrop(p, deps(d, client));
    await vi.advanceTimersByTimeAsync(6 * HB);
    await run;
    expect(d.started).toBeUndefined();
    expect(client.results()).toBe(0);
    const beats = client.beats;
    await vi.advanceTimersByTimeAsync(5 * HB);
    expect(client.beats).toBe(beats);
  });

  test('a stale answer during a slow pull: no container and no result', async () => {
    const d = slowPull(5.5 * HB);
    const client = counting(d.order, 'stale');
    const run = runDrop(p, deps(d, client));
    await vi.advanceTimersByTimeAsync(6 * HB);
    await run;
    expect(d.started).toBeUndefined();
    expect(client.results()).toBe(0);
  });

  test('the lost-server limit during a slow pull: no container is created', async () => {
    const d = slowPull(5.5 * HB);
    const client = counting(d.order);
    client.heartbeat = async () => {
      client.beats++;
      throw new Error('network down');
    };
    const run = runDrop(p, deps(d, client, { lostServerKillBeats: 3 }));
    await vi.advanceTimersByTimeAsync(6 * HB);
    await run;
    expect(d.started).toBeUndefined();
    expect(client.results()).toBe(0);
    expect(client.beats).toBe(3);
  });

  test('a failed verification stops the heartbeat before the failure is posted, once', async () => {
    const d = fakeDriver([done], { present: () => false });
    const client = counting(d.order);
    const cosign: Cosign = async () => {
      await new Promise((r) => setTimeout(r, 3.5 * HB));
      return { code: 10, stdout: '', stderr: 'Error: no signatures found' };
    };
    const trust: ImageTrust = {
      policy: 'signed',
      allowed: new Set(),
      signer: releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
      cosign,
      cache: new VerifyCache(
        join(mkdtempSync(join(tmpdir(), 'jm-trust-')), 'verified.json'),
        releaseSigner('x-a-n-d-e-r-k/jumpmaster', '0.4.0-rc.2'),
      ),
    };
    const run = runDrop(p, deps(d, client, { trust }));
    await vi.advanceTimersByTimeAsync(4 * HB);
    await run;
    expect(client.beats).toBeGreaterThanOrEqual(2);
    expect(client.results()).toBe(1);
    expect(client.result).toMatchObject({ status: 'failed' });
    expect(d.started).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * HB);
    expect(d.order.lastIndexOf('beat')).toBeLessThan(d.order.indexOf('result'));
  });

  test('a normal drop beats on one interval, not two', async () => {
    const d = fakeDriver([], { hang: true });
    const start = d.driver.start;
    d.driver.start = async (o) => {
      const h = await start(o);
      setTimeout(() => void h.stop(0), 10.5 * HB);
      return h;
    };
    const client = counting(d.order);
    const run = runDrop(payload, deps(d, client, { allowedImages: new Set([payload.image]) }));
    await vi.advanceTimersByTimeAsync(11 * HB);
    await run;
    expect(d.started).toBeDefined();
    expect(client.beats).toBeGreaterThanOrEqual(9);
    expect(client.beats).toBeLessThanOrEqual(11);
    const beats = client.beats;
    await vi.advanceTimersByTimeAsync(5 * HB);
    expect(client.beats).toBe(beats);
  });
});

describe('a provided mirror: the clone container before the agent (issue #860)', () => {
  const DONE = 'JM_RESULT {"status":"completed","gates":[]}';
  const SHA = 'c'.repeat(40);
  const PUSH_RESULT = `JM_RESULT ${JSON.stringify({
    status: 'completed',
    headSha: SHA,
    push: { kind: 'final', expectSha: SHA },
    gates: [],
  })}`;
  const CLONED = 'JM_RESULT {"status":"cloned","bytes":4242}';
  const CLONE_OK = { before: [READY_LINE], after: [CLONED] };
  const MIRROR_LABELS = {
    'org.jumpmaster.trooper.egress': '1',
    'org.jumpmaster.trooper.push': '1',
    'org.jumpmaster.trooper.mirror': '1',
  };
  const AGENT = 'jumpmaster-drop-d1-3';
  const MIRROR_VOL = 'jm-mirror-d1-3';
  const mirrored = (p: DropPayload): DropPayload =>
    DropPayloadSchema.parse({ ...p, repo: { ...p.repo, mirror: 'provided' } });
  const implement = mirrored(payload);
  const review = mirrored(
    DropPayloadSchema.parse({
      ...payload,
      role: 'review',
      pr: { number: 2, branch: 'agent/issue-1', headSha: 'a'.repeat(40) },
    }),
  );
  const enforce = (p: DropPayload): DropPayload => ({
    ...p,
    egress: { mode: 'enforce', allow: ['api.anthropic.com'] },
    services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
  });

  function world(
    lines: string[],
    opts: Parameters<typeof fakeDriver>[1] = {},
    client = fakeClient(),
  ) {
    const d = fakeDriver(lines, { imageLabels: MIRROR_LABELS, clone: CLONE_OK, ...opts });
    // The client's clone calls and posted results, in the driver's order.
    const plan = client.clonePlan.bind(client);
    client.clonePlan = async (dropId, epoch) => {
      d.order.push('plan');
      return plan(dropId, epoch);
    };
    const post = client.postResult.bind(client);
    client.postResult = async (dropId, epoch, r) => {
      d.order.push('result');
      return post(dropId, epoch, r);
    };
    const pending = new PendingPushes();
    const lines_: string[] = [];
    const deps = {
      client,
      driver: d.driver,
      heartbeatMs: 5,
      stickId: 's1',
      trooperImage: 'trooper:base',
      pending,
      resultRetryMs: 1,
      baseImage: () => ({ ok: true }) as const,
      allowedImages: new Set(['jumpmaster-trooper:test', 'postgres:16']),
      egressImage: 'jumpmaster-egress:test',
      egressReadyMs: 50,
      subnetPool: '172.30.0.0/16',
      log: (l: string) => lines_.push(l),
    };
    return { d, client, pending, deps, lines: lines_ };
  }

  test('plan, clone container, grant, clone result, then the agent with the mirror read-only', async () => {
    const w = world([DONE]);
    await runDrop(review, w.deps);
    expect(w.d.order).toEqual([
      `volume ${MIRROR_VOL}`,
      'plan',
      'clone',
      'grant',
      'removeAndWait jumpmaster-clone-d1-3',
      'trooper',
      'result',
      `removeAndWait ${AGENT}`,
      `removeVolume ${MIRROR_VOL}`,
    ]);
    expect(w.client.cloneCalls).toEqual(['plan', 'grant']);
    expect(w.d.started?.mirror?.volume).toMatch(/^jm-mirror-d1-3-[0-9a-f]{8}$/);
    expect(w.d.started?.mirror?.target).toBe('/jm/mirror');
    expect(w.d.started?.clone).toBeUndefined();
    expect(w.d.started?.mount).toBeUndefined();
    expect(w.d.cloneStarted?.mirror).toEqual(w.d.started?.mirror);
    expect(w.client.results).toHaveLength(1);
    expect(w.client.result?.status).toBe('completed');
  });

  test('the clone container runs the stick’s own trooper image, never the payload’s', async () => {
    const w = world([DONE]);
    await runDrop(review, w.deps);
    expect(w.d.cloneStarted?.image).toBe('trooper:base');
    expect(w.d.cloneStarted?.clone).toBe(true);
    expect(w.d.started?.image).toBe('jumpmaster-trooper:test');
  });

  test('a refused base image refuses a non-pushing provided-mirror drop before anything exists', async () => {
    const w = world([DONE]);
    await runDrop(review, {
      ...w.deps,
      baseImage: () => ({ ok: false, reason: 'base image trooper:base: image not allowed' }),
    });
    expect(w.d.order).toEqual(['result']);
    expect(w.client.cloneCalls).toEqual([]);
    expect(w.client.result).toMatchObject({
      status: 'failed',
      reason: 'base image trooper:base: image not allowed',
    });
  });

  test('a drop image without the mirror label is refused before any container or volume', async () => {
    const w = world([DONE], {
      imageLabels: { 'org.jumpmaster.trooper.egress': '1', 'org.jumpmaster.trooper.push': '1' },
    });
    await runDrop(implement, w.deps);
    expect(w.d.order).toEqual(['result']);
    expect(w.client.cloneCalls).toEqual([]);
    expect(w.client.result?.status).toBe('failed');
    expect(w.client.result?.reason).toContain('jumpmaster-trooper:test');
  });

  for (const retryable of [true, false]) {
    test(`a failed clone (retryable: ${retryable}) posts one failed result and starts nothing else`, async () => {
      const failed = `JM_RESULT ${JSON.stringify({ status: 'failed', reason: 'project not found', retryable })}`;
      const w = world([DONE], { clone: { before: [READY_LINE], after: [failed] } });
      await runDrop(enforce(implement), w.deps);
      expect(w.client.results).toHaveLength(1);
      expect(w.client.result).toMatchObject({ status: 'failed', reason: 'project not found' });
      expect(w.d.order).toEqual([
        `volume ${MIRROR_VOL}`,
        'plan',
        'clone',
        'grant',
        'removeAndWait jumpmaster-clone-d1-3',
        `removeVolume ${MIRROR_VOL}`,
        'result',
      ]);
      expect(w.d.started).toBeUndefined();
      expect(w.d.net).toBeUndefined();
      expect(w.pending.size()).toBe(0);
    });
  }

  test('a failed clone fails the doctor role too', async () => {
    const doctor = mirrored(
      DropPayloadSchema.parse({
        protocol: 1,
        dropId: 'd1',
        epoch: 3,
        role: 'doctor',
        repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
        model: 'm',
        image: 'jumpmaster-trooper:test',
        gates: [],
        credentials: { claudeToken: TOKEN, readToken: 'glpat-read' },
      }),
    );
    const w = world([DONE], {
      clone: { before: ['JM_RESULT {"status":"failed","reason":"nope","retryable":true}'] },
    });
    await runDrop(doctor, w.deps);
    expect(w.client.results).toHaveLength(1);
    expect(w.client.result).toMatchObject({ status: 'failed', reason: 'nope' });
    expect(w.d.started).toBeUndefined();
  });

  test('a stale clone plan posts no result and starts nothing', async () => {
    const client = fakeClient();
    client.planReply = 'stale';
    const w = world([DONE], {}, client);
    await runDrop(review, w.deps);
    expect(w.client.results).toEqual([]);
    expect(w.d.started).toBeUndefined();
    expect(w.d.order).toContain(`removeVolume ${MIRROR_VOL}`);
  });

  test('a halt mid-clone posts no result and leaves no mirror volume', async () => {
    const client = fakeClient();
    const w = world([DONE], { clone: { before: [READY_LINE], hang: true } }, client);
    client.grantReply = { grant: CLONE_GRANT };
    // Cancelled once the clone container runs.
    const start = w.d.driver.start;
    w.d.driver.start = async (o) => {
      const h = await start(o);
      if (o.clone) client.heartbeatReply = 'cancel';
      return h;
    };
    await runDrop(review, w.deps);
    expect(w.client.results).toEqual([]);
    expect(w.d.started).toBeUndefined();
    expect(w.d.order).toContain(`removeVolume ${MIRROR_VOL}`);
    expect(w.d.order.indexOf(`removeVolume ${MIRROR_VOL}`)).toBeGreaterThan(
      w.d.order.indexOf('removeAndWait jumpmaster-clone-d1-3'),
    );
  });

  test('a non-pushing role: the mirror volume goes once the agent container is confirmed gone', async () => {
    const w = world([DONE]);
    await runDrop(review, w.deps);
    const gone = w.d.order.indexOf(`removeAndWait ${AGENT}`);
    expect(gone).toBeGreaterThan(w.d.order.indexOf('trooper'));
    expect(w.d.order.indexOf(`removeVolume ${MIRROR_VOL}`)).toBeGreaterThan(gone);
    expect(w.d.order.filter((x) => x === `removeVolume ${MIRROR_VOL}`)).toHaveLength(1);
  });

  test('a pushing role queues its repo volume and removes the mirror after the agent is gone', async () => {
    const w = world([PUSH_RESULT]);
    const add = w.pending.add.bind(w.pending);
    w.pending.add = (dropId, o, now) => {
      w.d.order.push(`add ${o.volume.replace(/-[0-9a-f]{8}$/, '')}`);
      add(dropId, o, now);
    };
    await runDrop(implement, w.deps);
    expect(w.d.order).toEqual([
      `volume ${MIRROR_VOL}`,
      'plan',
      'clone',
      'grant',
      'removeAndWait jumpmaster-clone-d1-3',
      'volume jm-drop-d1-3',
      'init trooper:base',
      'trooper',
      'result',
      `removeAndWait ${AGENT}`,
      'add jm-drop-d1-3',
      `removeVolume ${MIRROR_VOL}`,
    ]);
    expect(w.d.started?.mount?.volume).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
    expect(w.d.started?.mirror?.volume).toMatch(/^jm-mirror-d1-3-[0-9a-f]{8}$/);
    expect(w.pending.get('d1')?.volume).toMatch(/^jm-drop-d1-3-/);
  });

  test('an agent container not confirmed gone keeps the mirror volume (the sweep’s)', async () => {
    const w = world([DONE], { removeError: true });
    await runDrop(review, w.deps);
    expect(w.d.order).not.toContain(`removeVolume ${MIRROR_VOL}`);
  });

  test('the drop network is created only after the clone returned, sharing one active set', async () => {
    const client = fakeClient();
    client.planReply = {
      forge: CLONE_FORGE,
      maxBytes: 1_000_000,
      egress: { mode: 'enforce', allow: ['gitlab.example.com'] },
    } as ClonePlanReply;
    const w = world([DONE], {}, client);
    const active = new Set<string>();
    const seen: string[][] = [];
    const create = w.d.driver.createDropNetwork;
    w.d.driver.createDropNetwork = async (name, labels, pool) => {
      seen.push([...active]);
      return create(name, labels, pool);
    };
    await runDrop(enforce(review), { ...w.deps, active });
    expect(w.d.net?.name).toBe('jm-drop-d1-3');
    expect(seen).toEqual([['jm-clone-d1-3'], ['jm-drop-d1-3']]);
    const order = w.d.order;
    expect(order.indexOf('clone')).toBeLessThan(order.lastIndexOf('network'));
    expect(order.indexOf('removeAndWait jumpmaster-clone-d1-3')).toBeLessThan(
      order.lastIndexOf('network'),
    );
    expect(active.size).toBe(0);
  });

  test('after a clone, a proxy that fails to start still removes the mirror volume', async () => {
    const w = world([DONE], { proxyError: 'no proxy' });
    await runDrop(enforce(review), w.deps);
    expect(w.client.result?.reason).toContain('egress proxy failed to start');
    expect(w.d.started).toBeUndefined();
    expect(w.d.order.slice(-2)).toEqual([`removeAndWait ${AGENT}`, `removeVolume ${MIRROR_VOL}`]);
  });

  test('after a clone, services that fail still remove the mirror volume', async () => {
    const w = world([DONE], { serviceError: 'db down' });
    await runDrop(enforce(review), w.deps);
    expect(w.client.result?.reason).toContain('services failed');
    expect(w.d.started).toBeUndefined();
    expect(w.d.order.slice(-2)).toEqual([`removeAndWait ${AGENT}`, `removeVolume ${MIRROR_VOL}`]);
  });

  test('after a clone, a repo volume that fails still removes the mirror volume', async () => {
    const w = world([PUSH_RESULT]);
    w.d.driver.initVolume = async () => 1;
    await runDrop(implement, w.deps);
    expect(w.client.result?.reason).toContain('repo volume failed');
    expect(w.d.started).toBeUndefined();
    expect(w.d.order.filter((x) => x === `removeVolume ${MIRROR_VOL}`)).toHaveLength(1);
    expect(w.d.order.slice(-2)).toEqual([`removeAndWait ${AGENT}`, `removeVolume ${MIRROR_VOL}`]);
  });

  test('the egress proxy image the clone may need is pulled with the drop’s images', async () => {
    const proxy = `jumpmaster-egress@sha256:${'e'.repeat(64)}`;
    const w = world([DONE], { present: (ref) => ref !== proxy });
    await runDrop(review, { ...w.deps, egressImage: proxy });
    expect(w.d.order[0]).toBe(`pull ${proxy}`);
    expect(w.client.result?.status).toBe('completed');
  });

  test('a planted grant token, plain or as basic auth, reaches no log line or result', async () => {
    const leak = `JM_RESULT ${JSON.stringify({
      status: 'failed',
      reason: `auth ${CLONE_TOKEN} ${gitlabBasicAuth(CLONE_TOKEN)} ${gitlabBasicAuthAs('bot', CLONE_TOKEN)}`,
      retryable: false,
    })}`;
    const w = world([DONE], { clone: { before: [READY_LINE], after: [leak] } });
    await runDrop(review, w.deps);
    // The grant went to the clone container's stdin, and only there.
    expect(w.d.cloneWrites.join('')).toContain(CLONE_TOKEN);
    const seen = JSON.stringify([w.lines, w.client.results, w.client.events]);
    for (const secret of [
      CLONE_TOKEN,
      gitlabBasicAuth(CLONE_TOKEN),
      gitlabBasicAuthAs('bot', CLONE_TOKEN),
    ]) {
      expect(seen).not.toContain(secret);
    }
    expect(w.client.results).toHaveLength(1);
    expect(w.client.events).toEqual([]);
  });
});

describe('a payload without repo.mirror runs as before (pinned)', () => {
  const DONE = 'JM_RESULT {"status":"completed","gates":[]}';
  const deps = (d: ReturnType<typeof fakeDriver>, client: ReturnType<typeof fakeClient>) => ({
    client,
    driver: d.driver,
    heartbeatMs: 5,
    stickId: 's1',
    trooperImage: 'trooper:base',
    allowedImages: new Set(['jumpmaster-trooper:test', 'postgres:16']),
    egressImage: 'jumpmaster-egress:test',
    egressReadyMs: 50,
    subnetPool: '172.30.0.0/16',
    log: () => {},
  });
  const full: DropPayload = {
    ...payload,
    egress: { mode: 'enforce', allow: ['api.anthropic.com'] },
    services: [{ name: 'db', image: 'postgres:16', port: 5432, readyTimeoutSeconds: 60 }],
  };

  test('a pushing drop with egress and services', async () => {
    const d = fakeDriver([DONE]);
    const client = fakeClient();
    let asked = 0;
    await runDrop(full, {
      ...deps(d, client),
      baseImage: () => {
        asked++;
        return { ok: true };
      },
    });
    expect(asked).toBe(1);
    expect(client.cloneCalls).toEqual([]);
    expect(d.started?.mirror).toBeUndefined();
    expect(d.order).toEqual([
      'volume jm-drop-d1-3',
      'init trooper:base',
      'network',
      'proxy',
      'services',
      'trooper',
      'proxy-stop',
      'teardown',
      'removeAndWait jumpmaster-drop-d1-3',
      'removeVolume jm-drop-d1-3',
    ]);
  });

  test('a non-pushing drop reads no base verdict and makes no volume', async () => {
    const review = DropPayloadSchema.parse({
      ...full,
      role: 'review',
      pr: { number: 2, branch: 'agent/issue-1', headSha: 'a'.repeat(40) },
    });
    const d = fakeDriver([DONE]);
    const client = fakeClient();
    let asked = 0;
    await runDrop(review, {
      ...deps(d, client),
      baseImage: () => {
        asked++;
        return { ok: false, reason: 'refused' };
      },
    });
    expect(asked).toBe(0);
    expect(client.cloneCalls).toEqual([]);
    expect(client.result?.status).toBe('completed');
    expect(d.order).toEqual(['network', 'proxy', 'services', 'trooper', 'proxy-stop', 'teardown']);
  });
});
