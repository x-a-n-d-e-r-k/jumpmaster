# GitHub App authentication — design proposal

*Status: proposal, not decided · 2026-11-13 · red-teamed five times (§12) · extends §7.3 of the
[design](2026-10-19-jumpmaster-design.md)*

Markers as in the design: **[call]** is the designer's choice for the owner to confirm or
overturn. GitHub facts carry a citation and one of **confirmed** (GitHub's docs say it),
**inferred** (follows from the docs or GitHub's behaviour, not stated), or **unknown** (the docs
are silent; the spike in Task 1 settles it).

## 1. Problem

GitHub has no API to create a personal access token. Today an operator makes up to three
fine-grained tokens by hand (author, reviewer, read), each on a pre-filled template link
(`apps/server/src/github/guidance.ts`, `patTemplateUrl`) that still can't choose the repository,
may not pre-fill the resource owner, and expires in at most 366 days. The owner's dry run on
2026-11-13 found this tedious and error-prone. Two more costs follow from PATs:

- On a repository owned by a **personal account**, a fine-grained token can't serve a
  collaborator bot, so the wizard recommends **starter mode** with the owner's own account as
  author (`authorMayBeAdmin`). That token then sits in implement, heal and resolve drops, under an
  admin account.
- The author token handed to drops lives up to 90 days, can't be revoked by Jumpmaster (the kill
  switch's known gap since M2), and carries Pull requests and Issues write, though the trooper only
  uses git (`apps/trooper/src/roles/implement.ts`: clone, fetch, push); the server opens, labels,
  reviews and merges through the outbox.

## 2. Recommendation

Replace the GitHub PATs, **in two-bot mode**, with **two GitHub Apps per repository owner (a
personal account or an organization), registered from a manifest** in one click each, and
**installation access tokens minted per repository and per use** by a credential broker in the
server [call]. **Starter mode stays on PATs, as today** [owner decision, 2026-11-13].

1. **Author app** and **reviewer app**, each registered from the setup wizard through GitHub's
   manifest flow, under the account that owns the zone's repository: a personal account or an
   organization, both supported. An install whose zones span several owners has one pair per owner
   (§4.1). Jumpmaster stores each app's id, slug and private key in the vault, keyed by owner
   (§4.4). No token is ever made or pasted by hand.
2. The operator **installs** each app on its owner's repositories, on **All repositories** or
   **Only select repositories**, whichever they prefer; both are supported. Every token is still
   narrowed to one repository when it is minted (item 3).
3. The broker mints **one-hour installation tokens narrowed to one repository and to the
   permissions the use needs**. **No write token enters a drop**: a drop gets a `contents: read`
   token for its own repository at its start, and its branch is pushed by a separate, agent-free
   **push container** with a write token the stick asks the server for (§4.2) [owner decision].
4. **PATs keep working** as a second credential kind per role. Existing installs migrate role by
   role from Settings, Credentials.
5. **Order of work** [owner decision, 2026-11-13]: first a **spike run by hand by the owner** on a
   personal-account repository and an organization repository (Task 1), whose first two questions
   decide whether apps deliver anything for a personal repository; then the **push container,
   landed and proven on PAT mode** (it rewires push, checkpoint and resume for every install);
   **apps last**, in **M5** (§10), which already brings per-zone forge credentials.

**What it depends on.** Two GitHub behaviours that GitHub's docs don't settle: whether an app's
approval counts toward a ruleset's required approvals (F12/F13), and whether the merge-restriction
ruleset works, including whether an app can be a bypass actor on a personal repository (F23). **If
either fails, a personal repository stays on PAT starter mode**: no change from today, where the
wizard already recommends starter mode for personal accounts (`apps/server/src/github/guidance.ts:206`).
That is the case the owner's dry run was on, which is why the spike comes first.

What it buys, if both hold: zero tokens to make for GitHub in two-bot mode; two-bot mode on
personal repositories (no more owner-as-author starter mode by necessity); no write token in any
container an agent ran in, and the agent's read token lives at most an hour and reaches one
repository; and no expiry to renew. Jumpmaster's own merges are unaffected: the author app merges
from the server once the review and checks pass, with no person involved (§5.1 says per mode what
that rests on).

What it costs on a **team repository**: the token-free route changes who can merge to the default
branch. `jumpmaster-merge` (§5.2) stops everyone with plain write access from merging there. The
two ways out are adding the write role to that ruleset's bypass list, which re-opens the hole the
ruleset closes, or the hybrid, which is a machine account plus a hand-made token again.

## 3. GitHub facts this rests on

| # | Fact | Status | Source |
|---|---|---|---|
| F1 | A manifest is POSTed (form field `manifest`, JSON) to `https://github.com/settings/apps/new` for a personal account or `https://github.com/organizations/ORGANIZATION/settings/apps/new` for an organization, with an optional `state` "to protect against cross-site request forgery". The person can edit the app's name before creating it. | confirmed | [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) |
| F2 | GitHub redirects to the manifest's `redirect_url` with `code`; `POST /app-manifests/{code}/conversions` returns the app's `id`, `slug`, `owner`, `permissions`, `client_id`, `client_secret`, `pem` (private key) and `webhook_secret`; "You must complete all three steps … within one hour"; the endpoint is rate limited. Whether a `code` is single-use is not stated. | confirmed (fields, hour); unknown (single use); spike | same page; [Create a GitHub App from a manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest) |
| F3 | The conversion needs no authentication. | inferred (the page shows none) | same page |
| F4 | Manifest fields: `name`, `url` (required), `hook_attributes` (`url` required inside it, `active` defaults to true), `redirect_url`, `callback_urls`, `setup_url`, `setup_on_update`, `description`, `public`, `default_events`, `default_permissions`, `request_oauth_on_install`. | confirmed | same page |
| F5 | `redirect_url` may be a `localhost` or private address, because GitHub only redirects the browser there. | unknown (Probot's manifest flow does this, which suggests yes) | spike |
| F5b | A manifest with `hook_attributes` omitted, or with a non-public hook `url` and `active: false`, is accepted. | unknown | spike |
| F6 | An installation token "will expire after 1 hour"; the request may narrow it with `repositories` or `repository_ids` (up to 500) and a `permissions` subset; it can't exceed what the installation was granted. | confirmed | [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| F6b | `DELETE /installation/token` revokes an installation token, and needs that token to call it. Whether it still revokes the stateless tokens of F21 is not stated. | confirmed (endpoint); unknown (stateless tokens); spike | [Endpoints available for installation access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| F7 | The app JWT is RS256, `exp` "no more than 10 minutes into the future", `iat` recommended 60 seconds in the past against clock drift; `iss` is the client id or app id. | confirmed | [Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) |
| F8 | Git over HTTPS takes the token as the password (`x-access-token:TOKEN`) with `contents` permission; editing files in `.github/workflows` needs the separate **Workflows** permission. | confirmed | [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) |
| F9 | When the app's permissions change, each installation's owner "will be prompted to approve the new permissions", and until they do the installation keeps the old ones. | confirmed | same page |
| F10 | "The success of an API request with an installation access token only depends on the app's permissions" (not on a collaborator role). | confirmed | same page |
| F11 | An app owned by a personal account can be installed on that account, on "All repositories" or "Only select repositories". | confirmed | [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) |
| F12 | A ruleset's pull request rule counts approving reviews from those with write access; the docs never say whether an **app's** APPROVE review counts, nor what "write access" means for an app (its `contents: write` grant is the likely reading). | **unknown** (apps) | [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets); [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| F13 | Community answers disagree: one says a dedicated app's reviews "will count toward merge requirements", another that GitHub "only counts real user" approvals. Whether a `github-actions[bot]` approval counts on a path with no code owner is not stated either. | unknown | [community discussion 181487](https://github.com/orgs/community/discussions/181487); spike |
| F14 | Code owners are "individuals or teams" that "must have write permissions", with "explicit write access". An app is neither, so it **can't be a code owner**. That a path with no owner accepts the approval of anyone with write access rests on an example comment in the docs, not a stated rule. | confirmed (who may be one); inferred (apps excluded; unowned paths); spike | [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| F15 | An author can't approve their own pull request, and this holds for an app's bot. | inferred; spike | — |
| F16 | Installation rate limit: at least 5,000 requests per hour, plus 50 per repository over 20 and per org user over 20, at most 12,500 (15,000 on Enterprise Cloud). A PAT's limit belongs to its user account, shared by all that account's tokens. | confirmed | [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| F17 | Ruleset bypass actors include `Integration` (an app). A caller without admin rights may not see `bypass_actors`, but gets `current_user_can_bypass`; whether an installation token gets that field is not stated. | confirmed (actor type); inferred (visibility); unknown (installation tokens); spike | [REST API endpoints for rules](https://docs.github.com/en/rest/repos/rules); [changelog 2023-06-27](https://github.blog/changelog/2023-06-27-repository-rules-public-beta-updates/) |
| F18 | `GET /user` is not available to an installation token. The bot's login is `<slug>[bot]`, so renaming the app changes it. | confirmed (endpoint); inferred (login string); spike | [Endpoints available for installation access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| F19 | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` needs **Contents: write** for an app. | confirmed | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) |
| F20 | A private app "can only be installed on the account that owns the app", personal or organization; a public app can be installed by "any user on GitHub", and has a landing page with an Install button. | confirmed | [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private) |
| F21 | Since a rollout that began on 2026-04-27 and finished by 2026-10-02, installation tokens are stateless, `ghs_APPID_JWT`, about 520 characters instead of 40; redaction rules written for the old pattern miss them. GitHub's suggested pattern is `ghs_[A-Za-z0-9.\-_]{36,}`. | confirmed | [changelog 2026-04-24](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/); [changelog 2026-10-02](https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/) |
| F22 | `PUT /app/installations/{installation_id}/suspended`, called with the app JWT, suspends an installation; `DELETE` on the same path unsuspends it. Whether suspension invalidates tokens already minted is not stated. | confirmed (endpoint); unknown (live tokens); spike | [REST API endpoints for GitHub Apps](https://docs.github.com/en/rest/apps/apps#suspend-an-app-installation) |
| F23 | Rulesets on the same branch are aggregated and "all rules apply"; bypass is granted per ruleset ("bypass the rules in the ruleset"). **Restrict updates**: "only users with bypass permissions can push to" matching branches. Whether merging a pull request counts as such a push, and whether a bypass in one ruleset leaves another ruleset's rules in force, are not stated outright. | confirmed (aggregation, rule); inferred (merge is a push; per-ruleset bypass); spike | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets); [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) |
| F24 | A repository's Actions settings (default `GITHUB_TOKEN` permissions, and "Allow GitHub Actions to create and approve pull requests") are read by `GET /repos/{o}/{r}/actions/permissions/workflow`, which needs administration rights. | inferred; spike | [REST API endpoints for GitHub Actions permissions](https://docs.github.com/en/rest/actions/permissions) |

F12, F13, F15 and F23 decide the two-identity model (§5). F5 and F5b decide whether a private
install can use the one-click flow at all (§4.1).

## 4. Design

### 4.1 Registering the apps (manifest flow)

The wizard's GitHub step, for a two-bot zone, replaces the token links with **Create the author
app** and **Create the reviewer app**. Each is an HTML form that POSTs to F1's URL for the owner
chosen below: the personal URL or the organization's.

```json
{
  "name": "Jumpmaster author (<install-id>)",
  "url": "https://github.com/<jumpmaster-public-repo>",
  "description": "Pushes agent branches and opens, labels and merges pull requests for one Jumpmaster install.",
  "redirect_url": "<jumpmaster-base>/setup/github-app/callback",
  "setup_url": "<jumpmaster-base>/setup/github-app/installed",
  "setup_on_update": true,
  "public": false,
  "default_events": [],
  "default_permissions": {
    "contents": "write", "pull_requests": "write", "issues": "write",
    "metadata": "read", "statuses": "read", "checks": "read", "actions": "read"
  }
}
```

The author's set is today's author PAT's, plus `checks: read`. The reviewer manifest asks
`pull_requests: write`, `contents: read`, `metadata: read`, unless the spike finds an app approval
counts only with `contents: write`; then the reviewer app is granted that at install, and every
reviewer token is still narrowed (`pull_requests: write` on the server, `contents: read` in drops),
so the install grant is broader than any token. Neither manifest ever asks `administration` or
`workflows`; the server refuses to render one that does, as `patTemplateUrl` refuses today.
`hook_attributes` is omitted (Jumpmaster polls); if GitHub requires it (F5b), it points at the
project's public repository URL with `active: false`, never at the install. App names are unique
across GitHub, so the name carries a short install id; the operator may edit it.

- **State.** The server mints a single-use `state` bound to the logged-in operator session, the
  owner and the role, kept ten minutes.
- **Callback: redeem at once, confirm with the cookie.** The session cookie is `SameSite=Strict`
  (`apps/server/src/auth/sessions.ts`), so the redirect from github.com arrives without it. The
  callback `GET /setup/github-app/callback?code&state` checks and consumes the `state`, then calls
  `POST /app-manifests/{code}/conversions` (F2) **immediately**, so the `code` is spent before it
  can be replayed (and the spike checks whether GitHub refuses a second redemption). The `code` and
  `state` query parameters are scrubbed from the server's request logs. The result is held as a
  *pending* app bound to the state's session; the page then shows a same-origin **Finish** form
  whose POST carries the cookie and passes the Origin check, and only that POST writes the vault
  entry. A pending app not confirmed within ten minutes is discarded, and the wizard tells the
  operator to delete it on GitHub. The cookie stays Strict. `setup_url` works the same way. Then the
  page links the app's install page (`https://github.com/apps/<slug>/installations/new`).
- **Conversion response.** The server checks that `owner.login` is the owner it asked for and that
  `permissions` equal the manifest's, and rejects the app otherwise (telling the operator to delete
  it). It keeps `id`, `slug`, `client_id` and `pem`; `client_secret` and `webhook_secret` are dropped
  at once, and both are added to the scrub set for the request's lifetime so an error path can't log
  them.
- **Plain HTTP.** On a base URL that is neither HTTPS nor `localhost`, the `code` crosses the
  network in clear text on its way back. Redeeming it at once shrinks that window to the
  redirect itself; the wizard also warns, naming HTTPS as the fix.
- **Reachability.** Only the operator's browser follows the redirect; the server makes outbound
  calls only, as today. If F5 fails, the fallback is the same flow with a manual last step: the
  operator pastes the URL the browser failed to load (it carries the code) into the wizard. That is
  no token to make, but it is one paste. If F5b fails with no public placeholder accepted, the
  manifest flow is out and the design falls back to PATs; the spike is the gate.
- **Which owner.** The app is registered under the account that owns the zone's repository. The
  wizard reads the owner's type from the repository URL the operator already entered (an
  unauthenticated `GET /users/{owner}` gives `User` or `Organization`) and preselects it, showing
  both choices: **My personal account** (`https://github.com/settings/apps/new`) or **The
  organization `<org>`** (`https://github.com/organizations/<org>/settings/apps/new`). The operator
  can override it, for instance to register on their own account and test before an org owner
  repeats it; the doctor's install check (§6) then says plainly if the app can't reach the zone.
- **Organizations.** Registering an app under an organization needs an owner or app manager of
  that organization; installing it on the organization's repositories needs an owner, or an
  owner's approval of a member's request. The wizard says so where it says today that an
  organization may have to approve each fine-grained token.
- **Zones under several owners: one app pair per owner** [call]. A private app installs only on
  the account that owns it (F20; the spike confirms GitHub refuses otherwise), so one private pair
  can't serve both a personal account and an organization. The alternative, one **public** pair
  installed on each, is rejected: a public app has an install page anyone on GitHub can use, so
  Jumpmaster would have to treat every unknown installation as hostile; and an organization's
  repositories would then hang on an app, and a private key, that belongs to someone's personal
  account, which the organization's owners can't manage, rotate or remove when that person leaves.
  One pair per owner keeps each app private, lets each owner's admins manage their own, and bounds
  a leaked key to one owner's installation. The cost is one more create-and-install per extra
  owner, which the wizard offers when a zone's repository has an owner with no app yet.
  `public: false` is therefore a kept restriction (§8).

### 4.2 Installing, the broker and drops

- **Installation.** The `setup_url` redirect carries `installation_id`, but the server never trusts
  it: it calls `GET /repos/{owner}/{repo}/installation` with the app JWT (F7), which answers exactly
  whether this repository is covered, by which installation and with which permissions; a 404 is
  the doctor's "not installed on this repository". Each zone records `{ installationId,
  repositoryId }` as config (not secret).
- **Broker.** A module in the server, `forge/github-app.ts`, holds the keys and mints
  `POST /app/installations/{id}/access_tokens` (F6) with `repository_ids: [zone repo]` and a
  `permissions` subset per use:

| Use | App | Permissions in the token | Lifetime |
|---|---|---|---|
| Server: issues, labels, PR open, merge, status and check reads | author | the author manifest's set | cached, re-minted under ten minutes left |
| Server: review posting, dismissing reviews | reviewer | `pull_requests: write` | cached |
| Implement, heal and resolve **agent containers** (fetch at start) | author | `contents: read` | **per drop**, minted at lease, never shared, revoked at drop end |
| **Push containers** (below), asked for by the stick | author | `contents: write` | per push, minted on the stick's request, revoked when the push result arrives |
| Review, crew and doctor drops on a private repository | reviewer | `contents: read` | per drop, revoked at drop end |

- **Why the push can't stay in the agent's container.** A drop's payload goes in once on stdin
  and the stick closes it (`StdinOnce: true`, `stream.end(o.payload)` in
  `apps/stick/src/docker.ts`); the trooper only writes events to stdout. A token minted at lease
  time can never be replaced inside a running drop, and an implement drop, with an agent run and
  gates of up to 20 minutes each (`GateSpecSchema` in `packages/protocol/src/index.ts`), routinely
  outlives an hour before it pushes. The trooper's own use of the forge is already front-loaded:
  `mirrorFetch` and `remoteBranchSha` run before the agent starts, the working clone fetches from
  the local root mirror (`file://`), and only the push reaches GitHub at the end
  (`apps/trooper/src/git.ts`).
- **The push container** [owner decision, 2026-11-13]. When the agent's container exits with work
  to push, the stick starts a **second, agent-free trooper container** on the agent's working copy
  and, once it reports ready, gives it a fresh `contents: write` token that the stick asked the
  server for. It runs `guardedPush`, adapted (it no longer uses a mirror, below): the agent-side
  fetch into a fresh root-owned push directory, the base fetched from GitHub into that directory,
  `prePushCheck` (protected paths, secrets in added lines and messages, commit identities), the
  `expectSha` check against the gated commit, and the `--force-with-lease` push. Properties:
  - **No write token ever sits in a container an agent ran in.** The agent container holds a
    `contents: read` token, used at its start (a minted one has the hour it needs).
  - **No channel into a container an agent ran in.** The one-hour refresh is the stick's request
    to the server on the stick's existing authenticated connection, made when the token is needed.
  - **One push path for PAT and app modes.** In PAT mode the server answers the same request with
    the author PAT; the agent container then fetches with `githubReadToken` where one is
    configured, and with the author PAT where none is, as today.
  - **No `git` in the server image, and no new size limit**: the push is the trooper's, bounded by
    today's `PUSH_FETCH_MAX_BYTES` (1 GiB) and fetch timeout.
  - **What it gives up**: the earlier draft's second, server-side check of the pushed diff. The
    trooper's `prePushCheck` stays the single pre-push check; the server's own protected-path check
    still runs on the PR's file list from the forge before any merge (`protectedPathHits` in
    `apps/server/src/flow/snapshot.ts:603`, parking in `flow/decide.ts:234`). (`results.ts:269`
    uses the same matcher, but to pick which verification artifacts a PR needs.)
- **One volume: the agent's working copy, never the mirror.** Trooper containers today have no
  mounts and run with `AutoRemove: true` (`apps/stick/src/docker.ts:498-512`); the root mirror
  (under `JM_WORK_ROOT=/work`) and the working copy (`/home/agent/repo`) vanish with the container,
  and the trooper also deletes both on exit (`apps/trooper/src/main.ts:105-110`). The push
  container gets **one** per-drop volume, at `/home/agent/repo`, and nothing else from the agent's
  container [call]. The mirror is not carried over: `guardedPush` runs root's git, with the token,
  in `mirrorDir` (`mirrorFetch` at `apps/trooper/src/git.ts:680`), whose `config` and other files
  were written in the agent's container; `assertRootOwnedDir` checks directories, not files, so if
  the agent ever got root there, a planted mirror config could redirect the base fetch (defeating
  `prePushCheck`) and planted alternates might reach `core.alternateRefsCommand` beside the token.
  The push container therefore builds its push directory in its own filesystem and fetches the
  base from GitHub straight into it as `refs/jm/base`, at the cost of one base fetch per push. This
  also removes the question of the trooper's random `/work/trooper-XXXX` path. Details:
  - **Naming.** `jm-drop-<dropId>-<epoch>-<nonce>`, labelled with the stick id, drop id and epoch.
    Docker's volume create returns an existing volume of the same name, and a re-leased drop gets
    `epoch + 1` (`apps/server/src/leases.ts:144`), so the stick inspects first and refuses to lease
    the drop if a volume of that name exists.
  - **Ownership.** `/home/agent/repo` isn't in the image (`images/trooper/Dockerfile:44-51`), Docker
    copies ownership from the first container to mount an empty volume (the agent container, on the
    zone's stack image), and root in the trooper has no `CHOWN`. So the stick initialises each new
    volume with a one-shot container from the **base trooper image**, no network, `CapAdd: CHOWN`
    only, which creates the directory owned by the agent (uid 10001, mode 0700) and exits. The base
    image also gains the directory. The doctor's new `stick.volumes` check creates, initialises,
    inspects and removes a test volume on each stick.
  - **The trooper keeps the working copy when a push is requested**: its `finally` cleanup skips
    the agent's `repo` in that case and still removes `/work`.
  - **Nothing secret is written there.** The payload's tokens stay on stdin and in process
    environments (`docker.ts:544`), and the working copy holds only the repository.
  - **Removal** after a successful push, a terminal result, or the end of the retention window
    (below). The stick's ten-minute sweep (`apps/stick/src/main.ts:18`) and its startup reap
    (`reapOrphans`) count pending pushes as live and remove only volumes no live or pending drop of
    this stick holds.
  - Copying the files out with Docker's archive API instead (keeping the stopped container) was
    weighed: it streams up to a gigabyte through the stick and relies on Docker's tar extraction of
    agent-written content; one volume avoids both.
- **Nothing the agent left can run beside the token.** Kept from `guardedPush`: root's git never
  runs in the agent's repository; it works only in its own bare `pushDir` (`GIT_DIR` set,
  `assertRootOwnedDir`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`,
  `core.hooksPath=/dev/null`, a fixed `config` written before and again after the agent fetch,
  `hooks` removed), and reads the agent's repository only through `--upload-pack` run **as the
  agent's uid**. Repository settings such as `core.fsmonitor`, filters, `core.sshCommand` and
  `includeIf` are read only by that agent-uid process, and none applies to `upload-pack` over
  `file://`. Symlinks, a `.git` file, alternates and setuid tricks in the working copy reach only
  that agent-uid process: it can read nothing the agent couldn't. The push container's own PID
  namespace makes the sweep complete: `sweep` (`kill(-1, SIGKILL)`, `sweepProcesses`) kills every
  process but the trooper. The push container tightens it:
  - **The token arrives last.** The stick starts the push container with a payload that holds no
    token; the trooper runs the agent-side fetch, sweeps, checks that no agent-uid process
    survives, and only then writes *ready* on stdout. The stick then asks the server for the token
    and writes it as one more line on the push container's stdin, which it holds open for exactly
    that line and then closes. So no agent-uid process is alive when the token exists in the
    container.
  - **`upload-pack` hardened**: invoked with `-c core.fsmonitor=false -c core.hooksPath=/dev/null`
    on its command line (which outranks the repository's config) and `GIT_NO_LAZY_FETCH=1`, so a
    planted partial-clone promisor can't make it fetch. The image's git must honour that variable
    (upstream 2.45.1, backported to the 2.39.4 maintenance line; the bookworm image's `git` is
    checked by a test that a lazy fetch is refused).
  - **The base trooper image only**, pinned by the stick's release, never the zone's stack image,
    so no project tooling is present; no agent CLI is started.
  - **Its own egress session**: the same resource limits, `CapDrop` and `no-new-privileges`, and,
    under egress, its own network and proxy that allow only the forge's host.
  - **The agent container is gone first**: the stick confirms the agent container has been
    removed, not only that its result arrived, before it starts the push container. This matters
    most for checkpoints, which have no `expectSha` to pin what is pushed.
- **The push is the server's record, not the stick's.** The agent container's trooper reports
  *push requested* (final, with the gated `expectSha`, or checkpoint), and the stick posts that as
  the drop's result **before** anything else. The server stores the drop in a new state,
  **`push_pending`**, with the kind and `expectSha`, and releases the usage probe if this drop was
  it (a pending probe would otherwise stall dispatch, `leases.ts:89`): the agent run the probe
  measures is over. A `push_pending` drop has no lease to expire (`expireLeases` covers only
  `leased` and `running`, `leases.ts:216-244`); it has a retention deadline instead (below).
- **The token request.** A new stick route, `POST /api/sticks/push-token { dropId, epoch }`. It
  authenticates as the other drop routes do (`apps/server/src/api/sticks.ts:124-146`: the stick's
  bearer token, stored hashed, and the drop belonging to that stick at that epoch), but accepts a
  drop in `push_pending` rather than requiring a live lease. The server refuses unless the drop's
  role pushes (implement, heal, resolve), the kill switch is off, the zone is `active` (not `paused`
  or `observe`), and the zone's repository is the drop's. It **reserves** the drop's one push token
  in the database (a row inserted in the same transaction as the checks) before the asynchronous
  mint, so two concurrent requests can't both mint; it mints with `repository_ids: [the zone's
  repository]` and `permissions: { contents: write }` (the PAT in PAT mode), records the token for
  revocation, audits the mint, and revokes it when the stick posts the push result. The
  **response carries every push parameter**: the token, branch, base, lease, `expectSha` (or none
  for a checkpoint), protected paths and the secrets to sweep for. The server names them; the stick
  persists none of them on the host (the secrets list must not land on disk). A compromised stick
  can therefore mint only for drops it holds, one repository each, and only after their agent run.
- **Leases on the remote branch.** The push gets the lease the agent container would have used:
  none for a new branch, `resumeSha` for a resumed one, and `payload.pr.headSha` for heal and
  resolve (`apps/trooper/src/roles/heal.ts:44`, `resolve.ts:49`), so a branch someone else moved is
  never overwritten. A retry that finds the remote branch already at `expectSha` (or, for a
  checkpoint, at the working copy's head) is a **success**: the earlier push landed and only its
  result was lost.
- **Checkpoints.** A stopped or rate-limited agent commits a checkpoint and pushes it without
  gates or `expectSha` (`checkpoint` in `roles/shared.ts:392-404`, called from `implement.ts:116`),
  and the `interrupted` and `rate_limited` results carry that `headSha` to the replacement drop
  (`apps/server/src/results.ts:158-171`, `:231`), whose `checkoutBranch(resumeSha)` needs the branch
  on GitHub. Now the agent container commits the checkpoint and reports *push requested,
  checkpoint*; the stick runs a push container for it as for a final push, and the server records
  the pushed SHA as the result's `headSha` before it creates the replacement. Each checkpoint is one
  push container, and a resumed drop still finds its branch.
- **Stopping an agent container.** The lost-server rule today sends SIGKILL through `hardKill()`
  (`apps/stick/src/runner.ts:357-361`, `:380`), not the stop signal the trooper checkpoints on. It
  becomes a stop with a grace period (60 seconds [call]) in which the trooper checkpoints into the
  volume and reports *push requested*, then a kill. Anything the agent left uncommitted when a kill
  does land (the kill switch's hard cancel, a stick crash) is still on the volume: the stick
  **salvages** it with a push container whose agent-side step first commits the working tree as
  the agent (`commitIfDirty`, as `checkpoint` does), before the token exists, and then pushes a
  checkpoint.
- **No work lost: the server unreachable, the server restarting, the stick restarting.**
  - *Server unreachable or refusing* when the stick posts *push requested* or asks for the token:
    the stick keeps the volume and the result in memory and retries with backoff. Nothing is
    discarded for want of a token.
  - *Server restart*: `push_pending` is in the database, so it survives. Drops still `running`
    when the server went down would expire within 60 seconds of its return (`LEASE_TTL_MS`,
    `leases.ts:8`) before their sticks reconnect, so `expireLeases` waits one lease period after
    server start before it marks anything lost.
  - *Stick restart*: the stick keeps no state (`apps/stick/src/runner.ts`), so it **rediscovers**
    its pending work from its volumes' labels (drop id, epoch) at startup, before it leases
    anything, and reports them. A drop already `push_pending` simply continues: the push-token
    response names every parameter. A drop that was still `running` (the agent's container died
    with the stick) has gone `lost` in 60 seconds, and today it is requeued after a two-minute
    grace (`LOST_GRACE_MS`, `leases.ts:9`). So a lost drop that had reached `running` holds its
    item's replacement for a **reclaim window** (default 15 minutes [call]); a stick that reports
    the drop's volume within it moves the drop to `push_pending` as a salvage, and the replacement
    then starts from the pushed SHA. After the window the item is requeued from the last pushed
    SHA and a late report is refused and its volume removed. A stick restart is minutes; a stick
    gone longer than the window loses its unpushed work, as a crashed stick does today.
- **Kill switch and observe mode.** `engageKill` cancels every `queued`, `leased` and `running`
  drop with `hard_cancel=1` (`apps/server/src/leases.ts:161-178`), after which their routes answer
  409, so as it stands a held push could never land. **`push_pending` is not in that list**: the
  kill switch leaves pending pushes in place and refuses their token requests while it is on; a
  push container already running is stopped by the stick (its heartbeat for a pending push answers
  *killed*), its token revoked, its volume kept. Agent containers are still hard-cancelled at once,
  which is what a kill switch is for, and their volumes are salvaged into `push_pending` after
  release. This keeps the kill switch's promise (nothing more reaches GitHub while it is on) and
  the owner's (no work lost through a kill). Discarding pending pushes and their volumes at kill was
  the alternative, rejected because it loses work. A zone in `observe` or `paused` gets no push
  token either (nothing written to GitHub); its pending pushes go out when it is active again, or
  are discarded with the drop if the operator cancels it.
- **Disk and hold time are bounded.** Volumes have no size limit of their own, so:
  - every pending push has a **retention deadline** (default 24 hours [call]), not only when its
    stick is gone; the clock pauses while the kill switch is on, and the operator can extend one
    (`ctl`). Past it the server marks the push lost, requeues the item from the last pushed SHA, and
    the stick removes the volume;
  - a **free-space floor** on each stick (default 10 GiB [call]) below which it takes no lease;
  - a **per-stick cap on pending pushes** (default 8 [call]), past which it takes no lease of a
    pushing role.
- **Rejected: the stick pushes directly.** Handing the write token to the stick to push from the
  host would run `git` on agent-written content on the host, beside the Docker socket, outside the
  container isolation the push container keeps. Rejected for that.
- **Revocation.** Each minted token is written to the vault (encrypted like every vault entry,
  keyed by drop id) when minted and deleted when revoked, so `DELETE /installation/token` (F6b),
  which needs the token itself, still works after a server restart. Read tokens are revoked at drop
  end and when the lease is lost; push tokens when the push result arrives; all of them by the kill
  switch. If the spike shows F6b doesn't revoke a stateless token (F21), a token simply expires
  within its hour. **If the spike shows suspension kills live tokens (F22), this store goes**:
  the kill switch's suspension covers what it was for, and an hour's expiry covers the rest, so
  minted tokens need not be written anywhere.
- **Kill switch** [call]. Besides refusing and revoking tokens, the kill switch **suspends each
  installation** with the app JWT (F22). That needs no record of which tokens are live and also
  halts the server's own GitHub work, which the kill switch stops anyway; resuming unsuspends them.
  If the spike shows suspension doesn't kill live tokens, it still stops new mints and the
  vault-held revocation covers the rest.
- **Redaction.** Minted tokens exist in no configured secret list, so the broker registers each one
  in a process-lifetime scrub set (bounded, kept past its expiry) that feeds the server's `scrub`
  (`apps/server/src/main.ts`), together with the base64 of `x-access-token:<token>`, the form git
  sends in a basic-auth header (`authHeader` in `apps/trooper/src/git.ts`); the trooper adds the
  same two strings to its redaction set (`apps/trooper/src/redact.ts`). The shape fallback
  `gh[pousr]_[A-Za-z0-9]{20,}` in `packages/protocol/src/redact.ts` misses the new stateless format
  (F21): it widens to `ghs_[A-Za-z0-9._-]{36,}` for `ghs_`, the pattern GitHub suggests. The
  vault entry's scrub list carries the PEM body and its long base64 lines separately from the JSON.
  Nothing stores a token in a fixed-width field: the new tokens are about 520 characters.
- **The private key never leaves the server process.** It is never in a payload or a drop.

### 4.3 The forge's own identity (every caller that reads the token's account)

`GitHubForge` leans on the token's user in more places than the login. With an app credential:

| Caller | Today | With an app |
|---|---|---|
| `viewerLogin()` (`GET /user`) | the token's account | returns the vault's `<slug>[bot]`; no request (F18) |
| `viewerIsAdmin()` inside `getBranchRules` | the account's collaborator role | returns `false` without a read: an installation is never a repository admin, and `forge.admin` checks the granted permissions instead. Without this, a 403/404 on the bot's collaborator permission falls into the catch that reports **no ruleset** |
| `current_user_can_bypass` in `getBranchRules` (`apps/server/src/forge/github.ts:754`) | `!== 'never'` sets `viewerCanBypass`, so an **absent** field parks every zone through `bot can bypass` (`apps/server/src/flow/guards.ts:976`, `:1009`) | evaluated per ruleset. When the field is absent: use `bypass_actors` if visible (an `Integration` entry with this app's id, or a role the app can't hold); if neither is visible, the result is `unknown`, which is a doctor **warn**, not a park [call]: an app without `administration` can't add itself as a bypass actor, so only a person can, and the doctor says how to check. The merge-restriction ruleset of §5.2 is the one ruleset where the author app is *expected* to bypass, and only there |
| `repoAccess()` (`apps/server/src/forge/github.ts:913`) | `GET /repos` `data.permissions`, the `x-oauth-scopes` and token-expiry headers | permissions from the installation's grant (`GET /repos/{o}/{r}/installation`, F7), not `data.permissions` (spike: what `GET /repos` returns for an installation token); `scopes: null`; `tokenExpiresAt` from the mint response. Callers: zone detection (`apps/server/src/zones/detect.ts:100`, `:143`), the doctor (`apps/server/src/doctor/checks.ts:804-805`), `testCredential` (`apps/server/src/vault/credentials.ts:316`) |
| `findIssueByMarker` (`creator: me`) | the account's login | `<slug>[bot]` (spike: the `creator` filter accepts it) |
| `findReviewByMarker` (the outbox's `post_review` read-back) | matches the review's `user.login` | matches `<slug>[bot]` (spike: the login an app review carries) |
| adoption: outbox `ours()` **and** `flow/reconcile.ts`, which takes `pass.botLogins[0]` as the one author login (`:76`, compared at `:87` and `:162`) | one author login | a **set** of author logins: the author app's `<slug>[bot]`, plus the old PAT bot's login during and after migration, and the old slug after a rename, so open agent PRs are still adopted and not reported as hand-opened |
| doctor `logins.author/reviewer`, `flow/snapshot.ts` `botLogins` | token logins | the apps' bot logins (the author's first, aliases after) |
| `isTrusted` / `isMaintainer` (issue authors' roles) | collaborator permission read | the same read with `metadata: read` (spike) |

The `GitHubForge` takes a token provider and an identity instead of a string, and a broker test
runs `getBranchRules`, `repoAccess`, the marker reads and adoption on an app token against the fake
GitHub.

### 4.4 Vault and credential resolution

App credentials are **keyed by owner** from the start, in the shape M5's per-zone credentials take
(§9): vault entries `github-app/<owner>/author` and `github-app/<owner>/reviewer`, each
`{ appId, slug, clientId, pem, importedAt }` (for config as code, files
`secrets/github-app/<owner>/author.json` and `.../reviewer.json`). A zone's credential for a role is
a reference, `{ kind: 'github-app', owner }` or `{ kind: 'github-pat', name }`; the owner is read
from the zone's repository, so a second organization is a second pair of entries and nothing else.
Per role the resolution is: **the app for this zone's owner if present, else the PAT**.
`credentialFingerprint` includes the app entries, so the forge pair cache refreshes when one
changes. `testCredential` for an app entry signs a JWT and calls `GET /app`: a 401 means a wrong
or revoked key.

The outbox's `pairFor` (`apps/server/src/outbox.ts:47`) routes merges to the reviewer when
`zone.authorMayBeAdmin`. Apps are offered only in two-bot mode, where `authorMayBeAdmin` is unset,
but `pairFor` still takes the resolved credential kind and never sets `merger` for an app author,
so a stale flag can't send merges to a reviewer token that can't merge; the pair cache keys on the
kind too.

A read source for private repositories (`readForgeFor`, the `reviewReadToken` parking rule,
`forge.private-clone`) accepts an app as well as `githubReadToken`.

## 5. Two identities and unattended merging

**Two apps** [call]. A pull request opened by the author app's bot can't be approved by that same
bot (F15, as for any author), so a second identity must approve: a second app, or a machine user
with a PAT as today. Which one depends on F12/F13, so the spike runs a matrix: reviewer app with
`contents: read` and with `contents: write`, each under a ruleset of one required approval, and
under code-owner review with an unowned file (F14).

- **If an app's approval counts** (the expected outcome, perhaps only with `contents: write`):
  two-bot mode uses two apps, with Required approvals 1 and Dismiss stale approvals, unchanged.
- **If it does not**: the author is an app and the reviewer stays a machine-user PAT (the
  **hybrid**). Most of the gain survives: no author token to make or renew, no write token in any
  drop, and the reviewer token never enters an implement drop.

**Apps are offered in two-bot mode only; starter mode stays on PATs** [owner decision,
2026-11-13]. The first draft's app-backed starter mode needed a required `jumpmaster/verdict`
status, which would have left every PR Jumpmaster didn't write (the operator's own, Dependabot's)
unmergeable, since the generated ruleset has no bypass actors (`guidance.ts:118`) and the server
posts verdicts only for its own work. Apps already remove starter mode's main reason on personal
repositories (two-bot works there, below), so the cost bought little. Starter mode is unchanged:
the owner's fine-grained PAT as author, approvals 0, the verdict held in Jumpmaster.

### 5.1 Merging with no person, per mode

The owner's requirement: Jumpmaster merges agent PRs automatically, with no person, in every
supported mode. What that rests on in each:

| Mode | Who merges | What the merge rests on |
|---|---|---|
| **Two-bot, two apps** | the author app, from the server's outbox | the reviewer app's APPROVE on the head SHA counting toward Required approvals 1 (**F12/F13, spike**); required checks; the author app passing the merge-restriction ruleset (§5.2, **F23, spike**); Jumpmaster's own SHA-bound verdict, without which the outbox never merges |
| **Two-bot, hybrid** (app author, PAT reviewer) | the author app | the machine-user reviewer's approval, which counts and can be a code owner, as today; checks; the verdict |
| **Two-bot, PATs** | the author PAT | as today |
| **Starter, PAT** | the author PAT (the owner's account, `authorMayBeAdmin`) | approvals 0, required checks, Jumpmaster's verdict, as today |

A **personal repository** runs two-bot with two apps only if the spike shows **both** that app
approvals count (F12/F13) **and** that the merge-restriction ruleset works there, with an app as a
bypass actor (F23). **If either fails, it stays on PAT starter mode, which is no change from
today**: the hybrid isn't available there (a fine-grained PAT can't serve a collaborator bot on a
personal repository, §1), and today's wizard already puts personal repositories on starter mode.
That is the dry run's case. An organization repository falls back to the hybrid.

The push container doesn't change who merges, and it keeps the requirement in the cases the
earlier drafts put at risk (§4.2):

- **Large branches**: the push is `guardedPush`, bounded only by today's `PUSH_FETCH_MAX_BYTES`
  (1 GiB); no new cap.
- **Server restart**: `push_pending` is in the database, and leases aren't expired until sticks
  have had a lease period to reconnect.
- **Stick restart**: pending pushes are rediscovered from volume labels, and a drop lost with its
  stick holds its replacement for the reclaim window, so the work is salvaged rather than redone.
- **Kill switch**: pending pushes are held, not cancelled, and agent containers' working copies are
  salvaged after release.
- **Checkpoints** go through the same push container, so a resumed drop finds its branch.

The merge itself is the outbox's, as before. The one way work can still be lost is a stick gone for
longer than the reclaim window or a pending push past its retention deadline, which is no worse than
a crashed stick today.

### 5.2 CODEOWNERS and who else can approve

An app can't be a code owner (F14), so the generated file's `* @<reviewer-bot>` line can't name a
reviewer app. Today that line is what makes the reviewer bot's approval the only one that merges an
ordinary PR (`apps/server/src/github/guidance.ts:262`). Dropping it alone would let any actor with
write access approve: a human collaborator (trusted), another installed app, the old author bot
(still a collaborator after migration, its PAT possibly left in a drop's environment for up to 90
days), or `github-actions[bot]` if the repository lets Actions approve pull requests. Agent branches
are in the same repository, so pull-request workflows run agent-written code with the repository's
`GITHUB_TOKEN`; that code could approve its own PR and, with a write `GITHUB_TOKEN`, merge it.

The fix has three parts:

1. **Only the author app (and admins) can merge** [call]. Two-app zones get a second generated
   ruleset, `jumpmaster-merge`, with the single rule **Restrict updates** on the default branch and
   two bypass actors: the author app (`Integration`, its app id) and the repository admin role. The
   main `jumpmaster` ruleset (approvals, stale dismissal, required checks) keeps `bypass_actors:
   []`. Rulesets aggregate and bypass is granted per ruleset (F23), so the author app passes
   `jumpmaster-merge` but still needs the approval and checks of `jumpmaster`. A foreign approval
   then lets nobody merge but the author app, which merges only on Jumpmaster's own verdict, and
   admins, who can merge anyway. The doctor's bypass reading (§4.3) expects the author app's bypass
   on `jumpmaster-merge` and nowhere else. The cost: people with plain write access can no longer
   merge into the default branch; the operator can add roles (`maintain`, `write`) to that
   ruleset's bypass list in the zone's GitHub page, a guarded choice with the warning that a write
   role re-opens merges to anyone with write. The spike settles whether a PR merge counts as an
   update, whether the bypass stays per ruleset, and whether `GITHUB_TOKEN` ever counts as a role
   holder. **If the spike fails this**, two-app mode is not offered and the zone uses the hybrid,
   which keeps `* @<reviewer-bot>`.
2. **The old author is retired after promotion, as a doctor fail.** Promoting the author app (§7)
   waits until no running drop holds the old PAT. The doctor's `forge.retired-author` then checks
   whether the old author account still has write access to the repository (read with the
   collaborator-permission endpoint, spike) or its PAT is still in the vault. During a stated
   **rollback window** (default 7 days from promotion [call]), in which §7 keeps the PAT so the
   operator can roll back, that is a **warn** naming the window's end; after it, a **fail**. Both
   name the two fixes: remove the account's access on GitHub, and delete the token (Settings,
   Credentials), with a link to revoke it on GitHub. Jumpmaster can't remove a collaborator itself:
   that needs admin.
3. **The Actions setting is read when it can be, and made harmless when it can't** (the check is
   deferrable, §13: by this section's own account it will usually say only "can't be read"). The doctor
   tries F24's read with the author app's token; without `administration` it will usually be
   refused, and the doctor won't ask for that permission (§8). So the setting is reported as
   **information**: "can't be read without admin; check these two settings", with direct links to
   the repository's Actions settings page. Part 1 is what makes an Actions approval harmless: it
   can't lead to a merge by anyone but the author app. The spike also records whether a
   `github-actions[bot]` approval counts at all on an unowned path (F13).

**Repositories with human code owners.** If a repository's own CODEOWNERS owns non-protected paths
by people or teams, two apps can't merge PRs that touch them (no app can be a code owner). The
route there is the **hybrid**: an app author and a machine-user PAT reviewer, which can be a code
owner, with `* @<reviewer-bot>` kept. `forge.codeowners`' fix text says exactly that, rather than
telling a repository with real team ownership to delete it.

**What a drop's token can do.** It can read its zone's repository for under an hour, and nothing
else (§4.2). Pushing is the push container's, with its own short-lived token, and merging is the
author app's, on the server.

**Two-bot on personal repositories.** The owner registers both apps under their own account and
installs them on their own repository (F11). Neither bot is the owner or an admin, so
`authorMayBeAdmin` is not needed (a private repository still needs GitHub Pro for rulesets). So
`recommendIdentity` recommends **two-bot with apps for every owner type** [call], and PAT starter
mode for an operator who chooses one bot or when the spike fails on a personal repository.

## 6. Doctor checks and token links

| Check | With a PAT (today, unchanged) | With an app (two-bot only) |
|---|---|---|
| `forge.author` | the token's account, its Write role, not Admin, expiry | the key for the repository's owner signs a JWT `GET /app` accepts; the slug `GET /app` returns equals the vault's (a rename changes `<slug>[bot]`, F18: a **fail** whose fix updates the slug and keeps the old login as an adoption alias); `GET /repos/{o}/{r}/installation` finds the zone's repository (a 404 names the owner and the install page); an informational note says what the installation reaches (All repositories, or the count of selected ones), never a warn or fail; the granted permissions equal the manifest's (an unapproved permission update, F9, is a warn naming the account owner who must approve); no expiry; a key older than a year (from `importedAt`) is a warn |
| `forge.reviewer` | another account, Write, not Admin; `skip` in starter mode | the same for the reviewer app, including the slug check; it must be a different app |
| `forge.author-reads` | probes each read; a refusal names the permission | the same probes with a minted token, plus check runs (`checks: read`), which apps have and fine-grained PATs lack |
| `forge.admin` | neither account is a repository admin | neither installation was granted `administration` or `workflows`; bypass read per ruleset with **each** app's token (§4.3): `never` everywhere except the author app on `jumpmaster-merge`; an `unknown` reading is a warn with the manual check |
| `forge.branch-rules` | the ruleset as today | read with the author app's token through §4.3's changes; also needs `jumpmaster-merge` (§5.2) |
| `forge.codeowners` | two-bot: every owned non-protected path names the reviewer bot | two apps: no non-protected path may have an owner (F14); protected paths name people; a repository with human-owned non-protected paths gets the fix "use the hybrid reviewer", not "delete them" |
| `forge.retired-author` (new) | — | after an author promotion, while the old author account has write access or its PAT is still in the vault: a **warn** during the rollback window, a **fail** after it (§5.2) |
| `forge.actions-approval` (new, deferrable) | — | F24's read if allowed (a write-default `GITHUB_TOKEN` or Actions allowed to approve is a warn); otherwise information with the links (§5.2) |
| `stick.volumes` (new, both kinds) | each stick creates, initialises (owner uid 10001), inspects and removes a test volume, and reports free space against its floor (§4.2) | the same |
| `forge.private-clone` | the read token | the reviewer app covers the repository |
| `credential.kind` | a starter zone needs a fine-grained PAT | an app credential on a starter zone is a **fail**: apps are two-bot only |

A push container's push that GitHub refuses because it touches `.github/workflows` (the apps have
no `workflows` permission, F8) says so by name rather than looking like a ruleset
refusal; such changes touch a protected path and are parked anyway.

The **token template links (M4.5 Task 7)** stay for the PAT path: for starter mode, and under "Use
tokens instead" on the GitHub step and the zone's GitHub page. The two-bot default path shows the
two create buttons and, after each, the install link; the collaborator checklist drops "invite the
bot and accept as the bot" for app roles (installations need no invitation). The generated ruleset
files gain `jumpmaster-merge` for two-app zones; the CODEOWNERS text follows §5.2.

## 7. Coexistence and migration

- **Coexistence.** Each role resolves to an app or a PAT independently, so a two-bot install can
  run an author app with a reviewer PAT (the hybrid), or PATs only, indefinitely; starter zones run
  PATs. Config as code accepts either. `ctl secrets set github-app/<owner>/author` takes the JSON
  on stdin for scripted installs; for a host with no browser, `ctl` writes the manifest form as a
  local HTML file to open elsewhere.
- **Migration of an existing two-bot install** (Settings, Credentials, "Switch to a GitHub App",
  per role; author first). **Deferrable** (Task 11): it serves only installs already running
  two-bot on PATs; new installs start on apps, and personal repositories run starter mode, which
  stays on PATs. If no such install exists when apps land, the drain, promotion, review dismissal
  and retired-author work can wait until one does.
  1. Create and install the app (§4). Nothing changes yet: the PAT still resolves.
  2. The doctor runs §6's app column against the app *as a candidate*, before it is used.
  3. **Author:** promotion waits until no running drop holds the old author PAT (new leases for
     the zone hold off meanwhile), then promotes: the role resolves to the app on the next pass.
     Open agent PRs keep working: push containers push to branches the old bot made and the author app
     merges PRs it didn't open, and adoption recognises both logins (§4.3). `forge.retired-author`
     then fails until the old account's access is removed and its PAT deleted (§5.2).
  4. **Reviewer, before promoting it:** a person applies the `jumpmaster-merge` ruleset and merges
     the CODEOWNERS change that drops the `*` line (the doctor's fixes show both). Doing this first
     is harmless while the old reviewer bot still reviews, since only the author can now merge.
     The candidate check fails until both are in place.
  5. **Reviewer promotion:** the role resolves to the app on the next pass, and the server
     **dismisses every open `REQUEST_CHANGES` review by the old reviewer bot** on agent PRs, which
     would otherwise block their merges (it posts them from `flow/reconcile.ts:267`); the reviewer
     app reviews those PRs afresh at their head SHA. A pending approval from the old bot stays
     valid until the next push dismisses it.
  6. Remove the old reviewer account's collaborator access and delete its PAT (for the reviewer,
     the doctor lists it as unused; it can't merge).
  Rollback is promoting the PAT again, within the rollback window (default 7 days [call]), in which
  the PAT is kept and `forge.retired-author` only warns; for the reviewer it needs the `*` line back,
  which the doctor's fix shows. After the window, retirement is required (the doctor fails).
- **A starter zone** that wants apps switches to two-bot (approvals 1, the generated rulesets and
  CODEOWNERS), then follows the same steps.

## 8. Security summary

- **Better than PATs:** no write token in any container an agent ran in; the agent's read token
  lives under an hour, reaches one repository and is revocable, by the kill switch too; the push
  container's write token is minted per push, for one repository, and revoked after it; no
  `workflows`, so a push to CI config fails at GitHub, not only at Jumpmaster's guard.
- **Given up:** the earlier draft's server-side re-check of the pushed diff. The trooper's
  `prePushCheck`, now in the push container, is the single pre-push check, and the server's
  protected-path check on the PR's file list still runs before every merge (§4.2).
- **Unchanged:** Jumpmaster's own merges, by the author app on the server; starter mode, on PATs.
- **New:** the private key is the install's most powerful GitHub secret for its owner. It mints
  `contents: write` (merge included) on every repository the app is installed on, without expiry.
  On **All repositories** that is every repository of that owner, including ones created later; on
  selected repositories, those. Both are supported [owner decision, 2026-11-13]; the doctor reports
  the reach as information. The key lives only in the vault and the server process and is redacted
  by body and line. `SECURITY.md` states the reach beside the vault key. Rotation: generate a new
  key on the app's settings page, paste it, delete the old one there (the spike checks whether an
  API exists).
- **Blast radius of a drop stays one repository either way.** Every drop token, the agent
  container's `contents: read` and the push container's `contents: write`, is minted with
  `repository_ids: [the zone's repository]` (F6), so what the installation reaches never widens
  what a drop can touch. Server-side tokens are narrowed the same way, per
  zone.

**Restrictions kept, and why.** Only those needed for safety or correctness:

| Restriction | Why it is needed |
|---|---|
| No `administration` permission | An admin-level app could edit or bypass the rulesets that keep merges behind the review and checks (§5.2). |
| No `workflows` permission | Agent code pushed to `.github/workflows` could run arbitrary CI with the repository's secrets; GitHub refuses it without this permission (F8). |
| Every token narrowed to one repository at minting | Keeps a drop's, and each server use's, reach to its zone's repository, whatever the installation reaches. |
| Agent containers get `contents: read` only; pushes run in an agent-free push container | Agent code never shares a container with a write token, so it can't merge, push tags, delete branches or skip `prePushCheck` (§4.2). |
| The push container runs only the base trooper image, the agent uid only for `upload-pack`, and a sweep before the token is used | Nothing the agent left in the workspace can run beside the write token (§4.2). |
| Push tokens only for a `push_pending` drop of a pushing role held by the asking stick, zone active, kill switch off, one per drop reserved before minting | Observe, paused and killed states write nothing to GitHub; a compromised stick mints only for drops it holds (§4.2). |
| The push container gets only the agent's working copy, never the mirror, and fetches the base itself | Files root's git reads with the token can't have been written in the agent's container (§4.2). |
| The token reaches the push container only after the agent-side fetch, the sweep and a check for surviving agent processes | No agent-uid process is alive when the token exists in the container (§4.2). |
| Retention deadline, free-space floor and pending-push cap per stick | Held work can't fill a host's disk or wait forever (§4.2). |
| Per-drop tokens, never shared, revoked at drop end or on the push result | A drop can't use another drop's credential, and the kill switch takes effect. |
| Reviewer is a different app from the author | A pull request's author can't approve it (GitHub's rule for users; for an app, F15 in the spike), so one app can't be both author and approver. |
| `jumpmaster-merge`: only the author app and admins update the default branch | Without `* @reviewer-bot`, other write-access actors' approvals count (§5.2). |
| The old author's access removed at promotion (doctor fail) | Its account and PAT could otherwise approve or merge with the widened approval rule (§5.2). |
| `public: false`, one pair per owner | A public app can be installed by anyone (F20); §4.1. |
| Apps in two-bot mode only | App-backed starter mode would need a required status that blocks every PR Jumpmaster didn't write (§5). |
| The private key never leaves the server | It mints write tokens for the owner's whole installation. |

Not restricted: personal or organization owner, All or selected repositories, and how many
repositories an installation covers.

## 9. GitLab (M5)

GitLab can create **project and group access tokens by API**, so `ctl` can mint them, but not from
nothing: `POST /projects/:id/access_tokens` needs a personal access token (`api` scope) of a
Maintainer or Owner, and can't be called with a project access token
([Project access tokens API](https://docs.gitlab.com/api/project_access_tokens/), confirmed).
On **GitLab.com, project access tokens need Premium or Ultimate** (one token during a trial); on
self-managed and Dedicated they come with any license
([Project access tokens](https://docs.gitlab.com/user/project/settings/project_access_tokens/),
confirmed). Each token is a bot user; it expires within 365 days by default (an administrator can
change the maximum from 17.6), and a token with the `self_rotate` (or `api`) scope can rotate
itself (`POST /projects/:id/access_tokens/self/rotate`, confirmed).

Proposed shape for M5 [call]:

- The operator pastes **one** short-lived personal token (`api`, expiring in a day) once. The
  server mints the zone's author (Developer) and reviewer tokens with `self_rotate`, then forgets
  the bootstrap token. Each token rotates itself well before expiry, so there is nothing to renew.
- Where project tokens aren't available (GitLab.com Free, which M5's e2e target includes), the zone
  uses bot-user PATs, the GitLab counterpart of today's GitHub PAT path.
- Whether a project token's bot user can approve a merge request in a way an approval rule counts
  is not verified here; approval rules are themselves a paid GitLab feature. M5's plan must settle
  it for GitLab two-bot mode.

**Fit with M5's per-zone forge credentials.** M5 already moves forge credentials from install-wide
to per zone (M4.5 plan, deferrals). This design gives that change its shape: a zone's credential for
each role is a reference of one kind, `github-app` (by owner, §4.4), `github-pat`,
`gitlab-project-token` or `gitlab-pat`; the broker answers "a token for role R on zone Z for use U"
whichever kind is behind it. GitHub apps are per repository owner (one pair per owner, shared by
that owner's zones); GitLab tokens are per project or group. The push container (§4.2)
serves every kind: the stick asks for "a push token for this drop", whatever is behind it.

## 10. Milestone and order of work

The order is the owner's [owner decision, 2026-11-13]:

1. **The spike, now, by hand** (Task 1), on a personal-account repository and an organization
   repository. Its first two questions, app approvals (F12/F13) and the merge-restriction ruleset
   with an app bypass actor (F23), decide whether apps deliver anything for a personal repository;
   if either fails there, personal repositories stay on PAT starter mode and the app work narrows
   to organization repositories.
2. **Not app-specific, can land at once**: the shared protected-path matcher (Task 2) and the
   redaction fix for the new token format (Task 3, F21).
3. **The push container, on PAT mode** (Task 4), landed and proven before apps go on top: it
   rewires push, checkpoint and resume for every install, including ones that never use apps, so
   it must stand on its own first. Its placement (M4.5's tail or M5's start) is a [call] for the
   owner; it doesn't change setup, so it doesn't disturb M4.5's before-and-after gate.
4. **Apps last, in M5** [call], as M5's first track, ahead of the GitLab adapter: M5 introduces
   per-zone credentials and credential kinds, and the broker is credential work the M4 plan
   explicitly deferred ("Short-lived forge credentials (GitHub App tokens, §7.3)"). M5's gate (two
   zones on two forges) then runs with an app on the GitHub side. Migration (Task 11) and
   `forge.actions-approval` are deferrable within it (§7, §5.2).

## 11. Open risks

1. **App approvals (F12/F13).** If they don't count, two-bot stays half PAT (the hybrid, §5), and a
   personal repository stays on PAT starter mode. Kill criterion for the reviewer app only; the
   author app stands either way.
2. **The merge-restriction ruleset (F23).** If a PR merge isn't an "update", or a bypass leaks
   across rulesets, two-app mode loses its answer to the widened approval rule and the hybrid is
   the two-bot route.
3. **Manifest reachability (F5, F5b).** A refused `localhost` redirect costs one paste; a refused
   hook configuration with no public placeholder rules out the manifest flow (PATs remain).
4. **GitHub behaviour changes.** The manifest flow, app reviews and the token format (F21) are
   stable but not contracted; the doctor's checks catch a change at the next pass.
5. **The private key** (§8).
6. **Organization policy.** An organization may forbid members to register or install apps; then
   the operator needs an owner, or falls back to PATs. The wizard says this when the owner is an
   organization (§4.1).
7. **Rate limits (F16).** One installation shares its budget across all zones of that owner, as
   one bot account's PATs share theirs today; the installation's budget grows with repositories.
   M5's weighted scheduler should count it per installation.
8. **Identity-dependent code (§4.3).** A caller missed there turns into a silent "no ruleset", a
   parked zone or a lost adoption; the broker test against the fake GitHub is the guard.
9. **The push container.** It runs beside a working copy the agent wrote, with a write token. The
   isolation of §4.2 (one volume, never the mirror; agent uid only for a hardened `upload-pack`;
   root git only in its own bare directory; the sweep in its own PID namespace; the token last; the
   base image) is what keeps the two apart; the tests in Task 4 guard it. Per-drop volumes also
   mean drop data now sits on the host's disk until the push or the retention deadline.
10. **Pending pushes and their lifecycle.** `push_pending`, the reclaim window, the stick's
    rediscovery from volume labels and the graceful lost-server stop are new state on both sides;
    Task 4's restart, kill and retry tests are the guard. A stick gone longer than the reclaim
    window, or a push past its retention deadline, loses its unpushed work, as a crashed stick does
    today.

## 12. Red-team record

**First review (2026-11-13, independent).** 1 blocker, 9 major and 9 minor issues; all were
accepted. The blocker: `getBranchRules` reads the token's own collaborator role, so an app token
would read as "no ruleset" (§4.3). The majors: a drop's container token can merge its own work
(now gone: drops get read tokens, §4.2); the reviewer's `contents` permission may decide whether
its approval counts (§5 spike matrix); the `SameSite=Strict` session cookie never reaches the
callback (§4.1); `authorMayBeAdmin` routes merges to a reviewer that can't merge (§4.4); minted
tokens and the PEM escaped redaction (§4.2); drop tokens were shared and never revoked (§4.2);
bypass actors aren't visible without admin rights (§4.3, §6 `forge.admin`); the migration order
stalled merges (§7); the webhook URL was an untested reachability risk (F5b). The minors corrected
F12, F16, F18, installation discovery, the starter read token, key age and workflow-file merges,
and widened the spike. One minor is **reversed by the owner's decision**: the review asked that an
installation on All repositories fail the doctor; the owner decided on 2026-11-13 that the design
should work with a personal or an organization installation and not restrict what isn't
necessary. All repositories is supported and reported as information (§6, §8), since every token
is narrowed to one repository at minting.

**Second review (Fable) and a third (Mythos, on the PR), 2026-11-13.** Every finding is accepted;
none is rejected. Each change and the finding it answers:

| Change | Answers |
|---|---|
| App-backed starter mode dropped; apps in two-bot only; `statuses: write`, the verdict check and its task removed; starter stays on PATs [owner decision] (§2, §5, §6, §7, §13) | Fable C1–C3, I4; Mythos M2 |
| Per-mode statement of what unattended merging rests on; personal repositories fall back to PAT starter if the spike fails (§5.1) | owner's requirement, restated with the decision |
| `jumpmaster-merge` ruleset so only the author app and admins merge; old author retired at promotion as a doctor fail (`forge.retired-author`); Actions setting read if possible, else information, made harmless by the merge restriction (`forge.actions-approval`); spike items (§5.2, §6, §7, §13) | Fable I2; Mythos M4 |
| Kill switch suspends installations with the app JWT; drop tokens kept in the vault so revocation survives a restart; spike items (§4.2, F6b, F22) | Fable (minor, revocation after restart); Mythos M5; minor "revocation needs the token" |
| Vault entries keyed by owner (`github-app/<owner>/<role>`), zone credentials as references (§4.4, §9) | Fable I8; Mythos M3 |
| Bypass evaluated per ruleset; an absent `current_user_can_bypass` falls back to `bypass_actors`, else a warn, not a park (§4.3, §6) | Fable I1 |
| Old reviewer bot's `REQUEST_CHANGES` reviews dismissed at reviewer promotion (§7) | Fable I3 |
| `repoAccess()` row with its call sites; spike item (§4.3, §13). The cited `init.ts:389` and `doctor/checks.ts:885` don't call it on `origin/main`; the real call sites are listed | Fable I5 |
| Adoption takes a set of author logins in `flow/reconcile.ts` too (§4.3) | Fable I6 |
| Redaction pattern widened for the stateless token format (F21), and the basic-auth form scrubbed (§4.2) | Fable I7 |
| Hybrid named as the route for repositories with human code owners; `forge.codeowners` fix text (§5.2, §6) | Fable I9; Mythos minor (fix text) |
| Pushes moved out of the agent's container, so no refresh channel is needed (§4.2); first as a git bundle the server pushed, replaced in the fourth review by the push container | Mythos M1 |
| Conversion response: `client_secret` dropped and scrubbed, `owner` and `permissions` checked (§4.1) | minors (both) |
| Manifest `code` redeemed at once, scrubbed from logs, plain-HTTP warning (§4.1) | minors (both) |
| Doctor compares the `GET /app` slug with the vault's (§6) | minors (both) |
| F14's unowned-path reading marked inferred and kept in the spike matrix (§3, §13) | minors (both) |
| Spike additions: private app outside its owner, suspension and live tokens, `code` single use, `github-actions[bot]` approval on an unowned path (§13) | Mythos (spike list) |

**Fourth review (Fable, focused on §4.2's push, 2026-11-13): SOUND WITH CHANGES.** The owner
chose its alternative, the push container ("Yes, push container"). Checking it against
`origin/main` turned up one thing the alternative assumed: a drop's workspace does **not** survive
its container today (no mounts, `AutoRemove`), so the design adds per-drop volumes. It also
corrected one citation: the server's protected-path check before a merge is
`flow/snapshot.ts:603` with `flow/decide.ts:234`; `results.ts:269` picks verification artifacts.
Nothing is rejected except, as the review itself advised, the stick pushing directly.

| Change | Answers |
|---|---|
| The push runs in a second, agent-free trooper container with a write token the stick requests; the bundle-to-server design and its `git` in the server image are dropped (§4.2) | the review's recommended alternative [owner decision] |
| (Superseded in the fifth review: one volume, never the mirror.) Per-drop volumes at `/work` and `/home/agent/repo` so the workspace outlives the agent container; cleanup and retention (§4.2) | found in verification (workspace lifetime) |
| Push container isolation kept from `guardedPush` and tightened: agent uid only for `upload-pack` with `core.fsmonitor`/hooks overridden, a failed sweep stops the push, base image only, forge-only egress (§4.2) | found in verification (agent leftovers) |
| `mirrorFetch` before `prePushCheck` uses the push container's fresh write token, after the sweep (§4.2) | C1 |
| A failed or refused token request keeps the volumes and the result, retries, and holds the drop as push pending; agent containers checkpoint on the lost-server kill, pending pushes are never killed (§4.2, §5.1) | I4 |
| Each checkpoint is a push container (no `expectSha`, no gates), and the result's `headSha` is the pushed SHA, so `checkoutBranch(resumeSha)` finds the branch (§4.2) | I6 |
| Heal and resolve keep their lease on `payload.pr.headSha` in the push container (§4.2) | I7 |
| One protected-path matcher in `packages/protocol` for `globHit` and `protectedMatch` (Task 2) | I8 |
| The token route: `liveDrop` (stick bearer token, drop owner, epoch, live lease) plus role, kill switch, zone mode and repository checks; one live token per drop; revocation on the push result; refused under the kill switch and in observe or paused zones (§4.2) | the request's checks |
| The server's re-check of the pushed diff is given up and said so; the protected-path check on the PR's file list before merge remains (§4.2, §8) | the review's stated cost |
| Rejected: handing the write token to the stick to push from the host, beside the Docker socket (§4.2) | the review's weaker option |
| Unattended merging restated for large branches (1 GiB, as today) and server restarts (§5.1) | owner's requirement |
| Stick, protocol, server route and trooper changes, with tests for isolation, a lapsed read token, server-unreachable retry, kill switch and observe, checkpoints and leases (now Task 4) | task outline |

**Fifth round (a narrow Fable review of §4.2's newest parts, SOUND WITH CHANGES, and Mythos's
full re-review on the PR), 2026-11-13.** The owner agreed to the changes and set a new order of
work. Every cited line was checked against `origin/main` and holds. Nothing is rejected. Two
findings are answered by choosing between options the reviews offered, and the choice is stated:
the kill switch keeps pending pushes rather than discarding them (Fable 1), and the lost-server
stop gets a grace period rather than a corrected claim (Fable 4); both because the owner's
requirement is that no work is lost.

| Change | Answers |
|---|---|
| New order: the spike first, by hand, on a personal and an organization repository, as owner-run steps; the push container on PAT mode next; apps last (§2, §10, §13) | Mythos business 1 and 3 [owner decision] |
| §2 and §5.1 say plainly that if app approvals or the merge-restriction ruleset fail, a personal repository stays on PAT starter mode, no change from today, the dry run's case | Mythos business 1 [owner decision] |
| §2 says the token-free route changes who can merge on a team repository, and what the two ways out cost | Mythos business 2 |
| Migration (Task 11) and `forge.actions-approval` marked deferrable, with why (§5.2, §6, §7, §13) | Mythos business 4 [owner decision] |
| One volume, the agent's working copy; the push container never reads the mirror and fetches the base into its own push directory (§4.2, §8) | Mythos security 1; Fable (both found it) |
| `push_pending` drop state, left alone by `engageKill`; the kill switch holds pending pushes, stops a running push container, and agent containers' work is salvaged after release (§4.2) | Fable 1 |
| *Push requested* posted first and stored by the server; the push-token response names every push parameter; nothing persisted on the host but the volume; restarted sticks rediscover pending pushes from volume labels; a reclaim window for drops lost with their stick; leases not expired until sticks have had a lease period after a server start (§4.2) | Fable 2 |
| The trooper keeps the working copy on exit when a push is requested; §13 says `guardedPush` changes (§4.2, Task 4) | Fable 3 |
| The lost-server stop becomes a stop with a 60-second grace, then a kill; salvage of uncommitted work after a kill (§4.2) | Fable 4 |
| Volumes initialised by a one-shot base-image container with only `CHOWN`; the base image gains the directory; `stick.volumes` doctor check (§4.2, §6) | Fable 5 |
| Volume names carry drop id, epoch and a nonce; an existing one is refused (§4.2) | Fable 6 |
| Retention deadline for every pending push, a free-space floor, a per-stick pending-push cap; the probe released on *push requested* so it can't stall dispatch (`leases.ts:89`) (§4.2) | Fable 7 |
| The token reaches the push container only after the agent-side fetch, the sweep and a no-survivors check; `GIT_NO_LAZY_FETCH=1` on `upload-pack`; the git version it needs, tested (§4.2) | Fable 8 |
| The one-token reservation in the database before the mint; a remote already at the expected SHA is success; the agent container's removal confirmed before the push container starts; pending drops counted by the sweep; the push container's own egress session (§4.2) | Fable minors |
| `forge.retired-author` warns during a stated rollback window and fails after it (§5.2, §6, §7) | Mythos security 2 |
| If suspension kills live tokens (F22), the vault store of minted tokens goes (§4.2, Task 1B, Task 5) | Mythos security 3 |
| The isolation statements Fable confirmed are kept: root reads the agent's repository only through agent-uid `upload-pack`; the private PID namespace makes the sweep complete; symlink, `.git`-file, alternates and setuid tricks reach only the agent-uid process; a compromised stick mints only for drops it holds, one repository each (§4.2) | Fable (confirmations) |

## 13. Task outline

In the owner's order (§10): the spike, then what isn't app-specific, then the push container on
PAT mode, then apps.

1. **Spike, first and by hand** [owner decision]. Creating each app needs the owner's browser, so
   part A is owner-run steps; part B runs afterwards with the same apps. Output:
   `docs/spikes/<date>-github-app.md`. Part A gates everything app-specific; if it fails on the
   personal repository, personal repositories stay on PAT starter mode (§5.1) and Tasks 5–12 are
   re-scoped to organization repositories.

   **Before part A** (done by an agent, reviewed, outside the product): a small spike helper,
   `scripts/spike/github-app.mjs`, that takes an app id and the path of its downloaded key, signs
   the JWT, mints a token for the spike repository, and runs one named step (`open-pr`, `approve`,
   `merge`, `status`, `bypass`), printing only the step's outcome, never a token.

   **Part A, on a personal-account repository (P) and then an organization repository (O):**

   | Step | What to click | What to record |
   |---|---|---|
   | A1 | P: **+** → **New repository** → name `jm-spike-<date>`, **Public** (rulesets on a private personal repository need GitHub Pro), tick **Add a README file** → **Create repository**. O: the same under the organization (**Owner** = the organization). | the repository URL |
   | A2 | Author app. P: profile menu → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**. O: organization → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**. Name `jm-spike-author-<date>`; Homepage URL = the repository URL; under **Webhook** untick **Active**; **Repository permissions**: **Contents** = Read and write, **Pull requests** = Read and write (Metadata becomes Read-only by itself); **Where can this GitHub App be installed?** = **Only on this account** → **Create GitHub App**. On the app's page: **Generate a private key** (a `.pem` downloads); then **Install App** → **Install** → **Only select repositories** → the spike repository → **Install**. | the App ID; where the `.pem` is |
   | A3 | Reviewer app: as A2, named `jm-spike-reviewer-<date>`, **Contents** = Read-only, **Pull requests** = Read and write. | the App ID |
   | A4 | Repository → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**. Name `jumpmaster`; **Enforcement status** = Active; **Target branches** → **Add target** → **Include default branch**; tick **Require a pull request before merging**, **Required approvals** = 1, tick **Dismiss stale pull request approvals when new commits are pushed**; leave the bypass list empty → **Create**. | — |
   | A5 | Run the helper: `open-pr` as the author, `approve` as the reviewer, `status`, then `merge` as the author. | **F12** (contents read): `reviewDecision`, `mergeStateStatus`, and whether the merge succeeded |
   | A6 | Only if A5's approval didn't count: reviewer app → **Permissions & events** → **Contents** = Read and write → **Save changes**; then accept it: P: profile **Settings** → **Applications** → **Installed GitHub Apps** (O: organization **Settings** → **GitHub Apps**) → the reviewer app → **Configure** → **Review request** → **Accept new permissions**. Repeat A5 on a new PR. | **F12** (contents write): the same three |
   | A7 | **New branch ruleset** again: name `jumpmaster-merge`, Active, default branch, tick only **Restrict updates**. **Bypass list** → **Add bypass**: is the author app offered? If so, add it and **Repository admin** → **Create**. | **F23**: whether an app can be a bypass actor on this owner type |
   | A8 | Helper: `open-pr`, `approve`, `merge` as the author; then `open-pr` and `merge` as the author **without** an approval. In the web UI, as yourself, try **Merge pull request** on a third, unapproved PR. | **F23**: the approved merge succeeds; the unapproved one is refused by `jumpmaster`; what the admin sees |
   | A9 | Helper: `bypass` with each app. | **F17**: `current_user_can_bypass` per ruleset for each app |

   Keep both repositories and the four apps for part B; delete them at the end (each app's page →
   **Advanced** → **Delete GitHub App**; each repository → **Settings** → **Delete this
   repository**).

   **Part B, after part A, with the same apps:** F5 and F5b (a manifest with a `localhost`
   redirect, and with the hook omitted or non-public); F2 (is the manifest `code` single-use);
   F12/F13 under code-owner review with an unowned file (F14); whether a `github-actions[bot]`
   approval counts on an unowned path; F15 (self-approval refused); F23's remaining cases (a
   write-role user and a write `GITHUB_TOKEN` refused by `jumpmaster-merge`); F18 (the bot's login,
   `issues?creator=`, the login on an app's review); `repoAccess()` (`GET /repos` permissions and
   headers for an installation token); collaborator-permission reads (another account's, for
   `forge.retired-author`, and the bot's own); F24 (the Actions workflow-permissions read without
   `administration`); F20 (a private app refused outside its owner account); F6b on a stateless
   token (F21); F22 (does suspending an installation kill its live tokens: if so, the vault store
   of minted tokens goes, §4.2); a workflow-file push refused without `workflows`; key rotation by
   API.
2. **One protected-path matcher** (can land now): the trooper's `globHit`
   (`apps/trooper/src/git.ts:538`) and the server's `protectedMatch` (`flow/guards.ts:30`) differ
   (the trooper adds the bare-`dir` and basename cases, the server the dotfile handling); one
   function in `packages/protocol` with the union of both behaviours and shared tests, so the push
   check and the review check always agree.
3. **Redaction for the new token format** (can land now): the widened `ghs_` pattern in
   `packages/protocol/src/redact.ts`, and the basic-auth form of registered tokens, with tests.
4. **Push container, landed and proven on PAT mode** (§4.2), before any app work. `guardedPush` is
   **not unchanged**: it loses the mirror (the base is fetched from GitHub straight into the push
   directory), gains the token-last handshake and the hardened `upload-pack`, and treats a remote
   already at the expected SHA as success.
   - **stick**: one per-drop volume at `/home/agent/repo`, named with drop id, epoch and a nonce,
     refused if it exists, initialised by a one-shot base-image container (`CHOWN` only, no
     network); the push container from the base trooper image with its own egress session; the
     token written to its stdin only after it reports *ready*; confirming the agent container is
     removed first; a graceful lost-server stop (grace, then kill) instead of `hardKill`;
     rediscovery of pending pushes from volume labels at startup; salvage of uncommitted work;
     retry with backoff; retention, free-space floor and pending-push cap; volumes counted by the
     ten-minute sweep and `reapOrphans`; the `stick.volumes` doctor report;
   - **protocol**: the push payload without a token, the *ready* line and the token line; the agent
     result *push requested* (final with `expectSha`, or checkpoint); the push-token request, and a
     response carrying every push parameter;
   - **server**: the `push_pending` drop state (kind, `expectSha`, retention deadline), left alone
     by `engageKill` and `expireLeases`; probe release on *push requested*; the reclaim window for
     lost drops that reached `running`; `expireLeases` waiting one lease period after start;
     `POST /api/sticks/push-token` with stick and epoch authentication, role, kill switch, zone
     mode and repository checks, the one-token reservation before minting, the PAT in PAT mode,
     audit and revocation on the push result; the checkpoint's `headSha` from the push;
   - **trooper**: the `push` role; implement, heal and resolve ending in *push requested*, with the
     working copy kept on exit; the salvage step (commit as the agent before the token); a refusal
     if an agent-uid process survives the sweep; a test that the image's git refuses a lazy fetch
     under `GIT_NO_LAZY_FETCH=1`;
   - **tests**: isolation (a planted hook, `core.fsmonitor`, a filter, `core.sshCommand`,
     `includeIf`, a promisor remote and a lingering agent process in the working copy, none of
     which runs or sees the token; nothing read from a mirror); a lapsed read token failing clearly
     at an agent container's start; the server unreachable at push time, then back; a server
     restart with drops running and pending; a stick restart with a pending push and with a
     running drop (salvaged within the reclaim window); the kill switch with agent containers,
     pending pushes and a running push container, then release (nothing lost); observe and paused
     zones; a checkpoint pushed by a push container and resumed by a replacement; heal and resolve
     refused on a moved PR head; a retry after a push whose result was lost; two concurrent token
     requests; a reused volume name; a branch near the 1 GiB limit; the probe released on *push
     requested*.

   **Apps, in M5 (Tasks 5–12):**
5. **Broker and JWT** (`forge/github-app.ts`): sign, mint narrowed tokens, cache server-side uses,
   per-drop read tokens and push tokens (held in the vault for revocation unless the spike shows
   suspension kills live tokens), installation suspension for the kill switch, scrub registration;
   tests with a fake GitHub.
6. **Forge identity** (§4.3): token provider and identity in `GitHubForge`; every caller that
   reads the token's account; `viewerIsAdmin`; bypass per ruleset with the absent-field fallback;
   `repoAccess`; adoption of a login set in `ours()` and `flow/reconcile.ts`; check-runs read.
7. **Vault and resolution**: `github-app/<owner>/<role>` entries, credential references,
   app-first resolution, `testCredential`, fingerprint, PEM scrubbing; `pairFor` by credential
   kind; the read source.
8. **Manifest flow**: owner choice (personal or organization, preselected from the repository),
   one pair per owner, manifest builder (with the no-`administration`/`workflows` refusal), state,
   immediate redemption with log scrubbing, conversion checks, Finish confirmation, install link,
   installation discovery; the wizard and Settings, Credentials buttons; the paste fallback if F5
   failed.
9. **Doctor and guidance**: §6's app column, the slug check, the `jumpmaster-merge` ruleset file,
   CODEOWNERS text without the `*` line for app reviewers and the hybrid fix for human-owned paths,
   `recommendIdentity` for apps (two-bot with apps for organizations always; for personal accounts
   only if part A passed there), token links for starter and under "Use tokens instead".
   `forge.actions-approval` is **deferrable**: by §5.2's own account it will usually report only
   that it can't read the setting, and `jumpmaster-merge` already makes an Actions approval
   harmless.
10. **Runbooks and SECURITY.md**: install (GitHub Apps first for two-bot, tokens for starter and
    as the alternative), operate (key rotation, adding a repository or an owner, pending pushes),
    troubleshooting by check id, the key's reach.
11. **Migration** (**deferrable**, §7): candidate validation (the `*` line and `jumpmaster-merge`),
    drain before author promotion, promote and roll back per role within the rollback window,
    dismissing the old reviewer's change requests, `forge.retired-author`. It serves only
    existing two-bot PAT installs; if there are none when apps land, it waits until there is one.
12. **GitLab** (M5's adapter track): bootstrap token, project-token minting with `self_rotate`,
    the per-zone credential kinds of §9.
