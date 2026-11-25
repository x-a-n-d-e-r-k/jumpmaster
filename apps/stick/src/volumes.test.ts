import { expect, test } from 'vitest';
import { DockerDriver } from './docker.js';
import type { ContainerDriver } from './driver.js';
import {
  createMirrorVolume,
  MIRROR_LABEL,
  MIRROR_MOUNT,
  mirrorVolumeLabels,
  mirrorVolumeName,
  prepareVolume,
  REPO_MOUNT,
  volumeLabels,
  volumeName,
} from './volumes.js';

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
function engine(
  o: { existing?: Record<string, string>[]; exitCode?: number; startError?: string } = {},
) {
  const calls: { kind: string; o?: unknown; id?: string }[] = [];
  const removed = new Set<string>();
  /** A wait on a container that never ran rejects once it is removed, as the engine's does. */
  const onRemove = new Map<string, () => void>();
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
        wait() {
          if (!o.startError) return Promise.resolve({ StatusCode: o.exitCode ?? 0 });
          return new Promise((_, reject) =>
            onRemove.set(c.name, () => reject(new Error('container removed'))),
          );
        },
        async start() {
          calls.push({ kind: 'startContainer', id: c.name });
          if (o.startError) throw new Error(o.startError);
        },
      };
    },
    getContainer(id: string) {
      return {
        async remove(r: unknown) {
          calls.push({ kind: 'removeContainer', id, o: r });
          removed.add(id);
          onRemove.get(id)?.();
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
  // The init container is gone before its volume is removed.
  expect(calls.filter((c) => c.kind !== 'listVolumes').map((c) => c.kind)).toEqual([
    'createVolume',
    'createContainer',
    'startContainer',
    'removeContainer',
    'removeVolume',
  ]);
  expect(calls.at(-1)).toEqual({ kind: 'removeVolume', id: created });
});

test('an init container that fails to start is removed, then its volume, with no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const { docker, calls } = engine({ startError: 'exec: "/bin/sh": not found' });
    await expect(
      prepareVolume(new DockerDriver(docker as never, { removePollMs: 1 }), drop),
    ).rejects.toThrow('/bin/sh');
    const created = (calls.find((c) => c.kind === 'createVolume')?.o as { Name: string }).Name;
    expect(calls.filter((c) => c.kind !== 'listVolumes')).toEqual([
      { kind: 'createVolume', o: expect.anything() },
      { kind: 'createContainer', o: expect.anything() },
      { kind: 'startContainer', id: `${created}-init` },
      { kind: 'removeContainer', id: `${created}-init`, o: { force: true } },
      { kind: 'removeVolume', id: created },
    ]);
    // Let any orphaned rejection surface.
    await new Promise((r) => setTimeout(r, 10));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('mirror volume names carry the drop, the epoch and an 8-hex nonce', () => {
  expect(MIRROR_LABEL).toBe('jumpmaster.mirror');
  expect(MIRROR_MOUNT).toBe('/jm/mirror');
  expect(mirrorVolumeName('d1', 3, '0123abcd')).toBe('jm-mirror-d1-3-0123abcd');
  expect(mirrorVolumeName('d1', 3)).toMatch(/^jm-mirror-d1-3-[0-9a-f]{8}$/);
  expect(mirrorVolumeName('d1', 3)).not.toBe(mirrorVolumeName('d1', 3));
  expect(() => mirrorVolumeName('d1', 3, 'xyz')).toThrow(/nonce/);
  expect(() => mirrorVolumeName('d1', 3, '0123ABCD')).toThrow(/nonce/);
});

test('mirror volume labels mark a mirror, never a repo volume', () => {
  const labels = mirrorVolumeLabels('s1', 'd1', 3);
  expect(labels).toEqual({
    'jumpmaster.stick': 's1',
    'jumpmaster.drop': 'd1',
    'jumpmaster.epoch': '3',
    'jumpmaster.mirror': '1',
  });
  expect(labels['jumpmaster.volume']).toBeUndefined();
});

/** An in-memory engine of volumes: enough for the volume functions that run no container. */
function volumeEngine(initial: { name: string; labels: Record<string, string> }[] = []) {
  const volumes = new Map(initial.map((v) => [v.name, v.labels]));
  const log: string[] = [];
  const driver = {
    async listVolumesByLabel(key: string, value: string) {
      return [...volumes]
        .filter(([, l]) => l[key] === value)
        .map(([name, labels]) => ({ name, labels }));
    },
    async createVolume(name: string, labels: Record<string, string>) {
      log.push(`createVolume ${name}`);
      volumes.set(name, labels);
    },
    async removeVolume(name: string) {
      log.push(`removeVolume ${name}`);
      volumes.delete(name);
    },
    async initVolume(o: { name: string }) {
      log.push(`initVolume ${o.name}`);
      return 0;
    },
  } as unknown as ContainerDriver;
  return { driver, volumes, log };
}

test('createMirrorVolume creates one labelled mirror volume with no init, and refuses a second', async () => {
  const e = volumeEngine();
  const name = await createMirrorVolume(e.driver, { dropId: 'd1', epoch: 3, stickId: 's1' });
  expect(name).toMatch(/^jm-mirror-d1-3-[0-9a-f]{8}$/);
  expect(e.log).toEqual([`createVolume ${name}`]);
  expect(e.volumes.get(name)).toEqual(mirrorVolumeLabels('s1', 'd1', 3));
  await expect(
    createMirrorVolume(e.driver, { dropId: 'd1', epoch: 3, stickId: 's1' }),
  ).rejects.toThrow('mirror volume exists for drop d1 epoch 3');
  expect(e.log).toEqual([`createVolume ${name}`]);
  expect(e.volumes.size).toBe(1);
  // Another epoch, or the drop's repo volume, does not block a mirror.
  await expect(
    createMirrorVolume(e.driver, { dropId: 'd1', epoch: 4, stickId: 's1' }),
  ).resolves.toMatch(/^jm-mirror-d1-4-/);
  const r = volumeEngine([{ name: 'jm-drop-d2-1-0123abcd', labels: volumeLabels('s1', 'd2', 1) }]);
  await expect(
    createMirrorVolume(r.driver, { dropId: 'd2', epoch: 1, stickId: 's1' }),
  ).resolves.toMatch(/^jm-mirror-d2-1-/);
});

test('prepareVolume is not refused by a mirror volume, and still refuses a repo volume', async () => {
  const mirror = { name: 'jm-mirror-d1-3-0123abcd', labels: mirrorVolumeLabels('s1', 'd1', 3) };
  const e = volumeEngine([mirror]);
  const name = await prepareVolume(e.driver, drop);
  expect(name).toMatch(/^jm-drop-d1-3-[0-9a-f]{8}$/);
  expect(e.volumes.get(name)).toEqual(volumeLabels('s1', 'd1', 3));
  // Now the repo volume exists too: a second one is refused, the mirror untouched.
  await expect(prepareVolume(e.driver, drop)).rejects.toThrow('volume exists for drop d1 epoch 3');
  expect(e.volumes.size).toBe(2);
  expect(e.volumes.has(mirror.name)).toBe(true);
});
