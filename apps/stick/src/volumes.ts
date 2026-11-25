import { randomBytes } from 'node:crypto';
import type { ContainerDriver } from './driver.js';

/** Where the drop's repo volume is mounted, in the agent and push containers alike. */
export const REPO_MOUNT = '/home/agent/repo';
/** Marks a volume as a drop's repo volume. */
export const VOLUME_LABEL = 'jumpmaster.volume';
/** Marks a volume as a drop's mirror volume (the clone container's read-only copy). */
export const MIRROR_LABEL = 'jumpmaster.mirror';
/** Where the drop's mirror volume is mounted, read-only, in the agent's container. */
export const MIRROR_MOUNT = '/jm/mirror';
/** How long `removeAndWait` waits for the engine to confirm a container is gone. */
export const REMOVE_TIMEOUT_MS = 60_000;
/** Below this much free space under the engine's root, the stick takes no pushing drop. */
export const VOLUME_FREE_FLOOR_BYTES = 10 * 2 ** 30;

/** An 8-hex volume nonce: the one given (checked), or a random one. */
function nonceOf(nonce?: string): string {
  const n = nonce ?? randomBytes(4).toString('hex');
  if (!/^[0-9a-f]{8}$/.test(n)) throw new Error(`volume nonce must be 8 hex characters: ${n}`);
  return n;
}

/** `jm-drop-<dropId>-<epoch>-<nonce>`, the nonce 8 hex characters (random unless given). */
export function volumeName(dropId: string, epoch: number, nonce?: string): string {
  return `jm-drop-${dropId}-${epoch}-${nonceOf(nonce)}`;
}

/** `jm-mirror-<dropId>-<epoch>-<nonce>`, the nonce as for `volumeName`. */
export function mirrorVolumeName(dropId: string, epoch: number, nonce?: string): string {
  return `jm-mirror-${dropId}-${epoch}-${nonceOf(nonce)}`;
}

const dropLabels = (stickId: string, dropId: string, epoch: number): Record<string, string> => ({
  'jumpmaster.stick': stickId,
  'jumpmaster.drop': dropId,
  'jumpmaster.epoch': String(epoch),
});

export function volumeLabels(
  stickId: string,
  dropId: string,
  epoch: number,
): Record<string, string> {
  return { ...dropLabels(stickId, dropId, epoch), [VOLUME_LABEL]: '1' };
}

/** A mirror volume's labels: never `jumpmaster.volume`, so salvage never sees one. */
export function mirrorVolumeLabels(
  stickId: string,
  dropId: string,
  epoch: number,
): Record<string, string> {
  return { ...dropLabels(stickId, dropId, epoch), [MIRROR_LABEL]: '1' };
}

/**
 * Creates the drop's mirror volume (no init container: the clone container fills it); returns
 * its name. Refuses a drop that already has a mirror volume for this epoch.
 */
export async function createMirrorVolume(
  driver: ContainerDriver,
  o: { dropId: string; epoch: number; stickId: string },
): Promise<string> {
  const existing = await driver.listVolumesByLabel('jumpmaster.drop', o.dropId);
  if (
    existing.some(
      (v) => v.labels[MIRROR_LABEL] === '1' && v.labels['jumpmaster.epoch'] === String(o.epoch),
    )
  )
    throw new Error(`mirror volume exists for drop ${o.dropId} epoch ${o.epoch}`);
  const name = mirrorVolumeName(o.dropId, o.epoch);
  await driver.createVolume(name, mirrorVolumeLabels(o.stickId, o.dropId, o.epoch));
  return name;
}

/**
 * Creates the drop's repo volume and runs the init container on it; returns the volume's name.
 * Refuses a drop that already has a volume for this epoch (a redelivery must not reuse or shadow
 * it); the drop's mirror volume does not count. A failed init removes the volume and throws.
 */
export async function prepareVolume(
  driver: ContainerDriver,
  o: { dropId: string; epoch: number; stickId: string; image: string },
): Promise<string> {
  const existing = await driver.listVolumesByLabel('jumpmaster.drop', o.dropId);
  if (
    existing.some(
      (v) => v.labels[MIRROR_LABEL] !== '1' && v.labels['jumpmaster.epoch'] === String(o.epoch),
    )
  )
    throw new Error(`volume exists for drop ${o.dropId} epoch ${o.epoch}`);
  const name = volumeName(o.dropId, o.epoch);
  const labels = volumeLabels(o.stickId, o.dropId, o.epoch);
  await driver.createVolume(name, labels);
  let exitCode: number;
  try {
    const { [VOLUME_LABEL]: _, ...initLabels } = labels;
    exitCode = await driver.initVolume({
      name: `${name}-init`,
      image: o.image,
      volume: name,
      labels: initLabels,
    });
  } catch (e) {
    await driver.removeVolume(name).catch(() => {});
    throw e;
  }
  if (exitCode !== 0) {
    await driver.removeVolume(name).catch(() => {});
    throw new Error(`volume init failed for drop ${o.dropId} epoch ${o.epoch}: exit ${exitCode}`);
  }
  return name;
}
