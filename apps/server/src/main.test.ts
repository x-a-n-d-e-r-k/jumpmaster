import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openDb } from './db/open.js';
import { pollTimer, start } from './main.js';

const env: Record<string, string> = {
  JM_CLAUDE_TOKEN: 'claude-token-value',
  JM_GITHUB_AUTHOR_TOKEN: 'author-token-value',
  JM_GITHUB_REVIEWER_TOKEN: 'reviewer-token-value',
  JM_JOIN_TOKEN: 'join-token-value',
  JM_OPERATOR_TOKEN: 'o'.repeat(32),
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** An install with no zones (so a pass makes no forge call), listening on a free port. */
function install(): { file: string; dataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-'));
  const dataDir = join(dir, 'data');
  const file = join(dir, 'jumpmaster.config.json');
  writeFileSync(
    file,
    JSON.stringify({ dataDir, listen: { host: '0.0.0.0', port: 0 }, dropZones: [] }),
  );
  return { file, dataDir };
}

/** Starts the server with stderr captured; returns the captured text and the server. */
async function startCaptured(file: string) {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    written.push(`${a.map(String).join(' ')}\n`);
  });
  const srv = await start(file, env);
  vi.restoreAllMocks();
  return { srv, stderr: written.join('') };
}

test('the setup code appears once per start in stderr on its own prefixed line and never in a page, a cookie, a URL or the database', async () => {
  const { file, dataDir } = install();
  const first = await startCaptured(file);
  const lines = first.stderr.split('\n').filter((l) => l.includes('SETUP CODE'));
  expect(lines).toHaveLength(1);
  const address = first.srv.app.server.address();
  const port = typeof address === 'object' && address ? address.port : -1;
  expect(lines[0]).toMatch(
    new RegExp(
      `^JUMPMASTER SETUP CODE: [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}  \\(open http://127\\.0\\.0\\.1:${port}/setup; a restart prints a new code\\)$`,
    ),
  );
  const code = (lines[0] as string).slice(
    'JUMPMASTER SETUP CODE: '.length,
    'JUMPMASTER SETUP CODE: '.length + 14,
  );
  // The allowed Host is the configured one (port 0 here), not the bound port.
  const host = { host: '127.0.0.1:0' };
  const page = await first.srv.app.inject({ method: 'GET', url: '/setup', headers: host });
  expect(page.statusCode).toBe(200);
  const res = await first.srv.app.inject({
    method: 'POST',
    url: '/setup/code',
    headers: host,
    payload: { code },
  });
  expect(res.statusCode).toBe(303);
  for (const r of [page, res]) {
    const all = `${r.body}${JSON.stringify(r.headers)}`;
    expect(all).not.toContain(code);
    expect(all).not.toContain(code.replaceAll('-', ''));
  }
  await first.srv.stop();
  const db = openDb(join(dataDir, 'jumpmaster.sqlite'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
  }[];
  const dump = tables
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()))
    .join('');
  expect(dump).not.toContain(code.replaceAll('-', ''));
  // An operator exists: the next start prints no code.
  db.prepare("INSERT INTO operator (id, passphrase_hash, created_at) VALUES (1, 'h', 'a')").run();
  db.close();
  const second = await startCaptured(file);
  expect(second.stderr).not.toContain('SETUP CODE');
  await second.srv.stop();
});

test('a restart prints a new code', async () => {
  const { file } = install();
  const a = await startCaptured(file);
  await a.srv.stop();
  const b = await startCaptured(file);
  await b.srv.stop();
  const codeOf = (s: string) => s.match(/SETUP CODE: (\S+)/)?.[1];
  expect(codeOf(a.stderr)).toBeDefined();
  expect(codeOf(b.stderr)).toBeDefined();
  expect(codeOf(a.stderr)).not.toBe(codeOf(b.stderr));
});

test('jumpmaster serve without a path starts in db mode from JM_DATA_DIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-db-'));
  const dataDir = join(dir, 'data');
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    written.push(`${a.map(String).join(' ')}\n`);
  });
  const srv = await start(undefined, { ...env, JM_DATA_DIR: dataDir, JM_LISTEN_PORT: '0' });
  vi.restoreAllMocks();
  expect(srv.store.mode()).toBe('db');
  expect(srv.store.revision()).toBe(1);
  expect(srv.store.current().dropZones).toEqual([]);
  expect(written.join('')).toContain('SETUP CODE');
  expect(existsSync(join(dataDir, 'jumpmaster.sqlite'))).toBe(true);
  await srv.stop();
});

test('a changed pollSeconds re-arms the poll timer', () => {
  const events: string[] = [];
  let next = 0;
  const timers = {
    setInterval: (_fn: () => void, ms: number) => {
      next += 1;
      events.push(`set ${next} ${ms}`);
      return next as unknown as NodeJS.Timeout;
    },
    clearInterval: (h: NodeJS.Timeout) => {
      events.push(`clear ${h as unknown as number}`);
    },
  };
  let poll = 60;
  const listeners: ((c: { pollSeconds: number }) => void)[] = [];
  const source = {
    current: () => ({ pollSeconds: poll }),
    subscribe: (fn: (c: { pollSeconds: number }) => void) => {
      listeners.push(fn);
      return () => undefined;
    },
  };
  const change = (p: number) => {
    poll = p;
    for (const l of listeners) l({ pollSeconds: p });
  };
  const timer = pollTimer(source, () => undefined, timers);
  change(60);
  change(15);
  change(15);
  timer.stop();
  expect(events).toEqual(['set 1 60000', 'clear 1', 'set 2 15000', 'clear 2']);
});

test('the poll timer clamps what it arms to 5 seconds and a day, whatever it is given', () => {
  const armed: number[] = [];
  const timers = {
    setInterval: (_fn: () => void, ms: number) => {
      armed.push(ms);
      return armed.length as unknown as NodeJS.Timeout;
    },
    clearInterval: () => undefined,
  };
  let fire: (c: { pollSeconds: number }) => void = () => undefined;
  const source = {
    current: () => ({ pollSeconds: 3_000_000 }),
    subscribe: (fn: (c: { pollSeconds: number }) => void) => {
      fire = fn;
      return () => undefined;
    },
  };
  const timer = pollTimer(source, () => undefined, timers);
  fire({ pollSeconds: 0.001 });
  fire({ pollSeconds: Number.NaN });
  timer.stop();
  // Never past setInterval's 2^31-1 ms limit (which Node turns into 1 ms), never a busy loop.
  expect(armed).toEqual([86_400_000, 5_000, 60_000]);
});

test('an unreadable secret file is named before the data directory is touched, as in M4', async () => {
  if (process.getuid?.() === 0) return; // root reads a 0000 file
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-secret-'));
  const secret = join(dir, 'claude');
  writeFileSync(secret, 'claude-token-value', { mode: 0o000 });
  // A data directory the server cannot create: the database would fail first if it were opened first.
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const { JM_CLAUDE_TOKEN: _c, ...rest } = env;
  await expect(
    start(undefined, {
      ...rest,
      JM_CLAUDE_TOKEN_FILE: secret,
      JM_DATA_DIR: join(blocked, 'data'),
      JM_LISTEN_PORT: '0',
    }),
  ).rejects.toThrow(/JM_CLAUDE_TOKEN_FILE: .*claude is not readable by uid/);
});
