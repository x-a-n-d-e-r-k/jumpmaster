import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_PREFIX, type DropPayload, type GateResult } from '@jumpmaster/protocol';
import { beforeEach, describe, expect, test } from 'vitest';
import type { TrooperDeps } from './main.js';
import type { RoleCtx } from './roles/shared.js';
import { artifactLines, runVerification, sniffMediaType } from './verification.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

let dir: string;
let ctx: RoleCtx;
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'jm-verify-'));
  mkdirSync(join(dir, 'shots'));
  ctx = {
    workdir: mkdtempSync(join(realpathSync(tmpdir()), 'jm-verify-work-')),
    secrets: ['token-value'],
    ids: null,
  };
});

const payload = (over: Partial<DropPayload> = {}) =>
  ({
    role: 'review',
    repo: { owner: 'o', name: 'r', defaultBranch: 'main' },
    verification: [
      {
        name: 'ui',
        paths: ['apps/web/**'],
        run: 'make shots',
        artifacts: 'shots/**',
        timeoutMinutes: 5,
      },
    ],
    ...over,
  }) as unknown as DropPayload;

function fakeDeps(changed: string[], gate: Partial<GateResult> = {}, write?: () => void) {
  const state = { ran: [] as string[], extra: undefined as unknown, lines: [] as string[] };
  const deps = {
    git: { changedPaths: async () => changed },
    runGates: async (gates: { name: string; run: string }[], o: { extraEnv?: unknown }) => {
      state.ran.push(...gates.map((g) => g.run));
      state.extra = o.extraEnv;
      write?.();
      return gates.map((g) => ({
        name: g.name,
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
        outputTail: '',
        ...gate,
      }));
    },
    emit: (l: string) => void state.lines.push(l),
  } as unknown as TrooperDeps;
  return { deps, state };
}

describe('runVerification', () => {
  test('a diff matching no glob runs nothing and passes', async () => {
    const f = fakeDeps(['docs/a.md']);
    const r = await runVerification(payload(), f.deps, ctx, dir);
    expect(r).toEqual({ ok: true, files: [] });
    expect(f.state.ran).toEqual([]);
  });

  test('a matching diff runs the step and collects a real image', async () => {
    const f = fakeDeps(['apps/web/a.tsx'], {}, () => writeFileSync(join(dir, 'shots/a.png'), PNG));
    const r = await runVerification(payload(), f.deps, ctx, dir);
    expect(f.state.ran).toEqual(['make shots']);
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ rule: 'ui', name: 'shots/a.png', mediaType: 'image/png' });
    expect(readFileSync(r.files[0]?.path ?? '')).toEqual(PNG);
  });

  test('a matching diff with no artifacts fails naming the rule', async () => {
    const r = await runVerification(payload(), fakeDeps(['apps/web/a.tsx']).deps, ctx, dir);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/ui produced no artifacts/),
    });
  });

  test('the step gets the same scrubbed environment as gates, so tools on PATH work', async () => {
    let env: NodeJS.ProcessEnv = {};
    const f = fakeDeps(['apps/web/a.tsx'], {}, () => writeFileSync(join(dir, 'shots/a.png'), PNG));
    const run = f.deps.runGates;
    f.deps.runGates = (gates, o) => {
      env = o.env;
      return run(gates, o);
    };
    process.env.JM_TEST_LEAK = 'x';
    await runVerification(payload(), f.deps, ctx, dir);
    delete process.env.JM_TEST_LEAK;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.JM_TEST_LEAK).toBeUndefined();
  });

  test('a failing step fails verification', async () => {
    const f = fakeDeps(['apps/web/a.tsx'], { exitCode: 2 });
    const r = await runVerification(payload(), f.deps, ctx, dir);
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/ui failed/) });
  });

  test('a false extension, a symlink or an oversized file is refused', async () => {
    const f = fakeDeps(['apps/web/a.tsx'], {}, () => {
      writeFileSync(join(dir, 'shots/fake.png'), 'not an image');
      writeFileSync(join(dir, 'secret.txt'), 'x');
      symlinkSync(join(dir, 'secret.txt'), join(dir, 'shots/link.png'));
      writeFileSync(
        join(dir, 'shots/huge.png'),
        Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]),
      );
    });
    const r = await runVerification(payload(), f.deps, ctx, dir);
    expect(r.ok).toBe(false);
    expect(r.files).toEqual([]);
  });

  test('at most ten files are kept', async () => {
    const f = fakeDeps(['apps/web/a.tsx'], {}, () => {
      for (let i = 0; i < 12; i++) writeFileSync(join(dir, `shots/${i}.png`), PNG);
    });
    const r = await runVerification(payload(), f.deps, ctx, dir);
    expect(r.files).toHaveLength(10);
  });
});

describe('artifactLines', () => {
  test('a 5 MB artifact crosses in chunks that fit under the event cap and reassemble', () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const lines = artifactLines({
      rule: 'ui',
      name: 'a.png',
      mediaType: 'image/png',
      sha256,
      bytes,
    });
    expect(lines.length).toBeGreaterThan(1);
    const parts = lines.map((l) => {
      expect(l.startsWith(ARTIFACT_PREFIX)).toBe(true);
      expect(Buffer.byteLength(l)).toBeLessThan(64 * 1024);
      return JSON.parse(l.slice(ARTIFACT_PREFIX.length));
    });
    expect(parts[0]).toMatchObject({ sha256, index: 0, total: lines.length });
    const whole = Buffer.concat(parts.map((p) => Buffer.from(p.data, 'base64')));
    expect(whole.equals(bytes)).toBe(true);
  });
});

test('sniffMediaType goes by content', () => {
  expect(sniffMediaType(PNG)).toBe('image/png');
  expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniffMediaType(Buffer.from('RIFF0000WEBPVP8 '))).toBe('image/webp');
  expect(sniffMediaType(Buffer.from('{"a":1}'))).toBe('application/json');
  expect(sniffMediaType(Buffer.from('<svg onload=x>'))).toBeNull();
  expect(sniffMediaType(Buffer.from('{broken'))).toBeNull();
});
