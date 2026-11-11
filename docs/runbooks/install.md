# Install runbook

This installs Jumpmaster from a published release with Docker Compose, on one Linux or macOS host,
and takes it to a merged agent pull request. There are two ways in:

- **[The browser path](#install-in-the-browser)** (start here): five shell commands, then
  everything in the browser. The config lives in the database (db mode), and credentials you
  enter are kept encrypted in the vault.
- **[The scripted install](#the-scripted-install)**: `jumpmaster init` writes a config file (file
  mode) and you keep each token as a file under `secrets/`. Use it when you want the config in
  version control; [Config as code](#config-as-code) covers both modes.

Where a command says `your-org/your-repo` (your repository) or `<zone>` (the zone id, the
repository name in lower case unless you chose another), put in your own. The steps name the
readiness doctor's check ids (such as `forge.labels`); when the doctor reports one you don't
understand, look it up under [Troubleshooting by check id](#troubleshooting-by-check-id).

What you end up with, in one directory:

| Path | What it is |
|---|---|
| `compose.yaml` | The release's compose file: every image pinned by `@sha256` digest. |
| `secrets/` | Mode `0700`. The machine secrets the `bootstrap` service makes (`join_token`, `operator_token`, `vault_key`, each `0600`), and any credential you keep as a file. |
| `data/` | Mode `0700`. The database: config revisions, the vault's ciphertext, the work. |
| `config/` | Empty in db mode. In file mode, `jumpmaster.config.json`, the config `init` writes. No secrets. |
| `.env` | Optional: `JM_UID`/`JM_GID` when your user is not uid 1000, and the stick settings in [`.env.example`](../../deploy/.env.example). Never a token. |

Four services: `bootstrap` (runs first and exits: it makes the directories and the machine
secrets), `jumpmaster` (the server and UI, no Docker access), `stick` (the only one with the Docker
socket; it starts a container, a *drop*, per agent task) and `init` (the scripted install only,
never started by `up`).

## Prerequisites

You need all of these before step 1.

- **A host:** Linux (amd64 or arm64) with a **rootful Docker Engine 27.0 or later**, or macOS with
  **Docker Desktop**. Engine 29.9.2 is the version tested so far. **Docker Compose v2**
  (`docker compose version`; any v2 release). On Linux, run the `docker` commands as an ordinary
  user in the `docker` group. If the host gives you only root (a fresh VPS, say), see
  [Hosts with only root](#hosts-with-only-root).
- **Not supported in this release: rootless Docker.** Its user-namespace uid mapping contradicts
  the host-uid install: `init` refuses to run under it, and the doctor's
  `config.uid` reports `skip: rootless unsupported in this release`. Use a rootful engine.
- **Claude:** a Claude Pro, Max, Team or Enterprise plan, and the Claude CLI (`claude`) on any
  machine with a browser, to run `claude setup-token` once.
- **GitHub:** a repository (`your-org/your-repo`) with a GitHub Actions workflow that runs its
  tests on `pull_request`, plus **either** two bot accounts (an author and a reviewer, the
  default, "two-bot") **or** [starter mode](#starter-mode) (your account alone). The setup wizard
  recommends which from the repository's owner and visibility. The default branch needs a
  ruleset ([Branch rules](#branch-rules)): on a **private** repository GitHub offers rulesets only
  on a paid plan (GitHub Pro for a personal account, GitHub Team for an organization); on a free
  plan, use a public repository.
- **Verification:** `cosign` v3, or Docker to run cosign from its image (step 1 shows both).
- `curl`, and `sha256sum` (Linux) or `shasum` (macOS).

The host reaches `ghcr.io`, `pkg-containers.githubusercontent.com`, `api.github.com`,
`github.com`, the Sigstore hosts and `api.anthropic.com`; see [Stick](#stick) for the stick's
list.

## Install in the browser

### Step 1: Download and verify the release

Make an empty directory, download the release's four files into it, check that `SHA256SUMS` was
signed by this repository's release workflow from a version tag on `main`, and check the files
against it. These are the README's first four commands; releases are listed at
<https://github.com/x-a-n-d-e-r-k/jumpmaster/releases>.

```sh
mkdir jumpmaster && cd jumpmaster
for f in compose.yaml images.lock.json SHA256SUMS SHA256SUMS.sigstore.json; do curl -fsSLO "https://github.com/x-a-n-d-e-r-k/jumpmaster/releases/latest/download/$f"; done
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-trigger push \
  --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
  SHA256SUMS
sha256sum -c SHA256SUMS        # macOS: shasum -a 256 -c SHA256SUMS
```

For a particular release (a release candidate, say), replace `latest/download` with
`download/<version>`, for example `download/v0.4.0-rc.1`.

Optionally, check the images the compose file names: the server, the stick and the egress proxy
(the stick checks every trooper and proxy image itself before it runs one; see
[Image trust](#image-trust)):

```sh
for ref in $(grep -o 'ghcr\.io/x-a-n-d-e-r-k/jumpmaster-[a-z-]*@sha256:[0-9a-f]*' compose.yaml | sort -u); do
  cosign verify \
    --certificate-identity-regexp '^https://github\.com/x-a-n-d-e-r-k/jumpmaster/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    --certificate-github-workflow-trigger push \
    --certificate-github-workflow-repository x-a-n-d-e-r-k/jumpmaster \
    "$ref" > /dev/null && echo "verified $ref"
done
```

Each must print `verified`; a failure prints why. Stop if any fails.

Without cosign installed, define this and use `cosign_docker` in place of `cosign` in both commands
above. It mounts only the two release files `verify-blob` reads, read-only, never the install
directory (which holds `secrets/` once it runs):

```sh
cosign_docker() {
  docker run --rm -w /w \
    -v "$PWD/SHA256SUMS:/w/SHA256SUMS:ro" \
    -v "$PWD/SHA256SUMS.sigstore.json:/w/SHA256SUMS.sigstore.json:ro" \
    ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d "$@"
}
```

The release's `compose.yaml` carries every image digest itself, so this check is the trust in the
download; the images are pinned whatever you skip. More in
[SECURITY.md](../../SECURITY.md#verifying-a-release).

### Step 2: Start it

```sh
docker compose up
```

It stays in the foreground so you can read its output (`docker compose up -d`, then
`docker compose logs -f jumpmaster`, is the same in the background). The `bootstrap` service runs
first, as your user: it makes `secrets/` and `data/` (`0700`) and `config/`, and generates
`secrets/join_token`, `secrets/operator_token` and `secrets/vault_key` (`0600`); then the server
starts, and the stick pairs with it using the join token. Nothing needs to be written by hand.

The server prints one line you need, beginning `JUMPMASTER SETUP CODE:`. Each start prints a new
code (`docker compose logs jumpmaster` shows it again), and
`docker compose exec jumpmaster jumpmaster ctl setup-code` prints a fresh one.

The UI is at <http://127.0.0.1:7420/>, on the host only. From another machine, tunnel it:
`ssh -L 7420:127.0.0.1:7420 <host>`, then open the same address on your machine.

**If your user is not uid 1000** (compose runs the server as uid 1000 unless `.env` says
otherwise), the first `up` can stop with `bootstrap` saying the install directory is not
writable, and the line to run:

```text
jumpmaster bootstrap: the install directory is not writable (EACCES): set JM_UID and JM_GID in .env to your user: printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" > .env
```

Run that `printf` line in the install directory, then `docker compose up` again. Other ownership
problems (a directory made by `sudo`, or by the engine as root) print their own `chown` line; see
[Troubleshooting](#troubleshooting).

### Step 3: Claim the install

Open <http://127.0.0.1:7420/>: a new install sends you to **Set up Jumpmaster**. Enter the setup
code and press **Continue**, then choose the operator passphrase you will log in with (at least
12 characters). That ends setup mode: from now on every page needs the login.

On a host with no browser, claim it from the shell instead (the passphrase is read without echo,
so it lands neither on screen nor in your shell history):

```sh
read -rs JM_PASS && printf '%s' "$JM_PASS" | docker compose exec -T jumpmaster jumpmaster ctl passphrase set
```

### Step 4: The setup wizard

After the login, the home page shows **Finish setup** and the wizard's five steps, each at its own
address (`/setup/claude`, `/setup/forge`, `/setup/stick`, `/setup/project`, `/setup/doctor`).
**Do this later** skips a step; **Dismiss setup** hides the wizard (home keeps **Add a project**).
Saving a credential asks for your passphrase again (sudo, good for five minutes).

1. **Claude** (`/setup/claude`). On your own computer run `claude setup-token`, sign in with the
   account whose plan pays for the work, and paste the token (it starts `sk-ant-oat01-`). Give
   **Made on** if you made it on another day: it starts the year-long expiry reminder. Pick your
   **Plan**. See [Claude token](#claude-token) and [Claude plan](#claude-plan).
2. **GitHub** (`/setup/forge`). Under **Which repository?** name `your-org/your-repo` and press
   **Recommend**: Jumpmaster reads the repository's owner and visibility and recommends two-bot
   or starter mode, and stops early when a private repository on a free plan can't have a
   ruleset. The token links open GitHub's token page pre-filled with the permissions in
   [Tokens](#tokens); check the resource owner and the repository there, generate, and paste
   each token under **The tokens** (**Author token**, **Reviewer token** for two-bot, **Read
   token** for a private repository). Each is tested with GitHub before it is saved, and never
   shown back. Tick **Starter mode** only if you chose it.
3. **Runner** (`/setup/stick`). The stick starts beside the server under Compose, so this usually
   says it has checked in. If not, `docker compose logs stick` says why.
4. **Project** (`/setup/project`). Name the repository and press **Detect**: Jumpmaster reads its
   default branch's root (it writes nothing) and proposes a **Stack** and the **Checks (gates)
   every change must pass**. Review them, pick the **Accounts**, and press **Create the
   project**. This adds a zone; it asks for confirmation first (see
   [Guarded changes](operate.md#guarded-changes-and-the-confirmation-page)). Egress starts in
   `monitor`. Under **On GitHub: the ruleset and the code owners**, enter your GitHub login and
   press **Show** for the two files of step 5.
5. **Doctor** (`/setup/doctor`). **Run the doctor**; see step 6.

### Step 5: The GitHub page

Each zone has a GitHub page, `/zones/<zone>/github` (the **GitHub** link on Zones and on home). It
writes nothing to GitHub: it gives you links and generated files, and you click.

- **Which accounts** and **Create the tokens**: the recommendation and the pre-filled token links.
- **The branch ruleset**: open the repository's Rulesets, then New ruleset → Import a ruleset,
  choose the downloaded `jumpmaster-<zone>-ruleset.json`, review it and click Create. It requires a
  pull request and the CI jobs Jumpmaster detected, with no bypass. Doctor check:
  `forge.branch-rules`.
- **Code owners for the protected paths**: the `.github/CODEOWNERS` text (the reviewer bot on
  `*` first, then the protected paths owned by people), and a link to create the file on GitHub.
  Commit it. Doctor check: `forge.codeowners`.
- **Give the accounts access**: the collaborators page and a checklist naming each bot login
  (Write role; accept the invitation as that account).

The labels (`agent-ready`, `agent-retry`) are created from the doctor: `forge.labels` fails while
one is missing, and its **Create the missing labels** button creates them as the author bot.

### Step 6: Run the doctor to zero fails

On `/doctor` press **Run the doctor** (or
`docker compose exec jumpmaster jumpmaster ctl doctor`). Each check shows `PASS`, `WARN`,
`FAIL` or `SKIP`; every one that isn't a pass shows its fix and an action: a link to the page that
fixes it (Settings, the zone page, the GitHub page), a GitHub page (with the generated file to
bring there, as a download), or a button for the two writes (**Create the missing labels**,
**Run a doctor drop for &lt;zone&gt;**). [Troubleshooting by check id](#troubleshooting-by-check-id)
lists each check with its action. Fix each `FAIL` and run it again until it shows `0 fail`.

At this point these warnings are expected, and the doctor drop clears the first two:

- `zone.egress`: egress is in monitor mode and no drop has run yet;
- `zone.doctor-drop`: no doctor drop has run yet;
- `zone.identity`, in starter mode only: the starter-mode cost (it stays; see
  [Starter mode](#starter-mode)).

**The doctor drop** runs your zone's real image, gates, services and egress setting on the default
branch, in a real drop: it proves the Claude token, the clone, the services and the gates, and
spends one turn of Claude usage. Press **Doctor drop: &lt;zone&gt;** on `/doctor` (or
`ctl doctor <zone> --drop`) and run the doctor again when it has finished; see
[Doctor drop](#doctor-drop).

**Then enforce egress.** On the zone page's **Egress** section, **Observed in the last 14 days**
lists every host the zone's drops reached, with the drops that reached it. Tick the hosts your
gates need (a package registry, say), press **Adopt ticked**, confirm, then set **Mode** to
`enforce` and **Save**. Leave out anything you don't expect. Run another doctor drop: it must pass
under `enforce`. See [Egress](#egress). Doctor checks: `zone.egress`, `zone.doctor-drop`,
`zone.services`.

### Step 7: File the first issue from the intake page

Open the zone's intake page, `/zones/<zone>/intake` (the **Intake** link in home's Crew table).

1. **The goal.** Fill in what the project is for and its objectives, and **Render the stub**.
   Jumpmaster doesn't commit it: `GOAL.md` is a protected path no agent may write. Commit it
   yourself by pull request when you're ready; the first issue doesn't wait for it.
2. **The first issue.** Give it a title, the context, acceptance criteria and the tests that prove
   it, and **File the issue**. It is filed on GitHub as a ready issue (`agent-ready`) at once, and
   the next pass picks it up. Submitting twice never files twice.

A small, testable change makes the best first issue. Any issue you label `agent-ready` yourself
works the same way.

### Step 8: Watch the pull request merge

The status line at the top of home says what Jumpmaster is doing and why it waits (for example
`Working: implement #1 in <zone>, …` or `Waiting on CI for PR #2 (…)`), with the control that
moves it on. The home page lists the work item as it moves: an implement drop opens a pull request
from an `agent/issue-*` branch, a review drop reviews it, CI runs, and the server merges it when
the review verdict, CI and the pull request head all agree on one commit. In two-bot mode the
reviewer account approves on GitHub; in starter mode the verdict shows only in Jumpmaster.

If the item parks, its page says why (a failing gate, a ruleset problem, a refused permission).
Fix that, then add the `agent-retry` label to the issue. Run the doctor again whenever something
looks wrong.

To see the image and egress proof for each drop, read the stick's log:

```sh
docker compose logs stick | grep -E '"event":"(image-verified|egress)"'
```

Each drop logs `image-verified` with `"via":"cosign"` (or `"cache"`) for its trooper and proxy
images, and `egress` with `"mode":"enforce","proxy":"ready"`.

The [operate runbook](operate.md) covers what comes next: zones, settings, rotation, the status
line, backups.

## The scripted install

`jumpmaster init` writes the config file from the command line, for an install you want to keep
as code. The config file means **file mode**: the file is the config, the UI shows it read-only,
and `jumpmaster ctl config reload` applies an edit without a restart. Credentials are files under
`secrets/`.

<a id="step-1-write-env"></a>

### Write .env if your user is not uid 1000

Do the whole install as an ordinary user (never root: see
[Hosts with only root](#hosts-with-only-root)). Compose runs the server as uid and gid 1000 unless
`.env` names another:

```sh
mkdir jumpmaster && cd jumpmaster
printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" > .env
```

Then download and verify the release into this directory as in
[step 1](#step-1-download-and-verify-the-release).

### Write the tokens as files

Each credential goes in its own file under `secrets/`, named for it: mode `0600`, the token on one
line. A file wins over anything entered in the browser. Never `echo` a token into a file: that
leaves it in your shell history. In bash or zsh, this helper asks for each one and reads it
without showing it (paste, then Enter); it writes nothing, and says so, if the input is empty:

```bash
mkdir -p -m 700 secrets
put() {
  local t
  printf 'Paste the %s, then press Enter: ' "$1" >&2
  if ! IFS= read -rs t || [ -z "$t" ]; then echo >&2; echo "nothing written to secrets/$1" >&2; return 1; fi
  echo >&2
  ( umask 077 && printf '%s\n' "$t" > "secrets/$1" && chmod 600 "secrets/$1" ) && echo "wrote secrets/$1" >&2
}
put claude_token           # the Claude token
put github_author_token    # the author token
put github_reviewer_token  # two-bot only: the reviewer token
put github_read_token      # private repositories only
```

A token that is already in a file (copied from another machine, say) goes in with `install`,
which sets the mode as it copies:

```sh
install -m 0600 /path/to/token-file secrets/claude_token
```

The file must hold the token alone: one trailing newline is fine, anything else (spaces, a second
line, a byte-order mark an editor added) is refused at startup with the file's name. Which files a
zone needs follows from them: no reviewer file means no reviewer credential (starter mode), a read
file means a read token (a private repository). What each token is, and its exact permissions, is
under [Tokens](#tokens) and [Claude token](#claude-token). Doctor checks: `forge.author`,
`forge.reviewer`, `forge.author-reads`, `forge.reviewer-reads`, `forge.admin`,
`forge.private-clone`, `claude.token-age`, `config.secret-files`.

Set the branch ruleset before any agent work: [Branch rules](#branch-rules) for two-bot or for
starter mode. Doctor checks: `forge.branch-rules`, `forge.codeowners`, `forge.ci`.

<a id="step-5-run-init"></a>

### Run init

```sh
docker compose --profile init run --rm init --repo your-org/your-repo
```

Starter mode adds `--identity starter` (and, on a personal repository, `--author-may-be-admin`;
see [Starter mode](#starter-mode)). `init`:

- runs `bootstrap` first (the directories and the machine secrets, only when absent);
- reads the author token from `secrets/github_author_token` and, with it, the repository's
  visibility and the build files at the root of its default branch (GET requests only);
- picks a [stack preset](#presets) and writes the repository's gates (its install and test
  commands) from those files;
- writes `config/jumpmaster.config.json`: one zone, egress `monitor`, signed images only, CI
  required, crew off; a private repository also gets `reviewReadToken: true`; with
  `secrets/claude_token` present, `claude.tokenCreatedAt` is that file's date;
- tightens any token file others can read to `0600`, and says so;
- prints the zone id (`<zone>`, the repository name in lower case), the preset, the gates, and
  what is left to do. It writes nothing into `.env` and never prints a token.

Exit codes: `2` when the root holds more than one stack (or none): rerun with
`--preset node|python|go|jvm`; `3` when a config exists: `--force` replaces it, and **rewrites the
whole config**, so any edits you made (gates, `egress.allow`, anything else) are lost and must be
made again (generated secrets are kept); `4` when a directory isn't writable: the install
directory must be owned by the `.env` user; `1` for anything else, with the reason (a refused
token, root, rootless Docker). `--help` lists every flag.

If the host can't reach GitHub when you run `init`, `--offline --preset <preset>` (plus `--private`
for a private repository) writes the config from the flags instead, with no gates: add them by
hand.

Read the gates `init` printed. They are what every agent change must pass inside its drop: if the
repository's tests need another command, edit `gates` in the config now. Doctor check:
`zone.preset`.

### Start, claim and check it

```sh
docker compose up -d
read -rs JM_PASS && printf '%s' "$JM_PASS" | docker compose exec -T jumpmaster jumpmaster ctl passphrase set
docker compose exec jumpmaster jumpmaster ctl labels <zone>
docker compose exec jumpmaster jumpmaster ctl doctor
```

`ctl passphrase set` claims the install without a browser (or open the UI and use the setup code,
as in [step 3](#step-3-claim-the-install)); `ctl labels <zone>` creates the missing labels
([Labels](#labels)). Fix what the doctor reports until it shows `0 fail`, then run the doctor drop
(`ctl doctor <zone> --drop`) and enforce egress: add the hosts the doctor's `zone.egress` lists to
the zone's `egress.allow` in the file, set its `mode` to `enforce`, run
`docker compose exec jumpmaster jumpmaster ctl config reload`, and run another doctor drop.
`ctl doctor <zone> --artifacts <dir>` writes the generated ruleset and CODEOWNERS files of any
fails into a directory. Always use `docker compose exec` for `ctl`, never `docker compose run`: a
new container is not the running server.

## Config as code

An install is in one of two modes, and `jumpmaster ctl config show` says which:

- **File mode**: `config/jumpmaster.config.json` exists. The file is the config; the UI shows it
  read-only. After editing it, `jumpmaster ctl config reload` applies it without a restart (an
  invalid file is refused, the server keeps the revision it had, and `config.file` fails with each
  problem by path).
- **Db mode**: no file (the browser path), or the file was adopted. The config lives in the
  database as revisions; the UI and `ctl config set` / `ctl settings set` / `ctl zones set` change
  it, every change applies at the next pass, and Settings, History lists and reverts revisions.

`jumpmaster ctl config adopt` copies the file into the database and switches to db mode; from then
on the file is ignored (the startup log and the doctor say so). `jumpmaster ctl config mode file`
switches back, and refuses unless the file equals the current export, so nothing is lost. The
export is written on the host, from the container's stdout (`-T` keeps the file free of carriage
returns):

```sh
docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json
```

Two ways to keep the config in version control:

- **Db mode, import.** Keep the exported file in your repository. To change the install, edit it,
  put it in `config/` under another name (the container reads `config/` as `/config`), check what
  it would change, then apply it:

  ```sh
  cp jumpmaster.next.json config/jumpmaster.next.json
  docker compose exec -T jumpmaster jumpmaster ctl config import /config/jumpmaster.next.json --dry-run
  docker compose exec -T jumpmaster jumpmaster ctl config import /config/jumpmaster.next.json
  ```

  The dry run prints each change and any refusal; the import is one new revision, conditional on
  the revision it read.
- **File mode, reload.** Deploy the file to `config/jumpmaster.config.json` and run
  `docker compose exec jumpmaster jumpmaster ctl config reload`.

`listen` and `dataDir` are boot settings, read before the database opens: from the file in file
mode, else from the environment (`JM_LISTEN_HOST`, `JM_LISTEN_PORT`, `JM_ALLOWED_HOSTS`,
`JM_TLS_TERMINATED`, `JM_DATA_DIR`); a change needs a restart. `mcp.enabled` and
`mcp.maxBodyBytes` are editable but also take effect at the next restart (`config.restart`).

## Upgrade

From M4, or any earlier release with Compose, replacing `compose.yaml` is the whole upgrade:
`secrets/`, `config/`, `data/` and `.env` keep working. Take a backup first if you want a way back
([backup and restore](operate.md#backup-and-restore)).

1. **Drain.** `docker compose exec jumpmaster jumpmaster ctl pause <zone>` for each zone, then wait
   until the home page shows nothing running.
2. **Replace `compose.yaml`.** Download and verify the new release's four files into the same
   directory, as in [step 1](#step-1-download-and-verify-the-release) (with `cosign_docker`, only
   the two release files are mounted, never `secrets/`).
3. **`docker compose up -d`.** Then `docker compose exec jumpmaster jumpmaster ctl resume <zone>`
   for each zone (a paused zone stays paused across the restart).
4. **Claim the login.** An install from before M4.5 has no operator: open the UI and enter the
   setup code from `docker compose logs jumpmaster` (see [step 3](#step-3-claim-the-install)), or
   run `read -rs JM_PASS && printf '%s' "$JM_PASS" | docker compose exec -T jumpmaster jumpmaster ctl passphrase set`.
   `ctl` and the stick are unaffected.

What carries over, and what may go:

- The config file means file mode, as before, read-only in the UI until you adopt it.
- The token files in `secrets/` are read by name; the new `bootstrap` service adds
  `secrets/vault_key`. The block `jumpmaster init` wrote into `.env` (between its
  `# jumpmaster init` markers, the `JM_REVIEWER_TOKEN_*` and `JM_READ_TOKEN_*` lines) is no longer
  read and may be deleted, as may a `secrets/github_reviewer_token` left beside a starter zone,
  which never uses it.
- **CODEOWNERS.** A two-bot install that followed the M4 runbook made the reviewer bot a code owner
  of the protected paths; and any repository whose CODEOWNERS has a `*` line (or lines for other
  paths) without the reviewer bot is caught too. Under the generated two-bot ruleset (code owner
  review on) such a zone parks its items with `code owner review blocks the reviewer bot: …`, and
  `forge.codeowners` fails. The file the zone's GitHub page generates has the right shape:
  `* @<reviewer-bot>` first, then the protected paths, owned by people only (the last match wins).
  Commit it in place of the old one.

**Going back.** A new release may migrate the database. An older release reads only the config
file, so in db mode **write the export to the config file before you downgrade** (the export line
in [Config as code](#config-as-code)), then restore the older `compose.yaml`. A `data/` restore
from before `adopt` returns to file mode with the file's zones. To undo a migration, restore the
backup you took before upgrading.

## Optional hardening

- **Address pools.** Each egress-controlled drop takes a `/28` from `JM_DROP_SUBNET_POOL` (default
  `172.30.0.0/16`). If that overlaps a network of yours, set another private range in `.env` and
  `docker compose up -d`. Docker's own `default-address-pools` (in `/etc/docker/daemon.json` on
  Linux, Docker Desktop → Settings → Docker Engine on macOS) should not overlap it either, for
  example:

  ```json
  { "default-address-pools": [{ "base": "10.200.0.0/16", "size": 24 }] }
  ```

- **The host at the drop gateway.** Drop networks are internal, with no address on the host's side
  of the bridge, and the stick proves at startup that a drop can't reach a listener on the host
  through the gateway before it advertises egress (`egress-v1`); the release's CI checks the same
  on every run. No `DOCKER-USER` rule is needed. On Linux, if you want a second layer anyway,
  refuse forwarded traffic from the drop pool to your LAN:
  `sudo iptables -I DOCKER-USER -s 172.30.0.0/16 -d 192.168.0.0/16 -j DROP` (adjust both ranges;
  make it persistent the way your distribution does).
- **Rootless Docker** is not supported in this release (see [Prerequisites](#prerequisites)).

## Troubleshooting

Look up a doctor check under [Troubleshooting by check id](#troubleshooting-by-check-id). For
anything else, `docker compose logs jumpmaster` and `docker compose logs stick` say why, and no
log ever contains a token. Common cases:

- **`bootstrap` names a `.env` line or a `chown` line.** It stops before anything else starts when
  it can't own the install's directories. Another user owns them (your user is not uid 1000):
  run the `printf … > .env` line it prints ([step 2](#step-2-start-it)). Root owns them (made by
  `sudo docker compose …`, or by an engine that creates missing bind directories): run the
  `sudo chown -R …` line it prints. Then `docker compose up` again.
- **`secrets/` is empty inside the containers on Docker Desktop** (the stick can't read
  `secrets/join_token`, or the server finds no machine secret, though the files are on the host).
  This happens when the install directory sits under a symlinked parent, such as macOS
  `/var/folders` or `/tmp`: the bind mount comes up empty. Run `docker compose down`, then
  `docker compose up`; if it persists, install under your home directory.
- **The setup code is lost.** `docker compose logs jumpmaster` shows the line again, and
  `docker compose exec jumpmaster jumpmaster ctl setup-code` prints a fresh one.
- **The passphrase is lost.** `docker compose exec jumpmaster jumpmaster ctl setup reopen` removes
  the operator and every session and prints a new setup code; or set a new passphrase with
  `ctl passphrase set` (above).

### Hosts with only root

If `id -u` prints `0` (as on many fresh servers), make an ordinary user first and do the whole
install as that user: the server holds your GitHub and Claude tokens, and running it as root would
let a bug in it act as root on the host's files. `bootstrap` and `init` refuse to run as root for
that reason.

```sh
adduser jumpmaster && usermod -aG docker jumpmaster
su - jumpmaster      # then start again
```

(`init --allow-root` runs as root anyway; the doctor's `config.uid` then warns for good.)

## Tokens

The setup wizard's GitHub step and each zone's GitHub page link GitHub's token page pre-filled with
these permissions; this is what they ask for. In the browser the tokens are `githubAuthorToken`,
`githubReviewerToken` and `githubReadToken` under Settings, Credentials; as files, the names below.

All GitHub tokens are **fine-grained personal access tokens** (Settings → Developer settings →
Personal access tokens → Fine-grained tokens), each with **Repository access: Only select
repositories → `your-org/your-repo`**, and an expiry you will remember to renew (the doctor warns
two weeks before it). Each account needs the **Write** role on the repository (Settings →
Collaborators; accept the invitation as that account), and neither bot may be an admin.

| File | Account | Repository permissions |
|---|---|---|
| `secrets/github_author_token` | the author bot (opens and merges pull requests) | Contents: Read and write · Pull requests: Read and write · Issues: Read and write · Metadata: Read-only · **no Workflows** |
| `secrets/github_reviewer_token` | the reviewer bot, a different account (two-bot only) | Pull requests: Read and write · Contents: Read-only · Metadata: Read-only |
| `secrets/github_read_token` | any account that can read the repository (private repositories only) | Contents: Read-only · Metadata: Read-only |

Also give the author token **Commit statuses: Read-only** and **Actions: Read-only**: the server
reads CI results through them (a fine-grained token can't read check runs, so Jumpmaster reads
GitHub Actions jobs, which carry the same names). On a public repository every read succeeds with
any token, so a missing read permission only shows on a private one.

Never give any token Administration or Workflows: Administration could change the ruleset that
guards merges, and Workflows could change CI.

**Who owns the repository matters.** A fine-grained token reaches only repositories owned by its own
account or by an organization the account belongs to (and the organization may have to approve
it). Two bots on a repository in an organization: fine-grained tokens, as above. Bots that are
collaborators on a repository owned by another personal account: GitHub's fine-grained tokens don't
cover that, so such a bot needs a classic token with the `repo` scope (`public_repo` for a public
repository); keep it for Jumpmaster alone. With your own account as the author on your own
repository, set `authorMayBeAdmin` (see [Starter mode](#starter-mode); the same applies in
two-bot with a machine reviewer).

When the wizard, `init` or the doctor says a token was rejected (401), it is expired, revoked or
mistyped: replace it under Settings, Credentials (or `ctl secrets set <name>`, the value on
stdin), or write the new file with `put` and run `docker compose exec jumpmaster jumpmaster ctl
secrets reload`. The [operate runbook](operate.md#credentials-and-rotation) covers rotation.

### Claude token

On any machine with a browser and the Claude CLI, run `claude setup-token`, sign in with the
account whose plan pays for the work, and copy the token it prints (it starts `sk-ant-oat01-`).
Paste it in the wizard's Claude step (or Settings, Credentials: `claudeToken`), or write it with
`put claude_token`. It lasts a year. A token entered in the browser is dated the day it is entered
(or the **Made on** date you give); in file mode `init` records the date of the file as
`claude.tokenCreatedAt` in the config (correct it if you made the token on another day). The
doctor's `claude.token-age` warns from day 330, and so does a banner on home and on Settings,
Credentials. To renew, run `claude setup-token` again and replace the token the same way.

The agent inside each drop runs Claude Code with this token, so the agent can read it. Egress
limits where it can send it (see [Egress](#egress)).

### Claude plan

`claude.plan` in the config declares your plan (`pro`, `max`, `team_standard`, `team_premium` or
`enterprise`; default `pro`); `init --plan max` sets it. It isn't detected. Jumpmaster runs Fable
only on a plan that includes it and only with `claude.fableModel` set; `claude.plan` flags a
`fableModel` your plan doesn't include.

### Read token

A private repository needs `secrets/github_read_token` (Contents: Read-only, Metadata: Read-only):
review, crew and doctor drops clone with it, since they never get a write token. Detection (the
wizard's project step, or `init`) sees the repository is private and sets `reviewReadToken: true`;
enter the token as `githubReadToken` under Settings, Credentials, or write the file. A zone with
`reviewReadToken` and no read token is parked until one arrives. Doctor check:
`forge.private-clone`.

## Branch rules

On GitHub: the repository → Settings → Rules → Rulesets → New ruleset → New branch ruleset.

A private repository can have rulesets only on a paid plan: GitHub Pro for a personal account,
GitHub Team for an organization. On a free plan there is no Rulesets page for a private repository
(and `gh api` answers 403); make the repository public or use a paid plan. The doctor's
`forge.branch-rules` says so when it finds no ruleset on a private repository.

- **Enforcement status:** Active.
- **Target branches:** Include default branch.
- **Bypass list:** empty. Neither bot, nor a team or role either belongs to, may bypass.
- **Require a pull request before merging:**
  - two-bot: **Required approvals: 1**, and **Dismiss stale pull request approvals when new
    commits are pushed**;
  - starter mode: Required approvals: 0.
- **Require status checks to pass:** add each check your CI workflow reports (a job name, such
  as `test`), and for each one **select GitHub Actions as the source** (not "any source"), so no
  other app can report it green.
- **Require review from Code Owners:**
  - two-bot: on. The code owners of the protected paths in `.github/CODEOWNERS` are people (you,
    and anyone else who may approve), never the bots; Jumpmaster never merges a pull request that
    touches a protected path, so GitHub blocks only the hand merge until a named person approves.
    This changes no automation **only if the reviewer bot owns every other owned path**: GitHub
    merges a pull request only when a code owner of each file it touches approved. The generated
    file starts with `* @<reviewer-bot>` and gives the protected paths back to people on the lines
    after it (the last match wins). If your file already has a `*` line (or any line for other
    paths), name the reviewer bot on it, or nothing will merge; Jumpmaster parks the zone's items
    with that fix, and `forge.codeowners` fails, until you do;
  - starter mode: off. You are the author and the only code owner, and GitHub never lets an author
    approve their own pull request, so it would block those pull requests for good. Jumpmaster parks
    every pull request that touches a protected path for you to review and merge by hand instead
    (`forge.codeowners`).

The same with `gh` (two-bot; for starter mode set `required_approving_review_count` to 0 and `require_code_owner_review` to false). Each
`context` is a check name your CI reports; `integration_id` 15368 is GitHub Actions:

```sh
gh api -X POST repos/your-org/your-repo/rulesets --input - <<'JSON'
{
  "name": "jumpmaster",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [ { "context": "test", "integration_id": 15368 } ] } }
  ]
}
JSON
```

Jumpmaster reads the rules through its tokens on every pass, and parks items with
`unsafe branch protection: …` until they are right. Rule types it can't satisfy with its own merge
(a merge queue, required deployments) park items too: leave them off the default branch.

### CI

The repository needs a GitHub Actions workflow that runs its tests on `pull_request`, with no
secrets exposed to pull-request runs, and the ruleset must require its checks
(`ciRequired: true`, which `init` writes). Agent branches run your workflows, and `.github/**` is a
protected path, so an agent change to a workflow parks instead of merging. Under Settings → Actions
→ General → Workflow permissions, keep **Read repository contents**. Doctor check: `forge.ci`.

## Labels

The zone uses `agent-ready` (`readyLabel`) and `agent-retry` (`retryLabel`); with the crew on,
also `agent-staged`. When one is missing, `forge.labels` fails and its action, **Create the
missing labels** on `/doctor` (or `jumpmaster ctl labels <zone>`), creates the configured ones as
the author bot; it creates nothing else and works in observe mode too, but not while the kill
switch is engaged. You can also make them yourself under the repository's Issues → Labels, or with
`gh label create agent-ready --repo your-org/your-repo`. Doctor check: `forge.labels`.

## Starter mode

Starter mode runs with one GitHub account, the author, and no reviewer account. It is opt-in:
**starter (one account)** under **Accounts** when you add a project (the wizard recommends it when
it fits), or `init --identity starter`. The reviewer drop still reviews every pull request, but its verdict is
kept in Jumpmaster and shown in the UI, not posted on GitHub, and the author merges when that
verdict and CI pass on the same commit. What it costs, in the doctor's words:

> starter mode: the author token can merge any green PR, including an unreviewed one; it is held by the server and by the trooper's root process in implement, heal and resolve drops. Use a fine-grained token for this repository only, with no Workflows permission, or add a reviewer identity.

It requires:

- a **fine-grained** author token limited to the repository, with no Workflows or Administration
  permission (otherwise the zone is parked: `credential.kind`);
- `ciRequired: true` (the default), and a ruleset with a pull request rule (0 approvals),
  required checks with GitHub Actions as the source, and no bypass ([Branch rules](#branch-rules)).

On a **private** personal repository, rulesets need GitHub Pro ([Branch rules](#branch-rules)).
On a **personal repository**, only the owner can make a fine-grained token for it, and the owner
is always an admin, so the author is your own account: tick **The author token belongs to the
repository's owner** when you add the project, or run `init` with
`--identity starter --author-may-be-admin`. The doctor's `forge.admin` then confirms the token
has no Administration permission.

A starter zone needs no reviewer token, and never uses one if it is there. To move to two-bot
later, see the fix under [`zone.identity`](#zoneidentity).

## Presets

A preset is a prebuilt, signed trooper image for one stack, and the hosts its installs reach:

| Preset | Detected from | Typical gates |
|---|---|---|
| `node` | `package.json` (npm, pnpm or yarn by lockfile) | install, then the `test`, `typecheck` and `lint` scripts that exist |
| `python` | `pyproject.toml`, `setup.py`, `requirements*.txt` | a venv and `pip install`, or `uv sync`; then `pytest` |
| `go` | `go.mod` | `go build`, `go vet`, `go test` |
| `jvm` | `mvnw`, `pom.xml`, `gradlew`, `build.gradle` | `mvn verify` or `./gradlew check` |

Detection (the wizard's project step, **Add a project**, or `init`) picks the preset from the
repository's root files and writes explicit `gates` into the config; the server never re-reads
them at dispatch. A repository with more than one stack at its root needs a choice of **Stack**
(`--preset` for `init`). You can change `gates` any time on the zone page's **Stack** section; the
next drop uses them, with no restart. The release's server
resolves a preset to its image by digest from the image lock it carries, so the config never
names an image tag. Doctor check: `zone.preset`.

To use your own image (more tools on top of a preset), build it `FROM` the preset's image by
digest, push it, and set the zone's `image` to its digest reference instead of `preset`; it must
also be pinned on the stick (next section).

### Pinning an image by digest

A digest reference (`name@sha256:<64 hex>`) names exact content; a tag can be moved. To get one:

- **An image in a registry** (a service such as a database, or anything you pulled):
  `docker buildx imagetools inspect registry.example.com/team/image:1` prints its digest on the
  `Digest:` line. The pin is `registry.example.com/team/image@sha256:<digest>`.
- **An image you built locally** has no registry digest: `imagetools` can't see it. Push it to a
  registry the stick can pull from (`docker push registry.example.com/team/image:1`), then read
  the pushed digest with
  `docker image inspect --format '{{index .RepoDigests 0}}' registry.example.com/team/image:1`.

Use the digest reference in the config, and list it in the stick's `JM_ALLOWED_IMAGES` in `.env`
(comma-separated), then `docker compose up -d`: under the signed policy a stick runs an image this
repository didn't sign only when the operator pinned that exact digest. An image that was never
pushed can't run on the release's stick.

## Services

A zone may declare services (a database for the tests, say). Each service image must be a digest
reference, pinned in the stick's `JM_ALLOWED_IMAGES` ([Pinning an image by digest](#pinning-an-image-by-digest)).
With egress on, a zone may declare at most 6. Doctor check: `zone.services`.

## Egress

Egress control limits where a drop's network traffic can go. `init` writes `monitor`:

- `monitor`: each drop has its own internal network whose only way out is a per-drop proxy; any
  public host is allowed and recorded, and the doctor lists the hosts not on the allow list.
- `enforce`: the proxy allows only HTTPS (`CONNECT` on port 443) to listed public hosts. Tools
  that ignore proxy settings have no route out at all, and DNS answers nothing.
- `off`: no control (the doctor warns).

The allow list is `api.anthropic.com` and `github.com`, plus the preset's hosts (for example
`registry.npmjs.org` for `node`, `pypi.org` and `files.pythonhosted.org` for `python`), plus the
zone's `egress.allow` (host names, or `*.` and a name for its subdomains; never an IP, port or
path). Move to `enforce` as in [step 6](#step-6-run-the-doctor-to-zero-fails). Doctor check:
`zone.egress`.

What egress does not stop: anything sent to an allowed host. An implement drop pushes to
`github.com` with the author token (held by the trooper's root process, not the agent), and the
agent's Claude token reaches `api.anthropic.com`.

## Doctor drop

`jumpmaster ctl doctor <zone> --drop` asks for one doctor drop: on the zone's real stick, image,
egress and services, it clones the default branch, starts the services, runs the gates and makes
one Claude call. It holds no write token, never writes to GitHub, and spends one turn of usage, so
it runs only when you ask (`--cancel` withdraws a queued one). The zone must be active. It leases
after any other queued work, and it still runs near the usage limit (see [Usage](#usage)): its one
Claude call is small, but it holds a stick slot for the whole gate run. Its usage report never
starts a credits stop. It waits
while usage is paused at the limit, during a credits stop, while the kill switch is on, and until a
stick that can run the zone is free. The reply to `--drop`, and the `zone.doctor-drop` line while it
is queued, say which: `held: usage paused until …`, `held: credits stop`, `waiting for a stick: no
stick is connected`, `waiting for a stick that can run zone …`, or `waiting for a free stick slot`. Doctor check: `zone.doctor-drop`.

## Stick

The stick is the only container with the Docker socket, which is root-equivalent on the host. It
enrolls with the server using `secrets/join_token`, keeps its enrollment, Sigstore trust root and
verify cache in the `jm-stick` volume, and runs `JM_SLOTS` drops at once (default 1).

What it needs, in short (the full account is the release runbook's
[What a stick needs to verify images](release.md#what-a-stick-needs-to-verify-images)):

- **Its own outbound traffic**, which Jumpmaster doesn't restrict; allow it if your host filters:
  `ghcr.io` and `pkg-containers.githubusercontent.com` (image pulls), `tuf-repo-cdn.sigstore.dev`
  (the Sigstore trust root), `rekor.sigstore.dev` and `fulcio.sigstore.dev` (the transparency log
  and the CA), and the server.
- **Docker Engine 27.0 or later.** At startup the stick proves that a drop network keeps a drop off
  the host, and only then advertises `egress-v1`; otherwise its log says
  `egress-v1 not advertised:` and why, and egress zones' drops stay queued.
- **The signed image policy**, which the release's stick runs: images only by digest, each verified
  with cosign or pinned in `JM_ALLOWED_IMAGES`; it refuses to start if a pin isn't a digest
  reference or if `SIGSTORE_*`, `COSIGN_*` or `TUF_MIRROR` is set.

A zone's drops wait while no live stick can run them; `stick.capabilities` says what the stick
lacks. Doctor checks: `stick.seen`, `stick.capabilities`.

## Image trust

The config written by `init` sets `requireSignedImages: true` (dispatch only to a stick that
verifies signatures); a browser install starts with it off, and you can turn it on under Settings,
Install. Either way, the release's stick runs the `signed` policy: before it creates anything for a drop it verifies the trooper and proxy images
with cosign against this repository's release workflow, then pulls them by digest. A verified
digest is cached for 7 days, so a short Sigstore outage doesn't stop known images. A tag never
runs. Doctor check: `stick.image-policy`.

If a drop fails with "the zone's image … is older than the … role", the zone runs an image built
before that kind of drop existed: rebuild the zone image on the current trooper (`FROM` the
release's preset), or use the release's preset.

## Listen

The server listens on `0.0.0.0:7420` inside its container, and compose publishes it on
`127.0.0.1:7420` only. Its pages need the operator login, but the login crosses the wire in clear,
so don't publish it on another interface; reach it through an SSH tunnel. A browser on another host name must be listed in `listen.allowedHosts`
(`JM_ALLOWED_HOSTS`), and only behind a TLS terminator you run and declare with
`JM_TLS_TERMINATED=1` (or `listen.tlsTerminated: true` in the file): without it the doctor fails,
because the passphrase would cross the network in clear. Declared, the login cookies are `Secure`.
Doctor check: `config.listen`.

## UID

The server, `bootstrap` and `init` run as `JM_UID:JM_GID` from `.env` (1000:1000 without it),
the host user who owns `secrets/`, `config/` and `data/`. If the server can't read a secret file, it stops at startup naming the
variable, the path and its uid: check `.env` matches `id -u` and `id -g`, and the files belong to
that user (`ls -ln secrets`). Doctor check: `config.uid`.

## Usage

Jumpmaster watches your Claude usage. Near the limit it runs only finishing work (review, heal,
resolve) and doctor drops you asked for; at the limit it pauses until the window resets; if a drop runs on extra-usage credits it
stops dispatch and raises a briefing for you to rule on (`/briefings`). Doctor check: `usage.gate`.

## Crew

The crew (off by default) plans issues from `GOAL.md` on its own; see the
[M3 crew runbook](m3-crew.md). Doctor checks: `zone.goals`, `zone.crew-cap`.

## Troubleshooting by check id

Each check prints its own fix; this says what it means. **Action** is the control the doctor's
page (`/doctor`) offers beside a fail or a warn, and `ctl doctor` prints as `action:`.

### `config.listen`

**Action:** Open Settings, Install (`/settings/install`), where the boot settings show with where each is set.

Where the UI listens and which host names it accepts. Inside the container `0.0.0.0` passes:
compose publishes `127.0.0.1` only. It fails when `allowedHosts` names a host other than loopback
and no TLS terminator is declared (`JM_TLS_TERMINATED=1`). See [Listen](#listen).

### `config.uid`

**Action:** this entry (the doctor links here).

The uid the server runs as. `warn` as root: set `JM_UID`/`JM_GID` in `.env` to an ordinary user
([UID](#uid), and [Hosts with only root](#hosts-with-only-root)). An install made with `init --allow-root`
keeps this warning for good. `skip` with "rootless unsupported": use a rootful engine
([Prerequisites](#prerequisites)).

### `config.file`

**Action:** Open Settings, History (`/settings/history`).

Where the config comes from. With a config file the install is in file mode: the file is the
config, and after editing it `jumpmaster ctl config reload` applies it without a restart. A `fail`
means the last reload found the file invalid: the server keeps running the revision it had, and
the fix lists each problem by path. `jumpmaster ctl config adopt` moves the config into the
database (db mode), where the UI (Settings, Install for the install-wide settings) and
`ctl settings set` / `ctl config set` change it; from then on the file is ignored except for
`listen` and `dataDir`, read at start. Settings, History lists every revision with what it
changed and reverts one (`jumpmaster ctl config rollback <id>`). A `warn` in db mode means the file no
longer mirrors the database: refresh it with
`docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json`
(`-T` keeps the file free of carriage returns). That export is also how to go back to file
mode (`jumpmaster ctl config mode file`, refused unless the file equals the export) and what
to write before running an older release, which reads only the file.

### `config.restart`

**Action:** Open Settings, Install (`/settings/install`), which carries the restart-pending badge.

A setting changed since the server started that only a restart applies (`mcp.enabled` and
`mcp.maxBodyBytes`, or a `listen` or `dataDir` changed in the file). Every other change applies at
the next pass. Settings, Install shows it as "restart pending". Run
`docker compose restart jumpmaster`.

### `credential.install`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The two credentials every zone needs, the Claude token and the GitHub author token, judged for
the install before any zone exists (a fresh install that skipped the wizard's first steps). A
`fail` names the missing ones: enter them in the setup wizard (`/setup/claude`, `/setup/forge`) or
with `jumpmaster ctl secrets set claudeToken` / `githubAuthorToken` (the value on stdin). Once a
zone exists, each zone's `credential.missing` reports them instead, so this passes.

### `credential.missing`

**Action:** Open Settings, Credentials (`/settings/credentials`).

A zone needs a credential nobody has set: the Claude token, the author token, a two-bot zone's
reviewer token, the read token when `reviewReadToken` is on, or a gate secret it declares. The zone
is parked until it arrives (its queue reason says `credentials: …`). Enter it under Settings,
Credentials, or `jumpmaster ctl secrets set <name>` (the value on stdin), or write its file under
`secrets/` and run `jumpmaster ctl secrets reload`.

### `credential.kind`

**Action:** Open Settings, Credentials (`/settings/credentials`).

A credential of the wrong kind for its zone: a starter zone, or one with `authorMayBeAdmin`, needs a
fine-grained author token (`github_pat_`); a gate secret needs at least 8 characters. The zone is
parked until it is replaced.

### `credential.same`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The reviewer token belongs to the author's account (the same token, or the same login when both
were tested on entry). A review must come from a second account: replace the reviewer token.

### `credential.shadowed`

**Action:** Open Settings, Credentials (`/settings/credentials`).

A credential is set both by a file under `secrets/` (or a variable) and in the vault, with different
values. The file wins. Remove whichever you do not mean: the file (then `jumpmaster ctl secrets
reload`), or the vault entry (`jumpmaster ctl secrets remove <name>`).

### `vault.key`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The vault's entries do not decrypt with the key `JM_VAULT_KEY_FILE` names (`secrets/vault_key`).
The key and the data travel together: restore the key file from the backup taken with `data/`, or
re-enter each credential. A server with a non-empty vault and no key file does not start.

### `config.secret-files`

**Action:** this entry (the doctor links here).

Every secret file must be readable by its owner only. A `fail` names the files others can read;
in the install directory run `chmod 700 secrets && chmod 600 secrets/*`, then
`docker compose restart jumpmaster` ([Tokens](#tokens)). It judges each file, not the `secrets/`
directory: a file's own mode is what counts, and a copy or backup of the file keeps the file's own mode, so a `0644` file fails even
inside a `0700` directory.

### `claude.token-age`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The Claude token's age from `claude.tokenCreatedAt`; warns from day 330, fails past a year. Renew
it ([Claude token](#claude-token)).

### `claude.plan`

**Action:** Open Settings, Install (`/settings/install`).

The declared plan, and whether a `fableModel` fits it ([Claude plan](#claude-plan)).

### `control.kill`

**Action:** Open the kill switch on home (`/`).

The kill switch stops every drop. Release it when safe:
`docker compose exec jumpmaster jumpmaster ctl unkill`.

### `stick.seen`

**Action:** See the sticks on home (`/`).

No stick has asked for work lately. `docker compose ps`, then `docker compose logs stick`: a wrong
join token, or a server it can't reach ([Stick](#stick)).

### `stick.capabilities`

**Action:** See the sticks on home (`/`).

No live stick can run this zone: the fix names what it lacks (`egress-v1`, `image-verify-v1`, the
signed policy). See [Stick](#stick).

### `stick.image-policy`

**Action:** See the sticks on home (`/`).

A stick runs images by allowlist, not verified signatures. Use the release's stick, which runs
`JM_IMAGE_POLICY=signed` ([Image trust](#image-trust)).

### `usage.gate`

**Action:** Open Settings, Install (`/settings/install`).

Whether dispatch is open under your Claude usage; nothing to do unless a credits briefing waits
([Usage](#usage)).

### `forge.author`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The author token's account, its role on the repository (must be Write, not Admin unless
`authorMayBeAdmin`), and its expiry ([Tokens](#tokens)).

### `forge.reviewer`

**Action:** Open Settings, Credentials (`/settings/credentials`).

The same for the reviewer; it must be another account than the author, with Write and not Admin.
`skip` in starter mode ([Tokens](#tokens)).

### `forge.author-reads`

**Action:** Make an author token with the right permissions (GitHub's token page, pre-filled with the [Tokens](#tokens) permissions).

Tries each read the server relies on with the author token: Contents, Issues, Pull requests,
Commit statuses, and CI results (Actions). A refusal names the permission to add ([Tokens](#tokens)).

### `forge.reviewer-reads`

**Action:** Make a reviewer token with the right permissions (GitHub's token page, pre-filled).

The same for the reviewer token: Contents and Pull requests ([Tokens](#tokens)).

### `forge.admin`

**Action:** Open Settings, Credentials (`/settings/credentials`).

Neither bot may be a repository admin, unless `authorMayBeAdmin` is set for an owner's personal
repository and the author token has no Administration permission ([Starter mode](#starter-mode)).

### `forge.branch-rules`

**Action:** Get the ruleset file for <zone> (the zone's GitHub page). When GitHub answered the doctor's reads, the action is **Import the ruleset file on GitHub** instead: the repository's Rulesets page, with the ruleset file as a download beside it.

The ruleset on the default branch, as the tokens see it; the summary names each problem
([Branch rules](#branch-rules)).

### `forge.codeowners`

**Action:** Get the CODEOWNERS text for <zone> (the zone's GitHub page). When GitHub answered the doctor's reads, the action is **Create .github/CODEOWNERS on GitHub** instead, with the text as a download beside it.

Two-bot: with Require review from Code Owners on, `.github/CODEOWNERS` must exist; its lines for
the protected paths must name people, not the reviewer bot (a warn otherwise), and every other line
that names owners must name the reviewer bot (a fail otherwise: GitHub would refuse every merge of
a pull request touching those paths, and Jumpmaster parks the items with the same fix). The last
matching line decides: a later line that names the reviewer bot (or no owner) covers an earlier
people-only one, and each protected path's last matching line must name people. A line owned by a
team or an e-mail is a warn, not a park: Jumpmaster cannot tell whether the bot is a member. Starter mode: the option must stay off (GitHub never lets an author
approve their own pull request); Jumpmaster parks those pull requests for you to merge by hand
([Branch rules](#branch-rules)).

### `forge.ci`

**Action:** Open GitHub Actions (the repository's Actions page, with the detected job names).

Required checks and the workflows that produce them; a required check no workflow runs would make
every pull request wait forever ([CI](#ci)).

### `forge.labels`

**Action:** Create the missing labels (a button: it creates them as the author bot).

Missing labels ([Labels](#labels)). The doctor page's **Create the missing labels** (or
`jumpmaster ctl labels <zone>`) creates them as the author bot, in observe mode too; the fix also
prints the `gh label create` commands. If GitHub does not answer, the request is left `unknown`
and counts as an active forge write, so a mode change or a zone removal waits, until a later pass
reads it back or it ages out after the outbox deadline. Before a downgrade to an older release,
make sure no label action is in flight.

### `forge.private-clone`

**Action:** Open Settings, Credentials (`/settings/credentials`).

A private repository needs the read token and `reviewReadToken: true` ([Read token](#read-token)).

### `zone.mode`

**Action:** Open the zones (`/zones`).

The zone is paused or observing: **Resume** on `/zones`, or
`docker compose exec jumpmaster jumpmaster ctl resume <zone>`.

### `zone.preset`

**Action:** Edit the preset of <zone> (the zone page's **Stack** section).

The preset against the repository's root files, whether the zone has gates, and whether the image
is a digest reference. With no gates, drops run no checks of their own: add the repository's
install and test commands to `gates`. A
`:dev` image is a local build; a tag needs pinning
([Presets](#presets), [Pinning an image by digest](#pinning-an-image-by-digest)).

### `zone.services`

**Action:** Edit the services of <zone> (the zone page's **Stack** section).

Each service image must be a digest reference pinned on the stick ([Services](#services)).

### `zone.egress`

**Action:** Edit the egress of <zone> (the zone page's **Egress** section).

The egress mode and the hosts seen; in monitor, the hosts to add before enforcing
([Egress](#egress), [step 6](#step-6-run-the-doctor-to-zero-fails)).

### `zone.identity`

**Action:** Edit the identity of <zone> (the zone page's **Merging** section).

`two-bot` passes. Starter mode always warns with its cost ([Starter mode](#starter-mode)). To add
a reviewer: give a second account Write, enter its token as `githubReviewerToken` under Settings,
Credentials (or write `secrets/github_reviewer_token` and run `ctl secrets reload`), set
**Accounts** to `two-bot` in the zone page's **Merging** section (in file mode, `"identity":
"two-bot"` in the file and `ctl config reload`), and import the zone's two-bot ruleset from its
GitHub page (1 approval, stale approvals dismissed, code owner review) and its CODEOWNERS.

### `zone.doctor-drop`

**Action:** Run a doctor drop for <zone> (a button).

The last doctor drop's result: what it proved, or what failed and the hosts it needed
([Doctor drop](#doctor-drop)).

### `zone.goals`

**Action:** Edit the goals of <zone> (the zone page's **Advanced** section).

With the crew on: whether `GOAL.md` parses ([Crew](#crew)).

### `zone.crew-cap`

**Action:** Edit the crew of <zone> (the zone page's **Advanced** section).

With the crew on: crew drops in the last day against the cap ([Crew](#crew)).
