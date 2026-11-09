# M4.5 Operable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Written 2026-11-09 with the spec amendment of the same date (§3, §7.5, §10.3, §15, §17), revised
> after a red team (2 Critical, 13 Important, 11 Minor) and again after its re-review (1 Critical,
> 5 Important, 4 Minor new, plus five partials) and its final check (1 Important, 7 Minor, all
> written in). Every Critical and Important is adopted; the
> disposition table at the end says how, Minors included. The owner delegated the review's open
> questions and chose its recommendations; they are built in as `[call]`. The plan builds on
> `main` at 0af429f, where PR #51 merged M4 Tasks 16–17 (`init --offline`, the compose install,
> the README and install runbook).

**Goal:** A person who has never opened Jumpmaster's config file runs five shell commands copied from the README (download, verify, `docker compose up`), and from then on uses only the browser: claim the install with the setup code, connect a Claude token and the forge tokens (the GitHub pages pre-filled from links the wizard renders), add a repository, import the ruleset file it generates, get the doctor green, reach a first merged PR, pause or change a zone, rotate a token, add a second repository and recover from a doctor FAIL. At any moment they can read, in plain language, what Jumpmaster is doing and why it is waiting. Everything they can click, they can also script with `jumpmaster ctl`. An M4 install upgrades by replacing `compose.yaml`, nothing else.

**Architecture:**
- **Auth.** One operator principal with two credentials: a passphrase chosen in the browser on first run (session cookie, CSRF token) and the generated machine token `jumpmaster ctl` already uses (Bearer). Both reach the same control handlers. Pages move behind the login (§7.5). A one-time setup code, printed to the server's stderr at start, claims a fresh install; `ctl passphrase set` claims it without a browser.
- **Config store.** The database holds config revisions; the running system reads the current revision at the top of every pass and request, so a change applies without a restart. An install is in **file mode** (a config file is present: it is the truth, re-read on reload, shown read-only in the UI) or **db mode** (no file, or the file was adopted: the UI and `ctl` write revisions; `ctl config mode file` is the way back). Boot settings (`listen`, `dataDir`) come from the file or the environment; `mcp.enabled` is the one editable setting that needs a restart. **Guarded paths** (what runs, where it may reach, what merges without a human) need a confirmation page from a browser session, whose POST carries the passphrase and a single-use server-side confirmation; two of them (`requireSignedImages` weakening, a zone's `image`) are never a session's to change.
- **Vault and file secrets.** Credentials encrypted at rest (AES-256-GCM) under a key file outside the data volume. A file named for the credential under the secrets directory (`/secrets/<name>`, the bind that already exists) or a `*_FILE` variable is a file secret and takes precedence over the vault, so an M4 install's `secrets/` keeps working untouched. The UI shows source, fingerprint and dates, never a value. Rules that span config and credentials are dispatch refusals and doctor FAILs, not apply-time errors.
- **Compose.** The default compose declares no Compose secret and no credential `_FILE` variable: the server reads `/secrets` by name, and the vault serves what is not there. The three machine secrets (join token, operator token, vault key) are created there by a `bootstrap` service before the server and the stick start, so `docker compose up` works in an empty directory. No override file.
- **GitHub guidance.** The half of the barrier that lives on GitHub is met with links and generated text: pre-filled fine-grained PAT template URLs, a ruleset file for GitHub's import with the detected CI job names, an identity recommendation from the owner type and visibility, CODEOWNERS text, a collaborator checklist. No forge write.
- **Pages.** Server-rendered HTML with small inline scripts, as today: the setup wizard, the Credentials tab, zones (list, add, edit), the rest of settings (install, MCP tokens, history), a GitHub page per zone, a status banner on home, action links on the doctor page.
- **ctl.** Every control route is in a manifest with its `ctl` verb; a test keeps them equal.

**Tech Stack:** TypeScript (ESM, strict), Node 24+, Fastify 5, better-sqlite3, zod 4, vitest, Biome. No new npm runtime dependency: passphrase hashing is Node's `crypto.scrypt`, the vault is `crypto`'s AES-256-GCM, session, setup and confirmation tokens are `crypto.randomBytes`, workflow job names are read by a small line-based reader. No UI framework (§14 leaves it to the builder; the existing pages set the pattern).

**Spec:** `docs/superpowers/specs/2026-10-19-jumpmaster-design.md` §1.3, §3, §4, §7.1, §7.3, §7.4, §7.5, §8.0, §10.3, §12.1, §13, §15 (M4.5), §17.

## The barrier today, and where each step goes

Scope was chosen by one test: what must a first-time user know, type or edit by hand today, and how does each step go away, or shrink, or get counted honestly?

| Today the user must… | After M4.5 | Task |
|---|---|---|
| Install Docker; make a directory; write `.env` with `JM_UID`/`JM_GID`; `mkdir -m 700 secrets`; download four release files; verify them | **Shrunk, not removed.** `.env` is optional (the compose defaults the uid; `bootstrap` prints the right fix when the directory's owner differs); `secrets/` and `data/` are made by `bootstrap`. What remains is five commands copied from the README, counted by the gate on their own bar | T5, T15 |
| Read the tokens section of the install runbook and write three or four tokens into `0600` files with a shell helper | Paste each credential into the wizard or the Credentials tab; it is tested on entry and never shown back. A file under `secrets/` still works for anyone who prefers it | T4, T6, T9 |
| Decide two-bot or starter from the runbook's prose; learn that a fine-grained PAT cannot serve a collaborator bot on another user's repository, and that rulesets on a private repository need a paid plan | The wizard recommends before it asks, from the repository's owner type and visibility, and stops early for the free-plan private case | T7 |
| Build two fine-grained PATs from a seven-row permission table without a mistake | One pre-filled link per token: click Generate, paste | T7 |
| Build a ruleset with ten fields and the exact CI job name | A ruleset file for GitHub's import, with the detected job names, and the two-line instruction | T7 |
| Write CODEOWNERS for the protected paths; invite the bots as collaborators with Write | The text with a copy button and the new-file link; a checklist naming the resolved bot logins | T7 |
| Run `jumpmaster init --repo …` and understand `--preset`, `--identity`, `--author-may-be-admin`, `--offline` | "Add a project" in the browser: detection runs on the server, the gates are shown for review, the identity is a labelled choice | T6, T11 |
| Hand-edit `config/jumpmaster.config.json` to change a gate, the egress list or a label; then restart | The zone page edits each section, validated by path; the change applies at the next pass; history and rollback | T2, T3, T11 |
| Know `claude.tokenCreatedAt` exists and set it | A credential entered in the UI is dated the day it is entered; the expiry banner follows | T4, T9 |
| Paste the operator token into a form field for every kill, ruling, doctor run and intake filing | Log in once; the session carries every action | T1 |
| Read a doctor fix hint, then find the config key or the GitHub settings page it means | Each FAIL links to the control that fixes it, in the app or on the forge, carrying the generated file where there is one; missing labels are created with one click | T8 |
| Run `ctl doctor <zone> --drop`, read the stick log for observed hosts, edit `egress.allow`, restart | The Egress section lists what monitor mode observed, with the drops that used each host; tick to adopt | T11 |
| Read slots, queue reasons, outbox and sticks on the home page to work out why nothing is happening | A status line answers "what is Jumpmaster doing and why is it waiting", with the link to act | T12 |
| Add a second repository by editing the file (`init` refuses when a config exists) | "Add a project" again | T11 |
| Watch `docker compose logs stick` to know the runner is alive | The home page already lists sticks with last seen, version and capabilities; the status line says when no runner has checked in. Drain, remove and join tokens wait for M6 | T12 |
| Script with `docker compose exec jumpmaster jumpmaster ctl …` for a handful of verbs | Unchanged mechanics; every UI action has a verb | T14 |
| Regenerate the operator token file and restart after losing it | `ctl setup reopen` reopens the passphrase step; `ctl passphrase set` claims a headless install; the token file stays the machine credential | T1 |
| Upgrade an M4 install: drain, replace `compose.yaml`, `up` | Unchanged, and still three steps: the `secrets/` files are read by name, the `.env` keeps working, the config file means file mode | T4, T5, T15 |

**What stays by hand, exactly.** The README's prelude, five commands, copied without edits: (1) make and enter a directory; (2) download the release's four files (`compose.yaml`, `images.lock.json`, `SHA256SUMS`, `SHA256SUMS.sigstore.json`) in one loop; (3) `cosign verify-blob` on the checksums; (4) `sha256sum -c`; (5) `docker compose up` (foreground, so the setup code is on screen; `-d` plus `docker compose logs -f jumpmaster` is the alternative the README shows). No `.env`, no `secrets/`, no token files. On GitHub: creating the bot accounts and accepting their collaborator invitations (two logins, or one in starter mode), clicking Generate on each pre-filled token page and pasting the result, importing the ruleset file, committing CODEOWNERS. On the operator's own machine: `claude setup-token` (§12.1: Jumpmaster never intermediates a Claude credential). The first `agent-ready` issue, which the intake page files. Nothing else.

## Global Constraints

- Build on `main` at 0af429f or later (PR #51 merged M4 Tasks 16–17). This plan modifies their `apps/server/src/init.ts`, `apps/server/src/cli.ts`, `deploy/compose.yaml.tmpl`, `deploy/.env.example`, `deploy/smoke.sh`, `deploy/deploy.test.ts`, `docs/runbooks/install.md` and `scripts/docs.test.ts`. Run `npm test`, `npm run typecheck` and `npx biome check .` before every commit.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, as the owner chose for this repository. PR bodies carry no generated-with footer.
- **Naming.** This repository is public. Call the owner's project "the reference project" and the gate's repositories "the test repositories". No private project names, hostnames, local paths, employer names or logins other than the repository's own. Pages carry the §4 plain-English label beside each term, as the existing pages do.
- **Pinning.** No new dependency is planned. If one becomes necessary, M4's rules apply unchanged (exact npm versions, 40-character action SHAs, digest image refs, 14-day age).
- **An M4 install upgrades by replacing `compose.yaml`.** Its `secrets/*` files are read from the directory bind by name, with the same precedence over the vault and the same `0600` check as today's `*_FILE` secrets; its `.env` keeps working (`JM_UID`/`JM_GID` are honoured, and `init`'s block of `JM_REVIEWER_TOKEN_*` and `JM_READ_TOKEN_*` lines is no longer referenced by the template, so it is dead and may be deleted); its config file means file mode, read-only in the UI until adopted. The one visible change is the login §7.5 requires: on the next start the server prints a setup code and the operator chooses a passphrase in the browser, or runs `ctl passphrase set` where there is no browser; `ctl` and the stick are untouched. T5's smoke runs this upgrade from an `init`-written directory and asserts no zone is parked.
- **Compose shape.** The default compose declares no Compose secret and no credential `_FILE` variable. `./secrets` is bound read-only at `/secrets` on the server and the stick (`JM_SECRETS_DIR=/secrets`); the machine secrets are files there, created by `bootstrap` before either starts; credentials are files there too when the operator wants them so, else vault entries. `compose.yaml` works from an empty directory, from one holding only `.env`, from one whose bind directories Docker or `sudo` made as root (bootstrap says the exact fix), and from an `init`-written M4 directory. The `init` profile stays. There is no override file, and PR #51's docs test that says so stays true.
- **Migrations** from v18 on, in the order they land: v18 operator, sessions and control audit (T1); v19 config revisions and settings (T2); v20 vault (T4). Never edit `schema.sql` or an earlier migration. Rollback: an M4 binary runs against all three (added tables are ignored) and reads the config file, so a **db-mode install must write `ctl config export` to the config file before a downgrade**, and a `data/` restore from before `adopt` puts the install back in file mode with the file's zones; the operate runbook says both.
- Every forge write goes through `runOp` in `outbox.ts`. The one new forge write is label creation (T8), operator-initiated, idempotent by name, allowed in observe mode and refused when killed. The doctor itself still never writes.
- **Secrets.** M4's rule holds (never printed, logged, stored unencrypted, in argv, URLs, layers or forge bodies), and gains: never in a config revision, diff, export, audit row, status line, page or generated GitHub artifact. The UI renders a fingerprint (the first 8 hex characters of SHA-256 of the value) and dates. The vault is the only place a value rests in the database, and only as ciphertext. **A value that fails its test is a secret too:** secret routes build their audit detail explicitly and return only a status and a permission name. **One bootstrap exception:** the setup code (T1) is printed to stderr. It is single-purpose, random (60 bits), invalid once a passphrase exists, and slowed by per-source backoff. `SECURITY.md` states it, and that a forwarded log carries it until it is claimed.
- **Two principals, one authorization.** Every `/api/control/*` route accepts the Bearer machine token (`ctl`) or a session cookie with a matching CSRF header (browser). Host and Origin checks apply to **every non-GET route, pages included**, and a request they refuse charges no backoff. Audit rows record `via: 'token' | 'session'`. A session needs sudo (the passphrase re-entered within five minutes) to write a credential; a guarded config change from a session goes through a confirmation page whose POST carries the passphrase and a single-use, server-side confirmation bound to the session, the change set and the base revision. The token is always sudo, since whoever holds it holds the secrets directory. Two changes a session never makes: weakening `requireSignedImages` and setting a zone's `image`.
- **Hot apply.** Consumers read `store.current()` at the top of each pass or request and never cache a `Config` across passes: the scheduler pass, the credits pass, the lease expirer, the MCP route and the poll timer itself. A running drop keeps the payload it was dispatched with. Boot settings (`listen`, `dataDir`) are not in the editable document. `mcp.enabled` is the one editable setting that needs a restart, and the UI marks it.
- **ctl parity.** Every UI write has a `ctl` verb, and both reach one handler. T14's manifest test enforces it from T14 on; earlier tasks add their verbs as they add routes. `ctl config export` writes to stdout; anything that wants a file redirects on the host.
- **Two parts.** T1–T9 are **M4.5a** and stand alone: every page a doctor action or a wizard "later" link names exists in them (zone checks link to the runbook until the zones page lands in T11). T11–T13 are **M4.5b**. T10, the owner dry run, sits between them and decides whether they ship as one release or two.
- **Between T1 and T5** the pages have no token fields and the browser-first smoke does not exist yet. The current smoke uses the log and `ctl`, so nothing breaks in between; T5 adds the new cases.
- Every network-facing or security-relevant task lists its threats under Review Focus. Its tests cover each threat, or the threat is named as resting on the rehearsal.

## Owner steps

These need accounts, people or the reference project. They are **owner-only**: the implementer stops and asks when the work reaches them.

| When | Owner-only step |
|---|---|
| Before T16, as early as possible | Run M4's partner gate session with M4.5's counters and stopwatch (T16's recording sheet), as the **baseline**. The M4 plan's Task 18 carries a note to that effect. |
| T10 | Upgrade the reference project (an M4 install) by replacing `compose.yaml`, schedule the daily export, adopt db mode, and run the a-part of the operability session; at least a week before partner 1. Decide at its end whether M4.5 ships as one release or as M4.5a and M4.5b. |
| Before T16 | Recruit two design partners who have never opened a Jumpmaster config file, each on a supported host (Linux with rootful Docker Engine, or macOS with Docker Desktop; one of each if possible). Provide each with two fresh test repositories with small seed apps and CI; the bot accounts, their collaborator invitations accepted, and their tokens (account creation is not delegated); and the partner's own Claude setup-token. Do **not** provide rulesets, CODEOWNERS or labels: guiding them is the milestone's work. |
| Each release | Push the version tag. |

## Rulings on spec gaps

Decisions the owner delegated to the revisions, chosen as the red team recommended `[call]`:

- **Placement:** M4.5 Operable between M4 and M5, no renumbering (§15 argues it).
- **The setup code goes to stderr,** with per-source backoff instead of a lock, and `ctl setup-code` to print a fresh one. A `0600` file would add a `cat` to the exact flow the milestone removes and protects against nobody the log does not.
- **One-click label creation from a doctor link,** working in observe mode too. The author token already holds Issues: write (intake files issues with it); the op is idempotent by name, operator-initiated, through the outbox, audited, refused when killed. The doctor itself stays read-only.
- **The reference project adopts db mode during the owner dry run,** at least a week before partner 1, provided `ctl config mode file` exists as the way back and a daily export on the host keeps the file a current mirror. It is the only install with real traffic to rehearse hot apply, rotation and the M4 upgrade against.
- **Gate numbers,** as the gate text below states them.

Builder decisions `[call]`:

- **File secrets by name under the secrets directory.** `resolveCredentials` treats `/secrets/claude_token`, `/secrets/github_author_token`, `/secrets/github_reviewer_token` and `/secrets/github_read_token` as file secrets, exactly as a `*_FILE` variable (which still works for anyone who sets one): precedence over the vault, the `0600` and regular-file checks, named at startup when unreadable. Presence decides: no reviewer file means no reviewer credential (starter), a read file means a read token (private), as `init` already decides. No override file, no `COMPOSE_FILE`, no `init` block in `.env`. A `*_FILE` path under `/run/secrets/` that does not exist, when the same name exists under the secrets directory, falls back to it with a logged warning, so a hand-edited compose from M4 upgrades too.
- **Two config modes, `adopt` one way and `mode file` the other.** Mixed ownership (some keys from the file, some from the UI) is where every config system becomes unexplainable. An install is in file mode or db mode. Adopt copies the file into revision history and switches the mode. `ctl config mode file` (Bearer only, audited) switches back, and refuses unless the file's hash equals the current revision's export, so nothing is lost on the way. The export itself is stdout: `/config` is mounted read-only in the container, so the host redirects it (`docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv …`; `-T`, or a hand-run `exec` allocates a pty and the file gets CRLF). A file present in db mode is ignored, loudly (startup log and a doctor note).
- **Guarded paths.** A change that lets more code run, lets a drop reach more, hands a drop a credential, or weakens a merge guard is guarded: from a session it needs the confirmation page (the passphrase on that page is the sudo; the confirmation is minted when the page renders and used once); from the token or the file it is the operator's business. Weakening `requireSignedImages` and setting a zone's `image` (on an existing or an added zone) are refused from a session outright, because they decide what runs with the secrets. The classifier works on documents, not raw diffs: an added zone is judged against the add baseline (the schema defaults, with `egress.mode: monitor` where the generated install starts); a removed key is judged on its effective value after defaults and the install-level fallback; list-valued paths are judged as set differences, so a reorder is nothing and a replacement is a removal plus an addition. Rollback, import, Resume, a rename (a removal plus an add) and the Advanced JSON editor are session applies like any other and go through it. `repo` is immutable on an existing zone (remove and re-add). `preset` may change freely when the new preset's base egress hosts are a subset of the old's, and is guarded otherwise (a preset is an image bounded by the signed lock, so the image rule does not apply); on an added zone the chosen preset's base hosts are the baseline's starting point, so the preset is not guarded there and the project step shows the hosts as information. `readyLabel` is not guarded (§7.1's author check still gates every issue), and the page notes that renaming to a label already on many issues dispatches them all.
- **Credential-dependent rules are dispatch refusals, not apply-time errors.** The wizard is skippable, so a two-bot zone may exist before its reviewer token does. The rules `loadConfig` enforces today across config and tokens (starter needs a `github_pat_` author token, `authorMayBeAdmin` needs a fine-grained one, reviewer differs from author, `reviewReadToken` needs a read token, a two-bot zone needs a reviewer token) plus "no Claude token" become `credentialProblems(zone, resolved)`: the scheduler parks dispatch for that zone with the problem as its reason, the doctor reports it as `credential.missing`, `credential.kind` or `credential.same`, and `PUT secrets` returns the problems of every zone as warnings. `parseEditable` keeps only the rules the config can judge alone.
- **Passphrase plus machine token.** §14 leaves the UI auth mechanism to the builder. A passphrase is what a browser user expects; a generated token is what a script expects. Both are "operator". `ctl passphrase set` (stdin) claims a headless install or replaces the passphrase, and deletes every session either way; `ctl setup reopen` (token only) is the recovery path.
- **Boot settings stay outside the editable document.** `listen` and `dataDir` are read before the database exists: from the file (file mode) or the environment (db mode), shown read-only with where they are set. `mcp.enabled` is editable but its route is registered at start, so a change is accepted, marked "restart pending" and reported by the doctor. Everything else applies live, the poll timer included.
- **A removed zone keeps its history.** Removal needs a drained observe zone (the guard that protects the move to observe) and deletes only the `zone_controls` row; work items, drops, outbox rows, crew issues and goals stay. Re-adding an id with history is refused unless the operator chooses Resume (`ctl zones add --resume`), and a rollback that re-adds a zone runs the add path and says so. Pause and observe stay runtime state in `zone_controls`, so a config edit never flips a zone's mode.
- **Install-wide forge credentials.** One author and one reviewer token serve every zone in M4.5, as today; a fine-grained PAT may list several repositories. Per-zone credentials arrive with M5's second forge.
- **Revisions hold the whole validated document,** without secrets. Zone edits, install settings and adoption are all revisions; rollback is a new revision with old content; history is never deleted; notes are capped at 500 characters and escaped.
- **Egress adoption is per host, ticked by the operator, with the drops that observed it shown.** Observation during a hostile drop is a hint, not a truth; nothing is adopted by default.
- **GitHub guidance is links and generated text, never a write.** Template URLs, a ruleset file, CODEOWNERS text and a checklist; the clicks and the commit stay the user's. The template URL parameters are taken from GitHub's documentation at implementation time and tested for the permission set; the resource-owner parameter is checked against a real organization during the owner dry run, and the step says to check that field.
- **Detection on zone add reuses `init`'s detection,** extended with the owner type and the workflow job names: read-only GETs on the default branch root and `.github/workflows/`, after the repository name passes `init`'s `REPO` regexp; the result is a proposal the operator confirms. Repository content stays data (§7.1).
- **`init` stays; `bootstrap` generates the machine secrets.** Compose runs `jumpmaster bootstrap` before the server and the stick, so `docker compose up` alone yields a paired stick and a server waiting for its setup code. `init` remains the scripted install and writes a file (file mode); it no longer writes compose variables into `.env`.
- **Plaintext login off loopback is a FAIL, judged by `allowedHosts`.** The server cannot tell reliably whether it is in a container or how its port is published, but it knows which `Host` values it accepts: `config.listen` fails when `allowedHosts` names a non-loopback host and `listen.tlsTerminated` (boot: `JM_TLS_TERMINATED=1` or the file) is false. A non-loopback `listen.host` with loopback-only `allowedHosts` stays a warning as today (a LAN `Host` is already 403). Non-loopback `allowedHosts` are allowed only behind a TLS terminator the operator declares; TLS guidance itself stays with M6's remote placements.
- **Session limits:** idle 12 hours, absolute 7 days, sudo 5 minutes. Setup-code and login attempts back off per remote address (1 s doubling to 5 min), charged only after the Host and Origin checks pass, with no global key: the 60-bit code makes a distributed guess infeasible, and a global key would let one source hold everyone. The cookies are `HttpOnly; SameSite=Strict; Path=/` without `Secure`: the UI is loopback or an SSH tunnel by default, and `config.listen` now fails otherwise.
- **Token age is dated on entry.** A credential set in the UI records today as its creation date unless the operator gives one; `claude.tokenCreatedAt` in a file keeps working in file mode.

## Review Focus

1. **Setup takeover (T1, T5, T6).**
   - An unauthenticated `/setup` claimed by someone else, including a drop container that shares a network with the server (compose puts the stick on one; a drop reaching `jumpmaster:7420` chooses its own `Host` header, so the Host check is no wall for it). The setup code is the wall: required, random, compared in constant time, single-use, invalid once a passphrase exists, slowed by per-source backoff.
   - Stalling the wizard. Backoff replaces lock-until-restart, is charged only after Host and Origin pass (a cross-site POST cannot spend the operator's budget), and has no global key; `ctl setup-code` prints a fresh code.
   - The code leaking. It is printed once per start to stderr on its own line with a fixed prefix, never to a page, cookie, URL or the database; the `jm_setup` cookie proves it was entered and lasts ten minutes.
   - Setup reopened by an attacker. `ctl setup reopen` needs the Bearer token, never a session.
2. **Sessions and CSRF (T1).**
   - Cross-site writes to page routes. `originAllowed` runs on every non-GET route, `/login`, `/setup/*`, `/logout` and the confirmation pages included; same-origin form posts carry `Origin`.
   - Session fixation or theft. The id is rotated on login, stored hashed, `HttpOnly; SameSite=Strict`, idle and absolute limits, deleted on logout and on any passphrase change; `next` accepts only a path (no scheme, no `//host`).
   - Cross-site writes to control routes. Every non-GET with a session needs the `x-jm-csrf` header equal to the session's token; Host and Origin checks stay in front.
   - Passphrase guessing. scrypt (N=2^15, r=8, p=1, 32-byte salt), minimum 12 characters, per-source backoff.
   - A passphrase crossing a LAN in clear. `config.listen` fails on non-loopback `allowedHosts` without `tlsTerminated`.
   - The machine token weakened. It still works exactly as before and never gets a session.
3. **Secret exposure through the new surfaces (T2, T4, T9).**
   - A value in a revision, diff, export, audit row, page, status line, generated artifact or log. Tests scan each for every secret in the fixture.
   - **A pasted value that fails its test**, which the scrubber does not know. Secret routes build audit detail from `{ name, fingerprint, result }`, never the body; the error path returns the status and the permission name only; a test with a fixture value distinct from every stored secret asserts it reaches no log line, audit row or response.
   - The vault key on the data volume. It is `JM_VAULT_KEY_FILE` under `./secrets`, beside the other machine secrets; a missing key with a non-empty vault refuses startup; `data/` alone (a `VACUUM INTO` copy, a diagnostics export) holds ciphertext only.
   - A fingerprint that reveals the value. It is a SHA-256 prefix, never a substring or the length.
   - Replace without proof of presence. Sudo for sessions.
   - A credential file the operator did not mean as one. Only the four names under `/secrets` count; `credential.shadowed` warns when a file and a vault entry both exist and differ; the `0600` check applies.
4. **Live-config hazards (T2, T3, T11).**
   - **A session weakens a guard.** The classifier judges documents (add baseline, effective values, set differences), so an added zone, a removed key, a reorder, a rename, a rollback, an import, a Resume and the Advanced editor are all caught; `requireSignedImages` weakening and a zone `image` (existing or added) are refused from a session; the audit row marks `guarded: true`.
   - **A forged or replayed confirmation.** The confirmation is a random value minted only when the page renders, stored hashed server-side with the session, the change-set hash, the base revision and an expiry, consumed on use; the POST also carries the passphrase. Nothing on the page (the CSRF meta included) lets a script compute it; a second use, a changed set, a stale revision or an expired record is refused.
   - A half-applied change. Revision row and current pointer change in one transaction; the store swaps a whole validated object.
   - A change racing a pass. A pass reads `store.current()` once at its start; a drop keeps its payload.
   - A consumer that read once. The poll timer re-arms on `pollSeconds`, the lease expirer and the MCP route read the store; tests name each.
   - Two editors. `expectRevision` makes every apply conditional; a stale one is a conflict, not an overwrite.
   - A zone removed under running work, or resurrected. Refused unless drained; history kept; re-add needs Resume; a rollback that re-adds says so.
   - A restart-only setting reported as live. `RESTART_PATHS` is tested, and a boot setting is never accepted through the editable document.
   - An invalid file on reload. The old config stays; the doctor reports `config.file`.
   - A credential rule lost in the split. `credentialProblems` is tested in both directions: a config change with the credential absent parks dispatch; a credential change that invalidates a zone parks it.
5. **File and db mode confusion (T2).** A file present in db mode is ignored with a startup log line and a doctor note; `mode file` refuses unless the file equals the current export; the export is stdout, redirected on the host, and the dry run smokes the round trip; the downgrade and restore notes are in the runbook; adopt is audited.
6. **The M4 upgrade (T4, T5).** A replaced `compose.yaml` over an `init`-written directory: the credential files are read by name, the `.env` block is dead but harmless, a hand-set `_FILE` under `/run/secrets` falls back, the config file keeps file mode, no zone parks. The smoke runs it.
7. **Egress adoption of a hostile host (T11).** Nothing is adopted by default; each host shows the drops that used it and whether a preset lists it; adopted entries pass `validAllowEntry`; adding is a guarded change. The residual (a hostile drop steering the operator's tick) is stated in the operate runbook.
8. **Label creation as a write path (T8).** Through the outbox, as the author bot, idempotent by name, only the configured label names, refused when killed, audited; the observe suppression is bypassed for this op alone, by an explicit flag.
9. **Detection over the author token (T6, T7, T11).** GET-only, the default branch root and `.github/workflows/` only, after the `REPO` regexp, result shown for confirmation, no gate runs before the operator saves. Gate commands run credential-less inside drops regardless (§7.2).
10. **GitHub guidance artifacts (T7).** A template URL that asks for a Workflows or Administration permission, a link to a host other than `github.com`, a ruleset file with a bypass actor, or a token in any generated text. Tests cover each; the ruleset JSON is compared field by field with the install runbook's.
11. **Root-owned bind directories (T5).** `sudo docker compose up`, or an Engine that creates bind sources at start, leaves `secrets/` and `data/` root's: `bootstrap` names the owner and prints the `chown` line, not the `.env` line; a CLI-created `0755` directory is tightened to `0700`. Live cases cover an empty directory, `.env` only and root-owned directories.
12. **DNS rebinding (all).** The Host check stays on pages and routes; the login adds a second wall for browsers; for direct clients the setup code and the token are the walls.

**Gate claims resting on unit tests, not the rehearsal:**
- the setup code's single use, backoff and absence from pages, cookies and the database;
- Origin refusal on page POSTs (charging no backoff), CSRF refusal, session rotation and expiry;
- the absence of any secret, a failed-test value included, from revisions, diffs, exports, audit rows, pages, artifacts and logs;
- the guarded-path classifier on adds, removed keys, list reorders, renames, rollback, import and Resume; the session-forbidden paths; the confirmation's single use, binding and expiry;
- the conflict on a stale `expectRevision` and the refusal of a half-valid apply;
- the next pass using the new config while a running drop keeps its payload; the re-armed poll timer;
- the credential problems parking dispatch in both directions;
- the label action's idempotency, its observe-mode success and its refusal when killed;
- the template URL permission sets and the ruleset JSON fields;
- the compose template's shape, and the smoke's four live cases (empty directory, `.env` only, root-owned directories, the M4 upgrade) in CI.

The hot-apply claim for a real drop (a changed gate timeout used by the next drop), the token rotation claim (the next drop carries the new token), the PAT template's resource-owner parameter on an organization and the M4 upgrade with real traffic rest on the owner dry run and the rehearsal as well as on tests.

---

### Task 1: Operator login, sessions, CSRF and setup mode (migration v18)

**Files:**
- Create: `apps/server/src/auth/operator.ts`, `apps/server/src/auth/sessions.ts`, `apps/server/src/auth/guard.ts`, `apps/server/src/auth/audit.ts`, `apps/server/src/auth/backoff.ts`, `apps/server/src/ui/auth-pages.ts`
- Modify: `apps/server/src/db/migrations.ts`, `apps/server/src/app.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/ctl.ts`, `apps/server/src/main.ts`, `apps/server/src/test/helpers.ts`
- Test: `apps/server/src/auth/operator.test.ts`, `apps/server/src/auth/sessions.test.ts`, `apps/server/src/auth/guard.test.ts`, `apps/server/src/auth/backoff.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/api/sticks.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/db/migrations.test.ts`

**Interfaces:**
- v18 adds `operator(id INTEGER PRIMARY KEY CHECK (id = 1), passphrase_hash TEXT NOT NULL, created_at TEXT NOT NULL, rotated_at TEXT)`; `sessions(id_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, sudo_until TEXT)`; `control_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, via TEXT NOT NULL CHECK (via IN ('token','session','system')), action TEXT NOT NULL, target TEXT, guarded INTEGER NOT NULL DEFAULT 0, detail_json TEXT NOT NULL)`, keeping the last 5000 rows. (`mcp_audit` stays as it is: its token and zone columns have no control-route equivalent.)
- `hashPassphrase(p: string): string` → `scrypt$N$r$p$<salt b64>$<hash b64>` with N=2^15, r=8, p=1, a 32-byte salt and a 32-byte hash; `verifyPassphrase(p, stored): boolean` in constant time; `MIN_PASSPHRASE = 12`, `MAX_PASSPHRASE = 256`.
- `type SetupState = { codeHash: Buffer }` held in memory; `newSetupCode(): { code: string; state: SetupState }` with the code as three groups of four base32 characters; `setupActive(db): boolean` is "no operator row". `rotateSetupCode()` prints a new one.
- `backoff.ts`: `class Backoff { check(key: string, now): { allowed: true } | { allowed: false; retryAfterMs: number }; fail(key, now); reset(key) }` with `BACKOFF = { startMs: 1000, factor: 2, maxMs: 300_000 }`, keyed per remote address only; used by `/setup/code`, `/login` and the confirmation POST. `fail` is called only for an attempt that passed the Host and Origin checks and then failed its credential; a refused attempt is 429 with `Retry-After`.
- `type Principal = { kind: 'operator'; via: 'token' | 'session'; sessionId?: string; sudo: boolean }`; `authenticate(req, deps): Principal | null`: Bearer match → `{ via: 'token', sudo: true }`; else cookie `jm_session` → a live session → `{ via: 'session', sudo: sudo_until > now }`. `requireCsrf(req, principal)`: a session principal on a non-GET needs header `x-jm-csrf` equal to the session's `csrf`.
- `guard.ts` registers one `onRequest` hook for the whole app: the Host check on every request (as today for pages, now for `/api/control/*` too; stick routes and `/mcp` keep their own); `originAllowed` on **every non-GET request**; then the route class decides: pages need a session (redirect to `/login?next=`), control routes need a principal, `/login`, `/setup/*` and `/logout` need neither.
- `SESSION_IDLE_MS = 12 h`, `SESSION_ABSOLUTE_MS = 7 d`, `SUDO_MS = 5 min`.
- `recordAudit(db, { via, action, target?, guarded?, detail }, now)` is called by every mutating control handler. `detail` is built by the handler from named fields, never from the request body; it still passes the secret scrubber.
- Routes: `GET /login`, `POST /login { passphrase, next? }` (`next` must be a path: starts with a single `/`), `POST /logout`, `GET /setup` (only while `setupActive`, otherwise redirect to `/`; the page says the code is on the server's own output and, under compose, in `docker compose logs jumpmaster`), `POST /setup/code { code }` → sets cookie `jm_setup` (`HttpOnly; SameSite=Strict`, ten minutes), `POST /setup/passphrase { passphrase, confirm }` (needs `jm_setup`) → creates the operator and a session, redirects to `/setup/next` (T6 fills the wizard; until then `/`), `POST /api/control/sudo { passphrase }`, `POST /api/control/setup/reopen` (Bearer only) → deletes the operator row and every session, prints a new setup code, `POST /api/control/setup/code` (Bearer only) → prints a fresh code to stderr (never returned), `PUT /api/control/passphrase { passphrase }` (Bearer only) → claims or replaces the operator without a browser and deletes every session.
- Every `/api/control/*` route accepts the token or a session with CSRF. `/api/sticks/*` and `/mcp` are unchanged: a stick enrolls and heartbeats while `setupActive`.
- Pages get `<meta name="jm-csrf" content="…">` and a shared `jmFetch(path, body)` helper that sends the header. The kill, rule, doctor and intake forms lose their "Operator token" fields.
- `main.ts` prints at start, when `setupActive`, on its own line: `JUMPMASTER SETUP CODE: XXXX-XXXX-XXXX  (open http://<host>:<port>/setup; a restart prints a new code)`, where host is `127.0.0.1` for a wildcard listen.
- `ctl setup-code` (prints a fresh code on the server's stderr), `ctl setup reopen`, `ctl passphrase set` (the passphrase from stdin, never argv).

- [ ] **Step 1: Write failing tests.**

```ts
test('v18 adds operator, sessions and control_audit, and control_audit keeps the last 5000 rows', ...)
test('with no operator every page redirects to /setup, and /setup accepts only the printed code', ...)
test('wrong codes back off per source, 1 s doubling to 5 min, with 429 and Retry-After, and never lock', ...)
test('an Origin-refused or Host-refused POST does not advance backoff', ...)
test('a code accepted once is refused the second time and after a passphrase exists', ...)
test('a passphrase under 12 characters is refused and the stored hash is scrypt with a fresh salt per hash', ...)
test('login sets an HttpOnly SameSite=Strict cookie, rotates the session id and follows next only to a single-slash path', ...)
test('a session idle for 12 hours or older than 7 days is refused and deleted', ...)
test('a POST to /login, /setup/code, /setup/passphrase or /logout with a foreign Origin is 403', ...)
test('a POST with a valid session but without the matching x-jm-csrf header is 403', ...)
test('a control route accepts the Bearer token without CSRF and a session only with CSRF', ...)
test('a wrong Host or foreign Origin is refused with a valid session and the header', ...)
test('failed logins back off per source and never lock the operator out', ...)
test('sudo lasts five minutes after re-entering the passphrase and the Bearer token is always sudo', ...)
test('every mutating control route writes a control_audit row from named fields, with its via and no secret value', ...)
test('ctl setup reopen needs the Bearer token, deletes every session and reopens setup with a new code', ...)
test('ctl setup-code prints a fresh code to stderr and returns nothing to the caller', ...)
test('ctl passphrase set reads stdin, claims or replaces the operator with no browser, ends setup mode and deletes every session', ...)
test('the setup code appears once per start in stderr on its own prefixed line and never in a page, a cookie, a URL or the database', ...)
test('a stick enrolls and heartbeats while setup is active', ...)
test('the kill, rule, doctor and intake forms carry no token field and send the CSRF header', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `guard.ts` is the one place that decides; `control.ts` drops its own token hook. Keep `tokenMatches` and `originAllowed`.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the operator login, sessions, CSRF and setup mode`

### Task 2: The config store: revisions, modes, hot apply and `mode file` (migration v19)

**Files:**
- Create: `apps/server/src/config/store.ts`, `apps/server/src/config/revisions.ts`, `apps/server/src/config/diff.ts`, `apps/server/src/config/boot.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/main.ts`, `apps/server/src/app.ts`, `apps/server/src/cli.ts`, `apps/server/src/leases.ts`, `apps/server/src/mcp/server.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/doctor/checks.ts`, `apps/server/src/test/flowHarness.ts`, `apps/server/src/test/helpers.ts`
- Test: `apps/server/src/config/store.test.ts`, `apps/server/src/config/revisions.test.ts`, `apps/server/src/config/diff.test.ts`, `apps/server/src/config.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/cli.test.ts`, `apps/server/src/leases.test.ts`, `apps/server/src/mcp/server.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/flow/lifecycle.test.ts`

**Interfaces:**
- v19 adds `config_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, config_json TEXT NOT NULL, source_hash TEXT NOT NULL, via TEXT NOT NULL CHECK (via IN ('file','ui','ctl','rollback','adopt','import','setup')), note TEXT CHECK (length(note) <= 500), created_at TEXT NOT NULL)` and `settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)` holding `config.mode`, `config.current`, `config.restart_pending`, `setup.step`. Revisions are kept in full (kilobytes each).
- `config.ts` splits `FileSchema` into `BootSchema` (`listen`, `dataDir`) and `EditableSchema` (everything else); `parseEditable(json: unknown, opts): { ok: true; config: EditableConfig } | { ok: false; issues: { path: string; message: string }[] }` keeps the rules the config can judge alone (digest refs, egress entries, duplicate services, a zone not weakening `requireSignedImages`, image resolution) and drops the credential-dependent ones (T4 takes them). `type Config` stays what consumers see: boot plus editable plus `secrets`.
- `boot.ts`: `loadBoot(env, filePath?): BootConfig` reads the environment in **both modes**. `listen` and `dataDir` come from the file when one exists, else from `JM_LISTEN_HOST` (default `127.0.0.1`; the server image sets `0.0.0.0`), `JM_LISTEN_PORT` (`7420`), `JM_ALLOWED_HOSTS` (comma list; default loopback on the port) and `JM_DATA_DIR` (default `./data`; the image `/data`). `JM_CONFIG`, `JM_SECRETS_DIR` (T4) and `JM_TLS_TERMINATED` (`listen.tlsTerminated`, default false) have no key in the file and are always read from the environment, file mode included, so an upgraded M4 install reads `/secrets` by name. An apply that carries `listen` or `dataDir` is refused at that path with "set in the config file or the environment; restart to change". `RESTART_PATHS = ['mcp.enabled']`.
- `class ConfigStore`: `current(): Config`, `mode(): 'file' | 'db'`, `revision(): number`, `apply(next: unknown, meta: ApplyMeta): ApplyResult`, `rollback(id: number, meta): ApplyResult`, `reload(): ApplyResult` (file mode), `adopt(meta): ApplyResult`, `toFileMode(meta): ApplyResult`, `exportJson(): string`, `subscribe(fn: (c: Config, rev: number, changes: Change[]) => void): () => void`.
  `type ApplyMeta = { via: 'ui' | 'ctl' | 'import' | 'rollback'; principal: Principal; note?: string; expectRevision?: number }` (T3 adds `confirmation` and `resume`).
  `type ApplyResult = { ok: true; revision: number; changed: string[]; restartNeeded: string[] } | { ok: false; issues: { path: string; message: string }[] } | { ok: false; conflict: { expected: number; actual: number } }` (T3 adds the guarded variants and `readds`).
- Mode at start: `settings.config.mode` if set; else a file present → `file`, with revision 1 recorded `via: 'file'` when the hash is new; else `db` with revision 1 = defaults and no zones, `via: 'setup'`.
- File mode: `apply` via ui or ctl is refused with one issue at path `''`: "config is managed by the file at <path>: edit it and run `jumpmaster ctl config reload`, or adopt it into the UI". `reload` validates the file; invalid → the old config stays, `config.file` doctor fail with the issues; valid and changed → a new revision, with a changed boot setting listed in `restartNeeded`. `adopt` records `via: 'adopt'` and sets db mode. `toFileMode` (Bearer only) reads the file at the configured path, refuses unless its hash equals the hash of `exportJson()` ("the file differs from the current config: write `ctl config export` to it first"), then sets file mode and records `via: 'ctl'` with the note "to file mode"; a file still present in db mode logs `config file ignored: adopted on <date>` at start and the doctor notes it.
- `exportJson()` is the editable document plus the boot settings, without secrets, byte-stable (sorted keys, two-space indent, trailing newline) so the host's redirected file and `toFileMode`'s hash agree.
- Hot apply: `main.ts` holds the store; the scheduler pass, the credits pass and `leaseExpirer` (now `leaseExpirer(db, () => store.current().usage)`) read `store.current()` once at their start; the poll timer is re-armed by a `subscribe` callback when `pollSeconds` changes; the MCP route reads `store.current().dropZones` per request; the forge pairs become `forgePairs.for(zone, secrets)`, cached by `(zone.id, credentialFingerprint)`; `createApp` takes the store and reads per request; `subscribe` runs `ensureZoneMode` for new zones. A changed `RESTART_PATHS` entry is accepted, listed in `restartNeeded`, and sets `config.restart_pending` until the next start.
- `diff(a, b): Change[]` with `type Change = { path: string; from: unknown; to: unknown }`; `dropZones` are matched by `id`, other arrays by index. It feeds the History page and `subscribe`; the guard classifier (T3) works on the documents themselves.
- Routes: `GET /api/control/config` → `{ mode, revision, config, boot, restartPending, filePath? }`; `PATCH /api/control/config { patch, expectRevision, note? }` (RFC 7396 merge patch on the editable document); `GET /api/control/config/revisions?limit=` → `[{ id, parentId, createdAt, via, note, changes }]`; `POST /api/control/config/rollback { id, note? }`; `POST /api/control/config/reload`; `POST /api/control/config/adopt`; `POST /api/control/config/mode { mode: 'file' }` (Bearer only); `GET /api/control/config/export` (the JSON, `Content-Disposition: attachment`); `POST /api/control/config/import { config, dryRun? }` → the diff, applied unless `dryRun`.
- `ctl config show [--json] | revisions | set <path>=<json>… [--note] | rollback <id> [note] | import <file> [--dry-run] | export | reload | adopt | mode file`. `export` writes the JSON to stdout and nothing else; the operate runbook's host line is `docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json` (`-T`: without it a hand-run `exec` allocates a pty and the file gets CRLF, so `mode file` never matches).
- `jumpmaster serve [config]`: the path is optional; `JM_CONFIG` names it in the image; absent or missing file → db mode.

- [ ] **Step 1: Write failing tests.**

```ts
test('v19 adds config_revisions with a 500-character note cap and settings', ...)
test('a server started with a file is in file mode and records revision 1 via file', ...)
test('a server started without a file is in db mode with defaults, no zones and revision 1 via setup', ...)
test('in file mode a UI or ctl apply is refused with the reload-or-adopt message and nothing changes', ...)
test('reload records a revision only when the file hash changed and keeps the old config when the new file is invalid', ...)
test('adopt switches to db mode and records via adopt, and a later reload is a no-op the doctor reports', ...)
test('mode file needs the Bearer token, refuses when the file differs from the export, and switches back when it matches', ...)
test('exportJson is byte-stable and equals the current config with boot settings and without secrets, and re-imports unchanged', ...)
test('ctl config export writes only the JSON to stdout', ...)
test('apply validates with the editable schema and returns issues by path, applying nothing on failure', ...)
test('apply with a stale expectRevision returns a conflict and changes nothing', ...)
test('apply is atomic: the revision row and config.current change together or not at all', ...)
test('the next scheduler pass dispatches with the new config while a running drop keeps its payload', ...)
test('a changed pollSeconds re-arms the poll timer', ...)
test('the lease expirer reads the current usage settings on each run', ...)
test('a zone added live is visible to the MCP route without a restart', ...)
test('a changed author token fingerprint rebuilds the forge pair and an unchanged one keeps it', ...)
test('a new zone gets its mode row on apply', ...)
test('a change to mcp.enabled is accepted, listed in restartNeeded and sets restart_pending', ...)
test('an apply that carries listen or dataDir is refused at that path, and the boot values come from the file or the environment', ...)
test('diff matches zones by id and contains no secret value', ...)
test('rollback creates a new revision with the old content and never deletes history', ...)
test('a revision note over 500 characters is refused and a stored note is escaped on the page', ...)
test('ctl config set applies a merge patch and ctl config import --dry-run prints the diff without applying', ...)
test('jumpmaster serve without a path starts in db mode from JM_DATA_DIR', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Start with `parseEditable` and the store over an in-memory database; then move each consumer in `main.ts` to `store.current()`, one pass at a time, running the flow harness after each.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): hold config in revisions and apply changes without a restart`

### Task 3: Guarded paths and confirmation, zone history and Resume, and the listen rule

**Files:**
- Create: `apps/server/src/config/guarded.ts`, `apps/server/src/config/confirm.ts`, `apps/server/src/ui/confirm.ts`
- Modify: `apps/server/src/config/store.ts`, `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/db/repo.ts`, `apps/server/src/doctor/checks.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/config/guarded.test.ts`, `apps/server/src/config/confirm.test.ts`, `apps/server/src/config/store.test.ts`, `apps/server/src/ui/confirm.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/db/repo.test.ts`, `apps/server/src/doctor/checks.test.ts`

**Interfaces:**
- `guarded.ts`: `GUARDED_PATHS: { path: string; kind: 'scalar' | 'set'; weakens: (from: unknown, to: unknown, ctx: GuardCtx) => boolean; consequence: (from, to, ctx) => string }[]` and `SESSION_FORBIDDEN: { path: string; applies: (from, to, ctx) => boolean }[]`, each `consequence` one sentence naming the zone and the value. `type GuardCtx = { zoneId?: string; install: EditableConfig; added: boolean }`.
  - **session-forbidden:** `requireSignedImages` and `dropZones[].requireSignedImages` from effective true to effective false; `dropZones[].image` set on an added zone or changed on an existing one.
  - **guarded, scalar:** `dropZones[].egress.mode` to a weaker mode ("Drops in <zone> will be able to reach any host on the internet" / "…hosts outside the allow list, with only a record of it"); `dropZones[].authorMayBeAdmin` to true ("The author token for <zone> may belong to an admin, who can bypass branch rules"); `dropZones[].identity` to `starter` (`STARTER_WARNING` verbatim); `dropZones[].ciRequired` to false ("Agent PRs in <zone> will merge without CI"); `dropZones[].requireBranchProtection` to false ("Agent PRs in <zone> will merge without branch protection"); `dropZones[].reviewReadToken` to true ("The read token will reach review drops in <zone>"); `dropZones[].trustPnpmBuildBlocking` to true ("Gates in <zone> will run package build scripts pnpm would otherwise block"); `dropZones[].crew.goalPath` ("The crew in <zone> will read its objectives from <path>, which must be a protected path"); `dropZones[].preset` on an existing zone when the new preset's base egress hosts are not a subset of the old's ("Drops in <zone> will be able to reach <hosts>"), never on an added zone; `usage.stopOnOverage` to false ("Dispatch will continue on usage credits; only a briefing is raised"); `mcp.enabled` to true ("Command's MCP server will accept tokens at /mcp after the next restart").
  - **guarded, set** (judged as `new minus old` and `old minus new`, order ignored): `dropZones[].egress.allow` additions ("Drops in <zone> will be able to send data to <host>"); `dropZones[].services` additions or changed images, keyed by name ("The stick will run <image> beside every drop in <zone>"); `dropZones[].protectedPaths` removals ("Agents will be able to merge changes to <path> in <zone> without a human review"); `dropZones[].overrideApprovers` additions ("<login> will be able to override branch-rule problems for <zone>"); `dropZones[].gateSecrets` additions ("Gate steps in <zone> will receive the secret <NAME>; any PR's gate code can read it"); `dropZones[].botLogins` removals ("Comments by <login> in <zone> will no longer be ignored as a bot's"); `dropZones[].adoptPulls` additions ("Jumpmaster will take over PR #<n> in <zone> and may merge it").
  - **refused outright, any principal:** `dropZones[].repo` on an existing zone ("the repository of a zone can't change: remove the zone and add a new one").
  - **not guarded, noted on the page:** `dropZones[].readyLabel` ("renaming to a label already on many issues dispatches them all").
  - `effective(doc, path, install)`: the value after schema defaults and, for a zone's `requireSignedImages`, the install-level fallback. `ADD_BASELINE(zone)`: the schema defaults with `egress.mode: 'monitor'` and the added zone's own `preset` (so its base egress hosts are the starting point), the generated install's starting point: an added zone with `off` is guarded, and its preset is not; the project step shows the preset's hosts as information.
  - `classify(before: EditableConfig | undefined, after: EditableConfig): Classification` with `type Classification = { guarded: { path: string; consequence: string }[]; sessionForbidden: string[]; refused: { path: string; message: string }[] }`: zones are matched by `id`; a zone present only in `after` is classified against `ADD_BASELINE`; a zone present only in `before` is a removal (T2's drained rule); a renamed zone is a removal plus an add.
- `confirm.ts`: `type Pending = { id: string; sessionIdHash: string; patch: unknown; changeHash: string; expectRevision: number; meta: ApplyMeta; returnTo?: string; expiresAt: Date }` (`returnTo` a path on this host the confirm POST redirects to after applying; the wizard sets `/setup/doctor`; at most ten `Pending` per session, the oldest evicted, so a script cannot grow memory by spamming guarded patches) and `type Confirmation = { tokenHash: Buffer; pendingId: string; sessionIdHash: string; changeHash: string; expectRevision: number; expiresAt: Date }`, both in memory (a restart drops them; the operator starts the change again). `PENDING_MS = 10 min`, `CONFIRM_MS = 5 min`. `mintConfirmation(pending, session)` is called by the page render only and returns the plain token once; `consumeConfirmation(token, pending, session, revision)` checks hash, pending id, session, change hash, revision and expiry, deletes the record and returns the pending patch, or a reason (`unknown`, `used`, `session`, `changed`, `stale`, `expired`).
- The guarded flow: a session `PATCH` (or rollback, or import) whose classification has `guarded` entries and no `confirmation` is stored as a `Pending` and answered `409 { needsConfirmation: true, pendingId, guarded }`; the page then opens `GET /config/confirm/:pendingId` (session must match the pending's), which renders each consequence verbatim, a passphrase field and Confirm, and mints the confirmation into the form; `POST /config/confirm/:pendingId { token, passphrase }` verifies the passphrase (this is the sudo; a wrong one charges backoff), consumes the confirmation, and applies the stored patch with `expectRevision` unchanged; the audit row has `guarded: 1` and the paths. `sessionForbidden` is answered `403 { sessionForbidden: [paths], hint: 'set with jumpmaster ctl or in the config file' }` whatever else the set carries. `refused` is an ordinary validation issue. The token principal skips `guarded` and `sessionForbidden`; the file (reload) skips both.
- `ApplyMeta` gains `confirmation?: string` and `resume?: string[]`; `ApplyResult` gains `{ ok: false; needsConfirmation: { pendingId: string; guarded: { path; consequence }[] } }`, `{ ok: false; sessionForbidden: string[] }` and `readds: string[]` on success.
- Zones and history: `zoneDrained(db, zoneId)` (extracted from the mode-change guard: observe, no active drop, no pending outbox op) gates removal; removal deletes the `zone_controls` row only; `zoneHasHistory(db, zoneId)` is true when work items, drops, outbox rows, crew issues or goals exist; an apply that adds a zone id with history is refused with "this zone has history: pick another id, or resume it" unless `resume` includes the id; a rollback that re-adds a zone runs the add path (mode row, history check with resume implied, the add-baseline classification) and lists it in `readds`.
- `config.listen`: fail when `allowedHosts` names a non-loopback host and `listen.tlsTerminated` is false, with the fix "put a TLS terminator in front and set JM_TLS_TERMINATED=1, or remove <host> from JM_ALLOWED_HOSTS"; a non-loopback `listen.host` with loopback-only `allowedHosts` stays the warning it is today.
- `ctl` gains nothing new here: a `ctl config set` or `rollback` from the token needs no confirmation; `ctl zones add --resume` lands with T11.

- [ ] **Step 1: Write failing tests.**

```ts
test('a session cannot change a guarded path without the confirmation page, and the token can', ...)
test('a confirmation minted by the page render is accepted once with the passphrase, and a second use is refused as used', ...)
test('a token not minted by the render, a token from another session, a changed set and a stale revision are each refused', ...)
test('an expired confirmation and an expired pending change are refused', ...)
test('a wrong passphrase on the confirmation POST charges backoff and applies nothing', ...)
test('requireSignedImages weakening and a zone image, on an existing or an added zone, are refused from a session with or without a confirmation', ...)
test('each guarded scalar path is guarded only in its weakening direction and its consequence names the zone and value', ...)
test('a removed key is judged on its effective value: requireSignedImages removed under an install at false, egress.mode removed, ciRequired removed', ...)
test('set paths are judged as set differences: a reorder is nothing, a replacement is a removal plus an addition, services are keyed by name', ...)
test('an added zone is judged against the add baseline, through the wizard route, Resume, rollback and the advanced JSON import alike', ...)
test('a rename is a removal plus an add and the add is classified', ...)
test('a rollback that weakens a guarded path needs the confirmation page, and one that sets an image is refused from a session', ...)
test('repo on an existing zone is refused for every principal with the remove-and-re-add message', ...)
test('a preset change on an existing zone is free when the new base hosts are a subset and guarded otherwise, and an added zone's preset is never guarded', ...)
test('an eleventh pending change for one session evicts the oldest', ...)
test('a guarded apply writes an audit row with guarded 1 and the paths', ...)
test('removing a zone with active work is refused, and a drained observe zone is removed with its mode row only', ...)
test('removing a zone keeps its work items, drops, outbox rows, crew issues and goals, and re-adding the id is refused without resume', ...)
test('a rollback that re-adds a zone runs the add path and lists it in readds', ...)
test('config.listen fails on a non-loopback allowed host without tlsTerminated, passes with it, and a non-loopback listen host alone stays a warning', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `classify` over fixture document pairs first; then `confirm.ts`; then the store and the pages.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): guard the risky config paths behind a confirmation and keep zone history`

### Task 4: The vault, file secrets by name, rotation and the credential rules (migration v20)

**Files:**
- Create: `apps/server/src/vault/vault.ts`, `apps/server/src/vault/credentials.ts`, `apps/server/src/vault/problems.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config/store.ts`, `apps/server/src/config/boot.ts`, `apps/server/src/main.ts`, `apps/server/src/scheduler.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/doctor/checks.ts`, `apps/server/src/db/migrations.ts`, `apps/server/src/init.ts`, `apps/server/src/payloads.ts`, `packages/protocol/src/secrets.ts`
- Test: `apps/server/src/vault/vault.test.ts`, `apps/server/src/vault/credentials.test.ts`, `apps/server/src/vault/problems.test.ts`, `apps/server/src/config.test.ts`, `apps/server/src/scheduler.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/init.test.ts`, `packages/protocol/src/secrets.test.ts`

**Interfaces:**
- v20 adds `vault(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, key_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, declared_created_at TEXT, tested_at TEXT, test_result TEXT, login TEXT, note TEXT)`.
- `type CredentialName = 'claudeToken' | 'githubAuthorToken' | 'githubReviewerToken' | 'githubReadToken' | \`zone:${string}:${string}\`` (the last for gate secrets, today's `JM_ZONE_<ID>_<NAME>`).
- **File secrets by name.** `SECRET_FILES: Record<CredentialName, string>` = `claude_token`, `github_author_token`, `github_reviewer_token`, `github_read_token`. `resolveCredentials(env, secretsDir: string | undefined, vault): Resolved`: for each credential, a `*_FILE` variable or a plain variable first (today's `readSecret`), else a regular file `<secretsDir>/<SECRET_FILES[name]>` read with the same checks (`0600`, not group- or world-writable, at most 64 KiB, named at startup when unreadable), else the vault, else `missing`. `readSecret` gains one fallback, a one-release shim removed in M5: a `*_FILE` path under `/run/secrets/` that does not exist, for one of the four credential names, is read from `JM_SECRETS_DIR/SECRET_FILES[name]` (by credential name, not by the path's basename) with a logged warning naming both paths; inert where `JM_SECRETS_DIR` is unset (the stick). Gate secrets keep today's env form plus the vault.
- `openVault(keyFile: string | undefined, db): Vault | 'disabled'`: key is 32 bytes from `JM_VAULT_KEY_FILE` (written by `bootstrap` and `init`, mode `0600`, under `./secrets`, outside the data volume); `keyId = sha256(key).hex.slice(0, 8)`; AES-256-GCM with a 12-byte nonce per write and the name as AAD. No key file with a non-empty vault refuses startup: "the vault at <dataDir> holds N credentials but JM_VAULT_KEY_FILE is unset: the key and the data travel together". No key file with an empty vault → `'disabled'`: the UI's Replace is disabled with "set JM_VAULT_KEY_FILE". A key that fails to decrypt → doctor `vault.key` fail: "the vault key changed: restore the key file or re-enter each credential".
- `type Resolved = Record<CredentialName, { value?: string; source: 'file' | 'env' | 'vault' | 'missing'; path?: string; fingerprint?: string; setAt?: string; declaredCreatedAt?: string; testedAt?: string; testResult?: string; login?: string }>`. The store assembles `config.secrets` from it; `secretList` and `payloadSecrets` include vault values; `credentialFingerprint(resolved)` feeds T2's pair cache. `config.secret-files` checks every file it finds under the secrets directory, the four credential names included.
- `fingerprintOf(value) = sha256(value).hex.slice(0, 8)`.
- `problems.ts`: `type CredentialProblem = { zoneId: string; kind: 'missing' | 'kind' | 'same'; credential: CredentialName; message: string }`; `credentialProblems(zone: DropZoneConfig, resolved: Resolved): CredentialProblem[]`, local and synchronous: `missing` for the Claude token (every zone), the author token, the reviewer token in a two-bot zone, the read token when `reviewReadToken` is true (a private repository without one stays the doctor's `forge.private-clone`, which needs the network); `kind` when a starter zone's author token is not `github_pat_`, or `authorMayBeAdmin` holds with a non-fine-grained token; `same` when both logins are recorded and the reviewer's equals the author's (file-sourced credentials have no recorded login, and `forge.reviewer` keeps judging them as today). The scheduler pass parks dispatch for a zone with problems, reason `credentials: <message>` (visible as the queue reason and to T12's status); the doctor mirrors them as `credential.missing`, `credential.kind` and `credential.same` (fail, per zone). `loadConfig` drops these refinements.
- Tests on entry: `githubAuthorToken` and `githubReviewerToken` → `viewerLogin` (stored as `login`) plus `repoAccess` for every zone; `githubReadToken` → `viewerLogin`; `claudeToken` → shape only, with "the doctor drop is the live proof"; a gate secret → length and name rules only. A failed test stores nothing and returns `{ ok: false, status, permission? }` and nothing else; the handler never logs the request or the upstream error body.
- Routes: `GET /api/control/secrets` → the list without values, plus `problems: CredentialProblem[]` for every zone; `PUT /api/control/secrets/:name { value, declaredCreatedAt?, note? }` (sudo for sessions; value ≤ 64 KiB, no newline; serialized per name; refused for a file- or env-sourced credential with "managed by <path>: replace the file and run `ctl secrets reload`") → `{ fingerprint, tested, problems, runningDropsWithPrevious: number }`; `POST /api/control/secrets/:name/test`; `DELETE /api/control/secrets/:name` (vault entries only; refused when it would create a `missing` problem); `POST /api/control/secrets/reload` (re-reads file and env credentials).
- After a successful Replace the page says "N running drops still carry the previous token; revoke it on GitHub after they finish", computed from active drops dispatched before the rotation, and clears when none remain.
- `ctl secrets list | set <name> [--from-file <path>] [--created YYYY-MM-DD] | test <name> | remove <name> | reload`; `set` reads the value from `--from-file` or stdin, never argv.
- `credentialCreatedAt('claudeToken')`: the vault's `declared_created_at` (defaulting to `created_at`) in db mode, `claude.tokenCreatedAt` in file mode; `claude.token-age` uses it. Doctor checks added: `credential.missing`, `credential.kind`, `credential.same`, `credential.shadowed` (warn: a file and a vault entry both set and different; the file is in use), `vault.key`.
- `init` writes `secrets/vault_key` beside the join and operator tokens (T5 moves all three to `bootstrap`) and stops writing its `.env` block.

- [ ] **Step 1: Write failing tests.**

```ts
test('v20 adds vault', ...)
test('a value round-trips through AES-256-GCM with the name as AAD and a fresh nonce per write', ...)
test('a wrong key fails to decrypt and the doctor reports vault.key as fail, naming no value', ...)
test('a missing key file with a non-empty vault refuses startup with the travel-together message', ...)
test('a file named for the credential under the secrets directory is a file secret with the 0600 and regular-file checks, and wins over a vault entry', ...)
test('a _FILE variable still wins, and one under /run/secrets that is missing falls back to the secrets directory with a warning', ...)
test('an init-written M4 directory resolves every credential as source file and no zone has a problem', ...)
test('a credential set in both places with different values warns credential.shadowed without printing either', ...)
test('PUT secrets needs sudo for a session, never for the Bearer token, and is refused for a file-managed credential with its path', ...)
test('a rotated author token is tested against every zone, the next drop payload carries it and a running drop keeps the old', ...)
test('after a rotation the response counts running drops that still carry the previous token, and the count reaches zero when they finish', ...)
test('a failed test stores nothing, returns only the status and permission, and the distinct fixture value reaches no log line, audit row or response', ...)
test('two PUTs for one name are serialized', ...)
test('the list carries fingerprint, source, path for a file, login and dates and no value, prefix, suffix or length', ...)
test('a Claude token set in the UI dates claude.token-age from today unless a date is given', ...)
test('credentialProblems: no Claude token, a two-bot zone without a reviewer token, a starter zone with a classic author token, authorMayBeAdmin with a classic token, reviewReadToken without a read token, and recorded reviewer login equal to author each produce one problem, and unknown logins produce none', ...)
test('a zone with a credential problem is parked by the scheduler with the problem as its reason, and dispatches once the credential arrives', ...)
test('a credential change that invalidates a zone parks it on the next pass and the doctor fails credential.kind or credential.same', ...)
test('loadConfig no longer refuses a config for a credential rule; parseEditable keeps the config-only rules', ...)
test('DELETE of a credential a zone needs is refused with the problem it would create', ...)
test('ctl secrets set reads the value from stdin or a file and refuses one in argv', ...)
test('vault values are scrubbed from server logs and from payload redaction', ...)
test('init writes secrets/vault_key with mode 0600 and no compose variables into .env', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The vault module knows nothing about credentials; `credentials.ts` knows the names, sources and tests; `problems.ts` knows the rules.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the credential vault, file secrets by name, rotation and the credential rules`

### Task 5: The compose rework, `bootstrap`, and the smoke and deploy tests

**Files:**
- Create: `apps/server/src/bootstrap.ts`
- Modify: `apps/server/src/cli.ts`, `apps/server/src/init.ts`, `deploy/compose.yaml.tmpl`, `deploy/.env.example`, `deploy/compose.build.yaml`, `deploy/smoke.sh`, `deploy/deploy.test.ts`, `scripts/render-compose.ts`, `.github/workflows/images.yml`
- Test: `apps/server/src/bootstrap.test.ts`, `apps/server/src/cli.test.ts`, `apps/server/src/init.test.ts`, `deploy/deploy.test.ts`, `scripts/render-compose.test.ts`

**Interfaces:**
- **Compose template.** `jumpmaster`: `user: "${JM_UID:-1000}:${JM_GID:-1000}"`, `command: ["serve"]`, environment `JM_CONFIG=/config/jumpmaster.config.json`, `JM_DATA_DIR=/data`, `JM_SECRETS_DIR=/secrets`, `JM_LISTEN_HOST=0.0.0.0`, `JM_ALLOWED_HOSTS=127.0.0.1:7420,localhost:7420`, `JM_JOIN_TOKEN_FILE=/secrets/join_token`, `JM_OPERATOR_TOKEN_FILE=/secrets/operator_token`, `JM_VAULT_KEY_FILE=/secrets/vault_key`; volumes `./data:/data`, `./config:/config:ro`, `./secrets:/secrets:ro`; `depends_on: bootstrap: condition: service_completed_successfully`; **no credential `_FILE` variable, no `${JM_REVIEWER_TOKEN_*}` or `${JM_READ_TOKEN_*}` interpolation, no `secrets:` key anywhere.** `stick`: `JM_JOIN_TOKEN_FILE=/secrets/join_token`, volume `./secrets:/secrets:ro`, `depends_on` bootstrap and jumpmaster. `bootstrap`: the server image, `command: ["bootstrap"]`, the same `user`, `restart: "no"`, `read_only`, volume `.:/install`, `JM_INSTALL_DIR=/install`. `init`: as today with the `user` default. `.env.example` documents `JM_UID`/`JM_GID` as optional with the default, and says the M4 `init` block is unused and may be deleted.
- **`jumpmaster bootstrap [dir]`**: under the install directory, creates `secrets/` and `data/` with mode `0700` when missing and tightens them to `0700` when present and owned by its uid; creates `secrets/join_token`, `secrets/operator_token` and `secrets/vault_key` (32 random bytes each, base64url, `0600`) when missing and tightens existing ones to `0600`; idempotent; refuses uid 0 as `init` does. When a directory or file is not writable by its uid it reads the owner and prints the fix for that case: owner root → `the directories were created as root (docker compose run with sudo, or by the engine): run  sudo chown -R <uid>:<gid> secrets data  and start again`; another uid → `set JM_UID and JM_GID in .env to your user: printf 'JM_UID=%s\nJM_GID=%s\n' "$(id -u)" "$(id -g)" > .env`; then exits 1, so the server does not start. It prints the names it created or tightened and never a value. `cli.ts` adds `bootstrap` to `RESERVED`. `init` gains `--secrets-only` (the same) and calls `bootstrap` for its secrets.
- **Smoke.** `deploy/smoke.sh` gains four cases beside the existing `init` one, each ending with the setup code on the server's stderr line, `GET /setup` answering 200 on `127.0.0.1:7420`, the stick enrolled, and `ctl passphrase set` ending setup mode: **(a) `.env` only**; **(b) an empty directory** on a uid-1000 host; **(c) root-owned directories**: `secrets/` and `data/` pre-created by root (and, on a host with `sudo`, `sudo docker compose up`), the first `up` fails in `bootstrap` with the `chown` line, the printed command is run, the second `up` reaches the setup page; **(d) the M4 upgrade**: an install directory written by `init --offline --preset node --identity starter` from the previous release's compose (the `.env` block, `secrets/*`, `config/`), `compose.yaml` replaced, `up`, then `ctl secrets list` shows every credential as source `file` with its path, `ctl status` is not a credential block, and the zone is not parked. Case (d) also runs the host export line (`docker compose exec -T … > config/x.tmp && mv …`) and `ctl config mode file` after an `adopt`, so the way back is smoked once, and includes a leftover `secrets/github_reviewer_token` beside a starter zone: harmless (starter zones never use it; a file credential carries no login), shown on the Credentials tab as present but unused, and the upgrade note says it may be deleted. CI's image e2e job runs all cases.
- `deploy/deploy.test.ts`: static tests for the template shape, and one live test per smoke case that runs when `JM_SMOKE=1` and is skipped by name otherwise.

- [ ] **Step 1: Write failing tests.**

```ts
test('the default compose declares no secrets key, no credential _FILE variable and no init .env interpolation, and reads the machine secrets from /secrets', ...)
test('bootstrap runs before the server and the stick, as the same uid, with the install directory read-write', ...)
test('JM_UID and JM_GID default to 1000 in the template, and .env.example says the M4 init block is unused', ...)
test('the template needs no override file', ...)   // PR #51's test, kept true
test('bootstrap creates secrets/ and data/ 0700 and the three machine secrets 0600 once, tightens looser modes, is idempotent and prints no value', ...)
test('bootstrap on a root-owned directory prints the chown line, on another uid the .env line, and exits 1 either way', ...)
test('jumpmaster bootstrap is a reserved command, not a config path', ...)
test('init --secrets-only equals bootstrap and init no longer writes compose variables into .env', ...)
test('from a directory holding only .env, compose up reaches the setup page', ...)            // live, JM_SMOKE=1
test('from an empty directory, compose up reaches the setup page', ...)                        // live
test('with root-owned bind directories the first up prints the chown line and the second reaches the setup page', ...)   // live
test('an init-written M4 directory upgrades by replacing compose.yaml: every credential resolves as file and no zone is parked', ...)   // live
test('the host export line and mode file round-trip on the upgraded install', ...)            // live
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Template and `bootstrap` first (the smoke decides them).
- [ ] **Step 4: Run the full suite and every smoke case.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat: start from an empty directory and upgrade an M4 install by replacing compose.yaml`

### Task 6: The setup wizard

**Files:**
- Create: `apps/server/src/ui/setup.ts`, `apps/server/src/zones/detect.ts` (from `init`'s detection; T7 and T11 extend it)
- Modify: `apps/server/src/init.ts`, `apps/server/src/app.ts`, `apps/server/src/auth/guard.ts`, `apps/server/src/ui/auth-pages.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/ui/setup.test.ts`, `apps/server/src/zones/detect.test.ts`, `apps/server/src/init.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- The wizard after T1's passphrase step, each step a thin frame over an existing handler, with "Do this later" on every step and progress in `settings.setup.step`: `/setup/claude` (token and plan; where to get it: `claude setup-token`; the link to Anthropic's terms, §12.1), `/setup/forge` (author token; reviewer token or starter mode with `STARTER_WARNING` verbatim; read token for a private repository; each tested before saving; T7 adds the recommendation, the template links and the checklist to this step), `/setup/stick` ("Your runner has checked in" from `sticks.last_seen_at`, or the `docker compose logs stick` hint), `/setup/project` (repository → `detect` → gates for review → create through the same apply path as T11's page, egress monitor, identity as chosen; T7 adds the ruleset file and CODEOWNERS to this step), `/setup/doctor` (runs it; fails with their actions; "Go to the factory floor"). Every wizard apply that answers `409 needsConfirmation` (the recommended starter path on a personal repository, a detected service) sends the browser to T3's confirmation page with `returnTo` set to the next wizard step, so after Confirm the user lands on `/setup/doctor` and never sees raw JSON; the project step shows the chosen preset's base egress hosts as information, not as a confirmation. The frame shows until a zone exists or the operator dismisses it. Afterwards every control it offered lives on the Credentials tab (T9) or, for adding a project, at `/setup/project`, which the home page links as "Add a project" until the zones page (T11) takes that link over. A file-mode install sees "Your config file holds N zones" with the adopt offer in place of the project step.
- `detect.ts`: `detectRepo(forge, repo): Promise<Detection>` with `type Detection = { visibility: 'public' | 'private'; defaultBranch: string; preset?: Preset; candidates: Preset[]; gates: GateSpec[] }`, GET-only on the default branch root, after `init`'s `REPO` regexp, shared with `init`.
- Routes: `POST /api/control/detect { repo }`; `POST /api/control/zones { zone, resume? }` (id defaults to the repository name in lower case; a repo already in another zone is refused; an id with history is refused unless `resume`); the wizard's steps post to T4's secret routes and this one. `ctl detect <owner/name>`; `ctl zones add <owner/name> [--id <id>] [--preset <p>] [--identity starter] [--egress off|monitor|enforce] [--resume]`, where `--egress` defaults to `monitor` so a scripted add matches the wizard and the add baseline rather than the schema's `off`.
- `/setup` names where the code is: the server's own output, or `docker compose logs jumpmaster` under compose.

- [ ] **Step 1: Write failing tests.**

```ts
test('a fresh install redirects to /setup, and each wizard step is skippable and resumable', ...)
test('the forge step tests the token before saving and shows the starter warning verbatim', ...)
test('the project step runs detection after the REPO regexp and creates the zone through the apply path, classified against the add baseline', ...)
test('on a personal public repository the starter recommendation with detected services shows the confirmation page with the starter warning and the service, not raw JSON, and continues to the doctor step after the passphrase', ...)
test('the project step shows the preset base hosts as information and asks no confirmation for them', ...)
test('ctl zones add without --egress writes monitor', ...)
test('init uses the shared detection and its output is unchanged', ...)
test('adding a zone whose repo is already in another zone is refused, and an id with history is refused without resume', ...)
test('the wizard disappears once a zone exists or is dismissed, the Credentials tab holds its credential controls, and /setup/project stays linked from home', ...)
test('a file-mode install sees its zones in the wizard with the adopt offer', ...)
test('/setup says where the code is printed', ...)
test('ctl detect and ctl zones add map to the routes', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): set up a fresh install from the browser`

### Task 7: GitHub guidance: pre-filled tokens, the ruleset file, the identity recommendation, CODEOWNERS and collaborators

**Files:**
- Create: `apps/server/src/github/guidance.ts`, `apps/server/src/github/workflows.ts`, `apps/server/src/ui/github.ts`
- Modify: `apps/server/src/zones/detect.ts`, `apps/server/src/forge/github.ts`, `apps/server/src/ui/setup.ts`, `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/github/guidance.test.ts`, `apps/server/src/github/workflows.test.ts`, `apps/server/src/ui/github.test.ts`, `apps/server/src/zones/detect.test.ts`, `apps/server/src/ui/setup.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- `detect.ts` gains `ownerType: 'User' | 'Organization'` (from the repository's `owner.type`) and `ciJobs: { workflow: string; job: string }[]` from `.github/workflows/*.yml` on the default branch (GET-only; `listDir` plus a content read per file). `workflows.ts`: `jobNames(yaml: string): string[]`, a line-based reader: the keys at indent 2 under a top-level `jobs:`, each replaced by its `name:` at indent 4 when present; tested on a fixture of real workflow shapes. A matrix job's expanded names and a reusable workflow's jobs (which appear as `caller / inner` on the Checks tab) are beyond it, and the step says to check the names on the repository's Checks tab.
- `guidance.ts`:
  - `PAT_PERMISSIONS: Record<'author' | 'reviewer' | 'read', Record<string, 'read' | 'write'>>`, the install runbook's table, and `patTemplateUrl(role, repo: { owner: string; name: string }, opts: { expirationDays?: number }): string` → `https://github.com/settings/personal-access-tokens/new?…` with the name, description, resource owner, repository and each permission as GitHub's "Pre-filling fine-grained personal access token details using URL parameters" documents (parameter names taken from that page at implementation time). Never a Workflows or Administration permission. The rendered step says "check the Resource owner field: for an organization it may not pre-fill".
  - `rulesetJson(zone: DropZoneConfig, detection: Pick<Detection, 'defaultBranch' | 'ciJobs'>): string`: the install runbook's Branch rules JSON (`target: branch`, `enforcement: active`, `bypass_actors: []`, the default branch, a `pull_request` rule with `required_approving_review_count` 1 for two-bot and 0 for starter and `dismiss_stale_reviews_on_push: true`, `required_status_checks` with one `{ context, integration_id: 15368 }` per detected job), compared field by field with the runbook in a test.
  - `recommendIdentity(d: { ownerType; visibility; paidPlan?: boolean }): { identity: 'two-bot' | 'starter'; authorMayBeAdmin: boolean; reason: string; stop?: string }`: User + public → starter with your own account and `authorMayBeAdmin` (`STARTER_WARNING` verbatim in `reason`; a fine-grained PAT cannot serve a collaborator bot on another user's repository); Organization → two bots with fine-grained PATs owned by the organization (the organization must allow fine-grained PATs; link the setting); private with `paidPlan: false` → `stop`: "rulesets on a private repository need a paid plan: make it public or upgrade before any token is created"; private with `paidPlan` unknown → the step asks first, since GitHub does not expose the plan to a non-admin token.
  - `codeownersText(zone, reviewers: string[]): string`: one line per `protectedPaths` entry naming each reviewer login (the operator types their own login in the step); `codeownersNewFileUrl(repo, branch)` → `https://github.com/<o>/<r>/new/<branch>?filename=.github/CODEOWNERS`.
  - `collaboratorChecklist(zone, logins: { author: string; reviewer?: string }): { url: string; items: string[] }` → `https://github.com/<o>/<r>/settings/access` with "invite <login> with the Write role" and "accept the invitation as <login>" per bot.
  - `type ZoneGuidance = { recommendation: ReturnType<typeof recommendIdentity>; pat: { author: string; reviewer: string; read: string }; ruleset: { filename: string; text: string }; codeowners: { filename: string; text: string; newFileUrl: string }; checklist: { url: string; items: string[] } }`; `zoneGuidance(zone, detection, logins): ZoneGuidance` assembles the five for a zone, and is what the page, the route, T8's artifacts and `ctl github` all read.
  - Every URL is under `https://github.com/`; every text is free of credentials; a test asserts both over the fixture.
- Surfaces: the wizard's forge step shows the recommendation before the token fields, then the two template links, the paste-and-test fields, and the collaborator checklist once the logins resolve; the project step shows the ruleset file (download and copy) with the two-line import instruction and the `settings/rules` link, then the CODEOWNERS text with its link; `GET /zones/:id/github` holds all five for any time later (reachable from home and the doctor before the zones page exists); T8 attaches the ruleset and CODEOWNERS as artifacts on `forge.branch-rules`, `forge.codeowners` and `forge.ci`.
- Routes: `GET /api/control/zones/:id/github` → `ZoneGuidance`; `POST /api/control/github/recommend { repo, paidPlan? }` (runs detection) for the wizard before a zone exists.
- `ctl github <zone> recommend | pat <author|reviewer|read> | ruleset | codeowners [--reviewer <login>] | checklist`.

- [ ] **Step 1: Write failing tests.**

```ts
test('detect reports the owner type and the workflow job names from .github/workflows over GET only', ...)
test('jobNames reads job ids and name overrides from real workflow shapes, ignores a matrix expansion, and the step names the caller / inner form', ...)
test('the author, reviewer and read template URLs carry exactly the runbook permissions once each and never Workflows or Administration', ...)
test('the ruleset JSON equals the runbook field for field, lists each detected job as a required check, and needs 1 approval for two-bot and 0 for starter', ...)
test('recommendIdentity: user and public is starter with authorMayBeAdmin and the starter warning; organization is two-bot; private on a free plan stops before any token; private with the plan unknown asks', ...)
test('codeownersText writes one line per protected path naming each reviewer, and the new-file link targets .github/CODEOWNERS on the default branch', ...)
test('the collaborator checklist names the resolved bot logins with the Write role', ...)
test('every generated URL is under github.com and no generated text carries a credential', ...)
test('the forge step shows the recommendation before the fields and the project step shows the ruleset file and CODEOWNERS', ...)
test('ctl github maps to the routes and prints each artifact', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pure functions first, from fixtures that mirror the runbook; then the pages and verbs.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): guide the GitHub half with pre-filled links and generated files`

### Task 8: Doctor: fix links, artifacts and the label action

**Files:**
- Create: `apps/server/src/doctor/actions.ts`
- Modify: `apps/server/src/doctor/checks.ts`, `apps/server/src/doctor/run.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`, `apps/server/src/outbox.ts`, `apps/server/src/forge/github.ts`
- Test: `apps/server/src/doctor/actions.test.ts`, `apps/server/src/doctor/checks.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/outbox.test.ts`, `apps/server/src/forge/github.test.ts`

**Interfaces:**
- `DoctorCheck.action?: { kind: 'app' | 'forge' | 'docs'; label: string; href: string; artifact?: { filename: string; text: string } }`. `app` is a path in this UI; `forge` is a page on the repository; `docs` is today's install-runbook anchor. `fix` stays for `ctl` and the page.
- `actionFor(check: DoctorCheck, ctx: { zone?: DropZoneConfig; guidance?: ZoneGuidance; pages: { zones: boolean; settings: boolean } }): Action | undefined` from a table keyed by check id, plus `NO_ACTION: Record<string, string>` naming each id without an action and why. The mapping: `config.listen`, `claude.plan`, `usage.gate` → `/settings/install` when `pages.settings`, else docs; `config.uid`, `config.secret-files`, `config.restart-pending` → docs; `claude.token-age`, `forge.author`, `forge.reviewer`, `forge.admin`, `forge.private-clone`, `credential.*`, `vault.key` → `/settings/credentials` (T9); `forge.author-reads`, `forge.reviewer-reads` → the T7 template link for that role (`forge`); `control.kill` → `/`; `stick.*` → `/` (the home page's sticks section); `forge.branch-rules` → the `settings/rules` page with the ruleset file as `artifact`; `forge.codeowners` → the CODEOWNERS new-file link with the text as `artifact`; `forge.ci` → the `actions` page with the detected job names in the label; `forge.labels` → the app action **Create the missing labels**; `zone.mode` → `/zones` when `pages.zones`, else `/`; `zone.preset`, `zone.services`, `zone.egress`, `zone.identity`, `zone.goals`, `zone.crew-cap` → `/zones/<id>#<section>` when `pages.zones`, else the docs anchor (T11 sets `pages.zones`); `zone.doctor-drop` → the existing run button; `config.file` → `/settings/history` when `pages.settings`, else docs. A test asserts that every action resolves to a registered page in the M4.5a configuration.
- `POST /api/control/zones/:id/labels` → outbox op `create-labels` run with `runOp(db, forges, op, now, { allowInObserve: true })`: for each configured label missing, GET then create as the author bot, idempotent by name; the kill check still applies; audited; then `forge.labels` re-runs. `GitHubForge.createLabel(name, color, description)`.
- The doctor page renders fails first, each with its action as a link or button and a download for an artifact; `ctl doctor` prints an `action:` line per fail (the href, or the route for an app action) and writes artifacts with `--artifacts <dir>`.

- [ ] **Step 1: Write failing tests.**

```ts
test('every doctor check id has an action or a reason in NO_ACTION, and the install runbook lists the same ids', ...)
test('in the M4.5a configuration every action href is a registered page, a github.com page or a runbook anchor', ...)
test('a zone check links to its zone page section once the zones page exists and to the runbook before', ...)
test('a credential check links to the Credentials tab', ...)
test('forge.branch-rules and forge.codeowners carry the generated file as an artifact, and forge.ci names the detected jobs', ...)
test('forge.author-reads and forge.reviewer-reads link the template URL for that role', ...)
test('forge.labels offers the create action, which runs through the outbox as the author and is idempotent', ...)
test('the label action works in observe mode and is refused when killed, with an audit row either way', ...)
test('no other outbox op bypasses the observe suppression', ...)
test('the doctor page renders fails first with their action links escaped and artifact downloads', ...)
test('ctl doctor prints the action for each fail and writes artifacts to the given directory', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): link each doctor fail to the control that fixes it`

### Task 9: Settings, part one: the Credentials tab

**Files:**
- Create: `apps/server/src/ui/settings.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/ui/pages.ts`
- Test: `apps/server/src/ui/settings.test.ts`, `apps/server/src/ui/routes.test.ts`

**Interfaces:**
- `GET /settings/credentials` (and `GET /settings`, which redirects to it until T13 adds the other tabs): a row per `CredentialName` in use (name, plain-English role, source with the path for a file, fingerprint, login where known, set at, created at — editable for the Claude token — last test and result), Replace (disabled with the managed-by text for a file- or env-sourced credential; for a vault one, opens the sudo prompt for a session, then a `PUT` with the value in the body only) and Test; the running-drops line after a rotation (T4); the credential problems of every zone with their messages; a banner when the Claude token is past day 330, repeated on home. Every control the wizard's Claude and forge steps offered is here.
- No new routes: the tab is a page over T4's secret routes.

- [ ] **Step 1: Write failing tests.**

```ts
test('the credentials tab shows source and path, fingerprint, login and dates for each credential, the zone problems, and no value', ...)
test('Replace is disabled with the managed-by text for a file credential, and for a vault one opens a sudo prompt and PUTs the value only in the body', ...)
test('a Claude token past day 330 shows the expiry banner on the tab and on home', ...)
test('/settings redirects to the credentials tab until the other tabs exist', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the credentials tab`

### Task 10: The owner dry run: the M4 upgrade, db mode on the reference project, and the split decision

**Files:**
- Create: `docs/runbooks/m4-5-dry-run.md`

- [ ] **Step 1: Upgrade the reference project.** Drain, replace `compose.yaml` with the M4.5 build, `up`. Expected: every credential resolves as source `file` (`ctl secrets list`), no zone parks, file mode, the setup code prints; claim it with `ctl passphrase set` or the browser.
- [ ] **Step 2: Prepare the way back.** Schedule on the host a daily `docker compose exec -T jumpmaster jumpmaster ctl config export > config/jumpmaster.config.json.tmp && mv config/jumpmaster.config.json.tmp config/jumpmaster.config.json` (the line is in the runbook; `-T` keeps a hand run from allocating a pty and writing CRLF), run it once by hand, and confirm `ctl config mode file` accepts the result against a copy of the database.
- [ ] **Step 3: Adopt.** `ctl config adopt` on the reference project. Expected: the UI becomes editable; the next pass runs on revision 2; the file is still a current mirror the next morning.
- [ ] **Step 4: Run the a-part of the operability session** (T16's script, steps 1–3 and 7) with the owner as the partner, on a fresh test repository, recording the same counters. Exercise the PAT template links for real as the bot accounts' owner, and note whether the resource-owner parameter pre-fills on an organization. Expected: every count zero; every hesitation over a minute written down.
- [ ] **Step 5: Fix.** Every hesitation, false doctor result or doc gap becomes a test-first fix or a wording change before T11.
- [ ] **Step 6: Decide.** If this step is reached more than a fortnight after T9 merged, or the a-part cannot be completed within the bar, ship **M4.5a** now (T1–T9, with T14's manifest and T15's docs for what exists; gate: the session's steps 1–3 and 7, both partners) and **M4.5b** after (T11–T13; gate: steps 4–6 and 8). Otherwise continue as one milestone. Either way T16's step 2 repeats the dry run for steps 4–6 and 8 once T13 is in.
- [ ] **Step 7: Commit.** `docs: add the M4.5 dry-run runbook`

### Task 11: The zones page and `ctl zones`

**Files:**
- Create: `apps/server/src/ui/zones.ts`, `apps/server/src/zones/form.ts`
- Modify: `apps/server/src/zones/detect.ts`, `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ctl.ts`, `apps/server/src/ui/pages.ts`, `apps/server/src/doctor/actions.ts`, `apps/server/src/doctor/checks.ts` (`egressSeen` and `HostSeen` exported)
- Test: `apps/server/src/ui/zones.test.ts`, `apps/server/src/zones/form.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/doctor/actions.test.ts`

**Interfaces:**
- Pages: `GET /zones` (one row per zone: id, repo, mode with its plain label, preset or image, egress mode, identity, last drop, the doctor's fail count, a credential problem if any; Pause, Resume, Observe buttons; "Add a project", which takes over the home page's link from `/setup/project`; a link to the zone's GitHub page), `GET /zones/new`, `GET /zones/:id`. `actionFor`'s `pages.zones` becomes true.
- The zone page has five sections, each a form that posts one merge patch (`PATCH /api/control/config` with `{ dropZones: [{ id, …}] }`) and `expectRevision`: **Project** (repo shown read-only with "remove and re-add to change", `readyLabel` with its note, `retryLabel`, `adoptPulls`), **Stack** (preset, or the image digest shown read-only with "set with `ctl` or in the config file"; gates as rows of name, run, timeout; verification; services; limits), **Egress** (mode; allow list; **Observed in the last 14 days**: host, the drops that used it, whether a preset lists it, a tick box per host, "Adopt ticked"), **Merging** (identity with `STARTER_WARNING` verbatim, `ciRequired`, `ciDeadlineMinutes`, `requireBranchProtection`, `authorMayBeAdmin`, `protectedPaths`, `overrideApprovers`, `reviewReadToken`), **Advanced** (the zone's JSON, editable, validated the same way; this is where models, budgets, crew and the remaining fields are edited in M4.5). Schema issues render beside the field whose path they name. A `needsConfirmation` result sends the browser to T3's confirmation page and back. A `sessionForbidden` result renders the "set with `ctl` or in the config file" note. File mode renders every section read-only under the adopt banner.
- `formToZone(fields: Record<string, string | string[]>): unknown` and `zoneToForm(zone: DropZoneConfig): Record<string, string | string[]>`, pure, with a round-trip property over every zone in the test fixtures.
- Add from the page: T6's `POST /api/control/zones` with the Resume offer rendered when the id has history (what it brings back is listed); `DELETE /api/control/zones/:id` (T3's `zoneDrained`); `GET /api/control/zones/:id/egress/observed` → `{ since, hosts: HostSeen[] }` from `egressSeen(db, zoneId, since)`; `POST /api/control/zones/:id/egress/adopt { hosts }` → entries validated by `validAllowEntry`, a guarded change (so from a session it goes through the confirmation page), revision note "adopt observed hosts: …". The existing `POST /api/control/zones/:id { mode }` stays.
- `ctl zones list [--json] | show <zone> [--json] | set <zone> <path>=<json>… | remove <zone> | egress observed <zone> | egress adopt <zone> <host>…` join T6's `add`.

- [ ] **Step 1: Write failing tests.**

```ts
test('/zones lists every zone with its plain-English mode, egress mode, identity and credential problem, links its page, and owns the home page add link', ...)
test('each section of the zone page is filled from the current config and posts a patch with expectRevision', ...)
test('a schema issue is rendered beside the field its path names', ...)
test('a guarded change from a session goes to the confirmation page and succeeds with the token', ...)
test('the image and the repo are read-only on the page with their notes', ...)
test('form fields and zone JSON round-trip for every fixture zone', ...)
test('in file mode the zone page is read-only and shows the adopt banner', ...)
test('an id with history offers Resume, and resume brings the history back under a fresh mode row', ...)
test('the egress section lists observed hosts with their drops and marks those no preset lists', ...)
test('adopt adds only ticked, valid entries, is guarded, and records the revision note', ...)
test('pause, resume and observe from the zones page keep the existing guards', ...)
test('zone doctor checks now link to the zone page sections', ...)
test('the zone page shows no secret', ...)
test('ctl zones set, remove and egress adopt map to the routes and refuse an unknown path', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** `form.ts` first (pure), then the pages, then the routes and `ctl`.
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the zones page and ctl zones`

### Task 12: Status: what Jumpmaster is doing and why it waits

**Files:**
- Create: `apps/server/src/status.ts`
- Modify: `apps/server/src/ui/pages.ts`, `apps/server/src/app.ts`, `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/status.test.ts`, `apps/server/src/ui/routes.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- `type Status = { headline: string; detail: string; waitingOn: 'nothing' | 'you' | 'ci' | 'forge' | 'claude' | 'stick' | 'setup' | 'doctor' | 'credentials'; since?: string; action?: { label: string; href: string } }`.
- `type StatusInput = { setupActive: boolean; killed: boolean; usagePausedUntil?: string; sticks: { live: number }; doctor: { fails: DoctorCheck[]; finishedAt?: string }; lastPassAt?: string; openBriefings: number; zones: { id: string; mode: ZoneMode; items: WorkItem[]; drops: Drop[]; parked: number; credentialProblems: CredentialProblem[] }[]; outboxRetrying: OutboxRow[]; restartPending: boolean }`, built in `app.ts` from what the home route already loads plus `latestDoctorRun` and the last pass time.
- `statusOf(input: StatusInput, now: Date): Status`, pure; first match wins: setup incomplete ("Finish setup", `/setup`); killed ("Stopped by the kill switch since …", `/`); usage pause ("Paused by Claude's usage limit until …"); no live stick ("No runner: the stick hasn't checked in", `/`); a running drop ("Working: <role> #<issue> in <zone>, <elapsed>, gate <k> of <n>", `/drops/<id>`); waiting on CI ("Waiting on CI for PR #<n> (<m> of <deadline> min)"); a credential problem, when no zone is working ("Blocked: <zone> needs <credential>: <message>", `/settings/credentials`); doctor fails from a run newer than the last pass ("Blocked: N doctor fails, first <id>", `/doctor`); open briefings ("Waiting on you: N briefings", `/briefings`); every zone paused or observing ("Paused by you: <zones>", `/zones`); an outbox op retrying ("Retrying a GitHub call: <op>", `/`); parked items ("N parked: <first reason>", `/`); queued without a slot ("Queued: N issues; every slot is busy"); idle ("Idle: no ready issues. Label one agent-ready or file one from Intake", `/zones/<id>/intake`). Credential problems while another zone works, doctor fails older than the last pass, and `restartPending` are appended to `detail` instead of taking the headline.
- The home page opens with the status banner; the page `<title>` carries the headline. `GET /api/control/status` → `Status`; `ctl status [--json]`.

- [ ] **Step 1: Write failing tests.**

```ts
test('statusOf returns one headline per state, in priority order, over the fixture table', ...)
test('running work outranks a doctor fail older than the last pass and a credential problem in another zone, which move to the detail', ...)
test('a credential problem takes the headline only when no zone is working, naming the zone and the credential', ...)
test('the home page opens with the status banner and its action link, and titles the page with the headline', ...)
test('ctl status prints the headline and detail, and --json the object', ...)
test('the status names zones, issues and PRs and never a token', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): say what Jumpmaster is doing and why it waits`

### Task 13: Settings, part two: install settings, MCP tokens and history

**Files:**
- Modify: `apps/server/src/ui/settings.ts`, `apps/server/src/api/control.ts`, `apps/server/src/app.ts`, `apps/server/src/ctl.ts`, `apps/server/src/doctor/actions.ts`
- Test: `apps/server/src/ui/settings.test.ts`, `apps/server/src/api/control.test.ts`, `apps/server/src/ctl.test.ts`, `apps/server/src/doctor/actions.test.ts`

**Interfaces:**
- `GET /settings` becomes the tabbed page, each tab a path (`/settings/credentials`, `/settings/install`, `/settings/mcp-tokens`, `/settings/history`; `/settings` redirects to the first): **Credentials** (T9), **Install** (`pollSeconds`, `usage.throttleUtilization`, `usage.stopOnOverage` (guarded to false), `claude.plan`, `claude.fableModel`, `claude.fableWeeklyDropCap`, `requireSignedImages` (weakening shown as "set with `ctl` or in the config file"), `mcp.*` (`mcp.enabled` marked "takes effect at the next restart" and guarded to true); `listen` and `dataDir` shown read-only with where they are set (the file, or `JM_LISTEN_HOST`, `JM_LISTEN_PORT`, `JM_ALLOWED_HOSTS`, `JM_TLS_TERMINATED`, `JM_DATA_DIR`); a "restart pending" badge from `config.restart_pending`), **MCP tokens** (§7.5: Command's tokens are created in the UI with a scope and an expiry; the routes exist since M3, the page and the `ctl` verbs don't: mint with zone, scope and days, shown once; list; revoke), **History** (T2's revisions with their changes, `guarded` and `readds` marks and a Revert button per revision; a revert that re-adds a zone says so before it runs, and a revert from a session goes through the confirmation page when it must). `actionFor`'s `pages.settings` becomes true.
- `ctl settings set <path>=<json>…` (T2's `config set`, limited to install-wide paths); `ctl mcp-tokens mint <zone> <read|write> --days N [--label <text>] | list | revoke <id>` over the existing routes.

- [ ] **Step 1: Write failing tests.**

```ts
test('the install tab marks mcp.enabled as restart-needed, shows the boot settings read-only with their source, and applies the rest live', ...)
test('requireSignedImages weakening is offered only as the ctl-or-file note, and stopOnOverage to false goes to the confirmation page', ...)
test('the MCP tokens tab mints a token shown once, lists tokens without values and revokes one', ...)
test('history lists revisions with their changes, guarded and re-add marks, and Revert posts a rollback with the id', ...)
test('install and history doctor checks now link to their tabs', ...)
test('ctl settings set and ctl mcp-tokens map to the routes', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): add the install, MCP tokens and history tabs`

### Task 14: `ctl` parity and the control manifest

**Files:**
- Create: `apps/server/src/api/manifest.ts`
- Modify: `apps/server/src/api/control.ts`, `apps/server/src/ctl.ts`
- Test: `apps/server/src/api/manifest.test.ts`, `apps/server/src/ctl.test.ts`

**Interfaces:**
- `CtlRequest` grows to `{ path: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }` (today it is `{ path, body } | { path, method: 'GET' }`).
- `CONTROL_ROUTES: { method; path: string; ctl: string | null; reason?: string }[]`, one entry per route under `/api/control/`, `ctl` an example invocation that `ctlRequest` must map to that method and path; `ctl: null` only with a `reason` (`/api/control/sudo`: "browser re-auth; the token is always sudo").
- `ctl help` prints every verb grouped by page (Status, Setup, Zones, GitHub, Settings, Credentials, Config, Doctor, Briefings, Kill); `ctl <verb> --help` prints that verb's forms. The `usage:` string in `ctl.ts` is generated from the manifest.

- [ ] **Step 1: Write failing tests.**

```ts
test('every registered /api/control route is in the manifest and every manifest entry is registered', ...)
test('every manifest entry with a ctl example parses to its method and path, PUT, PATCH and DELETE included', ...)
test('a manifest entry without a ctl verb carries a reason', ...)
test('ctl help lists every verb in the manifest and nothing else', ...)
```

- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full suite.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): keep ctl and the control API in step with a manifest`

### Task 15: Docs: the browser path first, the prelude stated exactly, the upgrade in three steps

**Files:**
- Create: `docs/runbooks/operate.md`
- Modify: `README.md`, `docs/runbooks/install.md`, `SECURITY.md`, `examples/jumpmaster.config.json`, `scripts/docs.test.ts`
- Test: `scripts/docs.test.ts`

**Interfaces:**
- README quickstart: the prelude, exactly five commands (make and enter a directory; download the four files; `cosign verify-blob`; `sha256sum -c`; `docker compose up` in the foreground, with `up -d` plus `docker compose logs -f jumpmaster` as the alternative), then "open `http://127.0.0.1:7420` and enter the setup code from the line that starts `JUMPMASTER SETUP CODE:`". One line for a server install: the SSH tunnel (`ssh -L 7420:127.0.0.1:7420 <host>`). The scripted path (`init`) moves to the install runbook.
- `install.md`: the browser path first (the prelude, the setup code, the wizard with its GitHub panels, the doctor), then the scripted install (`init`, file mode, credentials as files under `secrets/`), then "Config as code" (file mode, `reload`, `adopt`, `mode file`, the host export line, and the two GitOps shapes: `import --dry-run` then `import`, or deploy the file and `reload`), then the existing reference sections; the troubleshooting-by-check-id section gains each check's action; the upgrade section says: drain, replace `compose.yaml`, `up`; then claim the login with the setup code or `ctl passphrase set`; the `init` block in `.env` is unused and may be deleted, as may a starter install's leftover `secrets/github_reviewer_token`; "write the export to the config file before you downgrade"; "a `data/` restore from before adopt returns to file mode with the file's zones".
- `operate.md`: zones (add, resume, edit, guarded changes and the confirmation page, what a session may not change, pause, observe, remove, egress adoption and its residual), settings (credentials and their sources, rotation and the running-drops line, token age, install settings, MCP tokens, history and rollback), the GitHub page, status, the doctor's actions and artifacts, the `ctl` table generated from the manifest, backup and restore (`secrets/` travels with `data/`; a restore of `data/` without `secrets/vault_key` means re-entering each credential), the daily export line, and **the operability session** (T16's script, so a partner can be handed one page).
- `SECURITY.md`: sessions and CSRF, the guarded paths and the confirmation, the vault and its key (`data/` alone holds ciphertext), file secrets by name, the setup code (why stderr; a forwarded log carries it until it is claimed).
- `docs.test.ts` gains: the README's prelude is at most six commands and names no `.env`, `secrets/` or token file; every `ctl` verb in the manifest appears in `operate.md`; every `docs` action anchor exists; the setup-code and log-shipping sentences are in `SECURITY.md`; the upgrade section names the three steps plus the login claim, and nothing else; the export line in the runbooks carries `exec -T`; the public docs still name no personal path. PR #51's "needs no Compose override file" test stays as it is.

- [ ] **Step 1: Write the failing docs tests.**
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Run `npx vitest run scripts`.** Expected: PASS.
- [ ] **Step 5: Commit.** `docs: put the browser path first and add the operate runbook`

### Task 16: Gate rehearsal: the operability session

**Files:**
- Create: `docs/runbooks/m4-5-gate.md`

- [ ] **Step 1: Write the gate runbook.**
  - **Setup the operator provides** (the only inputs): a supported host (Linux with rootful Docker Engine, or macOS with Docker Desktop) with an empty directory and `cosign` installed; two fresh test repositories with small seed apps and CI, **without** rulesets, CODEOWNERS or labels; the bot accounts, their collaborator invitations accepted, and their tokens (owner step); the partner's own Claude setup-token; the public repository URL.
  - **The partner:** a person who has never opened a Jumpmaster config file. They get one page: the operate runbook's operability session. The author is present to inject the FAIL and to time, answers a question only when the partner cannot proceed without it, and records every question and every hesitation over a minute.
  - **Two clocks.** The **prelude** (the README's commands up to and including `docker compose up`, copied without edits) has its own bar: at most 6 commands and 10 minutes. The **session** clock starts when the setup page appears.
  - **The session**, in order, each with its measure:
    1. Enter the setup code; choose a passphrase. *Measure:* time to the passphrase set.
    2. Connect the Claude token and the forge tokens in the wizard, following its identity recommendation; add the first repository; import the ruleset file; commit CODEOWNERS from the generated text; create the labels from the doctor; run the doctor. *Measure:* time to a green doctor; every fail seen and whether its link was followed.
    3. File the first issue from Intake; wait for the PR to merge. *Measure:* time to merge (excluded from hands-on time).
    4. Pause the zone; change a gate timeout; resume. *Assert:* the next drop runs with the new timeout, with no restart (the stick log shows the payload's value).
    5. Rotate the author token in Settings with a PAT the author pre-created (a real user would generate it from the template link, which the owner dry run exercised), then revoke the old one on GitHub when the page says no running drop carries it. *Assert:* the next drop's payload carries the new fingerprint; the settings row shows the new date.
    6. Add the second repository, import its ruleset file, create its labels; run the doctor. *Measure:* time to a green doctor.
    7. The author deletes the `agent-ready` label on the second repository and asks the partner to run the doctor. *Assert:* the partner reaches the fix through the check's action and the doctor is green again.
    8. At two scripted moments (after step 4's pause, and while step 3 waits on CI) the author asks "what is Jumpmaster doing and why is it waiting?". *Assert:* the answer matches the status line, in the partner's words.
  - **Counted per partner:** prelude commands and minutes; edits to any file after `docker compose up`; shell commands beyond `docker compose up` and `docker compose logs`; questions, split into blocking (the partner could not proceed without the answer) and other; hesitations over a minute; hands-on minutes (a stopwatch the author runs, paused while CI or a drop runs). The two shell steps excluded by design are named: the prelude and `claude setup-token`.
  - **The bar:** prelude at most 6 commands and 10 minutes; zero file edits; zero shell commands after `up`; zero blocking questions, with every question and hesitation reported; under 60 minutes hands-on.
  - **Recorded per partner:** the host OS and Docker version; a screen recording; the counts and times; every doctor fail and the link followed; every question and hesitation and what they were looking for; the same sheet as M4's baseline session, so the report shows before and after.
  - **Reruns:** after a fix for a cause, the same partner may rerun on a fresh repository pair, and that run counts only for the step the fix addressed.
  - **If M4.5 shipped in two parts**, M4.5a's gate is steps 1–3 and 7 and M4.5b's is steps 4–6 and 8, each with both partners; the counters and the bar are the same.
- [ ] **Step 2: Second dry run.** With T13 in, the owner repeats T10's session for steps 4–6 and 8 on the reference project. Expected: every count zero.
- [ ] **Step 3: Baseline.** Confirm the owner has run M4's partner session with this sheet (Owner steps). Expected: its numbers are in the report's "before" column.
- [ ] **Step 4: Partner 1.** Expected: every bar met.
- [ ] **Step 5: Partner 2,** on the other supported host if available. Expected: the same.
- [ ] **Step 6: Fix and rerun.** Every blocking question, hesitation over a minute, false doctor result or doc gap becomes a test-first fix or a runbook edit; rerun per the rerun rule.
- [ ] **Step 7: Have the branch red-teamed,** fix the findings test-first, and merge. Commit: `docs: add the M4.5 gate runbook`
- [ ] **Step 8: Report to the owner** with each partner's counts and times beside M4's baseline.

**M4.5 gate (testable, run by Jumpmaster's operator):** two design partners who have never opened the config file, each on a supported host, complete the operability session with the browser as their only interface after `docker compose up`: install to a green doctor, first PR merged, pause a zone and change a gate without a restart, rotate a token, add a second repository, recover from an injected doctor FAIL, and say from the status line what Jumpmaster is doing and why it waits. Per partner: the README's prelude in at most 6 commands and 10 minutes; zero file edits and zero shell commands after `docker compose up` (`logs` allowed); zero blocking questions, with every question and hesitation reported; under 60 minutes of their own hands-on time, CI and drop time excluded. The two excluded shell steps are the prelude and `claude setup-token`. Rulesets, CODEOWNERS and labels are not pre-provisioned on the test repositories. M4's partner session, run with the same counters, is the baseline the report compares against.

The claims listed under Review Focus as resting on unit tests are accepted on those tests.

---

## Spec coverage

| Spec | Where |
|---|---|
| §3 first run as a browser flow; enroll a stick (local by default) | T1, T5, T6 (the compose stick pairs by file and shows as checked in) |
| §7.1 repository content is data | T6, T7, T11's detection; T7's generated files are proposals |
| §7.3 two identities, starter mode, token scopes, no `workflow` scope | T4's credential rules, T7's template links and recommendation |
| §7.4 branch protection stays authoritative; protected paths need a human review | T7's ruleset file and CODEOWNERS text; T3 guards `protectedPaths` removals |
| §7.5 UI: login, loopback, CSRF, Origin/Host, session timeout, re-auth to replace secrets | T1 (re-auth also on the confirmation page, T3) |
| §7.5 every mutating call audited | T1's `control_audit` |
| §7.5 Command's MCP tokens created in the UI with expiry and scope | T13's MCP tokens tab |
| §7.5 vault: key outside the data volume, threat model in the docs; file secrets keep precedence | T4, T15 |
| §8.0 every failure gets a fix-it hint; setup runs the doctor | T8 (a link and a file, not only a hint), T6's doctor step |
| §10.3 M4.5 surfaces | T6 setup, T7 GitHub, T8 doctor links, T9 and T13 settings, T11 zones, T12 status, T14 ctl |
| §12.1 the token belongs to the operator; link to the terms | T6's Claude step |
| §13 forward-only migrations, restore safety | Global Constraints (v18–v20), T15's restore notes |
| §15 M4.5 gate, with M4's session as the baseline | T16, Owner steps |

## Deferred

| Item | Why it waits |
|---|---|
| Weight, usage budget and placement affinity on the zones page | M5. The zones page gets a Scheduling section then; the fields don't exist in the scheduler yet. |
| Separate Models, Budgets and Crew forms on the zone page | M5, with Scheduling. The Advanced JSON section edits them in M4.5 with the same validation and guards. |
| Per-zone forge credentials, GitLab credentials and the GitLab adapter | M5. One author and one reviewer token serve every zone until the second forge arrives. |
| Sticks tab: drain, undrain, remove, minted join tokens, remote enrollment | M6, with the remote-stick runbook. The compose stick pairs by file and the home page shows its state. |
| Issue graph, flow page, CI metrics | M6. |
| TLS termination guidance and a `Secure` cookie flag | M6, with remote placements. M4.5 fails `config.listen` on non-loopback `allowedHosts` unless `tlsTerminated` is acknowledged. |
| Prompts registry, in-app intake chat | M7, with prompt optimization. |
| `PUT /api/control/config` and `ctl config diff` | `PATCH`, `import`, `export`, `rollback` and the History page cover the UI, scripts and downgrade. |
| Gate secrets as files under the secrets directory | They keep today's env form plus the vault; a zone-scoped file convention is more naming than the gate needs. |
| Confirmations that survive a restart | In memory; a restart means starting the change again, which is rare and safe. |
| Goal-change PRs from the UI (§8.1) | Still deferred from M4. |
| Credential proxy for the Claude token (§7.2) | Still deferred from M4. |
| Vault key rotation (`ctl vault rekey`) | Re-entering each credential after a key change is a few pastes in the UI; a rekey command adds a key-management surface the gate doesn't need. |
| Multiple operators, roles, TOTP or passkeys | §3: single operator per install, on loopback; a passphrase plus the setup code meets §7.5. |
| Mixed file-and-UI config ownership | The two-mode rule exists to avoid it. |
| Per-key config watching (inotify) in file mode | `ctl config reload` is explicit and auditable; a watcher can follow if file-mode operators ask. |
| Pruning config revisions | Kilobytes each; revisit if a history page gets slow. |
| One audit table for control and MCP rows | `mcp_audit` carries token and zone columns the control rows lack; merging means a data migration for no gate gain. |
| A global backoff key | Dropped: it hands one source the power to stall everyone, and the 60-bit code does not need it. |
| Doctor auto-fix beyond label creation | The doctor stays read-only; labels are the one mechanical, harmless fix. |
| Changing a stick's slot count from the UI | `JM_SLOTS` is a stick-side setting; it moves to the UI with M6's stick protocol work. |
| Matrix and reusable-workflow job names in the ruleset file | The line-based reader lists plain jobs; the step says to check the Checks tab for the rest. |

## Red-team disposition

First review (plan f2a56f7):

| # | Grade | Finding | Disposition |
|---|---|---|---|
| C1 | Critical | Compose file secrets and `_FILE` env make an empty-directory `up` fail | **Adopted, completed by N1 and N8.** T5: no Compose secret and no credential `_FILE` in the default compose; the machine secrets come through `./secrets:/secrets:ro`, created by `bootstrap`; credentials are read by name from the same bind, so there is no override file; static deploy tests plus live cases for `.env` only, an empty directory, root-owned directories and the M4 upgrade. |
| C2 | Critical | A session can weaken every guard file mode protected | **Adopted, completed by N2 and N3.** T3: `GUARDED_PATHS` with a direction and a verbatim consequence per path, a document classifier (add baseline, effective values, set differences), a server-side single-use confirmation whose POST carries the passphrase; `requireSignedImages` weakening and a zone's `image` refused from a session outright; the Advanced editor, rollback, import, Resume and renames go through the same classifier; audit `guarded`; Review Focus 4; T11 and T13 render it. |
| I1 | Important | Config–credential invariants validated nowhere after the split | **Adopted.** T4: `credentialProblems` (missing, kind, same; the Claude token included) parks dispatch and feeds `credential.*` doctor fails; `PUT secrets` returns every zone's problems; `parseEditable` keeps config-only rules; tests in both directions. |
| I2 | Important | The gate and the README skip the pre-`up` prelude | **Adopted.** Stated exactly (five commands) in "What stays by hand" and T15's README; shrunk (`.env` optional, `secrets/` and `data/` by `bootstrap`); counted on its own bar (≤ 6 commands, ≤ 10 minutes) in T16 and §15. |
| I3 | Important | The GitHub half is unguided | **Adopted as a task.** T7: PAT template URLs, the ruleset file for import with detected job names, the identity recommendation (owner type, visibility, the free-plan private case), CODEOWNERS text and link, the collaborator checklist; surfaced in the wizard, a per-zone GitHub page, the doctor's artifacts and `ctl github`. |
| I4 | Important | Label action refused in observe mode | **Adopted.** T8: `runOp(..., { allowInObserve: true })` for this op alone; the kill check stays; a test asserts no other op bypasses. |
| I5 | Important | No Origin check on page POSTs; lockouts are a DoS lever | **Adopted, completed by N6.** T1: `originAllowed` on every non-GET route; per-source backoff (1 s doubling to 5 min) charged only after Host and Origin pass, no global key; `ctl setup-code`; Review Focus names the shared-network drop and the free `Host` header. |
| I6 | Important | `pollSeconds`, the lease expirer and the MCP zone list read once | **Adopted.** T2: `subscribe` re-arms the timer; `leaseExpirer` takes a getter; the MCP route reads the store; three named tests. |
| I7 | Important | Zone remove, re-add and rollback resurrect state | **Adopted.** T3 and T11: removal deletes `zone_controls` only; `zoneHasHistory`; re-add refused without Resume; a rollback that re-adds runs the add path and is marked in `readds`. |
| I8 | Important | `export` does not return to file mode | **Adopted, completed by N5.** T2: `ctl config mode file` (Bearer only, audited, refuses unless the file equals the export); `export` writes to stdout and the host redirects it; T5's upgrade smoke round-trips it; the dogfood decision rests on both. |
| I9 | Important | Scope is 1.5–2 M4s | **Adopted, completed by N4.** Trimmed: sticks drain/undrain/remove/join-token minting (M6), `PUT /config`, `ctl config diff`, separate Models/Budgets/Crew forms (Advanced JSON, M5); migrations down to three. T2 and T4 each split in two (T2/T3, T5/T6). Reordered on the gate's critical path with the owner dry run (T10) between M4.5a (T1–T9) and M4.5b (T11–T13), where the split can still be taken. |
| I10 | Important | Two partner gates in a row, M4's not yet run | **Adopted.** M4's partner session runs with M4.5's counters as the baseline (Owner steps, T16, §15); the M4 plan's Task 18 carries a one-line note. |
| I11 | Important | Plaintext login on a non-loopback listen stays a warning | **Adopted, refined by N7.** `config.listen` fails on a non-loopback `allowedHosts` entry unless `listen.tlsTerminated` acknowledges a terminator (T3); TLS guidance stays M6. |
| I12 | Important | A failed credential test can leak the pasted value | **Adopted.** T4: audit detail from named fields; status-and-permission-only errors; a test with a fixture value distinct from every stored secret; Global Constraints and Review Focus 3 name the case. |
| I13 | Important | Every existing install forced into setup; headless cannot finish | **Adopted.** T1: `ctl passphrase set` from stdin (Bearer; deletes sessions); `passphrase reset` renamed `setup reopen`; the upgrade note in T15. |
| M1 | Minor | Names and small checks | **Adopted.** `zone_controls` named; `CtlRequest` grows to PUT/PATCH/DELETE (T14); `next` rejects `//host`; `detect` after the `REPO` regexp; `jm_setup` flags; the stick enrolls while setup is active (T1 test). |
| M2 | Minor | Finding the code | **Adopted.** A fixed prefix on its own line; `/setup` says where; the README runs `up` in the foreground or `logs -f jumpmaster`. |
| M3 | Minor | The URL on a server | **Adopted.** One SSH-tunnel line in the README (T15). |
| M4 | Minor | Status priority | **Adopted, completed by N9.** Running work and CI outrank doctor fails older than the last pass and credential problems in other zones, which move to the detail (T12). |
| M5 | Minor | Vault in the backup set | **Adopted.** SECURITY.md: `data/` alone holds ciphertext; operate runbook: a restore without `secrets/vault_key` means re-entering each credential (T15). |
| M6 | Minor | Rotation guidance | **Adopted.** The running-drops line after Replace, cleared when none remain; `PUT secrets/:name` serialized per name (T4); "revoke the old token" in the session's step 5 (T16). |
| M7 | Minor | Actions carry artifacts | **Adopted.** `DoctorCheck.action.artifact`; `forge.branch-rules` and `forge.codeowners` carry the generated files; `forge.ci` names the jobs (T8). |
| M8 | Minor | One audit table | **Left.** `mcp_audit` carries token and zone columns the control rows lack; merging is a data migration for no gate gain. Listed under Deferred. |
| M9 | Minor | Revision notes | **Adopted.** 500-character cap in the schema, escaped on the page (T2). |
| M10 | Minor | `bootstrap` ownership | **Adopted, completed by N8.** Creates `secrets/` and `data/` `0700` when missing, tightens them when present; reports root with the `chown` line and another uid with the `.env` line (T5). |
| M11 | Minor | Step 5's pre-created PAT | **Adopted.** The step says a real user would use the template link, which the owner dry run exercised (T10, T16). |
| — | — | Points the review marked right (vault, setup code, rotation, sessions, detection) | Kept as reviewed; the two gaps it named (M1, M8) are dispositioned above. |

Re-review (plan 934c4a4):

| # | Grade | Finding | Disposition |
|---|---|---|---|
| N1 | Critical | The M4 → M4.5 upgrade parks every zone; the override and `COMPOSE_FILE` need a fifth file and a `.env` edit; the M4 `.env`'s `/run/secrets` path stops the server | **Adopted.** T4: `/secrets/<name>` files are file secrets with the `*_FILE` precedence and checks; a missing `/run/secrets` `_FILE` path falls back to the secrets directory with a warning; `init` stops writing its `.env` block. T5: no override, no `COMPOSE_FILE`, no `${JM_*_TOKEN_*}` interpolation in the template, so the M4 `.env` is dead but harmless; the upgrade is a live smoke case from an `init`-written directory; Global Constraints say "replace `compose.yaml`" and nothing else. PR #51's "needs no Compose override file" test stays true. |
| N2 | Important | The confirmation token is keyed by the page-readable CSRF value and is not single-use | **Adopted.** T3: a `Pending` change and a `Confirmation` record, server-side, in memory, over (session, change-set hash, base revision, expiry); the confirmation is a random value minted only when the page renders, stored hashed, consumed on use; the POST carries the passphrase (the sudo). Tests: a token not minted by the render, another session, a changed set, a stale revision, replay, expiry, a wrong passphrase. |
| N3 | Important | The classifier misses added zones, removed keys and list reorders | **Adopted.** T3: `classify(before, after)` works on documents; an added zone is judged against `ADD_BASELINE` (schema defaults with `egress.mode: monitor`); an explicit `image` on an added zone is session-forbidden; removed keys are judged on effective values with the install fallback; set paths as set differences (services keyed by name); tested through rename, rollback, Resume, the wizard route and the advanced JSON import. The three Minor candidates: `repo` immutable on an existing zone, `preset` guarded only when its base hosts grow, `readyLabel` noted. |
| N4 | Important | The split is decided after part b is built; part a's doctor links and the wizard's "later" promise point at part b | **Adopted.** The dry run (T10) moves to right after the doctor task; the Credentials tab becomes T9, in part a; zone checks link to the runbook until T11 flips them; `/setup/project` stays the home page's "Add a project" until T11 takes it over; a test asserts every action in the M4.5a configuration resolves. Order: T1, T2, T3, T4, T5, T6, T7, T8, T9, dry run, T11, T12, T13, T14, T15, T16. |
| N5 | Important | The daily export writes into a `:ro` mount | **Adopted.** `ctl config export` writes to stdout; the runbook's host line redirects to a temp file and `mv`s; `exportJson` is byte-stable so `mode file`'s hash agrees; the upgrade smoke runs the line and the round trip once (T2, T5, T10, T15). |
| N8 | Important | Root-owned bind directories; the wrong fix line; live-test gaps | **Adopted.** T5: `bootstrap` tightens `0755` directories and loose files, reads the owner on `EACCES` and prints the `chown` line for root and the `.env` line for another uid; live cases for an empty directory, `.env` only, root-owned directories with the two-`up` sequence (and `sudo docker compose up` where the host allows), and the M4 upgrade; Review Focus 11. |
| N6 | Minor | Backoff charged on an Origin refusal; a global key stalls everyone | **Adopted.** T1: `fail` only after Host and Origin pass; no global key (Deferred says why); the test "an Origin-refused or Host-refused POST does not advance backoff". |
| N7 | Minor | The in-container heuristic for `config.listen` | **Adopted.** T3: fail when `allowedHosts` names a non-loopback host without `tlsTerminated`; a non-loopback listen host alone stays the warning; the ruling states that non-loopback `allowedHosts` are allowed only behind a declared TLS terminator. |
| N9 | Minor | A credential problem outranks running work in another zone | **Adopted.** T12: the credential headline only when no zone is working; otherwise the detail. |
| N10 | Minor | Base commit; `RESERVED`; sessions on passphrase replace; the Claude token problem; reusable-workflow jobs; the `preset` sentence; the docs test name | **Adopted.** Base is `main` 0af429f (PR #51 merged); `cli.ts` adds `bootstrap` to `RESERVED` (T5); `PUT /api/control/passphrase` deletes sessions (T1); a missing Claude token is a `credentialProblem` (T4); the T7 step names `caller / inner`; the `preset` rule is in the Rulings; the docs test stays true without renaming (N1). |

Final check (plan 5be0dc2):

| # | Grade | Finding | Disposition |
|---|---|---|---|
| N15 | Important | The wizard's project step does not say how it follows a 409 `needsConfirmation`; `preset` on an add is guarded against an empty baseline | **Adopted.** T6: every wizard apply follows `needsConfirmation` to the confirmation page with `returnTo` the next step, so Confirm lands on `/setup/doctor` and no raw JSON is seen; test for a personal public repository on the starter path with detected services. T3: `ADD_BASELINE(zone)` takes the added zone's preset as the starting point, so the preset is not guarded on an add and its hosts are shown as information; the Rulings say so; tested. |
| N11 | Minor | The `/run/secrets` fallback maps by basename | **Adopted.** T4: by credential name (`SECRET_FILES[name]`), the four names only, a one-release shim removed in M5, inert where `JM_SECRETS_DIR` is unset. |
| N12 | Minor | `loadBoot`'s "else" could leave `JM_SECRETS_DIR` unset in file mode | **Adopted.** T2: `loadBoot` reads the environment in both modes; `JM_CONFIG`, `JM_SECRETS_DIR` and `JM_TLS_TERMINATED` have no file key and are always environment. |
| N13 | Minor | A starter install's leftover reviewer file is re-enabled by presence | **Adopted.** T5's smoke (d) carries the case; T15's upgrade note says the file is unused and may be deleted. |
| N14 | Minor | No cap on `Pending` records per session | **Adopted.** T3: ten per session, oldest evicted; tested. |
| N16 | Minor | `ctl zones add` without `--egress` gives the schema's `off` | **Adopted.** T6: defaults to `monitor`; tested. |
| N17 | Minor | `docker compose exec` without `-T` writes CRLF into the redirected export | **Adopted.** `exec -T` in the Rulings, T2, T5, T10 and T15's docs test. |
| N18 | Minor | The docs test's "three steps and no fourth" contradicts the login claim in the same section | **Adopted.** T15: "the three steps plus the login claim, and nothing else". |
