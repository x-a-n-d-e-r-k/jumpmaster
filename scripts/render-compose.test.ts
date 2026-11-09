import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { RELEASE_IMAGES, renderCompose } from './render-compose.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = 'deploy/compose.yaml.tmpl';
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const fullLock = () => ({
  registry: 'ghcr.io/some-owner',
  images: Object.fromEntries(
    RELEASE_IMAGES.map((name, i) => [name, digest('abcdef0'[i] as string)]),
  ),
});

describe('renderCompose', () => {
  test('renderCompose pins every image by digest and throws on a leftover placeholder or missing lock entry', () => {
    const tmpl = 'services:\n  a:\n    image: {{image jumpmaster-server}}\n';
    const lock = { registry: 'ghcr.io/o', images: { 'jumpmaster-server': digest('1') } };
    expect(renderCompose(tmpl, lock)).toBe(
      `services:\n  a:\n    image: ghcr.io/o/jumpmaster-server@${digest('1')}\n`,
    );
    // A placeholder the lock can't fill.
    expect(() => renderCompose('image: {{image jumpmaster-stick}}\n', lock)).toThrow(
      /no jumpmaster-stick/,
    );
    // Any other leftover placeholder.
    expect(() => renderCompose(`${tmpl}x: {{version}}\n`, lock)).toThrow(/placeholder/);
    expect(() => renderCompose(`${tmpl}x: "{{ image jumpmaster-server }}"\n`, lock)).toThrow(
      /placeholder/,
    );
    // An image written into the template by hand without a digest.
    expect(() => renderCompose(`${tmpl}  b:\n    image: postgres:16\n`, lock)).toThrow(
      /postgres:16 is not pinned by digest/,
    );
    expect(() => renderCompose(`${tmpl}  b:\n    image: "\${X:-postgres:16}"\n`, lock)).toThrow(
      /not pinned by digest/,
    );
    // A lock that isn't a lock.
    expect(() =>
      renderCompose(tmpl, { registry: 'ghcr.io/o', images: { 'jumpmaster-server': 'latest' } }),
    ).toThrow(/not a sha256 digest/);
    expect(() => renderCompose(tmpl, { registry: 'ghcr.io/o?x', images: {} })).toThrow(/registry/);
  });

  test('the shipped template renders to a compose file with every service image by digest', () => {
    const tmpl = readFileSync(join(ROOT, TEMPLATE), 'utf8');
    for (const name of ['jumpmaster-server', 'jumpmaster-stick'])
      expect(tmpl).toContain(`{{image ${name}}}`);
    const out = renderCompose(tmpl, fullLock());
    const doc = load(out) as { services: Record<string, { image: string }> };
    const images = Object.values(doc.services).map((s) => s.image);
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const image of images)
      expect(image).toMatch(/^ghcr\.io\/some-owner\/jumpmaster-[a-z-]+@sha256:[0-9a-f]{64}$/);
    // Only the stick mounts the Docker socket; the UI is on loopback only.
    const raw = load(out) as {
      services: Record<string, { volumes?: string[]; ports?: string[] }>;
    };
    const socket = Object.entries(raw.services)
      .filter(([, s]) => (s.volumes ?? []).some((v) => v.includes('docker.sock')))
      .map(([n]) => n);
    expect(socket).toEqual(['stick']);
    for (const s of Object.values(raw.services))
      for (const p of s.ports ?? []) expect(p).toMatch(/^127\.0\.0\.1:/);
  });

  test('the CLI renders a template with a lock file and fails closed on a bad lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-render-'));
    const lockFile = join(dir, 'images.lock.json');
    writeFileSync(lockFile, JSON.stringify(fullLock()));
    const ok = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/render-compose.ts'), join(ROOT, TEMPLATE), lockFile],
      { encoding: 'utf8' },
    );
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain(
      `ghcr.io/some-owner/jumpmaster-server@${fullLock().images['jumpmaster-server']}`,
    );
    writeFileSync(lockFile, JSON.stringify({ registry: 'ghcr.io/o', images: {} }));
    const bad = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/render-compose.ts'), join(ROOT, TEMPLATE), lockFile],
      { encoding: 'utf8' },
    );
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/no jumpmaster-/);
  });
});
