// Helpers shared by the repository-level tests (pins, images). Not a test file, so importing it
// registers no tests.
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Files allowed to name local images (built on the same machine just before), and the only local
 * images each may name. Every other image reference must be an @sha256 digest.
 */
export const LOCAL_IMAGE_FILES: Record<string, { images: string[]; reason: string }> = {
  'images/trooper/e2e/Dockerfile': {
    images: ['jumpmaster-trooper:dev'],
    reason: 'test layer over the trooper image that run.sh builds locally just before',
  },
  'images/trooper/examples/Dockerfile.pnpm': {
    images: ['jumpmaster-trooper:dev'],
    reason: 'example zone image built by the operator on top of their locally built trooper',
  },
  'images/smoke.sh': {
    images: ['jumpmaster-server:dev', 'jumpmaster-stick:dev', 'jumpmaster-trooper:dev'],
    reason:
      'runs the server and stick images images.yml builds in the step before; the trooper tag is only a name in an observe-mode zone config that never runs a drop',
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

export type Instruction = { op: string; args: string; line: number; end: number };

/**
 * Dockerfile instructions with line continuations joined and comment lines dropped (including
 * comment lines inside a continuation, as Docker does). `line` is the 1-based first line, `end`
 * the last. Parser directives are comments here; read them with `directives()`.
 */
export function instructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  let pending = '';
  let start = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith('#') || (pending === '' && line === '')) return;
    if (pending === '') start = i + 1;
    pending += (pending ? ' ' : '') + line.replace(/\\$/, '').trim();
    if (line.endsWith('\\')) return;
    const [op = '', ...rest] = pending.split(/\s+/);
    out.push({ op: op.toUpperCase(), args: rest.join(' '), line: start, end: i + 1 });
    pending = '';
  });
  if (pending !== '') {
    const [op = '', ...rest] = pending.split(/\s+/);
    out.push({
      op: op.toUpperCase(),
      args: rest.join(' '),
      line: start,
      end: text.split('\n').length,
    });
  }
  return out;
}

/** Leading parser directives (`# syntax=…`, `# escape=…`), keyed in lower case, with lines. */
export function directives(text: string): { key: string; value: string; line: number }[] {
  const out: { key: string; value: string; line: number }[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const m = /^#\s*([a-zA-Z]+)\s*=\s*(\S*)\s*$/.exec(raw.trim());
    if (!m) break;
    out.push({ key: (m[1] as string).toLowerCase(), value: m[2] as string, line: i + 1 });
  }
  return out;
}
