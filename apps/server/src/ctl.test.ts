import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createApp } from './app.js';
import { loadBoot } from './config/boot.js';
import { ConfigStore } from './config/store.js';
import { ctlRequest, runCtl } from './ctl.js';
import { openDb } from './db/open.js';
import { t0, tmpDbFile } from './test/helpers.js';

const TOKEN = 'o'.repeat(32);
const env = { JM_OPERATOR_TOKEN: TOKEN };

/** A fetch that records each call and answers `status` with `body`. */
function fakeFetch(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, impl };
}

async function run<C = ReturnType<typeof fakeFetch>['calls']>(
  args: string[],
  stdin = '',
  fetchImpl: { calls: C; impl: typeof fetch } = fakeFetch() as unknown as {
    calls: C;
    impl: typeof fetch;
  },
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCtl(
    args,
    env,
    fetchImpl.impl,
    (l) => out.push(l),
    (l) => err.push(l),
    async () => stdin,
  );
  return { code, out, err, calls: fetchImpl.calls };
}

describe('ctl setup and passphrase verbs', () => {
  test('the setup and passphrase verbs map to their routes; a passphrase in argv is refused', () => {
    expect(ctlRequest(['setup-code'])).toEqual({ path: '/api/control/setup/code', body: {} });
    expect(ctlRequest(['setup', 'reopen'])).toEqual({
      path: '/api/control/setup/reopen',
      body: {},
    });
    expect(ctlRequest(['passphrase', 'set'])).toEqual({
      path: '/api/control/passphrase',
      method: 'PUT',
      body: {},
    });
    expect(ctlRequest(['passphrase', 'set', 'hunter2hunter2'])).toBeNull();
    expect(ctlRequest(['setup'])).toBeNull();
    expect(ctlRequest(['setup-code', 'extra'])).toBeNull();
    expect(ctlRequest(['passphrase'])).toBeNull();
  });

  test('ctl passphrase set reads stdin, claims or replaces the operator with no browser, ends setup mode and deletes every session', async () => {
    const pass = 'a long operator passphrase';
    const f = fakeFetch(200, { operator: 'claimed', sessionsDeleted: 0 });
    const r = await run(['passphrase', 'set'], `${pass}\r\n`, f);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe('http://127.0.0.1:7420/api/control/passphrase');
    expect(call.init.method).toBe('PUT');
    expect(JSON.parse(String(call.init.body))).toEqual({ passphrase: pass });
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.out.join('\n')).toContain('claimed');
    expect(`${r.out.join('\n')}${r.err.join('\n')}`).not.toContain(pass);
    expect(call.url).not.toContain(pass);
  });

  test('ctl passphrase set with nothing on stdin calls nothing', async () => {
    const r = await run(['passphrase', 'set'], '\n');
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(r.err.join('\n')).toMatch(/stdin/);
  });

  test('ctl setup-code asks the server to print a fresh code and says where to read it', async () => {
    const r = await run(
      ['setup-code'],
      '',
      fakeFetch(200, { printed: true, next: "the new setup code is on the server's output" }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/setup/code');
    expect(r.calls[0]?.init.method).toBe('POST');
    expect(r.out.join('\n')).toContain("server's output");
  });

  test('ctl setup reopen posts to the reopen route', async () => {
    const r = await run(['setup', 'reopen']);
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/setup/reopen');
  });

  test('the usage line names the new verbs', async () => {
    const r = await run(['nope']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/setup-code/);
    expect(r.err.join('\n')).toMatch(/setup reopen/);
    expect(r.err.join('\n')).toMatch(/passphrase set/);
  });
});

describe('ctl config', () => {
  const storeEnv = {
    JM_CLAUDE_TOKEN: 'claude-secret-value-1',
    JM_GITHUB_AUTHOR_TOKEN: 'author-secret-value-2',
    JM_GITHUB_REVIEWER_TOKEN: 'reviewer-secret-value-3',
    JM_JOIN_TOKEN: 'join-secret-value-4',
    JM_OPERATOR_TOKEN: TOKEN,
  };
  const zoneDoc = (id = 'main', extra: Record<string, unknown> = {}) => ({
    id,
    repo: `octo/${id}`,
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'jm-trooper:dev',
    ...extra,
  });

  /** A real server (db mode) behind `fetch`: ctl's requests go through the guard and the routes. */
  function server() {
    const db = openDb(tmpDbFile());
    const dir = mkdtempSync(join(tmpdir(), 'jm-ctl-cfg-'));
    const store = ConfigStore.open({
      db,
      boot: loadBoot({}, undefined),
      env: storeEnv,
      now: () => t0,
      imageLockPath: join(dir, 'no-lock.json'),
    });
    const app = createApp({
      db,
      config: store,
      now: () => t0,
      forgesFor: () => undefined as never,
    });
    const calls: { method: string; url: string; body: unknown }[] = [];
    const impl = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: u.pathname + u.search, body });
      const r = await app.inject({
        method,
        url: u.pathname + u.search,
        headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7420' },
        ...(body === undefined ? {} : { payload: body }),
      });
      return new Response(r.body, { status: r.statusCode, headers: r.headers as HeadersInit });
    }) as typeof fetch;
    return { db, store, dir, app, fetch: { calls, impl } };
  }

  test('ctl config export writes only the JSON to stdout', async () => {
    const s = server();
    s.store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    const r = await run(['config', 'export'], '', s.fetch);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    // One write, byte for byte the export (it ends in its own newline; out adds none).
    expect(r.out).toEqual([s.store.exportJson().replace(/\n$/, '')]);
    for (const v of Object.values(storeEnv)) expect(r.out.join('')).not.toContain(v);
    await s.app.close();
  });

  test('ctl config set applies a merge patch and ctl config import --dry-run prints the diff without applying', async () => {
    const s = server();
    s.store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    const set = await run(
      [
        'config',
        'set',
        'pollSeconds=30',
        'dropZones.main.readyLabel=go',
        'usage.stopOnOverage=false',
        '--note',
        'tune',
      ],
      '',
      s.fetch,
    );
    expect(set.code).toBe(0);
    // It read the revision first, then sent one conditional patch.
    expect(s.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/control/config',
      'PATCH /api/control/config',
    ]);
    expect(s.fetch.calls[1]?.body).toEqual({
      patch: {
        pollSeconds: 30,
        usage: { stopOnOverage: false },
        dropZones: [zoneDoc('main', { readyLabel: 'go' })],
      },
      expectRevision: 2,
      note: 'tune',
    });
    expect(s.store.current().pollSeconds).toBe(30);
    expect(s.store.current().dropZones[0]?.readyLabel).toBe('go');
    expect(s.store.current().usage.stopOnOverage).toBe(false);
    expect(set.out.join('\n')).toMatch(/revision 3/);

    const file = join(s.dir, 'next.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(s.store.exportJson()), pollSeconds: 90 }));
    const dry = await run(['config', 'import', file, '--dry-run'], '', s.fetch);
    expect(dry.code).toBe(0);
    expect(dry.out).toEqual(['pollSeconds: 30 -> 90', 'dry run: nothing applied']);
    expect(s.store.revision()).toBe(3);
    const done = await run(['config', 'import', file], '', s.fetch);
    expect(done.code).toBe(0);
    expect(s.store.current().pollSeconds).toBe(90);
    await s.app.close();
  });

  test('ctl config set refuses an unknown zone, a bad path and a missing value without a write', async () => {
    const s = server();
    for (const args of [
      ['config', 'set', 'dropZones.nope.readyLabel=go'],
      ['config', 'set', 'pollSeconds'],
      ['config', 'set'],
      ['config', 'set', '=1'],
    ]) {
      const r = await run(args, '', s.fetch);
      expect(r.code).toBe(2);
    }
    expect(s.fetch.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(s.store.revision()).toBe(1);
    await s.app.close();
  });

  test('ctl config show, revisions, rollback, reload, adopt and mode file reach their routes', async () => {
    const s = server();
    await run(['config', 'set', 'pollSeconds=30'], '', s.fetch);
    const show = await run(['config', 'show'], '', s.fetch);
    expect(show.out[0]).toBe('config: db mode, revision 2');
    expect(JSON.parse(show.out.slice(1).join('\n'))).toEqual({ pollSeconds: 30 });
    const json = await run(['config', 'show', '--json'], '', s.fetch);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({ mode: 'db', revision: 2 });
    const revs = await run(['config', 'revisions'], '', s.fetch);
    expect(revs.out[0]).toMatch(/^#2 .* ctl$/);
    expect(revs.out).toContain('    pollSeconds: (unset) -> 30');
    const back = await run(['config', 'rollback', '1', 'undo', 'it'], '', s.fetch);
    expect(back.code).toBe(0);
    expect(s.fetch.calls.at(-1)?.body).toEqual({ id: 1, note: 'undo it' });
    expect(s.store.current().pollSeconds).toBe(60);
    for (const [args, path, body] of [
      [['config', 'reload'], '/api/control/config/reload', {}],
      [['config', 'adopt'], '/api/control/config/adopt', {}],
      [['config', 'mode', 'file'], '/api/control/config/mode', { mode: 'file' }],
    ] as const) {
      await run([...args], '', s.fetch);
      expect(s.fetch.calls.at(-1)).toMatchObject({ method: 'POST', url: path, body });
    }
    expect(ctlRequest(['config', 'mode', 'db'])).toBeNull();
    await s.app.close();
  });
});
