# Runbook: M1 loop

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
  and npm settings (`.gitattributes`, `.gitmodules`, `.npmrc`) and test-runner configs
  (`vitest.config.*`, `vite.config.*`, `jest.config.*`, `.mocharc*`, …); the full list is
  `DEFAULT_PROTECTED_PATHS` in `apps/server/src/config.ts`. Add paths; removing defaults is
  not recommended.
- Budgets are per work item. When one runs out the item parks `budget exhausted: <key>`;
  the retry label resets them (see scenario 5).

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
| Items park `no pipeline` | `ciRequired` is true but nothing reported. Add CI or set `ciRequired: false`. |
| A drop fails `image not allowed: …` | Add the zone's image to `JM_ALLOWED_IMAGES` on the stick, spelled exactly. |
| Usage shows gate `closed` | A drop hit a usage limit. Dispatch resumes after the reset time, at most one hour after an unconfirmed limit. |
