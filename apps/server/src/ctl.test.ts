import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

describe('ctl sticks (issue #136)', () => {
  test('sticks slots kidney-shadow 2 calls the route with {slots: 2}', async () => {
    const r = await run(
      ['sticks', 'slots', 'kidney-shadow', '2'],
      '',
      fakeFetch(200, { id: 's1', slots: 2, maxSlots: 4 }),
    );
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/sticks/kidney-shadow/slots');
    expect(r.calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(r.calls[0]?.init.body))).toEqual({ slots: 2 });
    expect(r.out).toEqual(['stick s1: 2 troopers at once (allows up to 4)']);
  });

  test('a count that is not a whole number is a usage error; a refusal prints and exits 1', async () => {
    for (const bad of [
      ['sticks', 'slots', 'k'],
      ['sticks', 'slots', 'k', 'two'],
      ['sticks', 'slots', 'k', '2', 'x'],
    ]) {
      const r = await run(bad);
      expect(r.code, bad.join(' ')).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
    const refused = await run(
      ['sticks', 'slots', 'k', '9'],
      '',
      fakeFetch(400, {
        error:
          'stick k allows up to 4 troopers at once: to allow more, set JM_MAX_SLOTS on that machine and restart the stick',
      }),
    );
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('set JM_MAX_SLOTS on that machine');
  });

  test('ctl sticks lists name, effective, desired and max slots, and last seen', async () => {
    const r = await run(
      ['sticks'],
      '',
      fakeFetch(200, {
        sticks: [
          {
            id: 's1',
            name: 'kidney-shadow',
            slots: 3,
            enrolledSlots: 1,
            desiredSlots: 3,
            maxSlots: 4,
            running: 1,
            lastSeenAt: '2026-11-16T10:00:00.000Z',
          },
          {
            id: 's2',
            name: 'old',
            slots: 1,
            enrolledSlots: 1,
            desiredSlots: null,
            maxSlots: 1,
            running: 0,
            lastSeenAt: null,
          },
        ],
      }),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/sticks');
    expect(r.calls[0]?.init.method).toBe('GET');
    expect(r.out).toEqual([
      'kidney-shadow (s1): 3 troopers (desired 3, max 4), 1 running, last seen 2026-11-16T10:00:00.000Z',
      'old (s2): 1 trooper (desired -, max 1), 0 running, last seen never',
    ]);
    const none = await run(['sticks'], '', fakeFetch(200, { sticks: [] }));
    expect(none.out).toEqual(['no stick has enrolled']);
  });
});

describe('ctl public-url (issue #139)', () => {
  test('set, clear and check map to their routes; anything else is not a command', () => {
    expect(ctlRequest(['public-url', 'set', 'https://a.b.ts.net'])).toEqual({
      path: '/api/control/server/public-url',
      method: 'PUT',
      body: { publicUrl: 'https://a.b.ts.net' },
    });
    expect(ctlRequest(['public-url', 'clear'])).toEqual({
      path: '/api/control/server/public-url',
      method: 'PUT',
      body: { publicUrl: null },
    });
    expect(ctlRequest(['public-url', 'check'])).toEqual({
      path: '/api/control/server/public-url/check',
      method: 'POST',
      body: {},
    });
    expect(ctlRequest(['public-url', 'set'])).toBeNull();
    expect(ctlRequest(['public-url', 'check', 'extra'])).toBeNull();
  });

  test('check prints the Check answer and exits 1 when unreachable; set prints the address', async () => {
    const ok = await run(
      ['public-url', 'check'],
      '',
      fakeFetch(200, { ok: true, message: 'Reachable' }),
    );
    expect([ok.code, ok.out]).toEqual([0, ['Reachable']]);
    const bad = await run(
      ['public-url', 'check'],
      '',
      fakeFetch(200, { ok: false, message: 'HTTP 404 Not Found from https://a.b/healthz' }),
    );
    expect([bad.code, bad.out]).toEqual([1, ['HTTP 404 Not Found from https://a.b/healthz']]);
    const set = await run(
      ['public-url', 'set', 'https://a.b'],
      '',
      fakeFetch(200, { revision: 4, publicUrl: 'https://a.b' }),
    );
    expect([set.code, set.out]).toEqual([0, ['server.publicUrl is https://a.b (revision 4)']]);
    const cleared = await run(
      ['public-url', 'clear'],
      '',
      fakeFetch(200, { revision: 5, publicUrl: null }),
    );
    expect(cleared.out).toEqual(['server.publicUrl is unset (revision 5)']);
  });
});

describe('ctl setup and passphrase verbs', () => {
  test('the setup and passphrase verbs map to their routes; a passphrase in argv is refused', () => {
    expect(ctlRequest(['setup-code'])).toEqual({
      method: 'POST',
      path: '/api/control/setup/code',
      body: {},
    });
    expect(ctlRequest(['setup', 'reopen'])).toEqual({
      method: 'POST',
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
        // Only what changed, for that zone: the PATCH matches zones by id (Task 11).
        dropZones: [{ id: 'main', readyLabel: 'go' }],
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
    expect(s.fetch.calls.at(-1)?.body).toMatchObject({ expectRevision: 3 });
    expect(s.store.current().pollSeconds).toBe(90);
    await s.app.close();
  });

  test('ctl zones set takes nested githubApp paths end to end, and refuses a bad id or a missing installations', async () => {
    const s = server();
    s.store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    // Only the repository id, on a zone without githubApp: installations is required.
    const alone = await run(['zones', 'set', 'main', 'githubApp.repositoryId=123'], '', s.fetch);
    expect(alone.code).toBe(1);
    expect(alone.out.join('\n')).toMatch(/^400 .*githubApp\.installations/);
    // Not a positive id.
    const zero = await run(
      ['zones', 'set', 'main', 'githubApp.repositoryId=0', 'githubApp.installations.author=11'],
      '',
      s.fetch,
    );
    expect(zero.code).toBe(1);
    expect(zero.out.join('\n')).toMatch(/^400 .*githubApp\.repositoryId/);
    expect(s.store.revision()).toBe(2);

    const set = await run(
      ['zones', 'set', 'main', 'githubApp.repositoryId=123', 'githubApp.installations.author=11'],
      '',
      s.fetch,
    );
    expect(set.code).toBe(0);
    expect(s.fetch.calls.at(-1)?.body).toEqual({
      patch: {
        dropZones: [
          { id: 'main', githubApp: { repositoryId: 123, installations: { author: 11 } } },
        ],
      },
      expectRevision: 2,
    });
    expect(s.store.current().dropZones[0]?.githubApp).toEqual({
      repositoryId: 123,
      installations: { author: 11 },
    });
    // A later nested set merges into what is there; null removes the field.
    expect(
      (await run(['zones', 'set', 'main', 'githubApp.installations.reviewer=22'], '', s.fetch))
        .code,
    ).toBe(0);
    expect(s.store.current().dropZones[0]?.githubApp).toEqual({
      repositoryId: 123,
      installations: { author: 11, reviewer: 22 },
    });
    expect((await run(['zones', 'set', 'main', 'githubApp=null'], '', s.fetch)).code).toBe(0);
    expect(s.store.current().dropZones[0]).not.toHaveProperty('githubApp');
    await s.app.close();
  });

  test('ctl config rollback and import refuse to overwrite a revision applied after they read', async () => {
    const s = server();
    await run(['config', 'set', 'pollSeconds=30'], '', s.fetch);
    // Another editor applies between this ctl's read and its write.
    const racing: typeof fetch = async (url, init) => {
      const res = await s.fetch.impl(url, init);
      if (String(url).endsWith('/api/control/config') && (init?.method ?? 'GET') === 'GET')
        s.store.apply(
          { pollSeconds: 45 },
          { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
        );
      return res;
    };
    const back = await run(['config', 'rollback', '1'], '', { calls: [], impl: racing });
    expect(back.code).toBe(1);
    expect(back.out.join('\n')).toMatch(/^409 .*conflict/);
    expect(s.store.current().pollSeconds).toBe(45);
    await s.app.close();
  });

  test('ctl config set refuses an unknown zone, a bad path and a missing value without a write', async () => {
    const s = server();
    for (const args of [
      ['config', 'set', 'dropZones.nope.readyLabel=go'],
      ['config', 'set', 'pollSeconds'],
      ['config', 'set'],
      ['config', 'set', '=1'],
      ['config', 'set', '__proto__.pollSeconds=86400'],
      ['config', 'set', 'usage.constructor.x=1'],
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
    // Conditional on the revision it read first: a newer change elsewhere is a conflict.
    expect(s.fetch.calls.slice(-2).map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/control/config',
      'POST /api/control/config/rollback',
    ]);
    expect(s.fetch.calls.at(-1)?.body).toEqual({ id: 1, note: 'undo it', expectRevision: 2 });
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

  test('ctl settings set and ctl mcp-tokens map to the routes', async () => {
    const s = server();
    s.store.apply(
      { dropZones: [zoneDoc()] },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
    // `settings set` is `config set` for the install-wide paths: one read, one conditional patch.
    const set = await run(
      ['settings', 'set', 'pollSeconds=30', 'mcp.enabled=true', '--note', 'tune'],
      '',
      s.fetch,
    );
    expect(set.code).toBe(0);
    expect(s.fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/control/config',
      'PATCH /api/control/config',
    ]);
    expect(s.fetch.calls[1]?.body).toEqual({
      patch: { pollSeconds: 30, mcp: { enabled: true } },
      expectRevision: 2,
      note: 'tune',
    });
    expect(set.out.join('\n')).toMatch(/revision 3: .*; restart to apply mcp.enabled/);
    // A zone path, a boot setting or an unknown key is not an install setting: no request.
    const before = s.fetch.calls.length;
    for (const [args, says] of [
      [['settings', 'set', 'dropZones.main.readyLabel=go'], /ctl zones set/],
      [['settings', 'set', 'listen.port=8080'], /boot setting/],
      [['settings', 'set', 'pollseconds=30'], /not an install setting/],
      [['settings', 'set'], /usage: ctl settings set/],
      [['settings', 'show'], /usage: ctl settings set/],
      // A --note value is never read as a path, even one that looks like a flag (review M1).
      [
        ['settings', 'set', '--note', '--note', 'dropZones.main.readyLabel=go', 'pollSeconds=30'],
        /ctl zones set/,
      ],
      [['settings', 'set', 'pollSeconds=30', '--note'], /usage: ctl settings set/],
    ] as const) {
      const r = await run([...args], '', s.fetch);
      expect([args, r.code]).toEqual([args, 2]);
      expect(r.err.join('\n')).toMatch(says);
    }
    expect(s.fetch.calls).toHaveLength(before);

    // MCP tokens over the routes that exist since M3.
    expect(ctlRequest(['mcp-tokens', 'mint', 'main', 'write', '--days', '30'])).toEqual({
      method: 'POST',
      path: '/api/control/mcp-tokens',
      body: { zoneId: 'main', scope: 'write', days: 30 },
    });
    expect(
      ctlRequest(['mcp-tokens', 'mint', 'main', 'read', '--label', 'my laptop', '--days', '7']),
    ).toEqual({
      method: 'POST',
      path: '/api/control/mcp-tokens',
      body: { zoneId: 'main', scope: 'read', days: 7, label: 'my laptop' },
    });
    expect(ctlRequest(['mcp-tokens', 'list'])).toEqual({
      path: '/api/control/mcp-tokens',
      method: 'GET',
    });
    expect(ctlRequest(['mcp-tokens', 'revoke', '3'])).toEqual({
      path: '/api/control/mcp-tokens/3',
      method: 'DELETE',
    });
    for (const bad of [
      ['mcp-tokens', 'mint', 'main', 'write'],
      ['mcp-tokens', 'mint', 'main', 'admin', '--days', '7'],
      ['mcp-tokens', 'mint', 'main', 'read', '--days', 'x'],
      ['mcp-tokens', 'mint', 'main', 'read', '--days', '7', '--extra', 'y'],
      ['mcp-tokens', 'revoke', 'x'],
      ['mcp-tokens', 'list', 'more'],
      ['mcp-tokens'],
    ])
      expect([bad, ctlRequest(bad)]).toEqual([bad, null]);

    // Through the real routes: mcp is off in this server, so they are not registered.
    const off = await run(['mcp-tokens', 'list'], '', s.fetch);
    expect(off.code).toBe(1);
    // Printed: mint shows the token once with its id and expiry; list never a value.
    const minted = fakeFetch(200, {
      id: 4,
      token: 'jmm_abc',
      expiresAt: '2026-02-01T00:00:00.000Z',
      zoneId: 'main',
      scope: 'write',
      label: '',
    });
    const m = await run(['mcp-tokens', 'mint', 'main', 'write', '--days', '30'], '', minted);
    expect(m.code).toBe(0);
    expect(m.out).toEqual([
      'MCP token 4 for zone main (write), expires 2026-02-01T00:00:00.000Z',
      'jmm_abc',
      'It is shown this once: store it now (a password manager), or revoke it with jumpmaster ctl mcp-tokens revoke 4.',
    ]);
    const listed = fakeFetch(200, {
      tokens: [
        {
          id: 4,
          zoneId: 'main',
          scope: 'write',
          label: 'laptop',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-02-01T00:00:00.000Z',
          revokedAt: null,
          lastUsedAt: null,
        },
      ],
    });
    const l = await run(['mcp-tokens', 'list'], '', listed);
    expect(l.out).toEqual([
      '#4  main  write  "laptop"  expires 2026-02-01T00:00:00.000Z  last used never',
    ]);
    // The usage line names the new verbs.
    const u = await run(['nope'], '', s.fetch);
    expect(u.err.join('\n')).toMatch(/ctl settings set <path>=<json>/);
    expect(u.err.join('\n')).toMatch(/ctl mcp-tokens mint <zone> <read\|write> --days N/);
    await s.app.close();
  });

  test('ctl config show prints the warnings of a lenient file read', async () => {
    const answer = fakeFetch(200, {
      mode: 'file',
      revision: 1,
      config: { pollSeconds: 5 },
      restartPending: [],
      warnings: ['pollSeconds 1 is outside 5..86400: running with 5; set it in range'],
    });
    const r = await run(['config', 'show'], '', answer);
    expect(r.out[0]).toBe('config: file mode, revision 1');
    expect(r.out[1]).toBe(
      'warning: pollSeconds 1 is outside 5..86400: running with 5; set it in range',
    );
  });
});

describe('ctl secrets (Task 4)', () => {
  const VALUE = 'github_pat_CTLSECRETVALUE_0001';
  const bodyOf = (r: { calls: { init: RequestInit }[] }) =>
    JSON.parse(String(r.calls[0]?.init.body));

  test('ctl secrets set reads the value from stdin or a file and refuses one in argv', async () => {
    const fromStdin = await run(['secrets', 'set', 'githubAuthorToken'], `${VALUE}\n`);
    expect(fromStdin.code).toBe(0);
    expect(fromStdin.calls[0]?.url).toBe(
      'http://127.0.0.1:7420/api/control/secrets/githubAuthorToken',
    );
    expect(fromStdin.calls[0]?.init.method).toBe('PUT');
    expect(bodyOf(fromStdin)).toEqual({ value: VALUE });
    const file = join(mkdtempSync(join(tmpdir(), 'jm-ctl-secret-')), 'v');
    writeFileSync(file, `${VALUE}\n`, { mode: 0o600 });
    const fromFile = await run(
      ['secrets', 'set', 'claudeToken', '--from-file', file, '--created', '2026-01-02'],
      '',
    );
    expect(fromFile.code).toBe(0);
    expect(bodyOf(fromFile)).toEqual({ value: VALUE, declaredCreatedAt: '2026-01-02' });
    // A value in argv would sit in the shell history and the process list.
    const argv = await run(['secrets', 'set', 'githubAuthorToken', VALUE]);
    expect(argv.code).toBe(2);
    expect(argv.calls).toHaveLength(0);
    expect(argv.err.join('\n')).toMatch(/stdin or --from-file/);
    const empty = await run(['secrets', 'set', 'githubAuthorToken'], '\n');
    expect(empty.code).toBe(2);
    for (const r of [fromStdin, fromFile, argv, empty]) {
      expect(`${r.out.join('\n')}${r.err.join('\n')}`).not.toContain(VALUE);
      expect(r.calls[0]?.url ?? '').not.toContain(VALUE);
    }
  });

  test('list, test, remove and reload reach their routes', async () => {
    expect((await run(['secrets', 'list'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets',
      init: { method: 'GET' },
    });
    expect((await run(['secrets', 'test', 'claudeToken'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/claudeToken/test',
      init: { method: 'POST' },
    });
    expect((await run(['secrets', 'remove', 'githubReadToken'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/githubReadToken',
      init: { method: 'DELETE' },
    });
    expect((await run(['secrets', 'reload'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/reload',
      init: { method: 'POST' },
    });
    expect((await run(['secrets', 'nope'])).code).toBe(2);
  });

  test('secrets test github-app/<owner>/<role> reaches the app entry route; a PAT name and list keep theirs', async () => {
    const app = await run(['secrets', 'test', 'github-app/acme/author']);
    expect(app.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/github-app/acme/author/test',
      init: { method: 'POST' },
    });
    expect(ctlRequest(['secrets', 'test', 'github-app/acme/author'])).toEqual({
      path: '/api/control/secrets/github-app/acme/author/test',
      method: 'POST',
      body: {},
    });
    // Each segment is encoded on its own.
    expect(ctlRequest(['secrets', 'test', 'github-app/a b/author'])?.path).toBe(
      '/api/control/secrets/github-app/a%20b/author/test',
    );
    expect((await run(['secrets', 'test', 'githubAuthorToken'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/githubAuthorToken/test',
      init: { method: 'POST' },
    });
    expect(ctlRequest(['secrets', 'test', 'githubAuthorToken'])?.path).toBe(
      '/api/control/secrets/githubAuthorToken/test',
    );
    expect((await run(['secrets', 'list'])).calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets',
      init: { method: 'GET' },
    });
  });

  test('vault on, off, prefer and copy-to-vault reach their routes and send no value', async () => {
    const on = await run(['secrets', 'vault', 'on']);
    expect(on.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/vault/on',
      init: { method: 'POST' },
    });
    expect((await run(['secrets', 'vault', 'off'])).calls[0]?.url).toBe(
      'http://127.0.0.1:7420/api/control/secrets/vault/off',
    );
    const prefer = await run(['secrets', 'vault', 'prefer', 'on']);
    expect(prefer.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/secrets/vault/prefer');
    expect(bodyOf(prefer)).toEqual({ prefer: true });
    expect(bodyOf(await run(['secrets', 'vault', 'prefer', 'off']))).toEqual({ prefer: false });
    const copy = await run(['secrets', 'copy-to-vault', 'githubReadToken']);
    expect(copy.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:7420/api/control/secrets/githubReadToken/copy-to-vault',
      init: { method: 'POST' },
    });
    expect(bodyOf(copy)).toEqual({});
    expect((await run(['secrets', 'vault', 'prefer'])).code).toBe(2);
    expect((await run(['secrets', 'vault', 'maybe'])).code).toBe(2);
  });
});

describe('ctl detect and ctl zones add', () => {
  test('ctl detect and ctl zones add map to the routes', () => {
    expect(ctlRequest(['detect', 'octo/demo'])).toEqual({
      method: 'POST',
      path: '/api/control/detect',
      body: { repo: 'octo/demo' },
    });
    expect(
      ctlRequest([
        'zones',
        'add',
        'octo/demo',
        '--id',
        'web',
        '--preset',
        'node',
        '--identity',
        'starter',
        '--egress',
        'enforce',
        '--resume',
      ]),
    ).toEqual({
      method: 'POST',
      path: '/api/control/zones',
      body: {
        zone: {
          repo: 'octo/demo',
          id: 'web',
          preset: 'node',
          identity: 'starter',
          egress: { mode: 'enforce' },
        },
        resume: true,
      },
    });
    for (const bad of [
      ['detect'],
      ['detect', 'octo/demo', 'extra'],
      ['zones', 'add'],
      ['zones', 'add', 'octo/demo', '--egress', 'wide'],
      ['zones', 'add', 'octo/demo', '--identity', 'admin'],
      ['zones', 'add', 'octo/demo', '--id'],
      ['zones', 'add', 'octo/demo', '--unknown'],
      ['zones', 'rename', 'demo'],
      ['zones', 'add', 'octo/demo', '--preset', 'cobol'],
      ['zones', 'add', 'octo/demo', '--id', 'Not_Valid'],
    ])
      expect(ctlRequest(bad), bad.join(' ')).toBeNull();
  });

  test('ctl zones add without --egress writes monitor', () => {
    expect(ctlRequest(['zones', 'add', 'octo/demo'])).toEqual({
      method: 'POST',
      path: '/api/control/zones',
      body: { zone: { repo: 'octo/demo', egress: { mode: 'monitor' } } },
    });
  });
});

describe('ctl zones add output', () => {
  test('ctl zones add prints the zone, preset and gates it wrote', async () => {
    const r = await run(
      ['zones', 'add', 'octo/demo'],
      '',
      fakeFetch(200, {
        revision: 2,
        changed: ['dropZones[demo]'],
        restartNeeded: [],
        zone: 'demo',
        preset: 'node',
        gates: [
          { name: 'test', run: 'npm test' },
          { name: 'lint', run: 'npm run lint' },
        ],
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      'added zone demo (revision 2), preset node, egress monitor',
      '  gate test: npm test',
      '  gate lint: npm run lint',
    ]);
  });
});

describe('ctl github (Task 7)', () => {
  const GUIDANCE = {
    recommendation: {
      identity: 'two-bot',
      authorMayBeAdmin: false,
      reason: 'This repository belongs to an organization.',
      ask: 'Is the owner on a paid plan?',
    },
    pat: {
      author: 'https://github.com/settings/personal-access-tokens/new?name=a',
      reviewer: 'https://github.com/settings/personal-access-tokens/new?name=r',
      read: 'https://github.com/settings/personal-access-tokens/new?name=d',
    },
    ruleset: { filename: 'jumpmaster-demo-ruleset.json', text: '{\n  "name": "jumpmaster"\n}\n' },
    codeowners: {
      filename: '.github/CODEOWNERS',
      text: '# zone demo\n.github/** @alice\n',
      newFileUrl: 'https://github.com/octo/demo/new/main?filename=.github%2FCODEOWNERS',
    },
    checklist: {
      url: 'https://github.com/octo/demo/settings/access',
      items: ['invite jm-author with the Write role', 'accept the invitation as jm-author'],
    },
    rulesUrl: 'https://github.com/octo/demo/settings/rules',
  };

  test('ctl github maps to the routes and prints each artifact', async () => {
    expect(ctlRequest(['github', 'demo', 'ruleset'])).toEqual({
      path: '/api/control/zones/demo/github',
      method: 'GET',
    });
    expect(ctlRequest(['github', 'demo', 'codeowners', '--reviewer', 'alice'])).toEqual({
      path: '/api/control/zones/demo/github?reviewer=alice',
      method: 'GET',
    });
    expect(
      ctlRequest(['github', 'demo', 'codeowners', '--reviewer', 'alice', '--reviewer', 'bob']),
    ).toEqual({ path: '/api/control/zones/demo/github?reviewer=alice%2Cbob', method: 'GET' });
    for (const bad of [
      ['github'],
      ['github', 'demo'],
      ['github', 'demo', 'nope'],
      ['github', 'demo', 'pat'],
      ['github', 'demo', 'pat', 'admin'],
      ['github', 'demo', 'codeowners', '--reviewer'],
      ['github', 'demo', 'ruleset', '--reviewer', 'alice'],
    ])
      expect(ctlRequest(bad), bad.join(' ')).toBeNull();

    // The ruleset and CODEOWNERS print as the file alone, for the host to redirect.
    const ruleset = await run(['github', 'demo', 'ruleset'], '', fakeFetch(200, GUIDANCE));
    expect(ruleset.code).toBe(0);
    expect(ruleset.out.join('\n')).toBe(GUIDANCE.ruleset.text.trimEnd());
    expect(ruleset.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/zones/demo/github');
    expect(ruleset.calls[0]?.init.method).toBe('GET');
    const co = await run(['github', 'demo', 'codeowners'], '', fakeFetch(200, GUIDANCE));
    expect(co.out.join('\n')).toBe(GUIDANCE.codeowners.text.trimEnd());
    // A link, with what the step says beside it.
    const pat = await run(['github', 'demo', 'pat', 'reviewer'], '', fakeFetch(200, GUIDANCE));
    expect(pat.out[0]).toBe(GUIDANCE.pat.reviewer);
    expect(pat.out.join('\n')).toContain('check the Resource owner field');
    expect(pat.out.join('\n')).toContain('Only select repositories');
    expect(pat.out.join('\n')).toContain('token lifetime policy');
    const rec = await run(['github', 'demo', 'recommend'], '', fakeFetch(200, GUIDANCE));
    expect(rec.out).toEqual([
      'identity: two-bot',
      'authorMayBeAdmin: false',
      'This repository belongs to an organization.',
      'first: Is the owner on a paid plan?',
    ]);
    const list = await run(['github', 'demo', 'checklist'], '', fakeFetch(200, GUIDANCE));
    expect(list.out).toEqual([
      GUIDANCE.checklist.url,
      '- invite jm-author with the Write role',
      '- accept the invitation as jm-author',
    ]);
    // A refusal prints the status and the server's answer, and fails.
    const no = await run(
      ['github', 'demo', 'ruleset'],
      '',
      fakeFetch(409, { error: 'set the author token first' }),
    );
    expect(no.code).toBe(1);
    expect(no.out.join('\n')).toContain('409');
  });

  test('the usage line names ctl github', async () => {
    const r = await run(['github']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('ctl github <zone> recommend');
  });
});

describe('ctl doctor actions (Task 8)', () => {
  const doctorRunValue = {
    id: 3,
    finishedAt: '2026-01-01T00:00:00.000Z',
    checks: [
      { id: 'config.listen', zoneId: null, status: 'pass', summary: 'loopback' },
      {
        id: 'forge.branch-rules',
        zoneId: 'main',
        status: 'fail',
        summary: 'no rules',
        action: {
          kind: 'forge',
          label: 'Import the ruleset file on GitHub',
          href: 'https://github.com/octo/demo/settings/rules',
          artifact: { filename: 'jumpmaster-main-ruleset.json', text: '{"name":"jumpmaster"}\n' },
        },
      },
      {
        id: 'forge.labels',
        zoneId: 'main',
        status: 'fail',
        summary: 'missing',
        action: {
          kind: 'app',
          label: 'Create the missing labels',
          href: '/api/control/zones/main/labels',
          method: 'POST',
        },
      },
      {
        id: 'forge.codeowners',
        zoneId: '../x',
        status: 'fail',
        summary: 'none',
        action: {
          kind: 'forge',
          label: 'Create CODEOWNERS',
          href: 'https://github.com/octo/demo/new/main',
          artifact: { filename: '../../CODEOWNERS', text: '* @bot\n' },
        },
      },
    ],
  };

  test('ctl doctor prints the action for each fail and writes artifacts to the given directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-artifacts-'));
    const r = await run(['doctor', '--artifacts', dir], '', fakeFetch(200, { run: doctorRun }));
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/doctor');
    expect(JSON.parse(String(r.calls[0]?.init.body))).toEqual({});
    const out = r.out.join('\n');
    expect(out).toContain(
      'action: Import the ruleset file on GitHub: https://github.com/octo/demo/settings/rules',
    );
    expect(out).toContain(
      'action: Create the missing labels: POST /api/control/zones/main/labels (jumpmaster ctl labels main)',
    );
    expect(out).not.toMatch(/action: .*loopback/);
    // Each file under the directory, by its base name only.
    expect(readdirSync(dir).sort()).toEqual(['CODEOWNERS', 'jumpmaster-main-ruleset.json']);
    expect(readFileSync(join(dir, 'jumpmaster-main-ruleset.json'), 'utf8')).toBe(
      '{"name":"jumpmaster"}\n',
    );
    expect(out).toContain(`wrote ${join(dir, 'jumpmaster-main-ruleset.json')}`);
    // Without --artifacts nothing is written, and the line says how to get them.
    const plain = await run(['doctor'], '', fakeFetch(200, { run: doctorRun }));
    expect(plain.out.join('\n')).toContain(
      'file: jumpmaster-main-ruleset.json (jumpmaster ctl doctor --artifacts <dir> writes it)',
    );
  });

  test('ctl labels <zone> posts the label action', async () => {
    const r = await run(['labels', 'main']);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/zones/main/labels');
    expect(r.calls[0]?.init.method).toBe('POST');
  });
  const doctorRun = doctorRunValue;
});

test('ctl doctor strips control characters from every line, and says overwrote when it replaces a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jm-artifacts-'));
  writeFileSync(join(dir, 'CODEOWNERS'), 'old\n');
  const hostile = {
    id: 1,
    finishedAt: 'x',
    checks: [
      {
        id: 'forge.ci',
        zoneId: 'main',
        status: 'fail',
        summary: 'bad \u001b[2Jsummary',
        action: {
          kind: 'forge',
          label: 'Open GitHub Actions (detected jobs: a\u001b[31mred\nrm -rf)',
          href: 'https://github.com/octo/demo/actions',
          artifact: { filename: 'CODEOWNERS', text: '* @bot\n' },
        },
      },
    ],
  };
  const out: string[] = [];
  await runCtl(
    ['doctor', '--artifacts', dir],
    env,
    fakeFetch(200, { run: hostile }).impl,
    (l) => out.push(l),
    () => {},
    async () => '',
  );
  const text = out.join('\n');
  for (const line of out) expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(text).toContain(
    'action: Open GitHub Actions (detected jobs: a[31mredrm -rf): https://github.com/octo/demo/actions',
  );
  expect(text).toContain(`overwrote ${join(dir, 'CODEOWNERS')}`);
  expect(readFileSync(join(dir, 'CODEOWNERS'), 'utf8')).toBe('* @bot\n');
});

describe('ctl zones', () => {
  test('ctl zones list, show, remove and egress map to the routes', () => {
    expect(ctlRequest(['zones', 'list'])).toEqual({ path: '/api/control/zones', method: 'GET' });
    expect(ctlRequest(['zones', 'list', '--json'])).toEqual({
      path: '/api/control/zones',
      method: 'GET',
    });
    expect(ctlRequest(['zones', 'show', 'web'])).toEqual({
      path: '/api/control/zones/web',
      method: 'GET',
    });
    expect(ctlRequest(['zones', 'remove', 'web'])).toEqual({
      path: '/api/control/zones/web',
      method: 'DELETE',
    });
    expect(ctlRequest(['zones', 'egress', 'observed', 'web'])).toEqual({
      path: '/api/control/zones/web/egress/observed',
      method: 'GET',
    });
    expect(
      ctlRequest(['zones', 'egress', 'adopt', 'web', 'a.example.com', '*.b.example.com']),
    ).toEqual({
      method: 'POST',
      path: '/api/control/zones/web/egress/adopt',
      body: { hosts: ['a.example.com', '*.b.example.com'] },
    });
    for (const bad of [
      ['zones', 'show'],
      ['zones', 'remove'],
      ['zones', 'egress', 'adopt', 'web'],
      ['zones', 'egress', 'observed'],
      ['zones', 'list', 'extra'],
    ])
      expect(ctlRequest(bad), bad.join(' ')).toBeNull();
  });

  test('ctl zones set, remove and egress adopt map to the routes and refuse an unknown path', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const impl = (async (url: URL | string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === 'GET')
        return new Response(
          JSON.stringify({ revision: 7, config: { dropZones: [{ id: 'web' }] } }),
        );
      return new Response(
        JSON.stringify({ revision: 8, changed: ['dropZones[web].readyLabel'], restartNeeded: [] }),
      );
    }) as typeof fetch;
    const r = await run(
      ['zones', 'set', 'web', 'readyLabel="go"', 'egress.mode=enforce', 'retryLabel=null'],
      '',
      { calls, impl },
    );
    expect(r.code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/control/config',
      'PATCH /api/control/config',
    ]);
    expect(calls[1]?.body).toEqual({
      patch: {
        dropZones: [{ id: 'web', readyLabel: 'go', egress: { mode: 'enforce' }, retryLabel: null }],
      },
      expectRevision: 7,
    });
    expect(r.out.join('\n')).toMatch(/revision 8/);
    // An unknown key, an unknown zone, and a missing value: refused before any write.
    calls.length = 0;
    for (const args of [
      ['zones', 'set', 'web', 'readylabel=go'],
      ['zones', 'set', 'web', 'id=other'],
      ['zones', 'set', 'web', 'repo="o/x"'],
      ['zones', 'set', 'web'],
      ['zones', 'set', 'web', 'egress'],
    ]) {
      const bad = await run(args, '', { calls, impl });
      expect(bad.code, args.join(' ')).toBe(2);
    }
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    const ghost = await run(['zones', 'set', 'nope', 'readyLabel=go'], '', { calls, impl });
    expect(ghost.code).toBe(2);
    expect(ghost.err.join('\n')).toMatch(/no zone nope/);
  });
});

describe('ctl config set and the zone list', () => {
  test('ctl config set refuses the whole zone list and a zone by id, naming the verbs to use', async () => {
    for (const args of [
      ['config', 'set', 'dropZones=[]'],
      ['config', 'set', 'dropZones.web=null'],
      ['config', 'set', 'dropZones.web={"repo":"o/x"}'],
    ]) {
      const calls: string[] = [];
      const impl = (async (url: URL | string) => {
        calls.push(String(url));
        return new Response('{}');
      }) as typeof fetch;
      const r = await run(args, '', { calls, impl });
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err.join('\n')).toMatch(/ctl zones remove/);
      expect(r.err.join('\n')).toMatch(/ctl config import/);
      expect(calls).toEqual([]);
    }
  });
});

describe('ctl status', () => {
  const status = {
    headline: 'Waiting on CI for PR #12 (20 of 45 min)',
    detail: 'After the deadline the item parks with the reason CI gave, or that it gave none.',
    waitingOn: 'ci',
    since: '2026-01-01T00:40:00.000Z',
    action: { label: 'Open PR #12', href: 'https://github.com/octo/demo/pull/12' },
  };

  test('ctl status prints the headline and detail, and --json the object', async () => {
    expect(ctlRequest(['status'])).toEqual({ path: '/api/control/status', method: 'GET' });
    expect(ctlRequest(['status', '--json'])).toEqual({
      path: '/api/control/status',
      method: 'GET',
    });
    expect(ctlRequest(['status', 'extra'])).toBeNull();
    const text = await run(['status'], '', fakeFetch(200, status));
    expect(text.code).toBe(0);
    expect(text.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/status');
    expect(text.out).toEqual([
      status.headline,
      status.detail,
      `next: ${status.action.label}: ${status.action.href}`,
    ]);
    const json = await run(['status', '--json'], '', fakeFetch(200, status));
    expect(JSON.parse(json.out.join('\n'))).toEqual(status);
    // Nothing more to say: the headline alone.
    const idle = await run(
      ['status'],
      '',
      fakeFetch(200, { headline: 'Idle', detail: '', waitingOn: 'you' }),
    );
    expect(idle.out).toEqual(['Idle']);
    // A refusal is printed as it came, and fails.
    const refused = await run(['status'], '', fakeFetch(401, { error: 'unauthorized' }));
    expect(refused.code).toBe(1);
  });
});

describe('ctl status, round 2', () => {
  test('ctl status prints the other blockers as plain lines, without backticks or control characters', async () => {
    const st = {
      headline: '1 parked: no CI result: \u001b[31mred\u001b[0m\u0007',
      detail: 'check `docker compose logs stick`',
      waitingOn: 'you',
      also: [
        { text: 'demo: no Claude token', href: '/settings/credentials' },
        { text: 'no pass yet since \u001b]0;title\u0007start' },
      ],
      action: { label: 'See the items on home', href: '/' },
    };
    const r = await run(['status'], '', fakeFetch(200, st));
    expect(r.out).toEqual([
      '1 parked: no CI result: [31mred[0m',
      'check docker compose logs stick',
      '- demo: no Claude token (fix: /settings/credentials)',
      '- no pass yet since ]0;titlestart',
      'next: See the items on home: /',
    ]);
    for (const line of r.out) expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe('the verbs Task 14 adds for parity', () => {
  test('ctl intake sends the answers from a file (a fresh idempotency key per issue), github recommend posts the repository, and doctor --last reads the latest run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-intake-'));
    const issue = join(dir, 'issue.json');
    const spec = { title: 't', context: 'c', acceptance: ['a'], tests: ['b'] };
    writeFileSync(issue, JSON.stringify(spec));
    const filed = await run(['intake', 'web', 'issue', issue], '', fakeFetch(201, { number: 7 }));
    expect(filed.code).toBe(0);
    expect(filed.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/zones/web/intake/issue');
    const sent = JSON.parse(String(filed.calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject(spec);
    expect(sent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    const stubFile = join(dir, 'goal.json');
    writeFileSync(
      stubFile,
      JSON.stringify({ template: 'idea', lighthouse: 'l', objectives: ['o'] }),
    );
    const stub = await run(
      ['intake', 'web', 'stub', stubFile],
      '',
      fakeFetch(200, { markdown: '# Goal\n' }),
    );
    expect(stub.out).toEqual(['# Goal']);
    const missing = await run(['intake', 'web', 'issue', join(dir, 'nope.json')]);
    expect(missing.code).toBe(2);
    expect(missing.calls).toEqual([]);

    expect(
      ctlRequest(['github', 'recommend', 'octo/demo', '--paid-plan', '--identity', 'starter']),
    ).toEqual({
      path: '/api/control/github/recommend',
      method: 'POST',
      body: { repo: 'octo/demo', paidPlan: true, identity: 'starter' },
    });
    // A zone named like the verb keeps its own form.
    expect(ctlRequest(['github', 'recommend', 'ruleset'])).toEqual({
      path: '/api/control/zones/recommend/github',
      method: 'GET',
    });

    expect(ctlRequest(['doctor', '--last', '--json'])).toEqual({
      path: '/api/control/doctor',
      method: 'GET',
    });
    expect(ctlRequest(['doctor', 'web', '--last'])).toBeNull();
    const none = await run(['doctor', '--last'], '', fakeFetch(200, { run: null }));
    expect([none.code, none.out]).toEqual([
      0,
      ['no doctor run yet: jumpmaster ctl doctor runs one'],
    ]);
  });
});

describe('ctl dismiss', () => {
  test("dismisses the named briefings of one zone, as the zone's briefings page does", () => {
    expect(ctlRequest(['dismiss', 'web', '3', '4'])).toEqual({
      path: '/api/control/zones/web/briefings/dismiss',
      method: 'POST',
      body: { ids: [3, 4] },
    });
  });

  test('needs a zone and at least one briefing id, each a positive integer', () => {
    expect(ctlRequest(['dismiss'])).toBeNull();
    expect(ctlRequest(['dismiss', 'web'])).toBeNull();
    expect(ctlRequest(['dismiss', 'web', 'all'])).toBeNull();
    expect(ctlRequest(['dismiss', 'web', '3', '0'])).toBeNull();
    expect(ctlRequest(['dismiss', 'web', '1.5'])).toBeNull();
  });
});

describe('ctl transcripts (#195)', () => {
  const JSONL = '{"dropId":"d1","header":true}\n{"dropId":"d1","seq":1,"data":{"a": "ü"}}\n';
  /** A fetch answering the export in small chunks, as a stream would arrive. */
  function ndjsonFetch(status = 200, text = JSONL) {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const bytes = Buffer.from(text);
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
          c.close();
        },
      });
      return new Response(body, { status });
    }) as typeof fetch;
    return { calls, impl };
  }

  test('argument parsing: the routes, the window as a query, --out never sent', () => {
    expect(ctlRequest(['drops', 'transcript', 'd1'])).toEqual({
      method: 'GET',
      path: '/api/control/drops/d1/transcript',
    });
    expect(ctlRequest(['drops', 'transcript', 'd1', '--out', 'x.jsonl'])).toEqual({
      method: 'GET',
      path: '/api/control/drops/d1/transcript',
    });
    expect(ctlRequest(['zones', 'transcripts', 'jm', '--since', '2026-11-16'])).toEqual({
      method: 'GET',
      path: '/api/control/zones/jm/transcripts?since=2026-11-16',
    });
    expect(
      ctlRequest([
        'zones',
        'transcripts',
        'jm',
        '--out',
        'jm.jsonl',
        '--until',
        '2026-12-01',
        '--since',
        '2026-11-16',
      ]),
    ).toEqual({
      method: 'GET',
      path: '/api/control/zones/jm/transcripts?since=2026-11-16&until=2026-12-01',
    });
    for (const bad of [
      ['drops', 'transcript'],
      ['drops', 'transcript', '--out', 'f'],
      ['drops', 'transcript', 'd1', '--out'],
      ['drops', 'transcript', 'd1', 'extra'],
      ['drops', 'transcript', 'd1', '--since', '2026-11-16'],
      ['zones', 'transcripts', 'jm'],
      ['zones', 'transcripts', '--since', '2026-11-16'],
      ['zones', 'transcripts', 'jm', '--since'],
      ['zones', 'transcripts', 'jm', '--since', '16/11/2026'],
      ['zones', 'transcripts', 'jm', '--since', '2026-11-16T00:00:00Z'],
      ['zones', 'transcripts', 'jm', '--since', '2026-11-16', '--until', 'soon'],
      ['zones', 'transcripts', 'jm', '--since', '2026-11-16', '--since', '2026-11-17'],
      ['zones', 'transcripts', 'jm', '--since', '2026-11-16', '--json'],
      ['zones', 'transcripts', 'jm', 'web', '--since', '2026-11-16'],
    ])
      expect(ctlRequest(bad), bad.join(' ')).toBeNull();
  });

  test('without --out the lines go to stdout, exactly', async () => {
    const f = ndjsonFetch();
    const r = await run(['drops', 'transcript', 'd1'], '', f);
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe('http://127.0.0.1:7420/api/control/drops/d1/transcript');
    expect(r.calls[0]?.init.method).toBe('GET');
    expect(r.out).toEqual(JSONL.split('\n').slice(0, -1));
    expect(r.err).toEqual([]);
  });

  test('--out writes the file 0600, byte for byte, and says where', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-transcript-'));
    const file = join(dir, 'jm.jsonl');
    const r = await run(
      ['zones', 'transcripts', 'jm', '--since', '2026-11-16', '--out', file],
      '',
      ndjsonFetch(),
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]?.url).toBe(
      'http://127.0.0.1:7420/api/control/zones/jm/transcripts?since=2026-11-16',
    );
    expect(readFileSync(file, 'utf8')).toBe(JSONL);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual([`wrote ${file}`]);
  });

  test('--out refuses to overwrite an existing file and asks the server nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-transcript-'));
    const file = join(dir, 'old.jsonl');
    writeFileSync(file, 'keep me');
    const r = await run(['drops', 'transcript', 'd1', '--out', file], '', ndjsonFetch());
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('keep me');
    expect(r.err.join('\n')).toMatch(/exists.*not overwritten/);
  });

  test('a refused export (400, 404) says why on stderr, exits 1 and leaves no file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-transcript-'));
    const file = join(dir, 'jm.jsonl');
    const r = await run(
      [
        'zones',
        'transcripts',
        'jm',
        '--since',
        '2026-01-01',
        '--until',
        '2026-12-31',
        '--out',
        file,
      ],
      '',
      ndjsonFetch(400, '{"error":"the window is at most 92 days"}'),
    );
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['400 {"error":"the window is at most 92 days"}']);
    expect(readdirSync(dir)).toEqual([]);
    const s = await run(
      ['drops', 'transcript', 'nope'],
      '',
      ndjsonFetch(404, '{"error":"unknown drop"}'),
    );
    expect(s.code).toBe(1);
    expect(s.out).toEqual([]);
    expect(s.err).toEqual(['404 {"error":"unknown drop"}']);
  });
});

describe('ctl briefings reads on its own (#226)', () => {
  // The two briefings Command found barely actionable, as the route now serves them.
  const refuteExhausted = {
    id: 142,
    zone: 'main',
    kind: 'refute_exhausted',
    subject: 'issue:21',
    decision: 'Promote crew issue #224 as revised?',
    options: [
      {
        id: 'promote',
        label: 'Promote',
        effectText: 'the issue gets the ready label; an implementer takes it as written',
      },
      {
        id: 'reject',
        label: 'Reject',
        effectText: 'the issue is closed; the crew may file a replacement',
      },
    ],
    optionsDigest: 'abc123',
    about: {
      text: '#224 Push tokens in app mode: a contents:write token per push',
      url: 'https://github.com/octo/demo/issues/224',
    },
    why: [
      "#224 Push tokens in app mode: a contents:write token per push was reviewed 2 times. Each review asked for changes, and the last revision hasn't been reviewed.",
      '',
      'Review 1 (2026-11-01 10:05 UTC), asked to revise:',
      '  1. Criterion 2 is not testable.',
      '  full text: /drops/r1',
      '',
      'Review 2 (2026-11-01 11:05 UTC), asked to revise:',
      '  1. The token scope is wider than the push needs.',
      '  full text: /drops/r2',
      '',
      "Promote if the last review's findings were only wording; reject if it found a design problem.",
    ].join('\n'),
    recommendation: '',
    onHold: 'crew issue #224',
  };
  const crewLead = {
    id: 150,
    zone: 'main',
    kind: 'crew',
    subject: 'crew:Objective pointer still on Task 7 after Ruling 42',
    decision: 'Objective pointer still on Task 7 after Ruling 42',
    options: [
      {
        id: 'o1',
        label: 'File app-push-token first',
        effectText: 'recorded as guidance for the crew; nothing changes on GitHub',
      },
      {
        id: 'o2',
        label: 'Drop kill-suspend-installations',
        effectText: 'recorded as guidance for the crew; nothing changes on GitHub',
      },
    ],
    optionsDigest: 'def456',
    about: { text: 'Objective pointer still on Task 7 after Ruling 42' },
    why: 'Task 5 is done, but Briefing 125 \u001b[31mwas never ruled.',
    recommendation: 'o1',
    onHold: 'Task 7',
  };

  test('the text form gives About with its URL, why, recommendation, on hold, effects and the page', async () => {
    const r = await run(
      ['briefings'],
      '',
      fakeFetch(200, { briefings: [refuteExhausted, crewLead] }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      'Briefing 142 (zone main, refute_exhausted)',
      '  About: #224 Push tokens in app mode: a contents:write token per push <https://github.com/octo/demo/issues/224>',
      '  Decision: Promote crew issue #224 as revised?',
      '  Why:',
      "    #224 Push tokens in app mode: a contents:write token per push was reviewed 2 times. Each review asked for changes, and the last revision hasn't been reviewed.",
      '',
      '    Review 1 (2026-11-01 10:05 UTC), asked to revise:',
      '      1. Criterion 2 is not testable.',
      '      full text: http://127.0.0.1:7420/drops/r1',
      '',
      '    Review 2 (2026-11-01 11:05 UTC), asked to revise:',
      '      1. The token scope is wider than the push needs.',
      '      full text: http://127.0.0.1:7420/drops/r2',
      '',
      "    Promote if the last review's findings were only wording; reject if it found a design problem.",
      '  On hold: crew issue #224',
      '  Options:',
      '    promote: Promote: the issue gets the ready label; an implementer takes it as written',
      '    reject: Reject: the issue is closed; the crew may file a replacement',
      '  Rule: jumpmaster ctl rule 142 <option> --options abc123 [note]',
      '  Page: http://127.0.0.1:7420/briefings/142',
      '',
      'Briefing 150 (zone main, crew)',
      '  About: Objective pointer still on Task 7 after Ruling 42',
      '  Decision: Objective pointer still on Task 7 after Ruling 42',
      '  Why:',
      '    Task 5 is done, but Briefing 125 [31mwas never ruled.',
      '  Recommendation: o1',
      '  On hold: Task 7',
      '  Options:',
      '    o1: File app-push-token first: recorded as guidance for the crew; nothing changes on GitHub',
      '    o2: Drop kill-suspend-installations: recorded as guidance for the crew; nothing changes on GitHub',
      '  Rule: jumpmaster ctl rule 150 <option> --options def456 [note]',
      '  Page: http://127.0.0.1:7420/briefings/150',
    ]);
    const none = await run(['briefings'], '', fakeFetch(200, { briefings: [] }));
    expect(none.out).toEqual(['nothing is waiting on you']);
  });

  test('--json keeps every old key and adds about, why, recommendation, onHold and effectText', async () => {
    expect(ctlRequest(['briefings', '--json'])).toEqual({
      path: '/api/control/briefings',
      method: 'GET',
    });
    expect(ctlRequest(['briefings', 'extra'])).toBeNull();
    const r = await run(['briefings', '--json'], '', fakeFetch(200, { briefings: [crewLead] }));
    expect(r.code).toBe(0);
    const [b] = (JSON.parse(r.out.join('\n')) as { briefings: Record<string, unknown>[] })
      .briefings;
    for (const key of ['id', 'zone', 'kind', 'subject', 'decision', 'options', 'optionsDigest'])
      expect(b, key).toHaveProperty(key);
    expect(b).toEqual(crewLead);
    // A refusal is printed as it came, and fails.
    const refused = await run(['briefings'], '', fakeFetch(401, { error: 'unauthorized' }));
    expect(refused.code).toBe(1);
  });
});

describe('ctl kill / unkill and suspended installations (issue #225)', () => {
  test('prints today’s line alone without installations, or with none failed; exit 0', async () => {
    for (const [cmd, body] of [
      ['kill', { engaged: true, cancelled: 2 }],
      ['unkill', { engaged: false, cancelled: 0 }],
      ['kill', { engaged: true, cancelled: 0, installations: { ok: 3, failed: [] } }],
      ['unkill', { engaged: false, cancelled: 0, installations: { ok: 3, failed: [] } }],
    ] as const) {
      const r = await run([cmd], '', fakeFetch(200, body));
      expect(r.code).toBe(0);
      expect(r.out).toEqual([`200 ${JSON.stringify(body)}`]);
    }
  });

  test('prints one line per failed installation after today’s line; the exit code is unchanged', async () => {
    const failed = [
      { owner: 'octo', role: 'author', installationId: 11, status: 500 },
      { owner: 'other', role: 'reviewer', installationId: 13, status: 0 },
    ];
    for (const [cmd, verb] of [
      ['kill', 'suspend'],
      ['unkill', 'unsuspend'],
    ] as const) {
      const body = { engaged: cmd === 'kill', cancelled: 0, installations: { ok: 1, failed } };
      const r = await run([cmd], '', fakeFetch(200, body));
      expect(r.code).toBe(0);
      expect(r.out).toEqual([
        `200 ${JSON.stringify(body)}`,
        `could not ${verb} the author app installation 11 of octo (status 500)`,
        `could not ${verb} the reviewer app installation 13 of other (status 0)`,
      ]);
    }
  });

  test('a refused kill prints today’s line and exits 1', async () => {
    const r = await run(['kill'], '', fakeFetch(400, { error: 'invalid body' }));
    expect(r.code).toBe(1);
    expect(r.out).toEqual(['400 {"error":"invalid body"}']);
  });
});
