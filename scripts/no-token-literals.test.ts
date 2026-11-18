import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsSecret, findPrivateKeys, redact } from '@jumpmaster/protocol';
import { afterAll, describe, expect, test } from 'vitest';
import { prePushCheck } from '../apps/trooper/src/git.js';
import { fixtureKey, scratchPush } from '../apps/trooper/src/test/privateKey.js';

// The trooper's pre-push check refuses any added line shaped like a token (`containsSecret` in
// packages/protocol/src/redact.ts) and any real private key (`findPrivateKeys`), so a drop that
// writes one loses all its work at push time. This test applies the same detectors to every
// tracked file, so the mistake shows up in the test gate, where it can still be fixed. Write a
// fixture token so that its source isn't token-shaped: split it after the prefix, e.g.
// `'github_pat_' + 'AUTHOR_VALUE_0001'`; the value is the same. Build a fixture key at run time
// (apps/trooper/src/test/privateKey.ts), or keep its body under 200 base64 characters.

const root = join(import.meta.dirname, '..');
const SKIP = /\.(png|jpe?g|gif|ico|woff2?|ttf|pdf|zip|gz|tgz)$/;
const LOCKFILE = /(^|\/)(package-lock|npm-shrinkwrap)\.json$/;
/** `scheme://user:password@` in a URL: a registry credential in a lockfile's `resolved`. */
const URL_CREDENTIAL = /:\/\/[^/\s"'@:]+:[^/\s"'@]*@/;

/** `file:line` for every line of `text` that holds a token shape. */
export function tokenShapedLines(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (containsSecret(line, []) ? [`${file}:${i + 1}`] : []));
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Every reason `text` (the content of tracked file `file`) fails the gate, as `file:line …`. */
export function scanText(file: string, text: string): string[] {
  const hits = tokenShapedLines(file, text);
  for (const k of findPrivateKeys(text)) {
    if (k.real) hits.push(`${file}:${lineAt(text, k.start)} private key`);
  }
  if (LOCKFILE.test(file)) {
    text.split('\n').forEach((line, i) => {
      if (URL_CREDENTIAL.test(line)) hits.push(`${file}:${i + 1} credential in a URL`);
      if (line.includes('_authToken')) hits.push(`${file}:${i + 1} _authToken`);
    });
  }
  return hits;
}

/** Scans `files` (paths relative to `dir`); a file that can't be read fails, never skipped. */
export function scanFiles(dir: string, files: string[]): string[] {
  return files
    .filter((f) => f && !SKIP.test(f))
    .flatMap((f) => {
      let text: string;
      try {
        text = readFileSync(join(dir, f), 'utf8');
      } catch (e) {
        return [`${f}: unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`];
      }
      return scanText(f, text);
    });
}

test('tokenShapedLines finds a token shape and ignores a split fixture', () => {
  const shaped = `const T = '${'ghp_'}${'a'.repeat(36)}';`;
  const split = `const T = 'ghp_' + '${'a'.repeat(36)}';`;
  expect(tokenShapedLines('f.ts', `ok\n${shaped}\n${split}`)).toEqual(['f.ts:2']);
});

describe('the scanner, on a fixture tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'no-token-literals-'));
  afterAll(() => {
    chmodSync(join(dir, 'locked.ts'), 0o600);
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (f: string, text: string) => {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  };

  test('a real key fails, a short fake passes', () => {
    put('src/real.ts', `const a = 1;\nexport const K = \`${fixtureKey(1700)}\`;\n`);
    put('src/fake.test.ts', `const pem = '${fixtureKey(16, 'RSA ', '\\n')}';\n`);
    put('src/escaped.json', JSON.stringify({ k: fixtureKey(1700, 'OPENSSH ') }));
    expect(scanFiles(dir, ['src/real.ts', 'src/fake.test.ts', 'src/escaped.json'])).toEqual([
      'src/real.ts:2 private key',
      'src/escaped.json:1 private key',
    ]);
  });

  test('a lockfile credential URL and _authToken fail; a plain lockfile passes', () => {
    const lock = (resolved: string, extra = '') =>
      `{\n  "packages": {\n    "node_modules/x": {\n      "resolved": "${resolved}"${extra}\n    }\n  }\n}\n`;
    put('package-lock.json', lock('https://registry.npmjs.org/x/-/x-1.0.0.tgz'));
    put('a/package-lock.json', lock('https://user:s3cret@npm.example.com/x/-/x-1.0.0.tgz'));
    put(
      'b/package-lock.json',
      lock('https://npm.example.com/x.tgz', ',\n      "//npm.example.com/:_authToken": "abc"'),
    );
    put('c/package-lock.json', lock('https://tok@npm.example.com/x.tgz'));
    expect(
      scanFiles(dir, [
        'package-lock.json',
        'a/package-lock.json',
        'b/package-lock.json',
        'c/package-lock.json',
      ]),
    ).toEqual(['a/package-lock.json:4 credential in a URL', 'b/package-lock.json:5 _authToken']);
  });

  test('a file that cannot be read fails instead of being skipped', () => {
    mkdirSync(join(dir, 'a-directory'));
    expect(scanFiles(dir, ['a-directory', 'gone.ts'])).toEqual([
      'a-directory: unreadable (EISDIR)',
      'gone.ts: unreadable (ENOENT)',
    ]);
    put('locked.ts', 'x');
    chmodSync(join(dir, 'locked.ts'), 0);
    // Root reads through mode 000, so only a non-root run can see this one fail.
    if (process.getuid?.() !== 0) {
      expect(scanFiles(dir, ['locked.ts'])).toEqual(['locked.ts: unreadable (EACCES)']);
    }
  });
});

describe('one detector, three controls (D5)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'key-parity-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const push = async (name: string, text: string) => {
    const base = join(tmp, name);
    mkdirSync(base);
    const bare = scratchPush(base, 'agent/issue-1', { 'config/deploy.pem.ts': text });
    return prePushCheck(bare, 'agent/issue-1', [], 'refs/jm/base');
  };

  test('redaction, prePushCheck and the gate scanner all take the same key for a real one', async () => {
    const text = `export const KEY = \`${fixtureKey(1700)}\`;\n`;
    expect(redact(text, [])).toBe('export const KEY = `[REDACTED PRIVATE KEY]`;\n');
    expect(await push('real', text)).toBe('private key in config/deploy.pem.ts');
    expect(scanText('config/deploy.pem.ts', text)).toEqual(['config/deploy.pem.ts:1 private key']);
  });

  test('and all three let a short fake through (redaction still hides it)', async () => {
    const text = `export const KEY = \`${fixtureKey(199)}\`;\n`;
    expect(redact(text, [])).toBe('export const KEY = `[REDACTED PRIVATE KEY]`;\n');
    expect(await push('fake', text)).toBeNull();
    expect(scanText('config/deploy.pem.ts', text)).toEqual([]);
  });
});

test('no tracked file holds a token-shaped literal, a real private key or a lockfile credential', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split(
    '\0',
  );
  expect(
    scanFiles(root, files),
    "token-shaped literals and keys: the push check refuses them. Split each token after its prefix, e.g. 'github_pat_' + 'VALUE'",
  ).toEqual([]);
});
