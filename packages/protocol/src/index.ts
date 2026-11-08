import { basename, matchesGlob } from 'node:path';
import { z } from 'zod';

export const EVENT_PREFIX = 'JM_EVENT ';
export const RESULT_PREFIX = 'JM_RESULT ';
export const ARTIFACT_PREFIX = 'JM_ARTIFACT ';
export const MAX_ARTIFACTS = 10;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/** Whether a repo-relative path matches a glob. A glob with no slash also matches a basename. */
export function pathMatches(p: string, glob: string): boolean {
  if (matchesGlob(p, glob)) return true;
  // `dir/**` also covers a bare `dir` entry (a file or symlink standing in for the directory).
  if (glob.endsWith('/**') && p === glob.slice(0, -3)) return true;
  return !glob.includes('/') && matchesGlob(basename(p), glob);
}

/** The only place the agent branch name is built. */
export function agentBranch(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

export const GateSpecSchema = z.object({
  name: z.string(),
  run: z.string(),
  timeoutMinutes: z.number().default(20),
});
export type GateSpec = z.infer<typeof GateSpecSchema>;

/** Roles that work for the zone rather than one work item. They hold no forge write credential. */
export const CREW_ROLES = ['crew-lead', 'refute', 'diagnose'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
export const isCrewRole = (r: string): r is CrewRole =>
  (CREW_ROLES as readonly string[]).includes(r);

export const RoleSchema = z.enum(['implement', 'review', 'heal', 'resolve', ...CREW_ROLES]);
export type Role = z.infer<typeof RoleSchema>;

export const PrRefSchema = z.object({
  number: z.number(),
  branch: z.string(),
  headSha: z.string(),
});
export type PrRef = z.infer<typeof PrRefSchema>;

/** A step that must produce evidence, such as screenshots, when a PR touches `paths`. */
export const VerificationSpecSchema = z.object({
  name: z.string().min(1),
  paths: z.array(z.string()).min(1),
  run: z.string().min(1),
  artifacts: z.string().min(1),
  timeoutMinutes: z.number().positive().default(20),
});
export type VerificationSpec = z.infer<typeof VerificationSpecSchema>;

export const ArtifactChunkSchema = z.object({
  rule: z.string(),
  name: z.string(),
  mediaType: z.string(),
  sha256: z.string(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  data: z.string(),
});

export const ArtifactUploadSchema = z.object({
  rule: z.string(),
  name: z.string().max(1024),
  mediaType: z.string(),
  sha256: z.string(),
  dataBase64: z.string(),
});
export type ArtifactUpload = z.infer<typeof ArtifactUploadSchema>;

/** A sidecar for gate steps, reachable by `name` on the drop's private network. */
export const ServiceSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'service name must be a DNS label'),
  image: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  env: z.record(z.string(), z.string()).optional(),
  readyTimeoutSeconds: z.number().positive().default(60),
});
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;

export const ContainerLimitsSchema = z.object({
  pids: z.number().int().positive(),
  memoryMb: z.number().int().positive().optional(),
  shmMb: z.number().int().positive().optional(),
});
export type ContainerLimits = z.infer<typeof ContainerLimitsSchema>;

const dropPayloadBase = {
  protocol: z.literal(1),
  dropId: z.string(),
  epoch: z.number(),
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }),
  issue: z.object({ number: z.number(), title: z.string(), body: z.string() }),
  branch: z.string(),
  gates: z.array(GateSpecSchema),
  model: z.string(),
  maxTurns: z.number(),
  promptVersion: z.string(),
  prompt: z.string(),
  image: z.string(),
  /** The trooper's pre-push guard: a change touching these paths is refused. */
  protectedPaths: z.array(z.string()),
  credentials: z.object({ claudeToken: z.string(), forgeToken: z.string().optional() }),
  /** Environment for gate steps only, never the agent. Redacted like every credential. */
  gateSecrets: z.record(z.string(), z.string()).optional(),
  services: z.array(ServiceSpecSchema).optional(),
  limits: ContainerLimitsSchema.optional(),
  verification: z.array(VerificationSpecSchema).optional(),
  /** `false` turns off Claude's commit and PR attribution for the agent. Absent keeps the default. */
  attribution: z.boolean().optional(),
};

/**
 * A crew drop: no issue, branch, gates, services or gate secrets. Strict, so a payload carrying any
 * of those is refused rather than stripped.
 */
const crewPayloadBase = {
  protocol: dropPayloadBase.protocol,
  dropId: dropPayloadBase.dropId,
  epoch: dropPayloadBase.epoch,
  repo: dropPayloadBase.repo,
  model: dropPayloadBase.model,
  maxTurns: dropPayloadBase.maxTurns,
  promptVersion: dropPayloadBase.promptVersion,
  prompt: dropPayloadBase.prompt,
  image: dropPayloadBase.image,
  protectedPaths: dropPayloadBase.protectedPaths,
  credentials: dropPayloadBase.credentials,
  limits: dropPayloadBase.limits,
  attribution: dropPayloadBase.attribution,
};

export const DropPayloadSchema = z.discriminatedUnion('role', [
  z.object({
    ...dropPayloadBase,
    role: z.literal('implement'),
    resume: z.boolean().default(false),
    /** Remote tip to continue from. */
    resumeSha: z.string().optional(),
  }),
  z.object({ ...dropPayloadBase, role: z.literal('review'), pr: PrRefSchema }),
  z.object({ ...dropPayloadBase, role: z.literal('heal'), pr: PrRefSchema, feedback: z.string() }),
  z.object({ ...dropPayloadBase, role: z.literal('resolve'), pr: PrRefSchema }),
  z.strictObject({ ...crewPayloadBase, role: z.literal('crew-lead') }),
  z.strictObject({ ...crewPayloadBase, role: z.literal('refute') }),
  z.strictObject({
    ...crewPayloadBase,
    role: z.literal('diagnose'),
    /** The parked PR to inspect, when there is one. */
    checkout: PrRefSchema.optional(),
  }),
]);
export type DropPayload = z.infer<typeof DropPayloadSchema>;
/** A drop for one work item: it has an issue, a branch and gates. */
export type ItemDropPayload = Exclude<DropPayload, { role: CrewRole }>;
export type CrewDropPayload = Extract<DropPayload, { role: CrewRole }>;

export const VerdictSchema = z.object({
  decision: z.enum(['approve', 'request_changes']),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(['blocker', 'major', 'minor']),
      file: z.string().optional(),
      detail: z.string(),
    }),
  ),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const MergeOutcomeSchema = z.enum(['clean', 'conflicts', 'up_to_date']);
export type MergeOutcome = z.infer<typeof MergeOutcomeSchema>;

const UsageWindowSchema = z.object({ utilization: z.number(), resetsAt: z.string().optional() });
export const RateLimitEventDataSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  resetsAt: z.string().optional(),
  rateLimitType: z.string().optional(),
  unifiedWindows: z
    .object({ five_hour: UsageWindowSchema.optional(), seven_day: UsageWindowSchema.optional() })
    .optional(),
  /** Unobserved field names, kept as sent (pending rehearsal). */
  isUsingOverage: z.boolean().optional(),
  overageStatus: z.string().optional(),
  /** When the extra-usage spending cap resets (monthly); never a usage window's reset. */
  overageResetsAt: z.string().optional(),
});
export type RateLimitEventData = z.infer<typeof RateLimitEventDataSchema>;

export const IMPLEMENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['COMPLETE', 'BLOCKED'] },
    summary: { type: 'string' },
  },
  required: ['status', 'summary'],
  additionalProperties: false,
} as const;

export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['approve', 'request_changes'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['severity', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['decision', 'summary', 'findings'],
  additionalProperties: false,
} as const;

const PRIORITIES = ['highest', 'high', 'low', 'lowest'] as const;

export const CrewLeadOutputSchema = z.strictObject({
  summary: z.string().max(4000),
  fileIssues: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z0-9-]{1,40}$/),
        objective: z.string().max(200),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(12000),
        priority: z.enum(PRIORITIES).optional(),
      }),
    )
    .max(5),
  briefings: z
    .array(
      z.strictObject({
        subject: z.string().max(80),
        decision: z.string().max(500),
        why: z.string().max(2000),
        options: z.array(z.string().max(200)).min(2).max(4),
        recommendation: z.string().max(1000),
        onHold: z.string().max(500),
      }),
    )
    .max(3),
});
export type CrewLeadOutput = z.infer<typeof CrewLeadOutputSchema>;

export const RefuteOutputSchema = z.strictObject({
  decision: z.enum(['promote', 'revise', 'reject']),
  findings: z.array(z.string().max(1000)).max(20),
  revisedTitle: z.string().min(1).max(120).optional(),
  revisedBody: z.string().min(1).max(12000).optional(),
});
export type RefuteOutput = z.infer<typeof RefuteOutputSchema>;

export const DiagnoseOutputSchema = z.strictObject({
  diagnosis: z.string().max(4000),
  recommendation: z.enum(['retry', 'leave_parked', 'needs_command']),
  detail: z.string().max(2000),
});
export type DiagnoseOutput = z.infer<typeof DiagnoseOutputSchema>;

const CREW_OUTPUT = {
  'crew-lead': CrewLeadOutputSchema,
  refute: RefuteOutputSchema,
  diagnose: DiagnoseOutputSchema,
} as const;

export type CrewOutput = {
  'crew-lead': CrewLeadOutput;
  refute: RefuteOutput;
  diagnose: DiagnoseOutput;
};

/** The `--json-schema` for a crew role; every object forbids additional properties. */
export function crewOutputJsonSchema(role: CrewRole): object {
  const { $schema: _drop, ...schema } = z.toJSONSchema(CREW_OUTPUT[role]) as Record<
    string,
    unknown
  >;
  return schema;
}

/** Validates a crew result on either side; the reason names the first failing field. */
export function parseCrewOutput<R extends CrewRole>(
  role: R,
  v: unknown,
): { ok: true; value: CrewOutput[R] } | { ok: false; reason: string } {
  const r = CREW_OUTPUT[role].safeParse(v);
  if (r.success) return { ok: true, value: r.data as CrewOutput[R] };
  const issue = r.error.issues[0];
  const path = issue?.path.join('.') || '(root)';
  return { ok: false, reason: `${path}: ${issue?.message ?? 'invalid'}` };
}

export const GateResultSchema = z.object({
  name: z.string(),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  /** Last 4000 characters of gate output. */
  outputTail: z.string().max(4000),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const TrooperEventSchema = z.object({
  ts: z.string(),
  kind: z.enum(['phase', 'agent', 'rate_limit', 'gate', 'log']),
  data: z.record(z.string(), z.unknown()),
});
export type TrooperEvent = z.infer<typeof TrooperEventSchema>;

/** Longest author report a result may carry; the trooper truncates to this. */
export const REPORT_MAX_CHARS = 8000;

export const DropResultSchema = z.object({
  status: z.enum(['completed', 'no_changes', 'blocked', 'failed', 'interrupted', 'rate_limited']),
  role: RoleSchema.optional(),
  verdict: VerdictSchema.optional(),
  mergeOutcome: MergeOutcomeSchema.optional(),
  rateLimit: RateLimitEventDataSchema.optional(),
  /** A crew role's structured output, validated per role on both sides (`parseCrewOutput`). */
  crew: z.unknown().optional(),
  /** The model that actually served the drop, when the trooper could tell. */
  servedModel: z.string().optional(),
  reason: z.string().optional(),
  headSha: z.string().optional(),
  /** The author's report (implement/heal): each acceptance criterion, how it is met, and evidence. */
  summary: z.string().max(REPORT_MAX_CHARS).optional(),
  gates: z.array(GateResultSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  numTurns: z.number().optional(),
});
export type DropResult = z.infer<typeof DropResultSchema>;
export { containsSecret, payloadSecrets, redact, redactTokenShapes } from './redact.js';

/**
 * The model that served a run: the `modelUsage` key with the most output tokens (the first on a
 * tie), or null when there is none to tell by.
 */
export function servedModel(modelUsage: unknown): string | null {
  if (typeof modelUsage !== 'object' || modelUsage === null) return null;
  let best: string | null = null;
  let most = -1;
  for (const [model, usage] of Object.entries(modelUsage)) {
    const out = (usage as { outputTokens?: unknown } | null)?.outputTokens;
    const n = typeof out === 'number' ? out : 0;
    if (n > most) {
      best = model;
      most = n;
    }
  }
  return best;
}
