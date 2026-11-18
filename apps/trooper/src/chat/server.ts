// The `chat` compose service's HTTP face. The server posts one turn to POST /turns and reads the
// answer as NDJSON, one ChatEvent per line; GET /healthz says whether Claude and the forge are
// reachable through the egress proxy. A request body carries the Claude token and the turn's MCP
// token: it is never logged, and an error never echoes it (log lines name the turn id only).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ChatErrorCode,
  type ChatEvent,
  type ChatTurnRequest,
  ChatTurnRequestSchema,
} from '@jumpmaster/protocol';

export const DEFAULT_CHAT_LISTEN = '0.0.0.0:7431';
/** Larger than any valid request (200k + 50k characters of prompts and fifty zones), as UTF-8. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export type ChatHealth = { claude: boolean; forge: boolean };
export type RunTurn = (req: ChatTurnRequest, signal: AbortSignal) => AsyncIterable<ChatEvent>;

/** A HEAD answered with any status means the host is reachable (through HTTPS_PROXY in compose). */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export async function probeHealth(): Promise<ChatHealth> {
  const [claude, forge] = await Promise.all([
    reachable('https://api.anthropic.com/'),
    reachable('https://api.github.com/'),
  ]);
  return { claude, forge };
}

/** `host:port`, an IPv6 host in brackets; port 0 picks a free one. */
export function parseListen(listen: string): { host: string; port: number } {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(listen.trim());
  const port = m ? Number(m[3]) : Number.NaN;
  if (!m || port > 65_535) throw new Error(`JM_CHAT_LISTEN must be host:port, not ${listen}`);
  return { host: (m[1] ?? m[2]) as string, port };
}

const log = (line: string) => process.stderr.write(`[chat] ${line}\n`);

const NDJSON = 'application/x-ndjson; charset=utf-8';
const line = (e: ChatEvent) => `${JSON.stringify(e)}\n`;

function answerOne(res: ServerResponse, status: number, code: ChatErrorCode, message: string) {
  res.writeHead(status, { 'content-type': NDJSON });
  res.end(line({ type: 'error', code, message }));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function parseTurn(body: string | null): ChatTurnRequest | null {
  if (body === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const r = ChatTurnRequestSchema.safeParse(json);
  return r.success ? r.data : null;
}

export async function startChatServer(o: {
  listen: string;
  runTurn: RunTurn;
  /** The reachability probes (default: a HEAD to the Anthropic API and the forge). */
  health?: () => Promise<ChatHealth>;
}): Promise<{ close(): Promise<void>; port: number }> {
  const { host, port } = parseListen(o.listen);
  const health = o.health ?? probeHealth;
  const running = new Set<string>();

  const turn = async (req: IncomingMessage, res: ServerResponse) => {
    // A message for a bad body is fixed text: zod's issues may quote the values sent.
    const parsed = parseTurn(await readBody(req).catch(() => null));
    if (!parsed) return answerOne(res, 400, 'bad_request', 'the turn request is not valid');
    if (running.has(parsed.turnId))
      return answerOne(res, 409, 'busy', 'this turn is already running');
    running.add(parsed.turnId);
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    log(`turn ${parsed.turnId} started`);
    let outcome = 'ended';
    try {
      res.writeHead(200, { 'content-type': NDJSON, 'cache-control': 'no-store' });
      res.flushHeaders();
      for await (const event of o.runTurn(parsed, ac.signal)) {
        if (ac.signal.aborted) break;
        res.write(line(event));
      }
      if (ac.signal.aborted) outcome = 'aborted';
    } catch {
      // The error's text may carry anything the runner saw: neither logged nor sent.
      outcome = 'failed';
      if (!ac.signal.aborted)
        res.write(line({ type: 'error', code: 'claude_failed', message: 'the turn failed' }));
    } finally {
      running.delete(parsed.turnId);
      res.off('close', onClose);
      res.end();
      log(`turn ${parsed.turnId} ${outcome}`);
    }
  };

  const healthz = async (_req: IncomingMessage, res: ServerResponse) => {
    const h = await health().catch(() => ({ claude: false, forge: false }));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: h.claude && h.forge, claude: h.claude, forge: h.forge }));
  };
  const routes = new Map<string, { method: string; handle: typeof turn }>([
    ['/turns', { method: 'POST', handle: turn }],
    ['/healthz', { method: 'GET', handle: healthz }],
  ]);

  const server = createServer((req, res) => {
    const route = routes.get((req.url ?? '/').split('?')[0] as string);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== route.method) {
      res.writeHead(405, { allow: route.method }).end();
      return;
    }
    route.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
