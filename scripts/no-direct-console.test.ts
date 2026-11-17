import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// Every server log line goes through `log` (apps/server/src/log.ts), which scrubs it: the
// configured secrets, the scrub set, and every token shape. A direct console call skips that, so
// this test fails on any console call, or direct stdout/stderr write, under apps/server/src outside
// the allow-list below. Each allowed line is listed by its exact text, so a second call in an
// allowed file still fails.

const root = join(import.meta.dirname, '..');
const SERVER_SRC = 'apps/server/src/';

/** A direct write to the console or to stdout/stderr. */
const DIRECT = /\bconsole\s*(?:\.\s*[A-Za-z_$]|\[)|\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\b/;

/** Allowed direct writes: the exact (trimmed) line, per file, and why. */
export const ALLOWED: Record<string, { lines: string[]; reason: string }> = {
  'apps/server/src/log.ts': {
    lines: ['console.error(`[jumpmaster] ${scrub(msg, config, retired)}`);'],
    reason: 'the server logger itself: it scrubs every line before writing it',
  },
  'apps/server/src/main.ts': {
    lines: [
      'const setup = new SetupMode((code) => process.stderr.write(`${setupCodeLine(code, bound)}\\n`));',
    ],
    reason:
      'the setup code, written once to stderr on purpose and unscrubbed: the owner reads it there',
  },
  'apps/server/src/api/control.ts': {
    lines: [
      'return new SetupMode((code) => process.stderr.write(`${setupCodeLine(code, listen)}\\n`));',
    ],
    reason: 'the same setup-code line, for the control API built without main.ts',
  },
  'apps/server/src/cli.ts': {
    lines: ['const err = deps.err ?? console.error;'],
    reason: "the command line's usage text, for the operator at a terminal: not a server log line",
  },
  'apps/server/src/ctl.ts': {
    lines: [
      'out: (line: string) => void = console.log,',
      'err: (line: string) => void = console.error,',
    ],
    reason:
      '`jumpmaster ctl`, a client process: its output is the answer the operator asked for (an invite code, a token it minted), not a server log line',
  },
  'apps/server/src/init.ts': {
    lines: ['out: (l) => console.log(l),', 'err: (l) => console.error(l),'],
    reason: '`jumpmaster init`, a one-shot setup command run by the operator: not the server log',
  },
  'apps/server/src/bootstrap.ts': {
    lines: ['out: (l) => console.log(l),', 'err: (l) => console.error(l),'],
    reason: '`jumpmaster bootstrap`, a one-shot setup command compose runs: not the server log',
  },
};

/** `file:line: text` for every direct write in `text` that the allow-list does not name. */
export function directWrites(file: string, text: string): string[] {
  const allowed = ALLOWED[file]?.lines ?? [];
  return text.split('\n').flatMap((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
    if (!DIRECT.test(line) || allowed.includes(t)) return [];
    return [`${file}:${i + 1}: ${t}`];
  });
}

test('directWrites finds a console call and a stderr write, and skips allowed lines and comments', () => {
  const src = [
    "console.warn('x');",
    '// console.warn in a comment',
    ' * console.error in a doc comment',
    "process.stderr.write('y');",
    "console['error']('z');",
    'const err = deps.err ?? console.error;',
  ].join('\n');
  expect(directWrites('apps/server/src/a.ts', src)).toEqual([
    "apps/server/src/a.ts:1: console.warn('x');",
    "apps/server/src/a.ts:4: process.stderr.write('y');",
    "apps/server/src/a.ts:5: console['error']('z');",
    'apps/server/src/a.ts:6: const err = deps.err ?? console.error;',
  ]);
  expect(directWrites('apps/server/src/cli.ts', src)).toHaveLength(3);
});

test('no server source file writes to the console outside the allow-list', () => {
  // The tree, not `git ls-files`: a new file is scanned before it is added.
  const files = readdirSync(join(root, SERVER_SRC), { recursive: true, encoding: 'utf8' })
    .map((f) => `${SERVER_SRC}${f.split('\\').join('/')}`)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('/fixtures/'));
  expect(files.length).toBeGreaterThan(50);
  const hits = files.flatMap((f) => directWrites(f, readFileSync(join(root, f), 'utf8')));
  expect(hits, 'route these through `log` from apps/server/src/log.ts, which scrubs').toEqual([]);
});

test('every allow-listed line still exists, so the list does not outlive its reason', () => {
  for (const [file, { lines }] of Object.entries(ALLOWED)) {
    const text = readFileSync(join(root, file), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    for (const l of lines) expect(text, `${file}: ${l}`).toContain(l);
  }
});
