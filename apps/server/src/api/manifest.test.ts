import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp, routesOf } from '../app.js';
import { loadBoot } from '../config/boot.js';
import { ConfigStore } from '../config/store.js';
import { ZONE_ID } from '../config.js';
import { CTL_ZONE_ID, ctlHelp, ctlRequest, runCtl } from '../ctl.js';
import { openDb } from '../db/open.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import { CONTROL_ROUTES, CTL_VERBS, SWITCHES } from './manifest.js';

const TOKEN = 'o'.repeat(32);
const env = { JM_OPERATOR_TOKEN: TOKEN, JM_JOIN_TOKEN: 'join-secret-value-4' };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** The whole app as `serve` builds it: a store, the forges, and MCP on or off. */
async function server(o: { mcp: boolean }) {
  const db = openDb(tmpDbFile());
  const dir = mkdtempSync(join(tmpdir(), 'jm-manifest-'));
  const store = ConfigStore.open({
    db,
    boot: loadBoot({}, undefined),
    env,
    now: () => t0,
    imageLockPath: join(dir, 'no-lock.json'),
  });
  if (o.mcp)
    store.apply(
      { mcp: { enabled: true } },
      { via: 'ctl', principal: { kind: 'operator', via: 'token', sudo: true } },
    );
  const app = createApp({
    db,
    config: store,
    now: () => t0,
    forgesFor: () => {
      throw new Error('no forge in this test');
    },
  });
  await app.ready();
  close = () => app.close();
  return app;
}

const key = (method: string, path: string) => `${method} ${path}`;
const controlKeys = (routes: { method: string; url: string }[]) =>
  routes
    .filter((r) => r.url.startsWith('/api/control/') && r.method !== 'HEAD')
    .map((r) => key(r.method, r.url))
    .sort();

/** An argv from an example: words split on spaces, the leading `ctl` dropped. */
const argvOf = (example: string): string[] => example.split(' ').slice(1);

/** Whether a concrete path is an instance of a manifest path (`:id` matches one segment). */
const matches = (pattern: string, path: string): boolean =>
  new RegExp(`^${pattern.replace(/:[a-z]+/gi, '[^/?]+')}$`).test(path.split('?')[0] as string);

describe('the control manifest', () => {
  test('every registered /api/control route is in the manifest and every manifest entry is registered', async () => {
    const listed = CONTROL_ROUTES.map((r) => key(r.method, r.path)).sort();
    expect(new Set(listed).size).toBe(listed.length);
    // With every switch on, the app registers exactly the manifest.
    const on = await server({ mcp: true });
    expect(controlKeys(routesOf(on))).toEqual(listed);
    await close?.();
    // With MCP off, exactly the entries that need it are missing.
    const off = await server({ mcp: false });
    expect(controlKeys(routesOf(off))).toEqual(
      CONTROL_ROUTES.filter((r) => r.requires === undefined)
        .map((r) => key(r.method, r.path))
        .sort(),
    );
    expect(CONTROL_ROUTES.filter((r) => r.requires === 'mcp.enabled').length).toBe(3);
  });

  test('every manifest entry with a ctl example parses to its method and path, PUT, PATCH and DELETE included', () => {
    const methods = new Set<string>();
    for (const r of CONTROL_ROUTES) {
      for (const example of [r.ctl, ...(r.also ?? [])]) {
        if (example === null) continue;
        expect(example.startsWith('ctl ')).toBe(true);
        const req = ctlRequest(argvOf(example));
        expect([example, req?.method]).toEqual([example, r.method]);
        expect([example, matches(r.path, req?.path ?? '')]).toEqual([example, true]);
        methods.add(r.method);
      }
    }
    expect([...methods].sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  });

  test('a manifest entry without a ctl verb carries a reason', () => {
    for (const r of CONTROL_ROUTES)
      if (r.ctl === null) expect([r.path, (r.reason ?? '').length > 10]).toEqual([r.path, true]);
      else expect([r.path, r.reason]).toEqual([r.path, undefined]);
    expect(CONTROL_ROUTES.find((r) => r.path === '/api/control/sudo')).toMatchObject({
      ctl: null,
      reason: 'browser re-auth; the token is always sudo',
    });
  });

  test('ctl help lists every verb in the manifest and nothing else', async () => {
    const verbsInManifest = new Set(
      CONTROL_ROUTES.flatMap((r) => [r.ctl, ...(r.also ?? [])])
        .filter((e): e is string => e !== null)
        .map((e) => argvOf(e)[0] as string),
    );
    const help = ctlHelp();
    const verbsInHelp = new Set(
      help
        .split('\n')
        .filter((l) => l.startsWith('  ctl '))
        .map((l) => l.split(' ')[3] as string),
    );
    expect([...verbsInHelp].sort()).toEqual([...verbsInManifest].sort());
    expect(CTL_VERBS.map((v) => v.verb).sort()).toEqual([...verbsInManifest].sort());
    // Grouped by page, in the brief's order.
    const pages = help
      .split('\n')
      .filter((l) => /^[A-Z]/.test(l) && l.endsWith(':'))
      .map((l) => l.slice(0, -1));
    expect(pages).toEqual([
      'Status',
      'Setup',
      'Zones',
      'GitHub',
      'Settings',
      'Credentials',
      'Config',
      'Doctor',
      'Briefings',
      'Kill',
    ]);
    // `ctl help` prints it; `ctl <verb> --help` prints that verb's forms; usage is the same text.
    const out: string[] = [];
    const err: string[] = [];
    const io = [env, fetch, (l: string) => out.push(l), (l: string) => err.push(l)] as const;
    expect(await runCtl(['help'], ...io)).toBe(0);
    expect(out.join('\n')).toBe(help);
    out.length = 0;
    expect(await runCtl(['mcp-tokens', '--help'], ...io)).toBe(0);
    expect(out).toEqual(CTL_VERBS.find((v) => v.verb === 'mcp-tokens')?.forms);
    out.length = 0;
    expect(await runCtl(['config', 'set', '--help'], ...io)).toBe(0);
    expect(out).toEqual(CTL_VERBS.find((v) => v.verb === 'config')?.forms);
    expect(await runCtl(['nope'], ...io)).toBe(2);
    expect(err.join('\n')).toContain('ctl settings set <path>=<json>… [--note <text>]');
    for (const v of CTL_VERBS) for (const f of v.forms) expect(err.join('\n')).toContain(f);
  });
});

describe('carried into Task 14', () => {
  test('ctl against a server that is not there prints one line and exits 1', async () => {
    // A port that was just free: nothing listens on it.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    for (const argv of [['status'], ['config', 'show'], ['secrets', 'list'], ['briefings']]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCtl(
        argv,
        { ...env, JM_SERVER_URL: url },
        fetch,
        (l) => out.push(l),
        (l) => err.push(l),
      );
      expect([argv, code, out, err]).toEqual([argv, 1, [], [`cannot reach ${url}: ECONNREFUSED`]]);
    }
  });

  test('a route missing because its switch is off answers with a sentence naming the switch, not the raw 404', async () => {
    const app = await server({ mcp: false });
    const impl = (async (url: URL | string, init?: RequestInit) => {
      const u = new URL(String(url));
      const r = await app.inject({
        method: (init?.method ?? 'GET') as 'GET',
        url: u.pathname + u.search,
        headers: { ...(init?.headers as Record<string, string>), host: '127.0.0.1:7420' },
        ...(init?.body ? { payload: JSON.parse(String(init.body)) } : {}),
      });
      return new Response(r.body, { status: r.statusCode });
    }) as typeof fetch;
    for (const argv of [
      ['mcp-tokens', 'list'],
      ['mcp-tokens', 'mint', 'web', 'read', '--days', '7'],
      ['mcp-tokens', 'revoke', '3'],
    ]) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCtl(
        argv,
        env,
        impl,
        (l) => out.push(l),
        (l) => err.push(l),
      );
      expect([argv, code, out]).toEqual([argv, 1, []]);
      expect(err).toEqual([SWITCHES['mcp.enabled']]);
    }
    expect(SWITCHES['mcp.enabled']).toBe(
      "Command's MCP server is off: turn on mcp.enabled under Settings, Install (it takes effect at the next restart)",
    );
  });

  test("ctl's zone id rule is the schema's", () => {
    expect(CTL_ZONE_ID).toBe(ZONE_ID);
    for (const id of ['web', 'a-b', 'a'.repeat(63)])
      expect(ctlRequest(['zones', 'add', 'octo/x', '--id', id])).not.toBeNull();
    for (const id of ['-a', 'A', 'a'.repeat(64), 'a_b'])
      expect(ctlRequest(['zones', 'add', 'octo/x', '--id', id])).toBeNull();
  });

  test('every ctl invocation the scripts and runbooks use still parses', () => {
    // From deploy/smoke.sh, images/smoke.sh, the README and the runbooks (placeholders filled in).
    for (const argv of [
      ['briefings'],
      ['doctor'],
      ['doctor', 'main'],
      ['doctor', 'main', '--drop'],
      ['doctor', 'main', '--cancel'],
      ['doctor', '--json'],
      ['pause', 'main'],
      ['resume', 'main'],
      ['observe', 'main'],
      ['kill'],
      ['unkill'],
      ['labels', 'main'],
      ['crew-cycle', 'main'],
      ['rule', '3', 'resume'],
      ['rule', '3', 'yes', '--options', 'abc', 'a', 'note'],
      ['passphrase', 'set'],
      ['setup-code'],
      ['setup', 'reopen'],
      ['status'],
      ['status', '--json'],
      ['detect', 'octo/demo'],
      ['zones', 'add', 'octo/demo'],
      ['zones', 'list'],
      ['zones', 'show', 'main'],
      ['zones', 'remove', 'main'],
      ['zones', 'set', 'main', 'readyLabel=go'],
      ['github', 'main', 'ruleset'],
      ['github', 'main', 'pat', 'author'],
      ['config', 'show'],
      ['config', 'show', '--json'],
      ['config', 'export'],
      ['config', 'adopt'],
      ['config', 'reload'],
      ['config', 'mode', 'file'],
      ['config', 'revisions'],
      ['config', 'rollback', '3'],
      ['config', 'set', 'pollSeconds=30'],
      ['config', 'import', 'next.json', '--dry-run'],
      ['settings', 'set', 'pollSeconds=30'],
      ['secrets', 'list'],
      ['secrets', 'set', 'claudeToken'],
      ['secrets', 'test', 'claudeToken'],
      ['secrets', 'remove', 'claudeToken'],
      ['secrets', 'reload'],
      ['mcp-tokens', 'mint', 'main', 'read', '--days', '30'],
      ['mcp-tokens', 'list'],
      ['mcp-tokens', 'revoke', '3'],
    ])
      expect([argv, ctlRequest(argv) !== null]).toEqual([argv, true]);
  });
});
