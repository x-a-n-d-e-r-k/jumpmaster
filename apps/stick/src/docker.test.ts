import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { DockerDriver, ownContainerId, pullRef } from './docker.js';

test('listByLabel queries all containers (incl. stopped) by exact label', async () => {
  const seen: unknown[] = [];
  const docker = {
    async listContainers(o: unknown) {
      seen.push(o);
      return [{ Id: 'c1' }, { Id: 'c2' }];
    },
  };
  const d = new DockerDriver(docker as never);
  expect(await d.listByLabel('jumpmaster.stick', 's1')).toEqual(['c1', 'c2']);
  expect(seen).toEqual([{ all: true, filters: { label: ['jumpmaster.stick=s1'] } }]);
});

test('remove force-removes the container', async () => {
  const calls: unknown[] = [];
  const docker = {
    getContainer(id: string) {
      return {
        async remove(o: unknown) {
          calls.push([id, o]);
        },
      };
    },
  };
  await new DockerDriver(docker as never).remove('c1');
  expect(calls).toEqual([['c1', { force: true }]]);
});

test('container create options drop all capabilities and set no-new-privileges', async () => {
  const seen: { HostConfig?: unknown }[] = [];
  const docker = {
    async createContainer(o: { HostConfig?: unknown }) {
      seen.push(o);
      throw new Error('stop here');
    },
  };
  await expect(
    new DockerDriver(docker as never).start({ image: 'img', name: 'n', labels: {} } as never),
  ).rejects.toThrow('stop here');
  expect(seen[0]?.HostConfig).toEqual({
    AutoRemove: true,
    Init: true,
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: ['SETUID', 'SETGID', 'KILL'],
    SecurityOpt: ['no-new-privileges'],
    PidsLimit: 512,
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
  });
});

function fakeDocker() {
  const calls: { kind: string; o?: unknown; id?: string }[] = [];
  const docker = {
    async createNetwork(o: { Name: string }) {
      calls.push({ kind: 'createNetwork', o });
      return {
        id: o.Name,
        async connect(c: unknown) {
          calls.push({ kind: 'connect', o: c });
        },
      };
    },
    getNetwork(id: string) {
      return {
        async remove() {
          calls.push({ kind: 'removeNetwork', id });
        },
      };
    },
    async listNetworks(o: unknown) {
      calls.push({ kind: 'listNetworks', o });
      return [{ Id: 'n1' }];
    },
    async createContainer(o: unknown) {
      calls.push({ kind: 'createContainer', o });
      return {
        id: 'side1',
        async start() {
          calls.push({ kind: 'startContainer' });
        },
      };
    },
    async listContainers() {
      return [{ Id: 'side1' }];
    },
    getContainer(id: string) {
      return {
        async remove(o: unknown) {
          calls.push({ kind: 'removeContainer', id, o });
        },
      };
    },
  };
  return { docker, calls };
}

const db = {
  name: 'db',
  image: 'postgres:16',
  port: 5432,
  env: { POSTGRES_PASSWORD: 'throwaway' },
};

test('sidecars run on an internal per-drop network with no published ports or mounts', async () => {
  const { docker, calls } = fakeDocker();
  const net = await new DockerDriver(docker as never).startServices('d1', 3, [db], { a: 'b' });
  expect(net).toBe('jm-drop-d1-3');
  expect(calls[0]).toEqual({
    kind: 'createNetwork',
    o: { Name: 'jm-drop-d1-3', Internal: true, Labels: { a: 'b' } },
  });
  const created = calls.find((c) => c.kind === 'createContainer')?.o as {
    Image: string;
    Env: string[];
    Labels: Record<string, string>;
    HostConfig: Record<string, unknown>;
    NetworkingConfig: unknown;
  };
  expect(created.Image).toBe('postgres:16');
  expect(created.Env).toEqual(['POSTGRES_PASSWORD=throwaway']);
  expect(created.Labels).toEqual({ a: 'b', 'jumpmaster.service': 'db' });
  expect(created.HostConfig).toEqual({
    NetworkMode: 'jm-drop-d1-3',
    Privileged: false,
    SecurityOpt: ['no-new-privileges'],
    PidsLimit: 512,
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
  });
  expect(created.NetworkingConfig).toEqual({
    EndpointsConfig: { 'jm-drop-d1-3': { Aliases: ['db'] } },
  });
});

test('an absent image tells the operator to pre-pull it', async () => {
  const { docker } = fakeDocker();
  docker.createContainer = async () => {
    throw Object.assign(new Error('no such image'), { statusCode: 404 });
  };
  await expect(new DockerDriver(docker as never).startServices('d1', 1, [db], {})).rejects.toThrow(
    /pull postgres:16/,
  );
});

test('removeServices removes the sidecars and network, and tolerates absence', async () => {
  const { docker, calls } = fakeDocker();
  const d = new DockerDriver(docker as never);
  await d.removeServices('jm-drop-d1-3', { 'jumpmaster.drop': 'd1' });
  expect(calls.map((c) => c.kind)).toEqual(['removeContainer', 'removeNetwork']);
});

test('removing a network retries while the trooper is still detaching', async () => {
  const { docker } = fakeDocker();
  let tries = 0;
  docker.getNetwork = () => ({
    async remove() {
      tries++;
      if (tries < 3) throw new Error('has active endpoints');
    },
  });
  const d = new DockerDriver(docker as never, { networkRetryMs: 1 });
  await d.removeServices('jm-drop-d1-3', {});
  expect(tries).toBe(3);
});

test('removing a network gives up quietly after its retries', async () => {
  const { docker } = fakeDocker();
  let tries = 0;
  docker.getNetwork = () => ({
    async remove() {
      tries++;
      throw new Error('has active endpoints');
    },
  });
  const d = new DockerDriver(docker as never, { networkRetryMs: 1 });
  await expect(d.removeServices('n', {})).resolves.toBeUndefined();
  expect(tries).toBe(5);
});

test('removeNetworksByLabel removes every matching network', async () => {
  const { docker, calls } = fakeDocker();
  expect(await new DockerDriver(docker as never).removeNetworksByLabel('k', 'v')).toBe(1);
  expect(calls.map((c) => c.kind)).toEqual(['listNetworks', 'removeNetwork']);
});

test('limits and a network reach the trooper container', async () => {
  const seen: { HostConfig?: Record<string, unknown> }[] = [];
  const docker = {
    async createContainer(o: { HostConfig?: Record<string, unknown> }) {
      seen.push(o);
      throw new Error('stop here');
    },
  };
  await expect(
    new DockerDriver(docker as never).start({
      image: 'i',
      name: 'n',
      labels: {},
      payload: '{}',
      limits: { pids: 4096, memoryMb: 8192, shmMb: 1024 },
    }),
  ).rejects.toThrow('stop here');
  expect(seen[0]?.HostConfig).toMatchObject({
    PidsLimit: 4096,
    Memory: 8192 * 1024 * 1024,
    MemorySwap: 8192 * 1024 * 1024, // equal to Memory: no swap on a shared host
    ShmSize: 1024 * 1024 * 1024,
  });
});

// ---- egress ----

const net = {
  name: 'jm-drop-d1-3',
  subnet: '172.30.0.16/28',
  gateway: '172.30.0.17',
  proxy: '172.30.0.18',
  trooper: '172.30.0.19',
  dns: '172.30.0.20',
  ipRange: '172.30.0.24/29',
};
const SYSCTLS = {
  'net.ipv6.conf.all.disable_ipv6': '1',
  'net.ipv6.conf.default.disable_ipv6': '1',
};

/** A fake engine for the egress calls: networks, containers that attach and start, images. */
function egressDocker(
  o: { existing?: unknown[]; conflicts?: number; outLabels?: Record<string, string> | null } = {},
) {
  const calls: { kind: string; o?: unknown; id?: string }[] = [];
  let conflicts = o.conflicts ?? 0;
  const out = o.outLabels === undefined ? null : o.outLabels;
  const docker = {
    async listNetworks(q?: { filters?: { name?: string[] } }) {
      calls.push({ kind: 'listNetworks', o: q });
      if (q?.filters?.name) return out === null ? [] : [{ Name: 'jm-egress-out', Labels: out }];
      return o.existing ?? [];
    },
    async createNetwork(c: { Name: string }) {
      calls.push({ kind: 'createNetwork', o: c });
      if (c.Name !== 'jm-egress-out' && conflicts-- > 0)
        throw Object.assign(new Error('Pool overlaps with other one on this address space'), {
          statusCode: 403,
        });
      return { id: c.Name };
    },
    getNetwork(id: string) {
      return {
        async connect(c: unknown) {
          calls.push({ kind: 'connect', id, o: c });
        },
        async remove() {
          calls.push({ kind: 'removeNetwork', id });
        },
      };
    },
    async createContainer(c: unknown) {
      calls.push({ kind: 'createContainer', o: c });
      const { PassThrough } = await import('node:stream');
      const stream = new PassThrough();
      return {
        id: 'c1',
        modem: {
          demuxStream(s: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
            s.on('data', (d: Buffer) => stdout.write(d));
          },
        },
        async attach() {
          return stream;
        },
        async start() {
          calls.push({ kind: 'startContainer' });
          stream.write('{"ready":true}\n');
        },
        async stop() {
          calls.push({ kind: 'stopContainer' });
          stream.end();
        },
        async wait() {
          return { StatusCode: 0 };
        },
      };
    },
    getImage(name: string) {
      return {
        async inspect() {
          if (name === 'present:1') return { Id: 'sha256:x' };
          if (name === 'labelled:1')
            return { Id: 'sha256:y', Config: { Labels: { 'org.jumpmaster.trooper.egress': '1' } } };
          if (name === 'nolabels:1') return { Id: 'sha256:z', Config: { Labels: null } };
          throw Object.assign(new Error('no such image'), { statusCode: 404 });
        },
      };
    },
  };
  return { docker, calls };
}

test('a drop network is internal, on a free /28 of the pool, with no gateway address on the host', async () => {
  const { docker, calls } = egressDocker({
    existing: [
      { Name: 'bridge', IPAM: { Config: [{ Subnet: '172.17.0.0/16' }] } },
      { Name: 'other', IPAM: { Config: [{ Subnet: '172.30.0.0/28' }, { Subnet: 'fd00::/64' }] } },
      { Name: 'none', IPAM: { Config: null } },
    ],
  });
  const got = await new DockerDriver(docker as never).createDropNetwork(
    'jm-drop-d1-3',
    { 'jumpmaster.stick': 's1' },
    '172.30.0.0/16',
  );
  expect(got).toEqual(net);
  const create = calls.find((c) => c.kind === 'createNetwork')?.o;
  expect(create).toEqual({
    Name: 'jm-drop-d1-3',
    Internal: true,
    CheckDuplicate: true,
    EnableIPv6: false,
    Labels: { 'jumpmaster.stick': 's1', 'jumpmaster.egress': 'drop' },
    Options: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
    IPAM: {
      Driver: 'default',
      Config: [{ Subnet: '172.30.0.16/28', IPRange: '172.30.0.24/29', Gateway: '172.30.0.17' }],
    },
  });
});

test('a subnet conflict at create retries with the next subnet', async () => {
  const { docker, calls } = egressDocker({ conflicts: 2 });
  const got = await new DockerDriver(docker as never).createDropNetwork('n', {}, '172.30.0.0/16');
  const subnets = calls
    .filter((c) => c.kind === 'createNetwork')
    .map((c) => (c.o as { IPAM: { Config: { Subnet: string }[] } }).IPAM.Config[0]?.Subnet);
  expect(subnets).toEqual(['172.30.0.0/28', '172.30.0.16/28', '172.30.0.32/28']);
  expect(got.subnet).toBe('172.30.0.32/28');
  // Any other create error is not retried.
  const bad = egressDocker();
  bad.docker.createNetwork = async () => {
    throw Object.assign(new Error('permission denied'), { statusCode: 500 });
  };
  await expect(
    new DockerDriver(bad.docker as never).createDropNetwork('n', {}, '172.30.0.0/16'),
  ).rejects.toThrow('permission denied');
});

test('with egress, the trooper and services join only the drop network with the dead DNS address', async () => {
  const { docker, calls } = egressDocker();
  const d = new DockerDriver(docker as never);
  await d.startServices('d1', 3, [db], { a: 'b' }, net);
  expect(calls.some((c) => c.kind === 'createNetwork')).toBe(false);
  const svc = calls.find((c) => c.kind === 'createContainer')?.o as {
    HostConfig: Record<string, unknown>;
    NetworkingConfig: unknown;
  };
  expect(svc.HostConfig).toMatchObject({
    NetworkMode: 'jm-drop-d1-3',
    Dns: ['172.30.0.20'],
    DnsOptions: ['timeout:1', 'attempts:1'],
    Sysctls: SYSCTLS,
  });
  expect(svc.NetworkingConfig).toEqual({
    EndpointsConfig: { 'jm-drop-d1-3': { Aliases: ['db'] } },
  });

  calls.length = 0;
  await d.start({
    image: 'i',
    name: 'n',
    labels: {},
    payload: '{}',
    network: net.name,
    egress: net,
  });
  const trooper = calls.find((c) => c.kind === 'createContainer')?.o as {
    HostConfig: Record<string, unknown>;
    NetworkingConfig: unknown;
  };
  expect(trooper.HostConfig).toMatchObject({
    NetworkMode: 'jm-drop-d1-3',
    Dns: ['172.30.0.20'],
    DnsOptions: ['timeout:1', 'attempts:1'],
    Sysctls: SYSCTLS,
    CapDrop: ['ALL'],
  });
  expect(trooper.NetworkingConfig).toEqual({
    EndpointsConfig: { 'jm-drop-d1-3': { IPAMConfig: { IPv4Address: '172.30.0.19' } } },
  });
  // Created on the drop network: never on the default bridge, never connected to a second one.
  expect(calls.some((c) => c.kind === 'connect')).toBe(false);
});

test('without egress the trooper keeps the M3 create options and joins services alongside', async () => {
  const { docker, calls } = egressDocker();
  await new DockerDriver(docker as never).start({
    image: 'i',
    name: 'n',
    labels: {},
    payload: '{}',
    network: 'jm-drop-d1-3',
  });
  const trooper = calls.find((c) => c.kind === 'createContainer')?.o as {
    HostConfig: Record<string, unknown>;
    NetworkingConfig?: unknown;
  };
  expect(trooper.HostConfig.NetworkMode).toBeUndefined();
  expect(trooper.HostConfig.Dns).toBeUndefined();
  expect(trooper.NetworkingConfig).toBeUndefined();
  expect(calls.filter((c) => c.kind === 'connect')).toEqual([
    { kind: 'connect', id: 'jm-drop-d1-3', o: { Container: 'c1' } },
  ]);
});

test('the proxy gets the static .2 address, the jm-egress alias, hardening and the shared exit', async () => {
  const { docker, calls } = egressDocker();
  const handle = await new DockerDriver(docker as never).startEgressProxy({
    name: 'jm-egress-d1-3',
    image: 'jumpmaster-egress:dev',
    net,
    env: { JM_EGRESS_BIND: '172.30.0.18', JM_EGRESS_MODE: 'enforce' },
    labels: { 'jumpmaster.drop': 'd1' },
  });
  const create = calls.find((c) => c.kind === 'createContainer')?.o as {
    Image: string;
    name: string;
    Env: string[];
    Labels: Record<string, string>;
    HostConfig: Record<string, unknown>;
    NetworkingConfig: unknown;
  };
  expect(create.Image).toBe('jumpmaster-egress:dev');
  expect(create.Env).toEqual(['JM_EGRESS_BIND=172.30.0.18', 'JM_EGRESS_MODE=enforce']);
  // Removed with the services by removeServices (same labels plus the service label).
  expect(create.Labels).toEqual({
    'jumpmaster.drop': 'd1',
    'jumpmaster.service': 'jm-egress',
    'jumpmaster.egress': 'proxy',
  });
  expect(create.HostConfig).toMatchObject({
    NetworkMode: 'jm-drop-d1-3',
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Privileged: false,
    PidsLimit: 64,
  });
  expect(create.NetworkingConfig).toEqual({
    EndpointsConfig: {
      'jm-drop-d1-3': { IPAMConfig: { IPv4Address: '172.30.0.18' }, Aliases: ['jm-egress'] },
    },
  });
  const out = calls.find((c) => c.kind === 'createNetwork')?.o;
  expect(out).toEqual({
    Name: 'jm-egress-out',
    CheckDuplicate: true,
    Labels: { 'jumpmaster.egress': 'out' },
    Options: { 'com.docker.network.bridge.enable_icc': 'false' },
  });
  expect(calls.filter((c) => c.kind === 'connect')).toEqual([
    { kind: 'connect', id: 'jm-egress-out', o: { Container: 'c1' } },
  ]);
  const kinds = calls.map((c) => c.kind);
  expect(kinds.indexOf('connect')).toBeLessThan(kinds.indexOf('startContainer'));
  const it = handle.logs()[Symbol.asyncIterator]();
  expect((await it.next()).value).toBe('{"ready":true}');
  await handle.stop();
  expect((await it.next()).done).toBe(true);
});

test('an existing jm-egress-out is reused only when it carries the jumpmaster label', async () => {
  const ours = egressDocker({ outLabels: { 'jumpmaster.egress': 'out' } });
  await new DockerDriver(ours.docker as never).startEgressProxy({
    name: 'p',
    image: 'i',
    net,
    env: {},
    labels: {},
  });
  expect(ours.calls.some((c) => c.kind === 'createNetwork')).toBe(false);
  const theirs = egressDocker({ outLabels: {} });
  await expect(
    new DockerDriver(theirs.docker as never).startEgressProxy({
      name: 'p',
      image: 'i',
      net,
      env: {},
      labels: {},
    }),
  ).rejects.toThrow(/jm-egress-out exists without/);
  expect(theirs.calls.some((c) => c.kind === 'startContainer')).toBe(false);
});

test('imageExists asks the engine; listNetworksByLabel returns names and labels', async () => {
  const { docker } = egressDocker({
    existing: [{ Name: 'jm-drop-d1-3', Labels: { 'jumpmaster.drop': 'd1' } }],
  });
  const d = new DockerDriver(docker as never);
  expect(await d.imageExists('present:1')).toBe(true);
  expect(await d.imageExists('absent:1')).toBe(false);
  expect(await d.listNetworksByLabel('jumpmaster.stick', 's1')).toEqual([
    { name: 'jm-drop-d1-3', labels: { 'jumpmaster.drop': 'd1' } },
  ]);
});

test('imageLabels reads the image config labels; none is empty, an absent image throws', async () => {
  const { docker } = egressDocker();
  const d = new DockerDriver(docker as never);
  expect(await d.imageLabels('labelled:1')).toEqual({ 'org.jumpmaster.trooper.egress': '1' });
  expect(await d.imageLabels('nolabels:1')).toEqual({});
  expect(await d.imageLabels('present:1')).toEqual({});
  await expect(d.imageLabels('absent:1')).rejects.toThrow(/no such image/);
});

const D = `sha256:${'a'.repeat(64)}`;

test('pullImage pulls the digest reference, reports progress and fails on an error line', async () => {
  const pulled: string[] = [];
  const docker = (body: string) => ({
    async pull(ref: string, o: { abortSignal?: AbortSignal }) {
      pulled.push(ref);
      expect(o.abortSignal).toBeInstanceOf(AbortSignal);
      return Readable.from([body]);
    },
  });
  const progress: unknown[] = [];
  const ok = new DockerDriver(
    docker('{"status":"Pulling fs layer"}\n{"status":"Digest: x"}\n') as never,
  );
  await ok.pullImage(`ghcr.io/o/x:v1@${D}`, (e) => progress.push(e), new AbortController().signal);
  expect(pulled).toEqual([`ghcr.io/o/x@${D}`]);
  expect(progress).toEqual([{ status: 'Pulling fs layer' }, { status: 'Digest: x' }]);
  const bad = new DockerDriver(
    docker(
      '{"status":"x"}\n{"errorDetail":{"message":"manifest unknown"},"error":"manifest unknown"}\n',
    ) as never,
  );
  await expect(
    bad.pullImage(`ghcr.io/o/x@${D}`, () => {}, new AbortController().signal),
  ).rejects.toThrow('manifest unknown');
  const aborted = new AbortController();
  aborted.abort();
  await expect(bad.pullImage(`ghcr.io/o/x@${D}`, () => {}, aborted.signal)).rejects.toThrow(
    'aborted',
  );
});

test('pullRef drops a tag before the digest and keeps a registry port', () => {
  expect(pullRef(`ghcr.io/o/x:v1@${D}`)).toBe(`ghcr.io/o/x@${D}`);
  expect(pullRef(`localhost:5000/o/x@${D}`)).toBe(`localhost:5000/o/x@${D}`);
  expect(pullRef(`localhost:5000/x:t@${D}`)).toBe(`localhost:5000/x@${D}`);
  expect(pullRef('x:1')).toBe('x:1');
});

test('the stick finds its own container id in its mounts, and its image through the engine', async () => {
  const id = 'f'.repeat(64);
  const mounts = [
    '1 0 0:1 / / rw - overlay overlay rw',
    `2 1 254:1 /docker/containers/${id}/resolv.conf /etc/resolv.conf rw - ext4 /dev/vda1 rw`,
    `3 1 254:1 /docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/vda1 rw`,
  ].join('\n');
  expect(ownContainerId(mounts)).toBe(id);
  expect(ownContainerId('1 0 0:1 / / rw - overlay overlay rw')).toBeUndefined();
  // A volume path that merely looks like a container directory doesn't count.
  expect(
    ownContainerId(`2 1 254:1 /data/containers/${id}/other /x rw - ext4 /dev/vda1 rw`),
  ).toBeUndefined();
});

test('the isolation probe runs the host side from the host image as nobody, the drop side from the drop image', async () => {
  const created: { Image: string; User?: string; HostConfig: { NetworkMode: string } }[] = [];
  const docker = {
    async createContainer(o: {
      Image: string;
      User?: string;
      HostConfig: { NetworkMode: string };
    }) {
      created.push(o);
      const host = o.HostConfig.NetworkMode === 'host';
      const line = host
        ? '{"listening":true,"addrs":["127.0.0.1"]}'
        : '{"connect":"ECONNREFUSED","v6":"1"}';
      return {
        modem: {
          demuxStream(_s: unknown, out: { write(c: Buffer): void }) {
            out.write(Buffer.from(`${line}\n`));
          },
        },
        async attach() {
          const r = new Readable({ read() {} });
          return r;
        },
        async start() {},
        async remove() {},
      };
    },
  };
  const net = {
    name: 'probe',
    subnet: '172.30.0.0/28',
    gateway: '172.30.0.1',
    proxy: '172.30.0.2',
    trooper: '172.30.0.3',
    dns: '172.30.0.4',
    ipRange: '172.30.0.8/29',
  };
  const facts = await new DockerDriver(docker as never).probeIsolation(net, {
    host: 'sha256:stick',
    drop: 'egress@sha256:e',
  });
  expect(facts).toEqual({
    listenerUp: true,
    gatewayOnHost: false,
    gatewayReachable: false,
    ipv6Disabled: true,
  });
  expect(created.map((c) => [c.Image, c.HostConfig.NetworkMode, c.User])).toEqual([
    ['sha256:stick', 'host', '65534:65534'],
    ['egress@sha256:e', 'probe', undefined],
    ['sha256:stick', 'host', '65534:65534'],
  ]);
});
