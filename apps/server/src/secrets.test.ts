import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { readSecret } from './secrets.js';

const VALUE = 'sk-secret-value-123456';

function secretFile(content: string, mode = 0o600): string {
  const file = join(mkdtempSync(join(tmpdir(), 'jm-secret-')), 'token');
  writeFileSync(file, content, { mode });
  chmodSync(file, mode); // the umask may have narrowed it
  return file;
}

const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected an error');
};

const isRoot = process.getuid?.() === 0;

describe('readSecret', () => {
  test('JM_X_FILE supplies a secret; JM_X and JM_X_FILE together is a config error', () => {
    const file = secretFile(VALUE);
    expect(readSecret({ JM_X_FILE: file }, 'JM_X')).toBe(VALUE);
    expect(readSecret({ JM_X: VALUE }, 'JM_X')).toBe(VALUE);
    expect(readSecret({}, 'JM_X')).toBeUndefined();
    const both = thrown(() => readSecret({ JM_X: VALUE, JM_X_FILE: file }, 'JM_X'));
    expect(both).toMatch(/JM_X and JM_X_FILE/);
    expect(both).not.toContain(VALUE);
  });

  test('a group- or world-writable secret file is refused naming the variable, not the value', () => {
    for (const mode of [0o620, 0o602, 0o666]) {
      const file = secretFile(VALUE, mode);
      const message = thrown(() => readSecret({ JM_X_FILE: file }, 'JM_X'));
      expect(message).toMatch(/JM_X_FILE/);
      expect(message).toMatch(/group- or world-writable/);
      expect(message).not.toContain(VALUE);
    }
    // Group- or world-readable is the operator's choice (compose secrets keep host modes).
    expect(readSecret({ JM_X_FILE: secretFile(VALUE, 0o644) }, 'JM_X')).toBe(VALUE);
  });

  test.skipIf(isRoot)('an unreadable secret file is reported by variable, path and uid', () => {
    const file = secretFile(VALUE, 0o000);
    const message = thrown(() => readSecret({ JM_X_FILE: file }, 'JM_X'));
    expect(message).toBe(`JM_X_FILE: ${file} is not readable by uid ${process.getuid?.()}`);
  });

  test('a missing file, a directory or an empty file is refused by variable and path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-secret-'));
    const missing = join(dir, 'nope');
    expect(thrown(() => readSecret({ JM_X_FILE: missing }, 'JM_X'))).toMatch(
      new RegExp(`^JM_X_FILE: ${missing} `),
    );
    const sub = join(dir, 'sub');
    mkdirSync(sub, { mode: 0o700 });
    expect(thrown(() => readSecret({ JM_X_FILE: sub }, 'JM_X'))).toMatch(/not a regular file/);
    expect(thrown(() => readSecret({ JM_X_FILE: secretFile('') }, 'JM_X'))).toMatch(/is empty/);
    expect(thrown(() => readSecret({ JM_X_FILE: secretFile('\n') }, 'JM_X'))).toMatch(/is empty/);
  });

  test('one trailing newline is trimmed; inner whitespace is refused', () => {
    expect(readSecret({ JM_X_FILE: secretFile(`${VALUE}\n`) }, 'JM_X')).toBe(VALUE);
    expect(readSecret({ JM_X_FILE: secretFile(`${VALUE}\r\n`) }, 'JM_X')).toBe(VALUE);
    for (const bad of [`${VALUE}\n\n`, `${VALUE} \n`, `a b`, `a\tb`, ` ${VALUE}`, `a\nb`]) {
      const message = thrown(() => readSecret({ JM_X_FILE: secretFile(bad) }, 'JM_X'));
      expect(message).toBe(`JM_X_FILE: the secret contains whitespace`);
    }
  });

  test('an environment value is passed through unchanged, as before', () => {
    // Existing deployments set secrets in the environment; their values are not reinterpreted.
    expect(readSecret({ JM_X: 'a b\n' }, 'JM_X')).toBe('a b\n');
    expect(readSecret({ JM_X: '' }, 'JM_X')).toBe('');
  });

  test('a FIFO is refused at once instead of blocking startup', () => {
    // Run in a child with a timeout: a blocking open would hang this worker for good.
    const fifo = join(mkdtempSync(join(tmpdir(), 'jm-secret-')), 'pipe');
    execFileSync('mkfifo', ['-m', '0600', fifo]);
    const source = fileURLToPath(
      new URL('../../../packages/protocol/src/secrets.ts', import.meta.url),
    );
    const script = [
      `import { readSecret } from ${JSON.stringify(pathToFileURL(source).href)};`,
      'try {',
      `  readSecret({ JM_X_FILE: ${JSON.stringify(fifo)} }, 'JM_X');`,
      "  console.log('read');",
      '} catch (e) {',
      '  console.log(e.message);',
      '}',
    ].join('\n');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.signal, 'timed out: the open blocked').toBeNull();
    expect(child.stdout.trim()).toBe(`JM_X_FILE: ${fifo} is not a regular file`);
  });

  test('a secret file over 64 KiB is refused without reading it whole', () => {
    expect(readSecret({ JM_X_FILE: secretFile('a'.repeat(64 * 1024)) }, 'JM_X')).toHaveLength(
      64 * 1024,
    );
    expect(
      thrown(() => readSecret({ JM_X_FILE: secretFile('a'.repeat(64 * 1024 + 1)) }, 'JM_X')),
    ).toMatch(/^JM_X_FILE: .* is larger than 64 KiB$/);
  });
});
