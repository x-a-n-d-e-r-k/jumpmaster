import { basename, matchesGlob } from 'node:path';
import { z } from 'zod';
import {
  MAX_TRIAGE_IMAGES,
  MAX_TRIAGE_IMAGES_SKIPPED,
  TriageImageSchema,
  TriageImageSkippedSchema,
} from './media.js';
import { isGitLabProjectPath, isOwnerName, isRepoName } from './names.js';
import { RateLimitEventDataSchema } from './usage.js';

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
export const STICK_CAPABILITIES = [
  'clone-v1',
  'egress-v1',
  'image-verify-v1',
  'push-v1',
  'upgrade-v1',
] as const;
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
  /**
   * The stick's egress ceiling (`JM_EGRESS_CEILING`, issue #780), base hosts included, or null
   * when it has none. An older stick sends none: no ceiling. The server only reads it, to leave
   * drops outside it queued; the stick's own check stays the control.
   */
  egressCeiling: z.array(z.string().min(1).max(255)).max(256).nullable().default(null),
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

/** A release version: `X.Y.Z` or `X.Y.Z-rc.N`; `rc` null for a final release. */
export type ReleaseVersion = { major: number; minor: number; patch: number; rc: number | null };

const RELEASE_VERSION =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:-rc\.(0|[1-9][0-9]{0,8}))?$/;

/** `X.Y.Z` or `X.Y.Z-rc.N` (no `v`), or null for anything else. */
export function parseReleaseVersion(v: string): ReleaseVersion | null {
  const m = RELEASE_VERSION.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4]),
  };
}

/** Semver order on release versions: `X.Y.Z-rc.N` < `X.Y.Z`, and `rc.N` < `rc.M` when N < M. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc - b.rc;
}

/** Whether `v` is a release version (`0.0.0-dev`, `dev` and `unknown` are not). */
export const isReleaseVersion = (v: unknown): v is string =>
  typeof v === 'string' && parseReleaseVersion(v) !== null;

/**
 * The lease response header offering the stick an upgrade to the server's own release (issue
 * #427): compact JSON `UpgradeOffer`. While it rides on an answer the stick is leased no new drop.
 * The server only names a version and a digest: the stick verifies the image and decides.
 */
export const UPGRADE_HEADER = 'x-jumpmaster-upgrade';

/** `<registry>/jumpmaster-stick@sha256:<64 hex>`, the registry as the image lock writes it. */
const STICK_IMAGE_REF =
  /^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)*\/jumpmaster-stick@sha256:[0-9a-f]{64}$/;

export const UpgradeOfferSchema = z.object({
  version: z.string().max(64).refine(isReleaseVersion, 'not a release version'),
  image: z.string().max(512).regex(STICK_IMAGE_REF, 'not a jumpmaster-stick digest reference'),
});
export type UpgradeOffer = z.infer<typeof UpgradeOfferSchema>;

/** The stick's report of its last upgrade attempt, on the lease body (`upgrade`). */
export const UpgradeReportSchema = z.object({
  version: z.string().min(1).max(64),
  result: z.enum(['ok', 'failed', 'refused']),
  reason: z.string().max(500).optional(),
});
export type UpgradeReport = z.infer<typeof UpgradeReportSchema>;

/** Roles that work for the zone rather than one work item. They hold no forge write credential. */
export const CREW_ROLES = [
  'crew-lead',
  'refute',
  'diagnose',
  'triage',
  'arbitrate',
  'audit',
] as const;
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

/**
 * Whether `origin` is a bare `https://` origin: a host and an optional port, with no userinfo,
 * path, query, fragment or trailing slash. It must equal its own parsed origin, so anything the
 * URL parser would normalise (case, a default port, a trailing dot of a path) is refused.
 */
function isHttpsOrigin(origin: string): boolean {
  if (!origin.startsWith('https://')) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname !== '' &&
    u.username === '' &&
    u.password === '' &&
    u.origin === origin
  );
}

/**
 * The forge remote a drop clones from and a push grant pushes to, when it is not GitHub. With it,
 * the trooper's remote URL is `<origin>/<projectPath>.git` and its auth scope `<origin>/`; the
 * repo's `owner` and `name` then name nothing on the wire.
 */
export const ForgeRemoteSchema = z.strictObject({
  kind: z.literal('gitlab'),
  origin: z.string().refine(isHttpsOrigin, { message: 'origin is not a bare https:// origin' }),
  projectPath: z
    .string()
    .refine(isGitLabProjectPath, { message: 'projectPath is not a valid GitLab project path' }),
});
export type ForgeRemote = z.infer<typeof ForgeRemoteSchema>;

const dropPayloadBase = {
  protocol: z.literal(1),
  dropId: z.string(),
  epoch: z.number(),
  repo: z.object({
    owner: OwnerNameSchema,
    name: RepoNameSchema,
    defaultBranch: z.string(),
    /** A GitLab remote: the clone goes there, not to github.com/<owner>/<name>. */
    forge: ForgeRemoteSchema.optional(),
    /**
     * `provided`: a clone container has already cloned the repo into the drop's workspace, so the
     * trooper uses that mirror and fetches nothing with a token. Absent: the trooper clones.
     */
    mirror: z.literal('provided').optional(),
  }),
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
  z.strictObject({ ...crewPayloadBase, role: z.literal('audit') }),
  z.strictObject({
    ...crewPayloadBase,
    role: z.literal('arbitrate'),
    /** The pull request in dispute, when the arbitration is about a work item's review. */
    checkout: PrRefSchema.optional(),
  }),
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
        /**
         * The key of a rejected crew issue this one files again in corrected form (#784): the
         * server lifts the 7-day duplicate-title refusal only for a valid replacement.
         */
        replaces: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .optional(),
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
  /**
   * A proposed new text for the zone's goal file, and why: the server records it and raises a
   * briefing whose "Open the PR" ruling opens it as a pull request. Merging it still needs the
   * owner's confirmation in the browser.
   */
  goalChange: z
    .strictObject({
      text: z.string().min(1).max(64_000),
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

/** The most pull requests and issues an `already-done` triage verdict or an `already_done` diagnosis may cite, in all. */
export const MAX_TRIAGE_EVIDENCE = 10;

export const DiagnoseOutputSchema = z
  .strictObject({
    diagnosis: z.string().max(4000),
    recommendation: z.enum([
      'retry',
      'leave_parked',
      'needs_command',
      'rerun_checks',
      'already_done',
    ]),
    detail: z.string().max(2000),
    /** With `retry`: the one concrete change the next attempt must make. The server may act on it. */
    instruction: z.string().min(1).max(2000).optional(),
    /**
     * With `rerun_checks` (#420): the failed checks on the PR's head to run again, by name. The
     * server re-runs only those it reads as failed on the current head.
     */
    checks: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    /**
     * With `retry` on a gate-change park (#420): the instruction removes the gate change. Without
     * it, the server never retries a gate-change park; the change stays the owner's to allow.
     */
    gateChange: z.literal('remove').optional(),
    /**
     * With `already_done` only (#536): the merged pull requests and the issues closed as completed
     * that did the work. The server verifies each before anything is written to the forge.
     */
    evidence: z
      .strictObject({
        pulls: z.array(z.number().int().positive()).max(MAX_TRIAGE_EVIDENCE).optional(),
        issues: z.array(z.number().int().positive()).max(MAX_TRIAGE_EVIDENCE).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.recommendation === 'rerun_checks' && (v.checks?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', path: ['checks'], message: 'rerun_checks needs checks' });
    }
    const evidence = (v.evidence?.pulls?.length ?? 0) + (v.evidence?.issues?.length ?? 0);
    const fail = (message: string) => ctx.addIssue({ code: 'custom', path: ['evidence'], message });
    if (v.recommendation === 'already_done') {
      if (evidence < 1) fail('already_done needs at least one pull or issue');
      if (evidence > MAX_TRIAGE_EVIDENCE)
        fail(`already_done cites at most ${MAX_TRIAGE_EVIDENCE} items`);
    } else if (v.evidence !== undefined) {
      fail(`${v.recommendation} carries no evidence`);
    }
  });
export type DiagnoseOutput = z.infer<typeof DiagnoseOutputSchema>;

/**
 * An arbiter's ruling on a contested decision between positions A and B. `reversible` is false
 * when acting on it could not be undone by reverting a commit; `productQuestion` is true when the
 * dispute is what the product should do, not how.
 */
export const ArbitrateOutputSchema = z.strictObject({
  ruling: z.enum(['A', 'B', 'insufficient_evidence']),
  because: z.string().max(4000),
  wouldReverse: z.string().max(1000),
  reversible: z.boolean(),
  productQuestion: z.boolean(),
  instruction: z.string().max(2000),
});
export type ArbitrateOutput = z.infer<typeof ArbitrateOutputSchema>;

const TriageOutputObject = z.strictObject({
  summary: z.string().max(4000),
  outcome: z.enum(['split', 'questions', 'not-agent-work', 'already-done']),
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
  /**
   * With `already-done` only: the merged pull requests and the issues closed as completed that
   * did the work. The server verifies each before anything is written to the forge (#466).
   */
  evidence: z
    .strictObject({
      pulls: z.array(z.number().int().positive()).max(MAX_TRIAGE_EVIDENCE).optional(),
      issues: z.array(z.number().int().positive()).max(MAX_TRIAGE_EVIDENCE).optional(),
    })
    .optional(),
});

/**
 * A triage drop's verdict on one issue. `split` carries 1..5 children and nothing else,
 * `questions` a briefing and nothing else, `not-agent-work` a reason and nothing else,
 * `already-done` a reason and 1..10 evidence entries and nothing else.
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
    if (v.reason === undefined) fail('reason', `${v.outcome} needs a reason`);
    if (children > 0) fail('children', `${v.outcome} carries no children`);
    if (v.briefing !== undefined) fail('briefing', `${v.outcome} carries no briefing`);
  }
  const evidence = (v.evidence?.pulls?.length ?? 0) + (v.evidence?.issues?.length ?? 0);
  if (v.outcome === 'already-done') {
    if (evidence < 1) fail('evidence', 'already-done needs at least one pull or issue');
    if (evidence > MAX_TRIAGE_EVIDENCE)
      fail('evidence', `already-done cites at most ${MAX_TRIAGE_EVIDENCE} items`);
  } else if (v.evidence !== undefined) {
    fail('evidence', `${v.outcome} carries no evidence`);
  }
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

/**
 * An audit of one merged commit. `refuted` carries exactly one fix-forward issue with the
 * evidence; `holds` carries none.
 */
export const AuditOutputSchema = z
  .strictObject({
    verdict: z.enum(['holds', 'refuted']),
    findings: z.array(z.string().max(1000)).max(20),
    issue: z
      .strictObject({
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(12000),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.verdict === 'refuted' && v.issue === undefined)
      ctx.addIssue({ code: 'custom', path: ['issue'], message: 'refuted needs an issue' });
    if (v.verdict === 'holds' && v.issue !== undefined)
      ctx.addIssue({ code: 'custom', path: ['issue'], message: 'holds carries no issue' });
  });
export type AuditOutput = z.infer<typeof AuditOutputSchema>;

const CREW_OUTPUT = {
  'crew-lead': CrewLeadOutputSchema,
  refute: RefuteOutputSchema,
  diagnose: DiagnoseOutputSchema,
  triage: TriageOutputSchema,
  arbitrate: ArbitrateOutputSchema,
  audit: AuditOutputSchema,
} as const;

export type CrewOutput = {
  'crew-lead': CrewLeadOutput;
  refute: RefuteOutput;
  diagnose: DiagnoseOutput;
  triage: TriageOutput;
  arbitrate: ArbitrateOutput;
  audit: AuditOutput;
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
export * from './chat.js';
export * from './egress.js';
export * from './media.js';
export * from './names.js';
export {
  containsSecret,
  dropSecrets,
  findJwtShape,
  findPrivateKeys,
  gitlabBasicAuth,
  gitlabBasicAuthAs,
  type PrivateKeyBlock,
  payloadSecrets,
  REAL_KEY_BODY_CHARS,
  redact,
  redactTokenShapes,
  replaceJwtShapes,
  withBasicAuth,
} from './redact.js';
export { CREDENTIAL_FILES, MAX_SECRET_FILE_BYTES, readSecret, readSecretFile } from './secrets.js';
export * from './strings.js';
export * from './usage.js';

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
    /** A GitLab remote: the push goes there, not to github.com/<owner>/<name>. */
    forge: ForgeRemoteSchema.optional(),
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

/**
 * The clone container's payload: it clones a GitLab zone's private project for a drop, and no
 * agent runs in it. Strict, and carries no token: the grant arrives after ready.
 */
export const ClonePayloadSchema = z
  .object({
    protocol: z.literal(1),
    role: z.literal('clone'),
    dropId: dropPayloadBase.dropId,
    epoch: dropPayloadBase.epoch,
    /** As on the push payload: set when the container's only route out is the egress proxy. */
    egress: z.literal(true).optional(),
  })
  .strict();
export type ClonePayload = z.infer<typeof ClonePayloadSchema>;

/** What the stick learns from the server before it starts a clone container. Holds no secret. */
export const ClonePlanSchema = z
  .object({
    forge: ForgeRemoteSchema,
    limits: ContainerLimitsSchema.optional(),
    egress: EgressPayloadSchema.optional(),
    /** The most bytes the clone may take on disk. */
    maxBytes: z.number().int().positive(),
  })
  .strict();
export type ClonePlan = z.infer<typeof ClonePlanSchema>;

/** The read credential for one clone, handed over only after the container reports ready. */
export const CloneGrantSchema = z
  .object({
    token: z.string().min(1),
    /**
     * The git basic-auth username: a GitLab deploy token's own username, which GitLab requires for
     * one. Absent: `oauth2`.
     */
    username: z
      .string()
      .min(1)
      .refine((u) => !u.includes(':'), { message: 'username must not contain ":"' })
      .optional(),
    forge: ForgeRemoteSchema,
    secrets: z.array(z.string()),
  })
  .strict();
export type CloneGrant = z.infer<typeof CloneGrantSchema>;

export const CloneResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cloned'), bytes: z.number().int().nonnegative() }),
  z.object({ status: z.literal('failed'), reason: z.string().max(2000), retryable: z.boolean() }),
]);
export type CloneResult = z.infer<typeof CloneResultSchema>;
