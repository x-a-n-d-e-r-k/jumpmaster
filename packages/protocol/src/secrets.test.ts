import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CREDENTIAL_FILES, readSecret, readSecretFile } from './secrets.js';

const VALUE = 'github_pat_SHIMVALUE0123456789';

function dirWith(files: Record<string, string>, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'jm-secrets-dir-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, { mode });
    chmodSync(join(dir, name), mode);
  }
  return dir;
}

describe('file secrets by name', () => {
  test('CREDENTIAL_FILES names the four credential files by their variables', () => {
    expect(CREDENTIAL_FILES).toEqual({
      JM_CLAUDE_TOKEN: 'claude_token',
      JM_GITHUB_AUTHOR_TOKEN: 'github_author_token',
      JM_GITHUB_REVIEWER_TOKEN: 'github_reviewer_token',
      JM_GITHUB_READ_TOKEN: 'github_read_token',
    });
  });

  test('readSecretFile applies the _FILE checks, naming the label and path but never the value', () => {
    const dir = dirWith({ ok: `${VALUE}\n`, open: VALUE });
    expect(readSecretFile(join(dir, 'ok'), 'claude_token')).toBe(VALUE);
    chmodSync(join(dir, 'open'), 0o666);
    let msg = '';
    try {
      readSecretFile(join(dir, 'open'), 'claude_token');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toBe(
      `claude_token: ${join(dir, 'open')} is group- or world-writable; chmod go-w it`,
    );
    expect(msg).not.toContain(VALUE);
  });

  test('a _FILE under /run/secrets that is missing falls back to JM_SECRETS_DIR by credential name, with a warning naming both paths', () => {
    const dir = dirWith({ github_author_token: `${VALUE}\n` });
    const warnings: string[] = [];
    const env = {
      // The basename differs on purpose: the fallback goes by credential name.
      JM_GITHUB_AUTHOR_TOKEN_FILE: '/run/secrets/author',
      JM_SECRETS_DIR: dir,
    };
    expect(readSecret(env, 'JM_GITHUB_AUTHOR_TOKEN', (w) => warnings.push(w))).toBe(VALUE);
    expect(warnings).toEqual([
      `JM_GITHUB_AUTHOR_TOKEN_FILE: /run/secrets/author does not exist; reading ${join(dir, 'github_author_token')} instead (remove the variable: the secrets directory is read by name)`,
    ]);
    for (const w of warnings) expect(w).not.toContain(VALUE);
  });

  test('the fallback is inert without JM_SECRETS_DIR, outside /run/secrets, and for a name that is no credential', () => {
    const dir = dirWith({ github_author_token: VALUE, join_token: VALUE });
    expect(() =>
      readSecret({ JM_GITHUB_AUTHOR_TOKEN_FILE: '/run/secrets/author' }, 'JM_GITHUB_AUTHOR_TOKEN'),
    ).toThrow('JM_GITHUB_AUTHOR_TOKEN_FILE: /run/secrets/author does not exist');
    expect(() =>
      readSecret(
        { JM_GITHUB_AUTHOR_TOKEN_FILE: '/elsewhere/author', JM_SECRETS_DIR: dir },
        'JM_GITHUB_AUTHOR_TOKEN',
      ),
    ).toThrow('does not exist');
    expect(() =>
      readSecret(
        { JM_JOIN_TOKEN_FILE: '/run/secrets/join_token', JM_SECRETS_DIR: dir },
        'JM_JOIN_TOKEN',
      ),
    ).toThrow('does not exist');
  });
});

test('a symlink to a 0600 file loads (a Kubernetes-style ..data mount works)', () => {
  const dir = dirWith({ real: `${VALUE}\n` });
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  expect(readSecretFile(join(dir, 'link'), 'claude_token')).toBe(VALUE);
});

test('a symlink is held to the plain-file rule: a link to a 0644 file loads, a link to a directory is refused', () => {
  const dir = dirWith({ real: VALUE }, 0o644);
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  // As Kubernetes projects secrets (0644): it loads, and the doctor's config.secret-files fails it.
  expect(readSecretFile(join(dir, 'link'), 'claude_token')).toBe(VALUE);
  symlinkSync(dir, join(dir, 'dirlink'));
  expect(() => readSecretFile(join(dir, 'dirlink'), 'claude_token')).toThrow(
    `claude_token: ${join(dir, 'dirlink')} is not a regular file`,
  );
});
