# Jumpmaster M1 (Loop parity) Implementation Plan — v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take an issue all the way to a merged PR with no human click, while never wedging:
- implement → review → heal / resolve-conflicts → orchestrator merge;
- every forge write goes through an outbox;
- verdicts are bound to a commit SHA;
- credentials are split between two bots;
- implement checkpoints and resumes;
- the global usage pause works and cannot wedge;
- the trust boundary is enforced, including inside the trooper container.

**Architecture:**
- A pure decision function, `decide(snapshot) → Action`, owns the PR lifecycle. A per-zone reconciler builds fresh forge snapshots, applies the actions, and writes to the forge only through an idempotent outbox.
- Drops become role-typed: implement, review, heal, resolve. The trooper dispatches on role.
- The trooper (PID 1) is root and runs git only in root-owned directories. The agent and all working-copy git run as the unprivileged `agent` uid; gates run as a third uid, `gate`.

**Tech Stack:** unchanged from M0 (Node ≥ 24, TypeScript 7, npm workspaces, vitest, Biome, Fastify 5, better-sqlite3, zod, @octokit/rest, nock 14, dockerode, Claude Code 2.1.302).

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md`, mainly §15 (M1 row and gate), §5.1–§5.4, §7, §12.3 and §16. M0 usage findings: `docs/spikes/usage-signals.md`. v2 and v3 apply two red-team rounds; see **Red-team disposition** at the end.

## Global Constraints

- **No Claude attribution:** no `Co-Authored-By` or "Generated with" lines in commits, PR bodies, merge commits, or any text Jumpmaster writes to a forge.
- **Public repo:** no private names, hostnames, local paths, or employer names.
- **Merging:** agents never approve or merge. Only server code merges, through the outbox, and only when all of these hold (§7.4; Task 7 rules): verdict SHA = CI SHA = head SHA with no `request_changes` verdict on that head; the verdict's `post_review` op is `done`; the change is not on base, touches no protected path and changes no gate script; no trusted human block stands; branch protection passes the precondition (`requireBranchProtection`, default true); every required check has reported. M1 merges by squash only, with its own title (PR title) and message (`Closes #N`), so agent commit messages never reach base; every pushed commit's author and committer is Jumpmaster Agent.
- **Credential roles:**

  | Role / process | Forge token it gets |
  |---|---|
  | **author** (`JM_GITHUB_AUTHOR_TOKEN`) | implement, heal and resolve drops (root-only, for clone and push); the server, for create-PR and merge |
  | **reviewer** (`JM_GITHUB_REVIEWER_TOKEN`) | never leaves the server; used only to post reviews |
  | review drops | the global read token `JM_GITHUB_READ_TOKEN` only when `zone.reviewReadToken` is true (private repos); otherwise none |
  | agent uid, gate uid, crew | none, ever |

  The author PAT has no Workflows, Commit statuses, Checks or Secrets permission. Base CI exposes no secrets to agent branches, and `GITHUB_TOKEN` defaults to read (runbook, Task 24). The trooper refuses to push a change touching `protectedPaths` (Task 15).

- **Trust:** both bot logins (`Forge.viewerLogin()` of each identity) are never trusted. Reviews whose body contains `jm:op:` are Jumpmaster's own and are ignored for trust and fingerprints.
- **Forge facts:** facts that humans or CI own are re-read at decision time and never trusted from cache before a push, approve, merge or close (§5.1). The server never trusts `result.headSha` beyond the `upsertPullRequest` hint; the snapshot re-reads `getPull`.
- **Outbox:** every forge write carries a lookup key. A `<!-- jm:op:<opKey> -->` marker is the final line of every body Jumpmaster writes; every merge is pinned with `sha=`. Thrown or 5xx → `unknown`, resolved by read-back, never by blind retry. 4xx → `failed`, never retried. At startup, `pending` rows become `unknown` (§5.2).
- **Budgets** (per work item, configurable per zone; an exhausted budget parks `budget exhausted: <key>`):

  | Budget | Default | Counted |
  |---|---|---|
  | `maxHeal` | 3 | every heal drop, charged at enqueue |
  | `maxResolve` | 2 | only resolves whose `mergeOutcome` is `conflicts` (charged on result), plus repeats of the same `[headSha, baseSha]` fingerprint (charged at enqueue); clean and up-to-date resolves are free |
  | `maxResolveTotal` | 6 | every resolve enqueue, clean or not (parks `budget exhausted: resolve-total`) |
  | `maxResume` | 2 | every implement continuation (interrupted, or adopted branch without PR) |
  | `maxReviewRepeat` | 2 | reviews of the same head SHA |
  | `maxNoChange` | 1 | implement runs that end `no_changes` |
  | rate-limit requeues | 3 (constant) | `rate_limited` results requeued |

  A charge and its drop insert run in one transaction.
- **Usage** (Task 10): a pause comes only from a `rejected` report carried by a drop result whose accepted outcome is not `completed`. It lasts until `min(resetsAt, now + window)` + 30–90 s jitter (a past `resetsAt` gives now + jitter), capped at 1 h until a second distinct drop or the probe confirms it; then one probe drop runs, never for the item that caused the pause. `allowed` clears a pause only from the probe or a drop started after the pause. `allowed_warning`, or utilization ≥ 0.9 on either window, blocks new implement drops only, until the observation expires. The probe clears when its drop reaches any terminal state. `rate_limited` is requeued, refunding the charge, while the usage state is paused, at most 3 times per item (the probe's own requeue is free).
- **Concurrency:** at most one active drop per item (`one_active_drop` index; a unique-constraint error on insert means "already active"), and at most one active implement drop per zone. Review, heal and resolve drops for different items run concurrently, limited only by stick slots. At most one merge op per zone per pass; zones are processed sequentially.
- **Deadlines:** CI wait `ciDeadlineMinutes: 45` from the first time the current head was observed; `ciRequired: true` by default. Missing forge data (null PR, compare or issue read) waits, capped by the same deadline from `waiting_since`.
- **Inside the trooper (R1, v3 Q2/Q5):** `work/` is root-owned 0755 and holds the bare mirror `work/mirror`, which root clones with the token before any agent process exists. The agent clones from it, without a token, into its own `$HOME/repo` (`/home/agent/repo`); no chown exists anywhere. Root git always sets `GIT_DIR` and `GIT_CEILING_DIRECTORIES`, and `lstat`-validates the mirror (uid 0, directory, not a symlink) before every call. Gates run as uid `gate` (10002) in a fresh `/home/gate/repo`, cloned as the gate uid from a bundle of the agent repo's `HEAD`, after root sweeps every agent-uid process; there is no shared group or setgid, and the agent umask is 0022. Cleanup of agent files runs as the agent. Every working-copy git command (`status`, `add`, `commit`, `checkout`, `merge`, `aheadOfBase`, dirty-tree and conflict-marker checks) runs as the agent uid, and `safe.directory` is never overridden. The pristine push fetches from the agent repo with `upload-pack` running as the agent uid (`setpriv`), then pushes as root from a root-owned bare repo. Extra `GIT_CONFIG_*` keys append after the auth header (index ≥ 1). Root reads agent-written files only via `readAgentFile`. Uid switching happens only when `JM_CONTAINER === '1'` and the process is root.
- **Time:** every timestamp written by server code comes from a caller-supplied `now`. Tests never use the wall clock; jitter takes an injected `rand`.
- **Schema:** `schema.sql` is frozen as migration v1; never edit it.
- **Protocol header:** `x-jumpmaster-protocol: 1` is unchanged; payload changes stay backward-compatible within this branch only.
- **Known limitation (R13):** "already on base" is detected by `compare.aheadBy === 0` (ancestry). A change squash- or rebase-landed under different SHAs is not detected; such a closed-issue item parks `issue closed` instead of `done`. Tree-compare is deferred.

## Review Focus

1. **A human force-pushes to the agent branch after an approval.** The approval no longer counts; a fresh review runs on the new head, and no merge happens on the old verdict. Task 7, `head change invalidates approval`.
2. **The repo has no CI and `ciRequired` is false**, as in the M0 test repo. It merges once the verdict is approve and posted. With `ciRequired: true` it waits, then parks `no pipeline` at the deadline. Task 7, `no CI honours ciRequired`.
3. **The merge call returns 5xx after GitHub actually merged.** Exactly one merge call; the outbox read-back marks it done and the item becomes `done`/`merged`. Task 5, `merge 5xx after success is resolved by read-back`.
4. **The agent plants `core.fsmonitor`, a pre-commit hook and a clean filter in its working copy.** None of them runs on the root path (mirror clone, pristine fetch, push). Task 15, `planted fsmonitor, hook and clean filter never run on the root path`.
5. **The DB is restored from an older backup, or `data/` is wiped, while agent PRs are open.** The reconciler adopts the open `agent/issue-N` PRs from the author bot instead of re-implementing them, and nothing is merged twice. Task 12, `adopts an existing agent PR`.

---

## File Structure

```
packages/protocol/src/index.ts           role-typed DropPayload union, Verdict, MergeOutcome, RateLimitEventData, DropResult
apps/server/src/
  db/migrations.ts                        ordered forward-only migrations + schema_version
  db/schema.sql                           frozen M0 base (= migration v1)
  db/repo.ts                              + row types; PR, verdict, attempts, outbox, usage queries
  config.ts                               + reviewer/read tokens, per-role models, budgets, CI, protection, usage
  forge/github.ts                         + PR/review/check/merge/compare/rules/file reads and writes
  test/fakes.ts                           stateful FakeForge pair (keeps M0 fakeForge factory)
  outbox.ts                               ForgePair, runOp, resolveUnknown, markPendingUnknown, sanitizeForgeText
  flow/budgets.ts                         fingerprints and attempt accounting
  flow/decide.ts                          pure lifecycle decision: Snapshot → Action
  flow/guards.ts                          protected paths, gate-script and gate-tool changes, branch-protection problems
  flow/snapshot.ts                        fresh forge facts for one pr_open item
  flow/reconcile.ts                       per-zone pass: resolve unknowns, adopt, snapshot, decide, apply
  payloads.ts                             buildPayload per role + promptVersions (moved from api/sticks.ts)
  results.ts                              applyResult per role
  usage.ts                                usage state, dispatch gate, probe
  leases.ts, scheduler.ts, sync.ts, api/sticks.ts, app.ts, main.ts, ui/pages.ts   (modified)
  test/flowHarness.ts                     drivers for lifecycle tests
  flow/failure-classes.test.ts            §16 suite — the M1 gate
apps/trooper/
  prompts/{implement,review,heal,resolve}.md
  src/privilege.ts                        agent/gate identities, spawn options, setpriv argv, uid sweep, readAgentFile
  src/git.ts                              root mirror, agent-uid working copy, checkoutBranch, mergeBase, guarded pushes
  src/roles/{shared,implement,review,heal,resolve}.ts
  src/main.ts, src/claude.ts              role dispatch; outputSchema; rate-limit fields; strict result acceptance
images/trooper/Dockerfile                 agent and gate users, root trooper, no setuid binaries
apps/stick/src/{runner,docker}.ts         payload image + allow-list; container hardening
docs/runbooks/m1-loop.md                  operator procedure for the M1 real-repo check
```

---

### Task 1: Schema migrations, M1 tables and row types

**Files:**
- Create: `apps/server/src/db/migrations.ts`
- Modify: `apps/server/src/db/open.ts`, `apps/server/src/db/repo.ts`
- Test: `apps/server/src/db/migrations.test.ts`, `apps/server/src/db/repo.test.ts`

**Interfaces:**
- Consumes: M0 `Db`, `openDb`, `schema.sql`, `WorkItem`, `Drop`, `NewDrop`, `DropPatch`, `DROP_COLUMN`.
- Produces:
  - `MIGRATIONS: { version: number; sql: string }[]` (v1 = frozen `schema.sql`, exported as `M0_SCHEMA_SQL`; v2 = M1). `migrate(db: Db): number` runs each pending migration in its own transaction, recorded in `schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`. `openDb` calls it; an M0 DB (tables present, no `schema_version`) is stamped v1 first.
  - Migration v2:

    | Change | Detail |
    |---|---|
    | `pull_requests` | `work_item_id INTEGER PRIMARY KEY REFERENCES work_items(id)`, `number INTEGER NOT NULL`, `head_ref TEXT NOT NULL`, `head_sha TEXT NOT NULL`, `head_first_seen_at TEXT NOT NULL`, `state TEXT NOT NULL CHECK (state IN ('open','closed','merged'))`, `observed_at TEXT NOT NULL` |
    | `verdicts` | `id TEXT PRIMARY KEY` (= review drop id), `work_item_id INTEGER NOT NULL`, `head_sha TEXT NOT NULL`, `decision TEXT NOT NULL CHECK (decision IN ('approve','request_changes'))`, `forced INTEGER NOT NULL DEFAULT 0`, `summary TEXT NOT NULL`, `findings_json TEXT NOT NULL`, `gates_json TEXT NOT NULL`, `created_at TEXT NOT NULL` |
    | `attempts` | `work_item_id INTEGER NOT NULL`, `key TEXT NOT NULL`, `count INTEGER NOT NULL DEFAULT 0`, `last_fingerprint TEXT`, `PRIMARY KEY (work_item_id, key)` |
    | `outbox` | `id TEXT PRIMARY KEY`, `op_key TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge'))`, `work_item_id INTEGER NOT NULL`, `payload_json TEXT NOT NULL`, `state TEXT NOT NULL CHECK (state IN ('pending','done','unknown','failed'))`, `result_json TEXT`, `error TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL` |
    | `usage_state` | one row `id = 1`, seeded by the migration: `status TEXT`, `paused_until TEXT`, `five_hour_util REAL`, `five_hour_resets_at TEXT`, `seven_day_util REAL`, `seven_day_resets_at TEXT`, `observed_at TEXT`, `paused_at TEXT`, `pause_confirmed INTEGER NOT NULL DEFAULT 0`, `probe_drop_id TEXT`, `probe_not_before TEXT`, `cause_drop_id TEXT`, `cause_work_item_id INTEGER`, `updated_at TEXT` |
    | `work_items` columns | `retry_label_seen INTEGER NOT NULL DEFAULT 0`, `waiting_since TEXT` |
    | `drops` columns | `fingerprint TEXT`, `pr_number INTEGER`, `head_sha TEXT`, `input_json TEXT`, `charged_key TEXT` |

  - Types (camelCase via `AS` aliases, as in M0):
    - `AttemptKey = 'heal' | 'resolve' | 'resolve_total' | 'resume' | 'review' | 'no_change' | 'rate_limit'`
    - `PullRequestRow = { workItemId: number; number: number; headRef: string; headSha: string; headFirstSeenAt: string; state: 'open' | 'closed' | 'merged'; observedAt: string }`
    - `VerdictRow = { id: string; workItemId: number; headSha: string; decision: 'approve' | 'request_changes'; forced: boolean; summary: string; findingsJson: string; gatesJson: string; createdAt: string }`
    - `OutboxState = 'pending' | 'done' | 'unknown' | 'failed'`
    - `OutboxRow = { id: string; opKey: string; kind: 'create_pr' | 'post_review' | 'merge'; workItemId: number; payloadJson: string; state: OutboxState; resultJson: string | null; error: string | null; createdAt: string; updatedAt: string }`
    - `UsageStateRow = { status: 'allowed' | 'allowed_warning' | 'rejected' | null; pausedUntil: string | null; fiveHourUtil: number | null; fiveHourResetsAt: string | null; sevenDayUtil: number | null; sevenDayResetsAt: string | null; observedAt: string | null; pausedAt: string | null; pauseConfirmed: boolean; probeDropId: string | null; probeNotBefore: string | null; causeDropId: string | null; causeWorkItemId: number | null; updatedAt: string | null }`
    - `WorkItem` gains `retryLabelSeen: boolean`, `waitingSince: string | null`.
    - `Drop` gains `fingerprint`, `prNumber`, `headSha`, `inputJson`, `chargedKey: AttemptKey | null` (all nullable). `NewDrop` and `insertDrop` accept them; `DROP_COLUMN` gets an entry for each.
  - Functions (all writes take `now: Date`):
    - `getWorkItem(db, id): WorkItem | undefined`; `setWaitingSince(db, id, at: string | null): void`
    - `getPullRequest(db, itemId): PullRequestRow | undefined`
    - `upsertPullRequest(db, row: Omit<PullRequestRow, 'headFirstSeenAt' | 'observedAt'>, now): void` — resets `headFirstSeenAt` only when `headSha` changes; mirrors `number` into `work_items.pr_number` (UI copy; `pull_requests` is authoritative).
    - `insertVerdict(db, v: VerdictRow): boolean` — `INSERT OR IGNORE`; returns whether a row was inserted.
    - `latestVerdict(db, itemId): VerdictRow | undefined` (newest by `created_at`, then rowid); `verdictsForHead(db, itemId, headSha): VerdictRow[]` (oldest first).
    - `getAttempts(db, itemId, key: AttemptKey): { count: number; lastFingerprint: string | null }`; `setAttempts(db, itemId, key, count, fingerprint: string | null): void`; `resetAttempts(db, itemId): void`.
    - `activeDropFor(db, itemId): Drop | undefined`
    - `getOutbox(db, opKey): OutboxRow | undefined`; `insertOutbox(db, row: Omit<OutboxRow, 'resultJson' | 'error' | 'updatedAt'>): boolean` (`INSERT OR IGNORE`); `updateOutbox(db, opKey, patch: Pick<Partial<OutboxRow>, 'state' | 'resultJson' | 'error'>, now): void`; `listOutbox(db, states: OutboxState[], zoneId?: string): OutboxRow[]` (joined through `work_items`); `deleteFailedOutbox(db, itemId): number`.
    - `getUsageState(db): UsageStateRow`; `setUsageState(db, patch: Partial<UsageStateRow>, now): void`.

- [ ] **Step 1: Write failing tests**

```ts
test('fresh DB migrates to version 2', () => expect(maxVersion(openDb(tmpDbFile()))).toBe(2));
test('an M0 database is stamped v1 then upgraded without data loss', () => {
  const f = tmpDbFile(); const raw = new Database(f); raw.exec(M0_SCHEMA_SQL);
  raw.prepare(`insert into drop_zones values ('main','o/r','master','{}')`).run(); raw.close();
  const db = openDb(f); expect(count(db, 'drop_zones')).toBe(1); expect(maxVersion(db)).toBe(2);
});
test('migrate is idempotent', () => { const f = tmpDbFile(); openDb(f).close(); expect(migrate(openDb(f))).toBe(2); });
test('usage_state row 1 is seeded', () => expect(getUsageState(openDb(tmpDbFile())).status).toBeNull());
test('upsertPullRequest resets headFirstSeenAt only when the head changes', () => { /* t0 sha1, t1 sha1 → t0; t2 sha2 → t2 */ });
test('insertVerdict is idempotent per id', () => { expect(insertVerdict(db, v)).toBe(true); expect(insertVerdict(db, v)).toBe(false); });
// also: 'upsertPullRequest mirrors work_items.pr_number'; 'latestVerdict returns the newest verdict'; 'insertDrop round-trips fingerprint, prNumber, headSha,
//   inputJson, chargedKey'
```

- [ ] **Step 2: Run** `npm test -w apps/server -- db`. Expected: FAIL (`migrations.js` missing).
- [ ] **Step 3: Implement** as above. No wall-clock reads in new functions.
- [ ] **Step 4: Run** `npm test -w apps/server`. Expected: PASS, including the M0 tests.
- [ ] **Step 5: Commit** `feat(server): forward-only migrations and M1 tables`

---

### Task 2: Role-typed protocol

**Files:**
- Modify: `packages/protocol/src/index.ts`, `apps/server/src/api/sticks.ts` (`buildPayload`: add `image: zone.image`, `resume: false`, `protectedPaths: []` until Task 8), `apps/trooper/src/main.ts` (`forgeToken` optional; throw `forge token required for implement` when missing), `apps/stick/src/runner.ts` (synthesized `failed` results set `role: payload.role`)
- Test: `packages/protocol/src/index.test.ts`; fixtures in `apps/trooper/src/main.test.ts`, `apps/stick/src/runner.test.ts`, `apps/server/src/api/sticks.test.ts` gain `image`

**Interfaces:**
- Consumes: M0 `GateSpecSchema`, `GateResultSchema`, `agentBranch`.
- Produces:
  - `Role = 'implement' | 'review' | 'heal' | 'resolve'`, `RoleSchema`.
  - `PrRef = { number: number; branch: string; headSha: string }`.
  - `DropPayload`: `z.discriminatedUnion('role', …)`. Shared fields: `protocol: 1`, `dropId`, `epoch`, `repo`, `issue`, `branch`, `gates`, `model`, `maxTurns`, `promptVersion`, `prompt`, `image: string`, `protectedPaths: string[]` (the trooper's pre-push guard), `credentials: { claudeToken: string; forgeToken?: string }`.

    | Role | Extra fields |
    |---|---|
    | `implement` | `resume: boolean` (default false), `resumeSha?: string` (remote tip to continue from) |
    | `review` | `pr: PrRef` |
    | `heal` | `pr: PrRef`, `feedback: string` (pre-rendered, headed text) |
    | `resolve` | `pr: PrRef` |

  - `Verdict = { decision: 'approve' | 'request_changes'; summary: string; findings: { severity: 'blocker' | 'major' | 'minor'; file?: string; detail: string }[] }`, `VerdictSchema`.
  - `MergeOutcome = 'clean' | 'conflicts' | 'up_to_date'`.
  - `RateLimitEventData = { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: string; rateLimitType?: string; unifiedWindows?: { five_hour?: { utilization: number; resetsAt?: string }; seven_day?: { utilization: number; resetsAt?: string } } }` (all `resetsAt` ISO strings), `RateLimitEventDataSchema`. The trooper emits exactly these keys in `rate_limit` events.
  - `DropResult`: `status` adds `interrupted` (max turns; `headSha` set if a checkpoint was pushed) and `rate_limited` (usage limit; same). Adds `role?: Role` (optional; the server trusts `drop.role`), `verdict?: Verdict`, `mergeOutcome?: MergeOutcome`, `rateLimit?: RateLimitEventData` (the last rate-limit report of the run; the only source of a pause).
  - `REVIEW_OUTPUT_SCHEMA`, `IMPLEMENT_OUTPUT_SCHEMA`: plain JSON-schema objects (moved from `apps/trooper/src/claude.ts`).

- [ ] **Step 1: Write failing tests**

```ts
test('review payload requires pr', () => expect(() => DropPayloadSchema.parse({ ...base, role: 'review' })).toThrow());
test('implement payload defaults resume to false', () => { const p = DropPayloadSchema.parse({ ...base, role: 'implement' }); if (p.role !== 'implement') throw 0; expect(p.resume).toBe(false); expect(p.resumeSha).toBeUndefined(); });
test('forgeToken is optional', () => expect(DropPayloadSchema.parse({ ...reviewPayload, credentials: { claudeToken: 't' } }).credentials.forgeToken).toBeUndefined());
test('verdict decision is validated', () => expect(() => VerdictSchema.parse({ decision: 'lgtm', summary: '', findings: [] })).toThrow());
test('role is optional on results', () => expect(DropResultSchema.parse({ status: 'failed', gates: [] }).role).toBeUndefined());
test('rate limit event data keeps windows', () => expect(RateLimitEventDataSchema.parse({ status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.5 } } }).unifiedWindows?.seven_day?.utilization).toBe(0.5));
test('rate_limited result carries its rate limit', () => expect(DropResultSchema.parse({ status: 'rate_limited', gates: [], rateLimit: { status: 'rejected' } }).rateLimit?.status).toBe('rejected'));
// also: 'rate_limited and interrupted are valid statuses'; 'payload requires protectedPaths'
```

- [ ] **Step 2: Run** `npm test -w packages/protocol`. Expected: FAIL.
- [ ] **Step 3: Implement**; update the named call sites and fixtures until `npm run typecheck` passes. Server behaviour stays implement-only.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(protocol): role-typed drop payloads, verdicts, interrupted and rate_limited results`

---

### Task 3: Config for credential roles, models, budgets, CI, protection and usage

**Files:**
- Modify: `apps/server/src/config.ts`, `examples/jumpmaster.config.json`, `apps/server/src/api/sticks.test.ts` (its `secrets:` literal gains `githubReviewerToken`)
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Consumes: `Role` (Task 2).
- Produces:
  - `Config.secrets` gains `githubReviewerToken: string` (env `JM_GITHUB_REVIEWER_TOKEN`, required) and `githubReadToken?: string` (env `JM_GITHUB_READ_TOKEN`). Equal author and reviewer tokens fail: `JM_GITHUB_REVIEWER_TOKEN must differ from JM_GITHUB_AUTHOR_TOKEN`.
  - `DropZoneConfig` gains (zod defaults):

    | Field | Type | Default |
    |---|---|---|
    | `models` | `Partial<Record<Role, string>>` | `{}` |
    | `budgets` | `{ maxHeal: number; maxResolve: number; maxResolveTotal: number; maxResume: number; maxReviewRepeat: number; maxNoChange: number }` | `3, 2, 6, 2, 2, 1` |
    | `ciRequired` | `boolean` | `true` |
    | `ciDeadlineMinutes` | `number` | `45` |
    | `retryLabel` | `string` | `'agent-retry'` |
    | `mergeMethod` | `'squash'` (the only value accepted in M1) | `'squash'` |
    | `requireBranchProtection` | `boolean` | `true` |
    | `protectedPaths` | `string[]` | `['.github/**', '.claude/**', 'CODEOWNERS', 'GOAL.md', '.npmrc', '.gitattributes', '.gitmodules', 'jumpmaster*.json', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', 'vitest.config.*', 'vite.config.*', 'jest.config.*', '.mocharc*', 'playwright.config.*', 'babel.config.*']` |
    | `reviewReadToken` | `boolean` | `false` (set true for private repos) |

  - `type Budgets = DropZoneConfig['budgets']`.
  - `Config.usage: { throttleUtilization: number; probeJitterSeconds: [number, number] }`, defaults `0.9`, `[30, 90]`; `type UsageConfig = Config['usage']`.
  - `modelFor(zone: DropZoneConfig, role: Role): string` — falls back to `zone.model`.
  - `secretList(secrets: Config['secrets']): string[]` — every non-empty secret value (used for redaction).

- [ ] **Step 1: Write failing tests**

```ts
test('reviewer token is required', () => expect(() => loadConfig(f, { ...env, JM_GITHUB_REVIEWER_TOKEN: undefined })).toThrow(/JM_GITHUB_REVIEWER_TOKEN/));
test('reviewer and author must differ', () => expect(() => loadConfig(f, { ...env, JM_GITHUB_REVIEWER_TOKEN: env.JM_GITHUB_AUTHOR_TOKEN })).toThrow(/must differ/));
test('M1 defaults', () => expect(loadConfig(f, env).dropZones[0]).toMatchObject({ ciRequired: true, ciDeadlineMinutes: 45, retryLabel: 'agent-retry', mergeMethod: 'squash', requireBranchProtection: true, reviewReadToken: false, budgets: { maxHeal: 3, maxResolve: 2, maxResolveTotal: 6, maxResume: 2, maxReviewRepeat: 2, maxNoChange: 1 } }));
test('mergeMethod other than squash is refused', () => expect(() => loadConfig(withZone({ mergeMethod: 'rebase' }), env)).toThrow());
test('protectedPaths default list', () => expect(loadConfig(f, env).dropZones[0].protectedPaths).toContain('.github/**'));
test('modelFor falls back to zone model', () => expect(modelFor({ ...zone, models: { review: 'r' } }, 'heal')).toBe(zone.model));
// also: 'secretList omits an absent read token'
```

- [ ] **Step 2: Run** `npm test -w apps/server -- config`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the reviewer token to the example env comments.
- [ ] **Step 4: Run** `npm run typecheck && npm test -w apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): credential roles, per-role models, budgets, CI, protection and usage config`

---

### Task 4: GitHub adapter extensions

**Files:**
- Modify: `apps/server/src/forge/github.ts`
- Test: `apps/server/src/forge/github.test.ts`

**Interfaces:**
- Consumes: M0 `Forge`, `GitHubForge`, `ForgeIssue`.
- Produces — types:
  - `PullFacts = { number: number; title: string; state: 'open' | 'closed'; merged: boolean; headSha: string | null; headRef: string; headRepo: string | null; baseRef: string; author: string }`
  - `ForgeReview = { id: number; author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commitId: string; body: string; submittedAt: string }`
  - `ChecksState = 'success' | 'pending' | 'failure' | 'none'`; `ChecksFacts = { state: ChecksState; names: string[] }` (`names`: every check-run name and status context seen on the SHA, any state)
  - `CompareFacts = { aheadBy: number; behindBy: number; baseSha: string; mergeBaseSha: string }` (`mergeBaseSha` from `merge_base_commit`)
  - `PullFiles = { files: { path: string; previousPath?: string }[]; complete: boolean }` (`complete` false beyond the endpoint's 3000-file cap)
  - `BranchRules = { requiredApprovals: number; dismissStaleOnPush: boolean; requiredChecks: string[]; unpinnedChecks: string[]; viewerCanBypass: boolean; viewerIsAdmin: boolean }`
  - `BranchRulesRead = { kind: 'ok'; rules: BranchRules } | { kind: 'none' } | { kind: 'unavailable' }`
  - `ForgeError = Error & { status?: number }` — every adapter error carries Octokit's HTTP status.
- Produces — `Forge` methods (read-backs unless noted; list calls use `octokit.paginate`):

  | Method | Returns / behaviour |
  |---|---|
  | `viewerLogin()` | `string` (cached per instance) |
  | `getPull(number)` | `PullFacts \| null` |
  | `findOpenPullByHead(branch)` | `PullFacts \| null`; queries `head=<owner>:<branch>`; only PRs whose head repo is the base repo |
  | `listOpenAgentPulls(prefix)` | `PullFacts[]`; one paginated open-PR listing filtered to `headRef` starting with `prefix`, head repo = base repo |
  | `getIssueState(number)` | `'open' \| 'closed'` |
  | `getIssueLabels(number)` | `string[]` |
  | `branchSha(branch)` | `string \| null` (replaces the plan-v1 `branchExists`) |
  | `compare(base, head)` | `CompareFacts` |
  | `listPullFiles(number)` | `PullFiles` (paginated PR files endpoint; renames carry `previousPath`) |
  | `checksFor(sha)` | `ChecksFacts`; any failure → `failure`; any queued/in-progress → `pending`; none of either → `none` |
  | `getBranchRules(branch)` | `BranchRulesRead`. Reads `GET /repos/{o}/{r}/rules/branches/{b}`, then for each distinct `ruleset_id` `GET /repos/{o}/{r}/rulesets/{id}?includes_parents=true`; counts rules only from rulesets with `enforcement: active`. `viewerCanBypass` = any active ruleset whose `current_user_can_bypass` is missing or not `never`. `unpinnedChecks` = required checks without `integration_id`. `viewerIsAdmin` from the collaborator permission of `viewerLogin()`. 5xx → `unavailable`; 403/404 or no active ruleset → `none` |
  | `getFileAt(ref, path)` | `string \| null` (contents API; null on 404) |
  | `listReviews(number)` | `ForgeReview[]` |
  | `createReview(number, { event: 'APPROVE' \| 'REQUEST_CHANGES'; body: string; commitId: string })` | `{ id: number }` (write) |
  | `findReviewByMarker(number, marker)` | `{ id: number } \| null`; matches only reviews by `viewerLogin()` whose final line equals `marker` |
  | `merge(number, { sha: string; method: 'squash'; title: string; message: string })` | `{ merged: boolean; sha?: string }` (write; sends `sha`, `merge_method`, `commit_title`, `commit_message`) |

- [ ] **Step 1: Write failing tests** (nock)

```ts
test('listOpenAgentPulls paginates past 100', async () => { /* 150 PRs over two pages, 120 agent/ */ expect(await forge.listOpenAgentPulls('agent/')).toHaveLength(120); });
test('merge is pinned to sha and sets title and message', async () => { nock(api).put('/repos/o/r/pulls/5/merge', b => b.sha === 'abc' && b.merge_method === 'squash' && b.commit_title === 'T' && b.commit_message === 'Closes #3').reply(200, { merged: true, sha: 'm1' }); /* … */ });
test('adapter errors carry status', async () => { nock(api).put(/merge/).reply(405, { message: 'Base branch was modified' }); await expect(forge.merge(5, m)).rejects.toMatchObject({ status: 405 }); });
// also: 'checksFor combines check runs and statuses' (failure > pending > success; none when both empty; names collected); 'getPull maps merged, head repo and
//   null headSha'; 'findOpenPullByHead uses owner:branch and rejects fork heads'; 'listReviews paginates past 100'; 'findReviewByMarker ignores other authors
//   and non-final markers'; 'getBranchRules reads approvals, stale dismissal, checks and bypass'; 'getBranchRules treats a missing current_user_can_bypass as bypass'; 'getBranchRules
//   ignores evaluate and disabled rulesets'; 'getBranchRules flags unpinned checks and an admin bot'; 'getBranchRules: 5xx is unavailable, 403 is none'; 'listPullFiles
//   paginates and keeps previousPath'
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- forge` (expected FAIL); implement; run `npm test -w apps/server -- forge` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): forge reads and writes for the PR lifecycle`

---

### Task 5: Stateful FakeForge and the outbox

**Files:**
- Modify: `apps/server/src/test/fakes.ts`
- Create: `apps/server/src/outbox.ts`
- Test: `apps/server/src/outbox.test.ts`

**Interfaces:**
- Consumes: `Forge`, `PullFacts`, `ForgeReview`, `ForgeError` (Task 4); `OutboxRow`, outbox repo functions (Task 1).
- Produces:
  - `fakeForgePair(opts: { issues: ForgeIssue[]; trusted: string[]; defaultBranch?: string; authorLogin?: string; reviewerLogin?: string }): { author: FakeForge; reviewer: FakeForge; state: FakeForgeState }` — both share `state` (issues, pulls, branches, checks, reviews, merges, files, rules). `FakeForge` adds `failNext(method: keyof Forge, mode: 'throw' | '5xx' | '5xx-after-success' | { status: number; message?: string })` and `calls: { method: string; identity: 'author' | 'reviewer'; args: unknown[] }[]`; failures throw `ForgeError` with `status`. The M0 `fakeForge({ issues, trusted })` factory and its `created` list keep working.
  - `ForgePair = { author: Forge; reviewer: Forge }`.
  - `OpKind = 'create_pr' | 'post_review' | 'merge'`; `OpResult = { state: OutboxState; result?: unknown; error?: string }`.
  - `opKeys`: `pr:<itemId>:<headSha>`, `review:<itemId>:<headSha>:<dropId>`, `merge:<itemId>:<headSha>`.
  - `runOp(db, forges: ForgePair, op: { kind: OpKind; opKey: string; itemId: number; payload: unknown }, now: Date): Promise<OpResult>`:

    | Existing row | Behaviour |
    |---|---|
    | `done` | return stored result; no forge call. Exception: a `create_pr` row is reused only while `findOpenPullByHead` returns an open PR; otherwise the row is reset to `pending` and the op runs again |
    | `failed` | return stored failure; no forge call |
    | `pending` or `unknown` | lookup only; visible → `done`; else stays `unknown`. Never writes. |
    | none | `insertOutbox` (`INSERT OR IGNORE`; if ignored, re-read and apply the row above), then lookup, then write |

    | Kind | Lookup | Write | Identity |
    |---|---|---|---|
    | `create_pr` | `findOpenPullByHead` | `findOrCreatePullRequest`, body ending with the marker | author |
    | `post_review` | `findReviewByMarker(pr, marker)` | `createReview`, body ending with the marker | reviewer |
    | `merge` | `getPull`; `merged` → done | `merge` with `sha`, `method`, `title`, `message` | author |

    Thrown without status, or status ≥ 500 → `unknown`. Status 4xx → `failed`, `error` = message.
  - `resolveUnknown(db, forges, zoneId: string, now: Date, maxAgeMinutes: number): Promise<number>` — lookup for every `unknown` row of that zone (forges are per zone); returns rows marked `done`. A row still unresolved after `maxAgeMinutes` (the zone's `ciDeadlineMinutes`) becomes `failed`, `error = 'unresolved after <n> min'`.
  - `markPendingUnknown(db, now): number` — startup: every `pending` row becomes `unknown`.
  - `sanitizeForgeText(text: string, secrets: string[], maxLen = 60_000): string` — replaces each secret with `[redacted]`; escapes `<!--` and `-->`; neutralises `@mentions` and bare autolinks by wrapping them in code spans; truncates to `maxLen`.

- [ ] **Step 1: Write failing tests**

```ts
test('merge 5xx after success is resolved by read-back', async () => {
  f.author.failNext('merge', '5xx-after-success');
  expect((await runOp(db, forges, mergeOp, t0)).state).toBe('unknown');
  expect(await resolveUnknown(db, forges, 'main', t0, 45)).toBe(1);
  expect(f.author.calls.filter(c => c.method === 'merge')).toHaveLength(1);
});
test('runOp on an unknown row runs the lookup only', async () => { /* seed unknown, effect absent */ expect((await runOp(db, forges, mergeOp, t1)).state).toBe('unknown'); expect(calls('merge')).toHaveLength(0); });
test('an unknown row older than the deadline becomes failed', async () => { seedUnknown(mergeOp, t0); await resolveUnknown(db, forges, 'main', plus(t0, 46 * MIN), 45); expect(getOutbox(db, mergeOp.opKey)).toMatchObject({ state: 'failed', error: 'unresolved after 45 min' }); });
test('a done create_pr whose PR was closed runs again', async () => { /* done row, PR closed */ expect((await runOp(db, forges, prOp, t1)).state).toBe('done'); expect(calls('findOrCreatePullRequest')).toHaveLength(1); });
test('merge 405 is failed with the message', async () => { f.author.failNext('merge', { status: 405, message: 'Base branch was modified' }); expect(await runOp(db, forges, mergeOp, t0)).toMatchObject({ state: 'failed', error: /Base branch/ }); });
test('sanitizeForgeText redacts secrets and escapes markers and mentions', () => expect(sanitizeForgeText('tok @org/team <!-- jm:op:x -->', ['tok'])).not.toMatch(/tok|<!--|(^|\s)@org/));
// also: 'a done op is never re-issued'; 'runOp on a failed row never writes'; 'post_review finds its own marker instead of posting twice'; 'post_review uses
//   the reviewer identity'; 'markPendingUnknown flips pending rows'; 'resolveUnknown ignores rows of
//   other zones'
```

- [ ] **Step 2: Run** `npm test -w apps/server -- outbox`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/server`. Expected: PASS (M0 tests still use `fakeForge`).
- [ ] **Step 5: Commit** `feat(server): stateful fake forge and an idempotent outbox`

---

### Task 6: Budgets and fingerprints

**Files:**
- Create: `apps/server/src/flow/budgets.ts`
- Test: `apps/server/src/flow/budgets.test.ts`

**Interfaces:**
- Consumes: `AttemptKey`, attempts repo functions (Task 1); `Budgets` (Task 3).
- Produces:
  - `fingerprint(parts: (string | number | null)[]): string` — sha256 of the parts joined with `\0`, first 16 hex chars.
  - `RATE_LIMIT_REQUEUE_MAX = 3`.
  - `chargeBudget(db, itemId, key: 'heal' | 'resolve' | 'resume' | 'review', fp: string, budgets: Budgets): { ok: true } | { ok: false; reason: string }`:

    | Key | Charged when | Limit |
    |---|---|---|
    | `heal` | every call | `maxHeal` |
    | `resolve` | only when `fp` equals the last fingerprint; otherwise records `fp`, count unchanged. Every call also adds 1 to `resolve_total`, refused past `maxResolveTotal` with `budget exhausted: resolve-total` | `maxResolve`, `maxResolveTotal` |
    | `review` | `fp` equals the last fingerprint (+1); a new fingerprint resets the count to 1 | `maxReviewRepeat` |
    | `resume` | every call | `maxResume` |

    Over limit → `{ ok: false, reason: 'budget exhausted: <key>' }`, nothing written. Callers run it in the same transaction as the drop insert.
  - `chargeResolveConflict(db, itemId, budgets): boolean` — +1 on `resolve`; false once over `maxResolve`.
  - `chargeNoChange(db, itemId, budgets): boolean` — +1 on `no_change`; false once over `maxNoChange`.
  - `chargeRateLimitRequeue(db, itemId): boolean` — +1 on `rate_limit`; false once over `RATE_LIMIT_REQUEUE_MAX`.
  - `refundCharge(db, itemId, key: AttemptKey): void` — −1, floor 0.

- [ ] **Step 1: Write failing tests**

```ts
test('heal stops at maxHeal', () => { for (let i = 0; i < 3; i++) expect(chargeBudget(db, 1, 'heal', `f${i}`, b).ok).toBe(true); expect(chargeBudget(db, 1, 'heal', 'f9', b)).toEqual({ ok: false, reason: 'budget exhausted: heal' }); });
test('a clean resolve on a new fingerprint is free', () => { for (const fp of ['a', 'b', 'c', 'd']) expect(chargeBudget(db, 1, 'resolve', fp, b).ok).toBe(true); expect(getAttempts(db, 1, 'resolve').count).toBe(0); });
test('resolve conflicts are charged', () => { expect(chargeResolveConflict(db, 1, b)).toBe(true); expect(chargeResolveConflict(db, 1, b)).toBe(true); expect(chargeResolveConflict(db, 1, b)).toBe(false); });
test('free resolves stop at maxResolveTotal', () => { for (let i = 0; i < 6; i++) expect(chargeBudget(db, 1, 'resolve', `f${i}`, b).ok).toBe(true); expect(chargeBudget(db, 1, 'resolve', 'f9', b)).toEqual({ ok: false, reason: 'budget exhausted: resolve-total' }); });
// also: 'review repeats only count on the same fingerprint'; 'rate-limit requeues stop after 3'; 'refundCharge restores one charge'
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- budgets` (expected FAIL); implement; run `npm test -w apps/server -- budgets` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): attempt budgets keyed by input fingerprints`

---

### Task 7: The lifecycle decision function

**Files:**
- Create: `apps/server/src/flow/decide.ts`
- Test: `apps/server/src/flow/decide.test.ts`

**Interfaces:**
- Consumes: `WorkItem`, `Drop`, `VerdictRow` (Task 1); `DropZoneConfig` (Task 3); `PullFacts`, `ForgeReview`, `CompareFacts`, `ChecksFacts` (Task 4); `OpResult` (Task 5); `fingerprint` (Task 6).
- Produces:
  - `Snapshot`:

    ```ts
    {
      item: WorkItem; zone: DropZoneConfig; now: Date;
      activeDrop: Drop | null;
      pr: PullFacts | null;
      issueState: 'open' | 'closed' | null;      // null = read failed
      branchSha: string | null;
      compare: CompareFacts | null;              // null = read failed
      checks: ChecksFacts;
      requiredChecks: string[];                  // from BranchRules; [] when none
      verdictsOnHead: VerdictRow[];              // verdicts with headSha === pr.headSha, oldest first
      reviewOp: OpResult | null;                 // post_review row of the latest verdict on head ("verdictPosted")
      mergeOp: OpResult | null;                  // row merge:<itemId>:<pr.headSha>
      trustedChangeRequests: ForgeReview[];      // trusted non-bot authors whose latest review is CHANGES_REQUESTED on pr.headSha
      humanBlockStanding: boolean;               // a trusted non-bot author's latest review is CHANGES_REQUESTED on another commit
      protectedHits: string[];                   // changed paths (and rename sources) matching zone.protectedPaths
      filesComplete: boolean;                    // PullFiles.complete
      gateScriptChanges: string[];               // gate-invoked scripts changed vs merge base; '<path> unreadable' for an unreadable package.json
      gateToolChanges: string[];                 // see Task 11 gateToolChanges
      protectionProblems: string[] | null;       // null = rules read unavailable; [] when safe or !zone.requireBranchProtection
      headFirstSeenAt: string;
      missingSince: string | null;               // work_items.waiting_since
    }
    ```

  - `Feedback = { source: 'human' | 'review' | 'ci'; text: string }`.
  - `Action` = `{ kind: 'wait'; on: 'drop' | 'ci' | 'forge' | 'outbox' }` | `{ kind: 'enqueue'; role: 'review' | 'heal' | 'resolve'; fingerprint: string; feedback?: Feedback }` | `{ kind: 'post_review'; verdictId: string }` | `{ kind: 'merge'; sha: string }` | `{ kind: 'done'; reason: string }` | `{ kind: 'park'; reason: string }` | `{ kind: 'none' }`.
  - `decide(s: Snapshot): Action` — pure; first matching rule wins. "Deadline" means `now − anchor > zone.ciDeadlineMinutes`; "wait `forge` (deadline)" means wait, and past the deadline from `missingSince` park `forge data missing: <what>`.

    | # | Condition | Action |
    |---|---|---|
    | 1 | `activeDrop` | wait `drop` |
    | 2 | `pr === null` | wait `forge` (deadline; `pr`) |
    | 3 | `pr.merged` or `mergeOp.state === 'done'` | done `merged` |
    | 4 | `pr.state === 'closed'` | park `pr closed` |
    | 5 | `pr.headSha === null` | wait `forge` (deadline; `head`) — GitHub lag, not an orphan |
    | 6 | `mergeOp.state` is `pending` or `unknown` | wait `outbox` (`resolveUnknown` resolves it or fails it at its deadline) |
    | 7 | `mergeOp.state === 'failed'` | park `merge rejected: <error>` |
    | 8 | `issueState === null` or `compare === null` | wait `forge` (deadline; `issue` / `compare`) |
    | 9 | `issueState === 'closed'` | `compare.aheadBy === 0` → done `already on base`; else park `issue closed` |
    | 10 | `branchSha === null` | park `agent branch deleted` |
    | 11 | `compare.aheadBy === 0` | done `already on base` |
    | 12 | `protectedHits.length > 0`, or `!filesComplete` | park `protected path: <first file>` (or `protected path: file list truncated`) |
    | 13 | `gateScriptChanges.length > 0` | park `gate script changed: <first>` |
    | 14 | `gateToolChanges.length > 0` | park `gate tool changed: <first>` |
    | 15 | `protectionProblems === null`; or non-empty | wait `forge` (deadline; `branch rules`); or park `unsafe branch protection: <problems joined>` |
    | 16 | `trustedChangeRequests.length > 0` | enqueue `heal`, fp `[headSha, 'human', ...review ids]`, feedback `human` from those review bodies |
    | 17 | any `verdictsOnHead` with `request_changes` | enqueue `heal`, fp `[headSha, <latest RC verdict id>]`, feedback `review` from that verdict |
    | 18 | `compare.behindBy > 0` | enqueue `resolve`, fp `[headSha, compare.baseSha]` (forge `mergeable` is never read; §5.1, POC bc8e9dd) |
    | 19 | `verdictsOnHead.length === 0` | enqueue `review`, fp `[headSha]` |
    | 20 | `humanBlockStanding` | park `human block stands` |
    | 21 | `reviewOp === null` | `post_review` for the latest verdict on head |
    | 22 | `reviewOp.state` is `pending` or `unknown` | wait `outbox` |
    | 23 | `reviewOp.state === 'failed'` | park `review post failed: <error>` |
    | 24 | `checks.state === 'failure'` | enqueue `heal`, fp `[headSha, 'ci']`, feedback `ci`: `CI failed on <sha>; reproduce with the gates and fix.` |
    | 25 | CI satisfied: (`checks.state === 'success'` and every `requiredChecks` name is in `checks.names`) or (`checks.state === 'none'` and `!zone.ciRequired` and `requiredChecks` empty) | merge `pr.headSha` |
    | 26 | deadline from `headFirstSeenAt` | park `no pipeline` when `checks.state === 'none'` and no required checks; else park `no CI result: missing <required names absent from checks.names>` (or `no CI result` when none is missing) |
    | 27 | otherwise | wait `ci` |

  - How the order resolves overlaps:
    - Active drop and any forge change: rule 1 waits; the change is judged after the drop finishes.
    - Merge op failed, then the head moves: the op key is per head, so `mergeOp` is null for the new head and the item is re-decided.
    - Issue closed and behind base, or closed and RC: rule 9 parks first.
    - Protected path, gate-script or gate-tool change, or unsafe protection, with anything else: rules 12–15 park before any review or heal spend.
    - Behind base and RC (agent or human): heal first (16–17), then resolve (18) on the healed head, then one review of the result. This costs one review instead of two.
    - Behind base and CI failure: resolve first (18 before 24), because the failure may come from the stale base.
    - Base changed a gate script: rule 13 compares head against the merge base, so a PR that is merely behind is not parked; rule 18 resolves it.
    - RC then approve on the same head (re-review after a lost lease or rate limit): rule 17 still sees the RC, so the item heals and never merges.
    - Approve on head with a human block on an older commit: rule 19 has already reviewed once; rule 20 parks.
    - Approved, but the review post is missing or unknown: rules 21–23 come before any merge.
    - CI green but a required check has not reported yet (CI lag): rule 25 fails, so it waits (27) or parks at the deadline naming the missing checks (26).

- [ ] **Step 1: Write failing tests**, one per rule plus these named cases:

```ts
test('head change invalidates approval', () => expect(decide(snap({ verdictsOnHead: [], pr: pr('sha2'), checks: ok }))).toMatchObject({ kind: 'enqueue', role: 'review' }));
test('request_changes then approve on the same sha never merges', () => expect(decide(snap({ verdictsOnHead: [rc('s'), approve('s')], checks: ok })).kind).not.toBe('merge'));
test('no CI honours ciRequired', () => {
  expect(decide(snap({ verdictsOnHead: [approve('s')], checks: none, zone: { ...z, ciRequired: false } }))).toEqual({ kind: 'merge', sha: 's' });
  expect(decide(snap({ verdictsOnHead: [approve('s')], checks: none, headFirstSeenAt: minutesAgo(46) }))).toEqual({ kind: 'park', reason: 'no pipeline' });
});
test('closed issue never blocks dispatch', () => expect(decide(snap({ issueState: 'closed', compare: cmp({ aheadBy: 2 }) }))).toEqual({ kind: 'park', reason: 'issue closed' }));
test('merge failed parks, merge unknown waits', () => { expect(decide(snap({ mergeOp: { state: 'failed', error: '405' } })).kind).toBe('park'); expect(decide(snap({ mergeOp: { state: 'unknown' } }))).toEqual({ kind: 'wait', on: 'outbox' }); });
test('unposted verdict is posted before merge', () => expect(decide(snap({ verdictsOnHead: [approve('s')], reviewOp: null, checks: ok })).kind).toBe('post_review'));
test('standing human block on an older commit parks after one review', () => { expect(decide(snap({ humanBlockStanding: true, verdictsOnHead: [] }))).toMatchObject({ kind: 'enqueue', role: 'review' }); expect(decide(snap({ humanBlockStanding: true, verdictsOnHead: [approve('s')] }))).toEqual({ kind: 'park', reason: 'human block stands' }); });
test('protected path parks', () => expect(decide(snap({ protectedHits: ['.github/workflows/ci.yml'] }))).toEqual({ kind: 'park', reason: 'protected path: .github/workflows/ci.yml' }));
test('unsafe protection parks before any review', () => expect(decide(snap({ protectionProblems: ['bot can bypass'], verdictsOnHead: [] }))).toEqual({ kind: 'park', reason: 'unsafe branch protection: bot can bypass' }));
test('unavailable branch rules wait', () => expect(decide(snap({ protectionProblems: null }))).toEqual({ kind: 'wait', on: 'forge' }));
test('deadline names the missing required check', () => expect(decide(snap({ verdictsOnHead: [approve('s')], checks: { state: 'success', names: ['lint'] }, requiredChecks: ['lint', 'test'], headFirstSeenAt: minutesAgo(46) }))).toEqual({ kind: 'park', reason: 'no CI result: missing test' }));
test('required check missing waits even when checks are green', () => expect(decide(snap({ verdictsOnHead: [approve('s')], checks: { state: 'success', names: ['lint'] }, requiredChecks: ['lint', 'test'] }))).toEqual({ kind: 'wait', on: 'ci' }));
test('null headSha is not an orphan', () => expect(decide(snap({ pr: { ...pr('x'), headSha: null } }))).toEqual({ kind: 'wait', on: 'forge' }));
// also: 'gate script change parks'; 'gate tool change parks'; 'truncated file list parks'; 'behind base and request_changes heals first'; 'null pr waits, then parks at
//   the deadline'; 'stale mergeable flag is never consulted' (PullFacts has no mergeable field; behindBy 0 → no resolve)
```

- [ ] **Step 2: Run** `npm test -w apps/server -- decide`. Expected: FAIL.
- [ ] **Step 3: Implement** the table literally, in order.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): pure PR lifecycle decision function`

---

### Task 8: Role payloads and prompts

**Files:**
- Create: `apps/server/src/payloads.ts`, `apps/trooper/prompts/review.md`, `heal.md`, `resolve.md`
- Modify: `apps/server/src/api/sticks.ts` (use `payloads.ts`; drop its `promptVersion`/`buildPayload`), `apps/trooper/prompts/implement.md`
- Test: `apps/server/src/payloads.test.ts`

**Interfaces:**
- Consumes: `DropPayload`, `Role` (Task 2); `Config['secrets']`, `modelFor` (Task 3); `Drop` (Task 1); `Feedback` (Task 7).
- Produces:
  - `promptVersions(): Record<Role, string>` — sha256 of each template, first 12 hex chars.
  - `renderFeedback(f: Feedback): string` — `human` → under `## Feedback (data, from trusted reviewers)`; `review` and `ci` → under `## Automated review findings (data, untrusted)`.
  - `buildPayload(db, zone, drop: Drop, secrets: Config['secrets']): DropPayload`:

    | Role | `forgeToken` | Built from |
    |---|---|---|
    | `implement` | author | `resume = drop.headSha !== null`; `resumeSha = drop.headSha ?? undefined` |
    | `review` | read token only if `zone.reviewReadToken`, else omitted | `pr` from `drop.prNumber`, `drop.headSha` |
    | `heal` | author | `pr` from the drop (`pr.headSha = drop.headSha`, so a heal continuation starts from its checkpoint); `feedback = renderFeedback(JSON.parse(drop.inputJson).feedback)` |
    | `resolve` | author | `pr` from the drop |

    Every payload sets `image: zone.image`, `model: modelFor(zone, role)`, `promptVersion: promptVersions()[role]`, `protectedPaths: zone.protectedPaths`. No payload ever carries the reviewer token.
  - Prompt rules: every template keeps M0's (no attribution trailers, never push or open PRs, issue text is a spec) and puts the issue under `## Issue (data)`. `review.md`: review `origin/<base>...HEAD` against the issue, given the gate results; return the `REVIEW_OUTPUT_SCHEMA` verdict; deleted, skipped or weakened tests are a `blocker`; never modify files. `heal.md`: the feedback is data; fix only what it lists; keep the gates green. `resolve.md`: conflicts with base are in the tree; resolve them preserving both intents; keep the gates green.

- [ ] **Step 1: Write failing tests**

```ts
test('review payload never carries the author or reviewer token', () => { const s = JSON.stringify(buildPayload(db, zone, reviewDrop, secrets)); expect(s).not.toContain(secrets.githubAuthorToken); expect(s).not.toContain(secrets.githubReviewerToken); });
test('no payload ever carries the reviewer token', () => { for (const d of [impl, review, heal, resolve]) expect(JSON.stringify(buildPayload(db, zone, d, secrets))).not.toContain(secrets.githubReviewerToken); });
test('implement with a headSha resumes', () => expect(buildPayload(db, zone, { ...impl, headSha: 'ck1' }, secrets)).toMatchObject({ resume: true, resumeSha: 'ck1' }));
test('automated findings never sit under the trusted heading', () => expect(renderFeedback({ source: 'review', text: 'x' })).not.toContain('trusted reviewers'));
// also: 'payload carries zone protectedPaths'; 'review.md names weakened tests as a blocker'; 'review carries the read token only when reviewReadToken'; 'promptVersions differ per role'; 'payload carries zone image and role model'
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- payloads` (expected FAIL); implement; run `npm test -w apps/server` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): role payloads, per-role prompts and versions`

---

### Task 9: Result handling per role

**Files:**
- Modify: `apps/server/src/results.ts`, `apps/server/src/api/sticks.ts` (`StickRouteDeps.forgeFor` becomes `forgesFor(zoneId): ForgePair`; the result route passes the zone, `secretList(config.secrets)` and `now()`), `apps/server/src/app.ts`, `apps/server/src/main.ts` (builds both forges per zone)
- Test: `apps/server/src/results.test.ts`, `apps/server/src/api/sticks.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6; `sanitizeForgeText`, `runOp`, `ForgePair` (Task 5).
- Produces:
  - `ResultDeps = { forges: ForgePair; zone: DropZoneConfig; secrets: string[]; usageCfg: UsageConfig }` (`usageCfg` is used from Task 10).
  - `applyResult(db, deps: ResultDeps, dropId: string, result: DropResult, now: Date): Promise<void>` — dispatches on `drop.role`. A drop already terminal is a no-op (stick retries are safe).
  - `renderReviewBody(v: Verdict, gates: GateResult[], secrets: string[]): string` — summary plus findings as a list, file names in code spans, all through `sanitizeForgeText`.

  | Role | Result | Effect |
  |---|---|---|
  | implement | `completed` | `create_pr` op `pr:<itemId>:<result.headSha>` (title = issue title; body as M0 plus marker). `done` → `upsertPullRequest`, item `pr_open`. `unknown` → item stays `in_flight` (adoption picks it up, or reconcile step 3 resumes once the row resolves or fails). `failed` → park `create pr failed: <error>` |
  | implement | `interrupted` | `chargeBudget(resume)`; exhausted → park. Else queue an implement drop with `headSha = result.headSha ?? drop.headSha`, `chargedKey: 'resume'`; item stays `in_flight` |
  | implement | `no_changes` | `chargeNoChange`: within budget → `ready`; else park `no_changes` |
  | implement | `failed` / `blocked` | park with the reason (M0) |
  | review | `completed` + `verdict` | decision forced to `request_changes` (`forced: true`) if any gate failed or timed out. `insertVerdict` with `id = dropId`, `headSha = drop.headSha`. Then `post_review` op `review:<itemId>:<drop.headSha>:<dropId>` via reviewer, event from the stored decision, `commitId = drop.headSha`, body `renderReviewBody`. Item stays `pr_open` |
  | review | `completed` without `verdict` | treated as `failed`, reason `review returned no verdict` |
  | review | `failed` (any reason) | drop `failed`; item stays `pr_open`; the next same-head review is charged against `maxReviewRepeat` |
  | heal / resolve | `completed` | `upsertPullRequest` with `result.headSha`; resolve with `mergeOutcome === 'conflicts'` → `chargeResolveConflict` |
  | heal / resolve | `no_changes` | recorded; item stays `pr_open` (re-decided; heal budget parks a heal that pushes nothing) |
  | heal | `interrupted` | with `headSha`: `chargeBudget(resume)` (park on exhaustion), then queue a heal continuation with the same `fingerprint`, `prNumber`, `inputJson`, `headSha = result.headSha`, `chargedKey: 'resume'`. Without `headSha`: as `no_changes` |
  | heal / resolve | `failed` with reason starting `head moved` or `stale info` | drop `failed`; item stays `pr_open`; charge stands |
  | heal / resolve | other `failed` / `blocked` (including `protected path <f>` and `foreign commit identity` from the push guard) | park with the reason |
  | any | `rate_limited` | drop `cancelled`. Requeue when the usage state is paused (`status === 'rejected'` or `pausedUntil > now`) and either `drop.id === probeDropId` (free) or `chargeRateLimitRequeue` succeeds: `refundCharge(drop.chargedKey)` (if set), same role, fingerprint, `prNumber`, `inputJson`, `headSha = result.headSha ?? drop.headSha`. Else park `rate limit: requeue refused` |

- [ ] **Step 1: Write failing tests**, one per table row, plus:

```ts
test('review result posted twice gives one verdict and one review', async () => { await applyResult(db, deps, 'd1', approveResult, t0); await applyResult(db, deps, 'd1', approveResult, t0); expect(count(db, 'verdicts')).toBe(1); expect(f.reviewer.calls.filter(c => c.method === 'createReview')).toHaveLength(1); });
test('a red review gate forces request_changes', async () => { await applyResult(db, deps, 'd1', { ...approveResult, gates: [redGate] }, t0); expect(latestVerdict(db, 1)).toMatchObject({ decision: 'request_changes', forced: true }); });
test('interrupted implement charges resume and carries the checkpoint', async () => { /* → new queued implement drop with headSha 'ck1', chargedKey 'resume' */ });
// also: 'verdict text is redacted before posting'; 'three interruptions park'; 'heal head moved leaves the item pr_open'; 'rate_limited is requeued only while
//   usage is rejected'; 'rate_limited stops after three requeues'; 'a rate-limited probe drop is requeued free'; 'heal interrupted with a checkpoint queues a
//   continuation charged to resume'; 'create_pr is keyed by head'; 'the result route uses forgesFor and now()' (api/sticks.test.ts via app.inject)
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- results sticks` (expected FAIL); implement; run `npm run typecheck && npm test -w apps/server` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): per-role result handling through the outbox`

---

### Task 10: Usage state, dispatch gate and role-aware leases

**Files:**
- Create: `apps/server/src/usage.ts`
- Modify: `apps/server/src/leases.ts`, `apps/server/src/scheduler.ts`, `apps/server/src/results.ts` (ingest `result.rateLimit` first; `releaseProbe` last), `apps/server/src/api/sticks.ts` (lease route passes the gate; events route ingests), `apps/server/src/main.ts`
- Test: `apps/server/src/usage.test.ts`, `apps/server/src/leases.test.ts`, `apps/server/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `RateLimitEventData` (Task 2); `UsageConfig` (Task 3); usage repo functions (Task 1).
- Produces:
  - `Gate = 'open' | 'finishing_only' | 'probe' | 'closed'`.
  - `RateLimitSource = { dropId: string; workItemId: number; startedAt: string | null; outcome: DropResult['status'] | null }` (`outcome` null = a live event).
  - `ingestRateLimit(db, data: RateLimitEventData, src: RateLimitSource, cfg: UsageConfig, now: Date, rand: () => number = Math.random): void`:
    - Sources: the events route passes live events (`outcome: null`), parsed with `RateLimitEventDataSchema`, falling back to `data.raw.rate_limit_info` (epoch-seconds `resetsAt` normalized to ISO). `applyResult` passes `result.rateLimit` with the accepted outcome **before** its table runs.
    - Utilization: always stored when present (never assumed 0), with `observedAt = now` and each window's `resetsAt`.
    - `rejected` pauses only when `outcome` is non-null and not `completed`. Missing or unparseable `resetsAt` → ignored. `target = min(resetsAt, now + window) + jitter` (window 5 h for `five_hour`, else 7 d); a past `resetsAt` gives `now + jitter`.
      - No pause in force: `pausedUntil = min(target, now + 1 h)`, `pauseConfirmed = false`, `pausedAt = now`, `causeDropId`, `causeWorkItemId`; clears `probeDropId`.
      - Unconfirmed pause, and `src.dropId !== causeDropId` (a second distinct drop, or the probe): `pauseConfirmed = true`, `pausedUntil = max(pausedUntil, target)`.
    - `allowed` / `allowed_warning` clear `pausedUntil`, `probeDropId` and `probeNotBefore` only when `src.dropId === probeDropId` or `src.startedAt > pausedAt`; otherwise they update utilization only.
  - `dispatchGate(db, cfg: UsageConfig, now: Date): Gate`:

    | Gate | When |
    |---|---|
    | `closed` | `now < pausedUntil`, or `now < probeNotBefore` |
    | `probe` | `status === 'rejected'` and `pausedUntil` has passed |
    | `finishing_only` | `status === 'allowed_warning'` or a utilization ≥ `throttleUtilization`, and that observation has not expired (window `resetsAt`, fallback `observedAt` + 5 h / 7 d) |
    | `open` | otherwise |

  - `releaseProbe(db, dropId: string, cfg: UsageConfig, now: Date, rand?: () => number): void` — if `dropId === probeDropId`, clear it; when no `allowed` event arrived, set `probeNotBefore = now + jitter`. Called whenever a drop becomes terminal (`applyResult`, `expireLeases`).
  - `leaseNextDrop(db, stickId, now, gate: Gate = 'open')`:

    | Gate | Behaviour |
    |---|---|
    | `closed` | null |
    | `probe` | null if `probeDropId` is set; else lease one drop, preferring one whose `workItemId !== causeWorkItemId`; if no other item's drop is queued, the cause item's drop is the probe. Record it as `probeDropId` |
    | `finishing_only` | only `review`, `heal`, `resolve` drops |
    | `open` | as M0 |

    Sets `started_at` at lease time (M0 elapsed fix).
  - `enqueueImplement(db, zone, item: WorkItem, o: { headSha: string | null; chargedKey: AttemptKey | null; promptVersion: string }, usageCfg: UsageConfig, now: Date): string | null` — the single implement insert path: refuses unless the gate is `open` or `probe` and no implement drop is active in the zone; a `one_active_drop` constraint error returns null; sets the item `in_flight`.
  - `enqueueNext(db, zone, promptVersion: string, usageCfg: UsageConfig, now: Date): string | null` — the top-ranked `ready` item through `enqueueImplement` (at most one active implement drop per zone, not one drop per zone).
  - `expireLeases(db, now, usageCfg: UsageConfig)` is role-aware: a lost implement drop keeps M0 behaviour (item → `ready` after grace); a lost review, heal or resolve drop leaves the item `pr_open`. It calls `releaseProbe` for each lost drop.

- [ ] **Step 1: Write failing tests**

```ts
test('a confirmed rejected pauses until resetsAt plus jitter', () => { ingestRateLimit(db, rej('2026-10-20T12:00:00Z'), src('d1', 'rate_limited'), cfg, t0, () => 0); ingestRateLimit(db, rej('2026-10-20T12:00:00Z'), src('d2', 'rate_limited'), cfg, t0, () => 0); expect(dispatchGate(db, cfg, at('12:00:29'))).toBe('closed'); expect(dispatchGate(db, cfg, at('12:00:31'))).toBe('probe'); });
test('an unconfirmed pause is capped at one hour', () => { ingestRateLimit(db, rej('2026-10-20T12:00:00Z'), src('d1', 'rate_limited'), cfg, t0, () => 0); expect(dispatchGate(db, cfg, plus(t0, H + 1000))).toBe('probe'); });
test('a live event or a completed drop never pauses', () => { ingestRateLimit(db, rej(future), src('d1', null), cfg, t0); ingestRateLimit(db, rej(future), src('d2', 'completed'), cfg, t0); expect(dispatchGate(db, cfg, t0)).toBe('open'); });
test('a late allowed from an older drop does not reopen the gate', () => { pause(t0); ingestRateLimit(db, { status: 'allowed' }, src('old', null, startedBefore(t0)), cfg, plus(t0, MIN)); expect(dispatchGate(db, cfg, plus(t0, MIN))).toBe('closed'); });
test('with only the cause item queued, its requeued drop leases as the probe', () => { confirmedPause(rej(t1), t0, { item: 1 }); requeue(1); expect(leaseNextDrop(db, 's', plus(t1, 91_000), 'probe')?.dropId).toBe(requeuedId); expect(getUsageState(db).probeDropId).toBe(requeuedId); });
test('a far-future resetsAt is clamped to the window', () => { confirmedPause(rej('2099-01-01T00:00:00Z', 'five_hour'), t0); expect(dispatchGate(db, cfg, plus(t0, 5 * H + 31_000))).toBe('probe'); });
test('utilization at 0.9 throttles', () => { ingestRateLimit(db, { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.9 } } }, src('d1', null), cfg, t0); expect(dispatchGate(db, cfg, t0)).toBe('finishing_only'); });
test('a utilization observed 8 days ago has expired', () => expect(dispatchGate(db, cfg, plus(t0, 8 * DAY))).toBe('open'));
// also: 'a past resetsAt pauses for one jitter'; 'rejected without resetsAt is ignored'; 'probe allows exactly one lease'; 'a probe drop that fails without an event reopens after one
//   jitter'; 'warning allows finishing roles only'; 'missing unifiedWindows is not treated as zero'; 'the raw rate_limit_info fallback is parsed'; 'started_at
//   is set at lease time'; 'the probe is never the cause item'; 'lost review drop leaves the item pr_open'; 'a review drop for item A does not block implement for item B'; 'enqueueImplement refuses a second
//   implement in the zone'
```

- [ ] **Step 2: Run** `npm test -w apps/server -- usage leases scheduler`. Expected: FAIL.
- [ ] **Step 3: Implement.** The existing `leases.test.ts` keeps compiling through the default `gate`.
- [ ] **Step 4: Run** `npm test -w apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): usage pause, probe and throttle; role-aware leases`

---

### Task 11: Snapshot, guards and the reconciler

**Files:**
- Create: `apps/server/src/flow/guards.ts`, `apps/server/src/flow/snapshot.ts`, `apps/server/src/flow/reconcile.ts`
- Test: `apps/server/src/flow/guards.test.ts`, `apps/server/src/flow/snapshot.test.ts`, `apps/server/src/flow/reconcile.test.ts`

**Interfaces:**
- Consumes: Tasks 1–10 (`decide`, `Snapshot`, `Action`, `runOp`, `resolveUnknown`, `chargeBudget`, `enqueueImplement`, `enqueueNext`, `BranchRulesRead`, `PullFiles`).
- Produces:
  - `protectedPathHits(files: PullFiles['files'], globs: string[]): string[]` — checks both `path` and `previousPath`; `matchesGlob` from `node:path`; a pattern without `/` also matches the basename at any depth.
  - `invokedScripts(gates: GateSpec[], pkg: Record<string, string>): Set<string> | 'all'` — names from gate commands (`npm test|t|start|stop|restart`, `npm run[-script] <name>`, `npm -w <ws> run <name>`, `node --run <name>`, `pnpm|yarn [run] <name>`), closed transitively over script bodies (whole-word references, `run-p`/`run-s`/`npm-run-all` `name:*` globs), plus `pre<name>`/`post<name>` of each. Any gate command it cannot classify returns `'all'` (fail closed).
  - `gateScriptChanges(gates: GateSpec[], basePkg: string | null, headPkg: string | null): string[]` — `basePkg` is the file at `compare.mergeBaseSha`, never the base tip. Returns invoked names (from either side) whose script text differs, including added or removed. The reconciler applies it to every changed `package.json`; one it cannot read yields `<path> unreadable`.
  - `gateToolChanges(gates: GateSpec[], basePkg: string | null, headPkg: string | null, baseLock: string | null, headLock: string | null): string[]` — same merge-base comparison (`package-lock.json` read beside each changed `package.json`). Reports: any package added or changed in the lockfile's v2/v3 `packages` entries with `hasInstallScript: true`, as `install script: <pkg>`; `lockfile unreadable` (fail closed) when the lockfile is missing or unreadable while `package.json` dependencies changed; any added or changed dependency spec using `npm:`, `file:`, `link:`, `git`, `http` or `github:`; any `overrides`/`resolutions` change; any change of the `jest`, `mocha` or `vitest` keys; a version change of a package whose bin is the first word of an invoked script body.
  - `branchProtectionProblems(rules: { author: BranchRulesRead; reviewer: BranchRulesRead }, zone: DropZoneConfig): string[] | null` — null if either read is `unavailable`; else `no ruleset`, `approvals < 1`, `stale approvals not dismissed`, `bot can bypass`, `bot is admin`, `required check not pinned: <name>`, `no required checks` (only when `ciRequired`).
  - `ZonePass = { botLogins: string[]; requiredChecks: string[]; protectionProblems: string[] | null }`; `zonePass(forges: ForgePair, zone, baseBranch: string): Promise<ZonePass>` — read once per zone per pass.
  - `buildSnapshot(db, forges: ForgePair, zone, item: WorkItem, pass: ZonePass, now): Promise<Snapshot>`:
    - It reads `getPull`, `getIssueState`, `branchSha`, `compare(base, headSha)`, `checksFor(headSha)`, `listReviews`, `listPullFiles` fresh, and `getFileAt` at `mergeBaseSha` and at head for each changed `package.json` and its sibling `package-lock.json`. A thrown read gives `null` for that field.
    - It upserts `pull_requests`, and sets `waiting_since` when a field is null (clears it otherwise).
    - Reviews: drop the bot logins and bodies containing `jm:op:`, keep only `isTrusted` authors (fail closed), and take each author's latest review. That review being `CHANGES_REQUESTED` on head goes to `trustedChangeRequests`; on another commit it sets `humanBlockStanding`.
    - `reviewOp` and `mergeOp` come from `getOutbox`.
  - `ReconcileReport = { actions: number; merges: number }`.
  - `reconcileZone(db, forges: ForgePair, zone, versions: Record<Role, string>, usageCfg: UsageConfig, secrets: string[], now): Promise<ReconcileReport>` — in order:
    1. `resolveUnknown(db, forges, zone.id, now, zone.ciDeadlineMinutes)`.
    2. **Adoption:** one `listOpenAgentPulls('agent/issue-')` call. PRs authored by the author bot whose issue maps to a `ready`/`in_flight` item with no active drop and no `pull_requests` row → `upsertPullRequest`, item `pr_open`.
    3. **Resume (R12):** a `ready` item, or an `in_flight` item with no active drop, no PR row and no `pending`/`unknown` `create_pr` row, whose `branchSha(agentBranch(n))` is non-null → `chargeBudget(resume)` (park on exhaustion) and `enqueueImplement` with `headSha` = that SHA, `chargedKey: 'resume'` (the per-zone cap applies; a refusal rolls the charge back). An `in_flight` item in that state without a branch returns to `ready`.
    4. For each `pr_open` item: `buildSnapshot`, `decide`, apply:
       - `enqueue`: in one transaction, `chargeBudget(role key, fp)` (park on failure) and `insertDrop` with `role`, `fingerprint`, `prNumber`, `headSha`, `inputJson = JSON.stringify({ feedback })`, `promptVersion = versions[role]`, `chargedKey`. A `one_active_drop` error rolls back and counts as "already active".
       - `post_review`: re-run the verdict's op (same key and body as Task 9).
       - `merge`: at most one per zone per pass; `runOp` `merge:<itemId>:<sha>` with `title = pr.title`, `message = 'Closes #<issue>'`, `method = zone.mergeMethod` (squash-only in M1); `done` → item `done`/`merged`; other states are judged on the next pass.
       - `park` / `done`: set state and reason. `wait` / `none`: nothing.
    5. `enqueueNext(db, zone, versions.implement, usageCfg, now)`.

- [ ] **Step 1: Write failing tests**

```ts
test('protectedPathHits matches nested CODEOWNERS and jumpmaster*.json', () => expect(protectedPathHits(['docs/CODEOWNERS', 'jumpmaster.prod.json', 'src/a.ts'], defaults)).toEqual(['docs/CODEOWNERS', 'jumpmaster.prod.json']));
test('gate script change is detected through npm run indirection', () => expect(gateScriptChanges([{ name: 't', run: 'npm test' }], pkg({ test: 'npm run unit', unit: 'vitest' }), pkg({ test: 'npm run unit', unit: 'exit 0' }))).toEqual(['unit']));
test('gate script compare uses the merge base, not the base tip', async () => { f.state.files.set('base-tip:package.json', pkg({ test: 'vitest --changed' })); expect((await snapshotOf(behindItem)).gateScriptChanges).toEqual([]); });
test('pretest hooks and unclassified gate commands fail closed', () => { expect(gateScriptChanges([{ name: 't', run: 'npm test' }], pkg({ test: 'vitest' }), pkg({ test: 'vitest', pretest: 'x' }))).toEqual(['pretest']); expect(invokedScripts([{ name: 't', run: 'turbo test' }], pkg({}))).toBe('all'); });
test('gateToolChanges flags an npm: alias for the runner', () => expect(gateToolChanges(g, pkg({}, { vitest: '^3' }), pkg({}, { vitest: 'npm:evil@1' }))).toEqual(['vitest: npm:evil@1']));
test('a new dependency with an install script is a gate tool change', () => expect(gateToolChanges(g, pkg({}), pkg({}, { leftpad: '^1' }), lock({}), lock({ 'node_modules/leftpad': { version: '1.0.0', hasInstallScript: true } }))).toEqual(['install script: leftpad']));
test('changed dependencies with an unreadable lockfile fail closed', () => expect(gateToolChanges(g, pkg({}), pkg({}, { a: '1' }), lock({}), null)).toEqual(['lockfile unreadable']));
test('a rename out of a protected path is a hit', () => expect(protectedPathHits([{ path: 'x.yml', previousPath: '.github/workflows/ci.yml' }], defaults)).toEqual(['.github/workflows/ci.yml']));
test('snapshot excludes both bots from trust', async () => { f.state.reviews.push(review({ author: 'reviewer-bot', state: 'CHANGES_REQUESTED' })); expect((await snapshotOf(item)).trustedChangeRequests).toEqual([]); });
test('merge rejected parks without a second merge call', async () => { f.author.failNext('merge', { status: 405 }); await pass(); await pass(); expect(calls('merge')).toHaveLength(1); expect(workItem(db, 1)).toMatchObject({ state: 'parked', reason: expect.stringMatching(/^merge rejected/) }); });
// also: 'adding a dependency is not a gate script change'; 'branchProtectionProblems lists every missing setting'; 'snapshot sees a standing human block on an
//   older commit'; 'a failed trust lookup is untrusted'; 'adoption uses one listing call per pass'; 'adoption ignores PRs from other authors'; 'a ready item
//   with an existing branch resumes with resumeSha'; 'an in_flight item with no drop and no PR resumes' ; 'resume respects the one-implement-per-zone cap';
//   'branchProtectionProblems returns null when a read is unavailable'; 'charge and drop insert are one transaction' (insert throws → attempts unchanged); 'merge sets the title
//   and Closes #N'
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- flow` (expected FAIL); implement; run `npm test -w apps/server -- flow` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): fresh snapshots, merge guards and the per-zone reconciler`

---

### Task 12: Flow harness and lifecycle tests

**Files:**
- Create: `apps/server/src/test/flowHarness.ts`
- Test: `apps/server/src/flow/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1–11; `createApp` and `app.inject` for result posting.
- Produces: `harness(opts?: { zone?: Partial<DropZoneConfig>; issues?: ForgeIssue[] }): Promise<Harness>`. `Harness` has `db`, `forge: { author; reviewer; state }` (Task 5 pair), `zone`, `now()`, `at(minutes)` (advances the injected clock), `sync()` = `syncDropZone`, `reconcile()` = `syncDropZone` + `reconcileZone`, `queuedRoles(): Role[]`, `wipeDbKeepIssues()`. `lease(): Promise<{ dropId; epoch; payload: DropPayload }>` and `postResult(dropId, epoch, result): Promise<number>` (HTTP status) go through `app.inject`, so the route's live-epoch check runs; `finishDrop(role, result)` = lease + post. It uses `leaseWaitMs: 0` and `rand: () => 0`, and never reads the wall clock.

- [ ] **Step 1: Write failing tests**

```ts
test('happy path: implement → review approve → merge', async () => { /* finishDrop implement completed sha1 → reconcile → review queued → finishDrop review approve → reconcile (posts) → reconcile → merged */ expect(h.forge.state.merges).toEqual([{ number: 1, sha: 'sha1', title: 'Issue 1', message: 'Closes #1' }]); expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' }); });
test('adopts an existing agent PR', async () => { h.forge.state.addPull({ number: 9, headRef: 'agent/issue-1', headSha: 's', author: 'author-bot' }); h.wipeDbKeepIssues(); await h.reconcile(); expect(workItem(h.db, 1)).toMatchObject({ state: 'pr_open' }); expect(h.queuedRoles()).toEqual(['review']); });
test('interrupted implement resumes with resume:true', async () => { /* finishDrop implement interrupted ck1 → lease → payload.resume === true, resumeSha 'ck1' */ });
test('stale epoch result is rejected', async () => expect(await h.postResult(id, epoch - 1, r)).toBe(409));
// also: 'request_changes → heal → re-review on the new head'; 'restore after a merge never merges twice'; 'three PRs approved, one merges, the others resolve
//   cleanly without charge'; 'one merge per zone per pass'
```

- [ ] **Step 2: Run** `npm test -w apps/server -- lifecycle`. Expected: FAIL.
- [ ] **Step 3: Implement** the harness only; a lifecycle test that fails because of production code is reported to the controller, not patched here.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `test(server): flow harness and lifecycle tests`

---

### Task 13: Sync (retry label, reopen) and server wiring

**Files:**
- Modify: `apps/server/src/sync.ts`, `apps/server/src/main.ts`, `apps/server/src/test/flowHarness.ts` (`sync()` passes the pair)
- Test: `apps/server/src/sync.test.ts`, `apps/server/src/flow/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1–12.
- Produces:
  - `syncParked(db, forges: ForgePair, zone, pass: ZonePass, now): Promise<{ retried: number; reopened: number }>` — for each parked item, one `getIssueLabels` call:
    - **Retry label:** if `zone.retryLabel` is present and `retryLabelSeen` is false → `resetAttempts`, `deleteFailedOutbox`, set `retryLabelSeen`, item → `pr_open` if it has a PR row, else `ready` (an existing branch is then resumed by reconcile step 3). Label absent → `retryLabelSeen = false`.
    - **Reopen / landed:** reason `pr closed` or `issue closed` → re-read the PR and issue. Both open → `pr_open`. PR merged → `done`/`merged`. Reason starting `merge rejected` → re-read the PR: merged → `done`/`merged`; open and not merged → stays parked.
    - **Cause gone:** reason `human block stands` or `unsafe branch protection: …` → `buildSnapshot` + `decide`; unless the result is the same park, the item returns to `pr_open`.
  - `syncDropZone(db, forges: ForgePair, zone, now)` calls `zonePass` and then `syncParked` at its end; its return type gains `retried` and `reopened`.
  - `main.ts` builds a `ForgePair` per zone, runs `markPendingUnknown(db, now)` once at startup, and on each poll pass runs, per zone sequentially, `expireLeases`, `syncDropZone`, `reconcileZone`.

- [ ] **Step 1: Write failing tests**

```ts
test('reopened PR and issue un-park', async () => { /* park 'pr closed' → state.reopen(1) → sync → pr_open */ });
test('retry after merge rejected clears the failed op and merges', async () => { /* park 'merge rejected' → fix protection → label → sync → reconcile */ expect(calls('merge')).toHaveLength(2); expect(workItem(db, 1).state).toBe('done'); });
test('a dismissed human block un-parks without the label', ...);
test('a merge rejected park whose PR did merge becomes done', async () => { park(1, 'merge rejected: unresolved after 45 min'); f.state.markMerged(1); await h.sync(); expect(workItem(db, 1)).toMatchObject({ state: 'done', reason: 'merged' }); });
// also: 'retry label resets budgets once'; 'retry label on a closed-PR park resumes from the existing branch'; 'a parked item whose PR was merged by a human
//   becomes done'; 'startup turns pending outbox rows into unknown'
```

- [ ] **Steps 2–4:** run `npm test -w apps/server -- sync lifecycle` (expected FAIL); implement; run `npm run typecheck && npm test -w apps/server` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): retry label, reopen recovery and reconciler wiring`

---

### Task 14: Trooper privilege primitives

**Files:**
- Create: `apps/trooper/src/privilege.ts`
- Test: `apps/trooper/src/privilege.test.ts`

**Interfaces:**
- Produces:
  - `AgentIdentity = { uid: number; gid: number; home: string }` (any unprivileged uid); `TrooperIdentities = { agent: AgentIdentity; gate: AgentIdentity }`.
  - `trooperIdentities(env: NodeJS.ProcessEnv, getuid: () => number = process.getuid): TrooperIdentities | null` — from `JM_AGENT_UID/GID/HOME` and `JM_GATE_UID/GID/HOME`, only when `env.JM_CONTAINER === '1'` and `getuid() === 0`.
  - `sweepUid(uid: number, kill = process.kill): number` — scans `/proc/*/status`, SIGKILLs every process with that real or effective uid, returns the count.
  - `agentSpawnOptions(id: AgentIdentity | null, env: NodeJS.ProcessEnv): { uid?: number; gid?: number; umask?: number; env: NodeJS.ProcessEnv }` — with an identity: `uid`, `gid`, `HOME = id.home`, `CLAUDE_CONFIG_DIR = <home>/.claude` (mode 0700), `umask` 0022; without one: `env` unchanged. Used for both the agent and the gate identity.
  - `asAgentArgv(id: AgentIdentity | null, argv: string[]): string[]` — `['setpriv', '--reuid=<uid>', '--regid=<gid>', '--clear-groups', '--', ...argv]`, or `argv` when `id` is null.
  - `readAgentFile(path: string, id: AgentIdentity | null, maxBytes = 1_048_576): Promise<string>` — with an identity it reads through `asAgentArgv(id, ['cat', '--', path])`. Without one it uses `lstat` (regular file only), then `open` with `O_NOFOLLOW`. Over `maxBytes` throws.

- [ ] **Step 1: Write failing tests**

```ts
test('no identity outside container mode', () => expect(trooperIdentities({}, () => 0)).toBeNull());
test('no identity when not root', () => expect(trooperIdentities(containerEnv, () => 1000)).toBeNull());
test('gate and agent are distinct uids with distinct homes', () => { const ids = trooperIdentities(containerEnv, () => 0)!; expect(ids.gate.uid).not.toBe(ids.agent.uid); expect(ids.gate.home).not.toBe(ids.agent.home); });
test('sweepUid kills only that uid', ...);
test('spawn options use umask 0022 and no supplementary group', () => { const o = agentSpawnOptions(ids.agent, {}); expect(o.umask).toBe(0o022); expect(asAgentArgv(ids.agent, ['x'])).toContain('--clear-groups'); });
test('readAgentFile refuses a symlink', async () => { symlinkSync('/etc/hostname', p); await expect(readAgentFile(p, null)).rejects.toThrow(); });
// also: 'identity in container as root'; 'spawn options set uid, HOME and CLAUDE_CONFIG_DIR'; 'asAgentArgv wraps with setpriv'
```

- [ ] **Step 2: Run** `npm test -w apps/trooper -- privilege`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS (CI runs non-root; uid paths are pure).
- [ ] **Step 5: Commit** `feat(trooper): agent identity and privilege helpers`

---

### Task 15: Trooper git — root mirror, agent-uid working copy, guarded pushes

**Files:**
- Modify: `apps/trooper/src/git.ts`
- Test: `apps/trooper/src/git.test.ts`

**Interfaces:**
- Consumes: `AgentIdentity`, `asAgentArgv` (Task 14); `MergeOutcome` (Task 2).
- Produces (every working-copy function gains a trailing `as: AgentIdentity | null = null` and runs git under that identity):
  - `runGit(cwd, args, token = '', opts?: { as?: AgentIdentity | null; gitDir?: string; extraConfig?: [string, string][] }): Promise<string>` — the auth header stays `GIT_CONFIG_KEY_0`; `extraConfig` appends at index 1+; `as` with a token throws. A root call (no `as`) requires `gitDir`, sets `GIT_DIR=<gitDir>` and `GIT_CEILING_DIRECTORIES=<parent of gitDir>`, and first runs `assertRootOwnedDir(gitDir)`.
  - `assertRootOwnedDir(path, getuid = process.getuid): void` — `lstat` on every path component from `/` down to `path`: each a directory, not a symlink, and (when running as root) owned by uid 0 and not group- or other-writable; else throws `unsafe root git dir: <component>`.
  - Layout: `work/` (root, 0755) holds `work/mirror` (root bare mirror) and `work/push` (fresh pristine bare per push). The working copy is `<agent home>/repo`, or `<workdir>/repo` without an identity.
  - `cloneRepo(o: { owner; name; token; dir; mirrorDir?: string; url?; as?: AgentIdentity | null }): Promise<void>` — M0 signature plus optional fields (`mirrorDir` defaults to the sibling `mirror`). Root runs `git clone --bare` with the token into `mirrorDir`; the agent then runs `git clone --no-hardlinks file://<mirrorDir> <dir>`, without a token.
  - `mirrorFetch(mirrorDir, token, target, refs: string[]): Promise<void>` — root, in the mirror only; runs before any agent process for that step.
  - `prepareBranch`, `commitIfDirty`, `headSha`, `aheadOfBase`: unchanged signatures plus `as`.
  - `remoteBranchSha(target, branch, token): Promise<string | null>` — replaces `remoteBranchExists`.
  - `checkoutBranch(dir, branch, expectedSha, as): Promise<void>` — after `mirrorFetch`, the agent fetches from the mirror and checks out; throws `head moved: expected <a> got <b>`.
  - `mergeBase(dir, base, as): Promise<MergeOutcome>` — `git merge --no-edit origin/<base>` as Jumpmaster Agent; conflicts stay in the tree.
  - `PushOptions = { as?: AgentIdentity | null; base?: string; protectedPaths?: string[] }`.
  - `pushNewBranch(dir, branch, token, target, sweep?, o?: PushOptions)` and `pushExistingBranch(dir, branch, token, target, expectedRemoteSha, sweep?, o?: PushOptions): Promise<string>`. Root creates `work/push` and fetches from `file://<dir>` exactly `+refs/heads/<branch>:refs/heads/<branch>` with `--upload-pack='<asAgentArgv(as, ["git-upload-pack"])>'`, killed after `PUSH_FETCH_TIMEOUT_MS = 120_000` or once `work/push` exceeds `PUSH_FETCH_MAX_BYTES = 1 GiB` (polled each second). With `base` set, root then fetches `refs/heads/<base>` from `work/mirror` (refreshed with the token just before) into `work/push` as `refs/jm/base`, a local root-to-root fetch, and runs `prePushCheck` in that root-owned bare repo, and pushes from it (existing branch: `--force-with-lease=refs/heads/<branch>:<expectedRemoteSha>`). `GIT_DIR` and `GIT_COMMON_DIR` point at the bare repo (M0 `commondir` finding). A rejected lease throws `stale info: <stderr tail>`.
  - `prePushCheck(bareDir, branch, protectedPaths, since: string): Promise<string | null>` — root, bare repo only, `--no-replace-objects`; never reads a ref fetched from the agent repo other than `refs/heads/<branch>`. `git diff --name-status -M refs/jm/base...<branch>`: any path or rename source matching `protectedPaths` → `protected path <f>`. `git log --format=%an%x00%ae%x00%cn%x00%ce <since>..<branch>`, where `since` is `expectedRemoteSha` for an existing branch and `refs/jm/base` for a new one, so only the commits this push adds are checked: any author or committer other than Jumpmaster Agent → `foreign commit identity`. Human commits already on the remote pass. A non-null result is thrown and nothing is pushed.
  - `removeTree(dir, as): Promise<void>` — `rm -rf` through `asAgentArgv` (root has no `DAC_OVERRIDE`).
  - `cloneForGates(agentDir, gateDir, ids: TrooperIdentities): Promise<void>` — the agent runs `git bundle create <agent home>/gates.bundle HEAD` (0644); the gate uid runs `git clone <bundle> <gateDir>` (`/home/gate/repo`, recreated each time). No git process runs in the other uid's repo.
  - Root never runs git with `cwd` or `GIT_DIR` inside the working copy.

- [ ] **Step 1: Write failing tests**

```ts
test('planted fsmonitor, hook and clean filter never run on the root path', async () => { /* agent repo: core.fsmonitor + pre-commit + filter.x.clean with .gitattributes, each writing a marker file; run pushExistingBranch(as=null) */ expect(existsSync(marker)).toBe(false); });
test('a symlinked or renamed mirror makes mirrorFetch throw', async () => { renameSync(mirror, mirror + '.x'); symlinkSync(evilRepo, mirror); await expect(mirrorFetch(mirror, 't', target, ['main'])).rejects.toThrow(/unsafe root git dir/); });
test('every token-bearing git call sets GIT_DIR outside the working copy', async () => { /* recorder via injected spawn */ });
test('push refuses a protected path, including a rename source', async () => { /* commit mv .github/x.yml y.yml */ await expect(pushExistingBranch(dir, b, 't', target, s0, undefined, { base: 'main', protectedPaths: ['.github/**'] })).rejects.toThrow(/^protected path \.github\/x\.yml/); expect(remoteTip()).toBe(s0); });
test('push refuses a commit with a foreign author', ...);
test('an agent origin/<base> pointing at its own tip does not bypass the guard', async () => { agentGit(['update-ref', 'refs/remotes/origin/main', 'HEAD']); await expect(pushProtectedChange()).rejects.toThrow(/^protected path/); });
test('human commits already on the remote pass the identity check', async () => { /* remote has a human commit at s1; agent adds one commit */ await expect(pushExistingBranch(dir, b, 't', target, 's1', undefined, guard)).resolves.toBeTruthy(); });
test('the push fetch takes only the branch ref', ...);
test('assertRootOwnedDir rejects a writable or symlinked ancestor', ...);
test('an oversized or slow agent pack aborts the push', ...);
test('cloneForGates runs no git in the agent repo as the gate uid', ...);
test('pushExistingBranch refuses when the remote moved', async () => { /* second clone advances remote */ await expect(push()).rejects.toThrow(/^stale info/); });
test('second sweep runs after the tokenless fetch', async () => { /* expect [sweep, fetch, sweep, push] */ });
// also: 'extra config appends after the auth header'; 'runGit refuses a token with an agent identity'; 'checkoutBranch detects a moved head'; 'mergeBase
//   reports conflicts and leaves markers'; 'a planted commondir in the bare repo does not change the push config'; 'remoteBranchSha returns the tip or null'
```

- [ ] **Step 2: Run** `npm test -w apps/trooper -- git`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/trooper`. Expected: PASS, including `main.test.ts` (its fake `git` keeps the M0 function names).
- [ ] **Step 5: Commit** `feat(trooper): root-only mirror, agent-uid working copy, guarded leased pushes`

---

### Task 16: Trooper role dispatch refactor

**Files:**
- Create: `apps/trooper/src/roles/shared.ts`, `apps/trooper/src/roles/implement.ts`
- Modify: `apps/trooper/src/main.ts`, `apps/trooper/src/claude.ts`
- Test: `apps/trooper/src/claude.test.ts`; `apps/trooper/src/main.test.ts` must pass **unmodified**

**Interfaces:**
- Consumes: Tasks 2, 14, 15.
- Produces:
  - `ClaudeArgsOptions` gains `outputSchema: object`, which replaces the baked-in implement schema.
  - `ParsedLine`: the `rate_limit` variant gains `rateLimitType?: string` and `unifiedWindows?` (ISO `resetsAt`); `result` gains `sessionId?: string`; a new `{ type: 'init'; sessionId: string }` variant comes from `system/init`.
  - `rate_limit` events are emitted with exactly the `RateLimitEventData` keys.
  - `RoleCtx = { workdir: string; secrets: string[]; ids: TrooperIdentities | null }`; `RoleRunner = (payload: DropPayload, deps: TrooperDeps, ctx: RoleCtx) => Promise<DropResult>`.
  - `shared.ts`:
    - `cloneAndPrepare(payload, deps, ctx): Promise<string>` (repo dir; mirror at `<workdir>/mirror`, working copy at `<ids.agent.home>/repo` or `<workdir>/repo`);
    - `runAgent(payload, deps, ctx, o: { prompt: string; outputSchema: object }): Promise<AgentOutcome>`, with `AgentOutcome = { exitCode: number | null; results: ParsedLine[]; initSessionId: string | null; rateLimited: boolean; terminalReason?: string }`;
    - `runGatesPhase(payload, deps, ctx, dir): Promise<GateResult[]>` — first `sweepUid(ids.agent.uid)`, then `cloneForGates(dir, '/home/gate/repo', ids)`; gates run there with `agentSpawnOptions(ids.gate, …)` (own `HOME`). Gates therefore see committed `HEAD` only; implement, heal and resolve commit before gates, as in M0.
    - The `sweep` passed to every push runs the M0 sweep plus `sweepUid(ids.agent.uid)` and `sweepUid(ids.gate.uid)`.
  - Every rate-limit report seen is kept; the last one is attached to the result as `rateLimit`.
  - `runTrooper(payload, deps)` dispatches on `payload.role` to `runImplement` (M0 behaviour moved here); other roles return `failed`, `role not implemented` until Tasks 18–19.

- [ ] **Step 1: Write failing tests**

```ts
test('rate_limit parsing keeps rateLimitType and unifiedWindows in ISO', () => expect(parseStreamLine(rlLine({ seven_day: { utilization: 0.5, resets_at: 1767225600 } }))).toMatchObject({ unifiedWindows: { seven_day: { resetsAt: '2026-01-01T00:00:00.000Z' } } }));
test('gates run as the gate uid after an agent sweep', async () => { await runGatesPhase(p, deps, ctxWithIds, dir); expect(order).toEqual(['sweepUid:10001', 'cloneForGates', 'gate:10002@/home/gate/repo']); });
test('the push sweep kills both the agent and gate uids', ...);
// also: 'buildClaudeArgs uses the given output schema'; 'results carry the last rate-limit report'; 'system/init yields the session id'; 'unknown role fails without cloning'
```

- [ ] **Step 2: Run** `npm test -w apps/trooper`. Expected: FAIL on the new tests only.
- [ ] **Step 3: Implement** as a pure extraction; no behaviour change for implement.
- [ ] **Step 4: Run** `npm test -w apps/trooper`. Expected: PASS, `main.test.ts` untouched.
- [ ] **Step 5: Commit** `refactor(trooper): role dispatch and shared phases`

---

### Task 17: Implement resume, checkpoints and strict result acceptance

**Files:**
- Modify: `apps/trooper/src/roles/implement.ts`, `apps/trooper/src/roles/shared.ts`
- Test: `apps/trooper/src/roles/implement.test.ts`, `apps/trooper/src/main.test.ts` (fake Claude streams gain `system/init`)

**Interfaces:**
- Consumes: Task 16.
- Produces:
  - `acceptOutcome(o: AgentOutcome): { ok: true; result: Extract<ParsedLine, { type: 'result' }> } | { ok: false; reason: string }`. It accepts only when `exitCode === 0`, exactly one `result` event exists, and its `sessionId` equals `initSessionId`. Otherwise the reason is `claude exit <n>`, `multiple results` or `session mismatch`. It applies to every role that reads a result.
  - `runImplement`:
    - `resume: false`: when `remoteBranchSha` is non-null → `failed`, `branch <b> already exists on remote` (the server resumes such items; R12).
    - `resume: true`: `mirrorFetch` + `checkoutBranch(branch, resumeSha)` instead of the fail-fast; continue; push with `pushExistingBranch(..., resumeSha)`.
    - Every push passes `{ as: ids.agent, base, protectedPaths: payload.protectedPaths }`; a guard refusal becomes `failed` with its reason (`protected path <f>`, `foreign commit identity`).
    - A `rate_limit` event with status `rejected`, or `terminalReason !== 'completed'`, with commits ahead of base: `wip: checkpoint` commit (as agent), then a leased push. It returns `rate_limited` or `interrupted` with that `headSha`; with nothing to checkpoint, the same status without `headSha`.

- [ ] **Step 1: Write failing tests**

```ts
test('resume continues the existing branch instead of failing fast', async () => { const r = await runImplement({ ...impl, resume: true, resumeSha: 'ck1' }, deps, ctx); expect(git.calls).toContainEqual(['checkoutBranch', 'agent/issue-1', 'ck1']); expect(git.calls.map(c => c[0])).not.toContain('remoteBranchSha'); expect(r.status).toBe('completed'); });
test('rate_limited implement pushes a checkpoint and reports headSha', async () => { const r = await runImplement(impl, depsWith(stream([init('s'), rateLimit('rejected')])), ctx); expect(r).toMatchObject({ status: 'rate_limited', headSha: 'ck1' }); expect(git.calls).toContainEqual(['commitIfDirty', expect.any(String), 'wip: checkpoint']); });
test('a result whose session id differs from init is failed', () => expect(acceptOutcome({ exitCode: 0, results: [result('other')], initSessionId: 's', rateLimited: false })).toEqual({ ok: false, reason: 'session mismatch' }));
// also: 'a protected-path change is never pushed and fails'; 'resume:false with an existing branch fails fast'; 'max turns gives interrupted with a checkpoint'; 'a non-zero claude exit is failed even with a
//   result line'; 'two result events are failed'
```

- [ ] **Steps 2–4:** run `npm test -w apps/trooper -- implement` (expected FAIL); implement; run `npm test -w apps/trooper` (expected PASS).
- [ ] **Step 5: Commit** `feat(trooper): implement resume, checkpoints and strict result acceptance`

---

### Task 18: Review pipeline

**Files:**
- Create: `apps/trooper/src/roles/review.ts`
- Modify: `apps/trooper/src/main.ts` (dispatch)
- Test: `apps/trooper/src/roles/review.test.ts`

**Interfaces:**
- Consumes: Tasks 15–17; `REVIEW_OUTPUT_SCHEMA`, `VerdictSchema` (Task 2); M0 `redact`.
- Produces: `runReview: RoleRunner`:
  1. Clone (read token or none) → `checkoutBranch(pr.branch, pr.headSha)` → gates as the agent, credential-less.
  2. Record `treeState` (`status --porcelain=v1 -z --untracked-files=all` plus `HEAD`, as agent) **after** the gates. A failed gate skips Claude and gives `request_changes` with a `blocker` finding naming the gate.
  3. Otherwise Claude with `REVIEW_OUTPUT_SCHEMA` → `acceptOutcome` → `VerdictSchema.parse`. A changed `treeState` gives `failed`, `review modified the tree` (a sanity check, not a control).
  4. Every verdict string goes through `redact(…, ctx.secrets)`. Result: `completed` with `verdict` and `gates`; no commit, no push.

- [ ] **Step 1: Write failing tests**

```ts
test('review never pushes and returns the verdict', async () => { const r = await runReview(review, deps, ctx); expect(r).toMatchObject({ status: 'completed', verdict: { decision: 'approve' } }); expect(git.calls.map(c => c[0])).not.toContain('pushExistingBranch'); });
test('review that edits files is discarded', async () => expect(await runReview(review, depsWhereClaudeWrites('a.ts'), ctx)).toMatchObject({ status: 'failed', reason: 'review modified the tree' }));
test('a red gate yields request_changes without running claude', async () => { const r = await runReview(review, depsWithRedGate, ctx); expect(r.verdict?.decision).toBe('request_changes'); expect(claude.runs).toBe(0); });
// also: 'gate writes before claude are not a tree modification'; 'verdict strings are redacted'; 'review clone carries no token when none is given'
```

- [ ] **Steps 2–4:** run `npm test -w apps/trooper -- review` (expected FAIL); implement; run `npm test -w apps/trooper -- review` (expected PASS).
- [ ] **Step 5: Commit** `feat(trooper): review pipeline with SHA-bound verdicts`

---

### Task 19: Heal and resolve pipelines

**Files:**
- Create: `apps/trooper/src/roles/heal.ts`, `apps/trooper/src/roles/resolve.ts`
- Modify: `apps/trooper/src/main.ts` (dispatch)
- Test: `apps/trooper/src/roles/heal.test.ts`, `apps/trooper/src/roles/resolve.test.ts`

**Interfaces:**
- Consumes: Tasks 15–17.
- Produces `runHeal: RoleRunner` and `runResolve: RoleRunner`:

  | Role | Pipeline |
  |---|---|
  | heal | `mirrorFetch` → `checkoutBranch(pr.branch, pr.headSha)` → Claude with `heal.md` + feedback (`acceptOutcome`) → `commitIfDirty` as agent → `no_changes` if nothing changed → gates → `pushExistingBranch(..., pr.headSha)` → `completed` + `headSha`. Max turns or `rejected` → checkpoint as in Task 17 |
  | resolve | `mirrorFetch` → `checkoutBranch` → `mergeBase`. `up_to_date` → `no_changes`. `clean` skips Claude. `conflicts` → Claude with `resolve.md`, then any `<<<<<<<`/`>>>>>>>` line in a tracked file (checked as agent) → `failed`. Then gates → `pushExistingBranch` → `completed` + `headSha`. Every result carries `mergeOutcome` |

  Pushes pass the Task 17 guard options. `head moved` and `stale info` errors propagate as the `failed` reason prefix (the server keeps the item `pr_open`); guard refusals are `failed` with their reason (the server parks).

- [ ] **Step 1: Write failing tests**

```ts
test('heal pushes with lease on the PR head', async () => { await runHeal(heal, deps, ctx); expect(git.calls).toContainEqual(['pushExistingBranch', 'agent/issue-1', expect.anything(), expect.anything(), 'sha1']); });
test('heal lease rejection fails with stale info', async () => expect((await runHeal(heal, depsWherePushRejects, ctx)).reason).toMatch(/^stale info/));
test('resolve with clean merge skips claude and reports clean', async () => { const r = await runResolve(resolve, depsWithMerge('clean'), ctx); expect(r).toMatchObject({ status: 'completed', mergeOutcome: 'clean' }); expect(claude.runs).toBe(0); });
test('resolve leaving conflict markers fails', async () => expect((await runResolve(resolve, depsWithMarkersLeft, ctx)).status).toBe('failed'));
// also: 'heal on a moved head fails with head moved'; 'heal that changes nothing is no_changes'; 'resolve up to date is no_changes'
```

- [ ] **Steps 2–4:** run `npm test -w apps/trooper -- heal resolve` (expected FAIL); implement; run `npm test -w apps/trooper` (expected PASS).
- [ ] **Step 5: Commit** `feat(trooper): heal and resolve pipelines`

---

### Task 20: Trooper image and container hardening

**Files:**
- Modify: `images/trooper/Dockerfile`, `apps/stick/src/docker.ts`
- Test: `apps/stick/src/docker.test.ts`

**Interfaces:**
- Produces:
  - Dockerfile: creates `agent` (uid/gid 10001, home `/home/agent`, 0711) and `gate` (uid/gid 10002, home `/home/gate`, 0700), with no shared group; keeps the trooper as root (no `USER`); `work/` root-owned 0755; sets `JM_AGENT_*`, `JM_GATE_*`, `JM_CONTAINER=1`; installs `setpriv` (util-linux); strips setuid/setgid bits from every binary.
  - `DockerDriver` create options: `Privileged: false`, `CapDrop: ['ALL']`, `CapAdd: ['SETUID', 'SETGID', 'KILL']` (no `CHOWN`: nothing is chowned), `SecurityOpt: ['no-new-privileges']`, `PidsLimit: 512`, `Ulimits: [{ Name: 'core', Soft: 0, Hard: 0 }]`.
  - The process sweep still kills everything except PID 1.

- Note: the gate uid protects the Claude token only from gate commands; Claude's own tool calls still run repo code as the agent uid (residual risk, Task 24).
- [ ] **Step 1: Write failing test:** `container create options drop all capabilities and set no-new-privileges` (asserts the exact option values on the recorded dockerode call).
- [ ] **Steps 2–4:** run `npm test -w apps/stick -- docker` (expected FAIL); implement; run `npm test -w apps/stick -- docker` (expected PASS).
- [ ] **Step 5: Verify in the image (manual; requires Docker; report "not verified" if Docker is unavailable).** Build with `docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .`, then run payloads whose gates are `id -u` (→ `10002`); `cat /home/agent/.claude/.credentials.json` and `touch /home/agent/repo/.git/hooks/x` (→ permission denied); `cat /proc/1/environ`, `cat /proc/1/mem`, `ls -l /proc/1/fd/0` and `echo 'JM_RESULT {}' > /proc/1/fd/1` (→ permission denied); `find / -perm -4000 -xdev` (→ empty).
- [ ] **Step 6: Commit** `feat(trooper): agent uid image and hardened container`

---

### Task 21: Stick image selection and allow-list

**Files:**
- Modify: `apps/stick/src/runner.ts`
- Test: `apps/stick/src/runner.test.ts`

**Interfaces:**
- Produces:
  - `allowedImages(env): Set<string>` — `JM_ALLOWED_IMAGES` split on commas, trimmed, empty entries dropped; unset or empty means `{ JM_TROOPER_IMAGE (if set), 'jumpmaster-trooper:dev' }`.
  - `runDrop` uses `payload.image` (fallback `TROOPER_IMAGE`). An exact-string match against the allow-list is required; no prefix match. A refused image posts `failed`, reason `image not allowed: <image>`, and no container starts.

- [ ] **Step 1: Write failing tests:** `uses payload image`, `refuses an image outside the allow-list`, `no prefix match`, `empty JM_ALLOWED_IMAGES means the default`.
- [ ] **Steps 2–4:** run `npm test -w apps/stick -- runner` (expected FAIL); implement; run `npm test -w apps/stick -- runner` (expected PASS).
- [ ] **Step 5: Commit** `feat(stick): per-drop image with an exact allow-list`

---

### Task 22: UI for the loop

**Files:**
- Modify: `apps/server/src/ui/pages.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/ui/pages.test.ts`

**Interfaces:**
- Consumes: `dispatchGate` (Task 10), `listOutbox`, `latestVerdict`, `getAttempts` (Task 1).
- Produces home-page additions, all escaped as in M0: a **Usage** section (gate, `pausedUntil`, both utilizations with `observedAt`, `causeDropId`); work-item columns for PR number, short head SHA, latest verdict (with `forced`), attempts per key and park reason; a drop role column with elapsed from `started_at`; an **Outbox** section listing every `unknown` or `failed` op with its error.

- [ ] **Step 1: Write failing tests:** `shows usage gate`, `shows verdict and attempts`, `escapes verdict summary`, `lists unknown and failed outbox ops`.
- [ ] **Steps 2–4:** run `npm test -w apps/server -- pages` (expected FAIL); implement; run `npm test -w apps/server -- pages` (expected PASS).
- [ ] **Step 5: Commit** `feat(server): UI shows usage gate, verdicts, budgets and outbox`

---

### Task 23: §16 failure-class suite (the M1 gate)

**Files:**
- Create: `apps/server/src/flow/failure-classes.test.ts`

**Interfaces:**
- Consumes: `harness` (Task 12). No production file is modified in this task.

One `describe` per spec §16 line, driven through the harness. Each test asserts the visible end state **and** the forge call log (`calls`, with identity).

| §16 class | Test |
|---|---|
| 5xx after a successful merge | `exactly one merge; outcome read back` |
| server restart with a pending merge | `pending row read back after restart; no second merge` |
| merge rejected (405) | `parks merge rejected; never re-merges` |
| partitioned trooper / second lease | `stale epoch result rejected; one PR` |
| duplicate result post | `one verdict, one review` |
| implement ends without a PR | `no_changes parks after maxNoChange; Jumpmaster's own comments and reviews never reset or change a fingerprint` |
| implement interrupted | `resumes with resume:true; three interruptions park` |
| closed issue (landed / not landed / conflicted / branch gone) | four cases, plus `never blocks dispatch of another ready item` |
| stale CHANGES_REQUESTED on an old SHA | `human block on an old commit: one review, then park 'human block stands'; no merge call` |
| heal that pushes nothing | `never reaches approval; parks at maxHeal` |
| reviewer blocked SHA X, then the same SHA is approved | `never merges` |
| stale conflict flag while the branch contains base | `no resolve loop` |
| every merge moves base | `three approved PRs: clean resolves are free; none parks` |
| head moved under heal/review | `re-decided, not parked` |
| budgets counted before the run; human reset | `retry label resets once` |
| orphan PR vs a null-SHA preparing PR | `orphan (decide rule 10, agent branch deleted; or rule 4, pr closed) parks; null sha waits` |
| untrusted commenters and bot reviews | `untrusted or bot CHANGES_REQUESTED is ignored; failed lookup = untrusted` |
| hostile PR content | `protected path parks; rewriting the test script parks 'gate script changed'; an npm: alias for the runner parks 'gate tool changed'; base changing a gate script does not park a behind PR` |
| closed PR, then retry | `retry resumes the branch and opens a new PR (create_pr keyed by head)` |
| parks on server-side facts | `merge rejected / unsafe protection / human block: cleared by the retry label or by the cause going away` |
| outbox never resolves | `unknown merge row fails at the deadline, then parks` |
| busy base | `free resolves stop at maxResolveTotal` |
| dead in_flight | `create_pr 5xx with no PR: item resumes after the row fails` |
| unsafe branch protection | `parks before any merge call` |
| CI lag | `green checks without a required check wait; the deadline park names the missing check` |
| usage limit mid-drop | `requeued only while paused, charge refunded, gate closed until reset; forged far-future reset is clamped; a single-drop pause lasts at most 1 h; a late allowed from an older drop does not reopen` |
| probe drop dies | `gate reopens after one jitter; a rate-limited probe is requeued free; the probe is never the cause item` |
| claim race | `one active drop per item under concurrent enqueue` |
| lost webhook / missing or cancelled pipeline | `deadline parks with 'no CI result' / 'no pipeline'` |
| missing forge data | `null pr or compare waits, then parks at the deadline` |
| restore from an older backup | `adopts unknown PRs; nothing merged twice` |
| pagination past 100 | covered by Task 4 nock tests (`listOpenAgentPulls paginates past 100`, `listReviews paginates past 100`) |

**Human-action end-state matrix** (one test per cell; S1 = implement running, no PR; S2 = review drop running; S3 = approved, waiting for CI; S4 = parked `budget exhausted: heal`):

| Human action | S1 | S2 | S3 | S4 |
|---|---|---|---|---|
| merges the PR | n/a | drop result is stored; next pass `done`/`merged`; zero merge calls | `done`/`merged`; zero merge calls | `done`/`merged` (sync) |
| closes the PR | n/a | after the drop: parked `pr closed` | parked `pr closed` | stays parked |
| reopens the PR | n/a | n/a | n/a | from `pr closed`: back to `pr_open`, re-decided |
| closes the issue | the PR is created, then parked `issue closed`; another ready item dispatches | parked `issue closed` | parked `issue closed`; zero merge calls | stays parked |
| reopens the issue | n/a | n/a | n/a | from `issue closed`: back to `pr_open` |
| force-pushes the branch | implement push rejected → parked (retry label recovers via resume) | the verdict binds to the old SHA; new head reviewed; zero merge calls on the old SHA | approval invalidated; review queued for the new head | stays parked |
| deletes the branch | implement pushes a new branch normally | parked `pr closed` (forge closes the PR) | parked `pr closed` or `agent branch deleted` | stays parked |
| pushes to base | no effect until the PR exists | after the drop: resolve queued, no budget charge if clean | resolve, then re-review on the new head | stays parked |
| trusted CHANGES_REQUESTED on head | n/a | after the drop: heal with feedback under the trusted heading | heal queued; zero merge calls | stays parked |
| applies the retry label | no effect | no effect | no effect | attempts reset; back to `pr_open` |

The trooper-side classes are covered by these tests:
- long silent test: M0 `heartbeat from runtime`;
- SIGKILL and resume: Task 17, `resume continues the existing branch instead of failing fast`, and Task 11, `a ready item with an existing branch resumes with resumeSha`;
- hostile hooks and git config: M0 C1 and Task 15, `planted fsmonitor, hook and clean filter never run on the root path`;
- forged results: Task 17 `acceptOutcome` tests;
- protected-path and foreign-identity pushes: Task 15 `push refuses …` tests;
- gates reading agent credentials: Task 16 `gates run as the gate uid after an agent sweep`, Task 20 Step 5.

- [ ] **Step 1: Write the suite.** Do not change production code.
- [ ] **Step 2: Run** `npm run lint && npm run typecheck && npm test`.
- [ ] **Step 3: Report.** List every failing test with the owning task, from the table above or the rule numbers in Task 7, plus the assertion diff. The controller sends one fix subagent per failure with the owning task's text, under the rule "no exported signature changes; stop and report if a decide rule must change". Do not fix failures in this task.
- [ ] **Step 4: Commit** `test(server): spec §16 failure-class suite` (the commit may contain failing tests; the controller's fixes land separately before the M1 gate is declared green).

---

### Task 24: M1 runbook

**Files:**
- Create: `docs/runbooks/m1-loop.md`
- Modify: `docs/runbooks/m0-tracer.md` (link forward; the reviewer token is now required)

**Content:**
- **Prerequisites:** a second (reviewer) bot account, collaborator with write access; its fine-grained PAT with Pull requests read/write plus Metadata read. The author PAT has Contents and Pull requests read/write plus Metadata read, and **no** Workflows, Commit statuses, Checks or Secrets permission. Both bots are non-admin.
- **CI:** base workflows expose no secrets to agent branches (environment-gated secrets only), and the repository default for `GITHUB_TOKEN` is read.
- **Branch ruleset on base** (classic protection is not readable without admin, so a ruleset is required): ≥ 1 required approval; dismiss stale approvals on push; no bypass actor that includes either bot; required status checks when `ciRequired`, each pinned to its app (`integration_id`); the ruleset `active`. If any is missing, items park `unsafe branch protection: …`.
- **Config additions:** `mergeMethod` stays `squash` (the only M1 value); `ciRequired: false` for a repo without CI; budgets; `protectedPaths`; `reviewReadToken: true` for private repos; `JM_ALLOWED_IMAGES` on the stick, matching the zone image exactly.
- **Scenarios and expected outcomes:**
  1. Happy path: merged with no human click; the merge commit reads the PR title plus `Closes #N`, with no trailers.
  2. First review requests changes (e.g. "also handle non-number inputs with a TypeError"), so heal and re-review run.
  3. Push a commit to base while a PR is open, so a free clean resolve runs.
  4. Close an issue mid-flight: it parks `issue closed`. Reopen it: it returns to `pr_open`.
  5. The `agent-retry` label.
  6. A PR that edits `.github/` parks `protected path: …`.
- **Pass criteria** for each scenario, plus the M0 secret check repeated against the reviewer token.
- **Security notes:** the agent runs as uid 10001 and gates as uid 10002, with all capabilities dropped; root runs git only in root-owned mirrors; the reviewer token never leaves the server; the read token is global in M1 (per-zone tokens arrive in M5). **Residual risk:** Claude's own tool calls run repo code as the agent uid with the Claude token reachable, until the credential proxy (spec §7.2) lands.

- [ ] **Step 1: Write the runbook.**
- [ ] **Step 2: Commit** `docs: M1 loop runbook`

---

## Self-review notes

- **§15 M1 coverage:** review 8, 9, 18 · heal 7, 9, 19 · resolve-conflicts 7, 15, 19 · outbox 5, 11 · SHA-bound orchestrator merge 7, 11 · two-bot roles 3, 5, 8 · checkpoint resume 9, 11, 17 · usage pause 10 · trust boundary 8, 11, 14, 15, 20 · gate: §16 suite 23.
- **M0 parked items closed here:** separate uid 14, 15, 20 · `commondir` 15 · sweep-order test 15 · elapsed 10 · payload image 2, 8, 21 · migrations 1.
- **Type ownership** (each type is produced by exactly one task): T1 `AttemptKey`, `PullRequestRow`, `VerdictRow`, `OutboxState`, `OutboxRow`, `UsageStateRow` · T2 `Role`, `PrRef`, `DropPayload`, `Verdict`, `MergeOutcome`, `RateLimitEventData`, `DropResult` · T3 `Budgets`, `UsageConfig` · T4 `PullFacts`, `ForgeReview`, `ChecksState`, `ChecksFacts`, `CompareFacts`, `PullFiles`, `BranchRules`, `BranchRulesRead`, `ForgeError` · T5 `ForgePair`, `OpKind`, `OpResult`, `FakeForge` (extended) · T7 `Snapshot`, `Feedback`, `Action` · T9 `ResultDeps` · T10 `Gate`, `RateLimitSource` · T11 `ZonePass`, `ReconcileReport` · T12 `Harness` · T14 `AgentIdentity`, `TrooperIdentities` · T15 `PushOptions` · T16 `RoleCtx`, `RoleRunner`, `AgentOutcome`.
- **Deliberately not in M1:** single-bot starter mode (M4); forge status labels and comments (would need Issues: write); egress control (M4); crew (M3); multi-zone weights and per-zone read tokens (M5); GitLab (M5); tree-compare landed detection (deferred).
- **Deviation from spec §5.1:** the spec names local git as the authority for "already landed". M1's server has no clone, so it uses the forge `compare` API (ancestry, not the mergeable flag). A server-side mirror clone can replace this in M5.

---

## Red-team disposition

The controller's rulings R1–R13 are applied throughout. Below, "T" = task in this plan.

**Fable failure scenarios**

| ID | Disposition |
|---|---|
| C1 merge `failed` livelock | Adopted: T5 (`runOp` row semantics), T7 rules 6–7, T11 test |
| C2 `maxResume` never charged | Adopted: T6 (`resume` key), T8 (`resume = headSha !== null`), T9, T11 step 3 |
| C3 usage gate wedges | Adopted: T10 (`releaseProbe`, observation expiry) |
| C4 non-idempotent review result | Adopted: T1 (`INSERT OR IGNORE`), T5 (`markPendingUnknown`), T7 rules 21–23, T9 (`id = dropId`) |
| H1 merge cascade parks via `maxResolve` | Adopted per R5: T6, T9, T12 test. The variant "merge when behind but clean" is not adopted: resolves are now free, and merging a stale base would bypass CI on the merged tree |
| H2 head moved parks | Adopted per R7: T9, T15/T19 reason prefixes |
| H3 standing human block invisible | Adopted per R10: T7 rules 19–20, T11 |
| H4 no recovery from reopen | Adopted: T13 `syncParked`. Closed-PR branch: not deleted; retry resumes from it (R12) |
| M1 null `pr` / `compare` | Adopted: T7 rules 2, 8 |
| M2 squash-landed detection | Not adopted (R13): limitation stated in Global Constraints |
| M3 CI lag before required checks | Adopted: T4 `ChecksFacts.names`, T7 rule 25 |
| M4 RC then approve on same head | Adopted: T7 rule 17 (any RC on head) |
| M5 per-item adoption calls | Adopted: T4 `listOpenAgentPulls`, T11 step 2 |
| M6 gate writes trip the review tree check | Adopted: T18 step 4 |
| M7 charge and insert not atomic | Adopted: T6, T11 |
| Missing tests | Adopted: T5, T9, T10, T11, T12, T23 |

**Security**

| ID | Disposition |
|---|---|
| C1 root git in agent tree; `safe.directory=*` | Adopted per R1: T14, T15 |
| C2 `chownToAgent` follows symlinks | Adopted per R1: chown removed, mirror clone (T15) |
| H1 gates not authoritative; no protected paths | Adopted per R2: T3 `protectedPaths`, T7 rules 12–14, T9 forced RC, T11 guards. `package.json`/lockfiles are not blanket-protected (R2); script changes are caught instead |
| H2 forged verdict | Adopted: T17 `acceptOutcome`. "Ignore `ciRequired: false` unless protected paths are on" is not adopted: the protected-path check is always on |
| H3 bot reviews trusted | Adopted: T4 `viewerLogin`, T11 snapshot filter, T8 untrusted heading |
| H4 forged usage events | Adopted per R4: T10 clamp, cause recording, probe release; T9 requeue limits |
| H5 branch protection unchecked | Adopted per R3: T4 `getBranchRules`, T11, T7 rule 15, T24. "Require approval of latest push" is not adopted: R3's list omits it, and dismissing stale approvals covers the push-after-approval case |
| H6 secret leak via review body | Adopted: T18 trooper redaction, T5 `sanitizeForgeText`, T9 `renderReviewBody` |
| M1 fork PRs adopted | Adopted: T4 head-repo checks, T11 author check |
| M2 markdown and marker injection | Adopted: T5 `sanitizeForgeText`, T4 `findReviewByMarker` |
| M3 squash-merge message | Adopted per R11: T4, T11 |
| M4 read-only check and global read token | Partly adopted: the check is documented as sanity only (T18), and the token is omitted unless `reviewReadToken` (T8). A per-zone token is not adopted (R13, M5) |
| M5 container hardening | Adopted per R1: T20 |
| M6 root reads agent files | Adopted per R1: T14 `readAgentFile` |
| L1 allow-list normalization | Partly adopted: exact match and empty-means-default (T21). Required digests and never-pull are not adopted: local dev images have no digest |
| L2 single `JM_RESULT` line | Not adopted in the stick for M1: forged result lines are blocked by the uid split (T20 `/proc/1/fd/1` check). The server ignores `result.headSha` beyond the hint (Global Constraints) |
| L3 human review bodies only | Adopted: T11 uses review bodies only, with trust read in the same pass |
| L4 `checkoutBranch` fetch ordering | Adopted: T15 `mirrorFetch` runs as root before the agent step |

**Feasibility**

| ID | Disposition |
|---|---|
| 1 Reorder 8, 9 before 7 | Adopted per R8: payloads T8 and results T9 before reconcile T11; usage moved to T10 so reconcile consumes its final `enqueueNext` signature |
| 2 `applyResult` signature and callers | Adopted: T9 (`ResultDeps`, `forgesFor`) |
| 3 keep packages compiling | Adopted: T2 |
| 4 `secrets:` literals, `Budgets` | Adopted: T3 |
| 5 row types, `inputJson`, `now` | Adopted: T1 |
| 6 gate parameter, event fields, epoch seconds | Adopted: T2 `RateLimitEventData`, T10, T16 |
| 7 `input_json` at enqueue | Adopted: T11 step 4 |
| 8 bot's own reviews | Adopted: T4, T11 |
| 9 `safe.directory=*` | Adopted per R1: T15 |
| 10 moved head parks | Adopted per R7: T9 |
| 11 implement resume, `branchSha` | Adopted per R12: T4, T6, T8, T9, T11 |
| 12 probe sticks | Adopted: T10 |
| 13 outbox `unknown`/`failed`, drop `comment`, `{ status }` | Adopted: T1, T4, T5 |
| 14 missing data in `decide` | Adopted as wait-then-park (T7 rules 2, 8), following Fable M1 rather than an immediate park |
| 15 allow-list default | Adopted: T21 |
| 16 harness API | Adopted: T12 |
| 17 retry label lookup | Adopted: T13 |
| 18 concurrency | Adopted per R6: T10, T11 |
| 19 `runResume` typo | Adopted: T16 dispatch names |
| 20 transient review failure policy | Adopted per R7: T9 |
| Splits of 4, 7, 12 | Adopted per R8: T4/T5; T11/T12/T13; T16–T19 |
| Test feasibility and CI | Adopted: T12 (`leaseWaitMs`, `rand`), T14 (pure uid tests), T20 (Docker step manual), T23 (lists failures, does not fix them; matrix; "orphan" mapped to decide rules) |
| Task 1 frozen `schema.sql` | Adopted: Global Constraints, T1 |

**Second round (v2 re-review; controller rulings Q1–Q10 binding)**

| ID | Disposition |
|---|---|
| Fable N1 permanent `create_pr` key | Adopted: T5 key `pr:<itemId>:<headSha>` and open-PR validation of a `done` row; T9; T23 |
| Fable N2 late `allowed` reopens the gate | Adopted: T10 (`allowed` clears only from the probe or a drop started after `pausedAt`) |
| Fable N3 requeue depends on an event race | Adopted with Q6: T2 `DropResult.rateLimit`; T10 `applyResult` ingests it first; T9 requeues while paused |
| Fable N4 server-fact parks have no exit | Adopted: T13 cause-gone re-decide; retry label runs `deleteFailedOutbox` (T1) |
| Fable N5 `wait outbox` has no deadline | Adopted: T5 `resolveUnknown(…, maxAgeMinutes)` fails stale rows; T7 rules 6–7/22–23 then park |
| Fable N6 probe burns requeue budget | Adopted: T9 (probe requeue is free) |
| Fable N7 base-side gate-script change parks | Adopted per Q1: T4 `mergeBaseSha`; T11 guards compare against the merge base |
| Fable N8 unbounded free resolves | Adopted per Q1: T3 `maxResolveTotal` (6), T6 `resolve_total` |
| Fable N9 dead `in_flight` state | Adopted: T11 step 3 |
| Fable N10 protection rule too late | Adopted per Q1: T7 rule 15, right after the guard rules |
| Fable N11 resume bypasses the zone cap | Adopted: T10 `enqueueImplement`, used by T11 step 3 |
| Fable N12 truncated compare file list | Adopted: T4 `listPullFiles` (3000 cap); T7 rule 12 parks only beyond it |
| Fable N13 heal checkpoint reviewed as done | Adopted: T9 heal continuation charged to `resume`; T8 heal `pr.headSha` |
| Fable N14 past `resetsAt` ignored | Adopted: T10 (now + jitter) |
| Fable N15 vague `no CI result` | Adopted: T7 rule 26 names missing checks |
| Fable verdict table, rule 5 without deadline | Adopted: T7 rule 5 waits with the forge-data deadline |
| Security N1 agent can swap the mirror | Adopted per Q2: Global Constraints layout; T15 `assertRootOwnedDir`, `GIT_DIR`, `GIT_CEILING_DIRECTORIES`; T16 working copy under the agent's `$HOME`; T15 `removeTree` as agent |
| Security N2 CI runs pushed code with secrets | Adopted per Q3: T2/T8 `protectedPaths` in payloads; T15 `prePushCheck`; T17/T19; Global Constraints; T24 |
| Security N3 gate-script bypasses | Adopted per Q4: T11 `invokedScripts` (pre/post, whole words, `name:*`, fail closed), `gateToolChanges`; T3 test-runner configs; T8 `review.md`; T7 rule 14 |
| Security N4 gates share the agent uid | Adopted per Q5: T14 `TrooperIdentities`, `sweepUid`; T16; T20. Superseded in round three (H-B): no shared group; gates clone their own tree |
| Security N5 forged `rejected` | Adopted per Q6: T10 (result-only pauses, 1 h unconfirmed cap, distinct-drop confirmation, probe never the cause item) |
| Security N6 rules read under-specified | Adopted per Q7: T4 `getBranchRules` / `BranchRulesRead`; T11 `branchProtectionProblems`; T24 pinned checks |
| Security N7 agent commit metadata | Adopted per Q8: T3 squash-only; T4 `merge` type; T15 `prePushCheck` identity rule |
| Security N8 protected-path details | Adopted per Q9: T3 defaults (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.gitmodules`); T11 rename sources, merge-base diff, unreadable `package.json` parks |
| Security N9 capabilities and cleanup | Adopted per Q9: T20 drops `CHOWN`; T15 `removeTree` as agent |
| Security §2 `[text](url)` links still pass | Not adopted: low, accepted by the reviewer |

**Third round (final pass; controller rulings binding)**

| ID | Disposition |
|---|---|
| Security H-A / Fable V1 guard diffs an agent-controlled base | Adopted: T15 (`refs/jm/base` from `work/mirror`; the agent fetch takes only `refs/heads/<branch>`); test `an agent origin/<base> pointing at its own tip does not bypass the guard` |
| Security H-B gate uid escalates via the shared repo | Adopted per ruling: T14 (no shared group, umask 0022), T15 `cloneForGates` (via a bundle, so no git runs across uids), T16, T20; residual-risk note in T20 and T24 |
| Security H-C install scripts defeat the gate-tool guard | Adopted: T11 `gateToolChanges` lockfile `hasInstallScript` and fail-closed rules |
| Fable V2 probe starves with only the cause item | Adopted per ruling: T10 (cause item's drop is the probe if nothing else is queued) |
| Fable V3 identity check blocks human-touched branches | Adopted per ruling: T15 `prePushCheck(…, since)` checks only the commits this push adds |
| Fable V4 merged PR left parked `merge rejected` | Adopted per ruling: T13 landed check covers the `merge rejected` prefix |
| Security Medium: every path component | Adopted: T15 `assertRootOwnedDir` |
| Security Medium: pack size/time cap | Adopted: T15 `PUSH_FETCH_TIMEOUT_MS`, `PUSH_FETCH_MAX_BYTES` |
| Security Medium: sweep the gate uid before push | Adopted: T16 push `sweep` |
| Fable Medium: hard-coded `method: 'squash'` | Adopted: T11 uses `zone.mergeMethod` (squash-only) |
| Fable Medium: park reason names the last null field | Not adopted (ruling): parked for final code review |
| Fable Medium: cap the cause-gone re-decide | Not adopted (ruling): parked for final code review |

Per Q10, a single verification pass over the Criticals and Highs follows v3. Remaining Mediums are recorded as rulings for the final code review and do not trigger another plan revision.

