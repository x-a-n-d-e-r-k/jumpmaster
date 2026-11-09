import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect, createServer, type Server, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { EgressLogLine } from '@jumpmaster/protocol/egress';
import { afterEach, describe, expect, test } from 'vitest';
import { configFromEnv } from './config.js';
import { DEFAULT_LIMITS, type Proxy, type ProxyOptions, startProxy } from './proxy.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A TCP echo server on loopback, standing in for the remote TLS endpoint (the tunnel is opaque). */
async function echoServer(): Promise<{ port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    s.on('error', () => {});
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return { port: (server.address() as { port: number }).port, sockets };
}

/** A loopback port with nothing listening. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

type World = {
  proxy: Proxy;
  logs: EgressLogLine[];
  lookups: string[];
  dialed: string[];
};

/**
 * A proxy on loopback whose resolver answers from `answers` and whose dialler maps the public
 * addresses it is handed to loopback ports, so the real address check runs on public addresses.
 */
async function world(
  o: Partial<ProxyOptions> & {
    answers?: Record<string, string[]>;
    routes?: Record<string, number>;
  },
): Promise<World> {
  const logs: EgressLogLine[] = [];
  const lookups: string[] = [];
  const dialed: string[] = [];
  const answers = o.answers ?? {};
  const routes = o.routes ?? {};
  const proxy = await startProxy({
    mode: o.mode ?? 'enforce',
    allow: o.allow ?? ['allowed.test', '*.wild.test'],
    bind: '127.0.0.1',
    port: 0,
    log: (l) => logs.push(l),
    lookup: async (host) => {
      lookups.push(host);
      const list = answers[host];
      if (!list)
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    dial:
      o.dial ??
      ((address, _port) => {
        dialed.push(address);
        const to = routes[address];
        if (to === undefined) throw new Error(`test dialler has no route for ${address}`);
        return connect(to, '127.0.0.1');
      }),
    ...(o.ports ? { ports: o.ports } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
  });
  cleanups.push(() => proxy.close());
  return { proxy, logs, lookups, dialed };
}

/** Sends raw request bytes and resolves with the status code and the open socket. */
function request(
  port: number,
  raw: string,
): Promise<{ status: number; socket: Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    cleanups.push(() => void socket.destroy());
    let buf = '';
    const onData = (c: Buffer) => {
      buf += c.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0);
      const rest = buf.slice(end + 4);
      if (rest) socket.unshift(Buffer.from(rest, 'latin1'));
      resolve({ status, socket, head: buf.slice(0, end) });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: 0, socket, head: buf }));
    socket.write(raw);
  });
}

const connectTo = (port: number, target: string) =>
  request(port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

function readSome(socket: Socket): Promise<string> {
  return new Promise((resolve) => socket.once('data', (c: Buffer) => resolve(c.toString())));
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe('tunnels', () => {
  test('CONNECT to an allowed host on 443 tunnels bytes both ways', async () => {
    const echo = await echoServer();
    const w = await world({
      answers: { 'allowed.test': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
    });
    const { status, socket, head } = await connectTo(w.proxy.port, 'Allowed.Test.:443');
    expect(status).toBe(200);
    expect(head).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    socket.write('ping');
    expect(await readSome(socket)).toBe('ping');
    socket.end();
    await until(() => w.logs.length > 0);
    expect(w.logs).toEqual([
      expect.objectContaining({
        host: 'allowed.test',
        port: 443,
        decision: 'allow',
        bytesUp: 4,
        bytesDown: 4,
      }),
    ]);
    expect(w.logs[0]?.reason).toBeUndefined();
    expect(typeof w.logs[0]?.ms).toBe('number');
    expect(Date.parse(w.logs[0]?.at ?? '')).not.toBeNaN();
  });

  test('when the first checked address refuses, the second is tried; no re-resolution happens', async () => {
    const echo = await echoServer();
    const dead = await closedPort();
    const w = await world({
      answers: { 'allowed.test': ['1.1.1.1', '2606:4700:4700::1111', '8.8.8.8'] },
      routes: { '1.1.1.1': dead, '2606:4700:4700::1111': dead, '8.8.8.8': echo.port },
    });
    const { status, socket } = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(status).toBe(200);
    socket.write('x');
    expect(await readSome(socket)).toBe('x');
    // IPv4 first (the exit network is IPv4), in answer order within each family.
    expect(w.dialed).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(w.lookups).toEqual(['allowed.test']);
  });

  test('IPv4 answers are dialled before IPv6 ones, so an unroutable AAAA costs nothing', async () => {
    const echo = await echoServer();
    const dead = await closedPort();
    const w = await world({
      answers: { 'allowed.test': ['2606:4700:4700::1111', '2001:4860:4860::8888', '8.8.8.8'] },
      routes: { '8.8.8.8': echo.port, '2606:4700:4700::1111': dead, '2001:4860:4860::8888': dead },
    });
    expect((await connectTo(w.proxy.port, 'allowed.test:443')).status).toBe(200);
    expect(w.dialed).toEqual(['8.8.8.8']);
    // IPv6 is still tried when IPv4 fails.
    const v6only = await world({
      answers: { 'allowed.test': ['2606:4700:4700::1111', '1.1.1.1'] },
      routes: { '1.1.1.1': dead, '2606:4700:4700::1111': echo.port },
    });
    expect((await connectTo(v6only.proxy.port, 'allowed.test:443')).status).toBe(200);
    expect(v6only.dialed).toEqual(['1.1.1.1', '2606:4700:4700::1111']);
  });

  test('an address that hangs times out and the next is tried', async () => {
    const echo = await echoServer();
    const dialed: string[] = [];
    const w = await world({
      answers: { 'allowed.test': ['1.1.1.1', '8.8.8.8'] },
      limits: { connectTimeoutMs: 50 },
      dial: (address) => {
        dialed.push(address);
        // An unconnected socket never connects: the per-address timeout must move on.
        return address === '1.1.1.1' ? new Socket() : connect(echo.port, '127.0.0.1');
      },
    });
    const { status } = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(status).toBe(200);
    expect(dialed).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  test('when no checked address connects the answer is 502', async () => {
    const dead = await closedPort();
    const w = await world({
      answers: { 'allowed.test': ['1.1.1.1', '8.8.8.8'] },
      routes: { '1.1.1.1': dead, '8.8.8.8': dead },
    });
    expect((await connectTo(w.proxy.port, 'allowed.test:443')).status).toBe(502);
    expect((await connectTo(w.proxy.port, 'gone.wild.test:443')).status).toBe(502); // NXDOMAIN
    await until(() => w.logs.length === 2);
    expect(w.logs.map((l) => [l.decision, l.reason])).toEqual([
      ['deny', 'connect failed'],
      ['deny', 'resolve failed'],
    ]);
  });

  test('an idle tunnel is closed', async () => {
    const echo = await echoServer();
    const w = await world({
      answers: { 'allowed.test': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
      limits: { idleTimeoutMs: 100 },
    });
    const { status, socket } = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(status).toBe(200);
    await new Promise<void>((r) => socket.once('close', () => r()));
    await until(() => w.logs.length === 1);
    expect(w.logs[0]?.decision).toBe('allow');
  });
});

describe('the allow-list', () => {
  test('CONNECT to an unlisted host is 403 in enforce and allowed in monitor', async () => {
    const echo = await echoServer();
    const answers = { 'unlisted.test': ['8.8.8.8'], 'wild.test': ['8.8.8.8'] };
    const routes = { '8.8.8.8': echo.port };
    const enforce = await world({ answers, routes });
    expect((await connectTo(enforce.proxy.port, 'unlisted.test:443')).status).toBe(403);
    // The apex of a wildcard entry is not listed.
    expect((await connectTo(enforce.proxy.port, 'wild.test:443')).status).toBe(403);
    // Refused before any lookup: an unlisted name never reaches DNS, so it can't carry data out.
    expect(enforce.lookups).toEqual([]);
    expect(enforce.dialed).toEqual([]);
    expect(enforce.logs.map((l) => [l.host, l.decision, l.reason])).toEqual([
      ['unlisted.test', 'deny', 'not allowed'],
      ['wild.test', 'deny', 'not allowed'],
    ]);

    const monitor = await world({ mode: 'monitor', answers, routes });
    const { status, socket } = await connectTo(monitor.proxy.port, 'unlisted.test:443');
    expect(status).toBe(200);
    socket.end();
    await until(() => monitor.logs.length === 1);
    expect(monitor.logs[0]).toMatchObject({
      host: 'unlisted.test',
      decision: 'allow',
      reason: 'unlisted',
    });
  });

  test('any private address in the answer refuses the host even when listed', async () => {
    const echo = await echoServer();
    for (const mode of ['enforce', 'monitor'] as const) {
      const w = await world({
        mode,
        answers: {
          'allowed.test': ['8.8.8.8', '10.0.0.5'],
          'a.wild.test': ['::ffff:169.254.169.254'],
        },
        routes: { '8.8.8.8': echo.port },
      });
      expect((await connectTo(w.proxy.port, 'allowed.test:443')).status).toBe(403);
      expect((await connectTo(w.proxy.port, 'a.wild.test:443')).status).toBe(403);
      expect(w.dialed).toEqual([]);
      expect(w.logs.map((l) => l.reason)).toEqual(['private address', 'private address']);
    }
  });
});

describe('request shapes', () => {
  test('GET and absolute-URI requests are 405; CONNECT to port 22 is 403', async () => {
    const w = await world({ answers: { 'allowed.test': ['8.8.8.8'] } });
    const port = w.proxy.port;
    expect((await request(port, 'GET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n')).status).toBe(405);
    expect(
      (await request(port, 'GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n'))
        .status,
    ).toBe(405);
    expect(
      (await request(port, 'POST http://allowed.test:443/ HTTP/1.1\r\nHost: x\r\n\r\n')).status,
    ).toBe(405);
    expect((await connectTo(port, 'allowed.test:22')).status).toBe(403);
    expect((await connectTo(port, 'allowed.test:80')).status).toBe(403);
    expect(w.lookups).toEqual([]);
  });

  test('a configured port list replaces 443', async () => {
    const echo = await echoServer();
    const w = await world({
      ports: [443, 8443],
      answers: { 'allowed.test': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
    });
    expect((await connectTo(w.proxy.port, 'allowed.test:8443')).status).toBe(200);
    expect((await connectTo(w.proxy.port, 'allowed.test:22')).status).toBe(403);
  });

  test('CONNECT host:443@evil.example and a header over 8 KB are refused', async () => {
    const echo = await echoServer();
    const w = await world({
      answers: { 'allowed.test': ['8.8.8.8'], 'evil.example': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
      allow: ['allowed.test', 'evil.example'],
    });
    const port = w.proxy.port;
    for (const target of [
      'allowed.test:443@evil.example',
      'allowed.test:443@evil.example:443',
      'user@allowed.test:443',
      'allowed.test:443/x',
      'allowed.test',
      'allowed.test:',
      'allowed.test:0443x',
      'allowed.test:99999',
      'allowed.test :443',
      'http://allowed.test:443',
      '127.0.0.1:443',
      '169.254.169.254:443',
      '[::1]:443',
      '[2606:4700:4700::1111]:443',
      '2130706433:443',
      'xn--bcher-kva.example%00.allowed.test:443',
    ]) {
      const { status } = await connectTo(port, target);
      expect([400, 403], target).toContain(status);
    }
    expect(w.lookups).toEqual([]);
    expect(w.dialed).toEqual([]);
    const big = `CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\n`;
    expect((await request(port, big)).status).toBe(431);
    expect(w.dialed).toEqual([]);
  });
});

describe('binding and limits', () => {
  test('the proxy accepts nothing on an address other than JM_EGRESS_BIND', async () => {
    const w = await world({});
    const other = await new Promise<string>((resolve) => {
      const s = connect({ port: w.proxy.port, host: '::1' });
      s.on('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(other).not.toBe('connected');
    expect(['ECONNREFUSED', 'EADDRNOTAVAIL', 'ENETUNREACH']).toContain(other);
    expect(w.proxy.address).toBe('127.0.0.1');
  });

  test('each tunnel logs one line; the 65th concurrent tunnel is refused', async () => {
    expect(DEFAULT_LIMITS.maxTunnels).toBe(128);
    const echo = await echoServer();
    const w = await world({
      answers: { 'allowed.test': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
      limits: { maxTunnels: 64 },
    });
    const open: Socket[] = [];
    for (let i = 0; i < 64; i++) {
      const { status, socket } = await connectTo(w.proxy.port, 'allowed.test:443');
      expect(status).toBe(200);
      open.push(socket);
    }
    const extra = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(extra.status).toBe(503);
    expect(w.lookups).toHaveLength(64);
    for (const s of open) s.end();
    await until(() => w.logs.length === 65);
    expect(w.logs.filter((l) => l.decision === 'allow')).toHaveLength(64);
    expect(w.logs.filter((l) => l.reason === 'too many tunnels')).toHaveLength(1);
    // A slot frees once a tunnel ends.
    const again = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(again.status).toBe(200);
  }, 20_000);
});

describe('main', () => {
  test('main refuses to start without JM_EGRESS_BIND', () => {
    const base = { JM_EGRESS_MODE: 'enforce', JM_EGRESS_ALLOW: 'github.com,*.npmjs.org' };
    expect(() => configFromEnv(base)).toThrow(/JM_EGRESS_BIND is required/);
    for (const wildcard of ['0.0.0.0', '::', '0', 'jm-egress', '172.30.0.2:3128'])
      expect(() => configFromEnv({ ...base, JM_EGRESS_BIND: wildcard }), wildcard).toThrow(
        /JM_EGRESS_BIND/,
      );
    expect(configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2' })).toEqual({
      mode: 'enforce',
      allow: ['github.com', '*.npmjs.org'],
      ports: [443],
      bind: '172.30.0.2',
      port: 3128,
      limits: {},
    });
    expect(() =>
      configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2', JM_EGRESS_MODE: 'off' }),
    ).toThrow(/JM_EGRESS_MODE/);
    expect(() =>
      configFromEnv({
        ...base,
        JM_EGRESS_BIND: '172.30.0.2',
        JM_EGRESS_ALLOW: 'github.com,1.2.3.4',
      }),
    ).toThrow(/1\.2\.3\.4/);
    expect(
      configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2', JM_EGRESS_PORTS: '443, 8443' }).ports,
    ).toEqual([443, 8443]);
    expect(() =>
      configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2', JM_EGRESS_PORTS: '443,0' }),
    ).toThrow(/JM_EGRESS_PORTS/);
    const limits = configFromEnv({
      ...base,
      JM_EGRESS_BIND: '172.30.0.2',
      JM_EGRESS_MAX_TUNNELS: '256',
      JM_EGRESS_MAX_CONNECTIONS: '512',
    });
    expect(limits.limits).toEqual({ maxTunnels: 256, maxConnections: 512 });
    expect(configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2' }).limits).toEqual({});
    for (const bad of ['0', '-1', 'x', '100000'])
      expect(() =>
        configFromEnv({ ...base, JM_EGRESS_BIND: '172.30.0.2', JM_EGRESS_MAX_TUNNELS: bad }),
      ).toThrow(/JM_EGRESS_MAX_TUNNELS/);
  });

  test('the built entry exits non-zero naming JM_EGRESS_BIND, and prints no ready line', () => {
    // Needs `npx tsc -b` (CI's typecheck step), like the stick's entry-point test.
    const dist = fileURLToPath(new URL('../dist/main.js', import.meta.url));
    expect(existsSync(dist), 'build first: npx tsc -b').toBe(true);
    const env = {
      PATH: process.env.PATH ?? '',
      JM_EGRESS_MODE: 'enforce',
      JM_EGRESS_ALLOW: 'a.test',
    };
    const child = spawnSync(process.execPath, [dist], { encoding: 'utf8', env, timeout: 10_000 });
    expect(child.stderr).toContain('JM_EGRESS_BIND is required');
    expect(child.stdout).not.toContain('ready');
    expect(child.status).toBe(1);
  });
});

describe('connection load', () => {
  const rawSocket = (port: number) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
      cleanups.push(() => void s.destroy());
    });
  const closed = (s: Socket, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (s.destroyed) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      s.once('close', () => {
        clearTimeout(t);
        resolve(true);
      });
    });

  test('connections beyond the cap are refused and logged, sockets before CONNECT included', async () => {
    expect(DEFAULT_LIMITS.maxConnections).toBe(256);
    const w = await world({ limits: { maxConnections: 5 } });
    const idle: Socket[] = [];
    for (let i = 0; i < 5; i++) idle.push(await rawSocket(w.proxy.port));
    const extra = await rawSocket(w.proxy.port);
    expect(await closed(extra, 2000)).toBe(true);
    for (const s of idle) expect(s.destroyed).toBe(false);
    await until(() => w.logs.some((l) => l.reason === 'too many connections'));
    expect(w.logs.filter((l) => l.reason === 'too many connections')).toHaveLength(1);
  });

  test('a client that never finishes its headers is cut after the header timeout', async () => {
    const w = await world({ limits: { headersTimeoutMs: 200 } });
    const s = await rawSocket(w.proxy.port);
    s.write('CONNECT allowed.test:4');
    expect(await closed(s, 3000)).toBe(true);
  });

  test('an idle socket that never sends anything is cut', async () => {
    const w = await world({ limits: { headersTimeoutMs: 200 } });
    const s = await rawSocket(w.proxy.port);
    expect(await closed(s, 3000)).toBe(true);
  });

  test('close returns at once with idle sockets open, and logs every open tunnel', async () => {
    const echo = await echoServer();
    const w = await world({
      answers: { 'allowed.test': ['8.8.8.8'] },
      routes: { '8.8.8.8': echo.port },
    });
    const { status, socket } = await connectTo(w.proxy.port, 'allowed.test:443');
    expect(status).toBe(200);
    socket.write('x');
    await readSome(socket);
    for (let i = 0; i < 3; i++) await rawSocket(w.proxy.port);
    const slow = await rawSocket(w.proxy.port);
    slow.write('CONNECT allowed');
    const started = Date.now();
    await w.proxy.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(w.logs.filter((l) => l.decision === 'allow')).toEqual([
      expect.objectContaining({ host: 'allowed.test', bytesUp: 1, bytesDown: 1 }),
    ]);
  });
});
