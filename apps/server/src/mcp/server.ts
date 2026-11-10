import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type JSONRPCMessage,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { originAllowed } from '../api/control.js';
import { configReader, type LiveConfig } from '../config/source.js';
import { allowedHostsOf, type Config, type DropZoneConfig, mcpConfigOf } from '../config.js';
import type { Db } from '../db/open.js';
import { auditMcp, auditRefusedAuth, checkMcpToken, type McpPrincipal } from './tokens.js';
import { callBudgetSpent, callTool, errorMessage, listTools } from './tools.js';

export interface McpDeps {
  db: Db;
  /** Read per request: a zone added or removed live is seen by the next call. */
  config: LiveConfig;
  now(): Date;
  /** The operator's scrubbed log: the caller sees a generic error, the operator the cause. */
  log?: (msg: string) => void;
}

/** The request's config, read once when it is authenticated, with the token's zone in it. */
type Caller = { principal: McpPrincipal; zone: DropZoneConfig; config: Config };

const bearer = (req: FastifyRequest): string | undefined => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice('Bearer '.length) : undefined;
};

const GENERIC: Record<number, string> = {
  [-32700]: 'parse error',
  [-32600]: 'invalid request',
  [-32601]: 'method not found',
  [-32602]: 'invalid params',
  [-32603]: 'internal error',
};

function withGenericError(message: JSONRPCMessage): JSONRPCMessage {
  if (!('error' in message)) return message;
  const { code } = message.error;
  return { ...message, error: { code, message: GENERIC[code] ?? 'error' } };
}

const rpcError = (code: number, message: string) =>
  JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } });

/**
 * The MCP server for Command's own Claude Code, at `POST /mcp`: stateless streamable HTTP with
 * JSON responses, one SDK server per request bound to its token's zone and scope. Registered only
 * with `mcp.enabled` (read at start), so with it off `/mcp` is Fastify's 404. The body limit is
 * the route's, also read at start; the zones and every other setting are read per request.
 *
 * Order: Host (the app's hook) → Origin → bearer, both before the body is parsed → Content-Type
 * (415) and body limit (413) → batch refusal (400) → the SDK (Accept, 406) → the tool, which audits.
 */
export function registerMcpRoute(app: FastifyInstance, deps: McpDeps): void {
  const { db, now } = deps;
  const live = configReader(deps.config);
  const atStart = live();
  const mcp = mcpConfigOf(atStart);
  if (!mcp.enabled) return;
  // Boot settings: they change only with a restart.
  const allowed = allowedHostsOf(atStart);
  const callers = new WeakMap<FastifyRequest, Caller>();

  void app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'POST') return;
      if (!originAllowed(req.headers.origin, allowed)) {
        return reply.code(403).send({ error: 'forbidden origin' });
      }
      const at = now();
      const c = checkMcpToken(db, bearer(req), at);
      if (!c.ok) {
        auditRefusedAuth(db, c.reason, c.tokenId, at);
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
      }
      const config = live();
      const zone = config.dropZones.find((z) => z.id === c.principal.zoneId);
      if (!zone) {
        auditRefusedAuth(db, 'zone not configured', c.principal.tokenId, at);
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'unauthorized' });
      }
      callers.set(req, { principal: c.principal, zone, config });
    });

    scope.post('/mcp', { bodyLimit: mcp.maxBodyBytes }, async (req, reply) => {
      const caller = callers.get(req);
      if (!caller) return reply.code(401).send({ error: 'unauthorized' });
      const { principal, zone, config } = caller;
      // The MCP revision of 2025-06-18 removed batching; one request would otherwise carry
      // hundreds of tool calls past the write budget's check.
      if (Array.isArray(req.body)) {
        const at = now();
        // Counted against the call budget, and past it not audited again.
        if (!callBudgetSpent(db, config, principal.tokenId, at)) {
          auditMcp(
            db,
            {
              tokenId: principal.tokenId,
              zoneId: principal.zoneId,
              tool: 'batch',
              outcome: 'refused',
              detail: 'batch',
            },
            at,
          );
        }
        return reply
          .code(400)
          .type('application/json')
          .send(rpcError(-32600, 'JSON-RPC batches are not accepted'));
      }

      const server = new Server(
        { name: 'jumpmaster', version: '0.0.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: listTools(principal.scope),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) =>
        callTool(
          { db, config, zone, principal, now, ...(deps.log ? { log: deps.log } : {}) },
          request.params.name,
          request.params.arguments ?? {},
        ),
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      // Every JSON-RPC error leaves with a fixed message for its code: the SDK would otherwise send
      // an exception's or a validator's text (`error.message`) as is.
      const send = transport.send.bind(transport);
      transport.send = (message, options) => send(withGenericError(message), options);
      // After hijack Fastify's error handling no longer applies: this path answers for itself.
      reply.hijack();
      const res = reply.raw;
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, res, req.body);
      } catch (e) {
        deps.log?.(`mcp request failed: ${errorMessage(e)}`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(rpcError(-32603, 'internal error'));
      }
    });

    // Stateless: no SSE stream to open and no session to end.
    const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.code(405).header('allow', 'POST').send({ error: 'method not allowed' });
    scope.get('/mcp', notAllowed);
    scope.delete('/mcp', notAllowed);
  });
}
