// Issue #168 against a real engine: the tar the stick builds from a server layout loads on
// Docker's containerd image store so that `<registry>/<name>@<index digest>` resolves, with the
// index digest as its id. Skipped without Docker, or on the classic image store (which refuses
// digest names, as documented).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bindLayout, loadTar, stickPlatform } from './fetch-image.js';
import { sha, tar } from './test/layout.js';

const docker = (args: string[], input?: Buffer) =>
  spawnSync('docker', args, { encoding: 'utf8', ...(input ? { input } : {}), timeout: 60_000 });

const HAS_DOCKER = docker(['version', '--format', '{{.Server.Version}}']).status === 0;
const CONTAINERD_STORE =
  HAS_DOCKER &&
  docker(['info', '--format', '{{json .DriverStatus}}']).stdout.includes(
    'io.containerd.snapshotter',
  );

/** A tiny one-layer image for this host's platform, plus another platform's entry, laid out. */
function layout(dir: string) {
  const blobs = join(dir, 'blobs', 'sha256');
  mkdirSync(blobs, { recursive: true });
  const put = (b: Buffer) => {
    const d = sha(b);
    writeFileSync(join(blobs, d.slice(7)), b);
    return d;
  };
  const [os, architecture] = stickPlatform().split('/') as [string, string];
  const layer = tar([{ name: 'hello', body: Buffer.from(`jm-168 ${Date.now()}\n`) }]);
  const config = Buffer.from(
    JSON.stringify({
      architecture,
      os,
      config: { Cmd: ['/hello'] },
      rootfs: { type: 'layers', diff_ids: [sha(layer)] },
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: put(config),
        size: config.length,
      },
      layers: [
        {
          mediaType: 'application/vnd.oci.image.layer.v1.tar',
          digest: put(layer),
          size: layer.length,
        },
      ],
    }),
  );
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: put(manifest),
          size: manifest.length,
          platform: { os, architecture },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${'7'.repeat(64)}`,
          size: 10,
          platform: { os, architecture: architecture === 'arm64' ? 'amd64' : 'arm64' },
        },
      ],
    }),
  );
  return put(index);
}

describe('real Docker (issue #168)', () => {
  test.skipIf(!CONTAINERD_STORE)(
    'docker load of the stick-built tar, then docker image inspect <name>@<index digest> (skipped without Docker on the containerd image store)',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jm-168-'));
      const digest = layout(dir);
      const ref = `localhost/jm-issue-168@${digest}`;
      try {
        const chunks: Buffer[] = [];
        for await (const c of loadTar(dir, bindLayout(dir, digest, stickPlatform()), ref))
          chunks.push(c as Buffer);
        const loaded = docker(['load'], Buffer.concat(chunks));
        expect(loaded.status, loaded.stderr).toBe(0);
        expect(loaded.stdout).toContain(`Loaded image: ${ref}`);
        const inspect = docker(['image', 'inspect', '-f', '{{.Id}}', ref]);
        expect(inspect.status, inspect.stderr).toBe(0);
        expect(inspect.stdout.trim()).toBe(digest);
      } finally {
        docker(['image', 'rm', '-f', ref]);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
