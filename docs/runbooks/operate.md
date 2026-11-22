# Operate runbook

Running Jumpmaster day to day, once the [install runbook](install.md) has taken it to a green
doctor: the zones, the settings, the GitHub page, the status line, the doctor's actions, every
`ctl` verb, backups, and [the operability session](#the-operability-session), the one page a
first-time operator works through.

Every page needs the operator login. Every page action has a `ctl` verb that reaches the same
handler; run them with `docker compose exec jumpmaster jumpmaster ctl …` from the install
directory (`exec -T` when you redirect or pipe). In file mode (a config file at
`config/jumpmaster.config.json`) the config sections below are read-only: edit the file and run
`jumpmaster ctl config reload`, or adopt it ([Config as code](install.md#config-as-code)).

## Zones

A zone is one project: one repository Jumpmaster works on. `/zones` lists them with their mode,
stack, egress, accounts, last drop, doctor fails and anything a zone needs, with **Pause**,
**Resume** and **Observe** buttons and a **GitHub** link for each. `ctl zones list` prints the
same.

### Add a project

**Add a project** (`/zones/new`, also on home) is the wizard's project step: name the repository,
press **Detect**, review the proposed **Stack** and **Checks (gates) every change must pass**,
pick the **Accounts**, and **Create the project**. Detection reads only the default branch's root
and `.github/workflows/`, and writes nothing. A new project is a guarded change: its code will run
in drops with your Claude credentials, so it goes through the
[confirmation page](#guarded-changes-and-the-confirmation-page). `ctl zones add
your-org/your-repo` does the same from a terminal (`--preset`, `--identity starter`, `--egress`).

**Resume.** A zone id that was removed keeps its history (issues, drops, GitHub writes, crew issues,
goals). Adding the same id again is refused until you choose to resume it: the page says what
**Resume** brings back, and the zone comes back paused. `ctl zones add your-org/your-repo --id
<zone> --resume` does the same; it must be the repository the history was recorded against.

### Edit a zone

The zone page, `/zones/<zone>`, has a section per concern, each with its own **Save**:

- **Project**: the ready and retry labels and the open pull requests to take over. The repository
  can't change: remove the zone and add a new one. Renaming the ready label to one already on many
  issues dispatches them all.
- **Stack**: the preset (or an image), the gates, verification, services and limits.
- **Egress**: the mode, the allow list, and the hosts observed in the last 14 days
  ([Egress adoption](#egress-adoption)).
- **Merging**: the accounts (two-bot or starter), CI, the CI deadline, branch rules, the author as
  admin, the read token for review drops, the protected paths and the override approvers.
- **Advanced**: the zone as JSON, for everything else (models, budgets, crew, `gateCi`); it is
  checked as the sections are.

A save is one change to that zone, made against the config revision the page was drawn from: if
someone changed the config meanwhile, it says so and changes nothing (reload and redo it). It
applies at the next pass, with no restart; a drop already running keeps the settings it started
with. `ctl zones set <zone> <path>=<json>` does the same from a terminal, for example
`ctl zones set <zone> readyLabel=go`. `ctl zones show <zone>` prints the zone.

**`gateCi`.** Gates run with `CI=true` by default (frozen installs, no watch mode). `"gateCi":
false` in the Advanced section (or `ctl zones set <zone> gateCi=false`) makes them run with
`CI=false`; it sets the variable to `false`, it does not unset it. Upgrade the sticks and the zone
images before you set `gateCi: false`: an older stick drops the field, so its gates still run with
`CI=true`.

### Guarded changes and the confirmation page

A change that lets more code run, lets a drop reach more, hands a drop a credential, or weakens a
merge guard is guarded: a new project, an egress host added or egress loosened (`enforce` to
`monitor` or `off`), a protected path removed, CI no longer required, `usage.stopOnOverage` turned off, `mcp.enabled` turned on, `server.publicUrl` set, changed or cleared (new machines run the installer from it as root), and others. From
the browser such a change is not applied at once: the page goes to **Confirm a guarded change**,
which says in words what the change allows. Enter your **Operator passphrase** and press
**Confirm**; **Cancel** goes back. The confirmation is good for five minutes and once, for that
exact change on that config revision: if anything changed meanwhile, start again. Reverts,
imports and resumed zones are judged the same way. A change made with `ctl` (the operator token)
or in the config file applies directly, and is audited.

### What a browser session may not change

Two changes are never made from the browser, confirmed or not, because they decide what runs with
your secrets: turning off `requireSignedImages` (for the install or a zone) and setting a zone's
`image` (on an existing zone or a new one, a revert that brings one back included). The page says
to set them with `jumpmaster ctl` or in the config file, for example
`ctl zones set <zone> image='"registry.example.com/team/image@sha256:<digest>"'`.

### Pause, observe and resume

The mode is runtime state, separate from the config: a config change never flips it.

- **Pause** (`ctl pause <zone>`): starts nothing new; running drops finish, and their
  [pending pushes](#pending-pushes) still go out (a push is how a drop finishes).
- **Observe** (`ctl observe <zone>`): plans and records, but writes nothing to GitHub. It is
  refused while the zone has active drops (a pending push counts) or GitHub writes: pause it and
  let them drain first.
- **Resume** (`ctl resume <zone>`): takes ready issues and runs drops again.

These act on one zone. The [kill switch](#kill-switch) (`ctl kill`, `ctl unkill`) stops every
zone at once and, for zones on GitHub Apps, suspends their app installations.

A paused or observing zone's open briefings are held off the floor: they are not listed or counted
in "Waiting on you" or the status line, and the zone gets one line instead, `<repo>: paused, N
briefings held`, linking to the zone's briefings (`/briefings?zone=<zone>`, also linked from the
zone's page). The briefings are unchanged; resuming the zone lists them on the floor again. The
zone's briefings view can **Dismiss all** of them after a confirmation that states the count
(`ctl dismiss <zone> <briefing>…` names them). A dismissal records no ruling: whatever the briefing
was about is not ruled on, and nothing is written to GitHub. A dismissed parked briefing is not
raised again until the item parks again.

### Stop managing a zone

**Stop managing** on the zone's row in the Zones list, or near the top of its page
(`ctl zones remove <zone>`), after one confirmation naming the repository. The zone takes no new
work and goes to observe at once; it is removed as soon as it is drained, with no further visit
(the server checks every few seconds, and after a restart too). Until then it shows as
*stopping* with what it waits for, by count: running drops, pending pushes and outbox writes. In
observe a pending push is held, so it waits until its retention runs out or you cancel it
(`ctl drops cancel <drop>`). Pause or Resume withdraws the stop. Open pull requests and branches
are left as they are; only the zone's mode goes, and its history stays for a later Resume. The
API answers `200 {"removed": …}` when the zone went at once and `202 {"stopping": …, "waits": …}`
otherwise. A file-mode config shows no control: edit the file.

### The backlog and "Work on it"

`ctl backlog <zone>` lists the zone's open issues that carry none of its Jumpmaster labels (ready,
retry, the crew's staged label, triage and triaged) and were not filed by Jumpmaster. An issue
whose author has no write access is listed as not startable, with the reason: intake skips such
issues, so it cannot be queued. `ctl queue <zone> <issue>` puts the zone's ready label on one of
them, as the author identity through the outbox, and starts a pass; intake picks it up from there.
It reads the issue again first and refuses (409, nothing written) a closed issue, a pull request,
an issue already carrying a Jumpmaster label, an untrusted author's issue, a zone in observe mode
and an engaged kill switch. A failed forge read is a 502 with nothing written. Each queue is
audited as `zone.queue` with the issue number.

### Egress adoption

In `monitor`, every host a zone's drops reach is recorded. The Egress section's **Observed in the
last 14 days** lists each host with the drops that reached it and whether a preset already lists
it. Tick the hosts the gates need and press **Adopt ticked**: each is added to the allow list as
a guarded change (drops will be able to send data to it), so it goes through the confirmation
page. Nothing is adopted by default. `ctl zones egress observed <zone>` lists them;
`ctl zones egress adopt <zone> <host>…` adopts. Then set **Mode** to `enforce`.

The residual: a host was observed because a drop reached it, and a drop that misbehaved (an agent
steered by a hostile issue, say) may have reached a host to make it look needed. Adopt only hosts
you recognise; the drops listed beside each one say where it came from.

## System

`/system` is the System area. Its sub-nav: **Health** (the doctor, with the zones' credential
problems above the checks), **Sticks**, **Credentials**, **Server** (the install settings, then
Other machines), **MCP tokens**, **History** and **Advanced**. The old `/doctor`, `/sticks` and
`/settings/…` paths redirect to their pages here.

### Credentials and rotation

Each credential (`claudeToken`, `githubAuthorToken`, `githubReviewerToken`, `githubReadToken`,
`registryReadToken`, and any gate secret a zone declares) shows its source, its fingerprint (the first 8 hex
characters of its SHA-256), the GitHub login it belongs to, when it was set, when it was made, and
its last test. Never the value.

Sources, in the order they win: a variable in the server's environment (`JM_CLAUDE_TOKEN` and the
like, or its `_FILE` form naming a file), then a file under `secrets/` with the credential's name
(`claude_token`, `github_author_token`, `github_reviewer_token`, `github_read_token`,
`registry_read_token`), then the
vault (what you enter here). A file's or the
environment's credential is read-only here, with where it comes from: replace the file and run
`ctl secrets reload`, or change the environment and restart. The doctor's `credential.shadowed`
warns when a file and a vault entry both exist and differ. Each row says which source is in use
and, when another also holds a value, which one it overrides (for example "vault (encrypted),
overriding `JM_GITHUB_READ_TOKEN`").

**The vault's switches.** With the vault off, **Turn on the vault** writes a new random key (32
bytes, base64url) to `secrets/vault_key`, mode 0600 (never over an existing file), records that
the vault is on so a restart keeps it on, and opens it at once. `JM_VAULT_KEY_FILE`, when set,
still names the key and wins. Keep the key file with your backups: the database holds only
ciphertext. **Prefer the vault** (off by default) makes a vault entry win over its variable or
file, at once; with it on, **Replace** stores a value in the vault even for a credential a
variable sets. **Copy into the vault** reads a variable's or file's value on the server and
stores it in the vault; the value never reaches the browser. Unsetting the variable is yours to
do where the server's environment is set. **Turn off the vault** is offered only while it holds
no entries (and removes the key file it wrote). From a terminal: `ctl secrets vault on|off`,
`ctl secrets vault prefer on|off`, `ctl secrets copy-to-vault <name>`.

**Rotate** a credential: paste the new value into its row and press **Replace**. The first change
asks for your passphrase again (good for five minutes). The value is tested with GitHub (a Claude
token is checked for its shape: the doctor drop is its live proof), encrypted and saved; **Test**
tests the stored one again, and **Remove** deletes a vault entry (refused while a zone still needs
it). From a terminal: `ctl secrets set <name>` (the value on stdin or `--from-file`, never in
argv), `ctl secrets test <name>`, `ctl secrets remove <name>`, `ctl secrets list`.

The next drop carries the new value; a drop that started before still carries the old one, and
the page says so: `N running drops still carry the previous <name>: revoke the old one with its
provider once they finish.` Revoke the old token on GitHub (or let the old Claude token lapse)
when that line is gone.

**Token age.** A Claude token from `claude setup-token` lasts a year. From day 330 a banner on
home and on this tab says how old it is and links here; the doctor's `claude.token-age` warns
too. A token entered here is dated the day it is entered, or the **Made on** date you give.

### GitHub Apps

Two-bot zones that use GitHub Apps (see [GitHub Apps](install.md#github-apps)) use one author app
and one reviewer app per GitHub owner, and every zone on that owner's repositories shares the
pair. Credentials lists each pair under **GitHub App entries**, one row per owner and role. The
rows are listed only for the owners of configured two-bot zones: an owner whose pair exists but
who has no two-bot zone yet has no rows here.

- **Owner**: the personal account or organization the app belongs to.
- **Role**: `author` or `reviewer`.
- **Source**: where the entry comes from, `vault (encrypted)` or a file (with its path), and,
  when another source also holds one, which one it overrides.
- **App**: the app's slug, linked to its page on GitHub.
- **App id**, **Imported** (the date it was saved) and **Last test** (the result and its date).
- **Install**, a link to `https://github.com/apps/<slug>/installations/new`, and **Test**, which
  signs a request with the stored key and checks with GitHub that it answers as that app id and
  slug. From a terminal:
  `ctl secrets test github-app/<owner>/<role>`.

An entry not created yet shows `not created` as its source and says "Not created yet: one app
pair per GitHub owner." instead of the links. The private key and the client secret are never
shown, on this page or anywhere else. With no two-bot zone the section says GitHub Apps are for
two-bot mode.

This section lists and tests the entries; it creates none. The apps are created on the setup
wizard's GitHub step, `/setup/forge`, which stays open after setup: name a repository of the
owner, press **Recommend**, and a two-bot recommendation shows **Register the apps under** (**My
personal account** or **The organization**) with **Create the author app** and **Create the
reviewer app** (see [step 4](install.md#step-4-the-setup-wizard)). An owner whose pair already
exists gets an **Install it on the repository** link there instead.

**Adding a repository on an owner that already has a pair.** The pair is already there; the new
zone only needs its installation and repository ids. With no author token, **Detect** reads the
repository through the author app, so the author app's installation must cover the repository
before you add the zone (the order of [step 4](install.md#step-4-the-setup-wizard), the Project
step on the apps path).

1. If the apps' installations cover **Only select repositories**, add the new repository to each
   app's installation on GitHub first, the author app before you press **Detect**: follow the
   author row's **Install** link (or, if the owner has no two-bot zone yet and so no rows, the
   **Install it on the repository** link on `/setup/forge`), choose **Configure** on the owner
   where the app is installed, add the repository and save; then the same for the reviewer app.
   An installation that covers **All repositories** needs nothing.
2. Add the zone: [Add a project](#add-a-project), with two-bot accounts. If the author app's
   installation does not cover the repository, **Detect** answers that the author app "is not
   installed on" the repository and links its install page; add the repository to the
   installation (step 1) and press **Detect** again.
3. Open `/setup/github-app/installed` (GitHub also sends you there after an installation update)
   and press **Find the installations**. Jumpmaster asks GitHub for each two-bot zone's
   installation and repository ids and proposes them as one guarded change: follow **Review and
   confirm** and confirm it with your passphrase
   ([the confirmation page](#guarded-changes-and-the-confirmation-page)). Nothing is recorded
   until you do.
4. Set up the new repository's rulesets and CODEOWNERS on its GitHub page
   ([Branch rules](install.md#branch-rules), [step 5](install.md#step-5-the-github-page)), then
   run the doctor (`ctl doctor <zone>`) to zero fails.

Whatever the installation covers, each token Jumpmaster mints is narrowed to the one zone's
repository: All repositories does not give a drop the owner's other repositories.

**Adding an owner** (another personal account or organization). With no author token, the zone
can only be added once the owner's pair exists and its author app is installed on the
repository; before that, **Detect** answers that no author token is set (no pair) or that the
author app is not installed on the repository. So the pair and the installations come first:

1. Create that owner's pair: open `/setup/forge`, name the new repository and press
   **Recommend**; under **Register the apps under** choose **My personal account** or **The
   organization**, then press **Create the author app** and **Create the reviewer app**, and
   finish each on Jumpmaster's **Finish** page, as in
   [step 4](install.md#step-4-the-setup-wizard).
2. Install both apps on the new owner, choosing **All repositories** or **Only select
   repositories** with the new repository. The owner has no zone yet, so it has no rows under
   **GitHub App entries**: use the install link on the saved page after **Finish**, or the
   **Install it on the repository** link beside each created app on `/setup/forge`.
3. Add the zone for the new owner's repository ([Add a project](#add-a-project)), with two-bot
   accounts. The owner's rows appear under Settings → Credentials, **GitHub App entries**, once
   this zone exists.
4. Run discovery as above: `/setup/github-app/installed`, **Find the installations**, confirm with
   your passphrase.
5. Set up the rulesets and CODEOWNERS the install runbook describes:
   [Branch rules](install.md#branch-rules) and the
   [GitHub page](install.md#step-5-the-github-page). Then run the doctor to zero fails.

The first owner's pair and its zones are unaffected: each zone uses the pair of its own
repository's owner.

**Starter mode and tokens.** Starter-mode zones, and two-bot zones that chose "Use tokens
instead", are unchanged: they keep using the token rows above ([Credentials and
rotation](#credentials-and-rotation)), and nothing here applies to them.

#### Rotating an app's private key

Rotate an app's key when the doctor's `forge.author` or `forge.reviewer` warns that it was
imported more than 365 days ago, and at once if the key may have leaked. GitHub has no API for
this, so the new key is made on GitHub and pasted into Jumpmaster:

1. Open the app's page on GitHub (the row's **App** slug links to it) and go to **Private keys** →
   **Generate a private key**. GitHub downloads a `.pem` file.
2. On Settings → Credentials, under **GitHub App entries**, press **Replace key** on that owner and
   role's row, paste the whole `.pem` file, and enter your passphrase when asked.
3. Jumpmaster tests the key with GitHub before storing it. A key for another app, or a key GitHub
   rejects, is refused and nothing changes: the old key stays in use.
4. After the row shows the new **Imported** date and **Last test** result, delete the old key on
   the app's GitHub page, under **Private keys**. Until then both keys are valid.
5. Delete the downloaded `.pem` from the machine you pasted it from.

Rotation does not change the app id, the slug, the installations or open pull requests: nothing
else needs redoing. **Replace key** sets the entry's **Imported** date to now, so the doctor's
key-age warning clears; for a file-sourced entry it clears once the file's `importedAt` is set, as
below.

Tokens already minted from the old key run to their own expiry (an hour at most); deleting the old
key on GitHub stops new mints with it, not those tokens. If the key leaked, turn on the
[kill switch](#kill-switch) while you rotate: it suspends the app installations, which stops every
live token, and `ctl unkill` resumes once the old key is deleted
([Pending pushes](#pending-pushes)).

**A file-sourced entry** (its **Source** is the file `secrets/github-app/<owner>/<role>.json`) has
no **Replace key**: you edit the file instead. It is JSON, and the key is its `pem` field, one JSON
string with the key's line ends written as `\n`: pasting the multi-line `.pem` over the old value
breaks the file, and the server refuses it. In the same edit set `importedAt` to the current
ISO-8601 date-time (UTC, for example `2026-11-20T09:30:00Z`): the doctor's key-age warning is read
from that field, and nothing else updates it, so a file with only a new `pem` keeps the warning.
From the install directory, with `jq` 1.6 or later, this writes both fields from the downloaded
`.pem` without showing the key on the terminal or putting it in shell history, and keeps the file
at mode `0600`:

```sh
f=secrets/github-app/<owner>/<role>.json
( umask 077 && jq --rawfile pem /path/to/downloaded.pem \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.pem = $pem | .importedAt = $at' "$f" > "$f.new" ) \
  && chmod 600 "$f.new" && mv "$f.new" "$f" || rm -f "$f.new"
```

Then run `ctl secrets reload`, press **Test** on the row (its **Imported** date is now today and
the doctor's key-age warning clears), delete the old key on the app's GitHub page as in step 4, and
delete the downloaded `.pem` as in step 5.

**From a script.** There is no `ctl` verb for this, since the key spans many lines. A script sends
`{"pem": "<the new key>"}` with `PUT` to `/api/control/secrets/github-app/<owner>/<role>/key`,
with the control token, as the control route list says; the same test runs before anything is
stored.

### Install settings

**Server** (`/system/server`) holds the install-wide settings: `pollSeconds`,
`usage.throttleUtilization`, `usage.stopOnOverage`, `claude.plan`, `claude.fableModel`,
`claude.fableWeeklyDropCap`, `claude.fableMaxUtilization`, `claude.fableReview`,
`claude.fableReviewMaxUtilization`, `requireSignedImages` and `mcp.*`. **Save** applies them at the
next pass and says the revision it saved. Reviews may request Fable: with `claude.fableReview` on
(the default), a pull request review runs on Fable while Fable's weekly usage is under
`claude.fableReviewMaxUtilization` (default 0.5), and on the zone's review model otherwise, so the
audit, diagnose and arbitrate drops keep Fable up to `claude.fableMaxUtilization`. Turning `usage.stopOnOverage` off or `mcp.enabled` on asks
for confirmation; turning `requireSignedImages` off is not offered (set it with `ctl` or in the
file). `mcp.enabled` and `mcp.maxBodyBytes` take effect at the next restart: the tab shows
**Restart pending** until you run `docker compose restart jumpmaster`. The boot settings
(`listen`, `dataDir`) are shown read-only, each with where it is set. Warnings from reading the
config file show here too. From a terminal: `ctl settings set <path>=<json>…`, for example
`ctl settings set pollSeconds=30`, and `ctl config show`.

### MCP tokens

Command (a Claude session you run) reaches one zone through Jumpmaster's MCP server at `/mcp`,
with a token made here. Turn on `mcp.enabled` under Install first (it takes effect at the next
restart). On **MCP tokens** pick the **Zone**, the **Scope** (`read`, or `write`) and the **Days**
(1 to 90), give it a **Label**, and press **Make a token**: it asks for your passphrase again,
then shows the token once (the server keeps only its hash). The list shows each token's zone,
scope, label, dates and last use, never the value; **Revoke** ends it at its next call. A last
use you don't recognise means the token is in someone else's hands: revoke it. From a terminal:
`ctl mcp-tokens mint <zone> <read|write> --days N [--label <text>]`, `ctl mcp-tokens list`,
`ctl mcp-tokens revoke <id>`. The [M3 crew runbook](m3-crew.md) covers connecting Command.

### History and rollback

Every change to the config is a revision, kept for good. **History** lists them, newest first,
with when, how it was made, its note, each path that changed, and marks: **guarded** (the change
weakened a guard) and **re-added** (it brought back a zone with its history). **Revert** applies an
old revision's content as a new revision: it asks first, says if it brings back a removed zone
(which comes back paused), and goes through the confirmation page when the change is guarded. A
revert that would set a zone's `image` is refused from the browser: use
`ctl config rollback <id>`. From a terminal: `ctl config revisions`, `ctl config rollback <id>
[note]`.

## The GitHub page

Each zone has a GitHub page, `/zones/<zone>/github`. It never writes to GitHub: it reads the
repository with the author token and gives you links and generated files.

- **Which accounts**: two-bot or starter, recommended from the repository's owner and visibility.
- **Create the tokens**: GitHub's token page for each account, pre-filled with the permissions
  (never Workflows or Administration). Check the resource owner and the repository there.
- **The branch ruleset**: `jumpmaster-<zone>-ruleset.json`, to import under the repository's
  Rulesets (New ruleset → Import a ruleset), with the CI job names detected from the workflows.
- **Code owners for the protected paths**: the `.github/CODEOWNERS` text (two-bot: the reviewer
  bot on `*` first, then the protected paths owned by the people you name) and a link to create
  it on GitHub.
- **Give the accounts access**: the collaborators page and a checklist of the bot logins.

`ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | merge-ruleset | codeowners | checklist`
prints each piece (`ctl github <zone> ruleset > ruleset.json`). `merge-ruleset` is the second
ruleset, `jumpmaster-merge`, of a zone whose author and reviewer are both GitHub Apps: only the
author app and repository admins can merge; for any other zone it says so and fails. Before a zone exists,
`ctl github recommend your-org/your-repo` gives the recommendation.

## The status line

The top of home answers "what is Jumpmaster doing, and why is it waiting?" in one line, for
example `Working: implement #12 in <zone>, 4m 12s, gate 2 of 3`, `Waiting on CI for PR #13 (…)`,
`Paused by you: <zone> (paused)`, `Blocked: <zone> needs githubReviewerToken: …`,
`No runner: the stick hasn't checked in`, or
`Idle: no ready issues. Label one drop-ready or file a new issue`. Below it: the detail, the
other things that block work, each with its fix, and the control that moves it on. `ctl status`
prints the same (`--json` for the object).

## The doctor: actions and artifacts

`/system` shows the latest run; **Run the doctor** runs another (`ctl doctor`, or `ctl doctor
<zone>` for one zone; `ctl doctor --last` prints the latest run without running one). Each check
that isn't a pass shows its fix and its action: a link to the page that fixes it here, a GitHub
page, or a button for the two writes, **Create the missing labels** (`ctl labels <zone>`) and
**Run a doctor drop for &lt;zone&gt;** (`ctl doctor <zone> --drop`; `--cancel` withdraws a queued
one). The install runbook lists
[each check with its action](install.md#troubleshooting-by-check-id).

Where the fix is a file (the ruleset, CODEOWNERS), it is offered as a download beside the action;
`ctl doctor --artifacts <dir>` writes those files into a directory.

## Pending pushes

An implement, heal or resolve drop that finished its agent run with work to push is
`push_pending` until a push container on its stick has pushed it. It shows on home as a slot with
its drop id, and it holds its item: nothing else starts on that issue meanwhile. Normally it lasts
seconds. It lasts longer while the stick can't push: the server is unreachable, the zone is
observing, the kill switch is on, or the stick is down (it finds its pending pushes again when it
restarts).

- **Retention.** A pending push expires 24 hours after it was requested. Expiry marks the drop
  lost (its event log says `push retention expired`) and revokes its credential. An implement
  issue goes back to `ready`, and its next drop resumes from whatever the branch already has on
  GitHub, charged as a resume. A heal or resolve item stays `pr_open` and is picked up again from
  the pull request. The stick removes the volume the next time it asks about the push. Time with
  the server down counts; time with the kill switch on doesn't.
- **More time:** `ctl drops extend-retention <dropId> <hours>` (1 to 168 hours) moves the
  deadline, for example while you fix a stick that is down. It is audited, and refused for a drop
  that isn't pending.
- **Give up:** `ctl drops cancel <dropId>` cancels a pending push: the drop is cancelled, its
  credential revoked, and the item goes where retention expiry would send it (an implement issue
  to `ready`, charged as a resume; heal and resolve stay `pr_open`). The stick stops a push
  container already running for it and removes the volume. Only a `push_pending` drop can be
  cancelled this way.
- **Transcripts.** `ctl drops transcript <dropId> [--out <file>]` exports a drop's events as
  JSONL: a header line (`"header": true`: zone, role, state, stick, models), then one line per
  stored event in `seq` order, its `data` as stored (already redacted). `ctl zones transcripts
  <zone> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]` exports every drop of the
  zone created in `[since, until)`, oldest first; `until` defaults to now and the window is at
  most 92 days. Transcripts hold code from private repositories: export is operator-only, each
  export writes a `transcript-export` audit row, and `--out` creates the file mode 0600 and never
  overwrites one.
- <a id="kill-switch"></a>**Kill switch.** `ctl kill` hard-cancels queued and running drops, but
  leaves pending pushes in place. While it is on, no push credential is issued and a running push container is stopped
  with its volume kept, so nothing reaches GitHub. An agent run the kill stopped leaves its
  uncommitted work on its volume, and the stick salvages it into a pending push, even while the
  switch is on, or up to 15 minutes after `ctl unkill` (a stick that was down longer, or an issue
  that has moved on since, gets its volume removed instead). The retention clock stops for the
  duration. `ctl unkill` adds the time back to
  every deadline, and the pending pushes, salvaged ones included, go out.

  *Zones on GitHub Apps only:* `ctl kill` also suspends every app installation each zone records
  (author and reviewer). Suspension stops every live app token within seconds, the server's own
  GitHub work included, and GitHub refuses new mints until `ctl unkill` unsuspends them. Each
  installation is suspended (or unsuspended) on its own, with its own 10-second deadline, so one
  that fails doesn't hold up the others. ctl prints one line per failure:

  ```text
  could not suspend the <role> app installation <id> of <owner> (status N)
  ```

  (`could not unsuspend …` for `ctl unkill`), and the server log records the same failure. N is
  GitHub's HTTP status; status 0 means a network error, a timeout or a missing broker (no app
  entry to sign with). Run `ctl kill` (or `ctl unkill`) again, or suspend or unsuspend that
  installation yourself on GitHub: open the installation's settings (**Configure** on the app's
  installation for that owner) and press **Suspend** or **Unsuspend**. Token-mode zones have no installation to suspend: for them the
  switch is only what the paragraph above describes.
- **The push token (zones on GitHub Apps only).** In token mode the push uses the zone's author
  token, as configured. On a zone whose author is a GitHub App, the server mints a
  `contents: write` token from the author app when the stick asks for a push credential, narrowed
  to the zone's repository and good for that one push. It is held in the server's memory only and
  revoked on GitHub when the push result arrives, when a new push plan releases the drop's
  reservation, or when a salvage replaces the pending push. Retention expiry and
  `ctl drops cancel` void the drop's grant, so no credential is issued for it again, and the stick
  stops a running push container; they do not call GitHub to revoke a token already minted, which
  stays valid until it expires within its hour. The push token goes only into the push container:
  no write token ever enters a container an agent ran in. The agent's own fetches use a separate
  per-drop `contents: read` token (the author app's for implement, heal and resolve drops; the
  reviewer app's for review, crew and doctor drops), revoked when the drop ends.
- **Nothing to clean up after a restart (zones on GitHub Apps only).** Minted tokens are never
  stored: not in the database, the vault, an audit row or a log. A server restart forgets the
  ones it held, needs no cleanup, and any token left unrevoked expires within its hour. To stop
  every live token at once, use the [kill switch](#kill-switch).
- **A refused push.** GitHub refusing the push (branch protection, a pre-receive hook, secret
  scanning) is final, as is the trooper's own pre-push check (a protected path, a secret, a
  commit that isn't the gated one). The drop then fails, or for a checkpoint resumes from the last
  pushed commit. A network failure or timeout is retried.
- **A refused credential.** A push credential the server refuses for good (the drop's role, the
  zone's repository no longer the drop's, the push kind, or the branch) fails the push, as a final
  refusal would. A refusal for the kill switch, an observing zone, or another attempt's
  reservation is retried with backoff, the volume kept; a paused zone is not refused.

## Sticks

The **Sticks** page (`/system/sticks`) lists every stick: whether it is live, its version and
capabilities, the zones it can't run, and how many troopers it runs at once. Change the count and
Save: the stick picks it up on its next lease answer, with no restart. Lowering it stops nothing;
the stick takes no new drop until fewer than the new count are running. The count goes up to the
stick's ceiling (`JM_MAX_SLOTS`, see the install runbook's
[Troopers per stick](install.md#troopers-per-stick)); a refusal names the ceiling. From a script:
`ctl sticks` lists each stick's effective, desired and max counts, and
`ctl sticks slots <name-or-id> <n>` sets one. Each change is audited as `stick.slots`.
`ctl sticks remove <name-or-id>` removes a stick (its token is revoked; its unstarted drops are
requeued) and `ctl sticks cancel <invite>` cancels an invite that hasn't checked in; see
[Add a stick](install.md#add-a-stick).

Beside each stick's version the page says where it stands against the server's release: up to
date, an update available (with an **Upgrade to v…** button), older than in-place upgrades
(reinstall it once with a new code), upgrading, or a failed or refused upgrade with its reason
(and **Retry**). Upgrading asks for sudo, as removing does, and is audited as `stick.upgrade`.
`ctl sticks upgrade <name-or-id>` upgrades one stick and prints the reason when it can't;
`ctl sticks upgrade --all` upgrades every stick that can be and lists the ones it skipped.

A stick on another machine reaches the server at `server.publicUrl` (System, Server, Other machines, or
`ctl public-url set https://…`; `ctl public-url check` fetches its `/healthz`). Each change is
audited as `server.public_url`. See install.md, "Reaching the server from other machines".

## ctl

`docker compose exec jumpmaster jumpmaster ctl help` lists every verb by page, and
`ctl <verb> --help` shows one verb's forms. Every route the browser uses has a verb; the table
below is generated from the control manifest (`apps/server/src/api/manifest.ts`), and a test keeps
the two equal. The browser's re-authentication (`/api/control/sudo`) has no verb: the operator
token is always allowed.

<!-- ctl-table:start -->
| Page | `ctl` | Route |
|---|---|---|
| Status | `ctl status [--json]` | `GET /api/control/status` |
| Setup | `ctl setup-code` | `POST /api/control/setup/code` |
| Setup | `ctl setup reopen` | `POST /api/control/setup/reopen` |
| Setup | `ctl passphrase set (the passphrase on stdin)` | `PUT /api/control/passphrase` |
| Setup | `ctl detect <owner/name>` | `POST /api/control/detect` |
| Zones | `ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off\|monitor\|enforce] [--resume]`<br>`ctl zones list [--json]`<br>`ctl zones show <zone> [--json]`<br>`ctl zones set <zone> <path>=<json>… [--note <text>]`<br>`ctl zones remove <zone>`<br>`ctl zones egress observed <zone> [--json]`<br>`ctl zones egress adopt <zone> <host>…`<br>`ctl zones transcripts <zone> --since <YYYY-MM-DD> [--until <YYYY-MM-DD>] [--out <file>]` | `GET /api/control/zones`<br>`POST /api/control/zones`<br>`GET /api/control/zones/:id`<br>`DELETE /api/control/zones/:id`<br>`GET /api/control/zones/:id/egress/observed`<br>`POST /api/control/zones/:id/egress/adopt`<br>`PATCH /api/control/config`<br>`GET /api/control/zones/:id/transcripts` |
| Zones | `ctl pause <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl resume <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl observe <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl crew-cycle <zone>` | `POST /api/control/zones/:id/crew-cycle` |
| Zones | `ctl backlog <zone> (open issues with no Jumpmaster label)` | `GET /api/control/zones/:id/backlog` |
| Zones | `ctl queue <zone> <issue> (puts the ready label on)` | `POST /api/control/zones/:id/queue` |
| Zones | `ctl intake <zone> stub <file.json> (prints the GOAL.md stub)`<br>`ctl intake <zone> issue <file.json> (files the issue ready)` | `POST /api/control/zones/:id/intake/goal-stub`<br>`POST /api/control/zones/:id/intake/issue` |
| GitHub | `ctl github <zone> recommend \| pat <author\|reviewer\|read> \| ruleset \| merge-ruleset \| codeowners [--reviewer <login>]… \| checklist`<br>`ctl github recommend <owner/name> [--paid-plan] [--identity starter\|two-bot]` | `GET /api/control/zones/:id/github`<br>`POST /api/control/github/recommend` |
| Settings | `ctl settings set <path>=<json>… [--note <text>]` | `PATCH /api/control/config` |
| Settings | `ctl public-url set <https://address>`<br>`ctl public-url clear`<br>`ctl public-url check` | `PUT /api/control/server/public-url`<br>`POST /api/control/server/public-url/check` |
| Settings | `ctl mcp-tokens mint <zone> <read\|write> --days N [--label <text>]`<br>`ctl mcp-tokens list`<br>`ctl mcp-tokens revoke <id>` | `POST /api/control/mcp-tokens`<br>`GET /api/control/mcp-tokens`<br>`DELETE /api/control/mcp-tokens/:id` |
| Credentials | `ctl secrets list`<br>`ctl secrets set <name> [--from-file <path>] [--created YYYY-MM-DD] (the value on stdin or in the file, never in argv)`<br>`ctl secrets test <name>`<br>`ctl secrets test github-app/<owner>/<role>`<br>`ctl secrets remove <name>`<br>`ctl secrets remove github-app/<owner>/<role>`<br>`ctl secrets reload`<br>`ctl secrets vault on\|off`<br>`ctl secrets vault prefer on\|off`<br>`ctl secrets copy-to-vault <name>` | `GET /api/control/secrets`<br>`PUT /api/control/secrets/:name`<br>`POST /api/control/secrets/:name/test`<br>`POST /api/control/secrets/github-app/:owner/:role/test`<br>`DELETE /api/control/secrets/:name`<br>`DELETE /api/control/secrets/github-app/:owner/:role`<br>`POST /api/control/secrets/reload`<br>`POST /api/control/secrets/vault/on`<br>`POST /api/control/secrets/vault/off`<br>`POST /api/control/secrets/vault/prefer`<br>`POST /api/control/secrets/:name/copy-to-vault` |
| Config | `ctl config show [--json]`<br>`ctl config revisions`<br>`ctl config set <path>=<json>… [--note <text>]`<br>`ctl config rollback <id> [note]`<br>`ctl config import <file> [--dry-run] [--note <text>]`<br>`ctl config export`<br>`ctl config reload`<br>`ctl config adopt`<br>`ctl config mode file` | `PATCH /api/control/config`<br>`GET /api/control/config`<br>`GET /api/control/config/revisions`<br>`POST /api/control/config/rollback`<br>`POST /api/control/config/reload`<br>`POST /api/control/config/adopt`<br>`POST /api/control/config/mode`<br>`GET /api/control/config/export`<br>`POST /api/control/config/import` |
| Doctor | `ctl doctor [zone] [--json] [--artifacts <dir>]`<br>`ctl doctor --last [--json]`<br>`ctl doctor <zone> --drop`<br>`ctl doctor <zone> --cancel` | `POST /api/control/doctor`<br>`GET /api/control/doctor`<br>`POST /api/control/doctor/drop` |
| Doctor | `ctl labels <zone>` | `POST /api/control/zones/:id/labels` |
| Briefings | `ctl briefings [--json]` | `GET /api/control/briefings` |
| Briefings | `ctl rule <briefing> <option> [--options <digest>] [note]` | `POST /api/control/briefings/:id/rule` |
| Briefings | `ctl dismiss <zone> <briefing>…` | `POST /api/control/zones/:id/briefings/dismiss` |
| Drops | `ctl drops extend-retention <dropId> <hours>`<br>`ctl drops cancel <dropId>`<br>`ctl drops transcript <dropId> [--out <file>]` | `POST /api/control/drops/:id/extend-retention`<br>`POST /api/control/drops/:id/cancel`<br>`GET /api/control/drops/:id/transcript` |
| Sticks | `ctl sticks [--json]`<br>`ctl sticks slots <name-or-id> <n>`<br>`ctl sticks remove <name-or-id>`<br>`ctl sticks upgrade <name-or-id>`<br>`ctl sticks upgrade --all`<br>`ctl sticks cancel <invite-name-or-id>` | `GET /api/control/sticks`<br>`POST /api/control/sticks/:id/slots`<br>`POST /api/control/sticks/:id/remove`<br>`POST /api/control/sticks/:id/upgrade`<br>`POST /api/control/sticks/upgrade-all`<br>`POST /api/control/sticks/invites/:id/cancel` |
| Kill | `ctl kill` | `POST /api/control/kill` |
| Kill | `ctl unkill` | `POST /api/control/kill` |
<!-- ctl-table:end -->

A server that can't be reached prints `cannot reach <url>: <cause>`; a verb whose feature is off
(the MCP token verbs with `mcp.enabled` off) says which setting turns it on.

## Backup and restore

`secrets/` travels with `data/`: the database holds the vault's ciphertext, and
`secrets/vault_key` is its key. Back them up together.

**Back up** the database while it runs (a consistent copy, written to `data/`):

```sh
docker compose exec jumpmaster node -e "require('better-sqlite3')('/data/jumpmaster.sqlite').exec(\"VACUUM INTO '/data/backup-$(date +%Y%m%d).sqlite'\")"
```

Copy `data/backup-*.sqlite`, `secrets/` (with `vault_key`), `config/` and `.env` somewhere safe,
keeping the file modes (`cp -a`, or `tar -cpf`); keep the copy readable by you alone, since
`secrets/` holds every key. Together they are the whole install.

**Restore:** stop it (`docker compose down`), put the files back, then
`chmod 700 secrets && chmod 600 secrets/*`, put the backup in place as `data/jumpmaster.sqlite`
(remove any `jumpmaster.sqlite-wal` and `-shm` beside it) and `docker compose up -d`.

A restore of `data/` without `secrets/vault_key` means re-entering each credential: `bootstrap`
makes a new key and warns that `data/` already holds a database, the doctor's `vault.key` names
the entries that no longer decrypt, and System, Credentials shows each as `not set: the stored
value does not decrypt with the vault key (enter it again)`. **Remove** it and enter it again.
A file credential under `secrets/` needs nothing.

A `data/` restore from before `adopt` returns to file mode with the config file's zones.

### The daily export

In db mode, keep the config file a current mirror of the database, so a downgrade or a move back
to file mode loses nothing. Once a day, from the host (a crontab line, say):

```sh
cd ~/jumpmaster && docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json
```

`-T` keeps the file free of carriage returns. In db mode the server ignores the file (and says
so); the doctor's `config.file` warns when it no longer matches the database.

## Upgrading the server

The steps on the server host, from the install directory. Drain the zones first
([Upgrade](install.md#upgrade) has the drain and what carries over between releases).

1. **Back up** the release files and the database. Copy the files of the release that runs now
   into `upgrade-backup/`, and take the database copy from [Backup and restore](#backup-and-restore):

   ```sh
   mkdir -p upgrade-backup && cp -a compose.yaml images.lock.json SHA256SUMS SHA256SUMS.sigstore.json upgrade-backup/
   docker compose exec jumpmaster node -e "require('better-sqlite3')('/data/jumpmaster.sqlite').exec(\"VACUUM INTO '/data/backup-$(date +%Y%m%d).sqlite'\")"
   ```

2. **Place the new release files.** Download the new release's four files over the old ones (the
   download loop of [Upgrade](install.md#upgrade), step 2).
3. **Check `SHA256SUMS`**: `cosign verify-blob` as in that step, then
   `sha256sum -c SHA256SUMS` (macOS: `shasum -a 256 -c SHA256SUMS`). Stop on any failure and put
   the backed-up files back.
4. **Pull** the new images: `docker compose pull`.
5. **Start only the server and chat services**: `docker compose up -d jumpmaster chat`. The
   services they depend on start with them.
6. **Confirm the new release is healthy**: `docker compose exec jumpmaster jumpmaster ctl doctor`
   shows no `FAIL`, and `server.image-mirror` passes once the new images are mirrored (its message
   ends with the mirror store's size; the server deletes the blobs of images no lock still names
   after each complete pass). Resume the zones.
7. **Remove the previous release's images** from the host. `docker compose pull` leaves them in
   the host's Docker, and the server cannot remove them (it has no Docker socket). This lists the
   image of each digest in the backed-up previous `images.lock.json`, skips any the new lock still
   names and any a container (running or stopped) uses, and removes the rest with a plain
   `docker image rm` (never `-f`, so Docker refuses anything still in use):

   ```sh
   prev=upgrade-backup/images.lock.json
   registry=$(grep -o '"registry": *"[^"]*"' "$prev" | sed 's/.*"\([^"]*\)"$/\1/')
   grep -o '"jumpmaster-[a-z0-9-]*": *"sha256:[0-9a-f]*"' "$prev" \
     | sed 's/"\([^"]*\)": *"\([^"]*\)"/\1@\2/' \
     | while read -r ref; do
         digest=${ref#*@}
         if grep -q "$digest" images.lock.json; then echo "kept (in the new lock): $ref"; continue; fi
         id=$(docker image inspect --format '{{.Id}}' "$registry/$ref" 2>/dev/null) || continue
         if [ -n "$(docker ps -aq --filter ancestor="$id")" ]; then echo "kept (in use): $ref"; continue; fi
         echo "removing $id ($registry/$ref)"
         docker image rm "$id"
       done
   ```

   An image Docker refuses to remove stays; the message says what uses it. Keep `upgrade-backup/`
   until you no longer want a way back.

## The operability session

One page for a first-time operator: install Jumpmaster and run it through a project's life with
the browser as the only interface after `docker compose up`. You need a host (Linux with a
rootful Docker Engine, or macOS with Docker Desktop) with an empty directory and `cosign`, two
GitHub repositories with CI and no ruleset, CODEOWNERS or labels yet, the bot accounts with their
collaborator invitations accepted and their tokens, and your own Claude token from
`claude setup-token`.

0. **The prelude.** Run the README's five commands, as written, in the empty directory. The last,
   `docker compose up`, prints a line beginning `JUMPMASTER SETUP CODE:`.
1. **Claim it.** Open `http://127.0.0.1:7420`, enter the setup code, choose a passphrase.
2. **Set it up.** In the setup wizard, connect the Claude token and the GitHub tokens, following
   its account recommendation; add the first repository; import the ruleset file and commit the
   CODEOWNERS text from the GitHub page; create the labels from the doctor; run the doctor until it
   shows no fail.
3. **First issue.** File the first issue from the zone's New issue page (`/zones/<zone>/issues/new`), and wait for its pull request
   to merge.
4. **Change a running zone.** Pause the zone on Zones; on its page, change a gate's timeout in
   **Stack** and save; resume it. The next drop uses the new timeout, with no restart.
5. **Rotate a token.** Under System, Credentials, replace the author token with a new one; revoke
   the old one on GitHub once the page no longer says a running drop carries it.
6. **A second repository.** Add a second project, import its ruleset file, create its labels, and
   run the doctor until it shows no fail.
7. **Recover.** When the doctor shows a fail, follow that check's action until it passes again.
8. **Read the status line.** At any moment, say in your own words what Jumpmaster is doing and why
   it is waiting, from the line at the top of home.
