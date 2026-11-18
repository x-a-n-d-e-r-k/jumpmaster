import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openDb } from './db/open.js';
import { APP_MANIFEST_SWEEP_MS, listeningLine, pollTimer, start } from './main.js';

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
async function startCaptured(file: string, extra: Record<string, string> = {}) {
  const written: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    written.push(`${a.map(String).join(' ')}\n`);
  });
  const srv = await start(file, { ...env, ...extra });
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

test('with JM_TLS_TERMINATED=1 the served app counts wrong setup codes per forwarded client from a loopback peer (issue #261)', async () => {
  const wrongCodes = async (extra: Record<string, string>) => {
    const { file } = install();
    const { srv } = await startCaptured(file, extra);
    const post = (forwarded: string, remoteAddress = '127.0.0.1') =>
      srv.app.inject({
        method: 'POST',
        url: '/setup/code',
        remoteAddress,
        headers: { host: '127.0.0.1:0', 'x-forwarded-for': forwarded },
        payload: { code: 'AAAA-AAAA-AAAA' },
      });
    const codes = [
      (await post('100.64.0.7')).statusCode,
      (await post('100.64.0.7')).statusCode,
      (await post('100.64.0.8')).statusCode,
      // From a non-loopback peer the header is ignored: that peer's first try.
      (await post('100.64.0.9', '192.168.1.50')).statusCode,
      (await post('100.64.0.10', '192.168.1.50')).statusCode,
    ];
    await srv.stop();
    return codes;
  };
  expect(await wrongCodes({ JM_TLS_TERMINATED: '1' })).toEqual([401, 429, 401, 401, 429]);
  // Off, as before: every loopback client shares one bucket.
  expect(await wrongCodes({})).toEqual([401, 429, 429, 401, 429]);
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

test('start arms the pending GitHub App sweep once a minute, and stop clears it', async () => {
  const { file, dataDir } = install();
  // A poll other than a minute, so the sweep is the one 60-second interval.
  writeFileSync(
    file,
    JSON.stringify({
      dataDir,
      listen: { host: '0.0.0.0', port: 0 },
      dropZones: [],
      pollSeconds: 30,
    }),
  );
  const armed: { fn: () => void; ms: number | undefined; handle: unknown }[] = [];
  const realSet = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    armed.push({ fn, ms, handle });
    return handle;
  }) as typeof setInterval);
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const srv = await start(file, env);
  expect(APP_MANIFEST_SWEEP_MS).toBe(60_000);
  const sweeps = armed.filter((a) => a.ms === APP_MANIFEST_SWEEP_MS);
  expect(sweeps).toHaveLength(1);
  const sweep = sweeps[0] as (typeof armed)[number];
  // Nothing pending: a sweep runs without a word or a throw.
  expect(() => sweep.fn()).not.toThrow();
  expect(cleared.mock.calls.some(([h]) => h === sweep.handle)).toBe(false);
  await srv.stop();
  expect(cleared.mock.calls.some(([h]) => h === sweep.handle)).toBe(true);
});

test('a start whose listen fails leaves no pending GitHub App sweep armed', async () => {
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const address = busy.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-'));
  const dataDir = join(dir, 'data');
  const file = join(dir, 'jumpmaster.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      dataDir,
      listen: { host: '127.0.0.1', port },
      dropZones: [],
      pollSeconds: 30,
    }),
  );
  const armed: { ms: number | undefined; handle: NodeJS.Timeout }[] = [];
  const realSet = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    armed.push({ ms, handle });
    return handle;
  }) as typeof setInterval);
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(start(file, env)).rejects.toThrow();
    const sweeps = armed.filter((a) => a.ms === APP_MANIFEST_SWEEP_MS);
    const live = sweeps.filter((a) => !cleared.mock.calls.some(([h]) => h === a.handle));
    expect(live).toHaveLength(0);
  } finally {
    for (const a of armed) clearInterval(a.handle);
    await new Promise<void>((resolve) => busy.close(() => resolve()));
  }
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

test('a credential file under the secrets directory, and the vault key file, are named before the data directory is touched', async () => {
  if (process.getuid?.() === 0) return; // root reads a 0000 file
  const dir = mkdtempSync(join(tmpdir(), 'jm-main-dir-'));
  const blocked = join(dir, 'blocked');
  writeFileSync(blocked, 'not a directory');
  writeFileSync(join(dir, 'github_author_token'), 'author-token-value', { mode: 0o000 });
  const { JM_GITHUB_AUTHOR_TOKEN: _a, ...rest } = env;
  await expect(
    start(undefined, {
      ...rest,
      JM_SECRETS_DIR: dir,
      JM_DATA_DIR: join(blocked, 'data'),
      JM_LISTEN_PORT: '0',
    }),
  ).rejects.toThrow(
    `github_author_token: ${join(dir, 'github_author_token')} is not readable by uid`,
  );
  const key = join(dir, 'vault_key');
  writeFileSync(key, 'x', { mode: 0o000 });
  await expect(
    start(undefined, {
      ...env,
      JM_VAULT_KEY_FILE: key,
      JM_DATA_DIR: join(blocked, 'data'),
      JM_LISTEN_PORT: '0',
    }),
  ).rejects.toThrow(`JM_VAULT_KEY_FILE: ${key} is not readable by uid`);
});

test('a missing key file with a non-empty vault refuses startup with the travel-together message', async () => {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'jm-main-vault-')), 'data');
  mkdirSync(dataDir);
  const db = openDb(join(dataDir, 'jumpmaster.sqlite'));
  db.prepare(
    "INSERT INTO vault (name, ciphertext, nonce, key_id, fingerprint, created_at) VALUES ('claudeToken', x'00', zeroblob(12), 'k', 'f', 't')",
  ).run();
  db.close();
  await expect(
    start(undefined, { ...env, JM_DATA_DIR: dataDir, JM_LISTEN_PORT: '0' }),
  ).rejects.toThrow(
    `the vault at ${dataDir} holds 1 credentials but JM_VAULT_KEY_FILE is unset: the key and the data travel together`,
  );
});

test('the listening line puts 0.0.0.0 in its container context; any other host prints as before', () => {
  expect(listeningLine('0.0.0.0', 7420, 'db')).toBe(
    'listening on 0.0.0.0:7420 inside the container (config: db mode); compose publishes it on the address in compose.yaml',
  );
  const local = listeningLine('127.0.0.1', 7420, 'file');
  expect(local).toBe('listening on 127.0.0.1:7420 (config: file mode)');
  expect(local).not.toContain('inside the container');
});
