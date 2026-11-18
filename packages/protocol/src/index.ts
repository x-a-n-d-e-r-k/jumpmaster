import { basename, matchesGlob } from 'node:path';
import { z } from 'zod';
import {
  MAX_TRIAGE_IMAGES,
  MAX_TRIAGE_IMAGES_SKIPPED,
  TriageImageSchema,
  TriageImageSkippedSchema,
} from './media.js';
import { isOwnerName, isRepoName } from './names.js';

export const EVENT_PREFIX = 'JM_EVENT ';
/** One part of an event too large for a single `JM_EVENT ` line. */
export const EVENT_PART_PREFIX = 'JM_EVENT_PART ';
/** A serialized event at or under this size goes out as one `JM_EVENT ` line. */
export const MAX_EVENT_LINE_BYTES = 63 * 1024;
/** The largest serialized event, sent in parts: a bigger one keeps its first 2 MiB. */
export const MAX_EVENT_BYTES = 2 * 1024 * 1024;
/** The bytes of a serialized event one part carries, before base64. */
export const EVENT_PART_BYTES = 45 * 1024;
/** The most parts one event can take. */
export const MAX_EVENT_PARTS = Math.ceil(MAX_EVENT_BYTES / EVENT_PART_BYTES);
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

/** Segment-leading dots made plain, so `**` and `*` also cover dotfiles (`node_modules/.bin`). */
const undot = (s: string): string => s.replace(/(^|\/)\./g, '$1\u0001');

/**
 * Whether a changed path falls under a protected glob. The one matcher for the trooper's push
 * check and the server's review check, so the two always agree: `pathMatches`, and the same with
 * dotfiles visible to `*` and `**`.
 */
export function protectedPathMatches(p: string, glob: string): boolean {
  return pathMatches(p, glob) || pathMatches(undot(p), undot(glob));
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

/** Prebuilt trooper images, one per stack. The base trooper image doubles as `node`. */
export const PRESETS = ['node', 'python', 'go', 'jvm'] as const;
export type Preset = (typeof PRESETS)[number];
export const PresetSchema = z.enum(PRESETS);

/**
 * What a stick can enforce. A stick advertises a capability only once its code really does it,
 * and the server never leases it a drop from a zone that needs one it lacks.
 */
export const STICK_CAPABILITIES = ['egress-v1', 'image-verify-v1', 'push-v1'] as const;
export type StickCapability = (typeof STICK_CAPABILITIES)[number];
export const ImagePolicySchema = z.enum(['allowlist', 'signed']);
export type ImagePolicy = z.infer<typeof ImagePolicySchema>;

/**
 * Sent with every enroll and lease. Every field has a default, so an M3 stick (which sends none)
 * is a stick with no capabilities under the allowlist policy. `pinnedImages` are the stick's
 * digest pins: not secrets, sent so the doctor can check service images.
 */
export const StickInfoSchema = z.object({
  capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
  imagePolicy: ImagePolicySchema.default('allowlist'),
  version: z.string().min(1).max(64).optional(),
  pinnedImages: z.array(z.string().min(1).max(512)).max(256).default([]),
});
export type StickInfo = z.infer<typeof StickInfoSchema>;

/** A zone the lease passed over for this stick, and what the stick lacks for it. */
export const LeaseSkipSchema = z.object({ zoneId: z.string(), missing: z.array(z.string()) });
export type LeaseSkip = z.infer<typeof LeaseSkipSchema>;
/**
 * The lease response header naming skipped zones (URI-encoded JSON `LeaseSkip[]`). A header, so
 * it rides on a 204 too and an M3 stick ignores it.
 */
export const SKIPPED_HEADER = 'x-jumpmaster-skipped';

/**
 * The lease response header carrying how many troopers the server wants this stick to run at
 * once (an integer of 1 or more), on a 200 and a 204 alike. A stick caps it at its own ceiling
 * (`maxSlots` in the lease body); a stick that never sees it keeps its `JM_SLOTS`.
 */
export const SLOTS_HEADER = 'x-jumpmaster-slots';

/** Roles that work for the zone rather than one work item. They hold no forge write credential. */
export const CREW_ROLES = ['crew-lead', 'refute', 'diagnose', 'triage'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
export const isCrewRole = (r: string): r is CrewRole =>
  (CREW_ROLES as readonly string[]).includes(r);

/**
 * `doctor` proves a zone's setup on request: the Claude token, the clone, services and gates on the
 * default branch. Like a crew role it has no work item, but it is not crew: it never runs an agent
 * with tools, and it holds no forge write credential either.
 */
export const RoleSchema = z.enum([
  'implement',
  'review',
  'heal',
  'resolve',
  ...CREW_ROLES,
  'doctor',
]);
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

/**
 * Egress control for a drop. Absent when the zone's mode is `off`. The trooper derives its proxy
 * (the fixed `EGRESS_PROXY_URL`) from its presence; the stick runs the proxy with `allow`.
 */
export const EgressPayloadSchema = z.object({
  mode: z.enum(['monitor', 'enforce']),
  allow: z.array(z.string()),
});
export type EgressPayload = z.infer<typeof EgressPayloadSchema>;

/** A GitHub owner login; the error names the field, never the value. */
export const OwnerNameSchema = z
  .string()
  .refine(isOwnerName, { message: 'owner is not a valid GitHub owner name' });
/** A GitHub repository name; the error names the field, never the value. */
export const RepoNameSchema = z
  .string()
  .refine(isRepoName, { message: 'name is not a valid GitHub repository name' });

const dropPayloadBase = {
  protocol: z.literal(1),
  dropId: z.string(),
  epoch: z.number(),
  repo: z.object({ owner: OwnerNameSchema, name: RepoNameSchema, defaultBranch: z.string() }),
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
  /** Globs where the pre-push check lets a real private key through. Absent: none. */
  privateKeyPaths: z.array(z.string()).optional(),
  credentials: z.object({ claudeToken: z.string(), forgeToken: z.string().optional() }),
  /** Environment for gate steps only, never the agent. Redacted like every credential. */
  gateSecrets: z.record(z.string(), z.string()).optional(),
  /** `false`: gates run with CI=false instead of CI=true. Absent keeps CI=true. */
  gateCi: z.boolean().optional(),
  services: z.array(ServiceSpecSchema).optional(),
  limits: ContainerLimitsSchema.optional(),
  verification: z.array(VerificationSpecSchema).optional(),
  /** `false` turns off Claude's commit and PR attribution for the agent. Absent keeps the default. */
  attribution: z.boolean().optional(),
  egress: EgressPayloadSchema.optional(),
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
  privateKeyPaths: dropPayloadBase.privateKeyPaths,
  credentials: dropPayloadBase.credentials,
  limits: dropPayloadBase.limits,
  attribution: dropPayloadBase.attribution,
  egress: dropPayloadBase.egress,
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
    role: z.literal('triage'),
    /** The issue's images, fetched and checked by the server (0..4), each checked again here. */
    images: z.array(TriageImageSchema).max(MAX_TRIAGE_IMAGES).optional(),
    /** One entry per image URL that was not fetched, with a short reason. */
    imagesSkipped: z.array(TriageImageSkippedSchema).max(MAX_TRIAGE_IMAGES_SKIPPED).optional(),
  }),
  z.strictObject({
    ...crewPayloadBase,
    role: z.literal('diagnose'),
    /** The parked PR to inspect, when there is one. */
    checkout: PrRefSchema.optional(),
  }),
  /**
   * A doctor drop: the zone's real image, gates, services and egress, on the default branch. Strict
   * and with its own credentials shape, so a write token, an issue or a branch is refused.
   */
  z.strictObject({
    protocol: dropPayloadBase.protocol,
    dropId: dropPayloadBase.dropId,
    epoch: dropPayloadBase.epoch,
    role: z.literal('doctor'),
    repo: dropPayloadBase.repo,
    model: dropPayloadBase.model,
    image: dropPayloadBase.image,
    gates: dropPayloadBase.gates,
    services: dropPayloadBase.services,
    limits: dropPayloadBase.limits,
    gateSecrets: dropPayloadBase.gateSecrets,
    gateCi: dropPayloadBase.gateCi,
    egress: dropPayloadBase.egress,
    /** At most the read token, for a private repository's clone. Never a write token. */
    credentials: z.strictObject({
      claudeToken: z.string(),
      readToken: z.string().optional(),
      /** Never present: any value is refused. Declared so `credentials.forgeToken` reads as absent. */
      forgeToken: z.never().optional(),
    }),
  }),
]);
export type DropPayload = z.infer<typeof DropPayloadSchema>;
/** A drop for one work item: it has an issue, a branch and gates. */
export type ItemDropPayload = Exclude<DropPayload, { role: CrewRole | 'doctor' }>;
export type CrewDropPayload = Extract<DropPayload, { role: CrewRole }>;
export type DoctorDropPayload = Extract<DropPayload, { role: 'doctor' }>;

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

/** A usage window's key as the account reports it: `five_hour`, `seven_day`, `seven_day_fable`... */
export const USAGE_WINDOW_KEY = /^[a-z0-9_]{1,40}$/;
const IsoSchema = z.iso.datetime({ offset: true });
export const UsageWindowSchema = z.object({
  utilization: z.number().min(0).max(1),
  resetsAt: IsoSchema.optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type UsageWindows = Record<string, UsageWindow>;

const isoOnly = (v: unknown): string | undefined =>
  IsoSchema.safeParse(v).success ? (v as string) : undefined;

/**
 * Every valid window of a reported `unifiedWindows` object (#144). A key not matching
 * USAGE_WINDOW_KEY, or a utilization outside 0..1, drops that window; a reset time that
 * `normalize` cannot make an ISO timestamp drops only the reset. Never throws.
 */
export function usageWindowsOf(
  v: unknown,
  normalize: (resetsAt: unknown) => string | undefined = isoOnly,
): UsageWindows | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: UsageWindows = {};
  for (const [key, w] of Object.entries(v as Record<string, unknown>)) {
    if (!USAGE_WINDOW_KEY.test(key) || typeof w !== 'object' || w === null) continue;
    const raw = w as Record<string, unknown>;
    const resetsAt = isoOnly(normalize(raw.resetsAt ?? raw.resets_at));
    const parsed = UsageWindowSchema.safeParse({
      utilization: raw.utilization,
      ...(resetsAt ? { resetsAt } : {}),
    });
    if (parsed.success) out[key] = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const RateLimitEventDataSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  resetsAt: z.string().optional(),
  rateLimitType: z.string().optional(),
  /** Every window the account reports, keyed as reported; bad entries are dropped, not refused. */
  unifiedWindows: z
    .preprocess((v) => usageWindowsOf(v), z.record(z.string(), UsageWindowSchema).optional())
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
  /**
   * The current objective, reported finished: the server raises a briefing whose "Mark it done"
   * ruling records it done. The key is a goal key (at most 60 characters, as the server slugs).
   */
  objectiveDone: z
    .strictObject({
      key: z.string().regex(/^[a-z0-9-]{1,60}$/),
      why: z.string().max(2000),
    })
    .optional(),
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

const TriageOutputObject = z.strictObject({
  summary: z.string().max(4000),
  outcome: z.enum(['split', 'questions', 'not-agent-work']),
  children: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z0-9-]{1,40}$/),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(12000),
        priority: z.enum(PRIORITIES).optional(),
      }),
    )
    .max(5)
    .optional(),
  briefing: z
    .strictObject({
      subject: z.string().max(80),
      decision: z.string().max(500),
      why: z.string().max(2000),
      options: z.array(z.string().max(200)).min(2).max(4),
      recommendation: z.string().max(1000),
      onHold: z.string().max(500),
    })
    .optional(),
  reason: z.string().max(500).optional(),
});

/**
 * A triage drop's verdict on one issue. `split` carries 1..5 children and nothing else,
 * `questions` a briefing and nothing else, `not-agent-work` a reason and nothing else.
 */
export const TriageOutputSchema = TriageOutputObject.superRefine((v, ctx) => {
  const children = v.children?.length ?? 0;
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.outcome === 'split') {
    if (children < 1) fail('children', 'split needs 1 to 5 children');
    if (v.briefing !== undefined) fail('briefing', 'split carries no briefing');
    if (v.reason !== undefined) fail('reason', 'split carries no reason');
  } else if (v.outcome === 'questions') {
    if (v.briefing === undefined) fail('briefing', 'questions needs a briefing');
    if (children > 0) fail('children', 'questions carries no children');
    if (v.reason !== undefined) fail('reason', 'questions carries no reason');
  } else {
    if (v.reason === undefined) fail('reason', 'not-agent-work needs a reason');
    if (children > 0) fail('children', 'not-agent-work carries no children');
    if (v.briefing !== undefined) fail('briefing', 'not-agent-work carries no briefing');
  }
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

const CREW_OUTPUT = {
  'crew-lead': CrewLeadOutputSchema,
  refute: RefuteOutputSchema,
  diagnose: DiagnoseOutputSchema,
  triage: TriageOutputSchema,
} as const;

export type CrewOutput = {
  'crew-lead': CrewLeadOutput;
  refute: RefuteOutput;
  diagnose: DiagnoseOutput;
  triage: TriageOutput;
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
  kind: z.enum(['phase', 'agent', 'rate_limit', 'gate', 'log', 'egress']),
  data: z.record(z.string(), z.unknown()),
});
export type TrooperEvent = z.infer<typeof TrooperEventSchema>;

/** Part `n` of `of` of event `id` (a per-drop counter): a base64 slice of the serialized event. */
export const EventPartSchema = z.object({
  id: z.number().int().nonnegative(),
  n: z.number().int().positive(),
  of: z.number().int().positive().max(MAX_EVENT_PARTS),
  chunk: z.string().max(Math.ceil(EVENT_PART_BYTES / 3) * 4),
});
export type EventPart = z.infer<typeof EventPartSchema>;

/** What a doctor drop found. Every error text is redacted by the trooper before it is sent. */
export const DoctorResultSchema = z.object({
  claude: z.object({
    ok: z.boolean(),
    servedModel: z.string().optional(),
    error: z.string().max(1000).optional(),
  }),
  clone: z.object({
    ok: z.boolean(),
    sha: z.string().optional(),
    error: z.string().max(1000).optional(),
  }),
  services: z.array(z.object({ name: z.string(), ok: z.boolean() })),
  gates: z.array(GateResultSchema),
});
export type DoctorResult = z.infer<typeof DoctorResultSchema>;

/** Longest author report a result may carry; the trooper truncates to this. */
export const REPORT_MAX_CHARS = 8000;

/** A full lowercase 40-hex commit SHA: never a ref name or an option. */
export const sha40 = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-hex commit SHA');

/**
 * Whether `name` is a branch name that is safe on root git's command line: what `git
 * check-ref-format --branch` accepts, and never one that starts with `-` (an option).
 */
export function isSafeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255 || name === '@') return false;
  // Controls, space, DEL, and git's reserved ref characters.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (/^[-/]|[/.]$|\.\.|\/\/|@\{/.test(name)) return false;
  return name.split('/').every((c) => !c.startsWith('.') && !c.endsWith('.lock'));
}

/** A branch name that passes `isSafeBranchName`. */
export const BranchNameSchema = z
  .string()
  .refine(isSafeBranchName, 'a branch name git accepts that does not start with "-"');

/**
 * What the agent container asks the push container to do with its work. `final` pushes the tip it
 * names; `checkpoint` pushes whatever the volume holds. Salvage comes only from the server.
 */
export const PushRequestSchema = z
  .object({ kind: z.enum(['final', 'checkpoint']), expectSha: sha40.optional() })
  .refine((p) => (p.kind === 'final') === (p.expectSha !== undefined), {
    message: 'final requires expectSha and checkpoint forbids it',
  });
export type PushRequest = z.infer<typeof PushRequestSchema>;

export const DropResultSchema = z.object({
  /** Asks for the work on the volume to be pushed by the push container. */
  push: PushRequestSchema.optional(),
  status: z.enum(['completed', 'no_changes', 'blocked', 'failed', 'interrupted', 'rate_limited']),
  role: RoleSchema.optional(),
  verdict: VerdictSchema.optional(),
  mergeOutcome: MergeOutcomeSchema.optional(),
  rateLimit: RateLimitEventDataSchema.optional(),
  /** A crew role's structured output, validated per role on both sides (`parseCrewOutput`). */
  crew: z.unknown().optional(),
  /** A doctor drop's findings. */
  doctor: DoctorResultSchema.optional(),
  /** The model that actually served the drop, when the trooper could tell. */
  servedModel: z.string().optional(),
  reason: z.string().optional(),
  /** The commit the run ended on. Never anything else: it can become a later push's lease. */
  headSha: sha40.optional(),
  /** The author's report (implement/heal): each acceptance criterion, how it is met, and evidence. */
  summary: z.string().max(REPORT_MAX_CHARS).optional(),
  gates: z.array(GateResultSchema),
  usage: z.record(z.string(), z.unknown()).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  numTurns: z.number().optional(),
});
export type DropResult = z.infer<typeof DropResultSchema>;
export * from './egress.js';
export * from './media.js';
export * from './names.js';
export {
  containsSecret,
  dropSecrets,
  findPrivateKeys,
  type PrivateKeyBlock,
  payloadSecrets,
  REAL_KEY_BODY_CHARS,
  redact,
  redactTokenShapes,
  withBasicAuth,
} from './redact.js';
export { CREDENTIAL_FILES, MAX_SECRET_FILE_BYTES, readSecret, readSecretFile } from './secrets.js';

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

/** The roles whose work is pushed to a branch, by the push container. */
export const PUSHING_ROLES: readonly Role[] = ['implement', 'heal', 'resolve'];

export function isPushingRole(role: Role): boolean {
  return PUSHING_ROLES.includes(role);
}

/**
 * Whether the push a result asks for is one its role may ask for. A result without a push request
 * has nothing to refuse. `final` needs a completed run whose head is the SHA named; `checkpoint`
 * needs an interrupted or rate-limited run, and resolve never checkpoints.
 */
export function pushRequestValid(result: DropResult, role: Role): boolean {
  const push = result.push;
  if (push === undefined) return true;
  if (!PUSHING_ROLES.includes(role)) return false;
  if (push.kind === 'final') {
    return result.status === 'completed' && result.headSha === push.expectSha;
  }
  return (
    role !== 'resolve' && (result.status === 'interrupted' || result.status === 'rate_limited')
  );
}

/** The one line the push container prints, alone, once its volume is mounted and it is ready. */
export const READY_LINE = 'JM_READY';

/** The response header through which the server announces the features it supports. */
export const FEATURES_HEADER = 'x-jumpmaster-features';

/** The feature a server announces once it has an image lock to mirror for sticks (issue #141). */
export const IMAGE_MIRROR_FEATURE = 'image-mirror-v1';

/**
 * A stick's image download from the server (issue #141), carried on its lease calls: bytes done
 * and bytes total. `null` says no download is in progress.
 */
export const ImageFetchSchema = z.object({
  ref: z.string().min(1).max(512),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type ImageFetch = z.infer<typeof ImageFetchSchema>;

/**
 * A stick still running its first health check (issue #157), which pulls `image` and can take
 * minutes on a cold cache: carried on its no-free-slot lease calls until the check has a result.
 * `null` says the check has finished. A sibling of `ImageFetch`, not a reuse of it: there are no
 * bytes to count.
 */
export const StickStartingSchema = z.object({
  image: z.string().min(1).max(512),
});
export type StickStarting = z.infer<typeof StickStartingSchema>;

/** The push container's payload. Strict, and carries no token: the grant arrives after ready. */
export const PushPayloadSchema = z
  .object({
    protocol: z.literal(1),
    role: z.literal('push'),
    dropId: dropPayloadBase.dropId,
    epoch: dropPayloadBase.epoch,
    branch: z.string().min(1),
    salvage: z.boolean(),
    /**
     * Set when the container runs on a drop network behind the egress proxy, its only route out:
     * the trooper then routes git through the proxy.
     */
    egress: z.literal(true).optional(),
  })
  .strict();
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/** What the stick learns from the server before it starts a push container. */
export const PushPlanSchema = z
  .object({
    branch: z.string().min(1),
    salvage: z.boolean(),
    limits: ContainerLimitsSchema.optional(),
    egress: EgressPayloadSchema.optional(),
  })
  .strict();
export type PushPlan = z.infer<typeof PushPlanSchema>;

/** The credential and rules for one push, handed over only after the container reports ready. */
export const PushGrantSchema = z
  .object({
    token: z.string().min(1),
    owner: OwnerNameSchema,
    name: RepoNameSchema,
    branch: BranchNameSchema,
    base: BranchNameSchema,
    /** The SHA the remote branch must still be at, or empty for a new branch. */
    lease: z.union([sha40, z.literal('')]),
    expectSha: sha40.optional(),
    protectedPaths: z.array(z.string()),
    /** Globs where a real private key may be pushed (fixtures). Absent: none. */
    privateKeyPaths: z.array(z.string()).optional(),
    secrets: z.array(z.string()),
  })
  .strict();
export type PushGrant = z.infer<typeof PushGrantSchema>;

export const PushResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pushed'), headSha: sha40, alreadyThere: z.boolean() }),
  z.object({ status: z.literal('failed'), reason: z.string().max(2000), retryable: z.boolean() }),
  z.object({ status: z.literal('nothing'), reason: z.string().max(2000) }),
]);
export type PushResult = z.infer<typeof PushResultSchema>;
