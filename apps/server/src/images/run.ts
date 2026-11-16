// The image mirror as the server runs it (issue #140): from the release lock (the server image's
// `/app/images.lock.json`, or `JM_IMAGES_LOCK`), on start and again whenever the lock file
// changes. The lock is a local file the operator replaces by upgrading the server; the registry is
// never asked what is newer.
import { unwatchFile, watchFile } from 'node:fs';
import { IMAGE_LOCK_PATH, type ImageLockFile, loadImageLock } from '../presets.js';
import { ImageMirror, type MirrorDeps } from './mirror.js';

/** How often the lock file's stat is compared, for a lock replaced while the server runs. */
const LOCK_WATCH_MS = 60_000;

export const imageLockPath = (env: NodeJS.ProcessEnv): string =>
  env.JM_IMAGES_LOCK || IMAGE_LOCK_PATH;

export type ImageMirrorRun = {
  mirror: ImageMirror;
  /** Reads the lock again and, when it names other images, mirrors them. */
  reload(): void;
  stop(): void;
};

export function startImageMirror(
  deps: MirrorDeps & { lockPath: string; watch?: false },
): ImageMirrorRun {
  const log = deps.log ?? ((line: string) => console.error(`[jumpmaster] ${line}`));
  const mirror = new ImageMirror({ ...deps, log });
  let last: string | undefined;
  const reload = () => {
    let lock: ImageLockFile | undefined;
    try {
      lock = loadImageLock(deps.lockPath);
    } catch (e) {
      // A malformed lock stops nothing here: the mirror keeps the lock it had.
      log(`image mirror: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const key = JSON.stringify(lock ?? null);
    if (key === last) return;
    last = key;
    mirror.setLock(lock);
    if (lock) mirror.start();
  };
  reload();
  if (deps.watch !== false)
    watchFile(deps.lockPath, { interval: LOCK_WATCH_MS, persistent: false }, () => reload());
  return {
    mirror,
    reload,
    stop() {
      if (deps.watch !== false) unwatchFile(deps.lockPath);
      mirror.stop();
    },
  };
}
