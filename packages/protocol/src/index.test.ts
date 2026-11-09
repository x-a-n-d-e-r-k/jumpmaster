import { describe, expect, test } from 'vitest';
import {
  agentBranch,
  CREW_ROLES,
  crewOutputJsonSchema,
  DropPayloadSchema,
  DropResultSchema,
  EVENT_PREFIX,
  IMPLEMENT_OUTPUT_SCHEMA,
  isCrewRole,
  parseCrewOutput,
  RateLimitEventDataSchema,
  RESULT_PREFIX,
  REVIEW_OUTPUT_SCHEMA,
  RoleSchema,
  VerdictSchema,
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
const reviewPayload = {
  ...base,
  role: 'review',
  pr: { number: 3, branch: 'agent/issue-7', headSha: 'abc' },
};

describe('protocol', () => {
  test('defaults gate timeout to 20 minutes', () => {
    const p = DropPayloadSchema.parse({
      ...validPayload,
      gates: [{ name: 'test', run: 'npm test' }],
    });
    if (p.role !== 'implement') throw new Error(`unexpected role ${p.role}`);
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
  test('review payload requires pr', () =>
    expect(() => DropPayloadSchema.parse({ ...base, role: 'review' })).toThrow());
  test('heal payload requires feedback', () =>
    expect(() => DropPayloadSchema.parse({ ...reviewPayload, role: 'heal' })).toThrow());
  test('resolve payload parses with pr', () =>
    expect(DropPayloadSchema.parse({ ...reviewPayload, role: 'resolve' }).role).toBe('resolve'));
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
    expect(
      DropPayloadSchema.parse({ ...reviewPayload, credentials: { claudeToken: 't' } }).credentials
        .forgeToken,
    ).toBeUndefined());
  test('verdict decision is validated', () =>
    expect(() => VerdictSchema.parse({ decision: 'lgtm', summary: '', findings: [] })).toThrow());
  test('role is optional on results', () =>
    expect(DropResultSchema.parse({ status: 'failed', gates: [] }).role).toBeUndefined());
  test('a result summary is optional and capped at 8000 characters', () => {
    expect(DropResultSchema.parse({ status: 'completed', gates: [] }).summary).toBeUndefined();
    expect(
      DropResultSchema.parse({ status: 'completed', gates: [], summary: 'x'.repeat(8000) }).summary,
    ).toHaveLength(8000);
    expect(() =>
      DropResultSchema.parse({ status: 'completed', gates: [], summary: 'x'.repeat(8001) }),
    ).toThrow();
  });
  test('rate_limited and interrupted are valid statuses', () => {
    for (const status of ['rate_limited', 'interrupted'])
      expect(DropResultSchema.parse({ status, gates: [] }).status).toBe(status);
  });
  test('rate limit event data keeps windows', () =>
    expect(
      RateLimitEventDataSchema.parse({
        status: 'allowed',
        unifiedWindows: { seven_day: { utilization: 0.5 } },
      }).unifiedWindows?.seven_day?.utilization,
    ).toBe(0.5));
  test('rate_limited result carries its rate limit', () =>
    expect(
      DropResultSchema.parse({
        status: 'rate_limited',
        gates: [],
        rateLimit: { status: 'rejected' },
      }).rateLimit?.status,
    ).toBe('rejected'));
  test('a REVIEW_OUTPUT_SCHEMA-shaped sample parses as a Verdict', () => {
    expect(REVIEW_OUTPUT_SCHEMA.required).toContain('decision');
    expect(IMPLEMENT_OUTPUT_SCHEMA.type).toBe('object');
    expect(
      VerdictSchema.parse({
        decision: 'approve',
        summary: 's',
        findings: [{ severity: 'minor', file: 'a.ts', detail: 'd' }],
      }).findings,
    ).toHaveLength(1);
  });
});

describe('crew roles', () => {
  const crew = {
    protocol: 1,
    dropId: 'c1',
    epoch: 1,
    role: 'crew-lead',
    repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main' },
    model: 'claude-opus-5-5',
    maxTurns: 50,
    promptVersion: 'v1',
    prompt: 'Lead the crew.',
    image: 'jumpmaster-trooper:test',
    protectedPaths: [] as string[],
    credentials: { claudeToken: 'c' },
  };
  const checkout = { number: 3, branch: 'agent/issue-7', headSha: 'abc' };

  test('isCrewRole and RoleSchema know the crew roles', () => {
    expect(CREW_ROLES).toEqual(['crew-lead', 'refute', 'diagnose']);
    expect(isCrewRole('refute')).toBe(true);
    expect(isCrewRole('review')).toBe(false);
    expect(RoleSchema.parse('diagnose')).toBe('diagnose');
  });

  test('a crew payload parses for every crew role', () => {
    for (const role of CREW_ROLES) {
      expect(DropPayloadSchema.safeParse({ ...crew, role }).success).toBe(true);
    }
  });

  test('a crew payload with an issue or gates field is rejected', () => {
    expect(DropPayloadSchema.safeParse({ ...crew, issue: base.issue }).success).toBe(false);
    expect(DropPayloadSchema.safeParse({ ...crew, gates: [] }).success).toBe(false);
    expect(DropPayloadSchema.safeParse({ ...crew, branch: 'b' }).success).toBe(false);
    expect(DropPayloadSchema.safeParse({ ...crew, gateSecrets: { A: 'b' } }).success).toBe(false);
    expect(DropPayloadSchema.safeParse({ ...crew, services: [] }).success).toBe(false);
  });

  test('crew and item payloads may carry egress; only monitor or enforce, never off', () => {
    const egress = { mode: 'enforce', allow: ['github.com'] };
    for (const role of CREW_ROLES)
      expect(DropPayloadSchema.parse({ ...crew, role, egress })).toMatchObject({ egress });
    expect(DropPayloadSchema.parse({ ...base, egress })).toMatchObject({ egress });
    expect(DropPayloadSchema.parse(base)).not.toHaveProperty('egress');
    expect(
      DropPayloadSchema.safeParse({ ...crew, egress: { mode: 'off', allow: [] } }).success,
    ).toBe(false);
  });

  test('a diagnose payload may carry a checkout; crew-lead may not', () => {
    expect(DropPayloadSchema.safeParse({ ...crew, role: 'diagnose', checkout }).success).toBe(true);
    expect(DropPayloadSchema.safeParse({ ...crew, checkout }).success).toBe(false);
  });

  const lead = {
    summary: 's',
    fileIssues: [{ key: 'add-x', objective: 'o', title: 'T', body: 'B', priority: 'high' }],
    briefings: [],
  };

  test('a valid crew-lead output parses', () => {
    expect(parseCrewOutput('crew-lead', lead)).toEqual({ ok: true, value: lead });
  });

  test('crew-lead output over its limits is rejected naming the field', () => {
    const six = { ...lead, fileIssues: Array.from({ length: 6 }, () => lead.fileIssues[0]) };
    const six_r = parseCrewOutput('crew-lead', six);
    expect(six_r.ok).toBe(false);
    if (!six_r.ok) expect(six_r.reason).toMatch(/fileIssues/);
    const long = {
      ...lead,
      fileIssues: [{ ...lead.fileIssues[0], body: 'x'.repeat(12001) }],
    };
    const long_r = parseCrewOutput('crew-lead', long);
    expect(long_r.ok).toBe(false);
    if (!long_r.ok) expect(long_r.reason).toMatch(/fileIssues\.0\.body/);
    const badKey = { ...lead, fileIssues: [{ ...lead.fileIssues[0], key: 'Bad Key' }] };
    expect(parseCrewOutput('crew-lead', badKey).ok).toBe(false);
  });

  test('refute and diagnose outputs validate', () => {
    expect(parseCrewOutput('refute', { decision: 'promote', findings: [] }).ok).toBe(true);
    expect(parseCrewOutput('refute', { decision: 'merge', findings: [] }).ok).toBe(false);
    expect(
      parseCrewOutput('diagnose', { diagnosis: 'd', recommendation: 'retry', detail: '' }).ok,
    ).toBe(true);
    expect(
      parseCrewOutput('diagnose', { diagnosis: 'd', recommendation: 'merge', detail: '' }).ok,
    ).toBe(false);
  });

  test('extra properties are refused by the parser', () => {
    expect(parseCrewOutput('refute', { decision: 'promote', findings: [], x: 1 }).ok).toBe(false);
  });

  test('crewOutputJsonSchema forbids additional properties at every level', () => {
    const walk = (s: unknown, path: string, seen: string[]): void => {
      if (typeof s !== 'object' || s === null) return;
      const o = s as Record<string, unknown>;
      if (o.type === 'object') {
        expect(o.additionalProperties, path).toBe(false);
        seen.push(path);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`, seen);
    };
    for (const role of CREW_ROLES) {
      const seen: string[] = [];
      walk(crewOutputJsonSchema(role), role, seen);
      expect(seen.length).toBeGreaterThan(0);
    }
    const lead = crewOutputJsonSchema('crew-lead') as {
      properties: { fileIssues: { items: unknown } };
    };
    const seen: string[] = [];
    walk(lead.properties.fileIssues.items, 'items', seen);
    expect(seen).toEqual(['items']);
  });

  test('a result may carry crew output, a served model and overage fields', () => {
    const r = DropResultSchema.parse({
      status: 'completed',
      role: 'crew-lead',
      crew: lead,
      servedModel: 'claude-opus-5-5',
      gates: [],
      rateLimit: { status: 'allowed', isUsingOverage: true, overageStatus: 'allowed' },
    });
    expect(r.crew).toEqual(lead);
    expect(r.servedModel).toBe('claude-opus-5-5');
    expect(RateLimitEventDataSchema.parse(r.rateLimit)).toMatchObject({
      isUsingOverage: true,
      overageStatus: 'allowed',
    });
  });
});
