import { z } from 'zod';

export const EVENT_PREFIX = 'JM_EVENT ';
export const RESULT_PREFIX = 'JM_RESULT ';

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

export const RoleSchema = z.enum(['implement', 'review', 'heal', 'resolve']);
export type Role = z.infer<typeof RoleSchema>;

export const PrRefSchema = z.object({
  number: z.number(),
  branch: z.string(),
  headSha: z.string(),
});
export type PrRef = z.infer<typeof PrRefSchema>;

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
]);
export type DropPayload = z.infer<typeof DropPayloadSchema>;

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

export const DropResultSchema = z.object({
  status: z.enum(['completed', 'no_changes', 'blocked', 'failed', 'interrupted', 'rate_limited']),
  role: RoleSchema.optional(),
  verdict: VerdictSchema.optional(),
  mergeOutcome: MergeOutcomeSchema.optional(),
  rateLimit: RateLimitEventDataSchema.optional(),
  reason: z.string().optional(),
  headSha: z.string().optional(),
  gates: z.array(GateResultSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  numTurns: z.number().optional(),
});
export type DropResult = z.infer<typeof DropResultSchema>;
