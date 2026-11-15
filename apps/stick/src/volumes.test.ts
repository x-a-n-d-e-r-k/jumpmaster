import { expect, test } from 'vitest';
import { DockerDriver } from './docker.js';
import { prepareVolume, REPO_MOUNT, volumeLabels, volumeName } from './volumes.js';

test('volume names carry the drop, the epoch and an 8-hex nonce', () => {
  expect(volumeName('d1', 3, '0123abcd')).toBe('jm-drop-d1-3-0123abcd');
  expect(volumeName('d1', 3)).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
  expect(volumeName('d1', 3)).not.toBe(volumeName('d1', 3));
  expect(() => volumeName('d1', 3, 'xyz')).toThrow(/nonce/);
  expect(volumeLabels('s1', 'd1', 3)).toEqual({
    'jumpmaster.stick': 's1',
    'jumpmaster.drop': 'd1',
    'jumpmaster.epoch': '3',
    'jumpmaster.volume': '1',
  });
});

/** A fake engine: volumes (some existing), and an init container exiting with `exitCode`. */
function engine(o: { existing?: Record<string, string>[]; exitCode?: number } = {}) {
  const calls: { kind: string; o?: unknown; id?: string }[] = [];
  const removed = new Set<string>();
  const docker = {
    async listVolumes(q: unknown) {
      calls.push({ kind: 'listVolumes', o: q });
      return { Volumes: (o.existing ?? []).map((Labels, i) => ({ Name: `old${i}`, Labels })) };
    },
    async createVolume(c: unknown) {
      calls.push({ kind: 'createVolume', o: c });
      return {};
    },
    getVolume(name: string) {
      return {
        async remove() {
          calls.push({ kind: 'removeVolume', id: name });
        },
      };
    },
    async createContainer(c: { name: string }) {
      calls.push({ kind: 'createContainer', o: c });
      return {
        id: c.name,
        async wait() {
          return { StatusCode: o.exitCode ?? 0 };
        },
        async start() {
          calls.push({ kind: 'startContainer', id: c.name });
        },
      };
    },
    getContainer(id: string) {
      return {
        async remove(r: unknown) {
          calls.push({ kind: 'removeContainer', id, o: r });
          removed.add(id);
        },
        async inspect() {
          if (removed.has(id)) throw Object.assign(new Error('gone'), { statusCode: 404 });
          return { Id: id };
        },
      };
    },
  };
  return { docker, calls };
}
const drop = { dropId: 'd1', epoch: 3, stickId: 's1', image: 'trooper@sha256:base' };

test('refuses a drop whose volume for this epoch exists', async () => {
  const { docker, calls } = engine({
    existing: [{ 'jumpmaster.drop': 'd1', 'jumpmaster.epoch': '3', 'jumpmaster.volume': '1' }],
  });
  await expect(prepareVolume(new DockerDriver(docker as never), drop)).rejects.toThrow(
    'volume exists for drop d1 epoch 3',
  );
  expect(calls).toEqual([
    { kind: 'listVolumes', o: { filters: { label: ['jumpmaster.drop=d1'] } } },
  ]);
  // Another epoch's volume of the same drop does not block this one.
  const other = engine({
    existing: [{ 'jumpmaster.drop': 'd1', 'jumpmaster.epoch': '2', 'jumpmaster.volume': '1' }],
  });
  await expect(prepareVolume(new DockerDriver(other.docker as never), drop)).resolves.toMatch(
    /^jm-drop-d1-3-[0-9a-f]{8}$/,
  );
});

test('prepareVolume runs a no-network CHOWN-only init container from the base image', async () => {
  const { docker, calls } = engine();
  const name = await prepareVolume(new DockerDriver(docker as never, { removePollMs: 1 }), drop);
  expect(name).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
  expect(calls.find((c) => c.kind === 'createVolume')?.o).toEqual({
    Name: name,
    Driver: 'local',
    Labels: {
      'jumpmaster.stick': 's1',
      'jumpmaster.drop': 'd1',
      'jumpmaster.epoch': '3',
      'jumpmaster.volume': '1',
    },
  });
  const init = calls.find((c) => c.kind === 'createContainer')?.o as {
    Image: string;
    name: string;
    User: string;
    Entrypoint: string[];
    Cmd?: unknown;
    Labels: Record<string, string>;
    HostConfig: Record<string, unknown>;
  };
  expect(init.Image).toBe('trooper@sha256:base');
  expect(init.name).toBe(`${name}-init`);
  expect(init.User).toBe('0:0');
  expect(init.Labels).toEqual({
    'jumpmaster.stick': 's1',
    'jumpmaster.drop': 'd1',
    'jumpmaster.epoch': '3',
  });
  expect(init.Entrypoint).toEqual([
    '/bin/sh',
    '-c',
    `chown 0:0 ${REPO_MOUNT} && chmod 0700 ${REPO_MOUNT} && chown 10001:10001 ${REPO_MOUNT}`,
  ]);
  expect(init.HostConfig).toEqual({
    NetworkMode: 'none',
    Privileged: false,
    CapDrop: ['ALL'],
    CapAdd: ['CHOWN'],
    SecurityOpt: ['no-new-privileges'],
    ReadonlyRootfs: true,
    PidsLimit: 64,
    Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }],
    Mounts: [
      {
        Type: 'volume',
        Source: name,
        Target: '/home/agent/repo',
        ReadOnly: false,
        VolumeOptions: { NoCopy: true },
      },
    ],
  });
  expect(init.HostConfig.Binds).toBeUndefined();
  // Started, then removed (and confirmed gone) before the volume is handed over.
  expect(calls.filter((c) => c.kind !== 'listVolumes').map((c) => c.kind)).toEqual([
    'createVolume',
    'createContainer',
    'startContainer',
    'removeContainer',
  ]);
});

test('a failed init container fails the drop and removes its volume', async () => {
  const { docker, calls } = engine({ exitCode: 1 });
  await expect(
    prepareVolume(new DockerDriver(docker as never, { removePollMs: 1 }), drop),
  ).rejects.toThrow(/volume init failed for drop d1 epoch 3: exit 1/);
  const created = (calls.find((c) => c.kind === 'createVolume')?.o as { Name: string }).Name;
  expect(calls.at(-1)).toEqual({ kind: 'removeVolume', id: created });
});
