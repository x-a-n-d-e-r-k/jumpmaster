import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
/** The migration is the one non-test source that may name the old ready label. */
const MIGRATION = 'apps/server/src/config/ready-label.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'dist', 'test'].includes(e.name) ? [] : sources(p);
    return /\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

test("no non-test source outside the migration names the literal 'agent-ready' (#198)", () => {
  const files = ['apps', 'packages'].flatMap((d) => sources(join(ROOT, d)));
  expect(files.length).toBeGreaterThan(50);
  expect(files.map((f) => relative(ROOT, f))).toContain(MIGRATION);
  const named = files
    .filter((f) => relative(ROOT, f) !== MIGRATION)
    .filter((f) => /agent-ready/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(ROOT, f));
  expect(named).toEqual([]);
});
