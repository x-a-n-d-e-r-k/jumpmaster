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

export const DropPayloadSchema = z.object({
  protocol: z.literal(1),
  dropId: z.string(),
  epoch: z.number(),
  role: z.literal('implement'),
  repo: z.object({ owner: z.string(), name: z.string(), defaultBranch: z.string() }),
  issue: z.object({ number: z.number(), title: z.string(), body: z.string() }),
  branch: z.string(),
  gates: z.array(GateSpecSchema),
  model: z.string(),
  maxTurns: z.number(),
  promptVersion: z.string(),
  prompt: z.string(),
  credentials: z.object({ claudeToken: z.string(), forgeToken: z.string() }),
});
export type DropPayload = z.infer<typeof DropPayloadSchema>;

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
  status: z.enum(['completed', 'no_changes', 'blocked', 'failed']),
  reason: z.string().optional(),
  headSha: z.string().optional(),
  gates: z.array(GateResultSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  numTurns: z.number().optional(),
});
export type DropResult = z.infer<typeof DropResultSchema>;
