# GitHub App authentication — design proposal

*Status: proposal, not decided · 2026-11-13 · red-teamed once (§12) · extends §7.3 of the
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

Replace the GitHub PATs with **two GitHub Apps per install, registered from a manifest** in one
click each, and **installation access tokens minted per repository and per use** by a credential
broker in the server [call]:

1. **Author app** and **reviewer app**, each registered from the setup wizard through GitHub's
   manifest flow. Jumpmaster stores each app's id, slug and private key in the vault. No token is
   ever made or pasted by hand.
2. The operator **installs** each app on the repositories it should reach (GitHub's own install
   page, "Only select repositories"). Adding a repository later is ticking it there.
3. The broker mints **one-hour installation tokens narrowed to one repository and to the
   permissions the use needs**. A drop gets its own `contents: write` token for its zone's
   repository, never shared with another drop, **revoked at drop end and by the kill switch**.
   Read-only drops get `contents: read`.
4. **PATs keep working** as a second credential kind per role. Existing installs migrate role by
   role from Settings, Credentials.
5. It lands in **M5** (§10), which already brings per-zone forge credentials; it is behind a
   **spike** (Task 1) that settles the facts GitHub's docs leave open, chiefly whether an app's
   approval satisfies a ruleset's required approvals.

What it buys: zero tokens to make for GitHub; two-bot mode on personal repositories (no more
owner-as-author starter mode by necessity); a drop credential that lives at most an hour, reaches
one repository and is revocable; and no expiry to renew. What it does **not** buy: a drop token
that can't merge. `contents: write` includes the merge endpoint (F19), so the ruleset, not the
token, still stops a drop from merging (§5).

## 3. GitHub facts this rests on

| # | Fact | Status | Source |
|---|---|---|---|
| F1 | A manifest is POSTed (form field `manifest`, JSON) to `https://github.com/settings/apps/new` for a personal account or `https://github.com/organizations/ORGANIZATION/settings/apps/new` for an organization, with an optional `state` "to protect against cross-site request forgery". The person can edit the app's name before creating it. | confirmed | [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) |
| F2 | GitHub redirects to the manifest's `redirect_url` with `code`; `POST /app-manifests/{code}/conversions` returns `id`, `pem` (private key) and `webhook_secret`; "You must complete all three steps … within one hour"; the endpoint is rate limited. | confirmed | same page |
| F3 | The conversion needs no authentication. | inferred (the page shows none) | same page |
| F4 | Manifest fields: `name`, `url` (required), `hook_attributes` (`url` required inside it, `active` defaults to true), `redirect_url`, `callback_urls`, `setup_url`, `setup_on_update`, `description`, `public`, `default_events`, `default_permissions`, `request_oauth_on_install`. | confirmed | same page |
| F5 | `redirect_url` may be a `localhost` or private address, because GitHub only redirects the browser there. | unknown (Probot's manifest flow does this, which suggests yes) | spike |
| F5b | A manifest with `hook_attributes` omitted, or with a non-public hook `url` and `active: false`, is accepted. | unknown | spike |
| F6 | An installation token "will expire after 1 hour"; the request may narrow it with `repositories` or `repository_ids` (up to 500) and a `permissions` subset; it can't exceed what the installation was granted. | confirmed | [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) |
| F6b | `DELETE /installation/token` revokes an installation token. | confirmed | [Endpoints available for installation access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| F7 | The app JWT is RS256, `exp` "no more than 10 minutes into the future", `iat` recommended 60 seconds in the past against clock drift; `iss` is the client id or app id. | confirmed | [Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) |
| F8 | Git over HTTPS takes the token as the password (`x-access-token:TOKEN`) with `contents` permission; editing files in `.github/workflows` needs the separate **Workflows** permission. | confirmed | [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) |
| F9 | When the app's permissions change, each installation's owner "will be prompted to approve the new permissions", and until they do the installation keeps the old ones. | confirmed | same page |
| F10 | "The success of an API request with an installation access token only depends on the app's permissions" (not on a collaborator role). | confirmed | same page |
| F11 | An app owned by a personal account can be installed on that account, with "Only select repositories". | confirmed | [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) |
| F12 | A ruleset's pull request rule counts approving reviews from those with write access; the docs never say whether an **app's** APPROVE review counts, nor what "write access" means for an app (its `contents: write` grant is the likely reading). | **unknown** (apps) | [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets); [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) |
| F13 | Community answers disagree: one says a dedicated app's reviews "will count toward merge requirements", another that GitHub "only counts real user" approvals. Only `github-actions[bot]` is clearly excluded. | unknown | [community discussion 181487](https://github.com/orgs/community/discussions/181487) |
| F14 | Code owners are "individuals or teams" that "must have write permissions", with "explicit write access". An app is neither, so it **can't be a code owner**. A path with no owner can be changed with the approval of any user with write access. | confirmed (who may be one; unowned paths); inferred (apps excluded) | [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| F15 | An author can't approve their own pull request, and this holds for an app's bot. | inferred; spike | — |
| F16 | Installation rate limit: at least 5,000 requests per hour, plus 50 per repository over 20 and per org user over 20, at most 12,500 (15,000 on Enterprise Cloud). A PAT's limit belongs to its user account, shared by all that account's tokens. | confirmed | [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| F17 | Ruleset bypass actors include `Integration` (an app). A caller without admin rights may not see `bypass_actors`, but gets `current_user_can_bypass`. | confirmed (actor type); inferred (visibility); spike | [REST API endpoints for rules](https://docs.github.com/en/rest/repos/rules); [changelog 2023-06-27](https://github.blog/changelog/2023-06-27-repository-rules-public-beta-updates/) |
| F18 | `GET /user` is not available to an installation token. The bot's login is `<slug>[bot]`. | confirmed (endpoint); inferred (login string); spike | [Endpoints available for installation access tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| F19 | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` needs **Contents: write** for an app. | confirmed | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) |

F12, F13 and F15 decide the two-identity model (§5). F5 and F5b decide whether a private install
can use the one-click flow at all (§4.1).

## 4. Design

### 4.1 Registering the apps (manifest flow)

The wizard's GitHub step replaces the three token links with **Create the author app** and, for
two-bot, **Create the reviewer app**. Each is an HTML form that POSTs to F1's URL, for the
repository's owner when it is an organization, else the personal URL:

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
    "metadata": "read", "statuses": "write", "checks": "read", "actions": "read"
  }
}
```

`statuses: write` (today's PAT has read) is for starter mode's verdict status (§5). The reviewer
manifest asks `pull_requests: write`, `contents: read`, `metadata: read`, unless the spike finds an
app approval counts only with `contents: write`; then the reviewer app is granted that at install,
and every reviewer token is still narrowed (`pull_requests: write` on the server, `contents: read`
in drops), so the install grant is broader than any token. Neither manifest ever asks
`administration` or `workflows`; the server refuses to render one that does, as `patTemplateUrl`
refuses today. `hook_attributes` is omitted (Jumpmaster polls); if GitHub requires it (F5b), it
points at the project's public repository URL with `active: false`, never at the install. App
names are unique across GitHub, so the name carries a short install id; the operator may edit it.

- **State.** The server mints a single-use `state` bound to the logged-in operator session and the
  role, kept ten minutes.
- **Callback in two steps.** The session cookie is `SameSite=Strict`
  (`apps/server/src/auth/sessions.ts`), so the redirect from github.com arrives without it. The
  callback `GET /setup/github-app/callback?code&state` is therefore unauthenticated and does
  nothing but render a same-origin page whose **Finish** form POSTs `code` and `state` back. That
  POST carries the cookie and passes the Origin check; only then does the server redeem the state,
  call `POST /app-manifests/{code}/conversions` (F2), and store in the vault `githubAuthorApp` (or
  `githubReviewerApp`): `{ appId, slug, clientId, pem, importedAt }`. The webhook secret is dropped.
  The cookie stays Strict. `setup_url` works the same way. Then the page links the app's install
  page (`https://github.com/apps/<slug>/installations/new`).
- **Reachability.** Only the operator's browser follows the redirect; the server makes outbound
  calls only, as today. If F5 fails, the fallback is the same flow with a manual last step: the
  operator pastes the URL the browser failed to load (it carries the code) into the wizard. That is
  no token to make, but it is one paste. If F5b fails with no public placeholder accepted, the
  manifest flow is out and the design falls back to PATs; the spike is the gate.
- **Organizations.** Registering an app under an organization needs an owner or app manager of
  that organization; installing it on the organization's repositories needs an owner, or an
  owner's approval of a member's request. The wizard says so where it says today that an
  organization may have to approve each fine-grained token.

### 4.2 Installing and the broker

- **Installation.** The `setup_url` redirect carries `installation_id`, but the server never trusts
  it: it calls `GET /repos/{owner}/{repo}/installation` with the app JWT (F7), which answers exactly
  whether this repository is covered and by which installation; a 404 is the doctor's "not
  installed on this repository". Each zone records `{ installationId, repositoryId }` as config
  (not secret).
- **Broker.** A module in the server, `forge/github-app.ts`, holds the keys and mints
  `POST /app/installations/{id}/access_tokens` (F6) with `repository_ids: [zone repo]` and a
  `permissions` subset per use:

| Use | App | Permissions in the token | Lifetime |
|---|---|---|---|
| Server: issues, labels, PR open, merge, status and check reads, verdict status | author | the author manifest's set | cached, re-minted under ten minutes left |
| Server: review posting | reviewer | `pull_requests: write` | cached |
| Implement, heal, resolve drops (git only) | author | `contents: write` | **per drop**, never cached or shared, revoked at the end |
| Review, crew and doctor drops on a private repository | reviewer (author in starter mode) | `contents: read` | per drop, revoked at the end |

- **Revocation.** A drop's tokens are revoked with `DELETE /installation/token` (F6b) when the drop
  ends, when its lease is lost, on refresh (the old one), and by the kill switch, which closes the
  gap the M2 plan recorded for PATs.
- **Long drops.** An implement drop can outlive its first token before its push. The trooper asks
  for a fresh one over the stick channel right before each git operation that needs the network
  (new protocol message `credential.refresh`) [call]. The server answers only for a live lease,
  only with that lease's zone repository and the role's permission set, rate-limited and audited.
  A git credential helper that calls the stick is the same message behind git's own interface.
- **Redaction.** Minted tokens exist in no configured secret list, so the broker registers each one
  in a process-lifetime scrub set (bounded, kept past its expiry) that feeds the server's `scrub`
  (`apps/server/src/main.ts`); the trooper adds a refreshed token to its redaction set
  (`apps/trooper/src/redact.ts`) before first use; and the vault entry's scrub list carries the PEM
  body and its long base64 lines separately from the JSON.
- **The private key never leaves the server process.** It is never in a payload or a drop.

### 4.3 The forge's own identity (every `viewerLogin()` caller)

`GitHubForge` leans on the token's user in more places than the login. With an app credential:

| Caller | Today | With an app |
|---|---|---|
| `viewerLogin()` (`GET /user`) | the token's account | returns the vault's `<slug>[bot]`; no request (F18) |
| `viewerIsAdmin()` inside `getBranchRules` | the account's collaborator role | returns `false` without a read: an installation is never a repository admin, and `forge.admin` checks the granted permissions instead. Without this, a 403/404 on the bot's collaborator permission falls into the catch that reports **no ruleset** |
| `findIssueByMarker` (`creator: me`) | the account's login | `<slug>[bot]` (spike: the `creator` filter accepts it) |
| `findReviewByMarker` (the outbox's `post_review` read-back) | matches the review's `user.login` | matches `<slug>[bot]` (spike: the login an app review carries) |
| outbox adoption (`ours()`) | author login | author app's `<slug>[bot]`, **plus** the old PAT bot's login during and after migration, so open agent PRs are still adopted |
| doctor `logins.author/reviewer`, `flow/snapshot.ts` `botLogins` | token logins | the apps' bot logins |
| `isTrusted` / `isMaintainer` (issue authors' roles) | collaborator permission read | the same read with `metadata: read` (spike) |

The `GitHubForge` takes a token provider and an identity instead of a string, and a broker test
runs `getBranchRules`, the marker reads and adoption on an app token against the fake GitHub.

### 4.4 Vault and credential resolution

`apps/server/src/vault/credentials.ts` gains two install credentials, `githubAuthorApp` and
`githubReviewerApp` (a JSON value with the pem; also accepted as a file for config as code,
`secrets/github_author_app.json`). Per role the resolution is: **app if present, else PAT**.
`credentialFingerprint` includes the app entries, so the forge pair cache refreshes when one
changes. `testCredential` for an app entry signs a JWT and calls `GET /app`: a 401 means a wrong
or revoked key.

The outbox's `pairFor` (`apps/server/src/outbox.ts`) routes merges to the reviewer when
`zone.authorMayBeAdmin`. With an app author that would send merges to a reviewer token that can't
merge, so `pairFor` takes the resolved credential kind and never sets `merger` for an app author;
the pair cache keys on the kind too.

A read source for private repositories (`readForgeFor`, the `reviewReadToken` parking rule,
`forge.private-clone`) accepts an app as well as `githubReadToken`. In M5 these entries become per
zone (§9).

## 5. Two identities: one app or two

**Two apps** [call]. A pull request opened by the author app's bot can't be approved by that same
bot (F15, as for any author), so a second identity must approve: a second app, or a machine user
with a PAT as today. Which one depends on F12/F13, so the spike runs a matrix: reviewer app with
`contents: read` and with `contents: write`, each under a ruleset of one required approval, and
under code-owner review with an unowned file.

- **If an app's approval counts** (the expected outcome, perhaps only with `contents: write`):
  two-bot mode uses two apps, with Required approvals 1 and Dismiss stale approvals, unchanged.
- **If it does not**: the author is an app and the reviewer stays a machine-user PAT (a hybrid).
  Most of the gain survives: no author token to make or renew, per-drop revocable tokens, and the
  reviewer token never enters an implement drop.

**CODEOWNERS** (F14): an app can't be a code owner, so the generated file's `* @<reviewer-bot>`
line can't name a reviewer app. A path with no code owner needs only an approval from someone with
write access, so the generated file **drops the `*` line** and names people on the protected paths
only. Merges of ordinary PRs then need only the reviewer's approval; a PR touching a protected path
still needs a named person, and Jumpmaster never merges those anyway (§7.4 of the design). A
repository whose own CODEOWNERS owns other paths by people blocks every PR touching those paths;
`forge.codeowners` fails with that fix, as it does today for a line that misses the bot.

**What a drop token can do.** `contents: write` merges (F19), and also pushes tags and deletes
branches. In two-bot mode the ruleset's required approval stops a drop from merging an unreviewed
PR, as it stops a PAT today. In **starter mode** (approvals 0) nothing on GitHub would, so with an
app author starter mode requires one more ruleset entry [call]: a required status check
`jumpmaster/verdict` whose source is the **author app** (its integration id), which the server
posts from the SHA-bound verdict. The drop's token has no `statuses` permission, so it can't post
it, and a drop-initiated merge is refused. The doctor's `forge.branch-rules` requires that check for
an app-backed starter zone.

**What it means for starter mode.** Starter mode exists for two reasons: an operator who wants one
bot, and personal repositories where a PAT can't serve a collaborator bot. Apps remove the second:
the owner registers both apps under their own account and installs them on their own repository
(F11). Neither bot is the owner or an admin, so `authorMayBeAdmin` is not needed, and two-bot mode
works on a personal repository (a private one still needs GitHub Pro for rulesets). So
`recommendIdentity` recommends **two-bot for every owner type** when apps are used [call]. Starter
mode stays for an operator who chooses it: one author app, approvals 0 plus the verdict check, the
verdict held in Jumpmaster.

## 6. Doctor checks and token links

| Check | With a PAT (today, unchanged) | With an app |
|---|---|---|
| `forge.author` | the token's account, its Write role, not Admin, expiry | the key signs a JWT `GET /app` accepts; `GET /repos/{o}/{r}/installation` finds the zone's repository; the granted permissions equal the manifest's (an unapproved permission update, F9, is a warn naming the account owner who must approve); no expiry; a key older than a year (from `importedAt`) is a warn |
| `forge.reviewer` | another account, Write, not Admin; `skip` in starter mode | the same for the reviewer app; it must be a different app; `skip` in starter mode |
| `forge.author-reads` | probes each read; a refusal names the permission | the same probes with a minted token, plus check runs (`checks: read`), which apps have and fine-grained PATs lack |
| `forge.admin` | neither account is a repository admin | neither installation was granted `administration` or `workflows`; `current_user_can_bypass` read with **each** app's token is `never` (the full `bypass_actors` list is likely hidden without admin rights, F17); an installation on **All repositories** is a **fail** with the install-page fix; `authorMayBeAdmin` on an app-author zone is a pass with a note to clear it |
| `forge.branch-rules` | the ruleset as today | read with the author app's token through §4.3's `viewerIsAdmin` change; app-backed starter zones also need the `jumpmaster/verdict` check with the author app as its source |
| `forge.codeowners` | two-bot: every owned non-protected path names the reviewer bot | two-bot: no non-protected path may have an owner (F14); protected paths name people; starter unchanged |
| `forge.private-clone` | the read token | the reviewer app (author app in starter) covers the repository |
| `credential.kind` | a starter zone needs a fine-grained PAT | an app credential satisfies it |

A merge refused because a PR touches `.github/workflows` (the apps have no `workflows`
permission, F8) says so by name rather than looking like a ruleset refusal; such PRs touch a
protected path and are parked anyway.

The **token template links (M4.5 Task 7)** stay for the PAT path, under "Use tokens instead" on the
GitHub step and the zone's GitHub page. The default path shows the two create buttons and, after
each, the install link; the collaborator checklist drops "invite the bot and accept as the bot" for
app roles (installations need no invitation). The ruleset file gains the verdict check for
app-backed starter zones; the CODEOWNERS text follows §5.

## 7. Coexistence and migration

- **Coexistence.** Each role resolves to an app or a PAT independently, so an install can run an
  author app with a reviewer PAT (the hybrid), or PATs only, indefinitely. Config as code accepts
  either. `ctl secrets set githubAuthorApp` takes the JSON on stdin for scripted installs; for a
  host with no browser, `ctl` writes the manifest form as a local HTML file to open elsewhere.
- **Migration of an existing install** (Settings, Credentials, "Switch to a GitHub App", per role):
  1. Create and install the app (§4). Nothing changes yet: the PAT still resolves.
  2. The doctor runs §6's app column against the app *as a candidate*, before it is used.
  3. **Reviewer only, before promoting it:** a person merges the CODEOWNERS change that drops the
     `*` line (the doctor's fix shows the new text). Dropping it first is harmless: unowned paths
     accept the old reviewer bot's approval too (F14). Promoting the reviewer app while a `*` line
     still names the old bot would stall every merge, so the candidate check fails until it is gone.
  4. Promote: the role resolves to the app on the next pass. For the author, the same config
     revision clears `authorMayBeAdmin` (a guarded field). Open agent PRs keep working: the author
     app can push to branches the old bot made and merge PRs it did not open, and adoption
     recognises both logins (§4.3); a pending approval from the old reviewer bot stays valid until
     the next push dismisses it.
  5. Remove the old bot accounts' collaborator access and delete the PATs (the doctor lists them as
     unused credentials).
  Rollback is promoting the PAT again, kept until step 5; it needs no `*` line back.

## 8. Security summary

- **Better than PATs:** no long-lived credential in any drop; drop tokens per drop, one repository,
  revocable, and the kill switch can finally revoke them; no owner-admin account in starter mode;
  no `workflows`, so an agent push to CI config fails at GitHub, not only at Jumpmaster's guard.
- **Same as PATs:** a drop token can merge (F19); the ruleset is what stops it, now in starter mode
  too (§5).
- **New:** the private key is the install's most powerful GitHub secret. It mints `contents: write`
  (merge included) on every repository the app is installed on, without expiry. It lives only in
  the vault and the server process, is redacted by body and line, and an install on all
  repositories is a doctor fail. `SECURITY.md` states this beside the vault key. Rotation: generate a
  new key on the app's settings page, paste it, delete the old one there (the spike checks whether
  an API exists).

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
each role is one of `github-app`, `github-pat`, `gitlab-project-token`, `gitlab-pat`; the broker
answers "a token for role R on zone Z for use U" whichever kind is behind it. GitHub apps stay
install-wide (one pair, many installations); GitLab tokens are per project or group.

## 10. Milestone

**M5** [call], as its first track, ahead of the GitLab adapter: M5 introduces per-zone credentials
and credential kinds, and the broker is credential work the M4 plan explicitly deferred
("Short-lived forge credentials (GitHub App tokens, §7.3)"). It doesn't belong in M4.5, whose gate
measures the current path; changing setup under that gate would cost its before-and-after
comparison. M5's gate (two zones on two forges) then runs with an app on the GitHub side. The
**spike (Task 1) can run now**, independent of M5, so its answer is in hand when M5 is planned.

## 11. Open risks

1. **App approvals (F12/F13).** If they don't count, two-bot stays half PAT (the hybrid, §5).
   Kill criterion for the reviewer app only; the author app stands either way.
2. **Manifest reachability (F5, F5b).** A refused `localhost` redirect costs one paste; a refused
   hook configuration with no public placeholder rules out the manifest flow (PATs remain).
3. **GitHub behaviour changes.** The manifest flow and app reviews are stable but not contracted;
   the doctor's checks catch a change at the next pass.
4. **The private key** (§8).
5. **Organization policy.** An organization may forbid members to register or install apps; then
   the operator needs an owner, or falls back to PATs. The wizard asks who owns the organization
   before showing the buttons.
6. **Rate limits (F16).** One installation shares its budget across all zones on that account, as
   one bot account's PATs share theirs today; the installation's budget grows with repositories.
   M5's weighted scheduler should count it per installation.
7. **Identity-dependent code (§4.3).** A caller missed there turns into a silent "no ruleset" or a
   lost adoption; the broker test against the fake GitHub is the guard.

## 12. Red-team record

An independent review on 2026-11-13 found 1 blocker, 9 major and 9 minor issues in the first draft;
all were accepted. The blocker: `getBranchRules` reads the token's own collaborator role, so an app
token would read as "no ruleset" (now §4.3). The majors: a drop token can merge (§5, §8); the
reviewer's `contents` permission may decide whether its approval counts (§5 spike matrix); the
`SameSite=Strict` session cookie never reaches the callback (§4.1 two-step callback);
`authorMayBeAdmin` routes merges to a reviewer that can't merge (§4.4, §7); minted tokens and the
PEM escaped redaction (§4.2); drop tokens were shared and never revoked (§4.2); bypass actors
aren't visible without admin rights (§6 `forge.admin`); the migration order stalled merges (§7);
the webhook URL was an untested reachability risk (F5b). The minors corrected F12, F16, F18,
installation discovery, the starter read token, key age, workflow-file merges and the
all-repositories install, and widened the spike.

## 13. Task outline

1. **Spike (now, outside M5).** A throwaway app pair on a scratch repository with a ruleset of one
   required approval and code-owner review. Record: F5 (`localhost` redirect) and F5b (hook
   omitted or non-public); F12/F13 as a matrix of reviewer `contents: read` / `write` × required
   approval / code-owner review with an unowned file; F15 (self-approval refused); F18 (the bot's
   login string, `issues?creator=` with it, the login on an app's review); a drop-narrowed
   `contents: write` token merging via the API; a workflow-file push refused without `workflows`;
   `current_user_can_bypass` for an installation token, including when the app is a bypass actor;
   collaborator-permission reads (`metadata: read`) and the bot's own collaborator-permission
   status; `DELETE /installation/token`; key rotation by API. Output:
   `docs/spikes/<date>-github-app.md`. Gate for everything below.
2. **Broker and JWT** (`forge/github-app.ts`): sign, mint narrowed tokens, cache server-side uses,
   per-drop tokens with revocation, scrub registration; tests with a fake GitHub.
3. **Forge identity** (§4.3): token provider and identity in `GitHubForge`; every `viewerLogin()`
   caller; `viewerIsAdmin`; adoption of both logins; check-runs read.
4. **Vault and resolution**: `githubAuthorApp` / `githubReviewerApp`, app-first resolution,
   `testCredential`, fingerprint, PEM scrubbing; `pairFor` by credential kind; the read source.
5. **Manifest flow**: manifest builder (with the no-`administration`/`workflows` refusal), state,
   two-step callback, conversion, install link, installation discovery; the wizard and Settings,
   Credentials buttons; the paste fallback if F5 failed.
6. **Drops**: per-drop narrowed tokens in payloads; `credential.refresh` over the stick channel with
   lease checks; revocation at drop end, lease loss and kill switch; trooper redaction of refreshed
   tokens.
7. **Starter verdict check**: the server posts `jumpmaster/verdict` from the SHA-bound verdict; the
   ruleset file and `forge.branch-rules` require it for app-backed starter zones.
8. **Doctor and guidance**: §6's app column, CODEOWNERS text without the `*` line for app reviewers,
   `recommendIdentity` for apps, token links under "Use tokens instead".
9. **Migration**: candidate validation (including the `*` line), promote and roll back per role,
   clearing `authorMayBeAdmin`, unused-credential listing.
10. **Runbooks and SECURITY.md**: install (GitHub Apps first, Tokens as the alternative), operate
    (key rotation, adding a repository), troubleshooting by check id, the key's blast radius.
11. **GitLab** (M5's adapter track): bootstrap token, project-token minting with `self_rotate`,
    the per-zone credential kinds of §9.
