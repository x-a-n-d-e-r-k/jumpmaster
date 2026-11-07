import { expect, test } from 'vitest';
import { DockerDriver } from './docker.js';

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
