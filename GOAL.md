# Jumpmaster goal

## Lighthouse

Jumpmaster is a self-hosted software factory that takes a repository's agent-ready issues to
merged pull requests with no person in the loop, safely, and is easy for a first-time operator to
install and run.

## Objectives

The current milestone is M5: GitHub App authentication, built as specified in
`docs/superpowers/specs/2026-11-13-github-app-auth.md` (the spec). Each objective below is one
task of the spec's §13, except "Usage gate decides on reported utilization", which fixes how the
dispatch gate reads Claude's usage signals, "GitLab forge adapter", which is the GitLab adapter
that spec §9 and the design spec's §5.5 (`docs/superpowers/specs/2026-10-19-jumpmaster-design.md`)
assume and Task 12 builds on, and "Crew chat enhancements", which improves the owner's crew chat.
Read the named sections of the spec before planning; the spec, the spike
results in `docs/spikes/2026-11-14-github-app.md`, and the push container already on `main`
(spec Task 4) are the ground truth. File issues small enough for one drop each, in dependency
order, each naming the spec sections it implements.

### Vault and credential resolution (spec Task 7) (done)

§4.4: `github-app/<owner>/<role>` vault entries, credential references, app-first resolution,
`testCredential` and fingerprints for apps, PEM scrubbing, `pairFor` by credential kind, the read
source.

### Broker and JWT (spec Task 5) (done)

`apps/server/src/forge/github-app.ts`: sign the app JWT, mint installation tokens narrowed to the
zone's repository and to the permission subset of each use in §4.2's table, cache the server's own
tokens and re-mint them with under ten minutes left, mint per-drop read tokens and per-push write
tokens and revoke them at drop end or on the push result, suspend the installation for the kill
switch, and register every minted token and the key with redaction. The spike found that
suspension kills live tokens within seconds, so minted tokens are not stored in the vault (§4.2).
Tests run against a fake GitHub; nothing calls github.com.

The broker (#105), the scrub set (#106) and the server-token cache (#111) come first; the
lease, push and kill-switch hookup waits for Task 7's credential resolution (Command rulings 23,
26 and 28).

### Forge identity (spec Task 6) (done)

§4.3: a token provider and the forge's identity in `GitHubForge`; every caller that reads the
token's account; `viewerIsAdmin`; ruleset bypass per ruleset with the absent-field fallback;
`repoAccess`; the bot login set in `ours()` and `flow/reconcile.ts`; the check-runs read.

### Manifest flow (spec Task 8) (done)

§4.1: the owner choice (personal or organization, preselected from the repository), one app pair
per owner, the manifest builder that refuses `administration` and `workflows`, single-use state,
immediate redemption with log scrubbing, the conversion checks, the Finish confirmation, the
install link and installation discovery; the wizard's and Settings → Credentials' buttons.

### Doctor and guidance (spec Task 9) (done)

§6's app column, the slug check, the `jumpmaster-merge` ruleset file, CODEOWNERS text for app
reviewers, `recommendIdentity` for apps, and token links for starter mode and "Use tokens
instead". `forge.actions-approval` may be deferred.

### Runbooks and SECURITY.md (spec Task 10) (done)

Install (GitHub Apps first for two-bot, tokens for starter and as the alternative), operate (key
rotation, adding a repository or an owner, pending pushes), troubleshooting by check id, the key's
reach.

### Usage gate decides on reported utilization (done)

The dispatch gate (`apps/server/src/usage.ts`) holds new work on the owner's threshold
(`usage.throttleUtilization`) applied to the utilization Claude reports, and on nothing looser.
Command's decision of 2026-11-23: **the threshold is the control; Claude's `allowed_warning` is
information.** Parts, in this order:

- **Per-window gating**: the gate reads each reported window from `usage_windows`, each expiring
  by its own reset or observed time; a window missing from a report that carries
  `unifiedWindows` is forgotten (the `ultra` plan has no 5-hour window); only account-wide windows
  hold all dispatch, and a per-model window holds only drops on its model.
- **The warning informs**: `allowed_warning` is stored (window, time, reset) and holds work only
  when Claude reported no utilization for the warned window, and then only until that window's
  reset. Chat turns never extend a hold while utilization is reported.
- **Reasons and the warning shown**: one `gateReason` shared by Home, the doctor and `get_queue`
  names what holds the gate (window, figure, threshold, or pause, credits stop or warning
  fallback); the Home usage card shows a current Claude warning as information whether or not
  the gate is open.

`rejected`, probes and the credits stop are unchanged. The override in #728 and #729 assumes the
warning holds work; Command decides whether it is still wanted once these land.

### GitLab forge adapter

Design spec §5.5 and spec §9: a zone can live on GitLab (gitlab.com or a self-managed instance),
running on bot-user personal access tokens (`gitlab-pat`), the GitLab counterpart of today's
GitHub PAT path. Parts, in this order:

- **Zone forge kind**: a zone records its forge (`github`, the default, or `gitlab`) and, for
  GitLab, the instance's base URL and the project path. Existing zones read as `github` with no
  migration step, and every GitHub code path stays byte-identical.
- **A fake GitLab** for tests (in the style of the existing fake GitHub), covering the REST calls
  the adapter makes. Tests never reach gitlab.com.
- **`GitLabForge`** implementing the existing `Forge` interface, in reviewable slices: issues,
  labels and comments; branches, files and compare; merge requests (open, find by source branch,
  changed files, change digest); approvals as reviews; pipelines and jobs as checks, with retry;
  SHA-pinned merge (`sha` on accept) and rebase as the branch update; protected branches and
  approval rules as branch rules; project member access levels as `isTrusted`, `isMaintainer`
  and `repoAccess`. Where GitLab has no counterpart (for example "blocked by" links on the Free
  tier), the method is a documented no-op or an explicit refusal that the callers already handle.
  Each slice says so in its PR.
- **Credential kind `gitlab-pat`**: per-zone author and reviewer entries in the vault, a
  `testCredential` that reads `GET /user`, fingerprints, and `pairFor` building a `GitLabForge`
  pair for a GitLab zone.
- **Clone and push**: the trooper's git auth scope and the push container accept the zone's
  GitLab host, and the GitLab token reaches only the clone and push containers, in which no agent
  runs. Private and internal projects are cloned by the clone container of
  `docs/superpowers/specs/2026-11-24-clone-container.md` (Command ruling 121), built in that
  spec's order: it uses `gitlab-pat/<zone>/read` (a project deploy token, `read_repository`
  only) when set, else the author token, and exits before the agent starts. No GitLab token ever
  enters a container an agent runs in. A change to egress allowlists, CI, SECURITY.md or another
  protected path goes to Command as a briefing, not an issue.
- **Wizard and doctor**: the project step accepts a GitLab project URL, and the doctor's forge
  checks have a GitLab column (token valid, access level Developer or above, no `sudo` or
  `admin_mode` scope, approvals counted where approval rules exist).

The zone forge kind and the fake GitLab come first; the `GitLabForge` slices need both; the
credential kind, clone and push, and wizard and doctor need `GitLabForge`. This objective is the
prerequisite of "GitLab adapter (spec Task 12)" (Command ruling 106).

### GitLab adapter (spec Task 12)

§9: the bootstrap token, project-token minting with `self_rotate`, the per-zone credential kinds.
It waits for "GitLab forge adapter": the `gitlab-project-token` kind plugs into the `GitLabForge`
and the `gitlab-pat` kind that objective delivers. The standalone token client
(`apps/server/src/forge/gitlab-tokens.ts`, #540 and #595) and GitLab token redaction (#539)
have already merged.

### Crew chat enhancements

Make the owner's crew chat (`/chat`, `apps/server/src/chat/` and `apps/server/src/ui/chat.ts`)
easier to live with day to day. It stands apart from the M5 spec; the design of record is
`docs/superpowers/specs/2026-11-18-crew-chat-design.md`. Parts:

- **Thread management**: rename a thread (from the `/chat` list and the thread page), and delete
  old threads with a trashcan button on the right side of each listed thread, behind a
  confirmation. Delete removes the thread's messages and cards with it, is refused while a turn
  is running or a change waits for confirmation, and never undoes a change the thread applied.
- Further chat improvements the owner asks for, each as its own issue.

Every route keeps the chat's existing viewer scoping and CSRF protection, and no change weakens
how chat actions are confirmed or undone.

## Constraints

- The spec wins over any issue, plan or comment. Where the spec is silent, choose the option that
  keeps an operator's work lowest and say so in the PR.
- Starter mode stays on personal access tokens; GitHub Apps are for two-bot mode only. PAT mode
  must keep working unchanged at every step: no issue may break an existing PAT install.
- No manifest, token or code path ever asks for `administration` or `workflows`. On GitLab, no
  token is ever requested with `sudo` or `admin_mode`, or above Maintainer.
- No write token in any container an agent ran in. Per-drop and per-push tokens are narrowed to
  the drop's repository.
- Never log, return or render a token, a private key or a client secret. Tests prove it for every
  new path.
- Tests never reach github.com or gitlab.com; use the existing fakes or nock.
- One concern per issue and per pull request; each issue states its acceptance criteria and
  required tests.

## Non-goals

- Migrating existing two-bot PAT installs to apps (spec Task 11): deferred until such an install
  exists.
- Webhooks: Jumpmaster polls.
- Public GitHub Apps.
