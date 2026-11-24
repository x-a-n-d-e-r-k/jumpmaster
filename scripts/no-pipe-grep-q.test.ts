import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

// Under `set -o pipefail`, `producer | grep -q …` fails when grep's early exit kills the producer
// with SIGPIPE, although the text was there: a check misses a line it should find, and an
// `if … | grep -q secret; then fail` check passes with a secret in the output. Scripts read the
// output once into a variable and grep it with a here-string instead (images/smoke.sh `log_has`).

const root = join(import.meta.dirname, '..');
const DIRS = ['images/', 'deploy/', 'scripts/'];

/**
 * Line numbers (1-based) where a pipe feeds a quiet grep. Comment lines are dropped; the pipe and
 * the grep may be on different lines (a trailing `|`, or a `\` continuation before `| grep`).
 */
export function pipedQuietGreps(text: string): number[] {
  const lines = text.split('\n');
  // Keep line positions: a comment line becomes empty.
  const code = lines.map((l) => (l.trim().startsWith('#') ? '' : l.replace(/\\\s*$/, ' ')));
  const joined = code.join('\n');
  const re =
    /(?<![|>])\|(?![|])[\s]*(?:\w+=\S*\s+)*(?:command\s+)?grep\b[^\n;&|<>]*?\s(?:-[A-Za-z]*q[A-Za-z]*|--quiet)\b/g;
  const out: number[] = [];
  for (const m of joined.matchAll(re)) {
    out.push(joined.slice(0, m.index).split('\n').length);
  }
  return out;
}

function trackedPipefailScripts(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...DIRS], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => /\bpipefail\b/.test(readFileSync(join(root, f), 'utf8')));
}

describe('no pipe into a quiet grep under pipefail', () => {
  test('scripts under images/, deploy/ and scripts/ that set pipefail never pipe into grep -q', () => {
    const files = trackedPipefailScripts();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('images/smoke.sh');
    const found: string[] = [];
    for (const f of files) {
      for (const line of pipedQuietGreps(readFileSync(join(root, f), 'utf8'))) {
        found.push(`${f}:${line}`);
      }
    }
    expect(found).toEqual([]);
  });

  test('the matcher flags piped quiet greps and nothing else', () => {
    expect(pipedQuietGreps('docker logs x 2>&1 | grep -qF -- "$w"')).toEqual([1]);
    expect(pipedQuietGreps('docker logs x 2>&1 |\n  grep -q foo')).toEqual([1]);
    expect(pipedQuietGreps('docker logs x 2>&1 \\\n  | grep -Fq foo')).toEqual([2]);
    expect(pipedQuietGreps('a | grep -qE x')).toEqual([1]);
    expect(pipedQuietGreps('a | grep --quiet x')).toEqual([1]);
    expect(pipedQuietGreps('a | grep -F x')).toEqual([]);
    expect(pipedQuietGreps('grep -q x <<<"$out"')).toEqual([]);
    expect(pipedQuietGreps('# docker logs x | grep -q y')).toEqual([]);
    expect(pipedQuietGreps('  # a |\n  # grep -q y')).toEqual([]);
    expect(pipedQuietGreps('a || grep -q x file')).toEqual([]);
  });
});

describe('images/smoke.sh log_has', () => {
  const smoke = readFileSync(join(root, 'images/smoke.sh'), 'utf8');
  const fn = /^log_has\(\) \{\n[\s\S]*?\n\}\n/m.exec(smoke)?.[0];

  function run(docker: string, body: string) {
    const script = [
      'set -euo pipefail',
      'fail() { echo "FAIL: $*" >&2; exit 7; }',
      `docker() { ${docker}; }`,
      fn ?? 'false',
      body,
    ].join('\n');
    return spawnSync('bash', ['--norc', '--noprofile', '-c', script], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  test('is defined in images/smoke.sh', () => {
    expect(fn).toBeDefined();
  });

  test('finds a match on line 1 of a long log, every time', () => {
    const docker = 'echo "the secret smoke-join-token-1"; seq 1 100000';
    for (let i = 0; i < 20; i++) {
      const r = run(
        docker,
        'if log_has c -F smoke-join-token; then echo found; else echo "missing $?"; fi',
      );
      expect(r.stderr).toBe('');
      expect(r.stdout.trim()).toBe('found');
      expect(r.status).toBe(0);
    }
  });

  test('returns 1 without failing when there is no match', () => {
    const r = run(
      'echo hello; seq 1 1000',
      'if log_has c -F absent; then echo found; else echo "missing $?"; fi',
    );
    expect(r.stdout.trim()).toBe('missing 1');
    expect(r.stderr).not.toContain('FAIL');
    expect(r.status).toBe(0);
  });

  test('fails the script, naming the container, when the log cannot be read', () => {
    const r = run(
      'echo "Error: No such container: $2" >&2; return 1',
      'if log_has jm-gone -F x; then echo found; else echo "missing $?"; fi\necho after',
    );
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('FAIL');
    expect(r.stderr).toContain('jm-gone');
    expect(r.stdout).not.toContain('missing');
    expect(r.stdout).not.toContain('after');
  });

  test('fails the script when grep itself errors', () => {
    const r = run('echo x', 'log_has c -E "(" || echo "missing $?"\necho after');
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('FAIL');
    expect(r.stdout).toBe('');
  });
});
