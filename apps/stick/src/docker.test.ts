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
