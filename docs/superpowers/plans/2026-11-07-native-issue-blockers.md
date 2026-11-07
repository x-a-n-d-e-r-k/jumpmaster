# Native issue blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ready issue with an open GitHub "blocked by" link is never started (fresh or resumed) until every blocker is closed, and observe mode records why it waits.

**Architecture:** Intake keeps the REST issue list (its label filter is case-insensitive and tested) and adds one GraphQL call per 100 listed issues, using aliases, that reads each issue's open blockers. The server stores them on the work item (`blocked_by`, migration v4). Every path that starts implement work for a `ready` item (enqueue, resume, observe's `would_enqueue`) skips an item with blockers. Items already `in_flight` or with a PR are unaffected.

**Tech Stack:** TypeScript, Octokit GraphQL, better-sqlite3, vitest.

**Spec:** docs/superpowers/specs/2026-10-19-jumpmaster-design.md (intake and scheduling). Motivation: in the M2 observe run, a ready issue blocked on another (recorded only in a label and an HTML comment) was queued as startable. GitHub's native dependency links are visible in the UI, clear themselves when the blocker closes, and need no label upkeep.

## Global Constraints

- Node ≥24, ESM, strict TypeScript, Biome; no new dependencies (Octokit already has `graphql`).
- No private names, hostnames or paths in code, tests or docs. Use `jm-test`-style fixtures.
- The author token is fine-grained; the query must work with Issues: read and Metadata: read.
- Fail closed: if a blocker exists that the token cannot read, the issue waits.
- Do not honor a `blocked` label or comment markers. Native links are the one mechanism.

## Review Focus

1. A blocker in another repository the token can't see: `issueDependenciesSummary.blockedBy` counts it, `blockedBy.nodes` may omit it. The issue must wait, with a reason naming an unreadable blocker.
2. More than 50 blockers or more than 100 ready issues: pagination of the issue list must be complete; blocker nodes may be truncated but the open count still decides.
3. A blocker closed as "not planned": closed is closed; the issue becomes startable (matches GitHub's own semantics).
4. A link added after work started: an `in_flight` item or one with a PR continues; only fresh starts and resumes of `ready` items wait.
5. GraphQL failure mid-pass: intake throws as the REST call did today; nothing is marked done or unblocked from a partial read.

---

### Task 1: Forge returns blockers

**Files:** Modify `apps/server/src/forge/github.ts`, `apps/server/src/test/fakes.ts`. Test `apps/server/src/forge/github.test.ts`.

**Interfaces — Produces:** `ForgeIssue` gains optional `blockedBy?: string[]` — each open blocker as `#N` (same repo) or `owner/name#N`, plus `N unreadable blocker(s)` when the open count exceeds the visible open nodes (clamped at 0). Absent or empty means startable.

- [ ] Test `listReadyIssues returns open blockers and ignores closed ones`: blockers `{#7 OPEN, #8 CLOSED, other/repo#3 OPEN}`, summary `blockedBy: 2` → `['#7', 'other/repo#3']`.
- [ ] Test `counts blockers the token cannot see as unreadable`: summary 2, one visible open node → `['#7', '1 unreadable blocker']`.
- [ ] Test `a forbidden blocker node does not fail intake`: GraphQL answers `{data, errors:[{type:'FORBIDDEN', path:['repository','i5','blockedBy','nodes',0]}]}` with that node null → issue #5 gets `['1 unreadable blocker']`; an error whose path lacks `blockedBy` rethrows.
- [ ] Test `reads blockers in batches of 100`: 150 listed issues → two GraphQL calls.
- [ ] Implement: keep the REST list; then `octokit.graphql` with aliases `iN: issue(number: N) { issueDependenciesSummary { blockedBy } blockedBy(first: 100) { nodes { number state repository { nameWithOwner } } } }`. On `GraphqlResponseError` with `e.data.repository` present and every error path containing `blockedBy`, use `e.data`; otherwise rethrow. Filter null nodes.
- [ ] Fakes: no change needed; `blockedBy` is optional. Add `FakeForgeState.setBlockedBy(n, list)` if the sync test needs it.
- [ ] Commit `feat(forge): read native issue blockers with ready issues`.

### Task 2: Store blockers; never start a blocked ready item

**Files:** Modify `apps/server/src/db/migrations.ts` (v4: `ALTER TABLE work_items ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]'`), `db/repo.ts` (`WorkItem.blockedBy: string[]`, `upsertWorkItem` writes it), `sync.ts`, `scheduler.ts` (`enqueueNext`), `flow/reconcile.ts` (resume candidates and the observe branch). Tests beside each.

- [ ] Test (migrations) `v4 adds blocked_by defaulting to empty`.
- [ ] Test (sync) `stores blockers and clears them when the blocker closes`: pass 1 issue #5 blocked by `#4` → item `blockedBy ['#4']`; pass 2 no blockers → `[]`.
- [ ] Test (scheduler) `enqueueNext skips a blocked ready item and starts the next`: items #5 (high priority, blocked) and #6 → drop for #6.
- [ ] Test (reconcile) `does not resume a blocked ready item with an old branch`; `still resumes an in_flight item that gained a blocker`.
- [ ] Test (reconcile, observe) `records would_wait for a blocked item and would_enqueue for the next`: observations contain `would_wait:blocked` with detail `blocked by #4` and `would_enqueue:implement` for #6.
- [ ] Repo: `NewWorkItem.blockedBy?` defaults to `[]`; `WORK_ITEM_COLS` adds `blocked_by AS blockedBy` (parsed JSON); the upsert's `DO UPDATE` sets `blocked_by = excluded.blocked_by`. Status page (pages.ts item table) shows the list.
- [ ] Implement: `isBlocked(item) = item.blockedBy.length > 0`; filter it in `enqueueNext` and the observe `rankItems` call; in resume candidates exclude `state === 'ready' && isBlocked`. In observe, record `would_wait:blocked` once per blocked ready item per pass with detail `blocked by ${blockedBy.join(', ')}`.
- [ ] Commit `feat(flow): hold ready issues until their blockers close`.

### Task 3: Docs

- [ ] `docs/runbooks/m1-loop.md` intake section and `docs/runbooks/m2-cutover.md` observe list: one paragraph each on native "blocked by" links, `would_wait:blocked`, and the fail-closed unreadable case. Note that labels or comment markers used by other tools are not read, so convert them to links before switching. A changed blocker set adds a new `would_wait:blocked` row, so count items, not rows.
- [ ] Commit `docs: describe native issue blockers`.

### Task 4: Live check on the test repo

- [ ] On `jm-test`, two ready issues where B is blocked by A (REST `POST /repos/{o}/{r}/issues/{B}/dependencies/blocked_by` with A's id). Observe server: `would_wait:blocked` for B, `would_enqueue:implement` for A. Close A: next pass B is `would_enqueue`. Clean up both issues.
