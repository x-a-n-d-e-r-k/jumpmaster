import { describe, expect, test } from 'vitest';
import {
  agentBranch,
  DropPayloadSchema,
  DropResultSchema,
  RateLimitEventDataSchema,
  REVIEW_OUTPUT_SCHEMA,
  IMPLEMENT_OUTPUT_SCHEMA,
  VerdictSchema,
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
  image: 'jumpmaster-trooper:test',
  protectedPaths: [] as string[],
  credentials: { claudeToken: 'c', forgeToken: 'f' },
};
const base = validPayload;
const reviewPayload = { ...base, role: 'review', pr: { number: 3, branch: 'agent/issue-7', headSha: 'abc' } };

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
  test('review payload requires pr', () => expect(() => DropPayloadSchema.parse({ ...base, role: 'review' })).toThrow());
  test('heal payload requires feedback', () => expect(() => DropPayloadSchema.parse({ ...reviewPayload, role: 'heal' })).toThrow());
  test('resolve payload parses with pr', () => expect(DropPayloadSchema.parse({ ...reviewPayload, role: 'resolve' }).role).toBe('resolve'));
  test('implement payload defaults resume to false', () => {
    const p = DropPayloadSchema.parse({ ...base, role: 'implement' });
    if (p.role !== 'implement') throw new Error('role');
    expect(p.resume).toBe(false);
    expect(p.resumeSha).toBeUndefined();
  });
  test('payload requires protectedPaths', () => {
    const { protectedPaths: _p, ...rest } = base;
    expect(() => DropPayloadSchema.parse(rest)).toThrow();
  });
  test('forgeToken is optional', () =>
    expect(DropPayloadSchema.parse({ ...reviewPayload, credentials: { claudeToken: 't' } }).credentials.forgeToken).toBeUndefined());
  test('verdict decision is validated', () =>
    expect(() => VerdictSchema.parse({ decision: 'lgtm', summary: '', findings: [] })).toThrow());
  test('role is optional on results', () => expect(DropResultSchema.parse({ status: 'failed', gates: [] }).role).toBeUndefined());
  test('rate_limited and interrupted are valid statuses', () => {
    for (const status of ['rate_limited', 'interrupted'])
      expect(DropResultSchema.parse({ status, gates: [] }).status).toBe(status);
  });
  test('rate limit event data keeps windows', () =>
    expect(RateLimitEventDataSchema.parse({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5 } } }).unifiedWindows?.seven_day?.utilization).toBe(0.5));
  test('rate_limited result carries its rate limit', () =>
    expect(DropResultSchema.parse({ status: 'rate_limited', gates: [], rateLimit: { status: 'rejected' } }).rateLimit?.status).toBe('rejected'));
  test('a REVIEW_OUTPUT_SCHEMA-shaped sample parses as a Verdict', () => {
    expect(REVIEW_OUTPUT_SCHEMA.required).toContain('decision');
    expect(IMPLEMENT_OUTPUT_SCHEMA.type).toBe('object');
    expect(VerdictSchema.parse({ decision: 'approve', summary: 's', findings: [{ severity: 'minor', file: 'a.ts', detail: 'd' }] }).findings).toHaveLength(1);
  });
});
