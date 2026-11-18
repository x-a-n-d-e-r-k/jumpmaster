// The crew chat's wire format between the server and the `chat` compose service: one turn request
// (POST /turns) and the NDJSON stream of events it answers with, one `ChatEvent` per line.
import { z } from 'zod';
import { RateLimitEventDataSchema } from './usage.js';

export const CHAT_PROTOCOL = 1;

/** A zone the turn reads code from: fetched into the service's mirror before Claude starts. */
export const ChatZoneFetchSchema = z.strictObject({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  defaultBranch: z.string(),
  /** A read-only token for this fetch, or null: the zone then chats without its code. */
  token: z.string().nullable(),
  /** Pull request heads to fetch as well, never any other ref. */
  extraRefs: z.array(z.string().regex(/^pull\/\d+\/head$/)).max(4),
});
export type ChatZoneFetch = z.infer<typeof ChatZoneFetchSchema>;

export const ChatTurnRequestSchema = z.strictObject({
  protocol: z.literal(CHAT_PROTOCOL),
  turnId: z.string().uuid(),
  resumeSession: z.string().nullable(),
  prompt: z.string().max(200_000),
  systemPrompt: z.string().max(50_000),
  model: z.string(),
  maxTurns: z.number().int().min(1).max(100),
  deadlineMs: z.number().int().positive(),
  /** Reaches only the turn's `claude` process environment; never logged or stored. */
  claudeToken: z.string().min(1),
  /** The chat MCP endpoint and the turn's short-lived token for it. */
  mcp: z.strictObject({ url: z.string().url(), token: z.string().startsWith('jmm_') }),
  zones: z.array(ChatZoneFetchSchema).max(50),
});
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

export const CHAT_ERROR_CODES = [
  'session_lost',
  'claude_failed',
  'fetch_failed',
  'bad_request',
  'busy',
  'deadline',
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), sessionId: z.string() }),
  z.object({
    type: z.literal('zone'),
    zoneId: z.string(),
    state: z.enum(['fetched', 'unavailable']),
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool'), name: z.string(), summary: z.string() }),
  z.object({ type: z.literal('rate_limit'), data: RateLimitEventDataSchema }),
  z.object({
    type: z.literal('result'),
    isError: z.boolean(),
    usage: z.record(z.string(), z.unknown()).optional(),
    numTurns: z.number().optional(),
    sessionId: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), code: z.enum(CHAT_ERROR_CODES), message: z.string() }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;
