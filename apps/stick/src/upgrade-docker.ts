// The upgrade helper's Docker calls (issue #429), on dockerode.
import Docker from 'dockerode';
import type { ContainerSpec, UpgradeDocker } from './upgrade-helper.js';

const statusOf = (e: unknown): number | undefined => (e as { statusCode?: number }).statusCode;

/** Undefined for a 404; any other error is thrown. */
async function orMissing<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (e) {
    if (statusOf(e) === 404) return undefined;
    throw e;
  }
}

/** Ignores 304 (already started, already stopped). */
async function idempotent(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (e) {
    if (statusOf(e) !== 304) throw e;
  }
}

/** `repo:tag` (the repository may hold a registry port) split for the tag call. */
export function splitRepoTag(repoTag: string): { repo: string; tag: string } {
  const colon = repoTag.lastIndexOf(':');
  if (colon > repoTag.lastIndexOf('/')) {
    return { repo: repoTag.slice(0, colon), tag: repoTag.slice(colon + 1) };
  }
  return { repo: repoTag, tag: 'latest' };
}

export function dockerUpgrade(socketPath: string): UpgradeDocker {
  const docker = new Docker({ socketPath });
  return {
    async inspectContainer(name) {
      const c = await orMissing(() => docker.getContainer(name).inspect());
      if (!c) return undefined;
      return {
        id: c.Id,
        imageId: c.Image,
        env: c.Config.Env ?? [],
        labels: c.Config.Labels ?? {},
        hostConfig: c.HostConfig as unknown as Record<string, unknown>,
        running: c.State.Running,
        restartCount: c.RestartCount,
      };
    },
    async inspectImage(id) {
      const i = await orMissing(() => docker.getImage(id).inspect());
      if (!i) return undefined;
      return { id: i.Id, env: i.Config.Env ?? [], labels: i.Config.Labels ?? {} };
    },
    async create(name: string, spec: ContainerSpec) {
      await docker.createContainer({
        name,
        Image: spec.Image,
        Env: spec.Env,
        Labels: spec.Labels,
        HostConfig: spec.HostConfig as Docker.HostConfig,
      });
    },
    start: (name) => idempotent(() => docker.getContainer(name).start()),
    stop: (name, t) => idempotent(() => docker.getContainer(name).stop({ t })),
    async rename(name, newName) {
      await docker.getContainer(name).rename({ name: newName });
    },
    async remove(name) {
      await docker.getContainer(name).remove();
    },
    async removeImage(id) {
      await docker.getImage(id).remove({ force: false });
    },
    async tag(imageId, repoTag) {
      await docker.getImage(imageId).tag(splitRepoTag(repoTag));
    },
  };
}
