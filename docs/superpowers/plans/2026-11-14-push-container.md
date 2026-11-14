# Push Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every push to GitHub out of the container an agent ran in, and into a second,
agent-free trooper container. That container works on the agent's working copy, on a per-drop
volume, and receives a write token only after it has swept every agent process. This is landed
and proven on PAT mode, at the end of M4.5.

**Architecture:**
- **Trooper.** The agent's trooper stops pushing. It ends in a result that carries `push`
  (`final` with `expectSha`, or `checkpoint`) and leaves the working copy on the volume.
- **Server.** The stick posts that result first. The server runs the result's usage half at
  once and holds the drop in `push_pending`.
- **Push container.** The stick confirms the agent container is gone, asks the server for the
  push plan (non-secret), and starts a push container from the base trooper image. That container
  fetches the agent's branch through a hardened, agent-uid `upload-pack`, sweeps, then says *ready*.
- **Grant and push.** Only then does the stick ask for the grant (the token and the drop's own
  secrets) and write it as one stdin line. The push container fetches the base from GitHub, runs
  `prePushCheck`, pushes with the lease, and reports. The server then applies the stored result's
  outcome half with the pushed SHA.

**Tech Stack:** TypeScript (Node 24, ESM, type stripping), vitest, better-sqlite3 migrations,
Fastify, dockerode, git (bookworm), zod.

**Spec:** `docs/superpowers/specs/2026-11-13-github-app-auth.md` §4.2 ("The push container" through
"Disk and hold time are bounded") and §13 item 4. The code map was taken at `origin/main` d2713a4.
Plan red-teamed twice: the first pass found 5 blockers and 8 majors; the second confirmed them closed and found 3 new majors. Every finding is answered below as a ruling or a test.

## Delivery

**One feature branch, `feat/push-container`, merged as one PR after Task 14.** Server tasks land
first, then the trooper's new push path, then the stick, and the roles stop pushing last (Task 13).
So the branch is runnable at every task boundary, and main never sees a half-switched push path.

**Deploy order** (documented in Task 14): the server first, then the stick and images from the
same release. A new stick refuses pushing roles from a server that doesn't announce `push-v1`
(Ruling 11), so a stick deployed early fails safe rather than opening a PR for an unpushed branch.

## Global Constraints

- **PAT mode only.** No GitHub App code (§13 Tasks 5–12 come later). The grant carries the author
  PAT; `push_tokens` exists so app mode adds revocation without a migration.
- **The PAT-mode caveat.** "No write token in a container an agent ran in" holds fully only in app
  mode. In PAT mode with no `githubReadToken`, the agent container still holds the author PAT for
  its fetch (§4.2 "as today"), but the push happens only in the push container. SECURITY.md says
  this.
- **Commits.** Jumpmaster commits carry `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  and nothing else of the kind. No private hostnames, paths or names anywhere.
- **Named constants** for the spec's [call] defaults:
  - `LOST_SERVER_GRACE_MS = 60_000`;
  - `RECLAIM_WINDOW_MS = 15 * 60_000`;
  - `PUSH_RETENTION_MS = 24 * 3_600_000`;
  - `VOLUME_FREE_FLOOR_BYTES = 10 * 2**30`;
  - `MAX_PENDING_PUSHES = 8`.
- **More named constants:**
  - `READY_TIMEOUT_MS = 10 * 60_000`;
  - `REMOVE_TIMEOUT_MS = 60_000`;
  - `PUSH_BACKOFF_MAX_MS = 5 * 60_000`;
  - `PUSH_LOOP_MS = 15_000`;
  - `MAX_CONCURRENT_PUSHES = 2` (per stick);
  - `GRANT_HOLD_MS = 15 * 60_000` (how long an unrevoked reservation blocks another grant);
  - `NO_RESULT_RETRIES = 3`.
- **Unchanged bounds:** `PUSH_FETCH_MAX_BYTES` (1 GiB), `PUSH_FETCH_TIMEOUT_MS` (120 s).
- **Volumes.**
  - Name: `jm-drop-<dropId>-<epoch>-<nonce>`, where the nonce is 8 hex characters.
  - Labels: `jumpmaster.stick`, `jumpmaster.drop`, `jumpmaster.epoch`, `jumpmaster.volume=1`.
  - Mount point: `/home/agent/repo`, owned by agent 10001:10001, mode 0700.
- **The init container** runs from `TROOPER_IMAGE` with `NetworkMode: 'none'`,
  `CapDrop: ['ALL']` and `CapAdd: ['CHOWN']`.
- **The push container** runs from `TROOPER_IMAGE`, never `payload.image`.
  - It keeps today's `CapDrop`, `CapAdd [SETUID, SETGID, KILL]`, `no-new-privileges` and limits.
  - Its network is `jm-push-<dropId>-<epoch>`.
  - Under egress it gets its own session allowing `github.com` only. Without egress it gets the
    plain network the agent container would have had.
- **`READY_LINE = 'JM_READY'`**, printed once, alone on a line, by the push container.
- **Hardened upload-pack**, as one shell command run as the agent uid:
  `env GIT_NO_LAZY_FETCH=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack`.
- **Image label `org.jumpmaster.trooper.push="1"`.** It is on every trooper image from this
  release. A stick refuses a pushing-role drop whose `payload.image` lacks it.

## Rulings

1. **Read token.** Item payloads keep `credentials.forgeToken`. For implement, heal and resolve
   the server fills it with `githubReadToken ?? githubAuthorToken` (today: always the author
   token, `payloads.ts:341`). This lands in **Task 13**, with the roles' switch: before that the
   roles still push with that token.
2. **`push_pending` is an active state** for `one_active_drop`, for every hard-coded active-state
   list (`ACTIVE_DROP_STATES`), and for `maxConcurrentImplement` (`scheduler.ts:40`). A pending
   push holds its branch, so nothing else may start on the item.
3. **What the agent container may ask for.** Its `push.kind` is `final` or `checkpoint`
   (`salvage` only comes from the server).
   - `final` is valid only with status `completed` and `headSha === expectSha`.
   - `checkpoint` is valid only with `interrupted` or `rate_limited`.
   - Resolve never sends `checkpoint`.
   - The server rejects anything else with 422 and the stick removes the volume.
4. **Parameters come from the server, never from labels.**
   - Before starting a push container, the stick calls `push-plan` for the branch, limits,
     egress, and whether salvage is allowed. Volume labels carry only stick, drop and epoch.
   - After *ready*, `push-token` returns the grant. The trooper refuses unless the grant's
     `branch` equals the plan's.
5. **Grant secrets are the drop's own** (`dropSecrets`): the drop's `forgeToken` and the author
   token, each with its basic-auth form, the Claude token, and the drop's own zone gate secrets.
   It never uses `secretList(config)`, so the reviewer token, the join token and other zones'
   secrets never leave the server.
6. **Reservations.**
   - `push-token` refuses with 409 `reserved` while an unrevoked reservation for the drop is
     younger than `GRANT_HOLD_MS`.
   - `push-plan` revokes any older unrevoked reservation, as does every rediscovery (`salvage`
     call) and every push result.
   - So a stick that died after the grant gets a fresh one on its next attempt, at most
     `GRANT_HOLD_MS` later. Immediately, if it restarted: its rediscovery revokes the old
     reservation.
7. **Push results:**
   - `pushed`: apply the stored result's outcome with `headSha` = the pushed SHA.
   - `failed` with `retryable: true` (network, 5xx, a server refusal relayed): revoke, stay
     `push_pending`, and the stick retries.
   - `failed` and not retryable:
     - for `final`: apply the stored result as `failed` with the reason;
     - for `checkpoint` or `salvage`: apply the stored status (`interrupted`/`rate_limited`)
       with the drop's prior `head_sha`, so the item resumes from the last pushed commit and
       isn't parked.
   - `nothing`, for kind `salvage` (nothing ahead, or no branch): the drop goes to `lost`, and
     the item requeues as today.
   - `nothing`, for kind `checkpoint` (a resumed drop interrupted again with no new commits):
     apply the stored status with the prior `head_sha`, as for a non-retryable failure. So
     `continueInterrupted` still charges `resume` and parks when the budget is spent, and
     `rate_limited` keeps its refund and pause handling.
8. **Usage is applied at push-requested time.**
   - `applyResult` is split into `applyUsage(db, deps, drop, result, now)` (`noteOverage`,
     `noteProbeResult`, `noteFableSignals`, `ingestRateLimit`, served model, `releaseProbe`) and
     `applyOutcome(...)` (the role routing).
   - `applyUsage` reads `wasProbe` (`getUsageState().probeDropId === drop.id`) **before**
     `releaseProbe`, and persists it as `drops.was_probe`. `applyOutcome` reads `wasProbe` from
     the drop, never from the usage state. This holds for every role's result, not only pushes:
     today `releaseProbe` runs in a `finally`, after the outcome.
   - The result route runs `applyUsage` immediately for a push-requested result, then sets
     `drops.usage_applied = 1`.
   - `applyResult` calls both, skipping `applyUsage` when `usage_applied = 1`.
9. **Salvage** (`POST /api/sticks/salvage`). It accepts a drop of this stick and epoch that is:
   - `push_pending`: continue as it is;
   - `lost` with `running_at` within `RECLAIM_WINDOW_MS`;
   - `cancelled` with `hard_cancel = 1` (the kill switch), even while the switch is on.

   It refuses resolve, and it refuses when another active drop already exists for the item
   (that work is lost; the race is narrow because nothing leases while killed). On accept it
   stores a synthetic result `{status: 'interrupted', role, gates: [], reason: 'salvaged'}`,
   `push_kind = 'salvage'`, a deadline, and `usage_applied = 1`. A drop lost while rate-limited
   loses that status; accepted, since the replacement re-reads usage.
10. **Reclaim window.** v22 adds `drops.running_at`, stamped on the first heartbeat that moves the
    drop to `running`. While a `lost` drop's `running_at` is within `RECLAIM_WINDOW_MS`:
    - `expireLeases` doesn't requeue its in-flight item;
    - `decide.ts:195` and `flow/reconcile.ts:102` and `:140` treat it as active
      (`reclaimableDropFor`), so heal and resolve don't enqueue, and no branch is adopted under
      a drop that may still salvage.
11. **Version handshake.**
    - The server's lease response carries the header `x-jumpmaster-features: push-v1`.
    - A new stick refuses to run a pushing-role payload without it. It never starts the agent,
      posts no result and stops heartbeating, so the old server sees the drop `lost` and
      requeues it, rather than parking the item. It logs `server too old for push containers:
      deploy the server first` on every such lease.
    - The server treats a stick lacking the `push-v1` capability as `noPush`: it gets no pushing
      roles, but review, crew and doctor drops still go to it.
12. **Kill switch time.**
    - v22 adds `kill_switch.engaged_at`, set only on an off→on transition.
    - Release adds `now - engaged_at` to every `push_pending` deadline.
    - `expireLeases` never expires a `push_pending` drop while the switch is on.
13. **Idempotency.**
    - The result route answers `{state: 'push_pending'}` to a repeat from the same stick and
      epoch.
    - The push-result route answers 200 `{state}` when the drop has already left
      `push_pending` through this epoch's result. A stick retrying after a lost response is
      never told "stale".
14. **The lost-server rule** stops with a `LOST_SERVER_GRACE_MS` grace, then kills.
    - When the held result is later refused 409 because the drop went `lost`, the stick calls
      `salvage` before removing anything.
    - `hard_cancel` kills (`hardKill`), then `removeAndWait`, then calls `salvage`.
    - **On every path** (push request, 409 salvage, hard cancel, lost-server stop, and
      rediscovery after `reapOrphans` has completed), no entry enters `PendingPushes` until
      `removeAndWait` has confirmed the agent container is gone.
15. **The push loop is not a lease slot.**
    - `PendingPushes` is driven by its own loop in `main.ts` (every `PUSH_LOOP_MS`, at most
      `MAX_CONCURRENT_PUSHES` at a time). `runDrop` hands an entry over and returns.
    - The `jm-push-*` networks of live entries are in the sweep's active set.
16. **Operator cancel.** There is no item-drop cancel today (`control.ts:570` cancels queued
    doctor drops only), so Task 5 adds `POST /api/control/drops/:id/cancel` and `ctl drops cancel
    <id>`, which accept only `push_pending`. It marks the drop `cancelled`, revokes its grants,
    and sets the item explicitly:
    - implement: `ready` (a later drop starts from the drop's prior `head_sha` when it has one,
      via `insertReplacement`; otherwise fresh);
    - heal and resolve: the item stays `pr_open`.

    The stick learns it through Ruling 19.
19. **A pending push that ended on the server.** `push-plan` and `push-token` answer 409
    `{stale: true}` for a drop of this stick that is no longer `push_pending` (lost to retention,
    cancelled, or applied). The stick then removes the volume and the entry. Running push
    containers learn it from the heartbeat, as before.
20. **The token route trusts nothing from the plan call.** It re-reads the drop and re-validates
    the role, kind, branch, zone mode, kill switch and repository itself.
17. **The base image is verified.**
    - At startup the stick pulls `TROOPER_IMAGE` and verifies it under the image policy, through
      the same `verifyImage` path as `payload.image`.
    - The release stick image bakes `JM_TROOPER_IMAGE` (a digest reference) from a build arg, as
      it does `JM_EGRESS_IMAGE`.
18. **Health is re-checked.** The volume self-check runs at startup and in every 10-minute sweep.
    The capability is advertised from the latest result, on every lease.

## Review Focus

1. **The stick restarts after a grant and before the push result.** Rediscovery revokes the
   reservation, the next attempt gets a fresh grant, and the push either lands or is found
   already there. Test: Task 3, "rediscovery revokes a stale reservation", and Task 12,
   "rediscovers a pending push whose push container died with the stick".
2. **A zone is paused for days with a pending push.** The stick retries with backoff capped at
   `PUSH_BACKOFF_MAX_MS` and the volume stays. Retention expires at 24 h unless extended; when it
   does, the item resumes from the last pushed SHA. Test: Task 11, "retries a refused grant with
   capped backoff and keeps the volume"; Task 4, "retention expiry requeues from the last pushed
   sha".
3. **A working copy near 1 GiB.** Staging fails before any token, the push container reports a
   non-retryable `failed`, and the outcome is applied per Ruling 7: a final push fails as
   today's oversized push does; a checkpoint resumes. Test: Task 7, "an oversized working copy
   fails before the token"; Task 3, "a failed checkpoint push resumes from the prior sha".
4. **Two grant requests at once.** Exactly one gets a token. Test: Task 3, "one live
   reservation per drop".
5. **The response to a result post is lost, and the stick retries.** The drop stays
   `push_pending` and the volume stays. Test: Task 3, "a repeated push-requested result is
   idempotent"; Task 11, "a 409 on a held result triggers salvage, not removal".

---

### Task 1: Protocol schemas

**Files:**
- Modify: `packages/protocol/src/index.ts` (`STICK_CAPABILITIES` `:51`; after `DropResultSchema` `:443-463`), `packages/protocol/src/redact.ts`
- Test: `packages/protocol/src/index.test.ts`, `packages/protocol/src/redact.test.ts`

**Interfaces:**
- Produces:
  - `STICK_CAPABILITIES` adds `'push-v1'`. `READY_LINE = 'JM_READY'`. `FEATURES_HEADER = 'x-jumpmaster-features'`.
  - `PushRequestSchema = z.object({ kind: z.enum(['final','checkpoint']), expectSha: sha40.optional() })`. It is refined so that `final` requires `expectSha` and `checkpoint` forbids it. `DropResultSchema` adds `push: PushRequestSchema.optional()`.
  - `pushRequestValid(result: DropResult, role: Role): boolean` implements Ruling 3.
  - `PushPayloadSchema = z.object({ protocol: z.literal(1), role: z.literal('push'), dropId, epoch, branch: z.string().min(1), salvage: z.boolean() }).strict()`.
  - `PushPlanSchema = z.object({ branch, salvage: z.boolean(), limits: ContainerLimitsSchema.optional(), egress: EgressPayloadSchema.optional() }).strict()`.
  - `PushGrantSchema = z.object({ token, owner, name, branch, base, lease: z.string(), expectSha: sha40.optional(), protectedPaths: z.array(z.string()), secrets: z.array(z.string()) }).strict()`.
  - `PushResultSchema` is a discriminated union on `status`:
    - `pushed {headSha: sha40, alreadyThere: boolean}`;
    - `failed {reason: string ≤2000, retryable: boolean}`;
    - `nothing {reason: string ≤2000}`.
  - `dropSecrets(o: { forgeToken?: string; authorToken: string; claudeToken: string; gateSecrets?: Record<string,string> }): string[]` lists each token with its basic-auth form, in `redact.ts`.

- [ ] **Step 1: Failing tests:**
  - `push request: final needs expectSha; checkpoint forbids it`;
  - `pushRequestValid: final only with completed and matching headSha; checkpoint only interrupted or rate_limited; never for resolve checkpoints or non-pushing roles`;
  - `push payload is strict and has no token field`;
  - `grant and plan reject unknown keys`;
  - `push result variants`;
  - `dropSecrets lists basic-auth forms and nothing else`;
  - `push-v1 is a capability`.
- [ ] **Step 2:** Run `npx vitest run packages/protocol`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Then `npx tsc -b packages/protocol`. Expected: exit 0.
- [ ] **Step 5: Commit** `feat(protocol): push request, plan, grant and result schemas`.

### Task 2: Server schema v22 and repository

**Files:**
- Modify: `apps/server/src/db/migrations.ts` (v22 after `:635`), `apps/server/src/db/repo.ts` (`DropState` `:5-12`, `Drop` `:45-71`, `DROP_COLS`, `setKilled` `:935`)
- Modify, replacing literal lists with `ACTIVE_DROP_STATES`:
  - `repo.ts:499`, `:529`, `:948`;
  - `control.ts:570`, `:600`;
  - `api/secrets.ts:61`;
  - `crew/schedule.ts:128`;
  - `doctor/checks.ts:1795`;
  - `mcp/tools.ts:247`;
  - `ui/pages.ts:555`;
  - `scheduler.ts:40`.
- Test: `apps/server/src/db/migrations.test.ts`, `apps/server/src/db/repo.test.ts`

**Interfaces:**
- Produces:
  - **v22** (`foreignKeysOff: true`, the v17/v21 twelve-step rebuild of `drops`):
    - the state CHECK adds `'push_pending'`;
    - new columns: `push_kind` (`final|checkpoint|salvage`), `push_expect_sha`, `push_deadline`, `running_at`, `usage_applied INTEGER NOT NULL DEFAULT 0`, and `was_probe INTEGER NOT NULL DEFAULT 0`;
    - `one_active_drop` and its crew/doctor variants include `push_pending`;
    - `kill_switch` adds `engaged_at TEXT`;
    - new table `push_tokens(drop_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, reserved_at TEXT NOT NULL, minted_at TEXT, revoked_at TEXT, PRIMARY KEY (drop_id, epoch, seq))`.
  - `ACTIVE_DROP_STATES = ['queued','leased','running','push_pending'] as const`.
  - `Drop` adds `pushKind`, `pushExpectSha`, `pushDeadline`, `runningAt`, `usageApplied` and `wasProbe`.
  - `setKilled(db, engaged, now)` sets `engaged_at` only on an off→on transition. On on→off it returns the paused milliseconds.
  - Reservations:
    - `reserveGrant(db, dropId, epoch, now): 'ok' | 'reserved'`, in one transaction: it returns `reserved` if an unrevoked row is younger than `GRANT_HOLD_MS`; otherwise it revokes the older rows and inserts `seq + 1`;
    - `markMinted(db, dropId, epoch, now)`;
    - `revokeGrants(db, dropId, now)`.

- [ ] **Step 1: Failing tests:**
  - `v22 migrates a v21 database and keeps every drop and index`;
  - `push_pending blocks a second active drop for the item`;
  - `reserveGrant: one live reservation; a stale one is replaced`;
  - `setKilled records engaged_at once and returns the paused time`;
  - `scheduler counts pending pushes toward maxConcurrentImplement`.
- [ ] **Step 2:** Run `npx vitest run apps/server/src/db apps/server/src/scheduler.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): schema v22 for pending pushes`.

### Task 3: Server stick routes

**Files:**
- Modify: `apps/server/src/api/sticks.ts` (`liveDrop` `:124-147`, lease `:174-213`, result `:280-308`, new routes), `apps/server/src/leases.ts` (`heartbeat` `:182-207`), `apps/server/src/results.ts` (split `applyResult` `:465-527`)
- Test: `apps/server/src/api/sticks.test.ts`, `apps/server/src/results.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `applyUsage(db, deps, drop, result, now): void` and `applyOutcome(db, deps, drop, result, now): void`. `applyResult` = both, skipping usage when `usage_applied` (Ruling 8).
  - **Lease.** The response sets `FEATURES_HEADER: push-v1`. A stick without `push-v1`, or a body with `noPush: true`, gets no pushing roles (Ruling 11).
  - **Result route.** A valid push-requested result (`pushRequestValid`) does the following and answers `{state:'push_pending'}`:
    - moves the drop to `push_pending`;
    - stores `result_json`, `push_kind` and `push_expect_sha`, and sets `push_deadline = now + PUSH_RETENTION_MS`;
    - runs `applyUsage` and sets `usage_applied`.

    An invalid push request gets 422. A repeat from the same stick and epoch is idempotent (Ruling 13).
  - **`POST /api/sticks/push-plan {dropId, epoch}`.** For this stick, at this epoch, in `push_pending`, it calls `revokeGrants` and answers the `PushPlan`: the branch from the drop, the zone's limits and egress (allow `github.com` only), and `salvage: push_kind === 'salvage'`.
  - **`POST /api/sticks/push-token {dropId, epoch}`.**
    - Refusals, each `{refused, retryable}`:
      - `killed` (retryable); `zone paused|observe` (retryable);
      - `role` (no); `repo mismatch` (no);
      - `reserved` (409, retryable).
    - Otherwise `{grant}`:
      - the author PAT; owner, name and base from the zone; the branch;
      - `lease`: implement uses `''` when the drop's `head_sha` was null at lease and that SHA when resuming; heal and resolve use `pr.headSha` at lease;
      - `expectSha`; `protectedPaths`;
      - `secrets: dropSecrets(...)` (Ruling 5).
    - Then `markMinted`, and audit `push-token` with `via:'system'`, detail `{drop, epoch, kind}`, and no token.
  - **`POST /api/drops/:id/push-result {epoch, result: PushResult}`.** It applies Ruling 7, always runs `revokeGrants`, and is idempotent per Ruling 13.
  - **`POST /api/sticks/salvage {dropId, epoch}`** applies Ruling 9.
  - **Heartbeat.** For `push_pending`, it answers `killed` when the kill switch is on, `cancel` when the drop is `cancelled` (operator), and `ok` otherwise. It stamps `running_at` on the first leased→running move.
  - **`push-plan` and `push-token`** answer 409 `{stale: true}` for a drop not in `push_pending` (Ruling 19). The token route re-validates everything itself (Ruling 20).

- [ ] **Step 1: Failing tests:**
  - `lease announces push-v1 and gives pushing roles only to push-v1 sticks without noPush`;
  - `a push-requested result parks the drop, applies usage once and releases the probe`;
  - `a repeated push-requested result is idempotent`;
  - `an invalid push request is 422` (final on interrupted; a mismatched headSha; a resolve checkpoint; salvage from the agent);
  - `push-plan answers the branch and egress and revokes stale reservations`;
  - `push-token refuses killed, paused, observe, another stick, another epoch, a non-pushing role`;
  - `one live reservation per drop` (two concurrent injects; exactly one grant);
  - `rediscovery revokes a stale reservation` (salvage then push-token succeeds);
  - `the grant carries the drop's own secrets only` (the reviewer, join and other-zone tokens are absent);
  - `the audit row never contains the token`;
  - `push-result pushed applies the outcome with the pushed sha and skips usage`;
  - `a failed final push fails the drop`;
  - `a failed checkpoint push resumes from the prior sha`;
  - `a retryable failure stays pending`;
  - `nothing returns the drop to lost`;
  - `push-result is idempotent after it applied`;
  - `salvage accepts pending, recently lost running and kill-cancelled drops; refuses resolve, old lost, and items with another active drop`;
  - `heartbeat answers killed and cancel for pending pushes`;
  - `push-plan and push-token answer stale for a drop that left push_pending`;
  - `a rate-limited probe is judged as the probe after the usage split` (an ordinary result, and a push-requested one: requeued uncharged, as today);
  - `a checkpoint with nothing new spends the resume budget`.
- [ ] **Step 2:** Run `npx vitest run apps/server/src/api apps/server/src/results.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): push-plan, push-token, push-result and salvage routes`.

### Task 4: Server leases: kill switch, retention, reclaim, server restart

**Files:**
- Modify: `apps/server/src/leases.ts` (`engageKill` `:161-179`, `expireLeases` `:216-245`), `apps/server/src/api/control.ts:676-687` (the release credits the pause), `apps/server/src/flow/decide.ts:195`, `apps/server/src/flow/reconcile.ts:102`, `:140`, `apps/server/src/db/repo.ts` (`reclaimableDropFor`)
- Test: `apps/server/src/leases.test.ts`, `apps/server/src/flow/kill.test.ts`, `apps/server/src/flow/decide.test.ts`

**Interfaces:**
- Produces:
  - `engageKill` is unchanged in scope. `push_pending` isn't in its `WHERE`.
  - Release: `setKilled(false)` returns the paused milliseconds, and the route adds them to every `push_pending` deadline (Ruling 12).
  - `expireLeases`:
    - while not killed, a `push_pending` drop past its deadline becomes `lost` (`push retention expired`), runs `revokeGrants`, and requeues: implement through `insertReplacement` with resume from `head_sha` when the drop has one; heal and resolve leave the item `pr_open`;
    - an `in_flight` item whose latest drop is `lost` with `running_at` within `RECLAIM_WINDOW_MS` isn't requeued.
  - `reclaimableDropFor(db, itemId, now): Drop | undefined`. `decide.ts` and `reconcile.ts` treat it like `activeDropFor`.
  - `leaseExpirer` (`:264-281`) keeps extending only leased and running drops after a restart. `push_pending` has no lease.

- [ ] **Step 1: Failing tests:**
  - `engageKill leaves pending pushes in place`;
  - `retention never expires while killed, and release credits the pause`;
  - `retention expiry requeues from the last pushed sha` (implement), and `leaves heal and resolve items pr_open`;
  - `a lost running drop holds its item for the reclaim window` (`expireLeases`), `decide waits on a reclaimable heal drop`, and `reconcile adopts no branch during the reclaim window`;
  - `server restart: pending pushes survive and running drops get a lease period` (`leaseExpirer` with a db that has both);
  - `kill, salvage, release: the pending push gets a grant after release` (`flowHarness`);
  - `a paused zone's pending push gets its grant when the zone is active again`.
- [ ] **Step 2:** Run `npx vitest run apps/server/src/leases.test.ts apps/server/src/flow`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): kill switch, retention and reclaim for pending pushes`.

### Task 5: Server: `ctl drops extend-retention` and the `stick.volumes` check

**Files:**
- Modify: `apps/server/src/api/control.ts`, `apps/server/src/api/manifest.ts` (`CONTROL_ROUTES` `:34`, `CTL_VERBS` `:175-273`), `apps/server/src/ctl.ts` (`rawRequest` `:317-404`), `apps/server/src/doctor/checks.ts` (`CHECK_IDS` `:77-110`, `runChecks` `:2113-2149`)
- Test: `apps/server/src/api/control.test.ts`, `apps/server/src/api/manifest.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/doctor/checks.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/control/drops/:id/extend-retention {hours: 1..168}`. It is guarded and audited as `extend-retention`; a drop not in `push_pending` gets 409. The `ctl` verb is `drops extend-retention <dropId> <hours>`.
  - `POST /api/control/drops/:id/cancel`, guarded, audited as `cancel-push`, `push_pending` only (Ruling 16). The `ctl` verb is `drops cancel <dropId>`.
  - `stickVolumesCheck(d, sticks)`:
    - pass when every live stick advertises `push-v1`;
    - warn when some do;
    - fail when none do, with fix `Update the stick, and check that it can create Docker volumes and has 10 GiB free: without that it takes no implement, heal or resolve work.` and doc `install.md#sticks`.

- [ ] **Step 1: Failing tests:**
  - `extend-retention moves the deadline and audits`;
  - `extend-retention refuses a drop that isn't pending`;
  - `ctl help lists drops extend-retention and drops cancel`;
  - `cancel of a pending implement push sets the item ready and revokes; heal stays pr_open`;
  - `stick.volumes passes, warns and fails`.
- [ ] **Step 2:** Run `npx vitest run apps/server/src/api apps/server/src/ctl.test.ts apps/server/src/doctor`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): ctl drops extend-retention and stick.volumes check`.

### Task 6: Trooper stdin: payload by line, grant reader

**Files:**
- Create: `apps/trooper/src/stdin.ts`
- Modify: `apps/trooper/src/main.ts:156-179`
- Test: `apps/trooper/src/stdin.test.ts`, `apps/trooper/src/main.test.ts`

**Interfaces:**
- Produces:
  - `readLine(stream, maxBytes): Promise<string>`. It rejects with `stdin closed before a line` on EOF and `stdin line too long` past `maxBytes`, and leaves the rest of the stream unread.
  - `readPayload(file, stdin): Promise<DropPayload | PushPayload>`. It skips the Docker prefix up to `{"protocol":` and reads one line. `JSON.stringify` emits no raw newline. Agent roles still get stdin closed after the payload; the push role keeps it open for the grant line.
  - `readGrant(stdin): Promise<PushGrant>`, with `maxBytes` 1 MiB.

- [ ] **Step 1: Failing tests:**
  - `readPayload reads one line and leaves the stream open`;
  - `readPayload strips a Docker prefix`;
  - `readGrant reads the second line`;
  - `readLine rejects past maxBytes`;
  - `readLine rejects on EOF with no newline`.
- [ ] **Step 2:** Run `npx vitest run apps/trooper/src/stdin.test.ts apps/trooper/src/main.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(trooper): read the payload as one line; grant reader`.

### Task 7: Trooper git: stage from the agent, push with a grant, no mirror

**Files:**
- Modify: `apps/trooper/src/git.ts`. Add `stageFromAgent` and `pushStaged`. `guardedPush`/`pushNewBranch`/`pushExistingBranch` stay until Task 13 removes them. `prePushCheck` is unchanged.
- Modify: `apps/trooper/src/privilege.ts`. Add `agentProcessesAlive`.
- Test: `apps/trooper/src/git.push.test.ts` (new, `world()` copied from `git.guard.test.ts:66-99`), `apps/trooper/src/privilege.test.ts`

**Interfaces:**
- Produces:
  - `stageFromAgent(dir, branch, o: {as?, sweep, limits?}): Promise<{pushDir, head} | {nothing: string}>`.
    - It creates `pushDir = mkdtemp(<workRoot>/push-)`, runs `initBare`, then `sweep()`.
    - As root it fetches `file://<dir>` with `--upload-pack=` the hardened command (Global Constraints) wrapped by `asAgentArgv`, into `+refs/heads/<branch>:refs/heads/<branch>`, under the size watch.
    - Then `sweep()` again, rewrite `config`, remove `hooks`, and `rev-parse`.
    - A missing branch returns `{nothing: 'branch not in the working copy'}`.
    - It takes no token.
  - `pushStaged(pushDir, grant, o: {remoteUrl?}): Promise<PushResult>`.
    1. Fetch `+refs/heads/<base>:refs/jm/base` from GitHub (or `remoteUrl`) with the token. A network failure is `failed`, retryable.
    2. `prePushCheck(pushDir, branch, protectedPaths, lease || 'refs/jm/base', secrets)`. A refusal is `failed`, not retryable.
    3. `expectSha` against the head: a mismatch is `failed` (`pushed branch is not the gated commit`, not retryable).
    4. For a checkpoint, when `lease` equals the staged head, return `nothing` (`nothing ahead`).
    5. Push with `--force-with-lease`. On rejection, run `ls-remote`: equal to `expectSha ?? head` gives `pushed` with `alreadyThere`; otherwise `failed` with `stale info: …`, not retryable.
    6. Remove `pushDir` in a `finally`.
  - `agentProcessesAlive(uid, procRoot = '/proc'): number`.

- [ ] **Step 1: Failing tests:**
  - `staging never runs root git in the working copy` (a planted `core.fsmonitor`, hook, clean filter, `core.sshCommand` and `includeIf`: the markers are absent);
  - `upload-pack's fsmonitor and hooks are disabled` (behavioural: a working copy whose `.git/config` sets `core.fsmonitor` to a marker script, and a `post-upload-pack`-style hook; the markers are absent, `recordSpawn` sees the `--upload-pack=` string containing `env GIT_NO_LAZY_FETCH=1 git -c core.fsmonitor=false -c core.hooksPath=/dev/null upload-pack`);
  - `a promisor remote in the working copy is never fetched` (a marker URL; absent);
  - `an oversized working copy fails before the token` (`maxBytes` 10 000; a 1 MB blob);
  - `a missing branch is nothing`;
  - `pushStaged: new branch; protected path and rename source; protected dotfile; secret in an added line; non-agent author; expectSha mismatch; stale remote; already there; checkpoint with nothing ahead; base fetch network failure is retryable`;
  - `nothing is read from a mirror` (no mirror path is ever in `recordSpawn`);
  - `agentProcessesAlive counts real and effective uids`.
- [ ] **Step 2:** Run `npx vitest run apps/trooper/src/git.push.test.ts apps/trooper/src/privilege.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, reusing `initBare`, `runGit`, `asAgentArgv`, `dirSize` and `prePushCheck`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(trooper): stage from the agent and push with a grant`.

### Task 8: Trooper `push` role with the token-last handshake

**Files:**
- Create: `apps/trooper/src/roles/push.ts`
- Modify: `apps/trooper/src/main.ts` (`main()` `:199-215` dispatches `role === 'push'`), `apps/trooper/src/git.ts` (`commitIfDirty` gains `o.hardened`)
- Test: `apps/trooper/src/roles/push.test.ts`, `apps/trooper/src/git.test.ts`

**Interfaces:**
- Produces:
  - `runPush(payload: PushPayload, deps: PushDeps): Promise<PushResult>`.
    1. If `salvage`, run `commitIfDirty(repo, 'wip: salvage', agent, {hardened: true})`, with `-c core.fsmonitor=false -c core.hooksPath=/dev/null` on status, add and commit, and a 60 s timeout.
    2. `stageFromAgent`. `{nothing}` is returned as the result.
    3. `sweep()`.
    4. `alive(agent.uid) > 0` gives `failed`, `agent process survived the sweep`, retryable, and no ready line.
    5. `emit(READY_LINE)`.
    6. `readGrant`.
    7. A grant branch that differs from the payload's gives `failed`, not retryable.
    8. `pushStaged`.

    The result line is redacted with `grant.secrets` plus the token's basic-auth form.
  - `PushDeps = { stdin, emit, ids, sweep, alive, git: {stageFromAgent, pushStaged, commitIfDirty} }`.

- [ ] **Step 1: Failing tests:**
  - `ready only after staging and the sweep`;
  - `no ready when an agent process survives`;
  - `salvage commits as the agent, hardened, before staging`;
  - `the grant is consumed only after ready`;
  - `a grant for another branch is refused`;
  - `the result line never contains the token or its basic-auth form`;
  - `nothing is reported as nothing`;
  - `commitIfDirty hardened doesn't run a planted fsmonitor` (`git.test.ts`).
- [ ] **Step 2:** Run `npx vitest run apps/trooper/src/roles/push.test.ts apps/trooper/src/git.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(trooper): push role with token-last handshake`.

### Task 9: Trooper image: the repo directory, the push label, the lazy-fetch check

**Files:**
- Modify: `images/trooper/Dockerfile`. At `:21` add `LABEL org.jumpmaster.trooper.push="1"`; at `:44-51` add `install -d -o 10001 -g 10001 -m 0700 /home/agent/repo`. Do the same for every stack image Dockerfile that builds `FROM` the trooper and resets labels (check `images/trooper-*`).
- Create: `images/trooper/e2e/lazy-fetch.sh`
- Modify: the CI `images` job that runs `images/trooper/e2e/*.sh`, and `scripts/workflows.test.ts` if it pins the list.

- [ ] **Step 1:** Write `lazy-fetch.sh`. Inside `docker run --rm --network none <image>`, it makes a `--filter=blob:none` partial clone of a local bare repo, then asserts that `GIT_NO_LAZY_FETCH=1 git cat-file -p <missing blob>` fails with `lazy fetching disabled`.
- [ ] **Step 2:** Run `bash images/trooper/e2e/lazy-fetch.sh jumpmaster-trooper:dev`. Expected: PASS. **If it fails, stop**: the spec's premise is wrong, and the owner decides.
- [ ] **Step 3:** Add the Dockerfile lines and rebuild. Then check:
  - `docker run --rm --entrypoint stat jumpmaster-trooper:dev -c '%u:%g %a' /home/agent/repo`. Expected: `10001:10001 700`.
  - `docker image inspect -f '{{index .Config.Labels "org.jumpmaster.trooper.push"}}'` on each image. Expected: `1`.
- [ ] **Step 4: Commit** `build(trooper): repo dir, push label, lazy-fetch check`.

### Task 10: Stick driver: volumes, mounts, init, held-open stdin

**Files:**
- Modify: `apps/stick/src/driver.ts` (`:3-11`, `:44-123`), `apps/stick/src/docker.ts` (`start` `:498-610`), every fake (`runner.test.ts:48`, `docker.test.ts:56`, the e2e `*.mjs`)
- Create: `apps/stick/src/volumes.ts`
- Test: `apps/stick/src/docker.test.ts`, `apps/stick/src/volumes.test.ts`

**Interfaces:**
- Produces, on `ContainerDriver`:
  - `createVolume(name, labels)`, `inspectVolume(name)`, `listVolumesByLabel(label, value)` and `removeVolume(name)` (idempotent on 404).
  - `start(o)` gains `mount?: {volume, target: '/home/agent/repo'}` and `holdStdin?: boolean`. The payload is always written newline-terminated.
  - `ContainerHandle` gains `writeLine(line)` and `endStdin()`.
  - `removeAndWait(name, timeoutMs): Promise<void>`. It force-removes, then resolves when `inspect` returns 404, and throws `container not removed` after the timeout.
  - `freeBytes(): Promise<number>`, by `statfs` on `docker info`'s `DockerRootDir`.
- Produces, in `volumes.ts`:
  - `volumeName(dropId, epoch, nonce?)`.
  - `prepareVolume(driver, {dropId, epoch, stickId, image})`. It throws `volume exists for drop <id> epoch <n>` when `listVolumesByLabel` finds one with the same drop and epoch. Otherwise it creates the volume and runs the init container (Global Constraints), throwing on a non-zero exit.

- [ ] **Step 1: Failing tests:**
  - `refuses a drop whose volume for this epoch exists` (by labels);
  - `start with mount passes a single volume mount and no binds`;
  - `holdStdin keeps stdin open until endStdin`;
  - `prepareVolume runs a no-network CHOWN-only init container from the base image`;
  - `removeVolume ignores 404`;
  - `removeAndWait times out with a clear error`.
- [ ] **Step 2:** Run `npx vitest run apps/stick/src/docker.test.ts apps/stick/src/volumes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and update the fakes.
- [ ] **Step 4:** Rerun, then `npx vitest run apps/stick`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stick): volumes, single mount, init container, held-open stdin`.

### Task 11: Stick: agent run on a volume, the push loop, salvage

**Files:**
- Modify: `apps/stick/src/runner.ts` (`runDrop` `:162-298`, `runContainer` `:300-447`, heartbeat `:364-382`), `apps/stick/src/client.ts`
- Create: `apps/stick/src/push.ts`
- Test: `apps/stick/src/runner.test.ts`, `apps/stick/src/push.test.ts`, `apps/stick/src/client.test.ts`

**Interfaces:**
- Produces, on the client:
  - `features` (from the lease response header);
  - `pushPlan(dropId, epoch)`;
  - `pushGrant(dropId, epoch)`, answering `{grant} | {refused, retryable}`;
  - `postPushResult(dropId, epoch, result)`, answering `'ok'|'stale'` and treating 200 as ok (Ruling 13);
  - `salvage(dropId, epoch)`, answering `'ok'|'refused'`;
  - `heartbeat` adds `'killed'`.
- Produces, in `push.ts`:
  - `PendingPushes`: a `Map<dropId, {epoch, volume, attempts, nextAt, noResult}>`, with `size()`, `add()`, `remove()`, `due(now)` and `networks()`.
  - `pushOnce(entry, deps): Promise<'done'|'retry'|'killed'|'cancelled'>`:
    1. `pushPlan`. On `stale`, remove the volume and the entry and return `done` (Ruling 19);
    2. start the push container with the plan's egress or plain network, `TROOPER_IMAGE`, `mount` and `holdStdin`, and the `PushPayload` line;
    3. wait for `READY_LINE` (`READY_TIMEOUT_MS`);
    4. `pushGrant`; on a refusal, stop the container and retry;
    5. `writeLine(grant)`, `endStdin`, wait for the result;
    6. `postPushResult`; 5xx retries;
    7. on a `pushed`, non-retryable `failed`, or `nothing` result, remove the volume and return `done`.

    Extra cases:
    - An exit before ready with a result line posts that result.
    - With no result line it counts `noResult`, and at `NO_RESULT_RETRIES` it posts `failed`, `push container exited without a result`, not retryable.
    - A heartbeat while running answers `killed` (stop, keep the volume, back off) or `cancel` (stop, remove the volume, `done`).
    - Backoff is `min(PUSH_BACKOFF_MAX_MS, 15 s · 2^attempts)`.
- Behaviour in `runDrop` and `runContainer`:
  - A `payload.image` without the push label posts `failed`, `trooper image too old for push containers`.
  - Otherwise `prepareVolume` runs before the agent container, with `mount`.
  - After the agent container exits with a result carrying `push`:
    1. `postResult`, held and retried in memory while the server is unreachable;
    2. on 409, `salvage`; on refused, remove the volume;
    3. `removeAndWait(agent container, REMOVE_TIMEOUT_MS)`;
    4. `PendingPushes.add`, and return.
  - A result without `push`: remove the volume.
  - The lost-server rule calls `stop(LOST_SERVER_GRACE_MS)`. `hard_cancel` calls `hardKill`, then `removeAndWait`, then `salvage`, and on `ok` the entry is added. Every path that adds an entry has passed `removeAndWait` (Ruling 14).
  - A pushing-role payload from a server without `push-v1`: don't start, post nothing, stop heartbeating, and log (Ruling 11).
  - A stale or cancelled drop without a salvage: remove the volume.
- In `main.ts`, a `pushLoop` every `PUSH_LOOP_MS` runs `due()` entries, at most `MAX_CONCURRENT_PUSHES` at a time.

- [ ] **Step 1: Failing tests:**
  - `posts the push-requested result before any push container`;
  - `starts the push container only after the agent container is removed`;
  - `the push container uses the base image, one mount, its own network, and no token in its payload`;
  - `writes the grant only after ready`;
  - `retries a refused grant with capped backoff and keeps the volume`;
  - `holds the result in memory while the server is unreachable`;
  - `a 409 on a held result triggers salvage, not removal`;
  - `lost server stops with a 60 s grace`;
  - `hard cancel kills, then salvages`;
  - `killed keeps the volume; cancel removes it`;
  - `a pushing role from a server without push-v1 is never started and gets no result`;
  - `salvage starts no push container until the killed agent container is removed`;
  - `a stale plan removes the volume and the entry`;
  - `refuses an image without the push label`;
  - `exit before ready without a result retries, then fails after three`;
  - `the push loop runs at most two at a time and never holds a lease slot`.
- [ ] **Step 2:** Run `npx vitest run apps/stick`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stick): agent-free push container and push loop`.

### Task 12: Stick startup: self-check, base image, rediscovery, sweep, floor and cap

**Files:**
- Modify: `apps/stick/src/main.ts` (`:50-114`), `apps/stick/src/runner.ts` (`reapOrphans` `:54-66`, `sweepDropNetworks` `:73-95`), `apps/stick/src/state.ts` (`advertisedCapabilities` `:55-63`), `apps/stick/src/verify.ts` (`prepareImageTrust` `:332`)
- Modify: `images/stick/Dockerfile:69-76`, and the release workflow's stick build args.
- Test: `apps/stick/src/runner.test.ts`, `apps/stick/src/state.test.ts`, `apps/stick/src/verify.test.ts`, `scripts/workflows.test.ts`

**Interfaces:**
- Produces:
  - `volumeSelfCheck(driver, image, stickId): Promise<boolean>`. It never throws. It runs at startup and on every sweep. `push-v1` is advertised only from the latest pass with `freeBytes() >= VOLUME_FREE_FLOOR_BYTES`.
  - `prepareImageTrust` also pulls and verifies `TROOPER_IMAGE` (Ruling 17).
  - `rediscoverPending(driver, client, stickId, pending)`. It runs after `reapOrphans` has completed (and confirmed each removal) and before the first lease: for each volume of this stick, `salvage` gives `ok` (add) or `refused` (remove).
  - `reapOrphans` never removes volumes. The sweep removes this stick's volumes and `jm-push-*` networks not held by a live drop or a `PendingPushes` entry.
  - The lease body adds `noPush: true` when `pending.size() >= MAX_PENDING_PUSHES`. The stick doesn't lease at all below the free floor.

- [ ] **Step 1: Failing tests:**
  - `push-v1 is advertised only after a passing self-check above the floor`, and `is withdrawn when a later sweep fails`;
  - `the base image is verified at startup`;
  - `rediscovers a pending push whose push container died with the stick`;
  - `a refused rediscovery removes the volume`;
  - `the sweep keeps live and pending volumes and networks`;
  - `below the floor the stick does not lease`;
  - `at the cap the lease says noPush`;
  - `the release stick image sets JM_TROOPER_IMAGE`.
- [ ] **Step 2:** Run `npx vitest run apps/stick scripts/workflows.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stick): self-check, base image trust, rediscovery, floor and cap`.

### Task 13: Trooper roles end in a push request (the switch)

**Files:**
- Modify:
  - `apps/trooper/src/roles/implement.ts` (`:78-99`, `:116`, `:151`);
  - `roles/heal.ts` (`:51-69`, `:89`, `:128`);
  - `roles/resolve.ts` (`:114-129`);
  - `roles/shared.ts` (`checkpoint` `:392-404`);
  - `apps/trooper/src/main.ts` (`finally` `:105-111`);
  - `apps/trooper/src/git.ts`: delete `guardedPush`, `pushNewBranch`, `pushExistingBranch` and the `mirrorDir` push option.
- Modify: `apps/trooper/src/git.guard.test.ts`. Delete the suites now covered by `git.push.test.ts`, keeping the clone/mirror suites.
- Modify: `apps/server/src/payloads.ts:341` (Ruling 1)
- Test: the role tests, `roles/shared.test.ts`, `main.test.ts`, `test/roleWorld.ts`, `apps/server/src/payloads.test.ts`

**Interfaces:**
- Produces:
  - completed implement, heal or resolve: `{status:'completed', headSha: gatedSha, push: {kind:'final', expectSha: gatedSha}}`;
  - an implement or heal early stop with commits ahead: `{status, headSha: checkpointSha, push: {kind:'checkpoint'}}`;
  - `checkpoint(deps, ctx, dir, base): Promise<string|undefined>`;
  - the `finally` keeps `<agent.home>/repo` when `result.push` is set;
  - `buildPayload` (`apps/server/src/payloads.ts:341`) applies Ruling 1.

- [ ] **Step 1: Failing tests:**
  - `implement completed carries push final and pushes nothing`;
  - `implement and heal early stops carry checkpoint`;
  - `resolve early stop has no push`;
  - `runTrooper keeps the repo only when a push is requested`;
  - `a lapsed read token fails clearly at the start` (a 401 at clone gives `failed`, `the read token was refused (401): renew it`, with no push);
  - `implement payloads carry the read token when configured` (`apps/server/src/payloads.test.ts`).
- [ ] **Step 2:** Run `npx vitest run apps/trooper`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then the full gates: `npm run -s typecheck`, `npx biome check .`, `npx vitest run`. Expected: all exit 0.
- [ ] **Step 5: Commit** `feat(trooper): roles end in a push request; the agent container never pushes`.

### Task 14: End-to-end on a real engine, docs, spec corrections

**Files:**
- Create: `images/trooper/e2e/push.sh` and `push-drop.mjs` (the `egress-drop.mjs` pattern: the real `runDrop`, `pushOnce` and `DockerDriver`, a fake server client, and a local bare remote through `remoteUrl`)
- Modify:
  - `docs/runbooks/install.md`: sticks, `push-v1`, volumes, free space, deploy order;
  - the operate runbook: pending pushes, `ctl drops extend-retention`, kill switch behaviour, cancel;
  - `SECURITY.md`: the push container, and the PAT-mode caveat.
- Modify: `docs/superpowers/specs/2026-11-13-github-app-auth.md` §4.2. Correct:
  - `docker.ts:585`;
  - `leaseExpirer` already waits;
  - heal checkpoints and resolve doesn't;
  - the read token is new, not "as today";
  - `Init: true`, so the trooper isn't PID 1;
  - the doctor check is advertised;
  - the stick reads labels and the plan.

  Cite this plan's rulings.
- Test: `scripts/docs.test.ts`

- [ ] **Step 1:** `push.sh` runs, on a real engine:
  1. an implement drop that completes, pushed by a push container (the bare remote has the gated SHA);
  2. an interrupted drop whose checkpoint is pushed;
  3. a planted `core.fsmonitor` in the working copy, whose marker is absent;
  4. a lingering agent-uid process left by the agent container, which isn't alive in the push container (`agentProcessesAlive` is 0, and ready is emitted);
  5. the agent container's only mount is the volume;
  6. the volume removed at the end.

  Expected last line: `push e2e: ok`.
- [ ] **Step 2:** Run `bash images/trooper/e2e/push.sh`. Expected: `push e2e: ok`.
- [ ] **Step 3:** Docs and spec corrections. Run `npx vitest run scripts/docs.test.ts`. Expected: PASS.
- [ ] **Step 4:** Full gates. Expected: all exit 0.
- [ ] **Step 5: Commit** `test(e2e): push container on a real engine; docs`. Then open the feature PR.

## Spec coverage

| §4.2 requirement | Tasks |
|---|---|
| Push container: agent-free, base image (verified), own egress | 9, 10, 11, 12 |
| One volume, naming, refuse existing, init, image directory | 9, 10 |
| Working copy kept on a push request; nothing secret written | 1, 13 |
| Token last, ready line, no agent process alive | 7, 8 |
| `upload-pack` hardened, `GIT_NO_LAZY_FETCH`, image check | 7, 9 |
| Agent container removed first | 11 |
| Result first, `push_pending`, probe released (usage applied once) | 3, 11 |
| Token route: auth, refusals, reservation, every parameter, audit | 3 |
| Leases; "already there" is success | 3, 7 |
| Checkpoints (implement, heal) and their failure semantics | 3, 13 |
| Lost-server grace stop; salvage after a kill; reclaim window | 3, 4, 11 |
| Server unreachable or restarting; stick restarting | 4, 11, 12 |
| Kill switch, observe/paused, operator cancel | 3, 4, 11 |
| Retention, extension, pause under kill, free floor, pending cap | 4, 5, 12 |
| `stick.volumes` | 5, 12 |
| Revocation (PAT mode: reservation rows) | 2, 3 |
| Mixed versions and deploy order | 3, 11, 14 |
| The spec's test list | 3, 4, 7, 8, 10, 11, 12, 13, 14 |
