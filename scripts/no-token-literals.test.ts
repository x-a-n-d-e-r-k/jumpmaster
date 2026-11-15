import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactTokenShapes } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';

// The trooper's pre-push check refuses any added line shaped like a token (`containsSecret` in
// packages/protocol/src/redact.ts), so a drop that writes one loses all its work at push time.
// This test applies the same shapes to every tracked file, so the mistake shows up in the test
// gate, where it can still be fixed. Write a fixture token so that its source isn't token-shaped:
// split it after the prefix, e.g. `'github_pat_' + 'AUTHOR_VALUE_0001'`; the value is the same.

const root = join(import.meta.dirname, '..');
const SKIP = /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz|tgz)$|(^|\/)package-lock\.json$/;

/** `file:line` for every line of `text` that holds a token shape. */
export function tokenShapedLines(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (redactTokenShapes(line) === line ? [] : [`${file}:${i + 1}`]));
}

test('tokenShapedLines finds a token shape and ignores a split fixture', () => {
  const shaped = `const T = '${'ghp_'}${'a'.repeat(36)}';`;
  const split = `const T = 'ghp_' + '${'a'.repeat(36)}';`;
  expect(tokenShapedLines('f.ts', `ok\n${shaped}\n${split}`)).toEqual(['f.ts:2']);
});

test('no tracked file holds a token-shaped literal', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !SKIP.test(f));
  const hits = files.flatMap((f) => {
    let text: string;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      return [];
    }
    return tokenShapedLines(f, text);
  });
  expect(
    hits,
    "token-shaped literals: the push check refuses them. Split each after its prefix, e.g. 'github_pat_' + 'VALUE'",
  ).toEqual([]);
});
