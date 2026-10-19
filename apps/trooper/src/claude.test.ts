import { expect, test } from 'vitest';
import { buildClaudeArgs, parseStreamLine } from './claude.js';

test('builds headless args with isolated settings', () => {
  const a = buildClaudeArgs({
    prompt: 'P',
    model: 'claude-opus-5-5',
    maxTurns: 200,
    systemPromptFile: '/p.md',
    settingsFile: '/s.json',
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
