import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatZoneFetch } from '@jumpmaster/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { syncZone } from './repos.js';

// A fake read token, split after its prefix so no tracked line is token-shaped.
const TOKEN = 'ghs_' + 'x'.repeat(36);

let tmp: string;
let origin: string;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const zone = (over: Partial<ChatZoneFetch> = {}): ChatZoneFetch => ({
  id: 'main',
  owner: 'o',
  name: 'r',
  defaultBranch: 'main',
  token: TOKEN,
  extraRefs: [],
  ...over,
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.isFile() ? [p] : [];
  });
}

beforeAll(() => {
  tmp = mkdtempSync(join(realpathSync(tmpdir()), 'chat-repos-'));
  origin = join(tmp, 'origin.git');
  const seed = join(tmp, 'seed');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@example.com');
  writeFileSync(join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', origin, 'main');
  // A pull request head, as GitHub stores it.
  git(seed, 'checkout', '-qb', 'feature');
  writeFileSync(join(seed, 'b.txt'), 'b\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'feature');
  git(seed, 'push', '-q', origin, 'feature:refs/pull/7/head');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const freshRoot = () => mkdtempSync(join(tmp, 'root-'));

describe('syncZone', () => {
  test("CLAIM=PROOF after syncZone no file under the zone's directory contains the token", async () => {
    const root = freshRoot();
    const r = await syncZone(root, zone(), null, { url: `file://${origin}` });
    expect(r).toEqual({ workDir: join(root, 'main', 'work') });
    // The work tree is checked out at the default branch.
    expect(readFileSync(join(root, 'main', 'work', 'a.txt'), 'utf8')).toBe('a\n');
    // A second sync (a later turn) refreshes the same layout.
    expect(await syncZone(root, zone(), null, { url: `file://${origin}` })).toEqual(r);

    const files = walk(join(root, 'main'));
    expect(files.length).toBeGreaterThan(5);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    for (const f of files) {
      const text = readFileSync(f).toString('latin1');
      expect(text, f).not.toContain(TOKEN);
      expect(text, f).not.toContain(basic);
    }
    for (const cfg of [
      join(root, 'main', 'mirror', 'config'),
      join(root, 'main', 'work', '.git', 'config'),
    ]) {
      const text = readFileSync(cfg, 'utf8');
      expect(text).not.toContain('extraheader');
      expect(text).not.toContain('x-access-token');
    }
  });

  test('syncZone fetches extraRefs into the mirror', async () => {
    const root = freshRoot();
    const r = await syncZone(root, zone({ extraRefs: ['pull/7/head'] }), null, {
      url: `file://${origin}`,
    });
    expect('workDir' in r).toBe(true);
    const mirror = join(root, 'main', 'mirror');
    expect(git(mirror, 'rev-parse', 'refs/pull/7/head')).toBe(
      git(origin, 'rev-parse', 'refs/pull/7/head'),
    );
    // The work tree can read it too.
    const work = join(root, 'main', 'work');
    expect(git(work, 'rev-parse', 'refs/remotes/origin/pull/7/head')).toBe(
      git(origin, 'rev-parse', 'refs/pull/7/head'),
    );
  });

  test('a fetch failure answers unavailable with a reason that does not contain the token', async () => {
    const root = freshRoot();
    // The remote's path carries the token, so git's own error would echo it.
    const r = await syncZone(root, zone(), null, { url: `file://${tmp}/missing-${TOKEN}.git` });
    expect(r).toEqual({ unavailable: expect.any(String) });
    const reason = (r as { unavailable: string }).unavailable;
    expect(reason).not.toBe('');
    expect(reason).not.toContain(TOKEN);
  });

  test('a zone without a read token is unavailable and fetches nothing', async () => {
    const root = freshRoot();
    const r = await syncZone(root, zone({ token: null }), null, { url: `file://${origin}` });
    expect(r).toEqual({ unavailable: expect.stringMatching(/read token/) });
    expect(readdirSync(root)).toEqual([]);
  });

  test('a zone id or branch that could leave the layout is refused', async () => {
    const root = freshRoot();
    for (const z of [zone({ id: '../x' }), zone({ defaultBranch: 'main:refs/heads/x' })]) {
      const r = await syncZone(root, z, null, { url: `file://${origin}` });
      expect(r).toEqual({ unavailable: expect.any(String) });
    }
    expect(readdirSync(root)).toEqual([]);
  });
});
