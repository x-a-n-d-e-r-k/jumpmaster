// The live server's path for a GitLab zone (issue #764): `start()` reads the zone's gitlab-pat
// vault entries, judges its credentials by them, and its poll pass syncs the zone's ready issues
// through a GitLabForge, against the nock-based fake GitLab with the network shut.
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { openDb } from './db/open.js';
import { listWorkItems } from './db/repo.js';
import { start } from './main.js';
import { lastPassAt } from './status.js';
import { ACCESS, fakeGitLab } from './test/fake-gitlab.js';
import { gitlabPatEntryName } from './vault/gitlab-pat-entries.js';
import { openVault } from './vault/vault.js';

const GITLAB = 'https://gitlab.test-origin.example';
const PROJECT = { id: 91, path: 'group/sub/web' };
const POLL_SECONDS = 45;
// Made-up tokens, built at run time so no token-shaped literal sits in the tracked file.
const AUTHOR = ['glpat', 'M'.repeat(20)].join('-');
const REVIEWER = ['glpat', 'N'.repeat(20)].join('-');

// No GitHub token at all: a GitLab zone needs none.
const env: Record<string, string> = {
  JM_CLAUDE_TOKEN: 'claude-token-value',
  JM_JOIN_TOKEN: 'join-token-value',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};

/** `METHOD host path` of every outgoing request no interceptor answered (nock refuses them). */
const noMatch: string[] = [];
const onNoMatch = (req: { method?: string; hostname?: string; host?: string; path?: string }) =>
  noMatch.push(`${req.method} ${req.hostname ?? req.host} ${req.path}`);

beforeAll(() => {
  nock.disableNetConnect();
  nock.emitter.on('no match', onNoMatch);
});
afterEach(() => {
  vi.restoreAllMocks();
  nock.cleanAll();
  noMatch.length = 0;
});
afterAll(() => {
  nock.emitter.removeListener('no match', onNoMatch);
  nock.enableNetConnect();
});

/** An install with one GitLab zone in observe mode and its gitlab-pats in the vault. */
function install() {
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-gitlab-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir);
  const key = join(dir, 'vault_key');
  writeFileSync(key, randomBytes(32).toString('base64url'), { mode: 0o600 });
  const db = openDb(join(dataDir, 'jumpmaster.sqlite'));
  const vault = openVault(key, db);
  if (vault === 'disabled') throw new Error('expected a vault');
  const now = new Date();
  vault.put(gitlabPatEntryName('web', 'author'), AUTHOR, { now });
  vault.put(gitlabPatEntryName('web', 'reviewer'), REVIEWER, { now });
  db.close();
  const file = join(dir, 'jumpmaster.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      dataDir,
      listen: { host: '127.0.0.1', port: 0 },
      pollSeconds: POLL_SECONDS,
      dropZones: [
        {
          id: 'web',
          repo: PROJECT.path,
          forge: 'gitlab',
          gitlab: { baseUrl: GITLAB },
          mode: 'observe',
          gates: [{ name: 'test', run: 'npm test' }],
          image: 'jm-trooper:dev',
        },
      ],
    }),
  );
  return { file, dataDir, key };
}

test("a GitLab zone's poll pass syncs its ready issues through GitLabForge on its gitlab-pats, unparked, with nothing sent to github.com or gitlab.com", async () => {
  const { file, dataDir, key } = install();
  const gl = fakeGitLab({ baseUrl: GITLAB, project: PROJECT });
  gl.addUser({ username: 'author-bot', token: AUTHOR, accessLevel: ACCESS.developer });
  gl.addUser({ username: 'reviewer-bot', token: REVIEWER, accessLevel: ACCESS.developer });
  gl.addUser({
    username: 'maintainer',
    token: 'unused-token-value',
    accessLevel: ACCESS.maintainer,
  });
  gl.seedIssue({ title: 'Ready work', labels: ['drop-ready'], author: 'maintainer' });

  // The poll timer's callback, captured as it is armed, so the test drives a pass through it.
  let poll: (() => void) | undefined;
  const realSet = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === POLL_SECONDS * 1000) poll = fn;
    return realSet(fn, ms);
  }) as typeof setInterval);
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    written.push(`${a.map(String).join(' ')}\n`);
  });

  const srv = await start(file, { ...env, JM_VAULT_KEY_FILE: key });
  const reader = openDb(join(dataDir, 'jumpmaster.sqlite'));
  try {
    expect(poll).toBeDefined();
    // The pass start() runs at once finishes first, so the timer's pass is not skipped as busy.
    await vi.waitFor(() => expect(lastPassAt(reader)).toBeDefined(), { timeout: 10_000 });
    const first = lastPassAt(reader);
    gl.requests.length = 0;

    poll?.();
    await vi.waitFor(() => expect(lastPassAt(reader)).not.toBe(first), { timeout: 10_000 });

    // The zone is not parked on its credentials: they are judged by its gitlab-pats.
    expect(srv.store.problems()).toEqual([]);
    expect(written.join('')).not.toMatch(/zone web parked/);
    // The timer's pass listed the ready issues on GitLab, as the author bot.
    expect(
      gl.requests.some(
        (r) => r.method === 'GET' && /\/issues$/.test(r.path) && r.user === 'author-bot',
      ),
    ).toBe(true);
    expect(gl.requests.every((r) => r.user === 'author-bot' || r.user === 'reviewer-bot')).toBe(
      true,
    );
    // The ready issue became a work item.
    expect(listWorkItems(reader, 'web').map((i) => i.issueNumber)).toEqual([1]);
    // Nothing left for github.com, gitlab.com or anywhere else.
    expect(noMatch).toEqual([]);
    expect(written.join('')).not.toContain(AUTHOR);
    expect(written.join('')).not.toContain(REVIEWER);
  } finally {
    reader.close();
    await srv.stop();
    gl.stop();
  }
});
