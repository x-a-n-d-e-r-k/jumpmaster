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
`monitor` or `off`), a protected path removed, CI no longer required, `usage.stopOnOverage` turned off, `mcp.enabled` turned on, and others. From
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

- **Pause** (`ctl pause <zone>`): starts nothing new; running drops finish.
- **Observe** (`ctl observe <zone>`): plans and records, but writes nothing to GitHub. It is
  refused while the zone has active drops or GitHub writes: pause it and let them drain first.
- **Resume** (`ctl resume <zone>`): takes ready issues and runs drops again.

### Remove a zone

**Remove &lt;zone&gt;** at the bottom of the zone page (`ctl zones remove <zone>`). A zone is
removed once it is drained: set it to observe and let its drops and GitHub writes finish. Only
its mode goes; its history stays, for a later Resume.

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

## Settings

`/settings` has four tabs: **Credentials**, **Install**, **MCP tokens** and **History**.

### Credentials and rotation

Each credential (`claudeToken`, `githubAuthorToken`, `githubReviewerToken`, `githubReadToken`,
and any gate secret a zone declares) shows its source, its fingerprint (the first 8 hex
characters of its SHA-256), the GitHub login it belongs to, when it was set, when it was made, and
its last test. Never the value.

Sources, in the order they win: a variable in the server's environment (`JM_CLAUDE_TOKEN` and the
like, or its `_FILE` form naming a file), then a file under `secrets/` with the credential's name
(`claude_token`, `github_author_token`, `github_reviewer_token`, `github_read_token`), then the
vault (what you enter here). A file's or the
environment's credential is read-only here, with where it comes from: replace the file and run
`ctl secrets reload`, or change the environment and restart. The doctor's `credential.shadowed`
warns when a file and a vault entry both exist and differ.

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

### Install settings

**Install** (`/settings/install`) holds the install-wide settings: `pollSeconds`,
`usage.throttleUtilization`, `usage.stopOnOverage`, `claude.plan`, `claude.fableModel`,
`claude.fableWeeklyDropCap`, `requireSignedImages` and `mcp.*`. **Save** applies them at the next
pass and says the revision it saved. Turning `usage.stopOnOverage` off or `mcp.enabled` on asks
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

`ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | codeowners | checklist`
prints each piece (`ctl github <zone> ruleset > ruleset.json`); before a zone exists,
`ctl github recommend your-org/your-repo` gives the recommendation.

## The status line

The top of home answers "what is Jumpmaster doing, and why is it waiting?" in one line, for
example `Working: implement #12 in <zone>, 4m 12s, gate 2 of 3`, `Waiting on CI for PR #13 (…)`,
`Paused by you: <zone> (paused)`, `Blocked: <zone> needs githubReviewerToken: …`,
`No runner: the stick hasn't checked in`, or
`Idle: no ready issues. Label one agent-ready or file one from Intake`. Below it: the detail, the
other things that block work, each with its fix, and the control that moves it on. `ctl status`
prints the same (`--json` for the object).

## The doctor: actions and artifacts

`/doctor` shows the latest run; **Run the doctor** runs another (`ctl doctor`, or `ctl doctor
<zone>` for one zone; `ctl doctor --last` prints the latest run without running one). Each check
that isn't a pass shows its fix and its action: a link to the page that fixes it here, a GitHub
page, or a button for the two writes, **Create the missing labels** (`ctl labels <zone>`) and
**Run a doctor drop for &lt;zone&gt;** (`ctl doctor <zone> --drop`; `--cancel` withdraws a queued
one). The install runbook lists
[each check with its action](install.md#troubleshooting-by-check-id).

Where the fix is a file (the ruleset, CODEOWNERS), it is offered as a download beside the action;
`ctl doctor --artifacts <dir>` writes those files into a directory.

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
| Zones | `ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off\|monitor\|enforce] [--resume]`<br>`ctl zones list [--json]`<br>`ctl zones show <zone> [--json]`<br>`ctl zones set <zone> <path>=<json>… [--note <text>]`<br>`ctl zones remove <zone>`<br>`ctl zones egress observed <zone>`<br>`ctl zones egress adopt <zone> <host>…` | `GET /api/control/zones`<br>`POST /api/control/zones`<br>`GET /api/control/zones/:id`<br>`DELETE /api/control/zones/:id`<br>`GET /api/control/zones/:id/egress/observed`<br>`POST /api/control/zones/:id/egress/adopt`<br>`PATCH /api/control/config` |
| Zones | `ctl pause <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl resume <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl observe <zone>` | `POST /api/control/zones/:id` |
| Zones | `ctl crew-cycle <zone>` | `POST /api/control/zones/:id/crew-cycle` |
| Zones | `ctl intake <zone> stub <file.json> (prints the GOAL.md stub)`<br>`ctl intake <zone> issue <file.json> (files the issue ready)` | `POST /api/control/zones/:id/intake/goal-stub`<br>`POST /api/control/zones/:id/intake/issue` |
| GitHub | `ctl github <zone> recommend \| pat <author\|reviewer\|read> \| ruleset \| codeowners [--reviewer <login>]… \| checklist`<br>`ctl github recommend <owner/name> [--paid-plan] [--identity starter\|two-bot]` | `GET /api/control/zones/:id/github`<br>`POST /api/control/github/recommend` |
| Settings | `ctl settings set <path>=<json>… [--note <text>]` | `PATCH /api/control/config` |
| Settings | `ctl mcp-tokens mint <zone> <read\|write> --days N [--label <text>]`<br>`ctl mcp-tokens list`<br>`ctl mcp-tokens revoke <id>` | `POST /api/control/mcp-tokens`<br>`GET /api/control/mcp-tokens`<br>`DELETE /api/control/mcp-tokens/:id` |
| Credentials | `ctl secrets list`<br>`ctl secrets set <name> [--from-file <path>] [--created YYYY-MM-DD] (the value on stdin or in the file, never in argv)`<br>`ctl secrets test <name>`<br>`ctl secrets remove <name>`<br>`ctl secrets reload` | `GET /api/control/secrets`<br>`PUT /api/control/secrets/:name`<br>`POST /api/control/secrets/:name/test`<br>`DELETE /api/control/secrets/:name`<br>`POST /api/control/secrets/reload` |
| Config | `ctl config show [--json]`<br>`ctl config revisions`<br>`ctl config set <path>=<json>… [--note <text>]`<br>`ctl config rollback <id> [note]`<br>`ctl config import <file> [--dry-run] [--note <text>]`<br>`ctl config export`<br>`ctl config reload`<br>`ctl config adopt`<br>`ctl config mode file` | `PATCH /api/control/config`<br>`GET /api/control/config`<br>`GET /api/control/config/revisions`<br>`POST /api/control/config/rollback`<br>`POST /api/control/config/reload`<br>`POST /api/control/config/adopt`<br>`POST /api/control/config/mode`<br>`GET /api/control/config/export`<br>`POST /api/control/config/import` |
| Doctor | `ctl doctor [zone] [--json] [--artifacts <dir>]`<br>`ctl doctor --last [--json]`<br>`ctl doctor <zone> --drop`<br>`ctl doctor <zone> --cancel` | `POST /api/control/doctor`<br>`GET /api/control/doctor`<br>`POST /api/control/doctor/drop` |
| Doctor | `ctl labels <zone>` | `POST /api/control/zones/:id/labels` |
| Briefings | `ctl briefings` | `GET /api/control/briefings` |
| Briefings | `ctl rule <briefing> <option> [--options <digest>] [note]` | `POST /api/control/briefings/:id/rule` |
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
the entries that no longer decrypt, and Settings, Credentials shows each as `not set: the stored
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
3. **First issue.** File the first issue from the zone's Intake page, and wait for its pull request
   to merge.
4. **Change a running zone.** Pause the zone on Zones; on its page, change a gate's timeout in
   **Stack** and save; resume it. The next drop uses the new timeout, with no restart.
5. **Rotate a token.** Under Settings, Credentials, replace the author token with a new one; revoke
   the old one on GitHub once the page no longer says a running drop carries it.
6. **A second repository.** Add a second project, import its ruleset file, create its labels, and
   run the doctor until it shows no fail.
7. **Recover.** When the doctor shows a fail, follow that check's action until it passes again.
8. **Read the status line.** At any moment, say in your own words what Jumpmaster is doing and why
   it is waiting, from the line at the top of home.
