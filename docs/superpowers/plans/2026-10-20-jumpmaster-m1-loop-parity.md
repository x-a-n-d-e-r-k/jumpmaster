# Jumpmaster M1 (Loop parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take an issue all the way to a merged PR with no human click, while never wedging:
- implement → review → heal / resolve-conflicts → orchestrator merge;
- every forge write goes through an outbox;
- verdicts are bound to a commit SHA;
- credentials are split between two bots;
- implement checkpoints and resumes;
- the global usage pause works;
- the trust boundary is enforced.

**Architecture:**
- A pure decision function, `decide(snapshot) → action`, owns the PR lifecycle. A per-zone reconciler builds fresh forge snapshots, applies the actions, and writes to the forge only through an idempotent outbox.
- Drops become role-typed: implement, review, heal, resolve. The trooper dispatches on role.
- The agent and the gates run as a separate unprivileged uid inside the container.

**Tech Stack:** unchanged from M0 (Node ≥ 24, TypeScript 7, npm workspaces, vitest, Biome, Fastify 5, better-sqlite3, zod, @octokit/rest, nock 14, dockerode, Claude Code 2.1.302).

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md`, mainly:
- §15 (the M1 row and its gate);
- §5.1 to §5.4 (state ownership, outbox, liveness, troopers);
- §7 (trust and credentials);
- §12.3 (usage limits);
- §16 (failure classes).

The M0 findings are in `docs/spikes/usage-signals.md`.

## Global Constraints

- **No Claude attribution:** no `Co-Authored-By` or "Generated with" lines in commits, PR bodies, or any text Jumpmaster writes to a forge.
- **Public repo:** no private names, hostnames, local paths, or employer names.
- **Merging:** agents never approve or merge. Only server code merges, through the outbox, and only when the verdict SHA, the CI SHA, and the current head SHA are equal, and the change is not already on base (§7.4).
- **Credential roles:**

  | Role / process | Forge token it gets |
  |---|---|
  | **author** (`JM_GITHUB_AUTHOR_TOKEN`) | implement, heal, and resolve drops (clone and push); the server, for the merge |
  | **reviewer** (`JM_GITHUB_REVIEWER_TOKEN`) | never leaves the server; used only to post reviews |
  | review drops | the optional read token `JM_GITHUB_READ_TOKEN`, or none (public repos) |
  | crew and gates | none |
- **Forge facts:** facts that humans or CI own are re-read at decision time and never trusted from cache before a push, approve, merge, or close (§5.1).
- **Outbox:** every forge write carries a lookup key. A `<!-- jm:op:<opId> -->` marker goes in every body Jumpmaster writes, and every merge is pinned with `sha=`. Ambiguous results are recorded as `unknown` and resolved by read-back, never by blind retry (§5.2).
- **Budgets** (defaults, per work item, configurable per zone):

  | Budget | Default | Counted |
  |---|---|---|
  | `maxHeal` | 3 | |
  | `maxResolve` | 2 | |
  | `maxResume` | 2 | |
  | `maxReviewRepeat` | 2 | reviews of the same head SHA |
  | `maxNoChange` | 1 | implement runs that end `no_changes` |

  Budgets are marked before a drop runs. An exhausted budget parks the item with reason `budget exhausted: <role>`.
- **Usage:**
  - `rejected` pauses all dispatch until `resetsAt` + 30–90s jitter, then allows exactly one probe drop.
  - `allowed_warning`, or utilization ≥ `throttleUtilization` (default `0.9`) on either window, blocks new implement drops only.
  - Drops interrupted by a usage limit are requeued without consuming any budget.
- **Deadlines:** CI wait default `ciDeadlineMinutes: 45`, measured from the first time the current head was observed; `ciRequired: true` by default.
- **Inside the trooper:** the agent and the gates run as the `agent` uid. The trooper (PID 1) and every token-bearing git command run as root. Uid switching happens only when `JM_CONTAINER === '1'` and the process is root.
- **Protocol header:** `x-jumpmaster-protocol: 1` is unchanged; payload changes stay backward-compatible within this branch only.

## Review Focus

1. **A human force-pushes to the agent branch after an approval.** The approval no longer counts; a fresh review runs on the new head, and no merge happens on the old verdict. Covered by Task 6, `head change invalidates approval`.
2. **The repo has no CI and `ciRequired` is false**, as in the jm-test repo from the M0 gate run. It merges once the verdict is approve. With `ciRequired: true` it waits, then parks `no pipeline` at the deadline. Covered by Task 6, `no CI honours ciRequired`.
3. **The merge call returns 5xx after GitHub actually merged.** Exactly one merge happens; the outbox read-back marks it done and the item becomes `done` with reason `merged`. Covered by Task 4, `merge 5xx after success is resolved by read-back`.
4. **The issue is closed by a human while its PR is open.** The item leaves flight, parked with reason `issue closed`, and dispatch for other items is not blocked. Covered by Task 6, `closed issue never blocks dispatch`.
5. **The DB is restored from an older backup, or `data/` is wiped, while agent PRs are open.** The reconciler adopts the open `agent/issue-N` PRs instead of re-implementing them, and nothing is merged twice. Covered by Task 7, `adopts an existing agent PR`.

---

## File Structure

```
packages/protocol/src/index.ts           role-typed DropPayload union, Verdict, extended DropResult
apps/server/src/
  db/migrations.ts                        ordered forward-only migrations + schema_version
  db/schema.sql                           (M0 base; unchanged, migrations add the rest)
  db/repo.ts                              + PR, verdict, attempts, outbox, usage queries
  config.ts                               + reviewer/read tokens, per-role models, budgets, ci, usage
  forge/github.ts                         + PR/review/check/merge/compare/issue reads and writes
  outbox.ts                               runOp / resolveUnknown (idempotent forge writes)
  flow/decide.ts                          pure lifecycle decision: snapshot → Action
  flow/snapshot.ts                        gather fresh forge facts for one pr_open item
  flow/reconcile.ts                       per-zone pass: adopt, snapshot, decide, apply
  flow/budgets.ts                         attempts accounting
  usage.ts                                usage state, dispatch gate
  payloads.ts                             buildPayload per role + promptVersion per role (moved from api/sticks.ts)
  results.ts                              applyResult dispatch per role
  leases.ts, scheduler.ts, main.ts, ui/pages.ts   (modified)
  test/flowHarness.ts                     stateful fake forge + drivers for lifecycle tests
  flow/failure-classes.test.ts            §16 suite — the M1 gate
apps/trooper/
  prompts/{implement,review,heal,resolve}.md
  src/roles/{implement,review,heal,resolve}.ts   one pipeline per role
  src/main.ts                             role dispatch + shared phases
  src/git.ts                              + checkoutBranch, pushExistingBranch, mergeBase, commondir fix
  src/privilege.ts                        agentSpawnOptions(), chownToAgent()
images/trooper/Dockerfile                 agent user, root trooper
apps/stick/src/runner.ts                  use payload.image
docs/runbooks/m1-loop.md                  operator procedure for the M1 real-repo check
```

---

### Task 1: Schema migrations and M1 tables

**Files:**
- Create: `apps/server/src/db/migrations.ts`
- Modify: `apps/server/src/db/open.ts`, `apps/server/src/db/repo.ts`
- Test: `apps/server/src/db/migrations.test.ts`, `apps/server/src/db/repo.test.ts`

**Interfaces:**
- Produces:
  - `MIGRATIONS: { version: number; sql: string }[]`. Version 1 is the M0 `schema.sql`; version 2 is M1.
  - `migrate(db: Db): number`. It returns the resulting version and runs each pending migration in its own transaction, recorded in `schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`.
  - `openDb` calls `migrate`. A DB already created by M0 (tables present, no `schema_version` table) is detected and stamped as version 1 before version 2 is applied.
- Version 2 adds the following:

  | Change | Detail |
  |---|---|
  | `pull_requests` table | `work_item_id INTEGER PRIMARY KEY REFERENCES work_items(id)`, `number INTEGER NOT NULL`, `head_ref TEXT NOT NULL`, `head_sha TEXT NOT NULL`, `head_first_seen_at TEXT NOT NULL`, `state TEXT NOT NULL CHECK (state IN ('open','closed','merged'))`, `observed_at TEXT NOT NULL` |
  | `verdicts` table | `id TEXT PRIMARY KEY`, `work_item_id INTEGER NOT NULL`, `drop_id TEXT NOT NULL`, `head_sha TEXT NOT NULL`, `decision TEXT NOT NULL CHECK (decision IN ('approve','request_changes'))`, `summary TEXT NOT NULL`, `findings_json TEXT NOT NULL`, `gates_json TEXT NOT NULL`, `created_at TEXT NOT NULL` |
  | `attempts` table | `work_item_id INTEGER NOT NULL`, `role TEXT NOT NULL`, `count INTEGER NOT NULL DEFAULT 0`, `last_fingerprint TEXT`, `PRIMARY KEY (work_item_id, role)` |
  | `outbox` table | `id TEXT PRIMARY KEY`, `op_key TEXT NOT NULL UNIQUE`, `kind TEXT NOT NULL CHECK (kind IN ('create_pr','post_review','merge','comment'))`, `payload_json TEXT NOT NULL`, `state TEXT NOT NULL CHECK (state IN ('pending','done','unknown','failed'))`, `result_json TEXT`, `error TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL` |
  | `usage_state` table | single row `id = 1`: `status TEXT`, `resets_at TEXT`, `five_hour_util REAL`, `seven_day_util REAL`, `paused_until TEXT`, `probe_drop_id TEXT`, `updated_at TEXT` |
  | `work_items` columns | `retry_label_seen INTEGER NOT NULL DEFAULT 0`, `waiting_since TEXT` |
  | `drops` columns | `fingerprint TEXT`, `pr_number INTEGER`, `head_sha TEXT`, `input_json TEXT` (role inputs such as heal feedback) |

- `repo.ts` gains:
  - `getWorkItem(db, id): WorkItem | undefined`
  - `getPullRequest(db, itemId): PullRequestRow | undefined`
  - `upsertPullRequest(db, row: PullRequestRow): void`. When `head_sha` changes, it resets `head_first_seen_at`.
  - `insertVerdict(db, v: VerdictRow): void`
  - `latestVerdict(db, itemId): VerdictRow | undefined`. This is the newest by `created_at`, then rowid.
  - `getAttempts(db, itemId, role): { count: number; lastFingerprint: string | null }`
  - `setAttempts(db, itemId, role, count, fingerprint): void`
  - `resetAttempts(db, itemId): void`
  - `activeDropFor(db, itemId): Drop | undefined`
  - `getUsageState(db): UsageStateRow`
  - `setUsageState(db, patch): void`
  - `WorkItem` gains `retryLabelSeen: boolean` and `waitingSince: string | null`.
  - `Drop` gains `fingerprint`, `prNumber` and `headSha`.

- [ ] **Step 1: Write failing tests**

```ts
test('fresh DB migrates to version 2', () => { const db = openDb(tmpDbFile()); expect(db.prepare('select max(version) v from schema_version').get().v).toBe(2); });
test('an M0 database is stamped v1 then upgraded without data loss', () => {
  const f = tmpDbFile(); const raw = new Database(f); raw.exec(M0_SCHEMA_SQL); raw.prepare(`insert into drop_zones values ('main','o/r','master','{}')`).run(); raw.close();
  const db = openDb(f); expect(listWorkItems(db, 'main')).toEqual([]); expect(db.prepare('select count(*) c from drop_zones').get().c).toBe(1);
  expect(db.prepare('select max(version) v from schema_version').get().v).toBe(2);
});
test('migrate is idempotent', () => { const f = tmpDbFile(); openDb(f).close(); expect(migrate(openDb(f))).toBe(2); });
test('upsertPullRequest resets head_first_seen_at only when the head changes', ...);
test('latestVerdict returns the newest verdict', ...);
```

- [ ] **Step 2: Run** `npm test -w apps/server -- db`. Expected: FAIL (`migrations.js` missing).
- [ ] **Step 3: Implement.** `M0_SCHEMA_SQL` is the current `schema.sql` contents, exported for the test.
- [ ] **Step 4: Run** `npm test -w apps/server`. Expected: all pass, including the existing M0 tests.
- [ ] **Step 5: Commit** `feat(server): forward-only migrations and M1 tables`

---

### Task 2: Role-typed protocol

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces:
  - `Role = 'implement' | 'review' | 'heal' | 'resolve'`, with `RoleSchema`.
  - `PrRef = { number: number; branch: string; headSha: string }`.
  - `DropPayload` becomes a discriminated union on `role`. Every variant shares `protocol: 1`, `dropId`, `epoch`, `repo`, `issue`, `branch`, `gates`, `model`, `maxTurns`, `promptVersion`, `prompt`, and `image: string`.
  - `credentials` is `{ claudeToken: string; forgeToken?: string }`.

  | Role | Extra fields | `credentials.forgeToken` |
  |---|---|---|
  | `implement` | `resume: boolean` (true means continue the existing remote `branch` instead of starting from base) | author |
  | `review` | `pr: PrRef` | read token or absent |
  | `heal` | `pr: PrRef`; `feedback: string` (pre-rendered, trusted-only text) | author |
  | `resolve` | `pr: PrRef` | author |

  - `VerdictSchema`: `{ decision: 'approve' | 'request_changes'; summary: string; findings: { severity: 'blocker' | 'major' | 'minor'; file?: string; detail: string }[] }`.
  - `DropResult.status` adds `interrupted` (checkpoint pushed; `headSha` set) and `rate_limited` (the usage limit was hit; `headSha` is set if a checkpoint was pushed).
  - `DropResult` adds `verdict?: Verdict` (review only) and `role: Role`.
  - `REVIEW_OUTPUT_SCHEMA` and `IMPLEMENT_OUTPUT_SCHEMA` are moved here as plain JSON-schema objects, so the server and the trooper share them.

- [ ] **Step 1: Write failing tests**

```ts
test('review payload requires pr', () => expect(() => DropPayloadSchema.parse({ ...base, role: 'review' })).toThrow());
test('implement payload defaults resume to false', () => expect(DropPayloadSchema.parse({ ...base, role: 'implement' }).resume).toBe(false));
test('forgeToken is optional', () => expect(DropPayloadSchema.parse({ ...reviewPayload, credentials: { claudeToken: 't' } }).credentials.forgeToken).toBeUndefined());
test('verdict decision is validated', () => expect(() => VerdictSchema.parse({ decision: 'lgtm', summary: '', findings: [] })).toThrow());
test('rate_limited is a valid status', () => expect(DropResultSchema.parse({ role: 'implement', status: 'rate_limited', gates: [] }).status).toBe('rate_limited'));
```

- [ ] **Step 2: Run** `npm test -w packages/protocol`. Expected: FAIL.
- [ ] **Step 3: Implement** with `z.discriminatedUnion('role', [...])`. Update the server, trooper and stick call sites until `npm run typecheck` passes. Server call sites keep behaving as `implement` with `resume: false` until later tasks change them.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(protocol): role-typed drop payloads, verdicts, interrupted and rate_limited results`

---

### Task 3: Config for credential roles, models, budgets, CI and usage

**Files:**
- Modify: `apps/server/src/config.ts`, `examples/jumpmaster.config.json`
- Test: `apps/server/src/config.test.ts`

**Interfaces:**
- Produces:
  - `Config.secrets` gains `githubReviewerToken: string` (env `JM_GITHUB_REVIEWER_TOKEN`, required) and `githubReadToken?: string` (env `JM_GITHUB_READ_TOKEN`, optional).
  - `DropZoneConfig` gains:
    - `models: Partial<Record<Role, string>>`. A role without an entry falls back to `model`.
    - `budgets: { maxHeal: 3; maxResolve: 2; maxResume: 2; maxReviewRepeat: 2; maxNoChange: 1 }` (defaults shown).
    - `ciRequired: boolean = true`
    - `ciDeadlineMinutes: number = 45`
    - `retryLabel: string = 'agent-retry'`
    - `mergeMethod: 'squash' | 'merge' | 'rebase' = 'squash'`
  - `Config` gains `usage: { throttleUtilization: number = 0.9; probeJitterSeconds: [number, number] = [30, 90] }`.
  - `modelFor(zone, role): string`
- Validation: the reviewer and author tokens must be different strings. A single identity is the M4 starter mode and is not supported in M1. If they are equal, config fails with `JM_GITHUB_REVIEWER_TOKEN must differ from JM_GITHUB_AUTHOR_TOKEN`.

- [ ] **Step 1: Write failing tests**

```ts
test('reviewer token is required', () => expect(() => loadConfig(f, { ...env, JM_GITHUB_REVIEWER_TOKEN: undefined })).toThrow(/JM_GITHUB_REVIEWER_TOKEN/));
test('reviewer and author must differ', () => expect(() => loadConfig(f, { ...env, JM_GITHUB_REVIEWER_TOKEN: env.JM_GITHUB_AUTHOR_TOKEN })).toThrow(/must differ/));
test('M1 defaults', () => expect(loadConfig(f, env).dropZones[0]).toMatchObject({ ciRequired: true, ciDeadlineMinutes: 45, retryLabel: 'agent-retry', mergeMethod: 'squash', budgets: { maxHeal: 3, maxResolve: 2, maxResume: 2, maxReviewRepeat: 2, maxNoChange: 1 } }));
test('modelFor falls back to zone model', () => expect(modelFor({ ...zone, models: { review: 'r' } }, 'heal')).toBe(zone.model));
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): credential roles, per-role models, budgets, CI and usage config`

---

### Task 4: Forge adapter extensions and the outbox

**Files:**
- Modify: `apps/server/src/forge/github.ts`, `apps/server/src/test/fakes.ts`
- Create: `apps/server/src/outbox.ts`
- Test: `apps/server/src/forge/github.test.ts`, `apps/server/src/outbox.test.ts`

**Interfaces:**
- `Forge` adds the following methods. All are read-backs unless noted.

  | Method | Returns / behaviour |
  |---|---|
  | `getPull(number)` | `PullFacts \| null` |
  | `findOpenPullByHead(branch)` | `PullFacts \| null`. The adoption path uses this. |
  | `getIssueState(number)` | `'open' \| 'closed'` |
  | `getIssueLabels(number)` | `string[]` |
  | `branchExists(branch)` | `boolean` |
  | `compare(base, head)` | `{ aheadBy: number; behindBy: number }` |
  | `checksFor(sha)` | `'success' \| 'pending' \| 'failure' \| 'none'`. Combines check runs and commit statuses: any failure gives `failure`; any queued or in-progress gives `pending`; none of either gives `none`. |
  | `listReviews(number)` | `ForgeReview[]` |
  | `createReview(number, { event: 'APPROVE' \| 'REQUEST_CHANGES' \| 'COMMENT'; body: string; commitId: string })` | `{ id: number }` (write) |
  | `findReviewByMarker(number, marker)` | `{ id: number } \| null` |
  | `merge(number, { sha: string; method: 'squash' \| 'merge' \| 'rebase' })` | `{ merged: boolean; sha?: string }` (write) |

  - `PullFacts = { number: number; state: 'open' | 'closed'; merged: boolean; headSha: string | null; headRef: string; baseRef: string; mergeable: boolean | null }`
  - `ForgeReview = { author: string; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; commitId: string; body: string; submittedAt: string }`
  - Every list call uses `octokit.paginate`.
- `FakeForge` becomes stateful:
  - it holds issues, pulls, branches, checks, reviews and merges;
  - `failNext(method, mode: 'throw' | '5xx-after-success')` injects failures;
  - `calls` records every call.
- `outbox.ts` produces the following.
  - **Types:**
    - `OpKind = 'create_pr' | 'post_review' | 'merge' | 'comment'`
    - `OpResult = { state: 'done' | 'unknown' | 'failed'; result?: unknown; error?: string }`
  - **`runOp(db, forges: { author: Forge; reviewer: Forge }, op: { kind: OpKind; opKey: string; payload: unknown }, now: Date): Promise<OpResult>`.** If a row with the same `opKey` is already `done`, it returns the stored result without calling the forge. Otherwise it records a `pending` row, then runs a kind-specific lookup before acting:

    | Kind | Lookup before acting | Then | Token |
    |---|---|---|---|
    | `create_pr` | `findOpenPullByHead` | `findOrCreatePullRequest` | author |
    | `post_review` | `findReviewByMarker(pr, '<!-- jm:op:<opKey> -->')` | `createReview`, body ending with that marker | reviewer |
    | `merge` | `getPull`; if already `merged`, the op is done | `merge` with `sha` | author |

    A thrown error or a 5xx marks the row `unknown`. A 4xx marks it `failed`, with the message recorded.
  - **`resolveUnknown(db, forges, now): Promise<number>`.** It re-runs the lookup for every `unknown` row, marks it `done` if the effect is visible on the forge, and otherwise leaves it `unknown` for the next pass. It never re-issues the write.
  - **`opKey` formats:**
    - `pr:<itemId>`
    - `review:<itemId>:<headSha>:<verdictId>`
    - `merge:<itemId>:<headSha>`

- [ ] **Step 1: Write failing tests**

```ts
// github.test.ts (nock)
test('checksFor combines check runs and statuses', ...);   // failure beats pending beats success; none when both empty
test('getPull maps merged and null headSha', ...);
test('merge is pinned to sha', async () => { nock(api).put('/repos/o/r/pulls/5/merge', b => b.sha === 'abc' && b.merge_method === 'squash').reply(200, { merged: true, sha: 'm1' }); ... });
// outbox.test.ts (FakeForge)
test('merge 5xx after success is resolved by read-back', async () => {
  forge.failNext('merge', '5xx-after-success');
  expect((await runOp(db, forges, mergeOp, t0)).state).toBe('unknown');
  expect(await resolveUnknown(db, forges, t0)).toBe(1);
  expect(forge.calls.filter(c => c.method === 'merge')).toHaveLength(1);
});
test('a done op is never re-issued', ...);
test('post_review finds its own marker instead of posting twice', ...);
test('4xx marks failed with the message', ...);
```

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): forge reads for the PR lifecycle and an idempotent outbox`

---

### Task 5: Budgets and fingerprints

**Files:**
- Create: `apps/server/src/flow/budgets.ts`
- Test: `apps/server/src/flow/budgets.test.ts`

**Interfaces:**
- Produces:
  - `fingerprint(parts: (string | number | null)[]): string`. It is sha256 of the parts joined with `\0`, first 16 hex characters.
  - `chargeBudget(db, itemId, role: Role, fp: string, budgets: Budgets): { ok: true } | { ok: false; reason: string }`. Rules:

    | Role | Charged when | Limit |
    |---|---|---|
    | `heal` | every call | `maxHeal` |
    | `resolve` | every call | `maxResolve` |
    | `review` | `fp` equals the last fingerprint; a new fingerprint resets the count to 1 | `maxReviewRepeat` |
    | `implement` | resume calls | `maxResume` |

    The charge is written before the drop runs. An over-limit call returns `{ ok: false, reason: 'budget exhausted: <role>' }` and writes nothing.
  - `chargeNoChange(db, itemId, budgets): boolean`. It returns false once `maxNoChange` is exceeded.
  - `refundLast(db, itemId, role)` is used for `rate_limited` results.

- [ ] **Step 1: Write failing tests**

```ts
test('heal stops at maxHeal', () => { for (let i = 0; i < 3; i++) expect(chargeBudget(db, 1, 'heal', `f${i}`, b).ok).toBe(true); expect(chargeBudget(db, 1, 'heal', 'f9', b)).toEqual({ ok: false, reason: 'budget exhausted: heal' }); });
test('review repeats only count on the same fingerprint', ...);
test('refundLast restores one charge', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): attempt budgets keyed by input fingerprints`

---

### Task 6: The lifecycle decision function

**Files:**
- Create: `apps/server/src/flow/decide.ts`
- Test: `apps/server/src/flow/decide.test.ts`

**Interfaces:**
- Produces:
  - **`Snapshot`:**

    ```ts
    {
      item: WorkItem;
      pr: PullFacts | null;
      issueState: 'open' | 'closed';
      branchExists: boolean;
      compare: { aheadBy: number; behindBy: number } | null;
      checks: 'success' | 'pending' | 'failure' | 'none';
      verdict: VerdictRow | null;                    // latest
      trustedChangeRequests: ForgeReview[];          // trusted authors, CHANGES_REQUESTED, commitId === pr.headSha
      activeDrop: Drop | null;
      headFirstSeenAt: string;
      zone: DropZoneConfig;
      now: Date;
    }
    ```

  - **`Action`:** `{ kind: 'wait'; on: 'drop' | 'ci' }`, `{ kind: 'enqueue'; role: 'review' | 'heal' | 'resolve'; fingerprint: string; feedback?: string }`, `{ kind: 'merge'; sha: string }`, `{ kind: 'done'; reason: string }`, `{ kind: 'park'; reason: string }`, or `{ kind: 'none' }`.
  - **`decide(s: Snapshot): Action`.** It is pure. Rules are evaluated in this order:

    | # | Condition | Action |
    |---|---|---|
    | 1 | `activeDrop` | wait for the drop |
    | 2 | `pr.merged` | done, `merged` |
    | 3 | `pr.state === 'closed'` | park, `pr closed` |
    | 4 | `issueState === 'closed'` | done, `already on base` if `compare.aheadBy === 0`; otherwise park, `issue closed` |
    | 5 | `!branchExists` | park, `agent branch deleted` |
    | 6 | `pr.headSha === null` | none (GitLab "preparing", or GitHub lag; this is not an orphan) |
    | 7 | `compare.aheadBy === 0` | done, `already on base` |
    | 8 | `compare.behindBy > 0` | enqueue `resolve`, fingerprint `[headSha, 'behind']`. Only `compare` is used; the forge `mergeable` flag is ignored (§5.1, POC bc8e9dd). |
    | 9 | `trustedChangeRequests.length > 0` | enqueue `heal`, fingerprint `[headSha, 'human']`, with `feedback` built from those review bodies |
    | 10 | no verdict, or `verdict.head_sha !== pr.headSha` | enqueue `review`, fingerprint `[headSha]` |
    | 11 | `verdict.decision === 'request_changes'` | enqueue `heal`, fingerprint `[headSha, verdict.id]`, with `feedback` built from the verdict |
    | 12 | `checks === 'failure'` | enqueue `heal`, fingerprint `[headSha, 'ci']`, with `feedback` = `CI failed on <sha>; reproduce with the gates and fix.` |
    | 13 | `checks === 'success'`, or (`checks === 'none'` and `!zone.ciRequired`) | merge `pr.headSha` |
    | 14 | `now − headFirstSeenAt` > `zone.ciDeadlineMinutes` | park, `no CI result` when `checks === 'pending'`; park, `no pipeline` when `checks === 'none'` |
    | 15 | otherwise | wait for CI |

- [ ] **Step 1: Write failing tests**, one per rule plus these named cases:

```ts
test('head change invalidates approval', () => expect(decide(snap({ verdict: approve('sha1'), pr: pr('sha2'), checks: 'success' }))).toMatchObject({ kind: 'enqueue', role: 'review' }));
test('approve then request_changes on the same sha never merges', () => expect(decide(snap({ verdict: rc('sha1'), pr: pr('sha1'), checks: 'success' })).kind).not.toBe('merge'));
test('no CI honours ciRequired', () => {
  expect(decide(snap({ verdict: approve('s'), checks: 'none', zone: { ...z, ciRequired: false } }))).toEqual({ kind: 'merge', sha: 's' });
  expect(decide(snap({ verdict: approve('s'), checks: 'none', headFirstSeenAt: minutesAgo(46) }))).toEqual({ kind: 'park', reason: 'no pipeline' });
});
test('closed issue never blocks dispatch', () => expect(decide(snap({ issueState: 'closed', compare: { aheadBy: 2, behindBy: 0 } }))).toEqual({ kind: 'park', reason: 'issue closed' }));
test('stale mergeable flag is ignored when the branch contains base', () => expect(decide(snap({ pr: { ...pr('s'), mergeable: false }, compare: { aheadBy: 1, behindBy: 0 }, verdict: approve('s'), checks: 'success' })).kind).toBe('merge'));
test('null headSha is not an orphan', () => expect(decide(snap({ pr: { ...pr('x'), headSha: null } }))).toEqual({ kind: 'none' }));
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): pure PR lifecycle decision function`

---

### Task 7: Snapshot, reconciler and adoption

**Files:**
- Create: `apps/server/src/flow/snapshot.ts`, `apps/server/src/flow/reconcile.ts`, `apps/server/src/test/flowHarness.ts`
- Modify: `apps/server/src/sync.ts` (handle the retry label), `apps/server/src/scheduler.ts`, `apps/server/src/main.ts`
- Test: `apps/server/src/flow/reconcile.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5, 6.
- Produces:
  - **`buildSnapshot(db, forges, zone, item, now): Promise<Snapshot>`.** It reads every forge-owned field fresh. It upserts `pull_requests` from `getPull`. It filters `listReviews` to trusted authors with `CHANGES_REQUESTED` on the current head, using `isTrusted` and failing closed.
  - **`reconcileZone(db, forges, zone, promptVersions, now): Promise<{ actions: number }>`.** Steps, in order:
    1. `resolveUnknown`.
    2. **Adoption:** for each item in `ready` or `in_flight` with no active drop and no `pull_requests` row, run `findOpenPullByHead(agentBranch(n))`. If one is found, set the item to `pr_open` with that PR.
    3. For each `pr_open` item, build a snapshot, call `decide`, and apply the action:
       - `enqueue`: charge the budget (park on failure), then insert a `queued` drop with `role`, `fingerprint`, `pr_number`, `head_sha`, and the role's prompt version.
       - `merge`: run the outbox op `merge:<itemId>:<sha>`. When it is done, set the item to `done` with reason `merged`.
       - `park` or `done`: set the item state and reason.
       - `wait` or `none`: nothing.
    4. Only then call `enqueueNext` for new implement work, which is now usage-gated (Task 10).
  - **Retry label:** `sync.ts` reads labels for parked items. If an item carries `zone.retryLabel` and `retryLabelSeen` is 0, it resets the attempts, sets `retryLabelSeen` to 1, and returns the item to `pr_open` if it has a PR, otherwise to `ready`. When the label is absent, it sets `retryLabelSeen` back to 0.
  - **`flowHarness.ts`:** `harness()` returns `{ db, forge: FakeForge, zone, at(minutes), reconcile(), finishDrop(role, result) }`. `finishDrop` runs the real `applyResult` on the active drop.
  - **`main.ts`:**
    - It builds both forges per zone: `author` and `reviewer`, the latter from `githubReviewerToken`.
    - Each poll pass runs `syncDropZone`, then `reconcileZone`.
    - **Merge lock:** at most one merge op per zone per pass, and zones are processed sequentially.

- [ ] **Step 1: Write failing tests** (harness-driven)

```ts
test('happy path: implement → review approve → merge', async () => { /* finishDrop implement completed sha1 → reconcile → review drop queued → finishDrop review approve → reconcile → merged */ expect(h.forge.merges).toEqual([{ number: 1, sha: 'sha1' }]); expect(workItem(h.db, 1)).toMatchObject({ state: 'done', reason: 'merged' }); });
test('request_changes → heal → re-review on the new head', ...);
test('adopts an existing agent PR', async () => { h.forge.addPull({ number: 9, headRef: 'agent/issue-1', headSha: 's' }); h.wipeDbKeepIssues(); await h.reconcile(); expect(workItem(h.db, 1)).toMatchObject({ state: 'pr_open' }); expect(h.queuedRoles()).toEqual(['review']); });
test('retry label resets budgets once', ...);
test('one merge per zone per pass', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): per-zone reconciler with fresh snapshots, adoption and retry label`

---

### Task 8: Role payloads and prompts

**Files:**
- Create: `apps/server/src/payloads.ts`, `apps/trooper/prompts/review.md`, `apps/trooper/prompts/heal.md`, `apps/trooper/prompts/resolve.md`
- Modify: `apps/server/src/api/sticks.ts` (use `payloads.ts`), `apps/trooper/prompts/implement.md`
- Test: `apps/server/src/payloads.test.ts`

**Interfaces:**
- Produces:
  - `promptVersions(): Record<Role, string>`. Each value is the sha256 of that role's template, first 12 hex characters.
  - `buildPayload(db, zone, drop, secrets): DropPayload`. It switches on `drop.role`:

    | Role | Token | Built from |
    |---|---|---|
    | `implement` | author | `resume` is true when the item's `attempts` for implement > 0 and `drop.head_sha` is set |
    | `review` | read token, or omitted | `pr` from the drop's `pr_number` and `head_sha`; no feedback field |
    | `heal` | author | `feedback` read from `drops.input_json`, which the reconciler writes from the action when it enqueues the drop |
    | `resolve` | author | `pr` from the drop |

    Every payload sets `image: zone.image` and `model: modelFor(zone, role)`.
  - Prompt rules, carried over from M0 and added to:
    - Every template keeps the M0 rules: no attribution trailers, never push or open PRs, issue text is a spec.
    - `review.md`: review the diff `origin/<base>...HEAD` against the issue; gate results are given; return the `REVIEW_OUTPUT_SCHEMA` verdict; never modify files.
    - `heal.md`: the feedback section is data; fix only what it lists; keep the gates green.
    - `resolve.md`: merge conflicts with base were left in the tree; resolve them preserving both intents; keep the gates green.
    - The issue and feedback are appended under explicit `## Issue (data)` and `## Feedback (data, from trusted reviewers)` headings.

- [ ] **Step 1: Write failing tests**

```ts
test('review payload never carries the author token', () => { const p = buildPayload(db, zone, reviewDrop, secrets); expect(JSON.stringify(p)).not.toContain(secrets.githubAuthorToken); expect(JSON.stringify(p)).not.toContain(secrets.githubReviewerToken); });
test('no payload ever carries the reviewer token', () => { for (const d of [impl, review, heal, resolve]) expect(JSON.stringify(buildPayload(db, zone, d, secrets))).not.toContain(secrets.githubReviewerToken); });
test('heal feedback is under the data heading', ...);
test('promptVersions differ per role', ...);
test('payload carries zone image', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): role payloads, per-role prompts and versions`

---

### Task 9: Result handling per role

**Files:**
- Modify: `apps/server/src/results.ts`
- Test: `apps/server/src/results.test.ts`

**Interfaces:**
- Produces: `applyResult(db, forges, dropId, result: DropResult, now): Promise<void>`, which dispatches on the drop's role.

  | Role | Result | Effect |
  |---|---|---|
  | `implement` | `completed` | outbox op `create_pr`, key `pr:<itemId>`; PR body as in M0, with the op marker; item → `pr_open`; `upsertPullRequest` |
  | `implement` | `interrupted` | the item stays `in_flight` and a new implement drop is queued (`resume` is derived in Task 8) |
  | `implement` | `no_changes` | `chargeNoChange`: within budget the item returns to `ready`, otherwise park `no_changes` |
  | `review` | carries a `verdict` | `insertVerdict` with `head_sha` = the drop's `head_sha`; then outbox op `post_review`, `APPROVE` or `REQUEST_CHANGES` on `commitId` = the drop's `head_sha`, with the summary and findings as a markdown list, through the reviewer forge |
  | `review` | no `verdict` | treated as `failed` |
  | `heal` or `resolve` | `completed` | `upsertPullRequest` with the new `headSha`; the next reconcile reviews it |
  | `heal` or `resolve` | `no_changes` | recorded; the next reconcile re-decides on the same head, and the budget eventually parks it (POC: "a heal that pushes nothing never reaches approval") |
  | any | `rate_limited` | the drop becomes `cancelled`; `refundLast`; a same-role drop is requeued with the same fingerprint |
  | any | `failed` or `blocked` | park the item with the reason |

- [ ] **Step 1: Write failing tests**, covering each row of the table.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): per-role result handling through the outbox`

---

### Task 10: Leases, usage state and the dispatch gate

**Files:**
- Create: `apps/server/src/usage.ts`
- Modify: `apps/server/src/leases.ts`, `apps/server/src/api/sticks.ts` (event ingestion), `apps/server/src/scheduler.ts`
- Test: `apps/server/src/usage.test.ts`, `apps/server/src/leases.test.ts`

**Interfaces:**
- Produces:
  - `ingestRateLimit(db, info: { status: string; resetsAt?: string; rateLimitType?: string; unifiedWindows?: { five_hour?: { utilization: number }; seven_day?: { utilization: number } } }, cfg, now, rand = Math.random): void`
    - It updates `usage_state`.
    - On `rejected` it sets `paused_until` = `resetsAt` + a jitter drawn from `probeJitterSeconds`.
    - When the CLI omits `unifiedWindows`, the missing fields stay null; they are never assumed to be 0.
  - `dispatchGate(db, cfg, now): 'open' | 'finishing_only' | 'probe' | 'closed'`

    | Gate | When |
    |---|---|
    | `closed` | `now < paused_until` |
    | `probe` | `paused_until` has passed and no `allowed` event has arrived since |
    | `finishing_only` | the status is `allowed_warning`, or either utilization ≥ `throttleUtilization` |
    | `open` | otherwise |

  - `leaseNextDrop(db, stickId, now, gate)` honours the gate:

    | Gate | Behaviour |
    |---|---|
    | `closed` | returns null |
    | `probe` | leases one drop, records it in `probe_drop_id`, then returns null until an `allowed` event clears the probe |
    | `finishing_only` | leases only `review`, `heal` or `resolve` drops |
    | `open` | leases as before |

    `leaseNextDrop` also sets `started_at` at lease time (the M0 elapsed fix).
  - The lease route computes `dispatchGate(db, config, now())` and passes it to `leaseNextDrop`.
  - The events route calls `ingestRateLimit` for every `rate_limit` event. The trooper's parser output must keep `rateLimitType` and `unifiedWindows` (Task 12).
  - `expireLeases` becomes role-aware:
    - a lost implement drop keeps the M0 behaviour: the item returns to `ready` after the grace period, or resumes if the branch exists;
    - a lost review, heal or resolve drop leaves the item `pr_open`, so the next reconcile re-decides.
  - `scheduler.enqueueNext` checks `dispatchGate` and enqueues nothing unless it is `open` or `probe`.

- [ ] **Step 1: Write failing tests**

```ts
test('rejected pauses until resetsAt plus jitter', () => { ingestRateLimit(db, { status: 'rejected', resetsAt: '2026-10-20T12:00:00Z' }, cfg, t0, () => 0); expect(dispatchGate(db, cfg, new Date('2026-10-20T12:00:29Z'))).toBe('closed'); expect(dispatchGate(db, cfg, new Date('2026-10-20T12:00:31Z'))).toBe('probe'); });
test('probe allows exactly one lease', ...);
test('warning allows finishing roles only', ...);
test('utilization at 0.9 throttles', () => { ingestRateLimit(db, { status: 'allowed', unifiedWindows: { seven_day: { utilization: 0.9 } } }, cfg, t0); expect(dispatchGate(db, cfg, t0)).toBe('finishing_only'); });
test('missing unifiedWindows is not treated as zero', ...);
test('started_at is set at lease time', ...);
test('lost review drop leaves the item pr_open', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): usage pause, probe and throttle; role-aware leases`

---

### Task 11: Trooper git for existing branches, plus hardening

**Files:**
- Modify: `apps/trooper/src/git.ts`
- Test: `apps/trooper/src/git.test.ts`

**Interfaces:**
- Produces:
  - `checkoutBranch(dir, branch, expectedSha): Promise<void>`. It fetches `origin/<branch>`, checks it out as a local branch, and throws `head moved: expected <a> got <b>` if the tip is not `expectedSha`.
  - `mergeBase(dir, base): Promise<'clean' | 'conflicts' | 'up_to_date'>`. It runs `git merge --no-edit origin/<base>` as Jumpmaster Agent. On conflicts it leaves the conflict markers in the tree and does not abort.
  - `pushExistingBranch(dir, branch, token, target, expectedRemoteSha, sweep?): Promise<string>`. It is the same pristine-bare-repo path as `pushNewBranch`, but with `--force-with-lease=refs/heads/<branch>:<expectedRemoteSha>`.
  - The pristine push path in `pushNewBranch` and `pushExistingBranch` runs git with `GIT_DIR=<bare>` and `GIT_COMMON_DIR=<bare>` in its environment (the M0 parked `commondir` finding).

- [ ] **Step 1: Write failing tests**

```ts
test('pushExistingBranch refuses when the remote moved', async () => { /* remote advanced by a second clone → push rejects with stale info */ });
test('checkoutBranch detects a moved head', ...);
test('mergeBase reports conflicts and leaves markers', ...);
test('a planted commondir in the bare repo does not change the push config', async () => { /* write bare/commondir → agent repo with url.insteadOf redirect; push still lands on the intended remote */ });
test('second sweep runs after the tokenless fetch', async () => { /* record order of fetch/sweep/push calls via injected sweep; expect [sweep, fetch, sweep, push] */ });
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(trooper): existing-branch checkout, base merge, leased push; harden bare repo`

---

### Task 12: Trooper role pipelines

**Files:**
- Create: `apps/trooper/src/roles/implement.ts`, `review.ts`, `heal.ts`, `resolve.ts`
- Modify: `apps/trooper/src/main.ts`, `apps/trooper/src/claude.ts`
- Test: `apps/trooper/src/roles/*.test.ts`, `apps/trooper/src/main.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 11.
- Produces:
  - `buildClaudeArgs` gains `outputSchema: object`, which replaces the baked-in implement schema.
  - `parseStreamLine`'s `rate_limit` variant keeps `rateLimitType` and `unifiedWindows`.
  - `runTrooper(payload, deps)` dispatches by `payload.role` to `runImplement`, `runReview`, `runHeal` or `runResume`. Each has the signature `(payload, deps, ctx: { workdir: string; secrets: string[] }) => Promise<DropResult>`. The shared helpers `cloneAndPrepare`, `runAgent` and `runGatesPhase` are extracted from M0's `main.ts`.
- Role pipelines:

  | Role | Pipeline |
  |---|---|
  | implement | `resume: false`: M0 behaviour. `resume: true`: `checkoutBranch(branch, <remote tip>)` instead of the fail-fast, then continue and push with `pushExistingBranch` |
  | review | clone (read token or none) → `checkoutBranch(pr.branch, pr.headSha)` → gates (credential-less) → Claude with `REVIEW_OUTPUT_SCHEMA` → result `completed` with `verdict` and gates; no commit, no push. If the agent modified tracked files, the verdict is discarded and the result is `failed`, reason `review modified the tree` |
  | heal | `checkoutBranch(pr.branch, pr.headSha)` → Claude with the feedback prompt → commit → `no_changes` if nothing changed → gates → `pushExistingBranch(..., pr.headSha)` → `completed` + `headSha` |
  | resolve | `checkoutBranch` → `mergeBase`. `up_to_date` gives `no_changes`. `clean` skips Claude. `conflicts` runs Claude with `resolve.md`, and any `<<<<<<<` left in a tracked file afterwards gives `failed`. Then gates → `pushExistingBranch` |

- Checkpoint and usage handling:
  - If the Claude stream ends after a `rate_limit` event with status `rejected`, or the run hits max turns (`terminal_reason` is not `completed`), an implement or heal run with commits ahead pushes a checkpoint first: `wip: checkpoint` commit, then a leased push.
  - It returns `rate_limited` or `interrupted` with that `headSha`.
  - With nothing to checkpoint, it returns the same status without a `headSha`.

- [ ] **Step 1: Write failing tests** (fake deps, as in M0)

```ts
test('review never pushes and returns the verdict', ...);
test('review that edits files is discarded', ...);
test('heal pushes with lease on the PR head', ...);
test('resolve with clean merge skips claude', ...);
test('resolve leaving conflict markers fails', ...);
test('rate_limited implement pushes a checkpoint and reports headSha', ...);
test('resume continues the existing branch instead of failing fast', ...);
test('rate_limit parsing keeps unifiedWindows', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(trooper): implement/review/heal/resolve pipelines with checkpoints`

---

### Task 13: Separate uid for the agent and gates

**Files:**
- Create: `apps/trooper/src/privilege.ts`
- Modify: `images/trooper/Dockerfile`, `apps/trooper/src/main.ts`, `apps/trooper/src/gates.ts`
- Test: `apps/trooper/src/privilege.test.ts`

**Interfaces:**
- Produces:
  - `agentIdentity(env, getuid = process.getuid): { uid: number; gid: number; home: string } | null`. It returns the `agent` user's ids, read from the `JM_AGENT_UID`, `JM_AGENT_GID` and `JM_AGENT_HOME` env vars that the image sets, only when `env.JM_CONTAINER === '1'` and the process is root. Otherwise it returns null, and tests run as the current user.
  - `agentSpawnOptions(id): SpawnOptions`. It sets `{ uid, gid }` and `HOME` / `CLAUDE_CONFIG_DIR` under the agent's home.
  - `chownToAgent(dir, id): Promise<void>`. It recursively chowns the working copy before the agent runs.
- Behaviour:
  - Claude and the gates spawn with `agentSpawnOptions` when an identity is present. Every git command run by the trooper adds `safe.directory=*` through `GIT_CONFIG_*`.
  - Dockerfile:
    - creates `agent` (uid 10001);
    - keeps the trooper as root, with no `USER trooper`;
    - sets the `JM_AGENT_*` env vars, and `JM_CONTAINER=1` as in M0.
  - The process sweep still kills everything except PID 1.

- [ ] **Step 1: Write failing tests**

```ts
test('no identity outside container mode', () => expect(agentIdentity({}, () => 0)).toBeNull());
test('no identity when not root', () => expect(agentIdentity({ JM_CONTAINER: '1', JM_AGENT_UID: '10001', JM_AGENT_GID: '10001', JM_AGENT_HOME: '/home/agent' }, () => 1000)).toBeNull());
test('identity in container as root', ...);
```

- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Verify in the image.** Build it, then run a payload whose gate is `id -u`; the gate output must show `10001`. Also run a gate that reads `/proc/1/environ`; it must fail with permission denied.

```bash
docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .
```

- [ ] **Step 6: Commit** `feat(trooper): run agent and gates as an unprivileged uid`

---

### Task 14: Stick image selection

**Files:**
- Modify: `apps/stick/src/runner.ts`
- Test: `apps/stick/src/runner.test.ts`

- Image selection: `runDrop` uses `payload.image` and falls back to `JM_TROOPER_IMAGE`, then to `jumpmaster-trooper:dev`.
- Image allow-list: the stick refuses any image outside `JM_ALLOWED_IMAGES`, a comma-separated list that defaults to the fallback image. A refused drop gets a `failed` result with reason `image not allowed: <image>`, and no container starts.

- [ ] **Step 1: Write failing tests:** `uses payload image`, `refuses an image outside the allow-list`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(stick): per-drop image with an allow-list`

---

### Task 15: UI for the loop

**Files:**
- Modify: `apps/server/src/ui/pages.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/ui/pages.test.ts`

- Home page additions:
  - a **Usage** section showing the gate (`open`, `finishing_only`, `probe` or `closed`), `paused_until`, and both utilizations;
  - work items gain columns for PR number and head SHA (short), the latest verdict decision, and attempts per role;
  - drops gain a role column, and "elapsed" is measured from `started_at`;
  - an **Outbox** section listing every `unknown` or `failed` op.
- Everything is escaped, as in M0.

- [ ] **Step 1: Write failing tests:** `shows usage gate`, `shows verdict and attempts`, `escapes verdict summary`, `lists unknown outbox ops`.
- [ ] **Step 2–4:** RED, implement, GREEN.
- [ ] **Step 5: Commit** `feat(server): UI shows usage gate, verdicts, budgets and outbox`

---

### Task 16: §16 failure-class suite (the M1 gate)

**Files:**
- Create: `apps/server/src/flow/failure-classes.test.ts`
- (Trooper-side classes are covered by the Task 11–13 tests listed below.)

One `describe` per spec §16 line, driven through `flowHarness`. Each test asserts both the visible end state and the exact forge call log:

| §16 class | Test |
|---|---|
| 5xx after a successful merge | `exactly one merge; outcome read back` (Task 4 op reused end-to-end) |
| partitioned trooper / second lease | `stale epoch result rejected; one PR` |
| implement ends without a PR | `no_changes parks after maxNoChange; own comments don't reset` |
| closed issue (landed / not landed / conflicted / branch gone) | four cases, `never blocks dispatch of another ready item` |
| stale CHANGES_REQUESTED on an old SHA | `re-review once on the new head, then park after maxReviewRepeat` |
| heal that pushes nothing | `never reaches approval; parks at maxHeal` |
| reviewer blocked SHA X, then the same SHA is approved | `never merges` |
| stale conflict flag while the branch contains base | `no resolve loop` |
| budgets counted before the run; human reset | `retry label resets once` |
| orphan PR vs a null-SHA preparing PR | `orphan parks; null sha waits` |
| untrusted commenters | `untrusted CHANGES_REQUESTED is ignored; failed lookup = untrusted` |
| usage limit mid-drop | `requeued, budget refunded, gate closed until reset` |
| claim race | `one active drop per item under concurrent enqueue` |
| lost webhook / missing or cancelled pipeline | `deadline parks with 'no CI result' / 'no pipeline'` |
| human merge / close / reopen / force-push / branch delete | one test per action, in each of the states implement-running, review-pending, approved-waiting-CI |
| restore from an older backup | `adopts unknown PRs; nothing merged twice` |
| pagination past 100 | `adoption and reviews paginate` (FakeForge with 150 entries) |

The trooper-side classes are covered by these tests:
- long silent test: M0 `heartbeat from runtime`;
- SIGKILL and resume: Task 12, `resume continues the existing branch`;
- hostile hooks: M0 C1 and Task 11.

- [ ] **Step 1: Write the suite.** Any test that fails here is a bug in Tasks 1–15: fix it in the owning file in this task.
- [ ] **Step 2: Run** `npm run lint && npm run typecheck && npm test`. Expected: all green.
- [ ] **Step 3: Commit** `test(server): spec §16 failure-class suite`

---

### Task 17: M1 runbook

**Files:**
- Create: `docs/runbooks/m1-loop.md`
- Modify: `docs/runbooks/m0-tracer.md` (link forward; note the reviewer token is now required)

**Content:**
- **Prerequisites:** a second (reviewer) bot account, collaborator on the test repo with write access; its fine-grained PAT with Pull requests read/write plus Metadata read. The author PAT is unchanged.
- **Branch protection on the test repo:** 1 approval required, bots non-admin.
- **Config additions:** `ciRequired: false` for a repo without CI, plus the budgets.
- **Scenarios to run and their expected outcomes:**
  1. happy path, merged with no human click;
  2. an issue whose first review requests changes (e.g. "also handle non-number inputs with a TypeError"), so heal and re-review run;
  3. push a commit to `master` while a PR is open, so resolve runs;
  4. close an issue mid-flight, so it parks with `issue closed`;
  5. the `agent-retry` label.
- **Pass criteria for each scenario,** plus the M0 secret check repeated against the reviewer token.
- **Security notes** updated: the agent now runs as uid 10001, and the reviewer token never leaves the server.

- [ ] **Step 1: Write the runbook.**
- [ ] **Step 2: Commit** `docs: M1 loop runbook`

---

## Self-review notes

- **§15 M1 coverage:**

  | M1 item | Task |
  |---|---|
  | review | 8, 9, 12 |
  | heal | 6, 9, 12 |
  | resolve-conflicts | 6, 11, 12 |
  | outbox | 4 |
  | SHA-bound orchestrator merge | 6, 7 |
  | two-bot roles | 3, 4, 8 |
  | checkpoint resume | 9, 12 |
  | usage pause | 10 |
  | trust boundary (trusted reviews only; data headings; review read-only) | 7, 8, 12 |
  | gate: §16 suite | 16 |

- **M0 parked items closed here:**

  | Item | Task |
  |---|---|
  | separate uid | 13 |
  | `commondir` | 11 |
  | sweep-order test | 11 |
  | elapsed | 10 |
  | payload image | 2, 8, 14 |
  | migrations | 1 |

- **Deliberately not in M1:**
  - the single-bot starter mode (M4);
  - forge status mirroring labels and comments (later; would need Issues: write);
  - egress control (M4);
  - crew (M3);
  - multi-zone weights (M5);
  - GitLab (M5).
- **Deviation from spec §5.1:** the spec names local git as the authority for "already landed". M1's server has no clone, so it uses the forge commit-graph `compare` API, which is ancestry rather than the mergeable flag the spec warns about. A server-side mirror clone can replace this in M5 if needed.
