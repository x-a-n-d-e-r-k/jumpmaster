import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type ContainerSpec,
  INSTALLED_TAG,
  runUpgrade,
  type UpgradeDeps,
  type UpgradeDocker,
  type UpgradeOptions,
} from './upgrade-helper.js';

const NAME = 'jm-stick';
const OLD_IMAGE = 'sha256:old051';
const NEW_IMAGE = 'sha256:new060';
const HOST_CONFIG = {
  Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/var/lib/jumpmaster:/var/lib/jumpmaster'],
  RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
  NetworkMode: 'host',
  LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } },
};

interface FakeContainer {
  id: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  hostConfig: Record<string, unknown>;
  running: boolean;
  restartCount: number;
}

type Call = [op: string, ...args: unknown[]];

/** An in-memory Docker: containers by name, images by id, and every call recorded. */
class FakeDocker implements UpgradeDocker {
  containers = new Map<string, FakeContainer>();
  images = new Map<string, { env: string[]; labels: Record<string, string>; tags: string[] }>();
  calls: Call[] = [];
  created: ContainerSpec | undefined;
  /** Throws from an operation: return an error to throw it. */
  fail: (op: string, name: string, count: number) => Error | undefined = () => undefined;
  /** Runs after a container starts (the new stick writing `ok`, crashing, …). */
  onStart: (c: FakeContainer, name: string) => void = () => {};
  /** Runs before each call is recorded. */
  onCall: (call: Call) => void = () => {};
  private counts = new Map<string, number>();
  private nextId = 1;

  private enter(op: string, name: string, ...rest: unknown[]) {
    const call: Call = [op, name, ...rest];
    this.onCall(call);
    this.calls.push(call);
    const key = `${op}:${name}`;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    const err = this.fail(op, name, n);
    if (err) throw err;
  }

  private get(name: string): FakeContainer {
    const c = this.containers.get(name);
    if (!c) throw Object.assign(new Error(`no such container: ${name}`), { statusCode: 404 });
    return c;
  }

  async inspectContainer(name: string) {
    this.enter('inspectContainer', name);
    const c = this.containers.get(name);
    if (!c) return undefined;
    return {
      id: c.id,
      imageId: c.image,
      env: [...c.env],
      labels: { ...c.labels },
      hostConfig: structuredClone(c.hostConfig),
      running: c.running,
      restartCount: c.restartCount,
    };
  }

  async inspectImage(id: string) {
    this.enter('inspectImage', id);
    const i = this.images.get(id);
    return i ? { id, env: [...i.env], labels: { ...i.labels } } : undefined;
  }

  /** Awaited before each create, so a test can hold a helper mid-swap. */
  beforeCreate: () => Promise<void> = async () => {};

  async create(name: string, spec: ContainerSpec) {
    await this.beforeCreate();
    this.enter('create', name);
    if (this.containers.has(name)) throw new Error(`name in use: ${name}`);
    this.created = structuredClone(spec);
    this.containers.set(name, {
      id: `c${this.nextId++}`,
      image: spec.Image,
      env: [...spec.Env],
      labels: { ...spec.Labels },
      hostConfig: structuredClone(spec.HostConfig),
      running: false,
      restartCount: 0,
    });
  }

  async start(name: string) {
    this.enter('start', name);
    const c = this.get(name);
    c.running = true;
    this.onStart(c, name);
  }

  async stop(name: string, timeoutSeconds: number) {
    this.enter('stop', name, timeoutSeconds);
    this.get(name).running = false;
  }

  async rename(name: string, newName: string) {
    this.enter('rename', name, newName);
    const c = this.get(name);
    if (this.containers.has(newName)) throw new Error(`name in use: ${newName}`);
    this.containers.delete(name);
    this.containers.set(newName, c);
  }

  async remove(name: string) {
    this.enter('remove', name);
    const c = this.get(name);
    if (c.running) throw new Error(`container is running: ${name}`);
    this.containers.delete(name);
  }

  async removeImage(id: string) {
    this.enter('removeImage', id);
    if ([...this.containers.values()].some((c) => c.image === id)) throw new Error('image in use');
    this.images.delete(id);
  }

  async tag(imageId: string, repoTag: string) {
    this.enter('tag', imageId, repoTag);
    for (const i of this.images.values()) i.tags = i.tags.filter((t) => t !== repoTag);
    const i = this.images.get(imageId);
    if (!i) throw new Error(`no such image: ${imageId}`);
    i.tags.push(repoTag);
  }

  ops(): string[] {
    return this.calls.map((c) => c.slice(0, 2).join(' '));
  }
}

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'jm-upgrade-'));
}

interface World {
  docker: FakeDocker;
  state: string;
  dir: string;
  lines: string[];
  deps: UpgradeDeps;
  opts: UpgradeOptions;
  clock: { now: number };
}

function world(over: { oldEnv?: string[]; pending?: string | null } = {}): World {
  const docker = new FakeDocker();
  docker.images.set(OLD_IMAGE, {
    env: [
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'JM_TROOPER_IMAGE=ghcr.io/x/trooper@sha256:051',
      'JM_IMAGE_POLICY=signed',
    ],
    labels: { 'org.opencontainers.image.version': '0.5.1', 'org.opencontainers.image.title': 's' },
    tags: [INSTALLED_TAG],
  });
  docker.images.set(NEW_IMAGE, {
    env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'JM_TROOPER_IMAGE=ghcr.io/x/trooper@sha256:060'],
    labels: { 'org.opencontainers.image.version': '0.6.0' },
    tags: [],
  });
  docker.containers.set(NAME, {
    id: 'old-id',
    image: OLD_IMAGE,
    env: over.oldEnv ?? [
      'JM_SERVER_URL=https://jm.example',
      'JM_IMAGE_SOURCE=server',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'JM_TROOPER_IMAGE=ghcr.io/x/trooper@sha256:051',
      'JM_IMAGE_POLICY=signed',
    ],
    labels: {
      'org.opencontainers.image.version': '0.5.1',
      'org.opencontainers.image.title': 's',
      'jumpmaster.installer': 'install.sh',
    },
    hostConfig: structuredClone(HOST_CONFIG),
    running: true,
    restartCount: 0,
  });
  const state = fresh();
  const dir = join(state, 'upgrade');
  mkdirSync(dir, { recursive: true });
  const pending = over.pending === undefined ? '{"version":"0.6.0"}' : over.pending;
  if (pending !== null) writeFileSync(join(dir, 'pending.json'), pending);
  // The healthy new stick: writes `ok` with its version once started.
  docker.onStart = (c) => {
    if (c.image === NEW_IMAGE) writeFileSync(join(dir, 'ok'), '0.6.0\n');
  };
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') };
  const lines: string[] = [];
  const deps: UpgradeDeps = {
    docker,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    log: (line) => lines.push(line),
  };
  const opts: UpgradeOptions = {
    container: NAME,
    image: NEW_IMAGE,
    version: '0.6.0',
    stateDir: state,
    timeoutSeconds: 900,
  };
  return { docker, state, dir, lines, deps, opts, clock };
}

const readResult = (w: World) => JSON.parse(readFileSync(join(w.dir, 'result.json'), 'utf8'));

describe('runUpgrade: success', () => {
  test('the new container takes the name, host config and installer settings', async () => {
    const w = world();
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(0);
    const spec = w.docker.created;
    expect(spec).toBeDefined();
    expect(spec?.HostConfig).toEqual(HOST_CONFIG);
    expect(spec?.Env).toContain('JM_SERVER_URL=https://jm.example');
    expect(spec?.Env).toContain('JM_IMAGE_SOURCE=server');
    expect(spec?.Env.some((e) => e.startsWith('JM_TROOPER_IMAGE='))).toBe(false);
    expect(spec?.Env.some((e) => e.startsWith('PATH='))).toBe(false);
    expect(spec?.Env.some((e) => e.startsWith('JM_IMAGE_POLICY='))).toBe(false);
    expect(spec?.Labels).toEqual({ 'jumpmaster.installer': 'install.sh' });
    expect(spec?.Image).toBe(NEW_IMAGE);
    // Cmd, Entrypoint, User and WorkingDir come from the new image.
    expect(Object.keys(spec ?? {}).sort()).toEqual(['Env', 'HostConfig', 'Image', 'Labels']);
    expect(w.docker.calls).toContainEqual(['create', `${NAME}-next`]);

    const now = w.docker.containers.get(NAME);
    expect(now?.image).toBe(NEW_IMAGE);
    expect(now?.running).toBe(true);
    expect(now?.hostConfig).toEqual(HOST_CONFIG);
    expect([...w.docker.containers.keys()]).toEqual([NAME]);
    expect(w.docker.calls).toContainEqual(['remove', `${NAME}-previous`]);
    expect(w.docker.calls).toContainEqual(['removeImage', OLD_IMAGE]);
    expect(w.docker.images.has(OLD_IMAGE)).toBe(false);
    expect(w.docker.calls).toContainEqual(['tag', NEW_IMAGE, 'jumpmaster-stick:installed']);
    expect(w.docker.images.get(NEW_IMAGE)?.tags).toEqual(['jumpmaster-stick:installed']);

    expect(readResult(w)).toEqual({ version: '0.6.0', result: 'ok' });
    expect(existsSync(join(w.dir, 'ok'))).toBe(false);
    expect(existsSync(join(w.dir, 'pending.json'))).toBe(false);
    expect(existsSync(join(w.dir, 'lock'))).toBe(false);
    // Every log line is one JSON step, also kept in helper.log.
    for (const l of w.lines) expect(JSON.parse(l).event).toBe('upgrade-step');
    const file = readFileSync(join(w.dir, 'helper.log'), 'utf8').trim().split('\n');
    expect(file).toEqual(w.lines);
  });

  test('creates the next container before stopping the old one', async () => {
    const w = world();
    await runUpgrade(w.opts, w.deps);
    const ops = w.docker.ops();
    const created = ops.indexOf(`create ${NAME}-next`);
    const stopped = ops.indexOf(`stop ${NAME}`);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(created);
  });

  test('the old image is kept when its removal fails, and the upgrade still succeeds', async () => {
    const w = world();
    w.docker.fail = (op) => (op === 'removeImage' ? new Error('image has dependents') : undefined);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(0);
    expect(readResult(w).result).toBe('ok');
    expect(w.lines.some((l) => l.includes('image has dependents'))).toBe(true);
  });

  test('helper.log is truncated when the helper starts', async () => {
    const w = world();
    writeFileSync(join(w.dir, 'helper.log'), 'an old run\n');
    await runUpgrade(w.opts, w.deps);
    expect(readFileSync(join(w.dir, 'helper.log'), 'utf8')).not.toContain('an old run');
  });
});

/** Asserts the rollback: the new container gone, the old one back under its name and running. */
function expectRolledBack(w: World, reason: RegExp, resultBeforeStart: boolean[]) {
  const old = w.docker.containers.get(NAME);
  expect(old?.id).toBe('old-id');
  expect(old?.running).toBe(true);
  expect([...w.docker.containers.keys()]).toEqual([NAME]);
  expect(w.docker.calls).toContainEqual(['rename', `${NAME}-previous`, NAME]);
  const result = readResult(w);
  expect(result.result).toBe('failed');
  expect(result.version).toBe('0.6.0');
  expect(result.reason).toMatch(reason);
  // The old container's restart came after result.json was written.
  expect(resultBeforeStart.length).toBeGreaterThan(0);
  expect(resultBeforeStart.every(Boolean)).toBe(true);
  expect(existsSync(join(w.dir, 'pending.json'))).toBe(false);
  expect(existsSync(join(w.dir, 'ok'))).toBe(false);
  expect(existsSync(join(w.dir, 'lock'))).toBe(false);
  expect(w.docker.images.has(OLD_IMAGE)).toBe(true);
  expect(w.docker.calls.some((c) => c[0] === 'tag')).toBe(false);
  expect(w.lines.some((l) => l.includes('docker start'))).toBe(true);
}

/** Records, at each start of the old container, whether result.json existed. */
function watchOldStart(w: World): boolean[] {
  const seen: boolean[] = [];
  w.docker.onCall = ([op, name]) => {
    if (op === 'start' && name === NAME && w.docker.containers.get(NAME)?.id === 'old-id')
      seen.push(existsSync(join(w.dir, 'result.json')));
  };
  return seen;
}

describe('runUpgrade: health is only the ok file', () => {
  test('an ok file with another version does not count', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) writeFileSync(join(w.dir, 'ok'), '0.5.1\n');
    };
    const seen = watchOldStart(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expectRolledBack(w, /did not confirm within 900 s/, seen);
  });

  test('a running container without ok does not count', async () => {
    const w = world();
    w.docker.onStart = () => {};
    const seen = watchOldStart(w);
    const start = w.clock.now;
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(w.clock.now - start).toBeGreaterThanOrEqual(900_000);
    expectRolledBack(w, /^the new stick did not confirm within 900 s$/, seen);
  });

  test('a restart count of 1 fails at once', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.restartCount = 1;
    };
    const seen = watchOldStart(w);
    const start = w.clock.now;
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(w.clock.now - start).toBeLessThan(30_000);
    expectRolledBack(w, /^the new stick restarted$/, seen);
  });
});

describe('runUpgrade: rollback (D2)', () => {
  test('start of the new container throws', async () => {
    const w = world();
    w.docker.fail = (op, name) =>
      op === 'start' && name === NAME && w.docker.containers.get(NAME)?.image === NEW_IMAGE
        ? new Error('port is already allocated')
        : undefined;
    const seen = watchOldStart(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expectRolledBack(w, /port is already allocated/, seen);
  });

  test('the new container stops', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.running = false;
    };
    const seen = watchOldStart(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expectRolledBack(w, /^the new stick stopped$/, seen);
  });

  test('the timeout passes', async () => {
    const w = world();
    w.docker.onStart = () => {};
    w.opts.timeoutSeconds = 60;
    const seen = watchOldStart(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expectRolledBack(w, /^the new stick did not confirm within 60 s$/, seen);
  });

  test('a create failure never stops the old stick', async () => {
    const w = world();
    w.docker.fail = (op) => (op === 'create' ? new Error('no space left on device') : undefined);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(w.docker.calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(w.docker.calls.some((c) => c[0] === 'rename')).toBe(false);
    expect(w.docker.containers.get(NAME)?.running).toBe(true);
    expect([...w.docker.containers.keys()]).toEqual([NAME]);
    expect(readResult(w)).toMatchObject({ result: 'failed', version: '0.6.0' });
    expect(readResult(w).reason).toMatch(/no space left on device/);
  });

  test('restore calls are retried: start throws twice, then the old stick is back', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.restartCount = 1;
    };
    let oldStarts = 0;
    w.docker.fail = (op, name) => {
      if (op === 'start' && name === NAME && w.docker.containers.get(NAME)?.id === 'old-id') {
        oldStarts += 1;
        if (oldStarts <= 2) return new Error('engine busy');
      }
      return undefined;
    };
    const seen = watchOldStart(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(oldStarts).toBe(3);
    expectRolledBack(w, /^the new stick restarted$/, seen);
  });

  test('a restore that never works reports "rollback failed" and keeps -previous', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.restartCount = 1;
    };
    w.docker.fail = (op, name) =>
      op === 'rename' && name === `${NAME}-previous` ? new Error('engine gone') : undefined;
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(readResult(w).reason).toMatch(/^rollback failed: .*engine gone/);
    expect(w.docker.containers.has(`${NAME}-previous`)).toBe(true);
    expect(w.docker.calls.some((c) => c[0] === 'remove' && c[1] === `${NAME}-previous`)).toBe(
      false,
    );
    expect(w.lines.some((l) => l.includes(`docker rename ${NAME}-previous ${NAME}`))).toBe(true);
  });

  test('an old container whose start always throws: "rollback failed", -previous kept', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.running = false;
    };
    w.docker.fail = (op, name) =>
      op === 'start' && name === NAME && w.docker.containers.get(NAME)?.id === 'old-id'
        ? new Error('engine busy')
        : undefined;
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(1);
    expect(readResult(w).reason).toMatch(/^rollback failed: .*engine busy/);
    // Renamed back, never removed: it is the old stick, only not started.
    const old = w.docker.containers.get(NAME);
    expect(old?.id).toBe('old-id');
    expect(w.docker.calls.some((c) => c[0] === 'remove' && c[1] === `${NAME}-previous`)).toBe(
      false,
    );
  });

  test('when renaming the old container back fails every time, -previous still exists', async () => {
    const w = world();
    w.docker.onStart = (c) => {
      if (c.image === NEW_IMAGE) c.restartCount = 1;
    };
    w.docker.fail = (op, name) =>
      op === 'start' && name === NAME && w.docker.containers.get(NAME)?.id === 'old-id'
        ? new Error('engine busy')
        : op === 'rename' && name === `${NAME}-previous`
          ? new Error('engine busy')
          : undefined;
    await runUpgrade(w.opts, w.deps);
    expect(readResult(w).reason).toMatch(/^rollback failed/);
    expect(w.docker.containers.has('jm-stick-previous')).toBe(true);
  });

  test('a long failure reason is cut to 500 characters', async () => {
    const w = world();
    w.docker.fail = (op) => (op === 'create' ? new Error('x'.repeat(2000)) : undefined);
    await runUpgrade(w.opts, w.deps);
    expect(readResult(w).reason.length).toBe(500);
  });
});

describe('runUpgrade: preconditions exit 2 and change nothing', () => {
  const cases: [string, (w: World) => void, RegExp][] = [
    ['no pending.json', () => {}, /pending/],
    ['pending.json names another version', () => {}, /pending/],
    ['the old container is missing', (w) => w.docker.containers.delete(NAME), /not found/],
    [
      'the old container is not running',
      (w) => {
        const c = w.docker.containers.get(NAME);
        if (c) c.running = false;
      },
      /not running/,
    ],
    ['the new image is missing', (w) => w.docker.images.delete(NEW_IMAGE), /image/],
    [
      'a running -previous',
      (w) =>
        w.docker.containers.set(`${NAME}-previous`, {
          id: 'prev',
          image: OLD_IMAGE,
          env: [],
          labels: {},
          hostConfig: {},
          running: true,
          restartCount: 0,
        }),
      /-previous is running/,
    ],
    [
      'a running -next',
      (w) =>
        w.docker.containers.set(`${NAME}-next`, {
          id: 'next',
          image: NEW_IMAGE,
          env: [],
          labels: {},
          hostConfig: {},
          running: true,
          restartCount: 0,
        }),
      /-next is running/,
    ],
  ];

  test.each(cases)('%s', async (how, setup, reason) => {
    const pending =
      how === 'no pending.json'
        ? null
        : how === 'pending.json names another version'
          ? '{"version":"0.7.0"}'
          : undefined;
    const w = world({ pending });
    setup(w);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(2);
    const mutating = ['create', 'stop', 'rename', 'start', 'remove', 'removeImage', 'tag'];
    expect(w.docker.calls.filter((c) => mutating.includes(c[0]))).toEqual([]);
    const result = readResult(w);
    expect(result).toMatchObject({ version: '0.6.0', result: 'failed' });
    expect(result.reason).toMatch(reason);
    expect(existsSync(join(w.dir, 'lock'))).toBe(false);
  });

  test('a stopped leftover -previous and -next, and a leftover ok, are removed first', async () => {
    const w = world();
    for (const suffix of ['previous', 'next'])
      w.docker.containers.set(`${NAME}-${suffix}`, {
        id: suffix,
        image: OLD_IMAGE,
        env: [],
        labels: {},
        hostConfig: {},
        running: false,
        restartCount: 0,
      });
    writeFileSync(join(w.dir, 'ok'), '0.6.0');
    let okAtCreate: boolean | undefined;
    w.docker.onCall = ([op]) => {
      if (op === 'create') okAtCreate = existsSync(join(w.dir, 'ok'));
    };
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(0);
    expect(okAtCreate).toBe(false);
    expect(w.docker.ops().slice(0, w.docker.ops().indexOf(`create ${NAME}-next`))).toEqual(
      expect.arrayContaining([`remove ${NAME}-previous`, `remove ${NAME}-next`]),
    );
  });
});

describe('runUpgrade: the lock (D3)', () => {
  test('two helpers together: one swaps, the other exits 3 and touches nothing', async () => {
    const w = world();
    const resultFile = join(w.dir, 'result.json');
    writeFileSync(resultFile, '{"version":"0.5.1","result":"ok"}\n');
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    w.docker.beforeCreate = () => held;
    const first = runUpgrade(w.opts, w.deps);
    const second = await runUpgrade(w.opts, w.deps);
    expect(second.exitCode).toBe(3);
    // The first helper is still mid-swap: the second changed nothing it relies on.
    expect(readFileSync(join(w.dir, 'pending.json'), 'utf8')).toBe('{"version":"0.6.0"}');
    expect(readFileSync(resultFile, 'utf8')).toBe('{"version":"0.5.1","result":"ok"}\n');
    expect(existsSync(join(w.dir, 'lock'))).toBe(true);
    release();
    expect((await first).exitCode).toBe(0);
    expect(w.docker.calls.filter((c) => c[0] === 'create')).toHaveLength(1);
    expect(readResult(w).result).toBe('ok');
  });

  test('a fresh lock: exit 3, pending.json and result.json untouched, nothing written', async () => {
    const w = world();
    const lock = join(w.dir, 'lock');
    const lockBody = `${new Date(w.clock.now - 60_000).toISOString()}\n`;
    writeFileSync(lock, lockBody);
    writeFileSync(join(w.dir, 'result.json'), 'previous result\n');
    writeFileSync(join(w.dir, 'helper.log'), 'the running helper\n');
    writeFileSync(join(w.dir, 'ok'), '0.6.0');
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(3);
    expect(w.docker.calls).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe(lockBody);
    expect(readFileSync(join(w.dir, 'result.json'), 'utf8')).toBe('previous result\n');
    expect(readFileSync(join(w.dir, 'pending.json'), 'utf8')).toBe('{"version":"0.6.0"}');
    expect(readFileSync(join(w.dir, 'helper.log'), 'utf8')).toBe('the running helper\n');
    expect(existsSync(join(w.dir, 'ok'))).toBe(true);
  });

  test('a lock older than the timeout plus 180 s is replaced and the swap runs', async () => {
    const w = world();
    const lock = join(w.dir, 'lock');
    writeFileSync(lock, `${new Date(w.clock.now - (900 + 181) * 1000).toISOString()}\n`);
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(0);
    expect(readResult(w).result).toBe('ok');
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock just younger than the timeout plus 180 s still holds', async () => {
    const w = world();
    writeFileSync(
      join(w.dir, 'lock'),
      `${new Date(w.clock.now - (900 + 179) * 1000).toISOString()}\n`,
    );
    const r = await runUpgrade(w.opts, w.deps);
    expect(r.exitCode).toBe(3);
  });
});

describe('runUpgrade: secrets', () => {
  test('no environment value reaches the logger or helper.log', async () => {
    const oldEnv = [
      'JM_JOIN_TOKEN=sentinel-9f3a',
      'JM_SERVER_URL=https://sentinel-host-7c1',
      'JM_IMAGE_SOURCE=server',
    ];
    for (const crash of [false, true]) {
      const w = world({ oldEnv });
      if (crash)
        w.docker.onStart = (c) => {
          if (c.image === NEW_IMAGE) c.restartCount = 1;
        };
      const r = await runUpgrade(w.opts, w.deps);
      expect(r.exitCode).toBe(crash ? 1 : 0);
      expect(w.docker.created?.Env).toContain('JM_JOIN_TOKEN=sentinel-9f3a');
      const file = readFileSync(join(w.dir, 'helper.log'), 'utf8');
      expect(w.lines.length).toBeGreaterThan(3);
      for (const text of [...w.lines, file]) {
        expect(text).not.toContain('sentinel-9f3a');
        expect(text).not.toContain('sentinel-host-7c1');
      }
    }
  });
});

describe('upgrade helper entry point', () => {
  // Needs `npx tsc -b` (CI's typecheck step), like the stick's main.js check.
  const dist = fileURLToPath(new URL('../dist/upgrade-helper.js', import.meta.url));

  test('the build emits dist/upgrade-helper.js, which refuses a bad command line', () => {
    expect(existsSync(dist), 'build first: npx tsc -b').toBe(true);
    const child = spawnSync(process.execPath, [dist, '--container', 'jm-stick'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.stderr).toContain('usage: ');
    expect(child.status).toBe(2);
  });
});

describe('the dockerode wiring', () => {
  test('splits a repo:tag for the tag call, a registry port included', async () => {
    const { splitRepoTag } = await import('./upgrade-docker.js');
    expect(splitRepoTag(INSTALLED_TAG)).toEqual({ repo: 'jumpmaster-stick', tag: 'installed' });
    expect(splitRepoTag('localhost:5000/s:1')).toEqual({ repo: 'localhost:5000/s', tag: '1' });
    expect(splitRepoTag('localhost:5000/s')).toEqual({ repo: 'localhost:5000/s', tag: 'latest' });
  });
});
