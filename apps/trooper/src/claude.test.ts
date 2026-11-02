import { IMPLEMENT_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from '@jumpmaster/protocol';
import { expect, test } from 'vitest';
import { buildClaudeArgs, parseStreamLine } from './claude.js';

test('builds headless args with isolated settings', () => {
  const a = buildClaudeArgs({
    prompt: 'P',
    model: 'claude-opus-5-5',
    maxTurns: 200,
    systemPromptFile: '/p.md',
    settingsFile: '/s.json',
    outputSchema: IMPLEMENT_OUTPUT_SCHEMA,
  });
  expect(a.slice(0, 2)).toEqual(['-p', 'P']);
  for (const f of [
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'claude-opus-5-5',
    '--max-turns',
    '200',
    '--append-system-prompt-file',
    '/p.md',
    '--settings',
    '/s.json',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'bypassPermissions',
    '--json-schema',
  ])
    expect(a).toContain(f);
});
test('parses a rejected rate limit event', () => {
  expect(
    parseStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1792400000 },
      }),
    ),
  ).toMatchObject({
    type: 'rate_limit',
    status: 'rejected',
    resetsAt: new Date(1792400000 * 1000).toISOString(),
  });
});
test('parses a result message', () => {
  expect(
    parseStreamLine(
      JSON.stringify({
        type: 'result',
        is_error: false,
        structured_output: { status: 'COMPLETE', summary: 's' },
        num_turns: 3,
        terminal_reason: 'completed',
      }),
    ),
  ).toEqual({
    type: 'result',
    isError: false,
    structured: { status: 'COMPLETE', summary: 's' },
    usage: undefined,
    modelUsage: undefined,
    numTurns: 3,
    terminalReason: 'completed',
  });
});
test('other JSON objects are agent lines', () => {
  expect(parseStreamLine('{"type":"assistant"}')).toEqual({
    type: 'agent',
    raw: { type: 'assistant' },
  });
});
test('non-JSON and blank lines are ignored', () => {
  expect(parseStreamLine('hello')).toEqual({ type: 'ignored' });
  expect(parseStreamLine('  ')).toEqual({ type: 'ignored' });
});

test('ignores an invalid resetsAt', () => {
  const r = parseStreamLine(
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 1e20 },
    }),
  );
  expect(r).toMatchObject({ type: 'rate_limit', status: 'rejected' });
  expect(r).not.toHaveProperty('resetsAt');
});

test('buildClaudeArgs uses the given output schema', () => {
  const a = buildClaudeArgs({
    prompt: 'P',
    model: 'm',
    maxTurns: 1,
    systemPromptFile: '/p.md',
    settingsFile: '/s.json',
    outputSchema: REVIEW_OUTPUT_SCHEMA,
  });
  expect(a[a.indexOf('--json-schema') + 1]).toBe(JSON.stringify(REVIEW_OUTPUT_SCHEMA));
});

const rlLine = (windows: Record<string, Record<string, unknown>>) =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      resetsAt: 1767225600,
      rateLimitType: 'five_hour',
      unifiedWindows: windows,
    },
  });

test('rate_limit parsing keeps rateLimitType and unifiedWindows in ISO', () =>
  expect(
    parseStreamLine(rlLine({ seven_day: { utilization: 0.5, resets_at: 1767225600 } })),
  ).toMatchObject({
    type: 'rate_limit',
    rateLimitType: 'five_hour',
    unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: '2026-01-01T00:00:00.000Z' } },
  }));

test('camelCase window resetsAt (as the CLI sends it) is normalized too', () =>
  expect(
    parseStreamLine(rlLine({ five_hour: { utilization: 0.02, resetsAt: 1767225600 } })),
  ).toMatchObject({
    unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: '2026-01-01T00:00:00.000Z' } },
  }));

test('system/init yields the session id', () =>
  expect(
    parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' })),
  ).toEqual({
    type: 'init',
    sessionId: 's-1',
  }));

test('a result carries its session id', () =>
  expect(
    parseStreamLine(JSON.stringify({ type: 'result', is_error: false, session_id: 's-1' })),
  ).toMatchObject({
    type: 'result',
    sessionId: 's-1',
  }));
