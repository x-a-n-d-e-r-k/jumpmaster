import { describe, expect, test } from 'vitest';
import {
  agentBranch,
  CloneGrantSchema,
  ClonePayloadSchema,
  ClonePlanSchema,
  CloneResultSchema,
  CREW_ROLES,
  crewOutputJsonSchema,
  DoctorResultSchema,
  DropPayloadSchema,
  DropResultSchema,
  EgressPayloadSchema,
  EVENT_PREFIX,
  FEATURES_HEADER,
  ForgeRemoteSchema,
  IMAGE_MIRROR_FEATURE,
  IMPLEMENT_OUTPUT_SCHEMA,
  ImageFetchSchema,
  isCrewRole,
  PushGrantSchema,
  PushPayloadSchema,
  PushPlanSchema,
  PushRequestSchema,
  PushResultSchema,
  parseCrewOutput,
  protectedPathMatches,
  pushRequestValid,
  RateLimitEventDataSchema,
  READY_LINE,
  RESULT_PREFIX,
  REVIEW_OUTPUT_SCHEMA,
  RoleSchema,
  STICK_CAPABILITIES,
  StickInfoSchema,
  StickStartingSchema,
  TriageOutputSchema,
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
  test('rate limit event data keeps every valid window key (#144)', () => {
    const at = '2026-11-20T00:00:00.000Z';
    expect(
      RateLimitEventDataSchema.parse({
        status: 'allowed',
        unifiedWindows: {
          seven_day: { utilization: 0.5, resetsAt: at },
          seven_day_fable: { utilization: 0.42 },
        },
      }).unifiedWindows,
    ).toEqual({
      seven_day: { utilization: 0.5, resetsAt: at },
      seven_day_fable: { utilization: 0.42 },
    });
  });
  test('a bad window key or value is dropped without failing the parse (#144)', () => {
    const parsed = RateLimitEventDataSchema.parse({
      status: 'allowed',
      unifiedWindows: {
        seven_day: { utilization: 0.5 },
        'Bad-Key!': { utilization: 0.1 },
        seven_day_opus: { utilization: 2 },
        five_hour: { utilization: 0.3, resetsAt: 'soon' },
        [`k${'x'.repeat(40)}`]: { utilization: 0.1 },
      },
    });
    expect(parsed.unifiedWindows).toEqual({
      seven_day: { utilization: 0.5 },
      five_hour: { utilization: 0.3 },
    });
    expect(
      DropResultSchema.parse({
        status: 'completed',
        gates: [],
        rateLimit: { status: 'allowed', unifiedWindows: { 'Bad-Key!': { utilization: 2 } } },
      }).status,
    ).toBe('completed');
  });
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
    expect(CREW_ROLES).toEqual(['crew-lead', 'refute', 'diagnose', 'triage', 'arbitrate', 'audit']);
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

  test('a crew-lead issue may name the rejected key it replaces; results without it still parse (#784)', () => {
    expect(parseCrewOutput('crew-lead', lead).ok).toBe(true);
    const item = lead.fileIssues[0];
    const refiled = { ...lead, fileIssues: [{ ...item, key: 'add-x-2', replaces: 'add-x' }] };
    expect(parseCrewOutput('crew-lead', refiled)).toEqual({ ok: true, value: refiled });
    const bad = { ...lead, fileIssues: [{ ...item, replaces: 'Not A Key' }] };
    const bad_r = parseCrewOutput('crew-lead', bad);
    expect(bad_r.ok).toBe(false);
    if (!bad_r.ok) expect(bad_r.reason).toMatch(/fileIssues\.0\.replaces/);
    const schema = JSON.stringify(crewOutputJsonSchema('crew-lead'));
    expect(schema).toContain('"replaces"');
  });

  test('a crew-lead issue may list the keys that merge first; results without after still parse (#843)', () => {
    expect(parseCrewOutput('crew-lead', lead)).toEqual({ ok: true, value: lead });
    const item = lead.fileIssues[0];
    const ordered = {
      ...lead,
      fileIssues: [
        { ...item, after: ['add-y'] },
        { ...item, after: [] },
      ],
    };
    expect(parseCrewOutput('crew-lead', ordered)).toEqual({ ok: true, value: ordered });
    // Six keys parse: the server refuses that one issue, with the reason, not the whole result.
    const six = { ...lead, fileIssues: [{ ...item, after: ['a', 'b', 'c', 'd', 'e', 'f'] }] };
    expect(parseCrewOutput('crew-lead', six).ok).toBe(true);
    const bad = { ...lead, fileIssues: [{ ...item, after: ['Not A Key'] }] };
    const bad_r = parseCrewOutput('crew-lead', bad);
    expect(bad_r.ok).toBe(false);
    if (!bad_r.ok) expect(bad_r.reason).toMatch(/fileIssues\.0\.after/);
    expect(JSON.stringify(crewOutputJsonSchema('crew-lead'))).toContain('"after"');
  });

  test('crew-lead output may report the current objective done, and nothing else in it', () => {
    const done = { ...lead, objectiveDone: { key: 'ship-the-cli', why: 'all merged' } };
    expect(parseCrewOutput('crew-lead', done)).toEqual({ ok: true, value: done });
    const extra = { ...lead, objectiveDone: { key: 'ship-the-cli', why: 'w', title: 'x' } };
    expect(parseCrewOutput('crew-lead', extra).ok).toBe(false);
    const badKey = { ...lead, objectiveDone: { key: 'Ship The CLI', why: 'w' } };
    expect(parseCrewOutput('crew-lead', badKey).ok).toBe(false);
    const long = { ...lead, objectiveDone: { key: 'k'.repeat(61), why: 'w' } };
    expect(parseCrewOutput('crew-lead', long).ok).toBe(false);
    const longWhy = { ...lead, objectiveDone: { key: 'k', why: 'w'.repeat(2001) } };
    expect(parseCrewOutput('crew-lead', longWhy).ok).toBe(false);
  });

  test('crew-lead output may propose a goal change: a text and why, and nothing else in it', () => {
    const change = { ...lead, goalChange: { text: '# Goals', why: 'a guide is next' } };
    expect(parseCrewOutput('crew-lead', change)).toEqual({ ok: true, value: change });
    const extra = { ...lead, goalChange: { text: '# Goals', why: 'w', path: 'GOAL.md' } };
    expect(parseCrewOutput('crew-lead', extra).ok).toBe(false);
    expect(parseCrewOutput('crew-lead', { ...lead, goalChange: { text: '', why: 'w' } }).ok).toBe(
      false,
    );
    const long = { ...lead, goalChange: { text: 'x'.repeat(64_001), why: 'w' } };
    expect(parseCrewOutput('crew-lead', long).ok).toBe(false);
    const longWhy = { ...lead, goalChange: { text: '# Goals', why: 'w'.repeat(2001) } };
    expect(parseCrewOutput('crew-lead', longWhy).ok).toBe(false);
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

  test('a diagnose instruction is accepted with every recommendation, refused empty or over 2000 characters (#396)', () => {
    const base = { diagnosis: 'd', detail: '' };
    for (const recommendation of ['retry', 'leave_parked', 'needs_command'] as const) {
      expect(
        parseCrewOutput('diagnose', { ...base, recommendation, instruction: 'Fix the test.' }).ok,
      ).toBe(true);
    }
    expect(
      parseCrewOutput('diagnose', {
        ...base,
        recommendation: 'retry',
        instruction: 'x'.repeat(2000),
      }).ok,
    ).toBe(true);
    expect(
      parseCrewOutput('diagnose', { ...base, recommendation: 'retry', instruction: '' }).ok,
    ).toBe(false);
    expect(
      parseCrewOutput('diagnose', {
        ...base,
        recommendation: 'retry',
        instruction: 'x'.repeat(2001),
      }).ok,
    ).toBe(false);
  });

  test('diagnose accepts rerun_checks with checks and gateChange remove; rerun_checks needs checks (#420)', () => {
    const base = { diagnosis: 'd', detail: '' };
    expect(
      parseCrewOutput('diagnose', { ...base, recommendation: 'rerun_checks', checks: ['images'] })
        .ok,
    ).toBe(true);
    expect(
      parseCrewOutput('diagnose', {
        ...base,
        recommendation: 'retry',
        instruction: 'Remove the change to the test script.',
        gateChange: 'remove',
      }).ok,
    ).toBe(true);
    expect(parseCrewOutput('diagnose', { ...base, recommendation: 'rerun_checks' }).ok).toBe(false);
    expect(
      parseCrewOutput('diagnose', { ...base, recommendation: 'rerun_checks', checks: [] }).ok,
    ).toBe(false);
    expect(
      parseCrewOutput('diagnose', { ...base, recommendation: 'rerun_checks', checks: [''] }).ok,
    ).toBe(false);
    expect(
      parseCrewOutput('diagnose', { ...base, recommendation: 'retry', gateChange: 'allow' }).ok,
    ).toBe(false);
  });

  describe('diagnose already_done (#536)', () => {
    const base = { diagnosis: 'd', detail: 'close it' };
    const ok = (v: unknown) => parseCrewOutput('diagnose', v).ok;

    test('accepts already_done with evidence', () => {
      expect(ok({ ...base, recommendation: 'already_done', evidence: { issues: [502] } })).toBe(
        true,
      );
      expect(ok({ ...base, recommendation: 'already_done', evidence: { pulls: [7] } })).toBe(true);
    });

    test('refuses already_done without evidence', () => {
      expect(ok({ ...base, recommendation: 'already_done' })).toBe(false);
      expect(ok({ ...base, recommendation: 'already_done', evidence: {} })).toBe(false);
      expect(
        ok({ ...base, recommendation: 'already_done', evidence: { pulls: [], issues: [] } }),
      ).toBe(false);
    });

    test('refuses evidence on any other recommendation', () => {
      for (const recommendation of ['retry', 'leave_parked', 'needs_command']) {
        expect(ok({ ...base, recommendation, evidence: { pulls: [1] } }), recommendation).toBe(
          false,
        );
      }
      expect(
        ok({ ...base, recommendation: 'rerun_checks', checks: ['ci'], evidence: { pulls: [1] } }),
      ).toBe(false);
    });

    test('refuses 11 entries, a non-positive number and an unknown key', () => {
      const ten = { pulls: [1, 2, 3, 4, 5], issues: [6, 7, 8, 9, 10] };
      expect(ok({ ...base, recommendation: 'already_done', evidence: ten })).toBe(true);
      expect(
        ok({
          ...base,
          recommendation: 'already_done',
          evidence: { ...ten, issues: [...ten.issues, 11] },
        }),
      ).toBe(false);
      expect(ok({ ...base, recommendation: 'already_done', evidence: { pulls: [0] } })).toBe(false);
      expect(ok({ ...base, recommendation: 'already_done', evidence: { prs: [1] } })).toBe(false);
    });
  });

  describe('TriageOutputSchema', () => {
    const child = {
      key: 'hide-gauge',
      title: 'Hide the overage gauge',
      body: 'B',
      priority: 'high',
    };
    const briefing = {
      subject: 'fable usage',
      decision: 'Drop the gauge, estimate it, or wait?',
      why: 'w',
      options: ['drop', 'estimate'],
      recommendation: 'drop',
      onHold: '#179',
    };
    const split = { summary: 's', outcome: 'split', children: [child, { ...child, key: 'b' }] };
    const questions = { summary: 's', outcome: 'questions', briefing };
    const notAgent = { summary: 's', outcome: 'not-agent-work', reason: 'a question' };
    const ok = (v: unknown) => TriageOutputSchema.safeParse(v).success;

    test('accepts the three valid shapes', () => {
      expect(ok(split)).toBe(true);
      expect(ok({ ...split, children: [child], briefing: undefined })).toBe(true);
      expect(ok(questions)).toBe(true);
      expect(ok({ ...questions, children: [] })).toBe(true);
      expect(ok(notAgent)).toBe(true);
      expect(parseCrewOutput('triage', notAgent)).toEqual({ ok: true, value: notAgent });
    });

    test('rejects every forbidden combination', () => {
      for (const bad of [
        { summary: 's', outcome: 'split' },
        { ...split, children: [] },
        { ...split, briefing },
        { ...split, reason: 'r' },
        { summary: 's', outcome: 'questions' },
        { ...questions, children: [child] },
        { ...questions, reason: 'r' },
        { summary: 's', outcome: 'not-agent-work' },
        { ...notAgent, children: [child] },
        { ...notAgent, briefing },
        { ...notAgent, outcome: 'maybe' },
        { ...notAgent, extra: 1 },
      ]) {
        expect(ok(bad), JSON.stringify(bad)).toBe(false);
      }
    });

    test('rejects a sixth child, a 121-character title and a bad key', () => {
      const six = {
        ...split,
        children: Array.from({ length: 6 }, (_, n) => ({ ...child, key: `k${n}` })),
      };
      const r = parseCrewOutput('triage', six);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/children/);
      expect(ok({ ...split, children: [{ ...child, title: 'x'.repeat(121) }] })).toBe(false);
      expect(ok({ ...split, children: [{ ...child, title: 'x'.repeat(120) }] })).toBe(true);
      expect(ok({ ...split, children: [{ ...child, key: 'Bad Key' }] })).toBe(false);
      expect(ok({ ...split, children: [{ ...child, body: 'x'.repeat(12001) }] })).toBe(false);
      expect(ok({ ...questions, briefing: { ...briefing, options: ['one'] } })).toBe(false);
      expect(ok({ ...notAgent, reason: 'x'.repeat(501) })).toBe(false);
    });

    describe('already-done', () => {
      const done = {
        summary: 's',
        outcome: 'already-done',
        reason: 'shipped',
        evidence: { pulls: [120], issues: [119] },
      };

      test('accepts evidence with a reason', () => {
        expect(ok(done)).toBe(true);
        expect(ok({ ...done, evidence: { issues: [119] } })).toBe(true);
        expect(ok({ ...done, evidence: { pulls: [1] } })).toBe(true);
        expect(parseCrewOutput('triage', done)).toEqual({ ok: true, value: done });
      });

      test('refuses it without evidence, without a reason, or with children or a briefing', () => {
        for (const bad of [
          { ...done, evidence: undefined },
          { ...done, evidence: {} },
          { ...done, evidence: { pulls: [], issues: [] } },
          { ...done, reason: undefined },
          { ...done, children: [child] },
          { ...done, briefing },
          { ...done, evidence: { pulls: [0] } },
          { ...done, evidence: { pulls: [-3] } },
          { ...done, evidence: { pulls: [1.5] } },
          { ...done, evidence: { pulls: [1], extra: [2] } },
        ]) {
          expect(ok(bad), JSON.stringify(bad)).toBe(false);
        }
      });

      test('refuses evidence on every other outcome', () => {
        const evidence = { pulls: [1] };
        expect(ok({ ...split, evidence })).toBe(false);
        expect(ok({ ...questions, evidence })).toBe(false);
        expect(ok({ ...notAgent, evidence })).toBe(false);
      });

      test('refuses more than 10 entries in all', () => {
        const ten = { pulls: [1, 2, 3, 4, 5], issues: [6, 7, 8, 9, 10] };
        expect(ok({ ...done, evidence: ten })).toBe(true);
        expect(ok({ ...done, evidence: { ...ten, issues: [...ten.issues, 11] } })).toBe(false);
        expect(
          ok({ ...done, evidence: { pulls: Array.from({ length: 11 }, (_, n) => n + 1) } }),
        ).toBe(false);
      });
    });
  });

  describe('arbitrate', () => {
    const ruling = {
      ruling: 'A',
      because: 'Every finding was wording; the cited lines exist.',
      wouldReverse: 'A cited line that does not exist.',
      reversible: true,
      productQuestion: false,
      instruction: 'Promote the issue.',
    };

    test('parseCrewOutput accepts a full ruling', () => {
      expect(parseCrewOutput('arbitrate', ruling)).toEqual({ ok: true, value: ruling });
      expect(parseCrewOutput('arbitrate', { ...ruling, ruling: 'insufficient_evidence' }).ok).toBe(
        true,
      );
    });

    test('parseCrewOutput refuses an extra property, an unknown or missing ruling', () => {
      expect(parseCrewOutput('arbitrate', { ...ruling, x: 1 }).ok).toBe(false);
      expect(parseCrewOutput('arbitrate', { ...ruling, ruling: 'C' }).ok).toBe(false);
      const { ruling: _r, ...missing } = ruling;
      expect(parseCrewOutput('arbitrate', missing).ok).toBe(false);
    });

    test('DropPayloadSchema accepts an arbitrate payload and refuses item fields', () => {
      // The crew credential slot only ever carries the read token (payloads.ts); what a schema can
      // refuse is everything a write needs: an issue, a branch, gates and their secrets.
      expect(DropPayloadSchema.safeParse({ ...crew, role: 'arbitrate' }).success).toBe(true);
      const arb = { ...crew, role: 'arbitrate' };
      expect(DropPayloadSchema.safeParse({ ...arb, issue: base.issue }).success).toBe(false);
      expect(DropPayloadSchema.safeParse({ ...arb, branch: 'b' }).success).toBe(false);
      expect(DropPayloadSchema.safeParse({ ...arb, gates: [] }).success).toBe(false);
      expect(DropPayloadSchema.safeParse({ ...arb, gateSecrets: { A: 'b' } }).success).toBe(false);
      // An item's arbitration reads the disputed PR's head, as diagnose does (#383).
      expect(
        DropPayloadSchema.safeParse({ ...arb, checkout: { number: 1, branch: 'b', headSha: 'a' } })
          .success,
      ).toBe(true);
      expect(DropPayloadSchema.safeParse({ ...arb, checkout: { number: 1 } }).success).toBe(false);
    });
  });

  describe('audit', () => {
    const issue = { title: 'Fix the cap', body: '## Acceptance criteria\n- [ ] x' };

    test('parseCrewOutput accepts holds without an issue and refuted with one', () => {
      const holds = { verdict: 'holds', findings: [] };
      expect(parseCrewOutput('audit', holds)).toEqual({ ok: true, value: holds });
      const refuted = { verdict: 'refuted', findings: ['src/a.ts:3 is off by one'], issue };
      expect(parseCrewOutput('audit', refuted)).toEqual({ ok: true, value: refuted });
    });

    test('parseCrewOutput refuses refuted without an issue, holds with one, and extras', () => {
      expect(parseCrewOutput('audit', { verdict: 'refuted', findings: [] }).ok).toBe(false);
      expect(parseCrewOutput('audit', { verdict: 'holds', findings: [], issue }).ok).toBe(false);
      expect(parseCrewOutput('audit', { verdict: 'holds', findings: [], x: 1 }).ok).toBe(false);
      expect(
        parseCrewOutput('audit', { verdict: 'refuted', findings: [], issue: { ...issue, x: 1 } })
          .ok,
      ).toBe(false);
    });

    test('DropPayloadSchema accepts an audit payload and refuses item fields', () => {
      const audit = { ...crew, role: 'audit' };
      expect(DropPayloadSchema.safeParse(audit).success).toBe(true);
      expect(DropPayloadSchema.safeParse({ ...audit, issue: base.issue }).success).toBe(false);
      expect(DropPayloadSchema.safeParse({ ...audit, branch: 'b' }).success).toBe(false);
      expect(
        DropPayloadSchema.safeParse({
          ...audit,
          checkout: { number: 1, branch: 'b', headSha: 'a' },
        }).success,
      ).toBe(false);
    });
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

describe('the doctor role', () => {
  const doctor = {
    protocol: 1,
    dropId: 'doc-1',
    epoch: 1,
    role: 'doctor',
    repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main' },
    model: 'claude-opus-5-5',
    image: 'jumpmaster-trooper:test',
    gates: [{ name: 'test', run: 'npm test', timeoutMinutes: 5 }],
    credentials: { claudeToken: 'c', readToken: 'r' },
  };

  test('a doctor payload parses, with services, limits, gate secrets and egress', () => {
    const p = DropPayloadSchema.parse({
      ...doctor,
      services: [{ name: 'db', image: 'pg@sha256:x', port: 5432 }],
      limits: { pids: 100 },
      gateSecrets: { DB: 'pw' },
      egress: { mode: 'monitor', allow: ['github.com'] },
    });
    expect(p.role).toBe('doctor');
    expect(DropPayloadSchema.parse({ ...doctor, credentials: { claudeToken: 'c' } }).role).toBe(
      'doctor',
    );
    expect(RoleSchema.options).toContain('doctor');
    expect(isCrewRole('doctor')).toBe(false);
  });

  test('a doctor payload with a forgeToken, issue or branch is rejected', () => {
    for (const extra of [
      { credentials: { claudeToken: 'c', forgeToken: 'f' } },
      { issue: { number: 1, title: 't', body: 'b' } },
      { branch: 'agent/issue-1' },
      { prompt: 'do anything' },
      { protectedPaths: [] },
    ])
      expect(DropPayloadSchema.safeParse({ ...doctor, ...extra }).success).toBe(false);
  });

  test('a result may carry the doctor findings; they are validated', () => {
    const findings = {
      claude: { ok: false, error: 'authentication_failed' },
      clone: { ok: true, sha: 'abc' },
      services: [{ name: 'db', ok: true }],
      gates: [{ name: 'test', exitCode: 1, durationMs: 5, timedOut: false, outputTail: 'x' }],
    };
    const r = DropResultSchema.parse({
      status: 'completed',
      role: 'doctor',
      gates: findings.gates,
      doctor: findings,
    });
    expect(r.doctor).toEqual(findings);
    expect(DoctorResultSchema.safeParse({ ...findings, claude: { ok: 'yes' } }).success).toBe(
      false,
    );
  });
});

describe('protectedPathMatches (the one matcher for push and review checks)', () => {
  test.each([
    ['node_modules/.bin/x', 'node_modules/**'],
    ['.github/workflows/ci.yml', '**/*.yml'],
    ['a/.env', '**/*'],
    ['.claude', '.claude/**'],
    ['.github', '.github/**'],
    ['deep/dir/key.pem', '*.pem'],
    ['deep/.secret.pem', '*.pem'],
    ['.github/x.yml', '.github/**'],
  ])('%s is covered by %s', (p, g) => {
    expect(protectedPathMatches(p, g)).toBe(true);
  });
  test.each([
    ['src/a.ts', 'docs/**'],
    ['docsx/a.md', 'docs/**'],
    ['.githubx/a', '.github/**'],
    ['a/b.yml', 'b/*.yml'],
  ])('%s is not covered by %s', (p, g) => {
    expect(protectedPathMatches(p, g)).toBe(false);
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const doneResult = (over: Record<string, unknown>) =>
  DropResultSchema.parse({ status: 'completed', gates: [], ...over });

describe('push protocol', () => {
  test('push-v1 is a capability and the wire constants are fixed', () => {
    expect(STICK_CAPABILITIES).toContain('push-v1');
    expect(READY_LINE).toBe('JM_READY');
    expect(FEATURES_HEADER).toBe('x-jumpmaster-features');
  });

  test('image fetch progress (issue #141): the feature name and bytes done of total', () => {
    expect(IMAGE_MIRROR_FEATURE).toBe('image-mirror-v1');
    const ref = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
    expect(ImageFetchSchema.parse({ ref, done: 5, total: 10 })).toEqual({
      ref,
      done: 5,
      total: 10,
    });
    for (const bad of [
      { ref, done: -1, total: 10 },
      { ref, done: 1.5, total: 10 },
      { ref: '', done: 0, total: 0 },
      { ref: 'x'.repeat(513), done: 0, total: 0 },
      { ref, done: 0 },
    ])
      expect(ImageFetchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  test('a starting report (issue #157) names the image the first health check is checking', () => {
    const image = `ghcr.io/o/jumpmaster-trooper@sha256:${'a'.repeat(64)}`;
    expect(StickStartingSchema.parse({ image })).toEqual({ image });
    for (const bad of [{}, { image: '' }, { image: 'x'.repeat(513) }])
      expect(StickStartingSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  test('push request: final needs expectSha; checkpoint forbids it', () => {
    expect(PushRequestSchema.safeParse({ kind: 'final', expectSha: SHA_A }).success).toBe(true);
    expect(PushRequestSchema.safeParse({ kind: 'final' }).success).toBe(false);
    expect(PushRequestSchema.safeParse({ kind: 'final', expectSha: 'abc' }).success).toBe(false);
    expect(PushRequestSchema.safeParse({ kind: 'checkpoint' }).success).toBe(true);
    expect(PushRequestSchema.safeParse({ kind: 'checkpoint', expectSha: SHA_A }).success).toBe(
      false,
    );
    expect(PushRequestSchema.safeParse({ kind: 'salvage' }).success).toBe(false);
    expect(
      DropResultSchema.safeParse({
        status: 'completed',
        gates: [],
        push: { kind: 'final' },
      }).success,
    ).toBe(false);
  });

  test('pushRequestValid: final only with completed and matching headSha; checkpoint only interrupted or rate_limited; never for resolve checkpoints or non-pushing roles', () => {
    const fin = { kind: 'final', expectSha: SHA_A };
    const cp = { kind: 'checkpoint' };
    expect(pushRequestValid(doneResult({ headSha: SHA_A, push: fin }), 'implement')).toBe(true);
    expect(pushRequestValid(doneResult({ headSha: SHA_A, push: fin }), 'heal')).toBe(true);
    expect(pushRequestValid(doneResult({ headSha: SHA_A, push: fin }), 'resolve')).toBe(true);
    expect(pushRequestValid(doneResult({ headSha: SHA_B, push: fin }), 'implement')).toBe(false);
    expect(pushRequestValid(doneResult({ push: fin }), 'implement')).toBe(false);
    expect(
      pushRequestValid(doneResult({ status: 'failed', headSha: SHA_A, push: fin }), 'implement'),
    ).toBe(false);
    expect(pushRequestValid(doneResult({ status: 'interrupted', push: cp }), 'implement')).toBe(
      true,
    );
    expect(pushRequestValid(doneResult({ status: 'rate_limited', push: cp }), 'heal')).toBe(true);
    expect(pushRequestValid(doneResult({ status: 'completed', push: cp }), 'implement')).toBe(
      false,
    );
    expect(pushRequestValid(doneResult({ status: 'interrupted', push: cp }), 'resolve')).toBe(
      false,
    );
    for (const role of ['review', 'crew-lead', 'refute', 'diagnose', 'doctor'] as const) {
      expect(pushRequestValid(doneResult({ headSha: SHA_A, push: fin }), role)).toBe(false);
      expect(pushRequestValid(doneResult({ status: 'interrupted', push: cp }), role)).toBe(false);
    }
    // No request is nothing to refuse.
    expect(pushRequestValid(doneResult({}), 'review')).toBe(true);
  });

  const payload = {
    protocol: 1,
    role: 'push',
    dropId: 'd1',
    epoch: 2,
    branch: 'agent/x',
    salvage: false,
  };

  test('push payload is strict and has no token field', () => {
    expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
    expect(PushPayloadSchema.safeParse({ ...payload, token: 't' }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...payload, credentials: {} }).success).toBe(false);
    expect(PushPayloadSchema.safeParse({ ...payload, branch: '' }).success).toBe(false);
    expect(Object.keys(PushPayloadSchema.shape)).not.toContain('token');
  });

  test('grant and plan reject unknown keys', () => {
    const plan = { branch: 'agent/x', salvage: false };
    expect(PushPlanSchema.safeParse(plan).success).toBe(true);
    expect(
      PushPlanSchema.safeParse({
        ...plan,
        limits: { pids: 100 },
        egress: { mode: 'enforce', allow: ['github.com'] },
      }).success,
    ).toBe(true);
    expect(PushPlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
    const grant = {
      token: 't',
      owner: 'o',
      name: 'n',
      branch: 'agent/x',
      base: 'main',
      lease: '',
      protectedPaths: ['.github/**'],
      secrets: ['s'],
    };
    expect(PushGrantSchema.safeParse(grant).success).toBe(true);
    expect(PushGrantSchema.safeParse({ ...grant, expectSha: SHA_A }).success).toBe(true);
    expect(PushGrantSchema.safeParse({ ...grant, extra: 1 }).success).toBe(false);
    // A grant without a credential is no grant.
    expect(PushGrantSchema.safeParse({ ...grant, token: '' }).success).toBe(false);
  });

  test('grant lease is a full SHA or empty; base and branch are safe ref names (issue #262)', () => {
    const grant = {
      token: 't',
      owner: 'o',
      name: 'n',
      branch: 'agent/issue-1',
      base: 'main',
      lease: '',
      protectedPaths: [],
      secrets: [],
    };
    const ok = (over: Record<string, unknown>) => PushGrantSchema.safeParse({ ...grant, ...over });
    expect(ok({}).success).toBe(true);
    expect(ok({ lease: SHA_A }).success).toBe(true);
    for (const lease of ['-x', 'refs/heads/main', 'main', SHA_A.toUpperCase(), SHA_A.slice(1)])
      expect(ok({ lease }).success, lease).toBe(false);
    for (const base of ['main', 'develop', 'release/1.x', 'v2_stable'])
      expect(ok({ base }).success, base).toBe(true);
    for (const bad of [
      '',
      '-x',
      '--output=/x',
      'a..b',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'x.lock',
      'a/',
      '/a',
      'a//b',
      'a@{1}',
      '.a',
      'a/.b',
      'a*',
      'a?',
      'a[',
      'a\\b',
      '@',
      'a\u0001',
    ]) {
      expect(ok({ base: bad }).success, `base ${JSON.stringify(bad)}`).toBe(false);
      expect(ok({ branch: bad }).success, `branch ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  test('a result SHA is a full lowercase 40-hex SHA (issue #262)', () => {
    expect(
      DropResultSchema.safeParse({ status: 'interrupted', gates: [], headSha: SHA_A }).success,
    ).toBe(true);
    for (const headSha of ['--x', '--output=/x', SHA_A.slice(1), SHA_A.toUpperCase(), 'main', ''])
      expect(
        DropResultSchema.safeParse({ status: 'interrupted', gates: [], headSha }).success,
        headSha,
      ).toBe(false);
  });

  test('push result variants', () => {
    expect(
      PushResultSchema.safeParse({ status: 'pushed', headSha: SHA_A, alreadyThere: false }).success,
    ).toBe(true);
    expect(
      PushResultSchema.safeParse({ status: 'pushed', headSha: 'x', alreadyThere: false }).success,
    ).toBe(false);
    expect(
      PushResultSchema.safeParse({ status: 'failed', reason: 'net', retryable: true }).success,
    ).toBe(true);
    expect(PushResultSchema.safeParse({ status: 'failed', reason: 'net' }).success).toBe(false);
    expect(
      PushResultSchema.safeParse({ status: 'failed', reason: 'x'.repeat(2001), retryable: false })
        .success,
    ).toBe(false);
    expect(PushResultSchema.safeParse({ status: 'nothing', reason: 'empty' }).success).toBe(true);
    expect(PushResultSchema.safeParse({ status: 'nothing' }).success).toBe(false);
    expect(PushResultSchema.safeParse({ status: 'other', reason: 'x' }).success).toBe(false);
  });
});

describe('ForgeRemoteSchema (#716)', () => {
  const forge = { kind: 'gitlab', origin: 'https://gitlab.com', projectPath: 'group/sub/project' };

  test('accepts a gitlab.com origin and a self-managed origin with a port', () => {
    expect(ForgeRemoteSchema.parse(forge)).toEqual(forge);
    const selfManaged = { ...forge, origin: 'https://git.example.internal:8443' };
    expect(ForgeRemoteSchema.parse(selfManaged)).toEqual(selfManaged);
  });

  test.each([
    ['an http:// origin', { origin: 'http://gitlab.com' }],
    ['an origin with a path', { origin: 'https://gitlab.com/group' }],
    ['an origin with userinfo', { origin: 'https://user:pw@gitlab.com' }],
    ['an origin with a trailing slash', { origin: 'https://gitlab.com/' }],
    ['an origin with a query', { origin: 'https://gitlab.com?x=1' }],
    ['an origin with a fragment', { origin: 'https://gitlab.com#x' }],
    ['a non-URL origin', { origin: 'gitlab.com' }],
    ['a bad project path', { projectPath: 'project' }],
    ['a project path with ..', { projectPath: 'group/../project' }],
    ['an unknown kind', { kind: 'gitea' }],
    ['an extra key', { extra: 1 }],
  ])('rejects %s', (_what, change) => {
    expect(ForgeRemoteSchema.safeParse({ ...forge, ...change }).success).toBe(false);
  });

  const grant = {
    token: 't',
    owner: 'o',
    name: 'n',
    branch: 'agent/issue-1',
    base: 'main',
    lease: '',
    protectedPaths: [],
    secrets: [],
  };

  test('a push grant parses unchanged without forge, and parses with it', () => {
    expect(PushGrantSchema.parse(grant)).toEqual(grant);
    expect(PushGrantSchema.parse({ ...grant, forge })).toEqual({ ...grant, forge });
    expect(PushGrantSchema.safeParse({ ...grant, forge: { ...forge, kind: 'x' } }).success).toBe(
      false,
    );
    const { owner: _o, ...noOwner } = grant;
    expect(PushGrantSchema.safeParse({ ...noOwner, forge }).success).toBe(false);
  });

  const crewPayload = {
    protocol: 1,
    dropId: 'c1',
    epoch: 1,
    role: 'refute',
    repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main' },
    model: 'claude-opus-5-5',
    maxTurns: 50,
    promptVersion: 'v1',
    prompt: 'Refute.',
    image: 'jumpmaster-trooper:test',
    protectedPaths: [] as string[],
    credentials: { claudeToken: 'c' },
  };
  const doctorPayload = {
    protocol: 1,
    dropId: 'doc-1',
    epoch: 1,
    role: 'doctor',
    repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main' },
    model: 'claude-opus-5-5',
    image: 'jumpmaster-trooper:test',
    gates: [] as unknown[],
    credentials: { claudeToken: 'c', readToken: 'r' },
  };

  test.each([
    ['implement', validPayload],
    ['a crew role', crewPayload],
    ['doctor', doctorPayload],
  ])('a %s drop payload parses unchanged without forge, and with it', (_what, p) => {
    const plain = DropPayloadSchema.parse(p);
    expect(plain.repo).toEqual(p.repo);
    expect('forge' in plain.repo).toBe(false);
    const withForge = DropPayloadSchema.parse({ ...p, repo: { ...p.repo, forge } });
    expect(withForge.repo).toEqual({ ...p.repo, forge });
    expect(
      DropPayloadSchema.safeParse({
        ...p,
        repo: { ...p.repo, forge: { ...forge, origin: 'http://gitlab.com' } },
      }).success,
    ).toBe(false);
    const { owner: _o, ...noOwner } = p.repo;
    expect(DropPayloadSchema.safeParse({ ...p, repo: { ...noOwner, forge } }).success).toBe(false);
  });
});

describe('StickInfoSchema egressCeiling (#780)', () => {
  test('an absent field reads as null: an older stick has no ceiling', () => {
    expect(StickInfoSchema.parse({}).egressCeiling).toBeNull();
    expect(StickInfoSchema.parse({ egressCeiling: null }).egressCeiling).toBeNull();
  });

  test('a list of hosts is kept as sent', () => {
    expect(
      StickInfoSchema.parse({ egressCeiling: ['api.anthropic.com', 'registry.npmjs.org'] })
        .egressCeiling,
    ).toEqual(['api.anthropic.com', 'registry.npmjs.org']);
  });

  test('too many entries, an over-long or an empty entry is refused', () => {
    const many = Array.from({ length: 257 }, (_, i) => `h${i}.example.com`);
    expect(StickInfoSchema.safeParse({ egressCeiling: many }).success).toBe(false);
    expect(StickInfoSchema.safeParse({ egressCeiling: many.slice(0, 256) }).success).toBe(true);
    expect(StickInfoSchema.safeParse({ egressCeiling: ['a'.repeat(256)] }).success).toBe(false);
    expect(StickInfoSchema.safeParse({ egressCeiling: ['a'.repeat(255)] }).success).toBe(true);
    expect(StickInfoSchema.safeParse({ egressCeiling: [''] }).success).toBe(false);
  });
});

describe('clone container protocol (#830)', () => {
  const forge = { kind: 'gitlab', origin: 'https://gitlab.example.com', projectPath: 'grp/proj' };

  test('STICK_CAPABILITIES names clone-v1', () => {
    expect(STICK_CAPABILITIES).toContain('clone-v1');
  });

  const payload = { protocol: 1, role: 'clone', dropId: 'd1', epoch: 2 };
  test('the clone payload parses, with and without egress, and is strict', () => {
    expect(ClonePayloadSchema.parse(payload)).toEqual(payload);
    expect(ClonePayloadSchema.parse({ ...payload, egress: true })).toEqual({
      ...payload,
      egress: true,
    });
    expect(ClonePayloadSchema.safeParse({ ...payload, token: 't' }).success).toBe(false);
    expect(ClonePayloadSchema.safeParse({ ...payload, egress: false }).success).toBe(false);
    expect(ClonePayloadSchema.safeParse({ ...payload, role: 'push' }).success).toBe(false);
    expect(ClonePayloadSchema.safeParse({ ...payload, protocol: 2 }).success).toBe(false);
  });

  const plan = { forge, maxBytes: 1024 };
  test('the clone plan parses, needs a forge and a positive integer maxBytes, and is strict', () => {
    expect(ClonePlanSchema.parse(plan)).toEqual(plan);
    const full = {
      ...plan,
      limits: { pids: 100, memoryMb: 512 },
      egress: { mode: 'enforce', allow: ['gitlab.example.com'] },
    };
    expect(ClonePlanSchema.parse(full)).toEqual(full);
    expect(ClonePlanSchema.safeParse({ ...plan, token: 't' }).success).toBe(false);
    expect(ClonePlanSchema.safeParse({ maxBytes: 1 }).success).toBe(false);
    for (const maxBytes of [0, -1, 1.5, '1'])
      expect(ClonePlanSchema.safeParse({ ...plan, maxBytes }).success).toBe(false);
    const pathOrigin = { ...forge, origin: 'https://gitlab.example.com/grp' };
    expect(ClonePlanSchema.safeParse({ ...plan, forge: pathOrigin }).success).toBe(false);
  });

  const grant = { token: 'tok', forge, secrets: ['tok'] };
  test('the clone grant parses with and without a username, and refuses bad ones', () => {
    expect(CloneGrantSchema.parse(grant)).toEqual(grant);
    const named = { ...grant, username: 'gitlab+deploy-token-7' };
    expect(CloneGrantSchema.parse(named)).toEqual(named);
    expect(CloneGrantSchema.safeParse({ ...grant, token: '' }).success).toBe(false);
    expect(CloneGrantSchema.safeParse({ ...grant, username: 'a:b' }).success).toBe(false);
    expect(CloneGrantSchema.safeParse({ ...grant, username: '' }).success).toBe(false);
    expect(CloneGrantSchema.safeParse({ ...grant, extra: 1 }).success).toBe(false);
    const { forge: _f, ...noForge } = grant;
    expect(CloneGrantSchema.safeParse(noForge).success).toBe(false);
  });

  test('the clone result is cloned or failed', () => {
    const cloned = { status: 'cloned', bytes: 4096 };
    expect(CloneResultSchema.parse(cloned)).toEqual(cloned);
    const failed = { status: 'failed', reason: 'auth', retryable: false };
    expect(CloneResultSchema.parse(failed)).toEqual(failed);
    expect(CloneResultSchema.safeParse({ ...failed, reason: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(CloneResultSchema.safeParse({ status: 'pushed' }).success).toBe(false);
    expect(CloneResultSchema.safeParse({ status: 'cloned' }).success).toBe(false);
  });

  test('payloads without repo.mirror parse unchanged; mirror must be provided', () => {
    const github = { ...validPayload, resume: false };
    expect(DropPayloadSchema.parse(github)).toEqual(github);
    const gitlab = { ...github, repo: { ...github.repo, forge } };
    expect(DropPayloadSchema.parse(gitlab)).toEqual(gitlab);
    const mirrored = { ...gitlab, repo: { ...gitlab.repo, mirror: 'provided' } };
    expect(DropPayloadSchema.parse(mirrored)).toEqual(mirrored);
    const other = { ...gitlab, repo: { ...gitlab.repo, mirror: 'fetched' } };
    expect(DropPayloadSchema.safeParse(other).success).toBe(false);
    const crew = {
      protocol: 1,
      dropId: 'c1',
      epoch: 1,
      role: 'refute',
      repo: { owner: 'octo', name: 'widgets', defaultBranch: 'main', forge },
      model: 'claude-opus-5-5',
      maxTurns: 50,
      promptVersion: 'v1',
      prompt: 'Refute.',
      image: 'jumpmaster-trooper:test',
      protectedPaths: [] as string[],
      credentials: { claudeToken: 'c' },
    };
    expect(DropPayloadSchema.parse(crew)).toEqual(crew);
    const crewMirrored = { ...crew, repo: { ...crew.repo, mirror: 'provided' } };
    expect(DropPayloadSchema.parse(crewMirrored)).toEqual(crewMirrored);
  });
});

describe('EgressPayloadSchema private (#888)', () => {
  const allow = ['api.anthropic.com', 'gitlab.internal.example', '*.example.net'];

  test('private is accepted when every entry is on allow (after normalizeHost)', () => {
    const p = { mode: 'enforce', allow, private: ['GitLab.Internal.Example.'] };
    expect(EgressPayloadSchema.parse(p)).toEqual(p);
    expect(EgressPayloadSchema.parse({ mode: 'enforce', allow, private: [] })).toEqual({
      mode: 'enforce',
      allow,
      private: [],
    });
  });

  test('omitting private keeps the parse result of today', () => {
    const p = { mode: 'monitor', allow: ['github.com'] };
    const parsed = EgressPayloadSchema.parse(p);
    expect(parsed).toEqual(p);
    expect(parsed).not.toHaveProperty('private');
  });

  const refused = (priv: string[], list = allow) => {
    const r = EgressPayloadSchema.safeParse({ mode: 'enforce', allow: list, private: priv });
    expect(r.success).toBe(false);
    if (r.success) return;
    for (const issue of r.error.issues) {
      expect(issue.path[0]).toBe('private');
      expect(issue.message).toMatch(/private/);
      for (const v of priv) if (v.length > 0) expect(issue.message).not.toContain(v);
    }
  };

  test('a wildcard entry is refused, even when the same wildcard is on allow', () => {
    refused(['*.example.net']);
  });

  test('an IP literal is refused', () => {
    refused(['10.0.0.5'], [...allow, '10.0.0.5']);
    refused(['[::1]']);
  });

  test('an entry missing from allow is refused', () => {
    refused(['other.internal.example']);
    // A wildcard on allow doesn't make a subdomain private-listable.
    refused(['git.example.net']);
  });

  test('more than 16 entries are refused', () => {
    const hosts = Array.from({ length: 17 }, (_, i) => `h${i}.internal.example`);
    refused(hosts, hosts);
    const ok = hosts.slice(0, 16);
    expect(EgressPayloadSchema.safeParse({ mode: 'enforce', allow: ok, private: ok }).success).toBe(
      true,
    );
  });

  test('drop, push and clone payloads carry private through', () => {
    const egress = { mode: 'enforce', allow, private: ['gitlab.internal.example'] };
    const push = { branch: 'agent/issue-1', salvage: false, egress };
    expect(PushPlanSchema.parse(push)).toEqual(push);
    const clone = {
      forge: { kind: 'gitlab', origin: 'https://gitlab.internal.example', projectPath: 'g/p' },
      maxBytes: 1024,
      egress,
    };
    expect(ClonePlanSchema.parse(clone).egress).toEqual(egress);
    const bad = { ...egress, private: ['elsewhere.example'] };
    expect(PushPlanSchema.safeParse({ ...push, egress: bad }).success).toBe(false);
    expect(ClonePlanSchema.safeParse({ ...clone, egress: bad }).success).toBe(false);
  });
});

describe('egress-private-v1 (#897)', () => {
  test('STICK_CAPABILITIES names egress-private-v1 and stays sorted', () => {
    expect(STICK_CAPABILITIES).toContain('egress-private-v1');
    expect([...STICK_CAPABILITIES]).toEqual([...STICK_CAPABILITIES].sort());
  });
});
