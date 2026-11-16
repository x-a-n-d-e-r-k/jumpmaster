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

  test('renderCompose refuses a published port that is not bound to 127.0.0.1', () => {
    const lock = { registry: 'ghcr.io/o', images: { 'jumpmaster-server': digest('1') } };
    const svc = (ports: string) =>
      `services:\n  a:\n    image: {{image jumpmaster-server}}\n    ports:\n${ports}`;
    expect(() => renderCompose(svc('      - "127.0.0.1:7420:7420"\n'), lock)).not.toThrow();
    for (const bad of [
      '      - "7420:7420"\n',
      '      - 0.0.0.0:7420:7420\n',
      '      - "[::]:1:1"\n',
    ])
      expect(() => renderCompose(svc(bad), lock), bad).toThrow(/not bound to 127\.0\.0\.1/);
    // The frozen M4 template (the upgrade smoke renders it) still renders.
    const m4 = readFileSync(join(ROOT, 'deploy/fixtures/m4-compose.yaml.tmpl'), 'utf8');
    expect(() => renderCompose(m4, fullLock())).not.toThrow();
  });

  describe('published ports: every syntax is checked, not only a bare block list (issue #215)', () => {
    const tmpl = readFileSync(join(ROOT, 'deploy/compose.yaml.tmpl'), 'utf8');
    const SHIPPED = /( +)ports:\n\1  - "127\.0\.0\.1:7420:7420"\n/;
    /** The real template with its ports block replaced (indent is the `ports:` key's). */
    const edit = (block: (indent: string) => string): string => {
      const m = SHIPPED.exec(tmpl);
      if (!m) throw new Error('the shipped ports block moved: update this test');
      return tmpl.replace(SHIPPED, block(m[1] as string));
    };
    /** What the rendered file actually publishes off loopback, read by a YAML parser. */
    const offLoopback = (rendered: string): string[] => {
      const doc = load(rendered) as { services: Record<string, Record<string, unknown>> };
      const bad: string[] = [];
      for (const [name, svc] of Object.entries(doc.services)) {
        if (svc.network_mode === 'host') bad.push(`${name}: host network`);
        for (const p of (svc.ports as unknown[] | undefined) ?? []) {
          if (
            typeof p === 'string'
              ? !p.startsWith('127.0.0.1:')
              : (p as { host_ip?: string }).host_ip !== '127.0.0.1'
          )
            bad.push(`${name}: ${JSON.stringify(p)}`);
        }
      }
      return bad;
    };
    const variants: [string, string][] = [
      [
        'a comment between ports: and its item',
        edit((i) => `${i}ports:\n${i}  # note\n${i}  - "7420:7420"\n`),
      ],
      [
        'a blank line between ports: and its item',
        edit((i) => `${i}ports:\n\n${i}  - "7420:7420"\n`),
      ],
      ['a comment after ports:', edit((i) => `${i}ports: # x\n${i}  - "7420:7420"\n`)],
      ['flow style', edit((i) => `${i}ports: ["0.0.0.0:7420:7420"]\n`)],
      [
        'long form with no host_ip',
        edit((i) => `${i}ports:\n${i}  - target: 7420\n${i}    published: 7420\n`),
      ],
      [
        'long form on another address',
        edit(
          (i) =>
            `${i}ports:\n${i}  - target: 7420\n${i}    host_ip: 0.0.0.0\n${i}    published: 7420\n`,
        ),
      ],
      ['the host network', edit((i) => `${i}network_mode: host\n`)],
    ];
    const good: [string, string][] = [
      ['the shipped template', tmpl],
      ['flow style on loopback', edit((i) => `${i}ports: ["127.0.0.1:7420:7420"]\n`)],
      [
        'long form on loopback',
        edit(
          (i) =>
            `${i}ports:\n${i}  - target: 7420\n${i}    host_ip: 127.0.0.1\n${i}    published: 7420\n`,
        ),
      ],
    ];

    for (const [what, text] of variants)
      test(`refuses ${what}`, () => {
        expect(() => renderCompose(text, fullLock())).toThrow(
          /not bound to 127\.0\.0\.1|uses the host network/,
        );
      });
    for (const [what, text] of good)
      test(`accepts ${what}`, () => {
        expect(() => renderCompose(text, fullLock())).not.toThrow();
      });

    test('the renderer and a YAML parser agree on every variant (D5)', () => {
      for (const [what, text] of [...variants, ...good]) {
        const rendered = text.replace(
          /\{\{image ([a-z-]+)\}\}/g,
          'ghcr.io/o/$1@sha256:' + '0'.repeat(64),
        );
        let refused = false;
        try {
          renderCompose(text, fullLock());
        } catch {
          refused = true;
        }
        expect(refused, what).toBe(offLoopback(rendered).length > 0);
      }
    });

    test('the shipped template publishes exactly one port, on loopback', () => {
      const doc = load(renderCompose(tmpl, fullLock())) as {
        services: Record<string, { ports?: unknown[] }>;
      };
      const ports = Object.values(doc.services).flatMap((s) => s.ports ?? []);
      expect(ports).toEqual(['127.0.0.1:7420:7420']);
    });
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
