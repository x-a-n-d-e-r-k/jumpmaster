import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Every key block here is built at run time, so no source file holds one (the test gate in
// scripts/no-token-literals.test.ts would refuse a real one).

/** Base64 characters, none of them a header or footer: `n` of them. */
export const keyBody = (n: number): string =>
  'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV9ffhKbJmA'
    .repeat(Math.ceil(n / 64))
    .slice(0, n);

/** A PEM block with `n` body characters in 64-character lines, joined with `nl`. */
export function fixtureKey(n: number, label = 'RSA ', nl = '\n'): string {
  const lines = keyBody(n).match(/.{1,64}/g) ?? [];
  return [
    `-----BEGIN ${label}PRIVATE KEY-----`,
    ...lines,
    `-----END ${label}PRIVATE KEY-----`,
  ].join(nl);
}

const AGENT = {
  GIT_AUTHOR_NAME: 'Jumpmaster Agent',
  GIT_AUTHOR_EMAIL: 'jumpmaster-agent@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Jumpmaster Agent',
  GIT_COMMITTER_EMAIL: 'jumpmaster-agent@users.noreply.github.com',
};

/**
 * A root-style bare repo under `base`: `refs/jm/base` at a human commit and `refs/heads/<branch>`
 * with one agent commit adding `files` (path → content). Returns the bare repo's path.
 */
export function scratchPush(
  base: string,
  branch: string,
  files: Record<string, string>,
  seed: Record<string, string> = { 'a.txt': 'a\n' },
): string {
  const work = join(base, 'work');
  const bare = join(base, 'push.git');
  mkdirSync(work, { recursive: true });
  const git = (env: Record<string, string>, ...args: string[]) =>
    execFileSync('git', args, { cwd: work, env: { ...process.env, ...AGENT, ...env } });
  const write = (fs: Record<string, string>) => {
    for (const [p, text] of Object.entries(fs)) {
      mkdirSync(dirname(join(work, p)), { recursive: true });
      writeFileSync(join(work, p), text);
    }
  };
  git({}, 'init', '-q', '-b', 'main');
  write(seed);
  git({}, 'add', '.');
  git({ GIT_AUTHOR_NAME: 'Human', GIT_COMMITTER_NAME: 'Human' }, 'commit', '-q', '-m', 'init');
  git({}, 'switch', '-q', '-c', branch);
  write(files);
  git({}, 'add', '.');
  git({}, 'commit', '-q', '-m', 'feat: files');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { cwd: base });
  execFileSync('git', ['update-ref', 'refs/jm/base', 'refs/heads/main'], { cwd: bare });
  return bare;
}
