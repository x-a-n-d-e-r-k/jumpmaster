// The per-drop egress proxy: CONNECT only, to listed public hosts, on the allowed ports. It
// resolves names itself, refuses the host if any answer isn't public, and connects only to the
// addresses it checked, in order, never resolving again (no DNS rebinding between check and use).
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { type EgressLogLine, hostAllowed, isPublicAddress, normalizeHost } from './allow.js';

export type Resolved = { address: string; family: number };

export type ProxyOptions = {
  mode: 'monitor' | 'enforce';
  allow: string[];
  /** Ports a CONNECT may name; default `[443]`. */
  ports?: number[];
  /** The only address it listens on (the drop-network address). */
  bind: string;
  port: number;
  log: (line: EgressLogLine) => void;
  /** Test seam: every address for a name. Default `dns.lookup(host, { all: true })`. */
  lookup?: (host: string) => Promise<Resolved[]>;
  /** Test seam: opens a TCP connection to an address the proxy checked. */
  dial?: (address: string, port: number) => Socket;
  limits?: {
    maxTunnels?: number;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
  };
};

export type Proxy = { address: string; port: number; close(): Promise<void> };

/** Header bytes a request may carry; larger is answered 431 by Node's parser. */
export const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULTS = { maxTunnels: 64, connectTimeoutMs: 10_000, idleTimeoutMs: 5 * 60_000 };
/** The longest host a log line keeps: a refused request's target is attacker-chosen. */
const MAX_LOGGED_HOST = 253;

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** Splits an authority-form CONNECT target into a host and a port, or null if it isn't one. */
function parseTarget(target: string): { host: string; port: number } | null {
  const m = /^([^\s:/@[\]]+):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: m[1] as string, port };
}

const defaultLookup = async (host: string): Promise<Resolved[]> =>
  dnsLookup(host, { all: true, order: 'verbatim' });

const defaultDial = (address: string, port: number): Socket => connect({ host: address, port });

/** Connects to the first address that answers within the timeout, trying each in order. */
async function dialFirst(
  addresses: Resolved[],
  port: number,
  dial: (address: string, port: number) => Socket,
  timeoutMs: number,
): Promise<Socket | null> {
  for (const { address } of addresses) {
    const socket = await new Promise<Socket | null>((resolve) => {
      let s: Socket;
      try {
        s = dial(address, port);
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        s.destroy();
        resolve(null);
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', () => {
        clearTimeout(timer);
        s.destroy();
        resolve(null);
      });
    });
    if (socket) return socket;
  }
  return null;
}

export async function startProxy(o: ProxyOptions): Promise<Proxy> {
  const ports = o.ports ?? [443];
  const limits = { ...DEFAULTS, ...o.limits };
  const lookup = o.lookup ?? defaultLookup;
  const dial = o.dial ?? defaultDial;
  let tunnels = 0;
  const open = new Set<Duplex>();

  const logLine = (line: Omit<EgressLogLine, 'at'>) =>
    o.log({ at: new Date().toISOString(), ...line, host: line.host.slice(0, MAX_LOGGED_HOST) });

  const refuse = (socket: Duplex, status: number, host: string, port: number, reason: string) => {
    logLine({ host, port, decision: 'deny', reason });
    if (!socket.destroyed) {
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  };

  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES },
    (req: IncomingMessage, res: ServerResponse) => {
      // Plain HTTP, absolute-URI proxying included: nothing but CONNECT is served.
      logLine({
        host: req.headers.host ?? '',
        port: 0,
        decision: 'deny',
        reason: `method ${req.method}`,
      });
      res.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
      res.end();
    },
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => {});
    open.add(client);
    client.once('close', () => open.delete(client));
    void handleConnect(req, client, head);
  });

  async function handleConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const target = parseTarget(req.url ?? '');
    if (!target) return refuse(client, 400, req.url ?? '', 0, 'bad target');
    const { port } = target;
    if (!ports.includes(port)) return refuse(client, 403, target.host, port, 'port not allowed');
    const host = normalizeHost(target.host);
    if (host === null) return refuse(client, 403, target.host, port, 'invalid host');
    const listed = hostAllowed(host, o.allow);
    // Before any lookup: an unlisted name never reaches DNS, so it can't carry data out.
    if (o.mode === 'enforce' && !listed) return refuse(client, 403, host, port, 'not allowed');
    if (tunnels >= limits.maxTunnels) return refuse(client, 503, host, port, 'too many tunnels');
    tunnels++;
    const started = Date.now();
    let released = false;
    let tunneled = false;
    const release = () => {
      if (!released) {
        released = true;
        tunnels--;
      }
    };
    try {
      let addresses: Resolved[];
      try {
        addresses = await lookup(host);
      } catch {
        addresses = [];
      }
      if (addresses.length === 0) return refuse(client, 502, host, port, 'resolve failed');
      if (!addresses.every((a) => isPublicAddress(a.address)))
        return refuse(client, 403, host, port, 'private address');
      if (client.destroyed) return refuse(client, 502, host, port, 'client gone');
      const upstream = await dialFirst(addresses, port, dial, limits.connectTimeoutMs);
      if (!upstream) return refuse(client, 502, host, port, 'connect failed');
      if (client.destroyed) {
        upstream.destroy();
        return refuse(client, 502, host, port, 'client gone');
      }
      tunneled = true;
      tunnel(client, upstream, head, host, port, listed, started, release);
    } finally {
      // A tunnel releases its slot when it closes; every other path releases it here.
      if (!tunneled) release();
    }
  }

  function tunnel(
    client: Duplex,
    upstream: Socket,
    head: Buffer,
    host: string,
    port: number,
    listed: boolean,
    started: number,
    release: () => void,
  ): void {
    let bytesUp = head.length;
    let bytesDown = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      client.destroy();
      upstream.destroy();
      release();
      logLine({
        host,
        port,
        decision: 'allow',
        ...(listed ? {} : { reason: 'unlisted' }),
        bytesUp,
        bytesDown,
        ms: Date.now() - started,
      });
    };
    upstream.on('error', finish);
    upstream.on('close', finish);
    client.on('error', finish);
    client.on('close', finish);
    const idle = () => finish();
    upstream.setTimeout(limits.idleTimeoutMs, idle);
    (client as Socket).setTimeout?.(limits.idleTimeoutMs, idle);
    upstream.on('data', (c: Buffer) => {
      bytesDown += c.length;
    });
    client.on('data', (c: Buffer) => {
      bytesUp += c.length;
    });
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: o.port, host: o.bind, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('proxy has no address');
  return {
    address: addr.address,
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
