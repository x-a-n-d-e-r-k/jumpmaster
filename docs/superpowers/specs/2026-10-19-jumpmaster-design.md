# Jumpmaster — Design

*Status: draft v3 (owner answers folded in) · 2026-10-19*

> "I'm the orchestrator of my idea now, not the engineer."

Jumpmaster is a self-hosted, single-operator **software factory** that runs on the operator's own
Claude account. The operator sets goals; a crew of Claude agents turns them into specified issues,
implements them in disposable containers, reviews, heals, and merges, and escalates only the
decisions that genuinely need a human. It is the packaged, productized successor to a working
setup the owner built by hand while developing a large private project.

Markers: **[decided]** — the owner chose it in conversation. **[call]** — the designer's choice,
not explicitly confirmed; the owner may overturn it. **[red team]** — added after the builder
check and red-team review (§18); also a designer's call unless marked decided. Unmarked text is
description. §17 records the owner's answers to the review's open questions.

---

## 1. Why this exists

### 1.1 The current setup (the proof of concept)

The owner runs three hand-wired layers against a large private TypeScript monorepo (the
**reference project**, CI-gated with large test suites):

- **crew**: a Claude Code skill (kept in the reference project, not public) run as a long-lived
  interactive session (`/loop /crew`). It is the judgment layer: reads `GOAL.md` (a ladder of
  "hand-over-ready" rungs R0–R11, owner decisions, non-goals), red-teams staged specs and promotes
  them `staged → agent-ready`, arbitrates PRs the loop parked (`needs-human`) using a stronger
  model (Fable), detects collisions between issues and in-flight PRs, audits merged commits on
  sensitive paths, files new staged work toward the next rung, and writes owner **briefs** for
  anything on its `alwaysEscalate` list. Workers are subagents with four roles — refute, diagnose,
  arbitrate, scout (`roles.md`). It reaches the forge only through `f`, a bash allow-list wrapper
  that forbids approve/merge/push.
- **sandcastle-afk** ([github.com/x-a-n-d-e-r-k/sandcastle-afk](https://github.com/x-a-n-d-e-r-k/sandcastle-afk)): the executor. A file layer copied into each repo,
  running `afk:loop` (`.sandcastle/loop.ts`) as a `while(true)` daemon per host clone. Each cycle:
  clean host state → unblock issues → drive the first in-flight agent PR (conflicts → mechanical
  merge then agent resolver; approved → UI/CI gates → merge; changes requested → heal/re-review/
  escalate; else review) → otherwise pick the next `agent-ready` issue by priority and implement
  it (with checkpoint resume). Implement/review/heal/triage are Claude Code runs inside Docker via
  upstream **Sandcastle** (`@ai-hero/sandcastle` 0.12). Review uses a second forge identity
  (`FORGE_REVIEW_TOKEN`, host-only). Also: a UI screenshot gate (`verifyGlobs`, `uiGate`) and an
  out-of-band e2e **sentinel** that files regression issues. All state lives in forge labels and
  comment markers.
- **Glue**: `.sandcastle/.env`, host-only `.env.review`, three `gh` accounts, `crew.config.json`,
  `afk.config.json`, ssh log-tailing on a separate runner host.

It works — it has carried the reference project a long way — which is why it is a successful POC.
Its pain:

1. sandcastle-afk is a separately-run, separately-managed CLI; it is really a *component*.
2. Loops are pinned to host clones on one machine; they mutate the host repo and need the Docker
   socket and bind mounts. Concurrency is one job per clone.
3. No single management surface: monitoring is terminal tails, `afk:claims`, and forge comments.
   No run history, no metrics; Sandcastle's usage data is discarded.
4. State-in-labels produces a long tail of wedge/livelock bugs (most of the last ~100 sandcastle-afk
   commits are such fixes; §16 lists the failure classes). Label claims race.
5. Credentials and config are scattered across files and accounts.
6. It cannot be handed to anyone else.

### 1.2 Intent

Package the pattern so **coworkers and friends** can install it and get the same results, and so
the owner's own use gets better. Jumpmaster is a **refined POC** [decided]: targeted, light, and
strongly tied to Claude. It stands on its own; it is deliberately not a general-purpose platform.

**"Lighter" means less for the operator to run and wire up — one container, one setup flow — not
less capability** [red team, consistent with "all nine in v1"].

It may later be packaged and distributed commercially to third-party organizations [decided].
Because of that, security defaults matter more than usual (§7).

### 1.3 Success

- A friend with Docker and a Claude account goes from `docker compose up` to their first agent-
  opened PR on their own repo without the owner's help.
- The owner moves the reference project's factory onto Jumpmaster and retires the hand-wired crew +
  sandcastle-afk setup — **early**, as a release gate, not at the end (§15).
- Operators feel like product owners: they spend their time on goals, briefings, and rulings, not
  on babysitting loops.
- Early users are **design partners** [decided]: their feedback is the measure of v1.

---

## 2. Goals, non-goals, anti-goals

### 2.1 Goals (all in v1) [decided]

1. **Runner managed by the app** — the rebuilt Sandcastle + sandcastle-afk, as a component.
2. **Runners anywhere** — local Docker, remote Docker host, Podman, Kubernetes.
3. **One management interface** — orchestrator, dashboards, live metrics.
4. **Goals and milestones** management.
5. **Issue visualization.**
6. **Subagent tasks** (crew roles) visible and managed.
7. **Escalation to Fable** for conflicts/arbitration (subject to plan tier, §12.2).
8. **Prompt optimization** for crew and loop prompts.
9. **Config management** — Claude credential, forge credentials, etc.

Plus, from the conversation:

10. **Multiple projects per install** sharing one runner pool [decided].
11. **GitHub and GitLab**, both fully supported in v1 [decided]. GitLab validated end-to-end.
12. **Pipeline (CI) metrics** as a first-class view of where cycle time goes [decided].
13. **Intake**: guided onboarding of a project into the factory (§8) [decided].
14. **MCP server** exposed by the app (§9) [decided].

"All in v1" is delivered as a sequence of usable releases with gates (§15) [red team].

### 2.2 Non-goals

- **Multi-user / multi-tenant.** One operator per install; no roles or permission model [decided].
- **Managing CI runners.** Jumpmaster measures pipelines; it never provisions, scales, or configures
  CI runners [decided].
- **Non-Claude agents and non-subscription credentials.** Claude Code CLI is the only agent; no
  Codex, pi [decided]. v1 supports **Claude subscription tokens only** — no API key, Bedrock, or
  Vertex path [decided].
- **Hosted sandbox backends** (Vercel, Daytona) [call].
- **General-purpose platform features** — a workflow-definition engine, multi-user permission
  models, air-gapped operation [call].
- **External notifications** (email, Slack, push) in v1 — everything is in the UI [decided]. An
  Obsidian tie-in via a persistent bind-mounted vault folder is a later add-on [decided: later].
- **Phone-home telemetry** of any kind [call].

### 2.3 Anti-goals (would make it a failure even if it works)

- **Growing into a general platform** — a workflow engine, multi-tenancy, pluggable providers [call].
- **Cross-pollinating projects** — any path by which one project's code, issues, or context reaches
  another project's agents [decided].
- **Setup that needs the owner** — a friend needing a call with the owner to reach a first PR.
- **An agent with the merge button** — merging is fully automatic (reviewer agent approves + CI
  passes → merged, no human click), but it is done by Jumpmaster's deterministic code after it checks
  those conditions, never by an LLM calling a merge API on its own judgment (§7.4).
- **State that wedges** — rebuilding sandcastle-afk's livelocks (§5.1, §16).
- **Untrusted text steering agents** — strangers' issues or comments acting as instructions (§7.1)
  [red team].

---

## 3. Deployment shape

- **One app container** ("Jumpmaster") holds the orchestrator, web UI, API, and MCP server [decided].
  Persistence is embedded SQLite on a mounted volume [call] — no separate database. Distributed
  from a public **GitHub** repo as an image on **GHCR** [decided], **Apache-2.0** [call]. The
  documented install is a small `docker compose` file pinning images by digest [call].
- **The app container never mounts the Docker socket** [red team]. Container launching is done by a
  separate, minimal **stick agent** (§5.3) — even locally, where the compose file runs one stick
  agent beside the app. This keeps host-root-equivalent access out of the internet-facing process.
- **First run** is a browser setup flow: create the operator login, connect the Claude credential
  (§12.1), add forge credentials (§7.3), enroll a stick (local by default), add a first project
  (§8), run the **readiness doctor** (§8.0).
- **Placement** [decided targets]: **local** (N troopers on this machine; 1, 2, or more), or
  **remote** Docker host, Podman, or Kubernetes. Each placement runs a stick agent that dials out.
- **Single operator**, single Claude account per install [decided; call on "single account"].
- Runs comfortably on a laptop or small home server.

---

## 4. Vocabulary

An airborne/paratrooper theme supplies the domain language [call]. Use it in code and docs; **the UI shows a
plain-English label alongside each term** so newcomers aren't lost [red team].

| Term | Plain English | Today's equivalent |
|---|---|---|
| **Jumpmaster** | the app | crew session + glue |
| **Command** | you, the operator | the owner |
| **Drop zone** | project (one repo on one forge) | a consuming repo |
| **Objective** | milestone on the goal ladder | GOAL.md rung |
| **Lighthouse** | long-term end state | top of GOAL.md |
| **Drop** | one job | one `run()` |
| **Trooper** | one job slot / one running job container | a loop clone |
| **Stick** | a runner host: a placement target + its stick agent + slot count | a dedicated runner machine |
| **Crew** | per-project judgment agents | crew skill |
| **Briefing** | a decision put to you | `[crew:brief]` |
| **Ruling** | a recorded decision | `[crew:ruling]` |

---

## 5. Architecture

```
                 ┌──────────────────────────── Jumpmaster container ───────────────────────────┐
 Operator ───────┤ Web UI · API · MCP server (scoped tokens)                                    │
 browser /       │ Scheduler (code, content-blind) · Drop store (SQLite) · Outbox · Vault       │
 Claude Code     │ Forge adapters (GitHub, GitLab) · Reconciler · Metrics · Prompt registry     │
                 │ Credential broker (short-lived, drop-scoped creds)                           │
                 └────────────▲─────────────────────────────────────────────────────────────────┘
                              │ enrolled stick agents dial OUT: lease drops, heartbeats, events
          ┌───────────────────┴───────────────────┐
          │ Stick agent (one per placement)        │ local Docker · remote Docker · Podman · K8s
          │ builds/pulls toolchain images,         │
          │ starts one container per drop ─────────┼──► Trooper container: fresh clone, Claude CLI,
          └────────────────────────────────────────┘    gates run credential-less, egress-limited
```

### 5.1 State ownership and reconciliation [call; red team sharpened]

Jumpmaster's DB is the source of truth for **intent**; the forge is the source of truth for
**facts humans and CI own**. The owner rule [red team]:

| Owned by the DB | Owned by the forge (cached with `observed_at`) |
|---|---|
| intent and plans, leases, budgets (heal/resume/conflict/no-PR), rulings, briefings, verdicts, objective progress, prompt/image versions per drop, outbox ops | issue/PR open/closed/merged state, head SHA, branch existence, reviews by humans, pipelines and their SHAs, mergeability |

- Every transition is `f(db state, fresh forge snapshot)`, testable without a forge.
- **Before any irreversible step** (push, PR create, approve, merge, close) forge facts are
  **re-read**, never trusted from cache.
- **Local git is the authority** for "already landed" / "contains base tip" (`git merge-tree`),
  not forge mergeability flags [red team, POC lesson].
- Webhooks only accelerate; **polling is a complete, paginated sweep** that alone is sufficient.
- **Mirror writes** (labels, status comments) carry an op-id; events caused by Jumpmaster's own op-ids
  are ignored. Only a short list of **human forge actions are commands** — close, reopen, push to an
  agent branch, merge, delete branch, removing a park label, a human review. Everything else Jumpmaster
  writes to the forge is display [red team].
- **Foreign-actor policy** [red team]: human-authored PRs are collision inputs only; a human push to
  an agent branch invalidates verdicts and pauses heal for that PR; a human review counts per branch
  protection; label names are configurable with a prefix to avoid clashing with existing labels.

### 5.2 Side effects: outbox, fencing, idempotency [red team]

- Every forge write goes through an **outbox**: record intent → perform with a lookup key (find PR by
  head branch before create; comments embed an op-id; merge pinned to `sha=`) → confirm. A failed or
  ambiguous call is **"unknown"** and is resolved by reading the forge back, never by blind retry.
  (POC: a 5xx-after-success produced 160 merge commits for 54 issues.)
- **Leases carry an epoch.** A drop is re-leased only after the stick agent confirms the old container
  is stopped, or after lease expiry plus grace. Pushes use `--force-with-lease=<sha the DB expects>`.
  Lease expiry uses only the orchestrator's clock.
- **DB uniqueness**: at most one active drop per issue or PR.
- **One merge at a time per drop zone** (merge lock); a branch must be up to date with base (or use
  the forge's merge queue) and re-pass CI after any base update before merging.

### 5.3 Scheduler [decided rules; call on mechanics]

Plain code, not an agent; content-blind [decided]. One global queue across drop zones. **Full
precedence** [red team, resolving an ordering conflict]:

1. **Escalations** (arbitrate/diagnose on a parked PR) — they unblock everything behind them.
2. **Finishing beats starting** — review, heal, resolve-conflicts, merge on open PRs, any drop zone.
3. **Issue priority tier across drop zones** — every `highest` before any `high` [decided].
4. **Project weight within a tier** — weighted fair share [decided].
5. Tie-breakers: `fix:` titles, then oldest; **aging** prevents starvation [call].
6. **Crew lead cycles** run on a per-drop-zone timer from a small reserved budget [call].
7. **Manual pin** by Command [call].

Each queue item shows its reason ("high · weight 3 · waiting 2d") [call].

**Liveness** [red team]: every eligible (item, role) has an **input fingerprint** — issue body,
trusted comments, head SHA, base SHA (Jumpmaster's own comments excluded). Re-running on an
unchanged fingerprint consumes a budget; an empty budget parks the item with a briefing. Required
property: from every reachable state an item consumes budget, waits on a named external event with
a **deadline**, or exits.

**Waiting on CI** releases the slot [call]. Every wait has a deadline and a poll fallback; the
pipeline is bound to the head SHA (multiple/cancelled/re-run pipelines handled); "no pipeline after
X" becomes a briefing [red team].

**Per-drop-zone controls** [red team]: pause/resume; **observe mode** (plans computed, forge writes
suppressed — also used for shadow-running the reference project, §15); usage **budget** as a share of the
subscription; **placement affinity** (e.g. a work repo may only run on the work stick). **Global
kill switch**: cancel all drops and revoke all drop credentials. **Drain** before upgrades.

**Usage limits** (§12.3) pause dispatch globally; they are not charged to any budget.

### 5.4 Sticks and troopers (the rebuilt Sandcastle + sandcastle-afk) [decided: rebuild, no Sandcastle dependency]

A new implementation informed by the POC, not a port; no dependency on `@ai-hero/sandcastle`.

**Stick agent** [red team, resolves the builder's topology question; call]:
- A small long-lived process, one per placement target, **enrolled** from the UI (one-time join
  token → per-stick credential, revocable). It **dials out** to Jumpmaster (works through NAT), so
  Jumpmaster never needs network reach into remote hosts. Jumpmaster must be reachable *from* the
  stick (same machine, LAN, or a tunnel the operator provides).
- Advertises slot count; leases drops; starts one container per drop via its local driver (Docker,
  Podman, or K8s Jobs from inside the cluster); streams events; enforces cancel/drain; garbage-
  collects containers labelled with drop id + lease epoch against the lease table on restart.
- **Toolchain images** are built by the stick agent from the drop zone's template (Docker/Podman),
  without secrets and without socket access inside the build, base images pinned by digest. **K8s
  sticks require an operator-provided registry** to push/pull [call]. Stack **presets** ship for
  node, python, go, and jvm with gate detection [red team]; the POC's Node-only template goes.
- Stick-reported results are **not trusted for merge decisions**: Jumpmaster verifies CI and head
  SHA on the forge itself [red team].

**Troopers (drop containers)**:
- Generic capacity: five projects do not need ten troopers [decided].
- Fresh clone per drop, accelerated by a per-stick mirror cache (partial/sparse clone for
  monorepos) [red team]. Checkpoints are pushed **WIP commits on the agent branch** — on a timer and
  on SIGTERM — via the fenced push (§5.2); `maxResume` lives in the DB.
- **Heartbeat comes from the trooper runtime**, not from agent output; a separate progress watchdog
  watches the agent, so long silent test suites don't kill drops (POC lesson).
- The drop payload: drop zone, repo, issue/PR, role, **pinned prompt version and image digest**
  (recorded on the drop), resolved config, and **short-lived, drop-scoped credentials** (§7.3).
- Roles: `implement`, `review`, `heal`, `resolve-conflicts`, `triage`, `sentinel`, and crew roles
  `crew-lead`, `refute`, `diagnose`, `arbitrate`, `scout` (§6).
- **Kept from the POC** (re-implemented): heal budgets and parking; checkpoint resume; mechanical
  merge before an agent conflict resolver; reviewer independently re-runs gates; closed-issue/orphan
  PR handling; blocker-dependency unblocking; collision avoidance; **verification gate** (a diff
  matching configured globs must produce artifacts — e.g. UI screenshots — attached to the verdict
  and inspected by the reviewer); **sentinel** (scheduled e2e run that files regression issues as
  staged) [red team: both were missing].
- **Dropped from the POC**: the `while(true)` poller, label claims, host git mutation, the
  SIGINT/supervisor machinery and stop sentinel file, the layer-copy/`afk:update` model, Sandcastle's
  multi-agent and hosted-sandbox options [call].
- **Gates are data** and **run credential-less** (§7.2): per-command results and timings are reported
  structurally. In review, gates come from the drop zone's config held by Jumpmaster, not from files
  the PR can edit [red team].
- **Services for tests**: a drop zone can declare sidecar services (a compose fragment; pod sidecars
  on K8s), e.g. a database for integration tests [red team; required by the reference project].
- **Drop-zone secrets** (test env, private registry/npm/pip creds): a separate vault class injected
  only into gate steps, redacted from transcripts [red team].
- **Claude Code invocation** [red team, verified against Claude Code docs]: pinned CLI version;
  `-p --output-format stream-json --verbose`; explicit `--settings`/`--setting-sources`/`--mcp-config`
  (repo `.claude/` hooks and `.mcp.json` treated as untrusted); role prompt via
  `--append-system-prompt-file`; `--json-schema` for the review verdict (never parsed from prose);
  `--max-turns`; `--resume <session>` for checkpoint resume; SIGINT before SIGTERM; per-container
  `CLAUDE_CONFIG_DIR`; fail fast on `system/init` MCP/plugin errors. Capture `modelUsage`,
  `usage`, `num_turns`, `permission_denials`, terminal reason, and the transcript.

### 5.5 Forge adapters

Typed adapters for GitHub and GitLab: issues, labels, comments, PR/MR lifecycle, reviews, merges
(SHA-pinned), CI pipelines and timings, webhooks, permission lookups. The POC's `bin/forge` (39
verbs) and its contract fixtures are the requirements oracle [call]. GitLab is validated end-to-end
in CI against **gitlab.com (free tier) and a self-hosted GitLab container** [red team; call on
which].

---

## 6. Crew — per-drop-zone judgment [decided structure]

- **One crew per drop zone; no agent oversees more than one project** [decided]. The only
  cross-project view is the dashboard, and that is Command.
- **Isolation is structural** [call]: a crew drop receives only its drop zone's GOAL.md, issues, PRs,
  rulings, and repo; its MCP token is scoped to that drop zone; rulings, briefings, audit cursors,
  and case history are stored per drop zone; forge credentials are per drop zone.
- **Crew lead cycle** (per drop zone, on a timer): apply Command's answers; parked PRs →
  diagnose/arbitrate; refute staged specs and promote to ready; collisions → blockers; priorities;
  audit merged commits on red-team paths; steer toward the current objective (scout + file staged
  issues when ready work runs low); raise briefings.
- **Models**: arbitrate and diagnose use **Fable** where the plan includes it (§12.2); refute and
  scout use Opus [decided: Fable escalation; call: mapping, configurable].
- **Crew acts only through Jumpmaster's MCP/API**, holding no forge write credential. It can file
  staged issues, comment, label, set blockers, post rulings, propose goal changes; it cannot approve,
  merge, push, or change goals [call; replaces `f`].
- **`alwaysEscalate`** (deploys, IAM/CI, secrets, spend, public claims, data deletion, goal changes)
  always produces a briefing, and **blocks auto-merge** of PRs touching those concerns [red team].
- **Briefings**: decision, why it matters, options, recommendation, what's on hold. In the UI's
  "Waiting on you"; Command rules in place; the ruling is recorded [decided: UI only].

---

## 7. Trust, credentials, and threat model [red team — new section, calls unless marked]

### 7.1 Trust boundary: what may instruct an agent

Default assumption: **repo code, dependencies, and any text not written by a trusted maintainer are
hostile.** Jumpmaster may be distributed to third parties; public repos receive strangers' issues.

- Only content authored by users with actual repo write/maintain/admin permission (looked up, not
  inferred from `authorAssociation`) enters prompts as instructions. **Lookup errors fail closed.**
- Bot identities (both Jumpmaster bots) are never trusted as instruction sources; their comments never
  count as a maintainer answer.
- Issues filed by non-maintainers never become `agent-ready` without a Command ruling (or a crew
  refute that Command has allowed for that drop zone). Per-author rate limits keep strangers from
  flooding the queue.
- Prompts mark PR diffs, comments, and test output as **data**, especially in review.
- The POC's trusted-author contract tests become acceptance criteria.

### 7.2 Containing hostile code

- **Gates run credential-less**: repo code (installs, postinstall scripts, tests) runs in a step or
  sidecar with no Claude or forge credential in its environment.
- **Default-deny egress** from drop containers: allow the Claude API, the drop zone's forge, and
  configured package registries. Drops cannot reach each other or Jumpmaster except via the trooper
  runtime's authenticated channel.
- Prefer a **credential proxy** in the trooper runtime (the agent's HTTP calls get auth added outside
  the agent's environment) over raw env injection; where the Claude CLI requires the token in-process,
  state that residual risk in the docs.
- Rootless Docker/Podman documented as the recommended stick setup; hardened runtimes (gVisor) are an
  optional stick setting.

### 7.3 Forge credentials

- **Two bot identities per drop zone** — author and reviewer [decided], modelled as **credential
  roles** so strategy can change by config [call].
- **Single-identity starter mode** [decided]: a first-run operator may start with one bot and upgrade
  to two later. In starter mode the bot authors; the reviewer agent's SHA-bound verdict is recorded
  in Jumpmaster and the orchestrator merges when it and CI pass — still no human click. Because a
  forge cannot require an approval from a different identity here, branch protection requires CI
  only; the readiness doctor shows starter mode as a warning and links the two-bot upgrade [call].
- Tokens are **repo-scoped per drop zone** (fine-grained PATs, GitHub App installation tokens, or
  GitLab project tokens), with documented minimum scopes: **no `workflow` scope, no admin**.
- The credential broker mints or hands out **short-lived, drop-scoped credentials** where the forge
  supports it; long-lived vault secrets never leave Jumpmaster unnecessarily.
- Per role: implement/heal/resolve get **author** write; **review gets read-only forge access**; crew
  gets none (MCP only); gates get none.

### 7.4 Automatic merge, performed by the orchestrator — under branch protection

This is a factory: an ordinary PR merges with **no human involvement** once the reviewer agent
approves and CI passes, exactly as in the POC [decided]. What changes is *who executes* the merge:
Jumpmaster's code, after checking the conditions below, rather than an agent with a merge-capable
token. Command is only pulled in by briefings (protected paths, `alwaysEscalate`, parked PRs).

- The review drop returns a structured verdict (`--json-schema`) **bound to the head SHA**.
  Jumpmaster stores it, posts the approval **as the reviewer bot**, and merges only if
  verdict SHA = CI SHA = current head and the change is not already on base. Any push invalidates
  the verdict.
- **Branch protection stays authoritative**: bots are non-admin and cannot bypass rules; required CI
  checks on; **protected paths** (GOAL.md, drop-zone config, toolchain template, `.claude/`, agent
  rules, CI config) require a human review via CODEOWNERS or equivalent, and agent PRs touching them
  always produce a briefing. The readiness doctor (§8.0) verifies these settings and refuses unsafe
  ones without an explicit Command override.

### 7.5 Jumpmaster's own surfaces

- **UI**: mandatory operator login created on first run; binds to localhost by default; CSRF and
  Origin/Host checks (defeats DNS rebinding against the local API/MCP); session timeout; re-auth to
  reveal or replace secrets.
- **MCP/API tokens**: crew/worker tokens are minted per drop, bound to one drop zone, expire with the
  drop; Command's tokens are created in the UI with an expiry and scope. Every mutating call is
  audited. Scope enforced server-side on every resource id.
- **Vault**: secrets encrypted at rest with a key supplied via env var or Docker secret **outside the
  data volume**; the docs state the threat model plainly.
- **Transcripts** are redacted for secrets, retained per a configurable policy, and **excluded from
  the diagnostics export**.
- **Supply chain**: signed images (cosign), SBOM and provenance, digest-pinned compose, Claude CLI
  version pinned and checksummed, automated dependency updates.

---

## 8. Goals and intake

### 8.0 Readiness doctor [red team]

A check the operator can run any time (and setup runs automatically) per drop zone: Claude credential
works and plan tier detected; forge token scopes and repo access per role; bots are non-admin;
branch protection and protected paths; CI exists (or the **no-CI-yet path**: gates are the only
check until CI exists, clearly flagged); labels creatable; toolchain image builds; a gate dry-run
passes on the default branch; services start. Every failure gets a fix-it hint.

### 8.1 Goals live in the repo; status lives in the app [decided]

- **`GOAL.md` in the repo**: lighthouse, objectives, decisions, non-goals, constraints. Jumpmaster
  parses it and renders the ladder. It is a protected path (§7.4).
- **Progress in the DB**: current objective, issue↔objective mapping, evidence, done/not-done.
  Replaces the POC's tracker issue; a forge mirror is optional [call].
- **Editing from the UI** opens a goal-change PR as the author bot that Command approves in-app;
  crew may propose goal edits, never merge them [call].
- The parse format is the builder's to define; the reference project's `GOAL.md` must parse, with at most minimal,
  owner-approved edits [call].

### 8.2 Intake [decided: scenarios and spirit]

A "lay of the land" phase, interview-heavy (grill-me / brainstorming spirit). Three entry paths,
each a skill, sharing building blocks (interviewer, codebase scout, goal-ladder writer, issue
splitter) [call]:

1. **Existing production app** — investigate code, history, issues, docs, deployment; interview
   for original goals, likes, dislikes, future ideas; set objectives and the lighthouse.
2. **Idea, no repo** — full brainstorming, shaped by what the factory needs.
3. **Partly built** — both; focus on the gap to production and keep-vs-rebuild.

All end with a `GOAL.md`, the first objective split into **staged** issues, and drop zone config.
Intake can be re-run as a re-plan [call].

**Where intake runs**: v1 — the interview skills run in Command's own Claude Code connected to
Jumpmaster's MCP server [call]; **a minimal in-app path** (pick a template → GOAL.md stub → first
staged issue) exists in v1 so a friend is never blocked [red team]; v1.x — full in-app intake chat
running the same skills on a trooper.

### 8.3 Issue spec format

Agent-ready issues use the POC's `agent-ready-issue` format: acceptance-criteria checklist plus
required tests [call]. Full spec text is passed to agents (POC defect: clipped at 3000 chars).

---

## 9. MCP server [decided]

Drop-zone-scoped tools: read goals/objective status; read issues, PRs, rulings; file staged issues;
post rulings and comments; raise briefings; propose goal changes; read queue and flow state.
Callers: crew/worker drops, Command's own Claude Code, later the in-app chat. Token rules in §7.5.

---

## 10. UI

### 10.1 Home: the Factory floor [decided, mockup approved: `mockups/floor-with-flow.html`]

Slots (current drop, phase, elapsed, gate progress, "waiting on CI"); Flow strip with bottleneck
callout; queue with reasons; Claude usage state; CI box (read-only); "Waiting on you"; a visible
**kill switch** [red team].

### 10.2 Flow page [decided, mockup approved]

The owner's lesson: as development speeds up, **the pipeline becomes the chokepoint**. Cycle time
split by stage (spec, queue, implement, review, CI queued, CI running, heal, merge); per-week trend;
filters by drop zone and window; throughput balance (PRs ready for CI vs PRs CI clears per day);
pipeline step detail with test counts; duplicate-work panel (gates run up to 3× per PR). Data from
Jumpmaster's drop records plus forge CI APIs; nothing extra for operators to install [call].

### 10.3 Other surfaces [decided in scope; call on shape]

Drop zones (ladder, weight, config, pause/observe, affinity, budget); issue graph per drop zone
(states, blocker edges, objective mapping, PR state); drop detail (live transcript, gates, verdict,
usage, model actually used); briefings and ruling history; prompts registry; settings (Claude
credential, forge credentials, sticks); readiness doctor.

---

## 11. Prompt optimization [decided]

- **Base prompts** shared across drop zones; per-drop-zone **overrides**.
- Outcomes tracked per prompt version: heals, parks, review rejections, gate failures, cycle time.
- Jumpmaster **proposes** edits to base prompts; Command accepts or rejects; versions are visible.
- Cross-project learning allowed for base prompts [decided]. **Guardrails** [call + red team]: the
  abstraction step runs per drop zone and never quotes content verbatim; the proposal generator sees
  only statistics and abstracted patterns; every proposal is a diff Command approves.
- **Sample size** [red team]: with few drop zones, signals are noisy. Proposals are only generated
  once a prompt version has a minimum number of drops; until then the feature is versioning plus
  outcome dashboards. Ships late in the sequence (§15).

---

## 12. Claude account, usage, and models

### 12.1 Credential and terms [decided: subscription tokens only]

Verified from Anthropic's docs (see §18 sources): `claude setup-token` is explicitly offered for CI
and scripts (one-year token, Pro/Max/Team/Enterprise). Consumer plans (Pro/Max) say limits assume
"ordinary, individual usage." Products that run Claude Code for others must follow Anthropic's
Commercial Terms; they **may not collect, store, or intermediate Claude.ai credentials**, may not
resell or intermediate usage, and must ship Claude Code unmodified.

Implications [call]: the token always belongs to the operator who runs the install — never supplied
or shared by a distributor or anyone else; Claude Code's own auth is never wrapped or modified; the app
links to Anthropic's terms; no Anthropic-endorsement wording. v1 supports **subscription tokens
only** [decided]. The owner's position is that this operator-owned, self-hosted model aligns with
Anthropic's terms, so no separate confirmation is sought [decided].

### 12.2 Fable [red team]

Fable is outside plan limits on Pro and Team-standard (billed to pay-as-you-go credits, which `-p`
mode does **without asking**), and capped at a share of weekly limits on Max/premium seats; some
security-flagged Fable requests are silently served by Opus. Therefore: detect plan tier at setup;
enable Fable roles only where included; otherwise default those roles to Opus; track the Fable
weekly share and fall back to Opus ourselves; record the model that actually served each drop;
**never auto-buy credits** (surface `credits_required` to Command).

### 12.3 Usage limits [red team]

- Read structured stream-json signals: `rate_limit_event` (`allowed` / `allowed_warning` /
  `rejected`, `resetsAt`, `utilization`), assistant `error: rate_limit`, result `api_error_status`.
  **No regex on error text.**
- `allowed_warning` → soft throttle (start nothing new, let running drops finish). `rejected` →
  global pause until `resetsAt` + jitter, then one probe drop; a pause past a cap raises a briefing.
  Weekly exhaustion can mean days — the UI and scheduler handle that.
- A drop interrupted by a limit checkpoints and requeues **without consuming a budget**.
- Remaining usage may not be readable with a setup-token (the usage report requires a scope the
  token may lack); the UI shows the last known state from events and degrades gracefully. Verify
  early (M0 spike).
- Command's own interactive Claude use draws on the same account and is invisible to Jumpmaster;
  the UI says so.
- Token expiry: store creation date, warn before the one-year expiry; `authentication_failed` puts
  Jumpmaster in a global re-auth state, not a retry loop.

---

## 13. Constraints

- **Claude Code CLI** is the execution engine; Claude usage limits are a hard shared constraint.
- **Stack**: TypeScript on Node for app, stick agent, trooper runtime, UI; SQLite [call].
- **SQLite operations** [red team]: WAL on a local volume only (not NFS); backups via `VACUUM INTO`
  or the online backup API; forward-only migrations gated on schema version; **restore from an older
  backup must be safe** — the reconciler adopts unknown agent PRs by branch convention / op-id and
  never re-merges. Sticks ride out an orchestrator restart (buffer events, retry heartbeats, lease
  grace > restart time); the stick protocol is versioned.
- **Clean-room codebase**, informed by sandcastle-afk and the POC crew, not copied from private code [call].
- **Open source**, Apache-2.0, GitHub + GHCR [decided OSS; call license]; repo ownership may
  move to an organization later [decided]. No phone-home; design partners share feedback via an explicit, redacted
  diagnostics export [call].

---

## 14. Left to the builder

Internal module boundaries, API style, UI framework, event streaming transport; lease/heartbeat
protocol details within §5.2; reconciler internals within §5.1; GOAL.md parse format within §8.1;
image templating/caching details; K8s Job specifics; whether agents use a forge CLI, MCP tools, or
both (within §7.3 credential rules); UI auth mechanism within §7.5; retention defaults; exact
budget numbers and deadlines.

---

## 15. Releases and gates [red team; order decided]

"All nine in v1" ships as usable releases. Each has a gate; later releases don't start until the
gate passes. The order — including the reference-project cutover at M2 and design partners at
M4 — is confirmed by the owner [decided].

| Release | Contents | Gate |
|---|---|---|
| **M0 Tracer** | one drop zone, GitHub, local stick, `implement` only, DB lease, gates-as-data, operator merges by hand; spike on usage signals | an agent PR on a real repo end-to-end |
| **M1 Loop parity** | review, heal, resolve-conflicts, outbox + SHA-bound orchestrator merge, two-bot roles, checkpoint resume, usage pause, trust boundary | POC failure-class tests (§16) green |
| **M2 Dogfood cutover** | observe/shadow mode, open-agent-PR adoption, kill switch, pause, drop-zone secrets + services, verification gate | the reference project runs on Jumpmaster; POC retired |
| **M3 Crew + MCP** | crew lead + roles (Fable gating), briefings UI, scoped MCP, GOAL.md ladder | the POC crew retired |
| **M4 Friend-ready** | readiness doctor, stack presets, minimal in-app intake, intake skills, compose install, egress control, signed images | 2 design partners reach a first PR unaided |
| **M5 Multi-project + GitLab** | weighted scheduler, budgets, affinity, GitLab adapter validated e2e | two drop zones on two forges concurrently |
| **M6 Flow + placements** | flow/CI metrics, issue graph, remote Docker, Podman, K8s sticks, sentinel | a remote stick runs drops through NAT |
| **M7 Optimization + chat** | prompt outcomes and proposals, in-app intake chat | first accepted prompt proposal |

**Reference-project migration** [red team; call]: clean cutover rather than importing POC label state —
drain the sandcastle-afk loops, run Jumpmaster in observe mode against the reference project to compare decisions,
then switch; open agent PRs are **adopted** by branch convention (`agent/issue-N`), heal budgets
reset. The two systems never both act on one repo. crew.config/afk.config map to drop zone config;
the three `gh` accounts map to credential roles.

---

## 16. POC failure classes that must be tests [red team]

- Merge call returns 5xx after succeeding → exactly one merge; outcome read back.
- Partitioned trooper looks dead while a second lease runs → one push, one PR.
- Implement ends without a PR → escalates after N runs on the same fingerprint; Jumpmaster's own
  comments don't reset the count.
- PR whose issue is closed (landed, not landed, conflicted, branch gone) leaves flight and never
  blocks dispatch.
- Stale CHANGES_REQUESTED on an old SHA → re-review once, then escalate; a heal that pushes nothing
  never reaches approval.
- Reviewer blocked on SHA X, author approves same SHA → never merges.
- Stale conflict flag while the branch already contains base tip → no loop, no starvation.
- Heal/conflict budgets count attempts (marked before the run); a human can reset them.
- Orphan PR vs a null-SHA "preparing" MR (not an orphan).
- Untrusted / read-only / triage commenters don't steer agents; failed permission lookup = untrusted.
- Usage limit mid-drop → checkpoint, global pause, resume, no budget consumed.
- Long silent test command doesn't kill the drop; SIGKILL resumes from the last checkpoint.
- Two schedulers/sticks race → one active drop per issue.
- Lost webhook; cancelled or missing pipeline → deadline fires.
- Human merge/close/reopen/force-push/branch-delete during every state.
- Restore from an older backup → unknown PRs adopted, nothing merged twice.
- Pagination past 100 items in every forge listing.

---

## 17. Owner answers to the review's open questions

1. **Claude credential paths** — subscription tokens only for now; no API key, Bedrock, or Vertex
   path. No separate Anthropic confirmation: the operator-owned, self-hosted model aligns with
   Anthropic's terms.
2. **Single-identity starter mode** — yes (§7.3), still fully automatic merging.
3. **Release order** — §15 as written: reference-project cutover at M2, design partners at M4.

---

## 18. References

- Crew (POC): a private Claude Code skill — lead cycle, role prompts (refute, diagnose, arbitrate,
  scout), the `f` forge allow-list wrapper, crew config, and the reference project's `GOAL.md`.
- sandcastle-afk: https://github.com/x-a-n-d-e-r-k/sandcastle-afk — `.sandcastle/loop.ts`,
  `config.ts`, `claim.ts`, `heal.ts`, `conflicts.ts`, `merge-guard.ts`, `review-gate.ts`,
  `checkpoint.ts`, `ui.ts`, `rerender.ts`, `sentinel.ts`, prompts `.sandcastle/*.md`, `bin/forge`,
  `forge-verbs.json`, contract fixtures, `README.md` validation table, `playbook.md`; fix commits
  cited in §16 (e.g. a292303, f6fce23, ddf52bb, 1d6f695, bc8e9dd, 35aeaaa, aebd939, 634332f)
- Upstream Sandcastle: https://github.com/mattpocock/sandcastle (`@ai-hero/sandcastle` 0.12)
- Anthropic (checked 2026-10-19): Claude Code legal & compliance
  (code.claude.com/docs/en/legal-and-compliance), authentication, headless, model config, Agent SDK
  TypeScript reference; Consumer Terms (anthropic.com/legal/consumer-terms); help center "Claude
  Fable models on your plan" and "Use Claude Code with your Pro or Max plan".
- Mockups: `mockups/home-layout.html`, `mockups/floor-with-flow.html`.
- Review inputs: builder check; red teams on security, reliability, Claude subscription, scope.
