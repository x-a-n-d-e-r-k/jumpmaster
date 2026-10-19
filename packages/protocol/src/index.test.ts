import { describe, expect, test } from 'vitest';
import {
  agentBranch,
  DropPayloadSchema,
  DropResultSchema,
  EVENT_PREFIX,
  RESULT_PREFIX,
} from './index.js';

const validPayload = {
  protocol: 1,
  dropId: 'drop-1',
  epoch: 1,
  role: 'implement',
  repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main' },
  issue: { number: 7, title: 'Add widget', body: 'Please add a widget.' },
  branch: 'agent/issue-7',
  gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
  model: 'claude-opus-5-5',
  maxTurns: 200,
  promptVersion: 'v1',
  prompt: 'Implement the issue.',
  credentials: { claudeToken: 'c', forgeToken: 'f' },
};

describe('protocol', () => {
  test('defaults gate timeout to 20 minutes', () => {
    const p = DropPayloadSchema.parse({
      ...validPayload,
      gates: [{ name: 'test', run: 'npm test' }],
    });
    expect(p.gates[0]?.timeoutMinutes).toBe(20);
  });
  test('rejects unknown result status', () => {
    expect(() => DropResultSchema.parse({ status: 'merged', gates: [] })).toThrow();
  });
  test('prefixes', () => {
    expect(EVENT_PREFIX).toBe('JM_EVENT ');
    expect(RESULT_PREFIX).toBe('JM_RESULT ');
  });
  test('agent branch name', () => expect(agentBranch(7)).toBe('agent/issue-7'));
});
