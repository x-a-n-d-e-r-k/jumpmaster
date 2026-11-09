# Runbook: M1 loop

> **New install?** Start with the [install runbook](install.md): it installs a published release
> with Docker Compose. This runbook is the M1 development rehearsal, run from a checkout.

End-to-end check that Jumpmaster M1 runs the whole loop with no human click: a labelled
issue is implemented, reviewed by a second bot identity, healed or resolved when needed,
and merged by the server once the verdict, CI and the PR head all agree on one SHA.

It builds on the [M0 tracer runbook](m0-tracer.md). Build, the stick and the
environment-variable handling are the same; this runbook lists only what changes.

## Prerequisites

To move a real project, also read the [M2 cutover runbook](m2-cutover.md).

Everything from M0, plus:

- **`JM_OPERATOR_TOKEN`**, any secret of at least 32 characters, for the [control routes](m2-cutover.md#controls).

- **A second bot account (the reviewer).** Add it to the test repository as a
  collaborator with write access. Accept the invitation from that account.
- **Two fine-grained PATs, one per bot, both scoped to the test repository only:**

  | Token | Owner | Repository permissions |
  |---|---|---|
  | `JM_GITHUB_AUTHOR_TOKEN` | author bot | Contents: read/write · Pull requests: read/write · Metadata: read |
  | `JM_GITHUB_REVIEWER_TOKEN` | reviewer bot | Pull requests: read/write · Metadata: read |

  Neither token gets Workflows, Commit statuses, Checks, Secrets or Administration.
  Neither bot is a repository admin. The two tokens must differ; the server refuses to
  start if they are the same.
- **Or: your own account as the author, plus one machine account as the reviewer.** This
  suits a person running Jumpmaster alone, since GitHub's terms limit how many free machine
  accounts one person may hold. The differences from two bots:

  | Token | Owner | Access |
  |---|---|---|
  | `JM_GITHUB_AUTHOR_TOKEN` | you | Fine-grained, this repository only, same permissions as above |
  | `JM_GITHUB_REVIEWER_TOKEN` | machine account | Classic `repo` scope |

  - Set `"authorMayBeAdmin": true` on the zone, because a personal repository's owner is
    always an admin. The reviewer still must not be an admin, and neither account may
    bypass the ruleset, so your bypass list must not include you or the admin role.
  - The reviewer needs a classic token because GitHub's fine-grained tokens don't cover a
    collaborator's access to a repository owned by another personal account. It reaches
    every repository that account can, so keep it on the server and use a token made for
    Jumpmaster alone. It never enters a runner.
- **Or: one account, in starter mode** (opt-in, `"identity": "starter"` on the zone). No
  reviewer token: the reviewer drop's verdict is kept in Jumpmaster and shown in the UI, and
  the author merges when that verdict and CI pass on the same head. It needs a fine-grained
  author token, `ciRequired: true`, and a ruleset with a pull request rule (0 approvals),
  required checks with GitHub Actions as the source, and no bypass. What it costs, as the
  doctor's `zone.identity` warning states it: starter mode: the author token can merge any
  green PR, including an unreviewed one; it is held by the server and by the trooper's root
  process in implement, heal and resolve drops. Use a fine-grained token for this repository
  only, with no Workflows permission, or add a reviewer identity. See
  [the install runbook](install.md#starter-mode).
  - For a private repository, the author token also needs Issues: read, and, when the zone
    requires CI or branch protection requires checks, Commit statuses: read and Actions: read.
    GitHub never lets a fine-grained token read check runs, so Jumpmaster reads GitHub Actions
    jobs instead, which carry the same names. Checks posted by other GitHub Apps are not
    visible this way: a required check that only such an app reports never turns green.
    A read refused with 403 parks the item at once with a reason naming the permission to grant;
    it recovers on its own once the token can read.
  - The server refuses to start unless the author token is fine-grained. Don't grant it
    Administration: the server can't check that, and an admin's token with it could
    plausibly edit the ruleset.
  - Merges run under the reviewer token, so your admin account never performs them.
  - PRs, and so squash commits, appear under your name. Commits on agent branches are
    authored by `Jumpmaster Agent`.
  - GitHub won't let you review your own PRs, so your reviews can't stop one. Add the
    `jm:hold` label instead: the PR parks, with no new agent work, approval or merge, and
    continues when you remove the label. A running drop still finishes, and a merge
    already being sent can't be recalled. The hold only binds the server: anyone holding
    the author token could still act on the PR directly.
  - Don't open PRs by hand on `agent/issue-*` branches. Only PRs carrying the server's
    marker are adopted; the item parks with `hand-opened PR on agent branch`. To continue,
    close that PR and add the retry label. The agent resumes the branch, so your commits on
    it go through review and can merge. To start fresh instead, delete the branch first.
- **For a private repository only:** a read token (`JM_GITHUB_READ_TOKEN`, Contents:
  read and Metadata: read) and `"reviewReadToken": true` on the zone, so review drops can
  clone. In M1 this token is global; per-zone read tokens arrive in M5.

## 1. CI hygiene on the test repository

Agent branches run the repository's workflows, so before you point Jumpmaster at a repo:

- Workflows on base expose **no secrets** to pull-request runs. Put any secret behind a
  GitHub environment with required reviewers.
- Settings → Actions → General → Workflow permissions: **Read repository contents**
  (the default `GITHUB_TOKEN` is read-only).
- `.github/**` is in the default `protectedPaths`, so an agent PR that edits a workflow
  parks instead of being reviewed or merged.

## 2. Branch ruleset on base

Classic branch protection cannot be read without admin rights, so M1 requires a
**ruleset** (Settings → Rules → Rulesets → New branch ruleset) targeting the default
branch:

- Enforcement status: **Active**.
- **Require a pull request before merging**, with at least **1** required approval and
  **Dismiss stale pull request approvals when new commits are pushed**.
- **Bypass list:** empty, or at least containing neither bot nor a team or role either
  bot belongs to.
- When the zone has `ciRequired: true` (the default): **Require status checks to pass**,
  with every check pinned to the app that reports it (choose the source, for example
  GitHub Actions, rather than "any source").

The server reads the ruleset through both bot tokens on every pass. If any rule is
missing, items park with `unsafe branch protection: …` naming what is wrong, before any
review or merge. Fix the ruleset and the next pass un-parks them on its own.

## 3. Config additions

Start from the M0 config. The zone gains these fields (defaults shown):

```json
{
  "id": "main",
  "repo": "your-org/your-test-repo",
  "readyLabel": "agent-ready",
  "gates": [{ "name": "test", "run": "npm test", "timeoutMinutes": 20 }],
  "image": "jumpmaster-trooper:dev",
  "mergeMethod": "squash",
  "ciRequired": true,
  "ciDeadlineMinutes": 45,
  "retryLabel": "agent-retry",
  "requireBranchProtection": true,
  "reviewReadToken": false,
  "budgets": {
    "maxHeal": 3,
    "maxResolve": 2,
    "maxResolveTotal": 6,
    "maxResume": 2,
    "maxReviewRepeat": 2,
    "maxNoChange": 1
  }
}
```

- `mergeMethod` accepts only `squash` in M1.
- Set `ciRequired: false` for a repository with no CI. The ruleset then needs no
  required checks. With `ciRequired: true`, only checks the ruleset names count: an
  unrelated green check (a CLA bot, a labeler) never stands in for CI, and an item with no
  named required check waits, then parks `no CI result`.
- `protectedPaths` defaults to CI and agent configuration (`.github/**`, `.claude/**`,
  `CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `GOAL.md`, `jumpmaster*.json`), git
  settings (`.gitattributes`, `.gitmodules`), package-manager settings, hooks and patches
  (`.npmrc`, `npm-shrinkwrap.json`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `pnpmfile.cjs`,
  `patches/**`, `.yarnrc`, `.yarnrc.yml`), installed code and package-manager state
  (`node_modules/**`, `**/node_modules/**`, `.pnp.*`, `.yarn/**`, `.pnpm-store/**`) and test-runner configs (`vitest.config.*`,
  `vite.config.*`, `jest.config.*`, `.mocharc*`, …); the full list is
  `DEFAULT_PROTECTED_PATHS` in `apps/server/src/config.ts`. Add paths; removing defaults is
  not recommended. A protected-path park is never overridden: a person merges such a PR.
- Gate scripts and gate tools are guarded too (spec §7.2). A PR that changes a script the
  gates run parks `gate script changed: …`; one that could swap or wrap a tool they run parks
  `gate tool changed: …`, listing every change. Tool changes include a non-registry dependency
  spec (`npm:`, `file:`, `link:`, git, URLs, `workspace:`, `catalog:`, `portal:`, `jsr:`),
  `overrides`/`resolutions`, any key of the `pnpm` field, `packageManager`/`devEngines`, runner
  config keys, a runner version change, and the lockfile. The lockfile is checked whenever one
  is in the PR, or a package.json's dependencies change (the first lockfile walking up from it):
  - npm (`package-lock.json`, `npm-shrinkwrap.json`): for a new or changed package, an install
    script, a `resolved` URL off the registry host (npm's, or one the base lockfile already
    uses), a link, and any version change of a package whose name or bin a gate runs.
  - pnpm (`pnpm-lock.yaml`, v6–v9): read with js-yaml, as pnpm reads it. A lone carriage return,
    tabs, comments, document markers, anchors, aliases, tags, merge keys and duplicate keys park
    `lockfile unreadable`. Every entry is compared in full. A changed entry, a resolution
    other than registry integrity, an aliased or linked dependency, and a change to `settings`,
    `overrides`, `patchedDependencies`, `pnpmfileChecksum` or `catalogs` are all reported. A
    new package is reported as `dependency added: … (verified: registry integrity only; install
    scripts may run)`.
- `trustPnpmBuildBlocking` (default `false`): set it only when the image really runs pnpm 10 or
  later (Corepack or a pinned install), since an older pnpm runs install scripts with only a
  warning. With it on and the root `package.json` pinning `packageManager: pnpm@10` or later, a
  new registry package passes, because pnpm 10 runs no install script unless allow-listed. A
  package that may build is still reported: one named in `onlyBuiltDependencies` or
  `allowBuilds`, or any package when `dangerouslyAllowAllBuilds` or an allow-list file is set,
  in `package.json`, `pnpm-workspace.yaml` or `.npmrc` (`dangerously-allow-all-builds`), at
  base or head.
  - yarn and bun lockfiles are not read: a dependency change parks `lockfile format not
    supported: <file>`. Anything the reader does not expect parks `lockfile unreadable`.
- `overrideApprovers` (default `[]`): to let a gate script or gate tool change through, a
  person with maintain or admin on the repository approves the PR on GitHub. Write access is
  not enough unless the login is listed here. The approval must be their latest decisive review
  and on the exact head commit: a later change request, a dismissal or any new push (a heal or
  resolve included) parks the PR again until they approve the new head. Bot logins never count.
  The next sync pass that sees a newer review re-decides the item (otherwise it is re-checked
  hourly), and the reviewer agent then reviews it as usual. This works only when the guard read
  everything it judged: a reason ending `(not fully read: merge it by hand)` names a file it
  could not read (unreadable, missing or unsupported), and no approval lifts it; a person
  reviews and merges that PR. **Starter mode** (the operator's own account is the
  token for both bots): the operator's login is a bot login, so their approval never counts.
  Another maintainer must approve, or Command allows the head (next item).
- **Allowing a gate change by Command ruling.** Where no one else can approve (starter mode, or
  any setup where the operator's account is the PR author, which GitHub won't let approve its own
  PR), the operator rules on the item's parked briefing instead. A gate park that is fully read
  is briefed with three options: `Retry`, `Leave parked` and `Allow these gate changes for
  <sha7>` (option id `allow-<head sha, 12 chars>-<digest, 8 chars>`). The briefing says "Read the PR diff at <sha7> on the forge before
  ruling": do that. Its text is the park reason followed by every reported change in full, at
  most 8,000 characters: each changed gate script as `name: "<old>" → "<new>"` (merge base →
  head), and tool changes with old → new versions where the guard knows them. Rule on
  `/briefings`, or `ctl rule <briefing> <option id> [note]` (the id is shown beside each option)
  over the operator-authenticated control route. While it is open, the briefing is refreshed
  when what it would say changes (a new head judged, a park that became or stopped being fully
  read); the Allow option's id changes with it, so a ruling from a page showing an older version
  is refused (`unknown option`): reload and read again. The ruling binds to the diff it showed:
  that PR, that exact head commit, the merge base it was judged against, and a digest of every
  change listed.
  When it is applied (the next pass), a briefing that no longer matches what the item is parked
  on records `briefing out of date`, and a head that has moved on the forge records `head moved`;
  either way nothing is allowed. If the PR can't be read, the ruling is tried again on later
  passes and gives up with `forge unavailable` after 10; a PR that is gone or closed records
  `pull request not open`. After a failed ruling the item is briefed again once a new head is
  judged; after `briefing out of date` it is briefed again on the next pass, on what it is
  parked on now. With the crew on, a parked briefing is diagnosed once: the diagnosis shows
  under the why on `/briefings` (and beside the ruling once ruled) and stays while the why is
  unchanged; when the why changes (another park reason, or a new head judged) the diagnosis is
  dropped and the briefing is diagnosed again. A moved merge base or a different change list on the same head
  is not covered by the allowance either. Otherwise the allowance is recorded (it
  survives restarts), the next sync re-decides the item and the reviewer agent reviews it as
  usual; the status page shows `gate change allowed by Command for <sha7>` on the item. Any new
  push (a heal or resolve included) is a new head with no allowance, so it parks again and is
  briefed again. Not offered, and not honoured, when the park reason's list is cut short
  (`… (+N more)`), when the full list does not fit the briefing, for a reason ending `(not fully
  read: merge it by hand)`, or for a `protected path:` park: those still need a maintainer's
  approval on the forge or a person to merge by hand. Crew briefings can't offer it: only the
  server defines effects.
- Budgets are per work item. When one runs out the item parks `budget exhausted: <key>`;
  the retry label resets them (see scenario 5).
- **Usage credits stop dispatch** (`usage.stopOnOverage`, default `true`; spec §12.2, never buy
  credits). When any drop reports running on usage credits (`isUsingOverage: true`, from a live
  event or its result), the gate becomes `stopped`: nothing leases, reviews, heals, resolves and
  crew drops included; running drops finish; queued drops wait. A result only backs up lost live
  events: for a drop already seen on credits it never starts a new stop. The stop survives
  restarts and allowed reports, and lifts by itself at the exhausted window's reset (a window at
  98% or more, else the reported limit's window, else five hours; at most seven days); the
  briefing says which and why. After it lifts, the gate is `probe`: one drop runs, and dispatch
  opens fully once a drop reports live that it runs in plan (`isUsingOverage: false`), or the
  probe drop's result says so, or the probe succeeds without being seen on credits. A failed or
  cancelled probe with no such report proves nothing: the next drop probes. A probe on credits
  stops again. The home page's **Usage** section shows `stopped: drop <id> ran on usage credits
  at <time>`, the probe, and the account's overage status. A
  `credits:stop:<drop id>` briefing (Waiting on you) offers **Run on credits now**, which buys
  credits for that drop's work item until the five-hour window resets when that is the exhausted
  window (the time is shown), otherwise for five hours; and **Noted**, after which the stop stays
  and the briefing is asked again on the next pass. During that horizon (gate `credits_resume`)
  only that work item's drops lease (its review, heal or resolve once queued); nothing else
  leases and no new implement work is queued, so the horizon idles until that work is queued. A
  Resume on a crew drop lets nothing lease. Another drop on credits stops dispatch again ("confirmed by a second drop"); the Usage
  section counts the drops on credits since. When the horizon ends, one drop probes as above.
  Rulings on credits briefings apply in any zone mode, but not while the kill switch is on: a Run
  on credits ruled while killed applies after unkill. Without the UI: `ctl briefings` lists the
  open briefings with their option ids, then `ctl rule <briefing> resume`. To turn the stop off,
  set `stopOnOverage: false` **and restart the server** (config is read once at start): nothing
  stops, a stop or probe already recorded no longer holds the gate, and a `credits:overage`
  briefing reports the drop instead. A drop that outlives its lease
  (a server outage longer than the lease) is marked lost; its later events and result are refused,
  so its credit use is never seen. Check the account after such an outage. A Fable drop on
  credits also disables Fable (`credits:fable`, ruled separately).

## 4. Start the server and the stick

As in M0, with one more secret. In bash or zsh:

```sh
read -rs JM_GITHUB_REVIEWER_TOKEN && export JM_GITHUB_REVIEWER_TOKEN
```

The stick runs only images on its allow-list, matched exactly (no prefix or tag
wildcards). With `JM_ALLOWED_IMAGES` unset it allows `JM_TROOPER_IMAGE` (if set) and
`jumpmaster-trooper:dev`. If the zone uses another image, list it:

```sh
export JM_ALLOWED_IMAGES=jumpmaster-trooper:dev
```

A drop whose image is not on the list fails with `image not allowed: <image>` and no
container starts.

Rebuild the trooper image: M1 changes it (two unprivileged users, hardened container).
Whenever you upgrade, build and deploy the trooper image before the server, or together with
it. A server that finds a result from an older trooper (one that sends no author report)
tells the reviewer so, and missing run-and-report evidence then counts as `minor`, so a
mixed rollout does not park every item.

```sh
docker build -t jumpmaster-trooper:dev -f images/trooper/Dockerfile .
```

Before the real run you can check the container without any token: `images/trooper/e2e/run.sh`
builds the image with a fake Claude CLI and runs one review drop against a public repository
under the stick's hardened options. It checks that the agent, gate and root identities are
separated, and that the token never appears in the output. It doesn't push, so only the real
run below covers the push path.

## 5. Scenarios

Create each issue in the test repository with the `agent-ready` label, then watch the
home page (`http://127.0.0.1:7420`). The new **Usage** section shows the dispatch gate;
the work-item table shows the PR, its head SHA, the latest verdict and attempts per
budget; the **Outbox** section lists any forge write that is `unknown` or `failed`.

To order work, mark an issue "blocked by" another in GitHub's issue sidebar. A ready issue
with an open blocker stays `ready` with "waiting on #N" and is never started or resumed until
every blocker closes. Work already in flight continues if a blocker is added later.

| # | Do | Expect |
|---|---|---|
| 1 | Happy path: an issue such as "add a `sum(a, b)` function with a test". | Implement → PR by the author bot → review drop → approval posted by the reviewer bot → CI green → merged by the server, no human click. Item `done`, reason `merged`. |
| 2 | An issue whose first review should request changes, for example "add `parse(n)`" where the review asks to "also handle non-number inputs with a TypeError". | The reviewer bot posts REQUEST_CHANGES; a heal drop pushes onto the same branch; a new review runs on the new head; then merge. |
| 3 | While a PR from scenario 1 or 2 is open, push any commit to base yourself. | A resolve drop merges base into the branch. A clean merge is free (no `resolve` attempt is charged); the new head is re-reviewed, then merged. |
| 4 | Close an issue while its PR is open. Then reopen it. | The item parks `issue closed`, with no merge call. After reopening, the next pass returns it to `pr_open` and re-decides it. |
| 5 | Park an item (for example scenario 6), then add the `agent-retry` label to its issue. | Attempts reset once, the item returns to `pr_open` (or resumes the branch if the PR was closed). Leaving the label on does not reset again; remove and re-add it to retry again. |
| 6 | An issue that asks the agent to edit a file under `.github/`. | The push is refused in the trooper (`protected path …`), or, if such a change reaches a PR, the item parks `protected path: .github/…` before any review. |

### Acceptance criteria and waivers

The implement and heal agents end with a report: each acceptance criterion in the issue, how
it is met, and the evidence (commands run and their results). The reviewer sees the last three
reports, each labelled with the head it produced, next to the gate results. It checks every
criterion: one that is not met, or not shown to be met, is `major`, so the PR is sent back. A
criterion the issue marks `(manual)` is `minor`: a person checks it, and it does not block the
merge.

A criterion the agents cannot meet in this environment (for example one that needs a real
browser or a device) ends in a park: the heal returns `BLOCKED`, or makes no changes twice for
the same findings (`heal made no changes for the same findings`). To waive it:

1. Edit the issue and add `(manual)` to that criterion.
2. Add the `agent-retry` label.

The retry label clears the stored request-changes on the PR's current head, so the next pass
reviews that same head again against the edited issue. There is no override that approves a PR
by hand.

- `(manual)` takes effect only together with the retry label, which only a maintainer can add.
  Anyone who can edit the issue can add the token, so check the issue's edit history before you
  add the label.
- A standing request-changes from a human reviewer still blocks the PR: dismiss it first. On the
  current head it sends the PR back to a heal; on an older commit the item parks
  `human block stands` after the fresh review.
- A retry on a head that carries a request-changes costs one fresh review (charged to the
  review budget) before any further heal.

## 6. Pass criteria

- **Scenario 1:** the merge commit on base has the PR title as its subject and
  `Closes #N` as its body, with no other trailers. The issue is closed by GitHub.
- **Scenario 2:** the PR shows exactly one REQUEST_CHANGES and one APPROVE from the
  reviewer bot, each on a different commit, and the merged SHA is the approved one.
- **Scenario 3:** the item's attempts show no `resolve` charge for the clean resolve.
- **Scenario 4:** the item is `parked` / `issue closed` while closed and `pr_open` after
  reopening; the server made no merge call meanwhile.
- **Scenario 5:** after the label, the attempts column is empty and the item left
  `parked`.
- **Scenario 6:** no commit touching `.github/` exists on the agent branch, or the item is
  parked with the protected path named.
- **Every scenario:** no item is stuck `in_flight` once its drop finished; the Outbox
  section is empty at the end.
- **Secrets (repeat the M0 check, now for both bot tokens):** search the home page, every
  drop page, the database (`data/`) and every PR body and review for each token value
  and its base64 form. None may appear. The reviewer token never leaves the server: it is
  not in any drop payload and never reaches a stick.

## Cleanup

Revoke all fine-grained tokens and remove the reviewer bot's collaborator access when
you are done. Then run `unset JM_CLAUDE_TOKEN JM_GITHUB_AUTHOR_TOKEN
JM_GITHUB_REVIEWER_TOKEN JM_GITHUB_READ_TOKEN JM_JOIN_TOKEN JM_OPERATOR_TOKEN`.

## Security notes

- The trooper container drops all capabilities except `SETUID`, `SETGID` and `KILL`, sets
  `no-new-privileges`, caps processes at 512 and disables core dumps. No binary in the
  image keeps a setuid or setgid bit.
- Claude and its tools run as the agent uid (10001); gates run as a separate gate uid
  (10002) in their own clone, so gate commands cannot read the agent's Claude
  credentials. The trooper stays root as PID 1 and runs git only in root-owned bare
  mirrors, never inside the agent's tree; root cannot read the agent's private files.
- Every push is checked in a root-owned repository against the base from the server-side
  mirror: protected paths (including rename sources) and commit identity (only the
  commits this push adds must be Jumpmaster Agent's).
- The reviewer token never leaves the server. Reviews and merges are posted by the
  server through the outbox, bound to the head SHA the review saw.
- **Residual risk:** Claude's own tool calls run repository code as the agent uid, which
  can reach the Claude token. A malicious repository can therefore exfiltrate that token
  until the credential proxy (spec §7.2) lands. Point M1 only at repositories you trust.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Server exits: `JM_GITHUB_REVIEWER_TOKEN must differ from JM_GITHUB_AUTHOR_TOKEN` | Create the reviewer PAT from the second bot account. |
| Items park `unsafe branch protection: …` | Fix the ruleset as the reason says (section 2); the next pass un-parks them. |
| Items park `no CI result: missing <check>` | The ruleset requires a check that never reported on the head. Check the workflow runs on pull requests. |
| Items park `unsupported rule: merge_queue` (or `required_deployments`) | The server merges through the API, which a merge queue or required deployment never allows. Remove that rule from the ruleset for the agent's base branch. |
| Items park `merge rejected: …` | GitHub refused the merge on an unchanged head, often because of an unresolved conversation or a dismissed approval. Clear the cause; the server retries the merge about an hour after the refusal, or at once if you add the retry label. |
| Items park `heal made no changes for the same findings` | Two heals in a row found nothing to change for the same review findings. Either a finding cannot be met here (waive it: mark the criterion `(manual)` in the issue, then add the retry label) or the review is wrong (fix the issue text, then add the retry label). |
| Items park `budget exhausted: heal` after gate timeouts | A gate that times out or flakes forces "request changes", and each heal that finds nothing to fix spends the heal budget. Raise the gate's `timeoutMinutes` or fix the flaky test, then add the retry label. |
| Items park `gate tool changed: …` or `gate script changed: …` | The PR changes what the gates run. Read the listed changes; if they are fine, approve the PR's current head as a maintainer (section 3, `overrideApprovers`), or rule `Allow these gate changes for <sha7>` on the item's parked briefing, and the next pass un-parks it. Otherwise close the PR or ask for a different change. |
| Items park `gate tool changed: dependency added: …` on every dependency change in a pnpm project | Pin pnpm 10 or later in the root `package.json` (`"packageManager": "pnpm@10.x.y"`), make the image run that version, and set `trustPnpmBuildBlocking: true`; new registry packages then pass unless allowed to build. |
| Items park `gate tool changed: lockfile unreadable` or `lockfile format not supported: …` | The lockfile could not be read (yarn, bun, a pnpm lockfile older than v6, or an unexpected layout). No approval lifts this park. Review the dependency change yourself and merge the PR by hand, or close it. |
| Items park `no pipeline` | `ciRequired` is true but nothing reported. Add CI or set `ciRequired: false`. |
| A drop fails `image not allowed: …` | Add the zone's image to `JM_ALLOWED_IMAGES` on the stick, spelled exactly. |
| Usage shows gate `closed` | A drop hit a usage limit. Dispatch resumes after the reset time, at most one hour after an unconfirmed limit. |
| Usage shows gate `stopped` | A drop ran on usage credits (section 3, "Usage credits stop dispatch"). Wait for the time shown, or rule **Run on credits now** on its briefing (`ctl briefings`, then `ctl rule <id> resume`). |
| Usage shows gate `probe` after a credits stop | One drop runs until a drop reports live that it runs in plan, or the probe's result says it ran in plan, or the probe succeeds without using credits; then dispatch opens fully. A failed probe with no report hands the slot to the next drop. |
