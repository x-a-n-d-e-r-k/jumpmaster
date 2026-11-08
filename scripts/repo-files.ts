// Helpers shared by the repository-level tests (pins, images). Not a test file, so importing it
// registers no tests.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Files allowed to build FROM a local image, and the one local image each may name. */
export const LOCAL_IMAGE_FILES: Record<string, { image: string; reason: string }> = {
  'images/trooper/e2e/Dockerfile': {
    image: 'jumpmaster-trooper:dev',
    reason: 'test layer over the trooper image that run.sh builds locally just before',
  },
  'images/trooper/examples/Dockerfile.pnpm': {
    image: 'jumpmaster-trooper:dev',
    reason: 'example zone image built by the operator on top of their locally built trooper',
  },
};

/** Repository-relative paths of every file under the given roots (missing roots are skipped). */
export function walk(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const child = join(abs, name);
      if (statSync(child).isDirectory()) visit(child);
      else out.push(relative(root, child).split(sep).join('/'));
    }
  };
  for (const dir of dirs) {
    try {
      if (statSync(join(root, dir)).isDirectory()) visit(join(root, dir));
    } catch {
      // Not created yet.
    }
  }
  return out.sort();
}
