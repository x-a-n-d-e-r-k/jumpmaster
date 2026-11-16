import { describe, expect, test } from 'vitest';
import {
  agentBranch,
  CREW_ROLES,
  crewOutputJsonSchema,
  DoctorResultSchema,
  DropPayloadSchema,
  DropResultSchema,
  EVENT_PREFIX,
  FEATURES_HEADER,
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
  StickStartingSchema,
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
      lease: 'l',
      protectedPaths: ['.github/**'],
      secrets: ['s'],
    };
    expect(PushGrantSchema.safeParse(grant).success).toBe(true);
    expect(PushGrantSchema.safeParse({ ...grant, expectSha: SHA_A }).success).toBe(true);
    expect(PushGrantSchema.safeParse({ ...grant, extra: 1 }).success).toBe(false);
    // A grant without a credential is no grant.
    expect(PushGrantSchema.safeParse({ ...grant, token: '' }).success).toBe(false);
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
