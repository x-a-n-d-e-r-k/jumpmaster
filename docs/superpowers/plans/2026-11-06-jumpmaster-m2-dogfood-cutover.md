# M2 Dogfood Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operator the controls and test infrastructure needed to move a real project onto Jumpmaster safely, then cut the reference project over from the proof of concept.

**Architecture:** Zone controls live in the database and are enforced at the few places work starts or the forge is written. Observe mode runs the normal decision code but records each action instead of performing it. Secrets, services and verification extend the drop payload and the stick and trooper, leaving the decision table almost unchanged.

**Tech Stack:** TypeScript (ESM, strict), Node 24+, Fastify 5, better-sqlite3, zod, dockerode, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md` §5.3 (controls), §5.4 (verification, services, secrets), §7, §15 (M2 and migration).

## Global Constraints

- Build on `main`. Run `npm test`, `npm run typecheck` and `npx biome check .` before every commit.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the owner chose for this repository. PR bodies carry no generated-with footer.
- This repository is public. Call the target "the reference project". No private project names, hostnames, local paths or account names in code, docs or tests.
- No secret value is ever printed, logged, stored in the database, or placed in argv or URLs.
- "The two systems never both act on one repo" (§15). Nothing here may write to the reference project before the cutover step in Task 8.
- Default values must keep every M1 zone behaving exactly as it does now.
- Add DB changes as migration v3. Never edit `schema.sql` or an earlier migration.

## Rulings on spec gaps

- **Operator auth:** §7.5's login is not in M2's list, but control routes can't ship open. A trooper can reach the host's loopback through the container runtime on some platforms, so Host and Origin checks alone aren't enough. All control routes require `JM_OPERATOR_TOKEN`. Full login stays a later milestone.
- **"Revoke all drop credentials":** M2 tokens are long-lived PATs that Jumpmaster can't revoke. The kill switch stops all work and refuses new leases, and the UI tells the operator to revoke the tokens on the forge. Short-lived credentials remain §7.3 work.
- **Secrets at rest:** M2 reads zone secrets from environment variables. The encrypted vault (§7.5) arrives later, and they are never written to the database.
- **Gate secrets are readable by PR code:** gates run PR-controlled code with the secret in its environment, and M2 has no egress control (M4). Any PR or install script can read and send the value. Until M4, only sidecar-local or throwaway credentials are acceptable, and the runbook says so.
- **Emergency stop:** `docker stop` makes a trooper checkpoint and push. The host-side emergency stop is `docker kill`.
- **Services shape:** a structured list rather than a compose fragment. It covers the one known need and is far easier to harden.
- **Adoption:** §15 says adopt by branch convention, but the reference project's agent PRs share an author with hand-opened PRs, and #15 restricted adoption to marked PRs for that reason. Cutover adoption is therefore an explicit list of PR numbers.
- **Merge queue and classic protection:** the reference project has no active merge queue. Its classic branch protection is replaced with a ruleset at cutover rather than teaching Jumpmaster to read classic rules, which needs admin rights. The ruleset allows no bypass, so it also binds the owner's hand-opened PRs: this is the owner's decision at stage 4.

## Review Focus

1. A control change during in-flight work: a drop running or a forge write pending when a zone moves to observe, or when the kill switch fires. Nothing may reach the forge afterwards except a push already under way.
2. A server restart while paused, observing or killed: the state must persist and never fall back to the config default.
3. A real project's scale inside the hardened container: the process limit of 512 could fail a large test run for a reason unrelated to the code, and it must be configurable and report clearly.
4. Stale agent branches on the target repo: a ready item with an old `agent/issue-N` branch would resume months-old work. Observe mode must surface it before switching.
5. A secret or service leak across drops: sidecars, networks and secrets from a killed or crashed drop must not survive into the next drop.

---

### Task 1: Zone controls and operator auth

**Files:**
- Modify: `apps/server/src/db/migrations.ts`, `apps/server/src/db/repo.ts`, `apps/server/src/config.ts`, `apps/server/src/app.ts`
- Create: `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/api/control.test.ts`, `apps/server/src/db/repo.test.ts`, `apps/server/src/config.test.ts`

**Interfaces:**
- Produces: `type ZoneMode = 'active' | 'paused' | 'observe'`; `getZoneMode(db, zoneId, fallback: ZoneMode): ZoneMode`; `setZoneMode(db, zoneId, mode, now)`; `isKilled(db): boolean`; `setKilled(db, engaged: boolean, now)`; `zoneIsDrained(db, zoneId): boolean`; `registerControlRoutes(app, deps)`.
- Config: zone `mode: ZoneMode` default `'active'`, used only until a stored value exists. New required secret `JM_OPERATOR_TOKEN`, at least 32 characters, differing from every other secret. Top-level `listen.allowedHosts: string[]`, default `['127.0.0.1:<port>', 'localhost:<port>']`.

- [ ] **Step 1: Write failing tests.** In `control.test.ts`:

```ts
test('every control route refuses a missing or wrong token', ...)      // 401, state unchanged
test('a wrong Host or foreign Origin is refused even with the token', ...) // 403
test('moving to observe is refused while the zone has active work', ...)   // 409 naming the count
test('moving to observe succeeds once drained', ...)
test('pause and resume are allowed with active work', ...)
test('an unknown zone or mode is refused', ...)                       // 404, 400
test('a listed host is accepted on a non-loopback listen address', ...)
test('a stored mode survives a restart and beats the config default', ...)
```

`zoneIsDrained` is false while the zone has a drop in `queued`, `leased` or `running`, or an outbox op in `pending` or `unknown`.

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/server/src/api/control.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** Migration v3 adds `zone_controls(zone_id PK, mode, updated_at)` and `kill_switch(id=1 CHECK, engaged, updated_at)`. Routes: `POST /api/control/zones/:id` with `{ mode }`, `POST /api/control/kill` with `{ engaged }`, using `crypto.timingSafeEqual` on the bearer token. Host must be in `listen.allowedHosts`. A missing Origin is allowed, so the CLI works. `ctl.ts`: `node apps/server/dist/ctl.js <pause|resume|observe|kill|unkill> [zone]`, reading the token from the environment.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add zone controls and operator auth`

### Task 2: Pause and observe enforcement

**Files:**
- Modify: `apps/server/src/flow/reconcile.ts`, `apps/server/src/scheduler.ts`, `apps/server/src/leases.ts`, `apps/server/src/outbox.ts`, `apps/server/src/results.ts`, `apps/server/src/sync.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/db/repo.ts`, `apps/server/src/app.ts`
- Create: `apps/server/src/flow/observe.ts`
- Test: `apps/server/src/flow/observe.test.ts`, `apps/server/src/flow/failure-classes.test.ts`

**Interfaces:**
- Consumes: `getZoneMode`, `isKilled` from Task 1.
- Produces: `recordObservation(db, zoneId, itemId: number | null, action: string, detail: string, now)`; `listObservations(db, zoneId)`; `GET /observations`.
- Table (v3): `observations(id, zone_id, item_id, action, detail, first_at, last_at, count)`, unique on `(zone_id, item_id, action, detail)`. A repeat increments `count`.

Behaviour:

| | active | paused | observe |
|---|---|---|---|
| Read the forge, create work items | yes | yes | yes |
| Adopt listed PRs (DB only) | yes | yes | yes |
| Enqueue drops, including resume | yes | no | records `would_enqueue:<role>` |
| Lease queued drops | yes | no | no |
| Post reviews, merge | yes | no | records `would_post_review`, `would_merge` |
| Set an item parked or done, from decide or resume | yes | no | records `would_park`, `would_done` |
| A drop already running | finishes | finishes, its push and PR proceed; its review post waits for resume | can't exist |

- [ ] **Step 1: Write failing tests.** In `observe.test.ts`, drive a world through issues, a behind-base PR, an approved PR and a stale branch:

```ts
test('observe makes no forge write across every decision kind', ...)
  // assert the fake's write calls are empty: createPull, createReview, merge, labels, comments
test('observe creates no drop and changes no item state', ...)
test('observe records what it would do, once per decision, with a count', ...)
test('a ready item with an old agent branch records would_enqueue:resume with the branch sha', ...)
test('runOp refuses in observe before inserting any outbox row', ...)    // the second layer
test('observe does not park a hand-opened or listed PR', ...)
test('a would_enqueue:resume observation survives the rolled-back charge', ...)
test('pause starts nothing and posts nothing, and resume continues', ...)
test('a queued drop is not leased while paused or observing', ...)
test('a review finishing during pause posts after resume, not during', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/server/src/flow/observe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the mode once at the start of `reconcileZone` and branch in its action switch. `enqueueImplement` and `lease` also check it, so no path is missed. `runOp` looks up the item's zone and throws in observe, before its `pending` insert, since a row left behind would later become `unknown` and park the item. Record resume observations outside the charge transaction, which rolls back in observe. `results.ts` reuses the deferred-post path added for `jm:hold`. Audit `sync.ts` and confirm by test that it never writes to the forge.
- [ ] **Step 4: Add `/observations`** and a home-page line showing each zone's mode. Use the existing HTML escaping, and test that a detail string containing markup is escaped.
- [ ] **Step 5: Run the full suite.** Run: `npm test`. Expected: all pass, with M1 tests unchanged.
- [ ] **Step 6: Commit.** `feat(flow): enforce pause and observe modes`

### Task 3: Global kill switch

**Files:**
- Modify: `apps/server/src/leases.ts`, `apps/server/src/api/sticks.ts`, `apps/server/src/flow/reconcile.ts`, `apps/server/src/flow/budgets.ts`, `apps/server/src/sync.ts`, `apps/server/src/ui/pages.ts`, `apps/stick/src/runner.ts`, `apps/stick/src/client.ts`, `apps/stick/src/driver.ts`, `apps/stick/src/docker.ts`
- Test: `apps/server/src/flow/kill.test.ts`, `apps/stick/src/runner.test.ts`

**Interfaces:**
- Consumes: `setKilled`, `isKilled`.
- Produces: `engageKill(db, now): { cancelled: number }`; heartbeat reply `{ cancel: boolean; hard: boolean }`; `ContainerHandle.kill()`; stick setting `JM_LOST_SERVER_KILL_BEATS`, default 6 consecutive failed heartbeats.

- [ ] **Step 1: Write failing tests.**

```ts
test('engaging cancels every queued, leased and running drop', ...)
test('while engaged: no lease, no enqueue, no outbox write, no merge', ...)
test('the switch stays engaged across a restart until explicitly reset', ...)
test('a result from a cancelled drop is refused and writes nothing', ...)
test('after reset, in_flight items with a pushed branch resume and others restart', ...)
test('a hard cancel kills the container with no checkpoint push', ...)   // stick
test('an ordinary cancel still stops it gracefully', ...)                // stick
test('a stick that loses the server hard-kills its drop after the limit', ...) // stick
test('engaging refunds the charge of each cancelled drop', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/server/src/flow/kill.test.ts apps/stick/src/runner.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** A graceful stop makes the trooper checkpoint and push, so a kill must use SIGKILL. `heartbeat` returns `hard: true` while killed. Reconcile returns immediately while killed. A stick that can't reach the server fences itself, because a kill can't otherwise reach it: at the default beat interval this is inside the 60-second lease. `engageKill` calls `refundCharge`, so a reset doesn't count cancelled work as a repeat. After a reset, stick slots bound how much work runs at once. The kill form on the home page needs the operator token in a password field and posts with a small inline `fetch`. While engaged, the page also says that running tokens remain valid and must be revoked on the forge to invalidate them.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add a global kill switch`

### Task 4: Drop-zone gate secrets

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/payloads.ts`, `packages/protocol/src/index.ts`, `apps/trooper/src/roles/shared.ts`, `apps/trooper/src/main.ts`
- Test: `apps/server/src/config.test.ts`, `apps/server/src/payloads.test.ts`, `apps/trooper/src/roles/shared.test.ts`

**Interfaces:**
- Config: zone `gateSecrets: string[]`, names only, default `[]`. Each value comes from `JM_ZONE_SECRET_<ZONE>_<NAME>`, where `<ZONE>` is the upper-cased zone id with non-alphanumerics as `_`.
- Payload: optional `gateSecrets: Record<string, string>`. Produces `zoneSecrets(config, zoneId): Record<string, string>`, and `secretList` includes these values.

- [ ] **Step 1: Write failing tests.**

```ts
test('a declared secret with no env value stops the server at startup', ...)
test('a value under 8 characters is refused', ...)        // too short to redact safely
test('a reserved name is refused', ...)                   // GH_TOKEN, GITHUB_TOKEN, CLAUDE_*, GIT_*, JM_*, PATH, HOME, LD_*, NODE_OPTIONS
test('gate steps receive the secret; the agent process does not', ...)
test('the value is redacted from gate output and events', ...)
test('the value is in the push guard secret list', ...)
test('the value never appears in drops.input_json', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/server/src/config.test.ts apps/trooper/src/roles/shared.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** Document the exfiltration ruling beside the config field. Merge secrets into the gate env after `scrubEnv` in `runGatesPhase`. Add values to `ctx.secrets` in `main.ts`. Build payloads at lease time, as today.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add per-zone gate secrets`

### Task 5: Sidecar services and container limits

**Files:**
- Modify: `apps/server/src/config.ts`, `packages/protocol/src/index.ts`, `apps/stick/src/runner.ts`, `apps/stick/src/driver.ts`, `apps/stick/src/docker.ts`, `apps/trooper/src/roles/shared.ts`, `apps/trooper/src/gates.ts`
- Test: `apps/server/src/config.test.ts`, `apps/stick/src/runner.test.ts`, `apps/stick/src/docker.test.ts`, `apps/trooper/src/roles/shared.test.ts`

**Interfaces:**
- Config: zone `services: { name: string; image: string; port: number; env?: Record<string, string>; readyTimeoutSeconds?: number }[]`, default `[]`, with `readyTimeoutSeconds` default 60. Zone `limits: { pids: number; memoryMb?: number; shmMb?: number }`, default `{ pids: 512 }`. `name` matches `^[a-z][a-z0-9-]{0,30}$`.
- Payload: optional `services`, `limits`.
- Driver: `startServices(dropId, services): Promise<{ network: string }>`; `removeServices(dropId)`; `start` gains `network?`, `pidsLimit?`.
- Trooper: `waitForServices(services, timeoutMs)`. Gates receive `JM_SERVICE_<NAME>_HOST` and `JM_SERVICE_<NAME>_PORT`.

- [ ] **Step 1: Write failing tests.**

```ts
test('a service image off the allow-list fails the drop before any container starts', ...)
test('sidecars run on an internal per-drop network with no published ports or mounts', ...)
test('sidecars are removed on success, failure, cancel and hard kill', ...)
test('stick startup removes sidecars and networks left by a crashed run', ...)
test('a service that never accepts connections fails the drop naming the service', ...)
test('gates get host and port variables; a zone with no services changes nothing', ...)
test('limits reach the container; the defaults change nothing', ...)
test('a re-lease of the same drop gets a new network name', ...)
test('a gate killed by the process limit reports that as the likely cause', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/stick apps/trooper/src/roles/shared.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** Use a network `jm-drop-<dropId>-<epoch>` with `Internal: true`, labelled like troopers so existing cleanup finds it. The trooper keeps its default network and also joins this one. Sidecars get `no-new-privileges`, a process limit and core dumps off, but keep default capabilities, since database images need them. Readiness is a TCP connect from the trooper. `createContainer` doesn't pull, so an absent image fails with a message telling the operator to pre-pull it.
- [ ] **Step 4: Run the tests, then extend `images/trooper/e2e/run.sh`** with a sidecar case using a small allow-listed image. Run: `images/trooper/e2e/run.sh`. Expected: passes with no token.
- [ ] **Step 5: Commit.** `feat(stick): add sidecar services and process limits`

### Task 6: Verification gate

**Files:**
- Create: `apps/trooper/src/verification.ts`, `apps/server/src/artifacts.ts`
- Modify: `apps/server/src/config.ts`, `packages/protocol/src/index.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/api/sticks.ts`, `apps/server/src/results.ts`, `apps/server/src/app.ts`, `apps/stick/src/runner.ts`, `apps/stick/src/client.ts`, `apps/trooper/src/roles/review.ts`
- Test: `apps/trooper/src/verification.test.ts`, `apps/server/src/artifacts.test.ts`, `apps/server/src/results.test.ts`

**Interfaces:**
- Config: zone `verification: { name: string; paths: string[]; run: string; artifacts: string; timeoutMinutes?: number }[]`, default `[]`.
- Trooper: `runVerification(payload, deps, ctx, dir): Promise<{ ok: boolean; reason?: string; files: ArtifactFile[] }>`; as-user `listDir` in `privilege.ts`, and `readAgentFile` called with a 5 MB limit. Limits: 10 files, 5 MB each. Allowed types are PNG, JPEG, WebP and JSON, detected from content, not extension.
- Server: `storeArtifact(db, dataDir, dropId, name, bytes): ArtifactRow`, written to `<dataDir>/artifacts/<dropId>/<sha256>.<ext>`; table `artifacts(id, drop_id, name, sha256, media_type, bytes, created_at)`; `POST /api/drops/:id/artifacts` with stick auth and epoch check; `GET /artifacts/:id`.

- [ ] **Step 1: Write failing tests.**

```ts
test('a diff matching no glob runs nothing and passes', ...)
test('a matching diff runs the step as the gate user with no credentials', ...)
test('a matching diff with no artifacts forces request_changes naming the rule', ...)
test('a file with a false extension, a symlink, or over the limit is refused', ...)
test('the reviewer prompt lists artifacts and it can read them', ...)
test('a 5 MB artifact crosses in chunks, reassembles by hash and stays out of drop_events', ...)
test('a missing or corrupt chunk fails verification', ...)
test('the server forces request_changes if an approve has no stored artifact for a matching PR', ...)
test('an artifact upload with a stale epoch or wrong stick is refused', ...)
test('a hostile name cannot escape the artifact directory', ...)
test('artifacts are served with nosniff and a sandbox CSP', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/trooper/src/verification.test.ts apps/server/src/artifacts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The check runs during review only, after the gates and before the agent. The step's files live in the gate user's clone, so copy them out with the existing as-user read helper into a root-owned directory the agent can read. Events are capped at 63 KiB and stored in `drop_events`, so the trooper sends files as chunked base64 `artifact_chunk` lines. The stick reassembles them, never forwards them to `/events`, and posts each file to a route with its own 8 MB `bodyLimit`. A browser-driven step needs `--no-sandbox` (setuid bits are stripped in the image) and the `shmMb` limit; the runbook documents this. The server decides independently using `protectedPathHits`-style matching on the PR's file list, since §5.4 says stick results aren't trusted for merge decisions.
- [ ] **Step 4: Run the full suite.** Run: `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `feat: add a verification gate with stored artifacts`

### Task 7: Cutover adoption and concurrency

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/flow/reconcile.ts`, `apps/server/src/scheduler.ts`, `apps/server/src/outbox.ts`, `apps/server/src/sync.ts`
- Test: `apps/server/src/flow/reconcile.test.ts`, `apps/server/src/scheduler.test.ts`, `apps/server/src/outbox.test.ts`

**Interfaces:**
- Config: zone `adoptPulls: number[]`, default `[]`. Zone `maxConcurrentImplement: number`, default `1`. Zone `outboxDeadlineMinutes: number`, defaulting to `ciDeadlineMinutes`, so long CI doesn't lengthen the ageing of unknown ops.

- [ ] **Step 1: Write failing tests.**

```ts
test('a listed PR on an agent branch by the author is adopted without a marker', ...)
test('adoption starts with no attempts charged and asks for a fresh review', ...)
test('a listed PR from another author, a fork or a non-agent branch is refused and logged', ...)
test('an unlisted unmarked PR still parks as hand-opened', ...)
test('an item already parked as hand-opened for a listed PR is adopted', ...)   // from that parked state
test('adding a PR number to adoptPulls adopts it on the next start, so batches work', ...)
test('create_pr accepts a listed open PR', ...)
test('a listed PR with a closed issue follows the closed-issue path', ...)
test('maxConcurrentImplement allows N implement drops; one per issue still holds', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Run: `npx vitest run apps/server/src/flow/reconcile.test.ts apps/server/src/scheduler.test.ts`. Expected: FAIL on the new tests.
- [ ] **Step 3: Implement.** In `adopt`, a listed number passes the check `isServerPrBody` would otherwise fail, and items parked with `hand-opened PR on agent branch: #N` for a listed N are eligible. `resume` and the `create_pr` guard must treat that PR as ours too. In `enqueueImplement`, compare the count of active implement drops to the setting.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(flow): add explicit cutover adoption and implement concurrency`

### Task 8: Runbook, rehearsal and cutover

**Files:**
- Create: `docs/runbooks/m2-cutover.md`, `images/trooper/examples/Dockerfile.pnpm`
- Modify: `docs/runbooks/m1-loop.md` (link only)

The derived Dockerfile is `FROM jumpmaster-trooper:dev` plus `corepack enable`, and the runbook explains how to add a project's toolchain and allow-list the image.

- [ ] **Step 1: Write the runbook** using these stages. Each has a pass check and a rollback, and rollback before stage 5 is "stop Jumpmaster; nothing was written".
  1. **Prepare:** config, private-repo read token, zone image, pre-pulled sidecars, `mode: "observe"`, secrets, services, limits, and open agent PRs in `adoptPulls`, so observe also sees PR decisions. Only sidecar-local or throwaway values may be gate secrets.
  2. **Observe:** run against the target with the proof of concept still acting. Review `/observations` beside the loops' real actions for at least one full day. Investigate each difference. `would_enqueue:review` is the expected steady state for a PR, because no verdicts exist in observe; the valuable signals are `would_park` and `would_enqueue:resume`. Every resume on an old branch is either closed or accepted.
  3. **Drain:** stop the old loops, wait for their drops to finish, and refresh `adoptPulls` with the PRs still open, keeping only one in the first batch.
  4. **Protect:** export the classic settings first. Create a ruleset matching them, with checks pinned to their app and no bypass, then remove classic protection, and check that the server reports no `unsafe branch protection`. The ruleset also binds the owner's and every collaborator's PRs. Rollback: delete it and restore the export.
  5. **Switch:** `ctl resume` with one adopted PR and one issue. Add the remaining PR numbers in batches with a restart, then release the backlog. Keep the old loops stopped but installed. Rollback: `ctl pause`, then close or hand back Jumpmaster's PRs before restarting the old loops; check how they treat those PRs during the rehearsal.
  6. **Retire:** after the gate holds for a week, remove the old loops and the retired account.
- [ ] **Step 2: Rehearse on the test repository.** Run stages 1 to 5 end to end, with a real sidecar, a gate secret and a verification rule that runs a real browser. Then: hold, pause, kill during a running drop, a stick cut off from the server mid-drop, restart while killed, and reset. On the first real target gate, confirm `current_user_can_bypass` reads `never` for both tokens. Expected: no write in observe or while killed, no secret in the M1 scan extended to zone secrets and artifacts.
- [ ] **Step 3: Have the branch red-teamed,** fix findings test-first, merge. Commit: `docs: add the M2 cutover runbook`
- [ ] **Step 4: Stop for the owner.** Starting the loops' drain and changing protection on the reference project are the owner's decisions. Run stage 2 (read-only) on their go-ahead, and report the differences before asking for stage 3.
- [ ] **Step 5: Cut over,** following the runbook with the owner's approval at stages 3 to 5.

**M2 gate:** the reference project runs on Jumpmaster and the proof of concept is retired.
