import { describe, expect, test } from 'vitest';
import {
  CHAT_PROTOCOL,
  type ChatEvent,
  ChatEventSchema,
  type ChatTurnRequest,
  ChatTurnRequestSchema,
  ChatZoneFetchSchema,
} from './chat.js';
import * as index from './index.js';

const zone = {
  id: 'z1',
  owner: 'acme',
  name: 'app',
  defaultBranch: 'main',
  token: null,
  extraRefs: ['pull/12/head'],
};
const request: ChatTurnRequest = {
  protocol: 1,
  turnId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  resumeSession: null,
  prompt: 'what is open?',
  systemPrompt: 'You are the crew chat.',
  model: 'claude-opus-5-5',
  maxTurns: 20,
  deadlineMs: 600_000,
  claudeToken: 'sk-ant-oat01-x',
  mcp: { url: 'http://jumpmaster:7420/mcp/chat', token: 'jmm_abc' },
  zones: [zone],
};

describe('chat protocol', () => {
  test('CHAT_PROTOCOL is 1 and the index re-exports the chat module', () => {
    expect(CHAT_PROTOCOL).toBe(1);
    expect(index.ChatTurnRequestSchema).toBe(ChatTurnRequestSchema);
    expect(index.ChatEventSchema).toBe(ChatEventSchema);
  });

  test('a well-formed turn request parses', () => {
    expect(ChatTurnRequestSchema.safeParse(request).success).toBe(true);
  });

  test('a turn request with an unknown key, a token not starting jmm_ or an extraRef outside pull/N/head is refused', () => {
    const refused = (v: unknown) => expect(ChatTurnRequestSchema.safeParse(v).success).toBe(false);
    refused({ ...request, extra: 1 });
    refused({ ...request, mcp: { ...request.mcp, extra: 1 } });
    refused({ ...request, zones: [{ ...zone, extra: 1 }] });
    refused({ ...request, mcp: { ...request.mcp, token: 'ghp_abc' } });
    for (const ref of ['refs/heads/main', 'pull/x/head', 'pull/1/merge', 'pull/1/head/../x'])
      refused({ ...request, zones: [{ ...zone, extraRefs: [ref] }] });
    refused({ ...request, zones: [{ ...zone, extraRefs: Array(5).fill('pull/1/head') }] });
    refused({ ...request, protocol: 2 });
    refused({ ...request, turnId: 'not-a-uuid' });
    refused({ ...request, claudeToken: '' });
    refused({ ...request, maxTurns: 101 });
    refused({ ...request, zones: Array(51).fill(zone) });
    expect(ChatZoneFetchSchema.safeParse({ ...zone, token: 'ghs_x' }).success).toBe(true);
  });

  test('every ChatEvent type round-trips through JSON', () => {
    const events: ChatEvent[] = [
      { type: 'session', sessionId: 's1' },
      { type: 'zone', zoneId: 'z1', state: 'fetched' },
      { type: 'zone', zoneId: 'z2', state: 'unavailable', reason: 'no read token' },
      { type: 'text', text: 'hello' },
      { type: 'tool', name: 'Read', summary: 'README.md' },
      { type: 'rate_limit', data: { status: 'allowed', rateLimitType: 'five_hour' } },
      { type: 'result', isError: false, usage: { input_tokens: 3 }, numTurns: 2, sessionId: 's1' },
      { type: 'result', isError: true },
      ...(
        [
          'session_lost',
          'claude_failed',
          'fetch_failed',
          'bad_request',
          'busy',
          'deadline',
        ] as const
      ).map((code) => ({ type: 'error' as const, code, message: code })),
    ];
    const types = new Set(events.map((e) => e.type));
    expect([...types].sort()).toEqual(
      ['error', 'rate_limit', 'result', 'session', 'text', 'tool', 'zone'].sort(),
    );
    for (const e of events)
      expect(ChatEventSchema.parse(JSON.parse(JSON.stringify(e))), e.type).toEqual(e);
    expect(ChatEventSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(ChatEventSchema.safeParse({ type: 'error', code: 'other', message: 'x' }).success).toBe(
      false,
    );
  });
});
